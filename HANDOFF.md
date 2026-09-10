# Brakes — handoff

*Split out of `33kain/contexa` on 2026-09-06 into `33kain/tokenbrake`, history included. Paths below that say
`tokenbrake/…` are from before the split; in this repository they are at the root. Brakes 2, 3 and 5 are CONTEXA and
stay in that repository; this file keeps their cards because the plan was one plan.*

Written 2026-09-05, updated the same day after the first live run. Pick this up in Claude Code;
everything below is state, not conversation.

## Why

Anthropic replaces the temporary +50% Claude Code weekly boost with a permanent +25% on
**2026-09-14** — a net ~17% cut against what the meter shows today. Users are loud about it.
Every existing tool in this space is a **meter** (ccusage, CCUM, ccstatusline, menu-bar apps,
Chrome counters, the native usage page). Nothing is a **brake**. That gap is the product.

Brakes don't raise anyone's cap. They cut the share of the cap that goes to waste.

## The five brakes

| # | Name | Surface | Status |
|---|------|---------|--------|
| 1 | Bash-output guard hooks | npm package (`tokenbrake`) + Claude Code plugin | **0.2.0 published 2026-09-06** (Publish workflow, provenance); `npx tokenbrake@0.2.0 init && status` from the registry passes both spawn tests; `claude plugin marketplace add 33kain/tokenbrake && claude plugin install tokenbrake@tokenbrake` installs and lists 0.2.0 enabled; A/B measured on two models; Windows still unrun |
| 2 | Fork thread with summary | CONTEXA | **built 0.9.73, field-verified on Cowork 0.9.87** (444 vs 123,813 tokens) |
| 3 | Send-cost preview + long-thread warning | CONTEXA | **built 0.9.73, field-verified on Cowork 0.9.82** (exact count from the session record) |
| 4 | What's eating your tokens | `tokenbrake report` | **built**, run on one real 64-request session |
| 5 | Batch + model-routing nudge | CONTEXA | **built in 0.9.74**, not field-tested |

Shared plumbing across all five: one Worker backend, one token-estimation module
(`chars/4` is accurate enough for warnings), one settings/telemetry schema.

Ship order: 1 → (2 + 3 as one CONTEXA release) → 4 → 5. Brakes 2 + 3 shipped as CONTEXA 0.9.73 on 2026-09-05
(worker deployed; extension awaits the Chrome Web Store). Brake 4 built the same day as `tokenbrake report`;
brake 5 as CONTEXA 0.9.74. All five exist. Next: publish tokenbrake, submit 0.9.74 to the store, and field-test.

---

## Brake 1 — tokenbrake (`tokenbrake/` in the CONTEXA repo)

Lives at `tokenbrake/` in the CONTEXA repository since 2026-09-05, with its own `package.json` and a test
suite (`tokenbrake/test.mjs`) wired into the root `npm test` and CI. Publishing to npm is still a separate,
unrelated step from the extension and worker deploys.

### What it is

Two Claude Code hooks, zero dependencies, Node 18+, no Python/Rust/Git Bash.

- **PostToolUse `*`** → `guard.js post`. Bash/PowerShell output over `maxChars` is replaced with
  head + tail + up to N middle lines matching an error/warning regex, each with its line number.
  Full output written to `~/.claude/tokenbrake/out/`, path named in the trimmed result so Claude
  can Grep/Read it. Every tool result's size is appended to the ledger.
- **PreToolUse `Read`** → `guard.js read-pre`. A `Read` with no `offset`/`limit` on a file over
  `readMaxBytes` gets `updatedInput.limit = readLimitLines`, plus `additionalContext` telling Claude
  the file's real size and to page or Grep. Images/PDFs/notebooks skipped. Bounded reads untouched.

### Files

- `guard.js` — hook handler. Mode is `argv[2]`: `post` | `read-pre`. Fails open on everything.
- `cli.js` — `init [--project]`, `uninstall`, `status`, `report [--all]`, `clean [--days=N]`.
- `package.json` — bin maps `tokenbrake` → `cli.js`.
- `README.md` — user-facing.
- `test.mjs` — 46 checks, no Claude Code needed: spawns `guard.js` / `cli.js` against a throwaway
  `CLAUDE_CONFIG_DIR` with the stdin shapes observed on 2.1.261. Pins the object-shaped `updatedToolOutput`
  (the bug below), the fail-open paths, the Read cap, init/status/uninstall, and the `status` spawn test.

### Verified (mechanically, in a sandbox)

- `init` writes correct hook groups into `settings.json`; `--project` uses the
  `${CLAUDE_PROJECT_DIR}/...` placeholder, user scope uses an absolute path. Both exec form (`args`
  set, no shell) so Windows paths with spaces are safe.
- 400-line / 6,352-char `npm test` output → 1,605 chars, with all three seeded error/warning lines
  from the omitted middle preserved and line-numbered.
- 200 KB / 12,000-line file → `limit: 300` + context message. Same file with `limit` already set → no output.
- Small results → no output at all (Claude Code sees the original).
- Garbage stdin → exit 0, no output.
- `report` correctly shows by-tool share and top-10 heaviest.
- `uninstall` removes only our groups and leaves the rest of settings intact.

### Verified live (Claude Code 2.1.261, Linux, 2026-09-05)

Run in a real `claude -p` session with the hooks installed into an isolated `CLAUDE_CONFIG_DIR`, judged
from the transcript JSONL, the `--output-format stream-json` tool_result blocks and `--debug-file`, not
from the model's reply.

