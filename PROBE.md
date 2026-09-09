# Probe: does this Claude Code honor updatedToolOutput on PostToolUseFailure?

Run by a session on this branch. The project hooks here register the guard for PostToolUseFailure. A session
that runs an oversized failing command and finds `[tokenbrake]` in what it sees is on a Claude Code that
honors the replacement; one that sees the raw output (with Claude Code's own "… characters truncated …") is
not. The debug log on 2.1.261 says: "Hook JSON output had unrecognized keys (ignored):
hookSpecificOutput.updatedToolOutput." The result of the probe is written below by the session.
