import { createRequire } from 'node:module';
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
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

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

  /* A crafted session_id must not put path characters in the out/ filename: the first 8 chars are sanitized
     like the tool_use_id, so `../../..` can never escape out/ (before the fix, path.join would climb out). */
  const evil = guard('post', { session_id: '../../../etc/pwn', tool_use_id: 'toolu_01EVILEVILEVIL', tool_name: 'Bash',
    tool_input: { command: 'x' }, tool_response: bashResp(noisy) });
  const eu = parse(evil.stdout);
  const esaved = eu && eu.hookSpecificOutput && eu.hookSpecificOutput.updatedToolOutput
    && (String(eu.hookSpecificOutput.updatedToolOutput.stdout || '').match(/Full output saved to (\S+\.txt)/) || [])[1];
  const outDir = join(CFG, 'tokenbrake', 'out');
  t('a crafted session_id is sanitized in the saved path (cannot escape out/)',
    !!esaved && esaved.startsWith(outDir + sep) && /^[\w-]+\.txt$/.test(esaved.slice(outDir.length + 1)), esaved || 'no saved path');
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
  console.log('\n-- PostToolUse: MCP tool-output trimming (feature 1)');
  /* An mcp__* result arrives as a content-block array [{type:'text',text},…] (captured live on 2026-09-13
     from mcp__github__list_commits), not the Bash {stdout} object. The guard sees it in full before Claude
     Code's own "too large → saved to file + preview" step. mcpTrim is OFF by default and A/B'd before the
     default moves, so the config file turns it on for this block and is removed at the end. */
  const cfgFile = join(CFG, 'tokenbrake.json');
  const mcpResp = (text) => [{ type: 'text', text }];
  const toolName = 'mcp__github__list_commits';

  let r = guard('post', { session_id: 'mcp-0', tool_use_id: 'toolu_MCPOFF', tool_name: toolName,
    tool_input: {}, tool_response: mcpResp(noisy) });
  t('mcpTrim off by default: large MCP result is exit 0, no stdout (only logged)', r.status === 0 && r.stdout === '');
  {
    const led0 = readFileSync(join(CFG, 'tokenbrake', 'ledger.jsonl'), 'utf8').trim().split('\n').map(parse).filter(Boolean);
    const off = led0.filter(x => x.id === 'toolu_MCPOFF').pop();
    t('the untrimmed MCP row records the inner-text length, not the JSON wrapper (shares a basis with trimmed rows)',
      !!off && off.chars === noisy.length && off.kept === undefined, off && String(off.chars));
  }

  writeFileSync(cfgFile, JSON.stringify({ mcpTrim: true }));
  r = guard('post', { session_id: 'mcp-1', tool_use_id: 'toolu_MCPON', tool_name: toolName,
    tool_input: {}, tool_response: mcpResp(noisy) });
  t('mcpTrim on: exits 0', r.status === 0, `status=${r.status}`);
  const out = parse(r.stdout);
  const u = out && out.hookSpecificOutput && out.hookSpecificOutput.updatedToolOutput;
  t('emits PostToolUse updatedToolOutput', !!u && out.hookSpecificOutput.hookEventName === 'PostToolUse');
  /* The regression pin, MCP edition: the reply must be the content-block ARRAY the result arrived in, or
     Claude Code drops it silently and the whole result goes through untrimmed. */
  t('updatedToolOutput is a content-block array, not a string or bare object',
    Array.isArray(u) && u.length >= 1 && u[0].type === 'text' && typeof u[0].text === 'string');
  t('the trimmed text is much shorter and carries the tokenbrake marker',
    !!u && u[0].text.length < noisy.length / 3 && /\[tokenbrake\] \d+ lines omitted here/.test(u[0].text),
    u && `${noisy.length} -> ${u[0].text.length}`);
  t('head, tail and the seeded error lines survive the trim',
    !!u && u[0].text.startsWith('line 1 filler') &&
    /L150: ERROR: seeded failure alpha/.test(u[0].text) && /L301: Exception: seeded gamma/.test(u[0].text));
  const saved = u && (u[0].text.match(/Full output saved to (\S+\.txt)/) || [])[1];
  t('names the saved full-output file and it holds the full text', !!saved && existsSync(saved) && readFileSync(saved, 'utf8') === noisy);
  const led = readFileSync(join(CFG, 'tokenbrake', 'ledger.jsonl'), 'utf8').trim().split('\n').map(parse).filter(Boolean);
  const rec = led.filter(x => x.id === 'toolu_MCPON').pop();
  t('ledger row is marked mcp, with the MCP tool name, chars (inner text) and kept',
    !!rec && rec.mcp === true && rec.tool === toolName && rec.chars === noisy.length && rec.kept === u[0].text.length && rec.saved === saved);

  /* Shape coverage: a { content:[…] } wrapper rebuilds under .content and keeps the wrapper's other keys; a
     bare-string result trims to a string; a result with no text block (image only) has nothing to trim. */
  r = guard('post', { session_id: 'mcp-2', tool_use_id: 'toolu_MCPWRAP', tool_name: toolName,
    tool_input: {}, tool_response: { content: mcpResp(noisy), isError: false } });
  const w = parse(r.stdout).hookSpecificOutput.updatedToolOutput;
  t('a { content:[…] } wrapper is rebuilt in place, other keys preserved',
    w && !Array.isArray(w) && Array.isArray(w.content) && w.content[0].type === 'text' && w.isError === false && /\[tokenbrake\]/.test(w.content[0].text));
  r = guard('post', { session_id: 'mcp-3', tool_use_id: 'toolu_MCPSTR', tool_name: toolName,
    tool_input: {}, tool_response: noisy });
  const s2 = parse(r.stdout).hookSpecificOutput.updatedToolOutput;
  t('a bare-string MCP result trims to a string', typeof s2 === 'string' && /\[tokenbrake\]/.test(s2));
  r = guard('post', { session_id: 'mcp-4', tool_use_id: 'toolu_MCPIMG', tool_name: toolName,
    tool_input: {}, tool_response: [{ type: 'image', source: { data: 'x'.repeat(50000) } }] });
  t('an MCP result with no text block is left alone (exit 0, no stdout)', r.status === 0 && r.stdout === '');

  /* Composition with JSON-aware shaping (feature 5): a minified-JSON MCP body under mcpTrim + jsonShape keeps
     a sample of the big array and a count, not a broken char slice. */
  writeFileSync(cfgFile, JSON.stringify({ mcpTrim: true, jsonShape: true }));
  const bigArr = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ sha: 'c' + i, msg: 'commit number ' + i })));
  r = guard('post', { session_id: 'mcp-5', tool_use_id: 'toolu_MCPJSON', tool_name: toolName,
    tool_input: {}, tool_response: mcpResp(bigArr) });
  const j = parse(r.stdout).hookSpecificOutput.updatedToolOutput;
  t('mcpTrim + jsonShape keeps a JSON sample and a count, not a char slice',
    Array.isArray(j) && /showing the first 5 of 200 array items/.test(j[0].text) && j[0].text.length < bigArr.length,
    j && `${bigArr.length} -> ${j[0].text.length}`);

  rmSync(cfgFile, { force: true });
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
  /* Claude Code saves an oversized mcp__* result as tool-results/<id>.json; reading it whole is the same
     door back into context, so PERSISTED covers .json too -- the safety net for MCP when mcpTrim is off. */
  const ccJson = join(ccDir, 'mcp-result.json');
  writeFileSync(ccJson, body);
  r = guard('read-pre', { tool_name: 'Read', tool_input: { file_path: ccJson } });
  h = parse(r.stdout) && parse(r.stdout).hookSpecificOutput;
  t('an oversized MCP result saved as tool-results/<id>.json is capped like a persisted output',
    !!h && h.updatedInput.limit === 80 && /saved tool output/.test(h.additionalContext) && /500 lines/.test(h.additionalContext));
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
  /* `init` copies guard.js and nothing afterwards keeps the copy in step. The project copy is pinned by this
     suite; the user-scope copy had nothing watching it, so a guard.js change with no re-run leaves a machine
     running an older build while its ledger is read as evidence about the current one. */
  t('status says the installed guard matches this checkout', /guard build: matches this checkout/.test(r.stdout),
    (r.stdout.match(/[^\n]*guard build:[^\n]*/) || [])[0]);
  {
    const gf = join(CFG, 'hooks', 'tokenbrake', 'guard.js');
    const keep = readFileSync(gf, 'utf8');
    writeFileSync(gf, keep + '\n// drift\n');
    const drifted = cli(['status']);
    t('status calls a stale installed guard stale, and says what it costs',
      /guard build: STALE/.test(drifted.stdout) && /records an older guard/.test(drifted.stdout),
      (drifted.stdout.match(/[^\n]*guard build:[^\n]*/) || [])[0]);
    /* A CRLF working-tree copy (Windows core.autocrlf=true, the default) is the same code as the LF blob/tarball,
       byte-different only in line endings. The staleness check must treat it as matching, or every Windows dev
       checkout false-alarms -- the platform tokenbrake ships to. Pre-fix this hashed raw bytes and cried STALE. */
    const crlf = keep.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
    writeFileSync(gf, crlf);
    const eol = cli(['status']);
    t('status treats a CRLF copy of the same code as matching, not stale (Windows autocrlf)',
      /guard build: matches this checkout/.test(eol.stdout) && !/STALE/.test(eol.stdout),
      (eol.stdout.match(/[^\n]*guard build:[^\n]*/) || [])[0]);
    writeFileSync(gf, keep);
  }
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
  r = run(['--reach']);
  t('cli: --reach pools sessions and reports the share of carried tokens the trim can act on',
    /Where the trim can reach/.test(r.stdout) && /W = [\d.]+% of carried tokens/.test(r.stdout),
    (r.stdout.match(/[^\n]*W = [^\n]*/) || [])[0]);
  t('cli: --reach names the tools from the guard\'s own sessions, not from every session',
    /Only the \d+ session\(s\) the guard was recording in|No session had the guard/.test(r.stdout),
    (r.stdout.match(/[^\n]*session\(s\) the guard was recording in, since[^\n]*/) || [])[0]);
  t('cli: --reach separates sessions the guard ran in from sessions it did not',
    /the guard was recording in \d+/.test(r.stdout),
    (r.stdout.match(/[^\n]*guard was recording in[^\n]*/) || [])[0]);
  t('cli: --reach measures the verdict over the sessions the guard was running in',
    /measured over the sessions the guard was actually running in/.test(r.stdout));
  t('cli: --reach refuses a verdict on a thin pool rather than printing a number that looks like one',
    /NO VERDICT, and the number above is not one/.test(r.stdout));
  /* A transcript read away from the machine it ran on -- teleported, copied out of a cloud container, or read
     after the container was reclaimed -- arrives with no ledger beside it. Before the fallback it was filed as a
     session the guard was absent from, which is the pooling mistake one level down. Its own trim markers settle
     it, in one direction only. */
  {
    const dir = join(cfg, 'projects', '-c-work-moved');
    mkdirSync(dir, { recursive: true });
    const at = new Date(T0 + 60000).toISOString();
    writeFileSync(join(dir, 'movedsess.jsonl'), [
      JSON.stringify({ type: 'assistant', uuid: 'm1', requestId: 'm1', cwd: 'C:\\work\\moved', timestamp: at,
        message: { model: 'm', usage: { input_tokens: 1, output_tokens: 1 },
          content: [{ type: 'tool_use', id: 'tm1', name: 'Bash', input: { command: 'npm test' } }] } }),
      JSON.stringify({ type: 'user', cwd: 'C:\\work\\moved', timestamp: at,
        message: { content: [{ type: 'tool_result', tool_use_id: 'tm1',
          content: 'head\n\n[tokenbrake] 400 lines omitted here (12,000 chars total).\n\ntail' }] } }),
    ].join('\n') + '\n');
    const rm = run(['--reach']);
    t('cli: --reach counts a session whose only proof is its own trim marker',
      /1 of those from a trim marker in the transcript rather than a ledger row/.test(rm.stdout),
      (rm.stdout.match(/[^\n]*trim marker in the transcript[^\n]*/) || [])[0]);
    t('cli: --reach says the marker route is a lower bound, not a count',
      /LOWER BOUND -- a session the guard ran in and never trimmed carries no marker/.test(rm.stdout));
    const ra = run(['--all']);
    t('cli: --all marks a moved session as one the guard ran in, and says what that rests on',
      /movedses\.\.\..*carried\s+guard\s/.test(ra.stdout)
      && /1 session\(s\) here rest on the marker alone, which is a LOWER BOUND/.test(ra.stdout),
      (ra.stdout.match(/ +movedses[^\n]*/) || [])[0]);
    rmSync(dir, { recursive: true, force: true });
  }
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
  t('cli: --reads states the trigger\'s floor for shell reads even when no row trips it',
    /effective trigger is never lower than maxChars \(6,000\)/.test(r.stdout)
    && /guard\.js:272/.test(r.stdout) && /are shell reads \(a cat\)/.test(r.stdout),
    (r.stdout.match(/[^\n]*Floor:[^\n]*/) || [])[0]);
  t('cli: --reads keeps the miss rate out of the grid and labels it as the other population',
    /DIFFERENT population from the whole-file reads/.test(r.stdout));
  t('cli: --reads reports depth as a share of the file, which is the shape question',
    /How deep the targets sit/.test(r.stdout) && /fraction of file/.test(r.stdout));
  r = run(['--caps', '--session=nope']);
  t('cli: --caps with an unknown session prefix says so', /No session in the ledger starts with "nope"/.test(r.stdout));
  r = run(['--ledger']);
  /* A guard installed at both user and project scope fires twice for one event, because Claude Code adds
     hooks across scopes rather than choosing one. Every count in --ledger would then read double on the
     repository where the two overlap. */
  writeLedger([capRow,
    { t: 5000, ev: 'post', session: 'dup', tool: 'Bash', chars: 9000, kept: 1200, id: 'tu-dup', what: 'npm test' },
    { t: 5040, ev: 'post', session: 'dup', tool: 'Bash', chars: 9000, kept: 1200, id: 'tu-dup', what: 'npm test' }]);
  r = run(['--ledger', '--all']);
  const trimmedCount = (out) => Number((out.match(/Trimmed by tokenbrake: (\d+) shell/) || [])[1]);
  const withDup = trimmedCount(r.stdout);
  writeLedger([capRow, { t: 5000, ev: 'post', session: 'dup', tool: 'Bash', chars: 9000, kept: 1200, id: 'tu-dup', what: 'npm test' }]);
  const single = trimmedCount(run(['--ledger', '--all']).stdout);
  t('cli: --ledger counts one event once when two installs logged it twice',
    /1 duplicate row\(s\) dropped/.test(r.stdout) && withDup === single,
    'two rows -> ' + withDup + ' trimmed; one row -> ' + single);
  writeLedger([capRow]);
  t('cli: --ledger counts the two Read-cap halves apart',
    /Read caps fired: 1 -- 1 on a large source file \(readLimitLines\), 0 on a shell cat of one/.test(r.stdout)
    && !/Large reads capped/.test(r.stdout), r.stdout.split('\n').filter(l => /Read caps/.test(l)).join(' | '));
  /* --all listed the newest 30 under a header that said 65 and said nothing about the 35 it dropped; a
     conclusion about which sessions exist was drawn from the visible part within the hour of it being read.
     And the question those lines are read for -- which sessions may a claim about ordinary work rest on --
     needs the ledger, which the line never carried. */
  r = run(['--all']);
  t('cli: --all marks the sessions the guard was recording in',
    /realsess\.\.\..*carried\s+guard\s/.test(r.stdout), (r.stdout.match(/ +realsess[^\n]*/) || [])[0]);
  const benchLine = (r.stdout.match(/ +benchses[^\n]*/) || [''])[0];
  t('cli: --all leaves the column blank where it was not, rather than calling it off',
    !/guard/.test(benchLine) && /carried\s+bench\s/.test(benchLine), benchLine);
  t('cli: --all tags the benchmark cwd the other views skip', /bench\s+C:.Desktop.tokenbrake-bench/.test(r.stdout), benchLine);
  r = run(['--all', '--top=1']);
  t('cli: --all stops truncating silently and says how to see the rest',
    /Sessions, newest first \(3, newest 1 shown\)/.test(r.stdout)
    && /2 older session\(s\) not listed -- add --top=3 for every one/.test(r.stdout),
    (r.stdout.match(/[^\n]*not listed[^\n]*/) || [])[0]);
  /* The counts are the point of the block and they are taken over every session, not the printed ones: a
     count whose population is smaller than the header says is the defect one line above. */
  t('cli: --all counts over every session, not the ones it printed',
    /Of 3 readable session\(s\): 1 benchmark, 2 with guard records, 2 with guard records outside the benchmark/.test(r.stdout),
    (r.stdout.match(/[^\n]*readable session[^\n]*/) || [])[0]);
  t('cli: --all says the count is still not eligibility, because an A/B arm looks like ordinary work',
    /not a count of eligible sessions/.test(r.stdout) && /A.B arm is ordinary work by its cwd/.test(r.stdout));
  {
    const p1 = T.parseTranscript(join(cfg, 'projects', '-c-work-realrepo', 'realsess.jsonl'));
    const bare = T.renderSummaryLine(p1);
    t('renderSummaryLine adds no columns when the caller established nothing',
      !/guard/.test(bare) && /carried\s+C:.work.realrepo$/.test(bare), bare);
    t('and carries both columns before the cwd when it did',
      /carried\s+guard\s+bench\s+C:.work.realrepo$/.test(T.renderSummaryLine(p1, { guard: true, tag: 'bench' })),
      T.renderSummaryLine(p1, { guard: true, tag: 'bench' }));
  }
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
  for (const argv of [[], ['--where'], ['--caps'], ['--reads'], ['--reach'], ['--ledger'], ['--all']]) {
    const o = run(argv);
    t('cli: report ' + (argv.join(' ') || '(default)') + ' prints ASCII only', nonAscii(o.stdout).length === 0,
      nonAscii(o.stdout).slice(0, 2).join(' | '));
  }
  rmSync(join(cfg, 'projects'), { recursive: true, force: true });
  r = run([]);
  t('cli: no transcript falls back to the ledger with a note', /showing the ledger alone/.test(r.stdout) && /Trimmed by tokenbrake/.test(r.stdout));
  rmSync(cfg, { recursive: true, force: true });
  r = spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), 'report'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: join(tmpdir(), 'tokenbrake-none-' + Date.now()) } });
  t('cli: nothing at all says what to do', /No Claude Code session transcripts found/.test(r.stdout) && /nothing needs installing/.test(r.stdout));

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
  const EXCERPT_CORPUS = ['cat extension/content.js', 'cat -n build.mjs', 'head -200 worker/src/index.js', 'tail -n 120 worker/test.mjs', "sed -n 1500,2011p extension/content.js", 'sed -n "1,400p" a.js',
    /* Quoted, a glob character is an ordinary filename character -- the shell expands nothing inside quotes
       -- so this is one file and keeps the exemption, unlike the unquoted `cat *.log` below. And a grep that
       counts or inverts still prints one file's contents. */
    "cat '*.log'", 'grep -c foo a.txt', 'grep -v foo a.txt', '  cat a.txt  ',
    /* Bracketed route segments are ordinary paths, not globs, and models almost never quote them. Excluding
       `[`/`]` from the file slot cost every Next.js App Router, SvelteKit and Expo Router source file its
       exemption and shredded it to head/tail/error lines instead -- a far more common and worse outcome
       than letting a rare `cat [ab].log` through. Only `*` and `?` mark "possibly many files". */
    'cat app/[id]/page.tsx', 'cat src/routes/[slug]/+page.svelte', 'cat pages/[...slug].js'];
  for (const c of EXCERPT_CORPUS) {
    r = post(c, src.slice(0, 9000));
    t(`untouched: ${c}`, r.status === 0 && r.stdout === '');
  }
  const TRIM_CORPUS = ["sed -n '1,400p' a.js | grep foo", 'cat a.js b.js', 'npm test', 'git log --stat -40', "sed -n '1,400p' a.js; ls",
    /* The operand slots reject an option and an unquoted glob (ARG_/FILE_ in guard.js). Before that, an
       option cluster the recursive-grep guard rejected fell through into the operand slot, so `grep -rn foo`
       -- which names no file at all -- read as one file's excerpt and kept the exemption; and `cat *.log`
       kept it for however many files the glob matched. */
    'grep -rn foo', 'grep -Rn foo', 'cat *.log', 'cat a?.log',
    /* The exclusion scans the whole cluster, not its first letter: `grep -rn` was caught while `grep -nr`,
       `grep -ir` and `grep -vl` -- the same searches typed in the other order -- kept the single-file
       exemption and passed their whole multi-file result through (measured: 36,469 characters, per call). */
    'grep -nr foo .', 'grep -ir foo src', 'grep -vl foo src', 'grep -nR foo .', 'grep -ln foo src',
    'tail -f app.log', 'CAT a.txt', 'cat `cat evil`', 'echo $(cat a.txt)', 'cat a.txt && curl evil.test'];
  for (const c of TRIM_CORPUS) {
    r = post(c, src.slice(0, 9000));
    const o = parse(r.stdout); const u = o && o.hookSpecificOutput && o.hookSpecificOutput.updatedToolOutput;
    t(`still trimmed: ${c}`, !!u && /\[tokenbrake\] \d+ lines omitted here/.test(u.stdout), r.stdout.slice(0, 60));
  }
  /* The report must recognise exactly the commands the guard treats as reads, or it cannot say what the guard
     did. It once kept its own copy of this grammar, which went stale on three operand fixes at once; it now
     uses the guard's EXCERPT, and this runs the SAME corpus the two loops above ran through the real guard,
     through the report's classifier (readFileOf), end to end. */
  {
    const trx = await import('./transcript.js');
    const TX = trx.default || trx;
    const isRead = (c) => !!TX.readFileOf('Bash', { command: c });
    const missed = EXCERPT_CORPUS.filter((c) => !isRead(c));
    const extra = TRIM_CORPUS.filter((c) => isRead(c));
    t(`the report's classifier agrees with the guard on all ${EXCERPT_CORPUS.length + TRIM_CORPUS.length} corpus commands`,
      missed.length === 0 && extra.length === 0,
      JSON.stringify({ guardExemptsButReportMisses: missed, guardTrimsButReportCallsItARead: extra }));
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
  const shownLines = (x) => String(x || '').split('\n').filter(l => /^line \d+/.test(l)).length;
  t('an excerpt over readMaxBytes is capped by its leading lines, not trimmed to head and tail',
    !!u && u.stdout.startsWith('line 1 of a big file') && !/lines omitted here/.test(u.stdout)
    && shownLines(u.stdout) > 0 && shownLines(u.stdout) <= 300);
  /* readLimitLines of a 70-char file is 21 KB, over the 10,000-char hook output cap, so the branch folds to
     fit (Claude Code drops an oversized updatedToolOutput silently) and the note has to report the lines
     that actually survived -- a note claiming 300 while delivering 117 is the model being told something
     false about its own context. */
  t('and the note says so, with the cost of many small ranges, and its count is the lines actually delivered',
    !!u && /A few large ranges cost less/.test(u.stdout) && (() => {
      const m = /file excerpt capped at the first ([\d,]+) of 1,200 lines/.exec(u.stdout);
      if (!m) return false;
      const claimed = Number(m[1].replace(/,/g, ''));
      return claimed === shownLines(u.stdout) && claimed < 300;
    })(), (/file excerpt capped at the first [\d,]+ of [\d,]+ lines/.exec(u ? u.stdout : '') || [''])[0]);
  /* And when readLimitLines of them DO fit the cap, readLimitLines is still what governs: same oversized
     file, narrow lines. 3,000 x 24 chars is 72 KB (over readMaxBytes), of which 300 lines is 7.2 KB. */
  const narrow = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`.padEnd(23, '.')).join('\n');
  const un = (parse(post("sed -n '1,3000p' narrow.js", narrow).stdout) || {}).hookSpecificOutput.updatedToolOutput;
  /* Output with few lines is where a lines-only note lies: a minified bundle read whole is ONE line, the
     fold cuts it mid-line, and "the first 1 of 1 lines" tells the model the whole file is present while
     most of it is gone -- with saved:null, gone with no copy to go back to. Characters move whenever
     anything is withheld. */
  const bundle = 'x'.repeat(100000);
  const ub = (parse(post('cat bundle.min.js', bundle).stdout) || {}).hookSpecificOutput.updatedToolOutput;
  t('a single-line excerpt reports the characters withheld, not just an unchanged line count', (() => {
    if (!ub) return false;
    const m = /capped at the first ([\d,]+) of ([\d,]+) lines, ([\d,]+) of ([\d,]+) characters/.exec(ub.stdout);
    if (!m) return false;
    const num = (x) => Number(x.replace(/,/g, ''));
    return num(m[1]) === 1 && num(m[2]) === 1          // the line count genuinely cannot move here
      && num(m[3]) < num(m[4]) && num(m[4]) === bundle.length   // and the character count does
      && ub.stdout.length < 10000;
  })(), (/capped at the first [^.]*\./.exec(ub ? ub.stdout : '') || [''])[0]);

  /* And the line-boundary snap must not eat the excerpt. A minified bundle behind a one-line
     `//# sourceMappingURL` header, or a lockfile behind its opening `{`, puts the last newline near the
     START of the kept body -- snapping back to it delivered 34 characters of 200,035, and 1 of 150,002,
     on exactly the huge single-line files this branch most often sees. */
  for (const [label, body] of [
    ['a sourceMappingURL header then one 200k line', '//# sourceMappingURL=bundle.js.map\n' + 'x'.repeat(200000)],
    ['an opening brace then one 150k line', '{\n' + 'y'.repeat(150000)],
  ]) {
    const uu = (parse(post('cat bundle.min.js', body).stdout) || {}).hookSpecificOutput.updatedToolOutput;
    const m = uu && /capped at the first [\d,]+ of [\d,]+ lines, ([\d,]+) of ([\d,]+) characters/.exec(uu.stdout);
    t(`the line snap does not collapse the excerpt: ${label}`,
      !!m && Number(m[1].replace(/,/g, '')) > 2000 && uu.stdout.length < 10000,
      m ? m[0] : '(no excerpt note)');
  }

  t('an excerpt whose readLimitLines lines fit the cap keeps all 300 of them, and says 300',
    !!un && shownLines(un.stdout) === 300 && /file excerpt capped at the first 300 of 3,000 lines/.test(un.stdout),
    (/file excerpt capped at the first [\d,]+ of [\d,]+ lines/.exec(un ? un.stdout : '') || [''])[0]);
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
  t('the report carries the line with the share of all carried', /Small shell output, at or under the threshold \(excerpts and failures included\): 2 of 3 shell results/.test(text) && /% of all carried\)/.test(text), text.split('\n').find(l => /Small shell output/.test(l)));

  /* Item 1: `report` is the product, run before anything is installed. Two things it must get right there.
     A single-file excerpt goes down the guard's read path, so it is never in the trim's window and never the
     result the report says the guard "would have trimmed". And a session without the guard gets the question
     that person is asking -- is there anything here for the brake? -- not "Acted on: 0". */
  {
    const mk = (results) => ({ sessionId: 'fresh', cwd: '/w', requests: Array.from({ length: 6 }, () => ({})), compactions: [], results });
    const R = (id, name, chars, extra) => ({ id, name, what: 'cmd ' + id, chars, tokens: Math.round(chars / 4), carried: Math.round(chars / 4) * 5,
      carriedTurns: 5, afterReq: 0, isError: false, marker: false, file: null, ...(extra || {}) });
    const excerptOnly = mk([R('e1', 'Bash', 16000, { what: "sed -n '1,400p' big.js", file: 'big.js', excerpt: true }), R('o1', 'Agent', 400)]);
    const rc = T.reach(excerptOnly, []);
    t('a single-file excerpt is its own bucket, never in the trim window',
      rc.excerpt.n === 1 && rc.window.n === 0 && !T.inTrimWindow(excerptOnly.results[0], 6000), JSON.stringify({ w: rc.window, e: rc.excerpt }));
    const tx = T.renderReport(excerptOnly, []);
    t('and the report never names an excerpt as a result the guard would have trimmed',
      !/would have trimmed/.test(tx) && /single-file excerpts \(read like a Read: capped over readMaxBytes, never head\/tail-trimmed\)/.test(tx), tx.split('\n').find(l => /brakes on|excerpts/.test(l)));
    /* guardRan finds the guard by a ledger row or a trim marker, and a session it ran in can leave neither -- so
       the line reports what was seen, not a verdict on the install. */
    t('a session with no sign of the guard, with little in reach, says so instead of "Acted on: 0"',
      /No sign of tokenbrake in this session \(no ledger row, no trim marker\), and 0% of what it carried is in the brake's reach -- too little/.test(tx) && !/Acted on:/.test(tx),
      tx.split('\n').find(l => /No sign|Acted on/.test(l)));
    const dumps = mk([R('d1', 'Bash', 20000, { what: 'node tools/dump.js' }), R('o1', 'Agent', 400)]);
    const td = T.renderReport(dumps, []);
    t('a session with no sign of the guard, with plenty in reach, says what the brake could have acted on and how to install it',
      /No sign of tokenbrake in this session \(no ledger row, no trim marker\)\. The brake could have acted on 1 result, \d+% of what it carried -- if it is not installed, `npx tokenbrake init` installs it\./.test(td)
      && !/Still within reach/.test(td), td.split('\n').find(l => /No sign/.test(l)));
    t('and its advice line names the result in the window',
      /One result to have brakes on: Bash "node tools\/dump\.js"/.test(td), td.split('\n').find(l => /brakes on/.test(l)));
    t('the report takes the person\'s own maxChars, not the shipped default',
      T.reach(dumps, [], { maxChars: 25000 }).window.n === 0 && /over 6k tokens/.test(T.renderReport(dumps, [], { maxChars: 25000 })));
    /* The guard's toolConfig merges tools.<tool>.maxChars over the top level; a report that ignored it would
       call a result under that value one the guard "would have trimmed". */
    t('a per-tool maxChars is honoured the way the guard applies it',
      T.reach(dumps, [], { maxChars: 6000, toolMaxChars: { Bash: 25000 } }).window.n === 0
      && T.reach(dumps, [], { maxChars: 6000, toolMaxChars: { PowerShell: 25000 } }).window.n === 1
      && !/brakes on/.test(T.renderReport(dumps, [], { maxChars: 6000, toolMaxChars: { Bash: 25000 } })));
    /* An excerpt over readMaxBytes is capped by the guard and carries a marker -- the Read cap acting, not the
       trim -- so even when it is in the trimmed set it stays an excerpt. */
    t('an excerpt the guard capped stays an excerpt, not a trim the guard acted on',
      (() => { const r = T.reach(excerptOnly, [excerptOnly.results[0]]); return r.excerpt.n === 1 && r.acted.n === 0 && r.window.n === 0; })());
    t('reach counts shell results itself, excerpts included, so no caller has to sum buckets',
      T.reach(excerptOnly, []).shell.n === 1 && T.reach(dumps, []).shell.n === 1);
  }

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

  console.log('\n-- where the trim can reach, and which tools put it there');
  /* Round 2's pilot abandoned its schedule because the guard rewrote nothing the model saw: handed a CLI that
     could slice a log, the agent sliced. Round 1's workspace had only dumping tools and the mechanism was
     there. So the reach may be a property of the TOOLING, and the unit that answers it is the program a
     command invoked -- not the command string, which would give one row per invocation and answer nothing. */
  t('an interpreter is not a tool: the script it runs is',
    T.commandTool('node tools/ci.js log r-8814') === 'node tools/ci.js'
    && T.commandTool('FOO=1 node scripts/x.mjs --v') === 'node scripts/x.mjs');
  t('the same tool making different demands groups as one tool',
    T.commandTool("cd /w && node tools/ci.js summary r-1") === T.commandTool('node tools/ci.js log r-2'));
  t('a pipeline is credited to the stage that produced the bytes',
    T.commandTool('cat big.txt | head -50') === 'cat');
  t('a bare program is itself', T.commandTool('npm test') === 'npm' && T.commandTool('git log --stat -40') === 'git');

  const mkRes = (name, what, chars, carried, extra) => ({ name, what, chars, tokens: Math.round(chars / 4),
    carried, isError: false, marker: false, ...(extra || {}) });
  const sess = {
    parsed: { cwd: '/w', sessionId: 'rs', requests: [{}], compactions: [], results: [
      mkRes('Bash', 'node tools/dump.js', 20000, 40000),        // in the window
      mkRes('Bash', 'node tools/dump.js', 9000, 18000),         // in the window
      mkRes('Bash', 'node tools/ci.js summary r-1', 800, 1600), // under the threshold
      mkRes('Read', '/w/a.js', 5000, 10000),                    // not shell
    ] },
    trimmed: [],
  };
  const rp = T.reachPooled([sess]);
  t('the window is shell, over the threshold and under the host ceiling',
    rp.window.n === 2 && rp.under.n === 1 && rp.nonShell.n === 1, JSON.stringify({ w: rp.window.n, u: rp.under.n, ns: rp.nonShell.n }));
  /* The share is of CARRIED tokens and not of results, because a result costs its size times the later
     requests that re-read it -- counting results answers a different question from the one about the bill. */
  t('the share reported is of carried tokens, not of results',
    Math.abs(rp.windowShareOfCarried - 58000 / 69600) < 1e-6, String(rp.windowShareOfCarried));
  t('the tools that reached the trim are named, heaviest first',
    rp.tools[0].tool === 'node tools/dump.js' && rp.tools[0].n === 2, JSON.stringify(rp.tools));
  t('a tool whose output never reached the trim is not in the list',
    !rp.tools.some(x => /ci\.js/.test(x.tool)));
  /* A trimmed result now measures under the threshold, so classifying by size alone would put every success
     in the wrong bucket and leave the window empty. It is in the window by proof. */
  const trimmedRes = mkRes('Bash', 'node tools/dump.js', 900, 1800, { marker: true, id: 'tu1' });
  const sess2 = { parsed: { cwd: '/w', sessionId: 'rs2', requests: [{}], compactions: [], results: [trimmedRes] },
    trimmed: [trimmedRes] };
  t('a result the guard rewrote counts as in-window by proof, not by its post-trim size',
    T.reachPooled([sess2]).window.n === 1 && T.reachPooled([sess2]).acted.n === 1);
  /* "Was the guard running here" came only from the ledger, which lives beside the transcript and does not
     travel with it: a session read away from the machine it ran on would be filed as one the guard was absent
     from -- the same mistake as pooling sessions it never ran in, one level down. The transcript proves it
     itself, in one direction: a trim the model received carries the marker. */
  {
    const withMark = { sessionId: 's1', results: [{ marker: true }, { marker: false }] };
    const noMark = { sessionId: 's1', results: [{ marker: false }] };
    const led = [{ ev: 'post', session: 's1' }];
    t('the ledger settles it when it has rows for the session',
      T.guardRan(noMark, led, 's1').ran === true && T.guardRan(noMark, led, 's1').via === 'ledger');
    t('with no ledger row, a trim marker in the transcript settles it instead',
      T.guardRan(withMark, [], 's1').ran === true && T.guardRan(withMark, [], 's1').via === 'marker');
    t('neither is not a yes: a session with no rows and no marker stays out',
      T.guardRan(noMark, [], 's1').ran === false && T.guardRan(noMark, [], 's1').via === null);
    t('a ledger row for a DIFFERENT session does not establish this one',
      T.guardRan(noMark, [{ ev: 'post', session: 'other' }], 's1').ran === false);
    /* The direction that matters: the fallback can only add sessions. A session the guard ran in and trimmed
       nothing carries no marker, so the marker route is a lower bound and every caller has to say so. */
    t('the marker route is a lower bound -- ran and trimmed nothing reads as a blank',
      T.guardRan({ sessionId: 's2', results: [{ marker: false }, { marker: false }] }, [], 's2').ran === false);
  }

  /* ---- the other side of the same table: what sits BEYOND the reach ---------
     `reach` filed everything non-shell into one bucket and stopped, and on real sessions that bucket was
     41% of carried tokens -- the second largest thing in the report, unnamed. It is almost entirely Read,
     which the PostToolUse handler never touches (every branch is gated on shell/mcp), so the only lever is
     the PreToolUse cap -- eligible for a ranged read never, and for a whole read only over readMaxBytes.
     This lives in `reachPooled`'s own per-result loop rather than in a second pooling function, for the
     reason the comment above `trimmedResults` gives: one rule, not a second quietly different one. */
  {
    const mk = (name, extra) => ({ name, chars: 4000, tokens: 1000, carried: 10000, isError: false,
      marker: false, ...(extra || {}) });
    const results = [
      mk('Bash', { what: 'node tools/dump.js', chars: 20000, carried: 50000 }),   // shell: the other side
      mk('Read', { id: 'ranged', file: '/w/a.js', whole: false, carried: 7000 }),
      mk('Read', { id: 'small', file: '/w/b.js', whole: true, carried: 3000 }),
      mk('Read', { id: 'big', file: '/w/c.js', whole: true, carried: 5000 }),
      mk('Read', { id: 'nosize', file: '/w/d.js', whole: true, carried: 1000 }),
      mk('Agent', { id: 'ag', carried: 2000 }),
    ];
    const sizes = new Map([['small', 10000], ['big', 90000]]);   // 'nosize' deliberately absent
    const sess = { parsed: { cwd: '/w', sessionId: 'br', requests: [{}], compactions: [], results }, trimmed: [], sizes };
    const b = T.reachPooled([sess], { readMaxBytes: 60000 });

    t('the out-of-reach bucket is broken out by tool, heaviest first',
      b.nonShellTools[0].tool === 'Read' && b.nonShellTools[0].n === 4 && b.nonShellTools[0].carried === 16000
      && b.nonShellTools[1].tool === 'Agent', JSON.stringify(b.nonShellTools));
    t('a shell result is on the other side of the table, not in the by-tool list',
      !b.nonShellTools.some(x => x.tool === 'Bash') && b.tools[0].tool === 'node tools/dump.js',
      JSON.stringify({ ns: b.nonShellTools.map(x => x.tool), s: b.tools.map(x => x.tool) }));
    /* Computed in the same pass that produces the bucket, so this holds by construction rather than by two
       classifications agreeing. It is a guard against a later edit adding a skip to one branch and not the
       other -- it does NOT prove the per-tool split itself, which the rows above check. */
    t('the by-tool rows sum to the nonShell bucket they expand',
      b.nonShellTools.reduce((s, x) => s + x.carried, 0) === b.nonShell.carried,
      JSON.stringify({ rows: b.nonShellTools.reduce((s, x) => s + x.carried, 0), bucket: b.nonShell.carried }));

    t('a ranged read is its own line -- the cap leaves it alone by design (0.2.3)',
      b.read.ranged.n === 1 && b.read.ranged.carried === 7000, JSON.stringify(b.read.ranged));
    t('a whole read at or under the trigger is not the cap\'s either',
      b.read.under.n === 1 && b.read.under.carried === 3000, JSON.stringify(b.read.under));
    t('only a whole read OVER the trigger is a read the cap can act on',
      b.read.over.n === 1 && b.read.over.carried === 5000, JSON.stringify(b.read.over));
    /* The mistake unboundedReads documents at length is sizing a read by the cap's own output. A read no
       ledger row and no line numbering could size is reported apart, never dropped into a bucket. */
    t('a whole read with no size is reported as unsized, not guessed into a bucket',
      b.read.unsized.n === 1 && b.read.unsized.carried === 1000
      && b.read.ranged.n + b.read.over.n + b.read.under.n + b.read.unsized.n === b.read.all.n,
      JSON.stringify(b.read.unsized));
    /* The trigger is a live config value, not a constant: the same reads answer differently under it. */
    t('the split moves with readMaxBytes, because the cap does',
      T.reachPooled([sess], { readMaxBytes: 5000 }).read.over.n === 2
      && T.reachPooled([sess], { readMaxBytes: 1e9 }).read.over.n === 0);
    t('an explicit 0 is a real threshold, not an absent one -- the guard takes it literally',
      T.reachPooled([sess], { readMaxBytes: 0 }).readTrigger === 0
      && T.reachPooled([sess], { readMaxBytes: 0 }).read.over.n === 2);
    t('with no trigger given, nothing is filed as over or under -- an absent knob is not a threshold of zero',
      (() => { const nb = T.reachPooled([sess]);
        return nb.read.over.n === 0 && nb.read.under.n === 0 && nb.read.unsized.n === 3 && nb.readTrigger === null; })());
    /* Same precedence as reach: the rewrite is tested FIRST, so a trimmed non-shell result is acted-on and
       must not also appear beyond reach, or the rows stop summing to the bucket. */
    t('a rewritten non-shell result is acted-on, so it is not counted beyond reach as well',
      (() => {
        const mcp = mk('mcp__x__y', { id: 'm1', carried: 4000, marker: true });
        const s2 = { parsed: { cwd: '/w', sessionId: 'br2', requests: [{}], compactions: [], results: [mcp] }, trimmed: [mcp] };
        const p2 = T.reachPooled([s2], { readMaxBytes: 60000 });
        return p2.nonShellTools.length === 0 && p2.acted.n === 1;
      })());
    t('a Read result with no file path is counted by tool but not split -- there is no read to size',
      (() => {
        const noFile = mk('Read', { id: 'nf', carried: 800 });
        const s3 = { parsed: { cwd: '/w', sessionId: 'br3', requests: [{}], compactions: [], results: [noFile] }, trimmed: [] };
        const r3 = T.reachPooled([s3], { readMaxBytes: 60000 });
        return r3.nonShellTools[0].tool === 'Read' && r3.read.all.n === 0;
      })());
    t('a session with no sizes map at all reports its whole reads as unsized, not as under the trigger',
      (() => {
        const s4 = { parsed: { cwd: '/w', sessionId: 'br4', requests: [{}], compactions: [], results },
          trimmed: [] };   // no `sizes`
        const r4 = T.reachPooled([s4], { readMaxBytes: 60000 });
        return r4.read.unsized.n === 3 && r4.read.under.n === 0 && r4.read.over.n === 0;
      })());
  }

  /* The sizes map above is keyed by result id, so unboundedReads has to carry one. A row it reconstructs
     from a ledger cap has no tool result behind it and carries null, which a caller keying by id skips. */
  t('unboundedReads rows carry the result id the sizes map is keyed by',
    (() => {
      const p = { cwd: '/w', sessionId: 'ub', results: [
        { id: 'w1', name: 'Read', file: '/w/a.js', whole: true, chars: 900, lines: 9, shape: null, isError: false }] };
      const rows = T.unboundedReads(p, [], { sessionId: 'ub' }).reads;
      return rows.length === 1 && rows[0].id === 'w1';
    })());

  /* A read the cap already acted on can sit in the transcript as the guard's REWRITTEN input -- ranged, no
     offset. Counting it as "ranged" shrinks the cap's own share, the comparison the split exists to show. */
  {
    const cap = [{ t: 1, ev: 'read-cap', session: 'rw', tool: 'Read', what: '/w/big.js', bytes: 90000, lines: 2000, limit: 300, persisted: false }];
    const res = [
      { id: 'rw1', name: 'Read', file: '/w/big.js', whole: false, readFrom: null, chars: 9000, lines: 300, shape: null, isError: false,
        tokens: 2250, carried: 6000, marker: false },
      { id: 'rw2', name: 'Read', file: '/w/big.js', whole: false, readFrom: 400, chars: 900, lines: 30, shape: null, isError: false,
        tokens: 225, carried: 500, marker: false }];
    const p = { cwd: '/w', sessionId: 'rw', requests: [{}], compactions: [], results: res };
    const rows = T.unboundedReads(p, cap, { sessionId: 'rw' }).reads;
    t('a cap row recorded as the rewritten input is tied to the ranged read the rewrite produced',
      rows.length === 1 && rows[0].id === 'rw1' && rows[0].bytes === 90000, JSON.stringify(rows));
    const sizes = new Map(rows.filter(r => r.id != null && !r.ceiling).map(r => [r.id, r.bytes]));
    const b = T.reachPooled([{ parsed: p, trimmed: [], sizes }], { readMaxBytes: 60000 });
    t("and the split files it as the cap's own share, leaving the model's own ranged read as ranged",
      b.read.over.n === 1 && b.read.over.carried === 6000 && b.read.ranged.n === 1 && b.read.ranged.carried === 500,
      JSON.stringify(b.read));
  }
  /* A null or empty knob is absent, as unboundedReads treats it -- Number(null) is 0, a real threshold. */
  t('a null or empty readMaxBytes is no threshold, not a threshold of zero',
    (() => {
      const s = { parsed: { cwd: '/w', sessionId: 'nz', requests: [{}], compactions: [], results: [
        { id: 'n1', name: 'Read', file: '/w/a.js', whole: true, chars: 10, tokens: 3, carried: 3, isError: false, marker: false }] },
        trimmed: [], sizes: new Map([['n1', 5000]]) };
      return [null, ''].every(k => { const r = T.reachPooled([s], { readMaxBytes: k });
        return r.readTrigger === null && r.read.over.n === 0 && r.read.unsized.n === 1; });
    })());

  t('trimmedResults credits only a rewrite the model actually saw',
    (() => {
      const p2 = { sessionId: 'x', results: [
        { id: 'a', name: 'Bash', what: 'npm test', marker: true },
        { id: 'b', name: 'Bash', what: 'npm run lint', marker: false }] };
      const led = [{ ev: 'post', session: 'x', id: 'a', kept: 10, chars: 9000, tool: 'Bash', what: 'npm test' },
        { ev: 'post', session: 'x', id: 'b', kept: 10, chars: 9000, tool: 'Bash', what: 'npm run lint' }];
      const out = T.trimmedResults(p2, led);
      return out.length === 1 && out[0].id === 'a';
    })());

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

  /* The two paths that share readMaxBytes do not share its floor. An unbounded Read is capped by the PreToolUse
     hook, which compares statSync().size against the trigger and nothing gates it. A cat of one file goes
     through the POST hook, which returns at or under maxChars BEFORE any cap logic (guard.js:272) -- so below
     maxChars the trigger is a dead knob for it. The grid modelled only the first, and answered "what would a
     trigger of 2,000 have caught" with 2 where the guard's own path catches 1. */
  const floorReads = [{ bytes: 5000, lines: 900, via: 'post' }, { bytes: 9000, lines: 100, via: 'post' }];
  const gated = T.triggerGrid(floorReads, [2000], [30], { maxChars: 6000 })[0];
  t('a shell read over the trigger but under maxChars is not caught, and the row says how many are inert',
    gated.caught === 1 && gated.inert === 1, JSON.stringify({ caught: gated.caught, inert: gated.inert }));
  t('the same size through the Read path IS caught, because that path has no floor',
    T.triggerGrid([{ bytes: 5000, lines: 100, via: 'read-cap' }], [2000], [30], { maxChars: 6000 })[0].caught === 1);
  /* The count is the visible half and the medians are the half that decides: taken over the inflated set, the
     saving a low trigger appears to offer is a saving on reads the guard never touches. */
  t('the withheld median comes from the effective set, not from every read over the trigger',
    Math.abs(gated.byLimit[30] - (100 - 30) / 100) < 1e-9
    && Math.abs(T.triggerGrid(floorReads, [2000], [30])[0].byLimit[30] - (900 - 30) / 900) < 1e-9,
    'gated ' + gated.byLimit[30].toFixed(3) + '  ungated ' + T.triggerGrid(floorReads, [2000], [30])[0].byLimit[30].toFixed(3));
  t('omitting maxChars keeps the old arithmetic exactly, so no caller changes meaning by being left alone',
    T.triggerGrid(floorReads, [2000], [30])[0].caught === 2
    && T.triggerGrid(floorReads, [2000], [30])[0].inert === 0);
  t('each read records the path readMaxBytes would reach it by',
    ur.reads.every(r => r.via === 'post' || r.via === 'read-cap')
    && T.unboundedReads({ ...up, results: [R('/w/one.js', true, 'a\nb', null, 0, { name: 'Read' })] }, [], {}).reads[0].via === 'read-cap'
    && T.unboundedReads({ ...up, results: [R('/w/one.js', true, 'a\nb', null, 0, { name: 'Bash' })] }, [], {}).reads[0].via === 'post',
    JSON.stringify(ur.reads.map(r => r.via)));

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

  console.log('\n-- tokens, never money, and the guard\'s own cost');
  /* The rule: every saving is stated in tokens (entered, carried, cache), never money. The pricing helpers are
     gone from the module, so nothing can quietly start printing a dollar figure again. */
  t('the module exports no pricing helper', ['priceOf', 'usdOfTokens', 'costOf', 'PRICES'].every(k => T[k] === undefined));
  /* Claude Code writes <synthetic> entries with an all-zero usage; the old cost-based label dropped them, the
     token-only one must too, or --compare labels a one-model session as mixed. */
  t('a session label leaves out the <synthetic> placeholder model',
    T.sessionFacts({ file: '/w/syn.jsonl', sessionId: 'syn', requests: [{ model: 'claude-opus-5', usage: { input_tokens: 1 } }, { model: '<synthetic>', usage: { input_tokens: 0 } }], results: [], compactions: [] }, []).model === 'claude-opus-5');

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

