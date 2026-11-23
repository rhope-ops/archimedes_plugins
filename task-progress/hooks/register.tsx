import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Plan, Progress, TaskList, TurnRecord } from '../types'
import { MIN_SAMPLES, duration, estimate, relError, stats } from './eta'
import { apply, applyChange, completedChange } from './tasks'
import { SPIN, bar, fit, row1 as fitRow1, row2 as fitRow2, sweep } from './view'
import type { Change } from './tasks'

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

function failed(result: unknown): boolean {
  const r = result as { deny?: string; isError?: boolean }
  return r.deny !== undefined || r.isError === true
}

// Update the task list from a task tool call that worked, using its result.
async function track($: EngineInterface, tool: string, args: Record<string, unknown>, ran: unknown): Promise<void> {
  if (failed(ran)) return
  const result = (ran as { result?: unknown }).result as Record<string, unknown> | undefined
  let change: Change | undefined
  // Computed from the current value inside `update`, so parallel calls do not lose updates.
  await update($, tasks, current => {
    const after = apply(current, tool, args, result, () => `new-${crypto.randomUUID()}`)
    change = after === undefined ? undefined : completedChange(current, after)
    return after ?? current
  })
  const c = change
  if (c !== undefined && (c.added.length > 0 || c.removed.length > 0)) {
    await patch($, p => ({ ...p, completedInTurn: applyChange(p.completedInTurn, c) }))
  }
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
  const mmss = `${String(Math.floor(s / 60) % 60).padStart(s >= 3600 ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mmss}` : mmss
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
    const width = Math.max(0, e.props.bodyColumns)
    const isTwoRows = e.props.maxRows >= 2
    const t = p.isRunning ? await read($, now) : p.endedAt
    const elapsedMs = Math.max(0, t - p.startedAt)
    const plan = planOf(await read($, tasks), p.completedInTurn)
    // Read live, so background subagents from an earlier turn count too.
    const subagents = p.isRunning
      ? (await $.agent.list()).filter(a => a.kind === 'local_agent' && a.status === 'running').length
      : 0
    const counts = [
      `${p.steps} steps`,
      `${p.tools} tools`,
      ...(plan.total > 0 ? [`task ${Math.min(plan.done + (p.isRunning ? 1 : 0), plan.total)} of ${plan.total}`] : []),
      ...(subagents > 0 ? [`${subagents} subagents`] : []),
    ].join(' · ')

    // Row 1: state and clock, a bar across the width, then the estimate.
    let head: string
    let headColor: string
    let tail: string
    let shortTail: string
    let tailColor: string
    let frac: number | null
    if (!p.isRunning) {
      const isDone = p.outcome === 'Done'
      head = `● ${p.outcome} ${clock(elapsedMs)}`
      headColor = isDone ? 'green' : 'yellow'
      const off = p.predictedMs === null ? 0 : Math.round(relError(p.predictedMs, elapsedMs) * 100)
      const has = p.predictedMs !== null && isDone
      tail = has ? ` estimate was ${duration(p.predictedMs ?? 0)} (off ${off}%)` : ''
      shortTail = has ? ` off ${off}%` : ''
      tailColor = 'gray'
      frac = 1
    } else {
      const est = estimate(history, p.promptChars, elapsedMs, plan)
      head = `${SPIN[Math.floor(elapsedMs / 1000) % SPIN.length]} ${clock(elapsedMs)}`
      headColor = 'cyan'
      if (est.kind === 'eta') {
        frac = elapsedMs / Math.max(1, elapsedMs + est.leftMs)
        tail = ` ~${duration(est.leftMs)} left${est.basis === 'plan' ? ' (by tasks)' : ''}`
        shortTail = ` ~${duration(est.leftMs)}`
        tailColor = 'cyan'
      } else if (est.kind === 'over') {
        frac = 1
        tail = ' longer than usual'
        shortTail = ' longer'
        tailColor = 'yellow'
      } else {
        frac = null
        tail = ` ETA learning ${est.samples}/${MIN_SAMPLES}`
        shortTail = ` ${est.samples}/${MIN_SAMPLES}`
        tailColor = 'gray'
      }
    }
    const pct = p.isRunning && frac !== null && frac < 1 ? ` ${Math.round(frac * 100)}%` : ''
    const current = p.isRunning ? ` ${p.current}` : ''
    const barColor = !p.isRunning ? headColor : tailColor === 'yellow' ? 'yellow' : 'cyan'

    // Desktop, VS Code and phones (proportional fonts): the app lays the rows out.
    // Row 1: state and clock at the left, what runs now in the middle (cut first), the metrics fixed at the right.
    // Row 2, after a small gap: a segmented bar (▰ filled, ▱ empty), filled as a share of the row.
    if (e.surface !== 'terminal') {
      // Segmented blocks: filled ▰ and empty ▱, half a line high, clipped to the row.
      const FILLED = '▰'.repeat(240)
      const EMPTY = '▱'.repeat(240)
      const fillColor = !p.isRunning ? (p.outcome === 'Done' ? 'success' : 'warning') : tailColor === 'yellow' ? 'warning' : 'suggestion'
      const share = (x: number) => `${Math.round(Math.min(1, Math.max(0, x)) * 100)}%`
      const eta = p.isRunning
        ? tail.trim() + (pct ? ` (${pct.trim()})` : '')
        : p.predictedMs !== null && p.outcome === 'Done'
          ? `est ${duration(p.predictedMs)} · off ${Math.round(relError(p.predictedMs, elapsedMs) * 100)}%`
          : ''
      const metrics = [counts, eta].filter(Boolean).join(' · ')
      const at = (Math.floor(elapsedMs / 1000) * 10) % 80
      const seg = (key: string, width: string | null, color: string | null) => (
        <Box key={key} {...(width === null ? { flexGrow: 1, flexShrink: 1 } : { width, flexShrink: 0 })} minWidth={0} overflow="hidden">
          {color === null ? (
            <Text dimColor wrap="clip" maxLines={1}>
              {EMPTY}
            </Text>
          ) : (
            <Text color={color} wrap="clip" maxLines={1}>
              {FILLED}
            </Text>
          )}
        </Box>
      )
      const parts =
        frac === null
          ? [seg('before', `${at}%`, null), seg('fill', '20%', fillColor), seg('after', null, null)]
          : [seg('fill', share(frac), fillColor), seg('rest', null, null)]
      return (
        <Box flexDirection="column" rowGap="xs">
          <Box flexDirection="row" flexWrap="nowrap" alignItems="center" columnGap={2}>
            <Box flexShrink={0}>
              <Text color={headColor} weight="bold" tabular wrap="clip" maxLines={1}>
                {head}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text wrap="end" maxLines={1}>
                {current.trim()}
              </Text>
            </Box>
            <Box flexShrink={0}>
              <Text dimColor tabular wrap="clip" maxLines={1}>
                {metrics}
              </Text>
            </Box>
          </Box>
          <Box key="bar" flexDirection="row" flexWrap="nowrap" overflow="hidden">
            {parts}
          </Box>
        </Box>
      )
    }

    // Terminal: monospace cells, so the row is laid out to exactly the width.
    // One row only: the tool name goes after the estimate and the bar gets shorter.
    const r1 = fitRow1(width, head, pct, tail, shortTail, isTwoRows ? '' : current)
    const filled = frac === null ? null : bar(r1.barWidth, frac)
    const moving = frac === null ? sweep(r1.barWidth, Math.floor(elapsedMs / 1000)) : null

    const row1 = (
      <Box>
        <Text color={headColor} weight="bold" wrap="clip">
          {r1.head}
        </Text>
        {filled !== null ? (
          <Text color={barColor}>{filled.fill}</Text>
        ) : (
          <Text dimColor>{moving?.before ?? ''}</Text>
        )}
        {filled !== null ? (
          <Text dimColor>{filled.empty}</Text>
        ) : (
          <Text color="cyan">{moving?.glow ?? ''}</Text>
        )}
        {moving !== null && <Text dimColor>{moving.after}</Text>}
        {r1.pct !== '' && <Text weight="bold">{r1.pct}</Text>}
        {r1.tail !== '' && <Text color={tailColor}>{r1.tail}</Text>}
        {r1.inline !== '' && <Text>{r1.inline}</Text>}
      </Box>
    )
    if (!isTwoRows) return row1

    // Row 2: what Claude does now on the left, the counts on the right.
    const r2 = fitRow2(width, current, counts)
    return (
      <Box flexDirection="column">
        {row1}
        <Box>
          <Text>{r2.left}</Text>
          <Text dimColor>
            {r2.space}
            {r2.right}
          </Text>
        </Box>
      </Box>
    )
  })
}
