# Comment Standards: Full Detail

A comment is written for humans and agents, and a human reads it first. It carries only what the code cannot show, in a shape a reader skims in one pass. The code is the single source of truth.

## What a good comment carries

Only what the code cannot show. The kinds:

- The reason a choice was made when the obvious choice was rejected.
- An invariant another file relies on; name that file.
- An external system's quirk, with what breaks without the workaround.
- A consequence of changing the line that is not visible here.
- The one input that motivated a guard.

Never a comment: what the code does, its types, its control flow, its history, the rejected alternatives, the derivation. History, alternatives, and derivations belong in the commit message.

## Shape

- One idea per sentence. Short sentences. Plain words.
- A multi-line comment is a list of separate facts, one per line, never a paragraph that wraps.
- Usual length: one to three lines. Hard ceiling: 10 lines per block and 25 for a file header, the fleet caps repo-platform's file-size check enforces.
- A reader skims it and gets the point; a comment that needs a second read is rewritten.

## The test

Before writing or keeping a comment, ask two questions:

1. What does this say that the code does not?
2. Could a tired human read it in one pass?

Fail either: rewrite or delete. A wholly redundant comment is deleted, not compressed. A comment that buries one real constraint in narration keeps only the constraint.

## Specimen

The before/after header is in `SKILL.md`, under this standard. What changed:

- The opening sentence described the regex, which the code shows; it is gone.
- Each remaining line is one fact the code cannot show, with its reason in the same sentence.
- The reader skims separate facts instead of untangling one wrapped paragraph.

## No comment-justified workarounds

If it takes a paragraph-long comment to justify why a workaround is OK, the code is wrong: fix the code, even when that takes a bigger refactor (see `references/design.md`, Maintainability Over Effort).

A long rationalizing comment is the smell that a cleaner design exists; adopt it outright and delete the old path rather than shimming around it. A comment documenting a genuinely external, unavoidable constraint is fine, in the shape above.

## No TODO comments, ever

A TODO/FIXME/XXX/HACK marker is deferred work hiding in the code: either DO the work in the same change, or SURFACE it to the user (a task, an escalation in the completion signal); never park it in a comment. Sweeps treat existing TODO markers as work items to resolve or surface, not text to compress.

## No planning references in code

Code and comments never reference planning artifacts: work-package names, spike part numbers, plan codenames, audit finding numbers, or "temporary per plan" markers. Plan-internal labels are meaningless to future readers; comments describe purpose and constraints, not where the code came from. Commit messages may reference the change itself but not internal plan codenames.

## How to apply

- Run the two-question test before writing a comment and before keeping one you meet.
- Shape every comment you keep: one fact per line, under the ceiling.
- Treat any multi-line comment defending a hack, special case, or fragile assumption as a signal to redesign that code until the comment becomes unnecessary.
- Run these checks explicitly in every pre-commit review pass (see the `/rubber-duck-review` skill), and propagate them to every subagent that writes code.
- When sweeping a whole repo, skip generated files and symlinked files.
