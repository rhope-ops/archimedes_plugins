// Pure estimate of the time left in a turn. No engine calls: tested alone.
import type { Plan } from '../types'

export type Estimate =
  | { kind: 'learning' }
  | { kind: 'eta'; leftMs: number; basis: 'plan'; samples: number }

// The time left, from the turn's own task list alone: time per task done in this turn, times
// the tasks left. The same rule in every session and on every computer, so nothing is stored.
// No task done in this turn yet: no estimate ('learning', drawn as the meter's sweep).
export function estimate(elapsedMs: number, plan: Plan): Estimate {
  const left = plan.total - plan.done
  if (plan.doneThisTurn > 0 && left > 0) {
    return { kind: 'eta', leftMs: (elapsedMs / plan.doneThisTurn) * left, basis: 'plan', samples: plan.doneThisTurn }
  }
  return { kind: 'learning' }
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  // Under 10 minutes the seconds matter: 1m30s, not 2m.
  if (s < 600) return s % 60 === 0 ? `${s / 60}m` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}
