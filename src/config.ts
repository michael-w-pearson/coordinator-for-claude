// Defaults, loading and validation of config.json. Pure: the caller reads the file.

import { ramp } from './palette.ts'
import { COLORS, CONFIG_VERSION, LANE_STATUSES } from './types.ts'
import type { Color, Config, ProfileConfig, Rule, SourceConfig, StageDef } from './types.ts'
import { asRecord, isString, parseJson } from './util.ts'
import type { Rec } from './util.ts'

const STAGE_COLORS = ramp(6) as [Color, Color, Color, Color, Color, Color]
export const DEFAULT_STAGES: StageDef[] = [
  { id: 'plan', label: 'plan', description: 'being planned, nothing built yet', color: STAGE_COLORS[0] },
  { id: 'build', label: 'build', description: 'being written', color: STAGE_COLORS[1] },
  { id: 'verify', label: 'verify', description: 'tests and checks running', color: STAGE_COLORS[2] },
  { id: 'review', label: 'review', description: 'waiting on a reviewer or a fix', color: STAGE_COLORS[3] },
  { id: 'merge-line', label: 'merge-line', description: 'approved, queued to merge', color: STAGE_COLORS[4] },
  { id: 'merged', label: 'merged', description: 'done, in the main branch', color: STAGE_COLORS[5] },
]

/** First matching rule wins. Written as data so a user can replace the list. */
export const DEFAULT_RULES: Rule[] = [
  { when: { merged: true }, stage: 'merged', status: 'done' },
  { when: { plan: true, failing: true }, stage: 'plan', status: 'blocked', blockedBy: '{failing} check(s) failing' },
  { when: { plan: true, changesRequested: true }, stage: 'plan', status: 'blocked', blockedBy: 'changes requested' },
  { when: { plan: true, autoMerge: true }, stage: 'merge-line', status: 'moving' },
  { when: { plan: true, draft: true }, stage: 'plan', status: 'moving' },
  { when: { plan: true }, stage: 'plan', status: 'waiting', blockedBy: 'plan in review' },
  { when: { draft: true }, stage: 'build', status: 'moving' },
  { when: { failing: true }, stage: 'review', status: 'blocked', blockedBy: '{failing} check(s) failing' },
  { when: { changesRequested: true }, stage: 'review', status: 'blocked', blockedBy: 'changes requested' },
  { when: { autoMerge: true }, stage: 'merge-line', status: 'moving' },
  { when: { pending: true }, stage: 'verify', status: 'moving' },
  { when: { approved: true }, stage: 'merge-line', status: 'waiting', blockedBy: 'ready to merge' },
  { when: {}, stage: 'review', status: 'waiting', blockedBy: 'awaiting review' },
]

/** Folders whose files count as plans. Replace with "planPaths" on the github source. */
export const DEFAULT_PLAN_PATHS = ['wiki/plans/', 'wiki/decisions/', 'docs/plans/', 'docs/decisions/']
/** Titles that count as plans: "plan: ...", "plan(scope): ...", "docs(plans): ...". */
export const DEFAULT_PLAN_TITLE = '^(plan(\\([^)]*\\))?:|docs\\(plans\\))'

export const DEFAULTS = {
  refreshMode: 'auto' as const,
  intervalMinutes: 5,
  staleAfterMinutes: 30,
  minMoving: 3,
  mergeLineTtlMinutes: 30, // the status command is expensive: hundreds of GitHub calls per run
  maxBackoffMinutes: 60,
  mergedTtlMinutes: 60,
  mergeLineFileMaxAgeMinutes: 15,
  statusColors: { moving: 'green', waiting: 'yellow', blocked: 'red', done: 'gray' } as const,
  needsLabel: 'needs-me',
  githubLimit: 30,
}

export type Problem = { path: string; message: string; fatal: boolean }

export type Loaded = { config: Config | null; problems: Problem[] }

const SOURCE_TYPES = ['github', 'file', 'command']

function stringList(value: unknown, path: string, problems: Problem[]): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(isString)) {
    problems.push({ path, message: 'must be a list of text values', fatal: true })
    return []
  }
  return value
}

