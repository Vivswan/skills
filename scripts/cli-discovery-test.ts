#!/usr/bin/env bun
/**
 * Integration test: run the real `npx skills` CLI against this checkout and
 * assert what a consumer would see. Needs network (npx downloads the CLI), so
 * it runs as its own CI job and is not part of `bun run check`.
 *
 * Asserts that every published skill is listed, that they are grouped under
 * the plugin title derived from .claude-plugin/plugin.json, and that the
 * internal template skill stays hidden. Skill presence and absence are judged
 * against listing rows, never against the output as free text; see
 * scripts/cli-discovery-checks.ts for why.
 */

import { spawnSync } from "node:child_process";
import { basename, join } from "node:path";
import { checkListing, stripAnsi } from "./cli-discovery-checks";
import {
  fail,
  KEBAB_CASE,
  loadRootManifest,
  parseFrontmatter,
  ROOT,
  runChecks,
  skillDirs,
} from "./lib";

// Mirrors the CLI's kebabToTitle: capitalize the first letter of each segment.
function kebabToTitle(name: string): string {
  return name
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function main(): void {
  const manifest = loadRootManifest();
  const groupTitle = kebabToTitle(manifest.name);
  const expected = skillDirs().map((dir) => basename(dir));
  // Listing rows only ever hold kebab-case names, so a non-kebab folder could
  // never match one; fail with the real cause up front (this job runs on its
  // own, without validate-skills before it).
  for (const name of expected) {
    if (!KEBAB_CASE.test(name)) fail(`skills/${name}/: skill folder name must be kebab-case`);
  }

  // Derive the internal skill's name from the template itself, so renaming
  // the template skill cannot silently un-hide it here.
  const templateName = parseFrontmatter(join(ROOT, "template", "SKILL.md")).name;
  if (typeof templateName !== "string" || !KEBAB_CASE.test(templateName)) {
    fail("template/SKILL.md: frontmatter must declare a kebab-case internal skill name");
  }

  const proc = spawnSync("npx", ["-y", "skills", "add", ROOT, "--list"], {
    encoding: "utf-8",
    timeout: 300_000,
  });
  if (proc.error) fail(`npx skills failed to launch: ${proc.error.message}`);
  const output = stripAnsi(`${proc.stdout ?? ""}\n${proc.stderr ?? ""}`);
  if (proc.status !== 0) fail(`npx skills exited with ${proc.status}:\n${output}`);

  checkListing(expected, groupTitle, templateName, output);

  console.log(`CLI discovery test passed (${expected.length} skill(s) under '${groupTitle}').`);
}

runChecks(main);
