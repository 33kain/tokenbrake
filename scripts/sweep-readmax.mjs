#!/usr/bin/env node
/* tokenbrake — readMaxBytes × readLimitLines sweep
 *
 * WHAT IT ANSWERS
 *   Does lowering readMaxBytes increase the saving? No. It is a TRIGGER (from what
 *   file size the guard fires), not a strength (how much it cuts). readLimitLines
 *   is what moves the percentage. So the question about readMaxBytes is only which
 *   files it should fire on, and that is answered by real sessions, not by this sweep
 *   (AB-TASK.md, "The Read cap's trigger").
 *
 * HOW IT MEASURES
 *   For each (readMaxBytes, readLimitLines) pair it writes a real tokenbrake.json into
 *   a throwaway CLAUDE_CONFIG_DIR, spawns the REAL guard.js in read-pre mode against a
 *   real file on disk, and uses whatever limit the guard returns. Carried context =
 *   tokens × (5+4+3): three unbounded reads of the same file carried through a
 *   six-request session, the same shape as the fixture in test.mjs, with the Bash arm
 *   left out so the Read cap is isolated.
 *
 *   Arm A is the whole file. Read has no ceiling of its own in the sizes swept here:
 *   a 65 KB file entered a real session as 60,359 characters. (The ~30,000-character
 *   save-to-a-file ceiling is Bash's. The first version of this sweep, 2026-09-07,
 *   applied it to the Read too and so reported 19% for the 40 KB file; that number
 *   was against a truncation that does not happen.)
 *
 * RUN
 *   node scripts/sweep-readmax.mjs        (from the repository root)
 *
 * RESULT (2026-09-07, guard.js at this commit)
 *   64 KB file, 800 lines:  62.5% / 75.0% / 87.5% at readLimitLines 300 / 200 / 100,
 *                           identical for every readMaxBytes from 60,000 down to 10,000.
 *   40 KB file, 500 lines:  0% at readMaxBytes 60,000 (the guard never fires), then
 *                           40.0% / 60.0% / 80.0% at 300 / 200 / 100 once it does.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const guard = join(root, 'guard.js');

const mk = (lines, lineLen) => Array.from({ length: lines }, (_, i) => (`line ${i + 1} `.padEnd(lineLen, 'x')));
const files = {
  '64KB': mk(800, 80),     // ~64 KB, 80-char lines: the largest size verified to enter a session whole
  '40KB': mk(500, 80),     // ~40 KB, 80-char lines: the band the trigger is argued over
};

function ab(cfgOverride, lines) {
  const cfg = mkdtempSync(join(tmpdir(), 'tb-sweep-'));
  writeFileSync(join(cfg, 'tokenbrake.json'), JSON.stringify(cfgOverride));
  const fp = join(cfg, 'f.txt'); const text = lines.join('\n') + '\n';
  writeFileSync(fp, text);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg };
  const r = spawnSync(process.execPath, [guard, 'read-pre'],
    { input: JSON.stringify({ session_id: 's', tool_name: 'Read', tool_input: { file_path: fp } }), encoding: 'utf8', env });
  let limit = null; try { limit = JSON.parse(r.stdout).hookSpecificOutput.updatedInput.limit; } catch {}
  const whole = lines.join('\n');
  const capped = limit ? lines.slice(0, limit).join('\n') : whole;
  // three unbounded reads carried through 6 requests, as in test.mjs (shell arm left out to isolate the Read)
  const carried = (txt) => Math.round(txt.length / 4) * (5 + 4 + 3);
  const A = carried(whole), B = carried(capped);
  rmSync(cfg, { recursive: true, force: true });
  return { bytes: text.length, fired: limit != null, A, B, saved: (A - B) / A };
}

for (const [name, lines] of Object.entries(files)) {
  console.log(`\n== ${name} file (${lines.join('\n').length + 1} bytes, ${lines.length} lines)`);
  console.log('readMaxBytes  readLimitLines  fired  carried A -> B      saved');
  for (const rmb of [60000, 40000, 30000, 25000, 10000])
    for (const rll of [300, 200, 100]) {
      const x = ab({ readMaxBytes: rmb, readLimitLines: rll }, lines);
      console.log(`${String(rmb).padEnd(13)} ${String(rll).padEnd(15)} ${String(x.fired).padEnd(6)} ${String(x.A).padStart(6)} -> ${String(x.B).padStart(6)}   ${(x.saved * 100).toFixed(1).padStart(6)}%`);
    }
}
