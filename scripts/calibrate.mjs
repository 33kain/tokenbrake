// Calibration runner (AB-TASK.md, "Calibration: what each kind of token weighs against the five-hour limit").
// One headless `claude -p` per message; logs the five-hour meter and the request's usage to ./calib.jsonl.
// Run it from an empty directory whose path contains "calibration", so calibrate-pool.mjs leaves these sessions out.
// The meter reading a message returns does not include that message yet: compare readings across spans.
// `--autocompact auto` keeps the model's own window whatever the user settings say (stage B sets 300k, which
// compacted the 2026-09-23 run's 411k build); any compaction a block didn't ask for stops the run.
//
// The whole Opus 5.5 recalibration in one command (AB-TASK.md, 2026-09-24 amendment), then the weights:
//   node <repo>/scripts/calibrate.mjs --plan
//   node <repo>/scripts/calibrate-weights.mjs
//
// One block at a time, as the 2026-09-18 run was driven:
//   node <repo>/scripts/calibrate.mjs --block=B0 --n=20
//   node <repo>/scripts/calibrate.mjs --block=B1 --n=20 --build=250000   # new session; --build is a chars/4 target, and repo text is denser: 250000 gave 411k tokens
//   node <repo>/scripts/calibrate.mjs --block=B2 --n=20 --resume=<id> --build=350000
//   node <repo>/scripts/calibrate.mjs --block=B3 --n=1 --resume=<id> --idle=66
//   node <repo>/scripts/calibrate.mjs --block=B4 --n=20 --resume=<id> --compact
//   node <repo>/scripts/calibrate.mjs --block=B5 --n=5 --prompt="Write about 2,000 words on any topic. Use no tools."
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(process.cwd(), 'calib.jsonl');
const REPO = join(HERE, '..');
const STOP_AT = 0.9;   // leave the owner headroom in the window
const OK = 'Reply with the single word ok. Use no tools.';

const arg = (k, d) => {
  const a = process.argv.find(x => x.startsWith(`--${k}=`) || x === `--${k}`);
  return a === undefined ? d : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};

// ~4 chars per token; repo text repeated until the target is reached.
function filler(tokens) {
  const files = readdirSync(REPO).filter(f => /\.(md|js|mjs)$/.test(f) && statSync(join(REPO, f)).size > 0);
  const text = files.map(f => `\n===== ${f} =====\n` + readFileSync(join(REPO, f), 'utf8')).join('');
  let out = '';
  while (out.length < tokens * 4) out += text;
  return out.slice(0, tokens * 4);
}
const buildPrompt = (tokens) => 'Below is a document for later reference. Reply with the single word ok. Use no tools.\n\n' + filler(tokens);

function send(input, block, session) {
  const args = ['-p', '--model', 'opus', '--effort', 'low', '--output-format', 'stream-json', '--verbose', '--autocompact', 'auto'];
  if (session) args.push('--resume', session);
  const r = spawnSync('claude', args, { input, encoding: 'utf8', shell: true, maxBuffer: 1 << 28, cwd: process.cwd() });
  let meter = null, result = null, compacted = false;
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.startsWith('{')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'rate_limit_event') meter = e.rate_limit_info;
    if (e.type === 'result') result = e;
    if (e.type === 'system' && e.subtype === 'compact_boundary') compacted = true;
  }
  if (!result) throw new Error('no result event: ' + (r.stderr || r.stdout || '').slice(0, 400));
  const u = result.usage || {};
  return {
    t: new Date().toISOString(), block, session: result.session_id,
    five: meter?.unifiedWindows?.five_hour?.utilization ?? null,
    fiveResets: meter?.unifiedWindows?.five_hour?.resetsAt ?? null,
    seven: meter?.unifiedWindows?.seven_day?.utilization ?? null,
    input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens,
    write1h: u.cache_creation?.ephemeral_1h_input_tokens, write5m: u.cache_creation?.ephemeral_5m_input_tokens,
    output: u.output_tokens, turns: result.num_turns, model: Object.keys(result.modelUsage || {}).join(','),
    isError: result.is_error, compacted,
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stop = (why) => { console.log('STOP: ' + why); process.exit(1); };
const log = (row, kind) => {
  appendFileSync(LOG, JSON.stringify({ ...row, kind }) + '\n');
  if (row.compacted && kind !== 'compact') stop(`VOID: ${kind} auto-compacted in session ${row.session.slice(0, 8)}; this block does not count`);
  console.log(`${row.t.slice(11, 19)} ${row.block.padEnd(4)} ${kind.padEnd(7)} five=${row.five} read=${row.cacheRead} write=${row.cacheWrite} out=${row.output} turns=${row.turns} session=${row.session.slice(0, 8)}`);
  if (row.five !== null && row.five >= STOP_AT) stop('five-hour window at ' + row.five);
};

/* ---- The plan: the 2026-09-24 amendment, every block in one run, each span between two probes. ---- */

const MODEL = 'claude-opus-5-5';
const BUILD = 250000;           // chars/4, as on 2026-09-18: ~411k tokens of repo text
const AT_BUILD = 380000;        // a B1 message below this context is not re-reading the build
const SETTLE_MS = Number(process.env.CALIBRATE_SETTLE_MS ?? 90_000);   // the meter lags a message; wait before the probe that closes a span (env: dry runs only)
const START_UNDER = 0.6, ROOM = 0.85;
/* est: the block's draw in points at the Opus 5 weights, which the void run showed overstate Opus 5.5. */
const PLAN = [
  { block: 'B1', build: 1, n: 20, est: 12 },                  // new session at ~411k, then 20 messages: consistency check
  { block: 'B1R', resume: 'B1', n: 60, est: 11 },             // the read weight
  { block: 'B4', resume: 'B1', compact: true, n: 20, est: 3 },  // compaction's bound
  { block: 'BW', build: 3, est: 12 },                         // three builds, each a new session: the write weight
  { block: 'B5', n: 40, prompt: 'Write about 4,000 words on any topic. Use no tools.', est: 20 },  // the output weight
];

function check(row, kind) {
  if (row.model !== MODEL) stop(`VOID: ${row.block} ran on ${row.model || '?'}, not ${MODEL}`);
  if (row.isError) stop(`VOID: ${row.block} ${kind} returned an error`);
  const ctx = (row.cacheRead || 0) + (row.cacheWrite || 0) + (row.input || 0);
  if ((row.block === 'B1' || row.block === 'B1R') && kind === 'msg' && ctx < AT_BUILD)
    stop(`VOID: ${row.block} message at ${ctx} tokens of context, not the ~411k build`);
}

/* Any other Claude Code session with a model reply inside the span: the meter counted it too. The calibration's own
   sessions live under a project directory whose name contains "calibration". Chat on claude.ai leaves no trace here. */
function others(fromIso, toIso) {
  const from = Date.parse(fromIso), to = Date.parse(toIso), hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl') && !/calibration/i.test(p) && statSync(p).mtimeMs >= from) {
        for (const line of readFileSync(p, 'utf8').split('\n')) {
          if (!line.includes('"assistant"')) continue;
          let x; try { x = JSON.parse(line); } catch { continue; }
          const ts = Date.parse(x.timestamp);
          if (x.type === 'assistant' && ts >= from && ts <= to) { hits.push(p); break; }
        }
      }
    }
  };
  const root = join(homedir(), '.claude', 'projects');
  if (existsSync(root)) walk(root);
  return hits;
}

