---
name: orchestrator-mode
description: Use when asked to act as orchestrator, orchestrate with worktrees, run a fleet of parallel subagents on multi-track work, or build and manage many PRs in parallel.
license: SEE LICENSE IN LICENSE.md
disable-model-invocation: true
metadata:
  author: Vivswan
---

# Orchestrator Mode

Run the session as a lead that delegates implementation to parallel subagents in isolated git worktrees, while keeping architecture, integration, and landings under its own control.

This skill is explicit-invocation-only: it loads when the user invokes it (`/orchestrator-mode` in Claude Code, `$orchestrator-mode` in Codex), not on its own. The triggers below describe the sessions it is meant for.

## When to Apply

- "Act as orchestrator" / "orchestrate this with worktrees"
- "Run this as a fleet" / "fan this out to subagents"
- Building or managing several PRs in parallel, one worktree per PR
- A plan with several independent tracks that should build in parallel

## Roles

The lead owns architecture, overall consistency, integration, and long-term direction: specs, merges, gates. It personally reviews the maintainability-critical pieces before integrating. Everything else is delegated to focused subagents.

The lead also stays responsive: it never runs a long foreground task itself (a build, a test suite, a review, a watch) - the user may want to talk to the orchestrator at any moment, and a lead blocked inline cannot answer. Anything long-running is delegated to a subagent or run as a background command; the lead's own inline steps stay short.

## Session Setup

