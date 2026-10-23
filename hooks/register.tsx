import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { DEFAULT_STAGES, loadConfig, pickProfile } from '../src/config.ts'
import { alerts } from '../src/insight.ts'
import { fetchMerged, updateFlow } from '../src/flow.ts'
import { checkData, emptyData, refreshMs } from '../src/data.ts'
import { fetchCodex, fetchLanes, fetchMergeLine, fetchNeeds, fetchServices } from '../src/refresh.ts'
import { buildStarterConfig, parseGithubRemote, STARTER_OVERRIDE } from '../src/starter.ts'
import type { BandData, Config, Host } from '../src/types.ts'
import { firstLine } from '../src/util.ts'
import { buildView } from '../src/view.ts'
import type { Line, Seg, SectionView } from '../src/view.ts'
import type { LoadState } from '../types'

const PANE = 'coordinator-band-pane'
const loadState = { plugin: 'coordinator-band', key: 'load' } as const
const dataState = { plugin: 'coordinator-band', key: 'data' } as const
const answeredState = { plugin: 'coordinator-band', key: 'answered' } as const
const collapsedAtom = atom({ plugin: 'coordinator-band', key: 'collapsed' } as const, {} as Record<string, boolean>)

type Ui = ReturnType<EngineInterface['ui']['resolve']>

// Module variables start over on a hot reload; `$.state` keeps the values.
let host: Host | null = null
let current: BandData | null = null
let config: Config | null = null
let profileName: string | null = null
const lastRun = { main: 0, services: 0, config: 0 }
const busy = new Set<string>()

async function makeHost($: EngineInterface): Promise<Host> {
  const override = await $.env.get('COORDINATOR_BAND_HOME')
  // USERPROFILE first: under Git Bash, HOME can be a /c/Users/... path that the engine cannot read.
  const winHome = await $.env.get('USERPROFILE')
  const userHome = winHome ?? (await $.env.get('HOME')) ?? ''
  const platform = winHome || /^[A-Za-z]:|\\/.test(userHome) ? 'win32' : userHome.startsWith('/Users/') ? 'darwin' : 'linux'
  const home = (override ?? `${userHome}/.coordinator-band`).replace(/\\/g, '/')
  return {
    platform,
    home,
    now: () => Date.now(),
    readFile: path => $.fs.read(path),
    async run(argv, o) {
      const go = (list: readonly string[]) =>
        $.process.run(list, { ...(o?.cwd ? { cwd: o.cwd } : {}), ...(o?.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) })
      try {
        return await go(argv)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // On Windows a program such as an npm tool is "name.cmd". Retry once, but never after a timeout.
        if (platform === 'win32' && !/timed out|still running|timeout/i.test(message) && argv[0] && !/\.\w+$/.test(argv[0])) {
          try {
            return await go([`${argv[0]}.cmd`, ...argv.slice(1)])
          } catch {
            // report the first failure
          }
        }
        throw err
      }
    },
    async http(url, ms) {
      const reply = await Promise.race([
        $.http.fetch(url),
        $.clock.sleep(ms).then(() => { throw new Error(`no answer in ${Math.round(ms / 1000)}s`) }),
      ])
      return reply.status
    },
  }
}

async function ensureHost($: EngineInterface): Promise<Host> {
  host ??= await makeHost($)
  return host
}

const paneTitle = (): string => (config && profileName ? config.profiles[profileName]?.title ?? profileName : 'Coordinator band')

const NO_CONFIG = (home: string) =>
  `No config yet (looked for ${home}/config.json). In this chat, type: /band init <github-owner>/<repo>`

async function setLoad($: EngineInterface, value: LoadState): Promise<void> {
  await $.state.set(loadState, value)
}

async function loadAll($: EngineInterface): Promise<void> {
  const h = await ensureHost($)
  lastRun.config = h.now()
  let text: string
  try {
    text = await h.readFile(`${h.home}/config.json`)
  } catch {
    config = null
    profileName = null
    await setLoad($, { profile: null, config: null, problems: [], hint: NO_CONFIG(h.home) })
    return
  }
  const loaded = loadConfig(text, `${h.home}/config.json`)
  config = loaded.config
  if (!loaded.config) {
    profileName = null
    await setLoad($, { profile: null, config: null, problems: loaded.problems.map(p => `${p.path}: ${p.message}`), hint: null })
    return
  }
  const id = await $.session.id()
  const cwd = await $.session.cwd()
  const enrolled = ((await $.store.get('enrolled')) ?? {}) as Record<string, string>
  const chosen = enrolled[id]
  profileName = pickProfile(loaded.config, { id, cwd }, chosen ? [chosen] : [])
  await setLoad($, {
    profile: profileName,
    config: loaded.config,
    problems: loaded.problems.map(p => `${p.path}: ${p.message}`),
    hint: profileName ? null : `This session has no profile. Profiles: ${Object.keys(loaded.config.profiles).join(', ')}. Type: /band on <name>`,
  })
}

