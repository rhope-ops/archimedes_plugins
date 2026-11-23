// Pure task-list logic. No engine calls: runs inside `update`, so parallel calls do not lose updates.
import type { TaskList, TaskStatus } from '../types'

const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed']

function asStatus(s: unknown): TaskStatus {
  return (typeof s === 'string' && STATUSES.includes(s) ? s : 'pending') as TaskStatus
}

// The list after a task tool call that worked, or undefined when the call changes nothing.
export function apply(
  before: TaskList,
  tool: string,
  args: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
  newId: () => string,
): TaskList | undefined {
  if (tool === 'TodoWrite') {
    const todos = (Array.isArray(result?.newTodos) ? result.newTodos : args.todos) as
      | { status?: string }[]
      | undefined
    if (!Array.isArray(todos)) return undefined
    // By position: two todos with the same text stay two tasks.
    return todos.map((t, i) => ({ id: `todo:${i}`, status: asStatus(t.status) }))
  }
  if (tool === 'TaskCreate') {
    const task = result?.task as { id?: unknown } | undefined
    const id = typeof task?.id === 'string' ? task.id : newId()
    // A new task after a finished list starts a new list.
    const isFinished = before.length > 0 && before.every(t => t.status === 'completed')
    return [...(isFinished ? [] : before.filter(t => t.id !== id)), { id, status: 'pending' }]
  }
  if (tool === 'TaskUpdate' && typeof args.taskId === 'string') {
    if (result?.success === false) return undefined
    const id = args.taskId
    if (args.status === 'deleted') {
      return before.some(t => t.id === id) ? before.filter(t => t.id !== id) : undefined
    }
    if (typeof args.status === 'string' && STATUSES.includes(args.status)) {
      const entry = { id, status: asStatus(args.status) }
      return before.some(t => t.id === id) ? before.map(t => (t.id === id ? entry : t)) : [...before, entry]
    }
  }
  return undefined
}

export type Change = { added: string[]; removed: string[] }

// Which ids became completed, and which stopped being completed, in one change.
export function completedChange(before: TaskList, after: TaskList): Change {
  const was = new Set(before.filter(t => t.status === 'completed').map(t => t.id))
  const isNow = new Set(after.filter(t => t.status === 'completed').map(t => t.id))
  return {
    added: [...isNow].filter(id => !was.has(id)),
    removed: [...was].filter(id => !isNow.has(id)),
  }
}

// Apply a change to the turn's completed ids. Order does not matter between changes.
export function applyChange(ids: readonly string[], change: Change): string[] {
  const kept = ids.filter(id => !change.removed.includes(id))
  return [...kept, ...change.added.filter(id => !kept.includes(id))]
}
