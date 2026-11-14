import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";

import { basename, dirname, join, relative } from "node:path";

// --- Self-build: run as source, bundle into <skill>/.build/ and run the bundle; run as the bundle, do nothing.
// docs/authoring.md > Dependencies owns this block; the smoke test keeps every copy identical.

function buildPaths(source: string) {
  // An entry may sit below scripts/: the skill root is the parent of the scripts/ with the manifest beside it.
  let scripts = dirname(source);
  while (basename(scripts) !== "scripts" || !existsSync(join(dirname(scripts), "package.json"))) {
    if (dirname(scripts) === scripts) {
      console.error(
        `${source}: no scripts/ directory with a package.json beside it above the script`,
      );
      process.exit(2);
    }
    scripts = dirname(scripts);
  }
  const skill = dirname(scripts);
  const built = join(skill, ".build", relative(scripts, source).replace(/\.mts$/, ".js"));
  return { scripts, skill, built };
}

function buildIsStale(scripts: string, skill: string, built: string): boolean {
  if (!existsSync(built)) return true;
  // An entry imports its siblings, and a pin bump changes the bundle, so every script and the manifest count.
  const inputs = readdirSync(scripts, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".mts"))
    .map((name) => join(scripts, name));
  inputs.push(join(skill, "package.json"));
  const newest = Math.max(...inputs.map((path) => statSync(path).mtimeMs));
  return statSync(built).mtimeMs < newest;
}

function runBun(args: string[]): boolean {
  const step = spawnSync("bun", args, { stdio: ["ignore", "ignore", "pipe"] });
  if (step.status !== 0) process.stderr.write(step.stderr);
  return step.status === 0;
}

