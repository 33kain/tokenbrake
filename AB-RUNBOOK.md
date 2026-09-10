# The A/B at the keyboard — current round: ab9, the review task

**Two arms: no hooks, and tokenbrake 0.2.4.** Two Claude Code sessions on one clone of `33kain/contexa`,
the same twelve-step audit, differing only in whether the guard is in front of the tools. Windows,
PowerShell. About forty minutes with the waiting, roughly $6 at list price.

rtk is not part of this round. A head-to-head against it needs rtk installed on the machine first and is a
separate round on a separate day; ab7 discovered mid-round that it was not installed, and this page's
history of that is in `AB-TASK.md`.

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

## Step 0 — put the machine in a known state

If you have already tried this once, start here regardless of what you think is installed. The one thing
that silently voids an arm is a leftover hook, and neither tool's own command can see the other's. So look
at the file both of them write to, which is the ground truth:

```powershell
type $HOME\.claude\settings.json
```

- **File not found** → no user-scope hooks at all. That is the clean state. Good.
- **It prints JSON with a `hooks` block** → something is installed at user scope. Read it: entries naming
  `tokenbrake` or `guard.js` are tokenbrake's, entries naming `rtk` are rtk's.

To clear tokenbrake from user scope: `npx --yes tokenbrake@0.2.4 uninstall`. To clear rtk, use rtk's own
uninstall. If rtk's uninstall does not work or you are not sure of the command, you can edit
`$HOME\.claude\settings.json` by hand — delete the hook entries that name rtk, or if the whole file is
nothing but hooks you installed, delete the file. Claude Code treats a missing user settings file as no
user-scope configuration, which is exactly what arms 1 and 2 need. Back it up first if you have other
settings in there:

```powershell
copy $HOME\.claude\settings.json $HOME\.claude\settings.json.bak
```

Then confirm, and this is the check to trust over any tool's status output:

```powershell
type $HOME\.claude\settings.json     # "cannot find" is the answer you want
npx --yes tokenbrake@0.2.4 status      # backs it up for tokenbrake specifically
```

**Why this and not `rtk status`.** The first version of this page told you to run rtk's own status command
without saying what it is, because this project has never run rtk and does not know its CLI. That was a
hole in the instructions and it cost you an evening. Reading `settings.json` needs no tool's CLI at all,
shows every hook whichever tool installed it, and cannot be out of date.

## Before anything else

Close every other Claude Code session; the five-hour window is shared. Then, once:

```powershell
cd $HOME\Desktop
git clone https://github.com/33kain/contexa
cd contexa
npm install
git fetch origin
claude --version                # write this down
node --version                  # and this
```

If you already cloned it last night, `cd` into it and run `git fetch origin` instead of cloning again.

**One thing that is different on Windows, and it bears on this round.** The first Windows run (2026-09-09, recorded in
`AB-TASK.md`) found `npm test` on this repository printing 49.4 KB, against 27 KB on Linux. That is past Claude Code's
own ~30,000-character ceiling, so on step 1 the hook receives a truncated result and the model receives a 2 KB
persisted-output preview whatever any hook does. Step 1 is therefore not a step any of the three tools can win, on
this machine, and if the arms differ there the difference is not theirs. Note in the record what step 1 looked like on
each arm.

## How the arms differ — tokenbrake is never installed or uninstalled

This is the part that was hardest last night, and it was harder than it needed to be. Two branches of the
clone already carry the two configurations, so **tokenbrake is switched with `git checkout`, not with
`init` and `uninstall`**:

| branch | `.claude/settings.json` | used by |
|---|---|---|
| `claude/ab9-off` | `{"hooks": {}}` — no hooks | arm 1 (off) |
| `claude/ab9-tb` | the full 0.2.3 project install | arm 2 (tokenbrake) |

Both branches are cut from the same commit (`338053f`) and their trees differ in that one file and nothing
else. **Nothing is installed or uninstalled in this round at all** — the arms switch with `git checkout`.

Do not run `npx tokenbrake init` at any point. If you already did last night, undo it with
`npx --yes tokenbrake@0.2.4 uninstall` in step 0; a user-scope install would run on all three arms and void
the round.

## Arm 1 — off

```powershell
git checkout claude/ab9-off
npx --yes tokenbrake@0.2.4 status
```

`status` should print `missing` against all three hooks and against the guard file, and must **not** print
the "also installed at project scope" line. If it does print that line, you are on the wrong branch — check
with `git branch --show-current`.

Then `claude` in the clone, paste the task below, send nothing else, let it finish, and capture it per
"After each arm" below.

## Arm 2 — tokenbrake

```powershell
git checkout claude/ab9-tb
git branch --show-current
npx --yes tokenbrake@0.2.4 status
```

`status` should now name the project scope — the three hooks present there — while user scope stays
`missing`. A line saying the guard "runs once, from there" is the right one; on tokenbrake 0.2.3 that line
reads "runs twice per call here", which is a wording bug fixed after this round and means the same thing
when user scope is missing. Ignore it.

Fresh `claude` session — a new terminal, not `/clear` in the previous one, which keeps its requests and its
cost. Same paste.

## Check each arm before trusting it

Two things void an arm, and both are visible the moment it finishes.

**Batching.** The task says one step at a time. An arm that says something like "running the independent
ones in parallel" has ignored it, and its request count is then about how it planned rather than about the
tool under test. The check is one division, from that arm's own report: `tool results` ÷ `requests`. Around
1 is what the protocol asks for. The first hand-run round had one arm at 1.1 and another at 4.6, and the
round was void — the arm with 4.6 spent a third more money on a third of the requests, and none of it was
the hook. If two arms are more than about 1.5 apart on that ratio, they did not do the same task; re-run
the offending arm before comparing anything.

