import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'file-tree',
  component: 'Pane',
  requestId: 'file-tree',
  props: {
    title: 'Files',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

test('a read, an edit and a commit show their states', async ($, on) => {
  on('command.register', () => ({ value: { command: 'files' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/b.ts', old_string: 'x', new_string: 'y' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /a\.ts/ }))?.text).toBe('○ a.ts')
    expect((await ui.find({ type: 'Text', text: /b\.ts/ }))?.text).toBe('● b.ts')
    await ui.unmount()
  }

  await $.tool.call({ tool: 'Bash', command: 'git commit -m "x"' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /b\.ts/ }))?.text).toBe('✔ b.ts')
  expect((await ui.find({ type: 'Text', text: /a\.ts/ }))?.text).toBe('○ a.ts')
  await ui.unmount()
})
