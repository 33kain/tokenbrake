#!/usr/bin/env node
/* tokenbrake — what a cap on persisted outputs would have kept out of real sessions.
 *
 * A "persisted output" is a tool result that was too big to show inline and was written to a file:
 * Claude Code's own <config>/projects/<cwd>/<session>/tool-results/<id>.txt (its ~30,000-character
 * ceiling), or tokenbrake's <config>/tokenbrake/out/<id>.txt (the guard's own full-output save).
 * Reading one of those whole is the mechanism that carried 96% of the untrimmed audit arm's context
 * (AB-TASK.md): the output escaped the trim by being persisted, then came back in as a Read.
 *
 * This replays every transcript it is given (default: all on this machine) and, for each unbounded
 * Read of a persisted file, computes what the first LIMIT lines would have cost instead, times the
 * requests that carried it. Nothing is changed; this is the transcript re-read with a different rule.
 *
 *   node scripts/sim-persisted.mjs [--limit=80] [--all | <transcript.jsonl> ...]
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('../transcript.js');

const args = process.argv.slice(2);
const LIMIT = Number((args.find(a => a.startsWith('--limit=')) || '--limit=80').split('=')[1]);
const files = args.filter(a => !a.startsWith('--'));
const PERSISTED = /(^|\/)(tool-results|tokenbrake\/out)\/[^/]+\.txt$/;

const list = files.length ? files : T.findTranscripts(process.env.CLAUDE_CONFIG_DIR || require('node:path').join(require('node:os').homedir(), '.claude')).map(t => t.file || t);

let grand = { carried: 0, persistedCarried: 0, notCarried: 0, entered: 0, keptOut: 0, reads: 0, unbounded: 0 };
for (const file of list) {
  // the Read inputs, by tool_use_id, since transcript.js keeps only a description
  const inputs = new Map();
  const texts = new Map();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue; let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.isSidechain) continue;
    const c = o.message && o.message.content; if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (b.type === 'tool_use' && b.name === 'Read') inputs.set(b.id, b.input || {});
      if (b.type === 'tool_result' && inputs.has(b.tool_use_id)) texts.set(b.tool_use_id, T.resultText(b));
    }
  }
  const p = T.carry(T.parseTranscript(file));
  const total = p.results.reduce((s, r) => s + r.carried, 0);
  const rows = [];
  for (const r of p.results) {
    if (r.name !== 'Read' || !inputs.has(r.id)) continue;
    const inp = inputs.get(r.id);
    if (!PERSISTED.test(String(inp.file_path || ''))) continue;
    grand.reads++;
    const bounded = inp.limit != null || inp.offset != null;
    const text = texts.get(r.id) || '';
    const kept = bounded ? text : text.split('\n').slice(0, LIMIT).join('\n');
    const keptTok = Math.round(kept.length / T.CHARS_PER_TOKEN);
    if (!bounded) grand.unbounded++;
    rows.push({ what: inp.file_path.replace(/^.*\//, ''), bounded, tokens: r.tokens, keptTok, turns: r.carriedTurns, carried: r.carried, notCarried: (r.tokens - keptTok) * r.carriedTurns });
  }
  if (!rows.length) { console.log(`\n${p.sessionId.slice(0, 8)}  ${p.cwd}  — no reads of persisted outputs`); continue; }
  const pc = rows.reduce((s, x) => s + x.carried, 0), nc = rows.reduce((s, x) => s + x.notCarried, 0);
  const ent = rows.reduce((s, x) => s + x.tokens, 0), ko = rows.reduce((s, x) => s + (x.tokens - x.keptTok), 0);
  grand.carried += total; grand.persistedCarried += pc; grand.notCarried += nc; grand.entered += ent; grand.keptOut += ko;
  console.log(`\n${p.sessionId.slice(0, 8)}  ${p.cwd}  ${p.requests.length} requests, ${p.results.length} results`);
  console.log(`  reads of persisted outputs: ${rows.length} (${rows.filter(x => !x.bounded).length} unbounded), ${ent.toLocaleString()} tokens entered, ${pc.toLocaleString()} token-reads carried = ${(100 * pc / total).toFixed(0)}% of the session's ${total.toLocaleString()}`);
  console.log(`  with a ${LIMIT}-line cap on them: ${ko.toLocaleString()} tokens kept out, ${nc.toLocaleString()} token-reads not carried = ${(100 * nc / total).toFixed(0)}% of the session`);
  console.log('     size    kept   turns    carried  not carried  what');
  for (const x of rows.sort((a, b) => b.carried - a.carried).slice(0, 8))
    console.log(`  ${String(x.tokens).padStart(6)}  ${String(x.keptTok).padStart(6)}  ${String(x.turns).padStart(5)}  ${String(x.carried).padStart(9)}  ${String(x.notCarried).padStart(11)}  ${x.what}${x.bounded ? '  (bounded, untouched)' : ''}`);
}
if (list.length > 1 && grand.reads) console.log(`\nAll: ${grand.reads} reads of persisted outputs (${grand.unbounded} unbounded); ${grand.persistedCarried.toLocaleString()} of ${grand.carried.toLocaleString()} token-reads carried (${(100 * grand.persistedCarried / grand.carried).toFixed(0)}%); a ${LIMIT}-line cap keeps ${grand.keptOut.toLocaleString()} tokens out and ${grand.notCarried.toLocaleString()} token-reads uncarried (${(100 * grand.notCarried / grand.carried).toFixed(0)}%).`);
