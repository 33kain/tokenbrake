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
