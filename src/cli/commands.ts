// init, validate, doctor, refresh, show and version.

import { readdir, readFile, rm } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { join } from 'node:path'

import { DEFAULTS, loadConfig, pickProfile } from '../config.ts'
import { mermaid } from '../insight.ts'
import { refreshProfile } from '../refresh.ts'
import { parseGithubRemote, buildStarterConfig, STARTER_OVERRIDE } from '../starter.ts'
import { renderText } from '../text.ts'
import { CONFIG_VERSION, DATA_VERSION } from '../types.ts'
import type { BandData, Config } from '../types.ts'
import { asRecord, firstLine, parseJson } from '../util.ts'
import { buildView } from '../view.ts'
import { has, parseArgs, str } from './args.ts'
import { acquireLock, appendLog, atomicWrite, backup, bandHome, exists, MIN_NODE, paths, readText } from './files.ts'
import { createHost, run } from './host.ts'
import { isScheduled } from './schedule-cmd.ts'

const GH_INSTALL = 'Install the GitHub command-line tool from https://cli.github.com, then run: gh auth login'
const NAME_OK = /^[A-Za-z0-9][\w.-]*$/

// ---- helpers ---------------------------------------------------------------

type HomeConfig = { config: Config | null; lines: string[]; missing: boolean }

async function readConfig(path: string): Promise<HomeConfig> {
  const text = await readText(path)
  if (text === null) return { config: null, missing: true, lines: [`${path}: does not exist. Run: coordinator init`] }
  const { config, problems } = loadConfig(text, path)
  return { config, missing: false, lines: problems.map(p => `${p.path}: ${p.message}`) }
}

async function readData(path: string): Promise<{ data: BandData | null; reason?: string }> {
  const text = await readText(path)
  if (text === null) return { data: null }
  const parsed = parseJson(text)
  const root = parsed.ok ? asRecord(parsed.value) : null
  if (!root) return { data: null, reason: `${path} is not valid JSON. Run: coordinator refresh (it replaces the file).` }
  if (root.dataVersion !== DATA_VERSION) {
    return { data: null, reason: `${path} has dataVersion ${String(root.dataVersion)} but this release needs ${DATA_VERSION}. Run: coordinator refresh (it replaces the file).` }
  }
  return { data: root as unknown as BandData }
}

const csv = (s: string): string[] => s.split(',').map(x => x.trim()).filter(Boolean)

// ---- init ------------------------------------------------------------------

export const INIT_HELP = `Usage: coordinator init [--name n] [--owner o] [--repos a,b] [--label l] [--force] [--yes]

Writes a starter config for your GitHub repositories.
  --owner  GitHub user or organisation. Detected from this folder's git remote when you leave it out.
  --repos  Comma-separated repository names.
  --label  Open pull requests with this label become lanes. Default "band".
  --name   Name of the profile. Default "main".
  --force  Replace an existing config (the old one is kept as config.json.bak).
  --yes    Never ask questions. Missing values then stop the command.`

/** Run a short check. A program that is missing and one that is only slow are different problems. */
async function probe(argv: string[]): Promise<{ res: Awaited<ReturnType<typeof run>> | null; slow: boolean }> {
  try {
    return { res: await run(argv, { timeoutMs: 45_000 }), slow: false }
  } catch (e) {
    return { res: null, slow: /timed out/i.test(e instanceof Error ? e.message : String(e)) }
  }
}

