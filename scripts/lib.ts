/**
 * Shared helpers for the repo check scripts in this directory.
 *
 * Everything here is intentionally dependency-free (Bun + node builtins) so
 * `bun scripts/<name>.ts` works on a fresh checkout without an install step.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..");
export const SKILLS_DIR = join(ROOT, "skills");

export const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A check failed. Thrown by fail(); reported and exit-coded by runChecks(). */
export class CheckFailure extends Error {}

export function fail(message: string): never {
  throw new CheckFailure(message);
}

/** Entry-point wrapper: print a CheckFailure as `FAIL: ...` and exit 1. */
export function runChecks(main: () => void): void {
  try {
    main();
  } catch (error) {
    if (error instanceof CheckFailure) {
      console.error(`FAIL: ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

export function rel(path: string): string {
  return relative(ROOT, path);
}

export function requireFile(path: string): void {
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    fail(`Missing required file: ${rel(path)}`);
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    fail(`${rel(path)}: cannot read file (${(error as Error).message})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${rel(path)}: invalid JSON (${(error as Error).message})`);
  }
}

export type Frontmatter = Record<string, unknown>;

export function parseFrontmatter(path: string): Frontmatter {
  const text = readFileSync(path, "utf-8");
  if (!text.startsWith("---\n")) fail(`${rel(path)}: missing YAML frontmatter start`);
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) fail(`${rel(path)}: missing YAML frontmatter end`);

  let data: unknown;
  try {
    data = Bun.YAML.parse(text.slice(4, end));
  } catch (error) {
    fail(`${rel(path)}: invalid YAML frontmatter (${(error as Error).message})`);
  }
  if (!isRecord(data)) fail(`${rel(path)}: frontmatter must be a YAML mapping`);
  return data;
}

export function skillDirs(): string[] {
  if (!statSync(SKILLS_DIR, { throwIfNoEntry: false })?.isDirectory()) {
    fail("skills/: missing skills directory");
  }
  const dirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(SKILLS_DIR, entry.name))
    .sort();
  if (dirs.length === 0) fail("skills/: no public skills found");
  return dirs;
}

export function walkFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walkFiles(full));
    else if (entry.isFile()) results.push(full);
  }
  return results;
}
