import { expect, test } from 'claude-code/testing'

import { GUTTER, ROLE_HEX, STATE_HEX, bar, cells, ease, fit, fitPath, meter, roleOf, row1, shortPath, splitPath, stateOf, sweep, verdict } from '../hooks/view'

// The test runner has timers; the mod's own types do not declare them.
declare const setTimeout: (fn: (v?: unknown) => void, ms: number) => unknown

test('the bar fills in eighth steps and keeps its width', async () => {
  expect(bar(10, 0)).toEqual({ fill: '', empty: '░░░░░░░░░░' })
  expect(bar(10, 1)).toEqual({ fill: '██████████', empty: '' })
  const half = bar(10, 0.55)
  expect(half.fill).toBe('█████▌')
  expect(half.fill.length + half.empty.length).toBe(10)
  for (const f of [0.01, 0.33, 0.5, 0.99]) {
    const b = bar(37, f)
    expect(b.fill.length + b.empty.length).toBe(37)
  }
})

test('the sweep moves and keeps its width', async () => {
  const a = sweep(20, 0)
  const b = sweep(20, 3)
  expect(a.before.length + a.glow.length + a.after.length).toBe(20)
  expect(b.before.length).toBe(3)
  expect(sweep(20, 16).before.length).toBe(0)
})

test('fit counts terminal cells and never cuts a character', async () => {
  expect(fit('abcdef', 4)).toBe('abc…')
  expect(fit('abc', 4)).toBe('abc')
  expect(cells('日本語')).toBe(6)
  expect(cells('a🙂b')).toBe(4)
  expect(cells(fit('Edit: 日本語のファイル名.ts', 12))).toBeLessThanOrEqual(12)
  expect(fit('🙂🙂🙂', 4)).toBe('🙂…')
})

test('row 1 (one-row band) is exactly the width, also at 40 columns and below', async () => {
  const cases = [
    ['◐ 1:23', ' 45%', ' ~1m30s left (by tasks)', ' ~1m30s', ''],
    ['● Done 1:23', '', ' est 1m30s 2.0× slower', ' 2.0× slower', ''],
    ['◐ 1:02:03', ' 45%', ' ETA learning 3/5', ' 3/5', ' Edit: /a/very/long/path/to/a/file.ts'],
  ] as const
  for (const width of [20, 30, 40, 60, 100]) {
    for (const [head, pct, tail, short, inline] of cases) {
      const r = row1(width, head, pct, tail, short, inline)
      expect(cells(r.head) + r.barWidth + cells(r.pct) + cells(r.tail) + cells(r.inline)).toBe(width)
    }
  }
  // At 40 columns the percent and "(by tasks)" give way, and the bar keeps 8 cells or more.
  const r = row1(40, '◐ 1:23', ' 45%', ' ~1m30s left (by tasks)', ' ~1m30s', '')
  expect(r.pct).toBe('')
  expect(r.barWidth).toBeGreaterThanOrEqual(8)
})

const BAND = (bodyColumns: number, maxRows: number) =>
  ({
    plugin: 'task-progress',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: true,
      maxRows,
      bodyColumns,
      scroll: { offset: 0, bodyRows: maxRows },
      view: {},
    },
  }) as const

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>

// An engine stand-in: a settable clock, a store, and a turn.step that can report advisor calls.
function engine(on: Parameters<Body>[1], clock: { ms: number }, advisorCalls: { n: number }, hasTools = true) {
  const store = new Map<string, unknown>()
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  if (hasTools) on('tool.call', () => ({ result: {} }))
  on('agent.spawn', () => ({ agentId: 'w1', model: 'sonnet' }) as never)
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.ms }))
  on('agent.list', () => ({ value: [] }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('turn.step', async function* (_, e) {
    const n = advisorCalls.n
    advisorCalls.n = 0
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      serverToolUses: Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: 'advisor', input: {}, startedAt: 0, endedAt: 1 })),
      stopReason: 'end_turn',
      usage: null,
    }
  })
}

const END = { reason: 'answer', answer: '', durationMs: 1, isAborted: false } as const

// Task tools that answer as the real ones do, so a task list drives the estimate.
function taskTools(on: Parameters<Body>[1]) {
  let next = 0
  on('tool.call', (_, e) => {
    const a = e as unknown as Record<string, unknown>
    if (e.tool === 'TaskCreate') return { result: { task: { id: String(++next), subject: String(a.subject) } } }
    if (e.tool === 'TaskUpdate') return { result: { success: true, taskId: String(a.taskId), updatedFields: [] } }
    return { result: {} }
  })
}

