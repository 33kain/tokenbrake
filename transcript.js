'use strict';
// tokenbrake transcript reader — brake 4, "what's eating your tokens".
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
// Zero dependencies. Tolerant of lines it does not understand — the transcript format is Claude Code's,
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
   Never the result — the report names calls, it does not echo output. */
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
function readKey(name, input) {
  const i = input || {};
  if (name === 'Read' && i.file_path) return `Read ${i.file_path} ${i.offset || 0} ${i.limit || 0}`;
  if (name === 'Bash' && typeof i.command === 'string') {
    const m = /^\s*(?:cat(?: -n)?|sed -n\s+'?[0-9,]+p'?|head(?: -n?\s*\d+)?|tail(?: -n?\s*\d+)?)\s+(\S+)\s*$/.exec(i.command);
    if (m) return `Bash ${i.command.trim().replace(/\s+/g, ' ')}`;
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
  const toolUses = new Map();        // tool_use_id -> { name, input, req }
  const results = [];                // { id, name, what, chars, tokens, afterReq, isError }
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
        if (b && b.type === 'tool_use' && b.id) toolUses.set(b.id, { name: b.name || '?', input: b.input, req });
      }
      continue;
    }

    if (e.type === 'user' && e.message) {
      /* A compaction lands as a user message carrying the summary. Everything before it left the
         context, so every result already in the file stops being carried at this request — and a result
         that arrives AFTER it is bounded by the next compaction, not this one. The first fixture got that
         wrong by keying on request index alone, which capped a post-compaction result at zero. */
      if (e.isCompactSummary) compact(requests.length);
      const content = Array.isArray(e.message.content) ? e.message.content : [];
      for (const b of content) {
        if (!b || b.type !== 'tool_result') continue;
        const text = resultText(b);
        const use = toolUses.get(b.tool_use_id) || { name: '?', input: null, req: requests.length - 1 };
        results.push({
          id: b.tool_use_id || null,
          name: use.name,
          what: describe(use.name, use.input),
          key: readKey(use.name, use.input),
          chars: text.length,
          tokens: Math.round(text.length / CHARS_PER_TOKEN),
          afterReq: requests.length - 1,     // it entered context after this request, before the next
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

/* The carried cost of each result: size × the number of later requests that re-read it, stopping at
   the first compaction after it. Requests after the last result are what "later" means, so the newest
   result on the file has been carried zero times yet — the report says so rather than inventing a
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
   Claude Code uses (2× input; the five-minute TTL would be 1.25×). Checked against the session records of the
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

/* Usage, summed once per request. The API reports the whole context on every request (uncached input +
   cache reads + cache writes), so summing those is the total the session has actually processed, and the
   LAST request's figure is roughly what the context holds right now. cacheRead over the total is how much
   of that was served at the cached rate. Missing counters read as 0 here because this is a sum — the
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
function renderReport(parsed, ledger, { top = 10 } = {}) {
  carry(parsed);
  const u = usageTotals(parsed);
  const lines = [];
  const sid = String(parsed.sessionId || path.basename(parsed.file, '.jsonl'));
  lines.push(`Session ${sid.slice(0, 8)}…  ${parsed.cwd || ''}`);
  lines.push(`  ${fmt(parsed.requests.length)} requests, ${fmt(parsed.results.length)} tool results`
    + (parsed.compactions.length ? `, ${parsed.compactions.length} compaction(s)` : ''));
  if (u.requestsWithUsage) {
    const pct = u.processed ? Math.round(100 * u.cacheRead / u.processed) : 0;
    lines.push(`  Context processed: ${kfmt(u.processed)} tokens across ${fmt(u.requestsWithUsage)} requests (${pct}% read from cache); output ${kfmt(u.out)}`);
    lines.push(`  Context now: ≈ ${kfmt(u.contextNow)} tokens — what the next request re-reads`);
    const c = costOf(parsed);
    const models = Object.keys(c.byModel);
    if (models.length) lines.push(`  At list price: ≈ $${c.usd.toFixed(2)} (${models.join(', ')}; cache writes at the 1h rate)`
      + (c.unpriced.length ? ` — ${c.unpriced.join(', ')} unpriced` : ''));
  }
  const entered = parsed.results.reduce((s, r) => s + r.tokens, 0);
  const carried = parsed.results.reduce((s, r) => s + r.carried, 0);
  lines.push(`  Tool results entered ≈ ${kfmt(entered)} tokens of context, carried through later requests ≈ ${kfmt(carried)} token-reads`);

  const idx = ledgerIndex(ledger, parsed.sessionId);
  const trimmedOf = (r) => idx.byId.get(r.id) || idx.byWhat.get(r.name + '|' + r.what.slice(0, 120));
  const trimmed = parsed.results.filter(trimmedOf);
  const saved = trimmed.reduce((s, r) => { const l = trimmedOf(r); return s + Math.round((l.chars - l.kept) / CHARS_PER_TOKEN); }, 0);
  if (trimmed.length) {
    const savedCarried = trimmed.reduce((s, r) => { const l = trimmedOf(r); return s + Math.round((l.chars - l.kept) / CHARS_PER_TOKEN) * (r.carriedTurns + 1); }, 0);
    lines.push(`  tokenbrake trimmed ${trimmed.length} of them: ≈ ${kfmt(saved)} tokens kept out, ≈ ${kfmt(savedCarried)} token-reads not carried`);
  } else if (ledger.length) {
    lines.push(`  tokenbrake trimmed none of them (ledger has ${ledger.length} rows for other sessions or small results)`);
  }

  const rep = repeatReads(parsed);
  if (rep.sameShape) {
    lines.push(rep.repeats
      ? `  Repeat reads: ${rep.repeats} of ${rep.sameShape} same-shape reads returned a file already in context — ≈ ${kfmt(rep.tokens)} tokens re-entered, ≈ ${kfmt(rep.carried)} token-reads carried`
      : `  Repeat reads: none — ${rep.sameShape} same-shape reads, each of a file not already in context`);
  }

  lines.push('');
  lines.push(`What ate it — by tokens carried (size × later requests), top ${top}:`);
  lines.push(`     size   carried   turns  tool               what`);
  const ranked = [...parsed.results].sort((a, b) => b.carried - a.carried || b.tokens - a.tokens).slice(0, top);
  for (const r of ranked) {
    const l = trimmedOf(r);
    const mark = l ? `  [trimmed from ${kfmt(l.chars / CHARS_PER_TOKEN)}]` : (r.isError ? '  [error]' : '');
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
    lines.push(`One result to have brakes on: ${heaviestUntrimmed.name} "${heaviestUntrimmed.what.slice(0, 50)}" — ≈ ${kfmt(heaviestUntrimmed.tokens)} tokens carried ${heaviestUntrimmed.carriedTurns} times.`
      + (heaviestUntrimmed.name === 'Read' ? ' An offset/limit read, or a Grep first, would have kept most of it out.' : ' The tokenbrake guard would have trimmed it to its head, tail and error lines.'));
  }
  return lines.join('\n');
}

/* The measurement protocol of AB-TASK.md as one table: two sessions, the same rows, a change column. The rows
   are the ones the A/B rounds compared by hand — cost, requests, cache reads, output, what tool results
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
    ['trimmed by the guard', `${a.trimmed} (≈ ${kfmt(a.keptOut)} kept out)`, `${b.trimmed} (≈ ${kfmt(b.keptOut)} kept out)`, null, null],
    ['repeat reads', `${a.repeats} (≈ ${kfmt(a.repeatTokens)})`, `${b.repeats} (≈ ${kfmt(b.repeatTokens)})`, null, null],
    ['compactions', fmt(a.compactions), fmt(b.compactions), null, null],
  ];
  const change = (x, y) => (x == null || y == null || !x) ? '' : ((y - x) / x * 100).toFixed(0).replace(/^(-?)/, (m, s) => s === '-' ? '−' : '+') + '%';
  const w0 = 24, w1 = Math.max(14, ...rows.map(r => r[1].length)), w2 = Math.max(14, ...rows.map(r => r[2].length));
  const lines = [];
  lines.push(`A: ${a.session}…  ${a.model}  ${A.cwd || ''}`);
  lines.push(`B: ${b.session}…  ${b.model}  ${B.cwd || ''}`);
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
  return `  ${sid}…  ${String(parsed.requests.length).padStart(4)} req  ${kfmt(u.processed).padStart(6)} processed  ${kfmt(carried).padStart(7)} carried  ${(parsed.cwd || '').slice(-40)}`;
}

module.exports = { parseTranscript, carry, repeatReads, readKey, usageTotals, costOf, priceOf, sessionFacts, renderCompare, ledgerIndex, findTranscripts, renderReport, renderSummaryLine, resultText, describe, CHARS_PER_TOKEN };
