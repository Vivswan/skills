---
name: orchestrator-mode
description: Use when asked to act as orchestrator, orchestrate with worktrees, run a fleet of parallel subagents on multi-track work, or build and manage many PRs in parallel.
license: SEE LICENSE IN LICENSE.md
disable-model-invocation: true
metadata:
  author: Vivswan
---

# Orchestrator Mode

Run the session as a lead that delegates implementation to parallel subagents in isolated git worktrees. The lead keeps architecture, integration, and landings under its own control.

The sections below are the session lifecycle in order: interview, set up, keep parallel, review, babysit, land, sweep. A cold lead can run a session top to bottom from them. Mechanism lives in `scripts/` and `references/`; this file carries the judgment and points there.

This skill is explicit-invocation-only: it loads when the user invokes it (`/orchestrator-mode` in Claude Code, `$orchestrator-mode` in Codex), not on its own.

## When to Apply

- "Act as orchestrator" / "orchestrate this with worktrees"
- "Run this as a fleet" / "fan this out to subagents"
- Building or managing several PRs in parallel, one worktree per PR
- A plan with several independent tracks that should build in parallel

## Roles

The lead owns architecture, overall consistency, integration, and long-term direction: specs, merges, gates. Everything else is delegated to focused subagents.

- **Review before integrating.** The lead personally reviews the maintainability-critical pieces: through its own review pass, read before landing, never by taking over a builder's work.
- **Stay responsive.** The lead never runs a long foreground task itself (a build, a test suite, a review, a watch). The user may want to talk to the orchestrator at any moment, and a lead blocked inline cannot answer. Anything long-running goes to a subagent or a background command; the lead's own inline steps stay short.

## 1. Interview Before Fanning Out

Before creating the board or spawning anything, ask the user these in ONE message. Skip any the invocation already answered. Propose a default for each so a one-word reply suffices. Confirm what the repo itself answers (branch protection implies the landing mode; CI config implies the gates) instead of asking open-ended.

1. **Landing mode**: the GATE, chosen once. Direct commits to the mainline (which branch?), or a PR before it?
   - With PRs, also settle WHO MERGES. The default (the user) and the two standing exceptions are defined in the `/pr-and-issue-discipline` skill; the lead merges only on the user's explicit delegation, when a merge queue owns the ordering, or under those exceptions.
   - A user delegating merges wholesale should be offered direct commits instead: lead-merged PRs are direct commits with extra steps, worth keeping only where branch protection or a merge queue forces the PR mechanism.
   - Each track's BASE is not asked; it follows the dependency graph (the mainline for independent tracks, the dependency's branch for tracks building on unlanded content; see `references/landing.md`).
   - Infer the likely gate from branch protection, CONTRIBUTING docs, and recent history. When unsure, propose PRs (the safer guess on a protected repo).
2. **Isolation**: a worktree per builder (default), or everyone in the main checkout? A shared tree forces the unique-ownership rules in the `/worktree-hygiene` skill and caps parallelism to disjoint file sets.
3. **Boundaries**: anything out of scope or do-not-touch (directories, files, configs) beyond what the plan implies?
4. **Landing cadence**: land each track as it converges without further asks (the default), or pause for approval before each landing or merge? Either way the gates are unconditional: review-before-landing and the CI watcher run on every landing regardless of cadence.

## 2. Decompose, Board, Monitor, Builders

1. **Map the dependency graph first** and decompose to the smallest independent units. Only truly independent tracks run in parallel, each in its own worktree by default (`isolation: "worktree"` in Claude Code, or plain `git worktree add`); a shared checkout caps parallelism to disjoint file sets under the `/worktree-hygiene` skill's ownership rules.
   - One exception: a dependent track MAY build concurrently by basing on its dependency's branch (or the mainline plus an interface stub the brief names), accepting the restack and re-gate when the dependency moves. Mechanics in `references/landing.md`.
   - Give each agent an explicit file whitelist and do-not-touch boundary so branches merge without conflicts. When parts share files, they stay with one agent.
