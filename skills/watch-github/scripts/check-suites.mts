// The CI reads for one commit and the judgment over them. The check suites of a head come inside
// the per-repository read (pr-rows.mts) while its CI is pending; a head with more than one page
// of suites falls back to the paged read-and-confirm here. One more read, on a red verdict only,
// names the failed jobs and steps. Everything is GraphQL: the Actions REST endpoints are a
// secondary rate bucket that parallel watchers lock for longer than a run lasts.

import { GhError, get, graphql, requireNumber, requireString, stringOrNull } from "./gh.mts";

// Heavy retriggering stacks hundreds of suites on one SHA; a re-run between two page fetches can
// hide a re-queued suite from both, so a multi-page snapshot is judged only once two reads agree.
const MAX_SUITE_PAGES = 10;
const MAX_SNAPSHOT_ROUNDS = 5;
const TERMINAL_ROLLUPS = new Set(["SUCCESS", "FAILURE", "ERROR"]);
/** Polls a head may show no checks at all before a named gate is called missing; a run can register seconds after a push. */
export const NO_RUN_POLLS = 2;

// External apps (CodeQL, Semgrep) register check suites without a workflowRun; only github-actions
// suites carrying one are workflow runs.
export const SUITE_NODE_FIELDS =
  "id status conclusion app { slug } workflowRun { databaseId url updatedAt workflow { databaseId name } }";

/** The checkSuites connection as the per-repository read embeds it under a commit. */
export const SUITES_CONNECTION = `checkSuites(first: 100) { nodes { ${SUITE_NODE_FIELDS} } pageInfo { hasNextPage endCursor } }`;

