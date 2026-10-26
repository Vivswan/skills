import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkName,
  type Options,
  runControls,
} from "../../../skills/project-naming/scripts/check-name.mts";
import { oneEditApart } from "../../../skills/project-naming/scripts/columns/typosquat.mts";
import type { Cell, Io } from "../../../skills/project-naming/scripts/core/cells.mts";
import {
  allTakenIo,
  CRATES_PAGE,
  cell,
  detail,
  npmModule,
  OPTIONS,
  PAGE,
  PAGES,
  RANDOM,
  type Reply,
  ranking,
  sourcesIo,
  TOP,
  withReply,
} from "../../helpers/project-naming";
import { tempDirs } from "../../helpers/temp-dirs";

const temp = tempDirs();

describe("typosquat.mts", () => {
  test("one edit apart means one insertion, deletion, substitution, or adjacent transposition; exact and two-edit names are not", () => {
    const cases: [string, string, boolean][] = [
      ["requezts", "requests", true],
      ["request", "requests", true],
      ["requeststs", "requests", false],
      ["requestss", "requests", true],
      ["requetss", "requests", true],
      ["requests", "requests", false],
      ["requetsz", "requests", false],
      ["stseuqer", "requests", false],
      ["a", "", true],
      ["qz", "zq", true],
    ];
    for (const [a, b, expected] of cases) expect(oneEditApart(a, b), `${a} ~ ${b}`).toBe(expected);
  });

  /** Headers at once, the body a moment later, as a large or slow reply arrives; `settle` fires
   * once, when the body has been read or released. */
  function slowReply(status: number, body: unknown, settle: () => void): Response {
    let cancelled = false;
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const stream = new ReadableStream({
      async start(controller) {
        await Bun.sleep(20);
        if (!cancelled) {
          controller.enqueue(bytes);
          controller.close();
        }
        settle();
      },
      cancel() {
        cancelled = true;
        settle();
      },
    });
    return new Response(stream, { status });
  }

  /** An Io whose crates.io replies stream slowly (the first ranking page with `pageStatus`, the
   * `tokios` lookup a 404), and whose `overlaps` collects every crates.io request that opened
   * while another was still unsettled. */
  function overlapWatchingIo(pageStatus: number, overlaps: string[]): Io {
    let open = 0;
    const base = sourcesIo([], [], ["tokio"]);
    const settleOnce = (): (() => void) => {
      let settled = false;
      return () => {
        if (settled) return;
        settled = true;
        open--;
      };
    };
    return {
      ...base,
      fetch: async (input, init) => {
        const url = new URL(input);
        if (url.hostname !== "crates.io") return base.fetch(input, init);
        if (open > 0) overlaps.push(url.pathname + url.search);
        open++;
        const settle = settleOnce();
        if (url.pathname === "/api/v1/crates" && url.searchParams.get("page") === "1") {
          return slowReply(pageStatus, CRATES_PAGE(["tokio"]).body, settle);
        }
        if (url.pathname === "/api/v1/crates/tokios") return slowReply(404, {}, settle);
        const response = await base.fetch(input, init);
        settle();
        return response;
      },
    };
  }

  test("crates.io sees one request at a time, body included: a second name's crate lookup waits for a ranking page still streaming, and a status-only lookup or a failed page releases its body before the next request", async () => {
    for (const pageStatus of [200, 503]) {
      const overlaps: string[] = [];
      const io = overlapWatchingIo(pageStatus, overlaps);
      // The second name's crate lookup queues behind the first name's ranking page.
      const rows = await Promise.all(["tokios", "serdes"].map((n) => checkName(io, OPTIONS, n)));
      expect(
        rows.map((row) => cell(row.cells, "typosquat").status),
        String(pageStatus),
      ).toEqual(pageStatus === 200 ? ["taken", "free"] : ["unknown", "unknown"]);
      expect(overlaps, String(pageStatus)).toEqual([]);
    }
  });

  test("the crates lane compares against the top-by-downloads ranking read page by page with no search, so a neighbour the search would not return is still a hit", async () => {
    const seen: string[] = [];
    const base = sourcesIo([], [], ["tokio"]);
    const io: Io = {
      ...base,
      fetch: (input, init) => {
        const url = new URL(input);
        if (url.pathname === "/api/v1/crates") seen.push(url.pathname + url.search);
        return base.fetch(input, init);
      },
    };
    const row = await checkName(io, OPTIONS, "tokios");
    expect(cell(row.cells, "typosquat")).toEqual({
      status: "taken",
      detail: `1 edit from tokio on claimed crates (top 2000 by downloads)`,
    });
    expect(seen).toEqual(
      Array.from(
        { length: PAGES },
        (_, i) => `/api/v1/crates?sort=downloads&per_page=100&page=${i + 1}`,
      ),
    );
    // A page that could not be read fails the whole list: the names past it were never compared.
    const cut = withReply(sourcesIo([], [], ["tokio"]), "crates.io", () => {
      return new Response("", { status: 503 });
    });
    const unread = await checkName(cut, OPTIONS, "tokios");
    expect(cell(unread.cells, "typosquat")).toEqual({
      status: "unknown",
      detail: "claimed crates lookup failed (crates ranking page 1 HTTP 503)",
    });
  });

  test("a hit names the package, the registry with whether the run claims it, and the basis; every source hit is listed; an exact match is the registry column's business, not a typo", async () => {
    const io = sourcesIo(["requests", "Requezt"], ["request"], ["requests"]);
    const row = await checkName(io, OPTIONS, "requezts");
    expect(cell(row.cells, "typosquat")).toEqual({
      status: "taken",
      detail: `1 edit from requests on claimed pypi (top 5000 by downloads); 1 edit from requests on claimed crates (top 2000 by downloads)`,
    });
    // The page reads a hit on an unclaimed registry as MINOR and one on a claimed registry as a
    // gate failure, so the cell says which: --registries names the claimed ones.
    const cratesBrief: Options = { ...OPTIONS, registries: ["crates", "typosquat"] };
    const partly = await checkName(io, cratesBrief, "requezts");
    expect(cell(partly.cells, "typosquat")).toEqual({
      status: "taken",
      detail: `1 edit from requests on unclaimed pypi (top 5000 by downloads); 1 edit from requests on claimed crates (top 2000 by downloads)`,
    });
    const exact = await checkName(sourcesIo(["requests"], [], []), OPTIONS, "Requests");
    expect(cell(exact.cells, "typosquat")).toEqual({ status: "free" });
  });

  test("npm names are read from the npm-high-impact module's quoted strings, scoped packages included", async () => {
    const row = await checkName(sourcesIo([], ["@types/node", "react"], []), OPTIONS, "Reactt");
    expect(cell(row.cells, "typosquat")).toEqual({
      status: "taken",
      detail: "1 edit from react on claimed npm (top 5000 by downloads)",
    });
  });

  test("a 200 whose body is not the list (an error object, an entry without a name, an empty module) is a source that could not be read, never an empty list", async () => {
    const malformed: [string, Reply][] = [
      ["hugovk.dev", { status: 200, body: { message: "unavailable" } }],
      ["hugovk.dev", { status: 200, body: { rows: [{ project: 7 }] } }],
      // An empty full ranking is malformed, not a registry with nothing popular: with PyPI's
      // rows empty and npm carrying the control, the control would pass while numpi read free.
      ["hugovk.dev", { status: 200, body: { rows: [] } }],
      ["hugovk.dev", { status: 200, text: "not json" }],
      ["cdn.jsdelivr.net", { status: 200, text: "export const topDownload = []\n" }],
      ["cdn.jsdelivr.net", { status: 200, body: { error: "Cannot load 'react' ranking" } }],
      ["crates.io", { status: 200, body: { crates: "none" } }],
    ];
    for (const [host, reply] of malformed) {
      const io = withReply(sourcesIo([], [], []), host, () => {
        const text = reply.text ?? JSON.stringify(reply.body);
        return new Response(text, { status: reply.status });
      });
      const row = await checkName(io, OPTIONS, "lumera");
      expect(cell(row.cells, "typosquat").status, `${host} ${JSON.stringify(reply)}`).toBe(
        "unknown",
      );
      expect(detail(cell(row.cells, "typosquat"))).toContain("reply malformed");
      const stands = withReply(sourcesIo(["requests"], [], []), host, () => {
        const text = reply.text ?? JSON.stringify(reply.body);
        return new Response(text, { status: reply.status });
      });
      const hit = await checkName(stands, OPTIONS, "requestz");
      expect(cell(hit.cells, "typosquat").status, host).toBe(
        host === "hugovk.dev" ? "unknown" : "taken",
      );
      expect(detail(cell(hit.cells, "typosquat")), host).toContain("lookup failed");
    }
  });

  test("a source that could not be read is the cell when nothing hit, and is named beside a hit elsewhere, so a hit on an unclaimed registry cannot hide a failed lookup on a claimed one", async () => {
    const down = withReply(
      sourcesIo([], [], []),
      "hugovk.dev",
      () => new Response("", { status: 503 }),
    );
    const row = await checkName(down, OPTIONS, "lumera");
    expect(cell(row.cells, "typosquat")).toEqual({
      status: "unknown",
      detail: "claimed pypi lookup failed (top-pypi-packages HTTP 503)",
    });
    // A crates-only brief: the PyPI hit is a MINOR note on the page, and the crates ranking, the
    // one list the brief gates on, could not be read. Reported as the hit alone, the row would
    // pass the gate on a lookup that never happened.
    const cratesBrief: Options = { ...OPTIONS, registries: ["crates", "typosquat"] };
    const cratesDown = withReply(
      sourcesIo(["lumeras"], [], []),
      "crates.io",
      () => new Response("", { status: 503 }),
    );
    const hidden = await checkName(cratesDown, cratesBrief, "lumera");
    expect(cell(hidden.cells, "typosquat")).toEqual({
      status: "taken",
      detail:
        "1 edit from lumeras on unclaimed pypi (top 5000 by downloads); claimed crates lookup failed (crates ranking page 1 HTTP 503)",
    });
    const nothingHit = await checkName(
      withReply(sourcesIo([], [], []), "crates.io", () => new Response("", { status: 503 })),
      cratesBrief,
      "lumera",
    );
    expect(cell(nothingHit.cells, "typosquat")).toEqual({
      status: "unknown",
      detail: "claimed crates lookup failed (crates ranking page 1 HTTP 503)",
    });
  });

  test("a cut list is never a ranking: a crates page under 100, or a PyPI or npm list under its top 5000, is the cell unknown naming source and count, a page cached short is fetched again, and the control run reports the lane dark", async () => {
    // With regex on every list and requests cut from PyPI's, the regez control passed on all
    // three while requestz read free: a list is complete only at the size its source publishes.
    const cut = (host: string, reply: Reply) =>
      withReply(
        sourcesIo([], [], []),
        host,
        () => new Response(reply.text ?? JSON.stringify(reply.body), { status: reply.status }),
      );
    const short = TOP - 1;
    const cases: [string, Reply, string][] = [
      [
        "crates.io",
        {
          status: 200,
          body: { crates: ranking([], PAGE - 1).map((name) => ({ name })) },
        },
        `claimed crates lookup failed (crates ranking page 1 reply malformed: page has 99 entries, expected 100)`,
      ],
      [
        "hugovk.dev",
        {
          status: 200,
          body: { rows: ranking(["requests"], short).map((project) => ({ project })) },
        },
        `claimed pypi lookup failed (top-pypi-packages reply malformed: rows has ${short} entries, expected at least 5000)`,
      ],
      [
        "cdn.jsdelivr.net",
        { status: 200, text: npmModule(ranking(["requests"], short)) },
        `claimed npm lookup failed (npm-high-impact reply malformed: the module has ${short} entries, expected at least 5000)`,
      ],
    ];
    for (const [host, reply, expected] of cases) {
      const row = await checkName(cut(host, reply), OPTIONS, "requestz");
      expect(cell(row.cells, "typosquat"), host).toEqual({ status: "unknown", detail: expected });
    }
    // A page an earlier run kept short is a miss: the fetch answers whole and the hit stands.
    const scratch = temp.dir("check-name-short-page-");
    const pageOne = `https://crates.io/api/v1/crates?sort=downloads&per_page=100&page=1`;
    writeFileSync(
      join(scratch, `${createHash("sha256").update(pageOne).digest("hex")}.json`),
      JSON.stringify(ranking([], PAGE - 1)),
    );
    const refetched = await checkName(
      { ...sourcesIo([], [], ["tokio"]), cacheDir: scratch },
      OPTIONS,
      "tokios",
    );
    expect(cell(refetched.cells, "typosquat").status).toBe("taken");
    // The controls: PyPI and npm carry regex, so the taken row is taken on those two with the cut
    // crates page as the failure beside them, and the random row is unknown. Both read as dark.
    const base = allTakenIo(["nic.com"]);
    const [, cutPage] = cases[0] as [string, Reply, string];
    const cratesCut: Io = {
      ...base,
      fetch: (input, init) =>
        new URL(input).pathname === "/api/v1/crates"
          ? Promise.resolve(Response.json(cutPage.body))
          : base.fetch(input, init),
    };
    const failures = await runControls(cratesCut, OPTIONS, RANDOM);
    expect(failures.map((f) => [f.column, f.control, f.got.status])).toEqual([
      ["typosquat", "regez", "taken"],
      ["typosquat", RANDOM, "unknown"],
    ]);
    expect(detail((failures[0] as { got: Cell }).got)).toContain(
      `crates ranking page 1 reply malformed: page has 99 entries, expected 100`,
    );
  });
});
