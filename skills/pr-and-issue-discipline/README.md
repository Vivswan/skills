# PR and Issue Discipline

`/pr-and-issue-discipline` fires when an agent opens or updates a pull request, writes an issue, or decides who merges. It holds every PR and issue to the same shape:

- **Visualization first**: the body leads with real captured before/after output that stands alone, then `## How` in whatever form carries the change fastest (no mandated form, one carrier, programmer to programmer), then `## Proof` numbers; secrets stripped and machine paths genericized before publishing
- **Issues too**: what breaks (shown), a minimal repro, expected vs actual, environment only when it matters
- **Draft discipline**: open as draft, flip ready the moment the PR converges, flip back to draft the moment new commit-requiring work appears
- **Comment convergence**: every review round triaged the same cycle (valid findings fixed, invalid ones replied to and resolved), with thread state read via GraphQL `isResolved`, never inferred from timestamps
- **Who merges**: the human by default; a trivial mechanical fix and a pipeline blocked on a merge are the only standing exceptions, and every landing is exit-conditioned on the gate's own verdict, never chained onto a command that displayed a log

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill pr-and-issue-discipline
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/pr-and-issue-discipline -g
```

## What It Does

- Formats PR bodies and issues visualization-first, with redaction before publishing
- Flips drafts ready on convergence and back on commit-requiring work, and offers only converged PRs for merge
- Loops each open PR to comment convergence: CI green, every thread resolved, the latest round quiet
- Defaults the merge to the human hand, with two narrow standing exceptions and an exit-conditioned landing
- Hands the CI watch to [`/watch-ci-after-push`](../watch-ci-after-push/) and the pre-landing review to [`/rubber-duck-review`](../rubber-duck-review/), where installed
- Pairs with [`/orchestrator-mode`](../orchestrator-mode/), which runs this loop on every PR in a fleet and adds the fleet-specific routing on top

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app integrations can be added later without moving the skill.