1. Create the task board (task list) from the decomposed plan.
2. Spawn the fleet monitor first (see `references/fleet-monitor.md`).
3. Fan out worktree workers for the independent tracks.
4. Rely on harness notifications for subagent completion; the lead never sleeps or polls while waiting on a subagent - the `/no-sleep-waiting-on-subagents` skill states the rule, and spawn briefs propagate it to workers. (The fleet monitor's periodic sweeps are different: they probe for stalls, not completion.)

## Decompose, Then Parallelize

- Map the dependency graph first. Only truly independent tracks run in parallel worktree subagents (`isolation: "worktree"` in Claude Code, or plain `git worktree add` elsewhere).
- Give each agent an explicit file whitelist and do-not-touch boundary so branches merge without conflicts. When parts share files, they stay with one agent.
- Decompose to the smallest independent units, then sweep the backlog (reviewer non-blockings, test gaps, doc halves of blocked tasks) for disjoint work to run alongside. One busy agent while the lead idles is under-delegation.
- Maximize parallelism continuously and unprompted: whenever the live-stream count drops, re-scan the board and backlog for startable work before holding. Startable work includes:
  - queued tasks whose collisions are avoidable with territory notes
  - read-only passes (integration reviews, audits) that run beside builders
  - prep work for the next phase

  Idle capacity while unblocked work exists is a defect the user should never have to point out.
- Prefer a fresh agent per task over reusing one agent for a queue: long-lived multi-task workers accumulate context until they degrade or need handovers. Reuse is justified only when concurrently-open tasks genuinely share files, and even then each task signals and lands separately.
- Split growing waves into per-surface builders. When a wave's scope grows past roughly 8-10 items spanning disjoint surfaces (per-page or per-file territories), do not keep routing additions to the one running builder: ask it for a done/in-progress/not-started snapshot, let it keep the surfaces it is entangled with, and spawn sibling worktree builders for whole untouched surfaces with region-level grants on shared files. The same applies at wave start: if the item list already spans surfaces, start one builder per surface.

## Spawn Briefs

Every spawn brief inlines the full task contract; subagents may lack the board tools. Briefs must also forbid stop-and-wait and ban TODO markers; where the `/code-standards` skill is installed, briefs point builders at it for the comment rules and the rest of the house standards. See `references/spawn-briefs.md` for the checklist.

## Review Loops

- Each worktree agent runs its own review loop before reporting back. The lead's landing-gate review then gates the LANDING on the change's final integrated state (the rebased branch, or the up-to-date PR): an integration review, not a first look. Where the `/rubber-duck-review` skill is installed, use it for both loops (`/rubber-duck-review`): a cross-model, read-only reviewer for the builders' passes and the lead's gates.
- Route review fixes back to the owning agent to amend in place.
- The lead never takes over a builder's review loop. When a builder strands "waiting" on a reviewer, the fix is a nudge telling it to read its reviewer's completed output (in harnesses like Claude Code, an idle notification fires only with zero live children, so the reviewer is done; verify your harness behaves the same before relying on it) or to spawn a fresh reviewer itself if the old one is unresumable. Never a lead-run replacement review.
- The lead's own review passes (landing gate, integration) always run in the background, never blocking the lead inline. Background means non-inline, not non-gating: the lead reads the pass's output before landing, and findings can block the landing. This is also how the lead "personally reviews" maintainability-critical pieces - through its own pass, read before integrating. Fold this skill's Review Criteria section (below) into the prompts of those passes, so reviewers check orchestration hygiene alongside correctness.

## Landing

Implementation parallelizes; integration into a shared base does not. "The mainline" is whatever branch the session integrates changes into - often main, but nothing here requires it: the user may designate any branch (a develop, release, or long-lived feature branch) as the target, and every flow below applies to it unchanged. Two landing modes cover most repos; pick whichever the repo uses (branch protection, CONTRIBUTING docs, and recent history say which - when unsure, a PR per track is the safer guess on a protected repo).

**Serial landings (direct-push repos).**

1. One pending change on the mainline at a time, in plan order.
2. Take the builder's branch (named in its completion signal) and prepare it per the repo's conventions: rebase onto the mainline, cherry-pick its commits, or export and apply its diff as a patch.
3. Re-run the gates on the result, run the review pass, then commit and push.
4. Keep the mainline tree frozen while a review round is in flight, and serialize resource-exclusive validation (fixed ports, shared stacks).

**A PR per track (PR repos).**

1. Each builder's branch becomes its own PR (title and description per the repo's conventions). The spawn brief says who does what: either the builder pushes its branch and opens the PR, reporting the URL in its signal, or the builder stays no-push and the lead pushes from the worktree and opens the PR. Creating and iterating many PRs in parallel is fine: the file whitelists that keep worktrees disjoint keep the PRs disjoint too.
2. What stays serial is merging into the shared base: merge one at a time in plan order (or hand the ordering to the repo's merge queue), and rebase or update each successor PR after the previous merge.
3. The landing-gate review runs on each PR's final state before merge; re-run it after any rebase that changes content.

Both modes:

- Review before landing, never after: findings must be able to block the landing. Where installed, the `/review-before-commit` skill defines this gate (green tree first, independent background reviews, triage, convergence).
- After every push or merge (a direct landing, a PR update, or a PR merge), spawn a background CI watcher that reports pass/fail with failing-job logs. Never fire-and-forget a push, and never watch CI inline. Where installed, the `/watch-ci-after-push` skill defines the watcher (run discovery, the full-SHA gotcha, the report format).

## Post-Landing Integration Review

After each landing on the mainline (a direct push or a merged PR), and again over the combined delta once all streams land, spawn a review pass looking specifically for integration issues between the merged pieces. Per-stream reviews are blind to cross-stream seams; this pass catches high-severity findings that every per-stream round misses. Never skip it.

## Fleet Monitor

Keep one subagent whose job is monitoring the others: it schedules periodic checks and messages the lead if any agent stalls or dies. Liveness probing is full of false-conclusion traps (argv matching, self-matching greps, stale status hashes, missing `timeout` on macOS); follow `references/fleet-monitor.md` exactly.

## Incidental Findings

Anything discovered along the way that is broken, stale, or wrong (failing tooling, drifted docs, an unrelated bug, a defective skill or memory) is never silently dropped. Either queue it on the board and fix it (incidental findings are prime disjoint work for idle capacity) or surface it to the user in the next report. Builders report out-of-territory findings in their completion signal instead of fixing them, so territories stay clean.

## Sweep Continuously

At phase boundaries (a wave finishing, a landing), stop subagents whose work is delivered and delete completed tasks, so the visible lists show only live work. Before stopping an agent, check nothing still owes output, and copy handoff facts a later step needs into a still-open task first. Long-lived service agents (CI watchers, the fleet monitor) stay up until their exit condition.

Worktree handovers, removals, and fan-out file ownership have destructive failure modes; follow `references/worktree-hygiene.md` for those rules.

## Workflows

Invoking orchestrator mode is standing opt-in for multi-agent operation: spawning subagents and fleets, and running deterministic multi-agent workflows, need no per-use ask. Where the harness offers a workflow tool (e.g. Claude Code's Workflow tool), use it when the shape fits better than hand-fanned agents (audit or review sweeps over many fixtures, adversarial verification of findings, migration-style fan-outs over a work list, judge panels). Builders that own a worktree and a review loop stay ordinary agents; workflows suit the read-only or per-item stages around them.

Give workflow agents small scopes and small output schemas: shard by directory-sized scope, not by concept-across-the-whole-repo; cap list sizes and string lengths in the schema; say that terse output is a hard requirement and zero findings is a valid answer. An agent stuck on retries with a huge token count means its deliverable is too big: kill it and re-shard, do not wait it out.

## Fallback Without a Subagent Harness

When the host agent cannot spawn subagents, keep the structure and drop the parallelism:

- Use plain `git worktree add` for isolation and work the tracks one at a time in dependency order.
- Replace worktree builders with background read-only CLI invocations of another agent where available (e.g. `codex exec` or `claude -p`), or do the work inline.
- Keep every gate: review before landing, serialized integration, CI watch after every push or merge, and the post-landing integration review.

## Review Criteria

- TODO, FIXME, XXX, or HACK markers anywhere in the diff: spawn briefs ban them - the work happens in the change or is escalated, never parked in a comment.
- Edits outside the owning builder's declared territory (file whitelist violations that slipped past the brief).
- Leftover orchestration artifacts: keepalive marker files, wip commits meant to be rebased away, worktree paths leaked into configs or scripts.
- Duplicated near-identical hunks across files, the signature of a fan-out that assigned overlapping ownership.

Triage findings against the Spawn Briefs and Sweep sections above and `references/worktree-hygiene.md`.

## References

- `references/spawn-briefs.md`: the spawn-brief checklist, including the stop-and-wait ban and the TODO ban
- `references/fleet-monitor.md`: monitor design and the liveness-probe rules learned from production false alarms
- `references/worktree-hygiene.md`: handovers, worktree removal safety, and per-file ownership across fan-out rounds