function build(source: string, scripts: string, skill: string, built: string): boolean {
  // bun build resolves installed packages only, from a node_modules beside the entry, and two first runs at
  // once must never share one: each build gets its own scratch under .build/ and publishes by one rename.
  mkdirSync(join(skill, ".build"), { recursive: true });
  const scratch = mkdtempSync(join(skill, ".build", "scratch-"));
  try {
    cpSync(scripts, join(scratch, "scripts"), { recursive: true });
    copyFileSync(join(skill, "package.json"), join(scratch, "package.json"));
    const entry = join(scratch, "scripts", relative(scripts, source));
    const bundle = join(scratch, "bundle.js");
    const ok =
      runBun(["install", "--production", "--no-save", "--cwd", scratch]) &&
      runBun(["build", entry, "--target", "bun", "--outfile", bundle]);
    if (!ok) return false;
    mkdirSync(dirname(built), { recursive: true });
    renameSync(bundle, built);
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function ensureBuilt(source: string): Promise<boolean> {
  if (!source.endsWith(".mts")) return Promise.resolve(false);
  const { scripts, skill, built } = buildPaths(source);
  if (buildIsStale(scripts, skill, built) && !build(source, scripts, skill, built)) process.exit(2);
  // The bundle runs on this process's stdio, and a signal to this process goes on to it; this process then ends as
  // the bundle did, by its status, or by the same signal once the forwarding is off and the signal's default is back.
  const run = spawn("bun", [built, ...process.argv.slice(2)], { stdio: "inherit" });
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const forward = (signal: NodeJS.Signals) => {
    run.kill(signal);
  };
  for (const signal of signals) process.on(signal, forward);
  return new Promise((resolve) => {
    const settle = (status: number | null, signal: NodeJS.Signals | null) => {
      for (const name of signals) process.off(name, forward);
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = status ?? 1;
      resolve(true);
    };
    run.on("exit", settle);
    // A bundle that never started (no bun on PATH) emits error and no exit: that is the run's failure.
    run.on("error", (error) => {
      console.error(String(error));
      settle(1, null);
    });
  });
}

// Only the command builds; a test or a sibling importing this file must not.
if (import.meta.main && (await ensureBuilt(import.meta.path))) process.exit();

// Loaded below the guard: a static import is hoisted above it and would resolve on the source path.

const { default: pRetry } = await import("p-retry");

// The vocabulary every column speaks: a lookup that failed never reads as free, and a note is a
// reading with no free or taken in it. A free cell may carry a detail the table shows as MINOR.

export type Cell =
  | { status: "free"; detail?: string }
  | { status: "taken"; detail: string }
  | { status: "unknown"; detail: string }
  | { status: "note"; detail: string };

export type Io = {
  /** The live fetch in a run; a test injects hand-written replies here, so no test reaches the network. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;

  /** Resolves a hostname to at least one address, or throws (ENOTFOUND for an unregistered name). */
  resolve: (host: string) => Promise<unknown>;

  /** Lists a zone's name servers, or throws (ENOTFOUND for a zone no registry delegates). */
  resolveNs: (zone: string) => Promise<string[]>;

  /** From GH_TOKEN, GITHUB_TOKEN, or `gh auth token`; null runs the GitHub columns anonymously, at the lower search rate. */
  githubToken: string | null;

  /** A request past this is an `unknown` cell, so one stalled endpoint cannot hold the table. */
  timeoutMs: number;

  /** arXiv asks for one request every three seconds; its lookups are serialised this far apart. */
  arxivGapMs: number;

  /** GitHub allows 30 searches a minute per token, 10 with none, and every lane on the machine shares the token; the searches are serialised this far apart. */
  githubSearchGapMs: number;

  /** Stars from which an exact-name GitHub repository counts as taken (`--github-stars`); a less-starred one is a free cell naming its stars. */
  githubStarsTaken: number;

  /** crates.io asks for one request a second from anything automated; its lookups and the pages of its ranking are serialised this far apart. */
  cratesGapMs: number;

  /** Where the typosquat column keeps the day's popular-name lists, or null for no cache. */
  cacheDir: string | null;

  /** A 429 is waited out this long and asked again, the wait doubling, RATE_LIMIT_RETRIES times; 0 in tests. */
  retryBaseMs: number;
};

/** How many times a 429 is asked again before the last answer stands. */
export const RATE_LIMIT_RETRIES = 3;

/** The first wait after a 429 in a live run: 2 s, then 4 s, then 8 s, never under a registry's own gap. */
export const RATE_LIMIT_BASE_MS = 2_000;

/** The first retry wait: the base, or the widest registry gap, so a retry never repeats the violation a queue spaces for. */
function firstRetryWaitMs(io: Io): number {
  return Math.max(io.retryBaseMs, io.arxivGapMs, io.githubSearchGapMs, io.cratesGapMs);
}

/** The longest one request can take: every attempt's timeout plus every wait between them. */
export function requestBudgetMs(io: Io, timeoutMs = io.timeoutMs): number {
  let waits = 0;
  for (let k = 0, wait = firstRetryWaitMs(io); k < RATE_LIMIT_RETRIES; k++, wait *= 2)
    waits += wait;
  return (RATE_LIMIT_RETRIES + 1) * timeoutMs + waits;
}

const USER_AGENT = "check-name.mts (project-naming skill; https://github.com/Vivswan/skills)";

/** A 429, carried as the rejection p-retry retries on; any other reply or error passes through. */
class RateLimited extends Error {
  constructor(readonly response: Response) {
    super("HTTP 429");
  }
}

/** One request, with a 429 waited out and asked again (p-retry: the wait doubling from
 * `retryBaseMs`, RATE_LIMIT_RETRIES times): a lane's batches hit every registry's per-client limit
 * at once, and a column left blank for a batch is a column the lane cannot read. The last 429 is
 * returned for the column to name. */
export async function get(
  io: Io,
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = io.timeoutMs,
): Promise<Response> {
  const once = async () => {
    const response = await io.fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers },
    });
    if (response.status === 429) throw new RateLimited(response);
    return response;
  };
  try {
    return await pRetry(once, {
      retries: RATE_LIMIT_RETRIES,
      factor: 2,
      minTimeout: firstRetryWaitMs(io),
      maxTimeout: Number.POSITIVE_INFINITY,
      randomize: false,
      shouldRetry: ({ error }) => error instanceof RateLimited,
      // A 429 body that is not going back to the caller is released before the wait, best effort:
      // a body that fails to cancel must not end the retries.
      onFailedAttempt: async ({ error, retriesLeft }) => {
        if (retriesLeft > 0 && error instanceof RateLimited) {
          await error.response.body?.cancel().catch(() => undefined);
        }
      },
    });
  } catch (error) {
    if (error instanceof RateLimited) return error.response;
    throw error;
  }
}

/** Whether the run claims a registry: `--registries` names the claimed ones, and a run without it
 * claims every registry. The page reads a typosquat hit on a claimed registry as a gate failure
 * and one on an unclaimed registry as a MINOR note, so the cell says which. */
export type Claimed = (registryId: string) => boolean;

export const free: Cell = { status: "free" };
export const freeNoting = (detail: string): Cell => ({ status: "free", detail });
export const taken = (detail: string): Cell => ({ status: "taken", detail });
export const unknown = (detail: string): Cell => ({ status: "unknown", detail });

export function renderCell(cell: Cell): string {
  if (cell.status === "free") return cell.detail === undefined ? "free" : `free(${cell.detail})`;
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
