# The A/B run: does brake 1 move the usage limit?

> Since 0.2.2 the comparison table below is one command: `tokenbrake report --compare <A> <B>` on the two
> arms' transcripts prints cost, requests, cache reads, entered, carried, trimmed and repeat reads with the
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
usage and cost, so those are the primary numbers.

| | arm A, no hooks | arm B, hooks on | change |
|---|---|---|---|
| API cost of the session | $8.40 | $7.02 | −16% |
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

**Reading.** On an identical task, brake 1 cut the session's API cost by
16%, its cache reads by 41% and its requests by 29%. The five-hour limit
moved one point less, +8 against +9: at 1% resolution that is consistent with
the 16% and cannot be stated more finely than "about one point in nine". The
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
window by 30 points rather than 9 and a 16% difference becomes 5 points;
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
| API cost | $5.97 | $3.77 | −37% |
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
| cost, hooks off → on | $8.40 → $7.02 (−16%) | $5.97 → $3.77 (−37%) |
| cache reads, off → on | 4.62M → 2.72M (−41%) | 5.77M → 3.99M (−31%) |
| five-hour window, off → on | +9 → +8 | +3 → +2 |
| answers | identical | identical |

The limit moved with the cost on both, as far as 1% resolution can show. A
side fact worth keeping: the same task moved the five-hour window three
times as far on Fable as on Opus while costing more in dollars too, so the
limit weighs Fable heavily per dollar.

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
before: cost and cache reads from the session record, the five-hour window from
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
be compared on work done, not only on cost.

What to read: cost and cache reads from the session records, the usage page
around each arm, the number of `npm test` runs, and whether both arms fixed
the same five faults.

### Result: no measurable difference, and the reason is the finding

| usage page | arm A, hooks off | arm B, hooks on |
|---|---|---|
| five-hour window | 0% → 1% (+1, window freshly reset) | 14% → 15% (+1) |
| weekly, all / Fable | 33 → 33, 61 → 61 | 35 → 35, 64 → 64 |

| session record | arm A | arm B | change |
|---|---|---|---|
| API cost | $2.76 | $2.63 | −5% |
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
HEAD. The 5% is within the variation between two runs of the same task; the
guard trimmed nothing in arm B, because nothing crossed its threshold.

**Why nothing crossed it.** Opus 5 in a debugging loop bounds its own reads.
Neither arm ran `npm test` bare; both ran `npm test 2>&1 | tail -80`, or the
worker suite through `grep FAIL`, and read source through `grep -n … -A 20`
and `sed -n 'a,bp'`. The largest tool result in either session was about
1,000 tokens; tool results entered 10–11k of context in total, against 160k
on the audit task and 187k on Fable's. There was nothing for brake 1 to do.

**What this says.** Brake 1 saves what the model would otherwise let in. On
a read-heavy audit that asks for whole files, Opus let in 160k and the guard
cut the session's cost by 37%. On a debugging task where the model chose
`tail` and `grep` on its own, it let in 10k and the guard saved nothing.
The pre-registered expectation ("the biggest honest number") was wrong, and
it is recorded as wrong. The honest range for Opus 5 on this repository is
0% to 37%, set by how much output the model lets in, which `report` shows
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
| API cost | $1.54 | $1.16 | −24% |
| cache-read tokens | 1,508,345 | 720,867 | −52% |
| output tokens | 6,583 | 4,348 | −34% |
| requests | 16 | 7 | −56% |
| tool results entered (report) | 3k | 2k | |
| trimmed by the guard | 0 | **0** | |
| `npm test` runs | 3 | 3 | |
| faults fixed | 5 of 5, diff empty | 5 of 5, diff empty | |