function checkRules(value: unknown, path: string, stageIds: Set<string>, problems: Problem[]): void {
  if (!Array.isArray(value)) { problems.push({ path, message: 'must be a list of rules', fatal: true }); return }
  value.forEach((raw, i) => {
    const at = `${path}[${i}]`
    const rule = asRecord(raw)
    if (!rule) { problems.push({ path: at, message: 'must be an object with when, stage and status', fatal: true }); return }
    if (!asRecord(rule.when)) problems.push({ path: `${at}.when`, message: 'must be an object (use {} to match everything)', fatal: true })
    if (!isString(rule.stage) || !stageIds.has(rule.stage)) {
      problems.push({ path: `${at}.stage`, message: `must be one of: ${[...stageIds].join(', ')}`, fatal: true })
    }
    if (!isString(rule.status) || !(LANE_STATUSES as readonly string[]).includes(rule.status)) {
      problems.push({ path: `${at}.status`, message: `must be one of: ${LANE_STATUSES.join(', ')}`, fatal: true })
    }
  })
}

function checkSource(raw: unknown, path: string, stageIds: Set<string>, problems: Problem[]): void {
  const src = asRecord(raw)
  if (!src) { problems.push({ path, message: 'must be an object', fatal: true }); return }
  if (!isString(src.type) || !SOURCE_TYPES.includes(src.type)) {
    problems.push({ path: `${path}.type`, message: `must be one of: ${SOURCE_TYPES.join(', ')}`, fatal: true })
    return
  }
  if (src.type === 'github') {
    if (!isString(src.owner) || !src.owner) problems.push({ path: `${path}.owner`, message: 'needs a GitHub user or organisation name', fatal: true })
    const repos = stringList(src.repos, `${path}.repos`, problems)
    if (repos.length === 0) problems.push({ path: `${path}.repos`, message: 'needs at least one repository name', fatal: true })
    if (!src.label && !src.author) {
      problems.push({ path: `${path}`, message: 'set "label" (every open PR with it becomes a lane) or "author": "@me"', fatal: true })
    }
    if (src.rules !== undefined) checkRules(src.rules, `${path}.rules`, stageIds, problems)
    if (src.planPaths !== undefined) stringList(src.planPaths, `${path}.planPaths`, problems)
    if (src.planTitle !== undefined) {
      try { new RegExp(String(src.planTitle), 'i') } catch { problems.push({ path: `${path}.planTitle`, message: 'is not a valid regular expression', fatal: true }) }
    }
  } else if (src.type === 'file') {
    if (!isString(src.path) || !src.path) problems.push({ path: `${path}.path`, message: 'needs a file path', fatal: true })
  } else if (src.type === 'command') {
    if (!Array.isArray(src.argv) || src.argv.length === 0 || !src.argv.every(isString)) {
      problems.push({ path: `${path}.argv`, message: 'needs the program and its arguments as a list of text values', fatal: true })
    }
  }
}

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.localhost|[\w-]+\.local)$/i

/** True when a health URL points at this machine or a private network. */
export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOST.test(new URL(url).hostname)
  } catch {
    return false
  }
}

function checkProfile(name: string, raw: unknown, stageIds: Set<string>, problems: Problem[]): void {
  const path = `profiles.${name}`
  const profile = asRecord(raw)
  if (!profile) { problems.push({ path, message: 'must be an object', fatal: true }); return }
  if (!Array.isArray(profile.sources) || profile.sources.length === 0) {
    problems.push({ path: `${path}.sources`, message: 'needs at least one source', fatal: true })
  } else {
    profile.sources.forEach((s, i) => checkSource(s, `${path}.sources[${i}]`, stageIds, problems))
  }
  const sessions = asRecord(profile.sessions)
  if (profile.sessions !== undefined && (!sessions || !isString(sessions.dir) || !sessions.dir)) {
    problems.push({ path: `${path}.sessions.dir`, message: 'needs the folder where the Claude desktop app keeps its session records', fatal: true })
  }
  const ml = asRecord(profile.mergeLine)
  if (profile.mergeLine !== undefined && (!ml || !Array.isArray(ml.command) || ml.command.length === 0)) {
    problems.push({ path: `${path}.mergeLine.command`, message: 'needs the program and its arguments as a list', fatal: true })
  }
  if (profile.services !== undefined) {
    if (!Array.isArray(profile.services)) problems.push({ path: `${path}.services`, message: 'must be a list', fatal: true })
    else profile.services.forEach((raw2, i) => {
      const svc = asRecord(raw2)
      if (!svc || !isString(svc.name) || !isString(svc.url)) {
        problems.push({ path: `${path}.services[${i}]`, message: 'needs "name" and "url"', fatal: true })
      } else if (!/^https?:\/\//.test(svc.url)) {
        problems.push({ path: `${path}.services[${i}].url`, message: 'must start with http:// or https://', fatal: true })
      } else if (!isLocalUrl(svc.url) && svc.allowRemote !== true) {
        problems.push({
          path: `${path}.services[${i}].url`,
          message: `${svc.url} is not on this machine or a private network. Set "allowRemote": true to check it.`,
          fatal: true,
        })
      }
    })
  }
}

