import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Plan, Progress, TaskList } from '../types'
import { duration, estimate } from './eta'
import type { Estimate } from './eta'
import { activeTitle, apply, applyChange, completedChange } from './tasks'
import {
  ROLE_HEX,
  ROLE_NAMED,
  SPIN,
  STATE_HEX,
  STATE_NAMED,
  bar,
  ease,
  fit,
  fitPath,
  gap,
  cells as cellWidth,
  meter,
  roleOf,
  row1 as fitRow1,
  GUTTER,
  splitPath,
  stateOf,
  sweep,
  verdict,
} from './view'
import type { BandState, Role } from './view'
import type { Change } from './tasks'

// Change a tag when its value's fields change: it declines what an older version stored.
const progress = atom({ plugin: 'task-progress', key: 'progress' } as const, null, {
  shape: 'progress-6',
})
const tasks = atom({ plugin: 'task-progress', key: 'tasks' } as const, [], { shape: 'tasks-3' })
const now = atom({ plugin: 'task-progress', key: 'now' } as const, 0)
const isHidden = atom({ plugin: 'task-progress', key: 'isHidden' } as const, false)
const advisorSession = atom({ plugin: 'task-progress', key: 'advisorSession' } as const, 0)
const agentTypes = atom({ plugin: 'task-progress', key: 'agentTypes' } as const, {})

// The band redraws this often while a turn runs, so the bar moves smoothly.
const TICK_MS = 150
// Cells of the desktop meter.
const CELLS = 40
const TRACK_HEX = '#8a94a633'

const READS = new Set(['Read', 'NotebookRead'])
const WRITES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

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

// Asks a small model what the turn's prompt is for, in a few words. The prompt text goes only into this
// call; the answer stays in session state only.
const GOAL_SYSTEM =
  "You label what a person's request to a coding assistant is for. Reply with only the goal as a short phrase " +
  'of 3 to 7 words in sentence case: the intent, not the steps (for example "Polish the subagents pane" or ' +
  '"Find why the login test fails"). No quotes, no period, nothing else.'
const MIN_GOAL_PROMPT = 12

