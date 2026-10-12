// The table of registries check-name.mts reads. Adding a registry is adding one entry to
// REGISTRIES: its column, its control row, the TSV header, and `--list-registries` follow from
// the table.

import { cached, stringList, stringMap } from "./cache.mts";
import {
  type Cell,
  type Claimed,
  free,
  get,
  type Io,
  renderCell,
  serialQueue,
  taken,
  unknown,
} from "./cells.mts";
import { type Note, sayAsSpelled } from "./say.mts";
import { cratesQueue, typosquat } from "./typosquat.mts";

export type Registry = {
  kind: "registry";
  /** The column name, and the id `--registries` selects by. */
  id: string;
  label: string;
  /** A name known to be taken there: the row that proves the column reads before a free is trusted. */
  takenControl: string;
  /** What the control must read; any taken cell unless the column exists to see something finer. */
  controlHolds?: (cell: Cell) => boolean;
  /** Runs on every name whatever `--registries` selects: the page's gates read these columns. */
  gate?: true;
  lookup: (io: Io, name: string, claimed: Claimed) => Promise<Cell>;
};

/** One column per top-level domain the run asks for, each its own registry. */
export type DomainFamily = {
  kind: "domains";
  /** The id pattern, for `--list-registries`; each generated column is `dns-<tld>`. */
  id: string;
  label: string;
  takenControl: string;
  forTld: (tld: string) => Registry;
};

/** A column that reads the name itself and answers a note: no registry, so no control. */
export type NoteColumn = {
  kind: "note";
  id: string;
  label: string;
  gate?: true;
  lookup: (io: Io, name: string) => Promise<Note>;
};

export type Column = Registry | NoteColumn;

export type RegistryEntry = Registry | DomainFamily | NoteColumn;

