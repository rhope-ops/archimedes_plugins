// Pure layout for the band: bar cells, the sweep while learning, fitting text to the width.

export const SPIN = ['◐', '◓', '◑', '◒'] as const
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const

// A bar `width` cells wide, filled to `frac` (0..1) with eighth-cell steps.
export function bar(width: number, frac: number): { fill: string; empty: string } {
  const w = Math.max(0, Math.floor(width))
  const cells = Math.min(1, Math.max(0, frac)) * w
  const full = Math.floor(cells)
  const part = full < w ? Math.floor((cells - full) * 8) : 0
  const tip = EIGHTHS[part] ?? ''
  return { fill: '█'.repeat(full) + tip, empty: '░'.repeat(w - full - (tip ? 1 : 0)) }
}

// A bright segment that moves along the bar while there is no estimate yet.
export function sweep(width: number, tick: number): { before: string; glow: string; after: string } {
  const w = Math.max(0, Math.floor(width))
  const glow = '▒▓█▓▒'.slice(0, Math.min(5, w))
  const span = Math.max(1, w - glow.length + 1)
  const at = ((tick % span) + span) % span
  return { before: '░'.repeat(at), glow, after: '░'.repeat(w - at - glow.length) }
}

// Cut text to `n` columns with an ellipsis.
export function fit(text: string, n: number): string {
  if (n <= 0) return ''
  return text.length <= n ? text : `${text.slice(0, Math.max(0, n - 1))}…`
}

// Spaces that push `right` to the end of a `width`-column row after `left`.
export function gap(left: number, right: number, width: number): string {
  return ' '.repeat(Math.max(1, width - left - right))
}
