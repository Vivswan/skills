# Watch CI After Push

`/watch-ci-after-push` makes every push and every PR merge end with a **background CI watcher** that reports pass/fail with failing-job logs. Never fire-and-forget a push. Never watch CI inline. After a merge, the watched SHA is the mainline tip, not the topic branch's HEAD.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill watch-ci-after-push
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/watch-ci-after-push -g
```

## What It Does

- Finds the workflow runs a push triggered (polling until they register)
- Watches them in the background (subagent or background shell) while work continues
- Reports one line on success, and failing job names plus the relevant log excerpt on failure
- Falls back to the commit's checks URL when the `gh` CLI is unavailable

## Layout

- [`SKILL.md`](./SKILL.md): the watch workflow
- [`scripts/watch-ci.sh`](./scripts/watch-ci.sh): discovery + watch + report in one command (exit 0 green, 1 failures, 2 no runs, gh failure, or a missing expected workflow, which defaults to "CI" and is overridden with `--expect-workflow <name>`)

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
