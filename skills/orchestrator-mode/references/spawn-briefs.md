# Spawn Briefs

Every subagent spawn brief is self-contained: the agent may lack the task board, the plan, and the session history, so the brief carries everything.

## Checklist

Every brief includes:

1. **The full task contract inline.** Goal, acceptance criteria, and the definition of done. Never say "see task #N"; subagents may lack the board tools.
2. **An explicit file whitelist and do-not-touch boundary.** The territory the agent owns, plus any shared files with region-level grants (e.g. one CSS file's disjoint regions). This is what lets sibling branches merge without conflicts.
3. **The gates to run** (typecheck, lint, tests) and the instruction to run its own review loop before signaling done.
4. **How to signal completion** (e.g. message the lead) and the handoff contract: commit finished work to the worktree's branch (never push unless the brief says so) and include the branch name, commit subjects, and any escalations in the signal. In PR-per-track mode the brief NAMES THE ACTOR explicitly, preserving both options: either the builder pushes its branch, opens the PR, reports the URL in its signal, and spawns (or requests) the CI watcher for its own pushes - or the builder stays no-push and the lead pushes from the worktree, opens the PR, and starts the watcher. The final signal is the only permitted stop.
5. **The stop-and-wait ban** (below).
6. **The comment rules, including the TODO ban** (below).
7. **The out-of-territory rule:** anything broken or wrong found outside the agent's file whitelist is reported in the completion signal, never fixed silently - a silent out-of-territory edit collides with another agent's territory, and a silently dropped finding is lost.

## The Stop-and-Wait Ban

In harnesses like Claude Code, a subagent's idle notification fires only when it has zero live children, so "I'll be woken when they complete" is always said to an already-complete state. Builders that stop to "wait for my background children" strand until someone nudges them. If your harness has different notification semantics, verify them before relying on this; the ban on stopping to wait stands either way.

Every brief therefore states:

- Run gates, hooks, and reviews FOREGROUND.
- After fanning out sub-editors, the next action on wake is to read their output, never to wait again.
- No idle stop is permitted before the final signal.

When a stranded agent must be nudged anyway, the nudge states the mechanism ("this notification fires only with zero live children, so your child is done; read its output"). A bare "continue" lets it re-strand at the next seam.

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
  review loop and fix findings before signaling.
Handoff: commit finished work to wt/rate-limit (do not push). Signal the
  lead with the branch name, commit subjects, and any escalations.
Rules: no TODO/FIXME markers - do the work or escalate it. Comments only
  for what code cannot show. Never stop to "wait" for background
  children: after fanning out, your next action on wake is reading their
  output. The only permitted stop is your final signal.
```
