---
name: retire-the-class
description: Use when the same failure class is fixed twice, a trap or countermeasure list keeps growing, or a fix looks pointwise - find the architecture or data-structure change that retires the class.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Retire the Class

> Categorically eliminate the problem - through better architecture or a better choice of data structures - so the failure class cannot recur, instead of fixing its instances one at a time.

When you intervene to correct an agent, or fix the same failure again, respond at the highest rung you can reach, in order of value:

1. Categorically eliminate the problem - better architecture or a better choice of data structures. The class cannot recur.
2. Turn it into a lint rule or test so CI catches it. The class recurs but cannot land.
3. Turn it into a skill or rule. The class recurs but the next agent knows.
4. Have humans review for it. The weakest rung - a last resort, not a plan.

This skill is itself a rung-3 artifact: it exists so the next agent knows to reach for rung 1.

When the same failure class gets patched twice, or a countermeasure list keeps growing, stop patching pointwise: find the architecture, data-structure, or substrate change that makes the whole class unrepresentable, and prefer it even when it is a big refactor.

A fix that looks finished and a fix that removes the class are different deliverables. The generalization question that tests whether a fix clears the bar above:

> If a new member of this class appears tomorrow, does the fix hold, or does it silently pass the same way?

A silent pass means the class is still alive. So does a loud-but-late failure: a runtime guard converts the silent pass into a failure after shipping, but the class is retired only when the invalid state cannot be built at all.

## When to Apply

- you just intervened to correct an agent, or corrected the same behavior twice
- the fix being written is the second (or later) patch on the same kind of failure
- a doc, checklist, or warning-comment list of traps grew again in this change
- the fix enumerates known-bad cases ("also handle X", "also escape Y") instead of removing what admits them
- instructions accumulate "remember to ..." steps that every future operator must hold in their head

## Workflow

### 1. Name the class in one sentence

"Any new member of the event enum can ship without a roster entry." If you cannot name it in one sentence, it is not a class yet: ship the pointwise fix and move on.

### 2. Find the substrate the class lives on

New members keep appearing because something weak admits them: two artifacts synced by convention, a stringly-typed identifier, an untyped output channel, state kept in memory or prose, a hand-retyped ritual. That substrate, not the latest member, is the fix target.

### 3. Pick the highest-rung response

The table lists the highest reachable rung per shape: rung 1 wherever it exists, and the two entries marked rung 2 where prevention is impractical.

| Class keeps appearing as | Highest-rung response |
| --- | --- |
| repeated null or lifecycle guards at N call sites | a sum type or an owning transition - the type-level mechanisms live in the `/no-invalid-states` skill |
| two artifacts synced by convention (an enum and its dispatch table, a schema and its docs) | derive one from the other - a single source with the duplicate generated: drift is unrepresentable (rung 1) |
| convention-synced artifacts where generation is impractical | a CI agreement check: drift recurs but cannot land (rung 2) |
| string values from a closed set, dispatched on by string | a closed union or enum: a new member breaks every non-exhaustive handler at compile time |
| stringly-typed identifiers re-validated at every consumer | a branded type behind a smart constructor: validate once at the boundary, trust thereafter (retires re-validation, not roster holes) |
| a warning-comment checklist or trap doc that grows per incident | an executable check: a test, a lint rule, a script |
| a count or boolean standing in for a set or richer state | the set or the state itself |
| state living in prose, memory, or scrollback | a persisted structured store |

Every row is a rung-1 move except the two marked rung 2 - the CI agreement check and the trap-doc row: an executable check stops the class from landing even though it can still recur.

### 4. Ship the class-retiring change

The class-retiring change (rung 1) - the categorical elimination, not the instance fix - is the deliverable; build it now, even when it is a big refactor. A rung-2 fallback ships only where rung 1 is impractical, is recorded as rung 2, and names the rung-1 gap it leaves open. Only when urgency forces it does the pointwise fix ship first - and then the class-retiring change is boarded immediately as its own task on the active plan or board, never parked as a note (a note is state kept in prose: the exact substrate this skill exists to retire), and the work is reported as incomplete until the class is retired.

## Worked Examples

### A roster hole, fixed twice

Before: an event enum gained a new member, and the handler roster dispatching on it was not updated, so the new event fell through silently. The fix added the missing entry and read as complete. Weeks later the next member shipped with the same hole; that fix added its entry plus a runtime assertion that the roster covers every member, and also read as complete. Both were pointwise: for a third member tomorrow, the first fix silently passes, and the assertion fails loudly but late - at runtime, after the hole has already shipped. Neither prevents the hole from being built.

The class, in one sentence: any new enum member can ship without a roster entry. The substrate: two artifacts - the enum and the roster - synced by convention.

After: the roster became a compile-time-exhaustive structure (a `Record<Event, Handler>` in TypeScript, an exhaustive `match` in Rust). A new member now fails the build until the roster covers it. The class is unrepresentable, not guarded.

### A trap doc that grew per incident

A monitoring doc grew about 40 lines of probe traps in one shift ("this grep pipeline reads 0 both when the check passes and when the log path moved"). The class: any probe whose broken state is indistinguishable from a passing check silently passes. The substrate: ad-hoc pipelines whose only output channel is an untyped count. Retired by a probe tool with a three-way result - pass with evidence, fail with evidence, or a loud probe error (a clean zero passes only with source-verification evidence attached) - plus tested scripts replacing the hand-typed pipelines. The doc stopped growing per incident.

## Review Criteria

Skills that run code reviews (such as `/rubber-duck-review`) expand this section into their reviewer prompt when this skill is installed. Ask the reviewer to flag:

- fixes that are the second-or-later patch on the same failure class: the diff handles one more instance of a failure the codebase has been patched for before
- countermeasure, trap, or known-bad-case lists (docs, checklists, warning comments, enumerated guards) that grew in this diff
- for each finding, name the substrate change - architecture, data structure, or tooling - that would retire the whole class, and apply the generalization question: if a new member of the class appears tomorrow, is it prevented before shipping, does it fail loudly but late, or does it silently pass? Only prevention - the invalid state cannot be built - retires the class
- for each fix, name the rung it sits on (1 categorical elimination, 2 caught by CI, 3 skill or rule, 4 human review) and whether a higher rung was reachable

Triage the resulting findings with the workflow above.
