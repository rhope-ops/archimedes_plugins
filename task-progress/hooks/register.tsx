import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Progress } from '../types'

const progress = atom({ plugin: 'task-progress', key: 'progress' } as const, null, {
  shape: 'progress-2',
})
const now = atom({ plugin: 'task-progress', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'task-progress', key: 'isHidden' } as const, false)

// Short label for the tool that runs now.
function describe(tool: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const detail =
    pick('description') || pick('file_path') || pick('pattern') || pick('command') || pick('url')
  const short = detail.length > 50 ? `${detail.slice(0, 49)}…` : detail
  return short ? `${tool}: ${short}` : tool
}

// Change the band's state while a turn is known; no-op before the first turn.
async function patch($: EngineInterface, fn: (p: Progress) => Progress): Promise<void> {
  await update($, progress, p => (p === null ? p : fn(p)))
}

// Moves the elapsed time once a second while a turn runs.
async function startTicker($: EngineInterface): Promise<{ cancel: () => void }> {
  return $.clock.every(1000, async () => {
    const ms = await $.clock.now()
    await update($, now, () => ms)
  })
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export const register: Register = on => {
  let ticker: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'progress', description: 'Show or hide the task progress band' })
    // After a reload in the middle of a turn, start the clock again.
    const p = await read($, progress)
    if (p?.isRunning) {
      ticker?.cancel()
      ticker = await startTicker($)
    }
    return next(e)
  })

  on('command.run', { command: 'progress' }, async $ => {
    const hidden = await update($, isHidden, v => !v)
    return { text: hidden ? 'Task progress band hidden.' : 'Task progress band shown.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const t = await $.clock.now()
    await update($, now, () => t)
    await update($, progress, () => ({
      isRunning: true,
      startedAt: t,
      endedAt: 0,
      steps: 0,
      tools: 0,
      current: 'Thinking',
      outcome: '',
    }))
    ticker?.cancel()
    ticker = await startTicker($)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      await patch($, p => ({ ...p, steps: p.steps + 1, current: 'Thinking' }))
    }
    return yield* next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      // Observe only: a failure here must never stop the tool.
      try {
        const label = describe(e.tool, e as unknown as Record<string, unknown>)
        await patch($, p => ({ ...p, tools: p.tools + 1, current: label }))
      } catch {}
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    ticker?.cancel()
    ticker = undefined
    const t = await $.clock.now()
    const outcome = { answer: 'Done', aborted: 'Stopped', refusal: 'Refused', error: 'Error' }[e.reason]
    await patch($, p => ({ ...p, isRunning: false, endedAt: t, current: '', outcome }))
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, progress)
    if (p === null || e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const t = p.isRunning ? await read($, now) : p.endedAt
    const elapsed = clock(t - p.startedAt)
    const counts = `${p.steps} steps · ${p.tools} tools`
    // Read live, so background subagents from an earlier turn count too.
    const subagents = (await $.agent.list()).filter(
      a => a.kind === 'local_agent' && a.status === 'running',
    ).length

    if (!p.isRunning) {
      return (
        <Box>
          <Text color={p.outcome === 'Done' ? 'green' : 'yellow'}>● {p.outcome}</Text>
          <Text dimColor> {elapsed} · {counts}</Text>
        </Box>
      )
    }

    return (
      <Box>
        <Text color="cyan">◐ {elapsed}</Text>
        <Text> {p.current}</Text>
        <Text dimColor>
          {' '}· {counts}
          {subagents > 0 ? ` · ${subagents} subagents running` : ''}
        </Text>
      </Box>
    )
  })
}