// `n` new tasks; the first `done` of them completed at `atMs`.
async function plan($: Parameters<Body>[0], clock: { ms: number }, n: number, done: number, atMs: number) {
  for (let i = 0; i < n; i++) await $.tool.call({ tool: 'TaskCreate', subject: `t${i}`, description: `t${i}` })
  clock.ms = atMs
  for (let i = 1; i <= done; i++) await $.tool.call({ tool: 'TaskUpdate', taskId: String(i), status: 'completed' })
}

test('terminal: 3 rows, each exactly the width, in each state', async ($, on) => {
  const clock = { ms: 0 }
  engine(on, clock, { n: 0 }, false)
  taskTools(on)
  const rows = async (cols: number) => {
    const ui = await $.ui.mount({ ...BAND(cols, 3), surface: 'terminal' })
    const r = await Promise.all(['row1', 'row2', 'bar'].map(async key => (await ui.find({ key }))?.text ?? ''))
    await ui.unmount()
    return r
  }
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't0' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the test suite' })
  clock.ms = 7_000
  expect((await rows(100))[0]).not.toContain('learning')
  await $.turn.complete({ turnId: 't0', ...END })

  // 3 tasks, 1 done at 30 s: 60 s left, so the first estimate of the turn is 1m30s.
  clock.ms = 100_000
  await $.turn.start({ text: 'go', turnId: 't6' })
  await plan($, clock, 3, 1, 130_000)
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' })
  for (const cols of [40, 60, 100, 160]) {
    const r = await rows(cols)
    for (const row of r) expect(cells(row)).toBe(cols)
    expect(r[1]).toMatch(/■ main +edits src\/app\.ts/)
    // From 44 columns, row 2's text starts in the same cell as row 1's goal (after the gutter).
    if (cols >= 44) expect((r[1] ?? '').indexOf('edits')).toBe(12)
  }

  clock.ms += 60_000
  await $.turn.complete({ turnId: 't6', ...END })
  const end = await rows(100)
  expect(end[0]).toContain('est 1m30s ✓')
  // Review fix: at every width, each row is exactly that wide (no off-by-one at the column edges).
  for (let cols = 20; cols <= 120; cols++) for (const row of await rows(cols)) expect(`${cols}:${cells(row)}:${row}`).toBe(`${cols}:${cols}:${row}`)
  expect(end[1]).toContain('1 file changed')
  expect(end[2]).toBe('█'.repeat(100))
})

test('desktop: 3 rows; estimate at the right, then file and advisor, then the cell meter', async ($, on) => {
  const clock = { ms: 0 }
  const advisorCalls = { n: 0 }
  engine(on, clock, advisorCalls)
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the test suite' })
  clock.ms = 47_000
  let ui = await $.ui.mount({ ...BAND(120, 3), surface: 'desktop' })
  expect((await ui.find({ key: 'row1' }))?.text).not.toContain('learning')
  expect((await ui.find({ type: 'Text', text: /0:47/ }))?.props?.tabular).toBe(true)
  // Nothing at the right while the estimate learns: no empty box either.
  expect(await ui.find({ key: 'metrics' })).toBeUndefined()
  expect((await ui.find({ key: 'row2' }))?.text).toContain('Bash: Run the test suite')
  // No advisor call yet: no advisor text.
  expect((await ui.find({ key: 'advisor' }))).toBeUndefined()
  // Learning: 40 cells, 6 of them lit in the learning color; the rest the track.
  const cellsNow = (await ui.findAll({ type: 'Box' })).filter(b => /^c\d+$/.test(b.key ?? ''))
  expect(cellsNow.length).toBe(40)
  expect(cellsNow.filter(c => c.props.backgroundColor === STATE_HEX.learning).length).toBeLessThanOrEqual(6)
  expect((await ui.find({ key: 'bar' }))?.props?.overflow).toBe('hidden')
  await ui.unmount()

  // A subagent's file: its role and color on row 2. Two advisor calls: count and pips.
  await $.agent.spawn({ tool_use_id: 'x', prompt: 'p', description: 'd', subagentType: 'code-reviewer' } as never)
  await $.tool.call({ tool: 'Read', file_path: '/repo/hooks/view.ts', agentId: 'w1' } as never)
  advisorCalls.n = 2
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 })) {
    // drain the stream
  }
  ui = await $.ui.mount({ ...BAND(120, 3), surface: 'desktop' })
  const row2 = await ui.find({ key: 'row2' })
  expect(row2?.text).toContain('reviewer')
  // Verb, folder and name in their own Texts: the folder gives way first, the name stays.
  expect((await ui.find({ key: 'verb' }))?.text).toBe('reads')
  expect((await ui.find({ key: 'dir' }))?.text).toBe('hooks/')
  expect((await ui.find({ key: 'name' }))?.text).toBe('view.ts')
  // The folder gives way long before the name (which still ends in "…" as a last resort).
  expect(Number((await ui.find({ key: 'dir' }))?.props?.flexShrink)).toBeGreaterThan(Number((await ui.find({ key: 'name' }))?.props?.flexShrink))
  // The role label never shrinks: it sits in the fixed left column, the same width as the clock's.
  const gutters = (await ui.findAll({ type: 'Box' })).filter(b => b.key === 'gutter')
  expect(gutters.length).toBe(2)
  for (const g of gutters) expect(g.props.minWidth).toBe(GUTTER)
  // One face and one size: no Text of rows 1 and 2 sets a size or the monospaced face
  // (the meter's blank cells are the only Texts with a size).
  for (const t of (await ui.findAll({ type: 'Text' })).filter(t => t.text !== ' ')) {
    expect(t.props.size).toBeUndefined()
    expect(t.props.mono).toBeUndefined()
  }
  expect((await ui.find({ type: 'Text', text: /reviewer/ }))?.props?.color).toBe(ROLE_HEX.reviewer)
  expect((await ui.find({ key: 'advisor' }))?.text).toContain('advisor ×2')
  expect((await ui.find({ key: 'advisor' }))?.text).toContain('■■')
  // The right column has one width on rows 1 and 2, flush right.
  const cols = (await ui.findAll({ type: 'Box' })).filter(b => b.key === 'metrics' || b.key === 'advisor')
  expect(cols.length).toBe(2)
  expect(cols[0]?.props.minWidth).toBe(cols[1]?.props.minWidth)
  for (const c of cols) expect(c.props.justifyContent).toBe('flex-end')
  await ui.unmount()
})

