#!/usr/bin/env bun
// One layering declaration (architecture.yml), two readers: this lint and the
// module map. The lint fails in both directions so the declaration cannot rot:
//   import between layers with no declared edge  -> "forbidden import", exit 1
//   declared edge no file draws                  -> "stale allowance", exit 1
//   computed import() or require()               -> exit 2, never a silently dropped edge
//
// An edge is any way one file names another: runtime imports, type-only
// imports, re-exports, `import("./x").T` in a type position, and
// `import X = require("./x")`. Only relative specifiers are edges; a path
// alias is invisible here, so the declaration names the tree, not the alias.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Architecture } from "./declaration.mts";

// --- Self-build: run as source, bundle into <skill>/.build/ and run the bundle; run as the bundle, do nothing.
// docs/authoring.md > Dependencies owns this block; the smoke test keeps every copy identical.

function buildPaths(source: string) {
  // An entry may sit below scripts/: the skill root is the parent of the scripts/ with the manifest beside it.
  let scripts = dirname(source);
  while (basename(scripts) !== "scripts" || !existsSync(join(dirname(scripts), "package.json"))) {
    if (dirname(scripts) === scripts) {
      console.error(
        `${source}: no scripts/ directory with a package.json beside it above the script`,
      );
      process.exit(2);
    }
    scripts = dirname(scripts);
  }
  const skill = dirname(scripts);
  const built = join(skill, ".build", relative(scripts, source).replace(/\.mts$/, ".js"));
  return { scripts, skill, built };
}

function buildIsStale(scripts: string, skill: string, built: string): boolean {
  if (!existsSync(built)) return true;
  // An entry imports its siblings, and a pin bump changes the bundle, so every script and the manifest count.
  const inputs = readdirSync(scripts, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".mts"))
    .map((name) => join(scripts, name));
  inputs.push(join(skill, "package.json"));
  const newest = Math.max(...inputs.map((path) => statSync(path).mtimeMs));
  return statSync(built).mtimeMs < newest;
}

function runBun(args: string[]): boolean {
  const step = spawnSync("bun", args, { stdio: ["ignore", "ignore", "pipe"] });
  if (step.status !== 0) process.stderr.write(step.stderr);
  return step.status === 0;
}

function build(source: string, skill: string, built: string): void {
  // bun build resolves installed packages only: install the pins for the build's duration, then remove them.
  const ok =
    runBun(["install", "--production", "--no-save", "--cwd", skill]) &&
    runBun(["build", source, "--target", "bun", "--outfile", built]);
  rmSync(join(skill, "node_modules"), { recursive: true, force: true });
  if (!ok) process.exit(2);
}

function ensureBuilt(source: string): boolean {
  if (!source.endsWith(".mts")) return false;
  const { scripts, skill, built } = buildPaths(source);
  if (buildIsStale(scripts, skill, built)) build(source, skill, built);
  const run = spawnSync("bun", [built, ...process.argv.slice(2)], { stdio: "inherit" });
  // A bundle killed by a signal has no status: die of the same signal.
  if (run.signal) process.kill(process.pid, run.signal);
  process.exitCode = run.status ?? 1;
  return true;
}

// Only the command builds; a test or a sibling importing this file must not.
if (import.meta.main && ensureBuilt(import.meta.path)) process.exit();

// Loaded below the guard: a static import is hoisted above it and would resolve on the source path.
const { DEFAULT_CONFIG, layerOf, readArchitecture, renderArchitectureMermaid } = await import(
  "./declaration.mts"
);
const { isFile, pathLabel, toPosix } = await import("./paths.mts");
const { importSpecifiers, resolveImport, SOURCE_EXTENSIONS } = await import("./sources.mts");

/** The top-level directories the layers live in, so a file beside them outside every layer is seen. */
function scanRoots(arch: Architecture): string[] {
  const roots = new Set<string>();
  for (const paths of Object.values(arch.layers)) {
    for (const path of paths) {
      const [head] = path.split("/");
      if (head !== undefined && head !== "" && path.includes("/")) roots.add(head);
    }
  }
  return [...roots].sort();
}

/**
 * The lint verdict for the tree at `root`. Empty means the declaration is
 * exactly the tree. `configLabel` is how the messages name the declaration file.
 */
