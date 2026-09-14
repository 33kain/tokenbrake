# Features plan — the 10-feature roadmap

State + plan for the ten features selected on 2026-09-13. Written in the `HANDOFF.md` style: this is
state, not conversation. Pick it up in Claude Code; keep it in step as waves land.

## The ten features

Selected from a 20-item brainstorm by comparison-scoring (marks in the session that produced this file).

1. **MCP tool-output trimming** — extend the guard past `Bash`/`Read` to shape large `mcp__*` results.
2. **Per-tool trim profiles** — per-tool knobs in `tokenbrake.json` (`tools: { Bash: …, Grep: … }`).
3. **First-class retrieval of withheld output** — `outputs` lists, `show <id>` prints, saved `out/<id>.txt`.
4. **Doctor / self-heal** — one health check with a prioritized problem list; `--fix` repairs a stale guard.
5. **JSON/CSV/XML-aware shaping** — collapse long uniform arrays to schema + sample + count.
6. **Repeated-result dedup** — replace an identical in-session result with a pointer to the first.
7. **Config presets/profiles** — named `off`/`minimal`/`balanced`/`aggressive`, one command to apply.
8. **Cost & pricing model** — carried/saved tokens → dollars via a per-model price table.
9. **Allowlist/denylist by command or path** — never-trim / always-trim rules.
10. **Config what-if simulation** — replay a transcript under alternative config to estimate savings.

## They compose, they do not conflict

Five run inside the guard (the trim pipeline); the rest sit around it as config / reporting / diagnostics.

Guard pipeline order (a tool result flows top to bottom):

```
tool result
  → 9  allow/deny        (act at all? allow-list wins over everything)
  → 1  routing           (MCP result vs Bash vs Read)
  → 2  per-tool profile   (selects maxChars / strategy for this tool)
  → 6  dedup             (hash the ORIGINAL bytes, before shaping)
  → 5  JSON/CSV shaping or generic head/tail
  → 3  save full output → out/<id>.txt   (before the cut)
  → ledger → feeds 8 (cost) and 10 (simulation)
```

Config precedence: `allow/deny (9)` → `per-tool profile (2)` → `preset (7)` → global `tokenbrake.json` → defaults.

Invariants that hold the set together:
- **Fail-open per stage** — each stage catches its own error and passes the result through untouched.
- **One ledger schema** — the single source of truth for `report`, cost, and simulation.
- **Simulation calls the SAME trim function as the guard** — otherwise its estimate diverges from reality.
- **Dedup pointer resolves for retrieval** — a "same as #N" result must still be fetchable via `show`.

## Waves (build order: safe → risky)

- **Wave 1 — config / report / diagnostics, no A/B needed.** presets (7), per-tool profiles (2), cost (8),
  doctor (4), retrieval (3). Adds value immediately without changing what enters context.
- **Wave 2 — changes what enters context, A/B per `AB-TASK.md` before any default moves.** allow/deny (9),
  MCP trimming (1), JSON/CSV shaping (5), dedup (6).
- **Wave 3 — needs the pure trim module.** simulation (10).

### Deferred: the `trim.js` extraction

Pulling the trim engine out of `guard.js` into a pure module is the keystone for shaping (5) and simulation
(10) and pays off there. It is **deliberately deferred out of Wave 1**: the guard installs as a single copied
file (`init` copies `guard.js`; `status`/`test.mjs` pin that one copy byte-for-byte), so splitting it changes
the install mechanics and the drift check for no Wave-1 benefit. Do it as the first step of Wave 2/3, and
update `init` (copy both files), the `status` drift check, and the `test.mjs` byte-identity pin together.

## Progress

- **Wave 1 — DONE.** All five shipped with tests (suite green, 397 checks):
  - increment 1: `preset`, `outputs`/`show`, `doctor [--fix]` — `cli.js` only, no guard-behavior change.
  - `tools` map per-tool profiles (2) — `guard.js` `toolConfig()`, committed guard copy re-synced.
  - `report --cost [--model]` (8) — cost by token type/model + saving + what-if reprice. Reuses the new
    pure `transcript.trimSavings()`, extracted from `renderReport` (numbers unchanged, report byte-identical).
