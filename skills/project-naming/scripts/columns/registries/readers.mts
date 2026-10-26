// The per-registry readers: one lookup per registry, each reading a name into a Cell through the
// injected Io. table.mts binds them to their columns; wiktionary.mts parses the page text.

import { cached, stringList, stringMap } from "../../core/cache.mts";
import {
  type Cell,
  free,
  get,
  type Io,
  renderCell,
  serialQueue,
  taken,
  unknown,
} from "../../core/cells.mts";
import { readWikitext, type WikiReading } from "./wiktionary.mts";

export async function lookup404(io: Io, url: string, label: string): Promise<Cell> {
  try {
    const response = await get(io, url);
    // The status is the answer; the body is released so the request is over, not left open, and
    // a release that fails changes nothing.
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 404) return free;
    if (response.status === 200) return taken(label);
    return unknown(`${label} HTTP ${response.status}`);
  } catch (error) {
    return unknown(`${label} ${String(error)}`);
  }
}

/** Users and organizations share one namespace, so the handle is taken when either endpoint has
 * it. A 307 is the redirect to the canonical casing of a handle that exists under another. */
export async function huggingFace(io: Io, name: string): Promise<Cell> {
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

const arxivQueue = serialQueue();
const mavenQueue = serialQueue();
const githubSearchQueue = serialQueue();

function githubHeaders(io: Io): Record<string, string> {
  return io.githubToken ? { authorization: `Bearer ${io.githubToken}` } : {};
}

export async function githubUser(io: Io, name: string): Promise<Cell> {
  try {
    const response = await get(io, `https://api.github.com/users/${name}`, githubHeaders(io));
    if (response.status === 404) return free;
    if (response.status === 200) return taken("github handle");
    return unknown(`github HTTP ${response.status}`);
  } catch (error) {
    return unknown(`github ${String(error)}`);
  }
}

/** Stars at or above which an exact-name GitHub repository counts as taken. */
export const GITHUB_STARS_TAKEN = 20;

/** GitHub search serves at most 1000 results; past that an exact-name hit cannot be ruled out. */
const GITHUB_SEARCH_PAGES = 10;

type GithubItem = { name: string; stargazers_count: number };
type GithubSearch = { incomplete_results: boolean; items: GithubItem[] };

/** The reply in the search's shape, or what is wrong with it: a 200 that is not the shape must
 * not read as an empty result. */
function githubSearch(body: unknown): GithubSearch | string {
  if (typeof body !== "object" || body === null) return "not an object";
  const { incomplete_results, items } = body as Record<string, unknown>;
  if (incomplete_results !== undefined && typeof incomplete_results !== "boolean") {
    return "incomplete_results is not a boolean";
  }
  if (!Array.isArray(items)) return "no items list";
  for (const item of items as Record<string, unknown>[]) {
    if (typeof item?.name !== "string") return "an item has no name";
    if (typeof item.stargazers_count !== "number") return "an item has no stargazers_count";
  }
  return { incomplete_results: incomplete_results === true, items: items as GithubItem[] };
}

async function githubSearchPage(io: Io, url: string): Promise<GithubSearch | Cell> {
  let body: unknown;
  try {
    const response = await get(io, url, githubHeaders(io));
    if (response.status === 403 || response.status === 429) {
      return unknown("github search rate-limited; retry later");
    }
    if (response.status !== 200) return unknown(`github search HTTP ${response.status}`);
    body = await response.json();
  } catch (error) {
    return unknown(`github search ${String(error)}`);
  }
  const search = githubSearch(body);
  if (typeof search === "string") return unknown(`github search reply malformed: ${search}`);
  if (search.incomplete_results) return unknown("github search reported incomplete results");
  return search;
}

/** The search matches the name as a substring, sorted by stars, so the first exact-name hit is the
 * best-starred one and decides the cell. Pages are read until that hit, or until the stars fall
 * under the threshold, past which no exact-name repository can count. Forks are excluded by
 * default and a starred fork holds the name as firmly, so they are asked for. */
export async function githubRepo(io: Io, name: string): Promise<Cell> {
  const query = encodeURIComponent(`${name} in:name fork:true`);
  for (let page = 1; page <= GITHUB_SEARCH_PAGES; page++) {
    const url = `https://api.github.com/search/repositories?q=${query}&sort=stars&order=desc&per_page=100&page=${page}`;
    const search = await githubSearchQueue(io.githubSearchGapMs, () => githubSearchPage(io, url));
    if ("status" in search) return search;
    const { items } = search;
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

/** The indexes are tens of megabytes where every other reply is one name's. */
const BREW_INDEX_TIMEOUT_MS = 120_000;

/** One brew index: `nameKey` is the field holding an entry's own name, and `via` maps each list of other names an entry goes by to how the cell says so. */
type BrewIndex = {
  kind: "formula" | "cask";
  url: string;
  nameKey: string;
  via: Record<string, string>;
};

const BREW_INDEXES: readonly BrewIndex[] = [
  {
    kind: "formula",
    url: "https://formulae.brew.sh/api/formula.json",
    nameKey: "name",
    via: { aliases: "alias", oldnames: "old name" },
  },
  {
    kind: "cask",
    url: "https://formulae.brew.sh/api/cask.json",
    nameKey: "token",
    via: { old_tokens: "old token" },
  },
];

/** Every name an index answers to, lowercased, mapped to the cell detail for it, an entry's own
 * name winning over another entry's alias. An empty index is a malformed reply: it would read
 * every name free. */
function brewNames(json: string, index: BrewIndex): Record<string, string> {
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("not a list of entries");
  // A null-prototype map: a plain object inherits `constructor`, so `??=` would skip that alias.
  const names: Record<string, string> = Object.create(null);
  for (const entry of parsed as Record<string, unknown>[]) {
    const name = entry?.[index.nameKey];
    if (typeof name !== "string") throw new Error(`an entry has no ${index.nameKey}`);
    names[name.toLowerCase()] = `homebrew ${index.kind} ${name}`;
    for (const [key, how] of Object.entries(index.via)) {
      const others = stringList(entry[key]);
      if (!others) throw new Error(`${name} has no ${key} list`);
      for (const other of others) {
        names[other.toLowerCase()] ??= `homebrew ${index.kind} ${name} via ${how}`;
      }
    }
  }
  return names;
}

async function brewLookup(io: Io, lower: string, index: BrewIndex): Promise<Cell> {
  const loaded = await cached(io, {
    url: index.url,
    extract: (text) => brewNames(text, index),
    revive: stringMap,
    timeoutMs: BREW_INDEX_TIMEOUT_MS,
  });
  if ("error" in loaded) return unknown(`homebrew ${index.kind} index ${loaded.error}`);
  const holder = Object.hasOwn(loaded.value, lower) ? loaded.value[lower] : undefined;
  return holder ? taken(holder) : free;
}

/** The per-name pages answer an entry's own name only: `formula/python.json` is a 404 while
 * `python` is an alias of `python@3.15`, and no page resolves an alias. So the two indexes are
 * read whole, once a day, and a name is taken when either knows it. */
export async function homebrew(io: Io, name: string): Promise<Cell> {
  const lower = name.toLowerCase();
  const readings = await Promise.all(BREW_INDEXES.map((index) => brewLookup(io, lower, index)));
  return (
    readings.find((cell) => cell.status === "taken") ??
    readings.find((cell) => cell.status === "unknown") ??
    free
  );
}

/** A name Docker Hub would refuse cannot be claimed there, so its 404 is not a free name. The
 * users endpoint answers an organization's name with a 308 to the orgs endpoint. */
export async function dockerHub(io: Io, name: string): Promise<Cell> {
  const lower = name.toLowerCase();
  if (!/^[a-z0-9]{4,30}$/.test(lower)) {
    return unknown("docker hub ids are 4 to 30 lowercase letters and digits");
  }
  try {
    const response = await get(io, `https://hub.docker.com/v2/users/${lower}/`);
    if (response.status === 404) return free;
    if (response.status === 200) return taken("docker hub user");
    if ([301, 302, 307, 308].includes(response.status)) return taken("docker hub organization");
    return unknown(`docker hub HTTP ${response.status}`);
  } catch (error) {
    return unknown(`docker hub ${String(error)}`);
  }
}

type SolrReply = { response?: { numFound?: number } };

// search.maven.org answers in under a second or holds the request for 30 seconds and more, at
// random and more often after a burst. So the lookups run one at a time, and a held request is
// abandoned early and asked again, up to MAVEN_ATTEMPTS times, before the cell is unknown.

const MAVEN_ATTEMPT_MS = 5_000;
const MAVEN_ATTEMPTS = 3;

/** Artifact ids are case-sensitive, so the spelling as given and the lowercase form (the
 * convention) are both asked for. The count alone decides, so no documents are requested. */
export async function mavenCentral(io: Io, name: string): Promise<Cell> {
  const readings: Cell[] = [];
  for (const spelling of new Set([name, name.toLowerCase()])) {
    readings.push(await mavenQueue(0, () => mavenLookup(io, spelling)));
  }
  return (
    readings.find((cell) => cell.status === "taken") ??
    readings.find((cell) => cell.status === "unknown") ??
    free
  );
}

/** A Lucene field value as a phrase. Unquoted, `a:foo-bar` leaves the hyphen to the query
 * parser, which may read it as an operator; quoted, the artifact id is asked for as written. A
 * quote or backslash in the value is escaped so it stays part of the phrase. */
function lucenePhrase(value: string): string {
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

async function mavenLookup(io: Io, spelling: string): Promise<Cell> {
  const query = encodeURIComponent(`a:${lucenePhrase(spelling)}`);
  const url = `https://search.maven.org/solrsearch/select?q=${query}&rows=0&wt=json`;
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await get(io, url, {}, Math.min(io.timeoutMs, MAVEN_ATTEMPT_MS));
      if (response.status !== 200) return unknown(`maven HTTP ${response.status}`);
      const body = (await response.json()) as SolrReply;
      const count = body.response?.numFound;
      if (typeof count !== "number") return unknown("maven reply had no numFound");
      return count === 0 ? free : taken(`${count} maven artifact(s)`);
    } catch (error) {
      if (attempt >= MAVEN_ATTEMPTS || (error as { name?: string }).name !== "TimeoutError") {
        return unknown(`maven ${String(error)}`);
      }
    }
  }
}

type AtprotoError = { message?: string };

/** A handle under bsky.social. The resolver answers a free handle with HTTP 400 "Unable to resolve
 * handle"; any other 400 is a handle it refused to look at, not a free one. */
export async function bluesky(io: Io, name: string): Promise<Cell> {
  const handle = `${name.toLowerCase()}.bsky.social`;
  const url = `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`;
  try {
    const response = await get(io, url);
    if (response.status === 200) return taken("bluesky handle");
    if (response.status === 400) {
      const body = (await response.json()) as AtprotoError;
      if (body.message === "Unable to resolve handle") return free;
      return unknown(`bluesky ${body.message ?? "HTTP 400"}`);
    }
    return unknown(`bluesky HTTP ${response.status}`);
  } catch (error) {
    return unknown(`bluesky ${String(error)}`);
  }
}

/** Papers whose title carries the name. The export API rate-limits after a few dozen calls, and
 * answers `max_results=0` with HTTP 500, so one entry is asked for and only the count is read. */
export function arxiv(io: Io, name: string): Promise<Cell> {
  return arxivQueue(io.arxivGapMs, () => arxivLookup(io, name));
}

async function arxivLookup(io: Io, name: string): Promise<Cell> {
  const query = encodeURIComponent(`ti:"${name}"`);
  const url = `https://export.arxiv.org/api/query?search_query=${query}&max_results=1`;
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

// The DNS control is the zone itself, not a host under it: no host under an arbitrary zone is
// guaranteed an address (nic.uk and nic.ca have none, nic.co.uk does not exist), where a zone a
// registry delegates has name servers by definition, and a name server has an address.

/** The zone apex, in zone-file notation, which no candidate spells (a name starts with a letter). */
export const DNS_TAKEN_CONTROL = "@";

export async function domain(io: Io, name: string, tld: string): Promise<Cell> {
  const apex = name === DNS_TAKEN_CONTROL;
  const host = apex ? tld : `${name.toLowerCase()}.${tld}`;
  try {
    if (apex) {
      // The server list comes from the stub resolver; the server's address goes through the
      // system lookup the candidates take, so a blind system lookup fails this control.
      const [server] = await io.resolveNs(host);
      await io.resolve(server ?? host);
      return taken(`${host} is delegated`);
    }
    await io.resolve(host);
    return taken(`${host} resolves`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return free;
    return unknown(`${host} ${code ?? String(error)}`);
  }
}

export const WIKTIONARY_FLAG = "FLAG ";

type WikitextReply = { parse?: { wikitext?: string }; error?: { code?: string } };

/** One page's wikitext, read into a WikiReading. The REST definition endpoint drops the labels,
 * so the page's wikitext is read instead. */
async function wiktionaryPage(io: Io, title: string): Promise<WikiReading | Cell> {
  // redirects=1 resolves a redirect page (an alternative spelling) to the entry it points at.
  const url = `https://en.wiktionary.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&redirects=1&format=json&formatversion=2`;
  let parsed: unknown;
  try {
    const response = await get(io, url);
    if (response.status !== 200) return unknown(`wiktionary HTTP ${response.status}`);
    parsed = await response.json();
  } catch (error) {
    return unknown(`wiktionary ${String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    return unknown("wiktionary reply malformed: not an object");
  }
  const body = parsed as WikitextReply;
  if (body.error?.code === "missingtitle") return { languages: [], flags: [] };
  if (body.error) return unknown(`wiktionary api error ${body.error.code ?? ""}`.trim());
  const wikitext = body.parse?.wikitext;
  if (typeof wikitext !== "string") return unknown("wiktionary reply had no wikitext");
  return readWikitext(wikitext);
}

/** Every sense in every language, on the page spelled as given, the lowercase page, and the
 * capitalised page (proper nouns live there). A word is a word even when harmless, so a language
 * list is a `taken` cell. A flag found on one page stands even when another could not be read. */
export async function wiktionary(io: Io, name: string): Promise<Cell> {
  const lower = name.toLowerCase();
  const titles = [...new Set([name, lower, lower.charAt(0).toUpperCase() + lower.slice(1)])];
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
    const note = failed ? ` (another casing ${renderCell(failed)})` : "";
    return taken(`${WIKTIONARY_FLAG}${[...new Set(flags)].join(" | ")}${note}`);
  }
  if (failed) return failed;
  if (languages.length > 0) return taken(`word in ${[...new Set(languages)].join(",")}`);
  return free;
}

type UrbanEntry = { word: string; definition?: string; thumbs_up?: number };

/** Exact-match entries only: Urban Dictionary's search is fuzzy and would flag every name. */
export async function urban(io: Io, name: string): Promise<Cell> {
  const url = `https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(name)}`;
  try {
    const response = await get(io, url);
    if (response.status !== 200) return unknown(`urban HTTP ${response.status}`);
    const list = ((await response.json()) as { list?: unknown } | null)?.list;
    if (!Array.isArray(list)) return unknown("urban reply malformed: no list");
    if (!list.every((entry) => typeof entry?.word === "string")) {
      return unknown("urban reply malformed: an entry has no word");
    }
    const exact = (list as UrbanEntry[]).filter(
      (entry) => entry.word.toLowerCase() === name.toLowerCase(),
    );
    if (exact.length === 0) return free;
    exact.sort((a, b) => (b.thumbs_up ?? 0) - (a.thumbs_up ?? 0));
    const top = (exact[0]?.definition ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    return taken(`${exact.length} entr${exact.length === 1 ? "y" : "ies"}: ${top}`);
  } catch (error) {
    return unknown(`urban ${String(error)}`);
  }
}
