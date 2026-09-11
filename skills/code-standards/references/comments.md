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
- Lines stay at or under 100 characters; formatters do not reflow comments. A fact that runs longer continues on the next line, split at a clause boundary; two facts never share a line to fit.
- Never shorten a block by packing prose to the line width. A wall of text that fits the cap is worse than the original; a `comment-cap: ignore` marker on a packed block is the worst of both.
- Usual length: one to three lines. Ceiling: 10 lines per block and 25 for a file header, the numbers the fleet's file-size check warns at.
- Text that is not the author's to shape (a license header, an upstream-shaped block) is exempt from the ceiling; mark it the way the check accepts, a `comment-cap: ignore <reason>` line inside the block. Nothing else is marked: a block still over the cap after honest cutting is reported to the lead.
- A reader skims it and gets the point; a comment that needs a second read is rewritten.

## The test

Before writing or keeping a comment, ask two questions:

1. What does this say that the code does not?
2. Could a tired human read it in one pass?

Fail either: rewrite or delete. A wholly redundant comment is deleted, not compressed. A comment that buries one real constraint in narration keeps only the constraint.

## Specimens

**A header above a regex**, before and after, is in `SKILL.md` under this standard. What changed:

- The opening sentence described the regex, which the code shows; it is gone.
- Each remaining fact is one sentence the code cannot show, with its reason attached; the third continues onto a second line at its colon.
- The reader skims separate facts instead of untangling one wrapped paragraph.

**A rules list, 28 lines to 8 facts.** The doc comment on a field holding a server-reported capability baseline; every AFTER line was checked against the code through five review rounds.

```text
BEFORE, one wrapped paragraph across 28 lines:
/**
 * The server-reported capability baseline of one registered entry: the walk's
 * server-level input, carried on PreAttachModelInfo.litellm.serverDeclared.
 * Two separate facts ride here. The VALUES are the conservative aggregation
 * results exactly as registration advertises them, present whenever ANY
 * contributor reported the field - so a lower-precedence catalog guess can
 * never displace a conservative server minimum, while a field no contributor
 * reported stays absent and lets the catalog fill it. `outputDeclared` is the
 * stricter every-contributor rule and controls only whether the output limit
 * bypasses the request-side cap.
 *
 * max_input_tokens is present whenever ANY numeric limit was reported, not
 * only max_input_tokens itself: the collapse fills a missing input limit from
 * the reported context and output limits, and that server-grounded number is
 * what registration advertises - re-deriving it from the collapsed context and
 * output can overstate it, because min(ctx_i - out_i) undercuts min(ctx) -
 * min(out). Boolean fields count as reported when any contributor carried the
 * explicit flag (or, for reasoning, the supported-params list); modality flags
 * count as reported when the server supplied a modality array at all, an
 * accepted conflation of "reported false" with "unreported". The
 * prompt-caching and response-schema flags hold only when every contributor
 * advertises them, so the baseline can never say more than the entry
 * advertised; the supported-params and reasoning_effort_levels lists are each
 * present only when every contributor carries one and hold their
 * intersection; costs appear only for pricing-eligible shapes, and only the
 * costs the server declared - discovery's serverCostsOf already mapped the
 * 0/0 no-pricing stamp to undefined at ingest.
 */

AFTER, one complete sentence per line:
/**
 * ANY contributor's report keeps a limit or flag FIELD present.
 * Its VALUE is registration's conservative aggregate, exactly as advertised.
 * So a catalog guess never displaces a server minimum, and unreported fields stay absent for it.
 * The two string lists are present only when EVERY contributor carries one.
 * Costs are present only for pricing-eligible shapes, so aggregates omit them even when reported.
 * outputDeclared is the stricter every-contributor rule and gates only the request-side cap.
 * max_input_tokens counts as reported when ANY limit was, since re-deriving it can overstate it.
 * A modality array marks all modality flags reported, conflating false with unreported on purpose.
 */
```

What went, and why:

- The opening sentence named what the field is; its type shows that.
- The min(ctx_i - out_i) derivation; a derivation belongs in the commit message.
- The stamp mapping done by another function; that function's own doc states it.
- The per-flag narration; the body's `some(...)` calls show it.

Two traps the review rounds caught in earlier rewrites, both compression changing the truth:

- "can overstate" had become "overstates"; a hedge the code justifies is a fact, not padding.
- "present whenever ANY contributor reported" had swallowed the exceptions (the two string lists need every contributor; costs need a pricing-eligible shape); a rule with exceptions keeps them or is wrong.

After compressing, check each remaining sentence against the code, as the two-question test asks; shorter is never allowed to be less true.

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
- Run these checks explicitly in every pre-commit review pass (see the `/rubber-duck-review` skill).
- Hand a subagent that writes or sweeps comments this file and the SKILL.md section by path, and tell it to read both first. Never a paraphrase: a lead's paraphrase is where the rule inverts. One lead's version read "prefer one dense paragraph over bullets", and six agents produced packed walls of text with markers on top.
- When sweeping a whole repo, skip generated files and symlinked files.
