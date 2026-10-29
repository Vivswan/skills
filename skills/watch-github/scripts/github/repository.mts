// The per-poll read of one repository: one aliased GraphQL request answers every watched pull
// request's row, every watched branch's tip, and the check suites of each head whose CI is
// pending. Aliases carry the identity, so a reply is read back by alias, never by position, and a
// PR GitHub answers null for (deleted, or no access) is null in the result while the rest of the
// batch stands.

import { parseSuites, SUITES_CONNECTION, type Suites } from "./check-suites.mts";
import { GhError, get, gh, parseJson, requireNumber, requireString, stringOrNull } from "./gh.mts";

// GitHub prices a GraphQL request by its node count; 30 PRs with one review and one commit each stay far inside the per-request budget, and a chunk's failure costs at most 30 rows.
const CHUNK_SIZE = 30;

export type Row = {
  number: number;
  url: string;
  isDraft: boolean;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
  baseRefName: string;
  stackBaseRefName: string | null;
  headRefOid: string;
  headAuthor: string | null;
  updatedAt: string;
  issueComments: number;
  reviewThreads: number;
  latestReview: { id: string; submittedAt: string; state: string; author: string } | null;
  rollupState: string | null;
  labels: string[];
  mergeable: Mergeable;
};

/** GitHub's merge test against the base: UNKNOWN while it recomputes after either side moves. */
export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

export type Tip = {
  oid: string;
  author: string | null;
  rollupState: string | null;
};

/** What to read of one repository: the PRs and branches, and which of each need their suites. */
export interface RepoRead {
  prs: number[];
  branches: string[];
  suitesFor: { prs: Set<number>; branches: Set<string> };
}

export interface RepoReply {
  /** Null: GitHub answered null for the alias (a deleted PR, or no access). */
  rows: Map<number, { row: Row; suites: Suites | null } | null>;

  /** Null: GitHub answered null for the alias (a deleted branch, or no access). */
  tips: Map<string, { tip: Tip; suites: Suites | null } | null>;
}

const COMMIT_FIELDS = "oid author { user { login } } statusCheckRollup { state }";

function rowFields(withSuites: boolean): string {
  return `number url isDraft state mergedAt baseRefName headRefOid updatedAt mergeable stack { baseRefName }
      comments { totalCount } reviewThreads { totalCount } labels(first: 100) { nodes { name } }
      reviews(last: 1) { nodes { fullDatabaseId submittedAt state author { login } } }
      commits(last: 1) { nodes { commit { ${COMMIT_FIELDS}${withSuites ? ` ${SUITES_CONNECTION}` : ""} } } }`;
}

type Chunk = { query: string; prs: number[]; branches: string[] };

/**
 * `r: repository(...) { p12: pullRequest(number: 12) { ... } b0: ref(qualifiedName: "refs/heads/main") { ... } }`.
 * Branch names are not alias-safe, so branches are aliased by position.
 */
function buildChunk(repo: string, prs: number[], branches: string[], read: RepoRead): Chunk {
  const [owner, name] = repo.split("/") as [string, string];
  const parts = prs.map(
    (number) =>
      `p${number}: pullRequest(number: ${number}) { ${rowFields(read.suitesFor.prs.has(number))} }`,
  );
  branches.forEach((branch, i) => {
    const suites = read.suitesFor.branches.has(branch) ? ` ${SUITES_CONNECTION}` : "";
    parts.push(
      `b${i}: ref(qualifiedName: ${JSON.stringify(`refs/heads/${branch}`)}) { target { ... on Commit { ${COMMIT_FIELDS}${suites} } } }`,
    );
  });
  const query = `query {\n  r: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n    ${parts.join("\n    ")}\n  }\n}`;
  return { query, prs, branches };
}

// author.user is null for a commit no GitHub account claims.
function loginOf(commit: unknown): string | null {
  return stringOrNull(get(get(get(commit, "author"), "user"), "login"));
}

function parseRow(pr: unknown): { row: Row; suites: Suites | null } {
  const state = requireString(get(pr, "state"), "pullRequest.state");
  if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") {
    throw new GhError(`GraphQL response: pullRequest.state is ${state}`);
  }
  const reviewNodes = get(get(pr, "reviews"), "nodes");
  if (!Array.isArray(reviewNodes)) {
    throw new GhError("GraphQL response: reviews.nodes is not an array");
  }
  const review = reviewNodes[reviewNodes.length - 1];
  const mergeable = requireString(get(pr, "mergeable"), "pullRequest.mergeable");
  if (mergeable !== "MERGEABLE" && mergeable !== "CONFLICTING" && mergeable !== "UNKNOWN") {
    throw new GhError(`GraphQL response: pullRequest.mergeable is ${mergeable}`);
  }
  const labelNodes = get(get(pr, "labels"), "nodes");
  if (!Array.isArray(labelNodes)) {
    throw new GhError("GraphQL response: labels.nodes is not an array");
  }
  const commitNodes = get(get(pr, "commits"), "nodes");
  const commit = get(Array.isArray(commitNodes) ? commitNodes[0] : undefined, "commit");
  const suites = get(commit, "checkSuites");
  return {
    row: {
      number: requireNumber(get(pr, "number"), "pullRequest.number"),
      url: requireString(get(pr, "url"), "pullRequest.url"),
      isDraft: get(pr, "isDraft") === true,
      state,
      mergedAt: stringOrNull(get(pr, "mergedAt")),
      baseRefName: requireString(get(pr, "baseRefName"), "pullRequest.baseRefName"),
      stackBaseRefName: stringOrNull(get(get(pr, "stack"), "baseRefName")),
      headRefOid: requireString(get(pr, "headRefOid"), "pullRequest.headRefOid"),
      headAuthor: loginOf(commit),
      updatedAt: requireString(get(pr, "updatedAt"), "pullRequest.updatedAt"),
      issueComments: requireNumber(get(get(pr, "comments"), "totalCount"), "comments.totalCount"),
      reviewThreads: requireNumber(
        get(get(pr, "reviewThreads"), "totalCount"),
        "reviewThreads.totalCount",
      ),
      latestReview:
        review === undefined
          ? null
          : {
              id: requireString(get(review, "fullDatabaseId"), "review fullDatabaseId"),
              // Deleted accounts null the author; a PENDING review has no submittedAt.
              submittedAt: stringOrNull(get(review, "submittedAt")) ?? "unsubmitted",
              state: requireString(get(review, "state"), "review state"),
              author: stringOrNull(get(get(review, "author"), "login")) ?? "ghost",
            },
      rollupState: stringOrNull(get(get(commit, "statusCheckRollup"), "state")),
      // Sorted, so two rows compare as sets; one page of 100, GitHub's maximum, so a page shift never reads as a change.
      labels: labelNodes
        .map((node, i) => requireString(get(node, "name"), `labels.nodes[${i}].name`))
        .sort(),
      mergeable,
    },
    suites: suites === undefined ? null : parseSuites(suites),
  };
}

