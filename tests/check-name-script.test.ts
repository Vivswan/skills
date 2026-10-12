import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";
import {
  checkName,
  columns,
  type Options,
  renderTsv,
  run,
  runControls,
} from "../skills/project-naming/scripts/check-name.mts";
import {
  type Cell,
  GITHUB_STARS_TAKEN,
  type Io,
  REGISTRIES,
  type Registry,
  WIKTIONARY_FLAG,
} from "../skills/project-naming/scripts/registries.mts";

// check-name.mts is driven through an injected fetch and resolver: every registry reply here is
// hand-written and no test reaches the network. Each test names the reply shape it pins.

const SCRIPT = join(ROOT, "skills", "project-naming", "scripts", "check-name.mts");

type Reply = { status: number; body?: unknown; text?: string };

function wikitextReply(wikitext: string): Reply {
  return { status: 200, body: { parse: { wikitext } } };
}
const MISSING_PAGE: Reply = { status: 200, body: { error: { code: "missingtitle" } } };

const BLUESKY_FREE: Reply = { status: 400, body: { message: "Unable to resolve handle" } };

/** Every registry answers `free` unless the handler says otherwise: a 404 for the lookups that
 * use one, an empty result for the searches, a missing page for Wiktionary, the resolver's
 * "unable to resolve" for Bluesky. */
function defaultReply(url: URL): Reply {
  if (url.pathname === "/search/repositories") return { status: 200, body: { items: [] } };
  if (url.hostname === "search.maven.org")
    return { status: 200, body: { response: { numFound: 0 } } };
  if (url.hostname === "public.api.bsky.app") return BLUESKY_FREE;
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

function fakeIo(
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
      const error = new Error(dnsError) as Error & { code: string };
      error.code = dnsError;
      throw error;
    },
    githubToken: null,
    timeoutMs: 5_000,
    arxivGapMs: 0,
  };
}

