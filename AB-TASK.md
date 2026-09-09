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

