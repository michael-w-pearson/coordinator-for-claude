// Builds a BandData for one profile. Calls only `gh` (through the github source), the commands the profile
// lists, and the health URLs the profile lists. It never calls a language model.

import { DEFAULTS } from './config.ts'
import { parseCodexList, parseMergeLine } from './parsers.ts'
import { refState } from './sources/github.ts'
import { SOURCES } from './sources/index.ts'
import { DATA_VERSION, SourceError } from './types.ts'
import type {
  BandData, CodexTask, Host, Lane, MergeLineData, Need, ProfileConfig, SectionRecord, ServiceHealth, SourceContext,
} from './types.ts'
import { firstLine } from './util.ts'

const empty = <T>(data: T): SectionRecord<T> => ({ data, fetchedAt: null, error: 'not fetched yet' })

function ok<T>(data: T, now: number): SectionRecord<T> {
  return { data, fetchedAt: now }
}

function failed<T>(prev: SectionRecord<T> | null | undefined, fallback: T, reason: string): SectionRecord<T> {
  return { data: prev?.data ?? fallback, fetchedAt: prev?.fetchedAt ?? null, error: reason }
}

const reasonOf = (err: unknown): string =>
  err instanceof SourceError ? err.message : firstLine(err instanceof Error ? err.message : String(err))

/** Same ref: later lanes override earlier ones field by field. Lanes without a ref are never joined. */
export function mergeLanes(lanes: readonly Lane[]): Lane[] {
  const out: Lane[] = []
  const at = new Map<string, number>()
  for (const lane of lanes) {
    const i = lane.ref ? at.get(lane.ref) : undefined
    if (i === undefined) {
      if (lane.ref) at.set(lane.ref, out.length)
      out.push(lane)
    } else {
      const { state, ...rest } = lane
      const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined))
      // The live state line (from the first source) wins; a later source only fills it in when empty.
      out[i] = { ...out[i], ...defined, state: out[i]?.state || state } as Lane
    }
  }
  return out
}

/**
 * A hand-kept lane (file or command source) can name a pull request that has since merged or closed.
 * Ask GitHub about each such ref: merged becomes a done lane, closed is dropped. A failed check leaves the lane as it is.
 */
export async function settleRefs(ctx: SourceContext, profile: ProfileConfig, lanes: Lane[]): Promise<Lane[]> {
  const github = profile.sources.find(s => s.type === 'github')
  if (!github || github.type !== 'github') return lanes
  const stages = ctx.stageIds ?? []
  const last = stages[stages.length - 1] ?? 'merged'
  const handKept = (l: Lane): boolean => !!l.ref && !!l.source && !l.source.startsWith('github')
  const asked = await Promise.all(lanes.map(async l => {
    const m = handKept(l) ? /^([\w.-]+)#\d+$/.exec(l.ref ?? '') : null
    if (!m || !github.repos.includes(m[1] ?? '')) return null
    return refState(ctx, github.owner, l.ref ?? '')
  }))
  return lanes.flatMap((l, i) => {
    const s = asked[i]
    if (s === 'closed') return []
    if (s === 'merged') return [{ ...l, stage: last, status: 'done' as const, state: 'merged', blockedBy: undefined }]
    return [l]
  })
}

export async function fetchLanes(
  ctx: SourceContext,
  profile: ProfileConfig,
  prev: SectionRecord<Lane[]> | null | undefined,
): Promise<SectionRecord<Lane[]>> {
  const now = ctx.host.now()
  const errors: string[] = []
  const lanes: Lane[] = []
  for (const [i, config] of profile.sources.entries()) {
    const id = `${config.type}:${i}`
    const source = SOURCES[config.type]
    if (!source) { errors.push(`${id}: unknown source type`); continue }
    try {
      const raws = await source.fetch(config as never, ctx)
      for (const raw of raws) {
        const lane = source.toLane(raw as never, config as never, ctx)
        if (lane) lanes.push({ ...lane, source: id })
      }
    } catch (err) {
      errors.push(`${config.type}: ${reasonOf(err)}`)
      // Keep what this source showed last time, so one bad source does not blank the lanes.
      lanes.push(...(prev?.data ?? []).filter(l => l.source === id))
    }
  }
  const merged = await settleRefs(ctx, profile, mergeLanes(lanes))
  // The section is as old as the oldest hand-kept data in it, never newer than the fetch.
  const asOf = merged.flatMap(l => (l.asOf !== undefined ? [l.asOf] : []))
  const dataTime = Math.min(now, ...asOf)
  if (errors.length > 0) {
    return { data: merged, fetchedAt: errors.length === profile.sources.length ? (prev?.fetchedAt ?? null) : dataTime, error: errors.join('; ') }
  }
  return ok(merged, dataTime)
}

export async function fetchNeeds(
  ctx: SourceContext,
  profile: ProfileConfig,
  prev: SectionRecord<Need[]> | null | undefined,
): Promise<SectionRecord<Need[]>> {
  const now = ctx.host.now()
  const errors: string[] = []
  const needs: Need[] = []
  let asked = 0
  for (const config of profile.sources) {
    const source = SOURCES[config.type]
    if (!source?.fetchNeeds) continue
    asked += 1
    try {
      needs.push(...(await source.fetchNeeds(config as never, ctx)))
    } catch (err) {
      errors.push(`${config.type}: ${reasonOf(err)}`)
    }
  }
  const seen = new Map((prev?.data ?? []).map(n => [n.id, n.firstSeen ?? now]))
  const unique = new Map<string, Need>()
  for (const need of needs) unique.set(need.id, { ...unique.get(need.id), ...need, firstSeen: seen.get(need.id) ?? now })
  const data = [...unique.values()]
  if (errors.length > 0) {
    return { data: asked === errors.length ? (prev?.data ?? []) : data, fetchedAt: asked === errors.length ? (prev?.fetchedAt ?? null) : now, error: errors.join('; ') }
  }
  return ok(data, now)
}

