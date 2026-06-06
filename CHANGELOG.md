# Changelog

This file is maintained by [release-please](https://github.com/googleapis/release-please).
New version sections are added automatically when its release PR is merged — don't
edit released sections by hand. The catalog version lives in
`.claude-plugin/marketplace.json` (`metadata.version`); consumers pin a release
with `npx skills add Vivswan/skills#vX.Y.Z`.

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
