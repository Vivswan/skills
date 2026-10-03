# The docs-probe action

`.github/actions/docs-probe` runs the docs-discipline skill's probe, [`skills/docs-discipline/scripts/docs-probe.mts`](../skills/docs-discipline/scripts/docs-probe.mts), as a composite action a repository pins by sha. It was written for Vivswan/repo-platform's `ci.yml` to pin on its README and docs; this repository runs it on itself in `checks.yml`.

The probe reports two things on each page: a paragraph or list item over the word cap, and a repository path or relative link the prose names that does not exist. The skill's `SKILL.md` owns what counts as prose and as a path.

| Input | Meaning | Default |
|---|---|---|
| `pages` | Whitespace-separated page paths or globs, relative to `root`. Each must match at least one file. | required |
| `bases` | Whitespace-separated directories under `root` that named paths also resolve against: a tree shipped into other repositories | none |
| `root` | The repository root paths resolve against | `.` |
| `max-words` | The cap on a paragraph or list item | `70` |
| `shape-only` | `"true"` skips the path check, for pages that describe another repository's files | `"false"` |

| Exit | Meaning |
|---|---|
| `0` | every page clean |
| `1` | findings, one per line: `page:line: message` |
| `2` | a pattern matching nothing, no pages, a root that is not a directory, or an unreadable page |

**A caller pins it** to a commit on `main` and records which main it took in the comment. A platform repository whose pages describe files it writes into other repositories names those shipped trees as bases:

```yaml
- uses: Vivswan/skills/.github/actions/docs-probe@<sha> # main, <date>
  with:
    pages: README.md docs/*.md
    bases: files/base files/fuzzer files/nightly
```

The action sets up its own bun from the `.bun-version` next to `action.yml`, so the caller needs no bun step and no install step.

**This repository runs it on itself** in the `docs-probe-action` job of `.github/workflows/checks.yml`, on its README and docs, inside the all-green gate. That job exercises the action as a remote caller consumes it.

**The glue** between the inputs and the probe's arguments is [`.github/actions/docs-probe/run.mts`](../.github/actions/docs-probe/run.mts); its tests are [tests/docs-probe-action.test.ts](../tests/docs-probe-action.test.ts). The same glue runs locally:

```sh
PAGES="README.md docs/*.md" bun .github/actions/docs-probe/run.mts
```
