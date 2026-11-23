import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'task-progress',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: true,
    maxRows: 3,
    bodyColumns: 80,
    scroll: { offset: 0, bodyRows: 3 },
    view: {},
  },
} as const

const DONE = { reason: 'answer', answer: '', durationMs: 1000, isAborted: false } as const

test('the band shows the running tool, learns, then shows an ETA', async ($, on) => {
  let clockMs = 0
  const store = new Map<string, unknown>()
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clockMs }))
  on('agent.list', () => ({ value: [] }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // First turn: no history yet.
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run tests' })
  {
    const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /Run tests/ }))?.text?.trim()).toBe('Bash: Run tests')
    expect((await ui.find({ type: 'Text', text: /learning/ }))?.text?.trim()).toBe('ETA learning 0/5')
    await ui.unmount()
  }
  {
    // Desktop: one row; the bar's label carries the tool and the counts, its value the estimate.
    const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
    const all = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join(' ')
    expect(all).toContain('Bash: Run tests')
    expect(all).toContain('0 steps · 1 tools')
    expect(all).toContain('ETA learning 0/5')
    await ui.unmount()
  }
  clockMs = 60_000
  await $.turn.complete({ turnId: 't1', ...DONE })

  // Four more 60 s turns: 5 in all.
  for (const id of ['t2', 't3', 't4', 't5']) {
    clockMs += 1000
    await $.turn.start({ text: 'go', turnId: id })
    clockMs += 60_000
    await $.turn.complete({ turnId: id, ...DONE })
  }
  expect((store.get('history-v1') as unknown[]).length).toBe(5)

  // Sixth turn, 20 s in: the typical 60 s turn leaves 40 s.
  clockMs += 1000
  await $.turn.start({ text: 'go', turnId: 't6' })
  clockMs += 20_000
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /left/ }))?.text?.trim()).toBe('~40s left')
  await ui.unmount()

  // At the end the band compares the first estimate with the real time.
  clockMs += 40_000
  await $.turn.complete({ turnId: 't6', ...DONE })
  const end = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const verdictText = await end.find({ type: 'Text', text: /est 1m/ })
  expect(verdictText?.text).toContain('est 1m ✓')
  expect(verdictText?.props?.color).toBe('green')
  await end.unmount()
})

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
type Status = 'pending' | 'in_progress' | 'completed' | 'deleted'

// An engine stand-in whose task tools answer as the real ones do.
function taskEngine(on: Parameters<Body>[1], clock: { ms: number }) {
  let nextId = 0
  const known = new Set<string>()
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.ms }))
  on('agent.list', () => ({ value: [] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('tool.call', (_, e) => {
    const a = e as unknown as Record<string, unknown>
    if (e.tool === 'TaskCreate') {
      const id = String(++nextId)
      known.add(id)
      return { result: { task: { id, subject: String(a.subject) } } }
    }
    if (e.tool === 'TaskUpdate') {
      const ok = known.has(String(a.taskId))
      return { result: { success: ok, taskId: String(a.taskId), updatedFields: [] } }
    }
    if (e.tool === 'TodoWrite') return { result: { oldTodos: [], newTodos: a.todos } }
    return { result: {} }
  })
}

async function band($: Parameters<Body>[0]) {
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  const eta = (await ui.find({ type: 'Text', text: /left|learning|longer/ }))?.text?.trim()
  const step = (await ui.find({ type: 'Text', text: /steps/ }))?.text ?? ''
  await ui.unmount()
  return { eta, step }
}

const create = (s: string) => ({ tool: 'TaskCreate', subject: s, description: s }) as const
const set = (taskId: string, status: Status) => ({ tool: 'TaskUpdate', taskId, status }) as const
const END = { reason: 'answer', answer: '', durationMs: 1, isAborted: false } as const

test('a task list drives the ETA', async ($, on) => {
  const clock = { ms: 0 }
  taskEngine(on, clock)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  for (const s of ['a', 'b', 'c', 'd']) await $.tool.call(create(s))
  clock.ms = 30_000
  await $.tool.call(set('1', 'completed'))
  // 30 s for 1 task, 3 tasks left: 90 s.
  const b = await band($)
  expect(b.eta).toBe('~1m30s left (by tasks)')
  expect(b.step).toContain('task 2 of 4')
})

test('a new list in a later turn still drives the ETA', async ($, on) => {
  const clock = { ms: 0 }
  taskEngine(on, clock)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'one', turnId: 't1' })
  await $.tool.call(create('a'))
  await $.tool.call(create('b'))
  await $.tool.call(set('1', 'completed'))
  await $.tool.call(set('2', 'completed'))
  await $.turn.complete({ turnId: 't1', ...END })

  clock.ms = 100_000
  await $.turn.start({ text: 'two', turnId: 't2' })
  for (const s of ['c', 'd', 'e']) await $.tool.call(create(s))
  clock.ms = 120_000
  await $.tool.call(set('5', 'completed'))
  // 20 s for 1 task of the new list, 2 left: 40 s.
  const b = await band($)
  expect(b.eta).toBe('~40s left (by tasks)')
  expect(b.step).toContain('task 2 of 3')
})

