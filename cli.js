#!/usr/bin/env node
'use strict';
// tokenbrake CLI -- installs/removes the guard hooks in Claude Code settings and reads the ledger.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const transcript = require('./transcript.js');

const CFG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const TB_DIR = path.join(CFG_DIR, 'tokenbrake');
const LEDGER = path.join(TB_DIR, 'ledger.jsonl');
const args = process.argv.slice(2);
const cmd = args[0] || 'help';
const flag = (f) => args.includes(f);
const PROJECT = flag('--project');

// Where the guard script lives and how settings.json refers to it.
// User scope: absolute path under ~/.claude/hooks. Project scope: ${CLAUDE_PROJECT_DIR} placeholder (exec form, no shell).
const settingsPath = PROJECT ? path.join(process.cwd(), '.claude', 'settings.json') : path.join(CFG_DIR, 'settings.json');
const guardDir = PROJECT ? path.join(process.cwd(), '.claude', 'hooks', 'tokenbrake') : path.join(CFG_DIR, 'hooks', 'tokenbrake');
const guardFile = path.join(guardDir, 'guard.js');
const guardRef = PROJECT ? '${CLAUDE_PROJECT_DIR}/.claude/hooks/tokenbrake/guard.js' : guardFile;

// Which executable the hook spawns. Exec form (args present) means Claude Code starts it directly, no shell,
// so a bare 'node' has to be on the PATH Claude Code itself was launched with -- not the one a shell profile
// builds. If it isn't, the hook fails open and every result goes through untrimmed, silently. User scope
// therefore records the absolute path of the node running this installer (settings.json is machine-local
// anyway); project scope keeps 'node' because that file is meant to be committed and shared. --node=<path>
// overrides either. `status` spawns the recorded command exactly as Claude Code would, so a wrong path is
// caught there instead of in a transcript that quietly got no smaller.
const nodeFlag = args.find(a => a.startsWith('--node='));
const nodeCmd = nodeFlag ? nodeFlag.slice('--node='.length) : (PROJECT ? 'node' : process.execPath);

function readJson(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, obj) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n'); }
function isOurs(group) {
  return Array.isArray(group.hooks) && group.hooks.some(h =>
    String(h.command || '').includes('tokenbrake') || (h.args || []).some(a => String(a).includes('tokenbrake')));
}

function init() {
  fs.mkdirSync(guardDir, { recursive: true });
  fs.copyFileSync(path.join(__dirname, 'guard.js'), guardFile);

  const settings = readJson(settingsPath, {});
  settings.hooks = settings.hooks || {};
  const hook = (mode) => ({ type: 'command', command: nodeCmd, args: [guardRef, mode], timeout: 15, statusMessage: 'tokenbrake' });

  settings.hooks.PostToolUse = (settings.hooks.PostToolUse || []).filter(g => !isOurs(g));
  settings.hooks.PostToolUse.push({ matcher: '*', hooks: [hook('post')] });

  /* A shell command that exits non-zero fires PostToolUseFailure, not PostToolUse. Without this group the
     guard never sees a failing test run, which is the output it exists for. */
  settings.hooks.PostToolUseFailure = (settings.hooks.PostToolUseFailure || []).filter(g => !isOurs(g));
  settings.hooks.PostToolUseFailure.push({ matcher: 'Bash|PowerShell', hooks: [hook('post')] });

  settings.hooks.PreToolUse = (settings.hooks.PreToolUse || []).filter(g => !isOurs(g));
  settings.hooks.PreToolUse.push({ matcher: 'Read', hooks: [hook('read-pre')] });

  writeJson(settingsPath, settings);
  fs.mkdirSync(TB_DIR, { recursive: true });

  console.log(`tokenbrake installed (${PROJECT ? 'project' : 'user'} scope)`);
  console.log(`  hooks:   ${settingsPath}`);
  console.log(`  guard:   ${guardFile}`);
  console.log(`  node:    ${nodeCmd}`);
  console.log(`  config:  ${path.join(CFG_DIR, 'tokenbrake.json')} (optional, see README)`);
  console.log(`  ledger:  ${LEDGER}`);
  console.log('Restart Claude Code (or /hooks to verify). Run `tokenbrake report` after a session.');
}

function uninstall() {
  const settings = readJson(settingsPath, null);
  if (settings && settings.hooks) {
    for (const ev of ['PostToolUse', 'PostToolUseFailure', 'PreToolUse']) {
      if (Array.isArray(settings.hooks[ev])) {
        settings.hooks[ev] = settings.hooks[ev].filter(g => !isOurs(g));
        if (!settings.hooks[ev].length) delete settings.hooks[ev];
      }
    }
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    writeJson(settingsPath, settings);
  }
  try { fs.rmSync(guardDir, { recursive: true, force: true }); } catch {}
  console.log(`tokenbrake hooks removed from ${settingsPath}`);
  console.log(`Ledger and saved outputs kept at ${TB_DIR} -- delete that folder to remove them.`);
}

