# Probe: does this Claude Code honor updatedToolOutput on PostToolUseFailure?

Run by a session on this branch. The project hooks here register the guard for PostToolUseFailure. A session
that runs an oversized failing command and finds `[tokenbrake]` in what it sees is on a Claude Code that
honors the replacement; one that sees the raw output (with Claude Code's own "… characters truncated …") is
not. The debug log on 2.1.261 says: "Hook JSON output had unrecognized keys (ignored):
hookSpecificOutput.updatedToolOutput." The result of the probe is written below by the session.

## Result

**Claude Code version:** `claude --version` → `2.1.266 (Claude Code)`; env `CLAUDE_CODE_VERSION=2.1.42`
(also `CLAUDE_CODE_ENVIRONMENT_RUNNER_VERSION=release-ba76006550-ext`). The installed CLI reports 2.1.266;
the env var disagrees with the binary.

### Step 2 — what the session saw for the failing command

(a) Contains `[tokenbrake]`? **No.** The string does not appear anywhere in the tool result.

(b) Contains `characters truncated`? **Yes** — Claude Code's own middle-elision marker:
`... [2535 characters truncated] ...`

(c) First two lines, verbatim (the result arrived wrapped in an `<error>` element):

```
Exit code 1
probe line 1 filler text filler text filler text filler text
```

Last two lines, verbatim:

```
probe line 200 filler text filler text filler text filler text
FAIL: seeded failure at the end
```

(d) Roughly how many lines: ~162. The body ran from `probe line 1` through `probe line 81` (cut mid-line),
then the `[2535 characters truncated]` marker, then resumed mid-`probe line 122` and continued unbroken
through `probe line 200` and the `FAIL:` line. So ~40 lines were elided from the middle by Claude Code, and
the head and tail of the raw output were delivered as-is.

### Step 3 — last ledger line with `"failed":true`

```
{"t":1788961723497,"ev":"post","session":"a90a2c30-b91e-5840-8d08-b4cb6890ace8","tool":"Bash","chars":10039,"what":"node -e \"for(let i=1;i<=200;i++)console.log('probe line '+i+' filler text filler text filler text filler text'); console…","id":"toolu_01HGQ5yaZsRFSACXF9Rfkv2e","transcript":"/root/.claude/projects/-home-user-tokenbrake/a90a2c30-b91e-5840-8d08-b4cb6890ace8.jsonl","failed":true,"kept":5078,"saved":"/root/.claude/tokenbrake/out/a90a2c30-CXF9Rfkv2e.txt"}
```

### Reading

The hook **ran** on the failure — it saw the tool, recorded `failed:true`, wrote the full 10039 chars to its
`out/` file, and offered a 5078-char replacement. But the session received neither that replacement nor the
`[tokenbrake]` banner: what came back was the raw 10039 chars with ~2535 of them elided by Claude Code's own
truncator (~7504 chars delivered, well above the 5078 the guard kept). So on this build
`updatedToolOutput` is still ignored for `PostToolUseFailure` — the guard observes the failure but cannot
shrink it.
