// Apply the calibrated weights to every Claude Code session on this machine (the owner's pool).
// Points of the five-hour window per million tokens, Opus 5, measured 2026-09-18 (AB-TASK.md, calibration results).
// Run it from anywhere: node scripts/calibrate-pool.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const W = { read: 0.20, write: 8.9, output: 34 };
const ROOT = join(homedir(), '.claude', 'projects');
const COLD_MS = 60 * 60_000;

function files(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (e.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const tot = { read: 0, write: 0, writeCold: 0, writeMiss: 0, output: 0, requests: 0, sessions: 0, coldEvents: 0, missEvents: 0 };
const perSession = [];
for (const f of files(ROOT)) {
  if (/scratchpad|calibration|tokenbrake-bench/i.test(f)) continue;
  const seen = new Set();
  const reqs = [];
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.cwd && /scratchpad|calibration|tokenbrake-bench/i.test(e.cwd)) { reqs.length = 0; break; }
    const m = e.message; const u = m?.usage;
    if (e.type !== 'assistant' || !u) continue;
    const id = e.requestId || m.id;
    if (seen.has(id)) continue; seen.add(id);
    reqs.push({ t: Date.parse(e.timestamp), read: u.cache_read_input_tokens || 0, write: u.cache_creation_input_tokens || 0,
      input: u.input_tokens || 0, output: u.output_tokens || 0 });
  }
  if (!reqs.length) continue;
  const s = { f, read: 0, write: 0, writeCold: 0, writeMiss: 0, output: 0, n: reqs.length };
  reqs.sort((a, b) => a.t - b.t);
  reqs.forEach((r, i) => {
    const w = r.write + r.input;                     // uncached input counted with writes (it is processed fresh)
    s.read += r.read; s.output += r.output;
    const gap = i ? r.t - reqs[i - 1].t : 0;
    if (i && gap > COLD_MS && w >= 20_000) { s.writeCold += w; tot.coldEvents++; }
    else if (i && w >= 20_000 && w > r.read) { s.writeMiss += w; tot.missEvents++; }   // rewrote more than it read
    else s.write += w;
  });
  for (const k of ['read', 'write', 'writeCold', 'writeMiss', 'output']) tot[k] += s[k];
  tot.requests += s.n; tot.sessions++;
  perSession.push(s);
}

const pts = {
  read: tot.read / 1e6 * W.read,
  write: tot.write / 1e6 * W.write,
  cold: tot.writeCold / 1e6 * W.write,
  miss: tot.writeMiss / 1e6 * W.write,
  output: tot.output / 1e6 * W.output,
};
const all = Object.values(pts).reduce((a, b) => a + b, 0);
const M = x => (x / 1e6).toFixed(1) + 'M';
console.log(`${tot.sessions} sessions, ${tot.requests} requests`);
console.log(`tokens: read ${M(tot.read)}  write ${M(tot.write)}  cold ${M(tot.writeCold)} (${tot.coldEvents})  miss/rebuild ${M(tot.writeMiss)} (${tot.missEvents})  output ${M(tot.output)}`);
for (const [k, v] of Object.entries(pts)) console.log(`  ${k.padEnd(7)} ${v.toFixed(0).padStart(6)} pts  ${(100 * v / all).toFixed(1)}%`);
console.log(`  total   ${all.toFixed(0).padStart(6)} pts (weighted, five-hour-window points)`);
// Robustness: shares under the ends of each weight's range.
for (const [label, w] of [["low read/high write", { read: 0.15, write: 10.0, output: 34 }], ["high read/low write", { read: 0.26, write: 7.8, output: 34 }],
  ["output 30", { ...W, output: 30 }], ["output 38", { ...W, output: 38 }]]) {
  const p = [tot.read * w.read, (tot.write + tot.writeCold + tot.writeMiss) * w.write, tot.writeCold * w.write + tot.writeMiss * w.write, tot.output * w.output].map(x => x / 1e6);
  const a = p[0] + p[1] + p[3];
  console.log(`  [${label}] read ${(100 * p[0] / a).toFixed(1)}%  writes ${(100 * p[1] / a).toFixed(1)}% (cold+miss ${(100 * p[2] / a).toFixed(1)}%)  output ${(100 * p[3] / a).toFixed(1)}%`);
}
