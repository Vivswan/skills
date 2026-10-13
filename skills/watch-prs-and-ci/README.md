# Watch PRs and CI

`/watch-prs-and-ci` fires after a push or a PR open, and whenever a session waits on a PR's reviews, merge, or CI. One daemon per Claude Code session, started by the session as a background task, polls GitHub for the PRs that session watches. The events arrive in the session as messages, one per poll, and as lines in a write-ahead log a non-Claude agent reads with `wait`.

A PR merge reaches this skill through the `/pr-landing-discipline` skill, which owns the merge moment. A subscribed PR's merge event names the merge commit, and the daemon follows that commit's mainline CI, so the SHA judged after a merge is the PR's merge commit, never the topic branch's HEAD.

The daemon is the `/session-events` skill's; this skill is its PR source and resolves it as the sibling folder. Install both.

## Install

From the collection, both skills:

```bash
npx skills add Vivswan/skills -g --skill session-events --skill watch-prs-and-ci
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/watch-prs-and-ci -g
```

## What It Does

- **One daemon per session**, the `/session-events` skill's, started once as a background task; it is the session's own child, so its messages render as plain text, and it exits when the session does. The harness also ends a background task after two hours; the saved state survives, so the session starts it again.
- **One `watch` per PR**, with the head it pushed and the complete gate set; a repeated call replaces the gates.
- **Seven event kinds** as messages: comment, review, CI verdict with a log excerpt for up to three failed runs (the rest are counted), head moved to a SHA the session did not record, merged, closed, and tooling trouble. A poll's events arrive in one message.
- **The merge commit's mainline CI** follows a merge event automatically. `watch-commit` covers a direct mainline push with no PR.
- **A file sink** for Codex, the Copilot CLI, or a shell: a daemon named with `--id <name>` and a blocking `wait --id <name> --since <id>`.
- **One poller per session, 60 s floor, GraphQL only**: the rate buckets behind those rules are in the skill's Polling Budget.
- **A checks URL** as the fallback when the `gh` CLI is unavailable.

## Layout

- [`SKILL.md`](./SKILL.md): the subscribe-and-act workflow, the daemon lifecycle, the command contract, and the gotchas
- `<skill-dir>/scripts/pr-events.mts`: the CLI entry, run with bun: `daemon`, `watch`, `watch-commit`, `unwatch`, `wait`, `poll`, `status`, `stop`. It runs the `/session-events` daemon on this skill's source. Exit 0 ok; 2 usage, gh missing, or the `/session-events` skill not installed beside this one; 3 no daemon for this session, naming the command that starts one; `wait` exits 4 on timeout.
- `<skill-dir>/scripts/pr-source.mts` and `pr-state.mts`: the source: what a target is, the GraphQL reads, the CI judgment, and the event texts.
- The other `scripts/` modules are the reads: the `gh` wrapper, check-suite discovery and judging, and the PR batch and detail reads.

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
