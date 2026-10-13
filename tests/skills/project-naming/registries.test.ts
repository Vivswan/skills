import { describe, expect, test } from "bun:test";
import { checkName } from "../../../skills/project-naming/scripts/check-name.mts";
import {
  GITHUB_STARS_TAKEN,
  WIKTIONARY_FLAG,
} from "../../../skills/project-naming/scripts/columns/registries/readers.mts";
import type { Cell, Io } from "../../../skills/project-naming/scripts/core/cells.mts";
import {
  BLUESKY_FREE,
  CASK_INDEX,
  caskIndex,
  cell,
  detail,
  FORMULA_INDEX,
  fakeIo,
  formulaIndex,
  MISSING_PAGE,
  OPTIONS,
  RANDOM,
  type Reply,
  WITH_ARXIV,
  wikitextReply,
} from "../../helpers/project-naming";

describe("registries.mts readers", () => {
  test("Homebrew: a name is taken as a formula, a cask, an alias, an old name, or an old token in the indexes; the per-name pages answer canonical names only", async () => {
    // formula/python.json is a 404 while python is an alias of python@3.15, and cask/docker.json
    // a 404 while docker is an old token of docker-desktop: the per-name pages would read both
    // free. Only the index knows, so a name reads through the index and never a per-name page.
    const brew = (formula: Reply, cask: Reply) =>
      fakeIo((url) => {
        if (url.hostname !== "formulae.brew.sh") return undefined;
        if (url.pathname === FORMULA_INDEX) return formula;
        if (url.pathname === CASK_INDEX) return cask;
        throw new Error(`a per-name page was asked for: ${url.pathname}`);
      });
    const indexes = brew(
      formulaIndex([
        { name: "wget" },
        { name: "python@3.15", aliases: ["python", "python3"], oldnames: ["python-legacy"] },
        // An alias that every plain object inherits as a property must still be recorded.
        { name: "builder-kit", aliases: ["constructor"] },
      ]),
      caskIndex([{ token: "docker-desktop", old_tokens: ["docker"] }]),
    );
    const cases: [string, Cell][] = [
      ["wget", { status: "taken", detail: "homebrew formula wget" }],
      ["Python", { status: "taken", detail: "homebrew formula python@3.15 via alias" }],
      ["python-legacy", { status: "taken", detail: "homebrew formula python@3.15 via old name" }],
      ["docker-desktop", { status: "taken", detail: "homebrew cask docker-desktop" }],
      ["docker", { status: "taken", detail: "homebrew cask docker-desktop via old token" }],
      ["constructor", { status: "taken", detail: "homebrew formula builder-kit via alias" }],
      // The negative control: a name in neither index reads free with both indexes present, and
      // so does an inherited property name that no index lists (lowercase, as the lookup is).
      [RANDOM, { status: "free" }],
      ["__proto__", { status: "free" }],
    ];
    for (const [name, expected] of cases) {
      const row = await checkName(indexes, OPTIONS, name);
      expect(cell(row.cells, "homebrew"), name).toEqual(expected);
    }
    const down: Reply = { status: 503 };
    const wgetOnly = formulaIndex([{ name: "wget" }]);
    const dockerOnly = caskIndex([{ token: "docker-desktop" }]);
    const unreadable: [Reply, Reply, string, Cell][] = [
      [down, dockerOnly, "wget", { status: "unknown", detail: "homebrew formula index HTTP 503" }],
      [wgetOnly, down, "wget", { status: "taken", detail: "homebrew formula wget" }],
      [
        wgetOnly,
        down,
        "docker-desktop",
        { status: "unknown", detail: "homebrew cask index HTTP 503" },
      ],
      [
        down,
        dockerOnly,
        "docker-desktop",
        { status: "taken", detail: "homebrew cask docker-desktop" },
      ],
    ];
    for (const [formula, cask, name, expected] of unreadable) {
      const row = await checkName(brew(formula, cask), OPTIONS, name);
      expect(cell(row.cells, "homebrew"), `${formula.status}/${cask.status} ${name}`).toEqual(
        expected,
      );
    }
    // A 200 whose body is not the index is unreadable, never an index with no entries.
    const malformed: Reply[] = [
      { status: 200, body: [] },
      { status: 200, body: [{ aliases: [], oldnames: [] }] },
      { status: 200, body: [{ name: "wget", aliases: "none", oldnames: [] }] },
      { status: 200, body: { message: "unavailable" } },
    ];
    for (const reply of malformed) {
      const row = await checkName(brew(reply, dockerOnly), OPTIONS, "wget");
      expect(cell(row.cells, "homebrew").status, JSON.stringify(reply.body)).toBe("unknown");
      expect(detail(cell(row.cells, "homebrew"))).toContain("reply malformed");
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
        expect(url.searchParams.get("q")).toBe('a:"lumera"');
        return reply;
      });
    // Artifact ids are case-sensitive: an id published in mixed case is missed by the lowercase
    // query alone, so the spelling as given is asked for too.
    const mixedCase = fakeIo((url) => {
      if (url.hostname !== "search.maven.org") return undefined;
      const hit = url.searchParams.get("q") === 'a:"JLargeArrays"';
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

  test("a Maven artifact id with a dash is asked for as a quoted phrase, so the count is for that id and not for a parsed expression", async () => {
    // Unquoted, the hyphen is left to the query parser; the count must be for the id as written.
    const seen: string[] = [];
    const counting = (count: number) =>
      fakeIo((url) => {
        if (url.hostname !== "search.maven.org") return undefined;
        seen.push(url.search);
        const asked = url.searchParams.get("q");
        return {
          status: 200,
          body: { response: { numFound: asked === 'a:"foo-bar"' ? count : 0 } },
        };
      });
    const taken = await checkName(counting(2), OPTIONS, "foo-bar");
    expect(cell(taken.cells, "maven")).toEqual({ status: "taken", detail: "2 maven artifact(s)" });
    expect(seen).toEqual(["?q=a%3A%22foo-bar%22&rows=0&wt=json"]);
    const free = await checkName(counting(0), OPTIONS, "foo-bar");
    expect(cell(free.cells, "maven")).toEqual({ status: "free" });
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

  test("arXiv, Maven Central, and GitHub search lookups each run one at a time across the rows of a process", async () => {
    const inFlight: Record<string, number> = {};
    const overlap: Record<string, number> = {};
    const base = fakeIo(() => undefined);
    const serialised = (url: URL) =>
      url.hostname === "export.arxiv.org" ||
      url.hostname === "search.maven.org" ||
      url.pathname === "/search/repositories";
    const io: Io = {
      ...base,
      fetch: async (input, init) => {
        const url = new URL(input);
        if (!serialised(url)) return base.fetch(input, init);
        const host = url.hostname;
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

  test("GitHub searches, pages and rows alike, are the Io's gap apart: 30 searches a minute per token is shared by every lane on the machine", async () => {
    const gap = 40;
    const starts: number[] = [];
    const base = fakeIo((url) => {
      if (url.pathname !== "/search/repositories") return undefined;
      starts.push(Date.now());
      // A full page above the threshold, so a second page is asked for; then a short one.
      const full = Array.from({ length: 100 }, (_, i) => ({
        name: `other-${i}`,
        stargazers_count: 500,
      }));
      return { status: 200, body: { items: url.searchParams.get("page") === "1" ? full : [] } };
    });
    const io: Io = { ...base, githubSearchGapMs: gap };
    await Promise.all(["lumera", "tarnix"].map((n) => checkName(io, OPTIONS, n)));
    expect(starts).toHaveLength(4);
    for (let i = 1; i < starts.length; i++) {
      // A timer can wake a millisecond or two early.
      expect((starts[i] ?? 0) - (starts[i - 1] ?? 0), `gap ${i}`).toBeGreaterThanOrEqual(gap - 5);
    }
  });

  test("a GitHub search answered 403 or 429 is the rate limit, so the cell says to retry later", async () => {
    for (const status of [403, 429]) {
      const io = fakeIo((url) =>
        url.pathname === "/search/repositories" ? { status } : undefined,
      );
      const row = await checkName(io, OPTIONS, "lumera");
      expect(cell(row.cells, "github-repo"), String(status)).toEqual({
        status: "unknown",
        detail: "github search rate-limited; retry later",
      });
    }
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

  test("a GitHub search 200 whose body is not the result list (no items, items not a list, an item without a name or a star count, a non-boolean incomplete flag) is unknown, never free and never a thrown run", async () => {
    const malformed: unknown[] = [
      null,
      {},
      { items: "none" },
      { items: [{}] },
      { items: [{ name: "lumera" }] },
      { items: [{ name: 7, stargazers_count: 100 }] },
      { items: [], incomplete_results: "true" },
    ];
    for (const body of malformed) {
      const io = fakeIo((url) =>
        url.pathname === "/search/repositories" ? { status: 200, body } : undefined,
      );
      const row = await checkName(io, OPTIONS, "lumera");
      expect(cell(row.cells, "github-repo").status, JSON.stringify(body)).toBe("unknown");
      expect(detail(cell(row.cells, "github-repo")), JSON.stringify(body)).toContain(
        "github search reply malformed",
      );
    }
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

  test("the older label aliases {{cx}} and {{context}} flag a sense as {{lb}} does, the legacy lang= form included, and a named argument is never a label", async () => {
    const pages: Record<string, string> = {
      lbword: "# {{lb|en|vulgar|slang}} [[prick]]",
      cxword: "# {{cx|en|vulgar|slang}} [[prick]]",
      ctxword: "# {{context|en|vulgar|slang}} [[prick]]",
      // The legacy form names the language as an argument, so every unnamed one is a label.
      legacyword: "# {{context|vulgar|slang|lang=en}} [[prick]]",
      // The oldest form names no language at all: its first argument is a label, not a code.
      bareword: "# {{context|vulgar}} [[prick]]",
      barecx: "# {{cx|vulgar|slang}} [[prick]]",
      // A label may be a link template; its `|` and `}}` are its own, not the label list's.
      nestedword: "# {{cx|en|{{l|en|slang}}|vulgar}} [[prick]]",
      plainword: "# {{cx|en|British|nocat=1}} [[lorry]]",
      // A nested template inside a named argument is no label either, and leaves the gloss.
      sortedword: "# {{context|en|British|sort={{l|en|vulgar}}}} [[lorry]]",
      // A gloss wrapped in a template with templates inside reads as its text, inner ones first.
      nestedgloss:
        "# {{lb|en|vulgar}} {{ng|A contraction of {{l|en|foo}} or {{l|en|bar}}, meaning [[baz]].}}",
      // A piped link inside a template is a link, not an argument boundary.
      linkedgloss:
        "# {{lb|en|vulgar}} {{ng|An insult for a {{l|en|foo}}, a seller of [[straw|straw]].}}",
    };
    const io = fakeIo((url) => {
      if (url.hostname !== "en.wiktionary.org") return undefined;
      const body = pages[url.searchParams.get("page") ?? ""];
      return body ? wikitextReply(`==English==\n===Noun===\n${body}\n`) : MISSING_PAGE;
    });
    for (const page of [
      "lbword",
      "cxword",
      "ctxword",
      "legacyword",
      "bareword",
      "barecx",
      "nestedword",
    ]) {
      const row = await checkName(io, OPTIONS, page);
      expect(cell(row.cells, "wiktionary"), page).toEqual({
        status: "taken",
        detail: `${WIKTIONARY_FLAG}English: prick`,
      });
    }
    for (const page of ["plainword", "sortedword"]) {
      const plain = await checkName(io, OPTIONS, page);
      expect(cell(plain.cells, "wiktionary"), page).toEqual({
        status: "taken",
        detail: "word in English",
      });
    }
    const nested = await checkName(io, OPTIONS, "nestedgloss");
    expect(detail(cell(nested.cells, "wiktionary"))).toBe(
      `${WIKTIONARY_FLAG}English: A contraction of foo or bar, meaning baz.`,
    );
    const linked = await checkName(io, OPTIONS, "linkedgloss");
    expect(detail(cell(linked.cells, "wiktionary"))).toBe(
      `${WIKTIONARY_FLAG}English: An insult for a foo, a seller of straw.`,
    );
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

  test("a 200 whose JSON body is null is a malformed Wiktionary reply: the cell is unknown and the row still carries every other column", async () => {
    const io = fakeIo((url) =>
      url.hostname === "en.wiktionary.org" ? { status: 200, body: null } : undefined,
    );
    const row = await checkName(io, OPTIONS, "tarn");
    expect(cell(row.cells, "wiktionary")).toEqual({
      status: "unknown",
      detail: "wiktionary reply malformed: not an object",
    });
    expect(cell(row.cells, "pypi")).toEqual({ status: "free" });
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

  test("Urban Dictionary's fuzzy hits are ignored; an exact entry is taken with its top definition; a 200 without the list, or with an entry without a word, is unknown, never free", async () => {
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
    const malformed: [unknown, string][] = [
      [null, "no list"],
      [{}, "no list"],
      [{ list: "none" }, "no list"],
      [{ list: [{}] }, "an entry has no word"],
      [{ list: [{ definition: "synthetic slang" }] }, "an entry has no word"],
    ];
    for (const [body, what] of malformed) {
      const io = fakeIo((url) =>
        url.hostname === "api.urbandictionary.com" ? { status: 200, body } : undefined,
      );
      const row = await checkName(io, OPTIONS, "lumera");
      expect(cell(row.cells, "urban"), JSON.stringify(body)).toEqual({
        status: "unknown",
        detail: `urban reply malformed: ${what}`,
      });
    }
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
