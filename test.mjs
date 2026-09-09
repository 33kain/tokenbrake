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
  t('stdout carries the tokenbrake marker with the omitted count, and the count matches what is shown',
    !!u && (() => { const m = /\[tokenbrake\] (\d+) lines omitted here/.exec(u.stdout); if (!m) return false;
      const shown = u.stdout.split('\n').filter(l => /^line \d+ filler/.test(l)).length; return Number(m[1]) + shown === 400; })(),
    u && (u.stdout.match(/\[tokenbrake\] \d+ lines omitted/) || [''])[0]);
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
  console.log('\n-- PreToolUse Read cap on persisted outputs');
  /* A 40 KB file sits under readMaxBytes and is read whole as a source file. The same 40 KB under
     tool-results/ or tokenbrake/out/ is a saved tool output: it was too big to show inline, so it is
     capped at persistedLimitLines, whatever readMaxBytes says. */
  const body = Array.from({ length: 500 }, (_, i) => `saved output line ${i + 1}`.padEnd(79, '.')).join('\n') + '\n';
  const ccDir = join(CFG, 'projects', '-home-me-repo', 'sess-1', 'tool-results');
  const tbDir = join(CFG, 'tokenbrake', 'out');
  mkdirSync(ccDir, { recursive: true }); mkdirSync(tbDir, { recursive: true });
  const ccFile = join(ccDir, 'abc123.txt'), tbFile = join(tbDir, 'sess-1-x9.txt'), srcFile = join(PROJ, 'source.txt');
  for (const f of [ccFile, tbFile, srcFile]) writeFileSync(f, body);
  let r = guard('read-pre', { tool_name: 'Read', tool_input: { file_path: srcFile } });
  t('a 40 KB source file under readMaxBytes is read whole', r.status === 0 && r.stdout === '');
  r = guard('read-pre', { tool_name: 'Read', tool_input: { file_path: ccFile } });
  let h = parse(r.stdout) && parse(r.stdout).hookSpecificOutput;
  t("the same 40 KB under Claude Code's tool-results/ is capped at persistedLimitLines", !!h && h.updatedInput.limit === 80 && h.updatedInput.file_path === ccFile);
  t('and the note says it is a saved tool output, with the size', !!h && /saved tool output/.test(h.additionalContext) && /500 lines/.test(h.additionalContext) && /80 lines/.test(h.additionalContext));
  r = guard('read-pre', { tool_name: 'Read', tool_input: { file_path: tbFile } });
  h = parse(r.stdout) && parse(r.stdout).hookSpecificOutput;
  t("the same 40 KB under tokenbrake's own out/ is capped the same way", !!h && h.updatedInput.limit === 80);
  r = guard('read-pre', { tool_name: 'Read', tool_input: { file_path: ccFile, offset: 200, limit: 40 } });
  t('a bounded read of a persisted output is untouched', r.status === 0 && r.stdout === '');
  writeFileSync(join(ccDir, 'small.txt'), 'short output\n'.repeat(40));
  r = guard('read-pre', { tool_name: 'Read', tool_input: { file_path: join(ccDir, 'small.txt') } });
  t('a persisted output under maxChars is untouched', r.status === 0 && r.stdout === '');
  const led = readFileSync(join(CFG, 'tokenbrake', 'ledger.jsonl'), 'utf8').trim().split('\n').map(parse).filter(Boolean);
  const cap = led.filter(x => x.ev === 'read-cap' && x.what === ccFile).pop();
  t('the ledger row says the cap fired for a persisted output, with the limit', !!cap && cap.persisted === true && cap.limit === 80);
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

