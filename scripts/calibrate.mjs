// Calibration runner (AB-TASK.md, "Calibration: what each kind of token weighs against the five-hour limit").
// One headless `claude -p` per message; logs the five-hour meter and the request's usage to ./calib.jsonl.
// Run it from an empty directory whose path contains "calibration", so calibrate-pool.mjs leaves these sessions out.
// The meter reading a message returns does not include that message yet: compare readings across spans.
//
//   node <repo>/scripts/calibrate.mjs --block=B0 --n=20
//   node <repo>/scripts/calibrate.mjs --block=B1 --n=20 --build=250000   # new session; --build is a chars/4 target, and repo text is denser: 250000 gave 411k tokens
//   node <repo>/scripts/calibrate.mjs --block=B2 --n=20 --resume=<id> --build=350000
//   node <repo>/scripts/calibrate.mjs --block=B3 --n=1 --resume=<id> --idle=66
//   node <repo>/scripts/calibrate.mjs --block=B4 --n=20 --resume=<id> --compact
//   node <repo>/scripts/calibrate.mjs --block=B5 --n=5 --prompt="Write about 2,000 words on any topic. Use no tools."
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(process.cwd(), 'calib.jsonl');
const REPO = join(HERE, '..');
const STOP_AT = 0.9;   // leave the owner headroom in the window

const arg = (k, d) => {
  const a = process.argv.find(x => x.startsWith(`--${k}=`) || x === `--${k}`);
  return a === undefined ? d : a.includes('=') ? a.slice(a.indexOf('=') + 1) : true;
};
const block = arg('block');
const n = Number(arg('n', 20));
let session = arg('resume', null);
const build = Number(arg('build', 0));
const idle = Number(arg('idle', 0));
const prompt = arg('prompt', 'Reply with the single word ok. Use no tools.');
if (!block) throw new Error('--block is required');

// ~4 chars per token; repo text repeated until the target is reached.
function filler(tokens) {
  const files = readdirSync(REPO).filter(f => /\.(md|js|mjs)$/.test(f) && statSync(join(REPO, f)).size > 0);
  const text = files.map(f => `\n===== ${f} =====\n` + readFileSync(join(REPO, f), 'utf8')).join('');
  let out = '';
  while (out.length < tokens * 4) out += text;
  return out.slice(0, tokens * 4);
}

function send(input) {
  const args = ['-p', '--model', 'opus', '--effort', 'low', '--output-format', 'stream-json', '--verbose'];
  if (session) args.push('--resume', session);
  const r = spawnSync('claude', args, { input, encoding: 'utf8', shell: true, maxBuffer: 1 << 28, cwd: process.cwd() });
  let meter = null, result = null;
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.startsWith('{')) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === 'rate_limit_event') meter = e.rate_limit_info;
    if (e.type === 'result') result = e;
  }
  if (!result) throw new Error('no result event: ' + (r.stderr || r.stdout || '').slice(0, 400));
  session = result.session_id;
  const u = result.usage || {};
  const row = {
    t: new Date().toISOString(), block, session,
    five: meter?.unifiedWindows?.five_hour?.utilization ?? null,
    fiveResets: meter?.unifiedWindows?.five_hour?.resetsAt ?? null,
    seven: meter?.unifiedWindows?.seven_day?.utilization ?? null,
    input: u.input_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens,
    write1h: u.cache_creation?.ephemeral_1h_input_tokens, write5m: u.cache_creation?.ephemeral_5m_input_tokens,
    output: u.output_tokens, turns: result.num_turns, model: Object.keys(result.modelUsage || {}).join(','),
    isError: result.is_error,
  };
  return row;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (row, kind) => {
  appendFileSync(LOG, JSON.stringify({ ...row, kind }) + '\n');
  console.log(`${kind.padEnd(6)} five=${row.five} read=${row.cacheRead} write=${row.cacheWrite} out=${row.output} turns=${row.turns} session=${row.session.slice(0, 8)}`);
};

if (build) {
  const content = 'Below is a document for later reference. Reply with the single word ok. Use no tools.\n\n' + filler(build);
  log(send(content), 'build');                       // its reading is the block's "before"
} else if (!idle) {
  log(send(prompt), 'before');                       // one message whose reading opens the block
}
if (arg('compact')) log(send('/compact'), 'compact');
for (let i = 0; i < n; i++) {
  if (idle) {
    console.log(`idle ${idle} min`);
    await sleep(idle * 60_000);
    // A reading just before the cold message, from a throwaway fresh session, so the cold session stays cold.
    const keep = session; session = null;
    log(send(prompt), 'probe');
    session = keep;
  }
  const row = send(prompt);
  log(row, 'msg');
  if (row.five !== null && row.five >= STOP_AT) { console.log('STOP: five-hour window at ' + row.five); break; }
}
console.log('session ' + session);
