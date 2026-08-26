# Retire the Class

`/retire-the-class` stops the cycle of patching the same failure class one member at a time. When a fix is the second patch on the same kind of failure, or a trap list keeps growing, the skill finds the architecture, data-structure, or substrate change that makes the whole class unrepresentable - and prefers it even when it is a big refactor.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill retire-the-class
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/retire-the-class -g
```

## What It Does

- Names the failure class in one sentence; if it cannot be named, it is not a class yet
- Finds the substrate the class lives on: an untyped output channel, a text-token check, state kept in prose, a hand-retyped ritual
- Picks the class-retiring form: tested scripts over documented traps, evidence-bearing results over counts, persisted ledgers over evaporating state, pinned snapshots over substring tokens
- Builds the class-retiring change as the deliverable; when urgency ships a pointwise fix first, the class-retiring change is boarded immediately (never parked as a note) and the work is reported incomplete until the class is retired
- Pairs with [`/rubber-duck-review`](../rubber-duck-review/): when both skills are installed, the review skill folds these criteria into its second-opinion passes
- Hands the type-level mechanisms (sum types, newtypes, typestate) to [`/no-invalid-states`](../no-invalid-states/) and covers the rest of the space

## The Test

If a new member of the failure class appears tomorrow, does the fix hold, or does it silently pass the same way? A silent pass means the class is still alive.

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
