#!/usr/bin/env node
'use strict';
// tokenbrake guard — Claude Code hook handler.
// Zero dependencies. Fails open: any error => exit 0 with no output, Claude Code proceeds unchanged.
//
// Modes (argv[2]):
//   post      PostToolUse (matcher *) and PostToolUseFailure (Bash|PowerShell): trims oversized shell output,
//             logs every tool result size. A command that exits non-zero is a different event, and until 0.2.2
//             the guard never saw it: every failing test run entered whole. With mcpTrim on, oversized mcp__*
//             results (a content-block array, not {stdout}) are routed through the same trim pipeline.
//   read-pre  PreToolUse (matcher Read): caps unbounded reads of large files via updatedInput.limit

const fs = require('fs');
const path = require('path');
const os = require('os');

const MODE = process.argv[2] || 'post';
const CFG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const TB_DIR = path.join(CFG_DIR, 'tokenbrake');
/* Claude Code caps hook output at 10,000 characters; 9,500 is the margin. WHICH 10,000 is an OPEN QUESTION
   this code takes a position on: the docs (README, HANDOFF) say "hook output STRINGS", and until 2026-09-17
   every branch measured the replacement string. The branches now measure JSON.stringify(payload).length --
   the whole emitted envelope -- because if the ceiling is the envelope, a string-based check lets escaping
   carry an emission past it and the host drops it SILENTLY, so the original enters context and the ledger
   logs a saving that never happened.
   The two readings are not equivalent and the difference is large: JSON escaping costs a character per quote
   and backslash and six per control byte, so on dense output the envelope reading delivers roughly half, or
   on a binary dump a fifth, of what the string reading would. If the string reading is right, this is pure
   loss -- recoverable loss (out/ holds the full copy and the note names it), but loss.
   NOT YET SETTLED BY MEASUREMENT. No dropped emission has ever been observed here: 102 emitted trims across
   12 real sessions, 0 confirmed dropped. Settling it needs the pre-2026-09-17 guard emitting a string under
   9,500 whose envelope clears 10,000, in a live session, and checking whether the marker arrives -- the
   headless --debug-file method HANDOFF.md describes. Until then this errs toward delivering less rather than
   risking a silent drop; if the string reading is confirmed, revert the measurement basis here and every
   branch that measures through fitsCap/emitFitted falls back with it. */
const HOOK_OUTPUT_CAP = 9500;

const DEFAULTS = {
  enabled: true,
  maxChars: 6000,        // shell output longer than this gets trimmed (built-in ceiling is ~30,000)
  headLines: 40,
  tailLines: 40,
  keepErrorLines: 20,    // lines from the middle that look like errors/warnings are kept
  errorContextLines: 3,  // and this many lines after each, up to a blank line: the assertion, the expected/actual, the first frame
  readMaxBytes: 60000,   // Read without offset/limit on a file bigger than this gets capped
  readLimitLines: 300,
  persistedLimitLines: 80, // a saved tool output (Claude Code's tool-results/, tokenbrake's out/) read whole is capped at this
  shapeFilters: false,   // OFF by default: collapse progress redraws and repeated lines before anything else
  shapeMinChars: 1500,   // and only on results at least this long
  jsonShape: false,      // OFF by default: when trimming JSON, keep a sample of the big array + a count, not a char slice
  jsonSampleItems: 5,    // how many array items the JSON-aware trim keeps
  mcpTrim: false,        // OFF by default: also trim oversized mcp__* results (a content-block array); A/B before flipping. Pairs with jsonShape, since MCP bodies are usually JSON.
  dedup: false,          // OFF by default: replace an identical repeated result in a session with a pointer to the first; A/B before flipping
  dedupMinChars: 1000,   // don't dedup results shorter than this -- a small repeat is not worth a pointer
  readAfterEdit: false,  // OFF by default: after an Edit, narrow an unbounded Read of the same file to the changed region; A/B before flipping
  editContextLines: 20,  // lines of context kept on each side of the changed region by the delta
  reReadElide: false,    // OFF by default: a re-read of a file already read WHOLE this session, unchanged and recent, is narrowed to its first few lines plus a note; A/B before flipping
  reReadRecency: 8,      // only elide if fewer than this many whole-file reads happened since; a frequency limiter -- the guard does not consult compaction, so this just keeps elision to still-fresh reads
  reReadKeepLines: 5,    // lines kept before the pointer when a re-read is elided
  blobElide: false,      // OFF by default: replace blob-like shell output (a base64 dump, a minified bundle, a one-line JSON) with a short descriptor + a saved copy; A/B before flipping
  blobMinChars: 4000,    // don't treat output smaller than this as a blob worth eliding
  blobMaxLine: 2000,     // absolute floor: the longest line must be at least this many chars (prose, logs and pretty-printed JSON are far shorter) -- independent of blobMinChars so tuning the size gate down can't weaken it
  blobLineShare: 0.5,    // dominance: that longest line must also be at least this fraction of the output -- a single encoded/minified run, not wide multi-line data (CSV, tables)
  blobKeepChars: 160,    // chars of the head kept in the descriptor so the model can still see what it was
  gitView: false,        // OFF by default: in a `git diff`/`git show`, collapse the hunks of generated/lockfile paths to a one-line +/- summary, keeping real-source hunks; A/B before flipping
  gitViewMinChars: 2000, // don't bother collapsing a diff smaller than this
  gitCollapse: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'npm-shrinkwrap.json', 'Cargo.lock', 'go.sum', 'composer.lock', 'Gemfile.lock', 'poetry.lock', '.min.js', '.min.css', '.map'], // paths whose diff hunks are collapsed, matched as a SUFFIX (a filename or extension, so `.map` collapses foo.map but not a.mapper.js); only consulted when gitView is on
  logAllTools: true,     // record size of every tool result in the ledger (feeds `tokenbrake report`)
  shadow: true,          // ON by default: an off-by-default feature (blobElide, gitView, mcpTrim) still runs its own test and logs what it WOULD have withheld (ev:'shadow'), emitting nothing -- evidence for `tune` without a live run. Changes nothing that enters context.
  noTrim: [],            // allowlist: shell commands / read paths matching any of these substrings are left whole
  alwaysCap: []          // denylist: read paths / file-excerpt commands matching these are capped even under readMaxBytes
};

/* A persisted output: a tool result that was too big to show inline and was written to a file, by Claude Code
   (<config>/projects/<cwd>/<session>/tool-results/<id>.txt, its ~30,000-character ceiling) or by this guard
   (<config>/tokenbrake/out/<id>.txt). Reading one whole puts the oversized output back into context by another
   door; it carried 96% of the untrimmed audit arm's context (AB-TASK.md). Output that was too big to show is
   too big to read whole, whatever readMaxBytes says. An oversized mcp__* result is saved by Claude Code as
   tool-results/<id>.json, so both extensions count -- this is the safety net for MCP when mcpTrim is off (the
   default): the file re-read is capped even when the PostToolUse trim did not run. Still dir-scoped, so it
   only ever matches a file inside tool-results/ or tokenbrake/out/. */
const PERSISTED = /(^|[\\/])(tool-results|tokenbrake[\\/]out)[\\/][^\\/]+\.(txt|json)$/;

/* A line that opens with a pass marker is a passing test whatever its name says: "ok   error render call
   passes resp through" is not an error. Without this, a suite whose test names mention errors fills the
   keepErrorLines budget with green lines and the real FAIL further down never makes the cut. */
const PASS = /^\s*(?:ok|pass(?:ed)?|✓|✔|√)\b/i;
/* A shell command whose whole output is one file's contents: cat, sed -n with a range, head, tail, or a grep
   of a single named file — with no pipe and no redirect. That is a read, the same act as the Read tool, and
   the guard leaves a Read whole up to readMaxBytes. Until 0.2.3 it trimmed the same bytes to head, tail and
   error-looking lines when they came through sed, which for source is the wrong three things to keep, and a
   model that met that once sized every read after it to stay under maxChars: eighty-line sed ranges,
   ninety-one requests, twice the bill (AB-TASK.md, "Three arms"). Same shape as readKey in transcript.js;
   keep them together.

   Three things the first version got wrong, all found in one measured session (AB-TASK.md, pair 5):

   - **A `cd … &&` prefix lost the exemption.** Models working in a fixed directory write
     `cd "…/repo" && sed -n '502,535p' data.ndjson`, and that 34-line range — the model had already narrowed
     it — was shredded to head, tail and error lines. A `cd` adds no output, so it cannot change what the
     command prints.
   - **A label before or after lost it too.** `echo '=== settle.js ==='; sed -n '320,345p' settle.js` and
     `… && echo done` are the same read with one line of chrome around it. Models label their output
     constantly.
   - **A quoted path with a space lost it.** `cat "Settlement Batch.csv"` — and Windows paths have spaces.

   Pipes and redirects stay excluded on purpose: `sed -n '1,50p' f | grep x` no longer prints the file, it
   prints a filter over it, and trimming that is fair game. Recursive and list-only greps are excluded for
   the same reason -- they are a search across files, not one file's contents.

   That exclusion scans the WHOLE option cluster, not its first letter. `(?![rRlL])` only looked at the
   character after the `-`, so `grep -rn` was caught while `grep -nr`, `grep -ir` and `grep -vl` -- the same
   searches with the flags typed in the other order -- kept the single-file exemption and passed their whole
   multi-file result through untouched (measured: 36,469 characters, whole, per call). `[a-zA-Z]*[rRlL]`
   rejects the cluster wherever the r/R/l sits. */
