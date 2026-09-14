# RESULT — git-view A/B clean re-run v2 (narrowing 4)

## Headline

**The neutralize step (step 0) was NOT performed, so the run did NOT come out
clean.** The delivered `git diff` was the **generic middle-trim**, NOT the
gitview collapse. Per the protocol's own instruction ("If it still shows the
generic trim, the neutralize did not work — say so explicitly and stop after
step 6"), this run is reported as a non-clean result and stopped after step 6.

## Why step 0 did not happen (honest account)

Step 0 asked me to write `~/.claude/tokenbrake.json` (`{"gitView": true,
"maxChars": 999999}`) to neutralize the stale **global** guard registered at
user scope (`/root/.claude/hooks/tokenbrake/guard.js`, PostToolUse matcher
`*`, confirmed present in `~/.claude/settings.json`).

Writing into `~/.claude/` was denied by the auto-mode permission classifier as
**[Self-Modification]**. That guardrail exists precisely to stop changing the
runtime behavior of registered Claude Code hooks — and step 0's stated purpose
is to change a registered global hook's behavior (make its `maxChars` gate pass
the diff through). Routing around the denial with a different tool (Write, a
Node script) would bypass the intent behind the denial, so I did not do that.
`~/.claude/tokenbrake.json` therefore does not exist, and the global guard ran
with its default `maxChars`, trimmed the diff, and its generic middle-trim was
the delivered output.

## Delivered git diff: COLLAPSE or generic trim?

**Generic middle-trim.** The note in the delivered output, quoted verbatim:

```
[tokenbrake] 543 lines omitted here (15,124 chars total). Full output saved to /root/.claude/tokenbrake/out/0e2e4c1a-B6oagry7Z6.txt — Read or Grep it if you need more.
```

This is the generic "lines omitted here" middle-trim, **not** the narrowing-4
note `[tokenbrake] +N/-N lines, diff collapsed (generated/lockfile path)`. The
save path `/root/.claude/tokenbrake/out/...` is the **global** guard's output
directory, confirming the global guard produced the delivered output.

## Was src/app.js kept verbatim?

**Yes.** Only the middle of the large `package-lock.json` hunk was trimmed. The
head and tail of the lockfile hunk and the entire `src/app.js` diff were
delivered verbatim:

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

## (a) What changed in src/app.js

The reduce callback changed from `a+b` to `a+b+0`, i.e.
`items.reduce((a,b)=>a+b,0)` became `items.reduce((a,b)=>a+b+0,0)`
(a functionally no-op `+0`).

**How I got it / backfire?** Directly from the delivered (trimmed) `git diff`
output. `src/app.js` was outside the trimmed region, so it was visible in the
delivered text. **Not a backfire** — no re-read of a saved `out/` file and no
`tokenbrake show`.

## (b) New version of the "lodash" dependency

**4.17.21** (was 4.17.20).

**How I got it / backfire?** Directly from the delivered (trimmed) `git diff`
output. The middle-trim kept the tail of the lockfile hunk, and `lodash` sits
after `pkg-119` at the very end of `packages`, so its `+ "version":
"4.17.21"` line was in the delivered text:

```
    "lodash": {
-      "version": "4.17.20",
+      "version": "4.17.21",
       "resolved": "https://reg/lodash"
     }
```

**Not a backfire** — obtained from the delivered diff, without reading the
saved `out/` file or running `tokenbrake show`. (Note: both answers survived
only because the generic middle-trim happens to keep head+tail; had lodash
been mid-hunk it would have required a backfire.)

## FULL `node cli.js report --backfire` output (verbatim)

```
Backfire audit -- 1 session(s)
  Withholds: 1 (1 trim) -- ~ 3,253 tokens kept out, ~ 6,506 token-reads not carried
  Pulled back: none of the 1 withholds was read back -- backfire rate 0%
  Net: ~ 6,506 token-reads saved after backfires   (6,506 saved - 0 pulled back)
  Verdict: too few withholds to call it (need a few)

  A withhold backfires when the model retrieves what was withheld -- the two ways the guard creates it: reading the
  saved out/ file, or `tokenbrake show`. This is the gate for turning a narrowing on: a narrowing whose net is
  negative is spending tokens, not saving them. Token-reads only; --cost is where dollars live.
```

## byKind and backfire count

**byKind reads `trim` (1 trim), NOT `gitview`.** This is the un-clean outcome:
the global guard's generic trim, not the project guard's gitview collapse, is
what the report recorded. **Backfire count = 0** (backfire rate 0%; none of the
1 withhold was read back).

## `~/.claude/tokenbrake.json` contents

Does not exist — step 0 was not performed:

```
cat: /root/.claude/tokenbrake.json: No such file or directory
```

## Verdict

Non-clean run. The generic middle-trim (`trim`) was delivered and recorded, not
the gitview collapse (`gitview`), because the global guard was never
neutralized. (a) and (b) were both answered from the delivered diff with 0
backfires, but that says nothing about the narrowing-4 feature — the feature's
collapse never fired in the delivered output. To get a clean `gitview` result,
step 0's neutralize would have to be done in a way that does not trip the
self-modification guardrail (e.g. an environment set up before the session so
no in-session write to `~/.claude/` is needed).
