// The workflows that ran on a repository's recent heads, read once when `watch` names a gate
// (../github-events.mts). The names come through parseSuites, so a gate is compared in the
// spelling the CI judgment matches by.

import { parseSuites, SUITES_CONNECTION } from "./check-suites.mts";
import { get, graphql } from "./gh.mts";

/** How many heads back each read looks; a workflow that gates every head ran on one of them. */
export const RECENT_HEADS = 10;

// A pull request's head commit, with the suites on it.
const HEAD_COMMIT = `commits(last: 1) { nodes { commit { ${SUITES_CONNECTION} } } }`;

// The watched pull request's own head, then the heads of the repository's most recently updated ones.
const PR_HEADS_QUERY = `query RecentPrHeads($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${HEAD_COMMIT} }
    pullRequests(first: ${RECENT_HEADS}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { ${HEAD_COMMIT} }
    }
  }
}`;

// A branch's newest commits, each a head the branch once had.
const BRANCH_HEADS_QUERY = `query RecentBranchHeads($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) { target { ... on Commit {
      history(first: ${RECENT_HEADS}) { nodes { ${SUITES_CONNECTION} } }
    } } }
  }
}`;

function nodesOf(connection: unknown): unknown[] {
  const nodes = get(connection, "nodes");

  return Array.isArray(nodes) ? nodes : [];
}

// Every run parseSuites returns counts, under the name the CI judgment matches a gate by.
function workflowNames(heads: unknown[]): string[] | null {
  const pages = heads.map((head) => parseSuites(get(head, "checkSuites")));

  // A head with more suites than one page gives a cut list, which cannot say a workflow never ran.
  if (pages.some((page) => !page.complete)) return null;

  const names = new Set(pages.flatMap((page) => page.runs.map((run) => run.name)));

  return [...names].sort();
}

function headCommit(pr: unknown): unknown {
  return get(nodesOf(get(pr, "commits"))[0], "commit");
}

/**
 * The workflows that ran on a pull request's own head or on the heads of the repository's most
 * recently updated pull requests. Its own head counts, since an older pull request is not among those.
 *
 * @returns the names, sorted; empty when none ran; null when a head's suites pass one page
 * @throws {GhError} the request failed, or GitHub knows no such pull request
 */
export function readPrHeadWorkflows(repo: string, number: number): string[] | null {
  const [owner, name] = repo.split("/") as [string, string];
  const body = graphql(PR_HEADS_QUERY, { owner, name, number });
  const repository = get(get(body, "data"), "repository");
  const prs = [get(repository, "pullRequest"), ...nodesOf(get(repository, "pullRequests"))];

  return workflowNames(prs.map(headCommit));
}

/**
 * The workflows that ran on the branch's newest commits.
 *
 * @returns the names, sorted; empty when none ran, or GitHub answers null for the branch; null when a head's suites pass one page
 * @throws {GhError} the request failed
 */
export function readBranchWorkflows(repo: string, branch: string): string[] | null {
  const [owner, name] = repo.split("/") as [string, string];
  const body = graphql(BRANCH_HEADS_QUERY, { owner, name, ref: `refs/heads/${branch}` });
  const tip = get(get(get(get(body, "data"), "repository"), "ref"), "target");

  return workflowNames(nodesOf(get(tip, "history")));
}
