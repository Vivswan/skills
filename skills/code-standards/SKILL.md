---
name: code-standards
description: Use when writing or reviewing code changes, assembling a reviewer prompt, or asked to apply house code standards.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Code Standards

House standards for code and the artifacts around it. Apply them while writing; check them while reviewing. Where a standard has a canonical case (the specimen that set the rule), it is stated with it, because the concrete case recalls better than the rule; the `references/` file named under each standard carries the full detail - the why, the how-to-apply list, and the boundaries and exceptions.

## The Standards

### Fix the class, not the instance

A systemic problem gets a root fix that makes recurrence impossible (a workflow change, a shared test, tooling, a stronger type) - never only a fix of the case at hand.

Specimen (the case that set the rule): every Dependabot PR in a repo failed CI because a committed bundle drifted after dependency bumps. Hand-rebuilding the bundle on each PR fixes five PRs today and none tomorrow; the accepted fix was a CI workflow that rebuilds the bundle on every PR and pushes the regeneration commit automatically.

Full detail: `references/design.md`.

### Guard recurring problems with tests

If the same problem occurs a second or third time, or you judge it likely to recur (a drift-prone copy, a negligence-prone manual step, an easy-to-forget pipeline), add a guard: a test or tripwire that catches it at the source, or a pipeline fix that makes it impossible. When the guard is outside your reach (another repo, CI you cannot edit), tell the user what needs fixing and how, instead of silently absorbing the recurrence.

Full detail: `references/design.md`.

### General-purpose over special-case

Parameterize the axis that keeps changing instead of hardcoding today's instance.

Specimen: a safety classifier whose rulebook kept changing was built as a classifier FACTORY with the rubric as an input - any rubric change produces a new classifier for free, and the same machinery serves uses beyond safety.

Full detail, including the one-pipeline-per-concept rule (the page that grew three visibly diverging error-band renderers) and where DRY stops: `references/design.md`.

### Maintainability over effort

Code quality outweighs diff size and effort spent. A big refactor is always better than a fix done the wrong way: wrong-shaped fixes compound into tech debt. Take the larger refactor when it is cleaner, reduce complexity, and enforce invariants in types rather than repeated checks (see the `/no-invalid-states` skill). Use assertions to pin invariants the type system cannot carry - one assertion at a boundary removes whole families of downstream edge-case handling.

Specimen: a documented workaround hybrid was reworked outright rather than kept - never preserve a workaround to keep a diff small.

Full detail: `references/design.md`.

### Comments only for what code cannot show

Comments exist only for non-obvious constraints, cross-file invariants, and external-system quirks; the code is the single source of truth. Keep them SHORT (one to three lines), delete comments that restate the code outright, and treat a comment that has grown into a paragraph as containing either narration (delete it) or a workaround defense (fix the code, not the comment).

Full detail, including the TODO ban: `references/comments.md`.

### No barrel files or pass-through functions

An import-only index file, a "keep old importers compiling" re-export left after a move, or a function whose whole body forwards to another function without adding anything: delete it and repoint the importers or callers at the defining module or real function. A wrapper earns its existence only by adding something real (a default, a conversion, error mapping, an injected dependency, a narrowed type).

Full detail, including the migration-staging exception and what is not a barrel: `references/structure.md`.

### No planning references in code

Code and comments never reference planning artifacts: work-package names, spike or phase labels, plan codenames, audit finding numbers. The next reader has the code, not the plan.

Specimen: a comment like "WP-B spike, part 2:" has no meaning outside the planning; comments describe purpose and constraints, not where the code came from.

Full detail: `references/comments.md`.

### Lean AGENTS.md

Agent instruction files (AGENTS.md, CLAUDE.md) hold only project essentials: purpose, toolchain entry points, conventions CI enforces, safety constraints, and pointers. Cut anything an agent could learn by reading the code and keep a one-line pointer instead - duplicated detail drifts and then misleads; a pointer cannot drift.

Full detail: `references/artifacts.md`.

### Commit messages carry content only

Commit and PR messages state what changed and why, following the repo's subject conventions. No AI or tool attribution lines and no hard wrapping of the body at 72 columns (a wrapped body renders as ragged mid-sentence breaks in GitHub's soft-wrapping UI).

Specimen of the one sanctioned attribution: human community credit in repos that take contributions - `fix: ... (#NN, thanks @user)` in the subject, `Co-authored-by:` trailers for humans whose code landed. Credit for people, never for tools.

Full detail, including the email-patch exception: `references/artifacts.md`.

### No blobs of text

Docs, READMEs, reports, and PR text use scannable structure: bullets for facts, tables for enumerations, numbered steps for flows, paragraphs of 1-3 sentences. When the content is enumerable, enumerate it. Short explanatory paragraphs are fine; wall-of-text prose where structure would scan better is not.

Full detail: `references/artifacts.md`.

## Review Criteria

- Instance-only fixes: does the change prevent recurrence (test, type, tooling), or just patch the case at hand?
- A recurring or recurrence-prone problem fixed again without a guard test, tripwire, or pipeline fix (or a proposal to the user when the pipeline is out of reach).
- Special-casing: a new near-copy of existing logic where the varying axis should be a parameter.
- Complexity added to keep a diff small: flags, nesting, or repeated checks where a cleaner refactor or a stronger type was available (the `/no-invalid-states` skill covers the type-level fix).
- Comments that restate the code, and paragraph-long comments justifying workarounds (flag the code, not just the comment).
- Barrel files, re-export shims, or pass-through functions that only forward to another function or module.
- Planning artifacts (work packages, phases, codenames, finding numbers) referenced in code or comments.
- AGENTS.md or CLAUDE.md edits that duplicate implementation detail derivable from the code.
- Attribution lines or hard-wrapped bodies in commit messages and PR descriptions.
- Wall-of-text prose in docs, reports, or PR text where bullets, tables, or numbered steps would scan better.

Triage findings against the standards above; each criterion maps to one.

## Workflow

1. Writing code: apply the standards as you go; they are cheaper at write time than at review time.
2. Reviewing: check the Review Criteria, cite the specific standard in each finding, and prefer suggesting the class fix over the instance patch.
3. When a standard needs its boundaries (what counts, what is exempt, how far to take it), load the matching `references/` file before acting on it.
4. When a finding calls for enforcing invariants in the type system (lifecycle flags, must-call-X-before-Y ordering, fields that must appear together), apply the `/no-invalid-states` skill for the refactor itself.
5. When a standard conflicts with an explicit user or project decision, follow the decision and record which standard was consciously set aside.

## References

- `references/design.md`: fix the class, general-purpose over special-case (one pipeline per concept, DRY boundaries), maintainability over effort
- `references/comments.md`: the comment rules in full, the TODO ban, planning references
- `references/structure.md`: barrels, compatibility re-exports, escort functions, migration staging
- `references/artifacts.md`: lean AGENTS.md, content-only commit messages and their two exceptions