/** Each column's taken control reads taken there; every other name reads free. */
function allTakenIo(resolving: string[]): Io {
  const controls = REGISTRIES.filter((entry) => entry.kind === "registry").map(
    (entry) => entry.takenControl,
  );
  return fakeIo((url) => {
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

function withReply(base: Io, hostname: string, reply: () => Response): Io {
  return {
    ...base,
    fetch: async (input, init) =>
      new URL(input).hostname === hostname ? reply() : base.fetch(input, init),
  };
}

const OPTIONS: Options = { table: REGISTRIES, domains: ["com"], arxiv: false, registries: null };
const WITH_ARXIV: Options = { ...OPTIONS, arxiv: true };
const RANDOM = "zqplmwtrkvbn";

function cell(row: Record<string, Cell>, column: string): Cell {
  const value = row[column];
  if (!value) throw new Error(`no ${column} cell`);
  return value;
}

function detail(c: Cell): string {
  if (c.status === "free") throw new Error("free cell has no detail");
  return c.detail;
}

describe("check-name.mts cells", () => {
  test("a 404 is free, a 200 is taken naming the registry, and any other status is unknown, never free", async () => {
    const io = fakeIo((url) => {
      if (url.hostname === "pypi.org") return { status: 200, body: {} };
      if (url.hostname === "registry.npmjs.org") return { status: 503 };
      return undefined;
    });
    const row = await checkName(io, OPTIONS, "lumera");
    expect(cell(row.cells, "pypi")).toEqual({ status: "taken", detail: "pypi package" });
    expect(cell(row.cells, "npm")).toEqual({ status: "unknown", detail: "npm package HTTP 503" });
    expect(cell(row.cells, "crates")).toEqual({ status: "free" });
  });

  test("Homebrew: a formula or a cask takes the name, both 404 is free, and an unreadable index with no hit is unknown", async () => {
    const brew = (formula: number, cask: number) =>
      fakeIo((url) => {
        if (url.hostname !== "formulae.brew.sh") return undefined;
        return { status: url.pathname.startsWith("/api/cask/") ? cask : formula };
      });
    const cases: [number, number, Cell][] = [
      [404, 404, { status: "free" }],
      [200, 404, { status: "taken", detail: "homebrew formula" }],
      [404, 200, { status: "taken", detail: "homebrew cask" }],
      [200, 503, { status: "taken", detail: "homebrew formula" }],
      [503, 404, { status: "unknown", detail: "homebrew formula HTTP 503" }],
    ];
    for (const [formula, cask, expected] of cases) {
      const row = await checkName(brew(formula, cask), OPTIONS, "Lumera");
      expect(cell(row.cells, "homebrew"), `${formula}/${cask}`).toEqual(expected);
    }
  });

  test("Docker Hub: 200 is a user, a redirect is an organization, 404 is free, and a dashed name is unknown since Docker refuses it", async () => {
    const hub = (status: number) =>
      fakeIo((url) => (url.hostname === "hub.docker.com" ? { status } : undefined));
    const cases: [number, Cell][] = [
      [200, { status: "taken", detail: "docker hub user" }],
      [308, { status: "taken", detail: "docker hub organization" }],
      [404, { status: "free" }],
      [500, { status: "unknown", detail: "docker hub HTTP 500" }],
    ];
    for (const [status, expected] of cases) {
      const row = await checkName(hub(status), OPTIONS, "Lumera");
      expect(cell(row.cells, "docker"), String(status)).toEqual(expected);
    }
    // A dashed name and a 31-letter one pass the CLI's GitHub-shaped rule but Docker refuses
    // both, so their 404 must not read as free.
    for (const refused of ["lu-mera", "a".repeat(31)]) {
      const row = await checkName(hub(404), OPTIONS, refused);
      expect(cell(row.cells, "docker"), refused).toEqual({
        status: "unknown",
        detail: "docker hub ids are 4 to 30 lowercase letters and digits",
      });
    }
  });

  test("Maven Central: the artifact count decides, zero is free, and a reply without the count or a non-200 is unknown", async () => {
    const maven = (reply: Reply) =>
      fakeIo((url) => {
        if (url.hostname !== "search.maven.org") return undefined;
        expect(url.searchParams.get("q")).toBe("a:lumera");
        return reply;
      });
    // Artifact ids are case-sensitive: an id published in mixed case is missed by the lowercase
    // query alone, so the spelling as given is asked for too.
    const mixedCase = fakeIo((url) => {
      if (url.hostname !== "search.maven.org") return undefined;
      const hit = url.searchParams.get("q") === "a:JLargeArrays";
      return { status: 200, body: { response: { numFound: hit ? 1 : 0 } } };
    });
    const mixed = await checkName(mixedCase, OPTIONS, "JLargeArrays");
    expect(cell(mixed.cells, "maven")).toEqual({ status: "taken", detail: "1 maven artifact(s)" });
    const cases: [Reply, Cell][] = [
      [
        { status: 200, body: { response: { numFound: 3 } } },
        { status: "taken", detail: "3 maven artifact(s)" },
      ],
      [{ status: 200, body: { response: { numFound: 0 } } }, { status: "free" }],
      [
        { status: 200, body: {} },
        { status: "unknown", detail: "maven reply had no numFound" },
      ],
      [{ status: 503 }, { status: "unknown", detail: "maven HTTP 503" }],
    ];
    for (const [reply, expected] of cases) {
      const row = await checkName(maven(reply), OPTIONS, "lumera");
      expect(cell(row.cells, "maven"), String(reply.status)).toEqual(expected);
    }
  });

  test("a Maven request that stalls is abandoned and asked again; the third stall is the unknown cell", async () => {
    const stalling = (stalls: number) => {
      let attempts = 0;
      const base = fakeIo(() => undefined);
      const io: Io = {
        ...base,
        timeoutMs: 50,
        fetch: (input, init) => {
          if (new URL(input).hostname !== "search.maven.org") return base.fetch(input, init);
          attempts++;
          if (attempts > stalls) {
            return Promise.resolve(
              new Response(JSON.stringify({ response: { numFound: 2 } }), { status: 200 }),
            );
          }
          return new Promise((_, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          });
        },
      };
      return { io, attempts: () => attempts };
    };
    const recovered = stalling(2);
    const row = await checkName(recovered.io, OPTIONS, "lumera");
    expect(cell(row.cells, "maven")).toEqual({ status: "taken", detail: "2 maven artifact(s)" });
    expect(recovered.attempts()).toBe(3);
    const held = stalling(3);
    const gaveUp = await checkName(held.io, OPTIONS, "lumera");
    expect(cell(gaveUp.cells, "maven").status).toBe("unknown");
    expect(detail(cell(gaveUp.cells, "maven"))).toContain("TimeoutError");
    expect(held.attempts()).toBe(3);
    // A hold after the headers (the body never arrives) is the same stall and is retried too.
    let bodyAttempts = 0;
    const base = fakeIo(() => undefined);
    const bodyStall: Io = {
      ...base,
      timeoutMs: 50,
      fetch: async (input, init) => {
        if (new URL(input).hostname !== "search.maven.org") return base.fetch(input, init);
        bodyAttempts++;
        if (bodyAttempts > 1) {
          return new Response(JSON.stringify({ response: { numFound: 1 } }), { status: 200 });
        }
        const stream = new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
          },
        });
        return new Response(stream, { status: 200 });
      },
    };
    const afterBodyStall = await checkName(bodyStall, OPTIONS, "lumera");
    expect(cell(afterBodyStall.cells, "maven")).toEqual({
      status: "taken",
      detail: "1 maven artifact(s)",
    });
    expect(bodyAttempts).toBe(2);
  });

  test("Bluesky: 200 is taken, the resolver's 'unable to resolve' 400 is free, and any other 400 or status is unknown", async () => {
    const bsky = (reply: Reply) =>
      fakeIo((url) => {
        if (url.hostname !== "public.api.bsky.app") return undefined;
        expect(url.searchParams.get("handle")).toBe("lumera.bsky.social");
        return reply;
      });
    const cases: [Reply, Cell][] = [
      [
        { status: 200, body: { did: "did:plc:example" } },
        { status: "taken", detail: "bluesky handle" },
      ],
      [BLUESKY_FREE, { status: "free" }],
      [
        { status: 400, body: { message: "Invalid handle" } },
        { status: "unknown", detail: "bluesky Invalid handle" },
      ],
      [{ status: 502 }, { status: "unknown", detail: "bluesky HTTP 502" }],
    ];
    for (const [reply, expected] of cases) {
      const row = await checkName(bsky(reply), OPTIONS, "Lumera");
      expect(cell(row.cells, "bluesky"), JSON.stringify(reply)).toEqual(expected);
    }
  });

  test("a fetch that throws is unknown with the error named, not free", async () => {
    const io = withReply(
      fakeIo(() => undefined),
      "crates.io",
      () => {
        throw new Error("ECONNRESET");
      },
    );
    const row = await checkName(io, OPTIONS, "lumera");
    expect(cell(row.cells, "crates").status).toBe("unknown");
    expect(detail(cell(row.cells, "crates"))).toContain("ECONNRESET");
  });

  test("an endpoint that accepts the connection and never answers is an unknown cell after the timeout, not a hung table", async () => {
    const base = fakeIo(() => undefined);
    const io: Io = {
      ...base,
      timeoutMs: 50,
      fetch: (input, init) =>
        new URL(input).hostname === "api.urbandictionary.com"
          ? new Promise((_, reject) => {
              init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
            })
          : base.fetch(input, init),
    };
    const row = await checkName(io, OPTIONS, "lumera");
    expect(cell(row.cells, "urban").status).toBe("unknown");
    expect(detail(cell(row.cells, "urban"))).toContain("urban");
    expect(cell(row.cells, "pypi")).toEqual({ status: "free" });
  });

  test("arXiv and Maven Central lookups each run one at a time across the rows of a process", async () => {
    const inFlight: Record<string, number> = {};
    const overlap: Record<string, number> = {};
    const base = fakeIo(() => undefined);
    const io: Io = {
      ...base,
      fetch: async (input, init) => {
        const host = new URL(input).hostname;
        if (host !== "export.arxiv.org" && host !== "search.maven.org") {
          return base.fetch(input, init);
        }
        inFlight[host] = (inFlight[host] ?? 0) + 1;
        if ((inFlight[host] ?? 0) > 1) overlap[host] = (overlap[host] ?? 0) + 1;
        await Bun.sleep(5);
        inFlight[host] = (inFlight[host] ?? 0) - 1;
        return base.fetch(input, init);
      },
    };
    await Promise.all(["lumera", "tarnix", "quillo"].map((n) => checkName(io, WITH_ARXIV, n)));
    expect(overlap).toEqual({});
  });

  test("a Hugging Face 307 is a handle that exists under another casing, so taken", async () => {
    const io = fakeIo((url) =>
      url.pathname === "/api/users/Lumera/overview" ? { status: 307 } : undefined,
    );
    const row = await checkName(io, OPTIONS, "Lumera");
    expect(cell(row.cells, "hf")).toEqual({
      status: "taken",
      detail: "hf user exists under another casing",
    });
  });

  test("GitHub: only an exact-name repository counts, from the star threshold up, across pages while stars stay above it", async () => {
    type Item = { name: string; stargazers_count: number };
    const repo = (name: string, stars: number): Item => ({ name, stargazers_count: stars });
    let requests = 0;
    const pages = (...pageItems: Item[][]) =>
      fakeIo((url) => {
        if (url.pathname !== "/search/repositories") return undefined;
        requests++;
        // GitHub leaves forks out unless asked; a starred fork holds the name all the same.
        expect(url.searchParams.get("q")).toBe("lumera in:name fork:true");
        const page = Number(url.searchParams.get("page") ?? "1");
        return { status: 200, body: { items: pageItems[page - 1] ?? [] } };
      });
    const near = await checkName(pages([repo("lumera-ui", 5000)]), OPTIONS, "lumera");
    expect(cell(near.cells, "github-repo")).toEqual({ status: "free" });
    const small = await checkName(
      pages([repo("Lumera", GITHUB_STARS_TAKEN - 1)]),
      OPTIONS,
      "lumera",
    );
    expect(cell(small.cells, "github-repo")).toEqual({ status: "free" });
    // The exact-name repository sits on page two, behind a full page of better-starred substring hits.
    const pageOne = Array.from({ length: 100 }, (_, i) => repo(`lumera-${i}`, 10000 - i));
    const deep = await checkName(
      pages(pageOne, [repo("lumera", GITHUB_STARS_TAKEN)]),
      OPTIONS,
      "lumera",
    );
    expect(cell(deep.cells, "github-repo")).toEqual({
      status: "taken",
      detail: `repo with ${GITHUB_STARS_TAKEN} stars`,
    });
    // A page ending under the threshold is the last one read: one request for a short result.
    requests = 0;
    await checkName(pages([repo("lumera-x", 3)]), OPTIONS, "lumera");
    expect(requests).toBe(1);
    // So is a short page, however starred: the results are exhausted.
    requests = 0;
    const short = await checkName(pages([repo("lumera-x", 9000)]), OPTIONS, "lumera");
    expect(cell(short.cells, "github-repo")).toEqual({ status: "free" });
    expect(requests).toBe(1);
    // Ten full pages still above the threshold with no exact hit: unknown, never free.
    const full = Array.from({ length: 100 }, (_, i) => repo(`lumera-${i}`, 500));
    const capped = await checkName(pages(...Array(12).fill(full)), OPTIONS, "lumera");
    expect(cell(capped.cells, "github-repo")).toEqual({
      status: "unknown",
      detail: "github search: over 1000 repos named like it above 20 stars",
    });
  });

  test("a GitHub search that says it is incomplete is unknown, not free", async () => {
    const io = fakeIo((url) =>
      url.pathname === "/search/repositories"
        ? { status: 200, body: { incomplete_results: true, items: [] } }
        : undefined,
    );
    const row = await checkName(io, OPTIONS, "lumera");
    expect(cell(row.cells, "github-repo")).toEqual({
      status: "unknown",
      detail: "github search reported incomplete results",
    });
  });

  test("Wiktionary is read from wikitext, sense by sense: a {{lb}} register label flags the word, ordinary text does not", async () => {
    const io = fakeIo((url) => {
      if (url.hostname !== "en.wiktionary.org") return undefined;
      const page = url.searchParams.get("page");
      if (page === "innocuo") {
        return wikitextReply(
          "==Italian==\n===Adjective===\n# [[harmless]]\n# A military offensive.\n# To slurp soup.\n",
        );
      }
      if (page === "ruder") {
        return wikitextReply(
          [
            "==Spanish==",
            "===Noun===",
            "# itinerant straw seller",
            "# {{lb|es|Nicaragua}} [[plumber]]",
            "# {{lb|es|Spain|colloquial|vulgar|pejorative}} [[wanker]], [[tosser]] {{gl|someone who wanks}}",
            "# {{lb|es|vulgar|slang}} {{synonym of|es|pene}}.",
            "#: an example line that must not count",
            "==Portuguese==",
            "# a [[rudder|rudder]]",
            "==French==",
            "# {{label|fr|informal|offensive}} [[landwhale]]",
            "==Portuguese==",
            "# {{lb|pt|Brazil|affectionate|_|slang|or|racial slur}} a [[nickname]]",
            "# {{lb|pt|coarse}} a [[curse]]",
          ].join("\n"),
        );
      }
      return MISSING_PAGE;
    });
    const harmless = await checkName(io, OPTIONS, "Innocuo");
    expect(cell(harmless.cells, "wiktionary")).toEqual({
      status: "taken",
      detail: "word in Italian",
    });
    const flagged = await checkName(io, OPTIONS, "ruder");
    expect(detail(cell(flagged.cells, "wiktionary"))).toBe(
      `${WIKTIONARY_FLAG}Spanish: wanker, tosser someone who wanks | Spanish: pene. | French: landwhale | Portuguese: a nickname | Portuguese: a curse`,
    );
    const none = await checkName(io, OPTIONS, RANDOM);
    expect(cell(none.cells, "wiktionary")).toEqual({ status: "free" });
  });

  test("a term label beside the headword flags the whole word, with no sense line carrying it", async () => {
    const io = fakeIo((url) => {
      if (url.hostname !== "en.wiktionary.org") return undefined;
      return url.searchParams.get("page") === "rudish"
        ? wikitextReply(
            "==English==\n===Noun===\n{{en-noun|-}} {{tlb|en|UK|Ireland|vulgar}}\n\n# [[nonsense]]\n",
          )
        : MISSING_PAGE;
    });
    const row = await checkName(io, OPTIONS, "rudish");
    expect(detail(cell(row.cells, "wiktionary"))).toBe(
      `${WIKTIONARY_FLAG}English: term labelled vulgar`,
    );
  });

  test("a flag found on one casing's page stands when the other page cannot be read; with no flag the failure is the cell", async () => {
    const io = (upper: Reply) =>
      fakeIo((url) => {
        if (url.hostname !== "en.wiktionary.org") return undefined;
        const page = url.searchParams.get("page");
        if (page === "ruder") return wikitextReply("==Spanish==\n# {{lb|es|vulgar}} [[wanker]]\n");
        if (page === "Ruder") return upper;
        return MISSING_PAGE;
      });
    const flagged = await checkName(io({ status: 429 }), OPTIONS, "ruder");
    expect(cell(flagged.cells, "wiktionary")).toEqual({
      status: "taken",
      detail: `${WIKTIONARY_FLAG}Spanish: wanker (another casing unknown(wiktionary HTTP 429))`,
    });
    const harmlessIo = fakeIo((url) => {
      if (url.hostname !== "en.wiktionary.org") return undefined;
      return url.searchParams.get("page") === "Tarn" ? { status: 429 } : MISSING_PAGE;
    });
    const unknownRow = await checkName(harmlessIo, OPTIONS, "tarn");
    expect(cell(unknownRow.cells, "wiktionary")).toEqual({
      status: "unknown",
      detail: "wiktionary HTTP 429",
    });
  });

  test("Wiktionary is asked for the spelling as given, the lowercase and the capitalised page, and told to follow redirects", async () => {
    const asGiven = fakeIo((url) => {
      if (url.hostname !== "en.wiktionary.org") return undefined;
      return url.searchParams.get("page") === "iLume"
        ? wikitextReply("==English==\n===Proper noun===\n# A brand.\n")
        : MISSING_PAGE;
    });
    const mixed = await checkName(asGiven, OPTIONS, "iLume");
    expect(cell(mixed.cells, "wiktionary")).toEqual({ status: "taken", detail: "word in English" });
    const io = fakeIo((url) => {
      if (url.hostname !== "en.wiktionary.org") return undefined;
      // An alternative spelling is a redirect page; MediaWiki resolves it only when asked.
      expect(url.searchParams.get("redirects")).toBe("1");
      return url.searchParams.get("page") === "Tarn"
        ? wikitextReply("==English==\n===Proper noun===\n# A river.\n")
        : MISSING_PAGE;
    });
    const row = await checkName(io, OPTIONS, "tarn");
    expect(cell(row.cells, "wiktionary")).toEqual({ status: "taken", detail: "word in English" });
  });

  test("Urban Dictionary's fuzzy hits are ignored; an exact entry is taken with its top definition", async () => {
    const io = fakeIo((url) => {
      if (url.hostname !== "api.urbandictionary.com") return undefined;
      if (url.searchParams.get("term") === "lumera") {
        return {
          status: 200,
          body: { list: [{ word: "lumerang", definition: "unrelated", thumbs_up: 9 }] },
        };
      }
      return {
        status: 200,
        body: {
          list: [
            { word: "Tarnix", definition: "[less] liked", thumbs_up: 1 },
            { word: "tarnix", definition: "the [popular] one", thumbs_up: 40 },
          ],
        },
      };
    });
    const fuzzy = await checkName(io, OPTIONS, "lumera");
    expect(cell(fuzzy.cells, "urban")).toEqual({ status: "free" });
    const exact = await checkName(io, OPTIONS, "tarnix");
    expect(cell(exact.cells, "urban")).toEqual({
      status: "taken",
      detail: "2 entries: the [popular] one",
    });
  });

  test("DNS: a resolving host is taken, ENOTFOUND is free, any other failure is unknown", async () => {
    const resolves = await checkName(
      fakeIo(() => undefined, ["lumera.com"]),
      OPTIONS,
      "lumera",
    );
    expect(cell(resolves.cells, "dns-com")).toEqual({
      status: "taken",
      detail: "lumera.com resolves",
    });
    const absent = await checkName(
      fakeIo(() => undefined),
      OPTIONS,
      "lumera",
    );
    expect(cell(absent.cells, "dns-com")).toEqual({ status: "free" });
    const timeout = await checkName(
      fakeIo(() => undefined, [], "ETIMEOUT"),
      OPTIONS,
      "lumera",
    );
    expect(cell(timeout.cells, "dns-com")).toEqual({
      status: "unknown",
      detail: "lumera.com ETIMEOUT",
    });
  });
});

