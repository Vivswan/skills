# Changelog

This file is maintained by [release-please](https://github.com/googleapis/release-please).
New version sections are added automatically when its release PR is merged — don't
edit released sections by hand. The catalog version lives in
`.claude-plugin/marketplace.json` (`metadata.version`); consumers pin a release
with `npx skills add Vivswan/skills#vX.Y.Z`.

## [1.1.3](https://github.com/Vivswan/skills/compare/v1.1.2...v1.1.3) (2026-07-13)


### Bug Fixes

* keep rubber-duck reviewer alive until it exits ([546dcf7](https://github.com/Vivswan/skills/commit/546dcf79722b6b7829579bf2d1ae13860ae73f4d))
* **natural-writing:** add skill based on Wikipedia's Signs of AI writing ([7794d89](https://github.com/Vivswan/skills/commit/7794d89ead1ece7fa71b93eb8ffd17d82698a701))
* **rubber-duck-review:** don't treat a briefly empty output file as failure ([16acd39](https://github.com/Vivswan/skills/commit/16acd391705718a86907177da35e3cd93741f03b))
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
