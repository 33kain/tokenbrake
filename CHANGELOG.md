# Changelog

## Unreleased

- **`report` says where you actually read, which is the only evidence that can set `readLimitLines`.**
  When the model asks for a *range* — a `Read` with an `offset`, a `sed -n '320,345p'` — it has said where
  it expects to find something. A cap keeping the first N lines hides that target whenever the start line
  is past N, and the model comes back for it. The report now gives the distribution of those start lines
  and, against the cap you actually run, how often it would have hidden what the model went for.
  On the session that prompted it: ~100 targeted reads, median start line in the 50s, 90th percentile 464,
  deepest 820 — and the default 300-line cap would have hidden the target in **about a quarter of them**,
  against 9% at 500 and 1% at 800. That is a per-person number, and nobody else's default can supply it.
  Labelled as the inference it is: the guard never capped these reads themselves, they arrived already
  bounded. The claim that therefore they say nothing about what the cap did is **withdrawn in the next
  entry** -- it was wrong, and in the guard's favour.

- **That number was confounded, and `report --where` now takes the confound apart.** A capped Read hands the
  model lines 1..N and its `additionalContext` tells it, in words, to come back with an offset. It does — and
  that follow-up is a ranged read starting just past the cap, counted in the distribution meant to decide
  what the cap should be. Pooled over seventeen real sessions the figure read **57% of targets past line
  300, median start line 351** — against the 300 the guard had been applying all along. The report now joins
  the ledger's own record of which files the cap fired on against the reads, and prints two columns: every
  ranged read, and the subset the guard did not provoke. **Only the second may set a default**, and the
  report says so where the old closing line used to claim the opposite.
  A read with no timestamp to order against the cap goes in **neither** column and is counted; a cap in
  another session never excludes this session's reads; and a ledger with no cap rows at all reports *"not
  attempted"* rather than *"0 induced"*, because a machine whose ledger predates the Read cap should not get
  a clean bill of health for a confound nobody looked for.
  Two things the report states about itself: attribution is by file identity, so one cap marks every later
  ranged read of that file — which inflates the excluded count, not the clean one. And a cap on one file that
  teaches the model to read *another* with an offset is invisible here, so the spontaneous column is a
  **lower bound** on the guard's influence. Only a hooks-off session settles that.
  Also a diagnostic that needs no ledger, for machines whose ledger predates the cap: whether the start-line
  density **steps** at the cap. Two equal-width bands either side, an exact binomial tail, nothing tuned to
  the data — and a thin sample reports itself as thin rather than as no spike.

- **`report --caps`, and `--ledger` stops lumping the two Read caps together.** `Large reads capped: N`
  counted source-file caps (`readMaxBytes` / `readLimitLines`) together with caps on outputs Claude Code had
  already spilled to disk (`persistedLimitLines`). They are different features on one hook, governed by
  different config, and a single number was evidence for neither. `--caps` lists every file the cap has fired
  on, pooled across sessions, with the two halves counted apart and `delivered` — the share of the file the
  model received, `null` rather than a guess when the guard skipped the line count. Rows a double install
  logged twice are dropped once and the drop is reported. This is the view that answers how often the Read
  cap fires on ordinary work, which is the question `readMaxBytes` turns on: one real 40-request audit
  session read six files at 1, 8, 15, 16, 31 and 34 KB and **never tripped the 60,000-byte trigger once.**

