// `band migrate`: bring an old profiles file (or an old config) up to the current config version.

import { loadConfig } from '../config.ts'
import { migrateLegacy } from '../migrate.ts'
import { CONFIG_VERSION } from '../types.ts'
import { asRecord, parseJson } from '../util.ts'
import { has, parseArgs, str } from './args.ts'
import { atomicWrite, backup, bandHome, paths, readText } from './files.ts'

export const MIGRATE_HELP = `Usage: band migrate [--from old-profiles.json] [--merge-line-command "..."] [--band profile=path ...] [--write]

With --from: converts an old profiles file into config.json. Without --write it only shows what it would write.
  --merge-line-command  Program and arguments for the merge line section, using {owner} and {repo}.
  --band profile=path   An old band data file whose lanes become overrides/<profile>.json (repeat for more).
  --write               Write the files (an existing config.json is kept as config.json.bak).
Without --from: checks config.json and upgrades it when it is from an older release. If config.json has no
"configVersion" it is treated as an old profiles file.`

export async function migrate(argv: string[]): Promise<number> {
  const p = parseArgs(argv, { bool: ['write'], value: ['from', 'merge-line-command'], multi: ['band'] })
  if (p.flags.help) { console.log(MIGRATE_HELP); return 0 }
  if (p.error) { console.error(p.error); return 2 }
  const home = bandHome()
  const f = paths(home)
  const from = str(p, 'from')

  let source: string
  if (from) {
    const text = await readText(from)
    if (text === null) { console.error(`Cannot read ${from}. Check the path and run again: band migrate --from <old profiles file>`); return 1 }
    source = text
  } else {
    const text = await readText(f.config)
    if (text === null) { console.log(`There is no config at ${f.config}. Run: band init`); return 1 }
    const parsed = parseJson(text)
    const version = parsed.ok ? asRecord(parsed.value)?.configVersion : undefined
    if (!parsed.ok) { console.error(`${f.config} is not valid JSON (${parsed.reason}). Fix the syntax, or start again with: band init --force`); return 1 }
    if (version === CONFIG_VERSION) { console.log(`config.json is already current (version ${CONFIG_VERSION}). Nothing to do.`); return 0 }
    if (version !== undefined) { console.error(`config.json is version ${String(version)}, which this release does not know. Update coordinator-band.`); return 1 }
    source = text
  }

  const legacyBands: Record<string, string> = {}
  for (const spec of p.multi.band ?? []) {
    const eq = spec.indexOf('=')
    if (eq < 1) { console.error(`--band needs profile=path, for example --band main=old-band.json (you gave "${spec}").`); return 2 }
    const name = spec.slice(0, eq)
    const text = await readText(spec.slice(eq + 1))
    if (text === null) { console.error(`Cannot read ${spec.slice(eq + 1)} for --band ${name}. Check the path.`); return 1 }
    legacyBands[name] = text
  }

  let result
  try {
    const mergeLineCommand = str(p, 'merge-line-command')
    result = migrateLegacy(source, { ...(mergeLineCommand ? { mergeLineCommand } : {}), legacyBands })
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    return 1
  }
  const bad = Object.keys(result.config.profiles).find(n => !/^[A-Za-z0-9][\w.-]*$/.test(n))
  if (bad) { console.error(`The profile name "${bad}" may only use letters, numbers, dots, dashes and underscores. Rename it in the old file and run again.`); return 1 }

  const text = `${JSON.stringify(result.config, null, 2)}\n`
  for (const note of result.notes) console.log(`Note: ${note}`)
  const loaded = loadConfig(text, 'new config')
  for (const prob of loaded.problems) console.log(`Problem: ${prob.path}: ${prob.message}`)

  if (!has(p, 'write')) {
    console.log(`\nDry run. With --write this would write:\n  ${f.config}${Object.keys(result.overrides).map(n => `\n  ${f.override(n)}`).join('')}\n\n${text}`)
    return loaded.config ? 0 : 1
  }
  const kept = await backup(f.config)
  await atomicWrite(f.config, text)
  for (const [name, body] of Object.entries(result.overrides)) await atomicWrite(f.override(name), body)
  console.log(`Wrote ${f.config}${kept ? ' (the previous file is kept as config.json.bak)' : ''}${Object.keys(result.overrides).map(n => `\nWrote ${f.override(n)}`).join('')}`)
  console.log(loaded.config ? 'Next: run "band validate", then "band refresh".' : 'The new config has problems (listed above). Fix them in config.json, then run: band validate')
  return loaded.config ? 0 : 1
}
