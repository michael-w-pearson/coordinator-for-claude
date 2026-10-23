// The source registry. To add a source: write a file here that exports a `Source`, then add one line below.

import type { Source } from '../types.ts'
import { command, file } from './feed.ts'
import { github } from './github.ts'

// The registry is typed loosely on purpose: each source reads its own config type.
export const SOURCES: Record<string, Source<never, never>> = {
  github: github as unknown as Source<never, never>,
  file: file as unknown as Source<never, never>,
  command: command as unknown as Source<never, never>,
}
