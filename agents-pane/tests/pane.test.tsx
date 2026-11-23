import { expect, test } from 'claude-code/testing'
import { costRecord, isSafeId, splitCells, sync, tokensText, typeColor } from '../hooks/pricing'

const PANE = {
  plugin: 'agents-pane',
  component: 'Pane',
  requestId: 'agents-pane',
  props: { title: 'Subagents', isFocused: false, bodyColumns: 50, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const DONE = { reason: 'answer', answer: '', durationMs: 1000, isAborted: false } as const

const usage = (model: string, input: number, output: number) => ({
  model,
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 500,
})

// A sample agent with only the fields the pane reads; `usd` undefined means no cost yet.
const agent = (id: string, status: string, usd: number | undefined, startTime: number, type = 'worker') => ({
  id,
  description: `Task ${id}`,
  type,
  status,
  kind: 'local_agent',
  taskStatus: status === 'running' ? 'running' : 'completed',
  label: status === 'running' ? `Editing ${id}.py` : `Task ${id}`,
  startTime,
  cwd: '/',
  model: 'claude-sonnet-5-5',
  tokenCount: 0,
  tokenSamples: [],
  usage: [usage('claude-sonnet-5-5', 2000, 3000)],
  ...(usd === undefined ? {} : { cost: { usd } }),
})

// The session's /cost total the engine reports; a test sets it.
let sessionUsd = 0

async function setup($: any, on: any, list: () => unknown[]) {
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.list', () => ({ value: list() as never }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits: [], cost: { usd: sessionUsd } } as never }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

// A subagent's turn end makes the pane read the live list into its ledger.
const poke = ($: any) => $.turn.complete({ turnId: 'x', agentId: 'a1', ...DONE })

async function paneTexts($: any, surface: 'desktop' | 'terminal'): Promise<string[]> {
  const ui = await $.ui.mount({ ...PANE, surface })
  const texts = (await ui.findAll({ type: 'Text' })).map((t: { text?: string }) => t.text ?? '')
  await ui.unmount()
  return texts
}

test('totals, token split, per-type rows and a card for each agent; live first', async ($, on) => {
  const now = Date.now()
  await setup($, on, () => [agent('a1', 'completed', 0.004, now - 95_000, 'Explore'), agent('a2', 'running', 1.234, now - 95_000)])
  await poke($)
  for (const surface of ['desktop', 'terminal'] as const) {
    const texts = await paneTexts($, surface)
    const all = texts.join('\n')
    expect(all).toContain('2 subagents')
    expect(all).toContain('1 running · 1 done')
    // The total is the sum of the /cost estimates: 1.234 + 0.004.
    expect(texts).toContain('$1.24')
    expect(all).toContain('$1.23')
    expect(all).toContain('<$0.01')
    // 2,000 + 3,000 + 1,000 + 500 tokens per agent; 13k in all.
    expect(all).toContain('6.5k tok · in 2.0k · out 3.0k · cache 1.0kr / 500w')
    expect(texts).toContain('13.0k')
    expect(texts).toContain('4.0k · 6.0k')
    expect(texts).toContain('2.0k · 1.0k')
    // One row per type, with its count.
    expect(texts).toContain('Explore')
    expect(texts).toContain('worker')
    expect(all).toContain('Editing a2.py')
    expect(all).toContain('estimate, as /cost')
    expect(all.indexOf('ACTIVE · 1')).toBeLessThan(all.indexOf('FINISHED · 1'))
    expect(all.indexOf('Task a2')).toBeLessThan(all.indexOf('Task a1'))
  }
})

test('every agent gets a card; nothing is cut at the view height', async ($, on) => {
  const now = Date.now()
  await setup($, on, () => Array.from({ length: 8 }, (_, i) => agent(`a${i}`, 'running', 0.5, now - i * 1000)))
  await poke($)
  for (const surface of ['desktop', 'terminal'] as const) {
    const texts = await paneTexts($, surface)
    expect(texts.join('\n')).toContain('8 running · 0 done')
    for (let i = 0; i < 8; i++) expect(texts).toContain(`Task a${i}`)
    expect(texts).toContain('$4.00')
  }
})

test('an agent Claude Code drops from its list stays in the totals', async ($, on) => {
  const now = Date.now()
  let list = [agent('a1', 'completed', 0.75, now - 60_000), agent('a2', 'running', 0.25, now - 10_000)]
  await setup($, on, () => list)
  await poke($)
  expect(await paneTexts($, 'desktop')).toContain('$1.00')
  // The engine drops a1 a while after it ends.
  list = [agent('a2', 'completed', 0.5, now - 10_000)]
  await poke($)
  const texts = await paneTexts($, 'desktop')
  expect(texts).toContain('$1.25')
  expect(texts).toContain('Task a1')
  expect(texts.join('\n')).toContain('2 done')
})

test("no '+' after the total before any agent has a cost; a '+' when some have none yet", async ($, on) => {
  const now = Date.now()
  let list = [agent('a1', 'running', undefined, now), agent('a2', 'running', undefined, now - 1000)]
  await setup($, on, () => list)
  const total = async (surface: 'desktop' | 'terminal') => {
    await poke($)
    const texts = await paneTexts($, surface)
    // The header total is the text right after the "N subagents" text.
    return texts[texts.findIndex(t => /subagents$/.test(t)) + 1]
  }
  for (const surface of ['desktop', 'terminal'] as const) {
    list = [agent('a1', 'running', undefined, now), agent('a2', 'running', undefined, now - 1000)]
    expect(await total(surface)).toBe('$–')
  }
  list = [agent('a1', 'running', 1.234, now), agent('a2', 'running', undefined, now - 1000)]
  expect(await total('desktop')).toBe('$1.23+')
  list = [agent('a1', 'running', 1.234, now), agent('a2', 'running', 0.5, now - 1000)]
  expect(await total('desktop')).toBe('$1.73')
})

test('ledger: an end time once, counts never go down, types keep their first color slot', async () => {
  const empty = { types: [], order: [], agents: {}, main: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, mainTurns: 0, sessionUsd: null }
  const snap = (id: string, type: string, status: string, out: number) => ({
    id,
    description: id,
    type,
    model: null,
    status,
    label: id,
    startTime: 1,
    endTime: null,
    tokens: { input: 0, output: out, cacheRead: 0, cacheWrite: 0 },
    usd: null,
  })
  const a = sync(empty, [snap('x', 'Explore', 'running', 10), snap('y', 'Plan', 'running', 5)], 100)
  expect(a.types).toEqual(['Explore', 'Plan'])
  expect(sync(a, [snap('x', 'Explore', 'running', 10), snap('y', 'Plan', 'running', 5)], 200)).toBe(a)
  const b = sync(a, [snap('x', 'Explore', 'completed', 4)], 300)
  expect(b.agents.x?.endTime).toBe(300)
  expect(b.agents.x?.tokens.output).toBe(10)
  expect(sync(b, [snap('x', 'Explore', 'completed', 10)], 400).agents.x?.endTime).toBe(300)
  expect(typeColor(0, false)).not.toBe(typeColor(1, false))
  expect(typeColor(8, true)).toBe(typeColor(0, true))
})

test('helpers: token rounding', async () => {
  expect(tokensText(999_950)).toBe('1.0M')
  expect(tokensText(99_960)).toBe('100k')
  expect(tokensText(1_500)).toBe('1.5k')
})

test('a running agent that leaves the list ends; the terminal share bar is exactly the width', async ($, on) => {
  const now = Date.now()
  let list = [agent('a1', 'running', 0.5, now - 5000, 'Explore'), agent('a2', 'running', 1.5, now - 5000)]
  await setup($, on, () => list)
  await poke($)
  list = []
  await poke($)
  const texts = await paneTexts($, 'terminal')
  expect(texts.join('\n')).toContain('2 done')
  expect(texts.join('\n')).not.toContain('running')
  // bodyColumns 50, padding 1 each side: 48 cells, split 1 : 3 by cost.
  const bar = texts.filter(t => /^█+$/.test(t))
  expect(bar.map(t => t.length)).toEqual([12, 36])
})

test('splitCells: exact width, at least one cell per part with a share', async () => {
  expect(splitCells(10, [1, 1, 1])).toEqual([4, 3, 3])
  expect(splitCells(10, [100, 0.01])).toEqual([9, 1])
  expect(splitCells(5, [0, 0])).toEqual([0, 0])
})

test('the session block: main conversation beside the subagents, and the session total', async ($, on) => {
  const now = Date.now()
  sessionUsd = 3.0
  await setup($, on, () => [agent('a1', 'completed', 0.75, now - 60_000)])
  // Two main-loop turns: their usage adds up.
  for (const id of ['m1', 'm2']) {
    await $.turn.complete({
      turnId: id,
      ...DONE,
      usage: { model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 2000 },
    } as never)
  }
  for (const surface of ['desktop', 'terminal'] as const) {
    const texts = await paneTexts($, surface)
    expect(texts).toContain('SESSION')
    expect(texts).toContain('Main conversation · 2 turns')
    expect(texts).toContain('47.0k tok')
    // $3.00 for the session, less $0.75 for the subagent.
    expect(texts).toContain('$2.25')
    expect(texts).toContain('Subagents · 1')
    expect(texts).toContain('Session total')
    expect(texts).toContain('$3.00')
    expect(texts).toContain('53.5k tok')
  }
  sessionUsd = 0
})

test('each turn end writes the /cost record where the token-log hook reads it', async ($, on) => {
  const now = Date.now()
  const files = new Map<string, string>()
  const env: Record<string, string | undefined> = { HOME: '/home/t', TOKEN_LOG: undefined, TOKEN_LOG_HOME: undefined }
  sessionUsd = 2.0
  on('env.get', (_: unknown, e: { name: string }) => ({ value: env[e.name] }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => (files.set(e.path, e.text), { value: undefined }))
  await setup($, on, () => [agent('a1', 'completed', 0.5, now - 60_000, 'Explore')])
  await $.turn.complete({
    turnId: 'm1',
    ...DONE,
    usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
  } as never)
  const text = files.get('/home/t/.claude/token-log/cost/sess-1.json')
  expect(text).toBeDefined()
  const r = JSON.parse(text ?? '{}')
  expect(r.version).toBe(1)
  expect(r.session_usd).toBe(2)
  expect(r.main_usd).toBe(1.5)
  expect(r.subagents_usd).toBe(0.5)
  expect(r.main).toEqual({ turns: 1, input: 10, output: 20, cache_read: 30, cache_write: 40 })
  expect(r.subagents[0].type).toBe('Explore')
  // No task text in the record.
  expect(text).not.toContain('Task a1')

  // TOKEN_LOG_HOME moves it; TOKEN_LOG=off stops it.
  files.clear()
  env.TOKEN_LOG_HOME = '/var/tl'
  await $.turn.complete({ turnId: 'm2', ...DONE } as never)
  expect([...files.keys()]).toEqual(['/var/tl/cost/sess-1.json'])
  files.clear()
  env.TOKEN_LOG = 'off'
  await $.turn.complete({ turnId: 'm3', ...DONE } as never)
  expect(files.size).toBe(0)
  sessionUsd = 0
})

test('cost record: no session cost yet gives null main cost; unsafe ids are refused', async () => {
  const l = { types: [], order: [], agents: {}, main: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, mainTurns: 0, sessionUsd: null }
  expect(costRecord(l, 's', 0).main_usd).toBeNull()
  expect(isSafeId('216be8a9-f390-5737-904e-8abe3708475f')).toBe(true)
  expect(isSafeId('../x')).toBe(false)
  expect(isSafeId('a/b')).toBe(false)
})
