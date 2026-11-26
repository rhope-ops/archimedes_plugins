// Pure parts of the file list: roles, the list's caps, and how a touch, a change and a commit update it.

import type { FileEntry, FileHunk } from '../types'

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
  const base: FileEntry = old ?? { path, state: 'read', isActive: false, at: 0, agents: [], add: 0, del: 0, hunks: [] }
  return [...list.filter(f => f.path !== path), fn(base)].slice(-MAX_FILES)
}

const withAgent = (agents: readonly string[], agent: string) => (agents.includes(agent) ? [...agents] : [...agents, agent])

// A tool starts (`isActive` true) or ends (false) on a file.
export function touch(list: readonly FileEntry[], path: string, agent: string, at: number, isActive: boolean): FileEntry[] {
  return upsert(list, path, f => ({ ...f, isActive, at, agents: withAgent(f.agents, agent) }))
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
  }))
}

// After a git commit that worked, the changed files count as committed.
export function commit(list: readonly FileEntry[]): FileEntry[] {
  return list.map(f => (f.state === 'changed' ? { ...f, state: 'committed' } : f))
}

// A path to show: relative to the session folder when inside it, else the last 3 parts.
export function shortPath(path: string, cwd: string): string {
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  if (cwd !== '' && cwd !== '/' && path.startsWith(root)) return path.slice(root.length)
  const parts = path.split('/').filter(p => p !== '')
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path
}
