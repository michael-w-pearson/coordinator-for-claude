// Plain facts worked out from the lanes: what to do next, campaign progress, dependency tree, Mermaid graph. Pure.

import { DEFAULT_STAGES } from './config.ts'
import { refNumber } from './parsers.ts'
import type { BandData, Config, Lane } from './types.ts'

const HOUR = 3_600_000

export type Next = { text: string; color: 'red' | 'yellow' | 'green' | 'cyan'; ask?: string; to?: string }

/** A prompt for Claude about one lane. It holds the facts the band already knows. */
export function askText(lane: Lane): string {
  const bits = [`Look at ${lane.ref ?? lane.title}${lane.url ? ` (${lane.url})` : ''}: "${lane.title}".`, `It is in the ${lane.stage} stage and ${lane.status}.`]
  if (lane.blockedBy) bits.push(`Reason: ${lane.blockedBy}.`)
  if (lane.checks?.length) bits.push(`Failing checks: ${lane.checks.join(', ')}.`)
  if (lane.waitingOn?.length) bits.push(`Waiting on: ${lane.waitingOn.join(', ')}.`)
  if (lane.dependsOn?.length) bits.push(`It depends on: ${lane.dependsOn.join(', ')}.`)
  bits.push('Say what the next step is, and do it if it is safe and local.')
  return bits.join(' ')
}

const inStage = (lane: Lane, now: number): number => (lane.since ? now - lane.since : 0)

/** One line that says what to do right now. The first rule that fits wins. No model is called. */
export function nextAction(data: BandData, config: Config, now: number): Next {
  const lanes = data.lanes.data
  const stages = config.stages ?? DEFAULT_STAGES
  const stuckAfter = (config.stuckHours ?? 24) * HOUR
  const need = data.needs.data[0]
  if (need) return { text: `Answer: ${need.text}`, color: 'red' }
  const head = data.mergeLine?.data.head
  const headLane = head ? lanes.find(l => refNumber(l.ref) === head) : undefined
  if (headLane && headLane.status !== 'blocked' && headLane.status !== 'done') {
    return { text: `Merge #${head}: ${headLane.title}`, color: 'green', ask: `Check #${head} is ready and tell me before merging. ${askText(headLane)}`, ...(headLane.session ? { to: headLane.session.id } : {}) }
  }
  const blocked = lanes.filter(l => l.status === 'blocked').sort((a, b) => (a.since ?? 0) - (b.since ?? 0))[0]
  if (blocked) return { text: `Unblock: ${blocked.title}${blocked.blockedBy ? ` (${blocked.blockedBy})` : ''}`, color: 'red', ask: askText(blocked), ...(blocked.session ? { to: blocked.session.id } : {}) }
  const last = stages[stages.length - 1]?.id
  const stuck = lanes.filter(l => l.status !== 'done' && l.stage !== last && inStage(l, now) > stuckAfter).sort((a, b) => (a.since ?? 0) - (b.since ?? 0))[0]
  if (stuck) return { text: `Nudge: ${stuck.title} has sat in ${stuck.stage} for ${Math.floor(inStage(stuck, now) / HOUR)}h`, color: 'yellow', ask: askText(stuck), ...(stuck.session ? { to: stuck.session.id } : {}) }
  const moving = lanes.filter(l => l.status === 'moving').length
  const start = lanes.find(l => l.status === 'waiting' && !l.blockedBy)
  if (start && moving < (config.minMoving ?? 3)) return { text: `Start: ${start.title}`, color: 'cyan', ask: askText(start), ...(start.session ? { to: start.session.id } : {}) }
  return { text: lanes.length > 0 ? 'Nothing to do. Flow is healthy.' : 'No lanes yet.', color: 'green' }
}

export type Campaign = { name: string; open: number; merged: number; blocked: number }

/** Progress per campaign: recent merged pull requests against open lanes. */
export function campaigns(data: BandData): Campaign[] {
  const out = new Map<string, Campaign>()
  const get = (name: string): Campaign => {
    const c = out.get(name) ?? { name, open: 0, merged: 0, blocked: 0 }
    out.set(name, c)
    return c
  }
  for (const l of data.lanes.data) {
    if (!l.campaign) continue
    const c = get(l.campaign)
    if (l.status === 'done') c.merged += 1
    else c.open += 1
    if (l.status === 'blocked') c.blocked += 1
  }
  for (const m of data.flow?.merged ?? []) if (m.campaign) get(m.campaign).merged += 1
  return [...out.values()].sort((a, b) => b.open - a.open || a.name.localeCompare(b.name))
}

