#!/usr/bin/env bun
// One row per candidate name, one column per entry in columns/registries/table.mts: is it free there,
// does any language already own the word, does slang, is it one typo from a popular package, and can
// it be said as spelled? A registry cell is `free`, `taken(<why>)`, or `unknown(<why>)`, and a lookup
// that failed never reads as free; the say column is a `note(<reading>)`. Two controls run with
// every batch: per registry column, a name known to be taken there, and one random string that
// must be free everywhere. A column that answers either control wrongly is reported as a failed
// instrument and is not evidence. The flags and the exit codes are USAGE below; `--help` prints it.

import { spawn, spawnSync } from "node:child_process";
import { promises as dns } from "node:dns";
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
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { domainToASCII } from "node:url";
import { parseArgs } from "node:util";
import type { Column, RegistryEntry } from "./columns/registries/table.mts";
import type { Cell, Claimed, Io } from "./core/cells.mts";

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

const { GITHUB_STARS_TAKEN_DEFAULT } = await import("./columns/registries/readers.mts");
const {
  ARXIV_GAP_MS,
  CRATES_GAP_MS,
  GITHUB_SEARCH_GAP_ANONYMOUS_MS,
  GITHUB_SEARCH_GAP_MS,
  REGISTRIES,
} = await import("./columns/registries/table.mts");
const { RATE_LIMIT_BASE_MS, renderCell, unknown } = await import("./core/cells.mts");

const USAGE = [
  "usage: check-name.mts [--domain <tld>]... [--registries <id,id,...>] [--github-stars <n>] [--no-arxiv] [--json] <name>...",
  "       check-name.mts --list-registries",
  "  --domain <tld>          a DNS column per zone (default: com, ai, dev; the list replaces the default)",
  "  --registries <id,...>   the availability columns to run; the gate columns run on every name regardless",
  "  --github-stars <n>      stars from which an exact-name GitHub repository is taken (default 1000); one with 20 or more stars under it reads free(repo with <n> stars)",
  "  --no-arxiv              skip the arXiv column (one request every three seconds)",
  "  --json                  one JSON object, rows and failures, instead of the table",
  "  --list-registries       the live column table: id, label, taken control, gate",
  "exits: 0 every row printed and every control answered as expected;",
  "       1 a control answered wrongly: the named columns are not evidence; 2 usage error",
].join("\n");

export type Row = { name: string; cells: Record<string, Cell> };

export const REQUEST_TIMEOUT_MS = 20_000;

export type Options = {
  /** REGISTRIES in a run; a test passes a table of its own. */
  table: readonly RegistryEntry[];

  /** The zones `tlds` returns, so each names a distinct column. */
  domains: string[];

  /** False under `--no-arxiv`, which drops the arxiv column from the run. */
  arxiv: boolean;

  /** The column ids to run, or null for every column. */
  registries: string[] | null;
};

// A `--domain` spelling is screened before the host parser sees it, and the canonical zone after
// it: the parser silently drops a slash together with everything after it, and makes an IPv4
// address of a hex or decimal last label.

/** Letters, digits, dashes, and dots, the Unicode full stops that IDNA maps to a dot included; a space, a comma that `--registries` splits on, or a slash names no zone. */
const ZONE_SPELLING = /^[\p{L}\p{M}\p{N}\p{Pd}.\u3002\uFF0E\uFF61]+$/u;

/** What a spelling must be once canonical: dot-separated labels of up to 63 letters, digits, and inner dashes, the last with a letter in it, since a top-level domain is never all digits. */
const ZONE =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*(?=[a-z0-9-]*[a-z])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A host name is at most 253 characters and a name at most 39, so this leaves room for any. */
const ZONE_MAX = 213;

/** The distinct zones the `--domain` spellings name, first-seen order, and the spellings that
 * name none. DNS is case-insensitive, a dot on either end spells the same zone, and a Unicode
 * zone is looked up by its punycode form, so `COM`, `.com`, and `com.` are one zone, and a
 * Unicode zone is the same zone as its `xn--` spelling, not two readings of one record. */
export function tlds(spellings: readonly string[]): { zones: string[]; rejected: string[] } {
  const zones = new Set<string>();
  const rejected: string[] = [];
  for (const spelling of spellings) {
    const zone = ZONE_SPELLING.test(spelling)
      ? domainToASCII(spelling).replace(/^\.+|\.+$/g, "")
      : "";
    if (ZONE.test(zone) && zone.length <= ZONE_MAX) zones.add(zone);
    else rejected.push(spelling);
  }
  return { zones: [...zones], rejected };
}

