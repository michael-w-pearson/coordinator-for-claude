// A small hand-written argument parser: --flag, --name value, --name=value, and repeated values.

export type Spec = { bool?: string[]; value?: string[]; multi?: string[] }
export type Parsed = { flags: Record<string, string | true>; multi: Record<string, string[]>; rest: string[]; error?: string }

export function parseArgs(argv: readonly string[], spec: Spec): Parsed {
  const out: Parsed = { flags: {}, multi: {}, rest: [] }
  const bool = new Set([...(spec.bool ?? []), 'help'])
  const value = new Set(spec.value ?? [])
  const multi = new Set(spec.multi ?? [])
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '-h') { out.flags.help = true; continue }
    if (!arg.startsWith('--')) { out.rest.push(arg); continue }
    const eq = arg.indexOf('=')
    const name = arg.slice(2, eq === -1 ? undefined : eq)
    if (bool.has(name)) { out.flags[name] = true; continue }
    if (value.has(name) || multi.has(name)) {
      const v = eq === -1 ? argv[++i] : arg.slice(eq + 1)
      if (v === undefined) { out.error = `--${name} needs a value. Example: --${name} something`; return out }
      if (multi.has(name)) (out.multi[name] ??= []).push(v)
      else out.flags[name] = v
      continue
    }
    out.error = `Unknown option --${name}. Run the command with --help to see the options.`
    return out
  }
  return out
}

export const str = (p: Parsed, name: string): string | undefined => {
  const v = p.flags[name]
  return typeof v === 'string' ? v : undefined
}
export const has = (p: Parsed, name: string): boolean => p.flags[name] === true
