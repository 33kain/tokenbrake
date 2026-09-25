// Stage 1 runner (AB-TASK.md, "An earlier compaction window", stage 1). One run = one fresh fixture, two headless
// messages, graded answers, and where the compaction landed.
//
//   node <repo>/scripts/compact-stage1.mjs --arm=ON --run=pilot      (ON: window 150k; PREP: window 150k + compactPrep; OFF: default window)
import { spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const HERE = process.cwd();   // run from an empty directory whose path contains "calibration"
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const TR = createRequire(import.meta.url)(join(REPO, 'transcript.js'));
const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const ARM = arg('arm', 'ON'), RUN = arg('run', 'x');
const WINDOW = '150000';

// ---- fixture ---------------------------------------------------------------------------------------------------
const FIX = join(HERE, `fixture-${ARM}-${RUN}`);
rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });
for (const f of ['transcript.js', 'cli.js', 'guard.js', 'HANDOFF.md', 'README.md', 'package.json', 'LICENSE',
  'EVIDENCE.md', 'CHANGELOG.md', 'LANDSCAPE.md', 'FEATURES-PLAN.md', 'AB-RUNBOOK.md']) copyFileSync(join(REPO, f), join(FIX, f));
// AB-TASK.md is cut before the stage 1 protocol itself, which names every answer.
const ab = readFileSync(join(REPO, 'AB-TASK.md'), 'utf8');
writeFileSync(join(FIX, 'AB-TASK.md'), ab.slice(0, ab.indexOf('## An earlier compaction window')));
// HANDOFF.md names the stage too; the same cut at its brake-to-8-10 section.
const ho = readFileSync(join(REPO, 'HANDOFF.md'), 'utf8');
const hoCut = ho.indexOf('## Priority since 2026-09-18 evening');
if (hoCut > 0) writeFileSync(join(FIX, 'HANDOFF.md'), ho.slice(0, hoCut));
writeFileSync(join(FIX, 'config.js'), 'module.exports = {\n  RETRY_LIMIT: 7,\n  BACKOFF_MS: 250\n};\n');
writeFileSync(join(FIX, 'check.js'), "console.log('checking ledger...');\nconsole.error('Error: ledger checksum mismatch at row 4127 (expected 9f3a, got 1c07)');\nprocess.exit(1);\n");
const lines = (f) => readFileSync(join(FIX, f), 'utf8').split('\n').length - (readFileSync(join(FIX, f), 'utf8').endsWith('\n') ? 1 : 0);