test('TodoWrite replaces the list, and a new list counts in its own turn', async ($, on) => {
  const clock = { ms: 0 }
  taskEngine(on, clock)
  const todo = (done: number, all: number) => ({
    tool: 'TodoWrite' as const,
    todos: Array.from({ length: all }, (_, i) => ({
      content: `step ${i}`,
      status: (i < done ? 'completed' : 'pending') as 'completed' | 'pending',
      activeForm: `doing ${i}`,
    })),
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'one', turnId: 't1' })
  await $.tool.call(todo(4, 4))
  await $.turn.complete({ turnId: 't1', ...END })

  clock.ms = 50_000
  await $.turn.start({ text: 'two', turnId: 't2' })
  await $.tool.call(todo(0, 3))
  clock.ms = 60_000
  await $.tool.call(todo(1, 3))
  // 10 s for 1 task, 2 left: 20 s.
  expect((await band($)).eta).toBe('~20s left (by tasks)')
})

test('a reopened task, an unknown id and a failed update count for nothing', async ($, on) => {
  const clock = { ms: 0 }
  taskEngine(on, clock)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  for (const s of ['a', 'b', 'c']) await $.tool.call(create(s))
  clock.ms = 30_000
  await $.tool.call(set('1', 'completed'))
  await $.tool.call(set('1', 'in_progress'))
  await $.tool.call(set('99', 'deleted'))
  await $.tool.call(set('98', 'completed'))
  const b = await band($)
  // 0 done, 3 tasks: no estimate by tasks yet.
  expect(b.eta).toBe('ETA learning 0/5')
  expect(b.step).toContain('task 1 of 3')
})

test('parallel task calls lose no update', async ($, on) => {
  const clock = { ms: 0 }
  taskEngine(on, clock)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await Promise.all(['a', 'b', 'c', 'd'].map(s => $.tool.call(create(s))))
  clock.ms = 20_000
  await Promise.all([$.tool.call(set('1', 'completed')), $.tool.call(set('2', 'completed'))])
  const b = await band($)
  // 20 s for 2 tasks, 2 left: 20 s.
  expect(b.step).toContain('task 3 of 4')
  expect(b.eta).toBe('~20s left (by tasks)')
})

test('todos with the same text stay separate tasks', async ($, on) => {
  const clock = { ms: 0 }
  taskEngine(on, clock)
  const todos = (done: number) => ({
    tool: 'TodoWrite' as const,
    todos: [0, 1, 2, 3].map(i => ({
      content: 'run tests',
      status: (i < done ? 'completed' : 'pending') as 'completed' | 'pending',
      activeForm: 'running tests',
    })),
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call(todos(0))
  clock.ms = 20_000
  await $.tool.call(todos(2))
  // 10 s per task, 2 left: 20 s.
  expect((await band($)).eta).toBe('~20s left (by tasks)')
})
