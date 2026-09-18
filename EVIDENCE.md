# tokenbrake — the evidence

Everything measured about the brake so far, the losses included. It moved here from the top of the README on
2026-09-18, word for word: it is the most important thing to read before installing the brake, and the wrong
second thing to read about a report you can run without installing anything. The full protocol and every
number are in [`AB-TASK.md`](AB-TASK.md); the pre-registered benchmark is
[33kain/tokenbrake-bench](https://github.com/33kain/tokenbrake-bench).

**Since this was written (2026-09-18).** Two figures below are now known to be too generous to the brake,
and the correction runs in the same direction as everything else here:

- The reach figures counted single-file excerpts (`cat`, `sed -n`, `head`, `tail`) as results the trim
  could act on. The guard reads those like a Read and never trims them. With them counted apart, the trim's
  window on the machine this was written on is **11.6% of everything carried** over 55 sessions, and **7.5%**
  over the 24 the guard ran in (it read ~18% before the fix).
- The report line quoted below as "Under the trim threshold" is now "Small shell output, at or under the
  threshold (excerpts and failures included)" — the same count, labelled for what it includes.

## The A/B runs

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

## Limits, with the numbers

Read this before installing. It is the part most tools in this space leave to their critics.

**The trim's window is narrow on three sides at once.** A shell result is rewritten only if it is over
6,000 characters (below that it is left alone), under Claude Code's own ~30,000-character ceiling (above
that Claude Code persists the output to a file and hands the model a preview, and the hook's replacement is
never applied), and exited zero (a non-zero exit fires `PostToolUseFailure`, where Claude Code ignores the
replacement — see `AB-TASK.md`, "The failing command"). So the biggest outputs and every failing one are
out of reach, and what remains is medium-sized successful output.

**Measured on one machine's ledger: 285 tool results, and the trim applied to none of them.** 282 were
under the threshold. The three over it were two single-file excerpts — which 0.2.3 deliberately leaves
alone, because trimming them taught the model to read in eighty-line chunks and doubled the bill on one
task — and one MCP result, which is not a shell result. The Read cap fired zero times in the same 285. That
sample is biased toward well-behaved output: the repository it came from tells its agents to read with
bounded `sed` ranges, which is exactly the case where there is nothing to save. It is still 285 real calls
in which the hook did nothing.

**Results under the threshold are most of the cost.** In one working session they were 57% of all context
carried; in an audit session, 79%. Compressing them is what the rest of this category does, and it is where
the JetBrains benchmark found rtk losing money, so tokenbrake does not — but the share it declines to touch
is the majority of the bill.

**Generic trimming can keep the wrong three things.** Head, tail and error-looking lines are a guess about
what matters. The one measured instance of that guess being wrong is in this repository's own history: on
source-file excerpts those are the wrong three things, which is why 0.2.3 stopped trimming them. No round
has produced a wrong *answer* — every arm of every A/B has agreed, 12 of 12 — but the mechanism is real.

**No repeatable saving has been demonstrated on the bill, by any version, on any workload.** On the
read-heavy audit the shipping guard's three paired runs came out at 1.30, 0.85 and 1.00 times the no-hook
cost. Two debugging rounds and a feature round were flat. The best figure ever recorded, −37%, is one run
of eight on that shape and is not reproducible; the worst, +100%, came from a guard behaviour since
removed.

