// The typosquat column: is the name one edit away from a popular package on PyPI, npm, or crates?
// Each registry's popular names come from one public list, read through core/cache.mts.

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Cell, Claimed, Io } from "../core/cells.mts";

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

function ensureBuilt(source: string): Promise<boolean> {
  if (!source.endsWith(".mts")) return Promise.resolve(false);
  const { scripts, skill, built } = buildPaths(source);
  if (buildIsStale(scripts, skill, built) && !build(source, scripts, skill, built)) process.exit(2);
  // The bundle runs on this process's stdio, and a signal to this process goes on to it; this process then ends as
  // the bundle did, by its status, or by the same signal once the forwarding is off and the signal's default is back.
  const run = spawn("bun", [built, ...process.argv.slice(2)], { stdio: "inherit" });
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const forward = (signal: NodeJS.Signals) => {
    run.kill(signal);
  };
  for (const signal of signals) process.on(signal, forward);
  return new Promise((resolve) => {
    const settle = (status: number | null, signal: NodeJS.Signals | null) => {
      for (const name of signals) process.off(name, forward);
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = status ?? 1;
      resolve(true);
    };
    run.on("exit", settle);
    // A bundle that never started (no bun on PATH) emits error and no exit: that is the run's failure.
    run.on("error", (error) => {
      console.error(String(error));
      settle(1, null);
    });
  });
}

// Only the command builds; a test or a sibling importing this file must not.
if (import.meta.main && (await ensureBuilt(import.meta.path))) process.exit();

// Loaded below the guard: a static import is hoisted above it and would resolve on the source path.

const { cached, stringList } = await import("../core/cache.mts");
const { free, serialQueue, taken, unknown } = await import("../core/cells.mts");

/** The top of each download ranking; names past this are not what a typo lands on. */
export const RANKING_TOP = 5_000;

/** crates.io publishes no ranking file, and its search returns what matches the name, not the popular crate one edit away; so its crate list sorted by downloads is read whole, this many pages. */
export const CRATES_PAGES = 20;

/** The crates a page of that list holds, the most crates.io serves. */
export const CRATES_PER_PAGE = 100;

/** How many names a list holds when it is whole. A list is read for the names a typo lands on,
 * so one cut on the way (a proxy, a page served half) would read every name past the cut as
 * free: it is a malformed reply, and so is one cached short by an earlier build. */
type Size = { exactly: number } | { atLeast: number };

/** PyPI's list publishes 15,000 names and npm's about 16,000; each is read for its top RANKING_TOP, so one under that was cut. */
const RANKING_FLOOR: Size = { atLeast: RANKING_TOP };

/** The registry holds hundreds of thousands of crates, so every page the lane reads is full. */
const CRATES_PAGE_SIZE: Size = { exactly: CRATES_PER_PAGE };

/** Every request to crates.io, the per-name lookups and the ranking pages alike: its crawler policy asks for one request a second and a User-Agent that says who is asking. */
export const cratesQueue = serialQueue();

function oneSubstitutionOrSwapApart(a: string, b: string): boolean {
  const differ: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differ.push(i);
  if (differ.length === 1) return true;
  if (differ.length !== 2) return false;

  const [i, j] = differ as [number, number];
  return j === i + 1 && a[i] === b[j] && a[j] === b[i];
}

function oneDeletionApart(long: string, short: string): boolean {
  let skipped = false;
  for (let i = 0, j = 0; i < long.length; i++) {
    if (long[i] === short[j]) j++;
    else if (skipped) return false;
    else skipped = true;
  }

  return true;
}

/** True when `b` is one insertion, deletion, substitution, or adjacent transposition from `a`.
 * Hand-rolled: shipped skill scripts run from the installed folder on node built-ins alone, and
 * the bound-1 check is a few lines where the general Damerau-Levenshtein algorithm is a library. */
export function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) return oneSubstitutionOrSwapApart(a, b);

  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return oneDeletionApart(long, short);
}

/** The strings `pick` finds in the JSON list at `path`. Anything else is a malformed reply and
 * throws, never an empty list, since an empty list would read as "no popular name is near". */
function stringsOf(json: string, path: string[], pick: (item: unknown) => unknown): string[] {
  let node: unknown = JSON.parse(json);
  for (const key of path) {
    if (typeof node !== "object" || node === null) throw new Error(`no ${path.join(".")}`);
    node = (node as Record<string, unknown>)[key];
  }
  if (!Array.isArray(node)) throw new Error(`${path.join(".")} is not a list`);
  return node.map((item) => {
    const value = pick(item);
    if (typeof value !== "string") throw new Error(`an entry of ${path.join(".")} has no name`);
    return value;
  });
}

type Source =
  | { registry: string; names: string[]; basis: string }
  | { registry: string; error: string };

type PopularList = {
  registry: string;
  label: string;
  url: string;
  basis: string;
  extract: (text: string) => string[];
  revive: (stored: unknown) => string[] | null;
};

