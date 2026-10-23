// Turns the old profiles file (and optional old band data files) into a version 1 config plus override files. Pure.

import { isLocalUrl } from './config.ts'
import { CONFIG_VERSION } from './types.ts'
import type { Config, MergeLineConfig, ProfileConfig, Rule, ServiceConfig, SourceConfig } from './types.ts'
import { asRecord, isString, parseJson } from './util.ts'
import type { Rec } from './util.ts'

export type MigrateOptions = {
  /** Program and arguments with {owner} and {repo} placeholders, split on spaces. */
  mergeLineCommand?: string
  /** Profile name -> text of that profile's old band data file. */
  legacyBands?: Record<string, string>
}
export type Migrated = {
  config: Config
  /** Profile name -> text for overrides/<name>.json. */
  overrides: Record<string, string>
  notes: string[]
}

/** The labelled-lane behaviour of the old refresher, as rules. */
const LEGACY_RULES: Rule[] = [
  { when: { draft: true }, stage: 'build', status: 'moving' },
  { when: { autoMerge: true }, stage: 'merge-line', status: 'moving' },
  { when: { failing: true }, stage: 'review', status: 'blocked', blockedBy: '{failing} check(s) failing' },
  { when: { changesRequested: true }, stage: 'review', status: 'blocked', blockedBy: 'changes requested' },
  { when: { pending: true }, stage: 'review', status: 'moving' },
  { when: {}, stage: 'merge-line', status: 'waiting', blockedBy: 'merge line arms the head' },
]

const recs = (v: unknown): Rec[] => { const r = asRecord(v); return r ? [r] : [] }
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isString) : [])
const pick = (raw: Rec, keys: string[]): Rec =>
  Object.fromEntries(keys.filter(k => raw[k] !== undefined && raw[k] !== null).map(k => [k, raw[k]]))

function bandToFeed(text: string, name: string, notes: string[]): string | null {
  const parsed = parseJson(text)
  const root = parsed.ok ? asRecord(parsed.value) : null
  if (!root) { notes.push(`The old band file for "${name}" is not a JSON object, so its lanes were not brought across.`); return null }
  const lanes = (Array.isArray(root.path) ? root.path : []).flatMap(recs)
    .map(l => pick(l, ['title', 'ref', 'state', 'stage', 'status', 'blockedBy', 'failed', 'codex']))
  const needs = (Array.isArray(root.needs) ? root.needs : []).flatMap(recs)
    .map(n => pick(n, ['text', 'ref', 'url', 'options', 'to']))
  if (Array.isArray(root.running) && root.running.length > 0) {
    notes.push(`The "running" list in the old band file for "${name}" was dropped. This release does not show it.`)
  }
  return `${JSON.stringify({ feedVersion: 1, lanes, needs }, null, 2)}\n`
}

