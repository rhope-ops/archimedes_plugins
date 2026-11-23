import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Plan, Progress, TaskList, TurnRecord } from '../types'
import { MIN_SAMPLES, duration, estimate, relError, stats } from './eta'

// Change a tag when its value's fields change: it declines what an older version stored.
const progress = atom({ plugin: 'task-progress', key: 'progress' } as const, null, {
  shape: 'progress-3',
})
const tasks = atom(
  { plugin: 'task-progress', key: 'tasks' } as const,
  { total: 0, completedIds: [] },
  { shape: 'tasks-1' },
)
const now = atom({ plugin: 'task-progress', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'task-progress', key: 'isHidden' } as const, false)

// Turn history across sessions, in this computer's plugin store.
const HISTORY_KEY = 'history-v1'
const HISTORY_MAX = 300

// Short label for the tool that runs now.
function describe(tool: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const detail =
    pick('description') || pick('subject') || pick('file_path') || pick('pattern') || pick('command') || pick('url')
  const short = detail.length > 50 ? `${detail.slice(0, 49)}…` : detail
  return short ? `${tool}: ${short}` : tool
}

function isRecord(x: unknown): x is TurnRecord {
  const r = x as TurnRecord
  return typeof r === 'object' && r !== null && typeof r.ms === 'number' && typeof r.promptChars === 'number'
}

async function loadHistory($: EngineInterface): Promise<TurnRecord[]> {
  const v = await $.store.get(HISTORY_KEY)
  return Array.isArray(v) ? v.filter(isRecord) : []
}

// Change the band's state while a turn is known; no-op before the first turn.
async function patch($: EngineInterface, fn: (p: Progress) => Progress): Promise<void> {
  await update($, progress, p => (p === null ? p : fn(p)))
}

