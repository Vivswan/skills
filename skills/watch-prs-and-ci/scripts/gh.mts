// Read-only gh plumbing shared by the watch-prs-and-ci modules: one spawnSync wrapper with an
// explicit timeout, and the response-shape helpers that turn a GraphQL reply into typed values.

import { spawnSync } from "node:child_process";

export const DEFAULT_TIMEOUT_MS = 60_000;

/** A read refused before it was made, by the guard the caller installed. */
export class AbortedRead extends Error {}

let guard: (() => string | null) | null = null;

/**
 * Installs a check made before every gh spawn; a reason returned refuses the read with AbortedRead.
 * Every read is synchronous and holds the event loop, so a caller whose owner may go away between
 * reads (the daemon's session) notices at the next read instead of at the end of a poll.
 */
export function guardReads(check: (() => string | null) | null): void {
  guard = check;
}

export function beforeRead(): void {
  const reason = guard?.() ?? null;
  if (reason !== null) throw new AbortedRead(reason);
}

/** A gh call or response-shape failure. The caller decides whether it retries. */
export class GhError extends Error {
  /** gh exits 1 on a GraphQL reply that carries an `errors` entry, with the reply still on stdout;
   * a reader that can use the partial `data` (pr-rows.mts) finds it here. */
  readonly stdout: string | undefined;
  /** What gh itself printed on a nonzero exit; absent on an error this module raised about the reply. */
  readonly stderr: string | undefined;

  constructor(message: string, stdout?: string, stderr?: string) {
    super(message);
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export function gh(args: string[], timeoutMs: number = DEFAULT_TIMEOUT_MS): string {
  beforeRead();
  const result = spawnSync("gh", args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    // A page of 100 review threads with three long comments each passes spawnSync's 1 MiB
    // default, which answers a valid reply with ENOBUFS.
    maxBuffer: Number.POSITIVE_INFINITY,
  });
  const call = `gh ${args.slice(0, 2).join(" ")}`;
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new GhError(`${call}: gh not found on PATH`);
    if (code === "ETIMEDOUT") throw new GhError(`${call}: no answer within ${timeoutMs} ms`);
    throw new GhError(`${call}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const stderr = result.stderr.trim();
    throw new GhError(
      `${call} exited ${result.status ?? "on a signal"}: ${stderr}`,
      result.stdout,
      stderr,
    );
  }
  return result.stdout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function get(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

export function requireNumber(value: unknown, what: string): number {
  if (typeof value !== "number") throw new GhError(`GraphQL response: ${what} is not a number`);
  return value;
}

export function requireString(value: unknown, what: string): string {
  if (typeof value !== "string") throw new GhError(`GraphQL response: ${what} is not a string`);
  return value;
}

export function parseJson(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new GhError(`${what} returned non-JSON output`);
  }
}
