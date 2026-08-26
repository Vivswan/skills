# Rubber Duck Review

`/rubber-duck-review` is a portable review skill for getting a second opinion from another model without giving that reviewer write access.

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
- Ships `scripts/run-review.mts`, which spawns the reviewer safely (no shell, stdin closed or fed from the prompt file, stream captured to a tmp file) and prints the extracted verdict
- Keeps the reviewer read-only
- Focuses findings on correctness, future-proofing, and design quality
- Encourages re-review after fixes

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
