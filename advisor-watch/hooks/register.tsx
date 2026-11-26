import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const sessionCount = atom({ plugin: 'advisor-watch', key: 'session' } as const, 0)
const TOTAL_KEY = 'advisor-total'

async function total($: EngineInterface): Promise<number> {
  const v = await $.store.get(TOTAL_KEY)
  return typeof v === 'number' ? v : 0
}

// Counts only: the task-progress band shows "advisor ×N" while a turn runs.
// No status line and no toast. /advisor-stats gives the session and all-time counts.
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'advisor-stats',
      description: 'Show how often the advisor was consulted',
    })
    return next(e)
  })

  on('command.run', { command: 'advisor-stats' }, async $ => {
    const session = await read($, sessionCount)
    return {
      text: `Advisor consulted ${session} times this session, ${await total($)} times in all sessions.`,
    }
  })

  // The advisor is a server tool: it shows in the step's result, never as a tool call.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    try {
      const calls = (response.serverToolUses ?? []).filter(u => u.name === 'advisor').length
      if (calls > 0) {
        await update($, sessionCount, n => n + calls)
        await $.store.set(TOTAL_KEY, (await total($)) + calls)
      }
    } catch {}
    return response
  })
}
