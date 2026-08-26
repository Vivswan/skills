---
name: never-twice
description: Use when you just corrected an agent or fixed the same failure class twice - climb past the instance fix to the most durable response reachable, architecture and data structures first.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Never Twice

> Categorically eliminate the problem - through better architecture or a better choice of data structures - so the failure class cannot recur, instead of fixing its instances one at a time.

Every correction and every repeated failure gets the most durable response reachable:

| Rung | Response | What the class can still do |
| --- | --- | --- |
| 1 | better architecture or data structures | cannot recur |
| 2 | a lint rule or test in CI | recurs, but cannot land |
| 3 | a skill or written rule | recurs, but the next agent knows |
| 4 | human vigilance | anything - a last resort, not a plan |

## Rung 1: the class cannot recur

An event enum keeps outgrowing the roster that dispatches on it:

```ts
// Fix 1 shipped Event.Deleted's missing entry. Fix 2 shipped
// Event.Archived's, plus a guard. Both read as complete:
handlers[Event.Archived] = onArchived;
assert(Object.keys(handlers).length === EVENT_COUNT); // fires at runtime, after the hole ships
```

```ts
// Rung 1: the roster is total, so the hole cannot be built:
const handlers: Record<Event, Handler> = {
  [Event.Created]: onCreated,
  [Event.Updated]: onUpdated,
  [Event.Deleted]: onDeleted,
  [Event.Archived]: onArchived,
};
// A new member fails compilation until the roster covers it.
```

Type-level mechanics (closed unions, branded types, typestate) live in the `/no-invalid-states` skill.

## Rung 2: recurs, but cannot land

The same cleanup keeps getting committed by hand:

```text
$ git log --oneline -- docs/
9e8f7a6 fix: replace curly quotes with ASCII
a1b2c3d fix: replace curly quotes with ASCII (again)
```

```yaml
# Rung 2: a CI check, marked required in branch protection.
# Fail-closed: hits and grep errors both fail; only "no matches" passes.
- name: check-typography
  run: |
    status=0
    grep -rnP '[\x{2018}-\x{201D}\x{2014}]' docs/ || status=$?
    test "$status" -eq 1
```

## Rung 3: recurs, but the next agent knows

The same correction keeps being given across sessions:

```text
"Timestamps in logs are ISO 8601, not epoch."   (Tuesday)
"ISO 8601 in logs, please."                     (Thursday, new session)
```

```text
# Rung 3: the correction becomes a rule in a file every session loads.
$ tail -1 AGENTS.md
Log timestamps are ISO 8601 (2026-08-26T14:03:00Z), never epoch.
```

## Workflow

1. Name the class in one sentence: "any new Event member can ship without a roster entry." If you cannot, it is not a class yet - fix the instance and move on.
2. Find the substrate that admits new members: two artifacts synced by convention, a string where a closed set belongs, state kept in prose, a hand-typed ritual.
3. Climb as close to rung 1 as the task allows: take the most durable rung you can implement within the task's scope and authority.
4. Ship it. A lower-rung fallback ships only with the gap to the more durable rung named in your report - and tracked as its own task where you have the authority to create one, never parked as a note (a note is state kept in prose, the substrate that admitted the class).

Test whatever ships:

> If a new member of this class appears tomorrow, does the fix hold, or does it silently pass the same way?

Map the answer to the ladder: it cannot be built (rung 1), CI stops it before landing (rung 2), a loaded rule catches it in session (rung 3), or it silently passes - no rung held, the class is alive. A runtime guard that fails loudly but late - after shipping - is an instance fix wearing a fix's clothes, not a rung.

## Review Criteria

Skills that run code reviews (such as `/rubber-duck-review`) expand this section into their reviewer prompt when this skill is installed. Ask the reviewer to flag:

- fixes that repeat an earlier fix of the same failure class - cite the evidence (the prior commit, doc line, or correction), not a hunch
- for each, name the rung the fix sits on, propose a concrete more durable rung, and say why it is reachable within this change's scope (or why it is not)
- apply the test to whatever ships: a new member of the class tomorrow - impossible to build, stopped in CI, caught by a loaded rule, or silent?

Triage the resulting findings with the workflow above.