const fired = new Set<string>()

async function putData($: EngineInterface, data: BandData): Promise<void> {
  const before = current
  current = data
  if (config) for (const text of alerts(before, data, config, Date.now(), fired)) $.ui.toast(text)
  await $.state.set(dataState, data)
  // Always visible, even with the pane closed: how many lanes move, and whether something needs you.
  const lanes = data.lanes.data
  const moving = lanes.filter(l => l.status === 'moving').length
  const needs = data.needs.data.length
  $.ui.status(lanes.length === 0 && data.lanes.fetchedAt === null ? undefined : `band ${moving}/${lanes.length} moving${needs > 0 ? ` · ${needs} need you` : ''}`)
}

/** Read the file the command-line refresher wrote. Returns true when its data was adopted. */
async function adoptFile($: EngineInterface, h: Host, name: string, cfg: Config, mode: string): Promise<boolean> {
  let text: string
  try {
    text = await h.readFile(`${h.home}/data/${name}.json`)
  } catch {
    return false
  }
  const checked = checkData(text, `${h.home}/data/${name}.json`)
  if (!checked.ok) {
    const load = (await $.state.get(loadState)).value
    if (load) await setLoad($, { ...load, problems: [...load.problems.filter(p => !p.includes('data/')), checked.reason] })
    return false
  }
  const fresh = h.now() - checked.data.generatedAt < 2 * refreshMs(cfg)
  if (mode === 'file' || fresh) {
    await putData($, checked.data)
    return true
  }
  return false
}

async function section<T>(name: string, job: () => Promise<T>): Promise<T | null> {
  if (busy.has(name)) return null
  busy.add(name)
  try {
    return await job()
  } finally {
    busy.delete(name)
  }
}

async function selfRefresh($: EngineInterface, h: Host, name: string, cfg: Config, force: boolean): Promise<void> {
  const profile = cfg.profiles[name]
  if (!profile) return
  if (!current || current.profile !== name) await putData($, emptyData(name, profile, h.now()))
  const ctx = { host: h, profile: name, home: h.home, stageIds: (cfg.stages ?? DEFAULT_STAGES).map(s => s.id) }
  const jobs: Promise<unknown>[] = [
    section('lanes', async () => {
      const rec = await fetchLanes(ctx, profile, current?.lanes)
      if (current) {
        const now = h.now()
        const flow = await fetchMerged(h, profile, updateFlow(current.flow, current.lanes.data, rec.data, now), now)
        await putData($, { ...current, lanes: rec, flow, generatedAt: now })
      }
    }),
    section('needs', async () => {
      const hadGoodFetch = current?.needs.fetchedAt != null
      const before = new Set((current?.needs.data ?? []).map(n => n.id))
      const rec = await fetchNeeds(ctx, profile, current?.needs)
      if (current) await putData($, { ...current, needs: rec, generatedAt: h.now() })
      if (hadGoodFetch) for (const need of rec.data) if (!before.has(need.id)) $.ui.toast(`Needs you: ${need.text}`)
    }),
  ]
  if (profile.mergeLine) {
    jobs.push(section('mergeline', async () => {
      const rec = await fetchMergeLine(h, profile.mergeLine!, current?.mergeLine, force)
      if (current) await putData($, { ...current, mergeLine: rec })
    }))
  }
  if (profile.codexCloud?.enabled) {
    jobs.push(section('codex', async () => {
      const rec = await fetchCodex(h, profile.codexCloud!, current?.codex)
      if (current) await putData($, { ...current, codex: rec })
    }))
  }
  await Promise.all(jobs)
}

