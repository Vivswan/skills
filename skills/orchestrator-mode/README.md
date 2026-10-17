# Orchestrator Mode

`/orchestrator-mode` runs a session as a lead that fans implementation out to parallel subagents in isolated git worktrees while keeping architecture, reviews, and integration gated. Changes land as direct pushes onto a mainline or as PRs, with each track's base set by the dependency graph (independent or stacked), and serial merges either way.

This skill is explicit-invocation-only: agents load it when you invoke it (e.g. `/orchestrator-mode` in Claude Code), not on their own.

The `/session-events` skill is required: the fleet monitor's default instrument is its daemon, this skill's `fleet-events` is a source of it, and the script resolves it as the sibling folder (exit 2 with the install line when it is absent). Install both.

## Install

From the collection, both skills:

```bash
npx skills add Vivswan/skills -g --skill session-events --skill orchestrator-mode
```

Directly from the folders, the base first:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/session-events -g
npx skills add https://github.com/Vivswan/skills/tree/main/skills/orchestrator-mode -g
```

Beyond the required `/session-events` skill, four companion skills carry rules this one points at, so an install should add all four too. The PR body format lives in [`/pr-and-issue-discipline`](../pr-and-issue-discipline/), and the landing mechanics (draft discipline, comment convergence, line accounting, who merges) in [`/pr-landing-discipline`](../pr-landing-discipline/).

The worktree rules (removal safety, handovers, shared trees) live in [`/worktree-hygiene`](../worktree-hygiene/), and the fleet monitor's general measurement rules (the six controls a reading survives before it becomes a claim) in [`/verify-with-controls`](../verify-with-controls/):

```bash
npx skills add Vivswan/skills -g --skill pr-and-issue-discipline
npx skills add Vivswan/skills -g --skill pr-landing-discipline
npx skills add Vivswan/skills -g --skill worktree-hygiene
npx skills add Vivswan/skills -g --skill verify-with-controls
```

## What It Does

- **Decomposes work by dependency graph** and parallelizes the independent tracks. Dependent tracks may build concurrently against a predecessor branch or a named interface stub.
- **Gives every subagent an explicit file whitelist** so branches merge cleanly
- **Delegates review loops to builders** and gates each landing with an integration review
- **Gates every landing**: direct pushes onto a mainline or PRs with per-track bases (independent or stacked), with reviews and CI watchers either way
- **Keeps a fleet monitor**, one role with two instruments. The `fleet-events` daemon, where the harness gives it a session to read, messages only what needs the lead's judgment (a stuck call, a stall, a stranded job, an idle worktree, a wipe) and notes the rest in its log. A sweep-driven monitor subagent is the fallback on any harness, and judgment stays the lead's
- **Sweeps finished agents, tasks, and worktrees** so only live work stays visible, under the [`/worktree-hygiene`](../worktree-hygiene/) rules for removals, handovers, and shared trees

## Layout

- [`SKILL.md`](./SKILL.md): the session playbook, in lifecycle order
- [`references/spawn-briefs.md`](./references/spawn-briefs.md): what every spawn brief must contain
- [`references/fleet-monitor.md`](./references/fleet-monitor.md): the monitor role's two instruments (the daemon's events and what it cannot see, the monitor subagent's brief), and the judgment and instruments that stay the lead's
- [`references/landing.md`](./references/landing.md): the two landing gates (direct commits, and PRs with per-track independent or stacked bases)
- [`scripts/fleet-events.mts`](./scripts/fleet-events.mts): the fleet monitor's daemon instrument, this skill's source for the `/session-events` daemon, run with bun: `daemon`, `watch`, `unwatch`, `wait`, `poll`, `status`, `stop`. Its target is a session's subagents, with `--repo <root>` for the worktrees.
- [`scripts/fleet/`](./scripts/fleet): the fleet readings: `git.mts` for the worktrees and `processes.mts` for the processes in them, shared by the daemon and `sweep.mts`; `transcript-tail.mts`, the sweep's `--transcripts` sensor; `transcripts.mts`, the daemon's reducer of what each agent waits on.
- [`scripts/`](./scripts): the lead's instruments, `sweep.mts` (the one-shot worktree reading), `probe.mts`, `ledger.mts`, and `baseline.mts`. Run with bun; the first three also run on Node 24.3+, but `baseline.mts` bundles its one dependency, `diff`, into the skill's `.build` folder on first run and needs bun.

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
