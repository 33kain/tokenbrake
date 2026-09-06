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
