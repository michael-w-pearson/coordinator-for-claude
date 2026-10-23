// End-to-end tests of the command line against a fake `gh`. Run: node --test test-node/
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const bin = join(root, 'bin', 'band.mjs')
const fx = name => join(root, 'test', 'fixtures', name)

let tmp, home, ghDir, env

before(() => {
  tmp = mkdtempSync(join(tmpdir(), 'band-test-'))
  home = join(tmp, 'home dir') // a space on purpose
  ghDir = join(tmp, 'bin')
  mkdirSync(ghDir)
  writeFileSync(join(ghDir, 'gh.js'), `
const fs = require('node:fs')
const path = require('node:path')
const a = process.argv.slice(2)
const fail = fs.existsSync(path.join(__dirname, 'FAIL'))
const send = f => { process.stdout.write(fs.readFileSync(f, 'utf8')); process.exit(0) }
if (a[0] === '--version') { console.log('gh version 0.0.0 (fake)'); process.exit(0) }
if (a[0] === 'auth') process.exit(0)
if (fail) { process.stderr.write('gh: HTTP 502\\n'); process.exit(1) }
if (a[0] === 'pr' && a[1] === 'list') send(${JSON.stringify(fx('gh-pr-list.json'))})
if (a[0] === 'search') send(a[1] === 'prs' ? ${JSON.stringify(fx('gh-search-prs.json'))} : ${JSON.stringify(fx('gh-search-issues.json'))})
process.stderr.write('fake gh: unexpected ' + a.join(' ') + '\\n')
process.exit(3)
`)
  writeFileSync(join(ghDir, 'gh'), '#!/bin/sh\nexec node "$(dirname "$0")/gh.js" "$@"\n', { mode: 0o755 })
  writeFileSync(join(ghDir, 'gh.cmd'), '@echo off\r\nnode "%~dp0gh.js" %*\r\n')

  env = { ...process.env, COORDINATOR_BAND_HOME: home }
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
  // Drop any real gh from PATH so the fake one is the only one found.
  const rest = (env[key] ?? '').split(delimiter).filter(d => d && !existsSync(join(d, 'gh.exe')) && !existsSync(join(d, 'gh')))
  env[key] = [ghDir, ...rest].join(delimiter)
})

after(() => rmSync(tmp, { recursive: true, force: true }))

const band = (args, extra = {}) =>
  spawnSync(process.execPath, [bin, ...args], { env: { ...env, ...extra }, cwd: tmp, encoding: 'utf8', timeout: 60_000, windowsHide: true })
const out = r => `${r.stdout}${r.stderr}`

test('init --yes writes a valid config and refuses to overwrite', () => {
  const r = band(['init', '--yes', '--owner', 'cli', '--repos', 'cli', '--label', 'band'])
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /Next steps/)
  assert.ok(existsSync(join(home, 'config.json')))
  assert.ok(existsSync(join(home, 'overrides', 'main.example.json')))
  const again = band(['init', '--yes', '--owner', 'cli', '--repos', 'cli'])
  assert.equal(again.status, 1)
  assert.match(out(again), /already exists/)
  assert.match(out(again), /--force/)
})

test('init without values and without a terminal exits 2 and names the flags', () => {
  const r = band(['init', '--yes', '--force'], { COORDINATOR_BAND_HOME: join(tmp, 'other') })
  assert.equal(r.status, 2)
  assert.match(out(r), /--owner/)
  assert.match(out(r), /--repos/)
})

test('validate accepts the starter config and rejects one with no configVersion', () => {
  const ok = band(['validate'])
  assert.equal(ok.status, 0, out(ok))
  assert.match(ok.stdout, /config OK/)
  const old = join(tmp, 'old-config.json')
  writeFileSync(old, JSON.stringify({ profiles: { main: {} } }))
  const bad = band(['validate', '--config', old])
  assert.equal(bad.status, 1)
  assert.match(out(bad), /band migrate/)
})

