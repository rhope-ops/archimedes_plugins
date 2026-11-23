import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const sessionCount = atom({ plugin: 'advisor-watch', key: 'session' } as const, 0)
const TOTAL_KEY = 'advisor-total'

async function total($: EngineInterface): Promise<number> {
  const v = await $.store.get(TOTAL_KEY)
  return typeof v === 'number' ? v : 0
}

async function show($: EngineInterface, session: number): Promise<void> {
  $.ui.status(`advisor: ${session} this session · ${await total($)} total`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'advisor-stats',
      description: 'Show how often the advisor was consulted',
    })
    const result = await next(e)
    await show($, await read($, sessionCount))
    return result
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
        const session = await update($, sessionCount, n => n + calls)
        await $.store.set(TOTAL_KEY, (await total($)) + calls)
        const tier = /(fable|opus|sonnet|haiku)/i.exec(e.model)?.[1]?.toLowerCase() ?? e.model
        const who = e.agentId === undefined ? 'main' : 'subagent'
        $.ui.toast(`Advisor consulted by ${tier} (${who}) · #${session} this session`)
        await show($, session)
      }
    } catch {}
    return response
  })
}
