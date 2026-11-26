# Plan: band A2 + pane B1 (Archimedes) — 2026-11-26

## Context
The user does not like the file-tree pane and wants agents-pane tweaked; on the desktop both go into one pane. The task-progress band and the advisor-watch status line go into one 3-line band. The bar must stay boxy in every state, change color by state, and move smoothly.
Proposals page: https://claude.ai/artifact/E2Zuo6qv4puqVfzfJK9q7x

**DEC (2026-11-26, scope: this redesign):** band = A2 Cell meter; pane = B1 Agent lanes; diffs = own rows with word marks.

Root causes found in code:
- `task-progress/hooks/register.tsx` `startTicker` redraws every 1000 ms → steps.
- `frac = elapsed / (elapsed + leftMs)` is recomputed each tick → jumps forward and back.
- Done state uses a different color set (`success`/`warning`) and a full █ run; terminal shows a thin bar.

## Source items (in / out / later)
| Item from the request | Status |
|---|---|
| Line 1: spinner + duration + goal + ETA + "ETA learning" | in |
| Line 2: file in use (left, agent color) or fallback; advisor count (right) | in |
| Line 3: boxy bar, same shape always, color by state, smooth | in |
| Advisor status line + toast removed ("streamlined") | in |
| One pane: agents color-coded by role, files per agent, diffs | in |
| Terminal look of the band | in (same 3 lines, block glyphs) |
| Terminal look of the pane | later (pane is desktop-first; terminal keeps a plain list) |

## 1. task-progress 0.8.0 (band A2)
Files: `task-progress/hooks/register.tsx`, `view.ts`, `types/index.d.ts`, tests.
- **3 rows** (desktop render branch):
  1. spinner (SPIN, ✓/●/✕ when ended) · `m:ss` · goal · right: ETA text + "ETA learning n/5" chip (existing `estimate()` in `eta.ts`).
  2. left: file in use with a role-color square; fallback order: file → tool + target (existing `describe()`) → running subagent count → after turn "N files · +a −d". Right: `advisor ×N` + one pip per call this turn.
  3. cell meter: 40 Boxes (`flexGrow=1`, `backgroundColor`), one fixed height. Learning: a 6-cell block sweeps. Done: all cells, state color.
- **State colors (one meaning each):** learning = slate, running = blue, over / done slower = amber, done on target = green, failed/stopped = red. Hex on desktop, named colors on terminal.
- **Smooth fill:** tick 150 ms while running (was 1000). Add `shownFrac` to `Progress` (shape tag → `progress-6`): `shownFrac = max(shownFrac, shownFrac + (target − shownFrac) × 0.2)`; never goes back inside a turn. New pure fn `ease()` in `view.ts`.
- **Advisor count:** move the `turn.step` `serverToolUses` count from advisor-watch into task-progress (atoms `advisorSession`, `advisorTurn`).
- **File + agent role on line 2:** `tool.call` on Read/Edit/MultiEdit/Write/NotebookEdit sets `currentFile` + `agentId`; `agent.spawn` maps `agentId → type`; shared `roleOf(type)` (below).
- **Terminal:** same 3 rows; bar = █ cells colored by state, ░ track; no thin bar.

## 2. advisor-watch 0.3.0
- Remove the status-line entry and the toast. Keep `/advisor-stats` and the all-time total (its store key stays, no data loss).

## 3. agents-pane 0.7.0 (pane B1) — absorbs file-tree
Files: `agents-pane/hooks/register.tsx`, `pricing.ts`, new `files.ts` + `diff.ts`, `types/index.d.ts`, tests.
- **Keep unchanged:** SESSION block (tokens, cost, 5 h / 7 d limits), ledger, `/cost` record for token-log.
- **Role colors:** `roleOf(type)`: main (no agentId) → main/violet; type contains "review" → reviewer/magenta; `Explore`/`Plan` → explore/slate; else → worker/teal. Replaces index-based `typeColor` for lanes; the cost-share bar uses the same colors.
- **Role chips:** Buttons that hide/show a role (atom `hiddenRoles`).
- **Lanes:** one per agent (main first): status icon, role, name, run time, task; then its files.
- **File tracking** (from file-tree's `tool.call` hook): per path → agents, state (read / changed / committed via existing `COMMIT` regex), +/− counts, hunks. Atom shape `files-2`, max 300 files, max 20 hunks × 40 lines per file.
- **Diffs:** Edit → old/new string; MultiEdit → each edit; Write → read old file with `$.fs` first (cap 256 KB, else counts only). Line numbers from the old text position when the file read works, else none. `diff.ts`: line LCS + word marks on paired −/+ lines. Each file row is a Button; press opens/closes its diff (atom `openFile`).
- Pane title → "Agents & files"; opens at first spawn **or** first file touch.

## 4. file-tree — retired
- Remove the folder and its marketplace entry; README tells users to run `claude plugin uninstall file-tree@archimedes-plugins`.

## 5. Docs
- README table + `.claude-plugin/marketplace.json` descriptions; versions bumped.
- Save this plan as `docs/plans/2026-11-26-band-and-pane.md`.

## Verification
- `claude plugin validate` + `claude plugin test` for task-progress, agents-pane, advisor-watch (existing suites updated: `band.test.tsx`, `view.test.tsx`, `pane.test.tsx`, `quiet.test.ts`; file-tree tests move into agents-pane).
- New unit tests: `ease()` never goes back; state→color map; `roleOf()`; `diff.ts` (insert, delete, change with word marks, empty, large-file cap).
- Load the changed mods in this session (hot-reload) and run a turn with one worker and one reviewer subagent that edit a scratch file: check band rows, colors per state, pane lanes, diffs.
- Independent review in a fresh context (code-review skill) before the PR.
- Ship with the `ship` skill: branch `claude/beautiful-bardeen-w3mi1g`, PR, watch CI.

## GAPS
- **Terminal pane parity** — cost: medium; benefit: same view in terminal. Left for later.
- **Redraw cost at 150 ms** — cost: low; risk: CPU on slow machines. Mitigation: tick only while a turn runs; fall back to 300 ms if tests show lag.
- **Installed file-tree stays** on users' machines after the repo removes it — needs the uninstall step in README.
- **Diff memory** — capped (above); no cap = risk of large state.

## Assumptions
- Project short name "Archimedes" (no AGENTS.md in repo). Confidence: medium.
- Desktop side pane is about 320–380 px wide. Confidence: medium.
