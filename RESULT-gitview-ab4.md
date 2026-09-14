# git-view A/B — ON arm, clean run (narrowing 4)

## Step 0 — Environment cleanliness

`node cli.js status 2>&1 | grep -iE 'installed|scope|twice|guard file'`:

```
  guard file: missing (/root/.claude/hooks/tokenbrake/guard.js)
  guard build: no copy installed
  installed at project scope instead (/home/user/tokenbrake/.claude/settings.json): the guard runs once, from there
```

**Env is CLEAN.** No "also installed at ... scope" and no "runs twice". The guard
is installed at **project scope only** and "runs once, from there" — the stale
global/user install was successfully removed, so there is no double-fire.

## Delivered git diff — COLLAPSE (gitview), not the generic trim

`git -C /tmp/gitwork diff` delivered the **gitview narrowing-4 COLLAPSE**, not the
generic "lines omitted here" trim. The lockfile diff was replaced with the
collapse note:

> `[tokenbrake] +121/-121 lines, diff collapsed (generated/lockfile path)`

and a trailer:

> `[tokenbrake] collapsed 1 generated/lockfile diff above; real-source hunks kept. Full diff saved to /root/.claude/tokenbrake/out/00bb59c0-VHEaVBbvfJ.txt — Read it if you need the collapsed parts.`

## src/app.js kept verbatim

**Yes.** The `src/app.js` hunk was delivered verbatim (real-source hunks kept):

```
diff --git a/src/app.js b/src/app.js
index 68c81ed..75d35ad 100644
--- a/src/app.js
+++ b/src/app.js
@@ -1,4 +1,4 @@
 function total(items){
-  return items.reduce((a,b)=>a+b,0);
+  return items.reduce((a,b)=>a+b+0,0);
 }
 module.exports={total};
```

## Answers

**(a) What changed in `src/app.js`:** the reduce callback changed from
`(a,b)=>a+b` to `(a,b)=>a+b+0` (a `+0` was added to the accumulator expression).
Behavior is unchanged. **How I got it:** directly from the delivered git diff —
the source hunk was kept verbatim by the collapse. **Not a backfire.**

**(b) New version of the `lodash` dependency:** `4.17.21` (was `4.17.20`).
**How I got it:** the lockfile diff was collapsed, so I did NOT read the saved
`out/` file and did NOT run `tokenbrake show`. Instead I ran a **fresh targeted
`git diff -- package-lock.json | grep lodash`** and also **grepped the current
working-tree `package-lock.json`** directly. Both are re-derivations from the
original source, **not a backfire**.

## `node cli.js report --backfire` (full output, verbatim)

```
Backfire audit -- 1 session(s)
  Withholds: 1 (1 gitview) -- ~ 3,640 tokens kept out, ~ 10,920 token-reads not carried
  Pulled back: none of the 1 withholds was read back -- backfire rate 0%
  Net: ~ 10,920 token-reads saved after backfires   (10,920 saved - 0 pulled back)
  Verdict: too few withholds to call it (need a few)

  A withhold backfires when the model retrieves what was withheld -- the two ways the guard creates it: reading the
  saved out/ file, or `tokenbrake show`. This is the gate for turning a narrowing on: a narrowing whose net is
  negative is spending tokens, not saving them. Token-reads only; --cost is where dollars live.
```

- **byKind reads `gitview`:** yes — `Withholds: 1 (1 gitview)`.
- **Backfire count:** **0** — "none of the 1 withholds was read back -- backfire
  rate 0%". Net ~10,920 token-reads saved, 0 pulled back.

## `~/.claude/tokenbrake.json`

```
{"gitView": true}
```
