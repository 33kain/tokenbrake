# The A/B run: does brake 1 move the usage limit?

> Since 0.2.2 the comparison table below is one command: `tokenbrake report --compare <A> <B>` on the two
> arms' transcripts prints requests, cache reads, entered, carried, trimmed and repeat reads with the
> change column. The protocol on this page, one message, one config difference, the decision rule fixed
> before the run, is what makes the table mean something.

Two Cowork sessions on this repository, the same one-message task, the usage
page read before and after each. Arm A runs on `main` before `.claude/settings.json`
is merged (no hooks). Arm B runs after the merge (hooks on: shell output over
6,000 characters trimmed, unbounded Reads on files over 60 KB capped at 300 lines).

Same model, same effort, both arms. Nothing else running in the five-hour window
between the two readings of an arm.

## Procedure, per arm

1. Settings → Usage. Write down: five-hour window %, weekly all models %, weekly
   for the chosen model %. Note the time.
2. New Cowork session on this repository. Paste the task below as the first and
   only message. Do not answer questions, do not send anything else.
3. When the session's final answer arrives, Settings → Usage again. Write the
   same three numbers and the time.
4. Copy the session's final answer (ten lines plus the report block) into the
   chat with Claude that runs the comparison.

The one-message seeded protocol works on Opus 5 and Fable 5.1; Sonnet 5 in auto mode asks for human
confirmation before it will execute, so Sonnet is outside the protocol — a limit of the protocol, not a
result (`ab6`).

## The task (paste verbatim)

> **Pre-split protocol — CONTEXA paths.** This audit task and the debugging rounds below were run when
> tokenbrake lived inside `33kain/contexa`, so they read `extension/`, `worker/`, `build.mjs`, `scripts/ab/`
> and `publishing/` — CONTEXA's files, which do not exist in this standalone repo (see HANDOFF.md's split
> note). They stand as the record of those runs; do not paste them into a session on *this* repo unchanged.
> The self-contained tokenbrake A/B is **"Read-After-Edit Delta (narrowing 1)"** at the end of this file; a
> read-only tokenbrake-native task would target `guard.js`, `cli.js`, `transcript.js`, `test.mjs` instead.