2. **Create the task board** (task list) from the decomposed tracks.
3. **Spawn the fleet monitor first**: one subagent whose only job is watching the others and messaging the lead when any agent stalls or dies.
   - Its spawn brief names the script paths it runs, so it never hand-rolls a probe: `scripts/sweep.mts` (this skill's directory) for the periodic sweep, `scripts/probe.mts` for content claims, `scripts/ledger.mts` for standing states and flags, and `scripts/baseline.mts` at landings.
   - Liveness probing is full of false-conclusion traps. The scripts retire the mechanical ones by construction; `references/fleet-monitor.md` carries the wiring plus the judgment layer. Follow it exactly.
   - Lead directives the monitor must honor across sweeps go into that ledger (states, grants, standing flags with their retractions), never only into a message. The delivery rule lives in `references/fleet-monitor.md`, Reporting Discipline.
4. **In the PR gate, read `references/landing.md` BEFORE fanning out.** Dependency-based (stacked) tracks initialize their chain before builders spawn: each dependent branch is created off its dependency's branch, with the dependency tip it branched from recorded, per landing.md's stacked subsection. Every brief must name who pushes and opens each draft PR.
5. **Fan out builders** for the independent tracks, in the isolation the interview chose.
   - Every spawn brief is self-contained per `references/spawn-briefs.md`: the full task contract inline, the territory whitelist, the gates, the signal format, the stop-and-wait ban, and the TODO ban. Where the `/code-standards` skill is installed, briefs point builders at it for the comment rules and the rest of the house standards.
   - One-shot watchers and gate reviewers spawn UNNAMED where the harness delivers a completed agent's output automatically: a named watcher must remember to report at exactly the seam where agents strand (details in `references/spawn-briefs.md`).
6. **Rely on harness notifications** for subagent completion; the lead never sleeps or polls while waiting on a subagent (the `/no-sleep-waiting-on-subagents` skill states the rule, and spawn briefs propagate it to workers). The fleet monitor's periodic sweeps are different: they probe for stalls, not completion.

## 3. Keep the Fleet Parallel

- **Sweep the backlog** (reviewer non-blockings, test gaps, doc halves of blocked tasks) for disjoint work to run alongside the tracks. One busy agent while the lead idles is under-delegation. Idle capacity while unblocked work exists is a defect the user should never have to point out. Whenever the live-stream count drops, re-scan the board and backlog for startable work: queued tasks whose collisions are avoidable with territory notes, read-only passes (integration reviews, audits), prep for the next phase.
- **No "next cycle" parking.** "We'll pick this up next wave" is not a state. Identified work goes on the board immediately and starts as soon as capacity allows; work that cannot start yet carries its named blocking dependency on the board. What is banned is the deferred note and the mental backlog entry: work that exists nowhere but in prose.
- **Never drop incidental findings silently** (failing tooling, drifted docs, an unrelated bug, a defective skill or memory). Board them immediately, or report them to the user when out of session scope. Builders report out-of-territory findings in their completion signal instead of fixing them, so territories stay clean.
- **Prefer a fresh agent per task** over reusing one agent for a queue: long-lived multi-task workers accumulate context until they degrade or need handovers. Reuse is justified only when concurrently-open tasks genuinely share files, and even then each task signals and lands separately.
- **Split growing waves into per-surface builders.** When a wave's scope grows past roughly 8-10 items spanning disjoint surfaces, do not keep routing additions to the one running builder: ask it for a done/in-progress/not-started snapshot, let it keep the surfaces it is entangled with, and spawn sibling builders for whole untouched surfaces with region-level grants on shared files. The same applies at wave start: if the item list already spans surfaces, start one builder per surface.

## 4. Review Loops

- **Each worktree agent runs its own review loop** before reporting back. The lead's landing-gate review then gates the LANDING on the change's final integrated state (the rebased branch, or the up-to-date PR): an integration review, not a first look. Where the `/rubber-duck-review` skill is installed, use it for both loops: a cross-model, read-only reviewer.
- **Route review fixes back to the owning agent** to amend in place. The lead never takes over a builder's review loop. When a builder strands "waiting" on a reviewer, the fix is a nudge telling it to read its reviewer's completed output, or to spawn a fresh reviewer itself, never a lead-run replacement review.
- **When a gate catches the same failure class twice**, the next gate's prompt carries the generalization question explicitly ("if a new member of this class appears tomorrow, does the fix hold, or does it silently pass the same way?"), and a silent pass is a blocking finding. Production: two successive fixes to one roster hole (add the missing member, then constrain it) each read as complete and were merely pointwise; the question exposed both and forced the class-retiring form (a compile-time exhaustiveness check). A fix that looks finished and a fix that removes the class are different deliverables, and only the question distinguishes them.
- **The lead's own review passes always run in the background**, never blocking the lead inline. Background means non-inline, not non-gating: the lead reads the pass's output before landing, and findings can block the landing. Fold this skill's Orchestration Review Criteria section (below) into those passes' prompts, so reviewers check orchestration hygiene alongside correctness.

## 5. Babysit Every PR to Comment Convergence

Every open PR in the session runs the babysit loop from the `/pr-and-issue-discipline` skill: every review round triaged the same cycle, thread state read via GraphQL `isResolved`, and the draft flip in both directions (ready on convergence, back to draft on commit-requiring work). Fixes route per Review Loops (4). What the fleet adds on top:

- **A comment whose fix belongs to another track's territory** is replied-and-resolved with the routing named, and the receiving track's brief carries it.

## 6. Land

Implementation parallelizes; integration into a shared base does not. "The mainline" is whatever branch the session integrates changes into: often main, but the user may designate any branch, and every flow applies unchanged.

A landing is two independent choices:

- The GATE, chosen once in the interview: direct commits to the mainline, or a PR before it.
- Each track's BASE, set by the dependency graph: the mainline for independent work, a sibling's unlanded branch for stacked work. Any combination in one session.

The per-mode procedures, including the stacked-chain loop and the worktree rules around it, live in `references/landing.md`. What stays constant under either gate:

- **Who merges (the human by default), the two standing exceptions, visualization-first PR bodies with redaction, and the exit-conditioned landing** are defined in the `/pr-and-issue-discipline` skill. In the PR gate all of them apply; in direct mode there is no PR body or merging hand, so what carries over is the exit-conditioned landing.
- **Review before landing, never after**: findings must be able to block the landing. Where installed, the `/review-before-commit` skill defines this gate (green tree first, independent background reviews, triage, convergence).
- **After every push or merge** (a direct landing, a PR update, or a PR merge), spawn a background CI watcher that reports pass/fail with failing-job logs. Never fire-and-forget a push, and never watch CI inline. Where installed, the `/watch-ci-after-push` skill defines the watcher (run discovery, the full-SHA gotcha, the report format).
- **Every rebase gets the shared-file content check** ("the rebase is the risk, not the intent"): a clean replay can silently drop a prior landing's lines in files both tracks edit, with no conflict marker to warn anyone. The check is executable, not a prose token recipe: `scripts/baseline.mts pin`/`check` for whole-file ownership, `scripts/probe.mts tokens` for specific-line claims in shared files. Wiring in `references/fleet-monitor.md`, Verifying a Landing.

After each landing on the mainline, and again over the combined delta once all streams land, spawn a review pass looking specifically for integration issues between the merged pieces. Per-stream reviews are blind to cross-stream seams; this pass catches high-severity findings every per-stream round misses. Never skip it.

## 7. Sweep and Wrap Up

At phase boundaries (a wave finishing, a landing), stop subagents whose work is delivered and delete completed tasks, so the visible lists show only live work.

- Before stopping an agent, check nothing still owes output, and copy handoff facts a later step needs into a still-open task first.
- Long-lived service agents (CI watchers, the fleet monitor) stay up until their exit condition.
- Worktree handovers, removals, and fan-out file ownership have destructive failure modes; follow the `/worktree-hygiene` skill for those rules.

## Harness Variations

Invoking orchestrator mode is standing opt-in for multi-agent operation: spawning subagents and fleets needs no per-use ask.

Where the harness offers a workflow tool (e.g. Claude Code's Workflow tool), use it when the shape fits better than hand-fanned agents: audit or review sweeps over many fixtures, adversarial verification, migration-style fan-outs, judge panels. Builders that own a worktree and a review loop stay ordinary agents.

Give workflow agents small scopes and small output schemas: shard by directory-sized scope, cap list and string sizes, say terse output is a hard requirement and zero findings is a valid answer. An agent stuck on retries with a huge token count means its deliverable is too big: kill it and re-shard, do not wait it out.

When the host agent cannot spawn subagents, keep the structure and drop the parallelism:

- Implementation happens INLINE, one track at a time in dependency order, in plain `git worktree add` isolation.
- Background read-only CLI invocations of another agent (`codex exec`, `claude -p`) are retained for the REVIEW passes only. Read-only means they cannot edit, so they never substitute for a builder.
- Every gate is kept: review before landing, serialized integration, CI watch after every push or merge, the post-landing integration review.

## Orchestration Review Criteria

- TODO, FIXME, XXX, or HACK markers anywhere in the diff: spawn briefs ban them. The work happens in the change or is escalated, never parked in a comment.
- Edits outside the owning builder's declared territory (file whitelist violations that slipped past the brief).
- Leftover orchestration artifacts: keepalive marker files, wip commits meant to be rebased away, worktree paths leaked into configs or scripts.
- Duplicated near-identical hunks across files, the signature of a fan-out that assigned overlapping ownership.

Triage findings against sections 2 (Decompose, Board, Monitor, Builders) and 7 (Sweep and Wrap Up) above and the `/worktree-hygiene` skill. (The heading is deliberately not `## Review Criteria`: these checks are folded into the lead's own passes here, not auto-discovered into every `/rubber-duck-review` run.)

## References

- `references/spawn-briefs.md`: the spawn-brief checklist (the stop-and-wait ban, the TODO ban, unnamed one-shot watchers, git-fixture hygiene for test suites)
- `references/fleet-monitor.md`: the monitor's script wiring (sweep, probe, ledger, baseline) and the judgment rules learned from production false alarms
- `references/landing.md`: the two landing gates (direct commits; PRs with per-track bases, including the stacked-chain flow and the worktree rules around it)
