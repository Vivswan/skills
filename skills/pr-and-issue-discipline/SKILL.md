---
name: pr-and-issue-discipline
description: Use when opening a pull request, changing its body, title, or draft state, triaging review comments, writing an issue, or deciding who merges.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# PR and Issue Discipline

> Show the change, do not describe it: a fenced block is the text form of a picture, so the reader skims it and gets the change; the fewest words after, in the shape that fits the change; keep draft state honest, converge reviews, and leave the merge to a human by default.

These rules apply to any session that opens or updates a PR or writes an issue. "The author" below is whoever prepared the change, human or agent, working alone or in a multi-agent session.

## When to Apply

- Opening or updating a pull request (body, title, draft state)
- Writing a bug report or issue
- A review round just landed on an open PR
- Deciding whether a PR merges, and by whose hand

## PR Bodies: Show the Change, Shaped to It

Show the change rather than describe it. A PR body is text, so its picture is a fenced block: real captured output wherever behavior is observable, a diagram, table, or the contract's own shape where nothing runs. The reader skims the blocks and gets the change without reading a paragraph; prose only carries what no block can. Shape the body to the change; never force every PR through one template.

The target repository's own PR template is authoritative: fill its fields, applying this principle inside them. On a third party's or someone else's repository this is not optional; use their template and follow their `CONTRIBUTING` guidance rather than the shapes below. The shapes below are the fallback when neither a template nor `CONTRIBUTING` guidance covers the body.

### Additive feature

````markdown
## What this adds

```text
$ bun run shards --changed
manifest build/image-sets.json v3: 5 contexts, files and dependencies validated against the checkout
changed: api -> dependency closure {base, api} -> shards: [base, base+api]
```

## How

The resolver validates the manifest against the checkout, closes changed contexts over their dependencies, and emits the GitHub Actions matrix.

## Proof

- Manifest validation and shard-resolution tests pass (2 new), `bun run check` green.
````

### Existing behavior change or bug fix

Open with `Before` / `After` as real captured output; the comparison is the visualization. When nothing observable changes (a pure refactor), open with `## What this changes` and the same `## How` and `## Proof`.

````markdown
## Before

```text
$ bun run check
scripts/sweep.mts: probe timed out after 120s; agent marked dead (it was mid-build)
```

## After

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

- 34 tests green (2 new), `bun run check` green
````

### Contract or documentation PR

Use `## What this specifies` when the PR defines a contract rather than executable behavior. Nothing runs, so show the contract itself (its schema, table, or layout) in a block, not in prose.

````markdown
## What this specifies

```text
SKILL.md                    disable-model-invocation: true
agents/openai.yaml          policy.allow_implicit_invocation: false   <- must pair with the line above

agents/openai.yaml          .codex-plugin/plugin.json
interface.display_name      == interface.displayName
interface.short_description == interface.shortDescription   (25-64 chars)
interface.brand_color       == interface.brandColor
```

## How

The smoke test reads the three files per skill and fails the build on any drift.

## Proof

- Smoke-test cases for the mirrored block and the invocation pairing pass.
````

For every form:

- Blocks show, prose tells. Where behavior is observable, the opening block is an actual command and its actual output, complete enough to stand alone; never manufacture output or add it only to satisfy a format. Where nothing runs, the block is a diagram, a table, or the contract shape itself.
- `## How` has no mandated carrier. Use terse bullets, a small diagram, a table, or two short paragraphs, whichever explains the mechanism fastest. One carrier per point: a diagram followed by a paragraph re-explaining it means the diagram failed.
- `## Proof` names focused behavioral tests or stable checks, with numbers where they exist (tests, gates). Do not turn it into transient CI, approval, or review status.
- Write programmer to programmer: what changed, how the flow changed, in the reader's technical vocabulary. Usually 200 to 400 words is enough. The diff carries the detail; do not narrate the implementation process, reduction history, line counts, status, future work, scope caveats, reviewer guidance, or the entire diff.

**Redact captured output before publishing.** Strip secrets, tokens, and credentials; genericize machine-specific absolute paths and usernames (a captured row published with `/repo/...` in place of the machine's real checkout path is the worked example). Redaction is not paraphrase: the command and the output structure stay verbatim.

## Issues: Same Principle

What breaks, shown first; then the minimum around it. Short and skimmable, no walls of text.

The target repository's own issue templates are authoritative: fill their fields, applying this principle inside them. On a third party's or someone else's repository, use their template and follow their `CONTRIBUTING` guidance, not the shape below. The shape below is the fallback when neither a template nor `CONTRIBUTING` guidance covers the issue.

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

Include environment only when it matters: a version-specific parser bug names the version; a pure logic bug does not. When an issue includes captured output, the redaction rule above applies unchanged.

## Draft Discipline

- Open every PR as a DRAFT, and keep it draft through its review loop.
- Flip READY the moment it converges: never batched, never held back.
- Flip BACK TO DRAFT the moment new commit-requiring work appears on a ready PR (a fresh valid review comment, a gate finding), before the fix round starts.
- Draft state tracks pending commits; CONVERGENCE gates the merge offer. A fresh comment needing only a reply does not bounce a ready PR back to draft (its reply-and-resolve lands the same cycle, no commit), but a PR is offered for merge only while the full converged definition below holds.

**Converged** means the review has converged as the `/rubber-duck-review` skill defines it (step 7 owns the single definition), plus the PR-specific bar: CI fully green and every review thread resolved (fixed or answered). Fully green counts EVERY check on the PR, required or not, and on every PR in its dependency chain: a residue red from an un-retargeted base disqualifies ready even when the required gate passes.

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

Bot reviews that do not fire automatically on drafts are requested explicitly (e.g. add Copilot as a reviewer on the draft; prefer balanced or high reasoning where the repo exposes the setting). Requesting a Copilot review via the REST reviewers endpoint takes the reviewer login `Copilot`, exactly: `copilot-pull-request-reviewer[bot]` silently no-ops (a 201 response with empty `requested_reviewers`), and GraphQL `reviewRequests` hides a pending Copilot request either way, so the issue timeline is the only confirmation the request registered. Between rounds, never poll: where the `/watch-ci-after-push` skill is installed, sleep on its `wait-for-pr-event` script, a background waiter whose exit wakes the session and names what changed.

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

- After every push, a background CI watcher; where installed, the `/watch-ci-after-push` skill defines it. A MERGE is watched the same way, on the mainline tip's SHA (fetch the mainline from the remote the PR merged into and watch `FETCH_HEAD`): after `gh pr merge`, `git rev-parse HEAD` still names the topic tip, and the squash or merge commit exists only on the mainline.
- Before anything lands, an independent review that can block the landing, scoped to the exact content being landed, never the working tree: the branch or PR diff (`base...HEAD`) once committed, the staged diff before that. Where installed, the `/rubber-duck-review` skill defines that review and its convergence.