/* The Backfire Auditor (Step 0 gate): a withhold (marker + ledger row) backfires only when the model pulls
   the withheld bytes back the two ways the guard makes possible -- reading its saved out/ file, or
   `tokenbrake show <stem>`. Attribution is EXACT: the audit rebuilds the guard's own filename
   (<sid[0..8]>-<tool_use_id last 10, cleaned>) and compares the read's stem to it whole, so this fixture
   builds the out/ names the SAME way saveOut does -- a matcher that compared the full id would fail here. */
{
  console.log('\n-- backfire audit (Step 0 gate)');
  const tr = await import('./transcript.js');
  const T = tr.default || tr;
  const sid = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';                                 // realistic: > 8 chars
  const stem = (id) => sid.slice(0, 8).replace(/[^\w-]/g, '_') + '-' + String(id).slice(-10).replace(/[^\w-]/g, '');   // as saveOut names it (sid sanitized too)
  const outPath = (id) => '/cfg/tokenbrake/out/' + stem(id) + '.txt';
  const reqs = (n) => Array.from({ length: n }, () => ({ model: 'claude-opus-5' }));
  const A = 'toolu_01AAAAAAAAAAAAAAAAA1', B = 'toolu_01BBBBBBBBBBBBBBBBB2', C = 'toolu_01CCCCCCCCCCCCCCCCC3';
  /* 6 requests; three marked + ledgered trims (A, B, C). A Read of B's saved out/ file pulls B back. */
  const base = {
    sessionId: sid, cwd: '/w', requests: reqs(6), compactions: [],
    results: [
      { id: A, name: 'Bash', file: null, what: 'npm test', marker: true, tokens: 500, afterReq: 0 },
      { id: B, name: 'Bash', file: null, what: 'cat big.log', marker: true, tokens: 500, afterReq: 1 },
      { id: C, name: 'Bash', file: null, what: 'grep x src', marker: true, tokens: 500, afterReq: 2 },
      { id: 'toolu_R', name: 'Read', file: outPath(B), what: outPath(B), marker: false, tokens: 3000, afterReq: 3 },
    ],
  };
  const trimRow = (id) => ({ ev: 'post', session: sid, id, tool: 'Bash', chars: 20000, kept: 2000 });
  const ledger = [trimRow(A), trimRow(B), trimRow(C)];
  const a = T.backfireAudit(JSON.parse(JSON.stringify(base)), ledger);
  t('marker + ledger row makes a withhold, one per marked result', a.withholds.length === 3, String(a.withholds.length));
  t('a read of the guard-named out/ file attributes to that withhold (exact stem, not the full id)',
    a.backfired === 1 && a.withholds.find(w => w.id === B).recovered && !a.withholds.find(w => w.id === A).recovered,
    JSON.stringify(a.withholds.map(w => [w.id.slice(-4), w.recovered])));
  t('a saved-output read is one recovery event with a positive footprint', a.recoveredEvents === 1 && a.recoveredCarried > 0, JSON.stringify({ e: a.recoveredEvents, c: a.recoveredCarried }));
  t('net is gross saved-carried minus what was pulled back', a.net === a.savedCarried - a.recoveredCarried, JSON.stringify({ net: a.net, s: a.savedCarried, r: a.recoveredCarried }));
  t('a pull-back with a positive net verdicts net positive', a.verdict === 'net positive', a.verdict + ' net=' + a.net);

  /* The pull-back can come through a SHELL command, not just the Read tool. readFileOf lifts the single-file
     read shapes EXCERPT_CMD recognises (bare cat / sed -n / head / tail / non-recursive grep) into `file`, so
     OUT_FILE already caught those. The gap was every OTHER shell read of the out/ file -- piped or compound,
     where the pipe makes EXCERPT_CMD reject the command, so `file` is null and the path rides only in `what`,
     tested against SHOW_CMD alone. The harness pipes by default, so this was the wide leak, scored as clean.
     Each fixture is built through the real readFileOf/describe and asserts file === null, so it reproduces what
     parseTranscript emits for a piped read -- failing the pre-fix loop (backfired 0), passing now. */
  const shellPull = (cmd) => { const b = JSON.parse(JSON.stringify(base));
    b.results[3] = { id: 'toolu_SH', name: 'Bash', file: T.readFileOf('Bash', { command: cmd }),
      what: T.describe('Bash', { command: cmd }), marker: false, tokens: 3000, afterReq: 3 };
    return { audit: T.backfireAudit(b, ledger), file: b.results[3].file, what: b.results[3].what }; };
  for (const cmd of ["sed -n '1,40p' " + outPath(B) + ' | head', 'grep hunk ' + outPath(B) + ' | head -20', 'cat ' + outPath(B) + ' | tail -5']) {
    const { audit: as, file, what } = shellPull(cmd);
    t('a piped shell read of the saved out/ file is a pull-back, not clean: ' + cmd.slice(0, 14),
      file === null && /tokenbrake[\\/]out[\\/]/.test(what)   // faithful: readFileOf lifts nothing, the path is only in `what`
      && as.backfired === 1 && as.withholds.find(w => w.id === B).recovered && !as.withholds.find(w => w.id === A).recovered
      && as.recoveredEvents === 1 && as.recoveredCarried > 0,
      JSON.stringify({ file, backfired: as.backfired, recoveredCarried: as.recoveredCarried }));
  }
  /* And a piped shell read of an out/ path whose stem is no withhold's attributes to nothing -- counted as an
     unmatched pull-back (the cautious direction), never cross-attributed to A/B/C. */
  const asMiss = shellPull('sed -n 1,5p /cfg/tokenbrake/out/' + stem(B).slice(0, -1) + 'Z.txt | head').audit;
  t('a shell read of an unknown out/ stem is counted but not cross-attributed',
    asMiss.backfired === 0 && asMiss.unmatchedEvents === 1, JSON.stringify({ b: asMiss.backfired, u: asMiss.unmatchedEvents }));

  /* An out/ read whose stem differs by even one char attributes to nothing -- exact equality, no containment. */
  const near = JSON.parse(JSON.stringify(base));
  near.results[3] = { id: 'toolu_R', name: 'Read', file: '/cfg/tokenbrake/out/' + stem(B).slice(0, -1) + 'Z.txt', what: '', marker: false, tokens: 3000, afterReq: 3 };
  const an = T.backfireAudit(near, ledger);
  t('a near-miss stem is not cross-attributed, but is counted apart', an.backfired === 0 && an.unmatchedEvents === 1, JSON.stringify({ b: an.backfired, u: an.unmatchedEvents }));

  /* Dedup: the ledger row carries the FIRST copy's stem as `sameAs`, which the pointer names as the `show`
     argument -- so a dedup withhold attributes on sameAs, not on its own id. */
  const priorStem = sid.slice(0, 8) + '-priorcopyX';
  const dedupTx = { sessionId: sid, cwd: '/w', requests: reqs(4), compactions: [],
    results: [
      { id: 'toolu_DEDUP1', name: 'Bash', file: null, what: 'cat big.log', marker: true, tokens: 40, afterReq: 0 },
      { id: 'toolu_SHOW', name: 'Bash', file: null, what: 'npx tokenbrake show ' + priorStem, marker: false, tokens: 3000, afterReq: 1 },
    ] };
  const ad = T.backfireAudit(dedupTx, [{ ev: 'post', session: sid, id: 'toolu_DEDUP1', tool: 'Bash', chars: 20000, kept: 60, dedup: true, sameAs: priorStem }], { min: 1 });
  t('a dedup withhold is pulled back by `show <sameAs>`, not by its own id',
    ad.backfired === 1 && ad.withholds[0].kind === 'dedup' && ad.withholds[0].recovered, JSON.stringify(ad.withholds.map(w => [w.kind, w.recovered])));

  const none = T.backfireAudit({ sessionId: 'z', cwd: '/w', requests: reqs(2), compactions: [],
    results: [{ id: 'x', name: 'Bash', file: null, what: 'ls', marker: false, tokens: 10, afterReq: 0 }] }, []);
  t('a session with no withholds audits to the nothing verdict', none.verdict === 'nothing' && none.withholds.length === 0, none.verdict);

  /* A session_id with a path character: guard sanitizes sid into the out/ filename, and the audit's stemOf
     must sanitize IDENTICALLY, or the pull-back won't attribute (the point of the sid hardening). */
  const dsid = 'ab/cd-99-2222-3333-444455556666';
  const dstem = (id) => dsid.slice(0, 8).replace(/[^\w-]/g, '_') + '-' + String(id).slice(-10).replace(/[^\w-]/g, '');   // as saveOut names it (sid sanitized)
  const dirtyTx = { sessionId: dsid, cwd: '/w', requests: reqs(4), compactions: [],
    results: [
      { id: A, name: 'Bash', file: null, what: 'cat big.log', marker: true, tokens: 40, afterReq: 0 },
      { id: 'toolu_DR', name: 'Read', file: '/cfg/tokenbrake/out/' + dstem(A) + '.txt', what: '/cfg/tokenbrake/out/' + dstem(A) + '.txt', marker: false, tokens: 3000, afterReq: 1 },
    ] };
  const adirty = T.backfireAudit(dirtyTx, [{ ev: 'post', session: dsid, id: A, tool: 'Bash', chars: 20000, kept: 200 }], { min: 1 });
  t('a path-char session_id: the audit stem is sanitized like guard, so the pull-back still attributes',
    adirty.backfired === 1 && adirty.withholds[0].recovered, JSON.stringify({ b: adirty.backfired, stem: adirty.withholds[0].stem }));

  /* No sessionId in the parse: stemOf must recover the real session from parsed.file (as the rest of
     transcript.js does), matching the guard's own session_id, or no pull-back attributes. */
  const fbSess = 'realsess-1111';
  const fbStem = (id) => fbSess.slice(0, 8) + '-' + String(id).slice(-10).replace(/[^\w-]/g, '');
  const fbTx = { sessionId: null, file: '/x/' + fbSess + '.jsonl', cwd: '/w', requests: reqs(4), compactions: [],
    results: [
      { id: A, name: 'Bash', file: null, what: 'cat big.log', marker: true, tokens: 40, afterReq: 0 },
      { id: 'toolu_FR', name: 'Read', file: '/cfg/tokenbrake/out/' + fbStem(A) + '.txt', what: '/cfg/tokenbrake/out/' + fbStem(A) + '.txt', marker: false, tokens: 3000, afterReq: 1 },
    ] };
  const afb = T.backfireAudit(fbTx, [{ ev: 'post', session: fbSess, id: A, tool: 'Bash', chars: 20000, kept: 200 }], { min: 1 });
  t('a missing sessionId is recovered from parsed.file so the pull-back still attributes',
    afb.backfired === 1 && afb.withholds[0].recovered, JSON.stringify({ b: afb.backfired, stem: afb.withholds[0].stem }));

  /* A measured net loss is a backfire at any sample size -- one withhold, a pull-back that dwarfs it. */
  const heavy = { sessionId: sid, cwd: '/w', requests: reqs(6), compactions: [],
    results: [
      { id: A, name: 'Bash', file: null, what: 'cat log', marker: true, tokens: 100, afterReq: 0 },
      { id: 'toolu_P', name: 'Read', file: outPath(A), what: outPath(A), marker: false, tokens: 9000, afterReq: 1 },
    ] };
  const a3 = T.backfireAudit(heavy, [{ ev: 'post', session: sid, id: A, tool: 'Bash', chars: 5000, kept: 4000 }]);
  t('a measured net loss verdicts backfired even below the sample floor', a3.net < 0 && a3.verdict === 'backfired', JSON.stringify({ net: a3.net, v: a3.verdict }));

  /* Below the floor with no loss is too little to assert a rate -- 2 clean withholds do not get a verdict. */
  const twoTx = JSON.parse(JSON.stringify(base));
  twoTx.results = twoTx.results.slice(0, 2);   // A, B; no recovery
  const a2few = T.backfireAudit(twoTx, ledger);
  t('two clean withholds are too few to call a rate', a2few.verdict === 'too few' && a2few.backfired === 0, a2few.verdict);

  const cleanBase = JSON.parse(JSON.stringify(base));
  cleanBase.results = cleanBase.results.slice(0, 3);   // A, B, C; drop the recovery read
  const a4 = T.backfireAudit(cleanBase, ledger);
  t('three withholds and no pull-back verdicts clean', a4.verdict === 'clean' && a4.backfired === 0, a4.verdict);

  /* An excerpt cap (a `cat` of a large file, capped like a Read: ev:'post', excerpt:true, saved:null) carries
     a marker and kept but saves nothing to out/, so it is a Read-cap event, not a net-able trim -- it must
     NOT be counted as a withhold, or it would pad the saving side and could only ever read "clean". */
  const excerptTx = { sessionId: sid, cwd: '/w', requests: reqs(4), compactions: [],
    results: [{ id: 'toolu_CAT', name: 'Bash', file: null, what: 'cat huge.log', marker: true, tokens: 300, afterReq: 0 }] };
  const aex = T.backfireAudit(excerptTx, [{ ev: 'post', session: sid, id: 'toolu_CAT', tool: 'Bash', chars: 90000, kept: 8000, excerpt: true, saved: null }]);
  t('an excerpt cap is not counted as a withhold (it saves nothing to out/)', aex.withholds.length === 0 && aex.verdict === 'nothing', JSON.stringify({ w: aex.withholds.length, v: aex.verdict }));

  /* `show` resolves a full path, an exact stem, or a UNIQUE prefix, exactly as the CLI does; mirror that. */
  const showRef = (what) => T.backfireAudit({ sessionId: sid, cwd: '/w', requests: reqs(4), compactions: [],
    results: [{ id: A, name: 'Bash', file: null, what: 'npm test', marker: true, tokens: 500, afterReq: 0 },
      { id: 'toolu_S', name: 'Bash', file: null, what, marker: false, tokens: 2000, afterReq: 1 }] }, [trimRow(A)], { min: 1 });
  t('`show <unique prefix>` attributes to the one withhold it resolves', showRef('tokenbrake show ' + stem(A).slice(0, 12)).backfired === 1, 'prefix');
  t('`show <full out/ path>` attributes to its withhold', showRef('npx tokenbrake show ' + outPath(A)).backfired === 1, 'path');
  const amb = T.backfireAudit({ sessionId: sid, cwd: '/w', requests: reqs(5), compactions: [],
    results: [{ id: A, name: 'Bash', file: null, what: 'a', marker: true, tokens: 100, afterReq: 0 },
      { id: B, name: 'Bash', file: null, what: 'b', marker: true, tokens: 100, afterReq: 1 },
      { id: 'toolu_S', name: 'Bash', file: null, what: 'tokenbrake show ' + sid.slice(0, 8), marker: false, tokens: 2000, afterReq: 2 }] },
    [trimRow(A), trimRow(B)]);
  t('an ambiguous `show <sid8>` prefix is counted but not cross-attributed', amb.backfired === 0 && amb.unmatchedEvents === 1, JSON.stringify({ b: amb.backfired, u: amb.unmatchedEvents }));

  /* A net of exactly zero with a backfire is break-even, not a win. savedCarried == recoveredCarried by
     construction: A at afterReq0 of 3 requests carries 2 turns, savedTokens*(2+1) = 2000*3 = 6000; the
     recovery at afterReq1 carries 1 turn, foot = 3000 + 3000 = 6000. */
  const evenTx = { sessionId: sid, cwd: '/w', requests: reqs(3), compactions: [],
    results: [{ id: A, name: 'Bash', file: null, what: 'x', marker: true, tokens: 100, afterReq: 0 },
      { id: 'toolu_P', name: 'Read', file: outPath(A), what: outPath(A), marker: false, tokens: 3000, afterReq: 1 }] };
  const aeven = T.backfireAudit(evenTx, [{ ev: 'post', session: sid, id: A, tool: 'Bash', chars: 10000, kept: 2000 }], { min: 1 });
  t('a net of exactly zero with a backfire verdicts break-even, not net positive', aeven.net === 0 && aeven.verdict === 'break-even', JSON.stringify({ net: aeven.net, v: aeven.verdict }));

  /* Integration pin: backfireAudit rebuilds guard.js saveOut's out/ filename, and the two cannot share code
     (the guard installs as a single file). So pin them end to end -- a REAL guard trim, its real out/ file,
     attributed by the audit. A change to saveOut's naming breaks this test, not silently the gate. */
  const dir = mkdtempSync(join(tmpdir(), 'tokenbrake-bf-int-'));
  const isid = 'inteGRATION-sess-0001', itid = 'toolu_01INTEGRATION9999';
  const bigOut = Array.from({ length: 400 }, (_, i) => 'line ' + i + ' ' + 'x'.repeat(40)).join('\n');   // > maxChars, not a cat
  spawnSync(process.execPath, ['./guard.js', 'post'], {
    input: JSON.stringify({ session_id: isid, tool_use_id: itid, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: bashResp(bigOut) }),
    encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
  const outDir = join(dir, 'tokenbrake', 'out');
  const outFiles = existsSync(outDir) ? readdirSync(outDir).filter(f => f.endsWith('.txt')) : [];
  const intLedger = readFileSync(join(dir, 'tokenbrake', 'ledger.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const realPath = join(outDir, outFiles[0] || 'none.txt');
  const intTx = { sessionId: isid, cwd: '/w', requests: reqs(3), compactions: [],
    results: [{ id: itid, name: 'Bash', file: null, what: 'npm test', marker: true, tokens: 500, afterReq: 0 },
      { id: 'toolu_READ', name: 'Read', file: realPath, what: realPath, marker: false, tokens: 3000, afterReq: 1 }] };
  const ai = T.backfireAudit(intTx, intLedger, { min: 1 });
  t('the audit attributes a read of a REAL guard-written out/ file (pins stemOf to saveOut)',
    outFiles.length === 1 && ai.withholds.length === 1 && ai.backfired === 1, JSON.stringify({ files: outFiles, w: ai.withholds.length, b: ai.backfired }));
  rmSync(dir, { recursive: true, force: true });
}

/* Read-After-Edit Delta (narrowing 1, off by default): after an Edit, an unbounded Read of the same file is
   narrowed to the changed region + context; the rest is unchanged from what the model already has. The file
   stays on disk, so a wrong guess costs one wider read, which report --backfire measures as a delta backfire. */
{
  console.log('\n-- read-after-edit delta (narrowing 1, off by default)');
  const lines = Array.from({ length: 200 }, (_, i) => i === 99 ? 'const UNIQUE_EDIT_MARKER = 1;' : ('const x' + i + ' = ' + i + ';'));
  const sess = 'rae-1';
  const editInput = (file) => ({ session_id: sess, tool_use_id: 'toolu_e1', tool_name: 'Edit',
    tool_input: { file_path: file, old_string: 'const x99 = 99;', new_string: 'const UNIQUE_EDIT_MARKER = 1;' }, tool_response: { filePath: file } });

  const dir = mkdtempSync(join(tmpdir(), 'tokenbrake-rae-'));
  const file = join(dir, 'big.js');
  writeFileSync(file, lines.join('\n') + '\n');
  writeFileSync(join(dir, 'tokenbrake.json'), JSON.stringify({ readAfterEdit: true }));
  const spawnIn = (d, mode, input) => spawnSync(process.execPath, ['./guard.js', mode],
    { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: d } });

  spawnIn(dir, 'post', editInput(file));
  const editsFile = join(dir, 'tokenbrake', 'edits', sess + '.jsonl');
  t('an Edit records the changed line range when readAfterEdit is on',
    existsSync(editsFile) && /"ranges":\[\[100,100\]\]/.test(readFileSync(editsFile, 'utf8')), existsSync(editsFile) ? readFileSync(editsFile, 'utf8').trim() : 'no edits file');
  const on = parse(spawnIn(dir, 'read-pre', { session_id: sess, tool_name: 'Read', tool_input: { file_path: file } }).stdout);
  const ui = on && on.hookSpecificOutput && on.hookSpecificOutput.updatedInput;
  t('an unbounded read of the edited file is narrowed to the changed region + context', ui && ui.offset === 80 && ui.limit === 41, JSON.stringify(ui));
  t('the narrowing explains itself factually and points to a wider read',
    /region you edited \(lines 80-120 of 200\)/.test(((on || {}).hookSpecificOutput || {}).additionalContext || '')
    && /offset\/limit for the rest/.test(((on || {}).hookSpecificOutput || {}).additionalContext || ''),
    ((on || {}).hookSpecificOutput || {}).additionalContext || '');
  const led = readFileSync(join(dir, 'tokenbrake', 'ledger.jsonl'), 'utf8');
  t('the delta is logged as its own ev:read-delta with the window', /"ev":"read-delta"/.test(led) && /"offset":80/.test(led) && /"limit":41/.test(led), led.split('\n').filter(Boolean).pop());
  const bounded = parse(spawnIn(dir, 'read-pre', { session_id: sess, tool_name: 'Read', tool_input: { file_path: file, offset: 5, limit: 10 } }).stdout);
  t('a bounded read of an edited file is left alone', bounded === null || !bounded.hookSpecificOutput, JSON.stringify(bounded));

  const dir2 = mkdtempSync(join(tmpdir(), 'tokenbrake-rae-off-'));
  const file2 = join(dir2, 'big.js'); writeFileSync(file2, lines.join('\n') + '\n');
  spawnIn(dir2, 'post', editInput(file2));   // no config -> readAfterEdit defaults off
  t('no edit is recorded when readAfterEdit is off (default)', !existsSync(join(dir2, 'tokenbrake', 'edits', sess + '.jsonl')), 'off');
  const off = parse(spawnIn(dir2, 'read-pre', { session_id: sess, tool_name: 'Read', tool_input: { file_path: file2 } }).stdout);
  t('an unbounded read is not narrowed when readAfterEdit is off', off === null || !(off.hookSpecificOutput && off.hookSpecificOutput.updatedInput && off.hookSpecificOutput.updatedInput.offset), JSON.stringify(off));

  // structuredPatch is preferred and works where locating new_string cannot -- replace_all, repeated, or (here) absent text.
  const dir3 = mkdtempSync(join(tmpdir(), 'tokenbrake-rae-patch-'));
  const file3 = join(dir3, 'big.js'); writeFileSync(file3, lines.join('\n') + '\n');
  writeFileSync(join(dir3, 'tokenbrake.json'), JSON.stringify({ readAfterEdit: true }));
  spawnIn(dir3, 'post', { session_id: sess, tool_use_id: 'toolu_e2', tool_name: 'Edit',
    tool_input: { file_path: file3, old_string: 'whatever', new_string: 'NOT_IN_THE_FILE_AT_ALL' },
    tool_response: { structuredPatch: [{ oldStart: 50, oldLines: 3, newStart: 50, newLines: 4 }] } });
  const patchEdits = readFileSync(join(dir3, 'tokenbrake', 'edits', sess + '.jsonl'), 'utf8');
  t('structuredPatch drives the range where locating new_string cannot (replace_all / repeated / absent text)', /"ranges":\[\[50,53\]\]/.test(patchEdits), patchEdits.trim());
  rmSync(dir, { recursive: true, force: true }); rmSync(dir2, { recursive: true, force: true }); rmSync(dir3, { recursive: true, force: true });

  /* A window wider than readLimitLines is NOT injected -- the delta must never deliver more than the size cap
     it overrides (a scattered/large edit span would). */
  const dirCap = mkdtempSync(join(tmpdir(), 'tokenbrake-rae-cap-'));
  const fileCap = join(dirCap, 'big.js'); writeFileSync(fileCap, lines.join('\n') + '\n');
  writeFileSync(join(dirCap, 'tokenbrake.json'), JSON.stringify({ readAfterEdit: true, readLimitLines: 10 }));
  spawnIn(dirCap, 'post', { session_id: sess, tool_use_id: 'toolu_c1', tool_name: 'Edit', tool_input: { file_path: fileCap, old_string: 'const x99 = 99;', new_string: 'const UNIQUE_EDIT_MARKER = 1;' }, tool_response: { filePath: fileCap } });
  const capUi = (parse(spawnIn(dirCap, 'read-pre', { session_id: sess, tool_name: 'Read', tool_input: { file_path: fileCap } }).stdout) || {}).hookSpecificOutput;
  t('a delta window wider than readLimitLines is not injected (never delivers more than the cap)', !(capUi && capUi.updatedInput && capUi.updatedInput.offset), JSON.stringify(capUi));
  rmSync(dirCap, { recursive: true, force: true });

  /* An edit recorded past EOF (a truncation, or an odd structuredPatch newStart from untrusted tool output)
     must not inject a negative limit or a past-EOF offset -- it declines instead. */
  const dirEof = mkdtempSync(join(tmpdir(), 'tokenbrake-rae-eof-'));
  const fileEof = join(dirEof, 'big.js'); writeFileSync(fileEof, lines.join('\n') + '\n');   // 200 lines
  writeFileSync(join(dirEof, 'tokenbrake.json'), JSON.stringify({ readAfterEdit: true }));
  spawnIn(dirEof, 'post', { session_id: sess, tool_use_id: 'toolu_x1', tool_name: 'Edit', tool_input: { file_path: fileEof, old_string: 'a', new_string: 'b' }, tool_response: { structuredPatch: [{ newStart: 9999, newLines: 1 }] } });
  const eofUi = (parse(spawnIn(dirEof, 'read-pre', { session_id: sess, tool_name: 'Read', tool_input: { file_path: fileEof } }).stdout) || {}).hookSpecificOutput;
  t('an edit recorded past EOF never injects a negative limit / past-EOF offset', !(eofUi && eofUi.updatedInput && eofUi.updatedInput.offset), JSON.stringify(eofUi));
  rmSync(dirEof, { recursive: true, force: true });

  /* A last-line edit on a file with NO trailing newline (where countLines is one short) is still shown --
     `to` is left unclamped so the edited line stays inside the injected window. */
  const dirNl = mkdtempSync(join(tmpdir(), 'tokenbrake-rae-nl-'));
  const fileNl = join(dirNl, 'big.js'); writeFileSync(fileNl, lines.slice(0, 50).join('\n'));   // 50 lines, no trailing newline
  writeFileSync(join(dirNl, 'tokenbrake.json'), JSON.stringify({ readAfterEdit: true }));
  spawnIn(dirNl, 'post', { session_id: sess, tool_use_id: 'toolu_n1', tool_name: 'Edit', tool_input: { file_path: fileNl, old_string: 'a', new_string: 'b' }, tool_response: { structuredPatch: [{ newStart: 50, newLines: 1 }] } });
  const nlUi = ((parse(spawnIn(dirNl, 'read-pre', { session_id: sess, tool_name: 'Read', tool_input: { file_path: fileNl } }).stdout) || {}).hookSpecificOutput || {}).updatedInput;
  t('a last-line edit on a no-trailing-newline file is still inside the injected window',
    nlUi && nlUi.offset === 30 && (nlUi.offset + nlUi.limit - 1) >= 50, JSON.stringify(nlUi));
  rmSync(dirNl, { recursive: true, force: true });

  /* Over readMaxBytes the delta stands aside and the size cap governs -- the 2026-09-14 A/B showed narrowing a
     large file's verify-read backfired, so big files are left to the cap (readMaxBytes is the boundary the
     data drew: the helped file was under it, the backfired ones over). */
  const dirBig = mkdtempSync(join(tmpdir(), 'tokenbrake-rae-big-'));
  const fileBig = join(dirBig, 'big.js');
  writeFileSync(fileBig, Array.from({ length: 2000 }, (_, i) => 'const filler' + i + ' = "' + 'x'.repeat(30) + '";').join('\n') + '\n');   // ~100 KB, over readMaxBytes
  writeFileSync(join(dirBig, 'tokenbrake.json'), JSON.stringify({ readAfterEdit: true }));
  spawnIn(dirBig, 'post', { session_id: sess, tool_use_id: 'toolu_b1', tool_name: 'Edit', tool_input: { file_path: fileBig, old_string: 'a', new_string: 'b' }, tool_response: { structuredPatch: [{ newStart: 545, newLines: 1 }] } });
  const bigUi = ((parse(spawnIn(dirBig, 'read-pre', { session_id: sess, tool_name: 'Read', tool_input: { file_path: fileBig } }).stdout) || {}).hookSpecificOutput || {}).updatedInput;
  t('a file over readMaxBytes is left to the size cap, not narrowed by the delta (edit recorded, delta stands aside)',
    bigUi && bigUi.offset == null && bigUi.limit === 300, JSON.stringify(bigUi));
  rmSync(dirBig, { recursive: true, force: true });

  /* The delta honors the same cap conditions the sibling read-whole path does: an edited file on the
     alwaysCap denylist is left to the cap, not narrowed. */
  const dirAc = mkdtempSync(join(tmpdir(), 'tokenbrake-rae-acap-'));
  const fileAc = join(dirAc, 'bundle.min.js'); writeFileSync(fileAc, lines.join('\n') + '\n');
  writeFileSync(join(dirAc, 'tokenbrake.json'), JSON.stringify({ readAfterEdit: true, alwaysCap: ['.min.js'] }));
  spawnIn(dirAc, 'post', { session_id: sess, tool_use_id: 'toolu_ac', tool_name: 'Edit', tool_input: { file_path: fileAc, old_string: 'const x99 = 99;', new_string: 'const UNIQUE_EDIT_MARKER = 1;' }, tool_response: { filePath: fileAc } });
  const acUi = ((parse(spawnIn(dirAc, 'read-pre', { session_id: sess, tool_name: 'Read', tool_input: { file_path: fileAc } }).stdout) || {}).hookSpecificOutput || {}).updatedInput;
  t('an edited alwaysCap file is left to the cap, not narrowed by the delta', acUi && acUi.offset == null && acUi.limit === 300, JSON.stringify(acUi));
  rmSync(dirAc, { recursive: true, force: true });

  /* An edited persisted output (under the config dir, over maxChars) keeps its 80-line persistedLimitLines cap,
     not the delta -- a saved tool output is not the "file the model already has" the delta is for. */
  const dirP = mkdtempSync(join(tmpdir(), 'tokenbrake-rae-persist-'));
  const outDir = join(dirP, 'tokenbrake', 'out'); mkdirSync(outDir, { recursive: true });
  const fileP = join(outDir, 'saved.txt'); writeFileSync(fileP, Array.from({ length: 400 }, () => 'x'.repeat(30)).join('\n') + '\n');   // ~12 KB, over maxChars
  writeFileSync(join(dirP, 'tokenbrake.json'), JSON.stringify({ readAfterEdit: true }));
  spawnIn(dirP, 'post', { session_id: sess, tool_use_id: 'toolu_p1', tool_name: 'Edit', tool_input: { file_path: fileP, old_string: 'a', new_string: 'b' }, tool_response: { structuredPatch: [{ newStart: 100, newLines: 1 }] } });
  const pUi = ((parse(spawnIn(dirP, 'read-pre', { session_id: sess, tool_name: 'Read', tool_input: { file_path: fileP } }).stdout) || {}).hookSpecificOutput || {}).updatedInput;
  t('an edited persisted output keeps its persistedLimitLines cap, not the delta', pUi && pUi.offset == null && pUi.limit === 80, JSON.stringify(pUi));
  rmSync(dirP, { recursive: true, force: true });

  /* Auditor side: a delta backfires when the model later reads the file OUTSIDE the window the delta showed. */
  const tr = await import('./transcript.js');
  const T = tr.default || tr;
  const deltaLedger = [{ ev: 'read-delta', session: 'ds', what: '/w/big.js', offset: 80, limit: 41, t: 1000 }];
  const mk = (readFrom, at) => ({ sessionId: 'ds', cwd: '/w', requests: [{}, {}], compactions: [],
    results: [{ id: 'r', name: 'Read', file: '/w/big.js', readFrom, at, tokens: 100, afterReq: 0 }] });
  t('a later read outside the delta window is a delta backfire', T.backfireAudit(mk(150, 2000), deltaLedger).deltas.backfired === 1, 'outside');
  t('a later read inside the delta window is not a backfire', T.backfireAudit(mk(90, 2000), deltaLedger).deltas.backfired === 0, 'inside');
  t('a read before the delta fired is not a backfire', T.backfireAudit(mk(150, 500), deltaLedger).deltas.backfired === 0, 'before');
  const whole = (at) => ({ sessionId: 'ds', cwd: '/w', requests: [{}, {}], compactions: [],
    results: [{ id: 'r', name: 'Bash', file: '/w/big.js', readFrom: null, whole: true, at, tokens: 100, afterReq: 0 }] });
  t('a whole-file re-read after the delta (cat / unbounded Read) is a delta backfire', T.backfireAudit(whole(2000), deltaLedger).deltas.backfired === 1, 'whole-after');
  t('a whole-file read at/before the delta (its own narrowed read) is not counted', T.backfireAudit(whole(900), deltaLedger).deltas.backfired === 0, 'whole-own');
}

/* Re-read elision (narrowing 2, off by default): a re-read of a file already read WHOLE this session,
   unchanged and recent, is narrowed to the first reReadKeepLines + a pointer -- the model likely still has it.
   Off by default; a changed file, an old re-read, or a first read are all left alone. */
{
  console.log('\n-- re-read elision (narrowing 2, off by default)');
  const body = Array.from({ length: 200 }, (_, i) => 'const line_' + i + ' = 0;').join('\n') + '\n';
  const rp = (dir, file) => parse(spawnSync(process.execPath, ['./guard.js', 'read-pre'],
    { input: JSON.stringify({ session_id: 'rr', tool_name: 'Read', tool_input: { file_path: file } }), encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } }).stdout);
  const uiOf = (o) => (o && o.hookSpecificOutput && o.hookSpecificOutput.updatedInput) || null;

  const dir = mkdtempSync(join(tmpdir(), 'tokenbrake-rr-'));
  const file = join(dir, 'src.js'); writeFileSync(file, body);
  writeFileSync(join(dir, 'tokenbrake.json'), JSON.stringify({ reReadElide: true }));
  const first = uiOf(rp(dir, file));
  t('a first whole read is not elided', !(first && first.limit === 5), JSON.stringify(first));
  t('the whole read was recorded to reads-state', existsSync(join(dir, 'tokenbrake', 'reads', 'rr.jsonl')), 'reads state');
  const second = uiOf(rp(dir, file));
  t('an unchanged, recent re-read is elided to reReadKeepLines', second && second.limit === 5 && second.offset == null, JSON.stringify(second));
  t('the re-read is logged as ev:read-reread', /"ev":"read-reread"/.test(readFileSync(join(dir, 'tokenbrake', 'ledger.jsonl'), 'utf8')), 'ledger');
  writeFileSync(file, body + 'const added = 1;\n');   // changes size + mtime
  const changed = uiOf(rp(dir, file));
  t('a changed file is not elided', !(changed && changed.limit === 5), JSON.stringify(changed));
  rmSync(dir, { recursive: true, force: true });

  /* Recency: with reReadRecency:1, one other whole-read since means the re-read is no longer "recent". */
  const dirR = mkdtempSync(join(tmpdir(), 'tokenbrake-rr-recency-'));
  const fA = join(dirR, 'a.js'), fB = join(dirR, 'b.js'); writeFileSync(fA, body); writeFileSync(fB, body);
  writeFileSync(join(dirR, 'tokenbrake.json'), JSON.stringify({ reReadElide: true, reReadRecency: 1 }));
  rp(dirR, fA); rp(dirR, fB);   // read A, then B (since-A becomes 1)
  t('a re-read past reReadRecency is not elided', !((uiOf(rp(dirR, fA)) || {}).limit === 5), 'recency');
  rmSync(dirR, { recursive: true, force: true });

  /* reReadKeepLines:0 (or negative) must not fire: injecting limit:0 would make Read read the whole file
     (a silent no-op) while the note claims "the first 0 lines". The floor keeps a bad knob from firing. */
  const dirZ = mkdtempSync(join(tmpdir(), 'tokenbrake-rr-zero-'));
  const fZ = join(dirZ, 'src.js'); writeFileSync(fZ, body);
  writeFileSync(join(dirZ, 'tokenbrake.json'), JSON.stringify({ reReadElide: true, reReadKeepLines: 0 }));
  rp(dirZ, fZ); const z2 = uiOf(rp(dirZ, fZ));
  t('reReadKeepLines:0 does not elide (no limit:0 injected)', !(z2 && z2.limit === 0), JSON.stringify(z2));
  rmSync(dirZ, { recursive: true, force: true });

  /* Default OFF: nothing recorded, nothing elided. */
  const dirOff = mkdtempSync(join(tmpdir(), 'tokenbrake-rr-off-'));
  const fOff = join(dirOff, 'src.js'); writeFileSync(fOff, body);
  rp(dirOff, fOff); const off2 = uiOf(rp(dirOff, fOff));
  t('default off: no reads-state recorded', !existsSync(join(dirOff, 'tokenbrake', 'reads', 'rr.jsonl')), 'off state');
  t('default off: a re-read is not elided', !(off2 && off2.limit === 5), JSON.stringify(off2));
  rmSync(dirOff, { recursive: true, force: true });

  /* Auditor side: an elision backfires when the model reads the file again past what the elision showed. */
  const tr = await import('./transcript.js');
  const T = tr.default || tr;
  const rrLedger = [{ ev: 'read-reread', session: 'ds', what: '/w/src.js', limit: 5, t: 1000 }];
  const mk = (r) => ({ sessionId: 'ds', cwd: '/w', requests: [{}, {}], compactions: [],
    results: [{ id: 'r', name: 'Read', file: '/w/src.js', tokens: 100, afterReq: 0, ...r }] });
  t('a whole-file re-read after the elision is a re-read backfire', T.backfireAudit(mk({ whole: true, readFrom: null, at: 2000 }), rrLedger).reReads.backfired === 1, 'whole-after');
  t('a ranged read past what the elision showed is a re-read backfire', T.backfireAudit(mk({ readFrom: 40, at: 2000 }), rrLedger).reReads.backfired === 1, 'past-window');
  t('a read within the shown lines is not a re-read backfire', T.backfireAudit(mk({ readFrom: 3, at: 2000 }), rrLedger).reReads.backfired === 0, 'within');
  t('the elision\'s own read (at/before it) is not a backfire', T.backfireAudit(mk({ whole: true, readFrom: null, at: 900 }), rrLedger).reReads.backfired === 0, 'own');
  t('a session with no elisions reports zero re-reads', T.backfireAudit(mk({ whole: true, at: 2000 }), []).reReads.fired === 0, 'none');
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

/* Two branches that rewrote a body without measuring what they were about to emit. Both were found by
   /code-review on the cap fix itself and both are the same class it exists to close: the model receives
   something other than what the ledger says it received. */
{
  console.log('\n-- rewrites that must measure, and say what they cut');

  /* SHAPED: the only rewrite reachable with one knob on stock defaults. It cuts only when escaping pushes an
     under-maxChars body past the ceiling -- and when it cut, it cut silently. Measured before the fix: a
     9,428-character shaped body delivered 8,485 characters, ending mid-token, with no marker, no out/ copy,
     and a ledger row still claiming shapedTo: 9,428. */
  const dir = mkdtempSync(join(tmpdir(), 'tokenbrake-shapecut-'));
  writeFileSync(join(dir, 'tokenbrake.json'), JSON.stringify({ shapeFilters: true, maxChars: 100000 }));
  const redraw = Array.from({ length: 40 }, (_, i) => `\x1b[32m[${'='.repeat(Math.max(3, i)).padEnd(40)}] ${i * 2}% - loading package ${i}\x1b[0m`);
  const quoteDense = Array.from({ length: 70 }, (_, i) => `[build] "module" "${i}" resolved "node_modules/@scope/pkg-${i}/dist/index.js" -> "ok" "hash=${'x'.repeat(40)}"`);
  const rs = spawnSync(process.execPath, ['./guard.js', 'post'], {
    input: JSON.stringify({ session_id: 'shapecut', tool_use_id: 'toolu_shapecut_1', tool_name: 'Bash',
      tool_input: { command: 'npm run build' }, tool_response: bashResp(redraw.concat(quoteDense).join('\n')) }),
    encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
  const so = parse(rs.stdout);
  const sOut = so && so.hookSpecificOutput && so.hookSpecificOutput.updatedToolOutput;
  const sBody = sOut && typeof sOut.stdout === 'string' ? sOut.stdout : '';
  t('a shaped body cut to fit the ceiling says so, rather than stopping mid-token',
    /\[tokenbrake\] [\d,]+ characters cut to fit the hook output cap\./.test(sBody), JSON.stringify(sBody.slice(-120)));
  t('and the whole emitted payload is under the ceiling', rs.stdout.length <= 9500, `emitted=${rs.stdout.length}`);
  const sRows = readFileSync(join(dir, 'tokenbrake', 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  const sRow = sRows[sRows.length - 1];
  t('and the ledger records what was DELIVERED, not just what shaping produced',
    sRow.kept === sBody.length && sRow.shapedTo > sRow.kept, JSON.stringify({ shapedTo: sRow.shapedTo, kept: sRow.kept }));
  t('and names a saved copy the model can read back', !!sRow.saved && existsSync(sRow.saved), String(sRow.saved));
  rmSync(dir, { recursive: true, force: true });

  /* DEDUP: the pointer is ~110 characters, but for MCP rebuild() keeps every non-text sibling block, so the
     PAYLOAD carrying it need not be small. Measured before the fix: a repeated screenshot result emitted
     40,306 characters against the 9,500 ceiling -- dropped silently by the host, the whole duplicate
     entering context, while the ledger booked chars - kept as a saving. */
  const ddir = mkdtempSync(join(tmpdir(), 'tokenbrake-dedupcap-'));
  writeFileSync(join(ddir, 'tokenbrake.json'), JSON.stringify({ dedup: true }));
  const mcpResp = { content: [
    { type: 'text', text: 'the same tool result, twice in one session.\n'.repeat(40) },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(40000) } } ] };
  const callMcp = (n) => spawnSync(process.execPath, ['./guard.js', 'post'], {
    input: JSON.stringify({ session_id: 'dedupcap', tool_use_id: 'toolu_dedupcap_' + n,
      tool_name: 'mcp__screenshot__capture', tool_input: {}, tool_response: mcpResp }),
    encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: ddir } });
  callMcp(1);
  const r2 = callMcp(2);
  t('a dedup pointer whose payload cannot fit is not emitted over the ceiling',
    r2.stdout.length <= 9500, `emitted=${r2.stdout.length}`);
  const dRows = readFileSync(join(ddir, 'tokenbrake', 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  t('and no saving is booked for a pointer the model never received',
    !dRows.some(r => r.dedup && r.kept != null), JSON.stringify(dRows.filter(r => r.dedup)));
  rmSync(ddir, { recursive: true, force: true });
}

/* Binary-Blob Elider (narrowing 3, off by default): shell output that is one long encoded/minified run --
   base64, a minified bundle, a one-line JSON -- is unreadable as bytes yet re-enters context every request.
   Replace it with a head + a descriptor + a saved copy (a plain trim to the backfire audit). Wide structured
   data (many wide lines, none dominant), a single long line inside normal output, short output, a failed
   command and the default-off path are all left alone. */
{
  console.log('\n-- binary-blob elider (narrowing 3, off by default)');
  const blobLine = 'const DATA="' + 'A1b2C3d4'.repeat(700) + '";';   // one ~5.6k-char line, no newlines
  const runBlob = (text, cfgExtra, command = 'cat bundle.min.js', failed = false) => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenbrake-blob-'));
    if (cfgExtra) writeFileSync(join(dir, 'tokenbrake.json'), JSON.stringify(cfgExtra));
    const input = { session_id: 'blob', tool_use_id: 'toolu_blob_' + Math.random().toString(36).slice(2, 8),
      tool_name: 'Bash', tool_input: { command } };
    if (failed) { input.hook_event_name = 'PostToolUseFailure'; input.error = 'Exit code 1\n' + text; }
    else input.tool_response = bashResp(text);
    const r = spawnSync(process.execPath, ['./guard.js', 'post'], { input: JSON.stringify(input), encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
    const o = parse(r.stdout);
    const out = o && o.hookSpecificOutput && o.hookSpecificOutput.updatedToolOutput
      ? (o.hookSpecificOutput.updatedToolOutput.stdout ?? o.hookSpecificOutput.updatedToolOutput) : '';
    const outFiles = existsSync(join(dir, 'tokenbrake', 'out')) ? readdirSync(join(dir, 'tokenbrake', 'out')) : [];
    const ledgerPath = join(dir, 'tokenbrake', 'ledger.jsonl');
    const blobRow = existsSync(ledgerPath)
      ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map(l => parse(l)).reverse().find(r => r && r.blob)
      : null;
    rmSync(dir, { recursive: true, force: true });
    return { out, outFiles, blobRow };
  };

  t('off by default: a blob is not elided', !/blob-like output/.test(runBlob(blobLine, null).out), 'off');

  const on = runBlob(blobLine, { blobElide: true });
  t('on: a one-line blob is elided to a descriptor', /\[tokenbrake\] withheld ~\d+ KB of blob-like output/.test(on.out), on.out.slice(-140));
  t('on: the descriptor is far smaller than the blob', on.out.length < blobLine.length * 0.2, `${on.out.length} vs ${blobLine.length}`);
  t('on: the full output is saved to out/ for retrieval', on.outFiles.length === 1, JSON.stringify(on.outFiles));
  t('on: a head is kept so the model can see what it was', on.out.startsWith('const DATA="A1b2'), on.out.slice(0, 24));

  /* Wide but structured: many wide lines, none dominant -- the share guard leaves it whole. */
  const wide = Array.from({ length: 20 }, (_, i) => 'row' + i + ',' + 'x,'.repeat(1200)).join('\n');
  t('a wide multi-line table is left alone (longest line is not most of the output)',
    !/blob-like output/.test(runBlob(wide, { blobElide: true }).out), 'wide');

  /* One long line inside otherwise normal output is not the whole output -- the share guard again. */
  const embedded = Array.from({ length: 200 }, (_, i) => 'log line number ' + i + ' with ordinary content').join('\n') + '\n' + 'z'.repeat(2500);
  t('a single long line inside a normal log does not elide the log',
    !/blob-like output/.test(runBlob(embedded, { blobElide: true }).out), 'embedded');

  t('under blobMinChars nothing is elided', !/blob-like output/.test(runBlob('x'.repeat(2500), { blobElide: true }).out), 'small');

  t('a failed command carrying a blob is not elided (the error is wanted whole)',
    !/blob-like output/.test(runBlob(blobLine, { blobElide: true }, 'cat bundle.min.js', true).out), 'failed');

  /* blobMaxLine is an ABSOLUTE floor, independent of blobMinChars: a small output dominated by a merely-long
     line is not a blob even when the size gate is tuned down, so tuning blobMinChars can't silently weaken it. */
  const modest = 'y'.repeat(900) + '\n' + 'z'.repeat(60);   // one 900-char line, dominant, but under blobMaxLine (2000)
  t('a dominant but sub-blobMaxLine line is not elided even with blobMinChars tuned down',
    !/blob-like output/.test(runBlob(modest, { blobElide: true, blobMinChars: 800 }).out), 'floor');

  /* Accounting under shapeFilters: shaping collapses the progress lines first, the blob line then dominates,
     so the blob fires on the SHAPED text -- and the row's chars must be the shaped size it actually withheld,
     not the pre-shape original, or report/backfire over-credit the saving. */
  const shapedBlob = Array.from({ length: 300 }, (_, i) => `\x1b[32m[${'='.repeat(20)}] ${(i % 100) + 1}% downloading\x1b[0m`).join('\n') + '\n' + 'Q'.repeat(5000);
  const sb = runBlob(shapedBlob, { blobElide: true, shapeFilters: true });
  t('shapeFilters + blobElide: the blob fires on the shaped output', /blob-like output/.test(sb.out), sb.out.slice(-100));
  t('the blob row records the shaped size it withheld, not the pre-shape original',
    sb.blobRow && sb.blobRow.chars < shapedBlob.length * 0.6, JSON.stringify(sb.blobRow && { chars: sb.blobRow.chars, orig: shapedBlob.length }));

  /* The descriptor is clamped under HOOK_OUTPUT_CAP even with a large blobKeepChars, so the marker and the
     recovery note (both at the tail) are never truncated off by Claude Code's 10,000-char hook-output cap. */
  const bigKeep = runBlob('B'.repeat(60000), { blobElide: true, blobKeepChars: 50000 });
  t('a large blobKeepChars still leaves the marker + note intact (descriptor under the hook cap)',
    bigKeep.out.length <= 9500 && /blob-like output/.test(bigKeep.out) && /Read it if you need the raw bytes/.test(bigKeep.out),
    `len=${bigKeep.out.length}`);

  /* Auditor: a blob withhold is counted (kind "blob") and a re-read of its saved out/ file is a backfire,
     through the existing withhold/pull-back machinery -- no narrowing-3-specific audit code. */
  const tr = await import('./transcript.js');
  const T = tr.default || tr;
  const sid = 'b10bf00d-1111-2222-3333-444455556666';
  const stem = (id) => sid.slice(0, 8) + '-' + String(id).slice(-10).replace(/[^\w-]/g, '');
  const BID = 'toolu_01BLOBBBBBBBBBBBBB1';
  const outFile = '/cfg/tokenbrake/out/' + stem(BID) + '.txt';
  const blobTx = { sessionId: sid, cwd: '/w', requests: Array.from({ length: 4 }, () => ({ model: 'claude-opus-5' })), compactions: [],
    results: [
      { id: BID, name: 'Bash', file: null, what: 'cat bundle.min.js', marker: true, tokens: 40, afterReq: 0 },
      { id: 'toolu_RB', name: 'Read', file: outFile, what: outFile, marker: false, tokens: 6000, afterReq: 1 },
    ] };
  const ab = T.backfireAudit(blobTx, [{ ev: 'post', session: sid, id: BID, tool: 'Bash', chars: 30000, kept: 200, blob: true, saved: outFile }], { min: 1 });
  t('a blob withhold is counted with kind "blob"', ab.withholds.length === 1 && ab.withholds[0].kind === 'blob', JSON.stringify(ab.withholds.map(w => w.kind)));
  t('a re-read of the blob\'s saved out/ file is a backfire', ab.backfired === 1 && ab.withholds[0].recovered, JSON.stringify({ b: ab.backfired }));
  t('report byKind labels the blob withhold "blob"', ab.byKind.blob === 1, JSON.stringify(ab.byKind));
}

/* Change-Aware Git View (narrowing 4, off by default): in a `git diff`/`git show`, the hunks of generated
   /lockfile paths are collapsed to a one-line +/- summary while real-source hunks are kept verbatim. A diff
   with no generated files, a non-git command, and a failed command are all left alone. */
{
  console.log('\n-- change-aware git view (narrowing 4, off by default)');
  const lockHunk = ['diff --git a/package-lock.json b/package-lock.json',
    'index 1111111..2222222 100644', '--- a/package-lock.json', '+++ b/package-lock.json',
    '@@ -1,80 +1,80 @@',
    ...Array.from({ length: 80 }, (_, i) => `-    "pkg-${i}": "1.0.${i}",\n+    "pkg-${i}": "1.1.${i}",`)].join('\n');
  const srcHunk = ['diff --git a/src/app.js b/src/app.js', 'index aaaaaaa..bbbbbbb 100644',
    '--- a/src/app.js', '+++ b/src/app.js', '@@ -10,3 +10,3 @@ function main() {',
    ' const a = 1;', '-const x = 1;', '+const x = 2;', ' const b = 3;'].join('\n');
  const diff = lockHunk + '\n' + srcHunk + '\n';

  const runGit = (text, cfgExtra, command = 'git diff', failed = false) => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenbrake-git-'));
    if (cfgExtra) writeFileSync(join(dir, 'tokenbrake.json'), JSON.stringify(cfgExtra));
    const input = { session_id: 'git', tool_use_id: 'toolu_git_' + Math.random().toString(36).slice(2, 8),
      tool_name: 'Bash', tool_input: { command } };
    if (failed) { input.hook_event_name = 'PostToolUseFailure'; input.error = 'Exit code 1\n' + text; }
    else input.tool_response = bashResp(text);
    const r = spawnSync(process.execPath, ['./guard.js', 'post'], { input: JSON.stringify(input), encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
    const o = parse(r.stdout);
    const out = o && o.hookSpecificOutput && o.hookSpecificOutput.updatedToolOutput
      ? (o.hookSpecificOutput.updatedToolOutput.stdout ?? o.hookSpecificOutput.updatedToolOutput) : '';
    const outFiles = existsSync(join(dir, 'tokenbrake', 'out')) ? readdirSync(join(dir, 'tokenbrake', 'out')) : [];
    rmSync(dir, { recursive: true, force: true });
    return { out, outFiles };
  };

  t('off by default: a git diff is not collapsed', !/diff collapsed/.test(runGit(diff, null).out), 'off');

  const on = runGit(diff, { gitView: true });
  t('on: the lockfile hunk is collapsed to a +/- summary', /\+80\/-80 lines, diff collapsed/.test(on.out), on.out.slice(0, 200));
  t('on: the real-source hunk is kept verbatim', on.out.includes('+const x = 2;'), 'src kept');
  t('on: the collapsed diff is smaller than the original', on.out.length < diff.length, `${on.out.length} vs ${diff.length}`);
  t('on: the full diff is saved to out/ for retrieval', on.outFiles.length === 1, JSON.stringify(on.outFiles));
  t('on: the diff --git header for the lockfile is kept (file presence not dropped)', on.out.includes('diff --git a/package-lock.json b/package-lock.json'), 'header kept');

  /* A large diff of only real-source files has nothing generated to collapse -- left whole. */
  const bigSrc = Array.from({ length: 6 }, (_, i) =>
    [`diff --git a/src/mod${i}.js b/src/mod${i}.js`, `index a${i}..b${i} 100644`, `--- a/src/mod${i}.js`, `+++ b/src/mod${i}.js`,
     '@@ -1,20 +1,20 @@', ...Array.from({ length: 20 }, (_, j) => `-old line ${j} of module ${i}\n+new line ${j} of module ${i}`)].join('\n')).join('\n') + '\n';
  t('a diff with no generated files is not collapsed', !/diff collapsed/.test(runGit(bigSrc, { gitView: true }).out), 'no-generated');

  /* Suffix match, not substring: a real-source file whose name merely CONTAINS a pattern (`.map` inside
     `a.mapper.js`) must not be collapsed -- the "real-source hunks kept verbatim" invariant. */
  const mapperDiff = ['diff --git a/src/a.mapper.js b/src/a.mapper.js', 'index e1..e2 100644',
    '--- a/src/a.mapper.js', '+++ b/src/a.mapper.js', '@@ -1,80 +1,80 @@',
    ...Array.from({ length: 80 }, (_, j) => `-const mapping${j} = old;\n+const mapping${j} = new;`)].join('\n') + '\n';
  t('a real-source file whose name contains a pattern substring (.map in a.mapper.js) is NOT collapsed',
    !/diff collapsed/.test(runGit(mapperDiff, { gitView: true }).out), 'suffix');

  /* Never emit MORE than the original: a tiny generated hunk in a big real-source diff shrinks g.text a little,
     but adding the summary note would make the body larger than the diff -- so it is not emitted (falls through). */
  const bigReal = ['diff --git a/src/big.js b/src/big.js', 'index c1..c2 100644', '--- a/src/big.js', '+++ b/src/big.js',
    '@@ -1,60 +1,60 @@', ...Array.from({ length: 60 }, (_, j) => `-old source line ${j} here\n+new source line ${j} here`)].join('\n');
  const tinyLock = ['diff --git a/package-lock.json b/package-lock.json', 'index d1..d2 100644',
    '--- a/package-lock.json', '+++ b/package-lock.json', '@@ -1,1 +1,1 @@', '-  "version": "1.0.0"', '+  "version": "1.0.1"'].join('\n');
  const tinyLockBigSrc = bigReal + '\n' + tinyLock + '\n';
  const tl = runGit(tinyLockBigSrc, { gitView: true }).out;
  t('a collapse that would not shrink the delivered body is not emitted (never larger than the original)',
    !/diff collapsed/.test(tl) && tl.length <= tinyLockBigSrc.length, `len=${tl.length} vs ${tinyLockBigSrc.length}`);

  /* Only a git diff/show -- a non-git command carrying diff-like text is not touched. */
  t('a non-git command with diff-like output is left alone', !/diff collapsed/.test(runGit(diff, { gitView: true }, 'cat changes.patch').out), 'non-git');

  /* git show: the commit preamble before the first `diff --git` is preserved, generated hunk still collapsed. */
  const show = 'commit deadbeef1234\nAuthor: A <a@example.com>\nDate: today\n\n    bump deps\n\n' + diff;
  const onShow = runGit(show, { gitView: true }, 'git show HEAD');
  t('git show keeps the commit preamble and still collapses the lockfile', onShow.out.includes('Author: A <a@example.com>') && /\+80\/-80 lines, diff collapsed/.test(onShow.out), onShow.out.slice(0, 120));

  t('a failed git command is not collapsed (the error is wanted whole)', !/diff collapsed/.test(runGit(diff, { gitView: true }, 'git diff', true).out), 'failed');

  /* Auditor: a gitview withhold is counted (kind "gitview") and a re-read of its saved out/ file is a backfire. */
  const trg = await import('./transcript.js');
  const TG = trg.default || trg;
  const gsid = 'a11ce5ee-2222-3333-4444-555566667777';
  const gstem = (id) => gsid.slice(0, 8) + '-' + String(id).slice(-10).replace(/[^\w-]/g, '');
  const GID = 'toolu_01GITVIEWWWWWWWWWW1';
  const gOut = '/cfg/tokenbrake/out/' + gstem(GID) + '.txt';
  const gitTx = { sessionId: gsid, cwd: '/w', requests: Array.from({ length: 4 }, () => ({ model: 'claude-opus-5' })), compactions: [],
    results: [
      { id: GID, name: 'Bash', file: null, what: 'git diff', marker: true, tokens: 50, afterReq: 0 },
      { id: 'toolu_RG', name: 'Read', file: gOut, what: gOut, marker: false, tokens: 5000, afterReq: 1 },
    ] };
  const ag = TG.backfireAudit(gitTx, [{ ev: 'post', session: gsid, id: GID, tool: 'Bash', chars: 40000, kept: 300, gitview: true, saved: gOut }], { min: 1 });
  t('a gitview withhold is counted with kind "gitview"', ag.withholds.length === 1 && ag.withholds[0].kind === 'gitview', JSON.stringify(ag.withholds.map(w => w.kind)));
  t('a re-read of the gitview saved out/ file is a backfire', ag.backfired === 1 && ag.withholds[0].recovered, JSON.stringify({ b: ag.backfired }));
  t('report byKind labels the gitview withhold "gitview"', ag.byKind.gitview === 1, JSON.stringify(ag.byKind));
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

/* ---- report and report --compare, in tokens only -------------------------------
   Arm B of the feature round (Opus 5): 58 input, 13,902 output, 2,713,808 cache-read and 67,647 cache-write
   tokens. Every figure the report and --compare print for it is a token count or a count, never money. */
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
  console.log('\n-- report and --compare, in tokens only');
  const noMoney = (txt) => !/\$\s?\d|list price|dollar|USD|\bcost\b/i.test(txt.replace(/Every row is tokens or a count -- never money\./, ''));
  const repB = T.renderReport(T.parseTranscript(armB), []);
  t('the report prints no money: no dollar figure, no list price', noMoney(repB) && /Context processed: /.test(repB), (repB.match(/[^\n]*(\$\s?\d|list price)[^\n]*/) || [])[0]);
  t('a model the project never priced reports exactly like any other', noMoney(T.renderReport(T.parseTranscript(odd), [])));
  const cmp = T.renderCompare(T.parseTranscript(armA), T.parseTranscript(armB), []);
  t('--compare: A and B named, no cost row, and says every row is tokens or a count', /A: arma0000\.\.\.  claude-opus-5/.test(cmp) && /B: armb0000\.\.\./.test(cmp)
    && noMoney(cmp) && /Every row is tokens or a count -- never money\./.test(cmp), (cmp.match(/[^\n]*(\$\s?\d|cost)[^\n]*/i) || [])[0]);
  t('--compare: the rows the A/B rounds compared by hand', ['requests', 'cache-read tokens', 'output tokens', 'tool results entered', 'tool results carried', 'trimmed by the guard', 'repeat reads'].every(k => cmp.includes(k)));
  t('--compare: tool results entered halves, and the column says so', /tool results entered\s+2k\s+1k\s+-50%/.test(cmp), cmp.split('\n').find(l => /entered/.test(l)));
  /* Split carried by tool class: a Read result and a Bash result must land in different classes, so the
     change column can say whether the read cap or the shell trim cut the carried context, not one blend. */
  const mk2 = (name, readChars, bashChars) => {
    const L = [];
    L.push(JSON.stringify({ type: 'assistant', requestId: 'q1', uuid: 'q1', sessionId: name, cwd: '/w',
      message: { model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 },
        content: [{ type: 'tool_use', id: 'u1', name: 'Read', input: { file_path: '/w/big.js' } }, { type: 'tool_use', id: 'u2', name: 'Bash', input: { command: 'npm test' } }, { type: 'tool_use', id: 'u3', name: 'Grep', input: { pattern: 'x', path: '/w' } }] } }));
    L.push(JSON.stringify({ type: 'user', uuid: 'u1r', sessionId: name, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'r'.repeat(readChars) }] } }));
    L.push(JSON.stringify({ type: 'user', uuid: 'u2r', sessionId: name, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u2', content: 'b'.repeat(bashChars) }] } }));
    L.push(JSON.stringify({ type: 'user', uuid: 'u3r', sessionId: name, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'u3', content: 'g'.repeat(1000) }] } }));
    L.push(JSON.stringify({ type: 'assistant', requestId: 'q2', uuid: 'q2', sessionId: name, cwd: '/w',
      message: { model: 'claude-opus-5', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'done' }] } }));
    const f = join(dir, name + '.jsonl'); writeFileSync(f, L.join('\n') + '\n'); return f;
  };
  const twoA = mk2('twoa0000', 40000, 8000), twoB = mk2('twob0000', 1200, 8000);   // B: the Read shrank (cap); shell and the untrimmed Grep did not
  const facts = T.sessionFacts(T.parseTranscript(twoA), []);
  t('sessionFacts.byClass separates Read / shell / other, leaves MCP empty',
    facts.byClass.Read.n === 1 && facts.byClass.shell.n === 1 && facts.byClass.other.n === 1 && facts.byClass.MCP.n === 0
    && facts.byClass.Read.entered > facts.byClass.shell.entered, JSON.stringify(facts.byClass));
  const cmp2 = T.renderCompare(T.parseTranscript(twoA), T.parseTranscript(twoB), []);
  t('--compare splits BOTH entered and carried by tool class; present classes shown, MCP omitted',
    /entered: Read/.test(cmp2) && /carried: Read/.test(cmp2) && /entered: shell/.test(cmp2) && /carried: shell/.test(cmp2)
    && /entered: other/.test(cmp2) && /carried: other/.test(cmp2)
    && !/entered: MCP/.test(cmp2) && !/carried: MCP/.test(cmp2),
    cmp2.split('\n').filter(l => /entered:|carried:/.test(l)).join(' | '));
  // change() must not render a signed zero: a sub-percent shrink (10000 -> 9995 tokens) rounds to +0%, not -0%
  const zeroA = mk('zeroa000', 'claude-opus-5', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 }, 40000);
  const zeroB = mk('zerob000', 'claude-opus-5', { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 1, cache_creation_input_tokens: 1 }, 39980);
  const cmpz = T.renderCompare(T.parseTranscript(zeroA), T.parseTranscript(zeroB), []);
  t('--compare: a sub-percent decrease renders +0%, never a signed -0%', !/-0%/.test(cmpz), cmpz.split('\n').find(l => /tool results entered/.test(l)));
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

/* ---- this repo commits NO project-scope install ---------------------------
   tokenbrake installs once, at user scope (README); the repo carries no committed
   `.claude/settings.json`, so a session working on it is braked by a user-scope install
   (the environment Setup script in the cloud), never a doubled second project install.
   Pinning the absence catches an accidental `init --project` committed back into the repo. */
{
  t('repo commits no project-scope install (.claude/settings.json absent)', !existsSync('./.claude/settings.json'));
  t('repo commits no guard copy under .claude/hooks', !existsSync('./.claude/hooks/tokenbrake/guard.js'));
}

/* ---- Wave 1: preset, outputs/show, doctor --------------------------------
   cli.js-only features, no guard-behaviour change. A fresh config dir and a temp cwd so the dual-scope
   check sees no project install regardless of where the suite is run from. */
{
  const cfg = mkdtempSync(join(tmpdir(), 'tokenbrake-w1-'));
  const proj = join(cfg, 'proj'); mkdirSync(proj, { recursive: true });
  const e = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  const cli2 = (a) => spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), ...a], { encoding: 'utf8', env: e, cwd: proj });
  const cfgFile = join(cfg, 'tokenbrake.json');

  // preset (feature 7)
  let r = cli2(['preset', 'aggressive']);
  t('preset aggressive writes tokenbrake.json', r.status === 0 && existsSync(cfgFile));
  let saved = JSON.parse(readFileSync(cfgFile, 'utf8'));
  t('preset aggressive lowers maxChars and turns shapeFilters on, tagged with the preset name',
    saved.maxChars === 3000 && saved.shapeFilters === true && saved.preset === 'aggressive');
  cli2(['preset', 'off']);
  saved = JSON.parse(readFileSync(cfgFile, 'utf8'));
  t('preset off disables the guard but merges, not replaces (a key it does not set survives)',
    saved.enabled === false && saved.maxChars === 3000);
  r = cli2(['preset', 'list']);
  t('preset list names all four presets', /off/.test(r.stdout) && /minimal/.test(r.stdout) && /balanced/.test(r.stdout) && /aggressive/.test(r.stdout));
  r = cli2(['preset', 'nope']);
  t('an unknown preset is rejected non-zero', r.status === 1 && /unknown preset/.test(r.stdout));
  rmSync(cfgFile, { force: true });   // clean slate for the doctor checks below

  // outputs / show (feature 3)
  r = cli2(['outputs']);
  t('outputs on an empty out dir says so, exit 0', r.status === 0 && /No saved outputs/.test(r.stdout));
  const outDir = join(cfg, 'tokenbrake', 'out'); mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'abc12345-xyz9876543.txt'), 'FULL OUTPUT LINE ONE\nFULL OUTPUT LINE TWO\n');
  r = cli2(['outputs']);
  t('outputs lists a saved full output by id', r.status === 0 && /abc12345-xyz9876543/.test(r.stdout));
  r = cli2(['show', 'abc12345-xyz9876543']);
  t('show prints the whole saved output by exact id', r.status === 0 && /FULL OUTPUT LINE TWO/.test(r.stdout));
  r = cli2(['show', 'abc12345']);
  t('show resolves a prefix', r.status === 0 && /FULL OUTPUT LINE ONE/.test(r.stdout));
  r = cli2(['show', 'no-such-id']);
  t('show reports a miss non-zero', r.status === 1 && /No saved output/.test(r.stdout));

  // doctor (feature 4)
  r = cli2(['doctor']);
  t('doctor before install flags no hooks, exit non-zero', r.status === 1 && /no tokenbrake hooks installed/.test(r.stdout));
  cli2(['init']);
  r = cli2(['doctor']);
  t('doctor after init passes, exit 0', r.status === 0 && /all checks passed/.test(r.stdout), r.stdout.split('\n').find(l => /passed|ERROR|WARN/.test(l)));
  const gf = join(cfg, 'hooks', 'tokenbrake', 'guard.js');
  writeFileSync(gf, readFileSync('./guard.js', 'utf8') + '\n// drift\n');
  r = cli2(['doctor']);
  t('doctor detects a stale installed guard, exit non-zero', r.status === 1 && /STALE/.test(r.stdout));
  r = cli2(['doctor', '--fix']);
  t('doctor --fix re-copies the guard and then passes, exit 0', r.status === 0 && /FIXED/.test(r.stdout));
  t('doctor --fix restored the byte-identical guard', readFileSync(gf, 'utf8') === readFileSync('./guard.js', 'utf8'));
  // A CRLF copy of the same code (Windows autocrlf) is not drift -- doctor must pass it, not flag STALE (mirrors status).
  writeFileSync(gf, readFileSync('./guard.js', 'utf8').replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n'));
  r = cli2(['doctor']);
  t('doctor treats a CRLF copy of the same code as matching, not stale (Windows autocrlf)',
    r.status === 0 && !/STALE/.test(r.stdout), r.stdout.split('\n').find(l => /passed|STALE|ERROR/.test(l)));
  writeFileSync(gf, readFileSync('./guard.js', 'utf8'));   // restore an LF copy for the checks below
  writeFileSync(cfgFile, '{ not valid json');
  r = cli2(['doctor']);
  t('doctor flags invalid tokenbrake.json, exit non-zero', r.status === 1 && /not valid JSON/.test(r.stdout));

  rmSync(cfg, { recursive: true, force: true });
}

