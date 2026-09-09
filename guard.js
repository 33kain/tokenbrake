#!/usr/bin/env node
'use strict';
// tokenbrake guard — Claude Code hook handler.
// Zero dependencies. Fails open: any error => exit 0 with no output, Claude Code proceeds unchanged.
//
// Modes (argv[2]):
//   post      PostToolUse (matcher *) and PostToolUseFailure (Bash|PowerShell): trims oversized shell output,
//             logs every tool result size. A command that exits non-zero is a different event, and until 0.2.2
//             the guard never saw it: every failing test run entered whole.
//   read-pre  PreToolUse (matcher Read): caps unbounded reads of large files via updatedInput.limit

const fs = require('fs');
const path = require('path');
const os = require('os');

const MODE = process.argv[2] || 'post';
const CFG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const TB_DIR = path.join(CFG_DIR, 'tokenbrake');
const HOOK_OUTPUT_CAP = 9500; // Claude Code caps hook output strings at 10,000 chars

const DEFAULTS = {
  enabled: true,
  maxChars: 6000,        // shell output longer than this gets trimmed (built-in ceiling is ~30,000)
  headLines: 40,
  tailLines: 40,
  keepErrorLines: 20,    // lines from the middle that look like errors/warnings are kept
  errorContextLines: 3,  // and this many lines after each, up to a blank line: the assertion, the expected/actual, the first frame
  readMaxBytes: 60000,   // Read without offset/limit on a file bigger than this gets capped
  readLimitLines: 300,
  persistedLimitLines: 80, // a saved tool output (Claude Code's tool-results/, tokenbrake's out/) read whole is capped at this
  logAllTools: true      // record size of every tool result in the ledger (feeds `tokenbrake report`)
};

/* A persisted output: a tool result that was too big to show inline and was written to a file, by Claude Code
   (<config>/projects/<cwd>/<session>/tool-results/<id>.txt, its ~30,000-character ceiling) or by this guard
   (<config>/tokenbrake/out/<id>.txt). Reading one whole puts the oversized output back into context by another
   door; it carried 96% of the untrimmed audit arm's context (AB-TASK.md). Output that was too big to show is
   too big to read whole, whatever readMaxBytes says. */
const PERSISTED = /(^|[\\/])(tool-results|tokenbrake[\\/]out)[\\/][^\\/]+\.txt$/;

/* A line that opens with a pass marker is a passing test whatever its name says: "ok   error render call
   passes resp through" is not an error. Without this, a suite whose test names mention errors fills the
   keepErrorLines budget with green lines and the real FAIL further down never makes the cut. */
const PASS = /^\s*(?:ok|pass(?:ed)?|✓|✔|√)\b/i;
const ERR = /\b(error|err!|fail(ed|ure|ing)?|exception|traceback|panic|fatal|warn(ing)?|not found|cannot|denied|refused)\b|✗|✖/i;

function loadConfig() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(CFG_DIR, 'tokenbrake.json'), 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { return null; }
}
function emit(obj) {
  fs.writeSync(1, JSON.stringify(obj)); // synchronous so exit can't truncate it
}
function log(rec) {
  try {
    fs.mkdirSync(TB_DIR, { recursive: true });
    fs.appendFileSync(path.join(TB_DIR, 'ledger.jsonl'), JSON.stringify({ t: Date.now(), ...rec }) + '\n');
  } catch { /* ledger is best-effort */ }
}
function short(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n) + '…' : s; }