export async function init(argv: string[]): Promise<number> {
  const p = parseArgs(argv, { bool: ['force', 'yes'], value: ['name', 'owner', 'repos', 'label'] })
  if (p.flags.help) { console.log(INIT_HELP); return 0 }
  if (p.error) { console.error(p.error); return 2 }
  const home = bandHome()
  const f = paths(home)
  if ((await exists(f.config)) && !has(p, 'force')) {
    console.error(`${f.config} already exists, so nothing was changed. To replace it, run: coordinator init --force (the old file is kept as config.json.bak). To check it, run: coordinator validate`)
    return 1
  }

  let owner = str(p, 'owner')
  let repos = str(p, 'repos') ? csv(str(p, 'repos') ?? '') : []
  const name = str(p, 'name') ?? 'main'
  const label = str(p, 'label') ?? 'band'
  if (!NAME_OK.test(name)) { console.error(`--name "${name}" may only use letters, numbers, dots, dashes and underscores. Example: --name main`); return 2 }

  let detectedOwner = ''
  let detectedRepo = ''
  if (!owner || repos.length === 0) {
    const remote = await run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 }).catch(() => null)
    const found = remote && remote.exitCode === 0 ? parseGithubRemote(remote.stdout) : null
    if (found) { detectedOwner = found.owner; detectedRepo = found.repo }
  }
  const interactive = process.stdin.isTTY === true && !has(p, 'yes')
  if (interactive && (!owner || repos.length === 0)) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
      const ask = async (q: string, def: string): Promise<string> => (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def
      if (!owner) owner = await ask('GitHub owner (user or organisation)', detectedOwner)
      if (repos.length === 0) repos = csv(await ask('Repositories (comma-separated)', detectedRepo))
    } finally {
      rl.close()
    }
  } else {
    owner ||= detectedOwner
    if (repos.length === 0 && detectedRepo) repos = [detectedRepo]
  }
  const missing = [...(owner ? [] : ['--owner']), ...(repos.length > 0 ? [] : ['--repos'])]
  if (missing.length > 0) {
    console.error(`Missing ${missing.join(' and ')}. Pass them, for example: coordinator init --owner example-org --repos example-app (or run this inside a folder cloned from GitHub).`)
    return 2
  }
  if (!/^[\w.-]+$/.test(owner ?? '') || !repos.every(r => /^[\w.-]+$/.test(r))) {
    console.error('Owner and repository names may only use letters, numbers, dots, dashes and underscores. Example: --owner example-org --repos example-app,other-app')
    return 2
  }

  const ghVersion = await probe(['gh', '--version'])
  if (ghVersion.slow) {
    console.log('Warning: gh did not answer in 45 seconds. The machine may be busy. Run "coordinator doctor" later.')
  } else if (!ghVersion.res || ghVersion.res.exitCode !== 0) {
    console.log(`Warning: the "gh" tool was not found. ${GH_INSTALL}`)
  } else {
    const auth = await probe(['gh', 'auth', 'status'])
    if (!auth.res || auth.res.exitCode !== 0) console.log('Warning: gh is installed but you are not signed in. Run: gh auth login')
  }

  const config = buildStarterConfig({ name, owner: owner ?? '', repos, label })
  const text = `${JSON.stringify(config, null, 2)}\n`
  const loaded = loadConfig(text, f.config)
  if (!loaded.config) {
    console.error(`The starter config is not valid, so nothing was written:\n${loaded.problems.map(x => `  ${x.path}: ${x.message}`).join('\n')}`)
    return 1
  }
  const kept = await backup(f.config)
  await atomicWrite(f.config, text)
  await atomicWrite(join(home, 'overrides', `${name}.example.json`), STARTER_OVERRIDE)
  console.log(`Wrote ${f.config}${kept ? ' (the old file is kept as config.json.bak)' : ''}`)
  console.log(`Wrote ${join(home, 'overrides', `${name}.example.json`)} (an example of hand-written lanes; optional)`)
  console.log(`
Next steps
  1. On GitHub, add the label "${label}" to a pull request in ${owner}/${repos.join(', ')}.
  2. Open Claude Code. The coordinator pane appears and shows that pull request as a lane.
  3. To see the coordinator in this terminal, run: coordinator show
  4. Optional: keep it fresh when Claude Code is closed with: coordinator schedule install`)
  return 0
}

// ---- validate --------------------------------------------------------------