// Spawn one installed hook exactly the way Claude Code will: the recorded command, the recorded args, no shell,
// a synthetic event on stdin. Runs against a throwaway CLAUDE_CONFIG_DIR so the ledger is not touched.
// Returns a one-line verdict. This is the check the exec-form node-resolution risk needed: a hook that can't
// start is indistinguishable from a hook that chose not to rewrite, unless something spawns it on purpose.
function selfTest(h) {
  const hookArgs = (h.args || []).map(a => a.replace('${CLAUDE_PROJECT_DIR}', process.cwd()));
  const mode = hookArgs[1];
  const stdout = Array.from({ length: 200 }, (_, i) => (i === 100 ? 'ERROR: tokenbrake self-test marker' : `line ${i + 1} tokenbrake self-test filler`)).join('\n');
  const payload = mode === 'read-pre'
    ? { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: __filename, limit: 1 } }
    : { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'tokenbrake status' },
        tool_response: { stdout, stderr: '', interrupted: false, isImage: false } };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenbrake-status-'));
  let r;
  try {
    r = spawnSync(h.command, hookArgs, { input: JSON.stringify(payload), encoding: 'utf8', shell: false, timeout: 15000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: tmp } });
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  if (r.error) return `FAILED to start: ${r.error.code || r.error.message} -- '${h.command}' could not be spawned without a shell. Re-run init (records an absolute node path) or init --node=<path-to-node>.`;
  if (r.status !== 0) return `FAILED: exit ${r.status}${r.stderr ? ' -- ' + r.stderr.trim().split('\n')[0] : ''}`;
  if (mode === 'read-pre') return r.stdout.trim() === '' ? 'ok (spawns; bounded read left untouched)' : `unexpected output: ${r.stdout.slice(0, 80)}`;
  let out; try { out = JSON.parse(r.stdout); } catch { return `FAILED: stdout is not JSON: ${r.stdout.slice(0, 80)}`; }
  const u = out && out.hookSpecificOutput && out.hookSpecificOutput.updatedToolOutput;
  if (!u || typeof u !== 'object') return 'FAILED: no object-shaped updatedToolOutput (Claude Code would reject a string and keep the full output)';
  if (!String(u.stdout).includes('[tokenbrake]') || !String(u.stdout).includes('self-test marker')) return 'FAILED: trimmed output missing marker or flagged error line';
  return `ok (${stdout.length.toLocaleString()} chars in -> ${u.stdout.length.toLocaleString()} out, error line kept)`;
}

function status() {
  const settings = readJson(settingsPath, {});
  const ours = (ev) => (settings.hooks && settings.hooks[ev] || []).filter(isOurs);
  const has = (ev) => ours(ev).length > 0;
  console.log(`settings: ${settingsPath}`);
  console.log(`  PostToolUse guard: ${has('PostToolUse') ? 'installed' : 'missing'}`);
  console.log(`  PostToolUseFailure guard: ${has('PostToolUseFailure') ? 'installed' : 'missing (failing commands enter whole; re-run init)'}`);
  console.log(`  PreToolUse Read cap: ${has('PreToolUse') ? 'installed' : 'missing'}`);
  console.log(`  guard file: ${fs.existsSync(guardFile) ? 'present' : 'missing'} (${guardFile})`);
  for (const ev of ['PostToolUse', 'PostToolUseFailure', 'PreToolUse']) for (const g of ours(ev)) for (const h of g.hooks) {
    if (!isOurs({ hooks: [h] })) continue;
    console.log(`  ${ev} spawn test (${h.command}): ${selfTest(h)}`);
  }
  /* Both scopes at once means two guards per tool call: Claude Code runs the user-scope hooks and the
     project-scope hooks, each spawns node, each writes the same ledger row. Harmless, wasteful, and the
     ledger shows it as duplicate rows; say so -- but only when this scope has the guard too. The other
     scope carrying it while this one does not is the ordinary case (a project install, `status` run
     without --project), it runs the guard exactly once, and calling that "twice" sent an A/B arm hunting
     for a second install that was not there. */
  const otherPath = PROJECT ? path.join(CFG_DIR, 'settings.json') : path.join(process.cwd(), '.claude', 'settings.json');
  const other = readJson(otherPath, null);
  const otherHas = !!(other && other.hooks && ['PostToolUse', 'PostToolUseFailure', 'PreToolUse'].some(ev => (other.hooks[ev] || []).some(isOurs)));
  const thisHas = ['PostToolUse', 'PostToolUseFailure', 'PreToolUse'].some(has);
  const otherScope = PROJECT ? 'user' : 'project';
  if (otherHas && thisHas) console.log(`  also installed at ${otherScope} scope (${otherPath}): the guard runs twice per call here; uninstall one scope`);
  else if (otherHas) console.log(`  installed at ${otherScope} scope instead (${otherPath}): the guard runs once, from there`);
  const cfg = readJson(path.join(CFG_DIR, 'tokenbrake.json'), null);
  console.log(`  config: ${cfg ? JSON.stringify(cfg) : 'defaults'}`);
  const n = fs.existsSync(LEDGER) ? fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).length : 0;
  console.log(`  ledger: ${n} records`);
}

function loadLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  return fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
const tok = (c) => Math.round(c / 4); // rough: ~4 chars per token for code/logs
const fmt = (n) => n.toLocaleString();

/* Brake 4 -- what's eating your tokens. Transcript-first: the Claude Code session transcript holds every
   tool result exactly as the model saw it and the API's usage per request, so the ranking comes from there;
   the ledger says which of those results the guard trimmed. Falls back to the ledger-only report when no
   transcript can be found (an older Claude Code, a different config dir), and --ledger asks for that
   directly. --all lists sessions; --session=<prefix> or --transcript=<path> picks one; --top=N widens
   the ranking; --where pools every session's ranged reads into the one distribution that can set
   readLimitLines. */
function guardCfg() {
  const cfg = { readMaxBytes: 60000, readLimitLines: 300, persistedLimitLines: 80 };
  try {
    const c = JSON.parse(fs.readFileSync(path.join(CFG_DIR, 'tokenbrake.json'), 'utf8'));
    if (c.readMaxBytes) cfg.readMaxBytes = c.readMaxBytes;
    if (c.readLimitLines) cfg.readLimitLines = c.readLimitLines;
    if (c.persistedLimitLines) cfg.persistedLimitLines = c.persistedLimitLines;
  } catch {}
  return cfg;
}

