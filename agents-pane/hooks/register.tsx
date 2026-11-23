import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register } from 'claude-code'

import { agentTokens, since, tokensText, usdText } from './pricing'

const PANE = 'agents-pane'
// Each write redraws the pane, which then reads the live agent list.
const tick = atom({ plugin: 'agents-pane', key: 'tick' } as const, 0)

const STATUS: Record<string, { icon: string; color: string; word: string }> = {
  pending: { icon: '○', color: 'inactive', word: 'waiting to start' },
  running: { icon: '●', color: 'suggestion', word: 'running' },
  waiting: { icon: '◔', color: 'warning', word: 'waiting' },
  idle: { icon: '◌', color: 'inactive', word: 'idle' },
  completed: { icon: '✓', color: 'success', word: 'done' },
  failed: { icon: '✕', color: 'error', word: 'failed' },
  killed: { icon: '■', color: 'inactive', word: 'stopped' },
}

const ORDER = ['running', 'waiting', 'pending', 'idle', 'failed', 'killed', 'completed']

async function redraw($: EngineInterface): Promise<void> {
  await update($, tick, n => n + 1)
}

function shortModel(id: string | undefined): string {
  if (!id) return '?'
  const m = /(fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/i.exec(id)
  return m ? `${m[1]?.toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id
}

export const register: Register = on => {
  let isOpened = false
  let ticker: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agents-pane', description: 'Open the subagents pane' })
    // Run times move while the pane is open; a cheap redraw every 2 s.
    ticker?.cancel()
    ticker = await $.clock.every(2000, async () => {
      const running = (await $.agent.list()).some(a => a.status === 'running')
      if (running) await redraw($)
    })
    return next(e)
  })

  on('command.run', { command: 'agents-pane' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Subagents' })
    return { text: 'Subagents pane opened. Costs are Claude Code estimates, the same as /cost.' }
  })

  // Open the pane at the first spawn, then redraw on each change.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      if (!isOpened) {
        isOpened = true
        $.ui.open({ id: PANE, title: 'Subagents' }).catch(() => {})
      }
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

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, tick)
    const { Box, Text } = $.ui.resolve(e)
    const now = Date.now()
    const agents = (await $.agent.list()).filter(a => a.kind === 'local_agent')

    if (agents.length === 0) {
      return (
        <Box flexDirection="column" padding={1} rowGap={1}>
          <Text weight="semibold">No subagents yet</Text>
          <Text dimColor size="footnote" wrap="wrap">
            Each subagent shows here with its task, model, tokens and cost (the same estimate as /cost).
          </Text>
        </Box>
      )
    }

    const rows = agents.map(a => ({ a, tokens: agentTokens(a.usage ?? []), usd: a.cost?.usd }))
    rows.sort(
      (x, y) => ORDER.indexOf(x.a.status) - ORDER.indexOf(y.a.status) || y.a.startTime - x.a.startTime,
    )
    const live = rows.filter(r => ['running', 'waiting', 'pending'].includes(r.a.status))
    const running = rows.filter(r => r.a.status === 'running').length
    const rest = rows.filter(r => !live.includes(r))
    const tokens = rows.reduce((n, r) => n + r.tokens, 0)
    // Sum the agents that have a cost yet; a '+' marks that one or more have none yet.
    const usd = rows.reduce((n, r) => n + (r.usd ?? 0), 0)
    const isPartial = rows.some(r => r.usd === undefined)
    const hasCost = rows.some(r => r.usd !== undefined)
    const room = Math.max(3, Math.floor(((e.viewport?.rows ?? 30) - 6) / 4))

    const card = (r: (typeof rows)[number], isLive: boolean) => {
      const a: AgentInfo = r.a
      const st = STATUS[a.status] ?? { icon: '·', color: 'inactive', word: a.status }
      const label = (a.label.split('\n')[0] ?? '').trim()
      const meta = `${a.type} · ${shortModel(a.model)} · ${tokensText(r.tokens)} tok · ${since(now - a.startTime)}`
      if (!isLive) {
        return (
          <Box key={a.id} flexDirection="row" flexWrap="nowrap" columnGap={1} paddingX={1}>
            <Text color={st.color}>{st.icon}</Text>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor wrap="end" maxLines={1}>
                {a.description}
              </Text>
            </Box>
            <Text dimColor tabular wrap="clip">
              {usdText(r.usd)}
            </Text>
          </Box>
        )
      }
      return (
        <Box key={a.id} flexDirection="column" borderStyle="round" borderColor={st.color} paddingX={1}>
          <Box flexDirection="row" flexWrap="nowrap" columnGap={1}>
            <Text color={st.color}>{st.icon}</Text>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text weight="semibold" wrap="end" maxLines={1}>
                {a.description}
              </Text>
            </Box>
            <Text weight="semibold" tabular wrap="clip">
              {usdText(r.usd)}
            </Text>
          </Box>
          <Text dimColor size="footnote" tabular wrap="end" maxLines={1}>
            {meta}
          </Text>
          {label !== '' && label !== a.description && (
            <Text italic dimColor size="footnote" wrap="end" maxLines={1}>
              {label}
            </Text>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column" paddingX={1}>
          <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" columnGap={1}>
            <Text weight="bold" tabular wrap="clip">
              {running} running · {rest.length} finished
            </Text>
            <Text weight="bold" tabular wrap="clip">
              {hasCost ? usdText(usd) : usdText(undefined)}
              {hasCost && isPartial ? '+' : ''}
            </Text>
          </Box>
          <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" columnGap={1}>
            <Text dimColor size="footnote" tabular wrap="clip">
              {tokensText(tokens)} tokens
            </Text>
            <Text dimColor size="footnote" wrap="end" maxLines={1}>
              estimate, as /cost
            </Text>
          </Box>
        </Box>
        {live.slice(0, room).map(r => card(r, true))}
        {live.length > room && (
          <Box paddingX={1}>
            <Text dimColor size="footnote">
              +{live.length - room} more active
            </Text>
          </Box>
        )}
        {rest.length > 0 && (
          <Box flexDirection="column">
            <Box paddingX={1}>
              <Text dimColor size="caption" weight="semibold">
                FINISHED
              </Text>
            </Box>
            {rest.slice(0, room * 2).map(r => card(r, false))}
          </Box>
        )}
      </Box>
    )
  })
}
