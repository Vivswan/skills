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
| `expect(job.needs).toEqual(["lint", "test"])` after reading the workflow that says so | restates the source; it changes in the same commit, so nothing drifts under it |
| `expect(DEFAULT_HOME).toBe("~/.local/share/app")` | the constant is the source of the value; the test restates it and grows with every new constant |

A shape or dtype claim is not forbidden; it is forbidden *as the whole test*. Move it into the correctness test that also compares values.

## What strong looks like

- **Assert the whole outcome.** Compare the entire returned dict, the entire frame, the full selection, not one key. A test that ignores a column cannot catch a regression in it.
- **Parametrize the axis that varies.** When hand-written cases differ only along one input axis, one case list replaces five near-identical functions. Give each case an identifier and, where the reason is not obvious from the values, a reason string in the assertion message, so a failure names the case and the next reader knows why it exists.
- **Reuse the repo's existing harness.** If there is already a comparison helper for the thing being tested, use it rather than hand-rolling the plumbing.
- **Give a shared outcome shape one helper.** When several tests check the same shape (exit code plus complete output; error class plus message), a small helper that asserts the whole shape makes strength the default for the next test; a pointwise fix to one test invites the next weak one. Observed: every one of 16 files got the same partial-assertion finding at one landing gate, and three of them independently wrote the same helper.

## The drift question

Every test answers "what would drift silently without this?" in its name or first line. Three answers count:

| Answer | Example |
|---|---|
| An external fact the platform does not enforce for us | every PAT-reading job declares its `environment`; `secrets: inherit` sits on exactly the callers whose call reaches an environment job; an absent step output expands to the empty string, which a numeric comparison reads as `0` |
| A cross-file consistency the source cannot express | the codex manifest's `shortDescription` equals the `interface.short_description` in `agents/openai.yaml` |
| A regression with a named incident | the empty manifest that passed validation vacuously |

"The source says so" is not an answer. A test that restates what it read is edited in the same commit as the source, so nothing can drift under it; it is deleted, in the PR that notices it, and a reviewer asking for one is declined with this rule.

### A constant is the source

A test of a single constant, or of a variable that is itself the source of its value (a default, a key name, an argv literal, a path), is the same restatement one hop closer. The literal sits once in the source and once in the test, and every new constant invites a new one.

Pin the value where it leaves the program instead: the bytes written to a file, the line printed, the request sent. Do it only when that boundary is an external contract (a path a user's shell reads, a flag the README documents, a wire format a peer parses). A value that never crosses such a boundary gets no test of its own.

```ts
// DELETE: the constant is the source; this line changes with it
expect(DEFAULT_HOME).toBe("~/.local/share/app");

// KEEP: the installer wrote there, and the user's shell reads it from there
await runInstaller({ env: { HOME: home } });
await expect(readFile(join(home, ".local/share/app/env.sh"), "utf8")).resolves.toBe(expectedEnvFile);
```

The KEEP test fails when the default changes, when the installer stops writing the file, or when the content drifts, and the assertion owns each failure (a bare `await readFile` would reject upstream of it, which Prove the test below rules out). The DELETE test fails only when someone edits the constant, and they edit the test in the same keystroke.

Specimen: a test audit of an installer removed the `DEFAULT_HOME` pin and replaced it with this read-back.

Specimen: eleven PRs landed in one day on a repository of GitHub Actions workflows, and their builders shipped shape tests that restated the yaml: a census asserting no workflow sets `cancel-in-progress: false`, a pin that a job's `needs` equals the list in the file. Four pressures produced them, each with its answer:

- briefs demanded red-then-green for EVERY change, deletions included, so a test was manufactured to have something go red: the census rule below
- reviewers defaulted to "add a regression test" and nobody asked what it pinned: the standing question in the `/rubber-duck-review` reviewer prompt
- the line-accounting gate read `tests +0` as a question: the `/pr-landing-discipline` skill's census clause
- no deletion norm existed, so tests only accumulated: the question above, applied to every test at review time

## Deletions: census, not test

Red-then-green is for behavior changes: a fix or a feature has a behavior to see red first, and a fix made by deleting code (a faulty early return removed) is a behavior change like any other. A deletion with no behavior of its own (an unused setting, a dead path; removing a deploy step is a behavior change) has nothing to see red, so it proves itself with a census: the grep that counts the removed thing, run before and after at the same path. The census goes in the PR body, or in the landing report when the change lands by direct push with no PR.

```markdown
## Proof

- **Census:** `grep -rl 'cancel-in-progress: false' .github/workflows | wc -l`, 3 before, 0 after.
```

The before count is the control: a nonzero count at the same path proves the grep reaches the files, so the zero after is evidence and not a mistyped path (the `/verify-with-controls` rule). A test written so the deletion has something to turn red restates the source and is not written. A test deleted under the drift question records "restated the source" as its reason; that satisfies the dropped-coverage rule under Boundaries.

## Prove the test

This proves a test that exists for a behavior; it does not ask for a test on every change (Deletions, above).

A guard test that has never failed is not yet evidence. This is the `/verify-with-controls` rule (*a checker that has never been seen failing proves nothing when it passes*) applied to a test suite. Before claiming a test covers a bug, show it failing on that bug through the same assertion path its green run takes. Reintroducing the bug is the standard form:

1. Reintroduce the bug in the source (or make the equivalent one-line change).
2. Run the test and confirm it fails.
3. Confirm it fails *for that reason*, not on an unrelated error.
4. Confirm the mutation reached the assertion you added or changed. A mutation that throws upstream of every `expect` fails the old test just as well and proves nothing about the new one (observed: breaking a default path threw before the new assertion ran; the red run looked right and was not).
5. Restore the source and confirm green again.

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
