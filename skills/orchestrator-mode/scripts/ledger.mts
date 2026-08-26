#!/usr/bin/env bun
/**
 * Session ledger for orchestrator-mode: persists per-worker standing state,
 * territory grants, and flags in a JSON file so orchestration state survives
 * agent context loss. A duplicate standing flag is refused by construction,
 * dormancy is a lookup, and retraction is a recorded transition.
 *
 * Run with bun. Zero npm dependencies; node builtins only.
 *
 * Usage: ledger.mts <file> <command> [args...]
 * Every command prints a JSON result to stdout.
 * Exit codes: 0 ok, 1 refused / not found / corrupt ledger, 2 usage.
 *
 * Concurrency contract: mutating commands (state, flag, retract, grant) hold
 * an exclusive lockfile (<file>.lock, atomic create-if-absent) across their
 * whole load/check/save, so under concurrent writers every exit-0 mutation is
 * durable and duplicate flags are refused globally - never silently lost to a
 * racing writer. Acquisition retries briefly; a lock is broken only when it is
 * BOTH older than LEDGER_LOCK_STALE_MS (default 10s) AND its recorded holder
 * pid is dead - a live holder is never stolen, however stalled. After
 * LEDGER_LOCK_TIMEOUT_MS (default 5s) the command fails loudly with
 * exit 1 rather than ever proceeding unlocked. Saves stay temp+rename atomic,
 * so readers never see a torn file; init is itself an atomic
 * create-if-absent, and show reads without the lock.
 */

import { createHash, randomBytes } from "node:crypto";
import { linkSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const WORKER_STATES = ["active", "dormant-by-design", "landing-gate", "landed-swept"] as const;
type WorkerState = (typeof WORKER_STATES)[number];

interface Grant {
  wording: string;
  globs: string[];
  at: string;
}

interface WorkerEntry {
  state: WorkerState | null;
  grants: Grant[];
}

interface FlagEntry {
  hash: string;
  worker: string;
  text: string;
  status: "standing" | "retracted";
  at: string;
  retractedAt?: string;
}

interface Ledger {
  workers: Record<string, WorkerEntry>;
  flags: FlagEntry[];
}

const USAGE = `usage: ledger <file> <command> [args...]
commands:
  init                                create an empty ledger (never clobbers an existing one)
  state <worker> <state>              set standing state; states: ${WORKER_STATES.join(", ")}
  flag <worker> <text>                record a standing flag (an identical standing flag is refused)
  retract <flag-hash-prefix>          mark a flag retracted (unique prefix match)
  grant <worker> <wording> <glob...>  record a territory grant with its exact wording
  show [worker]                       print the whole ledger, or one worker
`;

function emit(exitCode: number, result: unknown): never {
  console.log(JSON.stringify(result, null, 2));
  process.exit(exitCode);
}

function usageError(message: string): never {
  process.stderr.write(`ledger: ${message}\n${USAGE}`);
  console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  process.exit(2);
}

/** Corrupt-ledger and not-found errors: stderr line plus JSON on stdout, exit 1. */
function loudError(message: string): never {
  console.error(`ledger: ${message}`);
  emit(1, { ok: false, error: message });
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isGrant(value: unknown): value is Grant {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const grant = value as Record<string, unknown>;
  return (
    isString(grant.wording) &&
    Array.isArray(grant.globs) &&
    grant.globs.length > 0 &&
    grant.globs.every((glob) => isString(glob) && glob.trim() !== "") &&
    isString(grant.at)
  );
}

function isWorkerEntry(value: unknown): value is WorkerEntry {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    (entry.state === null || (WORKER_STATES as readonly unknown[]).includes(entry.state)) &&
    Array.isArray(entry.grants) &&
    entry.grants.every(isGrant)
  );
}

function isFlagEntry(value: unknown): value is FlagEntry {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const flag = value as Record<string, unknown>;
  return (
    isString(flag.hash) &&
    isString(flag.worker) &&
    isString(flag.text) &&
    (flag.status === "standing" || flag.status === "retracted") &&
    isString(flag.at) &&
    (flag.retractedAt === undefined || isString(flag.retractedAt))
  );
}

function isLedgerShape(value: unknown): value is Ledger {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as { workers?: unknown; flags?: unknown };
  return (
    candidate.workers !== null &&
    typeof candidate.workers === "object" &&
    !Array.isArray(candidate.workers) &&
    Object.values(candidate.workers).every(isWorkerEntry) &&
    Array.isArray(candidate.flags) &&
    candidate.flags.every(isFlagEntry)
  );
}

function loadLedger(file: string): Ledger {
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      loudError(`ledger file not found: ${file} (run "ledger ${file} init" first)`);
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    loudError(
      `ledger file is not valid JSON, refusing to treat it as empty: ${file} (${String(error)})`,
    );
  }
  if (!isLedgerShape(parsed)) {
    loudError(
      `ledger file is malformed (expected {"workers": {}, "flags": []}), refusing to treat it as empty: ${file}`,
    );
  }
  // A null-prototype workers map keeps names like "__proto__" or "constructor"
  // as plain data instead of colliding with Object.prototype.
  parsed.workers = Object.assign(Object.create(null), parsed.workers);
  // Integrity beyond field types: a hand-edited hash or a duplicated entry
  // would silently break duplicate refusal and prefix retraction.
  const seen = new Set<string>();
  for (const flag of parsed.flags) {
    if (flag.hash !== flagHash(flag.worker, flag.text)) {
      loudError(`ledger file is malformed (flag hash does not match its worker+text): ${file}`);
    }
    if (seen.has(flag.hash)) {
      loudError(`ledger file is malformed (duplicate flag hash ${flag.hash}): ${file}`);
    }
    seen.add(flag.hash);
  }
  return parsed;
}

