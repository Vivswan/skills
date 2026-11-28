# Rubber Duck Review

`/rubber-duck-review` is a portable review skill for getting a second opinion from another model, with the reviewer kept read-only wherever the host can enforce it.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill rubber-duck-review
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/rubber-duck-review -g
```

## What It Does

- Launches a review-only pass with another model, tool, or CLI
- Ships `scripts/run-review.mts`, which spawns the reviewer safely (no shell, copilot's stdin closed, stream captured to a tmp dir kept for 24 hours) and prints the extracted verdict
- Keeps the reviewer read-only: codex and claude run as ACP sessions (the `codex-acp` and `claude-agent-acp` adapters), codex in read-only mode, which lets a read, a search, or a command its sandbox can run go and refuses the rest, claude in plan mode, which refuses whatever asks. A refusal lands in the trajectory, and the review fails naming it when the reviewer ends its turn on it.
- Lets the reviewer reach the internet: every codex launch asks for its live web search (a managed install may cap it), claude's plan mode has its web tools, and `--network` opens codex's shell by the snapshot copy
- Tells the reviewer to look up whatever it is unsure of, to verify every platform claim against current documentation with the page cited, and to report the unverifiable ones as `unverified`, never as findings and never as settled
- Where codex's bubblewrap sandbox cannot start, it reviews a git snapshot of the repository (step 4 of [`SKILL.md`](./SKILL.md) says what the snapshot holds), removed when the review ends, and the report says so
- Focuses findings on demonstrable defects and design quality. Speculative hardening is recorded, not built, unless the user asks or, in a repository with outside users or a hostile-input surface (a published package, a public service), confirms it after being shown the risk
- Encourages re-review after fixes

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