export type DepRow = { ref: string; title: string; stage: string; depth: number }

/** Lanes that depend on other open lanes, as a tree that starts at the lane everything waits on. */
export function depTree(lanes: readonly Lane[]): DepRow[] {
  const byRef = new Map(lanes.flatMap(l => (l.ref ? [[l.ref, l] as const] : [])))
  const live = (l: Lane): string[] => (l.dependsOn ?? []).filter(r => byRef.has(r))
  const linked = lanes.filter(l => l.ref && (live(l).length > 0 || lanes.some(o => live(o).includes(l.ref ?? ''))))
  const rows: DepRow[] = []
  const seen = new Set<string>()
  const walk = (lane: Lane, depth: number): void => {
    const ref = lane.ref ?? ''
    if (seen.has(ref) || depth > 6) return
    seen.add(ref)
    rows.push({ ref, title: lane.title, stage: lane.stage, depth })
    for (const child of linked.filter(c => live(c).includes(ref))) walk(child, depth + 1)
  }
  for (const root of linked.filter(l => live(l).length === 0)) walk(root, 0)
  return rows
}

const safe = (text: string): string => text.replace(/["\n\r]/g, ' ').slice(0, 48)
const id = (ref: string): string => `n_${ref.replace(/[^\w]/g, '_')}`

/** Mermaid flowchart text: lanes as nodes coloured by stage, dependencies as arrows, campaigns as groups. */
export function mermaid(data: BandData, config: Config): string {
  const stages = config.stages ?? DEFAULT_STAGES
  const lanes = data.lanes.data.filter(l => l.ref)
  const out = ['flowchart LR']
  for (const s of stages) out.push(`  classDef ${id(s.id)} fill:${s.color.startsWith('#') ? s.color : '#888888'},stroke:#333,color:#111`)
  const node = (l: Lane, pad: string): string => `${pad}${id(l.ref ?? '')}["${safe(l.title)}<br/>${l.ref} · ${l.stage}"]:::${id(l.stage)}`
  const groups = new Map<string, Lane[]>()
  for (const l of lanes) groups.set(l.campaign ?? '', [...(groups.get(l.campaign ?? '') ?? []), l])
  for (const [name, members] of groups) {
    if (name) out.push(`  subgraph ${id(`campaign ${name}`)}["${safe(name)}"]`)
    for (const l of members) out.push(node(l, name ? '    ' : '  '))
    if (name) out.push('  end')
  }
  const known = new Set(lanes.map(l => l.ref))
  for (const l of lanes) for (const d of l.dependsOn ?? []) if (known.has(d)) out.push(`  ${id(d)} --> ${id(l.ref ?? '')}`)
  return out.join('\n')
}

/**
 * Messages for things that just changed: a lane turned blocked, a lane got stuck, the queue head moved.
 * `fired` remembers what was already said. A key leaves it when its condition clears, so a lane that flaps speaks again.
 * With no previous data (the first pass after a reload) nothing is said; the keys are only recorded.
 */
export function alerts(prev: BandData | null, next: BandData, config: Config, now: number, fired: Set<string>): string[] {
  const stuckAfter = (config.stuckHours ?? 24) * HOUR
  const last = (config.stages ?? DEFAULT_STAGES).at(-1)?.id
  const active = new Map<string, string>()
  for (const l of next.lanes.data) {
    if (l.status === 'blocked') active.set(`${l.ref ?? l.title}|blocked`, `Blocked: ${l.title}${l.blockedBy ? ` (${l.blockedBy})` : ''}`)
    if (l.status !== 'done' && l.stage !== last && l.since && now - l.since > stuckAfter) {
      active.set(`${l.ref ?? l.title}|stuck`, `Stuck ${Math.floor((now - l.since) / HOUR)}h in ${l.stage}: ${l.title}`)
    }
  }
  const head = next.mergeLine?.data.head
  if (head) active.set(`head|${head}`, `Merge queue head is now #${head}`)
  const out: string[] = []
  for (const [key, text] of active) {
    if (fired.has(key)) continue
    fired.add(key)
    if (prev) out.push(text)
  }
  for (const key of [...fired]) if (!active.has(key)) fired.delete(key)
  return out
}
