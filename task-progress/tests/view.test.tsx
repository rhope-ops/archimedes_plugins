import { expect, test } from 'claude-code/testing'

import { bar, cells, fit, row1, row2, sweep, verdict } from '../hooks/view'

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

test('rows 1 and 2 are exactly the width, also at 40 columns and below', async () => {
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
    const r = row2(width, ' Edit: 日本語のファイル名.ts', '123 steps · 456 tools · task 12 of 15 · 3 subagents')
    expect(cells(r.left) + r.space.length + cells(r.right)).toBe(width)
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

  for (const cols of [40, 60, 100, 160]) {
    const r = await rows(cols)
    // Row 1 is every Text before the tool name; its width is the band's width.
    const i = r.findIndex(t => t.includes('Edit:'))
    expect(r.slice(0, i).join('').length).toBe(cols)
  }
  const one = await rows(100, 1)
  expect(one.join('').length).toBe(100)

  clockMs += 60_000
  await $.turn.complete({ turnId: 't6', ...END })
  const end = (await rows(100)).join('')
  expect(end).toContain('est 1m30s ✓')
  expect(end).not.toContain('off')
})

test('desktop: metrics fixed at the right, tool text cut first, bar on its own row', async ($, on) => {
  let clockMs = 0
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clockMs }))
  on('agent.list', () => ({ value: [] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run the test suite' })
  clockMs = 47_000
  const ui = await $.ui.mount({ ...BAND(120, 3), surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
  const all = texts.join(' ')
  expect(all).toContain('ETA learning 0/5')
  expect(all).toContain('Bash: Run the test suite')
  // The clock keeps its place: fixed-width digits.
  expect((await ui.find({ type: 'Text', text: /0:47/ }))?.props?.tabular).toBe(true)
  // The metrics sit at the right: one row of texts that never wrap; the tool text is cut first.
  const metrics = await ui.find({ key: 'metrics' })
  expect(metrics?.props?.flexShrink).toBe(0)
  expect((await ui.find({ type: 'Text', text: /steps · .* tools/ }))?.props?.wrap).toBe('clip')
  expect((await ui.find({ type: 'Text', text: /ETA learning 0\/5/ }))?.props?.wrap).toBe('clip')
  const tool = await ui.findAll({ type: 'Text', text: /Run the test suite/ })
  expect(tool.map(t => t.props?.maxLines)).toContain(1)
  // The bar while learning: a ░ track with the ▒▓█▓▒ glow, small monospace, cut at the row's edge.
  expect(await ui.find({ type: 'Text', text: '▒▓█▓▒' })).toBeDefined()
  const shade = await ui.findAll({ type: 'Text', text: /^░+$/ })
  expect(shade.length).toBe(2)
  expect(shade.every(t => t.props?.mono === true && t.props?.wrap === 'clip')).toBe(true)
  await ui.unmount()

  // At a narrow width the bar row clips what does not fit at its edge.
  const narrow = await $.ui.mount({ ...BAND(10, 3), surface: 'desktop' })
  expect((await narrow.find({ key: 'bar' }))?.props?.overflow).toBe('hidden')
  await narrow.unmount()
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

test('desktop bar: fill and edge at 30%, full run when done', async ($, on) => {
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
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const id of ['t1', 't2', 't3', 't4', 't5']) {
    clockMs += 1000
    await $.turn.start({ text: 'go', turnId: id })
    clockMs += 100_000
    await $.turn.complete({ turnId: id, ...END })
  }
  clockMs += 1000
  await $.turn.start({ text: 'go', turnId: 't6' })
  clockMs += 30_000
  let ui = await $.ui.mount({ ...BAND(120, 3), surface: 'desktop' })
  const fill = await ui.find({ key: 'fill' })
  expect(fill?.props?.width).toBe('30%')
  expect(fill?.props?.flexShrink).toBe(1)
  expect(await ui.find({ type: 'Text', text: '▓▒' })).toBeDefined()
  await ui.unmount()

  clockMs += 70_000
  await $.turn.complete({ turnId: 't6', ...END })
  ui = await $.ui.mount({ ...BAND(120, 3), surface: 'desktop' })
  expect((await ui.find({ key: 'fill' }))?.props?.flexGrow).toBe(1)
  expect(await ui.find({ type: 'Text', text: '▓▒' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Text', text: /^█+$/ })).every(t => t.props?.mono && t.props?.size === 'caption')).toBe(true)
  await ui.unmount()
})