- **`report --reads`, and a sizing error it had to fix first.** `readMaxBytes` decides which reads get capped
  and has never had an argument: 60,000 was a guess, and the one paid A/B lowering it to 25,000 cost +10% on
  a task that said "read in full", which forbids the saving by construction. Half of that question is
  arithmetic over a person's own reads — how many a lower trigger catches and how much of each it cuts — and
  this does that half for free.
  **The sizing error, found while building it and verified on this repo's own transcripts:** Claude Code
  numbers every line it delivers (`12→const x = 1`), and that numbering is Claude Code's, not the file's. It
  runs **5–6% of the delivered text on a 350-line file and grows with the line count**, while `readMaxBytes`
  is compared against the file's real size on disk. Measuring a file by what its read cost therefore
  overstates every file, and overstates the long ones most — exactly at the boundary a trigger sits on. The
  numbering is now stripped, which recovers the real size to the byte: an unchanged `guard.js` came back as
  22,076 characters and strips to **20,832 bytes against 20,831 on disk**. The stripping also gives the line
  count exactly, because the last prefix *is* the file's last line number.
  Four things that would each have made the grid lie, all corrected and each printed rather than folded in:
  a read the guard had already **capped** (its delivered text is the cap's first N lines — the ledger's
  `statSync` size is used instead, or a capped read would be counted as a small file and argue for a lower
  trigger using the cap's own output); a read Claude Code **refused** as too large; an unbounded read that
  stopped at a round host line limit, whose line count is a **floor** and not a count; and a read of an output
  Claude Code had already **spilled to disk**, which `persistedLimitLines` governs and `readMaxBytes` has no
  say in. Images and notebooks are excluded too, because the guard returns on them before it stats anything.
  **And the question underneath the value.** `readLimitLines` is an *absolute* line count, but whether it
  hides the target depends on where the target sits as a **fraction** of the file: a median start line of 351
  is 51% into a 684-line file and 14% into a 2,570-line one. The report gives both spreads side by side. If
  the fractional one is markedly tighter, the knob is the wrong *shape* — too tight on a short file, too loose
  on a long one — and no value of it is right everywhere. Nothing had ever paired a read's start line with its
  file's length, so neither shape had ever been evidence.
  The miss rate is printed beside the grid and never inside it, because it is measured over ranged reads —
  a different population from the whole-file reads a trigger catches — and adding the two would be wrong.

- **`report` prints ASCII.** Its output used typographic characters -- an ellipsis, a right arrow, em dashes --
  which a Windows console renders as `ΓÇª` and `ΓåÆ`. The owner's daily surface has been mojibake since the
  report existed. Every report, status and help string is ASCII now; the guard's own `…` marker inside a
  trimmed result is unchanged, because that text goes to the model as JSON, not to a console.

## 0.2.6 — 2026-09-12

- **The excerpt exemption now survives how models actually write a read.** It exempted a read of one file
  from the trim — because head, tail and error lines are the wrong summary of a range the model had already
  narrowed — but only when the command was a bare `cat`/`sed -n`/`head`/`tail` with one unquoted,
  space-free path and nothing before or after it. A `cd … &&` prefix, an `echo` label on either side, or a
  quoted path containing a space each disqualified the read. All three are how models write. It now also
  covers a `grep` of one named file, whose every line is a hit the model asked for.
  Pipes, redirects, recursive and list-only greps stay excluded: those do not print one file's contents.
  An unquoted path with spaces stays excluded too — it is genuinely ambiguous.
  **Measured, not assumed:** the benchmark's Experiment A gained a spelling matrix that runs one file
  through every spelling, for a fixture under `readMaxBytes` and one over it, and fails the build if any is
  handled against intent.
  **The cost of the old behaviour, measured:** in one paired run the guard shredded a 34-line range and a
  single-file grep on spelling alone; the model made four return trips for what had been cut, took three
  extra rounds, and the pair came out at −8.0% where others in the same round reached −39%. One of those
  return trips was the model reading **tokenbrake's own overflow file** — the escape hatch paying for the
  saving with a round trip. Recorded in the benchmark's `results/DEVIATIONS.md`.
  Note what this trades: those commands are no longer trimmed at all below `readMaxBytes`, so the guard
  acts less often. Pair 5 is the argument that acting less is worth more than acting wrongly.

## 0.2.5 — 2026-09-11

- **`report` says what the guard did to the bill, and what the mechanism cost.** Four lines gain money,
  priced at the session's own model and at list rate, with the first appearance of a result paid once at
  the cache-write rate and every later re-read at the cache-read rate: the trim line ends with what it
  took off the session; `Still within reach` names what the guard could have trimmed and did not, weighted
  by carried tokens rather than by size; and a new `Recovery reads` line counts the model coming back for
  more of a file it had already read, with its cost. A model with no published rate yields no figure
  rather than a guess.
  The benchmark is why. It measured that the saving lives in `carried` — a result is paid for again in
  every later request that re-reads it — that the number of trims does not predict it (two trims produced
  a 39% paired difference where seven produced 12%), and that **every run with the guard made more
  recovery reads than its partner without**. Showing a saving without the cost that produced it would be
  dishonest, so the two lines now sit together.
- **A 22-session pre-registered benchmark says no cost saving may be quoted, and says why.**
  [33kain/tokenbrake-bench](https://github.com/33kain/tokenbrake-bench): five paired runs and three
  OFF-against-OFF control pairs on a synthetic incident review. The controls — identical configuration on
  both sides, no hook anywhere — came out **5.7%, 18.4% and 30.3% apart on cost** and **42.6% apart on
  tokens entered**. The paired runs' 28.8% lower cost and 35.7% fewer tokens both sit inside that noise.
  The round's verdict flipped from *cost reduction* to *no measurable difference* when the third control
  was added, and the flip is recorded rather than smoothed.
  The sharp part of the round: **tokens entering context fell in every pair, while tokens *carried* fell
  in only four of six and rose in two, once by 72.6%.** Carried is where the money is, so the hook
  reliably shrinks what enters and does not reliably shrink what is paid for again on every later
  request — a trim that sends the model back for what was cut lengthens the session past where it
  started. What the same runs did establish: **22 runs, 22 scores of 38 of 38 against a hidden answer key,
  zero critical errors.** The hook never cost a correct answer.

- **`report` now says what the guard could ever have acted on, not only what it did.** Three lines:
  `Within the guard's reach` (shell, exit 0, over the trim threshold and under Claude Code's own inline
  ceiling — with its share of everything carried), `Out of reach` (under the threshold; not a shell result;
  failed, where the host ignores the replacement; past the ceiling, where the output is persisted and the
  replacement is never applied), and `Acted on` as a share of the reachable. The buckets account for every
  result exactly once, and a result the guard rewrote counts as reachable **by proof** rather than by size,
  since a trimmed result measures under the threshold afterwards.
  Reporting what was trimmed against a total that includes all four flattered the tool. On one session:
  **2 of 450 results within reach, 8% of everything carried, and the guard acted on none of them.** That is
  the difference between "it saved nothing here" and "it could never have saved anything here", and the
  second is usually the true sentence.
- **Shape filters, off by default.** `shapeFilters: true` in `~/.claude/tokenbrake.json` turns on three
  conservative passes over a shell result at least `shapeMinChars` (1,500) long, before the size test:
  ANSI escape sequences are removed; a carriage-return redraw **inside** a line keeps only its last frame;
  and a run of three or more consecutive lines carrying a run of **bar glyphs** collapses to its last line
  plus a count. Running before the size test is the point — a log that collapses below `maxChars` is
  delivered whole and never trimmed, so the model gets a complete short document instead of a head, a tail
  and a hole. On a 400-line install log with a realistic bar: **5,936 characters to 942, ANSI 106 to 0, and
  no trim at all**, against 5,936 trimmed to a gap with the filters off.
- **Two rules had to be narrowed the same day, both after they destroyed data in a probe.** A run was first
  collapsed when its lines "differ only in numbers or bar glyphs": sixty rows of a settlement table differ
  only in numbers too, and collapsing them left one row and a count. Adding "or a percentage" as the
  signal was no better — eighty rows of `tenant acme-079 risk score 53% approved` went the same way.
  **A run of bar glyphs is now the only signal.** The cost is that a bar-less `Downloading… 45%` is no
  longer collapsed, which is the right side to err on: a filter that misses noise is a nuisance, one that
  eats rows is a bug.
- **And `\r` at the end of a line is a CRLF line ending, not a redraw.** Reading it as one turned a
  120-row CRLF CSV into 121 characters of empty lines — every field gone, the worst thing this filter has
  done. A line is a redraw only if a `\r` sits inside it; a plain line, CRLF or LF, now passes byte for
  byte.
  It deliberately does **not** collapse passing-test lines: their names answer real questions ("how many
  checks passed, and what was the last one"), and a count is not always enough. Separate flag if wanted.
  Default stays `false` until an A/B moves it, as every default here has.

## 0.2.4 — 2026-09-10

- **`report` says whether the Read cap fired, and which half of it.** A capped Read is an ordinary short
  result carrying no marker, so the trim line could never see it and nothing in the report said the cap had
  acted at all. The new line counts the ledger's `read-cap` rows for the session, split into the two
  features that share the hook: `readMaxBytes`, an unbounded Read of a large source file, and
  `persistedLimitLines`, a read of an output Claude Code had already written to disk. They are separable by
  config and their evidence is not the same — on one real 421-request session reads of persisted outputs
  carried a quarter of everything carried, while the source-file cap has not been observed to fire outside
  a test, and the A/B where it did fire showed the file entering through `cat` and a persisted file instead
  (`AB-TASK.md`, ab8). Counting them apart is what lets a week of ordinary sessions decide whether either
  default is worth keeping.
- `status` no longer calls a single install a double one. The double-install warning fired whenever the
  *other* scope carried the guard, whether or not this scope did, so the ordinary case — a project install,
  `status` run without `--project` — printed "the guard runs twice per call here; uninstall one scope". It
  runs once. The line now says which scope it runs from, and only claims twice when both scopes have it.
  Found on the first hand-run A/B round, where it read as a second install to hunt down.

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
