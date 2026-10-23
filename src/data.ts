// Checks a data file before the pane trusts it. Pure.

import { DATA_VERSION } from './types.ts'
import type { BandData, Config, ProfileConfig, SectionRecord } from './types.ts'
import { asRecord, parseJson } from './util.ts'

export type DataCheck = { ok: true; data: BandData } | { ok: false; reason: string }

const isSection = (value: unknown): boolean => {
  const rec = asRecord(value)
  return !!rec && 'data' in rec && (rec.fetchedAt === null || typeof rec.fetchedAt === 'number')
}

export function checkData(text: string, file = 'data file'): DataCheck {
  const parsed = parseJson(text)
  if (!parsed.ok) return { ok: false, reason: `${file} is not valid JSON (${parsed.reason}). Run "coordinator refresh" to write it again.` }
  const root = asRecord(parsed.value)
  if (!root) return { ok: false, reason: `${file} must be a JSON object. Run "coordinator refresh" to write it again.` }
  if (root.dataVersion !== DATA_VERSION) {
    return {
      ok: false,
      reason: `${file} is version ${String(root.dataVersion ?? 'none')} but this release reads version ${DATA_VERSION}. Run "coordinator refresh" to rewrite it.`,
    }
  }
  if (!isSection(root.lanes) || !isSection(root.needs) || !Array.isArray(asRecord(root.lanes)?.data) || !Array.isArray(asRecord(root.needs)?.data)) {
    return { ok: false, reason: `${file} is missing its lanes or needs section. Run "coordinator refresh" to write it again.` }
  }
  return { ok: true, data: root as unknown as BandData }
}

const waiting = <T>(data: T): SectionRecord<T> => ({ data, fetchedAt: null, error: 'first fetch in progress' })

/** A data value for a profile before the first fetch. Sections the profile does not use stay null. */
export function emptyData(name: string, profile: ProfileConfig | undefined, now: number): BandData {
  return {
    dataVersion: DATA_VERSION,
    profile: name,
    generatedAt: now,
    lanes: waiting([]),
    needs: waiting([]),
    mergeLine: profile?.mergeLine ? waiting({ head: null, entries: [] }) : null,
    codex: profile?.codexCloud?.enabled ? waiting([]) : null,
    services: profile?.services && profile.services.length > 0 ? waiting([]) : null,
  }
}

export const refreshMs = (config: Config): number => (config.refresh?.intervalMinutes ?? 5) * 60_000
