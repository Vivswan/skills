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

export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadJson(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    fail(`${rel(path)}: cannot read file (${errorMessage(error)})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    fail(`${rel(path)}: invalid JSON (${errorMessage(error)})`);
  }
}

export function loadJsonObject(path: string): Record<string, unknown> {
  const data = loadJson(path);
  if (!isRecord(data)) fail(`${rel(path)}: root must be an object`);
  return data;
}

export interface RootManifest {
  readonly path: string;
  readonly name: string;
  readonly skills: readonly string[];
  readonly raw: Record<string, unknown>;
}

export function loadRootManifest(path = join(ROOT, ".claude-plugin", "plugin.json")): RootManifest {
  const raw = loadJsonObject(path);
  const name = raw.name;
  if (typeof name !== "string" || !KEBAB_CASE.test(name)) {
    fail(`${rel(path)}: name ${JSON.stringify(name)} must be kebab-case`);
  }
  const skills = raw.skills;
  if (!isUnknownArray(skills) || skills.length === 0) {
    fail(`${rel(path)}: skills must be a non-empty array of skill directory paths`);
  }
  const skillPaths: string[] = [];
  for (const skillPath of skills) {
    if (typeof skillPath !== "string") fail(`${rel(path)}: skill paths must be strings`);
    skillPaths.push(skillPath);
  }
  return { path, name, skills: skillPaths, raw };
}

export interface Marketplace {
  readonly path: string;
  readonly plugins: readonly Record<string, unknown>[];
  readonly raw: Record<string, unknown>;
}

export function loadMarketplace(
  path = join(ROOT, ".claude-plugin", "marketplace.json"),
): Marketplace {
  const raw = loadJsonObject(path);
  const rawPlugins = raw.plugins;
  if (!isUnknownArray(rawPlugins) || rawPlugins.length === 0) {
    fail(`${rel(path)}: missing plugins array`);
  }
  const plugins: Record<string, unknown>[] = [];
  for (const plugin of rawPlugins) {
    if (!isRecord(plugin)) fail(`${rel(path)}: each plugin entry must be an object`);
    plugins.push(plugin);
  }
  return { path, plugins, raw };
}

export type Frontmatter = Record<string, unknown>;

export function parseFrontmatter(path: string): Frontmatter {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    fail(`${rel(path)}: cannot read file (${errorMessage(error)})`);
  }
  if (!text.startsWith("---\n")) fail(`${rel(path)}: missing YAML frontmatter start`);
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) fail(`${rel(path)}: missing YAML frontmatter end`);

  let data: unknown;
  try {
    data = Bun.YAML.parse(text.slice(4, end));
  } catch (error) {
    fail(`${rel(path)}: invalid YAML frontmatter (${errorMessage(error)})`);
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
