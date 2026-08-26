# Orchestrator Mode

`/orchestrator-mode` runs a session as a lead that fans implementation out to parallel subagents in isolated git worktrees while keeping architecture, reviews, and integration gated: direct pushes onto a mainline or PRs, with each track's base set by the dependency graph (independent or stacked), and serial merges either way.

This skill is explicit-invocation-only: agents load it when you invoke it (e.g. `/orchestrator-mode` in Claude Code), not on their own.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill orchestrator-mode
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/orchestrator-mode -g
```

## What It Does

- Decomposes work by dependency graph and parallelizes the independent tracks; dependent tracks may build concurrently against a predecessor branch or a named interface stub
- Gives every subagent an explicit file whitelist so branches merge cleanly
- Delegates review loops to builders and gates each landing with an integration review
- Gates every landing: direct pushes onto a mainline or PRs with per-track bases (independent or stacked), with reviews and CI watchers either way
- Keeps a fleet monitor watching for stalled or dead agents
- Sweeps finished agents, tasks, and worktrees so only live work stays visible

## Layout

- [`SKILL.md`](./SKILL.md): the session playbook, in lifecycle order
- [`references/spawn-briefs.md`](./references/spawn-briefs.md): what every spawn brief must contain
- [`references/fleet-monitor.md`](./references/fleet-monitor.md): the monitor's script wiring and liveness judgment
- [`references/landing.md`](./references/landing.md): the two landing gates (direct commits; PRs with per-track independent or stacked bases)
- [`references/worktree-hygiene.md`](./references/worktree-hygiene.md): handovers, removals, and file ownership
- [`scripts/`](./scripts): the fleet instruments, `sweep.mts`, `probe.mts`, `ledger.mts`, and `baseline.mts` (run with bun; node 24+ also works)

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
