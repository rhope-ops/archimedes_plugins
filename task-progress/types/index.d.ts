// What the estimate reads of the task list: tasks in all, done, done in this turn.
export type Plan = {
  total: number
  done: number
  doneThisTurn: number
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

// The session's task list, as the TaskCreate, TaskUpdate and TodoWrite calls that worked built it.
export type TaskEntry = { id: string; status: TaskStatus }
export type TaskList = TaskEntry[]

export type Progress = {
  isRunning: boolean
  startedAt: number
  endedAt: number
  steps: number
  tools: number
  current: string
  outcome: string
  promptChars: number
  predictedMs: number | null
  // Tasks that became completed during this turn.
  completedInTurn: string[]
}

// One finished main-loop turn. No prompt text: only its length.
export type TurnRecord = {
  at: number
  ms: number
  steps: number
  tools: number
  promptChars: number
  predictedMs: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'task-progress': {
      progress: Shaped<Progress | null>
      tasks: Shaped<TaskList>
      now: number
      isHidden: boolean
    }
  }
}