test('desktop meter: 30% lights 12 of 40 cells in blue; done lights all in green; same cells always', async ($, on) => {
  const clock = { ms: 0 }
  engine(on, clock, { n: 0 }, false)
  taskTools(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // 10 tasks, 3 done at 30 s: 70 s left, so 30% of the turn.
  await $.turn.start({ text: 'go', turnId: 't6' })
  await plan($, clock, 10, 3, 30_000)
  const lit = async () => {
    const ui = await $.ui.mount({ ...BAND(120, 3), surface: 'desktop' })
    const cs = (await ui.findAll({ type: 'Box' })).filter(b => /^c\d+$/.test(b.key ?? ''))
    await ui.unmount()
    return cs.map(c => String(c.props.backgroundColor))
  }
  // The fill eases up to 30% (12 cells) and never goes back on the way.
  let cs = await lit()
  let lit12 = 0
  for (let i = 0; i < 40; i++) {
    expect(cs.length).toBe(40)
    const n = cs.filter(c => c === STATE_HEX.running).length
    expect(n).toBeGreaterThanOrEqual(lit12)
    lit12 = n
    if (n === 12) break
    await new Promise(r => setTimeout(r, 100))
    cs = await lit()
  }
  expect(lit12).toBe(12)

  // The verdict compares the first estimate (after task 1: 30 s × 10 = 5m) with the real time.
  clock.ms = 300_000
  await $.turn.complete({ turnId: 't6', ...END })
  cs = await lit()
  expect(cs.length).toBe(40)
  expect(cs.every(c => c === STATE_HEX.ok)).toBe(true)
})

test('a stopped turn: red, the bar keeps its cells', async ($, on) => {
  const clock = { ms: 0 }
  engine(on, clock, { n: 0 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  clock.ms = 5_000
  await $.turn.complete({ turnId: 't1', reason: 'aborted', answer: '', durationMs: 1, isAborted: true })
  const ui = await $.ui.mount({ ...BAND(120, 3), surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /✕/ }))?.props?.color).toBe(STATE_HEX.fail)
  expect((await ui.findAll({ type: 'Box' })).filter(b => /^c\d+$/.test(b.key ?? '')).length).toBe(40)
  await ui.unmount()
})

test('state for each case, one color each', async () => {
  expect(stateOf(true, 'learning', '', null)).toBe('learning')
  expect(stateOf(true, 'eta', '', null)).toBe('running')
  expect(stateOf(true, 'over', '', null)).toBe('over')
  expect(stateOf(false, 'eta', 'Done', 'success')).toBe('ok')
  expect(stateOf(false, 'eta', 'Done', null)).toBe('ok')
  expect(stateOf(false, 'eta', 'Done', 'warning')).toBe('over')
  expect(stateOf(false, 'eta', 'Done', 'error')).toBe('over')
  expect(stateOf(false, 'eta', 'Stopped', null)).toBe('fail')
  expect(new Set(Object.values(STATE_HEX)).size).toBe(5)
  for (const c of Object.values(ROLE_HEX)) expect(Object.values(STATE_HEX)).not.toContain(c)
})

test('ease: moves toward the target, never back, and rests on it', async () => {
  expect(Math.abs(ease(0, 0.5) - 0.1)).toBeLessThan(1e-9)
  expect(ease(0.5, 0.2)).toBe(0.5)
  expect(ease(0.4, null)).toBe(0.4)
  expect(ease(0.498, 0.5)).toBe(0.5)
  expect(Math.abs(ease(0.9, 2) - 0.92)).toBeLessThan(1e-9)
  let s = 0
  for (let i = 0; i < 60; i++) {
    const next = ease(s, 0.7)
    expect(next).toBeGreaterThanOrEqual(s)
    s = next
  }
  expect(s).toBe(0.7)
})

test('meter: cells on, edge and off; the learning block sweeps', async () => {
  expect(meter(40, 0.3, 0).filter(c => c === 'on').length).toBe(12)
  expect(meter(10, 0.55, 0)).toEqual(['on', 'on', 'on', 'on', 'on', 'edge', 'off', 'off', 'off', 'off'])
  expect(meter(10, 1, 0).every(c => c === 'on')).toBe(true)
  expect(meter(10, 0, 0).every(c => c === 'off')).toBe(true)
  const a = meter(20, null, 6)
  const b = meter(20, null, 7)
  expect(a.filter(c => c === 'on').length).toBe(6)
  expect(a.indexOf('on') + 1).toBe(b.indexOf('on'))
})

test('roles by agent type, and short paths', async () => {
  expect(roleOf(undefined)).toBe('main')
  expect(roleOf('general-purpose')).toBe('worker')
  expect(roleOf('code-reviewer')).toBe('reviewer')
  expect(roleOf('Explore')).toBe('explore')
  expect(roleOf('Plan')).toBe('explore')
  expect(shortPath('/repo/src/app.ts', '/repo')).toBe('src/app.ts')
  expect(shortPath('/other/a/b/c/d.ts', '/repo')).toBe('…/b/c/d.ts')
  expect(shortPath('/x/y.ts', '/')).toBe('/x/y.ts')
  // A subagent's worktree is cut off: the repo path shows.
  expect(shortPath('/Users/u/s-2026-11-26T17-90-161.Z/.claude/worktrees/agent-a1/src/app.ts', '/repo')).toBe('src/app.ts')
  expect(splitPath('/repo/src/ui/app.ts', '/repo')).toEqual({ dir: 'src/ui/', name: 'app.ts' })
  expect(splitPath('/repo/app.ts', '/repo')).toEqual({ dir: '', name: 'app.ts' })
  // The terminal cuts a long path at its start and keeps the file name.
  expect(fitPath('reads ', 'src/components/very/deep/app.ts', 20)).toBe('reads …/deep/app.ts')
  expect(fitPath('reads ', 'src/app.ts', 40)).toBe('reads src/app.ts')
})

test('the estimate verdict', async () => {
  expect(verdict(95_000, 8_000)).toEqual({ text: '12× faster', color: 'error' })
  expect(verdict(60_000, 100_000)).toEqual({ text: '1.7× slower', color: 'warning' })
  expect(verdict(60_000, 70_000)).toEqual({ text: '✓', color: 'success' })
})

test('the ✓ band is symmetric: max / min ≤ 1.25 in either direction', async () => {
  expect(verdict(80_000, 100_000)).toEqual({ text: '✓', color: 'success' })
  expect(verdict(100_000, 80_000)).toEqual({ text: '✓', color: 'success' })
  // 75 s against 100 s is 1.33× both ways: the same verdict in each direction.
  expect(verdict(75_000, 100_000)).toEqual({ text: '1.3× slower', color: 'warning' })
  expect(verdict(100_000, 75_000)).toEqual({ text: '1.3× faster', color: 'warning' })
})

test('the verdict color matches the shown, rounded number', async () => {
  // 2.04× shows "2.0×", so it is yellow, not red.
  expect(verdict(100_000, 204_000)).toEqual({ text: '2.0× slower', color: 'warning' })
  expect(verdict(204_000, 100_000)).toEqual({ text: '2.0× faster', color: 'warning' })
  expect(verdict(100_000, 210_000)).toEqual({ text: '2.1× slower', color: 'error' })
})

test('review fix: the bar keeps its fill when the estimate goes away mid-turn', async ($, on) => {
  const clock = { ms: 0 }
  engine(on, clock, { n: 0 }, false)
  taskTools(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'a', description: 'a' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'b', description: 'b' })
  clock.ms = 30_000
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  // Let the ticker ease the fill up toward 50%.
  await new Promise(r => setTimeout(r, 1200))
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'completed' })
  const ui = await $.ui.mount({ ...BAND(120, 3), surface: 'desktop' })
  expect((await ui.find({ key: 'row1' }))?.text).not.toContain('learning')
  const cs = (await ui.findAll({ type: 'Box' })).filter(b => /^c\d+$/.test(b.key ?? ''))
  expect(cs.filter(c => c.props.backgroundColor === STATE_HEX.running).length).toBeGreaterThan(6)
  await ui.unmount()
})
