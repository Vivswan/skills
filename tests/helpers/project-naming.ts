// The project-naming tests drive check-name.mts through an injected fetch and resolver: every
// registry reply here is hand-written and no test reaches the network. Each test names the reply
// shape it pins.

import type { Options } from "../../skills/project-naming/scripts/check-name.mts";
import { REGISTRIES } from "../../skills/project-naming/scripts/columns/registries/table.mts";
import type { Cell, Io } from "../../skills/project-naming/scripts/core/cells.mts";

export type Reply = { status: number; body?: unknown; text?: string };

export function wikitextReply(wikitext: string): Reply {
  return { status: 200, body: { parse: { wikitext } } };
}
export const MISSING_PAGE: Reply = { status: 200, body: { error: { code: "missingtitle" } } };

export const BLUESKY_FREE: Reply = { status: 400, body: { message: "Unable to resolve handle" } };

/** The shape npm-high-impact ships: a JS module exporting one array of quoted names. */
export function npmModule(names: string[]): string {
  return `export const topDownload = [\n${names.map((name) => `  '${name}'`).join(",\n")}\n]\n`;
}

/** What the sources publish and the script requires: PyPI's and npm's lists read for their top
 * 5000, crates.io's ranking 100 a page over 20 pages. Literals, so a shrink in the script shows. */
export const TOP = 5000;
export const PAGE = 100;
export const PAGES = 20;

/** A ranking as full as its source publishes: the given names at the top, filler behind them to
 * `size`. The script reads a shorter list as cut, so every fixture list is whole unless a test
 * cuts it on purpose. */
export function ranking(names: string[], size: number): string[] {
  const filler = Array.from({ length: size }, (_, i) => `filler-${i}`);
  return [...names, ...filler].slice(0, Math.max(size, names.length));
}
const PYPI_ROWS = (names: string[]): Reply => ({
  status: 200,
  body: { rows: ranking(names, TOP).map((project) => ({ project })) },
});
const NPM_MODULE = (names: string[]): Reply => ({
  status: 200,
  text: npmModule(ranking(names, TOP)),
});
export const CRATES_PAGE = (names: string[]): Reply => ({
  status: 200,
  body: { crates: ranking(names, PAGE).map((name) => ({ name })) },
});

/** The shape of formulae.brew.sh's two indexes: a formula entry carries `name`, `aliases`, and
 * `oldnames`; a cask entry `token` and `old_tokens`. */
type Formula = { name: string; aliases?: string[]; oldnames?: string[] };
type Cask = { token: string; old_tokens?: string[] };
export function formulaIndex(entries: Formula[]): Reply {
  return {
    status: 200,
    body: entries.map((f) => ({
      name: f.name,
      aliases: f.aliases ?? [],
      oldnames: f.oldnames ?? [],
    })),
  };
}
export function caskIndex(entries: Cask[]): Reply {
  return {
    status: 200,
    body: entries.map((c) => ({ token: c.token, old_tokens: c.old_tokens ?? [] })),
  };
}
export const FORMULA_INDEX = "/api/formula.json";
export const CASK_INDEX = "/api/cask.json";

/** Every registry answers `free` unless the handler says otherwise: a 404 for the lookups that
 * use one, an empty result for the searches, a missing page for Wiktionary, the resolver's
 * "unable to resolve" for Bluesky, a one-entry index for Homebrew (an empty one is unreadable). */
function defaultReply(url: URL): Reply {
  if (url.pathname === "/search/repositories") return { status: 200, body: { items: [] } };
  if (url.pathname === FORMULA_INDEX) return formulaIndex([{ name: "filler-formula" }]);
  if (url.pathname === CASK_INDEX) return caskIndex([{ token: "filler-cask" }]);
  if (url.hostname === "search.maven.org")
    return { status: 200, body: { response: { numFound: 0 } } };
  if (url.hostname === "public.api.bsky.app") return BLUESKY_FREE;
  if (url.hostname === "hugovk.dev") return PYPI_ROWS([]);
  if (url.hostname === "cdn.jsdelivr.net") return NPM_MODULE([]);
  if (url.pathname === "/api/v1/crates") return CRATES_PAGE([]);
  if (url.hostname === "api.urbandictionary.com") return { status: 200, body: { list: [] } };
  if (url.hostname === "en.wiktionary.org") return MISSING_PAGE;
  if (url.hostname === "export.arxiv.org") {
    return {
      status: 200,
      text: "<feed><opensearch:totalResults>0</opensearch:totalResults></feed>",
    };
  }
  return { status: 404 };
}

