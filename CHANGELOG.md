# Changelog

This file is maintained by [release-please](https://github.com/googleapis/release-please).
New version sections are added automatically when its release PR is merged — don't
edit released sections by hand. The catalog version lives in
`.claude-plugin/marketplace.json` (`metadata.version`); consumers pin a release
with `npx skills add Vivswan/skills#vX.Y.Z`.

## [1.1.4](https://github.com/Vivswan/skills/compare/v1.1.3...v1.1.4) (2026-08-09)


### Features

* add no-invalid-states skill ([41c40e1](https://github.com/Vivswan/skills/commit/41c40e185d908c604e82680984c0c57172e44b29))


### Bug Fixes

* add single-source-of-truth guards to the smoke test ([fedb233](https://github.com/Vivswan/skills/commit/fedb233ceff7ad236505fe928af9361409db2621))
* declare dependabot default labels and refresh issue forms ([16e7080](https://github.com/Vivswan/skills/commit/16e7080b26f3199246f5e7d3ae63c2bb01b61b78))
* **scripts:** guard remaining file reads and close integration-review gaps ([f270bd1](https://github.com/Vivswan/skills/commit/f270bd1f7fe49570b1413e80d1f6f18b1f550026))
* **scripts:** parse manifests once at typed boundaries in check scripts ([d4db87d](https://github.com/Vivswan/skills/commit/d4db87d89c6fe85bcffb86771ba41e83ea1743bd))

## [1.1.3](https://github.com/Vivswan/skills/compare/v1.1.2...v1.1.3) (2026-07-25)


### Features

* rewrite the repo checks in TypeScript on bun ([ed852bc](https://github.com/Vivswan/skills/commit/ed852bc5be6dfa08d936c23e0341a1861d8234e1))


### Bug Fixes

* keep rubber-duck reviewer alive until it exits ([546dcf7](https://github.com/Vivswan/skills/commit/546dcf79722b6b7829579bf2d1ae13860ae73f4d))
* **natural-writing:** add skill based on Wikipedia's Signs of AI writing ([7794d89](https://github.com/Vivswan/skills/commit/7794d89ead1ece7fa71b93eb8ffd17d82698a701))
* **natural-writing:** point manifest URLs at the skill and add keywords ([1381c01](https://github.com/Vivswan/skills/commit/1381c01e01ff9fd59215b31cc43aeb10606d0298))
* publish the catalog as a single vivswan-skills plugin ([3ec2f4c](https://github.com/Vivswan/skills/commit/3ec2f4c049707e04982aa6eb0be33c600780696f))
* release every change as a patch bump ([489f45d](https://github.com/Vivswan/skills/commit/489f45d794b8a26901bdc4c1e4b2e6059be83d9c))
* **rubber-duck-review:** add self-repair step and workaround-comment criterion ([69dd5cc](https://github.com/Vivswan/skills/commit/69dd5ccaf081ffd77bda43ba20bcc60e300f8f2a))
* **rubber-duck-review:** don't treat a briefly empty output file as failure ([16acd39](https://github.com/Vivswan/skills/commit/16acd391705718a86907177da35e3cd93741f03b))
* **rubber-duck-review:** fix valid non-blocking findings, gate convergence on it ([aee5344](https://github.com/Vivswan/skills/commit/aee5344e4fe9bab5743191933a9c4b2983c49cea))
* **rubber-duck-review:** use ASCII ranges and the shared author URL ([a8c4ad3](https://github.com/Vivswan/skills/commit/a8c4ad369f6fd2f582fd780c2ac87a56b0e1bc67))
* tailor issue forms and repo settings to the catalog ([2eade88](https://github.com/Vivswan/skills/commit/2eade884e946e5c925bce34358b64ec3d130b81a))
* **template:** follow the per-skill manifest conventions ([d325bcb](https://github.com/Vivswan/skills/commit/d325bcb9368a78d49c844e3c4166002de070f9ae))
* update docs for the bun toolchain and plugin install ([a10be75](https://github.com/Vivswan/skills/commit/a10be75730c5a663d76a5a4edc35db337ee661a7))
* write rubber-duck review artifacts to a scratch tmp dir ([53bb48f](https://github.com/Vivswan/skills/commit/53bb48facc05f5d60e06bb2d5516df4c346d89e3))

## [1.1.2](https://github.com/Vivswan/skills/compare/v1.1.1...v1.1.2) (2026-06-08)


### Bug Fixes

* clarify skill repo release commit types ([f8a8d13](https://github.com/Vivswan/skills/commit/f8a8d137ff3ea04da43214a497084b9aeda3d1cc))

## [1.1.1](https://github.com/Vivswan/skills/compare/v1.1.0...v1.1.1) (2026-06-07)


### Bug Fixes

* trim AGENTS.md to project conventions and ban commit attribution lines ([c70dae8](https://github.com/Vivswan/skills/commit/c70dae81baea727d2d0fb52dbfc743b73fc06897))

## [1.1.0] - 2026-06-06

Baseline release (pre-automation).

### Added
- `rubber-duck-review` skill: cross-model code review via a second agent, tool,
  or read-only CLI fallback.
- Repository tooling: `scripts/validate-skills.py` (structural validation) and
  `scripts/smoke-test.py` (template-placeholder, semver, and install-coherence
  checks; guards against per-skill `version` fields), both wired into CI.
- `.github/settings.yml` (Probot Settings app): repository metadata, labels, and
  a default-branch ruleset.
- Release automation: release-please (`release-please-config.json`) plus a
  Conventional-Commit PR-title check.
