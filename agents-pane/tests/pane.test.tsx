import { expect, test } from 'claude-code/testing'
import { diff, lineOf, markOf } from '../hooks/diff'
import { MODEL_HEX, change, commit, familyOf, roleOf, touch, typeLabel, utf8Bytes } from '../hooks/files'
import { costRecord, isSafeId, splitCells, sync, tokensText } from '../hooks/pricing'

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
let sessionIdNow = 'sess-1'
// The /usage windows the engine reports; a test sets them.
let rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[] = []

async function setup($: any, on: any, list: () => unknown[]) {
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  // The harness runs a timer's callback as soon as this answers.
  on('clock.after', () => ({ value: undefined }))
  on('turn.complete', () => ({ text: '' }))
  // The engine always has a session id; a test sets `sessionIdNow`.
  on('session.id', () => ({ value: sessionIdNow }))
  on('agent.list', () => ({ value: list() as never }))
  on('session.usage', () => ({ value: { startedAt: 0, context: {}, rateLimits, cost: { usd: sessionUsd } } as never }))
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
    // Tokens: the total, then each part with its label.
    expect(all).toContain('6.5k tok · in 2.0k · out 3.0k · cache read 1.0k · write 500')
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

test('ledger: an end time once, counts never go down, types keep their first-seen order', async () => {
  const empty = { sessionId: 's', types: [], order: [], agents: {}, main: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, mainTurns: 0, sessionUsd: null, limits: [], limitsAt: null }
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
  rateLimits = [
    { kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-11-24T22:00:00Z' },
    { kind: 'seven_day', percentUsed: 41 },
  ]
  on('env.get', (_: unknown, e: { name: string }) => ({ value: env[e.name] }))
  on('fs.write', (_: unknown, e: { path: string; text: string }) => (files.set(e.path, e.text), { value: undefined }))
  await setup($, on, () => [agent('a1', 'completed', 0.5, now - 60_000, 'Explore')])
  await $.turn.complete({
    turnId: 'm1',
    ...DONE,
    usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 },
  } as never)
  // The write runs from a timer, after the turn end: wait for it (each $ call is one round trip).
  // Wait until the file is there (or, when none is due, a fixed number of round trips).
  const settle = async (isDue = true) => {
    for (let i = 0; i < 20 && (!isDue || files.size === 0); i++) await paneTexts($, 'desktop')
  }
  await settle()
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
  // The /usage windows, as read.
  expect(r.limits).toEqual([
    { window: 'five_hour', percent_used: 12.5, resets_at: '2026-11-24T22:00:00Z' },
    { window: 'seven_day', percent_used: 41, resets_at: null },
  ])
  expect(typeof r.limits_read_at).toBe('string')
  expect(await paneTexts($, 'desktop')).toContain('Plan limits: 5h 12% · 7d 41%')
  rateLimits = []

  // TOKEN_LOG_HOME moves it; TOKEN_LOG=off stops it.
  files.clear()
  env.TOKEN_LOG_HOME = '/var/tl'
  await $.turn.complete({ turnId: 'm2', ...DONE } as never)
  await settle()
  expect([...files.keys()]).toEqual(['/var/tl/cost/sess-1.json'])
  files.clear()
  env.TOKEN_LOG = 'off'
  await $.turn.complete({ turnId: 'm3', ...DONE } as never)
  await settle(false)
  expect(files.size).toBe(0)
  sessionUsd = 0
})

test('cost record: no session cost yet gives null main cost; unsafe ids are refused', async () => {
  const l = { sessionId: 's', types: [], order: [], agents: {}, main: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, mainTurns: 0, sessionUsd: null, limits: [], limitsAt: null }
  expect(costRecord(l, 's', 0).main_usd).toBeNull()
  expect(isSafeId('216be8a9-f390-5737-904e-8abe3708475f')).toBe(true)
  expect(isSafeId('../x')).toBe(false)
  expect(isSafeId('a/b')).toBe(false)
})

test('a subagent turn with usage does not count as main; /clear starts the ledger over', async ($, on) => {
  const now = Date.now()
  sessionIdNow = 'sess-1'
  sessionUsd = 1.0
  await setup($, on, () => [agent('a1', 'running', 0.25, now - 1000)])
  const used = { model: 'm', input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  await $.turn.complete({ turnId: 'm1', ...DONE, usage: used } as never)
  await $.turn.complete({ turnId: 's1', agentId: 'a1', ...DONE, usage: used } as never)
  let texts = await paneTexts($, 'desktop')
  expect(texts).toContain('Main conversation · 1 turn')
  expect(texts).toContain('200 tok')
  // A late, smaller /cost reading does not lower the total.
  sessionUsd = 0.5
  await $.turn.complete({ turnId: 's2', agentId: 'a1', ...DONE } as never)
  expect(await paneTexts($, 'desktop')).toContain('$1.00')
  // /clear: a new session id, a new ledger.
  sessionIdNow = 'sess-2'
  sessionUsd = 0.1
  await $.turn.complete({ turnId: 'm2', ...DONE, usage: used } as never)
  texts = await paneTexts($, 'desktop')
  expect(texts).toContain('Main conversation · 1 turn')
  expect(texts).toContain('$0.10')
  sessionUsd = 0
  sessionIdNow = 'sess-1'
})

test('plan limits: an empty reading keeps the last one, a lower one replaces it, /clear clears them', async ($, on) => {
  const now = Date.now()
  sessionIdNow = 'sess-1'
  rateLimits = [{ kind: 'five_hour', percentUsed: 97 }, { kind: 'seven_day', percentUsed: 60 }]
  await setup($, on, () => [agent('a1', 'running', 0.1, now - 1000)])
  await poke($)
  expect(await paneTexts($, 'desktop')).toContain('Plan limits: 5h 97% · 7d 60%')
  // No windows in this response: the last reading stays.
  rateLimits = []
  await poke($)
  expect(await paneTexts($, 'desktop')).toContain('Plan limits: 5h 97% · 7d 60%')
  // The 5-hour window reset: the newer, lower reading wins.
  rateLimits = [{ kind: 'five_hour', percentUsed: 3 }, { kind: 'seven_day', percentUsed: 61 }]
  await poke($)
  expect(await paneTexts($, 'desktop')).toContain('Plan limits: 5h 3% · 7d 61%')
  // /clear: a new ledger with no limits until the next reading.
  sessionIdNow = 'sess-2'
  rateLimits = []
  await poke($)
  expect((await paneTexts($, 'desktop')).join('\n')).not.toContain('Plan limits')
  sessionIdNow = 'sess-1'
})

test('diff: insert, delete, change with word marks, context and line numbers', async () => {
  const ins = diff('a\nb\nc\n', 'a\nb\nNEW\nc\n', 10)
  expect(ins.add).toBe(1)
  expect(ins.del).toBe(0)
  expect(ins.lines.map(l => `${l.kind}${l.n}`)).toEqual([' 10', ' 11', '+12', ' 12'])

  const del = diff('a\nb\nc', 'a\nc', null)
  expect(del.lines.map(l => `${l.kind}${l.text}`)).toEqual([' a', '-b', ' c'])
  expect(del.lines.every(l => l.n === null)).toBe(true)

  const chg = diff('const right = fit(counts, w)', 'const right = fit(advisor, w)', 88)
  expect(chg.lines.map(l => l.kind)).toEqual(['-', '+'])
  const [minus, plus] = chg.lines
  expect(minus?.text.slice(...(minus?.mark ?? [0, 0]))).toBe('counts')
  expect(plus?.text.slice(...(plus?.mark ?? [0, 0]))).toBe('advisor')

  // Far from a change, kept lines are left out: 2 lines of context each side.
  const far = diff('1\n2\n3\n4\n5\n6\n7\n8', '1\n2\n3\n4\nX\n6\n7\n8', 1)
  expect(far.lines.map(l => l.text)).toEqual(['3', '4', '5', 'X', '6', '7'])

  expect(diff('', '', 1)).toEqual({ lines: [], add: 0, del: 0, cut: 0 })
  // A big rewrite: no LCS table; every line counts; the hunk is capped at 40 lines.
  const big = diff(Array.from({ length: 300 }, (_, i) => `old ${i}`).join('\n'), Array.from({ length: 300 }, (_, i) => `new ${i}`).join('\n'), 1)
  expect(big.add).toBe(300)
  expect(big.del).toBe(300)
  expect(big.lines.length).toBe(40)
  expect(big.cut).toBe(560)

  expect(markOf('same', 'same')).toBeNull()
  expect(markOf('abc', 'xyz')).toBeNull()
  expect(lineOf('a\nb\nc', 'c')).toBe(3)
  expect(lineOf('a', 'z')).toBeNull()
})

test('files: touch, change and commit; roles by type', async () => {
  let l = touch([], '/r/a.ts', 'main', 1, true)
  expect(l[0]).toMatchObject({ state: 'read', isActive: true, agents: ['main'] })
  l = change(l, '/r/a.ts', 'w1', 2, { lines: [{ kind: '+', n: 1, text: 'x' }], cut: 0 }, 1, 0)
  expect(l[0]).toMatchObject({ state: 'changed', isActive: false, agents: ['main', 'w1'], add: 1, del: 0 })
  expect(l[0]?.hunks[0]?.agent).toBe('w1')
  l = touch(l, '/r/b.ts', 'main', 3, false)
  l = commit(l)
  expect(l.map(f => f.state)).toEqual(['committed', 'read'])
  expect(roleOf(undefined)).toBe('main')
  expect(roleOf('general-purpose')).toBe('worker')
  expect(roleOf('code-reviewer')).toBe('reviewer')
  expect(roleOf('Explore')).toBe('explore')
})

test('pane: files in the lane of the agent that touched them; a press opens the diff; chips hide a role', async ($, on) => {
  const now = Date.now()
  const disk = new Map<string, string>([['/repo/src/b.ts', 'one\nconst x = fit(counts)\nthree\n']])
  on('fs.read', (_: unknown, e: { path: string }) => {
    const text = disk.get(e.path)
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: {} }))
  await setup($, on, () => [agent('r1', 'running', 0.5, now - 5_000, 'code-reviewer')])
  await poke($)

  await $.tool.call({ tool: 'Read', file_path: '/src/a.ts' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/b.ts', old_string: 'const x = fit(counts)', new_string: 'const x = fit(advisor)', agentId: 'r1' } as never)

  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The main lane has a.ts (read); the reviewer's lane has b.ts with its counts.
  expect((await ui.find({ key: 'lane-main' }))?.text).toContain('a.ts')
  expect((await ui.find({ key: 'lane-main' }))?.text).not.toContain('b.ts')
  const row = await ui.find({ key: 'f-r1|/repo/src/b.ts' })
  expect(row?.text).toContain('b.ts')
  expect(row?.text).toContain('+1')
  expect(row?.text).toContain('−1')
  expect((await ui.find({ type: 'Text', text: 'REVIEWER' }))).toBeDefined()
  await ui.press({ key: 'f-r1|/repo/src/b.ts' })
  await ui.unmount()

  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const all = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
  expect(all.join('|')).toContain('line 2')
  // The changed words carry the stronger mark.
  const marks = (await ui.findAll({ type: 'Text' })).filter(t => t.props.backgroundColor !== undefined).map(t => t.text)
  expect(marks).toEqual(['counts', 'advisor'])
  // Hide reviewers: the lane goes; the totals stay.
  await ui.press({ key: 'role-reviewer' })
  await ui.unmount()
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 'f-r1|/repo/src/b.ts' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Text' })).map(t => t.text ?? '').join('|')).toContain('1 subagent')
  await ui.unmount()

  // Show reviewers again; a commit marks the changed file committed (terminal: a plain list).
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'role-reviewer' })
  await ui.unmount()
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "x"' })
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: /a\.ts/ }))?.text).toContain('○')
  expect((await term.find({ type: 'Text', text: /b\.ts/ }))?.text).toContain('✔')
  await term.unmount()
})

