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
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  /* Write a sibling temp file and rename it over the target, rather than writing p directly: fs.writeFileSync
     opens with O_TRUNC, emptying an existing config before the write runs, so a failed write (full disk, quota,
     I/O error) would leave it wiped. temp-then-rename leaves the ORIGINAL untouched on any THROWN error -- the
     temp absorbs the failure, the catch removes it and re-throws. `wx` (O_CREAT|O_EXCL) makes the temp refuse
     to open through a pre-existing file or symlink, so a name collision or a planted symlink in a shared config
     dir cannot redirect the write, and a random suffix keeps the name from colliding in the first place. rename
     within a directory is atomic and Node maps it to MOVEFILE_REPLACE_EXISTING on Windows; it replaces the
     target even when that target is itself a symlink (the config becomes a regular file), the accepted cost of
     an atomic replace. Not fsync-durable: a power loss in the rename window is out of scope for a config file. */
  const tmp = p + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(tmp, p); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
const HOOK_EVENTS = ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionStart'];
function isOurs(group) {
  return Array.isArray(group.hooks) && group.hooks.some(h =>
    String(h.command || '').includes('tokenbrake') || (h.args || []).some(a => String(a).includes('tokenbrake')));
}
/* Hash guard.js by CONTENT, not raw bytes: a Windows checkout with core.autocrlf=true (the default) has a CRLF
   working tree while the git blob and the npm tarball are LF -- identical code, different bytes. Hashing raw
   bytes reported a false STALE on every such checkout, on the very platform tokenbrake ships to. Normalize
   CRLF/CR -> LF first, so the staleness check measures code drift, not line endings. */
