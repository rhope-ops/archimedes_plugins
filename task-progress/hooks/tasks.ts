// Pure task-list logic. No engine calls: runs inside `update`, so parallel calls do not lose updates.
import type { TaskEntry, TaskList, TaskStatus } from '../types'

const STATUSES: readonly string[] = ['pending', 'in_progress', 'completed']

const str = (x: unknown) => (typeof x === 'string' ? x.trim() : '')

// What a task is for, as a short line: activeForm ("Running tests"), else subject or content.
function titleOf(o: Record<string, unknown> | undefined): string {
  return (str(o?.activeForm) || str(o?.subject) || str(o?.content)).split('\n')[0] ?? ''
}

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
      | Record<string, unknown>[]
      | undefined
    if (!Array.isArray(todos)) return undefined
    // By position: two todos with the same text stay two tasks.
    return todos.map((t, i) => ({ id: `todo:${i}`, status: asStatus(t.status), title: titleOf(t) }))
  }
  if (tool === 'TaskCreate') {
    const task = result?.task as { id?: unknown } | undefined
    const id = typeof task?.id === 'string' ? task.id : newId()
    // A new task after a finished list starts a new list.
    const isFinished = before.length > 0 && before.every(t => t.status === 'completed')
    return [...(isFinished ? [] : before.filter(t => t.id !== id)), { id, status: 'pending', title: titleOf(args) }]
  }
  if (tool === 'TaskUpdate' && typeof args.taskId === 'string') {
    if (result?.success === false) return undefined
    const id = args.taskId
    if (args.status === 'deleted') {
      return before.some(t => t.id === id) ? before.filter(t => t.id !== id) : undefined
    }
    const hasStatus = typeof args.status === 'string' && STATUSES.includes(args.status)
    const title = titleOf(args)
    if (hasStatus || title !== '') {
      // Merge: an update that sets only the status keeps the title, and the other way round.
      const merge = (t: TaskEntry | undefined): TaskEntry => ({
        id,
        status: hasStatus ? asStatus(args.status) : (t?.status ?? 'pending'),
        title: title || t?.title || '',
      })
      const old = before.find(t => t.id === id)
      return old ? before.map(t => (t.id === id ? merge(t) : t)) : [...before, merge(undefined)]
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

// What the session works on now: the in-progress task's title, else ''.
export function activeTitle(list: TaskList): string {
  return list.find(t => t.status === 'in_progress' && t.title !== '')?.title ?? ''
}
