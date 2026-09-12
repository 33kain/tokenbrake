#!/usr/bin/env node
/* session-hooks-compare — find sessions on this machine, say which ran with the tokenbrake hooks on and
   which did not, and print the token output per session in a table split by that answer.
 *
 * What this can and cannot do, stated up front because the difference is the whole point of the A/B pages
 * in AB-TASK.md. A Claude Code session runs with the hooks ON or OFF for its whole life — never both. So
 * "the same session with hooks off" is a counterfactual no transcript can hold: an on-vs-off number is a
 * comparison of two *different* sessions running the same task (the paired arms of the A/B protocol), which
 * is exactly what `node cli.js report --compare <A> <B>` renders. This tool does the honest, measurable
 * thing underneath that request: it takes the sessions that actually exist, classifies each one, and lays
 * out their token output grouped by config, so that when both an on session and an off session are present
 * you can read them side by side.
 *
 * How the classification is grounded (not guessed):
 *   - LEDGER PRESENCE is the authority. With the hooks on, the PostToolUse guard fires on every tool call
 *     and appends a row to `<config>/tokenbrake/ledger.jsonl` keyed by session id — even when nothing
 *     crossed the trim threshold (the debugging-round nulls in AB-TASK.md). So a session id present in the
 *     ledger ⇒ the guard ran ⇒ hooks were ON.
 *   - THE TRANSCRIPT MARKER corroborates. parseTranscript tags each tool result with `marker` when its
 *     text carries the guard's `[tokenbrake]` rewrite. Any marked result ⇒ hooks were ON. Absence of a
 *     marker does NOT prove OFF (the guard may have had nothing to trim), so it is corroboration only.
 *   - NO LEDGER ROWS AND NO MARKERS is "no evidence the hooks ran". That is what an OFF session looks like,
 *     but it is also what an ON session looks like after its ledger was cleared (`cli.js clean`) with
 *     nothing ever trimmed. The tool labels this "off (no trace)" and says so, rather than claiming proof.
 *
 * Usage:
 *   node session-hooks-compare.mjs               scan real sessions, print the table
 *   node session-hooks-compare.mjs --n=10        sample at most N sessions at random (default 10)
 *   node session-hooks-compare.mjs --all         every session found, no sampling
 *   node session-hooks-compare.mjs --seed=123    fix the random sample so a run repeats
 *   node session-hooks-compare.mjs --md          emit the table as GitHub-flavored markdown
 *   node session-hooks-compare.mjs --selftest    build synthetic fixtures and assert the classifier + table
 *
 * Zero dependencies, reuses transcript.js. The token numbers for real sessions come straight from that
 * module's accounting; the selftest's numbers are synthetic fixtures and are labelled as such — this tool
 * never presents fabricated numbers as measurements.
 */

import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const transcript = require(path.join(here, 'transcript.js'));

const CFG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const LEDGER = (cfg) => path.join(cfg, 'tokenbrake', 'ledger.jsonl');