/* The three operand slots below differ only in what they exclude, so the quoted forms live once: a change
   to shell quoting has to land in one place, not three, or the slots silently disagree -- which is the bug
   this section fixes. A quoted operand keeps its glob characters literal, which is why FILE_ excludes `*`
   and `?` only when unquoted. Note this is exact for '...' and approximate for "...": double quotes still
   expand `$VAR`, `$(...)` and backticks, so `cat "$FILES"` can print several files and still reads as one
   file's excerpt. That is a known and deliberate limit -- the guard classifies text it never executes, and
   the failure is the same fail-open direction as any other command shape it does not understand. */
const Q_ = String.raw`'[^']+'|"[^"]+"`;
const PATH_ = String.raw`(?:${Q_}|[^|;&<>'"\s]+)`;
const LABEL_ = String.raw`echo(?:\s+(?:'[^']*'|"[^"]*"|[^|;&<>'"\s]+))*`;
/* An operand, not an option. The leading `-` is what separates `grep -rn foo` -- a recursive search whose
   pattern sits in the operand slot and which names no file at all -- from `grep -i foo a.txt`. Without this,
   an option cluster the `(?![rRlL])` guard rejects falls through into the operand slots instead, and the
   recursive grep reads as one file's excerpt: the exemption the paragraph above says it does not get.
   ARG_ still allows globs because a grep PATTERN may legitimately contain `*`, `?` or `[]`. */
const ARG_ = String.raw`(?:${Q_}|(?!-)[^|;&<>'"\s]+)`;
/* The read target: ONE file. Not an option either, and unquoted it carries no `*` or `?` -- `cat *.log`
   prints many files run together, which is the oversized output the trim exists for, not one file's
   contents. Quoted, they are ordinary filename characters, so `cat '*.log'` stays an excerpt.
   `[` and `]` are deliberately NOT excluded. They are a bracket glob perhaps once in a thousand commands
   and route-segment syntax constantly -- `app/[id]/page.tsx`, `routes/[slug]/+page.svelte`,
   `pages/[...slug].js` -- and models rarely quote paths. Excluding them cost every Next.js/SvelteKit route
   file its excerpt exemption and handed the model a head/tail/error-line shred of its own source instead,
   which is a far worse and far more frequent outcome than letting `cat [ab].log` through. */
const FILE_ = String.raw`(?:${Q_}|(?!-)[^|;&<>'"\s*?]+)`;
const READ_ = String.raw`(?:cat(?:\s+-[bnAEsTv]+)*|sed\s+-n\s+['"]?[0-9]+,[0-9]+p['"]?|head(?:\s+-n?\s*[0-9]+)?` +
  String.raw`|tail(?:\s+-n?\s*[0-9]+)?|grep(?:\s+-(?![a-zA-Z]*[rRlL])[a-zA-Z]+)*\s+${ARG_})\s+${FILE_}`;
const EXCERPT = new RegExp(
  String.raw`^\s*(?:cd\s+${PATH_}\s*&&\s*)?(?:${LABEL_}\s*(?:&&|;)\s*)?${READ_}` +
  String.raw`(?:\s*(?:&&|;)\s*${LABEL_})*\s*$`);

const ERR = /\b(error|err!|fail(ed|ure|ing)?|exception|traceback|panic|fatal|warn(ing)?|not found|cannot|denied|refused)\b|✗|✖/i;

function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(CFG_DIR, 'tokenbrake.json'), 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}

/* Per-tool profiles (feature 2). tokenbrake.json may carry a `tools` map keyed by tool name
   (Bash, PowerShell, Read, ...); a tool's entry overrides the base knobs for that tool only, so you can
   trim Bash hard and leave Read loose, or set "tools": { "Bash": { "enabled": false } } to skip one tool
   while the guard still runs for the rest. Shallow merge: any knob the entry omits keeps its base value. */
function toolConfig(cfg, tool) {
  const per = tool && cfg.tools && typeof cfg.tools === 'object' ? cfg.tools[tool] : null;
  return per && typeof per === 'object' ? { ...cfg, ...per } : cfg;
}

/* Allow/deny by command or path (feature 9). A substring match against the shell command (post) or the file
   path (read-pre). `noTrim` protects a result from the guard entirely -- a `git diff` you always want whole,
   a schema you always want in full. `alwaysCap` is the other direction: cap a read (or a `cat` excerpt) at
   readLimitLines even when it is under readMaxBytes -- a lockfile, a *.min.js, a generated bundle you never
   want whole. Both default to empty, so neither changes anything until set. */
function matchesAny(patterns, str, test) {
  if (!Array.isArray(patterns) || !patterns.length || !str) return false;
  str = String(str);
  test = test || ((s, p) => s.includes(p));   // default: substring (noTrim/alwaysCap); gitCollapse passes a suffix test
  for (const p of patterns) if (p && test(str, String(p))) return true;
  return false;
}

/* noTrim is one substring list shared across domains, but a command entry like "git" must not silently match
   the MCP tool NAME "mcp__github__…" (a real footgun: it would disable MCP trimming). So for an MCP result only
   mcp__-shaped entries apply -- name the tool ("mcp__github") to protect it; for shell/read the whole list
   applies to the command/path. */
function noTrimmed(cfg, subject, isMcp) {
  const list = isMcp ? (cfg.noTrim || []).filter(p => String(p).startsWith('mcp__')) : cfg.noTrim;
  return matchesAny(list, subject);
}
function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return null; }
}
function emit(obj) { emitJson(JSON.stringify(obj)); }
function emitJson(json) {
  fs.writeSync(1, json); // synchronous so exit can't truncate it
}
/* The emitted envelope, whose key names the host dictates. Built in ONE place so that when the contract
   moves, no branch is left emitting the old shape -- a mismatch the host rejects silently. */
function payload(hookEventName, updatedToolOutput) {
  return { hookSpecificOutput: { hookEventName, updatedToolOutput } };
}
/* The hook output ceiling applies to the EMITTED JSON, not to the text. JSON escaping costs a character per
   quote, backslash and newline, so a body that passes a length check can still be refused -- and Claude Code
   drops an oversized updatedToolOutput SILENTLY: the original result enters context, the rewrite is lost, and
   the ledger records a saving that never happened. Measured, a 6,000-character trim of quote-dense output
   serializes to 11,788, and a wide one to 16,446. Every branch that rewrites a body measures with this. */
function serialize(p) { try { return JSON.stringify(p); } catch { return null; } }
function fitsCap(p) { const j = serialize(p); return j !== null && j.length <= HOOK_OUTPUT_CAP; }
/* Shrink a rewritten body until its payload fits, then emit it. `render(budget)` rebuilds the body to a
   character budget and `wrap` puts it in the tool's own response shape. The cut is PROPORTIONAL to the
   measured overage rather than equal to it: where every byte escapes to two, cutting `over` characters
   removes twice that much payload and collapses the body to nothing. Bounded passes, and the emitted payload
   is always built from the final body (assigning inside the loop emitted the one before the last cut).
   Returns the body it sent, so the ledger records what the model actually received -- or null when nothing
   was emitted at all, which is the fail-open case the tail comment explains. */
function emitFitted(hookEventName, wrap, render) {
  const f = fitPayload(hookEventName, wrap, render);
  if (!f) return null;
  emitJson(f.json);
  return f.body;
}
/* The fitting half of emitFitted, with no side effect: the body and serialized payload the guard WOULD emit, or
   null when it would emit nothing. Shadow mode measures with this, so its `kept` is byte-for-byte the live one. */