export function allColumns(table: readonly RegistryEntry[], domains: string[]): Column[] {
  return table.flatMap((entry) => (entry.kind === "domains" ? domains.map(entry.forTld) : [entry]));
}

export function claimed(options: Options): Claimed {
  return (id) => options.registries === null || options.registries.includes(id);
}

/** The availability columns `--registries` names, or all of them, and the gate columns always:
 * a selective run never skips the pronunciation, typosquat, and meaning checks. */
export function columns(options: Options): Column[] {
  const isClaimed = claimed(options);
  return allColumns(options.table, options.domains).filter(
    (column) => (options.arxiv || column.id !== "arxiv") && (column.gate || isClaimed(column.id)),
  );
}

export async function checkName(io: Io, options: Options, name: string): Promise<Row> {
  const cols = columns(options);
  const isClaimed = claimed(options);
  const cells = await Promise.all(cols.map((column) => column.lookup(io, name, isClaimed)));
  return {
    name,
    cells: Object.fromEntries(cols.map((column, i) => [column.id, cells[i] ?? unknown("missing")])),
  };
}

/** A string no registry has: letters only, so every registry accepts it as a name. */
export function nonsenseName(random: () => number = Math.random): string {
  const alphabet = "bcdfghjklmnpqrstvwxz";
  let out = "zq";
  for (let i = 0; i < 12; i++) out += alphabet[Math.floor(random() * alphabet.length)];
  return out;
}

export type ControlVerdict = {
  column: string;
  control: string;
  expected: "taken" | "free";
  got: Cell;
};

/** One taken-control lookup per registry column (its own control name), and one random-name row.
 * A note column reads the name itself and has nothing to be right or wrong about. */
export async function runControls(
  io: Io,
  options: Options,
  freeControl: string,
): Promise<ControlVerdict[]> {
  const cols = columns(options).filter((column) => column.kind === "registry");
  const isClaimed = claimed(options);
  const [takenCells, freeRow] = await Promise.all([
    Promise.all(cols.map((column) => column.lookup(io, column.takenControl, isClaimed))),
    checkName(io, options, freeControl),
  ]);
  const failures: ControlVerdict[] = [];
  cols.forEach((column, i) => {
    const got = takenCells[i] ?? unknown("missing");
    const holds = column.controlHolds ?? ((cell: Cell) => cell.status === "taken");
    if (!holds(got)) {
      failures.push({ column: column.id, control: column.takenControl, expected: "taken", got });
    }
    const freeCell = freeRow.cells[column.id] ?? unknown("missing");
    if (freeCell.status !== "free") {
      failures.push({ column: column.id, control: freeControl, expected: "free", got: freeCell });
    }
  });
  return failures;
}

