// The detail read for one pull request whose row moved: recent comments, reviews, and review
// threads as a flat activity list, so the daemon can say what is new since the last poll.

import { GhError, get, gh, parseJson, requireNumber, requireString } from "./gh.mts";
import type { PrRef } from "./pr-rows.mts";

// 100 threads per page; a PR with more than 5000 is a broken measurement.
const MAX_THREAD_PAGES = 50;
// Each connection is read newest-first until an id the daemon has already reported appears; a
// daemon stopped for long enough to miss this many pages reports the gap instead of the rest.
const MAX_BACK_PAGES = 10;

export type Activity = {
  /** `<kind class>:<GitHub database id>`; the daemon's cursor is the set of these it has reported. */
  id: string;
  kind: "comment" | "review" | "review-comment" | "reply";
  at: string;
  author: string;
  body: string;
  url: string;
  path?: string;
  line?: number | null;
  reviewState?: string;
  /** For an inline comment, the `id` of the review that published it. */
  reviewId?: string;
};

export type PrDetail = {
  lastCommitAuthor: string | null;
  unresolvedThreads: number;
  activities: Activity[];
  /** One line per connection whose older activity was left unread at the paging cap. */
  gaps: string[];
};

const COMMENT_FIELDS = "databaseId publishedAt createdAt author { login } body url";
const REVIEW_COMMENT_FIELDS = `${COMMENT_FIELDS} pullRequestReview { fullDatabaseId }`;
const REVIEW_FIELDS = "fullDatabaseId submittedAt state author { login } body url";
const BACK_PAGE_INFO = "pageInfo { hasPreviousPage startCursor }";

// totalCount on a thread's comments tells whether the oldest fetched comment is the thread's
// first: comments(last: 3) on a longer thread returns replies only.
const DETAIL_QUERY = `query PrDetail($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(last: 20) { nodes { ${COMMENT_FIELDS} } ${BACK_PAGE_INFO} }
      reviews(last: 10) { nodes { ${REVIEW_FIELDS} } ${BACK_PAGE_INFO} }
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          id isResolved path line
          comments(last: 3) { totalCount nodes { ${REVIEW_COMMENT_FIELDS} } ${BACK_PAGE_INFO} }
        }
        pageInfo { hasNextPage endCursor }
      }
      commits(last: 1) { nodes { commit { author { user { login } } } } }
    }
  }
}`;

const OLDER_COMMENTS_QUERY = `query OlderComments($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(last: 20, before: $cursor) { nodes { ${COMMENT_FIELDS} } ${BACK_PAGE_INFO} }
    }
  }
}`;

const OLDER_REVIEWS_QUERY = `query OlderReviews($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(last: 10, before: $cursor) { nodes { ${REVIEW_FIELDS} } ${BACK_PAGE_INFO} }
    }
  }
}`;

const OLDER_THREAD_COMMENTS_QUERY = `query OlderThreadComments($id: ID!, $cursor: String!) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(last: 20, before: $cursor) { nodes { ${REVIEW_COMMENT_FIELDS} } ${BACK_PAGE_INFO} }
    }
  }
}`;

type Connection = { nodes: unknown[]; hasPreviousPage: boolean; startCursor: string | null };

function nodesOf(value: unknown, what: string): unknown[] {
  const nodes = get(value, "nodes");
  if (!Array.isArray(nodes)) throw new GhError(`GraphQL response: ${what}.nodes is not an array`);
  return nodes;
}

function connectionOf(value: unknown, what: string): Connection {
  const pageInfo = get(value, "pageInfo");
  const hasPreviousPage = get(pageInfo, "hasPreviousPage");
  if (typeof hasPreviousPage !== "boolean") {
    throw new GhError(`GraphQL response: ${what}.pageInfo.hasPreviousPage is not a boolean`);
  }
  const startCursor = get(pageInfo, "startCursor");
  return {
    nodes: nodesOf(value, what),
    hasPreviousPage,
    startCursor: typeof startCursor === "string" ? startCursor : null,
  };
}

function pullRequestOf(body: unknown): unknown {
  const pr = get(get(get(body, "data"), "repository"), "pullRequest");
  if (pr === null || pr === undefined) {
    throw new GhError("GraphQL response has no pullRequest (wrong repo or PR number?)");
  }
  return pr;
}

function commentId(node: unknown, kind: "comment" | "review-comment", what: string): string {
  return `${kind}:${requireNumber(get(node, "databaseId"), `${what} databaseId`)}`;
}

function reviewId(node: unknown, what: string): string {
  return `review:${requireString(get(node, "fullDatabaseId"), `${what} fullDatabaseId`)}`;
}

