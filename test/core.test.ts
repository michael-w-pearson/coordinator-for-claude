import { expect, test } from 'claude-code/testing'

import { DEFAULT_RULES, loadConfig, pickProfile } from '../src/config.ts'
import { codexLaneLine, mergePosition, parseCodexList, parseMergeLine } from '../src/parsers.ts'
import { fetchCodex, fetchLanes, fetchMergeLine, fetchNeeds, mergeLanes, refreshProfile } from '../src/refresh.ts'
import { applyRules, factsOf } from '../src/rules.ts'
import { badge } from '../src/state.ts'
import type { ProfileConfig } from '../src/types.ts'
import { fakeHost, fixture, NOW, okRun } from './helpers.ts'

const prList = JSON.parse(fixture('gh-pr-list.json')) as Record<string, unknown>[]
const byNumber = (n: number) => prList.find(p => p.number === n) as Record<string, unknown>

const profile: ProfileConfig = { sources: [{ type: 'github', owner: 'cli', repos: ['cli'], label: 'band' }] }

test('rules place recorded pull requests by draft, checks and review state', async () => {
  const place = (n: number) => applyRules(DEFAULT_RULES, factsOf({ ...byNumber(n), state: 'OPEN' }))
  expect(place(14783)).toEqual({ stage: 'build', status: 'moving' }) // draft
  expect(place(14791)).toEqual({ stage: 'merge-line', status: 'waiting', blockedBy: 'ready to merge' }) // approved, clean
  expect(place(13788)).toEqual({ stage: 'review', status: 'blocked', blockedBy: '3 check(s) failing' })
  expect(place(13982)).toEqual({ stage: 'review', status: 'blocked', blockedBy: 'changes requested' })
  expect(place(14727)).toEqual({ stage: 'review', status: 'waiting', blockedBy: 'awaiting review' })
  expect(factsOf(byNumber(14716)).labels).toContain('blocked')
})

test('rules read both CheckRun and StatusContext rows, and auto-merge', async () => {
  const facts = factsOf({
    isDraft: false, state: 'OPEN', autoMergeRequest: { enabledBy: { login: 'x' } },
    statusCheckRollup: [{ __typename: 'StatusContext', state: 'PENDING' }, { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: '' }],
  })
  expect(facts.pending).toBe(2)
  expect(applyRules(DEFAULT_RULES, facts)?.stage).toBe('merge-line')
  expect(applyRules(DEFAULT_RULES, { ...facts, autoMerge: false })?.stage).toBe('verify')
})

test('github source turns a labelled recorded list into lanes with no model call', async () => {
  const host = fakeHost(argv => (argv[0] === 'gh' && argv[1] === 'pr' ? okRun(fixture('gh-pr-list.json')) : undefined))
  const rec = await fetchLanes({ host, profile: 'p', home: host.home }, profile, null)
  expect(rec.error).toBeUndefined()
  expect(rec.data.length).toBe(8)
  expect(host.calls.every(c => c[0] === 'gh')).toBe(true)
  expect(host.calls[0]).toContain('--label')
  const draft = rec.data.find(l => l.ref === 'cli#14783')
  expect(draft?.stage).toBe('build')
  expect(draft?.url).toBe('https://github.com/cli/cli/pull/14783')
})

test('a missing gh is a plain reason with the install address, and last good lanes are kept', async () => {
  const good = fakeHost(() => okRun(fixture('gh-pr-list.json')))
  const first = await fetchLanes({ host: good, profile: 'p', home: good.home }, profile, null)
  const bad = fakeHost(() => new Error('spawn gh ENOENT'))
  const next = await fetchLanes({ host: bad, profile: 'p', home: bad.home }, profile, first)
  expect(next.error).toContain('"gh" is not installed')
  expect(next.error).toContain('https://cli.github.com')
  expect(next.data.length).toBe(8)
  expect(badge(next, false, NOW, 30 * 60_000).text).toContain('unavailable: github:')
  const signedOut = fakeHost(() => ({ exitCode: 4, stdout: '', stderr: 'To get started with GitHub CLI, please run:  gh auth login' }))
  expect((await fetchLanes({ host: signedOut, profile: 'p', home: '' }, profile, null)).error).toContain('gh auth login')
})

