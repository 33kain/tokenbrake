# Read-After-Edit Delta — A/B run (ON arm)

## (i) `node cli.js report --backfire` — full output

```
Backfire audit -- 1 session(s)
  No withholds in these session(s) -- nothing to audit (the guard trimmed nothing that carried its marker here).
  Read caps fired: 2
  Read-After-Edit deltas: 5 fired; 2 sent the model back for a wider read of the file (a delta that hid what it wanted)

  A withhold is a trim, MCP trim or dedup the model saw. Turn a narrowing on and run a session, then this says whether it paid off.
```

## (ii) Config (`tokenbrake.json`)

```
{"readAfterEdit": true}
```

## (iii) Verify-reads narrowed

5 of my 5 verify-reads were narrowed (every one showed the tokenbrake "narrowed this read to the region you edited" note).

## (iv) Did the delta help or backfire on these verify-reads?

Mixed, matching the report's 5 fired / 2 backfired: on the small file (guard.js, 3 reads) the delta helped — it handed back only the edited region, which contained the change, so the verify was cheap and complete; on the two large files (cli.js and transcript.js) it backfired — the size cap co-fired and delivered the first 300 lines instead of the narrowed window, so the edit (at line 1273 / line 545) was not visible in the result the delta claimed to have narrowed to.