function tempPath(file: string): string {
  return join(
    dirname(file),
    `.${basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
}

/**
 * Create and fill a temp file exclusively. wx (O_CREAT|O_EXCL) refuses to
 * open through anything already at the path - including a symlink planted by
 * another writer in a co-writable directory - and the random suffix makes
 * pre-creating the path impractical in the first place. EEXIST retries with
 * a fresh name; any other failure cleans up and stays loud.
 */
function writeTempExclusive(file: string, data: string): string {
  for (;;) {
    const temp = tempPath(file);
    try {
      writeFileSync(temp, data, { flag: "wx" });
      return temp;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      try {
        unlinkSync(temp);
      } catch {
        // The open itself failed; nothing was created.
      }
      throw error;
    }
  }
}

/**
 * Atomic write: exclusive temp file in the same directory, then rename, so a
 * reader never sees a torn file. Callers mutating an existing ledger must
 * hold the ledger lock; rename alone does not prevent lost updates.
 */
function saveLedger(file: string, ledger: Ledger): void {
  if (heldLock !== null) {
    assertLockStillHeld();
  }
  const temp = writeTempExclusive(file, `${JSON.stringify(ledger, null, 2)}\n`);
  try {
    renameSync(temp, file);
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // ENOENT after a successful rename: nothing to clean.
    }
  }
}

/**
 * Atomic create-if-absent for init: link(2) fails with EEXIST instead of
 * clobbering, closing the check-then-write race a plain existence test has.
 * Returns false when the ledger already existed.
 */
function createLedgerExclusive(file: string, ledger: Ledger): boolean {
  const temp = writeTempExclusive(file, `${JSON.stringify(ledger, null, 2)}\n`);
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // Temp cleanup is best-effort; it must never mask a successful link.
    }
  }
}

const LOCK_RETRY_MS = 25;

// Env knobs exist for tests and unusual deployments. Invalid values fail
// loudly: NaN/Infinity would make the deadline comparison permanently false
// (a waiter would hang forever), and zero/negative staleness would classify
// live locks as stale.
function lockMsFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    loudError(`${name} must be a positive integer (milliseconds), got "${raw}"`);
  }
  return value;
}

let heldLock: string | null = null;
let heldLockIno: bigint | null = null;
let heldBreakMutex: string | null = null;

// emit() leaves via process.exit, which skips finally blocks, so the lock is
// released in an exit handler that runs on every exit path (lock first, then
// gate). The inode check keeps a displaced holder from unlinking a
// successor's lock.
process.on("exit", () => {
  if (heldLock !== null && heldLockIno !== null) {
    try {
      if (statSync(heldLock, { bigint: true }).ino === heldLockIno) {
        unlinkSync(heldLock);
      }
    } catch {
      // Already gone; nothing to release.
    }
  }
  if (heldBreakMutex !== null) {
    try {
      unlinkSync(heldBreakMutex);
    } catch {
      // Best-effort; an orphaned gate only pauses acquisition, loudly.
    }
  }
});
// SIGINT/SIGTERM do not run exit handlers by default; route them through
// process.exit so an interrupted CLI still releases its lock. SIGKILL leaves
// the lock for the stale rule.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => process.exit(1));
}

// Synchronous sleep without child processes: Atomics.wait always times out
// on a value that never changes.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * A lock may be broken only when BOTH hold: it is older than staleMs AND the
 * pid recorded inside it is not a running process. Age alone is unsound - a
 * live holder can stall past any threshold (suspension, scheduling, slow
 * storage) and must never be stolen. EPERM (a process we cannot signal),
 * unreadable content, and anything but a canonical "<digits>\n" record are
 * treated as alive: never break a lock not attributable to a dead holder.
 */
function lockHolderAlive(lockPath: string): boolean {
  let content: string;
  try {
    content = readFileSync(lockPath, "utf-8");
  } catch {
    return true;
  }
  if (!/^[1-9][0-9]*\n$/.test(content)) {
    return true;
  }
  const pid = Number(content.trimEnd());
  if (!Number.isSafeInteger(pid)) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * One gated attempt to take the ledger lock. EVERY create, inspection, or
 * break of the lock happens only while holding the O_EXCL gate
 * (<lock>.break), which is what makes check-then-unlink sound: between the
 * staleness/liveness verdict and the unlink nothing can replace the lock
 * path, because creating it requires the gate we hold and the only ungated
 * transition is a holder releasing its own lock - a removal that can only
 * turn the unlink into a no-op (ENOENT), never hand it a successor's lock.
 * If a process is SIGKILLed inside this microsecond window, the orphaned
 * gate pauses all acquisition and later writers fail loudly at timeout -
 * never a steal.
 */
function tryAcquireUnderGate(lockPath: string, gatePath: string, staleMs: number): boolean {
  try {
    writeFileSync(gatePath, `${process.pid}\n`, { flag: "wx" });
    heldBreakMutex = gatePath;
  } catch {
    return false; // Gate busy (or orphaned): retry until the loud timeout.
  }
  try {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
      heldLockIno = statSync(lockPath, { bigint: true }).ino;
      heldLock = lockPath;
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
    try {
      const observed = statSync(lockPath, { bigint: true });
      if (Date.now() - Number(observed.mtimeMs) > staleMs && !lockHolderAlive(lockPath)) {
        unlinkSync(lockPath);
      }
    } catch {
      // The holder released mid-check; the next gated attempt will create.
    }
    return false;
  } finally {
    unlinkSync(gatePath);
    heldBreakMutex = null;
  }
}

/**
 * Exclusive lock around a whole load/check/save, so concurrent writers cannot
 * lose each other's exit-0 mutations or double-accept a duplicate flag.
 * Timeout is a loud exit-1 error - a mutation never proceeds unlocked.
 */
function acquireLedgerLock(file: string): void {
  const lockPath = `${file}.lock`;
  const gatePath = `${lockPath}.break`;
  const timeoutMs = lockMsFromEnv("LEDGER_LOCK_TIMEOUT_MS", 5000);
  const staleMs = lockMsFromEnv("LEDGER_LOCK_STALE_MS", 10000);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (tryAcquireUnderGate(lockPath, gatePath, staleMs)) {
      return;
    }
    if (Date.now() >= deadline) {
      loudError(
        `could not acquire ledger lock within ${timeoutMs}ms: ${lockPath} (a lock is broken automatically only when older than ${staleMs}ms AND its recorded holder pid is dead; if this persists, also check for an orphaned ${gatePath})`,
      );
    }
    sleepSync(LOCK_RETRY_MS);
  }
}

/**
 * Last line of defense: if this process's lock was somehow displaced, refuse
 * to write rather than silently losing a racing writer's update.
 */
function assertLockStillHeld(): void {
  try {
    if (
      heldLock !== null &&
      heldLockIno !== null &&
      statSync(heldLock, { bigint: true }).ino === heldLockIno
    ) {
      return;
    }
  } catch {
    // Fall through to the loud error.
  }
  loudError(`ledger lock was broken by another process; aborting without writing: ${heldLock}`);
}

// JSON-array encoding is injective, so ("a\nb", "c") and ("a", "b\nc") get
// distinct hashes; plain concatenation would collide.
function flagHash(worker: string, text: string): string {
  return createHash("sha256")
    .update(JSON.stringify([worker, text]))
    .digest("hex");
}

function workerEntry(ledger: Ledger, worker: string): WorkerEntry {
  const entry = ledger.workers[worker] ?? { state: null, grants: [] };
  ledger.workers[worker] = entry;
  return entry;
}

const [, , file, command, ...rest] = process.argv;
if (!file || !command) {
  usageError("missing <file> or <command>");
}

// biome's noFallthroughSwitchClause does not track never-returning calls, so
// every case exits via an explicit return.
function main(file: string, command: string, rest: string[]): never {
  switch (command) {
    case "init": {
      if (rest.length !== 0) {
        usageError("init takes no arguments");
      }
      if (createLedgerExclusive(file, { workers: {}, flags: [] })) {
        return emit(0, { ok: true, created: true, file });
      }
      loadLedger(file);
      return emit(0, { ok: true, created: false, file });
    }
    case "state": {
      const [worker, state] = rest;
      if (rest.length !== 2 || !worker || !state) {
        usageError("state requires <worker> <state>");
      }
      if (!(WORKER_STATES as readonly string[]).includes(state)) {
        usageError(`invalid state "${state}"; expected one of: ${WORKER_STATES.join(", ")}`);
      }
      acquireLedgerLock(file);
      const ledger = loadLedger(file);
      const entry = workerEntry(ledger, worker);
      const previous = entry.state;
      entry.state = state as WorkerState;
      saveLedger(file, ledger);
      return emit(0, { ok: true, worker, previous, state });
    }
    case "flag": {
      const [worker, text] = rest;
      if (rest.length !== 2 || !worker || !text) {
        usageError("flag requires <worker> <text>");
      }
      const hash = flagHash(worker, text);
      acquireLedgerLock(file);
      const ledger = loadLedger(file);
      const existing = ledger.flags.find((flag) => flag.hash === hash);
      if (existing?.status === "standing") {
        return emit(1, { ok: false, refused: "duplicate", hash, worker, text });
      }
      const at = new Date().toISOString();
      if (existing) {
        existing.status = "standing";
        existing.at = at;
        delete existing.retractedAt;
      } else {
        ledger.flags.push({ hash, worker, text, status: "standing", at });
      }
      saveLedger(file, ledger);
      return emit(0, { ok: true, hash, worker, text, at });
    }
    case "retract": {
      const [prefix] = rest;
      if (rest.length !== 1 || !prefix) {
        usageError("retract requires <flag-hash-prefix>");
      }
      acquireLedgerLock(file);
      const ledger = loadLedger(file);
      const matches = ledger.flags.filter((flag) => flag.hash.startsWith(prefix));
      if (matches.length === 0) {
        return emit(1, { ok: false, error: `no flag matches hash prefix "${prefix}"` });
      }
      if (matches.length > 1) {
        return emit(1, {
          ok: false,
          error: `hash prefix "${prefix}" is ambiguous`,
          matches: matches.map((flag) => flag.hash),
        });
      }
      const flag = matches[0];
      if (!flag) {
        throw new Error("unreachable: single match vanished");
      }
      if (flag.status === "retracted") {
        return emit(1, { ok: false, refused: "already-retracted", hash: flag.hash });
      }
      flag.status = "retracted";
      flag.retractedAt = new Date().toISOString();
      saveLedger(file, ledger);
      return emit(0, {
        ok: true,
        hash: flag.hash,
        status: "retracted",
        retractedAt: flag.retractedAt,
      });
    }
    case "grant": {
      const [worker, wording, ...globs] = rest;
      if (!worker || !wording || globs.length === 0 || globs.some((glob) => glob.trim() === "")) {
        usageError("grant requires <worker> <wording> and one or more non-empty <glob...>");
      }
      acquireLedgerLock(file);
      const ledger = loadLedger(file);
      const entry = workerEntry(ledger, worker);
      const at = new Date().toISOString();
      entry.grants.push({ wording, globs, at });
      saveLedger(file, ledger);
      return emit(0, { ok: true, worker, wording, globs, at });
    }
    case "show": {
      if (rest.length > 1) {
        usageError("show takes at most one <worker>");
      }
      const ledger = loadLedger(file);
      const [worker] = rest;
      if (worker === undefined) {
        return emit(0, ledger);
      }
      const entry = ledger.workers[worker];
      const flags = ledger.flags.filter((flag) => flag.worker === worker);
      if (!entry && flags.length === 0) {
        return emit(1, { ok: false, error: `unknown worker "${worker}"` });
      }
      return emit(0, {
        worker,
        state: entry?.state ?? null,
        grants: entry?.grants ?? [],
        flags,
      });
    }
    default:
      usageError(`unknown command "${command}"`);
  }
}

try {
  main(file, command, rest);
} catch (error) {
  // Unexpected filesystem or runtime failures still honor the JSON-on-stdout
  // contract instead of escaping as a bare stack trace.
  loudError(`unexpected failure: ${String(error)}`);
}
