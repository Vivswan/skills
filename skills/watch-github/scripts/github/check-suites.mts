// The check suite reads for one commit, judged in ../targets/ci.mts. The suites of a head come
// inside the per-repository read (repository.mts) while its CI is pending; a head with more than one
// page falls back to the paged read-and-confirm here, and a red verdict reads its failed jobs once.
// All GraphQL: the Actions REST endpoints are a rate bucket parallel watchers lock for longer than a run lasts.

import { GhError, get, graphql, requireNumber, requireString, stringOrNull } from "./gh.mts";

// Heavy retriggering stacks hundreds of suites on one SHA; a re-run between two page fetches can
// hide a re-queued suite from both, so a multi-page snapshot is judged only once two reads agree.
const MAX_SUITE_PAGES = 10;
const MAX_SNAPSHOT_ROUNDS = 5;

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

// --- failed jobs -------------------------------------------------------------

/** `workflow / job / step` for each failed job of each failed run, as the red line prints them. */
export type FailedJob = { workflow: string; job: string; step: string | null };

/**
 * The failed jobs and their first failed step, one request for all the failed runs of a verdict;
 * the read is one page of 50 jobs per suite, never paged, so a run with more names its first 50.
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
