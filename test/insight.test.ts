import { expect, test } from 'claude-code/testing'

import { loadConfig } from '../src/config.ts'
import { fetchMerged, median, perDay, sparkline, updateFlow } from '../src/flow.ts'
import { alerts, campaigns, depTree, mermaid, nextAction } from '../src/insight.ts'
import type { BandData, Config, Lane } from '../src/types.ts'
import { buildView } from '../src/view.ts'
import { renderText } from '../src/text.ts'
import { fakeHost, NOW, okRun } from './helpers.ts'

const HOUR = 3_600_000
const cfg = (): Config => loadConfig(JSON.stringify({ configVersion: 1, profiles: { p: { sources: [{ type: 'github', owner: 'o', repos: ['app'], label: 'band' }] } } })).config as Config
const lane = (n: number, rest: Partial<Lane> = {}): Lane => ({ title: `Lane ${n}`, ref: `app#${n}`, state: '', stage: 'build', status: 'moving', since: NOW - HOUR, ...rest })
const data = (lanes: Lane[], rest: Partial<BandData> = {}): BandData => ({
  dataVersion: 1, profile: 'p', generatedAt: NOW,
  lanes: { data: lanes, fetchedAt: NOW }, needs: { data: [], fetchedAt: NOW }, mergeLine: null, codex: null, services: null, ...rest,
})

test('next action: first rule that fits wins, in a fixed order', async () => {
  const c = cfg()
  const need = { id: 'n', text: 'Pick a name' }
  expect(nextAction(data([lane(1, { status: 'blocked' })], { needs: { data: [need], fetchedAt: NOW } }), c, NOW).text).toBe('Answer: Pick a name')
  const queue = { data: { head: '2', entries: [] }, fetchedAt: NOW }
  expect(nextAction(data([lane(1, { status: 'blocked' }), lane(2, { stage: 'merge-line', status: 'waiting' })], { mergeLine: queue }), c, NOW).text).toBe('Merge #2: Lane 2')
  const blocked = nextAction(data([lane(1, { status: 'blocked', blockedBy: '2 check(s) failing' })]), c, NOW)
  expect(blocked.text).toBe('Unblock: Lane 1 (2 check(s) failing)')
  expect(blocked.ask).toContain('app#1')
  expect(nextAction(data([lane(1, { stage: 'review', status: 'waiting', since: NOW - 30 * HOUR })]), c, NOW).text).toBe('Nudge: Lane 1 has sat in review for 30h')
  expect(nextAction(data([lane(1), lane(2, { status: 'waiting' })]), c, NOW).text).toBe('Start: Lane 2')
  expect(nextAction(data([lane(1), lane(2), lane(3)]), c, NOW).text).toBe('Nothing to do. Flow is healthy.')
  expect(nextAction(data([lane(1, { status: 'blocked', session: { id: 'abc', title: 't' } })]), c, NOW).to).toBe('abc')
})

test('campaigns count open lanes and recent merged pull requests per group', async () => {
  const flow = { merged: [{ ref: 'app#9', at: NOW, campaign: 'launch' }, { ref: 'app#8', at: NOW }], stageMs: {} }
  const out = campaigns(data([lane(1, { campaign: 'launch' }), lane(2, { campaign: 'launch', status: 'blocked' }), lane(3)], { flow }))
  expect(out).toEqual([{ name: 'launch', open: 2, merged: 1, blocked: 1 }])
})

