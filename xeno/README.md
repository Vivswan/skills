# Xeno Skills

Xeno, from the Greek for foreign: skills this catalog ships but does not write. Each folder here is a copy of one whole folder of another repository at the commit `sources.yaml` pins, so `npx skills add Vivswan/skills` installs them beside our own and our skills can hand off to them by name.

A copy is identical to its upstream folder except what `sources.yaml` declares: frontmatter overrides, a license file copied in from the upstream root when the folder carries none, and `own` paths, files of this repository that live inside the copy (the Vale style under `unslop/vale/`).

| Skill | Upstream | Folder there | License |
| --- | --- | --- | --- |
| [`unslop`](./unslop/) | [cursor/plugins](https://github.com/cursor/plugins) | `pstack/skills/unslop` | none published |
| [`frontend-design`](./frontend-design/) | [anthropics/skills](https://github.com/anthropics/skills) | `skills/frontend-design` | Apache-2.0 |
| [`design-taste-frontend`](./design-taste-frontend/) | [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) | `skills/taste-skill` | MIT |

## How a copy stays honest

```text
sources.yaml         name -> url, path, commit, license, optional ref, license_file, frontmatter overrides, and own paths
bun run sync-xeno           fetch each ref's head; where the folder changed, rewrite the copy and move the pin
bun run sync-xeno -- --check   exit 1 when the folder at a ref's head differs from its copy, or a copy differs from its pin
```

- **Nothing here is edited by hand, except under a declared `own` path.** A fix to upstream's files goes upstream; the next sync brings it back. The smoke test rejects a folder that is not in `sources.yaml`, and the sync stops on a copy whose body or other files differ from its pin instead of overwriting it.
- **The frontmatter of a copy's SKILL.md, the license file it names, and its `own` paths belong to `sources.yaml`.** Those are the only sanctioned differences from upstream. The sync keeps an own path exactly as it is and rewrites everything else; an upstream file appearing under an own path stops the sync instead of being hidden.
- **An override reaches Claude Code only.** Codex reads `agents/openai.yaml`, which a copy carries only when upstream ships one; `disable-model-invocation: true` on a copy therefore binds Claude Code and leaves Codex on the upstream policy.
- **The copies keep their upstream's conventions,** not this repository's: their prose shape, punctuation, and comments are read as upstream's. `.gitattributes` turns line-ending normalization off under `xeno/`, so a CRLF upstream stays CRLF.
- **The nightly workflow** (`.github/workflows/nightly.yml`) runs the sync every night and opens one pull request when a folder changed at its ref's head, with the before and after commits per skill. A red sync files a tracking issue; the next green night closes it.
- **The pin is the review unit.** A bump is read as a diff of the vendored folder, the same way any change to our own skills is read. An upstream commit elsewhere in that repository moves nothing: the pin moves only when the vendored files differ between it and the ref's head, so a pin move is always an upstream diff to read.

## Adding one

1. Add an entry to `sources.yaml` with `commit` set to forty zeros (the placeholder the first sync replaces; any other value is fetched as a pin) and the upstream license's SPDX id, or `none published` when the upstream has no license file.
2. When the license text sits outside the folder, name it in `license_file`; the sync copies it in beside the skill, as MIT and Apache require of a copy. Renaming or removing `license_file` later: delete its old copy first, then sync.
3. A `frontmatter` mapping sets or removes (`null`) SKILL.md keys in the copy. An `own` list names folder-relative paths this repository keeps inside the copy, a trailing slash for a directory (`own: [vale/]`); the smoke test requires each to exist.
4. Run `bun run sync-xeno`; the folder appears and the pin moves to the ref's head.
5. List it as `./<name>` under the `xeno` plugin in `.claude-plugin/marketplace.json` (that plugin is the CLI's "Xeno" heading), in the root README under Xeno, and in the bug report form's skill dropdown; `bun run check` names anything missed.

A copy carries what the upstream folder carries, the license file `sources.yaml` names, and the `own` paths it declares: no codex manifest, no README of ours, and no LICENSE.md of ours. `none published` means the upstream grants no license; the owner accepted that for the copy in this repository.