**The 24% is not the hook's.** The guard trimmed nothing: Fable, like Opus,
never let the suite in whole (`npm test 2>&1 | tail -80`, `grep -v '^ok'`),
and the largest result in either arm was about 1k tokens. Arm B was cheaper
because it did the job in 7 requests instead of 16, batching the fixes from
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
| API cost | $2.83 | $2.12 | −25% |
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
token-reads not carried against 1.7M cache reads. The other 24 points of the
cost gap are, again, the model doing the job in fewer requests (17 against
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
the run: 25,000 becomes the default only if arm B is cheaper or equal with
identical answers. Results: `ab-results/readmax-60k.txt` on
`claude/ab-readmax-60k` and `ab-results/readmax-25k.txt` on
`claude/ab-readmax-25k` in `33kain/contexa`.

| session record | arm A, 60000 | arm B, 25000 | change |
|---|---|---|---|
| API cost | $5.13 | $5.64 | +10% |
| cache-read tokens | 4,855,785 | 6,817,176 | +40% |
| output tokens | 13,161 | 11,857 | −10% |
| requests | 25 | 34 | +36% |
| tool results entered (report) | 91k | 92k | |
| tool results carried | 912k | 1.5M | +64% |
| Read calls | 21 | 17 | |
| trimmed by the guard | 1 result, ≈ 789 tokens | 1 result, ≈ 790 tokens | |
| answers | 12 of 12 | 12 of 12, identical | |

**Result: the lower trigger cost more, and 60,000 stays.** The same tokens
entered on both arms, 91k against 92k, because the task asks for whole files
and the model reads whatever the cap withholds in further bounded reads: in
both arms `content.js` (112 KB, capped either way) went in as six or seven
chunks of 4–6k tokens. Lowering the trigger added the same chunking to
`background.js`, `worker/test.mjs` and `capture.mjs`, and each extra read is an
extra request that re-reads the whole context: 34 requests against 25, 1.5M
token-reads carried against 912k, 40% more cache reads, 10% more cost. The
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
| API cost | $2.45 | $2.38 | −3% | $2.89 |
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

**Result: a null, and the noise is now measured.** Cost −3%, cache reads
+4%. The two hooks-on runs of the identical task, arm B and the voided arm A,
came out 21% apart in cost and 27% in cache reads on nothing but how the
model planned (23 against 30 requests), so anything inside that band is not
the hook. The mechanism is the one from the debugging round: the model
bounded its own reads (`sed -n`, `grep -n`, `wc -l`, then ranges), and its
largest result was one `cat -n build.mjs` at 5k tokens, which the guard
trimmed to 1k in the hooks-on arms and left whole in the off arm. That is
where the −28% in carried tool results comes from, 63k token-reads against
2.3M processed: real, mechanical, and 3% of the session.

So three shapes are measured now. Read-heavy audit that asks for whole files:
−16% on Fable 5.1, −37% on Opus 5. Debugging loop: ≈ 0%. A small feature:
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
files the model has to read whole, and the return trips cost more than the
cap saves.

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
| API cost | $2.62 | $1.73 | $2.91 | $4.55 |
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
commands costs when it goes wrong: compound commands, heredocs, background jobs, `set -e`, the exit code
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
transcript under `C:\Users\<user>\.claude\projects\C--Users-<user>-Desktop-contexa\` and priced the
session. Nothing platform-specific failed. The oldest open item on this page is closed.

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
  and the user had just installed user scope too, so the guard ran twice. Harmless, doubled spawn cost;
  `status` now says so.

## Three arms: off, rtk, tokenbrake — run 2026-09-09, Opus 5, Claude Code 2.1.266

The head-to-head the launch post wanted: the same twelve-step audit, three Cowork sessions from the same
commit of `33kain/contexa`, differing only in what sat in front of the tools. One message each. The
expectations were written down before the run: rtk reduces output and stays within the 21% noise on the
bill; tokenbrake around −30% on this shape, where it had measured −37% and −16% before.

| | off | rtk | tokenbrake 0.2.2 |
|---|---|---|---|
| API cost | $4.82 | $5.34 (void) | **$9.63** |
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
without any hook and is a second no-hook reading: $5.34 against $4.82, 33 requests against 24, the model
this time reading files as large `sed -n` ranges instead of whole Reads. The rtk comparison, if it happens,
happens on a machine where rtk is already installed.

**The tokenbrake arm cost twice the off arm, and the mechanism is the one JetBrains described for rtk.**
The model never used Read. It read the files with `sed -n`, and after its first excerpt,
`sed -n '1,120p' extension/content.js`, was trimmed (2k tokens to 1k), every excerpt that followed was 80
lines: `120,200p`, `200,280p`, `280,360p`, on through all of `content.js`, `index.js`, `background.js`,
`test.mjs` and `capture.mjs`. Eighty lines of this source is about 5,000 characters, under the 6,000 the
trim fires at. The model learned the threshold from one trimmed result and sized every read to stay under
it: 68 same-shape reads, 91 requests, each one re-reading the whole context, 14.9M cache reads against 4.6M.
Same answers, twice the bill.

Two earlier hooks-on runs of this shape did not do this: 2026-09-06, Opus 5, $3.77 with bounded Reads and
Grep; 2026-09-07, the readMaxBytes arm A, $5.13, 25 requests, `content.js` in six Read chunks of 300 lines.
So the hooks-on range on this one shape is now $3.77 to $9.63 with the off arm at $4.82 to $5.97, and the
model's reading strategy, not the hook, decides which. The −37% in the README is one of three runs, and the
post has to say so.

**What the run points at.** The trim treats every shell result the same, and a `sed -n` excerpt of a source
file is not test noise: it is a read, the same act as the Read tool, which the guard leaves whole up to
60 KB. The guard therefore does two inconsistent things to the same file: a Read of 40 KB passes, a
`sed -n 1,400p` of 20 KB is cut to head, tail and error-looking lines, which for source is the wrong
three things to keep. A model that meets that once has every reason to stay under 6,000 characters, and
80-line chunks are what that looks like. The candidate fix is to treat a single-file `cat`/`sed -n`/`head`/
`tail` the way Read is treated: untouched up to `readMaxBytes`, capped above it. `readKey` in
`transcript.js` already recognises the shape. That is a guard change and gets the same A/B as everything
else before it ships: off against on, this task, two arms, the `requests` column deciding.

Until that runs, the honest sentence about this shape is: on a read-heavy audit the hook has saved 37%,
16%, and cost 100%, on the same task, depending on how the model chose to read.

### The fix, measured — ab4, 2026-09-09, Opus 5, Claude Code 2.1.266

Same audit, same commit of `33kain/contexa`, off against the "file excerpts are reads" guard. Decision rule
written before the run: the fix ships as a win only if the on arm's requests are at or below the off arm's
and cost is not worse.

| | off | on (fix) | change | for comparison: on (0.2.2, ab3) |
|---|---|---|---|---|
| API cost | $4.60 | $5.99 | +30% | $9.63 |
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

**What it did not do.** The on arm still ran 45 requests against the off arm's 32, and cost 30% more. The
extra requests are more and smaller ranges on `index.js` and `background.js` (`150,270p`, `480,700p`),
which is how this model read those files this time; the off arm read them in 330-line ranges. That
difference is inside how the model plans, and it was there in the two no-hook arms of ab3 as well (24
against 33 requests), but the rule was the rule: by it, the fix is not a win.

**What ships anyway, and why.** The choice for the guard is not "fix or off"; a guard that does nothing to
excerpts is the fix. The choice is "fix or 0.2.2", and on this task 0.2.2 cost twice the off arm while the
fix cost 1.3 times. The change also only ever does less than before: it leaves excerpts alone. So it ships
as 0.2.3, with this table beside it, and without the word "win".

**The honest state of the audit shape on Opus 5.** Every run of it, hooks off and on, this repository:

| date | guard | hooks off | hooks on | on / off |
|---|---|---|---|---|
| 2026-09-06 | 0.2.0 | $5.97 | $3.77 | 0.63 |
| 2026-09-07 | 0.2.1, readMaxBytes 60000 arm | — | $5.13 | — |
| 2026-09-09 ab3 | 0.2.2 | $4.82 (and $5.34 on the void rtk arm, also no hooks) | $9.63 | 2.00 |
| 2026-09-09 ab4 | excerpts-are-reads | $4.60 | $5.99 | 1.30 |

Four no-hook readings between $4.60 and $5.97; four hooks-on readings between $3.77 and $9.63. The −37%
in the README is the best of four, not the number. On Opus 5, on this task, the hook has not shown a
saving that survives repetition; what survives is that the model's reading strategy, whole files against
ranges against small ranges, moves the bill by a factor of two, and the guard's job is not to push it
toward the small ranges. The Fable 5.1 reading (−16%, one run) is unrepeated and gets its rerun with this
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

The one unrepeated reading in the README is Fable 5.1's −16% on this shape, measured 2026-09-06 against
guard 0.2.0 — the guard that has since been shown to teach Opus eighty-line `sed` ranges and cost twice the
no-hook bill (ab3), and that 0.2.3 replaced. So the Fable figure was measured with a guard nobody would
ship today, and it is the number the launch post would lead with. This round re-measures it against the
guard that actually ships.

**Setup.** Two Cowork sessions on `33kain/contexa`, Fable 5.1 both arms, one message each, the twelve-step
audit above with step 12 pinned to `tokenbrake@0.2.3`. Both arms branch from the same commit, the 0.2.3
repin (`claude/tokenbrake-0.2.3`); the trees are identical but for `.claude/settings.json`, which is
`{"hooks": {}}` on the off arm and the project install on the on arm. Results to
`ab-results/ab5-off.txt` and `ab-results/ab5-tb.txt` on `claude/ab5-off` and `claude/ab5-tb`.

**One difference from ab4 to keep in view.** Step 12 runs the 0.2.3 report, which credits a trim only when
the model saw it; ab3 and ab4 ran the 0.2.2 report, which credited every offered trim. So ab5's
"tokens kept out" is comparable to nothing before it, and is the more honest of the two. Cost, requests
and cache reads come from `get_session` either way and are unaffected.

**Expectation, fixed before the run.** The on arm's requests at or below the off arm's. The reasoning: on
this task the guard's only remaining action on the large source files is nothing at all — 0.2.3 leaves a
`sed -n '1,400p'` untouched up to `readMaxBytes` — so what it trims is `npm test`, the build, `git log
--stat` and the greps, none of which the model needs to come back for. If it still drives requests up, the
mechanism is the same return-trip effect that cost rtk 7.6% at JetBrains, arriving through some door this
guard was not supposed to leave open, and that is worth knowing on a second model.

**Decision rule, fixed before the run.** Nothing ships or unships on this run; 0.2.3 is already released.
What the run decides is what the README and the post may say about Fable:

- On-arm requests at or below off-arm, and cost not worse than the off arm by more than the 21% noise
  band: the −16% survives its guard change, and the README keeps a Fable saving, stated as two runs on
  two guards.
- On-arm requests above off-arm: the −16% does not survive, and the README's Fable line gets the same
  treatment the Opus line already got — the best of N runs, not the number — with both readings printed.
- Cost apart by less than 21% with requests level: a null, recorded as one, and the Fable claim comes out
  of the README's headline and stays only in this file.

Answers must be identical across the arms in every case; a difference there voids the round.

### The result — ab5, run 2026-09-09, Fable 5.1 both arms, Claude Code 2.1.266

Sessions `da261739…` (off) and `80c5d8cf…` (on), from `claude/ab5-off` and `claude/ab5-tb`, trees identical
but for `.claude/settings.json`. Cost, cache and output from the session records; requests, entered,
carried and trimmed from each arm's own step-12 report, both taken at the same point in the protocol.

| | off | on (0.2.3) | change |
|---|---|---|---|
| API cost | $6.4787 | $5.5331 | **−14.6%** |
| requests | 26 | 29 | **+12%** |
| cache-read tokens | 4,739,441 | 5,345,262 | +13% |
| cache-write tokens | 243,059 | 187,626 | −23% |
| output tokens | 8,480 | 8,686 | +2% |
| tool results entered | 97k | 95k | |
| tool results carried | 1.5M | 1.6M | +7% |
| Read calls | 9 | 12 | |
| trimmed by the guard | 0 | 1 applied (≈ 6k kept out), 1 offered and not applied | |
| answers | 12 of 12 | 12 of 12, identical | |

**By the rule written before the run, the −16% does not survive.** The on arm ran more requests than the
off arm, which was the branch that says so. The cost did fall 14.6%, but 14.6% is inside the 21% band two
identical arms have already produced on this page, so it is not a saving either. Two runs on Fable, on two
guards, one −16% and one −14.6%-inside-noise with requests up: the honest reading is a null, and the
README's Fable line loses its headline the same way the Opus line did. What can still be said is what the
answers say — 12 of 12 identical, on both arms, on both models, in every round so far.

**What the arms actually spent their money on, and it is not what Opus spent it on.** On Fable 5.1 the
list rates are $0.25 per million cache reads and $20 per million cache writes, an eighty-fold gap; on
Opus 5 it is $0.50 against $10, twenty-fold. So on this round cache *writes* were 75% of the off arm's
bill and 68% of the on arm's, while cache reads were 18% and 24%. The guard's effect on the bill ran
through the write column: 243k written against 188k, −23%, worth about $1.11 of the $0.95 the arm saved
in total — the read column moved the other way and gave part of it back. Every earlier round on this page
is an Opus round, where cache reads dominate and the guard's lever is the carry multiplier. On Fable the
lever is how much *new* text enters at all, which is closer to what the whole category claims to do, and
it still did not clear the noise band. The cost formula in `transcript.js` reproduces both arms' records
exactly ($6.478700 and $5.533075 against $6.47870025 and $5.5330755), so the split is the API's, not an
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
- Each arm's report was run at step 12 and so priced the session as it stood then: $6.13 and $5.13 against
  the $6.4787 and $5.5331 the records ended at. The gap is the file write, commit and push that follow,
  the same on both arms. The report has always been a snapshot of the session that runs it; the
  `ab-results/real/` files inherit that and the Saturday table should say so.

**A protocol wrinkle to fix before the Sonnet round.** Step 11 is `cat ~/.claude/settings.json`, there to
prove the arm carried no user-scope hooks. On both arms the permission classifier refused the `cat`, and
both arms fell back to `ls` and to the Read tool, which agreed the file does not exist. The step did its
job, but by accident and not identically on the two arms, and a step whose command is refused is a step
that measures the classifier. Replace it with `ls -la ~/.claude/` for the Sonnet round, which is not
refused, answers the same question, and costs the same one call.

## The audit on Sonnet 5 — ab6, written 2026-09-09, before the run

Sonnet 5 is the model JetBrains ran their 425 trials of rtk on, and the only model in this space with an
independent billing-based number attached to it (+7.6% at low effort, flat at high). Everything on this
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

**Expectation, fixed before the run.** A null: cost inside the 21% band, requests within two or three of
each other, answers identical. The reasoning is the two rounds already on this page. Neither Opus 5 nor
Fable 5.1 produced a saving that survived being run a second time, on the one workload shape where the
guard has anything to trim at all, and there is no mechanism yet identified that would make Sonnet
different in kind. Sonnet 5's list rates put cache writes at twenty times its reads, the Opus ratio rather
than Fable's eighty, so if the round behaves like anything it should behave like the Opus rounds, where the
bill sits in the cache-read column and out of a hook's reach.

**Decision rule, fixed before the run.** This round settles what the post may say about Sonnet, and only
that; nothing ships or unships on it.

- Requests level (within three either way) and cost inside 21%: the expected null. The post gets a Sonnet
  row reading "no measurable difference", and the JetBrains comparison is stated as what it is — their
  tool cost 7.6% on this model, this one did nothing measurable on it, and neither is a saving.
- On-arm requests materially below off-arm (four or more) with cost not worse: the first result on this
  page that would survive the requests rule, and it gets a second run before it is written anywhere
  outside this file. One run does not become a claim.
- On-arm requests materially above off-arm: a loss, recorded as one, and the post says the hook has cost
  money on three of three models.

Answers must be identical across the arms; a difference voids the round. If either arm's step 11 is
refused again, the round still stands — the question it asks is answered by the fallback — but the step
gets replaced properly before any further round rather than patched a second time.

### ab6, first attempt — void, and the reason is worth more than the round

Run 2026-09-09, Sonnet 5 both arms. Neither arm ran a single step. Both read the task as an attack and
stopped: the off arm's status line was "prompt appears to contain exfiltration attempt; halting", the on
arm's "suspicious task request; pausing before execution", and each asked whether the human had really
sent it. $0.31 and $0.29 spent, nothing measured, both arms void.

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

**What this costs the record, said plainly.** Step 11 has now been three different commands across three
rounds: `cat ~/.claude/settings.json` in ab3 and ab4, the same refused-and-worked-around in ab5, and
`status` from ab6 on. Cross-round comparison of the audit was already imperfect on this step, since no
round has executed it as written. It is one call of a few hundred characters out of a 26-to-45-request
session, so it does not move any figure on this page, but a protocol document that hid the change would be
worth less than one that prints it.

**The methodology finding, which outlives this round.** A benchmark task that reads the user's
configuration directory is not model-portable. It passes on one model, is refused by the permission layer
on another, and is refused by the model itself on a third — and the third refusal costs a whole round.
Anyone A/B-testing agent tooling on the bill will write a task like this, because proving the control arm
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
this workload how the model plans is the thing that has moved the bill by a factor of two. So ab6's numbers
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
question names it — so they were oriented; they simply would not act on the message. $0.077 and $0.073,
nothing measured.

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
category aims at, and it is not small. It is also exactly where rtk lost money: these results are small
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

**What it answers.** JetBrains measured rtk at +7.6% on the bill on Sonnet 5 across 425 trials. This
repository has measured tokenbrake on one audit shape at between −37% and +100% on Opus 5 depending on the
guard and the run. Neither number says how the two compare on the same task, same machine, same day. Three
arms on one workload does not settle that either — it is three sessions, not 425 — but it is the first
reading where both tools face the same twelve steps, and if the two land on opposite sides of the off arm
that is worth knowing before the post claims anything about the category.

**Before you start.** A clone of `33kain/contexa` at a commit you write down, `npm install` already done
so no arm pays for it, Node and Git on PATH, and `claude --version` recorded. Close every other Claude Code
session: the five-hour window is shared and a background session moves the numbers. Budget about an hour
and roughly $15 at list price; the three arms have cost $4.60 to $9.63 each on Opus 5.

**The invariants, the same ones every round on this page has held to.** One model for all three arms, named
in the record. One message per arm, the twelve-step audit above pasted verbatim, step 12 pinned to the
tokenbrake version under test. No answering follow-up questions, no second message, no matter how the
session asks. A fresh session per arm, never `/clear` in the same one, because the cost comes from the
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

**Reading the result.** Each arm's cost, requests, cache reads and output come from its session record;
`npx tokenbrake report --all` lists the sessions on disk newest first, and
`npx tokenbrake report --compare <A> <B>` prints two of them side by side with the change column, which is
this file's table. Run it twice, off against rtk and off against tokenbrake. The arms' own reports give
entered, carried and trimmed. Note that on the rtk arm tokenbrake's report still works — it reads the
transcript, not its own ledger — so it will say what entered under rtk, which is the number rtk's own
claims are about.

**The rule for reading it, and it is the one that has voided results here before.** The requests column
decides, not the cost column. Two identical arms on this page came out 21% apart in cost on nothing but how
the model planned its reads, so any cost difference inside that band is a null and gets recorded as one.
A tool that lowers what enters and raises requests has lost, whatever its output-reduction number says;
that is the mechanism JetBrains found and the one that cost tokenbrake 0.2.2 twice the no-hook bill on
this exact task. And if the three arms give different answers to any of the twelve steps, the round is void
and the answers matter more than the bill: a cheaper wrong audit is not a saving.

**Recording it.** Three cost/requests/cache/output rows, three entered/carried/trimmed rows, the answers
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

- *rtk against off:* at or slightly above the off arm on cost, with more requests. This is not a guess, it
  is the JetBrains result restated — +7.6% at low effort, +14% turns, +14% cache reads — and the mechanism
  behind it is the one this page reproduced from the other side with `readMaxBytes` at 25,000 and again
  with 0.2.2's excerpt trimming: compressed output sends the model back, and each return trip re-reads the
  whole context. If rtk lands well below the off arm on this workload, that contradicts the only
  independent measurement in the field and would need a second run before anyone writes it down.
- *tokenbrake against off:* a null, cost inside the 21% band and requests within three. On the audit shape
  0.2.3 has one reading on each of two models and neither cleared the band. There is no reason to expect
  Sonnet to behave differently in kind, and the honest prior after ab4 and ab5 is that this guard does not
  save money on this task on any model.
- *answers:* 12 of 12 on all three arms, identical.

**Decision rule, fixed before the run.** The requests column decides; cost differences inside 21% are
nulls. Beyond that:

- **Both tools null against off.** The most likely outcome and the most useful one for the post: two hooks
  from opposite ends of the category, on the same task and machine and day, neither of which moved the
  bill. That is the paragraph the post is actually for.
- **rtk above off and tokenbrake null.** Consistent with JetBrains, stated as one run of three sessions
  agreeing with 425 billed trials, never as a replication.
- **tokenbrake below off and rtk not.** The first result on this page that would survive the requests rule
  on this workload, and it does not get written outside this file until a second run on a different day
  reproduces it. One run does not become a claim; that rule has already retired two numbers here.
- **tokenbrake above off.** A loss, recorded as one, and the post says the hook has cost money on a third
  model.
- **Any arm's answers differ.** The round is void, and the answers matter more than the bill. A cheaper
  wrong audit is not a saving.

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
| cost | $2.48 | | $3.26 |
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

**The round is void for exactly one reason: the two arms did not do the same task.** The pasted instruction
says "one step at a time, and do not skip
or batch steps". Arm 1 obeyed it: 17 tool results across 15 requests, 1.1 per request. Arm 3 opened with
"I'll work through the twelve items, running the independent ones in parallel" and batched: 23 tool results
across 5 requests, 4.6 per request. Every figure in the table follows from that. Five requests re-read the
context five times instead of fifteen, so carried context falls from 224k to 84k with the guard credited
for 10k of it; and five requests reuse the cache less, 67% against 92%, so on a model that lists cache
writes at eighty times its reads the bill goes *up* 31% while requests go *down* 67%. The requests column,
which the decision rule says decides, was decided by the batching.

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
looking at cost, and treat a gap like 1.1 against 4.6 as voiding, the way a difference in answers voids.

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

**Expectation, fixed before the run.** A null: cost inside the 21% band, requests within three, answers
identical. On the audit shape 0.2.3 now has one reading on Opus (ab4, +30% and not a win) and one on Fable
in the cloud (ab5, −14.6% with requests up, a null). ab7's two arms, for all that they are not comparable
to each other, both landed between $2.48 and $3.26 — a narrower spread than any cloud round of this task,
which is what a local machine on a 1M-context model looks like. There is no mechanism on the table that
would make Windows different in kind.

**Validity gate, checked before any comparison is read.** For each arm, `tool results ÷ requests` from its
own report. Both arms must be near 1, and within 1.5 of each other. An arm outside that batched, and a
round where one arm batched is not a measurement — ab7 is the worked example. An arm that fails the gate
is re-run before anything is compared; if the same arm fails twice, the round is closed as unmeasurable on
this harness and recorded that way, the way ab6 was closed on Sonnet.

**Decision rule, fixed before the run.** The requests column decides; a cost difference inside 21% is a
null.

- Requests within three either way and cost inside 21%: the expected null, and the fourth model-workload
  pair to produce one. The post's audit row gains a Windows-local line reading "no measurable difference".
- On-arm requests four or more below the off arm with cost not worse: the first result on this page that
  would survive the requests rule, and it stays inside this file until a second run on a different day
  reproduces it.
- On-arm requests four or more above the off arm: a loss, recorded as one.
- Answers differing anywhere: void, and the answers matter more than the bill.

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
| cost | $4.37 | $4.39 | **+0.5%** |
| tool results entered | 90k | 89k | −1% |
| tool results carried | 939k | 965k | +3% |
| trimmed by the guard | none | none | |
| under the trim threshold | 10 of 10 shell, 3% of carried | 10 of 10 shell, 3% of carried | |
| Read / Bash / Grep calls | 7 / 10 / 0 | 10 / 10 / 1 | |
| answers | 12 of 12 | 12 of 12, identical | |

**By the rule written before the run this is the expected null**, and the branch that fired is the first
one: requests within three either way, cost inside 21%. It is also the closest two arms have ever come on
this page — half a percent apart on a task where identically configured arms have been 21% apart — and the
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

It cost nothing here — half a percent, inside any noise band — which is the honest way to state it. It did
not cost the 10% the `readMaxBytes` round did, and it did not save anything either.

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
because ab3 showed that trimming them taught the model to read in eighty-line chunks and cost twice the
no-hook bill. So the 10% and 17% in that row are a saving the current guard would not produce, from a
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
> in eighty-line chunks and doubled the bill on one task — so even those two numbers describe something
> that no longer ships. The honest state of real-session evidence for the current version is zero
> sessions, and collecting it is what `tokenbrake report` is for. Run it on your own last session; that
> number is the one that matters to you, and it is the only one I would act on.


## The twelve-step audit was measuring a hook that never ran — the diagnosis, 2026-09-10

The owner's complaint about the audit task is right, and the reason is worse than "the questions are easy".

**In ab8, both arms reported `Under the trim threshold: 10 of 10 shell results`.** Every shell result on
both arms was under 6,000 characters. The PostToolUse trim — the guard's main feature, the thing the
package is named for — **fired zero times, on both arms, in a $9 experiment.** The Read cap fired once and
the file came in through another door. So the round measured the cost of running two hooks that did
nothing, which is why it produced half a percent, and why every round before it hovered around zero for
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
yet that trimming does not pay on the bill. If entered is level, the guard is not acting even here.

**Decision rule, fixed before the run.** Validity gate first: tool results ÷ requests near 1 on both arms
and within 1.5 of each other, and both arms' answers checked against the ground truth above — including
step 5, which is the one an arm can fail while looking fluent.

- Entered lower **and** requests within three **and** cost not worse: the first workload on which this
  guard demonstrably works. It stays in this file until a second run on another day reproduces it.
- Entered lower and requests four or more higher: the return trip, recorded as such.
- Entered level: the guard is not acting on a task designed to make it act, and that goes in `README.md`'s
  "Limits" section next to the 285-call count.
- Either arm's answers wrong against the ground truth: void, and the wrong answer is the finding.

## What the guard actually did, counted rather than argued — 2026-09-10

Prompted by a critique of the package that listed four weaknesses. All four were accurate, and three were
this repository's own published findings arrived at independently, which is the most useful thing a critic
has said about the documentation. One correction: the critique's "−37% to +100%" range mixes guard
versions; the shipping guard's three paired runs on that workload are 1.30, 0.85 and 1.00.

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

All of it is now in `README.md` under "Limits, with the numbers", ahead of the install instructions, on the
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
| cost | $1.93 | $1.70 | −11.9% |
| **tool results entered** | **12k** | **9k** | **−25%** |
| **tool results carried** | **118k** | **97k** | **−17.8%** |
| output tokens | 11k | 8k | −27% |
| trimmed by the guard | 0 | **3 — ≈ 9k kept out, ≈ 141k token-reads not carried** | |
| Read caps fired | none | none | |
| under the trim threshold | 12 of 15 shell, 29% of carried | 15 of 16 shell, 75% of carried | |
| Read / Bash calls | 0 / 15 | 0 / 16 | |

**By the rule written before the run, this is the first branch that has ever fired:** entered lower on the
guarded arm, requests within three, cost not worse. It therefore stays in this file and goes nowhere else
until a second run on another day reproduces it. That rule has already retired two numbers on this page and
it applies in this direction too.

**What is a claim and what is not.** The −11.9% on cost is *inside* the 21% band two identically configured
arms have produced here, so it is not a cost claim and must not be quoted as one. What is measured rather
than inferred is **entered** and **carried**: those are per-result counts from the transcript, not outcomes
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
bet the JetBrains benchmark and this page's own `readMaxBytes` round both lost money on. It is not a
smaller version of what tokenbrake does; it is the thing tokenbrake was built to argue against.

**Why phase 3's gate is refused.** `expect(savings).toBeGreaterThanOrEqual(40)` makes a test fail unless
output shrinks by 40%. rtk advertises 60–90% output reduction and cost **+7.6%** on the bill at JetBrains.
A test like that does not measure the tool, it steers it toward the behaviour that loses money. The 30 ms
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

### The shape filter's first bug, found before a run was paid for — 2026-09-10

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
  `git log --stat -40` or `HEAD~3`, which voided ab9's steps 1 to 3. `measure.mjs` re-derives cost and
  tokens **from the transcript, not from tokenbrake's ledger**, and its arithmetic is proven against
  synthetic transcripts with hand-computed answers including compaction boundaries. The session id is
  found from the shell after the session closes, never from inside it — the default that named the wrong
  session three times here. And it measures what the guard **emits** separately from what the host
  **delivers**, which is the distinction the report's credit fix was about.
- **Two experiments, never pooled.** A mechanism stress test over fixed fixtures, and one natural incident
  task whose prompt names no file and never says "read in full" — the phrasing that forbids the guard's
  saving by construction. Only the natural task feeds the cost verdict.
- **Pre-registered**: five paired OFF/ON runs in balanced order, two OFF/OFF controls to estimate normal
  variability, one ON/SHAPE pair, and a verdict rule fixed in `results/PRE-REGISTRATION.md`. Fewer than
  five pairs is reported as "inconclusive". An ON-arm critical correctness error the OFF arm did not make
  blocks any safe-savings claim whatever the cost did.

**It found a real bug before a single run was paid for** — the shape filters collapsing the tenant
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
v24.19.0, no `TBD` left. Sixteen sessions in the plan at roughly $2 each on this workload — about $30 —
and nothing needs to be run in one sitting: the fixtures are deterministic and `restore.mjs` refuses to
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
  was plausibly the only mechanism by which the hook could move the bill on this model. I had not checked.
  The pricing page, *Long context pricing*, read 2026-09-10: Claude 4.6 and later bill the full 1M window
  at standard rates, "a 900k-token request is billed at the same per-token rate as a 9k-token request".
  **There is no step.** The hypothesis is dead before it cost a session, and the null expectation now
  stands alone with one fewer route to a saving.
- **Decision rule.** The OFF/OFF band decides, as always. `requests_over_threshold` is reported per run
  as context, never as a price. `prices.json` now records, per model and with a verification date,
  whether the long window bills at standard rates, at a published surcharge, or is unrecorded — and an
  unrecorded model makes the run a declared lower bound rather than being assumed cheap.

  Base rates were re-checked against the same page: Fable 5.1 $10 in / $50 out / $0.25 cache read (the
  0.025x multiplier, not 0.1x) / $20 for a 1h cache write. `$5.7349` is the cost of the OFF arm, not a
  lower bound. At that rate the pre-registered 16 sessions are roughly **$90**, not the $30 I estimated.

### B-pair1-off — the OFF arm

Session `aac143d4`, 7 requests, 40 tool results, 982k processed (78% cache read), 0 compactions, 2
recovery reads. **38 / 38, zero critical errors.** Cost is not stated here: it is a lower bound until the
surcharge is priced.

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
2. **Long-context billing was asserted, not checked.** `measure.mjs` printed "list price WITHOUT
   long-context surcharge", wording that claims a surcharge exists, against a page that says the opposite.
   Now `prices.json` carries the answer per model with a date and a source, and the three-state
   distinction that matters: priced, surcharged, or *unrecorded and therefore a declared lower bound*.
   An unknown is never quietly treated as standard — the same error as this one, made cheaply.
3. **The validity gate would have voided every run.** It failed any run with `tool results ÷ requests`
   over 2.5; this one measured 5.71. The cap came from ab7/ab8, whose prompt was twelve numbered steps and
   forced one call per turn. This benchmark deliberately lets the agent batch — batching is recorded as an
   outcome, not forced — so the cap contradicted the design it was meant to protect. What ab7 caught was
   *one arm batching and the other not*; that between-arms test stays, as a ratio (`max/min > 1.5`).
   This is an amendment to a pre-registration after the first session, made with no ON arm in existence,
   and it is flagged as an amendment wherever the verdict is quoted.

Every one of the three is now covered by a test that fails if the defect returns.