async function lookup404(io: Io, url: string, label: string): Promise<Cell> {
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

function packageRegistry(
  id: string,
  label: string,
  takenControl: string,
  detail: string,
  url: (lower: string) => string,
): Registry {
  return {
    kind: "registry",
    id,
    label,
    takenControl,
    lookup: (io, name) => lookup404(io, url(name.toLowerCase()), detail),
  };
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

const arxivQueue = serialQueue();
const mavenQueue = serialQueue();
const githubSearchQueue = serialQueue();

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
async function githubRepo(io: Io, name: string): Promise<Cell> {
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

type BrewIndex = {
  kind: "formula" | "cask";
  url: string;
  /** The key of an entry's own name. */
  nameKey: string;
  /** Keys of the lists of other names an entry goes by, each with how the cell says so. */
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
async function homebrew(io: Io, name: string): Promise<Cell> {
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
async function dockerHub(io: Io, name: string): Promise<Cell> {
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

/** search.maven.org answers in under a second or holds the request for 30 seconds and more, at
 * random and more often after a burst. So the lookups run one at a time, and a held request is
 * abandoned early and asked again, up to MAVEN_ATTEMPTS times, before the cell is unknown. */
const MAVEN_ATTEMPT_MS = 5_000;
const MAVEN_ATTEMPTS = 3;

/** Artifact ids are case-sensitive, so the spelling as given and the lowercase form (the
 * convention) are both asked for. The count alone decides, so no documents are requested. */
async function mavenCentral(io: Io, name: string): Promise<Cell> {
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
async function bluesky(io: Io, name: string): Promise<Cell> {
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
function arxiv(io: Io, name: string): Promise<Cell> {
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

/** Every top-level domain registry runs its own nic host. */
const DNS_TAKEN_CONTROL = "nic";

async function domain(io: Io, name: string, tld: string): Promise<Cell> {
  const host = `${name.toLowerCase()}.${tld}`;
  try {
    await io.resolve(host);
    return taken(`${host} resolves`);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOTFOUND" || code === "ENODATA") return free;
    return unknown(`${host} ${code ?? String(error)}`);
  }
}

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

export const WIKTIONARY_FLAG = "FLAG ";

type WikitextReply = { parse?: { wikitext?: string }; error?: { code?: string } };

/** The label templates: on a sense line `lb` and its aliases, the older `context` and `cx` among
 * them; on a headword line `tlb` and `term-label`. */
const SENSE_LABEL = ["lb", "lbl", "label", "context", "cx"];
const TERM_LABEL = ["tlb", "term-label"];

type Template = { start: number; end: number; args: string[] };

/** Each template on the line with one of the names, with its top-level arguments: a `|` or `}}`
 * inside a nested template, a linked label or a `sort={{...}}`, belongs to that template. */
function templates(line: string, names: readonly string[]): Template[] {
  const found: Template[] = [];
  const opener = new RegExp(`\\{\\{(?:${names.join("|")})\\|`, "g");
  for (let match = opener.exec(line); match; match = opener.exec(line)) {
    const start = match.index;
    const args: string[] = [];
    let depth = 1;
    let argStart = start + match[0].length;
    let i = argStart;
    while (i < line.length && depth > 0) {
      if (line.startsWith("{{", i)) {
        depth++;
        i += 2;
      } else if (line.startsWith("}}", i)) {
        depth--;
        if (depth === 0) args.push(line.slice(argStart, i));
        i += 2;
      } else {
        if (line[i] === "|" && depth === 1) {
          args.push(line.slice(argStart, i));
          argStart = i + 1;
        }
        i++;
      }
    }
    if (depth > 0) break;
    found.push({ start, end: i, args: args.map((arg) => arg.trim()) });
    opener.lastIndex = i;
  }
  return found;
}

function withoutTemplates(line: string, names: readonly string[]): string {
  let out = "";
  let from = 0;
  for (const template of templates(line, names)) {
    out += line.slice(from, template.start);
    from = template.end;
  }
  return out + line.slice(from);
}

/** A named argument starts with its name and `=`; a nested template's own `=` is not one. */
function isNamed(arg: string): boolean {
  return /^[^{}|=]+=/.test(arg);
}

/** The text a template reads as: its last unnamed argument (`{{synonym of|en|penis}}` reads
 * "penis", `{{l|en|slang}}` as a label reads "slang"). */
function templateText(inner: string): string {
  const unnamed = inner
    .split("|")
    .filter((arg) => !isNamed(arg))
    .slice(1);
  return unnamed[unnamed.length - 1] ?? "";
}

/** Innermost first, so an outer template's last unnamed argument is plain text by the time it is
 * read as the gloss. */
function templatesAsText(text: string): string {
  let out = text;
  while (/\{\{[^{}]*\}\}/.test(out)) {
    out = out.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => templateText(inner));
  }
  return out;
}

/** Wikitext to a readable gloss: label templates go, links keep their shown text, then any other
 * template keeps its last unnamed argument. Links first, so a piped link inside a template is
 * not read as an argument boundary. */
function plainGloss(line: string): string {
  const unlabelled = withoutTemplates(line.replace(/^#+\s*/, ""), [...SENSE_LABEL, ...TERM_LABEL]);
  return templatesAsText(unlabelled.replace(/\[\[([^\]|]*\|)?([^\]]*)\]\]/g, "$2"))
    .replace(/'{2,}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** A Wiktionary language code: `en`, `cmn`, `gem-pro`, `roa-opt`. */
const LANGUAGE_CODE = /^[a-z]{2,3}(?:-[a-z]{2,3})*$/;

/** The labels the templates on one line carry: their unnamed arguments after the language. The
 * language is the first argument when it has a code's shape; the legacy `{{context|vulgar}}` and
 * `{{context|vulgar|lang=en}}` forms name none there, and every unnamed argument is a label. A
 * named argument is never a label. */
function registerLabels(line: string): string[] {
  const labels: string[] = [];
  for (const { args } of templates(line, [...SENSE_LABEL, ...TERM_LABEL])) {
    const languageNamed = args.some((arg) => /^lang\s*=/.test(arg));
    const unnamed = args.filter((arg) => !isNamed(arg));
    const languageFirst = !languageNamed && LANGUAGE_CODE.test(unnamed[0] ?? "");
    for (const label of languageFirst ? unnamed.slice(1) : unnamed) {
      labels.push(templatesAsText(label).toLowerCase());
    }
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
    const term = offensiveLabels(withoutTemplates(line, SENSE_LABEL));
    if (term.length > 0) reading.flags.push(`${language}: term labelled ${term.join(", ")}`);
  }
  return reading;
}

/** Every sense in every language, on the page spelled as given, the lowercase page, and the
 * capitalised page (proper nouns live there). A word is a word even when harmless, so a language
 * list is a `taken` cell. A flag found on one page stands even when another could not be read. */
async function wiktionary(io: Io, name: string): Promise<Cell> {
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
async function urban(io: Io, name: string): Promise<Cell> {
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

/** The taken controls are names that were taken on the day each entry was written; a registry that
 * drops one shows up as a failed instrument, and the entry gets a new control. */
export const REGISTRIES: readonly RegistryEntry[] = [
  packageRegistry(
    "pypi",
    "PyPI package",
    "requests",
    "pypi package",
    (lower) => `https://pypi.org/pypi/${lower}/json`,
  ),
  packageRegistry(
    "npm",
    "npm package",
    "react",
    "npm package",
    (lower) => `https://registry.npmjs.org/${lower}`,
  ),
  {
    kind: "registry",
    id: "crates",
    label: "crates.io crate",
    takenControl: "serde",
    // One request a second to crates.io, the typosquat ranking's pages in the same line.
    lookup: (io, name) =>
      cratesQueue(io.cratesGapMs, () =>
        lookup404(io, `https://crates.io/api/v1/crates/${name.toLowerCase()}`, "crate"),
      ),
  },
  {
    kind: "registry",
    id: "homebrew",
    label: "Homebrew formula or cask, aliases and old names included",
    // wget: a formula in the index on 2026-10-12.
    takenControl: "wget",
    lookup: homebrew,
  },
  {
    kind: "registry",
    id: "docker",
    label: "Docker Hub user or organization",
    // library: the official images organization, read 308 on 2026-10-12.
    takenControl: "library",
    lookup: dockerHub,
  },
  {
    kind: "registry",
    id: "maven",
    label: "Maven Central artifact id",
    // junit: 31 artifacts on 2026-10-12.
    takenControl: "junit",
    lookup: mavenCentral,
  },
  {
    kind: "registry",
    id: "hf",
    label: "Hugging Face user or organization",
    takenControl: "google",
    lookup: huggingFace,
  },
  {
    kind: "registry",
    id: "github-user",
    label: "GitHub handle",
    takenControl: "torvalds",
    lookup: githubUser,
  },
  {
    kind: "registry",
    id: "github-repo",
    label: `GitHub repository with ${GITHUB_STARS_TAKEN}+ stars`,
    takenControl: "linux",
    lookup: githubRepo,
  },
  {
    kind: "registry",
    id: "bluesky",
    label: "Bluesky handle under bsky.social",
    // jay.bsky.social: resolved on 2026-10-12.
    takenControl: "jay",
    lookup: bluesky,
  },
  {
    kind: "registry",
    id: "arxiv",
    label: "arXiv paper title",
    takenControl: "transformer",
    lookup: arxiv,
  },
  {
    kind: "domains",
    id: "dns-<tld>",
    label: "domain that resolves",
    takenControl: DNS_TAKEN_CONTROL,
    forTld: (tld) => ({
      kind: "registry",
      id: `dns-${tld}`,
      label: `${tld} domain that resolves`,
      takenControl: DNS_TAKEN_CONTROL,
      lookup: (io, name) => domain(io, name, tld),
    }),
  },
  {
    kind: "registry",
    id: "wiktionary",
    gate: true,
    label: "Wiktionary word, any language, offensive senses flagged",
    // The control word's offensive senses are what the column exists to see, so a label-less
    // reading of it is a failed instrument too.
    takenControl: "pajero",
    controlHolds: (cell) => cell.status === "taken" && cell.detail.startsWith(WIKTIONARY_FLAG),
    lookup: wiktionary,
  },
  {
    kind: "registry",
    id: "urban",
    gate: true,
    label: "Urban Dictionary exact entry",
    takenControl: "yeet",
    lookup: urban,
  },
  {
    kind: "registry",
    id: "typosquat",
    gate: true,
    label: "one edit from a popular package on PyPI, npm, or crates",
    // regex, popular on all three registries, with its last letter changed: a list that misses
    // it is a failed instrument, where a control on one list would pass with the other two blind.
    takenControl: "regez",
    controlHolds: (cell) =>
      cell.status === "taken" &&
      ["pypi", "npm", "crates"].every((registry) =>
        new RegExp(` on (?:un)?claimed ${registry} \\(`).test(cell.detail),
      ),
    lookup: typosquat,
  },
  {
    kind: "note",
    id: "say",
    gate: true,
    label:
      "said as spelled: syllables, hard letters, doubled letters, clusters, two readings, spoken digits",
    lookup: async (_io, name) => sayAsSpelled(name),
  },
];
