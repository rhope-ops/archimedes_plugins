import { expect, test } from 'claude-code/testing'

test('no status line until the advisor is used, then a short one', async ($, on) => {
  const statuses: (string | undefined)[] = []
  const store = new Map<string, unknown>()
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', (_, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(statuses.filter(s => s !== undefined)).toEqual([])
})

test('after an advisor call: a toast and a short status', async ($, on) => {
  const statuses: (string | undefined)[] = []
  const toasts: string[] = []
  const store = new Map<string, unknown>()
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.status', (_, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.toast', (_, e) => (toasts.push(e.text), { value: undefined }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => (store.set(e.key, e.value), { value: undefined }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      serverToolUses: [{ id: 'a1', name: 'advisor', input: {}, startedAt: 0, endedAt: 1 }],
      stopReason: 'end_turn',
      usage: null,
    }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-sonnet-5-5', messageCount: 1 })) {
    // drain the stream
  }
  expect(statuses.at(-1)).toBe('advisor ×1')
  expect(toasts[0]).toContain('sonnet')
  expect(store.get('advisor-total')).toBe(1)
})