export const VALIDATE_HELP = `Usage: coordinator validate [--config path]

Checks config.json and says what is wrong, line by line. Exits 1 when the config cannot be used.`

export async function validate(argv: string[]): Promise<number> {
  const p = parseArgs(argv, { value: ['config'] })
  if (p.flags.help) { console.log(VALIDATE_HELP); return 0 }
  if (p.error) { console.error(p.error); return 2 }
  const home = bandHome()
  const file = str(p, 'config') ?? paths(home).config
  const r = await readConfig(file)
  for (const line of r.lines) console.log(line)
  for (const name of await readdir(paths(home).dataDir).catch(() => [] as string[])) {
    if (!name.endsWith('.json')) continue
    const d = await readData(join(paths(home).dataDir, name))
    if (d.reason) console.log(`warning: ${d.reason}`)
  }
  if (!r.config) return 1
  console.log('config OK')
  return 0
}

// ---- doctor ----------------------------------------------------------------

export const DOCTOR_HELP = `Usage: coordinator doctor

Checks Node, gh, the coordinator folder, the config, the data files and the scheduled job. Prints OK, WARN or FAIL
for each, with the fix. Exits 1 when anything FAILs.`

export async function doctor(argv: string[]): Promise<number> {
  const p = parseArgs(argv, {})
  if (p.flags.help) { console.log(DOCTOR_HELP); return 0 }
  if (p.error) { console.error(p.error); return 2 }
  const home = bandHome()
  const f = paths(home)
  let failed = false
  const say = (level: 'OK' | 'WARN' | 'FAIL', what: string, fix?: string) => {
    if (level === 'FAIL') failed = true
    console.log(`${level.padEnd(4)}  ${what}${fix ? ` - ${fix}` : ''}`)
  }

  const [maj = 0, min = 0] = process.versions.node.split('.').map(Number)
  if (maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1])) say('OK', `Node ${process.versions.node}`)
  else say('FAIL', `Node ${process.versions.node} is too old`, 'install Node 22.18 or newer from https://nodejs.org')

  const gh = await probe(['gh', '--version'])
  if (gh.slow) {
    say('WARN', 'gh did not answer in 45 seconds', 'the machine may be busy. Run coordinator doctor again')
  } else if (gh.res && gh.res.exitCode === 0) {
    say('OK', 'gh is installed')
    const auth = await probe(['gh', 'auth', 'status'])
    if (auth.res && auth.res.exitCode === 0) say('OK', 'gh is signed in')
    else if (auth.slow) say('WARN', 'gh auth status did not answer in 45 seconds', 'run coordinator doctor again')
    else say('FAIL', 'gh is not signed in', 'run: gh auth login')
  } else {
    say('FAIL', 'gh is not installed', 'install it from https://cli.github.com, then run: gh auth login')
  }

  try {
    await atomicWrite(join(home, '.doctor-check'), 'ok')
    await rm(join(home, '.doctor-check'), { force: true })
    say('OK', `${home} is writable`)
  } catch (e) {
    say('FAIL', `${home} is not writable (${firstLine(e instanceof Error ? e.message : String(e), 80)})`, 'set COORDINATOR_HOME to a folder you can write to')
  }

  const r = await readConfig(f.config)
  if (r.config) say('OK', 'config is valid')
  else say('FAIL', 'config is not valid', `${r.lines.join(' / ')} (run: coordinator validate)`)

  if (r.config) {
    const staleMin = r.config.refresh?.staleAfterMinutes ?? DEFAULTS.staleAfterMinutes
    for (const name of Object.keys(r.config.profiles)) {
      const d = await readData(f.data(name))
      if (d.reason) say('WARN', `data for "${name}" cannot be used`, d.reason)
      else if (!d.data) say('WARN', `no data yet for "${name}"`, 'run: coordinator refresh')
      else {
        const age = Math.round((Date.now() - d.data.generatedAt) / 60_000)
        if (age > staleMin) say('WARN', `data for "${name}" is ${age} minutes old`, 'run: coordinator refresh, or keep it fresh with: coordinator schedule install')
        else say('OK', `data for "${name}" is ${age} minute(s) old`)
      }
    }
    const urls = Object.values(r.config.profiles).flatMap(pr => pr.services ?? [])
    if (urls.length === 0) say('OK', 'no health-check URLs are configured, so none are contacted')
    else say('OK', `health-check URLs: ${urls.map(s => `${s.name} ${s.url}`).join(', ')}`, 'these are the only URLs this tool contacts besides GitHub')
  }

  if (await isScheduled()) say('OK', 'scheduled refresh is installed')
  else say('WARN', 'scheduled refresh is not installed (optional)', 'run: coordinator schedule install')
  return failed ? 1 : 0
}