/* ---- Wave 1: per-tool trim profiles (feature 2) --------------------------
   guard.js resolves a `tools` map (keyed by tool name) over the base config, per tool. */
{
  const cfg = mkdtempSync(join(tmpdir(), 'tokenbrake-tools-'));
  const e = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  const g = (mode, input) => spawnSync(process.execPath, [join(process.cwd(), 'guard.js'), mode], { input: JSON.stringify(input), encoding: 'utf8', env: e });
  const setCfg = (o) => writeFileSync(join(cfg, 'tokenbrake.json'), JSON.stringify(o));
  const uOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput; } catch { return null; } };
  const hOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput; } catch { return null; } };
  const big = Array.from({ length: 400 }, (_, i) => 'line ' + (i + 1) + ' filler filler filler').join('\n');
  const post = () => ({ session_id: 's', tool_use_id: 't1', tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_response: { stdout: big, stderr: '', interrupted: false, isImage: false } });

  setCfg({ maxChars: 100000, tools: { Bash: { maxChars: 200 } } });
  let u = uOf(g('post', post()));
  t('per-tool maxChars trims a tool the base maxChars would have left whole', !!u && /\[tokenbrake\]/.test(u.stdout));

  setCfg({ maxChars: 200, tools: { Bash: { enabled: false } } });
  t('tools.Bash.enabled=false passes Bash through untrimmed (no rewrite emitted)', g('post', post()).stdout.trim() === '');

  setCfg({ maxChars: 200, tools: { PowerShell: { maxChars: 100000 } } });
  u = uOf(g('post', post()));
  t('a tools entry for another tool does not spare Bash: base maxChars still trims it', !!u && /\[tokenbrake\]/.test(u.stdout));

  const bigFile = join(cfg, 'big.txt');
  writeFileSync(bigFile, Array.from({ length: 2000 }, (_, i) => 'line ' + (i + 1)).join('\n'));
  const readPre = () => ({ session_id: 's', tool_name: 'Read', tool_input: { file_path: bigFile } });
  setCfg({ readMaxBytes: 10000000, tools: { Read: { readMaxBytes: 1000, readLimitLines: 50 } } });
  const h = hOf(g('read-pre', readPre()));
  t('a per-tool Read profile caps a read the base readMaxBytes would have left whole, at its own limit', !!h && h.updatedInput && h.updatedInput.limit === 50);
  setCfg({ readMaxBytes: 100, tools: { Read: { enabled: false } } });
  t('tools.Read.enabled=false leaves the read uncapped (no output)', g('read-pre', readPre()).stdout.trim() === '');

  rmSync(cfg, { recursive: true, force: true });
}