export function renderTsv(options: Options, rows: Row[]): string {
  const cols = columns(options);
  const lines = [["name", ...cols.map((c) => c.id)].join("\t")];
  for (const row of rows) {
    lines.push(
      [row.name, ...cols.map((c) => renderCell(row.cells[c.id] ?? unknown("missing")))].join("\t"),
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderRegistries(table: readonly RegistryEntry[]): string {
  const lines = ["id\tlabel\ttaken control\tgate"];
  for (const entry of table) {
    const control = entry.kind === "note" ? "-" : entry.takenControl;
    const gate = entry.kind !== "domains" && entry.gate ? "yes" : "-";
    lines.push([entry.id, entry.label, control, gate].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

export type RunResult = { rows: Row[]; failures: ControlVerdict[] };

export async function run(io: Io, options: Options, names: string[]): Promise<RunResult> {
  const [failures, ...rows] = await Promise.all([
    runControls(io, options, nonsenseName()),
    ...names.map((name) => checkName(io, options, name)),
  ]);
  return { rows, failures };
}

function githubTokenFromEnvironment(): string | null {
  const fromEnv = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;
  const result = spawnSync("gh", ["auth", "token"], { encoding: "utf-8" });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return null;
}

function liveIo(githubStarsTaken: number): Io {
  const githubToken = githubTokenFromEnvironment();
  return {
    githubStarsTaken,
    fetch: (url, init) => fetch(url, init),
    resolve: (host) => dns.lookup(host),
    resolveNs: (zone) => dns.resolveNs(zone),
    githubToken,
    timeoutMs: REQUEST_TIMEOUT_MS,
    arxivGapMs: ARXIV_GAP_MS,
    githubSearchGapMs: githubToken ? GITHUB_SEARCH_GAP_MS : GITHUB_SEARCH_GAP_ANONYMOUS_MS,
    cratesGapMs: CRATES_GAP_MS,
    cacheDir: join(tmpdir(), "check-name-cache"),
    retryBaseMs: RATE_LIMIT_BASE_MS,
  };
}

type Flags = ReturnType<typeof parseArgs>["values"];

/** The Options the flags name, or the usage error that stops the run: a `--domain` spelling that
 * names no zone, a `--registries` id no column has, or a selection `--no-arxiv` leaves empty. */
export function optionsFrom(
  flags: Flags,
): { options: Options; githubStars: number } | { error: string } {
  const starsFlag = flags["github-stars"] as string | undefined;
  if (starsFlag !== undefined && !/^[1-9]\d*$/.test(starsFlag)) {
    return { error: `--github-stars: a positive whole number, not ${JSON.stringify(starsFlag)}` };
  }
  const githubStars = starsFlag === undefined ? GITHUB_STARS_TAKEN_DEFAULT : Number(starsFlag);

  const spellings = (flags.domain as string[] | undefined) ?? ["com", "ai", "dev"];
  const { zones: domains, rejected } = tlds(spellings);
  if (rejected.length > 0) {
    const quoted = rejected.map((spelling) => JSON.stringify(spelling)).join(", ");
    return { error: `--domain: not a top-level domain: ${quoted}` };
  }

  const selected =
    (flags.registries as string | undefined)?.split(",").map((id) => id.trim()) ?? null;
  const known = allColumns(REGISTRIES, domains).map((column) => column.id);
  const bad = (selected ?? []).filter((id) => !known.includes(id));
  if (bad.length > 0) {
    const quoted = bad.map((id) => JSON.stringify(id)).join(", ");
    return {
      error: `--registries: no column ${quoted}; the columns for these domains are ${known.join(", ")}`,
    };
  }

  const options: Options = {
    table: REGISTRIES,
    domains,
    arxiv: !(flags["no-arxiv"] as boolean | undefined),
    registries: selected,
  };
  if (selected && !columns(options).some((column) => selected.includes(column.id))) {
    return { error: "--registries and --no-arxiv together leave no column of the selection" };
  }

  return { options, githubStars };
}

async function main(): Promise<number> {
  const first = process.argv[2];
  if (first === "--help" || first === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        domain: { type: "string", multiple: true },
        registries: { type: "string" },
        "list-registries": { type: "boolean" },
        "github-stars": { type: "string" },
        "no-arxiv": { type: "boolean" },
        json: { type: "boolean" },
      },
    });
  } catch (error) {
    process.stderr.write(`${String(error)}\n${USAGE}\n`);
    return 2;
  }

  if (parsed.values["list-registries"]) {
    process.stdout.write(renderRegistries(REGISTRIES));
    return 0;
  }

  const names = parsed.positionals;
  if (names.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }

  // The strictest common rule, GitHub's handle: letters and digits, single dashes between them,
  // 39 characters at most. A name outside it reads free on a registry that would refuse it.
  const bad = names.find((name) => !/^[A-Za-z](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(name));
  if (bad) {
    process.stderr.write(
      `name must be letters and digits with single dashes between, starting with a letter, at most 39 characters: ${bad}\n`,
    );
    return 2;
  }

  const read = optionsFrom(parsed.values);
  if ("error" in read) {
    process.stderr.write(`${read.error}\n`);
    return 2;
  }

  const result = await run(liveIo(read.githubStars), read.options, names);
  if (parsed.values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(renderTsv(read.options, result.rows));
  }

  for (const failure of result.failures) {
    process.stderr.write(
      `instrument failed: ${failure.column} read ${renderCell(failure.got)} for ${failure.control}, expected ${failure.expected}; do not trust that column\n`,
    );
  }
  return result.failures.length > 0 ? 1 : 0;
}

// exitCode, not process.exit(): a long table on a piped stdout drains fully before the end.
if (import.meta.main) {
  process.exitCode = await main();
}