function trimText(text, cfg, savedPath) {
  const lines = text.split('\n');
  const note = savedPath ? ` Full output saved to ${savedPath} — Read or Grep it if you need more.` : '';
  let out;

  if (lines.length > cfg.headLines + cfg.tailLines + 5) {
    /* Flagged lines from the middle, each with the lines that follow it up to a blank line or
       errorContextLines, whichever comes first. A FAIL line alone names the test; the assertion, the
       expected/actual pair and the first stack frame are the lines after it, and a model that gets only
       the name comes back for the rest: a whole extra request that re-reads everything. Windows that
       touch are merged; a gap between windows is shown as one "…" line. */
    const chars = (arr) => arr.reduce((n, l) => n + l.length + 1, 0);
    let headN = cfg.headLines, tailN = cfg.tailLines;
    let ctx = Math.max(0, Number(cfg.errorContextLines) || 0);
    const flaggedLines = (ctx) => {
      const midStart = headN, midEnd = lines.length - tailN;
      const keep = new Map();
      let flaggedCount = 0;
      for (let i = midStart; i < midEnd && flaggedCount < cfg.keepErrorLines; i++) {
        if (PASS.test(lines[i]) || !ERR.test(lines[i])) continue;
        flaggedCount++;
        keep.set(i, true);
        for (let j = i + 1; j <= i + ctx && j < midEnd; j++) {
          if (!lines[j].trim()) break;
          keep.set(j, true);
        }
      }
      const out = [];
      let prev = null;
      for (const i of [...keep.keys()].sort((a, b) => a - b)) {
        if (prev != null && i !== prev + 1) out.push('  …');
        out.push(`  L${i + 1}: ${short(lines[i], 200)}`);
        prev = i;
      }
      return out;
    };
    const marker = (flagged) => [
      '',
      `[tokenbrake] ${lines.length - tailN - headN} lines omitted here (${text.length.toLocaleString()} chars total).${note}`,
      ...(flagged.length ? [`[tokenbrake] error/warning-looking lines from the omitted region${ctx ? `, each with up to ${ctx} lines after it` : ''}:`, ...flagged] : []),
      ''
    ];
    /* Budget, in this order: the flagged lines and their context first, since they are what the model
       would otherwise come back for; then head and tail fill what is left of maxChars, down to a floor
       of ten lines each. Context that would take more than half the budget on its own is dropped and the
       flagged lines stand alone, as before 0.2.2. */
    let flagged = flaggedLines(ctx);
    if (ctx && chars(flagged) > cfg.maxChars / 2) { ctx = 0; flagged = flaggedLines(0); }
    const total = () => chars(lines.slice(0, headN)) + chars(marker(flagged)) + chars(lines.slice(lines.length - tailN));
    while (total() > cfg.maxChars && (headN > 10 || tailN > 10)) {
      if (headN >= tailN && headN > 10) headN--; else if (tailN > 10) tailN--; else headN--;
    }
    if (headN !== cfg.headLines || tailN !== cfg.tailLines) flagged = flaggedLines(ctx);   // the middle grew: scan it once more
    out = [...lines.slice(0, headN), ...marker(flagged), ...lines.slice(lines.length - tailN)].join('\n');
  } else {
    // Few lines but huge (minified output, one giant line): cut by characters.
    const half = Math.floor(cfg.maxChars / 2);
    out = text.slice(0, half) + `\n\n[tokenbrake] ${(text.length - 2 * half).toLocaleString()} chars omitted here.${note}\n\n` + text.slice(-half);
  }

  if (out.length > HOOK_OUTPUT_CAP) {
    const half = Math.floor((HOOK_OUTPUT_CAP - 120) / 2);
    out = out.slice(0, half) + `\n\n[tokenbrake] further trimmed to fit hook output cap.${note}\n\n` + out.slice(-half);
  }
  return out;
}

