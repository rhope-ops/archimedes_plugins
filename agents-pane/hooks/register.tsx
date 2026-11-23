import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

const PANE = 'agents-pane'
// Each write redraws the pane, which then reads the live agent list.
const tick = atom({ plugin: 'agents-pane', key: 'tick' } as const, 0)

const ICON: Record<string, string> = {
  pending: '○',
  running: '◐',
  waiting: '◔',
  idle: '◌',
  completed: '●',
  failed: '✖',
  killed: '■',
}

async function redraw($: EngineInterface): Promise<void> {
  await update($, tick, n => n + 1)
}

function tokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function shortModel(id: string | undefined): string {
  if (!id) return '?'
  const m = /(fable|opus|sonnet|haiku)/i.exec(id)
  return m?.[1]?.toLowerCase() ?? id
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agents-pane', description: 'Open the subagents pane' })
    return next(e)
  })

  on('command.run', { command: 'agents-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Subagents' })
    return { text: 'Subagents pane opened.' }
  })

  // Open the pane at the first spawn, then redraw on each change.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      void $.ui.open({ id: PANE, title: 'Subagents' })
      await redraw($)
    } catch {}
    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) await redraw($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) await redraw($)
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId !== undefined) {
      try {
        await redraw($)
      } catch {}
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, tick)
    const { Box, Text } = $.ui.resolve(e)
    const agents = (await $.agent.list()).filter(a => a.kind === 'local_agent')
    const room = Math.max(1, Math.floor(((e.viewport?.rows ?? 24) - 3) / 3))

    if (agents.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No subagents in this session yet.</Text>
        </Box>
      )
    }

    const running = agents.filter(a => a.status === 'running').length
    const usd = agents.reduce((sum, a) => sum + (a.cost?.usd ?? 0), 0)

    return (
      <Box flexDirection="column">
        <Text bold>
          {running} running · {agents.length} total · ~${usd.toFixed(2)}
        </Text>
        {agents.slice(-room).map(a => {
          const label = (a.label.split('\n')[0] ?? '').slice(0, 60)
          return (
            <Box flexDirection="column" marginTop={1}>
              <Text color={a.status === 'failed' ? 'red' : a.status === 'running' ? 'cyan' : 'white'}>
                {ICON[a.status] ?? '·'} {a.description}
              </Text>
              <Text dimColor>
                {'  '}
                {a.type} · {shortModel(a.model)} · {tokens(a.tokenCount)} tok
                {a.cost ? ` · ~$${a.cost.usd.toFixed(2)}` : ''}
              </Text>
              {a.status === 'running' && label !== a.description && (
                <Text dimColor>
                  {'  '}
                  {label}
                </Text>
              )}
            </Box>
          )
        })}
      </Box>
    )
  })
}
