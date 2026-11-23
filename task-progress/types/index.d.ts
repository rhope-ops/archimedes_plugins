// What the estimate reads of the task list: tasks in all, done, done in this turn.
export type Plan = {
  total: number
  done: number
  doneThisTurn: number
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed'

// The session's task list, as the TaskCreate, TaskUpdate and TodoWrite calls that worked built it.
// `title` is what the task is for: its activeForm, else its subject (or a todo's content).
export type TaskEntry = { id: string; status: TaskStatus; title: string }
export type TaskList = TaskEntry[]

export type Progress = {
  isRunning: boolean
  startedAt: number
  endedAt: number
  steps: number
  tools: number
  current: string
  // What this turn is for, in a few words: from the in-progress task, else a short model summary of
  // the prompt. Empty until known. Kept for this session only, never in the turn history.
  goal: string
  turnId: string
  // True once a task tool call changed the list in this turn: only then does the task name the goal.
  hasTaskChange: boolean
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