- **Wave 2 — in progress.**
  - allow/deny (9) — DONE. `noTrim` (allowlist) and `alwaysCap` (denylist), substring match on command/path,
    in both guard handlers. Both default to empty, so they change nothing until set — no A/B needed. Guard
    copy re-synced; 5 new checks.
  - Resequenced: the `trim.js` extraction is moved to sit **immediately before MCP trimming (1) and JSON/CSV
    shaping (5)**, which actually build on the trim engine — rather than up front, where it would carry the
    single-file-install risk with no Wave-2 payoff yet. allow/deny needed no extraction and shipped first.
  - JSON-aware trim (5) — DONE. `jsonShape` (default false) makes `trimText` keep a sample of the big array
    plus a count for a JSON result, instead of a char slice. Runs only in the trim path, so the full output
    is always saved. Ships off; A/B gates turning it on. Guard copy re-synced; 5 new checks.
  - MCP trimming (1) — **CLOSED: code done, accept side verified live, A/B measured — default stays OFF (opt-in per-tool).** The shape was the blocker, and
    it was captured live on 2026-09-13 from `mcp__github__list_commits` in a Cowork session with the guard on:
    an `mcp__*` result arrives as a content-block array `[{type:'text',text},…]` — the whole result, in full —
    and the guard sees it *before* Claude Code's own "too large → saved to a file, 2 KB preview" step (ledger
    `chars` 52,960 against the 2,245-char preview the model was left with; the 52 KB file is then re-read whole,
    the persisted-output carry the product exists to cut). `guard.js` now routes an `mcp__*` result through the
    same `trimText` pipeline and rebuilds the reply in the shape it arrived in — bare array, `{content:[…]}`
    wrapper, or bare string (`mcpBody`) — behind `mcpTrim` (default false). Full output saved to `out/`; pairs
    with `jsonShape` since MCP bodies are usually JSON; a per-tool profile or `noTrim` (matches the tool name)
    targets one server. Guard copy re-synced; 6 new checks pin the array shape — the MCP analogue of the Bash
    `{stdout}` regression. **Accept side verified live on 2026-09-13** (this Cowork session, guard on,
    `{mcpTrim:true, jsonShape:true}`): the same `mcp__github__list_commits` that ran untrimmed at the top of the
    session came back carrying the marker — `[tokenbrake] showing the first 5 of 30 array items (50,196 chars).
    Full output saved to …/out/…txt`. So Claude Code *accepts* the content-block-array `updatedToolOutput` for
    an `mcp__*` tool; the silent-rejection risk is cleared and jsonShape composed (ledger `mcp:true`, `kept`
    9,145, full output saved). A side finding: the guard's *content* is re-read from disk on each hook spawn, so
    `init --project` + a live call verifies the accept side in-session — no fresh container needed. **A/B measured
    2026-09-14** (AB-TASK.md, "MCP tool-output trimming", Opus, two single pairs): `mcpTrim` on **helped a glance
    workload** and **hurt a content-hungry one** (recovery reads). The raw deltas (glance −25% cost / −18.5%
    context; content-heavy +46% cost) are within this repo's own identical-arm noise (ab10: ±30% cost / ±42%
    tokens) — read only the *direction*, not the magnitude. **Default stays OFF** (the burden of proof is on the flip, not on staying off);
    ships **opt-in, best per-tool** for glance-heavy MCP tools, pairs with `jsonShape`. The per-tool opt-in
    net-win is reasoned from the mechanism, not yet A/B-confirmed. **MCP (1) is closed.**
  - dedup (6) — DONE. `dedup` (default false) hands back a pointer to the first copy when a Bash/PowerShell or
    `mcp__*` result over `dedupMinChars` (1,000) repeats byte-for-byte in a session. The guard is one stateless
    process per call, so state is a per-session **append-only JSONL** under `dedup/<session>.jsonl` (append, not
    rewrite, so concurrent calls can't lose each other's entry). Hashes the original bytes before shaping; the
    first copy is saved to `out/` so the pointer resolves via `tokenbrake show` (ties to feature 3); pointer
    rebuilt in the tool's shape; honors `noTrim`; fails open throughout. Ledger row `{dedup, sameAs, chars,
    kept}` → `report` credits it via the existing chars−kept path. Ships off; A/B gates the default (same
    recovery-read risk as mcpTrim). Guard copy re-synced; 8 new checks.
  - Remaining: **`trim.js` extraction → simulation (10)** — Wave 3. The extraction is the only thing left that
    truly needs a shared pure trim module (simulation calls the engine from `cli.js`); it also changes the
    single-file install (copy both files, drift-check both, pin both in `test.mjs`), so it is done right before
    simulation, not before.

## The flowchart phase — narrow the request, not just the response

The ten features above trim the *response* (PostToolUse). The next direction narrows the *request*
(PreToolUse): a semantically-targeted narrow result has a lower recovery-read rate than a generic head/tail
trim, so lower net carried tokens — but a wrong narrowing forces a costlier full re-run, so a narrowing ships
only where the need is predictable and only after it is validated. Measured in **tokens** throughout, never
money (that is a hard rule; the `$` in `report --cost`, `PRICES` and the older AB-TASK/README language is
grandfathered, to be cleaned up later, not extended).

- **Step 0 — Backfire Auditor. DONE.** The gate every narrowing passes before its default moves. It is not a
  narrowing itself and changes nothing that enters context, so it ships on like Wave 1 (no A/B). `report
  --backfire` (`transcript.backfireAudit`): counts what the guard **withheld** (a result carrying the marker
  matched to a ledger row — a trim, MCP trim or dedup) against what the model then **pulled back** the two
  ways the guard itself creates — reading the saved `out/<sid>-<tid>.txt` file, or `tokenbrake show <id>` —
  and reports the backfire rate and the **net** (saved token-reads − pulled-back token-reads, same footprint
  basis on both sides). A pull-back it cannot tie to a withhold counted here (an earlier session's `out/`
  file, or a capped/over-ceiling output with no marker) is reported apart, never silently netted — the fix
  for the first real-session run, where a 0% rate was docking the net for cross-session reads. Built on the
  existing engine (`trimSavings`, `ledgerIndex`, `classifyRangedReads`, `recoveryReads`); tokens only; 9 new
  checks. Every later narrowing follows the save-to-`out/` + marker pattern, so its backfires are `out/` reads
  the same detector already catches — which is why this is Step 0.
- **Narrowing 1 — Read-After-Edit Delta. DONE (ships OFF).** Chosen first because it is the lowest-backfire
  bet on the board: it withholds a *re-send of content the model already has* (it just edited the file), and
  the Claude Code harness's own guidance — "Do NOT re-read a file you just edited to verify … the harness
  tracks file state for you" (in this session's system prompt) — calls the verify re-read unnecessary, so the
  withheld bytes' need is predictably low. `readAfterEdit` (default false): `handlePost` records each
  `Edit`/`MultiEdit`'s changed line range to a per-session `edits/<session>.jsonl` (mirroring the dedup state
  pattern) — from Claude Code's own `structuredPatch` when present (so `replace_all` and repeated-text edits
  are covered), else by locating `new_string` uniquely in the post-edit file; `handleReadPre` narrows a later
  **unbounded** Read of that file to the
  changed region + `editContextLines` (20) via `updatedInput` offset/limit — the same proven mechanism the
  Read cap uses, not a PostToolUse rewrite of the Read result (unknown schema, silent-rejection risk). Takes
  precedence over the size cap (shows the actual edit, not the first N lines). Logged as its own
  `ev:'read-delta'` with the injected window, and `backfireAudit` counts a **delta backfire** when the model
  later reads the file outside that window — a distinct ev on purpose, so the delta's own narrowed read is not
  mistaken for its own backfire and so read-delta rows stay out of the readMaxBytes evidence. Guard copy
  re-synced; 8 new checks incl. an end-to-end guard spawn. A/B via `report --backfire` gates the default.
  `ev:'read-delta'` with the injected window, and `backfireAudit` counts a **delta backfire** when the model
  later reads the file outside that window. **Gated to files at or under `readMaxBytes`** (the 2026-09-14 A/B:
  small files helped 0/7 backfire; large files backfired → excluded). **Merged to `main` in PR #62** with the
  Backfire Auditor and the recipe; ships as a recommended **opt-in**, default OFF (a flip would need an
  organic session showing it fires and saves — the forced-pattern A/Bs don't clear that bar).
- **Narrowing 2 — Read-After-Read elision. DONE (ships OFF).** A re-read of a file already read WHOLE this
  session, unchanged (same size + mtime) and recent (fewer than `reReadRecency` whole-reads since), is narrowed
  to the first `reReadKeepLines` + a one-line note (no saved artifact) — the model very likely still has it. `reReadElide` (default
  false): the read-whole branch records each whole delivery to `reads/<session>.jsonl`; `handleReadPre` elides
  after the read-after-edit branch (any edit or external write changes size/mtime → fails the equality check,
  so only genuine unchanged re-reads reach it) and before the size cap (only files read whole get a record; a
  capped first read means the model lacks the whole file). Its honest limit is a **compaction** the guard does
  not consult (it never sees the context window, so the model may have lost the content) — that risk is
  *mitigated*, not eliminated, by `reReadRecency` (a frequency limiter, not a compaction bound), default-OFF,
  and measured: `transcript.readReReads` counts an elision that backfired (the model read the file again past
  what the elision showed), surfaced by `report --backfire`. Distinct `ev:'read-reread'`, so the elision's own
  read isn't miscounted and its rows stay out of the `readMaxBytes` evidence. The delta and re-read audits share
  one `auditNarrowing(ledgerRecs, parsed, ev, wentPast)` loop (the two differ only in the "went past" test).
  13 new checks. On-strategy request narrowing; A/B gates the default.
  - **Deferred follow-ups (recorded, not built):** (1) a *compaction-boundary check* — skip elision when a
    compaction happened between the whole-read and the re-read — is the real fix for the one risk above, but it
    depends on `transcript_path` being present on the PreToolUse stdin, which is **unverified**. Building on an
    unconfirmed input shape risks a silent no-op (the 0.1.0 "verify the shape before you build on it" lesson),
    so this waits on a live check that PreToolUse actually delivers `transcript_path`. (2) A `forEachSessionLine`
    helper to fold the near-identical JSONL scan loops in `priorRead`/state readers — modest, pre-existing, not
    worth coupling to this change.
  - **Backfire-audit precision (from /code-review, all in the *conservative* or *deferred* direction):**
    (a) `wentPast` sees a later read's START line only, so it under-counts a bounded re-read that starts within
    the shown head but runs past it (`offset:1 limit:200`), and limit-only re-reads. This is the *unsafe*
    direction (too few backfires), so it is the one worth a real fix — but a precise test needs the read's END
    line added to the parsed results (`readStartLine` returns offset only), a shape addition no other report view
    needs, so it is deferred with the compaction check rather than expanded here. (b) A later whole re-read that
    was *itself* elided can be counted as an earlier elision's backfire when the transcript records original
    (not rewritten) input (`shapeVerdict`) — this OVER-counts, the *safe* direction for a gate, left as-is.
    (c) `priorRead` full-scans the per-session `reads/` JSONL on every unbounded Read while `reReadElide` is on
    (O(n²) over a read-heavy session); pre-existing scan pattern, OFF by default, folds into (2) above.
- **Narrowing 3 — Binary-Blob Elider. DONE (ships OFF).** Shell output that is one long encoded/minified run
  (a base64 dump, a minified bundle, a one-line JSON) is unreadable to the model as bytes yet re-enters context
  every request until compaction. `handlePost` (after shaping, before the size cap and the excerpt handling)
  replaces it with the first `blobKeepChars` (160) + a descriptor + a saved `out/` copy. The trigger is content,
  not size: `text.length >= blobMinChars` (4,000) AND the **single longest line** is both `>= blobMaxLine`
  (2,000, an absolute floor kept independent of `blobMinChars` so tuning the size gate down can't weaken it) AND
  `>= blobLineShare` (0.5) of the whole (the dominance test). So it fires on a blob whether over or under
  `maxChars`, catching an excerpt under `readMaxBytes`
  (passed whole today) and cutting an over-`maxChars` blob to a descriptor instead of the `maxChars`-of-garbage
  the char-slice keeps. The longest-line-share test discriminates a single encoded/minified run from
  wide-but-structured data (CSV, tables — many wide lines, none dominant) and from prose/logs/pretty JSON (short
  lines); a failed command is never elided. `blobElide` default false. **No
  narrowing-3 audit code:** the row is `ev:'post'` with `blob:true` + marker + saved `out/`, so the existing
  withhold/pull-back machinery counts it (labelled `blob` in `report --backfire` byKind) and a re-read of the
  saved file as a backfire. `maxLineLen` is a no-alloc longest-line scan. 12 new checks. A/B gates the default.
  - **Deferred follow-ups (recorded, not built):** (1) a **`Read` of a one-line minified file** — the highest
    single-firing waste — cannot be narrowed the way the other Read narrowings are: `updatedInput.limit` is a
    *line* count, so `limit:1` still delivers the whole giant line. A `Read` result *does* reach `handlePost`
    (the PostToolUse matcher is `*`), but as a no-op — every branch is gated on `isShell`/`isMcp` — so closing
    this means intercepting Read there, which needs `Read`'s PostToolUse response shape verified first (the
    "verify the shape before you build on it" lesson), else a silent no-op. (2) **MCP base64 results** — the MCP
    branch returns before the blob check; eliding a base64 image block there means going through
    `mcpBody`/`rebuild`, its own change. (3) When either lands, the shared `saveOut → descriptor → shaped
    `updatedToolOutput` → emit` scaffold (now in the dedup/excerpt/trim/blob branches) is worth one helper, and
    the guard writing an explicit `kind` on the ledger row would retire the auditor's flag-chain kind ternary.
    All waited on rather than bundled here. (4) With `dedup` AND `blobElide` both on, a first-seen blob is saved
    to `out/` twice (dedup's first-copy save, then the blob save to the same tool_use_id path) — a redundant
    write, and if `shapeFilters` also shaped the text between them the dedup record's `chars` no longer matches
    the overwritten file. All three OFF by default; a multi-feature-ON interaction, not the blob path's own bug,
    left for whenever these defaults start being combined.
- **Narrowing 4 — Change-Aware Git View. DONE (ships OFF).** A `git diff`/`git show` re-adds the whole diff on
  every request, and its noisiest part is usually generated — a lockfile, a `*.min.js`, a source map — that no
  one reads line by line. `handlePost` (after the blob branch, before the size cap) runs `collapseGitDiff`:
  split the diff on `diff --git ` boundaries, and for each file section whose `b/` path matches `gitCollapse`
  (default lockfiles + `.min.js`/`.min.css`/`.map`, substring match via `matchesAny`), replace the hunk body
  with a one-line `+adds/-dels` summary, keeping the `diff --git` header, every real-source hunk, and any
  commit/preamble verbatim. Fires only on a `git diff`/`git show` command (`GIT_DIFF` regex — not `log`/
  `status`) whose output is ≥ `gitViewMinChars` (2,000) and only when at least one file collapsed and the result
  shrank; a huge all-real-source diff whose collapsed body would still exceed `HOOK_OUTPUT_CAP` is left to the
  normal trim. Saves the full diff to `out/` and carries the marker, so — like the blob elider — the existing
  withhold/pull-back machinery counts it (kind `gitview`) with no new audit code. `gitView` default false.
  Not on a failed command. 13 new checks. The **frequency** play (git is constant in dev sessions) to the blob
  elider's **context-bomb** play; A/B gates the default. Pure string work, no git invocation.
- **Remaining narrowings** (each ships off, each validated by Step 0 before any default moves): Grep-Anchored
  Reads (higher backfire risk — deferred: the Grep tool already returns matching lines with context, so a
  following Read usually wants *more*, not the same window), Dependency Surface Reader, API/JSON Field
  Projection; plus Instruction Diet Compiler, Personalized Auto-Tuner (the report engine already holds most of
  it), Deterministic Replay Simulator (rides the `trim.js` extraction). The blob elider's two deferred
  follow-ups (a `Read` of a one-line minified file; MCP base64 result blocks) also remain.
