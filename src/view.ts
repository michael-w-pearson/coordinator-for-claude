// Turns data plus config into styled lines. Pure. The pane draws the lines with its own elements,
// and `band show` draws the same lines as plain text. So a test of this file tests what the person sees.

import { DEFAULT_STAGES, DEFAULTS } from './config.ts'
import { blockerChain, codexLaneLine, idleLabel, mergePosition, refNumber, refillCandidates } from './parsers.ts'
import { badge } from './state.ts'
import type { Badge } from './state.ts'
import type { BandData, CodexTask, Color, Config, Lane, LaneStatus, Need, SectionRecord, StageDef } from './types.ts'
import { ageLabel, clock, truncate } from './util.ts'

export type Seg = {
  text: string
  color?: Color
  bold?: boolean
  dim?: boolean
  href?: string
  /** Draw as a small filled block (a stage of the pipeline strip) instead of text. */
  block?: boolean
  /** A button. The host decides what pressing it does. */
  action?: { kind: 'choose'; needId: string; option: number } | { kind: 'refresh' }
}
/** One row of a legend: a coloured square, a label on the left, a count and a share on the right. */
export type LegendRow = { color: Color; label: string; value: string; pct: string }
/** A left part and a right part on one row, like "84% used" and "417.6k / 500k". */
export type HeadRow = { left: Seg[]; right: Seg[] }
export type BarPart = { color: Color; n: number }
export type Line = Seg[]
export type SectionView = {
  id: 'needs' | 'lanes' | 'services' | 'mergeline' | 'codex'
  title: string
  color: Color
  /** Short words on the header: "ok · 2m", "stale: data 40m old", "empty", "unavailable". */
  note: string
  noteColor: Color
  /** Headline row under the title. */
  head?: HeadRow
  /** A stacked bar: each part is as wide as its count. */
  bar?: BarPart[]
  legend?: LegendRow[]
  /** The last row: a hint on the left and quiet buttons. */
  footer?: Line
  state: Badge['state']
  lines: Line[]
}
export type View = { title: string; sections: SectionView[] }

const MAX_NEEDS = 8
const seg = (text: string, rest: Omit<Seg, 'text'> = {}): Seg => ({ text, ...rest })
const dim = (text: string): Line => [seg(text, { dim: true })]

export type ViewOptions = { now: number; title: string; repoFilter?: string }

function shortBadge(b: Badge): string {
  return b.state === 'error' ? 'unavailable' : b.text
}

/** The first line of a section that failed: the reason, in full, in red. */
function reasonLines(rec: SectionRecord<unknown> | null, b: Badge): Line[] {
  if (b.state !== 'error') return []
  return [[seg(b.text, { color: 'red' })]]
}

function stageOf(config: Config, id: string): StageDef | undefined {
  return (config.stages ?? DEFAULT_STAGES).find(s => s.id === id)
}

/** Block glyphs for one lane: done blocks, the current block, blocks still to do. */
export function strip(stages: readonly StageDef[], stageId: string, failed: boolean | undefined): Seg[] {
  const at = stages.findIndex(s => s.id === stageId)
  return stages.map((s, i) => {
    const kind = i < at ? 'done' : i === at ? (failed ? 'failed' : at === stages.length - 1 ? 'done' : 'current') : 'todo'
    return seg(kind === 'todo' ? '▱' : '▰', {
      ...(kind === 'failed' ? { color: 'red' as Color } : kind === 'todo' ? {} : { color: s.color }),
      ...(kind === 'todo' ? { dim: true } : {}),
    })
  })
}

function needsSection(rec: SectionRecord<Need[]>, config: Config, o: ViewOptions, stale: number, answered: Record<string, string>): SectionView {
  const b = badge(rec, rec.data.length === 0, o.now, stale)
  const lines: Line[] = [...reasonLines(rec, b)]
  if (rec.data.length === 0 && b.state !== 'error') lines.push([seg('Nothing needs you', { color: 'green' })])
  for (const need of rec.data.slice(0, MAX_NEEDS)) {
    const first = need.firstSeen ?? o.now
    const hours = (o.now - first) / 3_600_000
    const fresh = o.now - first < 5 * 60_000
    const line: Line = [
      seg('● ', { color: 'red' }),
      seg(truncate(need.text, 40), need.url ? { href: need.url } : {}),
      seg(fresh ? ' ▲ NEW' : ` ${ageLabel(first, o.now)}`, { color: hours >= 4 ? 'red' : hours >= 1 ? 'yellow' : 'green', bold: fresh }),
    ]
    lines.push(line)
    if (need.options?.length) {
      lines.push(answered[need.id]
        ? [seg('  '), seg(`✓ sent: ${answered[need.id]}`, { color: 'green' })]
        : [seg('  '), ...need.options.map((opt, i) => seg(`[${opt.label}]`, { action: { kind: 'choose', needId: need.id, option: i } }))])
    }
  }
  if (rec.data.length > MAX_NEEDS) lines.push(dim(`… and ${rec.data.length - MAX_NEEDS} more`))
  return {
    id: 'needs', title: 'needs you', state: b.state, noteColor: b.color,
    color: rec.data.length > 0 ? 'red' : b.state === 'error' ? 'red' : 'green',
    note: [rec.data.length > 0 ? String(rec.data.length) : '', shortBadge(b)].filter(Boolean).join(' · '),
    lines,
  }
}