// Update the task list from a task tool's arguments.
async function track($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<void> {
  if (tool === 'TodoWrite' && Array.isArray(args.todos)) {
    const todos = args.todos as { status?: string }[]
    const done = todos.map((t, i) => (t.status === 'completed' ? `todo-${i}` : '')).filter(Boolean)
    await update($, tasks, () => ({ total: todos.length, completedIds: done }))
  } else if (tool === 'TaskCreate') {
    // A new task after a finished list starts a new list.
    await update($, tasks, l =>
      l.total > 0 && l.completedIds.length >= l.total
        ? { total: 1, completedIds: [] }
        : { ...l, total: l.total + 1 },
    )
  } else if (tool === 'TaskUpdate' && typeof args.taskId === 'string') {
    const id = args.taskId
    if (args.status === 'completed') {
      await update($, tasks, l =>
        l.completedIds.includes(id) ? l : { ...l, completedIds: [...l.completedIds, id] },
      )
    } else if (args.status === 'deleted') {
      await update($, tasks, l => ({
        total: Math.max(0, l.total - 1),
        completedIds: l.completedIds.filter(x => x !== id),
      }))
    }
  }
}

function planOf(list: TaskList, doneAtStart: number): Plan {
  const done = Math.min(list.completedIds.length, list.total)
  return { total: list.total, done, doneThisTurn: Math.max(0, done - doneAtStart) }
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

function pct(x: number | null): string {
  return x === null ? 'n/a' : `${Math.round(x * 100)}%`
}

export const register: Register = on => {
  let ticker: { cancel: () => void } | undefined
  let history: TurnRecord[] = []

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'progress', description: 'Show or hide the task progress band' })
    await $.command.register({
      name: 'progress-stats',
      description: 'Show how accurate the time-left estimate is',
    })
    history = await loadHistory($)
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

  on('command.run', { command: 'progress-stats' }, async () => {
    const s = stats(history)
    const trend =
      s.recentError !== null && s.olderError !== null
        ? s.recentError < s.olderError
          ? 'better'
          : 'not better'
        : 'not enough turns yet'
    return {
      text: [
        `Turns recorded: ${s.turns} (estimates start after ${MIN_SAMPLES}).`,
        `Typical turn: ${duration(s.medianMs)}.`,
        `Median error of the first estimate: last 20 turns ${pct(s.recentError)}, 20 before ${pct(s.olderError)} (${trend}).`,
      ].join('\n'),
    }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const t = await $.clock.now()
    const list = await read($, tasks)
    const doneAtStart = planOf(list, 0).done
    const first = estimate(history, e.text.length, 0, { total: 0, done: 0, doneThisTurn: 0 })
    await update($, now, () => t)
    await update($, progress, () => ({
      isRunning: true,
      startedAt: t,
      endedAt: 0,
      steps: 0,
      tools: 0,
      current: 'Thinking',
      outcome: '',
      promptChars: e.text.length,
      predictedMs: first.kind === 'eta' ? first.leftMs : null,
      doneAtStart,
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
    // Observe only: a failure here must never stop the tool.
    try {
      const args = e as unknown as Record<string, unknown>
      // Subagents write the session's task list too.
      await track($, e.tool, args)
      if (e.agentId === undefined) {
        const label = describe(e.tool, args)
        await patch($, p => ({ ...p, tools: p.tools + 1, current: label }))
      }
    } catch {}
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    ticker?.cancel()
    ticker = undefined
    try {
      const t = await $.clock.now()
      const outcome = { answer: 'Done', aborted: 'Stopped', refusal: 'Refused', error: 'Error' }[e.reason]
      await patch($, p => ({ ...p, isRunning: false, endedAt: t, current: '', outcome }))
      // Learn only from turns that ran to an answer.
      const p = await read($, progress)
      if (p !== null && e.reason === 'answer') {
        const record: TurnRecord = {
          at: t,
          ms: t - p.startedAt,
          steps: p.steps,
          tools: p.tools,
          promptChars: p.promptChars,
          predictedMs: p.predictedMs,
        }
        history = [...(await loadHistory($)), record].slice(-HISTORY_MAX)
        await $.store.set(HISTORY_KEY, history)
      }
    } catch {}
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, progress)
    if (p === null || e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const t = p.isRunning ? await read($, now) : p.endedAt
    const elapsedMs = t - p.startedAt
    const counts = `${p.steps} steps · ${p.tools} tools`

    if (!p.isRunning) {
      const guess =
        p.predictedMs !== null && p.outcome === 'Done'
          ? ` · estimate was ${duration(p.predictedMs)} (off ${Math.round(relError(p.predictedMs, elapsedMs) * 100)}%)`
          : ''
      return (
        <Box>
          <Text color={p.outcome === 'Done' ? 'green' : 'yellow'}>● {p.outcome}</Text>
          <Text dimColor>
            {' '}
            {clock(elapsedMs)} · {counts}
            {guess}
          </Text>
        </Box>
      )
    }

    const plan = planOf(await read($, tasks), p.doneAtStart)
    const est = estimate(history, p.promptChars, elapsedMs, plan)
    const eta =
      est.kind === 'eta'
        ? `~${duration(est.leftMs)} left${est.basis === 'plan' ? ' (by tasks)' : ''}`
        : est.kind === 'over'
          ? 'longer than usual'
          : `ETA learning ${est.samples}/${MIN_SAMPLES}`
    const step = plan.total > 0 ? ` · task ${Math.min(plan.done + 1, plan.total)} of ${plan.total}` : ''
    // Read live, so background subagents from an earlier turn count too.
    const subagents = (await $.agent.list()).filter(
      a => a.kind === 'local_agent' && a.status === 'running',
    ).length

    return (
      <Box>
        <Text color="cyan">◐ {clock(elapsedMs)}</Text>
        <Text color={est.kind === 'over' ? 'yellow' : 'cyan'}> {eta}</Text>
        <Text> {p.current}</Text>
        <Text dimColor>
          {' '}· {counts}
          {step}
          {subagents > 0 ? ` · ${subagents} subagents running` : ''}
        </Text>
      </Box>
    )
  })
}
