#!/usr/bin/env bun
// One row per candidate name, one column per entry in registries.mts: is it free there, does any
// language already own the word, does slang, is it one typo from a popular package, and can it be
// said as spelled? A registry cell is `free`, `taken(<why>)`, or `unknown(<why>)`, and a lookup
// that failed never reads as free; the say column is a `note(<reading>)`. Two controls run with
// every batch: per registry column, a name known to be taken there, and one random string that
// must be free everywhere. A column that answers either control wrongly is reported as a failed
// instrument and is not evidence.
//
// Exit codes:
//   0  every row printed and every control answered as expected
//   1  a control answered wrongly: the named columns are not evidence
//   2  usage error

import { spawnSync } from "node:child_process";
import { promises as dns } from "node:dns";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { type Cell, type Claimed, type Io, renderCell, unknown } from "./cells.mts";
import { type Column, REGISTRIES, type RegistryEntry } from "./registries.mts";

const USAGE =
  "usage: check-name.mts [--domain <tld>]... [--registries <id,id,...>] [--no-arxiv] [--json] <name>...\n" +
  "       check-name.mts --list-registries";

export type Row = { name: string; cells: Record<string, Cell> };

export const REQUEST_TIMEOUT_MS = 20_000;
export const ARXIV_GAP_MS = 3_000;
/** GitHub's search limit is 30 a minute with a token and 10 without. */
export const GITHUB_SEARCH_GAP_MS = 2_000;
export const GITHUB_SEARCH_GAP_ANONYMOUS_MS = 6_000;

export type Options = {
  table: readonly RegistryEntry[];
  domains: string[];
  arxiv: boolean;
  /** The column ids to run, or null for every column. */
  registries: string[] | null;
};

export function allColumns(table: readonly RegistryEntry[], domains: string[]): Column[] {
  return table.flatMap((entry) => (entry.kind === "domains" ? domains.map(entry.forTld) : [entry]));
}

export function claimed(options: Options): Claimed {
  return (id) => options.registries === null || options.registries.includes(id);
}

export function columns(options: Options): Column[] {
  const isClaimed = claimed(options);
  return allColumns(options.table, options.domains).filter(
    (column) => (options.arxiv || column.id !== "arxiv") && isClaimed(column.id),
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
  const lines = ["id\tlabel\ttaken control"];
  for (const entry of table) {
    const control = entry.kind === "note" ? "-" : entry.takenControl;
    lines.push([entry.id, entry.label, control].join("\t"));
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

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        domain: { type: "string", multiple: true },
        registries: { type: "string" },
        "list-registries": { type: "boolean" },
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
  const domains = (parsed.values.domain as string[] | undefined) ?? ["com", "ai", "dev"];
  const selected =
    (parsed.values.registries as string | undefined)?.split(",").map((id) => id.trim()) ?? null;
  if (selected) {
    const known = allColumns(REGISTRIES, domains).map((column) => column.id);
    const bad = selected.filter((id) => !known.includes(id));
    if (bad.length > 0) {
      process.stderr.write(
        `--registries: no column ${bad.map((id) => JSON.stringify(id)).join(", ")}; the columns for these domains are ${known.join(", ")}\n`,
      );
      return 2;
    }
  }
  const options: Options = {
    table: REGISTRIES,
    domains,
    arxiv: !(parsed.values["no-arxiv"] as boolean | undefined),
    registries: selected,
  };
  if (columns(options).length === 0) {
    process.stderr.write("--registries and --no-arxiv together leave no column to check\n");
    return 2;
  }
  const githubToken = githubTokenFromEnvironment();
  const io: Io = {
    fetch: (url, init) => fetch(url, init),
    resolve: (host) => dns.lookup(host),
    githubToken,
    timeoutMs: REQUEST_TIMEOUT_MS,
    arxivGapMs: ARXIV_GAP_MS,
    githubSearchGapMs: githubToken ? GITHUB_SEARCH_GAP_MS : GITHUB_SEARCH_GAP_ANONYMOUS_MS,
    cacheDir: join(tmpdir(), "check-name-cache"),
  };
  const result = await run(io, options, names);
  if (parsed.values.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(renderTsv(options, result.rows));
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
