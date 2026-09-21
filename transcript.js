'use strict';
// tokenbrake transcript reader -- brake 4, "what's eating your tokens".
//
// A READER over two files that already exist, never a new collector:
//   1. the Claude Code session transcript (JSONL under <config>/projects/<cwd>/<session>.jsonl),
//      which holds every tool result exactly as the model saw it and the API's usage counters per request;
//   2. the tokenbrake ledger, which says which of those results the guard trimmed and by how much.
//
// The one idea that makes this a brake rather than a meter: a tool result is not paid for once. It is
// re-sent as context on EVERY later request until the session compacts, so its cost is its size times the
// requests it was carried through. A 30k-token dump at request 3 of 60 is carried 57 times. Ranking by that
// product, not by size, is what tells you which single result to have trimmed, capped or never run.
//
// Zero dependencies. Tolerant of lines it does not understand -- the transcript format is Claude Code's,
// not ours, and a line this file cannot read is skipped, never fatal.

const fs = require('fs');
const path = require('path');

const CHARS_PER_TOKEN = 4;   // the same estimate the extension and the HANDOFF use; an estimate, not a count

function readJsonl(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* a line we cannot read is not our line */ }
  }
  return out;
}

/* The text a tool_result put in front of the model. A string, or an array of blocks whose text
   blocks are what count; images count as nothing here (they are billed by pixel, not by character,
   and this estimate is about text that scrolls off into the context). */
function resultText(block) { return GUARD.resultText(block); }   // one definition, the guard's

/* What a tool call was about, for the report's one-line label: the command, the file, the pattern.
   Never the result -- the report names calls, it does not echo output. */
function describe(name, input) {
  const i = input || {};
  let s = String(i.command || i.file_path || i.pattern || i.url || i.query || i.description || i.prompt || '').replace(/\s+/g, ' ').trim();
  if (i.command) {
    /* A shell line's first sixty characters are often plumbing: VAR=... assignments, an export, a cd
       to the working directory. Strip them so the column shows the command that did the work. */
    s = s.replace(/^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=\S+\s*;?\s*)+/, '').replace(/^cd\s+\S+\s*(?:&&|;)\s*/, '');
  }
  return s;
}

/* The identity of a read, for the repeat-reads line: a Read of one path and range, or a shell command that
   only prints one file (cat, sed -n, head, tail). Two results with the same key in the same compaction
   window put the same text into context twice. Anything else has no key and is never called a repeat. */
/* The file a result came from, when the call names one: a Read's path, or the single path a plain
   cat/sed/head/tail read. Separate from readKey because a recovery read is the SAME file at a DIFFERENT
   offset, so it needs the path without the range that readKey deliberately includes. */
/* The guard's own definitions -- guard.js is a library when required and a hook only when run -- so the report
   classifies commands, persisted outputs and knobs with the SAME objects the guard decides with. These were
   copies once, kept in step by pinning tests, and one had already drifted (PERSISTED missed the .json outputs
   the guard recognises). */
