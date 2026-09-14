# Blob-Binary Elider A/B — ON arm result (narrowing 3)

Config: `~/.claude/tokenbrake.json` = `{"blobElide": true}` (elider ON).

## (a) Per-cat elision outcome

- **`cat /tmp/blobwork/bundle.min.js`** — **ELIDED**. Note quoted:
  `[tokenbrake] withheld ~19 KB of blob-like output (longest line 19,601 chars — looks minified or encoded, not prose). Full output saved to /root/.claude/tokenbrake/out/16d5e9c8-U55kkHis8u.txt — Read it if you need the raw bytes.`

- **`cat /tmp/blobwork/photo.b64`** — **not elided** by tokenbrake. No `[tokenbrake]` withheld note appeared. Instead the harness tried to render the file as an image and returned an error:
  `<error>Unable to resize image — image processing is unavailable and dimensions could not be read from the file header. Please convert the image to PNG, JPEG, GIF, or WebP.</error>`
  The raw bytes never entered context (the harness intercepted the output before the guard's note would show), and the backfire report counts only 2 withholds, so this cat was not one of them.

- **`cat /tmp/blobwork/config.json`** — **ELIDED**. Note quoted:
  `[tokenbrake] withheld ~6 KB of blob-like output (longest line 6,035 chars — looks minified or encoded, not prose). Full output saved to /root/.claude/tokenbrake/out/16d5e9c8-KboPw5wbH9.txt — Read it if you need the raw bytes.`

## (b) How targetValue was obtained — NOT a backfire

`targetValue` = **`ZZZ-9137`**.

The `config.json` cat was elided and the shown head contained only the `pad` field (a run of `x`); `targetValue` was not visible in it. I obtained the value with a targeted `jq -r '.targetValue' /tmp/blobwork/config.json` against the **original /tmp file**, which returns only the small field.

This is **NOT a backfire**: I did not read the saved `out/` file, and I did not run `tokenbrake show`. The whole blob was never pulled back into context — only the 8-byte value was.

## (c) Full verbatim output of `node cli.js report --backfire`

```
Backfire audit -- 1 session(s)
  Withholds: 2 (2 blob) -- ~ 6,215 tokens kept out, ~ 28,251 token-reads not carried
  Pulled back: none of the 2 withholds was read back -- backfire rate 0%
  Net: ~ 28,251 token-reads saved after backfires   (28,251 saved - 0 pulled back)
  Verdict: too few withholds to call it (need a few)

  A withhold backfires when the model retrieves what was withheld -- the two ways the guard creates it: reading the
  saved out/ file, or `tokenbrake show`. This is the gate for turning a narrowing on: a narrowing whose net is
  negative is spending tokens, not saving them. Token-reads only; --cost is where dollars live.
```

## (d) Contents of ~/.claude/tokenbrake.json

```
{"blobElide": true}
```
