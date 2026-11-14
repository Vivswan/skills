import { describe, expect, test } from "bun:test";
import { checkName } from "../../../skills/project-naming/scripts/check-name.mts";
import type { Io } from "../../../skills/project-naming/scripts/core/cells.mts";
import { cell, detail, fakeIo, OPTIONS, withReply } from "../../helpers/project-naming";

describe("cells.mts", () => {
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
  test("a status-only lookup whose body cannot be released keeps its answer: the status decides, not the body", async () => {
    const erroring = (status: number) =>
      withReply(
        fakeIo(() => undefined),
        "crates.io",
        () => {
          const body = new ReadableStream({
            start(controller) {
              controller.error(new Error("ECONNRESET"));
            },
          });
          return new Response(body, { status });
        },
      );
    const free = await checkName(erroring(404), OPTIONS, "lumera");
    expect(cell(free.cells, "crates")).toEqual({ status: "free" });
    const taken = await checkName(erroring(200), OPTIONS, "lumera");
    expect(cell(taken.cells, "crates")).toEqual({ status: "taken", detail: "crate" });
  });

  test("a 429 is asked again after a doubling wait, three times, and the last answer stands", async () => {
    // One live lane put ten names a batch at Wiktionary in parallel and 140 of 191 readings came back 429 and blank.
    let calls = 0;
    const thenTaken = fakeIo((url) => {
      if (url.hostname !== "pypi.org") return undefined;
      calls++;
      return calls < 3 ? { status: 429 } : { status: 200 };
    });
    const recovered = await checkName({ ...thenTaken, retryBaseMs: 10 }, OPTIONS, "lumera");
    expect(cell(recovered.cells, "pypi")).toEqual({ status: "taken", detail: "pypi package" });
    expect(calls).toBe(3);

    calls = 0;
    const always = fakeIo((url) => {
      if (url.hostname !== "pypi.org") return undefined;
      calls++;
      return { status: 429 };
    });
    // Another registry's gap (GitHub's six seconds without a token) is not this registry's wait.
    const started = Date.now();
    const limited = await checkName(
      { ...always, retryBaseMs: 10, githubSearchGapMs: 6_000 },
      { ...OPTIONS, registries: ["pypi"] },
      "lumera",
    );
    expect(cell(limited.cells, "pypi")).toEqual({
      status: "unknown",
      detail: "pypi package HTTP 429",
    });
    expect(calls).toBe(4);
    // 10 + 20 + 40 ms of waiting, a timer waking a millisecond or two early allowed.
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(65);
    expect(waited).toBeLessThan(1_000);
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
});