/* ---- brake 1: the carried-context A/B, with a floor ------------------------
   The number brake 1 is sold on, computed instead of read off the usage page.
   AB-TASK.md measures the same quantity for real — one reading per five-hour
   window, by hand — which makes it a proof and not a tool. This runs in a second,
   so a change that quietly stops the guard from paying for itself fails here.

   Both arms are the same session: the same tool calls, in the same order, over the
   same file. They differ only in whether guard.js sat in front of them. Arm A is what
   Claude Code does alone — an unbounded Read of a 48 KB source file landing whole (Read
   has no ceiling of its own: a 65 KB file entered a real session as 60,359 characters;
   the ~30,000-char save-to-a-file ceiling is Bash's), the model re-reading it twice
   more, and a test run whose 400 lines land whole. Arm B sends every one of those
   through the real hooks and carries whatever they actually return. The file sits in the
   25-60 KB band because that is where the Read cap's trigger is argued over
   (AB-TASK.md, "The Read cap's trigger"): the fixture is meant to keep biting there.

   The re-read loop is in the fixture because it was 96% of the untrimmed session's
   carried context in the live run (README, "Compaction and tokenbrake"). Arm B repeats
   the identical unbounded reads rather than the bounded ones the guard's note sends the
   model to, so the guard is credited only with what it mechanically does. The live
   saving is the larger number; this floor sits under the smaller one.

   What is asserted is carried context — size × the requests that re-read it — because
   that, not the size of any single result, is what the five-hour limit counts. */
{
  const tr = await import('./transcript.js');
  const T = tr.default || tr;

  const cfgAB = mkdtempSync(join(tmpdir(), 'tokenbrake-ab-'));
  const envAB = { ...process.env, CLAUDE_CONFIG_DIR: cfgAB };
  const guardAB = (mode, input) => spawnSync(process.execPath, ['./guard.js', mode],
    { input: JSON.stringify(input), encoding: 'utf8', env: envAB });

  const bigLines = Array.from({ length: 600 }, (_, i) => `line ${i + 1} of the source file the model kept re-reading`.padEnd(79, '.'));
  const bigPath = join(cfgAB, 'big.js');
  writeFileSync(bigPath, bigLines.join('\n') + '\n');
  const wholeRead = bigLines.join('\n');                     // 48 KB: over 25,000, under 60,000, and Read returns it whole

  // what the hooks really return for this file and this output — not a hand-written "after"
  // the cap's trigger for this fixture, set here and not inherited from DEFAULTS: whether the shipped
  // default should sit at 25,000 or 60,000 is the live A/B's question, not this test's
  writeFileSync(join(cfgAB, 'tokenbrake.json'), JSON.stringify({ readMaxBytes: 25000 }));
  const pre = parse(guardAB('read-pre', { session_id: 'ab', tool_name: 'Read', tool_input: { file_path: bigPath } }).stdout);
  const capped = pre && pre.hookSpecificOutput && pre.hookSpecificOutput.updatedInput;
  const cappedRead = bigLines.slice(0, (capped && capped.limit) || bigLines.length).join('\n');
  const post = parse(guardAB('post', { session_id: 'ab', tool_use_id: 'tu4', tool_name: 'Bash',
    tool_input: { command: 'npm test' }, tool_response: bashResp(noisy) }).stdout);
  const trimmedShell = post && post.hookSpecificOutput.updatedToolOutput.stdout;

  console.log('\n-- brake 1: carried context, guard off vs guard on');
  t('the fixture exercises both brakes: the Read is capped and the shell output trimmed',
    !!capped && capped.limit === 300 && capped.file_path === bigPath && !!trimmedShell && trimmedShell.length < noisy.length,
    `read ${wholeRead.length}->${cappedRead.length} chars, shell ${noisy.length}->${trimmedShell ? trimmedShell.length : '?'}`);

  /* Six requests: three unbounded reads of the same big file, one test run, then two more
     requests, so every result is carried by what follows it. No compaction — this measures
     what the guard keeps out, not what compaction later relieves. */
  const session = (name, read, shell) => {
    const L = [];
    const call = (i, id, tool, input, text) => {
      L.push(JSON.stringify({ type: 'assistant', requestId: 'r' + i, uuid: 'r' + i, sessionId: 'ab', cwd: '/w',
        message: { model: 'm', content: [{ type: 'tool_use', id, name: tool, input }] } }));
      L.push(JSON.stringify({ type: 'user', uuid: id + '-r', sessionId: 'ab',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }));
    };
    call(0, 'tu1', 'Read', { file_path: bigPath }, read);
    call(1, 'tu2', 'Read', { file_path: bigPath }, read);
    call(2, 'tu3', 'Read', { file_path: bigPath }, read);
    call(3, 'tu4', 'Bash', { command: 'npm test' }, shell);
    for (const rid of ['r4', 'r5']) L.push(JSON.stringify({ type: 'assistant', requestId: rid, uuid: rid,
      sessionId: 'ab', cwd: '/w', message: { model: 'm', content: [{ type: 'text', text: 'working through it' }] } }));
    const f = join(cfgAB, name + '.jsonl');
    writeFileSync(f, L.join('\n') + '\n');
    return T.carry(T.parseTranscript(f));
  };

  const A = session('arm-a', wholeRead, noisy);
  const B = session('arm-b', cappedRead, trimmedShell);
  const carried = (p) => p.results.reduce((s, r) => s + r.carried, 0);
  const cA = carried(A), cB = carried(B);
  const readShare = A.results.filter(r => r.name === 'Read').reduce((s, r) => s + r.carried, 0) / cA;
  const saved = (cA - cB) / cA;

  t('the two arms are the same session: six requests, four results, no compaction',
    A.requests.length === 6 && B.requests.length === 6 && A.results.length === 4 && B.results.length === 4 &&
    A.compactions.length === 0 && B.compactions.length === 0);
  t('the fixture is the re-read loop: the repeated Read is most of what arm A carries',
    readShare > 0.85, `${Math.round(readShare * 100)}%`);
  t('arm A carries every result at full size through every later request',
    cA === Math.round(wholeRead.length / 4) * (5 + 4 + 3) + Math.round(noisy.length / 4) * 2, String(cA));
  t('the guard cuts carried context, and by more than the shell trim alone',
    cB < cA && cA - cB > Math.round(noisy.length / 4) * 2, `${cA} -> ${cB}`);

  /* The floor. This fixture yields 52% today: 300 lines of a 600-line file is a halving
     of the Read, and the order of magnitude in the live run came from the behaviour change
     this fixture deliberately withholds. Pinned under that so retuning headLines or
     readLimitLines has room, and a regression that halves the saving does not. */
  const FLOOR = 0.50;
  t(`carried context falls by at least ${Math.round(FLOOR * 100)}%`,
    saved >= FLOOR, `${(saved * 100).toFixed(1)}%, ${cA} -> ${cB} token-reads`);

  rmSync(cfgAB, { recursive: true, force: true });
}

