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
  shapeFilters: false,   // OFF by default: collapse progress redraws and repeated lines before anything else
  shapeMinChars: 1500,   // and only on results at least this long
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
/* A shell command whose whole output is one file's contents: cat, sed -n with a range, head, tail, or a grep
   of a single named file — with no pipe and no redirect. That is a read, the same act as the Read tool, and
   the guard leaves a Read whole up to readMaxBytes. Until 0.2.3 it trimmed the same bytes to head, tail and
   error-looking lines when they came through sed, which for source is the wrong three things to keep, and a
   model that met that once sized every read after it to stay under maxChars: eighty-line sed ranges,
   ninety-one requests, twice the bill (AB-TASK.md, "Three arms"). Same shape as readKey in transcript.js;
   keep them together.

   Three things the first version got wrong, all found in one measured session (AB-TASK.md, pair 5):

   - **A `cd … &&` prefix lost the exemption.** Models working in a fixed directory write
     `cd "…/repo" && sed -n '502,535p' data.ndjson`, and that 34-line range — the model had already narrowed
     it — was shredded to head, tail and error lines. A `cd` adds no output, so it cannot change what the
     command prints.
   - **A label before or after lost it too.** `echo '=== settle.js ==='; sed -n '320,345p' settle.js` and
     `… && echo done` are the same read with one line of chrome around it. Models label their output
     constantly.
   - **A quoted path with a space lost it.** `cat "Settlement Batch.csv"` — and Windows paths have spaces.

   Pipes and redirects stay excluded on purpose: `sed -n '1,50p' f | grep x` no longer prints the file, it
   prints a filter over it, and trimming that is fair game. Recursive and list-only greps are excluded for
   the same reason — they are a search across files, not one file's contents. */
const PATH_ = String.raw`(?:'[^']+'|"[^"]+"|[^|;&<>'"\s]+)`;
const LABEL_ = String.raw`echo(?:\s+(?:'[^']*'|"[^"]*"|[^|;&<>'"\s]+))*`;
const READ_ = String.raw`(?:cat(?:\s+-[bnAEsTv]+)*|sed\s+-n\s+['"]?[0-9]+,[0-9]+p['"]?|head(?:\s+-n?\s*[0-9]+)?` +
  String.raw`|tail(?:\s+-n?\s*[0-9]+)?|grep(?:\s+-(?![rRlL])[a-zA-Z]+)*\s+${PATH_})\s+${PATH_}`;
const EXCERPT = new RegExp(
  String.raw`^\s*(?:cd\s+${PATH_}\s*&&\s*)?(?:${LABEL_}\s*(?:&&|;)\s*)?${READ_}` +
  String.raw`(?:\s*(?:&&|;)\s*${LABEL_})*\s*$`);

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

/* Shape filters, OFF by default and A/B'd before any default moves.

   The trim only acts above maxChars, and a measured install log shows why that is not enough on its own:
   400 lines of progress bars kept 65 progress lines and 144 ANSI escape sequences and spent nearly the
   whole 6,000-character budget on them, leaving the final status alive only because it sat in the tail.
   Repeated near-identical lines are not information; they are the same line drawn again.

   Three passes, all conservative, in this order:
     1. ANSI escapes go. They colour a terminal nobody is looking at.
     2. A carriage-return redraw keeps its last frame. `\r` exists to overwrite, so only the last write was
        ever visible.
     3. A run of three or more consecutive lines carrying a run of BAR GLYPHS collapses to its LAST line
        plus a count. The
        last one is the informative frame — 100%, the final total — and the count keeps the fact that
        there were many.

   Redraw-like is the whole safety of this. "Differs only in numbers" is not enough and was the first
   version's bug: sixty rows of a settlement table — `acme-041   EUR   2517.41   settled` — differ only in
   numbers too, and collapsing them destroys fifty-nine tenants' amounts and leaves a count. Found by an
   outside benchmark before a single run was paid for. A line qualifies only if it carries a run of bar
   glyphs. A percentage was allowed for one afternoon and had to be removed for the same reason: risk
   scores are percentages too.

   What it deliberately does not do: collapse passing-test lines. Their names are answers to real questions
   ("how many checks passed, and what was the last one") and a count is not always enough. That is a
   separate flag if it is ever wanted, measured separately.

   Nothing here is lossy about which distinct lines occurred, only about how many times a line was redrawn. */