/* `--where`: pool every session's ranged reads into one distribution, and say what a cap at each candidate
   would have withheld. This is the only evidence that can set readLimitLines for a given person, and it
   has to be pooled -- a single session is a handful of reads.

   Two filters make the pooled number mean anything, and both exist because the first two versions of this
   number were circular.

   The workload filter. Run over four of this repo's own benchmark sessions the per-session line read 48% of
   targets past line 300, against 24% on an ordinary working session -- because the benchmark's fixtures are
   BUILT with the evidence past line 300. Benchmark sessions are skipped by default, every skip is printed
   with its reason, and --cwd=<substring> restricts the pool explicitly when that is wanted.

   The confound filter, which is the same mistake from the other direction. A capped Read delivers lines
   1..limit and its additionalContext tells the model to come back with an offset. It does, and the
   follow-up is a ranged read starting just past the cap -- counted here as a target the cap would hide.
   Pooled over seventeen real sessions that read 57% past line 300 with a median of 351, against a cap of
   300 that had been applying all along. So the ledger's own record of which files the cap fired on is
   joined against the reads, and the two distributions are printed side by side: everything, and the subset
   the guard did not provoke. Only the second may set a default. */
function whereReport() {
  const opt = (name) => { const a = args.find(x => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null; };
  const only = opt('--cwd');
  const CAPS = [100, 200, 300, 500, 800, 1200];
  const cfg = guardCfg();
  const configured = cfg.readLimitLines;
  const ledger = loadLedger();
  const found = transcript.findTranscripts(CFG_DIR);
  if (!found.length) { console.log('No transcripts found under ' + path.join(CFG_DIR, 'projects') + '.'); return; }
  const pooled = []; const skipped = [];
  let allReads = [], spontReads = [], induced = [], unordered = 0, basename = 0, capped = 0, attempted = 0;
  const byFile = new Map();
  for (const f of found) {
    const id = String(f.session).slice(0, 8);
    let p;
    try { p = transcript.parseTranscript(f.file); } catch { skipped.push([id, 'unreadable']); continue; }
    const cwd = p.cwd || '';
    if (only) {
      if (!cwd.toLowerCase().includes(only.toLowerCase())) { skipped.push([id, 'cwd does not contain "' + only + '"']); continue; }
    } else if (/tokenbrake-bench/i.test(cwd)) {
      skipped.push([id, 'benchmark session -- synthetic fixtures, evidence placed past line 300 by design; --cwd to include']);
      continue;
    }
    const cls = transcript.classifyRangedReads(p, ledger, { sessionId: p.sessionId || f.session });
    if (!cls.all.length) { skipped.push([id, 'no ranged reads']); continue; }
    pooled.push([id, cls.all.length, cwd]);
    allReads = allReads.concat(cls.all);
    spontReads = spontReads.concat(cls.spontaneous);
    induced = induced.concat(cls.induced);
    unordered += cls.unordered.length;
    basename += cls.basename;
    capped += cls.capped;
    if (cls.attempted) attempted++;
    for (const [what, n] of cls.byFile) byFile.set(what, (byFile.get(what) || 0) + n);
  }
  console.log('Where you read -- ' + pooled.length + ' session(s) pooled, ' + skipped.length + ' skipped'
    + (only ? '  (--cwd=' + only + ')' : ''));
  if (!allReads.length) {
    console.log('\n  No ranged reads in any pooled session. Nothing here can set readLimitLines.');
    printPool(pooled, skipped);
    return;
  }
  const all = transcript.readTargets({ results: allReads }, CAPS);
  const spont = transcript.readTargets({ results: spontReads }, CAPS);
  const THIN = 20;
  console.log('\n  All ranged reads: ' + all.n + ' -- median start line ' + all.median
    + ', 90th percentile ' + all.p90 + ', deepest ' + all.max);

  if (!attempted) {
    console.log('\n  Guard-induced: not attempted -- the ledger holds no read-cap rows for these sessions.');
    console.log('  Either the Read cap never fired here, or the ledger predates it. The two are not the same,');
    console.log('  and this is an absence of evidence about the confound, not evidence there is none.');
  } else {
    console.log('\n  Guard-induced and excluded: ' + induced.length + ' of ' + all.n + ', from ' + capped
      + ' cap firing(s). Each is a ranged read of a file');
    console.log('  the Read cap had already fired on, in the same session, issued after it fired -- the cap hands back');
    console.log('  the first N lines and tells the model to return with an offset, so that start line is the cap\'s.');
    const top = [...byFile.entries()].sort((a, b) => b[1] - a[1]);
    if (top.length) {
      const shown = top.slice(0, 4).map(([w, n]) => String(w).split(/[\\/]/).pop() + ' (' + n + ')').join('  ');
      console.log('    by file: ' + shown + (top.length > 4 ? '  + ' + (top.length - 4) + ' more' : ''));
    }
    if (unordered) console.log('    ' + unordered + ' more excluded as unordered: no timestamp on the read or on the cap row, so which came first'
      + '\n    cannot be established. Counted, never guessed.');
    if (basename) console.log('    ' + basename + ' of the ' + induced.length + ' matched on file name alone (a shell read with a relative path).');
  }

  console.log('\n  Spontaneous: ' + spont.n + (spont.n ? ' -- median start line ' + spont.median
    + ', 90th percentile ' + spont.p90 + ', deepest ' + spont.max : '')
    + (spont.n < THIN ? '   (under ' + THIN + ' reads -- too few to set a default)' : ''));

  console.log('\n  A Read cap keeping the first ... would have hidden what the model went for:');
  console.log('                        all        spontaneous');
  for (const n of CAPS) {
    const a = all.past[n], b = spont.past[n];
    console.log('    ' + String(n).padStart(4) + ' lines ->  ' + String(a).padStart(4) + ' ('
      + String(Math.round(100 * a / all.n)).padStart(3) + '%)     '
      + String(b).padStart(4) + (spont.n ? ' (' + String(Math.round(100 * b / spont.n)).padStart(3) + '%)' : '       ')
      + (n === configured ? '   <- your current readLimitLines' : ''));
  }
  if (!CAPS.includes(configured)) console.log('    (your readLimitLines is ' + configured + ', which is not on this scale)');

  console.log('\n  Start lines, all ranged reads:');
  for (const b of transcript.startHistogram(all.starts)) {
    const to = b.to === Infinity ? '+'.padEnd(6) : '..' + String(b.to).padEnd(4);
    console.log('    ' + String(b.from).padStart(5) + to + String(b.n).padStart(5) + '  ' + b.bar);
  }

  /* The same question without the ledger, so it still gets asked on a machine whose ledger predates the cap.
     A smooth start-line density cannot step upward at an arbitrary line number; a cap can put one there. */
  const bands = [[cfg.readLimitLines, 'your readLimitLines'], [cfg.persistedLimitLines, 'your persistedLimitLines']];
  for (const l of transcript.readCapIndex(ledger, null).limits) {
    if (!bands.some(([n]) => n === l)) bands.push([l, 'from the ledger, a session that ran a different cap']);
  }
  console.log('\n  Bunching at a cap -- the signature, and it needs no ledger at all:');
  for (const [cap, label] of bands) {
    const sp = transcript.capBandSpike(all.starts, cap);
    console.log('    ' + String(cap).padStart(4) + ' (' + label + '): ' + sp.at + ' in [' + cap + '..' + (cap + sp.width)
      + '] against ' + sp.below + ' in [' + (cap - sp.width) + '..' + cap + ') -- '
      + (sp.verdict === 'too few' ? 'too few to say' : sp.ratio.toFixed(1) + 'x, p=' + sp.p.toFixed(3) + ', ' + sp.verdict)
      + '; ' + sp.exact + ' at exactly ' + cap + '/' + (cap + 1));
  }
  console.log('    A step here is the cap measuring itself. A cap with no influence on how the model reads');
  console.log('    leaves the density smooth across it.');

  printPool(pooled, skipped);
  console.log('\n  A ranged read -- a Read with an offset, or a sed -n range -- is the model saying where it expects');
  console.log('  to find something. The guard never capped these reads themselves; they arrived already bounded.');
  console.log('  But a cap on an EARLIER unbounded read of the SAME file tells the model to come back with an');
  console.log('  offset, and that follow-up lands just past the cap -- so the "all" column is partly the cap');
  console.log('  measuring itself. The spontaneous column is the one that can set readLimitLines.');
  console.log('  It is a lower bound on the guard\'s influence: a ranged read of a file the guard never capped,');
  console.log('  written that way because a cap on some OTHER file taught the model to, still counts as');
  console.log('  spontaneous. Only a hooks-off session settles that (AB-TASK.md).');
}

function printPool(pooled, skipped) {
  console.log('\n  Pooled:  ' + (pooled.map(([id, n]) => id + ' (' + n + ')').join('  ') || 'none'));
  for (const [id, why] of skipped) console.log('  Skipped: ' + id + '  ' + why);
}

/* `--caps`: every file the Read cap has fired on, pooled across sessions. The question this answers is
   readMaxBytes's, not readLimitLines's: how often does the cap fire on real work at all, and on what. A
   real 40-request audit session read six files at 1, 8, 15, 16, 31 and 34 KB -- the 60,000-byte trigger
   never fired once -- while benchmark round 1 fired it one to four times per run on fixtures built large on
   purpose. Which of those a person's own week looks like is not a thing to reason about. */
function capsReport() {
  const opt = (name) => { const a = args.find(x => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null; };
  if (opt('--cwd') != null) {
    console.log('--cwd cannot apply to --caps: ledger rows carry no cwd, so a session cannot be told from a');
    console.log('working directory here. Use --session=<prefix>, or --where for the cwd-filtered view.');
    return;
  }
  const top = Number(opt('--top') || 15) || 15;
  const want = opt('--session');
  let recs = loadLedger();
  if (!recs.length) { console.log('No ledger yet. Run a Claude Code session with tokenbrake installed, then try again.'); return; }
  let sessionId = null;
  if (want) {
    const ids = [...new Set(recs.map(r => r.session).filter(Boolean))];
    sessionId = ids.find(id => String(id).startsWith(want));
    if (!sessionId) { console.log('No session in the ledger starts with "' + want + '".'); return; }
  }
  if (flag('--all')) console.log('(--all is the default here: --caps pools every session. Use --session=<prefix> to narrow.)\n');
  const c = transcript.readCapFiles(recs, sessionId);
  if (!c.n) {
    console.log('Read caps fired: none' + (sessionId ? ' in session ' + String(sessionId).slice(0, 8) : ' in this ledger') + '.');
    console.log('The Read cap acts on an unbounded Read of a file over readMaxBytes (60,000 bytes by default),');
    console.log('or on a read of an output Claude Code had already spilled to disk. Neither has happened here.');
    return;
  }
  console.log('Read caps fired -- ' + c.n + ' across ' + (sessionId ? '1 session' : c.sessions + ' session(s)') + ' in the ledger\n');
  console.log('  Source files (readLimitLines):           ' + String(c.source.n).padStart(3) + ' caps, '
    + c.source.files + ' file(s), ~ ' + fmt(tok(c.source.bytes)) + ' tokens of file');
  console.log('  Persisted outputs (persistedLimitLines): ' + String(c.persisted.n).padStart(3) + ' caps, '
    + c.persisted.files + ' file(s), ~ ' + fmt(tok(c.persisted.bytes)) + ' tokens of file');
  console.log('\n  caps  bytes        lines  limit  delivered  file');
  for (const r of c.files.slice(0, top)) {
    console.log('  ' + String(r.n).padStart(4) + '  ' + fmt(r.bytes).padStart(11) + '  '
      + (r.lines == null ? '    ?' : fmt(r.lines).padStart(5)) + '  ' + String(r.limit == null ? '?' : r.limit).padStart(5) + '  '
      + (r.delivered == null ? '      ?' : (Math.round(100 * r.delivered) + '%').padStart(7)) + '    ' + r.what);
  }
  if (c.files.length > top) console.log('  (+ ' + (c.files.length - top) + ' more file(s); --top=' + (c.files.length) + ' for all of them)');
  if (c.unknownLines) console.log('  (' + c.unknownLines + ' row(s) have no line count: the file was over 20 MB, so the guard did not count'
    + '\n   lines and no delivered fraction is shown.)');
  if (c.deduped) console.log('  (' + c.deduped + ' duplicate row(s) dropped: the guard installed at both user and project scope logs'
    + '\n   each cap twice. `tokenbrake status` says so too.)');
  console.log('\n  delivered is limit/lines -- the share of the file the model received. The rest is not lost; it is');
  console.log('  one offset read away, and that read is another request that re-reads the whole context. How often');
  console.log('  the source-file half fires on real work is the question readMaxBytes turns on: here, ' + c.source.n + ' time(s).');
}

/* `--reads`: the other half of the Read cap's evidence. `--where` says where the model looks; this says how
   big the files it reads whole actually are, which is what `readMaxBytes` acts on, and how deep the targets
   sit as a FRACTION of the file, which is what says whether an absolute line cap is even the right shape.

   The trigger has never had an argument. 60,000 was a guess; one paid A/B lowering it to 25,000 cost +10%
   with a task that said "read in full", which forbids the saving by construction. Half of that question is
   arithmetic over a person's own reads -- how many a lower trigger catches and how much of each it cuts --
   and this mode does that half for free. The half it cannot do is whether the model comes back. */
function readsReport() {
  const opt = (name) => { const a = args.find(x => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null; };
  const only = opt('--cwd');
  const TRIGGERS = [10000, 25000, 30000, 45000, 60000];
  const LIMITS = [100, 200, 300, 500, 800, 1200];
  const cfg = guardCfg();
  const ledger = loadLedger();
  const found = transcript.findTranscripts(CFG_DIR);
  if (!found.length) { console.log('No transcripts found under ' + path.join(CFG_DIR, 'projects') + '.'); return; }
  /* The file on disk is the last resort for a line count and it is the weakest: it may have changed since the
     read. Cached so a file read in twenty sessions is counted once. */
  const diskCache = new Map();
  const linesOnDisk = (f) => {
    if (diskCache.has(f)) return diskCache.get(f);
    let n = null;
    try { const st = fs.statSync(f); if (st.isFile() && st.size < 20e6) n = fs.readFileSync(f, 'utf8').split('\n').length; } catch {}
    diskCache.set(f, n);
    return n;
  };
  const pooled = [], skipped = [];
  let reads = [], depths = [];
  let capped = 0, recOrig = 0, recRew = 0, nearCeiling = 0, noLines = 0, unresolved = 0;
  let hostLines = 0, refused = 0, errored = 0, persistedSkipped = 0, files = 0;
  const sources = { ledger: 0, numbering: 0, text: 0 };
  const bySource = { session: 0, ledger: 0, disk: 0 };
  for (const f of found) {
    const id = String(f.session).slice(0, 8);
    let p;
    try { p = transcript.parseTranscript(f.file); } catch { skipped.push([id, 'unreadable']); continue; }
    const cwd = p.cwd || '';
    if (only) {
      if (!cwd.toLowerCase().includes(only.toLowerCase())) { skipped.push([id, 'cwd does not contain "' + only + '"']); continue; }
    } else if (/tokenbrake-bench/i.test(cwd)) {
      skipped.push([id, 'benchmark session -- synthetic fixtures, sizes chosen by design; --cwd to include']);
      continue;
    }
    const sessionId = p.sessionId || f.session;
    const u = transcript.unboundedReads(p, ledger, { sessionId });
    const d = transcript.readDepths(p, ledger, { sessionId, linesOnDisk });
    if (!u.n && !d.n) { skipped.push([id, 'no whole-file reads and no resolvable targets']); continue; }
    pooled.push([id, u.n, cwd]);
    reads = reads.concat(u.reads);
    depths = depths.concat(d.rows);
    capped += u.capped; recOrig += u.recordedOriginal; recRew += u.recordedRewritten;
    nearCeiling += u.nearCeiling; noLines += u.noLines; unresolved += d.unresolved;
    hostLines += u.hostLines; refused += u.refused; errored += u.errored;
    persistedSkipped += u.persistedSkipped; files += u.files;
    for (const k of Object.keys(sources)) sources[k] += u.sources[k];
    for (const k of Object.keys(bySource)) bySource[k] += d.bySource[k];
  }
  console.log('What you read whole -- ' + pooled.length + ' session(s) pooled, ' + skipped.length + ' skipped'
    + (only ? '  (--cwd=' + only + ')' : ''));
  if (!reads.length) {
    console.log('\n  No whole-file reads in any pooled session. readMaxBytes has nothing to act on here.');
    printPool(pooled, skipped);
    return;
  }
  const sized = reads.filter(r => !r.ceiling);
  const sizes = sized.map(r => r.bytes || 0).sort((a, b) => a - b);
  const q = (f) => sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * f))] : 0;
  console.log('\n  ' + reads.length + ' whole-file read(s) of ' + files + ' file(s) -- '
    + fmt(reads.reduce((t, r) => t + (r.bytes || 0), 0)) + ' bytes in total'
    + (sizes.length ? ', median ' + fmt(q(0.5)) + ', 90th percentile ' + fmt(q(0.9)) + ', largest ' + fmt(q(1)) : ''));
  /* Sizes are the FILE's, not what the read cost. Claude Code numbers every line it delivers and that
     numbering is its own, not the file's -- 5-6% of the delivered text on a 350-line file, and growing with
     the line count. readMaxBytes is compared against statSync().size, so leaving the numbering in overstates
     every file and overstates long ones most, right at the boundary this grid is about. */
  console.log('    Sized from: ' + sources.ledger + ' a ledger cap row (statSync, exact), ' + sources.numbering
    + ' the Read\'s own line numbering (subtracted), ' + sources.text + ' the delivered text as-is (a shell cat).');
  if (capped) console.log('    ' + capped + ' read(s) the guard had already capped: the delivered text was the cap\'s first N lines,'
    + '\n    so the ledger\'s true size is used. Believing the transcript there would count a capped read as a'
    + '\n    small file and argue for a lower trigger using the cap\'s own output as the evidence.');
  const notSized = [];
  if (refused) notSized.push(refused + ' refused by Claude Code for exceeding its own per-read token ceiling'
    + ' (so the file IS large, and the transcript does not say how large -- those reads could swing the'
    + '\n      medians below in either direction)');
  if (errored) notSized.push(errored + ' failed for a reason not recognised as the size refusal -- counted as failures, not as large files');
  if (hostLines) notSized.push(hostLines + ' stopped at exactly ' + transcript.HOST_READ_LINES + ' lines from line 1, which looks like a host limit rather than the end of the file -- the line count is a floor');
  if (nearCeiling) notSized.push(nearCeiling + ' came back within 10% of the ~100,000-character Read ceiling');
  if (notSized.length) console.log('    Not sized, and out of every median below: ' + notSized.join(';\n      '));
  if (persistedSkipped) console.log('    ' + persistedSkipped + ' read(s) of an output Claude Code had already spilled to disk are excluded: those are'
    + '\n    capped by persistedLimitLines at anything over maxChars, so readMaxBytes has no say in them (report --caps).');
  if (noLines) console.log('    ' + noLines + ' read(s) have no line count and are in the byte columns only.');

  console.log('\n  What lowering readMaxBytes would catch, and what each limit would then withhold (median):');
  console.log('    trigger   reads  bytes' + LIMITS.map(l => String(l).padStart(6)).join(''));
  for (const g of transcript.triggerGrid(sized, TRIGGERS, LIMITS)) {
    console.log('    ' + String(g.trigger).padStart(7) + String(g.caught).padStart(8)
      + (Math.round(100 * g.byteShare) + '%').padStart(7)
      + LIMITS.map(l => (g.byLimit[l] == null ? '-' : Math.round(100 * g.byLimit[l]) + '%').padStart(6)).join('')
      + (g.trigger === cfg.readMaxBytes ? '   <- your readMaxBytes' : ''));
  }
  /* The miss rate belongs beside the grid but not inside it: it is measured over ranged reads, a different
     population from the whole-file reads the trigger catches. Printing them in one table would invite adding
     them up. */
  const tgt = transcript.readTargets({ results: depths.map(d => ({ readFrom: d.start })) }, LIMITS);
  if (tgt.n) {
    console.log('\n  Chance each capped read sends the model back, by limit -- from your ranged reads, which are a');
    console.log('  DIFFERENT population from the whole-file reads above. Read it beside the grid, not added to it:');
    console.log('    ' + LIMITS.map(l => l + ': ' + Math.round(100 * tgt.past[l] / tgt.n) + '%').join('   '));
  }

  console.log('\n  How deep the targets sit -- ' + depths.length + ' read(s) with a known file length'
    + (unresolved ? ', ' + unresolved + ' unresolved and left out' : ''));
  if (depths.length) {
    console.log('    line length known from: ' + bySource.session + ' a whole-file read in the same session, '
      + bySource.ledger + ' the ledger, ' + bySource.disk + ' the file on disk now (may have changed)');
    const d2 = { n: depths.length, rows: depths };
    const cv = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return m ? Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1)) / m : null; };
    const exact = depths.filter(r => r.source !== 'disk');
    const absCV = depths.length > 1 ? cv(depths.map(r => r.start)) : null;
    const frCV = depths.length > 1 ? cv(depths.map(r => r.depth)) : null;
    const eAbs = exact.length > 1 ? cv(exact.map(r => r.start)) : null;
    const eFr = exact.length > 1 ? cv(exact.map(r => r.depth)) : null;
    const pct = (x) => x == null ? '?' : x.toFixed(2);
    console.log('    spread (coefficient of variation), all sources:   absolute line ' + pct(absCV) + '   fraction of file ' + pct(frCV));
    console.log('    spread, exact sources only (' + exact.length + ' reads):' + ' '.repeat(9) + 'absolute line ' + pct(eAbs) + '   fraction of file ' + pct(eFr));
    console.log('    The tighter one is the shape the cap should have. readLimitLines is an absolute line count,');
    console.log('    so if the fraction is markedly tighter the knob is the wrong shape -- too tight on a short');
    console.log('    file and too loose on a long one -- and no value of it is right everywhere.');
    console.log('\n  Target depth as a share of the file:');
    for (const b of transcript.startHistogram(depths.map(r => Math.round(100 * r.depth)), [0, 10, 20, 30, 40, 50, 60, 80, 101])) {
      const to = b.to > 100 ? '100%' : String(b.to) + '%';
      console.log('    ' + (String(b.from) + '%').padStart(5) + '..' + to.padEnd(5) + String(b.n).padStart(5) + '  ' + b.bar);
    }
  }
  if (capped) {
    console.log('\n  What the transcript records when the guard caps a Read -- settled from your machine, not assumed:');
    console.log('    ' + recOrig + ' appear as the model wrote them (unbounded), ' + recRew + ' as the guard rewrote them (carrying a limit).');
    console.log('    Verdict: ' + (recOrig && recRew ? 'mixed' : recOrig ? 'recorded as the model wrote it' : 'recorded as the guard rewrote it') + '.');
    if (recOrig) console.log('    That means capped reads sit in the pool looking like small whole-file reads unless the ledger'
      + '\n    catches them, which is why the ledger join above is not optional.');
  }
  printPool(pooled, skipped);
  console.log('\n  A whole-file read -- an unbounded Read, or a bare cat -- is what readMaxBytes acts on. head,');
  console.log('  tail, sed -n and grep are bounded requests and are not counted. The grid above is arithmetic and');
  console.log('  is exact for what it measures; what it cannot say is whether the model comes back for what a cap');
  console.log('  withholds, which is behavioural and has cost money to find out before (AB-TASK.md).');
}