export function migrateLegacy(legacyProfilesJson: string, opts: MigrateOptions = {}): Migrated {
  const notes: string[] = []
  const parsed = parseJson(legacyProfilesJson)
  const root = parsed.ok ? asRecord(parsed.value) : null
  const legacy = asRecord(root?.profiles)
  if (!legacy) throw new Error('The old profiles file must be a JSON object with a "profiles" entry. Check that you passed the right file to --from.')

  const profiles: Record<string, ProfileConfig> = {}
  const overrides: Record<string, string> = {}
  const bands = opts.legacyBands ?? {}
  const oneProfile = Object.keys(legacy).length === 1
  let labelNote = false
  let unused = false

  for (const [name, value] of Object.entries(legacy)) {
    const p = asRecord(value) ?? {}
    const owner = isString(p.owner) ? p.owner : ''
    if (!owner) notes.push(`Profile "${name}" has no owner. Set "owner" in its github source before you run "band validate".`)
    const github: SourceConfig = {
      type: 'github',
      owner,
      repos: strings(p.repos),
      ...(isString(p.pathLabel) && p.pathLabel ? { label: p.pathLabel } : { author: '@me' }),
      needsLabel: 'needs-me',
      rules: LEGACY_RULES,
    }
    labelNote = true
    if (!isString(p.pathLabel) || !p.pathLabel) notes.push(`Profile "${name}" had no lane label, so it now lists your own open pull requests ("author": "@me"). Set "label" in its github source to use a label instead.`)
    const sources: SourceConfig[] = [github]

    const band = bands[name]
    if (band !== undefined) {
      const feed = bandToFeed(band, name, notes)
      if (feed !== null) {
        overrides[name] = feed
        // A labelled profile took its lanes from GitHub alone: the old refresher replaced the hand-written ones.
        const labelled = isString(p.pathLabel) && p.pathLabel !== ''
        sources.push({ type: 'file', path: `overrides/${name}.json`, ...(labelled ? { lanes: false } : {}) })
        if (labelled) notes.push(`Profile "${name}" has a lane label, so lanes come from GitHub only. The old band file is read for needs only ("lanes": false).`)
      }
    } else if (p.data !== undefined) {
      notes.push(`Profile "${name}" had a hand-written band file. To bring its lanes across, run again with --band ${name}=<path to that file>.`)
    }

    const profile: ProfileConfig = { sources }
    if (isString(p.title)) profile.title = p.title
    const sessions = strings(p.sessions)
    const cwdContains = strings(p.cwdContains)
    if (sessions.length > 0 || cwdContains.length > 0) {
      profile.match = { ...(sessions.length > 0 ? { sessions } : {}), ...(cwdContains.length > 0 ? { cwdContains } : {}) }
    } else if (!oneProfile) {
      notes.push(`Profile "${name}" has no session or folder match, so it is never picked on its own. Add "match" to it, for example {"always": true}.`)
    }

    const ml = asRecord(p.mergeLine)
    if (ml) {
      if (opts.mergeLineCommand) {
        const argv = opts.mergeLineCommand.replace(/\{owner\}/g, owner).replace(/\{repo\}/g, isString(ml.repo) ? ml.repo : '').split(/\s+/).filter(Boolean)
        const mergeLine: MergeLineConfig = { command: argv, ...(isString(ml.cwd) ? { cwd: ml.cwd } : {}), ...(isString(ml.repo) ? { repo: ml.repo } : {}) }
        profile.mergeLine = mergeLine
      } else {
        notes.push(`Profile "${name}" had a merge line section. Run again with --merge-line-command "<program and arguments, using {owner} and {repo}>" to keep it.`)
      }
    }
    if (p.codex === true) profile.codexCloud = { enabled: true }

    if (Array.isArray(p.services)) {
      const services: ServiceConfig[] = []
      for (const raw of p.services) {
        const s = asRecord(raw)
        if (!s || !isString(s.name) || !isString(s.url)) continue
        const remote = /^https?:\/\//.test(s.url) && !isLocalUrl(s.url)
        services.push({ name: s.name, url: s.url, ...(remote ? { allowRemote: true } : {}) })
        if (s.insecure === true) notes.push(`Service "${s.name}" had "insecure": true. That option is gone: an https address with a self-signed certificate will show as down.`)
        if (remote) notes.push(`Service "${s.name}" is not on this machine or a private network. "allowRemote": true was added so it is still checked. Remove it to stop checking it.`)
      }
      if (services.length > 0) profile.services = services
    }
    if (p.refreshPathState !== undefined || p.cacheFile !== undefined) unused = true
    profiles[name] = profile
  }

  for (const name of Object.keys(bands)) {
    if (!legacy[name]) notes.push(`--band ${name}=... names a profile that is not in the old file, so it was ignored.`)
  }
  if (labelNote) notes.push('Every profile now lists issues and pull requests labelled "needs-me" under NEEDS YOU. If you used another label, set "needsLabel" in its github source.')
  if (unused) notes.push('The old "refreshPathState" and "cacheFile" settings are gone. This release needs neither.')
  return { config: { configVersion: CONFIG_VERSION, profiles }, overrides, notes }
}
