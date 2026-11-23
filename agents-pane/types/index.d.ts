export type Tick = number

// Tokens of one agent, split by kind.
export type TokenSplit = { input: number; output: number; cacheRead: number; cacheWrite: number }

// What the pane keeps of one subagent. Claude Code drops a finished subagent from its list after a
// while; the ledger keeps it, so the totals never go down.
export type AgentSnap = {
  id: string
  description: string
  type: string
  model: string | null
  status: string
  label: string
  startTime: number
  // When the pane first saw it finished; null while it runs.
  endTime: number | null
  tokens: TokenSplit
  // The /cost estimate; null before Claude Code has one.
  usd: number | null
}

export type Ledger = {
  // Agent types in the order the pane first saw them: the color slot of each type.
  types: string[]
  // Agent ids in spawn order.
  order: string[]
  agents: Record<string, AgentSnap>
  // The main conversation: its turns' tokens, summed at each turn end.
  main: TokenSplit
  mainTurns: number
  // The whole session's /cost estimate (main, subagents and mods' model calls); null before one exists.
  sessionUsd: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'agents-pane': { tick: Tick; ledger: Shaped<Ledger> }
  }
}
