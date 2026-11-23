# archimedes_plugins

Personal Claude Code mods that show what Claude does now: progress, subagents, advisor calls, files and the prompt cache.

| Mod | What it shows | Command |
|---|---|---|
| task-progress | A row above the prompt: elapsed time, the tool that runs now, steps, tool calls, running subagents | `/progress` shows or hides it |
| agents-pane | A side pane with each subagent: task, type, model, tokens, estimated cost | `/agents-pane` |
| advisor-watch | A toast each time the advisor is consulted, with the caller's model; counts in the status line | `/advisor-stats` |
| file-tree | A side pane of files: ○ read, ● changed, ✔ committed, ◐ in use now | `/files` |
| cache-tax | A row above the prompt before the prompt cache goes cold (5 min before for the 1-hour cache, 1 min before for the 5-minute cache), and a red row after | none |

Costs are estimates from Claude Code, not a bill.

## Install on your computer

Plugins that you install once with the "user" scope work in the terminal, in desktop app local sessions and in VS Code on the same computer.

### In the desktop app

1. In a Code session, click **+** next to the prompt box.
2. Click **Plugins**, then **Browse plugins**. If you do not see **Browse plugins**, click **Manage plugins**.
3. Add the marketplace `rhope-ops/archimedes_plugins`.
4. Install each mod that you want from the table above.

### In a terminal (outside Claude Code)

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
