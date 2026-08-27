---
name: fire-relevant-skills-and-memories
description: "Use before any consequential action - commit, merge, push, delete, report, spawn - stop and enumerate which skills and memories trigger at that moment, then apply them"
metadata:
  type: feedback
---

Before any consequential action - a commit, a merge, a push, a delete, a report, a spawn - explicitly check which skills and memories trigger at that moment and apply the ones that do. Consequential means the action lands content, destroys state, delegates work, or delivers a conclusion someone will act on; a routine intermediate reply is not a checkpoint. An applicable-but-unfired rule is a process defect in itself, even when the action happens to turn out fine: a rule that fires only when remembered is not a rule.

**Why:** Standing rules do not announce themselves at the moment they apply; only the action is in view. Gate incidents trace back not to missing rules but to existing rules that were never consulted at the decisive moment: the review skipped at a commit ([[rubber-duck-before-every-commit]]), the merge chained past its gate ([[gate-exit-conditions-the-merge]]), the sleep loop on a subagent ([[no-sleep-waiting-on-subagents]]).

**How to apply:** Treat each consequential action as a checkpoint: name the action, list the skills and memories whose triggers match it, and run them before acting. When spawning, the check includes propagating into the brief the rules the worker will need at its own checkpoints. Report an applicable rule that went unfired as a defect, not as a footnote.
