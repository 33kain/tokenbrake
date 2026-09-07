#!/usr/bin/env node
'use strict';
// tokenbrake guard — Claude Code hook handler.
// Zero dependencies. Fails open: any error => exit 0 with no output, Claude Code proceeds unchanged.
//
// Modes (argv[2]):
//   post      PostToolUse (matcher *): trims oversized Bash/PowerShell output, logs every tool result size
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
  readMaxBytes: 60000,   // Read without offset/limit on a file bigger than this gets capped
  readLimitLines: 300,
  logAllTools: true      // record size of every tool result in the ledger (feeds `tokenbrake report`)
};

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
    const head = lines.slice(0, cfg.headLines);
    const tail = lines.slice(-cfg.tailLines);
    const midStart = cfg.headLines, midEnd = lines.length - cfg.tailLines;
    const flagged = [];
    for (let i = midStart; i < midEnd && flagged.length < cfg.keepErrorLines; i++) {
      if (ERR.test(lines[i])) flagged.push(`  L${i + 1}: ${short(lines[i], 200)}`);
    }
    const omitted = midEnd - midStart;
    const marker = [
      '',
      `[tokenbrake] ${omitted} lines omitted here (${text.length.toLocaleString()} chars total).${note}`,
      ...(flagged.length ? [`[tokenbrake] error/warning-looking lines from the omitted region:`, ...flagged] : []),
      ''
    ];
    out = [...head, ...marker, ...tail].join('\n');
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

  let text = '';
  if (typeof resp === 'string') text = resp;
  else if (resp && typeof resp === 'object') {
    text = isShell ? [resp.stdout, resp.stderr].filter(Boolean).join('\n') : JSON.stringify(resp);
  }

  /* `id` and `transcript` (0.1.0, for brake 4): the tool_use_id is how a ledger row joins the transcript's
     tool_result exactly, and transcript_path is where that transcript is — Claude Code hands both over on
     stdin, so the report never has to guess a path or match on a command string. */
  const rec = {
    ev: 'post', session: input.session_id, tool, chars: text.length,
    what: isShell ? short(ti.command, 120) : (ti.file_path || ti.pattern || ti.url || ti.description || undefined),
    id: input.tool_use_id || undefined,
    transcript: input.transcript_path || undefined
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
  const updated = (resp && typeof resp === 'object') ? { ...resp, stdout: trimmed, stderr: '' } : trimmed;
  emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated } });
}

function handleReadPre(input, cfg) {
  const ti = input.tool_input || {};
  const fp = ti.file_path;
  if (!fp || ti.limit != null || ti.offset != null) return;          // already bounded
  if (/\.(png|jpe?g|gif|webp|bmp|svg|pdf|ipynb)$/i.test(fp)) return;   // binary/paged formats handled by Read itself

  let st;
  try { st = fs.statSync(fp); } catch { return; }
  if (!st.isFile() || st.size <= cfg.readMaxBytes) return;

  let lineCount = null;
  if (st.size <= 20 * 1024 * 1024) {
    try { const buf = fs.readFileSync(fp); lineCount = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lineCount++; } catch { lineCount = null; }
  }

  log({ ev: 'read-cap', session: input.session_id, tool: 'Read', what: fp, bytes: st.size, lines: lineCount });

  const sizeDesc = `${lineCount != null ? lineCount.toLocaleString() + ' lines / ' : ''}${Math.round(st.size / 1024)} KB`;
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...ti, limit: cfg.readLimitLines },
      additionalContext: `${path.basename(fp)} is ${sizeDesc}. tokenbrake capped this read at the first ${cfg.readLimitLines} lines to save context. Use offset/limit to read the section you need, or Grep to locate it first.`
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