describe("check-name.mts controls", () => {
  test("every column, DNS and arXiv included, has a taken control that fails when the instrument reads free", async () => {
    const failures = await runControls(
      fakeIo(() => undefined),
      WITH_ARXIV,
      RANDOM,
    );
    expect(failures.map((f) => f.column).sort()).toEqual(
      [
        "pypi",
        "npm",
        "crates",
        "homebrew",
        "docker",
        "maven",
        "hf",
        "github-user",
        "github-repo",
        "bluesky",
        "arxiv",
        "dns-com",
        "wiktionary",
        "urban",
      ].sort(),
    );
    expect(failures.every((f) => f.expected === "taken")).toBe(true);
    expect(failures.find((f) => f.column === "dns-com")?.control).toBe("nic");
  });

  test("a resolver blind to every host fails the DNS taken control while the HTTP controls pass", async () => {
    const failures = await runControls(allTakenIo([]), WITH_ARXIV, RANDOM);
    expect(failures).toEqual([
      { column: "dns-com", control: "nic", expected: "taken", got: { status: "free" } },
    ]);
  });

  test("the Wiktionary control must come back flagged: a label-less reading of the control word is a failed instrument", async () => {
    const base = allTakenIo(["nic.com"]);
    const io: Io = {
      ...base,
      fetch: async (input, init) => {
        const url = new URL(input);
        // Both the lowercase and the capitalised page come back without labels.
        if (
          url.hostname === "en.wiktionary.org" &&
          url.searchParams.get("page")?.toLowerCase() === "pajero"
        ) {
          return new Response(
            JSON.stringify({ parse: { wikitext: "==Spanish==\n# itinerant straw seller\n" } }),
            { status: 200 },
          );
        }
        return base.fetch(input, init);
      },
    };
    const failures = await runControls(io, OPTIONS, RANDOM);
    expect(failures).toEqual([
      {
        column: "wiktionary",
        control: "pajero",
        expected: "taken",
        got: { status: "taken", detail: "word in Spanish" },
      },
    ]);
  });

  test("a registry that answers 200 to the random control is a failed instrument, expected free", async () => {
    const io = withReply(
      allTakenIo(["nic.com"]),
      "registry.npmjs.org",
      () => new Response("{}", { status: 200 }),
    );
    const failures = await runControls(io, OPTIONS, RANDOM);
    expect(failures).toEqual([
      {
        column: "npm",
        control: RANDOM,
        expected: "free",
        got: { status: "taken", detail: "npm package" },
      },
    ]);
  });

  test("run() reports the candidate rows beside the control verdicts", async () => {
    const result = await run(allTakenIo(["nic.com"]), OPTIONS, ["lumera", "tarnix"]);
    expect(result.failures).toEqual([]);
    expect(result.rows.map((row) => row.name)).toEqual(["lumera", "tarnix"]);
  });
});

