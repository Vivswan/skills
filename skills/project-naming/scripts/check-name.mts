#!/usr/bin/env bun
// One row per candidate name: is it free on each registry, does any language already own the
// word, and does slang? Every cell is `free`, `taken(<why>)`, or `unknown(<why>)`; a lookup that
// failed never reads as free. Two controls run with every batch: per column, a name known to be
// taken there, and one random string that must be free everywhere. A column that answers either
// control wrongly is reported as a failed instrument and is not evidence.
//
// Exit codes:
//   0  every row printed and every control answered as expected
//   1  a control answered wrongly: the named columns are not evidence
//   2  usage error

import { spawnSync } from "node:child_process";
import { promises as dns } from "node:dns";
import { parseArgs } from "node:util";

const USAGE = "usage: check-name.mts [--domain <tld>]... [--no-arxiv] [--json] <name>...";

export type Cell =
  | { status: "free" }
  | { status: "taken"; detail: string }
  | { status: "unknown"; detail: string };

export type Row = { name: string; cells: Record<string, Cell> };

export type Io = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Resolves a hostname to at least one address, or throws (ENOTFOUND for an unregistered name). */
  resolve: (host: string) => Promise<unknown>;
  githubToken: string | null;
};

export type Options = {
  domains: string[];
  arxiv: boolean;
};

/** Stars at or above which an exact-name GitHub repository counts as taken. */
export const GITHUB_STARS_TAKEN = 20;
/** GitHub search serves at most 1000 results; past that an exact-name hit cannot be ruled out. */
const GITHUB_SEARCH_PAGES = 10;

const USER_AGENT = "check-name.mts (project-naming skill; https://github.com/Vivswan/skills)";

/** Register labels Wiktionary puts in `{{lb|<lang>|...}}` on a sense, canonical names and their
 * aliases; any one makes the sense a flag. Any label ending in "slur" (ethnic, racial, religious)
 * counts too. */
const OFFENSIVE_LABELS = new Set([
  "vulgar",
  "coarse",
  "obscene",
  "profane",
  "profanity",
  "swear word",
  "offensive",
  "derogatory",
  "disparaging",
  "pejorative",
  "slur",
]);

function isOffensiveLabel(label: string): boolean {
  return OFFENSIVE_LABELS.has(label) || label.endsWith(" slur");
}

/** Per column, a name known to be taken there. Each DNS column uses the registry's own `nic` host. */
export const TAKEN_CONTROL: Record<string, string> = {
  pypi: "requests",
  npm: "react",
  crates: "serde",
  hf: "google",
  "github-user": "torvalds",
  "github-repo": "linux",
  arxiv: "transformer",
  wiktionary: "pajero",
  urban: "yeet",
};
const DNS_TAKEN_CONTROL = "nic";

export const WIKTIONARY_FLAG = "FLAG ";

const free: Cell = { status: "free" };
const taken = (detail: string): Cell => ({ status: "taken", detail });
const unknown = (detail: string): Cell => ({ status: "unknown", detail });

async function get(io: Io, url: string, headers: Record<string, string> = {}): Promise<Response> {
  return io.fetch(url, {
    redirect: "manual",
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers },
  });
}

/** 404 is free and 200 is taken; anything else is a reading the caller cannot use. */
async function registry(io: Io, url: string, label: string): Promise<Cell> {
  try {
    const response = await get(io, url);
    if (response.status === 404) return free;
    if (response.status === 200) return taken(label);
    return unknown(`${label} HTTP ${response.status}`);
  } catch (error) {
    return unknown(`${label} ${String(error)}`);
  }
}

/** Users and organizations share one namespace, so the handle is taken when either endpoint has
 * it. A 307 is the redirect to the canonical casing of a handle that exists under another. */
async function huggingFace(io: Io, name: string): Promise<Cell> {
  const readings: Cell[] = [];
  for (const kind of ["users", "organizations"] as const) {
    const label = kind === "users" ? "hf user" : "hf org";
    try {
      const response = await get(io, `https://huggingface.co/api/${kind}/${name}/overview`);
      if (response.status === 404) readings.push(free);
      else if (response.status === 200) readings.push(taken(label));
      else if ([301, 302, 307].includes(response.status)) {
        readings.push(taken(`${label} exists under another casing`));
      } else readings.push(unknown(`${label} HTTP ${response.status}`));
    } catch (error) {
      readings.push(unknown(`${label} ${String(error)}`));
    }
  }
  return (
    readings.find((cell) => cell.status === "taken") ??
    readings.find((cell) => cell.status === "unknown") ??
    free
  );
}

