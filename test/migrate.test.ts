import { expect, test } from 'claude-code/testing'

import { loadConfig } from '../src/config.ts'
import { migrateLegacy } from '../src/migrate.ts'

const legacy = JSON.stringify({
  profiles: {
    work: {
      title: 'Work', data: 'band.json', owner: 'example-org', repos: ['example-app'], pathLabel: 'band',
      refreshPathState: true, mergeLine: { repo: 'example-app', cwd: '/srv/example-app' }, cacheFile: 'cache.txt', codex: true,
      services: [{ name: 'api', url: 'https://localhost:8443/health', insecure: true }, { name: 'web', url: 'http://localhost:3000' }],
      cwdContains: ['example-app'],
    },
    side: { owner: 'example-org', repos: ['other-app'], sessions: ['abc'] },
  },
})
const band = JSON.stringify({
  updated: 1, running: [{ title: 'x' }],
  path: [{ title: 'Lane one', ref: 'example-app#1', state: 'draft', stage: 'build', status: 'moving', codex: 'task-1', extra: 'dropped' }],
  needs: [{ text: 'Pick one', ref: 'example-app#2', options: [{ label: 'A', text: 'a' }], to: 'abc' }],
})

test('legacy profiles become a valid version 1 config with notes', () => {
  const r = migrateLegacy(legacy, { mergeLineCommand: 'merge-tool status --repo {owner}/{repo}', legacyBands: { work: band } })
  const loaded = loadConfig(JSON.stringify(r.config))
  expect(loaded.problems).toEqual([])
  const work = r.config.profiles.work!
  expect(work.title).toBe('Work')
  expect(work.sources[0]).toMatchObject({ type: 'github', owner: 'example-org', label: 'band', needsLabel: 'needs-me' })
  expect(work.sources[1]).toEqual({ type: 'file', path: 'overrides/work.json', lanes: false })
  expect(work.mergeLine).toEqual({ command: ['merge-tool', 'status', '--repo', 'example-org/example-app'], cwd: '/srv/example-app', repo: 'example-app' })
  expect(work.codexCloud).toEqual({ enabled: true })
  expect(work.services?.map(s => s.name)).toEqual(['api', 'web'])
  expect(work.match).toEqual({ cwdContains: ['example-app'] })
  expect(r.config.profiles.side?.sources[0]).toMatchObject({ author: '@me' })
  expect(r.notes.join('\n')).toContain('self-signed')
  expect(r.notes.join('\n')).toContain('"running"')
  expect(r.notes.join('\n')).toContain('needsLabel')
})

test('old labelled-lane rules are kept as config rules', () => {
  const github = migrateLegacy(legacy).config.profiles.work!.sources[0] as { rules?: unknown[] }
  expect(github.rules).toContainEqual({ when: { failing: true }, stage: 'review', status: 'blocked', blockedBy: '{failing} check(s) failing' })
  expect(github.rules?.length).toBe(6)
})

test('an old band file becomes an override feed; without a merge line command a note says so', () => {
  const r = migrateLegacy(legacy, { legacyBands: { work: band } })
  const feed = JSON.parse(r.overrides.work ?? '{}') as { feedVersion: number; lanes: Record<string, unknown>[]; needs: Record<string, unknown>[] }
  expect(feed.feedVersion).toBe(1)
  expect(feed.lanes[0]).toEqual({ title: 'Lane one', ref: 'example-app#1', state: 'draft', stage: 'build', status: 'moving', codex: 'task-1' })
  expect(feed.needs[0]).toMatchObject({ text: 'Pick one', to: 'abc' })
  expect(r.config.profiles.work?.mergeLine).toBeUndefined()
  expect(r.notes.join('\n')).toContain('--merge-line-command')
  expect(() => migrateLegacy('[]')).toThrow()
})