function report() {
  if (flag('--ledger')) return ledgerReport();
  if (flag('--where')) return whereReport();
  if (flag('--caps')) return capsReport();
  if (flag('--reads')) return readsReport();
  const opt = (name) => { const a = args.find(x => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null; };
  const top = Number(opt('--top') || 10) || 10;
  const ledger = loadLedger();
  let file = opt('--transcript');
  const found = transcript.findTranscripts(CFG_DIR);
  if (flag('--compare')) {
    /* report --compare A B: the AB-TASK.md table for two sessions, each a session-id prefix or a transcript path. */
    const pick = (x) => fs.existsSync(x) ? x : (found.find(f => f.session.startsWith(x)) || {}).file;
    const want = args.filter(x => !x.startsWith('--') && x !== 'report');
    if (want.length !== 2) { console.log('Usage: tokenbrake report --compare <A> <B>, each a session-id prefix or a transcript path. --all lists sessions.'); return; }
    const [fa, fb] = want.map(pick);
    if (!fa || !fb) { console.log('No transcript for ' + (fa ? want[1] : want[0]) + '. tokenbrake report --all lists them.'); return; }
    let A, B;
    try { A = transcript.parseTranscript(fa); B = transcript.parseTranscript(fb); } catch (e) { console.log('Could not read: ' + e.message); return; }
    console.log(transcript.renderCompare(A, B, ledger));
    return;
  }
  if (!file) {
    const want = opt('--session');
    if (flag('--all')) {
      if (!found.length) { console.log('No transcripts found under ' + path.join(CFG_DIR, 'projects') + '. Try --transcript=<path>, or --ledger for the trimming record alone.'); return; }
      console.log('Sessions, newest first (' + found.length + '):');
      for (const f of found.slice(0, 30)) {
        try { console.log(transcript.renderSummaryLine(transcript.parseTranscript(f.file))); } catch (e) { console.log('  ' + f.session.slice(0, 8) + '...  unreadable: ' + e.message); }
      }
      console.log('\nOpen one with: tokenbrake report --session=<prefix>');
      return;
    }
    if (want) {
      const hit = found.find(f => f.session.startsWith(want));
      if (!hit) { console.log('No transcript whose session id starts with ' + want + '. tokenbrake report --all lists them.'); return; }
      file = hit.file;
    } else {
      /* The last session the ledger saw, if its transcript is known; else the newest transcript on disk. */
      const lastRow = [...ledger].reverse().find(r => r && r.transcript && fs.existsSync(r.transcript));
      file = lastRow ? lastRow.transcript : (found[0] && found[0].file);
    }
  }
  if (!file) {
    if (!ledger.length) { console.log('No transcript and no ledger yet. Run a Claude Code session with tokenbrake installed, then try again.'); return; }
    console.log('No transcript found under ' + path.join(CFG_DIR, 'projects') + ' -- showing the ledger alone.\n');
    return ledgerReport();
  }
  let parsed;
  try { parsed = transcript.parseTranscript(file); } catch (e) { console.log('Could not read ' + file + ': ' + e.message); return; }
  /* The report's "Where you read" line compares against the cap the user actually runs, not the default. */
  let readLimitLines = 300;
  try { const c = JSON.parse(fs.readFileSync(path.join(CFG_DIR, 'tokenbrake.json'), 'utf8')); if (c.readLimitLines) readLimitLines = c.readLimitLines; } catch {}
  console.log(transcript.renderReport(parsed, ledger, { top, readLimitLines }));
  console.log('\n' + (found.length > 1 ? found.length + ' sessions on disk; --all lists them. ' : '') + 'Sizes are chars/4 estimates; the usage line is what the API reported.');
}

/* The 0.1.0-era ledger-only report, kept for machines where no transcript is readable: what the guard
   itself saw and trimmed, by tool and by size. */
function ledgerReport() {
  let recs = loadLedger();
  if (!recs.length) { console.log('No ledger yet. Run a Claude Code session with tokenbrake installed, then try again.'); return; }
  const sessions = [...new Set(recs.map(r => r.session).filter(Boolean))];
  if (!flag('--all')) {
    const last = sessions[sessions.length - 1];
    recs = recs.filter(r => r.session === last);
    console.log(`Session ${String(last).slice(0, 8)}... (${sessions.length} sessions in ledger; use --all for everything)\n`);
  }

  const posts = recs.filter(r => r.ev === 'post');
  const total = posts.reduce((s, r) => s + (r.chars || 0), 0);
  const saved = posts.reduce((s, r) => s + (r.kept != null ? r.chars - r.kept : 0), 0);
  const trimmed = posts.filter(r => r.kept != null).length;
  /* The two Read-cap halves are different features on one hook and they are decided by different config:
     readMaxBytes/readLimitLines cap a large source file, persistedLimitLines caps a read of an output Claude
     Code had already spilled to disk. A single count told the owner nothing about which default it was
     evidence for. --caps lists the files. */
  const caps = transcript.readCapFiles(recs, null);

  console.log(`Tool results: ${fmt(posts.length)}   raw size: ${fmt(total)} chars ~ ${fmt(tok(total))} tokens`);
  console.log(`Trimmed by tokenbrake: ${trimmed} shell outputs, ${fmt(saved)} chars ~ ${fmt(tok(saved))} tokens kept out of context`);
  console.log(caps.n
    ? `Read caps fired: ${caps.n} -- ${caps.source.n} on a large source file (readLimitLines), `
      + `${caps.persisted.n} on a persisted output (persistedLimitLines)   (report --caps lists the files)\n`
    : 'Read caps fired: none\n');

  const byTool = {};
  for (const r of posts) { byTool[r.tool] = byTool[r.tool] || { n: 0, chars: 0 }; byTool[r.tool].n++; byTool[r.tool].chars += r.chars || 0; }
  console.log('By tool (share of raw result size):');
  for (const [t, v] of Object.entries(byTool).sort((a, b) => b[1].chars - a[1].chars).slice(0, 8)) {
    const pct = total ? Math.round(100 * v.chars / total) : 0;
    console.log(`  ${t.padEnd(12)} ${String(v.n).padStart(4)} calls  ${fmt(v.chars).padStart(10)} chars  ${String(pct).padStart(3)}%`);
  }

  console.log('\nTop 10 heaviest results:');
  for (const r of [...posts].sort((a, b) => b.chars - a.chars).slice(0, 10)) {
    const mark = r.kept != null ? `-> ${fmt(r.kept)} kept` : '';
    console.log(`  ${fmt(r.chars).padStart(9)} chars  ${(r.tool || '').padEnd(10)} ${String(r.what || '').slice(0, 60)} ${mark}`);
  }
}

function clean() {
  const outDir = path.join(TB_DIR, 'out');
  if (!fs.existsSync(outDir)) { console.log('nothing to clean'); return; }
  const days = Number((args.find(a => a.startsWith('--days=')) || '--days=7').split('=')[1]);
  const cutoff = Date.now() - days * 86400000;
  let n = 0;
  for (const f of fs.readdirSync(outDir)) {
    const p = path.join(outDir, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) { fs.unlinkSync(p); n++; } } catch {}
  }
  console.log(`removed ${n} saved outputs older than ${days} days`);
}

