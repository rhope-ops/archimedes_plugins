# archimedes_plugins

Personal Claude Code mods that show what Claude does now. They need Claude Code 2.1.287 or newer.

| Mod | What it shows | Command |
|---|---|---|
| task-progress | A row above the prompt: elapsed time, the tool that runs now, steps, tool calls, running subagents | `/progress` shows or hides it |
| agents-pane | A side pane with each subagent: task, type, model, tokens, estimated cost | `/agents-pane` |
| advisor-watch | A toast each time the advisor is consulted, with the caller's model; counts in the status line | `/advisor-stats` |
| file-tree | A side pane of files: ○ read, ● changed, ✔ committed, ◐ in use now | `/files` |
| cache-tax | A row above the prompt 5 minutes before the prompt cache goes cold, and a red row after | none |

Costs are estimates from Claude Code, not a bill.

## Install

1. Open Claude Code in a terminal on your computer.
2. Type this line and push Enter. Repeat it for each mod, with the mod name from the table:

```bash
/plugin install task-progress --marketplace rhope-ops/archimedes_plugins
```

3. When Claude Code asks to add the marketplace, type `y`. Then select the scope "user", so that the mod works in all projects.
4. Type `/reload-plugins` and push Enter. The mod shows in the current session.

## Check a mod

```bash
claude plugin validate task-progress
```

```bash
claude plugin test task-progress
```
