// The table of registries check-name.mts reads. Adding a registry is adding one entry to
// REGISTRIES: its column, its control row, the TSV header, and `--list-registries` follow from
// the table. Every cell is `free`, `taken(<why>)`, or `unknown(<why>)`; a lookup that failed never
// reads as free.

export type Cell =
  | { status: "free" }
  | { status: "taken"; detail: string }
  | { status: "unknown"; detail: string };

export type Io = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Resolves a hostname to at least one address, or throws (ENOTFOUND for an unregistered name). */
  resolve: (host: string) => Promise<unknown>;
  githubToken: string | null;
  /** A request past this is an `unknown` cell, so one stalled endpoint cannot hold the table. */
  timeoutMs: number;
  /** arXiv asks for one request every three seconds; its lookups are serialised this far apart. */
  arxivGapMs: number;
};

export type Registry = {
  kind: "registry";
  /** The column name, and the id `--registries` selects by. */
  id: string;
  label: string;
  /** A name known to be taken there: the row that proves the column reads before a free is trusted. */
  takenControl: string;
  /** What the control must read; any taken cell unless the column exists to see something finer. */
  controlHolds?: (cell: Cell) => boolean;
  lookup: (io: Io, name: string) => Promise<Cell>;
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

export type RegistryEntry = Registry | DomainFamily;

export const free: Cell = { status: "free" };
export const taken = (detail: string): Cell => ({ status: "taken", detail });
export const unknown = (detail: string): Cell => ({ status: "unknown", detail });

export function renderCell(cell: Cell): string {
  if (cell.status === "free") return "free";
  return `${cell.status}(${cell.detail})`;
}

const USER_AGENT = "check-name.mts (project-naming skill; https://github.com/Vivswan/skills)";

async function get(io: Io, url: string, headers: Record<string, string> = {}): Promise<Response> {
  return io.fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(io.timeoutMs),
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers },
  });
}

async function lookup404(io: Io, url: string, label: string): Promise<Cell> {
  try {
    const response = await get(io, url);
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

let arxivTurn: Promise<void> = Promise.resolve();
let arxivLastDone = 0;

/** The gap is waited before a lookup, never after one, so the last lookup ends the process. */
function arxivSerialised<T>(io: Io, work: () => Promise<T>): Promise<T> {
  const mine = arxivTurn.then(async () => {
    const wait = arxivLastDone + io.arxivGapMs - Date.now();
    if (wait > 0) await Bun.sleep(wait);
    try {
      return await work();
    } finally {
      arxivLastDone = Date.now();
    }
  });
  arxivTurn = mine.then(
    () => undefined,
    () => undefined,
  );
  return mine;
}

/** Papers whose title carries the name. The export API rate-limits after a few dozen calls, and
 * answers `max_results=0` with HTTP 500, so one entry is asked for and only the count is read. */
function arxiv(io: Io, name: string): Promise<Cell> {
  return arxivSerialised(io, () => arxivLookup(io, name));
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
  packageRegistry(
    "crates",
    "crates.io crate",
    "serde",
    "crate",
    (lower) => `https://crates.io/api/v1/crates/${lower}`,
  ),
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
    label: "Urban Dictionary exact entry",
    takenControl: "yeet",
    lookup: urban,
  },
];
