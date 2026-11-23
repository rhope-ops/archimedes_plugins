import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Plan, Progress, TaskList, TaskStatus, TurnRecord } from '../types'
import { MIN_SAMPLES, duration, estimate, relError, stats } from './eta'

// Change a tag when its value's fields change: it declines what an older version stored.
const progress = atom({ plugin: 'task-progress', key: 'progress' } as const, null, {
  shape: 'progress-4',
})
const tasks = atom({ plugin: 'task-progress', key: 'tasks' } as const, [], { shape: 'tasks-2' })
const now = atom({ plugin: 'task-progress', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'task-progress', key: 'isHidden' } as const, false)

// Turn history across sessions, in this computer's plugin store.
const HISTORY_KEY = 'history-v1'
const HISTORY_MAX = 300

// Short label for the tool that runs now.
function describe(tool: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const detail =
    pick('description') ||
    pick('subject') ||
    pick('file_path') ||
    pick('pattern') ||
    pick('command') ||
    pick('url')
  const short = detail.length > 50 ? `${detail.slice(0, 49)}…` : detail
  return short ? `${tool}: ${short}` : tool
}

function isRecord(x: unknown): x is TurnRecord {
  const r = x as TurnRecord
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  return (
    typeof r === 'object' &&
    r !== null &&
    num(r.ms) &&
    r.ms >= 0 &&
    num(r.promptChars) &&
    (r.predictedMs === null || num(r.predictedMs))
  )
}

async function loadHistory($: EngineInterface): Promise<TurnRecord[]> {
  const v = await $.store.get(HISTORY_KEY)
  return Array.isArray(v) ? v.filter(isRecord) : []
}

// Change the band's state while a turn is known; no-op before the first turn.
async function patch($: EngineInterface, fn: (p: Progress) => Progress): Promise<void> {
  await update($, progress, p => (p === null ? p : fn(p)))
}

const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed']

function failed(result: unknown): boolean {
  const r = result as { deny?: string; isError?: boolean }
  return r.deny !== undefined || r.isError === true
}

// Note which tasks became completed (or stopped being completed) during this turn.
async function noteTurn($: EngineInterface, before: TaskList, after: TaskList): Promise<void> {
  const was = new Set(before.filter(t => t.status === 'completed').map(t => t.id))
  const now = new Set(after.filter(t => t.status === 'completed').map(t => t.id))
  await patch($, p => {
    const kept = p.completedInTurn.filter(id => now.has(id))
    const added = [...now].filter(id => !was.has(id) && !kept.includes(id))
    return { ...p, completedInTurn: [...kept, ...added] }
  })
}

// Update the task list from a task tool call that worked, using its result.
async function track(
  $: EngineInterface,
  tool: string,
  args: Record<string, unknown>,
  ran: unknown,
): Promise<void> {
  if (failed(ran)) return
  const result = (ran as { result?: unknown }).result as Record<string, unknown> | undefined
  const before = await read($, tasks)
  let after: TaskList | undefined

  if (tool === 'TodoWrite') {
    const todos = (Array.isArray(result?.newTodos) ? result.newTodos : args.todos) as
      | { content?: string; status?: string }[]
      | undefined
    if (!Array.isArray(todos)) return
    after = todos.map((t, i) => ({
      id: `todo:${t.content ?? i}`,
      status: (STATUSES.includes(t.status ?? '') ? t.status : 'pending') as TaskStatus,
    }))
  } else if (tool === 'TaskCreate') {
    const task = result?.task as { id?: unknown } | undefined
    const id = typeof task?.id === 'string' ? task.id : `new-${before.length + 1}`
    // A new task after a finished list starts a new list.
    const isFinished = before.length > 0 && before.every(t => t.status === 'completed')
    after = [...(isFinished ? [] : before.filter(t => t.id !== id)), { id, status: 'pending' }]
  } else if (tool === 'TaskUpdate' && typeof args.taskId === 'string') {
    if (result?.success === false) return
    const id = args.taskId
    const status = args.status
    if (status === 'deleted') {
      after = before.filter(t => t.id !== id)
    } else if (typeof status === 'string' && STATUSES.includes(status)) {
      const entry = { id, status: status as TaskStatus }
      after = before.some(t => t.id === id) ? before.map(t => (t.id === id ? entry : t)) : [...before, entry]
    }
  }

  if (after === undefined) return
  await update($, tasks, () => after)
  await noteTurn($, before, after)
}

function planOf(list: TaskList, completedInTurn: readonly string[]): Plan {
  const done = list.filter(t => t.status === 'completed')
  const ids = new Set(done.map(t => t.id))
  return {
    total: list.length,
    done: done.length,
    doneThisTurn: completedInTurn.filter(id => ids.has(id)).length,
  }
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
    try {
      history = await loadHistory($)
      // After a reload in the middle of a turn, start the clock again.
      const p = await read($, progress)
      if (p?.isRunning) {
        ticker?.cancel()
        ticker = await startTicker($)
      }
    } catch {}
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
    try {
      const t = await $.clock.now()
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
        completedInTurn: [],
      }))
      ticker?.cancel()
      ticker = await startTicker($)
    } catch {}
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
    const args = e as unknown as Record<string, unknown>
    try {
      if (e.agentId === undefined) {
        const label = describe(e.tool, args)
        await patch($, p => ({ ...p, tools: p.tools + 1, current: label }))
      }
    } catch {}
    const ran = await next(e)
    try {
      // Subagents write the session's task list too.
      if (e.tool === 'TaskCreate' || e.tool === 'TaskUpdate' || e.tool === 'TodoWrite') {
        await track($, e.tool, args, ran)
      }
    } catch {}
    return ran
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

    const plan = planOf(await read($, tasks), p.completedInTurn)
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
          {' '}
          · {counts}
          {step}
          {subagents > 0 ? ` · ${subagents} subagents running` : ''}
        </Text>
      </Box>
    )
  })
}
