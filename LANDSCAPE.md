# The field, 2026-09-09

What else does the job tokenbrake does, how each one measures itself, and where tokenbrake is behind or
ahead. Written from source and documentation, not from live runs of the others. Sources at the end.

## The tools

| tool | mechanism | touches | how savings are measured | stars, license |
|---|---|---|---|---|
| **rtk** | PreToolUse rewrites `git status` to `rtk git status`; a Rust binary filters output per command, 100+ commands | Bash only | claims 60–90% output reduction, bytes/4. JetBrains ran 425 billed trials on Sonnet 5: **+7.6% cost** at low effort, flat at high, +14% turns, +14% cache reads | 79.6k, Apache 2.0 |
| **chop** | the same idea in Go, 60+ commands plus auto-detection of JSON, CSV and logs | Bash only | per-command claims (git status 95%), self-reported | 44, MIT |
| **squeez** | Pre- and PostToolUse: Bash compression, Read/Grep limit injection, cross-call dedup, verbatim stash retrievable over MCP | Bash, Read, Grep; five hosts | 91% on 46 fixtures, tokenizer-verified on the fixtures, not on sessions | 200, Apache 2.0 |
| **claude-context-optimizer** | advisory plugin: blocks re-reads of unchanged files, heatmaps, budget alerts | Read | "30–50% wasted", from a read-but-never-edited heuristic | 110, MIT |
| **shunt** (Spotify Portal) | blocks Reads over 350 lines and routes them to a cheaper model | Read | about 90% on bulk reads of one Java monorepo | not fully open |
| **tokenbrake** | PostToolUse generic trim over 6,000 chars, Read cap, persisted-output cap, `report` | Bash, Read | session billing records, A/B with the nulls kept: on a read-heavy audit the range is −37% to +100% across eight runs on two models and four guard versions, with nothing that repeats; ≈ 0 on debugging, ≈ 0 on a small feature (`AB-TASK.md`) | 0 humans, MIT |

## What the JetBrains benchmark means

The largest tool in the space cost more on the bill in a controlled run. The reasons the authors give are
the ones `AB-TASK.md` found from the other side the same week: compressed output sends the model back for
re-reads, and each return trip is a request that re-reads the whole context; cached re-reads dominate the
bill and sit beyond a hook's reach; and rtk counted raw output as its counterfactual while ignoring Claude
Code's own truncation and cache pricing. The readMaxBytes A/B lost money the same way and is recorded as a
loss. The category's claims are output reductions. The bill is a different quantity, and on the bill the
honest range so far is 0 to 37% at best and worse than nothing at worst, workload-dependent, with the
model's own habit of bounding its reads deciding which end a session lands on. Since ab5 there is a second
caveat: the two models do not spend alike. On Opus 5 cache reads carry the bill and a hook's lever is the
carry multiplier; on Fable 5.1, where writes cost eighty times reads, cache writes were three quarters of
both arms' cost and the lever is how much new text enters at all. A claim measured on one model does not
transfer to the other, and this table's own row is the first thing that has to say so.

## Behind

1. **Small outputs.** rtk, chop and squeez compress `git status`, passing test lines, `ls`, `docker ps`,
   below tokenbrake's 6,000-character threshold. In the 40-request audit session, 79% of carried context
   was small excerpts under `maxChars`, untouched. The route that does not repeat rtk's mistake is shape
   filters, not command tables: collapse repeated lines with a count, collapse passing-test lines, strip
   ANSI and progress bars, compact JSON that parses. Threshold around 1,500 characters. A/B'd with the
   protocol in `AB-TASK.md` before it is default-on, because this is exactly where rtk lost money.
2. **Repeat reads.** squeez and claude-context-optimizer suppress re-reads of unchanged files. Measured on
   the session that wrote this: 24 same-shape reads, zero exact repeats in 522 requests. So there is no
   evidence yet that it matters, only their claims. `report` now prints a "Repeat reads" line, so the
   `ab-results/real/` files will say whether it does. Any suppression must reset at a compaction, since a
   re-read after one is legitimate: the first copy is gone.
3. **Grep.** No cap on tokenbrake's side; squeez injects a head limit. Cheap to add, but Grep was under 1%
   of carried context in every measured session. `report`'s by-tool table is the trigger for doing it.
4. **Reach.** Not a feature gap. Nobody knows the package exists; the launch post is the fix.

## Ahead

- **The number is the bill.** Every headline figure is a session cost from the API's own usage record,
  hooks off against hooks on, with run-to-run noise measured (21% between identical arms) and the nulls
  published. No other tool in the table has a billing-based comparison, and the only independent one, the
  JetBrains run, went against the tool it measured.
- **`carried`**, size times the requests that re-read a result, per tool result. The others attribute per
  message or per file; the per-result multiplier is what names the one read that cost a fifth of a session.
- **The persisted-output cap** (0.2.1): output that was too big to show inline is capped when read back
  whole, whatever `readMaxBytes` says. Not found anywhere else. Re-reads of those files were 96% of the
  untrimmed audit arm's carried context and 24% of the session that wrote the rule.
- **300 lines, no binary, no dependencies.** Full text on disk, path named in the note; plugin or `npx`.

## Two Claude Code facts that bound the design

The Read tool refuses a file over 25k tokens in the CLI and over 10k on the Desktop app, so on Desktop a
40 to 60 KB file fails before the 60,000-byte cap fires; the model then reads it bounded on its own, one
error round-trip later. And the request to make Bash truncation configurable was closed as not planned.

## Plan, in order

1. `report`: the "Repeat reads" line (done), and Grep's share is already in the by-tool table. Collect a
   week of `ab-results/real/`.
2. Shape filters for small outputs, behind a config flag, A/B'd on the audit and the feature task before
   default-on.
3. Repeat-read suppression only if step 1 shows repeats are common; compaction-aware.
4. The post leads with the bill, cites the JetBrains benchmark, and lists the nulls.

## Sources

- rtk: https://github.com/rtk-ai/rtk
- JetBrains, rtk benchmark: https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/
- chop: https://github.com/AgusRdz/chop
- squeez: https://github.com/claudioemmanuel/squeez
- claude-context-optimizer: https://github.com/egorfedorov/claude-context-optimizer
- Spotify Engineering, Portal: https://engineering.atspotify.com/2026/9/portal-by-spotify-cut-my-claude-code-token-usage-by-90
- Show HN, Claude Token Analyzer: https://news.ycombinator.com/item?id=48545313
- claude-code #40100, Bash truncation: https://github.com/anthropics/claude-code/issues/40100
- claude-code #40357, Read limit: https://github.com/anthropics/claude-code/issues/40357
- claude-code #32105, updatedToolOutput: https://github.com/anthropics/claude-code/issues/32105
