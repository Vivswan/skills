# Watch PRs and CI

`/watch-prs-and-ci` fires after a push or a PR open, and whenever a session waits on a PR's reviews, merge, or CI. One daemon per user per machine polls GitHub for every subscribed PR. The events arrive in the subscribing Claude Code session as cross-session messages, and as lines in a write-ahead log any other agent reads with `wait`.

A PR merge reaches this skill through the `/pr-landing-discipline` skill, which owns the merge moment. A subscribed PR's merge event names the merge commit, and the daemon follows that commit's mainline CI, so the SHA judged after a merge is the PR's merge commit, never the topic branch's HEAD.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill watch-prs-and-ci
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/watch-prs-and-ci -g
```

## What It Does

- **One `watch` per PR**, with the session's permission mode, the head it pushed, and the gate workflows. The daemon starts itself on the first call and exits once no subscriber is left.
- **Seven event kinds** as messages: comment, review, CI verdict with the failed-job log tail, head moved to a SHA no subscriber recorded, merged, closed, and tooling trouble.
- **The merge commit's mainline CI** follows a merge event automatically. `watch-commit` covers a direct mainline push with no PR.
- **A file sink** for Codex, the Copilot CLI, or a shell: `--sink file --id <name>` and a blocking `wait --id <name> --since <id>`.
- **One poller per user, 60 s floor, GraphQL only**: the rate buckets behind those rules are in the skill's Polling Budget.
- **A checks URL** as the fallback when the `gh` CLI is unavailable.

## Layout

- [`SKILL.md`](./SKILL.md): the subscribe-and-act workflow, the daemon lifecycle, the command contract, and the gotchas
- `<skill-dir>/scripts/pr-events.mts`: the CLI entry, run with bun: `watch`, `watch-commit`, `unwatch`, `wait`, `poll`, `status`, `stop`, `daemon`. Exit 0 ok; 2 usage, gh missing, or the daemon unreachable; `wait` exits 3 on timeout.
- The other `scripts/` modules are the daemon's parts: the `gh` wrapper, check-suite discovery and judging, the PR batch and detail reads, the inbox delivery, and the state and log files.

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
