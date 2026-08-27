---
name: pr-and-issue-discipline
description: Use when opening a pull request, changing its body, title, or draft state, triaging review comments, writing an issue, or deciding who merges.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# PR and Issue Discipline

> Show the change before telling it: real captured output first, the fewest words after, drafts that flip ready on convergence and back on commit-requiring work, and a human hand on the merge by default.

These rules apply to any session that opens or updates a PR or writes an issue. "The author" below is whoever prepared the change, human or agent, working alone or in a multi-agent session.

## When to Apply

- Opening or updating a pull request (body, title, draft state)
- Writing a bug report or issue
- A review round just landed on an open PR
- Deciding whether a PR merges, and by whose hand

## PR Bodies: Visualization First

The opening section is real captured output, not prose. A reader must get the change from the fenced blocks without reading a paragraph.

````markdown
## The bug this kills          (or "## What this adds" for a feature)

Before:
```text
$ bun run check
scripts/sweep.mts: probe timed out after 120s; agent marked dead (it was mid-build)
```

After:
```text
$ bun run check
scripts/sweep.mts: probe extended 120s -> 300s while the build lock is held; agent alive
```

## How

```text
before: probe start -> fixed 120s -> timeout -> agent marked dead (mid-build)
after:  probe start -> 120s up -> build lock held? -> extend to 300s -> live verdict
```

## Proof

- 34 tests green (2 new), `bun run check` green, CI watched to completion
- 2 review rounds, every thread resolved
````

- The opening blocks are actual commands and actual output, complete enough to stand alone.
- `## How` has no mandated form. Pick whatever carries THIS change fastest: sometimes three terse bullets, sometimes a diagram, a table, or two sentences. The test is reading speed, not format. Never a visual plus prose re-explaining it - if the diagram needs a paragraph after it, the diagram failed; pick one carrier.
- The register is programmer to programmer: what changed, how the flow changed, in the reader's technical vocabulary. No executive-summary tone, no benefits-narration. The diff carries the detail; never re-narrate it.
- `## Proof` is numbers: tests, gates, review rounds. Cut any sentence the blocks already show.

**Redact before publishing.** Strip secrets, tokens, and credentials; genericize machine-specific absolute paths and usernames (a captured row published with `/repo/...` in place of the machine's real checkout path is the worked example). Redaction is not paraphrase: the command and the output structure stay verbatim.

## Issues: Same Principle

What breaks, shown first; then the minimum around it. Short and skimmable, no walls of text.

A repository's own issue templates are authoritative: fill their fields, applying this principle inside them. The shape below is the fallback when no template exists.

````markdown
## What breaks

```text
$ npx skills add Vivswan/skills --skill some-skill
installed: SKILL.md, README.md          (metadata.json silently missing)
```

## Repro

1. Add a `metadata.json` inside any skill folder.
2. Install with `npx skills add`.

## Expected vs actual

- Expected: every file in the skill folder installed
- Actual: `metadata.json` dropped without a warning
````

Include environment only when it matters: a version-specific parser bug names the version; a pure logic bug does not. The redaction rule above applies unchanged: issues publish captured output too.

## Draft Discipline

- Open every PR as a DRAFT, and keep it draft through its review loop.
- Flip READY the moment it converges: never batched, never held back.
- Flip BACK TO DRAFT the moment new commit-requiring work appears on a ready PR (a fresh valid review comment, a gate finding), before the fix round starts.
- Draft state tracks pending commits; CONVERGENCE gates the merge offer. A fresh comment needing only a reply does not bounce a ready PR back to draft (its reply-and-resolve lands the same cycle, no commit), but a PR is offered for merge only while the full converged definition below holds.

**Converged** means: CI fully green, every review thread resolved (fixed or answered), and the latest review round raised nothing new and valid. Fully green counts EVERY check on the PR, required or not, and on every PR in its dependency chain: a residue red from an un-retargeted base disqualifies ready even when the required gate passes.

## Babysit to Comment Convergence

An open PR is live work until it merges: bot reviewers (e.g. Copilot code review) and humans leave comments on every push. Per PR, loop until quiescent:

1. Every push gets a CI watcher (Companion Gates, below).
2. When a review lands, triage EVERY comment the same cycle it appears, never batched:
   - A valid finding is fixed in that same round.
   - An invalid or not-valid-here comment gets a reply stating why, and its thread resolved.
3. A fix push restarts the loop: new CI watch, re-gate on the changed content, and the bot may re-review.

**Toil budget.** When rounds keep yielding one finding at a time (around ten rounds in), stop fixing instances one at a time: enumerate the recurring finding classes, sweep each whole class across the change in one pass, then resume the loop. One 35-round convergence collapsed to a few batch sweeps once the finding classes were enumerated.

Read thread state via GraphQL, never from comment timestamps (a thread with no new comments can still be unresolved):

```text
reviewThreads(first: 100) { nodes { isResolved } pageInfo { hasNextPage endCursor } }
```

Paginate with `after: <endCursor>` while `hasNextPage` is true; a fixed first page is not the full set.

Bot reviews that do not fire automatically on drafts are requested explicitly (e.g. add Copilot as a reviewer on the draft; prefer balanced or high reasoning where the repo exposes the setting). Between rounds, never poll: where the `/watch-ci-after-push` skill is installed, sleep on its `wait-for-pr-event` script, a background waiter whose exit wakes the session and names what changed.

Production shape of one round:

- "empty manifest passes vacuously": valid. Fixed with a regression test in the same cycle.
- "script not wired into the docs": sequencing by design. Replied with the plan (a docs pass wires all scripts post-merge) and resolved.
- "symlink following": split. The leaf-fidelity half fixed after confirming it empirically; the escape half declined with the recorded design rationale.

## Who Merges

The human, by default. A PR exists to put a human gate before the mainline: the author prepares it (push, gates green, a "ready to merge" report) and the human merges. Where a merge queue owns the ordering, the author's prepared action is enqueueing the converged PR; enqueue is not merged, so watch until the commit actually lands. Two standing exceptions, each only when the user has granted it:

- **A trivial mechanical fix.** A change of a few lines that alters no behavior, flow, or procedure (a type narrowing, a typo, a rename with no semantic edge) merges directly once its gates are green; the human gate is reserved for changes worth human attention. When in doubt about "trivial", it is not trivial.
- **A pipeline blocked on a merge.** When a converged PR gates queued work and the human is not acting, merge it and say so in the next report. Waiting idle on a merge the author could perform is the defect; the notification preserves the human's oversight.

**The landing action is exit-conditioned, never chained**, for a PR merge and a direct push alike. Read the gate's own verdict and STOP; land in a separate command only after the gate itself reports green. Green means the gate's exit code AND its verdict, and a review gate is green only when its findings are triaged, not merely when its process exits 0.

```bash
tail gate.log; git merge && git push    # WRONG: the merge runs whatever the log said
tail gate.log && git merge && git push  # WRONG: && conditions on tail printing the log,
                                        # not on the gate's verdict; a red log still merges
```

## Companion Gates

- After every push, a background CI watcher; where installed, the `/watch-ci-after-push` skill defines it.
- Before anything lands, an independent review that can block the landing, scoped to the exact content being landed - the branch or PR diff (`base...HEAD`) once committed, the staged diff before that - not the working tree; where installed, the `/rubber-duck-review` skill defines that review and its convergence.