describe("check-name.mts registry table", () => {
  // A registry that exists only in this test: the table is the one place a column is defined, so
  // an entry added there must reach the columns, the header, and the control rows with no other
  // change. A column that needed a second edit elsewhere would be missing from one of them.
  const extra: Registry = {
    kind: "registry",
    id: "extra",
    label: "a registry added by the test",
    takenControl: "occupied",
    lookup: async (_io, name) =>
      name === "occupied" ? { status: "taken", detail: "extra entry" } : { status: "free" },
  };
  const extended: Options = { ...OPTIONS, table: [...REGISTRIES, extra] };

  test("an entry added to the table is a column, a header field, and a control row with no other change", async () => {
    expect(columns(extended).map((c) => c.id)).toEqual([
      ...columns(OPTIONS).map((c) => c.id),
      "extra",
    ]);
    const row = await checkName(
      fakeIo(() => undefined),
      extended,
      "lumera",
    );
    expect(cell(row.cells, "extra")).toEqual({ status: "free" });
    const tsv = renderTsv(extended, [row]);
    expect(tsv.split("\n")[0]?.endsWith("\turban\textra")).toBe(true);
    const failures = await runControls(allTakenIo(["nic.com"]), extended, RANDOM);
    expect(failures).toEqual([]);
    const blind: Options = {
      ...extended,
      table: [...REGISTRIES, { ...extra, lookup: async () => ({ status: "free" }) }],
    };
    expect(await runControls(allTakenIo(["nic.com"]), blind, RANDOM)).toEqual([
      { column: "extra", control: "occupied", expected: "taken", got: { status: "free" } },
    ]);
  });

  test("--registries narrows the columns, the controls, and the header to the ids named, dns ids included", async () => {
    const subset: Options = { ...WITH_ARXIV, registries: ["npm", "dns-com"] };
    expect(columns(subset).map((c) => c.id)).toEqual(["npm", "dns-com"]);
    const failures = await runControls(
      fakeIo(() => undefined),
      subset,
      RANDOM,
    );
    expect(failures.map((f) => f.column)).toEqual(["npm", "dns-com"]);
    const tsv = renderTsv(subset, []);
    expect(tsv).toBe("name\tnpm\tdns-com\n");
  });
});