// ---- refresh ---------------------------------------------------------------

export const REFRESH_HELP = `Usage: coordinator refresh [--profile n] [--force-merge-line] [--quiet]

Fetches fresh data from GitHub (through gh) and writes data/<profile>.json. A failed section is stored as a
failure with its reason, and the last good data is kept. Exits 1 only for config or write errors.
  --profile n          Refresh one profile.
  --force-merge-line   Run the merge line command even if its last result is recent.
  --quiet              Print nothing on success.`

const sectionsOf = (d: BandData): [string, { error?: string }, number][] => [
  ['lanes', d.lanes, d.lanes.data.length],
  ['needs', d.needs, d.needs.data.length],
  ...(d.mergeLine ? [['merge-line', d.mergeLine, d.mergeLine.data.entries.length] as [string, { error?: string }, number]] : []),
  ...(d.codex ? [['codex', d.codex, d.codex.data.length] as [string, { error?: string }, number]] : []),
  ...(d.services ? [['services', d.services, d.services.data.length] as [string, { error?: string }, number]] : []),
]
const summarize = (d: BandData): string =>
  sectionsOf(d).map(([n, rec, count]) => (rec.error ? `${n}=error(${firstLine(rec.error, 100)})` : `${n}=ok(${count})`)).join(' ')

export async function refresh(argv: string[]): Promise<number> {
  const p = parseArgs(argv, { bool: ['force-merge-line', 'quiet'], value: ['profile'] })
  if (p.flags.help) { console.log(REFRESH_HELP); return 0 }
  if (p.error) { console.error(p.error); return 2 }
  const home = bandHome()
  const f = paths(home)
  const quiet = has(p, 'quiet')

  const r = await readConfig(f.config)
  if (!r.config) { for (const l of r.lines) console.error(l); return 1 }
  const config = r.config
  const only = str(p, 'profile')
  if (only && !config.profiles[only]) {
    console.error(`No profile named "${only}". The profiles in your config are: ${Object.keys(config.profiles).join(', ')}.`)
    return 2
  }

  const lock = await acquireLock(f.lock)
  if (typeof lock !== 'function') {
    if (!quiet) console.log(`Another refresh started ${Math.round(lock.heldForMs / 60_000)} minute(s) ago is still running, so this one was skipped. If it is stuck, delete ${f.lock}`)
    return 0
  }
  let code = 0
  try {
    const host = createHost(home)
    // Profiles refresh side by side, so a slow one does not hold back the others.
    await Promise.all(Object.entries(config.profiles).map(async ([name, profile]) => {
      if (only && name !== only) return
      try {
        const prev = await readData(f.data(name))
        const stamp = new Date().toISOString()
        if (prev.reason) await appendLog(f.log, `${stamp} ${name} ignoring old data file: ${prev.reason}`)
        const data = await refreshProfile(host, name, profile, prev.data, { forceMergeLine: has(p, 'force-merge-line'), stageIds: (config.stages ?? []).map(s => s.id) })
        await atomicWrite(f.data(name), `${JSON.stringify(data, null, 2)}\n`)
        await appendLog(f.log, `${new Date().toISOString()} ${name} ${summarize(data)}`)
        if (!quiet) console.log(`${name}: ${summarize(data)}`)
      } catch (e) {
        code = 1
        console.error(`Could not refresh "${name}": ${e instanceof Error ? e.message : String(e)}. Check that ${home} is writable (run: coordinator doctor).`)
      }
    }))
  } finally {
    await lock()
  }
  return code
}

