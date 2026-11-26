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

// One line of a diff: kept (' '), added ('+') or removed ('-'); its line number when known; and the
// changed middle of the line [start, end) in characters, when it pairs with a line on the other side.
export type DiffLine = { kind: ' ' | '+' | '-'; n: number | null; text: string; mark?: [number, number] }

// One change to a file by one agent ('main' for the main conversation).
export type FileHunk = { agent: string; at: number; lines: DiffLine[]; cut: number }

// A file an agent read or changed in this session. Content is kept only as capped diff hunks.
export type FileEntry = {
  path: string
  state: 'read' | 'changed' | 'committed'
  // True while a tool works on it.
  isActive: boolean
  at: number
  // Agent ids that touched it ('main' for the main conversation), first toucher first.
  agents: string[]
  add: number
  del: number
  hunks: FileHunk[]
  // What each agent did to it: its own state, line counts and whether its tool runs on it now.
  by: Record<string, AgentFile>
}

export type AgentFile = { state: 'read' | 'changed' | 'committed'; add: number; del: number; isActive: boolean }

declare module 'claude-code' {
  interface PluginState {
    'agents-pane': {
      tick: Tick
      ledger: Shaped<Ledger>
      files: Shaped<FileEntry[]>
      // Roles hidden by the role chips.
      hiddenRoles: string[]
      // The open diff: "<agent id>|<path>", or '' when none.
      openFile: string
    }
  }
}
