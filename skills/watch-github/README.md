# Watch GitHub

`/watch-github` fires after a push or a PR open, and whenever a session waits on a PR's reviews, merge, or CI, or on a branch tip's CI. One daemon per Claude Code session polls GitHub for the pull requests and branch tips that session watches. The events arrive as messages, one per poll, and as lines in a log a non-Claude agent reads with `wait`.

A PR merge reaches this skill through the `/pr-landing-discipline` skill, which owns the merge moment. The mainline's CI after a merge is the branch target's business: watch `owner/repo:main` once per session.

The `/session-events` skill is required: the daemon is its, this skill is its GitHub source, and the script resolves it as the sibling folder (exit 2 with the install line when it is absent). Install both.

## Install

From the collection, both skills:

```bash
npx skills add Vivswan/skills -g --skill session-events --skill watch-github
```

Directly from the folders, the base first:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/session-events -g
npx skills add https://github.com/Vivswan/skills/tree/main/skills/watch-github -g
```

## What It Does

- **One daemon per session**, the `/session-events` skill's, started once as a background task; it is the session's own child, so its messages render as plain text, and it exits when the session does. The harness also ends a background task after two hours; the saved state survives, so the session starts it again.
- **Two target forms**: a pull request, `owner/repo#n`, until it merges or closes; a branch tip, `owner/repo:branch`, through every push. Each carries the gate workflows named on it.
- **Nine event kinds** as messages: comment, review, CI verdict, head moved, label, conflict, merged, closed, and tooling trouble. Every text is structure, label names, and URLs; nothing a comment or a build log said is quoted.
- **A file sink** for Codex, the Copilot CLI, or a shell: a daemon named with `--id <name>` and a blocking `wait --id <name> --since <id>`.
- **One request per repository per poll, GraphQL only, 60 s busy and 300 s idle**: the rate buckets behind those rules are in the skill's Polling Budget.

## Layout

- [`SKILL.md`](./SKILL.md): the subscribe-and-act workflow, the targets, the event texts and CI rules, the polling budget, the command contract, and the gotchas
- [`scripts/github-events.mts`](./scripts/github-events.mts): the CLI entry, run with bun: `daemon`, `watch`, `unwatch`, `wait`, `poll`, `status`, `stop`. It composes the source and hands it to the `/session-events` library. Exit 0 ok; 2 usage or the `/session-events` skill not installed beside this one; 3 no daemon for this session, naming the command that starts one; `wait` exits 4 on timeout.
- [`scripts/targets/pr.mts`](./scripts/targets/pr.mts) and [`scripts/targets/branch.mts`](./scripts/targets/branch.mts): the two target forms, their cursors, and their event texts; [`scripts/targets/ci.mts`](./scripts/targets/ci.mts): the CI judgment both share, the verdict rules and the verdict as an event line.
- [`scripts/github/repository.mts`](./scripts/github/repository.mts), [`scripts/github/pr-activity.mts`](./scripts/github/pr-activity.mts), [`scripts/github/check-suites.mts`](./scripts/github/check-suites.mts), [`scripts/github/gh.mts`](./scripts/github/gh.mts): the reads: the per-repository query, one PR's comments and reviews, the paged check suites and failed jobs, and the `gh` wrapper.

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