const GUARD = require('./guard.js');
/* A read of one file: the guard's EXCERPT, whose group 1 is the file. */
const EXCERPT_CMD = GUARD.EXCERPT;
const unquote = (s) => String(s || '').replace(/^['"]|['"]$/g, '');

/* A whole-file read: the population the Read cap's TRIGGER acts on. An unbounded Read, or a bare `cat` of
   one file -- `head -n N`, `tail`, `sed -n` and `grep` are all bounded requests and are not it, even though
   readFileOf recognises them as reads of a named file. A Read carrying an offset or a limit is likewise not
   one, and that is also how the guard decides (guard.js:323 returns before it stats anything). */
const P_ = String.raw`(?:'[^']+'|"[^"]+"|[^|;&<>'"\s]+)`;
const LBL_ = String.raw`echo(?:\s+(?:'[^']*'|"[^"]*"|[^|;&<>'"\s]+))*`;
const WHOLE_RD_ = String.raw`cat(?:\s+-[bnAEsTv]+)*\s+(${P_})`;
const WHOLE_CMD = new RegExp(
  String.raw`^\s*(?:cd\s+${P_}\s*&&\s*)?(?:${LBL_}\s*(?:&&|;)\s*)?${WHOLE_RD_}` +
  String.raw`(?:\s*(?:&&|;)\s*${LBL_})*\s*$`);

/* The guard's own two early exits (PERSISTED is the guard's own pattern; WHOLE_CMD is the report's): a read it
   returns on is not a read the trigger acts on, so neither belongs in the population readMaxBytes is argued
   from. PERSISTED is the second knob -- a spilled output is capped by persistedLimitLines at anything over
   maxChars, whatever readMaxBytes says (guard.js:41, :329). */
const PERSISTED = GUARD.PERSISTED;
/* Claude Code's own refusal when a file exceeds its per-read token ceiling. Matched on wording, so a build
   that words it differently falls through to 'errored' rather than being counted as a big file. */
const TOO_LARGE = /exceeds maximum allowed (?:tokens|size)|too (?:large|long) to read|maximum allowed tokens/i;
const BINARY_READ = /\.(png|jpe?g|gif|webp|bmp|svg|pdf|ipynb)$/i;

function readsWholeFile(name, input) {
  const i = input || {};
  if (name === 'Read') return !!i.file_path && i.offset == null && i.limit == null && !BINARY_READ.test(i.file_path);
  if ((name === 'Bash' || name === 'PowerShell') && typeof i.command === 'string') return WHOLE_CMD.test(i.command);
  return false;
}

/* Claude Code refuses a Read at roughly 25k tokens and may truncate around there, so a delivered size close
   to it is not evidence of the file's size. 100,000 characters is that ceiling; 90% of it is where a
   delivered size stops being trustworthy as a measurement of the file. */
const HOST_READ_CEILING = 100000;
/* Claude Code also appears to have a default line limit of its own on an unbounded Read. It is not
   documented and this repo has no transcript that reaches it, so nothing here asserts it exists: an
   unbounded read that stops at exactly this many lines is FLAGGED, its line count treated as a floor, and
   the operator told why. If the limit is real the flag catches it; if it is not, the flag stays at zero. */
const HOST_READ_LINES = 2000;

/* What a delivered Read result says about the FILE, as opposed to about the read.

   Claude Code numbers every line it hands the model -- `12\tconst x = 1` -- and that numbering is Claude
   Code's, not the file's. Measured on this repo's own transcripts it runs 5-6% of the delivered text on a
   350-line file and grows with the line count, because the prefix grows with the number. `readMaxBytes` is
   compared against fs.statSync().size (guard.js:330), so comparing a delivered length against it overstates
   every file, and overstates the long ones most -- exactly at the boundary the trigger question turns on.
   Stripping the prefixes recovers the real size: on an unchanged guard.js, 20,728 bytes recovered against
   20,831 on disk.

   The numbering also gives the line count exactly, and better than counting newlines: the last prefix IS the
   file's last line number. Which is what makes truncation visible -- if an unbounded read's last line number
   is a round host limit rather than the end of the file, the count is a floor and the report must say so
   instead of taking it for a measurement. */
function fileShape(text) {
  const t = String(text || '');
  if (!t) return { numbered: false, from: null, to: null, bytes: 0, lines: 0 };
  const L = t.split('\n');
  const NUM = /^\s*(\d+)[\t→]/;
  const first = NUM.exec(L[0]);
  if (!first) return { numbered: false, from: null, to: null, bytes: Buffer.byteLength(t), lines: L.length };
  /* Consecutive from the first line, or it is data that happens to start with a number -- a TSV whose first
     column counts, say -- and stripping it would eat the file's own content. */
  let n = Number(first[1]), to = n, bytes = 0, ok = true;
  for (const line of L) {
    const m = NUM.exec(line);
    if (!m) { if (line !== '') bytes += Buffer.byteLength(line) + 1; continue; }
    if (Number(m[1]) !== n) { ok = false; break; }
    to = n; n++;
    bytes += Buffer.byteLength(line.slice(m[0].length)) + 1;
  }
  if (!ok) return { numbered: false, from: null, to: null, bytes: Buffer.byteLength(t), lines: L.length };
  return { numbered: true, from: Number(first[1]), to, bytes, lines: to - Number(first[1]) + 1 };
}

function readFileOf(name, input) {
  const i = input || {};
  if (i.file_path) return String(i.file_path);
  if ((name === 'Bash' || name === 'PowerShell') && typeof i.command === 'string') {
    const m = EXCERPT_CMD.exec(i.command);
    if (m) return unquote(m[1]);
  }
  return null;
}

/* The line a ranged read starts at: a Read's `offset`, or the first number of a `sed -n 'A,Bp'`. Only
   explicit position choices count -- `cat` and `head` ask for the top, which says nothing about where the
   model expected to find anything. This is the empirical answer to the only question that decides whether
   the Read cap can help a given person: when the model goes looking, how deep into the file does it go? */
function readStartLine(name, input) {
  const i = input || {};
  if (i.file_path && i.offset) return Number(i.offset) || null;
  if ((name === 'Bash' || name === 'PowerShell') && typeof i.command === 'string') {
    const m = /sed\s+-n\s+['"]?(\d+),(\d+)p/.exec(i.command);
    if (m) return Number(m[1]) || null;
  }
  return null;
}

/* Where this session's targeted reads actually landed, and what a cap keeping the first N lines would
   have withheld. An inference, and labelled as one in the report: these are reads the model ALREADY
   bounded, which the guard never caps. What they establish is where the model expects to find things --
   so if it had read unbounded and been capped at N, this is how often it would have had to come back. */
function readTargets(parsed, caps) {
  const starts = parsed.results.map((r) => r.readFrom).filter((n) => n != null).sort((a, b) => a - b);
  const q = (f) => starts.length ? starts[Math.min(starts.length - 1, Math.floor(starts.length * f))] : null;
  const past = {};
  for (const n of (caps || [300, 500, 800])) past[n] = starts.filter((x) => x > n).length;
  return { n: starts.length, starts, median: q(0.5), p90: q(0.9), max: starts.length ? starts[starts.length - 1] : null, past };
}

/* One spelling for a path, so a ledger row and a transcript read can be recognised as the same file.
   A shell excerpt names a relative path (`sed -n '320,345p' transcript.js`) while the ledger records what
   the guard stat'd, which is absolute -- so a relative path is resolved against the session's cwd. Case is
   folded only behind a Windows drive letter: on POSIX, Guard.js and guard.js are two files and merging them
   would invent a match. */
function normReadPath(p, cwd) {
  if (!p) return null;
  let out = String(p).replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (!/^([a-zA-Z]:\/|\/)/.test(out) && cwd) out = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '') + '/' + out;
  out = out.replace(/\/+$/, '');
  if (/^[a-zA-Z]:\//.test(out)) out = out.toLowerCase();
  return out || null;
}

/* The Read cap's firings as an index the join can use: which files were capped, and when each was FIRST
   capped. The ledger row (ev: 'read-cap') carries session, path, full size, line count and the limit applied,
   but no tool_use_id -- PreToolUse does not carry one -- so (session, path, time) is the only key there is.
   Two guard installs, user scope and project scope, log the same cap twice milliseconds apart; those rows are
   deduped on session|path|limit inside a second and counted, because for the per-file listing they would be a
   real double-count. */
function readCapIndex(ledgerRecs, sessionId) {
  const rows = [];
  let deduped = 0, noTime = 0;
  const seen = new Map();
  for (const r of ledgerRecs || []) {
    if (!r || r.ev !== 'read-cap') continue;
    if (sessionId && r.session && r.session !== sessionId) continue;
    const key = normReadPath(r.what);
    const t = Number(r.t) || null;
    if (t == null) noTime++;
    const dk = String(r.session || '') + '|' + key + '|' + r.limit;
    const prev = seen.get(dk);
    if (prev != null && t != null && Math.abs(t - prev) <= 1000) { deduped++; continue; }
    if (t != null) seen.set(dk, t);
    rows.push({ t, what: r.what, key, bytes: Number(r.bytes) || 0, lines: r.lines == null ? null : Number(r.lines),
      limit: Number(r.limit) || null, persisted: !!r.persisted, session: r.session || null });
  }
  rows.sort((a, b) => (a.t || 0) - (b.t || 0));
  const byFile = new Map();
  let source = 0, persisted = 0, bytes = 0;
  for (const r of rows) {
    bytes += r.bytes;
    if (r.persisted) persisted++; else source++;
    const e = byFile.get(r.key);
    if (!e) byFile.set(r.key, { first: r.t, last: r.t, n: 1, limit: r.limit, persisted: r.persisted, bytes: r.bytes, lines: r.lines, what: r.what });
    else {
      e.n++;
      if (r.t != null && (e.first == null || r.t < e.first)) e.first = r.t;
      if (r.t != null && (e.last == null || r.t > e.last)) e.last = r.t;
    }
  }
  const limits = [...new Set(rows.map((r) => r.limit).filter((n) => n != null))].sort((a, b) => a - b);
  return { rows, byFile, source, persisted, n: rows.length, bytes, limits, deduped, noTime };
}

/* A read that ran off the end of its file tells you exactly how long that file was.

   `sed -n '375,480p'` asked for 106 lines and got 105: the file ended at line 479. A `Read` with offset and
   limit does the same. This is exact, contemporaneous, and it was in every transcript already -- which
   matters, because the shape question (should the cap be a line count or a fraction of the file?) needs file
   lengths and had one exact length in forty-three, the rest read off disk today. On this repo's own
   transcripts 40 of 163 sed ranges ran off the end.

   Two ways this would lie, both excluded. A read the guard TRIMMED comes back short because the guard cut it,
   not because the file ended -- so any result carrying the marker is refused outright. And a range starting
   past the end returns nothing, which says only that the file is shorter than the start, not how much.

   The convention: this counts delivered lines, so a file with no trailing newline reads one longer than the
   ledger's newline count for the same file. At the sizes the cap argues over that is noise, but the two
   numbers are not the same number. */
function eofLength(name, input, text, marker) {
  if (marker) return null;                       // short because the guard cut it, not because the file ended
  const i = input || {};
  let from = null, want = null;
  if (name === 'Read' && i.file_path && i.offset && i.limit) { from = Number(i.offset); want = Number(i.limit); }
  else if ((name === 'Bash' || name === 'PowerShell') && typeof i.command === 'string') {
    const m = /sed\s+-n\s+['"]?(\d+),(\d+)p/.exec(i.command);
    if (m) { from = Number(m[1]); want = Number(m[2]) - Number(m[1]) + 1; }
  }
  if (!from || !want || want < 1) return null;
  const t = String(text || '');
  if (t === '') return null;                     // the range began past the end: a bound, not a length
  const got = t.replace(/\n$/, '').split('\n').length;
  if (got >= want) return null;                  // the range filled up: only a lower bound on the length
  return from + got - 1;
}

/* Whole-file reads the cap did NOT act on, from the ledger rather than the transcript. The guard records one
   per unbounded Read under the trigger with the size from statSync and a newline count -- so a file's real
   size and length are available for every file read whole in a session, not only for the ones capped. Before
   this the only exact sizes came from cap rows, which on real work meant almost none: sizes had to be inferred
   from the delivered text and file lengths read off disk today, which is why the question of whether the cap
   should be a line count or a fraction of the file could not be answered. */
function wholeReadIndex(ledgerRecs, sessionId) {
  const byFile = new Map();
  for (const r of ledgerRecs || []) {
    if (!r || r.ev !== 'read-whole') continue;
    if (sessionId && r.session && r.session !== sessionId) continue;
    const key = normReadPath(r.what);
    if (!key) continue;
    const e = byFile.get(key);
    const bytes = Number(r.bytes) || 0;
    /* The largest sighting wins: a file that grew during the session was that long by the end, and a length
       shorter than a read's own start line is the one that would be thrown away as unresolvable. */
    if (!e || bytes > e.bytes) byFile.set(key, { bytes, lines: r.lines == null ? null : Number(r.lines), what: r.what, n: (e ? e.n : 0) + 1 });
    else e.n++;
  }
  return { byFile, n: byFile.size };
}

/* Split this session's ranged reads into the ones the cap provoked and the ones it did not.

   Why this exists. A capped Read delivers lines 1..limit and its additionalContext tells the model, in
   words, to come back with an offset. The model does, and that follow-up is a ranged read starting just
   past the cap -- which then shows up in the distribution meant to decide what the cap should be. The
   number measures the cap. Pooled over seventeen real sessions it read 57% of targets past line 300, with
   a median of 351, sitting just past the 300 the guard had been applying all along.

   The rule: a ranged read of a file the cap fired on in this session, emitted after it fired, is induced.
   A ranged read of that file from BEFORE the cap is kept -- it is real evidence. A read with no timestamp
   to order is put in neither bucket and counted, because guessing which came first is the thing to avoid.
   The capped read itself can never land here: handleReadPre returns on any offset, so a read that got
   capped had none, and readStartLine needs one.

   Two limits, both reported by the caller. Attribution is by file identity, so one cap on a file marks
   every later ranged read of it -- conservative, and it inflates `induced` rather than the clean subset.
   And a cap on one file that teaches the model to read a different file with an offset is invisible here,
   so `spontaneous` is a LOWER bound on the guard's influence. Only a hooks-off arm settles that. */
function classifyRangedReads(parsed, ledgerRecs, opts) {
  const o = opts || {};
  const idx = readCapIndex(ledgerRecs, o.sessionId || parsed.sessionId || null);
  const all = parsed.results.filter((r) => r.readFrom != null);
  const spontaneous = [], induced = [], unordered = [];
  const byFile = new Map();
  let basename = 0;
  const base = (k) => String(k || '').split('/').pop();
  const byBase = new Map();
  for (const [k, e] of idx.byFile) { const b = base(k); if (!byBase.has(b)) byBase.set(b, e); }
  for (const r of all) {
    const key = normReadPath(r.file, parsed.cwd);
    let cap = key ? idx.byFile.get(key) : null;
    let why = 'after-cap';
    if (!cap && key) { const b = byBase.get(base(key)); if (b) { cap = b; why = 'after-cap-basename'; } }
    if (!cap) { spontaneous.push(r); continue; }
    const askedAt = r.askedAt != null ? r.askedAt : r.at;
    if (askedAt == null || cap.first == null) { unordered.push({ read: r, cap, why: 'no-time' }); continue; }
    if (askedAt < cap.first) { spontaneous.push(r); continue; }
    induced.push({ read: r, cap, why });
    if (why === 'after-cap-basename') basename++;
    byFile.set(cap.what, (byFile.get(cap.what) || 0) + 1);
  }
  return { all, spontaneous, induced, unordered, capped: idx.n, attempted: idx.n > 0, basename,
    byFile: [...byFile.entries()].sort((a, b) => b[1] - a[1]) };
}

/* Does the start-line distribution step at the cap? The ledger-free half of the same question, and the
   one that still works on a machine whose ledger predates the Read cap. Any smooth density of start lines
   is non-increasing across an arbitrary line number, so `below >= at` is the null and a band just past the
   cap holding several times what the band just below it holds can only come from a step. `exact` -- starts
   at the cap itself or one past it -- is the sharpest fingerprint: a model told it received the first 300
   lines comes back at literally 300 or 301. A thin sample reports itself as thin rather than as no spike. */
function capBandSpike(starts, cap, opts) {
  const width = (opts && opts.width) || Math.max(5, Math.round(cap * 0.1));
  const at = starts.filter((x) => x >= cap && x <= cap + width).length;
  const below = starts.filter((x) => x >= cap - width && x < cap).length;
  const exact = starts.filter((x) => x === cap || x === cap + 1).length;
  const ratio = at / Math.max(1, below);
  /* The two bands are the same width, so under the null they split the reads that fall in either of them
     evenly and `at` is Binomial(n, 0.5). One-sided exact tail, no distribution assumed and no threshold
     tuned to this data -- the same family as the sign test the benchmark's round 2 is pre-registered on.
     Conservative on purpose: a smooth density is non-increasing across the cap, so an even split OVERstates
     how much of `at` is ordinary, which makes a significant result harder to get rather than easier. */
  const n = at + below;
  let p = null;
  if (n) {
    let c = 1, sum = 0;                       // C(n,n) = 1, walking down from k = n
    for (let k = n; k >= at; k--) { sum += c; c = c * k / (n - k + 1); }
    p = sum / Math.pow(2, n);
  }
  const verdict = n < 8 ? 'too few' : (p <= 0.05 ? 'spike' : 'none');
  return { cap, width, at, below, exact, ratio, p, verdict };
}

/* The shape of the whole distribution, so the reader can see what the percentages summarise. Edges reach
   1200 because the cap's trigger is 60,000 bytes: every file it touches runs roughly 1,500 lines or more,
   so a scale stopping at 800 stops before the point where a cap keeps everything. */
function startHistogram(starts, edges) {
  const e = edges || [1, 50, 100, 200, 300, 500, 800, 1200, Infinity];
  const bins = [];
  for (let i = 0; i < e.length - 1; i++) {
    const from = e[i], to = e[i + 1];
    bins.push({ from, to, n: starts.filter((x) => x >= from && x < to).length, bar: '' });
  }
  const first = bins[0];
  if (first) first.n += starts.filter((x) => x < e[0]).length;   // offset below the first edge still belongs somewhere
  const top = bins.reduce((m, b) => Math.max(m, b.n), 0);
  for (const b of bins) b.bar = '#'.repeat(top ? Math.max(b.n ? 1 : 0, Math.round(30 * b.n / top)) : 0);
  return bins;
}

function readKey(name, input) {
  const i = input || {};
  if (name === 'Read' && i.file_path) return `Read ${i.file_path} ${i.offset || 0} ${i.limit || 0}`;
  if (name === 'Bash' && typeof i.command === 'string' && EXCERPT_CMD.test(i.command)) {
    return `Bash ${i.command.trim().replace(/\s+/g, ' ')}`;
  }
  return null;
}

/* Parse one transcript into: the ordered list of API requests (deduped by requestId, usage taken from the
   first entry that carries it), the tool results in order with the request index they landed after, and the
   compaction boundaries. Only the main chain: sidechain entries (subagents) run in their own context and
   would be counted against the wrong window. */
/* One malformed structuredPatch in a transcript (a hunk whose newStart cannot even be converted to a number)
   must not throw the whole session away as unreadable: that edit just has no ranges, and counts as not replayable. */
const safeRanges = (resp) => { try { return GUARD.patchRanges(resp); } catch { return []; } };
function parseTranscript(file) {
  const entries = readJsonl(file);
  const requests = [];               // { id, usage, at }  in order of first appearance
  const reqIndex = new Map();        // requestId -> index in requests
  const toolUses = new Map();        // tool_use_id -> { name, input, req, at }
  const results = [];                // { id, name, what, chars, tokens, afterReq, askedAt, at, isError }
  const compactions = [];            // request indices at which context was reset
  const boundaries = [];             // { atReq, trigger, preTokens, at } from each compact_boundary: what compacted it, from what size
  let cwd = null, sessionId = null, version = null;
  let userTurns = 0;                 // user entries with a message: the input formatWarning weighs requests against

  for (const e of entries) {
    if (!e || typeof e !== 'object' || e.isSidechain) continue;
    if (e.type === 'user' && e.message) userTurns++;
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!sessionId && e.sessionId) sessionId = e.sessionId;
    if (!version && e.version) version = e.version;

    if (e.type === 'system' && e.subtype === 'compact_boundary') {
      const m = e.compactMetadata || {};
      boundaries.push({ atReq: requests.length, trigger: m.trigger || null,
        preTokens: Number.isFinite(Number(m.preTokens)) ? Number(m.preTokens) : null, at: Date.parse(e.timestamp) || null });
      continue;
    }

    if (e.type === 'assistant' && e.message) {
      const rid = e.requestId || e.uuid;
      if (!reqIndex.has(rid)) {
        reqIndex.set(rid, requests.length);
        requests.push({ id: rid, usage: e.message.usage || null, at: e.timestamp || null, model: e.message.model || null });
      } else if (!requests[reqIndex.get(rid)].usage && e.message.usage) {
        requests[reqIndex.get(rid)].usage = e.message.usage;
      }
      const req = reqIndex.get(rid);
      for (const b of (Array.isArray(e.message.content) ? e.message.content : [])) {
        if (b && b.type === 'tool_use' && b.id) toolUses.set(b.id, { name: b.name || '?', input: b.input, req, at: Date.parse(e.timestamp) || null });
      }
      continue;
    }

    if (e.type === 'user' && e.message) {
      /* A compaction lands as a user message carrying the summary. Everything before it left the
         context, so every result already in the file stops being carried at this request -- and a result
         that arrives AFTER it is bounded by the next compaction, not this one. The first fixture got that
         wrong by keying on request index alone, which capped a post-compaction result at zero. */
      if (e.isCompactSummary) compact(requests.length);
      const content = Array.isArray(e.message.content) ? e.message.content : [];
      for (const b of content) {
        if (!b || b.type !== 'tool_result') continue;
        const text = resultText(b);
        const use = toolUses.get(b.tool_use_id) || { name: '?', input: null, req: requests.length - 1, at: null };
        results.push({
          id: b.tool_use_id || null,
          name: use.name,
          what: describe(use.name, use.input),
          key: readKey(use.name, use.input),
          file: readFileOf(use.name, use.input),
          /* For the offline shadow (see offlineShadow): a hash of what a shell or MCP result delivered, and the line
             ranges an Edit changed, read from Claude Code's own structuredPatch with the guard's own patchRanges --
             the exact ranges the live readAfterEdit would have recorded. */
          hash: (use.name === 'Bash' || use.name === 'PowerShell' || /^mcp__/.test(use.name)) && text ? GUARD.hashOf(text) : null,
          /* The raw command, for matching noTrim exactly as the guard does (`what` is cleaned up for display). */
          cmd: (use.name === 'Bash' || use.name === 'PowerShell') && use.input && typeof use.input.command === 'string' ? use.input.command : undefined,
          /* Where a Grep or Glob looked: Grep's path and glob, Glob's path and pattern. With `cmd` for the shell, it
             lets a compaction's recovery tell a lookup of a file already read (compactionView) from new work. */
          lookIn: use.input && (use.name === 'Grep' || use.name === 'Glob')
            ? [use.input.path, use.name === 'Grep' ? use.input.glob : use.input.pattern].filter(x => typeof x === 'string').join(' ') || undefined
            : undefined,
          patch: (use.name === 'Edit' || use.name === 'MultiEdit') ? safeRanges(e.toolUseResult) : undefined,
          /* The guard's own test for "this command is a read of one file" (guard.js EXCERPT), kept as its own fact
             rather than inferred from `file`, which means "which file this reads" and may grow other shapes. */
          excerpt: (use.name === 'Bash' || use.name === 'PowerShell') && !!use.input && typeof use.input.command === 'string'
            && EXCERPT_CMD.test(use.input.command),
          readFrom: readStartLine(use.name, use.input),
          marker: /\[tokenbrake\]/.test(text),   // the guard's replacement is what the model saw
          chars: text.length,
          /* The Read cap is a LINE count on a BYTE trigger, so neither can be reasoned about from the other.
             `shape` is what the delivered text says about the file itself, with Claude Code's line numbering
             subtracted; it is computed only for reads, not for every result in a large transcript. */
          lines: text ? text.split('\n').length : 0,
          whole: readsWholeFile(use.name, use.input),
          shape: readFileOf(use.name, use.input) ? fileShape(text) : null,
          /* Only for a failed read, and only the head of it: the reason a read failed decides whether it is
             evidence of a large file or of nothing at all, and that cannot be recovered later. */
          text: b.is_error ? text.slice(0, 400) : undefined,
          /* Exact file length when this read ran off the end of the file; null otherwise. */
          eofAt: eofLength(use.name, use.input, text, /\[tokenbrake\]/.test(text)),
          tokens: Math.round(text.length / CHARS_PER_TOKEN),
          afterReq: requests.length - 1,     // it entered context after this request, before the next
          /* Two clocks, both Claude Code's own and both on this host: askedAt is when the model emitted the
             call -- the moment it chose an offset -- and at is when the result landed. askedAt is the one a
             cap can be compared against, because a follow-up read the model wrote after reading the cap's
             advice was necessarily emitted after the cap fired. Null on an older transcript. */
          askedAt: use.at != null ? use.at : null,
          at: Date.parse(e.timestamp) || null,
          isError: !!b.is_error
        });
      }
      continue;
    }

    if (e.type === 'summary') compact(requests.length);   // older shape: a summary line
  }

  function compact(atReq) {
    compactions.push(atReq);
    for (const r of results) if (r.compactedAt == null) r.compactedAt = atReq;
  }

  return { file, cwd, sessionId, version, userTurns, requests, results, compactions, boundaries };
}

/* The transcript is Claude Code's internal format, not a versioned API. When it changes, the parser above
   does not throw: it just recognizes nothing, and the report would print an empty or zeroed session as if
   that were the finding. This names the three shapes of "recognized nothing" that a real session cannot
   produce, so the report can say the format moved instead. Null when the transcript reads normally. The
   thresholds leave room for an aborted session (a prompt or two and no reply). */
function formatWarning(p) {
  let why = null;
  if (!p.requests.length && (p.userTurns >= 3 || p.results.length)) why = `none of its ${p.userTurns} user entries got a model request back`;
  else if (p.requests.length >= 3 && !p.requests.some(r => r.usage)) why = `none of its ${p.requests.length} requests carries token usage`;
  else if (p.results.length >= 3 && p.results.every(r => r.name === '?')) why = `none of its ${p.results.length} tool results matches a tool call`;
  if (!why) return null;
  return `This transcript does not read as expected: ${why}. Claude Code's transcript format may have changed `
    + `(this one was written by ${p.version ? 'Claude Code ' + p.version : 'an unrecorded Claude Code version'}), `
    + 'so the figures below may be empty or wrong. Please report it: https://github.com/33kain/tokenbrake/issues';
}

/* What each kind of token weighs against the five-hour limit, in points of the window per million tokens, as
   calibrated on Opus 5 (AB-TASK.md, "Calibration results", 2026-09-18). Other models are not calibrated. */
const LIMIT_WEIGHTS = { model: 'claude-opus-5', read: 0.20, write: 8.9, output: 34 };
const DEFAULT_COMPACT_WINDOW = 967000;   // where Opus 5 on the 1M context compacts on its own (Claude Code model-config docs)
const COMPACT_CHARGE = [0.5, 1.6];       // compaction's own draw is in no transcript: the calibration's estimate and its bound
const calibrated = (model, weights = LIMIT_WEIGHTS) => String(model || '').startsWith(weights.model);
/* A result's price: written once, then re-read on each request that carries it. */
const resultPts = (tokens, carriedTurns, weights = LIMIT_WEIGHTS) => tokens * (weights.write + (carriedTurns || 0) * weights.read) / 1e6;

function usageCtx(u) {
  return u ? (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0) : 0;
}

/* Every compaction in a session, priced (AB-TASK.md, "An earlier compaction window", stage 2). For each one:
   - the saving: the context dropped from `pre` to the next request's size, so every later request re-reads that
     much less, and a cold rebuild (a write of 20k+ after over an hour idle) rewrites that much less. It accrues
     until the next compaction, and stops where the uncompacted context would have passed Claude Code's own
     default window, because there the session would have compacted anyway.
   - the recovery: in the `recoveryWindow` requests after the compaction, every result that went back to a file
     already read before it -- a Read of it, or a shell/Grep/Glob lookup whose command or path names it (the stage 1
     pilot recovered three lost details with one grep, which a Read-only count scored as zero). Each is priced as a
     fresh write plus its re-reads until the next compaction. A lookup that also does new work in the same command
     is counted whole, so recovery errs high, which is the safe side for a gate.
   Compaction's own draw is not in the transcript and is added by the caller at COMPACT_CHARGE. Pure.
   Recovery here differs from recoveryReads on purpose: that one looks within a compaction window, and this one
   looks across the boundary, which is the only place a compaction's own recovery can show. */
/* Which already-read file a result went back to by looking it up, or null. A Grep or Glob is always a lookup; a
   shell command counts only in a segment (split at ; && || |) whose program reads or searches text -- running
   `node test.mjs` or `git diff app.js` names a file without looking anything up. The name must stand as its own
   path component (`app.js` does not match `myapp.js`), and case is ignored because normReadPath lowercases
   drive-letter paths while the command keeps its own case. */
const LOOKUP_PROGRAM = /^(grep|egrep|fgrep|rg|ag|ack|sed|awk|cat|head|tail|less|more|wc|od|xxd|nl|cut|sort|uniq|diff|type|findstr|select-string|sls|get-content|gc)$/;
function lookupOf(r, byName) {
  if (!byName.size) return null;
  const segs = r.lookIn ? [r.lookIn] : r.cmd ? String(r.cmd).split(/&&|\|\||;|\|/).filter(s => {
    const prog = (s.trim().split(/\s+/)[0] || '').split(/[\\/]/).pop().replace(/\.exe$/i, '').toLowerCase();
    return LOOKUP_PROGRAM.test(prog);
  }) : [];
  for (const seg of segs) {
    const hay = seg.toLowerCase();
    for (const [name, key] of byName) {
      if (!name) continue;
      for (let at = hay.indexOf(name); at >= 0; at = hay.indexOf(name, at + 1)) {
        const pre = at ? hay[at - 1] : ' ', post = hay[at + name.length] || ' ';
        if (/[\s\/\\'"=:*]/.test(pre) && /[\s'"),;:*]/.test(post)) return key;
      }
    }
  }
  return null;
}

function compactionView(parsed, { weights = LIMIT_WEIGHTS, defaultWindow = DEFAULT_COMPACT_WINDOW, recoveryWindow = 30 } = {}) {
  carry(parsed);
  const reqs = parsed.requests;
  const times = reqs.map(q => Date.parse(q.at) || 0);
  // Each result's file, normalized once (a Read's absolute path and a grep's relative one are the same file), and
  // the files read so far, grown across the boundaries in order rather than rebuilt at each one.
  const keys = parsed.results.map(r => r.file ? normReadPath(r.file, parsed.cwd) : null);
  const before = new Set(), byName = new Map();   // normalized path; lowercased basename -> that path
  let seen = 0;
  const rows = [];
  parsed.boundaries.forEach((b, bi) => {
    const k = b.atReq;
    if (k >= reqs.length) return;   // no request after it yet
    const end = bi + 1 < parsed.boundaries.length ? parsed.boundaries[bi + 1].atReq : reqs.length;
    const post = usageCtx(reqs[k].usage);
    const pre = b.preTokens != null ? b.preTokens : (k ? usageCtx(reqs[k - 1].usage) : 0);
    const drop = Math.max(0, pre - post);
    let colds = 0, requestsCounted = 0;
    for (let i = k; i < end; i++) {
      const u = reqs[i].usage;
      if (usageCtx(u) + drop > defaultWindow) break;
      requestsCounted++;
      if (i && times[i] - times[i - 1] > 60 * 60 * 1000 && u && (u.cache_creation_input_tokens || 0) >= 20000) colds++;
    }
    for (; seen < parsed.results.length && parsed.results[seen].afterReq < k; seen++) {
      if (keys[seen]) {
        before.add(keys[seen]);
        const name = path.basename(keys[seen]).toLowerCase();
        if (name) byName.set(name, keys[seen]);   // a drive root ("C:") has no basename, and an empty name would match everywhere forever
      }
    }
    const files = new Set();
    let pts = 0;
    const stop = Math.min(end, k + recoveryWindow);
    for (let i = seen; i < parsed.results.length && parsed.results[i].afterReq < stop; i++) {
      const r = parsed.results[i];
      if (r.isError) continue;
      const hit = keys[i] && before.has(keys[i]) ? keys[i] : lookupOf(r, byName);
      if (!hit) continue;
      files.add(hit);
      pts += resultPts(r.tokens, r.carriedTurns, weights);
    }
    rows.push({
      at: b.at, trigger: b.trigger, model: reqs[k].model || null, pre, post, drop, later: end - k, requestsCounted,
      saving: drop * (requestsCounted * weights.read + colds * weights.write) / 1e6,
      recovery: { files: [...files], pts }
    });
  });
  return rows;
}

/* Stage 2's rules (AB-TASK.md, "An earlier compaction window"), in one pure place: which compactions count, and
   the verdict once enough have. A compaction counts when it was automatic, on the calibrated model, and outside
   benchmark and calibration sessions. The stage passes when recovery plus compaction's own charge, at the bound,
   stays under half the saving across STAGE2.n counted compactions. */
const STAGE2 = { n: 8, share: 0.5 };
/* Staged work: a benchmark fixture or a calibration arm, driven by a script over a prepared repo. Stage 2
   pre-registered this rule (AB-TASK.md, "sessions under tokenbrake-bench or a calibration directory don't
   count"); the saving listing separates the same set, and since the 2026-09-20 amendment --where, --reads,
   --reach and tune skip it. The KIND is the primitive and the predicate derives from it, so the label a
   listing prints and the population a view drops can never come from two regexes that merely agree. */
const STAGED = [['bench', /tokenbrake-bench/i], ['calib', /calibration/i]];
const stagedKind = (cwd) => (STAGED.find(([, re]) => re.test(cwd || '')) || [''])[0];
const stagedCwd = (cwd) => !!stagedKind(cwd);
function compactionWhy(row, cwd, weights = LIMIT_WEIGHTS) {
  if (stagedCwd(cwd)) return 'benchmark/calibration';
  if (row.trigger !== 'auto') return (row.trigger || '?') + ' trigger';
  if (!calibrated(row.model, weights)) return 'model ' + (row.model || '?');
  return '';
}
function compactionVerdict(counted, [chargeLow, chargeHigh] = COMPACT_CHARGE) {
  const saving = counted.reduce((s, r) => s + r.saving, 0);
  const recovery = counted.reduce((s, r) => s + r.recovery.pts, 0);
  const costLow = recovery + chargeLow * counted.length, costHigh = recovery + chargeHigh * counted.length;
  const verdict = counted.length < STAGE2.n ? null
    : saving > 0 && costHigh < saving * STAGE2.share ? 'PASS'
    : saving > 0 && costLow < saving * STAGE2.share ? 'NOT YET' : 'FAIL';
  return { n: counted.length, saving, recovery, costLow, costHigh, verdict };
}

/* The carried cost of each result: size x the number of later requests that re-read it, stopping at
   the first compaction after it. Requests after the last result are what "later" means, so the newest
   result on the file has been carried zero times yet -- the report says so rather than inventing a
   future. */
function carry(parsed) {
  const n = parsed.requests.length;
  for (const r of parsed.results) {
    const until = r.compactedAt != null ? r.compactedAt : n;
    r.carriedTurns = Math.max(0, until - r.afterReq - 1);
    r.carried = r.tokens * r.carriedTurns;
  }
  return parsed;
}

/* Repeat reads: a result whose key already appeared in the same compaction window. The earlier text is
   still in context when the repeat lands, so the repeat is pure duplication until a compaction removes
   the first copy; a re-read after a compaction is not a repeat, the original is gone. This is measured,
   not acted on: the guard does nothing about repeats until the real-session files say they are common. */
function repeatReads(parsed) {
  const windowOf = (r) => parsed.compactions.filter(c => c <= r.afterReq).length;
  const seen = new Map();
  const out = { sameShape: 0, repeats: 0, tokens: 0, carried: 0, rows: [] };
  for (const r of parsed.results) {
    if (!r.key) continue;
    out.sameShape++;
    const k = windowOf(r) + '|' + r.key;
    if (seen.has(k)) {
      out.repeats++; out.tokens += r.tokens; out.carried += r.carried || 0;
      out.rows.push({ what: r.what, tokens: r.tokens, first: seen.get(k), again: r.afterReq });
    } else seen.set(k, r.afterReq);
  }
  return out;
}


const TRIM_CHARS = GUARD.DEFAULTS.maxChars;   // the guard's own default maxChars
/* The share of a session's carried tokens inside the trim's window at which a report tells someone without the
   guard that installing it is worth it. Below it the honest line is "too little here". A chosen floor, not a
   measured one: on the machine this was written on, with excerpts correctly out of the window, the pooled window
   was 11.6% of carried over 55 sessions (7.5% over the 24 the guard ran in) -- so 10% sits at about a typical
   session, and a session under it has less than usual for the brake to do. */
const BRAKE_WORTH_PCT = 10;
/* Shell results the guard leaves alone: Bash and PowerShell results at or under maxChars (TRIM_CHARS, the
   guard's default, when not given). Counted with their carried cost so the untouched share of a session is a
   number, not a guess. */
function smallResults(parsed, maxChars) {
  const limit = limitOf(maxChars);
  const out = { shell: 0, n: 0, tokens: 0, carried: 0 };
  for (const r of parsed.results) {
    if (r.name !== 'Bash' && r.name !== 'PowerShell') continue;
    out.shell++;
    if (r.chars > (typeof limit === 'function' ? limit(r) : limit)) continue;
    out.n++; out.tokens += r.tokens; out.carried += r.carried || 0;
  }
  return out;
}

/* What the guard could ever have acted on, which is the denominator every other line here needs.

   The trim reaches a tool result only if all three hold: it is a shell result, it exited zero, and it is
   over TRIM_CHARS but under Claude Code's own inline ceiling. Outside that window the guard is a spectator:
   a Read or an MCP result is not its business; a failing command fires PostToolUseFailure, where Claude
   Code ignores the replacement; a result past the ceiling is persisted by the host and the model is handed
   a preview, so the replacement is never applied; and a result under the threshold is left alone by design.

   Reporting only what was trimmed, against a session total that includes all four, flatters the tool. On
   one ledger, 285 tool results and the trim applied to none of them -- a fact no line in this report said.
   These buckets are what make "it saved nothing here" and "it could never have saved anything here"
   different sentences, and the second is usually the true one.

   HOST_CEILING is approximate and the class is confirmed rather than guessed where possible: a result the
   host persisted names its tool-results path, which is a fact in the transcript, not an estimate. */
const HOST_CEILING = 30000;
/* A single-file excerpt (`cat`, `sed -n`, `head`, `tail`, a simple `grep` -- `r.excerpt`, set at parse time
   from EXCERPT_CMD) is read like a Read: untouched up to readMaxBytes and capped above it, never
   trimmed to head and tail. It is the Read cap's business, not the trim's, so it is never in the trim's window
   -- counting it there told a first-run report the guard "would have trimmed" a sed -n of a source file. */
const isShell = (r) => r.name === 'Bash' || r.name === 'PowerShell';
/* maxChars resolved once at each entry point so the helpers below take it as given: a number, or -- when the
   config sets it per tool under `tools`, which the guard's toolConfig merges over the top level -- a function of
   the result giving that tool's value. An already-resolved function passes through. */
const limitOf = (maxChars, byTool) => {
  if (typeof maxChars === 'function') return maxChars;
  const base = maxChars == null || maxChars === '' ? TRIM_CHARS : Number(maxChars);
  const per = byTool && typeof byTool === 'object' ? Object.entries(byTool).filter(([, v]) => Number.isFinite(Number(v)) && v !== null && v !== '') : [];
  if (!per.length) return base;
  const m = new Map(per.map(([k, v]) => [k, Number(v)]));
  return (r) => (m.has(r.name) ? m.get(r.name) : base);
};
/* Which side of the trim's window a result falls on, by its delivered size -- the one test, so the buckets
   and every "could the trim act on this" question agree by construction. Order matters and is the guard's:
   not its business, then a failure, then past the host's ceiling, then a read, then too small. */
function trimClass(r, maxChars) {
  if (!isShell(r)) return 'nonShell';
  if (r.isError) return 'failed';
  if (r.chars >= HOST_CEILING) return 'persisted';
  if (r.excerpt) return 'excerpt';
  if (r.chars <= (typeof maxChars === 'function' ? maxChars(r) : maxChars)) return 'under';
  return 'window';
}
const inTrimWindow = (r, maxChars) => trimClass(r, limitOf(maxChars)) === 'window';
const REACH_BUCKETS = ['window', 'acted', 'untouched', 'under', 'failed', 'persisted', 'excerpt', 'nonShell', 'shell', 'total'];
const emptyReach = () => Object.fromEntries(REACH_BUCKETS.map((k) => [k, { n: 0, tokens: 0, carried: 0 }]));
const addTo = (b, r) => { b.n++; b.tokens += r.tokens; b.carried += r.carried || 0; };
function reach(parsed, wasTrimmed, opts) {
  const maxChars = limitOf(opts && opts.maxChars, opts && opts.toolMaxChars);
  const out = emptyReach();
  const trimmed = new Set(wasTrimmed || []);
  for (const r of parsed.results) {
    addTo(out.total, r);
    if (isShell(r)) addTo(out.shell, r);
    /* A result the guard rewrote is in the window by proof, whatever its delivered size says. Sizes here
       are what the model received, so a trimmed result now measures under the threshold -- classifying by
       size alone would put every success in the "untouched" bucket and leave the window empty. */
    if (trimmed.has(r) && !r.excerpt) { addTo(out.window, r); addTo(out.acted, r); continue; }
    const c = trimClass(r, maxChars);
    addTo(out[c], r);
    if (c === 'window') addTo(out.untouched, r);
  }
  return out;
}

/* The program a shell command actually invoked, which is the unit the tooling question turns on.
   `node tools/ci.js log r-8814` and `node tools/ci.js summary r-8813` are the same TOOL making different
   demands; `git log --stat -40` and `npm test` are different tools. Grouping raw command strings would give
   one row per invocation and answer nothing. */
function commandTool(cmd) {
  let c = String(cmd || '').trim().replace(/^cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|]+)\s*&&\s*/, '');
  c = c.split(/[|;]/)[0].trim();                        // the first stage of a pipeline is what produced it
  const parts = c.split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  let i = 0;
  while (i < parts.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(parts[i])) i++;   // FOO=bar prefixes
  let prog = parts[i] || null;
  if (!prog) return null;
  /* An interpreter tells you nothing; the script it runs does. */
  if (/^(node|npx|python3?|sh|bash|pwsh|powershell)$/.test(prog)) {
    const next = parts.slice(i + 1).find((x) => x && !x.startsWith('-'));
    if (next) prog = prog + ' ' + next;
  }
  return prog.replace(/\\/g, '/');
}

/* Where the trim can act at all, pooled, and WHICH tools put it there.

   Round 2's pilot abandoned because the guard rewrote nothing the model saw: handed a CLI that could slice a
   log, the agent sliced. Round 1's workload had no slicing tools and the mechanism was present. So the
   question this answers is whether the trim's reach is a property of the work or of the tools -- and a
   person's own sessions are a better sample of "an agent with decent tools" than any fixture.

   The share that matters is of CARRIED tokens, not of results: ab10 established that a result's cost is its
   size times the later requests that re-read it, so a count of results says nothing about the tokens. */
/* The results the guard actually rewrote AND the model saw, which is what `reach` needs to classify a
   trimmed result as in-window by proof rather than by its post-trim size. Extracted from renderReport so a
   pooled view can use the same rule rather than a second, quietly different one. */
/* The ledger row the guard wrote for a result, by id, else by tool and command -- the one join every "what did
   the guard do to this result" question goes through. */
function offeredOf(parsed, ledgerRecs) {
  const idx = ledgerIndex(ledgerRecs || [], parsed.sessionId);
  return (r) => idx.byId.get(r.id) || idx.byWhat.get(r.name + '|' + String(r.what || '').slice(0, 120));
}
function trimmedResults(parsed, ledgerRecs) {
  const offered = offeredOf(parsed, ledgerRecs);
  return parsed.results.filter((r) => r.marker && offered(r));
}

/* The guard's saving on one session, in tokens: for each result that carries the trim marker AND matches a
   ledger row, the removed tokens (original chars - kept, over CHARS_PER_TOKEN), and those tokens re-read
   through every later request they no longer sit in (carriedTurns + 1). Tokens only, never money -- the
   project states every saving in tokens entered and carried. */
function trimSavings(parsed, ledgerRecs) {
  const idx = ledgerIndex(ledgerRecs || [], parsed.sessionId);
  const offeredOf = (r) => idx.byId.get(r.id) || idx.byWhat.get(r.name + '|' + String(r.what || '').slice(0, 120));
  const trimmed = parsed.results.filter((r) => r.marker && offeredOf(r));
  let saved = 0, savedCarried = 0, pts = 0, unpriced = 0;
  for (const r of trimmed) {
    const l = offeredOf(r);
    const tok = Math.round((l.chars - l.kept) / CHARS_PER_TOKEN);
    saved += tok;
    savedCarried += tok * (r.carriedTurns + 1);
    const q = parsed.requests[r.afterReq];
    if (calibrated(q && q.model)) pts += resultPts(tok, r.carriedTurns); else unpriced++;
  }
  return { count: trimmed.length, saved, savedCarried, pts, unpriced };
}

/* The second half is the OTHER side of the same table, and it lives in this one loop for the reason the
   comment above `trimmedResults` gives: a pooled view uses the same rule, not a second, quietly different
   one. `reach` files everything non-shell into a single `nonShell` bucket and stops -- on the sessions this
   was written from that bucket was 41% of all carried tokens, the second largest thing in the report, and
   the view named none of it. It is not miscellany: pooled over 76 transcripts on one machine it was almost
   entirely **Read**, 40.1% of everything carried. `handlePost` gates every branch on isShell/isMcp, so a Read
   result never enters the trim pipeline at all, and its only lever is the PreToolUse cap.

   So `read` sizes what that lever can even be eligible for. The cap fires on an UNBOUNDED read of a file over
   `readMaxBytes`, leaving three groups, which on the same pool ran 63.8% / 33.2% / 3.0% of Read carry --
   the cap is eligible for about a thirtieth of the largest block in the report. A ranged read is excluded BY
   DESIGN (0.2.3: shredding one taught the model to read in 80-line chunks and doubled the tokens), so this is
   not a defect list; it is the size of what the product declines to touch, which the report owes the reader
   plainly rather than as a 41% residue.

   File sizes are NOT taken from the delivered text -- on a read the cap already acted on, that text IS the
   cap's output, the mistake `unboundedReads` documents at length. They come from each session's optional
   `sizes` map (id -> bytes), which the caller builds from `unboundedReads` and its existing provenance chain.
   A read that chain cannot size is counted as `unsized` rather than guessed into a bucket, and an ABSENT
   `readMaxBytes` files every whole read that way -- an absent knob is not a threshold of zero, the same
   distinction `unboundedReads` draws for `over`. */
function reachPooled(sessions, opts) {
  const knob = (opts || {}).readMaxBytes;
  const trigger = knob == null || knob === '' ? NaN : Number(knob);
  const sized = Number.isFinite(trigger);
  const maxChars = limitOf((opts || {}).maxChars, (opts || {}).toolMaxChars);
  const B = () => ({ n: 0, tokens: 0, carried: 0 });
  const out = emptyReach();
  const byTool = new Map(), nonShellByTool = new Map();
  const read = { all: B(), ranged: B(), over: B(), under: B(), unsized: B() };
  const bump = (map, key, res) => {
    const e = map.get(key) || { tool: key, n: 0, tokens: 0, carried: 0 };
    e.n++; e.tokens += res.tokens; e.carried += res.carried || 0;
    map.set(key, e);
  };
  const add = addTo;
  for (const { parsed, trimmed, sizes } of sessions) {
    const r = reach(parsed, trimmed, { maxChars });
    for (const k of Object.keys(out)) { out[k].n += r[k].n; out[k].tokens += r[k].tokens; out[k].carried += r[k].carried; }
    const inWindow = new Set([...(trimmed || [])]);
    for (const res of parsed.results) {
      const shell = res.name === 'Bash' || res.name === 'PowerShell';
      /* `reach` tests the rewrite FIRST, so a result the guard rewrote is acted-on whatever it is. Mirroring
         that order here is what keeps both tool maps summing to their own bucket instead of double-counting
         a trimmed mcp__* result as acted-on and as beyond reach. */
      if (!shell) {
        if (inWindow.has(res)) continue;
        bump(nonShellByTool, res.name || '(unknown)', res);
        if (res.name !== 'Read' || !res.file) continue;
        add(read.all, res);
        /* A ranged read with a size is one the cap rewrote: `unboundedReads` ties its reconstructed cap row
           back to this result, and it sizes no other ranged read. It belongs to the cap, not to "ranged". */
        if (!res.whole && !(sizes && res.id != null && sizes.has(res.id))) { add(read.ranged, res); continue; }
        const bytes = sized && sizes && res.id != null ? sizes.get(res.id) : null;
        add(bytes == null ? read.unsized : bytes > trigger ? read.over : read.under, res);
        continue;
      }
      const isWindow = inWindow.has(res) || trimClass(res, maxChars) === 'window';
      if (!isWindow) continue;
      bump(byTool, commandTool(res.what) || '(unknown)', res);
    }
  }
  const carriedTotal = out.total.carried || 0;
  const rank = (m) => [...m.values()].sort((a, b) => b.carried - a.carried || b.n - a.n);
  return { ...out, carriedTotal, read, readTrigger: sized ? trigger : null,
    windowShareOfCarried: carriedTotal ? out.window.carried / carriedTotal : 0,
    tools: rank(byTool), nonShellTools: rank(nonShellByTool) };
}


/* The guard's own cost, and the reason ab10's pair 5 saved only 8%: a trim can send the model back for
   what was cut. A recovery read is a read of a file this session had already read at a different offset
   in the same context window -- distinct from a repeat read, which returns the same slice again. Every ON
   arm of ab10 made more of these than its OFF arm. Reporting the saving without this is dishonest. */
function recoveryReads(parsed) {
  const windowOf = (r) => parsed.compactions.filter(c => c <= r.afterReq).length;
  const seen = new Map(); const out = { n: 0, tokens: 0, carried: 0, files: [] };
  for (const r of parsed.results) {
    const f = r.file; if (!f) continue;
    const k = windowOf(r) + '|' + f;
    if (seen.has(k)) { out.n++; out.tokens += r.tokens; out.carried += r.carried || 0; if (out.files.indexOf(f) < 0 && out.files.length < 5) out.files.push(f); }
    seen.set(k, r.afterReq);
  }
  return out;
}

/* Step 0 of the narrowing roadmap: the gate that decides whether a withhold saved tokens or backfired.
   recoveryReads above is the raw signal -- every time the model came back to a file it had read -- and it
   can only say "some of these" were the guard's doing. This attributes the cost to the guard exactly. A
   WITHHOLD is a result the model saw carrying the guard's marker AND matching a ledger row (a trim, an MCP
   trim, or a dedup pointer): the ledger gives the original and kept sizes, so its saving is exact. It
   BACKFIRES only when the model pulls the withheld bytes back the two ways the guard itself created --
   reading the out/ file the guard saved (the trim/MCP marker names that path), or `tokenbrake show <id>`
   (the dedup pointer names that id). Nothing else lives in out/ and no other `show` exists, so a hit is the
   guard's own cost by construction, not an ordinary re-read.

   Attribution is EXACT, not a substring guess: the guard names each save `<session_id[0..8]>-<tool_use_id
   last 10, cleaned>.txt` (guard.js saveOut), so this rebuilds that stem for each withhold from its own id
   and the session id and compares the read's stem to it whole. A dedup row's saving is its FIRST copy, saved
   under that copy's stem, which the row carries verbatim as `sameAs` and the pointer names as the `show`
   argument -- so a dedup withhold matches on `sameAs`. A read whose stem this session cannot rebuild (an
   earlier session's file, a different session id) matches nothing here, which is the point of doing it whole
   rather than by containment.

   The NET is the gross saving (the same removed-tokens x carried basis trimSavings rests on) minus
   what those pull-backs carried, measured on the SAME footprint (size x (its own later requests + 1), so
   entry and every re-read count on both sides). The verdict reads the net, not the count: ab10 established
   that the number of trims does not predict the saving, so a measured net loss is called a backfire at any
   sample size, and only the "did it help" labels wait for MIN_WITHHOLDS results before a rate is asserted.
   Only a MATCHED pull-back nets against the saving: a
   read of a save this audit did not count as a withhold (an earlier session's out/ file, or a capped or
   over-ceiling output that carries no marker) is a real cost but not THIS saving coming back, so netting it
   would let the rate say "nothing backfired" while the net was silently docked -- it is reported apart
   instead. Read caps are reported apart too, as a softer signal: a bounded re-read after a cap is partly the
   behaviour the cap asks for, and trimSavings never counted a saving for them to net against. */
const OUT_FILE = /(?:^|[\\/])tokenbrake[\\/]out[\\/]([^\\/]+?)\.txt$/;
/* The same saved-output path embedded in a shell command rather than standing alone as a Read's path: no `$`
   anchor (the path sits mid-line, e.g. `sed -n '1,40p' <path> | head`), a leading boundary so a stray
   `xtokenbrake` cannot match, and the stem in the guard's own sanitized charset ([A-Za-z0-9_-], per saveOut). */
const OUT_IN_CMD = /(?:^|[\s'"=([\\/])tokenbrake[\\/]out[\\/]([A-Za-z0-9_-]+)\.txt/;
const SHOW_CMD = /(?:tokenbrake|cli\.js)\s+show\s+(\S+)/;
const MIN_WITHHOLDS = 3;   // a chosen confidence floor: below it a "rate" is not asserted, only a measured loss
function backfireVerdict(n, net, backfired, min) {
  if (!n) return 'nothing';
  if (net < 0) return 'backfired';                 // a measured net loss is real at any sample size
  if (n < (min == null ? MIN_WITHHOLDS : min)) return 'too few';   // an explicit floor of 0 must not coerce to the default
  if (!backfired) return 'clean';
  return net === 0 ? 'break-even' : 'net positive';   // break-even: the pull-backs cost exactly what was saved
}
function backfireAudit(parsed, ledgerRecs, opts) {
  carry(parsed);
  const ledger = ledgerRecs || [];
  const idx = ledgerIndex(ledger, parsed.sessionId);
  const offeredOf = (r) => idx.byId.get(r.id) || idx.byWhat.get(r.name + '|' + String(r.what || '').slice(0, 120));

  /* The withholds this audit can net exactly: marker in the transcript (the model saw the replacement) AND a
     ledger row that saved the withheld bytes to out/ (the original and kept sizes). kind is read from the row
     -- a dedup row carries `dedup`, an MCP trim carries `mcp`, a blob elision carries `blob`, a git-diff
     collapse carries `gitview`, everything else is a plain trim. An EXCERPT
     row (a `cat` of a large file capped like a Read: guard.js logs ev:'post', excerpt:true, saved:null) is
     NOT netted here: it saves nothing to out/, so it could only ever read as "clean" and would pad the saving
     side of the gate. It is a Read-cap-family event and belongs to the caps line / `report --caps`. `stem` is
     the exact out/ filename (minus .txt) the guard would have written: for a dedup, the first copy's stem in
     `sameAs`; otherwise rebuilt the way saveOut names it (guard.js saveOut -- pinned by the integration test
     in test.mjs; the guard could now export it, a later cleanup). No stem => no match. */
  // must match guard.js saveOut's sid stem byte-for-byte, or a pull-back won't match its withhold: same
  // slice+sanitize, AND the same fallback -- recover the real session from the transcript filename (as the
  // rest of transcript.js does) when the parse lost it, then guard's own `|| 'session'` last resort.
  const sid8 = String(parsed.sessionId || path.basename(parsed.file || '', '.jsonl') || 'session').slice(0, 8).replace(/[^\w-]/g, '_');
  const stemOf = (id) => (sid8 && id) ? sid8 + '-' + String(id).slice(-10).replace(/[^\w-]/g, '') : null;
  const withholds = [];
  for (const r of parsed.results) {
    if (!r.marker) continue;
    const l = offeredOf(r);
    if (!l || l.excerpt) continue;
    const savedTokens = Math.max(0, Math.round(((l.chars || 0) - (l.kept || 0)) / CHARS_PER_TOKEN));
    const kind = l.dedup ? 'dedup' : (l.mcp ? 'mcp' : (l.blob ? 'blob' : (l.gitview ? 'gitview' : 'trim')));
    withholds.push({ id: r.id || null, kind, chars: Number(l.chars) || null, savedTokens, savedCarried: savedTokens * ((r.carriedTurns || 0) + 1),
      stem: kind === 'dedup' ? (l.sameAs || null) : stemOf(r.id), recovered: false, pulledFoot: 0 });
  }

  /* A pull-back: a later result that read a saved output back into context. Three shapes, all the guard's own
     doing -- the out/ file read by the Read/Edit tool (path in `file`), the out/ file read by a SHELL command
     whose shape EXCERPT_CMD does not recognise (path in the command text `what`), or `tokenbrake show <arg>`
     (ref = the argument, a stem, a prefix, or a full path, exactly as `show` accepts). readFileOf lifts the
     single-file read shapes EXCERPT_CMD DOES match -- a bare cat / `sed -n 'N,Mp'` / head / tail / non-recursive
     grep -- into `file`, so OUT_FILE already caught those; what stayed uncounted was every OTHER way a shell
     reads the file: piped or compound (`sed ... | head`, `cat ... | tail`), a recursive grep, a sed/grep form
     outside that narrow set. For those `file` is null and only `what` carries the path, and the harness pipes by
     default, so this was a wide leak -- a real backfire scored as clean. `foot` is the token-read footprint on
     the same basis as savedCarried: what re-entered (tokens) plus what it was then carried through. Still a
     LOWER bound, tighter now, and where it is not exact it errs the cautious way: the shell match keys on the
     out/ path being NAMED in the command, which is a read wherever the model holds that path (that is why it
     holds it), so it counts the real pull-backs and over-counts only a rare non-read reference (`rm`/`ls`/`echo`
     of the path) -- an over-count, never an under-count, there. It reads the FIRST out/ path in a command, so a
     single command pulling back two withheld out/ files counts one; and a Grep TOOL call on the saved file,
     whose `path` input surfaces as neither `file` nor `what`, is still uncounted. Both are optimistic residuals,
     so a clean result still means "none seen", not "none happened". */
  const recoveries = [];
  for (const r of parsed.results) {
    let ref = null, kind = null;
    const m = (r.file && OUT_FILE.exec(String(r.file))) || OUT_IN_CMD.exec(String(r.what || ''));   // out/ file read: Read tool, or a shell command that names it
    if (m) { ref = m[1]; kind = 'out-file'; }
    else { const ms = SHOW_CMD.exec(String(r.what || '')); if (ms) { ref = String(ms[1]); kind = 'show'; } }
    if (!kind) continue;
    recoveries.push({ kind, ref, foot: (r.tokens || 0) + (r.carried || 0), tokens: r.tokens || 0, matched: false });
  }

  /* Match a pull-back to the withhold whose saved output it read, setting both flags in one pass. An out/
     file read must EQUAL the stem the guard would have written -- exact, so a shared sid8 prefix cannot
     cross-attribute. A `show` argument is looser by design: `show` resolves a full path, an exact stem, or a
     unique prefix, and refuses an ambiguous one (cli.js showOutput), so mirror that -- reduce a path to its
     stem, then take an exact stem, else a prefix that resolves to exactly one withhold; an ambiguous prefix
     stays unattributed (counted as a pull-back, not netted). */
  const stemFromShow = (arg) => { const m = OUT_FILE.exec(String(arg)); return m ? m[1] : String(arg).replace(/\.txt$/, ''); };
  const attribute = (rec) => {
    const ref = rec.kind === 'show' ? stemFromShow(rec.ref) : rec.ref;
    if (!ref) return null;
    const exact = withholds.filter((w) => w.stem && w.stem === ref);
    if (exact.length) return exact[0];
    if (rec.kind === 'show') { const pre = withholds.filter((w) => w.stem && w.stem.startsWith(ref)); if (pre.length === 1) return pre[0]; }
    return null;
  };
  for (const rec of recoveries) { const w = attribute(rec); if (w) { rec.matched = true; w.recovered = true; w.pulledFoot += rec.foot; } }

  const saved = withholds.reduce((s, w) => s + w.savedTokens, 0);
  const savedCarried = withholds.reduce((s, w) => s + w.savedCarried, 0);
  const matched = recoveries.filter((x) => x.matched);
  const recoveredTokens = matched.reduce((s, x) => s + x.tokens, 0);
  const recoveredCarried = matched.reduce((s, x) => s + x.foot, 0);
  const unmatched = recoveries.filter((x) => !x.matched);
  const unmatchedCarried = unmatched.reduce((s, x) => s + x.foot, 0);
  const backfired = withholds.filter((w) => w.recovered).length;
  const net = savedCarried - recoveredCarried;
  const verdict = backfireVerdict(withholds.length, net, backfired, opts && opts.min);

  const byKind = {};
  for (const w of withholds) byKind[w.kind] = (byKind[w.kind] || 0) + 1;
  const caps = readCaps(ledger, parsed.sessionId);
  const cls = classifyRangedReads(parsed, ledger, { sessionId: parsed.sessionId });
  const deltas = readDeltas(ledger, parsed);
  const reReads = readReReads(ledger, parsed);

  return { withholds, byKind, saved, savedCarried, recoveredEvents: matched.length,
    recoveredTokens, recoveredCarried, unmatchedEvents: unmatched.length, unmatchedCarried,
    backfired, net, verdict, caps: { fired: caps.n, induced: cls.induced.length }, deltas, reReads };
}

/* Shared backfire audit for both narrowings. A narrowing (guard ev:'read-delta' for narrowing 1, 'read-reread'
   for narrowing 2) replaced an unbounded Read of a file with a bounded window, on the premise that the model
   still had -- or did not need -- the rest. It BACKFIRED when the model then read the SAME file again at a line
   OUTSIDE that window: the narrowing hid what it actually wanted. One loop serves both: for each ledger row of
   the given ev in this session, count it as fired, then look for a LATER read of the same file that reached
   outside what the narrowing left in context -- a whole-file re-read (cat / unbounded Read), or a ranged read
   the ev-specific `wentPast(readFrom, r)` flags. The `when <= t` guard excludes the narrowed read's OWN entry
   (its unbounded intent, recorded before the narrowing fired), so a narrowing never counts as its own backfire;
   this is why the window is recorded on each row, and why each narrowing has its own ev rather than folding into
   the read-cap/induced machinery (where its own read would count against it). A distinct ev also keeps these
   rows out of the readMaxBytes evidence in --caps/--reads/--where, which is about the size cap, not this.

   Known imprecision (deferred, see FEATURES-PLAN): `wentPast` sees a later read's START line only (readStartLine
   returns offset, not offset+limit), so it UNDER-counts a bounded re-read that starts at/before the shown head
   but runs past it (e.g. offset:1 limit:200 after a 5-line elision) and a limit-only read (readFrom null). This
   errs toward too-few backfires -- the unsafe direction for a default flip -- but a precise test needs the
   read's END line added to the parsed results, which no other view needs; recorded, not built. */
function auditNarrowing(ledgerRecs, parsed, ev, wentPast) {
  const cwd = parsed && parsed.cwd;
  let fired = 0, backfired = 0;
  for (const r of ledgerRecs || []) {
    if (!r || r.ev !== ev) continue;
    if (parsed && parsed.sessionId && r.session && r.session !== parsed.sessionId) continue;
    fired++;
    const key = normReadPath(r.what, cwd), t = Number(r.t) || null;
    const hit = (parsed.results || []).some((res) => {
      if (!res.file || normReadPath(res.file, cwd) !== key) return false;
      const when = res.askedAt != null ? res.askedAt : res.at;
      if (t != null && when != null && when <= t) return false;   // must come after the narrowing fired
      if (res.whole) return true;                                 // read the whole file again
      if (res.readFrom == null) return false;
      return wentPast(res.readFrom, r);
    });
    if (hit) backfired++;
  }
  return { fired, backfired };
}

/* A delta backfires when a later read starts outside the [offset, offset+limit) window it showed. */
function readDeltas(ledgerRecs, parsed) {
  return auditNarrowing(ledgerRecs, parsed, 'read-delta', (readFrom, r) => {
    const from = Number(r.offset) || 1, to = from + (Number(r.limit) || 0) - 1;
    return readFrom < from || readFrom > to;
  });
}

/* Re-read elisions (narrowing 2) and whether each sent the model back. An elision (guard ev:'read-reread')
   caps a re-read of an unchanged, already-whole-read file to the first `limit` lines on the premise that the
   model still has the rest. It BACKFIRED when the model then read the SAME file again past that -- a
   whole-file read, or a ranged read starting beyond `limit` -- meaning it did NOT still have it (a compaction
   the guard does not consult). */
function readReReads(ledgerRecs, parsed) {
  return auditNarrowing(ledgerRecs, parsed, 'read-reread', (readFrom, r) =>
    readFrom > (Number(r.limit) || 0));   // asked for content past what the elision showed
}

/* Usage, summed once per request. The API reports the whole context on every request (uncached input +
   cache reads + cache writes), so summing those is the total the session has actually processed, and the
   LAST request's figure is roughly what the context holds right now. cacheRead over the total is how much
   of that was served at the cached rate. Missing counters read as 0 here because this is a sum -- the
   per-call null-vs-0 distinction the extension keeps does not survive addition. */
function usageTotals(parsed) {
  let processed = 0, cacheRead = 0, cacheWrite = 0, input = 0, out = 0, requestsWithUsage = 0, last = 0, lastModel = null;
  for (const q of parsed.requests) {
    const u = q.usage;
    if (!u || !(usageCtx(u) + (u.output_tokens || 0))) continue;   // Claude Code's synthetic replies: all-zero, no API request
    requestsWithUsage++;
    const inp = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
    last = usageCtx(u); lastModel = q.model;
    processed += last; cacheRead += cr; cacheWrite += cw; input += inp; out += u.output_tokens || 0;
  }
  return { processed, cacheRead, cacheWrite, input, out, requestsWithUsage, contextNow: last, lastModel };
}

/* The session's draw on the five-hour limit, in points of the window, priced with LIMIT_WEIGHTS: cache reads,
   writes (cache writes plus uncached input, as the calibration and the replay count them) and output. Only
   requests on the calibrated model are priced; the rest are counted and never guessed at. A request whose
   usage is all zero (Claude Code's own synthetic replies) is neither. Pure. */
function limitDraw(parsed) {
  let read = 0, write = 0, output = 0, priced = 0, unpriced = 0;
  for (const q of parsed.requests) {
    const u = q.usage;
    if (!u || !(usageCtx(u) + (u.output_tokens || 0))) continue;
    if (!calibrated(q.model)) { unpriced++; continue; }
    priced++;
    read += u.cache_read_input_tokens || 0;
    write += (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0);
    output += u.output_tokens || 0;
  }
  const W = LIMIT_WEIGHTS;
  return { read: read * W.read / 1e6, write: write * W.write / 1e6, output: output * W.output / 1e6, priced, unpriced };
}

/* Which results the guard trimmed, from the ledger: keyed by tool_use_id where the ledger has one (0.1.0
   records it as `id`), else by (tool, what) as a best effort for older rows. */
function ledgerIndex(ledgerRecs, sessionId) {
  const byId = new Map(), byWhat = new Map();
  for (const r of ledgerRecs) {
    if (!r || r.ev !== 'post' || r.kept == null) continue;
    if (sessionId && r.session && r.session !== sessionId) continue;
    if (r.id) byId.set(r.id, r);
    else byWhat.set(r.tool + '|' + String(r.what || '').slice(0, 120), r);
  }
  return { byId, byWhat };
}

/* The Read cap's own firings, from the ledger rather than the transcript: a capped Read produces a
   perfectly ordinary short result with no marker in it, so the trim line cannot see it and never could.
   The two halves are different features that happen to share a hook and are separable by config --
   `readMaxBytes` caps an unbounded Read of a large source file, `persistedLimitLines` caps a read of an
   output Claude Code had already written to disk -- and the evidence for them is not the same. On one real
   421-request session, reads of persisted outputs carried 25% of everything carried; the source-file cap was
   then unobserved outside a test, and benchmark round 1 (2026-09-11) is where it was first seen firing in
   anger -- one to four times per ON run, on fixtures built large on purpose. How often it fires on ordinary
   work is still open, and `report --caps` is what answers it. Counting them apart is what lets a week of real
   sessions decide whether either default is worth keeping. */
function readCaps(ledgerRecs, sessionId) {
  let source = 0, persisted = 0, bytes = 0;
  for (const r of ledgerRecs) {
    if (!r || r.ev !== 'read-cap') continue;
    if (sessionId && r.session && r.session !== sessionId) continue;
    bytes += Number(r.bytes) || 0;
    if (r.persisted) persisted++; else source++;
  }
  return { source, persisted, n: source + persisted, bytes };
}

/* Every file the Read cap has fired on, pooled across sessions unless one is named. This is the view that
   says whether the cap is a daily event or a rarity on a given person's work -- the question readMaxBytes
   turns on, and one the per-session report cannot answer because the answer is a handful of firings spread
   over weeks. `delivered` is limit/lines, the share of the file the model received; it is null rather than a
   guess when the guard skipped the line count, which it does above 20 MB. */
function readCapFiles(ledgerRecs, sessionId) {
  const idx = readCapIndex(ledgerRecs, sessionId);
  const files = new Map();
  const sessions = new Set();
  /* The third half, which is not a third knob. A `cat` of a large file is capped by the POST path against
     the SAME readMaxBytes and readLimitLines (guard.js:283-296), but it logs `ev: 'post', excerpt: true`
     rather than `ev: 'read-cap'` -- so a counter that reads only read-cap rows sees one of the two paths
     those knobs govern and reports the other as never having fired. `chars` on that row is the size BEFORE
     the cap, which for a cat is the file itself: no line numbering to subtract. */
  const rows = [...idx.rows];
  let excerpt = 0;
  for (const r of ledgerRecs || []) {
    if (!r || r.ev !== 'post' || !r.excerpt || r.kept == null) continue;
    if (sessionId && r.session && r.session !== sessionId) continue;
    const fp = readFileOf('Bash', { command: String(r.what || '') });
    if (!fp) continue;
    excerpt++;
    rows.push({ t: Number(r.t) || null, what: fp, key: normReadPath(fp), bytes: Number(r.chars) || 0,
      lines: null, limit: null, persisted: false, session: r.session || null, viaExcerpt: true });
  }
  for (const r of rows) {
    if (r.session) sessions.add(r.session);
    const e = files.get(r.key);
    if (!e) files.set(r.key, { what: r.what, n: 1, persisted: r.persisted, limit: r.limit, bytes: r.bytes,
      lines: r.lines, viaExcerpt: !!r.viaExcerpt });
    else { e.n++; if (r.bytes > e.bytes) { e.bytes = r.bytes; e.lines = r.lines; } }
  }
  const listed = [...files.values()].map((e) => ({ ...e,
    delivered: (e.lines && e.limit) ? e.limit / e.lines : null }))
    .sort((a, b) => b.n - a.n || b.bytes - a.bytes);
  const half = (pick) => {
    const rs = out.filter(pick);
    return { n: rows.filter(pick).length, files: rs.length, bytes: rows.filter(pick).reduce((t, r) => t + r.bytes, 0) };
  };
  const out = [...files.values()];
  return { source: half((r) => !r.persisted && !r.viaExcerpt), persisted: half((r) => r.persisted),
    excerpt: half((r) => r.viaExcerpt), viaExcerpt: excerpt,
    n: rows.length, bytes: rows.reduce((t, r) => t + r.bytes, 0),
    sessions: sessions.size, deduped: idx.deduped, limits: idx.limits,
    unknownLines: listed.filter((r) => r.lines == null).length, files: listed };
}

/* The reads the Read cap's TRIGGER would act on, and how big they actually were. `readMaxBytes` decides
   which unbounded reads get capped and `readLimitLines` how much a capped one withholds -- but nothing in the
   record has ever said how many of a person's reads a lower trigger would catch, or how much of each it would
   then cut. That is arithmetic over their own sessions, and this is the population it runs on.

   Three corrections without which the count is worthless, each returned as its own number rather than folded
   into the total:

   - A read the guard already CAPPED delivered only `readLimitLines` lines and carries no marker, so it looks
     like a small ordinary read. The ledger knows better: a read-cap row carries the file's true size and line
     count from statSync, so those reads come back with real sizes instead of being dropped or believed.
   - Whether Claude Code records the model's ORIGINAL input or the guard's REWRITTEN one (updatedInput adds a
     `limit`) is not documented anywhere. Both tallies are returned, which settles it from a real machine's
     data rather than by assuming.
   - Claude Code refuses a Read near 25k tokens, so a delivered size close to that ceiling is a floor on the
     file's size, not a measurement of it. Those are flagged, never silently counted as measured. */
function unboundedReads(parsed, ledgerRecs, opts) {
  const o = opts || {};
  const idx = readCapIndex(ledgerRecs, o.sessionId || parsed.sessionId || null);
  const whole = wholeReadIndex(ledgerRecs, o.sessionId || parsed.sessionId || null);
  const reads = [];
  const postByIdChars = new Map();
  for (const r of ledgerRecs || []) {
    if (!r || r.ev !== 'post' || !r.excerpt || r.kept == null || !r.id) continue;
    if ((o.sessionId || parsed.sessionId) && r.session && r.session !== (o.sessionId || parsed.sessionId)) continue;
    postByIdChars.set(r.id, Number(r.chars) || 0);
  }
  let recordedOriginal = 0, nearCeiling = 0, hostLines = 0, persistedSkipped = 0;
  const capSeen = new Set();
  for (const r of parsed.results) {
    if (!r.whole || !r.file) continue;
    /* A spilled output is the OTHER knob: persistedLimitLines caps it at anything over maxChars, whatever
       readMaxBytes is set to. Counting it here would credit the trigger with a firing it has no say in. */
    if (PERSISTED.test(r.file)) { persistedSkipped++; continue; }
    const key = normReadPath(r.file, parsed.cwd);
    const cap = key ? idx.byFile.get(key) : null;
    if (cap) {
      /* Recorded as the model wrote it: unbounded in the transcript, yet the ledger says it was capped, so
         the delivered text is the cap's first N lines and not the file. Believe the ledger -- its numbers
         come from statSync. Believing the transcript here would count a capped read as a small file and
         then argue for a lower trigger using the cap's own output as the evidence. */
      recordedOriginal++;
      capSeen.add(key);
      reads.push({ id: r.id, file: r.file, bytes: cap.bytes, lines: cap.lines, source: 'ledger', capped: true, ceiling: null,
        via: r.name === 'Read' ? 'read-cap' : 'post', reuse: (r.carriedTurns || 0) + 1 });
      continue;
    }
    let sh = r.shape || { bytes: r.chars, lines: r.lines, numbered: false, from: null, to: null };
    let source = sh.numbered ? 'numbering' : 'text';
    /* The guard stat'd this file at the moment of the read. That beats anything the delivered text can say. */
    const wr = key ? whole.byFile.get(key) : null;
    if (wr && wr.bytes) { sh = { bytes: wr.bytes, lines: wr.lines, numbered: false, from: null, to: null }; source = 'ledger-whole'; }
    /* The same correction the Read cap needs, for the other path. A `cat` the guard capped as an excerpt
       delivered only readLimitLines lines and says so in its marker; its ledger `post` row carries `chars`,
       the size BEFORE the cap, which for a cat is the file itself. Without this a capped cat is sized at its
       cap and argues for a lower trigger with the guard's own output -- the mistake this file already
       corrects for Read, arriving by a different door. */
    if (r.marker && r.id && postByIdChars.has(r.id)) {
      sh = { bytes: postByIdChars.get(r.id), lines: null, numbered: false, from: null, to: null };
      source = 'ledger-post';
    }
    let ceiling = null;
    /* An errored read is not a large file. Claude Code's own refusal above roughly 25k tokens IS evidence a
       large file exists, with no evidence of its size; "file not found" is evidence of nothing. Classifying
       every failure as the first would manufacture large files out of typos -- and those files, being
       unsized, sit exactly where they could swing the withholding median. So the refusal is matched on its
       wording and anything else is reported as what it is: a failure whose reason was not recognised. */
    if (r.isError) ceiling = TOO_LARGE.test(r.text || '') ? 'refused' : 'errored';
    else if (sh.numbered && sh.from === 1 && sh.lines === HOST_READ_LINES) { ceiling = 'host-lines'; hostLines++; }
    else if (r.chars >= 0.9 * HOST_READ_CEILING) { ceiling = 'near'; nearCeiling++; }
    /* Which of the two paths readMaxBytes reaches this read by, because they do not share its floor: the
       PreToolUse cap compares statSync().size and nothing gates it, while a shell excerpt goes through the
       POST hook, which returns before any cap logic at or under maxChars (guard.js:272). A trigger below
       maxChars is therefore a dead knob for a shell read, and a grid that does not know that overstates
       every row below it. */
    reads.push({ id: r.id, file: r.file, bytes: sh.bytes, lines: sh.lines, capped: source === 'ledger-post', ceiling, source,
      via: r.name === 'Read' ? 'read-cap' : 'post', reuse: (r.carriedTurns || 0) + 1 });
  }
  /* A cap row whose file never appears as an unbounded read means the transcript recorded the guard's
     rewritten input instead -- the read is in there carrying a `limit`, which is not a whole-file read.
     Those reads belong in the population too, at their true size. */
  let recordedRewritten = 0;
  const claimed = new Set();
  for (const [key, cap] of idx.byFile) {
    if (capSeen.has(key) || cap.persisted) continue;
    recordedRewritten++;
    /* The rewritten read is in the transcript as a Read of the same file carrying the cap's `limit` and no
       offset. Tie the row to the first such result so a caller keying sizes by result id can find it; with
       none, `id` stays null and such a caller skips it. */
    const res = parsed.results.find((x) => x.name === 'Read' && !x.whole && x.readFrom == null && x.id != null
      && !claimed.has(x.id) && normReadPath(x.file, parsed.cwd) === key);
    if (res) claimed.add(res.id);
    reads.push({ id: res ? res.id : null, file: cap.what, bytes: cap.bytes, lines: cap.lines, source: 'ledger', capped: true, ceiling: null,
      via: 'read-cap', reuse: res ? (res.carriedTurns || 0) + 1 : null });
  }
  const sized = reads.filter((r) => !r.ceiling);
  /* Reads over `readMaxBytes` (from opts) the cap did NOT act on -- the guard had its chance and missed, the
     "missing" signal report --reads and the auto-tuner both read. One predicate, here where the reads are
     classified, rather than the same filter copied into each caller. An ABSENT readMaxBytes disables the signal
     (over: 0); an explicit 0 is honored (the guard takes 0 literally as "cap everything", so any uncapped read
     is over it) -- distinguished so a caller passing 0 is not silently treated as "no threshold". */
  const overMaxN = Number(o.readMaxBytes);
  const overMax = (o.readMaxBytes == null || !Number.isFinite(overMaxN)) ? null : overMaxN;
  const over = overMax == null ? 0 : reads.filter((r) => !r.capped && !r.ceiling && (r.bytes || 0) > overMax).length;
  return { reads, sized, over, n: reads.length, bytes: reads.reduce((t, x) => t + (x.bytes || 0), 0),
    files: new Set(reads.map((r) => normReadPath(r.file, parsed.cwd))).size,
    capped: reads.filter((x) => x.capped).length, recordedOriginal, recordedRewritten,
    nearCeiling, hostLines, persistedSkipped,
    refused: reads.filter((r) => r.ceiling === 'refused').length,
    errored: reads.filter((r) => r.ceiling === 'errored').length,
    sources: { ledger: reads.filter((r) => r.source === 'ledger').length,
      ledgerWhole: reads.filter((r) => r.source === 'ledger-whole').length,
      ledgerPost: reads.filter((r) => r.source === 'ledger-post').length,
      numbering: reads.filter((r) => r.source === 'numbering').length,
      text: reads.filter((r) => r.source === 'text').length },
    noLines: reads.filter((x) => !x.lines).length,
    /* Undetermined until a cap actually fires in these sessions: with nothing to match, neither answer is
       evidence. Printed as undetermined rather than silently as one of them. */
    shapeVerdict: (recordedOriginal + recordedRewritten) === 0 ? 'undetermined'
      : recordedOriginal && recordedRewritten ? 'mixed' : (recordedOriginal ? 'original' : 'rewritten') };
}

/* Was the guard running in this session?

   This decides the reach verdict, and twice it has been answered from the ledger alone -- which lives beside the
   transcript and does not travel with it. A session read on a machine that is not the one it ran on (teleported,
   copied out of a cloud container, or restored after the container was reclaimed) arrives with no ledger rows,
   and would be filed as a session the guard was ABSENT from. That is the same mistake as pooling sessions it
   never ran in, one level down: "untouched" then means the record is missing, not that the guard declined.

   The transcript carries its own proof. A result the guard rewrote and the model actually received holds the
   `[tokenbrake]` marker, so the marker settles it when the ledger cannot.

   The fallback can only ADD sessions, never remove one: a session the guard ran in and never trimmed leaves no
   marker at all, so `via: 'marker'` is a LOWER BOUND on which sessions had it, and every caller says so. */
function guardRan(parsed, ledgerRecs, sessionId) {
  const sid = sessionId || (parsed && parsed.sessionId) || null;
  if (sid && (ledgerRecs || []).some((r) => r && r.session === sid)) return { ran: true, via: 'ledger' };
  if (parsed && (parsed.results || []).some((r) => r && r.marker)) return { ran: true, via: 'marker' };
  return { ran: false, via: null };
}

/* How deep into a file the model's targets sit, as a FRACTION of the file rather than as a line number.

   The question this exists for is the shape of the knob, not its value. `readLimitLines` is an absolute line
   count, but whether it hides the target depends on where the target sits relative to the file's length: a
   median start line of 351 is 51% into a 684-line file and 14% into a 2,570-line one. If targets cluster at
   an absolute line whatever the file's size, a fixed line count is the right shape. If they scale with the
   file, it is the wrong shape and the cap should be a fraction. Nothing has ever paired a read's start line
   with its file's length, so neither has ever been evidence.

   Line counts come from three sources and the output says which, because they are not equally good: a
   whole-file read of that file in the same session is exact and contemporaneous; a ledger cap row is exact
   but only exists for files the cap fired on; the file on disk now is what is left, and it may have changed
   since. A read whose file length cannot be established at all is counted as unresolved and never imputed. */
function readDepths(parsed, ledgerRecs, opts) {
  const o = opts || {};
  const sessionId = o.sessionId || parsed.sessionId || null;
  const idx = readCapIndex(ledgerRecs, sessionId);
  const whole = wholeReadIndex(ledgerRecs, sessionId);
  /* Lengths this session revealed by running off the end of a file. Largest sighting wins: a file that grew
     was that long by the end, and the shorter sighting is the one that throws a deeper read away. */
  const fromEof = new Map();
  for (const r of parsed.results) {
    if (!r.eofAt || !r.file) continue;
    const key = normReadPath(r.file, parsed.cwd);
    if (key && (!fromEof.has(key) || r.eofAt > fromEof.get(key))) fromEof.set(key, r.eofAt);
  }
  const fromSession = new Map();
  for (const r of parsed.results) {
    if (!r.whole || !r.file) continue;
    /* The file's length as the numbering reported it -- exact, and contemporaneous with the read. A read
       that stopped at the host's own line limit says nothing about the file's length and is not used. */
    const sh = r.shape;
    if (!sh || !sh.lines || (sh.numbered && sh.from === 1 && sh.lines === HOST_READ_LINES)) continue;
    const key = normReadPath(r.file, parsed.cwd);
    if (key && !fromSession.has(key)) fromSession.set(key, sh.lines);
  }
  const cls = classifyRangedReads(parsed, ledgerRecs, { sessionId });
  const rows = []; const bySource = { session: 0, ledger: 0, eof: 0, disk: 0 };
  let unresolved = 0;
  for (const r of cls.spontaneous) {
    const key = normReadPath(r.file, parsed.cwd);
    let lines = null, source = null;
    if (key && fromSession.has(key)) { lines = fromSession.get(key); source = 'session'; }
    else if (key && whole.byFile.get(key) && whole.byFile.get(key).lines) { lines = whole.byFile.get(key).lines; source = 'ledger'; }
    else if (key && idx.byFile.get(key) && idx.byFile.get(key).lines) { lines = idx.byFile.get(key).lines; source = 'ledger'; }
    else if (key && fromEof.has(key)) { lines = fromEof.get(key); source = 'eof'; }
    else if (o.linesOnDisk && r.file) { const n = o.linesOnDisk(r.file); if (n) { lines = n; source = 'disk'; } }
    if (!lines || r.readFrom > lines) { unresolved++; continue; }
    bySource[source]++;
    /* Bytes per line for THIS file, from this read's own delivered text: N lines in C characters, with Claude
       Code's numbering already subtracted by fileShape. Contemporaneous and specific to the file, which is the
       point -- the figure runs 28 to 56 across the files on record, so no global number can stand in for it. */
    const bpl = (r.shape && r.shape.lines > 0 && r.shape.bytes > 0) ? r.shape.bytes / r.shape.lines : null;
    rows.push({ file: r.file, start: r.readFrom, lines, depth: r.readFrom / lines, source, bpl });
  }
  const cv = (xs) => {
    if (xs.length < 2) return null;
    const m = xs.reduce((a, b) => a + b, 0) / xs.length;
    if (!m) return null;
    const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
    return Math.sqrt(v) / m;
  };
  const q = (xs, f) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : null; };
  const abs = rows.map((r) => r.start), frac = rows.map((r) => r.depth);
  /* Exact sources only for the verdict: a length read off disk today may not be the length the model saw. */
  const exact = rows.filter((r) => r.source !== 'disk');
  return { rows, n: rows.length, unresolved, bySource,
    absCV: cv(abs), fracCV: cv(frac),
    exactN: exact.length, exactAbsCV: cv(exact.map((r) => r.start)), exactFracCV: cv(exact.map((r) => r.depth)),
    absMedian: q(abs, 0.5), fracMedian: q(frac, 0.5), fracP90: q(frac, 0.9) };
}

/* Which SHAPE of cap serves a person's reading, not which value.

   An absolute cap delivers the first L lines whatever the file's length, so it withholds most of a long file
   and nothing from a short one. A fractional cap delivers the first f of the file, so it withholds 1-f of
   every file whatever its size. Genuinely different trades, and a coefficient of variation cannot tell them
   apart because it measures concentration, not what a single threshold of that shape costs.

   Per candidate, over reads whose file length is known exactly: how often the cap hides the target, and the
   median share of lines it withholds. `no cap` is on the list as the anchor -- a shape that cannot beat doing
   nothing is not a shape worth having. AB-TASK.md, "The Read cap's form". */
function capFrontier(rows, opts) {
  const o = opts || {};
  const abs = o.absolute || [100, 200, 300, 500, 800, 1200];
  const frac = o.fractional || [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const usable = (rows || []).filter((r) => r && r.lines > 0 && r.start > 0);
  const med = (xs) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; };
  /* Two ways to say what a cap costs, and they are not the same question. `withheld` is the median SHARE of a
     file's lines, which weights a 200-line file the same as a 2,000-line one. `withheldTokens` is the share of
     all the tokens these reads represent, which is what a session's total is made of -- and it is the measure that decides
     whether a fractional cap's extra saving on short files is saving worth having. AB-TASK.md, "A fractional
     Read cap", Step A. Reads whose bytes-per-line could not be established are outside the token measure and
     are counted, never estimated into it. */
  const priced = usable.filter((r) => r.bpl > 0);
  const totalTokens = priced.reduce((t, r) => t + (r.lines * r.bpl) / 4, 0);
  const point = (shape, param, deliveredOf) => {
    const delivered = usable.map((r) => Math.max(0, Math.min(r.lines, deliveredOf(r))));
    const missed = usable.filter((r, i) => r.start > delivered[i]).length;
    const tok = usable.reduce((t, r, i) => t + (r.bpl > 0 ? ((r.lines - delivered[i]) * r.bpl) / 4 : 0), 0);
    return { shape, param,
      miss: usable.length ? missed / usable.length : 0,
      withheld: med(usable.map((r, i) => (r.lines - delivered[i]) / r.lines)),
      withheldTokens: totalTokens ? tok / totalTokens : 0 };
  };
  return { n: usable.length, priced: priced.length, totalTokens,
    none: point('none', null, (r) => r.lines),
    absolute: abs.map((L) => point('absolute', L, () => L)),
    fractional: frac.map((f) => point('fractional', f, (r) => Math.floor(f * r.lines))) };
}

/* Which shape can save more at the same safety.

   The first criterion here asked for no higher miss at every matched withholding level. It cannot discriminate,
   and that was found on synthetic fixtures before it ever ran on real data: a fractional cap is all-or-nothing
   on targets that sit at a fixed depth -- it misses everything below the depth and nothing above it -- while an
   absolute cap degrades gradually. Two curves of different curvature almost never have one uniformly below the
   other, so "neither" came back for data built to favour each shape in turn. An instrument that returns the
   same answer whatever it measures is not measuring. Withdrawn, and recorded as withdrawn in AB-TASK.md.

   What replaces it holds SAFETY fixed and compares SAVING, which is the trade the cap actually makes: among
   the candidates of a shape whose miss rate is at or under `maxMiss`, the most any of them withholds. `no cap`
   is always available at zero withholding, so a shape whose best safe candidate withholds nothing is a shape
   that cannot be both safe and useful on this reading -- and if that is true of both, one number is the wrong
   form and no value of either will fix it. */
function frontierVerdict(front, opts) {
  const o = opts || {};
  const maxMiss = o.maxMiss == null ? 0.25 : o.maxMiss;
  const edge = o.edge == null ? 0.10 : o.edge;
  const key = o.measure === 'tokens' ? 'withheldTokens' : 'withheld';
  const best = (points) => [front.none, ...points].filter((p) => p.miss <= maxMiss)
    .reduce((b, p) => (b == null || p[key] > b[key] ? p : b), null);
  const a = best(front.absolute), f = best(front.fractional);
  const wa = a ? a[key] : 0, wf = f ? f[key] : 0;
  /* Nothing priced means nothing measured, and "neither shape can be safe and useful" is a finding -- one this
     data cannot support. A measure with no input says so instead of reporting the shape of its own emptiness. */
  const unmeasured = key === 'withheldTokens' && !(front.priced > 0 && front.totalTokens > 0);
  return { maxMiss, edge, measure: key, absolute: a, fractional: f, saved: { absolute: wa, fractional: wf },
    verdict: unmeasured ? 'no verdict'
      : (wa === 0 && wf === 0) ? 'neither can be safe and useful'
      : wf - wa >= edge ? 'fractional' : wa - wf >= edge ? 'absolute' : 'tie' };
}

/* What each candidate trigger would catch, and what each candidate limit would then withhold. Pure
   arithmetic over the reads -- the half of the readMaxBytes question that needs no session. The half it
   cannot answer is whether the model comes back for what was withheld, which is behavioural and costs a session
   to find out (AB-TASK.md, "The Read cap's trigger"). */
/* Whether the guard reaches the Read cap on a read at all: a shell read (via the POST hook) at or under maxChars
   is returned on before any cap logic (guard.js:272); an unbounded Read has no floor. A null maxChars is no floor. */
const capReaches = (r, maxChars) => !(maxChars != null && r.via === 'post' && (r.bytes || 0) <= maxChars);
function triggerGrid(reads, triggers, limits, opts) {
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const totalBytes = reads.reduce((t, r) => t + (r.bytes || 0), 0);
  /* `maxChars` is the shell path's floor and the Read path has none, so a read is caught only if the guard
     would actually reach the cap on it. Without this the rows below maxChars count reads the POST hook returns
     on, and -- worse than the count -- the withheld medians are taken over that same inflated set, so the
     saving a low trigger appears to offer is a saving on reads it never touches. Omitting opts keeps the old
     arithmetic exactly, so no existing caller changes meaning by being left alone. */
  const maxChars = opts && opts.maxChars != null ? Number(opts.maxChars) : null;
  return (triggers || []).map((trigger) => {
    const overBytes = reads.filter((r) => (r.bytes || 0) > trigger);
    const caught = overBytes.filter((r) => capReaches(r, maxChars));
    const caughtBytes = caught.reduce((t, r) => t + r.bytes, 0);
    const byLimit = {};
    for (const L of (limits || [])) {
      const withheld = caught.filter((r) => r.lines).map((r) => Math.max(0, (r.lines - Math.min(L, r.lines)) / r.lines));
      byLimit[L] = withheld.length ? med(withheld) : null;
    }
    return { trigger, caught: caught.length, caughtBytes, inert: overBytes.length - caught.length,
      byteShare: totalBytes ? caughtBytes / totalBytes : 0, byLimit };
  });
}

/* ---- Personalized Auto-Tuner (`tokenbrake tune`) --------------------------------------------------------

   Every off-by-default feature ships with a knob and no guidance on when it earns its keep. This reads a
   person's OWN recent sessions and answers that per feature, from two sources kept strictly apart:

     MEASURED   -- the feature actually fired in these sessions (its ledger rows + the backfire audit). Ground
                   truth: fired N times, M pulled back, ~T token-reads saved. A clean measured record with
                   enough firings is the ONLY thing that earns a "turn it on".
     OPPORTUNITY -- the feature is off, so there is nothing to measure; instead estimate how often it WOULD act
                   from the facts parseTranscript keeps (chars, lines, the file, the command). Every estimator
                   below is built to UNDER-count -- a lower bound -- so "worth trying" is never asserted on
                   inflated opportunity, and it earns at most a "try it and measure", never a "turn it on":
                   whether the model comes back for what was withheld is behavioural and costs a session to
                   learn, the same rule the Read-cap trigger has always lived under (AB-TASK.md).

   Pure: parsed sessions + the ledger + the merged config in, a structured recommendation out. cli.js renders
   it. This function only ever reads -- it never writes a config. */

/* The guard.js DEFAULTS the tuner needs -- the guard's own values, not copies: the off-by-default state of each
   feature (so a feature the user has not turned on reads as off) and the thresholds the opportunity estimators
   compare against. cli.js merges the user's tokenbrake.json over this, so a knob the user changed is respected
   and only the rest fall back to the default. */
const TUNE_DEFAULTS = Object.fromEntries(['mcpTrim', 'dedup', 'readAfterEdit', 'reReadElide', 'blobElide', 'gitView', 'shadow',
  'maxChars', 'blobMinChars', 'blobMaxLine', 'dedupMinChars', 'gitViewMinChars', 'readMaxBytes', 'readLimitLines']
  .map((k) => [k, GUARD.DEFAULTS[k]]));

const MIN_FIRE = MIN_WITHHOLDS;   // reuse the audit's confidence floor: below it a clean measured record is "try", not "on"
/* Judgment floors for turning an OPPORTUNITY into a "try it": below both, the feature would act too rarely or
   too cheaply on this person's work to be worth flipping a default and running a measurement session for. Named
   because they are a choice, not a measurement -- a different tolerance would set them elsewhere. */
const OPP_MIN_N = 3;             // it would act at least this many times across the pooled sessions
const OPP_MIN_CARRIED = 2000;    // or withhold at least this many carried token-reads (one big blob can clear this alone)

/* Blob-elider opportunity on a session it did NOT run in: shell results the guard's blob gate WOULD fire on,
   estimated from the two facts parseTranscript keeps (chars, lines), not the body it drops. A blob is one very
   long line that dominates the output. With only chars and lines, the TRUE lower bound is a SINGLE-line result
   (`lines === 1`) over the floor: its one line IS the whole output, so its longest line = chars, which clears
   blobMaxLine (chars >= blobMaxLine via the floor) and is 100% of the output -- so it satisfies the dominance
   share for ANY blobLineShare, and this estimate does not depend on that knob's value (which is why blobLineShare
   is not among the TUNE_DEFAULTS). Deliberately conservative: it skips a two-line result even though a
   blob with a trailing newline is two lines, because chars+lines alone cannot tell that (dominant) case from two
   real long lines (not dominant, which the guard would NOT elide) -- so it never over-counts.

   It also has one big BLIND SPOT worth stating: a blob OVER maxChars has already been char-sliced by the
   always-on trim before blobElide would ever see it, so it arrives multi-line with the trim marker and is not a
   single line here -- exactly the large blobs blobElide helps most are invisible, and their original shape is
   destroyed (not recoverable from the transcript or the ledger). So this sees only the untapped blobs the trim
   left whole (one-liners between the floor and maxChars); a low count is NOT evidence blobElide would not help,
   which is why the tuner never turns a low blob count into a "leave off" (only a measured backfire does that).
   Failed commands are excluded (the guard leaves an error whole). */
function blobOpportunity(parsed, cfg) {
  const floor = Math.max(Number(cfg.blobMinChars) || 4000, Number(cfg.blobMaxLine) || 2000);
  let n = 0, carried = 0;
  for (const r of parsed.results) {
    if (r.name !== 'Bash' && r.name !== 'PowerShell') continue;
    if (r.isError || r.lines !== 1 || r.chars < floor) continue;
    n++; carried += r.carried || 0;
  }
  return { n, carried };
}

/* MCP-trim opportunity: mcp__* results the model received whole and over maxChars, which is exactly what
   mcpTrim would route through the trim. A result already carrying the guard's marker is excluded -- it was
   trimmed, so it is not an untapped opportunity. One BLIND SPOT (like blobOpportunity's): an MCP result Claude
   Code judged too large is persisted by the host and only a ~2KB preview lands in the transcript, so its r.chars
   reads under maxChars and it is missed here -- exactly the oversized MCP results mcpTrim most targets. So a low
   count is not proof mcpTrim would not help; it under-counts (the safe direction), and the real number comes
   from turning mcpTrim on for a session. */
function mcpOpportunity(parsed, cfg) {
  const max = Number(cfg.maxChars) || 6000;
  let n = 0, carried = 0;
  for (const r of parsed.results) {
    if (!/^mcp__/.test(r.name) || r.isError || r.marker || r.chars <= max) continue;
    n++; carried += r.carried || 0;
  }
  return { n, carried };
}

/* Git-view opportunity: an UNTRIMMED `git diff`/`git show` result over gitViewMinChars. This is an UPPER bound,
   unlike the exact-lower-bound estimators -- the guard collapses only the hunks of generated/lockfile paths, and
   with the body dropped this cannot see whether such a path is in the diff. So it counts every large diff and
   the render labels it "up to"; the real number comes from turning gitView on for a session. A result already
   carrying the guard's marker is excluded (as mcpOpportunity does): the always-on trim already char-sliced it,
   so its carried in the transcript is the shrunken value, not the diff's -- counting it would double-count what
   the trim already saved and size it wrong. GIT_CMD is the guard's own GIT_DIFF. */
const GIT_CMD = GUARD.GIT_DIFF;
function gitOpportunity(parsed, cfg) {
  const min = Number(cfg.gitViewMinChars) || 2000;
  let n = 0, carried = 0;
  for (const r of parsed.results) {
    if (r.name !== 'Bash' && r.name !== 'PowerShell') continue;
    if (r.isError || r.marker || r.chars < min || !GIT_CMD.test(String(r.what || ''))) continue;
    n++; carried += r.carried || 0;
  }
  return { n, carried };
}

/* ---- The two thresholds, per person (item 2 of the 2026-09-18 priority set) --------------------------------

   `maxChars` and `readMaxBytes` ship as one value for everyone, and ab10 showed a global A/B cannot resolve a
   global default (identical OFF/OFF arms differed by +-42.6% tokens). What CAN be answered is what each value
   would reach on this person's own sessions, so the tuner prints that as a grid and recommends from it. It only
   RECOMMENDS: lowering a threshold withholds more, the record behind it was measured at the current value, and
   acting on it would be acting on an estimate -- which is what `tune --write` is built never to do. Shadow mode
   is what would measure a lower value for free. */
const MAX_CHARS_STEPS = [2000, 3000, 4000, 6000, 8000, 12000];
/* Shared with `report --reads`, which tune's readMaxBytes line points people to: one list, so the two grids
   show the same rows for the same knob. */
const READ_MAX_STEPS = [10000, 25000, 30000, 45000, 60000];
/* The candidates with the person's own value spliced in, so the grid always has a "you are here" row and the
   step either way is the neighbour of what they actually run. */
const stepsAround = (steps, current) => [...new Set([...steps, current])].filter(Number.isFinite).sort((a, b) => a - b);

/* What each maxChars would put in the trim's reach, over shell results the caller has already sized and
   filtered to the window (successful, under Claude Code's inline ceiling) -- each as `{ chars, reuse }`, where
   a result the guard trimmed carries its ORIGINAL size from the ledger, not the trimmed text the model saw.
   `withheldCarried` is an UPPER bound -- everything past the value, priced across every request it would no
   longer sit in -- because the trim keeps error lines and a tail beyond the budget. maxChars is also the
   trim's budget, so a lower value both reaches more results and cuts harder into the ones it already trims. */
function shellGrid(rows, steps) {
  return steps.map((value) => {
    let n = 0, withheldCarried = 0;
    for (const r of rows) if (r.chars > value) { n++; withheldCarried += Math.round((r.chars - value) / CHARS_PER_TOKEN) * r.reuse; }
    return { value, n, withheldCarried };
  });
}

/* What each readMaxBytes would catch, from the same sized reads `report --reads` grids and under the same
   maxChars floor for shell reads (`capReaches`), with each caught read's withholding at readLimitLines priced
   the same way. A read with no line count, or no result to take its carry from, is caught but not priced. */
function readGrid(reads, steps, cfg) {
  const L = cfg.readLimitLines;
  return steps.map((value) => {
    let n = 0, withheldCarried = 0;
    for (const r of reads) {
      if (!((r.bytes || 0) > value && capReaches(r, cfg.maxChars))) continue;
      n++;
      if (r.lines && r.reuse) withheldCarried += Math.round(r.bytes * Math.max(0, r.lines - L) / r.lines / CHARS_PER_TOKEN) * r.reuse;
    }
    return { value, n, withheldCarried };
  });
}

/* The trim's record AT a maxChars: only withholds of results over it. A pooled record also holds withholds made
   under an older, lower setting -- ones the current value already lets through whole -- and counting those
   would keep re-recommending a raise the person already took, on evidence it already answered. */
function recordAbove(measured, current) {
  if (!measured) return null;
  const rows = measured.rows.filter((w) => w.chars == null || w.chars > current);
  return { fired: rows.length, backfired: rows.filter((w) => w.recovered).length, rows };
}

/* One rule for both knobs, the threshold form of decide(). A clean record with enough firings, where one step
   down would take a material amount more, says try that step -- never further, and never "set it": the step
   down has no record of its own. A measured backfire never earns a step down, and earns a raise only as the
   weighing below allows. Anything else keeps the value. `measured` is null where pull-backs cannot be measured
   at all (the Read cap: a ranged read after a cap is partly what the cap asks for, so it is not evidence of a
   miss). `opts.missing` is a coverage problem no value fixes -- reads went over the cap uncapped in guarded
   sessions -- so it keeps the value whatever the grid says. */
function thresholdAdvice(grid, current, measured, fired, opts) {
  if (opts && opts.missing) return { advice: 'keep', to: null, why: 'missing' };
  if (measured && measured.backfired > 0) {
    /* Weighed on the measured withholds alone, both sides exact: raising to a step lets every withhold at or
       under it through whole, which gives up that withhold's recorded saving and spares its recorded pull-back.
       Recommend the step with the best balance, and only if pulling back cost more than trimming saved -- one
       pull-back among many clean trims is the trim working, not a threshold set too low. */
    let best = null;
    for (const g of grid) {
      if (g.value <= current) continue;
      let fixed = 0, givenUp = 0;
      for (const w of measured.rows) if (w.chars != null && w.chars <= g.value) { fixed += w.pulledFoot; givenUp += w.savedCarried; }
      if (fixed > givenUp && (!best || fixed - givenUp > best.fixed - best.givenUp)) best = { to: g.value, fixed, givenUp };
    }
    if (!best) return { advice: 'keep', to: null, why: 'backfired-outweighed', pulledCost: measured.rows.reduce((t, w) => t + w.pulledFoot, 0) };
    return { advice: 'raise', to: best.to, why: 'backfired', fixed: best.fixed, givenUp: best.givenUp };
  }
  if (fired < MIN_FIRE) return { advice: 'keep', to: null, why: 'few-firings', min: MIN_FIRE };
  const i = grid.findIndex((g) => g.value === current);
  const gain = i > 0 ? grid[i - 1].withheldCarried - grid[i].withheldCarried : 0;
  if (gain >= OPP_MIN_CARRIED) return { advice: 'try', to: grid[i - 1].value, why: measured ? 'clean' : 'unmeasured', gain };
  return { advice: 'keep', to: null, why: 'no-gain' };
}

/* Shadow mode (guard `shadow: true`, on by default): an off-by-default feature still runs its own decision on
   every result and logs ev:'shadow' with what it WOULD have withheld (`chars` -> `kept`), emitting nothing.
   This joins those rows to the transcript by tool_use_id and prices them the way every saving here is priced:
   withheld tokens, and those tokens times every request they would no longer have sat in. Withheld is measured
   against what ENTERED context -- the transcript's own size for the result -- not the row's pre-trim `chars`:
   a shadowed blob or diff over maxChars was still cut by the always-on trim, whose saving is already counted,
   so only what the feature would have taken on top of it is its own. It is the withhold side exactly -- the
   guard's own test on the real output, not an estimate -- and nothing about the backfire side: the model saw
   the output as delivered, so whether it would have come back for the part the feature withholds is not
   something this session can show. Only the features the guard shadows are read, and a row whose result is not
   in this transcript is skipped (it cannot be priced). One row per result and feature, so a doubled install
   does not count twice. */
const SHADOWED = ['blobElide', 'gitView', 'mcpTrim'];
const emptyShadow = () => ({ n: 0, withheld: 0, carried: 0, grew: 0, hostSwapped: 0 });
function shadowRecord(parsed, ledgerRecs) {
  const byId = new Map(parsed.results.filter((r) => r.id).map((r) => [r.id, r]));
  const out = new Map(SHADOWED.map((k) => [k, emptyShadow()]));
  const seen = new Set();
  let ran = false;
  for (const l of ledgerRecs || []) {
    if (!l) continue;
    if (parsed.sessionId && l.session && l.session !== parsed.sessionId) continue;
    if (l.sh) ran = true;   // the guard ran this session with shadow on: a zero below is "saw none", not "never looked"
    if (l.ev !== 'shadow' || !out.has(l.feature) || !l.id) continue;
    const r = byId.get(l.id);
    const key = l.feature + '|' + l.id;
    if (!r || seen.has(key)) continue;
    seen.add(key);
    const e = out.get(l.feature);
    /* A feature can emit MORE than entered: the always-on trim cuts a big diff to maxChars, while a gitView
       collapse keeps every real-source hunk up to the hook cap. That result is evidence against the feature, so
       it is counted apart (`grew`) and never as an opportunity. */
    const tok = Math.round(((r.chars || 0) - (Number(l.kept) || 0)) / CHARS_PER_TOKEN);
    /* Two different reasons the feature's output can be larger than what entered, told apart by the trim marker.
       Marked: the always-on trim cut it, and the feature would have kept more (a gitView collapse keeps every
       real-source hunk) -- real growth, evidence against it. Unmarked and far smaller than what the guard saw:
       the HOST swapped the result for a ~2 KB preview and saved the rest to a file (an oversized MCP result, a
       shell output past the inline ceiling). The feature acts before that swap, so comparing it to the preview
       prices nothing real -- the cost there is the later re-read of the saved file, which the read cap governs.
       Counted apart, never as growth and never as a saving. */
    if (tok <= 0) { if (!r.marker && (Number(l.chars) || 0) > (r.chars || 0)) e.hostSwapped++; else e.grew++; continue; }
    e.n++; e.withheld += tok; e.carried += tok * ((r.carriedTurns || 0) + 1);
  }
  return { ran, ...Object.fromEntries(out) };
}

/* ---- Offline shadow: the three stateful features, replayed over a transcript -----------------------------------

   dedup, reReadElide and readAfterEdit each remember earlier calls in a session, so a live shadow would need its own
   state on disk. Instead this replays the transcript in order, keeps that memory in memory, and asks the guard's
   OWN decision functions (guard.js exports them) at each step -- so it cannot drift from what the guard decides,
   it costs nothing at runtime, and it works on every transcript already on disk, guard installed or not.

   Each feature is simulated alone (as if it were the only one on), and a session where the feature actually ran
   live is skipped for it: its measured record is better than any replay. What the replay cannot see, and how
   each gap is biased:
   - dedup hashes what was DELIVERED, not the original bytes the guard hashes, so a result the trim had already
     cut (it carries the marker) cannot be matched -- skipped, an under-count.
   - reReadElide's "unchanged" is the guard's size+mtime test, which a transcript cannot see. It is replaced by a
     conservative signature: no shell command at all, no edit of the file and no compaction between the two reads.
     A shell command could have changed the file (a formatter, a checkout), so any one disqualifies the pair --
     an under-count by design, because over-counting here would argue for flipping a default. Compaction is
     excluded because after it the model no longer has the first read -- a blind spot of the live guard itself.
   - readAfterEdit takes the edit's ranges from structuredPatch; an edit without one (older Claude Code, or a
     shape change) is counted in `editsNoPatch` so a format change shows as coverage, not as a quiet zero.
   - Like every shadow, nothing here says whether the model would have come back for what was withheld. */
const OFFLINE = ['dedup', 'reReadElide', 'readAfterEdit'];
const OFFLINE_LABEL = { dedup: 'dedup (repeat results)', reReadElide: 'reReadElide (re-reads)', readAfterEdit: 'readAfterEdit (reads after an edit)' };
/* On in a config: the top-level key, or any per-tool entry, as the guard's toolConfig would apply it. */
const isOnIn = (cfg, k) => !!(cfg && (cfg[k] || (cfg.tools && typeof cfg.tools === 'object'
  && Object.values(cfg.tools).some((v) => v && typeof v === 'object' && v[k]))));
const LIVE_ROW = { dedup: (l) => l.dedup === true, reReadElide: (l) => l.ev === 'read-reread', readAfterEdit: (l) => l.ev === 'read-delta' };
function offlineShadow(parsed, ledgerRecs, cfg) {
  const c = { ...GUARD.DEFAULTS, ...(cfg || {}) };
  const sid = parsed.sessionId;
  const out = Object.fromEntries(OFFLINE.map((k) => [k, emptyShadow()]));
  const live = Object.fromEntries(OFFLINE.map((k) => [k, false]));
  /* A read the guard itself capped or narrowed in this session is the guard's, not a candidate: some transcripts
     record the model's ORIGINAL unbounded input for it, so it looks like a small whole read of the cap's first
     300 lines -- the trap unboundedReads documents. Any read of such a file is left out (an under-count), and a
     whole read the guard logged gets its true size from the ledger, not from the delivered text. */
  const guarded = new Set();
  for (const l of ledgerRecs || []) {
    if (!l || (sid && l.session !== sid)) continue;
    for (const k of OFFLINE) if (LIVE_ROW[k](l)) live[k] = true;
    if ((l.ev === 'read-cap' || l.ev === 'read-delta' || l.ev === 'read-reread') && l.what) guarded.add(normReadPath(l.what));
  }
  const trueSize = wholeReadIndex(ledgerRecs || [], sid).byFile;
  const credit = (k, r, tok) => {
    if (tok <= 0) return;
    const e = out[k]; e.n++; e.withheld += tok; e.carried += tok * ((r.carriedTurns || 0) + 1);
  };
  const shell = (r) => r.name === 'Bash' || r.name === 'PowerShell';
  const noteTok = (s) => Math.round(s.length / CHARS_PER_TOKEN);
  const compactionsBy = (req) => parsed.compactions.filter((x) => x <= req).length;
  const seen = new Set();                       // dedup: hashes delivered so far
  const reads = [];                             // reReadElide: the guard's own record shape, in order
  const edits = new Map();                      // readAfterEdit: file -> [{ ranges, t }]
  const fileGen = new Map();
  let shellGen = 0, editsTotal = 0, editsNoPatch = 0;
  parsed.results.forEach((r, i) => {
    const key = r.file ? normReadPath(r.file, parsed.cwd) : null;
    if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(r.name) && key && !r.isError) {
      fileGen.set(key, (fileGen.get(key) || 0) + 1);
      if (r.name === 'Edit' || r.name === 'MultiEdit') {
        editsTotal++;
        if (r.patch && r.patch.length) { if (!edits.has(key)) edits.set(key, []); edits.get(key).push({ ranges: r.patch, t: i }); } else editsNoPatch++;
      }
    }
    /* dedup: a shell or MCP result over the floor, delivered whole (no marker), not protected by noTrim -- the
       guard's own noTrimmed, on the raw command for a shell result and the tool name for an MCP one */
    const mcpR = /^mcp__/.test(r.name);
    const tc = GUARD.toolConfig(c, r.name);   // per-tool settings, merged the way the guard merges them per call
    if (!live.dedup && (shell(r) || mcpR) && !r.isError && !r.marker && r.hash && r.chars >= tc.dedupMinChars
      && !GUARD.noTrimmed(tc, mcpR ? r.name : (r.cmd || r.what), mcpR)) {
      if (seen.has(r.hash)) credit('dedup', r, Math.round((r.chars - GUARD.dedupPointer({ chars: r.chars, id: 'x'.repeat(19) }).length) / CHARS_PER_TOKEN));
      else seen.add(r.hash);
    }
    if (shell(r)) shellGen++;
    /* the two Read narrowings: a whole, successful Read of line 1 on, the guard would have let through (not
       noTrim, not one it capped or narrowed, under the trigger, not a persisted output, not alwaysCap) */
    if (r.name !== 'Read' || !r.whole || r.isError || !key || guarded.has(key)) return;
    if (r.shape && r.shape.numbered && r.shape.from !== 1) return;
    if (GUARD.matchesAny(tc.noTrim, r.file) || GUARD.matchesAny(tc.alwaysCap, r.file) || PERSISTED.test(r.file)) return;
    const logged = trueSize.get(key);
    const bytes = (logged && logged.bytes) || (r.shape && r.shape.bytes) || r.chars;
    const nLines = (logged && logged.lines) || (r.shape && r.shape.lines) || r.lines;
    if (!nLines || bytes > tc.readMaxBytes) return;
    const base = path.basename(String(r.file));
    if (!live.readAfterEdit) {
      const w = GUARD.editWindow(edits.get(key), nLines, tc);
      if (w) credit('readAfterEdit', r, Math.round(r.tokens * (1 - w.limit / nLines)) - noteTok(GUARD.deltaNote(base, w.from, w.to, nLines)));
    }
    if (!live.reReadElide) {
      const sig = shellGen + ':' + (fileGen.get(key) || 0) + ':' + compactionsBy(r.afterReq);
      if (GUARD.reReadDecision(GUARD.priorReadIn(reads, key), sig, 0, nLines, tc)) credit('reReadElide', r, Math.round(r.tokens * (1 - tc.reReadKeepLines / nLines)) - noteTok(GUARD.reReadNote(base, tc.reReadKeepLines, nLines)));
      else reads.push({ file: key, size: sig, mtime: 0 });   // an elided read is not recorded, as in the guard
    }
  });
  return { ...out, live, editsTotal, editsNoPatch };
}

/* The knob sweep (`tune --sweep`): the offline replay re-run at several values of each stateful feature's knobs, so a
   person sees the curve on their own sessions instead of one number at one setting. Data only: no recommendation, and
   nothing written. Each knob is swept alone with every other setting as configured; the person's own value is always
   one of the rows. Sessions where the feature ran live are left out by the replay itself (its record is measured). */
const SWEEP_KNOBS = [
  { feature: 'dedup', knob: 'dedupMinChars', steps: [250, 500, 1000, 2000, 4000] },
  { feature: 'reReadElide', knob: 'reReadRecency', steps: [2, 4, 8, 16, 32] },
  { feature: 'reReadElide', knob: 'reReadKeepLines', steps: [1, 5, 20, 50] },
  { feature: 'readAfterEdit', knob: 'editContextLines', steps: [0, 5, 10, 20, 40] },
];
function sweepOffline(parsedSessions, ledgerRecs, cfg) {
  const base = { ...GUARD.DEFAULTS, ...(cfg || {}) };
  const sessions = (parsedSessions || []).filter(Boolean);
  for (const p of sessions) carry(p);
  const tools = base.tools && typeof base.tools === 'object' ? base.tools : {};
  return SWEEP_KNOBS.map(({ feature, knob, steps }) => {
    const raw = base[knob];
    const current = typeof raw === 'number' ? raw : NaN;   // a non-number is named by the caller, never coerced into a row
    /* A per-tool entry that sets this knob would override the swept top-level value (the guard merges it per call),
       so the swept value goes into those entries too -- and they are returned, so the view can name them. */
    const scoped = Object.entries(tools).filter(([, v]) => v && typeof v === 'object' && knob in v).map(([tool, v]) => ({ tool, value: v[knob] }));
    const rows = stepsAround(steps, current).map((value) => {
      const c = { ...base, [knob]: value,
        tools: Object.fromEntries(Object.entries(tools).map(([tool, v]) => [tool, v && typeof v === 'object' && knob in v ? { ...v, [knob]: value } : v])) };
      let n = 0, withheld = 0, carried = 0, replayed = 0;
      for (const p of sessions) {
        const os = offlineShadow(p, ledgerRecs, c);
        if (os.live[feature]) continue;
        replayed++; n += os[feature].n; withheld += os[feature].withheld; carried += os[feature].carried;
      }
      return { value, n, withheld, carried, replayed };
    });
    return { feature, knob, current, raw, scoped, rows };
  });
}

/* `opts.disabled` is the set of knobs written `false` in the raw tokenbrake.json. It cannot be derived from
   `cfg`: the caller hands us TUNE_DEFAULTS merged with the file, and every feature knob defaults to false
   there, so "absent" and "deliberately off" are the same value by the time it arrives. Only the raw file
   distinguishes them, so the caller reads it and passes the distinction in. */
function autotune(parsedSessions, ledger, cfg, opts) {
  cfg = cfg || {};
  const led = ledger || [];
  const sessions = (parsedSessions || []).filter(Boolean);

  const kind = {};   // measured, per withhold kind: fired / backfired / savedCarried
  /* `rows` keeps each withhold's original size, saving and pull-back cost, so a threshold can be weighed on
     exactly the withholds a different value would have let through whole. */
  const bump = (k, w) => { const e = kind[k] || (kind[k] = { fired: 0, backfired: 0, savedCarried: 0, rows: [] });
    e.fired++; if (w.recovered) e.backfired++; e.savedCarried += w.savedCarried || 0; e.rows.push(w); };
  let deltaFired = 0, deltaBack = 0, reReadFired = 0, reReadBack = 0, netCarried = 0, withholds = 0;

  const shadowed = Object.fromEntries(SHADOWED.map((k) => [k, emptyShadow()]));
  const offline = Object.fromEntries(OFFLINE.map((k) => [k, { n: 0, withheld: 0, carried: 0, sessions: 0 }]));
  let editsTotal = 0, editsNoPatch = 0;
  let shadowSessions = 0;
  const blob = { n: 0, carried: 0 }, mcp = { n: 0, carried: 0 }, gitOpp = { n: 0, carried: 0 };
  const reachSessions = [];
  const sizedReads = [], shellRows = [];   // the two threshold grids' populations, pooled
  const noTrim = Array.isArray(cfg.noTrim) ? cfg.noTrim.filter((x) => !String(x).startsWith('mcp__')) : [];
  let carriedTotal = 0;
  let capOver = 0, capFired = 0, guarded = 0, sawLedger = false;
  /* Respect an explicit readMaxBytes including 0 (which the guard takes literally as "cap everything"); only a
     genuinely absent value falls back to the shipped default. */
  const readMaxBytes = cfg.readMaxBytes == null ? TUNE_DEFAULTS.readMaxBytes : Number(cfg.readMaxBytes);

  for (const p of sessions) {
    /* Self-protect: a transcript parsed with no sessionId of its own would make every ledger join below skip its
       session filter and attribute ALL sessions' rows to this one. The transcript filename is the session id, so
       recover it here -- so any caller, not just tuneReport, is safe. carry(p) already mutates p, so this does too. */
    if (!p.sessionId && p.file) p.sessionId = path.basename(String(p.file), '.jsonl');
    carry(p);
    const g = guardRan(p, led, p.sessionId);
    if (g.ran) guarded++;

    const a = backfireAudit(p, led);
    for (const w of a.withholds) bump(w.kind, w);
    deltaFired += a.deltas.fired; deltaBack += a.deltas.backfired;
    reReadFired += a.reReads.fired; reReadBack += a.reReads.backfired;
    netCarried += a.net; withholds += a.withholds.length;

    const sr = shadowRecord(p, led);
    const os = offlineShadow(p, led, cfg);
    editsTotal += os.editsTotal; editsNoPatch += os.editsNoPatch;
    for (const k of OFFLINE) if (!os.live[k]) { offline[k].sessions++; for (const f of ['n', 'withheld', 'carried']) offline[k][f] += os[k][f]; }
    if (sr.ran) {
      shadowSessions++;
      for (const k of SHADOWED) for (const f of Object.keys(emptyShadow())) shadowed[k][f] += sr[k][f];
    }
    if (!sr.ran) {
      const bo = blobOpportunity(p, cfg); blob.n += bo.n; blob.carried += bo.carried;
      const mo = mcpOpportunity(p, cfg); mcp.n += mo.n; mcp.carried += mo.carried;
    }
    if (!sr.ran) { const go = gitOpportunity(p, cfg); gitOpp.n += go.n; gitOpp.carried += go.carried; }

    const u = unboundedReads(p, led, { sessionId: p.sessionId, readMaxBytes });
    capFired += u.capped;
    for (const rd of u.reads) if (!rd.ceiling) sizedReads.push(rd);   // a read at a ceiling is sized by what came back, not the file
    /* A result the guard trimmed is in the transcript at its trimmed size; the ledger has what it was. Sizing it
       by the transcript would drop every result the trim fired on out of the maxChars grid. */
    const offered = offeredOf(p, led);
    for (const r of p.results) {
      carriedTotal += (r.tokens || 0) + (r.carried || 0);   // entry + carry, the basis every withheld figure uses
      if (!isShell(r) || r.isError) continue;
      /* The trim never sees these whatever maxChars is: a single-file excerpt goes down the guard's read path,
         and a noTrim command is returned on first. noTrim is matched against the whitespace-normalised
         command, so it is as close as the transcript allows. */
      if (r.excerpt || noTrim.some((x) => x && String(r.what || '').includes(String(x)))) continue;
      const l = r.marker ? offered(r) : null;
      const chars = l && Number(l.chars) ? Number(l.chars) : r.chars;
      if (chars < HOST_CEILING) shellRows.push({ chars, reuse: (r.carriedTurns || 0) + 1 });
    }
    /* Only a GUARDED session's uncapped over-threshold read is a "missing" signal: in an unguarded session
       (teleported, or read before install) the read went whole because the guard was not there, not because the
       cap failed -- counting it would manufacture a phantom config defect. So gate per-session, not on the
       global guarded count.
       Specifically on LEDGER evidence, which is what report --reads buckets on (ledgerSessions, cli.js) -- the
       parity this comment used to claim while gating on g.ran, which also accepts a transcript MARKER. A marker
       proves the PostToolUse hook ran; it says nothing about whether the PreToolUse read hook was ever
       registered, and the two are separate entries in settings.json. So a marker-only session (ledger rotated
       or deleted) cannot tell "the read-pre hook is missing" from "the evidence is missing", and reporting the
       first is the phantom defect this gate exists to prevent. */
    if (g.via === 'ledger') { sawLedger = true; capOver += u.over; }
    // reachPooled only uses the guarded sessions (filtered below), so skip the trimmedResults scan for the rest
    reachSessions.push({ parsed: p, trimmed: g.ran ? trimmedResults(p, led) : null, ran: g.ran });
  }

  /* A knob can be set per TOOL as well as globally: guard.js toolConfig() shallow-merges cfg.tools[<tool>]
     over every knob, for the post hook and the read hook alike. Reading only the top level called a
     Bash-only elider "off", credited it with the measured record its own Bash firings produced, and told
     --write to write a TOP-LEVEL true -- widening a deliberately tool-scoped setting to every tool on one
     tool's evidence. The mirror case (a tools entry turning a globally-on knob off) printed [on] for a
     feature disabled where it actually runs. `scoped` carries the fact that a knob is tool-scoped at all, so
     --write can decline to flatten it rather than guess which tool the person meant. */
  const plainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const toolCfgs = plainObj(cfg.tools) ? Object.values(cfg.tools) : [];
  const entriesFor = (k) => toolCfgs.filter((v) => plainObj(v) && k in v);
  const on = (k) => !!cfg[k] || entriesFor(k).some((v) => !!v[k]);
  const scoped = (k) => entriesFor(k).length > 0;
  const measuredOf = (k) => kind[k] || null;   // bump builds each kind as {fired, backfired, savedCarried, rows}
  /* The read narrowings measure fired/backfired only (no out/ save, so no savedCarried); carry that shape. */
  const readMeasured = (fired, back) => fired > 0 ? { fired, backfired: back, savedCarried: null } : null;

  /* One decision, applied to every feature. Measured beats opportunity: a feature that fired is judged on what
     happened, never on an estimate. A measured backfire is disqualifying whatever the count (ab10: the count of
     withholds does not predict the saving, so one real pull-back is evidence) -- and it is the ONLY thing that
     earns a definitive "leave off". A clean measured record earns "turn it on" only past the confidence floor;
     below it, "try". With no firings, material opportunity earns at most a "try" (never a "turn it on":
     backfire is behavioural and must be measured), and NO material opportunity earns "measure" -- not "leave
     off", because the off-state estimators have blind spots (blobElide's biggest wins in particular are
     invisible off-state: the always-on trim char-slices a large blob before blobElide would ever see it), so
     the honest verdict is "no signal from the off state, turn it on for a session and measure". */
  const decide = (isOn, measured, opp) => {
    if (measured && measured.fired > 0) {
      if (measured.backfired > 0) return isOn ? 'review' : 'leave-off';
      if (measured.fired >= MIN_FIRE) return isOn ? 'keep' : 'turn-on';
      return isOn ? 'keep' : 'try';   // clean but too few to be sure: keep it if already on, else worth a try
    }
    if (opp && (opp.n >= OPP_MIN_N || (opp.carried || 0) >= OPP_MIN_CARRIED)) return isOn ? 'keep' : 'try';
    /* The shadow ran and the feature would have acted on nothing: not "no signal, measure it" but a measured
       none -- on this work there is nothing for it to do. */
    if (opp && opp.shadowSessions && !opp.n) return isOn ? 'keep' : 'idle';
    return isOn ? 'keep' : 'measure';
  };
  /* `bound` is the honesty of the opportunity estimate, decided HERE where the estimator lives rather than
     re-derived from the feature key in the renderer: 'upper' for the over-counting estimator (gitOpportunity,
     shown as "up to N"), 'near' for the lower-bound ones (blobOpportunity, mcpOpportunity, shown as "~ N"),
     'shadow'/'mixed' for the guard's live shadow rows, and 'offline' for the transcript replay of the three
     stateful features (offlineShadow). */
  const disabledKnobs = new Set((opts && opts.disabled) || []);
  const feat = (key, label, knob, measured, opp, bound) => {
    const isOn = on(knob), isScoped = scoped(knob), isDisabled = disabledKnobs.has(knob);
    const status = decide(isOn, measured, opp);
    /* `on`/`scoped`/`disabled` stay as the raw facts -- each is something only one source knows, and all three
       combinations occur ({blobElide:false, tools:{Bash:{blobElide:true}}} is disabled AND scoped AND on).
       `offer` is the one POLICY built from them, decided here beside decide() rather than re-derived by each
       caller: --write, the per-feature render and the summary were each combining the three booleans in a
       different precedence order, so "does a tools entry beat a top-level false?" had three answers.
       The status is left alone -- it is the truth about what the feature DID, and a knob the person turned
       off still has the clean measured record that earned its turn-on. Only the OFFER changes. */
    const offer = status !== 'turn-on' ? null : isScoped ? 'scoped' : isDisabled ? 'user-off' : 'turn-on';
    /* `offer` is the --write policy and is null off a turn-on, so the preview cannot lean on it to explain a
       config-governed knob at 'try'/'measure' -- it would print "Set knob: true" for a feature the person set
       false. `note` is the DISPLAY classification, computed at ANY status once here so the renderer never
       re-combines the raw booleans, and it turns on the ONE fact the [off] mark must follow: whether the
       feature is actually running. `running` is on but only because a `tools` entry provides the on (the
       top-level key is not true) -- it must read as on, never [off], whether that key is absent or explicitly
       false. `scoped` and `user-off` are the two ways a feature is OFF by config: a `tools` entry pins it off,
       or the top-level key is false. A knob on via its own top-level key -- with or without a per-tool
       exception -- is plain on, so it is null and renders from status like any other on feature. */
    const topOn = !!cfg[knob];
    const note = (isOn && !topOn) ? 'running' : (!isOn && isScoped) ? 'scoped' : (!isOn && isDisabled) ? 'user-off' : null;
    return { key, label, knob, on: isOn, scoped: isScoped, disabled: isDisabled, offer, note,
      bound, measured, opportunity: opp || null, status };
  };

  /* A feature the shadow saw fire is judged on that, not on the off-state estimator: the same decision (still only
     an opportunity -- the backfire side is unmeasured -- so at most a "try"), exact instead of estimated. */
  /* Chosen per SESSION above: a session the shadow ran in contributes its exact record (zero included -- "saw
     none" is an answer), one it did not contributes the estimate. The bound says which the total is made of. */
  /* The offline replay of a stateful feature, over the sessions it did not run live in. `shadowSessions` carries the
     session count so decide() reads a replay that saw nothing as "idle", the same as a live shadow that saw none. */
  const replayed = (k) => [{ n: offline[k].n, withheld: offline[k].withheld, carried: offline[k].carried, shadowSessions: offline[k].sessions }, 'offline'];
  const offOrShadow = (k, estimate, bound) => {
    if (!shadowSessions) return [estimate, bound];
    const s = shadowed[k];
    return [{ n: s.n + estimate.n, carried: s.carried + estimate.carried, withheld: s.withheld, grew: s.grew, hostSwapped: s.hostSwapped,
      shadowN: s.n, estimateN: estimate.n, shadowSessions, estimateBound: bound }, estimate.n ? 'mixed' : 'shadow'];
  };
  const features = [
    feat('blobElide', 'Binary-Blob Elider', 'blobElide', measuredOf('blob'), ...offOrShadow('blobElide', blob, 'near')),
    feat('gitView', 'Change-Aware Git View', 'gitView', measuredOf('gitview'), ...offOrShadow('gitView', gitOpp, 'upper')),
    feat('mcpTrim', 'MCP output trim', 'mcpTrim', measuredOf('mcp'), ...offOrShadow('mcpTrim', mcp, 'near')),
    feat('dedup', 'Duplicate-result pointer', 'dedup', measuredOf('dedup'), ...replayed('dedup')),
    feat('reReadElide', 'Read-After-Read elision', 'reReadElide', readMeasured(reReadFired, reReadBack), ...replayed('reReadElide')),
    feat('readAfterEdit', 'Read-After-Edit delta', 'readAfterEdit', readMeasured(deltaFired, deltaBack), ...replayed('readAfterEdit')),
  ];

  /* The Read cap is always on and has its own tuning views (report --reads/--where); the tuner only reads its
     HEALTH here. dormant: no read reached readMaxBytes, so the cap has nothing to act on. firing: it capped
     reads. missing: reads went over readMaxBytes uncapped in a session the guard was running -- the cap had its
     chance and did not take it (a config or coverage problem worth flagging). capOver already counts only
     guarded sessions (see the loop), so it alone carries the "guard was present" condition.
     unmeasured comes FIRST because the other three are all statements about a guard that ran. With no guarded
     session in the pool -- a fresh install, or --cwd onto a project where the guard was never installed --
     capOver is 0 by its own gate and capFired is 0 because no cap could fire, so the fall-through would report
     "dormant: no read reached readMaxBytes", asserting a measurement nothing performed and pointing the person
     away from the install that would actually help. */
  /* `unmeasured` covers both ways the cap can be un-judged, not just one. capOver is now gated on ledger
     evidence, and capFired is structurally 0 without it too (unboundedReads marks a read capped only from a
     ledger row), so a guarded session known ONLY by a transcript marker reaches neither counter -- and used
     to fall through to "dormant: no read reached readMaxBytes", a flat statement about reads it never
     examined, in a session that may hold five uncapped 100 KB whole-file reads. Both cases are the same
     thing: nothing measured the cap here. */
  const capVerdict = !sawLedger ? 'unmeasured' : capOver > 0 ? 'missing' : capFired > 0 ? 'firing' : 'dormant';
  /* Two different situations reach `unmeasured` and they want opposite advice, so the cause travels with the
     verdict: nothing ran the guard (install it), versus sessions that did but whose ledger evidence is gone
     (installing again changes nothing). Without this the one string had to assert "no pooled session ran the
     guard", which flatly contradicts the "N with the guard" the header prints from the marker-inclusive
     count. */
  const readCap = { readMaxBytes, over: capOver, fired: capFired, verdict: capVerdict,
    why: capVerdict !== 'unmeasured' ? null : (guarded === 0 ? 'no-guard' : 'no-ledger') };

  const maxChars = cfg.maxChars == null ? TUNE_DEFAULTS.maxChars : Number(cfg.maxChars);
  const readLimitLines = Number(cfg.readLimitLines) || TUNE_DEFAULTS.readLimitLines;
  const trimRec = recordAbove(measuredOf('trim'), maxChars), trimFired = trimRec ? trimRec.fired : 0;
  const sg = shellGrid(shellRows, stepsAround(MAX_CHARS_STEPS, maxChars));
  const rg = readGrid(sizedReads, stepsAround(READ_MAX_STEPS, readMaxBytes), { maxChars, readLimitLines });
  const thresholds = { carriedTotal,
    maxChars: { current: maxChars, grid: sg, measured: trimRec, fired: trimFired,
      ...thresholdAdvice(sg, maxChars, trimRec, trimFired) },
    readMaxBytes: { current: readMaxBytes, grid: rg, measured: null, fired: capFired,
      ...thresholdAdvice(rg, readMaxBytes, null, capFired, { missing: capVerdict === 'missing' }) },
  };

  const summary = { turnOn: [], tryThese: [], review: [], leaveOff: [], measure: [], keep: [], excluded: [], idle: [] };
  for (const f of features) {
    /* The summary is the line people act on, so a config-off feature (off, and either scoped to a tool or set
       false -- read from `note`) contributes to it ONLY from a genuine turn-on: a clean measured record whose
       flip the config overrides, where "Would turn on, but your config says otherwise" is exactly true. At
       'try'/'measure' that claim would overstate (few or no measured evidence, and --write sets neither), and
       filing it under "Try:"/"Measure:" would recommend flipping a knob the person set off -- so those are left
       to the per-feature [off] line alone. A measured backfire on an off knob still reads as leave-off, and
       'review' needs the feature on, which a config-off knob is not. `running` is on where its `tools` entry
       applies and is never config-off. This is why the divert reads `note`, not `offer`: `offer` is null off a
       turn-on, so it had left a config-off knob at 'try'/'measure' under "Try:"/"Measure:". */
    const configOff = f.note === 'scoped' || f.note === 'user-off';
    if (configOff && (f.status === 'try' || f.status === 'measure')) continue;   // off by config, weak/no evidence: detail line only
    if (configOff && f.status === 'turn-on') summary.excluded.push(f.label);
    else if (f.status === 'turn-on') summary.turnOn.push(f.label);
    else if (f.status === 'try') summary.tryThese.push(f.label);
    else if (f.status === 'review') summary.review.push(f.label);
    else if (f.status === 'measure') summary.measure.push(f.label);
    else if (f.status === 'idle') summary.idle.push(f.label);
    else if (f.status === 'keep') summary.keep.push(f.label);
    else summary.leaveOff.push(f.label);
  }

  /* `withholds` counts only what backfireAudit nets, which is built from ev:'post' ledger rows -- the trim
     and its siblings, which replace an output and save a copy. The two READ narrowings log ev:'read-delta' and
     ev:'read-reread' and never appear there, so a session in which only they fired has withholds === 0 while
     the feature list below reports "fired 3x". Carried separately so the caller can tell "nothing has fired"
     from "something fired that this net cannot price". */
  return { sessions: sessions.length, guarded,
    reach: reachPooled(reachSessions.filter((s) => s.ran)),
    netCarried, withholds, narrowings: reReadFired + deltaFired, features, readCap, thresholds, summary,
    shadowOn: cfg.shadow !== false, editsTotal, editsNoPatch,
    thin: guarded < MIN_FIRE };   // a note, not a gate: a handful of sessions is a weak base for a recommendation
}

/* Find transcripts. The ledger's `transcript` field (0.1.0) is exact; failing that, every JSONL under
   <config>/projects/<encoded cwd>/, newest first. Subagent transcripts sit in a sibling directory named
   after the session and are not sessions of their own. */
function findTranscripts(cfgDir) {
  const root = path.join(cfgDir, 'projects');
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    const p = path.join(root, d);
    let files = [];
    try { files = fs.readdirSync(p); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(p, f);
      try { const st = fs.statSync(full); if (st.isFile()) out.push({ file: full, mtime: st.mtimeMs, size: st.size, session: f.slice(0, -6), project: d }); } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const fmt = (n) => Math.round(n).toLocaleString('en-US');
const pfmt = (n) => n >= 10 ? String(Math.round(n)) : n >= 1 ? n.toFixed(1) : n >= 0.005 ? n.toFixed(2) : '< 0.01';
const kfmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(Math.round(n));

/* The report, as lines. Pure: takes parsed data, returns text, so the test can read it without a
   console. `top` is how many results to name. */
function renderReport(parsed, ledger, { top = 10, readLimitLines = 300, maxChars: maxCharsOpt, toolMaxChars, userCfg } = {}) {
  const maxChars = limitOf(maxCharsOpt, toolMaxChars);
  const baseChars = limitOf(maxCharsOpt);   // the top-level value, for the one line that names a number
  /* Whether the guard was here at all decides what every "the guard did / did not" line below means. With it,
     "trimmed none" and "0 acted on" are facts about the guard; without it they read as its failure, when it was
     never installed -- and for the person running `report` before installing anything, the question is the
     other one: is there anything here for the brake to act on? */
  const ran = guardRan(parsed, ledger, parsed.sessionId).ran;
  carry(parsed);
  const u = usageTotals(parsed);
  const draw = limitDraw(parsed);
  const lines = [];
  const sid = String(parsed.sessionId || path.basename(parsed.file, '.jsonl'));
  lines.push(`Session ${sid.slice(0, 8)}...  ${parsed.cwd || ''}`);
  lines.push(`  ${fmt(parsed.requests.length)} requests, ${fmt(parsed.results.length)} tool results`
    + (parsed.compactions.length ? `, ${parsed.compactions.length} compaction(s)` : ''));
  if (u.requestsWithUsage) {
    const pct = u.processed ? Math.round(100 * u.cacheRead / u.processed) : 0;
    lines.push(`  Context processed: ${kfmt(u.processed)} tokens across ${fmt(u.requestsWithUsage)} requests (${pct}% read from cache); output ${kfmt(u.out)}`);
    lines.push(`  Context now: ~ ${kfmt(u.contextNow)} tokens -- what the next request re-reads`
      + (calibrated(u.lastModel) ? `, ~ ${pfmt(u.contextNow * LIMIT_WEIGHTS.read / 1e6)} points of the five-hour window each time` : ''));
    /* The same usage in the unit the limit is spent in (AB-TASK.md, "Calibration results"): a cache write weighs
       ~45 cache reads, and output ~170, so the token count above hides where the window actually went. */
    if (draw.priced) {
      lines.push(`  Five-hour window: ~ ${pfmt(draw.read + draw.write + draw.output)} points drawn -- cache reads ${pfmt(draw.read)}, writes ${pfmt(draw.write)}, output ${pfmt(draw.output)}`
        + ` (weights calibrated on Opus 5${draw.unpriced ? `; ${fmt(draw.unpriced)} requests on other models not priced` : ''})`);
    }
  }
  const entered = parsed.results.reduce((s, r) => s + r.tokens, 0);
  const carried = parsed.results.reduce((s, r) => s + r.carried, 0);
  lines.push(`  Tool results entered ~ ${kfmt(entered)} tokens of context, carried through later requests ~ ${kfmt(carried)} token-reads`);

  const idx = ledgerIndex(ledger, parsed.sessionId);
  /* A ledger row says the guard offered a replacement. Only the transcript says whether the model saw it:
     above Claude Code's own ~30,000-character ceiling the hook gets a truncated copy and the model gets a
     2 KB persisted-output preview, and on PostToolUseFailure the replacement is ignored outright. Credit
     goes only to results whose text carries the guard's marker; the rest are reported as offered and not
     applied, never as savings. Found on the first Windows run (AB-TASK.md). */
  const offeredOf = (r) => idx.byId.get(r.id) || idx.byWhat.get(r.name + '|' + r.what.slice(0, 120));
  const trimmedOf = (r) => (r.marker ? offeredOf(r) : null);
  const trimmed = parsed.results.filter(trimmedOf);
  const ignored = parsed.results.filter(r => offeredOf(r) && !r.marker);
  const sv = trimSavings(parsed, ledger);
  if (trimmed.length) {
    const svPts = sv.count > sv.unpriced
      ? `, ~ ${pfmt(sv.pts)} points of the five-hour window${sv.unpriced ? ` (${sv.unpriced} on other models not priced)` : ''}` : '';
    lines.push(`  tokenbrake trimmed ${trimmed.length} of them: ~ ${kfmt(sv.saved)} tokens kept out, ~ ${kfmt(sv.savedCarried)} token-reads not carried${svPts}`);
  } else if (ran) {
    lines.push(`  tokenbrake trimmed none of them (ledger has ${ledger.length} rows for other sessions or small results)`);
  }
  if (ignored.length) {
    const entered = ignored.reduce((s, r) => s + r.tokens, 0);
    lines.push(`  ${ignored.length} trim${ignored.length === 1 ? '' : 's'} offered and not applied (over Claude Code's own ceiling, or a failing command): ~ ${kfmt(entered)} tokens entered as Claude Code delivered them`);
  }

  /* A capped Read never carries the guard's marker -- it is an ordinary short read -- so it cannot appear on
     the trim line, and until now nothing in the report said the Read cap had fired at all. Split by which
     half fired, because they are separate features sharing a hook and their evidence differs. */
  const caps = readCaps(ledger, parsed.sessionId);
  if (caps.n) {
    const parts = [];
    if (caps.source) parts.push(`${caps.source} on a large source file`);
    if (caps.persisted) parts.push(`${caps.persisted} on a persisted output`);
    lines.push(`  Read caps fired: ${caps.n} (${parts.join(', ')}), on ~ ${kfmt(Math.round(caps.bytes / CHARS_PER_TOKEN))} tokens of file`);
  } else if (ran) {
    lines.push(`  Read caps fired: none`);
  }

  /* What the trim does not touch: shell results under the threshold. Small excerpts carried through a long
     session were 79% of one real audit session's carried context (LANDSCAPE.md); this line says what they
     are here, so a week of real sessions can say whether shape filters for small output are worth building. */
  const small = smallResults(parsed, maxChars);
  if (small.shell) {
    lines.push(`  Small shell output, at or under the threshold (excerpts and failures included): ${small.n} of ${small.shell} shell results (~ ${kfmt(small.tokens)} tokens entered, ~ ${kfmt(small.carried)} token-reads carried, ${carried ? Math.round(100 * small.carried / carried) : 0}% of all carried)`);
  }
  /* The denominator. Everything above says what the guard did; this says what it could ever have done,
     which on most sessions is the more useful number and is usually smaller than anyone expects. */
  const rc = reach(parsed, trimmed, { maxChars });
  const pct = (x) => (carried ? Math.round(100 * x / carried) : 0);
  if (rc.total.n) {
    lines.push(`  Within the guard's reach: ${rc.window.n} of ${rc.total.n} tool results (~ ${kfmt(rc.window.tokens)} tokens entered, ~ ${kfmt(rc.window.carried)} carried, ${pct(rc.window.carried)}% of all carried) -- shell, exit 0, over ${kfmt(baseChars / CHARS_PER_TOKEN)} tokens${typeof maxChars === 'function' ? ' (or your per-tool maxChars)' : ''} and under Claude Code's own ceiling`);
    const oor = [];
    if (rc.under.n) oor.push(`${rc.under.n} under the threshold`);
    if (rc.excerpt.n) oor.push(`${rc.excerpt.n} single-file excerpts (read like a Read: capped over readMaxBytes, never head/tail-trimmed)`);
    if (rc.nonShell.n) oor.push(`${rc.nonShell.n} not shell results`);
    if (rc.failed.n) oor.push(`${rc.failed.n} failed (the host ignores the replacement)`);
    if (rc.persisted.n) oor.push(`${rc.persisted.n} past the host's ceiling (persisted, replacement never applied)`);
    if (oor.length) lines.push(`  Out of reach: ${oor.join('; ')} -- ~ ${kfmt(rc.total.carried - rc.window.carried)} carried, ${pct(rc.total.carried - rc.window.carried)}% of all carried`);
    if (!ran) {
      lines.push(pct(rc.window.carried) >= BRAKE_WORTH_PCT
        ? `  No sign of tokenbrake in this session (no ledger row, no trim marker). The brake could have acted on ${rc.window.n} result${rc.window.n === 1 ? '' : 's'}, ${pct(rc.window.carried)}% of what it carried -- if it is not installed, \`npx tokenbrake init\` installs it.`
        : `  No sign of tokenbrake in this session (no ledger row, no trim marker), and ${pct(rc.window.carried)}% of what it carried is in the brake's reach -- too little to install it for work like this.`);
    } else lines.push(`  Acted on: ${trimmed.length} of those${rc.window.n ? ` -- ${Math.round(100 * trimmed.length / rc.window.n)}% of what it could reach` : ''}`);
    /* What is left on the table, in token-reads. The share of *carried* is the honest weight: ab10 found the
       count of trims does not predict the saving -- two trims beat seven -- because which result is cut,
       and how early, decides how many later requests re-read it. */
    if (ran && rc.untouched.n) {
      lines.push(`  Still within reach: ${rc.untouched.n} result${rc.untouched.n === 1 ? '' : 's'} the guard could have trimmed and did not (~ ${kfmt(rc.untouched.carried)} carried)`);
    }
  }

  /* The guard's own cost, reported next to its saving and never omitted when the saving is shown. */
  const rec = recoveryReads(parsed);
  if (rec.n) {
    lines.push(`  Recovery reads: ${rec.n} -- the model came back for more of a file it had already read (~ ${kfmt(rec.tokens)} tokens re-entered, ~ ${kfmt(rec.carried)} carried)`
      + (trimmed.length ? ` -- some of these are what the trim sent it back for` : ''));
  }

  /* The offline replay (offlineShadow) of the three stateful off-by-default features, for this one session and with
     the person's own settings: what each would have withheld had it been on, in tokens -- nothing installed needed.
     A feature ON in the config is named, never replayed: the live guard saw those results and passed on them, so
     "would have acted" would contradict it. One that fired live here has its record in report --backfire. */
  const os = offlineShadow(parsed, ledger, userCfg);
  const onNow = OFFLINE.filter((k) => isOnIn(userCfg, k));
  const liveHere = OFFLINE.filter((k) => os.live[k] && !onNow.includes(k));
  const replayed = OFFLINE.filter((k) => !os.live[k] && !onNow.includes(k));
  const acted = replayed.filter((k) => os[k].n), idle = replayed.filter((k) => !os[k].n);
  if (replayed.length) {
    const parts = acted.map((k) => `${OFFLINE_LABEL[k]} would have acted on ${os[k].n}, ~ ${kfmt(os[k].withheld)} tokens kept out (~ ${kfmt(os[k].carried)} carried)`);
    if (idle.length) parts.push(`${idle.map((k) => OFFLINE_LABEL[k]).join(', ')}: nothing to act on in this session`);
    const notes = [];
    if (onNow.length) notes.push(`on in your config: ${onNow.join(', ')}`);
    if (liveHere.length) notes.push(`ran live here: ${liveHere.join(', ')} -- report --backfire has its record`);
    lines.push(`  Off-by-default features, replayed over this session with the guard's own decisions: ${parts.join('; ')}`
      + (notes.length ? ` (${notes.join('; ')})` : ''));
    if (acted.length) lines.push(`    Whether the model would have come back for what they withhold is not measured. To try one, set "${acted[0]}": true in ~/.claude/tokenbrake.json (tokenbrake init installs the guard).`);
  }

  /* The only line here that answers "should I change readLimitLines", and it answers it from this session
     rather than from a default someone picked. AB-TASK.md, "The Read cap's trigger": readMaxBytes decides
     WHICH reads get capped, readLimitLines decides how much a capped read withholds -- and a cap that
     withholds what the model was going for buys a return trip that costs more than the cut saved. */
  const tgt = readTargets(parsed, [readLimitLines, 500, 800].filter((v, i, a) => v && a.indexOf(v) === i).sort((a, b) => a - b));
  if (tgt.n >= 5) {
    const pcts = Object.entries(tgt.past).map(([n, k]) => `${n} lines -> ${k} (${Math.round(100 * k / tgt.n)}%)`);
    const cls = classifyRangedReads(parsed, ledger || [], { sessionId: parsed.sessionId });
    lines.push(`  Where you read: ${tgt.n} targeted reads, median start line ${tgt.median}, 90th percentile ${tgt.p90}, deepest ${tgt.max}`
      + (cls.induced.length ? ` -- ${cls.induced.length} of them followed a cap on the same file; report --where separates them` : ''));
    lines.push(`  A Read cap keeping the first ... would have hidden what the model went for: ${pcts.join('; ')}`);
    lines.push(`    (inferred: the guard never capped these reads themselves -- they arrived already bounded. But a cap on an`);
    lines.push(`     earlier unbounded read of the same file tells the model to come back with an offset, so some of these`);
    lines.push(`     start lines are the cap's own, not the model's. report --where pools every session and splits the two.)`);
  }

  const rep = repeatReads(parsed);
  if (rep.sameShape) {
    lines.push(rep.repeats
      ? `  Repeat reads: ${rep.repeats} of ${rep.sameShape} same-shape reads returned a file already in context -- ~ ${kfmt(rep.tokens)} tokens re-entered, ~ ${kfmt(rep.carried)} token-reads carried`
      : `  Repeat reads: none -- ${rep.sameShape} same-shape reads, each of a file not already in context`);
  }

  lines.push('');
  lines.push(`What ate it -- by tokens carried (size x later requests), top ${top}:`);
  lines.push(`     size   carried   turns  tool               what`);
  const ranked = [...parsed.results].sort((a, b) => b.carried - a.carried || b.tokens - a.tokens).slice(0, top);
  for (const r of ranked) {
    const l = trimmedOf(r);
    const mark = l ? `  [trimmed from ${kfmt(l.chars / CHARS_PER_TOKEN)}]` : (offeredOf(r) ? '  [trim not applied]' : (r.isError ? '  [error]' : ''));
    lines.push(`  ${kfmt(r.tokens).padStart(7)}  ${kfmt(r.carried).padStart(8)}  ${String(r.carriedTurns).padStart(5)}  ${r.name.padEnd(18).slice(0, 18)} ${r.what.slice(0, 56)}${mark}`);
  }

  lines.push('');
  lines.push('By tool (share of tokens carried):');
  const byTool = {};
  for (const r of parsed.results) { const t = byTool[r.name] = byTool[r.name] || { n: 0, tokens: 0, carried: 0 }; t.n++; t.tokens += r.tokens; t.carried += r.carried; }
  for (const [t, v] of Object.entries(byTool).sort((a, b) => b[1].carried - a[1].carried).slice(0, 8)) {
    const pct = carried ? Math.round(100 * v.carried / carried) : 0;
    lines.push(`  ${t.padEnd(18).slice(0, 18)} ${String(v.n).padStart(4)} calls  ${kfmt(v.tokens).padStart(7)} entered  ${kfmt(v.carried).padStart(8)} carried  ${String(pct).padStart(3)}%`);
  }

  /* The advice line is derived, never generic: it names the single result whose trimming would have
     removed the most carried context, and only if it is something the guard could act on. */
  /* A shell result qualifies only if it is in the trim's window -- an excerpt, a failure or a result past the
     host's ceiling is not something the guard would have trimmed, whatever its size. */
  const heaviestUntrimmed = ranked.find(r => !trimmedOf(r) && (inTrimWindow(r, maxChars) || (r.name === 'Read' && r.tokens >= 1500)));
  if (heaviestUntrimmed) {
    lines.push('');
    lines.push(`One result to have brakes on: ${heaviestUntrimmed.name} "${heaviestUntrimmed.what.slice(0, 50)}" -- ~ ${kfmt(heaviestUntrimmed.tokens)} tokens carried ${heaviestUntrimmed.carriedTurns} times.`
      + (heaviestUntrimmed.name === 'Read' ? ' An offset/limit read, or a Grep first, would have kept most of it out.' : ' The tokenbrake guard would have trimmed it to its head, tail and error lines.'));
  }
  return lines.join('\n');
}

/* The measurement protocol of AB-TASK.md as one table: two sessions, the same rows, a change column. The rows
   are the ones the A/B rounds compared by hand -- cost, requests, cache reads, output, what tool results
   entered and carried, what the guard trimmed, repeat reads. Nothing here says which arm is which or why
   they differ; that is the caller's protocol. The change column is B against A. */
function sessionFacts(parsed, ledger) {
  carry(parsed);
  const u = usageTotals(parsed), rep = repeatReads(parsed);
  const idx = ledgerIndex(ledger || [], parsed.sessionId);
  let trimmed = 0, keptOut = 0;
  for (const r of parsed.results) {
    const l = (r.id && idx.byId.get(r.id)) || idx.byWhat.get(r.what);
    if (l && l.kept != null && l.chars != null && l.kept < l.chars) { trimmed++; keptOut += Math.round((l.chars - l.kept) / CHARS_PER_TOKEN); }
  }
  /* Split entered/carried by the tool class each guard feature acts on -- Read (the read cap), shell
     (Bash/PowerShell: the base trim, blobElide, gitView), MCP (mcpTrim), and everything else the guard
     leaves alone. The A-vs-B change per class is what says WHERE brake 1's carried-context saving comes
     from -- the read cap or the shell trim -- rather than one blended number. classOf mirrors guard.js's
     own isShell (Bash/PowerShell) and isMcp (mcp__*) gates; the guard ships as a lone file so this cannot
     import them -- if the guard learns to trim a new tool class, teach classOf the same split or that class's
     saving reads as the untrimmed 'other' baseline. */
  const byClass = { Read: { n: 0, entered: 0, carried: 0 }, shell: { n: 0, entered: 0, carried: 0 },
    MCP: { n: 0, entered: 0, carried: 0 }, other: { n: 0, entered: 0, carried: 0 } };
  const classOf = (n) => n === 'Read' ? 'Read' : (n === 'Bash' || n === 'PowerShell') ? 'shell' : /^mcp__/.test(String(n)) ? 'MCP' : 'other';
  for (const r of parsed.results) { const cls = byClass[classOf(r.name)]; cls.n++; cls.entered += r.tokens; cls.carried += r.carried; }
  return {
    session: String(parsed.sessionId || path.basename(parsed.file, '.jsonl')).slice(0, 8),
    model: [...new Set(parsed.requests.filter((q) => q.usage && q.model && q.model !== '<synthetic>').map((q) => q.model))].join('+') || (parsed.requests.find(q => q.model) || {}).model || '?',
    requests: parsed.requests.length, results: parsed.results.length, compactions: parsed.compactions.length,
    processed: u.processed, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, input: u.input, out: u.out,
    entered: parsed.results.reduce((s, r) => s + r.tokens, 0),
    carried: parsed.results.reduce((s, r) => s + r.carried, 0),
    trimmed, keptOut, repeats: rep.repeats, repeatTokens: rep.tokens, byClass
  };
}

function renderCompare(A, B, ledger) {
  const a = sessionFacts(A, ledger), b = sessionFacts(B, ledger);
  /* Break the entered and carried totals out by tool class, so the change column says which of the guard's
     domains (read cap vs shell trim) moved. entered is the guard's lever; carried is entered x turns, so a
     shorter arm B drops carried in every class at once regardless of the guard -- read entered per class to
     attribute a saving to the guard. Only classes present in either arm show; 'other' (tools the guard leaves
     alone) is the task-variance baseline: Read/shell dropping while 'other' holds flat is the guard, all four
     dropping together is a shorter arm. */
  const classRows = (metric) => ['Read', 'shell', 'MCP', 'other']
    .filter((k) => a.byClass[k].n || b.byClass[k].n)
    .map((k) => [`  ${metric}: ${k}`, kfmt(a.byClass[k][metric]), kfmt(b.byClass[k][metric]), a.byClass[k][metric], b.byClass[k][metric]]);
  const rows = [
    ['requests', fmt(a.requests), fmt(b.requests), a.requests, b.requests],
    ['context processed', kfmt(a.processed), kfmt(b.processed), a.processed, b.processed],
    ['cache-read tokens', kfmt(a.cacheRead), kfmt(b.cacheRead), a.cacheRead, b.cacheRead],
    ['cache-write tokens', kfmt(a.cacheWrite), kfmt(b.cacheWrite), a.cacheWrite, b.cacheWrite],
    ['uncached input tokens', kfmt(a.input), kfmt(b.input), a.input, b.input],
    ['output tokens', kfmt(a.out), kfmt(b.out), a.out, b.out],
    ['tool results', fmt(a.results), fmt(b.results), a.results, b.results],
    ['tool results entered', kfmt(a.entered), kfmt(b.entered), a.entered, b.entered],
    ...classRows('entered'),
    ['tool results carried', kfmt(a.carried), kfmt(b.carried), a.carried, b.carried],
    ...classRows('carried'),
    ['trimmed by the guard', `${a.trimmed} (~ ${kfmt(a.keptOut)} kept out)`, `${b.trimmed} (~ ${kfmt(b.keptOut)} kept out)`, null, null],
    ['repeat reads', `${a.repeats} (~ ${kfmt(a.repeatTokens)})`, `${b.repeats} (~ ${kfmt(b.repeatTokens)})`, null, null],
    ['compactions', fmt(a.compactions), fmt(b.compactions), null, null],
  ];
  const change = (x, y) => (x == null || y == null || !x) ? '' : ((y - x) / x * 100).toFixed(0).replace(/^-0$/, '0').replace(/^(-?)/, (m, s) => s === '-' ? '-' : '+') + '%';
  const w0 = 24, w1 = Math.max(14, ...rows.map(r => r[1].length)), w2 = Math.max(14, ...rows.map(r => r[2].length));
  const lines = [];
  lines.push(`A: ${a.session}...  ${a.model}  ${A.cwd || ''}`);
  lines.push(`B: ${b.session}...  ${b.model}  ${B.cwd || ''}`);
  lines.push('');
  lines.push(`${''.padEnd(w0)}  ${'A'.padStart(w1)}  ${'B'.padStart(w2)}  change`);
  for (const r of rows) lines.push(`${r[0].padEnd(w0)}  ${r[1].padStart(w1)}  ${r[2].padStart(w2)}  ${change(r[3], r[4])}`);
  lines.push('');
  lines.push('Change is B against A. Every row is tokens or a count -- never money.');
  lines.push('The entered:/carried: rows split those totals by tool class -- Read (read cap), shell (the trim: Bash/PowerShell), MCP (mcp trim), other (untrimmed, the task-variance baseline). entered is the guard\'s lever; carried is entered x turns, so a shorter arm drops carried everywhere -- read entered per class to credit the guard.');
  lines.push('Two sessions differ by more than their configuration: identical OFF/OFF arms have come out up to 42.6% apart on tokens entered (EVIDENCE.md).');
  return lines.join('\n');
}

/* One line per session, for --all: enough to pick the one worth opening.
   `marks` adds the two columns the question "which of these may a claim about ordinary work rest on" turns
   on: whether the guard was recording there, and what the cwd makes it (the benchmark's, a calibration
   arm's, or ordinary work -- `marks.tag` is whichever short label the caller's view uses). Both are omitted
   entirely when the caller has not established them -- a column reading "no guard" for a caller that never
   opened the ledger would be a claim about the guard made from nothing. */
function renderSummaryLine(parsed, marks) {
  carry(parsed);
  const u = usageTotals(parsed);
  const carried = parsed.results.reduce((s, r) => s + r.carried, 0);
  const sid = String(parsed.sessionId || path.basename(parsed.file, '.jsonl')).slice(0, 8);
  const m = marks || {};
  const cols = m.guard == null ? '' : '  ' + (m.guard ? 'guard' : '     ') + '  ' + String(m.tag || '').padEnd(5);
  /* The saving listing is this listing under a filter, so the brake's own three figures join this row
     rather than getting a second row format that can drift from it. */
  const sv = m.saved ? '  ' + String(m.saved.count).padStart(3) + (m.saved.count === 1 ? ' trim ' : ' trims')
    + '  ' + kfmt(m.saved.saved).padStart(6) + ' out  ' + kfmt(m.saved.savedCarried).padStart(7) + ' not carried  '
    + (m.saved.unpriced === m.saved.count ? '--' : pfmt(m.saved.pts)).padStart(6) + ' pts' : '';
  return `  ${sid}...  ${String(parsed.requests.length).padStart(4)} req  ${kfmt(u.processed).padStart(6)} processed  ${kfmt(carried).padStart(7)} carried${sv}${cols}  ${(parsed.cwd || '').slice(-40)}`;
}

module.exports = { parseTranscript, formatWarning, carry, limitDraw, compactionView, lookupOf, compactionWhy, compactionVerdict, STAGE2, LIMIT_WEIGHTS, COMPACT_CHARGE, kfmt, guardRan, repeatReads, recoveryReads, backfireAudit, backfireVerdict, readFileOf, readTargets,
  normReadPath, readCapIndex, classifyRangedReads, capBandSpike, startHistogram, readCapFiles,
  unboundedReads, readDepths, triggerGrid, readsWholeFile, fileShape, wholeReadIndex, eofLength,
  reachPooled, commandTool, trimmedResults, trimSavings, pfmt, stagedCwd, stagedKind,
  GUARD_DEFAULTS: GUARD.DEFAULTS, offlineShadow, OFFLINE, isOnIn, sweepOffline, SWEEP_KNOBS, shadowRecord, SHADOWED, inTrimWindow, trimClass, shellGrid, readGrid, thresholdAdvice, recordAbove, READ_MAX_STEPS, capFrontier, frontierVerdict, HOST_READ_CEILING, HOST_READ_LINES, readKey, readCaps, reach, smallResults, TRIM_CHARS, usageTotals, sessionFacts, renderCompare, ledgerIndex, findTranscripts, renderReport, renderSummaryLine, resultText, describe, CHARS_PER_TOKEN,
  autotune, blobOpportunity, mcpOpportunity, gitOpportunity, TUNE_DEFAULTS, GIT_CMD };