function githubHeaders(io: Io): Record<string, string> {
  return io.githubToken ? { authorization: `Bearer ${io.githubToken}` } : {};
}

async function githubUser(io: Io, name: string): Promise<Cell> {
  try {
    const response = await get(io, `https://api.github.com/users/${name}`, githubHeaders(io));
    if (response.status === 404) return free;
    if (response.status === 200) return taken("github handle");
    return unknown(`github HTTP ${response.status}`);
  } catch (error) {
    return unknown(`github ${String(error)}`);
  }
}

type GithubSearch = {
  incomplete_results?: boolean;
  items?: { name: string; stargazers_count: number }[];
};

/** The search matches the name as a substring, sorted by stars, so the first exact-name hit is the
 * best-starred one and decides the cell. Pages are read until that hit, or until the stars fall
 * under the threshold, past which no exact-name repository can count. Forks are excluded by
 * default and a starred fork holds the name as firmly, so they are asked for. */
async function githubRepo(io: Io, name: string): Promise<Cell> {
  const query = encodeURIComponent(`${name} in:name fork:true`);
  for (let page = 1; page <= GITHUB_SEARCH_PAGES; page++) {
    const url = `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=100&page=${page}`;
    let body: GithubSearch;
    try {
      const response = await get(io, url, githubHeaders(io));
      if (response.status !== 200) return unknown(`github search HTTP ${response.status}`);
      body = (await response.json()) as GithubSearch;
    } catch (error) {
      return unknown(`github search ${String(error)}`);
    }
    if (body.incomplete_results) return unknown("github search reported incomplete results");
    const items = body.items ?? [];
    const exact = items.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (exact) {
      if (exact.stargazers_count >= GITHUB_STARS_TAKEN) {
        return taken(`repo with ${exact.stargazers_count} stars`);
      }
      return free;
    }
    // A short page is the last one; a full page ending under the threshold has shown every
    // repository that could count.
    const last = items[items.length - 1];
    if (!last || items.length < 100 || last.stargazers_count < GITHUB_STARS_TAKEN) return free;
  }
  return unknown(
    `github search: over ${GITHUB_SEARCH_PAGES * 100} repos named like it above ${GITHUB_STARS_TAKEN} stars`,
  );
}

/** Papers whose title carries the name. The export API rate-limits after a few dozen calls. */
async function arxiv(io: Io, name: string): Promise<Cell> {
  const query = encodeURIComponent(`ti:"${name}"`);
  const url = `https://export.arxiv.org/api/query?search_query=${query}&max_results=0`;
  try {
    const response = await get(io, url, { accept: "application/atom+xml" });
    if (response.status === 429) return unknown("arxiv rate-limited; retry later");
    if (response.status !== 200) return unknown(`arxiv HTTP ${response.status}`);
    const match = /<opensearch:totalResults[^>]*>(\d+)</.exec(await response.text());
    if (!match) return unknown("arxiv reply had no totalResults");
    const count = Number(match[1]);
    return count === 0 ? free : taken(`${count} paper title(s)`);
  } catch (error) {
    return unknown(`arxiv ${String(error)}`);
  }
}

async function domain(io: Io, name: string, tld: string): Promise<Cell> {
  const host = `${name}.${tld}`;
  try {
    await io.resolve(host);
    return taken(`${host} resolves`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return free;
    return unknown(`${host} ${code ?? String(error)}`);
  }
}

type WikitextReply = { parse?: { wikitext?: string }; error?: { code?: string } };

/** Wikitext to a readable gloss: links keep their shown text, label templates go, any other
 * template keeps its last unnamed argument (`{{synonym of|en|penis}}` reads "penis"). */
function plainGloss(line: string): string {
  return line
    .replace(/^#+\s*/, "")
    .replace(/\{\{(?:lb|lbl|label|tlb|term-label)\|[^}]*\}\}/g, "")
    .replace(/\{\{([^}]*)\}\}/g, (_, inner: string) => {
      const unnamed = inner
        .split("|")
        .slice(1)
        .filter((arg) => !arg.includes("="));
      return unnamed[unnamed.length - 1] ?? "";
    })
    .replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2")
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The arguments of the label templates on one line: `{{lb|<lang>|a|b}}` and its aliases `label`
 * and `lbl` on a sense line, `{{tlb|<lang>|a|b}}` or `{{term-label|...}}` on a headword line. */
function registerLabels(line: string): string[] {
  const labels: string[] = [];
  for (const match of line.matchAll(/\{\{(?:lb|lbl|label|tlb|term-label)\|[^|}]*\|([^}]*)\}\}/g)) {
    for (const label of (match[1] ?? "").split("|")) labels.push(label.trim().toLowerCase());
  }
  return labels;
}

