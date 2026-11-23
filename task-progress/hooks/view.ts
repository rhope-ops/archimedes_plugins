// Pure layout for the band: bar cells, the sweep while learning, and fitting text to terminal cells.

export const SPIN = ['◐', '◓', '◑', '◒'] as const
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'] as const
export const MIN_BAR = 8

// Terminal cells of one code point: 2 for wide East Asian characters and emoji, 0 for joiners, else 1.
function cellOf(cp: number): number {
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x300 && cp <= 0x36f)) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

export function cells(text: string): number {
  let n = 0
  for (const ch of text) n += cellOf(ch.codePointAt(0) ?? 0)
  return n
}

// Cut text to `n` cells with an ellipsis, never through a character.
export function fit(text: string, n: number): string {
  if (n <= 0) return ''
  if (cells(text) <= n) return text
  let out = ''
  let used = 0
  for (const ch of text) {
    const w = cellOf(ch.codePointAt(0) ?? 0)
    if (used + w > n - 1) break
    out += ch
    used += w
  }
  return `${out}…`
}

// Spaces that push `right` to the end of a `width`-cell row after `left`.
export function gap(left: number, right: number, width: number): string {
  return ' '.repeat(Math.max(1, width - left - right))
}

// A bar `width` cells wide, filled to `frac` (0..1) with eighth-cell steps.
export function bar(width: number, frac: number): { fill: string; empty: string } {
  const w = Math.max(0, Math.floor(width))
  const filled = Math.min(1, Math.max(0, frac)) * w
  const full = Math.floor(filled)
  const part = full < w ? Math.floor((filled - full) * 8) : 0
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

export type Row1 = { head: string; pct: string; tail: string; inline: string; barWidth: number }

// Fit row 1 to exactly `width` cells: head, a space, the bar, then pct, tail and inline text.
// What gives way, in order: the percent, the long tail, the inline tool name, then the tail is cut.
export function row1(
  width: number,
  head: string,
  pct: string,
  tail: string,
  shortTail: string,
  inline: string,
): Row1 {
  const w = Math.max(0, Math.floor(width))
  const h = `${head} `
  if (cells(h) >= w) return { head: fit(h, w), pct: '', tail: '', inline: '', barWidth: 0 }
  const room = w - cells(h)
  const tries: [string, string, string][] = [
    [pct, tail, inline],
    ['', tail, inline],
    ['', shortTail, inline],
    ['', shortTail, fit(inline, Math.max(0, room - MIN_BAR - cells(shortTail)))],
  ]
  for (const [p, t, i] of tries) {
    const rest = room - cells(p) - cells(t) - cells(i)
    if (rest >= MIN_BAR) return { head: h, pct: p, tail: t, inline: i, barWidth: rest }
  }
  const t = fit(shortTail, Math.max(0, room - Math.min(MIN_BAR, room)))
  return { head: h, pct: '', tail: t, inline: '', barWidth: room - cells(t) }
}

// Fit row 2 to exactly `width` cells: what runs now at the left, the counts at the right.
export function row2(width: number, current: string, counts: string): { left: string; space: string; right: string } {
  const w = Math.max(0, Math.floor(width))
  const right = fit(counts, Math.max(0, w - 11))
  const left = fit(current, Math.max(0, w - cells(right) - 1))
  const space = ' '.repeat(Math.max(0, w - cells(left) - cells(right)))
  return { left, space, right }
}

// The verdict on a finished turn's first estimate: on target, slower or faster, with a color.
export function verdict(predictedMs: number, actualMs: number): { text: string; color: string } {
  const p = Math.max(1000, predictedMs)
  const a = Math.max(1000, actualMs)
  if (Math.abs(p - a) / a <= 0.25) return { text: '✓', color: 'success' }
  const ratio = a > p ? a / p : p / a
  const times = ratio < 10 ? ratio.toFixed(1) : String(Math.round(ratio))
  return { text: `${times}× ${a > p ? 'slower' : 'faster'}`, color: ratio <= 2 ? 'warning' : 'error' }
}
