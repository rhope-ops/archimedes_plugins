// What the estimate reads of the task list: tasks in all, done, done in this turn.
export type Plan = {
  total: number
  done: number
  doneThisTurn: number
}

// The session's task list, as the TaskCreate, TaskUpdate and TodoWrite calls built it.
export type TaskList = {
  total: number
  completedIds: string[]
}

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
  doneAtStart: number
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
