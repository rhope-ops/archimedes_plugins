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

// The verdict on a finished turn's first estimate: on target, slower or faster, with a color.
// Symmetric: ✓ when the larger time is at most 1.25× the smaller, in either direction.
// The color comes from the shown (rounded) number, so "2.0×" is always yellow.
export function verdict(predictedMs: number, actualMs: number): { text: string; color: string } {
  const p = Math.max(1000, predictedMs)
  const a = Math.max(1000, actualMs)
  const ratio = Math.max(p, a) / Math.min(p, a)
  if (ratio <= 1.25) return { text: '✓', color: 'success' }
  const times = ratio < 10 ? ratio.toFixed(1) : String(Math.round(ratio))
  return { text: `${times}× ${a > p ? 'slower' : 'faster'}`, color: Number(times) <= 2 ? 'warning' : 'error' }
}

// ---- 0.8.0: one boxy bar in every state, colored by state ----

// The band's state. One color each, the same on every surface:
// learning (no ETA yet), running, over (longer than the estimate, or done off target),
// ok (done on target, or done with no estimate), fail (stopped, refused or an error).
export type BandState = 'learning' | 'running' | 'over' | 'ok' | 'fail'

export const STATE_HEX: Record<BandState, string> = {
  learning: '#7b8db3',
  running: '#3b7ddd',
  over: '#d49a1f',
  ok: '#2ea865',
  fail: '#e05252',
}
export const STATE_NAMED: Record<BandState, string> = {
  learning: 'gray',
  running: 'cyan',
  over: 'yellow',
  ok: 'green',
  fail: 'red',
}

// `est` is the estimate's kind while running; `outcome` the turn's end word; `verdictColor` the
// verdict's color when the turn ended with an answer and had a first estimate.
export function stateOf(
  isRunning: boolean,
  est: 'eta' | 'over' | 'learning',
  outcome: string,
  verdictColor: string | null,
): BandState {
  if (isRunning) return est === 'eta' ? 'running' : est === 'over' ? 'over' : 'learning'
  if (outcome !== 'Done') return 'fail'
  return verdictColor === null || verdictColor === 'success' ? 'ok' : 'over'
}

// The next shown fill: eases toward the target and never goes back inside a turn.
// A gap under half a percent closes at once, so the bar rests on the target.
export function ease(shown: number, target: number | null): number {
  const s = Math.min(1, Math.max(0, Number.isFinite(shown) ? shown : 0))
  if (target === null || !Number.isFinite(target)) return s
  const t = Math.min(1, Math.max(0, target))
  if (t <= s) return s
  const gap = t - s
  return gap < 0.005 ? t : s + gap * 0.2
}

// The cell meter: `n` cells, each on, edge (part filled) or off. While learning, a block of
// `block` cells sweeps along the row; `tick` moves it one cell.
export type Cell = 'on' | 'edge' | 'off'
export function meter(n: number, frac: number | null, tick: number, block = 6): Cell[] {
  const count = Math.max(0, Math.floor(n))
  if (frac === null) {
    const span = count + block
    const at = (((tick % span) + span) % span) - block
    return Array.from({ length: count }, (_, i) => (i >= at && i < at + block ? 'on' : 'off'))
  }
  const filled = Math.min(1, Math.max(0, frac)) * count
  const full = Math.floor(filled)
  return Array.from({ length: count }, (_, i) => (i < full ? 'on' : i === full && filled - full >= 0.25 ? 'edge' : 'off'))
}

// What an agent does, by its type. Fixed colors per role, never reused for a state.
export type Role = 'main' | 'worker' | 'reviewer' | 'explore'
export function roleOf(type: string | undefined): Role {
  if (type === undefined || type === '' || type === 'main') return 'main'
  const t = type.toLowerCase()
  if (t.includes('review')) return 'reviewer'
  if (t === 'explore' || t === 'plan' || t.includes('explor') || t.includes('research')) return 'explore'
  return 'worker'
}
export const ROLE_HEX: Record<Role, string> = {
  main: '#8b6cff',
  worker: '#14a8a2',
  reviewer: '#d9479c',
  explore: '#8a98ae',
}
export const ROLE_NAMED: Record<Role, string> = {
  main: 'blueBright',
  worker: 'cyanBright',
  reviewer: 'magenta',
  explore: 'gray',
}

// A path to show: relative to the session folder when inside it, else the last 3 parts.
export function shortPath(path: string, cwd: string): string {
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  if (cwd !== '' && cwd !== '/' && path.startsWith(root)) return path.slice(root.length)
  const parts = path.split('/').filter(p => p !== '')
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path
}