async function source(io: Io, list: PopularList): Promise<Source> {
  const { registry, label, basis } = list;
  const loaded = await cached(io, list);
  if ("error" in loaded) return { registry, error: `${label} ${loaded.error}` };
  return { registry, names: loaded.value, basis };
}

function shortfall(count: number, size: Size): string | null {
  if ("exactly" in size) {
    return count === size.exactly ? null : `${count} entries, expected ${size.exactly}`;
  }
  return count >= size.atLeast ? null : `${count} entries, expected at least ${size.atLeast}`;
}

function whole(names: string[], what: string, size: Size): string[] {
  const short = shortfall(names.length, size);
  if (short) throw new Error(`${what} has ${short}`);
  return names;
}

function wholeStringList(size: Size): (stored: unknown) => string[] | null {
  return (stored) => {
    const list = stringList(stored);
    return list && shortfall(list.length, size) === null ? list : null;
  };
}

// The project publishes the ranking at hugovk.github.io, which redirects here.
export const PYPI_TOP_URL = "https://hugovk.dev/top-pypi-packages/top-pypi-packages.min.json";

/** npm publishes no ranking and its search matches whole words (a one-letter typo returns nothing), so the list is npm-high-impact's by-downloads ranking of the packages npm itself calls high-impact. */
const NPM_TOP_URL = "https://cdn.jsdelivr.net/npm/npm-high-impact@1/lib/top-download.js";

function quotedNames(moduleText: string): string[] {
  const exported = /^export const \w+ = \[([^\]]*)\]/m.exec(moduleText);
  if (!exported) throw new Error("not a module exporting one array");
  return [...(exported[1] ?? "").matchAll(/'([^'\n]+)'/g)].map((match) => match[1] ?? "");
}

function cratesPage(page: number): string {
  return `https://crates.io/api/v1/crates?sort=downloads&per_page=${CRATES_PER_PAGE}&page=${page}`;
}

/** The ranking page by page, in turn, each kept a day: a page that could not be read fails the
 * list, since the names past it were never compared. */
async function cratesRanking(io: Io): Promise<Source> {
  const names: string[] = [];
  for (let page = 1; page <= CRATES_PAGES; page++) {
    const loaded = await cached(io, {
      url: cratesPage(page),
      extract: (text) =>
        whole(
          stringsOf(text, ["crates"], (crate) => (crate as { name?: unknown }).name),
          "page",
          CRATES_PAGE_SIZE,
        ),
      revive: wholeStringList(CRATES_PAGE_SIZE),
      through: (work) => cratesQueue(io.cratesGapMs, work),
    });
    if ("error" in loaded) {
      return { registry: "crates", error: `crates ranking page ${page} ${loaded.error}` };
    }
    names.push(...loaded.value);
  }
  return {
    registry: "crates",
    names,
    basis: `top ${CRATES_PAGES * CRATES_PER_PAGE} by downloads`,
  };
}

function sources(io: Io): Promise<Source>[] {
  const ranking = `top ${RANKING_TOP} by downloads`;
  return [
    source(io, {
      registry: "pypi",
      label: "top-pypi-packages",
      url: PYPI_TOP_URL,
      basis: ranking,
      extract: (text) =>
        whole(
          stringsOf(text, ["rows"], (row) => (row as { project?: unknown }).project),
          "rows",
          RANKING_FLOOR,
        ).slice(0, RANKING_TOP),
      revive: wholeStringList(RANKING_FLOOR),
    }),
    source(io, {
      registry: "npm",
      label: "npm-high-impact",
      url: NPM_TOP_URL,
      basis: ranking,
      extract: (text) =>
        whole(quotedNames(text), "the module", RANKING_FLOOR).slice(0, RANKING_TOP),
      revive: wholeStringList(RANKING_FLOOR),
    }),
    cratesRanking(io),
  ];
}

/** Every source's outcome is in the cell: a source that could not be read is named beside the
 * hits, since the name may be one edit from what it would have shown, and with no hit it is the
 * cell. A hit on an unclaimed registry alone must not read as a complete check of the claimed one. */
export async function typosquat(io: Io, name: string, claimed: Claimed): Promise<Cell> {
  const lower = name.toLowerCase();
  const hits: string[] = [];
  const failures: string[] = [];
  for (const found of await Promise.all(sources(io))) {
    const registry = `${claimed(found.registry) ? "claimed" : "unclaimed"} ${found.registry}`;
    if ("error" in found) {
      failures.push(`${registry} lookup failed (${found.error})`);
      continue;
    }
    const near = found.names.find((candidate) => oneEditApart(lower, candidate.toLowerCase()));
    if (near) hits.push(`1 edit from ${near} on ${registry} (${found.basis})`);
  }
  const detail = [...hits, ...failures].join("; ");
  if (hits.length > 0) return taken(detail);
  if (failures.length > 0) return unknown(detail);
  return free;
}
