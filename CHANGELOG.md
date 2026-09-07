# Changelog

## 0.2.1 — 2026-09-07

- Read cap on persisted outputs: an unbounded Read of a saved tool output (Claude Code's `tool-results/<id>.txt`,
  the guard's own `tokenbrake/out/<id>.txt`) is capped at `persistedLimitLines` (default 80) whatever its size,
  with a note saying why. Reading those whole carried 96% of the untrimmed audit arm's context and 24% of the
  session that wrote the rule; the general `readMaxBytes` default stays at 60,000, because lowering it was
  measured and cost more (`AB-TASK.md`).
- `scripts/sweep-readmax.mjs` and `scripts/sim-persisted.mjs`: the trigger sweep, and the replay that shows what
  the persisted cap would have kept out of the sessions on this machine.
- Project-scope install on this repository, pinned to `guard.js` by a test.

## 0.2.0 — 2026-09-06

- Own repository, `33kain/tokenbrake`, split out of `33kain/contexa` with the history.
- Claude Code plugin: `.claude-plugin/plugin.json`, `hooks/hooks.json` (exec form, `${CLAUDE_PLUGIN_ROOT}/guard.js`),
  and a marketplace file in the same repository, so `claude plugin marketplace add 33kain/tokenbrake` then
  `claude plugin install tokenbrake@tokenbrake` installs it without touching a settings file.
- Measured on an identical Cowork task, hooks off against on: Fable 5.1 $8.40 → $7.02, Opus 5 $5.97 → $3.77,
  identical answers (`AB-TASK.md`).
- No change to the guard, the CLI or the report.

## 0.1.0 — 2026-09-05

- First publish. PostToolUse trim of shell output over 6,000 characters (head, tail, error-looking middle lines,
  full text saved to a file), PreToolUse cap of unbounded Reads on files over 60 KB, `init`, `status`,
  `uninstall`, `clean`, and `report` from the session transcript. Live-verified on Linux, Claude Code 2.1.261.