test('show before any refresh says there is no data', () => {
  const r = band(['show'])
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /no data yet - run: band refresh/)
})

test('refresh then show prints lanes from the recorded gh output', () => {
  const r = band(['refresh'])
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /main: lanes=ok\(8\)/)
  assert.ok(existsSync(join(home, 'data', 'main.json')))
  assert.ok(readFileSync(join(home, 'logs', 'refresh.log'), 'utf8').includes('lanes=ok(8)'))
  assert.ok(!existsSync(join(home, 'refresh.lock')), 'lock is released')
  const s = band(['show', '--width', '100'])
  assert.equal(s.status, 0, out(s))
  assert.match(s.stdout, /L A N E S/)
  assert.match(s.stdout, /Update github\.com\/digitorus/)
  assert.doesNotMatch(s.stdout, /(^|\s)\?(\s|$)/m)
})

test('a failing gh is stored as unavailable and the previous lanes stay', () => {
  writeFileSync(join(ghDir, 'FAIL'), '')
  try {
    const r = band(['refresh'])
    assert.equal(r.status, 0, out(r))
    assert.match(r.stdout, /lanes=error\(/)
    const s = band(['show', '--width', '100'])
    assert.match(s.stdout, /unavailable:/)
    assert.match(s.stdout, /HTTP 502/)
    assert.match(s.stdout, /Update github\.com\/digitorus/)
  } finally {
    rmSync(join(ghDir, 'FAIL'))
  }
})

test('--quiet prints nothing on success; an unknown profile exits 2', () => {
  const q = band(['refresh', '--quiet'])
  assert.equal(q.status, 0)
  assert.equal(q.stdout, '')
  const p = band(['refresh', '--profile', 'nope'])
  assert.equal(p.status, 2)
  assert.match(out(p), /main/)
})

test('doctor reports OK lines and exits 0 with the fake gh', () => {
  const r = band(['doctor'])
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /OK +gh is signed in/)
  assert.match(r.stdout, /OK +config is valid/)
  assert.match(r.stdout, /no health-check URLs/)
})

test('doctor fails when gh is missing and says how to install it', () => {
  const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
  const r = band(['doctor'], { [key]: dirOfNode() })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /FAIL +gh is not installed - install it from https:\/\/cli\.github\.com/)
})

const dirOfNode = () => join(process.execPath, '..')

test('schedule status answers without changing anything', () => {
  const r = band(['schedule', 'status'])
  assert.equal(r.status, 0, out(r))
  assert.match(r.stdout, /Scheduled refresh: (installed|not installed)/)
})

test('migrate on a current config says it is already current; version prints', () => {
  assert.match(band(['migrate']).stdout, /already current/)
  assert.match(band(['version']).stdout, /^coordinator-band \d+\.\d+\.\d+/)
})

test('migrate --from converts an old file (dry run writes nothing)', () => {
  const legacy = join(tmp, 'legacy.json')
  writeFileSync(legacy, JSON.stringify({ profiles: { solo: { owner: 'example-org', repos: ['example-app'], pathLabel: 'band' } } }))
  const fresh = join(tmp, 'migrated-home')
  const dry = band(['migrate', '--from', legacy], { COORDINATOR_BAND_HOME: fresh })
  assert.equal(dry.status, 0, out(dry))
  assert.match(dry.stdout, /Dry run/)
  assert.ok(!existsSync(join(fresh, 'config.json')))
  const wrote = band(['migrate', '--from', legacy, '--write'], { COORDINATOR_BAND_HOME: fresh })
  assert.equal(wrote.status, 0, out(wrote))
  assert.equal(band(['validate'], { COORDINATOR_BAND_HOME: fresh }).status, 0)
})

test('old Node gets a plain message', () => {
  // The guard lives in bin/band.mjs and reads process.versions, so check the text it prints.
  assert.match(readFileSync(bin, 'utf8'), /needs Node 22\.18 or newer \(you have \$\{process\.versions\.node\}\)\. Get it from https:\/\/nodejs\.org/)
})
