# Review Before Commit

`/review-before-commit` is the commit gate: no commit until an independent background review of the working tree has run and converged. Review-then-commit, never commit-then-review.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill review-before-commit
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/review-before-commit -g
```

## What It Does

- Gets the tree green (typecheck, lint, tests) before spending a reviewer on it
- Launches independent background reviews (via [`/rubber-duck-review`](../rubber-duck-review/) when installed) and keeps working
- Triages every finding: fix, reject with reasons, or skip for a recorded reason
- Re-reviews until convergence, then commits and hands off to [`/watch-ci-after-push`](../watch-ci-after-push/) after the push
- Honors explicit user waivers and scales down for trivial mechanical changes

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
