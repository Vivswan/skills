---
name: no-sleep-waiting-on-subagents
description: Use when a background subagent, reviewer, or watcher is running and the next step looks like sleeping, polling, or waiting for it.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# No Sleep-Waiting on Subagents

Never run `sleep`, poll in a loop, or otherwise stall to wait for a background subagent: the harness sends a completion notification on its own. A sleep only delays the moment you can act on the result, and a polling loop is repeated no-op checks the harness already does for free.

## When to Apply

- A background subagent, reviewer, or watcher was just launched
- "Wait for the agent to finish" appears as the next step in a plan
- You are about to run `sleep N` with a subagent in flight

## The Rule

1. After launching a background subagent, keep working on other tasks or end the turn; react when the completion notification arrives.
2. If a result is needed before anything else can proceed, launch the agent synchronously (`run_in_background: false` in Claude Code) or use the harness's blocking wait primitive - never a sleep loop.
3. Propagate the rule to every subagent you spawn: orchestrators and workers alike never sleep-wait on their own children, so it belongs in spawn briefs.

## Boundary

Watching EXTERNAL state the harness cannot notify about (a CI run through its own CLI, a remote queue) is a different job: that is what dedicated background watchers are for (see `/watch-ci-after-push`). The ban is on waiting for the harness's own subagents, whose completion arrives as a notification regardless.
