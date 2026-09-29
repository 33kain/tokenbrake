// coldWarn's pilot, check 1: does a cache read refresh the cache's 1-hour life? Read-only, over this machine's
// unstaged transcripts, by the rule AB-TASK.md recorded on 2026-09-30 before any of it was read.
//   A late read is a sized request C with an anchor W, the latest sized request at least 65 minutes before it, with
//   no compaction, no model change, no 5-minute cache write and no gap over 55 minutes between them. Everything W
//   read or wrote was written at or before W, so without a refresh it has expired by C. C is refreshed when its cache
//   read, less every token written after W, is at least 50,000; not refreshed when it read under 50,000 and wrote at
//   least 50,000; otherwise undecided. Sessions are the unit. The idle case is a refreshed late read whose chain has
//   a gap of 40 minutes or more.
//   node scripts/coldwarn-refresh.cjs
const path = require('path'), os = require('os');
const T = require(path.join(__dirname, '..', 'transcript.js'));
const CFG = path.join(os.homedir(), '.claude');
const MIN = 60e3, SPAN = 65 * MIN, GAP = 55 * MIN, IDLE = 40 * MIN, OLD = 50000;

const ctx = (u) => u ? (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0) : 0;
const written = (u) => (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0);
const fiveMin = (u) => ((u.cache_creation && u.cache_creation.ephemeral_5m_input_tokens) || 0) > 0;

let pooled = 0;
const sessions = [];
for (const f of T.findTranscripts(CFG)) {
  let p; try { p = T.parseTranscript(f.file); } catch { continue; }
  if (T.formatWarning(p) || T.staged(p)) continue;
  pooled++;
  // Sized requests with a timestamp; a sized request with none breaks every chain through it.
  const s = [];
  p.requests.forEach((q, i) => { if (ctx(q.usage) > 0) s.push({ i, q, t: Date.parse(q.at) }); });
  const cut = new Set(p.boundaries.map((b) => b.atReq));
  const between = (a, b) => { for (let k = a + 1; k <= b; k++) if (cut.has(k)) return true; return false; };
  const e = { id: String(p.sessionId || path.basename(f.file, '.jsonl')).slice(0, 8), refreshed: 0, not: 0, undecided: 0, idle: 0, misses: [] };
  for (let c = 1; c < s.length; c++) {
    const C = s[c];
    if (!Number.isFinite(C.t) || fiveMin(C.q.usage)) continue;
    let after = 0, idle = false, w = -1;
    for (let j = c - 1; j >= 0; j--) {
      const a = s[j], b = s[j + 1];
      if (!Number.isFinite(a.t) || a.q.model !== C.q.model || fiveMin(a.q.usage) || between(a.i, b.i)) break;
      const gap = b.t - a.t;
      if (gap > GAP) break;
      if (gap >= IDLE) idle = true;
      if (C.t - a.t >= SPAN) { w = j; break; }
      after += written(a.q.usage);   // a is after the anchor (not yet found), so what it wrote is newer than W
    }
    if (w < 0) continue;
    const u = C.q.usage, read = u.cache_read_input_tokens || 0;
    if (read - after >= OLD) { e.refreshed++; if (idle) e.idle++; }
    else if (read < OLD && written(u) >= OLD) { e.not++; e.misses.push({ at: C.q.at, read, wrote: written(u), anchorMin: Math.round((C.t - s[w].t) / MIN) }); }
    else e.undecided++;
  }
  if (e.refreshed + e.not + e.undecided) sessions.push(e);
}

const refreshed = sessions.filter((e) => e.refreshed && !e.not), not = sessions.filter((e) => e.not);
const decided = refreshed.length + not.length, idle = sessions.filter((e) => e.idle && !e.not);
console.log('Pooled ' + pooled + ' unstaged session(s); ' + sessions.length + ' have a late read.');
console.log('  late reads: ' + sessions.reduce((t, e) => t + e.refreshed, 0) + ' refreshed, ' + sessions.reduce((t, e) => t + e.not, 0)
  + ' not refreshed, ' + sessions.reduce((t, e) => t + e.undecided, 0) + ' undecided');
console.log('  sessions: ' + refreshed.length + ' refreshed, ' + not.length + ' not refreshed (of ' + decided + ' decided), '
  + (sessions.length - decided) + ' undecided only; idle case in ' + idle.length);
for (const e of not) for (const m of e.misses) console.log('  not refreshed: ' + e.id + ' ' + m.at + '  read ' + m.read + ', wrote ' + m.wrote + ', anchor ' + m.anchorMin + ' min before');
const pass = refreshed.length >= 5 && not.length <= 0.1 * decided && idle.length >= 3;
const verdict = not.length > 0.1 * decided ? 'FAIL: reads do not keep the cache alive; coldWarn stops'
  : idle.length < 3 ? 'NOT SETTLED: the idle case is in fewer than 3 sessions; check 1 runs as pre-registered'
  : pass ? 'PASS' : 'NOT SETTLED: fewer than 5 refreshed sessions';
console.log('Check 1: ' + verdict);
