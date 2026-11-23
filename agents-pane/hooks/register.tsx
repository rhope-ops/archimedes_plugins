import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { AgentSnap, Ledger } from '../types'
import { addUsage, costRecord, isSafeId, since, snapOf, splitCells, splitTotal, sync, tokensText, typeColor, usdText } from './pricing'

const PANE = 'agents-pane'
// Moves the run times of running agents while the pane is open.
const tick = atom({ plugin: 'agents-pane', key: 'tick' } as const, 0)
// Every subagent of the session, also after Claude Code drops it from its own list.
const EMPTY: Ledger = {
  types: [],
  order: [],
  agents: {},
  main: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  mainTurns: 0,
  sessionUsd: null,
}
const ledger = atom({ plugin: 'agents-pane', key: 'ledger' } as const, EMPTY, { shape: 'ledger-2' })

const STATUS: Record<string, { icon: string; color: string; word: string }> = {
  pending: { icon: '○', color: 'inactive', word: 'waiting to start' },
  running: { icon: '●', color: 'suggestion', word: 'running' },
  waiting: { icon: '◔', color: 'warning', word: 'waiting' },
  idle: { icon: '◌', color: 'inactive', word: 'idle' },
  completed: { icon: '✓', color: 'success', word: 'done' },
  failed: { icon: '✕', color: 'error', word: 'failed' },
  killed: { icon: '■', color: 'inactive', word: 'stopped' },
  // Left Claude Code's list while it ran, with no last reading.
  ended: { icon: '✓', color: 'inactive', word: 'ended' },
}
const LIVE = ['running', 'waiting', 'pending']

// Read the live list and fold it into the ledger. Writes only when something changed.
async function refresh($: EngineInterface): Promise<void> {
  const list = (await $.agent.list()).filter(a => a.kind === 'local_agent')
  const t = Date.now()
  const before = await read($, ledger)
  const after = sync(before, list.map(snapOf), t)
  if (after !== before) await update($, ledger, current => sync(current, list.map(snapOf), t))
  const usd = (await $.session.usage()).cost?.usd ?? null
  if (usd !== before.sessionUsd) await update($, ledger, current => ({ ...current, sessionUsd: usd }))
}