function guardSha(p) { try { return require('crypto').createHash('sha256').update(fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n')).digest('hex'); } catch { return null; } }

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

  /* After a compaction: compactPrep re-injects the working set when it is on, and shadow records what it would
     have injected when it is off. Registered either way, like every other feature's hook. */
  settings.hooks.SessionStart = (settings.hooks.SessionStart || []).filter(g => !isOurs(g));
  settings.hooks.SessionStart.push({ matcher: 'compact', hooks: [hook('session-start')] });

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
    for (const ev of HOOK_EVENTS) {
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenbrake-status-'));
  let payload = mode === 'read-pre'
    ? { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: __filename, limit: 1 } }
    : { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'tokenbrake status' },
        tool_response: { stdout, stderr: '', interrupted: false, isImage: false } };
  /* SessionStart: a one-edit transcript inside the throwaway config dir, with compactPrep on there, so the spawn
     proves the whole path -- the transcript is found, parsed, and the edited file comes back as a pointer. */
  const SELF_FILE = '/tokenbrake-self-test/edited.js';
  let r;
  try {
    if (mode === 'session-start') {
      const dir = path.join(tmp, 'projects', 'self-test');
      fs.mkdirSync(dir, { recursive: true });
      const tp = path.join(dir, 'self-test.jsonl');
      fs.writeFileSync(tp, [
        { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: SELF_FILE } }] } },
        { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
          toolUseResult: { structuredPatch: [{ newStart: 10, newLines: 3 }] } }
      ].map(e => JSON.stringify(e)).join('\n') + '\n');
      fs.writeFileSync(path.join(tmp, 'tokenbrake.json'), JSON.stringify({ compactPrep: true }));
      payload = { hook_event_name: 'SessionStart', source: 'compact', session_id: 'self-test', transcript_path: tp };
    }
    r = spawnSync(h.command, hookArgs, { input: JSON.stringify(payload), encoding: 'utf8', shell: false, timeout: 15000,
      env: { ...process.env, CLAUDE_CONFIG_DIR: tmp } });
  } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
  if (r.error) return `FAILED to start: ${r.error.code || r.error.message} -- '${h.command}' could not be spawned without a shell. Re-run init (records an absolute node path) or init --node=<path-to-node>.`;
  if (r.status !== 0) return `FAILED: exit ${r.status}${r.stderr ? ' -- ' + r.stderr.trim().split('\n')[0] : ''}`;
  if (mode === 'read-pre') return r.stdout.trim() === '' ? 'ok (spawns; bounded read left untouched)' : `unexpected output: ${r.stdout.slice(0, 80)}`;
  let out; try { out = JSON.parse(r.stdout); } catch { return `FAILED: stdout is not JSON: ${r.stdout.slice(0, 80)}`; }
  if (mode === 'session-start') {
    const ctx = out && out.hookSpecificOutput && out.hookSpecificOutput.additionalContext;
    return typeof ctx === 'string' && ctx.includes(SELF_FILE) && ctx.includes('lines 10-12')
      ? `ok (spawns; a compaction's working set comes back as pointers, ${ctx.length} chars)` : 'FAILED: no working set in additionalContext';
  }
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
  console.log(`  SessionStart compaction prep: ${has('SessionStart') ? 'installed' : 'missing (re-run init)'}`);
  /* Is the INSTALLED guard the one this checkout ships? `init` copies guard.js; nothing afterwards keeps the
     copy in step. `test.mjs` pins the project-scope copy, and the user-scope copy had nothing watching it at
     all -- so a guard.js change with no re-run leaves the machine quietly running an older build while its
     ledger is read as evidence about the current one. That matters most exactly when the ledger is being
     collected on purpose, which is what a user-scope install is for. */
  const srcSha = guardSha(path.join(__dirname, 'guard.js'));
  const copySha = guardSha(guardFile);
  const drift = srcSha && copySha && srcSha !== copySha;
  console.log(`  guard file: ${fs.existsSync(guardFile) ? 'present' : 'missing'} (${guardFile})`);
  console.log(`  guard build: ${!copySha ? 'no copy installed'
    : !srcSha ? 'installed, and this checkout has no guard.js to compare against'
    : drift ? 'STALE -- the installed copy is not this checkout\'s guard.js (' + copySha.slice(0, 12) + ' vs '
      + srcSha.slice(0, 12) + '). Re-run `' + (PROJECT ? 'node cli.js init --project' : 'node cli.js init')
      + '`: until you do, the ledger records an older guard while the report reads it as this one.'
    : 'matches this checkout (' + srcSha.slice(0, 12) + ')'}`);
  for (const ev of HOOK_EVENTS) for (const g of ours(ev)) for (const h of g.hooks) {
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
  const otherHas = !!(other && other.hooks && HOOK_EVENTS.some(ev => (other.hooks[ev] || []).some(isOurs)));
  const thisHas = HOOK_EVENTS.some(has);
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
  const D = transcript.GUARD_DEFAULTS;   // the guard's own defaults, not copies
  const cfg = { maxChars: D.maxChars, readMaxBytes: D.readMaxBytes, readLimitLines: D.readLimitLines, persistedLimitLines: D.persistedLimitLines, raw: {} };
  try {
    const c = JSON.parse(fs.readFileSync(path.join(CFG_DIR, 'tokenbrake.json'), 'utf8'));
    if (c && typeof c === 'object' && !Array.isArray(c)) cfg.raw = c;   // the file as written, for the report's replay
    if (c.maxChars) cfg.maxChars = c.maxChars;
    if (c.readMaxBytes) cfg.readMaxBytes = c.readMaxBytes;
    if (c.readLimitLines) cfg.readLimitLines = c.readLimitLines;
    if (c.persistedLimitLines) cfg.persistedLimitLines = c.persistedLimitLines;
    /* Per-tool maxChars, which the guard's toolConfig merges over the top level: a report that ignored them would
       count a Bash result under tools.Bash.maxChars as one the guard "would have trimmed". */
    if (c.tools && typeof c.tools === 'object') {
      const per = {};
      for (const [tool, v] of Object.entries(c.tools)) if (v && typeof v === 'object' && v.maxChars) per[tool] = v.maxChars;
      if (Object.keys(per).length) cfg.toolMaxChars = per;
    }
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
  console.log('  Source files, Read cap (readLimitLines):  ' + String(c.source.n).padStart(3) + ' caps, '
    + c.source.files + ' file(s), ~ ' + fmt(tok(c.source.bytes)) + ' tokens of file');
  /* The same two knobs, the other path. A `cat` of a large file is capped after the fact by the POST hook
     against the same readMaxBytes and readLimitLines, but it logs as a trimmed post, not as a read-cap row.
     Counting only read-cap rows reports one of the two paths those knobs govern and calls the other zero. */
  console.log('  Same knobs via a shell cat:              ' + String(c.excerpt.n).padStart(3) + ' caps, '
    + c.excerpt.files + ' file(s), ~ ' + fmt(tok(c.excerpt.bytes)) + ' tokens of file');
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
  console.log('  the source-file half fires on real work is the question readMaxBytes turns on: here, '
    + (c.source.n + c.excerpt.n) + ' time(s) across both paths (' + c.source.n + ' Read, ' + c.excerpt.n + ' shell cat).');
}

/* `--reads`: the other half of the Read cap's evidence. `--where` says where the model looks; this says how
   big the files it reads whole actually are, which is what `readMaxBytes` acts on, and how deep the targets
   sit as a FRACTION of the file, which is what says whether an absolute line cap is even the right shape.

   The trigger has never had an argument. 60,000 was a guess; one paid A/B lowering it to 25,000 cost +10%
   with a task that said "read in full", which forbids the saving by construction. Half of that question is
   arithmetic over a person's own reads -- how many a lower trigger catches and how much of each it cuts --
   and this mode does that half for free. The half it cannot do is whether the model comes back. */
/* `--reach`: of everything that entered context, how much sits where the trim can act at ALL -- shell, exit 0,
   over maxChars, under Claude Code's inline ceiling -- and which tools put it there.

   The question comes from a benchmark round that abandoned its own schedule: handed a CLI that could slice a
   log, the agent sliced, and the guard rewrote nothing the model saw. The round before it, on a workspace
   whose tools only dump, the mechanism was there. So the trim's reach may be a property of the TOOLING rather
   than of the work -- and a person's own sessions are a better sample of "an agent with decent tools" than
   any fixture can stage. AB-TASK.md, "Does the trim's mechanism appear when the agent has decent tools?",
   carries the rule and the thresholds, fixed before this was ever run.

   The share reported is of CARRIED tokens, not of results: a result costs its size times the later requests
   that re-read it, so counting results answers a different question from the one about the tokens. */
function reachReport() {
  const opt = (name) => { const a = args.find(x => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null; };
  const only = opt('--cwd');
  const top = Number(opt('--top') || 12) || 12;
  const cfg = guardCfg();
  const ledger = loadLedger();
  const found = transcript.findTranscripts(CFG_DIR);
  if (!found.length) { console.log('No transcripts found under ' + path.join(CFG_DIR, 'projects') + '.'); return; }
  const pooled = [], skipped = [], sessions = [];
  for (const f of found) {
    const id = String(f.session).slice(0, 8);
    let p;
    try { p = transcript.parseTranscript(f.file); } catch { skipped.push([id, 'unreadable']); continue; }
    const cwd = p.cwd || '';
    if (only) {
      if (!cwd.toLowerCase().includes(only.toLowerCase())) { skipped.push([id, 'cwd does not contain "' + only + '"']); continue; }
    } else if (/tokenbrake-bench/i.test(cwd)) {
      skipped.push([id, 'benchmark session -- a staged workload, which is the thing this view exists to check against']);
      continue;
    }
    transcript.carry(p);
    const trimmed = transcript.trimmedResults(p, ledger);
    if (!p.results.length) { skipped.push([id, 'no tool results']); continue; }
    /* "The guard was here and chose not to act" and "the guard was not here" produce an identical untouched
       bucket and opposite conclusions -- the first is a design choice to argue about, the second is a
       coverage gap. The ledger tells them apart: a session the guard ran in wrote rows in it. This is the
       third place today the same distinction decided everything. */
    const sid = p.sessionId || f.session;
    const g = transcript.guardRan(p, ledger, sid);
    /* File sizes for the Read split below, keyed by result id. Taken from `unboundedReads` -- the same
       provenance chain `--reads` uses -- rather than from the delivered text, which is the cap's own output
       on any read it already acted on. */
    const sizes = new Map();
    try {
      for (const rd of transcript.unboundedReads(p, ledger, { sessionId: sid, readMaxBytes: cfg.readMaxBytes }).reads) {
        /* A read at a ceiling (refused, errored, cut at the host's line limit, near its size limit) is sized
           by what came back, not by the file -- leave it unsized rather than guess it into a bucket. */
        if (rd && rd.id != null && rd.bytes != null && !rd.ceiling) sizes.set(rd.id, rd.bytes);
      }
    } catch { /* no sizes for this session; the split reports them as unsized rather than guessing */ }
    sessions.push({ parsed: p, trimmed, sizes, ran: g.ran, via: g.via });
    pooled.push([id, p.results.length, cwd]);
  }
  const withGuard = sessions.filter((x) => x.ran);
  const r = transcript.reachPooled(sessions, { readMaxBytes: cfg.readMaxBytes, maxChars: cfg.maxChars, toolMaxChars: cfg.toolMaxChars });
  const rg = transcript.reachPooled(withGuard, { readMaxBytes: cfg.readMaxBytes, maxChars: cfg.maxChars, toolMaxChars: cfg.toolMaxChars });
  const shellN = r.shell.n;
  console.log('Where the trim can reach -- ' + pooled.length + ' session(s) pooled, ' + skipped.length + ' skipped'
    + (only ? '  (--cwd=' + only + ')' : ''));
  console.log('\n  ' + fmt(r.total.n) + ' tool results, ~ ' + fmt(r.total.carried) + ' carried tokens in total'
    + '  (' + fmt(shellN) + ' of them shell)');
  /* One printer and one percent, for both tables below. They differ only in their denominator -- a share is
     always of some total -- and letting each table carry its own copy of the round-to-one-decimal formula is
     how two tables in one view end up quietly disagreeing about what a percent is. */
  const pc = (x) => (Math.round(1000 * x) / 10) + '%';
  const row = (label, b, denom) => console.log('    ' + label.padEnd(38) + String(b.n).padStart(6)
    + fmt(b.carried).padStart(12) + (denom ? pc(b.carried / denom).padStart(8) : ''));
  console.log('\n    bucket                                    results     carried   share');
  row('within the trim\'s reach', r.window, r.carriedTotal);
  row('  of those, it acted on', r.acted, r.carriedTotal);
  row('  of those, it did not', r.untouched, r.carriedTotal);
  row('under the threshold (too small)', r.under, r.carriedTotal);
  row('single-file excerpt (read path)', r.excerpt, r.carriedTotal);
  row('past the host ceiling (persisted)', r.persisted, r.carriedTotal);
  row('failed (host ignores a rewrite)', r.failed, r.carriedTotal);
  row('not shell at all', r.nonShell, r.carriedTotal);

  /* The last row of that table, opened up. It was 41% of carried tokens on the sessions this was written
     from and the view named none of it. Pooled over the SAME sessions as the table -- not the guarded subset
     the verdict below uses -- because what a Read costs is a fact about the workload whether the guard ran or
     not, and because these rows have to sum to the row above them. */
  if (r.nonShellTools.length) {
    console.log('\n  What that last row is, by tool:');
    console.log('    results      carried   share  tool');
    for (const t of r.nonShellTools.slice(0, top)) {
      console.log('    ' + String(t.n).padStart(7) + fmt(t.carried).padStart(13) + '  '
        + (r.nonShell.carried ? pc(t.carried / r.nonShell.carried).padStart(6) + '  ' : '') + t.tool);
    }
    if (r.nonShellTools.length > top) console.log('    (+ ' + (r.nonShellTools.length - top) + ' more; --top=N)');
  }
  const b = r.read;
  if (b.all.n) {
    console.log('\n  Read is the one the trim never sees: every branch of the PostToolUse handler is gated on'
      + '\n  shell or mcp__*, so a Read result is not trimmed at all, ever. Its only lever is the PreToolUse'
      + '\n  cap, which fires on an UNBOUNDED read of a file over readMaxBytes (' + fmt(cfg.readMaxBytes) + '). What that leaves:');
    console.log('\n    of Read\'s carried tokens                    results     carried   share');
    row('ranged -- the cap leaves these alone', b.ranged, b.all.carried);
    row('whole, at or under the trigger', b.under, b.all.carried);
    row('whole, over it  <- the cap\'s own share', b.over, b.all.carried);
    if (b.unsized.n) row('whole, size unknown', b.unsized, b.all.carried);
    console.log('\n    Only the third line is a read the cap can act on'
      + (b.all.carried && r.total.carried
        ? ' -- ' + pc(b.over.carried / r.total.carried) + ' of everything carried,'
          + '\n    against Read\'s ' + pc(b.all.carried / r.total.carried) + '.'
        : '.'));
    console.log('    A ranged read is excluded BY DESIGN: 0.2.3 stopped trimming single-file excerpts because');
    console.log('    doing it taught the model to read in 80-line chunks and doubled the tokens on one task. So');
    console.log('    this is not a defect list. It is the size of what the product declines to touch, and the');
    console.log('    honest moves on it withhold nothing the model does not already have -- reReadElide is the');
    console.log('    one with a measured record here; `tokenbrake tune` says whether it has fired for you.');
    if (b.unsized.n) {
      console.log('    "size unknown" is a whole read nothing could size: a failed read, one cut at the host\'s own');
      console.log('    limit, a read of a spilled tool output, or one with no ledger row and no line numbering.');
      console.log('    It is reported apart rather than guessed into a bucket.');
    }
  }

  /* Everything above pools sessions the guard never ran in, where "untouched" says nothing about the guard.
     The verdict is taken from the sessions it DID run in, because those are the only ones where a result
     inside the reach and left alone is a fact about the product. */
  const byMarker = withGuard.filter((x) => x.via === 'marker').length;
  console.log('\n  Of the ' + pooled.length + ' session(s) pooled, the guard was recording in ' + withGuard.length + '.');
  /* A transcript read away from the machine it ran on has no ledger beside it. Its own trim markers are the
     proof instead -- and they are proof in one direction only. */
  if (byMarker) console.log('    ' + byMarker + ' of those from a trim marker in the transcript rather than a ledger row: the'
    + '\n    ledger does not travel with a transcript, so a session moved off the machine it ran on has none.'
    + '\n    That route is a LOWER BOUND -- a session the guard ran in and never trimmed carries no marker.');
  if (!withGuard.length) {
    console.log('  Nothing below can be read as a fact about the guard: it was not running in any of them.');
  } else {
    console.log('    within reach there: ' + rg.window.n + ' result(s), ' + fmt(rg.window.carried) + ' carried'
      + (rg.carriedTotal ? ' (' + (Math.round(1000 * rg.windowShareOfCarried) / 10) + '% of what those sessions carried)' : ''));
    console.log('    acted on: ' + rg.acted.n + '  left alone: ' + rg.untouched.n
      + (rg.window.carried ? '  -- the guard reached ' + Math.round(100 * rg.acted.carried / rg.window.carried) + '% of the carried tokens it could' : ''));
    console.log('    A result inside the reach and left alone, in a session the guard WAS running in, is the');
    console.log('    product declining to act -- a noTrim entry, or output the trim could not shorten. Single-file');
    console.log('    excerpts are not among them: the guard reads those like a Read, and they have their own row above.');
  }

  const W = rg.windowShareOfCarried;
  console.log('\n  W = ' + (Math.round(1000 * W) / 10) + '% of carried tokens sit where the trim can act,'
    + '\n  measured over the sessions the guard was actually running in.');
  const shellG = rg.shell.n;
  const THIN = withGuard.length < 10 || shellG < 200;
  console.log('  ' + (THIN
    ? 'Under 10 sessions or 200 shell results: NO VERDICT, and the number above is not one.'
    : W < 0.05 ? 'Under 5%: the mechanism is essentially absent on this work. No quality of trimming can'
        + '\n  matter at that share -- the guard is not the useful part of this product on your sessions.'
      : W >= 0.20 ? 'At or above 20%: the mechanism is present and worth having on your work.'
        : 'Between 5% and 20%: present but marginal. That is the number; there is no claim to make from it.'));

  /* Split the same way the verdict is. A tool list pooled over sessions the guard never ran in answers the
     tooling question for a machine with no guard on it -- which is a different question, and mixing them is
     the error this view had one line below the one it had just fixed. */
  const toolRows = withGuard.length ? rg.tools : r.tools;
  if (toolRows.length) {
    console.log('\n  What put results in the trim\'s reach -- the tooling question, not the workload one.');
    console.log('  ' + (withGuard.length
      ? 'Only the ' + withGuard.length + ' session(s) the guard was recording in, since a tool list from sessions'
        + '\n  without it describes a machine that is not running this product:'
      : 'No session had the guard, so this is every pooled session and says nothing about the guard:'));
    console.log('    results      carried  tool');
    for (const t of toolRows.slice(0, top)) {
      console.log('    ' + String(t.n).padStart(7) + fmt(t.carried).padStart(13) + '  ' + t.tool);
    }
    if (toolRows.length > top) console.log('    (+ ' + (toolRows.length - top) + ' more; --top=N)');
    if (withGuard.length && r.tools.length) {
      console.log('    (across all ' + pooled.length + ' pooled session(s), guard or not, the heaviest were: '
        + r.tools.slice(0, 3).map((t) => t.tool + ' ' + fmt(t.carried)).join(', ') + ' -- context, not evidence.)');
    }
    console.log('    A tool that only dumps makes trimmable output; one that can slice does not, and a model');
    console.log('    that can slice will. If this list is short and every entry is a dump with no ranged mode,');
    console.log('    the reach is a property of the tools and the honest fix is to give them a ranged mode.');
  } else {
    console.log('\n  Nothing reached the trim at all, so there is no tool list to show.');
  }
  printPool(pooled, skipped);
}

function readsReport() {
  const opt = (name) => { const a = args.find(x => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null; };
  const only = opt('--cwd');
  const TRIGGERS = transcript.READ_MAX_STEPS;   // one list with tune's readMaxBytes grid
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
  const pooled = [], skipped = [], missed = [];
  const ledgerSessions = new Set(ledger.map(r => r && r.session).filter(Boolean));
  let reads = [], depths = [];
  let capped = 0, recOrig = 0, recRew = 0, nearCeiling = 0, noLines = 0, unresolved = 0;
  let hostLines = 0, refused = 0, errored = 0, persistedSkipped = 0, files = 0;
  const sources = { ledger: 0, ledgerWhole: 0, ledgerPost: 0, numbering: 0, text: 0 };
  const bySource = { session: 0, ledger: 0, eof: 0, disk: 0 };
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
    const u = transcript.unboundedReads(p, ledger, { sessionId, readMaxBytes: cfg.readMaxBytes });
    const d = transcript.readDepths(p, ledger, { sessionId, linesOnDisk });
    /* The product's own self-check, and the reason it exists: a read over readMaxBytes that was NOT capped
       means either the guard was not running in that session or it did not fire. Those are the same evidence
       and opposite conclusions -- "the cap is inert on this workload" against "the cap is not running on this
       workload" -- and nothing in this repo could tell them apart. The ledger settles it: if it holds no row
       at all for a session, the guard was not there; if it holds rows and the read still went through
       unbounded, the cap had its chance and missed. `u.over` is that predicate, owned by unboundedReads. */
    if (u.over) missed.push([id, u.over, ledgerSessions.has(sessionId)]);
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
  /* No whole-file reads says everything about readMaxBytes and nothing about the cap's SHAPE, which is
     answered from ranged reads alone. Bailing out of the whole report here hid the shape block from anyone who
     reads with offsets, which is the reading the guard most wants to encourage. */
  if (!reads.length) console.log('\n  No whole-file reads in any pooled session. readMaxBytes has nothing to act'
    + ' on here at any value:\n  every read arrived bounded, which is the cheapest shape there is.');
  const sized = reads.filter(r => !r.ceiling);
  if (reads.length) {
  const sizes = sized.map(r => r.bytes || 0).sort((a, b) => a - b);
  const q = (f) => sizes.length ? sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * f))] : 0;
  console.log('\n  ' + reads.length + ' whole-file read(s) of ' + files + ' file(s) -- '
    + fmt(reads.reduce((t, r) => t + (r.bytes || 0), 0)) + ' bytes in total'
    + (sizes.length ? ', median ' + fmt(q(0.5)) + ', 90th percentile ' + fmt(q(0.9)) + ', largest ' + fmt(q(1)) : ''));
  /* Sizes are the FILE's, not what the read cost. Claude Code numbers every line it delivers and that
     numbering is its own, not the file's -- 5-6% of the delivered text on a 350-line file, and growing with
     the line count. readMaxBytes is compared against statSync().size, so leaving the numbering in overstates
     every file and overstates long ones most, right at the boundary this grid is about. */
  console.log('    Sized from: ' + (sources.ledger + sources.ledgerWhole) + ' a ledger row the guard wrote at the'
    + ' moment of the read (statSync, exact), ' + sources.ledgerPost
    + ' a ledger post row (a cat the guard capped -- its size before the cap), ' + sources.numbering
    + '\n      the Read\'s own line numbering (subtracted), ' + sources.text + ' the delivered text as-is (an uncapped cat).');
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
  const rows = transcript.triggerGrid(sized, TRIGGERS, LIMITS, { maxChars: cfg.maxChars });
  for (const g of rows) {
    console.log('    ' + String(g.trigger).padStart(7) + String(g.caught).padStart(8)
      + (Math.round(100 * g.byteShare) + '%').padStart(7)
      + LIMITS.map(l => (g.byLimit[l] == null ? '-' : Math.round(100 * g.byLimit[l]) + '%').padStart(6)).join('')
      + (g.trigger === cfg.readMaxBytes ? '   <- your readMaxBytes' : '')
      + (g.inert ? '   <- ' + g.inert + ' read(s) inert here: a shell read at or under maxChars never reaches the cap' : ''));
  }
  /* The two paths that share readMaxBytes do not share its floor, and the grid used to model only one of them.
     An unbounded Read is capped by the PreToolUse hook, which compares statSync().size and has no floor. A cat
     goes through the POST hook, which returns at or under maxChars before any cap logic runs (guard.js:272) --
     so below maxChars the trigger is a dead knob for it. With the default triggers all sitting above maxChars
     no row is ever marked, which is exactly why the floor is stated here rather than only when it bites: the
     question "what would a trigger of 2,000 have saved" was asked, and the unmodelled grid answered it too
     high. */
  const shellReads = sized.filter((r) => r.via === 'post').length;
  console.log('    Floor: ' + shellReads + ' of these ' + sized.length + ' read(s) are shell reads (a cat), and for those the'
    + '\n    effective trigger is never lower than maxChars (' + fmt(cfg.maxChars) + ') -- the POST hook returns at or under it'
    + '\n    before any cap logic (guard.js:272). Only an unbounded Read is capped straight off readMaxBytes.');
  /* The miss rate belongs beside the grid but not inside it: it is measured over ranged reads, a different
     population from the whole-file reads the trigger catches. Printing them in one table would invite adding
     them up. */
  }
  const tgt = transcript.readTargets({ results: depths.map(d => ({ readFrom: d.start })) }, LIMITS);
  if (tgt.n && reads.length) {
    console.log('\n  Chance each capped read sends the model back, by limit -- from your ranged reads, which are a');
    console.log('  DIFFERENT population from the whole-file reads above. Read it beside the grid, not added to it:');
    console.log('    ' + LIMITS.map(l => l + ': ' + Math.round(100 * tgt.past[l] / tgt.n) + '%').join('   '));
  }

  console.log('\n  How deep the targets sit -- ' + depths.length + ' read(s) with a known file length'
    + (unresolved ? ', ' + unresolved + ' unresolved and left out' : ''));
  if (depths.length) {
    console.log('    line length known from: ' + bySource.session + ' a whole-file read in the same session, '
      + bySource.ledger + ' the ledger, ' + bySource.eof + ' a read that ran off the end of the file,'
      + '\n      ' + bySource.disk + ' the file on disk now (may have changed -- excluded from the verdict below)');
    const d2 = { n: depths.length, rows: depths };
    const cv = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return m ? Math.sqrt(xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1)) / m : null; };
    /* Exact means the length was established at the time of the read: a whole-file read in the session, a
       ledger row the guard wrote, or a read that ran off the end. The file on disk today is none of those. */
    const exact = depths.filter(r => r.source !== 'disk' && r.lines > 0 && r.start > 0);
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
    /* The form question, computed only from lengths established at the time of the read. AB-TASK.md,
       "The Read cap's form": the rule and its thresholds were committed before this ran. */
    const rows = exact.map(r => ({ start: r.start, lines: r.lines, bpl: r.bpl }));
    const front = transcript.capFrontier(rows);
    if (front.n >= 20) {
      const v = transcript.frontierVerdict(front);
      console.log('\n  Which SHAPE of cap serves your reading -- over the ' + front.n + ' reads with an exact file length:');
      console.log('    cap                    withholds   misses');
      const line = (label, p) => console.log('    ' + label.padEnd(22)
        + (Math.round(100 * p.withheld) + '%').padStart(8) + (Math.round(100 * p.miss) + '%').padStart(9));
      line('no cap at all', front.none);
      for (const p of front.absolute) line('first ' + p.param + ' lines', p);
      for (const p of front.fractional) line('first ' + Math.round(100 * p.param) + '% of the file', p);
      const name = (p) => !p ? 'nothing' : p.shape === 'none' ? 'no cap at all'
        : p.shape === 'absolute' ? 'the first ' + p.param + ' lines'
        : 'the first ' + Math.round(100 * p.param) + '% of the file';
      const at = (p) => !p ? '' : name(p) + ' (withholds ' + Math.round(100 * p.withheld) + '%, misses '
        + Math.round(100 * p.miss) + '%)';
      console.log('    Safest useful cap of each shape, at a miss budget of ' + Math.round(100 * v.maxMiss) + '%:');
      console.log('      absolute:   ' + at(v.absolute));
      console.log('      fractional: ' + at(v.fractional));
      console.log('    Verdict: ' + (v.verdict === 'tie'
        ? 'a TIE -- the two shapes save within ' + Math.round(100 * v.edge) + ' points of each other at the same'
          + '\n    safety, so nothing here argues for changing the form.'
        : v.verdict === 'neither can be safe and useful'
          ? 'NEITHER shape can be both safe and useful. The only cap of either shape that stays inside'
            + '\n    the miss budget is no cap at all, so one number is the wrong form and no value fixes it.'
          : v.verdict.toUpperCase() + ' saves more at the same safety, by '
            + Math.round(100 * Math.abs((v.fractional ? v.fractional.withheld : 0) - (v.absolute ? v.absolute.withheld : 0)))
            + ' points of withholding.'));
      console.log('    Safety is held fixed and saving compared, because that is the trade a cap makes. A miss');
      console.log('    rate on its own is beaten by any cap that withholds less, down to withholding nothing.');
      /* The same comparison priced in tokens. A share of a file's LINES weights a 200-line file like a
         2,000-line one, and a fractional cap's extra saving lands mostly on short files -- which is cheap.
         AB-TASK.md, "A fractional Read cap", Step A: this is the measure that decides whether the line-share
         margin is saving worth having. */
      const vt = transcript.frontierVerdict(front, { measure: 'tokens' });
      console.log('\n    Priced in tokens instead of in share of lines -- ' + front.priced + ' of ' + front.n
        + ' reads carry a\n    bytes-per-line of their own; the rest are outside this measure, never estimated into it:');
      console.log('      absolute:   ' + (vt.absolute ? name(vt.absolute) + ' saves ' + Math.round(100 * vt.saved.absolute) + '% of these reads\' tokens' : 'nothing'));
      console.log('      fractional: ' + (vt.fractional ? name(vt.fractional) + ' saves ' + Math.round(100 * vt.saved.fractional) + '% of these reads\' tokens' : 'nothing'));
      console.log('      Verdict on tokens: ' + (vt.verdict === 'tie' ? 'a TIE'
        : vt.verdict === 'neither can be safe and useful' ? 'NEITHER can be safe and useful' : vt.verdict.toUpperCase())
        + (vt.verdict === 'fractional' || vt.verdict === 'absolute'
          ? ', by ' + Math.round(100 * Math.abs(vt.saved.fractional - vt.saved.absolute)) + ' points' : ''));
      if (front.priced < 20) console.log('      (under 20 reads with a bytes-per-line: no verdict on tokens, and'
        + ' the line above says so\n      rather than reporting a shape that nothing was measured for.)');
    }
    console.log('\n  Target depth as a share of the file:');
    for (const b of transcript.startHistogram(depths.map(r => Math.round(100 * r.depth)), [0, 10, 20, 30, 40, 50, 60, 80, 101])) {
      const to = b.to > 100 ? '100%' : String(b.to) + '%';
      console.log('    ' + (String(b.from) + '%').padStart(5) + '..' + to.padEnd(5) + String(b.n).padStart(5) + '  ' + b.bar);
    }
  }
  if (missed.length) {
    const withGuard = missed.filter(([, , had]) => had);
    const without = missed.filter(([, , had]) => !had);
    const total = missed.reduce((t, [, n]) => t + n, 0);
    console.log('\n  ' + total + ' read(s) over your readMaxBytes of ' + fmt(cfg.readMaxBytes) + ' that were NOT capped:');
    if (without.length) console.log('    ' + without.reduce((t, [, n]) => t + n, 0) + ' in ' + without.length
      + ' session(s) with no ledger row at all -- the guard was not running there, so the cap never had a chance:'
      + '\n      ' + without.map(([i, n]) => i + ' (' + n + ')').join('  '));
    if (withGuard.length) console.log('    ' + withGuard.reduce((t, [, n]) => t + n, 0) + ' in ' + withGuard.length
      + ' session(s) the guard WAS recording in -- it had its chance on these and did not fire, which is a'
      + '\n      defect and not a tuning question:  ' + withGuard.map(([i, n]) => i + ' (' + n + ')').join('  '));
    console.log('    Why this line exists: a read over the trigger with no cap is the same evidence for "the cap');
    console.log('    is inert on this workload" and for "the cap is not running on this workload", and those are');
    console.log('    opposite conclusions. The ledger is what tells them apart.');
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
  console.log('  withholds, which is behavioural and has taken real sessions to find out before (AB-TASK.md).');
}

/* `--compactions`: every compaction on this machine, priced with the calibrated weights -- the measurement for
   stage 2 of "An earlier compaction window" (AB-TASK.md). Per compaction: the saving the drop in context buys
   until the next one, and the recovery, files re-read in the 30 requests after it that were read before. The
   stage counts automatic compactions on Opus 5 only, outside benchmark and calibration sessions, from --since. */
function compactionsReport() {
  const opt = (name) => { const a = args.find(x => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null; };
  const since = opt('--since') ? Date.parse(opt('--since')) : null;
  if (opt('--since') && !Number.isFinite(since)) { console.log('--since takes a date, like --since=2026-09-19'); process.exitCode = 1; return; }
  const W = transcript.LIMIT_WEIGHTS;
  const [chargeLow, chargeHigh] = transcript.COMPACT_CHARGE;
  const rows = [];
  for (const f of transcript.findTranscripts(CFG_DIR)) {
    let p;
    try { p = transcript.parseTranscript(f.file); } catch { continue; }
    if (!p.boundaries.length) continue;
    const excluded = /tokenbrake-bench|calibration/i.test(p.cwd || '');
    for (const r of transcript.compactionView(p)) {
      if (since && (r.at || 0) < since) continue;
      r.eligible = !excluded && r.trigger === 'auto' && String(r.model || '').startsWith(W.model);
      r.why = excluded ? 'benchmark/calibration' : r.trigger !== 'auto' ? (r.trigger || '?') + ' trigger' : !r.eligible ? 'model ' + (r.model || '?') : '';
      rows.push(r);
    }
  }
  const k = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1000) + 'k';
  console.log('Compactions -- ' + rows.length + ' found' + (since ? ' since ' + opt('--since') : '')
    + '. Points of the five-hour window, calibrated on Opus 5 (AB-TASK.md, "Calibration results").');
  if (!rows.length) { console.log('\n  None yet. A compaction is recorded in the transcript when Claude Code compacts a session.'); return; }
  console.log('\n  when              trigger  context       later  saving  recovery (files re-read)   counts');
  for (const r of rows.sort((a, b) => (a.at || 0) - (b.at || 0))) {
    const when = r.at ? new Date(r.at).toISOString().slice(0, 16).replace('T', ' ') : '?';
    console.log('  ' + when.padEnd(17) + ' ' + String(r.trigger || '?').padEnd(8) + ' ' + (k(r.pre) + ' -> ' + k(r.post)).padEnd(13)
      + ' ' + String(r.later).padStart(5) + '  ' + r.saving.toFixed(2).padStart(6) + '  '
      + (r.recovery.pts.toFixed(2) + ' (' + r.recovery.files.length + ')').padEnd(25) + '  ' + (r.eligible ? 'yes' : 'no -- ' + r.why));
  }
  const el = rows.filter(r => r.eligible);
  const saving = el.reduce((s, r) => s + r.saving, 0);
  const recovery = el.reduce((s, r) => s + r.recovery.pts, 0);
  const share = (c) => saving > 0 ? Math.round(100 * c / saving) + '%' : 'n/a';
  const costLow = recovery + chargeLow * el.length, costHigh = recovery + chargeHigh * el.length;
  console.log('\n  Counted: ' + el.length + ' of the 8 automatic compactions stage 2 needs.'
    + '  Saving ' + saving.toFixed(1) + ' points; recovery ' + recovery.toFixed(1)
    + '; compaction charged at ' + chargeLow + ' and ' + chargeHigh + ' points each.');
  console.log('  Cost as a share of the saving: ' + share(costLow) + ' at the estimate, ' + share(costHigh) + ' at the bound.'
    + ' Stage 2 passes under 50% at the bound, with 8 counted.');
  if (el.length >= 8) console.log('  Verdict: ' + (saving > 0 && costHigh < saving / 2 ? 'PASS' : costLow < saving / 2 ? 'NOT YET -- passes at the estimate, not at the bound; the default stays off' : 'FAIL') + ' (and only with no more than one "felt worse" logged).');
  console.log('\n  Recovery is inferred: a file read again after a compaction may be one the next step needed anyway.');
}

function report() {
  if (flag('--ledger')) return ledgerReport();
  if (flag('--where')) return whereReport();
  if (flag('--caps')) return capsReport();
  if (flag('--reads')) return readsReport();
  if (flag('--reach')) return reachReport();
  /* --cost (and its --model repricing) was retired on 2026-09-18: tokenbrake states everything in tokens,
     never money. Say so and exit non-zero, so a script that relied on it does not read the plain report as it. */
  if (flag('--cost')) { console.log('report --cost was removed: tokenbrake reports tokens only (entered, carried, cache), never money. The plain report and report --backfire carry the token figures.'); process.exitCode = 1; return; }
  if (flag('--backfire')) return auditReport();
  if (flag('--compactions')) return compactionsReport();
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
      /* This printed the newest 30 under a header that said 65, with nothing to say 35 were missing, and a
         conclusion was drawn from the visible part within the hour. --top now governs it and an omission
         says so. The counts below are taken over EVERY session, not the printed ones: a count whose
         population is smaller than the header says is the same defect one line further down. */
      const allTop = Number(opt('--top') || 30) || 30;

      const rows = found.map((f) => {
        let p;
        try { p = transcript.parseTranscript(f.file); } catch (e) { return { f, err: e.message }; }
        const cwd = p.cwd || '';
        const g = transcript.guardRan(p, ledger, String(p.sessionId || f.session));
        return { f, p, cwd, bench: /tokenbrake-bench/i.test(cwd), guard: g.ran, via: g.via };
      });
      const shown = rows.slice(0, allTop);
      console.log('Sessions, newest first (' + rows.length
        + (rows.length > shown.length ? ', newest ' + shown.length + ' shown' : '') + '):');
      for (const x of shown) {
        if (x.err) { console.log('  ' + x.f.session.slice(0, 8) + '...  unreadable: ' + x.err); continue; }
        console.log(transcript.renderSummaryLine(x.p, { guard: x.guard, tag: x.bench ? 'bench' : '' }));
      }
      if (rows.length > shown.length) console.log('  (' + (rows.length - shown.length)
        + ' older session(s) not listed -- add --top=' + rows.length + ' for every one)');
      const readable = rows.filter((x) => !x.err);
      const bench = readable.filter((x) => x.bench).length;
      const guarded = readable.filter((x) => x.guard).length;
      const outside = readable.filter((x) => x.guard && !x.bench).length;
      const byMarkerAll = readable.filter((x) => x.via === 'marker').length;
      console.log('\n  guard = the guard was running in that session -- established from its ledger rows, or, when the');
      console.log('  ledger has none (a transcript read away from the machine it ran on carries no ledger), from a');
      console.log('  trim marker in the transcript itself. A blank means it was not running there, which is a');
      console.log('  different conclusion from running and leaving everything alone, and the two look identical in');
      console.log('  every other column. bench = a cwd under tokenbrake-bench, which --where, --reads and --reach');
      console.log('  skip by default as a staged workload.');
      if (byMarkerAll) console.log('  ' + byMarkerAll + ' session(s) here rest on the marker alone, which is a LOWER BOUND: one the guard'
        + '\n  ran in and never trimmed carries no marker and reads as a blank.');
      console.log('  Of ' + readable.length + ' readable session(s): ' + bench + ' benchmark, ' + guarded
        + ' with guard records, ' + outside + ' with guard records outside the benchmark.');
      console.log('  That last number is the population a claim about ordinary work has to come from. It is still');
      console.log('  not a count of eligible sessions: an A/B arm is ordinary work by its cwd and is not ordinary');
      console.log('  work, and no transcript says it was an arm. Those come off by hand -- HANDOFF.md lists the');
      console.log('  ones on record.');
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
    if (!ledger.length) { console.log('No Claude Code session transcripts found under ' + path.join(CFG_DIR, 'projects') + '. Run a Claude Code session, then try again -- nothing needs installing for this.'); return; }
    console.log('No transcript found under ' + path.join(CFG_DIR, 'projects') + ' -- showing the ledger alone.\n');
    return ledgerReport();
  }
  let parsed;
  try { parsed = transcript.parseTranscript(file); } catch (e) { console.log('Could not read ' + file + ': ' + e.message); return; }
  /* The report's "Where you read" line compares against the cap the user actually runs, not the default. */
  /* raw: the config as written, so the replay line applies the person's own settings (thresholds, noTrim,
     alwaysCap, per-tool entries) the way the guard would. */
  const { readLimitLines, maxChars, toolMaxChars, raw } = guardCfg();
  console.log(transcript.renderReport(parsed, ledger, { top, readLimitLines, maxChars, toolMaxChars, userCfg: raw }));
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

  /* One tool call can produce two rows. A guard installed at BOTH user and project scope fires twice for the
     same event -- Claude Code adds hooks across scopes rather than choosing one -- and every count here would
     then read double on the repository where the two overlap. `--caps` already dedupes and `--reach` collapses
     duplicates through a Map keyed by tool_use_id; this was the one place the doubling still showed. Rows
     carrying a tool_use_id dedupe on it; the older rows that predate that field keep their previous
     behaviour, since inventing a key for them would merge genuinely distinct results. */
  const seenPost = new Set();
  const posts = recs.filter(r => {
    if (r.ev !== 'post') return false;
    if (!r.id) return true;
    const k = String(r.session || '') + '|' + r.id;
    if (seenPost.has(k)) return false;
    seenPost.add(k);
    return true;
  });
  const dupPosts = recs.filter(r => r.ev === 'post').length - posts.length;
  const total = posts.reduce((s, r) => s + (r.chars || 0), 0);
  const saved = posts.reduce((s, r) => s + (r.kept != null ? r.chars - r.kept : 0), 0);
  const trimmed = posts.filter(r => r.kept != null).length;
  /* The two Read-cap halves are different features on one hook and they are decided by different config:
     readMaxBytes/readLimitLines cap a large source file, persistedLimitLines caps a read of an output Claude
     Code had already spilled to disk. A single count told the owner nothing about which default it was
     evidence for. --caps lists the files. */
  const caps = transcript.readCapFiles(recs, null);

  console.log(`Tool results: ${fmt(posts.length)}   raw size: ${fmt(total)} chars ~ ${fmt(tok(total))} tokens`
    + (dupPosts ? `   (${fmt(dupPosts)} duplicate row(s) dropped: the guard is installed at both user and project scope here, so each event is logged twice)` : ''));
  console.log(`Trimmed by tokenbrake: ${trimmed} shell outputs, ${fmt(saved)} chars ~ ${fmt(tok(saved))} tokens kept out of context`);
  console.log(caps.n
    ? `Read caps fired: ${caps.n} -- ${caps.source.n} on a large source file (readLimitLines), `
      + `${caps.excerpt.n} on a shell cat of one (same knobs, capped after the fact), `
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

/* Named config profiles (feature 7). Applying one merges its keys into ~/.claude/tokenbrake.json, so a
   custom key the profile does not name survives. `balanced` is the guard's own DEFAULTS, spelled out.
   The guard reads config on every call, so a preset takes effect on the next tool call -- no restart. */
const PRESETS = {
  off:        { enabled: false },
  minimal:    { enabled: true, maxChars: 12000, readMaxBytes: 120000, readLimitLines: 500, persistedLimitLines: 120, shapeFilters: false },
  balanced:   { enabled: true, maxChars: 6000,  readMaxBytes: 60000,  readLimitLines: 300, persistedLimitLines: 80,  shapeFilters: false },
  aggressive: { enabled: true, maxChars: 3000,  readMaxBytes: 30000,  readLimitLines: 150, persistedLimitLines: 60,  shapeFilters: true }
};

function preset() {
  const cfgPath = path.join(CFG_DIR, 'tokenbrake.json');
  const name = args[1];
  if (!name || name === 'list') {
    console.log('presets (npx tokenbrake preset <name>):');
    for (const [n, keys] of Object.entries(PRESETS)) console.log(`  ${n.padEnd(11)} ${JSON.stringify(keys)}`);
    const cur = readJson(cfgPath, null);
    console.log(`\ncurrent config: ${cur ? JSON.stringify(cur) : 'defaults (no ' + cfgPath + ')'}`);
    if (!name) { console.log('\nUsage: npx tokenbrake preset <off|minimal|balanced|aggressive>'); }
    return;
  }
  const keys = PRESETS[name];
  if (!keys) { console.log(`unknown preset "${name}". Known: ${Object.keys(PRESETS).join(', ')}`); process.exitCode = 1; return; }
  const next = { ...readJson(cfgPath, {}), ...keys, preset: name };
  writeJson(cfgPath, next);
  console.log(`preset "${name}" applied to ${cfgPath}`);
  console.log(`  ${JSON.stringify(next)}`);
  console.log('Takes effect on the next tool call -- the guard reads config each call, no restart needed.');
}

/* Retrieval (feature 3). The guard writes every result it trims to <config>/tokenbrake/out/<id>.txt and
   names the path in the trimmed result. These two make that first-class: `outputs` lists them, `show <id>`
   prints one whole -- so the full text is one command away when the trimmed view is not enough. */
function outputs() {
  const outDir = path.join(TB_DIR, 'out');
  let files;
  try { files = fs.readdirSync(outDir).filter(f => f.endsWith('.txt')); } catch { files = []; }
  if (!files.length) { console.log(`No saved outputs in ${outDir}. The guard writes one when it trims a large result.`); return; }
  const rows = files.map(f => {
    let st; try { st = fs.statSync(path.join(outDir, f)); } catch { st = null; }
    return { id: f.replace(/\.txt$/, ''), bytes: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
  }).sort((a, b) => b.mtime - a.mtime);
  console.log(`Saved full outputs in ${outDir} (newest first):`);
  for (const r of rows) console.log(`  ${r.id.padEnd(22)} ${fmt(r.bytes).padStart(10)} chars  ${new Date(r.mtime).toISOString().replace('T', ' ').slice(0, 19)}`);
  console.log('\nPrint one with: npx tokenbrake show <id>   (id is the first column; a prefix works)');
  console.log('Delete old ones with: npx tokenbrake clean --days=7');
}

function showOutput() {
  const arg = args[1];
  if (!arg) { console.log('Usage: npx tokenbrake show <id>   (npx tokenbrake outputs lists them)'); process.exitCode = 1; return; }
  const emitFile = (p) => { try { process.stdout.write(fs.readFileSync(p, 'utf8')); return true; } catch (e) { console.log(`Could not read ${p}: ${e.message}`); process.exitCode = 1; return false; } };
  if (arg.includes('/') || arg.includes(path.sep)) { emitFile(arg); return; }
  const outDir = path.join(TB_DIR, 'out');
  let files;
  try { files = fs.readdirSync(outDir).filter(f => f.endsWith('.txt')); } catch { files = []; }
  const stem = arg.replace(/\.txt$/, '');
  let matches = files.filter(f => f.replace(/\.txt$/, '') === stem);
  if (!matches.length) matches = files.filter(f => f.startsWith(stem));
  if (!matches.length) matches = files.filter(f => f.includes(stem));
  if (!matches.length) { console.log(`No saved output matches "${arg}". npx tokenbrake outputs lists what is there.`); process.exitCode = 1; return; }
  if (matches.length > 1) {
    console.log(`"${arg}" matches ${matches.length} outputs -- narrow it:`);
    for (const m of matches) console.log('  ' + m.replace(/\.txt$/, ''));
    process.exitCode = 1; return;
  }
  emitFile(path.join(outDir, matches[0]));
}

/* Doctor (feature 4): the same checks `status` prints, re-cast as a prioritized problem list with a remedy
   for each, and an exit code (non-zero when an ERROR remains) so it can gate CI. `--fix` performs the one
   safe, well-defined repair -- re-copying a stale guard -- and reports everything else for the human. */
function doctor() {
  const FIX = flag('--fix');
  const problems = [];
  const settings = readJson(settingsPath, {});
  const ours = (ev) => (settings.hooks && settings.hooks[ev] || []).filter(isOurs);
  const has = (ev) => ours(ev).length > 0;
  const EVENTS = HOOK_EVENTS;

  console.log(`tokenbrake doctor (${PROJECT ? 'project' : 'user'} scope)`);
  console.log(`  settings: ${settingsPath}`);

  const missing = EVENTS.filter(ev => !has(ev));
  if (missing.length === EVENTS.length) problems.push({ sev: 'error', msg: 'no tokenbrake hooks installed', fix: 'run: node cli.js init' + (PROJECT ? ' --project' : '') });
  else if (missing.length) problems.push({ sev: 'warn', msg: `missing hook group(s): ${missing.join(', ')}${missing.includes('PostToolUseFailure') ? ' -- failing commands enter whole' : ''}`, fix: `re-run init${PROJECT ? ' --project' : ''}` });

  const srcSha = guardSha(path.join(__dirname, 'guard.js'));
  const copySha = guardSha(guardFile);
  if (!copySha) problems.push({ sev: has('PostToolUse') ? 'error' : 'warn', msg: `guard file missing (${guardFile})`, fix: `re-run init${PROJECT ? ' --project' : ''}` });
  else if (srcSha && srcSha !== copySha) {
    if (FIX) {
      try { fs.mkdirSync(guardDir, { recursive: true }); fs.copyFileSync(path.join(__dirname, 'guard.js'), guardFile);
        problems.push({ sev: 'warn', msg: 'installed guard was STALE', fixed: `re-copied guard.js -> ${guardFile}` }); }
      catch (e) { problems.push({ sev: 'error', msg: `installed guard is STALE and --fix could not re-copy it: ${e.message}`, fix: `check permissions on ${guardDir}` }); }
    } else problems.push({ sev: 'error', msg: `installed guard is STALE (${copySha.slice(0, 12)} vs source ${srcSha.slice(0, 12)}); the ledger records an older guard than this checkout`, fix: `node cli.js doctor --fix, or node cli.js init${PROJECT ? ' --project' : ''}` });
  }

  const cfgPath = path.join(CFG_DIR, 'tokenbrake.json');
  if (fs.existsSync(cfgPath)) {
    try { const c = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      if (c.enabled === false) {
        problems.push({ sev: 'warn', msg: 'guard is disabled in config (enabled:false): it returns immediately and records nothing', fix: 'node cli.js preset balanced, or set enabled:true' });
        const reEnabled = c.tools && typeof c.tools === 'object' ? Object.keys(c.tools).filter(t => c.tools[t] && c.tools[t].enabled === true) : [];
        if (reEnabled.length) problems.push({ sev: 'warn', msg: `tools.{${reEnabled.join(', ')}}.enabled:true cannot re-enable a globally disabled guard -- the base enabled:false returns before per-tool config applies`, fix: 'set the base enabled:true and disable the tools you do not want instead' });
      }
    } catch { problems.push({ sev: 'error', msg: `${cfgPath} is not valid JSON; the guard silently falls back to defaults`, fix: 'fix the JSON or delete the file' }); }
  }

  for (const ev of EVENTS) for (const g of ours(ev)) for (const h of g.hooks) {
    if (!isOurs({ hooks: [h] })) continue;
    const v = selfTest(h);
    if (!/^ok/.test(v)) problems.push({ sev: 'error', msg: `${ev} hook spawn (${h.command}): ${v}`, fix: 'check the node path; re-run init with --node=<path-to-node>' });
  }

  const otherPath = PROJECT ? path.join(CFG_DIR, 'settings.json') : path.join(process.cwd(), '.claude', 'settings.json');
  const other = readJson(otherPath, null);
  const otherHas = !!(other && other.hooks && EVENTS.some(ev => (other.hooks[ev] || []).some(isOurs)));
  if (otherHas && EVENTS.some(has)) problems.push({ sev: 'warn', msg: `also installed at ${PROJECT ? 'user' : 'project'} scope (${otherPath}): the guard runs twice per call and the ledger double-counts`, fix: 'uninstall one scope' });

  const fixed = problems.filter(p => p.fixed);
  const errors = problems.filter(p => p.sev === 'error' && !p.fixed);
  const warns = problems.filter(p => p.sev === 'warn' && !p.fixed);
  for (const p of fixed) console.log(`  FIXED  ${p.msg} -- ${p.fixed}`);
  for (const p of errors) console.log(`  ERROR  ${p.msg}\n         fix: ${p.fix}`);
  for (const p of warns) console.log(`  WARN   ${p.msg}\n         fix: ${p.fix}`);
  if (!errors.length && !warns.length) console.log(`  all checks passed${fixed.length ? ' (after --fix)' : ''}`);
  else if (!FIX && errors.some(p => /STALE/.test(p.msg))) console.log('\n  Re-run with --fix to repair a stale guard automatically.');
  process.exitCode = errors.length ? 1 : 0;
}

/* Pick the session transcript(s) a report runs on, for --backfire.
   --transcript=<path> and --all take precedence over --session=<prefix>; with none, the last session the
   ledger saw (whose transcript still exists), else the newest transcript on disk. Returns { ledger, found,
   files } or null after printing the reason -- a caller returns on null. */
function pickSessions() {
  const opt = (name) => { const a = args.find(x => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null; };
  const ledger = loadLedger();
  const found = transcript.findTranscripts(CFG_DIR);
  let files = [];
  const tpath = opt('--transcript');
  const want = opt('--session');
  if (tpath) files = [tpath];
  else if (flag('--all')) files = found.map(f => f.file);
  else if (want) {
    const hit = found.find(f => String(f.session).startsWith(want));
    if (!hit) { console.log('No transcript whose session id starts with ' + want + '. tokenbrake report --all lists them.'); process.exitCode = 1; return null; }
    files = [hit.file];
  } else {
    const lastRow = [...ledger].reverse().find(r => r && r.transcript && fs.existsSync(r.transcript));
    files = lastRow ? [lastRow.transcript] : (found[0] ? [found[0].file] : []);
  }
  if (!files.length) { console.log('No transcript found under ' + path.join(CFG_DIR, 'projects') + '.'); return null; }
  return { ledger, found, files };
}

/* The Backfire Auditor (roadmap Step 0): the gate a narrowing has to pass before its default can move. For
   the picked session(s) it counts what the guard withheld (trims, MCP, dedup), how much of that the model
   then pulled back the two ways the guard itself created (its saved out/ file, or `tokenbrake show`), and
   the NET -- token-reads saved minus token-reads carried back in. Tokens only: this is a measurement gate,
   and ab10's lesson is that the count of trims does not predict the saving, so it reads the net. --all
   pools, --session=<prefix>/--transcript=<path> pick one. */
function auditReport() {
  const picked = pickSessions();
  if (!picked) return;
  const { ledger, files } = picked;

  let W = 0, saved = 0, savedCarried = 0, recTokens = 0, recCarried = 0, backfired = 0, sessions = 0;
  let unmatchedEvents = 0, unmatchedCarried = 0;
  const byKind = {}; let capsFired = 0, induced = 0, deltasFired = 0, deltasBackfired = 0, reReadsFired = 0, reReadsBackfired = 0;
  for (const file of files) {
    let p; try { p = transcript.parseTranscript(file); } catch { continue; }
    sessions++;
    const a = transcript.backfireAudit(p, ledger);
    W += a.withholds.length; saved += a.saved; savedCarried += a.savedCarried;
    recTokens += a.recoveredTokens; recCarried += a.recoveredCarried;
    unmatchedEvents += a.unmatchedEvents; unmatchedCarried += a.unmatchedCarried;
    backfired += a.backfired; capsFired += a.caps.fired; induced += a.caps.induced;
    deltasFired += a.deltas.fired; deltasBackfired += a.deltas.backfired;
    reReadsFired += a.reReads.fired; reReadsBackfired += a.reReads.backfired;
    for (const k of Object.keys(a.byKind)) byKind[k] = (byKind[k] || 0) + a.byKind[k];
  }
  const narrowingLines = () => {
    if (deltasFired) console.log('  Read-After-Edit deltas: ' + deltasFired + ' fired; '
      + deltasBackfired + ' sent the model back for a wider read of the file (a delta that hid what it wanted)');
    if (reReadsFired) console.log('  Re-read elisions: ' + reReadsFired + ' fired; '
      + reReadsBackfired + ' sent the model back to read the file again (it did not still have it)');
  };
  /* A read of a saved output this audit could not tie to a withhold it counted -- an earlier session's out/
     file, or a capped/over-ceiling output that carries no marker. Real token-reads, but not this session's
     saving coming back, so it is reported apart from the net rather than silently docking it. */
  const alsoBack = () => { if (unmatchedEvents) console.log('  Also pulled back (not tied to a withhold here): '
    + unmatchedEvents + ' saved-output read(s) -- ~ ' + fmt(unmatchedCarried)
    + ' token-reads, from an earlier session or a capped/over-ceiling output'); };

  console.log('Backfire audit -- ' + sessions + ' session(s)');
  if (!W) {
    console.log('  No withholds in these session(s) -- nothing to audit (the guard trimmed nothing that carried its marker here).');
    alsoBack();
    if (capsFired) console.log('  Read caps fired: ' + capsFired + (induced ? ', ' + induced + ' later ranged read(s) followed a cap on the same file' : ''));
    narrowingLines();
    console.log('\n  A withhold is a trim, MCP trim or dedup the model saw. Turn a narrowing on and run a session, then this says whether it paid off.');
    return;
  }
  const kinds = Object.entries(byKind).map(([k, n]) => n + ' ' + k).join(', ');
  console.log('  Withholds: ' + W + ' (' + kinds + ') -- ~ ' + fmt(saved) + ' tokens kept out, ~ ' + fmt(savedCarried) + ' token-reads not carried');
  const rate = Math.round(100 * backfired / W);
  if (backfired) {
    console.log('  Pulled back: ' + backfired + ' of ' + W + ' withheld outputs were read back (a saved out/ file, or `show`) -- backfire rate ' + rate + '%');
    console.log('    ~ ' + fmt(recTokens) + ' tokens re-entered, ~ ' + fmt(recCarried) + ' token-reads carried back in');
  } else {
    console.log('  Pulled back: none of the ' + W + ' withholds was read back -- backfire rate 0%');
  }
  alsoBack();
  const net = savedCarried - recCarried;
  console.log('  Net: ~ ' + fmt(net) + ' token-reads ' + (net < 0 ? 'LOST' : 'saved') + ' after backfires   (' + fmt(savedCarried) + ' saved - ' + fmt(recCarried) + ' pulled back)');
  const verdict = transcript.backfireVerdict(W, net, backfired);
  const say = { nothing: 'nothing to audit', 'too few': 'too few withholds to call it (need a few)',
    backfired: 'BACKFIRED -- the pull-backs cost more than the trims saved', 'net positive': 'net positive despite backfires',
    'break-even': 'break-even -- the pull-backs cost exactly what the trims saved',
    clean: 'clean -- no withheld output was read back' }[verdict] || verdict;
  console.log('  Verdict: ' + say);
  if (capsFired) console.log('  Read caps (softer signal, reported apart): ' + capsFired + ' fired; ' + induced
    + ' later ranged read(s) followed a cap on the same file -- a bounded re-read is partly what the cap asks for');
  narrowingLines();
  console.log('\n  A withhold backfires when the model retrieves what was withheld -- the two ways the guard creates it: reading the'
    + '\n  saved out/ file, or `tokenbrake show`. This is the gate for turning a narrowing on: a narrowing whose net is'
    + '\n  negative is spending tokens, not saving them. Token-reads only.');
}

/* The Personalized Auto-Tuner (`tokenbrake tune`). Pools your recent real sessions -- the same population and
   skips as report --reads/--where -- and, for each off-by-default feature, prints its MEASURED record where it
   has fired (from the backfire audit) or a labelled OPPORTUNITY estimate where it has not, then a per-feature
   recommendation and the exact knob to set. Recommends only: it never writes tokenbrake.json (that changes what
   the guard withholds next session, so it stays the person's explicit act -- the recommendation names the knob
   to paste). The recommendation engine is transcript.autotune, kept pure and tested; this only pools and prints. */
function tuneReport() {
  const opt = (name) => { const a = args.find(x => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null; };
  const only = opt('--cwd');
  const want = opt('--session');
  const ledger = loadLedger();
  const found = transcript.findTranscripts(CFG_DIR);
  if (!found.length) { console.log('No transcripts found under ' + path.join(CFG_DIR, 'projects') + '.'); return; }

  const plainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  const rawRead = readJson(path.join(CFG_DIR, 'tokenbrake.json'), {});
  const rawCfg = plainObj(rawRead) ? rawRead : {};
  const cfg = { ...transcript.TUNE_DEFAULTS, ...rawCfg };
  /* A knob written `false` is a decision; a knob that is absent is just a default. The merged cfg above cannot
     tell them apart (TUNE_DEFAULTS sets every feature knob false), so the distinction is taken from the raw
     file here and handed to autotune. Only knob names are ever looked up in it, so collecting every false key
     is harmless. */
  const disabled = Object.keys(rawCfg).filter((k) => rawCfg[k] === false);

  const parsed = [], skipped = [];
  for (const f of found) {
    const id = String(f.session).slice(0, 8);
    if (want && !String(f.session).startsWith(want)) continue;
    let p;
    try { p = transcript.parseTranscript(f.file); } catch { skipped.push([id, 'unreadable']); continue; }
    const cwd = p.cwd || '';
    if (only) { if (!cwd.toLowerCase().includes(only.toLowerCase())) { skipped.push([id, 'cwd does not contain "' + only + '"']); continue; } }
    else if (/tokenbrake-bench/i.test(cwd)) { skipped.push([id, 'benchmark session -- staged fixtures, not your work; --cwd to include']); continue; }
    if (!p.results.length) { skipped.push([id, 'no tool results']); continue; }
    parsed.push(p);   // autotune backfills a missing p.sessionId from the transcript filename itself
  }
  if (!parsed.length) { console.log('No usable session(s) to tune from' + (want ? ' for --session=' + want : '') + (only ? ' under --cwd=' + only : '') + '.'); return; }

  /* --sweep: the offline replay of the stateful features at several values of each knob -- a view of its own, data
     only, so tune's own output does not grow. Tokens only. */
  if (flag('--sweep')) {
    const sw = transcript.sweepOffline(parsed, ledger, cfg);
    const narrowed = [only ? '--cwd=' + only : null, want ? '--session=' + want : null].filter(Boolean).join(' ');
    console.log('Knob sweep -- the stateful off-by-default features replayed over ' + parsed.length + ' session(s) with the guard\'s own decisions'
      + (narrowed ? '  (' + narrowed + ')' : ''));
    console.log('  One knob at a time, every other setting as configured. Tokens kept out and carried token-reads; whether the model');
    console.log('  would have come back for them is not measured. Sessions where a feature ran live are left out (its record is measured).');
    for (const s of sw) {
      const on = transcript.isOnIn(rawCfg, s.feature);
      console.log('\n  ' + s.feature + ' -- ' + s.knob + (on ? '   (on in your config: the replay covers only sessions it did not run in)' : ''));
      if (s.scoped.length) console.log('    your tools entries set it too (' + s.scoped.map((x) => x.tool + ': ' + x.value).join(', ') + ') -- each row applies its value there as well');
      if (s.raw != null && typeof s.raw !== 'number') console.log('    your value (' + JSON.stringify(s.raw) + ') is not a number, so no row is marked as yours');
      console.log('    ' + 'value'.padStart(8) + 'acts on'.padStart(10) + 'tokens kept out'.padStart(18) + 'carried'.padStart(14) + 'sessions'.padStart(11));
      for (const r of s.rows) console.log('    ' + fmt(r.value).padStart(8) + String(r.n).padStart(10) + ('~ ' + fmt(r.withheld)).padStart(18)
        + ('~ ' + fmt(r.carried)).padStart(14) + String(r.replayed).padStart(11) + (r.value === s.current ? '   <- yours' : ''));
    }
    if (skipped.length) console.log('\n  ' + skipped.length + ' session(s) skipped.');
    if (flag('--write')) console.log('  --write is ignored with --sweep: the sweep only shows data.');
    return;
  }
  const t = transcript.autotune(parsed, ledger, cfg, { disabled });

  /* `--write`: apply the recommendation to tokenbrake.json. This is the one part of the tuner that changes what
     the guard withholds next session, so it only ever turns a feature ON, and only on a clean MEASURED record
     (a 'turn-on') -- never on an estimate. It does NOT auto-disable: a measured backfire is surfaced as
     'reconsider' for the person to turn off deliberately, because the audit's net is pooled, not per-feature, so
     --write cannot tell a feature that backfired once but is strongly net-positive from one that is net-negative
     -- and reverting a net-positive feature would cost tokens. 'try'/'measure' are opportunity estimates, left
     for the person to enable and measure. Knob names come from the fixed feature list (never transcript
     content), values are booleans, and every other key is preserved (merge, not replace) -- the `preset`
     contract. The plain `tokenbrake tune` is the preview; this is the deliberate apply. */
  if (flag('--write')) {
    const cfgPath = path.join(CFG_DIR, 'tokenbrake.json');
    /* --write changes ONE global tokenbrake.json, so when the evidence behind it was narrowed by --cwd or
       --session the header has to say so -- the preview render carries the filter and the apply must not
       drop it. `tune --cwd=oneproject --write` otherwise reads as a verdict on everything. */
    const narrowed = [only ? '--cwd=' + only : null, want ? '--session=' + want : null].filter(Boolean).join(' ');
    console.log('Auto-tune --write -- ' + t.sessions + ' session(s), ' + t.guarded + ' with the guard'
      + (narrowed ? '  (evidence narrowed to ' + narrowed + '; the config it writes is global)' : ''));
    /* One pass over the turn-ons, splitting on the `offer` policy autotune already decided. Two of the three
       outcomes are left alone and say why: a tool-scoped knob because the only key --write knows how to set is
       the top-level one, which would turn it on for every other tool too; and a knob set to false because the
       clean record that earned its turn-on is from the firings before it was turned off. */
    const plan = [], excluded = { scoped: [], 'user-off': [] };
    for (const f of t.features.filter((f) => f.offer)) {
      if (f.offer === 'turn-on') plan.push(f); else excluded[f.offer].push(f);
    }
    for (const f of excluded.scoped) console.log('  Left alone: "' + f.knob + '" is set per-tool under "tools" -- --write only sets the top-level key, which would turn it on for every other tool too. Edit the tools entry yourself.');
    for (const f of excluded['user-off']) console.log('  Left alone: "' + f.knob + '" is set to false in your config. Its clean record is from before you turned it off, and --write does not re-enable what you turned off -- delete the line, or set it true, to take it back.');
    const review = t.features.filter((f) => f.status === 'review');
    const reviewNote = review.length ? ' It does not auto-disable: ' + review.map((f) => f.knob).join(', ')
      + ' measurably backfired -- turn ' + (review.length > 1 ? 'those' : 'it') + ' off by hand if you want (`tokenbrake tune` shows the backfire).' : '';
    if (!plan.length) {
      /* "Nothing qualified" and "everything that qualified was excluded" are different situations, and the
         advice for the first is wrong for the second -- it read as "no feature has a clean record" directly
         under "Left alone: ... ITS CLEAN RECORD is from before you turned it off". */
      if (excluded.scoped.length || excluded['user-off'].length) {
        console.log('  Nothing left to write: every feature with a clean measured record is one of the above.' + reviewNote);
      } else {
        console.log('  No feature has a clean MEASURED record to turn on. --write acts only on measured evidence, never an');
        console.log('  estimate -- enable a "try"/"measure" feature yourself for a session first (`tokenbrake tune`), then re-run.' + reviewNote);
      }
      return;
    }
    /* Read the RAW file (not the defaults-merged cfg) as the merge base, so a default is never baked in. A
       MISSING file starts fresh; a MALFORMED file is NOT overwritten -- readJson would swallow the parse error
       and hand back {}, and writing that would wipe every real setting the merge exists to preserve. Abort and
       let the person fix it instead. */
    /* One refusal, whichever way the file is unusable: name what is wrong and change nothing. */
    const refuse = (why) => console.log('  ' + cfgPath + ' ' + why + ' -- fix or remove it before --write, so its other settings are not lost. Nothing written.');
    /* Read and parse are separated so the refusal names the real cause: catching both together reported
       EACCES (a root-owned or locked config) and EISDIR as "is not valid JSON", which is false and sends the
       person to edit a file that is perfectly well-formed. */
    let raw, current;
    try { raw = fs.readFileSync(cfgPath, 'utf8'); }
    catch (e) {
      if (e && e.code === 'ENOENT') raw = null;
      else { refuse('could not be read (' + ((e && e.code) || 'unknown error') + ')'); return; }
    }
    if (raw === null) current = {};
    else {
      try { current = JSON.parse(raw); }
      catch { refuse('is not valid JSON'); return; }
    }
    /* Parsing is not enough. `null`, `[]`, `"x"` and `5` are all VALID JSON, and spreading any of them into
       the merge base below yields {} (or index keys, for a string) -- so the write would replace the file
       with nothing but the flipped knobs. That is the same wipe the abort above exists to prevent, reached
       through a different door. The guard treats such a file as inert (loadConfig spreads it over DEFAULTS
       and gets DEFAULTS back, silently); here the identical shape is destructive, so it refuses instead. */
    if (!current || typeof current !== 'object' || Array.isArray(current)) { refuse('is not a JSON object'); return; }
    /* Every plan feature is off (decide() returns 'turn-on' only when the feature is off), so each is a real
       false -> true flip -- there is no "already matches" case (a matching feature is 'keep' and never here). */
    const next = { ...current };
    for (const f of plan) next[f.knob] = true;
    /* The read and parse above refuse cleanly; the write itself can still fail (a root-owned or read-only
       config, a full disk). writeJson writes a temp file and renames it into place, so a failure leaves the
       existing config untouched -- catch it here to name the cause and stop, rather than end on an unhandled
       stack trace that reads like a tokenbrake bug. */
    try { writeJson(cfgPath, next); }
    catch (e) {
      console.log('  ' + cfgPath + ' could not be written (' + ((e && e.code) || 'unknown error') + ') -- your existing config was left unchanged. Check its permissions and free space, then re-run --write.');
      return;
    }
    console.log('  Turned ON ' + plan.length + ' feature(s) in ' + cfgPath + ' (every other key preserved):');
    for (const f of plan) {
      const m = f.measured;   // always present with fired > 0: decide() gives 'turn-on' only to a measured feature
      const ev = m.savedCarried == null ? m.fired + ' fired, ' + m.backfired + ' sent the model back' : m.fired + ' fired, ' + m.backfired + ' pulled back';
      console.log('    "' + f.knob + '": false -> true   (measured clean: ' + ev + ')');
    }
    if (review.length) console.log(' ' + reviewNote);
    console.log('  Revert any line by editing ' + cfgPath + '. Re-run `tokenbrake tune` after more sessions to re-check. Tokens only.');
    return;
  }

  /* Both filters, not just --cwd: `tune --session=abc` narrowed the pool to one session and said nothing,
     which is the disclosure --write's comment claims the preview already carries. */
  const narrowedBy = [only ? '--cwd=' + only : null, want ? '--session=' + want : null].filter(Boolean).join(' ');
  console.log('Auto-tune -- ' + t.sessions + ' session(s) pooled, ' + t.guarded + ' with the guard, ' + skipped.length + ' skipped'
    + (narrowedBy ? '  (' + narrowedBy + ')' : ''));
  if (t.thin) console.log('  Few guarded sessions -- a weak base; treat these as provisional and run more sessions to firm them up.');
  /* Only claim nothing has fired when nothing has. The read narrowings fire without producing a withhold the
     backfire audit can net (see autotune), so they get their own line rather than being counted as silence. */
  if (!t.withholds && !t.narrowings) console.log('  Nothing withheld yet in these sessions (no context-narrowing feature has fired here).');
  else if (!t.withholds) console.log('  ' + t.narrowings + ' read narrowing(s) fired here. They narrow a read rather than replace a saved output, so the backfire audit cannot price them -- see the per-feature lines below for how often they sent the model back.');
  else if (t.netCarried >= 0) console.log('  Net so far: ~ ' + fmt(t.netCarried) + ' token-reads saved across the features already on, after any pull-backs (backfire audit).');
  else console.log('  Net so far: ~ ' + fmt(-t.netCarried) + ' token-reads LOST across the features already on -- pull-backs cost more than was saved. See tokenbrake report --backfire.');

  const mark = { 'turn-on': '[ON] ', 'keep': '[on] ', 'try': '[try]', 'review': '[!!] ', 'measure': '[ ? ]', 'leave-off': '[ - ]', 'idle': '[ 0 ]' };
  const evidence = (f) => {
    const m = f.measured, isRead = m && m.savedCarried == null;
    if (m && m.fired > 0) {
      const back = isRead
        ? m.backfired + ' sent the model back'
        : m.backfired + ' pulled back' + (m.savedCarried ? ', ~ ' + fmt(m.savedCarried) + ' token-reads saved' : '');
      return 'fired ' + m.fired + 'x, ' + back
        + (f.status === 'try' ? '  -- clean, but too few firings to be sure; run a few more sessions' : '')
        + (f.status === 'review' ? '  -- it backfired; reconsider leaving it on' : '');
    }
    /* The opportunity estimators measure the OFF state -- they count results the feature would have acted on
       had it been running. For a feature that is already ON, "would act on N result(s)" asserts the guard
       would have touched output it demonstrably did not touch, which is the one kind of claim this tuner is
       built not to make. An on-but-silent feature gets the plain fact instead. */
    if (f.on) return 'on, but has not fired in these sessions -- nothing here matched it yet';
    const o = f.opportunity;
    if (f.bound === 'offline') {
      if (!o.shadowSessions) return 'off; it ran live in every session here, so its measured record above is the evidence';
      const cov = f.key === 'readAfterEdit' && t.editsNoPatch ? ' (' + t.editsNoPatch + ' of ' + t.editsTotal + ' edits carried no line ranges and could not be replayed)' : '';
      return o.n
        ? 'off; replayed on ' + o.shadowSessions + ' session(s) of your transcripts with the guard\'s own decision, it would have acted on ' + o.n
          + ' result(s), withholding ~ ' + fmt(o.withheld) + ' tokens (~ ' + fmt(o.carried) + ' carried token-reads)' + cov + '. Whether the model would have come back for it is not measured'
        : 'off; replayed on ' + o.shadowSessions + ' session(s) of your transcripts with the guard\'s own decision, it would have acted on nothing' + cov;
    }
    if (!o || !o.n) return 'not fired, and no off-state signal seen here -- turn it on for a session to measure (a feature\'s wins can be invisible until it runs)';
    /* Shadow rows are the guard's own test on the real output, so the withhold side is exact. What they cannot
       say is whether the model would have come back for it: it saw the output as delivered. */
    if (f.bound === 'shadow' || f.bound === 'mixed') {
      const grew = (o.grew ? '; on ' + o.grew + ' more it would have ADDED tokens (its output larger than what entered), which counts against it' : '')
        + (o.hostSwapped ? '; ' + o.hostSwapped + ' more were results Claude Code had already swapped for a short preview and saved to a file -- not priced here (their cost is the later re-read of that file, which the read cap governs)' : '');
      const sh = o.shadowN
        ? 'its shadow saw it would have acted on ' + o.shadowN + ' result(s) in ' + o.shadowSessions + ' session(s), withholding ~ ' + fmt(o.withheld) + ' tokens (exact, from the guard\'s own test)'
        : 'its shadow ran in ' + o.shadowSessions + ' session(s) and saw nothing it would act on';
      const est = o.estimateN ? '; in the sessions it did not run in, estimated ' + (o.estimateBound === 'upper' ? 'up to ' : '~ ') + o.estimateN + ' more' : '';
      return 'off; ' + sh + grew + est + (o.carried ? ' -- ~ ' + fmt(o.carried) + ' carried token-reads in all' : '')
        + (o.n ? '. Whether the model would have come back for it is not measured' : '');
    }
    const bound = f.bound === 'upper' ? 'up to ' : '~ ';   // upper-bound estimators say "up to"; the under-counting ones "~"
    const what = f.key === 'gitView' ? ' large git diff/show result(s) (gitView acts only on those touching a lockfile/minified path)'
      : f.key === 'blobElide' ? ' blob-like shell result(s)'
      : f.key === 'mcpTrim' ? ' MCP result(s) over maxChars'
      : ' result(s)';
    return 'not fired; would act on ' + bound + o.n + what + (o.carried ? ' (~ ' + fmt(o.carried) + ' carried token-reads)' : '');
  };
  console.log('\n  Off-by-default features:');
  if (!t.shadowOn) console.log('    (shadow is off in your config, so blobElide, gitView and mcpTrim are estimated from the off state rather than measured -- "shadow": true measures them for free)');
  for (const f of t.features) {
    /* `note` (from feat()) is the status-independent config classification: `scoped` (a `tools` entry pins the
       knob off) and `user-off` (top-level false) are the two ways it is off BY CONFIG, `running` is on via a
       `tools` entry (never [off]). `offer` is not used here -- being null off a turn-on, it let a config-off
       knob at 'try'/'measure' fall through to "Set <knob>: true", recommending exactly the flip --write
       refuses. But the config note replaces "Set true" only where the status WOULD offer the turn-on
       (turn-on/try/measure). At `review`/`leave-off` the measured verdict speaks, so "delete the line or set it
       true to take it back" is not dangled beside a knob that measurably backfired, and the mark stays the
       verdict's rather than a flat [off]. */
    const configOff = f.note === 'scoped' || f.note === 'user-off';
    const offerable = f.status === 'turn-on' || f.status === 'try' || f.status === 'measure';
    const set = f.note === 'running' ? '   (top-level "' + f.knob + '" is not on, but a "tools" entry turns it on -- it is running where that entry applies)'
      : (configOff && offerable) ? (f.note === 'scoped'
          ? '   ("' + f.knob + '" is set per-tool under "tools" -- edit that entry, not the top-level key)'
          : '   ("' + f.knob + '": false in your config -- delete the line or set it true to take it back)')
      : (f.status === 'turn-on' || f.status === 'try') ? '   Set "' + f.knob + '": true'
      : f.status === 'measure' ? '   Set "' + f.knob + '": true to measure it'
      : f.status === 'idle' ? '   (nothing on your work for it to do -- leave it off)'
      : f.status === 'review' ? '   ("' + f.knob + '": false to turn it back off)' : '';
    /* [off] only where the feature is off by config AND the status would otherwise offer to turn it on, so the
       mark and the set-line agree. `running` is on, and a config-off knob at review/leave-off keeps its verdict
       mark ([!!] / [ - ]) -- its measured record still speaks -- so neither is flattened to [off]. */
    const offerMark = (configOff && offerable) ? '[off]' : (mark[f.status] || '     ');
    console.log('    ' + offerMark + ' ' + f.label + ' (' + f.knob + ')' + set);
    console.log('        ' + evidence(f));
  }

  const rc = t.readCap;
  const capLine = rc.verdict === 'unmeasured' ? (rc.why === 'no-guard'
      ? 'not measured here -- no pooled session ran the guard, so nothing watched the reads. Install it (tokenbrake init) and re-run after a session'
      : 'not measured here -- these sessions ran the guard but their ledger rows are gone, and the ledger is the only thing that records a cap firing. Re-running is what fixes it, not re-installing')
    : rc.verdict === 'firing' ? 'firing -- capped ' + rc.fired + ' read(s) in these sessions'
    : rc.verdict === 'missing' ? 'check -- ' + rc.over + ' read(s) went over readMaxBytes (' + fmt(rc.readMaxBytes) + ' bytes) uncapped in a guarded session. If the guard was installed for the whole session (not added mid-run), the read-pre hook may be missing -- report --reads has the detail'
    : 'dormant -- no read reached readMaxBytes (' + fmt(rc.readMaxBytes) + ' bytes), so the cap had nothing to act on';
  console.log('\n  Read cap (always on): ' + capLine + '.');
  console.log('    For the exact readLimitLines/readMaxBytes values, the evidence is in: tokenbrake report --reads (and --where).');

  /* The two thresholds, as what each value would reach on these sessions. Recommend-only: --write never sets
     them (see thresholdAdvice), so every line here is a suggestion to try, never an applied change. */
  const th = t.thresholds;
  const pc = (x, of) => of ? (Math.round(1000 * x / of) / 10) + '%' : '-';
  console.log('\n  Thresholds, from your own sessions (recommendations only -- --write never changes these):');
  const knob = (name, x, col, unit) => {
    console.log('    ' + name.padEnd(16) + col.padEnd(16) + 'up to withheld, token-reads (share of all carried)');
    for (const g of x.grid) console.log('      ' + fmt(g.value).padStart(10) + String(g.n).padStart(8) + ' ' + unit.padEnd(9)
      + ('~ ' + fmt(g.withheldCarried)).padStart(13) + ('  (' + pc(g.withheldCarried, th.carriedTotal) + ')').padEnd(10)
      + (g.value === x.current ? '  <- yours' : ''));
    const m = x.measured;
    const pulled = m ? m.backfired + ' of ' + x.fired + ' withholds at ' + fmt(x.current) + ' pulled back' : '';
    const why = x.why === 'backfired' ? pulled + '; at ' + fmt(x.to) + ' they would have passed whole, sparing ~ ' + fmt(x.fixed)
        + ' token-reads of pull-back for ~ ' + fmt(x.givenUp) + ' of saving given up'
      : x.why === 'backfired-outweighed' ? pulled + ' (~ ' + fmt(x.pulledCost) + ' token-reads), but no higher value spares more than it gives up in measured saving'
      : x.why === 'few-firings' ? 'fewer than ' + x.min + ' firings at ' + fmt(x.current) + ' -- too little record to step from'
      : x.why === 'missing' ? 'reads went over it uncapped in guarded sessions -- a coverage problem no value fixes (see Read cap above)'
      : x.why === 'clean' ? 'clean at ' + fmt(x.current) + ' (' + x.fired + ' withholds, none pulled back), and one step down takes up to ~ ' + fmt(x.gain) + ' more token-reads'
      : x.why === 'unmeasured' ? 'the cap fired ' + x.fired + 'x at ' + fmt(x.current) + ', and one step down takes up to ~ ' + fmt(x.gain) + ' more token-reads'
      : 'one step down takes too little more to be worth the risk';
    console.log('      ' + (x.advice === 'raise' ? 'Raise to ' + fmt(x.to) + ' -- ' + why + '.'
      : x.advice === 'try' ? 'Try ' + fmt(x.to) + ' for a few sessions -- ' + why + '. Then re-run tune: the step has no record of its own.'
      : 'Keep ' + fmt(x.current) + ' -- ' + why + '.'));
  };
  knob('maxChars', th.maxChars, 'reaches', 'results');
  console.log('      (maxChars is also the trim\'s budget: a lower value cuts harder into what it already trims.)');
  knob('readMaxBytes', th.readMaxBytes, 'catches', 'reads');
  console.log('      (A Read cap\'s pull-back cannot be measured from transcripts; report --reads has the per-limit proxy.)');

  if (t.reach && t.guarded) {
    const W = Math.round(1000 * (t.reach.windowShareOfCarried || 0)) / 10;
    console.log('\n  Trim reach: ~ ' + W + '% of carried tokens sit where the trim can act (over the ' + t.guarded + ' guarded session(s)). report --reach breaks it down.');
  }

  const s = t.summary;
  const parts = [];
  if (s.turnOn.length) parts.push('Turn on: ' + s.turnOn.join(', '));
  if (s.tryThese.length) parts.push('Try: ' + s.tryThese.join(', '));
  if (s.review.length) parts.push('Reconsider: ' + s.review.join(', '));
  if (s.measure.length) parts.push('Measure (no off-state signal): ' + s.measure.join(', '));
  if (s.idle.length) parts.push('Nothing to act on (its shadow saw none): ' + s.idle.join(', '));
  if (s.leaveOff.length) parts.push('Leave off (backfired): ' + s.leaveOff.join(', '));
  /* A feature with a clean measured record that --write will not set still belongs in the summary: before it
     had its own bucket it appeared under "Turn on:", which was wrong, and routing it out of there without a
     consumer here made it disappear from the one line people act on -- also wrong, and quieter. */
  if (s.excluded.length) parts.push('Would turn on, but your config says otherwise: ' + s.excluded.join(', '));
  console.log('\n  ' + (parts.length ? parts.join('.  ') + '.' : 'Nothing to change on this evidence.'));
  if (skipped.length) { console.log('\n  Skipped:'); for (const [id, why] of skipped.slice(0, 12)) console.log('    ' + id + '...  ' + why); if (skipped.length > 12) console.log('    (+ ' + (skipped.length - 12) + ' more)'); }
  console.log('\n  A "turn on" is a MEASURED, clean record. A "try" is an ESTIMATE from what the model read -- built to under-count,');
  console.log('  so turn the feature on and run `tokenbrake report --backfire` to confirm before trusting it. "Measure" means the');
  console.log('  off state shows no signal either way (some wins are invisible until the feature runs); only a measured backfire is');
  console.log('  a real "leave off". Recommendations only: nothing here changes your config -- set the named knob in ' + path.join(CFG_DIR, 'tokenbrake.json') + ' yourself. Tokens only.');
}

function help() {
  console.log(`tokenbrake -- find out what ate your Claude Code context, then brake it if there is anything to brake

