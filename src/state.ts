// One small state set for every section: ok, stale, empty, error. One badge for all of them.

import type { Color, SectionRecord, SectionState } from './types.ts'
import { ageLabel } from './util.ts'

export type Badge = { state: SectionState; text: string; color: Color }

/** `isEmpty` says whether the stored data holds nothing to show. */
export function sectionState(
  rec: SectionRecord<unknown> | null,
  isEmpty: boolean,
  now: number,
  staleAfterMs: number,
): SectionState {
  if (!rec) return 'error'
  if (rec.error) return 'error'
  if (rec.fetchedAt === null) return 'error'
  if (now - rec.fetchedAt > staleAfterMs) return 'stale'
  return isEmpty ? 'empty' : 'ok'
}

/** The words and colour shown on the section header. The same for every section. */
export function badge(rec: SectionRecord<unknown> | null, isEmpty: boolean, now: number, staleAfterMs: number): Badge {
  const state = sectionState(rec, isEmpty, now, staleAfterMs)
  const age = rec?.fetchedAt != null ? ageLabel(rec.fetchedAt, now) : null
  if (state === 'error') {
    const reason = rec?.error ?? 'no data yet'
    return { state, text: age ? `unavailable: ${reason} (last good ${age === 'now' ? 'just now' : `${age} ago`})` : `unavailable: ${reason}`, color: 'red' }
  }
  if (state === 'stale') {
    const hours = rec?.fetchedAt != null ? (now - rec.fetchedAt) / 3_600_000 : 0
    return { state, text: `stale: data ${age ?? 'of unknown age'} old`, color: hours >= 4 ? 'red' : 'yellow' }
  }
  if (state === 'empty') return { state, text: age === 'now' ? 'empty' : `empty · ${age}`, color: 'gray' }
  return { state, text: age === 'now' ? 'ok · now' : `ok · ${age}`, color: 'green' }
}

/** A section record for a fetch that has not run yet. */
export const pending = <T>(data: T): SectionRecord<T> => ({ data, fetchedAt: null, error: 'not fetched yet' })
