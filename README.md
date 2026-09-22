# tokenbrake

Find out what ate your Claude Code context, then brake it if your report says there is anything to brake.

```
npx tokenbrake report
```

No install, no hooks, no config, nothing written anywhere: it reads the session transcripts Claude Code already
keeps under `~/.claude/projects/` and ranks every tool result by the tokens it actually took. That isn't its size.
It's **carried**: its size times the number of later requests that re-read it, because a tool result is re-sent as
context on every request until the session compacts. A 4k-token file read at request 3 of 100 is about 400k
token-reads, and the ranking puts results like that at the top where you can see them. Then it tells you how much of
that the brake could act on at all, and, when tokenbrake was not running, whether installing it is worth it for
work like yours. Often it is not, and the report says so.

The brake is step two: Claude Code hooks (`npx tokenbrake init`) that trim oversized shell output and cap
unbounded reads of large files before they enter context. Its measured record, losses included, is in
[`EVIDENCE.md`](https://github.com/33kain/tokenbrake/blob/main/EVIDENCE.md), and it is thinner than the report's:
install it when your own report says there is something in its reach.

**Built for long sessions.** Every tool result is re-sent with each request after it, so the longer the session,
the more a trim at entry saves. It runs wherever Claude Code runs locally, from one user-scope install: the CLI,
and the Claude Desktop app on Windows (a local Code session there loads the same `~/.claude/settings.json`).

**Source:** everything that ships is three files at the root of this repository: `cli.js` (the installer and
the report), `guard.js` (the hooks) and `transcript.js` (the transcript reader). There are no dependencies and
no build step, so what npm installs is those files as they are here. Tests: `npm test` (`test.mjs`), run in
CI on Windows and Ubuntu with Node 18, 20 and 22.

## Why there is no percentage on this page

Anyone publishing a token-saving percentage for this category owes a control pair alongside it: the same task
run twice with the tool **off** on both sides. Without one, a saving is indistinguishable from the agent reading
differently on the day.

This project ran those controls. In a 22-session pre-registered benchmark
([`AB-TASK.md`, "ab10 closed"](https://github.com/33kain/tokenbrake/blob/main/AB-TASK.md#ab10-closed--what-twenty-two-sessions-bought)), OFF-against-OFF pairs with identical
configuration on both sides came out up to **42.6% apart on tokens entered**. The runs with the brake entered a
median 35.7% fewer tool-result tokens, and that sits inside the noise. The sharper result is about tokens
**carried**, the number that matters: tokens entering context fell in every pair with the brake, but tokens
carried fell in only four of six pairs and rose in two, once by 72.6%, because a trim that sends the model back
for what it cut lengthens the session. Five pairs cannot resolve an effect that size against variation that
size, and neither can anyone else's handful of sessions.

So tokenbrake does not quote a saving. It reports what your own sessions carried and how much of it the brake
could reach, and it leaves the decision to that. The whole record, losses included, is in
[`EVIDENCE.md`](https://github.com/33kain/tokenbrake/blob/main/EVIDENCE.md): read it before you install the brake.

## Install

As a Claude Code plugin (0.4.0):

```
claude plugin marketplace add 33kain/tokenbrake
claude plugin install tokenbrake@tokenbrake
```

or with npx, which writes the hooks into a settings file you own:

```
npx tokenbrake init            # user scope: ~/.claude/settings.json, applies to every project
npx tokenbrake init --project  # this project only: .claude/settings.json (commit it to share with a team). One scope per
                               # machine: with both, the guard runs twice per call, and `status` says so
```

One or the other -- never both. User scope is the install; `--project` is for a team that commits the guard to a
shared repo whose members don't already run it at user scope. With both, every result runs through the guard twice:
the second pass is a no-op on an already trimmed output, and the ledger records it twice -- `report --ledger`,
`--caps` and `--reach` drop the duplicate and say how many they dropped, and `status` reports the overlap -- but that
is cleanup after a misconfiguration, not a mode to run in.

Restart Claude Code (or run `/hooks`: `PreToolUse`, `PostToolUse`, `PostToolUseFailure` and `SessionStart` each list
a tokenbrake entry, `guard.js` in its command). Node 18+ is the only requirement — no
Python, no Rust binary, no Git Bash. Works on Windows with the PowerShell tool.

```
npx tokenbrake status          # what is installed, plus one real spawn of each hook, as Claude Code does it
```

The hooks are exec-form (no shell), so Claude Code starts the recorded executable directly. User-scope `init`
records the absolute path of the node it ran under; `--project` records plain `node` so the committed file works
on any machine, and `--node=<path>` overrides either. If `status` prints `FAILED to start`, that is the hook
Claude Code would also fail to start — silently, with every result going through untrimmed.

### In a cloud session — the web, the phone, `claude --cloud`

A cloud session starts in a fresh container, and **your `~/.claude` stays on your machine**: a user-scope install
is not there. What does arrive is whatever the repository carries, so a committed `.claude/settings.json` from
`init --project` is the only thing that protects a cloud session out of the box — and only in that one
repository. Everywhere else, the guard is simply absent, and nothing in the session says so.

To have it in every cloud session, install it from the environment's **Setup script** field (at
[claude.ai/code](https://claude.ai/code), in the environment's settings):

```bash
#!/bin/bash
npm i -g tokenbrake@0.4.0 || true
tokenbrake init || true
tokenbrake status || true
```

The script runs as root before Claude Code launches, and the container's filesystem is snapshotted afterwards, so
later sessions start with the install already in place. Three things that are not decoration: `|| true`, because a
setup script that exits non-zero fails the session; `status` last, because its output lands in the startup
checklist, which is where you learn the install did not take; and a **pinned version**, so a number the ledger
records is attributable to a build. Only a *new* session runs the script — resuming never re-runs it.

What this does not give you is the record. A cloud session's ledger and transcript live inside the container and
go when it does, so `report` on your own machine never sees that work. The guard trims there; it just does not
keep receipts.

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
npx tokenbrake report --backfire          # what the guard withheld vs. what the model pulled back -- the net
npx tokenbrake report --compactions       # every compaction priced: what the drop saves, what re-reading cost
npx tokenbrake tune                       # read your recent sessions and recommend which off-by-default features to turn on
```

A tool result is not paid for once. It is re-sent as context on every later request until the session
compacts, so a 30k-token test dump at request 3 of 60 is read 57 times. `report` reads the Claude Code
session transcript (every tool result exactly as the model saw it, and the API's usage per request) and
ranks results by **size × the requests they were carried through** — which is the number that says which
single `cat`, `Read` or test run to have trimmed, capped or never run. It also shows what the session
processed in total, how much of that came from cache, what the context holds right now, and which of the
results tokenbrake trimmed and what that kept out. On Opus 5 the same usage is also given in **points of the
five-hour window**, split into cache reads, writes and output, and so is the trim's saving. It uses the
weights calibrated on the author's machine (per million tokens: cache read 0.20, write 8.9, output 34; see
AB-TASK.md, "Calibration results"). Token counts alone hide where the window went, because a cache write weighs
about 45 cache reads. Other models are not calibrated, so they are not priced. Sizes are chars/4 estimates; the
usage line is what the API reported. `--ledger` shows the guard's own record alone, which is also the fallback when no transcript
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

It also shows the other side of that table: what sits **out** of reach, broken out by tool. On most work that is
mostly Read, and Read gets a split of its own -- ranged reads (left alone by design, since trimming excerpts
taught the model to read in 80-line chunks), whole reads at or under `readMaxBytes`, whole reads over it (the
only ones the Read cap can act on), and reads nothing could size, which are listed apart rather than guessed
into a bucket. Sizes come from the guard's ledger and Claude Code's line numbering, never from the delivered
text, which on a capped read is the cap's own output. On the machine this was built on, Read was about a third
of everything carried and the cap could act on about 1% of it.

Everything tokenbrake reports is in tokens: tokens entered, token-reads carried, cache reads and writes. It
never states a saving in money. `report --cost`, which stated sessions in money, was removed on 2026-09-18
and now says so.

`--backfire` is the honest counterweight to the saving line, measured in token-reads like everything else. A trim, MCP trim or dedup keeps content out of context, but a trim can also send the model back for
what was cut, and a return trip that re-reads the whole saved output can take more tokens than the cut saved. This
view counts what the guard **withheld** (each result the model saw carrying the marker, matched to a ledger
row for its original and kept size) against what the model then **pulled back** — the two ways the guard
itself makes that possible: reading the `out/` file it saved, or `tokenbrake show`. Those are the guard's own
price by construction, paid in tokens, unlike a plain re-read, which the ranking counts but cannot attribute. It reports the
**backfire rate** (how many withheld outputs were read back) and the **net** — token-reads saved minus
token-reads carried back in, on the same footprint basis on both sides. A read of a saved output it can't tie
to a withhold here (an earlier session's file, or a capped output that carries no marker) is reported apart,
never silently netted. This is the gate a narrowing has to pass before its default moves: a narrowing whose
net is negative is spending tokens, not saving them.

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
the table `AB-TASK.md` built by hand, in tokens and counts only: requests, context processed, cache reads and
writes, output, what tool results entered and were carried (split by tool class), what the guard trimmed, repeat
reads, with B's change against A.

Two sessions differ by more than their configuration. Identical OFF/OFF arms have come out up to 42.6% apart on
tokens entered, on nothing but how the model planned; the table says what happened, the protocol in
`AB-TASK.md` says what it means.

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
  "shadow": true,
  "enabled": true
}
```

`enabled: false` turns the guard off without uninstalling. `logAllTools: false` records only trimmed and capped events.

`shadow` (default `true`) is evidence, not behaviour: while `blobElide`, `gitView` or `mcpTrim` is off, the guard still runs
that feature's own test on each shell or MCP result and, when it would have fired, writes one ledger row with what it would
have withheld. It emits nothing and saves nothing, so what enters context is byte-identical with it on or off.
`tokenbrake tune` then reads those rows as an exact count of what the feature would have withheld in tokens on your
own sessions, in place of an estimate. It still recommends at most "try": the model saw the whole output, so whether
it would have come back for the withheld part is not something a shadow can measure. `shadow: false` turns it off.

The three features that remember earlier calls in a session — `dedup`, `reReadElide`, `readAfterEdit` — are measured
differently: `tune` replays your transcripts in order and asks the guard's own decision functions at each step, so
it needs no install and works on every session already on disk. It is deliberately conservative where a transcript
cannot see what the guard sees: a re-read counts only if no shell command, edit or compaction came between the two
reads, and a result the trim already cut cannot be matched as a duplicate. Edits without line data are counted and
reported rather than guessed. A session where the feature actually ran is judged on its real record instead.
`tune --sweep` re-runs that replay at several values of each of their knobs (`dedupMinChars`, `reReadRecency`,
`reReadKeepLines`, `editContextLines`), one at a time with your own value marked, so you see the curve rather than
one number. It only shows data; it never changes your config.

A `tools` map overrides any of these knobs per tool, keyed by tool name (`Bash`, `PowerShell`, `Read`). A
tool's entry is merged over the base config for that tool only — knobs it omits keep their base value — so you
can trim one tool hard and leave another loose, or switch the guard off for a single tool with
`"enabled": false` while it keeps running for the rest:

```json
{
  "maxChars": 6000,
  "tools": {
    "Bash": { "maxChars": 3000, "shapeFilters": true },
    "Read": { "readMaxBytes": 120000, "readLimitLines": 500 },
    "PowerShell": { "enabled": false }
  }
}
```

Two lists match by **command or path** (a plain substring), for the cases size alone gets wrong. Both are
empty by default, so neither changes anything until you set it:

- `noTrim` — an allowlist. A shell command or a read path matching any of these is left **whole**: the
  `git diff` you always want in full, a schema or a fixture a trimmed view would ruin. For an `mcp__*` result
  only an **`mcp__`-shaped** entry applies — `"mcp__github__get_file_contents"` (or a prefix like
  `"mcp__github"`) spares that MCP tool from `mcpTrim`, while a command entry like `"git"` stays scoped to
  shell and never bleeds into a tool name such as `mcp__github__…`.
- `alwaysCap` — the other direction. A read (or a `cat`/`sed` excerpt) whose path matches is capped at
  `readLimitLines` **even when it is under `readMaxBytes`**: a lockfile, a `*.min.js`, a generated bundle you
  never want whole.

```json
{
  "noTrim": ["git diff", "schema.sql"],
  "alwaysCap": ["package-lock.json", ".min.js", "dist/"]
}
```

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

`jsonShape` (default `false`) changes how a **JSON** result over `maxChars` is trimmed. A char slice through a
100-record dump leaves two broken half-objects and a shapeless gap; the head/tail line trim is no better on
minified JSON that is one line. With it on, when the result parses as JSON tokenbrake keeps the first
`jsonSampleItems` (5) of the big array — a top-level array, or the largest array property of a top-level
object — and appends a one-line count, so the model gets the shape, a real sample, and the total. It runs
only in the trim path, so the full output is already saved to `out/` and named in the note; anything that is
not one of those two shapes falls back to the ordinary trim. Off until an A/B moves it, same as the shape
filters.

`mcpTrim` (default `false`) extends the guard past shell output to `mcp__*` tool results. An MCP result arrives
as a content-block array (`[{ "type": "text", "text": … }]`) — not the Bash `{ stdout }` object — and the guard
sees it in full *before* Claude Code's own "too large → saved to a file, 2 KB preview" step, so with it on an
oversized MCP result is routed through the same trim as shell output (head/tail, or a JSON sample when
`jsonShape` is on) and the full output saved to `out/`, instead of a generic preview plus a file that is then
re-read whole. The reply is rebuilt in the exact shape the result arrived in, since Claude Code validates it
against the tool's own schema and drops a wrong shape silently. Target one server with a per-tool profile
(`"tools": { "mcp__github__list_commits": { … } }`) or protect one by name with `noTrim`. Off until an A/B
moves it; pairs with `jsonShape`, since MCP bodies are usually JSON.

`dedup` (default `false`) catches the same result arriving **twice in one session**. A result is re-sent as
context on every later request, so a 30k-char output produced twice is carried twice; when a Bash/PowerShell or
`mcp__*` result over `dedupMinChars` (1,000) is byte-for-byte identical to one seen earlier this session, the
guard hands back a one-line pointer — `[tokenbrake] identical to an earlier result this session (N chars). Full:
tokenbrake show <id>` — in the tool's own shape, instead of the whole thing again. The first copy is saved to
`out/` (even when it is never trimmed) so the pointer is retrievable; state is a per-session append-only file
under `dedup/`, and every step fails open. It honors `noTrim`. Like a trim, the pointer can send the model back
for the full copy (a recovery read), so it is off until an A/B moves it — best per-tool for a tool you call
repeatedly with identical results.

`readAfterEdit` (default `false`) narrows the request instead of the response. Right after you `Edit` a file,
the model often re-`Read`s the whole thing to check the change landed — a re-read the Claude Code harness
itself calls unnecessary ("Do NOT re-read a file you just edited to verify"). With this on, the guard remembers
which lines each `Edit`/`MultiEdit` changed — from the edit's own `structuredPatch` when Claude Code provides
it (which covers `replace_all` and repeated text), else by locating the new text uniquely — in a per-session
append-only file under `edits/`, and when an **unbounded** `Read` of that file follows, it injects an
`offset`/`limit` so the read returns only the changed region plus
`editContextLines` (20) of context — with a note saying so and how to read wider. The file is still on disk, so
a wrong guess costs one ranged re-read, not lost data; that re-read is a **delta backfire**, which
`report --backfire` counts (`Read-After-Edit deltas: N fired; M sent the model back`). Off until an A/B moves
it — the gate is the whole reason to measure before flipping.

`reReadElide` (default `false`) is the sibling for the other common re-send: re-reading a file you already read
this session. When you `Read` a file **whole**, the guard remembers its size and mtime (a per-session file
under `reads/`); if you re-`Read` the same file **unbounded** while it is **unchanged** and the re-read is
**recent** (fewer than `reReadRecency`, default 8, whole-reads since), it hands back only the first
`reReadKeepLines` (default 5) plus a one-line note, instead of re-adding the whole file you likely still have.
(It saves no artifact — the file is still on disk, so a wider read is one `offset`/`limit` away.) It
only fires for files read whole (a capped first read means you don't have all of it), and any edit or external
write changes the size or mtime so the equality check fails and the read-after-edit delta handles the edit case
instead. Its one real risk is a **compaction** between the two reads — which the guard does not consult — that
dropped the content; `reReadRecency` *mitigates* that (it limits elision to still-fresh reads, it is not a
compaction bound), and a re-read that has to go back for the file anyway is a **backfire** `report --backfire`
counts (`Re-read elisions: N fired; M sent the model back`). Off until an A/B moves it.

`compactPrep` (default `false`) works on how long context stays, not on what enters it. After Claude Code compacts
a session, a `SessionStart` hook puts back the **working set** as pointers only, never file contents: the files
edited (with the line ranges touched), the files read (with their ranges), the last command that failed and its
first error line, and the first words of the task. It's built from the session's own transcript and capped at
`compactPrepMaxChars` (default 8,000, about 2,000 tokens). The point is that the model re-reads only what its
next step needs instead of searching for its place. It pairs with an earlier compaction window
(`/autocompact 300k`, Claude Code's own setting), and `report --compactions` prices every compaction: what the
drop in context saves, and what re-reading afterwards costs. Off by default until the two-stage measurement in
`AB-TASK.md` ("An earlier compaction window") passes; with it off, shadow records what it would have injected.

`blobElide` (default `false`) catches the other shape of waste: shell output that is one long **encoded or
minified run** — a base64 dump, a minified bundle, a giant one-line JSON. As bytes it tells the model nothing,
yet it re-enters context on every request until compaction. When a shell result is at least `blobMinChars`
(default 4,000) and its **single longest line** is both at least `blobMaxLine` chars (default 2,000 — the
absolute floor) and at least `blobLineShare` of the whole (default 0.5 — the dominance test), the guard replaces
it with the first `blobKeepChars` (default 160) — enough to see what it was — plus a one-line descriptor, and
saves the full output to `out/` so you can
`Read` it back if you truly need the bytes. The longest-line-share test is the discriminator: prose, logs and
pretty-printed JSON keep short lines, and wide-but-structured data (a CSV, a table) has many wide lines with
none dominant, so all of those pass through untouched; only a single dominant encoded/minified run is elided. A
failed command is never elided (its error is wanted whole). It counts as a plain trim to `report --backfire`
(labelled `blob`), so a later `Read` of the saved file registers as a backfire. Shell/excerpt output only for
now (an MCP base64 result or a `Read` of a one-line minified file are follow-ups). Off until an A/B moves it.

`gitView` (default `false`) is the change-aware view of a `git diff`/`git show`. The whole diff re-enters
context on every request, and its noisiest part is usually **generated** — a lockfile, a `*.min.js`, a source
map — that no one reads line by line. When such a diff is at least `gitViewMinChars` (default 2,000), the guard
collapses the hunks of any file whose path matches `gitCollapse` (default: the common lockfiles plus `.min.js`
/ `.min.css` / `.map`) to a one-line `+adds/-dels` summary, **keeps every real-source hunk verbatim** and the
commit/preamble intact, and saves the full diff to `out/`. It only touches `git diff`/`git show` (not `git
log`, not `git status`); a diff with no generated files, or `--stat`/`--name-only` output, collapses nothing
and passes through. A failed command is never touched. It counts as a plain trim to `report --backfire`
(labelled `gitview`), so a `Read` of the saved diff registers as a backfire. Off until an A/B moves it.

## Auto-tune — which of those to turn on

Every feature above ships **off**, which is safe but leaves the question every operator actually has: *which of
these would help me?* `tokenbrake tune` answers it from your own recent sessions, and keeps two kinds of answer
strictly apart:

- **Measured** — the feature already fired in these sessions, so the backfire audit has its real record: fired
  N times, M pulled back, the token-reads it saved. A clean measured record with enough firings is the only
  thing that earns a **turn it on**; a measured backfire earns a **leave off** (or, if it is already on, a
  *reconsider*).
- **Opportunity** — the feature is off, so there is nothing to measure. Instead `tune` estimates how often it
  *would* act from what your transcripts already record (a blob-shaped shell result, a large MCP payload, a `git
  diff`, an edit followed by a whole re-read). Every estimate is built to **under-count**, and it earns at most a
  **try it and measure** — never a *turn it on*, because whether the model comes back for what was withheld is
  behavioural and costs a session to learn (the same rule the Read-cap trigger has always lived under).

```
npx tokenbrake tune                 # pool your recent real sessions (benchmark and calibration sessions skipped)
npx tokenbrake tune --cwd=<text>    # restrict the pool to one project; --session=<prefix> for one session
npx tokenbrake tune --sweep         # the stateful features replayed at several values of each knob (data only)
npx tokenbrake tune --write         # apply the MEASURED recommendation to tokenbrake.json (see below)
```

It prints, per feature, that verdict and the **exact knob to set**. Plain `tune` is a preview — it changes
nothing. It also reports the Read cap's health (firing / dormant / missing / unmeasured — the last is what a
fresh install sees, meaning no pooled session ran the guard, so nothing watched the reads; the exact value still comes from
`report --reads` and `--where`) and how much of your carried tokens sit where the trim can act. Tokens and cache only.

It also recommends the two **thresholds**, `maxChars` and `readMaxBytes`, from your own sessions rather than
one value for everyone: a grid of what each candidate value would reach and could withhold at most, with your
own value marked, and one step of advice. **Try one step lower** only when the record at your current value is
clean with enough firings and the lower value takes materially more. **Raise** only when the pull-backs raising
would have prevented cost more than the saving it would give up; both sides are measured on the same withholds,
so one pull-back among many clean trims reads as the trim working. Otherwise **keep**. The Read cap's pull-backs
can't be measured from transcripts, so its advice says so. These are recommendations only: `tune --write` never
changes a threshold, because the lower value has no record of its own until you run it.

**`tune --write`** applies the recommendation to `~/.claude/tokenbrake.json`, and only ever acts on **measured**
evidence — never an estimate. It turns **on** the features with a clean measured record (a `turn on`). It does
**not** turn anything off: a feature that measurably backfired is surfaced as `reconsider` for you to disable
deliberately (the backfire audit's net is pooled, not per-feature, so `--write` can't tell a feature that
backfired once but is strongly net-positive from one that is net-negative — and reverting a net-positive feature
would cost tokens); `try` and `measure` verdicts are opportunity estimates, left for you to enable and measure
yourself first. It merges (every other key is preserved, like `preset`, and it aborts rather than overwrite a
malformed config), and prints exactly what it turned on and the measured reason. The apply is gated on measured
evidence for the same reason the whole project ships every context-narrowing feature off: whether a withhold
pays off or backfires is behavioural, and only a real session measures it.

## Presets

Instead of editing the knobs by hand, apply a named profile — it merges into `~/.claude/tokenbrake.json`,
so a key it does not set survives, and it takes effect on the next tool call (the guard reads config each
call, no restart):

```
npx tokenbrake preset aggressive   # maxChars 3000, readMaxBytes 30000, shapeFilters on
npx tokenbrake preset balanced     # the defaults, spelled out
npx tokenbrake preset minimal      # high thresholds — trims rarely
npx tokenbrake preset off          # enabled:false, without uninstalling
npx tokenbrake preset list         # show them, and the current config
```

## Health check

```
npx tokenbrake doctor [--project]   # a prioritized problem list, each with a remedy; non-zero if an ERROR remains
npx tokenbrake doctor --fix         # re-copies the guard if the installed copy has drifted from this checkout
```

`doctor` is `status` re-cast for scripting and CI: it exits non-zero when something is actually broken
(no hooks, a stale guard, a hook that cannot spawn, invalid `tokenbrake.json`) and prints the fix for each.

## Saved outputs

When the guard trims a large result it writes the full text to `~/.claude/tokenbrake/out/<id>.txt` and names
the path in the trimmed result. To get it back:

```
npx tokenbrake outputs        # list saved full outputs, newest first
npx tokenbrake show <id>      # print one whole (id from `outputs`; a prefix works)
```

## Uninstall

```
npx tokenbrake uninstall [--project]
npx tokenbrake clean --days=7   # delete saved full outputs older than 7 days
```

## Notes and limits

- The report reads Claude Code's session transcripts, which are an internal format rather than a versioned
  API. If a transcript stops reading as a real session would (user turns with no model requests back,
  requests with no token usage, or tool results that match no tool call), `report` says the format may have
  changed and names the Claude Code version that wrote it, rather than printing an empty session as the
  finding. The pooled views skip such a session and give that as the reason.
- Rewriting a tool result needs `updatedToolOutput` support in PostToolUse, which Claude Code added for
  built-in tools in the v2.1.12x line. On older versions the hook runs but changes nothing. Claude Code checks
  the rewrite against the tool's own result shape (for Bash: the `{ stdout, stderr, … }` object) and drops a
  mismatch without telling anyone but the debug log; tokenbrake returns the object, and `status` checks it.
- Claude Code caps hook output at 10,000 characters; tokenbrake keeps its rewrite under that. Whether the
  cap applies to the replacement *string* or to the whole emitted JSON is not settled by measurement — the
  guard currently assumes the JSON, which delivers less on escape-dense output but cannot be silently
  dropped. See the note on `HOOK_OUTPUT_CAP` in `guard.js`.
- For Bash, only successful tool calls pass through `PostToolUse`; a non-zero exit fires `PostToolUseFailure`,
  which tokenbrake has registered for since 0.2.2 and which Claude Code 2.1.261–2.1.267 ignores the
  replacement on, against its own hooks reference. So a failing command's output enters as Claude Code
  delivers it — capped by its own error ceiling, middle elided to about 7,500 characters — and the ledger
  records its size. `AB-TASK.md`, "The failing command", has the measurements.
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
