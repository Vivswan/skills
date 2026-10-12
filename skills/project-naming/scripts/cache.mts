// One fetch per URL per process, and per day on disk when the Io names a cache directory: the
// popular-name lists and the Homebrew indexes are the same for every name in a batch, so a batch
// of lanes does not pull the same list twenty times.

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { get, type Io } from "./cells.mts";

export const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export type Loaded<T> = { value: T } | { error: string };

export type CacheSource<T> = {
  url: string;
  /** The reply's body to the value kept; throws on a body that is not what it should be. */
  extract: (text: string) => T;
  /** The value back from its JSON on disk, or null for a file an older layout wrote. */
  revive: (stored: unknown) => T | null;
  /** The request's bound, where the body is too large for the Io's one-name bound. */
  timeoutMs?: number;
  /** The queue the request goes through, body included, for a host that wants its requests one
   * at a time; a value read from disk goes through nothing. */
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
  const fromDisk = io.cacheDir ? readCache(io.cacheDir, source) : null;
  if (fromDisk !== null) return { value: fromDisk };
  let text: string;
  try {
    const request = async (): Promise<{ text: string } | { status: number }> => {
      const response = await get(io, source.url, {}, source.timeoutMs ?? io.timeoutMs);
      if (response.status === 200) return { text: await response.text() };
      // Released, not left open: the queue behind this request waits for the body too. The status
      // is the error whether or not the release succeeds.
      await response.body?.cancel().catch(() => undefined);
      return { status: response.status };
    };
    const reply = await (source.through ? source.through(request) : request());
    if ("status" in reply) return { error: `HTTP ${reply.status}` };
    text = reply.text;
  } catch (error) {
    return { error: String(error) };
  }
  let value: T;
  try {
    value = source.extract(text);
  } catch (error) {
    return { error: `reply unreadable: ${String(error)}` };
  }
  if (io.cacheDir) writeCache(io.cacheDir, source.url, JSON.stringify(value));
  return { value };
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