/* ---- context after flagged lines ------------------------------------------
   A FAIL line alone names the test. The lines after it carry the assertion and the first frame, and a
   model that gets only the name comes back for the rest with a whole extra request. */
{
  console.log('\n-- PostToolUse: context after flagged lines');
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i + 1} filler text to make the output long enough to trip the guard`);
  lines[149] = 'FAIL  src/app.test.js > renders the total';
  lines[150] = 'AssertionError: expected 41 to equal 42';
  lines[151] = '    at Object.<anonymous> (src/app.test.js:88:5)';
  lines[152] = '    at Promise.then.completed (node_modules/jest-circus/build/utils.js:298:28)';
  lines[153] = '    at new Promise (<anonymous>)';              // 4th line after: beyond the default of 3
  lines[219] = 'warning: deprecated call at line 220';
  lines[220] = '';                                             // a blank line ends the window
  lines[221] = 'this line follows the blank and must not be kept';
  lines[300] = 'Exception: seeded gamma at line 301';
  lines[301] = 'Error: the next line is flagged too';           // flagged inside a window: still one block
  const text = lines.join('\n');
  const run = (cfgExtra) => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenbrake-ctx-'));
    if (cfgExtra) writeFileSync(join(dir, 'tokenbrake.json'), JSON.stringify(cfgExtra));
    const r = spawnSync(process.execPath, ['./guard.js', 'post'], { input: JSON.stringify({ session_id: 'ctx', tool_use_id: 'toolu_ctx', tool_name: 'Bash',
      tool_input: { command: 'npm test' }, tool_response: bashResp(text) }), encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
    rmSync(dir, { recursive: true, force: true });
    const o = parse(r.stdout); return o && o.hookSpecificOutput.updatedToolOutput.stdout;
  };
  const out = run(null);
  t('the FAIL line is kept with the assertion and two frames after it',
    /L150: FAIL/.test(out) && /L151: AssertionError: expected 41 to equal 42/.test(out) && /L152: +at Object/.test(out) && /L153: +at Promise/.test(out), (out.match(/L15\d: .*/g) || []).join(' | '));
  t('the fourth line after is not kept at the default of 3', !/L154:/.test(out));
  t('a blank line ends the window', /L220: warning/.test(out) && !/L222:/.test(out) && !/must not be kept/.test(out));
  t('a flagged line inside a window makes one block, not two', /L301: Exception[^\n]*\n  L302: Error/.test(out));
  t('gaps between blocks are shown as one … line', (out.match(/\n  …\n/g) || []).length === 2);
  t('the header says how many lines follow each', /each with up to 3 lines after it/.test(out));
  const zero = run({ errorContextLines: 0 });
  t('errorContextLines 0 keeps the flagged lines alone, as before', /L150: FAIL/.test(zero) && !/L151:/.test(zero) && !/lines after it/.test(zero));
  t('the result stays within maxChars: head and tail yield to the context, not the other way round', out.length <= 6000, `out=${out.length}`);

  /* The real contexa suite: test names mention errors, so "  ok   error render call passes resp through"
     matched ERR, twenty such lines filled the budget, and the two real FAIL lines further down never made
     the cut. A pass marker at the start of a line wins over anything in its name. */
  const suite = Array.from({ length: 400 }, (_, i) => {
    const n = i + 1;
    if (n > 60 && n < 200 && n % 4 === 0) return `  ok   error ${n} render call passes the failure through`;
    if (n === 214) return '  FAIL turn one is pinned through the trim  first=81';
    if (n === 215) return '  expected 1, got 81';
    if (n === 218) return '  FAIL and turn one still survives that trim';
    return `  ok   check ${n} passes`;
  }).join('\n');
  const rr = spawnSync(process.execPath, ['./guard.js', 'post'], { input: JSON.stringify({ session_id: 'ctx2', tool_use_id: 'toolu_ctx2', tool_name: 'Bash',
    tool_input: { command: 'npm test' }, tool_response: bashResp(suite) }), encoding: 'utf8', env });
  const so = parse(rr.stdout).hookSpecificOutput.updatedToolOutput.stdout;
  t('passing lines whose names mention errors are not flagged', !/L\d+:   ok   error/.test(so));
  t('so the real FAIL lines make the cut, with the line after them', /L214:   FAIL turn one/.test(so) && /L215:   expected 1, got 81/.test(so) && /L218:   FAIL and turn one/.test(so));
  t('and that result is within maxChars too', so.length <= 6000, `out=${so.length}`);

  /* The budget. Context that would take more than half of maxChars on its own is dropped and the flagged
     lines stand alone; head and tail then shrink to fit, down to ten lines each. */
  const wide = Array.from({ length: 400 }, (_, i) => {
    const n = i + 1;
    if (n > 60 && n < 340 && n % 6 === 0) return `Error: seeded ${n} ` + 'x'.repeat(150);
    if (n > 60 && n < 340 && n % 6 !== 0) return `frame ${n} ` + 'y'.repeat(150);
    return `line ${n}`;
  }).join('\n');
  const rw = spawnSync(process.execPath, ['./guard.js', 'post'], { input: JSON.stringify({ session_id: 'ctx3', tool_use_id: 'toolu_ctx3', tool_name: 'Bash',
    tool_input: { command: 'npm test' }, tool_response: bashResp(wide) }), encoding: 'utf8', env });
  const wo = parse(rw.stdout).hookSpecificOutput.updatedToolOutput.stdout;
  t('when the context alone would take over half of maxChars, it is dropped and the flagged lines stay',
    !/lines after it/.test(wo) && /L66: Error: seeded 66/.test(wo) && !/L67: frame/.test(wo), `out=${wo.length}`);
  t('head and tail never shrink below ten lines each', /^line 1\n/.test(wo) && /\nline 10\n/.test(wo) && /\nline 391\n/.test(wo) && /\nline 400$/.test(wo));
}

/* ---- the repeat-reads line ------------------------------------------------
   Measured, not acted on. A Read of the same path and range twice in one compaction window is a
   repeat; the same Read after a compaction is not, because the first copy left the context. */
{
  const tr = await import('./transcript.js');
  const T = tr.default || tr;
  const dir = mkdtempSync(join(tmpdir(), 'tokenbrake-rep-'));
  const L = [];
  let n = 0;
  const call = (id, tool, input, text) => {
    n++;
    L.push(JSON.stringify({ type: 'assistant', requestId: 'r' + n, uuid: 'r' + n, sessionId: 'rep', cwd: '/w',
      message: { model: 'm', content: [{ type: 'tool_use', id, name: tool, input }] } }));
    L.push(JSON.stringify({ type: 'user', uuid: id + '-r', sessionId: 'rep',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }));
  };
  const body = 'x'.repeat(4000);
  call('a1', 'Read', { file_path: '/w/big.js' }, body);                       // first read
  call('a2', 'Bash', { command: 'sed -n 10,40p /w/big.js' }, body.slice(0, 400)); // a different range: not a repeat
  call('a3', 'Read', { file_path: '/w/big.js' }, body);                       // repeat, same window
  call('a4', 'Bash', { command: 'cat /w/big.js' }, body);                     // a different shape (cat vs Read): not a repeat
  call('a5', 'Bash', { command: 'cat /w/big.js' }, body);                     // repeat of the cat
  L.push(JSON.stringify({ type: 'user', uuid: 'c1', sessionId: 'rep', isCompactSummary: true, message: { role: 'user', content: 'summary' } }));
  call('a6', 'Read', { file_path: '/w/big.js' }, body);                       // after the compaction: not a repeat
  call('a7', 'Bash', { command: 'npm test' }, body);                          // no key at all
  const f = join(dir, 'rep.jsonl');
  writeFileSync(f, L.join('\n') + '\n');
  const parsed = T.carry(T.parseTranscript(f));
  const rep = T.repeatReads(parsed);
  console.log('\n-- repeat reads');
  t('readKey: a Read, and a single-file cat/sed/head/tail, get a key; other commands do not',
    T.readKey('Read', { file_path: '/a' }) === 'Read /a 0 0' && !!T.readKey('Bash', { command: 'sed -n 1,5p /a' }) && !!T.readKey('Bash', { command: 'cat -n /a' }) && T.readKey('Bash', { command: 'npm test' }) === null && T.readKey('Bash', { command: 'cat a b' }) === null);
  t('six same-shape reads, two repeats: the second Read and the second cat', rep.sameShape === 6 && rep.repeats === 2, JSON.stringify(rep.rows));
  t('a re-read after the compaction is not a repeat', !rep.rows.some(r => r.again >= 6));
  t('the repeat tokens are the two duplicated bodies', rep.tokens === 2 * Math.round(body.length / 4), String(rep.tokens));
  const text = T.renderReport(parsed, []);
  t('the report carries the line', /Repeat reads: 2 of 6 same-shape reads/.test(text), text.split('\n').find(l => /Repeat reads/.test(l)));
  rmSync(dir, { recursive: true, force: true });
}

/* ---- cost at list price, and report --compare -----------------------------
   The formula must reproduce a real session record: arm B of the feature round (Opus 5) billed $2.381214
   for 58 input, 13,902 output, 2,713,808 cache-read and 67,647 cache-write tokens. */
{
  const tr = await import('./transcript.js');
  const T = tr.default || tr;
  const dir = join(CFG, 'projects', '-w-cmp'); mkdirSync(dir, { recursive: true });   // under CFG, so the CLI's --compare can find them by prefix
  const mk = (name, model, usage, results) => {
    const L = [];
    L.push(JSON.stringify({ type: 'assistant', requestId: 'r1', uuid: 'r1', sessionId: name, cwd: '/w',
      message: { model, usage, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }));
    L.push(JSON.stringify({ type: 'user', uuid: 't1r', sessionId: name, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(results) }] } }));
    L.push(JSON.stringify({ type: 'assistant', requestId: 'r2', uuid: 'r2', sessionId: name, cwd: '/w',
      message: { model, usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'done' }] } }));
    const f = join(dir, name + '.jsonl'); writeFileSync(f, L.join('\n') + '\n'); return f;
  };
  const armB = mk('armb0000', 'claude-opus-5', { input_tokens: 58, output_tokens: 13902, cache_read_input_tokens: 2713808, cache_creation_input_tokens: 67647 }, 4000);
  const armA = mk('arma0000', 'claude-opus-5', { input_tokens: 54, output_tokens: 16022, cache_read_input_tokens: 2614181, cache_creation_input_tokens: 74504 }, 8000);
  const odd = mk('oddm0000', 'claude-someday-9', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 }, 10);
  console.log('\n-- cost at list price, and --compare');
  const cB = T.costOf(T.parseTranscript(armB)), cA = T.costOf(T.parseTranscript(armA));
  t('the Opus 5 formula reproduces the session record to the sixth decimal', cB.usd.toFixed(6) === '2.381214' && cA.usd.toFixed(6) === '2.452951', `${cB.usd.toFixed(6)} ${cA.usd.toFixed(6)}`);
  t('the report carries the price line', /At list price: ≈ \$2\.38 \(claude-opus-5; cache writes at the 1h rate\)/.test(T.renderReport(T.parseTranscript(armB), [])));
  t('an unlisted model is reported as unpriced, not guessed', T.costOf(T.parseTranscript(odd)).usd === 0 && T.costOf(T.parseTranscript(odd)).unpriced.join() === 'claude-someday-9');
  const cmp = T.renderCompare(T.parseTranscript(armA), T.parseTranscript(armB), []);
  t('--compare: A and B named, cost row with the change', /A: arma0000…  claude-opus-5/.test(cmp) && /B: armb0000…/.test(cmp) && /API cost, list price\s+\$2\.45\s+\$2\.38\s+−3%/.test(cmp), cmp.split('\n').find(l => /API cost/.test(l)));
  t('--compare: the rows the A/B rounds compared by hand', ['requests', 'cache-read tokens', 'output tokens', 'tool results entered', 'tool results carried', 'trimmed by the guard', 'repeat reads'].every(k => cmp.includes(k)));
  t('--compare: tool results entered halves, and the column says so', /tool results entered\s+2k\s+1k\s+−50%/.test(cmp), cmp.split('\n').find(l => /entered/.test(l)));
  const r = cli(['report', '--compare', 'arma0000', 'armb0000'], PROJ);
  t('cli: report --compare resolves session prefixes', r.status === 0 && /Change is B against A/.test(r.stdout), (r.stdout + r.stderr).slice(0, 200));
  const r2 = cli(['report', '--compare', 'arma0000'], PROJ);
  t('cli: one argument is a usage line, not a crash', r2.status === 0 && /Usage: tokenbrake report --compare/.test(r2.stdout));
  rmSync(dir, { recursive: true, force: true });
}

/* ---- 0.2.0 — the plugin manifest and the marketplace ---------------------- */
{
  const plugin = JSON.parse(readFileSync('./.claude-plugin/plugin.json', 'utf8'));
  const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
  t('plugin: named tokenbrake, same version as the npm package', plugin.name === 'tokenbrake' && plugin.version === pkg.version);
  const hooks = JSON.parse(readFileSync('./hooks/hooks.json', 'utf8')).hooks;
  const post = hooks.PostToolUse && hooks.PostToolUse[0], pre = hooks.PreToolUse && hooks.PreToolUse[0];
  t('plugin: PostToolUse on every tool, PreToolUse on Read only', post && post.matcher === '*' && pre && pre.matcher === 'Read');
  const ok = h => h && h.type === 'command' && h.command === 'node' && Array.isArray(h.args) && h.args[0] === '${CLAUDE_PLUGIN_ROOT}/guard.js';
  t('plugin: both hooks exec-form, node, the guard from the plugin root', ok(post.hooks[0]) && ok(pre.hooks[0]) && post.hooks[0].args[1] === 'post' && pre.hooks[0].args[1] === 'read-pre');
  const market = JSON.parse(readFileSync('./.claude-plugin/marketplace.json', 'utf8'));
  const entry = market.plugins.find(p => p.name === 'tokenbrake');
  t('marketplace: one entry, this repository, same version', market.name === 'tokenbrake' && entry && entry.source && entry.source.repo === '33kain/tokenbrake' && entry.version === pkg.version);
  const cli = spawnSync('claude', ['plugin', 'validate', '.claude-plugin/plugin.json'], { encoding: 'utf8' });
  if (cli.error) console.log('  skip plugin validate: no claude CLI on this machine');
  else t('claude plugin validate accepts the plugin manifest', cli.status === 0, (cli.stdout + cli.stderr).trim().split('\n').pop());
}

/* ---- the repository's own project-scope install ----------------------------
   .claude/settings.json gives every session on this repository brake 1, so the hooks are
   exercised on their own development. The guard there is a copy, refreshed by
   `node cli.js init --project`; this pins it to the source so it cannot drift. */
{
  const own = JSON.parse(readFileSync('./.claude/settings.json', 'utf8'));
  const hook = (ev) => own.hooks[ev][0].hooks[0];
  t('project install: the committed guard is byte-identical to guard.js',
    readFileSync('./.claude/hooks/tokenbrake/guard.js', 'utf8') === readFileSync('./guard.js', 'utf8'));
  t('project install: PostToolUse on every tool, PreToolUse on Read, both through the committed guard',
    own.hooks.PostToolUse[0].matcher === '*' && own.hooks.PreToolUse[0].matcher === 'Read' &&
    hook('PostToolUse').args.join(' ') === '${CLAUDE_PROJECT_DIR}/.claude/hooks/tokenbrake/guard.js post' &&
    hook('PreToolUse').args.join(' ') === '${CLAUDE_PROJECT_DIR}/.claude/hooks/tokenbrake/guard.js read-pre' &&
    hook('PostToolUse').command === 'node' && hook('PreToolUse').command === 'node');
}

rmSync(CFG, { recursive: true, force: true });
console.log(fails.length ? '\nFAILED: ' + fails.join(', ') : '\nall tokenbrake checks passed');
process.exit(fails.length ? 1 : 0);
