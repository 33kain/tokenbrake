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
  - MCP trimming (1) — **code DONE, accept side verified live; only the A/B remains.** The shape was the blocker, and
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
    `init --project` + a live call verifies the accept side in-session — no fresh container needed. **Remaining
    before MCP is closed:** only the A/B per `AB-TASK.md` (arm A off vs arm B on) before the default moves off
    false.
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