function shortModel(id: string | null): string {
  if (!id) return '?'
  const m = /(fable|opus|sonnet|haiku)-(\d{1,2})(?:-(\d{1,2}))?(?!\d)/i.exec(id)
  return m ? `${m[1]?.toLowerCase()} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : id
}

// Save the /cost record where the token-log Stop hook picks it up and pushes it with its rows.
// TOKEN_LOG=off turns it off, as it does the hook; TOKEN_LOG_HOME moves it, as it does the hook's files.
async function saveCost($: EngineInterface): Promise<void> {
  if ((await $.env.get('TOKEN_LOG')) === 'off') return
  const base = (await $.env.get('TOKEN_LOG_HOME')) || `${(await $.env.get('HOME')) ?? ''}/.claude/token-log`
  const id = await $.session.id()
  if (!base.startsWith('/') || !isSafeId(id)) return
  const record = costRecord(await read($, ledger), id, Date.now())
  await $.fs.write(`${base}/cost/${id}.json`, `${JSON.stringify(record, null, 1)}\n`)
}

const runMs = (a: AgentSnap, now: number) => Math.max(0, (a.endTime ?? now) - a.startTime)

export const register: Register = on => {
  let isOpened = false
  let ticker: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agents-pane', description: 'Open the subagents pane' })
    ticker?.cancel()
    ticker = await $.clock.every(2000, async () => {
      try {
        await refresh($)
        const l = await read($, ledger)
        if (Object.values(l.agents).some(a => LIVE.includes(a.status))) await update($, tick, n => n + 1)
      } catch {}
    })
    return next(e)
  })

  on('command.run', { command: 'agents-pane' }, async $ => {
    await refresh($).catch(() => {})
    await $.ui.open({ id: PANE, title: 'Subagents' })
    return { text: 'Subagents pane opened. Costs are Claude Code estimates, the same as /cost.' }
  })

  // Open the pane at the first spawn, then keep the ledger current on each change.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      if (!isOpened) {
        isOpened = true
        $.ui.open({ id: PANE, title: 'Subagents' }).catch(() => {})
      }
      await refresh($)
    } catch {}
    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) await refresh($).catch(() => {})
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    try {
      if (e.agentId === undefined && e.usage !== undefined) {
        const u = e.usage
        await update($, ledger, l => ({ ...l, main: addUsage(l.main, u), mainTurns: l.mainTurns + 1 }))
      }
      await refresh($)
      // At each turn end, so the Stop hook that runs right after finds this turn's figures.
      await saveCost($)
    } catch {}
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, tick)
    const l = await read($, ledger)
    const { Box, Text } = $.ui.resolve(e)
    const now = Date.now()
    const isTerminal = e.surface === 'terminal'
    const colorOf = (type: string) => typeColor(l.types.indexOf(type), isTerminal)
    const all = l.order.map(id => l.agents[id]).filter((a): a is AgentSnap => a !== undefined)

    // The whole session: the main conversation beside the subagents. The main cost is the session's /cost
    // total less the subagents', so it also holds mods' own model calls.
    const subUsd = all.reduce((n, a) => n + (a.usd ?? 0), 0)
    const subTokens = all.reduce((n, a) => n + splitTotal(a.tokens), 0)
    const mainTokens = splitTotal(l.main)
    const mainUsd = l.sessionUsd === null ? undefined : Math.max(0, l.sessionUsd - subUsd)
    const row = (key: string, label: string, tok: string, cost: string, strong = false) => (
      <Box key={key} flexDirection="row" flexWrap="nowrap" columnGap={2}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="end" maxLines={1} {...(strong ? { weight: 'semibold' } : { dimColor: true })}>
            {label}
          </Text>
        </Box>
        <Text tabular dimColor wrap="clip">
          {tok}
        </Text>
        <Text tabular wrap="clip" {...(strong ? { weight: 'semibold' } : {})}>
          {cost}
        </Text>
      </Box>
    )
    const sessionBlock = (
      <Box key="session" flexDirection="column" paddingX={1}>
        <Text dimColor size="caption" weight="semibold">
          SESSION
        </Text>
        {row('main', `Main conversation · ${l.mainTurns} turn${l.mainTurns === 1 ? '' : 's'}`, `${tokensText(mainTokens)} tok`, usdText(mainUsd))}
        {row('sub', `Subagents · ${all.length}`, `${tokensText(subTokens)} tok`, usdText(all.length > 0 ? subUsd : 0))}
        {row('total', 'Session total', `${tokensText(mainTokens + subTokens)} tok`, usdText(l.sessionUsd ?? undefined), true)}
      </Box>
    )

    if (all.length === 0) {
      return (
        <Box flexDirection="column" paddingY={1} rowGap={1}>
          {sessionBlock}
          <Box flexDirection="column" paddingX={1} rowGap={1}>
            <Text weight="semibold">No subagents yet</Text>
            <Text dimColor size="footnote" wrap="wrap">
              Each subagent shows here with its task, model, tokens, run time and cost (the same estimate as /cost). The
              totals keep every agent of the session.
            </Text>
          </Box>
        </Box>
      )
    }

    // Session totals over every agent, finished ones too.
    const sum = (f: (a: AgentSnap) => number) => all.reduce((n, a) => n + f(a), 0)
    const tok = {
      input: sum(a => a.tokens.input),
      output: sum(a => a.tokens.output),
      cacheRead: sum(a => a.tokens.cacheRead),
      cacheWrite: sum(a => a.tokens.cacheWrite),
    }
    const tokens = tok.input + tok.output + tok.cacheRead + tok.cacheWrite
    const usd = sum(a => a.usd ?? 0)
    const hasCost = all.some(a => a.usd !== null)
    const isPartial = all.some(a => a.usd === null)
    const totalText = hasCost ? `${usdText(usd)}${isPartial ? '+' : ''}` : usdText(undefined)
    const agentMs = sum(a => runMs(a, now))
    const firstStart = Math.min(...all.map(a => a.startTime))
    const lastEnd = Math.max(...all.map(a => a.endTime ?? now))
    const count = (s: string) => all.filter(a => a.status === s).length
    const statusLine = [
      ...(count('running') ? [`${count('running')} running`] : []),
      ...(count('waiting') + count('pending') ? [`${count('waiting') + count('pending')} waiting`] : []),
      `${count('completed') + count('ended')} done`,
      ...(count('failed') ? [`${count('failed')} failed`] : []),
      ...(count('killed') + count('idle') ? [`${count('killed') + count('idle')} stopped`] : []),
    ].join(' · ')

    // By type, in the fixed color order.
    const byType = l.types
      .map(type => {
        const of = all.filter(a => a.type === type)
        const t = of.reduce((n, a) => n + a.tokens.input + a.tokens.output + a.tokens.cacheRead + a.tokens.cacheWrite, 0)
        return {
          type,
          n: of.length,
          tokens: t,
          usd: of.reduce((n, a) => n + (a.usd ?? 0), 0),
          ms: of.reduce((n, a) => n + runMs(a, now), 0),
        }
      })
      .filter(g => g.n > 0)
    // The share bar splits by cost; by tokens before any cost exists.
    const shareOf = (g: (typeof byType)[number]) => (hasCost && usd > 0 ? g.usd / usd : tokens > 0 ? g.tokens / tokens : g.n / all.length)
    const RUN = 300

    const stat = (label: string, value: string, key: string, strong = false) => (
      <Box key={key} flexDirection="row" flexWrap="nowrap" justifyContent="space-between" columnGap={2}>
        <Text dimColor size="footnote" wrap="clip">
          {label}
        </Text>
        <Text tabular wrap="end" maxLines={1} {...(strong ? { weight: 'semibold' } : {})}>
          {value}
        </Text>
      </Box>
    )

    const section = (title: string) => (
      <Box paddingX={1}>
        <Text dimColor size="caption" weight="semibold">
          {title}
        </Text>
      </Box>
    )

    const card = (a: AgentSnap) => {
      const st = STATUS[a.status] ?? { icon: '·', color: 'inactive', word: a.status }
      const isLive = LIVE.includes(a.status)
      const color = colorOf(a.type)
      const t = a.tokens
      const total = t.input + t.output + t.cacheRead + t.cacheWrite
      const label = (a.label.split('\n')[0] ?? '').trim()
      return (
        <Box key={a.id} flexDirection="column" borderStyle="round" borderColor={color} borderDimColor={!isLive} paddingX={1}>
          <Box flexDirection="row" flexWrap="nowrap" columnGap={1}>
            <Text color={st.color}>{st.icon}</Text>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text weight="semibold" wrap="end" maxLines={1}>
                {a.description}
              </Text>
            </Box>
            <Text weight="semibold" tabular wrap="clip">
              {usdText(a.usd ?? undefined)}
            </Text>
          </Box>
          <Box flexDirection="row" flexWrap="nowrap" columnGap={1}>
            <Text color={color} size="footnote" wrap="clip">
              {a.type}
            </Text>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor size="footnote" tabular wrap="end" maxLines={1}>
                · {shortModel(a.model)} · {st.word} · {since(runMs(a, now))}
              </Text>
            </Box>
          </Box>
          <Text dimColor size="footnote" tabular wrap="end" maxLines={1}>
            {tokensText(total)} tok · in {tokensText(t.input)} · out {tokensText(t.output)} · cache {tokensText(t.cacheRead)}r /{' '}
            {tokensText(t.cacheWrite)}w
          </Text>
          {isLive && label !== '' && label !== a.description && (
            <Text italic dimColor size="footnote" wrap="end" maxLines={1}>
              {label}
            </Text>
          )}
        </Box>
      )
    }

    const live = all.filter(a => LIVE.includes(a.status)).sort((x, y) => y.startTime - x.startTime)
    const done = all.filter(a => !LIVE.includes(a.status)).sort((x, y) => (y.endTime ?? now) - (x.endTime ?? now))

    return (
      <Box flexDirection="column" rowGap={1}>
        {sessionBlock}
        <Box flexDirection="column" paddingX={1}>
          <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" columnGap={1}>
            <Text weight="bold" wrap="clip">
              {all.length} subagent{all.length === 1 ? '' : 's'}
            </Text>
            <Text weight="bold" tabular wrap="clip">
              {totalText}
            </Text>
          </Box>
          <Text dimColor size="footnote" tabular wrap="end" maxLines={1}>
            {statusLine}
          </Text>
        </Box>

        <Box flexDirection="column" paddingX={1}>
          {stat('Tokens', tokensText(tokens), 'tok', true)}
          {stat('  input · output', `${tokensText(tok.input)} · ${tokensText(tok.output)}`, 'io')}
          {stat('  cache read · write', `${tokensText(tok.cacheRead)} · ${tokensText(tok.cacheWrite)}`, 'cache')}
          {stat('Agent time', since(agentMs), 'agent-ms', true)}
          {stat('  wall clock', since(lastEnd - firstStart), 'wall')}
          <Text dimColor size="caption" wrap="end" maxLines={1}>
            estimate, as /cost{isPartial && hasCost ? '; + some have no cost yet' : ''}
          </Text>
        </Box>

        <Box flexDirection="column" paddingX={1} rowGap={0}>
          {isTerminal ? (
            // Terminal: whole cells, laid out to the pane's width.
            <Box key="share" flexDirection="row" flexWrap="nowrap">
              {splitCells(Math.max(0, (e.props.bodyColumns ?? 40) - 2), byType.map(shareOf)).map((n, i) => (
                <Text key={byType[i]?.type ?? String(i)} color={colorOf(byType[i]?.type ?? '')} wrap="clip">
                  {'█'.repeat(n)}
                </Text>
              ))}
            </Box>
          ) : (
          <Box key="share" flexDirection="row" flexWrap="nowrap" overflow="hidden">
            {byType.map((g, i) => (
              <Box
                key={g.type}
                overflow="hidden"
                minWidth={0}
                {...(i === byType.length - 1
                  ? { flexGrow: 1, flexShrink: 1 }
                  : { flexShrink: 0, width: `${Math.round(shareOf(g) * 100)}%` })}
              >
                <Text mono size="caption" color={colorOf(g.type)} wrap="clip" maxLines={1}>
                  {'█'.repeat(RUN)}
                </Text>
              </Box>
            ))}
          </Box>
          )}
          {byType.map(g => (
            <Box key={`t-${g.type}`} flexDirection="row" flexWrap="nowrap" columnGap={1}>
              <Text color={colorOf(g.type)}>■</Text>
              <Box flexGrow={1} flexShrink={1} minWidth={0}>
                <Text wrap="end" maxLines={1}>
                  {g.type}
                </Text>
              </Box>
              <Text dimColor size="footnote" tabular wrap="clip">
                ×{g.n} · {tokensText(g.tokens)} · {since(g.ms)} ·
              </Text>
              <Text tabular wrap="clip">
                {usdText(hasCost ? g.usd : undefined)}
              </Text>
            </Box>
          ))}
        </Box>

        {live.length > 0 && section(`ACTIVE · ${live.length}`)}
        {live.map(card)}
        {done.length > 0 && section(`FINISHED · ${done.length}`)}
        {done.map(card)}
      </Box>
    )
  })
}
