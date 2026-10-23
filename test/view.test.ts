import { expect, test } from 'claude-code/testing'

import { loadConfig } from '../src/config.ts'
import { checkData, emptyData } from '../src/data.ts'
import { refreshProfile } from '../src/refresh.ts'
import { badge, sectionState } from '../src/state.ts'
import { barWidths, renderText } from '../src/text.ts'
import type { BandData, Config, SectionRecord } from '../src/types.ts'
import { buildView } from '../src/view.ts'
import { fakeHost, fixture, NOW, okRun } from './helpers.ts'

const MIN = 60_000
const config = (extra: Record<string, unknown> = {}, profile: Record<string, unknown> = {}): Config => {
  const loaded = loadConfig(JSON.stringify({
    configVersion: 1,
    ...extra,
    profiles: { main: { sources: [{ type: 'github', owner: 'cli', repos: ['cli'], label: 'band' }], ...profile } },
  }))
  expect(loaded.problems).toEqual([])
  return loaded.config!
}

async function liveData(profile: Record<string, unknown> = {}): Promise<{ data: BandData; cfg: Config }> {
  const cfg = config({}, profile)
  const host = fakeHost(argv => {
    if (argv[0] === 'gh' && argv[1] === 'pr') return okRun(fixture('gh-pr-list.json'))
    if (argv[0] === 'gh' && argv[1] === 'search') return okRun(argv[2] === 'prs' ? fixture('gh-search-prs.json') : fixture('gh-search-issues.json'))
    if (argv[0] === 'status-tool') return okRun(fixture('merge-line-status.txt'))
    if (argv[0] === 'codex') return okRun(fixture('codex-cloud-list.txt'))
    return undefined
  })
  const data = await refreshProfile(host, 'main', cfg.profiles.main!, null)
  return { data, cfg }
}

const text = (data: BandData | null, cfg: Config) => renderText(buildView(data, cfg, { now: NOW, title: 'Demo' }))

test('the four section states are decided one way for every section', async () => {
  const rec = (fetchedAt: number | null, error?: string): SectionRecord<unknown[]> => ({ data: [], fetchedAt, ...(error ? { error } : {}) })
  const stale = 30 * MIN
  expect(sectionState(rec(NOW - MIN), false, NOW, stale)).toBe('ok')
  expect(sectionState(rec(NOW - MIN), true, NOW, stale)).toBe('empty')
  expect(sectionState(rec(NOW - 40 * MIN), false, NOW, stale)).toBe('stale')
  expect(sectionState(rec(NOW - MIN, 'boom'), false, NOW, stale)).toBe('error')
  expect(sectionState(rec(null), false, NOW, stale)).toBe('error')
  expect(badge(rec(NOW - 5 * MIN, 'gh is not signed in'), false, NOW, stale).text).toBe('unavailable: gh is not signed in (last good 5m ago)')
  expect(badge(rec(NOW - 40 * MIN), false, NOW, stale).text).toBe('stale: data 40m old')
  expect(badge(rec(NOW - 40 * MIN), false, NOW, stale).color).toBe('yellow')
  expect(badge(rec(NOW - 8 * 60 * MIN), false, NOW, stale)).toMatchObject({ text: 'stale: data 8h old', color: 'red' })
})

test('the pane text shows every section with its age and no bare question mark', async () => {
  const { data, cfg } = await liveData({
    mergeLine: { command: ['status-tool'], repo: 'cli' },
    codexCloud: { enabled: true },
    services: [{ name: 'api', url: 'http://127.0.0.1:3000/health' }, { name: 'worker', url: 'http://localhost/down' }],
  })
  const out = text(data, cfg)
  for (const word of ['N E E D S   Y O U', 'L A N E S', 'S E R V I C E S', 'M E R G E   L I N E', 'C O D E X   C L O U D']) expect(out).toContain(word)
  expect(out).toContain('ok · now')
  expect(out).toContain('Head #421 · 4 in line')
  expect(out).toContain('■ merge-line')
  expect(out).toContain('waiting on a reviewer or a fix') // description of the current stage
  expect(out).toContain('worker (down)')
  expect(out).not.toMatch(/(^|\s)\?(\s|$)/)
})

