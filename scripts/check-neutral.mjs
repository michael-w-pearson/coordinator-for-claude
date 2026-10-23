// Fails when the repo names a person, a machine or a private service.
// It always checks generic patterns (home directories, private network addresses, session ids, Python).
// To also check names that belong to you, put one case-insensitive word per line in a file OUTSIDE the repo
// and run:  NEUTRAL_DENYLIST=/path/to/words.txt node scripts/check-neutral.mjs
// Recorded GitHub output in test/fixtures is public data from a public repository and is skipped.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const root = new URL('../', import.meta.url)
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(f => f && !f.startsWith('test/fixtures/') && f !== 'test/fixtures.ts' && f !== 'scripts/check-neutral.mjs' && !/\.(png|jpg|gif)$/.test(f))

const GENERIC = [
  [/[A-Za-z]:[\\/]+Users[\\/]+(?!test\b|example|you\b|name\b|u\b|Some|<)[\w ]+/i, 'a Windows home directory'],
  [/\/Users\/(?!test\b|example|you\b|name\b|u\b|Some|<)[\w ]+/, 'a macOS home directory'],
  [/\/home\/(?!test\b|example|you\b|name\b|u\b|Some|<)[\w ]+/, 'a Linux home directory'],
  [/\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/, 'a Tailscale address'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, 'a session or object id'],
  [/\bpythonw?\b|\.py\b/i, 'Python'],
]
const own = process.env.NEUTRAL_DENYLIST
  ? readFileSync(process.env.NEUTRAL_DENYLIST, 'utf8').split('\n').map(s => s.trim()).filter(Boolean)
  : []
const patterns = [...GENERIC, ...own.map(w => [new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), `the private word from your list`])]

let bad = 0
for (const file of files) {
  let text
  try { text = readFileSync(new URL(file, root), 'utf8') } catch { continue }
  text.split('\n').forEach((line, i) => {
    for (const [re, what] of patterns) {
      if (re.test(line)) { console.error(`${file}:${i + 1}: ${what}`); bad += 1 }
    }
  })
}
if (bad) { console.error(`${bad} problem(s). Replace each with a neutral example.`); process.exit(1) }
console.log(`neutral: ${files.length} files checked${own.length ? ` (+${own.length} private words)` : ''}`)
