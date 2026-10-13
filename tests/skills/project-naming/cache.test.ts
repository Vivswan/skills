import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkName } from "../../../skills/project-naming/scripts/check-name.mts";
import { PYPI_TOP_URL } from "../../../skills/project-naming/scripts/columns/typosquat.mts";
import type { Io } from "../../../skills/project-naming/scripts/core/cells.mts";
import { cell, detail, OPTIONS, PAGES, sourcesIo, withReply } from "../../helpers/project-naming";
import { tempDirs } from "../../helpers/temp-dirs";

const temp = tempDirs();

describe("cache.mts", () => {
  test("the PyPI ranking and the Homebrew indexes are fetched once per process and read from the cache directory for a day, after which they are fetched again", async () => {
    const scratch = temp.dir("check-name-cache-");
    const cacheDir = join(scratch, "cache");
    // The Homebrew indexes are tens of megabytes: fetched per name, a batch of twenty would pull
    // them twenty times.
    let fetches = 0;
    let indexFetches = 0;
    const counting = (): Io => {
      const base = sourcesIo(["requests"], [], []);
      return {
        ...base,
        cacheDir,
        fetch: (input, init) => {
          const url = new URL(input);
          if (url.hostname === "hugovk.dev") fetches++;
          if (url.hostname === "formulae.brew.sh") indexFetches++;
          return base.fetch(input, init);
        },
      };
    };
    const first = counting();
    await Promise.all(["lumera", "tarnix"].map((name) => checkName(first, OPTIONS, name)));
    expect(fetches).toBe(1);
    expect(indexFetches).toBe(2);
    // A ranking an earlier build cached empty is a miss, not a complete list: with that file on
    // disk and the fetch answering empty too, the source fails instead of reading every name free.
    const emptyCache = join(scratch, "empty-ranking");
    mkdirSync(emptyCache, { recursive: true });
    writeFileSync(
      join(emptyCache, `${createHash("sha256").update(PYPI_TOP_URL).digest("hex")}.json`),
      "[]",
    );
    const emptyAgain = withReply(
      { ...sourcesIo([], [], []), cacheDir: emptyCache },
      "hugovk.dev",
      () => new Response(JSON.stringify({ rows: [] }), { status: 200 }),
    );
    const cachedEmpty = await checkName(emptyAgain, OPTIONS, "numpi");
    expect(detail(cell(cachedEmpty.cells, "typosquat"))).toContain(
      "rows has 0 entries, expected at least 5000",
    );
    // A malformed reply is not cached: the next process asks again.
    const broken = withReply(
      { ...sourcesIo([], [], []), cacheDir: join(scratch, "broken") },
      "hugovk.dev",
      () => new Response("not json", { status: 200 }),
    );
    await checkName(broken, OPTIONS, "lumera");
    // The npm ranking, every crates ranking page, and the two Homebrew indexes.
    expect(readdirSync(join(scratch, "broken"))).toHaveLength(1 + PAGES + 2);
    // A cache directory that cannot be made (its path is a file) costs the fetch, not the cell.
    writeFileSync(join(scratch, "blocked"), "");
    const unwritable = { ...sourcesIo(["requests"], [], []), cacheDir: join(scratch, "blocked") };
    const stillRead = await checkName(unwritable, OPTIONS, "requestz");
    expect(cell(stillRead.cells, "typosquat").status).toBe("taken");
    const row = await checkName(counting(), OPTIONS, "requestz");
    expect(fetches).toBe(1);
    expect(indexFetches).toBe(2);
    expect(cell(row.cells, "typosquat").status).toBe("taken");
    // A day later every file is stale: the ranking is fetched again, and a stale entry no lookup
    // refreshes (a search for a name this run never asks about) leaves with the purge.
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
    writeFileSync(join(cacheDir, "orphan.json"), "{}");
    for (const entry of readdirSync(cacheDir)) utimesSync(join(cacheDir, entry), stale, stale);
    await checkName(counting(), OPTIONS, "lumera");
    expect(fetches).toBe(2);
    expect(indexFetches).toBe(4);
    const left = readdirSync(cacheDir);
    expect(left).not.toContain("orphan.json");
    expect(left.length).toBeGreaterThan(0);
  });

  test("two processes on one cold cache fetch each list once: the second waits on the lock file beside the entry and reads its write; a dead holder's lock is broken, a live one past the request bound is left and worked around", async () => {
    const scratch = temp.dir("check-name-lock-");
    const requests: string[] = [];
    const isRanking = (url: URL) =>
      url.hostname === "hugovk.dev" ||
      url.hostname === "cdn.jsdelivr.net" ||
      url.pathname === "/api/v1/crates";
    // A separate Io is a separate process to the cache: its own memo, the shared directory.
    const processLike = (cacheDir: string, timeoutMs = 5_000): Io => {
      const base = sourcesIo([], [], ["tokio"]);
      return {
        ...base,
        cacheDir,
        timeoutMs,
        fetch: async (input, init) => {
          const url = new URL(input);
          if (isRanking(url)) {
            requests.push(url.href);
            await Bun.sleep(5);
          }
          return base.fetch(input, init);
        },
      };
    };
    const shared = join(scratch, "shared");
    const rows = await Promise.all(
      [processLike(shared), processLike(shared)].map((io) => checkName(io, OPTIONS, "tokios")),
    );
    expect(rows.map((row) => cell(row.cells, "typosquat").status)).toEqual(["taken", "taken"]);
    expect(requests).toHaveLength(2 + PAGES);
    expect(new Set(requests).size).toBe(requests.length);
    expect(readdirSync(shared).filter((entry) => entry.endsWith(".lock"))).toEqual([]);

    const pageOne = `https://crates.io/api/v1/crates?sort=downloads&per_page=100&page=1`;
    const lockOf = (dir: string) =>
      join(dir, `${createHash("sha256").update(pageOne).digest("hex")}.json.lock`);
    // The holder's pid has exited and been reaped by the time spawnSync returns.
    const orphaned = join(scratch, "orphaned");
    mkdirSync(orphaned);
    writeFileSync(lockOf(orphaned), `${spawnSync("true").pid}\n`);
    requests.length = 0;
    const afterDead = await checkName(processLike(orphaned), OPTIONS, "tokios");
    expect(cell(afterDead.cells, "typosquat").status).toBe("taken");
    expect(requests).toContain(pageOne);
    expect(existsSync(lockOf(orphaned))).toBe(false);
    // A live holder (this process) that never releases: the waiter gives it twice the request
    // bound, then fetches for itself and leaves the lock, since a live lock is never removed.
    const stuck = join(scratch, "stuck");
    mkdirSync(stuck);
    writeFileSync(lockOf(stuck), `${process.pid}\n`);
    requests.length = 0;
    const began = Date.now();
    const workedAround = await checkName(processLike(stuck, 50), OPTIONS, "tokios");
    expect(cell(workedAround.cells, "typosquat").status).toBe("taken");
    expect(Date.now() - began).toBeGreaterThanOrEqual(90);
    expect(requests).toContain(pageOne);
    expect(existsSync(lockOf(stuck))).toBe(true);
  });
});
