// Pure estimate of the time left in a turn. No engine calls: tested alone.
import type { Plan, TurnRecord } from '../types'

export type Estimate =
  | { kind: 'learning'; samples: number }
  | { kind: 'over'; samples: number }
  | { kind: 'eta'; leftMs: number; basis: 'plan' | 'history'; samples: number }

export const MIN_SAMPLES = 5
const BUCKET_MIN = 8

export function bucket(promptChars: number): 's' | 'm' | 'l' {
  return promptChars < 120 ? 's' : promptChars < 600 ? 'm' : 'l'
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? (s[mid] ?? 0) : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2
}

// The turns to learn from: the same prompt size when there are enough, else all.
export function sample(history: readonly TurnRecord[], promptChars: number): TurnRecord[] {
  const b = bucket(promptChars)
  const same = history.filter(t => bucket(t.promptChars) === b)
  return same.length >= BUCKET_MIN ? same : [...history]
}

export function estimate(
  history: readonly TurnRecord[],
  promptChars: number,
  elapsedMs: number,
  plan: Plan,
): Estimate {
  // 1. The turn's own task list: time per task done in this turn, times tasks left.
  const left = plan.total - plan.done
  if (plan.doneThisTurn > 0 && left > 0) {
    return {
      kind: 'eta',
      leftMs: (elapsedMs / plan.doneThisTurn) * left,
      basis: 'plan',
      samples: plan.doneThisTurn,
    }
  }

  // 2. History: of past turns that ran longer than this one so far, the median end.
  const turns = sample(history, promptChars)
  if (turns.length < MIN_SAMPLES) return { kind: 'learning', samples: turns.length }
  const longer = turns.map(t => t.ms).filter(ms => ms > elapsedMs)
  if (longer.length === 0) return { kind: 'over', samples: turns.length }
  return { kind: 'eta', leftMs: median(longer) - elapsedMs, basis: 'history', samples: turns.length }
}

// Relative error of a first estimate: |predicted - actual| / actual.
export function relError(predictedMs: number, actualMs: number): number {
  return Math.abs(predictedMs - actualMs) / Math.max(actualMs, 1000)
}

export type Stats = {
  turns: number
  medianMs: number
  recentError: number | null
  olderError: number | null
}

// Median error of the first estimate: the last 20 turns against the 20 before them.
export function stats(history: readonly TurnRecord[]): Stats {
  const errs = history.filter(t => t.predictedMs !== null).map(t => relError(t.predictedMs ?? 0, t.ms))
  const recent = errs.slice(-20)
  const older = errs.slice(-40, -20)
  return {
    turns: history.length,
    medianMs: history.length > 0 ? median(history.map(t => t.ms)) : 0,
    recentError: recent.length > 0 ? median(recent) : null,
    olderError: older.length > 0 ? median(older) : null,
  }
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}