// ---- v2 stage A: the tail (AB-TASK.md, "The compaction window, v2") ------------------------------------------------
// 30 follow-on questions, "the first word on line N of F": 15 on files message 1 read, 15 on files it never read.
// The (F, N) pairs come from a fixed seed over the fixture's nonblank lines, so every run asks the same 30.
const TAIL = Number(arg('tail', 0));
function tailQuestions() {
  let s = 20260919;
  const rand = () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (files, n) => Array.from({ length: n }, (_, k) => {
    const f = files[k % files.length];
    const ls = readFileSync(join(FIX, f), 'utf8').split('\n');
    const nonblank = ls.map((l, i) => l.trim() ? i + 1 : 0).filter(Boolean);
    const line = nonblank[Math.floor(rand() * nonblank.length)];
    return { file: f, line, word: ls[line - 1].trim().split(/\s+/)[0], read: files === READ_FILES };
  });
  const READ_FILES = ['transcript.js', 'cli.js', 'guard.js', 'HANDOFF.md', 'README.md'];
  return [...pick(READ_FILES, 15), ...pick(['FEATURES-PLAN.md', 'AB-RUNBOOK.md', 'CHANGELOG.md'], 15)];
}
const TQ = TAIL ? tailQuestions().slice(0, TAIL) : [];
if (arg('list')) { for (const q of TQ) console.log(`${q.read ? 'read  ' : 'unread'} ${q.file}:${q.line} -> ${JSON.stringify(q.word)}`); process.exit(0); }   // --list=1: the questions, no run
const tailPrompt = (q, k) => `Follow-on question ${k + 1} of ${TQ.length}. What is the first word on line ${q.line} of ${q.file}? Reply with just that word.`;
const tailRight = (q, a) => { const clean = (x) => String(x || '').trim().replace(/^[`'"*]+|[`'"*.,:;]+$/g, ''); return clean(a) === clean(q.word) || clean(a).split(/\s+/)[0] === clean(q.word); };

const MSG1 = `Work only in this directory. Do these steps in order.
1. Run \`node check.js\` and note the first line that starts with "Error:".
2. In config.js, double the value of RETRY_LIMIT. Change nothing else.
3. Choose between Option LANTERN (keep the ledger append-only) and Option HARBOR (rotate the ledger daily) for this project. Write your choice in your working as "CHOICE: LANTERN" or "CHOICE: HARBOR", with one sentence of reason, before you go on.
4. Read these five files in full, each from its first line to its last: transcript.js, cli.js, guard.js, HANDOFF.md, README.md. Then find the section of AB-TASK.md whose heading starts with "### Calibration results" and read it.
5. Reply with the single word: done`;

const MSG2 = `Answer these fifteen questions. Reply with exactly fifteen lines, "Q1: <answer>" through "Q15: <answer>", nothing else. Use tools only if you need to.
Q1: What was the first line starting with "Error:" that \`node check.js\` printed?
Q2: What was RETRY_LIMIT in config.js before your edit, and what is it now? (answer as "before -> now")
Q3: Which option did you choose, LANTERN or HARBOR?
Q4: How many lines does guard.js have?
Q5: What cache-read weight does the "Calibration results" section of AB-TASK.md give, in points per million tokens?
Q6: How many bytes of the transcript's tail does guard.js read after a compaction (PREP_TAIL_BYTES)?
Q7: What default compaction window does transcript.js assume (DEFAULT_COMPACT_WINDOW)?
Q8: What example date does cli.js give in its error message for a bad --since value?
Q9: According to HANDOFF.md, what share of the five-hour limit did five messages in a 689k-token session use?
Q10: What default value of reReadRecency does README.md state?
Q11: What is the "version" field in package.json?
Q12: Who is named as the copyright holder in LICENSE?
Q13: How many lines does EVIDENCE.md have?
Q14: What is the first "## " version heading in CHANGELOG.md?
Q15: What is the first line of LANDSCAPE.md?`;

const KEY = {
  Q1: (a) => /ledger checksum mismatch at row 4127/.test(a),
  Q2: (a) => /\b7\b[\s\S]*\b14\b/.test(a),
  Q3: null,   // graded against the CHOICE line message 1 wrote in its working
  Q4: (a) => { const n = Number((a.match(/\d[\d,]*/) || [''])[0].replace(/,/g, '')); return Math.abs(n - lines('guard.js')) <= 1; },
  Q5: (a) => /\b0?\.20?\b/.test(a),
  Q6: (a) => /\b16\s*(MB|MiB|\*)|16777216|16,777,216/i.test(a),
  Q7: (a) => /967,?000|967k/i.test(a),
  Q8: (a) => /2026-09-19/.test(a),
  Q9: (a) => /(^|\D)9\s*(%|percent|percentage)/i.test(a),   // "9 percentage points (36% -> 45%)" is right too
  Q10: (a) => /(^|\D)8(\D|$)/.test(a),
  Q11: (a) => /0\.4\.0/.test(a),
  Q12: (a) => /\bMili\b/.test(a),
  Q13: (a) => { const n = Number((a.match(/\d+/) || [''])[0]); return Math.abs(n - lines('EVIDENCE.md')) <= 1; },
  Q14: (a) => /0\.4\.0/.test(a),
  Q15: (a) => /The field, 2026-09-09/.test(a)
};

// ---- arm config ------------------------------------------------------------------------------------------------
const TBJ = join(homedir(), '.claude', 'tokenbrake.json');
const savedCfg = existsSync(TBJ) ? readFileSync(TBJ, 'utf8') : null;
const setPrep = (on) => {
  const cfg = savedCfg ? JSON.parse(savedCfg) : {};
  if (on) cfg.compactPrep = true; else delete cfg.compactPrep;
  writeFileSync(TBJ, JSON.stringify(cfg, null, 2) + '\n');
};
const env = { ...process.env };
if (ARM === 'ON' || ARM === 'PREP') env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = WINDOW; else delete env.CLAUDE_CODE_AUTO_COMPACT_WINDOW;

function send(text, session) {
  const a = ['-p', '--model', 'opus', '--output-format', 'stream-json', '--verbose', '--allowedTools', 'Read,Grep,Glob,Edit,Bash(node check.js)'];
  if (session) a.push('--resume', session);
  const r = spawnSync('claude', a, { input: text, encoding: 'utf8', shell: true, cwd: FIX, env, maxBuffer: 1 << 28 });
  let meter = null, result = null;
  for (const l of (r.stdout || '').split('\n')) {
    if (!l.startsWith('{')) continue;
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'rate_limit_event') meter = e.rate_limit_info?.unifiedWindows?.five_hour?.utilization ?? meter;
    if (e.type === 'result') result = e;
  }
  if (!result) throw new Error('no result: ' + (r.stderr || r.stdout || '').slice(0, 500));
  return { session: result.session_id, text: result.result || '', meter, turns: result.num_turns, t: new Date().toISOString() };
}

// Amendment 3: a filler message between the two, so a compaction fired by a message's arrival lands on it --
// after step 3 and before message 2 -- and not on message 2.
const FILLER = 'Reply with the single word: ok';
let m1, mf, m2;
const tail = [];
try {
  if (ARM === 'PREP') setPrep(true);
  m1 = send(MSG1, null);
  console.log(`msg1 done: session ${m1.session.slice(0, 8)}, turns ${m1.turns}, meter ${m1.meter}`);
  mf = send(FILLER, m1.session);
  console.log(`filler done: turns ${mf.turns}, reply ${JSON.stringify(mf.text.slice(0, 40))}`);
  m2 = send(MSG2, m1.session);
  console.log(`msg2 done: turns ${m2.turns}, meter ${m2.meter}`);
  TQ.forEach((q, k) => tail.push(send(tailPrompt(q, k), m1.session)));
  if (TQ.length) console.log(`tail done: ${tail.length} questions, meter ${tail[tail.length - 1].meter}`);
} finally {
  if (savedCfg !== null) writeFileSync(TBJ, savedCfg);
}

// ---- where the compaction landed, and what the run drew ---------------------------------------------------------
const tf = TR.findTranscripts(join(homedir(), '.claude')).find(f => f.session === m1.session);
const entries = readFileSync(tf.file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const msg2At = entries.findIndex(e => e.type === 'user' && typeof e.message?.content === 'string' && e.message.content.startsWith('Answer these fifteen questions'));
const bounds = entries.map((e, i) => e.type === 'system' && e.subtype === 'compact_boundary'
  ? { i, trigger: e.compactMetadata?.trigger, pre: e.compactMetadata?.preTokens, post: e.compactMetadata?.postTokens } : null).filter(Boolean);
// The CHOICE line, from the model's own working in message 1 (never its final reply), and where step 3 ended.
const textAt = (e) => (Array.isArray(e.message?.content) ? e.message.content : []).filter(b => b.type === 'text' || b.type === 'thinking').map(b => b.text || b.thinking || '').join('\n');
// The model states its choice in its own words as often as in the CHOICE: form it was asked for ("I'm going with
// LANTERN"), so the first decision-shaped mention before message 2 counts. Corrected after the counted runs; see
// AB-TASK.md, "Stage 1 results".
const CHOICE_RE = /(?:CHOICE:\s*|go(?:ing)? with |choos\w* |chos(?:e|en) |keep|pick\w* |select\w* |opt\w* for )\W*(LANTERN|HARBOR)/i;
const choiceAt = entries.findIndex((e, i) => i < msg2At && e.type === 'assistant' && CHOICE_RE.test(textAt(e)));
const chose = choiceAt >= 0 ? textAt(entries[choiceAt]).match(CHOICE_RE)[1].toUpperCase() : null;
// The edit, however it was made: any Edit/Write/MultiEdit/Bash call whose input names config.js.
const editAt = entries.findIndex(e => e.type === 'assistant' && Array.isArray(e.message?.content) && e.message.content.some(b => b.type === 'tool_use' && /^(Edit|Write|MultiEdit|Bash|PowerShell)$/.test(b.name) && /config\.js/.test(JSON.stringify(b.input || {}))));
const factsDone = Math.max(choiceAt, editAt);
// Stage A: compactions during the tail are allowed (real work continues and compacts again); the placement rule
// applies to everything before the tail. OFF may not compact anywhere.
const tailAt = entries.findIndex(e => e.type === 'user' && typeof e.message?.content === 'string' && e.message.content.startsWith('Follow-on question 1 of'));
const inTail = (b) => tailAt >= 0 && b.i > tailAt;
const where = bounds.map(b => ({ ...b, in: inTail(b) ? 'in the tail' : b.i < factsDone ? 'during the facts steps' : b.i < msg2At ? 'after step 3, in message 1' : 'in message 2' }));
const headBounds = bounds.filter(b => !inTail(b));
// The filler must carry nothing: its reply is "ok", and no tool is called between it and message 2.
const fillerAt = entries.findIndex(e => e.type === 'user' && typeof e.message?.content === 'string' && e.message.content.trim().startsWith(FILLER));
const fillerTools = fillerAt < 0 ? 0 : entries.slice(fillerAt, msg2At).filter(e => e.type === 'assistant'
  && Array.isArray(e.message?.content) && e.message.content.some(b => b.type === 'tool_use')).length;
const fillerOk = fillerAt >= 0 && mf.text.trim().toLowerCase().replace(/[^a-z]/g, '') === 'ok' && fillerTools === 0;
const placement = !fillerOk ? 'VOID: the filler carried something (reply not "ok", or a tool call)'
  : choiceAt < 0 || editAt < 0 ? 'VOID: step 2 or 3 not found'
  : ARM === 'OFF' ? (bounds.length ? 'VOID: OFF compacted' : 'counts (OFF: no compaction, by design)')
  : !headBounds.some(b => b.trigger === 'auto') ? 'VOID: no automatic compaction'
  : headBounds.every(b => b.i > factsDone && b.i < msg2At) ? 'counts' : 'VOID: a compaction outside (after step 3, before message 2)';
if (m1.text.trim().toLowerCase().replace(/[^a-z]/g, '') !== 'done') console.log('note: message 1 replied more than "done": ' + m1.text.slice(0, 120));

// ---- grade ------------------------------------------------------------------------------------------------------
const answers = Object.fromEntries((m2.text.match(/^Q\d+:.*$/gm) || []).map(l => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()]));
const score = {};
for (const q of Object.keys(KEY)) score[q] = !!answers[q] && (q === 'Q3' ? !!chose && answers[q].toUpperCase().includes(chose) : KEY[q](answers[q]));
const recall = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'].filter(q => score[q]).length;          // task facts
const details = ['Q6', 'Q7', 'Q8', 'Q9', 'Q10'].filter(q => score[q]).length;        // buried details
const fresh = ['Q11', 'Q12', 'Q13', 'Q14', 'Q15'].filter(q => score[q]).length;

const parsed = TR.parseTranscript(tf.file);
const u = parsed.requests.reduce((s, q) => { const x = q.usage || {}; s.read += x.cache_read_input_tokens || 0; s.write += (x.cache_creation_input_tokens || 0) + (x.input_tokens || 0); s.out += x.output_tokens || 0; return s; }, { read: 0, write: 0, out: 0 });
// The session's own model's weights; an uncalibrated one falls back to Opus 5's, as before, and the row says which.
const W = parsed.requests.map(q => TR.weightsOf(q.model)).findLast(Boolean) || TR.weightsOf('claude-opus-5');
const draw = (u.read * W.read + u.write * W.write + u.out * W.output) / 1e6;
const recov = TR.compactionView(parsed).map(r => ({ files: r.recovery.files.length, pts: +r.recovery.pts.toFixed(2) }));

// Each compaction's own request, which no transcript records: a cached read of the context it summarized, plus the
// summary it wrote (the next isCompactSummary entry, chars / 4 as tokens). v2 stage A's estimate.
const charges = bounds.map(b => {
  const s = entries.slice(b.i).find(e => e.isCompactSummary);
  const c = s ? (typeof s.message?.content === 'string' ? s.message.content : JSON.stringify(s.message?.content || '')) : '';
  return { pre: b.pre || 0, summaryTokens: Math.round(c.length / 4), pts: ((b.pre || 0) * W.read + (c.length / 4) * W.output) / 1e6 };
});
const charge = charges.reduce((a, c) => a + c.pts, 0);
const tailScore = { read: TQ.filter((q, k) => q.read && tailRight(q, tail[k]?.text)).length, unread: TQ.filter((q, k) => !q.read && tailRight(q, tail[k]?.text)).length };
const head = (() => { try { return spawnSync('git', ['-C', REPO, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim(); } catch { return null; } })();

const row = { t: new Date().toISOString(), arm: ARM, run: RUN, head, session: m1.session, placement, chose, answers, score, recall, details, fresh,
  compactions: where, requests: parsed.requests.length, tokens: u, weights: W.label, draw: +draw.toFixed(2), recovery: recov, meter: [m1.meter, m2.meter, tail.length ? tail[tail.length - 1].meter : null],
  msg1: m1.text, turns: [m1.turns, m2.turns],
  ...(TQ.length ? { tail: TQ.map((q, k) => ({ ...q, answer: tail[k]?.text, right: tailRight(q, tail[k]?.text) })), tailScore, charges,
    charge: +charge.toFixed(3), total: +(draw + charge).toFixed(2) } : {}) };
appendFileSync(join(HERE, TQ.length ? 'stageA.jsonl' : 'stage1.jsonl'), JSON.stringify(row) + '\n');
console.log(JSON.stringify({ arm: ARM, run: RUN, placement, recall, details, fresh, chose, compactions: where, requests: row.requests, draw: row.draw,
  recovery: recov, ...(TQ.length ? { tailScore, charge: row.charge, total: row.total } : {}), score }, null, 1));
