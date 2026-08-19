# Comment Standards: Full Detail

Comments exist only for what the code cannot show: non-obvious constraints, cross-file invariants, external-system quirks. The code is the single source of truth. Four rules follow, plus the planning-reference ban.

## No redundant comments

If the code directly and easily tells the reader the implementation, a comment saying the same thing is noise - never write one, and delete wholly redundant ones outright rather than compressing them. If a comment buries one real constraint in narration, keep only the constraint.

## Keep comments short everywhere

Even a comment documenting a genuine constraint is compressed to the constraint itself - one to three lines. History, rejected alternatives, and derivations belong in commit messages, not comments. A comment that has grown into a paragraph almost always contains either narration (delete it) or a workaround defense (fix the code).

## No comment-justified workarounds

If it takes a paragraph-long comment to justify why a workaround is OK, the code is wrong: fix the code, even when that takes a bigger refactor (see `references/design.md`, Maintainability Over Effort). A long rationalizing comment is the smell that a cleaner design exists; adopt it outright and delete the old path rather than shimming around it. Comments documenting a genuinely external, unavoidable constraint are fine.

## No TODO comments, ever

A TODO/FIXME/XXX/HACK marker is deferred work hiding in the code: either DO the work in the same change, or SURFACE it to the user (a task, an escalation in the completion signal) - never park it in a comment. Sweeps treat existing TODO markers as work items to resolve or surface, not text to compress.

## No planning references in code

Code and comments never reference planning artifacts: work-package names, spike part numbers, plan codenames, audit finding numbers, or "temporary per plan" markers. Plan-internal labels are meaningless to future readers; comments describe what the code does and why, not where it came from. Commit messages may reference the change itself but not internal plan codenames.

## How to apply

- Before keeping or writing any comment, ask what it says that the code does not; if the answer is nothing, remove it or don't write it.
- Treat any multi-line comment defending a hack, special case, or fragile assumption as a signal to redesign that code until the comment becomes unnecessary.
- Run these checks explicitly in every pre-commit review pass (see the `/review-before-commit` skill), and propagate them to every subagent that writes code.
- When sweeping a whole repo, skip generated files and symlinked files.
