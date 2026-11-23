// Token and cost helpers for the pane. Costs come from Claude Code itself (the `/cost` estimate on each
// agent), the most complete estimate in a session: it prices 5-minute and 1-hour cache writes, fast mode,
// long prompts and search fees. Source of truth for prices: platform.claude.com/docs/en/about-claude/pricing.

import type { AgentInfo } from 'claude-code'
import type { AgentSnap, Ledger, TokenSplit } from '../types'

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
  // A live agent that left the list without a last reading has ended: stop its clock.
  const seen = new Set(live.map(s => s.id))
  for (const id of order) {
    const old = agents[id]
    if (old && !seen.has(id) && !ENDED.includes(old.status) && old.status !== 'ended') {
      agents[id] = { ...old, status: 'ended', endTime: now }
      changed = true
    }
  }
  if (types.length !== before.types.length || order.length !== before.order.length) changed = true
  return changed ? { ...before, types, order, agents } : before
}

// Add one main-loop turn's usage (the API's field names) to the running split.
export function addUsage(t: TokenSplit, u: Partial<Usage> | undefined): TokenSplit {
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  return {
    input: t.input + n(u?.input_tokens),
    output: t.output + n(u?.output_tokens),
    cacheRead: t.cacheRead + n(u?.cache_read_input_tokens),
    cacheWrite: t.cacheWrite + n(u?.cache_creation_input_tokens),
  }
}

export const splitTotal = (t: TokenSplit) => t.input + t.output + t.cacheRead + t.cacheWrite

// Cells of each part of a `width`-cell bar split by `shares` (any scale): every part with a share
// gets at least 1 cell when it fits, and the cells add up to exactly `width`.
export function splitCells(width: number, shares: readonly number[]): number[] {
  const w = Math.max(0, Math.floor(width))
  const total = shares.reduce((n, x) => n + Math.max(0, x), 0)
  if (w === 0 || total <= 0) return shares.map(() => 0)
  const raw = shares.map(x => (Math.max(0, x) / total) * w)
  const cells = raw.map(x => Math.floor(x))
  // Largest remainders take the cells left over.
  const order = raw.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0])
  let left = w - cells.reduce((n, x) => n + x, 0)
  for (const [, i] of order) {
    if (left <= 0) break
    cells[i] = (cells[i] ?? 0) + 1
    left--
  }
  // A part with a share but no cell borrows one from the largest part.
  for (let i = 0; i < cells.length; i++) {
    if ((shares[i] ?? 0) > 0 && cells[i] === 0) {
      const big = cells.indexOf(Math.max(...cells))
      if ((cells[big] ?? 0) > 1) {
        cells[big] = (cells[big] ?? 0) - 1
        cells[i] = 1
      }
    }
  }
  return cells
}

// One color per agent type, in the order the types first appear. The 8 hues of the dataviz
// reference palette (dark-surface steps); named colors in the terminal. After 8 they repeat.
const HEX = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#0ca30c', '#9085e9', '#e66767']
const NAMED = ['blue', 'yellow', 'cyan', 'magenta', 'green', 'blueBright', 'magentaBright', 'red']

export function typeColor(slot: number, isTerminal: boolean): string {
  const list = isTerminal ? NAMED : HEX
  return list[(Math.max(0, slot) % list.length + list.length) % list.length] ?? 'gray'
}

// The /cost record the token-log Stop hook pushes next to its rows (kit scripts/token_log.py reads it).
// Claude Code's own estimate, as /cost shows it. No task text: only ids, types, models and numbers.
export type CostRecord = {
  version: 1
  session_id: string
  written_at: string
  session_usd: number | null
  main_usd: number | null
  subagents_usd: number
  main: { turns: number; input: number; output: number; cache_read: number; cache_write: number }
  subagents: {
    agent_id: string
    type: string
    model: string | null
    status: string
    usd: number | null
    input: number
    output: number
    cache_read: number
    cache_write: number
    started_at: string
    ended_at: string | null
  }[]
}

const iso = (ms: number) => new Date(ms).toISOString()

export function costRecord(l: Ledger, sessionId: string, now: number): CostRecord {
  const agents = l.order.map(id => l.agents[id]).filter((a): a is AgentSnap => a !== undefined)
  const subUsd = agents.reduce((n, a) => n + (a.usd ?? 0), 0)
  return {
    version: 1,
    session_id: sessionId,
    written_at: iso(now),
    session_usd: l.sessionUsd,
    main_usd: l.sessionUsd === null ? null : Math.max(0, l.sessionUsd - subUsd),
    subagents_usd: subUsd,
    main: {
      turns: l.mainTurns,
      input: l.main.input,
      output: l.main.output,
      cache_read: l.main.cacheRead,
      cache_write: l.main.cacheWrite,
    },
    subagents: agents.map(a => ({
      agent_id: a.id,
      type: a.type,
      model: a.model,
      status: a.status,
      usd: a.usd,
      input: a.tokens.input,
      output: a.tokens.output,
      cache_read: a.tokens.cacheRead,
      cache_write: a.tokens.cacheWrite,
      started_at: iso(a.startTime),
      ended_at: a.endTime === null ? null : iso(a.endTime),
    })),
  }
}

// Only a plain id may name the file.
export const isSafeId = (id: string) => /^[A-Za-z0-9._-]{1,128}$/.test(id) && !id.startsWith('.')
