// Where things live in the coordinator home directory, and safe ways to write them.

import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const MIN_NODE = [22, 18] as const

/** COORDINATOR_HOME, else ~/.claude-coordinator. A folder made before the rename (~/.coordinator-band) is used when it is the only one. */
export function bandHome(): string {
  const set = process.env.COORDINATOR_HOME || process.env.COORDINATOR_BAND_HOME
  if (set) return set
  const fresh = join(homedir(), '.claude-coordinator')
  const legacy = join(homedir(), '.coordinator-band')
  return !existsSync(fresh) && existsSync(legacy) ? legacy : fresh
}

export const paths = (home: string) => ({
  config: join(home, 'config.json'),
  override: (name: string) => join(home, 'overrides', `${name}.json`),
  data: (name: string) => join(home, 'data', `${name}.json`),
  dataDir: join(home, 'data'),
  log: join(home, 'logs', 'refresh.log'),
  lock: join(home, 'refresh.lock'),
})

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/** Write to a .tmp file and rename it over the target, creating folders. Windows can refuse a rename for a moment, so retry. */
export async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, text, 'utf8')
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, path)
      return
    } catch (err) {
      if (attempt >= 4) { await unlink(tmp).catch(() => {}); throw err }
      await sleep(60)
    }
  }
}

export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null
    throw err
  }
}

export const exists = async (path: string): Promise<boolean> => stat(path).then(() => true, () => false)

/** Keep the old file as <name>.bak before it is replaced. Returns true when a backup was made. */
export async function backup(path: string): Promise<boolean> {
  if (!(await exists(path))) return false
  await copyFile(path, `${path}.bak`)
  return true
}

export const STALE_LOCK_MS = 20 * 60_000

/** Take the lock file with an exclusive create. Returns a release function, or the age in ms of the process that holds it. */
export async function acquireLock(path: string, now = Date.now()): Promise<(() => Promise<void>) | { heldForMs: number }> {
  await mkdir(dirname(path), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx')
      await handle.writeFile(`${process.pid} ${new Date(now).toISOString()}\n`)
      await handle.close()
      return async () => { await unlink(path).catch(() => {}) }
    } catch (err) {
      if ((err as { code?: string }).code !== 'EEXIST') throw err
      const age = await stat(path).then(s => now - s.mtimeMs, () => 0)
      if (age < STALE_LOCK_MS) return { heldForMs: age }
      await unlink(path).catch(() => {}) // stale: take over
    }
  }
  return { heldForMs: 0 }
}

/** Append one line to the refresh log and keep the last 200. */
export async function appendLog(path: string, line: string): Promise<void> {
  const old = (await readText(path)) ?? ''
  const lines = old.split('\n').filter(Boolean)
  lines.push(line)
  await atomicWrite(path, `${lines.slice(-200).join('\n')}\n`)
}
