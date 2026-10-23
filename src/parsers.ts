// Parsers for text that other tools print. Pure, so tests can feed them recorded output.

import type { CodexTask, MergeLineData, MergeLineEntry } from './types.ts'
import { asRecord, isString, truncate } from './util.ts'

/**
 * The merge-line text contract: one "Head: #N" line, then "PR #N: note" lines.
 * Any program can print it. Returns null when the text holds neither.
 */
export function parseMergeLine(text: string): MergeLineData | null {
  let head: string | null = null
  const entries: MergeLineEntry[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const h = /^Head:\s*#(\d+)/i.exec(line)
    if (h) { head = h[1] ?? null; continue }
    const p = /^PR\s+#(\d+):\s*(.*)$/.exec(line)
    if (p) entries.push({ n: p[1] ?? '', note: p[2] ?? '' })
  }
  return head === null && entries.length === 0 ? null : { head, entries }
}

export type StatusFile = { data: MergeLineData; at: number }

/**
 * A merge-line snapshot file: { generated_at, head, over_cap, prs: [{ number, set, blocker, owner, reason }] }.
 * Returns the data and the time it was written, or the reason it cannot be used.
 */
export function parseStatusFile(text: string): StatusFile | string {
  let doc: unknown
  try { doc = JSON.parse(text) } catch (err) { return `not valid JSON (${err instanceof Error ? err.message : String(err)})` }
  const root = asRecord(doc)
  const at = isString(root?.generated_at) ? Date.parse(root.generated_at) : NaN
  if (!root || Number.isNaN(at)) return 'has no readable generated_at'
  if (!Array.isArray(root.prs)) return 'has no prs list'
  const entries: MergeLineEntry[] = []
  for (const raw of root.prs) {
    const pr = asRecord(raw)
    if (!pr || typeof pr.number !== 'number') continue
    const text = (v: unknown): string => (isString(v) ? v : '')
    // The note reads like the text contract: a queue member's reason, a waiting PR's blocker, a backlog PR's blocker.
    const note = pr.set === 'QUEUE' ? text(pr.reason) : [pr.set === 'WAITING' && text(pr.owner) ? `[${text(pr.owner)}]` : '', text(pr.blocker)].filter(Boolean).join(' ')
    entries.push({ n: String(pr.number), note })
  }
  const head = typeof root.head === 'number' ? String(root.head) : null
  return { data: { head, entries }, at }
}

/** Where a PR sits in the line, in plain words. Never "?". */
export function mergePosition(line: MergeLineData, n: string): string {
  if (line.head === n) return 'head'
  const hit = line.entries.find(entry => entry.n === n)
  if (!hit) return 'not in line'
  const note = hit.note.toLowerCase()
  if (note.startsWith('behind head')) return 'behind head'
  if (note.startsWith('held')) return 'held'
  if (note === 'draft') return 'draft'
  if (note.includes('unresolved')) return 'review threads'
  return truncate(hit.note, 20) || 'in line'
}

/** Blocks of `codex cloud list`: url line, "[STATUS] title", "repo • age", "+x/-y • n files". */
export function parseCodexList(text: string): CodexTask[] {
  const tasks: CodexTask[] = []
  for (const block of text.split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    const id = lines.map(line => /task_[A-Za-z0-9_]+/.exec(line)?.[0]).find(Boolean)
    const head = lines.map(line => /^\[([A-Z_]+)\]\s*(.*)$/.exec(line)).find(Boolean)
    if (!id || !head) continue
    const age = lines.map(line => /(\d+\s*[smhdw]\w*\s+ago|just now)/i.exec(line)?.[1]).find(Boolean) ?? ''
    const diff = lines.map(line => /(\+\d+\/-\d+)/.exec(line)?.[1]).find(Boolean) ?? ''
    tasks.push({ id, status: head[1] ?? '', title: head[2] ?? '', age, diff })
  }
  return tasks
}

/** "2h ago" or "35m ago" to minutes. Null when unreadable. */
export function ageMinutes(age: string): number | null {
  const m = /^(\d+)\s*([smhdw])/i.exec(age.trim())
  if (!m) return /just now/i.test(age) ? 0 : null
  const n = Number(m[1])
  const unit = (m[2] ?? '').toLowerCase()
  return unit === 's' ? 0 : unit === 'm' ? n : unit === 'h' ? n * 60 : unit === 'd' ? n * 1440 : n * 10080
}

/** One line for a lane's Codex Cloud task. READY and not applied for 10 minutes or more is the one to chase. */
export function codexLaneLine(
  task: CodexTask | undefined,
  stage?: string,
): { text: string; color: 'yellow' | 'red' | 'green' | 'gray' } | null {
  if (!task) return null
  const status = task.status.toUpperCase()
  const mins = ageMinutes(task.age) ?? 0
  if (status === 'PENDING' || status === 'RUNNING') return { text: `codex running ${task.age}`, color: 'yellow' }
  if (status === 'ERROR' || status === 'FAILED') return { text: `codex failed ${task.age}`, color: 'red' }
  if (status === 'APPLIED') return { text: stage === 'verify' || stage === 'review' ? `codex applied, ${stage}` : 'codex applied', color: 'green' }
  if (status === 'READY') {
    return mins >= 10
      ? { text: `codex READY, not applied (${task.age})`, color: 'red' }
      : { text: `codex ready ${task.age}`, color: 'green' }
  }
  return { text: `codex ${status.toLowerCase()} ${task.age}`, color: 'gray' }
}

/** "#843 front door" gives "#843". "M2a (PR #853) verified" gives "M2a". */
export function shortName(title: string): string {
  const word = /^[#\w.-]+/.exec(title.trim())?.[0] ?? title.trim()
  return truncate(word, 10)
}

export function refNumber(ref: string | undefined): string | null {
  return ref ? /#(\d+)$/.exec(ref)?.[1] ?? null : null
}

/** Follows "blockedBy" links lane to lane. Stops at a cycle or after 5 hops. */
export function blockerChain(lanes: readonly { ref?: string; blockedBy?: string }[], index: number): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  let at = index
  for (let hop = 0; hop < 5; hop += 1) {
    const n = /#(\d+)/.exec(lanes[at]?.blockedBy ?? '')?.[1]
    if (!n || seen.has(n)) break
    seen.add(n)
    chain.push(n)
    at = lanes.findIndex(lane => refNumber(lane.ref) === n)
    if (at < 0) break
  }
  return chain
}

/** A moving lane unchanged for 2 h turns amber, for 4 h red. Null when fresh or unknown. */
export function idleLabel(updatedAt: string | undefined, now: number): { label: string; color: 'yellow' | 'red' } | null {
  const at = updatedAt ? Date.parse(updatedAt) : NaN
  if (!Number.isFinite(at)) return null
  const hours = (now - at) / 3_600_000
  if (hours < 2) return null
  const minutes = Math.floor((now - at) / 60_000)
  const age = minutes < 60 ? `${minutes}m` : hours < 24 ? `${Math.floor(hours)}h` : `${Math.floor(hours / 24)}d`
  return { label: `idle ${age}`, color: hours >= 4 ? 'red' : 'yellow' }
}

/** Waiting lanes nobody blocks on: the ones to start when too few lanes move. */
export function refillCandidates(lanes: readonly { title: string; status: string; blockedBy?: string }[]): string[] {
  return lanes.filter(lane => lane.status === 'waiting' && !lane.blockedBy).map(lane => shortName(lane.title))
}
