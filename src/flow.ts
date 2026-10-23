// Flow numbers: how long work sits in each stage and how many pull requests merge per day. Pure except fetchMerged.

import { DEFAULTS } from './config.ts'
import { campaignOf } from './rules.ts'
import { ghJson } from './sources/github.ts'
import type { Flow, Host, Lane, ProfileConfig } from './types.ts'
import { asRecord, isString } from './util.ts'

const DAY = 86_400_000
const KEEP_DAYS = 14
const KEEP_STAGE_SAMPLES = 50

/** Fold one refresh into the flow log: a lane that changed stage adds how long it stayed in the old one. */
export function updateFlow(prev: Flow | undefined, before: readonly Lane[], after: readonly Lane[], now: number): Flow {
  const flow: Flow = { merged: [...(prev?.merged ?? [])], stageMs: { ...(prev?.stageMs ?? {}) }, ...(prev?.mergedCheckedAt ? { mergedCheckedAt: prev.mergedCheckedAt } : {}) }
  const old = new Map(before.flatMap(l => (l.ref ? [[l.ref, l] as const] : [])))
  for (const lane of after) {
    const was = lane.ref ? old.get(lane.ref) : undefined
    if (was?.since && was.stage !== lane.stage && now > was.since) {
      flow.stageMs[was.stage] = [...(flow.stageMs[was.stage] ?? []), now - was.since].slice(-KEEP_STAGE_SAMPLES)
    }
  }
  flow.merged = flow.merged.filter(m => now - m.at < KEEP_DAYS * DAY)
  return flow
}

/** Merged pull requests, asked for at most once an hour: one `gh pr list` per repository. */
export async function fetchMerged(host: Host, profile: ProfileConfig, flow: Flow, now: number): Promise<Flow> {
  const github = profile.sources.find(s => s.type === 'github')
  if (!github || github.type !== 'github') return flow
  if (flow.mergedCheckedAt && now - flow.mergedCheckedAt < DEFAULTS.mergedTtlMinutes * 60_000) return flow
  const seen = new Set(flow.merged.map(m => m.ref))
  const merged = [...flow.merged]
  for (const repo of github.repos) {
    try {
      const args = ['pr', 'list', '--repo', `${github.owner}/${repo}`, '--state', 'merged', '--limit', '30', '--json', 'number,mergedAt,labels,milestone']
      if (github.label) args.push('--label', github.label)
      if (github.author) args.push('--author', github.author)
      const rows = await ghJson(host, args)
      for (const row of Array.isArray(rows) ? rows : []) {
        const r = asRecord(row)
        const at = isString(r?.mergedAt) ? Date.parse(r.mergedAt) : NaN
        const ref = `${repo}#${String(r?.number)}`
        if (!Number.isNaN(at) && !seen.has(ref) && now - at < KEEP_DAYS * DAY) { const campaign = campaignOf(r ?? {}, github.campaignPrefix ?? 'campaign:'); merged.push({ ref, at, ...(campaign ? { campaign } : {}) }); seen.add(ref) }
      }
    } catch {
      // leave the log as it was; the next hourly try runs again
    }
  }
  return { ...flow, merged, mergedCheckedAt: now }
}

/** Merged per day for the last `days` days, oldest first. */
export function perDay(flow: Flow | undefined, now: number, days = 7): number[] {
  const out = new Array<number>(days).fill(0)
  for (const m of flow?.merged ?? []) {
    const ago = Math.floor((now - m.at) / DAY)
    if (ago >= 0 && ago < days) out[days - 1 - ago] = (out[days - 1 - ago] ?? 0) + 1
  }
  return out
}

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? (s[mid] ?? null) : (((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2)
}

const BARS = '▁▂▃▄▅▆▇█'
export function sparkline(values: readonly number[]): string {
  const max = Math.max(...values, 1)
  return values.map(v => (v === 0 ? '▁' : BARS[Math.min(7, Math.ceil((v / max) * 8) - 1)] ?? '▁')).join('')
}
