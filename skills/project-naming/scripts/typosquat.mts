// The typosquat column: is the name one edit away from a popular package on PyPI, npm, or crates?
// Each registry's popular names come from one public list, read through cache.mts.

import { cached, stringList } from "./cache.mts";
import { type Cell, type Claimed, free, type Io, taken, unknown } from "./cells.mts";

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
  const loaded = await cached(io, { url, extract, revive: stringList });
  if ("error" in loaded) return { registry, error: `${label} ${loaded.error}` };
  return { registry, names: loaded.value, basis };
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

/** Every source's outcome is in the cell: a source that could not be read is named beside the
 * hits, since the name may be one edit from what it would have shown, and with no hit it is the
 * cell. A hit on an unclaimed registry alone must not read as a complete check of the claimed one. */
export async function typosquat(io: Io, name: string, claimed: Claimed): Promise<Cell> {
  const lower = name.toLowerCase();
  const hits: string[] = [];
  const failures: string[] = [];
  for (const found of await Promise.all(sources(io, lower))) {
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
