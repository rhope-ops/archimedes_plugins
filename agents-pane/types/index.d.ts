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
  // The session these figures belong to. After /clear the id changes and the ledger starts over.
  sessionId: string
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
  // The plan's usage limits as /usage shows them (5-hour and 7-day windows), for the whole account, at
  // the time `limitsAt`; empty off a subscription or before the first API response.
  limits: UsageLimit[]
  limitsAt: number | null
}

export type UsageLimit = { kind: string; percentUsed: number; resetsAt: string | null }

declare module 'claude-code' {
  interface PluginState {
    'agents-pane': { tick: Tick; ledger: Shaped<Ledger> }
  }
}
