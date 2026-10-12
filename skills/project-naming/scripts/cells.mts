// The vocabulary every column speaks: a lookup that failed never reads as free, and a note is a
// reading with no free or taken in it.

export type Cell =
  | { status: "free" }
  | { status: "taken"; detail: string }
  | { status: "unknown"; detail: string }
  | { status: "note"; detail: string };

export type Io = {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** Resolves a hostname to at least one address, or throws (ENOTFOUND for an unregistered name). */
  resolve: (host: string) => Promise<unknown>;
  /** Lists a zone's name servers, or throws (ENOTFOUND for a zone no registry delegates). */
  resolveNs: (zone: string) => Promise<string[]>;
  githubToken: string | null;
  /** A request past this is an `unknown` cell, so one stalled endpoint cannot hold the table. */
  timeoutMs: number;
  /** arXiv asks for one request every three seconds; its lookups are serialised this far apart. */
  arxivGapMs: number;
  /** GitHub allows 30 searches a minute per token, 10 with none, and every lane on the machine
   * shares the token; the searches are serialised this far apart. */
  githubSearchGapMs: number;
  /** crates.io asks for one request a second from anything automated; its lookups and the pages
   * of its ranking are serialised this far apart. */
  cratesGapMs: number;
  /** Where the typosquat column keeps the day's popular-name lists, or null for no cache. */
  cacheDir: string | null;
};

const USER_AGENT = "check-name.mts (project-naming skill; https://github.com/Vivswan/skills)";

export async function get(
  io: Io,
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = io.timeoutMs,
): Promise<Response> {
  return io.fetch(url, {
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers },
  });
}

/** Whether the run claims a registry: `--registries` names the claimed ones, and a run without it
 * claims every registry. The page reads a typosquat hit on a claimed registry as a gate failure
 * and one on an unclaimed registry as a MINOR note, so the cell says which. */
export type Claimed = (registryId: string) => boolean;

export const free: Cell = { status: "free" };
export const taken = (detail: string): Cell => ({ status: "taken", detail });
export const unknown = (detail: string): Cell => ({ status: "unknown", detail });

export function renderCell(cell: Cell): string {
  if (cell.status === "free") return "free";
  return `${cell.status}(${cell.detail})`;
}

/** One lookup at a time against a host that punishes bursts, `gapMs` apart. The gap is waited
 * before a lookup, never after one, so the last lookup ends the process. */
export function serialQueue(): <T>(gapMs: number, work: () => Promise<T>) => Promise<T> {
  let turn: Promise<void> = Promise.resolve();
  let lastDone = 0;
  return (gapMs, work) => {
    const mine = turn.then(async () => {
      const wait = lastDone + gapMs - Date.now();
      if (wait > 0) await Bun.sleep(wait);
      try {
        return await work();
      } finally {
        lastDone = Date.now();
      }
    });
    turn = mine.then(
      () => undefined,
      () => undefined,
    );
    return mine;
  };
}
