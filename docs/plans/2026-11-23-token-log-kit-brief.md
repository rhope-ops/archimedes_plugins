# Brief: token log, streamlined, with /cost and /usage records (kit; steps 2 and 3.2 of the token-log plan)

Repos for this session: `rhope-ops/archimedes_lever` (the kit) and `rhope-ops/token-logs` (private, new, empty). If one is missing, call add_repo for it; the owner may see an approval card.

## Authority

- The owner approved the plan on 2026-11-23 and changed it on 2026-11-24 (question dialogs). Plan: https://github.com/rhope-ops/archimedes_plugins/blob/claude/practical-meitner-m5f71j/docs/plans/2026-11-23-token-log.md
- Follow archimedes_lever's AGENTS.md. The token-log scripts are scripts a hook runs: lane C. Show the owner the diff and the review, then ask before the merge.
- Add a row to docs/DECISIONS.md with the date and scope.
- The owner is on a subscription plan. For them the plan's usage limit is what is paid; dollars are an estimate (kit DECISIONS row of 2026-11-23).

## Part A: streamline the token-log scripts (do this first)

Today there are five files: `scripts/token_log.py`, `token_log_rows.py`, `token_log_report.py`, `token_log_test.py` and `token_log_test_report.py`. The environment's setup script copies the first three, plus `kit.config.json`, to `~/.claude/hooks/`.

1. Map what each file does, its size, and who imports or copies it: the setup script, `scripts/check.sh` self-tests, `scripts/bootstrap.sh`, the hook's self-update, and docs/FILES.md.
2. Propose the smallest layout that keeps each job clear. Example: one hook module plus one report module, and one test file. Give the line counts before and after.
3. Keep the hook's behavior the same. That covers the background push, the temporary index, the retries at 1 and 5 minutes, the coalescing, the self-update and the env settings.
4. List every place that must change with the layout. If the file list in the cloud environment's setup script must change, propose the new script with the update_environment tool; the owner approves it on a card. Make the new script also accept the old file layout, so a session that starts before the merge still installs a working hook.
5. Ask the owner before you merge files. This is lane C.

## Part B: /cost and /usage records

Input: `$TOKEN_LOG_HOME/cost/<session id>.json` (default `~/.claude/token-log/cost/`). The agents-pane mod (0.5.0 merged in rhope-ops/archimedes_plugins#7; 0.6.0 adds `limits`) writes it just after each turn end, from a timer, and once more at session end. JSON, `version: 1`:

- `session_id`, `written_at` (ISO UTC).
- `session_usd`, `main_usd`, `subagents_usd`: Claude Code's `/cost` estimate. `session_usd` and `main_usd` can be null.
- `limits[]`: `window` (`five_hour`, `seven_day`, or a gateway's `spend_limit`), `percent_used` (0 to 100), `resets_at` (ISO, can be null). These are for the whole account, not this session. `limits_read_at` is when they were read; it can be null. The list is empty off a subscription.
- `main`: `turns`, `input`, `output`, `cache_read`, `cache_write`.
- `subagents[]`: `agent_id`, `type`, `model`, `status`, `usd` (can be null), `input`, `output`, `cache_read`, `cache_write`, `started_at`, `ended_at` (can be null).

There is no task text in it. A session without the mod has no file.

Change:

1. In the background push, when the file exists and its `session_id` matches, commit two more files through the temporary index, in the same commit as `sessions/<session id>.csv`:
   - `costs/<session id>.csv`, a snapshot that replaces the old one at each push. Rows: one `main` row, then one row per subagent. Columns: `session_id, written_at, source, agent_id, type, model, status, usd, input, output, cache_read, cache_write, started_at, ended_at, session_usd`.
   - `limits/<session id>.csv`, which grows: one row per window per new `limits_read_at`, deduplicated by (`limits_read_at`, `window`). Columns: `session_id, read_at, window, percent_used, resets_at`. Keep the earlier rows: the series over time is the point.
2. If the JSON does not parse, has no `version: 1`, or names another session: skip it, add a line to push.log, and push the rows as now.
3. Read the file at push time, in the background, not when the hook starts. The mod can write after the Stop hook starts; the retries at 1 and 5 minutes pick up a later write.
4. `--report`:
   - "Plan limits": for each 7-day window (by `resets_at`), the highest `percent_used` seen and when.
   - "Limit used per session (estimate)": for each window, split its rise in `percent_used` across the sessions active in that time, by their share of tokens from `sessions/*.csv`. Label it an estimate. Weigh tokens by model only if the owner agrees, and say what you chose.
   - "Claude Code /cost by week", next to the hook's own estimate. Say which sessions have no record.
5. `--test`: cases for a good file, a bad file, another session's file, no file, a costs snapshot that replaces an older one, limits rows that grow and deduplicate, and the per-session split.

## Part C: push test for the private log repo (step 3.2; before Part B's pull request)

1. In the `rhope-ops/token-logs` checkout, create a branch. Add `test/push-test.txt` (one line: the date and "push test"), commit, and push.
2. Report whether the push worked. If it failed, quote the error line.
3. Delete that test branch again (it is yours and holds no other work).

Do not change the hook's log branch or remote yet. Moving the logs (steps 3.3 to 3.5) waits for the owner's decision after this test.

## Done when

The hook's self-test passes, `scripts/check.sh` passes, a fresh review finds no MAJOR finding, and the owner approves the merge. End with the owner's turn-summary format. Title the session "Kit · Token log streamline and limits · <start date>" and tag it `project:<AGENTS.md Short name>`.
