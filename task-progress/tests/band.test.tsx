import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'task-progress',
  component: 'AbovePrompt',
  props: { hasSurvey: false },
} as const

test('the band shows the running tool, then the outcome', async ($, on) => {
  on('command.register', () => ({ value: { command: 'progress' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('clock.every', () => ({ value: { cancel: () => {} } }))
  on('clock.now', () => ({ value: 1_000 }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', description: 'Run tests' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect((await ui.find({ type: 'Text', text: /Run tests/ }))?.text).toBe(' Bash: Run tests')
    expect(await ui.find({ type: 'Text', text: /1 tools/ })).toBeDefined()
    await ui.unmount()
  }

  await $.turn.complete({ turnId: 't1', reason: 'answer' })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Done/ }))?.text).toBe('● Done')
  await ui.unmount()
})
