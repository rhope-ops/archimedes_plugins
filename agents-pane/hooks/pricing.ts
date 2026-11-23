// Token and cost helpers for the pane. Costs come from Claude Code itself (the `/cost` estimate on each
// agent), the most complete estimate in a session: it prices 5-minute and 1-hour cache writes, fast mode,
// long prompts and search fees. Source of truth for prices: platform.claude.com/docs/en/about-claude/pricing.

import type { AgentInfo } from 'claude-code'
import type { AgentSnap, Ledger } from '../types'

export type Usage = {
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

export function usageTokens(u: Usage): number {
  return u.input_tokens + u.output_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
}

// All the tokens an agent's requests used: input, output, cache reads and cache writes.
export function agentTokens(usage: readonly Usage[]): number {
  return usage.reduce((n, u) => n + usageTokens(u), 0)
}

export function tokensText(n: number): string {
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 99_950) return `${Math.round(n / 1000)}k`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

export function usdText(usd: number | undefined): string {
  if (usd === undefined) return '$–'
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`
}

export function since(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}`
}


// What the pane keeps of one live agent. endTime is set by `sync`.
export function snapOf(a: AgentInfo): AgentSnap {
  const usage = (a.usage ?? []) as readonly Usage[]
  const sum = (f: (u: Usage) => number) => usage.reduce((n, u) => n + f(u), 0)
  return {
    id: a.id,
    description: a.description,
    type: a.type,
    model: a.model ?? null,
    status: a.status,
    label: a.label,
    startTime: a.startTime,
    endTime: null,
    tokens: {
      input: sum(u => u.input_tokens),
      output: sum(u => u.output_tokens),
      cacheRead: sum(u => u.cache_read_input_tokens),
      cacheWrite: sum(u => u.cache_creation_input_tokens),
    },
    usd: a.cost?.usd ?? null,
  }
}

const ENDED = ['completed', 'failed', 'killed', 'idle']

// Fold the live list into the ledger. Agents missing from the list keep their last snapshot.
// Returns the same object when nothing changed, so a caller can skip the write.
export function sync(before: Ledger, live: readonly AgentSnap[], now: number): Ledger {
  let changed = false
  const agents = { ...before.agents }
  const order = [...before.order]
  const types = [...before.types]
  for (const s of [...live].sort((x, y) => x.startTime - y.startTime)) {
    const old = agents[s.id]
    const isEnded = ENDED.includes(s.status)
    const endTime = isEnded ? (old?.endTime ?? now) : null
    // Never let a later reading lower what an earlier one counted.
    const next: AgentSnap = {
      ...s,
      endTime,
      tokens: old
        ? {
            input: Math.max(old.tokens.input, s.tokens.input),
            output: Math.max(old.tokens.output, s.tokens.output),
            cacheRead: Math.max(old.tokens.cacheRead, s.tokens.cacheRead),
            cacheWrite: Math.max(old.tokens.cacheWrite, s.tokens.cacheWrite),
          }
        : s.tokens,
      usd: s.usd ?? old?.usd ?? null,
    }
    if (!old) order.push(s.id)
    if (!types.includes(s.type)) types.push(s.type)
    if (JSON.stringify(old) !== JSON.stringify(next)) {
      agents[s.id] = next
      changed = true
    }
  }
  if (types.length !== before.types.length || order.length !== before.order.length) changed = true
  return changed ? { types, order, agents } : before
}

// One color per agent type, in the order the types first appear. The 8 hues of the dataviz
// reference palette (dark-surface steps); named colors in the terminal. After 8 they repeat.
const HEX = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767']
const NAMED = ['blue', 'yellow', 'cyan', 'magenta', 'green', 'blueBright', 'magentaBright', 'red']

export function typeColor(slot: number, isTerminal: boolean): string {
  const list = isTerminal ? NAMED : HEX
  return list[(Math.max(0, slot) % list.length + list.length) % list.length] ?? 'gray'
}