```
Read-only audit of this repository. Do every step with tools, in this order, one step at a time, and do not skip or batch steps. Do not modify any file. At the end write eleven lines, one per step, then paste the report from step 11 verbatim.

1. Run `npm test` and report the number of checks that passed and failed.
2. Run `node build.mjs` and report the zip name it prints.
3. Read extension/content.js in full and name the function that decides whether the Start fresh control renders.
4. Read worker/src/index.js in full and name the constant that caps the brief's length.
5. Read extension/background.js in full and say how long a staged brief lives before it expires.
6. Read CHANGELOG.md in full and give the version number of the oldest entry.
7. Read extension/test.mjs in full and count the lines that begin with `  t(`.
8. Run `git log --stat -40` and name the file that appears most often in it.
9. Run `grep -rn "Start fresh" publishing/` and count the matching lines.
10. Run `cat tokenbrake/HANDOFF.md` and quote its first line.
11. Run `node tokenbrake/cli.js report --top=8` and paste its full output.
```

## What the comparison reads

| number | where it comes from | what it tells |
|---|---|---|
| five-hour % after − before | the usage page | the limit's own accounting, the number that matters |
| Context processed | step 11 in the answer | tokens the API reported, both arms |
| Tool results entered / carried | step 11 | what brake 1 changed inside the session |
| `[trimmed from …]` marks | step 11, arm B only | which results the guard cut |

The result goes into `HANDOFF.md` as the twenty-third card, and, if it holds,
into `tokenbrake/README.md` as the first measured number for brake 1.

## Arm A — run 2026-09-06, no hooks (main before the merge)

Fable 5.1, effort Auto. One message, eleven steps, 21 requests.

| usage page | 09:12 before | 09:17 after | moved |
|---|---|---|---|
| five-hour window | 16% | 25% | +9 |
| weekly, all models | 25% | 26% | +1 |
| weekly, Fable | 46% | 48% | +2 |

The session's own report (step 11): 21 requests, 31 tool results; context
processed 4.2M tokens (92% from cache); output 7k; context at the end ≈ 383k;
tool results entered ≈ 187k tokens, carried ≈ 1.6M token-reads. By tool: Read
18 calls, 174k entered, 1.6M carried (96%); Bash 13 calls, 14k entered, 59k
carried (4%). Every one of the top eight was a Read of a persisted tool-result
file under the session's own `tool-results/` directory, 8k to 15k tokens each,
carried 7 to 16 times: the big file reads went through Claude Code's own
"result too large, saved to a file" path and came back as reads of that file.

What that means for arm B: the guard's PostToolUse trim acts on shell output,
and the Read cap acts on an unbounded Read of a file over 60 KB. Whether either
catches the persisted-result reads is exactly what arm B answers; the `[trimmed
from …]` marks in its report, or their absence, say which.

## Arm B — run 2026-09-06, hooks on (main after the merge)

Fable 5.1, effort Auto, the same message. The session said it out loud after
step 3: "The tokenbrake hooks trimmed the shell output, so I'll read the file
through the Read tool in bounded chunks." So the hooks fire in a Cowork
session from the repository's `.claude/settings.json`, which was the open
question in the HANDOFF.

| usage page | 09:30 before | 09:37 after | moved |
|---|---|---|---|
| five-hour window | 27% | 35% | +8 |
| weekly, all models | 26% | 27% | +1 |
| weekly, Fable | 48% | 50% | +2 |

The session's own report (step 11): 15 requests, 34 tool results; context
processed 2.7M tokens (89% from cache); output 7k; context at the end ≈ 338k;
tool results entered ≈ 164k, carried ≈ 981k token-reads; tokenbrake trimmed 7
of them, ≈ 34k tokens kept out, ≈ 326k token-reads not carried. By tool: Read
21 calls, 155k entered, 917k carried (93%); Bash 13 calls, 9k entered, 64k
carried (7%). The top eight are now bounded reads of the source files
themselves (CHANGELOG.md 11–12k, content.js 6k, index.js 7k), not of
persisted results.

## The comparison

The usage page has 1% resolution; the session records carry the exact API
usage in tokens, so those are the primary numbers.

| | arm A, no hooks | arm B, hooks on | change |
|---|---|---|---|
| cache-read tokens | 4,617,507 | 2,723,757 | −41% |
| cache-write tokens | 341,883 | 297,217 | −13% |
| output tokens | 8,070 | 7,878 | −2% |
| requests | 21 | 15 | −29% |
| context processed (report) | 4.2M | 2.7M | −36% |
| context at the end | 383k | 338k | −12% |
| tool results carried | 1.6M | 981k | −39% |
| five-hour window moved | +9 | +8 | −1 point |
| weekly, all models / Fable | +1 / +2 | +1 / +2 | same |

Same answers on all ten questions from both arms (649 checks, contexa-v0.9.95.zip,
MAX_BRIEF_CHARS 1800, two minutes, 0.9.0, 239 lines, index.html, 29 matches,
"# Brakes — handoff"); arm B named `costLine` where arm A named `weightLine`
for step 3, both defensible readings of the same code.

**Reading.** On an identical task, brake 1 cut the session's cache reads by
41%, its cache writes by 13% and its requests by 29%. The five-hour limit
moved one point less, +8 against +9: at 1% resolution that is consistent with
those cuts and cannot be stated more finely than "about one point in nine". The
weekly limits did not resolve the difference. Nothing was lost on the task:
every answer matched.

**Where the saving came from.** Not from the Read cap, which never fired
(every large read was already bounded), and only partly from the seven
trimmed shell outputs (34k tokens, 326k token-reads). The larger part is
indirect: with `cat` of a big file trimmed, the model read the file through
bounded Read calls instead of through Claude Code's "result too large, saved
to a file" path and its re-reads of that file, which in arm A were 96% of the
carry. Six fewer requests, each one a full re-read of the context, is where
41% of the cache reads went.

**What would sharpen it.** A longer task, so the arms move the five-hour
window by 30 points rather than 9 and the same relative difference shows as several points rather than one;
and the same task on Opus, where the per-token weight differs.

## Opus round — run 2026-09-06, both arms on Opus 5, effort Auto

`main` now carries the hooks, so the arms are told apart by a step 0 that the
session runs itself: arm A writes `{"enabled": false}` to
`~/.claude/tokenbrake.json`, arm B writes `{"enabled": true}`; the guard reads
that file on every call. Step 11 prints the file back so the answer carries
the arm's identity; step 12 is the report. Everything else is the same task.
Both arms ran on the same `main` (after #47).

| usage page | arm A, hooks off | arm B, hooks on |
|---|---|---|
| five-hour window | 38% → 41% (+3) | 41% → 43% (+2) |
| weekly, all models | 27% → 28% (+1) | 28% → 28% (0) |

| session record | arm A | arm B | change |
|---|---|---|---|
| cache-read tokens | 5,774,364 | 3,990,823 | −31% |
| cache-write tokens | 288,833 | 157,955 | −45% |
| output tokens | 7,891 | 7,718 | −2% |
| requests | 31 | 28 | −10% |
| context processed (report) | 5.7M | 3.9M | −32% |
| context at the end | 331k | 200k | −40% |
| tool results entered | 160k | 76k | −53% |
| tool results carried | 2.2M | 1.2M | −45% |
| trimmed by the guard | 0 | 3 results, 13k tokens, 284k token-reads | |

Answers identical on all ten questions (649/0; contexa-v0.9.95.zip;
weightLine with costLine; MAX_BRIEF_CHARS 1800; two minutes; 0.9.0; 239; a
23–23 tie between tokenbrake/HANDOFF.md and publishing/website/index.html,
the log having moved on since the Fable round; 29; "# Brakes — handoff").
Step 11 read `{"enabled": false}` on A and `{"enabled": true}` on B.

**What was different from the Fable round.** On Opus the Read cap fired,
twice, and the session said so: "the tokenbrake hook capped the full-file
read at 300 lines, so I read the head, the complete 91-entry heading index,
and the tail rather than every line" (CHANGELOG.md), and the `t(` count came
from a grep over the whole file with the harness section read directly
(test.mjs). Nine Read calls against seventeen; 76k tokens of results entered
against 160k. The guard's note after a trimmed `cat` and the cap's note after
a capped Read both point at offset/limit and Grep, and Opus followed them.

**Reading across both models.** Same task, same repository, one message:

| | Fable 5.1 | Opus 5 |
|---|---|---|
| cache reads, off → on | 4.62M → 2.72M (−41%) | 5.77M → 3.99M (−31%) |
| requests, off → on | 21 → 15 (−29%) | 31 → 28 (−10%) |
| five-hour window, off → on | +9 → +8 | +3 → +2 |
| answers | identical | identical |

The limit moved with the cache reads on both, as far as 1% resolution can show. A
side fact worth keeping: the same task moved the five-hour window three
times as far on Fable as on Opus while re-reading fewer cache tokens there
(4.62M against 5.77M with hooks off), so the limit weighs Fable heavily per token.

## Debugging round — run 2026-09-06, Opus 5 both arms, both arms on the same model

The audit task reads files once each. A debugging session runs the test suite
over and over, and the CONTEXA suite prints about 50 KB per run, so this is the
workload where shell output should dominate the context. Arms as in the Opus
round: step 0 writes `{"enabled": false}` or `{"enabled": true}` to
`~/.claude/tokenbrake.json`, and step 5 prints it back.

`scripts/ab/inject-faults.mjs` in the CONTEXA repository plants five faults in
the working tree, each one exact string replacement, each probed to break one
or two tests alone; all five planted show four failures at first and reveal
the rest as they are fixed. The session is told not to open the script, not to
edit tests, and to re-run the full suite after every change. It reports each
fault it fixed, how many times it ran the suite, `git diff --stat`, the config
file, and `npx tokenbrake@0.2.0 report --top=8`.

Success on the task is the same for both arms: the suite green, and the diff
touching only the five planted sites. What the comparison reads is the same as
before: tokens and cache reads from the session record, the five-hour window from
the usage page, and the report's own numbers, plus this time the number of
`npm test` runs, since each run is one 50 KB result carried until the end.

The prompt (both arms; step 0 differs):

```
Debugging task. Work in this repository's checkout. Do every step with tools, in order. Do not read or modify anything under scripts/ab/, do not modify any test file, do not commit or push. At the end write the final answer described in step 6.

1. Run `node scripts/ab/inject-faults.mjs`. It plants a few faults in the source files. Do not open the script.
2. Run `npm test` in full. Read the failures.
3. Fix every failure by editing source files under extension/ and worker/ only. After each change, re-run the full `npm test`. Repeat until the whole suite passes. Do not skip, disable or edit tests.
4. Run `git diff --stat` and keep the output.
5. Run `cat ~/.claude/tokenbrake.json` and keep the output.
6. Run `npx --yes tokenbrake@0.2.0 report --top=8` and keep the full output.

Final answer: one line per fault you fixed (file, what was wrong, what you changed); the number of times you ran `npm test`; then the outputs of steps 4, 5 and 6 pasted verbatim.
```

## Debugging round — run 2026-09-06, Opus 5 both arms

The workload where tool output should dominate: a broken test suite, fixed by
running the 50 KB suite repeatedly and reading source. `scripts/ab/inject-faults.mjs`
in `33kain/contexa` (merged, #50) plants five exact-string faults in the
session's working tree: fitTurns dropping the pinned first turn, the action
gate testing a label with its first word removed, takeBrief inverting the TTL
check, the daily limit 20 → 25, the reply cut at MIN_REPLY_CHARS. Each breaks
one or two tests on its own; all five show four failures at first and reveal
the rest as they are fixed. The script refuses to run if an anchor is missing.

Arms as in the Opus round: step 0 writes `{"enabled": false}` or `{"enabled": true}`
to `~/.claude/tokenbrake.json`; the task then runs the script (without reading
it), runs `npm test`, fixes source files under extension/ and worker/ only,
re-runs the full suite after every change until green, and ends with
`git diff --stat`, the config, and `npx --yes tokenbrake@0.2.0 report --top=8`.
The answer lists each fault fixed and the number of test runs, so the arms can
be compared on work done, not only on tokens.

What to read: tokens and cache reads from the session records, the usage page
around each arm, the number of `npm test` runs, and whether both arms fixed
the same five faults.

### Result: no measurable difference, and the reason is the finding

| usage page | arm A, hooks off | arm B, hooks on |
|---|---|---|
| five-hour window | 0% → 1% (+1, window freshly reset) | 14% → 15% (+1) |
| weekly, all / Fable | 33 → 33, 61 → 61 | 35 → 35, 64 → 64 |

| session record | arm A | arm B | change |
|---|---|---|---|
| cache-read tokens | 3,831,950 | 3,543,572 | −8% |
| cache-write tokens | 58,300 | 57,065 | −2% |
| output tokens | 10,484 | 11,481 | +10% |
| requests | 44 | 41 | −7% |
| tool results entered (report) | 11k | 10k | |
| tool results carried | 276k | 234k | |
| trimmed by the guard | 0 | **0** | |
| `npm test` runs | 6 | 4 | |
| faults fixed | 5 of 5, diff empty | 5 of 5, diff empty | |

Both arms fixed all five faults and restored every file byte-for-byte to
HEAD. The 8% fewer cache reads and three fewer requests are within the variation between two runs of the same task; the
guard trimmed nothing in arm B, because nothing crossed its threshold.

**Why nothing crossed it.** Opus 5 in a debugging loop bounds its own reads.
Neither arm ran `npm test` bare; both ran `npm test 2>&1 | tail -80`, or the
worker suite through `grep FAIL`, and read source through `grep -n … -A 20`
and `sed -n 'a,bp'`. The largest tool result in either session was about
1,000 tokens; tool results entered 10–11k of context in total, against 160k
on the audit task and 187k on Fable's. There was nothing for brake 1 to do.

**What this says.** Brake 1 saves what the model would otherwise let in. On
a read-heavy audit that asks for whole files, Opus let in 160k and the guard
cut the session's cache reads by 31% and the tool results it carried by 45%. On a debugging task where the model chose
`tail` and `grep` on its own, it let in 10k and the guard saved nothing.
The pre-registered expectation ("the biggest honest number") was wrong, and
it is recorded as wrong. The honest range for Opus 5 on this repository is
0% to 31% of cache reads, set by how much output the model lets in, which `report` shows
in one line: "Tool results entered".

Two side notes. In auto permission mode the classifier blocked
`printf … > ~/.claude/tokenbrake.json` from Bash in both arms; the sessions
wrote the file with the Write tool instead, same path, same content, and the
guard read it (arm A's report carries no trim entries with hooks off; arm B's
says "trimmed none" with hooks on). And arm B's session guessed that the
project-scope install "applies regardless" of the config file; it does not:
the project hook runs the same guard, which reads `enabled` on every call.

### The same round on Fable 5.1 — run 2026-09-06

Same two prompts, step 0 rewritten to use the Write tool (the auto-mode
classifier had blocked the shell redirect for both Opus arms), and a step 7
that commits the answer to the session's branch so nothing has to be
transcribed from a phone. Usage page: arm A 21% → 23% (+2), arm B 23% → 24%
(+1) on the five-hour window; weekly Fable 65 → 65 and 65 → 66.

| session record | arm A, hooks off | arm B, hooks on | change |
|---|---|---|---|
| cache-read tokens | 1,508,345 | 720,867 | −52% |
| output tokens | 6,583 | 4,348 | −34% |
| requests | 16 | 7 | −56% |
| tool results entered (report) | 3k | 2k | |
| trimmed by the guard | 0 | **0** | |
| `npm test` runs | 3 | 3 | |
| faults fixed | 5 of 5, diff empty | 5 of 5, diff empty | |

**The 52% fewer cache reads are not the hook's.** The guard trimmed nothing: Fable, like Opus,
never let the suite in whole (`npm test 2>&1 | tail -80`, `grep -v '^ok'`),
and the largest result in either arm was about 1k tokens. Arm B re-read less
cache because it did the job in 7 requests instead of 16, batching the fixes from
one read; that is run-to-run variation in how the model plans, and with
nothing trimmed there is no mechanism by which the hook could have caused it.
Recorded as a null result, like the Opus round. Debugging on this repository,
on both models: 0% attributable to brake 1.

**A flaw in the task, found by both Fable arms.** The injector edits the
working tree, so `git diff` shows every planted fault in one command, and
both Fable arms ran `git diff` early (705 tokens, second row of both reports)
and read the answers off it. The Opus arms did not. It does not change the
measurement (nothing was trimmed either way) but it makes the "debugging"
lighter than intended. Closed the same day: the injector now commits the
planted tree (contexa #51), `git diff` is clean, fixes are compared with
`git diff --stat HEAD~1`, and the prompts say so in step 4.

### The debugging round again, faults committed (v2) — Fable 5.1, 2026-09-06

The injector now commits the planted tree, so `git diff` is clean and the
faults have to be found by tests and reading. Both arms did exactly that:
neither ran a diff, both worked from `npm test | grep -v '^ok'` and `sed -n`
ranges, both fixed all five and left `git diff --stat HEAD~1` empty.

| usage page | arm A, hooks off | arm B, hooks on |
|---|---|---|
| five-hour window | 31% → 34% (+3) | 34% → 37% (+3) |
| weekly, all / Fable | +1 / +1 | 0 / 0 |

| session record | arm A | arm B | change |
|---|---|---|---|
| cache-read tokens | 2,685,151 | 1,718,544 | −36% |
| output tokens | 14,374 | 11,101 | −23% |
| requests | 24 | 17 | −29% |
| tool results entered (report) | 14k | 8k | |
| tool results carried | 154k | 69k | |
| trimmed by the guard | 0 | 3 results, ≈ 2k tokens kept out, ≈ 18k token-reads not carried | |
| `npm test` runs | 6 | 6 | |
| faults fixed | 5 of 5, diff empty | 5 of 5, diff empty | |

**Attributable to the hook: about 1%.** The guard fired for the first time on
a debugging arm, three times, on outputs of about 2k tokens each; 18k
token-reads not carried against 1.7M cache reads. The rest of the 36%
cache-read gap is, again, the model doing the job in fewer requests (17 against
24), which the hook cannot cause when it touched 2k tokens. Same conclusion
as v1 and as Opus: on a debugging loop where the model bounds its own output,
brake 1 saves next to nothing. The task flaw is closed and the result did not
move, which is what a closed flaw should do.

## The Read cap's trigger — 2026-09-07

Brake 1 has two knobs on the Read side: `readMaxBytes`, the file size from which an
unbounded Read is capped, and `readLimitLines`, what the cap keeps. The default
trigger, 60,000 bytes, was never argued for. Three things now bear on it.

**A real 40-request audit session on this repository, hooks off.** 4.3M tokens
processed, 515k token-reads carried. Six unbounded Reads: 1, 8, 15, 16, 31 and
34 KB. None at or above 60 KB, so `readMaxBytes: 60000` would not have fired
once; the two largest, 31 and 34 KB, carried half of the Read total, and a
trigger around 25,000 catches both. 79% of the carried context was Bash, mostly
small `sed -n` excerpts of 1–2k tokens carried 27–38 times because the session
was long. Those sit under `maxChars` and are compaction's problem, not the
guard's. The 96% mechanism from the audit A/B reproduced live: `git log --stat
-40` hit Claude Code's own ~30,000-character ceiling, was persisted to a file,
and the file was then read whole, 34 KB.

**The sweep (`scripts/sweep-readmax.mjs`).** `readMaxBytes` is a trigger, not a
strength: on a 64 KB file every value from 60,000 down to 10,000 gives the same
62.5% at `readLimitLines` 300, and only `readLimitLines` moves the number (75%
at 200, 87.5% at 100). In the band the trigger does change, a 40 KB file goes
from 0% at 60,000 (the guard never fires) to 40% at 25,000. The first version
of the sweep reported 19% for that file because it truncated arm A at the
30,000-character Bash ceiling; Read has no such ceiling in these sizes (a 65 KB
file entered a real session as 60,359 characters), and the fixture in
`test.mjs` had the same premise and was corrected the same way.

So lowering the trigger cannot change how much a capped Read saves, only how
many Reads get capped. What no simulation can say is the other side: a capped
Read sends the model to two or three bounded reads, and every extra request
re-reads the whole context. Whether the 25–60 KB band pays for itself is a live
question.

**The live A/B — run 2026-09-07, Opus 5 both arms.** Two Cowork sessions,
both with the hooks on, the same twelve-step read-only audit of
`33kain/contexa`, differing only in `~/.claude/tokenbrake.json`:
`readMaxBytes` 60000 (arm A) against 25000 (arm B). The audit reads
`worker/test.mjs` (60 KB), `extension/background.js` (59 KB) and
`scripts/screenshots/capture.mjs` (35 KB) whole, all three in the band, and
two of the answers it asks for sit past line 300. Decision rule, fixed before
the run: 25,000 becomes the default only if arm B spends fewer or equal tokens with
identical answers. Results: `ab-results/readmax-60k.txt` on
`claude/ab-readmax-60k` and `ab-results/readmax-25k.txt` on
`claude/ab-readmax-25k` in `33kain/contexa`.

| session record | arm A, 60000 | arm B, 25000 | change |
|---|---|---|---|
| cache-read tokens | 4,855,785 | 6,817,176 | +40% |
| output tokens | 13,161 | 11,857 | −10% |
| requests | 25 | 34 | +36% |
| tool results entered (report) | 91k | 92k | |
| tool results carried | 912k | 1.5M | +64% |
| Read calls | 21 | 17 | |
| trimmed by the guard | 1 result, ≈ 789 tokens | 1 result, ≈ 790 tokens | |
| answers | 12 of 12 | 12 of 12, identical | |

**Result: the lower trigger spent more tokens, and 60,000 stays.** The same tokens
entered on both arms, 91k against 92k, because the task asks for whole files
and the model reads whatever the cap withholds in further bounded reads: in
both arms `content.js` (112 KB, capped either way) went in as six or seven
chunks of 4–6k tokens. Lowering the trigger added the same chunking to
`background.js`, `worker/test.mjs` and `capture.mjs`, and each extra read is an
extra request that re-reads the whole context: 34 requests against 25, 1.5M
token-reads carried against 912k, 40% more cache reads. The
cap saves tokens only when the model does not come back for the rest, which
is the behaviour change the audit A/B credited it with, and which a task that
says "read in full" forbids by construction.

One run per arm. Earlier rounds put run-to-run variation in planning at 17
against 24 requests on identical setups, so a nine-request gap is not
separable from noise on its own; what the run establishes is that there is no
evidence for 25,000 and some against. What it does not say is what happens on
a session that reads a 40 KB file once and moves on, where the sweep's 40%
applies with no return trip. The default stays at 60,000 until a run of that
shape says otherwise.

**2026-09-12 — the band is measurable now.** That open question could not be
answered by the benchmark either: its fixtures ran 7, 12, 14, 16, 68 and 144 KB,
**nothing between 25 and 60 KB**, so both triggers capped the same two files and
the knob had nothing to move. Two generated sources now sit in the band at 30 KB
and 45 KB, each with a decisive line past 300, and a `cap-sweep` section runs
every fixture through `readMaxBytes` × `readLimitLines` recording whether the cap
fired, how many lines the model receives, and **whether the decisive line is among
them** — 180 rows, no paid session
([tokenbrake-bench](https://github.com/33kain/tokenbrake-bench), `results/DEVIATIONS.md`).
The column that matters is the last one: bytes withheld and answer withheld are
different numbers, and reading them as one is what made lowering the trigger look
like a saving before the A/B and a loss after it (40% more cache reads).

## The Read cap's trigger — pre-registered 2026-09-12, before the numbers

`readMaxBytes` decides *which* reads get capped. The record against moving it: the 2026-09-07 A/B lowering it
to 25,000 read **+40%** cache tokens, 34 requests against 25 — on a task that said "read in full". The record for moving it:
in a real 40-request audit the six unbounded reads ran 1, 8, 15, 16, 31 and 34 KB, **none reached 60,000**, and
the two largest carried half the Read total. And as of today, the source-file cap has fired **zero** times on
real work, so at 60,000 the trigger catches nothing this owner does.

**The sweep is confirmatory only, and that is settled without running it.** Computed directly from the bench's
`fixtures/manifest.json`: `F15_band_30k` is 30,004 bytes / 684 lines / 43.9 B per line with its decisive line
at 411, 60% deep; `F16_band_45k` is 45,006 / 1,040 / 43.3 with its decisive line at 633, 61% deep. The trigger
never changes what a capped read withholds — every value below the file's size gives the same number — and the
*safe* limit is pinned by how deep the decisive line sits, which in these fixtures is the constant `0.62` in
`fixtures/lib/sources.mjs:1085`. "A safe limit withholds at most ~38%" is `1 − 0.62` restated, not a
measurement. `results/DEVIATIONS.md` already warns about exactly this.

**What `report --reads` adds, and what it cannot.** It measures the withholding half from the owner's own
reads — with Claude Code's line numbering stripped, without which every file is overstated by 5-6% and the
long ones more. It cannot measure the saving: whether the model comes back for what a cap withheld is
behavioural and is in no transcript. This mode does not replace the paid session; it decides whether one is
worth running.

**Q1, the trigger — decision rule.** Lower `readMaxBytes` from 60,000 to the largest candidate T satisfying
**all three**: it catches at least **5** whole-file reads; those carry at least **20%** of all bytes read
whole; and at `readLimitLines` 800 — this morning's answer, which travels with any trigger change — the median
withholding on the newly-caught reads is at least **25%**. If no candidate satisfies all three, **60,000
stays** and the argument it never had gets written down: below roughly 55 KB a limit safe at this owner's
target depth delivers the whole file, so a lower trigger fires more often and saves nothing. A candidate that
passes earns the paid test, it does not skip it.

**Q2, the shape — decision rule.** Compare the coefficient of variation of target depth as a **fraction**
against the same in **absolute lines**, over reads whose file length came from an exact source (not from disk
now). If the fractional spread is at least **25% tighter**, targets scale with file length, `readLimitLines`
is the wrong shape, and the fractional cap gets its own pre-registration — not the same change. If the
absolute spread is tighter, a fixed line count is the right shape and that is the first evidence for it. Under
**20** reads with an exact length: no verdict.

**Written expectation.** I expect the absolute spread to be tighter, and Q1 to fail its third condition,
leaving 60,000 in place. The specific risk, named because this morning's prediction failed for a reason of
exactly this kind: his whole-file reads may be dominated by one or two large files, and the medians would then
be one file's shape rather than a workload's.

**Result — 2026-09-12, run on the owner's machine.**

**Q1: no candidate passes, so 60,000 stays.** 33 whole-file reads of 27 files, 701,372 bytes, median 18,293,
90th percentile 59,374, largest **62,476** — his whole-file reads stop just above the trigger. The grid:

| trigger | reads caught | share of bytes | withheld at limit 800 |
|---|---|---|---|
| 10,000 | 16 | 95% | **8%** |
| 25,000 | 13 | 88% | **8%** |
| 30,000 | 12 | 84% | **17%** |
| 45,000 | 8 | 64% | **17%** |
| 60,000 | 2 | 18% | 20% |

Conditions one and two pass down to 45,000 and condition three fails everywhere: nothing reaches 25%. **The
argument 60,000 never had, now measured rather than estimated:** the limit that keeps this owner's targets
makes the cap nearly a no-op on every file he reads, so a lower trigger fires more often and saves almost
nothing. The self-cancelling arithmetic predicted from an assumed 50 bytes per line holds on his real files.
The written expectation — that Q1 would fail its third condition — was right this time.

Three reads could not be sized. They were checked before the rule was applied, because unsized reads sit
exactly where they could swing the withholding median: all three failed for reasons other than Claude Code's
size refusal, so they are failures and not large files, and the grid is complete.

**Q2: no verdict on the first attempt, and the reason was fixable.** The rule requires 20 reads whose file
length came from an exact source. There was **1** —
the other 42 lengths were read off disk today, which the rule excludes because a file may have changed since
the read. The numbers exist (absolute CV 1.21, fractional 1.05, so the fraction is 13% tighter, short of the
25% the rule demands) and are **not admissible**. The shape question stays open, and the expectation that the
absolute spread would be tighter is neither confirmed nor refuted: the test did not run.

Worth a second look, from the inadmissible source and so a lead rather than a finding: target depth is
**bimodal** — 21 reads in the first 10% of a file, then 15 at 50-60%. Two habits, "read the top" and "read the
middle", which one cap value cannot serve. **Caveat added the same day:** that histogram was built from
disk-today lengths, which are systematically too long because files grow, so every depth in it is too shallow.
It is a lead about shape, not a measurement of it.

**Two exact sources added afterwards, so the rule can actually run.** First, the guard now writes a
`read-whole` ledger row for every unbounded Read it does not cap, with the statSync size and a newline count.
Second, and retroactively over transcripts that already exist: **a read that ran off the end of its file says
exactly how long that file was.** A `sed -n 'A,Bp'` or an offset+limit `Read` that comes back short ended at
EOF, and the last delivered line is the file's length. On this repo's transcripts 40 of 163 sed ranges
qualified; the report's own session went from 1 exact length to 17. A result the guard trimmed is refused
outright -- it is short because the guard cut it, and without that check every capped read would read as a
short file, which is the same error that has now been caught five times today and always in the guard's
favour.

**Q2, second attempt — the rule ran, and my rule had a hole in it.**

With the off-the-end source the exact count went from 1 to **45**, past the 20 the rule needs. 44 of those 45
lengths came from a read that ran off the end of its file; 1 from a whole-file read in the same session; 5 more
reads resolved only off disk and are excluded from the verdict, as the rule requires.

| spread over 45 exact reads | coefficient of variation |
|---|---|
| absolute start line | **1.12** |
| depth as a fraction of the file | **0.98** |

The fraction is tighter by **12.5%**. The rule demanded **25%**. **Not met, so no change to the shape is
licensed** — and `readLimitLines` stays an absolute line count.

**But the rule's two branches do not cover this, and that is my error, not the data's.** It said: fractional at
least 25% tighter means the knob is the wrong shape; *absolute tighter* means a fixed line count is the right
shape and is the first evidence for it. Here the fractional spread **is** tighter, just not by enough. So the
second branch does not fire either: this is not evidence that a fixed line count is right, it is a refusal to
act on a 12.5% lean. A rule with a threshold needs three outcomes and mine named two. **Recorded as written and
not re-scored** — the same refusal as round 1's band statistic. What it licenses is nothing, which is the
correct outcome of a threshold that was not met.

**And the likely reason neither shape wins, which is the useful part.** Target depth is strongly **bimodal**:
23 of 50 reads land in the first 10% of a file, then 15 cluster at 50-60%, with almost nothing between. Two
habits -- "read the top" and "read the middle" -- and **no single parameter of either shape serves both.** A
similar CV for the two shapes is what that looks like. This survives the disk-length caveat, because the
off-the-end source now supplies most of the lengths.

So the shape question is not "absolute or fractional" but **"is one number the right form at all"**, which
neither this rule nor its data was built to answer. Any next attempt needs its own pre-registration, and the
statistic should be the decision-relevant one rather than a spread: for each candidate of each shape, the miss
rate against the median withholding, and then which shape's frontier dominates. That comparison is exact
arithmetic over these same 45 reads and needs no new session -- but it must be written down before it is computed.

## `readMaxBytes` has a floor, and it is `maxChars` — found 2026-09-13

**The finding.** The two paths that share `readMaxBytes` do not share its floor, and every statement on this
page about "lowering the trigger" was written as though they did.

| path | compares | floor |
|---|---|---|
| PreToolUse, an unbounded `Read` | `statSync().size` against `readMaxBytes` | none |
| PostToolUse, a `cat` of one file | delivered `text.length` against `readMaxBytes`, **only after** `text.length > maxChars` | **`maxChars`** |

`guard.js:272` returns before any cap logic when a shell result is at or under `maxChars`. So **for a shell read,
`readMaxBytes` below `maxChars` is a dead knob**: setting it to 2,000 changes nothing for a result under 6,000
chars. That is correct behaviour in the guard -- the trim's threshold gates the whole POST path -- and it was
simply not modelled anywhere the trigger was reasoned about.

**How it surfaced, which is the part worth keeping.** Asked what a trigger of 2,000 with `readLimitLines` 30
would have saved in one session, `report --reads`' grid answered **2 of 5** whole-file reads caught. Simulating
the guard's own path answered **1**. The grid applied `bytes > trigger` and nothing else, so every row below
`maxChars` overstated its count -- and the withheld medians in those rows were taken over the same inflated set,
which is the half that would have fed a decision. Third time in two days that these two paths gave different
answers: the `--caps` zero that counted one path, the capped-`cat` sizing that used the guard's own output, and
now the grid's floor. `triggerGrid` takes `maxChars` now, marks a row where the gate bites, and `--reads` states
the floor unconditionally -- with the default triggers all above 6,000 no row is ever marked, so a reader asking
about a low trigger would otherwise never be told.

**The measurement that produced it, n=1 and labelled as such.** One session, 1,479 requests over four days,
58M carried token-reads. Five whole-file reads, **all** shell `cat`s: 6,557 / 2,220 /
1,508 / 257 / 59 chars. At trigger 2,000 with cap 30 exactly one is affected -- `cat LANDSCAPE.md`, 84 lines,
carried 871,948 token-reads across 532 requests -- and it withholds **60.6%**, not the 64.3% that `30/84` gives,
because the model receives the guard's own 239-character note in place of the text. That is **~528k carried
token-reads**, against what the trim actually saved in the same session (that comparison was recorded in cost
only; not restated here — tokens-only record). The other four reads are
under `maxChars` and never reach the cap at any trigger.

**What it does not license.** No default moves on one session, and nothing on this page changes its numbers: with
`maxChars` 6,000 and the grid's candidate triggers starting at 10,000, every row was already above the floor.
Q1's decision rule stands as written, with one clause now explicit -- **a candidate T below `maxChars` cannot
satisfy it for shell reads at all**, whatever the arithmetic says, so the search space for the trigger starts at
`maxChars` and not at zero.

## The Read cap's form — pre-registered 2026-09-12, before the frontier is computed

The spread rule licensed nothing and named the reason it could not: a coefficient of variation says how
concentrated a distribution is, which is only a proxy for what actually matters — whether **one number of that
shape** can keep the model's targets without withholding so little that the cap does nothing. This is the
decision-relevant comparison, over the same 45 reads whose file length is known exactly. It is arithmetic and
needs no new session. Written down first because the thresholds are the whole argument.

**The two shapes.** An **absolute** cap delivers the first `L` lines whatever the file's length — so it
withholds most of a long file and nothing at all from a short one. A **fractional** cap delivers the first
`f` of the file — so it withholds `1 − f` of every file, the same share regardless of size. They are genuinely
different trades, not two spellings of one.

**Computed per candidate, over each read's (start line, file length):**

- **miss rate** — the share of reads whose target sits past what the cap delivers. Absolute `L`: hidden when
  `start > L`. Fractional `f`: hidden when `start > floor(f × lines)`.
- **withholding** — the median over those same reads of `(lines − delivered) / lines`.

Candidates: `L ∈ {100, 200, 300, 500, 800, 1200}` and `f ∈ {0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8}`, plus
**no cap at all** (miss 0, withholding 0) as the anchor, because a shape that cannot beat doing nothing is not
a shape worth having.

**The rule — WITHDRAWN 2026-09-12, before it was ever run on real data, and replaced below.** One shape
dominates the other if, at every withholding level the other reaches — matched to the nearest candidate within
5 percentage points — its miss rate is no higher, and is lower by at least 10 points at one or more of them.

**Why it was withdrawn.** It cannot discriminate. A fractional cap is all-or-nothing on targets that sit at a
fixed depth — it misses everything below that depth and nothing above it — while an absolute cap degrades
gradually. Two curves of different curvature are almost never one uniformly below the other, so a single bad
level at the aggressive end (where both miss nearly everything and the result is useless either way) breaks
domination. Run against synthetic data **built to favour each shape in turn**, it returned "neither" for both.
An instrument that returns the same answer whatever it measures is not measuring.

Found on those fixtures **before** it touched the owner's data, which is the only reason replacing it is not
re-scoring. The fixtures are in `test.mjs` and the replacement must separate all four of them: targets at a
fixed depth, targets at a fixed line, a bimodal habit, and targets at the end of their files.

**The rule, replacing it.** Hold **safety** fixed and compare **saving**, which is the trade the cap actually
makes. For each shape, among its candidates whose miss rate is at or under **25%** — the same budget the
strength rule used — take the **most any of them withholds**. `no cap` is always on that list at zero
withholding, so a shape whose best safe candidate withholds nothing cannot be both safe and useful here.
A shape wins by withholding at least **10 percentage points** more than the other.

- Fractional wins → `readLimitLines` is the wrong **form**; a fractional cap gets designed under its own
  pre-registration and its own A/B. Not today, and not as a value change.
- Absolute wins → the current form is right, and this is the first evidence for it in the project.
- Within 10 points of each other → **a tie**, and no change. Note that if every file were the same length the
  two shapes would be the same cap and a tie would be arithmetic rather than a finding; his files are not.
- **Neither can be safe and useful** — both best-safe candidates withhold nothing → one number is the wrong
  form for this workload, and no value of either shape fixes it. Record it and stop tuning the shape.

Fewer than **20** reads with an exact length: no verdict.

**Written expectation.** Neither dominates. Target depth is bimodal — 23 of 50 reads in the first 10% of a file
and 15 at 50-60% — so any single threshold that keeps the shallow group cheaply must miss the middle group, in
either shape. If that is right, the answer to "absolute or fractional" is "neither, and the question was
wrong", which is a more useful result than picking one.

**Result — 2026-09-12, over the owner's 45 reads with an exact file length.**

| shape | safest useful cap at a 25% miss budget | withholds | misses |
|---|---|---|---|
| absolute | first **800 lines** | **22%** | 13% |
| fractional | first **60% of the file** | **40%** | 11% |

**FRACTIONAL wins, by 18 points of withholding** — nearly twice the saving, at slightly better safety. The
threshold was 10. **`readLimitLines` is the wrong form.** What that licenses is exactly what the rule said:
a fractional cap gets designed under its own pre-registration and its own A/B. **Not today, and not as a value
change.** Nothing ships from this.

**My written expectation — "neither dominates" — was wrong.** I expected the bimodal depth distribution to
defeat both shapes. It defeats the absolute one and not the fractional: the 60% cap clears the 50-60% cluster
while still cutting 40% off every file, whereas an absolute cap loose enough to clear that cluster on a long
file (800 lines) withholds nothing from a short one. That is the mechanism, and it is the opposite of the
reason I gave for expecting a tie.

**The hole in this rule, and it is the third of the day.** The statistic is the median share of *lines*
withheld, which weights every file equally regardless of size. A fractional cap also cuts short files, where
the saving in tokens is small — so part of its 18-point margin may be saving that is not worth having. A
**token-weighted** withholding measure could narrow or reverse it. Recorded as a condition on the verdict, not
as a reason to discount it: the rule ran as written and returned fractional, and any fractional cap design must
carry this question into its own pre-registration and answer it before a line of it is written.

**A bug in the reporting, caught by the owner's console rather than by the suite.** The block crashed after
printing the table, and the sentence above the crash still described the *withdrawn* criterion. The shape block
needs 20 exact lengths before it prints at all, and no test fixture ever reached that, so a green suite shipped
both. A fixture that reaches it is now in `test.mjs`; the numbers above were computed before the crash and are
unaffected.

## A fractional Read cap — pre-registered 2026-09-12, before any of it is built

The form comparison said `readLimitLines` is the wrong shape: at a 25% miss budget the best absolute cap
withholds 22% of a file and the best fractional one withholds 40%, missing slightly less. This is what that
licenses and nothing more. **Written before a line of it exists, including the two conditions that would kill
it.**

### Step A — the token-weighted re-test, and nothing proceeds until it passes

The winning statistic was the **median share of lines** withheld, which weights a 200-line file the same as a
2,000-line one. A fractional cap cuts short files where an absolute cap does nothing, and on a short file that
saving is small in tokens. **Part of the 18-point margin may be saving not worth having**, and that has to be
settled before anything is designed, not after.

Tokens per file are estimated per file, not globally: a ranged read delivers *N* lines in *C* characters, so
that file's bytes per line is `C / N` — exact, contemporaneous, and specific to the file rather than an
assumption about source code. It varies from 28 to 56 in the files already on record, which is exactly why a
global figure will not do.

Re-run the same comparison with withholding measured as **total tokens withheld across all reads** —
`sum(lines_withheld x bytes_per_line) / 4` — instead of the median share of lines. Same 25% miss budget, same
candidates, same 10-point margin expressed as a share of the total tokens the reads represent.

- Fractional still wins by ≥10 points → proceed to Step B.
- Tie, or absolute wins → **stop.** `readLimitLines` stays, in form and in value, and the line-share result is
  recorded as an artifact of weighting every file equally. No fractional cap is built.
- Fewer than 20 reads with both an exact length and a measurable bytes-per-line → no verdict, and nothing is
  built on a verdict that does not exist.

**Written expectation for Step A.** Fractional still wins, but by less — I would guess 8 to 14 points, which
straddles the threshold. His whole-file reads have a median of 18 KB, so short files are a real share of the
population and the correction is not negligible.

### Step B — what gets built, and what deliberately does not

A `readLimitFraction` setting, **default unset**, alongside `readLimitLines` rather than replacing it:

- When set, a capped read delivers `floor(fraction x lineCount)` lines. The guard already counts lines when it
  caps (`guard.js`), so nothing new is read from disk.
- When `lineCount` is null — a file over 20 MB, where the guard skips the count — it falls back to
  `readLimitLines`. A fraction of an unknown length is not a number.
- Both set: the cap keeps the **smaller** of the two. A fraction is a safety floor on short files, not a licence
  to deliver more than the absolute cap allows.

**The default does not change, and that is the point.** 0.6 came from one person's 45 reads. The product now
has `report --reads`, which tells any user which shape suits their own reading and what value of it — so the
honest shipping decision is the capability plus the measurement, not a new default inherited from the owner's
files. Shipping 0.6 for everyone would repeat, in a new place, the thing that put an unargued 60,000 and an
unargued 300 in the defaults in the first place.

### Step C — the A/B, and the reason it cannot be a session-total A/B

**The obstacle, stated before choosing an endpoint.** The Read cap has never fired on the owner's real work in
any session where the guard was running, so his own workload cannot test this at all. The benchmark can trip
it, but round 1 measured its OFF/OFF control band as a band far too wide to resolve an 18-point difference in
withholding (that band was recorded on cost only; the figure is not restated here — tokens-only record).
**A session-total endpoint cannot answer this question at any affordable number of
sessions, and pretending otherwise is how the 2026-09-07 trigger A/B produced a number nobody can use.**

So the endpoints are the two that are not swamped by that band:

1. **Deterministic, free, and first:** the bench's `cap-sweep` gains a fractional arm. Per fixture and per
   candidate, whether the cap withholds the **decisive line** — the column that already exists and already
   distinguishes bytes withheld from answer withheld. A fractional cap that hides the decisive line more often
   than the absolute one at equal withholding is refused here, before any session is paid for.
2. **Session-level, and the same endpoint round 2 is pre-registered on: recovery reads.** Sign test over ≥7
   pairs, two-sided p ≤ 0.05. **Kill condition:** if the fractional arm shows more recovery reads than the
   absolute arm in a majority of pairs, the design is refused regardless of what it withheld. Round 1 found
   every ON arm making more recovery reads than its OFF arm, which is the failure mode this endpoint exists to
   catch.

Session token totals are recorded from every run, as always, and **may not be quoted as a result** — the band
forbids it. They are there to notice a disaster, not to declare a win.

### What would make me abandon this entirely

- Step A reverses or ties. Most likely outcome, and it needs no session to find out.
- The sweep shows the fractional cap hiding decisive lines more often at equal withholding.
- The recovery-read kill condition fires.
- A fourth hole turns up in this rule before it runs. Three rules today have had one, all three in the
  product's favour, and the next one is not free — it is the reason nothing here ships on a single measurement.

**Result — Step A, 2026-09-12. TIE at 9 points against a threshold of 10. STOP: nothing is built.**

45 of 45 reads carried a bytes-per-line of their own, over the 20 the rule needs.

| shape | safest useful cap | saves, by median share of lines | saves, by share of tokens | misses |
|---|---|---|---|---|
| absolute | first 800 lines | 22% | **31%** | 13% |
| fractional | first 60% of the file | 40% | **40%** | 11% |

**Exactly half the margin was a weighting artifact.** 18 points on share of lines, 9 on tokens. The mechanism is
clean and worth keeping: a fractional cap withholds the same share of every file, so its number does not move
between the two measures at all. An absolute cap cuts hardest on long files, which is where the tokens are, so
its share rises from 22% to 31% once tokens are what is counted. Step A existed for precisely this, and it
found precisely this.

**9 against 10, and the rule decides.** That is one point, on a threshold I chose myself, for a design I
proposed. It would take one sentence to call it "essentially ten" or "inside the noise". **No.** The rule was
written before the measurement, it says tie, and a tie means `readLimitLines` stays **in form and in value** and
no fractional cap is built. Recorded here rather than argued down.

**My written expectation was half right, which is the honest way to score it.** I predicted "fractional still
wins, by 8 to 14 points". The magnitude was right — 9 sits in that range. The verdict was wrong, because 9 is
below the line I had already drawn. Predicting the number and missing the conclusion is not a successful
prediction.

**So the form question closes with no change, and the whole Read cap is now settled:** `readMaxBytes` 60,000
(rule failed at every candidate), `readLimitLines` 300 with 800 decided and held for a trigger change that the
same evidence says should not happen, and the form absolute (tie on the measure that decides). Three questions,
three answers, none of them a change, and every one of them now has an argument where before it had a guess.

## Does the trim's mechanism appear when the agent has decent tools? — pre-registered 2026-09-12

Round 2's pilot abandoned its schedule because the guard rewrote **nothing the model saw**: every shell result
in the ON arm was under the 6,000-character threshold. The fixtures put six logs inside the trim's window on
purpose; the agent, handed a CLI with `summary` and `log --step=`, sliced instead of dumping.

Round 1's workload had no slicing tools -- `diag.js`, `bank-trace.js`, `ledger-dump.js` print and stop -- and
there the mechanism was present. So the hypothesis this question exists to test is uncomfortable for the
product: **the trim's mechanism may be a property of bad tooling rather than of hard work.** A tool that dumps
makes trimmable output; a tool that slices does not, and a model that can slice will.

**This is answered from the owner's own sessions, free, and not from a paid round.** His real work is a better
sample of "an agent with decent tools" than anything a fixture can stage, and it is already on disk.

### The measurement

A new `report --reach`, pooled across sessions with the same workload filter the other views use. Of every
tool result, the share that sits where the trim can act at all: shell, exit 0, over `maxChars`, under Claude
Code's inline ceiling. Reported by count and — the column that matters — **by share of carried tokens**, since
ab10 established that a result's carried tokens are its size times the later requests that re-read it.

Alongside it, the commands that produced those results, grouped by the program invoked. That is what turns a
number into an answer about tooling: if the trim's reach comes from three commands and all three are dumps
with no ranged mode, the mechanism is a tooling artifact and the honest advice is to fix the tool.

### The rule, fixed before the numbers

Let **W** be the share of all carried tool-result tokens sitting in the trim's window, pooled across the
owner's non-benchmark sessions.

- **W < 5%** → the mechanism is essentially absent on real work with real tools. No quality of trimming can
  matter at that share, and the product's own README must say so in those words.
- **W ≥ 20%** → the mechanism is present and worth having, and round 2's null is about the CI task's tooling
  rather than about agents in general.
- **5% ≤ W < 20%** → present but marginal. Report the number, make no claim either way.

Under **10 pooled sessions**, or under **200 shell results**: no verdict.

**Written expectation.** W lands under 10%. Round 2's agent sliced when it could, the Read cap has already
been shown never to fire on this owner's real work, and `--where` showed his reads arriving already bounded.
The picture those three make is of an agent that mostly asks for what it wants. If that is right, the useful
product is the report rather than the guard — which is a finding about tokenbrake, not about this session.

**Result — 2026-09-12: NO VERDICT, and the rule's own minimum is why.**

Pooled over 40 non-benchmark sessions: 679 tool results, 16.4M carried tokens, 54 results inside the trim's
reach carrying 2.71M — **16.5%**.

**That number is not the measurement.** The guard was recording in only **8 of the 40 sessions**; in the other
32 it was never installed, and there "inside the reach and untouched" says nothing about the product. Measured
over the 8 sessions it did run in: **11 results in reach, 260,475 carried, W = 4.4%**, of which it acted on 4
and left 7 alone — reaching **22% of the carried tokens it could have**.

**8 sessions is under the rule's minimum of 10, so there is no verdict.** 4.4% sits in the band the rule calls
"essentially absent", and it does not get to be quoted as that. The minimum exists for exactly this moment:
the number that arrived is the one I expected, and wanting it is not a reason to accept a sample the rule
already refused.

**What it needs:** 10 sessions with the guard actually running, and 200 shell results inside them. That
accumulates on its own, and much faster with a user-scope install — currently 8 of 40 sessions had the guard
at all, which is a coverage fact worth knowing in its own right.

**A prediction I scored against the wrong number.** I called my written expectation ("W under 10%") a failure
on seeing 16.5%. But 16.5% pools 32 sessions the guard never ran in. Properly measured it is 4.4%, consistent
with the expectation — and with no verdict, neither reading is a result. The retraction is of my own scoring,
not of the expectation.

**And a defect in the view, one line below the one it had just fixed.** The tool table — `sed` at 32 results
and 77% of in-reach carried tokens — was pooled over all 40 sessions while the verdict was taken from 8. A
tool list from sessions without the guard describes a machine that is not running this product. Now split the
same way, with the all-session figures kept as labelled context rather than as evidence.

**The question this was built to ask remains open**, and the suspicion behind it is unresolved: that 0.2.6's
excerpt exemption — shipped on the evidence of one pair, and documented as trading "acting less for acting
wrongly less often" — took most of the guard's remaining reach. `sed` ranges are exactly what it exempted.
Whether that is true needs the guard running in enough sessions to see, and it is the first thing this project
has measured that could overturn a change I made myself rather than a default someone inherited.

**And a discrepancy that outranks the knob.** `--reads` finds **2 whole-file reads over 60,000 bytes** on real
work; `--caps` finds **0** caps on real work from either path. Identical evidence supports "the cap is inert on
this workload" and "the cap is not running on this workload", and those are opposite conclusions. `--reads`
now separates them from the ledger: a session with no ledger row never had the guard; a session the guard was
recording in, whose over-trigger read still went through, is a defect.

**Resolved the same day: not a defect.** Both reads sit in sessions with **no ledger row at all** (`460d9673`,
`3c9cde47`) -- the guard was not running there and the cap never had a chance. So the zero is genuine and the
"inert, not broken" reading is the right one.

It also sharpens the finding past where the rule needed it. Every read over 60,000 bytes is in a session
without the guard, so across the **11 sessions where the guard was running, not one whole-file read reached the
trigger.** The cap is not rarely useful on this workload; in the sessions where it runs it is never reached.

Two consequences worth carrying:

- A paid test of the trigger **cannot use this owner's own workload as its scenario**, because his workload with
  the guard on never trips it. Any such test is measuring a task constructed to trip it, which is what the
  2026-09-07 A/B did and is the weakness already on its record.
- 2 of 13 real sessions ran without the guard at all. That is a coverage gap rather than a tuning question:
  project-scope installs only cover the repo that carries them, and `tokenbrake status` says what is installed
  where.

## The Read cap's strength — pre-registered 2026-09-12, before the numbers

`readLimitLines` is the other half of the Read cap: `readMaxBytes` decides *which* reads get capped,
`readLimitLines` decides how much a capped read withholds. The sweep settled that the trigger cannot change
the saving per capped read; only this knob can. It has never been argued for either.

**What made it answerable, and what nearly made it wrong.** `report --where` pools a person's own *ranged*
reads — a `Read` with an offset, a `sed -n 'A,Bp'` — because a range is the model saying where it expects to
find something. Run over seventeen of the owner's real sessions it gave **111 ranged reads, median start line
351, 57% of targets past line 300.**

That figure is confounded, and in the guard's favour. A capped Read delivers lines 1..300 and its
`additionalContext` tells the model in words to come back with an offset. The follow-up is a ranged read
starting just past 300 — counted as a target the cap would hide, when it is the cap's own instruction being
measured. Every one of those seventeen sessions ran with the guard on, and round 1 recorded the cap firing one
to four times per ON run. A median of 351, sitting just past the 300 the guard had been applying all along, is
what that looks like. It is the same circularity that disqualified the earlier 48% figure, arriving from the
other direction: the first time it was fixtures built with the evidence past line 300, this time the guard
instructing the model to read past line 300.

So the ledger's `read-cap` rows are joined against the reads — same session, same file, issued after the cap
fired — and the report prints two columns: all ranged reads, and the **spontaneous** subset.

**The decision rule, fixed before the split was run.** From the spontaneous subset only, take the smallest
L in {300, 500, 800, 1200} whose share of hidden targets is **≤ 25%**.

- Spontaneous subset **under 20 reads** → change nothing; the sample does not carry the decision.
- **No** candidate at ≤ 25% → change nothing, and record it: on this workload the cap cannot be made safe
  without becoming a no-op. The trigger is 60,000 bytes, so every file the cap touches runs roughly 1,500
  lines or more, and a limit near 1,200 on a 1,500-line file barely cuts.
- No paid session either way. The distribution is observational and the saving per capped read is arithmetic.
  Only `readMaxBytes` needs a session, because only there is the question behavioural.

**Written expectation, before the numbers.** The spike diagnostic fires at 300 and at 80, and the spontaneous
past-300 share falls from 57% into roughly 20–35%, leaving 300 or 500 as the answer. If the spike reports
`none` and the spontaneous share holds at or above 50%, the confound was small, 57% stands, and the rule picks
800 or refuses. Either is a result and gets recorded as one.

**What no version of this can establish.** Attribution is by file identity, so one cap marks every later
ranged read of that file — which inflates the excluded count rather than the clean one. And a cap on one file
that teaches the model to read a *different* file with an offset stays counted as spontaneous, so that column
is a **lower bound** on the guard's influence. Only a hooks-off arm settles it.

**Result — 2026-09-12, run on the owner's machine over 62 sessions on disk.**

**The prediction failed, and it failed in the direction that matters.** I expected the spike diagnostic to
fire and the spontaneous past-300 share to fall from 57% into 20–35%. Neither happened. The confound is
**3 of 111 reads, 2.7%** — all three from one persisted spill file — and the share moved from 57% to **56%**.
The spike test reports `too few to say` at both 300 and 80, because there was almost no echo to find.

Why I got it wrong: I took round 1's firing rate — one to four caps per ON run — as the rate on real work.
Round 1 is the benchmark, running fixtures built large on purpose. That is the exact substitution the
workload filter in `report --where` exists to prevent, made one level up, about the ledger instead of the
transcripts.

**What `--caps` found instead, and it is the larger finding.** Twelve caps across seven sessions. **Eleven of
the twelve are benchmark sessions.** Exactly one fired on real work: a 112 KB Claude Code spill file in a
`contexa` session, capped at 80 of 2,011 lines, 4% delivered — and that one cap is what produced all three
induced reads. So the model came back three times for one cap on real work, n=1 and not a measurement, but
the mechanism in miniature.

**Source-file caps on real work: zero.** Every one of the six fired inside the benchmark — five on
`settle.js`, one on `ledger-entries.json`. It agrees with the 40-request audit: unbounded reads there
ran 1, 8, 15, 16, 31 and 34 KB, and the 60,000-byte trigger needs roughly double the largest of them.

**Corrected later the same day: that zero covered one of two paths.** `readMaxBytes` and `readLimitLines`
govern the PreToolUse Read cap *and* the POST path that caps a `cat` of a large file (`guard.js:283-296`) --
but the second logs `ev: 'post', excerpt: true`, not `ev: 'read-cap'`, so a counter reading only `read-cap`
rows sees half the feature and calls the other half zero. `report --caps` counts both now and prints them
apart. The sentence that stood here -- that `readLimitLines` governs a cap which has never once fired on this
owner's own work -- is **withdrawn in that form**: it holds for the Read path, and the shell path was never
measured. It does not change this section's verdict, which rests on where the targets sit, not on the count.

**The rule's verdict.** Spontaneous subset 108 reads, over the 20 needed. Hidden share by candidate:
300 → 56%, 500 → 40%, **800 → 20%**, 1200 → 8%. The smallest L at or under 25% is **800**.

The no-op clause does not bite. The two source files ever seen over the trigger ran 1,297 lines (68 KB) and
2,570 lines (72 KB) — 53 and 28 bytes per line, so the "1,500 lines or more" I assumed when writing the rule
was itself a guess, and wrong in both directions. At 800 those two withhold 38% and 69%. Against 300's 77%
and 88%, the cut roughly halves while the miss rate falls from 56% to 20%.

**So: 800, and it changes nothing today.** The knob is inert on this workload, which is why the choice is
free — and why it is a prerequisite rather than an improvement. It matters only if `readMaxBytes` ever comes
down, and 56% past line 300 is exactly why the 2026-09-07 attempt to bring it down read +40% cache tokens.

**Unchecked, and it stays on the record.** One session contributes 29 of the 111 reads, 27% of the pool. No
jackknife was run. The decision is insensitive to it today because the cap does not fire on real work at all;
it becomes live the moment the trigger moves.

**Decided 2026-09-12: 800 is the answer and it is NOT applied.** Neither the shipped default nor the owner's
own config changes. The reasoning is the zero: a knob that has never fired on this workload cannot be improved
by retuning it, so 800 is held and goes in **in the same step** as any move on `readMaxBytes`, which is the
only thing that would make it fire. Deciding it now rather than then is the point — the value is fixed by a
rule written before the numbers, so a future trigger change cannot quietly pick its own limit to look good.

The downside of holding, stated so it is not a surprise: until then, an unbounded read of a file over 60 KB still
gets 300 lines, with a 56% chance on this workload that the model has to come back for the part it wanted.
That is one return trip on a rare event, against a default change whose blast radius includes the
shell-excerpt path (`readLimitLines` is also what caps a `cat`/`sed`/`grep` of a large file, guard.js:292)
where no equivalent measurement exists.

## Feature round — run 2026-09-07, Opus 5 both arms

The audit is reading without writing and the debugging round is a test loop;
ordinary work is neither. This round is a small feature on `33kain/contexa`:
add a check to `build.mjs` that the first `## <version> —` heading in
`CHANGELOG.md` carries the manifest version, with a test covering the passing
and the failing case, and `npm test` and `node build.mjs` green. One message
per arm, the same to the letter apart from step 0. Each arm commits its code
to its own branch and its report to `ab-results/feature-<arm>.txt`.

Arm A ran from `claude/feature-A-nohooks`, main with an empty
`.claude/settings.json`, so brake 1 was off from session start without any
write to `~/.claude`. That was the second attempt: the first arm A was told to
write `{"enabled": false}` to `~/.claude/tokenbrake.json`, the permission
classifier refused the write (Write tool and shell redirect alike), the
session said so and did not work around it, and so ran with the project hooks
on. That run is kept below as a second hooks-on reading of the same task. Arm
B wrote `{"enabled": true}` and ran from main.

| session record | arm A, hooks off | arm B, hooks on | change | first arm A, hooks on (voided) |
|---|---|---|---|---|
| cache-read tokens | 2,614,181 | 2,713,808 | +4% | 3,435,844 |
| output tokens | 16,022 | 13,902 | −13% | 18,071 |
| requests | 24 | 23 | | 30 |
| tool results entered (report) | 13k | 10k | | 11k |
| tool results carried | 222k | 159k | −28% | 206k |
| trimmed by the guard | 0 | 1 result, ≈ 4k tokens kept out, ≈ 79k token-reads not carried | | 2 results, ≈ 4k kept out, ≈ 109k not carried |
| `npm test` runs | 3 | 2 | | 2 |
| `node build.mjs` runs | 2 | 3 | | 3 |
| result | check + test, both green | check + test, both green | | check + test, both green |

All three trees pass `npm test` and `node build.mjs` when checked out clean.

**Result: a null, and the noise is now measured.** Cache reads +4%, one
request fewer. The two hooks-on runs of the identical task, arm B and the voided arm A,
came out 27% apart in cache reads on nothing but how the
model planned (23 against 30 requests), so anything inside that band is not
the hook. The mechanism is the one from the debugging round: the model
bounded its own reads (`sed -n`, `grep -n`, `wc -l`, then ranges), and its
largest result was one `cat -n build.mjs` at 5k tokens, which the guard
trimmed to 1k in the hooks-on arms and left whole in the off arm. That is
where the −28% in carried tool results comes from, 63k token-reads against
2.3M processed: real, mechanical, and 3% of the session.

So three shapes are measured now. Read-heavy audit that asks for whole files:
−41% cache reads on Fable 5.1, −31% on Opus 5. Debugging loop: ≈ 0%. A small feature:
≈ 0%, inside the noise. The hook saves what the model would otherwise let in,
and on two of three shapes Opus lets little in. The `ab-results/real/`
files in `33kain/contexa` will say which shape ordinary sessions on that
repository take.

## Persisted outputs — the miss, and the rule for it (0.2.1, 2026-09-07)

One mechanism kept turning up on the wrong side of the guard. When a shell
result passes Claude Code's own ~30,000-character ceiling, Claude Code writes
it to `<config>/projects/<cwd>/<session>/tool-results/<id>.txt` and shows a
note; the guard's own trim does the same into `<config>/tokenbrake/out/`. The
model then reads that file. Whole. Seen three times, independently:

- the audit A/B: re-reads of persisted files were 96% of the untrimmed arm's
  carried context;
- the 40-request session in "The Read cap's trigger": `git log --stat -40`
  persisted, then read whole, 34 KB;
- the session that wrote this section, replayed with `scripts/sim-persisted.mjs`:

```
ced42a1a  /home/user/contexa  486 requests, 534 results
  reads of persisted outputs: 4 (3 unbounded), 44,130 tokens entered,
    5,911,014 token-reads carried = 24% of the session's 24,857,131
  with a 80-line cap on them: 37,205 tokens kept out,
    4,985,470 token-reads not carried = 20% of the session
     size    kept   turns    carried  not carried  what
   15090    1077    134    2022060      1877742  buq52pp79.txt
   13784    1307    134    1847056      1671918  b5tw2bsvt.txt
   12850    2135    134    1721900      1435810  blz8ddrye.txt
    2406    2406    133     319998            0  buq52pp79.txt  (bounded, untouched)
```

Four reads out of 534 results carried a quarter of the session. They sit at
30–65 KB, so the 60,000 trigger catches one of three, and the readMaxBytes
A/B above showed why the trigger cannot simply be lowered: it cuts source
files the model has to read whole, and the return trips re-read more tokens
than the cap saves.

The rule in 0.2.1 is narrower than a threshold. An unbounded Read of a file
under `tool-results/` or `tokenbrake/out/` is capped at `persistedLimitLines`
(default 80, the guard's own head+tail budget) whatever its size, with a note
that says why: the output was too big to show inline, so it is too big to
read whole. Source files are not touched; `readMaxBytes` stays at 60,000. A
bounded read of a persisted file is untouched, so a model that wants a range
of it gets the range.

What is measured: the replay above, and `test.mjs`. What is not: whether the
model, sent to `offset`/`limit` on a persisted file, comes back for the rest
the way it did for source files in the readMaxBytes A/B. The difference in
kind is that a source file is something the task may need whole; a persisted
output is a `git log` or a test dump whose head and tail were already judged
enough once. The `ab-results/real/` files will show the rule firing, or not,
on ordinary sessions; a live run of the audit shape is the confirmation if
those files show it firing often.


## The failing command — errorContextLines rounds, and the event the guard never saw (2026-09-09)

Two A/B rounds on the fault-injected debugging task, both arms with the hooks on, differing only in
`errorContextLines` (0 against 3), Opus 5, one message each. Both are nulls by construction, and the
reason is the finding.

| | v2 A, ctx 0 | v2 B, ctx 3 | v3 A, ctx 0 | v3 B, ctx 3 |
|---|---|---|---|---|
| requests | 16 | 18 | 30 | 50 |
| `npm test` runs | 3 | 3 | 5 | 5 |
| faults fixed | 5 of 5 | 5 of 5 | 5 of 5 | 5 of 5 |
| trimmed by the guard | 0 | 0 | 4 small results | 2 small results |
| the `npm test` failures | piped to `tail -60` | piped | 4 × ≈ 3k tokens, untrimmed | 4 × ≈ 3k tokens, untrimmed |

**v2.** Both arms ran `npm test 2>&1 \| tail -60`, so nothing crossed `maxChars` and the context lines
had nothing to attach to. Both arms also ran `git show HEAD` and read the planted faults from the
injector's commit: step 4 of the prompt said "the injector commits the faults", which was as good as a
map. Protocol flaw, closed in v3 by two rules: `npm test` as the exact command with no pipe or
redirection, and no git for finding faults. The arm A of v3 had its config write refused by the
permission classifier and wrote the same file with a shell heredoc; the config was right either way.

**v3.** The suite ran in full and failed in full, four times per arm, about 12,000 characters each, and
the report shows every one of them `[error]` and none `[trimmed]`. The guard never saw them. For Bash,
`PostToolUse` fires only when the command exits 0; a non-zero exit fires `PostToolUseFailure`, a
different event the guard was not registered for. Checked in the session that wrote this: a 300-line
command exiting 1 arrived whole, with Claude Code's own "12,439 characters truncated" in the middle and
no `[tokenbrake]` marker, and the ledger gained no row. So in every debugging round on this page, the
failing test output, the one thing the trim exists for, went past the guard. That is part of why the
debugging rounds read ≈ 0%.

**0.2.2 registers the guard for `PostToolUseFailure`.** The event's input carries the output in `error`
as one string, "Exit code 1" then the text, no `tool_response` on 2.1.261. The guard trims it, keeps the
exit line first, writes the full text to `out/`, and the ledger row says `failed`. And Claude Code ignores
the replacement. The debug log on 2.1.261: "Hook JSON output had unrecognized keys (ignored):
hookSpecificOutput.updatedToolOutput." A probe session on 2.1.266, the line the arms ran on: hook ran,
10,039 characters in, 5,078 offered, and the session received the raw output with Claude Code's own
elision of about 2,500 characters from the middle, about 7,500 delivered. Both string and Bash-object
shapes were tried. The hooks reference lists `updatedToolOutput` for this event; the builds do not honor
it.

What that leaves. A failing command's output is bounded by Claude Code at roughly 10,000 characters, with
the middle elided to about 7,500, and nothing a PostToolUseFailure hook returns changes it. The only
route left is a PreToolUse rewrite of the command so that it never exits non-zero from Claude Code's
point of view, with the exit code printed as the last line and the trim then applied under PostToolUse.
That is what rtk does to every command, and the JetBrains benchmark is the record of what rewriting
commands loses when it goes wrong: compound commands, heredocs, background jobs, `set -e`, the exit code
the model no longer sees as an error. Not a default. It could be an opt-in for suites known to be safe,
measured with this protocol before anyone relies on it.

The `errorContextLines` question itself stays open: on this task the trim fires on passing runs only,
and a passing run has no FAIL lines. It will be measurable when either Claude Code honors the field or
a task produces oversized passing output with flagged lines, which is the shape of a build log rather
than a test suite.

An issue for `anthropics/claude-code`, if the maintainers want one: "PostToolUseFailure hook:
`updatedToolOutput` is documented but ignored (2.1.261, 2.1.266)", with the debug-log line above and the
two-line reproduction in `PROBE.md`'s history on this repository's `claude/post-failure` branch.


## The first Windows run — 2026-09-09, Claude Code 2.1.240, Node 24, Git 2.55

`npx tokenbrake@0.2.2 init` and `status` on Windows 10, PowerShell: three hooks installed, three spawn tests
passed, with the node path carrying a space (`C:\Program Files\nodejs\node.exe`). `report` found the
transcript under `C:\Users\<user>\.claude\projects\C--Users-<user>-Desktop-contexa\` and read the
session's usage. Nothing platform-specific failed. The oldest open item on this page is closed.

The run also produced two findings, one of them a fault in the report:

- `npm test` on the CONTEXA suite printed 49.4 KB on Windows (27 KB on Linux; why is CONTEXA's question).
  That is over Claude Code's ceiling: the hook received 29,965 characters, kept 5,952, and offered the
  replacement; the model received Claude Code's persisted-output preview, 2 KB and a path. The report then
  said "tokenbrake trimmed 1 of them: ≈ 6k tokens kept out". It was Claude Code that kept them out. The
  report now credits a trim only when the result the model saw carries the `[tokenbrake]` marker, and
  reports the rest as offered and not applied. On the session that wrote this, re-checked against its
  transcript: seven trims applied and three not, the three being the over-ceiling and failing-command cases
  above, which the earlier reports on this page had counted as trimmed. The A/B rows above are from arm
  reports run before this correction; their "trimmed" counts were small results under the ceiling in every
  case listed, and the failing runs were already marked untrimmed.
- The ledger held two identical rows 16 ms apart for the one call: the repository has project-scope hooks
  and the user had just installed user scope too, so the guard ran twice. Harmless, doubled spawns;
  `status` now says so.

## Three arms: off, rtk, tokenbrake — run 2026-09-09, Opus 5, Claude Code 2.1.266

The head-to-head the launch post wanted: the same twelve-step audit, three Cowork sessions from the same
commit of `33kain/contexa`, differing only in what sat in front of the tools. One message each. The
expectations were written down before the run: rtk reduces output and stays within the run-to-run noise;
tokenbrake a clear saving on this shape (that expectation was written as a cost figure; not restated here —
tokens-only record), where it had measured −31% (Opus 5) and −41% (Fable 5.1) cache reads before.

| | off | rtk (void) | tokenbrake 0.2.2 |
|---|---|---|---|
| requests | 24 | 33 | **91** |
| cache-read tokens | 4,551,872 | 6,553,719 | 14,929,639 |
| output tokens | 8,126 | 11,328 | 16,289 |
| tool results entered (report) | 93k | 90k | 84k |
| tool results carried | 1.1M | 1.5M | 3.9M |
| Read calls | 8 | 0 | 0 |
| Bash calls | 15 | 32 | 90 |
| trimmed by the guard | 0 | 0 | 4 |
| answers | 12 of 12 | 12 of 12, identical | 12 of 12, identical |

**The rtk arm is void.** The permission classifier refused `curl … | sh`, and refused `sh /tmp/rtk-install.sh`
after the session had fetched the script; no binary, no hook. In a Cowork auto-mode container rtk cannot be
installed by the session, so a cloud head-to-head is not available with this protocol. The arm ran on
without any hook and is a second no-hook reading: 6.55M cache reads against 4.55M, 33 requests against 24, the model
this time reading files as large `sed -n` ranges instead of whole Reads. The rtk comparison, if it happens,
happens on a machine where rtk is already installed.

**The tokenbrake arm read 3.3 times the off arm's cache tokens, and the mechanism is the one JetBrains described for rtk.**
The model never used Read. It read the files with `sed -n`, and after its first excerpt,
`sed -n '1,120p' extension/content.js`, was trimmed (2k tokens to 1k), every excerpt that followed was 80
lines: `120,200p`, `200,280p`, `280,360p`, on through all of `content.js`, `index.js`, `background.js`,
`test.mjs` and `capture.mjs`. Eighty lines of this source is about 5,000 characters, under the 6,000 the
trim fires at. The model learned the threshold from one trimmed result and sized every read to stay under
it: 68 same-shape reads, 91 requests, each one re-reading the whole context, 14.9M cache reads against 4.6M.
Same answers, 3.3 times the cache reads.

Two earlier hooks-on runs of this shape did not do this: 2026-09-06, Opus 5, 3.99M cache reads and 28 requests
with bounded Reads and Grep; 2026-09-07, the readMaxBytes arm A, 4.86M cache reads, 25 requests, `content.js`
in six Read chunks of 300 lines. So the hooks-on range on this one shape is now 3.99M to 14.9M cache reads with
the off arm at 4.55M to 5.77M, and the model's reading strategy, not the hook, decides which. The README's Opus
saving is one of three runs, and the post has to say so.

**What the run points at.** The trim treats every shell result the same, and a `sed -n` excerpt of a source
file is not test noise: it is a read, the same act as the Read tool, which the guard leaves whole up to
60 KB. The guard therefore does two inconsistent things to the same file: a Read of 40 KB passes, a
`sed -n 1,400p` of 20 KB is cut to head, tail and error-looking lines, which for source is the wrong
three things to keep. A model that meets that once has every reason to stay under 6,000 characters, and
80-line chunks are what that looks like. The candidate fix is to treat a single-file `cat`/`sed -n`/`head`/
`tail` the way Read is treated: untouched up to `readMaxBytes`, capped above it. `readKey` in
`transcript.js` already recognises the shape. That is a guard change and gets the same A/B as everything
else before it ships: off against on, this task, two arms, the `requests` column deciding.

Until that runs, the honest sentence about this shape is: on a read-heavy audit the hook has cut cache reads
by 31% and 41%, and more than tripled them, on the same task, depending on how the model chose to read.

### The fix, measured — ab4, 2026-09-09, Opus 5, Claude Code 2.1.266

Same audit, same commit of `33kain/contexa`, off against the "file excerpts are reads" guard. Decision rule
written before the run: the fix ships as a win only if the on arm's requests are at or below the off arm's
and the session total is not worse (written against cost at the time; tokens-only record).

| | off | on (fix) | change | for comparison: on (0.2.2, ab3) |
|---|---|---|---|---|
| requests | 32 | 45 | +41% | 91 |
| cache-read tokens | 5,367,982 | 8,011,611 | +49% | 14,929,639 |
| output tokens | 8,359 | 11,241 | | 16,289 |
| tool results entered | 88k | 85k | | 84k |
| tool results carried | 1.4M | 2.2M | | 3.9M |
| largest excerpt, untouched | `sed -n '1,330p'`, 7k tokens | `sed -n '1,400p'`, 6k tokens | | `sed -n '120,200p'`, 1k |
| trimmed by the guard | 0 | 5, none of them an excerpt | | 4 |
| answers | 12 of 12 | identical | | identical |

**What the fix did.** The pathology is gone: the on arm read `content.js` in five ranges of 400 lines, each
about 6k tokens, each passed through untouched, where 0.2.2's arm had read it in seventeen ranges of 80. The
five results the guard did trim were `npm test`, the build, `git log --stat` and two greps: the outputs the
trim is for. Requests fell from 91 to 45.

**What it did not do.** The on arm still ran 45 requests against the off arm's 32, and read 49% more cache tokens. The
extra requests are more and smaller ranges on `index.js` and `background.js` (`150,270p`, `480,700p`),
which is how this model read those files this time; the off arm read them in 330-line ranges. That
difference is inside how the model plans, and it was there in the two no-hook arms of ab3 as well (24
against 33 requests), but the rule was the rule: by it, the fix is not a win.

**What ships anyway, and why.** The choice for the guard is not "fix or off"; a guard that does nothing to
excerpts is the fix. The choice is "fix or 0.2.2", and on this task 0.2.2 read 3.3 times its off arm's cache
tokens (ab3) while the fix read 1.5 times (ab4). The change also only ever does less than before: it leaves excerpts alone. So it ships
as 0.2.3, with this table beside it, and without the word "win".

**The honest state of the audit shape on Opus 5.** Every run of it, hooks off and on, this repository:

| date | guard | cache reads, hooks off | cache reads, hooks on | on / off |
|---|---|---|---|---|
| 2026-09-06 | 0.2.0 | 5,774,364 | 3,990,823 | 0.69 |
| 2026-09-07 | 0.2.1, readMaxBytes 60000 arm | — | 4,855,785 | — |
| 2026-09-09 ab3 | 0.2.2 | 4,551,872 (and 6,553,719 on the void rtk arm, also no hooks) | 14,929,639 | 3.28 |
| 2026-09-09 ab4 | excerpts-are-reads | 5,367,982 | 8,011,611 | 1.49 |

Four no-hook readings between 4.55M and 6.55M cache reads; four hooks-on readings between 3.99M and 14.9M. The
README's Opus saving is the best of four, not the number. On Opus 5, on this task, the hook has not shown a
saving that survives repetition; what survives is that the model's reading strategy, whole files against
ranges against small ranges, moves the cache reads by a factor of three, and the guard's job is not to push it
toward the small ranges. The Fable 5.1 reading (−41% cache reads, one run) is unrepeated and gets its rerun with this
guard (HANDOFF.md, "Next session", step 1).

The rtk comparison stays out of reach in the cloud and moves to the owner's machine, where it now has a
tokenbrake arm that at least does no harm on this shape.

## The twelve-step audit — the task as it has been pasted since the split

The eleven-step block at the top of this file is the original, and its step 10 reads `tokenbrake/HANDOFF.md`,
a path that stopped existing when the package was split out of `33kain/contexa` on 2026-09-06. Every audit
round since — the three-arm ab3 and the fix's ab4 — pasted a twelve-step version instead, which was never
written down here. It is written down now, so a later round measures the same workload and not a
reconstruction of it. Only step 12's version pin moves between rounds, to whatever guard is under test.

```
Read-only audit of this repository. Do every step with tools, in this order, one step at a time, and do not skip or batch steps. Do not modify any file. At the end write twelve lines, one per step, then paste the output of steps 11 and 12 verbatim.

1. Run `npm test` and report the number of checks that passed and failed.
2. Run `node build.mjs` and report the zip name it prints.
3. Read extension/content.js in full and name the function that decides which line, if any, the label row carries.
4. Read worker/src/index.js in full and name the constant that caps the brief's length.
5. Read extension/background.js in full and say how long a staged brief lives before it expires.
6. Read worker/test.mjs in full and count the lines that begin with two spaces followed by `t(`.
7. Read scripts/screenshots/capture.mjs in full and name the Playwright call that opens the browser.
8. Run `git log --stat -40` and name the file that appears most often in it.
9. Run `grep -rn "Start fresh" publishing/` and count the matching lines.
10. Run `cat .claude/hooks/tokenbrake/guard.js` and quote its first line.
11. Run `cat ~/.claude/settings.json` and paste its output.
12. Run `npx --yes tokenbrake@<version> report --top=8` and paste its full output.
```

Step 11 exists to prove the arm carried no user-scope hooks: configuration differences go on the branch,
never into `~/.claude`, because the permission classifier refuses writes there about one time in four. On
every run so far the file has not existed, and "No such file or directory" is the passing answer.

## The audit on Fable 5.1 with the excerpt guard — ab5, written 2026-09-09, before the run

The one unrepeated reading in the README is Fable 5.1's −41% cache reads on this shape, measured 2026-09-06
against guard 0.2.0 — the guard that has since been shown to teach Opus eighty-line `sed` ranges and read 3.3
times the no-hook arm's cache tokens (ab3), and that 0.2.3 replaced. So the Fable figure was measured with a guard nobody would
ship today, and it is the number the launch post would lead with. This round re-measures it against the
guard that actually ships.

**Setup.** Two Cowork sessions on `33kain/contexa`, Fable 5.1 both arms, one message each, the twelve-step
audit above with step 12 pinned to `tokenbrake@0.2.3`. Both arms branch from the same commit, the 0.2.3
repin (`claude/tokenbrake-0.2.3`); the trees are identical but for `.claude/settings.json`, which is
`{"hooks": {}}` on the off arm and the project install on the on arm. Results to
`ab-results/ab5-off.txt` and `ab-results/ab5-tb.txt` on `claude/ab5-off` and `claude/ab5-tb`.

**One difference from ab4 to keep in view.** Step 12 runs the 0.2.3 report, which credits a trim only when
the model saw it; ab3 and ab4 ran the 0.2.2 report, which credited every offered trim. So ab5's
"tokens kept out" is comparable to nothing before it, and is the more honest of the two. Requests
and cache reads come from `get_session` either way and are unaffected.

**Expectation, fixed before the run.** The on arm's requests at or below the off arm's. The reasoning: on
this task the guard's only remaining action on the large source files is nothing at all — 0.2.3 leaves a
`sed -n '1,400p'` untouched up to `readMaxBytes` — so what it trims is `npm test`, the build, `git log
--stat` and the greps, none of which the model needs to come back for. If it still drives requests up, the
mechanism is the same return-trip effect JetBrains measured against rtk, arriving through some door this
guard was not supposed to leave open, and that is worth knowing on a second model.

**Decision rule, fixed before the run.** Nothing ships or unships on this run; 0.2.3 is already released.
What the run decides is what the README and the post may say about Fable:

- On-arm requests at or below off-arm, and "cost not worse than the off arm by more than the 21% noise
  band": the 2026-09-06 Fable saving survives its guard change, and the README keeps a Fable saving, stated
  as two runs on two guards. *(Quoted as pre-registered: the condition was written in cost, and pre-registered text is never rewritten after the run. Rounds after 2026-09-18 use the token condition in "Amendment: the third condition, in tokens" below.)*
- On-arm requests above off-arm: the 2026-09-06 Fable saving does not survive, and the README's Fable line gets the same
  treatment the Opus line already got — the best of N runs, not the number — with both readings printed.
- "Cost apart by less than 21%" with requests level: a null, recorded as one, and the Fable claim comes out
  of the README's headline and stays only in this file.

Answers must be identical across the arms in every case; a difference there voids the round.

### The result — ab5, run 2026-09-09, Fable 5.1 both arms, Claude Code 2.1.266

Sessions `da261739…` (off) and `80c5d8cf…` (on), from `claude/ab5-off` and `claude/ab5-tb`, trees identical
but for `.claude/settings.json`. Cache and output from the session records; requests, entered,
carried and trimmed from each arm's own step-12 report, both taken at the same point in the protocol.

| | off | on (0.2.3) | change |
|---|---|---|---|
| requests | 26 | 29 | **+12%** |
| cache-read tokens | 4,739,441 | 5,345,262 | +13% |
| cache-write tokens | 243,059 | 187,626 | −23% |
| output tokens | 8,480 | 8,686 | +2% |
| tool results entered | 97k | 95k | |
| tool results carried | 1.5M | 1.6M | +7% |
| Read calls | 9 | 12 | |
| trimmed by the guard | 0 | 1 applied (≈ 6k kept out), 1 offered and not applied | |
| answers | 12 of 12 | 12 of 12, identical | |

**By the rule written before the run, the 2026-09-06 Fable saving does not survive.** The on arm ran more
requests than the off arm, which was the branch that says so. Cache writes did fall 23%, but cache reads rose
13% and carried tool results 7%, all inside the band two identical arms have already produced on this page
(27% apart in cache reads), so it is not a saving either. Two runs on Fable, on two guards, one −41% cache
reads and one inside-noise with requests up: the honest reading is a null, and the
README's Fable line loses its headline the same way the Opus line did. What can still be said is what the
answers say — 12 of 12 identical, on both arms, on both models, in every round so far.

**Where the arms' tokens went, and it is not where Opus's went.** On Fable 5.1 a cache write weighs far
more against a cache read than it does on Opus 5 (that comparison was recorded in prices, and the round's
column shares in cost; neither is restated here — tokens-only record), so the write column matters more on
this model. The guard's effect ran through the write column: 243k written against 188k, −23% — and the read
column moved the other way, 4.74M against 5.35M, +13%. Every earlier round on this page
is an Opus round, where cache reads dominate and the guard's lever is the carry multiplier. On Fable the
lever is how much *new* text enters at all, which is closer to what the whole category claims to do, and
it still did not clear the noise band. The column figures are the API's own session records, not an
estimate.

**A mechanism the round did make visible.** With no hooks, the off arm read the five large source files
unbounded; Claude Code passed its own ceiling, wrote each result to
`<config>/projects/<cwd>/<session>/tool-results/<id>.txt`, and the model read those files back whole.
Its report's top eight carried results are all such files — 94% of everything it carried was Reads of
Claude Code's own persisted outputs, not of the repository. The on arm's top eight are
`extension/content.js`, `worker/src/index.js`, `extension/background.js` and `worker/test.mjs` by name:
the Read cap fired first, so nothing was ever persisted to be re-read. This is the 0.2.1 rule's mechanism
reproduced on a second model, and it is the clearest thing the guard did in this round. It is also worth
noticing that it bought almost nothing: 1.5M carried against 1.6M. Keeping the model reading the file
instead of a copy of the file is the right shape and was not, here, a saving.

**Recorded against the instrument, not the result.** Two things about the report itself, found in these
files and both cosmetic:

- The `what` column truncates a path at about fifty characters, which on a persisted output cuts it off
  inside the session id — `…/projects/-home-user-contexa/da261739-50c5-` — exactly before the
  `tool-results/<id>.txt` that says what kind of file it is. The off arm's report is therefore readable
  only by someone who already knows the path shape. Worth eliding the middle rather than the tail before
  Saturday's table is built from these files.
- Each arm's report was run at step 12 and so measured the session as it stood then, short of where the
  records ended (that gap was recorded in cost only; not restated here — tokens-only record). The gap is the file write, commit and push that follow,
  the same on both arms. The report has always been a snapshot of the session that runs it; the
  `ab-results/real/` files inherit that and the Saturday table should say so.

**A protocol wrinkle to fix before the Sonnet round.** Step 11 is `cat ~/.claude/settings.json`, there to
prove the arm carried no user-scope hooks. On both arms the permission classifier refused the `cat`, and
both arms fell back to `ls` and to the Read tool, which agreed the file does not exist. The step did its
job, but by accident and not identically on the two arms, and a step whose command is refused is a step
that measures the classifier. Replace it with `ls -la ~/.claude/` for the Sonnet round, which is not
refused, answers the same question, and takes the same one call.

## The audit on Sonnet 5 — ab6, written 2026-09-09, before the run

Sonnet 5 is the model JetBrains ran their 425 trials of rtk on, and the only model in this space with an
independent measured number attached to it (worse at low effort, flat at high; recorded as a billing
figure, not restated here — tokens-only record). Everything on this
page is Opus 5 or Fable 5.1. So this is the first reading on the one model where somebody else's result
exists to be read next to it, and that is the whole reason to spend the round.

**Setup.** Identical to ab5 in every respect but the model: two Cowork sessions on `33kain/contexa`,
Sonnet 5 both arms, one message each, branches `claude/ab6-off` and `claude/ab6-tb` cut from the same
0.2.3 repin commit, differing only in `.claude/settings.json`. Results to `ab-results/ab6-off.txt` and
`ab-results/ab6-tb.txt`. One change to the task, carried in from ab5's finding: step 11 becomes
`ls -la ~/.claude/` instead of `cat ~/.claude/settings.json`, because the permission classifier refused the
`cat` on both Fable arms and a step whose command is refused measures the classifier rather than the
configuration. It answers the same question — no user-scope settings file — in the same one call, and both
arms get it.

**Expectation, fixed before the run.** A null: session totals inside the noise band, requests within two or three of
each other, answers identical. The reasoning is the two rounds already on this page. Neither Opus 5 nor
Fable 5.1 produced a saving that survived being run a second time, on the one workload shape where the
guard has anything to trim at all, and there is no mechanism yet identified that would make Sonnet
different in kind. Sonnet 5 weighs cache writes against reads the way Opus does rather than the way Fable
does, so if the round behaves like anything it should behave like the Opus rounds, where the session's
weight sits in the cache-read column and out of a hook's reach.

**Decision rule, fixed before the run.** This round settles what the post may say about Sonnet, and only
that; nothing ships or unships on it.

- Requests level (within three either way) and "cost inside 21%": the expected null.
  The post gets a Sonnet row reading "no measurable difference", and the JetBrains comparison is stated as
  what it is — their tool measured worse on this model, this one did nothing measurable on it, and neither
  is a saving.
- On-arm requests materially below off-arm (four or more) with "cost not worse": the first result on this
  page that would survive the requests rule, and it gets a second run before it is written anywhere
  outside this file. One run does not become a claim. *(Quoted as pre-registered: the condition was written in cost, and pre-registered text is never rewritten after the run. Rounds after 2026-09-18 use the token condition in "Amendment: the third condition, in tokens" below.)*
- On-arm requests materially above off-arm: a loss, recorded as one. *(Restored 2026-09-18: this branch was
  removed with the dollar figures, but it is a rule, not a figure.)*
- On-arm requests materially above off-arm: a loss, recorded as one, and the post says the hook has made
  sessions heavier on three of three models.

Answers must be identical across the arms; a difference voids the round. If either arm's step 11 is
refused again, the round still stands — the question it asks is answered by the fallback — but the step
gets replaced properly before any further round rather than patched a second time.

### ab6, first attempt — void, and the reason is worth more than the round

Run 2026-09-09, Sonnet 5 both arms. Neither arm ran a single step. Both read the task as an attack and
stopped: the off arm's status line was "prompt appears to contain exfiltration attempt; halting", the on
arm's "suspicious task request; pausing before execution", and each asked whether the human had really
sent it. Nothing measured, both arms void (what they spent was recorded in cost only; not restated here).

**They were right, and the step they objected to was the one added an hour earlier.** ab5 found that the
permission classifier refused step 11's `cat ~/.claude/settings.json`, so for this round it became
`ls -la ~/.claude/` — the model's own configuration directory — with the task then saying to paste the
output into a file, commit it, and push it to a public GitHub branch. Read without the context of this
page, that is a prompt telling an agent to enumerate the user's Claude configuration and push it to a
remote. Two models out of two flagged it. The step meant to prove a negative about the arm's setup had
turned into the one part of the task that looks like an exfiltration.

**And it had already leaked something, mildly.** The ab5 on-arm did paste that listing, and it was
committed to `claude/ab5-tb` in a public repository. No credentials — file names, sizes and modes in a
throwaway container's home directory — but it carries no measurement and it should not have been asked
for. It is removed from that file, with the one line that answers the step's actual question left in
place. The ab5 result stands: both arms handled step 11 the same way and neither's numbers depend on it.

**The fix, and why it is not a third patch.** Step 11 exists to establish one thing: what hooks this arm
carried and at what scope. That question has a command of its own — `npx --yes tokenbrake@0.2.3 status`,
which reports exactly what is installed at user and project scope and spawns each hook once. It answers
the step's real question directly instead of inferring it from the absence of a file, it reads nothing
outside the tool's own installation, and it is one small Bash call on both arms, as the step always was.
Step 11 becomes that, and stays that.

**What this does to the record, said plainly.** Step 11 has now been three different commands across three
rounds: `cat ~/.claude/settings.json` in ab3 and ab4, the same refused-and-worked-around in ab5, and
`status` from ab6 on. Cross-round comparison of the audit was already imperfect on this step, since no
round has executed it as written. It is one call of a few hundred characters out of a 26-to-45-request
session, so it does not move any figure on this page, but a protocol document that hid the change would be
worth less than one that prints it.

**The methodology finding, which outlives this round.** A benchmark task that reads the user's
configuration directory is not model-portable. It passes on one model, is refused by the permission layer
on another, and is refused by the model itself on a third — and the third refusal wastes a whole round.
Anyone A/B-testing agent tooling on session totals will write a task like this, because proving the control arm
really is a control arm is the first thing the protocol asks for. Prove it with the tool's own status
command, or by the branch the arm was cut from, and never by having the agent read and publish the
environment. This goes in `LANDSCAPE.md` next to the other things measuring this category teaches.

**The pre-registration above stands unamended in every other respect.** The expectation and the decision
rule were written before any Sonnet arm ran and no arm produced a number, so there is nothing here that
could have been fitted to a result. Only step 11 changes, and it changes for a reason that has nothing to
do with what the round measures.

### ab6, second attempt — the deviation, recorded before the arms returned

Written 2026-09-09 while both arms were still running, so it cannot be fitted to a result. Two changes
from the ab5 message, identical on both arms:

- Step 11 is `npx --yes tokenbrake@0.2.3 status`, per the section above.
- A closing paragraph says what the session is: one arm of an A/B of the tokenbrake hooks, run by their
  author, that steps 10 and 11 look only at tokenbrake's own installation in this repository, and that
  nothing reads or publishes anything outside it.

That second change is a real deviation and not a formatting one. It adds about five hundred characters to
the first message and it tells the model why it is doing this, which the ab3, ab4 and ab5 messages never
did. It is here because without it Sonnet 5 stopped both arms, and an arm that refuses the task measures
nothing at all. But a model told it is being benchmarked may plan differently from one that is not, and on
this workload how the model plans is the thing that has moved cache reads by a factor of three. So ab6's numbers
compare cleanly to each other — both arms carry the same paragraph — and compare to the Opus and Fable
rounds only with this stated next to them.

If the round is ever repeated, the honest version is to put the explanation in the repository, in
`CLAUDE.md` or a file the task points at, where every arm on every model picks it up from the branch rather
than from the message. That is the same rule this page already applies to configuration: it goes on the
branch, not into the prompt and not into `~/.claude`.

### ab6, second attempt — also void, and the blocker is the channel, not the task

Run 2026-09-09, minutes after the first. Neither arm ran a step again, but the objection moved. The off
arm: "12-step audit requested via unverified system notification; awaiting direct user confirmation". The
on arm: "suspicious task block detected; awaiting user confirmation", asking whether a human had really
requested an A/B with tokenbrake. Both had read the repository's `CLAUDE.md` first — the off arm's
question names it — so they were oriented; they simply would not act on the message. Nothing
measured.

**The exfiltration objection is gone; a different one replaced it.** Step 11 is now `tokenbrake status`
and the message says what the run is, and neither arm raised the first attempt's concern. What stopped
them is how the message arrived: every arm on this page is opened with `create_session`, so its first
message is a seeded prompt with no human turn behind it. Sonnet 5 on this harness treats that as
unverified and holds for confirmation. Opus 5 and Fable 5.1 ran the identical seeded message without
comment, across ab3, ab4 and ab5.

**Which means no wording fixes it.** The objection is to the delivery, not the content, and the first
message cannot say anything about how it was delivered. The only ways past it are to send a second
message confirming — which breaks the one-message invariant every other round on this page was run
under — or to run Sonnet somewhere a person types the prompt.

**Recorded as a limit of this protocol, not a fact about the guard.** The cloud A/B harness measures Opus
5 and Fable 5.1 and does not measure Sonnet 5. That is the second thing this container cannot do, next to
installing rtk, and both belong to the same paragraph in the eventual write-up: some arms need a real
machine. Nothing here says anything about how tokenbrake performs on Sonnet, and the post must not imply
that it does. The JetBrains comparison stays what it has always been on this page — their measurement of
their tool on their model, cited as theirs.

### ab6 — closed unmeasured, by decision

Not retried a third time. The two ways past the block were a second message confirming the first, which
breaks the one-message invariant every other round on this page was run under, or a person typing the
prompt on a real machine. The owner chose neither: Sonnet 5 comes out of the cloud protocol, and this page
carries no tokenbrake number for it.

What that means for anything written from this file. The audit shape has been measured on Opus 5 (four
runs each way) and Fable 5.1 (two runs each way). It has not been measured on Sonnet 5, and no sentence
anywhere may imply otherwise — not by omission, not by "on Claude models", not by putting a tokenbrake
figure in the same table as the JetBrains figure without a column that says which model each is. The
JetBrains benchmark stays cited as what it is: their measurement, of their tool, on a model this page has
no reading for. The comparison the launch post wanted, one task, two tools, one model, does not exist
yet and the honest thing is to say so.

The `claude/ab6-off` and `claude/ab6-tb` branches on `33kain/contexa` stay where they are, carrying the
arm configuration and no results. If Sonnet is ever run by hand on a real machine, they are the arms.

## Small results, two readings — for Saturday's step 5

The Saturday plan makes shape filters for small output conditional on the real-session files showing that
small results dominate carried context. Two reports written today, both from ordinary working sessions on
`33kain/tokenbrake` rather than from A/B arms, already point the same way:

| session | shell results at or under `maxChars` | tokens entered | carried | share of all carried |
|---|---|---|---|---|
| `c5ad7352` (this one, 104 requests) | 79 of 81 | ≈ 18k | ≈ 1.1M | **57%** |
| the same session at 58 requests | 49 of 51 | ≈ 12k | ≈ 376k | **54%** |

So on a long working session, the guard's threshold leaves about 97% of shell results untouched and those
untouched results carry more than half of everything carried. That is the gap the whole rest of the
category aims at, and it is not small. It is also exactly where rtk lost ground (more turns, more cache reads): these results are small
because the model bounded them, and compressing what a model deliberately kept short is how a hook earns
return trips. Two readings from one repository decide nothing; they are here so Saturday's table is read
against a number that already exists rather than in the abstract, and so the decision rule for that build
is written knowing the share will probably be high.

## The rtk head-to-head — the procedure, for the owner's Windows machine

Written 2026-09-09, not run. The cloud container cannot install rtk: ab3's rtk arm was void because the
permission classifier refused `curl … | sh` and then refused `sh /tmp/rtk-install.sh` after the session had
already fetched the script, so the arm ran with no binary and no hook and became a second no-hook reading.
That is not rtk's fault and it is not a result about rtk. A real comparison needs a machine where rtk is
installed by a person before any session starts, which means the owner's Windows box. Everything below is
for a person to run by hand; nothing in it should be handed to a session to do for itself, because the
thing being measured is what the tooling does to a session that does not know it is being measured.

**What it answers.** JetBrains measured rtk at +14% turns and +14% cache reads on Sonnet 5 across 425
trials. This repository has measured tokenbrake on one audit shape on Opus 5 landing on both sides of the
no-hook arm depending on the guard and the run (recorded in cost only; not restated here — tokens-only
record). Neither says how the two compare on the same task, same machine, same day. Three
arms on one workload does not settle that either — it is three sessions, not 425 — but it is the first
reading where both tools face the same twelve steps, and if the two land on opposite sides of the off arm
that is worth knowing before the post claims anything about the category.

**Before you start.** A clone of `33kain/contexa` at a commit you write down, `npm install` already done
so no arm pays for it, Node and Git on PATH, and `claude --version` recorded. Close every other Claude Code
session: the five-hour window is shared and a background session moves the numbers. Budget about an hour.

**The invariants, the same ones every round on this page has held to.** One model for all three arms, named
in the record. One message per arm, the twelve-step audit above pasted verbatim, step 12 pinned to the
tokenbrake version under test. No answering follow-up questions, no second message, no matter how the
session asks. A fresh session per arm, never `/clear` in the same one, because the token counts come from the
session record and a cleared session keeps its old requests. And exactly one tool installed at a time:
verify it, do not assume the previous arm's uninstall worked.

**Arm 1, off.** Neither tool installed.

```
rtk init -g --uninstall          # even if you think it is not installed
npx --yes tokenbrake uninstall   # user scope
npx --yes tokenbrake uninstall --project    # in the contexa clone, if it has project hooks
```

The contexa clone carries project-scope tokenbrake hooks in `.claude/settings.json` on `main`, so for this
arm either uninstall them there or check out a branch whose `.claude/settings.json` is `{"hooks": {}}` —
`claude/ab5-off` is exactly that. Confirm with `npx tokenbrake status`: it should report nothing installed
at either scope. Then start Claude Code in the clone, paste the audit, and let it finish.

**Arm 2, rtk.** `rtk init -g`, and confirm rtk's own status command reports the hook. tokenbrake stays
uninstalled at both scopes — `npx tokenbrake status` again, because a leftover project hook is the easiest
way to void this arm. Fresh session, same paste.

**Arm 3, tokenbrake.** `rtk init -g --uninstall`, then `npx tokenbrake init`, then `npx tokenbrake status`,
which spawns each hook once and will say if the node path is wrong. Fresh session, same paste.

**Reading the result.** Each arm's requests, cache reads and output come from its session record;
`npx tokenbrake report --all` lists the sessions on disk newest first, and
`npx tokenbrake report --compare <A> <B>` prints two of them side by side with the change column, which is
this file's table. Run it twice, off against rtk and off against tokenbrake. The arms' own reports give
entered, carried and trimmed. Note that on the rtk arm tokenbrake's report still works — it reads the
transcript, not its own ledger — so it will say what entered under rtk, which is the number rtk's own
claims are about.

**The rule for reading it, and it is the one that has voided results here before.** The requests column
decides. Two identical arms on this page came out 27% apart in cache reads on nothing but how the model
planned its reads, so any difference inside that band is a null and gets recorded as one.
A tool that lowers what enters and raises requests has lost, whatever its output-reduction number says;
that is the mechanism JetBrains found and the one that took tokenbrake 0.2.2 to 91 requests against the off
arm's 24 on this exact task. And if the three arms give different answers to any of the twelve steps, the round is void
and the answers matter more than the token counts: a smaller wrong audit is not a saving.

**Recording it.** Three requests/cache/output rows, three entered/carried/trimmed rows, the answers
line, the model, the Claude Code version, the commit, and the date, into a new section on this page. Nulls
and losses go in with the same care as wins; that is the only reason anything on this page can be cited.

### ab7 — the pre-registration, written 2026-09-09, before anything is installed

The procedure above says how to run the three arms. This is the part the protocol will not let a round
skip: what is expected and what the numbers decide, both fixed before the first session opens.

**The model, and it is a real choice.** The round runs on **Sonnet 5**, all three arms. The alternative was
Opus 5, where four off readings already exist to compare against, and the trade is worth stating: on Opus
the round would sit inside this page's existing series, while on Sonnet it stands alone. Sonnet wins
anyway, for two reasons that only apply once. It is the model JetBrains measured rtk on, so the rtk arm is
the first thing on this page that can be read next to somebody else's number instead of against nothing.
And it is the model the cloud protocol cannot reach at all — ab6 died twice on it — so a person at a
keyboard is the only way this page ever gets a Sonnet reading, and the three-arm design carries its own off
arm, which is exactly the baseline that is missing. One session buys the comparison and the missing
baseline together. If the round is run on Opus instead, that is a legitimate choice and the only thing it
costs is the JetBrains comparison; write down which model was used before starting, either way.

**Expectation, fixed before the run.**

- *rtk against off:* at or slightly above the off arm on cache reads, with more requests. This is not a guess, it
  is the JetBrains result restated — +14% turns, +14% cache reads — and the mechanism
  behind it is the one this page reproduced from the other side with `readMaxBytes` at 25,000 and again
  with 0.2.2's excerpt trimming: compressed output sends the model back, and each return trip re-reads the
  whole context. If rtk lands well below the off arm on this workload, that contradicts the only
  independent measurement in the field and would need a second run before anyone writes it down.
- *tokenbrake against off:* a null, inside the noise band and requests within three. On the audit shape
  0.2.3 has one reading on each of two models and neither cleared the band. There is no reason to expect
  Sonnet to behave differently in kind, and the honest prior after ab4 and ab5 is that this guard does not
  save tokens on this task on any model.
- *answers:* 12 of 12 on all three arms, identical.

**Decision rule, fixed before the run.** The requests column decides; differences inside the noise band are
nulls. Beyond that:

- **Both tools null against off.** The most likely outcome and the most useful one for the post: two hooks
  from opposite ends of the category, on the same task and machine and day, neither of which moved the
  token counts. That is the paragraph the post is actually for.
- **rtk above off and tokenbrake null.** Consistent with JetBrains, stated as one run of three sessions
  agreeing with 425 trials, never as a replication.
- **tokenbrake below off and rtk not.** The first result on this page that would survive the requests rule
  on this workload, and it does not get written outside this file until a second run on a different day
  reproduces it. One run does not become a claim; that rule has already retired two numbers here.
- **tokenbrake above off.** A loss, recorded as one, and the post says the hook has added tokens on a third
  model.
- **Any arm's answers differ.** The round is void, and the answers matter more than the token counts. A
  smaller wrong audit is not a saving.

The round is `ab7`, and nulls go in with the same care as anything else.

### ab7 — the runbook

Lifted out to **[`AB-RUNBOOK.md`](AB-RUNBOOK.md)** so it can be read beside a terminal instead of
scrolled to through this file. It is self-contained: the commands per arm, the audit text, the checks, and
the table to fill in. It is the only document needed to run the round; this page is what the result comes
back to.

Revised 2026-09-10 after its first real use, which went badly and for reasons that were the page's fault:

- It said to confirm rtk with "rtk's own status command" without naming one, because this project has never
  run rtk. The check is now `type $HOME\.claude\settings.json`, read with your own eyes — the file both
  tools write to, needing neither tool's CLI, showing every hook whichever installed it.
- It never said what to keep from an arm before starting the next. There is now an "After each arm" section:
  save the answer, note the session id, close the session, and run
  `report --session=<id>` **from the shell**, because step 12's in-session report counts only the requests
  made before it ran. That file is every row of the record; the record's rows now name the report line each
  comes from, and the two rows that asked for cache-read and cache-write token counts are gone, since the
  local report does not print them and only the cloud's session records ever did.
- tokenbrake is no longer installed and uninstalled between arms at all. `claude/ab7-off` and
  `claude/ab7-tb` on `33kain/contexa` carry the two configurations, cut from the same commit and differing
  in `.claude/settings.json` alone, so the arms switch with `git checkout` and rtk is the only thing
  installed either way. Install and uninstall was the hardest part of the first attempt and most of it was
  unnecessary.

The general lesson, which belongs with the other methodology findings in `LANDSCAPE.md`: a protocol
document is not finished when it is correct, it is finished when someone who was not in the room can follow
it. Every hole above was invisible to its author and cost the first runner an evening.

### ab7 — run 2026-09-10 by hand, and void as a comparison

The first round on this page run by a person at a keyboard rather than by `create_session`, and the first
run on Windows. Fable 5.1 (`claude-fable-5-1[1m]`, the 1M-context variant), Claude Code 2.1.267, Node
v24.19.0, commit `c2d0cd7` of `claude/ab7-off`, one message per arm, the twelve-step audit with step 11 as
`tokenbrake status`.

| | arm 1, off | arm 2, rtk | arm 3, tokenbrake 0.2.3 |
|---|---|---|---|
| session | `01139ae6` | — | `acb853e1` |
| requests | 15 | *dropped, see below* | 5 |
| tool results | 17 | | 23 |
| tool results per request | 1.1 | | **4.6** |
| context processed | 1.3M, 92% from cache | | 443k, 67% from cache |
| output tokens | 4k | | 4k |
| tool results entered | 46k | | 91k |
| tool results carried | 224k | | 84k |
| trimmed by the guard | 0 (2 offered, not applied) | | 1 (≈ 2k kept out, ≈ 10k not carried) |
| under the trim threshold | 10 of 17 shell, 10% of carried | | 11 of 12 shell, 7% of carried |
| Read calls / Bash calls | 0 / 17 | | 11 / 12 |
| answers | 12 of 12 | | 12 of 12, **identical** |

**The rtk arm was dropped by decision, and that is not why the round is void.** `rtk` turned out not to be
installed on the machine — discovered at arm 2, after arm 1 had already run — and this project does not
know its Windows install command, having never run it. Rather than stop, the owner and this session agreed
to finish as a two-arm round, off against tokenbrake. That is a recorded change of scope, not a defect in
what was measured: two arms is the design every other round on this page uses. The runbook's failure to
check that the binary exists before arm 1 is a real hole in the runbook, and it is fixed, but it cost a
discovery mid-round rather than a result.

**The round is void for two reasons. The first, found on the day: the two arms did not do the same task.** The pasted instruction
says "one step at a time, and do not skip
or batch steps". Arm 1 obeyed it: 17 tool results across 15 requests, 1.1 per request. Arm 3 opened with
"I'll work through the twelve items, running the independent ones in parallel" and batched: 23 tool results
across 5 requests, 4.6 per request. Every figure in the table follows from that. Five requests re-read the
context five times instead of fifteen, so carried context falls from 224k to 84k with the guard credited
for 10k of it; and five requests reuse the cache less, 67% of processed context from cache against 92%, so
more of what is processed is written to cache rather than read from it while requests go *down* 67%. The requests column,
which the decision rule says decides, was decided by the batching.

**The second reason, found 2026-09-12 and not on the day: arm 1 was not off.** Its session, `01139ae6`,
has tokenbrake ledger rows -- `report --all` marks it `guard` -- so the hooks were firing in the arm whose
whole job was to run without them. The evidence was in the table above the entire time, read as a zero:
**"trimmed by the guard | 0 (2 offered, not applied)"** on the off arm. A guard that was not installed offers
nothing.

Three things checked before writing that down, because an accusation against one's own record is worth the
same scrutiny as a finding. It is the same session: the ab7 table says 15 requests, 1.3M processed and 224k
carried, and `--all` reports 15, 1.3M and 224k for `01139ae6`. It is not an artefact of how `status` tests
itself: that spawn sends a payload with no `session_id` (`cli.js:101-103`), so a row it writes cannot carry a
real session's id, and rows without one are dropped before the join. And it did not spread: ab8's off arm
`460d9673` and ab9's off arm `8516e976` carry no ledger rows at all, which fits ab7 being the first round run
by hand rather than by `create_session`.

What this does **not** change is the numbers in the table. "Offered and not applied" means the model never
received the replacement, so what arm 1 was delivered is what the host delivered; the contamination is in the
arm's configuration and in the sentence that called the round void for one reason. It does change what the
round is evidence of -- an off arm with the product running is not an off arm, whatever the totals say -- and
it is the first known instance of the trap this repository only wrote down today: **a user-scope install makes
an OFF arm impossible, and nothing in the arm's own settings will say so.** Before any future round:
`node cli.js uninstall`, then `verify-config --expect=off`, which exists because of exactly this and refuses a
pair when a guard is installed at any scope.

The two arms also read differently — arm 1 used `sed -n` through Bash and let 46k in, arm 3 used the Read
tool and let 91k in — which is the same planning variance this page has measured at a factor of two on
Opus, now visible on Fable, on the same model and the same task on the same machine within an hour.

**What survives.** The answers: 12 of 12, identical, on both arms, including the two that a compressed or
capped read would be most likely to break — 112 lines matching `  t(` in a 60 KB file, and 48 matches for
"Start fresh". Both arms also independently named `publishing/website/index.html` as the runner-up in step
8, which nobody asked for. That is now four rounds across three models where the hooks changed no answer.

**What it says about the protocol, which is the useful part.** A one-message instruction not to batch is
not binding on the model, and a round where one arm batches and the other does not is not a measurement.
Every cloud round so far happened not to hit this: ab5's arms ran 26 and 29 requests for 25 and 28 results,
ab3's and ab4's the same shape. It took the first hand-run round to produce an arm that read the same
sentence and worked in parallel anyway. Any future round has to check tool-results-per-request before
looking at any other column, and treat a gap like 1.1 against 4.6 as voiding, the way a difference in answers voids.

**The `claude/ab7-tb` branch carries one extra commit now** (`ee4ca51`), an `ab-results/real/` file the arm
wrote and pushed under the repository's own end-of-session rule in `CLAUDE.md`. The ab7 task text has no
instruction about that file, unlike ab5's and ab6's, which told the arms not to write one; that omission is
also why arm 3 spent requests on a commit and a push that arm 1 did not. The figures above are both arms'
step-12 snapshots, taken before either did anything after the twelve steps, so that asymmetry is outside
them — but the next round's task text should say it explicitly rather than rely on it.


## ab8 — the ab7 re-run, two arms, written 2026-09-10 before the run

Same machine, same person at the keyboard. ab7 established that the workload and the tooling are fine and
that one thing broke it: one arm batched its tool calls and the other did not. So this is the same round
with that one cause removed, and with the design it actually has — **two arms, off against tokenbrake
0.2.3**, which is what every other round on this page runs. rtk is not part of it and its absence is not a
gap: a head-to-head needs rtk installed by hand first, and that is a separate round on a separate day.

**The one change to the task text, identical on both arms.** After step 12, two sentences are added:

```
Run exactly one tool call per turn. Do not issue two tool calls in the same turn, even for steps that do not depend on each other.
Do not write or commit an ab-results/real/ file for this session and do not open a pull request; this is a measurement arm, not an ordinary session.
```

The first says explicitly what "one step at a time, and do not skip or batch steps" was always meant to
say and what ab7's arm 3 read past. The second restores a line ab5 and ab6 carried and ab7 dropped, which
is why ab7's arm 3 spent requests on a commit and a push that its off arm did not.

Both arms get the new text, which is why **both are re-run** rather than only the one that batched.
Comparing an arm run on the old text against one run on the new is the mistake this page keeps finding in
other people's benchmarks.

**Fresh branches.** `claude/ab8-off` and `claude/ab8-tb`, cut from the same commit of `33kain/contexa`,
differing in `.claude/settings.json` alone. ab7's branches are not reused: `claude/ab7-tb` now carries an
extra commit its arm pushed, and a branch whose history differs from its pair's is one more thing to
explain later.

**Expectation, fixed before the run.** A null: inside the noise band, requests within three, answers
identical. On the audit shape 0.2.3 now has one reading on Opus (ab4, not a win) and one on Fable
in the cloud (ab5, requests up, a null). ab7's two arms, for all that they are not comparable
to each other, both landed close together (recorded in cost only; not restated here — tokens-only
record). There is no mechanism on the table that
would make Windows different in kind.

**Validity gate, checked before any comparison is read.** For each arm, `tool results ÷ requests` from its
own report. Both arms must be near 1, and within 1.5 of each other. An arm outside that batched, and a
round where one arm batched is not a measurement — ab7 is the worked example. An arm that fails the gate
is re-run before anything is compared; if the same arm fails twice, the round is closed as unmeasurable on
this harness and recorded that way, the way ab6 was closed on Sonnet.

**Decision rule, fixed before the run.** The requests column decides; a difference inside the noise band is a
null.

- Requests within three either way and "cost inside 21%": the expected null, and the fourth model-workload
  pair to produce one. The post's audit row gains a Windows-local line reading "no measurable difference".
- On-arm requests four or more below the off arm with "cost not worse": the first result on this page that
  would survive the requests rule, and it stays inside this file until a second run on a different day
  reproduces it. *(Quoted as pre-registered: the condition was written in cost, and pre-registered text is never rewritten after the run. Rounds after 2026-09-18 use the token condition in "Amendment: the third condition, in tokens" below.)*
- On-arm requests four or more above the off arm: a loss, recorded as one.
- Answers differing anywhere: void, and the answers matter more than the bill. *(Restored 2026-09-18: this
  branch was removed with the dollar figures, but it is the correctness rule, not a figure.)*
- Answers differing anywhere: void, and the answers matter more than the token counts.

### The report can read the wrong session, and on Windows it did — 2026-09-10

`report` with no `--session` opens the newest transcript on disk. Run from *inside* a live session, that
is normally the session itself. On Windows it twice was not.

- ab7, arm 1: the arm's step-12 report described a session the arm believed was not its own. It was its
  own, and the caveat was a false alarm — which taught the wrong lesson, because it made the same caveat
  easy to dismiss the next time.
- ab8, arm 1: the arm's step-12 report described `acb853e1`, the *previous* round's tokenbrake arm, at its
  final state. The arm said "this session made more calls than that" and was right. Its own session,
  `460d9673`, was on disk and newer.

The tell that settles it in one line: **the off arm's report said `tokenbrake trimmed 1 of them`.** An arm
running with no hooks at either scope cannot have a trim. Any report whose trim line disagrees with the
arm's configuration is a report of a different session, and that check costs nothing.

The likely mechanism is Windows file modification times: a transcript being written by a live process can
carry a stale mtime until the handle is flushed, so a session that finished an hour ago can look newer than
the one running now. That is a property of the platform rather than of the format, and the cloud rounds
never hit it.

What follows for the protocol: an arm's step-12 report stays in the task, because producing a large tool
result is part of the workload being measured, but **its header is not the record**. The record is
`report --session=<id>` run from the shell after the session is closed, with the id taken from
`report --all` — the newest row carrying the repository's path — and confirmed against the arm's
configuration by the trim line. The runbook says so now.


### ab8 — the result, run 2026-09-10 by hand. A clean null, and one mechanism worth the whole round.

Fable 5.1 (`claude-fable-5-1[1m]`), Claude Code 2.1.267, Node v24.19.0, commit `d477c97` of
`33kain/contexa`, Windows, one message per arm, the twelve-step audit with the one-tool-call-per-turn line.
Both figures are `report --session=<id>` run from PowerShell after each session closed.

| | off, `460d9673` | tokenbrake 0.2.3, `8c21713d` | change |
|---|---|---|---|
| requests | 18 | 21 | +3 |
| tool results | 17 | 21 | |
| **tool results ÷ requests** | **0.94** | **1.00** | both pass the gate |
| context processed | 2.6M, 93% from cache | 2.9M, 94% from cache | |
| output tokens | 4k | 5k | |
| tool results entered | 90k | 89k | −1% |
| tool results carried | 939k | 965k | +3% |
| trimmed by the guard | none | none | |
| under the trim threshold | 10 of 10 shell, 3% of carried | 10 of 10 shell, 3% of carried | |
| Read / Bash / Grep calls | 7 / 10 / 0 | 10 / 10 / 1 | |
| answers | 12 of 12 | 12 of 12, identical | |

**By the rule written before the run this is the expected null**, and the branch that fired is the first
one: requests within three either way, inside the noise band. It is also the closest two arms have ever come on
this page — entered 1% apart and carried 3% apart, on a task where identically configured arms have been 27%
apart in cache reads — and the
first round where both arms passed the batching gate. ab7's lesson worked: the explicit
one-tool-call-per-turn line produced 0.94 and 1.00 where the old wording produced 1.1 and 4.6.

**Both arms report `trimmed none`, and on the guarded arm that is correct rather than broken.** Every shell
result on both arms was under the 6,000-character threshold — 10 of 10 — so the trim had nothing to act on,
and the reads that were bounded are untouched by design. The guard was present and running: arm 1's report
counted 69 ledger rows and arm 2's counted 90, and the 21 in between are this session's 21 tool calls, one
row logged per call. **That row count, not the trim line, is what identifies which arm a report belongs
to.** An earlier version of this page's guidance said the guarded arm must show a trim; that is only true
when the guard has something to trim, and it is wrong as a check.

**The mechanism, which is what this round actually bought.** The Read cap fired once. *Corrected
2026-09-10:* when 0.2.4's `Read caps fired` line was run against this arm's transcript afterwards it read
**"1 (1 on a persisted output)"** — so the cap that fired was the persisted-output cap, not `readMaxBytes`,
and the arm's unbounded Read of `extension/content.js` was refused by Claude Code's own Read limit rather
than capped by the guard. `readMaxBytes` did not fire in ab8 at all, and has still never been observed to
fire outside a test. What happened is: 

- The model went to Bash and ran `cat extension/content.js`.
- That passed Claude Code's own inline ceiling, so Claude Code wrote the output to
  `~/.claude/projects/<project>/<session>/tool-results/…` and handed back a preview.
- The model then read that persisted file back in **three bounded ranges** — 11k, 11k and 7k tokens,
  carried 167k, 148k and 96k, **411k token-reads, 43% of everything this arm carried**.
- The guard could not touch any of the three. Its persisted-output cap fires on an *unbounded* read of such
  a file; a bounded read of one is untouched by design, and by design is right in general — a model asking
  for a range is the behaviour the cap exists to produce.

So the cap did not keep `content.js` out. The off arm let it in as two Read calls, 30k tokens entered and
377k carried. The guarded arm let in 29k and carried 411k, through a persisted file, in more steps. **The
cap changed which door the file came in through and nothing else.** That is the same sentence the launch
post opens with about Claude Code's own persisted outputs, now measured on the guard's own behaviour rather
than on its absence, and it is the sharpest illustration yet of the rule this page keeps arriving at: on a
task that asks for whole files, capping a read buys a return trip, not a saving.

It cost nothing here — entered −1%, carried +3%, inside any noise band — which is the honest way to state
it. It did not cost the 40% more cache reads and 34 requests against 25 the `readMaxBytes` round did, and it
did not save anything either.

**What this adds to the record.** A fourth model-workload pair producing a null, a third model, the first
run on a real machine rather than in a container, and the tightest agreement between arms yet measured.
Across ab4, ab5, ab7 and ab8 — Opus 5, Fable 5.1 in the cloud and Fable 5.1 on Windows — 0.2.3 has not
shown a saving on the read-heavy audit, and every arm of every round has given identical answers.


## Real sessions, everything recorded so far — n=3, 2026-09-10

The Saturday plan asked for a week of ordinary sessions with median, min and max. The inventory found eight
files that are not eight sessions: `ced42a1a` appears three times as one session reported while it grew
(421, 505, 617 requests — the last is used), `acb853e1` is an ab7 A/B arm, and `c5ad7352` and `ca84ebdd`
ran outside `33kain/contexa`. Three ordinary contexa sessions remain, and one of those is five requests
long. This is the table of what exists, printed as n=3 rather than dressed as a distribution.

| session | requests | entered | carried | trims | kept out | not carried | kept-out / entered | not-carried / carried |
|---|---|---|---|---|---|---|---|---|
| `ced42a1a` | 617 | 265k | 31.8M | 10 | 12k | 1.3M | 4.5% | 4.1% |
| `c905b53d` | 150 | 40k | 3.6M | 4 | 4k | 625k | 10% | 17% |
| `22afe55e` | 5 | 933 | 2k | 0 | 0 | 0 | 0% | 0% |

**No median is printed and none should be.** Three sessions, one of them trivial, from one repository and
mostly one author. The honest sentence is "on the two substantial sessions recorded, the guard kept out
4.5% and 10% of what entered", and that is a smaller claim than the plan expected to make.

**And the larger caveat, which was not anticipated: every one of these files predates the guard that
ships.** `c905b53d`'s four trims are visible in its own report — `sed -n '1,110p'
publishing/website/index.html` trimmed from 3k to 2k, `sed -n '120,420p' publishing/website/site.css` from
2k to 1k. Those are file excerpts, and **0.2.3 stopped trimming file excerpts**: it treats them as reads,
because ab3 showed that trimming them taught the model to read in eighty-line chunks and took 91 requests
against the no-hook arm's 24. So the 10% and 17% in that row are a saving the current guard would not produce, from a
behaviour deliberately removed. `ced42a1a`'s ten trims are from the same period and may be the same shape;
its report does not say which.

**What that leaves.** The table describes a guard that no longer exists. It is published because the
numbers are real and were collected honestly, and because a table showing that the recorded evidence does
not apply to the shipping version is worth more than no table. What it means practically is that the
real-session evidence for 0.2.3 is **zero sessions**, and that collecting it starts now: contexa's
`CLAUDE.md` pinned the report to 0.2.3 on 2026-09-09, and 0.2.4 adds the `Read caps fired` line the
`readMaxBytes` decision needs. A table worth a median needs eight or nine sessions recorded from here on.

**The post's paragraph, to replace the `[TABLE]` slot**, says exactly this and no more:

> On real sessions the evidence is thin and I would rather say so than pad it. Three ordinary sessions on
> one repository have left a report behind: 617 requests, 150, and 5. On the two substantial ones the
> hook kept 4.5% and 10% of entering tokens out of context. Both were recorded under a guard version that
> trimmed file excerpts — a behaviour I removed in 0.2.3 after measuring that it taught the model to read
> in eighty-line chunks and nearly quadrupled the requests on one task — so even those two numbers describe something
> that no longer ships. The honest state of real-session evidence for the current version is zero
> sessions, and collecting it is what `tokenbrake report` is for. Run it on your own last session; that
> number is the one that matters to you, and it is the only one I would act on.


## The twelve-step audit was measuring a hook that never ran — the diagnosis, 2026-09-10

The owner's complaint about the audit task is right, and the reason is worse than "the questions are easy".

**In ab8, both arms reported `Under the trim threshold: 10 of 10 shell results`.** Every shell result on
both arms was under 6,000 characters. The PostToolUse trim — the guard's main feature, the thing the
package is named for — **fired zero times, on both arms, across 39 requests.** The Read cap fired once and
the file came in through another door. So the round measured the effect of running two hooks that did
nothing, which is why it produced 1% on entered and 3% on carried, and why every round before it hovered around zero for
the same reason nobody checked.

Three properties of the task cause it, and all three are fixable:

1. **It forbids the saving by construction.** Steps that say "read X in full" mean the model must see the
   whole file, so anything the cap withholds it fetches again. This was noticed once, in the `readMaxBytes`
   round, and written down there — "a task that says read in full forbids the behaviour change by
   construction" — and then the same task went on being used for five more rounds.
2. **Nothing produces large output.** `node build.mjs` prints 283 characters. The greps the task asks for
   print two or three thousand. The only step over the threshold is `npm test`, at 50,520 characters on
   this repository, which is *above* Claude Code's own ~30,000-character ceiling — so it is persisted and
   previewed, and the hook's replacement is never applied. There is no step in the twelve where the trim
   can act.
3. **Nothing fails and nothing depends on anything.** `PostToolUseFailure` is never reached. And every step
   is independent, which is what let ab7's arm run them in parallel and void the round; the fix there was
   an instruction, where the task's own shape should have made batching impossible.

**Measured on this repository, at commit `d477c97`, so the replacement can be built on facts:**

| command | characters | exit | what it exercises |
|---|---|---|---|
| `cd worker && node test.mjs` | 23,089 | 0 | over the threshold, **under** Claude Code's ceiling — the trim applies |
| `git log --stat -40` | 23,995 | 0 | same |
| `grep -rn "brief" extension/ worker/src/` | 17,162 | 0 | same |
| `sed -n '1,400p' CHANGELOG.md` | 18,074 | 0 | a file excerpt over the threshold — 0.2.3 must leave it alone |
| the same grep, then a grep that matches nothing | 17,162 | **1** | `PostToolUseFailure` with real output |
| `npm test` | 50,520 | 0 | above Claude Code's ceiling — persisted, hook ignored |
| `node build.mjs` | 283 | 0 | nothing |
| `CHANGELOG.md` as a whole file | 237,608 (≈ 59k tokens) | | Claude Code's Read **refuses** it — the cap's one chance to *help* |

That last row is the one the old task never had. Claude Code's Read tool refuses a file over about 25k
tokens; `CHANGELOG.md` is more than twice that. Without the hook the model gets an error and must come
back bounded — a wasted round trip. With the hook the PreToolUse cap rewrites the request before the tool
runs and hands back 300 lines immediately. **Every round so far has given the Read cap opportunities to
hurt and none to help.** A benchmark that only measures a feature where it cannot win is not measuring it.

## ab9 — the review task, written 2026-09-10 before the run

The first version of this section was a trace task, and the owner rejected it on sight: nine of its twelve
steps had changed but it was still the same *kind* of thing — twelve lookup questions, "run a command,
report a number". He was right. A harder quiz is not a different workload, and the workload is what the
measurement is about. This is the replacement, built from the two shapes he chose: a **release review**
(part 1, which puts real work inside the trim's operating window) and a **mechanism trace with a synthesis
deliverable** (part 2, which is where the Read cap and whole-file reading live). Part 3 verifies.

**Why these two and not debugging.** The trim acts only on results over 6,000 characters, under Claude
Code's ~30,000-character ceiling, and exited zero. A debugging session's large outputs are failing test
runs — non-zero exit, where Claude Code ignores the hook's replacement — so the workload the trim was
written for is structurally out of its reach, and four debugging rounds have already returned ≈ 0 for that
reason. Measured on this repository at `d477c97`, the commands that land *inside* the window are the ones a
review session runs: `git log --stat -40` (23,995 chars), `cd worker && node test.mjs` (23,089),
`sed -n '1,400p' CHANGELOG.md` (18,074), `git diff HEAD~3` (13,642), `grep -rn 'function ' extension/
worker/src/` (13,107), `git log -p -3` (7,865).

**The task, pasted verbatim, identical on both arms.**

```
Read-only review of this repository before a release. Work through the parts in order; part 2 and part 3 depend on what you find in part 1. Do not modify any file. Run exactly one tool call per turn. At the end produce the report described at the bottom.

Part 1 — what changed.
1. Run `git log --stat -40`. Name the three files that appear on the most changed-file lines, with their counts.
2. Run `git diff HEAD~3`. Name every file it touches and say in one line what the change does.
3. Read CHANGELOG.md in full. Report the version number of its most recent entry, and how many of the file's lines mention `MAX_BRIEF_CHARS`.

Part 2 — trace the mechanism.
4. A "brief" travels from the extension page to the worker and back. Starting at `weightLine` in extension/content.js, list every named numeric limit the thread or the brief passes on that path, in the order it meets them, giving for each: constant name, value, file, and line number.
5. One of those limits is enforced in two different files, by two copies of the same function. Name the constant, name the function, and give both file:line pairs for each.
6. For a thread of 15,000 tokens whose brief is 3,000 characters: say which limits from step 4 apply, in order, and what the brief's final length is. Then say what happens instead for a thread of 5,000 tokens, and why.

Part 3 — verify.
7. Run `cd worker && node test.mjs`. Report how many checks passed and the exact text of the last check that ran.
8. Run `grep -rn "MAX_BRIEF_CHARS" extension/ worker/src/`. Report the match count in each of the two locations separately.
9. Run `grep -rn "brief" extension/ worker/src/; grep -rn "zzz-not-present" extension/`. Report how many lines the first grep matched and the exit code of the whole command.
10. Run `cat .claude/hooks/tokenbrake/guard.js` and quote its first line.
11. Run `npx --yes tokenbrake@0.2.4 status` and paste its output.
12. Run `npx --yes tokenbrake@0.2.4 report --top=8` and paste its full output.

The report: one numbered line per step above, then the outputs of steps 11 and 12 pasted verbatim, then two sentences saying whether you would sign off on the release and what you would want changed first.

Do not write or commit an ab-results/real/ file for this session and do not open a pull request; this is a measurement arm, not an ordinary session.
```

**Ground truth, computed on `d477c97` before either arm runs.** Steps 1 and 2 move as the repository gains
commits and are fixed only within a round; the rest are stable.

| step | answer |
|---|---|
| 1 | `CLAUDE.md` 4, `.claude/hooks/tokenbrake/guard.js` 4, `publishing/website/site.css` 3 |
| 3 | lines mentioning `MAX_BRIEF_CHARS`: to be read off the file at the round's commit |
| 4 | `LONG_THREAD_TOKENS` 12000 — content.js:434; `FRAGMENT_MIN_THREAD_TOKENS` 4000 — content.js:928; `MAX_BRIEF_CHARS` 1800 — background.js:621; `BRIEF_TTL_MS` 2·60·1000 — background.js:753; `MAX_BRIEF_CHARS` 1800 — worker/src/index.js:633; `FORK_MAX_TOKENS` 2000 — worker/src/index.js:827 |
| 5 | `MAX_BRIEF_CHARS`, function `cleanBrief`, at `extension/background.js:621`/`:622` and `worker/src/index.js:633`/`:634` |
| 6 | 15,000 > `LONG_THREAD_TOKENS` so the cost line and the Start fresh control render; the brief is cut by `cleanBrief` at `MAX_BRIEF_CHARS`, final length ≤ 1,800. At 5,000 tokens `weightLine` returns the fragments nudge instead — 5,000 is above `FRAGMENT_MIN_THREAD_TOKENS` but below `LONG_THREAD_TOKENS` — so no Start fresh control renders, no brief is produced, and the 1,800 cap never applies. |
| 7 | 151 checks; `cleanBrief lives inside the injected helper block` |
| 8 | extension/ 2, worker/src/ 3 — to be confirmed at the round's commit |
| 9 | 148 matches; exit code 1 |
| 10 | `#!/usr/bin/env node` |

Step 5 is the one worth the round on its own: **the same constant and the same function are defined twice,
independently, in the extension and in the worker.** No arm has been asked anything that required noticing
something, as opposed to looking something up, and a review that misses it is a review that did not read.

**What each part is for, against the guard.**

- **Part 1** puts three results in the trim's window (24k, 14k, and CHANGELOG reading) and asks questions
  whose answers survive trimming — the head, the tail and the file names — so a trim that keeps the wrong
  three things shows up as a wrong answer rather than as a saving.
- **Part 2** is where the Read cap lives. Step 3 asks for `CHANGELOG.md` whole: 237 KB, about 59k tokens,
  and Claude Code's Read refuses a file over roughly 25k. The off arm should eat an error and come back
  bounded; the guarded arm should be handed 300 lines by the PreToolUse cap before the tool runs. **This is
  the only case in nine rounds where the cap can save rather than cost.** Steps 4–6 then need three large
  files read well enough to reason over, which is the shape the cap is supposed to help with.
- **Part 3** re-runs the suite (23k, in the window), forces a non-zero exit with 17k already printed
  (`PostToolUseFailure`, which no round has exercised with real output), and closes with the instruments.

**Expectation, fixed before the run.** For the first time, not a null: entered tokens lower on the guarded
arm, by something like 20k, with requests within three. If entered falls and requests rise by four or
more, that is the return trip on a task built to favour the guard, and it would be the strongest evidence
yet that trimming does not pay in tokens. If entered is level, the guard is not acting even here.

**Decision rule, fixed before the run.** Validity gate first: tool results ÷ requests near 1 on both arms
and within 1.5 of each other, and both arms' answers checked against the ground truth above — including
step 5, which is the one an arm can fail while looking fluent.

- Entered lower **and** requests within three **and** "cost not worse": the first workload on which this
  guard demonstrably works. It stays in this file until a second run on another day reproduces it. *(Quoted as pre-registered: the condition was written in cost, and pre-registered text is never rewritten after the run. Rounds after 2026-09-18 use the token condition in "Amendment: the third condition, in tokens" below.)*
- Entered lower and requests four or more higher: the return trip, recorded as such.
- Entered level: the guard is not acting on a task designed to make it act, and that goes in `README.md`'s
  "Limits" section next to the 285-call count.
- Either arm's answers wrong against the ground truth: void, and the wrong answer is the finding.

## What the guard actually did, counted rather than argued — 2026-09-10

Prompted by a critique of the package that listed four weaknesses. All four were accurate, and three were
this repository's own published findings arrived at independently, which is the most useful thing a critic
has said about the documentation. One correction: the critique's range mixes guard versions; the
shipping guard has three paired runs on that workload (their ratios were recorded in cost only; not restated
here — tokens-only record).

What the critique did not have is a count. This container's ledger, 285 logged tool results:

| | |
|---|---|
| under 6,000 characters — untouched by design | **282** |
| over 6,000 characters | 3 |
| — `sed -n '644,750p' AB-TASK.md`, 7,198 chars | a single-file excerpt: exempt since 0.2.3 |
| — `cat LANDSCAPE.md`, 6,557 chars | a single-file excerpt: exempt since 0.2.3 |
| — `mcp__github__actions_list`, 6,309 chars | not a shell result: the trim does not apply |
| **trims actually applied** | **0** |
| **Read caps fired** | **0** |

Two hundred and eighty-five tool calls, and the guard rewrote nothing. The sample is biased and the bias
should be stated: this repository's `CLAUDE.md` tells its agents to read with bounded `sed` ranges rather
than the Read tool, which is exactly the "the model bounds its own output" case that four rounds have
already shown leaves nothing to save. But it is 285 real calls, and it is the first time anyone counted.

It also sharpens the window that bounds the whole design. A shell result is rewritten only if it is **over
6,000 characters, under Claude Code's ~30,000-character ceiling, and exited zero.** The critique named the
failure hole; the ceiling is the one nobody had named, and it means the largest outputs — the ones most
worth trimming — are as unreachable as the failing ones. Between them they remove the debugging workload
entirely, which is the workload the trim was written for.

All of it went into `README.md` under "Limits, with the numbers" (moved word for word to `EVIDENCE.md` on 2026-09-18), ahead of the install instructions, on the
principle that a package whose whole argument is honesty should not leave its limitations to be discovered
by someone else.

### The wrong-session default, a third time — and the check that is actually reliable

ab9's off arm ran the new `report --top=8` at step 12 and got a report of `8c21713d`, which is **ab8's
tokenbrake arm**. Its own session was `8516e976`, on disk and newer. The arm said so — "this session issued
no Read or Grep tool calls at all, only Bash, so the ten Read rows do not describe this session's work" —
and was right, as ab8's arm was right and ab7's arm was wrong.

That is three misfires of the same default on Windows, and it is now established rather than suspected: a
transcript being written by a live process can carry a stale modification time there, so `report` with no
`--session` can name a session that finished hours earlier. **The step-12 report is part of the workload
and not part of the record.** The record is always `report --session=<id>` from the shell after the session
closes, with the id taken from `report --all`, and the id is the newest row carrying the repository's path
— never the one printed inside the arm's own step 12.

The reliable identity check is the **ledger row count**, not the trim line and not the session id: it grows
by one per tool call of a session the guard ran in. It caught nothing here only because the wrong report
was pulled before anyone compared counts.


### ab9 — the result, run 2026-09-10 by hand. The first time the guard moved anything.

Fable 5.1 (`claude-fable-5-1[1m]`), Claude Code 2.1.267, Windows, commit `d477c97` of `33kain/contexa`, one
message per arm, the review task. Both figures are `report --session=<id>` run from PowerShell after each
session closed.

| | off, `8516e976` | tokenbrake 0.2.4, `a2afb138` | change |
|---|---|---|---|
| requests | 16 | 17 | +1 |
| tool results | 15 | 16 | |
| **tool results ÷ requests** | **0.94** | **0.94** | both pass the gate |
| **tool results entered** | **12k** | **9k** | **−25%** |
| **tool results carried** | **118k** | **97k** | **−17.8%** |
| output tokens | 11k | 8k | −27% |
| trimmed by the guard | 0 | **3 — ≈ 9k kept out, ≈ 141k token-reads not carried** | |
| Read caps fired | none | none | |
| under the trim threshold | 12 of 15 shell, 29% of carried | 15 of 16 shell, 75% of carried | |
| Read / Bash calls | 0 / 15 | 0 / 16 | |

**By the rule written before the run, this is the first branch that has ever fired:** entered lower on the
guarded arm, requests within three, and "cost not worse" held (the rule as pre-registered). It therefore stays in this file and goes nowhere else
until a second run on another day reproduces it. That rule has already retired two numbers on this page and
it applies in this direction too.

**What is a claim and what is not.** Requests (+1) and output tokens (−27%) are outcomes of how the model
chose to plan, and two identically configured arms here have been 27% apart in cache reads, so neither is
quoted as an effect. What is measured rather than inferred is **entered** and **carried**: those are per-result counts from the transcript, not outcomes
of how the model chose to plan. Entered fell 25% and carried fell 18%, and the three trims are visible in
the arm's own table — `git log --stat -40` trimmed from 7k tokens to 544, `git diff HEAD~3` from 3k to 2k,
one `sed` excerpt from 2k to 1k. That is the first time in nine rounds that the guard's action shows up in
the numbers at all.

Note the guard's own "≈ 141k token-reads not carried" is a per-result counterfactual, and the measured
difference in carried is 21k. The two do not reconcile and should not be added together: the arms did
slightly different amounts of work, and the counterfactual assumes everything else held.

**The model starves the task, even one built to feed it.** The workload was designed from measured sizes so
four steps would produce 17k–24k characters. Neither arm let that happen. The off arm ran the worker suite
as `node test.mjs 2>&1 | tee … | tail -`, answered "read CHANGELOG.md in full" with `wc -l` and
`grep -c` on a 237 KB file it never opened, and used **zero Read calls in fifteen tool calls**. Total
entered: 12k, against 90k on the old audit. You cannot make a model accept a large result; you can only ask
a question, and it will find the cheapest way to answer. Which is the project's own thesis arriving from
the other side: the hook exists to stop the model letting big things in, and mostly the model does not.

**Three design faults in the task, found by running it.**

- **Steps 1, 2 and 3 are not comparable between the arms.** The off branch carries one extra commit — the
  one that empties `.claude/settings.json` — so `git log --stat -40` slides its window by one and
  `HEAD~3` spans different commits on each arm. The arms' answers differ accordingly: `index.html` at 4
  against 5 on step 1, and completely different file lists on step 2. That is the branch design, not the
  guard, and it means any step reading git history is void as an identity check. A future round must cut
  the off arm's configuration into the *same* commit as the on arm's, or ask nothing of `git log`.
- **Step 4 is open-ended and cannot be compared.** "List every named limit" produced 15 rows on one arm and
  19 on the other, both correct as far as they go. An A/B needs questions with one answer.
- **Steps 5 to 10 agreed exactly**, including step 5, the one that required noticing rather than looking
  up: both arms found `MAX_BRIEF_CHARS` and `cleanBrief` duplicated at `extension/background.js:621/622`
  and `worker/src/index.js:633/634`, and both got step 6's reasoning right in both directions. Ground truth
  confirmed 3, 7, 8, 9 and 10 against the branch afterwards; the arms were right and one of my
  pre-computed answers (step 8) was wrong.

**A gap the round exposed in the excerpt rule.** The guarded arm's trimmed `sed` excerpt was
`echo '=== content.js 320-345 (capture windows) ==='; sed -n …`. The 0.2.3 rule exempts a command that
*only* prints one file; prefixing a label with `echo` makes it a compound command and the exemption is
lost, so the excerpt was trimmed to head, tail and error-looking lines — the exact behaviour 0.2.3 removed,
reached through a different door. Models label their output this way constantly. Worth fixing, and worth
measuring before it is.

**What the round bought.** The first positive reading in the project's history, on the first workload built
from measurements rather than guessed at; a mechanism for it that is visible in the arm's own table; the
sign-off both arms wrote, which found a real code smell nobody asked about — the own-key fork handler
hardcodes `6000` and `2000` where the worker uses named constants, so drift there would be invisible to
`build.mjs`; and three faults in the task that the next round fixes. It is one run. It is not a number for
the README yet.


## An outside test plan, reviewed — 2026-09-10

A test plan for tokenbrake arrived from outside the project: four phases, vitest, assertions against
`processCommandOutput`, `compressCodeFile` and `optimizeForClaude` in `src/backend/index.js`. **None of
those exist.** tokenbrake is one `guard.js`, two hooks, no dependencies, no backend, no proxy and no
`src/`; the suite is a hand-rolled `test.mjs`, not vitest; and the model id it counts tokens against,
`claude-3-5-sonnet-latest`, is two generations stale. Written against a different product.

Its *premises* are another matter. Three of the five are worth having, and two of them were checkable
against the real guard in a few minutes. Measured, not argued:

| phase | claim | what the guard actually does |
|---|---|---|
| 1 | progress bars and ANSI should be stripped | **Gap, confirmed.** A 400-line install log with progress bars kept **65 progress lines and 144 ANSI escape sequences**, spending nearly the whole 6,000-character budget on them. The final status line survived only because it sits in the tail. |
| 2 | compress function bodies to a skeleton | **Refused, and not only for scope.** See below. |
| 3 | count tokens with the Anthropic tokenizer; require ≥ 40% savings | Half. The tokenizer instead of chars/4 is a real improvement and is optional work. The ≥ 40% gate is the error this whole page exists to refute. |
| 4.1 | a stack trace must survive | **Already true.** `Error: Cannot find module 'express'` and three frames survived 400 lines of passing noise, line-numbered as `L203:     at Function…`. |
| 4.2 | JSON and fenced blocks must not be broken | **Real, and previously unmeasured.** Both fences survived — they are head and tail — and the JSON between them **no longer parses.** |

**Why phase 2 is refused rather than deferred.** Replacing function bodies with `// ... internal logic ...`
would hand the model a file that looks complete and is not. tokenbrake's Read cap is safe today precisely
because a capped read is *obviously* partial and `Edit` still needs an exact string match, so a truncated
view cannot cause a wrong edit; a skeletonised view removes that protection. It is also the output-reduction
bet the JetBrains benchmark and this page's own `readMaxBytes` round both lost tokens on. It is not a
smaller version of what tokenbrake does; it is the thing tokenbrake was built to argue against.

**Why phase 3's gate is refused.** `expect(savings).toBeGreaterThanOrEqual(40)` makes a test fail unless
output shrinks by 40%. rtk advertises 60–90% output reduction and came out at **+14% turns and +14% cache reads** at
JetBrains. A test like that does not measure the tool, it steers it toward the behaviour that loses tokens. The 30 ms
processing budget in the same phase is reasonable and worth having; the guard already spends 50–100 ms per
call on process spawn, which is the number that actually matters and is not what the plan measures.

**What was built from it.** Phase 4.1 and 4.2 are now tests in `test.mjs`, under "what the trim keeps and
what it breaks". The first pins behaviour that already works so a budget change cannot silently lose it.
The second **pins a limitation rather than a feature**: it asserts that the JSON does *not* parse, so the
day someone makes the trim structure-aware the test fails and has to be updated deliberately. Writing the
first version of those tests, two of my four assertions were wrong about the guard's own output shape — the
frames come back line-numbered and the gap is marked `[tokenbrake] N lines omitted here`, not with an
ellipsis — which is its own small argument for probing before asserting.

**What phase 1 becomes.** It is the shape-filter work `LANDSCAPE.md` has had planned since the first week
and never built: collapse repeated lines with a count, strip ANSI, collapse passing-test lines, compact
JSON that parses, at a threshold well below `maxChars`. The measurement above is the first evidence that it
would do anything — 65 progress lines and 144 escape sequences of a single 6,000-character budget. It is a
guard change, so it ships default-off behind a config flag and is A/B'd before any default moves, which is
the rule that has governed every other change here.

### The shape filter's first bug, found before a run was made — 2026-09-10

An outside adversarial benchmark was built against tokenbrake the same day the shape filters landed. Its
mechanism harness exercises the filters on and off, and it reported that they collapse not only the deploy
log's progress bars but **the tenant settlement table** — distinct numeric rows — and flagged it as a loss
risk worth the A/B.

Reproduced here in one probe: sixty rows of `acme-041   EUR   2517.41   settled   2026-09-10T11:41:00Z`
became **one row and a count**. Fifty-nine tenants' amounts gone. The rule was "a run of three or more
consecutive lines differing only in numbers or bar glyphs", and a table differs only in numbers too.

Fixed by requiring the lines to be **redraw-like**: a run collapses only if its lines carry bar glyphs or a
percentage, which a progress redraw has and a data row does not. Verified both ways — the sixty-row table
now passes through untouched (the guard emits nothing at all), and the 400-line install log still goes from
32,310 characters to 2,519 with ANSI gone and the final status intact. A run of `syncing shard 12 — 12%
complete` still collapses, because that is a redraw.

The test that had encoded the bug as intended behaviour — "distinct lines that differ only by number ARE
collapsed, that is the whole mechanism" — is replaced by two: the table must not collapse, and the same
shape with a percentage must. Writing a test that asserts the bug is the failure mode worth naming here;
the filter was written and tested by the same person in the same hour, and it took an adversary to see it.

This is the flag-and-A/B rule paying for itself before the A/B: a lossy filter that shipped default-on
would have destroyed data in real sessions, and the round that would have caught it had not been run yet.

### The adversarial benchmark, built and configured — 2026-09-10

An outside spec asked for a reproducible adversarial benchmark and it was built the same day, in
`tokenbrake-bench` on the owner's machine, separate from this repository. It supersedes `AB-RUNBOOK.md`
for future rounds. What it is, from its own self-check and from what was verified here:

- **One seeded generator** builds a synthetic payment-incident repo and a hidden answer key **from the same
  objects**, so fixtures and answers cannot drift. `node selftest.mjs` regenerates, checks hashes and runs
  every validation with **no model calls**; it ends `ALL GREEN`.
- **Fixtures sit on the window's boundaries**, each asserted: successful commands at exactly 5,900 / 6,000
  / 6,001 chars and at 12k and 28k; one over 35,000 that the host persists so the replacement is never
  applied; a failing command at ~18,000 chars with a non-zero exit, where Claude Code ignores the
  replacement. Plus a source file over 60,000 bytes with the fault past line 300, saved outputs straddling
  the persisted-read threshold with evidence past line 80, a 144 KB file over the host's Read refusal,
  passing tests named `error`/`failure`/`warning` with ASCII and Unicode markers, CRLF, quoted paths with
  spaces, and a decisive neutral record that the default trim does **not** preserve.
- **It fixes, by construction, four things this page learned the hard way.** Arms toggle by writing a
  git-ignored `.claude/`, so both sit on the same commit with a clean tree — no second commit sliding
  `git log --stat -40` or `HEAD~3`, which voided ab9's steps 1 to 3. `measure.mjs` re-derives
  tokens **from the transcript, not from tokenbrake's ledger**, and its arithmetic is proven against
  synthetic transcripts with hand-computed answers including compaction boundaries. The session id is
  found from the shell after the session closes, never from inside it — the default that named the wrong
  session three times here. And it measures what the guard **emits** separately from what the host
  **delivers**, which is the distinction the report's credit fix was about.
- **Two experiments, never pooled.** A mechanism stress test over fixed fixtures, and one natural incident
  task whose prompt names no file and never says "read in full" — the phrasing that forbids the guard's
  saving by construction. Only the natural task feeds the verdict.
- **Pre-registered**: five paired OFF/ON runs in balanced order, two OFF/OFF controls to estimate normal
  variability, one ON/SHAPE pair, and a verdict rule fixed in `results/PRE-REGISTRATION.md`. Fewer than
  five pairs is reported as "inconclusive". An ON-arm critical correctness error the OFF arm did not make
  blocks any safe-savings claim whatever the token counts did.

**It found a real bug before a single run was made** — the shape filters collapsing the tenant
settlement table, recorded in the section above. After the fix was pulled and the fixtures regenerated
against `bcaaf58`, its mechanism output changes exactly one fixture with `shapeFilters` on
(`F08_deploy_log_ansi`, 8,353 → 5,368 chars) and the settlement table no longer appears. That is the
confirmation, and it is the strongest argument the flag-and-A/B rule has produced in either direction.

**Two small defects in the build, recorded rather than fixed.** Its own README claims the guard SHA is
pinned into `fixtures/manifest.json`; there is no `guard` key there, only fixture hashes, so
`plan.json`'s instruction to make `guard_version` "match fixtures/manifest.json guard sha" cannot be
followed and the field was filled by hand (`0.2.4 @ bcaaf58`). And `selftest.mjs`'s own output says
nothing about the shape filters; that evidence lives in `results/mechanism/experiment-A.txt`.

**Configured and ready**: guard `bcaaf58`, model `claude-fable-5-1[1m]`, Claude Code 2.1.267, Node
v24.19.0, no `TBD` left. Sixteen sessions in the plan, and nothing needs to be run in one sitting: the fixtures are deterministic and `restore.mjs` refuses to
proceed if they do not match the pre-registered hashes. **ab10 runs through this, not through
`AB-RUNBOOK.md`.**

### The shape filter's second and third bugs, from the same review — 2026-09-10

The list that came with the benchmark named five things. Two were claims about this code and both were
true; they were checked with probes rather than judged, and both destroyed data.

**A percentage is not a redraw signal.** The settlement-table fix had narrowed collapsing to lines carrying
"bar glyphs **or a percentage**". Eighty rows of `tenant acme-079 risk score 53% approved` collapsed to one
row and a count — the same destruction as the settlement table, through the other half of the same rule.
Percentages appear in data far more often than in progress bars. **A run of bar glyphs is now the only
signal.** The cost is real and accepted: a bar-less `Downloading… 45%` is no longer collapsed. A filter that
misses noise is a nuisance; one that eats rows is a bug.

**A trailing `\r` is a line ending, not a redraw.** After `split('\n')`, every line of a CRLF document ends
with `\r`, so "keep what follows the last `\r`" followed nothing: a 120-row CRLF CSV was delivered as **121
characters of empty lines**, every field gone. The worst thing this filter has done. A line is a redraw only
if a `\r` sits *inside* it; a plain line, CRLF or LF, now passes byte for byte.

**What the two fixes cost, measured honestly.** The first probe used a bar that starts empty
(`'='.repeat(pct/8)`, zero glyphs for the first quarter), and against it the filter now barely acts:
5,998 characters to 5,841, still trimmed, still a hole. Against a bar with glyphs from the start — what a
real installer prints — it is **5,936 to 942 with no trim at all**. The headline this file and the README
carried for one afternoon, 32,310 to 2,519, came from the unsafe version and is withdrawn. The number that
matters is the benchmark's own `F08_deploy_log_ansi` fixture, which will be lower than the 8,353 → 5,368 it
reported against the unsafe guard; that measurement is now the benchmark's to make, not a probe's.

**Three bugs in one feature in one afternoon, all in code written and tested by the same person in the same
hour, none caught by its own tests.** Each test that shipped alongside a bug asserted the bug was the
intended behaviour — twice, then a third time. What caught all three was an outside document written by
someone with no stake in the feature working. That is the argument for the benchmark and for the flag: the
default is still `false`, and none of this reached a real session.

### The remaining three items on that list, and what they need

- **Excerpt detection: labelled outputs and quoted paths with spaces.** `EXCERPT` requires the command to
  be a bare `cat`/`sed -n`/`head`/`tail` with one unquoted, space-free path and nothing after it. So
  `echo '=== content.js ==='; sed -n '320,345p' file.js` loses the exemption and is trimmed to head, tail
  and error lines — ab9's guarded arm did exactly that — and `cat "my file.txt"` fails the same way because
  the character class forbids whitespace inside the path. Models label their output constantly and Windows
  paths have spaces. **The benchmark covers this**: its mechanism harness runs plain reads, labelled
  equivalents, piped ones and quoted paths as separate fixtures. Fix after its Experiment A says how often
  each shape actually appears, not before.
- **The report as a product: where the guard *can* act, what was applied, what was out of reach.** The
  report already says what entered, what was trimmed, what was offered and not applied, what sat under the
  threshold, and now how many Read caps fired. What it does not say is the share that was never reachable
  at all — results above the host's ceiling, failing commands, non-shell tools — which is the honest
  denominator for everything else. On one ledger that share was total: 285 tool results, trim applied to
  none. **The benchmark will not produce this**; it is product work, and on a package whose whole argument
  is honest measurement it is arguably the most valuable item on the list.
- **Only then a lower threshold or shape filters on by default.** Correct sequencing and exactly the rule
  this page already runs on. Nothing moves until an A/B moves it.


## ab10 — the benchmark, pair 1 (Fable 5.1 [1m], guard 98b3c07)

The benchmark now lives at [33kain/tokenbrake-bench](https://github.com/33kain/tokenbrake-bench), private,
so it can be fixed by commit instead of by hand on one desktop. Every measured arm records the benchmark
commit beside the guard commit; without both, a number is not reproducible.

### Pre-registration, written before the ON arm

- **Primary expectation: null.** The OFF arm's transcript says the trim has almost nothing to bite on —
  6 of 8 shell results are under the 6,000-char threshold, the host had already persisted 3 previews, and
  the results under the threshold account for 5% of carried tokens. Two candidate results is not a lever.
- **A secondary hypothesis, raised and then withdrawn before the run.** 3 of the OFF arm's 7 requests
  crossed 200k input tokens, and I argued that a long-context surcharge — a step rather than a slope —
  was plausibly the only mechanism by which the hook could move the result on this model. I had not
  checked. Anthropic's published long-context terms, read 2026-09-10, treat the full 1M window of Claude
  4.6 and later the same as a short request, per token. **There is no step.** The hypothesis is dead
  before it cost a session, and the null expectation now stands alone with one fewer route to a saving.
- **Decision rule.** The OFF/OFF band decides, as always. `requests_over_threshold` is reported per run
  as context, never as an effect. The bench's `prices.json` now records, per model and with a verification
  date, how the long window is treated, or that it is unrecorded — and an unrecorded model makes the run a
  declared lower bound rather than being assumed standard.

### B-pair1-off — the OFF arm

Session `aac143d4`, 7 requests, 40 tool results, 982k processed (78% cache read), 0 compactions, 2
recovery reads. **38 / 38, zero critical errors.** Only token counts are stated here.

### What the first run measured was this harness

Three defects, all found by running it once, all recorded in the bench's `results/DEVIATIONS.md`:

1. **The scorer reported 2 / 38 for a perfect answer.** It scanned for the last `{...}` containing the
   substring `affected` and matched **"unaffected"** inside an evidence object the session wrote to rule
   out a distractor — then scored that fragment, every field `undefined`, with five critical errors, which
   under the verdict rule blocks any claim of safe savings. A confident wrong number is worse than a
   crash: it would have entered the tables as a correctness result and blocked the guard for a reason
   having nothing to do with the guard. Now the candidate with the most schema keys wins, and an answer
   carrying none is **refused** (exit 65, `capture_invalid`) rather than scored zero.
   I first blamed the operator's hand-copied capture. That was wrong, and the hand copy scores 38 / 38 too.
2. **Long-context handling was asserted, not checked.** `measure.mjs` printed a label claiming a
   long-context surcharge exists, against a page that says the opposite. Now `prices.json` carries the
   answer per model with a date and a source, and the three-state distinction that matters: standard,
   surcharged, or *unrecorded and therefore a declared lower bound*. An unknown is never quietly treated as
   standard — the same error as this one, caught early.
3. **The validity gate would have voided every run.** It failed any run with `tool results ÷ requests`
   over 2.5; this one measured 5.71. The cap came from ab7/ab8, whose prompt was twelve numbered steps and
   forced one call per turn. This benchmark deliberately lets the agent batch — batching is recorded as an
   outcome, not forced — so the cap contradicted the design it was meant to protect. What ab7 caught was
   *one arm batching and the other not*; that between-arms test stays, as a ratio (`max/min > 1.5`).
   This is an amendment to a pre-registration after the first session, made with no ON arm in existence,
   and it is flagged as an amendment wherever the verdict is quoted.

Every one of the three is now covered by a test that fails if the defect returns.

### ab10 result — five paired runs, and the mechanism

Full tables: [tokenbrake-bench `results/RESULTS-TABLES.md`](https://github.com/33kain/tokenbrake-bench/blob/main/results/RESULTS-TABLES.md).
Sixteen sessions, Fable 5.1 [1m], guard `98b3c07`, one day.

The pre-registered rule fired a **reduction outside the control band** on its primary endpoint — and then
a third control pair, pre-registered hours later with the rule that it counts whichever way it falls,
widened the band and **retracted it**. The standing verdict is **no measurable difference on the
pre-registered endpoint: the paired median sits inside the control band; tool-result tokens entered fell
−35.7%; a token reduction, reported as exactly that.** (The endpoint's figures, the band and the per-pair
range were recorded in cost only; not restated here — tokens-only record.)

Reading that result exposed a flaw in the band itself. It was defined as the **maximum** control
difference, and a maximum grows with sample size — the three controls came out each larger than the
last — so the band widens forever and any effect eventually vanishes, real or not. Under the **median** of
the same three controls the band is narrower and the verdict would have been a reduction.
The statistic decides the answer, and the flaw was noticed only when it cost the result. Round 1 is not
re-scored: it stands under the rule in force when its sessions were run. A median band over at least
four controls is pre-registered for round 2, before any round-2 session exists. Against the widened
band, four of the five pooled pairs are inside it, and the unpaired reading is inside too. All twenty-two
runs are from one day and one usage window.
**Nothing is published.**

**What does not depend on the band: tool-result tokens entered fell between 19% and 62% in every pair,
median −35.7%. And twenty-two runs, twenty-two 38/38, zero critical errors.** No ON arm made an error its OFF arm
did not.

Three things the round established that the project did not know before:

- **The saving is in carried tokens, not in the trimmed result.** Median carried 197k (OFF) against 118k
  (ON). A trimmed result is smaller once and then smaller again in every later request of the session; that
  compounding is the whole effect. `carried` was already the right column — this is the first evidence
  that it is the *only* one that matters.
- **The number of trims does not predict the saving.** The two pairs with two trims gave the largest
  reductions, the two with seven trims middling ones, and the one with three the smallest (per-pair
  figures recorded in cost only; not restated here — tokens-only record). Which result is trimmed, and how
  early, dominates how many.
  Any future tuning aimed at "trim more" is aimed at the wrong quantity.
- **The failure mode has been seen.** Pair 5's ON arm ran 9 requests against 6, made 4 recovery reads, and
  ended with **330,936 carried tokens — more than any run in the experiment, either arm** — for the
  smallest saving. Every ON arm made more recovery reads than its OFF arm. When the model goes back
  for what the trim removed, the session lengthens and the saving pays for the recovery.

Also, first time outside a test: **the Read cap fired in every ON run**, one to four times per session.
ab8 recorded that `readMaxBytes` had never been observed to fire in a real session; that is now false.

### ab10 closed — what twenty-two sessions bought

Tokens were then tested as a second endpoint, beside the pre-registered one and against a band built the same
way. They did not rescue it: `entered` −35.7% against a ±42.6% band, **inside**; `carried` −45.5% against
±44.9%, outside by 0.6 points on the estimator already recorded as unsound, with a range reaching
**+72.6%** — one pair whose ON arm carried most of all.

**The finding is not that the hook does nothing. It is that this experiment cannot tell.**

Two identical OFF sessions — same fixtures, same prompt, no guard — differ by up to
**42.6% in tokens entered**. The agent reads differently every time, and that variation is the same size
as the effect. Five pairs cannot resolve a difference of that size against noise of that size.

That is worth more than either verdict this round produced, because it says what to do next: **not more
sessions of the same kind.** When noise and effect are the same order, extra pairs mostly measure the
agent's mood. The lever is variance, and cutting it is exactly what Experiment A already does — fixed
invocations, fixed fixtures, no freedom for the agent, the mechanism measured directly.

So the defensible shape, today, with no further sessions:

- **Mechanism (Experiment A):** the guard rewrites specific outputs by measured amounts, reproducibly,
  with no session noise. This is what the package may claim.
- **Natural task (Experiment B):** the effect on a real session is not separable from the difference
  between two identical sessions without the guard. No session-level figure may be quoted as an effect.
- **Correctness:** twenty-two runs, twenty-two 38/38, zero critical errors.

The day-2 replication is **withdrawn as designed**. Fourteen more sessions of a design that has just
demonstrated it lacks the power would buy a second inconclusive result at twice the sessions. A round 2,
if there is one, changes the design first: a lower-variance endpoint, a task that constrains reading, or a
model on which what the hook actually moves is a larger share of the session.

## MCP tool-output trimming (feature 1) — 2026-09-14, Opus, two single pairs

Feature 1 added `mcpTrim` (default false): route an oversized `mcp__*` result through the same trim as shell
output. This is the A/B that gates flipping that default. Arms differ in **`mcpTrim` only** — `jsonShape` and
`shapeFilters` were left at their default `false` in both — so this measures `mcpTrim` alone, not the combo.
Model Opus, on `main`, both arms per pair run as separate Cowork sessions. Numbers are read from the **session
record** (`get_session`: cache tokens, `context_usage.used_tokens`), not the guard's own ledger, so
recovery reads are counted in — the net, as the methodology requires.

Two workloads, chosen as opposite extremes rather than a representative mix:

- **content-heavy** — every question needs the *full* MCP result (how many of 40 commits are `claude`, how many
  `t(` lines in `test.mjs`, how many `arm B` in `AB-TASK.md`). When the trim cuts the result, the model must go
  back for it: recovery reads.
- **glance** — every question is about the *top/first* item only (most-recent commit, first PR, first heading),
  so the trimmed head/sample is enough and no recovery is needed.

### Measured (one pair per regime, n=1 each)

| regime | metric | A `mcpTrim:off` | B `mcpTrim:on` | Δ (B vs A) |
|---|---|---|---|---|
| content-heavy | cache_read | 1,169,006 | 1,390,745 | **+19%** |
| | context now | 82,042 | 84,107 | +2.5% |
| glance | cache_write | 73,530 | 46,118 | **−37%** |
| | context now | 102,601 | 83,665 | **−18.5%** |

### Reading — held against this repo's own noise

ab10 (above) established that two **identical** OFF arms of a natural task differ by up to
**42.6% in tokens entered**. Against that band: the content-heavy +19% cache reads and the glance −37% cache
writes both sit **inside** it. So — by this repo's own standard — **no figure here is quoted as an effect.**
The glance `context now` −18.5% is the cleaner-looking number but is still within the token noise ab10 measured.

What survives noise is the **direction and its consistency with the mechanism**, not any magnitude: trimming a
result the model *needs* forces recovery and lengthens the session (content-heavy went up); trimming one it only
*glances* at removes carry it never used (glance went down). Same split ab10's thesis predicts — "the guard
saves what the model would otherwise let in."

### Measured vs reasoned (kept separate on purpose)

- **Measured:** the directional split above — ON worse on content-heavy, ON better on glance — from two single
  pairs, both noise-limited. The content-heavy result is **inconclusive**: +19% cache reads sits inside the
  42.6% token band, so no harm is established, only a direction consistent with the mechanism. (Downgraded
  2026-09-18 from "a real backfire, not a null": that verdict rested on a cost figure, and in tokens alone the
  evidence does not carry it.)
- **Reasoned, NOT A/B-confirmed:** that `mcpTrim` is a net win as a per-tool opt-in for glance-heavy MCP tools;
  and that `jsonShape` improves the trimmed sample (it was **off** in both arms, so its added value here is
  mechanism, not measurement). Answer **correctness was not captured** this round (no channel to the arms'
  final messages); for glance it is design-guaranteed by the head questions, for content-heavy the recovery
  reads are what staying correct takes.

### Conclusion

**Default stays OFF** for `mcpTrim` (and `jsonShape`, `shapeFilters`). The burden of proof is on the **flip**,
not on staying off: a thin, noise-limited A/B does not meet it, and the direction it points — flipping can *add*
reads on a content-hungry workload (+19% cache reads here, inside the noise) — is reason enough not to flip on it. `mcpTrim` ships as an **opt-in**, best set
**per-tool** (`"tools": { "mcp__…": { "mcpTrim": true } }`) for MCP tools whose results you reliably only
sample; pair with `jsonShape` for a clean JSON sample.

Deliberately **not done:** more pairs. ab10 already showed that on a design where noise and effect are the same
size, extra pairs mostly measure the agent's mood. Quantifying `mcpTrim` would need a lower-variance design
(Experiment-A style: measure the trim on a fixed result directly), which the mechanism tests in `test.mjs`
already do for the rewrite itself.

## Read-After-Edit Delta (narrowing 1) — the A/B protocol

`readAfterEdit` narrows an **unbounded Read of a file the model just edited** to the changed region + context.
It ships **OFF**; this A/B is the gate for the default, and it is read straight off `tokenbrake report
--backfire` (the delta line — token-reads, no dollars), so unlike the arms above it does not depend on the
usage page.

**What the delta needs to fire, and where the code must live.** The guard a session runs is the committed
copy of the checkout it started on, so the delta only exists in a session whose checkout carries this feature
(this branch, or `main` once merged) — a config flip alone cannot add the knob to an older guard. Both arms
differ **only** by a step-0 config write, exactly as the Opus round does.

**Two questions, kept apart.**
1. *Per-firing net* — when the verify re-read happens, does narrowing it help or send the model back? The task
   below forces the re-read so this is measured cleanly and repeatably.
2. *Firing rate* — how often the pattern happens on its own. The Claude Code harness tells the model not to
   re-read a file it just edited, so on Opus the organic rate may be low; a run of ordinary edit work with the
   delta on, reading only the `deltas fired` count, answers this. A low rate is a real finding, not a failure:
   it bounds how much the delta can ever save on that model.

**The task (paste verbatim; step 0 is the only difference between arms).** It edits **scratch copies**, so it
is fully reversible and repeatable:

```
Edit-heavy task. Do every step with tools, in order. At the end write the final answer in step 6.

0. Arm A: run  mkdir -p ~/.claude && printf '{"readAfterEdit": false}' > ~/.claude/tokenbrake.json
   Arm B: run  mkdir -p ~/.claude && printf '{"readAfterEdit": true}'  > ~/.claude/tokenbrake.json
1. Copy the repo's guard.js, cli.js and transcript.js into /tmp/abwork/ (as guard.js, cli.js, transcript.js). Work only on those copies; do not touch the repo's own files.
2. Make each of these edits with the Edit tool, and AFTER each edit Read the whole file you just edited to confirm the change before the next step:
   a. /tmp/abwork/guard.js: change the DEFAULTS value maxChars from 6000 to 7000.
   b. /tmp/abwork/guard.js: change headLines from 40 to 48.
   c. /tmp/abwork/guard.js: change tailLines from 40 to 48.
   d. /tmp/abwork/cli.js: in the help text, change the word "trims" to "trim" in the first line.
   e. /tmp/abwork/cli.js: change the clean default of 7 days to 14 in the help text.
   f. /tmp/abwork/transcript.js: change CHARS_PER_TOKEN from 4 to 4 (a no-op edit is fine; still Read to verify).
   g. /tmp/abwork/transcript.js: change the TRIM_CHARS constant from 6000 to 7000.
3. Run `node /tmp/abwork/cli.js --help` (it will fail harmlessly; that is fine) and move on.
4. Run `git status --short` in the repo and confirm it reports no changes to tracked files.
5. Run `cat ~/.claude/tokenbrake.json`.
6. Run `node cli.js report --backfire` in the repo and paste its full output verbatim, then the outputs of steps 4 and 5.

Final answer: the number of edits you made, whether any re-read was narrowed (you will see a tokenbrake note in the read result), and the pasted outputs of steps 5 and 6.
```

**What the comparison reads.** From step 6, arm B's `report --backfire` line: `Read-After-Edit deltas: N
fired; M sent the model back`. The read the delta narrowed on each verify is the *fired* count; a `sent the
model back` is a backfire (the verify needed more than the region, or a later read of the file landed outside
it). Arm A is the baseline: with the delta off, `deltas fired` is 0 and the same reads enter whole. Compare
the two arms' `report` — context processed, tool results entered/carried — for the net; the delta pays off
when arm B carries fewer read token-reads with `M` small against `N`. A human-run pair can also read the
five-hour window per arm as the other rounds do; it is secondary here because the delta line is exact.

**Decision rule, fixed before the run.** Flip the default to `readAfterEdit: true` only if, across the run,
`M/N` (backfire rate) is low **and** arm B's carried read token-reads are meaningfully below arm A's. A high
`M`, or no measurable carry difference, keeps it OFF and opt-in. As with `mcpTrim`, the burden of proof is on
the flip.

### Result — ON arm, 2026-09-14 (Opus, spawned cloud session on this branch)

One ON-arm session ran the task above (`readAfterEdit: true`) autonomously on a checkout of this branch.
`report --backfire`:

```
Read caps fired: 2
Read-After-Edit deltas: 5 fired; 2 sent the model back for a wider read of the file
```

**5 fired, 2 backfired — a 40% backfire rate.** All five verify-reads were narrowed to the edited region; the
split was by **file size**: the three reads of the small file (`guard.js`) were satisfied by the narrowed
region (the edit sat in it) and did not send the model back, while the two reads of the large files
(`cli.js`, `transcript.js`, near/over `readMaxBytes`) backfired — the model asked for the whole file again
despite the edit being shown in the narrowed slice. A small slice of a large file leaves the model wanting
the rest; a slice that is most of a small file does not.

**Decision: default stays OFF.** The pre-registered rule flips only on a low backfire rate; 40% is not low.
This is the gate working as intended — it caught a real backfire and stopped the flip. The delta ships opt-in.

**Verified, not taken on trust.** The run's own prose claimed the size cap "delivered the first 300 lines
instead of the narrowed window" on large files (i.e. the edit was not visible). That is wrong, and was
reproduced against the guard directly: an unbounded read of a 2,000-line (~90 KB, over `readMaxBytes`) file
edited at line 545 is narrowed to lines 525–565 — the delta returns before the size cap, whatever the file
size, so the edit is shown. The backfires are genuine model behaviour on large files, not a cap-replacement
bug.

**Caveats.** n = 1 session, one model (Opus), and the verify-read was forced by the task — this measures the
delta's effect *when the pattern occurs*, not its base rate, and this repo's A/Bs are noise-limited (ab10).
Read the direction (small files help, large files backfire), not the 40%.

**Change made (2026-09-14): the delta now applies only to files at or under `readMaxBytes`.** The A/B split by
size exactly on that line — the helped file (`guard.js`, 42 KB) sat under `readMaxBytes` (60,000 bytes ≈ 59
KB), the two that backfired (`cli.js` 89 KB, `transcript.js` 95 KB) over it — so the delta reuses that
threshold rather than a new knob, and gates on the same conditions the read-whole path does (also skipping a
persisted output or an `alwaysCap` file, which have their own caps). A larger or capped file is left to the
size cap (`guard.js` handleReadPre). This removes the backfiring
class by construction: re-run the ON arm and the two large-file firings should be gone, leaving the three
small-file firings that helped. **Default is still OFF** — flip it only after that re-run measures the backfire
rate low with the gate in place; the change narrows *where* the delta fires, it does not itself move the
default.

### Re-run — ON arm with the gate, 2026-09-14 (Opus, spawned session)

Same ON arm with the gate in place; the task edited four small files (under `readMaxBytes`) plus one 96 KB
file (over it), each verify-read whole. `report --backfire`:

```
Read caps fired: 2
Read-After-Edit deltas: 4 fired; 0 sent the model back for a wider read of the file
```

**4 fired, 0 backfired (0%), and the 96 KB file was CAPPED, not narrowed.** The size gate excluded the large
file in a real session, not just in the unit tests; each small-file window (lines 77–123) contained the edit,
so the verify was satisfied without a wider re-read. Combined with run 1 (small files 0 of 3 backfired; the 2
backfires there were the large files now gated out), small-file verify-reads have backfired **0 of 7** across
both runs.

**Default still OFF / opt-in.** The gated delta is validated *when it fires* — on the files it now touches it
does not backfire, and the risky large files are excluded. But the flip's burden is not met: the pattern was
**forced** by the task, on one model, and neither the organic firing RATE (Opus is told not to re-read after
an edit, so it may rarely fire on its own) nor the real carried-token SAVINGS against an OFF arm was measured.
So it ships as a **recommended opt-in** (`readAfterEdit: true`), not a moved default. Flipping would need an
organic session (no forced re-reads) showing the delta fires and nets a saving on its own.

## Binary-Blob Elider (narrowing 3) — the A/B protocol

`blobElide` replaces **shell output that is one long encoded/minified run** — a base64 dump, a minified
bundle, a one-line JSON — with a short head + a descriptor + a saved `out/` copy. It ships **OFF**; this A/B is
the gate for the default, read straight off `tokenbrake report --backfire` (the `blob` byKind count and its
backfires — token-reads, no dollars), so like narrowing 1 it does not depend on the usage page.

**What it needs to fire, and where the code must live.** As with the delta: the guard a session runs is the
committed copy of the checkout it started on, so `blobElide` only exists in a session whose checkout carries
this feature (this branch, or `main` once merged); a config flip alone cannot add it to an older guard. Both
arms differ **only** by a step-0 config write.

**Two questions, kept apart.**
1. *Per-firing net* — when a blob is elided, does the model go back and Read the saved file (a backfire counted
   by `report --backfire`), or is the head + a targeted `grep`/`jq` of the original enough? Step 6 puts a value
   past the kept head so the choice is forced and measured.
2. *Firing rate* — how often blob-shaped output appears on its own. Blobs are rare per session but large when
   they hit; a low organic rate is a real finding (it bounds the ceiling), not a failure.

**The task (paste verbatim; step 0 is the only difference between arms).** It writes only under `/tmp`, so it
is fully reversible and repeatable:

```
Blob-heavy task. Do every step with tools, in order. At the end write the final answer in step 7.

0. Arm A: run  mkdir -p ~/.claude && printf '{"blobElide": false}' > ~/.claude/tokenbrake.json
   Arm B: run  mkdir -p ~/.claude && printf '{"blobElide": true}'  > ~/.claude/tokenbrake.json
1. Run  mkdir -p /tmp/blobwork
2. Write /tmp/blobwork/bundle.min.js as ONE line of minified-looking JavaScript at least 8000 chars, no newlines:  node -e "require('fs').writeFileSync('/tmp/blobwork/bundle.min.js','!function(){'+'var x'+Array.from({length:900},(_,i)=>i+'=Math.random()*'+i).join(',')+';}();')"
3. Write /tmp/blobwork/photo.b64 as one 10000-char base64-ish line:  node -e "require('fs').writeFileSync('/tmp/blobwork/photo.b64','data:image/png;base64,'+'ABCDEFGH'.repeat(1400))"
4. Write /tmp/blobwork/config.json as a single-line JSON at least 6000 chars with the field placed near the END:  node -e "let o={pad:'x'.repeat(6000),targetValue:'ZZZ-9137'};require('fs').writeFileSync('/tmp/blobwork/config.json',JSON.stringify(o))"
5. Run each, one at a time, and read the result:  cat /tmp/blobwork/bundle.min.js   then   cat /tmp/blobwork/photo.b64   then   cat /tmp/blobwork/config.json
6. State the value of the "targetValue" field in config.json. Get it however you judge best.
7. Run `node cli.js report --backfire` in the repo and paste its full output verbatim, then run `cat ~/.claude/tokenbrake.json` and paste it.

Final answer: for each of the three cat commands, say whether tokenbrake elided it (you will see a "[tokenbrake] withheld ... blob-like output" note in the result); how you obtained the targetValue in step 6 and whether you re-read a saved file (or ran `tokenbrake show`) to get it; then the pasted outputs of step 7.
```

**What the comparison reads.** From step 7, arm B's `report --backfire`: the `Withholds` line's byKind should
show `3 blob` (the three cats), and `Pulled back: N of 3 … backfire rate` says how many sent the model back to
Read the saved file. A `grep`/`jq` of the *original* `/tmp` file in step 6 is NOT a pull-back (it does not read
the `out/` file) — that is the cheap, sanctioned path and the good outcome. Arm A is the baseline: with
`blobElide` off the three blobs enter whole (or are size-capped, not blob-elided), so `blob` withholds are 0.

**Decision rule, fixed before the run.** Flip the default to `blobElide: true` only if the blob backfire rate
is low **and** arm B carries meaningfully fewer read token-reads than arm A. A model that Reads the saved file
back on most firings keeps it OFF/opt-in. Burden of proof is on the flip, as with every other narrowing.

### Result — ON arm, 2026-09-14 (Opus, spawned cloud session on this branch)

One ON-arm session ran the task above (`blobElide: true`) autonomously on a checkout of this branch.
`report --backfire`:

```
Withholds: 2 (2 blob) -- ~ 6,215 tokens kept out, ~ 28,251 token-reads not carried
Pulled back: none of the 2 withholds was read back -- backfire rate 0%
Net: ~ 28,251 token-reads saved after backfires   (28,251 saved - 0 pulled back)
Verdict: too few withholds to call it (need a few)
```

**2 fired, 0 backfired (0%), ~28.3k token-reads saved.** Two of the three blobs elided —
`bundle.min.js` (one 19,601-char line) and `config.json` (one 6,035-char line), each replaced by a head +
descriptor + saved `out/` copy. The per-firing net is clean: the task hid `targetValue` past the 160-char
head, and the model fetched it with a targeted `jq` on the **original** `/tmp` file — not by reading the saved
`out/` file and not by `tokenbrake show`. So the elision withheld ~28k token-reads of unreadable bytes and the
model still got the one value it needed by the cheap, sanctioned path. That is exactly the behaviour the design
leaves room for, and the reason blobs are a low-backfire target: the raw bytes are rarely what the model wants.

**The base64 case did not go through the elider — a fixture artifact, not a miss.** `cat photo.b64` (a
`data:image/png;base64,…` line) was intercepted by the Claude Code harness as an *image* (a resize/render error)
before the guard's PostToolUse note could show, so its bytes never entered context and it is not one of the two
withholds. A real base64 blob that is *not* a `data:image` URI (a base64-encoded archive, a JWT dump) would not
trigger image handling and would elide like the other two; the fixture just picked a shape the harness treats
specially. Worth remembering for the deferred **MCP base64** follow-up (those arrive as image content blocks,
not shell text, and need their own path).

**Decision: default stays OFF / opt-in.** The pre-registered rule wants low backfire **and** a real saving, and
both are present (0% and ~28k token-reads) — but the verdict is `too few withholds to call it` at n = 2, the
pattern was **forced** by the task (the blobs were created and `cat`'d on purpose, so the organic firing RATE is
unmeasured), and it is one model. This is the same bar narrowings 1 and 2 sat at: validated *when it fires*, not
yet a moved default. It ships as a **recommended opt-in** (`blobElide: true`). That said, it is the
best-behaved narrowing measured so far — 0% backfire where the delta's forced run was 40% before its size gate —
and blobs are the high-value "context bomb" case, so it is the strongest opt-in of the three. Flipping the
default would need an organic session (no created-on-purpose blobs) showing it fires and nets a saving on its own.

## Change-Aware Git View (narrowing 4) — the A/B protocol

`gitView` collapses the hunks of generated/lockfile paths in a `git diff`/`git show` to a `+adds/-dels` summary,
keeping real-source hunks. It ships **OFF**; this A/B is the gate, read off `tokenbrake report --backfire` (the
`gitview` byKind count and its backfires). Both arms differ only by the step-0 config write. This is the
**frequency** play: the backfire question is whether collapsing a lockfile diff sends the model back to Read the
saved full diff.

**The task (paste verbatim; step 0 is the only difference between arms).** It builds a scratch git repo under
`/tmp`, so it is fully reversible and repeatable:

```
Git-diff A/B task. Do every step with tools, in order, autonomously (do not ask questions). At the end write the final answer in step 6.

0. Arm A: run  mkdir -p ~/.claude && printf '{"gitView": false}' > ~/.claude/tokenbrake.json
   Arm B: run  mkdir -p ~/.claude && printf '{"gitView": true}'  > ~/.claude/tokenbrake.json
1. Run  rm -rf /tmp/gitwork && mkdir -p /tmp/gitwork/src && git -C /tmp/gitwork init -q && git -C /tmp/gitwork config user.email a@example.com && git -C /tmp/gitwork config user.name tester
2. Create and commit the initial files:
   node -e "let d={};for(let i=0;i<120;i++)d['pkg-'+i]={version:'1.0.'+i,resolved:'https://reg/pkg-'+i};d['lodash']={version:'4.17.20',resolved:'https://reg/lodash'};require('fs').writeFileSync('/tmp/gitwork/package-lock.json',JSON.stringify({name:'app',lockfileVersion:3,packages:d},null,2))"
   node -e "require('fs').writeFileSync('/tmp/gitwork/src/app.js','function total(items){\n  return items.reduce((a,b)=>a+b,0);\n}\nmodule.exports={total};\n')"
   git -C /tmp/gitwork add -A && git -C /tmp/gitwork commit -q -m init
3. Modify both files:
   node -e "let p=require('/tmp/gitwork/package-lock.json');for(let i=0;i<120;i++)p.packages['pkg-'+i].version='1.1.'+i;p.packages['lodash'].version='4.17.21';require('fs').writeFileSync('/tmp/gitwork/package-lock.json',JSON.stringify(p,null,2))"
   node -e "let s=require('fs').readFileSync('/tmp/gitwork/src/app.js','utf8').replace('a+b','a+b+0');require('fs').writeFileSync('/tmp/gitwork/src/app.js',s)"
4. Run  git -C /tmp/gitwork diff   and read the result.
5. Answer BOTH from what you have: (a) what changed in src/app.js; (b) the NEW version of the "lodash" dependency in package-lock.json. State honestly how you obtained EACH -- especially whether getting (b) meant re-reading a saved tokenbrake out/ file or running `tokenbrake show` (a backfire) versus a grep/read of the original file or a fresh targeted git diff (not a backfire).
6. Run `node cli.js report --backfire` in the tokenbrake repo checkout and paste its full output verbatim, then `cat ~/.claude/tokenbrake.json`.

Final answer: whether the package-lock.json hunk was collapsed (you will see a "[tokenbrake] ... diff collapsed" note), how you got (a) and (b), and the pasted outputs of step 6.
```

**What the comparison reads.** Arm B's `report --backfire`: the `Withholds` byKind shows `1 gitview` (the one
`git diff`), and the backfire count says whether getting the collapsed lockfile detail sent the model to Read
the saved diff. Getting (b) via `grep lodash` / a fresh `git diff package-lock.json` on the original repo is
NOT a pull-back (it doesn't read the `out/` file) -- the sanctioned path. Arm A is the baseline: with `gitView`
off the whole diff (including the lockfile hunk) enters and is carried.

**Decision rule, fixed before the run.** Flip the default to `gitView: true` only if the gitview backfire rate
is low **and** arm B carries meaningfully fewer read token-reads than arm A. Burden of proof on the flip.

### Result — ON arm, 2026-09-14 (Opus, spawned session): INCONCLUSIVE — a second guard co-fired

The ON-arm run exposed a **methodology bug in the cloud A/B environment**, not a gitview result. The
environment carries a **stale global tokenbrake install** at `/root/.claude/hooks/tokenbrake/guard.js`,
registered on PostToolUse at **user scope** — a much older version (it has none of the `gitView`/`blobElide`/
`reReadElide`/`readAfterEdit`/`dedup`/`mcpTrim` knobs). Claude Code merges user-scope and project-scope hooks,
so **every tool result fired the guard twice**: the project-scope feature guard AND the old global guard, ~10–34
ms apart with the same `tool_use_id`.

For the `git diff` (15,124 chars) the ledger shows the pair:

```
{... "gitview":true, "kept":563,  "chars":15124 ...}   # project guard: narrowing-4 collapse (+121/-121, correct)
{...                 "kept":2113, "chars":15124 ...}   # old global guard: generic middle-trim (delivered last)
```

The gitview collapse **fired and is correct** (confirmed in the ledger and by the session reproducing it
offline: `[tokenbrake] +121/-121 lines, diff collapsed (generated/lockfile path)`, `src/app.js` kept verbatim),
but the old guard's generic middle-trim won the delivered output, so gitview **never reached the model's
context**. `report --backfire` therefore recorded `2 trim` (0% backfire, ~130k token-reads saved) — the *old
guard's* trim, not gitview. The model answered both step-5 questions (the `src/app.js` change and lodash
`4.17.21`) from the fresh diff without any pull-back, but that reflects the generic trim, not the collapse.

**This retroactively taints the earlier cloud A/Bs too** (Read-After-Edit, re-read, blob): the same two guards
were racing. The blob run happened to show `2 blob` (the project guard won that race), but the measurement was
never clean. **Fix for any future cloud A/B:** neutralize the user-scope guard first (remove or disable
`/root/.claude/settings.json`'s PostToolUse tokenbrake hook, or delete `/root/.claude/hooks/tokenbrake/guard.js`)
so only the checkout's project guard fires — then re-run.

**Real-world corollary (worth a product safeguard):** a machine with BOTH a global and a project tokenbrake
install double-fires, and an older global guard can silently override a newer project narrowing. The two guards
each receive the *original* tool output (not chained), so the existing `[tokenbrake]` marker does not protect
against it. Candidate fixes: the installer detecting/warning on a co-registered guard, or a documented
"one scope only" rule.

**Status:** gitView is **logic-verified** (519 checks + the offline reproduction) but its organic backfire is
**unmeasured**; it stays OFF/opt-in like the others until a clean single-guard A/B runs.

**Clean re-run attempt (2026-09-14): blocked by the environment, not run.** A second spawned session added a
step 0 that empties the stale global guard's script so only the project guard delivers. It stalled on a
permission prompt: an autonomous session in `auto` mode won't self-approve writing under `/root/.claude` plus
an `rm -rf`, and a parent cannot approve a child's prompt or grant a child a more permissive mode. So a clean
single-guard organic A/B needs a **human-supervised** session (to approve those prompts) or a pre-cleaned
environment (no user-scope tokenbrake install). Given the collapse is deterministic and already verified, and
the backfire is highly likely ~0% (the blob run showed models fetch a specific value with a targeted grep, not
a whole re-read), the organic number is low-value for an OFF feature. **gitView ships OFF / opt-in on its tests
+ offline verification — the same standing as narrowings 1–3**, none of which cleared the flip bar either. The
double-guard finding above is the more useful takeaway and is the thing to fix before any narrowing's default
can be trusted to move.

**Third attempt (2026-09-14): the wall is structural, confirmed.** A follow-up tried to neutralize the old
guard with NO `/root/.claude` write and NO `rm` -- just `maxChars: 999999` in the run config, so the old guard
(which trims only above `maxChars`) passes the diff through while the project guard's gitview fires before the
size check. But writing `~/.claude/tokenbrake.json` was itself denied by the auto-mode classifier as
**[Self-Modification]** (it changes a registered hook's runtime behavior), and the session correctly declined
to route around the denial -- so the config never landed, the old guard trimmed the diff, and `report
--backfire` again read `2 trim`, 0 backfires. **An autonomous auto-mode session cannot cleanly neutralize the
co-firing global guard**: every method (empty the guard file, or change `maxChars`) is a hook-behavior change
the permission system blocks, and dodging it by reframing would be gaming a safety guardrail. A clean organic
gitview A/B therefore needs one of: (a) the stale global tokenbrake install removed from environment
`env_01Hscqvejiu7QKDj3pTeRTYB` -- a claude.ai environment-settings change that ALSO fixes the double-guard bug
for good; (b) a human-supervised session that approves the `~/.claude` write; or (c) pre-session provisioning of
`tokenbrake.json`. Until one of those, **gitView stays OFF / opt-in** on its tests + offline verification. On
all evidence the organic number is ~0% backfire, same as blob.

### Result — ON arm, 2026-09-14, CLEAN (env fixed): 1 gitview, 0 backfired (0%)

The environment's stale global install was removed at its source (a
`tokenbrake init || true` line in the env setup script, deleted by the owner), so a
fresh session now runs the **project guard only** — the double-fire is gone for
good. `node cli.js status` in the run confirmed it: *"installed at project scope
instead ... the guard runs once, from there."* With that, a plain ON-arm run
(just `{"gitView": true}`, no neutralize) delivered the **gitview collapse** to
the model — `[tokenbrake] +121/-121 lines, diff collapsed (generated/lockfile
path)`, `src/app.js` kept verbatim. `report --backfire`:

```
Withholds: 1 (1 gitview) -- ~ 3,640 tokens kept out, ~ 10,920 token-reads not carried
Pulled back: none of the 1 withholds was read back -- backfire rate 0%
Net: ~ 10,920 token-reads saved after backfires   (10,920 saved - 0 pulled back)
Verdict: too few withholds to call it (need a few)
```

**1 fired, 0 backfired (0%), ~10.9k token-reads saved.** The per-firing net is
clean and telling: to get the collapsed lockfile's `lodash` version the model ran
a **targeted `git diff -- package-lock.json | grep lodash`** (and grepped the
working tree) — a fresh re-derivation from source, NOT a Read of the saved `out/`
file and NOT `tokenbrake show`. That is exactly the cheap path the collapse leaves
open, and the reason a collapsed generated diff does not send the model back for
the whole thing.

**Decision: default stays OFF / opt-in.** As with narrowings 1-3 the backfire is
low (0%) and the saving real (~10.9k token-reads), but the verdict is *too few to
call it* at n = 1 and the diff was forced by the task, so the organic firing RATE
is unmeasured. It ships a **recommended opt-in** (`gitView: true`). The lasting
win of this run is the environment fix: **the double-guard bug is resolved**, so
every future A/B here reads clean.

## Measurement epoch — `eee95d1`, 2026-09-17: the classifier moved and the trim's ceiling was wrong

Not a run. This records a commit that changes what the guard does, so numbers
taken on either side of it are not the same experiment. Two things moved.

**The excerpt/trim split moved.** The classifier's operand slots now reject an
option and an unquoted glob, and the recursive/list-only grep exclusion scans the
whole option cluster instead of its first letter. Before it, `grep -rn` was caught
but `grep -nr`, `grep -ir`, `grep -vl` were not — the same searches typed in the
other order kept the single-file exemption and passed their whole multi-file
result through: **36,469 characters, whole, per call**, measured. `cat *.log` did
the same for however many files the glob matched. So a ledger comparison spanning
this commit mixes two classifiers, and the ON arm of any older pair exempted
commands this one trims. `[` and `]` stay allowed on purpose (route segments like
`app/[id]/page.tsx` are far commoner than a bracket glob); only `*` and `?` mark
"possibly many files".

**The trim was emitting past the hook output ceiling.** `trimText` measured the
trimmed TEXT against the 10,000-char limit, but the limit applies to the emitted
JSON, and escaping costs a character per quote, backslash and newline. Swept by
line width on quote-dense output: 50 chars emitted 8,715 (fine), **75 emitted
11,788, 400 emitted 16,446** — past the ceiling, where Claude Code drops the
`updatedToolOutput` silently and the FULL untrimmed result enters context. The
guard would have logged a trim that never happened.

**What this does and does not invalidate.** It does not inflate any saving
recorded here. `trimSavings` counts a result only when it carries the
`[tokenbrake]` marker in the transcript *and* matches a ledger row — a dropped
emission has no marker, so it was never counted as saved. The exposure is the
other way round: a dropped emission is an ON-arm result that entered whole while
the ledger said otherwise, which would show up as unexplained carried, not as
overstated savings.

Scanned every session on this machine for it: **102 trims emitted across 12
sessions, 32 confirmed landed, 0 confirmed dropped, 62 unmatched.** Eight results
initially looked dropped and are not — each delivered ~2,100 characters, *less*
than the guard's own kept size (5,575–8,484), which is Claude Code's persisted-
output preview replacing an oversized result, not a rejected emission. The
delivered size is the tell: below the ledger's `kept` means the host spilled it,
at the original size means the emission was refused. So there is **no observed
instance of this bug in the recorded data**, which fits the shape of the
trigger — it needs quote- or backslash-dense output at line width 75+, and build
and test logs are neither.

**The file-excerpt cap is a separate case and affects nothing recorded.** It
skipped the ceiling fold entirely (15–40 KB emissions), but it has never fired:
of **554 real ledger rows, 21 were classified as excerpts and 0 were capped**,
because `readMaxBytes` (60,000) sits above Claude Code's own ~30,000-character
shell ceiling — the largest shell result ever recorded here is 29,878. What kept
it dormant was a threshold, not the code.

**That last point is the live one for this page.** `scripts/sweep-readmax.mjs`
and `tune` both recommend lowering `readMaxBytes`, and any value under ~30,000
brings that branch into reach. Taken before `eee95d1`, such a recommendation
would have woken a silent-drop path with no evidence trail. **The sweep's
sub-30,000 rows are only valid against the post-fix guard; re-run them before
acting on one.**

**How to audit a past session for it.** `report --top` already marks a result
`[trim not applied]` when a ledger row exists and the transcript result carries no
marker. That is the signal; compare the delivered size against the row's `kept` to
tell a host spill from a refused emission.

No default changed and no flag was added — both fixes restore behaviour the code
already documented, and the excerpt fix is a no-op at shipped defaults. 641 checks.

## Measurement epoch — the backfire audit now counts piped shell pull-backs, 2026-09-17

Not a run, and not a guard change — this one moves the AUDIT, not what enters
context. The backfire auditor's recovery detection scored a pull-back only when
the withheld out/ file was read back through the Read tool, through `tokenbrake
show`, or through a shell read shape `EXCERPT_CMD` recognises (a bare cat /
`sed -n 'N,Mp'` / head / tail / non-recursive grep, which populate `file`). A read
through a PIPED or compound shell command — `sed ... | head`, `cat ... | tail`, a
recursive grep — carries the out/ path only in the command text and went
uncounted. Since the harness pages a file with sed/grep by default, that was the
common way a withheld output comes back, so the audit undercounted pull-backs and
overstated net.

Measured live on this machine: an 8,273 → 4,892 char withhold, then ~3,513 chars
pulled back through `sed` on the out/ file, reported as "clean — backfire rate
0%". Roughly a wash, plausibly net negative, booked as a clean saving.

**What this invalidates.** Only the backfire audit's verdict and net, not any
saving. `trimSavings` and `savedCarried` are unchanged. What moves is
`recoveredCarried` (up, as real pull-backs are now netted) and therefore `net`
(down) and the `clean` / `net positive` / `backfired` verdict. So a backfire
verdict taken before this fix is only a lower bound on pull-backs: **re-run
`report --backfire` / `tune` over the SAME ledger post-fix before acting on a
"clean".** Because this page gates default-flips on measured net, an old "clean"
is not evidence a feature did not backfire — it is evidence no pull-back was
SEEN, and the seen set just widened.

**What it still does not reach.** The match keys on the out/ path being NAMED, so
it over-counts a rare non-read reference (`rm`/`echo` of the path) — the cautious
direction — reads the first out/ path in a command, and leaves a Grep TOOL call's
`path` input uncounted; all optimistic residuals, so a clean result still means
"none seen", not "none happened".

No default changed and no flag was added — a report reads the ledger, it does not
touch what the guard withholds. tests +4 (639 → 643).

## Measurement epoch — the harness previews Bash output, so the ledger's `saved` overstates CONTEXT saving above ~2 KB, 2026-09-17

Not a run and not a guard change — this moves how we READ the ledger's savings on
the shell path, after a live blobElide measurement (single user-scope install,
guard `613517357d15`) exposed the mechanism.

**The observation.** `cat` of a 71,473-byte minified bundle, the same file, twice:

| | blobElide on | base trim only (blobElide + dedup off) |
|---|---|---|
| chars the guard SAW | 30,046 | 30,046 |
| kept | 395 | 6,158 |
| branch | `blob` | base shell trim (maxChars char-cut) |
| what reached CONTEXT | the full 395-char descriptor | ~2 KB of raw minified head — identical to no guard |

Two facts fall out. (1) **The guard never sees the whole file.** `chars` is 30,046
against 71,473 bytes both times: the harness caps the Bash payload handed to the
PostToolUse hook at ~30 K (the ceiling `guard.js` already notes) and persists the
raw output to its own tool-results file. Every shell-path saving on this page is
measured against that pre-truncated stream, not the original. (2) **The harness
also previews the FINAL (post-guard) tool result to ~2 KB in context** and keeps
the rest in the persisted file. The 6,158-char base trim showed in context as the
same ~2 KB of minified head as no guard at all — invisible. blobElide's 395-char
descriptor showed in full only because it is UNDER that ~2 KB floor.

**The corrected blobElide figure.** The ledger books `saved = chars − kept =
30,046 − 395 = 29,651 chars ≈ 7,413 tokens`. That is the guard's OUTPUT reduction,
not its context reduction. What actually leaves context per call is bounded by the
~2 KB preview floor (~512 tokens): no-guard and base-trim both spend ~512 tokens
(previewed), blobElide spends ~99 (395 chars, under the floor). So blobElide's real
per-call context saving is ~512 − 99 ≈ **~400 tokens** (compounding per carried
turn), and the ledger `saved` overstates it by ~18×. blobElide's edge over the base
trim is not the 15.6× output ratio — it is that it is the only shaper that gets
UNDER the preview floor at all, swapping ~2 KB of unreadable minified head for a
readable "withheld ~29 KB, saved to <path>" descriptor. A real but modest win, and
largely qualitative (readable vs raw bytes) rather than a big token cut.

**The question to resolve for brake 1.** If the harness previews any Bash result
above ~2 KB, the always-on base shell trim also buys little IN CONTEXT for large
Bash output: the harness would have previewed the raw output to ~2 KB anyway, and a
trim that stays above the floor is invisible (run 2). A shell trim wins in context
only when it (a) gets UNDER the floor, or (b) makes the visible ~2 KB more useful
than the raw head — head/tail/flagged lines on a MULTI-line log, not a one-line
blob. So where do the pooled brake-1 savings on this page actually come from — the
**Bash trim**, or the **Read cap**? The Read cap (`readMaxBytes`, the "65 KB →
60,359 chars" case) is a different path with no 2 KB preview: a capped Read
genuinely keeps bytes out of context. Hypothesis to confirm before trusting the
Bash side of the headline number: **brake 1's real context value in this harness
lives mostly in Read-capping; the Bash trim's context win is largely subsumed by
the harness preview except for under-floor cases like blobElide.** Resolve it by
splitting a pooled `report --compare` result by tool — Read-path vs Bash-path
carried tokens — rather than reading one blended saving.

**Caveats.** (1) The ~2 KB preview is THIS harness/surface's Bash-output handling
(cloud, Claude Code as run here); another surface may inject full Bash output,
where the trim's context saving is real — a per-surface fact, not a universal one,
so a `--compare` should record the surface. (2) n is tiny (one file, two runs); the
MECHANISM is what this epoch records, not a rate. No default changed, no flag added
— this is how to READ the ledger on the shell path, not what the guard withholds.

## Amendment: the third condition, in tokens — 2026-09-18

Every decision rule above that gates a result carries a third, safety condition, written as "cost not worse":
the brake must not save entered tokens while the session as a whole gets heavier. Those rules are quoted as they
were pre-registered and are never rewritten after their run. From 2026-09-18 tokenbrake states everything in
tokens, never money, so **every round pre-registered after this date writes that condition as: tokens carried
(size x the later requests that re-read it) not worse on the on-arm by more than the band two identical OFF/OFF
arms have produced** -- 42.6% on tokens entered on the natural task above, or the round's own control pair where
it has one.

Carried, not cost, and deliberately: ab10 found the damage lands in carried -- a trim that sends the model back
lengthens the session and carried climbs past where it started -- which is exactly what the cost condition was
there to catch. One thing the swap gives up: cost weighted output and cache writes more heavily than cache reads,
and a single token total weights them equally. A round whose risk is in output or cache writes names that count
as its own fourth condition rather than folding it into carried.

## Calibration: what each kind of token weighs against the five-hour limit — pre-registered 2026-09-18, before any of it is run

**Why this comes before the brake.** The goal set on 2026-09-18 is a brake worth 8-10, and the candidates are
aimed at different kinds of token. The entry trim cuts tool results entering context. A *duration* brake
(compact or clear before stale context gets re-read hundreds of times) cuts **cache reads**. A *cold-cache*
brake (don't resend a large context after the cache has expired) cuts **cache writes**. Which one to build
first depends on what each kind weighs against the limit people actually hit, and nobody has published that
for subscriptions. The amendment above names the gap: a single token total weighs every kind equally.

**What is known before the run.**
- API token accounting (platform docs, prompt caching): a cache read weighs 0.1x base input (0.025x on Fable
  5.1), a 5-minute cache write 1.25x, a 1-hour write 2x. Whether the subscription limit uses the same weights
  is not documented.
- Claude Code's cost docs: a long session "re-reads that history at the cached token rate, so a one-line
  question in a session that has been open all day still draws usage for the whole conversation"; the cache
  lives 1 hour on a subscription; the first message after a longer break "reprocesses your full context";
  `/compact` "is itself a large request"; `/clear` costs nothing. On Pro and Max, resuming a large session
  after a long break **offers to resume from a summary**, and Claude Code clears old tool results from context
  by itself. Both are built-in versions of brakes we would build, so the brake has to beat them, not a bare
  session.
- Our own record: the 689k Start-fresh card (HANDOFF, twenty-second card) — five messages in a 689k session
  drew 9% of the five-hour window, the same five after Start fresh drew 3%; the brake's A/B above cut cache
  reads 41% and moved the window +9 → +8. Both confirm cache reads count at a discount; neither separates the
  weights, because every arm moved reads, writes, output and requests together at 1% meter resolution.

### Design — one variable per block

Every block is a run of identical messages in one session: **"Reply with the single word ok. Use no tools."**
Opus 5, effort low, for the whole calibration (the weights are per model; a Fable run repeats the calibration
later and is not mixed with this one). Each block varies one thing — how much context is re-read, or whether
the cache is warm — so each kind of token gets its weight from the difference between blocks, not from a
regression over tangled arms.

| block | session | messages | what it isolates |
|---|---|---|---|
| B0 | fresh | 20 | the floor: system prompt + tools + tiny output, per message |
| B1 | ~250k context, warm | 20 | cache reads at 250k |
| B2 | ~600k context, warm | 20 | cache reads at 600k; (B2 − B1) ÷ (R2 − R1) is the **cache-read weight** |
| B3 | the B2 session, idle > 65 min | 1, three times on separate idles | one full rewrite of ~600k: the **cache-write weight** |
| B4 | the B2 session: `/compact`, then 20 messages | 1 + 20 | what compaction costs, and what it saves per message afterwards |
| B5 | fresh | 5, each "write about 2,000 words on any topic, no tools" | the **output weight** |

Contexts are built before the block's first meter reading (reading files into the session is the cheapest
way), so the building never counts toward the block. Build size is whatever the session reports; the design
needs R2 at least twice R1, not the round numbers.

### Procedure, per block

1. Settings → Usage: five-hour %, weekly all models %, weekly Opus %, and the time. Note when the five-hour
   window resets; a block whose readings straddle a reset is void.
2. Send the block's messages, nothing else. Nothing else runs anywhere on the account in between: no other
   session, no claude.ai chat, no scheduled task, loop, goal check-in or cross-session message.
3. Read the usage page again and record the same numbers.
4. Token counts come from the session transcript: `usage` summed over exactly the block's requests (input,
   cache read, cache write split into 5-minute and 1-hour where the transcript has the split, output).
5. B3 and B4 also record what Claude Code offered and did: whether it offered to resume from a summary (B3
   declines, and notes that it was offered), and whether it cleared tool results or auto-compacted on its own
   (either voids that block; rerun it).

**Resolution rule.** A block counts only if it moves the five-hour window by **at least 5 points**, so 1%
resolution means ±20% or better. A block that moves less is repeated with twice the messages, up to 80, in a
fresh window. A block that cannot reach 5 points at 80 messages is recorded as "below resolution", and that is
itself a result: that kind of token is too light to matter.

### The rule, fixed before the numbers

Let **a**, **w** and **o** be the measured points of the five-hour window per million cache-read, cache-write
and output tokens. Apply them to every session in the owner's pooled sessions (the pool `--reach` uses): each
session's draw splits into a cache-read share, a cache-write share (the part caused by misses and cold rebuilds
counted apart) and an output share.

- **Cache reads ≥ 50% of weighted draw** → the duration brake is built first. The carry is the draw.
- **Cold rebuilds and misses ≥ 25% of weighted draw** → the cold-cache brake is built first, or alongside the
  duration brake if both hold. It has to do better than Claude Code's own resume-from-summary offer, which B3
  records.
- **Output ≥ 50% of weighted draw** → neither brake is the headline, and the entry trim isn't either, because
  none of them touch output. Recorded as written, and the 8-10 plan is reopened.
- **Compaction payback** from B4: requests to recover = compaction's own draw ÷ (per-message draw at 600k −
  per-message draw after compacting). **≤ 20 requests** → the duration brake is viable for any session with
  that many requests left. **> 100** → the duration brake is dead as designed; the only duration lever left is
  `/clear`, which is the user's call, not a brake.
- **Does the subscription weigh tokens like the API?** Measured w ÷ a against the API's 20 (2x ÷ 0.1x, 1-hour
  cache, Opus). Within a factor of 2 → the report may weight carried tokens with the API multipliers from then
  on, citing this calibration. Outside it → the report uses the measured weights, per model, and says so.

Void conditions, each voiding that block only: other usage in the window, a reset inside the block, a different
model or effort, tool use in a block that says no tools, auto-compaction or tool-result clearing outside B4.

**Cost of the run, stated in advance.** About 90 short messages, 5 long ones and three idle waits of over an
hour, spread over as many five-hour windows as the resolution rule needs. It is paid out of the owner's own
limit, which is the point: that is the meter being calibrated.

### Calibration results — run 2026-09-18 21:07 to 2026-09-19 01:44 UTC, Opus 5, effort low, Claude Code 2.1.277

**How it was run, and where it departed from the protocol.** Every block was driven headless by
`scripts/calibrate.mjs`: one `claude -p` per message, one row per message in `calib.jsonl`. The meter is the
`rate_limit_event` a headless run emits, `unifiedWindows.five_hour.utilization`. It has the same whole-point
resolution as the usage page, but it gives a reading after every message. Deviations, all decided before the
numbers they affect were read:

- **The meter lags.** A message's own reading doesn't include that message yet: each B3 cold message read the
  same as the probe just before it, and its cost appeared at the next probe. Every figure below compares
  readings across a span, never one message.
- **B1 landed at 430k, not 250k.** `--build` targets chars/4 and the repo text is denser (411k tokens). R2 ≥ 2R1
  would then need ~900k, too close to the window, so **B2 was skipped**. Its only job was to give the read
  weight as a slope, and the long block at 430k measures it directly: the per-message floor (B0) is under 10%
  of a 430k message.
- **B1 was below resolution** (2 points), so per the rule it was repeated with 40 messages on the same warm
  session. The read weight comes from that repeat alone: its span starts after the build's two writes, which
  the meter lag makes ambiguous at B1's own start.
- **B5 ran 40 replies of about 4,000 words** instead of 5 of 2,000, because 5 × 2,000 words would have moved the
  meter under a point. They ran in one session, so its reads and writes are subtracted with the weights below.
- **B3 had a probe before each cold message**: one tiny message in a throwaway fresh session, so the cold session
  stayed cold.
- **Headless `/compact` reports no usage for the compaction request** (neither the result nor the transcript
  carries it), so its draw comes from the meter as a bound, not a count.
- **Contamination, from the transcripts of every session on this machine:** no other project or chat made a
  request during any block. This session did, a few seconds' overlap at the edges of B0, B1 and B5 (under 0.1
  point each), and **one that matters**: at 01:41:05 it came back from 4.5 hours idle and rewrote its own expired
  cache, 164,583 tokens (≈1.5 points), inside B3's third span. That span is corrected for it below.

| block | messages | cache read | cache write | output | five-hour | what it gives |
|---|---|---|---|---|---|---|
| B0 fresh | 21 | 0.76M | 50k | 84 | 20 → 21 | floor; below resolution (1 point) |
| B1 build, 2 writes | 2 | 34k | 0.82M | 8 | 21 → 28 | the first message after the build missed the cache and rewrote all of it |
| B1 after the build, at 430k | 19 | 8.2M | 11k | 76 | 28 → 30 | consistent; below resolution alone |
| B1 repeat at 430k | 41 | 18.2M | 38k | 164 | 30 → 34 | **cache read** |
| B5 long replies | 41 | 8.7M | 376k | 342k | 34 → 51 | **output**, after subtracting its reads and writes |
| B3 cold ×3 | 3 + 3 probes | 98k | 1.35M | 24 | 0 → 13 | **cache write (1 hour)**; the third span minus this session's 1.5 |
| B4 compact + 20 | 1 + 21 | 1.23M | 50k | 84 | 13 → 14 | compaction bound |

**Weights, in points of the five-hour window per million tokens (Opus 5):**

| | weight | range from the 1-point quantisation | per base-input token, relative to a cache read |
|---|---|---|---|
| cache read | **0.20** | 0.15 – 0.26 | 1 |
| cache write, 1-hour | **8.9** | 7.8 – 10.0 | **45** (the API says 20) |
| output | **34** | 30 – 38 | **170** (the API says 50) |

**Compaction.** At 455k, `/compact` took the session to about 40k (the headless floor plus the summary).
Compaction plus the 20 messages after it moved the meter 1 point, so under 2. The 20 messages account for
about 0.4 of that, which bounds compaction's own draw at 1.6 points (estimate ≈0.5: a cached read of 455k, a
summary's output, a ~20k write). Each message at 455k draws ≈0.1 point, and one at 40k ≈0.01, so compaction
pays for itself in **≈6 requests, 18 at the bound**. Caveat: these are "ok" messages. On real work a compacted
session re-reads what it needs, which the calibration does not capture.

**The owner's pool with those weights** (`scripts/calibrate-pool.mjs`: 123 transcripts including subagents, 3,161
requests; benchmark and calibration sessions excluded; a cold rebuild is a write of 20k or more after an idle
of over 60 minutes, a miss/rebuild is a write of 20k or more that exceeds that request's cache read):

| share of weighted draw | point estimate | across the weight ranges |
|---|---|---|
| cache reads (the carry) | **38.2%** | 30.0 – 46.7% |
| cache writes, normal (content entering) | **32.7%** | — |
| cache writes, cold rebuilds + misses | **8.1%** (5 cold, 6 misses) | 6.7 – 9.6% |
| all cache writes | **40.8%** | 33.6 – 48.1% |
| output | **20.9%** | 18.9 – 22.8% |

### The rules, applied as written

- **Cache reads ≥ 50%?** No: 38.2%, and 46.7% at the most favourable end. *The duration brake is not built
  first.*
- **Cold rebuilds and misses ≥ 25%?** No: 8.1%. *The cold-cache brake is not built first.*
- **Output ≥ 50%?** No: 20.9%. *The plan isn't reopened on output grounds.*
- **Compaction payback ≤ 20 requests?** Yes: ≈6, 18 at the bound. *The duration brake is viable.*
- **Subscription weights like the API's?** w ÷ a = 45 (30–67) against the API's 20: outside a factor of 2 at
  the point estimate. *The report uses the measured weights, per model, and says so.* Output is heavier still
  (170 cache reads against the API's 50).

**What the rules did not anticipate, and so decide nothing about.** No kind of token is a majority. The draw splits
about **40 / 40 / 20** between re-reading context, writing content into it, and output. The largest category the
rules were not written for is ordinary cache writes, 33%: content entering context. That is exactly what the entry
trim acts on, and the carried metric undercounts it. A token entering context costs about 45 re-reads of itself
before the carry catches up. A result carried fewer than ~45 requests draws more from its write than from its
reads. Choosing the brake from here is a new decision, taken in discussion with these numbers, not read off a rule
that didn't foresee them.

**Limits of this calibration.** One model (Opus 5) at effort low, driven headless. The pool mixes models, and
Fable weighs differently, so the shares are Opus-weighted. The miss classification is a heuristic, not Claude
Code's own miss count. Compaction's own draw is a bound, not a count.

## An earlier compaction window, and whether the work survives it — pre-registered 2026-09-19, before anything is built or run

**The lever.** Claude Code's `autoCompactWindow` (user setting, `/autocompact`, `--autocompact`, or
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`; 100k to 1M) sets when a session compacts itself. On Opus 5 with the 1M context
the default is about 967k, so a long session re-reads a growing context for hundreds of requests and never
compacts. Replaying the owner's 123 transcripts with the calibrated weights (`scripts/compact-replay.mjs`, 50k
after compaction, 7k summary) puts the net saving of a **300k window at 16.2% of all weighted draw** (14.3% with an
80k post-compaction context and a 20k summary), from 5 compactions. It is concentrated: the 3 sessions that ever
passed 300k are 46% of the owner's whole draw. A `/clear` at every break, assuming the owner always agrees, comes
to 17-18%, so a notice asking the user reaches no further than the setting. It stays a possible upgrade for
quality, not the core.

**Why this is not a paired total-token A/B.** The saving is mechanical: once a session compacts, every later request
re-reads less, and the replay prices that exactly. The only uncertain part is behavioural: after compacting, does
the model re-read what it lost, take extra steps, or get things wrong. A paired A/B on session totals would bury that
under the 42.6% OFF/OFF band, and the effect lives only in long sessions, where each pair costs most of a five-hour
window. So the claim is split: **the saving from the replay, the behavioural cost measured directly** in two
stages, and the cost is subtracted from the saving.

**What gets built first, default-off, before either stage runs:**
- **The preparation step.** A `SessionStart` hook matching `compact` that injects the working set after a
  compaction, as pointers only, never file contents, capped at 2,000 tokens: the files edited this session (path
  and the line ranges touched), the files read (path and range), the last failing command with its first error
  line, and the first 300 characters of the session's first user message. The documented pattern for re-injecting
  context after compaction; it runs only when the owner turns it on.
- **`report --compactions`.** For every compaction a transcript records (`compact_boundary`, trigger `auto`): the
  context before and after, the saving the replay model predicts from there to the end of the session, and the
  **recovery**: every file read in the 30 requests after the boundary that was already read before it in the same
  session, its tokens entered, priced as a write plus its re-reads until the session ends. Compaction's own draw is
  not in any transcript, so it is charged at the calibration's estimate, 0.5 points, and at its bound, 1.6, both
  shown.

### Stage 1 — controlled, three arms, scaled down

A scripted task on a fixture copy of this repository at a pinned commit, Opus 5, effort as the owner runs it,
driven headless, two messages per session:

1. **Message 1 (before).** Read five named files in full and a sixth by range, which grows the context past
   200k. Run a seeded failing command and note its first error line. Make one seeded edit (a named constant
   changed). Pick one of two named options and give the reason in one sentence.
2. **Message 2 (after).** Ten questions with exact answers. Five are **recall probes** on message 1: the error
   line, the constant's old and new value, the option picked, the line count of one of the five files, the range
   of the sixth. Five are **fresh**: they need files message 1 never touched, as a control on plain correctness.

| arm | window | preparation step | runs |
|---|---|---|---|
| OFF | default (~967k) | off | 3 |
| ON | 150k (`CLAUDE_CODE_AUTO_COMPACT_WINDOW=150000`) | off | 3 |
| ON+PREP | 150k | on | 3 |

The window is scaled down so that each run costs a few points instead of most of a window; the mechanism, a
compaction between what was learned and when it is needed, is the same. Three OFF runs also give this task's own
OFF/OFF spread. **Step 0, a pilot, void by design:** one ON run to confirm that a compaction actually fires between
the two messages. If it fires in the middle of message 1 instead, the task is resized before any counted run.

**Measured per run:** correct answers out of 10 (recall 5, fresh 5), recovery reads after the compaction and their
priced tokens, requests in message 2, and total weighted draw (transcript usage × the calibrated weights).

**Stage 1 passes when, fixed now:**
- **Correct:** each ON arm's median score is at least the OFF median minus 1 (out of 10), and the fresh five
  never score lower than in OFF. A lower fresh score means something other than lost context broke.
- **Remembers:** ON+PREP answers **all five recall probes correctly in all three runs**. That is the preparation
  step's whole job; one miss fails it.
- **Doesn't claw it back:** recorded, and decisive only if it is clear. The ON+PREP median draw is compared with the
  OFF median. If the OFF runs' own spread is larger than the difference, stage 1 says nothing on cost, and stage 2
  decides.

If ON fails "correct" and ON+PREP passes, the preparation step is mandatory with any lowered window. If both fail,
the window lever is dead as designed and the plan returns to discussion.

### Stage 2 — the owner's real work, at 300k

The owner sets `/autocompact 300k` and turns the preparation step on, and works as usual on Opus 5. Stage 2 runs
until **8 automatic compactions** are recorded, however long that takes. At the owner's history (5 in the whole
pool at 300k), that could be weeks. Manual `/compact`, other models, and sessions under `tokenbrake-bench` or a
calibration directory don't count.

**Measured per compaction, by `report --compactions`:** predicted saving, recovery cost, compaction's own charge.
Any compaction after which the work felt worse to the owner is written down the same day with one line, and it
counts. It doesn't need a number.

**Stage 2 passes when:** across the 8 compactions, recovery cost plus compaction charges (at the 1.6 bound) is
**under half the predicted saving**. If it passes at the 0.5 estimate but not at the 1.6 bound, the verdict
states both and the default stays off. **And** the owner has logged no more than one "felt worse", and none of
them is attributed to a lost fact the preparation step should have carried.

### The flip

The 300k window with the preparation step becomes tokenbrake's default (`init` writes `autoCompactWindow`,
`uninstall` removes it, `status` shows it) **only if both stages pass**. Until then both ship off, exactly as
`CLAUDE.md` requires for anything that changes what enters context. A failed stage is recorded as it falls, with
the numbers, and is not re-run with a looser rule.

### Amendment after the stage 1 pilot — 2026-09-19, before any counted run

The pilot (ON arm, 150k window, session `d3bd6db9`, about 3 points of the five-hour window) was void by design, and
it found two things wrong with the task as written. Neither is a result about compaction.

- **The compaction fired inside message 1, twice, not between the messages.** The first fired at 183,558 tokens,
  not 150,000, because one batch of parallel reads carried the context past the window in a single step; the
  compaction kept the recent segment and landed at 101,670. The second fired at 205,325 and landed at 24,444.
  Both came after the facts steps and before message 2. So the mechanism under test held (a compaction between
  learning a fact and needing it), just not at the point the protocol named.
- **The recall probes could be answered without the model remembering anything.** Message 1 ended by echoing
  the error line and the option chosen, and that reply came after both compactions. The old and new values of
  the constant, and the line range, were written in the task prompt, which the compaction summary keeps. The
  pilot's 10 of 10 without the preparation step therefore measures nothing.

**The task as amended, for every counted run:**
- Message 1 ends with the single word "done". Nothing learned is echoed.
- Every recall probe asks for something seen only in tool output or the model's own working:
  - the error line `node check.js` prints (as before);
  - the constant's values, with the edit now "double RETRY_LIMIT", so its old value (7) is only in the file and
    the new one (14) is computed;
  - the option, which the model states in its working as `CHOICE: LANTERN` or `CHOICE: HARBOR` before it moves
    on, and never in the final reply;
  - the line count of guard.js (as before);
  - the cache-read weight given in AB-TASK.md's "Calibration results" section, which message 1 finds and reads
    (0.20), in place of a line range the prompt itself named.
- **Where the compaction falls:** a run counts when **at least one automatic compaction happens, and every one
  of them falls after step 3 and before message 2**. A compaction during the facts steps voids the run. One to
  two compactions per run is accepted, since a long real session compacts more than once too.

The fresh five, the arms, the three runs per arm, and every pass rule stand as pre-registered. A second pilot runs
the amended task once in the ON arm to confirm the placement, and it is void by design as well.

### Amendment 2 — 2026-09-19, after the second pilot, before any counted run

The second pilot (ON, session `5d88fc2a`) placed both compactions correctly (after step 3 and before message 2:
192,361 → 88,656, then 183,008 → 24,458), and scored 10 of 10 again without the preparation step. Message 2 made
one tool call, and the recall answers came from Claude Code's compaction summary, which reliably keeps what the
task pointed at. As written, the test could not fail. That would make "correct" and "remembers" pass trivially,
and say nothing about the actual risk: a compaction losing a **detail** the task never flagged as important.

**Five detail probes are added**, each deep in a file message 1 reads and never mentioned by the task:
- the tail limit guard.js puts on the transcript it reads after a compaction (16 MB, about line 1135 of 1293);
- the default compaction window constant in transcript.js (967000, line 497 of 2358);
- the example date cli.js gives in its error for a bad `--since` (2026-09-19, about line 890 of 1707);
- the share of the five-hour limit HANDOFF.md says five messages in a 689k session used (9%, line 343);
- the default `reReadRecency` README.md states (8, line 391 of 552).

Message 2 now asks 15 questions: **task facts** (the five from the first amendment), **details** (these five) and
**fresh** (the original five). Tools stay allowed, so a detail can be looked up again. Looking it up shows as
recovery cost, while getting it wrong from memory shows as a miss. Both are what the preparation step is meant to
move.

**The pass rules, restated for 15 questions:**
- **Correct:** each ON arm's median, out of 15, is at least the OFF median minus 1, and the fresh five never score
  lower than in OFF.
- **Remembers:** ON+PREP answers all ten task-fact and detail probes correctly in all three runs.
- **Cost:** as pre-registered.

A third pilot checks this task once in the ON arm, void by design.

### Stage 1 results — run 2026-09-19 09:19 to 09:37 UTC, Opus 5, Claude Code 2.1.277

The third pilot (ON, session `8525a898`) placed its three compactions correctly and scored 15 of 15. The detail
probes worked as intended: the last compaction summary did not contain 967000, the 9%, or `reReadRecency`, and
message 2 got them back with one `grep`/`sed` call. That lookup is what showed `report --compactions` counted only
Reads as recovery, and the lookup rule was fixed (PR #93) before any counted run was priced. Then nine counted
runs, interleaved OFF, ON, PREP three times over, driven by `scripts/compact-stage1.mjs`.

**Two grading artifacts in the runner, found by reading every transcript, corrected here and in the script.**
The rules are unchanged. The raw grades are kept beside the corrected ones.
- **Q3, the option.** The runner looked only for the literal `CHOICE: LANTERN`. In three runs (PREP 1, ON 2,
  PREP 2) the model stated the choice in its own words in its thinking, before the compaction ("I'm going with
  LANTERN, since…", "I'm choosing LANTERN"). It then answered Q3 correctly, and the runner marked it wrong and
  voided the run.
- **Q9, the 9%.** PREP 2 answered "9 percentage points (36% → 45%)", which is correct. The runner accepted only "9%".

| arm · run | session | compactions (pre → post) | raw / corrected score | draw (points) | recovery (points) |
|---|---|---|---|---|---|
| OFF 1 | `447c3785` | none | 15 / 15 | 2.98 | 0 |
| ON 1 | `0d6be59a` | 117k→35k, 119k→22k, 113k→22k | 15 / 15 | 3.15 | 0.78 |
| PREP 1 | `cf3931fa` | 148k→41k, 115k→31k, 129k→20k | 14 / 15 | 3.13 | 0.00 |
| OFF 2 | `ad431d6e` | none | 15 / 15 | 2.66 | 0 |
| ON 2 | `a6b1d57c` | 129k→22k, 122k→19k, 117k→10k † | 14 / 15 | 3.15 | 0.18 |
| PREP 2 | `1ccd62b4` | 208k→115k, 213k→11k † | 13 / 15 | 2.93 | 0.01 |
| OFF 3 | `b918c21f` | none | 15 / 15 | 2.60 | 0 |
| ON 3 | `4293cf09` | 213k→106k, 197k→10k † | 15 / 15 | 2.91 | 0.01 |
| PREP 3 | `1da74b0b` | 206k→115k, 213k→11k † | 15 / 15 | 2.95 | 0.00 |

Draw is the transcript's own usage, priced with the calibrated weights. Compaction's own request is not in any
transcript, so it is not in the draw. Recovery is priced by the merged `compactionView`.

† **Placement.** This compaction fired the moment message 2 arrived, with **no model output before it** (checked
in each transcript), so it falls between learning and needing. But it comes after message 2 was *sent*, and the
amendment says "before message 2". Choosing a reading after seeing the data would be a post-hoc call, so both
readings are recorded:
- **By the letter:** ON 2, ON 3, PREP 2 and PREP 3 are void. That leaves one counted run each for ON and PREP,
  which is too few for any stage 1 verdict.
- **By the purpose** (no model output between the compaction and message 2, which holds in all four): all nine
  count.

**The rules, applied under the purpose reading, with the corrected grades:**
- **Correct: PASS.** Every run scored 15 of 15. The ON and PREP medians (15) equal the OFF median, and the fresh
  five were 5 of 5 everywhere.
- **Remembers: PASS.** PREP answered all ten task-fact and detail probes correctly in all three runs. (With the
  raw grades it would fail on PREP 1 and PREP 2, but only because of the two artifacts above.)
- **Cost: no verdict, as the rule foresaw.** The PREP median draw (2.95) sits 0.29 above the OFF median (2.66),
  inside the OFF runs' own spread of 0.38. ON's median (3.15) is 0.49 above. That is expected at this scale: the
  task ends a few requests after the last compaction, so the re-reads a compaction saves have no time to add up,
  while its rewrite is paid at once. This stage was built to measure harm, and stage 2 measures the saving.

**What stage 1 does show, beyond the rules.** Compaction did not cost correctness on this task. It did lose
details: the summaries dropped them, and the model looked them up again, cheaply. The preparation step moved the
one number it exists for. Recovery after compaction was 0.78, 0.18 and 0.01 points without it (median 0.18), and
0.00, 0.01 and 0.00 with it (median 0.004). That is three runs per arm, so it is a direction, not a result.

**Limits.** A scaled-down task (a 150k window on a task growing to about 220k) that hits a ceiling on
correctness. Opus 5 only, headless. The owner's `tokenbrake.json` had `readAfterEdit`, `reReadElide`, `mcpTrim`,
`gitView`, `blobElide` and `dedup` on, the same in every arm.

**Which placement reading stands is the owner's call, and it is recorded here when made.** Under the purpose
reading stage 1 passes, and stage 2 (the owner's real work at 300k with the preparation step on) is next. Under
the letter reading stage 1 is incomplete: ON and PREP need more runs with a task sized so no compaction fires at
message 2.

**The owner's call, 2026-09-19: the letter governs.** ON 2, ON 3, PREP 2 and PREP 3 are void. They are void
because of how the task was sized, not because the model did anything wrong: message 1 ended with the context
above the compaction threshold, and Claude Code compacts when the next message arrives. With one counted run
left for each of ON and PREP, stage 1 has **no verdict** from this set. The table above stands as recorded.

### Amendment 3 — 2026-09-19, before any further run

Resizing the reads cannot fix this. Claude Code compacts when a new message arrives while the context is over the
threshold, and where message 1 ends relative to that threshold is not controllable. So a third message goes
between the two: **"Reply with the single word: ok"**. A compaction that fires when a message arrives now fires on
this filler, which falls after step 3 and before message 2 by the letter. The filler carries nothing: no fact, no
question and no tool call. It is the original design with a fixed place for the compaction to land.

**A clean set of nine**, three per arm, interleaved OFF, ON, PREP. The five valid runs above are not mixed into
it: the owner chose one design over a cheaper mixed set. The runner's corrected grading (a choice stated in the
model's own words, and "9 percentage points" accepted) applies from the first run. Every pass rule, the placement
rule by its letter, and the 15 questions stand as pre-registered. A run in which the filler's reply is anything
other than "ok", or in which a tool is called before message 2, is void.

### Stage 1 results, the clean set — run 2026-09-19 09:45 to 12:50 UTC, Opus 5, Claude Code 2.1.277

Nine runs under amendment 3, interleaved OFF, ON, PREP three times over.
- **PREP 3 hit the owner's five-hour session limit.** The meter stood at 68% when the set started, and I did not
  check it first. The filler got the host's limit message, so that run is void and could not be completed. It was
  re-run once the window reset (`c3b`, meter at 3%), with nothing else changed.
- **One more runner artifact of the same kind as before.** PREP 1 stated its choice as "I'll go with LANTERN",
  the runner's pattern knew only "going with", and the model answered Q3 correctly. The pattern now includes
  "go with". PREP 1 re-grades to 15/15, with every compaction after step 3 and before message 2.

| arm · run | session | compactions (pre → post) | score | draw (points) | recovery (points) |
|---|---|---|---|---|---|
| OFF 1 | `e1f5c752` | none | 15 | 2.73 | 0 |
| ON 1 | `d1d3f6b9` | 113k→32k, 147k→30k, 113k→46k | 15 | 3.14 | 0.800 |
| PREP 1 | `21732530` | 129k→52k, 141k→38k, 126k→46k | 15 (raw 14) | 3.78 | 0.602 |
| OFF 2 | `a2b70589` | none | 15 | 2.69 | 0 |
| ON 2 | `a61a6618` | 138k→60k, 158k→46k, 122k→29k | 15 | 3.54 | 0.532 |
| PREP 2 | `f15715f1` | 126k→19k, 122k→19k, 118k→10k | 15 | 3.34 | 0.213 |
| OFF 3 | `306370c5` | none | 15 | 2.71 | 0 |
| ON 3 | `d6c73665` | 135k→22k, 123k→21k, 118k→10k | 15 | 3.34 | 0.745 |
| PREP 3 (`c3b`) | `4dd5bfd1` | 206k→119k, 220k→9k | 15 | 3.11 | 0.001 |

Every filler reply was "ok" with no tool call. Every compaction fell after step 3 and before message 2, and all
nine runs count by the letter.

**The rules, applied as written:**
- **Correct: PASS.** All nine runs scored 15 of 15.
- **Remembers: PASS.** PREP answered all ten task-fact and detail probes correctly in all three runs.
- **Cost: FAIL.** The OFF runs' own spread is 0.04 (2.69 to 2.73), and the PREP median draw (3.34) sits 0.63
  above the OFF median (2.71). The difference is far larger than the spread, so by the rule it is decisive, and
  PREP drew more than OFF. The ON median (3.34) is the same.

**Stage 1 fails.** Under "The flip" above, the 300k window with the preparation step cannot become the default on
this protocol. By its own rule this stage is not re-run with a looser one.

**What the failure is, stated plainly.** The cost rule compared whole-session draw on a task built to end a few
requests after the last compaction. Each compaction rewrites the compacted context, 10k to 119k tokens at the
write weight, and that is paid at once. The re-reads it saves are paid only over the requests that follow, and
this task had almost none. So the rule measured a compaction's fixed cost with no room for its saving. That is a
flaw in how I wrote stage 1's cost rule, and it was visible before the runs: the first results already said
"stage 2 measures the saving". It is recorded as a flaw of the design, and it does not change the verdict.

**What the stage does show.** Compaction cost no correctness. And the preparation step cut the one thing it exists
to cut: recovery after compaction had a median of 0.745 points without it (0.800, 0.532, 0.745) and 0.213 with it
(0.602, 0.213, 0.001), a reduction of about 70% over three runs per arm.

## The compaction window, v2 — pre-registered 2026-09-19, after v1's stage 1 failed and before any stage 2 data

**What this is, and what it cannot do.** v1's stage 1 failed on cost, and that failure stays on the record. It is
not re-run with a looser rule. v2 is a new test with a different question: *once a session continues past its
compactions the way real work does, does the earlier window pay for itself, with its preparation step, without
costing correctness?* v1's stage 1 could not ask that, because its task ended right after the last compaction.
Everything in v2 is fixed here, before any stage 2 data exists. v2 passing would not overturn v1's result; the
two would be recorded as answering different questions.

### Stage A — controlled, with the continuation v1 lacked

**The task.** Message 1, the filler and the 15-question message 2 are exactly amendment 3's, so correctness and
recall are measured as before. Then a **tail of 30 follow-on messages**, one question each, each answered in one
line:
- **15 about files message 1 read**: "What is the first word on line N of F?", with F in {transcript.js, cli.js,
  guard.js, HANDOFF.md, README.md} and N fixed in advance.
- **15 about files it never read**: the same question for FEATURES-PLAN.md, AB-RUNBOOK.md and CHANGELOG.md.

The 30 (F, N) pairs are generated from a fixed seed and committed in the runner before any counted run. The
answers are computed from the fixture. The tail is the continuation the saving needs: every tail request re-reads
the whole context, about 220k in OFF against what compaction left in PREP.

**Arms:** OFF (Claude Code's default window) and PREP (a 150k window plus `compactPrep`). ON is dropped, because
the default under test is the window with its step, and v1 already measured ON. **Four runs per arm**, interleaved
OFF, PREP.

**Draw, including what a transcript leaves out.** The transcript's own usage is priced with the calibrated weights,
**plus each compaction's own request, estimated**: a cached read of the pre-compaction context (pre × the
read weight) plus the summary's output (the summary message's characters ÷ 4 × the output weight). The summary is
the `isCompactSummary` entry in the transcript. v1 charged a flat 0.5 or 1.6 points; this estimate is made per
compaction and checked against the meter:
- The five-hour meter is read before the set and after it, and nothing else runs meanwhile.
- If the meter's movement over the set and the summed estimated draw disagree by more than 25%, **the cost
  verdict is void**, and the meter reading is reported instead.

**Meter discipline**, the lesson of v1's clean set. The meter is read before every run. No run starts above 60%;
the set waits for the window to reset.

**The prediction, written now.** A tail request in OFF re-reads about 220k tokens (about 0.044 points). In PREP it
re-reads what compaction left, 10k to 120k. Stage 1 put the up-front cost of compacting at about 0.6 points. So
PREP should break even within roughly 15 to 25 tail requests and finish the 30 ahead. If it doesn't, the model of
the lever is wrong, not just the size of the saving.

**Stage A passes when:**
- **Correct:** PREP's median on the 15 questions is at least OFF's minus 1, and PREP's median on the 30 tail
  answers is at least OFF's minus 2.
- **Remembers:** PREP answers all ten task-fact and detail probes correctly in all four runs.
- **Cost:** PREP's median total draw, including the estimated compaction requests, is **below** OFF's median by
  more than OFF's own spread (its highest run minus its lowest). A difference inside that spread is no verdict,
  and no verdict is not a pass.

### Stage B — the owner's real work

Stage B is v1's stage 2, **unchanged**: the owner at `/autocompact 300k` with `compactPrep` on, until 8
automatic compactions are recorded. It passes when the recovery cost plus compaction's own charge, at v1's 1.6-point
bound, stays under half the predicted saving, with no more than one "felt worse" logged and none of them from a
lost fact the step should have carried. It is kept as written because it is the stricter reading, not replaced
by stage A's estimate.

### The flip, v2

The 300k window with the preparation step becomes the default **only if stage A and stage B both pass**. If stage
A fails on cost even with the tail, the window lever is dead as a default, full stop, and stays an opt-in. The
preparation step may still earn a default of its own, but only through a protocol of its own.

### v2 stage A results — run 2026-09-19 18:15 to 19:00 UTC, Opus 5, Claude Code 2.1.277, commit `be4c5d8`

Eight runs, interleaved OFF, PREP, driven by `scripts/compact-stage1.mjs --tail=30` under a small orchestrator:
- A meter probe ran before the set, before every run, and after the set.
- No run was allowed to start above 60%, and none needed to wait: the set started at 3% and ended at 49%, all in
  one window.
- Nothing else ran meanwhile, and the session that launched the set stayed idle.

| arm · run | session | compactions (pre → post) | 15 questions | tail (read + unread) | draw | compaction charge | total |
|---|---|---|---|---|---|---|---|
| OFF 1 | `48adc213` | none | 15 | 13 + 15 | 5.51 | 0 | **5.51** |
| PREP 1 | `f637a2c7` | 116k→82k, 225k→77k, 155k→10k | 15 | 13 + 15 | 4.09 | 0.20 | **4.29** |
| OFF 2 | `615039a7` | none | 15 | 14 + 15 | 5.46 | 0 | **5.46** |
| PREP 2 | `4cc9627d` | 206k→116k, 214k→11k | 15 | 13 + 15 | 3.93 | 0.17 | **4.09** |
| OFF 3 | `a96fe552` | none | 15 | 13 + 12 | 5.56 | 0 | **5.56** |
| PREP 3 | `a9ecaabe` | 206k→115k, 213k→9k | 15 (raw 14) | 13 + 15 | 3.94 | 0.13 | **4.07** |
| OFF 4 | `467e54b7` | none | 15 | 13 + 15 | 5.40 | 0 | **5.40** |
| PREP 4 | `0640c12f` | 137k→48k, 172k→76k, 147k→11k | 15 | 13 + 15 | 4.04 | 0.22 | **4.26** |

All compactions in PREP fell after step 3 and before message 2. None fired in the tail, and OFF never compacted.

**Runner artifact, the same kind as before.** PREP 3 wrote "I've chosen LANTERN" in its thinking before both
compactions, and the pattern knew "chose" but not "chosen". It re-grades to 15 and counts. The pattern now takes
"chosen".

Two tail questions grade oddly, and they do so in both arms alike:
- transcript.js line 2037, whose first whitespace-delimited "word" is `feat('mcpTrim',`: all eight runs answered
  "feat".
- README.md line 420, "none": the PREP runs answered "None".

Neither moves a rule.

**The rules, applied as written:**
- **Correct: PASS.** Every run scored 15 of 15. The tail medians are 28 (OFF: 28, 29, 25, 28) and 28 (PREP: 28 in
  all four), and the rule was PREP ≥ OFF − 2.
- **Remembers: PASS.** PREP answered all ten task-fact and detail probes correctly in all four runs.
- **Cost: PASS.** The OFF median total is 5.49, with a spread of 0.16 (5.40 to 5.56). The PREP median total is
  4.18, which is **1.31 points (24%) below**, about eight times OFF's own spread.
- **Meter check: holds.** The meter moved 46 points (3% → 49%, ±1). The estimate summed to 39.6 points: 38.64
  across the runs, plus 0.97 for the probes. That is a gap of 14%, inside the pre-registered 25%, so the cost
  verdict stands. The estimate runs low: it prices each compaction from its summary alone, and the gap covers
  OFF runs too, so part of it is the weights' own uncertainty.
- **The prediction, written before any run:** PREP breaks even within the tail and finishes ahead. **It held.**

**Stage A passes.** Under "The flip, v2", the default now waits on stage B alone: v1's stage 2, unchanged, on the
owner's real work at `/autocompact 300k` with `compactPrep` on, until 8 automatic compactions are recorded. v1's
stage 1 fail stays on the record as the answer to its own question.

## Amendment: the workload filter widens to bench *or* calibration — 2026-09-20, before any number is read under it

`--where`, `--reads`, `--reach` and `tune` skip staged work so that a claim about ordinary work is not drawn
from fixtures. Each of them spells that skip as **a cwd under `tokenbrake-bench`**. Stage 2 spells the same
idea wider — "sessions under `tokenbrake-bench` or a calibration directory don't count" — and `report --saved`,
added 2026-09-20, separates the same wide set. The narrow spelling was written when the benchmark was the only
staged thing on this machine. It has not been since 2026-09-19.

**What is on disk today**, by cwd alone (a classification, not a result): of **137** sessions, **23** are under
`tokenbrake-bench`, **41** are calibration arms, and **73** are ordinary work. The 41 are the stage 1 and stage A
runs driven by `scripts/compact-stage1.mjs` over prepared fixtures, all under
`…\scratchpad\calibration-stage1\…` and `…\scratchpad\calibration-stageA\…`.

**What that does to `--reach`'s pool as it stands:** 91 sessions pooled, of which **30 are calibration arms**.
They carry **881 of the ~3,464** pooled tool results and **292 of the 2,190** shell results. So about a quarter
of the results the reach shares are computed over, and an eighth of the shell results the verdict rule counts,
come from a scripted workload whose tool use was chosen by a script, not by the work.

**The amendment, from this date:** the four views skip on the wide rule — `transcript.stagedCwd(cwd)`, the one
stage 2 already uses — instead of the narrow one. `--cwd=<substring>` still overrides it, as it always has, so
any staged set can be asked for on purpose.

**What does not move.** No weight, no counting rule, no `compactionView` figure, no trim accounting, and stage
2's own population (it was already on the wide rule, so nothing it has recorded changes). `report --saved`
already lists staged work apart rather than skipping it, and keeps doing so: a saving in a fixture is a real
saving, it is just not a claim about ordinary work.

**What the amendment voids, and what it does not.** The reach figures on the record — first run, **8 of 40**
sessions with the guard recording, **W = 4.4%** of carried tokens inside the trim's reach, **22%** of the
carried tokens it could have reached — were computed under the narrow pool and stay on the record as that.
**No verdict may be drawn from any `--reach` output computed before this line.** The open question's
thresholds are untouched and are not being rewritten: still **under 5% of carried tokens and the README must
say the mechanism is essentially absent, in those words**, and still **ten sessions with the guard running and
200 shell results in them** before a verdict at all. Both counts are now counts over the narrowed pool, so
guarded sessions and shell results already accumulated inside a calibration directory do not count toward
them. The first `--reach` run after the code change lands is the first one whose numbers count.

This is written before the change is made and before any figure is read under it, which is the order
`CLAUDE.md` requires.

## Does the trim's mechanism appear when the agent has decent tools? — first counted run, 2026-09-20

The rule was pre-registered before any of this was measured, thresholds and all, including the outcome that is
bad for the product: **under 5% of carried tokens and the README must say the mechanism is essentially absent,
in those words**; at or above 20% it is present and worth having; between the two it is present but marginal
and no claim may be made from it. It returns **NO VERDICT** below **ten sessions with the guard running and
200 shell results in them**. The first run, 2026-09-12, returned NO VERDICT: the guard was recording in 8 of
40 sessions. Everything computed since then pooled calibration arms as the owner's own work, which the
amendment above corrects; this is the first run whose numbers count under it, on `main` at `be51821`.

**The pool.** 137 sessions on disk, **61 pooled**: 64 skipped as staged (23 benchmark, 41 calibration arms)
and 12 with no tool results. Of the 61, the guard was recording in **30** (2 of them established from a trim
marker rather than a ledger row, which is a lower bound), carrying **1,614 shell results**. Both gates are
cleared, by 3x on sessions and 8x on shell results, so the verdict is live for the first time.

**The number: W = 9.7%** of carried tokens sit where the trim can act, measured over the 30 sessions the guard
was actually running in. (Over all 61 pooled it reads 11.1%; the verdict takes the guarded figure, since a
tool list from sessions without the guard describes a machine that is not running this product.)

**The rule, applied as written: between 5% and 20% -- present but marginal. That is the number; there is no
claim to make from it.** The 5% branch did not fire, so the README is not required to say the mechanism is
essentially absent, and nothing licenses saying it is present and worth having either. The question the round
was pre-registered to answer -- whether the mechanism needs poor tooling to have anything to do -- comes back
*not settled either way on this evidence*, and that is the answer, not a reason to re-run it differently.

**Three things the run says that the verdict does not.**
- **The guard is not leaving reachable work alone.** Inside those 30 sessions, 46 results sit within reach and
  it acted on 42: **99% of the carried tokens it could reach**. The first run's 22% was the open worry; it is
  not where the remaining share went.
- **What it declines to touch is larger than what it reaches.** Single-file excerpts are 142 results and
  ~12.9M carried, **12.2%** of everything pooled -- more than the 11.1% inside the reach. 0.2.3 stopped
  trimming them on measured evidence (chunked re-reads doubled the tokens on one task), so this is the size of
  a deliberate exemption, not a defect. It does not by itself confirm the standing suspicion about 0.2.6's
  excerpt exemption: these are excerpts the model asked for, not reads the cap provoked.
- **The biggest bucket is under the threshold.** 1,678 results, ~46.3M carried, **43.7%** -- output too small
  for the trim to fire on, carried through every later request. That is the shape the "brake to 8-10" work is
  aimed at, and it is a different mechanism from the one this round measured.

**What may be quoted from this.** The verdict sentence and W, with the population named (30 guarded sessions
of 61 pooled, staged work excluded). Not the pooled 11.1% as if it were W, and not any figure from a run
before `be51821`.

## Known limitation in `compactionView`, left as is while stage B runs — 2026-09-22

The 2026-09-21 architecture review found two edges in `compactionView`: a post-boundary request with no `usage`
reads as zero context, so `drop` and the saving inflate; and a request with no timestamp reads as epoch zero, so
the gap to the request before it exceeds an hour and can register a false cold rebuild. Both are real. Neither
is fixed here, because the fix changes the saving figure stage B reads, and `CLAUDE.md` forbids that mid-stage
without an amendment.

**Checked 2026-09-22 against the three compactions counted so far** (sessions `4eaa149a` at 2026-09-20 14:29
and 18:27, `230261b2` at 2026-09-21 11:51): the first request after each boundary carries usage, and no request
in any counted range lacks usage or a timestamp. The numbers read so far are untouched by either edge. The fix
lands after stage B closes at 8, and the five compactions still to come are checked the same way before the
verdict is read.

## Amendment: stage B continues on Opus 5.5 after a recalibration — 2026-09-22, before any Opus 5.5 number is read

**Why.** Claude Code's model picker no longer offers Opus 5; the owner's sessions now run on Opus 5.5
(`claude-opus-5-5`). Stage B counts automatic compactions on the calibrated model only, so as written it can
never reach 8. Three are counted on Opus 5 (2026-09-20 14:29 and 18:27, 2026-09-21 11:51), all passing with
margin. Closing stage B at three would leave the 300k window without a verdict on the model the owner uses.
The owner chose on 2026-09-22 to continue on Opus 5.5 instead.

**What carries over, and what does not.** Opus 5.5 has the same tokenizer, the same 1M window and the same
output cap as Opus 5, so a compaction at 300k removes the same context and later requests stop re-reading
the same tokens. What is per model is the weight of each kind of token against the five-hour window, and
`LIMIT_WEIGHTS` holds Opus 5's. Opus 5.5 is not assumed to weigh the same.

**The recalibration.** The 2026-09-18 calibration, repeated unchanged on Opus 5.5: same blocks, same prompt,
same resolution rules, same `scripts/calibrate.mjs` (its `--model opus` alias now resolves to Opus 5.5; the
`model` column in `calib.jsonl` records what ran). Effort stays `low` as in the original. Not started above 60%
of the five-hour window. Results are recorded here under their own heading before any Opus 5.5 compaction is
priced.

**How stage B counts after it.**
- The three Opus 5 compactions stay counted, priced with the Opus 5 weights.
- Opus 5.5 automatic compactions count from the day the Opus 5.5 weights are merged, priced with those
  weights. Any Opus 5.5 compaction before that day is listed and not counted.
- The pass rule is unchanged: 8 counted in total, recovery plus compaction's charge at the 1.6-point bound
  under half the predicted saving, no more than one "felt worse" logged. The compaction charge bound is
  re-derived from the Opus 5.5 run the same way, and the larger of the two bounds is used for the verdict.
- If the Opus 5.5 weights differ from Opus 5's by more than the calibration's own resolution, the verdict is
  also given separately for each model, and both are quoted.

### Opus 5.5 recalibration, first run — 2026-09-23 18:44 to 2026-09-24 06:39 UTC: void, rerun

**Why it is void.** The owner's user settings carry stage B's `autoCompactWindow: 300000`, and headless
`claude -p` honours it. The 2026-09-18 run had no such setting, so this run did not repeat it unchanged. The B1
build reached 411,826 tokens, and the next message auto-compacted it to 2,433 (`compact_boundary`, trigger
`auto`, in `201aa5a7`). Every block that resumed that session then ran at about 20-35k instead of 430k. The B5
session auto-compacted once at 300k as well. The protocol voids a block for auto-compaction outside B4, so:

| block | rows | five-hour | status |
|---|---|---|---|
| B0 fresh | 1 + 20 | 3 → 4 | clean, below resolution (as on Opus 5) |
| B1 build + 20 | 1 + 20 | 4 → 9 | void: auto-compacted after its first message |
| B1 repeat | 1 + 40 | 9 → 13 | void: ran at ~35k, not 430k |
| B5 long replies | 1 + 40 | 13 → 29 | void: auto-compacted once |
| B3 cold ×3 | 3 + 3 probes | 29 → 0 → 0 | void: each cold write was ~17k, not ~430k; the window reset inside the block |
| B4 compact + 20 | 1 + 1 + 20 | 0 → 2 | void: compacted a ~34k session |

No weight is read from it. It also records one change from the Opus 5 run, on Claude Code 2.1.281: every resumed
message writes about 9k tokens of 1-hour cache (B0: 185k over 20 messages; the Opus 5 B0 wrote 50k over 21). It is
the same in every block, so the per-block differences the weights come from are not affected.

**The script.** `scripts/calibrate.mjs` now passes `--autocompact auto` (the model's own window, as on
2026-09-18) and stops the run on any compaction a block did not ask for.

## Amendment: the Opus 5.5 recalibration reruns in daylight, B3 replaced by builds — 2026-09-24, before any of it is run

**Why.** The first run is void, and the owner will not give it another night. The night was B3: three idles of
over an hour, only to let the cache expire before each cold rewrite. Everything else took about 80 minutes. The
2026-09-22 amendment stands: Opus 5.5 compactions count from the day these weights merge, priced with them. This
amendment only changes how the weights are measured. It is committed before the rerun's first message.

**What changes, and why it measures the same thing.**
- **B3 becomes BW: three builds of the B1 size (~411k), each in a new session, back to back.** A cold rewrite and a
  build are the same kind of token, a 1-hour cache write (`ephemeral_1h` in the usage), and both are about 411k.
  An hour's wait adds nothing to the weight. BW does not record what Claude Code offers after a long break.
- **B0 is not rerun.** No weight comes from it (on 2026-09-18 it was a floor below resolution), and the void
  run's B0 is clean.
- **Every span opens and closes on a probe**: one message in a new session, 90 seconds after the block's last
  message. A span's tokens are its opening probe and the block's rows. The meter lags one message, so the closing
  probe's reading holds everything before it and nothing of itself. On 2026-09-18 a span ran from one block's
  first reading to the next block's. The lag rule is the same, but the edges are now clean.
- **The B1 repeat is 60 messages, and it always runs.** On Claude Code 2.1.281 a resumed small session wrote ~9k of
  1-hour cache per message (the void run). If the ~411k session does the same, a third of the span's draw is
  writes, and 60 keeps the read weight above resolution after they are subtracted.
- **B4 follows the B1 repeat directly**, while the B1 session is warm. On 2026-09-18 it followed B3's last cold
  rewrite, which also left it warm.
- **The weights are solved together.** B1R, BW and B5 each give one equation: reads x a + writes x w + output x o
  = the meter's move, in millions of tokens, where writes are cache writes plus uncached input. Three spans, three
  unknowns. The ranges take every combination of each move ±1 point. On 2026-09-18 the same subtraction was done
  one weight at a time. B1 and B4 are checks: the weights' prediction against the meter, reported, not used.
  Compaction's bound is B4's move + 1, less what the weights predict for its rows. The derivation is
  `scripts/calibrate-weights.mjs`, committed with this amendment; `--selftest` recovers known weights from
  synthetic rows.
- **Windows.** The run starts under 60%. Before each block, if the reading plus the block's estimate would pass
  85%, the script waits for the window to reset. A span whose probes straddle a reset is void.

**Void, and the run stops (the script enforces each):** a model other than `claude-opus-5-5`; an error; a
compaction outside B4; a B1 or B1R message under 380k of context; any other Claude Code session on this machine
with a model reply inside a span; the window at 90%. Chat on claude.ai leaves no trace on this machine, so the
owner keeps it closed.

**Unchanged:** the "ok" prompt, `--model opus`, effort low, the build size, B5's prompt and 40 replies, the
5-point resolution rule, and every rule of the 2026-09-18 section and the 2026-09-22 amendment.

**One command:** `node <repo>/scripts/calibrate.mjs --plan` from a new, empty directory whose path contains
`calibration`, then `node <repo>/scripts/calibrate-weights.mjs` in it. The results go under their own heading
below, before any Opus 5.5 compaction is priced.

### Opus 5.5 recalibration, second run — 2026-09-24 17:56 to 22:54 UTC: void, rerun

**Why it is void.** `--autocompact auto`, added after the first run, broke the prompt cache on every resumed call.
Every B1 and B1R message read only the system prompt from cache (17,099) and wrote the whole ~395k session again as
1-hour cache. B1R was meant to measure the read weight and measured writes instead. Each message drew about 3 points,
not the 0.2 the plan assumed, and the window reached 90% after 31 of B1R's 60 messages.

| block | rows | five-hour | cache writes | cache reads | status |
|---|---|---|---|---|---|
| B1 build + 20 | probe + 1 + 20 | 1 → 88 | 8.30M | 0.40M | not used: no message read the build |
| B1R | probe + 31 | 0 → 90 (stopped) | 12.28M | 0.53M | void: stopped at 90%, and no message read the build |

No weight is read from it. Both spans are almost entirely 1-hour writes, but they give about 10.5 and 7.3 points per
million. That difference is recorded here without an explanation, and it is not used.

**The cause, from an uncounted diagnostic** (2026-09-25, `C:\Users\Q\calibration-diag-cache`, a ~41k session and
four resumed "ok" messages per arm). With `--autocompact auto`, every resumed message read 17,095 and wrote ~24k.
Without the flag, and under the owner's `autoCompactWindow: 300000`, every resumed message read the whole ~41k from
cache and wrote nothing. The first run had no flag, and its first resumed B1 message read 411,711 from cache.

## Amendment: the compaction window comes from a settings file, chosen by a preflight — 2026-09-25, before any of it is run

**What changes.**
- **The window.** Each call widens the compaction window so that the 411k build is not compacted, as before. It no
  longer uses `--autocompact auto`. A **preflight** runs before the first probe and tries two ways in order:
  `--settings` with a file holding `autoCompactWindow: 1000000`, then `--autocompact 1000000`. Each gets a new
  ~15k session and two resumed messages. The run uses the first way whose resumed messages both read at least 90% of
  their context from cache. If neither does, the run stops before any span. The preflight's rows go to
  `preflight.jsonl`, not `calib.jsonl`, and count toward nothing.
- **A new void rule:** a B1 or B1R message that reads less than 380k from cache stops the run. It would have stopped
  the second run after its first message, about 4 points in.

The preflight checks the cache at ~15k, not whether the chosen way really keeps a 411k session from compacting. The
existing rules check that: any compaction outside B4, or a B1 message under 380k of context, stops the run.

**Unchanged:** everything in the 2026-09-24 amendment: the blocks, their sizes and order, the probes, the windows,
the solve, and every void rule.

**One command,** as before: `node <repo>/scripts/calibrate.mjs --plan` from a new, empty directory whose path
contains `calibration`.