export function cleanGoal(text: string): string {
  const line = (text.split('\n').find(l => l.trim() !== '') ?? '').trim()
  const bare = line.replace(/^(goal:\s*)/i, '').replace(/^["'`*]+|["'`*.]+$/g, '').trim()
  return bare.length > 60 ? `${bare.slice(0, 59)}…` : bare
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
  if (c !== undefined) await patch($, p => (p.hasTaskChange ? p : { ...p, hasTaskChange: true }))
  if (c !== undefined && (c.added.length > 0 || c.removed.length > 0)) {
    await patch($, p => ({ ...p, completedInTurn: applyChange(p.completedInTurn, c) }))
    // The first estimate of the turn's length, for the verdict at its end.
    const t = await $.clock.now()
    const list = await read($, tasks)
    await patch($, p => (p.predictedMs !== null ? p : { ...p, predictedMs: firstGuess(t - p.startedAt, planOf(list, p.completedInTurn)) }))
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

// Where the bar should be now: elapsed ÷ (elapsed + time left); null with no estimate.
function targetOf(est: Estimate, elapsedMs: number): number | null {
  return est.kind === 'eta' ? elapsedMs / Math.max(1, elapsedMs + est.leftMs) : null
}

// The whole turn's length by the first estimate, or null with none yet.
function firstGuess(elapsedMs: number, plan: Plan): number | null {
  const est = estimate(elapsedMs, plan)
  return est.kind === 'eta' ? elapsedMs + est.leftMs : null
}

// `hasTicked` is true once the ticker has moved the shown fill in this module's life; before that
// (and in tests, where no timer runs) the band draws the estimate itself.
const live: { hasTicked: boolean } = { hasTicked: false }

// Every TICK_MS while a turn runs: move the clock, then ease the shown fill toward the estimate.
async function startTicker($: EngineInterface): Promise<{ cancel: () => void }> {
  return $.clock.every(TICK_MS, async () => {
    try {
      const ms = await $.clock.now()
      await update($, now, () => ms)
      const list = await read($, tasks)
      await patch($, p => {
        if (!p.isRunning) return p
        const elapsedMs = Math.max(0, ms - p.startedAt)
        const est = estimate(elapsedMs, planOf(list, p.completedInTurn))
        const shownFrac = ease(p.shownFrac, targetOf(est, elapsedMs))
        return shownFrac === p.shownFrac ? p : { ...p, shownFrac }
      })
      live.hasTicked = true
    } catch {}
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

// The goal call of the latest turn, so a new turn cuts an older one.
const goalCall: { now?: { cancel: () => void; stop: AbortController } } = {}

// From a timer, so the turn never waits for it. A late answer for an older turn is dropped.
async function askGoal($: EngineInterface, turnId: string, text: string): Promise<void> {
  goalCall.now?.cancel()
  goalCall.now?.stop.abort()
  const stop = new AbortController()
  const timer = await $.clock.after(10, async () => {
    try {
      const r = await $.model.complete(
        { model: 'haiku', system: GOAL_SYSTEM, prompt: text.slice(0, 4000), maxTokens: 200, effort: 'low', timeoutMs: 15000 },
        { signal: stop.signal },
      )
      const goal = r.isAnswered ? cleanGoal(r.text) : ''
      if (goal !== '') await patch($, p => (p.turnId === turnId ? { ...p, goal } : p))
    } catch {}
  })
  goalCall.now = { cancel: timer.cancel, stop }
}

export const register: Register = on => {
  let ticker: { cancel: () => void } | undefined
  let cwd = ''

  on('session.start', async ($, e, next) => {
    cwd = e.cwd
    await $.command.register({ name: 'progress', description: 'Show or hide the task progress band' })
    try {
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

  // Learn each subagent's type, so the band colors its file by role.
  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    try {
      const id = result.agentId
      if (typeof id === 'string' && id !== '') {
        await update($, agentTypes, m => (m[id] === e.subagentType ? m : { ...m, [id]: e.subagentType }))
      }
    } catch {}
    return result
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    try {
      const t = await $.clock.now()
      const isShort = e.text.trim().length < MIN_GOAL_PROMPT
      await update($, now, () => t)
      await update($, progress, before => ({
        isRunning: true,
        startedAt: t,
        endedAt: 0,
        steps: 0,
        tools: 0,
        current: '',
        // A short reply ("yes", "go on") keeps the goal it continues.
        goal: isShort ? (before?.goal ?? '') : '',
        turnId: e.turnId,
        hasTaskChange: false,
        outcome: '',
        promptChars: e.text.length,
        predictedMs: null,
        completedInTurn: [],
        shownFrac: 0,
        file: '',
        fileVerb: '',
        fileRole: '',
        changed: [],
        advisor: 0,
      }))
      ticker?.cancel()
      ticker = await startTicker($)
      if (!isShort) await askGoal($, e.turnId, e.text)
    } catch {}
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      // Between tools nothing runs: the band shows the goal alone, not the word "Thinking".
      // The main agent's file ends with its tool: clear it too.
      await patch($, p => ({ ...p, steps: p.steps + 1, current: '', ...(p.fileRole === 'main' ? { file: '', fileVerb: '', fileRole: '' } : {}) }))
    }
    const response = yield* next(e)
    // The advisor is a server tool: it shows in the step's result, never as a tool call.
    try {
      const calls = (response.serverToolUses ?? []).filter(u => u.name === 'advisor').length
      if (calls > 0) {
        await update($, advisorSession, n => n + calls)
        await patch($, p => (p.isRunning ? { ...p, advisor: p.advisor + calls } : p))
      }
    } catch {}
    return response
  })

  on('tool.call', async ($, e, next) => {
    // Observe only: a failure here must never stop the tool.
    const args = e as unknown as Record<string, unknown>
    const raw = args.file_path ?? args.notebook_path
    const path = typeof raw === 'string' ? raw : ''
    const isFile = path !== '' && (READS.has(e.tool) || WRITES.has(e.tool))
    try {
      const role: Role = e.agentId === undefined ? 'main' : roleOf((await read($, agentTypes))[e.agentId] ?? 'worker')
      await patch($, p => ({
        ...p,
        ...(e.agentId === undefined ? { tools: p.tools + 1, current: describe(e.tool, args) } : {}),
        // The newest file tool of any agent names the file; another tool of that agent clears it.
        ...(isFile
          ? { file: path, fileVerb: READS.has(e.tool) ? 'reads' : 'edits', fileRole: role }
          : p.fileRole === role
            ? { file: '', fileVerb: '', fileRole: '' }
            : {}),
      }))
    } catch {}
    const ran = await next(e)
    try {
      if (isFile && WRITES.has(e.tool) && !failed(ran)) {
        await patch($, p => (p.changed.includes(path) ? p : { ...p, changed: [...p.changed, path].slice(-200) }))
      }
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
    // The goal call is left to finish: a short turn still shows what it was for.
    try {
      const t = await $.clock.now()
      const outcome = { answer: 'Done', aborted: 'Stopped', refusal: 'Refused', error: 'Error' }[e.reason]
      await patch($, p => ({ ...p, isRunning: false, endedAt: t, current: '', file: '', fileVerb: '', fileRole: '', outcome }))
    } catch {}
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, progress)
    if (p === null || e.props.hasSurvey || (await read($, isHidden))) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const isTerminal = e.surface === 'terminal'
    const width = Math.max(0, e.props.bodyColumns)
    const rows = e.props.maxRows
    const t = p.isRunning ? await read($, now) : p.endedAt
    const elapsedMs = Math.max(0, t - p.startedAt)
    const taskList = await read($, tasks)
    const plan = planOf(taskList, p.completedInTurn)
    // What the turn is for: the task in progress, else the model's summary of the prompt.
    // A task left in progress by an earlier turn does not hide this turn's goal.
    const goal = (p.hasTaskChange ? activeTitle(taskList) : '') || p.goal
    // Read live, so background subagents from an earlier turn count too.
    const subagents = p.isRunning
      ? (await $.agent.list()).filter(a => a.kind === 'local_agent' && a.status === 'running').length
      : 0
    const advisor = await read($, advisorSession)

    // The state, its color, and the fill.
    const est = p.isRunning ? estimate(elapsedMs, plan) : null
    const v = !p.isRunning && p.outcome === 'Done' && p.predictedMs !== null ? verdict(p.predictedMs, elapsedMs) : null
    // An estimate can vanish mid-turn (the last task done): then the bar
    // keeps its fill and its running color instead of going back to the learning sweep.
    const isLost = p.isRunning && est?.kind === 'learning' && p.shownFrac > 0
    const state: BandState = isLost
      ? 'running'
      : stateOf(p.isRunning, est?.kind === 'eta' ? 'eta' : 'learning', p.outcome, v?.color ?? null)
    const target = est === null ? null : targetOf(est, elapsedMs)
    // Running: the eased fill (the estimate itself before the first tick); null while learning.
    // Done: full. Stopped or failed: where it stood.
    const frac: number | null = p.isRunning
      ? target === null
        ? isLost
          ? p.shownFrac
          : null
        : live.hasTicked
          ? p.shownFrac
          : Math.max(p.shownFrac, target)
      : p.outcome === 'Done'
        ? 1
        : p.shownFrac
    const color = isTerminal ? STATE_NAMED[state] : STATE_HEX[state]

    // Row 1: the spinner (or the end mark) and the clock; the goal; the estimate at the right.
    const mark = p.isRunning ? (SPIN[Math.floor(elapsedMs / 250) % SPIN.length] ?? '◐') : state === 'ok' ? '✓' : state === 'over' ? '●' : '✕'
    const head = `${mark} ${clock(elapsedMs)}`
    const taskText = plan.total > 0 ? `task ${Math.min(plan.done + (p.isRunning ? 1 : 0), plan.total)} of ${plan.total}` : ''
    let eta = ''
    // No label while the estimate learns: the meter's sweep says it, and "n/5" told nobody anything.
    if (est?.kind === 'eta') eta = `~${duration(est.leftMs)} left`
    else if (est !== null) eta = ''
    else if (v !== null) eta = `est ${duration(p.predictedMs ?? 0)} ${v.text}`
    else eta = p.outcome
    const percent = p.isRunning && frac !== null && frac < 1 && est?.kind === 'eta' ? `${Math.round(frac * 100)}%` : ''

    // Row 2: what is worked on at the left; the advisor count at the right.
    // A file shows as verb, folder and name: the folder gives way first, the name stays.
    const role = (p.fileRole || 'main') as Role
    let who = ''
    let verb = ''
    let dir = ''
    let name = ''
    let left = ''
    if (p.isRunning && p.file !== '') {
      who = role
      verb = p.fileVerb
      ;({ dir, name } = splitPath(p.file, cwd))
    } else if (p.isRunning && p.current !== '') left = p.current
    else if (p.isRunning && subagents > 0) left = `${subagents} subagent${subagents === 1 ? '' : 's'} running`
    else if (p.isRunning) left = 'thinking'
    else left = p.changed.length === 0 ? 'no files changed' : `${p.changed.length} file${p.changed.length === 1 ? '' : 's'} changed`
    const advisorText = advisor > 0 ? `advisor ×${advisor}` : ''
    // One square per advisor call in this turn: the same mark as the role square at the left.
    const pips = '■'.repeat(Math.min(8, p.advisor))

    if (!isTerminal) {
      // One face and one size for every word (only weight and color change), digits of one
      // width, and one cut rule: a Text ends in "…" when its Box is too narrow, never mid-letter.
      const tx = (key: string, text: string, props: Record<string, string | boolean> = {}) => (
        <Text key={key} tabular wrap="end" maxLines={1} {...props}>
          {text}
        </Text>
      )
      // Rows 1 and 2 share one left column, so the goal and the file start at the same place.
      const gutter = (child: ReturnType<typeof tx> | false) => (
        <Box key="gutter" width={GUTTER} flexShrink={0} flexDirection="row" flexWrap="nowrap">
          {child}
        </Box>
      )
      const right: ReturnType<typeof tx>[] = []
      if (eta !== '') right.push(tx('eta', eta, { color, weight: 'semibold' }))
      if (taskText !== '') {
        if (right.length > 0) right.push(tx('dot', '·', { dimColor: true }))
        right.push(tx('task', taskText, { dimColor: true }))
      }
      if (percent !== '') right.push(tx('pct', percent, { weight: 'semibold' }))
      // Rows 1 and 2 share one right column too: the width of the wider of the two, each row's
      // text flush right in it, so "task 1 of 3" and "advisor ×1" end and start in line.
      const right1 = [eta, eta !== '' && taskText !== '' ? '·' : '', taskText, percent].filter(x => x !== '').join(' ')
      const right2 = [advisorText, pips].filter(x => x !== '').join(' ')
      const rightW = Math.max(cellWidth(right1), cellWidth(right2))
      const rightCol = (key: string, children: ReturnType<typeof tx>[] | ReturnType<typeof tx> | false) => (
        <Box key={key} width={rightW} flexShrink={0} flexDirection="row" flexWrap="nowrap" justifyContent="flex-end" alignItems="center" columnGap={1}>
          {children}
        </Box>
      )
      const cellsNow = meter(CELLS, frac, Math.floor(elapsedMs / TICK_MS))
      return (
        <Box flexDirection="column" rowGap={0}>
          <Box key="row1" flexDirection="row" flexWrap="nowrap" alignItems="center" columnGap={1}>
            {gutter(tx('head', head, { color, weight: 'bold' }))}
            <Box key="goal" flexGrow={1} flexShrink={1} minWidth={0}>
              {tx('goal', goal, { weight: 'semibold', ...(p.isRunning ? {} : { dimColor: true }) })}
            </Box>
            {rightW > 0 && rightCol('metrics', right)}
          </Box>
          <Box key="row2" flexDirection="row" flexWrap="nowrap" alignItems="center" columnGap={1}>
            {gutter(who !== '' && tx('who', `■ ${who}`, { color: ROLE_HEX[role], weight: 'semibold' }))}
            <Box key="now" flexGrow={1} flexShrink={1} minWidth={0} flexDirection="row" flexWrap="nowrap" columnGap={1}>
              {who !== '' ? (
                [
                  <Box key="verb" flexShrink={0}>{tx('verb', verb, { dimColor: true })}</Box>,
                  <Box key="path" flexShrink={1} minWidth={0} flexDirection="row" flexWrap="nowrap">
                    {dir !== '' && (
                      <Box key="dir" flexShrink={100} minWidth={0}>
                        {tx('dir', dir, { dimColor: true })}
                      </Box>
                    )}
                    <Box key="name" flexShrink={1} minWidth={0}>{tx('name', name)}</Box>
                  </Box>,
                ]
              ) : (
                <Box key="what" flexShrink={1} minWidth={0}>
                  {tx('what', left, { dimColor: true })}
                </Box>
              )}
            </Box>
            {rightW > 0 &&
              rightCol(
                'advisor',
                // One Text, so the squares sit on the count's own line.
                advisorText !== '' && (
                  <Text key="advisor" tabular wrap="end" maxLines={1} dimColor>
                    {advisorText}
                    {pips !== '' && (
                      <Text key="pips" color={ROLE_HEX.main} dimColor={false}>
                        {` ${pips}`}
                      </Text>
                    )}
                  </Text>
                ),
              )}
          </Box>
          <Box key="bar" flexDirection="row" flexWrap="nowrap" overflow="hidden" columnGap="xs">
            {cellsNow.map((c, i) => (
              <Box
                key={`c${i}`}
                width={0}
                flexGrow={1}
                flexShrink={1}
                minWidth={0}
                height={1}
                backgroundColor={c === 'on' ? STATE_HEX[state] : c === 'edge' ? `${STATE_HEX[state]}88` : TRACK_HEX}
              >
                <Text size="caption"> </Text>
              </Box>
            ))}
          </Box>
        </Box>
      )
    }

    // Terminal: monospace cells, so each row is laid out to exactly the width.
    if (rows < 2) {
      // One row: the bar sits inline, the estimate after it.
      const tailText = [eta, percent].filter(x => x !== '').join(' ')
      const tail = tailText === '' ? '' : ` ${tailText}`
      const r1 = fitRow1(width, head, '', tail, tail, '')
      const filled = frac === null ? null : bar(r1.barWidth, frac)
      const moving = frac === null ? sweep(r1.barWidth, Math.floor(elapsedMs / TICK_MS)) : null
      return (
        <Box>
          <Text color={color} weight="bold" wrap="clip">
            {r1.head}
          </Text>
          {filled !== null ? <Text color={color}>{filled.fill}</Text> : <Text dimColor>{moving?.before ?? ''}</Text>}
          {filled !== null ? <Text dimColor>{filled.empty}</Text> : <Text color={color}>{(moving?.glow ?? '').replace(/[▒▓]/g, '█')}</Text>}
          {moving !== null && <Text dimColor>{moving.after}</Text>}
          {r1.tail !== '' && <Text color={color}>{r1.tail}</Text>}
        </Box>
      )
    }

    // Rows 1 and 2 share a left column of GUTTER cells when the row has room, so the goal and
    // the file start in the same cell.
    const col = width >= GUTTER * 4 ? GUTTER + 1 : 0
    const pad = (text: string) => (col > 0 ? `${text}${' '.repeat(Math.max(1, col - cellWidth(text)))}` : `${text} `)

    // Row 1: head, goal (cut first), then the estimate, the task and the percent at the right.
    const etaT = eta
    const taskT = taskText !== '' ? `${etaT !== '' ? ' · ' : ''}${taskText}` : ''
    const pctT = percent !== '' ? ` ${percent}` : ''
    const rightCells = cellWidth(etaT) + cellWidth(taskT) + cellWidth(pctT)
    const headT = pad(head)
    const fitRight = rightCells + cellWidth(headT) <= width
    const goalT = fitRight ? fit(goal, Math.max(0, width - cellWidth(headT) - rightCells - 1)) : ''
    const space1 = fitRight ? gap(cellWidth(headT) + cellWidth(goalT), rightCells, width) : ''
    const row1 = (
      <Box key="row1">
        <Text color={color} weight="bold" wrap="clip">
          {fitRight ? headT : fit(headT, width)}
        </Text>
        {goalT !== '' && <Text weight="bold">{goalT}</Text>}
        {space1 !== '' && <Text>{space1}</Text>}
        {fitRight && etaT !== '' && <Text color={color}>{etaT}</Text>}
        {fitRight && taskT !== '' && <Text dimColor>{taskT}</Text>}
        {fitRight && pctT !== '' && <Text weight="bold">{pctT}</Text>}
      </Box>
    )

    // The bar: the full width, the state's color; while learning a block sweeps along a dim track.
    const filled = frac === null ? null : bar(width, frac)
    const moving = frac === null ? sweep(width, Math.floor(elapsedMs / TICK_MS)) : null
    const barRow = (
      <Box key="bar">
        {filled !== null ? <Text color={color}>{filled.fill}</Text> : <Text dimColor>{moving?.before ?? ''}</Text>}
        {filled !== null ? <Text dimColor>{filled.empty}</Text> : <Text color={color}>{(moving?.glow ?? '').replace(/[▒▓]/g, '█')}</Text>}
        {moving !== null && <Text dimColor>{moving.after}</Text>}
      </Box>
    )
    if (rows < 3) return <Box flexDirection="column">{row1}{barRow}</Box>

    // Row 2: what is worked on at the left (the role in its color), the advisor at the right.
    // What gives way on a narrow row: the pips, then the advisor count, then the role.
    // A path is cut at its start, so the file name stays.
    let rightT = advisorText !== '' ? `${advisorText}${pips !== '' ? ` ${pips}` : ''}` : ''
    if (cellWidth(rightT) + 12 > width) rightT = advisorText
    if (cellWidth(rightT) + 12 > width) rightT = ''
    const whoRaw = who !== '' && cellWidth(`■ ${who}`) + cellWidth(rightT) + 2 <= width ? `■ ${who}` : ''
    const whoT = whoRaw !== '' ? pad(whoRaw) : col > 0 ? ' '.repeat(col) : ''
    const room = Math.max(0, width - cellWidth(whoT) - cellWidth(rightT) - 1)
    const leftT = who !== '' ? fitPath(`${verb} `, `${dir}${name}`, room) : fit(left, room)
    const space2 = gap(cellWidth(whoT) + cellWidth(leftT), cellWidth(rightT), width)
    return (
      <Box flexDirection="column">
        {row1}
        <Box key="row2">
          {whoT !== '' && <Text color={ROLE_NAMED[role]}>{whoT}</Text>}
          <Text {...(who === '' ? { dimColor: true } : {})}>{leftT}</Text>
          <Text>{space2}</Text>
          {rightT !== '' && <Text dimColor>{rightT}</Text>}
        </Box>
        {barRow}
      </Box>
    )
  })
}
