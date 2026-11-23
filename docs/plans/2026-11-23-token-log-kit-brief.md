# Brief: /cost records in the token log (kit, step 2 of the token-log plan)

Start a new cloud session with the repository `rhope-ops/archimedes_lever`. Paste this file as the first message.

## Authority

- The owner approved this work on 2026-11-23 (question dialog "Approve all 3", in the session "archimedes_plugins · Subagent pane totals, goal line · 2026-11-23"). The plan: https://github.com/rhope-ops/archimedes_plugins/blob/claude/practical-meitner-m5f71j/docs/plans/2026-11-23-token-log.md (on the default branch after rhope-ops/archimedes_plugins#7 merges).
- `scripts/token_log.py` is a script that a hook runs, so this is a lane C change. Show the owner the diff and the review, then ask before the merge.
- Follow this repo's AGENTS.md. Add a row to docs/DECISIONS.md with the date and scope.

## Input file (written by the agents-pane mod 0.5.0)

`$TOKEN_LOG_HOME/cost/<session id>.json`. The default is `~/.claude/token-log/cost/`, the folder the hook already uses for push.log. The mod rewrites the file just after each turn end, from a timer, so the turn never waits for the disk. It is JSON, `version: 1`:

- `session_id`, `written_at` (ISO UTC).
- `session_usd`, `main_usd` and `subagents_usd`: Claude Code's `/cost` estimate. `session_usd` and `main_usd` can be null.
- `main`: `turns`, `input`, `output`, `cache_read`, `cache_write`.
- `subagents[]`: `agent_id`, `type`, `model`, `status`, `usd` (can be null), `input`, `output`, `cache_read`, `cache_write`, `started_at`, `ended_at` (can be null).

There is no task text in it. A session without the mod has no file.

## Change

1. In the background push, when the file exists and its `session_id` matches, write `costs/<session id>.csv` in the same commit as `sessions/<session id>.csv`. Use the temporary index, as now.
   - Rows: one `main` row, then one row per subagent.
   - Columns: `session_id, written_at, source (main, subagent), agent_id, type, model, status, usd, input, output, cache_read, cache_write, started_at, ended_at, session_usd`.
   - The file is a snapshot. Replace it at each push; do not merge it.
2. If the JSON does not parse, has no `version: 1`, or names another session: skip it, add a line to push.log, and push the rows as now.
3. The mod writes at the turn end, and the hook may run first. So read the file at push time (in the background), not when the hook starts. The retry pushes at 1 and 5 minutes pick up a later write.
4. `--report`: add a table "Claude Code /cost estimate by week": the sum of the latest `session_usd` of each session, next to the hook's own estimate. Say which sessions have no record.
5. `--test`: add cases for a good file, a bad file, another session's file, no file, and a record that replaces an older one.

## Not in this step

Moving the logs to a private repo (step 3) waits for the owner's repo and a push test. Do not change `TOKEN_LOG_BRANCH` or the remote here.

## Done when

`python3 scripts/token_log.py --test` passes, `scripts/check.sh` passes, a fresh review finds no MAJOR finding, and the owner approves the merge.
