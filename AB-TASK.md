# The A/B run: does brake 1 move the usage limit?

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
