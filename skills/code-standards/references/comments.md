# Comment Standards: Full Detail

A comment is written for humans and agents, and a human reads it first. It carries only what the code cannot show, in a shape a reader takes in one pass. The code is the single source of truth.

## What a good comment carries

Only what the code cannot show. The kinds:

- The reason a choice was made when the obvious choice was rejected.
- An invariant another file relies on; name that file.
- An external system's quirk, with what breaks without the workaround.
- A consequence of changing the line that is not visible here.
- The one input that motivated a guard.

Never a comment: what the code does, its types, its control flow, its history, the rejected alternatives, the derivation. History, alternatives, and derivations belong in the commit message. What another function does belongs in that function's own comment.

## Tell first, then show

- One or two sentences say what the code cannot show. That is the whole comment when nothing more is needed.
- A block follows only when it shows the fact faster: an arrow flow for a sequence (`re-derive -> read credentials -> re-derive again -> must match`), aligned rows for facts that share a shape (`input  -> outcome`). Nothing else is mandated.
- Combine as the spot needs; a blank comment line separates the parts. One carrier per point: rows followed by prose re-explaining them mean the rows failed.
- Uniform shape is the wall. A paragraph fails; so does a stack of sentences or fragments one per line, however true each line is.
- A paragraph that has grown holds narration (delete it) or a workaround defense (fix the code, not the comment).
- No limits here: length and width caps are the fleet's file-size check. Never pack prose to fit a cap; a wall under the cap is worse than the original, and a marker on a packed block is the worst of both. Cut honestly; a block still over the cap after that is reported to the lead.

## The test

Before writing or keeping a comment, ask two questions:

1. What does this say that the code does not?
2. Could a tired human read it in one pass?

Fail either: rewrite or delete. A wholly redundant comment is deleted, not compressed. A comment that buries one real constraint in narration keeps only the constraint. After compressing, check each remaining fact against the code; shorter is never allowed to be less true (one rewrite turned "can overstate" into "overstates").

## Specimens

Real blocks, before and after.

**A stack of one-fact sentences, to tell then rows.** Eight lines, each true, each its own sentence: a wall read in lines.

```ts
/**
 * This is the ONE "entry uses this credential field" judgment, mirroring parseGroupConfiguration.
 * This judges the ENTRY alone, so a caller with just a value's existence errs toward "uses it".
 * narrowVirtualKey also drops a header-value-illegal virtual key, which needs the value in hand.
 * The wire narrowing still drops what cannot ride, so consumers gate refusals, never the send.
 * resolveOwnedSecrets' refusals gate the secretsMismatched skip, usage probe, and MCP's resolve.
 * A resolved Authorization-named header skips the OAuth exchange.
 * A resolved X-API-Key-named header owns that carrier.
 * The entry cannot show a value resolving, so a declared header lowers no other field's judgment.
 */
```

```ts
/**
 * The ONE "entry uses this credential field" judgment; it judges the ENTRY alone, so it errs toward "uses it".
 * Wire narrowing still drops what cannot ride, so consumers gate refusals, never the send.
 *
 * Authorization-named header resolved  -> skips the OAuth exchange
 * X-API-Key-named header resolved      -> owns that carrier
 * declared header, value unknown       -> lowers no other field's judgment
 */
```

Two lines described what other functions do; their own comments carry that. Three facts shared a shape (a resolved header, its effect) and became rows.

**Narrated control flow, deleted.** Every sentence described a branch the function body shows; nothing here was a reason, an invariant, or a quirk.

```ts
/**
 * Parse a reply into title and description. Noise-only lines never hold or
 * block the title. The title label may sit on any of the first
 * TITLE_SCAN_LINES content lines (preamble before it is dropped unless it
 * carries the description); a blank labeled title takes the following content
 * line. Without a title label, the first content line is the title.
 * Everything after the title is the description, with a description label
 * stripped only when it is the remainder's first content line - later
 * label-looking lines are content and are kept. A title that still came out
 * blank takes the description's first line. A blank description is
 * `undefined`; no usable title at all is the empty variant.
 */
```

```ts
// (nothing: the comment is removed; the function signature and body carry all of it)
```

**A wrapped paragraph, to tell then rows.** From this repository's test launcher.

```ts
// A run of zero tests must fail HOWEVER it was reached: bun exits 1 when no
// test file matches, but exits 0 with "Ran 0 tests" for --pass-with-no-tests
// and for --only with no .only test - a vacuous green from a test launcher.
// ANSI color sequences are stripped first (under FORCE_COLOR bun wraps the
// summary's timing bracket in SGR codes, which would hide a genuine summary
// and fail a passing run). The match is anchored to a full line-start
// summary with bun's timing suffix, and the LAST one wins: bun echoes CLI
// values mid-line in its own diagnostics (-t "Ran 1 test across 1 file. [x]"
// appears inside an "error: regex ..." line), so an unanchored search could
// be spoofed into seeing tests that never ran. A missing summary on exit 0
// fails too, so a bun wording change breaks loudly here instead of silently
// disarming the guard.
```

```ts
// bun exits 0 with "Ran 0 tests" under --pass-with-no-tests and --only, so a zero-test run must fail here.
// The summary match is anchored at a line start: bun echoes CLI values mid-line ("Ran 1 test across 1 file. [x]" inside an error line).
//
// FORCE_COLOR wraps the timing bracket in SGR codes  -> stripped first, or a green run would fail
// several anchored summaries                         -> the LAST is the run's
// no summary on exit 0                               -> fails, so a bun wording change breaks loudly
```

The two sentences carry why the guard exists and why the match is anchored; the three rows pair each hazard with its handling.

## No comment-justified workarounds

If it takes a paragraph-long comment to justify why a workaround is OK, the code is wrong: fix the code, even when that takes a bigger refactor (see `references/design.md`, Maintainability Over Effort).

A long rationalizing comment is the smell that a cleaner design exists; adopt it outright and delete the old path rather than shimming around it. A comment documenting a genuinely external, unavoidable constraint is fine, in the shape above.

## No TODO comments, ever

A TODO/FIXME/XXX/HACK marker is deferred work hiding in the code: either DO the work in the same change, or SURFACE it to the user (a task, an escalation in the completion signal); never park it in a comment. Sweeps treat existing TODO markers as work items to resolve or surface, not text to compress.

## No planning references in code

Code and comments never reference planning artifacts: work-package names, spike part numbers, plan codenames, audit finding numbers, or "temporary per plan" markers. Plan-internal labels are meaningless to future readers; comments describe purpose and constraints, not where the code came from. Commit messages may reference the change itself but not internal plan codenames.

## How to apply

- Run the two-question test before writing a comment and before keeping one you meet.
- Shape every comment you keep: tell, then show only when a block is faster.
- Treat any multi-line comment defending a hack, special case, or fragile assumption as a signal to redesign that code until the comment becomes unnecessary.
- Run these checks explicitly in every pre-commit review pass (see the `/rubber-duck-review` skill).
- Hand a subagent that writes or sweeps comments this file and the SKILL.md section by path, and tell it to read both first. Never a paraphrase: a lead's paraphrase is where the rule inverts. One lead's version read "prefer one dense paragraph over bullets", and six agents produced packed walls of text with markers on top.
- When sweeping a whole repo, skip generated files and symlinked files.