function parseTip(ref: unknown): { tip: Tip; suites: Suites | null } {
  const commit = get(ref, "target");
  const suites = get(commit, "checkSuites");
  return {
    tip: {
      oid: requireString(get(commit, "oid"), "ref.target.oid"),
      author: loginOf(commit),
      rollupState: stringOrNull(get(get(commit, "statusCheckRollup"), "state")),
    },
    suites: suites === undefined ? null : parseSuites(suites),
  };
}

// gh exits 1 when the reply carries an `errors` entry, which a deleted PR in the batch does
// ("Could not resolve to a PullRequest"), with the other PRs' data still on stdout. That data is
// read, and the error kept for the caller to raise once the data proves unusable.
function rawReply(query: string): { raw: string; failure: GhError | null } {
  try {
    return { raw: gh(["api", "graphql", "-f", `query=${query}`]), failure: null };
  } catch (error) {
    if (!(error instanceof GhError) || error.stdout === undefined) throw error;
    return { raw: error.stdout, failure: error };
  }
}

// A reply with no data at all is the failure it looks like, and so is an error at an alias that is
// not a NOT_FOUND: an INTERNAL or RATE_LIMITED answer nulls the alias too, and read as a deleted
// target it would end the watch with the wrong word.
function requestChunk(chunk: Chunk): { data: unknown; failure: GhError | null } {
  const { raw, failure } = rawReply(chunk.query);
  let body: unknown;
  try {
    body = parseJson(raw, "gh api graphql");
  } catch (error) {
    throw failure ?? error;
  }
  const data = get(body, "data");
  if (data === undefined || data === null) {
    throw failure ?? new GhError("GraphQL response carries no data");
  }
  const errors = get(body, "errors");
  for (const entry of Array.isArray(errors) ? errors : []) {
    const type = get(entry, "type");
    if (type !== undefined && type !== "NOT_FOUND") {
      throw failure ?? new GhError(`GraphQL response carries a ${String(type)} error`);
    }
  }
  return { data, failure };
}

/** One repository's rows and tips, in one request per 30 PRs; the branches ride with the first. */
export function readRepository(repo: string, read: RepoRead): RepoReply {
  const reply: RepoReply = { rows: new Map(), tips: new Map() };
  const chunks: Chunk[] = [];
  for (let start = 0; start < Math.max(read.prs.length, 1); start += CHUNK_SIZE) {
    chunks.push(
      buildChunk(
        repo,
        read.prs.slice(start, start + CHUNK_SIZE),
        start === 0 ? read.branches : [],
        read,
      ),
    );
  }
  for (const chunk of chunks) {
    const { data, failure } = requestChunk(chunk);
    const repository = get(data, "r");
    // A null repository is the whole read failed (gone, no access, or an error at its path), not
    // every target unreadable at once; the poll fails and is retried.
    if (repository === null || repository === undefined) {
      throw failure ?? new GhError(`GraphQL response has no repository ${repo}`);
    }
    for (const number of chunk.prs) {
      const pr = get(repository, `p${number}`);
      reply.rows.set(number, pr === null || pr === undefined ? null : parseRow(pr));
    }
    chunk.branches.forEach((branch, i) => {
      const ref = get(repository, `b${i}`);
      reply.tips.set(branch, ref === null || ref === undefined ? null : parseTip(ref));
    });
  }
  return reply;
}

export type ChangeSet = { activity: boolean; head: boolean; rollup: boolean; state: boolean };

// A first sighting is a baseline, not news: everything but activity reads as changed so the
// source judges the head and state it sees, without replaying every comment already on the PR.
export function rowChanged(previous: Row | undefined, current: Row): ChangeSet {
  if (previous === undefined) return { activity: false, head: true, rollup: true, state: true };
  const before = previous.latestReview;
  const after = current.latestReview;
  const reviewSame =
    before === null || after === null
      ? before === after
      : before.id === after.id &&
        before.submittedAt === after.submittedAt &&
        before.state === after.state &&
        before.author === after.author;
  return {
    activity:
      previous.updatedAt !== current.updatedAt ||
      previous.issueComments !== current.issueComments ||
      previous.reviewThreads !== current.reviewThreads ||
      !reviewSame,
    head: previous.headRefOid !== current.headRefOid,
    rollup: previous.rollupState !== current.rollupState,
    state: previous.state !== current.state,
  };
}