function probe() {
  const row = send(OK, 'P', null);
  check(row, 'probe');
  log(row, 'probe');
  if (typeof row.five !== 'number' || !row.fiveResets) stop('the probe returned no five-hour reading');
  return row;
}

async function plan() {
  if (!/calibration/i.test(process.cwd())) stop('run it from a directory whose path contains "calibration"');
  if (existsSync(LOG)) stop('calib.jsonl already exists here: start the plan in a new, empty directory');
  let open = probe();
  if (open.five >= START_UNDER) stop(`the five-hour window is at ${open.five}; start under ${START_UNDER}`);
  const sessions = {};
  for (const step of PLAN) {
    if (open.five + step.est / 100 > ROOM) {
      const until = open.fiveResets * 1000 + 120_000;
      console.log(`${step.block} needs ~${step.est} points and the window is at ${open.five}: waiting for its reset at ${new Date(until).toISOString()}`);
      await sleep(Math.max(0, until - Date.now()));
      open = probe();
    }
    let session = step.resume ? sessions[step.resume] : null;
    const run = (input, kind) => { const row = send(input, step.block, session); check(row, kind); log(row, kind); session = row.session; return row; };
    for (let i = 0; i < (step.build || 0); i++) {
      if (step.block === 'BW') session = null;         // each write in a new session
      run(buildPrompt(BUILD), 'build');
    }
    if (step.compact) run('/compact', 'compact');
    for (let i = 0; i < (step.n || 0); i++) run(step.prompt || OK, 'msg');
    sessions[step.block] = session;
    await sleep(SETTLE_MS);
    const close = probe();
    if (close.fiveResets !== open.fiveResets) stop(`VOID: the five-hour window reset inside ${step.block}`);
    const hits = others(open.t, close.t);
    if (hits.length) stop(`VOID: another session made requests during ${step.block}: ${hits.join(', ')}`);
    open = close;
  }
  console.log('Done. Next: node ' + join(HERE, 'calibrate-weights.mjs'));
}

if (arg('plan')) {
  await plan();
} else {
  const block = arg('block');
  const n = Number(arg('n', 20));
  let session = arg('resume', null);
  const build = Number(arg('build', 0));
  const idle = Number(arg('idle', 0));
  const prompt = arg('prompt', OK);
  if (!block) throw new Error('--block is required (or --plan)');
  const one = (input) => { const row = send(input, block, session); session = row.session; return row; };

  if (build) log(one(buildPrompt(build)), 'build');    // its reading is the block's "before"
  else if (!idle) log(one(prompt), 'before');          // one message whose reading opens the block
  if (arg('compact')) log(one('/compact'), 'compact');
  for (let i = 0; i < n; i++) {
    if (idle) {
      console.log(`idle ${idle} min`);
      await sleep(idle * 60_000);
      // A reading just before the cold message, from a throwaway fresh session, so the cold session stays cold.
      log(send(prompt, block, null), 'probe');
    }
    log(one(prompt), 'msg');
  }
  console.log('session ' + session);
}
