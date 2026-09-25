// The weights from a `calibrate.mjs --plan` run (AB-TASK.md, 2026-09-24 amendment), fixed before the run.
//   node <repo>/scripts/calibrate-weights.mjs [path/to/calib.jsonl]   # default ./calib.jsonl
//   node <repo>/scripts/calibrate-weights.mjs --selftest              # recovers known weights from synthetic rows
//
// A span runs from one probe (included) to the next (excluded): the meter lags a message, so the closing probe's
// reading holds everything before it and nothing of itself. Each span gives one equation in points of the
// five-hour window: reads x a + writes x w + output x o = the meter's move, tokens in millions, writes counting
// cache writes plus uncached input. B1R, BW and B5 give three equations in three unknowns. The ranges take every
// combination of each move +-1 point (the meter's whole-point resolution). B1 and B4 are checks, not inputs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OPUS_5 = { read: 0.20, write: 8.9, output: 34 };
const RESOLUTION = 5;   // a span that moves less is below resolution (AB-TASK.md, calibration protocol)

export function spans(rows) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    if (r.kind !== 'probe') { if (cur) cur.rows.push(r); continue; }
    if (cur && cur.rows.length) out.push({ ...cur, close: r });   // a span with no rows is a wait for a reset
    cur = { open: r, rows: [] };
  }
  return out.map(s => {
    const all = [s.open, ...s.rows];
    const blocks = [...new Set(s.rows.map(r => r.block))];
    if (blocks.length !== 1) throw new Error('a span holds more than one block: ' + blocks.join(', '));
    const sum = (f) => all.reduce((t, r) => t + (f(r) || 0), 0) / 1e6;
    return {
      block: blocks[0], n: s.rows.length,
      R: sum(r => r.cacheRead), W: sum(r => (r.cacheWrite || 0) + (r.input || 0)), O: sum(r => r.output),
      move: Math.round((s.close.five - s.open.five) * 100),
      sameWindow: s.close.fiveResets === s.open.fiveResets,
      void: s.rows.filter(r => r.compacted && r.kind !== 'compact').length ? 'auto-compaction' : '',
    };
  });
}

function solve3(A, b) {   // Cramer's rule
  const det = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const d = det(A);
  if (Math.abs(d) < 1e-12) throw new Error('the three spans do not separate the three weights');
  return [0, 1, 2].map(k => det(A.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)))) / d);
}

export function weights(list) {
  const by = Object.fromEntries(list.map(s => [s.block, s]));
  const eq = ['B1R', 'BW', 'B5'].map(b => { if (!by[b]) throw new Error('no ' + b + ' span'); return by[b]; });
  const A = eq.map(s => [s.R, s.W, s.O]);
  const [read, write, output] = solve3(A, eq.map(s => s.move));
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < 27; k++) {
    const x = solve3(A, eq.map((s, i) => s.move + (Math.floor(k / 3 ** i) % 3) - 1));
    x.forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v); });
  }
  const w = { read, write, output };
  const pred = (s) => s.R * read + s.W * write + s.O * output;
  const c = by.B4;
  return {
    w, range: { read: [lo[0], hi[0]], write: [lo[1], hi[1]], output: [lo[2], hi[2]] },
    belowResolution: eq.filter(s => s.move < RESOLUTION).map(s => s.block),
    checks: ['B1', 'B4'].filter(b => by[b]).map(b => ({ block: b, move: by[b].move, predicted: pred(by[b]) })),
    // Compaction's own request is in no usage: its bound is the span's move at the top of its resolution, less the rest.
    compactBound: c ? c.move + 1 - pred(c) : null,
  };
}

function report(rows) {
  const list = spans(rows);
  const bad = list.filter(s => !s.sameWindow || s.void);
  const f = (x, d = 2) => x.toFixed(d);
  console.log('span   rows  reads M  writes M  output M  move');
  for (const s of list) console.log(`${s.block.padEnd(5)} ${String(s.n).padStart(5)}  ${f(s.R).padStart(7)}  ${f(s.W, 3).padStart(8)}  ${f(s.O, 3).padStart(8)}  ${String(s.move).padStart(4)}${s.sameWindow ? '' : '  VOID: window reset'}${s.void ? '  VOID: ' + s.void : ''}`);
  if (bad.length) { console.log('\nVoid spans: no weights.'); process.exitCode = 1; return; }
  const r = weights(list);
  console.log('\nweight (points per million)  estimate  range            Opus 5');
  for (const k of ['read', 'write', 'output']) {
    const [lo, hi] = r.range[k];
    console.log(`${k.padEnd(28)} ${f(r.w[k]).padStart(8)}  ${(f(lo) + ' - ' + f(hi)).padEnd(15)}  ${String(OPUS_5[k]).padStart(6)}${OPUS_5[k] >= lo && OPUS_5[k] <= hi ? '  inside' : '  OUTSIDE'}`);
  }
  console.log(`\nper token, relative to a cache read: write ${f(r.w.write / r.w.read, 0)} (the API says 20), output ${f(r.w.output / r.w.read, 0)} (the API says 50)`);
  if (r.belowResolution.length) console.log('below resolution (moved under ' + RESOLUTION + ' points): ' + r.belowResolution.join(', '));
  for (const c of r.checks) console.log(`check ${c.block}: moved ${c.move}, the weights predict ${f(c.predicted, 1)}`);
  if (r.compactBound !== null) console.log(`compaction's own draw, bound: ${f(r.compactBound, 1)} points (Opus 5: 1.6)`);
}

function selftest() {
  const truth = { read: 0.17, write: 7.4, output: 29 };
  const rows = [];
  let exact = 12.3, t = 0;
  const push = (block, kind, read, write, output) => {
    rows.push({ t: t++, block, kind, cacheRead: read, cacheWrite: write, input: 2, output, five: Math.floor(exact) / 100, fiveResets: 1 });
    exact += (read * truth.read + (write + 2) * truth.write + output * truth.output) / 1e6;
  };
  const probe = () => push('P', 'probe', 17096, 9000, 4);
  probe(); push('B1', 'build', 17096, 394615, 4); for (let i = 0; i < 20; i++) push('B1', 'msg', 411000, 9000, 4);
  probe(); for (let i = 0; i < 60; i++) push('B1R', 'msg', 425000, 9000, 4);
  probe(); push('B4', 'compact', 0, 0, 0); for (let i = 0; i < 20; i++) push('B4', 'msg', 30000, 9000, 4);
  probe(); for (let i = 0; i < 3; i++) push('BW', 'build', 17096, 394615, 4);
  probe(); for (let i = 0; i < 40; i++) push('B5', 'msg', 20000 + i * 10000, 10000, 9900);
  probe();
  const r = weights(spans(rows));
  const ok = ['read', 'write', 'output'].every(k => truth[k] >= r.range[k][0] && truth[k] <= r.range[k][1]);
  console.log((ok ? 'ok' : 'FAIL') + ': recovered ' + JSON.stringify(r.w) + ' within ' + JSON.stringify(r.range) + ', truth ' + JSON.stringify(truth));
  if (!ok) process.exitCode = 1;
}

if (process.argv.includes('--selftest')) selftest();
else {
  const file = process.argv.slice(2).find(a => !a.startsWith('--')) || join(process.cwd(), 'calib.jsonl');
  report(readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l)));
}