- **The shipped `guard.js` did not work, and the failure was invisible.** The hook fired, produced the right
  trimmed text, Claude Code logged `Hook PostToolUse (tokenbrake) replaced tool output` — and then
  rejected it: `PostToolUse hook returned updatedToolOutput that does not match Bash's output shape:
  expected "object"`. The full 27,798-char output went into the transcript. `status` said "installed" and
  the ledger recorded a saving that never happened. Only the debug log knew.
- **Fix (applied):** for Bash/PowerShell, `updatedToolOutput` must be the tool's response *object*
  (`{ stdout, stderr, interrupted, isImage, noOutputExpected }`), not a string. `guard.js` now spreads the
  incoming `tool_response` and puts the trimmed text in `stdout` (`stderr` is already folded into it, so
  it is blanked). A string-typed `tool_response` still gets a string back.
- After the fix, `cat` of a 400-line / 27,798-char file → 5,998 chars in the transcript, marker present,
  all three seeded error/warning lines from the omitted middle listed with line numbers, full output saved
  to `out/`, ledger row correct.
- Unbounded `Read` of a 12,000-line / 216 KB file → 300 lines in the transcript, `limit` injected
  (debug log: `modified tool input keys: [file_path, limit]`), `additionalContext` delivered (176 chars);
  the model reported seeing the cap note.
- Fail-open paths unchanged: garbage stdin → exit 0, no output; small results → no output.
- `/hooks` itself is not reachable headless. The equivalent evidence is the `hook_started` /
  `hook_response` system events in stream-json, named `PostToolUse:Bash` and `PreToolUse:Read`.

- **npm name:** `tokenbrake` is free — the registry returned 404 for it on 2026-09-05. No rename needed.
- **Node resolution hardened** (the Windows risk, addressed without a Windows machine): user-scope `init` now
  records `process.execPath` (the absolute node the installer ran under) instead of bare `node`; `--project`
  keeps `node` because that file is committed and shared; `--node=<path>` overrides either. And `status` now
  spawns each installed hook exactly as Claude Code would (recorded command, recorded args, no shell, synthetic
  event on stdin, throwaway config dir so the ledger is untouched) and prints `ok (… chars in → … out)` or
  `FAILED to start: ENOENT`. The HANDOFF used to say "`status` won't catch it"; it does now.

### NOT verified — do these first

1. **Windows live run.** The node-resolution risk is mitigated, not measured: run `npx tokenbrake init`
   and `npx tokenbrake status` on a Windows machine and confirm the spawn test says `ok`. Then a real session
   with the PowerShell tool to confirm its `tool_response` shape: the fix spreads whatever object arrives, which
   holds if PowerShell matches Bash's `{ stdout, stderr, interrupted, isImage, noOutputExpected }`, but that
   is an inference. If PowerShell's shape differs, `handlePost` needs a per-tool branch.
2. **Interactive `/hooks` listing.** Only headless runs so far; worth one look in a TTY session to confirm
   both entries show with their source file.

### Then

- **Published: `tokenbrake@0.1.0` on 2026-09-05**, by `md_contexa`, from a Claude session with a one-off granular token
  (revoked after). `npx tokenbrake@0.1.0 init && npx tokenbrake status` from the registry into a clean config dir
  passed both spawn tests. For the next version: the `Publish tokenbrake` workflow (`.github/workflows/publish-tokenbrake.yml`, Run workflow from
  the Actions tab) — needs the repository secret `NPM_TOKEN`, an npm granular access token with read/write on
  packages; it runs the tests, refuses a version already on the registry, publishes with provenance (the repo
  is public) and reads the version back. Keep it MIT and dependency-free — that's the whole pitch against the
  Rust/Python alternatives.
- Consider narrowing the PostToolUse matcher to `Bash|PowerShell|Read` as a documented option: it's one
  `node` spawn (~50–100 ms) per tool call otherwise, and the full ledger is what pays for that cost.
- Config file `~/.claude/tokenbrake.json` (or under `CLAUDE_CONFIG_DIR`) overrides `DEFAULTS` in `guard.js`.

### Ledger schema — brake 4 consumes this

`~/.claude/tokenbrake/ledger.jsonl`, one JSON object per line:

```
{ t, ev, session, tool, chars, what, id, transcript }              // ev: "post"
{ t, ev, session, tool, chars, kept, what, saved, id, transcript } // ev: "post", trimmed
{ t, ev, session, tool, what, bytes, lines }                       // ev: "read-cap"
```

`id` is the tool_use_id and `transcript` the transcript_path, both from the hook's stdin (added for brake 4;
rows from before that lack them and the report falls back to matching on tool + what). Brake 4 is a reader
over this file plus the Claude Code transcript JSONL — not a new collector.

---

## Claude Code hooks API — facts checked 2026-09-05

Don't re-derive these; re-check only if something behaves differently.

- Hook input arrives on **stdin as JSON**. Output goes to **stdout as JSON**, stdout must contain
  nothing else (a chatty shell profile breaks parsing).
- PostToolUse input field is **`tool_response`**, not `tool_output`. For Bash it is
  `{ stdout, stderr, interrupted, isImage }`. Shape differs per tool.
- Rewrite fields: `hookSpecificOutput.updatedToolOutput` (PostToolUse),
  `hookSpecificOutput.updatedInput` (PreToolUse). Both need `hookEventName` set.
- **`updatedToolOutput` is validated against the tool's own response schema.** For Bash it must be the
  same object shape as `tool_response` (`{ stdout, stderr, interrupted, isImage, noOutputExpected }`);
  a bare string is rejected. **The rejection is silent** — no stderr, no transcript note, exit stays 0 —
  and the original output goes through untouched. It shows only in `--debug-file` / `--debug` as
  `[ERROR] PostToolUse hook returned updatedToolOutput that does not match Bash's output shape`.
  Any change to a rewrite hook must be checked against the debug log, not against `status` or the ledger.
