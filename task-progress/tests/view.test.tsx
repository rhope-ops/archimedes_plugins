import { expect, test } from 'claude-code/testing'

import { bar, fit, gap, sweep } from '../hooks/view'

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

test('fit and gap', async () => {
  expect(fit('abcdef', 4)).toBe('abc…')
  expect(fit('abc', 4)).toBe('abc')
  expect(gap(10, 5, 20).length).toBe(5)
  expect(gap(30, 5, 20).length).toBe(1)
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

test('row 1 fills the width in each state', async ($, on) => {
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
  const END = { reason: 'answer', answer: '', durationMs: 1, isAborted: false } as const

  const rows = async (cols: number, maxRows = 3) => {
    const ui = await $.ui.mount({ ...BAND(cols, maxRows), surface: 'terminal' })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
    await ui.unmount()
    return texts
  }

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't0' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the test suite' })
  clockMs = 7_000
  const learning = await rows(100)
  expect(learning.join('')).toContain('ETA learning 0/5')

  for (const id of ['t1', 't2', 't3', 't4', 't5']) {
    await $.turn.complete({ turnId: id === 't1' ? 't0' : id, ...END })
    clockMs += 1000
    await $.turn.start({ text: 'go', turnId: id })
    clockMs += 90_000
  }
  await $.turn.complete({ turnId: 't5', ...END })
  clockMs += 1000
  await $.turn.start({ text: 'go', turnId: 't6' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b' })
  clockMs += 30_000

  for (const cols of [60, 100, 160]) {
    const r = await rows(cols)
    // Row 1 is every Text before the tool name; its width is the band's width.
    const i = r.findIndex(t => t.includes('Edit:'))
    expect(r.slice(0, i).join('').length).toBe(cols)
  }
  const one = await rows(100, 1)
  expect(one.join('').length).toBe(100)

  clockMs += 60_000
  await $.turn.complete({ turnId: 't6', ...END })
  expect((await rows(100)).join('')).toContain('estimate was 1m30s (off 0%)')
})