function fitPayload(hookEventName, wrap, render) {
  const payloadOf = (b) => payload(hookEventName, wrap(b));
  /* Serialized ONCE per body and carried: the loop's measurement, the final fit check and the emission all
     read the same string, where they were three JSON.stringify calls over the same ~9.5 KB payload. */
  let budget = HOOK_OUTPUT_CAP, body = render(budget), json = serialize(payloadOf(body));
  /* Six, not four: each pass multiplies the budget by cap/size so it converges geometrically, but a render
     whose body carries fixed overhead the budget does not cover (the excerpt's note) approaches from
     above and spent four passes still 438 characters over. The passes are pure string work on at most
     ~9 KB and this branch is already the oversized case. */
  for (let pass = 0; pass < 6; pass++) {
    const size = json === null ? Infinity : json.length;   // unserializable measures as over, and shrinks
    if (size <= HOOK_OUTPUT_CAP || !body) break;
    /* Scale the next budget from min(budget, body.length), then cap the step at 90% of it. Neither term
       alone works, and each failure here was measured. Scaling by the BUDGET alone stalls when `render`
       never bound it: an MCP body sat at 6,246 characters against a 9,500 budget and two passes moved
       neither. Scaling by BODY.LENGTH alone biases every estimate upward by overhead the budget does not
       cover -- the excerpt's ~350-character note -- and at high expansion the iteration settles ABOVE the
       ceiling: quotes and backslashes expand 2x and hid that, but CONTROL characters serialize as \u00XX
       and expand 6x, and a NUL- or BEL-dense body (a binary dump, a terminal capture, a .pack) stalled at
       10,889, delivering 2,005 characters of 240,000 while the ledger recorded the saving. The 0.9 clamp is
       what guarantees each pass makes progress; at that fixed point the ratio is ~0.84, so it never binds on
       its own and cannot rescue a bad scale term. */
    const eff = Math.min(budget, body.length);
    const scaled = Math.floor(eff * HOOK_OUTPUT_CAP / size);
    budget = Math.max(400, Math.min(scaled, Math.floor(eff * 0.9)));
    body = render(budget);
    json = serialize(payloadOf(body));
  }
  /* If six passes cannot make it fit, emitting anyway is the worst of both: the host refuses it, the original
     result enters context, and the caller logs a saving that did not happen. That is the failure this helper
     exists to remove, so do not commit it here. `wrap` can add content the budget does not reach -- an MCP
     result whose sibling blocks (an image, a resource) dwarf the text it trims -- and no amount of shrinking
     the text will help. Returning null means "nothing emitted": the original passes through untouched, which
     is the honest fail-open, and the caller logs no kept/saved claim for it. */
  if (json === null || json.length > HOOK_OUTPUT_CAP) return null;
  return { body, json };
}
/* Shadow mode: run an off-by-default feature's own decision and record what it would have withheld, emitting
   nothing and saving nothing. Its own try/catch, because a shadow must never change what the real path does --
   the guard fails open, and a shadow that threw would take the real trim down with it. */
function shadow(fn) { try { fn(); } catch { /* a shadow is best-effort evidence, never behaviour */ } }

/* The blob descriptor and the collapsed git body, built in one place for the live branch and its shadow. */
function blobDescriptor(text, ml, keep, saved, budget) {
  const note = saved ? ` Full output saved to ${saved} — Read it if you need the raw bytes.` : '';
  const h = text.slice(0, Math.max(0, Math.min(keep, budget)));
  return `${h}${text.length > h.length ? '…' : ''}\n\n[tokenbrake] withheld ~${Math.round(text.length / 1024).toLocaleString()} KB of blob-like output (longest line ${ml.toLocaleString()} chars — looks minified or encoded, not prose).${note}`;
}
function gitBody(g, saved) {
  return `${g.text}\n[tokenbrake] collapsed ${g.collapsed} generated/lockfile diff${g.collapsed > 1 ? 's' : ''} above; real-source hunks kept.${saved ? ` Full diff saved to ${saved} — Read it if you need the collapsed parts.` : ''}`;
}
const isBlob = (text, ml, cfg) => ml >= cfg.blobMaxLine && ml >= text.length * cfg.blobLineShare;
/* The git collapse, or null when it collapses nothing or does not shrink. A diff that names no gitCollapse path
   cannot collapse anything, so a substring pre-screen skips the split-and-join on the common case -- which
   matters now that the shadow runs this on every git diff with gitView off. */
function planGit(text, cfg) {
  const pats = Array.isArray(cfg.gitCollapse) ? cfg.gitCollapse : [];
  if (!pats.some((p) => p && text.includes(String(p)))) return null;
  const gd = collapseGitDiff(text, pats);
  return gd.collapsed && gd.text.length < text.length ? gd : null;
}
/* The live gitView's acceptance test, whole: the emitted body (collapse + note) is smaller than the diff and its
   payload fits the hook cap. See the live branch for why each half is there. */
function gitPays(body, text, evName, wrap) {
  return body.length < text.length && body.length <= HOOK_OUTPUT_CAP && fitsCap(payload(evName, wrap(body)));
}

function log(rec) {
  try {
    fs.mkdirSync(TB_DIR, { recursive: true });
    fs.appendFileSync(path.join(TB_DIR, 'ledger.jsonl'), JSON.stringify({ t: Date.now(), ...rec }) + '\n');
  } catch { /* ledger is best-effort */ }
}
function short(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

/* Save a full result to out/<session>-<toolUseId>.txt before it is cut, so nothing withheld from the model is
   lost -- the trim note names the path and `tokenbrake show <id>` retrieves it. Best-effort: any error => no
   saved copy, and the caller passes null on to the note. */
/* Where saveOut puts a result, computed without writing it -- the shadow names the same path in its note. */
function outPathFor(input) {
  const sid = String(input.session_id || 'session').slice(0, 8).replace(/[^\w-]/g, '_');   // sanitize (as sessionStatePath does): a crafted session_id must not put `/` or `..` in the out/ filename
  const tid = String(input.tool_use_id || Date.now()).slice(-10).replace(/[^\w-]/g, '');
  return path.join(TB_DIR, 'out', `${sid}-${tid}.txt`);
}
function saveOut(input, text) {
  try {
    fs.mkdirSync(path.join(TB_DIR, 'out'), { recursive: true });
    const saved = outPathFor(input);
    fs.writeFileSync(saved, text);
    return saved;
  } catch { return null; }
}

/* Dedup state (feature 6). One append-only JSONL per session under dedup/<session>.jsonl, a line
   { h, id, chars } for the first time each result was seen -- append, not rewrite, so two tool calls landing
   at once cannot lose each other's entry. Lookup scans for the hash (files are per-session and small). Every
   step is best-effort: a missing or corrupt file just means no dedup, never an error. */
function hashOf(text) {
  try { return require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 32); } catch { return null; }
}
/* One per-session append-only JSONL of small state, under <kind>/<session>.jsonl -- append, not rewrite, so
   two tool calls landing at once cannot lose each other's line. Dedup (feature 6) and Read-After-Edit
   (narrowing 1) both use it; the append body was identical in both, so it lives once here. */
function sessionStatePath(kind, session) { return path.join(TB_DIR, kind, String(session || 'session').replace(/[^\w-]/g, '_') + '.jsonl'); }
function appendSessionState(p, rec) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, JSON.stringify(rec) + '\n'); } catch { /* best-effort */ }
}
function dedupPath(session) { return sessionStatePath('dedup', session); }
function dedupLookup(session, h) {
  try {
    for (const line of fs.readFileSync(dedupPath(session), 'utf8').split('\n')) {
      if (!line) continue;
      try { const o = JSON.parse(line); if (o.h === h) return o; } catch { /* skip a bad line */ }
    }
  } catch { /* no state yet */ }
  return null;
}
function dedupRecord(session, rec) { appendSessionState(dedupPath(session), rec); }

/* Read-After-Edit state (narrowing 1). One line { file, ranges:[[from,to],...], t } per Edit/MultiEdit under
   edits/<session>.jsonl, consulted by handleReadPre to narrow a later unbounded Read of the same file to the
   changed region. Best-effort throughout: a missing or corrupt file just means no narrowing. */
function editsPath(session) { return sessionStatePath('edits', session); }
function editRecord(session, rec) { appendSessionState(editsPath(session), rec); }
function editLookup(session, file) {
  const out = [];
  try {
    for (const line of fs.readFileSync(editsPath(session), 'utf8').split('\n')) {
      if (!line) continue;
      try { const o = JSON.parse(line); if (o && o.file === file && Array.isArray(o.ranges)) out.push(o); } catch { /* skip a bad line */ }
    }
  } catch { /* no state yet */ }
  return out;
}
/* Record the changed 1-based line ranges of an Edit/MultiEdit so a later read can be narrowed to them.
   Prefer Claude Code's own structuredPatch (its per-hunk newStart/newLines are the authoritative post-edit
   diff, so it covers replace_all and edits whose new_string repeats -- both of which locating new_string by a
   unique match silently drops -- and needs no file read). The shape is validated, not assumed (the 0.1.0
   lesson): a hunk counts only when newStart/newLines are finite. Fall back to a unique indexOf of new_string
   in the post-edit file when no usable patch is present. Fails open. */
function recordEdits(input, ti, tool) {
  try {
    const fp = ti && ti.file_path; if (!fp) return;
    const ranges = patchRanges(input.tool_response);
    const found = ranges.length ? ranges : locateEdits(fp, ti, tool);
    if (found.length) editRecord(input.session_id, { file: path.resolve(fp), ranges: found, t: Date.now() });
  } catch { /* best-effort */ }
}
function patchRanges(resp) {
  const patch = resp && typeof resp === 'object' ? resp.structuredPatch : null;
  const ranges = [];
  if (Array.isArray(patch)) for (const h of patch) {
    const start = Number(h && h.newStart), len = Number(h && h.newLines);
    if (Number.isFinite(start) && start >= 1 && Number.isFinite(len)) ranges.push([start, start + Math.max(1, len) - 1]);
  }
  return ranges;
}
function locateEdits(fp, ti, tool) {
  let content; try { content = fs.readFileSync(fp, 'utf8'); } catch { return []; }
  const edits = tool === 'MultiEdit' ? (Array.isArray(ti.edits) ? ti.edits : []) : [{ new_string: ti.new_string }];
  const ranges = [];
  for (const e of edits) {
    const ns = e && typeof e.new_string === 'string' ? e.new_string : '';
    if (!ns) continue;
    const at = content.indexOf(ns);
    if (at < 0 || content.indexOf(ns, at + 1) >= 0) continue;   // absent, or not unique -> skip
    const from = content.slice(0, at).split('\n').length;
    ranges.push([from, from + ns.split('\n').length - 1]);
  }
  return ranges;
}

