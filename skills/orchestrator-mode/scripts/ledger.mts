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
 */

import { createHash } from "node:crypto";
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
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
  return join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now().toString(36)}.tmp`);
}

/**
 * Atomic write: temp file in the same directory, then rename. Concurrent
 * writers race last-writer-wins, but a reader never sees a torn file.
 */
function saveLedger(file: string, ledger: Ledger): void {
  const temp = tempPath(file);
  writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(temp, file);
}

/**
 * Atomic create-if-absent for init: link(2) fails with EEXIST instead of
 * clobbering, closing the check-then-write race a plain existence test has.
 * Returns false when the ledger already existed.
 */
function createLedgerExclusive(file: string, ledger: Ledger): boolean {
  const temp = tempPath(file);
  writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`);
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw error;
  } finally {
    unlinkSync(temp);
  }
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
