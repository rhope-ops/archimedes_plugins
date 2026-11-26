// Pure parts of the file list: roles, the list's caps, and how a touch, a change and a commit update it.

import type { AgentFile, FileEntry, FileHunk } from '../types'

// What an agent does, by its type. Fixed colors per role (the task-progress band uses the same).
export type Role = 'main' | 'worker' | 'reviewer' | 'explore'
export const ROLES: readonly Role[] = ['main', 'worker', 'reviewer', 'explore']
export function roleOf(type: string | undefined): Role {
  if (type === undefined || type === '' || type === 'main') return 'main'
  const t = type.toLowerCase()
  if (t.includes('review')) return 'reviewer'
  if (t === 'explore' || t === 'plan' || t.includes('explor') || t.includes('research')) return 'explore'
  return 'worker'
}
export const ROLE_HEX: Record<Role, string> = {
  main: '#8b6cff',
  worker: '#14a8a2',
  reviewer: '#d9479c',
  explore: '#8a98ae',
}
export const ROLE_NAMED: Record<Role, string> = {
  main: 'blueBright',
  worker: 'cyanBright',
  reviewer: 'magenta',
  explore: 'gray',
}

// Model family colors: one each, apart from the role colors and the state colors.
export type Family = 'fable' | 'opus' | 'sonnet' | 'haiku' | 'other'
export function familyOf(model: string | null): Family {
  const m = /(fable|opus|sonnet|haiku)/i.exec(model ?? '')
  return m ? (m[1]?.toLowerCase() as Family) : 'other'
}
export const MODEL_HEX: Record<Family, string> = {
  fable: '#c9a227',
  opus: '#c2703d',
  sonnet: '#4a8fc2',
  haiku: '#7fa650',
  other: '#8a94a6',
}
export const MODEL_NAMED: Record<Family, string> = {
  fable: 'yellowBright',
  opus: 'redBright',
  sonnet: 'blue',
  haiku: 'greenBright',
  other: 'gray',
}

// The agent type shown beside the role tag: only when it says more than the role word does.
export function typeLabel(type: string): string {
  const t = type.trim()
  const role = roleOf(t)
  const bare = t.toLowerCase().replace(/[-_\s]+/g, '')
  if (bare === role || bare === `${role}s` || bare === 'generalpurpose' || bare === 'main') return ''
  return t
}

// Diff colors: added and removed lines, and the stronger mark on the changed words.
export const DIFF = {
  addBg: '#2ea86522',
  addMark: '#2ea86566',
  addFg: '#2ea865',
  delBg: '#e0525222',
  delMark: '#e0525266',
  delFg: '#e05252',
}

export const MAX_FILES = 300
export const MAX_HUNKS = 20
// Old file text read for a diff: at most this many bytes. A longer file gets counts only.
export const READ_CAP = 256 * 1024

export const READS = new Set(['Read', 'NotebookRead'])
export const WRITES = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

// A real `git commit` (not commit-tree, --dry-run, or the word in a path or message).
export const COMMIT = /(^|[;&|]\s*)git\s+((-[cC]\s+\S+|--?[\w-]+(=\S+)?)\s+)*commit(?![-\w])(?![^;&|]*--dry-run)/

function upsert(list: readonly FileEntry[], path: string, fn: (f: FileEntry) => FileEntry): FileEntry[] {
  const old = list.find(f => f.path === path)
  const base: FileEntry = old ?? { path, state: 'read', isActive: false, at: 0, agents: [], add: 0, del: 0, hunks: [], by: {} }
  return [...list.filter(f => f.path !== path), fn(base)].slice(-MAX_FILES)
}

const withAgent = (agents: readonly string[], agent: string) => (agents.includes(agent) ? [...agents] : [...agents, agent])
const NONE: AgentFile = { state: 'read', add: 0, del: 0, isActive: false }
const mine = (f: FileEntry, agent: string): AgentFile => f.by[agent] ?? NONE

// A tool starts (`isActive` true) or ends (false) on a file.
export function touch(list: readonly FileEntry[], path: string, agent: string, at: number, isActive: boolean): FileEntry[] {
  return upsert(list, path, f => ({
    ...f,
    isActive,
    at,
    agents: withAgent(f.agents, agent),
    by: { ...f.by, [agent]: { ...mine(f, agent), isActive } },
  }))
}

// A change that worked: the file counts as changed, with its hunk (newest last, capped).
export function change(
  list: readonly FileEntry[],
  path: string,
  agent: string,
  at: number,
  hunk: Omit<FileHunk, 'agent' | 'at'> | null,
  add: number,
  del: number,
): FileEntry[] {
  return upsert(list, path, f => ({
    ...f,
    state: 'changed',
    isActive: false,
    at,
    agents: withAgent(f.agents, agent),
    add: f.add + add,
    del: f.del + del,
    hunks: hunk === null || hunk.lines.length === 0 ? f.hunks : [...f.hunks, { ...hunk, agent, at }].slice(-MAX_HUNKS),
    by: { ...f.by, [agent]: { state: 'changed', add: mine(f, agent).add + add, del: mine(f, agent).del + del, isActive: false } },
  }))
}

// After a git commit that worked, the changed files count as committed.
export function commit(list: readonly FileEntry[]): FileEntry[] {
  return list.map(f =>
    f.state === 'changed'
      ? {
          ...f,
          state: 'committed',
          by: Object.fromEntries(Object.entries(f.by).map(([k, v]) => [k, v.state === 'changed' ? { ...v, state: 'committed' } : v])),
        }
      : f,
  )
}

// UTF-8 bytes of a text, without TextEncoder: the size the read cap counts.
export function utf8Bytes(text: string): number {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

// A path to show: relative to the session folder when inside it, else the last 3 parts.
export function shortPath(path: string, cwd: string): string {
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  if (cwd !== '' && cwd !== '/' && path.startsWith(root)) return path.slice(root.length)
  const parts = path.split('/').filter(p => p !== '')
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path
}
