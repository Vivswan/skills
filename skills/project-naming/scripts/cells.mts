// The vocabulary every column speaks: a lookup that failed never reads as free.

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

export const free: Cell = { status: "free" };
export const taken = (detail: string): Cell => ({ status: "taken", detail });
export const unknown = (detail: string): Cell => ({ status: "unknown", detail });

export function renderCell(cell: Cell): string {
  if (cell.status === "free") return "free";
  return `${cell.status}(${cell.detail})`;
}
