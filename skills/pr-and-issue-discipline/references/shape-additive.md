<!-- /pr-and-issue-discipline shape: additive feature.
Copy this file as is into .github/PULL_REQUEST_TEMPLATE/; the comments vanish when the body renders.
Use it for something new, added beside what exists; its flow may still show what happened without it. The filled example sits under the rule at the end. -->

## What this adds

<!-- the flow, when the addition changed one: a before: line and an after: line in one block, plain ASCII, arrows between steps -->

```text
before: step -> step
after:  step -> new step -> step
```

<!-- the real captured output of the new capability, complete enough to stand alone -->

```text
$ command
output
```

## How

<!-- 3 to 6 bullets, one sentence each, about 15 words, a bold lead-in; the mechanism, never the flow again.
When the diff touches a library-shaped category, the last bullet is **Library:** package, covers what (or: searched where; none fits because) -->

- **...**
- **...**
- **...**

## Proof

<!-- 2 to 4 bullets: focused tests or stable checks, latest totals only -->

- **Tests:** ...
- **Gate:** ...

<!-- A PR whose detail fits above has no Technical details section. Add one, collapsed, only for facts written for a bot reviewer or the next agent. -->

---

Filled, from a CI matrix that learned to build only the shards a change reaches:

````markdown
## What this adds

```text
before: push -> every context -> every shard built
after:  push -> changed contexts -> dependency closure -> shards in the closure only
```

```text
$ bun run shards --changed
manifest build/image-sets.json v3: 5 contexts, files and dependencies validated against the checkout
changed: api -> dependency closure {base, api} -> shards: [base, base+api]
```

## How

- **Validates the manifest** against the checkout before anything else runs.
- **Dependencies are declared per context** in the manifest, and the closure is transitive over them.
- **The matrix is one shard per closure entry,** in the manifest's own order.
- **Library:** `ajv`, covers the manifest schema validation.

## Proof

- **Tests:** manifest validation and shard-resolution cases pass (2 new).
- **Gate:** `bun run check` green.
````

Its detail fits in part one, so it has no part two.
