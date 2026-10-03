#!/usr/bin/env bun
// The docs-probe action's glue: its inputs arrive as environment variables, the page patterns
// expand here (an action input cannot glob), and the probe's exit code passes through unchanged.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname, isAbsolute, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../skills/docs-discipline/scripts/docs-probe.mts",
);

const words = (value: string | undefined): string[] => (value ?? "").split(/\s+/).filter(Boolean);

function fail(message: string): never {
  console.error(`docs-probe action: ${message}`);
  process.exit(2);
}

/** Any failure to stat is "not a directory": a missing path or a file in the middle of it alike. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function main(): number {
  const root = resolve(process.env.ROOT || ".");
  if (!isDirectory(root)) fail(`root ${root} is not a directory`);
  const pages = new Set<string>();
  for (const pattern of words(process.env.PAGES)) {
    const matches = [...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })].sort();
    if (matches.length === 0) fail(`pages pattern ${pattern} matches nothing under ${root}`);
    for (const match of matches) pages.add(normalize(match));
  }
  if (pages.size === 0) fail("the pages input is required");

  const args = ["--root", root];
  for (const base of words(process.env.BASES)) args.push("--base", base);
  if (process.env.MAX_WORDS) args.push("--max-words", process.env.MAX_WORDS);
  if (process.env.SHAPE_ONLY === "true") args.push("--shape-only");

  // Relative with a `./` prefix: a page named `-guide.md` is then a file to the probe, not an option,
  // and a pattern that climbs out of a symlinked root and back still names what the scan matched.
  const files = [...pages].map((page) => (isAbsolute(page) ? page : `./${page}`));
  const run = spawnSync(process.execPath, [PROBE, ...args, ...files], {
    cwd: root,
    stdio: "inherit",
  });
  return run.status ?? 2;
}

// Every failure before the probe runs (an unreadable root, a pattern the scanner rejects) is a
// usage error with one diagnostic line, never a stack trace with exit 1.
try {
  process.exit(main());
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