function handlePost(input, cfg) {
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const resp = input.tool_response;
  const isShell = tool === 'Bash' || tool === 'PowerShell';
  /* PostToolUseFailure: for Bash, the command exited non-zero. The output arrives in `error` as one string
     ("Exit code 1", then stdout and stderr), with no tool_response on the Claude Code line this was written
     against (2.1.261) and, per the docs, possibly both. Take whichever carries the text. An interrupted
     call is the user's doing: nothing to trim, nothing to log. */
  const failed = input.hook_event_name === 'PostToolUseFailure';
  if (failed && input.is_interrupt) return;
  const asText = (v) => typeof v === 'string' ? v
    : (v && typeof v === 'object') ? (isShell ? [v.stdout, v.stderr].filter(Boolean).join('\n') : JSON.stringify(v)) : '';
  let text = asText(resp);
  if (failed) { const e = asText(input.error); if (e.length > text.length) text = e; }

  /* `id` and `transcript` (0.1.0, for brake 4): the tool_use_id is how a ledger row joins the transcript's
     tool_result exactly, and transcript_path is where that transcript is — Claude Code hands both over on
     stdin, so the report never has to guess a path or match on a command string. */
  const rec = {
    ev: 'post', session: input.session_id, tool, chars: text.length,
    what: isShell ? short(ti.command, 120) : (ti.file_path || ti.pattern || ti.url || ti.description || undefined),
    id: input.tool_use_id || undefined,
    transcript: input.transcript_path || undefined,
    failed: failed || undefined
  };

  if (!isShell || text.length <= cfg.maxChars) {
    if (cfg.logAllTools) log(rec);
    return;
  }

  let saved = null;
  try {
    const outDir = path.join(TB_DIR, 'out');
    fs.mkdirSync(outDir, { recursive: true });
    const sid = String(input.session_id || 'session').slice(0, 8);
    const tid = String(input.tool_use_id || Date.now()).slice(-10).replace(/[^\w-]/g, '');
    saved = path.join(outDir, `${sid}-${tid}.txt`);
    fs.writeFileSync(saved, text);
  } catch { saved = null; }

  const trimmed = trimText(text, cfg, saved);
  log({ ...rec, kept: trimmed.length, saved });
  // Claude Code validates updatedToolOutput against the tool's own response schema. For Bash that is
  // { stdout, stderr, interrupted, isImage } — a bare string is rejected (silently, in the debug log only)
  // and the original output goes through untouched. Keep the object shape, put the trimmed text in stdout.
  // On failure the output Claude sees is the error string itself, so the replacement is a string too.
  const updated = (!failed && resp && typeof resp === 'object') ? { ...resp, stdout: trimmed, stderr: '' } : trimmed;
  emit({ hookSpecificOutput: { hookEventName: failed ? 'PostToolUseFailure' : 'PostToolUse', updatedToolOutput: updated } });
}

function handleReadPre(input, cfg) {
  const ti = input.tool_input || {};
  const fp = ti.file_path;
  if (!fp || ti.limit != null || ti.offset != null) return;          // already bounded
  if (/\.(png|jpe?g|gif|webp|bmp|svg|pdf|ipynb)$/i.test(fp)) return;   // binary/paged formats handled by Read itself

  let st;
  try { st = fs.statSync(fp); } catch { return; }
  if (!st.isFile()) return;
  const persisted = PERSISTED.test(fp) && st.size > cfg.maxChars;
  if (!persisted && st.size <= cfg.readMaxBytes) return;
  const limit = persisted ? cfg.persistedLimitLines : cfg.readLimitLines;

  let lineCount = null;
  if (st.size <= 20 * 1024 * 1024) {
    try { const buf = fs.readFileSync(fp); lineCount = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lineCount++; } catch { lineCount = null; }
  }

  log({ ev: 'read-cap', session: input.session_id, tool: 'Read', what: fp, bytes: st.size, lines: lineCount, limit, persisted });

  const sizeDesc = `${lineCount != null ? lineCount.toLocaleString() + ' lines / ' : ''}${Math.round(st.size / 1024)} KB`;
  const why = persisted
    ? `${path.basename(fp)} is a saved tool output, ${sizeDesc}: it was too big to show inline, so it is too big to read whole. tokenbrake capped this read at the first ${limit} lines.`
    : `${path.basename(fp)} is ${sizeDesc}. tokenbrake capped this read at the first ${limit} lines to save context.`;
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...ti, limit },
      additionalContext: `${why} Use offset/limit to read the section you need, or Grep to locate it first.`
    }
  });
}

(function main() {
  try {
    const cfg = loadConfig();
    if (!cfg.enabled) return;
    const input = readStdin();
    if (!input || typeof input !== 'object') return;
    if (MODE === 'read-pre') handleReadPre(input, cfg);
    else handlePost(input, cfg);
  } catch { /* fail open */ }
  process.exitCode = 0;
})();