async function servicesRefresh($: EngineInterface, h: Host, name: string, cfg: Config): Promise<void> {
  const list = cfg.profiles[name]?.services
  if (!list || list.length === 0) return
  lastRun.services = h.now()
  await section('services', async () => {
    const before = current?.services?.data ?? []
    const rec = await fetchServices(h, list, current?.services)
    if (current) await putData($, { ...current, services: rec })
    for (const s of rec.data) if (s.value === 'down' && before.find(b => b.name === s.name)?.value !== 'down') $.ui.toast(`${s.name} is down`)
  })
}

/** One pass: reload the config, then refresh whatever is due. */
async function tick($: EngineInterface, force = false): Promise<void> {
  const h = await ensureHost($)
  // Ages are worked out when the pane draws. Draw again each tick so a shown age can never freeze.
  $.ui.invalidate('ui.render')
  await loadAll($)
  if (!config || !profileName) return
  const mode = config.refresh?.mode ?? 'auto'
  const due = force || h.now() - lastRun.main >= refreshMs(config)
  if (due) {
    lastRun.main = h.now()
    if (mode === 'self' || !(await adoptFile($, h, profileName, config, mode))) {
      if (mode !== 'file') await selfRefresh($, h, profileName, config, force)
    }
  }
  if (mode !== 'file' && (force || h.now() - lastRun.services >= 60_000)) await servicesRefresh($, h, profileName, config)
}

// ---- Drawing --------------------------------------------------------------

const titleCase = (title: string): string => title.charAt(0).toUpperCase() + title.slice(1)

type Act = NonNullable<Seg['action']>

function Segments(props: { ui: Ui; line: Line; onAct: (a: Act) => void; id: string }) {
  const { Box, Button, Link, Text } = props.ui
  return (
    <Box flexDirection="row">
      {props.line.map((s, i) => {
        const key = `${props.id}-${i}`
        if (s.action) {
          const a = s.action
          return <Button key={key} label={s.text} onPress={() => props.onAct(a)} />
        }
        if (s.href) return <Link key={key} href={s.href}>{s.text}</Link>
        if (s.block) {
          const fill = s.dim ? 'gray' : (s.color ?? 'gray')
          return <Box key={key} width={2} marginRight={1} backgroundColor={fill}><Text> </Text></Box>
        }
        return <Text key={key} color={s.color} bold={s.bold} dimColor={s.dim}>{s.text}</Text>
      })}
    </Box>
  )
}

function Section(props: { ui: Ui; view: SectionView; collapsed: boolean; onToggle: () => void; onAct: (a: Act) => void }) {
  const { Box, Button, Text } = props.ui
  const v = props.view
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} paddingY={0} marginBottom={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Button key={`toggle-${v.id}`} plain onPress={props.onToggle}>
          <Text bold>{titleCase(v.title)}</Text>
          <Text dimColor>{props.collapsed ? ' >' : ' ⌄'}</Text>
        </Button>
        <Text color={v.noteColor}>{v.note}</Text>
      </Box>
      {props.collapsed ? null : (
        <Box flexDirection="column">
          {v.head ? (
            <Box flexDirection="row" justifyContent="space-between">
              <Segments id={`${v.id}-hl`} ui={props.ui} line={v.head.left} onAct={props.onAct} />
              <Segments id={`${v.id}-hr`} ui={props.ui} line={v.head.right} onAct={props.onAct} />
            </Box>
          ) : null}
          {v.bar ? (
            <Box flexDirection="row" width="100%" height={1} marginY={1}>
              {v.bar.map((p, i) => <Box key={`${v.id}-bar-${i}`} flexGrow={p.n} backgroundColor={p.color}><Text> </Text></Box>)}
            </Box>
          ) : null}
          {(v.legend ?? []).map(row => (
            <Box key={`${v.id}-lg-${row.label}`} flexDirection="row" justifyContent="space-between">
              <Box flexDirection="row">
                <Text color={row.color}>{'■ '}</Text>
                <Text dimColor={row.value === '0'}>{row.label}</Text>
              </Box>
              <Box flexDirection="row">
                <Text dimColor>{row.value.padStart(4)}</Text>
                <Text bold={row.value !== '0'} dimColor={row.value === '0'}>{row.pct.padStart(6)}</Text>
              </Box>
            </Box>
          ))}
          {v.lines.map((line, i) => <Segments key={`${v.id}-line-${i}`} id={`${v.id}-${i}`} ui={props.ui} line={line} onAct={props.onAct} />)}
          {v.footer && v.footer.some(s => s.text.trim()) ? <Segments id={`${v.id}-ft`} ui={props.ui} line={v.footer} onAct={props.onAct} /> : null}
        </Box>
      )}
    </Box>
  )
}

