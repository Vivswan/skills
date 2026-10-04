---
name: never-twice
description: Use when you just corrected an agent or fixed the same failure class twice, or when a change removes a rule, guard, or check.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Never Twice

> Categorically eliminate the problem so the failure class cannot recur, through better architecture or a better choice of data structures. That beats fixing its instances one at a time.

Every failure that passes the floor below, most corrections of an agent among them, gets the most durable response reachable:

| Rung | Response | What the class can still do | Preference |
| --- | --- | --- | --- |
| 1 | better architecture or data structures | cannot recur | the goal |
| 2 | a lint rule or test in CI | recurs, but cannot land | acceptable |
| 3 | a skill or written rule | recurs, but the next agent knows | fallback |
| 4 | human vigilance | anything | avoid |

The ladder is not a menu, and preference decays exponentially down it. Rung 1 is the goal, and rung 2 a clearly weaker but acceptable gate. Rungs 3 and 4 are each another large step down, taken only when every higher rung is genuinely unreachable.

A rung-3 or rung-4 landing is a **debt**, not a resolution. When a higher rung becomes reachable, convert the rule or vigilance entry up the ladder.

**The floor the ladder stands on:** whether a failure earns a guard is a judgment weighed scenario by scenario, never a count and never a lookup. Four questions carry it: can the failure be reproduced, is the cause understood concretely, how often will normal operation produce the trigger, and what would the guard cost and where would it live?

A correction of an agent answers those questions by itself: the default behaviour is the concrete cause, and every prompt produces the trigger, so a single correction usually passes the floor. Likely means normal operation produces the trigger often. An outage (the forge down, a dependency's service down) is the canonical unlikely trigger.

Reproducible on demand is not reproducible at the desk. A condition whose cause is understood concretely, that arises only in CI or needs something that cannot be staged locally, and that keeps happening in real runs, answers the questions the same way: known cause, likely trigger.

Two constraints hold in every scenario. A fixture reproduces the failure as observed, so none is ever built without a reproduction, and no local fixture is fabricated to stand in for a condition that lives elsewhere; the guard lives where the condition lives. An unreproduced incident whose cause is unknown is recorded, never guarded.

The record (where it was seen, what was observed) goes in the PR body, report, or issue that holds the incident, never in a rule. "It happened twice" is evidence for the judgment, not a trigger on its own. When the judgment is unclear, ask the user; never build quietly, and never drop it silently.

Worked examples of the judgment, not an exhaustive list:

- A release step depends on someone editing a version file by hand first. Skipping the edit reproduces the failure, every release runs the step, and deriving the version costs one line, so the step derives it.
- A merge race is understood from the code, and its window opens whenever two pushes land within a minute. Nothing reproduces it at the desk, but normal operation opens that window often, so a lock of a few lines in the merge step, where the race lives, serializes them, with no fabricated fixture.
- A check fails only on the CI runner's image after its nightly rebuild, never locally. The cause is concrete, the rebuild is nightly, and a one-step probe of the image in the pipeline is cheap, so the guard lives where the condition does: a CI-side tripwire.
- The forge was down for ten minutes and a push failed. Normal operation rarely produces an outage, so the push is retried and the event recorded, and the user is asked if a fix still seems right.
- A review launcher's scratch directory vanished once mid-run. No reproduction and no cause, so the run was relaunched and the event recorded, and no guard was built.

## Workflow

1. **Name the class** in one sentence: "any new Event member can ship without a roster entry." If you cannot, it is not a class yet: fix the instance and move on.
2. **Find the substrate** that admits new members: two artifacts synced by convention, a string where a closed set belongs, state kept in prose, a hand-typed ritual.
3. **Climb** as close to rung 1 as the task allows: take the most durable rung you can implement within the task's scope and authority.
4. **Ship it.** A lower-rung fallback ships only with the gap to the more durable rung named in your report. Track that gap as its own task where you have the authority to create one. Never park it as a note: a note is state kept in prose, the substrate that admitted the class.

Test whatever ships:

> If a new member of this class appears tomorrow, does the fix hold, or does it silently pass the same way?

Three answers:

- It **silently passes**: the class is alive.
- It **fails loudly but late** (at runtime, after shipping): an instance guard, the class is still alive.
- It **cannot recur**, at the rung that holds it: impossible to build (1), stopped in CI (2), caught by a loaded rule (3).

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

How to write the rule (where it lives, its trigger, its quality bar) is the `/craft-skills-and-memories` skill's job. This rung decides THAT a loaded rule is the response, then hands off there.

## Deleting a Guard (Chesterton's Fence)

The ladder erects guards, and this rule governs removing them. Never remove a rule, guard, or check without being able to state why it was erected. Every such deletion in a change maps to one of two outcomes, or nothing lands:

- a successor that covers its class: a script that embodies it, a stronger rung, a rewording that keeps the rule
- a named deliberate cut, with the reason recorded in the change

Worked example: a doc rewrite deleted 90 long-standing rule lines. Auditing each line into successor / rewording / named cut found exactly one unmapped real loss, restored before landing.

The audit is the mechanism. This rule makes it the default for every deletion, not a salvage step after someone notices.

The pairing is the point: aggressive rewrites stay allowed BECAUSE deletions are audited. The audit is what makes bold deletion safe, not a brake on it.

## Review Criteria

Skills that run code reviews (such as `/rubber-duck-review`) expand this section into their reviewer prompt when this skill is installed. Ask the reviewer to flag:

- fixes that repeat an earlier fix of the same failure class. Cite the evidence (the prior commit, doc line, or correction), not a hunch
- for each, name the rung the fix sits on, propose a concrete more durable rung, and say why it is reachable within this change's scope (or why it is not)
- apply the test to whatever ships: if a new member of the class appears tomorrow, is it impossible to build, stopped in CI, caught by a loaded rule, or silent?
- deletions of rules, guards, or checks that map to neither a successor covering their class nor a deliberate cut with its reason recorded in the change (Deleting a Guard, above)
- a guard the floor's judgment does not support (the floor, above): an unreproduced incident with unknown cause, guarded at all; an unreproduced rare trigger, or an unclear call, guarded without the user's confirmation; a fixture that does not reproduce an observed failure
- an instance repair with no guard where the floor's judgment supports one (a concrete cause, a trigger normal operation produces often, a guard worth its cost): the fix climbs the ladder

Triage the resulting findings with the workflow above.
