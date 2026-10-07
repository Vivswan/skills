---
name: prefer-library-over-hand-rolling
description: "Use BEFORE writing any parser, fetcher, schema, converter, retry or backoff loop, lock or serializer, date or zone helper, scanner, or CLI plumbing, and when reviewing or briefing one - never hand-roll what a good library or a tool already in the repository does; search first and write the result down; large or unclear fit, ask the owner"
metadata:
  type: feedback
---

Never hand-roll something a good library already exists for. The search happens before the first line and is recorded in the brief, then the PR body or the landing report: the library used, or what was searched and why nothing fits.

- A tool already in the repository counts as the library (a lint rule in place of a hand-written scanner).
- Code a change adds, moves, touches, reuses, or depends on counts, not only code it adds.
- Dependency weight is never a reason to keep the hand-rolled version.
- A large library or an unclear fit is the owner's question, asked before the work with the library named.
- The one exception: a library that needs a runtime or API the repository has dropped.

**Why:** The hand-rolled version is maintained for as long as the code lives, the library by its authors. Hand-rolled parsers, scanners, retry loops, and lock helpers with a library alternative have passed briefs, reviews, and gates repeatedly, because the rule was pointed at and never asked.

**How to apply:** The brief carries a filled `Library check:` line, the PR body's `## How` (or the landing report) a `**Library:**` bullet, the reviewer asks the standing question and a confirmed hit is blocking, and the gate refuses the PR without the bullet. The `/code-standards` skill's design reference owns the rule; it fires per [[fire-relevant-skills-and-memories]] and is reviewed per [[rubber-duck-before-every-commit]].
