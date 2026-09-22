#!/usr/bin/env bun
// The targeted gate the pre-commit hook runs: the fast static checks always, then only the test
// files a staged file can reach (by import, or by name in the test's text). The full suite is CI's (checks.yml runs `bun run check`
// on every push and PR), so a commit here stays seconds long.
//   check-staged.mts               staged paths read from the index
//   check-staged.mts <paths...>    the hook passes them, read before it scrubs GIT_INDEX_FILE

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { basename, dirname, extname, join, normalize, relative } from "node:path";
import { ROOT } from "./lib";

export const STATIC_CHECKS = ["typecheck", "lint", "validate", "smoke"] as const;

/** A path's file name without its last extension: scripts/sync-xeno.mts -> sync-xeno, SKILL.md -> SKILL. */
export function stem(path: string): string {
  const name = basename(path);
  return name.slice(0, name.length - extname(name).length);
}

/** The launcher every test runs under; a change anywhere in its import closure reaches every test. */
export const LAUNCHER_ROOTS = ["scripts/run-tests.ts", "tests/preload.ts"] as const;

const RELATIVE_IMPORT = /(?:from\s+|import\s+|import\()\s*["'](\.{1,2}\/[^"']+)["']/g;

/** Relative imports of one file, resolved to paths present in `files` (extension-less specifiers try .ts and .mts). */
export function importsOf(
  path: string,
  text: string,
  files: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(RELATIVE_IMPORT)) {
    const spec = normalize(join(dirname(path), match[1] as string));
    const hit = [spec, `${spec}.ts`, `${spec}.mts`, `${spec}/index.ts`].find((c) => files.has(c));
    if (hit) out.push(hit);
  }
  return out;
}

function closure(roots: readonly string[], files: ReadonlyMap<string, string>): Set<string> {
  const seen = new Set<string>();
  const queue = roots.filter((r) => files.has(r));
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    queue.push(...importsOf(path, files.get(path) as string, files));
  }
  return seen;
}

/**
 * The test files to run for a staging: every staged test; every test whose import closure reaches a
 * staged file; every test whose text names a staged file's stem (a script a test runs by path, a
 * SKILL.md a doc test pins). A staged file in the launcher's closure selects every test.
 * A stem under three characters names too little to select by.
 */
export function selectTests(
  staged: readonly string[],
  files: ReadonlyMap<string, string>,
): string[] {
  const tests = [...files.keys()]
    .filter((p) => p.startsWith("tests/") && p.endsWith(".test.ts"))
    .sort();
  const stagedSet = new Set(staged);
  const launcher = closure(LAUNCHER_ROOTS, files);
  if (staged.some((p) => launcher.has(p) || (LAUNCHER_ROOTS as readonly string[]).includes(p))) {
    return tests;
  }
  const stems = [...new Set(staged.map(stem))].filter((s) => s.length >= 3);
  return tests.filter(
    (t) =>
      stagedSet.has(t) ||
      [...closure([t], files)].some((f) => stagedSet.has(f)) ||
      stems.some((s) => (files.get(t) as string).includes(s)),
  );
}

const SOURCE_DIRS = ["tests", "scripts", "skills", ".githooks", ".github"];

/** Every TypeScript file the selector can follow imports through, repo-relative path -> text. */
function readSources(): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.m?ts$/.test(entry.name)) {
        files.set(relative(ROOT, full), readFileSync(full, "utf8"));
      }
    }
  };
  for (const dir of SOURCE_DIRS) if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir));
  return files;
}

function stagedFromIndex(): string[] {
  const proc = Bun.spawnSync(
    ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    { cwd: ROOT, stdout: "pipe", stderr: "inherit" },
  );
  if (proc.exitCode !== 0) {
    console.error("check-staged: git diff --cached failed");
    process.exit(2);
  }
  return proc.stdout.toString().split("\0").filter(Boolean);
}

function run(script: string, args: readonly string[] = []): void {
  console.log(`check-staged: bun run ${[script, ...args].join(" ")}`);
  const proc = Bun.spawnSync(["bun", "run", script, ...args], {
    cwd: ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (proc.exitCode === 0) return;
  if (proc.exitCode !== null) process.exit(proc.exitCode);
  // Shell-style status when the check dies by signal (143 for SIGTERM), as the hook reports it.
  const signal = proc.signalCode ? constants.signals[proc.signalCode as NodeJS.Signals] : undefined;
  process.exit(signal !== undefined ? 128 + signal : 1);
}

if (import.meta.main) {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  const staged = args.length > 0 ? args : stagedFromIndex();
  for (const script of STATIC_CHECKS) run(script);
  const tests = selectTests(staged, readSources());
  if (tests.length === 0)
    console.log("check-staged: no test names a staged file; the suite is CI's");
  else run("test", tests);
}
