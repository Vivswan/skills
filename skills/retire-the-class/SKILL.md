---
name: retire-the-class
description: Use when the same failure class is fixed twice, a trap or countermeasure list keeps growing, or a fix looks pointwise - find the architecture or data-structure change that retires the class.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Retire the Class

When the same failure class gets patched twice, or a countermeasure list keeps growing, stop patching pointwise: find the architecture, data-structure, or substrate change that makes the whole class unrepresentable, and prefer it even when it is a big refactor.

A fix that looks finished and a fix that removes the class are different deliverables. The generalization question that tells them apart:

> If a new member of this class appears tomorrow, does the fix hold, or does it silently pass the same way?

A silent pass means the class is still alive.

## When to Apply

- the fix being written is the second (or later) patch on the same kind of failure
- a doc, checklist, or warning-comment list of traps grew again in this change
- the fix enumerates known-bad cases ("also handle X", "also escape Y") instead of removing what admits them
- instructions accumulate "remember to ..." steps that every future operator must hold in their head

## Workflow

### 1. Name the class in one sentence

"Any new member of the event enum can ship without a roster entry." If you cannot name it in one sentence, it is not a class yet: ship the pointwise fix and move on.

### 2. Find the substrate the class lives on

New members keep appearing because something weak admits them: two artifacts synced by convention, a stringly-typed identifier, an untyped output channel, state kept in memory or prose, a hand-retyped ritual. That substrate, not the latest member, is the fix target.

### 3. Pick the class-retiring form

| Class keeps appearing as | Class-retiring form |
| --- | --- |
| repeated null or lifecycle guards at N call sites | a sum type or an owning transition - the type-level mechanisms live in the `/no-invalid-states` skill |
| two artifacts synced by convention (an enum and its dispatch table, a schema and its docs) | a single source, with the duplicate generated or checked |
| stringly-typed identifiers drifting apart | an enum or branded type with exhaustiveness checking |
| a warning-comment checklist or trap doc that grows per incident | an executable check: a test, a lint rule, a script |
| a count or boolean standing in for a set or richer state | the set or the state itself |
| state living in prose, memory, or scrollback | a persisted structured store |

### 4. Ship the class-retiring change

The class-retiring change is the deliverable; build it now, even when it is a big refactor. Only when urgency forces it does the pointwise fix ship first - and then the class-retiring change is boarded immediately as its own task on the active plan or board, never parked as a note (a note is state kept in prose: the exact substrate this skill exists to retire), and the work is reported as incomplete until the class is retired.

## Worked Examples

### A roster hole, fixed twice

Before: an event enum gained a new member, and the handler roster dispatching on it was not updated, so the new event fell through silently. The fix added the missing entry and read as complete. Weeks later the next member shipped with the same hole; that fix added its entry plus a runtime assertion that the roster covers every member, and also read as complete. Both were pointwise: a third member tomorrow still ships with a hole, caught by the assertion after deploy at best.

The class, in one sentence: any new enum member can ship without a roster entry. The substrate: two artifacts - the enum and the roster - synced by convention.

After: the roster became a compile-time-exhaustive structure (a `Record<Event, Handler>` in TypeScript, an exhaustive `match` in Rust). A new member now fails the build until the roster covers it. The class is unrepresentable, not guarded.

### A trap doc that grew per incident

A monitoring doc grew about 40 lines of probe traps in one shift ("this grep pipeline reads 0 both when the check passes and when the log path moved"). The class: any probe whose broken state is indistinguishable from a passing check silently passes. The substrate: ad-hoc pipelines whose only output channel is an untyped count. Retired by a probe tool with a three-way result - pass with evidence, fail with evidence, or a loud probe error (a clean zero passes only with source-verification evidence attached) - plus tested scripts replacing the hand-typed pipelines. The doc stopped growing per incident.

## Review Criteria

Skills that run code reviews (such as `/rubber-duck-review`) expand this section into their reviewer prompt when this skill is installed. Ask the reviewer to flag:

- fixes that are the second-or-later patch on the same failure class: the diff handles one more instance of a failure the codebase has been patched for before
- countermeasure, trap, or known-bad-case lists (docs, checklists, warning comments, enumerated guards) that grew in this diff
- for each finding, name the substrate change - architecture, data structure, or tooling - that would retire the whole class, and apply the generalization question: if a new member of the class appears tomorrow, does this fix hold, or does it silently pass?

Triage the resulting findings with the workflow above.
