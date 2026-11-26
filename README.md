# archimedes_plugins

Personal Claude Code mods that show what Claude does now: progress, subagents, advisor calls, files and the prompt cache.

| Mod | What it shows | Command |
|---|---|---|
| task-progress | Above the prompt, 3 rows. Row 1: a spinner and the clock, the goal of the current task (the task in progress, else a short Haiku summary of your prompt), and at the right the time left (nothing until it can estimate), the task count and the percent. Row 2: the file in use now (a subagent's worktree prefix cut off; on a narrow row the folder gives way and the file name stays) with the role of the agent that works on it (main, worker, reviewer, explore, each in its own color), else the tool that runs now, else the running subagents; after the turn, how many files changed. At the right: `advisor ×N` for the session, with one purple ■ per advisor call in this turn, in a right column shared with row 1. Row 3: a meter of 40 boxes. It keeps the same shape in every state; only the color changes: slate while the estimate is learning, blue while running, amber when over the estimate or done slower or faster than it (more than 1.25×), green when done on target, red when stopped or failed. It redraws every 150 ms and never moves back inside a turn. Rows 1 and 2 use one font and size and share a left column, so the goal and the file start at the same place. Terminal: the same 3 rows with block characters | `/progress` shows or hides it; `/progress-stats` shows how accurate the estimate is |
| agents-pane | A side pane, "Agents & files": the session (main conversation, subagents and the total, in tokens and cost, and the `/usage` plan limits), the subagent totals and a cost-share bar, then role chips (press one to hide or show that role), then a lane per agent: the main conversation first, then each subagent, its border in its role color, with its task, cost, role tag (and its type when the type says more), the model in its family color on the desktop (fable gold, opus copper, sonnet steel blue, haiku olive; bold in the terminal), the status word in its status color, run time, and one token row (total, in, out, cache read, write) that ends with … when the pane is narrow. Under each lane, the files that agent touched: ○ read, ● changed, ✔ committed, ◐ in use now, with +added −removed lines. Press a file to open its diff: removed and added lines with line numbers, the changed words marked. Diffs are capped (20 changes per file, 40 lines per change, 300 files). Costs are Claude Code's own estimate, the same as `/cost`. At each turn end it saves those figures and limits (no task text) to `~/.claude/token-log/cost/<session>.json`, for the token-log Stop hook to push; `TOKEN_LOG=off` stops it | `/agents-pane` |
| advisor-watch | Counts advisor calls, for this session and all sessions. Nothing on screen: the task-progress band shows the live count | `/advisor-stats` |
| cache-tax | A row above the prompt before the prompt cache goes cold (5 min before for the 1-hour cache, 1 min before for the 5-minute cache), and a red row after | none |

**file-tree was removed in this version**: its files and diffs are now in agents-pane. If you installed it, remove it:

```bash
claude plugin uninstall file-tree@archimedes-plugins
```

Costs are estimates from Claude Code (the same as `/cost`), not a bill. On a subscription plan they show what the same use would cost on the API; your real limit is the plan's usage limit. Prices: platform.claude.com/docs/en/about-claude/pricing.

## How task-progress estimates the time left

1. If the turn has a task list (TaskCreate, TaskUpdate or TodoWrite) and at least 1 task is done in this turn: time per done task × tasks left. The band shows "(by tasks)".
2. Otherwise, from history: of your past turns with a similar prompt size that ran longer than this turn so far, the median end time. The band shows no time until 3 turns are recorded (the meter sweeps instead), and "longer than usual" when this turn runs longer than all of them. The history is in the plugin store on that computer: a new cloud session starts with none, so there the estimate needs 3 answered turns in that session first.

### The goal line

At the start of each turn with a prompt of 12 characters or more, the mod asks Haiku (low effort, one small call, about $0.001) for a 3 to 7 word goal (one small call per turn, billed like any other Haiku request and counted in `/cost`). Your prompt text goes only into that call. The answer is kept in the session's state, not in the turn history. A shorter prompt ("yes", "go on") keeps the goal of the turn before. When a task is in progress (TaskUpdate or TodoWrite), its name shows instead.

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
