// The ACP builders: the state file acp-runner.mts rewrites for each builder it runs, read from the
// session-events runtime directory for what the builder's turn stands at. The daemon judges the
// reading beside its agent and worktree rows; this module only lists and parses.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { record } from "./transcripts.mts";

/** `<name>.acp-runner.state.json`, the runner's name in front. */
export const STATE_SUFFIX = ".acp-runner.state.json";

const PHASES = new Set(["starting", "idle", "busy", "permission", "ended"]);

export type RunnerPhase = "starting" | "idle" | "busy" | "permission" | "ended";

export function isRunnerPhase(value: unknown): value is RunnerPhase {
  return typeof value === "string" && PHASES.has(value);
}

/** The facts of one state file the judgment reads; the runner writes more, which the lead reads with `status`. */
export interface RunnerState {
  name: string;
  /** The writer's identity: a runner restarted under the same name is a new builder, with no continuity from the old. */
  instance: string;
  phase: RunnerPhase;
  lastUpdateAt: string | null;
  lastStop: string | null;
  endedAt: string | null;
  reason: string | null;
}

export type RunnerRead =
  | { ok: true; name: string; file: string; state: RunnerState }
  | { ok: false; name: string; file: string; reason: string };

/** A field the runner writes as a string or null; anything else, undefined included, is a shape it never wrote. */
function nullableString(value: unknown): { ok: true; value: string | null } | { ok: false } {
  if (value === null || typeof value === "string") return { ok: true, value };
  return { ok: false };
}

/** A state file's content as the judgment needs it; null for a shape the runner never wrote, so the saved row stands. */
export function parseRunnerState(raw: unknown): RunnerState | null {
  const saved = record(raw);
  if (saved === null || typeof saved.name !== "string" || !isRunnerPhase(saved.phase)) return null;
  if (typeof saved.pid !== "number" || typeof saved.startedAt !== "string") return null;
  const lastUpdateAt = nullableString(saved.lastUpdateAt);
  const lastStop = nullableString(saved.lastStop);
  const endedAt = nullableString(saved.endedAt);
  const reason = nullableString(saved.reason);
  if (!lastUpdateAt.ok || !lastStop.ok || !endedAt.ok || !reason.ok) return null;
  return {
    name: saved.name,
    instance: `${saved.pid}:${saved.startedAt}`,
    phase: saved.phase,
    lastUpdateAt: lastUpdateAt.value,
    lastStop: lastStop.value,
    endedAt: endedAt.value,
    reason: reason.value,
  };
}

/** Every runner state file in `dir`, each parsed or named with why it could not be; a directory not there yet is no runners. */
export function readRunnerStates(dir: string): RunnerRead[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const reads: RunnerRead[] = [];
  for (const entry of names.filter((candidate) => candidate.endsWith(STATE_SUFFIX)).sort()) {
    const name = entry.slice(0, -STATE_SUFFIX.length);
    const file = join(dir, entry);
    try {
      const state = parseRunnerState(JSON.parse(readFileSync(file, "utf8")));
      if (state === null) reads.push({ ok: false, name, file, reason: "not a runner state" });
      else reads.push({ ok: true, name, file, state });
    } catch (error) {
      reads.push({ ok: false, name, file, reason: (error as Error).message });
    }
  }
  return reads;
}
