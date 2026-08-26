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

"Any grep-based probe reads 0 both when the check passes and when the probe is broken." If you cannot name it in one sentence, it is not a class yet: ship the pointwise fix and move on.

### 2. Find the substrate the class lives on

New members keep appearing because something weak admits them: an untyped output channel, a text-token check against live content, state kept in memory or prose, a hand-retyped ritual. That substrate, not the latest member, is the fix target.

### 3. Pick the class-retiring form

| Class keeps appearing as | Class-retiring form |
| --- | --- |
| repeated tool traps documented in prose | a tested script that bakes them in |
| a count standing in for a thing | a set, or an evidence-bearing result |
| state that evaporates (memory, prose, scrollback) | a persisted ledger |
| substring tokens matched against live text | pinned-content snapshots and diffs |
| repeated runtime guards for the same invariant | a stronger representation - the type-level mechanisms live in the `/no-invalid-states` skill; this skill covers the rest of the space |

### 4. Ship the class-retiring change

The class-retiring change is the deliverable; build it now, even when it is a big refactor. Only when urgency forces it does the pointwise fix ship first - and then the class-retiring change is boarded immediately as its own task on the active plan or board, never parked as a note (a note is state kept in prose: the exact substrate this skill exists to retire), and the work is reported as incomplete until the class is retired.

## Worked Example

Before: a monitoring doc grew about 40 lines of probe traps in one shift. Each incident added another warning - "this grep pipeline reads 0 both when the check passes and when the log path moved", "count lines only after filtering the header". Every fix worked, and every fix left the next operator one more line to remember. The doc was growing per incident: the class was alive.

The class, in one sentence: any probe whose broken state is indistinguishable from a passing check silently passes. The substrate: ad-hoc grep pipelines whose only output channel is an untyped count.

After: a probe tool with a three-way result - pass with evidence, fail with the offending lines as evidence, or a loud probe error - plus tested scripts replacing the hand-typed pipelines. A clean zero passes only with source-verification evidence attached: the canonical source it read, that source's freshness, and how many records it scanned. Anything the tool cannot vouch for is a probe error, never a bare 0. A new probe mistake now fails loudly in the tool instead of earning a warning line. The doc stopped growing per incident: the class is retired, not managed.

## Review Criteria

Skills that run code reviews (such as `/rubber-duck-review`) expand this section into their reviewer prompt when this skill is installed. Ask the reviewer to flag:

- fixes that are the second-or-later patch on the same failure class: the diff handles one more instance of a failure the codebase has been patched for before
- countermeasure, trap, or known-bad-case lists (docs, checklists, warning comments, enumerated guards) that grew in this diff
- for each finding, name the substrate change - architecture, data structure, or tooling - that would retire the whole class, and apply the generalization question: if a new member of the class appears tomorrow, does this fix hold, or does it silently pass?

Triage the resulting findings with the workflow above.