**And now the number behind that sentence: two identical sessions without the hook differ by up to 30%
on the bill.** A 22-session pre-registered benchmark
([33kain/tokenbrake-bench](https://github.com/33kain/tokenbrake-bench)) ran a synthetic incident review
five times with the hook and five times without, plus three OFF-against-OFF control pairs — the same
configuration on both sides, no hook at all. Those controls came out **5.7%, 18.4% and 30.3% apart**, and
on tokens entered, **42.6% apart**. The paired runs with the hook showed a median 28.8% lower cost and
35.7% fewer tool-result tokens, and **both sit inside that noise**. The agent simply reads differently
every time.

So the honest reading of that round is not that the hook does nothing. It is that **five pairs cannot
resolve an effect of this size against variation of this size**, and anyone claiming a percentage saving
from a handful of sessions — this package included — is measuring the agent's mood. The round's own
verdict flipped from "cost reduction" to "no measurable difference" when the third control was added, and
both the flip and the flaw found in the rule that caused it are in that repository's `DEVIATIONS.md`.

One thing in that round is sharp rather than inconclusive, and it is the most useful sentence here:
**tokens entering context fell in every single pair, while tokens *carried* — size times the number of
later requests that re-read them — fell in only four of six and rose in two, once by 72.6%.** Carried is
where the money is, since a result is paid for again on every later request. So the hook reliably shrinks
what enters and does not reliably shrink what is carried: when a trim sends the model back for what was
cut, the session lengthens and carried climbs past where it started. That is the whole null, in one line.
(Post-hoc, not pre-registered, and recorded as such.)

What the same 22 runs did establish: **the hook never cost a correct answer.** Every run scored 38 of 38
against a hidden answer key, with zero critical errors, on a task with more than twenty warning-shaped
distractors. And **every run with the hook made more recovery reads than its partner without** — the model
going back for what was cut — which is the mechanism's own price, now reported by `report`.

**Real-session evidence for the current version is zero sessions.** Every `ab-results/real/` file on record
predates 0.2.3, and the only one showing substantial savings got them from the excerpt trimming that 0.2.3
removed.

**The measuring tool itself has been wrong twice.** It credited tokenbrake with tokens Claude Code had kept
out, until the first Windows run caught it; and on Windows a live transcript's modification time can lag,
so `report` run from inside a session picked a different session — twice, once producing plausible wrong
numbers. Both are fixed and both are recorded.

**The report tells you this about your own sessions, in dollars.** Since 0.2.5 it prints `Within the
guard's reach`, `Out of reach`, `Acted on`, `Still within reach` and `Recovery reads`: how many of your
tool results the hooks could ever touch, why the rest are beyond them, what share of your carried context
that is, what the trims took off this session's bill at list price, what is left untrimmed and what that
is worth — and what the model's return trips for trimmed content cost you. The benchmark found the saving
lives in *carried* tokens rather than in the size of any one result, and that the number of trims does not
predict it: two trims produced a 39% paired difference where seven produced 12%. On the session that produced the count above
it read 2 of 450 results, 8% of everything carried, acted on none. That is the number that answers "would
this have helped me", and it is the one thing here worth running whatever you decide about the hooks.

**What it is not: the only tool that reads your transcripts.** An earlier version of this file claimed no
other tool in this space reports its own inapplicability. That was written without checking and is
withdrawn. Several projects already parse the same `~/.claude/projects/**/*.jsonl` files for tokens and
cost — [token-dashboard](https://github.com/nateherkai/token-dashboard),
[cc-analyzer](https://github.com/yorch/cc-analyzer),
[claude-token-analyzer](https://github.com/li195111/claude-token-analyzer),
[claude-session-analyzer](https://github.com/yonk-labs/claude-session-analyzer),
[ccost](https://github.com/toolsu/ccost) among them — and Claude Code itself now ships `/usage`,
`/context` and OpenTelemetry export with per-tool attribution. If you want tokens and cost by session or
by day, use one of those; they do it better and they are not attached to a hook.
What this report has that a survey of those did not turn up is narrower: `carried`, which charges a cost
to an **individual tool result** by how many later requests re-read it, and the reach denominator, which
is specific to the question of whether a trimming hook could act on your sessions at all. "Did not turn
up" is not "does not exist", and this file will not make that mistake twice.

What follows from all of that: **run `tokenbrake report` on your own last session before installing
anything.** The "Tool results entered" and "Under the trim threshold" lines say whether you have the kind
of session this can act on. Most sessions are not.
