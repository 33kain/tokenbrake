/* tokenbrake tests — no Claude Code, no network.
   Run from the tokenbrake/ directory:  node test.mjs

   Spawns guard.js and cli.js as real child processes against a throwaway
   CLAUDE_CONFIG_DIR, feeding them the same stdin shapes Claude Code 2.1.261 was
   observed to send. Written after the first live run: the shipped guard emitted
   a string where Claude Code's per-tool schema wanted the Bash response object,
   the rejection was logged only at debug level, and every transcript stayed
   full-size while `status` said "installed". Nothing in a sandbox could see
   that; this file pins the shape so it cannot regress unnoticed. */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fails = [];
const t = (name, cond, extra = '') => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!cond) fails.push(name);
};

const CFG = mkdtempSync(join(tmpdir(), 'tokenbrake-test-'));
const PROJ = join(CFG, 'proj');
mkdirSync(PROJ, { recursive: true });
const env = { ...process.env, CLAUDE_CONFIG_DIR: CFG };

const guard = (mode, input) => spawnSync(process.execPath, ['./guard.js', mode], {
  input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env
});
const cli = (args, cwd = PROJ) => spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), ...args], { encoding: 'utf8', env, cwd });
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/* The Bash response shape as Claude Code sends it (five keys; the fifth was not in
   the docs and was learned from the raw stdin). Preserving all of it is the point. */
const bashResp = (stdout, stderr = '') => ({ stdout, stderr, interrupted: false, isImage: false, noOutputExpected: false });
const noisy = Array.from({ length: 400 }, (_, i) => {
  const n = i + 1;
  if (n === 150) return 'ERROR: seeded failure alpha at line 150';
  if (n === 220) return 'warning: seeded warning beta at line 220';
  if (n === 301) return 'Exception: seeded gamma at line 301';
  return `line ${n} filler text to make the output long enough to trip the guard`;
}).join('\n');

{
  console.log('\n-- PostToolUse: oversized Bash output');
  const r = guard('post', { session_id: 'sess-1', tool_use_id: 'toolu_01TESTTESTTEST', tool_name: 'Bash',
    tool_input: { command: 'cat noisy.txt' }, tool_response: bashResp(noisy) });
  t('exits 0', r.status === 0, `status=${r.status}`);
  const out = parse(r.stdout);
  const u = out && out.hookSpecificOutput && out.hookSpecificOutput.updatedToolOutput;
  t('emits hookSpecificOutput.updatedToolOutput with hookEventName', !!u && out.hookSpecificOutput.hookEventName === 'PostToolUse');
  /* The regression. Claude Code validates updatedToolOutput against the tool's own
     response schema; for Bash that is an object, and a string is dropped silently. */
  t('updatedToolOutput is an object, not a string', u !== null && typeof u === 'object');
  t('every key of the incoming tool_response survives',
    !!u && ['stdout', 'stderr', 'interrupted', 'isImage', 'noOutputExpected'].every(k => k in u));
  t('trimmed text is in stdout and is much shorter', !!u && u.stdout.length < noisy.length / 3, u && `${noisy.length} -> ${u.stdout.length}`);
  t('stdout carries the tokenbrake marker with the omitted count', !!u && /\[tokenbrake\] 320 lines omitted here/.test(u.stdout));
  t('head and tail are the real first and last lines', !!u && u.stdout.startsWith('line 1 filler') && u.stdout.trimEnd().endsWith('line 400 filler text to make the output long enough to trip the guard'));
  t('all three seeded lines from the omitted middle are kept, numbered',
    !!u && /L150: ERROR: seeded failure alpha/.test(u.stdout) && /L220: warning: seeded warning beta/.test(u.stdout) && /L301: Exception: seeded gamma/.test(u.stdout));
  t('stays under the 10,000-char hook output cap', !!u && JSON.stringify(out).length < 10000);
  const saved = u && (u.stdout.match(/Full output saved to (\S+\.txt)/) || [])[1];
  t('names the saved full-output file and it holds the full text', !!saved && existsSync(saved) && readFileSync(saved, 'utf8') === noisy);
  const ledger = readFileSync(join(CFG, 'tokenbrake', 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const rec = ledger[ledger.length - 1];
  t('ledger row records chars, kept and saved', rec.ev === 'post' && rec.tool === 'Bash' && rec.chars === noisy.length && rec.kept === u.stdout.length && rec.saved === saved);
}

{
  console.log('\n-- PostToolUse: stderr is folded into the trimmed stdout, not lost');
  const r = guard('post', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: bashResp('y\n'.repeat(4000), 'npm ERR! the real problem') });
  const u = parse(r.stdout).hookSpecificOutput.updatedToolOutput;
  t('stderr text appears in stdout', u.stdout.includes('npm ERR! the real problem'));
  t('and stderr itself is blanked so it is not counted twice', u.stderr === '');
}

{
  console.log('\n-- PostToolUse: leaves everything else alone');
  let r = guard('post', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: bashResp('a\nb') });
  t('small Bash output: exit 0, no stdout', r.status === 0 && r.stdout === '');
  r = guard('post', { tool_name: 'Read', tool_input: { file_path: '/x' }, tool_response: { type: 'text', file: { content: 'z'.repeat(50000) } } });
  t('large non-shell result: exit 0, no stdout (only logged)', r.status === 0 && r.stdout === '');
  r = guard('post', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: 'y\n'.repeat(5000) });
  const u = parse(r.stdout).hookSpecificOutput.updatedToolOutput;
  t('a string-typed tool_response still gets a string back', typeof u === 'string' && u.includes('[tokenbrake]'));
  r = guard('post', 'this is not json');
  t('garbage stdin: exit 0, no stdout (fails open)', r.status === 0 && r.stdout === '');
  r = guard('post', '');
  t('empty stdin: exit 0, no stdout', r.status === 0 && r.stdout === '');
}