export function dnsFailure(code: string): Error {
  const error = new Error(code) as Error & { code: string };
  error.code = code;
  return error;
}

export function fakeIo(
  handler: (url: URL) => Reply | undefined,
  resolving: string[] = [],
  dnsError = "ENOTFOUND",
): Io {
  return {
    fetch: async (input) => {
      const url = new URL(input);
      const reply = handler(url) ?? defaultReply(url);
      const text = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
      return new Response(text, { status: reply.status });
    },
    resolve: async (host) => {
      if (resolving.includes(host)) return [{ address: "192.0.2.1", family: 4 }];
      throw dnsFailure(dnsError);
    },
    // A zone with resolving hosts under it is delegated, and they are its name servers.
    resolveNs: async (zone) => {
      const servers = resolving.filter((host) => host.endsWith(`.${zone}`));
      if (servers.length > 0) return servers;
      throw dnsFailure(dnsError);
    },
    githubToken: null,
    timeoutMs: 5_000,
    arxivGapMs: 0,
    githubSearchGapMs: 0,
    cratesGapMs: 0,
    cacheDir: null,
  };
}

/** Each column's taken control reads taken there; every other name reads free. */
export function allTakenIo(resolving: string[]): Io {
  const controls = REGISTRIES.filter((entry) => entry.kind === "registry").map(
    (entry) => entry.takenControl,
  );
  return fakeIo((url) => {
    // The typosquat control is one letter off regex, which all three rankings carry.
    if (url.hostname === "hugovk.dev") return PYPI_ROWS(["regex"]);
    if (url.hostname === "cdn.jsdelivr.net") return NPM_MODULE(["regex"]);
    if (url.pathname === "/api/v1/crates") return CRATES_PAGE(["regex"]);
    // The Homebrew control is a formula in the index, not a path of its own.
    if (url.pathname === FORMULA_INDEX) return formulaIndex([{ name: "wget" }]);
    const path = decodeURIComponent(url.pathname + url.search).toLowerCase();
    const named = controls.find((control) => path.includes(control));
    if (!named) return undefined;
    if (url.pathname === "/search/repositories") {
      // One full page of substring hits, the control's own repository first.
      const items = [{ name: named, stargazers_count: 5000 }];
      for (let i = 1; i < 100; i++) items.push({ name: `${named}-${i}`, stargazers_count: 4000 });
      return { status: 200, body: { items } };
    }
    if (url.hostname === "export.arxiv.org") {
      return {
        status: 200,
        text: "<feed><opensearch:totalResults>12</opensearch:totalResults></feed>",
      };
    }
    if (url.hostname === "en.wiktionary.org") {
      return wikitextReply("==Spanish==\n# {{lb|es|vulgar}} [[wanker]]\n");
    }
    if (url.hostname === "api.urbandictionary.com") {
      return { status: 200, body: { list: [{ word: named, definition: "slang", thumbs_up: 3 }] } };
    }
    if (url.hostname === "search.maven.org") {
      return { status: 200, body: { response: { numFound: 4 } } };
    }
    if (url.hostname === "hub.docker.com") return { status: 308 };
    return { status: 200, body: {} };
  }, resolving);
}

export function withReply(base: Io, hostname: string, reply: () => Response): Io {
  return {
    ...base,
    fetch: async (input, init) =>
      new URL(input).hostname === hostname ? reply() : base.fetch(input, init),
  };
}

export const OPTIONS: Options = {
  table: REGISTRIES,
  domains: ["com"],
  arxiv: false,
  registries: null,
};
export const WITH_ARXIV: Options = { ...OPTIONS, arxiv: true };
export const RANDOM = "zqplmwtrkvbn";

export function cell(row: Record<string, Cell>, column: string): Cell {
  const value = row[column];
  if (!value) throw new Error(`no ${column} cell`);
  return value;
}

export function detail(c: Cell): string {
  if (c.status === "free") throw new Error("free cell has no detail");
  return c.detail;
}

export function sourcesIo(pypi: string[], npm: string[], crates: string[]): Io {
  return fakeIo((url) => {
    if (url.hostname === "hugovk.dev") return PYPI_ROWS(pypi);
    if (url.hostname === "cdn.jsdelivr.net") return NPM_MODULE(npm);
    if (url.pathname === "/api/v1/crates") {
      // The ranking is read page by page, every page full; the names sit on the first.
      return CRATES_PAGE(url.searchParams.get("page") === "1" ? crates : []);
    }
    return undefined;
  });
}
