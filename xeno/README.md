# Xeno Skills

Xeno, from the Greek for foreign: skills this catalog ships but does not write. Each folder here is a copy of one whole folder of another repository at the commit `sources.yml` pins, identical to it except the frontmatter keys `sources.yml` overrides, so `npx skills add Vivswan/skills` installs them beside our own and our skills can hand off to them by name.

| Skill | Upstream | Folder there | License |
| --- | --- | --- | --- |
| [`unslop`](./unslop/) | [cursor/plugins](https://github.com/cursor/plugins) | `pstack/skills/unslop` | none published |
| [`frontend-design`](./frontend-design/) | [anthropics/skills](https://github.com/anthropics/skills) | `skills/frontend-design` | Apache-2.0 |
| [`design-taste-frontend`](./design-taste-frontend/) | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | `skills/taste-skill` | MIT |

## How a copy stays honest

```text
sources.yml          name -> url, path, commit, license, optional ref and frontmatter overrides
bun run sync-xeno           fetch each ref's head, rewrite the folder, move the pin
bun run sync-xeno -- --check   exit 1 when a pin is behind its ref or a copy differs from its pin
```

- **Nothing here is edited by hand.** A fix goes upstream; the next sync brings it back. The smoke test rejects a folder that is not in `sources.yml`, and the sync stops on a copy whose body or other files differ from its pin instead of overwriting it.
- **The frontmatter of a copy's SKILL.md belongs to `sources.yml`.** Its overrides are the only sanctioned difference from upstream, and an edit typed there is not preserved.
- **An override reaches Claude Code only.** Codex reads `agents/openai.yaml`, which a copy carries only when upstream ships one; `disable-model-invocation: true` on a copy therefore binds Claude Code and leaves Codex on the upstream policy.
- **The copies keep their upstream's conventions,** not this repository's: their prose shape, punctuation, and comments are read as upstream's. `.gitattributes` turns line-ending normalization off under `xeno/`, so a CRLF upstream stays CRLF.
- **The weekly workflow** (`.github/workflows/sync-xeno-skills.yml`) runs the sync every Monday and opens one pull request when a pin moved, with the before and after commits per skill.
- **The pin is the review unit.** A bump is read as a diff of the vendored folder, the same way any change to our own skills is read.

## Adding one

1. Add an entry to `sources.yml` with any 40-hex `commit` (the sync replaces it) and the upstream license's SPDX id, or `none published` when the upstream has no license file. When the license text sits outside the folder, name it in `license_file` and the sync copies it in beside the skill, as MIT and Apache require of a copy. A `frontmatter` mapping sets or removes (`null`) SKILL.md keys in the copy; it is the only allowed difference from upstream.
2. Run `bun run sync-xeno`; the folder appears and the pin moves to the ref's head.
3. List it as `./<name>` under the `xeno` plugin in `.claude-plugin/marketplace.json` (that plugin is the CLI's "Xeno" heading), in the root README under Xeno, and in the bug report form's skill dropdown; `bun run check` names anything missed.

A copy carries only what the upstream folder carries: no codex manifest, no README of ours, and no LICENSE.md of ours. `none published` means the upstream grants no license; the owner accepted that for the copy in this repository.