test('a merge line with no head says none, never a question mark', async () => {
  const { data, cfg } = await liveData({ mergeLine: { command: ['status-tool'] } })
  const empty: BandData = { ...data, mergeLine: { data: { head: null, entries: [{ n: '5', note: 'draft' }] }, fetchedAt: NOW } }
  expect(text(empty, cfg)).toContain('Head #none · 1 in line')
  const failed: BandData = { ...data, mergeLine: { data: { head: null, entries: [] }, fetchedAt: null, error: 'merge line command gave no result (it printed nothing)' } }
  const out = text(failed, cfg)
  expect(out).toContain('unavailable: merge line command gave no result')
  expect(out).not.toContain('Head #')
})

test('a failed fetch says unavailable with the reason and still lists the last good lanes', async () => {
  const { data, cfg } = await liveData()
  const broken: BandData = { ...data, lanes: { ...data.lanes, error: 'github: gh is not signed in. Run: gh auth login' } }
  const out = text(broken, cfg)
  expect(out).toContain('unavailable: github: gh is not signed in. Run: gh auth login')
  expect(out).toContain('release download: add --verify')
  expect(text(null, cfg)).toContain('unavailable: nothing fetched yet')
  const first = emptyData('main', cfg.profiles.main, NOW)
  expect(text(first, cfg)).toContain('unavailable: first fetch in progress')
})

test('stale and empty are shown the same way on every section', async () => {
  const { data, cfg } = await liveData({ codexCloud: { enabled: true } })
  const old: BandData = {
    ...data,
    lanes: { ...data.lanes, fetchedAt: NOW - 2 * 3_600_000 },
    codex: { data: [], fetchedAt: NOW - MIN },
  }
  const out = text(old, cfg)
  expect(out).toContain('stale: data 2h old')
  expect(out).toContain('empty · 1m')
  expect(out).toContain('No tasks')
})

test('stages, descriptions, colours and status colours come from config', async () => {
  const cfg = config({
    stages: [
      { id: 'idea', label: 'idea', description: 'just an idea', color: 'gray' },
      { id: 'doing', label: 'doing', description: 'someone is on it', color: 'green' },
      { id: 'shipped', label: 'shipped', description: 'out the door', color: 'cyan' },
    ],
    statusColors: { moving: 'cyan' },
  })
  const data = emptyData('main', cfg.profiles.main, NOW)
  data.lanes = { data: [{ title: 'Custom lane', state: 'x', stage: 'doing', status: 'moving' }], fetchedAt: NOW }
  const view = buildView(data, cfg, { now: NOW, title: 'T' })
  const out = renderText(view)
  expect(out).toContain('▰▰▱ doing · someone is on it')
  expect(out).toContain('■ shipped')
  const dot = view.sections.find(s => s.id === 'lanes')!.lines[0]![0]!
  expect(dot.color).toBe('cyan')
  data.lanes.data[0]!.stage = 'build'
  expect(renderText(buildView(data, cfg, { now: NOW, title: 'T' }))).toContain('unknown stage "build"')
})

test('refill hint appears under the moving minimum and can be turned off', async () => {
  const { data } = await liveData()
  expect(text(data, config())).toContain('Below 3 moving.')
  expect(text(data, config({ minMoving: 0 }))).not.toContain('Below')
})

