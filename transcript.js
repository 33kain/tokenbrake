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

const CHARS_PER_TOKEN = 4;   // the same estimate the extension and the HANDOFF use; a warning, not a bill

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
function resultText(block) {
  const c = block && block.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(b => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '').join('\n');
  return '';
}

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
/* The same command shapes guard.js exempts from the trim, kept deliberately in step with its EXCERPT: a
   read of one file, optionally inside a `cd ... &&`, optionally with an `echo` label before or after, and
   with the path quoted if it has spaces. The two must agree -- a report that does not recognise the
   commands the guard treats as reads cannot tell you what the guard did. */
const P_ = String.raw`(?:'[^']+'|"[^"]+"|[^|;&<>'"\s]+)`;
const LBL_ = String.raw`echo(?:\s+(?:'[^']*'|"[^"]*"|[^|;&<>'"\s]+))*`;
const RD_ = String.raw`(?:cat(?:\s+-[bnAEsTv]+)*|sed\s+-n\s+['"]?[0-9]+,[0-9]+p['"]?|head(?:\s+-n?\s*[0-9]+)?` +
  String.raw`|tail(?:\s+-n?\s*[0-9]+)?|grep(?:\s+-(?![rRlL])[a-zA-Z]+)*\s+${P_})\s+(${P_})`;
const EXCERPT_CMD = new RegExp(
  String.raw`^\s*(?:cd\s+${P_}\s*&&\s*)?(?:${LBL_}\s*(?:&&|;)\s*)?${RD_}` +
  String.raw`(?:\s*(?:&&|;)\s*${LBL_})*\s*$`);
