# tokenbrake

Claude Code hooks that keep oversized tool output out of your context window.

Tool results are the bulk of what a Claude Code session spends — and shell output is the worst offender.
Claude Code's own ceiling for a valid Bash result is ~30,000 characters inline (roughly 7,500 tokens), and
that gets re-sent with every turn until you `/compact`. tokenbrake lowers that ceiling to something sane,
keeps the parts that matter, and tells you afterwards what ate your tokens.

## Install

```
npx tokenbrake init            # user scope: ~/.claude/settings.json, applies to every project
npx tokenbrake init --project  # this project only: .claude/settings.json (commit it to share with a team)
```

Restart Claude Code (or run `/hooks` to confirm two tokenbrake entries). Node 18+ is the only requirement — no
Python, no Rust binary, no Git Bash. Works on Windows with the PowerShell tool.

```
npx tokenbrake status          # what is installed, plus one real spawn of each hook, as Claude Code does it
```

The hooks are exec-form (no shell), so Claude Code starts the recorded executable directly. User-scope `init`
records the absolute path of the node it ran under; `--project` records plain `node` so the committed file works
on any machine, and `--node=<path>` overrides either. If `status` prints `FAILED to start`, that is the hook
Claude Code would also fail to start — silently, with every result going through untrimmed.

## What it does

**Shell output trim** (PostToolUse on `Bash` / `PowerShell`). Output over 6,000 chars is replaced by the first
40 lines, the last 40 lines, and up to 20 lines from the middle that look like errors or warnings, each with
its line number. The full output is saved to `~/.claude/tokenbrake/out/` and the trimmed result names the path,
so Claude can `Grep` or `Read` it if it needs more. Nothing is rewritten or "compressed" — what Claude sees is a
predictable head/tail excerpt of the real output.

**Large-read cap** (PreToolUse on `Read`). A `Read` with no `offset`/`limit` on a file over 60 KB is rewritten
to `limit: 300`, and Claude is told the file's real size and how to page through it or `Grep` it first. Reads that
already specify a range are untouched. Images, PDFs and notebooks are skipped.

**Ledger** (every tool result). Size of each result is appended to `~/.claude/tokenbrake/ledger.jsonl`. Nothing
leaves your machine.

## What ate your tokens

```
npx tokenbrake report                     # last session
npx tokenbrake report --all               # one line per session on disk
npx tokenbrake report --session=<prefix>  # a particular one; --transcript=<path> for a file
npx tokenbrake report --top=25            # widen the ranking
```

A tool result is not paid for once. It is re-sent as context on every later request until the session
compacts, so a 30k-token test dump at request 3 of 60 is read 57 times. `report` reads the Claude Code
session transcript (every tool result exactly as the model saw it, and the API's usage per request) and
ranks results by **size × the requests they were carried through** — which is the number that says which
single `cat`, `Read` or test run to have trimmed, capped or never run. It also shows what the session
processed in total, how much of that came from cache, what the context holds right now, and which of the
results tokenbrake trimmed and what that kept out. Sizes are chars/4 estimates; the usage line is what the
API reported. `--ledger` shows the guard's own record alone, which is also the fallback when no transcript
can be found.

## Configure

Optional `~/.claude/tokenbrake.json` (or under `CLAUDE_CONFIG_DIR`):

```json
{
  "maxChars": 6000,
  "headLines": 40,
  "tailLines": 40,
  "keepErrorLines": 20,
  "readMaxBytes": 60000,
  "readLimitLines": 300,
  "logAllTools": true,
  "enabled": true
}
```

`enabled: false` turns the guard off without uninstalling. `logAllTools: false` records only trimmed and capped events.

## Uninstall

```
npx tokenbrake uninstall [--project]
npx tokenbrake clean --days=7   # delete saved full outputs older than 7 days
```

## Notes and limits

- Rewriting a tool result needs `updatedToolOutput` support in PostToolUse, which Claude Code added for
  built-in tools in the v2.1.12x line. On older versions the hook runs but changes nothing. Claude Code checks
  the rewrite against the tool's own result shape (for Bash: the `{ stdout, stderr, … }` object) and drops a
  mismatch without telling anyone but the debug log; tokenbrake returns the object, and `status` checks it.
- Claude Code caps hook output strings at 10,000 characters; tokenbrake keeps its rewrite under that.
- Only successful tool calls pass through PostToolUse. A failing command already arrives as a ~10,000-char
  head/tail excerpt from Claude Code itself; tokenbrake doesn't touch it.
- The guard fails open: any error exits 0 with no output and Claude Code proceeds unchanged.
- One `node` process per tool call (~50–100 ms). Set the PostToolUse matcher to `Bash|PowerShell|Read` in
  settings.json if you want it lighter and don't need the full ledger.
- Reads capped by tokenbrake are partial views; `Edit` still requires an exact string match, so a capped read
  can't cause a wrong edit — Claude will read the section it needs first.
