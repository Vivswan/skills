---
name: review-before-commit
description: Use when about to commit or asked to commit changes, so an independent review runs and converges before anything lands.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Review Before Commit

**No commit until an independent review** of the working-tree state has run and converged. Review-then-commit, never commit-then-review.

A flaw must be able to block the landing. That matters most where commits go straight to the main branch.

## When to Apply

- About to run `git commit` on a non-trivial change
- "commit this" / "land this change" / "ship it"

## Workflow

### 1. Get the tree green first

Run the project's gates (typecheck, lint, tests) before launching any review. Reviewing a red tree wastes the reviewer on problems the gates already catch.

### 2. Launch independent background reviews

- **Use `/rubber-duck-review`** when installed. It defines reviewer selection, read-only sandboxing, background launch with streaming, and verdict extraction.
- **Independent reviewers**: prefer a different model than yourself. Two independent reviewers beat one when available.
- **Defense in depth.** Independent gates are not redundancy: each catches a failure class the others are blind to. The project gates catch mechanical breakage; a semantic review catches drift the gates cannot type-check; where a landing workflow adds them, a review of the final integrated state catches rebase-time divergence and a docs-against-code pass catches doc-truth gaps. One gate passing never excuses another; skipping a gate requires naming which remaining gate covers its failure class, and "the other one passed" is not an answer.
- **Read-only, always.** Reviewers must run NON-WRITING (a read-only sandbox or plan mode). A writable reviewer has been seen:
  - writing a probe test file into the reviewed tree (it ran in the suite and inflated the pass count)
  - mutating source in place to check tests can fail, then restoring imperfectly

  If a review ran writable anyway, diff every modified file before committing.
- **Background, and keep working.** Start reviews together; never sleep or poll waiting for them. React to the completion notification, or run a reviewer synchronously when nothing can proceed without its verdict. (In orchestrator sessions the stricter rule wins: the lead never runs a reviewer inline, only in the background.)
- **No explicit verdict or findings section means a FAILED run**, not a clean review. Zero bytes, a truncated stream, or narration with no conclusion all count. Relaunch it. If the same reviewer CLI returns empty output repeatedly, switch mechanism (e.g. a read-only review subagent) instead of re-running it a fifth time.

### 3. Triage every finding

- **Fix** valid findings, non-blocking included.
- **Reject** incorrect or inapplicable findings with the reason.
- **Skip** a valid finding only for a recorded reason (conflicts with the design, out of scope, explicit user decision).
- **Never drop incidental discoveries silently** (failing tooling, drifted docs, an unrelated bug found along the way): fix them when in scope, otherwise report them explicitly in the final summary.

### 4. Converge, then commit

Re-run the gates after fixes, then re-review the updated state.

- **Reviewer-prompted fixes are still unreviewed code.** Code that changed only to apply them still needs review: the reviewers' last round must have seen the final state of the tree.
- **Keep rounds unprimed** when thoroughness matters (no earlier-findings lists fed forward). An unprimed round has surfaced blockers a primed one missed.
- **The gate opens** when no valid blocking findings remain and every non-blocking finding is fixed, rejected, or recorded as skipped.

Only then commit.

### 5. After the push

If the commit is pushed, the CI-watching rule takes over: see the `/watch-ci-after-push` skill.

## Exceptions

- The user explicitly waives review ("just commit it"): follow the instruction and note that review was waived.
- Trivial mechanical changes (a typo, a version bump the checks fully validate) may go with a single reviewer or, when the user agrees, none. When in doubt, review.

## Fallback Without a Second Model

When no independent reviewer is available, do a read-only self-review with fresh eyes:

1. Read `git diff HEAD` hunk by hunk against the review criteria of the installed skills (e.g. `/code-standards`, `/no-invalid-states`).
2. Triage and converge the same way.
3. Say in the report that the review was not cross-model.

## Worked Example

1. A refactor is ready and `bun run check` is green.
2. Launch a codex read-only review in the background (per `/rubber-duck-review`); keep cleaning up docs while it runs.
3. It returns one blocking finding (a dropped error path) and two non-blocking naming suggestions.
4. Fix all three, re-run the checks, relaunch the review on the updated tree.
5. It reports clean. Commit now, and only now.