/* ---- Wave 2: allow/deny by command or path (feature 9) -------------------- */
{
  const cfg = mkdtempSync(join(tmpdir(), 'tokenbrake-rules-'));
  const e = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  const g = (mode, input) => spawnSync(process.execPath, [join(process.cwd(), 'guard.js'), mode], { input: JSON.stringify(input), encoding: 'utf8', env: e });
  const setCfg = (o) => writeFileSync(join(cfg, 'tokenbrake.json'), JSON.stringify(o));
  const uOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput; } catch { return null; } };
  const hOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput; } catch { return null; } };
  const big = Array.from({ length: 400 }, (_, i) => 'line ' + (i + 1) + ' filler filler').join('\n');
  const post = (cmd) => ({ session_id: 's', tool_use_id: 't1', tool_name: 'Bash', tool_input: { command: cmd }, tool_response: { stdout: big, stderr: '', interrupted: false, isImage: false } });

  // noTrim allowlist for a shell command
  setCfg({ maxChars: 200, noTrim: ['git diff'] });
  t('noTrim leaves a matching shell command whole (no rewrite emitted)', g('post', post('git diff HEAD~1')).stdout.trim() === '');
  t('noTrim does not spare a non-matching command', /\[tokenbrake\]/.test((uOf(g('post', post('npm test'))) || {}).stdout || ''));

  // alwaysCap forces a cat-excerpt cap under readMaxBytes
  setCfg({ maxChars: 200, readMaxBytes: 10000000, readLimitLines: 50, alwaysCap: ['bundle.min.js'] });
  t('alwaysCap caps a cat excerpt that would otherwise be exempt under readMaxBytes', /file excerpt capped/.test((uOf(g('post', post('cat bundle.min.js'))) || {}).stdout || ''));

  // Read side: noTrim protects a path, alwaysCap forces a cap under readMaxBytes
  const lock = join(cfg, 'package-lock.json');
  writeFileSync(lock, Array.from({ length: 500 }, (_, i) => '"dep' + i + '": "1.0.0"').join('\n'));
  const readPre = () => ({ session_id: 's', tool_name: 'Read', tool_input: { file_path: lock } });
  setCfg({ readMaxBytes: 10000000, readLimitLines: 40, alwaysCap: ['package-lock.json'] });
  const h = hOf(g('read-pre', readPre()));
  t('alwaysCap caps a matched read even though it is under readMaxBytes', !!h && h.updatedInput && h.updatedInput.limit === 40);
  setCfg({ readMaxBytes: 100, noTrim: ['package-lock.json'] });
  t('noTrim leaves a matched read uncapped (no output)', g('read-pre', readPre()).stdout.trim() === '');

  rmSync(cfg, { recursive: true, force: true });
}

