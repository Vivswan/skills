---
name: code-standards
description: Use when writing code changes, sweeping or shortening comments (including file-size or comment-cap findings), or asked to apply the code standards.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Code Standards

Standards for code and the artifacts around it. Apply them while writing. Check them while reviewing.

Readability and beauty come first. Every standard here serves them and yields where following it would read worse; the deviation is said in a line, never forced through.

This is a silver standard, not gold. Languages and tools move faster than this page: a newer version's more beautiful, more readable way of writing a thing wins even where the page has not caught up, and the page is brought up to it afterwards.

Each standard below is the rule in a few lines, with the specimen that set it where one exists. The `references/` page named under it carries the why, the how-to-apply list, and the boundaries. Load that page before acting on a standard's edge.

## The Standards

### Fix the class, not the instance

A systemic problem gets a root fix that makes recurrence impossible, never only a fix of the case at hand. The `/never-twice` skill owns the judgment and its response ladder. Full detail: `references/design.md`.

### Guard what passes the floor

A problem that passes the `/never-twice` floor's judgment ships with the highest reachable rung: a type or structure that makes the state impossible, else a test, tripwire, or pipeline fix (or a proposal to the user when the pipeline is out of reach), else a written rule recorded as debt. Full detail: `references/design.md`.

### General-purpose over special-case

Parameterize the axis that keeps changing instead of hardcoding today's instance, and give one concept one pipeline. Specimen: a safety classifier whose rulebook kept changing was built as a classifier factory with the rubric as an input. Full detail, including where DRY stops: `references/design.md`.

### Maintainability over effort

Code quality outweighs diff size and effort spent. A big refactor beats a fix done the wrong way, invariants live in types (the `/no-invalid-states` skill), and an assertion at a boundary pins what types cannot. Specimen: a documented workaround hybrid was reworked outright rather than kept. Full detail: `references/design.md`.

### Prefer a library over hand-rolling

Never hand-roll what a good library already does; a tool already in the repository counts: a declared direct dependency or its own code, never a transitive dependency, a library's private module, or a skill's script. The search happens before the first line and is recorded in the brief, then the PR body or landing report. A large library or an unclear fit is a question to the owner first.

Specimen: five CI scripts whose whole job a published package or `git diff --exit-code` already did. Full detail: `references/design.md`.

### Minimum standard for tests

A floor every test clears. A test asserts a whole outcome and answers "what would drift silently without this?" in its name or first line: an external fact, a cross-file consistency, or a named incident. A constant or a shipped file is the source and is never pinned to itself.

A guard test is seen failing on its bug. A deletion with no behavior of its own proves itself with a census, not a manufactured test. Fixtures are hand-authored, never recorded from real data.

Specimen: fifteen tests each asserting one key of a dict became one parametrized test pinning the whole dict, 81 test functions to 44, every guarded bug still caught. Full detail and the other specimens: `references/tests.md`.

### Comments carry only what the code cannot show

The reason a choice was made, an invariant another file relies on, an external system's quirk, a consequence invisible here, the input that motivated a guard. Never what the code does, its types, its control flow, its history, the alternatives.

Tell first, in one or two sentences, then show (aligned rows, an arrow flow) only when a block is faster. Never pack prose to fit a cap: cut honestly. Before writing or keeping one: what does this say that the code does not, and could a tired human read it in one pass?

On a variable, a field, or a constant, the comment is one line above the item, never more; what needs more goes into the name or a short tell above the group. Once one field of a record or one constant of a block carries a comment, every one does. Specimen: a record with one three-line comment over three fields and four fields bare. Specimens, the TODO ban: `references/comments.md`.

### Heal at the boundary, or refuse there

Malformed state with one unambiguous repair is repaired at the boundary and reported; with no repair or several, it is refused there. What the tool only reads is refused, what it outputs is healed toward what the user declared, and nothing malformed passes through to fail later. Full detail: `references/design.md`.

### Code reads beautifully, top to bottom