test('a rule list in config replaces the default rules', async () => {
  const cfg = config({}, {
    sources: [{
      type: 'github', owner: 'cli', repos: ['cli'], label: 'band',
      rules: [{ when: { label: 'blocked' }, stage: 'review', status: 'blocked', blockedBy: 'labelled blocked' }, { when: {}, stage: 'build', status: 'moving' }],
    }],
  })
  const host = fakeHost(() => okRun(fixture('gh-pr-list.json')))
  const data = await refreshProfile(host, 'main', cfg.profiles.main!, null)
  expect(data.lanes.data.find(l => l.ref === 'cli#14716')).toMatchObject({ status: 'blocked', blockedBy: 'labelled blocked' })
  expect(data.lanes.data.find(l => l.ref === 'cli#14791')).toMatchObject({ stage: 'build' })
})

test('old or broken files get a message naming the file, the versions and the fix', async () => {
  const none = loadConfig('{"profiles":{}}', 'config.json')
  expect(none.config).toBe(null)
  expect(none.problems[0]?.message).toContain('band migrate')
  const old = loadConfig('{"configVersion":0,"profiles":{}}', 'config.json')
  expect(old.problems[0]?.message).toContain('version 0 but this release needs version 1')
  const newer = loadConfig('{"configVersion":9,"profiles":{}}', 'config.json')
  expect(newer.problems[0]?.message).toContain('newer than this release')
  expect(loadConfig('{oops', 'config.json').problems[0]?.message).toContain('not valid JSON')
  const bad = loadConfig(JSON.stringify({ configVersion: 1, profiles: { a: { sources: [{ type: 'github', owner: 'o', repos: [] }] } } }))
  expect(bad.problems.map(p => p.path)).toContain('profiles.a.sources[0].repos')
  const stale = checkData('{"dataVersion":0}', 'data/main.json')
  expect(stale).toEqual({ ok: false, reason: expect.stringContaining('version 0 but this release reads version 1') })
  expect(checkData('nope', 'data/main.json').ok).toBe(false)
})

test('health URLs must be local unless the profile says allowRemote', async () => {
  const bad = loadConfig(JSON.stringify({
    configVersion: 1,
    profiles: { a: { sources: [{ type: 'file', path: 'x.json' }], services: [{ name: 'site', url: 'https://example.com/health' }] } },
  }))
  expect(bad.config).toBe(null)
  expect(bad.problems[0]?.message).toContain('allowRemote')
  for (const url of ['http://localhost:3000/h', 'http://127.0.0.1/h', 'http://192.168.1.4/h', 'http://[::1]:80/h']) {
    const ok = loadConfig(JSON.stringify({ configVersion: 1, profiles: { a: { sources: [{ type: 'file', path: 'x.json' }], services: [{ name: 's', url }] } } }))
    expect(ok.problems).toEqual([])
  }
})

test('no profile makes any service call unless services are listed', async () => {
  const { data } = await liveData()
  expect(data.services).toBe(null)
})

test('a long needs list shows the first eight and counts the rest', async () => {
  const cfg = config()
  const data = emptyData('main', cfg.profiles.main, NOW)
  data.needs = { data: Array.from({ length: 11 }, (_, i) => ({ id: 'n' + i, text: 'Need ' + i, firstSeen: NOW - 10 * MIN })), fetchedAt: NOW }
  const out = text(data, cfg)
  expect(out).toContain('Need 7')
  expect(out).not.toContain('Need 8')
  expect(out).toContain('… and 3 more')
})

test('hand-kept lanes make the section as old as the file, and a merged pull request stops looking open', async () => {
  const cfg = config({}, { sources: [{ type: 'github', owner: 'cli', repos: ['cli'], label: 'nothing-has-this' }, { type: 'file', path: 'overrides/main.json' }] })
  const host = fakeHost(argv => {
    if (argv[1] === 'pr' && argv[2] === 'list') return okRun('[]')
    if (argv[1] === 'pr' && argv[2] === 'view') return okRun(fixture('gh-pr-view-merged.json'))
    if (argv[1] === 'search') return okRun('[]')
    return undefined
  }, { '/home/test/.coordinator-band/overrides/main.json': fixture('feed-old-overrides.json') })
  const data = await refreshProfile(host, 'main', cfg.profiles.main!, null)
  const merged = data.lanes.data.find(l => l.ref === 'cli#14784')!
  expect(merged).toMatchObject({ status: 'done', stage: 'merged', state: 'merged' })
  // The file says it was written at 10:00; the fetch is at 18:00. The section is 8h old, not "now".
  expect(data.lanes.fetchedAt).toBe(Date.parse('2026-10-22T10:00:00Z'))
  const out = text(data, cfg)
  expect(out).toContain('stale: data 8h old')
  expect(buildView(data, cfg, { now: NOW, title: 'T' }).sections.find(s => s.id === 'lanes')?.noteColor).toBe('red')
  expect(out).not.toContain('ok · now')
})