/* ---- Wave 2: JSON-aware trim (feature 5) ---------------------------------
   OFF by default; when on, a JSON result over maxChars keeps a sample of the big array plus a count,
   instead of a char slice. The full output is saved (this runs only in the trim path), so nothing is lost. */
{
  const cfg = mkdtempSync(join(tmpdir(), 'tokenbrake-json-'));
  const e = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  const g = (input) => spawnSync(process.execPath, [join(process.cwd(), 'guard.js'), 'post'], { input: JSON.stringify(input), encoding: 'utf8', env: e });
  const setCfg = (o) => writeFileSync(join(cfg, 'tokenbrake.json'), JSON.stringify(o));
  const uOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput; } catch { return null; } };
  const arr = JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i, name: 'item-' + i })));
  const post = (stdout) => ({ session_id: 's', tool_use_id: 't1', tool_name: 'Bash', tool_input: { command: 'curl api' }, tool_response: { stdout, stderr: '', interrupted: false, isImage: false } });

  setCfg({ maxChars: 200, jsonShape: true, jsonSampleItems: 3 });
  let u = uOf(g(post(arr)));
  t('jsonShape keeps a sample of a big top-level array and states the count', !!u && /showing the first 3 of 100 array items/.test(u.stdout));
  t('jsonShape keeps the kept sample as valid JSON', !!u && (() => { try { JSON.parse(u.stdout.split('\n[tokenbrake]')[0]); return true; } catch { return false; } })());

  setCfg({ maxChars: 200 });   // default: jsonShape off
  u = uOf(g(post(arr)));
  t('with jsonShape off the same JSON gets the ordinary trim, not the item-count note', !!u && !/array items/.test(u.stdout) && /omitted here/.test(u.stdout));

  const obj = JSON.stringify({ total: 100, items: Array.from({ length: 100 }, (_, i) => ({ id: i })) });
  setCfg({ maxChars: 200, jsonShape: true, jsonSampleItems: 2 });
  u = uOf(g(post(obj)));
  t('jsonShape cuts the dominant array property of an object and names it', !!u && /the "items" array was cut to its first 2 of 100/.test(u.stdout));

  setCfg({ maxChars: 200, jsonShape: true });
  u = uOf(g(post('x'.repeat(9000))));   // not JSON
  t('jsonShape falls back to the ordinary trim on non-JSON output', !!u && /omitted here/.test(u.stdout) && !/array items/.test(u.stdout));

  rmSync(cfg, { recursive: true, force: true });
}

/* ---- report --cost is retired -------------------------------------------------
   It stated sessions in money; tokenbrake states everything in tokens. It must say so and exit non-zero, never
   fall through to the plain report where a script would read it as the old view. */
{
  const cfg = mkdtempSync(join(tmpdir(), 'tokenbrake-cost-'));
  mkdirSync(join(cfg, 'projects', '-w'), { recursive: true });
  const M = 1000000;
  const u = { input_tokens: M, output_tokens: M, cache_read_input_tokens: M, cache_creation_input_tokens: M };
  writeFileSync(join(cfg, 'projects', '-w', 'cost-1.jsonl'),
    JSON.stringify({ type: 'assistant', requestId: 'r1', uuid: 'r1-a', sessionId: 'cost-1', cwd: '/w', message: { model: 'claude-opus-5', usage: u, content: [{ type: 'text', text: 'hi' }] } }) + '\n');
  const e = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  const cost = (a) => spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), 'report', '--cost', ...a], { encoding: 'utf8', env: e });

  let r = cost([]);
  t('report --cost says it was removed, in favour of tokens, and exits non-zero',
    r.status === 1 && /report --cost was removed: tokenbrake reports tokens only/.test(r.stdout) && !/\$\s?\d/.test(r.stdout), r.stdout.slice(0, 160));
  r = cost(['--model=sonnet']);
  t('report --cost --model is refused the same way, never a repricing', r.status === 1 && /was removed/.test(r.stdout) && !/\$\s?\d/.test(r.stdout));

  rmSync(cfg, { recursive: true, force: true });
}

/* ---- Offline shadow: dedup, reReadElide, readAfterEdit replayed over a transcript ----------------------------
   The replay asks the guard's own exported decisions at each step, so these checks are about the replay's
   bookkeeping: that it fires where the guard would, stays quiet where the guard would, and stays conservative
   where a transcript cannot see what the guard sees. */
{
  const tr = await import('./transcript.js');
  const T = tr.default || tr;
  console.log('\n-- offline shadow: stateful features replayed');
  let n = 0;
  const R = (name, extra) => ({ id: 'o' + (++n), name, what: name, chars: 4000, tokens: 1000, carriedTurns: 3, afterReq: 0,
    isError: false, marker: false, file: null, whole: false, lines: 1, ...(extra || {}) });
  const read = (file, extra) => R('Read', { file, whole: true, lines: 400, shape: { bytes: 16000, lines: 400 }, ...(extra || {}) });
  const sess = (results, extra) => ({ sessionId: 'OF', cwd: '/w', requests: [{}, {}, {}, {}], compactions: [], results, ...(extra || {}) });
  const off = (p, led, cfg) => T.offlineShadow(p, led || [], cfg || {});
  const GD = createRequire(import.meta.url)('./guard.js');
  const noteTok = (s) => Math.round(s.length / 4);   // the narrowings' own note enters context too, so it is priced

  // dedup
  const dupA = R('Bash', { what: 'npm test', hash: 'h1', chars: 4000 }), dupB = R('Bash', { what: 'npm test', hash: 'h1', chars: 4000 });
  const d1 = off(sess([dupA, dupB]));
  t('dedup replay: an identical second result over the floor is a would-dedup, priced as what the pointer would save',
    d1.dedup.n === 1 && d1.dedup.withheld > 900 && d1.dedup.withheld < 1000, JSON.stringify(d1.dedup));
  t('dedup replay: a trimmed result (marker) cannot be matched and is skipped, an under-count',
    off(sess([dupA, R('Bash', { hash: 'h1', marker: true })])).dedup.n === 0);
  t('dedup replay: a noTrim command is left alone, as the guard leaves it', off(sess([dupA, dupB]), [], { noTrim: ['npm test'] }).dedup.n === 0);
  t('dedup replay: below dedupMinChars is not a repeat worth a pointer', off(sess([dupA, dupB]), [], { dedupMinChars: 5000 }).dedup.n === 0);
  t('a session where the feature ran live is skipped for it: its measured record is the evidence',
    off(sess([dupA, dupB]), [{ ev: 'post', session: 'OF', dedup: true }]).live.dedup === true
    && off(sess([dupA, dupB]), [{ ev: 'post', session: 'OF', dedup: true }]).dedup.n === 0);

  // reReadElide
  const r2 = off(sess([read('/w/a.js'), read('/w/b.js'), read('/w/a.js')]));
  t('reReadElide replay: an unchanged, recent whole re-read is a would-elide, priced as all but the kept lines',
    r2.reReadElide.n === 1 && r2.reReadElide.withheld === Math.round(1000 * (1 - 5 / 400)) - noteTok(GD.reReadNote('a.js', 5, 400)), JSON.stringify(r2.reReadElide));
  t('reReadElide replay: any shell command between the two reads disqualifies them (it could have changed the file)',
    off(sess([read('/w/a.js'), R('Bash', { what: 'npm run format' }), read('/w/a.js')])).reReadElide.n === 0);
  t('reReadElide replay: an edit of the file between the reads disqualifies them',
    off(sess([read('/w/a.js'), R('Edit', { file: '/w/a.js', patch: [[3, 4]] }), read('/w/a.js')])).reReadElide.n === 0);
  t('reReadElide replay: a compaction between the reads disqualifies them (the model no longer has the first)',
    off(sess([read('/w/a.js', { afterReq: 0 }), read('/w/a.js', { afterReq: 2 })], { compactions: [1] })).reReadElide.n === 0);
  t('reReadElide replay: a read no longer recent (reReadRecency others since) is not elided, as in the guard',
    off(sess([read('/w/a.js'), ...Array.from({ length: 8 }, (_, i) => read('/w/x' + i + '.js')), read('/w/a.js')])).reReadElide.n === 0);
  t('reReadElide replay: an elided re-read is not recorded, so a third read counts once more, as in the guard',
    off(sess([read('/w/a.js'), read('/w/a.js'), read('/w/a.js')])).reReadElide.n === 2);

  t('a read of a file the guard itself capped or narrowed this session is never replayed (the guard already acted on it)',
    off(sess([read('/w/a.js'), read('/w/a.js')]), [{ ev: 'read-cap', session: 'OF', what: '/w/a.js' }]).reReadElide.n === 0);
  t('a numbered excerpt that does not start at line 1 is not a whole read, whatever its input said',
    off(sess([read('/w/a.js'), read('/w/a.js', { shape: { bytes: 16000, lines: 400, numbered: true, from: 301 } })])).reReadElide.n === 0);
  t('a noTrim path is left alone by both Read narrowings, as the guard leaves it',
    off(sess([read('/w/a.js'), read('/w/a.js')]), [], { noTrim: ['a.js'] }).reReadElide.n === 0);
  t('dedup honours noTrim on the RAW command, not the cleaned-up one',
    off(sess([R('Bash', { what: 'npm test', cmd: 'CI=1 npm test', hash: 'h9' }), R('Bash', { what: 'npm test', cmd: 'CI=1 npm test', hash: 'h9' })]), [], { noTrim: ['CI=1'] }).dedup.n === 0);

  // readAfterEdit
  const e1 = off(sess([R('Edit', { file: '/w/a.js', patch: [[10, 12]] }), read('/w/a.js')]));
  t('readAfterEdit replay: a whole read after an edit narrows to the guard\'s own window around the edit',
    e1.readAfterEdit.n === 1 && e1.readAfterEdit.withheld === Math.round(1000 * (1 - 32 / 400)) - noteTok(GD.deltaNote('a.js', 1, 32, 400)), JSON.stringify(e1.readAfterEdit));
  t('readAfterEdit replay: an edit with no line ranges is counted as not replayable, never guessed',
    off(sess([R('Edit', { file: '/w/a.js', patch: [] }), read('/w/a.js')])).editsNoPatch === 1
    && off(sess([R('Edit', { file: '/w/a.js', patch: [] }), read('/w/a.js')])).readAfterEdit.n === 0);
  t('readAfterEdit replay: a whole read over readMaxBytes is the cap\'s, not the delta\'s',
    off(sess([R('Edit', { file: '/w/a.js', patch: [[10, 12]] }), read('/w/a.js', { shape: { bytes: 90000, lines: 400 } })])).readAfterEdit.n === 0);

  /* The line ranges come from Claude Code's structuredPatch, read with the guard's own patchRanges at parse time. */
  {
    const dir = mkdtempSync(join(tmpdir(), 'tokenbrake-offline-'));
    const f = join(dir, 'pt.jsonl');
    writeFileSync(f, [
      JSON.stringify({ type: 'assistant', uuid: 'a1', sessionId: 'pt', cwd: '/w', message: { model: 'm', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/w/a.js', old_string: 'x', new_string: 'y' } }] } }),
      JSON.stringify({ type: 'user', uuid: 'u1', sessionId: 'pt', toolUseResult: { filePath: '/w/a.js', structuredPatch: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [] }] },
        message: { content: [{ type: 'tool_result', tool_use_id: 'e1', content: 'The file /w/a.js has been updated successfully.' }] } }),
    ].join('\n') + '\n');
    const pr = T.parseTranscript(f);
    t('an Edit\'s line ranges are parsed from structuredPatch with the guard\'s own patchRanges', JSON.stringify(pr.results[0].patch) === '[[10,12]]', JSON.stringify(pr.results[0].patch));
    rmSync(dir, { recursive: true, force: true });
  }

  /* In report: one line for the session, in tokens, the person's own settings honoured, live features named. */
  const rp = sess([read('/w/a.js'), read('/w/b.js'), read('/w/a.js')], { file: '/w/OF.jsonl', requests: [{}, {}, {}, {}, {}, {}] });
  const rt = T.renderReport(rp, []);
  t('report carries the replay line for the session, in tokens, with its caveat and how to try it',
    /Off-by-default features, replayed over this session with the guard's own decisions: reReadElide \(re-reads\) would have acted on 1, ~ \S+ tokens kept out/.test(rt)
    && /dedup \(repeat results\), readAfterEdit \(reads after an edit\): nothing to act on in this session/.test(rt)
    && /not measured/.test(rt) && /set "reReadElide": true/.test(rt) && !/\$\s?\d/.test(rt),
    rt.split('\n').find(l => /Off-by-default features, replayed/.test(l)));
  t('report names a feature that ran live and points at its record instead of replaying it',
    /ran live here: reReadElide -- report --backfire has its record/.test(T.renderReport(rp, [{ ev: 'read-reread', session: 'OF', what: '/w/zz.js' }])));
  /* A feature ON in the config saw those results live and passed on them; "would have acted" would contradict it. */
  const onRt = T.renderReport(rp, [], { userCfg: { reReadElide: true } });
  t('report never replays a feature that is on in the config, only names it',
    /on in your config: reReadElide/.test(onRt) && !/reReadElide \(re-reads\) would have acted/.test(onRt), onRt.split('\n').find(l => /Off-by-default/.test(l)));
  t('a feature on only under a tools entry counts as on, as the guard applies it',
    /on in your config: reReadElide/.test(T.renderReport(rp, [], { userCfg: { tools: { Read: { reReadElide: true } } } })));
  t("report honours the person's own settings in the replay (noTrim)",
    /reReadElide \(re-reads\) would have acted/.test(rt)
    && !/reReadElide \(re-reads\) would have acted/.test(T.renderReport(rp, [], { userCfg: { noTrim: ['a.js'] } })));
  t('the replay applies per-tool settings the way the guard merges them (tools.Read.readMaxBytes)',
    off(rp, [], { tools: { Read: { readMaxBytes: 1000 } } }).reReadElide.n === 0 && off(rp, [], {}).reReadElide.n === 1);

  /* tune --sweep: the replay re-run per knob value, one knob at a time, the person's own value always a row. */
  {
    const sw = T.sweepOffline([sess([read('/w/a.js'), read('/w/b.js'), read('/w/c.js'), read('/w/d.js'), read('/w/a.js')])], [], {});
    const row = (knob, v) => sw.find(s => s.knob === knob).rows.find(r => r.value === v);
    t('the sweep moves with the knob: a re-read 3 reads later is recent at reReadRecency 4, not at 2',
      row('reReadRecency', 2).n === 0 && row('reReadRecency', 4).n === 1 && row('reReadRecency', 8).n === 1, JSON.stringify(sw.find(s => s.knob === 'reReadRecency').rows));
    t('keeping more lines of a re-read withholds less, in tokens',
      row('reReadKeepLines', 1).withheld > row('reReadKeepLines', 50).withheld && row('reReadKeepLines', 50).withheld > 0);
    const own = T.sweepOffline([sess([read('/w/a.js')])], [], { dedupMinChars: 777 });
    t("the person's own value is always one of the rows, and marked as current",
      own.find(s => s.knob === 'dedupMinChars').current === 777 && own.find(s => s.knob === 'dedupMinChars').rows.some(r => r.value === 777));
    const lv = T.sweepOffline([sess([read('/w/a.js'), read('/w/a.js')])], [{ ev: 'read-reread', session: 'OF', what: '/w/zz.js' }], {});
    t('a session where the feature ran live is left out of its sweep, and the row says how many sessions it covers',
      lv.find(s => s.knob === 'reReadRecency').rows.every(r => r.n === 0 && r.replayed === 0));
  }

  {
    /* A tools entry that sets the knob would override the swept top-level value; the sweep applies each value there too. */
    const scopedSw = T.sweepOffline([sess([read('/w/a.js'), read('/w/b.js'), read('/w/c.js'), read('/w/d.js'), read('/w/a.js')])], [], { tools: { Read: { reReadRecency: 2 } } });
    const rs = scopedSw.find(s => s.knob === 'reReadRecency');
    t('a per-tool entry does not flatten the sweep: each value is applied to it too, and the entry is reported',
      rs.rows.find(r => r.value === 2).n === 0 && rs.rows.find(r => r.value === 4).n === 1 && rs.scoped.length === 1 && rs.scoped[0].tool === 'Read', JSON.stringify(rs));
    const strSw = T.sweepOffline([sess([read('/w/a.js')])], [], { editContextLines: '20' }).find(s => s.knob === 'editContextLines');
    t('a knob written as a string is reported as such, never coerced into a marked row', strSw.raw === '20' && Number.isNaN(strSw.current));
  }

  /* In tune: the replay replaces the estimators, and a replay that saw nothing reads as nothing to act on. */
  const tp = sess([read('/w/a.js'), read('/w/b.js'), read('/w/a.js')], { file: '/w/OF.jsonl', requests: [{}, {}, {}, {}, {}, {}] });
  const at = T.autotune([tp], [], { reReadElide: false, readAfterEdit: false, dedup: false });
  const fr = at.features.find(f => f.key === 'reReadElide'), fe = at.features.find(f => f.key === 'readAfterEdit');
  t('tune reads a stateful feature from its offline replay, never more than a "try"',
    fr.bound === 'offline' && fr.opportunity.n === 1 && ['try', 'measure', 'idle'].includes(fr.status) && fr.status !== 'turn-on', JSON.stringify({ b: fr.bound, o: fr.opportunity, s: fr.status }));
  t('and a replay that saw nothing is "nothing to act on", not an estimate', fe.bound === 'offline' && fe.opportunity.n === 0 && fe.status === 'idle', JSON.stringify({ s: fe.status }));
}

/* ---- Shadow mode (item 5): an off feature runs its test, logs, and emits NOTHING --------------------------
   The whole claim is that shadow changes nothing that enters context, so the first check is byte-identical
   output with shadow on and off. Then: the row it writes, the rows it must not write, and that `tune` reads
   the rows as an exact opportunity rather than the off-state estimate. */
{
  const tr = await import('./transcript.js');
  const T = tr.default || tr;
  console.log('\n-- shadow mode: evidence without a live run');
  const runShadow = (text, cfgExtra, command, mcpTool) => {
    const dir = mkdtempSync(join(tmpdir(), 'tokenbrake-shadow-'));
    if (cfgExtra) writeFileSync(join(dir, 'tokenbrake.json'), JSON.stringify(cfgExtra));
    const input = mcpTool
      ? { session_id: 'shadowses', tool_use_id: 'toolu_sh_1', tool_name: mcpTool, tool_input: {}, tool_response: [{ type: 'text', text }] }
      : { session_id: 'shadowses', tool_use_id: 'toolu_sh_1', tool_name: 'Bash', tool_input: { command }, tool_response: bashResp(text) };
    const r = spawnSync(process.execPath, ['./guard.js', 'post'], { input: JSON.stringify(input), encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: dir } });
    const lp = join(dir, 'tokenbrake', 'ledger.jsonl');
    const rows = existsSync(lp) ? readFileSync(lp, 'utf8').split('\n').filter(Boolean).map(parse) : [];
    const outFiles = existsSync(join(dir, 'tokenbrake', 'out')) ? readdirSync(join(dir, 'tokenbrake', 'out')) : [];
    rmSync(dir, { recursive: true, force: true });
    /* Each run has its own config dir, and a trim note names the saved file's path inside it -- blank the dir
       out (in both JSON-escaped and plain forms) so the comparison is of what the guard emitted, not where. */
    const stdout = r.stdout.split(JSON.stringify(dir).slice(1, -1)).join('<DIR>').split(dir).join('<DIR>');
    return { stdout, status: r.status, rows, shadows: rows.filter(x => x && x.ev === 'shadow'), outFiles };
  };
  const blob = 'A'.repeat(20000);
  const lock = ['diff --git a/package-lock.json b/package-lock.json', 'index 1111111..2222222 100644',
    '--- a/package-lock.json', '+++ b/package-lock.json', '@@ -1,80 +1,80 @@',
    ...Array.from({ length: 80 }, (_, i) => `-    "pkg-${i}": "1.0.${i}",\n+    "pkg-${i}": "1.1.${i}",`),
    'diff --git a/src/app.js b/src/app.js', '--- a/src/app.js', '+++ b/src/app.js', '@@ -1,1 +1,1 @@', '-const x = 1;', '+const x = 2;'].join('\n') + '\n';

  for (const [label, text, cmd] of [['blob', blob, 'cat bundle.min.js | head -c 20000'], ['git diff', lock, 'git diff']]) {
    const on = runShadow(text, null, cmd), off = runShadow(text, { shadow: false }, cmd);
    t(`shadow changes nothing that enters context (${label}): output byte-identical with it on and off`,
      on.stdout === off.stdout && on.status === 0 && off.status === 0, `${on.stdout.length} vs ${off.stdout.length}`);
    t(`and it saves nothing: no out/ file beyond what the live path wrote (${label})`, on.outFiles.length === off.outFiles.length,
      JSON.stringify({ on: on.outFiles, off: off.outFiles }));
    t(`shadow off writes no shadow row (${label})`, off.shadows.length === 0);
  }
  const b = runShadow(blob, null, 'cat bundle.min.js | head -c 20000');
  t('shadow on by default: an off blobElide logs what it would have withheld',
    b.shadows.length === 1 && b.shadows[0].feature === 'blobElide' && b.shadows[0].chars === 20000
    && b.shadows[0].kept > 0 && b.shadows[0].kept < 1000 && b.shadows[0].id === 'toolu_sh_1', JSON.stringify(b.shadows));
  const gd = runShadow(lock, null, 'git diff');
  t('and an off gitView logs its collapse, with the kept real-source body',
    gd.shadows.length === 1 && gd.shadows[0].feature === 'gitView' && gd.shadows[0].collapsed === 1
    && gd.shadows[0].kept < gd.shadows[0].chars, JSON.stringify(gd.shadows));
  /* One decision feeds both paths, fitted the same way with the same saved-path note, so the shadow's kept is the
     live feature's kept exactly -- the claim that makes a shadow row evidence rather than an estimate. */
  const liveBlob = runShadow(blob, { blobElide: true }, 'cat bundle.min.js | head -c 20000').rows.find(x => x && x.blob);
  const liveGit = runShadow(lock, { gitView: true }, 'git diff').rows.find(x => x && x.gitview);
  t('the shadow measures what the live feature would emit, byte for byte',
    liveBlob && liveGit && liveBlob.kept === b.shadows[0].kept && liveGit.kept === gd.shadows[0].kept,
    JSON.stringify({ blob: [liveBlob && liveBlob.kept, b.shadows[0].kept], git: [liveGit && liveGit.kept, gd.shadows[0].kept] }));
  /* mcpTrim, the third stateless feature: the same guarantees on an MCP content-block result. */
  const mcpText = Array.from({ length: 400 }, (_, i) => '{"sha":"' + i.toString(16).padStart(40, '0') + '","author":"dev","message":"commit ' + i + '"}').join('\n');
  const MT = 'mcp__github__list_commits';
  const mOn = runShadow(mcpText, null, null, MT), mOff = runShadow(mcpText, { shadow: false }, null, MT);
  t('shadow changes nothing that enters context (mcp): output byte-identical with it on and off',
    mOn.stdout === mOff.stdout && mOn.status === 0 && mOn.stdout === '', `${mOn.stdout.length} vs ${mOff.stdout.length}`);
  t('and it saves nothing (mcp)', mOn.outFiles.length === 0 && mOff.shadows.length === 0, JSON.stringify(mOn.outFiles));
  const liveMcp = runShadow(mcpText, { mcpTrim: true }, null, MT).rows.find(x => x && x.mcp);
  t('an off mcpTrim logs what it would have withheld, byte for byte what the live trim emits',
    mOn.shadows.length === 1 && mOn.shadows[0].feature === 'mcpTrim' && mOn.shadows[0].chars === mcpText.length
    && !!liveMcp && liveMcp.kept === mOn.shadows[0].kept, JSON.stringify({ shadow: mOn.shadows[0], live: liveMcp && liveMcp.kept }));
  t('a noTrim entry for the tool keeps the shadow away too, as it keeps the live trim away',
    runShadow(mcpText, { noTrim: ['mcp__github'] }, null, MT).shadows.length === 0);
  t('a live feature is not also shadowed', runShadow(blob, { blobElide: true }, 'cat bundle.min.js | head -c 20000').shadows.length === 0);
  t('output its test rejects writes no shadow row', runShadow('line of ordinary output\n'.repeat(900), null, 'npm test').shadows.length === 0);

  /* The join: rows priced against the transcript, one per result, only for this session, only known features. */
  const p = { sessionId: 'S', results: [{ id: 'a', chars: 20000, carriedTurns: 4 }, { id: 'b', chars: 8000, carriedTurns: 0 }, { id: 'c', chars: 6000, marker: true, carriedTurns: 1 }] };
  const led = [
    { ev: 'shadow', session: 'S', id: 'a', feature: 'blobElide', chars: 20000, kept: 400 },
    { ev: 'shadow', session: 'S', id: 'a', feature: 'blobElide', chars: 20000, kept: 400 },   // a doubled install
    { ev: 'shadow', session: 'S', id: 'b', feature: 'gitView', chars: 8000, kept: 2000 },
    { ev: 'shadow', session: 'OTHER', id: 'b', feature: 'gitView', chars: 8000, kept: 2000 },
    { ev: 'shadow', session: 'S', id: 'a', feature: '__proto__', chars: 1, kept: 0 },
    { ev: 'shadow', session: 'S', id: 'zz', feature: 'gitView', chars: 8000, kept: 0 },       // not in this transcript
  ];
  /* A result the always-on trim already cut entered at its trimmed size; the feature's own saving is only what it
     would have taken on top of that, or the trim's saving is counted twice. */
  const trimmedFirst = T.shadowRecord(p, [{ ev: 'shadow', session: 'S', id: 'c', feature: 'blobElide', chars: 90000, kept: 400 }]);
  t('a shadowed result the trim already cut is priced against what entered, not its pre-trim size',
    trimmedFirst.blobElide.withheld === 1400 && trimmedFirst.blobElide.carried === 2800, JSON.stringify(trimmedFirst.blobElide));
  const sr = T.shadowRecord(p, led);
  t('shadowRecord prices each row as withheld tokens and carried token-reads, once per result',
    sr.blobElide.n === 1 && sr.blobElide.withheld === 4900 && sr.blobElide.carried === 4900 * 5
    && sr.gitView.n === 1 && sr.gitView.withheld === 1500 && sr.gitView.carried === 1500, JSON.stringify(sr));
  t('and ignores other sessions, unknown features and results it cannot price',
    Object.keys(sr).sort().join() === 'blobElide,gitView,mcpTrim,ran' && !Object.prototype.hasOwnProperty.call(sr, '__proto__'));

  const tp = { sessionId: 'S', file: '/w/S.jsonl', cwd: '/w', requests: [{}, {}, {}, {}, {}, {}], compactions: [],
    results: [{ id: 'a', name: 'Bash', what: 'cat x', chars: 20000, tokens: 5000, afterReq: 0, isError: false, marker: false }] };
  const at = T.autotune([tp], [{ ev: 'post', session: 'S', tool: 'Bash', chars: 10, sh: 1 }, led[0]], { blobElide: false });
  const fb = at.features.find(f => f.key === 'blobElide');
  t('tune reads a shadowed feature as an exact opportunity, never more than a "try"',
    fb.bound === 'shadow' && fb.opportunity.n === 1 && fb.opportunity.withheld === 4900 && fb.status === 'try', JSON.stringify({ b: fb.bound, o: fb.opportunity, s: fb.status }));
  /* Shadow ran (rows marked sh) and saw nothing: an answer, not a fallback to the off-state estimate. */
  const idle = T.autotune([tp], [{ ev: 'post', session: 'S', tool: 'Bash', chars: 10, sh: 1 }], { gitView: false });
  const fg = idle.features.find(f => f.key === 'gitView');
  t('a shadow that ran and saw nothing reads as nothing to act on, not as an estimate to try',
    fg.bound === 'shadow' && fg.opportunity.n === 0 && fg.status === 'idle' && idle.summary.idle.includes(fg.label), JSON.stringify({ b: fg.bound, s: fg.status }));
  /* A session with no shadow marks keeps the estimate; one with them gives the exact record; the total says which. */
  const tq = { ...tp, sessionId: 'Q', file: '/w/Q.jsonl', results: [{ ...tp.results[0], id: 'q', what: 'cat big.min.js | head', lines: 1 }] };
  const mixed = T.autotune([tp, tq], [{ ev: 'post', session: 'S', tool: 'Bash', chars: 10, sh: 1 }, led[0]], { blobElide: false });
  const fm = mixed.features.find(f => f.key === 'blobElide');
  t('shadow and estimate are chosen per session, and a mixed total says which part is which',
    fm.bound === 'mixed' && fm.opportunity.shadowN === 1 && fm.opportunity.estimateN >= 1 && fm.opportunity.shadowSessions === 1, JSON.stringify(fm.opportunity));
  /* A gitView collapse can keep more than the trim let in; that result counts against the feature, never for it. */
  const grew = T.shadowRecord({ sessionId: 'S', results: [{ id: 'g', chars: 6000, marker: true, carriedTurns: 3 }] },
    [{ ev: 'shadow', session: 'S', id: 'g', feature: 'gitView', chars: 40000, kept: 9000, sh: 1 }]);
  /* A result the HOST swapped for a preview (no trim marker, far smaller than what the guard saw) is not growth:
     the feature acts before the swap, so its cost is not priced here at all. */
  const swapped = T.shadowRecord({ sessionId: 'S', results: [{ id: 'm', chars: 2000, marker: false, carriedTurns: 3 }] },
    [{ ev: 'shadow', session: 'S', id: 'm', feature: 'mcpTrim', chars: 150000, kept: 6000, sh: 1 }]);
  t('a result the host swapped for a preview is counted apart, not as growth and not as a saving',
    swapped.mcpTrim.hostSwapped === 1 && swapped.mcpTrim.grew === 0 && swapped.mcpTrim.n === 0, JSON.stringify(swapped.mcpTrim));
  /* And the estimator is off in a shadowed session, so mcpTrim is not counted twice there. */
  const mcpSess = { sessionId: 'M', file: '/w/M.jsonl', cwd: '/w', requests: [{}, {}, {}, {}], compactions: [],
    results: [{ id: 'mm', name: 'mcp__x__y', what: 'mcp__x__y', chars: 10000, tokens: 2500, afterReq: 0, isError: false, marker: false }] };
  const am = T.autotune([mcpSess], [{ ev: 'post', session: 'M', tool: 'mcp__x__y', chars: 10000, sh: 1 },
    { ev: 'shadow', session: 'M', id: 'mm', tool: 'mcp__x__y', feature: 'mcpTrim', chars: 10000, kept: 6000, sh: 1 }], { mcpTrim: false });
  const fmc = am.features.find(f => f.key === 'mcpTrim');
  t('in a shadowed session mcpTrim is read from its shadow alone, not also from the estimator',
    fmc.bound === 'shadow' && fmc.opportunity.n === 1 && fmc.opportunity.estimateN === 0, JSON.stringify(fmc.opportunity));
  t('a shadowed result that would grow context is counted apart, never as an opportunity',
    grew.gitView.n === 0 && grew.gitView.grew === 1 && grew.gitView.withheld === 0 && grew.ran === true, JSON.stringify(grew.gitView));
}

