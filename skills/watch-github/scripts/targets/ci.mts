// The CI judgment over one head, shared by the PR and branch targets: the verdict kinds, the
// green, red, missing, and none rules over a rollup and the runs read for the head
// (../github/check-suites.mts), and the verdict as the event line a target delivers. Pure over read
// data, except the failed-jobs read a red makes once to name its jobs.

import { type FailedJob, type Run, readFailedJobs } from "../github/check-suites.mts";
import { GhError } from "../github/gh.mts";

const TERMINAL_ROLLUPS = new Set(["SUCCESS", "FAILURE", "ERROR"]);
/** Polls a head may show no checks at all (no rollup) before a named gate is called missing; a run can register seconds after a push. */
export const NO_RUN_POLLS = 2;

// --- judgment ----------------------------------------------------------------

/**
 * The unit of judgment is the workflow: re-triggers stack several runs of one workflow on one SHA,
 * and a concurrency group cancels all but the newest, so judging every run would report a green
 * pipeline as red. Grouped by workflow id, not name, since two workflow files can share a name.
 * Run ids are monotonic, so the highest id is the newest.
 */
export function selectLatest(runs: Run[]): Run[] {
  const sorted = [...runs].sort((a, b) => b.id - a.id);
  const seen = new Set<number>();
  const latest: Run[] = [];
  for (const run of sorted) {
    if (run.workflowId !== null) {
      if (seen.has(run.workflowId)) continue;
      seen.add(run.workflowId);
    }
    latest.push(run);
  }
  return latest;
}

/** A completed run that did not pass: cancelled with no newer run to supersede it counts, since no verdict was delivered. */
export function isFailed(run: Run): boolean {
  return (
    run.status === "completed" &&
    run.conclusion !== null &&
    run.conclusion !== "success" &&
    run.conclusion !== "skipped"
  );
}

export type Verdict =
  | { kind: "green"; latest: Run[] }
  /** `missing`: gates with no run although the rollup settled, named on the red line so the red does not hide them. */
  | { kind: "red"; latest: Run[]; failed: Run[]; missing: string[] }
  | { kind: "pending" }
  /** A named gate has no run once CI settled, or after two polls on a head with no checks at all: a typo in the name, or a workflow that does not trigger here. */
  | { kind: "missing"; gates: string[]; settled: boolean }
  /** No checks at all and no gate named: a head nothing runs on, with nothing to judge and nothing to say. */
  | { kind: "none" };

/**
 * Green is every named gate's latest run passed, or, with no gate named, the aggregate rollup
 * SUCCESS. Red is any named gate's latest run failed, or the rollup FAILURE or ERROR with no gate.
 * A named gate with no run is pending until the rollup settles, then missing; `waited` says the
 * head has had no checks at all for long enough (two polls) to call the gate missing without a
 * rollup, since a head nothing runs on never settles. With no gate, a head with no rollup has no
 * CI, whatever suites it lists (a run with no job yet makes none): read as pending it would hold
 * the busy interval and a suites read every poll for good.
 */
export function judgeHead(
  rollup: string | null,
  runs: Run[],
  gates: string[],
  waited = false,
): Verdict {
  const latest = selectLatest(runs);
  const settled = TERMINAL_ROLLUPS.has(rollup ?? "");
  if (gates.length === 0) {
    if (rollup === "SUCCESS") return { kind: "green", latest };
    if (settled) return { kind: "red", latest, failed: latest.filter(isFailed), missing: [] };
    if (rollup === null) return { kind: "none" };
    return { kind: "pending" };
  }
  // Two workflow files can share a name: every latest run under a gate's name is that gate's.
  const gateRuns = latest.filter((run) => gates.includes(run.name));
  const failed = gateRuns.filter(isFailed);
  const absent = gates.filter((gate) => !gateRuns.some((run) => run.name === gate));
  if (failed.length > 0) return { kind: "red", latest, failed, missing: settled ? absent : [] };
  if (absent.length > 0) {
    if (settled) return { kind: "missing", gates: absent, settled: true };
    return waited ? { kind: "missing", gates: absent, settled: false } : { kind: "pending" };
  }
  if (gateRuns.some((run) => run.status !== "completed" || run.conclusion === null)) {
    return { kind: "pending" };
  }
  return { kind: "green", latest };
}

// --- the verdict as an event -----------------------------------------------------

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export type CiState = Verdict["kind"];

/** A head's CI is still moving: pending or expected, not settled and not absent. */
export function rollupPending(rollup: string | null): boolean {
  return rollup !== null && !TERMINAL_ROLLUPS.has(rollup);
}

export type CiEvent = {
  kind: "ci" | "trouble";
  text: string;
  url: string;
  state: Exclude<CiState, "pending" | "none">;
};

/**
 * What a settled verdict says, as one string a target keeps to tell the same verdict from a new
 * one: the kind, and the gates it found absent. Null while pending, and for a head with no CI.
 */
export function verdictKey(verdict: Verdict): string | null {
  switch (verdict.kind) {
    case "pending":
    case "none":
      return null;
    case "green":
      return "green";
    case "red":
      return verdict.missing.length > 0 ? `red; no run of ${verdict.missing.join(", ")}` : "red";
    case "missing":
      return `missing ${verdict.gates.join(", ")}`;
  }
}

/**
 * The verdict as the event line says it, for a head labelled `label`. A red names each failed
 * job's workflow, job, and first failed step from one more read; when that read fails, the
 * workflows alone, and the verdict stands. Null while pending, and for a head with no CI.
 */
export function describeVerdict(
  label: string,
  sha: string,
  verdict: Verdict,
  checksUrl: string,
  log: (line: string) => void,
): CiEvent | null {
  const short = sha.slice(0, 12);
  switch (verdict.kind) {
    case "pending":
    case "none":
      return null;
    case "green":
      return {
        kind: "ci",
        state: "green",
        text: `${label}: CI green on ${short}: ${plural(verdict.latest.length, "workflow")}`,
        url: checksUrl,
      };
    case "missing":
      return {
        kind: "trouble",
        state: "missing",
        text: verdict.settled
          ? `${label}: CI settled on ${short} with no run of ${verdict.gates.join(", ")}; check the workflow name`
          : `${label}: no checks on ${short} after ${NO_RUN_POLLS} polls, so no run of ${verdict.gates.join(", ")}; check the workflow name`,
        url: checksUrl,
      };
    case "red": {
      let jobs: FailedJob[] = [];
      if (verdict.failed.length > 0) {
        try {
          jobs = readFailedJobs(verdict.failed);
        } catch (error) {
          if (!(error instanceof GhError)) throw error;
          log(`failed jobs of ${short}: ${error.message}`);
        }
      }
      const parts =
        jobs.length > 0
          ? jobs.map(
              (job) => `${job.workflow} / ${job.job}${job.step === null ? "" : ` / ${job.step}`}`,
            )
          : verdict.failed.map((run) => run.name);
      const missing = verdict.missing.length > 0 ? `; no run of ${verdict.missing.join(", ")}` : "";
      return {
        kind: "ci",
        state: "red",
        text: `${label}: CI red on ${short}: ${parts.length > 0 ? parts.join(", ") : "a check outside Actions"}${missing}`,
        url: verdict.failed[0]?.url ?? checksUrl,
      };
    }
  }
}
