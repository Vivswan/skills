// One fetch per URL per process, and per day on disk when the Io names a cache directory, once
// across the processes that share it: the popular-name lists and the Homebrew indexes are the
// same for every name in a batch, so a batch of lanes does not pull the same list twenty times.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Io } from "./cells.mts";

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

const { get, requestBudgetMs } = await import("./cells.mts");

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type Loaded<T> = { value: T } | { error: string };

export type CacheSource<T> = {
  /** Fetched once per process and per day on disk: the URL is the cache key. */
  url: string;

  /** The reply's body to the value kept; throws on a body that is not what it should be. */
  extract: (text: string) => T;

  /** The value back from its JSON on disk, or null for a file an older layout wrote. */
  revive: (stored: unknown) => T | null;

  /** The request's bound, where the body is too large for the Io's one-name bound. */
  timeoutMs?: number;

  /** The queue the request goes through, body included, for a host that wants its requests one at a time; a value read from disk goes through nothing. */
  through?: <T>(work: () => Promise<T>) => Promise<T>;
};

const inFlight = new WeakMap<Io, Map<string, Promise<Loaded<unknown>>>>();

/** Only a reply `extract` could read is cached, so a malformed reply is asked for again next run. */
export function cached<T>(io: Io, source: CacheSource<T>): Promise<Loaded<T>> {
  let memo = inFlight.get(io);
  if (!memo) {
    memo = new Map();
    inFlight.set(io, memo);
  }
  let pending = memo.get(source.url);
  if (!pending) {
    pending = load(io, source);
    memo.set(source.url, pending);
  }
  return pending as Promise<Loaded<T>>;
}

async function load<T>(io: Io, source: CacheSource<T>): Promise<Loaded<T>> {
  const dir = io.cacheDir;
  const fromDisk = dir ? readCache(dir, source) : null;
  if (fromDisk !== null) return { value: fromDisk };
  const timeoutMs = source.timeoutMs ?? io.timeoutMs;
  const fetchAndKeep = async (): Promise<Loaded<T>> => {
    let text: string;
    try {
      const response = await get(io, source.url, {}, timeoutMs);
      if (response.status !== 200) {
        // Released, not left open: the queue behind this request waits for the body too. The
        // status is the error whether or not the release succeeds.
        await response.body?.cancel().catch(() => undefined);
        return { error: `HTTP ${response.status}` };
      }
      text = await response.text();
    } catch (error) {
      return { error: String(error) };
    }
    let value: T;
    try {
      value = source.extract(text);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return { error: `reply malformed: ${why}` };
    }
    if (dir) writeCache(dir, source.url, JSON.stringify(value));
    return { value };
  };
  // The holder's request ends by its budget (every attempt and the waits between), so a lock
  // still held past twice that is a holder stalled outside one (suspended, or a pid another
  // process wears since).
  const work = dir
    ? () => underLock(dir, source, 2 * requestBudgetMs(io, timeoutMs), fetchAndKeep)
    : fetchAndKeep;
  return source.through ? source.through(work) : work();
}

const LOCK_POLL_MS = 100;
const held = new Set<string>();

// The lock files this process holds are released at exit as well as in place: a process that ends
// past its finally (an unhandled rejection, process.exit) would otherwise leave them for the next
// waiter's dead-pid rule.
process.on("exit", () => {
  for (const path of held) {
    try {
      unlinkSync(path);
    } catch {
      // Released already.
    }
  }
});

/** The holder is alive unless the file names a pid no process has. A file still empty (its
 * creator between open and write), one that cannot be read, and a pid we may not signal all
 * read as alive: only a lock a dead holder left is ever broken. */
function holderAlive(path: string): boolean {
  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return true;
  }
  if (!/^[1-9][0-9]*\n$/.test(content)) return true;
  try {
    process.kill(Number(content), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

type Claim = "held" | "busy" | "unavailable";

/** Creates `path` with our pid in it; a file a dead holder left is removed and the create tried
 * once more. "busy" is a live holder; "unavailable" a place that takes no file. The break is
 * best effort: two waiters that read the same dead pid at once may both unlink and both create,
 * which costs one duplicate request, since the cache write lands whole either way. */
function claim(path: string): Claim {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx" });
      held.add(path);
      return "held";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "unavailable";
    }
    if (holderAlive(path)) return "busy";
    try {
      unlinkSync(path);
    } catch {
      // Another waiter broke it first; the create above answers for it.
    }
  }
  return "busy";
}

function release(path: string): void {
  held.delete(path);
  try {
    unlinkSync(path);
  } catch {
    // Gone already.
  }
}

/** One process on the machine fetches a URL while the others wait for its write: the lanes run as
 * separate processes, and without this a cold cache was the ranking's twenty pages fetched by
 * every lane at once. The lock saves requests and guards nothing, since the write lands whole
 * either way, so a place that takes no lock, and a holder alive past `waitMs`, both mean
 * fetching for ourselves. */
async function underLock<T>(
  dir: string,
  source: CacheSource<T>,
  waitMs: number,
  fetchAndKeep: () => Promise<Loaded<T>>,
): Promise<Loaded<T>> {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // The claim below reads the same failure as "unavailable".
  }
  const lock = `${cachePath(dir, source.url)}.lock`;
  const deadline = Date.now() + waitMs;
  let claimed = claim(lock);
  while (claimed === "busy") {
    const fromDisk = readCache(dir, source);
    if (fromDisk !== null) return { value: fromDisk };
    if (Date.now() >= deadline) break;
    await Bun.sleep(LOCK_POLL_MS);
    claimed = claim(lock);
  }
  try {
    // The holder we waited for may have written between our last read and our claim.
    const fromDisk = readCache(dir, source);
    if (fromDisk !== null) return { value: fromDisk };
    return await fetchAndKeep();
  } finally {
    if (claimed === "held") release(lock);
  }
}

export function stringList(stored: unknown): string[] | null {
  if (!Array.isArray(stored) || !stored.every((item) => typeof item === "string")) return null;
  return stored;
}

export function stringMap(stored: unknown): Record<string, string> | null {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return null;
  if (!Object.values(stored).every((item) => typeof item === "string")) return null;
  return stored as Record<string, string>;
}

function cachePath(dir: string, url: string): string {
  return join(dir, `${createHash("sha256").update(url).digest("hex")}.json`);
}

/** The cache only saves a fetch, so any failure of it (an unreadable directory, a full disk, an
 * entry an older layout wrote) is a miss or a skipped write, never a cell. */
function readCache<T>(dir: string, source: CacheSource<T>): T | null {
  try {
    const path = cachePath(dir, source.url);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (!stat || Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    return source.revive(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return null;
  }
}

/** The file lands whole (written beside, then renamed), and entries past the day leave with it,
 * so the directory never holds more than a day of lookups. */
function writeCache(dir: string, url: string, text: string): void {
  const path = cachePath(dir, url);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${path}.part`, text);
    renameSync(`${path}.part`, path);
  } catch {
    // The value was fetched; the next run fetches it again.
    return;
  }
  try {
    for (const entry of readdirSync(dir)) {
      const stat = statSync(join(dir, entry), { throwIfNoEntry: false });
      if (stat?.isFile() && Date.now() - stat.mtimeMs > CACHE_TTL_MS) {
        unlinkSync(join(dir, entry));
      }
    }
  } catch {
    // A stale entry left behind goes with the next write.
  }
}
