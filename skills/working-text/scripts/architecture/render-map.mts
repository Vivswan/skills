#!/usr/bin/env bun
// The second reader of architecture.yml: the module map, spliced between the
// page's `<!-- BEGIN GENERATED: <name> (hint) -->` and `<!-- END GENERATED: <name> -->`
// markers. The agent runs it from the skill directory before a change lands; --check reports whether the map is stale.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

export const DEFAULT_REGION = "architecture-map";

const USAGE = [
  "usage: render-map.mts --page <path> [--config <architecture.yml>] [--root <dir>] [--region <name>] [--check]",
  "  --page     the markdown page carrying the generated region",
  "  --config   the layering declaration (default: <root>/architecture.yml)",
  "  --root     the repository root (default: cwd)",
  `  --region   the generated region's name (default: ${DEFAULT_REGION})`,
  "  --check    exit 1 when the committed region differs, instead of rewriting it",
  "exits: 0 written or already current; 1 drift under --check; 2 usage, no region, or an unreadable declaration",
].join("\n");

// Above the self-build: a cold install with no network still answers --help.
if (import.meta.main && (process.argv[2] === "--help" || process.argv[2] === "-h")) {
  console.log(USAGE);
  process.exit(0);
}

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

function build(source: string, scripts: string, skill: string, built: string): boolean {
  // bun build resolves installed packages only, from a node_modules beside the entry, and two first runs at
  // once must never share one: each build gets its own scratch under .build/ and publishes by one rename.
  mkdirSync(join(skill, ".build"), { recursive: true });
  const scratch = mkdtempSync(join(skill, ".build", "scratch-"));
  try {
    cpSync(scripts, join(scratch, "scripts"), { recursive: true });
    copyFileSync(join(skill, "package.json"), join(scratch, "package.json"));
    const entry = join(scratch, "scripts", relative(scripts, source));
    const bundle = join(scratch, "bundle.js");
    const ok =
      runBun(["install", "--production", "--no-save", "--cwd", scratch]) &&
      runBun(["build", entry, "--target", "bun", "--outfile", bundle]);
    if (!ok) return false;
    mkdirSync(dirname(built), { recursive: true });
    renameSync(bundle, built);
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function ensureBuilt(source: string): boolean {
  if (!source.endsWith(".mts")) return false;
  const { scripts, skill, built } = buildPaths(source);
  if (buildIsStale(scripts, skill, built) && !build(source, scripts, skill, built)) process.exit(2);
  const run = spawnSync("bun", [built, ...process.argv.slice(2)], { stdio: "inherit" });
  // A bundle killed by a signal has no status: die of the same signal.
  if (run.signal) process.kill(process.pid, run.signal);
  process.exitCode = run.status ?? 1;
  return true;
}

// Only the command builds; a test or a sibling importing this file must not.
if (import.meta.main && ensureBuilt(import.meta.path)) process.exit();

// Loaded below the guard: a static import is hoisted above it and would resolve on the source path.
const { DEFAULT_CONFIG, readArchitecture, renderArchitectureMermaid } = await import(
  "./declaration.mts"
);
const { readPage } = await import("./page.mts");
const { pathLabel } = await import("./paths.mts");

// A marker name is one token to the page reader, so a name with whitespace or markup could never be found; refusing it names the fix.
const REGION_NAME = /^[a-z0-9-]+$/;

/** Exactly one BEGIN then one END for `name`, else a throw naming the counts: a second marker pair would splice into the wrong one silently. */
export function regionBounds(text: string, name: string): { bodyStart: number; bodyEnd: number } {
  if (!REGION_NAME.test(name)) {
    throw new Error(`a region name is lowercase letters, digits, and dashes; got "${name}"`);
  }
  // Only a top-level marker is a region's: one quoted in a fence or under `> ` is page text about markers.
  const markers = readPage(text).markers.filter((marker) => marker.name === name);
  const begins = markers.filter((marker) => marker.kind === "BEGIN");
  const ends = markers.filter((marker) => marker.kind === "END");
  const [begin] = begins;
  const [end] = ends;
  if (begin === undefined || end === undefined || begins.length !== 1 || ends.length !== 1) {
    throw new Error(
      `region "${name}" needs exactly one BEGIN and one END marker, found ${begins.length} and ${ends.length}`,
    );
  }
  if (end.start < begin.end) {
    throw new Error(`region "${name}" has its END marker before its BEGIN marker`);
  }
  // The body runs from the BEGIN marker's line end, before whichever line ending CommonMark allows, to the END marker's line start (its indent stays).
  const lineEnd = text.slice(begin.end).search(/\r|\n/);
  return { bodyStart: lineEnd === -1 ? text.length : begin.end + lineEnd, bodyEnd: end.start };
}

export function spliceMap(text: string, name: string, map: string): string {
  const { bodyStart, bodyEnd } = regionBounds(text, name);
  return `${text.slice(0, bodyStart)}\n\`\`\`mermaid\n${map}\n\`\`\`\n${text.slice(bodyEnd)}`;
}

interface CliOptions {
  page: string;
  root: string;
  config: string;
  region: string;
  check: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let root = process.cwd();
  let page: string | undefined;
  let config: string | undefined;
  let region = DEFAULT_REGION;
  let check = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    if (arg === "--root") root = resolve(value());
    else if (arg === "--page") page = resolve(value());
    else if (arg === "--config") config = resolve(value());
    else if (arg === "--region") region = value();
    else if (arg === "--check") check = true;
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  if (page === undefined) throw new Error(`--page is required\n${USAGE}`);
  return { page, root, config: config ?? join(root, DEFAULT_CONFIG), region, check };
}

if (import.meta.main) {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const pageLabel = pathLabel(options.root, options.page);
  const configLabel = pathLabel(options.root, options.config);
  if (!existsSync(options.page)) {
    console.error(`render-architecture-map: ${pageLabel} does not exist`);
    process.exit(2);
  }
  try {
    const current = readFileSync(options.page, "utf8");
    const map = renderArchitectureMermaid(readArchitecture(options.config, configLabel));
    const next = spliceMap(current, options.region, map);
    if (next === current) {
      console.log(`render-architecture-map: ${pageLabel} region ${options.region} is current`);
    } else if (options.check) {
      console.error(
        `render-architecture-map: ${pageLabel} region ${options.region} differs from ${configLabel}; run without --check to rewrite it`,
      );
      process.exit(1);
    } else {
      writeFileSync(options.page, next);
      console.log(`render-architecture-map: wrote ${pageLabel} region ${options.region}`);
    }
  } catch (error) {
    console.error(
      `render-architecture-map: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
