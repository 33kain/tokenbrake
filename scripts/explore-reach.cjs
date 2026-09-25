// Would steering exploration into subagents save window? Read-only, over this machine's transcripts (HANDOFF.md,
// 2026-09-25). A phase is >= --min (default 3) read-only results in a row inside one user turn. As run, it costs
// the main context re-read on each of its requests plus its results carried afterwards; delegated, a subagent
// makes the same requests from its own base (measured: its first request's cache write) and hands back a report
// (measured: the median subagent's last text, or --summary=N). Priced with the Opus 5.5 weights.
//   node scripts/explore-reach.cjs [--min=N] [--summary=N]
const fs = require('fs'), path = require('path'), os = require('os');
const T = require(path.join(__dirname, '..', 'transcript.js'));
// A headless `claude -p` session (entrypoint sdk-cli) is scripted work wherever it ran, not the owner's.
const headless = (file) => /"entrypoint":"sdk-cli"/.test(require('fs').readFileSync(file, 'utf8'));
const CFG = path.join(os.homedir(), '.claude');
const MIN_RUN = +(process.argv.find(a => a.startsWith('--min='))?.slice(6) || 3);

const RO_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebFetch', 'WebSearch', 'NotebookRead']);
const RO_PROGS = new Set(['cat', 'head', 'tail', 'ls', 'find', 'grep', 'rg', 'wc', 'tree', 'file', 'stat', 'du', 'sed', 'awk',
  'less', 'more', 'type', 'dir', 'Get-Content', 'Get-ChildItem', 'Select-String', 'gc', 'gci', 'sls', 'echo', 'pwd', 'which', 'cd', 'sort', 'uniq', 'cut', 'jq']);
const RO_GIT = new Set(['log', 'show', 'diff', 'status', 'blame', 'grep', 'ls-files', 'rev-parse', 'branch', 'describe', 'shortlog']);
function roShell(cmd) {
  if (typeof cmd !== 'string' || /(^|[^>])>(?!&)|\btee\b|-i\b/.test(cmd.replace(/2>\/dev\/null|2>&1|2>\$null/g, ''))) return false;
  return cmd.split(/&&|\|\||;|\||\n/).map(s => s.trim()).filter(Boolean).every(seg => {
    const w = seg.split(/\s+/).filter(x => !/^\w+=/.test(x));
    const p = (w[0] || '').replace(/^.*[\\/]/, '');
    if (p === 'git') { const sub = w.slice(1).find(x => !x.startsWith('-') && !/^[A-Z]:|^\//.test(x)) || ''; return RO_GIT.has(sub) || w.includes('-C') && RO_GIT.has(w[w.indexOf('-C') + 2]); }
    if (p === 'gh') return /^(pr|issue|run|api)\s+(view|list|diff|checks)\b/.test(w.slice(1).join(' ')) || w[1] === 'api';
    return RO_PROGS.has(p);
  });
}
const isExplore = (r) => RO_TOOLS.has(r.name) || ((r.name === 'Bash' || r.name === 'PowerShell') && roShell(r.cmd));

// Where each typed prompt falls, in request indices, so a phase never spans the user's own turn.
function promptReqs(file) {
  const seen = new Set(); let n = 0; const at = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue; let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain) continue;
    if (e.type === 'assistant' && e.message) { const id = e.requestId || e.uuid; if (!seen.has(id)) { seen.add(id); n++; } }
    else if (e.type === 'user' && !e.isMeta && !e.isCompactSummary && e.message) {
      const c = e.message.content;
      const typed = typeof c === 'string' ? !c.startsWith('<') : Array.isArray(c) && c.some(b => b && b.type === 'text') && !c.some(b => b && b.type === 'tool_result');
      if (typed) at.push(n);
    }
  }
  return at;
}
const ctx = (u) => u ? (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.input_tokens || 0) : 0;

