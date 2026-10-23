#!/usr/bin/env node
// Plain JavaScript on purpose: it must run on an old Node long enough to say what is wrong.
const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`coordinator-band needs Node 22.18 or newer (you have ${process.versions.node}). Get it from https://nodejs.org`)
  process.exit(1)
}
await import('../src/cli/main.ts')