let timerStarted = false

/** Fetch every 30 s, but only in a session that has a profile. Other sessions never start the timer. */
function ensureTimer($: EngineInterface): void {
  if (timerStarted) return
  timerStarted = true
  $.clock.every(30_000, () => { void tick($).catch(() => {}) })
}

export const register: Register = on => {
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const [load, data, answered, collapsed] = await Promise.all([
      $.state.get(loadState), $.state.get(dataState), $.state.get(answeredState), read($, collapsedAtom),
    ])
    const l = load.value
    if (!l || !l.config || !l.profile) {
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold color="yellow">Coordinator band is not set up for this session</Text>
          {(l?.problems ?? []).map((p, i) => <Text key={`p-${i}`} color="red">{p}</Text>)}
          <Text>{l?.hint ?? 'Loading…'}</Text>
          <Text dimColor>Docs: README.md, section "Set up in two minutes".</Text>
        </Box>
      )
    }
    const profile = l.config.profiles[l.profile]
    const cwd = (await $.session.cwd()).replace(/\\/g, '/').toLowerCase()
    const focusRepo = (data.value?.lanes.data ?? []).map(x => x.ref?.split('#')[0] ?? '').find(r => r && cwd.includes(r.toLowerCase()))
    const view = buildView(data.value ?? null, l.config, {
      now: Date.now(),
      title: profile?.title ?? l.profile,
      ...(profile?.mergeLine?.repo ? { repoFilter: profile.mergeLine.repo } : {}),
      ...(collapsed.__compact ? { compact: true } : {}),
      ...(collapsed.__focus && focusRepo ? { focus: focusRepo } : {}),
    }, answered.value ?? {})
    const toggle = (id: string) => () => update($, collapsedAtom, c => ({ ...c, [id]: !c[id] }))
    const choose = (needId: string, option: number) => {
      void (async () => {
        const need = data.value?.needs.data.find(n => n.id === needId)
        const opt = need?.options?.[option]
        if (!need || !opt) return
        try {
          const to = need.to && /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(need.to) ? { sessionId: need.to } : need.to
          if (!to) { $.ui.toast('This need has no "to" session to send the reply to'); return }
          await $.session.send({ to, text: opt.text })
          await $.state.set(answeredState, { ...(answered.value ?? {}), [needId]: opt.label })
          $.ui.toast(`Sent: ${opt.label}`)
        } catch (err) {
          $.ui.toast(`Send failed: ${firstLine(String(err), 80)}`)
        }
      })()
    }
    const ask = (text: string, to?: string) => {
      void (async () => {
        try {
          await $.session.send({ to: { sessionId: to ?? (await $.session.id()) }, text })
          $.ui.toast(to ? 'Sent to its session' : 'Asked Claude')
        } catch (err) {
          $.ui.toast(`Could not send: ${firstLine(String(err), 80)}`)
        }
      })()
    }
    const act = (a: NonNullable<Seg['action']>) => {
      if (a.kind === 'choose') choose(a.needId, a.option)
      else if (a.kind === 'ask') ask(a.text, a.to)
      else void tick($, true).catch(() => {})
    }
    return (
      <Box flexDirection="column">
        {(l.problems.length > 0) ? <Text color="yellow">{l.problems.join(' | ')}</Text> : null}
        <Box flexDirection="row" justifyContent="flex-end">
          <Button key="mode-compact" label={collapsed.__compact ? 'Full' : 'Compact'} onPress={toggle('__compact')} />
          {focusRepo ? <Button key="mode-focus" label={collapsed.__focus ? 'All repos' : `Focus ${focusRepo}`} onPress={toggle('__focus')} /> : null}
        </Box>
        {view.sections.map(s => (
          <Section key={s.id} ui={ui} view={s} collapsed={!!collapsed[s.id]} onToggle={toggle(s.id)} onAct={act} />
        ))}
      </Box>
    )
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'band', description: 'Coordinator band: /band init <owner>/<repo>, validate, refresh, doctor, on <profile>' })
    await $.command.register({ name: 'pane', description: 'Open the coordinator band pane' })
    // Only a session that matches a profile (its id, its folder, or /band on) gets the pane, the timer and the fetches.
    await loadAll($).catch(() => {})
    if (profileName) {
      await tick($).catch(() => {})
      ensureTimer($)
      void $.ui.open({ id: PANE, title: paneTitle() })
    }
    return next(e)
  })

  on('command.run', { command: 'pane' }, async $ => {
    await $.ui.open({ id: PANE, title: paneTitle() })
    return { text: 'Band pane opened.' }
  })

  on('command.run', { command: 'band' }, async ($, e) => {
    const h = await ensureHost($)
    const args = String((e as { args?: unknown }).args ?? '').trim().split(/\s+/).filter(Boolean)
    const sub = args[0] ?? 'help'

    if (sub === 'init') {
      const spec = parseGithubRemote(`https://github.com/${args[1] ?? ''}`)
      if (!spec) return { text: 'Usage: /band init <github-owner>/<repo> [label]   Example: /band init example-org/example-app' }
      const path = `${h.home}/config.json`
      if (await $.fs.exists(path)) return { text: `${path} already exists. Edit it, or delete it and run /band init again.` }
      const cfg = buildStarterConfig({ owner: spec.owner, repos: [spec.repo], ...(args[2] ? { label: args[2] } : {}) })
      await $.fs.write(path, `${JSON.stringify(cfg, null, 2)}\n`)
      await $.fs.write(`${h.home}/overrides/main.example.json`, STARTER_OVERRIDE)
      await tick($, true)
      ensureTimer($)
      void $.ui.open({ id: PANE, title: paneTitle() })
      return { text: `Wrote ${path}. Add the label "${cfg.profiles.main?.sources[0] && 'label' in cfg.profiles.main.sources[0] ? cfg.profiles.main.sources[0].label : 'band'}" to a pull request in ${spec.owner}/${spec.repo} and it appears as a lane. Needs the GitHub tool: /band doctor` }
    }

    if (sub === 'validate' || sub === 'doctor') {
      await loadAll($)
      const load = (await $.state.get(loadState)).value
      const lines: string[] = []
      lines.push(load?.config ? 'OK    config.json is valid' : `FAIL  ${(load?.problems.join('; ') || load?.hint) ?? 'no config'}`)
      if (load?.problems.length && load.config) lines.push(...load.problems.map(p => `WARN  ${p}`))
      if (sub === 'doctor') {
        try {
          const v = await h.run(['gh', '--version'], { timeoutMs: 10_000 })
          lines.push(v.exitCode === 0 ? `OK    ${firstLine(v.stdout)}` : 'FAIL  gh did not run. Install it from https://cli.github.com')
          const a = await h.run(['gh', 'auth', 'status'], { timeoutMs: 15_000 })
          lines.push(a.exitCode === 0 ? 'OK    gh is signed in' : 'FAIL  gh is not signed in. Run in a terminal: gh auth login')
        } catch {
          lines.push('FAIL  the GitHub tool "gh" is not installed. Install it from https://cli.github.com then run: gh auth login')
        }
        lines.push('INFO  The band reads GitHub only. It sends nothing anywhere. Services are checked only if you list them.')
      }
      return { text: lines.join('\n') }
    }

    if (sub === 'on') {
      await loadAll($)
      const name = args[1]
      if (!name || !config?.profiles[name]) return { text: `Usage: /band on <profile>. Profiles: ${Object.keys(config?.profiles ?? {}).join(', ') || 'none (run /band init first)'}` }
      const enrolled = ((await $.store.get('enrolled')) ?? {}) as Record<string, string>
      enrolled[await $.session.id()] = name
      await $.store.set('enrolled', enrolled)
      await tick($, true)
      ensureTimer($)
      void $.ui.open({ id: PANE, title: paneTitle() })
      return { text: `This session now shows "${name}".` }
    }

    if (sub === 'refresh') {
      await tick($, true)
      return { text: 'Refreshed.' }
    }

    void $.ui.open({ id: PANE, title: paneTitle() })
    const age = current ? `${Math.round((h.now() - current.generatedAt) / 60_000)} min old` : 'no data yet'
    return {
      text: [
        `Coordinator band (${profileName ?? 'no profile'}, ${age}).`,
        '/band init <owner>/<repo>   write a starter config',
        '/band validate | doctor      check the config and tools',
        '/band refresh                fetch now',
        '/band on <profile>           use a profile in this session',
      ].join('\n'),
    }
  })
}