Code always looks beautiful and reads once. A module reads top to bottom with nothing to scroll back for, and a function reads as the list of its steps. Everything below this heading is a default, not a law: the case decides, a deviation that reads better stands, and a reviewer who flags one says what would read better.

- **Module:** imports, every constant in one block (caches included), types, then functions. A function sits above its callers, so the entry point is the last definition. Where that order cannot be had or reads worse, readability wins and the deviation is stated. A section separator marks a small bounded group only: a module that wants sections is two modules.
- **Function:** one concept each, nameable in a few words, long when the concept is long. Guards first, each its own paragraph and never counted as a second concept; an early return with the body unwrapped after it; a loop that `continue`s instead of nesting.
- **Split, or fold:** two nameable things split into named steps, and a step called from one place that is no concept of its own folds back into its caller. A complexity lint is the backstop, raised with a reason or split, never silenced inline, and never set tighter than the language page's floor.
- **Line:** no ugly one-liners (nested conditionals, conditional splices, first-match lookups, assignment in a condition, `and`/`or` as control flow). One computation per line under a plain-noun name; named arguments once three values share a type; cleanup bound to its acquisition (`with`, `defer`, `Drop`, `using`).
- **Body:** blank lines after the setup, between decisions and branches, before the return; none inside an `if` and its single consequence.
- **Members:** once a record's members carry comments, a blank line between every member, commented or not, and around a commented constant or variable, so each stands alone; bare members that read whole stay together.
- **Surface:** every signature typed; a doc comment on every public item saying what it returns and what the arguments mean, never a narrative of its behaviour; no underscore-prefixed names, module level or attribute, beyond the language's own visibility, except on what the module's user must never touch (the value behind a property and its setter, a framework-fixed hook).

Specimen, the body that set the paragraph rule:

```python
key = (video_key(video), audio_sig(video), model)

if key not in SEGMENTS:
    cache = cache_file(video, model)
    segments = read_cache(cache)

    if segments is None and window is not None:
        return with_min_words(transcribe_window(video, model, window), min_words)

    if segments is None:
        segments = run_asr(full_audio_wav(video), model, offset=audio_start(video))
        write_cache(cache, segments)

    SEGMENTS[key] = segments

segments = SEGMENTS[key]
if window is not None:
    segments = within_window(segments, window)

return with_min_words(segments, min_words)
```

The rules and their specimens: `references/shape.md`. The lint floor and the idioms per language, and the Python order checker: `references/languages/`.

### No barrel files or pass-through functions

Delete an import-only index, a "keep old importers compiling" re-export, and a function whose whole body forwards to another. Repoint the importers or callers at the defining module. A wrapper earns its existence only by adding something real: a default, a conversion, error mapping, an injected dependency, a narrowed type.

A confusing layout is the same defect one level up. A predictable one names each file after its main public thing and keeps its helpers beside it, gives every sibling in a folder the same internal template, and repeats file names across sibling stages, so a reader knows where a thing sits before opening it. Not sure where a thing goes: ask the user, with options.

A stage's records, constants, and small functions gather in its `records`, `constants`, and `util` modules, and a package that fits one module is one module. A module named after its main thing may hold that thing alone; the defect is a helper of one caller, or a constant, given its own module outside those three.

Specimen: one sweep split a tree into 269 modules, among them a file holding a single format-conversion helper and another holding a default layer list.

A file per function is the same defect from the other side: a file holds one concept with its helpers, as a function holds one concept with its steps.

Any file may move, a pure move is its own PR with an export census and an equal test count, and a whole-repo reorganisation is proposed as a target layout first. Full detail: `references/structure.md`; the barrel in each language: `references/languages/`.

### No planning references in code

Code and comments never reference planning artifacts: work-package names, spike or phase labels, plan codenames, audit finding numbers. Specimen: a comment opening "WP-B spike, part 2:" means nothing outside the plan. Full detail: `references/comments.md`.

### Lean AGENTS.md