// GitHub renders a deleted account's comments under "ghost"; the same name here keeps the viewer
// filter in newActivity from ever matching one.
function loginOf(node: unknown): string {
  const login = get(get(node, "author"), "login");
  return typeof login === "string" ? login : "ghost";
}

function commentActivity(
  node: unknown,
  kind: Activity["kind"],
  what: string,
  thread?: { path: string; line: number | null },
): Activity {
  const body = get(node, "body");
  // An inline comment is created while its review is a draft and published when the review is
  // submitted; only the publication instant is news to anyone but its author.
  const publishedAt = get(node, "publishedAt");
  const activity: Activity = {
    id: commentId(node, thread === undefined ? "comment" : "review-comment", what),
    kind,
    at:
      typeof publishedAt === "string"
        ? publishedAt
        : requireString(get(node, "createdAt"), `${what} createdAt`),
    author: loginOf(node),
    body: typeof body === "string" ? body : "",
    url: requireString(get(node, "url"), `${what} url`),
  };
  if (thread !== undefined) {
    activity.path = thread.path;
    activity.line = thread.line;
    const review = get(node, "pullRequestReview");
    if (review !== null && review !== undefined) {
      activity.reviewId = reviewId(review, `${what} pullRequestReview`);
    }
  }
  return activity;
}

// A PENDING review (no submittedAt) is the viewer's own unsubmitted draft. The empty COMMENTED
// review GitHub wraps a batch of inline comments in stays: the renderer headlines the batch under
// it, and drops it when no inline comment of its own is new.
function reviewActivities(nodes: unknown[]): Activity[] {
  const activities: Activity[] = [];
  for (const node of nodes) {
    const submittedAt = get(node, "submittedAt");
    if (typeof submittedAt !== "string") continue;
    const body = get(node, "body");
    activities.push({
      id: reviewId(node, "review"),
      kind: "review",
      at: submittedAt,
      author: loginOf(node),
      body: typeof body === "string" ? body : "",
      url: requireString(get(node, "url"), "review url"),
      reviewState: requireString(get(node, "state"), "review state"),
    });
  }
  return activities;
}

function threadActivities(
  thread: { path: string; line: number | null },
  total: number,
  nodes: unknown[],
  where: string,
): Activity[] {
  const firstFetched = total - nodes.length;
  return nodes.map((node, i) =>
    commentActivity(
      node,
      firstFetched + i === 0 ? "review-comment" : "reply",
      `${where}.comments.nodes[${i}]`,
      thread,
    ),
  );
}

/** The daemon's cursor: the ids it has reported. `null` at a first sighting, where nothing is news. */
export type Seen = ReadonlySet<string> | null;

class DetailReader {
  private readonly owner: string;
  private readonly name: string;
  readonly gaps: string[] = [];

  constructor(
    private readonly ref: PrRef,
    private readonly seen: Seen,
  ) {
    [this.owner, this.name] = ref.repo.split("/") as [string, string];
  }

