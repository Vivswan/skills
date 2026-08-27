---
name: gate-exit-conditions-the-merge
description: "Use when landing a change after a gate (review, CI, tests) - never chain the merge or push in the same compound command as reading the gate's log; land in a separate command only after the gate's exit code and verdict are read"
metadata:
  type: feedback
---

A landing action (merge, push, publish) is a separate command issued only after the gate's own result - its exit code and its verdict - has been read and is green. Never `tail gate.log; git merge && git push` in one compound: the merge runs regardless of what the tail printed. `tail gate.log && git merge` is equally wrong: the `&&` conditions on tail succeeding at printing, not on what the gate said. There is no compliant single-command form: `test "$(cat gate_exit)" = 0 && git merge` still lands on the exit code alone, with the verdict unread.

**Why:** The failure mode is a gate racing its reader: a compound command tails the gate log and carries the landing action in the same line, so when the gate has exited nonzero, the tail prints the failure and the chained push still goes out - a red-gated commit lands and downstream CI has to arbitrate what the gate already caught. The exit code was available; it just was never wired to the action.

**How to apply:** Two commands minimum: (1) read the gate's exit code and its verdict, then stop; (2) merge or push in a fresh command only after both are green. Green for a review gate means its findings are triaged, not merely that its process exited 0 - convergence per [[rubber-duck-before-every-commit]].
