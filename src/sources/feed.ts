// Two sources that read the same JSON shape:
//   file    a hand-written override file
//   command any program that prints that JSON (the way to add GitLab, Linear, Jira, CI and so on)
//
// Shape, either a bare list of lanes or an object:
//   { "feedVersion": 1, "lanes": [Lane], "needs": [Need] }

import { SourceError } from '../types.ts'
import type { CommandSourceConfig, FileSourceConfig, Lane, LaneStatus, Need, Source, SourceContext } from '../types.ts'
import { LANE_STATUSES } from '../types.ts'
import { asRecord, firstLine, isString, parseJson } from '../util.ts'
import type { Rec } from '../util.ts'

export const FEED_VERSION = 1

type Feed = { lanes: Rec[]; needs: Rec[]; updated: number | null }

const records = (value: unknown): Rec[] => (Array.isArray(value) ? value.flatMap((v): Rec[] => { const r = asRecord(v); return r ? [r] : [] }) : [])

export function parseFeed(text: string, label: string): Feed {
  const parsed = parseJson(text)
  if (!parsed.ok) throw new SourceError(`${label} is not valid JSON (${firstLine(parsed.reason, 80)})`)
  if (Array.isArray(parsed.value)) return { lanes: records(parsed.value), needs: [], updated: null }
  const root = asRecord(parsed.value)
  if (!root) throw new SourceError(`${label} must be a JSON list or object`)
  if (root.feedVersion !== undefined && root.feedVersion !== FEED_VERSION) {
    throw new SourceError(`${label} has feedVersion ${String(root.feedVersion)} but this release reads ${FEED_VERSION}. Run "coordinator migrate".`)
  }
  const updated = isString(root.updated) ? Date.parse(root.updated) : NaN
  return { lanes: records(root.lanes), needs: records(root.needs), updated: Number.isFinite(updated) ? updated : null }
}

export function laneFromFeed(raw: Rec, source: string): Lane | null {
  if (!isString(raw.title) || !isString(raw.stage)) return null
  const status = isString(raw.status) && (LANE_STATUSES as readonly string[]).includes(raw.status) ? (raw.status as LaneStatus) : 'waiting'
  return {
    title: raw.title,
    stage: raw.stage,
    status,
    state: isString(raw.state) ? raw.state : '',
    ...(isString(raw.ref) ? { ref: raw.ref } : {}),
    ...(isString(raw.url) ? { url: raw.url } : {}),
    ...(isString(raw.blockedBy) ? { blockedBy: raw.blockedBy } : {}),
    ...(raw.failed === true ? { failed: true } : {}),
    ...(isString(raw.codex) ? { codex: raw.codex } : {}),
    ...(isString(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
    ...(typeof raw.asOf === 'number' ? { asOf: raw.asOf } : {}),
    source,
  }
}

export function needsFromFeed(rows: Rec[]): Need[] {
  return rows.flatMap((raw, i): Need[] => {
    if (!isString(raw.text)) return []
    const options = Array.isArray(raw.options)
      ? raw.options.flatMap(o => (isString(asRecord(o)?.label) && isString(asRecord(o)?.text)
        ? [{ label: String(asRecord(o)?.label), text: String(asRecord(o)?.text) }] : []))
      : []
    return [{
      id: isString(raw.ref) ? raw.ref : isString(raw.url) ? raw.url : `feed:${i}:${raw.text}`,
      text: raw.text,
      ...(isString(raw.url) ? { url: raw.url } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(isString(raw.to) ? { to: raw.to } : {}),
    }]
  })
}

/** Give every lane the time its feed says it was written, so the pane can show how old hand-kept data is. */
function stamp(feed: Feed): Rec[] {
  return feed.updated === null ? feed.lanes : feed.lanes.map(l => ({ ...l, asOf: feed.updated }))
}

function resolve(home: string, path: string): string {
  return /^([a-zA-Z]:)?[\\/]/.test(path) ? path : `${home}/${path}`
}

async function readFeedFile(config: FileSourceConfig, ctx: SourceContext): Promise<Feed> {
  const path = resolve(ctx.home, config.path)
  let text: string
  try {
    text = await ctx.host.readFile(path)
  } catch {
    throw new SourceError(`cannot read ${path}`)
  }
  return parseFeed(text, path)
}

async function runFeed(config: CommandSourceConfig, ctx: SourceContext): Promise<Feed> {
  let result
  try {
    result = await ctx.host.run(config.argv, { ...(config.cwd ? { cwd: config.cwd } : {}), timeoutMs: (config.timeoutSeconds ?? 60) * 1000 })
  } catch (err) {
    throw new SourceError(`"${config.argv[0] ?? ''}" could not run: ${firstLine(err instanceof Error ? err.message : String(err))}`)
  }
  if (result.exitCode !== 0) throw new SourceError(`"${config.argv[0] ?? ''}" failed: ${firstLine(result.stderr || result.stdout) || `exit code ${result.exitCode}`}`)
  return parseFeed(result.stdout, `output of "${config.argv[0] ?? ''}"`)
}

export const file: Source<FileSourceConfig, Rec> = {
  type: 'file',
  requires: () => [],
  fetch: async (config, ctx) => (config.lanes === false ? [] : stamp(await readFeedFile(config, ctx))),
  toLane: (raw) => laneFromFeed(raw, 'file'),
  fetchNeeds: async (config, ctx) => needsFromFeed((await readFeedFile(config, ctx)).needs),
}

export const command: Source<CommandSourceConfig, Rec> = {
  type: 'command',
  requires: config => [{ command: config.argv[0] ?? '', install: 'the program named in "argv"' }],
  fetch: async (config, ctx) => stamp(await runFeed(config, ctx)),
  toLane: (raw) => laneFromFeed(raw, 'command'),
  fetchNeeds: async (config, ctx) => needsFromFeed((await runFeed(config, ctx)).needs),
}