/* Re-read state (narrowing 2). One line per whole-file Read the guard delivered whole this session, appended
   to reads/<session>.jsonl: { file, size, mtime }. On a later unbounded Read of the same file, handleReadPre
   uses it to tell an unchanged, recent re-read (the model likely still has it) from a first read. Best-effort. */
function readsPath(session) { return sessionStatePath('reads', session); }
function readRecord(session, rec) { appendSessionState(readsPath(session), rec); }
/* The most recent prior whole-read of `file`, plus `since` = how many other whole-reads happened after it. The
   guard does not consult compaction; a small `since` is the proxy for "the read is recent, so the model still
   has it". Null when the file was not read whole this session. */
function priorRead(session, file) {
  let last = null, since = 0;
  try {
    for (const line of fs.readFileSync(readsPath(session), 'utf8').split('\n')) {
      if (!line) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (!o || !o.file) continue;
      if (o.file === file) { last = o; since = 0; } else if (last) { since++; }
    }
  } catch { /* no state yet */ }
  return last ? { size: last.size, mtime: last.mtime, since } : null;
}

/* Shape filters, OFF by default and A/B'd before any default moves.

   The trim only acts above maxChars, and a measured install log shows why that is not enough on its own:
   400 lines of progress bars kept 65 progress lines and 144 ANSI escape sequences and spent nearly the
   whole 6,000-character budget on them, leaving the final status alive only because it sat in the tail.
   Repeated near-identical lines are not information; they are the same line drawn again.

   Three passes, all conservative, in this order:
     1. ANSI escapes go. They colour a terminal nobody is looking at.
     2. A carriage-return redraw keeps its last frame. `\r` exists to overwrite, so only the last write was
        ever visible.
     3. A run of three or more consecutive lines carrying a run of BAR GLYPHS collapses to its LAST line
        plus a count. The
        last one is the informative frame — 100%, the final total — and the count keeps the fact that
        there were many.

   Redraw-like is the whole safety of this. "Differs only in numbers" is not enough and was the first
   version's bug: sixty rows of a settlement table — `acme-041   EUR   2517.41   settled` — differ only in
   numbers too, and collapsing them destroys fifty-nine tenants' amounts and leaves a count. Found by an
   outside benchmark before a single run was paid for. A line qualifies only if it carries a run of bar
   glyphs. A percentage was allowed for one afternoon and had to be removed for the same reason: risk
   scores are percentages too.

   What it deliberately does not do: collapse passing-test lines. Their names are answers to real questions
   ("how many checks passed, and what was the last one") and a count is not always enough. That is a
   separate flag if it is ever wanted, measured separately.

   Nothing here is lossy about which distinct lines occurred, only about how many times a line was redrawn. */
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
function shapeKey(line) {
  return line
    .replace(/[=\-#>*.·▏▎▍▌▋▊▉█░▒▓]{2,}/g, '§')  // a run of bar glyphs is one glyph
    .replace(/\d[\d.,:%]*/g, '#')                 // any number is the same number
    .replace(/[ \t]+/g, ' ')                      // a bar pads itself with spaces as it fills
    .trim();
}
/* A progress redraw carries a run of bar glyphs. Nothing else is enough.

   A percentage was in this list for one afternoon and had to come out: eighty rows of
   `tenant acme-079 risk score 53% approved` collapsed to one row and a count, the same destruction the
   settlement table showed, reached through the other half of the test. Percentages appear in data far more
   often than they appear in progress bars, and "the numbers differ" is never a licence to delete a line.
   The cost of dropping it is that `Downloading… 45%` with no bar is no longer collapsed. That is the right
   side to err on: a filter that misses noise is a nuisance, one that eats rows is a bug. */
const REDRAW = /[=\-#>*·▏▎▍▌▋▊▉█░▒▓]{3,}/;
function shapeFilter(text) {
  /* `\r` at the END of a line is a CRLF line ending, not a redraw. Treating it as one turned a 120-row
     CRLF CSV into 121 characters of empty lines — every field gone — because "keep what follows the last
     \r" follows nothing. A line is only a redraw if a `\r` sits INSIDE it; a plain line, CRLF or LF, comes
     through byte for byte. */
  const src = text.replace(ANSI, '').split('\n').map(l => {
    const body = l.endsWith('\r') ? l.slice(0, -1) : l;
    if (body.indexOf('\r') < 0) return l;
    return body.slice(body.lastIndexOf('\r') + 1);
  });
  const out = [];
  for (let i = 0; i < src.length;) {
    const key = shapeKey(src[i]);
    let j = i + 1;
    if (key && REDRAW.test(src[i])) while (j < src.length && shapeKey(src[j]) === key && REDRAW.test(src[j])) j++;
    const run = j - i;
    if (run >= 3) {
      out.push(src[j - 1]);
      out.push(`[tokenbrake] the line above was drawn ${run} times; ${run - 1} identical-shaped lines collapsed`);
    } else {
      for (let k = i; k < j; k++) out.push(src[k]);
    }
    i = j;
  }
  return out.join('\n');
}

/* JSON-aware trim (feature 5), OFF by default and A/B'd before any default moves. A char slice through a
   100-record JSON dump leaves two broken half-objects and a middle that is gone with no shape and no count;
   the head/tail line trim is no better on minified JSON that is one line. When the result parses as JSON,
   keep the first N items of the big array and say how many there were, so the model sees the shape, a real
   sample, and the total -- and the full output is on disk (this runs only in the trim path, after the save)
   so nothing is lost. Only two shapes are handled -- a top-level array, and an object with one dominant
   array property; anything else returns null and the ordinary trim takes over. Conservative on purpose: an
   array too short to be worth cutting is left to the normal trim, same caution as the shape filters. */
function jsonTrim(text, cfg, note) {
  const t = text.trim();
  if (t[0] !== '[' && t[0] !== '{') return null;
  let data;
  try { data = JSON.parse(t); } catch { return null; }
  const K = Math.max(1, Number(cfg.jsonSampleItems) || 5);
  if (Array.isArray(data)) {
    if (data.length <= K + 1) return null;
    return `${JSON.stringify(data.slice(0, K), null, 2)}\n[tokenbrake] showing the first ${K} of ${data.length.toLocaleString()} array items (${text.length.toLocaleString()} chars).${note}`;
  }
  if (data && typeof data === 'object') {
    let key = null, bytes = -1;
    for (const k of Object.keys(data)) if (Array.isArray(data[k])) { const b = JSON.stringify(data[k]).length; if (b > bytes) { key = k; bytes = b; } }
    if (key == null || data[key].length <= K + 1) return null;
    return `${JSON.stringify({ ...data, [key]: data[key].slice(0, K) }, null, 2)}\n[tokenbrake] the "${key}" array was cut to its first ${K} of ${data[key].length.toLocaleString()} items (${text.length.toLocaleString()} chars total).${note}`;
  }
  return null;
}

/* Extract the text of an mcp__* result and a rebuilder that returns the SAME shape with trimmed text in place.
   Observed live (mcp__github__list_commits, 2026-09-13): a bare content-block array [{type:'text',text},…] --
   the whole result, in full, before Claude Code's own "too large → saved to file + 2KB preview" step. Also
   handle a { content:[…] } wrapper and a bare string, since the exact shape is per-server. Non-text blocks
   (images, …) are preserved after the trimmed text. Returns null when there is nothing to trim, so the guard
   falls open to log-only. Rebuilding in the arrived-in shape is the Bash {stdout} lesson: updatedToolOutput is
   validated against the tool's own response schema and a wrong shape is rejected silently. */
function mcpBody(resp) {
  const fromBlocks = (blocks) => {
    if (!Array.isArray(blocks)) return null;
    const texts = blocks.filter(b => b && b.type === 'text' && typeof b.text === 'string');
    if (!texts.length) return null;
    const others = blocks.filter(b => !(b && b.type === 'text' && typeof b.text === 'string'));
    return { text: texts.map(b => b.text).join('\n'), make: (t) => [{ type: 'text', text: t }, ...others] };
  };
  if (Array.isArray(resp)) {
    const b = fromBlocks(resp);
    return b && { text: b.text, rebuild: b.make };
  }
  if (resp && typeof resp === 'object' && Array.isArray(resp.content)) {
    const b = fromBlocks(resp.content);
    return b && { text: b.text, rebuild: (t) => ({ ...resp, content: b.make(t) }) };
  }
  if (typeof resp === 'string') return { text: resp, rebuild: (t) => t };
  return null;
}

function trimText(text, cfg, savedPath, cap = HOOK_OUTPUT_CAP) {
  const lines = text.split('\n');
  const note = savedPath ? ` Full output saved to ${savedPath} — Read or Grep it if you need more.` : '';
  let out;

  const shaped = cfg.jsonShape ? jsonTrim(text, cfg, note) : null;
  if (shaped != null && shaped.length < text.length) {
    out = shaped;
  } else if (lines.length > cfg.headLines + cfg.tailLines + 5) {
    /* Flagged lines from the middle, each with the lines that follow it up to a blank line or
       errorContextLines, whichever comes first. A FAIL line alone names the test; the assertion, the
       expected/actual pair and the first stack frame are the lines after it, and a model that gets only
       the name comes back for the rest: a whole extra request that re-reads everything. Windows that
       touch are merged; a gap between windows is shown as one "…" line. */
    const chars = (arr) => arr.reduce((n, l) => n + l.length + 1, 0);
    let headN = cfg.headLines, tailN = cfg.tailLines;
    let ctx = Math.max(0, Number(cfg.errorContextLines) || 0);
    const flaggedLines = (ctx) => {
      const midStart = headN, midEnd = lines.length - tailN;
      const keep = new Map();
      let flaggedCount = 0;
      for (let i = midStart; i < midEnd && flaggedCount < cfg.keepErrorLines; i++) {
        if (PASS.test(lines[i]) || !ERR.test(lines[i])) continue;
        flaggedCount++;
        keep.set(i, true);
        for (let j = i + 1; j <= i + ctx && j < midEnd; j++) {
          if (!lines[j].trim()) break;
          keep.set(j, true);
        }
      }
      const out = [];
      let prev = null;
      for (const i of [...keep.keys()].sort((a, b) => a - b)) {
        if (prev != null && i !== prev + 1) out.push('  …');
        out.push(`  L${i + 1}: ${short(lines[i], 200)}`);
        prev = i;
      }
      return out;
    };
    const marker = (flagged) => [
      '',
      `[tokenbrake] ${lines.length - tailN - headN} lines omitted here (${text.length.toLocaleString()} chars total).${note}`,
      ...(flagged.length ? [`[tokenbrake] error/warning-looking lines from the omitted region${ctx ? `, each with up to ${ctx} lines after it` : ''}:`, ...flagged] : []),
      ''
    ];
    /* Budget, in this order: the flagged lines and their context first, since they are what the model
       would otherwise come back for; then head and tail fill what is left of maxChars, down to a floor
       of ten lines each. Context that would take more than half the budget on its own is dropped and the
       flagged lines stand alone, as before 0.2.2. */
    let flagged = flaggedLines(ctx);
    if (ctx && chars(flagged) > cfg.maxChars / 2) { ctx = 0; flagged = flaggedLines(0); }
    const total = () => chars(lines.slice(0, headN)) + chars(marker(flagged)) + chars(lines.slice(lines.length - tailN));
    while (total() > cfg.maxChars && (headN > 10 || tailN > 10)) {
      if (headN >= tailN && headN > 10) headN--; else if (tailN > 10) tailN--; else headN--;
    }
    if (headN !== cfg.headLines || tailN !== cfg.tailLines) flagged = flaggedLines(ctx);   // the middle grew: scan it once more
    out = [...lines.slice(0, headN), ...marker(flagged), ...lines.slice(lines.length - tailN)].join('\n');
  } else {
    // Few lines but huge (minified output, one giant line): cut by characters.
    const half = Math.floor(cfg.maxChars / 2);
    out = text.slice(0, half) + `\n\n[tokenbrake] ${(text.length - 2 * half).toLocaleString()} chars omitted here.${note}\n\n` + text.slice(-half);
  }

  if (out.length > cap) {
    const half = Math.floor((cap - 120) / 2);
    out = out.slice(0, half) + `\n\n[tokenbrake] further trimmed to fit hook output cap.${note}\n\n` + out.slice(-half);
  }
  return out;
}

/* Length of the longest line, without allocating a split. Blob detection (narrowing 3) uses it as the tell
   that separates an encoded/minified run -- a base64 dump, a bundled/minified file, a one-line JSON -- from
   prose, logs and pretty-printed JSON, whose lines stay short however large the whole gets. */
function maxLineLen(text) {
  let max = 0, cur = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) { if (cur > max) max = cur; cur = 0; } else cur++;
  }
  return cur > max ? cur : max;
}

/* Change-Aware Git View (narrowing 4). A `git diff`/`git show` re-adds the whole diff on every request, and the
   noisiest part is usually generated -- a lockfile, a *.min.js, a source map -- that no one reads line by line.
   collapseGitDiff replaces the hunk body of files whose path matches `patterns` with a one-line +adds/-dels
   summary, keeps every real-source hunk verbatim, and leaves the commit/preamble intact. It never drops a
   file's presence (the `diff --git` header stays), only its hunks. Returns the rewritten text and the count
   collapsed; the caller acts only when at least one collapsed and the result got smaller. Pure string work over
   the diff already in hand -- no git invocation. A quoted/space path that the header regex misses is left
   whole (safe). */
const GIT_DIFF = /\bgit(?:\s+-C\s+\S+)?\s+(?:diff|show)\b/;
function collapseGitDiff(text, patterns) {
  const parts = text.split(/(?=^diff --git )/m);   // each file section begins "diff --git "; parts[0] is any preamble
  let collapsed = 0;
  const out = parts.map((sec) => {
    if (!sec.startsWith('diff --git ')) return sec;
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(sec);
    const file = m ? m[2].trim() : null;
    if (!file || !matchesAny(patterns, file, (s, p) => s.endsWith(p))) return sec;   // suffix: `.map` must not match `a.mapper.js`
    let adds = 0, dels = 0;                                    // count +/- line-starts without allocating a split
    for (let i = 0; i < sec.length; ) {
      const c = sec.charCodeAt(i);
      if (c === 43 && !sec.startsWith('+++', i)) adds++;        // '+' content line, not the +++ file header
      else if (c === 45 && !sec.startsWith('---', i)) dels++;   // '-' content line, not the --- file header
      const nl = sec.indexOf('\n', i);
      if (nl === -1) break;
      i = nl + 1;
    }
    if (adds + dels === 0) return sec;   // rename/mode change only -- no hunks to collapse
    collapsed++;
    const nl = sec.indexOf('\n');
    const firstLine = nl === -1 ? sec : sec.slice(0, nl);   // the `diff --git a/… b/…` header, kept
    return `${firstLine}\n[tokenbrake] +${adds}/-${dels} lines, diff collapsed (generated/lockfile path)\n`;
  });
  return collapsed ? { text: out.join(''), collapsed } : { text, collapsed: 0 };   // no join/copy when nothing collapsed
}

function handlePost(input, cfg) {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const resp = input.tool_response;
  const isShell = tool === 'Bash' || tool === 'PowerShell';
  const isMcp = /^mcp__/.test(tool);
  cfg = toolConfig(cfg, tool);
  /* PostToolUseFailure: for Bash, the command exited non-zero. The output arrives in `error` as one string
     ("Exit code 1", then stdout and stderr), with no tool_response on the Claude Code line this was written
     against (2.1.261) and, per the docs, possibly both. Take whichever carries the text. An interrupted
     call is the user's doing: nothing to trim, nothing to log. */
  const failed = input.hook_event_name === 'PostToolUseFailure';
  /* The Bash response shape, in one place. CLAUDE.md: Claude Code validates updatedToolOutput against the
     tool's own schema and drops a mismatch SILENTLY, so a shape change that reaches five of six call sites
     fails with nothing in the log. Every rewrite branch below is inside a `!failed` guard, so the term is
     redundant at each of them individually and load-bearing for the one shared spelling. On failure the
     output Claude sees is the error string itself, so the replacement is a string too. */
  const evName = failed ? 'PostToolUseFailure' : 'PostToolUse';
  const wrapShell = (t) => (!failed && resp && typeof resp === 'object') ? { ...resp, stdout: t, stderr: '' } : t;
  /* One spelling of "what the ledger calls an emission that did not go out". Four branches log this, and it
     had already drifted between them. */
  const outcome = (b) => (b == null ? { unfitted: true } : { kept: b.length });
  if (failed && input.is_interrupt) return;
  const asText = (v) => typeof v === 'string' ? v
    : (v && typeof v === 'object') ? (isShell ? [v.stdout, v.stderr].filter(Boolean).join('\n') : JSON.stringify(v)) : '';
  let text = asText(resp);
  if (failed) { const e = asText(input.error); if (e.length > text.length) text = e; }

  /* `id` and `transcript` (0.1.0, for brake 4): the tool_use_id is how a ledger row joins the transcript's
     tool_result exactly, and transcript_path is where that transcript is — Claude Code hands both over on
     stdin, so the report never has to guess a path or match on a command string. */
  const rec = {
    ev: 'post', session: input.session_id, tool, chars: text.length,
    what: isShell ? short(ti.command, 120) : (ti.file_path || ti.pattern || ti.url || ti.description || undefined),
    id: input.tool_use_id || undefined,
    transcript: input.transcript_path || undefined,
    failed: failed || undefined,
    /* Shadow was on for this call. Without it a session whose shadow saw nothing to act on reads the same as one
       where shadow never ran, and tune would fall back to an estimate the shadow had already answered. */
    sh: cfg.shadow ? 1 : undefined
  };

  /* Resolve the MCP body once (features 1/6): its inner text is the size basis -- rec.chars was the
     JSON.stringify of the whole block array -- and the dedup and MCP branches below both reuse it. Set here,
     BEFORE the disabled-log, so a per-tool-disabled MCP tool records inner-text chars, not the wrapper length. */
  const mcp = isMcp ? mcpBody(resp) : null;
  if (mcp) rec.chars = mcp.text.length;

  /* A per-tool profile can switch the guard off for one tool while it runs for the rest: still measure the
     result in the ledger, but pass it through untrimmed. */
  if (!cfg.enabled) { if (cfg.logAllTools) log(rec); return; }

  /* Read-After-Edit Delta (record side): remember which lines this Edit changed, so a later unbounded Read of
     the same file can be narrowed to the changed region (handleReadPre). Off by default, so recording is
     skipped entirely when off. Recording, then falling through to the normal per-tool logging below. */
  if (cfg.readAfterEdit && !failed && (tool === 'Edit' || tool === 'MultiEdit')) recordEdits(input, ti, tool);

  /* Dedup (feature 6): the same result twice in one session is paid for twice -- it re-enters context and is
     carried from then on. When it repeats, hand back a short pointer to the first copy instead of the whole
     thing. Hash the ORIGINAL bytes (the inner text: stdout for shell, the joined text blocks for MCP), before
     any shaping. Bash/PowerShell + MCP only; a Read is already covered by the read cap. The first occurrence is
     saved to out/ even if it is never trimmed, so the pointer is retrievable via `tokenbrake show`. Off by
     default (dedup); A/B gates it. Honors noTrim, and fails open on every step. The pointer carries the marker,
     so `report` credits chars - kept the same way it credits a trim. */
  const dsubject = isShell ? String(ti.command || '') : tool;
  if (cfg.dedup && !failed && (isShell || isMcp) && input.session_id && !noTrimmed(cfg, dsubject, isMcp)) {
    const dtext = isMcp ? (mcp && mcp.text) : text;
    if (dtext && dtext.length >= cfg.dedupMinChars) {
      const h = hashOf(dtext);
      const prior = h ? dedupLookup(input.session_id, h) : null;
      if (prior) {
        const pointer = `[tokenbrake] identical to an earlier result this session (${prior.chars.toLocaleString()} chars). Full: tokenbrake show ${prior.id}`;
        /* The pointer is ~110 characters, but the PAYLOAD carrying it need not be small: for MCP,
           rebuild() keeps every non-text sibling block (an image, a resource) and spreads the original
           response around it. Measured, a duplicate screenshot result emitted 40,306 characters against a
           9,500 ceiling -- dropped silently, the whole duplicate entering context while the ledger booked
           chars - kept as saved. So this branch measures like every other rewrite, and when the pointer
           cannot be delivered it claims nothing and falls through to the ordinary handling below. */
        const dedupPayload = payload(evName, isMcp ? mcp.rebuild(pointer) : wrapShell(pointer));
        if (fitsCap(dedupPayload)) {
          log({ ...rec, chars: dtext.length, dedup: true, sameAs: prior.id, kept: pointer.length });
          emit(dedupPayload);
          return;
        }
      }
      if (h) { const saved = saveOut(input, dtext); if (saved) dedupRecord(input.session_id, { h, id: path.basename(saved).replace(/\.txt$/, ''), chars: dtext.length }); }
    }
  }

  /* MCP tool-output trimming (feature 1). An mcp__* result is a content-block array the guard sees in full,
     before Claude Code's own "too large → saved to file + preview" step (which otherwise persists the whole
     result to a file that then gets re-read whole -- the carry the product exists to cut). Route it through
     the same trimText pipeline as shell output, but rebuild the reply in the shape it arrived in. Off by
     default (mcpTrim); A/B gates turning it on. noTrim matches the tool name for an MCP result. On failure the
     PostToolUseFailure matcher never routes MCP here, but guard defensively. `chars` on the trim row is the
     inner text length, so it shares a basis with `kept` the way the shell rows do. */
  if (isMcp) {
    const body = mcp;   // resolved once above; rec.chars is already the inner-text length
    /* One decision for the live trim and its shadow: the same test, the same trimText, the same fitting and the
       same saved-path note -- so a shadow row's kept is what the live branch would have emitted. The shadow's
       whole decision runs inside shadow()'s try/catch, so nothing it does can stop the logging below. */
    const mcpCandidate = !failed && body && !noTrimmed(cfg, tool, true) && body.text.length > cfg.maxChars;
    if (mcpCandidate && !cfg.mcpTrim && cfg.shadow) shadow(() => {
      const f = fitPayload(evName, (t) => body.rebuild(t), (b) => trimText(body.text, cfg, outPathFor(input), b));
      if (f) log({ ...rec, ev: 'shadow', feature: 'mcpTrim', kept: f.body.length });   // rec.chars is already the inner-text length
    });
    if (mcpCandidate && cfg.mcpTrim) {
      const saved = saveOut(input, body.text);
      /* Measured like the shell trim: an MCP body is JSON, so escaping is at its worst here -- a one-line
         dense result trimmed to 6,246 characters serialized to 12,377, past the ceiling, and was dropped. */
      const trimmed = emitFitted(evName, (t) => body.rebuild(t), (b) => trimText(body.text, cfg, saved, b));
      log({ ...rec, mcp: true, saved, ...outcome(trimmed) });
      return;
    }
    if (cfg.logAllTools) log(rec);
    return;
  }

  /* noTrim allowlist: a matched shell command is left exactly as it came, only recorded. */
  if (isShell && matchesAny(cfg.noTrim, String(ti.command || ''))) { if (cfg.logAllTools) log({ ...rec, noTrim: true }); return; }

  /* Shaping runs before the size test, so a log that collapses below maxChars is delivered clean and never
     trimmed at all. That is the point: the trim's head/tail/flagged shape is right for a log and the wrong
     thing to spend on redraws. */
  let shaped = false;
  if (isShell && cfg.shapeFilters && text.length >= cfg.shapeMinChars) {
    const s2 = shapeFilter(text);
    if (s2.length < text.length) { rec.shapedFrom = text.length; rec.shapedTo = s2.length; text = s2; shaped = true; }
  }

  /* Binary-Blob Elider (narrowing 3): shell output that is an encoded or minified run -- a base64 dump, a
     minified bundle, a giant one-line JSON -- is unreadable to the model as bytes, yet it re-enters context on
     every request until compaction. Replace it with a short head plus a descriptor and a saved copy, so the
     model can see what it was and Read the file back if it truly needs the bytes. Fires whether or not the
     output is over maxChars: an excerpt under readMaxBytes and a below-threshold blob both pass whole otherwise,
     and even an over-maxChars blob keeps maxChars of garbage under the char-slice above -- the descriptor keeps
     a few. Off by default (blobElide); noTrim already returned above. The tell is one very long line that is
     most of the output: blobMaxLine is the absolute floor (an encoded/minified line runs to thousands of chars;
     prose, logs and pretty JSON stay short) and blobLineShare the dominance test (that longest line is at least
     that fraction of the whole). Two independent floors on purpose -- share alone, coupled to blobMinChars,
     would let a tuned-down size gate elide a merely-long line; wide-but-structured data (CSV, tables) has many
     wide lines, none dominant, and is left alone by the share test. Not on a failed command -- an error is
     wanted whole and rarely a blob. Logged as ev:'post' with blob:true; a plain
     trim to the backfire audit (marker + saved out/), so report --backfire counts it and a re-read of the saved
     file as a pull-back with no new machinery. */
  /* Binary-Blob Elider and Change-Aware Git View each have ONE decision (isBlob / planGit, the same renderer, the
     same fitting) that goes one of two ways: live (the feature is on) emits it, and shadow (the feature is off,
     shadow on) logs what it would have emitted -- with the same saved-path note -- and emits and saves nothing.
     Shared pieces, so the shadow cannot drift from what the live path would do. */
  /* The shadow's WHOLE decision runs inside shadow()'s try/catch, the test included: anything it throws must
     never reach the guard's outer fail-open, which would exit before the live trim below ever ran. */
  if (isShell && !failed && !cfg.blobElide && cfg.shadow && text.length >= cfg.blobMinChars) shadow(() => {
    const ml = maxLineLen(text);
    if (!isBlob(text, ml, cfg)) return;
    const f = fitPayload(evName, wrapShell, (budget) => blobDescriptor(text, ml, cfg.blobKeepChars, outPathFor(input), budget));
    if (f) log({ ...rec, ev: 'shadow', feature: 'blobElide', chars: text.length, kept: f.body.length });
  });
  if (isShell && !failed && cfg.blobElide && text.length >= cfg.blobMinChars) {
    const ml = maxLineLen(text);
    if (isBlob(text, ml, cfg)) {
      /* Measured like the others. This branch's kept head is base64 or minified source BY CONSTRUCTION, so it
         is the most escape-dense body the guard ever emits -- `blobKeepChars` is 160 by default, which is why
         a fixed character reserve ever appeared to hold, but raising it is a one-knob change and at 8,000
         this emitted 16,474. Math.max(0) in blobDescriptor is NOT dead: `keep` comes from config, and a
         negative blobKeepChars would make slice() cut from the END of the blob. The ceiling is the fitter's
         job alone; blobKeepChars means what it says. */
      const keep = cfg.blobKeepChars;
      const saved = saveOut(input, text);
      const descriptor = emitFitted(evName, wrapShell, (budget) => blobDescriptor(text, ml, keep, saved, budget));
      // chars = the (possibly shaped) text we actually withheld, not the pre-shape rec.chars
      log({ ...rec, chars: text.length, blob: true, saved, ...outcome(descriptor) });
      return;
    }
  }

  /* Change-Aware Git View (narrowing 4): collapse the generated/lockfile hunks of a `git diff`/`git show` so the
     whole diff stops re-entering context, keeping every real-source hunk. Off by default (gitView). Only a git
     diff/show (not `git log`, not `git status`); a diff with no generated files, or `--stat`/`--name-only`
     output (no `diff --git` hunks), collapses nothing and falls through. Saves the full diff to out/ and carries
     the marker, so report --backfire counts it (kind 'gitview') and a re-read of the saved file as a pull-back.
     Skipped if the collapsed body would still exceed the hook output cap -- a huge all-real-source diff is left
     to the normal trim below. Not on a failed command. */
  const gitCandidate = isShell && !failed && text.length >= cfg.gitViewMinChars && GIT_DIFF.test(String(ti.command || ''));
  if (gitCandidate && !cfg.gitView && cfg.shadow) shadow(() => {
    const gd = planGit(text, cfg);
    if (!gd) return;
    const body = gitBody(gd, outPathFor(input));
    if (gitPays(body, text, evName, wrapShell)) log({ ...rec, ev: 'shadow', feature: 'gitView', chars: text.length, kept: body.length, collapsed: gd.collapsed });
  });
  if (gitCandidate && cfg.gitView) {
    const gd = planGit(text, cfg);
    if (gd) {
      const saved = saveOut(input, text);
      const body = gitBody(gd, saved);
      /* Act only when the FULL emitted body (collapse + the summary note that names the saved path) is actually
         smaller than the original AND fits the hook cap. A tiny generated hunk in an otherwise large real-source
         diff can shrink the collapse yet leave `body` bigger than the diff once the note is added -- emitting
         that would grow context and log kept > chars, poisoning the A/B. When it does not pay off (or a huge
         all-real-source diff would still overflow the cap), fall through to the normal trim below; that path
         re-saves the same out/ file (idempotent, same tool_use_id) -- accepted for this uncommon case.
         The cap test is on the EMITTED payload, not on `body`: a collapsed diff whose kept real-source hunks
         are quote- or backslash-dense passed the character check and serialized past the ceiling (measured
         10,456 at 60 such lines, 17,058 at 100). body.length first is a free and SOUND precondition (JSON
         escaping never shrinks a string), and spares serializing a diff that can run to hundreds of KB. */
      if (gitPays(body, text, evName, wrapShell)) {
        log({ ...rec, gitview: true, chars: text.length, kept: body.length, saved });   // chars = the diff we withheld
        emit(payload(evName, wrapShell(body)));
        return;
      }
    }
  }

  if (!isShell || text.length <= cfg.maxChars) {
    if (cfg.logAllTools) log(rec);
    /* Shaped but under the trim threshold: the replacement still has to go out, or the shaping is a
       measurement of something the model never received — the mistake the report's credit fix was about. */
    if (shaped) {
      /* Under maxChars is not under the ceiling: a 5.8 KB shaped build log of quote-dense lines emitted
         11,751. Shaping is the one rewrite that can be reached with a single knob on stock defaults, and a
         dropped shaping is exactly the "measurement of something the model never received" the note above
         warns about -- so it is measured too. The text is already below maxChars, so the fold only ever
         engages on escaping.
         When it does engage it must SAY so. A bare slice delivered a build log that stopped mid-token with
         no marker, no out/ copy and a ledger row claiming shapedTo -- measured, 943 characters gone from a
         9,428-character shaped body, the silent loss this whole change exists to remove, inverted from
         "emitted nothing" into "emitted less than it claimed". The note is charged against the budget, so
         the body plus its note still fits, and out/ is written only on the pass that actually cuts. */
      let shapeSaved = null;
      const renderShaped = (b) => {
        if (text.length <= b) return text;
        if (shapeSaved === null) shapeSaved = saveOut(input, text) || '';
        const note = `\n\n[tokenbrake] ${(text.length - b).toLocaleString()} characters cut to fit the hook output cap.`
          + (shapeSaved ? ` Full output saved to ${shapeSaved} — Read it if you need the rest.` : '');
        const body = text.slice(0, Math.max(0, b - note.length)) + note;
        return body;
      };
      const shapedOut = emitFitted(evName, wrapShell, renderShaped);
      log({ ...rec, shaped: true, saved: shapeSaved || null, ...outcome(shapedOut) });
    }
    return;
  }

  /* A file excerpt is read like a Read: untouched up to readMaxBytes, and above that capped to the first
     readLimitLines lines with the same note the Read cap gives, not trimmed to head, tail and error lines. */
  const excerpt = !failed && EXCERPT.test(String(ti.command || ''));
  if (excerpt && text.length <= cfg.readMaxBytes && !matchesAny(cfg.alwaysCap, String(ti.command || ''))) {
    if (cfg.logAllTools) log({ ...rec, excerpt: true });
    return;
  }
  if (excerpt) {
    const all = text.split('\n');
/* Fit the hook output cap, which trimText applies to the trim path and this branch has to apply to
       itself: Claude Code validates updatedToolOutput and drops an oversized one SILENTLY, so 300 lines of
       a wide file would lose the cap altogether instead of applying it (15 KB at 40-char lines, 40 KB at
       120, against a 10,000-char ceiling).
       The ceiling is a property of the emitted JSON, not of the text, and JSON escaping costs a character
       for every quote, backslash and newline -- so a fixed reserve cannot cover it. Measured on this
       branch, 8.1 KB of text emits 8.6 KB of JSON from plain lines but 10.0 KB from quote-heavy JSON
       (`cat package-lock.json`), 10.1 KB from Windows paths and 16.5 KB from quote-dense content. So
       measure the real payload and cut the body by the overage. The note is rebuilt each pass, never
       sliced: a note claiming 300 lines while delivering 117 tells the model something false about its own
       context, and a note cut in half tells it nothing. Bounded passes, and a body that will not shrink
       emits NOTHING -- the original passes through untouched, which is how this fails open. */
/* The note counts CHARACTERS as well as lines. Lines alone are a lie on output that has few of them:
       a 100,000-char minified bundle read whole is one line, the fold cuts it to ~9,000 chars mid-line, and
       a lines-only note reads "the first 1 of 1 lines" -- telling the model the whole file is present while
       91% of it is gone and, with saved:null, gone with no copy to go back to. Characters move whenever
       anything is withheld, whatever the line structure. */
    const noteFor = (body) => `\n\n[tokenbrake] file excerpt capped at the first ${(body ? body.split('\n').length : 0).toLocaleString()} of ${all.length.toLocaleString()} lines, ${body.length.toLocaleString()} of ${text.length.toLocaleString()} characters. A few large ranges cost less than many small ones: each call is a request that re-reads the whole context. Use a narrower range, or Grep to locate the section first.`;

    /* Cut to the budget, then snap back to a line boundary only when that is CHEAP. When the last newline
       sits near the START -- a minified bundle behind a one-line `//# sourceMappingURL` header, a lockfile
       behind its opening `{` -- snapping throws away everything after it: measured, 34 characters delivered
       of 200,035, and 1 of 150,002, on exactly the huge single-line files this branch most often sees. Past
       the halfway mark the snap costs at most a partial line; before it the mid-line cut stands, and the
       note counts characters so a body ending mid-line is still described honestly. */
    const renderExcerpt = (budget) => {
      let kept = all.slice(0, cfg.readLimitLines).join('\n');
      if (kept.length > budget) {
        kept = kept.slice(0, budget);   // emitFitted never renders below a 400 budget
        const nl = kept.lastIndexOf('\n');
        if (nl > 0 && nl >= kept.length / 2) kept = kept.slice(0, nl);
      }
      return kept + noteFor(kept);
    };
    const keptExcerpt = emitFitted(evName, wrapShell, renderExcerpt);
    log({ ...rec, excerpt: true, saved: null, ...outcome(keptExcerpt) });
    return;
  }

  const saved = saveOut(input, text);

  // Claude Code validates updatedToolOutput against the tool's own response schema. For Bash that is
  // { stdout, stderr, interrupted, isImage } — a bare string is rejected (silently, in the debug log only)
  // and the original output goes through untouched. Keep the object shape, put the trimmed text in stdout.
  // On failure the output Claude sees is the error string itself, so the replacement is a string too.

  /* The ceiling is a property of the EMITTED JSON, and trimText measures the text. JSON escaping costs a
     character per quote, backslash and newline, so the two diverge exactly on the output most worth
     trimming: measured, a 6,000-character trim of quote-dense build output emits 11,788 characters, and a
     wide one 16,446, against a 10,000 ceiling. Claude Code drops an oversized updatedToolOutput SILENTLY --
     so the trim is discarded and the FULL untrimmed result enters context, the precise inverse of the
     intent, with nothing in the ledger to say it happened. Re-trim to a budget shrunk by the measured
     overage until the real payload fits. Bounded passes, and the last text emitted is the one logged. */
  const trimmed = emitFitted(evName, wrapShell, (b) => trimText(text, cfg, saved, b));
  log({ ...rec, saved, ...outcome(trimmed) });
}

/* Lines in a file, by counting newline bytes -- the ledger's `lines` convention throughout, so a file with no
   trailing newline reads one short. Skipped above 20 MB rather than reading that much to count. */
function countLines(fp, size) {
  if (size > 20 * 1024 * 1024) return null;
  try {
    const buf = fs.readFileSync(fp);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    return n;
  } catch { return null; }
}

function handleReadPre(input, cfg) {
  cfg = toolConfig(cfg, input.tool_name || 'Read');
  /* Per-tool disabled: record the read still happened (symmetric with handlePost, which logs its result even
     when disabled) so `report` does not silently lose the evidence -- then leave the read uncapped. */
  if (!cfg.enabled) { if (cfg.logAllTools && input.tool_input && input.tool_input.file_path) log({ ev: 'read-disabled', session: input.session_id, tool: input.tool_name || 'Read', what: input.tool_input.file_path }); return; }
  const ti = input.tool_input || {};
  const fp = ti.file_path;
  if (!fp || ti.limit != null || ti.offset != null) return;          // already bounded
  if (/\.(png|jpe?g|gif|webp|bmp|svg|pdf|ipynb)$/i.test(fp)) return;   // binary/paged formats handled by Read itself
  if (matchesAny(cfg.noTrim, fp)) return;                             // allowlist: never cap this path

  let st;
  try { st = fs.statSync(fp); } catch { return; }
  if (!st.isFile()) return;
  const nLines = countLines(fp, st.size);   // computed once; the delta and the size cap below both read it
  /* A persisted output lives UNDER the Claude Code config dir (its projects/.../tool-results/, or tokenbrake's
     own out/). Requiring that anchor stops a user's own build/tool-results/*.json from being force-capped as if
     it were a saved tool output -- the PERSISTED regex matches the filename shape, this checks the location.
     Computed here, above the delta, so the delta can leave a persisted output to its 80-line cap as the read
     paths do rather than narrow it to the edit region. */
  let underConfig = false; try { underConfig = path.resolve(String(fp)).startsWith(path.resolve(CFG_DIR) + path.sep); } catch {}
  const persisted = PERSISTED.test(fp) && underConfig && st.size > cfg.maxChars;

  /* Read-After-Edit Delta (narrowing 1): the model edited this file this session and is now reading it whole
     -- almost always to verify the edit, which the harness's own guidance calls unnecessary. Narrow the read
     to the changed region plus context; the file is still on disk, so a wider read is one offset away. Off by
     default (readAfterEdit). Logged as its own ev:'read-delta' with the window it injected, so the Backfire
     Auditor can tell a delta from a size cap and measure whether it sent the model back for a wider read. The
     note states only what the guard knows -- that these lines were edited -- not that the model already holds
     the rest, which it cannot know (a blind edit, a format-on-save, or another tool may have changed the file).

     Applies only to the files the read-whole path below would take -- at or under readMaxBytes, not a
     persisted output, not on the alwaysCap denylist -- so the delta never overrides a cap the sibling read
     path honors. A larger (or capped) file is left to the size cap instead: the 2026-09-14 A/B (AB-TASK.md)
     showed narrowing a big file's verify-read to the edit region BACKFIRED (the model asked for the whole file
     anyway, 2 of 5 firings, both on files over readMaxBytes), while on the smaller file it helped. readMaxBytes
     is exactly the line the data drew -- the helped file sat under it, the backfired ones over -- so the delta
     reuses that threshold rather than a new knob, and stays on the small files where it fires cleanly.

     Uses the MOST RECENT edit record for this file, not the union of the whole session: the latest edit is the
     one this read most likely verifies, its lines are in the current numbering, and it bounds the spread.
     Three guards keep the injected window sound: the edit must fall within the file (editFrom <= nLines + 1 --
     else a truncation or an odd structuredPatch newStart would push offset past EOF and limit negative); the
     window must not exceed readLimitLines (else scattered edits could deliver more than the size cap would);
     and it must hide something (limit < nLines). `to` is left unclamped so a last-line edit on a file with no
     trailing newline (where nLines counts one short) still shows. */
  if (cfg.readAfterEdit && nLines != null && !persisted && st.size <= cfg.readMaxBytes && !matchesAny(cfg.alwaysCap, fp)) {
    const recs = editLookup(input.session_id, path.resolve(fp));
    const latest = recs.reduce((a, b) => (b && (b.t || 0) >= (a && a.t || 0) ? b : a), null);
    const ranges = (latest && Array.isArray(latest.ranges) ? latest.ranges : []).filter(r => Array.isArray(r) && r.length === 2);
    if (ranges.length) {
      const ctx = cfg.editContextLines;
      const editFrom = Math.min(...ranges.map(r => r[0])), editTo = Math.max(...ranges.map(r => r[1]));
      const from = Math.max(1, editFrom - ctx);
      const to = editTo + ctx;
      const limit = to - from + 1;
      if (editFrom <= nLines + 1 && limit <= cfg.readLimitLines && limit < nLines) {
        log({ ev: 'read-delta', session: input.session_id, tool: 'Read', what: fp, bytes: st.size, lines: nLines, offset: from, limit });
        emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, offset: from, limit },
          additionalContext: `${path.basename(fp)}: you edited this file this session, so tokenbrake narrowed this read to the region you edited (lines ${from}-${Math.min(to, nLines)} of ${nLines}) -- a read right after an edit is usually a verify. Read with an explicit offset/limit for the rest of the file.` } });
        return;
      }
    }
  }

  /* Read-After-Read elision (narrowing 2): the model already read this file WHOLE this session, it is
     unchanged (same size + mtime) and the read was recent (few whole-reads since), so it very likely still
     has the content -- hand back only the first reReadKeepLines plus a one-line note (no saved artifact; the
     file is still on disk to re-read) instead of re-adding the whole file. Off by default (reReadElide). Only files read whole get a priorRead record (a capped first read
     means the model does NOT have the whole file), and any change to the file -- an edit, or any external
     write -- changes size or mtime and fails the equality check below, so this reaches only genuine unchanged
     re-reads. The one thing the guard does not consult is compaction (it never sees the context window); that
     risk is mitigated by reReadRecency and, default-OFF, gated by the Backfire Auditor before the default moves. */
  if (cfg.reReadElide && nLines != null && cfg.reReadKeepLines > 0 && cfg.reReadKeepLines < nLines) {
    const prior = priorRead(input.session_id, path.resolve(fp));
    if (prior && prior.size === st.size && prior.mtime === st.mtimeMs && prior.since < cfg.reReadRecency) {
      log({ ev: 'read-reread', session: input.session_id, tool: 'Read', what: fp, bytes: st.size, lines: nLines, limit: cfg.reReadKeepLines });
      emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { ...ti, limit: cfg.reReadKeepLines },
        additionalContext: `${path.basename(fp)}: you already read this file whole earlier this session and it is unchanged, so tokenbrake is showing only the first ${cfg.reReadKeepLines} lines instead of re-adding all ${nLines}. Read with an explicit offset/limit if you need part of it again.` } });
      return;
    }
  }
  /* A whole-file read the cap did NOT act on is still worth recording, and until now nothing recorded it.
     Without it, `report --reads` had to infer every file's size from the delivered text -- which Claude Code
     line-numbers, so every file came out 5-6% large and the long ones worse -- and `report --where` could
     resolve a file's length for only one ranged read in forty-three, leaving the question of whether the cap
     should be a line count or a fraction of the file unanswerable. statSync has already run here, so the size
     is free; the line count costs one read of a file that is under the trigger by definition.
     This changes no decision the guard makes and alters no output: it writes a ledger row and returns, exactly
     as before. Its value is that the trigger's own evidence stops being an inference. */
  if (!persisted && st.size <= cfg.readMaxBytes && !matchesAny(cfg.alwaysCap, fp)) {
    if (cfg.logAllTools) log({ ev: 'read-whole', session: input.session_id, tool: 'Read', what: fp,
      bytes: st.size, lines: nLines });
    /* Remember this whole delivery so a later unchanged, recent re-read can be elided (narrowing 2). */
    if (cfg.reReadElide) readRecord(input.session_id, { file: path.resolve(fp), size: st.size, mtime: st.mtimeMs });
    return;
  }
  const limit = persisted ? cfg.persistedLimitLines : cfg.readLimitLines;
  const lineCount = nLines;

  log({ ev: 'read-cap', session: input.session_id, tool: 'Read', what: fp, bytes: st.size, lines: lineCount, limit, persisted });

  const sizeDesc = `${lineCount != null ? lineCount.toLocaleString() + ' lines / ' : ''}${Math.round(st.size / 1024)} KB`;
  const why = persisted
    ? `${path.basename(fp)} is a saved tool output, ${sizeDesc}: it was too big to show inline, so it is too big to read whole. tokenbrake capped this read at the first ${limit} lines.`
    : `${path.basename(fp)} is ${sizeDesc}. tokenbrake capped this read at the first ${limit} lines to save context.`;
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...ti, limit },
      additionalContext: `${why} Use offset/limit to read the section you need, or Grep to locate it first. A few large ranges cost less than many small ones: each call is a request that re-reads the whole context.`
    }
  });
}

(function main() {
  try {
    const cfg = loadConfig();
    if (!cfg.enabled) return;
    const input = readStdin();
    if (!input || typeof input !== 'object') return;
    if (MODE === 'read-pre') handleReadPre(input, cfg);
    else handlePost(input, cfg);
  } catch { /* fail open */ }
  process.exitCode = 0;
})();
