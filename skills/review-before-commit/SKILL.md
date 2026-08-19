---
name: review-before-commit
description: Use when about to commit or asked to commit changes, so an independent review runs and converges before anything lands.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Review Before Commit

No commit until an independent review of the working-tree state has run and converged. Review-then-commit, never commit-then-review: a flaw must be able to block the landing, which matters most where commits go straight to the main branch.

## When to Apply

- About to run `git commit` on a non-trivial change
- "commit this" / "land this change" / "ship it"

## Workflow

### 1. Get the tree green first

Run the project's gates (typecheck, lint, tests) before launching any review. Reviewing a red tree wastes the reviewer on problems the gates already catch.

### 2. Launch independent background reviews

- Use the `/rubber-duck-review` skill when installed: it defines reviewer selection, read-only sandboxing, background launch with streaming, and verdict extraction.
- Prefer reviewers independent of yourself (a different model); two independent reviewers beat one when available.
- Reviewers must run NON-WRITING (a read-only sandbox or plan mode). A writable reviewer has been seen writing a probe test file into the reviewed tree (it ran in the suite and inflated the pass count) and mutating source in place to check tests can fail, then restoring imperfectly. If a review ran writable anyway, diff every modified file before committing.
- Start reviews together in the background and keep working; never sleep or poll waiting for them - react to the completion notification, or run a reviewer synchronously when nothing can proceed without its verdict. (In orchestrator sessions the stricter rule wins: the lead never runs a reviewer inline - background only.)
- An output with no explicit verdict or findings section - zero bytes, a truncated stream, narration with no conclusion - is a FAILED run, not a clean review. Relaunch it; and if the same reviewer CLI returns empty output repeatedly, switch mechanism (e.g. a read-only review subagent) instead of re-running it a fifth time.

### 3. Triage every finding

- Fix valid findings, non-blocking included.
- Reject incorrect or inapplicable findings with the reason.
- Skip a valid finding only for a recorded reason (conflicts with the design, out of scope, explicit user decision).

### 4. Converge, then commit

Re-run the gates after fixes and re-review the updated state. Code that changed only to apply reviewer-prompted fixes is still unreviewed code: the reviewers' last round must have seen the final state of the tree. When thoroughness matters, keep rounds unprimed (no earlier-findings lists fed forward); an unprimed round has surfaced blockers a primed one missed. The gate opens when no valid blocking findings remain and every non-blocking finding is fixed, rejected, or recorded as skipped. Only then commit.

### 5. After the push

If the commit is pushed, the CI-watching rule takes over: see the `/watch-ci-after-push` skill.

## Exceptions

- The user explicitly waives review ("just commit it"): follow the instruction and note that review was waived.
- Trivial mechanical changes (a typo, a version bump the checks fully validate) may go with a single reviewer or, when the user agrees, none. When in doubt, review.

## Fallback Without a Second Model

When no independent reviewer is available, do a read-only self-review with fresh eyes: read `git diff HEAD` hunk by hunk against the review criteria of the installed skills (e.g. `/code-standards`, `/no-invalid-states`), then triage and converge the same way. Say in the report that the review was not cross-model.

## Worked Example

A refactor is ready and `bun run check` is green. Launch a codex read-only review in the background (per `/rubber-duck-review`); keep cleaning up docs while it runs. It returns one blocking finding (a dropped error path) and two non-blocking naming suggestions. Fix all three, re-run the checks, relaunch the review on the updated tree; it reports clean. Commit now - and only now.