const SUITES_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) { ... on Commit {
      checkSuites(first: 100, after: $cursor) {
        nodes { ${SUITE_NODE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }
    } }
  }
}`;

// The suite ids go inline as a list literal: gh's -f carries a string, not a GraphQL list.
const failedJobsQuery = (suiteIds: string[]): string => `query {
  nodes(ids: ${JSON.stringify(suiteIds)}) { ... on CheckSuite {
    id
    checkRuns(first: 50, filterBy: { conclusions: [FAILURE, TIMED_OUT, CANCELLED, ACTION_REQUIRED, STARTUP_FAILURE] }) {
      nodes { name steps(first: 50) { nodes { name conclusion } } }
    }
  } }
}`;

export type Run = {
  id: number;
  /** The check suite's node id, for the failed-jobs read. */
  suiteId: string;
  status: string;
  conclusion: string | null;
  workflowId: number | null;
  updatedAt: string;
  name: string;
  url: string;
};

/** One page of suites as read: the runs, and whether another page follows. */
export type Suites = { runs: Run[]; complete: boolean; nextCursor: string | null };

// --- discovery ---------------------------------------------------------------

/**
 * The runs in one checkSuites connection. Enum words are lowercased: GitHub returns SUCCESS, the
 * output lines say success. A run can lack a workflow id (ruleset or unnamed runs) and is judged
 * on its own. A null connection (an unknown SHA) is an empty, complete page.
 */
export function parseSuites(suites: unknown): Suites {
  if (suites === undefined || suites === null)
    return { runs: [], complete: true, nextCursor: null };
  const nodes = get(suites, "nodes");
  const runs: Run[] = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const workflowRun = get(node, "workflowRun");
    if (get(get(node, "app"), "slug") !== "github-actions" || !workflowRun) continue;
    const workflow = get(workflowRun, "workflow");
    const conclusion = get(node, "conclusion");
    const workflowId = get(workflow, "databaseId");
    runs.push({
      id: requireNumber(get(workflowRun, "databaseId"), "checkSuites workflowRun.databaseId"),
      suiteId: requireString(get(node, "id"), "checkSuites id"),
      status: requireString(get(node, "status"), "checkSuites status").toLowerCase(),
      conclusion: typeof conclusion === "string" ? conclusion.toLowerCase() : null,
      workflowId: typeof workflowId === "number" ? workflowId : null,
      updatedAt: String(get(workflowRun, "updatedAt")),
      name: String(get(workflow, "name")),
      url: String(get(workflowRun, "url")),
    });
  }
  const pageInfo = get(suites, "pageInfo");
  if (get(pageInfo, "hasNextPage") !== true) return { runs, complete: true, nextCursor: null };
  return {
    runs,
    complete: false,
    nextCursor: requireString(get(pageInfo, "endCursor"), "checkSuites pageInfo.endCursor"),
  };
}

type Snapshot = { runs: Run[]; pages: number };

// A failed gh call yields nothing, even after earlier pages were received: a partial snapshot
// judged as complete would leave the omitted runs unmeasured.
function readSnapshot(repo: string, oid: string): Snapshot {
  const [owner, name] = repo.split("/") as [string, string];
  const runs: Run[] = [];
  let cursor: string | null = null;
  for (let pages = 1; pages <= MAX_SUITE_PAGES; pages += 1) {
    const variables: Record<string, string> = { owner, name, oid };
    if (cursor !== null) variables.cursor = cursor;
    const body = graphql(SUITES_QUERY, variables);
    const page = parseSuites(
      get(get(get(get(body, "data"), "repository"), "object"), "checkSuites"),
    );
    runs.push(...page.runs);
    if (page.complete) return { runs, pages };
    cursor = page.nextCursor;
  }
  throw new GhError(
    `check suites for ${oid} span more than ${MAX_SUITE_PAGES} pages of 100; refusing to judge a partial snapshot`,
  );
}

/**
 * Every run on a commit, for a head whose first page was not the whole list. One page is one
 * atomic read of the run list with its states; a multi-page snapshot is not, so it is confirmed by
 * an identical second read. updatedAt is part of the comparison: status and conclusion alone
 * cannot see a re-run that completed again between two reads.
 */
export function discoverRuns(repo: string, oid: string): Run[] {
  let previous = "";
  for (let round = 1; round <= MAX_SNAPSHOT_ROUNDS; round += 1) {
    const snapshot = readSnapshot(repo, oid);
    const serialized = JSON.stringify(snapshot.runs);
    if (snapshot.pages === 1 || serialized === previous) return snapshot.runs;
    previous = serialized;
  }
  throw new GhError(
    `check suites for ${oid} kept changing across ${MAX_SNAPSHOT_ROUNDS} multi-page reads; refusing to judge a partial snapshot`,
  );
}

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
  | { kind: "missing"; gates: string[]; settled: boolean };

/**
 * Green is every named gate's latest run passed, or, with no gate named, the aggregate rollup
 * SUCCESS. Red is any named gate's latest run failed, or the rollup FAILURE or ERROR with no gate.
 * A named gate with no run is pending until the rollup settles, then missing; `waited` says the
 * head has had no checks at all for long enough (two polls) to call the gate missing without a
 * rollup, since a head nothing runs on never settles.
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

/** `workflow / job / step` for each failed job of each failed run, as the red line prints them. */
export type FailedJob = { workflow: string; job: string; step: string | null };

/**
 * The failed jobs and their first failed step, one request for every failed run of a verdict.
 * Informational: a read that fails names the workflows alone and changes no verdict.
 */
export function readFailedJobs(failed: Run[]): FailedJob[] {
  const body = graphql(failedJobsQuery(failed.map((run) => run.suiteId)));
  const jobs: FailedJob[] = [];
  const nodes = get(get(body, "data"), "nodes");
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const run = failed.find((candidate) => candidate.suiteId === get(node, "id"));
    if (run === undefined) continue;
    const checkRuns = get(get(node, "checkRuns"), "nodes");
    for (const checkRun of Array.isArray(checkRuns) ? checkRuns : []) {
      const steps = get(get(checkRun, "steps"), "nodes");
      const failedStep = (Array.isArray(steps) ? steps : []).find((step) =>
        ["FAILURE", "TIMED_OUT", "CANCELLED"].includes(String(get(step, "conclusion"))),
      );
      jobs.push({
        workflow: run.name,
        job: requireString(get(checkRun, "name"), "checkRuns name"),
        step: stringOrNull(get(failedStep, "name")),
      });
    }
  }
  return jobs;
}

// --- the verdict as an event -----------------------------------------------------

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export type CiState = "pending" | "green" | "red" | "missing";

/** A head's CI is still moving: pending or expected, not settled and not absent. */
export function rollupPending(rollup: string | null): boolean {
  return rollup !== null && !TERMINAL_ROLLUPS.has(rollup);
}

export type CiEvent = {
  kind: "ci" | "trouble";
  text: string;
  url: string;
  state: Exclude<CiState, "pending">;
};

/**
 * What a settled verdict says, as one string a target keeps to tell the same verdict from a new
 * one: the kind, and the gates it found absent. Null while pending.
 */
export function verdictKey(verdict: Verdict): string | null {
  switch (verdict.kind) {
    case "pending":
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
 * workflows alone, and the verdict stands. Null while pending.
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