function offensiveLabels(line: string): string[] {
  return registerLabels(line).filter(isOffensiveLabel);
}

type WikiReading = { languages: string[]; flags: string[] };

/** One page's languages (its `==Language==` sections), the senses carrying an offensive label, and
 * the terms labelled so as a whole. The REST definition endpoint drops the labels, so the page's
 * wikitext is read instead. */
async function wiktionaryPage(io: Io, title: string): Promise<WikiReading | Cell> {
  // redirects=1 resolves a redirect page (an alternative spelling) to the entry it points at.
  const url = `https://en.wiktionary.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&redirects=1&format=json&formatversion=2`;
  let body: WikitextReply;
  try {
    const response = await get(io, url);
    if (response.status !== 200) return unknown(`wiktionary HTTP ${response.status}`);
    body = (await response.json()) as WikitextReply;
  } catch (error) {
    return unknown(`wiktionary ${String(error)}`);
  }
  if (body.error?.code === "missingtitle") return { languages: [], flags: [] };
  if (body.error) return unknown(`wiktionary api error ${body.error.code ?? ""}`.trim());
  const wikitext = body.parse?.wikitext;
  if (typeof wikitext !== "string") return unknown("wiktionary reply had no wikitext");
  const reading: WikiReading = { languages: [], flags: [] };
  let language = "";
  for (const line of wikitext.split("\n")) {
    const heading = /^==([^=].*?)==\s*$/.exec(line);
    if (heading) {
      language = (heading[1] ?? "").trim();
      reading.languages.push(language);
      continue;
    }
    if (/^#[^:*]/.test(line)) {
      if (offensiveLabels(line).length > 0) {
        reading.flags.push(`${language}: ${plainGloss(line).slice(0, 80)}`);
      }
      continue;
    }
    // A term label beside the headword applies to the whole term, every sense included.
    const term = offensiveLabels(line.replace(/\{\{(?:lb|lbl|label)\|[^}]*\}\}/g, ""));
    if (term.length > 0) reading.flags.push(`${language}: term labelled ${term.join(", ")}`);
  }
  return reading;
}

/** Every sense in every language, on the lowercase and the capitalised page (proper nouns live on
 * the latter). A word is a word even when harmless, so a language list is a `taken` cell. A flag
 * found on one page stands even when the other page could not be read. */
export async function wiktionary(io: Io, name: string): Promise<Cell> {
  const lower = name.toLowerCase();
  const titles = [lower, lower.charAt(0).toUpperCase() + lower.slice(1)];
  const languages: string[] = [];
  const flags: string[] = [];
  let failed: Cell | null = null;
  for (const title of titles) {
    const reading = await wiktionaryPage(io, title);
    if ("status" in reading) {
      failed = reading;
      continue;
    }
    languages.push(...reading.languages);
    flags.push(...reading.flags);
  }
  if (flags.length > 0) {
    const note = failed ? ` (other casing ${renderCell(failed)})` : "";
    return taken(`${WIKTIONARY_FLAG}${[...new Set(flags)].join(" | ")}${note}`);
  }
  if (failed) return failed;
  if (languages.length > 0) return taken(`word in ${[...new Set(languages)].join(",")}`);
  return free;
}

type UrbanEntry = { word?: string; definition?: string; thumbs_up?: number };

