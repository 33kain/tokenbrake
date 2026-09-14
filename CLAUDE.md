# CLAUDE.md

tokenbrake: two Claude Code hooks (`guard.js`), an installer and report CLI (`cli.js`), and the transcript reader behind
the report (`transcript.js`). Plain Node, no dependencies, no build step.

```bash
node test.mjs          # the whole suite; prints ok/FAIL per check, exits non-zero on any failure
node cli.js status     # what is installed on this machine, plus one real spawn of each hook
node cli.js report     # what ate the last session's tokens
```

Every Claude Code and Cowork session on this repository runs with brake 1 on: `.claude/settings.json` is the
project-scope install, and `.claude/hooks/tokenbrake/guard.js` is a copy of `guard.js`, not a source. After changing
`guard.js`, refresh the copy with `node cli.js init --project` and commit both; `test.mjs` fails if they differ.
Hooks load at session start, so a session that edits the guard keeps running the copy it started with.

Every change that touches `guard.js`, `cli.js`, or `transcript.js` runs the same loop before it merges: `/simplify`
(cut what the change doesn't need), then `/code-review` (bugs — the guard sees untrusted tool output and must fail
open), then `/security-review` (path and injection safety on that same untrusted input). Verify every finding against
the actual code before changing anything; ship anything that alters what enters context default-OFF and let `AB-TASK.md`
gate the default flip. Savings are measured and reasoned about in tokens (and cache), never money.

`HANDOFF.md` is the state of the work and the plan it belongs to; `AB-TASK.md` is the measurement protocol and every
number measured so far. Publishing is the `Publish` workflow (Actions → Run workflow), which refuses to republish a
version already on the registry. Keep the guard's `updatedToolOutput` in the tool's own response shape (an object for
Bash, with `stdout`), because Claude Code validates it against the tool's schema and rejects a bare string silently.