/* ---- Wave 2: dedup of repeated results (feature 6) ------------------------
   The same result twice in a session is paid for twice; when it repeats, the guard hands back a pointer to
   the first copy. Off by default; A/B gates it. Bash/PowerShell + MCP, over dedupMinChars, honoring noTrim. */
{
  const cfg = mkdtempSync(join(tmpdir(), 'tokenbrake-dedup-'));
  const e = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  const g = (input) => spawnSync(process.execPath, [join(process.cwd(), 'guard.js'), 'post'], { input: JSON.stringify(input), encoding: 'utf8', env: e });
  const cli2 = (a) => spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), ...a], { encoding: 'utf8', env: e });
  const setCfg = (o) => writeFileSync(join(cfg, 'tokenbrake.json'), JSON.stringify(o));
  const uOf = (r) => { if (!r.stdout.trim()) return null; try { return JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput; } catch { return null; } };
  const big = 'x'.repeat(2000);
  const bash = (id, out, sess = 's1') => ({ session_id: sess, tool_use_id: id, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: out, stderr: '', interrupted: false, isImage: false } });

  setCfg({ dedup: true });
  t('dedup: first occurrence is not rewritten (recorded, passed through)', g(bash('toolu_A', big)).stdout.trim() === '');
  const u = uOf(g(bash('toolu_B', big)));
  t('dedup: an identical second result becomes a pointer to the first', !!u && /identical to an earlier result this session \(2,000 chars\)/.test(u.stdout) && /show s1-toolu_A/.test(u.stdout));
  const show = cli2(['show', 's1-toolu_A']);
  t('dedup: the pointer id is retrievable via tokenbrake show', show.status === 0 && show.stdout.startsWith('x'.repeat(50)));
  const led = readFileSync(join(cfg, 'tokenbrake', 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const drow = led.find(x => x.id === 'toolu_B');
  t('dedup: ledger row carries dedup:true, sameAs, chars(full) and kept(pointer)', !!drow && drow.dedup === true && drow.sameAs === 's1-toolu_A' && drow.chars === 2000 && drow.kept < 200);
  t('dedup: a different result is not pointed', g(bash('toolu_C', 'z'.repeat(2000))).stdout.trim() === '');

  setCfg({ dedup: true, dedupMinChars: 1000 });
  const small = 'y'.repeat(500);
  g(bash('toolu_D', small, 's2'));
  t('dedup: a repeat under dedupMinChars is left alone', g(bash('toolu_E', small, 's2')).stdout.trim() === '');

  setCfg({ dedup: true, noTrim: ['git diff'] });
  const gd = (id) => ({ session_id: 's3', tool_use_id: id, tool_name: 'Bash', tool_input: { command: 'git diff' }, tool_response: { stdout: big, stderr: '', interrupted: false, isImage: false } });
  g(gd('toolu_G1'));
  t('dedup: a noTrim command is never deduped', g(gd('toolu_G2')).stdout.trim() === '');

  setCfg({});
  g(bash('toolu_H1', big, 's5'));
  t('dedup off by default: an identical repeat is not pointed', g(bash('toolu_H2', big, 's5')).stdout.trim() === '');

  setCfg({ dedup: true });
  const mcp = (id) => ({ session_id: 's4', tool_use_id: id, tool_name: 'mcp__x__y', tool_input: {}, tool_response: [{ type: 'text', text: big }] });
  g(mcp('toolu_MC1'));
  const um = uOf(g(mcp('toolu_MC2')));
  t('dedup: an identical MCP result becomes a content-block array pointer', Array.isArray(um) && /identical to an earlier result/.test(um[0].text));

  rmSync(cfg, { recursive: true, force: true });
}

/* ---- code-review fixes (findings 1-6) ------------------------------------ */
{
  const cfg = mkdtempSync(join(tmpdir(), 'tokenbrake-crfix-'));
  const proj = mkdtempSync(join(tmpdir(), 'tokenbrake-crproj-'));
  const e = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  const g = (mode, input) => spawnSync(process.execPath, [join(process.cwd(), 'guard.js'), mode], { input: JSON.stringify(input), encoding: 'utf8', env: e });
  const cli2 = (a) => spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), ...a], { encoding: 'utf8', env: e });
  const setCfg = (o) => writeFileSync(join(cfg, 'tokenbrake.json'), JSON.stringify(o));
  const uOf = (r) => { if (!r.stdout.trim()) return null; try { return JSON.parse(r.stdout).hookSpecificOutput.updatedToolOutput; } catch { return null; } };
  const hOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput; } catch { return null; } };
  const tail = () => { try { return readFileSync(join(cfg, 'tokenbrake', 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).pop(); } catch { return null; } };
  const mcp = (text) => ({ session_id: 's', tool_use_id: 't1', tool_name: 'mcp__github__list_commits', tool_input: {}, tool_response: [{ type: 'text', text }] });
  const big = 'x'.repeat(3000);

  // #1 noTrim shares a list across domains: a command entry must not disable an MCP tool by substring
  setCfg({ mcpTrim: true, maxChars: 200, noTrim: ['git'] });
  t('#1 noTrim:["git"] does NOT spare an mcp__github tool (still trims)', /\[tokenbrake\]/.test(((uOf(g('post', mcp(big))) || [{}])[0] || {}).text || ''));
  setCfg({ mcpTrim: true, maxChars: 200, noTrim: ['mcp__github'] });
  t('#1 an mcp__-shaped noTrim entry does spare the MCP tool', g('post', mcp(big)).stdout.trim() === '');

  // #3 jsonTrim picks the dominant array by bytes, not item count
  setCfg({ maxChars: 200, jsonShape: true, jsonSampleItems: 2 });
  const obj = JSON.stringify({ heavy: Array.from({ length: 5 }, (_, i) => ({ id: i, blob: 'z'.repeat(500) })), small: Array.from({ length: 50 }, (_, i) => i) });
  const u3 = uOf(g('post', { session_id: 's', tool_use_id: 't3', tool_name: 'Bash', tool_input: { command: 'curl' }, tool_response: { stdout: obj, stderr: '', interrupted: false, isImage: false } }));
  t('#3 jsonTrim cuts the byte-heavy array, not the higher item-count one', !!u3 && /the "heavy" array was cut/.test(u3.stdout));

  // #4 a per-tool-disabled MCP tool logs inner-text chars, not the JSON-wrapper length
  setCfg({ tools: { 'mcp__github__list_commits': { enabled: false } } });
  rmSync(join(cfg, 'tokenbrake', 'ledger.jsonl'), { force: true });
  g('post', mcp('y'.repeat(5000)));
  t('#4 a disabled MCP tool logs inner-text chars (5000), not the wrapper length', (tail() || {}).chars === 5000);

  // #5 a per-tool-disabled Read still records evidence, symmetric with handlePost
  setCfg({ tools: { Read: { enabled: false } } });
  rmSync(join(cfg, 'tokenbrake', 'ledger.jsonl'), { force: true });
  const bf = join(proj, 'big.txt'); writeFileSync(bf, 'x'.repeat(80000));
  g('read-pre', { session_id: 's', tool_name: 'Read', tool_input: { file_path: bf } });
  t('#5 a disabled Read still records a ledger row', (tail() || {}).ev === 'read-disabled');

  // #6 PERSISTED must also be anchored under the config dir
  setCfg({ maxChars: 200, readMaxBytes: 10000000 });
  mkdirSync(join(proj, 'build', 'tool-results'), { recursive: true });
  const outside = join(proj, 'build', 'tool-results', 'manifest.json'); writeFileSync(outside, Array.from({ length: 200 }, (_, i) => `"k${i}":${i}`).join('\n'));
  t('#6 a tool-results/.json OUTSIDE the config dir is not force-capped', g('read-pre', { session_id: 's', tool_name: 'Read', tool_input: { file_path: outside } }).stdout.trim() === '');
  mkdirSync(join(cfg, 'projects', 'x', 'tool-results'), { recursive: true });
  const inside = join(cfg, 'projects', 'x', 'tool-results', 'id.json'); writeFileSync(inside, readFileSync(outside, 'utf8'));
  t('#6 a real persisted .json under the config dir is still capped', !!(hOf(g('read-pre', { session_id: 's', tool_name: 'Read', tool_input: { file_path: inside } })) || {}).updatedInput);

  // #2 doctor: honest wording + a warn on the contradictory global-off/per-tool-on config
  cli2(['init']);
  setCfg({ enabled: false, tools: { Bash: { enabled: true } } });
  const doc = cli2(['doctor']);
  t('#2 doctor says a disabled guard records nothing and warns on the impossible per-tool re-enable',
    /records nothing/.test(doc.stdout) && /cannot re-enable a globally disabled guard/.test(doc.stdout));

  rmSync(cfg, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
}

/* ---- Personalized Auto-Tuner (`tokenbrake tune`) --------------------------
   The recommendation engine (transcript.autotune) composes the backfire audit (MEASURED: what the feature did
   when it ran) with coarse OPPORTUNITY estimates (what it would do, for a feature that is off). The decision it
   makes per feature is the driftable part, so it is pinned here: measured beats opportunity, a measured backfire
   is disqualifying, and opportunity earns at most a "try", never a "turn it on". The opportunity estimators and
   the mirrored TUNE_DEFAULTS are pinned too. */
{
  console.log('\n-- auto-tuner (tokenbrake tune)');
  const tr = await import('./transcript.js');
  const T = tr.default || tr;
  const reqs = (n) => Array.from({ length: n }, () => ({ model: 'claude-opus-5' }));
  const sid = 'c0ffee12-3456-7890-abcd-ef0123456789';
  const stem = (id) => sid.slice(0, 8) + '-' + String(id).slice(-10).replace(/[^\w-]/g, '');
  const outOf = (id) => '/cfg/tokenbrake/out/' + stem(id) + '.txt';
  /* A result with the fields autotune's pipeline reads; a test overrides only what it needs. */
  const R = (o) => ({ id: null, name: 'Bash', file: null, what: '', marker: false, chars: 0, lines: 1,
    tokens: 0, carried: 0, isError: false, whole: false, afterReq: 0, ...o });
  const blobLedger = (id) => ({ ev: 'post', session: sid, id, tool: 'Bash', chars: 30000, kept: 200, blob: true, saved: outOf(id) });
  const fBlob = (t) => t.features.find((f) => f.key === 'blobElide');

  // ---- MEASURED decisions ----
  const IDs = ['toolu_01B1', 'toolu_01B2', 'toolu_01B3'];
  const cleanBlob = () => ({ sessionId: sid, cwd: '/w', requests: reqs(6), compactions: [],
    results: IDs.map((id, i) => R({ id, what: 'cat bundle.min.js', marker: true, tokens: 500, afterReq: i })) });
  const cleanLedger = IDs.map(blobLedger);

  const onClean = T.autotune([cleanBlob()], cleanLedger, { blobElide: false });
  t('a clean measured record (3 fires, 0 pulled back) recommends turn-on when the feature is off',
    fBlob(onClean).status === 'turn-on' && onClean.summary.turnOn.includes('Binary-Blob Elider'), fBlob(onClean).status);
  const onKeep = T.autotune([cleanBlob()], cleanLedger, { blobElide: true });
  t('the same clean record, already on, recommends keep', fBlob(onKeep).status === 'keep' && onKeep.summary.keep.includes('Binary-Blob Elider'), fBlob(onKeep).status);

  const backfiredBlob = () => ({ sessionId: sid, cwd: '/w', requests: reqs(4), compactions: [],
    results: [R({ id: IDs[0], what: 'cat bundle.min.js', marker: true, tokens: 100, afterReq: 0 }),
      R({ id: 'toolu_RB', name: 'Read', file: outOf(IDs[0]), what: outOf(IDs[0]), tokens: 6000, afterReq: 1 })] });
  t('a measured backfire recommends leave-off when off', fBlob(T.autotune([backfiredBlob()], [blobLedger(IDs[0])], { blobElide: false })).status === 'leave-off');
  const onBack = T.autotune([backfiredBlob()], [blobLedger(IDs[0])], { blobElide: true });
  t('a measured backfire recommends review when on', onBack.features.find((f) => f.key === 'blobElide').status === 'review' && onBack.summary.review.includes('Binary-Blob Elider'));

  const fewClean = { sessionId: sid, cwd: '/w', requests: reqs(4), compactions: [],
    results: [R({ id: IDs[0], what: 'cat bundle.min.js', marker: true, tokens: 500, afterReq: 0 })] };
  t('one clean fire is too few to assert -- recommends try, not turn-on', fBlob(T.autotune([fewClean], [blobLedger(IDs[0])], { blobElide: false })).status === 'try');
  t('the same few-fire clean record, already ON, is keep -- not a redundant "try/set it on"', fBlob(T.autotune([fewClean], [blobLedger(IDs[0])], { blobElide: true })).status === 'keep');

  // ---- OPPORTUNITY decisions (no fires) ----
  /* carry() recomputes r.carried from r.tokens (tokens x turns carried), so drive the opportunity's carried
     through tokens here -- requests(2) with afterReq 0 carries 1 turn, so carried == tokens. */
  const blobby = (n, chars, tokens) => ({ sessionId: 'opp', cwd: '/w', requests: reqs(2), compactions: [],
    results: Array.from({ length: n }, () => R({ name: 'Bash', what: 'base64 dump', chars, lines: 1, tokens })) });
  const bigOpp = T.autotune([blobby(4, 6000, 25)], [], { blobElide: false });
  t('material opportunity (>= floor fires) with no measured record recommends try',
    fBlob(bigOpp).status === 'try' && !fBlob(bigOpp).measured && fBlob(bigOpp).opportunity.n === 4, JSON.stringify(fBlob(bigOpp).opportunity));
  /* No fire and below-floor opportunity is NOT a confident "leave off" -- the off-state estimators have blind
     spots (a big blob is char-sliced by the always-on trim before blobElide would see it), so the honest verdict
     is "measure it". Only a MEASURED backfire earns "leave off". */
  const tiny = T.autotune([blobby(1, 6000, 25)], [], { blobElide: false });
  t('below-floor opportunity with no fire recommends measure, not leave-off', fBlob(tiny).status === 'measure' && tiny.summary.measure.includes('Binary-Blob Elider') && !tiny.summary.leaveOff.length, fBlob(tiny).status);
  t('leave-off is reserved for a measured backfire', fBlob(T.autotune([backfiredBlob()], [blobLedger(IDs[0])], { blobElide: false })).status === 'leave-off');
  t('one fire but heavy carried opportunity clears the floor -> try', fBlob(T.autotune([blobby(1, 6000, 5000)], [], { blobElide: false })).status === 'try');

  const mixed = { sessionId: sid, cwd: '/w', requests: reqs(4), compactions: [],
    results: [R({ id: IDs[0], what: 'cat x', marker: true, tokens: 100, afterReq: 0 }),
      R({ id: 'toolu_RB', name: 'Read', file: outOf(IDs[0]), what: outOf(IDs[0]), tokens: 6000, afterReq: 1 }),
      R({ name: 'Bash', what: 'base64', chars: 6000, lines: 1, carried: 9999 })] };
  t('a measured backfire wins over heavy opportunity (leave-off, not try)', fBlob(T.autotune([mixed], [blobLedger(IDs[0])], { blobElide: false })).status === 'leave-off');

  /* The two READ narrowings log ev:'read-delta' / 'read-reread', which backfireAudit counts as fired but never
     turns into a withhold (those come from ev:'post' rows, which carry a saved copy to price). So `withholds`
     alone reads as "nothing has fired" in a session where a narrowing fired three times, and the caller printed
     "Nothing withheld yet ... no context-narrowing feature has fired here" directly above "fired 3x". */
  const rrLedger = ['/w/a.js', '/w/b.js', '/w/c.js'].map((f, i) => ({ ev: 'read-reread', session: sid, tool: 'Read', what: f, limit: 5, t: 100 + i }));
  const rrTune = T.autotune([{ sessionId: sid, cwd: '/w', requests: reqs(4), compactions: [], results: [] }], rrLedger, { reReadElide: true });
  t('a session where only read narrowings fired is not reported as nothing having fired',
    rrTune.withholds === 0 && rrTune.narrowings === 3, `withholds=${rrTune.withholds} narrowings=${rrTune.narrowings}`);
  t('a session with neither is still nothing withheld', (() => { const z = T.autotune([blobby(1, 100, 1)], [], {}); return z.withholds === 0 && z.narrowings === 0; })());

  /* guard.js toolConfig() shallow-merges cfg.tools[<tool>] over every knob, so a knob can be ON for one tool
     and absent at the top level. Reading only the top level called such a feature "off", credited it with the
     measured record its own firings produced, and recommended a TOP-LEVEL true -- widening a deliberately
     tool-scoped setting to every other tool on that one tool's evidence. */
  const scopedOn = T.autotune([cleanBlob()], cleanLedger, { tools: { Bash: { blobElide: true } } });
  t('a knob set only under tools.<tool> reads as ON, not off', fBlob(scopedOn).on === true && fBlob(scopedOn).scoped === true,
    `on=${fBlob(scopedOn).on} scoped=${fBlob(scopedOn).scoped}`);
  t('and so its clean record is keep, never a turn-on that would flatten it', fBlob(scopedOn).status === 'keep', fBlob(scopedOn).status);
  t('and the summary reports it as excluded rather than offering it, or filing it under keep',
    !scopedOn.summary.turnOn.includes('Binary-Blob Elider') && !scopedOn.summary.excluded.includes('Binary-Blob Elider'),
    JSON.stringify({ turnOn: scopedOn.summary.turnOn, excluded: scopedOn.summary.excluded }));
  t('a tools entry turning a globally-on knob OFF still reads as on where it is on',
    fBlob(T.autotune([cleanBlob()], cleanLedger, { blobElide: true, tools: { Read: { blobElide: false } } })).on === true);
  t('a plain top-level knob is not marked scoped', fBlob(onKeep).scoped === false && fBlob(onClean).scoped === false);

  /* A knob you set to false keeps its clean MEASURED record -- those firings happened while it was on, before
     you turned it off -- so the status stays the truth about what the feature did, and `disabled` carries the
     decision separately. The caller uses it to stop offering, and --write to stop applying, a turn-on. */
  const offByHand = T.autotune([cleanBlob()], cleanLedger, { blobElide: false }, { disabled: ['blobElide'] });
  t('a knob written false is marked disabled while keeping its measured record',
    fBlob(offByHand).disabled === true && fBlob(offByHand).status === 'turn-on' && fBlob(offByHand).measured.fired === 3,
    `disabled=${fBlob(offByHand).disabled} status=${fBlob(offByHand).status}`);
  t('a knob merely absent from the file is not marked disabled', fBlob(onClean).disabled === false);
  /* The footer is the line people act on, so it cannot say "Turn on: X" for a knob the per-feature line marks
     [off] and --write refuses to set. It gets its OWN bucket: folding it into `keep` would make that list mean
     "already on, keep it" and "off, not being offered" at the same time, which reads exactly backwards. */
  t('the summary does not offer a knob the person turned off, and does not file it under keep',
    !offByHand.summary.turnOn.includes('Binary-Blob Elider')
    && offByHand.summary.excluded.includes('Binary-Blob Elider')
    && !offByHand.summary.keep.includes('Binary-Blob Elider'),
    JSON.stringify({ turnOn: offByHand.summary.turnOn, excluded: offByHand.summary.excluded, keep: offByHand.summary.keep }));
  t('and `offer` carries why, so every caller answers the precedence question the same way',
    offByHand.features.find((f) => f.key === 'blobElide').offer === 'user-off'
    && onClean.features.find((f) => f.key === 'blobElide').offer === 'turn-on'
    && onKeep.features.find((f) => f.key === 'blobElide').offer === null,
    JSON.stringify(offByHand.features.map((f) => f.key + ':' + f.offer)));

  /* `offer` is the --write policy and is null at every status but turn-on. `note` is the DISPLAY classification,
     computed at ANY status, so the preview and summary can explain a config-off knob without leaning on `offer`
     -- which, being null at 'try'/'measure', had left both printing "Set <knob>: true" / "Try:" for a knob the
     person set false or scoped to one tool. `note` turns on the ONE fact the [off] mark must follow: whether the
     feature is actually running. `running` is on but only via a tools entry (top-level not true), so it reads
     on, never [off]; `scoped`/`user-off` are the two OFF-by-config kinds; a knob on via its top-level key is null. */
  const running = T.autotune([cleanBlob()], cleanLedger, { blobElide: false, tools: { Bash: { blobElide: true } } }, { disabled: ['blobElide'] });
  const offTry = T.autotune([fewClean], [blobLedger(IDs[0])], { blobElide: false }, { disabled: ['blobElide'] });
  const scopedTry = T.autotune([fewClean], [blobLedger(IDs[0])], { tools: { Bash: { blobElide: false } } });
  const offMeasure = T.autotune([blobby(1, 6000, 25)], [], { blobElide: false }, { disabled: ['blobElide'] });
  t('note reads on-via-a-tools-entry as running (never off), off-via-tools as scoped, top-level false as user-off',
    fBlob(running).note === 'running' && fBlob(scopedOn).note === 'running'   // scopedOn = {tools:{Bash:{blobElide:true}}} is ON for Bash
    && fBlob(scopedTry).note === 'scoped' && fBlob(offTry).note === 'user-off'
    && fBlob(onClean).note === null && fBlob(onKeep).note === null,
    JSON.stringify({ running: fBlob(running).note, scopedOn: fBlob(scopedOn).note, scopedTry: fBlob(scopedTry).note, offTry: fBlob(offTry).note, onClean: fBlob(onClean).note, onKeep: fBlob(onKeep).note }));

  /* F1: a hand-off (or tool-scoped) knob sitting at 'try'/'measure' -- its firings earned a clean-but-few record
     before it was turned off -- has offer null, so the preview used to fall through to "Set <knob>: true" and
     the summary to "Try:"/"Measure:", recommending the exact flip --write then refuses. `note` fixes the
     preview; the summary leaves these to the per-feature [off] line rather than a "Try:" or "would turn on"
     claim neither the few/no evidence nor --write supports (only a clean-record turn-on earns excluded). */
  t('a hand-off knob at try status: offer null (the field the preview leaned on) but note user-off',
    fBlob(offTry).status === 'try' && fBlob(offTry).offer === null && fBlob(offTry).note === 'user-off',
    JSON.stringify({ status: fBlob(offTry).status, offer: fBlob(offTry).offer, note: fBlob(offTry).note }));
  t('and the summary keeps it out of Try without overstating it as a turn-on (neither tryThese nor excluded)',
    !offTry.summary.tryThese.includes('Binary-Blob Elider') && !offTry.summary.excluded.includes('Binary-Blob Elider'),
    JSON.stringify({ tryThese: offTry.summary.tryThese, excluded: offTry.summary.excluded }));
  t('a tool-scoped knob at try status is note scoped, offer null, and likewise omitted from the summary',
    fBlob(scopedTry).status === 'try' && fBlob(scopedTry).offer === null && fBlob(scopedTry).note === 'scoped'
    && !scopedTry.summary.tryThese.includes('Binary-Blob Elider') && !scopedTry.summary.excluded.includes('Binary-Blob Elider'),
    JSON.stringify({ status: fBlob(scopedTry).status, note: fBlob(scopedTry).note, tryThese: scopedTry.summary.tryThese, excluded: scopedTry.summary.excluded }));
  t('a hand-off knob at measure status is likewise left to the detail line, not filed under Measure or excluded',
    fBlob(offMeasure).status === 'measure' && fBlob(offMeasure).note === 'user-off'
    && !offMeasure.summary.measure.includes('Binary-Blob Elider') && !offMeasure.summary.excluded.includes('Binary-Blob Elider'),
    JSON.stringify({ status: fBlob(offMeasure).status, measure: offMeasure.summary.measure, excluded: offMeasure.summary.excluded }));
  /* Only a genuine turn-on (a clean measured record the config overrides) earns the excluded bucket, where
     "Would turn on, but your config says otherwise" is exactly true -- offByHand is that case. A RUNNING knob
     is on and is never diverted: excluded would be a false claim for something already running, so it stays keep. */
  t('a clean-record turn-on the config overrides IS the excluded case, while a running knob stays in keep',
    offByHand.summary.excluded.includes('Binary-Blob Elider') && !offByHand.summary.turnOn.includes('Binary-Blob Elider')
    && running.summary.keep.includes('Binary-Blob Elider') && !running.summary.excluded.includes('Binary-Blob Elider'),
    JSON.stringify({ excludedTurnOn: offByHand.summary.excluded, runningKeep: running.summary.keep, runningExcluded: running.summary.excluded }));

  /* `status === 'turn-on' && scoped` is reachable only when a tools entry sets the knob FALSE with no
     top-level key: a tools entry setting it true makes on() true, which makes decide() return 'keep'. The
     fixture that used the true shape never reached the exclusion at all. */
  const scopedOff = T.autotune([cleanBlob()], cleanLedger, { tools: { Bash: { blobElide: false } } });
  t('a knob scoped false for one tool with no top-level key is a scoped turn-on, the case --write declines',
    fBlob(scopedOff).status === 'turn-on' && fBlob(scopedOff).scoped === true && fBlob(scopedOff).offer === 'scoped',
    JSON.stringify({ status: fBlob(scopedOff).status, scoped: fBlob(scopedOff).scoped, offer: fBlob(scopedOff).offer }));
  t('autotune without the opts argument still works (disabled defaults to none)',
    fBlob(T.autotune([cleanBlob()], cleanLedger, { blobElide: false })).disabled === false);

  /* capOver decides the "read-pre hook may be missing" verdict, so it must rest on evidence that the read hook
     could have run. A transcript MARKER proves only that the PostToolUse hook fired -- the two are separate
     entries in settings.json -- so a marker-only session (ledger rotated or deleted) cannot tell a missing
     read hook from missing evidence, and calling it "missing" is the phantom defect the gate exists to stop. */
  /* Over readMaxBytes (60,000) but under 0.9 x HOST_READ_CEILING (90,000): past that a read is classified
     'near' the host's own ceiling and excluded from `over`, so a bigger number would test nothing. */
  const hugeRead = R({ name: 'Read', file: '/w/huge.js', what: '/w/huge.js', whole: true, chars: 80000, tokens: 20000 });
  const markerOnly = { sessionId: 'marker01', cwd: '/w', requests: reqs(4), compactions: [],
    results: [R({ id: 'toolu_M1', what: 'cat x', marker: true, tokens: 10, afterReq: 0 }), hugeRead] };
  const markerTune = T.autotune([markerOnly], [], {});
  /* Not "missing", and not "dormant" either: capOver is gated on ledger evidence and capFired is structurally
     0 without it, so nothing here examined the reads at all -- and this session holds an 80,000-char uncapped
     whole-file read, which "dormant: no read reached readMaxBytes" would flatly deny. */
  t('a marker-only session reports the read cap as unmeasured, not missing and not dormant',
    markerTune.guarded === 1 && markerTune.readCap.verdict === 'unmeasured' && markerTune.readCap.over === 0,
    `guarded=${markerTune.guarded} verdict=${markerTune.readCap.verdict} over=${markerTune.readCap.over}`);
  /* The two ways to reach `unmeasured` want opposite advice -- install the guard, versus the ledger evidence
     is gone and re-installing changes nothing -- and "no pooled session ran the guard" would contradict the
     "N with the guard" the header prints for a marker-only pool. */
  t('and says which kind of unmeasured it is', markerTune.readCap.why === 'no-ledger', String(markerTune.readCap.why));
  /* The same session WITH a ledger row is real evidence, and must still raise it. */
  const withLedger = T.autotune([{ ...markerOnly, sessionId: 'ledger01' }],
    [{ ev: 'post', session: 'ledger01', id: 'toolu_M1', tool: 'Bash', chars: 30000, kept: 200 }], {});
  t('the same session with ledger evidence still reports the cap verdict from it',
    withLedger.guarded === 1 && withLedger.readCap.over === 1 && withLedger.readCap.verdict === 'missing', `verdict=${withLedger.readCap.verdict} over=${withLedger.readCap.over}`);
  t('a malformed tools value cannot throw', (() => {
    for (const bad of [null, 'x', 5, [], { Bash: null }, { Bash: 'x' }, { Bash: [] }]) {
      const r = T.autotune([cleanBlob()], cleanLedger, { tools: bad });
      if (!r || !r.features.length) return false;
    }
    return true;
  })());

  /* The read cap's three verdicts are all statements about a guard that RAN. With no guarded session pooled --
     a fresh install, or --cwd onto a project where it was never installed -- capOver is 0 by its own gate and
     capFired is 0 because no cap could fire, so the fall-through claimed "dormant: no read reached
     readMaxBytes", asserting a measurement nothing performed. */
  const unguarded = T.autotune([blobby(4, 6000, 25)], [], { blobElide: false });
  t('with no guarded session pooled the read cap is unmeasured, not dormant',
    unguarded.guarded === 0 && unguarded.readCap.verdict === 'unmeasured' && unguarded.readCap.why === 'no-guard',
    `guarded=${unguarded.guarded} verdict=${unguarded.readCap.verdict} why=${unguarded.readCap.why}`);
  t('a guarded session whose reads all stayed under readMaxBytes is still dormant',
    onKeep.guarded > 0 && onKeep.readCap.verdict === 'dormant', `guarded=${onKeep.guarded} verdict=${onKeep.readCap.verdict}`);

  // ---- opportunity estimators (units) ----
  const P = (results) => ({ cwd: '/w', results });
  const bo = T.blobOpportunity(P([
    R({ name: 'Bash', chars: 5000, lines: 1, carried: 10 }),     // a blob: exactly 1 line (100% dominant), over the floor
    R({ name: 'Bash', chars: 5000, lines: 2 }),                  // 2 lines -> can't prove dominance from chars+lines, excluded (true lower bound)
    R({ name: 'Bash', chars: 5000, lines: 400 }),                // a log, not a blob
    R({ name: 'Bash', chars: 5000, lines: 1, isError: true }),   // failed -> the guard leaves it whole
    R({ name: 'Bash', chars: 2000, lines: 1 }),                  // under the size floor
    R({ name: 'Read', chars: 9000, lines: 1 }),                  // not shell
  ]), { blobMinChars: 4000, blobMaxLine: 2000 });
  t('blobOpportunity counts only a single-line shell result over the floor (exact lower bound, excludes 2-line)', bo.n === 1 && bo.carried === 10, JSON.stringify(bo));

  const mo = T.mcpOpportunity(P([
    R({ name: 'mcp__github__x', chars: 7000, carried: 5 }),       // big MCP -> counts
    R({ name: 'mcp__github__x', chars: 7000, marker: true }),     // already trimmed
    R({ name: 'mcp__github__x', chars: 3000 }),                   // under maxChars
    R({ name: 'Bash', chars: 9000 }),                             // not MCP
  ]), { maxChars: 6000 });
  t('mcpOpportunity counts only an untrimmed mcp result over maxChars', mo.n === 1 && mo.carried === 5, JSON.stringify(mo));

  const go = T.gitOpportunity(P([
    R({ name: 'Bash', what: 'git diff', chars: 5000, carried: 3 }),      // counts
    R({ name: 'Bash', what: 'git log --stat', chars: 5000 }),           // not diff/show
    R({ name: 'Bash', what: 'git diff', chars: 1000 }),                  // under the floor
    R({ name: 'Bash', what: 'git show HEAD', chars: 5000, carried: 4 }), // counts
  ]), { gitViewMinChars: 2000 });
  t('gitOpportunity counts git diff/show over the floor, not git log', go.n === 2 && go.carried === 7, JSON.stringify(go));

  // ---- read-cap health ----
  const postRow = { ev: 'post', session: sid, id: 'x', tool: 'Bash', chars: 100 };
  const dormant = T.autotune([{ sessionId: sid, cwd: '/w', requests: reqs(2), compactions: [],
    results: [R({ name: 'Bash', what: 'ls', chars: 100 })] }], [postRow], {});
  t('read cap reads dormant when no read reaches readMaxBytes', dormant.readCap.verdict === 'dormant', dormant.readCap.verdict);
  const missing = T.autotune([{ sessionId: sid, cwd: '/w', requests: reqs(3), compactions: [],
    results: [R({ name: 'Read', file: '/w/huge.js', whole: true, chars: 70000, lines: 1000,
      shape: { bytes: 70000, lines: 1000, numbered: false, from: null, to: null } })] }], [postRow], { readMaxBytes: 60000 });
  t('read cap reads missing when an over-threshold read went uncapped with the guard running', missing.readCap.verdict === 'missing', JSON.stringify(missing.readCap));
  /* An over-threshold uncapped read in an UNGUARDED session (no ledger row, no marker) is NOT a missing cap --
     the guard was not there. Pooled with a clean guarded session, it must not raise a phantom alarm. */
  const unguardedBig = { sessionId: 'noguard', cwd: '/w', requests: reqs(3), compactions: [],
    results: [R({ name: 'Read', file: '/w/huge.js', whole: true, chars: 70000, lines: 1000,
      shape: { bytes: 70000, lines: 1000, numbered: false, from: null, to: null } })] };
  const mixedCap = T.autotune([{ sessionId: sid, cwd: '/w', requests: reqs(2), compactions: [],
    results: [R({ name: 'Bash', what: 'ls', chars: 100 })] }, unguardedBig], [postRow], { readMaxBytes: 60000 });
  t('an over-threshold read in an UNGUARDED session raises no phantom cap-missing', mixedCap.readCap.verdict !== 'missing' && mixedCap.readCap.over === 0, JSON.stringify(mixedCap.readCap));

  // ---- netCarried honesty (a loss is not a saving; nothing-withheld is distinct from a zero net) ----
  const lossTx = { sessionId: sid, cwd: '/w', requests: reqs(6), compactions: [],
    results: [R({ id: IDs[0], what: 'cat log', marker: true, tokens: 100, afterReq: 0 }),
      R({ id: 'toolu_P', name: 'Read', file: outOf(IDs[0]), what: outOf(IDs[0]), tokens: 9000, afterReq: 1 })] };
  const loss = T.autotune([lossTx], [{ ev: 'post', session: sid, id: IDs[0], tool: 'Bash', chars: 5000, kept: 4000, blob: true, saved: outOf(IDs[0]) }], { blobElide: true });
  t('a net loss reports negative netCarried with withholds > 0 (the render calls it a loss, not a saving)', loss.withholds > 0 && loss.netCarried < 0, JSON.stringify({ w: loss.withholds, net: loss.netCarried }));
  const cleanTune = T.autotune([cleanBlob()], cleanLedger, { blobElide: true });
  t('a clean measured session reports withholds > 0 and a positive net', cleanTune.withholds === 3 && cleanTune.netCarried > 0, JSON.stringify({ w: cleanTune.withholds, net: cleanTune.netCarried }));
  const noneTune = T.autotune([{ sessionId: sid, cwd: '/w', requests: reqs(2), compactions: [], results: [R({ name: 'Bash', what: 'ls', chars: 100 })] }], [postRow], {});
  t('a session that withheld nothing reports withholds === 0 (distinct from a zero net)', noneTune.withholds === 0, JSON.stringify({ w: noneTune.withholds }));

  // ---- guard.js is a library when required and a hook only when run ----
  /* transcript.js used to carry COPIES of the guard's knobs and command grammars, pinned by tests like the ones
     this replaces -- and one had drifted anyway (PERSISTED missed .json). Now it takes the guard's own objects,
     so there is nothing to pin: the checks below are that it really does, and that loading the guard as a
     library is inert. */
  {
    const G = createRequire(import.meta.url)('./guard.js');
    t('transcript.js uses the guard\'s own objects, not copies',
      T.GIT_CMD === G.GIT_DIFF && Object.keys(T.TUNE_DEFAULTS).every(k => T.TUNE_DEFAULTS[k] === G.DEFAULTS[k]),
      JSON.stringify(Object.keys(T.TUNE_DEFAULTS).filter(k => T.TUNE_DEFAULTS[k] !== G.DEFAULTS[k])));
    t('and its read grammar is the guard\'s, with the file as group 1', T.readFileOf('Bash', { command: "sed -n '1,40p' 'a b.js'" }) === 'a b.js');
    /* Loaded, the guard must not do what it does as a hook: read stdin, write the ledger, print a reply. A hook
       input on stdin makes the difference visible -- run as a hook it would answer; required, it must not. */
    const lib = mkdtempSync(join(tmpdir(), 'tokenbrake-lib-'));
    const hookInput = JSON.stringify({ session_id: 'lib', tool_use_id: 'toolu_lib', tool_name: 'Bash', tool_input: { command: 'npm test' },
      tool_response: bashResp('x\n'.repeat(5000)) });
    const req = spawnSync(process.execPath, ['-e', "const g = require('./guard.js'); process.stdout.write(typeof g.DEFAULTS + ' ' + typeof g.EXCERPT)"],
      { input: hookInput, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: lib } });
    t('required as a library, the guard reads no stdin, writes no ledger and prints no reply',
      req.status === 0 && req.stdout === 'object object' && !existsSync(join(lib, 'tokenbrake', 'ledger.jsonl')), JSON.stringify({ out: req.stdout, err: req.stderr.slice(0, 200) }));
    const run = spawnSync(process.execPath, ['./guard.js', 'post'], { input: hookInput, encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: lib } });
    t('run as a hook, the same file still answers and records', run.status === 0 && /updatedToolOutput/.test(run.stdout)
      && existsSync(join(lib, 'tokenbrake', 'ledger.jsonl')), run.stdout.slice(0, 80));
    rmSync(lib, { recursive: true, force: true });
  }

  // ---- cli wiring: tune runs and help lists it ----
  const cfg2 = mkdtempSync(join(tmpdir(), 'tokenbrake-tune-'));
  const e2 = { ...process.env, CLAUDE_CONFIG_DIR: cfg2 };
  const rTune = spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), 'tune'], { encoding: 'utf8', env: e2 });
  t('cli tune with no transcripts exits 0 and says so (fails open)', rTune.status === 0 && /No transcripts found/.test(rTune.stdout), (rTune.stdout || rTune.stderr || '').slice(0, 80));
  const rHelp = spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), 'help'], { encoding: 'utf8', env: e2 });
  t('help lists tune --sweep', /--sweep/.test(spawnSync(process.execPath, ['cli.js', 'help'], { encoding: 'utf8' }).stdout));
  t('help lists the tune command', /tokenbrake tune/.test(rHelp.stdout));

  /* F5 (sessionId backfill): a transcript with no sessionId field of its own must not make autotune attribute
     ANOTHER session's ledger rows to it. Here a foreign read-delta row exists; tuneReport recovers the session
     from the filename before autotune, so the foreign row is filtered out and nothing reads as "fired". Without
     the backfill, auditNarrowing's session filter is skipped and the foreign delta leaks in as a firing. */
  const txDir = join(cfg2, 'projects', 'realproj'); mkdirSync(txDir, { recursive: true });
  const txLines = [
    JSON.stringify({ type: 'assistant', uuid: 'r1', timestamp: '2026-01-01T00:00:00Z', cwd: '/work/realproj', message: { model: 'claude-opus-5', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id: 'toolu_A', name: 'Bash', input: { command: 'ls' } }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'ok' }] } }),
  ].join('\n');
  writeFileSync(join(txDir, 'realsessF5.jsonl'), txLines);
  mkdirSync(join(cfg2, 'tokenbrake'), { recursive: true });
  writeFileSync(join(cfg2, 'tokenbrake', 'ledger.jsonl'), JSON.stringify({ ev: 'read-delta', session: 'FOREIGN-SESSION', what: '/work/realproj/x.js', offset: 1, limit: 20, t: 1 }) + '\n');
  const rF5 = spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), 'tune'], { encoding: 'utf8', env: e2 });
  t('tune backfills sessionId from the filename, so a foreign session\'s ledger rows do not leak in as firings',
    rF5.status === 0 && !/fired \d+x/.test(rF5.stdout), (rF5.stdout.match(/fired \d+x/) || ['(none)'])[0]);
  rmSync(cfg2, { recursive: true, force: true });

  /* Item 2: the two thresholds, per person. A grid of what each value would reach, and one step of advice,
     weighed on the measured record -- recommend-only, so --write never touches them (checked further down). */
  {
    const g = T.shellGrid([{ chars: 3500, reuse: 3 }, { chars: 7000, reuse: 2 }, { chars: 20000, reuse: 4 }], [3000, 6000]);
    t('shellGrid counts each sized result over the value',
      g[0].n === 3 && g[1].n === 2, JSON.stringify(g));
    t('and prices what past the value it could withhold, across every request it would no longer sit in',
      g[1].withheldCarried === Math.round(1000 / 4) * 2 + Math.round(14000 / 4) * 4, JSON.stringify(g[1]));

    /* The population autotune hands shellGrid: successful shell results under the host ceiling, a TRIMMED one
       at its original size from the ledger. Sized by the transcript, a trimmed result sits at its trimmed size
       and drops out of exactly the rows where the trim fired. */
    {
      const R = (id, chars, extra) => ({ id, name: 'Bash', what: 'cmd ' + id, chars, tokens: Math.round(chars / 4), isError: false, marker: false, afterReq: 0, ...(extra || {}) });
      const p = { sessionId: 'sg', cwd: '/w', requests: [{}, {}, {}], compactions: [], results: [
        R('a', 3500), R('b', 2400, { marker: true }), R('c', 40000), R('d', 9000, { isError: true }),
        R('f', 9000, { file: '/w/big.log', excerpt: true }), R('g', 9000, { what: 'npm run bench' }),
        { id: 'e', name: 'Read', file: '/w/x', chars: 5000, tokens: 1250, afterReq: 0 }] };
      const led = [{ ev: 'post', session: 'sg', id: 'b', tool: 'Bash', what: 'cmd b', chars: 20000, kept: 2400 }];
      const th = T.autotune([p], led, { maxChars: 6000, readMaxBytes: 60000, noTrim: ['bench'] }).thresholds;
      const at = (v) => th.maxChars.grid.find(x => x.value === v);
      t('a trimmed result is sized from the ledger, so it stays in the rows the trim fired on',
        at(6000).n === 1 && at(3000).n === 2, JSON.stringify(th.maxChars.grid));
      /* A single-file excerpt goes down the guard's read path and a noTrim command is returned on first -- the
         trim never sees either at any maxChars, so neither belongs in its grid. */
      t('a file excerpt and a noTrim command are not in the maxChars grid -- the trim never reaches them',
        at(3000).n === 2, JSON.stringify(th.maxChars.grid));
      /* On the numerator's basis (entry + carry), or a share can print over 100% in a short session. */
      t('the share denominator is everything carried, entry included, and is carried once for both grids',
        th.carriedTotal === p.results.reduce((s, r) => s + (r.tokens || 0) + (r.carried || 0), 0) && th.maxChars.carriedTotal === undefined,
        JSON.stringify({ total: th.carriedTotal }));
    }

    const reads = [
      { bytes: 50000, lines: 1000, reuse: 2, via: 'read-cap' },
      { bytes: 5000, lines: 100, reuse: 1, via: 'post' },        // a cat at or under maxChars: the POST hook never reaches the cap
      { bytes: 20000, lines: null, reuse: 1, via: 'read-cap' },  // caught, but no line count to price it by
    ];
    const rg = T.readGrid(reads, [4000, 30000], { readLimitLines: 300, maxChars: 6000 });
    t("readGrid keeps --reads' maxChars floor for shell reads and prices only what it can",
      rg[0].n === 2 && rg[1].n === 1 && rg[1].withheldCarried === Math.round(50000 * 700 / 1000 / 4) * 2, JSON.stringify(rg));

    const grid = [{ value: 3000, withheldCarried: 90000 }, { value: 6000, withheldCarried: 50000 }, { value: 12000, withheldCarried: 10000 }];
    const rec = (rows) => ({ fired: rows.length, backfired: rows.filter(r => r.pulledFoot).length, rows });
    const clean = rec([1, 2, 3, 4].map(() => ({ chars: 9000, savedCarried: 500, pulledFoot: 0 })));
    const tryDown = T.thresholdAdvice(grid, 6000, clean, clean.fired);
    t('a clean record with enough firings and material gain says try ONE step down, never further',
      tryDown.advice === 'try' && tryDown.to === 3000 && tryDown.gain === 40000, JSON.stringify(tryDown));
    t('too few firings to step from says keep',
      T.thresholdAdvice(grid, 6000, rec([{ chars: 9000, savedCarried: 500, pulledFoot: 0 }]), 1).why === 'few-firings');
    t('a step down that takes too little more says keep',
      T.thresholdAdvice([{ value: 3000, withheldCarried: 50100 }, grid[1]], 6000, clean, 4).why === 'no-gain');
    /* One pull-back among many clean trims is the trim working. Raising is recommended only when the
       pull-backs it would have prevented cost more than the saving it would give up -- both measured. */
    const oneCheap = rec([{ chars: 7000, savedCarried: 5000, pulledFoot: 800 }, { chars: 9000, savedCarried: 5000, pulledFoot: 0 }]);
    const outw = T.thresholdAdvice(grid, 6000, oneCheap, 2);
    t('a pull-back that costs less than raising would give up says keep, not raise',
      outw.advice === 'keep' && outw.why === 'backfired-outweighed' && outw.pulledCost === 800, JSON.stringify(outw));
    const dear = rec([{ chars: 7000, savedCarried: 300, pulledFoot: 9000 }, { chars: 9000, savedCarried: 5000, pulledFoot: 0 }]);
    const up = T.thresholdAdvice(grid, 6000, dear, 2);
    t('a pull-back that costs more than raising gives up says raise, to a step that lets it through',
      up.advice === 'raise' && up.to === 12000 && up.fixed === 9000 && up.givenUp === 5300, JSON.stringify(up));
    const above = rec([{ chars: 25000, savedCarried: 100, pulledFoot: 9000 }]);
    t('a pull-back from above every step is not fixed by raising, so it says keep',
      T.thresholdAdvice(grid, 6000, above, 1).advice === 'keep');
    t('a backfire never earns a step down, however clean the rest',
      T.thresholdAdvice(grid, 6000, oneCheap, 99).advice !== 'try');
    /* A pooled record holds withholds from an older, lower setting too; the current value is judged only on
       what it withheld, or a raise already taken is recommended again on evidence it already answered. */
    t('the trim record at a value counts only withholds over it',
      (() => { const r = T.recordAbove({ rows: [{ chars: 7000, recovered: true }, { chars: 9000, recovered: false }, { chars: 13000, recovered: false }] }, 8000);
        return r.fired === 2 && r.backfired === 0 && r.rows.every(w => w.chars > 8000); })());
    t('a cap that is missing reads keeps its value whatever the grid says -- no value fixes coverage',
      T.thresholdAdvice(grid, 6000, null, 99, { missing: true }).why === 'missing');
    t('with no measurable pull-back (the Read cap), a step down is labelled unmeasured, not clean',
      T.thresholdAdvice(grid, 6000, null, 5).why === 'unmeasured');
    const at = T.autotune([], [], { maxChars: 5000, readMaxBytes: 60000 });
    t("autotune splices the person's own value into the grid, so there is always a you-are-here row",
      at.thresholds.maxChars.grid.some(g => g.value === 5000) && at.thresholds.maxChars.current === 5000
      && at.thresholds.readMaxBytes.current === 60000, JSON.stringify(at.thresholds.maxChars.grid.map(g => g.value)));
  }

  /* --write: applies MEASURED recommendations to tokenbrake.json (merge, not replace), and NEVER an estimate. */
  const cfg3 = mkdtempSync(join(tmpdir(), 'tokenbrake-tunew-'));
  const e3 = { ...process.env, CLAUDE_CONFIG_DIR: cfg3 };
  const cli3 = (a) => spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), ...a], { encoding: 'utf8', env: e3 });
  const w3 = join(cfg3, 'projects', 'tw'); mkdirSync(w3, { recursive: true });
  const bigDiff = 'diff --git a/x b/x\n' + 'x'.repeat(3000);   // a git-diff result -> gitView OPPORTUNITY (no marker), never measured
  const uses = ['toolu_B1', 'toolu_B2', 'toolu_B3'].map((id) => ({ type: 'tool_use', id, name: 'Bash', input: { command: 'cat bundle.min.js' } }));
  uses.push({ type: 'tool_use', id: 'toolu_G1', name: 'Bash', input: { command: 'git diff' } });
  const res = ['toolu_B1', 'toolu_B2', 'toolu_B3'].map((id) => ({ type: 'tool_result', tool_use_id: id, content: '[tokenbrake] withheld blob-like output' }));
  res.push({ type: 'tool_result', tool_use_id: 'toolu_G1', content: bigDiff });
  writeFileSync(join(w3, 'tunewrite01.jsonl'), [
    JSON.stringify({ type: 'assistant', uuid: 'r1', sessionId: 'tunewrite01', timestamp: '2026-01-01T00:00:00Z', cwd: '/work/tw', message: { model: 'claude-opus-5', usage: { input_tokens: 1 }, content: uses } }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:01Z', message: { content: res } }),
  ].join('\n'));
  mkdirSync(join(cfg3, 'tokenbrake'), { recursive: true });
  writeFileSync(join(cfg3, 'tokenbrake', 'ledger.jsonl'),
    ['toolu_B1', 'toolu_B2', 'toolu_B3'].map((id) => JSON.stringify({ ev: 'post', session: 'tunewrite01', id, tool: 'Bash', chars: 30000, kept: 200, blob: true })).join('\n') + '\n');
  const cfg3Path = join(cfg3, 'tokenbrake.json');

  /* A MALFORMED config must abort, not be overwritten -- or --write would wipe every real setting it claims to
     preserve. (blobElide is a measured turn-on here, so the plan is non-empty and the file read is reached.) */
  const malformed = '{ "maxChars": 5000, oops }';
  writeFileSync(cfg3Path, malformed);
  const rwBad = cli3(['tune', '--write']);
  /* A read failure is not a parse failure: reporting EISDIR as "is not valid JSON" sends the person to edit a
     file that is well-formed, or in this case is not a file at all. */
  const dirAsCfg = join(cfg3, 'tokenbrake.json');
  rmSync(dirAsCfg, { force: true });
  mkdirSync(dirAsCfg, { recursive: true });
  const rwDir = cli3(['tune', '--write']);
  t('tune --write names a read failure as a read failure, not as invalid JSON',
    rwDir.status === 0 && /could not be read/.test(rwDir.stdout) && !/is not valid JSON/.test(rwDir.stdout),
    rwDir.stdout.split('\n').find((l) => /could not be read|not valid JSON/.test(l)) || '(no refusal)');
  rmSync(dirAsCfg, { recursive: true, force: true });
  writeFileSync(cfg3Path, malformed);   // restore what this block displaced: the next assertion reads it back

  t('tune --write aborts on a malformed config instead of wiping it', rwBad.status === 0 && /not valid JSON/.test(rwBad.stdout) && readFileSync(cfg3Path, 'utf8') === malformed, rwBad.stdout.split('\n').find(l => /valid JSON/.test(l)) || '(no abort)');

  /* Valid JSON is not enough: every one of these parses, and each spreads into an empty (or index-keyed)
     merge base, so before the type check --write replaced the file with nothing but the flipped knobs --
     the same data loss the malformed-file abort above exists to prevent, through a different door. */
  for (const bad of ['null', '[]', '"blobElide"', '5']) {   // the distinct shapes: null, array, string, number
    writeFileSync(cfg3Path, bad);
    const r = cli3(['tune', '--write']);
    t(`tune --write refuses a config whose JSON root is not an object: ${bad}`,
      r.status === 0 && /is not a JSON object/.test(r.stdout) && readFileSync(cfg3Path, 'utf8') === bad,
      readFileSync(cfg3Path, 'utf8') === bad ? (r.stdout.split('\n').find(l => /JSON object/.test(l)) || '(no refusal)') : 'FILE WAS REWRITTEN: ' + readFileSync(cfg3Path, 'utf8'));
  }

  writeFileSync(cfg3Path, JSON.stringify({ maxChars: 5000 }));   // a pre-existing key that must survive the merge
  const rw = cli3(['tune', '--write']);
  const after = JSON.parse(readFileSync(cfg3Path, 'utf8'));
  t('tune --write turns ON a feature with a clean measured record', rw.status === 0 && after.blobElide === true, JSON.stringify(after));
  t('tune --write does NOT write an estimate-only feature (gitView is a try/measure, not measured)', after.gitView === undefined, JSON.stringify(after));
  t('tune --write merges, preserving other keys', after.maxChars === 5000, JSON.stringify(after));
  t('tune --write never sets a threshold -- they are recommend-only', after.maxChars === 5000 && after.readMaxBytes === undefined, JSON.stringify(after));
  const pv = cli3(['tune']);
  t("the tune preview shows both threshold grids, marking the person's own value",
    /Thresholds, from your own sessions/.test(pv.stdout) && /5,000 .*<- yours/.test(pv.stdout) && /readMaxBytes/.test(pv.stdout),
    pv.stdout.split('\n').filter(l => /Thresholds|yours/.test(l)).join(' | '));
  t('tune --write reports what it turned on with the measured reason', /Turned ON 1 feature/.test(rw.stdout) && /"blobElide": false -> true/.test(rw.stdout) && /measured clean/.test(rw.stdout), rw.stdout.split('\n').filter(l => /blobElide|Turned ON/.test(l)).join(' | '));

  /* F2: writeJson itself can throw (a root-owned or read-only config, a full disk). --write catches it and
     names the cause instead of ending on an unhandled stack trace -- the same fail-open shape as the read
     refusal tested just above ("names a read failure as a read failure"). It has no black-box test here on
     purpose: the read and the write traverse the same path, so every filesystem condition that fails the
     write (EISDIR, ENOTDIR, a missing parent) fails the earlier read first and is caught there; and the one
     that would not (an unwritable existing file) cannot be staged as the root this suite runs as, which
     bypasses the mode bits. The success path the guard wraps is covered by the "Turned ON" assertion above. */
  const rw2 = cli3(['tune', '--write']);   // blobElide now on + clean -> 'keep', not in the turn-on plan
  t('a second --write is a no-op once the clean feature is already on', rw2.status === 0 && /No feature has a clean MEASURED record to turn on/.test(rw2.stdout), rw2.stdout.split('\n').slice(0, 3).join(' | '));

  /* --write on a session that only has opportunity (no measured record) writes nothing. */
  const cfg4 = mkdtempSync(join(tmpdir(), 'tokenbrake-tunew2-'));
  const e4 = { ...process.env, CLAUDE_CONFIG_DIR: cfg4 };
  const w4 = join(cfg4, 'projects', 'tw2'); mkdirSync(w4, { recursive: true });
  writeFileSync(join(w4, 'oppo01.jsonl'), [
    JSON.stringify({ type: 'assistant', uuid: 'r1', sessionId: 'oppo01', timestamp: '2026-01-01T00:00:00Z', cwd: '/work/tw2', message: { model: 'claude-opus-5', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id: 'toolu_G', name: 'Bash', input: { command: 'git diff' } }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_G', content: bigDiff }] } }),
  ].join('\n'));
  const rw3 = spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), 'tune', '--write'], { encoding: 'utf8', env: e4 });
  t('tune --write writes nothing when there is only opportunity, no measured record', rw3.status === 0 && /No feature has a clean MEASURED record to turn on/.test(rw3.stdout) && !existsSync(join(cfg4, 'tokenbrake.json')), rw3.stdout.split('\n')[1] || '');

  /* --write can only set the TOP-LEVEL key, so a knob the person scoped to one tool must be left alone rather
     than flattened onto every other tool from that one tool's evidence. And because the config it writes is
     global, a pool narrowed by --cwd has to say so in the header. */
  /* The tools entry must set it FALSE: setting it true makes the feature read as on, which makes the verdict
     `keep`, which never reaches --write's plan at all. The earlier fixture used the true shape, so this branch
     and its message were never executed and the assertion passed against unmodified code. */
  writeFileSync(cfg3Path, JSON.stringify({ tools: { Bash: { blobElide: false } } }));
  const rwScoped = cli3(['tune', '--write']);
  t('tune --write leaves a tool-scoped knob alone instead of flattening it to the top level',
    rwScoped.status === 0 && JSON.parse(readFileSync(cfg3Path, 'utf8')).blobElide === undefined,
    readFileSync(cfg3Path, 'utf8'));
  t('and says why it left it', /Left alone: "blobElide" is set per-tool/.test(rwScoped.stdout),
    rwScoped.stdout.split('\n').find((l) => /Left alone|No feature/.test(l)) || '(no line)');
  /* `[ON]` beside "--write will not set this" is the same contradiction the user-off case was fixed for: a
     scoped turn-on is reachable only when a tools entry sets the knob false, so it is off too. */
  const scopedPrev = cli3(['tune']).stdout.split('\n').find((l) => /Binary-Blob Elider/.test(l)) || '';
  t('a tool-scoped turn-on is not marked [ON] either, and points at the tools entry',
    !/\[ON\]/.test(scopedPrev) && /set per-tool under "tools"/.test(scopedPrev), scopedPrev.trim());

  /* The firings that earn a clean record happened while the feature was ON, so a knob you then set to false
     still looks like a turn-on candidate. --write must not flip it back, and the preview must not offer it --
     recommending what --write declines is the tuner disagreeing with itself. */
  writeFileSync(cfg3Path, JSON.stringify({ blobElide: false, maxChars: 5000 }));
  const rwOff = cli3(['tune', '--write']);
  t('tune --write does not re-enable a feature the person set to false',
    rwOff.status === 0 && JSON.parse(readFileSync(cfg3Path, 'utf8')).blobElide === false,
    readFileSync(cfg3Path, 'utf8'));
  t('and says it left it alone, and why', /Left alone: "blobElide" is set to false in your config/.test(rwOff.stdout),
    rwOff.stdout.split('\n').find((l) => /Left alone|No feature/.test(l)) || '');
  const rPrev = cli3(['tune']);
  const prevLine = rPrev.stdout.split('\n').find((l) => /Binary-Blob Elider/.test(l)) || '';
  t('and the preview reports it rather than recommending it',
    !/Set "blobElide": true/.test(prevLine) && /false in your config/.test(prevLine), prevLine.trim());
  /* Routing an excluded turn-on out of summary.turnOn is only half the fix: the footer is the line people act
     on, and before this it said nothing at all about a feature with a clean measured record. */
  t('and the summary footer still names it, rather than dropping it silently',
    /Would turn on, but your config says otherwise: Binary-Blob Elider/.test(rPrev.stdout),
    (rPrev.stdout.split('\n').find((l) => /Would turn on, but|Turn on:|Nothing to change/.test(l)) || '(no summary line)').trim());

  /* An empty plan because everything qualified and was then excluded is a different situation from nothing
     qualifying, and the advice for the second ("go enable a try feature and measure it") is wrong for the
     first -- it printed directly under "Left alone: ... ITS CLEAN RECORD is from before you turned it off". */
  t('an empty plan from exclusions does not claim no feature has a clean record',
    /Nothing left to write: every feature with a clean measured record is one of the above/.test(rwOff.stdout)
    && !/No feature has a clean MEASURED record/.test(rwOff.stdout),
    rwOff.stdout.split('\n').find((l) => /Nothing left to write|No feature has/.test(l)) || '');

  /* --session narrows the evidence exactly as --cwd does, and the header claimed to cover both. */
  writeFileSync(cfg3Path, JSON.stringify({ maxChars: 5000 }));
  const rwSess = cli3(['tune', '--session=tunewrite01', '--write']);
  t('tune --session ... --write discloses the narrowing too',
    /evidence narrowed to --session=tunewrite01; the config it writes is global/.test(rwSess.stdout),
    rwSess.stdout.split('\n')[0] || '');
  /* And the preview, which --write's comment claims already carries the filter. */
  t('tune --session discloses the narrowing in the preview header too',
    /\(--session=tunewrite01\)/.test(cli3(['tune', '--session=tunewrite01']).stdout),
    cli3(['tune', '--session=tunewrite01']).stdout.split('\n')[0] || '');

  /* `disabled` reads the top-level key, `on` also reads cfg.tools -- so the shell-scoped elider is both, and
     it IS running. The mark and the hint must follow `on`, not the raw key. */
  writeFileSync(cfg3Path, JSON.stringify({ blobElide: false, tools: { Bash: { blobElide: true } } }));
  const rScoped = cli3(['tune']);
  const scopedLine = rScoped.stdout.split('\n').find((l) => /Binary-Blob Elider/.test(l)) || '';
  t('a knob turned off at the top level but on for a tool is not rendered as off',
    !/\[off\]/.test(scopedLine) && /a "tools" entry turns it on/.test(scopedLine), scopedLine.trim());

  /* The same must hold with NO top-level key at all: a knob enabled only under tools.<tool> is on for that
     tool, so it reads as running, never [off]. A regression marked it [off] because the mark had been keyed on
     the config classification (`note`) rather than on whether the feature is actually on. */
  writeFileSync(cfg3Path, JSON.stringify({ tools: { Bash: { blobElide: true } } }));
  const scopedOnLine = cli3(['tune']).stdout.split('\n').find((l) => /Binary-Blob Elider/.test(l)) || '';
  t('a knob enabled only under tools.<tool>, with no top-level key, renders as running, not [off]',
    !/\[off\]/.test(scopedOnLine) && /a "tools" entry turns it on/.test(scopedOnLine), scopedOnLine.trim());

  /* A knob the person set false that ALSO measurably backfired is a leave-off, not a turn-on candidate: its
     mark must stay [ - ] and it must NOT dangle "delete the line or set it true to take it back". The config
     note (and the [off] mark) belong only where the status would otherwise OFFER the turn-on (turn-on/try/
     measure), never beside a measured backfire -- a regression showed [off] + the re-enable invite here. */
  const cfgBk = mkdtempSync(join(tmpdir(), 'tokenbrake-tunebk-'));
  const eBk = { ...process.env, CLAUDE_CONFIG_DIR: cfgBk };
  const sidBk = 'backfire01-2222-3333-4444-555566667777', BK = 'toolu_BKAAAA1111';
  const wBk = join(cfgBk, 'projects', 'bk'); mkdirSync(wBk, { recursive: true });
  const outBk = join(cfgBk, 'tokenbrake', 'out', sidBk.slice(0, 8) + '-' + BK.slice(-10).replace(/[^\w-]/g, '') + '.txt');
  mkdirSync(join(cfgBk, 'tokenbrake', 'out'), { recursive: true });
  writeFileSync(outBk, 'x'.repeat(30000));
  writeFileSync(join(wBk, 'bk01.jsonl'), [
    JSON.stringify({ type: 'assistant', uuid: 'r1', sessionId: sidBk, timestamp: '2026-01-01T00:00:00Z', cwd: '/work/bk', message: { model: 'claude-opus-5', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id: BK, name: 'Bash', input: { command: 'cat bundle.min.js' } }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: BK, content: '[tokenbrake] withheld blob-like output' }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'r2', sessionId: sidBk, timestamp: '2026-01-01T00:01:00Z', cwd: '/work/bk', message: { model: 'claude-opus-5', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id: 'toolu_RB', name: 'Read', input: { file_path: outBk } }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:01:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_RB', content: 'x'.repeat(30000) }] } }),
  ].join('\n'));
  writeFileSync(join(cfgBk, 'tokenbrake', 'ledger.jsonl'),
    JSON.stringify({ ev: 'post', session: sidBk, id: BK, tool: 'Bash', chars: 30000, kept: 200, blob: true, saved: outBk }) + '\n');
  writeFileSync(join(cfgBk, 'tokenbrake.json'), JSON.stringify({ blobElide: false }));
  const rBk = spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), 'tune'], { encoding: 'utf8', env: eBk });
  const bkLine = rBk.stdout.split('\n').find((l) => /Binary-Blob Elider/.test(l)) || '';
  t('a hand-off knob that measurably backfired renders [ - ], never [off] with a "set it true" invite',
    rBk.status === 0 && /\[ - \]/.test(bkLine) && !/\[off\]/.test(bkLine) && !/set it true to take it back/.test(bkLine),
    bkLine.trim());
  t('and the footer files the backfired hand-off knob under leave-off, not "would turn on"',
    /Leave off \(backfired\): Binary-Blob Elider/.test(rBk.stdout) && !/Would turn on[^.]*Binary-Blob Elider/.test(rBk.stdout),
    (rBk.stdout.split('\n').find((l) => /Leave off|Would turn on/.test(l)) || '(none)').trim());
  rmSync(cfgBk, { recursive: true, force: true });

  writeFileSync(cfg3Path, JSON.stringify({ maxChars: 5000 }));
  const rwCwd = cli3(['tune', '--cwd=/work/tw', '--write']);
  t('tune --cwd ... --write says the evidence was narrowed while the config it writes is global',
    /evidence narrowed to --cwd=\/work\/tw; the config it writes is global/.test(rwCwd.stdout),
    rwCwd.stdout.split('\n')[0] || '');
  t('and an unfiltered --write does not claim a narrowing', !/evidence narrowed/.test(cli3(['tune', '--write']).stdout));

  /* The opportunity estimators count what a feature WOULD have acted on had it been running, so attaching one
     to a feature that is already ON asserts the guard would have touched output it demonstrably did not touch.
     Before the fix this printed, live on a real machine: `[on]  MCP output trim (mcpTrim)` / `not fired; would
     act on ~ 1 MCP result(s) over maxChars`. */
  const cfg5 = mkdtempSync(join(tmpdir(), 'tokenbrake-tuneon-'));
  const e5 = { ...process.env, CLAUDE_CONFIG_DIR: cfg5 };
  const w5 = join(cfg5, 'projects', 'tuneon'); mkdirSync(w5, { recursive: true });
  writeFileSync(join(w5, 'tuneon01.jsonl'), [
    JSON.stringify({ type: 'assistant', uuid: 'r1', sessionId: 'tuneon01', timestamp: '2026-01-01T00:00:00Z', cwd: '/work/tuneon', message: { model: 'claude-opus-5', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id: 'toolu_BLOB', name: 'Bash', input: { command: 'base64 payload.bin' } }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:01Z', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_BLOB', content: 'A'.repeat(9000) }] } }),
  ].join('\n'));
  writeFileSync(join(cfg5, 'tokenbrake.json'), JSON.stringify({ blobElide: true }));   // ON, and it never fired here
  const rOn = spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), 'tune'], { encoding: 'utf8', env: e5 });
  const blobLine = rOn.stdout.split('\n').findIndex((l) => /Binary-Blob Elider/.test(l));
  const blobEvidence = blobLine >= 0 ? (rOn.stdout.split('\n')[blobLine + 1] || '') : '';
  t('tune does not describe an already-ON feature with its off-state opportunity estimate',
    rOn.status === 0 && /\[on\]/.test(rOn.stdout.split('\n')[blobLine] || '')
    && /on, but has not fired/.test(blobEvidence) && !/would act on/.test(blobEvidence),
    blobEvidence.trim() || '(no evidence line)');
  t('and an off feature still gets its opportunity estimate', (() => {
    writeFileSync(join(cfg5, 'tokenbrake.json'), JSON.stringify({ blobElide: false }));
    const rOff = spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), 'tune'], { encoding: 'utf8', env: e5 });
    const i = rOff.stdout.split('\n').findIndex((l) => /Binary-Blob Elider/.test(l));
    return i >= 0 && /would act on/.test(rOff.stdout.split('\n')[i + 1] || '');
  })());
  t('and the read cap reports unmeasured, not dormant, when no pooled session ran the guard',
    /Read cap .*not measured here -- no pooled session ran the guard/.test(rOn.stdout),
    (rOn.stdout.split('\n').find((l) => /Read cap/.test(l)) || '').trim());
  rmSync(cfg3, { recursive: true, force: true });
  rmSync(cfg4, { recursive: true, force: true });
  rmSync(cfg5, { recursive: true, force: true });
}

