# Changelog

## 0.2.2 — 2026-09-09

- **The guard now sees failing commands.** For Bash, `PostToolUse` fires only on exit 0; a non-zero exit is
  `PostToolUseFailure`, a different event the guard was not registered for. So every failing test run,
  the one output the trim exists for, entered whole, in every debugging round measured so far. `init`,
  `init --project` and the plugin now register `PostToolUseFailure` on `Bash|PowerShell` with the same
  guard; the trimmed error keeps its `Exit code N` first line. Re-run `npx tokenbrake init` (or
  `init --project`) to pick it up; `status` says "missing" until you do.
- The shell trim keeps up to `errorContextLines` (default 3) lines after each error-looking line from the
  omitted middle, stopping at a blank line: the assertion, the expected/actual pair, the first stack frame.
  A `FAIL` line alone names the test, and a model that gets only the name comes back for the rest with a
  whole extra request. Touching windows merge; gaps show as one `…` line. Set it to 0 for the old behaviour.
  The budget runs in that order too: flagged lines and context first, then head and tail fill what is left
  of `maxChars` (down to ten lines each), so a trimmed result now stays within `maxChars` instead of near it.
  Context that would take more than half the budget on its own is dropped and the flagged lines stand alone.
- A line that opens with a pass marker (`ok`, `PASS`, `✓`) is never flagged as error-looking, whatever its
  test name says. Found on the CONTEXA suite: "ok   error render call passes resp through" had been filling
  the `keepErrorLines` budget and the real `FAIL` lines further down never made the cut.
- `report --compare <A> <B>`: two sessions side by side, the `AB-TASK.md` table as one command. Every report
  also carries "At list price": the session's cost computed per request at its model's list price, cache
  writes at the 1h rate; reproduces the Opus 5 A/B arms' session records to the sixth decimal.
- `report` prints a "Repeat reads" line: same-shape reads (a Read of one path and range, or a single-file
  `cat`/`sed -n`/`head`/`tail`) that returned a file already in context in the same compaction window,
  with the tokens re-entered and carried. Measured, not acted on.
- `LANDSCAPE.md`: the other tools in the space, how each measures itself, and where tokenbrake is behind
  or ahead.

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
