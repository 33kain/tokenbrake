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
/* `--where`: pool every session's ranged reads into one distribution, and say what a cap at each candidate
   would have withheld. This is the only evidence that can set readLimitLines for a given person, and it
   has to be pooled -- a single session is a handful of reads.

   The workload filter is the point, not a nicety. Run over four of this repo's own benchmark sessions the
   per-session line read 48% of targets past line 300, against 24% on an ordinary working session -- because
   the benchmark's fixtures are BUILT with the evidence past line 300. Pooling those with real work would
   set a default from a synthetic task's design. Benchmark sessions are therefore skipped by default, every
   skip is printed with its reason, and --cwd=<substring> restricts the pool explicitly when that is wanted. */
function whereReport() {
  const opt = (name) => { const a = args.find(x => x.startsWith(name + '=')); return a ? a.slice(name.length + 1) : null; };
  const only = opt('--cwd');
  const CAPS = [100, 200, 300, 500, 800];
  let configured = 300;
  try { const c = JSON.parse(fs.readFileSync(path.join(CFG_DIR, 'tokenbrake.json'), 'utf8')); if (c.readLimitLines) configured = c.readLimitLines; } catch {}
  const found = transcript.findTranscripts(CFG_DIR);
  if (!found.length) { console.log('No transcripts found under ' + path.join(CFG_DIR, 'projects') + '.'); return; }
  const pooled = []; const skipped = []; let starts = [];
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
    const t = transcript.readTargets(p, CAPS);
    if (!t.n) { skipped.push([id, 'no ranged reads']); continue; }
    pooled.push([id, t.n, cwd]);
    starts = starts.concat(t.starts);
  }
  console.log('Where you read -- ' + pooled.length + ' session(s) pooled, ' + skipped.length + ' skipped'
    + (only ? '  (--cwd=' + only + ')' : ''));
  if (!starts.length) {
    console.log('\n  No ranged reads in any pooled session. Nothing here can set readLimitLines.');
  } else {
    const all = transcript.readTargets({ results: starts.map((n) => ({ readFrom: n })) }, CAPS);
    console.log('\n  ' + all.n + ' targeted reads -- median start line ' + all.median
      + ', 90th percentile ' + all.p90 + ', deepest ' + all.max);
    console.log('\n  A Read cap keeping the first ... would have hidden what the model went for:');
    for (const n of CAPS) {
      const k = all.past[n];
      console.log('    ' + String(n).padStart(4) + ' lines -> ' + String(k).padStart(4) + '  ('
        + String(Math.round(100 * k / all.n)).padStart(3) + '%)' + (n === configured ? '   <- your current readLimitLines' : ''));
    }
    if (!CAPS.includes(configured)) console.log('    (your readLimitLines is ' + configured + ', which is not on this scale)');
  }
  console.log('\n  Pooled:  ' + (pooled.map(([id, n]) => id + ' (' + n + ')').join('  ') || 'none'));
  for (const [id, why] of skipped) console.log('  Skipped: ' + id + '  ' + why);
  console.log('\n  A ranged read -- a Read with an offset, or a sed -n range -- is the model saying where it expects');
  console.log('  to find something. These were already bounded, so the guard never capped them: they say where to');
  console.log('  look, not what the cap did.');
}

function report() {
  if (flag('--ledger')) return ledgerReport();
  if (flag('--where')) return whereReport();
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
  const readCaps = recs.filter(r => r.ev === 'read-cap').length;

  console.log(`Tool results: ${fmt(posts.length)}   raw size: ${fmt(total)} chars ~ ${fmt(tok(total))} tokens`);
  console.log(`Trimmed by tokenbrake: ${trimmed} shell outputs, ${fmt(saved)} chars ~ ${fmt(tok(saved))} tokens kept out of context`);
  console.log(`Large reads capped: ${readCaps}\n`);

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
                                      readLimitLines. Benchmark sessions are skipped; --cwd=<text> restricts
      --compare <A> <B>               two sessions side by side: cost, requests, cache reads, what entered
                                      and was carried, what the guard trimmed -- the AB-TASK.md table
  npx tokenbrake clean [--days=7]     delete saved full outputs older than N days`);
}

({ init, uninstall, status, report, clean, help })[cmd] ? ({ init, uninstall, status, report, clean, help })[cmd]() : help();
