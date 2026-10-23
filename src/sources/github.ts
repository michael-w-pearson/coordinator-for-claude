// Reference source: GitHub through the `gh` command-line tool. Read-only.
// Every call is a `gh pr list`, `gh pr view`, `gh issue view` or `gh search`. Nothing here writes to GitHub.

import { DEFAULT_RULES, DEFAULTS } from '../config.ts'
import { applyRules, describeFacts, factsOf } from '../rules.ts'
import { SourceError } from '../types.ts'
import type { GithubSourceConfig, Host, Lane, Need, Requirement, Source, SourceContext } from '../types.ts'
import { asRecord, firstLine, isString, parseJson } from '../util.ts'
import type { Rec } from '../util.ts'

export const GH_FIELDS = 'number,title,url,isDraft,mergeStateStatus,statusCheckRollup,reviewDecision,autoMergeRequest,labels,updatedAt'

export const GH_REQUIREMENT: Requirement = { command: 'gh', install: 'https://cli.github.com (then run: gh auth login)' }

type Raw = Rec & { _repo: string }

/** Run gh and return parsed JSON. Throws SourceError with a reason a person can act on. */
export async function ghJson(host: Host, args: string[]): Promise<unknown> {
  let result
  try {
    result = await host.run(['gh', ...args], { timeoutMs: 60_000 })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (/ENOENT|not found|cannot find|spawn/i.test(reason)) {
      throw new SourceError(`the GitHub command-line tool "gh" is not installed. Install it from ${GH_REQUIREMENT.install}`)
    }
    throw new SourceError(`gh could not run: ${firstLine(reason)}`)
  }
  if (result.exitCode !== 0) {
    const text = result.stderr || result.stdout
    if (/auth login|not logged in|authentication|GH_TOKEN/i.test(text)) {
      throw new SourceError('gh is not signed in. Run: gh auth login')
    }
    if (/Could not resolve to a Repository|404|Not Found/i.test(text)) {
      throw new SourceError(`GitHub says a repository was not found or you cannot see it (${firstLine(text, 80)})`)
    }
    throw new SourceError(`gh failed: ${firstLine(text) || `exit code ${result.exitCode}`}`)
  }
  const parsed = parseJson(result.stdout)
  if (!parsed.ok) throw new SourceError(`gh printed something that is not JSON (${firstLine(parsed.reason, 80)})`)
  return parsed.value
}

export const github: Source<GithubSourceConfig, Raw> = {
  type: 'github',
  requires: () => [GH_REQUIREMENT],

  async fetch(config, ctx) {
    const rows: Raw[] = []
    const limit = String(config.limit ?? DEFAULTS.githubLimit)
    for (const repo of config.repos) {
      const args = ['pr', 'list', '--repo', `${config.owner}/${repo}`, '--state', 'open', '--limit', limit, '--json', GH_FIELDS]
      if (config.label) args.push('--label', config.label)
      if (config.author) args.push('--author', config.author)
      const value = await ghJson(ctx.host, args)
      if (!Array.isArray(value)) throw new SourceError(`gh pr list for ${repo} did not return a list`)
      for (const row of value) {
        const rec = asRecord(row)
        if (rec) rows.push({ ...rec, _repo: repo })
      }
    }
    return rows
  },

  toLane(raw, config): Lane | null {
    if (!isString(raw.title) || typeof raw.number !== 'number') return null
    const facts = factsOf({ ...raw, state: 'OPEN' })
    const placed = applyRules(config.rules ?? DEFAULT_RULES, facts)
    if (!placed) return null
    return {
      title: raw.title,
      ref: `${raw._repo}#${raw.number}`,
      ...(isString(raw.url) ? { url: raw.url } : {}),
      state: describeFacts(raw, facts),
      ...(isString(raw.updatedAt) ? { updatedAt: raw.updatedAt } : {}),
      ...placed,
    }
  },

  async fetchNeeds(config, ctx): Promise<Need[]> {
    const label = config.needsLabel ?? DEFAULTS.needsLabel
    const needs: Need[] = []
    for (const kind of ['issues', 'prs']) {
      const value = await ghJson(ctx.host, [
        'search', kind, '--label', label, '--owner', config.owner, '--state', 'open',
        '--json', 'repository,number,title,url', '--limit', '20',
      ])
      if (!Array.isArray(value)) throw new SourceError(`gh search ${kind} did not return a list`)
      for (const entry of value) {
        const row = asRecord(entry)
        const repository = asRecord(row?.repository)?.nameWithOwner ?? row?.repository
        if (!row || !isString(repository) || !isString(row.title) || !isString(row.url) || typeof row.number !== 'number') continue
        if (config.repos.length > 0 && !config.repos.some(r => repository.toLowerCase() === `${config.owner}/${r}`.toLowerCase())) continue
        needs.push({ id: `${repository.toLowerCase()}#${row.number}`, text: row.title, url: row.url })
      }
    }
    return needs
  },
}

/** State of one ref such as "repo#12": used to close out an override whose PR has merged. */
export async function refState(ctx: SourceContext, owner: string, ref: string): Promise<'open' | 'merged' | 'closed' | null> {
  const m = /^([\w.-]+)#(\d+)$/.exec(ref)
  if (!m) return null
  for (const kind of ['pr', 'issue']) {
    try {
      const value = asRecord(await ghJson(ctx.host, [kind, 'view', m[2] ?? '', '--repo', `${owner}/${m[1]}`, '--json', 'state']))
      const state = String(value?.state ?? '').toUpperCase()
      if (state === 'MERGED') return 'merged'
      if (state === 'CLOSED') return 'closed'
      if (state === 'OPEN') return 'open'
    } catch {
      // try the next kind
    }
  }
  return null
}
