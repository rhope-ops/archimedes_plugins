import { expect, test } from 'claude-code/testing'

import { bucket, duration, estimate, relError, stats } from '../hooks/eta'
import type { TurnRecord } from '../types'

const NO_PLAN = { total: 0, done: 0, doneThisTurn: 0 }
const turn = (ms: number, promptChars = 50, predictedMs: number | null = null): TurnRecord => ({
  at: 0,
  ms,
  steps: 1,
  tools: 1,
  promptChars,
  predictedMs,
})

test('fewer than 5 turns: still learning', async () => {
  const e = estimate([turn(10_000), turn(20_000)], 50, 0, NO_PLAN)
  expect(e.kind).toBe('learning')
})

test('history: median end of the turns that ran longer than now', async () => {
  const h = [10, 20, 30, 40, 50, 60, 70].map(s => turn(s * 1000))
  const atStart = estimate(h, 50, 0, NO_PLAN)
  expect(atStart).toEqual({ kind: 'eta', leftMs: 40_000, basis: 'history', samples: 7 })
  // At 35 s only 40..70 s turns remain: median end 55 s, so 20 s left.
  const later = estimate(h, 50, 35_000, NO_PLAN)
  expect(later).toEqual({ kind: 'eta', leftMs: 20_000, basis: 'history', samples: 7 })
  expect(estimate(h, 50, 80_000, NO_PLAN).kind).toBe('over')
})

test('history uses the same prompt size when it has 8 turns', async () => {
  const short = Array.from({ length: 8 }, () => turn(10_000, 50))
  const long = Array.from({ length: 8 }, () => turn(300_000, 2000))
  const e = estimate([...short, ...long], 2000, 0, NO_PLAN)
  expect(e).toEqual({ kind: 'eta', leftMs: 300_000, basis: 'history', samples: 8 })
  expect(bucket(50)).toBe('s')
  expect(bucket(300)).toBe('m')
  expect(bucket(2000)).toBe('l')
})

test('task list wins: time per task done in this turn times tasks left', async () => {
  const e = estimate([], 50, 60_000, { total: 5, done: 2, doneThisTurn: 2 })
  expect(e).toEqual({ kind: 'eta', leftMs: 90_000, basis: 'plan', samples: 2 })
})

test('stats compare the last 20 errors with the 20 before', async () => {
  const older = Array.from({ length: 20 }, () => turn(100_000, 50, 150_000))
  const recent = Array.from({ length: 20 }, () => turn(100_000, 50, 110_000))
  const s = stats([...older, ...recent])
  expect(s.turns).toBe(40)
  expect(s.olderError).toBe(0.5)
  expect(s.recentError).toBe(0.1)
  expect(relError(50_000, 100_000)).toBe(0.5)
  expect(duration(45_000)).toBe('45s')
  expect(duration(240_000)).toBe('4m')
  expect(duration(90_000)).toBe('1m30s')
  expect(duration(725_000)).toBe('12m')
  expect(duration(5_400_000)).toBe('1h30')
})
