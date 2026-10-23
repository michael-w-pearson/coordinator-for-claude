// Small pure helpers. No I/O.

export type Rec = Record<string, unknown>

export const asRecord = (value: unknown): Rec | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null

export const isString = (value: unknown): value is string => typeof value === 'string'

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`
}

/** "14:05" in local time, or "never" when the time is unknown. */
export function clock(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return 'never'
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** "now", "12m", "3h", "2d". */
export function ageLabel(since: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - since) / 60_000)
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

/** Strip a UTF-8 byte order mark. Windows editors add one. */
export const stripBom = (text: string): string => text.replace(/^﻿/, '')

/** Parse JSON text. Returns the value or a reason. Never throws. */
export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  try {
    return { ok: true, value: JSON.parse(stripBom(text)) as unknown }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** First non-empty line of a process error, for a one-line reason. */
export function firstLine(text: string, max = 160): string {
  const line = text.split(/\r?\n/).map(l => l.trim()).find(Boolean) ?? ''
  return truncate(line, max)
}

/** Join path parts with "/" (works on Windows too). */
export const joinPath = (...parts: string[]): string =>
  parts.join('/').replace(/\\/g, '/').replace(/(?<=.)\/{2,}/g, '/')
