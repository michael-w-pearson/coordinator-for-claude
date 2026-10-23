import { expect, test } from 'claude-code/testing'

import { loadConfig } from '../src/config.ts'
import { buildStarterConfig, parseGithubRemote, STARTER_OVERRIDE } from '../src/starter.ts'

test('the starter config passes validation with no problems', () => {
  const config = buildStarterConfig({ owner: 'example-org', repos: ['example-app', 'other-app'] })
  const loaded = loadConfig(JSON.stringify(config))
  expect(loaded.problems).toEqual([])
  expect(loaded.config?.profiles.main?.sources[0]).toMatchObject({ type: 'github', label: 'coordinator', repos: ['example-app', 'other-app'] })
  expect(Object.keys(buildStarterConfig({ name: 'work', owner: 'o', repos: ['r'], label: 'lane' }).profiles)).toEqual(['work'])
})

test('git remotes in https and ssh form give owner and repo', () => {
  const want = { owner: 'example-org', repo: 'example-app' }
  expect(parseGithubRemote('https://github.com/example-org/example-app.git')).toEqual(want)
  expect(parseGithubRemote('https://github.com/example-org/example-app')).toEqual(want)
  expect(parseGithubRemote('git@github.com:example-org/example-app.git\n')).toEqual(want)
  expect(parseGithubRemote('ssh://git@github.com/example-org/example-app.git')).toEqual(want)
  expect(parseGithubRemote('https://gitlab.com/example-org/example-app.git')).toBe(null)
})

test('the example override is a feed with one lane and one need with options', () => {
  const feed = JSON.parse(STARTER_OVERRIDE) as { feedVersion: number; lanes: unknown[]; needs: { options: unknown[] }[] }
  expect(feed.feedVersion).toBe(1)
  expect(feed.lanes.length).toBe(1)
  expect(feed.needs[0]?.options.length).toBe(2)
})
