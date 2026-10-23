// Join pull requests to the Claude sessions that own them, from the app's local session records. Read-only.
// The record format belongs to the Claude desktop app and is not documented. Anything unreadable is skipped.

import type { Lane } from './types.ts'
import { asRecord, isString, parseJson } from './util.ts'

export type SessionRef = { id: string; title: string; at: number }

/** Map "repo#number" to the newest live session that lists that pull request. */
export function parseSessions(texts: readonly string[]): Map<string, SessionRef> {
  const out = new Map<string, SessionRef>()
  for (const text of texts) {
    const parsed = parseJson(text)
    const rec = parsed.ok ? asRecord(parsed.value) : null
    if (!rec || rec.isArchived === true || !isString(rec.sessionId)) continue
    const at = typeof rec.lastActivityAt === 'number' ? rec.lastActivityAt : 0
    const title = isString(rec.title) ? rec.title : rec.sessionId
    for (const raw of Array.isArray(rec.prs) ? rec.prs : []) {
      const pr = asRecord(raw)
      if (!pr || typeof pr.prNumber !== 'number' || !isString(pr.repo)) continue
      const key = `${pr.repo.split('/').pop()}#${pr.prNumber}`
      const old = out.get(key)
      if (!old || at > old.at) out.set(key, { id: rec.sessionId, title, at })
    }
  }
  return out
}

export function attachSessions(lanes: Lane[], sessions: Map<string, SessionRef>): Lane[] {
  return lanes.map(l => {
    const s = l.ref ? sessions.get(l.ref) : undefined
    return s ? { ...l, session: { id: s.id, title: s.title } } : l
  })
}