test('dependencies: a tree from the lane others wait on, and Mermaid text with stage colours and groups', async () => {
  const lanes = [lane(1), lane(2, { dependsOn: ['app#1'] }), lane(3, { dependsOn: ['app#2', 'app#99'], campaign: 'launch' }), lane(4)]
  expect(depTree(lanes).map(r => `${r.depth}:${r.ref}`)).toEqual(['0:app#1', '1:app#2', '2:app#3'])
  const text = mermaid(data(lanes), cfg())
  expect(text).toContain('n_app_1 --> n_app_2')
  expect(text).toContain('n_app_2 --> n_app_3')
  expect(text).not.toContain('app_99')
  expect(text).toContain('subgraph n_campaign_launch["launch"]')
  expect(text).toMatch(/classDef n_build fill:#[0-9a-f]{6}/)
})

test('alerts: silent on the first pass, once per change, again after the condition clears', async () => {
  const c = cfg()
  const fired = new Set<string>()
  const blocked = data([lane(1, { status: 'blocked', blockedBy: 'checks' })])
  expect(alerts(null, blocked, c, NOW, fired)).toEqual([])
  expect(alerts(blocked, blocked, c, NOW, fired)).toEqual([])
  const ok = data([lane(1)])
  expect(alerts(blocked, ok, c, NOW, fired)).toEqual([])
  expect(alerts(ok, blocked, c, NOW, fired)).toEqual(['Blocked: Lane 1 (checks)'])
  const stuck = data([lane(2, { since: NOW - 30 * HOUR })])
  expect(alerts(blocked, stuck, c, NOW, fired)).toEqual(['Stuck 30h in build: Lane 2'])
  const queue = (head: string) => data([lane(3)], { mergeLine: { data: { head, entries: [] }, fetchedAt: NOW } })
  expect(alerts(ok, queue('7'), c, NOW, fired)).toEqual(['Merge queue head is now #7'])
  expect(alerts(queue('7'), queue('8'), c, NOW, fired)).toEqual(['Merge queue head is now #8'])
})

test('flow: stage durations, hourly merged fetch with one call per repo, per-day counts', async () => {
  const before = [lane(1, { since: NOW - 5 * HOUR })]
  const flow = updateFlow(undefined, before, [lane(1, { stage: 'review', since: NOW })], NOW)
  expect(flow.stageMs.build).toEqual([5 * HOUR])
  expect(median([1, 5, 3])).toBe(3)
  expect(median([])).toBeNull()
  const rows = JSON.stringify([{ number: 7, mergedAt: new Date(NOW - 2 * HOUR).toISOString(), labels: [{ name: 'campaign:x' }] }])
  const host = fakeHost(() => okRun(rows))
  const profile = { sources: [{ type: 'github' as const, owner: 'o', repos: ['app', 'web'], label: 'band' }] }
  const first = await fetchMerged(host, profile, flow, NOW)
  expect(host.calls.length).toBe(2)
  expect(first.merged.find(m => m.ref === 'app#7')?.campaign).toBe('x')
  await fetchMerged(host, profile, first, NOW + 30 * 60_000)
  expect(host.calls.length).toBe(2) // inside the hour: no call
  await fetchMerged(host, profile, first, NOW + 61 * 60_000)
  expect(host.calls.length).toBe(4)
  const week = perDay({ merged: [{ ref: 'a', at: NOW }, { ref: 'b', at: NOW - 1000 }, { ref: 'c', at: NOW - 25 * HOUR }], stageMs: {} }, NOW)
  expect(week.slice(-2)).toEqual([1, 2])
  expect(sparkline([0, 1, 2]).length).toBe(3)
})

test('the pane view shows next first, check names, reviewers, dependencies, an ask button, and compact is shorter', async () => {
  const lanes = [
    lane(1, { status: 'blocked', blockedBy: '2 check(s) failing', checks: ['lint', 'unit'], waitingOn: ['sam'], dependsOn: ['app#2'], stage: 'review', campaign: 'launch' }),
    lane(2),
  ]
  const d = data(lanes)
  const c = cfg()
  const full = buildView(d, c, { now: NOW, title: 'T' })
  expect(full.sections[0]?.id).toBe('next')
  const out = renderText(full)
  expect(out).toContain('✕ lint, unit')
  expect(out).toContain('@sam')
  expect(out).toContain('⛓ waits on app#2')
  expect(out).toContain('[Ask Claude]')
  expect(full.sections.map(s => s.id)).toContain('campaigns')
  const compact = renderText(buildView(d, c, { now: NOW, title: 'T', compact: true }))
  expect(compact.split('\n').length).toBeLessThan(out.split('\n').length)
  expect(compact).not.toContain('⛓')
  const focused = renderText(buildView(data([lane(1), { ...lane(2), ref: 'web#2', title: 'Web lane' }]), c, { now: NOW, title: 'T', focus: 'web' }))
  expect(focused).toContain('Web lane')
  expect(focused).not.toContain('Lane 1')
})
