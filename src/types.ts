// Shared types. Erasable TypeScript only (no enums, no parameter properties) so Node can run src/ with no build.

export const CONFIG_VERSION = 1
export const DATA_VERSION = 1

export type LaneStatus = 'moving' | 'waiting' | 'blocked' | 'done'
export const LANE_STATUSES: readonly LaneStatus[] = ['moving', 'waiting', 'blocked', 'done']

/** A named color the terminal pane and the text renderer both understand. */
export type Color = `#${string}` | 'green' | 'yellow' | 'red' | 'cyan' | 'blue' | 'magenta' | 'gray' | 'white'
export const COLORS: readonly Color[] = ['green', 'yellow', 'red', 'cyan', 'blue', 'magenta', 'gray', 'white']

export type StageDef = { id: string; label: string; description: string; color: Color }

/** One of four states, shown the same way for every section. */
export type SectionState = 'ok' | 'stale' | 'empty' | 'error'

/** What a refresh stores for one section. Rendering turns it into a SectionState. */
export type SectionRecord<T> = {
  /** Last good data. Kept when a later fetch fails. */
  data: T
  /** Epoch ms of the last good fetch, or null when it never worked. */
  fetchedAt: number | null
  /** Why the latest fetch failed. Absent when it worked. */
  error?: string
  /** Consecutive failed fetches. Drives the back-off. Absent after a good fetch. */
  failures?: number
  /** Epoch ms before which a failed fetch is not tried again. */
  retryAt?: number
}

export type Lane = {
  title: string
  /** Stable id such as "repo#12". Used to join overrides and blockers. */
  ref?: string
  url?: string
  /** Short free text, for example "draft, 2 failing". */
  state: string
  stage: string
  status: LaneStatus
  blockedBy?: string
  failed?: boolean
  updatedAt?: string
  /** Optional id of a Codex Cloud task shown under the lane. */
  codex?: string
  /** Which source produced the lane. */
  source?: string
  /** Epoch ms when a person or program last wrote this lane's hand-kept fields. Set from a feed's "updated". */
  asOf?: number
}

export type NeedOption = { label: string; text: string }
export type Need = {
  id: string
  text: string
  url?: string
  options?: NeedOption[]
  /** Session id or name that receives an option's text. */
  to?: string
  /** Epoch ms when this need was first seen. Set by refresh. */
  firstSeen?: number
}

export type MergeLineEntry = { n: string; note: string }
export type MergeLineData = { head: string | null; entries: MergeLineEntry[] }
export type CodexTask = { id: string; status: string; title: string; age: string; diff: string }
export type HealthValue = 'up' | 'down'
export type ServiceHealth = { name: string; value: HealthValue; detail?: string }

/** The data file for one profile. The refresher writes it. The pane reads it. */
export type BandData = {
  dataVersion: number
  profile: string
  generatedAt: number
  lanes: SectionRecord<Lane[]>
  needs: SectionRecord<Need[]>
  mergeLine: SectionRecord<MergeLineData> | null
  codex: SectionRecord<CodexTask[]> | null
  services: SectionRecord<ServiceHealth[]> | null
}

// ---- Config ---------------------------------------------------------------

export type Rule = {
  /** All listed conditions must hold. Unlisted conditions are ignored. */
  when: RuleWhen
  stage: string
  status: LaneStatus
  blockedBy?: string
  failed?: boolean
}
export type RuleWhen = {
  draft?: boolean
  failing?: boolean
  pending?: boolean
  changesRequested?: boolean
  approved?: boolean
  autoMerge?: boolean
  merged?: boolean
  closed?: boolean
  label?: string
  /** True when the pull request is a plan: only plan files change, or the title says so. */
  plan?: boolean
}

export type GithubSourceConfig = {
  type: 'github'
  owner: string
  repos: string[]
  /** Every open PR with this label becomes a lane. */
  label?: string
  /** Use "@me" to list only your own PRs when no label is set. */
  author?: string
  limit?: number
  /** Issues and PRs with this label appear under NEEDS YOU. */
  needsLabel?: string
  rules?: Rule[]
  /** A pull request whose changed files all sit under these folders counts as a plan. */
  planPaths?: string[]
  /** A pull request whose title matches this expression (case-insensitive) counts as a plan. */
  planTitle?: string
}
export type FileSourceConfig = {
  type: 'file'
  path: string
  /** Set false to read only the needs from the file. Default true. */
  lanes?: boolean
}
export type CommandSourceConfig = { type: 'command'; argv: string[]; cwd?: string; timeoutSeconds?: number }
export type SourceConfig = GithubSourceConfig | FileSourceConfig | CommandSourceConfig

export type MergeLineConfig = {
  /** Program that prints "Head: #N" and "PR #N: note" lines. */
  command: string[]
  cwd?: string
  /** Re-run when the last good result is older than this. */
  ttlMinutes?: number
  timeoutSeconds?: number
  /** Only PRs of this repo name are listed under the section. */
  repo?: string
}
export type CodexConfig = { enabled: boolean; command?: string[] }
export type ServiceConfig = { name: string; url: string; allowRemote?: boolean }

export type MatchConfig = { always?: boolean; cwdContains?: string[]; sessions?: string[] }

export type ProfileConfig = {
  title?: string
  match?: MatchConfig
  sources: SourceConfig[]
  mergeLine?: MergeLineConfig
  codexCloud?: CodexConfig
  services?: ServiceConfig[]
}

export type RefreshConfig = {
  /** auto: read a fresh data file, else fetch in the pane. self: always fetch. file: only read. */
  mode?: 'auto' | 'self' | 'file'
  intervalMinutes?: number
  /** Show "stale" after this many minutes without a good fetch. */
  staleAfterMinutes?: number
}

export type Config = {
  configVersion: number
  refresh?: RefreshConfig
  /** Lanes below this count show a refill hint. 0 turns the hint off. */
  minMoving?: number
  stages?: StageDef[]
  statusColors?: Partial<Record<LaneStatus, Color>>
  profiles: Record<string, ProfileConfig>
}

// ---- Host and sources -----------------------------------------------------

export type RunResult = { exitCode: number; stdout: string; stderr: string }
export type RunOptions = { cwd?: string; timeoutMs?: number }

/** Everything the core needs from the outside world. The mod and the CLI each supply one. */
export type Host = {
  run(argv: readonly string[], options?: RunOptions): Promise<RunResult>
  readFile(path: string): Promise<string>
  now(): number
  /** Status code of a GET to a health URL. Rejects when nothing answers. Only used for opted-in services. */
  http?(url: string, timeoutMs: number): Promise<number>
  platform: 'win32' | 'darwin' | 'linux'
  /** Directory that holds config.json, data/ and overrides. */
  home: string
}

/** A thing a source needs on the machine, with how to get it. */
export type Requirement = { command: string; install: string }

export type SourceContext = { host: Host; profile: string; home: string; stageIds?: string[] }

/** A source failed in a way a person can fix. The message is shown in the pane. */
export class SourceError extends Error {}

export type Source<Config = unknown, Raw = unknown> = {
  type: string
  requires(config: Config): Requirement[]
  /** Fetch raw items. Throw SourceError with a plain reason when it fails. */
  fetch(config: Config, ctx: SourceContext): Promise<Raw[]>
  /** Map one raw item to a lane (stage, status, blockedBy). Return null to skip it. */
  toLane(raw: Raw, config: Config, ctx: SourceContext): Lane | null
  /** Optional: items that need the person. */
  fetchNeeds?(config: Config, ctx: SourceContext): Promise<Need[]>
}
