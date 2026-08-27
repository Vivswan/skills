---
name: no-sleep-waiting-on-subagents
description: "Use when tempted to sleep, poll, or busy-wait on a background subagent - its completion notification re-invokes the session on its own; launch synchronously instead when the result gates everything else"
metadata:
  type: feedback
---

Never sleep or poll waiting for a background subagent whose completion notification re-invokes the session. The notification arrives on its own; a sleep in between is pure waste, and a poll loop can only confirm what the notification would have delivered anyway. When the subagent's result gates everything that follows, do not background it at all: launch it synchronously and continue when it returns.

**Why:** Two failure modes. A session with nothing else to do burns turns sleeping in a loop for a notification that is already guaranteed to arrive. Worse, a spawned worker ends its own turn to "wait" on a background helper - but re-invocation is a property of a still-live session, and for a worker, ending the turn is completing: there is no session left for the notification to land in, so that wait is unbounded by construction.

**How to apply:** Result gates everything: launch synchronously. Result is one of several parallel streams: background it and keep working on the others; the notification interrupts when it lands. This division holds only for an agent that stays live to be re-invoked: a spawned worker, whose turn ending is its completion, launches every gating helper synchronously, and any harness with no completion notification has no compliant background wait at all. Propagate this rule into every spawn brief, so workers inherit it instead of rediscovering the trap. External state that sends no notification - a CI run, a remote deploy - is not a subagent: hand that wait to a dedicated watcher process whose exit wakes the session.
