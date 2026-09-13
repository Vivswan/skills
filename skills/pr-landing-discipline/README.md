# PR Landing Discipline

`/pr-landing-discipline` fires once a pull request exists: a review round lands, the PR converges or gets new work, someone must decide who merges, or a change is about to land by PR merge or direct push. It carries the change from opened to landed under one discipline:

- **Draft discipline**: open as draft, flip ready the moment the PR converges, flip back to draft the moment new commit-requiring work appears; Converged means the review converged, CI fully green on every check in the chain, every thread resolved
- **Babysit to comment convergence**: every review round triaged the same cycle it appears, valid findings fixed in that round, invalid ones replied to and resolved, thread state read via GraphQL `isResolved`, recurring finding classes swept in one pass instead of one instance per round
- **Who merges**: the human by default, two narrow standing exceptions, the owner's `merge-when-green` label (a hand-over of the merge, not a verdict on the content, so every gate still runs) verified with three checks before acting on it, and an exit-conditioned landing that never chains the merge behind reading a gate log
- **Line accounting before landing**: additions and deletions summed per kind (source, scripts, tests, docs, workflows, generated) and read against the stated purpose; a count that goes against the purpose asks why, and a good change still lands with the reason in the human part of the body
- **Companion gates**: a CI watcher after every push or merge ([`/watch-ci-after-push`](../watch-ci-after-push/)) and an independent review that can block the landing ([`/rubber-duck-review`](../rubber-duck-review/)), where installed
- **Pairs with** [`/pr-and-issue-discipline`](../pr-and-issue-discipline/), which writes the PR body or issue before this skill takes over, and with [`/orchestrator-mode`](../orchestrator-mode/), which runs this loop on every PR in a fleet

## Installation

```bash
npx skills add Vivswan/skills -g --skill pr-landing-discipline
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/pr-landing-discipline -g
```

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app integrations can be added later without moving the skill.

## License

SEE LICENSE IN LICENSE.md
