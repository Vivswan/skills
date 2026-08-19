# Design Standards: Full Detail

The deep version of three standards: fix the class, general-purpose over special-case, maintainability over effort. They share one root: a design should absorb change instead of being rewritten by it.

## Fix the Class, Not the Instance

When a problem is systemic, do not just fix the occurrence in front of you - build the thing that makes the problem impossible from then on.

Canonical case: every Dependabot PR in a repo failed CI because a committed bundle drifted after dependency bumps. Hand-rebuilding and pushing the bundle to each PR fixes five PRs today and none tomorrow. The class fix was a CI workflow that rebuilds the bundle on every PR and pushes the regeneration commit automatically.

Why: an instance fix leaves the failure class alive, so the same toil returns on the next occurrence, and knowledge of the fix stays in one head. Encoding the fix in machinery (CI workflow, test, tripwire, type constraint, generator) retires the class permanently.

How to apply:

- When a failure looks like it will recur (same cause, different day/PR/file), pause the point fix and ask what mechanism would make the whole class impossible or self-healing: a workflow that repairs it automatically, a test or tripwire that fails at the source, a type that forbids the state, a generator that derives the repeated artifact.
- Prefer the mechanism even when it costs more than the point fix.
- Still apply the point fix when something is bleeding - but do not stop there.

### Guard recurring problems with tests

The recurrence trigger has two forms:

- **It already recurred**: the same problem showing up a second or third time is proof the class is alive; the next fix ships with a guard (a test, a tripwire, a CI check) so it either never happens again or is caught early when it does.
- **You foresee it recurring**: when a problem will plausibly return through negligence, drift, or a manual step someone will forget, do not wait for the second occurrence - add the test or fix the pipeline now.

When the fix is outside your reach (another repository, CI you cannot edit, a process the user owns), propose it concretely: name the pipeline that needs fixing and how to fix it, rather than silently absorbing the recurrence.

## General-Purpose Over Special-Case

Parameterize the axis that keeps changing instead of hardcoding today's instance.

Canonical case: a safety classifier was needed, but the safety rulebook kept changing - so the build target became a classifier FACTORY with the rubric as an input. Any rubric change now produces a new classifier for free, and the same machinery serves uses beyond safety.

How to apply:

- Find the axis that keeps changing (the rubric, the schema, the target platform) and make it a parameter or input; build the mechanism one level up when variation is expected.
- Generalize the varying axis, not every axis: general-purpose never means elaborate, and the mechanism itself stays simple and robust.
- A good test: could a second, unrelated consumer pick this up without rework?
- Validate the parameterized inputs with types at the trust boundary (the `/no-invalid-states` skill).

### One pipeline per concept, DRY with common sense

Canonical case: one page grew THREE independent problem-band renderers across three waves of work - blocking bands, a usage band, an over-budget paint - each locally correct, so the page ended with three visibly different answers to "how does an error look". The concept (a severity band) had no single pipeline, making drift structural rather than accidental.

- When one concept (a presentation vocabulary, a parse, a classification) is implemented by multiple independent sites, consolidate onto one pipeline with the variation as its parameter, and GUARD it (a registry test, a compiled-output assertion) so a new variant cannot be minted beside it.
- The mandatory unification target is the concept's whole pipeline: what must agree, agrees through one pipeline with a guard.
- Below that level, sharing any given function is a per-function judgment with no mechanical rule: share when sharing is easy and uncomplicating (or when consistency is itself the point); duplicate when a shared helper would accrete flags as its callers diverge. Not-DRY sometimes makes growth simpler than DRY.
- Only unify where divergence is user-visible or correctness-relevant. Incidental duplication that is clearer duplicated stays duplicated, and deliberate test oracles exist precisely to disagree.
- The unified pipeline itself follows `/no-invalid-states`: a discriminated union over the variants, not a flag soup a caller can mis-set. A "one pipeline" whose inputs can express nonsense states has traded N drift sites for one corruption site.

## Maintainability Over Effort

Future maintainability, adaptability, and code quality outweigh effort and diff size: choose the best solution even when it requires more effort or a larger refactor. Best also means simple - the cleanest design is the one with the fewest moving parts that still does the job, never the most elaborate one.

How to apply:

- When two approaches differ in effort but the harder one is cleaner, more reusable, or more maintainable, take the harder one without being asked. Never preserve a workaround to keep a diff small.
- When a constraint (linter, parser, legacy helper) forces awkward code, treat the constraint as the thing to fix. "Non-blocking" structural review findings get fixed, not filed.
- Prefer extracting or unifying duplicated logic over adding a parallel copy; derive vocabularies and registries from existing sources of truth rather than hand-maintained lists; design pure, dependency-free cores with injectable environments; use versioned formats for external contracts.
- Enforce invariants in the type system instead of repeated runtime checks (the `/no-invalid-states` skill: parse, don't validate; make illegal states unrepresentable).
- A larger refactor never licenses gratuitous complexity: delete old paths outright rather than keeping shims or dual code paths, and simplify what you touch.
- A big refactor is always better than a fix done the wrong way; a wrong-shaped fix compounds into tech debt that a later, larger cleanup must pay for.
- Use assertions to pin invariants the type system cannot carry: asserting an invariant at the boundary removes the downstream edge-case handling for states that can no longer occur.
- When an action is hard to undo (deletions, published or external actions, architecture lock-ins), stop and consult the user first, even mid-task.
