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
npx tokenbrake report --all               # one line per session on disk
npx tokenbrake report --session=<prefix>  # a particular one; --transcript=<path> for a file
npx tokenbrake report --top=25            # widen the ranking
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
- Only successful tool calls pass through PostToolUse. A failing command already arrives as a ~10,000-char
  head/tail excerpt from Claude Code itself; tokenbrake doesn't touch it.
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
