import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Touched } from '../types'

const PANE = 'file-tree'
// Change the tag when Touched's fields change: it declines older stored values.
const files = atom({ plugin: 'file-tree', key: 'files' } as const, [], { shape: 'files-1' })

const READS = new Set(['Read', 'NotebookRead'])
const WRITES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

function pathOf(e: Record<string, unknown>): string | undefined {
  const p = e.file_path ?? e.notebook_path
  return typeof p === 'string' ? p : undefined
}

async function mark($: EngineInterface, path: string, fn: (t: Touched) => Touched): Promise<void> {
  await update($, files, list => {
    const old = list.find(f => f.path === path)
    const base: Touched = old ?? { path, state: 'read', isActive: false, at: 0 }
    return [...list.filter(f => f.path !== path), fn(base)].slice(-300)
  })
}

// Common folder prefix, so the pane shows short paths.
function commonDir(paths: string[]): string {
  if (paths.length === 0) return ''
  const parts = paths.map(p => p.split('/').slice(0, -1))
  const first = parts[0] ?? []
  let n = 0
  while (n < first.length && parts.every(p => p[n] === first[n])) n += 1
  return first.slice(0, n).join('/')
}

const MARK = { read: '○', changed: '●', committed: '✔' } as const
const COLOR = { read: 'gray', changed: 'yellow', committed: 'green' } as const

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'files', description: 'Open the pane of files Claude touched' })
    return next(e)
  })

  on('command.run', { command: 'files' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Files' })
    return { text: 'Files pane opened.' }
  })

  on('tool.call', async ($, e, next) => {
    const args = e as unknown as Record<string, unknown>
    const path = pathOf(args)
    const isRead = READS.has(e.tool)
    const isWrite = WRITES.has(e.tool)
    const command = e.tool === 'Bash' && typeof args.command === 'string' ? args.command : ''

    if (path && (isRead || isWrite)) {
      try {
        const t = await $.clock.now()
        void $.ui.open({ id: PANE, title: 'Files' })
        await mark($, path, f => ({ ...f, isActive: true, at: t }))
      } catch {}
    }

    const result = await next(e)

    try {
      if (path && (isRead || isWrite)) {
        await mark($, path, f => ({
          ...f,
          isActive: false,
          // A read never downgrades a changed or committed file.
          state: isWrite ? 'changed' : f.state,
        }))
      }
      // After a git commit, every changed file counts as committed.
      if (/\bgit\b[^|;&]*\bcommit\b/.test(command)) {
        await update($, files, list =>
          list.map(f => (f.state === 'changed' ? { ...f, state: 'committed' } : f)),
        )
      }
    } catch {}

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, files)

    if (list.length === 0) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No files touched yet.</Text>
        </Box>
      )
    }

    const root = commonDir(list.map(f => f.path))
    const sorted = [...list].sort((a, b) => a.path.localeCompare(b.path))
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 3)
    const changed = list.filter(f => f.state === 'changed').length

    return (
      <Box flexDirection="column">
        <Text dimColor>
          {root || '/'} · {list.length} files · {changed} uncommitted
        </Text>
        {sorted.slice(0, room).map(f => (
          <Text color={f.isActive ? 'cyan' : COLOR[f.state]} bold={f.isActive}>
            {f.isActive ? '◐' : MARK[f.state]} {root ? f.path.slice(root.length + 1) : f.path}
          </Text>
        ))}
        {sorted.length > room && <Text dimColor>… {sorted.length - room} more</Text>}
      </Box>
    )
  })
}
