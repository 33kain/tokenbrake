# Brakes — handoff

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
| 1 | Bash-output guard hooks | npm package (`tokenbrake`) | **published 0.1.0**, live-verified on Linux (Claude Code 2.1.261) |
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
drops every lookup of 0.9.89–0.9.93. The Cowork path is closed end to end. The Cowork
path is closed end to end except that last hop: exact count → cost line → brief (444 vs 123,813 tokens)
→ new session in the same project (the brief lands by itself once the right project page opens). Field-open: the
project mapping's twentieth card (0.9.94 opens the decoded page), the chat path's Start fresh on the phone, and a second session's numbers.**

## Launch vehicle

A "Does September 14 hit you?" calculator: plan tier in, current weekly usage in, projected shortfall out.
Publish before the 14th, funnel to the CONTEXA update and the npm package.

## Open question worth measuring

My estimate is that a third or more of consumption in long chat threads is re-sent history — that's a guess,
not a measurement. The A/B instrumentation in brake 2 turns it into a real figure. Don't put a number in
marketing copy until that lands.