test('needs come from the recorded search output and keep their first-seen time', async () => {
  const host = fakeHost(argv => (argv[1] === 'search' ? okRun(fixture(argv[2] === 'prs' ? 'gh-search-prs.json' : 'gh-search-issues.json')) : undefined))
  const rec = await fetchNeeds({ host, profile: 'p', home: host.home }, profile, null)
  expect(rec.error).toBeUndefined()
  expect(rec.data.length).toBeGreaterThan(0)
  expect(rec.data[0]?.id).toMatch(/^cli\/cli#\d+$/)
  expect(rec.data[0]?.firstSeen).toBe(NOW)
})

test('merge line text parses; a failed run keeps the last good result and says why', async () => {
  const parsed = parseMergeLine(fixture('merge-line-status.txt'))
  expect(parsed?.head).toBe('421')
  expect(mergePosition(parsed!, '421')).toBe('head')
  expect(mergePosition(parsed!, '422')).toBe('behind head')
  expect(mergePosition(parsed!, '423')).toBe('held')
  expect(mergePosition(parsed!, '9')).toBe('not in line')
  expect(parseMergeLine('nothing useful')).toBe(null)

  const config = { command: ['status-tool'], ttlMinutes: 8 }
  const goodHost = fakeHost(() => okRun(fixture('merge-line-status.txt')))
  const good = await fetchMergeLine(goodHost, config, null)
  expect(good.data.head).toBe('421')
  // Fresh result inside the ttl: no command runs.
  const again = await fetchMergeLine(goodHost, config, good)
  expect(again).toBe(good)
  expect(goodHost.calls.length).toBe(1)
  // The command printed nothing (the live bug: an empty cache file): keep the last good head.
  const blank = fakeHost(() => ({ exitCode: 1, stdout: '', stderr: 'TLS handshake timeout' }))
  const failed = await fetchMergeLine(blank, config, good, true)
  expect(failed.data.head).toBe('421')
  expect(failed.error).toContain('TLS handshake timeout')
})

test('codex list parses the recorded output; unreadable text is an error, not an empty list', async () => {
  const tasks = parseCodexList(fixture('codex-cloud-list.txt'))
  expect(tasks.length).toBe(4)
  expect(tasks[0]?.status).toBe('READY')
  expect(tasks[0]?.age).toBe('8m ago')
  expect(codexLaneLine(tasks[2], 'review')?.color).toBe('red') // READY for 20 minutes
  const garbled = await fetchCodex(fakeHost(() => okRun('Something changed in the tool output')), { enabled: true }, null)
  expect(garbled.error).toContain('cannot read')
  const none = await fetchCodex(fakeHost(() => okRun('')), { enabled: true }, null)
  expect(none.error).toBeUndefined()
})

test('lanes with the same ref merge field by field, later sources winning', async () => {
  const lanes = mergeLanes([
    { title: 'A', ref: 'r#1', state: 'draft', stage: 'build', status: 'moving' },
    { title: 'A', ref: 'r#1', state: '', stage: 'verify', status: 'waiting', blockedBy: 'x' },
    { title: 'B', state: '', stage: 'build', status: 'moving' },
  ])
  expect(lanes.length).toBe(2)
  expect(lanes[0]).toMatchObject({ stage: 'verify', status: 'waiting', state: 'draft', blockedBy: 'x' })
})

test('a command source adds lanes from any program with no core change', async () => {
  const host = fakeHost(argv => (argv[0] === 'my-tracker'
    ? okRun(JSON.stringify([{ title: 'Ticket 9', ref: 'T#9', stage: 'review', status: 'blocked', blockedBy: 'waiting on legal' }]))
    : undefined))
  const rec = await refreshProfile(host, 'p', { sources: [{ type: 'command', argv: ['my-tracker'] }] }, null)
  expect(rec.lanes.data[0]).toMatchObject({ title: 'Ticket 9', stage: 'review', status: 'blocked', source: 'command:0' })
  expect(rec.lanes.error).toBeUndefined()
})

test('profile choice: one profile without rules always fits; rules narrow others', async () => {
  const one = loadConfig(JSON.stringify({ configVersion: 1, profiles: { a: profile } })).config!
  expect(pickProfile(one, { id: 's', cwd: '/x' })).toBe('a')
  const two = loadConfig(JSON.stringify({
    configVersion: 1,
    profiles: { a: { ...profile, match: { cwdContains: ['proj-a'] } }, b: { ...profile, match: { sessions: ['abc'] } } },
  })).config!
  expect(pickProfile(two, { id: 'zzz', cwd: 'C:\\work\\proj-a\\x' })).toBe('a')
  expect(pickProfile(two, { id: 'abc', cwd: '/y' })).toBe('b')
  expect(pickProfile(two, { id: 'q', cwd: '/y' })).toBe(null)
  expect(pickProfile(two, { id: 'q', cwd: '/y' }, ['b'])).toBe('b')
})

test('plan stage: docs-only files or a plan title put a pull request in plan, code stays in build and review', async () => {
  const plan = { planPaths: ['wiki/plans/', 'wiki/decisions/'], planTitle: /^(plan(\([^)]*\))?:|docs\(plans\))/i }
  const place = (row: Record<string, unknown>) => applyRules(DEFAULT_RULES, factsOf({ ...row, state: 'OPEN' }, plan))
  const docs = [{ path: 'wiki/plans/2026-10-22-x.md' }, { path: 'wiki/decisions/y.md' }]
  const ready = { ...byNumber(14727), files: docs } // recorded ready PR with its files swapped for plan files
  expect(place(ready)).toEqual({ stage: 'plan', status: 'waiting', blockedBy: 'plan in review' })
  expect(place({ ...ready, isDraft: true })).toEqual({ stage: 'plan', status: 'moving' })
  expect(place({ ...byNumber(14727), title: 'plan(band): add a plan stage' })?.stage).toBe('plan')
  expect(place({ ...ready, files: [...docs, { path: 'src/a.ts' }] })?.stage).toBe('review') // one code file: not a plan
  expect(place(byNumber(14783))?.stage).toBe('build') // recorded draft code PR
  expect(place({ ...ready, autoMergeRequest: { enabledBy: { login: 'x' } } })?.stage).toBe('merge-line')
})
