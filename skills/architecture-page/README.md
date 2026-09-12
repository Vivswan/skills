# Architecture Page

`/architecture-page` gives a repository with a layered `src/` and a docs site an architecture page that cannot rot: one `architecture.yml` declares the layers and the edges between them, a lint fails on any import the declaration lacks and on any allowance no file draws, the same declaration renders the module map into the page, and a page test checks that every box names a file that exists, a symbol it exports, and a test that demonstrates the concept.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill architecture-page
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/architecture-page -g
```

## What It Does

- Declares the import layering once, in `architecture.yml` (layers, exclude globs, allowed edges)
- Lints the tree against it in both directions: forbidden imports name both files, stale allowances name the edge, files outside every layer are reported, computed imports are refused
- Renders the module map from the declaration into a BEGIN/END GENERATED region of the page, with a drift check for CI
- Checks the hand-authored concept diagrams: paths exist, symbols are exported, every diagram has a "Demonstrated by:" line whose links resolve, and the diagram count is pinned

## Layout

- [`SKILL.md`](./SKILL.md): the specimen, the recipe, and the review criteria
- [`scripts/arch-lint.mts`](./scripts/arch-lint.mts): the lint (`--mermaid` prints the map); exports `readArchitecture`, `lintArchitecture`, `renderArchitectureMermaid`, `importSpecifiers`
- [`scripts/render-architecture-map.mts`](./scripts/render-architecture-map.mts): writes the map into the page's generated region; `--check` exits 1 on drift
- [`scripts/check-architecture-page.mts`](./scripts/check-architecture-page.mts): the page test; `--expect-diagrams <n>` pins the count, `--repo-url` resolves absolute links

The scripts run with bun plus the `oxc-parser` package (`bun add -d oxc-parser`); an unknown argument prints the usage. Copy them into the repository so its check command runs without the skill installed.

## Exit Codes

| Exit | Meaning |
| --- | --- |
| 0 | the tree, the page, or the region matches |
| 1 | a finding: forbidden or stale edge, a box naming missing code, drift in the generated region |
| 2 | usage, an unreadable declaration, a missing region, or a computed import the graph cannot follow |

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
