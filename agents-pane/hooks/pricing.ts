// Token and cost helpers for the pane. Costs come from Claude Code itself (the `/cost` estimate on each
// agent), the most complete estimate in a session: it prices 5-minute and 1-hour cache writes, fast mode,
// long prompts and search fees. Source of truth for prices: platform.claude.com/docs/en/about-claude/pricing.

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
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
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
