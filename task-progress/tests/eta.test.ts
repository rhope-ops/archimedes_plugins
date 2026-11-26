import { expect, test } from 'claude-code/testing'

import { duration, estimate } from '../hooks/eta'

test('no task done in this turn: no estimate', async () => {
  expect(estimate(60_000, { total: 0, done: 0, doneThisTurn: 0 })).toEqual({ kind: 'learning' })
  // Tasks done in an earlier turn do not count: their time is not in this turn's clock.
  expect(estimate(60_000, { total: 5, done: 2, doneThisTurn: 0 })).toEqual({ kind: 'learning' })
  // All done: nothing left to estimate.
  expect(estimate(60_000, { total: 2, done: 2, doneThisTurn: 2 })).toEqual({ kind: 'learning' })
})

test('time per task done in this turn times tasks left', async () => {
  const e = estimate(60_000, { total: 5, done: 2, doneThisTurn: 2 })
  expect(e).toEqual({ kind: 'eta', leftMs: 90_000, basis: 'plan', samples: 2 })
})

test('durations', async () => {
  expect(duration(45_000)).toBe('45s')
  expect(duration(240_000)).toBe('4m')
  expect(duration(90_000)).toBe('1m30s')
  expect(duration(725_000)).toBe('12m')
  expect(duration(5_400_000)).toBe('1h30')
})
