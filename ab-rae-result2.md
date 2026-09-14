# Read-After-Edit Delta — A/B re-run (size-gated), ON arm

Feature under test: `readAfterEdit` (ON), now gated on `st.size <= readMaxBytes`
(`readMaxBytes` default = 60000). After an Edit, an unbounded Read of the same
file is narrowed to the edited region — but only for files at or under the size
cap. Files over the cap fall through to the ordinary Read cap instead.

Scratch set (`/tmp/abwork2`, throwaway; no tracked repo files touched):
`small1..small4.js` = 3892 B each (under `readMaxBytes`), `big.js` = 97814 B on
disk / ~96 KB as measured by the guard (over `readMaxBytes`).

## `node cli.js report --backfire`

```
Backfire audit -- 1 session(s)
  No withholds in these session(s) -- nothing to audit (the guard trimmed nothing that carried its marker here).
  Read caps fired: 2
  Read-After-Edit deltas: 4 fired; 0 sent the model back for a wider read of the file (a delta that hid what it wanted)

  A withhold is a trim, MCP trim or dedup the model saw. Turn a narrowing on and run a session, then this says whether it paid off.
```

## Per-read outcome

| Read (whole-file, file_path only) | Outcome |
| --- | --- |
| small1.js | NARROWED — delta to lines 77–123 of 200 |
| small2.js | NARROWED — delta to lines 77–123 of 200 |
| small3.js | NARROWED — delta to lines 77–123 of 200 |
| small4.js | NARROWED — delta to lines 77–123 of 200 |
| big.js | CAPPED — size cap held at first 300 lines (1,512 lines / 96 KB); NOT narrowed |

## Did the four small-file verify-reads backfire?

No. All four RAE deltas fired and 0 sent the model back for a wider read: each
narrowed window (lines 77–123) contained the edited line (`const line_100 =
12345;`), so the verify was satisfied without re-reading the rest of the file.

## Was big.js correctly left to the cap (not narrowed)?

Yes. big.js is over `readMaxBytes`, so despite being edited this session the RAE
delta did not fire; the Read cap governed and capped the read at the first 300
lines. The size gate behaved as intended.
