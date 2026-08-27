---
name: rubber-duck-before-every-commit
description: "Use before every commit or merge, however trivial - a cross-model rubber-duck review must run and converge on the exact final content first; exceptions and reviewer coverage never transfer between gates"
metadata:
  type: feedback
---

Every commit and every merge, no matter how small, is preceded by a cross-model rubber-duck review (the /rubber-duck-review workflow) that converges on the exact final content being landed: the staged diff at commit time, the branch or PR diff at merge time. The same rule carries two non-transfer corollaries:

- An exception granted for one gate never transfers to a neighboring gate. A waiver for one commit says nothing about the next commit or the merge that follows it.
- Coverage never transfers between reviewers. One reviewer having seen the final state does not satisfy another reviewer's requirement; each required reviewer sees the final content itself.

**Why:** The failure mode is scope creep on a one-time allowance: a review skipped for a "trivial" follow-up commit ships exactly the defect the review existed to catch, and a pass recorded against one gate gets silently reused to wave a neighboring gate through. Trivial-looking diffs are where unreviewed breakage hides, because nothing else is looking at them.

**How to apply:** Run the review before the commit, scoped to the staged diff; after any fix round, re-run it on the new final content - a review of a superseded state counts for nothing. At merge time, the review scopes to the full branch diff. A waiver is never self-granted: only the gate's owner can grant one, it is recorded, and it is consumed by that single gate. See [[fire-relevant-skills-and-memories]] for the checkpoint that makes this rule fire, and [[gate-exit-conditions-the-merge]] for how the landing command itself is issued.
