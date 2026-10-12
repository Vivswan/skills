// The detail read for one pull request whose row moved: recent comments, reviews, and review
// threads as a flat activity list, so the daemon can say what is new since the last poll.

import { GhError, get, gh, parseJson, requireNumber, requireString } from "./gh.mts";
import type { PrRef } from "./pr-rows.mts";

// 100 threads per page; a PR with more than 5000 is a broken measurement.
const MAX_PAGES = 50;

export type Activity = {
  kind: "comment" | "review" | "review-comment" | "reply";
  at: string;
  author: string;
  body: string;
  url: string;
  path?: string;
  line?: number | null;
  reviewState?: string;
};

export type PrDetail = {
  lastCommitAuthor: string | null;
  unresolvedThreads: number;
  activities: Activity[];
};

// totalCount on a thread's comments tells whether the oldest fetched comment is the thread's
// first: comments(last: 3) on a longer thread returns replies only.
const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      comments(last: 20) { nodes { databaseId publishedAt createdAt author { login } body url } }
      reviews(last: 10) { nodes { fullDatabaseId submittedAt state author { login } body url } }
      reviewThreads(first: 100, after: $cursor) {
        nodes {
          isResolved path line
          comments(last: 3) { totalCount nodes { databaseId publishedAt createdAt author { login } body url } }
        }
        pageInfo { hasNextPage endCursor }
      }
      commits(last: 1) { nodes { commit { author { user { login } } } } }
    }
  }
}`;

type DetailPage = {
  pr: unknown;
  threads: unknown[];
  hasNextPage: boolean;
  endCursor: string | null;
};

function parseDetailPage(raw: string): DetailPage {
  const pr = get(get(get(parseJson(raw, "gh api graphql"), "data"), "repository"), "pullRequest");
  if (pr === null || pr === undefined) {
    throw new GhError("GraphQL response has no pullRequest (wrong repo or PR number?)");
  }
  const threads = get(pr, "reviewThreads");
  const nodes = get(threads, "nodes");
  if (!Array.isArray(nodes)) {
    throw new GhError("GraphQL response: reviewThreads.nodes is not an array");
  }
  const pageInfo = get(threads, "pageInfo");
  const hasNextPage = get(pageInfo, "hasNextPage");
  if (typeof hasNextPage !== "boolean") {
    throw new GhError("GraphQL response: pageInfo.hasNextPage is not a boolean");
  }
  const endCursor = get(pageInfo, "endCursor");
  return {
    pr,
    threads: nodes,
    hasNextPage,
    endCursor: typeof endCursor === "string" ? endCursor : null,
  };
}

function nodesOf(value: unknown, what: string): unknown[] {
  const nodes = get(value, "nodes");
  if (!Array.isArray(nodes)) throw new GhError(`GraphQL response: ${what}.nodes is not an array`);
  return nodes;
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
  }
  return activity;
}

// A review's content is its state and body. GitHub wraps every batch of inline comments in a
// COMMENTED review with an empty body, which says nothing the thread comments do not, so those
// are dropped; a PENDING review (no submittedAt) is the viewer's own unsubmitted draft.
function reviewActivities(pr: unknown): Activity[] {
  const activities: Activity[] = [];
  for (const node of nodesOf(get(pr, "reviews"), "reviews")) {
    const submittedAt = get(node, "submittedAt");
    if (typeof submittedAt !== "string") continue;
    const state = requireString(get(node, "state"), "review state");
    const body = typeof get(node, "body") === "string" ? (get(node, "body") as string) : "";
    if (state === "COMMENTED" && body === "") continue;
    activities.push({
      kind: "review",
      at: submittedAt,
      author: loginOf(node),
      body,
      url: requireString(get(node, "url"), "review url"),
      reviewState: state,
    });
  }
  return activities;
}

function threadActivities(thread: unknown, index: number): Activity[] {
  const where = `reviewThreads.nodes[${index}]`;
  const path = requireString(get(thread, "path"), `${where}.path`);
  const line = get(thread, "line");
  const comments = get(thread, "comments");
  const total = requireNumber(get(comments, "totalCount"), `${where}.comments.totalCount`);
  const nodes = nodesOf(comments, `${where}.comments`);
  const firstFetched = total - nodes.length;
  return nodes.map((node, i) =>
    commentActivity(
      node,
      firstFetched + i === 0 ? "review-comment" : "reply",
      `${where}.comments.nodes[${i}]`,
      { path, line: typeof line === "number" ? line : null },
    ),
  );
}

export function readPrDetail(ref: PrRef): PrDetail {
  const [owner, name] = ref.repo.split("/") as [string, string];
  let first: unknown;
  let unresolvedThreads = 0;
  const activities: Activity[] = [];
  let cursor: string | null = null;
  for (let pageCount = 1; ; pageCount += 1) {
    if (pageCount > MAX_PAGES) {
      throw new GhError(`review-thread pagination did not end after ${MAX_PAGES} pages`);
    }
    const args = ["api", "graphql", "-f", `query=${DETAIL_QUERY}`];
    args.push("-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${ref.number}`);
    if (cursor !== null) args.push("-f", `cursor=${cursor}`);
    const page = parseDetailPage(gh(args));
    first ??= page.pr;
    page.threads.forEach((thread, i) => {
      if (get(thread, "isResolved") !== true) unresolvedThreads += 1;
      activities.push(...threadActivities(thread, i));
    });
    if (!page.hasNextPage) break;
    if (page.endCursor === null) {
      throw new GhError("GraphQL response: hasNextPage without an endCursor");
    }
    cursor = page.endCursor;
  }
  for (const node of nodesOf(get(first, "comments"), "comments")) {
    activities.push(commentActivity(node, "comment", "comment"));
  }
  activities.push(...reviewActivities(first));
  const commit = get(nodesOf(get(first, "commits"), "commits")[0], "commit");
  const commitAuthor = get(get(get(commit, "author"), "user"), "login");
  return {
    lastCommitAuthor: typeof commitAuthor === "string" ? commitAuthor : null,
    unresolvedThreads,
    activities,
  };
}

/** Activities strictly after sinceIso by instant, the viewer's own excluded, oldest first. */
export function newActivity(detail: PrDetail, sinceIso: string, viewer: string): Activity[] {
  const since = Date.parse(sinceIso);
  if (Number.isNaN(since)) throw new Error(`newActivity: sinceIso is not a timestamp: ${sinceIso}`);
  return detail.activities
    .filter((activity) => activity.author !== viewer && Date.parse(activity.at) > since)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function viewerLogin(): string {
  const raw = gh(["api", "graphql", "-f", "query={ viewer { login } }"]);
  return requireString(
    get(get(get(parseJson(raw, "gh api graphql"), "data"), "viewer"), "login"),
    "viewer.login",
  );
}
