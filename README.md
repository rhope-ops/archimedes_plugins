# archimedes_plugins

Personal Claude Code mods that show what Claude does now: progress, subagents, advisor calls, files and the prompt cache.

| Mod | What it shows | Command |
|---|---|---|
| task-progress | Desktop app: row 1 shows the state and clock at the left, the goal of the current task in the middle (the task in progress, else a short Haiku summary of your prompt) with the tool that runs now in gray after it (cut with … when too long), and steps, tools and time left fixed at the right; row 2, right under it, is a thin shaded block bar (█ fill, ▓▒ edge, ░ track; a moving ░▒▓█▓▒░ glow while the estimate is still learning); after the turn the estimate shows ✓ (green, when the larger time is at most 1.25× the smaller), "N× slower" or "N× faster" (yellow up to the shown 2.0×, red beyond). Terminal: two rows across the full width, with the same verdict | `/progress` shows or hides it; `/progress-stats` shows how accurate the estimate is |
| agents-pane | A side pane: session totals (agents by status, tokens split into input, output, cache read and cache write, agent time, wall clock, cost), a cost-share bar and one row per agent type, then a card for every subagent, running and finished, colored by its type. The totals keep every agent, also after Claude Code drops it from its list. Costs are Claude Code's own estimate, the same as `/cost` | `/agents-pane` |
| advisor-watch | Nothing until the advisor is used in the session. Then a toast for each call, with the caller's model, and a short `advisor ×N` in the status line | `/advisor-stats` (also the all-time count) |
| file-tree | A side pane of files: ○ read, ● changed, ✔ committed, ◐ in use now | `/files` |
| cache-tax | A row above the prompt before the prompt cache goes cold (5 min before for the 1-hour cache, 1 min before for the 5-minute cache), and a red row after | none |

Costs are estimates from Claude Code (the same as `/cost`), not a bill. On a subscription plan they show what the same use would cost on the API; your real limit is the plan's usage limit. Prices: platform.claude.com/docs/en/about-claude/pricing.

## How task-progress estimates the time left

1. If the turn has a task list (TaskCreate, TaskUpdate or TodoWrite) and at least 1 task is done in this turn: time per done task × tasks left. The band shows "(by tasks)".
2. Otherwise, from history: of your past turns with a similar prompt size that ran longer than this turn so far, the median end time. The band shows "ETA learning n/5" until 5 turns are recorded, and "longer than usual" when this turn runs longer than all of them.

### The goal line

At the start of each turn with a prompt of 12 characters or more, the mod asks Haiku (low effort, one small call, about $0.001) for a 3 to 7 word goal. Your prompt text goes only into that call. The answer stays in the session's state; it is not written to disk. A shorter prompt ("yes", "go on") keeps the goal of the turn before. When a task is in progress (TaskUpdate or TodoWrite), its name shows instead.

At the end of each turn that ends with an answer, the mod records the turn (time, steps, tool calls and prompt length, not the prompt text) and the error of its first estimate. It keeps the last 300 turns in the plugin store on that computer. `/progress-stats` shows the median error of the last 20 turns against the 20 turns before them.

## Install on your computer

Plugins that you install once with the "user" scope work in the terminal, in desktop app local sessions and in VS Code on the same computer.

### In the desktop app

1. In a Code session, click **+** next to the prompt box.
2. Click **Plugins**, then **Browse plugins**. If you do not see **Browse plugins**, click **Manage plugins**.
3. Add the marketplace `rhope-ops/archimedes_plugins`.
4. Install each mod that you want from the table above.

### In a terminal (outside Claude Code)

This needs the separate Claude Code command-line tool. The desktop app does not add the `claude` command to PowerShell or to a terminal. If PowerShell says that `claude` is not a cmdlet, use the desktop app steps above, or install the command-line tool first (see the setup page of the Claude Code docs).

1. Type this command and push Enter. You see that the marketplace `archimedes-plugins` is added.

```bash
claude plugin marketplace add rhope-ops/archimedes_plugins
```

2. Type this command and push Enter. Repeat it for each mod, with the mod name from the table.

```bash
claude plugin install task-progress@archimedes-plugins
```

## Cloud sessions

Cloud sessions do not get plugins from your computer. The "Work" cloud environment's setup script clones this repo and loads each mod through `CLAUDE_CODE_PLUGIN_DIRS`.

## Check a mod

```bash
claude plugin validate task-progress
```

```bash
claude plugin test task-progress
```