/** Read the text of config.json. Version problems and bad fields come back as readable lines. */
export function loadConfig(text: string, file = 'config.json'): Loaded {
  const parsed = parseJson(text)
  if (!parsed.ok) {
    return { config: null, problems: [{ path: file, message: `is not valid JSON (${parsed.reason}). Fix the syntax or run "band init --force".`, fatal: true }] }
  }
  const root = asRecord(parsed.value)
  if (!root) return { config: null, problems: [{ path: file, message: 'must be a JSON object', fatal: true }] }

  const problems: Problem[] = []
  const version = root.configVersion
  if (version === undefined) {
    return {
      config: null,
      problems: [{
        path: file,
        message: `has no "configVersion". It looks like a file from an older release. Run "band migrate" to update it (a backup is kept).`,
        fatal: true,
      }],
    }
  }
  if (version !== CONFIG_VERSION) {
    const older = typeof version === 'number' && version < CONFIG_VERSION
    return {
      config: null,
      problems: [{
        path: file,
        message: older
          ? `is version ${String(version)} but this release needs version ${CONFIG_VERSION}. Run "band migrate" to update it (a backup is kept).`
          : `is version ${String(version)}, newer than this release understands (${CONFIG_VERSION}). Update coordinator-band.`,
        fatal: true,
      }],
    }
  }

  const stages = stagesOf(root, problems)
  const stageIds = new Set(stages.map(s => s.id))
  const profiles = asRecord(root.profiles)
  if (!profiles || Object.keys(profiles).length === 0) {
    problems.push({ path: 'profiles', message: 'needs at least one profile. Run "band init".', fatal: true })
  } else {
    for (const [name, raw] of Object.entries(profiles)) checkProfile(name, raw, stageIds, problems)
  }
  const refresh = asRecord(root.refresh)
  if (refresh?.mode !== undefined && !['auto', 'self', 'file'].includes(String(refresh.mode))) {
    problems.push({ path: 'refresh.mode', message: 'must be auto, self or file', fatal: true })
  }
  if (problems.some(p => p.fatal)) return { config: null, problems }
  return { config: { ...(root as unknown as Config), stages }, problems }
}

function stagesOf(root: Rec, problems: Problem[]): StageDef[] {
  if (root.stages === undefined) return DEFAULT_STAGES
  if (!Array.isArray(root.stages) || root.stages.length === 0) {
    problems.push({ path: 'stages', message: 'must be a non-empty list', fatal: true })
    return DEFAULT_STAGES
  }
  const stages: StageDef[] = []
  root.stages.forEach((raw, i) => {
    const s = asRecord(raw)
    if (!s || !isString(s.id) || !s.id) { problems.push({ path: `stages[${i}].id`, message: 'needs an id', fatal: true }); return }
    const okColor = isString(s.color) && ((COLORS as readonly string[]).includes(s.color) || /^#[0-9a-f]{6}$/i.test(s.color))
    const color = okColor ? (s.color as StageDef['color']) : 'cyan'
    if (s.color !== undefined && color !== s.color) {
      problems.push({ path: `stages[${i}].color`, message: `must be a colour name (${COLORS.join(', ')}) or a hex colour such as #3fa7d6`, fatal: true })
    }
    stages.push({ id: s.id, label: isString(s.label) ? s.label : s.id, description: isString(s.description) ? s.description : '', color })
  })
  return stages
}

/** The first profile whose match rules fit this session. A single profile with no rules always fits. */
export function pickProfile(
  config: Config,
  session: { id: string; cwd: string },
  enrolled: readonly string[] = [],
): string | null {
  const names = Object.keys(config.profiles)
  const cwd = session.cwd.replace(/\\/g, '/')
  for (const name of enrolled) if (config.profiles[name]) return name
  for (const name of names) {
    const match = config.profiles[name]?.match
    if (!match) continue
    if (match.always) return name
    if (match.sessions?.includes(session.id)) return name
    if (match.cwdContains?.some(part => cwd.includes(part.replace(/\\/g, '/')))) return name
  }
  const only = names.length === 1 ? config.profiles[names[0] ?? ''] : undefined
  if (only && !only.match) return names[0] ?? null
  return null
}

export const profileOf = (config: Config, name: string): ProfileConfig | undefined => config.profiles[name]
export const sourceLabel = (s: SourceConfig, i: number): string => `${s.type}:${i}`
