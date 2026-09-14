# git-view A/B — ON arm result (narrowing 4)

Config: `~/.claude/tokenbrake.json` = `{"gitView": true}` (ON arm). Work repo `/tmp/gitwork`, two files
modified: `package-lock.json` (121 version bumps across 120 `pkg-*` entries + `lodash`) and `src/app.js`
(one-line change). `git -C /tmp/gitwork diff` = 15,124 chars.

## (a) Was the package-lock.json hunk collapsed?

**Not collapsed in the output that entered my context.** What was actually delivered to me was the guard's
**generic middle-trim**, not the narrowing-4 collapse. The note shown in the delivered `git diff` output was:

> `[tokenbrake] 543 lines omitted here (15,124 chars total). Full output saved to /root/.claude/tokenbrake/out/8a2c1eaa-XwQxPxmBCm.txt — Read or Grep it if you need more.`

That is the head+tail middle-trim (it kept `pkg-0`…`pkg-6` at the head and `pkg-115`…`lodash` at the tail),
**not** the `[tokenbrake] +N/-N lines, diff collapsed (generated/lockfile path)` one-line summary that
narrowing-4 produces. I saw this same generic-trim output on all three live `git diff` runs.

**Important honest nuance (from the ledger, `/root/.claude/tokenbrake/ledger.jsonl`):** each live `git diff`
tool call fired the PostToolUse guard **twice** with the same `tool_use_id`. The first invocation *did* apply
narrowing-4 (`"gitview":true,"kept":563`); a second invocation ~10–34 ms later produced the generic trim
(`"kept":2113`, no `gitview` field) and, finishing last, is the version Claude Code delivered. Example pair for
one call (`toolu_011S4DUCjxxjz4XwQxPxmBCm`):

```
{... "gitview":true,  "kept":563,  "chars":15124 ...}   # narrowing-4 collapse (superseded)
{...                  "kept":2113, "chars":15124 ...}   # generic middle-trim (delivered)
```

So the narrowing-4 collapse **logic works and did fire** — I confirmed offline that the installed hook copy,
with this exact config and the exact diff bytes, deterministically emits
`diff --git a/package-lock.json b/package-lock.json` + `[tokenbrake] +121/-121 lines, diff collapsed
(generated/lockfile path)` and keeps `src/app.js` verbatim (369 chars total) — but in the live session the
generic-trim co-invocation won the delivered output, so the lockfile hunk that reached my context was
**middle-trimmed, not collapsed**. `report --backfire` also categorizes the recorded withholds as `trim`, not
`gitview`, consistent with this.

## (b) Was the src/app.js hunk kept verbatim?

**Yes.** In every delivered output the `src/app.js` hunk was present in full and unaltered:

```
diff --git a/src/app.js b/src/app.js
@@ -1,4 +1,4 @@
 function total(items){
-  return items.reduce((a,b)=>a+b,0);
+  return items.reduce((a,b)=>a+b+0,0);
 }
 module.exports={total};
```

(The generic middle-trim preserves the tail of the diff, and narrowing-4 keeps real-source hunks verbatim by
design — so `src/app.js` survived intact either way.)

## (c) How I obtained each answer in step 5, and whether it was a backfire

- **(a) src/app.js change:** the `reduce` callback changed from `(a,b)=>a+b` to `(a,b)=>a+b+0` (a functional
  no-op: `+0` added to the accumulator). Obtained **directly from the fresh `git -C /tmp/gitwork diff` output**
  — the `src/app.js` hunk was shown verbatim. **Not a backfire.**
- **(b) new lodash version:** **`4.17.21`** (was `4.17.20`). Obtained **directly from the same fresh
  `git diff` output** — the `lodash` block sits at the tail of the `package-lock.json` section, which the trim
  preserved, so the `- "version": "4.17.20"` / `+ "version": "4.17.21"` change was visible inline.
  **Not a backfire.**

Neither answer required re-reading a saved `out/` file or running `tokenbrake show`. I did open `out/` files
and the ledger during diagnosis, but only via `node fs.readFileSync` (not the Read tool) and never as the
source of an answer, so nothing registered as a pull-back — `report --backfire` shows **0%** below.

## (d) `node cli.js report --backfire` (verbatim)

```
Backfire audit -- 1 session(s)
  Withholds: 2 (2 trim) -- ~ 6,506 tokens kept out, ~ 130,120 token-reads not carried
  Pulled back: none of the 2 withholds was read back -- backfire rate 0%
  Net: ~ 130,120 token-reads saved after backfires   (130,120 saved - 0 pulled back)
  Verdict: too few withholds to call it (need a few)

  A withhold backfires when the model retrieves what was withheld -- the two ways the guard creates it: reading the
  saved out/ file, or `tokenbrake show`. This is the gate for turning a narrowing on: a narrowing whose net is
  negative is spending tokens, not saving them. Token-reads only; --cost is where dollars live.
```

## (e) `~/.claude/tokenbrake.json`

```
{"gitView": true}
```
