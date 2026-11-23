import { expect, test } from 'claude-code/testing'

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