{
  console.log('\n-- PreToolUse Read cap');
  const big = join(PROJ, 'big.txt');
  writeFileSync(big, Array.from({ length: 12000 }, (_, i) => `bigline ${i + 1}`).join('\n') + '\n');
  let r = guard('read-pre', { tool_name: 'Read', tool_input: { file_path: big } });
  const out = parse(r.stdout);
  const h = out && out.hookSpecificOutput;
  t('unbounded Read of a large file: exit 0 with PreToolUse output', r.status === 0 && !!h && h.hookEventName === 'PreToolUse');
  t('updatedInput keeps file_path and adds limit 300', !!h && h.updatedInput.file_path === big && h.updatedInput.limit === 300);
  t('additionalContext states the real size as a fact', !!h && /12,000 lines/.test(h.additionalContext) && /KB/.test(h.additionalContext));
  r = guard('read-pre', { tool_name: 'Read', tool_input: { file_path: big, limit: 50 } });
  t('bounded Read: no output', r.status === 0 && r.stdout === '');
  r = guard('read-pre', { tool_name: 'Read', tool_input: { file_path: big, offset: 4000 } });
  t('Read with an offset: no output', r.status === 0 && r.stdout === '');
  r = guard('read-pre', { tool_name: 'Read', tool_input: { file_path: join(PROJ, 'nope.txt') } });
  t('missing file: no output (Read reports it)', r.status === 0 && r.stdout === '');
  r = guard('read-pre', { tool_name: 'Read', tool_input: { file_path: big.replace(/\.txt$/, '.pdf') } });
  t('paged formats are skipped by extension', r.status === 0 && r.stdout === '');
}

