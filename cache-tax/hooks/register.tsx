import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheInfo } from '../types'

const info = atom({ plugin: 'cache-tax', key: 'info' } as const, null, { shape: 'cache-1' })
const now = atom({ plugin: 'cache-tax', key: 'now' } as const, 0)

const TTL_MS = { '5m': 5 * 60_000, '1h': 60 * 60_000 } as const
// Warn this long before the cache goes cold: 5 min for the 1h cache, 1 min for the 5m cache.
const SOON_MS = { '5m': 60_000, '1h': 5 * 60_000 } as const

function minutes(ms: number): string {
  return ms < 60_000 ? 'under 1 min' : `${Math.round(ms / 60_000)} min`
}

function kilo(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

async function remember($: EngineInterface, ttl: '5m' | '1h' | undefined): Promise<void> {
  const t = await $.clock.now()
  const usage = await $.session.usage()
  await update($, info, old => ({
    lastAt: t,
    ttl: ttl ?? old?.ttl ?? '1h',
    // Absent after /clear or /compact: then nothing large is re-read.
    tokens: usage.context.tokens ?? 0,
    percent: usage.context.percent ?? 0,
  }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    // Redraw the band every 15 s so the countdown moves.
    await $.clock.every(15_000, async () => {
      const t = await $.clock.now()
      await update($, now, () => t)
    })
    return result
  })

  // Each main request writes or reads the cache, which restarts its lifetime.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    if (e.agentId === undefined && response.usage) {
      try {
        const u = response.usage
        const ttl =
          (u.ephemeral_1h_input_tokens ?? 0) > 0 ? '1h' : (u.ephemeral_5m_input_tokens ?? 0) > 0 ? '5m' : undefined
        await remember($, ttl)
        await update($, now, () => 0)
      } catch {}
    }
    return response
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const c = await read($, info)
    const tick = await read($, now)
    if (c === null || tick === 0 || e.props.hasSurvey || c.tokens < 20_000) return next(e)

    const left = c.lastAt + TTL_MS[c.ttl] - tick
    if (left > SOON_MS[c.ttl]) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const cost = `the next message re-reads about ${kilo(c.tokens)} tokens (${c.percent}% of context) at full price`

    return (
      <Box>
        {left > 0 ? (
          <Text color="yellow">⏳ Cache goes cold in {minutes(left)}: after that, {cost}.</Text>
        ) : (
          <Text color="red">❄ Cache is cold: {cost}. Consider /compact or a new session.</Text>
        )}
      </Box>
    )
  })
}
