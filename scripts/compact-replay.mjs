// Replay the owner's sessions under a lower auto-compact window, or a /clear at each break, and price the
// difference with the calibrated weights (AB-TASK.md, "Calibration results"). Offline: no request is sent.
//
//   node scripts/compact-replay.mjs [--post=50000] [--summary=7000]
//
// What it models: context size per request from the transcript's own usage (cache read + write + input). Under a
// window W, when the context would pass W the session compacts to `post` tokens and keeps growing from there;
// every later request re-reads that much less, and a cold rebuild rewrites that much less. Each compaction costs
// a cached read of the whole context, a summary's output, and a fresh write of `post`. A /clear costs nothing and
// returns the context to the session's own first-request size.
// What it does not model: the re-reads the model makes after a compaction or clear because detail was lost.
// That is behavioural, not in any transcript, and it is what the paid A/B measures. Every saving here is an
// upper bound on that account.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const W = { read: 0.20, write: 8.9, output: 34 };   // points of the five-hour window per million tokens (Opus 5)
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? Number(a.split('=')[1]) : d; };
const POST = arg('post', 50_000);
const SUMMARY = arg('summary', 7_000);
const COLD_MS = 60 * 60_000;
const BREAK_MS = 10 * 60_000;
const SKIP = /scratchpad|calibration|tokenbrake-bench/i;

function files(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else if (e.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const sessions = [];
for (const f of files(join(homedir(), '.claude', 'projects'))) {
  if (SKIP.test(f)) continue;
  const seen = new Set(), reqs = [];
  let skip = false;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.cwd && SKIP.test(e.cwd)) { skip = true; break; }
    const u = e.message?.usage;
    if (e.type !== 'assistant' || !u) continue;
    const id = e.requestId || e.message.id;
    if (seen.has(id)) continue; seen.add(id);
    const read = u.cache_read_input_tokens || 0, write = (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0);
    reqs.push({ t: Date.parse(e.timestamp), read, write, output: u.output_tokens || 0, ctx: read + write });
  }
  if (!skip && reqs.length) sessions.push(reqs.sort((a, b) => a.t - b.t));
}

const draw = r => (r.read * W.read + r.write * W.write + r.output * W.output) / 1e6;
const base = sessions.reduce((s, reqs) => s + reqs.reduce((x, r) => x + draw(r), 0), 0);

// mode: { window } or { clearAbove } — returns points saved (before and after compaction costs) and event count.
function replay(mode) {
  let readSaved = 0, writeSaved = 0, cost = 0, events = 0;
  for (const reqs of sessions) {
    const floor = reqs[0].ctx;
    let offset = 0, prev = 0;
    reqs.forEach((r, i) => {
      if (r.ctx < prev * 0.5) offset = 0;              // the session compacted or cleared for real: start over
      prev = r.ctx;
      const gap = i ? r.t - reqs[i - 1].t : 0;
      let sim = r.ctx - offset;
      if (mode.window && sim > mode.window) {
        cost += (sim * W.read + SUMMARY * W.output + POST * W.write) / 1e6;
        offset += sim - POST; sim = POST; events++;
      }
      if (mode.clearAbove && i && gap >= BREAK_MS && sim > mode.clearAbove) {
        offset += sim - floor; sim = floor; events++;
        cost += (floor * W.write) / 1e6;               // the cleared session writes its floor fresh
      }
      if (!offset) return;
      const cold = i && gap > COLD_MS && r.write >= 20_000;
      readSaved += Math.min(offset, r.read);
      if (cold) writeSaved += Math.min(offset, r.write);
    });
  }
  const gross = (readSaved * W.read + writeSaved * W.write) / 1e6;
  return { gross, cost, net: gross - cost, events, readSaved };
}

const pct = x => (100 * x / base).toFixed(1) + '%';
console.log(`${sessions.length} transcripts, ${sessions.reduce((s, r) => s + r.length, 0)} requests, weighted draw ${base.toFixed(0)} points`);
console.log(`post-compaction context ${POST / 1000}k, summary ${SUMMARY / 1000}k output\n`);
for (const mode of [{ window: 500_000 }, { window: 300_000 }, { window: 200_000 }, { window: 100_000 },
  { clearAbove: 200_000 }, { clearAbove: 100_000 }]) {
  const r = replay(mode);
  const label = mode.window ? `compact at ${mode.window / 1000}k` : `/clear at a break, above ${mode.clearAbove / 1000}k`;
  console.log(`${label.padEnd(32)} events ${String(r.events).padStart(4)}  re-reads saved ${(r.readSaved / 1e6).toFixed(0).padStart(4)}M  ` +
    `gross ${pct(r.gross).padStart(6)}  cost ${pct(r.cost).padStart(5)}  net ${pct(r.net).padStart(6)}`);
}