/* ---- compactPrep: the working set re-injected after a compaction ----------- */
{
  console.log('\n-- compactPrep: SessionStart after a compaction');
  const G = createRequire(import.meta.url)('./guard.js');
  const LS = String.fromCharCode(0x2028), RLO = String.fromCharCode(0x202e);
  const use = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
  const res = (id, content, extra = {}) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra.block }] }, ...extra.entry });
  const entries = [
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'user', message: { content: 'Fix the total in the cart and keep the tests green.' } },
    use('r1', 'Read', { file_path: '/p/src/cart.js' }), res('r1', 'SECRET FILE BODY that must not come back'),
    use('r2', 'Read', { file_path: '/p/src/big.js', offset: 400, limit: 80 }), res('r2', 'x'),
    use('e1', 'Edit', { file_path: '/p/src/cart.js' }), res('e1', 'ok', { entry: { toolUseResult: { structuredPatch: [{ newStart: 42, newLines: 3 }] } } }),
    use('b1', 'Bash', { command: 'npm test' }), res('b1', 'Exit code 1\n> jest\nSyntaxError: Unexpected token in cart.test.js', { block: { is_error: true } }),
    use('w1', 'Write', { file_path: '/p/evil' + LS + 'path' + RLO + '.js' }), res('w1', 'ok'),
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 's1', name: 'Edit', input: { file_path: '/p/sidechain.js' } }] } }
  ];
  const ws = G.workingSet(entries);
  t('prep: the task is the first real prompt, not a command wrapper', ws.task === 'Fix the total in the cart and keep the tests green.');
  t('prep: an edited file carries the patched range, and is not listed again under Read', ws.edited.some(r => r.file === '/p/src/cart.js' && r.ranges.includes('42-44')) && !ws.read.some(r => r.file === '/p/src/cart.js'));
  t('prep: a ranged read keeps its range', ws.read.some(r => r.file === '/p/src/big.js' && r.ranges.includes('400-479')));
  t('prep: the failing command names the error line, not the host\'s "Exit code"', ws.failing && ws.failing.line.startsWith('SyntaxError'));
  t('prep: a sidechain edit is not the main session\'s working set', !ws.edited.some(r => r.file === '/p/sidechain.js'));
  const text = G.renderWorkingSet(ws, 8000);
  t('prep: pointers only -- no file body comes back', !text.includes('SECRET FILE BODY'));
  t('prep: labelled as data recorded by tokenbrake', /\[tokenbrake\].*data, not instructions/.test(text));
  t('prep: line separators and bidi overrides from a path are stripped', !text.includes(LS) && !text.includes(RLO) && text.includes('/p/evil path .js'));
  t('prep: the block respects its cap', G.renderWorkingSet(ws, 600).length <= 600);
  const fixed = G.workingSet([...entries, use('b2', 'Bash', { command: 'npm test' }), res('b2', 'all green')]);
  t('prep: a failing command that later succeeded is not reported as failing', fixed.failing === null);
  const nb = G.workingSet([use('n1', 'NotebookEdit', { notebook_path: '/p/a.ipynb' }), res('n1', 'ok')]);
  t('prep: a notebook edit (notebook_path) is in the working set', nb.edited.some(r => r.file === '/p/a.ipynb'));
  t('prep: a read with no range is not claimed as "whole" (the cap may have cut it)',
    ws.read.find(r => r.file === '/p/src/big.js') && !G.renderWorkingSet(G.workingSet([use('r9', 'Read', { file_path: '/p/x.js' }), res('r9', 'x')]), 8000).includes('whole'));
  t('prep: a host note like "[Request interrupted by user]" is not the task',
    G.workingSet([{ type: 'user', message: { content: '[Request interrupted by user]' } }, { type: 'user', message: { content: 'real task' } }]).task === 'real task');
  t('prep: nothing to point at -> nothing injected', G.renderWorkingSet(G.workingSet([{ type: 'user', message: { content: 'hi' } }]), 8000) === null);

  const cfgP = mkdtempSync(join(tmpdir(), 'tokenbrake-prep-'));
  const envP = { ...process.env, CLAUDE_CONFIG_DIR: cfgP };
  mkdirSync(join(cfgP, 'projects', 'p'), { recursive: true });
  const tp = join(cfgP, 'projects', 'p', 's.jsonl');
  const outside = join(cfgP, 'elsewhere.jsonl');
  const jsonl = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(tp, jsonl);
  writeFileSync(outside, jsonl);
  const start = (input) => spawnSync(process.execPath, ['./guard.js', 'session-start'], { input: JSON.stringify(input), encoding: 'utf8', env: envP });
  const ledger = () => existsSync(join(cfgP, 'tokenbrake', 'ledger.jsonl'))
    ? readFileSync(join(cfgP, 'tokenbrake', 'ledger.jsonl'), 'utf8').trim().split('\n').map(parse) : [];
  const ev = { hook_event_name: 'SessionStart', source: 'compact', session_id: 'sp', transcript_path: tp };

  let r = start(ev);
  t('prep off (the default): exit 0, nothing injected', r.status === 0 && r.stdout === '');
  const sh = ledger().find(l => l.ev === 'shadow' && l.feature === 'compactPrep');
  t('prep off: a shadow row records what it would have injected', !!sh && sh.kept > 0 && sh.edited >= 1 && sh.failing === true);

  writeFileSync(join(cfgP, 'tokenbrake.json'), JSON.stringify({ compactPrep: true }));
  r = start(ev);
  const ctx = parse(r.stdout)?.hookSpecificOutput;
  t('prep on: SessionStart additionalContext carries the working set', r.status === 0 && ctx && ctx.hookEventName === 'SessionStart' && ctx.additionalContext.includes('/p/src/cart.js (lines 42-44)'));
  t('prep on: the ledger records the injection', ledger().some(l => l.ev === 'compact-prep' && l.session === 'sp'));
  r = start({ ...ev, source: 'startup' });
  t('prep on: a startup (not a compaction) injects nothing', r.status === 0 && r.stdout === '');
  r = start({ ...ev, transcript_path: outside });
  t('prep on: a transcript path outside projects/ is not opened', r.status === 0 && r.stdout === '');
  r = start({ ...ev, transcript_path: join(cfgP, 'projects', 'p', '..', '..', 'elsewhere.jsonl') });
  t('prep on: a path that climbs out of projects/ is not opened', r.status === 0 && r.stdout === '');
  r = spawnSync(process.execPath, ['./guard.js', 'session-start'], { input: 'not json', encoding: 'utf8', env: envP });
  t('prep on: garbage stdin fails open', r.status === 0 && r.stdout === '');

  const cliP = (a) => spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), ...a], { encoding: 'utf8', env: envP, cwd: PROJ });
  cliP(['init']);
  const sP = JSON.parse(readFileSync(join(cfgP, 'settings.json'), 'utf8'));
  const ss = (sP.hooks.SessionStart || []).filter(g => g.hooks.some(h => (h.args || []).some(a => a.includes('tokenbrake'))));
  t('init: one SessionStart group, matcher compact, mode session-start', ss.length === 1 && ss[0].matcher === 'compact' && ss[0].hooks[0].args[1] === 'session-start');
  /* The plugin's hooks.json mirrors cli.js's HOOKS table: the same events, matchers and modes init installs. */
  const shape = (hooks) => Object.entries(hooks).flatMap(([ev, gs]) => gs.filter(g => g.hooks.some(h => (h.args || []).some(a => /tokenbrake|CLAUDE_PLUGIN_ROOT/.test(a))))
    .map(g => ev + '|' + g.matcher + '|' + g.hooks[0].args[1])).sort().join(',');
  t('plugin hooks.json installs exactly what init installs', shape(JSON.parse(readFileSync('./hooks/hooks.json', 'utf8')).hooks) === shape(sP.hooks),
    shape(JSON.parse(readFileSync('./hooks/hooks.json', 'utf8')).hooks));
  r = cliP(['status']);
  t('status: the SessionStart hook spawns and returns a working set', /SessionStart spawn test .*: ok/.test(r.stdout), (r.stdout.split('\n').find(l => /SessionStart spawn/.test(l)) || '').trim());
  cliP(['uninstall']);
  const sU = JSON.parse(readFileSync(join(cfgP, 'settings.json'), 'utf8'));
  t('uninstall: the SessionStart group is gone', !(sU.hooks && sU.hooks.SessionStart));
  const plug = JSON.parse(readFileSync('./hooks/hooks.json', 'utf8')).hooks.SessionStart;
  t('plugin: SessionStart on compact, the guard from the plugin root', plug && plug[0].matcher === 'compact' && plug[0].hooks[0].args[0] === '${CLAUDE_PLUGIN_ROOT}/guard.js' && plug[0].hooks[0].args[1] === 'session-start');
  rmSync(cfgP, { recursive: true, force: true });
}

