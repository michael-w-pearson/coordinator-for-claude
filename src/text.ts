// Plain-text drawing of a View, for `coordinator show`, the README capture and tests.

import type { BarPart, Line, View } from './view.ts'

const spaced = (title: string): string => title.toUpperCase().split('').join(' ').replace(/ {3,}/g, '   ')
const plain = (line: Line): string => line.map(s => s.text).join('')

/** Whole blocks per part. The parts always add up to `width`: the largest remainders get the spare blocks. */
export function barWidths(parts: readonly BarPart[], width: number): number[] {
  const total = parts.reduce((sum, p) => sum + p.n, 0)
  if (total === 0) return parts.map(() => 0)
  const exact = parts.map(p => (p.n / total) * width)
  const widths = exact.map(Math.floor)
  let spare = width - widths.reduce((a, b) => a + b, 0)
  const order = exact.map((x, i) => ({ i, r: x - Math.floor(x) })).sort((a, b) => b.r - a.r)
  for (const { i } of order) { if (spare <= 0) break; widths[i] = (widths[i] ?? 0) + 1; spare -= 1 }
  // A part that has lanes always shows at least one block.
  return widths.map((w, i) => (w === 0 && (parts[i]?.n ?? 0) > 0 ? 1 : w))
}

const row = (left: string, right: string, inner: number): string => `${left}${' '.repeat(Math.max(1, inner - left.length - right.length))}${right}`

export function renderText(view: View, width = 64): string {
  const out: string[] = []
  const inner = width - 4
  for (const section of view.sections) {
    const head = `${spaced(section.title)}   ${section.note}`
    out.push(`┌─ ${head} ${'─'.repeat(Math.max(1, width - head.length - 5))}┐`)
    if (section.head) out.push(`│ ${row(plain(section.head.left), plain(section.head.right), inner)}`)
    if (section.bar) out.push(`│ ${barWidths(section.bar, inner).map(w => '█'.repeat(w)).join('')}`)
    for (const l of section.legend ?? []) out.push(`│ ${row(`■ ${l.label}`, `${l.value.padStart(4)}  ${l.pct.padStart(4)}`, inner)}`)
    if (section.legend || section.bar || section.head) out.push('│')
    for (const line of section.lines) out.push(`│ ${plain(line)}`)
    if (section.footer && plain(section.footer).trim()) out.push(`│ ${plain(section.footer)}`)
    out.push(`└${'─'.repeat(width - 2)}┘`)
  }
  return out.join('\n')
}
