# tokenbrake

Claude Code hooks that keep oversized tool output out of your context window.

Tool results are the bulk of what a Claude Code session spends — and shell output is the worst offender.
Claude Code's own ceiling for a valid Bash result is ~30,000 characters inline (roughly 7,500 tokens), and
that gets re-sent with every turn until you `/compact`. tokenbrake lowers that ceiling to something sane,
keeps the parts that matter, and tells you afterwards what ate your tokens.

**Measured (2026-09-06 to 2026-09-10).** The same read-only audit task on the same repository, run as Cowork sessions
without the hooks and with them, cost taken from the session records, identical answers on every run. Fable 5.1, three
runs: $8.40 → $7.02 (−16%) on guard 0.2.0, $6.48 → $5.53 (−15%) on 0.2.3 with requests going the wrong way 26 → 29,
and, run by hand on Windows rather than in a container, $4.37 → $4.39 (+0.5%) with requests 18 → 21. All three sit
inside the 21% band two identically configured arms have already produced here, so the Fable reading is a null, not a
saving — and the third is the closest two arms have come on this task, half a percent apart. Opus 5, four hooks-on
runs against four hooks-off runs: off between $4.60 and $5.97, on between $3.77 and $9.63. The best on-run is −37% and
is in an earlier version of this paragraph; the worst is +100%, a guard version that trimmed `sed -n` excerpts of
source files and taught the model to read in 80-line ranges, 91 requests for one audit. That is fixed (an excerpt of
one file is now read like a Read), and the run after the fix still came out 30% over the off arm. On Opus 5, on this
task, the hook has not shown a saving that survives repetition; what moves the bill by a factor of two is how the
model chooses to read, and the guard's job is not to push it toward small ranges. The two models do not even spend
alike: on Opus 5 cache reads dominate the bill, on Fable 5.1 cache writes are three quarters of it, so the same hook
is pulling a different lever on each. Two debugging rounds and a small-feature round on Opus 5 saved nothing
attributable: the model bounded its own reads and let 10–14k tokens of tool results in. The saving is whatever the
model would otherwise have let in, and on the runs so far that is 0 to 37% at best and worse than nothing at worst,
with no result on either model that survives being run twice; the report's "Tool results entered" line says which end
a session was on. The protocol and every number, the losses included, are in [`AB-TASK.md`](AB-TASK.md).

## Limits, with the numbers

Read this before installing. It is the part most tools in this space leave to their critics.

**The trim's window is narrow on three sides at once.** A shell result is rewritten only if it is over
6,000 characters (below that it is left alone), under Claude Code's own ~30,000-character ceiling (above
that Claude Code persists the output to a file and hands the model a preview, and the hook's replacement is
never applied), and exited zero (a non-zero exit fires `PostToolUseFailure`, where Claude Code ignores the
replacement — see `AB-TASK.md`, "The failing command"). So the biggest outputs and every failing one are
out of reach, and what remains is medium-sized successful output.

**Measured on one machine's ledger: 285 tool results, and the trim applied to none of them.** 282 were
under the threshold. The three over it were two single-file excerpts — which 0.2.3 deliberately leaves
alone, because trimming them taught the model to read in eighty-line chunks and doubled the bill on one
task — and one MCP result, which is not a shell result. The Read cap fired zero times in the same 285. That
sample is biased toward well-behaved output: the repository it came from tells its agents to read with
bounded `sed` ranges, which is exactly the case where there is nothing to save. It is still 285 real calls
in which the hook did nothing.

**Results under the threshold are most of the cost.** In one working session they were 57% of all context
carried; in an audit session, 79%. Compressing them is what the rest of this category does, and it is where
the JetBrains benchmark found rtk losing money, so tokenbrake does not — but the share it declines to touch
is the majority of the bill.

**Generic trimming can keep the wrong three things.** Head, tail and error-looking lines are a guess about
what matters. The one measured instance of that guess being wrong is in this repository's own history: on
source-file excerpts those are the wrong three things, which is why 0.2.3 stopped trimming them. No round
has produced a wrong *answer* — every arm of every A/B has agreed, 12 of 12 — but the mechanism is real.

**No repeatable saving has been demonstrated on the bill, by any version, on any workload.** On the
read-heavy audit the shipping guard's three paired runs came out at 1.30, 0.85 and 1.00 times the no-hook
cost. Two debugging rounds and a feature round were flat. The best figure ever recorded, −37%, is one run
of eight on that shape and is not reproducible; the worst, +100%, came from a guard behaviour since
removed.