export async function fetchMergeLine(
  host: Host,
  config: NonNullable<ProfileConfig['mergeLine']>,
  prev: SectionRecord<MergeLineData> | null | undefined,
  force = false,
): Promise<SectionRecord<MergeLineData>> {
  const now = host.now()
  const ttl = (config.ttlMinutes ?? DEFAULTS.mergeLineTtlMinutes) * 60_000
  if (!force && prev) {
    if (prev.error ? now < (prev.retryAt ?? 0) : prev.fetchedAt !== null && now - prev.fetchedAt < ttl) return prev
  }
  const fallback: MergeLineData = { head: null, entries: [] }
  // After a failure wait ttl x2 per consecutive failure (capped). A rate limit waits at least half the cap.
  const fail = (reason: string): SectionRecord<MergeLineData> => {
    const failures = (prev?.failures ?? 0) + 1
    const cap = DEFAULTS.maxBackoffMinutes * 60_000
    const wait = Math.min(cap, ttl * 2 ** (failures - 1))
    const limited = /rate limit|HTTP 403|403/i.test(reason)
    return { ...failed(prev, fallback, reason), failures, retryAt: now + (limited ? Math.max(wait, cap / 2) : wait) }
  }
  try {
    const result = await host.run(config.command, { ...(config.cwd ? { cwd: config.cwd } : {}), timeoutMs: (config.timeoutSeconds ?? 600) * 1000 })
    // Some tools exit non-zero on a healthy run, so judge by what they printed.
    const parsed = parseMergeLine(result.stdout)
    if (parsed) return ok(parsed, now)
    const why = firstLine(result.stderr) || (result.stdout.trim() ? `unreadable output: ${firstLine(result.stdout, 60)}` : 'it printed nothing')
    return fail(`merge line command gave no result (${why})`)
  } catch (err) {
    return fail(`merge line command could not run: ${reasonOf(err)}`)
  }
}

export async function fetchCodex(
  host: Host,
  config: NonNullable<ProfileConfig['codexCloud']>,
  prev: SectionRecord<CodexTask[]> | null | undefined,
): Promise<SectionRecord<CodexTask[]>> {
  const now = host.now()
  const argv = config.command ?? ['codex', 'cloud', 'list', '--limit', '20']
  try {
    // Run in the band folder: the codex tool writes an error.log into its working directory.
    const result = await host.run(argv, { cwd: host.home, timeoutMs: 30_000 })
    if (result.exitCode !== 0) return failed(prev, [], `codex failed: ${firstLine(result.stderr || result.stdout) || `exit code ${result.exitCode}`}`)
    // An empty list is a good answer. Text that holds no task and is not empty is not.
    const tasks = parseCodexList(result.stdout)
    if (tasks.length === 0 && result.stdout.trim() && !/no (tasks|results)/i.test(result.stdout)) {
      return failed(prev, [], `codex printed text this release cannot read (${firstLine(result.stdout, 60)})`)
    }
    return ok(tasks, now)
  } catch (err) {
    return failed(prev, [], `codex could not run: ${reasonOf(err)}`)
  }
}

export async function fetchServices(
  host: Host,
  services: NonNullable<ProfileConfig['services']>,
  prev: SectionRecord<ServiceHealth[]> | null | undefined,
): Promise<SectionRecord<ServiceHealth[]>> {
  const now = host.now()
  if (!host.http) return failed(prev, [], 'this host cannot check URLs')
  const http = host.http
  const data = await Promise.all(services.map(async (svc): Promise<ServiceHealth> => {
    try {
      const status = await http(svc.url, 3000)
      return { name: svc.name, value: 'up', detail: String(status) }
    } catch (err) {
      return { name: svc.name, value: 'down', detail: firstLine(err instanceof Error ? err.message : String(err), 60) }
    }
  }))
  return ok(data, now)
}

export type RefreshOptions = { forceMergeLine?: boolean; stageIds?: string[] }

/** One full pass. `prev` supplies the last good data for sections that fail this time. */
export async function refreshProfile(
  host: Host,
  name: string,
  profile: ProfileConfig,
  prev: BandData | null,
  options: RefreshOptions = {},
): Promise<BandData> {
  const ctx: SourceContext = { host, profile: name, home: host.home, ...(options.stageIds ? { stageIds: options.stageIds } : {}) }
  const [lanes, needs, mergeLine, codex, services] = await Promise.all([
    fetchLanes(ctx, profile, prev?.lanes),
    fetchNeeds(ctx, profile, prev?.needs),
    profile.mergeLine ? fetchMergeLine(host, profile.mergeLine, prev?.mergeLine, options.forceMergeLine) : Promise.resolve(null),
    profile.codexCloud?.enabled ? fetchCodex(host, profile.codexCloud, prev?.codex) : Promise.resolve(null),
    profile.services && profile.services.length > 0 ? fetchServices(host, profile.services, prev?.services) : Promise.resolve(null),
  ])
  return { dataVersion: DATA_VERSION, profile: name, generatedAt: host.now(), lanes, needs, mergeLine, codex, services }
}

export { empty as emptySection }
