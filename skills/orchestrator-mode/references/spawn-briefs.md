# Spawn Briefs

Every subagent spawn brief is self-contained: the agent may lack the task board, the plan, and the session history, so the brief carries everything.

## Checklist

Every brief includes:

1. **The full task contract inline.** Goal, acceptance criteria, and the definition of done. Never say "see task #N"; subagents may lack the board tools.
2. **An explicit file whitelist and do-not-touch boundary.** The territory the agent owns, plus any shared files with region-level grants (e.g. one CSS file's disjoint regions). This is what lets sibling branches merge without conflicts.
3. **The gates to run** (typecheck, lint, tests) and the instruction to run its own review loop before signaling done.
4. **How to signal completion** (e.g. message the lead) and the handoff contract: commit finished work to the worktree's branch (never push unless the brief says so) and include the branch name, commit subjects, and any escalations in the signal. In PR-per-track mode the brief NAMES THE ACTOR explicitly, preserving both options. Either the builder pushes its branch, opens the PR, reports the URL in its signal, and spawns (or requests) the CI watcher for its own pushes; or the builder stays no-push and the lead pushes from the worktree, opens the PR, and starts the watcher. The final signal is the only permitted stop.
5. **The stop-and-wait ban** (below).
6. **The comment rules and the TODO ban** (below). Comments only for what code cannot show; where the `/code-standards` skill is installed, the brief points builders at it for the full house standards.
7. **The out-of-territory rule:** anything broken or wrong found outside the agent's file whitelist is reported in the completion signal, never fixed silently. A silent out-of-territory edit collides with another agent's territory, and a silently dropped finding is lost.
8. **The inbox-reconciliation rule** (below): the final signal enumerates every lead message received, with one line of evidence per directive.
9. **The idempotency rule** (below): every directive and every briefed step is safe to arrive twice, late, or after the fact; genuinely non-idempotent operations are named in the brief.
10. **For long-running service agents (the fleet monitor, long-horizon watchers): the standing-state channel.** The brief names the session ledger as where standing state arrives (re-read it every sweep) and requires every lead directive received as a message to be acknowledged in the agent's NEXT report. The delivery rule and its lead side live in `references/fleet-monitor.md`, Reporting Discipline.
11. **Scratch files go to /tmp, never the worktree.** A review prompt or helper script written into the worktree blocks the clean-tree landing criterion and is one `git add -A` away from riding into the commit.

## The Stop-and-Wait Ban

In harnesses like Claude Code, a subagent's idle notification fires only when it has zero live children, so "I'll be woken when they complete" is always said to an already-complete state. Builders that stop to "wait for my background children" strand until someone nudges them. If your harness has different notification semantics, verify them before relying on this; the ban on stopping to wait stands either way.

Every brief therefore states:

- Run gates, hooks, and reviews FOREGROUND.
- After fanning out sub-editors, the next action on wake is to read their output, never to wait again.
- No idle stop is permitted before the final signal.

When a stranded agent must be nudged anyway, the nudge states the mechanism ("this notification fires only with zero live children, so your child is done; read its output"). A bare "continue" lets it re-strand at the next seam.

One nuance from production: a notification can occasionally fire while an untracked grandchild (e.g. a git hook's process tree) is still alive. An agent acting on a "finished" child should verify the outcome it reads is settled, not trust the notification alone.

**The named-spawn trap (Claude Code):** an Agent-tool spawn WITH a `name` detaches and runs in the background even when the brief said `run_in_background: false`; only unnamed spawns honor the synchronous flag. This single fact produced five strands across three builders in one production session; each builder believed its reviewer was synchronous. Briefs that tell a builder to run reviews synchronously must therefore say: spawn the reviewer UNNAMED, or use a foreground CLI invocation (`codex exec` in a foreground Bash call) that cannot detach.

## Report-First for Watchers and Reviewers

A watcher or reviewer's entire value is its report. The single most common failure is a silent idle stop at the report seam, observed repeatedly even in agents whose brief ended with a report instruction.

- State the deliverable FIRST, not last: "your ENTIRE value is one SendMessage to the lead; a stop without it is total failure".
- Require that message in EVERY branch: success, failure, empty output, tooling error ("report tooling trouble as tooling trouble, never as a red pipeline").
- Briefs shaped this way reported unprompted; briefs with the instruction buried needed a nudge per run.

Better still, remove the seam: spawn one-shot watchers and gate reviewers UNNAMED where the harness delivers a completed agent's output to the spawner automatically (Claude Code does). A named watcher must remember to SendMessage at exactly the seam where agents strand; two report-seam strands in one production session were both named spawns whose harness would have delivered the same output for free. Reserve names for agents the lead must address mid-run.

## Test Fixtures That Touch Git

Two incident classes from one production session, each observed twice; every brief for a track whose tests create or run git repositories carries both rules:

- **Fixture repos live in `mkdtemp` under `os.tmpdir()`, never inside the worktree, and fixture commits never land on the track's branch.** A test that runs `git init`/`git commit` in (or resolves paths into) the working tree wrote fixture commits onto the real branch and wiped the worktree twice when the fixture's cleanup ran against the enclosing repo.
- **Hermetic git env is owner-side: the repo's test launcher (`bun run test` -> `scripts/run-tests.ts`) builds it BEFORE the test process starts - GIT_* scrubbed, `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_CEILING_DIRECTORIES` over the repo root and tmpdir, deterministic `fixture` identity, cwd outside the repo - and the preload refuses runs launched any other way.** The pre-commit hook exports `GIT_DIR` and `GIT_INDEX_FILE` into `bun test`, silently redirecting every fixture's git calls at the REAL repository; two corruption incidents, plus one canary escape that proved per-suite scrubbing cannot cover children spawned with a default env (they inherit the environ from process birth, which no preload or in-process mutation reaches). Suites that build child envs by hand keep the same hygiene as belt-and-suspenders - scrub GIT_*, pin the /dev/null configs, set identity AFTER the scrub (`GIT_AUTHOR_NAME=fixture`, `GIT_AUTHOR_EMAIL=fixture@example.com`, `GIT_COMMITTER_NAME=fixture`, `GIT_COMMITTER_EMAIL=fixture@example.com`) - but the launcher, not suite discipline, is what contains a leaky test.

## Territory Binds Children

A builder's file whitelist binds every subagent the builder spawns, and the brief must say so.

Production case: a builder's docs subagent silently edited an out-of-territory policy file to satisfy a fail-closed guard. The builder then reported the edit as "the lead's uncommitted amendment", an attribution invented by inference from a stale observation.

Two rules follow:

1. Out-of-territory events are escalated in the builder's own name with writer evidence (the child's transcript shows the Edit call), never attributed by inference.
2. Fail-closed guards can couple docs to code ATOMICALLY (a bidirectional registry sweep makes "code here, docs are lead territory" literally uncommittable). When a guard demands an out-of-territory file, the resolution is an explicit lead grant, not a silent edit and not a doomed ordering plan.

## Final Signals Reconcile the Full Inbox

A directive sent to a worker mid-turn queues invisibly and delivers only at its next tool round; the worker cannot see it while its long turn runs. The dominant coordination failure this produces: the worker finishes its planned round, signals "done", and the queued directive silently drops. In one production session this cost a full extra round on four different builders, each of which sincerely reported completion while a lead message sat unread in its inbox.

The rule every brief carries: a FINAL SIGNAL must re-read the full inbox first and enumerate every lead message received since the last signal, with one line of evidence per directive ("fixed at file:line", "declined because X", "already done, see Y"). A signal that omits a pending directive is not a final signal: the lead bounces it, and the bounce costs more than the enumeration ever does.

The lead's side of the same rule: verify a signal against the directives actually sent, by probe, not by trusting the enumeration.

## Directives and Steps Are Idempotent

Messages cross constantly in a fleet: a directive can arrive twice, arrive late, or arrive after the worker already did the thing. Idempotency is what makes that harmless. Every directive and every briefed step is written to be safe on re-arrival: the worker checks current state before acting, and an already-applied directive is a no-op to report ("already done, see Y"), never an error and never a redo.

The exception class is named, never assumed: genuinely non-idempotent operations (version bumps, counters, anything append-only) are called out in the brief and coordinated through the lead. Production shape: two stacked builders each bumped the same manifest version by one; the double bump was absorbed only because a later rebase happened to collapse the two edits. The brief clause makes that coordination explicit instead of lucky.

## The TODO Ban

Builders may never leave TODO or FIXME markers. The work either happens in the same change or is surfaced as an escalation in the completion signal, for the lead to queue or put before the user. A TODO found in a diff at review time is a review finding.

## Example Brief

```text
Task: Add rate limiting to the API gateway (worktree branch: wt/rate-limit).
Done means: middleware added, unit tests pass, gateway docs section updated.
Territory: src/gateway/** and tests/gateway/** only. Do NOT touch
  src/core/** or shared configs; report needed changes there in your
  signal instead of making them.
Gates: run `bun run check` FOREGROUND until green, then run your own
  review loop and fix findings before signaling. Spawn reviewers UNNAMED
  (named spawns detach); write scratch/prompt files to /tmp, never here.
Handoff: commit finished work to wt/rate-limit (do not push). Signal the
  lead with the branch name, commit subjects, any escalations, and one
  line per lead message you received. Re-read your FULL inbox first: a
  signal that omits a pending directive is not a final signal.
Rules: no TODO/FIXME markers; do the work or escalate it. Comments only
  for what code cannot show. Directives can arrive twice or late: check
  current state first; report an already-applied one as a no-op. Never
  stop to "wait" for background children: after fanning out, your next
  action on wake is reading their output. The only permitted stop is
  your final signal.
```
