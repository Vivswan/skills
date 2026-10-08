<!-- /pr-and-issue-discipline shape: measured change.
Copy the part above the horizontal rule into .github/PULL_REQUEST_TEMPLATE/; the comments vanish when the body renders.
Use it when the change is read rather than run and its effect is measured by an evaluation. A Before/After of one run's output
would be a shorter string nobody can act on; the reader needs the problem, the fix, the reasoning, and the measured result.
Part one runs to about 200 words. The filled example sits under the rule at the end. -->

## Problem

<!-- two or three sentences, the one prose opening: what went wrong, as the evaluation saw it -->

...

## Fix

<!-- the flow before and after, one text block, plain ASCII, arrows between steps -->

```text
before: step -> step -> step
after:  step -> changed step -> step
```

## Reasoning

<!-- 3 to 4 bullets with a bold lead-in: why this change should move the behavior, since the fix alone does not say.
When the diff touches a library-shaped category, the last of them is **Library:** package, covers what (or: searched where; none fits because) -->

- **...**
- **...**
- **...**

## Results

<!-- a measured before/after table; a cell not yet measured says "not yet" and why -->

| Metric | Before | After |
| --- | --- | --- |
| ... | ... | ... |

<!-- one footer line: the judge, the runs, the aggregation -->

Judge: ..., N prompts, N runs each, mean.

## Proof

<!-- 2 to 4 bullets, usually the tests and the gate, latest totals only -->

- **Tests:** ...
- **Gate:** ...

<details>
<summary>Technical details</summary>

<!-- one fact per line, for a bot reviewer or the next agent; nothing part one already says. Delete the section when there is no such detail. -->

- **...**

</details>

---

Filled, from a router that rendered its policy with worked examples the judge then scored:

````markdown
## Problem

The router prompt rendered the policy with its three worked examples, and the judge scored answers against the examples instead of the rules. Policy recall fell on prompts the examples did not cover.

## Fix

```text
before: load policy.yaml -> render(policy + examples) -> router prompt
after:  load policy.yaml -> render(policy)             -> router prompt    (examples only under --with-examples)
```

## Reasoning

- **The examples were the longest text in the prompt,** so the judge weighted them over the rules they illustrated.
- **Every example restated a rule written above it,** so the policy loses nothing without them.
- **A flag keeps them for the eval that needs them,** so the training renders are unchanged.

## Results

| Metric | Before | After |
| --- | --- | --- |
| Policy recall | 0.71 | 0.84 |
| Example leakage | 12 of 200 | 0 of 200 |
| Latency p50 | not yet: the perf sweep runs nightly | not yet: same sweep |

Judge: rubric v3, 200 prompts, 3 runs each, mean.

## Proof

- **Tests:** the render test pins examples absent by default and present under the flag (2 new).
- **Gate:** `bun run check` green.

<details>
<summary>Technical details</summary>

- **Reviewer note (Copilot):** the default lives in `render_policy`, not in the YAML, so a policy file cannot turn examples back on.
- **Files:** `router/{render_policy.py,policy.yaml}`, `tests/test_render_policy.py`.

</details>
````
