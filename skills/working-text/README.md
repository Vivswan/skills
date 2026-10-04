# Working Text

`/working-text` governs working text: anything a colleague reads to get work done in a repository, on GitHub, in CI output, in Notion, or in a diagram. A README, a comment, a description or help text, a PR or issue, a review reply, a commit body, an agent brief, a Mermaid chart. Not a paper, an essay, or a book, which a reader studies rather than scans.

Every fact is shown by the device that shows it fastest, and every path, symbol, and check the text names is real:

| The reader must see | A device that showed it well |
| --- | --- |
| which value wins | an ASCII tree with the winner on each leaf |
| what a command does | its real captured output |
| what to do about a symptom | what you see, what it means, what to do |
| a break between versions | old form, new form, and what the old form does now |
| plain facts | bullets with bold lead-ins, paragraphs under 70 words |

`scripts/docs-probe.mts` measures the cap and checks that named paths exist. `references/architecture-page.md` and its three scripts keep an architecture page's diagrams naming real code.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill working-text
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/working-text -g
```

## What It Does

- Picks the device from the content, with a worked before/after on a real paragraph. Includes the rule to break a convention when the content reads better without it.
- Probes a page: paragraphs and list items over 70 words, and backticked paths or relative links that do not exist, each with its line.
- Restructures an existing page without losing or inventing a fact: headings and anchors censused before and after, a review that lists every fact absent or new.
- For an architecture page: declares the import layering once in `architecture.yml` and lints the tree against it both ways. Renders the module map into a generated region, and checks that every diagram box names a file that exists and a symbol it exports.
- Contributes its `## Review Criteria` to every [`/rubber-duck-review`](../rubber-duck-review/) pass.

## Layout

- [`SKILL.md`](./SKILL.md): the specimen, the shape rules, the probe, restructuring, page kinds, the review criteria
- [`references/architecture-page.md`](./references/architecture-page.md): the architecture page recipe
- [`scripts/docs-probe.mts`](./scripts/docs-probe.mts): the paragraph cap and the path check. `--shape-only` skips paths, `--max-words` moves the cap, `--base <dir>` adds a tree paths also resolve against
- [`scripts/arch-lint.mts`](./scripts/arch-lint.mts): the layering lint (`--mermaid` prints the map). Exports `readArchitecture`, `lintArchitecture`, `renderArchitectureMermaid`, `importSpecifiers`
- [`scripts/render-architecture-map.mts`](./scripts/render-architecture-map.mts): writes the map into the page's generated region. `--check` exits 1 on drift
- [`scripts/check-architecture-page.mts`](./scripts/check-architecture-page.mts): the page test. `--expect-diagrams <n>` pins the count, `--repo-url` resolves absolute links

The probe runs with bun alone. The three architecture scripts also need `oxc-parser` (`bun add -d oxc-parser`). Copy them into the repository so its check command runs without the skill installed.

## Exit Codes

| Exit | Meaning |
| --- | --- |
| 0 | the page, the tree, or the region is clean |
| 1 | a finding: a unit over the cap, a missing path, a forbidden or stale edge, a box naming missing code, drift in the generated region |
| 2 | usage, a page or declaration that cannot be read, a missing region, or a computed import the graph cannot follow |

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