/* ---- report --compactions: each compaction priced ----------------------------- */
{
  console.log('\n-- report --compactions');
  const TR = createRequire(import.meta.url)('./transcript.js');
  const cfgC = mkdtempSync(join(tmpdir(), 'tokenbrake-compact-'));
  const dir = join(cfgC, 'projects', 'work');
  mkdirSync(dir, { recursive: true });
  const t0 = Date.parse('2026-09-20T10:00:00Z');
  const at = (minutes) => new Date(t0 + minutes * 60000).toISOString();
  let n = 0;
  const asst = (minutes, content, ctx, write) => ({ type: 'assistant', requestId: 'q' + (++n), timestamp: at(minutes),
    message: { model: 'claude-opus-5', content, usage: { cache_read_input_tokens: ctx - write, cache_creation_input_tokens: write, input_tokens: 0, output_tokens: 10 } } });
  const req = (ctx, write, minutes) => asst(minutes, [], ctx, write);
  const readUse = (id, file, minutes) => asst(minutes, [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }], 1000, 0);
  const readRes = (id, minutes) => ({ type: 'user', timestamp: at(minutes), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(4000) }] } });
  const session = (sid, trigger, cwd) => {
    n = 0;
    const lines = [readUse('a', '/w/app.js', 1), readRes('a', 1), req(300000, 500, 2),
      { type: 'system', subtype: 'compact_boundary', timestamp: at(3), compactMetadata: { trigger, preTokens: 300000 } },
      { type: 'user', isCompactSummary: true, message: { content: 'summary' } },
      req(50000, 50000, 4), readUse('b', '/w/app.js', 5), readRes('b', 5), req(52000, 500, 6), req(53000, 500, 7)];
    writeFileSync(join(dir, sid + '.jsonl'), lines.map(e => JSON.stringify({ sessionId: sid, cwd, ...e })).join('\n') + '\n');
    return TR.parseTranscript(join(dir, sid + '.jsonl'));
  };
  const p = session('auto1', 'auto', '/w');
  t('parse: the compact_boundary is kept with its trigger and size', p.boundaries.length === 1 && p.boundaries[0].trigger === 'auto' && p.boundaries[0].preTokens === 300000);
  const [row] = TR.compactionView(p);
  t('compactions: the drop is pre minus the next request\'s context', row && row.pre === 300000 && row.post === 50000 && row.drop === 250000);
  t('compactions: the saving is the drop re-read less on every later request, at the calibrated read weight',
    row && Math.abs(row.saving - 250000 * row.requestsCounted * TR.LIMIT_WEIGHTS.read / 1e6) < 1e-9 && row.requestsCounted === 4);
  t('compactions: a file read before and again after is recovery', row && row.recovery.files.length === 1 && row.recovery.files[0] === '/w/app.js' && row.recovery.pts > 0);
  /* Two compactions close together: a read after the second is recovery for the second only. */
  n = 0;
  const two = [readUse('a', '/w/app.js', 1), readRes('a', 1), req(300000, 500, 2),
    { type: 'system', subtype: 'compact_boundary', timestamp: at(3), compactMetadata: { trigger: 'auto', preTokens: 300000 } },
    req(50000, 50000, 4),
    { type: 'system', subtype: 'compact_boundary', timestamp: at(5), compactMetadata: { trigger: 'auto', preTokens: 60000 } },
    req(40000, 40000, 6), readUse('b', '/w/app.js', 7), readRes('b', 7), req(41000, 500, 8)];
  writeFileSync(join(dir, 'two.jsonl'), two.map(e => JSON.stringify({ sessionId: 'two', cwd: '/w', ...e })).join('\n') + '\n');
  const [first, second] = TR.compactionView(TR.parseTranscript(join(dir, 'two.jsonl')));
  t('compactions: recovery stops at the next compaction, so no read is counted twice', first.recovery.files.length === 0 && second.recovery.files.length === 1);
  rmSync(join(dir, 'two.jsonl'));
  /* A lost detail looked up with a shell grep of a file read before the compaction is recovery too; a lookup of a
     file never read before is new work. */
  n = 0;
  const shellUse = (id, command, minutes) => asst(minutes, [{ type: 'tool_use', id, name: 'Bash', input: { command } }], 1000, 0);
  const grepped = [readUse('a', '/w/app.js', 1), readRes('a', 1), req(300000, 500, 2),
    { type: 'system', subtype: 'compact_boundary', timestamp: at(3), compactMetadata: { trigger: 'auto', preTokens: 300000 } },
    req(50000, 50000, 4), shellUse('g', 'grep -n LIMIT app.js', 5), readRes('g', 5), shellUse('h', 'cat other.js', 6), readRes('h', 6), req(51000, 500, 7)];
  writeFileSync(join(dir, 'grep.jsonl'), grepped.map(e => JSON.stringify({ sessionId: 'grep', cwd: '/w', ...e })).join('\n') + '\n');
  const [g] = TR.compactionView(TR.parseTranscript(join(dir, 'grep.jsonl')));
  t('compactions: a grep naming a file read before is recovery; a file never read is not', g.recovery.files.length === 1 && g.recovery.files[0] === 'app.js' && g.recovery.pts > 0);
  rmSync(join(dir, 'grep.jsonl'));
  const big = TR.compactionView(p, { defaultWindow: 290000 });
  t('compactions: the saving stops where the uncompacted context passes the default window', big[0].requestsCounted === 0 && big[0].saving === 0);
  t('stage 2: an automatic Opus 5 compaction outside the bench counts', TR.compactionWhy(row, '/w') === '');
  t('stage 2: manual, other models and bench or calibration sessions do not',
    TR.compactionWhy({ ...row, trigger: 'manual' }, '/w') === 'manual trigger' && /^model/.test(TR.compactionWhy({ ...row, model: 'claude-fable-5-1' }, '/w'))
    && TR.compactionWhy(row, '/x/tokenbrake-bench') === 'benchmark/calibration' && TR.compactionWhy(row, '/tmp/calibration') === 'benchmark/calibration');
  const rowsOf = (saving, rec) => Array.from({ length: TR.STAGE2.n }, () => ({ saving, recovery: { pts: rec } }));
  t('stage 2: no verdict before 8 are counted', TR.compactionVerdict(rowsOf(10, 0).slice(1)).verdict === null);
  t('stage 2: PASS when recovery plus the 1.6 charge stays under half the saving', TR.compactionVerdict(rowsOf(10, 1)).verdict === 'PASS');
  t('stage 2: NOT YET when only the 0.5 estimate passes', TR.compactionVerdict(rowsOf(3, 0.5)).verdict === 'NOT YET');
  t('stage 2: FAIL when even the estimate does not', TR.compactionVerdict(rowsOf(1, 1)).verdict === 'FAIL');

  session('man1', 'manual', '/w');
  session('bench1', 'auto', '/x/tokenbrake-bench/run');
  const rep = (...a) => spawnSync(process.execPath, [join(process.cwd(), 'cli.js'), 'report', '--compactions', ...a], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: cfgC } });
  const r = rep();
  t('report --compactions: exit 0, three found', r.status === 0 && /Compactions -- 3 found/.test(r.stdout), r.stderr);
  t('report --compactions: only the automatic Opus 5 one outside the bench counts', /Counted: 1 of the 8/.test(r.stdout) && /no -- manual trigger/.test(r.stdout) && /no -- benchmark\/calibration/.test(r.stdout));
  t('report --compactions --since: earlier compactions are left out', /Compactions -- 0 found since 2099-01-01/.test(rep('--since=2099-01-01').stdout));
  t('report --compactions --since: a non-date is refused, exit 1', rep('--since=someday').status === 1);
  rmSync(cfgC, { recursive: true, force: true });
}

rmSync(CFG, { recursive: true, force: true });
console.log(fails.length ? '\nFAILED: ' + fails.join(', ') : '\nall tokenbrake checks passed');
process.exit(fails.length ? 1 : 0);
