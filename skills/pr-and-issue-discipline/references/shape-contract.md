<!-- /pr-and-issue-discipline shape: contract or documentation PR.
Copy this file as is into .github/PULL_REQUEST_TEMPLATE/; the comments vanish when the body renders.
Use it when the PR defines a contract rather than executable behavior: nothing runs, so the contract itself is the picture.
The filled example sits under the rule at the end. -->

## What this specifies

<!-- the flow, when the contract changes one: a before: line and an after: line in one block, plain ASCII -->

```text
before: step -> step
after:  step -> check -> step
```

<!-- the contract itself: its schema, table, or layout, in a block, not in prose -->

```text
the contract, as the reader will see it
```

## How

<!-- 3 to 6 bullets, one sentence each, about 15 words, a bold lead-in; the mechanism, never the flow again -->

- **...**
- **...**
- **...**

## Proof

<!-- 2 to 4 bullets: the check that enforces the contract, and the gate -->

- **Check:** ...
- **Gate:** ...

<details>
<summary>Technical details</summary>

<!-- one fact per line; accepted deviations from the contract belong here. Delete the section when there is no such detail. -->

- **Accepted deviation:** ...

</details>

---

Filled, from a smoke test that mirrors three manifest files per skill:

````markdown
## What this specifies

```text
before: build -> smoke test reads SKILL.md -> green
after:  build -> smoke test reads the three files -> mirrored fields match? -> yes: green
                                                                            -> no:  fails, field named
```

```text
SKILL.md                    disable-model-invocation: true
agents/openai.yaml          policy.allow_implicit_invocation: false   <- must pair with the line above

agents/openai.yaml          .codex-plugin/plugin.json
interface.display_name      == interface.displayName
interface.short_description == interface.shortDescription   (25-64 chars)
interface.brand_color       == interface.brandColor
```

## How

- **The mirrored fields are one table** in the smoke test, so a new field is one row.
- **The failure names the field and both values,** so the fix is one edit, not a search.
- **The invocation pair is checked together,** so one flag without the other fails.

## Proof

- **Smoke test:** the mirrored-block and invocation-pairing cases pass.
- **Gate:** `bun run check` green.

<details>
<summary>Technical details</summary>

- **Accepted deviation:** `longDescription` is not mirrored, since the codex manifest carries the long form alone.

</details>
````
