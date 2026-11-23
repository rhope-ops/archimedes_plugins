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
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Run tests/ }))?.text).toBe(' Bash: Run tests')
    expect((await ui.find({ type: 'Text', text: /learning/ }))?.text).toBe(' ETA learning 0/5')
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
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /left/ }))?.text).toBe(' ~40s left')
  await ui.unmount()

  // At the end the band compares the first estimate with the real time.
  clockMs += 40_000
  await $.turn.complete({ turnId: 't6', ...DONE })
  const end = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await end.find({ type: 'Text', text: /estimate was/ }))?.text).toContain('estimate was 1m (off 0%)')
  await end.unmount()
})

test('a task list drives the ETA', async ($, on) => {
  let clockMs = 0
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clockMs }))
  on('agent.list', () => ({ value: [] }))
  on('store.get', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'build it', turnId: 't1' })
  for (const s of ['a', 'b', 'c', 'd']) {
    await $.tool.call({ tool: 'TaskCreate', subject: s, description: s })
  }
  clockMs = 30_000
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // 30 s for 1 task, 3 tasks left: 90 s.
  expect((await ui.find({ type: 'Text', text: /left/ }))?.text).toBe(' ~2m left (by tasks)')
  expect(await ui.find({ type: 'Text', text: /task 2 of 4/ })).toBeDefined()
  await ui.unmount()
})
