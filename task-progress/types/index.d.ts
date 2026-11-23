export type Progress = {
  isRunning: boolean
  startedAt: number
  endedAt: number
  steps: number
  tools: number
  current: string
  subagents: number
  outcome: string
}

declare module 'claude-code' {
  interface PluginState {
    'task-progress': { progress: Shaped<Progress | null>; now: number; isHidden: boolean }
  }
}
