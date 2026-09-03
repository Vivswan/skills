# Tests

Full detail for the **Minimum standard for tests**.

This is a floor, not a ceiling. It says nothing about which kinds of tests to write: unit, property-based, fuzzing, integration, and end-to-end tests all have their place. It says what every test, of any kind, must at least do.

## Why

Agents write many small tests because each one is easy to justify in isolation. The result is a suite that is long, slow to read, and weaker than its size suggests: fifteen tests that each assert one key of a returned dict all pass while a sixteenth field silently regresses.

The reviewer's phrasing that set this rule: *"Please make sure to write few but strong tests. Claude/GPT tend to write a lot of small weak tests."*

## What counts as weak

Delete or fold these:

| Pattern | Why it is weak |
|---|---|
| `assert result.shape == (3, 4)` and nothing else | passes for any wrong values of the right shape |
| `assert isinstance(x, Foo)` and nothing else | the constructor already guaranteed that |
| `assert grad is not None` | existence is not correctness; if there is no custom gradient, delete the test |
| `assert output.dtype == dtype` as its own test | assert it inside the test that checks the values |
| five tests differing only in an input value | one parametrized case list |

A shape or dtype claim is not forbidden; it is forbidden *as the whole test*. Move it into the correctness test that also compares values.

## What strong looks like

- **Assert the whole outcome.** Compare the entire returned dict, the entire frame, the full selection, not one key. A test that ignores a column cannot catch a regression in it.
- **Parametrize the axis that varies.** When hand-written cases differ only along one input axis, one case list replaces five near-identical functions. Give each case an identifier and, where the reason is not obvious from the values, a reason string in the assertion message, so a failure names the case and the next reader knows why it exists.
- **Reuse the repo's existing harness.** If there is already a comparison helper for the thing being tested, use it rather than hand-rolling the plumbing.

## Prove the test

A guard test that has never failed is not yet evidence. This is the `/verify-with-controls` rule (*a checker that has never been seen failing proves nothing when it passes*) applied to a test suite. Before claiming a test covers a bug, show it failing on that bug through the same assertion path its green run takes. Reintroducing the bug is the standard form:

1. Reintroduce the bug in the source (or make the equivalent one-line change).
2. Run the test and confirm it fails.
3. Confirm it fails *for that reason*, not on an unrelated error.
4. Restore the source and confirm green again.

A red run against the pre-fix revision, or a mutation of the code under test, is the same control by another route. A test that was only ever run green is not.

This catches the two ways a control goes vacuous: an assertion that holds regardless of the behaviour, and an assertion whose input already contains the answer.

Specimens, both caught this way:

- A floor test asserting `harmless >= 40` passed under `Balanced` allocation too, which gives ~100, so it did not discriminate the rule it was written for. The fix was asserting a band (`40 <= harmless <= 60`) that fails under both `Proportional` and `Balanced`.
- A propagation test asserted that a flag reached a loader, but the test passed the flag in itself. It would have passed with the propagation removed.

## Boundaries

- **Distinct scenarios are not duplicates.** Five tests that look alike but cover five different short-circuit paths stay five tests; folding them behind a setup callable hides what each one covers. Fold on *shared shape with a varying value*, not on superficial resemblance.
- **Parametrized case count is not test count.** The rule targets weak assertions and duplicated functions, not the number of cases a table drives.
- **Whole outcome means the outcome under test.** Pin the full result the test exists to check, not every incidental detail around it. A snapshot of unrelated fields is brittle, not strong.
- **Dropped coverage needs a successor or a recorded reason.** If consolidation drops a path, either a remaining test still covers that failure class, or the change says which path was cut and why (the `/never-twice` rule on deleting a guard). Never let the count improve quietly.
