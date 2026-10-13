#!/usr/bin/env bun
// One row per candidate name, one column per entry in columns/registries/table.mts: is it free there,
// does any language already own the word, does slang, is it one typo from a popular package, and can
// it be said as spelled? A registry cell is `free`, `taken(<why>)`, or `unknown(<why>)`, and a lookup
// that failed never reads as free; the say column is a `note(<reading>)`. Two controls run with
// every batch: per registry column, a name known to be taken there, and one random string that
// must be free everywhere. A column that answers either control wrongly is reported as a failed
// instrument and is not evidence. The flags and the exit codes are USAGE below; `--help` prints it.

import { spawnSync } from "node:child_process";
import { promises as dns } from "node:dns";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { domainToASCII } from "node:url";
import { parseArgs } from "node:util";
import {
  ARXIV_GAP_MS,
  type Column,
  CRATES_GAP_MS,
  GITHUB_SEARCH_GAP_ANONYMOUS_MS,
  GITHUB_SEARCH_GAP_MS,
  REGISTRIES,
  type RegistryEntry,
} from "./columns/registries/table.mts";
import { type Cell, type Claimed, type Io, renderCell, unknown } from "./core/cells.mts";

const USAGE = [
  "usage: check-name.mts [--domain <tld>]... [--registries <id,id,...>] [--no-arxiv] [--json] <name>...",
  "       check-name.mts --list-registries",
  "  --domain <tld>          a DNS column per zone (default: com, ai, dev; the list replaces the default)",
  "  --registries <id,...>   the availability columns to run; the gate columns run on every name regardless",
  "  --no-arxiv              skip the arXiv column (one request every three seconds)",
  "  --json                  one JSON object, rows and failures, instead of the table",
  "  --list-registries       the live column table: id, label, taken control, gate",
  "exits: 0 every row printed and every control answered as expected;",
  "       1 a control answered wrongly: the named columns are not evidence; 2 usage error",
].join("\n");

export type Row = { name: string; cells: Record<string, Cell> };

export const REQUEST_TIMEOUT_MS = 20_000;

export type Options = {
  table: readonly RegistryEntry[];
  /** The zones `tlds` returns, so each names a distinct column. */
  domains: string[];
  arxiv: boolean;
  /** The column ids to run, or null for every column. */
  registries: string[] | null;
};

/** Letters, digits, dashes, and dots, the Unicode full stops that IDNA maps to a dot included.
 * Anything else names no zone: a space, a comma that `--registries` splits on, or a slash,
 * which the host parser would silently drop together with everything after it. */
const ZONE_SPELLING = /^[\p{L}\p{M}\p{N}\p{Pd}.\u3002\uFF0E\uFF61]+$/u;
/** What a spelling must be once canonical: dot-separated labels of up to 63 letters, digits,
 * and inner dashes, the last with a letter in it, since a top-level domain is never all digits
 * and the host parser makes an IPv4 address of a hex or decimal spelling. */
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
  const { zones: domains, rejected } = tlds(
    (parsed.values.domain as string[] | undefined) ?? ["com", "ai", "dev"],
  );
  if (rejected.length > 0) {
    process.stderr.write(
      `--domain: not a top-level domain: ${rejected.map((spelling) => JSON.stringify(spelling)).join(", ")}\n`,
    );
    return 2;
  }
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
  if (selected && !columns(options).some((column) => selected.includes(column.id))) {
    process.stderr.write("--registries and --no-arxiv together leave no column of the selection\n");
    return 2;
  }
  const githubToken = githubTokenFromEnvironment();
  const io: Io = {
    fetch: (url, init) => fetch(url, init),
    resolve: (host) => dns.lookup(host),
    resolveNs: (zone) => dns.resolveNs(zone),
    githubToken,
    timeoutMs: REQUEST_TIMEOUT_MS,
    arxivGapMs: ARXIV_GAP_MS,
    githubSearchGapMs: githubToken ? GITHUB_SEARCH_GAP_MS : GITHUB_SEARCH_GAP_ANONYMOUS_MS,
    cratesGapMs: CRATES_GAP_MS,
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
