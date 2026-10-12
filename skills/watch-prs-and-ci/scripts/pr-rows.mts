// The per-poll row of every subscribed pull request, read in batches: one aliased GraphQL request
// answers a chunk of PRs across repositories, so a daemon polling dozens of PRs once a minute
// spends a handful of requests, not one per PR.

import { GhError, get, gh, parseJson, requireNumber, requireString } from "./gh.mts";

// GitHub prices a GraphQL request by its node count; 30 PRs with one review and one commit each
// stay far inside the per-request budget, and a chunk's failure costs at most 30 rows.
const CHUNK_SIZE = 30;

export type PrRef = { repo: string; number: number };
/** `${repo}#${number}` */
export type PrKey = string;

export function prKey(ref: PrRef): PrKey {
  return `${ref.repo}#${ref.number}`;
}

export type Row = {
  repo: string;
  number: number;
  url: string;
  isDraft: boolean;
  state: "OPEN" | "MERGED" | "CLOSED";
  mergedAt: string | null;
  mergeCommitOid: string | null;
  headRefOid: string;
  updatedAt: string;
  issueComments: number;
  reviewThreads: number;
  latestReview: { id: string; submittedAt: string; state: string; author: string } | null;
  rollupState: string | null;
};

const ROW_FIELDS = `number url isDraft state mergedAt mergeCommit { oid } headRefOid updatedAt
      comments { totalCount } reviewThreads { totalCount }
      reviews(last: 1) { nodes { fullDatabaseId submittedAt state author { login } } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }`;

type Chunk = { query: string; aliases: { ref: PrRef; repoAlias: string; prAlias: string }[] };

// Aliases carry the identity: `r0: repository(...) { p12: pullRequest(number: 12) { ... } }`, so
// a reply is read back by alias, never by position.
function buildChunk(refs: PrRef[]): Chunk {
  const repos = [...new Set(refs.map((ref) => ref.repo))];
  const aliases: Chunk["aliases"] = [];
  const blocks = repos.map((repo, i) => {
    const [owner, name] = repo.split("/") as [string, string];
    const repoAlias = `r${i}`;
    const prs = refs
      .filter((ref) => ref.repo === repo)
      .map((ref) => {
        const prAlias = `p${ref.number}`;
        aliases.push({ ref, repoAlias, prAlias });
        return `${prAlias}: pullRequest(number: ${ref.number}) { ${ROW_FIELDS} }`;
      });
    return `${repoAlias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
    ${prs.join("\n    ")}
  }`;
  });
  return { query: `query {\n  ${blocks.join("\n  ")}\n}`, aliases };
}

function parseRow(ref: PrRef, pr: unknown): Row {
  const state = requireString(get(pr, "state"), "pullRequest.state");
  if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED") {
    throw new GhError(`GraphQL response: pullRequest.state is ${state}`);
  }
  const mergedAt = get(pr, "mergedAt");
  const mergeCommitOid = get(get(pr, "mergeCommit"), "oid");
  const reviewNodes = get(get(pr, "reviews"), "nodes");
  if (!Array.isArray(reviewNodes)) {
    throw new GhError("GraphQL response: reviews.nodes is not an array");
  }
  const review = reviewNodes[reviewNodes.length - 1];
  const reviewAuthor = get(get(review, "author"), "login");
  const reviewSubmittedAt = get(review, "submittedAt");
  const commitNodes = get(get(pr, "commits"), "nodes");
  const rollupState = get(
    get(
      get(Array.isArray(commitNodes) ? commitNodes[0] : undefined, "commit"),
      "statusCheckRollup",
    ),
    "state",
  );
  return {
    repo: ref.repo,
    number: requireNumber(get(pr, "number"), "pullRequest.number"),
    url: requireString(get(pr, "url"), "pullRequest.url"),
    isDraft: get(pr, "isDraft") === true,
    state,
    mergedAt: typeof mergedAt === "string" ? mergedAt : null,
    mergeCommitOid: typeof mergeCommitOid === "string" ? mergeCommitOid : null,
    headRefOid: requireString(get(pr, "headRefOid"), "pullRequest.headRefOid"),
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
            submittedAt: typeof reviewSubmittedAt === "string" ? reviewSubmittedAt : "unsubmitted",
            state: requireString(get(review, "state"), "review state"),
            author: typeof reviewAuthor === "string" ? reviewAuthor : "ghost",
          },
    rollupState: typeof rollupState === "string" ? rollupState : null,
  };
}

// gh exits 1 when the reply carries an `errors` entry, which a deleted PR in the batch does
// ("Could not resolve to a PullRequest"), with the other PRs' data still on stdout. That data is
// read; a reply with no data at all is the failure it looks like.
function requestChunk(chunk: Chunk): unknown {
  let raw: string;
  let failure: GhError | null = null;
  try {
    raw = gh(["api", "graphql", "-f", `query=${chunk.query}`]);
  } catch (error) {
    if (!(error instanceof GhError) || error.stdout === undefined) throw error;
    failure = error;
    raw = error.stdout;
  }
  let data: unknown;
  try {
    data = get(parseJson(raw, "gh api graphql"), "data");
  } catch (error) {
    throw failure ?? error;
  }
  if (data === undefined || data === null) {
    throw failure ?? new GhError("GraphQL response carries no data");
  }
  return data;
}

/** The rows of every ref the API can see, keyed by prKey. A PR the API returns as null (deleted,
 * or no access) is absent; a chunk whose every PR is null is an error naming them. */
export function readRows(refs: PrRef[]): Map<PrKey, Row> {
  const rows = new Map<PrKey, Row>();
  for (let start = 0; start < refs.length; start += CHUNK_SIZE) {
    const chunk = buildChunk(refs.slice(start, start + CHUNK_SIZE));
    const data = requestChunk(chunk);
    const unseen: PrKey[] = [];
    for (const { ref, repoAlias, prAlias } of chunk.aliases) {
      const pr = get(get(data, repoAlias), prAlias);
      if (pr === null || pr === undefined) {
        unseen.push(prKey(ref));
        continue;
      }
      rows.set(prKey(ref), parseRow(ref, pr));
    }
    if (unseen.length === chunk.aliases.length) {
      throw new GhError(`GraphQL response has no pullRequest for ${unseen.join(", ")}`);
    }
  }
  return rows;
}

export type ChangeSet = { activity: boolean; head: boolean; rollup: boolean; state: boolean };

// A first sighting is a baseline, not news: everything but activity reads as changed so the
// daemon judges the head and state it sees, without replaying every comment already on the PR.
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