export function lintArchitecture(
  root: string,
  arch: Architecture,
  configLabel = DEFAULT_CONFIG,
): string[] {
  const excluded = arch.exclude.map((pattern) => new Bun.Glob(pattern));
  const drawn = new Map<string, string[]>();
  const problems: string[] = [];
  for (const [layer, paths] of Object.entries(arch.layers)) {
    for (const path of paths) {
      if (!existsSync(join(root, path))) {
        problems.push(`layer ${layer} names ${path}, which does not exist`);
      } else if (!path.endsWith("/") && statSync(join(root, path)).isDirectory()) {
        // Without the slash no scan root reaches the directory, and the layer would lint as empty.
        problems.push(
          `layer ${layer} names ${path}, a directory; write it as ${path}/ so its files are scanned`,
        );
      }
    }
  }
  const files: string[] = [];
  // A layer may own a root-level file (main.ts); no scan root reaches it, so it is seeded by name.
  for (const paths of Object.values(arch.layers)) {
    for (const path of paths) {
      if (path.includes("/") || !SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext))) continue;
      if (isFile(join(root, path)) && !excluded.some((glob) => glob.match(path))) files.push(path);
    }
  }
  for (const scanRoot of scanRoots(arch)) {
    if (!existsSync(join(root, scanRoot))) continue;
    for (const entry of readdirSync(join(root, scanRoot), { recursive: true, encoding: "utf8" })) {
      const file = toPosix(join(scanRoot, entry));
      if (!SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext))) continue;
      if (!isFile(join(root, file))) continue;
      if (excluded.some((glob) => glob.match(file))) continue;
      files.push(file);
    }
  }
  for (const file of files.sort()) {
    const from = layerOf(arch, file);
    if (from === undefined) {
      problems.push(`${file} belongs to no layer in ${configLabel}`);
      continue;
    }
    const absolute = join(root, file);
    for (const specifier of importSpecifiers(readFileSync(absolute, "utf8"), file)) {
      const target = toPosix(relative(root, resolveImport(absolute, specifier)));
      const to = layerOf(arch, target);
      if (to === undefined) {
        problems.push(`${target} (imported by ${file}) belongs to no layer in ${configLabel}`);
      } else if (to !== from) {
        const key = `${from} -> ${to}`;
        drawn.set(key, [...(drawn.get(key) ?? []), `${file} -> ${target}`]);
      }
    }
  }
  const declared = new Set(
    Object.entries(arch.edges).flatMap(([from, targets]) =>
      targets.map((to) => `${from} -> ${to}`),
    ),
  );
  for (const [key, sites] of [...drawn].sort()) {
    if (!declared.has(key)) {
      problems.push(`forbidden import ${key}: ${sites.join(", ")}; move it or declare the edge`);
    }
  }
  for (const key of [...declared].sort()) {
    if (!drawn.has(key)) {
      problems.push(`stale allowance ${key}: no file draws it; remove it from ${configLabel}`);
    }
  }
  return problems;
}

// --- CLI ---------------------------------------------------------------------

const USAGE = [
  "usage: lint.mts [--config <architecture.yml>] [--root <dir>] [--mermaid]",
  "  --config   the layering declaration (default: <root>/architecture.yml)",
  "  --root     the repository root the paths are relative to (default: cwd)",
  "  --mermaid  print the module map instead of linting",
  "exit 0: the tree matches the declaration; 1: forbidden or stale edges; 2: usage or an unreadable graph",
].join("\n");

export interface CliOptions {
  root: string;
  config: string;
  mermaid: boolean;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let root = process.cwd();
  let config: string | undefined;
  let mermaid = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    if (arg === "--root") root = resolve(value());
    else if (arg === "--config") config = resolve(value());
    else if (arg === "--mermaid") mermaid = true;
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  return { root, config: config ?? join(root, DEFAULT_CONFIG), mermaid };
}

if (import.meta.main) {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const configLabel = pathLabel(options.root, options.config);
  try {
    const arch = readArchitecture(options.config, configLabel);
    if (options.mermaid) {
      console.log(renderArchitectureMermaid(arch));
      process.exit(0);
    }
    const problems = lintArchitecture(options.root, arch, configLabel);
    if (problems.length > 0) {
      console.error(`arch-lint: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`arch-lint: imports under ${scanRoots(arch).join(", ")} match ${configLabel}`);
  } catch (error) {
    console.error(`arch-lint: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