**And now the number behind that sentence: two identical sessions without the hook differ by up to 30%
on the bill.** A 22-session pre-registered benchmark
([33kain/tokenbrake-bench](https://github.com/33kain/tokenbrake-bench)) ran a synthetic incident review
five times with the hook and five times without, plus three OFF-against-OFF control pairs — the same
configuration on both sides, no hook at all. Those controls came out **5.7%, 18.4% and 30.3% apart**, and
on tokens entered, **42.6% apart**. The paired runs with the hook showed a median 28.8% lower cost and
35.7% fewer tool-result tokens, and **both sit inside that noise**. The agent simply reads differently
every time.

So the honest reading of that round is not that the hook does nothing. It is that **five pairs cannot
resolve an effect of this size against variation of this size**, and anyone claiming a percentage saving
from a handful of sessions — this package included — is measuring the agent's mood. The round's own
verdict flipped from "cost reduction" to "no measurable difference" when the third control was added, and
both the flip and the flaw found in the rule that caused it are in that repository's `DEVIATIONS.md`.

One thing in that round is sharp rather than inconclusive, and it is the most useful sentence here:
**tokens entering context fell in every single pair, while tokens *carried* — size times the number of
later requests that re-read them — fell in only four of six and rose in two, once by 72.6%.** Carried is
where the money is, since a result is paid for again on every later request. So the hook reliably shrinks
what enters and does not reliably shrink what is carried: when a trim sends the model back for what was
cut, the session lengthens and carried climbs past where it started. That is the whole null, in one line.
(Post-hoc, not pre-registered, and recorded as such.)

What the same 22 runs did establish: **the hook never cost a correct answer.** Every run scored 38 of 38
against a hidden answer key, with zero critical errors, on a task with more than twenty warning-shaped
distractors. And **every run with the hook made more recovery reads than its partner without** — the model
going back for what was cut — which is the mechanism's own price, now reported by `report`.

**Real-session evidence for the current version is zero sessions.** Every `ab-results/real/` file on record
predates 0.2.3, and the only one showing substantial savings got them from the excerpt trimming that 0.2.3
removed.

**The measuring tool itself has been wrong twice.** It credited tokenbrake with tokens Claude Code had kept
out, until the first Windows run caught it; and on Windows a live transcript's modification time can lag,
so `report` run from inside a session picked a different session — twice, once producing plausible wrong
numbers. Both are fixed and both are recorded.

**The report tells you this about your own sessions, in dollars.** Since 0.2.5 it prints `Within the
guard's reach`, `Out of reach`, `Acted on`, `Still within reach` and `Recovery reads`: how many of your
tool results the hooks could ever touch, why the rest are beyond them, what share of your carried context
that is, what the trims took off this session's bill at list price, what is left untrimmed and what that
is worth — and what the model's return trips for trimmed content cost you. The benchmark found the saving
lives in *carried* tokens rather than in the size of any one result, and that the number of trims does not
predict it: two trims produced a 39% paired difference where seven produced 12%. On the session that produced the count above
it read 2 of 450 results, 8% of everything carried, acted on none. That is the number that answers "would
this have helped me", and it is the one thing here worth running whatever you decide about the hooks.

**What it is not: the only tool that reads your transcripts.** An earlier version of this file claimed no
other tool in this space reports its own inapplicability. That was written without checking and is
withdrawn. Several projects already parse the same `~/.claude/projects/**/*.jsonl` files for tokens and
cost — [token-dashboard](https://github.com/nateherkai/token-dashboard),
[cc-analyzer](https://github.com/yorch/cc-analyzer),
[claude-token-analyzer](https://github.com/li195111/claude-token-analyzer),
[claude-session-analyzer](https://github.com/yonk-labs/claude-session-analyzer),
[ccost](https://github.com/toolsu/ccost) among them — and Claude Code itself now ships `/usage`,
`/context` and OpenTelemetry export with per-tool attribution. If you want tokens and cost by session or
by day, use one of those; they do it better and they are not attached to a hook.
What this report has that a survey of those did not turn up is narrower: `carried`, which charges a cost
to an **individual tool result** by how many later requests re-read it, and the reach denominator, which
is specific to the question of whether a trimming hook could act on your sessions at all. "Did not turn
up" is not "does not exist", and this file will not make that mistake twice.

What follows from all of that: **run `tokenbrake report` on your own last session before installing
anything.** The "Tool results entered" and "Under the trim threshold" lines say whether you have the kind
of session this can act on. Most sessions are not.

## Install

As a Claude Code plugin (0.2.0):

```
claude plugin marketplace add 33kain/tokenbrake
claude plugin install tokenbrake@tokenbrake
```

or with npx, which writes the two hooks into a settings file you own:

```
npx tokenbrake init            # user scope: ~/.claude/settings.json, applies to every project
npx tokenbrake init --project  # this project only: .claude/settings.json (commit it to share with a team). One scope per
                               # machine: with both, the guard runs twice per call, and `status` says so
```

One or the other. With both, every result runs through the guard twice: the second pass is a no-op on an already
trimmed output, but the ledger records it twice and `report` counts it twice.

Restart Claude Code (or run `/hooks` to confirm two tokenbrake entries). Node 18+ is the only requirement — no
Python, no Rust binary, no Git Bash. Works on Windows with the PowerShell tool.

```
npx tokenbrake status          # what is installed, plus one real spawn of each hook, as Claude Code does it
```

The hooks are exec-form (no shell), so Claude Code starts the recorded executable directly. User-scope `init`
records the absolute path of the node it ran under; `--project` records plain `node` so the committed file works
on any machine, and `--node=<path>` overrides either. If `status` prints `FAILED to start`, that is the hook
Claude Code would also fail to start — silently, with every result going through untrimmed.

## What it does

**Shell output trim** (PostToolUse on `Bash` / `PowerShell`; a command that exits non-zero fires `PostToolUseFailure` instead, where the guard is registered since 0.2.2 and records the failure, but current Claude Code ignores a hook's replacement on that event, so a failing run's output enters as Claude Code caps it, about 7,500 characters; see `AB-TASK.md`, "The failing command"). Output over 6,000 chars is replaced by up to 20
lines from the middle that look like errors or warnings, each with up to 3 lines after it (the assertion, the
expected/actual pair, the first stack frame) and its line number, plus the first and last lines of the output,
up to 40 each, as many as fit in the 6,000. A line that opens with a pass marker (`ok`, `PASS`, `✓`) is never
taken for an error, whatever its name says. A command that only prints one file (`cat`, `sed -n` with a range, `head`,
`tail`, no pipe) is a read, and is treated like one: untouched up to `readMaxBytes`, capped at `readLimitLines` above
it, never cut to head and tail. The full output is saved to `~/.claude/tokenbrake/out/` and the trimmed result names the path,
so Claude can `Grep` or `Read` it if it needs more. Nothing is rewritten or "compressed" — what Claude sees is a
predictable head/tail excerpt of the real output.

**Large-read cap** (PreToolUse on `Read`). A `Read` with no `offset`/`limit` on a file over 60 KB is rewritten
to `limit: 300`, and Claude is told the file's real size and how to page through it or `Grep` it first. Reads that
already specify a range are untouched. Images, PDFs and notebooks are skipped.

**Ledger** (every tool result). Size of each result is appended to `~/.claude/tokenbrake/ledger.jsonl`. Nothing
leaves your machine.

## What ate your tokens

```
npx tokenbrake report                     # last session
npx tokenbrake report --all               # one line per session on disk, and which had the guard running
npx tokenbrake report --session=<prefix>  # a particular one; --transcript=<path> for a file
npx tokenbrake report --top=25            # widen the ranking
npx tokenbrake report --where             # where your ranged reads land -- the evidence for readLimitLines
npx tokenbrake report --caps              # every file the Read cap fired on
npx tokenbrake report --reads             # every file you read whole -- the evidence for readMaxBytes
npx tokenbrake report --reach             # how much of what your tools deliver the trim can act on at all
```

A tool result is not paid for once. It is re-sent as context on every later request until the session
compacts, so a 30k-token test dump at request 3 of 60 is read 57 times. `report` reads the Claude Code
session transcript (every tool result exactly as the model saw it, and the API's usage per request) and
ranks results by **size × the requests they were carried through** — which is the number that says which
single `cat`, `Read` or test run to have trimmed, capped or never run. It also shows what the session
processed in total, how much of that came from cache, what the context holds right now, and which of the
results tokenbrake trimmed and what that kept out. Sizes are chars/4 estimates; the usage line is what the
API reported. `--ledger` shows the guard's own record alone, which is also the fallback when no transcript
can be found.

Two views exist to set the Read cap's own knobs from a person's own sessions rather than from a default
someone picked. `--where` pools every session's *ranged* reads -- a `Read` with an offset, a
`sed -n '320,345p'` -- because a range is the model saying where it expects to find something, and a cap
keeping the first N lines hides that target whenever the start line is past N. It separates out the reads a
cap on the same file provoked: a capped read hands back the first N lines and tells the model to come back
with an offset, so those start lines are the cap's own, not the model's, and pooling them in makes the guard
measure itself. `--caps` is the other half — every file the cap has actually fired on, pooled across
sessions, with the source-file and spilled-output halves counted apart and the share of each file delivered.
Whether the cap is a daily event or a rarity on your work is what decides `readMaxBytes`, and it is not a
thing to reason about.

`--reads` is the third, and it is the one `readMaxBytes` turns on: every file you read **whole** — an
unbounded `Read`, or a bare `cat` — at its own size, with **Claude Code's line numbering subtracted**. That
numbering is Claude Code's and not the file's: it runs 5–6% of the delivered text on a 350-line file and grows
with the line count, and `readMaxBytes` is compared against the file's real size, so leaving it in overstates
every file and overstates long ones most — right at the boundary the question is about. From those sizes it
prints how many of your reads each candidate trigger would catch, how much of each file a limit would then
withhold, and how deep your targets sit **as a share of the file**, which is what says whether an absolute
line cap is even the right shape. The withholding is arithmetic and exact; whether the model comes back for
what a cap withheld is behavioural, is not in any transcript, and the report says so.

`--reach` asks a different question from the other three: not what a knob should be, but whether the mechanism
has anything to do on your work at all. It reports what share of your **carried** tokens sits where the trim can
act -- a shell result, exit 0, over `maxChars`, under Claude Code's inline ceiling -- and names the tools that put
results there, grouped by the program invoked rather than by the command string. Handed a CLI that can slice a
log, a model slices and the trim has nothing to rewrite; handed tools that only dump, it has plenty. Which of
those your work looks like is not a thing to reason about either. It counts only sessions the guard was actually
recording in, because in a session without it "untouched" means the guard was absent rather than idle, and under
10 such sessions or 200 shell results it prints no verdict instead of a number that looks like one.

## Against Claude Code's compaction

Compaction and tokenbrake attack the same quantity from opposite ends. A tool result costs its size times the
number of requests that re-read it. `/compact` (and auto-compact) cuts the second factor after the fact.
tokenbrake cuts the first factor before the result ever lands.

| | compaction | tokenbrake |
|---|---|---|
| acts | after the tokens are in context | before they enter it |
| scope | the whole conversation at once | one oversized result at a time |
| reduces | how many turns you keep paying for a result | what you pay for it per turn |
| what is kept | whatever the summary happens to preserve | head, tail, and the error-looking lines, with line numbers |
| recoverable | no, the detail is gone | yes, full text on disk, path named in the trimmed result |
| costs | a model pass over the entire context | one `node` spawn per tool call (~50-100 ms) |

By the time compaction fires, a 30,000-character test dump has already been re-sent on every request since it
arrived, and the compaction pass reads it one more time to summarize it. The guard means it was never 30,000
characters in the first place.

The two also differ in blast radius. Compaction is all or nothing: it resets everything, including the plan and
the decisions you wanted kept. The guard only touches shell output over `maxChars` and unbounded reads of files
over `readMaxBytes`; small results pass through untouched, and reads that already carry an `offset`/`limit` are
never modified. One exception to the size rule: a saved tool output (Claude Code's `tool-results/<id>.txt`, or
the guard's own `tokenbrake/out/<id>.txt`) read without bounds is capped at `persistedLimitLines` however big it
is, because it was too big to show inline and is therefore too big to read whole. That is the door through which
oversized output came back in the audit A/B, and in the session that wrote this rule those reads carried 24% of
everything (`AB-TASK.md`, "Persisted outputs").

And the guard changes what the model does next, which compaction cannot. Most of the saving measured in
`AB-TASK.md` was indirect: a trimmed `cat`, plus a note naming `offset`/`limit` and `Grep`, sent the model to
bounded `Read` calls instead of Claude Code's own "result too large, saved to a file" path, whose re-reads were
96% of the untrimmed session's carried context.

They compose rather than compete, and `report` knows it: carried context stops accumulating at a compaction
boundary, so the ranking already reflects what compaction relieved. With the hooks on, both models ended the
same audit session holding less context (383k → 338k on Fable 5.1, 331k → 200k on Opus 5), so auto-compact
fires later and fewer times.

Where each one fails is the honest part. tokenbrake saves nothing when the model bounds its own output, which
is what both models did on the debugging task in `AB-TASK.md`. Compaction is the only answer to a context
filled by long back-and-forth, extended thinking, and code the model wrote, none of which the guard touches.
Claude Code's own ~30,000-character save-to-a-file ceiling is a third mechanism, and it is high enough to be
the problem rather than the fix: in the audit run the model kept re-reading those persisted files.

## Compare two sessions

```
npx tokenbrake report --compare <A> <B>
```

Each argument is a session-id prefix (`tokenbrake report --all` lists them) or a transcript path. The output is
the table `AB-TASK.md` built by hand: cost at list price, requests, cache reads and writes, output, what tool
results entered and were carried, what the guard trimmed, repeat reads, with B's change against A. The cost
line also appears in every single-session report; it is computed per request at that request's model's list
price, cache writes at the one-hour rate Claude Code uses, and it reproduces the Opus 5 A/B arms' session
records to the sixth decimal. A model without a listed price is reported as unpriced, not guessed.

Two sessions differ by more than their configuration. On one task, identical arms came out 21% apart in cost on
nothing but how the model planned; the table says what happened, the protocol in `AB-TASK.md` says what it
means.

## Configure

Optional `~/.claude/tokenbrake.json` (or under `CLAUDE_CONFIG_DIR`):

```json
{
  "maxChars": 6000,
  "headLines": 40,
  "tailLines": 40,
  "keepErrorLines": 20,
  "errorContextLines": 3,
  "readMaxBytes": 60000,
  "readLimitLines": 300,
  "persistedLimitLines": 80,
  "logAllTools": true,
  "enabled": true
}
```

`enabled: false` turns the guard off without uninstalling. `logAllTools: false` records only trimmed and capped events.

`shapeFilters` (default `false`) turns on a pre-pass over shell results at least `shapeMinChars` (1,500)
long: ANSI escapes removed, a carriage-return redraw *inside* a line reduced to its last frame, and runs of
three or more consecutive lines carrying a run of **bar glyphs** collapsed to the last one plus a count. It
runs *before* the size test, so a log that collapses below `maxChars` is delivered whole and never trimmed.
On a 400-line install log with a realistic bar that is 5,936 characters to 942, with no trim at all.

A run of bar glyphs is the only signal, and that is deliberate. "Lines differing only in numbers" collapsed
a settlement table; adding "or a percentage" collapsed a table of risk scores; and treating a trailing `\r`
as a redraw destroyed every field of a CRLF CSV. Each was caught in a probe on the day it was written. A
filter that misses noise is a nuisance; one that eats rows is a bug. It is off because no A/B has moved it
yet; see `AB-TASK.md`.

## Uninstall

```
npx tokenbrake uninstall [--project]
npx tokenbrake clean --days=7   # delete saved full outputs older than 7 days
```

## Notes and limits

- Rewriting a tool result needs `updatedToolOutput` support in PostToolUse, which Claude Code added for
  built-in tools in the v2.1.12x line. On older versions the hook runs but changes nothing. Claude Code checks
  the rewrite against the tool's own result shape (for Bash: the `{ stdout, stderr, … }` object) and drops a
  mismatch without telling anyone but the debug log; tokenbrake returns the object, and `status` checks it.
- Claude Code caps hook output strings at 10,000 characters; tokenbrake keeps its rewrite under that.
- For Bash, only successful tool calls pass through `PostToolUse`; a non-zero exit fires `PostToolUseFailure`,
  which tokenbrake has registered for since 0.2.2 and which Claude Code 2.1.261–2.1.267 ignores the
  replacement on, against its own hooks reference. So a failing command's output enters as Claude Code
  delivers it — capped by its own error ceiling, middle elided to about 7,500 characters — and the ledger
  records what it cost. `AB-TASK.md`, "The failing command", has the measurements.
- The guard fails open: any error exits 0 with no output and Claude Code proceeds unchanged.
- One `node` process per tool call (~50–100 ms). Set the PostToolUse matcher to `Bash|PowerShell|Read` in
  settings.json if you want it lighter and don't need the full ledger.
- Reads capped by tokenbrake are partial views; `Edit` still requires an exact string match, so a capped read
  can't cause a wrong edit — Claude will read the section it needs first.

## Where this lives

`33kain/tokenbrake` since 2026-09-06. It was built inside the CONTEXA repository
(`33kain/contexa`, folder `tokenbrake/`) and split out with its history; the
measurements in `AB-TASK.md` were run on that repository, which is why the task
there says `node tokenbrake/cli.js` where this repository says `node cli.js`.
CONTEXA is a Chrome extension for claude.ai; tokenbrake is hooks for Claude
Code. They share an idea and nothing else.
