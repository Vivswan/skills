# No Invalid States

`/no-invalid-states` is a review-and-refactor skill that
moves correctness invariants out of scattered runtime checks and into the
type system: parse at boundaries, then make invalid internal states
impossible to construct.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill no-invalid-states
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/no-invalid-states -g
```

## What It Does

- Finds invariants hiding behind boolean lifecycle flags, co-dependent
  optionals, "must call X before Y" comments, and repeated validation
- Classifies each one as static (encode it in the types) or dynamic (keep
  the runtime check)
- Refactors to the strongest idiomatic mechanism: sum types, newtypes,
  typestate, smart constructors, immutability, or schema constraints
- Verifies with the repository's own formatter, type checker, lint, and
  test tooling, then reports what was strengthened and what stayed dynamic
- Pairs with [`/rubber-duck-review`](../rubber-duck-review/): when both skills are installed, the
  review skill folds these criteria into its second-opinion passes

## Language Coverage

Detailed guidance with code examples, one file per ecosystem:

- [`references/rust.md`](./references/rust.md)
- [`references/typescript.md`](./references/typescript.md)
- [`references/python.md`](./references/python.md)
- [`references/other-languages.md`](./references/other-languages.md) (Go,
  Java, Kotlin, C#, Swift, functional languages, dynamic languages, and
  database schemas)

## Plugin-Ready Layout

This skill directory already includes plugin metadata in
[`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers,
hooks, or app manifests can be added later without moving the skill.