  private graphql(query: string, variables: Record<string, string | number>): unknown {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
    }
    return parseJson(gh(args), "gh api graphql");
  }

  private prVariables(cursor?: string): Record<string, string | number> {
    const variables: Record<string, string | number> = {
      owner: this.owner,
      name: this.name,
      number: this.ref.number,
    };
    if (cursor !== undefined) variables.cursor = cursor;
    return variables;
  }

  // The seen set holds two reads' windows, so a node older than the newest reported one on the
  // stopping page is history the set has forgotten, not news: a back page is wider than a
  // thread's window, and would otherwise resurface comments from before the baseline.
  private readBack(
    first: Connection,
    what: string,
    idOf: (node: unknown) => string,
    older: (cursor: string) => Connection,
  ): unknown[] {
    const seen = this.seen;
    if (seen === null) return first.nodes;
    const newer: unknown[] = [];
    let page = first;
    for (let pages = 1; ; pages += 1) {
      const boundary = page.nodes.findLastIndex((node) => seen.has(idOf(node)));
      if (boundary >= 0) return [...page.nodes.slice(boundary), ...newer];
      if (!page.hasPreviousPage) return [...page.nodes, ...newer];
      if (pages === MAX_BACK_PAGES) {
        this.gaps.push(
          `${what}: more than ${MAX_BACK_PAGES} pages since the last one reported; the older ones are not reported`,
        );
        return [...page.nodes, ...newer];
      }
      if (page.startCursor === null) {
        throw new GhError(`GraphQL response: ${what} hasPreviousPage without a startCursor`);
      }
      newer.unshift(...page.nodes);
      page = older(page.startCursor);
    }
  }

  private olderComments(cursor: string): Connection {
    const pr = pullRequestOf(this.graphql(OLDER_COMMENTS_QUERY, this.prVariables(cursor)));
    return connectionOf(get(pr, "comments"), "comments");
  }

  private olderReviews(cursor: string): Connection {
    const pr = pullRequestOf(this.graphql(OLDER_REVIEWS_QUERY, this.prVariables(cursor)));
    return connectionOf(get(pr, "reviews"), "reviews");
  }

  private olderThreadComments(threadId: string, cursor: string): Connection {
    const body = this.graphql(OLDER_THREAD_COMMENTS_QUERY, { id: threadId, cursor });
    return connectionOf(
      get(get(get(body, "data"), "node"), "comments"),
      `thread ${threadId} comments`,
    );
  }

  private threads(pr: unknown, firstIndex: number, activities: Activity[]): number {
    let unresolved = 0;
    const threads = get(pr, "reviewThreads");
    nodesOf(threads, "reviewThreads").forEach((thread, i) => {
      const where = `reviewThreads.nodes[${firstIndex + i}]`;
      if (get(thread, "isResolved") !== true) unresolved += 1;
      const line = get(thread, "line");
      const place = {
        path: requireString(get(thread, "path"), `${where}.path`),
        line: typeof line === "number" ? line : null,
      };
      const comments = get(thread, "comments");
      const total = requireNumber(get(comments, "totalCount"), `${where}.comments.totalCount`);
      const threadId = requireString(get(thread, "id"), `${where}.id`);
      const nodes = this.readBack(
        connectionOf(comments, `${where}.comments`),
        `thread on ${place.path}`,
        (node) => commentId(node, "review-comment", `${where}.comments`),
        (cursor) => this.olderThreadComments(threadId, cursor),
      );
      activities.push(...threadActivities(place, total, nodes, where));
    });
    return unresolved;
  }

  read(): PrDetail {
    let first: unknown;
    let unresolvedThreads = 0;
    let threadsRead = 0;
    const activities: Activity[] = [];
    let cursor: string | undefined;
    for (let pageCount = 1; ; pageCount += 1) {
      if (pageCount > MAX_THREAD_PAGES) {
        throw new GhError(`review-thread pagination did not end after ${MAX_THREAD_PAGES} pages`);
      }
      const pr = pullRequestOf(this.graphql(DETAIL_QUERY, this.prVariables(cursor)));
      first ??= pr;
      unresolvedThreads += this.threads(pr, threadsRead, activities);
      threadsRead += nodesOf(get(pr, "reviewThreads"), "reviewThreads").length;
      const pageInfo = get(get(pr, "reviewThreads"), "pageInfo");
      const hasNextPage = get(pageInfo, "hasNextPage");
      if (typeof hasNextPage !== "boolean") {
        throw new GhError("GraphQL response: pageInfo.hasNextPage is not a boolean");
      }
      if (!hasNextPage) break;
      const endCursor = get(pageInfo, "endCursor");
      if (typeof endCursor !== "string") {
        throw new GhError("GraphQL response: hasNextPage without an endCursor");
      }
      cursor = endCursor;
    }
    const comments = this.readBack(
      connectionOf(get(first, "comments"), "comments"),
      "issue comments",
      (node) => commentId(node, "comment", "comment"),
      (c) => this.olderComments(c),
    );
    for (const node of comments) activities.push(commentActivity(node, "comment", "comment"));
    const reviews = this.readBack(
      connectionOf(get(first, "reviews"), "reviews"),
      "reviews",
      (node) => reviewId(node, "review"),
      (c) => this.olderReviews(c),
    );
    activities.push(...reviewActivities(reviews));
    const commit = get(nodesOf(get(first, "commits"), "commits")[0], "commit");
    const commitAuthor = get(get(get(commit, "author"), "user"), "login");
    return {
      lastCommitAuthor: typeof commitAuthor === "string" ? commitAuthor : null,
      unresolvedThreads,
      activities,
      gaps: this.gaps,
    };
  }
}

export function readPrDetail(ref: PrRef, seen: Seen): PrDetail {
  return new DetailReader(ref, seen).read();
}

/**
 * Activities whose id is not in `seen`, the viewer's own excluded, oldest first. Ids, never
 * instants: GitHub's timestamps have one-second grain, so a comment published in the same second
 * as the last read would be older-or-equal to any watermark and never reported.
 */
export function newActivity(
  detail: PrDetail,
  seen: ReadonlySet<string>,
  viewer: string,
): Activity[] {
  return detail.activities
    .filter((activity) => activity.author !== viewer && !seen.has(activity.id))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function viewerLogin(): string {
  const raw = gh(["api", "graphql", "-f", "query={ viewer { login } }"]);
  return requireString(
    get(get(get(parseJson(raw, "gh api graphql"), "data"), "viewer"), "login"),
    "viewer.login",
  );
}