const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;
function shapeKey(line) {
  return line
    .replace(/[=\-#>*.·▏▎▍▌▋▊▉█░▒▓]{2,}/g, '§')  // a run of bar glyphs is one glyph
    .replace(/\d[\d.,:%]*/g, '#')                 // any number is the same number
    .replace(/[ \t]+/g, ' ')                      // a bar pads itself with spaces as it fills
    .trim();
}
/* A progress redraw carries a run of bar glyphs. Nothing else is enough.

   A percentage was in this list for one afternoon and had to come out: eighty rows of
   `tenant acme-079 risk score 53% approved` collapsed to one row and a count, the same destruction the
   settlement table showed, reached through the other half of the test. Percentages appear in data far more
   often than they appear in progress bars, and "the numbers differ" is never a licence to delete a line.
   The cost of dropping it is that `Downloading… 45%` with no bar is no longer collapsed. That is the right
   side to err on: a filter that misses noise is a nuisance, one that eats rows is a bug. */
const REDRAW = /[=\-#>*·▏▎▍▌▋▊▉█░▒▓]{3,}/;
function shapeFilter(text) {
  /* `\r` at the END of a line is a CRLF line ending, not a redraw. Treating it as one turned a 120-row
     CRLF CSV into 121 characters of empty lines — every field gone — because "keep what follows the last
     \r" follows nothing. A line is only a redraw if a `\r` sits INSIDE it; a plain line, CRLF or LF, comes
     through byte for byte. */
  const src = text.replace(ANSI, '').split('\n').map(l => {
    const body = l.endsWith('\r') ? l.slice(0, -1) : l;
    if (body.indexOf('\r') < 0) return l;
    return body.slice(body.lastIndexOf('\r') + 1);
  });
  const out = [];
  for (let i = 0; i < src.length;) {
    const key = shapeKey(src[i]);
    let j = i + 1;
    if (key && REDRAW.test(src[i])) while (j < src.length && shapeKey(src[j]) === key && REDRAW.test(src[j])) j++;
    const run = j - i;
    if (run >= 3) {
      out.push(src[j - 1]);
      out.push(`[tokenbrake] the line above was drawn ${run} times; ${run - 1} identical-shaped lines collapsed`);
    } else {
      for (let k = i; k < j; k++) out.push(src[k]);
    }
    i = j;
  }
  return out.join('\n');
}

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

  /* Shaping runs before the size test, so a log that collapses below maxChars is delivered clean and never
     trimmed at all. That is the point: the trim's head/tail/flagged shape is right for a log and the wrong
     thing to spend on redraws. */
  let shaped = false;
  if (isShell && cfg.shapeFilters && text.length >= cfg.shapeMinChars) {
    const s2 = shapeFilter(text);
    if (s2.length < text.length) { rec.shapedFrom = text.length; rec.shapedTo = s2.length; text = s2; shaped = true; }
  }

  if (!isShell || text.length <= cfg.maxChars) {
    if (cfg.logAllTools) log(rec);
    /* Shaped but under the trim threshold: the replacement still has to go out, or the shaping is a
       measurement of something the model never received — the mistake the report's credit fix was about. */
    if (shaped) {
      const u = (!failed && resp && typeof resp === 'object') ? { ...resp, stdout: text, stderr: '' } : text;
      emit({ hookSpecificOutput: { hookEventName: failed ? 'PostToolUseFailure' : 'PostToolUse', updatedToolOutput: u } });
    }
    return;
  }

  /* A file excerpt is read like a Read: untouched up to readMaxBytes, and above that capped to the first
     readLimitLines lines with the same note the Read cap gives, not trimmed to head, tail and error lines. */
  const excerpt = !failed && EXCERPT.test(String(ti.command || ''));
  if (excerpt && text.length <= cfg.readMaxBytes) {
    if (cfg.logAllTools) log({ ...rec, excerpt: true });
    return;
  }
  if (excerpt) {
    const all = text.split('\n');
    const kept = all.slice(0, cfg.readLimitLines).join('\n');
    const trimmedExcerpt = `${kept}\n\n[tokenbrake] file excerpt capped at the first ${cfg.readLimitLines} of ${all.length.toLocaleString()} lines (${text.length.toLocaleString()} chars). A few large ranges cost less than many small ones: each call is a request that re-reads the whole context. Use a narrower range, or Grep to locate the section first.`;
    log({ ...rec, excerpt: true, kept: trimmedExcerpt.length, saved: null });
    const updatedExcerpt = (resp && typeof resp === 'object') ? { ...resp, stdout: trimmedExcerpt, stderr: '' } : trimmedExcerpt;
    emit({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updatedExcerpt } });
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

/* Lines in a file, by counting newline bytes -- the ledger's `lines` convention throughout, so a file with no
   trailing newline reads one short. Skipped above 20 MB rather than reading that much to count. */
function countLines(fp, size) {
  if (size > 20 * 1024 * 1024) return null;
  try {
    const buf = fs.readFileSync(fp);
    let n = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) n++;
    return n;
  } catch { return null; }
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
  /* A whole-file read the cap did NOT act on is still worth recording, and until now nothing recorded it.
     Without it, `report --reads` had to infer every file's size from the delivered text -- which Claude Code
     line-numbers, so every file came out 5-6% large and the long ones worse -- and `report --where` could
     resolve a file's length for only one ranged read in forty-three, leaving the question of whether the cap
     should be a line count or a fraction of the file unanswerable. statSync has already run here, so the size
     is free; the line count costs one read of a file that is under the trigger by definition.
     This changes no decision the guard makes and alters no output: it writes a ledger row and returns, exactly
     as before. Its value is that the trigger's own evidence stops being an inference. */
  if (!persisted && st.size <= cfg.readMaxBytes) {
    if (cfg.logAllTools) log({ ev: 'read-whole', session: input.session_id, tool: 'Read', what: fp,
      bytes: st.size, lines: countLines(fp, st.size) });
    return;
  }
  const limit = persisted ? cfg.persistedLimitLines : cfg.readLimitLines;
  const lineCount = countLines(fp, st.size);

  log({ ev: 'read-cap', session: input.session_id, tool: 'Read', what: fp, bytes: st.size, lines: lineCount, limit, persisted });

  const sizeDesc = `${lineCount != null ? lineCount.toLocaleString() + ' lines / ' : ''}${Math.round(st.size / 1024)} KB`;
  const why = persisted
    ? `${path.basename(fp)} is a saved tool output, ${sizeDesc}: it was too big to show inline, so it is too big to read whole. tokenbrake capped this read at the first ${limit} lines.`
    : `${path.basename(fp)} is ${sizeDesc}. tokenbrake capped this read at the first ${limit} lines to save context.`;
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      updatedInput: { ...ti, limit },
      additionalContext: `${why} Use offset/limit to read the section you need, or Grep to locate it first. A few large ranges cost less than many small ones: each call is a request that re-reads the whole context.`
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
