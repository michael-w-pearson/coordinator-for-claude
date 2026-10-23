// The config that `band init` writes, and the example override file. Pure.

import { CONFIG_VERSION } from './types.ts'
import type { Config } from './types.ts'

export type StarterOptions = { name?: string; owner: string; repos: string[]; label?: string }

export function buildStarterConfig(opts: StarterOptions): Config {
  return {
    configVersion: CONFIG_VERSION,
    profiles: {
      [opts.name || 'main']: {
        match: { always: true },
        sources: [{ type: 'github', owner: opts.owner, repos: opts.repos, label: opts.label || 'band', needsLabel: 'needs-me' }],
      },
    },
  }
}

/** An example for the "file" source. Copy it to overrides/<profile>.json and point a file source at it. */
export const STARTER_OVERRIDE: string = `${JSON.stringify({
  feedVersion: 1,
  lanes: [{
    title: 'Example lane written by hand',
    ref: 'example-app#1',
    stage: 'review',
    status: 'waiting',
    state: 'waiting for a design decision',
    blockedBy: 'needs a decision',
  }],
  needs: [{
    text: 'Example: pick the release date',
    ref: 'example-app#2',
    url: 'https://github.com/example-org/example-app/issues/2',
    options: [
      { label: 'This week', text: 'Ship this week.' },
      { label: 'Next week', text: 'Ship next week.' },
    ],
  }],
}, null, 2)}\n`

/** Owner and repository from a git remote such as https://github.com/o/r.git or git@github.com:o/r.git. */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/\s]+@)github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(url.trim())
  return m && m[1] && m[2] ? { owner: m[1], repo: m[2] } : null
}