AGENTS.md (and CLAUDE.md) holds the project's guiding principles and nothing an agent can deduce elsewhere: what the project is, the conventions the owner wants kept, safety constraints, toolchain entry points, pointers. Anything a specific file answers is cut to a one-line pointer, and no test pins the text. Specimen: a 66-line tail became 15. Full detail: `references/artifacts.md`.

### Commit messages carry content only

What changed and why, in the repo's subject conventions. No AI or tool attribution, no hard wrapping of the body, no PII (the `/pr-and-issue-discipline` skill's rule). The one sanctioned attribution is human community credit. Full detail: `references/artifacts.md`.

### Hooks check, never commit

A pre-commit hook checks what the developer staged and reports: check and fail, or check, write the fix into the working tree, and still fail. It never stages, commits, formats-and-restages, runs a writing git command, reaches the network, or installs anything. Full detail and the specimen: `references/artifacts.md`.

### No blobs of text

Anything a human skims uses scannable structure: paragraphs of 1 to 3 sentences, and when the content is enumerable, enumerate it. The shape rules and the paragraph probe live in the `/working-text` skill; PR bodies follow the `/pr-and-issue-discipline` skill. Prose inside a code artifact (an action description, CLI help) follows the `/working-text` page rules.

## Workflow

1. **Writing code:** apply the standards as you go. They are cheaper at write time than at review time. Readability and beauty come first: where a standard would read worse here, break it and say so in a line.
2. **Writing a test:** before creating a test file or adding a case, write its drift answer (an external fact, a cross-file consistency, a named incident) as the name or first line. No answer, no test.
3. **Reviewing:** check the Review Criteria, cite the specific standard in each finding, and prefer suggesting the class fix over the instance patch.
4. **Boundaries:** when a standard needs its boundaries (what counts, what is exempt, how far to take it), load the matching `references/` page before acting on it.
5. **Type-level fixes:** when a finding calls for enforcing invariants in the type system, apply the `/no-invalid-states` skill for the refactor itself.
6. **Conflicts:** when a standard conflicts with an explicit user or project decision, follow the decision and record which standard was consciously set aside.

## Review Criteria