describe("check-name.mts output", () => {
  test("the TSV carries one row per name with every cell spelled out, so an empty cell cannot pass as free", () => {
    const tsv = renderTsv(OPTIONS, [
      {
        name: "lumera",
        cells: {
          pypi: { status: "free" },
          npm: { status: "taken", detail: "npm package" },
          crates: { status: "unknown", detail: "crate HTTP 500" },
        },
      },
    ]);
    const [header, row] = tsv.trimEnd().split("\n");
    expect(header).toBe(
      "name\tpypi\tnpm\tcrates\thomebrew\tdocker\tmaven\thf\tgithub-user\tgithub-repo\tbluesky\tdns-com\twiktionary\turban",
    );
    expect(row).toBe(
      `lumera\tfree\ttaken(npm package)\tunknown(crate HTTP 500)${"\tunknown(missing)".repeat(10)}`,
    );
  });

  test("no name, or a name with characters no registry accepts, is a usage error before any lookup", () => {
    const none = Bun.spawnSync([process.execPath, SCRIPT], { stdout: "pipe", stderr: "pipe" });
    expect(none.exitCode).toBe(2);
    expect(none.stderr.toString()).toContain("usage:");
    // An id the table lacks, and an empty id (which would otherwise select no column at all and
    // print an empty row as a clean run), are refused before any lookup.
    for (const selection of ["npm,gopher", "", ",npm"]) {
      const refused = Bun.spawnSync(
        [process.execPath, SCRIPT, "--registries", selection, "lumera"],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(refused.exitCode, selection).toBe(2);
      expect(refused.stderr.toString(), selection).toContain("--registries");
    }
    // A valid selection that --no-arxiv then empties would print a clean row with no cells.
    const emptied = Bun.spawnSync(
      [process.execPath, SCRIPT, "--registries", "arxiv", "--no-arxiv", "lumera"],
      { stdout: "pipe", stderr: "pipe" },
    );
    expect(emptied.exitCode).toBe(2);
    expect(emptied.stderr.toString()).toContain("no column");
    // A space, a trailing dash, and a 40th character: each refused by some registry, so none
    // may be read as free there.
    for (const name of ["two words", "example-", `a${"b".repeat(39)}`]) {
      const bad = Bun.spawnSync([process.execPath, SCRIPT, "lumera", name], {
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(bad.exitCode, name).toBe(2);
      expect(bad.stderr.toString(), name).toContain(name);
    }
  });
});