**Different answers.** Any of the twelve differing across arms voids the round outright, whatever the bill
says. A cheaper wrong audit is not a saving.

## After each arm — what to save

Do this the moment an arm's twelve lines are on screen, before starting the next one. Nothing here is
recoverable later except from the transcript, so save it now.

1. **Copy the session's whole final answer** — the twelve lines plus the two pasted blocks — into a text
   file: `arm1-off-answer.txt`, `arm2-rtk-answer.txt`, `arm3-tb-answer.txt`. Plain copy-paste from the
   terminal is fine.
2. **Write down the session id.** It is the first line of the step-12 report inside that answer:
   `Session abc12345…  C:\Users\...\contexa`. The first eight characters are what you need.
3. **Close that Claude Code session.** Then, from PowerShell:

```powershell
npx --yes tokenbrake@0.2.4 report --all
npx --yes tokenbrake@0.2.4 report --session=<the 8 characters> --top=8 > arm1-off-report.txt
```

**Do not trust the session id printed by step 12.** `report` with no `--session` opens the newest transcript
on disk, and on Windows a live session's transcript can have a stale modification time, so the report an arm
runs *inside itself* can describe a different session entirely. It has happened twice: once giving a false
alarm, once giving plausible wrong numbers that would have gone straight into the table. Find the id from
`report --all` after closing the session — the arm is the newest row with this repository's path — and
sanity-check the arm you think it is. The reliable check is the **ledger row count** on the
`tokenbrake trimmed` line: it grows by one per tool call of a session the guard ran in, so the guarded
arm's count should exceed the off arm's by about that arm's number of tool results. An off arm that reports
a *trim* is certainly the wrong session — an arm with no hooks cannot trim anything — but a guarded arm
reporting `trimmed none` is not: if every shell result was under the threshold and every read was bounded,
the guard had nothing to do, which is exactly what ab8 measured.

**This last report, not the one from step 12, is the number that goes in the table.** Step 12 runs while the
session is still going, so it prices and counts the session as it stood at that moment — it misses the
requests that came after. Run from PowerShell once the session is closed, the same command reads the
finished transcript and gives the final figures. `--all` lists the sessions newest first if you lose track
of which id is which.

That file gives you every row of the table: `requests`, `At list price` (the cost), `Tool results entered`,
`carried`, the `tokenbrake trimmed` line, and the by-tool table with Read and Bash call counts. There is no
separate place to look and nothing else to keep.

## The task — paste verbatim, identical on both arms

This is the **review task**. It replaced the twelve-step audit, and then replaced a trace task that was
only a harder version of the same quiz. The audit measured a hook that never ran: in ab8 every shell
result on both arms sat under the trim threshold, so the guard's main feature fired zero times in a nine-
dollar experiment. This one is real work -- a release review and a mechanism trace -- built from measured
output sizes so that four steps land in the band where the trim actually acts, one step fails with 17k
already printed, and one step gives the Read cap the only chance in nine rounds to *save* rather than cost.

`AB-TASK.md` carries the reasoning and the **ground truth for every answer**. Check both arms against it:
two arms agreeing on a wrong answer is not a passing round, and step 5 is one an arm can fail while
sounding perfectly fluent.

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

Step 3 is the one to watch. `CHANGELOG.md` is 237 KB, about 59k tokens, and Claude Code's Read tool
refuses a file over roughly 25k -- so on the **off** arm expect an error and a second, bounded attempt, and
on the **guarded** arm expect 300 lines handed back by the PreToolUse cap before the tool runs. Every round
so far has given the Read cap opportunities to hurt and none to help; this is the first that asks.

## After both arms

```powershell
npx --yes tokenbrake@0.2.4 report --all                    # session ids, newest first
npx --yes tokenbrake@0.2.4 report --compare OFFID TBID
```

Use the two session ids without angle brackets. `--compare` prints both sessions side by side with a change
column, which is most of the table below already worked out; save it to a file too.

## The record to fill in

Every row comes from the per-arm report file you saved under "After each arm". Nothing here needs a website,
a usage page or any other tool — the line each number sits on is named in the left column.

```
ab9 — <date>, <model>, Claude Code <version>, Node <version>, commit 338053f, Windows

                                                    off        tokenbrake 0.2.3
requests                    ("N requests")
context processed           ("Context processed")
% read from cache           (same line, in brackets)
output tokens               (same line, "output N")
cost                        ("At list price: ≈ $")
tool results entered        ("Tool results entered ≈")
tool results carried        (same line, "carried through later requests ≈")
trimmed                     ("tokenbrake trimmed" — arm 2 only; "none" on arm 1)
under the trim threshold    ("Under the trim threshold")
Read calls / Bash calls     (the "By tool" table at the bottom)
step 1 (npm test) as delivered   (what the arm said in its line 1)
tool results / requests (the validity gate)
answers                                             __ of 12   __ of 12
```

Two notes on the cost row. It is the report's own figure, not a bill you look up: the formula reproduces
the API's records to the cent on both Opus 5 and Fable 5.1 (`AB-TASK.md`, ab5), so it is the number, not an
estimate. And it counts the whole session including the writing at the end, which is why the report has to
be run from PowerShell after the session is closed rather than read off step 12.

Then the verdict against the decision rule in `AB-TASK.md`, in its own words, including which branch of it fired.
If any arm was void — a tool that would not install, an arm that refused the task, a second message sent —
say so and say what it cost, the way the rtk arm of ab3 and both arms of ab6 are recorded. An arm that did
not run is not a zero; it is a hole, and a hole that is written down is worth more than a number that is
not.