- Instance-only fixes, once the problem passes the `/never-twice` floor's judgment: does the change prevent recurrence (test, type, tooling), or just patch the case at hand?
- A problem past the `/never-twice` floor's judgment fixed again without the highest reachable rung: a type or structure, a test, tripwire, or pipeline fix, a proposal to the user when the pipeline is out of reach, or, when none is possible, a written rule recorded as debt.
- Tests that assert only a shape, a type, or that something exists.
- Hand-written test functions that differ only along one input axis and should be one parametrized case list.
- A guard test never seen failing on the bug it guards.
- A check for a failure that is already loud without it or that the toolchain fixes itself, or a silent failure the project depends on left untested as "it would fail anyway".
- A new test that restates the source it reads (a workflow test pinning `needs` to the list in the yaml, a constant pinned to its own literal, a shipped config file parsed and asserted back), or whose name or first line does not say what would drift silently without it.
- A test manufactured for a deletion with no behavior of its own in place of a census in the PR body or landing report.
- A fixture recorded from real data, a provenance comment saying so, or a tool that measures real data with a default output path or one inside the repository.
- Special-casing: a new near-copy of existing logic where the varying axis should be a parameter.
- Complexity added to keep a diff small: flags, nesting, or repeated checks where a cleaner refactor or a stronger type was available (the `/no-invalid-states` skill covers the type-level fix).
- Hand-rolled code, added, moved, touched, reused, or depended on, whose whole job a good library or a tool already in the repository does; the finding names the library and what it covers. A change in a library-shaped category whose record (the brief, then the PR body or the landing report) names no library and no search.
- A skill's script copied into a repository, or a library finding that counts a transitive dependency or a library's private module as already in the repository.
- Comments that say what the code shows: what it does, its types, its control flow, its history, the alternatives.
- Comments a reader cannot take in one pass: uniform shape (a paragraph, or every fact as its own line with nothing shown past a two-sentence tell), several ideas in one sentence, prose packed to fit a cap.
- A comment on a variable, field, or constant over one line, a record or constants block where some items carry a comment and others none, members of a commented record running together, or a commented constant or variable not spaced out from its neighbours.
- Paragraph-long comments justifying workarounds (flag the underlying code, not the comment alone).
- A boundary that refuses state the tool outputs and could repair unambiguously, repairs input the tool only reads, or lets malformed input through to fail later; a healing step whose comment argues instead of stating the rule.
- A module constant below the first function, a function above one it calls, a section separator where a split was due, a function holding two nameable concepts, a one-caller step that is no concept of its own kept out of its caller, a complexity finding silenced inline instead of split or raised at config level with its reason, or a lint cap tighter than the language page's floor.
- A nested conditional expression, a conditional splice, a first-match lookup where a keyed table reads once, an assignment inside a condition, `and`/`or` as control flow, a guard's body wrapped in an `else`, a loop nesting what a `continue` would skip, or a hand-written cleanup block where the language binds cleanup to the acquisition.
- A body with no blank line between its decisions, an untyped signature, a public item without a doc comment in the language's form, a docstring over three short paragraphs or narrating behaviour instead of stating what the function returns, or an underscore-prefixed name, module level or attribute, on what the module's user may touch.
- Barrel files, re-export shims, or pass-through functions that only forward to another function or module.
- A file holding two main things, a concept scattered over several files, or a file named unlike the one it holds, a helper of one caller or a constant given its own module outside the `records`, `constants`, and `util` modules, a sibling whose internal template differs from the folder's, or a concept spelled differently across sibling stages.
- A move that leaves a path it changed unrepaired (an importer, a workflow or manifest path, a comment, a relative path inside the moved file), that edits the moved code beyond its paths in the same PR, or that lacks the export census and test count; a confusing layout kept because moving files is "churn".
- Planning artifacts (work packages, phases, codenames, finding numbers) referenced in code or comments.
- AGENTS.md or CLAUDE.md carrying anything deducible from the code or another doc (layout trees, enforced checklists, module behavior), a long paragraph, or a test that pins its text.
- Attribution lines or hard-wrapped bodies in commit messages and PR descriptions.
- A pre-commit hook that does anything beyond check-and-fail or check-write-the-fix-and-fail: staging, committing, a writing git command, fix-then-pass, network, an install or tool fetch.

Triage findings against the standards above. Each criterion maps to one. The shape and layout criteria are defaults: a finding there names what would read better, and a deviation the author can defend in a line stands.

## References

Cross-language standards, one page each:

- `references/design.md`: fix the class, guard the floor, general-purpose over special-case (one pipeline per concept, DRY boundaries), maintainability over effort, prefer a library, heal at the boundary
- `references/tests.md`: the minimum standard for tests, the drift question, proving a guard test, the census rule for deletions, hand-authored fixtures
- `references/comments.md`: what a good comment carries, tell then show, the one-line rule for variables, fields, and constants, the two-question test, the specimens, the TODO ban, planning references
- `references/shape.md`: module layout, define before use, one concept per function, guards and early exits, the ugly-to-clear table, the paragraph specimen, members standing alone, types and docs
- `references/structure.md`: barrels, compatibility re-exports, escort functions, migration staging, the predictable layout and its specimen tree, the pure-move PR and the target layout for a reorganisation
- `references/artifacts.md`: lean AGENTS.md, content-only commit messages and their two exceptions, hooks that check and never commit

How the shape and barrel rules land in each language, with its lint floor and idioms:

- `references/languages/python.md`: the ruff block, the order checker, `__all__`, `with`, Google docstrings
- `references/languages/typescript.md`: the biome block, `no-use-before-define`, options objects, `using`
- `references/languages/rust.md`: the clippy thresholds, `let ... else`, `Drop` guards, `mod.rs`
- `references/languages/go.md`: the golangci-lint block, `defer`, options structs, the package as the unit