test('a closed pull request named by a hand-kept lane is dropped, and a failed check leaves the lane alone', async () => {
  const cfg = config({}, { sources: [{ type: 'github', owner: 'cli', repos: ['cli'], label: 'x' }, { type: 'file', path: 'overrides/main.json' }] })
  const files = { '/home/test/.coordinator-band/overrides/main.json': fixture('feed-old-overrides.json') }
  const closed = fakeHost(argv => (argv[2] === 'list' ? okRun('[]') : argv[1] === 'search' ? okRun('[]') : okRun('{"state":"CLOSED"}')), files)
  expect((await refreshProfile(closed, 'main', cfg.profiles.main!, null)).lanes.data.map(l => l.ref)).toEqual([undefined])
  const down = fakeHost(argv => (argv[2] === 'list' ? okRun('[]') : argv[1] === 'search' ? okRun('[]') : { exitCode: 1, stdout: '', stderr: 'HTTP 502' }), files)
  expect((await refreshProfile(down, 'main', cfg.profiles.main!, null)).lanes.data.length).toBe(2)
})

test('a file source can be read for needs only', async () => {
  const cfg = config({}, { sources: [{ type: 'github', owner: 'cli', repos: ['cli'], label: 'x' }, { type: 'file', path: 'o.json', lanes: false }] })
  const host = fakeHost(argv => (argv[1] === 'pr' ? okRun('[]') : argv[1] === 'search' ? okRun('[]') : undefined), { '/home/test/.coordinator-band/o.json': fixture('feed-old-overrides.json') })
  expect((await refreshProfile(host, 'main', cfg.profiles.main!, null)).lanes.data).toEqual([])
})

test('the lanes card has a headline, a stacked bar, legend rows and a refresh button', async () => {
  const { data, cfg } = await liveData()
  const view = buildView(data, cfg, { now: NOW, title: 'T' })
  const lanes = view.sections.find(s => s.id === 'lanes')!
  expect(lanes.head?.left[0]?.text).toMatch(/^\d+ of 8 moving$/)
  expect(lanes.bar?.reduce((n, p) => n + p.n, 0)).toBe(8)
  expect(lanes.legend?.map(r => r.label)).toEqual(['build', 'verify', 'review', 'merge-line', 'merged'])
  expect(lanes.legend?.reduce((n, r) => n + Number(r.value), 0)).toBe(8)
  expect(lanes.footer?.some(s => s.action?.kind === 'refresh')).toBe(true)
  const out = renderText(view)
  expect(out).toContain('■ review')
  expect(out).toMatch(/█{5,}/)
  expect(out).toContain('[Refresh]')
})

test('bar widths always add up to the width and give every non-empty part a block', async () => {
  const w = barWidths([{ color: 'green', n: 1 }, { color: 'red', n: 1 }, { color: 'cyan', n: 1 }], 10)
  expect(w.reduce((a, b) => a + b, 0)).toBe(10)
  const small = barWidths([{ color: 'green', n: 100 }, { color: 'red', n: 1 }], 20)
  expect(small[1]).toBeGreaterThanOrEqual(1)
  expect(barWidths([{ color: 'green', n: 0 }], 10)).toEqual([0])
})
