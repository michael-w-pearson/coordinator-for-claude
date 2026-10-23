import type { Host, RunResult } from '../src/types.ts'

import { FIXTURES } from './fixtures.ts'

export const fixture = (name: string): string => {
  const text = FIXTURES[name]
  if (text === undefined) throw new Error('no fixture ' + name)
  return text
}

export const NOW = Date.parse('2026-10-22T18:00:00Z')

type Reply = RunResult | ((argv: readonly string[]) => RunResult | Promise<RunResult>) | Error
export const okRun = (stdout: string): RunResult => ({ exitCode: 0, stdout, stderr: '' })

/** A host whose commands are answered by `replies`. Any command with no reply fails the test. */
export function fakeHost(replies: (argv: readonly string[]) => Reply | undefined, files: Record<string, string> = {}): Host & { calls: string[][] } {
  const calls: string[][] = []
  return {
    calls,
    platform: 'linux',
    home: '/home/test/.coordinator-band',
    now: () => NOW,
    async run(argv) {
      calls.push([...argv])
      const reply = replies(argv)
      if (reply === undefined) throw new Error(`unexpected command: ${argv.join(' ')}`)
      if (reply instanceof Error) throw reply
      return typeof reply === 'function' ? reply(argv) : reply
    },
    async readFile(path) {
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT ${path}`)
      return text
    },
    async http(url) {
      if (url.includes('down')) throw new Error('connect ECONNREFUSED')
      return 200
    },
  }
}
