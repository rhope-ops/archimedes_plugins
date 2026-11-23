import { expect, test } from 'claude-code/testing'
import { tokensText } from '../hooks/pricing'

const PANE = {
  plugin: 'agents-pane',
  component: 'Pane',
  requestId: 'agents-pane',
  props: { title: 'Subagents', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const usage = (model: string, input: number, output: number) => ({
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 500,
})

test('cards show the /cost estimate and the tokens; running first', async ($, on) => {
  const now = Date.now()
  const agent = (id: string, status: string, usd: number, description: string) => ({
    id,
    description,
    type: 'worker',
    status,
    kind: 'local_agent',
    taskStatus: status === 'running' ? 'running' : 'completed',
    label: status === 'running' ? 'Editing scripts/token_log.py' : description,
    startTime: now - 95_000,
    cwd: '/',
    model: 'claude-sonnet-5-5',
    tokenCount: 0,
    tokenSamples: [],
    usage: [usage('claude-sonnet-5-5', 2000, 3000)],
    cost: { usd },
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('agent.list', () => ({
    // Sample agents: only the fields the pane reads.
    value: [agent('a1', 'completed', 0.004, 'Find files'), agent('a2', 'running', 1.234, 'Fix token log')] as never,
  }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('\n')
    expect(texts).toContain('1 running · 1 finished')
    // The total is the sum of the /cost estimates: 1.234 + 0.004.
    expect(texts).toContain('$1.24')
    expect(texts).toContain('$1.23')
    expect(texts).toContain('<$0.01')
    // 2,000 + 3,000 + 1,000 + 500 tokens per agent.
    expect(texts).toContain('6.5k tok')
    expect(texts).toContain('Editing scripts/token_log.py')
    expect(texts).toContain('estimate, as /cost')
    expect(texts.indexOf('Fix token log')).toBeLessThan(texts.indexOf('Find files'))
    await ui.unmount()
  }
})

// A sample running agent with only the fields the pane reads; `usd` undefined means no cost yet.
const live = (id: string, usd: number | undefined, startTime: number) => ({
  id,
  description: `Task ${id}`,
  type: 'worker',
  status: 'running',
  kind: 'local_agent',
  taskStatus: 'running',
  label: `Task ${id}`,
  startTime,
  cwd: '/',
  model: 'claude-sonnet-5-5',
  tokenCount: 0,
  tokenSamples: [],
  usage: [usage('claude-sonnet-5-5', 2000, 3000)],
  ...(usd === undefined ? {} : { cost: { usd } }),
})

test("over the room for cards, a '+N more active' line counts the rest", async ($, on) => {
  const paneTexts = async (surface: 'desktop' | 'terminal') => {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
    await ui.unmount()
    return texts
  }
  const now = Date.now()
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  // 8 running agents; the default view (30 rows) has room for 6 cards.
  on('agent.list', () => ({ value: Array.from({ length: 8 }, (_, i) => live(`a${i}`, 0.5, now - i * 1000)) as never }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    const texts = await paneTexts(surface)
    expect(texts.join('\n')).toContain('8 running · 0 finished')
    expect(texts.map(t => t.trim())).toContain('+2 more active')
    // The newest 6 get cards; the 2 oldest are in the count only.
    expect(texts).toContain('Task a5')
    expect(texts).not.toContain('Task a6')
  }
})

test("no '+' after the total before any agent has a cost; a '+' when some have none yet", async ($, on) => {
  const paneTexts = async (surface: 'desktop' | 'terminal') => {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
    await ui.unmount()
    return texts
  }
  const now = Date.now()
  let agents = [live('a1', undefined, now), live('a2', undefined, now - 1000)]
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('agent.list', () => ({ value: agents as never }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['desktop', 'terminal'] as const) {
    // The header total is the text right after the "N running · M finished" text.
    const total = (texts: string[]) => texts[texts.findIndex(t => /running ·/.test(t)) + 1]
    agents = [live('a1', undefined, now), live('a2', undefined, now - 1000)]
    expect(total(await paneTexts(surface))).toBe('$–')
    agents = [live('a1', 1.234, now), live('a2', undefined, now - 1000)]
    expect(total(await paneTexts(surface))).toBe('$1.23+')
    agents = [live('a1', 1.234, now), live('a2', 0.5, now - 1000)]
    expect(total(await paneTexts(surface))).toBe('$1.73')
  }
})

test('helpers: token rounding', async () => {
  expect(tokensText(999_950)).toBe('1.0M')
  expect(tokensText(99_960)).toBe('100k')
  expect(tokensText(1_500)).toBe('1.5k')
})
