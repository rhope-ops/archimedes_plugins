// Pure diff for the pane: line diff (LCS) with up to 2 lines of context, word marks on changed lines.

import type { DiffLine } from '../types'

// Above this many line pairs the LCS table is too big: every old line is removed, every new one added.
const MAX_CELLS = 40_000
const CONTEXT = 2
// The most lines kept per hunk; the rest is counted in `cut`.
export const MAX_LINES = 40

export type Diff = { lines: DiffLine[]; add: number; del: number; cut: number }

function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  // A final newline ends the last line; it is not one more empty line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

type Op = { kind: ' ' | '+' | '-'; text: string; oldN: number; newN: number }

// The longest line kept in a diff, in characters (a minified file has one huge line).
const MAX_TEXT = 400
const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s)

// Common leading and trailing lines are kept as they are; only the middle goes through the LCS,
// so a one-line change in a long file stays a one-line change.
function ops(a: string[], b: string[]): Op[] {
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const head: Op[] = a.slice(0, pre).map((text, i) => ({ kind: ' ', text, oldN: i, newN: i }))
  const tail: Op[] = a.slice(a.length - suf).map((text, i) => ({ kind: ' ', text, oldN: a.length - suf + i, newN: b.length - suf + i }))
  const mid = middle(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf)).map(o => ({
    ...o,
    oldN: o.oldN < 0 ? o.oldN : o.oldN + pre,
    newN: o.newN < 0 ? o.newN : o.newN + pre,
  }))
  return [...head, ...mid, ...tail]
}

function middle(a: string[], b: string[]): Op[] {
  const m = a.length
  const n = b.length
  if (m * n > MAX_CELLS) {
    return [
      ...a.map((text, i) => ({ kind: '-' as const, text, oldN: i, newN: -1 })),
      ...b.map((text, j) => ({ kind: '+' as const, text, oldN: -1, newN: j })),
    ]
  }
  // len[i][j]: LCS length of a[i..] and b[j..].
  const len: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--) {
    const row = len[i] as number[]
    const below = len[i + 1] as number[]
    for (let j = n - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: Op[] = []
  let i = 0
  let j = 0
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      out.push({ kind: ' ', text: a[i] as string, oldN: i, newN: j })
      i++
      j++
    } else if (i < m && (j >= n || (len[i + 1]?.[j] ?? 0) >= (len[i]?.[j + 1] ?? 0))) {
      // Removed lines go before added ones, as in a unified diff.
      out.push({ kind: '-', text: a[i] as string, oldN: i, newN: -1 })
      i++
    } else {
      out.push({ kind: '+', text: b[j] as string, oldN: -1, newN: j })
      j++
    }
  }
  return out
}

// Words and the runs between them, so a mark never cuts a word.
function tokens(s: string): string[] {
  return s.match(/\w+|\s+|[^\w\s]/g) ?? []
}

// The changed middle of `a` against `b`: [start, end) in characters, or null when the lines are equal.
export function markOf(a: string, b: string): [number, number] | null {
  if (a === b) return null
  const ta = tokens(a)
  const tb = tokens(b)
  let pre = 0
  while (pre < ta.length && pre < tb.length && ta[pre] === tb[pre]) pre++
  let suf = 0
  while (suf < ta.length - pre && suf < tb.length - pre && ta[ta.length - 1 - suf] === tb[tb.length - 1 - suf]) suf++
  const start = ta.slice(0, pre).join('').length
  const end = a.length - ta.slice(ta.length - suf).join('').length
  // A mark over the whole line says nothing more than the line's color.
  if (end <= start || (start === 0 && end === a.length)) return null
  return [start, end]
}

// Diff `before` against `after`. `firstLine` is the 1-based line of `before`'s first line in its file,
// or null when unknown (then lines carry no number).
export function diff(before: string, after: string, firstLine: number | null): Diff {
  const all = ops(splitLines(before), splitLines(after))
  const add = all.filter(o => o.kind === '+').length
  const del = all.filter(o => o.kind === '-').length
  // Keep changed lines and up to CONTEXT lines around each.
  const keep = new Array<boolean>(all.length).fill(false)
  all.forEach((o, k) => {
    if (o.kind === ' ') return
    for (let d = -CONTEXT; d <= CONTEXT; d++) if (k + d >= 0 && k + d < all.length) keep[k + d] = true
  })
  const lines: DiffLine[] = []
  let k = 0
  while (k < all.length) {
    const o = all[k] as Op
    if (!keep[k]) {
      k++
      continue
    }
    // A run of removed lines followed by added ones: pair them line by line for word marks.
    if (o.kind === '-') {
      let r = k
      while (r < all.length && all[r]?.kind === '-') r++
      let s = r
      while (s < all.length && all[s]?.kind === '+') s++
      const removed = all.slice(k, r)
      const added = all.slice(r, s)
      removed.forEach((x, idx) => {
        const pair = added[idx]
        const mark = pair ? markOf(x.text, pair.text) : null
        lines.push({ kind: '-', n: firstLine === null ? null : firstLine + x.oldN, text: clip(x.text), ...(mark && mark[1] <= MAX_TEXT ? { mark } : {}) })
      })
      added.forEach((y, idx) => {
        const pair = removed[idx]
        const mark = pair ? markOf(y.text, pair.text) : null
        lines.push({ kind: '+', n: firstLine === null ? null : firstLine + y.newN, text: clip(y.text), ...(mark && mark[1] <= MAX_TEXT ? { mark } : {}) })
      })
      k = s
      continue
    }
    const n = o.kind === '+' ? o.newN : o.oldN
    lines.push({ kind: o.kind, n: firstLine === null ? null : firstLine + n, text: clip(o.text) })
    k++
  }
  const cut = Math.max(0, lines.length - MAX_LINES)
  return { lines: lines.slice(0, MAX_LINES), add, del, cut }
}

// The 1-based line where `needle` starts in `text`, or null when it is not there.
export function lineOf(text: string, needle: string): number | null {
  if (needle === '') return null
  const at = text.indexOf(needle)
  if (at < 0) return null
  let n = 1
  for (let i = 0; i < at; i++) if (text.charCodeAt(i) === 10) n++
  return n
}
