#!/usr/bin/env python3
"""Fast smoke test for the skills collection.

Complements scripts/validate-skills.py (which checks structure). This focuses on
consumer-facing breakage that still passes structural validation:

  * template placeholders left behind in a real skill (copy-from-template slip)
  * the catalog version (marketplace.json metadata.version) is valid semver, and
    no per-skill `version` field has been reintroduced (single source of truth)
  * install incoherence: a marketplace skill path with no SKILL.md, or a
    plugin.json name that disagrees with its folder / SKILL.md frontmatter

Stdlib only, no network. Exits non-zero on the first failure.
"""

from __future__ import annotations

import json
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent

# Strings that should only ever appear in template/, never in a published skill.
PLACEHOLDER_MARKERS = (
    "Replace with",
    "Replace this",
    "template-skill",
    "Template Skill",
)

SEMVER = re.compile(
    r"^\d+\.\d+\.\d+"  # major.minor.patch
    r"(?:-[0-9A-Za-z-.]+)?"  # optional -prerelease
    r"(?:\+[0-9A-Za-z-.]+)?$"  # optional +build
)


def fail(message: str) -> None:
    raise SystemExit(f"SMOKE FAIL: {message}")


def frontmatter_name(skill_md: Path) -> str | None:
    text = skill_md.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return None
    try:
        end = text.index("\n---\n", 4)
    except ValueError:
        return None
    for line in text[4:end].splitlines():
        stripped = line.strip()
        if stripped.startswith("name:") and not line.startswith("  "):
            return stripped.split(":", 1)[1].strip().strip("\"'")
    return None


def frontmatter_has_version(skill_md: Path) -> bool:
    text = skill_md.read_text(encoding="utf-8")
    if not text.startswith("---\n"):
        return False
    try:
        end = text.index("\n---\n", 4)
    except ValueError:
        return False
    return any(re.match(r"\s*version\s*:", line) for line in text[4:end].splitlines())


def load_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def check_no_placeholders(skill_dir: Path) -> None:
    for path in skill_dir.rglob("*"):
        if not path.is_file() or path.suffix not in {".md", ".json"}:
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for marker in PLACEHOLDER_MARKERS:
            if marker in text:
                fail(
                    f"{path.relative_to(ROOT)}: leftover template placeholder "
                    f"{marker!r} -- looks copied from template/ but not filled in"
                )


def check_skill(skill_dir: Path) -> None:
    folder = skill_dir.name
    skill_md = skill_dir / "SKILL.md"
    plugin_json = skill_dir / ".codex-plugin" / "plugin.json"

    check_no_placeholders(skill_dir)

    fm_name = frontmatter_name(skill_md)
    if fm_name != folder:
        fail(f"{skill_md.relative_to(ROOT)}: frontmatter name {fm_name!r} != folder {folder!r}")

    plugin = load_json(plugin_json)
    if not isinstance(plugin, dict):
        fail(f"{plugin_json.relative_to(ROOT)}: root must be an object")
    if plugin.get("name") != folder:
        fail(f"{plugin_json.relative_to(ROOT)}: name {plugin.get('name')!r} != folder {folder!r}")

    # Single source of truth: the catalog version in marketplace.json. Per-skill
    # `version` fields are intentionally absent so they cannot drift -- guard
    # against anyone reintroducing one.
    if "version" in plugin:
        fail(
            f"{plugin_json.relative_to(ROOT)}: unexpected 'version' field -- the single "
            f"source of truth is marketplace.json metadata.version (see AGENTS.md > Releases)"
        )
    if frontmatter_has_version(skill_md):
        fail(
            f"{skill_md.relative_to(ROOT)}: unexpected metadata.version -- the single "
            f"source of truth is marketplace.json metadata.version"
        )


def check_marketplace() -> None:
    marketplace = load_json(ROOT / ".claude-plugin" / "marketplace.json")
    if not isinstance(marketplace, dict):
        fail(".claude-plugin/marketplace.json: root must be an object")

    version = marketplace.get("metadata", {}).get("version")
    if not isinstance(version, str) or not SEMVER.match(version):
        fail(f".claude-plugin/marketplace.json: metadata.version {version!r} is not valid semver")

    referenced: set[Path] = set()
    for plugin in marketplace.get("plugins", []):
        for skill_path in plugin.get("skills", []):
            resolved = (ROOT / skill_path).resolve()
            referenced.add(resolved)
            if not (resolved / "SKILL.md").is_file():
                fail(
                    f".claude-plugin/marketplace.json: referenced skill {skill_path!r} "
                    f"has no SKILL.md -- a consumer install would land nothing"
                )

    # Every skill folder must be listed in the marketplace, or it passes
    # structural validation but is silently excluded from `npx skills add` (the
    # collection install). Catch the omission here instead of at install time.
    for skill_dir in (ROOT / "skills").iterdir():
        if skill_dir.is_dir() and skill_dir.resolve() not in referenced:
            rel = skill_dir.relative_to(ROOT)
            fail(
                f"{rel}: skill folder is not referenced by any plugin in "
                f".claude-plugin/marketplace.json -- it would be excluded from collection installs"
            )


def main() -> None:
    check_marketplace()

    skills_dir = ROOT / "skills"
    skill_dirs = sorted(p for p in skills_dir.iterdir() if p.is_dir())
    for skill_dir in skill_dirs:
        check_skill(skill_dir)

    print(f"Smoke test passed ({len(skill_dirs)} skill(s) checked).")


if __name__ == "__main__":
    main()