{
  console.log('\n-- cli: init / status / uninstall');
  writeFileSync(join(CFG, 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo theirs' }] }] } }));
  let r = cli(['init']);
  t('init exits 0', r.status === 0, r.stderr);
  const s = JSON.parse(readFileSync(join(CFG, 'settings.json'), 'utf8'));
  const ours = (ev) => (s.hooks[ev] || []).filter(g => g.hooks.some(h => (h.args || []).some(a => a.includes('tokenbrake'))));
  t('one PostToolUse group with matcher *', ours('PostToolUse').length === 1 && ours('PostToolUse')[0].matcher === '*');
  t('one PreToolUse group with matcher Read', ours('PreToolUse').length === 1 && ours('PreToolUse')[0].matcher === 'Read');
  const post = ours('PostToolUse')[0].hooks[0];
  t('exec form: args present, guard path absolute, mode is the second arg', Array.isArray(post.args) && post.args[0] === join(CFG, 'hooks', 'tokenbrake', 'guard.js') && post.args[1] === 'post');
  /* Exec form spawns the command without a shell, so a bare 'node' depends on the
     PATH Claude Code itself was started with. User scope records this node's path. */
  t('user scope records the absolute path of the installing node', post.command === process.execPath);
  t('guard.js was copied next to settings', existsSync(join(CFG, 'hooks', 'tokenbrake', 'guard.js')));
  t('pre-existing hook group and permissions untouched',
    s.permissions.allow[0] === 'Bash(ls)' && s.hooks.PostToolUse.some(g => g.hooks[0].command === 'echo theirs'));
  r = cli(['init']);
  t('init is idempotent (re-run does not duplicate groups)', JSON.parse(readFileSync(join(CFG, 'settings.json'), 'utf8')).hooks.PostToolUse.length === 2);

  r = cli(['status']);
  t('status exits 0', r.status === 0, r.stderr);
  t('status reports both hooks installed', /PostToolUse guard: installed/.test(r.stdout) && /PreToolUse Read cap: installed/.test(r.stdout));
  /* The spawn test is the check the Windows node-resolution risk needed: it starts
     the recorded command with the recorded args and no shell, as Claude Code will. */
  t('status spawns the PostToolUse hook and sees an object-shaped trim', /PostToolUse spawn test \(.*\): ok \(/.test(r.stdout), r.stdout.split('\n').find(l => /PostToolUse spawn/.test(l)));
  t('status spawns the PreToolUse hook', /PreToolUse spawn test \(.*\): ok/.test(r.stdout));
  const ledgerLines = readFileSync(join(CFG, 'tokenbrake', 'ledger.jsonl'), 'utf8').trim().split('\n').length;
  r = cli(['status']);
  t('status does not write to the ledger', readFileSync(join(CFG, 'tokenbrake', 'ledger.jsonl'), 'utf8').trim().split('\n').length === ledgerLines);

  r = cli(['init', '--node=/definitely/not/a/node']);
  r = cli(['status']);
  t('a command that cannot be spawned is reported as FAILED to start, not as installed-and-fine', /spawn test .*: FAILED to start: ENOENT/.test(r.stdout));

  r = cli(['init', '--project']);
  const ps = JSON.parse(readFileSync(join(PROJ, '.claude', 'settings.json'), 'utf8'));
  const ph = ps.hooks.PostToolUse[0].hooks[0];
  t('--project writes .claude/settings.json with the ${CLAUDE_PROJECT_DIR} placeholder and plain node',
    ph.args[0] === '${CLAUDE_PROJECT_DIR}/.claude/hooks/tokenbrake/guard.js' && ph.command === 'node');
  t('--project copies guard.js under .claude/hooks', existsSync(join(PROJ, '.claude', 'hooks', 'tokenbrake', 'guard.js')));
  r = cli(['status', '--project']);
  t('status --project resolves the placeholder and spawns', /PostToolUse spawn test \(node\): ok \(/.test(r.stdout), r.stdout.split('\n').find(l => /PostToolUse spawn/.test(l)));

  r = cli(['uninstall']);
  const after = JSON.parse(readFileSync(join(CFG, 'settings.json'), 'utf8'));
  t('uninstall removes only our groups', after.hooks.PostToolUse.length === 1 && after.hooks.PostToolUse[0].hooks[0].command === 'echo theirs' && !after.hooks.PreToolUse);
  t('uninstall leaves permissions and the ledger', after.permissions.allow[0] === 'Bash(ls)' && existsSync(join(CFG, 'tokenbrake', 'ledger.jsonl')));
  t('uninstall removes the guard copy', !existsSync(join(CFG, 'hooks', 'tokenbrake', 'guard.js')));
}

{
  console.log('\n-- report');
  /* --ledger since brake 4: plain `report` is the transcript ranking now, and this config dir has no
     transcript, only the guard's own rows. */
  const r = cli(['report', '--ledger', '--all']);
  t('report --ledger exits 0 and shows the trimmed session', r.status === 0 && /Trimmed by tokenbrake: [1-9]/.test(r.stdout) && /cat noisy\.txt/.test(r.stdout));
}

{
  console.log('\n-- brake 4: the transcript report');
  /* A synthetic transcript in the shape Claude Code 2.1.261 writes (see HANDOFF.md, "Transcript facts"):
     four requests, each split over two assistant entries sharing a requestId; three tool results of known
     size; a compaction before the last request; one sidechain line and one unreadable line to be skipped. */
  const tr = await import('./transcript.js');
  const T = tr.default || tr;
  const line = (o) => JSON.stringify(o);
  const usage = (n) => ({ input_tokens: 10 * n, cache_read_input_tokens: 1000 * n, cache_creation_input_tokens: 100 * n, output_tokens: 50 });
  const asst = (rid, n, content) => [line({ type: 'assistant', requestId: rid, uuid: rid + '-a', sessionId: 'sess-abc', cwd: '/w', message: { model: 'm', usage: usage(n), content: content.slice(0, 1) } }),
                                     line({ type: 'assistant', requestId: rid, uuid: rid + '-b', sessionId: 'sess-abc', cwd: '/w', message: { model: 'm', usage: usage(n), content: content.slice(1) } })];
  const result = (id, text) => line({ type: 'user', uuid: id + '-r', sessionId: 'sess-abc', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] }, toolUseResult: {} });
  const lines = [
    ...asst('req1', 1, [{ type: 'text', text: 'hi' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'S=/tmp/x FOO=bar cd /w && npm test' } }]),
    result('tu1', 'x'.repeat(4000)),                                                   // 1,000 tokens, after req 0
    'this line is not json {',
    line({ type: 'user', isSidechain: true, message: { content: [{ type: 'tool_result', tool_use_id: 'nope', content: 'y'.repeat(40000) }] } }),
    ...asst('req2', 2, [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/w/big.txt' } }]),
    result('tu2', [{ type: 'text', text: 'z'.repeat(6000) }, { type: 'image', source: {} }]),   // 1,500 tokens, after req 1
    ...asst('req3', 3, [{ type: 'text', text: 'and' }, { type: 'tool_use', id: 'tu3', name: 'Grep', input: { pattern: 'needle' } }]),
    line({ type: 'user', isCompactSummary: true, message: { content: 'summary of everything so far' } }),
    result('tu3', 'n'.repeat(400)),                                                    // 100 tokens, after req 2 (post-compaction)
    ...asst('req4', 4, [{ type: 'text', text: 'done' }, { type: 'text', text: '.' }])
  ];
  const cfg = mkdtempSync(join(tmpdir(), 'tokenbrake-b4-'));
  mkdirSync(join(cfg, 'projects', '-w'), { recursive: true });
  const file = join(cfg, 'projects', '-w', 'sess-abc.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');

  const p = T.carry(T.parseTranscript(file));
  t('requests are deduped by requestId', p.requests.length === 4, String(p.requests.length));
  t('sidechain and unreadable lines are skipped', p.results.length === 3, String(p.results.length));
  t('the tool name and input come from the tool_use block', p.results[0].name === 'Bash' && p.results[1].name === 'Read' && p.results[2].name === 'Grep');
  t('env assignments and the cd are stripped from the label', p.results[0].what === 'npm test', p.results[0].what);
  t('a string result is measured at chars/4', p.results[0].tokens === 1000);
  t('an array result counts its text blocks only', p.results[1].tokens === 1500);
  t('compaction is recorded at the request it precedes', p.compactions.length === 1 && p.compactions[0] === 3);
  t('a result after request 1 of 4 is carried through requests 2 and 3', p.results[0].carriedTurns === 2 && p.results[0].carried === 2000);
  t('a result after request 2 stops being carried at the compaction', p.results[1].carriedTurns === 1 && p.results[1].carried === 1500);
  t('a result after the compaction is carried by what follows it', p.results[2].carriedTurns === 1 && p.results[2].carried === 100);
  const u = T.usageTotals(p);
  t('usage is summed once per request, not once per entry', u.processed === (10 + 1000 + 100) * (1 + 2 + 3 + 4) && u.requestsWithUsage === 4, String(u.processed));
  t('context now is the last request\'s whole context', u.contextNow === (10 + 1000 + 100) * 4);
  t('cache reads are separated', u.cacheRead === 1000 * 10);

  const ledger = [{ t: 1, ev: 'post', session: 'sess-abc', tool: 'Bash', chars: 4000, kept: 1200, what: 'S=/tmp/x FOO=bar cd /w && npm test', id: 'tu1', transcript: file },
                  { t: 2, ev: 'post', session: 'other', tool: 'Bash', chars: 9000, kept: 1000, what: 'x', id: 'zzz' }];
  const out = T.renderReport(p, ledger, { top: 5 });
  t('the report names the session and the counts', /Session sess-abc/.test(out) && /4 requests, 3 tool results, 1 compaction/.test(out));
  t('it reports processed context and the cache share', /Context processed: 11k tokens across 4 requests \(90% read from cache\)/.test(out), out.split('\n')[2]);
  t('it reports what the context holds now', /Context now: ≈ 4k tokens/.test(out));
  const rank = out.split('\n').filter(l => /^\s+\d/.test(l) && /(Bash|Read|Grep)/.test(l));
  t('the ranking is by carried, not by size', /Bash/.test(rank[0]) && /Read/.test(rank[1]) && /Grep/.test(rank[2]), rank.join(' | '));
  t('a trimmed result is marked from the ledger, joined by tool_use_id', /npm test.*\[trimmed from 1k\]/.test(rank[0]), rank[0]);
  t('the other session\'s ledger row is not counted', /tokenbrake trimmed 1 of them/.test(out));
  t('the savings line carries the trim through the turns it would have been re-read', /≈ 700 tokens kept out, ≈ 2k token-reads not carried/.test(out), out.split('\n').find(l => /kept out/.test(l)));
  t('the advice names the heaviest untrimmed result the guard could act on', /One result to have brakes on: Read "\/w\/big.txt"/.test(out) && /offset\/limit/.test(out));
  t('by-tool shares sum from carried', /Bash\s+1 calls\s+1k entered\s+2k carried\s+56%/.test(out), out.split('\n').find(l => /^  Bash/.test(l)));

  const found = T.findTranscripts(cfg);
  t('findTranscripts sees the session under projects/', found.length === 1 && found[0].session === 'sess-abc');
  t('the one-line summary carries request count, processed and carried', /sess-abc…\s+4 req\s+11k processed\s+4k carried/.test(T.renderSummaryLine(p)), T.renderSummaryLine(p));

  // through the CLI
  const envB4 = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  const run = (a) => spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), 'report', ...a], { encoding: 'utf8', env: envB4 });
  let r = run([]);
  t('cli: report with no ledger picks the newest transcript', r.status === 0 && /Session sess-abc/.test(r.stdout), r.stdout.slice(0, 80));
  r = run(['--all']);
  t('cli: --all lists sessions', /Sessions, newest first \(1\)/.test(r.stdout) && /sess-abc…/.test(r.stdout));
  r = run(['--session=sess-a']);
  t('cli: --session picks by prefix', /Session sess-abc/.test(r.stdout));
  r = run(['--session=nope']);
  t('cli: an unknown session says so', /No transcript whose session id starts with nope/.test(r.stdout));
  r = run(['--transcript=' + file, '--top=2']);
  t('cli: --transcript and --top', /top 2:/.test(r.stdout) && !/Grep/.test(r.stdout.split('What ate it')[1].split('By tool')[0]));
  mkdirSync(join(cfg, 'tokenbrake'), { recursive: true });
  writeFileSync(join(cfg, 'tokenbrake', 'ledger.jsonl'), ledger.map(x => JSON.stringify(x)).join('\n') + '\n');
  r = run([]);
  t('cli: with a ledger, the last row\'s transcript path wins', /Session sess-abc/.test(r.stdout) && /\[trimmed from 1k\]/.test(r.stdout));
  r = run(['--ledger']);
  t('cli: --ledger is the guard\'s own record alone', /Trimmed by tokenbrake/.test(r.stdout) && !/carried/.test(r.stdout));
  rmSync(join(cfg, 'projects'), { recursive: true, force: true });
  r = run([]);
  t('cli: no transcript falls back to the ledger with a note', /showing the ledger alone/.test(r.stdout) && /Trimmed by tokenbrake/.test(r.stdout));
  rmSync(cfg, { recursive: true, force: true });
  r = spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), 'report'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: join(tmpdir(), 'tokenbrake-none-' + Date.now()) } });
  t('cli: nothing at all says what to do', /No transcript and no ledger yet/.test(r.stdout));

  // the guard now records the join keys
  const g = spawnSync(process.execPath, ['./guard.js', 'post'], { input: JSON.stringify({ session_id: 's', tool_use_id: 'toolu_1', transcript_path: '/t/s.jsonl', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a', stderr: '' } }), encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: CFG } });
  const last = readFileSync(join(CFG, 'tokenbrake', 'ledger.jsonl'), 'utf8').trim().split('\n').pop();
  t('the ledger row carries the tool_use_id and the transcript path', g.status === 0 && /"id":"toolu_1"/.test(last) && /"transcript":"\/t\/s.jsonl"/.test(last), last.slice(0, 160));
}

rmSync(CFG, { recursive: true, force: true });
console.log(fails.length ? '\nFAILED: ' + fails.join(', ') : '\nall tokenbrake checks passed');
process.exit(fails.length ? 1 : 0);