function lanesSection(rec: SectionRecord<Lane[]>, config: Config, o: ViewOptions, stale: number, codex: CodexTask[]): SectionView {
  const stages = config.stages ?? DEFAULT_STAGES
  const colors = { ...DEFAULTS.statusColors, ...config.statusColors } as Record<LaneStatus, Color>
  const b = badge(rec, rec.data.length === 0, o.now, stale)
  const lanes = rec.data
  const minMoving = config.minMoving ?? DEFAULTS.minMoving
  const moving = lanes.filter(l => l.status === 'moving').length
  const lines: Line[] = [...reasonLines(rec, b)]
  if (lanes.length === 0 && b.state !== 'error') lines.push(dim('No lanes. Label a pull request or edit the profile.'))
  const count = (status: LaneStatus): number => lanes.filter(l => l.status === status).length
  const total = lanes.length
  const counts = stages.map(s => ({ stage: s, n: lanes.filter(l => l.stage === s.id).length }))
  const head: HeadRow | undefined = total === 0 ? undefined : {
    left: [seg(`${moving} of ${total} moving`, { bold: true })],
    right: [
      ...(count('blocked') > 0 ? [seg(`${count('blocked')} blocked`, { color: 'red' }), seg('  ')] : []),
      ...(count('waiting') > 0 ? [seg(`${count('waiting')} waiting`, { color: 'yellow' }), seg('  ')] : []),
      seg(`${count('done')} done`, { dim: true }),
    ],
  }
  const bar: BarPart[] | undefined = total === 0 ? undefined : counts.filter(c => c.n > 0).map(c => ({ color: c.stage.color, n: c.n }))
  const legend: LegendRow[] | undefined = total === 0 ? undefined
    : counts.map(c => ({ color: c.stage.color, label: c.stage.label, value: String(c.n), pct: `${Math.round((c.n / total) * 100)}%` }))
  lanes.forEach((lane, i) => {
    const idle = lane.status === 'moving' ? idleLabel(lane.updatedAt, o.now) : null
    lines.push([
      seg('● ', { color: colors[lane.status] }),
      seg(truncate(lane.title, 34), { ...(lane.url ? { href: lane.url } : {}), ...(lane.status === 'done' ? { dim: true } : {}) }),
      seg(` ${lane.state || lane.status}`, { dim: true }),
      ...(idle ? [seg(` ${idle.label}`, { color: idle.color, bold: true })] : []),
    ])
    const def = stageOf(config, lane.stage)
    if (def) {
      lines.push([
        seg('  '), ...strip(stages, lane.stage, lane.failed),
        seg(` ${lane.failed ? 'failed ' : ''}${def.label}`, { color: lane.failed ? 'red' : def.color }),
        ...(def.description ? [seg(` · ${def.description}`, { dim: true })] : []),
      ])
    } else {
      lines.push([seg(`  unknown stage "${lane.stage}" (see "stages" in config.json)`, { color: 'yellow', dim: true })])
    }
    const task = lane.codex ? codex.find(t => t.id === lane.codex) : undefined
    const cl = codexLaneLine(task, lane.stage)
    if (cl) lines.push([seg(`  ${cl.text}`, { color: cl.color })])
    if (lane.status === 'waiting') {
      const chain = blockerChain(lanes, i)
      if (chain.length > 0) lines.push([seg(`  ← ${chain.map(n => `#${n}`).join(' ← ')}`, { color: 'yellow', dim: true })])
      else if (lane.blockedBy) lines.push([seg(`  ← ${lane.blockedBy}`, { color: 'yellow', dim: true })])
    } else if (lane.status === 'blocked' && lane.blockedBy) {
      lines.push([seg(`  ✕ ${lane.blockedBy}`, { color: 'red', dim: true })])
    }
  })
  const hint: Seg = minMoving > 0 && lanes.length > 0 && moving < minMoving
    ? (() => {
      const next = refillCandidates(lanes)
      return seg(`Below ${minMoving} moving. ${next.length > 0 ? `Start: ${next.slice(0, 3).join(', ')}` : 'No waiting lane to start.'}`, { color: 'red' })
    })()
    : seg(lanes.length > 0 ? 'Flow is healthy' : '', { dim: true })
  const footer: Line = [hint, seg('   '), seg('[Refresh]', { action: { kind: 'refresh' } })]
  return {
    id: 'lanes', title: 'lanes', state: b.state, noteColor: b.color,
    color: b.state === 'error' ? 'red' : minMoving > 0 && moving < minMoving && lanes.length > 0 ? 'red' : 'cyan',
    note: `${moving}${minMoving > 0 ? `/${minMoving}` : ''} moving · ${shortBadge(b)}`,
    ...(head ? { head } : {}),
    ...(bar ? { bar } : {}),
    ...(legend ? { legend } : {}),
    footer,
    lines,
  }
}

function servicesSection(rec: SectionRecord<BandData['services'] extends SectionRecord<infer T> | null ? T : never>, o: ViewOptions, stale: number): SectionView {
  const b = badge(rec, rec.data.length === 0, o.now, stale)
  const lines: Line[] = [...reasonLines(rec, b)]
  if (rec.data.length > 0) {
    lines.push(rec.data.flatMap((s): Seg[] => [
      seg('● ', { color: s.value === 'up' ? 'green' : 'red' }),
      seg(`${s.name}${s.value === 'down' ? ' (down)' : ''}  `, { dim: s.value === 'up' }),
    ]))
    lines.push(dim(`checked ${clock(rec.fetchedAt)}`))
  }
  return { id: 'services', title: 'services', color: 'gray', state: b.state, noteColor: b.color, note: shortBadge(b), lines }
}

function mergeLineSection(rec: SectionRecord<BandData['mergeLine'] extends SectionRecord<infer T> | null ? T : never>, lanes: Lane[], o: ViewOptions, stale: number): SectionView {
  const b = badge(rec, false, o.now, stale)
  const line = rec.data
  const lines: Line[] = [...reasonLines(rec, b)]
  if (rec.fetchedAt !== null) {
    lines.push([seg(`Head #${line.head ?? 'none'} · ${line.entries.length} in line`)])
    for (const lane of lanes) {
      const n = refNumber(lane.ref)
      if (!n || (o.repoFilter && !lane.ref?.startsWith(`${o.repoFilter}#`))) continue
      const where = mergePosition(line, n)
      if (where === 'not in line') continue
      lines.push([seg(`#${n} ${where}`, where === 'head' ? { color: 'cyan' } : { dim: true })])
    }
  }
  return { id: 'mergeline', title: 'merge line', color: 'gray', state: b.state, noteColor: b.color, note: shortBadge(b), lines }
}

function codexSection(rec: SectionRecord<CodexTask[]>, o: ViewOptions, stale: number): SectionView {
  const b = badge(rec, rec.data.length === 0, o.now, stale)
  const lines: Line[] = [...reasonLines(rec, b)]
  if (rec.data.length === 0 && b.state !== 'error') lines.push(dim('No tasks'))
  for (const t of rec.data.slice(0, 5)) {
    const color: Color = t.status === 'PENDING' || t.status === 'RUNNING' ? 'yellow' : t.status === 'READY' ? 'green' : t.status === 'ERROR' ? 'red' : 'gray'
    lines.push([seg(t.status === 'PENDING' ? '◌ ' : '● ', { color }), seg(truncate(t.title, 34), { href: `https://chatgpt.com/codex/tasks/${t.id}` }), seg(` ${t.age}`, { dim: true })])
  }
  return { id: 'codex', title: 'codex cloud', color: 'gray', state: b.state, noteColor: b.color, note: shortBadge(b), lines }
}

export function buildView(data: BandData | null, config: Config, o: ViewOptions, answered: Record<string, string> = {}): View {
  const stale = (config.refresh?.staleAfterMinutes ?? DEFAULTS.staleAfterMinutes) * 60_000
  if (!data) {
    return {
      title: o.title,
      sections: [{ id: 'lanes', title: 'lanes', color: 'red', state: 'error', note: 'unavailable', noteColor: 'red', lines: [[seg('unavailable: nothing fetched yet. Wait a moment or run "band refresh".', { color: 'red' })]] }],
    }
  }
  const sections: SectionView[] = [
    needsSection(data.needs, config, o, stale, answered),
    lanesSection(data.lanes, config, o, stale, data.codex?.data ?? []),
  ]
  if (data.services) sections.push(servicesSection(data.services, o, stale))
  if (data.mergeLine) sections.push(mergeLineSection(data.mergeLine, data.lanes.data, o, stale))
  if (data.codex) sections.push(codexSection(data.codex, o, stale))
  return { title: o.title, sections }
}
