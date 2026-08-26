# Never Twice

`/never-twice` fires when you just corrected an agent or fixed the same failure class twice. Instead of the next instance fix, it climbs to the most durable response reachable:

| Rung | Response | What the class can still do |
| --- | --- | --- |
| 1 | better architecture or data structures | cannot recur |
| 2 | a lint rule or test in CI | recurs, but cannot land |
| 3 | a skill or written rule | recurs, but the next agent knows |
| 4 | human vigilance | anything - a last resort, not a plan |

The test for whatever ships: if a new member of the failure class appears tomorrow, is it impossible to build (rung 1), stopped in CI (rung 2), caught by a loaded rule (rung 3), or silent - no rung held? A runtime guard that fails loudly but late, after shipping, is an instance fix, not a rung.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill never-twice
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/never-twice -g
```

## What It Does

- Names the failure class in one sentence; if it cannot be named, it is not a class yet
- Finds the substrate that admits new members: convention-synced artifacts, strings where closed sets belong, state kept in prose, hand-typed rituals
- Climbs as close to rung 1 as the task allows and ships it; a lower-rung fallback ships only with the more durable rung's gap named and tracked
- Pairs with [`/rubber-duck-review`](../rubber-duck-review/): its Review Criteria join every second-opinion pass, asking which rung a fix sits on and whether a more durable rung was reachable
- Hands type-level mechanics (closed unions, branded types, typestate) to [`/no-invalid-states`](../no-invalid-states/)

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app integrations can be added later without moving the skill.
