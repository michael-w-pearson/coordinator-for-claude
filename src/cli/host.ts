// The Host the command line gives the core: child processes, files, the clock and (opt-in) URL checks.

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import type { Host, RunOptions, RunResult } from '../types.ts'

const MAX_OUTPUT = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

type Spawn = { cmd: string; args: string[]; verbatim: boolean }

function once(s: Spawn, cwd: string | undefined, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(s.cmd, s.args, {
        ...(cwd ? { cwd } : {}),
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsVerbatimArguments: s.verbatim,
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }
    const out: string[] = []
    const err: string[] = []
    let size = 0
    const keep = (into: string[]) => (chunk: Buffer) => {
      if (size >= MAX_OUTPUT) return
      size += chunk.length
      into.push(chunk.toString('utf8'))
    }
    child.stdout?.on('data', keep(out))
    child.stderr?.on('data', keep(err))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      if (process.platform === 'win32' && child.pid) {
        // child.kill() would leave the children of a .cmd wrapper running.
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill())
      } else {
        child.kill('SIGKILL')
      }
    }, timeoutMs)
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`))
      else resolve({ exitCode: code ?? 1, stdout: out.join(''), stderr: err.join('') })
    })
  })
}

const quote = (s: string): string => `"${s.replace(/"/g, '""')}"`

export function run(argv: readonly string[], options: RunOptions = {}): Promise<RunResult> {
  const [cmd, ...args] = argv
  if (!cmd) return Promise.reject(new Error('no program to run'))
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  return once({ cmd, args, verbatim: false }, options.cwd, timeoutMs).catch(async (e: unknown) => {
    const code = (e as { code?: string }).code
    if (code !== 'ENOENT') throw e
    if (process.platform === 'win32' && !/\.\w+$/.test(cmd)) {
      // Tools installed as a .cmd shim (npm packages, wrappers) are not found by a plain spawn.
      try {
        const viaCmd = await once({ cmd: 'cmd.exe', args: ['/d', '/s', '/c', `"${[`${cmd}.cmd`, ...args.map(quote)].join(' ')}"`], verbatim: true }, options.cwd, timeoutMs)
        // cmd.exe itself starts fine; a missing shim shows up as this message.
        if (!(viaCmd.exitCode === 1 && /is not recognized|cannot find the (file|path)/i.test(viaCmd.stderr))) return viaCmd
      } catch (e2) {
        if ((e2 as { code?: string }).code !== 'ENOENT') throw e2
      }
    }
    throw new Error(`spawn ${cmd} ENOENT (the program "${cmd}" was not found)`)
  })
}

export function createHost(home: string): Host {
  return {
    run,
    readFile: path => readFile(path, 'utf8'),
    now: () => Date.now(),
    platform: process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux',
    home,
    async recentJson(dir, days) {
      const since = Date.now() - days * 86_400_000
      const out: string[] = []
      const walk = async (d: string, depth: number): Promise<void> => {
        for (const e of await readdir(d, { withFileTypes: true })) {
          const p = join(d, e.name)
          if (e.isDirectory() && depth < 3) await walk(p, depth + 1)
          else if (e.isFile() && e.name.endsWith('.json') && (await stat(p)).mtimeMs >= since) out.push(await readFile(p, 'utf8'))
        }
      }
      await walk(dir, 0)
      return out
    },
    async http(url, ms) {
      const res = await fetch(url, { signal: AbortSignal.timeout(ms) })
      void res.body?.cancel()
      return res.status
    },
  }
}