function loadLedger(cfg) {
  try {
    return fs.readFileSync(LEDGER(cfg), 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/* The classifier. Pure: (parsed transcript, ledger rows) -> a verdict with its evidence, so the selftest
   can assert it without a config dir or a console. See the header for why the ledger is the authority and
   the marker only corroborates. */
function classify(parsed, ledgerRecs) {
  const sid = String(parsed.sessionId || path.basename(parsed.file, '.jsonl'));
  const rows = ledgerRecs.filter(r => r && r.session === sid);
  const postRows = rows.filter(r => r.ev === 'post').length;
  const readCaps = rows.filter(r => r.ev === 'read-cap').length;
  const trims = rows.filter(r => r.ev === 'post' && r.kept != null && r.chars != null && r.kept < r.chars).length;
  const markers = parsed.results.filter(r => r.marker).length;
  const hooksOn = rows.length > 0 || markers > 0;
  const evidence = [];
  if (postRows) evidence.push(`${postRows} ledger row${postRows === 1 ? '' : 's'}`);
  if (trims) evidence.push(`${trims} trimmed`);
  if (readCaps) evidence.push(`${readCaps} read-cap${readCaps === 1 ? '' : 's'}`);
  if (markers) evidence.push(`${markers} marker${markers === 1 ? '' : 's'} in transcript`);
  return {
    session: sid,
    hooksOn,
    // "on" when the ledger saw it; "on (marker only)" when only the transcript proves it; "off (no trace)"
    // otherwise — the last is the absence of evidence, not evidence of absence, and the label says so.
    label: rows.length ? 'on' : (markers > 0 ? 'on (marker only)' : 'off (no trace)'),
    evidence: evidence.length ? evidence.join(', ') : 'none',
    counts: { postRows, readCaps, trims, markers },
  };
}

/* One session's token output, from transcript.js's own accounting, plus the verdict. */
function sessionRow(parsed, ledger) {
  const facts = transcript.sessionFacts(parsed, ledger);   // runs carry() internally
  const verdict = classify(parsed, ledger);
  return { ...facts, ...verdict, file: parsed.file };
}

const kfmt = (n) => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(Math.round(n));
const money = (r) => r.unpriced ? '$' + r.cost.toFixed(2) + '*' : '$' + r.cost.toFixed(2);

/* The table, as text. Columns are the token output per session (the user's ask), ordered hooks-on first
   then hooks-off so the two groups read as two blocks. `md` switches to a markdown table. */
function renderTable(rows, { md = false } = {}) {
  const on = rows.filter(r => r.hooksOn);
  const off = rows.filter(r => !r.hooksOn);
  const cols = ['session', 'hooks', 'model', 'requests', 'output tok', 'processed', 'entered', 'carried', 'trimmed', 'cost'];
  const cell = (r) => [
    r.session.slice(0, 8),
    r.label,
    (r.model || '?').replace(/^claude-/, ''),
    String(r.requests),
    kfmt(r.out),
    kfmt(r.processed),
    kfmt(r.entered),
    kfmt(r.carried),
    r.trimmed ? `${r.trimmed} (≈${kfmt(r.keptOut)})` : '0',
    money(r),
  ];
  const body = [...on, ...off].map(cell);
  const out = [];
  if (md) {
    out.push('| ' + cols.join(' | ') + ' |');
    out.push('|' + cols.map(() => '---').join('|') + '|');
    for (const c of body) out.push('| ' + c.join(' | ') + ' |');
  } else {
    const w = cols.map((h, i) => Math.max(h.length, ...body.map(c => c[i].length)));
    const line = (c) => c.map((v, i) => v.padEnd(w[i])).join('  ');
    out.push(line(cols));
    out.push(w.map(x => '-'.repeat(x)).join('  '));
    for (const c of body) out.push(line(c));
  }
  return { text: out.join('\n'), on: on.length, off: off.length };
}

/* A seeded shuffle so --seed makes a sample repeatable; without a seed it is Math.random. */
function sample(arr, n, seed) {
  const a = [...arr];
  let rnd = Math.random;
  if (seed != null) { let s = seed >>> 0 || 1; rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

function scan(cfg, { n = 10, all = false, seed = null, md = false } = {}) {
  const found = transcript.findTranscripts(cfg);
  const ledger = loadLedger(cfg);
  const out = [];
  out.push(`Config dir: ${cfg}`);
  out.push(`Ledger:     ${LEDGER(cfg)} (${ledger.length} rows)`);
  out.push(`Sessions found under projects/: ${found.length}`);
  if (!found.length) {
    out.push('');
    out.push('No session transcripts on this machine. Run some Claude Code sessions (with and without the');
    out.push('hooks) and try again, or point CLAUDE_CONFIG_DIR at a config dir that has them.');
    return out.join('\n');
  }
  const chosen = all ? found : sample(found, Math.min(n, found.length), seed);
  out.push(all ? `Using all ${chosen.length}.` : `Sampled ${chosen.length} at random${seed != null ? ` (seed ${seed})` : ''}.`);
  out.push('');

  const rows = [];
  for (const f of chosen) {
    try { rows.push(sessionRow(transcript.parseTranscript(f.file), ledger)); }
    catch (e) { out.push(`  (skipped ${f.session.slice(0, 8)}: ${e.message})`); }
  }
  const { text, on, off } = renderTable(rows, { md });
  out.push(text);
  out.push('');
  out.push(`Groups: ${on} with hooks on, ${off} with no trace of hooks.`);

  if (on && off) {
    out.push('');
    out.push('Both groups are present, so the table above shows token output for hooks-on and hooks-off');
    out.push('sessions side by side. Note: these are different sessions doing different work, so the gap');
    out.push('between the groups is not attributable to the hooks alone. A clean on-vs-off delta needs two');
    out.push('sessions running the *same* task (the A/B arms); render that with:');
    out.push('    node cli.js report --compare <off-session.jsonl> <on-session.jsonl>');
  } else if (on && !off) {
    out.push('');
    out.push('Every session here ran with the hooks on, so there is no hooks-off arm to compare against.');
    out.push('An on-vs-off table needs a session that ran with the hooks off (a checkout on a commit before');
    out.push('`.claude/settings.json`, or `{"enabled": false}` in ~/.claude/tokenbrake.json). The measured');
    out.push('paired arms live in AB-TASK.md and in 33kain/contexa\'s ab-results/real/ branches.');
  } else {
    out.push('');
    out.push('No session here shows a trace of the hooks. Either they were off, or the ledger was cleared;');
    out.push('this tool cannot tell those apart from a transcript alone.');
  }
  return out.join('\n');
}

/* ---------- selftest: prove the classifier and the table on synthetic fixtures ---------- */

let PASS = 0, FAIL = 0;
const t = (name, cond) => { if (cond) { PASS++; console.log('ok   ' + name); } else { FAIL++; console.log('FAIL ' + name); } };

function writeTranscript(file, sid, { marked = false, model = 'claude-opus-5', requests = 2 } = {}) {
  const lines = [];
  for (let i = 0; i < requests; i++) {
    lines.push(JSON.stringify({
      type: 'assistant', uuid: 'u' + i, requestId: 'r' + i, timestamp: new Date().toISOString(),
      cwd: '/fixture', sessionId: sid, version: '2.1.261',
      message: { model, usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 100, output_tokens: 50 },
        content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: `echo step ${i}` } }] },
    }));
    const body = 'x'.repeat(4000);
    const text = (marked && i === 0) ? `[tokenbrake] trimmed from 27,798 chars\n${body}` : body;
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: text }] } }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shc-'));
  const projDir = path.join(tmp, 'projects', '-fixture');
  fs.mkdirSync(projDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, 'tokenbrake'), { recursive: true });

  const ON = 'aaaaaaaa-0000-0000-0000-000000000000';   // hooks on: ledger rows incl a trim + a read-cap, and a marker
  const ONQ = 'cccccccc-0000-0000-0000-000000000000';  // hooks on but quiet: ledger rows, nothing trimmed, no marker
  const OFF = 'bbbbbbbb-0000-0000-0000-000000000000';  // hooks off: transcript only, no ledger, no marker

  writeTranscript(path.join(projDir, ON + '.jsonl'), ON, { marked: true });
  writeTranscript(path.join(projDir, ONQ + '.jsonl'), ONQ, { marked: false });
  writeTranscript(path.join(projDir, OFF + '.jsonl'), OFF, { marked: false });

  const ledgerRows = [
    { t: 1, ev: 'post', session: ON, tool: 'Bash', chars: 27798, kept: 5998, what: 'echo step 0', id: 't0' },
    { t: 2, ev: 'read-cap', session: ON, tool: 'Read', what: '/fixture/big.md', bytes: 141711, lines: 2046, limit: 300, persisted: false },
    { t: 3, ev: 'post', session: ON, tool: 'Bash', chars: 1465, what: 'echo step 1', id: 't1' },
    { t: 4, ev: 'post', session: ONQ, tool: 'Bash', chars: 1200, what: 'echo step 0', id: 't0' },
    { t: 5, ev: 'post', session: ONQ, tool: 'Bash', chars: 1300, what: 'echo step 1', id: 't1' },
  ];
  fs.writeFileSync(LEDGER(tmp), ledgerRows.map(r => JSON.stringify(r)).join('\n') + '\n');

  const ledger = loadLedger(tmp);
  const pOn = transcript.parseTranscript(path.join(projDir, ON + '.jsonl'));
  const pOnQ = transcript.parseTranscript(path.join(projDir, ONQ + '.jsonl'));
  const pOff = transcript.parseTranscript(path.join(projDir, OFF + '.jsonl'));

  const cOn = classify(pOn, ledger), cOnQ = classify(pOnQ, ledger), cOff = classify(pOff, ledger);

  t('ledger loads all fixture rows', ledger.length === 5);
  t('on session classified hooks-on', cOn.hooksOn === true && cOn.label === 'on');
  t('on session evidence names the trim and the read-cap', /trimmed/.test(cOn.evidence) && /read-cap/.test(cOn.evidence));
  t('on session sees the transcript marker', cOn.counts.markers === 1);
  t('quiet-on session classified hooks-on from the ledger alone', cOnQ.hooksOn === true && cOnQ.label === 'on');
  t('quiet-on session has no marker', cOnQ.counts.markers === 0 && cOnQ.counts.trims === 0);
  t('off session classified hooks-off', cOff.hooksOn === false && cOff.label === 'off (no trace)');
  t('off session evidence is none', cOff.evidence === 'none');

  // the classifier must not leak one session's ledger rows into another
  t('off session sees zero ledger rows', cOff.counts.postRows === 0);
  t('on session counts only its own rows', cOn.counts.postRows === 2);

  // token output must come through for every session (the sessionFacts join)
  const rOn = sessionRow(pOn, ledger), rOff = sessionRow(pOff, ledger);
  t('on session reports a positive processed-token total', rOn.processed > 0);
  t('off session reports a positive processed-token total', rOff.processed > 0);
  t('on session reports the trim in its facts', rOn.trimmed === 1 && rOn.keptOut > 0);
  t('off session reports zero trims', rOff.trimmed === 0);

  // the table groups on before off and contains all three sessions
  const rows = [pOff, pOn, pOnQ].map(p => sessionRow(p, ledger));
  const { text, on, off } = renderTable(rows);
  t('table counts two on and one off', on === 2 && off === 1);
  t('table lists on sessions before the off session', text.indexOf('aaaaaaaa') < text.indexOf('bbbbbbbb') && text.indexOf('cccccccc') < text.indexOf('bbbbbbbb'));
  t('table renders every session', ['aaaaaaaa', 'bbbbbbbb', 'cccccccc'].every(s => text.includes(s)));

  const md = renderTable(rows, { md: true }).text;
  t('markdown table has a header separator', /\|---\|/.test(md.replace(/ /g, '')));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}

/* ---------- entry ---------- */
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, d) => { const a = args.find(x => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : d; };

if (flag('--selftest')) {
  selftest();
} else {
  const n = parseInt(opt('--n', '10'), 10);
  const seedRaw = opt('--seed', null);
  console.log(scan(CFG_DIR, { n, all: flag('--all'), seed: seedRaw == null ? null : parseInt(seedRaw, 10), md: flag('--md') }));
}
