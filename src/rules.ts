// Turns facts about a pull request into a stage and status. Pure.

import type { Lane, Rule, RuleWhen } from './types.ts'
import { asRecord, isString } from './util.ts'
import type { Rec } from './util.ts'

export type Facts = {
  draft: boolean
  failing: number
  pending: number
  changesRequested: boolean
  approved: boolean
  autoMerge: boolean
  merged: boolean
  closed: boolean
  /** Plan, not code: only plan files changed, or the title says plan. */
  plan: boolean
  labels: string[]
}

export type PlanOptions = { planPaths: readonly string[]; planTitle: RegExp }

const FAILED = new Set(['FAILURE', 'FAILED', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const RUNNING = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING', 'REQUESTED', 'EXPECTED'])

/** Facts from one `gh pr list/view --json` row. Handles CheckRun rows and StatusContext rows. */
export function factsOf(row: Rec, plan?: PlanOptions): Facts {
  const checks = Array.isArray(row.statusCheckRollup) ? row.statusCheckRollup : []
  let failing = 0
  let pending = 0
  for (const raw of checks) {
    const check = asRecord(raw)
    if (!check) continue
    const result = String(check.conclusion ?? '').toUpperCase() || String(check.state ?? '').toUpperCase()
    const status = String(check.status ?? '').toUpperCase() || String(check.state ?? '').toUpperCase()
    if (FAILED.has(result)) failing += 1
    else if (!result && RUNNING.has(status)) pending += 1
    else if (RUNNING.has(result)) pending += 1
  }
  const state = isString(row.state) ? row.state.toUpperCase() : 'OPEN'
  const labels = Array.isArray(row.labels)
    ? row.labels.flatMap(l => (isString(l) ? [l] : isString(asRecord(l)?.name) ? [String(asRecord(l)?.name)] : []))
    : []
  const paths = Array.isArray(row.files) ? row.files.flatMap(f => (isString(asRecord(f)?.path) ? [String(asRecord(f)?.path)] : [])) : []
  const onlyPlanFiles = !!plan && paths.length > 0 && paths.every(p => plan.planPaths.some(dir => p.startsWith(dir)))
  const planTitle = !!plan && isString(row.title) && plan.planTitle.test(row.title)
  return {
    draft: row.isDraft === true,
    failing,
    pending,
    changesRequested: row.reviewDecision === 'CHANGES_REQUESTED',
    approved: row.reviewDecision === 'APPROVED',
    autoMerge: row.autoMergeRequest !== null && row.autoMergeRequest !== undefined,
    merged: state === 'MERGED',
    closed: state === 'CLOSED',
    plan: onlyPlanFiles || planTitle,
    labels,
  }
}

function holds(when: RuleWhen, facts: Facts): boolean {
  if (when.draft !== undefined && when.draft !== facts.draft) return false
  if (when.failing !== undefined && when.failing !== facts.failing > 0) return false
  if (when.pending !== undefined && when.pending !== facts.pending > 0) return false
  if (when.changesRequested !== undefined && when.changesRequested !== facts.changesRequested) return false
  if (when.approved !== undefined && when.approved !== facts.approved) return false
  if (when.autoMerge !== undefined && when.autoMerge !== facts.autoMerge) return false
  if (when.merged !== undefined && when.merged !== facts.merged) return false
  if (when.closed !== undefined && when.closed !== facts.closed) return false
  if (when.plan !== undefined && when.plan !== facts.plan) return false
  if (when.label !== undefined && !facts.labels.includes(when.label)) return false
  return true
}

/** The first rule that holds sets stage, status and the reason. A text like "{failing} check(s) failing" is filled in. */
export function applyRules(rules: readonly Rule[], facts: Facts): Pick<Lane, 'stage' | 'status' | 'blockedBy' | 'failed'> | null {
  const rule = rules.find(r => holds(r.when, facts))
  if (!rule) return null
  const blockedBy = rule.blockedBy?.replace('{failing}', String(facts.failing)).replace('{pending}', String(facts.pending))
  return {
    stage: rule.stage,
    status: rule.status,
    ...(blockedBy ? { blockedBy } : {}),
    ...(rule.failed ? { failed: true } : {}),
  }
}

/** "draft, blocked, 2 failing": a short line shown beside the lane title. */
export function describeFacts(row: Rec, facts: Facts): string {
  if (facts.merged) return 'merged'
  if (facts.closed) return 'closed'
  const parts = [facts.draft ? 'draft' : 'ready']
  if (isString(row.mergeStateStatus) && row.mergeStateStatus) parts.push(row.mergeStateStatus.toLowerCase())
  if (facts.failing > 0) parts.push(`${facts.failing} failing`)
  else if (facts.pending > 0) parts.push(`${facts.pending} running`)
  return parts.join(', ')
}
