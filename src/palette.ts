// A sequential colour ramp in OKLCH: hue steps from violet to green while lightness rises,
// so neighbours differ in hue and in lightness (readable for colour-blind viewers, on light and dark).

const toHex = (L: number, C: number, hDeg: number): string => {
  const h = (hDeg * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
  const enc = (v: number): string => {
    const c = Math.min(1, Math.max(0, v))
    const g = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055
    return Math.round(g * 255).toString(16).padStart(2, '0')
  }
  return `#${lin.map(enc).join('')}`
}

/** n colours from violet (first) to green (last). */
export function ramp(n: number): string[] {
  return Array.from({ length: n }, (_, i) => {
    const t = n === 1 ? 1 : i / (n - 1)
    return toHex(0.62 + 0.2 * t, 0.15, 300 - 160 * t)
  })
}
