// Where the window's writes go. Read-only, over this machine's transcripts (HANDOFF.md, 2026-09-25). Each request's
// write (cache writes plus uncached input) is split into what is new since the previous request and what re-writes
// context that was already cached: the previous request's context minus what this one read from cache. A re-write
// of at least --min tokens (default 5,000) is an event, attributed to the first cause that fits: the session's first
// request, a compaction, an idle gap longer than the cache's 1-hour life, a model switch, or none of those
// (an unexplained miss). Priced per request with its model's weights; requests on uncalibrated models are skipped.
//   node scripts/write-reach.cjs [--min=N]
const path = require('path'), os = require('os');
const T = require(path.join(__dirname, '..', 'transcript.js'));
const CFG = path.join(os.homedir(), '.claude');
const MIN = +(process.argv.find(a => a.startsWith('--min='))?.slice(6) || 5000);
const HOUR = 3600e3;

const ctx = (u) => u ? (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0) : 0;
const causes = ['session start', 'compaction', 'idle > 1h', 'model switch', 'unexplained'];
const ev = Object.fromEntries(causes.map(c => [c, { n: 0, tokens: 0, pts: 0, sessions: new Set(), sizes: [], gaps: [] }]));
let pool = 0, drawPts = 0, readPts = 0, writePts = 0, outPts = 0, newTok = 0, newPts = 0, resultTok = 0;
const topSessions = new Map();

for (const f of T.findTranscripts(CFG)) {
  let p; try { p = T.parseTranscript(f.file); } catch { continue; }
  if (T.stagedCwd(p.cwd) || T.formatWarning(p) || p.requests.length < 10) continue;
  pool++;
  const d = T.limitDraw(p); drawPts += d.read + d.write + d.output; readPts += d.read; writePts += d.write; outPts += d.output;
  resultTok += p.results.reduce((a, r) => a + r.tokens, 0);
  const compactAt = new Set(p.boundaries.map(b => b.atReq));
  let prev = null;   // the previous request with usage
  for (let i = 0; i < p.requests.length; i++) {
    const q = p.requests[i], u = q.usage;
    if (!u || !ctx(u)) continue;
    const W = T.weightsOf(q.model);
    const write = (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0);
    const lost = prev ? Math.max(0, ctx(prev.usage) - (u.cache_read_input_tokens || 0)) : write;
    const rewrite = Math.min(write, lost), fresh = write - rewrite;
    const compacted = [...compactAt].some(k => prev && k > prev.i && k <= i);
    if (W) { newTok += fresh; newPts += fresh * W.write / 1e6; }
    if (rewrite >= MIN && W) {
      const gap = prev ? (Date.parse(q.at) - Date.parse(prev.q.at)) : 0;
      const cause = !prev ? 'session start' : compacted ? 'compaction' : gap > HOUR ? 'idle > 1h'
        : prev.q.model !== q.model ? 'model switch' : 'unexplained';
      const e = ev[cause], pts = rewrite * W.write / 1e6;
      e.n++; e.tokens += rewrite; e.pts += pts; e.sessions.add(f.session); e.sizes.push(rewrite); e.gaps.push(gap);
      const s = topSessions.get(f.session) || { pts: 0, cwd: p.cwd, events: 0 }; s.pts += pts; s.events++; topSessions.set(f.session, s);
    } else if (W) { newTok += rewrite; newPts += rewrite * W.write / 1e6; }   // below the event floor: counted as ordinary
    prev = { q, usage: u, i };
  }
}

const k = T.kfmt, pc = (a) => (100 * a / drawPts).toFixed(1) + '%';
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
console.log(`pool: ${pool} sessions, ~${drawPts.toFixed(0)} pts drawn: reads ${pc(readPts)}, writes ${pc(writePts)}, output ${pc(outPts)}`);
console.log(`new content written: ${k(newTok)} tokens, ~${newPts.toFixed(1)} pts (${pc(newPts)}); tool results entered ~${k(resultTok)} of it (chars/4)`);
console.log(`re-writes of cached context (events >= ${k(MIN)}):`);
for (const c of causes) {
  const e = ev[c];
  console.log(`  ${c.padEnd(14)} ${String(e.n).padStart(4)} events in ${String(e.sessions.size).padStart(2)} sessions  ${k(e.tokens).padStart(7)} tokens  ~${e.pts.toFixed(1).padStart(5)} pts (${pc(e.pts)})  median ${k(med(e.sizes))}`
    + (c === 'idle > 1h' || c === 'unexplained' ? `, median gap ${Math.round(med(e.gaps) / 60e3)} min` : ''));
}
console.log('sessions with the most re-write:');
for (const [s, v] of [...topSessions].sort((a, b) => b[1].pts - a[1].pts).slice(0, 6))
  console.log(`  ${s.slice(0, 8)}  ~${v.pts.toFixed(1)} pts in ${v.events} events  ${(v.cwd || '').slice(-40)}`);