/** Exact-match entries only: Urban Dictionary's search is fuzzy and would flag every name. */
async function urban(io: Io, name: string): Promise<Cell> {
  const url = `https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(name)}`;
  try {
    const response = await get(io, url);
    if (response.status !== 200) return unknown(`urban HTTP ${response.status}`);
    const body = (await response.json()) as { list?: UrbanEntry[] };
    const exact = (body.list ?? []).filter(
      (entry) => (entry.word ?? "").toLowerCase() === name.toLowerCase(),
    );
    if (exact.length === 0) return free;
    exact.sort((a, b) => (b.thumbs_up ?? 0) - (a.thumbs_up ?? 0));
    const top = (exact[0]?.definition ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    return taken(`${exact.length} entr${exact.length === 1 ? "y" : "ies"}: ${top}`);
  } catch (error) {
    return unknown(`urban ${String(error)}`);
  }
}

export function columns(options: Options): string[] {
  const base = ["pypi", "npm", "crates", "hf", "github-user", "github-repo"];
  if (options.arxiv) base.push("arxiv");
  for (const tld of options.domains) base.push(`dns-${tld}`);
  base.push("wiktionary", "urban");
  return base;
}

export async function lookup(io: Io, column: string, name: string): Promise<Cell> {
  const lower = name.toLowerCase();
  switch (column) {
    case "pypi":
      return registry(io, `https://pypi.org/pypi/${lower}/json`, "pypi package");
    case "npm":
      return registry(io, `https://registry.npmjs.org/${lower}`, "npm package");
    case "crates":
      return registry(io, `https://crates.io/api/v1/crates/${lower}`, "crate");
    case "hf":
      return huggingFace(io, name);
    case "github-user":
      return githubUser(io, name);
    case "github-repo":
      return githubRepo(io, name);
    case "arxiv":
      return arxiv(io, name);
    case "wiktionary":
      return wiktionary(io, name);
    case "urban":
      return urban(io, name);
  }
  if (column.startsWith("dns-")) return domain(io, lower, column.slice("dns-".length));
  return unknown(`no lookup for column ${column}`);
}

export async function checkName(io: Io, options: Options, name: string): Promise<Row> {
  const cols = columns(options);
  const cells = await Promise.all(cols.map((column) => lookup(io, column, name)));
  return {
    name,
    cells: Object.fromEntries(cols.map((column, i) => [column, cells[i] ?? unknown("missing")])),
  };
}

/** A string no registry has: letters only, so every registry accepts it as a name. */
export function nonsenseName(random: () => number = Math.random): string {
  const alphabet = "bcdfghjklmnpqrstvwxz";
  let out = "zq";
  for (let i = 0; i < 12; i++) out += alphabet[Math.floor(random() * alphabet.length)];
  return out;
}

export function takenControlFor(column: string): string {
  if (column.startsWith("dns-")) return DNS_TAKEN_CONTROL;
  return TAKEN_CONTROL[column] ?? "";
}

/** The taken control must read taken; for Wiktionary it must also be flagged, since the control
 * word's offensive senses are what the column exists to see. */
function takenControlHolds(column: string, cell: Cell): boolean {
  if (cell.status !== "taken") return false;
  if (column === "wiktionary") return cell.detail.startsWith(WIKTIONARY_FLAG);
  return true;
}

export type ControlVerdict = {
  column: string;
  control: string;
  expected: "taken" | "free";
  got: Cell;
};

/** One taken-control lookup per column (its own control name), and one random-name row. */
export async function runControls(
  io: Io,
  options: Options,
  freeControl: string,
): Promise<ControlVerdict[]> {
  const cols = columns(options);
  const [takenCells, freeRow] = await Promise.all([
    Promise.all(cols.map((column) => lookup(io, column, takenControlFor(column)))),
    checkName(io, options, freeControl),
  ]);
  const failures: ControlVerdict[] = [];
  cols.forEach((column, i) => {
    const got = takenCells[i] ?? unknown("missing");
    if (!takenControlHolds(column, got)) {
      failures.push({ column, control: takenControlFor(column), expected: "taken", got });
    }
    const freeCell = freeRow.cells[column] ?? unknown("missing");
    if (freeCell.status !== "free") {
      failures.push({ column, control: freeControl, expected: "free", got: freeCell });
    }
  });
  return failures;
}

export function renderCell(cell: Cell): string {
  if (cell.status === "free") return "free";
  return `${cell.status}(${cell.detail})`;
}

export function renderTsv(options: Options, rows: Row[]): string {
  const cols = columns(options);
  const lines = [["name", ...cols].join("\t")];
  for (const row of rows) {
    lines.push(
      [row.name, ...cols.map((c) => renderCell(row.cells[c] ?? unknown("missing")))].join("\t"),
    );
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
        "no-arxiv": { type: "boolean" },
        json: { type: "boolean" },
      },
    });
  } catch (error) {
    process.stderr.write(`${String(error)}\n${USAGE}\n`);
    return 2;
  }
  const names = parsed.positionals;
  if (names.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  const bad = names.find((name) => !/^[A-Za-z][A-Za-z0-9-]*$/.test(name));
  if (bad) {
    process.stderr.write(
      `name must be letters, digits, and dashes, starting with a letter: ${bad}\n`,
    );
    return 2;
  }
  const options: Options = {
    domains: (parsed.values.domain as string[] | undefined) ?? ["com", "ai", "dev"],
    arxiv: !(parsed.values["no-arxiv"] as boolean | undefined),
  };
  const io: Io = {
    fetch: (url, init) => fetch(url, init),
    resolve: (host) => dns.lookup(host),
    githubToken: githubTokenFromEnvironment(),
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

if (import.meta.main) {
  process.exit(await main());
}
