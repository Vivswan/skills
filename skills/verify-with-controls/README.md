# Verify With Controls

`/verify-with-controls` fires at the moments a measurement is about to become a claim: a zero or absent reading, an alarming finding, a success claim, or stillness read from a probe or status check. The reading must survive its controls first:

| # | Rule | The failure it kills |
| --- | --- | --- |
| 1 | Evidence or error, never a bare zero | one 0 for both "absent" and "I failed to look" |
| 2 | Positive control before trusting a zero | a blind instrument answering the wrong question truthfully |
| 3 | Suspect the instrument first | a plausible number measuring the wrong thing |
| 4 | The postcondition is the truth | success logs over a state that never changed |
| 5 | Two observations to look, re-measure to send | a report racing the state it describes |
| 6 | Negative control for checkers | a gate that cannot go red |

Each rule is distilled from a false conclusion nearly shipped in production: a pathspec typo that a diff accepted silently, a checker aimed at the wrong repository, a column parse split by check names, a tool that printed "Push failed" and exited 0, a flag withheld because a re-measure 37 seconds later found the state changed, and a landing checker whose green meant nothing until it was first seen failing against a ref without the files.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill verify-with-controls
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/verify-with-controls -g
```

## What It Does

- Rejects any probe whose zero means both "absent" and "I failed to look"; a sound reading carries its matched lines or errors
- Requires a positive control (one reading that must be non-zero, same instrument) before any zero is trusted
- Re-derives alarming readings a second way before they reach a report
- Treats exit codes and output verdicts as approximations and checks the postcondition itself
- Holds flags to two observations, then re-measures immediately before sending
- Negative-controls every checker: a gate that has never been seen red proves nothing when green
- Pairs with [`/rubber-duck-review`](../rubber-duck-review/): its Review Criteria join every second-opinion pass, flagging uncontrolled probes and gates that cannot fail

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app integrations can be added later without moving the skill.
