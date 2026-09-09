# Changelog

## 0.2.3 — 2026-09-09

- **A file excerpt is a read.** A shell command that only prints one file (`cat`, `sed -n` with a range,
  `head`, `tail`, no pipe) is treated like the Read tool: untouched up to `readMaxBytes`, capped at the
  first `readLimitLines` lines above it with a note. Until now the same bytes through `sed -n` were trimmed
  to head, tail and error-looking lines, the wrong three things to keep from source, and a model that met
  that once sized every read after it to stay under `maxChars`: eighty-line `sed` ranges, 91 requests,
  twice the bill on the three-arm audit (`AB-TASK.md`). The Read cap's note now also says that a few large
  ranges cost less than many small ones.
- `report` credits a trim only when the model saw it. A ledger row means the guard offered a replacement;
  above Claude Code's own ~30,000-character ceiling the model gets a 2 KB persisted-output preview instead,
  and on `PostToolUseFailure` the replacement is ignored. Those now read "offered and not applied", with
  the tokens that entered as Claude Code delivered them, never as savings. Found on the first Windows run,
  where the report had credited tokenbrake with 6k tokens Claude Code kept out.
- `status` warns when the guard is installed at both user and project scope: it runs twice per call there.
- `report` prints "Under the trim threshold": shell results at or under `maxChars`, with their tokens and
  carried cost as a share of everything carried. The share the guard does not touch, measured, so the
  real-session files can say whether shape filters for small output are worth building.
- Measured, not claimed: the excerpt rule was A/B'd against no hooks on the same audit before release
  (`AB-TASK.md`, "The fix, measured"). It removed the pathology it was written for — eighty-line `sed`
  ranges, 91 requests, twice the bill — but the on arm still ran 45 requests to the off arm's 32 and cost
  30% more, so by the protocol's own rule this is not a win, only strictly less than 0.2.2 did. On the
  read-heavy audit shape the honest range across four runs each way is $4.60-$5.97 with hooks off and
  $3.77-$9.63 with hooks on: the model's reading strategy moves that bill more than the guard does.

## 0.2.2 — 2026-09-09

- **The guard now sees failing commands, and Claude Code does not let it act.** For Bash, `PostToolUse`
  fires only on exit 0; a non-zero exit is `PostToolUseFailure`, a different event the guard was not
  registered for. So every failing test run, the one output the trim exists for, went past it, in every
  debugging round measured so far. `init`, `init --project` and the plugin now register
  `PostToolUseFailure` on `Bash|PowerShell` with the same guard; the ledger row says `failed`, the saved
  full output is written, and the replacement keeps its `Exit code N` first line. But Claude Code 2.1.261
  and 2.1.266 ignore that replacement on this event ("Hook JSON output had unrecognized keys (ignored):
  hookSpecificOutput.updatedToolOutput" in the debug log), against their own hooks reference, so a failing
  command's output still enters as Claude Code delivers it: capped by its own ~10,000-character error
  ceiling, middle elided to about 7,500. The registration stays because the docs promise the field and the
  ledger now records what failures cost; `AB-TASK.md`, "The failing command", has the measurements and the
  one route that remains. Re-run `npx tokenbrake init` (or `init --project`) to pick the group up.
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