- Full PostToolUse stdin keys on 2.1.261: `session_id, transcript_path, cwd, scratchpad_dir, prompt_id,
  permission_mode, effort, hook_event_name, tool_name, tool_input, tool_response, tool_use_id, duration_ms`.
  `transcript_path` is the session's JSONL — brake 4 does not need to guess the path.
- Testing hooks headless: `claude -p '...' --output-format stream-json --verbose --debug-file <f>` with an
  isolated `CLAUDE_CONFIG_DIR`. stream-json carries `hook_started` / `hook_response` system events and
  the exact tool_result the model saw; the transcript JSONL under `<cfg>/projects/` carries
  `toolUseResult` with the post-hook `stdout`. Nested inside another Claude Code session, unset `CLAUDECODE`.
- `additionalContext` is allowed on PreToolUse and PostToolUse; it lands next to the tool result.
  Write it as factual statements, not imperatives — imperative phrasing can trip prompt-injection defenses.
- **Hook output strings are capped at 10,000 characters.** Over that, Claude Code writes to a file and
  substitutes a preview. `guard.js` keeps its rewrite under 9,500 deliberately.
- Exit 0 + JSON = structured control. **Exit 2 blocks** (PostToolUse can't block — the tool already ran —
  but stderr is shown to Claude). Exit 1 is a *non-blocking* error; never use it to enforce anything.
- PostToolUse fires on **success only**; failures go to `PostToolUseFailure`. A failed Bash result already
  arrives as a ~10,000-char head/tail excerpt from Claude Code, so it needs no trimming.
- Built-in Bash limits for context: valid result inline to ~30,000 chars (past that, a file path + preview);
  failure inline to ~10,000. `BASH_MAX_OUTPUT_LENGTH` changes the read-back window, not the inline ceiling.
- `matcher` with only letters/digits/`_`/`-`/space/`,`/`|` is exact-match; anything else is an unanchored regex.
- Exec form = `args` present → executable spawned directly, no shell, each arg verbatim. Shell form = `args`
  absent → string goes to `sh -c` / Git Bash / PowerShell. On Windows, exec form needs a real `.exe`;
  `.cmd`/`.bat` shims (npx, eslint) can't be spawned without a shell.
- Hooks merge across settings levels rather than replacing. `disableAllHooks` turns everything off.
- `/hooks` is a read-only browser showing which file each hook came from — the fastest install check.

---

## Brakes 2–5 — short specs

**2. Fork thread with summary (CONTEXA) — built, 0.9.73.** `FORK_SYSTEM` (byte-identical in
`extension/background.js` and `worker/src/index.js`), `POST /v1/fork` on the worker sharing every gate and
the same daily twenty, `cleanBrief` in the injected helper block. The brief is one chip whose hover title is
the brief; its click stages the text in `chrome.storage.session` and opens `claude.ai/new`, where the content
script inserts it into the composer. No `?q=` URL parameter: reported removed from claude.ai in late 2025, and
a mechanism the extension owns end to end is the only one that can be tested here. Instrumented: every fork
logs `thread ≈ N tokens, brief ≈ M tokens (P% less per send)`. NOT field-tested — the CHANGELOG entry says what
to watch for; the first live fork on a real long thread is the next verification.

**3. Send-cost preview + long-thread warning (CONTEXA) — built in part, 0.9.73.** `threadTokens()` reads the
page at chars/4 and, above `LONG_THREAD_TOKENS` (12,000), the card's label row carries "≈ Nk tokens re-read per
send" and the **Start fresh** control from brake 2. Not built: the session-percentage figure (it needs the native
usage page, which is a different page and would mean fetching claude.ai's internal API from the content script —
fragile, and outside what the extension does today), and the peak-window indicator — the "existing clock logic"
this spec pointed at does not exist in the CONTEXA repository. Both stay open and are recorded as such in the
0.9.73 changelog.

**4. What's eating your tokens — built, as `tokenbrake report` (`transcript.js`).** Reads the Claude Code
session transcript (`<config>/projects/<cwd>/<session>.jsonl`) plus the ledger. The number it ranks by is
**carried context**: a result's size × the later requests that re-read it (until a compaction), because a
result is not paid for once. Transcript facts, checked on Claude Code 2.1.261 and not to be re-derived: one
API request spans several `assistant` entries sharing a `requestId` (dedupe by it, usage is identical across
them); tool results are `user` entries whose `message.content` holds `tool_result` blocks with the exact text
the model saw; `tool_use_id` joins them to the `tool_use` block in an `assistant` entry, which carries the tool
name and input; `isSidechain` marks subagent lines (skip); compaction lands as a user message with
`isCompactSummary: true` (older files: a `summary` line). The API's usage on every request is the whole
context (input + cache read + cache write), so the sum over requests is what the session processed and the
last request's figure is what the context holds now. First real run, this repo's own build session: 64
requests, 100 tool results, 15.4M tokens processed (96% from cache), ≈ 457k in context, and the three
heaviest results were unbounded reads of persisted tool output at 13–15k tokens each, carried 25 times —
exactly the class brake 1's Read cap exists for. The ledger gained `id` (tool_use_id) and `transcript`
(transcript_path) so the join is exact rather than by command string. Not built: anything live or
cross-session; it is a per-session report on purpose.

