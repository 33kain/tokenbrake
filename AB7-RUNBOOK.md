# ab7 — the rtk head-to-head, at the keyboard

The one round in this project that cannot run in the cloud. Three Claude Code sessions on one clone of
`33kain/contexa`, the same twelve-step audit, differing only in what sits in front of the tools: nothing,
rtk, tokenbrake 0.2.3. Windows, PowerShell. About an hour with the waiting, roughly $10 to $20 at list
price.

Everything needed is on this page. `AB-TASK.md` holds the reasoning and the pre-registered decision rule,
and is where the filled-in result goes back; you do not need it open while running.

## Who runs what — read this first

**This page is for your hands, not for an agent.** Do not hand the runbook to a Claude session and ask it
to carry the round out. The three Claude Code sessions here are the thing being measured, not the operator
doing the measuring, and a session that installs or uninstalls a hook is measuring itself. That is how the
round gets silently voided: every number would come from a session that had already spent requests on
setup, and the arm would no longer be the arm.

The split, exactly:

| what | who |
|---|---|
| Clone, `npm install`, write down commit and versions | you, in PowerShell, outside Claude Code |
| Install / uninstall rtk and tokenbrake, and every `status` check | you, in PowerShell, outside Claude Code |
| The audit text | pasted into each of three **fresh** Claude Code sessions, as the only message, then left alone |
| `report --all` and the two `report --compare` calls | you, in PowerShell, after the third arm |
| Filling in the table and writing the result into `AB-TASK.md` | an agent, afterwards — that part is record-keeping and touches nothing measured |

So: one code block on this page goes into a Claude session, the one under "The task". Everything else you
type yourself. And within each arm, paste the task and send nothing else — no answers to questions, no
follow-ups. An arm that took a second message is recorded as such and is not comparable to one that did
not; see ab6 in `AB-TASK.md` for what that already cost once.

## Decide one thing first: the model

Write it down before you start. All three arms run on the same one.

`AB-TASK.md` pre-registers **Sonnet 5**, because it is the model JetBrains measured rtk on and so the only
one where the rtk arm can be read next to somebody else's number. If you are choosing between **Fable 5.1**
and **Opus 5** instead, take Fable, for a reason this project only learned in ab5: Fable lists cache writes
at eighty times its cache reads, against Opus's twenty, and in the ab5 round cache writes were three
quarters of both arms' bill. A tool whose whole claim is that less text enters the context is therefore
measured on Fable in the column that dominates the bill, and on Opus in a column that is diluted by cached
re-reads. Opus's one advantage is four existing off readings to sanity-check a new one against, and its
disadvantage is larger: on this exact workload its hooks-on runs have ranged $3.77 to $9.63 on nothing but
how it chose to read, which is a factor of two of noise for a design that runs each arm once.

Whichever you pick, the three-arm design carries its own off arm, so the comparison stands on its own.

Self-contained; nothing above needs to be open while running it. Windows, PowerShell. Costs roughly $10 to
$20 at list price depending on model and is about an hour with the waiting.

## Before anything

Close every other Claude Code session; the five-hour window is shared. Then, once:

```powershell
cd $HOME\Desktop
git clone https://github.com/33kain/contexa
cd contexa
npm install
git rev-parse --short HEAD      # write this down; all three arms run from it
claude --version                # write this down
node --version                  # and this
```

**One thing that is different on Windows, and it bears on this round.** The first Windows run (2026-09-09, recorded in
`AB-TASK.md`) found `npm test` on this repository printing 49.4 KB, against 27 KB on Linux. That is past Claude Code's
own ~30,000-character ceiling, so on step 1 the hook receives a truncated result and the model receives a 2 KB
persisted-output preview whatever any hook does. Step 1 is therefore not a step any of the three tools can win, on
this machine, and if the arms differ there the difference is not theirs. Note in the record what step 1 looked like on
each arm.

## Arm 1 — off

Neither tool installed.

```powershell
rtk init -g --uninstall            # even if you think it is not installed
npx --yes tokenbrake@0.2.3 uninstall
npx --yes tokenbrake@0.2.3 uninstall --project
npx --yes tokenbrake@0.2.3 status
```

`status` should print `missing` against all three hooks and against the guard file, and must not print the
"also installed at project scope" line — that line means the guard would run on this arm and voids it.
The clone carries project-scope tokenbrake hooks on `main`, which the third command removes. Do not skip the
`status`; a leftover project hook is the easiest way to void an arm, and it also spawn-tests the node path,
which on Windows contains a space (`C:\Program Files\nodejs\node.exe`) and has broken installs before.

Then `claude` in the clone, paste the task below, send nothing else, and let it finish.

## Arm 2 — rtk

```powershell
rtk init -g                        # then rtk's own status command: confirm the hook is registered
npx --yes tokenbrake@0.2.3 status  # again: three `missing` lines, no project-scope line
```

Fresh `claude` session — not `/clear` in the previous one, which keeps its requests and its cost. Same
paste.

## Arm 3 — tokenbrake

```powershell
rtk init -g --uninstall            # then rtk's status: confirm it is gone
npx --yes tokenbrake@0.2.3 init
npx --yes tokenbrake@0.2.3 status  # PostToolUse, PostToolUseFailure and PreToolUse Read cap all present
```

Fresh session, same paste. (The rtk commands here are the owner's; this page has never run rtk and does not
verify its CLI. Whatever rtk's install, uninstall and status commands actually are, the requirement is only
that exactly one tool is installed per arm and that you confirmed it rather than assumed it.)

## The task — paste verbatim, identical on all three arms

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
11. Run `npx --yes tokenbrake@0.2.3 status` and paste its output.
12. Run `npx --yes tokenbrake@0.2.3 report --top=8` and paste its full output.
```

Notes on the task. Step 10 has no file to read on arms 1 and 2, since the guard is uninstalled there; "the file does
not exist" is the correct answer and the arms should say so rather than hunting for it. Step 11 reports which arm this
was, from the tool's own status, which is why it is that command and not a look at `~/.claude` — see "ab6, first
attempt" in `AB-TASK.md` for what that cost. Step 12 is the measuring instrument and works on all three arms: it reads
the Claude Code transcript, not tokenbrake's ledger, so on the rtk arm it still says what entered and what was
carried, which is the quantity rtk's own claims are about.

## After the third arm

```powershell
npx --yes tokenbrake@0.2.3 report --all                    # session ids, newest first
npx --yes tokenbrake@0.2.3 report --compare <off> <rtk>
npx --yes tokenbrake@0.2.3 report --compare <off> <tokenbrake>
```

## The record to fill in

Paste this filled out into a new `### ab7 — the result` section in `AB-TASK.md`.

```
ab7 — <date>, <model>, Claude Code <version>, Node <version>, commit <sha>, Windows

                              off        rtk        tokenbrake 0.2.3
API cost
requests
cache-read tokens
cache-write tokens
output tokens
tool results entered
tool results carried
Read calls / Bash calls
trimmed by the guard
step 1 (npm test) as delivered
answers                       __ of 12   __ of 12   __ of 12
```

Then the verdict against the decision rule in `AB-TASK.md`, in its own words, including which branch of it fired.
If any arm was void — a tool that would not install, an arm that refused the task, a second message sent —
say so and say what it cost, the way the rtk arm of ab3 and both arms of ab6 are recorded. An arm that did
not run is not a zero; it is a hole, and a hole that is written down is worth more than a number that is
not.