// ---- show ------------------------------------------------------------------

export const GRAPH_HELP = `Usage: coordinator graph [--profile n]

Prints a Mermaid flowchart of the lanes: stage colours, dependencies ("depends on #12" in a pull request description) and campaigns.
Paste it into a Markdown file or any Mermaid viewer.`

export async function graph(argv: string[]): Promise<number> {
  const p = parseArgs(argv, { bool: [], value: ['profile'] })
  if (p.flags.help) { console.log(GRAPH_HELP); return 0 }
  if (p.error) { console.error(p.error); return 2 }
  const f = paths(bandHome())
  const r = await readConfig(f.config)
  if (!r.config) { for (const l of r.lines) console.error(l); return 1 }
  const names = Object.keys(r.config.profiles)
  const name = str(p, 'profile') ?? pickProfile(r.config, { id: '', cwd: process.cwd() }) ?? names[0]
  if (!name || !r.config.profiles[name]) { console.error(`No profile named "${str(p, 'profile') ?? ''}". The profiles in your config are: ${names.join(', ')}.`); return 2 }
  const d = await readData(f.data(name))
  if (d.reason) { console.error(d.reason); return 1 }
  if (!d.data) { console.log('no data yet - run: coordinator refresh'); return 0 }
  console.log(mermaid(d.data, r.config))
  return 0
}

export const SHOW_HELP = `Usage: coordinator show [--profile n] [--width n] [--json]

Prints the coordinator as text, from the last data file.`

export async function show(argv: string[]): Promise<number> {
  const p = parseArgs(argv, { bool: ['json'], value: ['profile', 'width'] })
  if (p.flags.help) { console.log(SHOW_HELP); return 0 }
  if (p.error) { console.error(p.error); return 2 }
  const home = bandHome()
  const f = paths(home)
  const r = await readConfig(f.config)
  if (!r.config) { for (const l of r.lines) console.error(l); return 1 }
  const config = r.config
  const names = Object.keys(config.profiles)
  const name = str(p, 'profile') ?? pickProfile(config, { id: '', cwd: process.cwd() }) ?? names[0]
  const profile = name ? config.profiles[name] : undefined
  if (!name || !profile) { console.error(`No profile named "${str(p, 'profile') ?? ''}". The profiles in your config are: ${names.join(', ')}.`); return 2 }
  const width = str(p, 'width')
  if (width !== undefined && !/^\d+$/.test(width)) { console.error(`--width must be a number, for example --width 80 (you gave "${width}").`); return 2 }

  const d = await readData(f.data(name))
  if (d.reason) { console.error(d.reason); return 1 }
  if (!d.data) { console.log('no data yet - run: coordinator refresh'); return 0 }
  const view = buildView(d.data, config, {
    now: Date.now(),
    title: profile.title ?? name,
    ...(profile.mergeLine?.repo ? { repoFilter: profile.mergeLine.repo } : {}),
  })
  console.log(has(p, 'json') ? JSON.stringify(view, null, 2) : renderText(view, width ? Number(width) : 64))
  return 0
}

// ---- version ---------------------------------------------------------------

export async function version(): Promise<number> {
  const parsed = parseJson(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  const pkg = parsed.ok ? asRecord(parsed.value) : null
  console.log(`coordinator-for-claude ${String(pkg?.version ?? 'unknown')} (config version ${CONFIG_VERSION}, data version ${DATA_VERSION})`)
  return 0
}