**5. Batch + model nudge (CONTEXA) — built, 0.9.74.** Two lines on the card, no button, chosen by
`weightLine` after the long-thread cost line: three short user turns in a row on a thread of ≥ 4,000
estimated tokens ("each re-reading the thread… one message reads it once"), and a short code-free last turn
sent while claude.ai's model selector (`[data-testid="model-selector-dropdown"]`, pinned) reads Opus ("about
2.5× Sonnet's usage per token", the API list-price ratio, source named in the code). Retrospective by design:
said when the reply lands, the one moment the pattern is complete and the composer is empty; nothing watches
the composer. "ŠRAF classification" does not exist in this repository; the fragment definition is the
one in `content.js`. **Field, 2026-09-05, Quetta on Android, 0.9.74 sideloaded:** the model line rendered on a live Opus 5 chat, so
the selector is verified. The cost line did not render on a long chat — the virtualised DOM held a fraction of
the thread — and 0.9.75 scales the read by page height and exposes the measured number in the wordmark's
tooltip. Also reported: "on most chats CONTEXA does not open"; 0.9.75 arms the settle fallback at attach so a
finished, flagless, static page draws its card. Whether that was the cause is the next thing to check. **Second session: 0.9.75 changed nothing.** 0.9.76 reads
the thread size from claude.ai's own conversation API (same origin, read-only, fails quietly to the DOM
estimate) and adds a three-tap diagnostic card on the wordmark, because the phone has no console and no
tooltip. The next report must carry that card's numbers. **It did:** 3 blocks, 1 user turn, scale ×3.81 → 6.3k tokens on a
long chat, API "not asked" (the card could not tell pending from never). 0.9.77 reads the user's turns from the API
when it answers (so moves and brief stop being mined from one turn) and makes the card's API states honest. **Third card:** the page was a Cowork session (`/cowork/cse_…`), not a
chat — Cowork's API is unknown. 0.9.78 adds a main-world probe that lists the page's own `/api/` paths in the diag
card. **Fourth/fifth cards:** on a chat the API read works on the phone (8,111 chars, 6 user messages vs 3 in the DOM);
on Cowork the base is `/api/organizations/<org>/cowork/sessions/<cse_id>/…` and the content did not appear among
same-origin fetches — 0.9.79 widens the probe (ws, sse, other hosts) and reports the status and key names of four
GETs under that base. **Sixth card:** the Cowork page calls `/v1/code/sessions/<cse_id>` and `…/events` (same origin) — the Claude Code
Remote API, proxied. The session record (checked from this side via get_session) carries
`external_metadata.context_usage.used_tokens`: **123,813** on the field session, exact, against a DOM estimate of
6,324; lifetime 245M cache-read tokens, $1,432. 0.9.80 reads the record for the count and the events for the
user's turns (shape parsed defensively; keys reported in the diag). On Cowork the fork copies the brief instead of
opening /new. Open: the events shape (one card will confirm), and opening a new Cowork session with the brief.
Was: read the shape, implement the Cowork session read, decide what "Start fresh" means on Cowork (a new
Cowork session, not `/new`). Note for brake 1: Cowork remote sessions are Claude Code sessions in Anthropic's
cloud; hooks there would have to come from the repo's own `.claude/settings.json` (`tokenbrake init --project`). If the API read works it is also the fix for the
head-truncated capture (`captureTurns` could read the whole session from it) — a deliberate later step.

**Eighth card (0.9.82): the cost line rendered on the live Cowork session — `≈ 124k tokens re-read per send`, exact,
from `/v1/code/sessions/<id>` → `response_shape.external_metadata.context_usage.used_tokens` (needs the page's own
headers: anthropic-version 2023-06-01, anthropic-beta ccr-byoc-2025-07-29, anthropic-client-feature ccr,
anthropic-client-platform web_claude_ai, x-organization-uuid from the lastActiveOrg cookie).** Events:
`/v1/code/sessions/<id>/events` → `{data,next_cursor,resume_cursor}`, 50 per page, `data[].{event_type,payload,
sequence_num,…}`; the first page is session setup (control_request/response, env_manager_log, system,
autocompact_state, active_goal) and the field session has >23,000 events, so the brief cannot walk from the start.
0.9.83 probes `limit` and `from_sequence_num` on /events and reports the shape of `active_goal` and the record's
`post_turn_summary`, the two cheap sources a Cowork brief can be built from. Next: read from the end, build the
Cowork brief, and decide what Start fresh opens on Cowork (a new Cowork session in the same project).

**Ninth–eleventh cards (0.9.85–0.9.86):** the stream takes `limit=500`, its cursor is a sequence number and every answer
carries `resume_cursor` (the head, 23,435 on the field session); reading 500 from the start plus the last 3,000 back
from the head found 137 user turns in the tail (12 pages), and the moves came from the present. The first live fork
failed with the generic parse-failure card; 0.9.86 salvages a cut or JSON-broken brief from the raw text on both
paths (`rawBrief`, injected block), raises the fork ceiling to 2,000, and the diag card carries the last error with
its diag. Start fresh on Cowork copies the brief, parks it and opens `claude.ai/cowork`; whether the brief lands in
the new session's composer is not yet verified.

**Twelfth card (0.9.86): the brief. `Brief ready: ≈ 444 tokens instead of ≈ 124k per send` on the live 123,813-token
Cowork session — the thesis's first measured number (99.6% less per send). `claude.ai/cowork` redirects to a product
page; the new-session screen's URL is unknown, so 0.9.87 lands a parked brief on any claude.ai page that is not an
existing conversation, has a composer and holds no messages (take is consuming, so only then). Open question: the
new Cowork session's URL, to open it from the chip.**

