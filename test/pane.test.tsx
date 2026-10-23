import { expect, mock, test } from 'claude-code/testing'

import { FIXTURES } from './fixtures.ts'

const HOME = '/home/test'
const BAND = `${HOME}/.coordinator-band`
const CONFIG = JSON.stringify({
  configVersion: 1,
  profiles: { main: { sources: [{ type: 'github', owner: 'cli', repos: ['cli'], label: 'band' }] } },
})

const PANE = {
  plugin: 'coordinator-band',
  component: 'Pane',
  requestId: 'coordinator-band-pane',
  props: { title: 'Coordinator band', isFocused: false, bodyColumns: 70, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

type Hooks = (event: string, handler: (...args: never[]) => unknown) => void

function world(on: Hooks, files: Record<string, string>, calls: string[][] = []): ReturnType<typeof mock.clock> {
  mock.env(on as never, { HOME })
  mock.store(on as never)
  const clock = mock.clock(on as never, { now: Date.now() })
  on('command.register', (() => ({ value: { command: 'band' } })) as never)
  on('ui.open', (() => ({ value: { isPlaced: true } })) as never)
  on('session.id', (() => ({ value: 'session-1' })) as never)
  on('session.cwd', (() => ({ value: '/work/app' })) as never)
  on('session.start', ((_: unknown, e: { cwd: string }) => ({ cwd: e.cwd })) as never)
  // The engine may turn '/home/...' into a drive path on Windows, so match on the tail.
  const key = (path: string): string | undefined => Object.keys(files).find(k => path.split('\\').join('/').endsWith(k))
  on('fs.exists', ((_: unknown, e: { path: string }) => ({ value: key(e.path) !== undefined })) as never)
  on('fs.read', ((_: unknown, e: { path: string }) => { const k = key(e.path); return k ? { value: files[k] } : { deny: `ENOENT ${e.path}` } }) as never)
  on('fs.write', (() => ({ value: undefined })) as never)
  on('process.run', ((_: unknown, e: { argv: string[] }) => {
    calls.push([...e.argv])
    if (e.argv[0] !== 'gh') return { deny: 'unexpected command' }
    if (e.argv[1] === 'pr') return { value: { exitCode: 0, stdout: FIXTURES['gh-pr-list.json'], stderr: '' } }
    return { value: { exitCode: 0, stdout: '[]', stderr: '' } }
  }) as never)
  return clock
}

test('with no config the pane says what to type', async ($, on) => {
  world(on as never, {})
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /not set up/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\/band init <github-owner>\/<repo>/ })).toBeTruthy()
  await ui.unmount()
})

test('with a config the pane draws lanes from recorded GitHub output, on every surface', async ($, on) => {
  world(on as never, { [`${BAND}/config.json`]: CONFIG })
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /L A N E S/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /ok · now/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('a broken config shows its problem in the pane', async ($, on) => {
  world(on as never, { [`${BAND}/config.json`]: '{"profiles":{}}' })
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /band migrate/ })).toBeTruthy()
  await ui.unmount()
})

test('the pane fetches on its own at session start, with no scheduler and no data file', async ($, on) => {
  const calls: string[][] = []
  world(on as never, { [`${BAND}/config.json`]: CONFIG }, calls)
  await $.session.start({ cwd: '/work/app', surface: 'terminal', isInteractive: true })
  expect(calls.filter(c => c[1] === 'pr').length).toBe(1)
  expect(calls.every(c => c[0] === 'gh')).toBe(true)
})