test('review fixes: a one-line change in a long file stays one line; each lane shows its own part', async () => {
  const before = Array.from({ length: 300 }, (_, i) => `line ${i}`)
  const after = [...before]
  after[150] = 'changed'
  const d = diff(before.join('\n'), after.join('\n'), 1)
  expect([d.add, d.del]).toEqual([1, 1])
  expect(d.lines.filter(l => l.kind !== ' ').map(l => `${l.kind}${l.n}`)).toEqual(['-151', '+151'])
  // A huge single line is clipped.
  expect(diff('x', 'y'.repeat(5000), 1).lines[1]?.text.length).toBe(400)

  let l = touch([], '/r/a.ts', 'e1', 1, false)
  l = change(l, '/r/a.ts', 'main', 2, null, 5, 2)
  expect(l[0]?.by.e1).toEqual({ state: 'read', add: 0, del: 0, isActive: false })
  expect(l[0]?.by.main).toEqual({ state: 'changed', add: 5, del: 2, isActive: false })
  expect(commit(l)[0]?.by.main?.state).toBe('committed')
  expect(commit(l)[0]?.by.e1?.state).toBe('read')

  expect(utf8Bytes('aé日🙂')).toBe(1 + 2 + 3 + 4)
})

test('card: the role once, the model in its family color, the status word in its color', async ($, on) => {
  const now = Date.now()
  await setup($, on, () => [agent('r1', 'running', 0.5, now - 5_000, 'reviewer'), agent('g1', 'completed', 0.1, now - 9_000, 'general-purpose')])
  await poke($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text ?? '')
  // In each card the role shows once; a type that adds nothing ("reviewer", "general-purpose") is left out.
  const r1 = (await ui.find({ key: 'r1' }))?.text ?? ''
  expect(r1.match(/reviewer/gi)?.length).toBe(1)
  expect((await ui.find({ key: 'g1' }))?.text).not.toContain('general-purpose')
  expect(texts.length).toBeGreaterThan(0)
  const model = (await ui.findAll({ type: 'Text', text: 'sonnet 5.5' }))
  expect(model.length).toBe(2)
  expect(model.every(m => m.props.color === MODEL_HEX.sonnet)).toBe(true)
  const words = await ui.findAll({ type: 'Text', text: /^(running|done)$/ })
  expect(words.map(w => `${w.text}:${String(w.props.color)}`).sort()).toEqual(['done:success', 'running:suggestion'])
  await ui.unmount()
  expect(familyOf('claude-opus-5-5')).toBe('opus')
  expect(familyOf(null)).toBe('other')
  expect(typeLabel('Explore')).toBe('')
  expect(typeLabel('code-reviewer')).toBe('code-reviewer')
  expect(typeLabel('db-migrator')).toBe('db-migrator')
  expect(typeLabel('review')).toBe('')
  expect(typeLabel('explorer')).toBe('')
  expect(typeLabel('Plan')).toBe('Plan')
})

test('card at terminal width: the token row is one cut line, the status word stays whole', async ($, on) => {
  const now = Date.now()
  await setup($, on, () => [agent('r1', 'running', 0.5, now - 5_000, 'code-reviewer')])
  await poke($)
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 40 }, surface: 'terminal' })
  const tok = await ui.find({ type: 'Text', text: /tok · in/ })
  expect(tok?.props?.wrap).toBe('end')
  expect(tok?.props?.maxLines).toBe(1)
  const word = (await ui.findAll({ type: 'Text', text: 'running' })).find(w => w.props.color === 'suggestion')
  expect(word?.props?.wrap).toBe('clip')
  // The only shrinking part of the row holds the type.
  expect((await ui.find({ type: 'Text', text: 'code-reviewer' }))?.props?.wrap).toBe('end')
  await ui.unmount()
})