function help() {
  console.log(`tokenbrake -- trims oversized tool output before it reaches Claude's context

  npx tokenbrake init [--project] [--node=<path>]
                                      install hooks (user scope, or this project's .claude/);
                                      --node pins the executable the hook spawns (default: this node,
                                      or plain 'node' for --project so the file stays shareable)
  npx tokenbrake uninstall [--project]
  npx tokenbrake status               shows what is installed and spawns each hook once, as Claude Code would
  npx tokenbrake report               what ate your tokens last session: every tool result ranked by
                                      the context it was carried through (size x later requests), from
                                      the Claude Code transcript, with what tokenbrake trimmed
      --all                           one line per session on disk, newest first
      --session=<prefix>              a particular session;  --transcript=<path> a particular file
      --top=N                         widen the ranking (default 10);  --ledger  the guard's own record only
      --where                         every session pooled: where the model's ranged reads land, and what a
                                      Read cap at each size would have hidden. The evidence for
                                      readLimitLines. Reads a cap on the same file provoked are separated
                                      out -- the cap tells the model to come back with an offset, so those
                                      start lines are the cap's. Benchmark sessions are skipped;
                                      --cwd=<text> restricts the pool explicitly
      --caps                          every file the Read cap has fired on, pooled across sessions, with the
                                      two knobs counted apart and the share of each file delivered;
                                      --session=<prefix> narrows, --top=N widens
      --reads                         every file you read WHOLE, at its own size with Claude Code's line
                                      numbering subtracted: how many reads a lower readMaxBytes would catch,
                                      how much of each a limit would then withhold, and how deep the targets
                                      sit as a share of the file. The evidence for readMaxBytes
      --compare <A> <B>               two sessions side by side: cost, requests, cache reads, what entered
                                      and was carried, what the guard trimmed -- the AB-TASK.md table
  npx tokenbrake clean [--days=7]     delete saved full outputs older than N days`);
}

({ init, uninstall, status, report, clean, help })[cmd] ? ({ init, uninstall, status, report, clean, help })[cmd]() : help();