STEP ONE -- the report. Nothing to install; it reads the transcripts Claude Code already keeps.

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
      --reach                         of everything that entered context, the share of CARRIED tokens sitting
                                      where the trim can act at all, and which tools put it there. The
                                      question of whether the guard needs poor tooling to have anything to do
      --reads                         every file you read WHOLE, at its own size with Claude Code's line
                                      numbering subtracted: how many reads a lower readMaxBytes would catch,
                                      how much of each a limit would then withhold, and how deep the targets
                                      sit as a share of the file. The evidence for readMaxBytes
      --backfire                      the Backfire Auditor: what the guard withheld, how much the model then
                                      pulled back (its saved out/ file, or 'show'), and the NET token-reads
                                      saved. The gate a narrowing passes before its default moves. Tokens only
      --compactions [--since=<date>]  every compaction, priced: what the drop in context saves until the next
                                      one, and what re-reading files afterwards cost. The measurement for an
                                      earlier autoCompactWindow (AB-TASK.md, stage 2)
      --compare <A> <B>               two sessions side by side: cost, requests, cache reads, what entered
                                      and was carried, what the guard trimmed -- the AB-TASK.md table

STEP TWO -- the brake, if your report says there is something in its reach.

  npx tokenbrake init [--project] [--node=<path>]
                                      install hooks (user scope, or this project's .claude/);
                                      --node pins the executable the hook spawns (default: this node,
                                      or plain 'node' for --project so the file stays shareable)
  npx tokenbrake uninstall [--project]
  npx tokenbrake status               shows what is installed and spawns each hook once, as Claude Code would
  npx tokenbrake doctor [--project] [--fix]
                                      a health check as a prioritized problem list, each with a remedy;
                                      exits non-zero when an ERROR remains. --fix re-copies a stale guard
  npx tokenbrake preset <name>        apply a named config profile: off | minimal | balanced | aggressive
                                      (merged into ~/.claude/tokenbrake.json); preset list shows them
  npx tokenbrake outputs              list the full outputs the guard saved when it trimmed a result
  npx tokenbrake show <id>            print one saved full output whole (id from 'outputs'; a prefix works)
  npx tokenbrake tune                 read your recent sessions and recommend which off-by-default features to
      [--cwd=<text>]                  turn on: each feature's real record where it has fired (fired / pulled
      [--session=<prefix>]            back / saved, from the backfire audit) or a labelled opportunity estimate
                                      where it has not, plus the Read cap's health and a per-person grid and
                                      advice for maxChars and readMaxBytes (recommend-only). Prints the exact
                                      knob to set. Benchmark sessions skipped
      --sweep                         the stateful features (dedup, reReadElide, readAfterEdit) replayed over your
                                      transcripts at several values of each knob, your own marked. Data only
      --write                         turn ON the features with a clean MEASURED record (estimates, and features
                                      that backfired, are left for you to decide). Merges into tokenbrake.json,
                                      never replaces; aborts rather than overwrite a malformed config
  npx tokenbrake clean [--days=7]     delete saved full outputs older than N days`);
}

const cmds = { init, uninstall, status, doctor, report, tune: tuneReport, preset, show: showOutput, outputs, ls: outputs, clean, help };
(cmds[cmd] || help)();