// Subagents, measured: their base context (first request) and what they hand back (the Agent tool result).
const subBase = [], subReqs = [], subBack = [];
for (const d of fs.readdirSync(path.join(CFG, 'projects'))) {
  const pd = path.join(CFG, 'projects', d);
  for (const s of fs.readdirSync(pd)) {
    const sd = path.join(pd, s, 'subagents'); if (!fs.existsSync(sd)) continue;
    for (const f of fs.readdirSync(sd).filter(f => f.endsWith('.jsonl'))) {
      try {
        const lines = fs.readFileSync(path.join(sd, f), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
        const reqs = new Map(); for (const e of lines) if (e.type === 'assistant' && e.message?.usage) reqs.set(e.requestId || e.uuid, e.message.usage);
        const us = [...reqs.values()]; if (!us.length) continue;
        subBase.push(us[0].cache_creation_input_tokens || 0); subReqs.push(us.length);
        const last = [...lines].reverse().find(e => e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.some(b => b.type === 'text'));
        if (last) subBack.push(Math.round(last.message.content.filter(b => b.type === 'text').map(b => b.text).join('').length / 4));
      } catch {}
    }
  }
}
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

const W = T.weightsOf('claude-opus-5-5');
const pts = (read, write) => (read * W.read + write * W.write) / 1e6;
let pool = 0, skipped = 0, totalCtx = 0, totalCarried = 0;
const agentBack = [];
const phases = [];
const perSession = [];
for (const f of T.findTranscripts(CFG)) {
  let p; try { p = T.parseTranscript(f.file); } catch { skipped++; continue; }
  if (T.stagedCwd(p.cwd) || headless(f.file) || T.formatWarning(p) || p.requests.length < 10) { skipped++; continue; }
  T.carry(p); pool++;
  const reqCtx = p.requests.map(q => ctx(q.usage));
  const sessCtx = reqCtx.reduce((a, b) => a + b, 0); totalCtx += sessCtx;
  totalCarried += p.results.reduce((a, r) => a + r.carried, 0);
  for (const r of p.results) if (r.name === 'Agent' || r.name === 'Task') agentBack.push(r.tokens);
  const prompts = new Set(promptReqs(f.file));
  const compactAt = new Set(p.compactions || []);
  let run = [];
  let sessSave = 0;
  const flush = () => {
    if (run.length >= MIN_RUN) {
      const first = run[0].afterReq, last = run[run.length - 1].afterReq;
      // The requests the phase itself made: from the one that asked for its first result to the one that asked for its last.
      const phaseReqs = []; for (let i = first; i <= last; i++) phaseReqs.push(i);
      const tokens = run.reduce((a, r) => a + r.tokens, 0);
      const inPhaseCtx = phaseReqs.slice(1).reduce((a, i) => a + reqCtx[i], 0);   // main context re-read while exploring
      const after = Math.max(0, (run[run.length - 1].carriedTurns || 0) - (last - run[run.length - 1].afterReq));
      const postCarry = run.reduce((a, r) => a + r.tokens * Math.max(0, r.carriedTurns - (last - r.afterReq)), 0);
      phases.push({ file: f.session, n: run.length, reqs: phaseReqs.length, tokens, inPhaseCtx, postCarry, after,
        startCtx: reqCtx[first] || 0, results: run });
    }
    run = [];
  };
  let prevReq = -1;
  for (const r of p.results) {
    const brokenByPrompt = run.length && [...prompts].some(x => x > prevReq && x <= r.afterReq);
    const brokenByCompact = run.length && [...compactAt].some(x => x > prevReq && x <= r.afterReq);
    if (!isExplore(r) || r.isError && false || brokenByPrompt || brokenByCompact) { flush(); if (!isExplore(r)) { prevReq = r.afterReq; continue; } }
    run.push(r); prevReq = r.afterReq;
  }
  flush();
}

const B = med(subBase), S = +(process.argv.find(a => a.startsWith('--summary='))?.slice(10) || med(subBack));
let poolPts = 0; for (const f of T.findTranscripts(CFG)) { let p; try { p = T.parseTranscript(f.file); } catch { continue; }
  if (T.stagedCwd(p.cwd) || headless(f.file) || T.formatWarning(p) || p.requests.length < 10) continue;
  const d = T.limitDraw(p); poolPts += d.read + d.write + d.output; }
// Counterfactual per phase: the subagent makes as many requests as the phase did, starting from B and accumulating the
// phase's results; the main session makes one spawn request (its context at the phase's start) and then carries S instead
// of the phase's results.
let actual = 0, counter = 0, actualPts = 0, counterPts = 0, tokensMoved = 0;
for (const ph of phases) {
  const act = ph.inPhaseCtx + ph.postCarry;
  let sub = 0, acc = 0; for (const r of ph.results) { sub += B + acc; acc += r.tokens; }
  const cf = sub + ph.startCtx + S * (ph.after + 1);
  ph.act = act; ph.cf = cf;
  actual += act; counter += cf; tokensMoved += ph.tokens;
  // Points: reads at the read weight; writes: the phase's results are written once either way, the subagent's base once
  // per phase and the summary once in main -- the extra writes delegation adds.
  actualPts += pts(act, 0); counterPts += pts(cf, B + S);
  ph.savePts = pts(act, 0) - pts(cf, B + S);
}
const oracle = phases.filter(p => p.savePts > 0);
const k = T.kfmt, pct = (a, b) => b ? (100 * a / b).toFixed(1) + '%' : 'n/a';
console.log(`pool: ${pool} sessions (skipped ${skipped}: staged, too short, or unreadable), context processed ${k(totalCtx)}`);
console.log(`pool draw (priced requests only): ~${poolPts.toFixed(0)} pts
subagents measured: ${subBase.length}, base WRITE median ${k(B)}, report back median ${k(med(subBack))} (using ${k(S)}), requests median ${med(subReqs)}; Agent results in main: ${agentBack.length}, median ${k(S)}`);
console.log(`exploration phases (>= ${MIN_RUN} read-only results in a row, within one user turn): ${phases.length} in ${new Set(phases.map(p => p.file)).size} sessions, ${k(tokensMoved)} tokens of results`);
console.log(`  as run:       ${k(actual)} tokens processed (${pct(actual, totalCtx)} of all context processed)  ~${actualPts.toFixed(1)} pts`);
console.log(`  delegated:    ${k(counter)} tokens processed  ~${counterPts.toFixed(1)} pts`);
console.log(`  net saving:   ${k(actual - counter)} tokens = ${pct(actual - counter, totalCtx)} of all context processed  ~${(actualPts - counterPts).toFixed(1)} pts`);
const big = [...phases].sort((a, b) => (b.act - b.cf) - (a.act - a.cf));
const wins = phases.filter(p => p.act > p.cf);
console.log(`  phases where delegating wins: ${wins.length} of ${phases.length}; top 10% of phases hold ${pct(big.slice(0, Math.ceil(phases.length / 10)).reduce((a, p) => a + p.act - p.cf, 0), actual - counter)} of the net`);
console.log(`  oracle (delegate only phases that win in points): ${oracle.length} phases, ~${oracle.reduce((a, p) => a + p.savePts, 0).toFixed(1)} pts = ${pct(oracle.reduce((a, p) => a + p.savePts, 0), poolPts)} of the pool's draw`);
for (const m of [3, 5, 8, 12]) { const sel = phases.filter(p => p.n >= m); console.log(`  rule "delegate phases of >= ${m} results": ${sel.length} phases, ~${sel.reduce((a, p) => a + p.savePts, 0).toFixed(1)} pts`); }
