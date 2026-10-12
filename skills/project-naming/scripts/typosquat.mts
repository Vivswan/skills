// The typosquat column: is the name one edit away from a popular package on a claimed registry?
// Each registry's popular names come from one public list, fetched once per process and kept
// under the OS temp dir for a day, so a batch of lanes does not pull the same list twenty times.

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type Cell, free, get, type Io, taken, unknown } from "./cells.mts";

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** The top of each download ranking; names past this are not what a typo lands on. */
export const RANKING_TOP = 5_000;

/** True when `b` is one insertion, deletion, substitution, or adjacent transposition from `a`.
 * Hand-rolled: shipped skill scripts run from the installed folder on node built-ins alone, and
 * the bound-1 check is a few lines where the general Damerau-Levenshtein algorithm is a library. */
export function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const differ: number[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differ.push(i);
    if (differ.length === 1) return true;
    if (differ.length !== 2) return false;
    const [i, j] = differ as [number, number];
    return j === i + 1 && a[i] === b[j] && a[j] === b[i];
  }
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  let skipped = false;
  for (let i = 0, j = 0; i < long.length; i++) {
    if (long[i] === short[j]) j++;
    else if (skipped) return false;
    else skipped = true;
  }
  return true;
}

type Names = { names: string[] } | { error: string };

const inFlight = new WeakMap<Io, Map<string, Promise<Names>>>();

/** One fetch per URL per process, and per day on disk when the Io names a cache directory. Only
 * a reply `extract` could read is cached, so a malformed reply is asked for again next run. */
function cachedNames(io: Io, url: string, extract: (text: string) => string[]): Promise<Names> {
  let memo = inFlight.get(io);
  if (!memo) {
    memo = new Map();
    inFlight.set(io, memo);
  }
  let pending = memo.get(url);
  if (!pending) {
    pending = fetchNames(io, url, extract);
    memo.set(url, pending);
  }
  return pending;
}

async function fetchNames(
  io: Io,
  url: string,
  extract: (text: string) => string[],
): Promise<Names> {
  const fromDisk = io.cacheDir ? readCache(io.cacheDir, url) : null;
  if (fromDisk !== null) return { names: fromDisk };
  let text: string;
  try {
    const response = await get(io, url);
    if (response.status !== 200) return { error: `HTTP ${response.status}` };
    text = await response.text();
  } catch (error) {
    return { error: String(error) };
  }
  let names: string[];
  try {
    names = extract(text);
  } catch (error) {
    return { error: `reply unreadable: ${String(error)}` };
  }
  if (io.cacheDir) writeCache(io.cacheDir, url, JSON.stringify(names));
  return { names };
}

function cachePath(dir: string, url: string): string {
  return join(dir, `${createHash("sha256").update(url).digest("hex")}.json`);
}

/** The cache only saves a fetch, so any failure of it (an unreadable directory, a full disk, an
 * entry an older layout wrote) is a miss or a skipped write, never a cell. */
function readCache(dir: string, url: string): string[] | null {
  try {
    const path = cachePath(dir, url);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat || Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!Array.isArray(parsed) || !parsed.every((name) => typeof name === "string")) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** The file lands whole (written beside, then renamed), and entries past the day leave with it,
 * so the directory never holds more than a day of lookups. */
function writeCache(dir: string, url: string, text: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    const path = cachePath(dir, url);
    writeFileSync(`${path}.part`, text);
    renameSync(`${path}.part`, path);
    for (const entry of readdirSync(dir)) {
      const stat = statSync(join(dir, entry), { throwIfNoEntry: false });
      if (stat?.isFile() && Date.now() - stat.mtimeMs > CACHE_TTL_MS) {
        unlinkSync(join(dir, entry));
      }
    }
  } catch {
    // The names were fetched; the next run fetches them again.
  }
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

async function source(
  io: Io,
  registry: string,
  label: string,
  url: string,
  basis: string,
  extract: (text: string) => string[],
): Promise<Source> {
  const loaded = await cachedNames(io, url, extract);
  if ("error" in loaded) return { registry, error: `${label} ${loaded.error}` };
  return { registry, names: loaded.names, basis };
}

// The project publishes the ranking at hugovk.github.io, which redirects here.
const PYPI_TOP_URL = "https://hugovk.dev/top-pypi-packages/top-pypi-packages.min.json";

/** npm publishes no ranking and its search matches whole words (a one-letter typo returns
 * nothing), so the list is npm-high-impact's by-downloads ranking of the packages npm itself
 * calls high-impact, served by jsDelivr as a JS module of quoted names. */
const NPM_TOP_URL = "https://cdn.jsdelivr.net/npm/npm-high-impact@1/lib/top-download.js";

function quotedNames(moduleText: string): string[] {
  const exported = /^export const \w+ = \[([^\]]*)\]/m.exec(moduleText);
  if (!exported) throw new Error("not a module exporting one array");
  const names = [...(exported[1] ?? "").matchAll(/'([^'\n]+)'/g)].map((match) => match[1] ?? "");
  if (names.length === 0) throw new Error("no quoted names in the module");
  return names;
}

function sources(io: Io, lower: string): Promise<Source>[] {
  const ranking = `top ${RANKING_TOP} by downloads`;
  return [
    source(io, "pypi", "top-pypi-packages", PYPI_TOP_URL, ranking, (text) =>
      stringsOf(text, ["rows"], (row) => (row as { project?: unknown }).project).slice(
        0,
        RANKING_TOP,
      ),
    ),
    source(io, "npm", "npm-high-impact", NPM_TOP_URL, ranking, (text) =>
      quotedNames(text).slice(0, RANKING_TOP),
    ),
    source(
      io,
      "crates",
      "crates search",
      `https://crates.io/api/v1/crates?q=${encodeURIComponent(lower)}&per_page=100&sort=downloads`,
      "the 100 most downloaded crates the search returns for it",
      (text) => stringsOf(text, ["crates"], (crate) => (crate as { name?: unknown }).name),
    ),
  ];
}

/** With no hit, a source that could not be read is the cell: the name may be one edit from what
 * that source would have shown. */
export async function typosquat(io: Io, name: string): Promise<Cell> {
  const lower = name.toLowerCase();
  const hits: string[] = [];
  const errors: string[] = [];
  for (const found of await Promise.all(sources(io, lower))) {
    if ("error" in found) {
      errors.push(found.error);
      continue;
    }
    const near = found.names.find((candidate) => oneEditApart(lower, candidate.toLowerCase()));
    if (near) hits.push(`1 edit from ${near} on ${found.registry} (${found.basis})`);
  }
  if (hits.length > 0) return taken(hits.join("; "));
  if (errors.length > 0) return unknown(errors.join("; "));
  return free;
}
