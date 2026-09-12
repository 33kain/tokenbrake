/* tokenbrake tests -- no Claude Code, no network.
   Run from the tokenbrake/ directory:  node test.mjs

   Spawns guard.js and cli.js as real child processes against a throwaway
   CLAUDE_CONFIG_DIR, feeding them the same stdin shapes Claude Code 2.1.261 was
   observed to send. Written after the first live run: the shipped guard emitted
   a string where Claude Code's per-tool schema wanted the Bash response object,
   the rejection was logged only at debug level, and every transcript stayed
   full-size while `status` said "installed". Nothing in a sandbox could see
   that; this file pins the shape so it cannot regress unnoticed. */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
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
    tool_input: { command: 'node test.mjs' }, tool_response: bashResp(noisy) });
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
  t('one PostToolUseFailure group on the shells, same guard, same mode', ours('PostToolUseFailure').length === 1 && ours('PostToolUseFailure')[0].matcher === 'Bash|PowerShell' && ours('PostToolUseFailure')[0].hooks[0].args[1] === 'post');
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
  t('status says nothing about a second scope when there is none', !/runs twice per call/.test(r.stdout));
  const pr = cli(['init', '--project']);
  const r2 = cli(['status']);
  t('status warns when user and project scope are both installed', pr.status === 0 && /also installed at project scope .*runs twice per call/.test(r2.stdout), r2.stdout.split('\n').find(l => /twice/.test(l)));
  cli(['uninstall', '--project']);
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

  /* The other scope carrying the guard while this one does not is the ordinary case -- a project install,
     `status` run without --project -- and it runs the guard exactly once. The warning used to fire on the
     other scope alone and say "runs twice per call", which on the first ab7 arm read as a second install
     to hunt down. */
  cli(['uninstall']);
  r = cli(['status']);
  t('project scope alone is reported as running once, not as a double install',
    /installed at project scope instead/.test(r.stdout) && !/runs twice per call/.test(r.stdout),
    r.stdout.split('\n').find(l => /project scope/.test(l)));

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
  t('report --ledger exits 0 and shows the trimmed session', r.status === 0 && /Trimmed by tokenbrake: [1-9]/.test(r.stdout) && /node test\.mjs/.test(r.stdout));
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
    result('tu1', '[tokenbrake] ' + 'x'.repeat(3987)),                                 // 1,000 tokens, after req 0; carries the marker, so the ledger row is credited
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
  t('it reports what the context holds now', /Context now: ~ 4k tokens/.test(out));
  const rank = out.split('\n').filter(l => /^\s+\d/.test(l) && /(Bash|Read|Grep)/.test(l));
  t('the ranking is by carried, not by size', /Bash/.test(rank[0]) && /Read/.test(rank[1]) && /Grep/.test(rank[2]), rank.join(' | '));
  t('a trimmed result is marked from the ledger, joined by tool_use_id', /npm test.*\[trimmed from 1k\]/.test(rank[0]), rank[0]);
  t('the other session\'s ledger row is not counted', /tokenbrake trimmed 1 of them/.test(out));
  t('the savings line carries the trim through the turns it would have been re-read', /~ 700 tokens kept out, ~ 2k token-reads not carried/.test(out), out.split('\n').find(l => /kept out/.test(l)));
  t('the advice names the heaviest untrimmed result the guard could act on', /One result to have brakes on: Read "\/w\/big.txt"/.test(out) && /offset\/limit/.test(out));
  t('by-tool shares sum from carried', /Bash\s+1 calls\s+1k entered\s+2k carried\s+56%/.test(out), out.split('\n').find(l => /^  Bash/.test(l)));

  const found = T.findTranscripts(cfg);
  t('findTranscripts sees the session under projects/', found.length === 1 && found[0].session === 'sess-abc');
  t('the one-line summary carries request count, processed and carried', /sess-abc\.\.\.\s+4 req\s+11k processed\s+4k carried/.test(T.renderSummaryLine(p)), T.renderSummaryLine(p));

  // through the CLI
  const envB4 = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  const run = (a) => spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), 'report', ...a], { encoding: 'utf8', env: envB4 });
  let r = run([]);
  t('cli: report with no ledger picks the newest transcript', r.status === 0 && /Session sess-abc/.test(r.stdout), r.stdout.slice(0, 80));
  r = run(['--all']);
  t('cli: --all lists sessions', /Sessions, newest first \(1\)/.test(r.stdout) && /sess-abc\.\.\./.test(r.stdout));
  r = run(['--session=sess-a']);
  t('cli: --session picks by prefix', /Session sess-abc/.test(r.stdout));
  /* --where pools ranged reads across sessions, and must keep the benchmark's synthetic workload out of
     that pool by default: its fixtures place the evidence past line 300 on purpose, so pooling them with
     real work would set readLimitLines from a fixture design. */
  const T0 = Date.parse('2026-09-12T10:00:00.000Z');
  const mkSession = (dir, name, offsets, cwd, wholes, eofPairs) => {
    mkdirSync(join(cfg, 'projects', dir), { recursive: true });
    const rows = [];
    /* Ranged reads that run off the end of their file: each gives an exact file length, which is what the
       shape comparison needs and what no other fixture here supplies. */
    for (let n = 0; n < (eofPairs || 0); n++) {
      const at = new Date(T0 + 900 + n).toISOString();
      const lines = 300 + 37 * n, start = n % 3 === 0 ? 8 + n : Math.floor(lines * 0.55);
      const got = lines - start + 1;
      rows.push(JSON.stringify({ type: 'assistant', uuid: 'e' + n, requestId: 'e' + n, cwd, timestamp: at,
        message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'tool_use', id: 'te' + n, name: 'Bash',
            input: { command: "sed -n '" + start + "," + (start + got + 50) + "p' /s" + n + ".js" } }] } }));
      rows.push(JSON.stringify({ type: 'user', cwd, timestamp: at,
        message: { content: [{ type: 'tool_result', tool_use_id: 'te' + n, content: Array(got).fill('x').join('\n') }] } }));
    }
    (wholes || []).forEach((w, n) => {
      const at = new Date(T0 + 500 + n).toISOString();
      const lines = Math.ceil(w.bytes / 60);
      const text = Array.from({ length: lines }, (_, i) => (i + 1) + '\t' + 'x'.repeat(58 - String(i + 1).length)).join('\n');
      rows.push(JSON.stringify({ type: 'assistant', uuid: 'w' + n, requestId: 'w' + n, cwd, timestamp: at,
        message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'tool_use', id: 'tw' + n, name: 'Read', input: { file_path: '/big' + n + '.js' } }] } }));
      rows.push(JSON.stringify({ type: 'user', cwd, timestamp: at,
        message: { content: [{ type: 'tool_result', tool_use_id: 'tw' + n, content: text }] } }));
    });
    offsets.forEach((offset, n) => {
      const at = new Date(T0 + n * 1000).toISOString();
      rows.push(JSON.stringify({ type: 'assistant', uuid: 'x' + n, requestId: 'x' + n, cwd, timestamp: at,
        message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'tool_use', id: 't' + n, name: 'Read', input: { file_path: '/x.js', offset, limit: 20 } }] } }));
      rows.push(JSON.stringify({ type: 'user', cwd, timestamp: at,
        message: { content: [{ type: 'tool_result', tool_use_id: 't' + n, content: 'lines' }] } }));
    });
    writeFileSync(join(cfg, 'projects', dir, name + '.jsonl'), rows.join('\n') + '\n');
  };
  mkSession('-c-work-realrepo', 'realsess', [10, 40, 120, 350, 600], 'C:\\work\\realrepo');
  mkSession('-c-desktop-tokenbrake-bench-work-kestrel', 'benchsess', [900, 910, 920, 930, 940, 950], 'C:\\Desktop\\tokenbrake-bench\\work\\kestrel');
  mkdirSync(join(cfg, 'tokenbrake'), { recursive: true });
  const capRow = { t: T0 + 2500, ev: 'read-cap', session: 'realsess', tool: 'Read', what: '/x.js', bytes: 80000, lines: 1900, limit: 300, persisted: false };
  const writeLedger = (extra) => writeFileSync(join(cfg, 'tokenbrake', 'ledger.jsonl'),
    [...ledger, ...extra].map(x => JSON.stringify(x)).join('\n') + '\n');
  writeLedger([]);
  r = run(['--where']);
  /* With no read-cap row anywhere, the split must say it was not attempted rather than report zero induced:
     a machine whose ledger predates the Read cap would otherwise get a clean bill of health for a confound
     nobody looked for. */
  t('cli: --where says the separation was not attempted when no cap ever fired',
    /Guard-induced: not attempted/.test(r.stdout) && /absence of evidence about the confound/.test(r.stdout));
  writeLedger([capRow]);
  r = run(['--where']);
  t('cli: --where skips benchmark sessions by default, and says why',
    /benchses\s+benchmark session/.test(r.stdout) && /realsess \(5\)/.test(r.stdout), r.stdout.split('\n')[0]);
  t('cli: --where pools the real session and not the benchmark', /All ranged reads: 5/.test(r.stdout) && !/benchses \(/.test(r.stdout),
    (r.stdout.match(/All ranged reads:[^\n]*/) || [])[0]);
  t('cli: --where marks the configured cap', /<- your current readLimitLines/.test(r.stdout));
  t('cli: --where counts a target past each cap, not the same number everywhere',
    /300 lines ->\s+2/.test(r.stdout) && /500 lines ->\s+1/.test(r.stdout) && /800 lines ->\s+0/.test(r.stdout),
    r.stdout.split('\n').filter(l => /lines ->/.test(l)).join(' | '));
  /* The confound: /x.js was capped at T0+2.5s, so the reads at offset 350 and 600 -- issued after it -- are
     the cap telling the model to come back with an offset, not the model choosing where to look. The three
     earlier ones are real evidence and stay. */
  t('cli: --where excludes the reads a cap on the same file provoked',
    /Guard-induced and excluded: 2 of 5/.test(r.stdout) && /Spontaneous: 3/.test(r.stdout),
    r.stdout.split('\n').filter(l => /induced|Spontaneous/.test(l)).join(' | '));
  t('cli: --where names the files the exclusions came from', /by file: x\.js \(2\)/.test(r.stdout));
  t('cli: --where no longer claims the cap did not touch what these reads say',
    /cap on an EARLIER unbounded read of the SAME file/.test(r.stdout)
    && !/they say where to look, not what the cap did/.test(r.stdout));
  t('cli: --where prints the histogram and the ledger-free spike line',
    /Start lines, all ranged reads/.test(r.stdout) && /Bunching at a cap/.test(r.stdout)
    && /80 \(your persistedLimitLines\)/.test(r.stdout));
  t('cli: --where says when the clean subset is too thin to decide',
    /Spontaneous: 3[^\n]*too few to set a default/.test(r.stdout),
    (r.stdout.match(/Spontaneous:[^\n]*/) || [])[0]);
  r = run(['--where', '--cwd=kestrel']);
  t('cli: --cwd includes the benchmark deliberately and excludes the rest',
    /benchses \(6\)/.test(r.stdout) && /All ranged reads: 6/.test(r.stdout) && /realsess\s+cwd does not contain/.test(r.stdout),
    r.stdout.split('\n')[0]);
  /* --caps: the ledger view. Pooled across sessions by default, the two knobs counted apart, and the share
     of the file the model received shown per file. */
  r = run(['--caps']);
  t('cli: --caps lists the files the Read cap fired on, with the delivered share',
    /Read caps fired -- 1 across 1 session/.test(r.stdout) && /Source files, Read cap \(readLimitLines\):\s+1 caps/.test(r.stdout)
    && /16%.*\/x\.js/.test(r.stdout), r.stdout.split('\n').filter(l => /x\.js|Source files/.test(l)).join(' | '));
  /* The self-check. A read over readMaxBytes that was never capped is the same evidence for "the cap is inert
     on this workload" and for "the cap is not running on this workload" -- opposite conclusions. The ledger
     tells them apart: no row at all for a session means the guard was not there. */
  mkSession('-c-work-bigrepo', 'bigsess', [], 'C:\\work\\bigrepo', [{ bytes: 90000 }]);
  r = run(['--reads']);
  t('cli: --reads flags a read over the trigger that was never capped',
    /read\(s\) over your readMaxBytes of 60,000 that were NOT capped/.test(r.stdout),
    (r.stdout.match(/[^\n]*NOT capped[^\n]*/) || [])[0]);
  t('cli: --reads says whether the guard was even running there, because that is the whole question',
    /the guard was not running there/.test(r.stdout) && /opposite conclusions/.test(r.stdout));
  rmSync(join(cfg, 'projects', '-c-work-bigrepo'), { recursive: true, force: true });
  /* The shape block needs 20 reads with an EXACT file length before it prints at all, so no CLI fixture ever
     reached it -- and a crash plus wording left over from the withdrawn criterion shipped past a green suite
     into the owner's console. A fixture that reaches it is the test that was missing. */
  mkSession('-c-work-shaperepo', 'shapesess', [], 'C:\\work\\shaperepo', [], 24);
  r = run(['--reads']);
  t('cli: --reads prints the shape comparison once there are enough exact lengths',
    /Which SHAPE of cap serves your reading/.test(r.stdout) && /Safest useful cap of each shape/.test(r.stdout),
    (r.stdout.match(/[^\n]*Which SHAPE[^\n]*/) || [])[0]);
  t('cli: --reads names a winning shape by what it saves at the same safety, not by domination',
    /Verdict: (FRACTIONAL|ABSOLUTE) saves more at the same safety, by \d+ points|Verdict: a TIE|Verdict: NEITHER shape can be/.test(r.stdout),
    (r.stdout.match(/[^\n]*Verdict:[^\n]*/) || [])[0]);
  t('cli: --reads prices the same comparison in tokens, as Step A requires',
    /Priced in tokens instead of in share of lines/.test(r.stdout) && /Verdict on tokens:/.test(r.stdout),
    (r.stdout.match(/[^\n]*Verdict on tokens:[^\n]*/) || [])[0]);
  t('cli: --reads does not crash printing the verdict', r.status === 0 && !/TypeError/.test(r.stderr), r.stderr.slice(0, 120));
  rmSync(join(cfg, 'projects', '-c-work-shaperepo'), { recursive: true, force: true });
  r = run(['--caps', '--cwd=whatever']);
  t('cli: --caps refuses --cwd and says why', /ledger rows carry no cwd/.test(r.stdout));
  /* --reads: the trigger's half of the question. The fixture's reads are line-numbered exactly as Claude Code
     delivers them, so the sizes the grid works from are the files' own and not what the reads cost. */
  r = run(['--reads']);
  t('cli: --reads pools the real session and skips the benchmark',
    /realsess \(/.test(r.stdout) && /benchses\s+benchmark session/.test(r.stdout) && !/benchses \(/.test(r.stdout),
    r.stdout.split('\n')[0]);
  t('cli: --reads says where each size came from, because they are not equally good',
    /Sized from: /.test(r.stdout) && /line numbering \(subtracted\)/.test(r.stdout),
    (r.stdout.match(/Sized from:[^\n]*/) || [])[0]);
  t('cli: --reads prints the trigger grid and marks the configured readMaxBytes',
    /<- your readMaxBytes/.test(r.stdout) && /trigger   reads  bytes/.test(r.stdout));
  t('cli: --reads keeps the miss rate out of the grid and labels it as the other population',
    /DIFFERENT population from the whole-file reads/.test(r.stdout));
  t('cli: --reads reports depth as a share of the file, which is the shape question',
    /How deep the targets sit/.test(r.stdout) && /fraction of file/.test(r.stdout));
  r = run(['--caps', '--session=nope']);
  t('cli: --caps with an unknown session prefix says so', /No session in the ledger starts with "nope"/.test(r.stdout));
  r = run(['--ledger']);
  t('cli: --ledger counts the two Read-cap halves apart',
    /Read caps fired: 1 -- 1 on a large source file \(readLimitLines\), 0 on a shell cat of one/.test(r.stdout)
    && !/Large reads capped/.test(r.stdout), r.stdout.split('\n').filter(l => /Read caps/.test(l)).join(' | '));
  rmSync(join(cfg, 'projects', '-c-work-realrepo'), { recursive: true, force: true });
  rmSync(join(cfg, 'projects', '-c-desktop-tokenbrake-bench-work-kestrel'), { recursive: true, force: true });

  r = run(['--session=nope']);
  t('cli: an unknown session says so', /No transcript whose session id starts with nope/.test(r.stdout));
  r = run(['--transcript=' + file, '--top=2']);
  t('cli: --transcript and --top', /top 2:/.test(r.stdout) && !/Grep/.test(r.stdout.split('What ate it')[1].split('By tool')[0]));
  writeLedger([]);
  r = run([]);
  t('cli: with a ledger, the last row\'s transcript path wins', /Session sess-abc/.test(r.stdout) && /\[trimmed from 1k\]/.test(r.stdout));
  r = run(['--ledger']);
  t('cli: --ledger is the guard\'s own record alone', /Trimmed by tokenbrake/.test(r.stdout) && !/carried/.test(r.stdout));
  /* The report is a console surface, and a Windows console renders the typographic characters it used to
     print as mojibake -- an ellipsis and an arrow arrived as two garbage characters each, on the owner's
     daily output, for as long as the report existed.
     Nothing pinned the conversion, so this does. The guard's own ellipsis inside a trimmed result is exempt:
     that text goes to the model as JSON, not to a terminal. */
  const nonAscii = (out) => out.split('\n').filter(l => !/^[\x20-\x7e]*$/.test(l));
  for (const argv of [[], ['--where'], ['--caps'], ['--reads'], ['--ledger'], ['--all']]) {
    const o = run(argv);
    t('cli: report ' + (argv.join(' ') || '(default)') + ' prints ASCII only', nonAscii(o.stdout).length === 0,
      nonAscii(o.stdout).slice(0, 2).join(' | '));
  }
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
   AB-TASK.md measures the same quantity for real -- one reading per five-hour
   window, by hand -- which makes it a proof and not a tool. This runs in a second,
   so a change that quietly stops the guard from paying for itself fails here.

   Both arms are the same session: the same tool calls, in the same order, over the
   same file. They differ only in whether guard.js sat in front of them. Arm A is what
   Claude Code does alone -- an unbounded Read of a 48 KB source file landing whole (Read
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

   What is asserted is carried context -- size x the requests that re-read it -- because
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

  // what the hooks really return for this file and this output -- not a hand-written "after"
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
     requests, so every result is carried by what follows it. No compaction -- this measures
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

/* ---- a file excerpt is a read ----------------------------------------------
   sed -n / cat / head / tail of one file, no pipe: untouched up to readMaxBytes like a Read, capped to
   readLimitLines above it. The three-arm run had a model chunk every file into 80-line sed ranges after
   one such excerpt was trimmed: 91 requests, twice the bill. */
{
  console.log('\n-- a file excerpt is a read');
  const src = Array.from({ length: 400 }, (_, i) => `  const v${i} = compute(${i}); // a line of source, about sixty characters wide`).join('\n');
  const post = (command, text) => guard('post', { session_id: 'ex', tool_use_id: 'toolu_ex_' + Math.random().toString(36).slice(2, 8), tool_name: 'Bash',
    tool_input: { command }, tool_response: bashResp(text) });
  let r = post("sed -n '1,120p' extension/content.js", src.slice(0, 9000));
  t('a 9k-char sed range of one file passes untouched', r.status === 0 && r.stdout === '', r.stdout.slice(0, 80));
  for (const c of ['cat extension/content.js', 'cat -n build.mjs', 'head -200 worker/src/index.js', 'tail -n 120 worker/test.mjs', "sed -n 1500,2011p extension/content.js", 'sed -n "1,400p" a.js']) {
    r = post(c, src.slice(0, 9000));
    t(`untouched: ${c}`, r.status === 0 && r.stdout === '');
  }
  for (const c of ["sed -n '1,400p' a.js | grep foo", 'cat a.js b.js', 'npm test', 'git log --stat -40', "sed -n '1,400p' a.js; ls"]) {
    r = post(c, src.slice(0, 9000));
    const o = parse(r.stdout); const u = o && o.hookSpecificOutput && o.hookSpecificOutput.updatedToolOutput;
    t(`still trimmed: ${c}`, !!u && /\[tokenbrake\] \d+ lines omitted here/.test(u.stdout), r.stdout.slice(0, 60));
  }
  /* The shapes models actually write, all found trimmed in one measured session (AB-TASK.md, pair 5):
     a `cd ... &&` prefix, an echo label before or after, a quoted path with a space, and a grep of one
     named file. Each is a read the model had already narrowed; each lost the exemption and was cut to
     head, tail and error lines, and the model then went back for what was removed -- four return trips,
     three extra rounds, and the weakest result of the round. */
  for (const c of [
    'cd "C:/Users/Q/Desktop/bench/work/kestrel-payments" && sed -n \'502,535p\' incident/data/events.ndjson && echo "---"',
    "echo '=== settle.js ==='; sed -n '320,345p' settle.js",
    'cat "Settlement Batch 2026-08.csv"',
    'cd "/a b/c" && grep -n "txn_7Q4M9KX2" "incident/exports/Settlement Batch.csv"',
    'head -n 200 build.log && echo done',
    "cd /repo && tail -n 120 worker/test.mjs",
  ]) {
    r = post(c, src.slice(0, 9000));
    t(`untouched (pair 5 shapes): ${c.slice(0, 62)}`, r.status === 0 && r.stdout === '', r.stdout.slice(0, 80));
  }
  /* And the ones that must keep being trimmed: a pipe filters the file rather than printing it, a redirect
     sends it elsewhere, and a recursive grep is a search across files, not one file's contents. */
  for (const c of [
    'node tools/test-runner.js 2>&1 | grep -v "^PASS"',
    'grep -rn "txn_7Q4M9KX2" .',
    'grep -l "txn" src/*.js',
    'cd /a && cat x.js > y.js',
    'cd /a && rm -rf build',
  ]) {
    r = post(c, src.slice(0, 9000));
    const o2 = parse(r.stdout); const u2 = o2 && o2.hookSpecificOutput && o2.hookSpecificOutput.updatedToolOutput;
    t(`still trimmed (pair 5 shapes): ${c.slice(0, 52)}`, !!u2 && /\[tokenbrake\] \d+ lines omitted here/.test(u2.stdout), r.stdout.slice(0, 60));
  }
  /* The report has to recognise exactly what the guard exempts, or it cannot say what the guard did. */
  const { readFileOf } = await import('./transcript.js');
  for (const [c, want] of [
    ['cd "C:/a b/repo" && sed -n \'502,535p\' incident/data/events.ndjson && echo "---"', 'incident/data/events.ndjson'],
    ['cat "Settlement Batch 2026-08.csv"', 'Settlement Batch 2026-08.csv'],
    ['sed -n \'1,50p\' f.js | grep foo', null],
  ]) {
    t(`the report reads the same path the guard does: ${String(want).slice(0, 34)}`, readFileOf('Bash', { command: c }) === want, String(readFileOf('Bash', { command: c })));
  }

  const big = Array.from({ length: 1200 }, (_, i) => `line ${i + 1} of a big file `.padEnd(70, '.')).join('\n');   // 85 KB, over readMaxBytes
  r = post("sed -n '1,1200p' big.js", big);
  let o = parse(r.stdout); let u = o && o.hookSpecificOutput && o.hookSpecificOutput.updatedToolOutput;
  t('an excerpt over readMaxBytes is capped at the first readLimitLines lines, not trimmed to head and tail',
    !!u && u.stdout.startsWith('line 1 of a big file') && u.stdout.split('\n').filter(l => /^line \d+ of/.test(l)).length === 300 && !/lines omitted here/.test(u.stdout));
  t('and the note says so, with the cost of many small ranges', !!u && /file excerpt capped at the first 300 of 1,200 lines/.test(u.stdout) && /A few large ranges cost less/.test(u.stdout));
  r = guard('post', { session_id: 'ex', tool_use_id: 'toolu_ex_fail', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
    tool_input: { command: "sed -n '1,120p' missing.js" }, error: 'Exit code 1\n' + noisy, is_interrupt: false });
  o = parse(r.stdout); u = o && o.hookSpecificOutput && o.hookSpecificOutput.updatedToolOutput;
  t('a failing excerpt command is a failure, trimmed like one', typeof u === 'string' && /lines omitted here/.test(u));
  const led = readFileSync(join(CFG, 'tokenbrake', 'ledger.jsonl'), 'utf8').trim().split('\n').map(parse).filter(Boolean);
  t('the ledger marks excerpts', led.some(x => x.excerpt === true && /sed -n/.test(x.what)));
}

/* ---- PostToolUseFailure: the failing command -------------------------------
   For Bash, PostToolUse fires only on exit 0. A non-zero exit is PostToolUseFailure, whose input carries
   the output in `error` ("Exit code 1", then the text) and no tool_response on Claude Code 2.1.261. Until
   0.2.2 the guard was not registered for it, so every failing test run entered whole: the one output the
   trim exists for. Found by the errorContextLines A/B, where four `npm test` failures of 12k chars each
   sat untrimmed in both arms (AB-TASK.md). */
{
  console.log('\n-- PostToolUseFailure: a failing shell command');
  const err = 'Exit code 1\n' + noisy;
  let r = guard('post', { session_id: 'sess-f', tool_use_id: 'toolu_fail1', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
    tool_input: { command: 'npm test' }, error: err, is_interrupt: false });
  let o = parse(r.stdout); let h = o && o.hookSpecificOutput;
  t('a failing command over maxChars is trimmed under its own event name', r.status === 0 && !!h && h.hookEventName === 'PostToolUseFailure');
  t('the replacement is a string, since the error Claude sees is a string', !!h && typeof h.updatedToolOutput === 'string' && h.updatedToolOutput.length < err.length / 3);
  t('the exit code line survives as the first line', !!h && h.updatedToolOutput.startsWith('Exit code 1\n'));
  t('the seeded error lines from the middle are kept', !!h && /L151: ERROR: seeded failure alpha/.test(h.updatedToolOutput) && /L302: Exception: seeded gamma/.test(h.updatedToolOutput));
  const led = readFileSync(join(CFG, 'tokenbrake', 'ledger.jsonl'), 'utf8').trim().split('\n').map(parse).filter(Boolean);
  const row = led.filter(x => x.id === 'toolu_fail1').pop();
  t('the ledger row says the command failed', !!row && row.failed === true && row.chars === err.length);
  r = guard('post', { session_id: 'sess-f', tool_use_id: 'toolu_fail2', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
    tool_input: { command: 'npm test' }, error: err, is_interrupt: true });
  t('an interrupted call is left alone', r.status === 0 && r.stdout === '');
  r = guard('post', { session_id: 'sess-f', tool_use_id: 'toolu_fail3', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
    tool_input: { command: 'false' }, error: 'Exit code 1', is_interrupt: false });
  t('a short failure passes through untouched', r.status === 0 && r.stdout === '');
  r = guard('post', { session_id: 'sess-f', tool_use_id: 'toolu_fail4', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash',
    tool_input: { command: 'npm test' }, error: 'Command exited with code 1', tool_response: err, is_interrupt: false });
  o = parse(r.stdout); h = o && o.hookSpecificOutput;
  t('when the docs shape arrives instead (short error, output in tool_response), the output is what gets trimmed', !!h && h.updatedToolOutput.startsWith('Exit code 1\n') && /\[tokenbrake\]/.test(h.updatedToolOutput));
}

/* ---- credit only what the model saw ---------------------------------------
   A ledger row means the guard offered a replacement. Above Claude Code's own ceiling the model gets a
   2 KB persisted-output preview instead, and on PostToolUseFailure the replacement is ignored. The first
   Windows run had npm test at 49.4 KB: the hook saw 29,965 chars, kept 5,952, the model saw the preview,
   and the report credited tokenbrake with 6k tokens Claude Code had kept out. */
{
  const tr = await import('./transcript.js');
  const T = tr.default || tr;
  const dir = join(CFG, 'projects', '-w-credit'); mkdirSync(dir, { recursive: true });
  const L = []; let n = 0;
  const call = (id, tool, input, text) => {
    n++;
    L.push(JSON.stringify({ type: 'assistant', requestId: 'r' + n, uuid: 'r' + n, sessionId: 'credit', cwd: '/w',
      message: { model: 'claude-opus-5', content: [{ type: 'tool_use', id, name: tool, input }] } }));
    L.push(JSON.stringify({ type: 'user', uuid: id + '-r', sessionId: 'credit', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }));
  };
  call('c1', 'Bash', { command: 'npm test' }, 'head\n[tokenbrake] 300 lines omitted here (27,000 chars total).\ntail\n' + 'k'.repeat(5000));  // applied
  call('c2', 'Bash', { command: 'npm test' }, '<persisted-output>Output too large (49.4KB). Full output saved to: x.txt</persisted-output>\n' + 'p'.repeat(2000)); // preview instead
  call('c3', 'Bash', { command: 'ls' }, 'a\nb');
  const f = join(dir, 'credit.jsonl');
  writeFileSync(f, L.join('\n') + '\n');
  const parsed = T.carry(T.parseTranscript(f));
  const ledger = [
    { t: 1, ev: 'post', session: 'credit', tool: 'Bash', chars: 27000, kept: 5900, what: 'npm test', id: 'c1', transcript: f },
    { t: 2, ev: 'post', session: 'credit', tool: 'Bash', chars: 29965, kept: 5952, what: 'npm test', id: 'c2', transcript: f },
  ];
  const text = T.renderReport(parsed, ledger);
  console.log('\n-- credit only what the model saw');
  t('a result carrying the marker is credited', /tokenbrake trimmed 1 of them: ~ 5k tokens kept out/.test(text), text.split('\n').find(l => /tokenbrake trimmed/.test(l)));
  t('a result without the marker is reported as offered and not applied, not as savings', /1 trim offered and not applied \(over Claude Code's own ceiling, or a failing command\): ~ 523 tokens entered/.test(text), text.split('\n').find(l => /not applied/.test(l)));
  t('the ranking marks it', /npm test  \[trim not applied\]/.test(text) && /npm test  \[trimmed from 7k\]/.test(text));
}

/* ---- the small-results line -------------------------------------------------
   Shell results under the trim threshold, with their carried cost: the share of a session the guard
   does not touch, so the real-session files can say whether shape filters for small output are worth it. */
{
  const tr = await import('./transcript.js');
  const T = tr.default || tr;
  const dir = join(CFG, 'projects', '-w-small'); mkdirSync(dir, { recursive: true });
  const L = []; let n = 0;
  const call = (id, tool, input, text) => {
    n++;
    L.push(JSON.stringify({ type: 'assistant', requestId: 'r' + n, uuid: 'r' + n, sessionId: 'small', cwd: '/w',
      message: { model: 'claude-opus-5', usage: { input_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id, name: tool, input }] } }));
    L.push(JSON.stringify({ type: 'user', uuid: id + '-r', sessionId: 'small', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] } }));
  };
  call('s1', 'Bash', { command: 'sed -n 1,40p a.js' }, 'x'.repeat(2000));   // small, carried 3
  call('s2', 'Bash', { command: 'npm test' }, 'y'.repeat(9000));            // over the threshold: not counted
  call('s3', 'Read', { file_path: '/w/a.js' }, 'z'.repeat(2000));            // not a shell result
  call('s4', 'Bash', { command: 'git status' }, 'w'.repeat(400));           // small, carried 0
  const f = join(dir, 'small.jsonl');
  writeFileSync(f, L.join('\n') + '\n');
  const parsed = T.carry(T.parseTranscript(f));
  const sm = T.smallResults(parsed);
  console.log('\n-- the small-results line');
  t('counts shell results at or under the threshold only', sm.shell === 3 && sm.n === 2, JSON.stringify(sm));
  t('with their tokens and carried cost', sm.tokens === 500 + 100 && sm.carried === 500 * 3 + 100 * 0, JSON.stringify(sm));
  const text = T.renderReport(parsed, []);
  t('the report carries the line with the share of all carried', /Under the trim threshold: 2 of 3 shell results/.test(text) && /% of all carried\)/.test(text), text.split('\n').find(l => /Under the trim/.test(l)));

  /* The Read cap's firings come from the ledger, not the transcript: a capped Read is an ordinary short
     result with no marker, invisible to the trim line. The two halves are separate features sharing one
     hook -- readMaxBytes on a large source file, persistedLimitLines on an output Claude Code wrote to
     disk -- and their evidence differs, so the report counts them apart. */
  console.log('\n-- the Read-cap line');
  const capLedger = [
    { ev: 'read-cap', session: 'small', tool: 'Read', what: '/w/big.js', bytes: 80000, persisted: false },
    { ev: 'read-cap', session: 'small', tool: 'Read', what: '/w/t/tool-results/a.txt', bytes: 40000, persisted: true },
    { ev: 'read-cap', session: 'other', tool: 'Read', what: '/w/x.js', bytes: 99999, persisted: false },
    { ev: 'post', session: 'small', tool: 'Bash', what: 'npm test', chars: 9000, kept: 500 },
  ];
  const caps = T.readCaps(capLedger, 'small');
  t('counts this session only, split by which half fired', caps.n === 2 && caps.source === 1 && caps.persisted === 1, JSON.stringify(caps));
  t('a post row is not a read cap', caps.bytes === 120000, JSON.stringify(caps));
  const capText = T.renderReport(parsed, capLedger);
  t('the report names both halves', /Read caps fired: 2 \(1 on a large source file, 1 on a persisted output\)/.test(capText), capText.split('\n').find(l => /Read caps/.test(l)));
  t('with no cap rows the line says none rather than going missing', /Read caps fired: none/.test(T.renderReport(parsed, [capLedger[3]])), T.renderReport(parsed, [capLedger[3]]).split('\n').find(l => /Read caps/.test(l)));
}

/* ---- reach: what the guard could ever have acted on ------------------------
   Every other line in the report says what the guard did. None said what it could have done, and the
   difference is the whole honesty of the thing: on one ledger, 285 tool results and the trim applied to
   none -- a session where "it saved nothing" and "it could never have saved anything" are different
   sentences and the second is true. Four ways to be out of reach, and a result the guard actually rewrote
   is in the window by proof rather than by size, since a trimmed result measures under the threshold. */
{
  const tr = await import('./transcript.js');
  const T = tr.default || tr;
  const dir = join(CFG, 'projects', '-w-reach'); mkdirSync(dir, { recursive: true });
  const L = []; let n = 0;
  const call = (id, tool, input, text, isError) => {
    n++;
    L.push(JSON.stringify({ type: 'assistant', requestId: 'q' + n, uuid: 'q' + n, sessionId: 'reach', cwd: '/w',
      message: { model: 'claude-opus-5', usage: { input_tokens: 1, cache_read_input_tokens: 100, cache_creation_input_tokens: 1, output_tokens: 1 }, content: [{ type: 'tool_use', id, name: tool, input }] } }));
    L.push(JSON.stringify({ type: 'user', uuid: id + '-r', sessionId: 'reach',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: !!isError }] } }));
  };
  call('r1', 'Bash', { command: 'npm test' }, '[tokenbrake] x'.padEnd(3000, '.'));   // rewritten: in the window by proof
  call('r2', 'Bash', { command: 'git log --stat -40' }, 'y'.repeat(9000));           // over the threshold, exit 0: the window
  call('r3', 'Bash', { command: 'git status' }, 'z'.repeat(500));                    // under the threshold
  call('r4', 'Read', { file_path: '/w/a.js' }, 'w'.repeat(9000));                    // not a shell result
  call('r5', 'Bash', { command: 'node broken.js' }, 'e'.repeat(9000), true);         // failed: the host ignores the replacement
  call('r6', 'Bash', { command: 'node dump.js' }, 'p'.repeat(40000));                // past the host's ceiling
  const f = join(dir, 'reach.jsonl');
  writeFileSync(f, L.join('\n') + '\n');
  const parsed = T.carry(T.parseTranscript(f));
  const byId = (id) => parsed.results.find(r => r.id === id);
  const rc = T.reach(parsed, [byId('r1')]);

  console.log('\n-- reach: the denominator');
  t('a result the guard rewrote is in the window by proof, not by its delivered size',
    rc.window.n === 2, JSON.stringify({ window: rc.window.n }));
  t('a non-shell result is out of reach whatever its size', rc.nonShell.n === 1, JSON.stringify(rc.nonShell));
  t('a failing shell result is out of reach -- the host ignores the replacement', rc.failed.n === 1, JSON.stringify(rc.failed));
  t('a result past the host ceiling is out of reach -- persisted, never applied', rc.persisted.n === 1, JSON.stringify(rc.persisted));
  t('a shell result under the threshold is out of reach by design', rc.under.n === 1, JSON.stringify(rc.under));
  t('the buckets account for every result exactly once',
    rc.window.n + rc.under.n + rc.failed.n + rc.persisted.n + rc.nonShell.n === rc.total.n && rc.total.n === 6,
    JSON.stringify({ total: rc.total.n }));

  const text = T.renderReport(parsed, []);
  t('the report prints the reach line with a share of carried', /Within the guard's reach: \d+ of 6 tool results/.test(text),
    text.split('\n').find(l => /Within the guard/.test(l)));
  t('and an out-of-reach line naming each way', /Out of reach: .*under the threshold.*not shell results.*failed.*ceiling/.test(text),
    text.split('\n').find(l => /Out of reach/.test(l)));
  /* Acted-on can never exceed what was reachable; the first version printed 450% because it counted every
     result whose text merely mentioned the marker against a window computed from delivered sizes. */
  const acted = (text.match(/Acted on: (\d+) of those -- (\d+)%/) || []);
  t('acted-on never exceeds what was reachable', !acted[2] || Number(acted[2]) <= 100, acted[0] || 'no acted line');
  t('the window splits into what was acted on and what is still available',
    rc.acted.n + rc.untouched.n === rc.window.n && rc.acted.n === 1 && rc.untouched.n === 1,
    JSON.stringify({ acted: rc.acted.n, untouched: rc.untouched.n, window: rc.window.n }));

  console.log('\n-- where the model actually reads');
  /* The only evidence that can settle readLimitLines for a given person, and it comes from their own
     sessions: when the model asks for a RANGE it has said where it expects to find something. A cap that
     keeps the first N lines hides the target whenever that start line is past N (AB-TASK.md, "The Read
     cap's trigger"). `cat` and `head` ask for the top and are not position choices, so they do not count. */
  const { readTargets } = await import('./transcript.js');
  const mk = (rows) => ({ results: rows });
  const tx = mk([
    { readFrom: 10 }, { readFrom: 46 }, { readFrom: 250 }, { readFrom: 411 }, { readFrom: 820 },
    { readFrom: null }, { readFrom: null },
  ]);
  const tt = readTargets(tx, [300, 500, 800]);
  t('only ranged reads count as targets', tt.n === 5, JSON.stringify(tt));
  t('the deepest target is reported, not the average', tt.max === 820, String(tt.max));
  t('a cap at 300 hides the two targets past it', tt.past[300] === 2, JSON.stringify(tt.past));
  t('a deeper cap hides fewer, and a target past the cap still counts', tt.past[500] === 1 && tt.past[800] === 1, JSON.stringify(tt.past));
  t('no targets means no claim', readTargets(mk([{ readFrom: null }]), [300]).n === 0);
  /* The distinction the line rests on: a range is a position choice, the top of a file is not. */
  const { readFileOf: _rf } = await import('./transcript.js');
  const startOf = (cmd) => { const m = /sed\s+-n\s+['"]?(\d+),(\d+)p/.exec(cmd); return m ? Number(m[1]) : null; };
  t('a sed range is a target at its first line', startOf("sed -n '320,345p' settle.js") === 320);
  t('cat and head are not position choices', startOf('cat settle.js') === null && startOf('head -n 300 settle.js') === null);

  console.log('\n-- separating the cap\'s own echo from where the model chose to look');
  /* The confound this whole block exists for. A capped Read hands back lines 1..limit and its
     additionalContext tells the model, in words, to come back with an offset. It does -- and that follow-up
     is a ranged read starting just past the cap, which then lands in the distribution meant to decide what
     the cap should be. Pooled over seventeen real sessions the number read 57% of targets past line 300,
     median 351, against the 300 the guard had been applying all along. The join below is what takes that
     apart: same file, same session, issued after the cap fired. */
  const C0 = Date.parse('2026-09-12T09:00:00.000Z');
  const jp = {
    cwd: '/w', sessionId: 'joinsess', requests: [{}], compactions: [],
    results: [
      { file: '/w/a.js', readFrom: 40, askedAt: C0 - 5000, at: C0 - 5000 },        // before the cap: evidence
      { file: '/w/a.js', readFrom: 305, askedAt: C0 + 2000, at: C0 + 2000 },       // after it: the cap's own
      { file: '/w/b.js', readFrom: 420, askedAt: C0 + 3000, at: C0 + 3000 },       // never capped
      { file: '/w/t/tool-results/x.txt', readFrom: 90, askedAt: C0 + 4000, at: C0 + 4000 },
      { file: '/w/a.js', readFrom: 700, askedAt: null, at: null },                 // cannot be ordered
      { file: '/w/c.js', readFrom: null, askedAt: C0, at: C0 },                    // not a ranged read at all
    ],
  };
  const jled = [
    { t: C0, ev: 'read-cap', session: 'joinsess', tool: 'Read', what: '/w/a.js', bytes: 80000, lines: 1900, limit: 300, persisted: false },
    { t: C0 + 3500, ev: 'read-cap', session: 'joinsess', tool: 'Read', what: '/w/t/tool-results/x.txt', bytes: 40000, lines: 900, limit: 80, persisted: true },
    { t: C0, ev: 'read-cap', session: 'other', tool: 'Read', what: '/w/b.js', bytes: 99999, lines: 2000, limit: 300, persisted: false },
  ];
  const cl = T.classifyRangedReads(jp, jled, { sessionId: 'joinsess' });
  t('a ranged read issued after a cap on the same file is excluded',
    cl.induced.length === 2 && cl.induced.some(x => x.read.readFrom === 305), JSON.stringify(cl.induced.map(x => x.read.readFrom)));
  t('a ranged read of that file from BEFORE the cap is kept -- it is evidence',
    cl.spontaneous.some(r => r.readFrom === 40), JSON.stringify(cl.spontaneous.map(r => r.readFrom)));
  t('a ranged read of a file no cap touched is kept', cl.spontaneous.some(r => r.readFrom === 420));
  t('a persisted-output cap excludes the same way a source-file cap does',
    cl.induced.some(x => x.read.readFrom === 90));
  t('a read that cannot be ordered against the cap goes in neither bucket, and is counted',
    cl.unordered.length === 1 && !cl.spontaneous.some(r => r.readFrom === 700) && !cl.induced.some(x => x.read.readFrom === 700));
  t('all equals spontaneous plus induced plus unordered, always',
    cl.all.length === cl.spontaneous.length + cl.induced.length + cl.unordered.length, String(cl.all.length));
  t('a cap in another session does not exclude this session\'s reads',
    cl.spontaneous.some(r => r.readFrom === 420), JSON.stringify(cl.byFile));
  /* An empty ledger must say the separation was not attempted. Reporting "0 induced" would hand a machine
     whose ledger predates the Read cap a clean bill of health for a confound nobody looked for. */
  const clNone = T.classifyRangedReads(jp, [], {});
  t('an empty ledger reports that the separation was not attempted, not that nothing was induced',
    clNone.attempted === false && clNone.induced.length === 0 && clNone.spontaneous.length === 5);
  /* A shell excerpt names a relative path while the ledger records what the guard stat'd, absolute. */
  const relp = { cwd: '/w', sessionId: 'joinsess', requests: [{}], compactions: [],
    results: [{ file: 'a.js', readFrom: 310, askedAt: C0 + 1000, at: C0 + 1000 }] };
  t('a relative shell path resolves against the session cwd', T.classifyRangedReads(relp, jled, {}).induced.length === 1);
  t('with no cwd to resolve against, the weaker basename match is counted as such',
    (() => { const c = T.classifyRangedReads({ ...relp, cwd: null }, jled, {}); return c.induced.length === 1 && c.basename === 1; })());
  t('normReadPath folds case only behind a Windows drive letter',
    T.normReadPath('C:\\Work\\A.js') === 'c:/work/a.js' && T.normReadPath('/w/A.js') === '/w/A.js');

  /* The same question without the ledger, so it still gets asked where the ledger predates the cap. Two
     equal-width bands, so under the null `at` is Binomial(n, 0.5) -- an exact tail, nothing tuned. */
  const rep = (n, v) => Array(n).fill(v);
  t('bunching just past the cap is a spike, with no ledger at all',
    T.capBandSpike([...rep(12, 305), ...rep(1, 290)], 300).verdict === 'spike');
  t('a smooth distribution shows no step at the cap',
    T.capBandSpike([...rep(10, 305), ...rep(10, 290)], 300).verdict === 'none');
  t('a thin sample reports itself as thin, never as no spike',
    T.capBandSpike(rep(3, 305), 300).verdict === 'too few');
  t('the exact-boundary count is separate, and counts only the cap and one past it',
    T.capBandSpike([300, 301, 302, 305], 300).exact === 2);
  t('the histogram bins every start exactly once',
    T.startHistogram([1, 0, 60, 250, 400, 900, 5000]).reduce((n, b) => n + b.n, 0) === 7);

  console.log('\n-- what you read whole, and how deep the targets sit');
  /* The guard now records a whole-file read it did NOT cap. Until it did, the trigger's own evidence was all
     inference: sizes came from the delivered text, which Claude Code line-numbers, and file lengths were read
     off disk today -- one ranged read in forty-three could be resolved exactly, so whether the cap should be a
     line count or a fraction of the file could not be answered at all. This is a log-only change: the guard
     writes the row and returns, exactly as before, and emits nothing. */
  {
    const dir = mkdtempSync(join(tmpdir(), 'tokenbrake-whole-'));
    const small = join(dir, 'small.js');
    writeFileSync(small, Array.from({ length: 120 }, (_, i) => 'line ' + i).join('\n'));
    const spawnRead = (env) => spawnSync(process.execPath, ['./guard.js', 'read-pre'],
      { input: JSON.stringify({ session_id: 'w1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: small } }),
        encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir, ...env } });
    const g1 = spawnRead({});
    const ledgerAt = join(dir, 'tokenbrake', 'ledger.jsonl');
    const rows = readFileSync(ledgerAt, 'utf8').trim().split('\n').map(x => JSON.parse(x));
    t('a whole-file read under the trigger is recorded, with the size statSync saw',
      rows.length === 1 && rows[0].ev === 'read-whole' && rows[0].bytes === statSync(small).size && rows[0].lines === 119,
      JSON.stringify(rows[0]));
    t('recording it changes nothing the model sees: no output, exit 0',
      g1.stdout === '' && g1.status === 0, JSON.stringify(g1.stdout));
    /* A bounded read still returns before anything is stat'd, so it must not appear in the ledger either. */
    const g2 = spawnSync(process.execPath, ['./guard.js', 'read-pre'],
      { input: JSON.stringify({ session_id: 'w1', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: small, offset: 40 } }),
        encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
    t('a read the model already bounded is still not recorded at all',
      g2.stdout === '' && readFileSync(ledgerAt, 'utf8').trim().split('\n').length === 1);
    writeFileSync(join(dir, 'tokenbrake.json'), JSON.stringify({ logAllTools: false }));
    spawnRead({});
    t('logAllTools: false keeps it out, like every other non-event row',
      readFileSync(ledgerAt, 'utf8').trim().split('\n').length === 1);
    rmSync(dir, { recursive: true, force: true });
  }
  /* Which SHAPE of cap, not which value. An absolute cap withholds most of a long file and nothing from a
     short one; a fractional cap withholds the same share of every file. A coefficient of variation cannot
     tell those apart, because it measures concentration rather than what one threshold of that shape costs.
     AB-TASK.md, "The Read cap's form" -- rule and thresholds committed before it was first computed. */
  {
    const shallow = Array.from({ length: 40 }, (_, i) => ({ start: 5 + (i % 20), lines: 200 + 10 * i }));
    const fs2 = T.capFrontier(shallow);
    t('a cap is scored on both what it withholds and what it hides',
      fs2.absolute[0].miss === 0 && Math.abs(fs2.absolute[0].withheld - 0.75) < 0.02,
      JSON.stringify(fs2.absolute[0]));
    t('no cap at all is on the list, because a shape that cannot beat doing nothing is not worth having',
      fs2.none.miss === 0 && fs2.none.withheld === 0);
    t('a fractional cap withholds the same share of every file, whatever its length',
      fs2.fractional.every(p => Math.abs(p.withheld - (1 - p.param)) < 0.02),
      JSON.stringify(fs2.fractional.map(p => [p.param, p.withheld.toFixed(2)])));
    /* The verdict holds SAFETY fixed and compares SAVING: among the candidates of a shape whose miss rate is
       at or under the budget, the most any withholds. The first criterion asked for no higher miss at every
       matched withholding level and could not discriminate -- a fractional cap is all-or-nothing on targets at
       a fixed depth while an absolute one degrades gradually, so two curves of different curvature are almost
       never one uniformly below the other. It returned "neither" for data built to favour each shape in turn.
       Found on these fixtures before it ran on real data, withdrawn, and recorded as withdrawn. The three
       fixtures below are what an instrument has to separate before it is allowed to measure anything. */
    const proportional = Array.from({ length: 40 }, (_, i) => ({ lines: 100 + 50 * i, start: Math.floor((100 + 50 * i) * 0.55) }));
    t('targets at a fixed DEPTH: the fractional shape saves more at the same safety',
      T.frontierVerdict(T.capFrontier(proportional)).verdict === 'fractional',
      JSON.stringify(T.frontierVerdict(T.capFrontier(proportional)).verdict));
    t('and an absolute cap cannot be safe there at all without withholding nothing',
      T.frontierVerdict(T.capFrontier(proportional)).absolute.withheld === 0);
    /* Two habits at once -- some targets at the top, some in the middle. An absolute cap can still hold the
       deeper group by keeping a fixed number of lines that is a small share of a long file; a fraction cannot
       be small and deep at once. */
    const bimodal = Array.from({ length: 40 }, (_, i) => (i % 8 < 5
      ? { lines: 300 + 40 * i, start: 6 + (i % 4) }
      : { lines: 300 + 40 * i, start: Math.floor((300 + 40 * i) * 0.55) }));
    t('a bimodal habit is separated too, and does not collapse to no answer',
      T.frontierVerdict(T.capFrontier(bimodal)).verdict === 'absolute');
    /* Shallow targets in files of every length: a small absolute cap and a small fraction are nearly the same
       thing, and the 10-point edge refuses to call a 4-point difference a win. */
    const fixedLine = Array.from({ length: 40 }, (_, i) => ({ lines: 400 + 60 * i, start: 90 + (i % 5) }));
    t('when both shapes serve equally the answer is a tie, not the larger number',
      T.frontierVerdict(T.capFrontier(fixedLine)).verdict === 'tie',
      JSON.stringify([T.frontierVerdict(T.capFrontier(fixedLine)).absolute.withheld,
        T.frontierVerdict(T.capFrontier(fixedLine)).fractional.withheld]));
    /* Files all one length make the two shapes the same thing by construction, so a tie there is arithmetic
       rather than a finding -- worth pinning, because it is the case that would make a real tie meaningless. */
    const uniform = Array.from({ length: 40 }, (_, i) => ({ lines: 1000, start: 10 + 24 * i }));
    t('when every file is the same length the two shapes ARE the same cap, and the answer is a tie',
      T.frontierVerdict(T.capFrontier(uniform)).verdict === 'tie'
      && Math.abs(T.frontierVerdict(T.capFrontier(uniform)).absolute.withheld
        - T.frontierVerdict(T.capFrontier(uniform)).fractional.withheld) < 1e-9);
    /* Priced in tokens rather than in share of lines, which is Step A of the fractional cap's
       pre-registration. A share of a file's lines weights a 200-line file like a 2,000-line one, and a
       fractional cap's extra saving lands mostly on short files -- where it is cheap. The two measures must be
       able to disagree, or the re-test is theatre. */
    const mixed = [];
    for (let i = 0; i < 30; i++) mixed.push({ start: 5, lines: 150, bpl: 20 });      // short, cheap, shallow
    for (let i = 0; i < 15; i++) mixed.push({ start: 1100, lines: 2000, bpl: 55 });  // long, dear, deep
    const fm = T.capFrontier(mixed);
    t('the same data can say fractional by share of lines and a tie by tokens',
      T.frontierVerdict(fm).verdict === 'fractional'
      && T.frontierVerdict(fm, { measure: 'tokens' }).verdict === 'tie',
      JSON.stringify([T.frontierVerdict(fm).verdict, T.frontierVerdict(fm, { measure: 'tokens' }).verdict]));
    t('a fractional cap withholds the same share of tokens as of lines, since it cuts every file alike',
      fm.fractional.every(p => Math.abs(p.withheldTokens - (1 - p.param)) < 0.02),
      JSON.stringify(fm.fractional.map(p => [p.param, p.withheldTokens.toFixed(2)])));
    t('a read with no bytes-per-line is outside the token measure and counted, not estimated in',
      T.capFrontier([{ start: 5, lines: 100, bpl: 20 }, { start: 5, lines: 100 }]).priced === 1);
    t('with nothing priced at all the token measure is zero everywhere rather than a guess',
      T.capFrontier([{ start: 5, lines: 100 }]).absolute.every(p => p.withheldTokens === 0));
    /* Zero everywhere would otherwise read as "neither shape can be safe and useful", which is a finding this
       data cannot support: nothing was measured, so nothing is concluded. */
    t('a token verdict with nothing priced is no verdict, not a finding about the shapes',
      T.frontierVerdict(T.capFrontier([{ start: 5, lines: 100 }]), { measure: 'tokens' }).verdict === 'no verdict'
      && T.frontierVerdict(T.capFrontier([{ start: 5, lines: 100 }])).verdict !== 'no verdict');
    /* The strongest finding the rule can return: targets sitting at the end of their files, where the only
       safe cap is no cap and no value of either shape saves anything. */
    const deep = Array.from({ length: 40 }, (_, i) => ({ lines: 2000 + 50 * i, start: Math.floor((2000 + 50 * i) * 0.95) }));
    t('targets at the end of their files means neither shape can be safe and useful, and it says so',
      T.frontierVerdict(T.capFrontier(deep)).verdict === 'neither can be safe and useful',
      JSON.stringify(T.frontierVerdict(T.capFrontier(deep)).verdict));
  }
  /* A read that ran off the end of its file says exactly how long that file was, and it was in every
     transcript already. `sed -n '375,480p'` asking for 106 lines and getting 105 means the file ended at 479.
     On this repo's own transcripts 40 of 163 sed ranges ran off the end -- against one exact file length in
     forty-three from every other source combined, which is why the shape question had no evidence. */
  t('a sed range that ran off the end gives the file\'s exact length',
    T.eofLength('Bash', { command: "sed -n '375,480p' a.js" }, Array(105).fill('x').join('\n'), false) === 479);
  t('a Read with offset and limit does the same',
    T.eofLength('Read', { file_path: 'a.js', offset: 300, limit: 100 }, Array(48).fill('1\tx').join('\n'), false) === 347);
  t('a range that filled up says only that the file is at least that long, so it says nothing here',
    T.eofLength('Bash', { command: "sed -n '1,30p' a.js" }, Array(30).fill('x').join('\n'), false) === null);
  /* The one way this would lie, and it would lie systematically: a result the guard trimmed is short because
     the guard cut it, not because the file ended -- which would report every capped read as a short file. */
  t('a result the guard trimmed is refused outright, not read as a short file',
    T.eofLength('Bash', { command: "sed -n '1,999p' a.js" }, 'x\n[tokenbrake] capped at 300 lines', true) === null);
  t('a range beginning past the end is a bound, not a length',
    T.eofLength('Bash', { command: "sed -n '900,910p' a.js" }, '', false) === null);
  t('an off-the-end length resolves a ranged read, and counts as exact',
    (() => {
      const p5 = { cwd: '/w', sessionId: 'w4', requests: [{}], compactions: [], results: [
        { file: '/w/a.js', whole: false, chars: 10, lines: 5, shape: null, readFrom: 200, askedAt: 1, at: 1, eofAt: 479 },
        { file: '/w/a.js', whole: false, chars: 10, lines: 5, shape: null, readFrom: 100, askedAt: 2, at: 2, eofAt: null }] };
      const d5 = T.readDepths(p5, [], { sessionId: 'w4' });
      return d5.n === 2 && d5.bySource.eof === 2 && d5.exactN === 2 && Math.abs(d5.rows[0].depth - 200 / 479) < 1e-9;
    })());
  t('a file length from one of those rows resolves a ranged read exactly, instead of off disk today',
    (() => {
      const p3 = { cwd: '/w', sessionId: 'w2', requests: [{}], compactions: [],
        results: [{ file: '/w/a.js', whole: false, chars: 10, lines: 5, shape: null, readFrom: 300, askedAt: 1, at: 1 }] };
      const led = [{ t: 1, ev: 'read-whole', session: 'w2', tool: 'Read', what: '/w/a.js', bytes: 40000, lines: 900 }];
      const d3 = T.readDepths(p3, led, { sessionId: 'w2' });
      return d3.rows.length === 1 && d3.rows[0].lines === 900 && d3.rows[0].source === 'ledger' && d3.exactN === 1;
    })());
  t('the largest sighting of a file wins, so a file that grew is not measured at its shortest',
    T.wholeReadIndex([
      { ev: 'read-whole', session: 'w2', what: '/w/a.js', bytes: 1000, lines: 20 },
      { ev: 'read-whole', session: 'w2', what: '/w/a.js', bytes: 4000, lines: 90 }], 'w2').byFile.get('/w/a.js').lines === 90);
  t('a whole-file read takes the ledger size over anything the delivered text can say',
    (() => {
      const p4 = { cwd: '/w', sessionId: 'w3', requests: [{}], compactions: [],
        results: [{ file: '/w/a.js', whole: true, chars: 24132, lines: 352, shape: T.fileShape('1\tx'), readFrom: null }] };
      const u4 = T.unboundedReads(p4, [{ t: 1, ev: 'read-whole', session: 'w3', what: '/w/a.js', bytes: 22833, lines: 352 }], {});
      return u4.reads[0].bytes === 22833 && u4.reads[0].source === 'ledger-whole';
    })());

  /* The trigger's half of the question, which is arithmetic and needs no session: how many of a person's
     whole-file reads a lower readMaxBytes would catch, and how much of each a limit would then withhold.
     And the shape question underneath it -- readLimitLines is an absolute line count, but whether it hides
     the target depends on where the target sits as a FRACTION of the file. */
  t('an unbounded Read is a whole-file read; one carrying an offset or a limit is not',
    T.readsWholeFile('Read', { file_path: '/a.js' }) === true
    && T.readsWholeFile('Read', { file_path: '/a.js', offset: 40 }) === false
    && T.readsWholeFile('Read', { file_path: '/a.js', limit: 300 }) === false);
  t('a bare cat is a whole-file read; head, tail, sed -n and grep are bounded requests and are not',
    T.readsWholeFile('Bash', { command: 'cat /a.js' }) === true
    && T.readsWholeFile('Bash', { command: 'cd /w && cat a.js' }) === true
    && T.readsWholeFile('Bash', { command: 'head -n 300 /a.js' }) === false
    && T.readsWholeFile('Bash', { command: "sed -n '10,40p' /a.js" }) === false
    && T.readsWholeFile('Bash', { command: 'grep foo /a.js' }) === false
    && T.readsWholeFile('Bash', { command: 'cat /a.js | head -5' }) === false);

  /* Claude Code numbers every line it delivers, so the delivered text is not the file. Verified on this
     repo's own transcripts: an unchanged guard.js came back as 22,076 characters and its numbering strips to
     20,832 bytes against 20,831 on disk -- exact to the trailing newline, and 5-6% off if left in. It grows
     with the line count, so it is worst on exactly the long files the trigger question is about. */
  const numbered = (from, to, text) => Array.from({ length: to - from + 1 }, (_, i) => (from + i) + '\t' + text).join('\n');
  const sh = (t) => T.fileShape(t);
  t('the delivered text is not the file: Claude Code\'s line numbering is subtracted',
    sh(numbered(1, 3, 'abcd')).bytes === 15 && sh(numbered(1, 3, 'abcd')).lines === 3,
    JSON.stringify(sh(numbered(1, 3, 'abcd'))));
  t('the last line number is the file\'s length, which is better than counting newlines',
    sh(numbered(1, 352, 'x')).lines === 352 && sh(numbered(380, 479, 'x')).from === 380);
  t('unnumbered text is the file itself -- a shell cat has nothing to subtract',
    sh('plain\ntext').numbered === false && sh('plain\ntext').bytes === Buffer.byteLength('plain\ntext'));
  t('leading numbers that do not run consecutively are data, not numbering',
    sh('1\ta\n1\tb').numbered === false);

  const U0 = Date.parse('2026-09-12T08:00:00.000Z');
  const R = (file, whole, text, readFrom, dt, extra) => ({ file, whole, chars: text.length,
    lines: text.split('\n').length, shape: T.fileShape(text), readFrom: readFrom || null,
    askedAt: U0 + (dt || 0), at: U0 + (dt || 0), ...(extra || {}) });
  const up = {
    cwd: '/w', sessionId: 'usess', requests: [{}], compactions: [],
    results: [
      R('/w/small.js', true, numbered(1, 100, 'x'.repeat(38)), null, 0),
      R('/w/big.js', true, numbered(1, 300, 'x'.repeat(38)), null, 1000),
      R('/w/host.txt', true, numbered(1, 2000, 'x'.repeat(38)), null, 2000),
      R('/w/small.js', false, numbered(60, 89, 'x'), 60, 3000),
      R('/w/nolen.js', false, numbered(200, 229, 'x'), 200, 4000),
    ],
  };
  const uled = [{ t: U0 + 900, ev: 'read-cap', session: 'usess', tool: 'Read', what: '/w/big.js', bytes: 80000, lines: 1900, limit: 300, persisted: false }];
  const ur = T.unboundedReads(up, uled, { sessionId: 'usess' });
  /* The correction the whole count turns on. big.js was capped, so its delivered 12,000 chars are the cap's
     300 lines, not the file. Believing the transcript there would count a capped read as a small file -- and
     argue for a lower trigger using the cap's own output as the evidence for it. */
  t('a capped read is counted at the ledger\'s true size, not at what the cap delivered',
    ur.reads.find(r => /big/.test(r.file)).bytes === 80000 && ur.reads.find(r => /big/.test(r.file)).source === 'ledger',
    JSON.stringify(ur.reads.map(r => [r.file, r.bytes, r.source])));
  t('a read recorded as the model wrote it is told apart from one recorded as the guard rewrote it',
    ur.recordedOriginal === 1 && ur.recordedRewritten === 0, JSON.stringify({ o: ur.recordedOriginal, r: ur.recordedRewritten }));
  t('a cap row with no matching unbounded read still enters the population, at its true size',
    (() => { const x = T.unboundedReads({ ...up, results: up.results.filter(r => !/big/.test(r.file)) }, uled, {});
      return x.recordedRewritten === 1 && x.reads.some(r => r.bytes === 80000); })());
  /* An unbounded read that stops at a round host limit says nothing about the file's length. Whether Claude
     Code really has such a limit is not documented and no transcript here reaches one, so the flag asserts
     nothing -- it stays at zero if the limit is not real, and catches the case if it is. */
  t('an unbounded read stopping at exactly the host line limit is a floor, not a file length',
    ur.reads.find(r => /host/.test(r.file)).ceiling === 'host-lines' && ur.hostLines === 1);
  /* A failed read is not a large file. The host's own size refusal IS evidence one exists, with no evidence
     of how large; "file does not exist" is evidence of nothing. Counting every failure as the first would
     manufacture large files out of typos -- and unsized reads sit exactly where they could swing the
     withholding median, which is the number the trigger's decision rule turns on. */
  const errRead = (file, text) => ({ file, whole: true, chars: 10, lines: 1, shape: T.fileShape('x'),
    readFrom: null, isError: true, text });
  const errs = T.unboundedReads({ ...up, results: [
    errRead('/w/big.js', 'File content (35000 tokens) exceeds maximum allowed tokens (25000)'),
    errRead('/w/gone.js', '<tool_use_error>File does not exist.</tool_use_error>')] }, [], {});
  t('the host\'s size refusal is evidence of a large file; any other failure is not',
    errs.refused === 1 && errs.errored === 1, JSON.stringify({ refused: errs.refused, errored: errs.errored }));
  t('neither kind of failure is sized, so neither enters the grid', errs.sized.length === 0);
  t('a read that could not be sized is out of the grid, not silently in it',
    ur.sized.length === 2 && ur.n === 3, JSON.stringify({ sized: ur.sized.length, n: ur.n }));
  t('a read of a spilled output is the other knob and never enters the population',
    T.unboundedReads({ ...up, results: [R('/w/t/tool-results/a.txt', true, 'x', null, 0)] }, [], {}).persistedSkipped === 1);
  t('an image is never a whole-file read: the cap returns on it before it stats anything',
    T.readsWholeFile('Read', { file_path: '/a.png' }) === false && T.readsWholeFile('Read', { file_path: '/a.ipynb' }) === false);

  const grid = T.triggerGrid(ur.sized, [3000, 60000], [300, 800]);
  t('a lower trigger catches more reads, and the byte share is reported with the count',
    grid[0].caught === 2 && grid[1].caught === 1 && Math.abs(grid[1].byteShare - 80000 / (80000 + 3900)) < 1e-9,
    JSON.stringify(grid.map(g => [g.trigger, g.caught, g.byteShare.toFixed(3)])));
  t('a file exactly at the trigger is not caught -- the guard returns on <=, not <',
    T.triggerGrid([{ bytes: 60000, lines: 10 }, { bytes: 60001, lines: 10 }], [60000], [300])[0].caught === 1);
  t('the withheld share is the median over the reads the trigger caught',
    Math.abs(grid[1].byLimit[300] - (1900 - 300) / 1900) < 1e-9, String(grid[1].byLimit[300]));
  t('a limit at or above the file\'s length withholds nothing -- the cap fires and is a no-op',
    T.triggerGrid([{ bytes: 70000, lines: 600 }], [10000], [800])[0].byLimit[800] === 0);

  /* Depth: the same start line means different things in files of different lengths, and nothing before this
     paired the two. Line lengths come from three sources and the weakest (the file on disk now) is excluded
     from the verdict, because it may not be the length the model saw. */
  const dep = T.readDepths(up, uled, { sessionId: 'usess', linesOnDisk: (f) => (/nolen/.test(f) ? 400 : null) });
  t('a file length taken from a host-truncated read is not used as a length at all',
    !dep.rows.some(r => /host/.test(r.file)));
  t('depth is the start line over the file\'s length, and the source of that length is recorded',
    dep.rows.find(r => /small/.test(r.file)).depth === 0.6 && dep.rows.find(r => /small/.test(r.file)).source === 'session',
    JSON.stringify(dep.rows.map(r => [r.file, r.depth, r.source])));
  t('a length that could only be read off disk now is used but marked as the weaker source',
    dep.bySource.disk === 1 && dep.exactN === 1, JSON.stringify(dep.bySource));
  t('a read whose file length cannot be established is unresolved, never imputed',
    T.readDepths(up, uled, { sessionId: 'usess' }).unresolved === 1);
  t('a start line past the end of the file is unresolved rather than a depth over 1',
    T.readDepths({ ...up, results: [R('/w/small.js', true, numbered(1, 50, 'x'), null, 0),
      R('/w/small.js', false, numbered(900, 904, 'x'), 900, 1)] }, [], {}).unresolved === 1);
  t('the two spreads are both reported, so the shape question has an answer either way',
    typeof T.readDepths({ ...up, results: [
      R('/w/a.js', true, numbered(1, 100, 'x'), null, 0), R('/w/b.js', true, numbered(1, 1000, 'x'), null, 1),
      R('/w/a.js', false, numbered(50, 54, 'x'), 50, 2), R('/w/b.js', false, numbered(500, 504, 'x'), 500, 3)] },
      [], {}).fracCV === 'number');

  /* The ledger view. One count for both Read-cap halves told the owner nothing about which default it was
     evidence for: readMaxBytes governs a large source file, persistedLimitLines a spilled output. */
  const capLed = [
    { t: 1000, ev: 'read-cap', session: 'A', tool: 'Read', what: '/w/big.js', bytes: 80000, lines: 1900, limit: 300, persisted: false },
    { t: 1020, ev: 'read-cap', session: 'A', tool: 'Read', what: '/w/big.js', bytes: 80000, lines: 1900, limit: 300, persisted: false },
    { t: 5000, ev: 'read-cap', session: 'A', tool: 'Read', what: '/w/t/tool-results/a.txt', bytes: 40000, lines: null, limit: 80, persisted: true },
    { t: 9000, ev: 'read-cap', session: 'B', tool: 'Read', what: '/w/big.js', bytes: 80000, lines: 1900, limit: 300, persisted: false },
  ];
  const cf = T.readCapFiles(capLed, null);
  /* A `cat` of a large file is capped by the POST hook against the SAME readMaxBytes and readLimitLines, but
     it logs as a trimmed post, not as a read-cap row. A counter reading only read-cap rows therefore sees one
     of the two paths those knobs govern and reports the other as never having fired -- which is exactly what
     it did report, on the owner's real sessions, until this. */
  const exLed = [
    { t: 1, ev: 'read-cap', session: 'A', tool: 'Read', what: '/w/big.js', bytes: 80000, lines: 1900, limit: 300, persisted: false },
    { t: 2, ev: 'post', session: 'A', tool: 'Bash', excerpt: true, kept: 9000, chars: 62476, what: 'cat /w/huge.md' },
    { t: 3, ev: 'post', session: 'A', tool: 'Bash', excerpt: true, chars: 500, what: 'cat /w/small.md' },
    { t: 4, ev: 'post', session: 'A', tool: 'Bash', chars: 9000, kept: 1000, what: 'npm test' },
  ];
  const exc = T.readCapFiles(exLed, null);
  t('a shell cat capped by the same two knobs is counted, on its own line',
    exc.excerpt.n === 1 && exc.excerpt.bytes === 62476 && exc.source.n === 1,
    JSON.stringify({ excerpt: exc.excerpt, source: exc.source }));
  t('an excerpt the guard left alone is not a cap, and an ordinary trim is not one either',
    exc.n === 2, JSON.stringify(exc.files.map(f => f.what)));
  t('a capped cat is sized at its size BEFORE the cap, not at what the cap delivered',
    (() => { const p2 = { cwd: '/w', sessionId: 'A', requests: [{}], compactions: [],
        results: [{ file: '/w/huge.md', whole: true, chars: 9000, lines: 300, shape: T.fileShape('x'),
          readFrom: null, marker: true, id: 'tu9' }] };
      const u2 = T.unboundedReads(p2, [{ t: 2, ev: 'post', session: 'A', excerpt: true, kept: 9000, chars: 62476, id: 'tu9', what: 'cat /w/huge.md' }], {});
      return u2.reads[0].bytes === 62476 && u2.reads[0].source === 'ledger-post'; })());
  t('the cap counter splits the two knobs apart', cf.source.n === 2 && cf.persisted.n === 1, JSON.stringify({ s: cf.source, p: cf.persisted }));
  t('a double install logs each cap twice; the duplicate is dropped once and reported',
    cf.deduped === 1 && cf.n === 3, JSON.stringify({ deduped: cf.deduped, n: cf.n }));
  t('the delivered share is limit/lines', Math.abs(cf.files.find(f => /big/.test(f.what)).delivered - 300 / 1900) < 1e-9);
  t('a row with no line count reports no fraction rather than a guess',
    cf.files.find(f => /a\.txt/.test(f.what)).delivered === null && cf.unknownLines === 1);
  t('the same file capped in two sessions is one row, counted twice',
    cf.files.find(f => /big/.test(f.what)).n === 2 && cf.sessions === 2);
  t('pooled counts equal the sum of the per-session ones',
    T.readCapFiles(capLed, 'A').n + T.readCapFiles(capLed, 'B').n === cf.n,
    String(T.readCapFiles(capLed, 'A').n) + '+' + String(T.readCapFiles(capLed, 'B').n) + ' vs ' + String(cf.n));

  console.log('\n-- the bill, and the guard\'s own cost');
  /* ab10 measured that the saving lives in `carried`, so the report has to price a re-read, not a byte. */
  const px = T.priceOf('claude-opus-5');
  t('a re-read is priced at the cache-read rate and the first pass at the write rate',
    Math.abs(T.usdOfTokens(1e6, 3e6, px) - (1 * px.write + 2 * px.read)) < 1e-9,
    String(T.usdOfTokens(1e6, 3e6, px)));
  t('carried below the first pass never prices negative', T.usdOfTokens(1e6, 0, px) === 1 * px.write,
    String(T.usdOfTokens(1e6, 0, px)));
  t('an unpriced model yields no dollar figure, never a guess', T.usdOfTokens(1e6, 2e6, T.priceOf('some-other-model')) === null);
  t('the dominant model is the one most requests ran on',
    T.dominantModel({ requests: [{ model: 'a' }, { model: 'b' }, { model: 'b' }] }) === 'b');

  /* A recovery read is the same file at a different offset -- the cost a trim can create. Distinct from a
     repeat read, which returns the same slice again (ab10 pair 5: 4 recovery reads, the smallest saving). */
  const recTx = {
    requests: [{}, {}, {}], compactions: [],
    results: [
      { name: 'Read', file: '/a/settle.js', tokens: 100, carried: 300, afterReq: 0 },
      { name: 'Bash', file: '/a/settle.js', tokens: 50, carried: 100, afterReq: 1 },
      { name: 'Bash', file: '/a/other.js', tokens: 40, carried: 80, afterReq: 1 },
      { name: 'Bash', file: null, tokens: 10, carried: 20, afterReq: 2 },
    ],
  };
  const rec = T.recoveryReads(recTx);
  t('coming back to a file already read counts once, and only for the return',
    rec.n === 1 && rec.tokens === 50 && rec.carried === 100, JSON.stringify(rec));
  t('a result naming no file is never a recovery read', rec.files.length === 1 && rec.files[0] === '/a/settle.js', JSON.stringify(rec.files));
}

/* ---- shape filters, off by default ---------------------------------------
   The trim only acts above maxChars and spends that budget on whatever is there, which on an install log
   is progress redraws: measured, 400 such lines kept 65 of them and 144 ANSI escapes and left the final
   status alive only because it sat in the tail (AB-TASK.md, "An outside test plan"). These filters run
   before the size test, so a log that collapses below maxChars is delivered clean and never trimmed at
   all. Default off; a default only moves after an A/B, as every other default here has. */
{
  console.log('\n-- shape filters (off by default)');
  /* A real progress bar carries glyphs from early on; a degenerate one that starts empty is not the case
     the filter is for, and using it here hid how much the safety rules cost. */
  const bar = (pct, i) => `\x1b[32m[${'='.repeat(Math.max(3, Math.floor(pct * 0.4))).padEnd(40)}] ${pct}% - loading package number ${i} from the registry cache\x1b[0m`;
  const log400 = ['Installing dependencies...', ...Array.from({ length: 400 }, (_, i) => bar((i % 100) + 1, i)), 'Added 142 packages in 3s.'].join('\n');
  const run = (text, cfgExtra, command = 'npm install') => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenbrake-shape-'));
    if (cfgExtra) writeFileSync(join(dir, 'tokenbrake.json'), JSON.stringify(cfgExtra));
    const r = spawnSync(process.execPath, ['./guard.js', 'post'], {
      input: JSON.stringify({ session_id: 'shape', tool_use_id: 'toolu_shape_' + Math.random().toString(36).slice(2, 8),
        tool_name: 'Bash', tool_input: { command }, tool_response: bashResp(text) }), encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
    rmSync(dir, { recursive: true, force: true });
    const o = parse(r.stdout);
    return o && o.hookSpecificOutput && o.hookSpecificOutput.updatedToolOutput
      ? (o.hookSpecificOutput.updatedToolOutput.stdout ?? o.hookSpecificOutput.updatedToolOutput) : '';
  };

  const off = run(log400, null);
  t('off by default: the log is trimmed the old way, redraws and all',
    off.includes('\x1b[') && /omitted here/.test(off), `ansi=${(off.match(/\x1b\[/g) || []).length}`);

  const on = run(log400, { shapeFilters: true });
  t('on: ANSI escapes are gone', !on.includes('\x1b['), `ansi=${(on.match(/\x1b\[/g) || []).length}`);
  t('on: repeated redraws collapse with a count', /drawn \d+ times; \d+ identical-shaped lines collapsed/.test(on),
    (on.split('\n').find(l => /collapsed/.test(l)) || on.slice(0, 120)));
  t('on: the final status line survives', on.includes('Added 142 packages in 3s.'));
  /* The point of running before the size test: this log no longer needs trimming at all, so the model
     gets a whole document instead of a head, a tail and a hole. */
  t('on: it collapses below maxChars and is delivered without any trim', !/omitted here/.test(on), String(on.length));
  t('on: and is much smaller than what the trim alone delivered', on.length < off.length * 0.6, `${on.length} vs ${off.length}`);

  /* The safety this rests on, and the first version's bug. "Differs only in numbers" is not enough:
     sixty rows of a settlement table differ only in numbers too, and collapsing them destroyed
     fifty-nine tenants' amounts and left a count. An outside benchmark caught it before a run was paid
     for. A line is only redraw-like if it carries bar glyphs or a percentage. */
  const table = ['Tenant settlement table',
    ...Array.from({ length: 60 }, (_, i) => `acme-${String(i).padStart(3, '0')}   EUR   ${1000 + i * 37}.${String(i % 100).padStart(2, '0')}   settled   2026-09-10T11:${String(i % 60).padStart(2, '0')}:00Z`),
    'END OF TABLE'].join('\n');
  t('a data table whose rows differ only in numbers is NOT collapsed -- no bar, no percentage',
    run(table, { shapeFilters: true }) === '', run(table, { shapeFilters: true }).slice(0, 160));
  /* A percentage was allowed as a redraw signal for one afternoon and had to come out: eighty rows of
     `tenant acme-079 risk score 53% approved` collapsed to one and a count -- the settlement table again,
     through the other half of the rule. Percentages are in data more often than in progress bars. The
     cost is that a bar-less `Downloading... 45%` is no longer collapsed; that is the right side to err on. */
  const risk = ['Risk review', ...Array.from({ length: 80 }, (_, i) => `tenant acme-${String(i).padStart(3, '0')} risk score ${(i * 7) % 100}% approved`), 'END'].join('\n');
  t('a percentage alone is NOT a redraw signal -- risk scores are percentages too',
    run(risk, { shapeFilters: true }) === '', run(risk, { shapeFilters: true }).slice(0, 160));

  /* `\r` at the end of a line is a CRLF line ending, not a redraw. Reading it as one turned a 120-row CRLF
     CSV into 121 characters of empty lines: every field gone, the worst thing this filter has done. */
  const csv = 'date,tenant,ccy,amount,status\r\n' + Array.from({ length: 120 }, (_, i) => `2026-09-10,acme-${String(i).padStart(3, '0')},EUR,${1000 + i * 7}.${String(i % 100).padStart(2, '0')},settled`).join('\r\n') + '\r\n';
  t('a CRLF document passes through untouched -- the trailing \\r is a line ending, not a redraw',
    run(csv, { shapeFilters: true }) === '', run(csv, { shapeFilters: true }).slice(0, 160));
  const varied = ['alpha begins here', 'beta continues elsewhere', 'gamma finishes the job'].join('\n').padEnd(2000, '\nunique tail line here');
  const onVaried = run(varied, { shapeFilters: true });
  t('genuinely different consecutive lines are left alone', onVaried === '' || onVaried.includes('alpha begins here'));

  const small = 'short output, nothing to do here';
  t('under shapeMinChars nothing is emitted at all', run(small, { shapeFilters: true }) === '');

  /* A carriage-return redraw is one line overwritten many times; only the last write was ever visible. */
  const cr = 'downloading\n' + 'x'.repeat(1600) + '\n' + ['  5%', ' 25%', ' 75%', '100% done'].map(p => `progress: ${p}`).join('\r') + '\nfinished';
  const onCr = run(cr, { shapeFilters: true });
  t('a carriage-return redraw keeps its last frame only',
    onCr.includes('100% done') && !onCr.includes('  5%'), onCr.split('\n').filter(l => /progress/.test(l)).join(' | ').slice(0, 120));
}

/* ---- what the trim keeps and what it breaks -------------------------------
   From a review of an outside test plan (AB-TASK.md, "An outside test plan").
   Two of its four claims about this guard were checkable and they came out
   opposite ways: the error survives, the structure does not. Both are pinned
   here so a future change to the budget cannot quietly move either. */
{
  console.log('\n-- error integrity, and structure integrity');
  const post = (command, text) => guard('post', { session_id: 'ig', tool_use_id: 'toolu_ig_' + Math.random().toString(36).slice(2, 8),
    tool_name: 'Bash', tool_input: { command }, tool_response: bashResp(text) });
  const trimmedText = (r) => {
    if (r.status !== 0 || !r.stdout) return '';
    const o = JSON.parse(r.stdout).hookSpecificOutput;
    return (o && o.updatedToolOutput && o.updatedToolOutput.stdout) || '';
  };
  const noise = Array.from({ length: 200 }, (_, i) => `  ok   check number ${i} passed in this suite of many checks`).join('\n');
  const crash = [noise, '',
    "Error: Cannot find module 'express'",
    '    at Function.Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)',
    '    at Function.Module._load (node:internal/modules/cjs/loader:986:27)',
    '    at Module.require (node:internal/modules/cjs/loader:1233:19)',
    noise].join('\n');
  let r = post('node server.js', crash);
  let out = trimmedText(r);
  t('a stack trace buried in 400 lines of passing noise survives the trim',
    out.includes("Error: Cannot find module 'express'"), out.slice(0, 200));
  /* The kept frames come back line-numbered, as `L203:     at Function...`, because the trim reports
     where in the omitted region each flagged line was. A test written against a bare `    at ` would
     pass on a guard that dropped the numbering, so match the shape that actually ships. */
  t('and keeps its frames, which is what makes it actionable',
    (out.match(/L\d+: {5}at /g) || []).length >= 3, String((out.match(/L\d+: {5}at /g) || []).length));

  /* Head, tail and flagged lines with a gap between them is the right shape for a log and the
     wrong shape for a structured document: the fences survive because they sit at the ends, and
     what they enclose no longer parses. The guard does not claim to preserve structure and this
     test says so out loud rather than leaving it to be discovered in a session. */
  const big = { name: 'contexa', items: Array.from({ length: 120 }, (_, i) => ({ id: i, label: `item number ${i} with a reasonably long label to pad it` })) };
  const doc = 'Here is the config:\n```json\n' + JSON.stringify(big, null, 2) + '\n```\nDone.';
  r = post('node dump-config.js', doc);
  out = trimmedText(r);
  t('a fenced block over the threshold keeps both fences (they are head and tail)',
    (out.match(/```/g) || []).length === 2, String((out.match(/```/g) || []).length));
  const inner = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
  let parses = true; try { JSON.parse(inner); } catch { parses = false; }
  t('but the JSON it encloses no longer parses -- a known limit, not a regression', parses === false);

  /* The gap in the middle is marked, so a reader can tell a truncated document from a complete
     one. Without this the model has no way to know it is looking at a hole. */
  t('the omitted middle is marked rather than silently joined',
    /\[tokenbrake\] \d[\d,]* lines omitted here/.test(out),
    (out.split('\n').find(l => /omitted here/.test(l)) || out.slice(0, 120)));
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
  t('gaps between blocks are shown as one ellipsis line', (out.match(/\n  \u2026\n/g) || []).length === 2);   // the guard's own marker, still U+2026
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
  t('the report carries the price line', /At list price: ~ \$2\.38 \(claude-opus-5; cache writes at the 1h rate\)/.test(T.renderReport(T.parseTranscript(armB), [])));
  t('an unlisted model is reported as unpriced, not guessed', T.costOf(T.parseTranscript(odd)).usd === 0 && T.costOf(T.parseTranscript(odd)).unpriced.join() === 'claude-someday-9');
  const cmp = T.renderCompare(T.parseTranscript(armA), T.parseTranscript(armB), []);
  t('--compare: A and B named, cost row with the change', /A: arma0000\.\.\.  claude-opus-5/.test(cmp) && /B: armb0000\.\.\./.test(cmp) && /API cost, list price\s+\$2\.45\s+\$2\.38\s+-3%/.test(cmp), cmp.split('\n').find(l => /API cost/.test(l)));
  t('--compare: the rows the A/B rounds compared by hand', ['requests', 'cache-read tokens', 'output tokens', 'tool results entered', 'tool results carried', 'trimmed by the guard', 'repeat reads'].every(k => cmp.includes(k)));
  t('--compare: tool results entered halves, and the column says so', /tool results entered\s+2k\s+1k\s+-50%/.test(cmp), cmp.split('\n').find(l => /entered/.test(l)));
  const r = cli(['report', '--compare', 'arma0000', 'armb0000'], PROJ);
  t('cli: report --compare resolves session prefixes', r.status === 0 && /Change is B against A/.test(r.stdout), (r.stdout + r.stderr).slice(0, 200));
  const r2 = cli(['report', '--compare', 'arma0000'], PROJ);
  t('cli: one argument is a usage line, not a crash', r2.status === 0 && /Usage: tokenbrake report --compare/.test(r2.stdout));
  rmSync(dir, { recursive: true, force: true });
}

/* ---- 0.2.0 -- the plugin manifest and the marketplace ---------------------- */
{
  const plugin = JSON.parse(readFileSync('./.claude-plugin/plugin.json', 'utf8'));
  const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
  t('plugin: named tokenbrake, same version as the npm package', plugin.name === 'tokenbrake' && plugin.version === pkg.version);
  const hooks = JSON.parse(readFileSync('./hooks/hooks.json', 'utf8')).hooks;
  const post = hooks.PostToolUse && hooks.PostToolUse[0], pre = hooks.PreToolUse && hooks.PreToolUse[0];
  const fail = hooks.PostToolUseFailure && hooks.PostToolUseFailure[0];
  t('plugin: PostToolUse on every tool, PostToolUseFailure on the shells, PreToolUse on Read only', post && post.matcher === '*' && fail && fail.matcher === 'Bash|PowerShell' && pre && pre.matcher === 'Read');
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
  t('project install: PostToolUseFailure on the shells through the same guard',
    own.hooks.PostToolUseFailure[0].matcher === 'Bash|PowerShell' && hook('PostToolUseFailure').args[1] === 'post');
}

rmSync(CFG, { recursive: true, force: true });
console.log(fails.length ? '\nFAILED: ' + fails.join(', ') : '\nall tokenbrake checks passed');
process.exit(fails.length ? 1 : 0);
