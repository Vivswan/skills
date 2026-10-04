#!/usr/bin/env bun
// The docs gate behind `bun run check:docs`. Skill pages describe other repositories' files, so
// their set is word counts only.
//   check-docs.mts [<root>]    the root defaults to this repository; a test points it at a fixture tree

import { join } from "node:path";
import { ROOT } from "./lib";

const PROBE = join(ROOT, "skills", "working-text", "scripts", "docs-probe.mts");

export const PAGE_SETS: readonly { flags: readonly string[]; patterns: readonly string[] }[] = [
  {
    flags: [],
    patterns: [
      "README.md",
      "CONTRIBUTING.md",
      "docs/*.md",
      "xeno/README.md",
      "skills/README.md",
      "skills/*/README.md",
      "memories/*.md",
      "template/README.md",
      "template/references/*.md",
    ],
  },
  {
    flags: ["--shape-only"],
    patterns: ["skills/*/SKILL.md", "skills/*/references/*.md", "template/SKILL.md"],
  },
];

/** A pattern matching nothing is an error, not a shorter gate: a page set that shrank silently would pass vacuously. */
export function expand(root: string, pattern: string): string[] {
  const pages = [...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })].sort();
  if (pages.length === 0) throw new Error(`${pattern} matches no page under ${root}`);
  return pages;
}

if (import.meta.main) {
  const root = process.argv[2] ?? ROOT;
  for (const { flags, patterns } of PAGE_SETS) {
    let pages: string[];
    try {
      pages = patterns.flatMap((pattern) => expand(root, pattern));
    } catch (error) {
      console.error(`check-docs: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(2);
    }
    const proc = Bun.spawnSync(["bun", PROBE, ...flags, ...pages], {
      cwd: root,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
  }
}
