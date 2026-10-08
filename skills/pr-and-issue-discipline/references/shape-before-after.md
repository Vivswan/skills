<!-- /pr-and-issue-discipline shape: existing behavior change or bug fix.
Copy this file as is into .github/PULL_REQUEST_TEMPLATE/; the comments vanish when the body renders.
Use it when something runs and its output or its flow moved. The filled example sits under the rule at the end. -->

## Before

<!-- the flow as it ran: plain ASCII, arrows between steps, a branch on its own indented line; only when the flow moved -->

```text
step -> step -> step
```

<!-- the real captured output, complete enough to stand alone; only when the output changed -->

```text
$ command
output as it was
```

## After

<!-- the same order: the flow as it runs now, then the real output now; each block only when that facet moved -->

```text
step -> step -> branch? -> yes: step
                        -> no:  step
```

```text
$ command
output as it is now
```

## How

<!-- 3 to 6 bullets, one sentence each, about 15 words, a bold lead-in; the mechanism, never the flow again.
When the diff touches a library-shaped category, the last bullet is **Library:** package, covers what (or: searched where; none fits because) -->

- **...**
- **...**
- **...**

## Proof

<!-- 2 to 4 bullets: focused tests or stable checks, latest totals only; never one line per review round -->

- **Tests:** ...
- **Gate:** ...

<details>
<summary>Technical details</summary>

<!-- one fact per line, for a bot reviewer or the next agent; nothing part one already says.
In a release-please repository the commit-override block is the last element here. Delete this section when there is no such detail. -->

- **...**

</details>

---

When neither the output nor the flow moved (a pure refactor), the opening is one section, `## What this changes`, with the block that shows it, and the two state sections go.

Filled, from a sweep script whose probe killed agents mid-build:

````markdown
## Before

```text
probe start -> fixed 120s -> timeout -> agent marked dead (mid-build)
```

```text
$ bun run check
scripts/sweep.mts: probe timed out after 120s; agent marked dead (it was mid-build)
```

## After

```text
probe start -> 120s up -> build lock held? -> yes: extend to 300s -> live verdict
                                           -> no:  120s verdict
```

```text
$ bun run check
scripts/sweep.mts: probe extended 120s -> 300s while the build lock is held; agent alive
```

## How

- **The lock read is one non-blocking `flock` probe,** so an unheld lock costs nothing.
- **The verdict is written once,** after the extension decides, so a caller never sees dead then alive.
- **Library:** the runtime's own one-call file lock, covers the build lock.

## Proof

- **Tests:** 34 green (2 new).
- **Gate:** `bun run check` green.

<details>
<summary>Technical details</summary>

- **Reviewer note (Copilot):** the 300s ceiling is a constant in `scripts/sweep.mts`, not a flag.
- **Refused: `--probe-ceiling`.** No second caller exists.
- **Proof detail:** one new test pins the extension while the lock is held, the other the plain 120s verdict without it.
- **Files:** `scripts/sweep.mts` (the probe), `tests/sweep-script.test.ts` (the two cases).

BEGIN_COMMIT_OVERRIDE
fix(sweep)!: extend the probe while the build lock is held

BREAKING CHANGE: `--probe-timeout` is removed; the probe extends itself while the build lock is held.
The probe's dead verdict can arrive up to 300s after start instead of at 120s; callers that raced it must re-read.
END_COMMIT_OVERRIDE

</details>
````

The block closing the details section is the commit-override rule at work (`references/release-please.md`): this specimen's merge carries two breaks, so one `BREAKING CHANGE` footer lists them on two lines.