const unquote = (s) => String(s || '').replace(/^['"]|['"]$/g, '');

/* A whole-file read: the population the Read cap's TRIGGER acts on. An unbounded Read, or a bare `cat` of
   one file -- `head -n N`, `tail`, `sed -n` and `grep` are all bounded requests and are not it, even though
   readFileOf recognises them as reads of a named file. A Read carrying an offset or a limit is likewise not
   one, and that is also how the guard decides (guard.js:323 returns before it stats anything). */
const WHOLE_RD_ = String.raw`cat(?:\s+-[bnAEsTv]+)*\s+(${P_})`;
const WHOLE_CMD = new RegExp(
  String.raw`^\s*(?:cd\s+${P_}\s*&&\s*)?(?:${LBL_}\s*(?:&&|;)\s*)?${WHOLE_RD_}` +
  String.raw`(?:\s*(?:&&|;)\s*${LBL_})*\s*$`);

/* The guard's own two early exits, kept deliberately in step with it exactly as EXCERPT_CMD is: a read it
   returns on is not a read the trigger acts on, so neither belongs in the population readMaxBytes is argued
   from. PERSISTED is the second knob -- a spilled output is capped by persistedLimitLines at anything over
   maxChars, whatever readMaxBytes says (guard.js:41, :329). */
const PERSISTED = /(^|[\\/])(tool-results|tokenbrake[\\/]out)[\\/][^\\/]+\.txt$/;
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
function parseTranscript(file) {
  const entries = readJsonl(file);
  const requests = [];               // { id, usage, at }  in order of first appearance
  const reqIndex = new Map();        // requestId -> index in requests
  const toolUses = new Map();        // tool_use_id -> { name, input, req, at }
  const results = [];                // { id, name, what, chars, tokens, afterReq, askedAt, at, isError }
  const compactions = [];            // request indices at which context was reset
  let cwd = null, sessionId = null, version = null;

  for (const e of entries) {
    if (!e || typeof e !== 'object' || e.isSidechain) continue;
    if (!cwd && e.cwd) cwd = e.cwd;
    if (!sessionId && e.sessionId) sessionId = e.sessionId;
    if (!version && e.version) version = e.version;

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
          readFrom: readStartLine(use.name, use.input),
          marker: /\[tokenbrake\]/.test(text),   // the guard's replacement is what the model saw
          chars: text.length,
          /* The Read cap is a LINE count on a BYTE trigger, so neither can be reasoned about from the other.
             `shape` is what the delivered text says about the file itself, with Claude Code's line numbering
             subtracted; it is computed only for reads, not for every result in a large transcript. */
          lines: text ? text.split('\n').length : 0,
          whole: readsWholeFile(use.name, use.input),
          shape: readFileOf(use.name, use.input) ? fileShape(text) : null,
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

  return { file, cwd, sessionId, version, requests, results, compactions };
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

/* List prices, USD per million tokens, first-party Claude API. Cache writes are priced for the one-hour TTL
   Claude Code uses (2x input; the five-minute TTL would be 1.25x). Checked against the session records of the
   A/B arms: on the Opus 5 feature arms the formula reproduces $2.381214 and $2.452951 to the sixth decimal.
   Prices change; a model not listed here is reported as unpriced rather than guessed. */
const PRICES = [
  [/^claude-fable-5-1/, { in: 10, out: 50, read: 0.25, write: 20 }],
  [/^claude-fable-5/, { in: 10, out: 50, read: 1, write: 20 }],
  [/^claude-opus-5/, { in: 5, out: 25, read: 0.5, write: 10 }],
  [/^claude-opus-4-[678]/, { in: 5, out: 25, read: 0.5, write: 10 }],
  [/^claude-sonnet-5/, { in: 2, out: 10, read: 0.2, write: 4 }],
  [/^claude-sonnet-4-6/, { in: 3, out: 15, read: 0.3, write: 6 }],
  [/^claude-haiku-4-5/, { in: 1, out: 5, read: 0.1, write: 2 }],
];
function priceOf(model) { for (const [re, p] of PRICES) if (re.test(String(model || ''))) return p; return null; }

/* The session at list price, request by request, each at its own model's rate. */
function costOf(parsed) {
  let usd = 0; const byModel = {}; const unpriced = new Set();
  for (const q of parsed.requests) {
    const u = q.usage; if (!u) continue;
    const p = priceOf(q.model);
    if (!p) { unpriced.add(q.model || '?'); continue; }
    const c = ((u.input_tokens || 0) * p.in + (u.output_tokens || 0) * p.out
      + (u.cache_read_input_tokens || 0) * p.read + (u.cache_creation_input_tokens || 0) * p.write) / 1e6;
    usd += c; byModel[q.model] = (byModel[q.model] || 0) + c;
  }
  return { usd, byModel, unpriced: [...unpriced] };
}

/* Shell results the guard leaves alone: Bash and PowerShell results at or under TRIM_CHARS characters, the
   guard's default maxChars. Counted with their carried cost so the untouched share of a session is a
   number, not a guess. */
const TRIM_CHARS = 6000;
function smallResults(parsed) {
  const out = { shell: 0, n: 0, tokens: 0, carried: 0 };
  for (const r of parsed.results) {
    if (r.name !== 'Bash' && r.name !== 'PowerShell') continue;
    out.shell++;
    if (r.chars > TRIM_CHARS) continue;
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
function reach(parsed, wasTrimmed) {
  const B = () => ({ n: 0, tokens: 0, carried: 0 });
  const out = { window: B(), acted: B(), untouched: B(), under: B(), failed: B(), persisted: B(), nonShell: B(), total: B() };
  const add = (b, r) => { b.n++; b.tokens += r.tokens; b.carried += r.carried || 0; };
  const trimmed = new Set(wasTrimmed || []);
  for (const r of parsed.results) {
    add(out.total, r);
    /* A result the guard rewrote is in the window by proof, whatever its delivered size says. Sizes here
       are what the model received, so a trimmed result now measures under the threshold -- classifying by
       size alone would put every success in the "untouched" bucket and leave the window empty. */
    if (trimmed.has(r)) { add(out.window, r); add(out.acted, r); continue; }
    const shell = r.name === 'Bash' || r.name === 'PowerShell';
    if (!shell) { add(out.nonShell, r); continue; }
    if (r.isError) { add(out.failed, r); continue; }
    if (r.chars >= HOST_CEILING) { add(out.persisted, r); continue; }
    if (r.chars <= TRIM_CHARS) { add(out.under, r); continue; }
    add(out.window, r); add(out.untouched, r);
  }
  return out;
}

/* Money, not token counts. ab10 (AB-TASK.md) measured where a hook's effect actually lands: not in the
   size of any one result but in `carried` -- a result is paid for again in every later request that
   re-reads it. So price the first appearance once at the cache-write rate and every re-read at the
   cache-read rate, at the session's own model and at list price. A token count is not a bill, and this
   package's whole claim is about the bill. */
function dominantModel(parsed) {
  const n = {};
  for (const q of parsed.requests) if (q.model) n[q.model] = (n[q.model] || 0) + 1;
  let best = null, most = 0;
  for (const m of Object.keys(n)) if (n[m] > most) { best = m; most = n[m]; }
  return best;
}
function usdOfTokens(first, carriedTotal, price) {
  if (!price) return null;
  const later = Math.max(0, (carriedTotal || 0) - (first || 0));
  return ((first || 0) * price.write + later * price.read) / 1e6;
}
const usd = (x) => x == null ? null : (x >= 0.01 ? '$' + x.toFixed(2) : '<$0.01');

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

/* Usage, summed once per request. The API reports the whole context on every request (uncached input +
   cache reads + cache writes), so summing those is the total the session has actually processed, and the
   LAST request's figure is roughly what the context holds right now. cacheRead over the total is how much
   of that was served at the cached rate. Missing counters read as 0 here because this is a sum -- the
   per-call null-vs-0 distinction the extension keeps does not survive addition. */
function usageTotals(parsed) {
  let processed = 0, cacheRead = 0, cacheWrite = 0, input = 0, out = 0, requestsWithUsage = 0, last = 0;
  for (const q of parsed.requests) {
    const u = q.usage; if (!u) continue;
    requestsWithUsage++;
    const inp = u.input_tokens || 0, cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
    processed += inp + cr + cw; cacheRead += cr; cacheWrite += cw; input += inp; out += u.output_tokens || 0;
    last = inp + cr + cw;
  }
  return { processed, cacheRead, cacheWrite, input, out, requestsWithUsage, contextNow: last };
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
  for (const r of idx.rows) {
    if (r.session) sessions.add(r.session);
    const e = files.get(r.key);
    if (!e) files.set(r.key, { what: r.what, n: 1, persisted: r.persisted, limit: r.limit, bytes: r.bytes, lines: r.lines });
    else { e.n++; if (r.bytes > e.bytes) { e.bytes = r.bytes; e.lines = r.lines; } }
  }
  const rows = [...files.values()].map((e) => ({ ...e,
    delivered: (e.lines && e.limit) ? e.limit / e.lines : null }))
    .sort((a, b) => b.n - a.n || b.bytes - a.bytes);
  const half = (want) => {
    const rs = rows.filter((r) => r.persisted === want);
    return { n: idx.rows.filter((r) => r.persisted === want).length, files: rs.length,
      bytes: idx.rows.filter((r) => r.persisted === want).reduce((t, r) => t + r.bytes, 0) };
  };
  return { source: half(false), persisted: half(true), n: idx.n, bytes: idx.bytes,
    sessions: sessions.size, deduped: idx.deduped, limits: idx.limits,
    unknownLines: rows.filter((r) => r.lines == null).length, files: rows };
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
  const reads = [];
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
      reads.push({ file: r.file, bytes: cap.bytes, lines: cap.lines, source: 'ledger', capped: true, ceiling: null });
      continue;
    }
    const sh = r.shape || { bytes: r.chars, lines: r.lines, numbered: false, from: null, to: null };
    let ceiling = null;
    if (r.isError) ceiling = 'refused';
    else if (sh.numbered && sh.from === 1 && sh.lines === HOST_READ_LINES) { ceiling = 'host-lines'; hostLines++; }
    else if (r.chars >= 0.9 * HOST_READ_CEILING) { ceiling = 'near'; nearCeiling++; }
    reads.push({ file: r.file, bytes: sh.bytes, lines: sh.lines, capped: false, ceiling,
      source: sh.numbered ? 'numbering' : 'text' });
  }
  /* A cap row whose file never appears as an unbounded read means the transcript recorded the guard's
     rewritten input instead -- the read is in there carrying a `limit`, which is not a whole-file read.
     Those reads belong in the population too, at their true size. */
  let recordedRewritten = 0;
  for (const [key, cap] of idx.byFile) {
    if (capSeen.has(key) || cap.persisted) continue;
    recordedRewritten++;
    reads.push({ file: cap.what, bytes: cap.bytes, lines: cap.lines, source: 'ledger', capped: true, ceiling: null });
  }
  const sized = reads.filter((r) => !r.ceiling);
  return { reads, sized, n: reads.length, bytes: reads.reduce((t, x) => t + (x.bytes || 0), 0),
    files: new Set(reads.map((r) => normReadPath(r.file, parsed.cwd))).size,
    capped: reads.filter((x) => x.capped).length, recordedOriginal, recordedRewritten,
    nearCeiling, hostLines, persistedSkipped,
    refused: reads.filter((r) => r.ceiling === 'refused').length,
    sources: { ledger: reads.filter((r) => r.source === 'ledger').length,
      numbering: reads.filter((r) => r.source === 'numbering').length,
      text: reads.filter((r) => r.source === 'text').length },
    noLines: reads.filter((x) => !x.lines).length,
    /* Undetermined until a cap actually fires in these sessions: with nothing to match, neither answer is
       evidence. Printed as undetermined rather than silently as one of them. */
    shapeVerdict: (recordedOriginal + recordedRewritten) === 0 ? 'undetermined'
      : recordedOriginal && recordedRewritten ? 'mixed' : (recordedOriginal ? 'original' : 'rewritten') };
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
  const rows = []; const bySource = { session: 0, ledger: 0, disk: 0 };
  let unresolved = 0;
  for (const r of cls.spontaneous) {
    const key = normReadPath(r.file, parsed.cwd);
    let lines = null, source = null;
    if (key && fromSession.has(key)) { lines = fromSession.get(key); source = 'session'; }
    else if (key && idx.byFile.get(key) && idx.byFile.get(key).lines) { lines = idx.byFile.get(key).lines; source = 'ledger'; }
    else if (o.linesOnDisk && r.file) { const n = o.linesOnDisk(r.file); if (n) { lines = n; source = 'disk'; } }
    if (!lines || r.readFrom > lines) { unresolved++; continue; }
    bySource[source]++;
    rows.push({ file: r.file, start: r.readFrom, lines, depth: r.readFrom / lines, source });
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

/* What each candidate trigger would catch, and what each candidate limit would then withhold. Pure
   arithmetic over the reads -- the half of the readMaxBytes question that needs no session. The half it
   cannot answer is whether the model comes back for what was withheld, which is behavioural and costs money
   to find out (AB-TASK.md, "The Read cap's trigger"). */
function triggerGrid(reads, triggers, limits) {
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const totalBytes = reads.reduce((t, r) => t + (r.bytes || 0), 0);
  return (triggers || []).map((trigger) => {
    const caught = reads.filter((r) => (r.bytes || 0) > trigger);
    const caughtBytes = caught.reduce((t, r) => t + r.bytes, 0);
    const byLimit = {};
    for (const L of (limits || [])) {
      const withheld = caught.filter((r) => r.lines).map((r) => Math.max(0, (r.lines - Math.min(L, r.lines)) / r.lines));
      byLimit[L] = withheld.length ? med(withheld) : null;
    }
    return { trigger, caught: caught.length, caughtBytes,
      byteShare: totalBytes ? caughtBytes / totalBytes : 0, byLimit };
  });
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
const kfmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(Math.round(n));

/* The report, as lines. Pure: takes parsed data, returns text, so the test can read it without a
   console. `top` is how many results to name. */
function renderReport(parsed, ledger, { top = 10, readLimitLines = 300 } = {}) {
  carry(parsed);
  const u = usageTotals(parsed);
  const lines = [];
  const sid = String(parsed.sessionId || path.basename(parsed.file, '.jsonl'));
  lines.push(`Session ${sid.slice(0, 8)}...  ${parsed.cwd || ''}`);
  lines.push(`  ${fmt(parsed.requests.length)} requests, ${fmt(parsed.results.length)} tool results`
    + (parsed.compactions.length ? `, ${parsed.compactions.length} compaction(s)` : ''));
  if (u.requestsWithUsage) {
    const pct = u.processed ? Math.round(100 * u.cacheRead / u.processed) : 0;
    lines.push(`  Context processed: ${kfmt(u.processed)} tokens across ${fmt(u.requestsWithUsage)} requests (${pct}% read from cache); output ${kfmt(u.out)}`);
    lines.push(`  Context now: ~ ${kfmt(u.contextNow)} tokens -- what the next request re-reads`);
    const c = costOf(parsed);
    const models = Object.keys(c.byModel);
    if (models.length) lines.push(`  At list price: ~ $${c.usd.toFixed(2)} (${models.join(', ')}; cache writes at the 1h rate)`
      + (c.unpriced.length ? ` -- ${c.unpriced.join(', ')} unpriced` : ''));
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
  const saved = trimmed.reduce((s, r) => { const l = trimmedOf(r); return s + Math.round((l.chars - l.kept) / CHARS_PER_TOKEN); }, 0);
  const price = priceOf(dominantModel(parsed));
  if (trimmed.length) {
    const savedCarried = trimmed.reduce((s, r) => { const l = trimmedOf(r); return s + Math.round((l.chars - l.kept) / CHARS_PER_TOKEN) * (r.carriedTurns + 1); }, 0);
    const money = usdOfTokens(saved, savedCarried, price);
    lines.push(`  tokenbrake trimmed ${trimmed.length} of them: ~ ${kfmt(saved)} tokens kept out, ~ ${kfmt(savedCarried)} token-reads not carried`
      + (money == null ? '' : ` -- ~ ${usd(money)} off this session at list price`));
  } else if (ledger.length) {
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
  } else if (ledger.length) {
    lines.push(`  Read caps fired: none`);
  }

  /* What the trim does not touch: shell results under the threshold. Small excerpts carried through a long
     session were 79% of one real audit session's carried context (LANDSCAPE.md); this line says what they
     are here, so a week of real sessions can say whether shape filters for small output are worth building. */
  const small = smallResults(parsed);
  if (small.shell) {
    lines.push(`  Under the trim threshold: ${small.n} of ${small.shell} shell results (~ ${kfmt(small.tokens)} tokens entered, ~ ${kfmt(small.carried)} token-reads carried, ${carried ? Math.round(100 * small.carried / carried) : 0}% of all carried)`);
  }
  /* The denominator. Everything above says what the guard did; this says what it could ever have done,
     which on most sessions is the more useful number and is usually smaller than anyone expects. */
  const rc = reach(parsed, trimmed);
  const pct = (x) => (carried ? Math.round(100 * x / carried) : 0);
  if (rc.total.n) {
    lines.push(`  Within the guard's reach: ${rc.window.n} of ${rc.total.n} tool results (~ ${kfmt(rc.window.tokens)} tokens entered, ~ ${kfmt(rc.window.carried)} carried, ${pct(rc.window.carried)}% of all carried) -- shell, exit 0, over ${kfmt(TRIM_CHARS / CHARS_PER_TOKEN)} tokens and under Claude Code's own ceiling`);
    const oor = [];
    if (rc.under.n) oor.push(`${rc.under.n} under the threshold`);
    if (rc.nonShell.n) oor.push(`${rc.nonShell.n} not shell results`);
    if (rc.failed.n) oor.push(`${rc.failed.n} failed (the host ignores the replacement)`);
    if (rc.persisted.n) oor.push(`${rc.persisted.n} past the host's ceiling (persisted, replacement never applied)`);
    if (oor.length) lines.push(`  Out of reach: ${oor.join('; ')} -- ~ ${kfmt(rc.total.carried - rc.window.carried)} carried, ${pct(rc.total.carried - rc.window.carried)}% of all carried`);
    lines.push(`  Acted on: ${trimmed.length} of those${rc.window.n ? ` -- ${Math.round(100 * trimmed.length / rc.window.n)}% of what it could reach` : ''}`);
    /* What is left on the table, in money. The share of *carried* is the honest weight: ab10 found the
       count of trims does not predict the saving -- two trims beat seven -- because which result is cut,
       and how early, decides how many later requests re-read it. */
    if (rc.untouched.n) {
      const left = usdOfTokens(rc.untouched.tokens, rc.untouched.carried, price);
      lines.push(`  Still within reach: ${rc.untouched.n} result${rc.untouched.n === 1 ? '' : 's'} the guard could have trimmed and did not (~ ${kfmt(rc.untouched.carried)} carried${left == null ? '' : `, ~ ${usd(left)}`})`);
    }
  }

  /* The guard's own cost, reported next to its saving and never omitted when the saving is shown. */
  const rec = recoveryReads(parsed);
  if (rec.n) {
    const cost = usdOfTokens(rec.tokens, rec.carried, price);
    lines.push(`  Recovery reads: ${rec.n} -- the model came back for more of a file it had already read (~ ${kfmt(rec.tokens)} tokens re-entered, ~ ${kfmt(rec.carried)} carried${cost == null ? '' : `, ~ ${usd(cost)}`})`
      + (trimmed.length ? ` -- some of these are what the trim sent it back for` : ''));
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
  const heaviestUntrimmed = ranked.find(r => !trimmedOf(r) && (r.name === 'Bash' || r.name === 'Read') && r.tokens >= 1500);
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
  const u = usageTotals(parsed), c = costOf(parsed), rep = repeatReads(parsed);
  const idx = ledgerIndex(ledger || [], parsed.sessionId);
  let trimmed = 0, keptOut = 0;
  for (const r of parsed.results) {
    const l = (r.id && idx.byId.get(r.id)) || idx.byWhat.get(r.what);
    if (l && l.kept != null && l.chars != null && l.kept < l.chars) { trimmed++; keptOut += Math.round((l.chars - l.kept) / CHARS_PER_TOKEN); }
  }
  return {
    session: String(parsed.sessionId || path.basename(parsed.file, '.jsonl')).slice(0, 8),
    model: Object.keys(c.byModel).join('+') || (parsed.requests.find(q => q.model) || {}).model || '?',
    cost: c.usd, unpriced: c.unpriced.length > 0,
    requests: parsed.requests.length, results: parsed.results.length, compactions: parsed.compactions.length,
    processed: u.processed, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, input: u.input, out: u.out,
    entered: parsed.results.reduce((s, r) => s + r.tokens, 0),
    carried: parsed.results.reduce((s, r) => s + r.carried, 0),
    trimmed, keptOut, repeats: rep.repeats, repeatTokens: rep.tokens
  };
}

function renderCompare(A, B, ledger) {
  const a = sessionFacts(A, ledger), b = sessionFacts(B, ledger);
  const money = (x, f) => f.unpriced ? '$' + x.toFixed(2) + '*' : '$' + x.toFixed(2);
  const rows = [
    ['API cost, list price', money(a.cost, a), money(b.cost, b), a.cost, b.cost],
    ['requests', fmt(a.requests), fmt(b.requests), a.requests, b.requests],
    ['context processed', kfmt(a.processed), kfmt(b.processed), a.processed, b.processed],
    ['cache-read tokens', kfmt(a.cacheRead), kfmt(b.cacheRead), a.cacheRead, b.cacheRead],
    ['cache-write tokens', kfmt(a.cacheWrite), kfmt(b.cacheWrite), a.cacheWrite, b.cacheWrite],
    ['uncached input tokens', kfmt(a.input), kfmt(b.input), a.input, b.input],
    ['output tokens', kfmt(a.out), kfmt(b.out), a.out, b.out],
    ['tool results', fmt(a.results), fmt(b.results), a.results, b.results],
    ['tool results entered', kfmt(a.entered), kfmt(b.entered), a.entered, b.entered],
    ['tool results carried', kfmt(a.carried), kfmt(b.carried), a.carried, b.carried],
    ['trimmed by the guard', `${a.trimmed} (~ ${kfmt(a.keptOut)} kept out)`, `${b.trimmed} (~ ${kfmt(b.keptOut)} kept out)`, null, null],
    ['repeat reads', `${a.repeats} (~ ${kfmt(a.repeatTokens)})`, `${b.repeats} (~ ${kfmt(b.repeatTokens)})`, null, null],
    ['compactions', fmt(a.compactions), fmt(b.compactions), null, null],
  ];
  const change = (x, y) => (x == null || y == null || !x) ? '' : ((y - x) / x * 100).toFixed(0).replace(/^(-?)/, (m, s) => s === '-' ? '-' : '+') + '%';
  const w0 = 24, w1 = Math.max(14, ...rows.map(r => r[1].length)), w2 = Math.max(14, ...rows.map(r => r[2].length));
  const lines = [];
  lines.push(`A: ${a.session}...  ${a.model}  ${A.cwd || ''}`);
  lines.push(`B: ${b.session}...  ${b.model}  ${B.cwd || ''}`);
  lines.push('');
  lines.push(`${''.padEnd(w0)}  ${'A'.padStart(w1)}  ${'B'.padStart(w2)}  change`);
  for (const r of rows) lines.push(`${r[0].padEnd(w0)}  ${r[1].padStart(w1)}  ${r[2].padStart(w2)}  ${change(r[3], r[4])}`);
  lines.push('');
  lines.push('Change is B against A. Cost is list price, cache writes at the 1h rate' + ((a.unpriced || b.unpriced) ? '; * a model without a listed price was left out' : '') + '.');
  lines.push('Two sessions differ by more than their configuration: on one task, identical arms came out 21% apart in cost (AB-TASK.md).');
  return lines.join('\n');
}

/* One line per session, for --all: enough to pick the one worth opening. */
function renderSummaryLine(parsed) {
  carry(parsed);
  const u = usageTotals(parsed);
  const carried = parsed.results.reduce((s, r) => s + r.carried, 0);
  const sid = String(parsed.sessionId || path.basename(parsed.file, '.jsonl')).slice(0, 8);
  return `  ${sid}...  ${String(parsed.requests.length).padStart(4)} req  ${kfmt(u.processed).padStart(6)} processed  ${kfmt(carried).padStart(7)} carried  ${(parsed.cwd || '').slice(-40)}`;
}

module.exports = { parseTranscript, carry, repeatReads, recoveryReads, readFileOf, readTargets, dominantModel,
  normReadPath, readCapIndex, classifyRangedReads, capBandSpike, startHistogram, readCapFiles,
  unboundedReads, readDepths, triggerGrid, readsWholeFile, fileShape, HOST_READ_CEILING, HOST_READ_LINES, usdOfTokens, readKey, readCaps, reach, smallResults, TRIM_CHARS, usageTotals, costOf, priceOf, sessionFacts, renderCompare, ledgerIndex, findTranscripts, renderReport, renderSummaryLine, resultText, describe, CHARS_PER_TOKEN };