**Thirteenth card (0.9.87): the brief landed by itself on `claude.ai/cowork/project/<chat_project_id>` — the project page
is the new-session screen. 0.9.88 opens it from the chip (the id is in the session record), retires `probe.js`, and is
the store candidate — except that `chat_project_id` is a `claude_proj_…` id and the project page wants the project uuid
(fourteenth card: "Couldn't load this project"); 0.9.89 read the project link off the session page instead — and the
fifteenth card opened the wrong project: the page's first `/cowork/project/` link is the sidebar's first project. 0.9.90
asks `/api/organizations/<org>/projects` for the entry carrying the `claude_proj_…` id and takes its `uuid`; else
`/v1/code/projects/<id>` (code headers) and records its shape; else the chip copies and opens nothing. Sixteenth card: the
list's keys are `uuid,name,description,is_private,creator,is_starred,is_starter_project,is_harmony_project,type,subtype,settings,
archiver,archived_at,created_at`, none holding the id; `/v1/code/projects/<id>` is 404. 0.9.91 adds the project details,
`/v1/code/projects` as a list, and the page's own resource timing (`/api/organizations/<org>/projects/<uuid>` fetched by the
session page to show its project's name), the last used only when exactly one uuid was fetched. Seventeenth card: details add
only `prompt_template,organization_role`, `/v1/code/projects` 404, five resource entries, both links in plain divs. 0.9.92 searches
the org's `chat_conversations` and each project's `…/conversations` for the `cse_` id, and `/v1/code/sessions?limit=50`. Eighteenth card: conversations carry
`project_uuid,session_id,workspace_session_id` (none holding the cse id in 76 + 14 entries); the sessions list carries
`relations,tags,title,participants,status` — the record's diag summary cut at twelve keys, so 0.9.93 searches the record itself
first and shows all its keys. Nineteenth card: the record has no project uuid either — and needs none. **`chat_project_id` is the
uuid in another spelling: `claude_proj_01` + base58 (Bitcoin alphabet, 22 chars, `1`-padded) of the uuid's 16 bytes.**
`claude_proj_011CeAvYWZiPwTSnbTDUTRkX` → `01a016c6-92cb-713e-982d-db1fbc14c7fc`, verified against the page reached by hand and
by round trip. 0.9.94 decodes (`projectUuidOf`), asks the org's project list once only to name the project on the chip, and
drops every lookup of 0.9.89–0.9.93. **Twentieth card (0.9.94): the chip opened `/cowork/project/01a016c6-…` — the CONTEXA
project the session lives in — and the brief landed in its composer by itself. The Cowork path is closed end to end and
field-verified: exact count → cost line → brief (444 vs 123,813 tokens) → new session in the same project.** The Cowork
path is closed end to end except that last hop: exact count → cost line → brief (444 vs 123,813 tokens)
→ new session in the same project (the brief lands by itself once the right project page opens). Field-open: nothing on
the extension. The chat path's Start fresh was clicked on the phone (twenty-second card): /new opened with the brief in its box.**

**Twenty-first card (0.9.94): four more sessions, the brief measured on each.**

| page | thread (re-read per send) | brief |
|---|---|---|
| Cowork `cse_01Pc8b…` | ≈ 689k | ≈ 441 |
| Cowork `cse_01SMDg…` | ≈ 214k | ≈ 313 |
| chat `5d0b6192…` | ≈ 14k | ≈ 442 |
| chat `e9e4e32e…` | ≈ 22k | ≈ 427 |

With the first (123,813 → 444) that is five sessions, 14k to 689k, and the brief lands between 313 and 444 tokens
every time. The second-session condition on any marketing number is met. The honest claim is "a brief of about four
hundred tokens instead of re-reading the whole thread on every send" — tokens re-read, not money: prompt caching
prices a cached re-read at a tenth, and how claude.ai's usage limits count cached tokens is not public.

**Twenty-second card (0.9.94): the limit, measured.** Five messages in the 689k-token Cowork session (Opus 5), then
Start fresh and the same five in the new conversation it opened — a chat in the same project, on Opus 5 as well, so the
two arms share a model — the usage page read before and after each arm:

| | before | +5 in the 689k session | +5 in the fresh session |
|---|---|---|---|
| five-hour window | 36% | 45% (+9) | 48% (+3) |
| weekly, all models | 20% | 22% (+2) | 22% (0) |
| weekly, Fable | 39% | 39% (0) | 40% (+1) |

Three times cheaper per message on the five-hour window; the weekly limit moved 2 points on the heavy side and none on
the fresh one. Not the 200× of the raw token ratio, for three expected reasons: cached re-reads are counted at a
discount (first evidence that the subscription limit discounts them, and still counts them); a fresh Cowork session
carries tens of thousands of tokens of system prompt and tool definitions per turn before the brief (the fresh arm was
a project chat with commands available, lighter than a Cowork task, so a Cowork-to-Cowork run would sit between the
two); and message 4 on the heavy side used three tools, three extra re-reads. Caveats: one short reply of mine, on Fable,
in the window — that is the whole Fable +1, and it is not on the Opus arms — and 1% resolution. A tighter run is ten
messages, "in one sentence, no tools", and Cowork on both sides. The number that holds as written: *five messages in a 689k-token session used 9% of the
five-hour limit; the same five after Start fresh used 3%.*

**Twenty-third card (2026-09-06): brake 1 against the usage limit, measured.** `tokenbrake init --project` merged
(#46), so every Cowork session on the repository runs the hooks, and the first one confirmed it in its own words. The A/B
in `tokenbrake/AB-TASK.md`: one identical eleven-step read-heavy task as a single message, arm A before the merge, arm B
after, Fable 5.1 both, the usage page read around each, the session records read afterwards for exact usage and cost.

| | no hooks | hooks on | change |
|---|---|---|---|
| API cost | $8.40 | $7.02 | −16% |
| cache-read tokens | 4.62M | 2.72M | −41% |
| requests | 21 | 15 | −29% |
| five-hour window | +9 | +8 | −1 point |

Same answers on all ten questions. The saving is mostly indirect: a trimmed `cat` sent the model to bounded Read calls
instead of Claude Code's persisted-result path, whose re-reads were 96% of arm A's carry; the Read cap itself never fired.
The usage page, at 1% resolution, moved consistently with the cost and cannot say more than "about one point in nine".
The number that holds: *on an identical Cowork task, brake 1 cut the session's cost by 16% and its cache reads by 41%,
with nothing lost on the task.*

**Twenty-fourth card (2026-09-06): the Opus run.** Same task, both arms on Opus 5, told apart by a step 0 the session runs
itself (`{"enabled": false}` / `{"enabled": true}` in `~/.claude/tokenbrake.json`, printed back in step 11). Cost $5.97 →
$3.77 (−37%), cache reads 5.77M → 3.99M (−31%), tool results entered 160k → 76k, five-hour window +3 → +2, identical
answers. On Opus the Read cap fired twice and the model went to head + heading index + tail and to grep, which is where
the larger saving came from. Two models, one task, both cheaper with nothing lost: 16% on Fable, 37% on Opus. Details and
every number in `AB-TASK.md`.

**Twenty-fifth card (2026-09-06): the debugging round, a null result.** Five planted faults, the 50 KB suite to run until
green, Opus 5 both arms. Cost $2.76 → $2.63 (−5%, within run-to-run variation), the guard trimmed nothing, both arms fixed
all five and left an empty diff. Opus bounded its own reads (`npm test | tail -80`, `grep -A`, `sed -n`): tool results
entered 10–11k against 160k on the audit. Brake 1 saves what the model would otherwise let in, and on this workload it let
in nothing. The expectation that debugging would give the biggest number was wrong and is recorded as wrong. The honest
range on Opus 5, this repository: 0% to 37%, set by "Tool results entered" in the report.

**Twenty-sixth card (2026-09-06): the debugging round on Fable 5.1, also null.** Cost $1.54 → $1.16, but the guard trimmed
nothing on either arm: Fable bounded its own reads too (`tail -80`, `grep -v '^ok'`), and the difference is arm B doing the
job in 7 requests instead of 16, which is planning variance, not the hook. Both arms fixed all five with an empty diff.
Flaw found: the injector leaves the faults in the working tree and both Fable arms read them off `git diff`; a next version
should commit the planted tree. Standing result across two models and three workloads: brake 1 saves what the model would
otherwise let in — 16% and 37% on whole-file audits, 0% on a debugging loop where the model bounds its own output.

**Twenty-seventh card (2026-09-06): debugging v2, faults committed, Fable 5.1.** Neither arm could diff; both fixed all
five by tests and reading. Cost $2.83 → $2.12, but the guard trimmed three 2k outputs, 18k token-reads against 1.7M cache
reads: about 1% attributable, the rest planning variance (17 requests against 24). The closed flaw did not move the result.
Measurements on this repository are complete: audit 16% / 37%, debugging ≈ 0% / ≈ 1%, identical answers everywhere.

**Twenty-eighth card (2026-09-07 to 09-09): the second week, in one place.** Released 0.2.1 (cap on persisted
outputs: Claude Code's `tool-results/` and our `out/`, 80 lines whatever the size; 24% of the writing session's carry)
and 0.2.2 (`PostToolUseFailure` registered; context after flagged lines; pass markers never flagged; the trim budgeted
context-first). Report gained: cost at list price (matches session records to six decimals on Opus 5), `--compare A B`,
"Repeat reads", "Under the trim threshold", and credit only for trims the model saw. Measured and recorded in
`AB-TASK.md`: readMaxBytes 60k→25k cost +10% (return trips), feature round ≈ 0 with noise measured at 21% between
identical arms, errctx v2/v3 nulls by construction. Found and recorded: Claude Code ignores `updatedToolOutput` on
`PostToolUseFailure` (2.1.261, 2.1.266; debug log says "unrecognized keys"), so no hook can trim a failing test run;
outputs over its ~30,000-char ceiling reach the hook truncated and the model as a 2 KB preview. `LANDSCAPE.md`: rtk,
chop, squeez, claude-context-optimizer, shunt, against the JetBrains benchmark (rtk +7.6% on the bill). First Windows
run: everything works. Project-scope hooks on both repositories; every session leaves `ab-results/real/<date>-<id>.txt`
on its branch in `33kain/contexa`.

**Twenty-ninth card (2026-09-09, evening): 0.2.3 released, the Fable number retired, Sonnet out of reach.**
Released 0.2.3 (the excerpt rule from #15, the report's trim-credit fix, `status`'s double-install warning,
"Under the trim threshold"); `33kain/contexa` repinned to it in an open PR. Ran ab5, the audit on Fable 5.1,
off against 0.2.3: $6.4787 → $5.5331 (−14.6%) but 26 → 29 requests, so by the rule written before the run
the README's −16% does not survive its guard change. Both Fable readings are inside the 21% noise band; the
Fable line is now a null in README and LANDSCAPE, as the Opus line already was. Answers 12 of 12 identical,
as in every round. Two mechanisms came out of it: **the models do not spend alike** — Fable lists cache
writes at eighty times reads against Opus's twenty, so writes were 75% of the off arm's bill where every
Opus round is read-dominated, which means a saving measured on one model is not evidence about another —
and **the persisted-output leak reproduced**, 94% of the off arm's carried context being Reads of Claude
Code's own `tool-results/` files rather than of the repository, though it bought almost nothing on the bill.
The cost formula in `transcript.js` reproduces both Fable records exactly, so those splits are the API's.
ab6, the Sonnet 5 round, is **void twice and closed unmeasured by the owner's decision**: the first attempt
was refused by both arms as an exfiltration attempt, over a step 11 (`ls -la ~/.claude/`) added an hour
earlier that told the arm to publish the user's config directory to a public branch — the ab5 arm had
already done so, and that listing is now removed from `claude/ab5-tb`; the second attempt, with step 11
replaced by `tokenbrake status`, was refused again because a `create_session` seed is not a human turn on
Sonnet. No wording fixes the second. The audit is measured on Opus 5 and Fable 5.1 and on no other model,
and nothing written from `AB-TASK.md` may imply otherwise. Also written: the rtk head-to-head as a
procedure for the owner's Windows machine, and the twelve-step audit task itself, which three rounds had
used without ever recording it.

**Thirtieth card (2026-09-10): the first round run by a person, and the cap's door.** ab7 and ab8, both on
the owner's Windows machine, Fable 5.1 (`claude-fable-5-1[1m]`), Claude Code 2.1.267. ab7 was void: one arm
read "one step at a time, and do not skip or batch steps", announced it would run the independent steps in
parallel, and came in at 4.6 tool results per request against the other's 1.1, so every figure followed
from the batching rather than the guard. rtk turned out not to be installed and the round finished as two
arms by agreement — a change of scope, not a defect. ab8 re-ran it with one added sentence, *one tool call
per turn*, and both arms landed at 0.94 and 1.00: **$4.37 → $4.39, +0.5%, requests 18 → 21, answers 12 of
12 identical.** By the rule written before the run, the expected null, and the closest two arms have ever
come on this page. What the round bought is the mechanism: the Read cap fired on `content.js` (112 KB), the
model went to `cat` instead, that passed Claude Code's own ceiling and was persisted, and the model read
the persisted file back in three *bounded* ranges the guard leaves alone by design — 411k token-reads, 43%
of that arm's carried context. **The cap changed which door the file came in through and nothing else.**
Four holes in `AB-RUNBOOK.md` were found by someone actually following it and are fixed: no rtk status
command was named, nothing said what to save per arm, install/uninstall was replaced by `git checkout` on
prepared branches, and the arm's own step-12 report can name the wrong session (on Windows a live
transcript's mtime lags, so `report` with no `--session` picked a previous round's arm — twice). Also
fixed in the tool: `status` called a single project install a double one. The lesson worth keeping is that
a protocol document is finished when someone who was not in the room can follow it, not when it is correct.

**Thirty-first card (2026-09-10): ab9, and the first time the guard moved anything.** The audit task was
retired after ab8 showed it measured a hook that fired zero times on both arms; its replacement is a
release review plus a mechanism trace, built from measured output sizes. ab9 on Fable 5.1 on Windows, off
against 0.2.4: **entered 12k → 9k (−25%), carried 118k → 97k (−18%), cost $1.93 → $1.70, requests 16 → 17**,
both arms at 0.94 tool results per request. By the rule written before the run this is the first branch
that has ever fired — entered lower, requests within three, cost not worse — and by the same rule it stays
in `AB-TASK.md` until a second run on another day reproduces it. The cost figure is inside the 21% noise
band and is *not* a claim; entered and carried are per-result counts and are. Three trims are visible in
the arm's own table, `git log --stat -40` cut from 7k tokens to 544 among them. Also found: **the model
starves even a task built to feed it** — the off arm answered "read CHANGELOG.md in full" with `wc -l` and
`grep -c` on a file it never opened, and made zero Read calls in fifteen tool calls; **three faults in the
task itself**, chiefly that the off branch's extra commit slides `git log --stat -40` and `HEAD~3` so any
git-history step is void as an identity check; and **a gap in the excerpt rule** — prefixing `echo '=== label ==='`
to a `sed` range makes it a compound command, loses the 0.2.3 exemption, and gets it trimmed, which models
do constantly. ab8's record was corrected the same day: 0.2.4's new `Read caps fired` line shows the cap
that fired there was the *persisted* one, so `readMaxBytes` has still never been observed to fire outside a
test. Released 0.2.4 (the `Read caps fired` line; `status` no longer calls a single install a double one);
`README.md` gained "Limits, with the numbers" ahead of the install instructions, including the count of 285
logged tool results in which the trim applied to none.

## Next session — Saturday 2026-09-13, the distribution table and the post

Nothing to build before then. The task is collection and one table, then publishing. Steps:

1. In a checkout of `33kain/contexa`, run the loop in `ab-results/real/README.md` (fetch every `claude/…` branch,
   copy each `ab-results/real/*.txt`, dedupe by name). Expect one file per session since 2026-09-06; the writing
   session's own file is `2026-09-06-ced42a1a.txt` and a second one dated 09-09.
2. Per file, read off: requests; "Tool results entered ≈ N"; "carried through later requests ≈ N"; "tokenbrake
   trimmed N of them: ≈ N tokens kept out, ≈ N token-reads not carried" (files from before 0.2.2's report may
   over-credit, see the Windows section of `AB-TASK.md`; note which version wrote each); "Under the trim threshold"
   and "Repeat reads" where present (reports from 0.2.2+ only); "At list price" where present.
3. **Before building the table, four things the inventory of 2026-09-10 found. It was run early and it is
   why this step changes shape.** Eight files exist across all `claude/…` branches; they are not eight
   sessions.
   - **`ced42a1a` appears three times** — 09-06 at 421 requests, 09-07 at 505, 09-09 at 617. One session,
     reported three times as it grew. Count it **once, at its latest snapshot**. Tabling all three would
     triple-count the largest session on record, which is exactly the error this page exists to avoid.
   - **`acb853e1` is an A/B arm** (ab7's tokenbrake arm, on Windows), not an ordinary session. Exclude it,
     and exclude any future file whose session is an arm.
   - **Two files are not contexa sessions**: `c5ad7352` ran in `/home/user/tokenbrake` and `ca84ebdd` in
     `/home/user`. The claim is "one repository", so either exclude them or drop that word.
   - What is left is **three ordinary contexa sessions — 617, 150 and 5 requests** — and one of those is
     trivial. **A median of three, one of them n=5, is not a distribution.** Say the number of sessions in
     the table's first line and never print a median that rests on fewer than, say, eight.
   - **Files written before 0.2.4 have no "Read caps fired" line**, since the report gained it on 09-10.
     For those sessions the split between the `readMaxBytes` cap and the persisted-output cap is simply
     unknown, and the table's note must say so rather than showing a blank as a zero. That gap is the whole
     reason the line was added, so the decision it feeds — whether `readMaxBytes` earns its default —
     waits for sessions recorded from 0.2.4 on.
4. The table: one row per session, then median / min / max per column **only if there are enough rows to
   mean anything**, plus kept-out as a share of entered and not-carried as a share of carried. Put it in `AB-TASK.md` under a new heading "Real sessions, one week", and the
   median row into README's "Measured" paragraph as the third number after the audit and debugging figures.
5. The post: the draft is in this repository's owner's scratch (sent to them as `tokenbrake-post.md` on 09-09), with a
   `[TABLE: …]` slot; fill it from step 3, commit the post as `POST.md`, and publish in this order: Show HN, then
   r/ClaudeCode, then X. Lead with the bill and the nulls; cite the JetBrains benchmark; do not claim more than the
   table shows.
6. Only if the table says small results dominate (the "Under the trim threshold" share is high across sessions):
   shape filters for small output become the next build, A/B'd with the protocol before default-on. Only if
   "Repeat reads" is common: repeat-read suppression, compaction-aware. Otherwise neither.

7. Two report fixes that Saturday's table wants and that are display-only, no guard change and so no A/B:
   the `what` column truncates a persisted path before the `tool-results/<id>.txt` that identifies it
   (elide the middle, not the tail), and every report prices the session as it stood when it ran, which
   for the `ab-results/real/` files means each one is a snapshot short of its session's end. The table's
   note has to say the second even if the first is fixed.

8. **ab10 runs through the adversarial benchmark, not through `AB-RUNBOOK.md`.** `tokenbrake-bench` on
   the owner's machine is built, self-checking (`node selftest.mjs` ends `ALL GREEN` with no model calls),
   and configured — guard `bcaaf58`, model `claude-fable-5-1[1m]`, no `TBD` left. It fixes by construction
   the four things this page learned the hard way: arms toggle without a second commit, measurement is
   re-derived from the transcript rather than from the guard's own ledger, the session id comes from the
   shell after the session closes, and what the guard emits is never confused with what the host delivers.
   Five paired runs, two OFF/OFF controls and one ON/SHAPE pair are pre-registered, with the verdict rule
   fixed. Roughly $30 and resumable across sittings. `AB-RUNBOOK.md` stays as the record of how ab8 and ab9
   were run.

9. **ab9, the review A/B by hand, is recorded and its faults are known.** `AB-RUNBOOK.md` is the self-contained Windows
   runbook: two arms, off against tokenbrake 0.2.4, on `claude/ab9-off` and `claude/ab9-tb` of
   `33kain/contexa`, cut from `d477c97` and differing in `.claude/settings.json` alone, so nothing is
   installed or uninstalled at all. The task is no longer the twelve-step audit — ab8 showed that measured
   a hook which fired zero times on both arms — but a release review plus a mechanism trace, built from
   measured output sizes so four steps land in the band where the trim acts, one step fails with 17k
   already printed, and one step gives the Read cap the only chance in nine rounds to save rather than
   cost. `AB-TASK.md` carries the pre-registration, the ground truth for every answer, and the validity
   gate ab7 taught: tool results ÷ requests, near 1 on both arms and within 1.5 of each other, checked
   before any comparison is read. ab8's own result stands as recorded; ab9's numbers do not compare to it,
   because the workload changed. The rtk head-to-head remains a separate round needing rtk installed by
   hand first, and blocks nothing.

Open on the owner's side: rotate the old Cloudflare token (npm done 09-09); the `anthropics/claude-code` bug and the
feature request (per-result clearing of old tool results, the lever no hook can reach), text in `AB-TASK.md`; and ab7
itself, above. `33kain/contexa` PR #61, the 0.2.3 repin, is merged. The `claude/ab6-off` and `claude/ab6-tb` branches
are cut and waiting if a two-arm Sonnet round is ever preferred to ab7's three-arm one.

## Launch vehicle

A "Does September 14 hit you?" calculator: plan tier in, current weekly usage in, projected shortfall out.
Publish before the 14th, funnel to the CONTEXA update and the npm package.

## Open question worth measuring

My estimate was that a third or more of consumption in long chat threads is re-sent history — a guess. The
twenty-second card above is the first measurement: on a 689k-token session, two thirds of the per-message cost on the
five-hour limit went away with Start fresh. The number is usable in copy as written there, with its caveats.
