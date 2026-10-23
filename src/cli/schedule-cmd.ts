// `coordinator schedule install|uninstall|status`: runs the files and commands that src/schedule.ts builds.

import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildSchedule, clampInterval } from '../schedule.ts'
import type { Schedule } from '../schedule.ts'
import { parseArgs, str } from './args.ts'
import { atomicWrite, bandHome } from './files.ts'
import { run } from './host.ts'

export const SCHEDULE_HELP = `Usage: coordinator schedule install|uninstall|status [--interval minutes]

Runs "coordinator refresh" on a timer, even when Claude Code is closed.
  install     Add the job to your computer (Task Scheduler, launchd, systemd or cron).
  uninstall   Remove it again.
  status      Say whether it is installed.
  --interval  Minutes between runs, 1 to 59. Default 5.

Nothing needs this: with it off, the coordinator refreshes itself while Claude Code is open.`

export const scriptPath = (): string => fileURLToPath(new URL('../../bin/coordinator.mjs', import.meta.url))

export async function scheduleFor(intervalMinutes: number): Promise<Schedule> {
  const platform = process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'
  let hasSystemd = false
  if (platform === 'linux') {
    hasSystemd = await run(['systemctl', '--user', '--version'], { timeoutMs: 10_000 }).then(r => r.exitCode === 0, () => false)
  }
  return buildSchedule(platform, {
    nodePath: process.execPath,
    scriptPath: scriptPath(),
    home: bandHome(),
    intervalMinutes,
    userHome: homedir(),
    ...(process.getuid ? { uid: process.getuid() } : {}),
    hasSystemd,
  })
}

/** True when the job exists. */
export async function isScheduled(): Promise<boolean> {
  const s = await scheduleFor(5)
  const r = await run(s.status, { timeoutMs: 15_000 }).catch(() => null)
  return r !== null && r.exitCode === 0
}

export async function scheduleCommand(argv: string[]): Promise<number> {
  const p = parseArgs(argv, { value: ['interval'] })
  const action = p.rest[0]
  if (p.flags.help || !action) { console.log(SCHEDULE_HELP); return p.flags.help ? 0 : 2 }
  if (p.error) { console.error(p.error); return 2 }
  if (!['install', 'uninstall', 'status'].includes(action)) {
    console.error(`Unknown action "${action}". Use: coordinator schedule install, coordinator schedule uninstall or coordinator schedule status.`)
    return 2
  }
  const interval = str(p, 'interval')
  if (interval !== undefined && !/^\d+$/.test(interval)) {
    console.error(`--interval must be a whole number of minutes from 1 to 59 (you gave "${interval}").`)
    return 2
  }
  const s = await scheduleFor(clampInterval(interval === undefined ? 5 : Number(interval)))

  if (action === 'status') {
    const r = await run(s.status, { timeoutMs: 15_000 }).catch(() => null)
    console.log(r !== null && r.exitCode === 0
      ? `Scheduled refresh: installed (${s.name}). Remove it with: coordinator schedule uninstall`
      : 'Scheduled refresh: not installed. Add it with: coordinator schedule install')
    return 0
  }

  if (action === 'install') {
    for (const f of s.files) await atomicWrite(f.path, f.content)
    await mkdir(join(bandHome(), 'logs'), { recursive: true })
    for (const argv2 of s.install) {
      const best = argv2.includes('bootout') // an older copy may not exist
      const r = await run(argv2, { timeoutMs: 30_000 }).catch((e: unknown) => ({ exitCode: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) }))
      if (r.exitCode !== 0 && !best) {
        console.error(`Could not install the scheduled job. "${argv2.slice(0, 2).join(' ')}" said: ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? 'nothing'}`)
        console.error('Nothing else was changed. Fix the problem above and run: coordinator schedule install. To clean up, run: coordinator schedule uninstall')
        return 1
      }
    }
    console.log(s.summary)
    return 0
  }

  for (const argv2 of s.uninstall) await run(argv2, { timeoutMs: 30_000 }).catch(() => null)
  for (const f of s.files) await rm(f.path, { force: true })
  console.log(`Removed the scheduled job "${s.name}" if it existed. Your config and data were not touched.`)
  return 0
}
