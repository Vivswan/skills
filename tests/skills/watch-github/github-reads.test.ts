import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoverRuns,
  parseSuites,
  type Run,
} from "../../../skills/watch-github/scripts/github/check-suites.mts";
import { GhError, gh } from "../../../skills/watch-github/scripts/github/gh.mts";
import {
  type Activity,
  newActivity,
  readPrDetail,
} from "../../../skills/watch-github/scripts/github/pr-activity.mts";
import {
  type Row,
  readRepository,
  rowChanged,
} from "../../../skills/watch-github/scripts/github/repository.mts";
import {
  describeVerdict,
  judgeHead,
  verdictKey,
} from "../../../skills/watch-github/scripts/targets/ci.mts";
import { tempDirs } from "../../helpers/temp-dirs";

// Contract tests for the GitHub read modules: a fake `gh` on PATH validates the exact invocation
// it receives, serves hand-written GitHub-shaped JSON (uppercase enums, external suites, null
// PRs), and records every REST call as a violation, since the modules never reach those
// endpoints. Each test names what would drift silently without it. The reply is the raw body
// GitHub would send, so the modules' own parsing is under test.
//   <kind>-<n>.json   the body for call n of that kind (the last lower n serves when n is absent)
//   <kind>-<n>.fail   call n dies with no body, like a network failure
//   <kind>-<n>.exit1  call n prints its body, then this file to stderr, and exits 1: gh's
//                     behavior on a reply carrying an `errors` entry
//   <kind>-<n>.sleep  call n answers late
const FAKE_GH = `#!/usr/bin/env bash
{ printf '%s' "$*" | tr '\\n' ' '; printf '\\n'; } >> "\${STUB_ARGS_LOG}"
violate() { echo "$*" >> "\${STUB_VIOLATIONS}"; }
next() {
  local countfile="\${STUB_DIR}/.$1-count"
  local n=$(( $(cat "$countfile" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$countfile"
  echo "$n"
}
serve() {
  local kind="$1" n="$2"
  [ -f "\${STUB_DIR}/\${kind}-\${n}.sleep" ] && sleep 5
  if [ -f "\${STUB_DIR}/\${kind}-\${n}.fail" ]; then echo "gh: boom" >&2; exit 1; fi
  local m="$n"
  while [ "$m" -gt 1 ] && [ ! -f "\${STUB_DIR}/\${kind}-\${m}.json" ]; do m=$((m-1)); done
  local file="\${STUB_DIR}/\${kind}-\${m}.json"
  if [ ! -f "$file" ]; then echo "fake gh: no \${kind} fixture for call $n" >&2; exit 1; fi
  cat "$file"
  if [ -f "\${STUB_DIR}/\${kind}-\${n}.exit1" ]; then cat "\${STUB_DIR}/\${kind}-\${n}.exit1" >&2; exit 1; fi
  exit 0
}
if [ "$1 $2" = "api graphql" ]; then
  shift 2
  query=""; owner=""; name=""; oid=""; number=""; cursor=""; id=""
  while [ "$#" -gt 0 ]; do
    case "$1 $2" in
      "-f query="*) query="\${2#query=}";;
      "-f owner="*) owner="\${2#owner=}";;
      "-f name="*) name="\${2#name=}";;
      "-f oid="*) oid="\${2#oid=}";;
      "-f cursor="*) cursor="\${2#cursor=}";;
      "-f id="*) id="\${2#id=}";;
      "-F number="*) number="\${2#number=}";;
      *) violate "graphql arg: $1 $2"; exit 64;;
    esac
    shift 2
  done
  case "$query" in
    *'r: repository('*)
      [ -z "$owner$name$oid$number$cursor" ] || { violate "rows query must inline its targets: $owner/$name/$oid/$number/$cursor"; exit 64; }
      serve rows "$(next rows)";;
    *'nodes(ids:'*)
      serve jobs "$(next jobs)";;
    *'checkSuites('*)
      [ "$owner/$name/$oid/$number" = "octocat/repo/deadbeef/" ] || { violate "suites target: $owner/$name/$oid/$number"; exit 64; }
      serve suites "$(next suites)";;
    *'reviewThreads(first:'*)
      [ "$owner/$name/$oid/$number" = "octocat/repo//7" ] || { violate "detail target: $owner/$name/$oid/$number"; exit 64; }
      serve detail "$(next detail)";;
    *'query OlderComments('*)
      [ "$owner/$name/$oid/$number" = "octocat/repo//7" ] && [ -n "$cursor" ] || { violate "older comments target: $owner/$name/$oid/$number before $cursor"; exit 64; }
      serve older-comments "$(next older-comments)";;
    *'query OlderReviews('*)
      [ "$owner/$name/$oid/$number" = "octocat/repo//7" ] && [ -n "$cursor" ] || { violate "older reviews target: $owner/$name/$oid/$number before $cursor"; exit 64; }
      serve older-reviews "$(next older-reviews)";;
    *'query OlderThreadComments('*)
      [ -n "$id" ] && [ -n "$cursor" ] && [ -z "$owner$name$oid$number" ] || { violate "older thread comments target: $id before $cursor"; exit 64; }
      serve older-thread "$(next older-thread)";;
    *viewer*)
      serve viewer "$(next viewer)";;
    *) violate "graphql query: $query"; exit 64;;
  esac
fi
case "$1 $2" in
  "run list" | "run watch" | "run view") violate "actions rest: $*"; echo "HTTP 403: API rate limit exceeded for user ID 1" >&2; exit 1;;
esac
violate "unknown: $*"
exit 64
`;

const temps = tempDirs();
const binDir = temps.dir("github-reads-bin-");
const emptyBinDir = temps.dir("github-reads-nobin-");
writeFileSync(join(binDir, "gh"), FAKE_GH);
chmodSync(join(binDir, "gh"), 0o755);

// The modules spawn gh with the process environment, so the fake goes first on this process's
// PATH for the file's duration.
const ORIGINAL_PATH = process.env.PATH ?? "";
process.env.PATH = `${binDir}:${ORIGINAL_PATH}`;
afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
});

function readOr(path: string, fallback: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

/** One fixture directory per scenario, named through the environment the fake reads. */
function scenario(fixtures: Record<string, string>) {
  const dir = temps.dir("github-reads-fixtures-");
  for (const [name, body] of Object.entries(fixtures)) writeFileSync(join(dir, name), body);
  process.env.STUB_DIR = dir;
  process.env.STUB_ARGS_LOG = join(dir, "args.log");
  process.env.STUB_VIOLATIONS = join(dir, "violations.log");
  return {
    calls: () => readOr(join(dir, "args.log"), "").split("\n").filter(Boolean),
    violations: () => readOr(join(dir, "violations.log"), ""),
  };
}

// --- fixtures ----------------------------------------------------------------

type SuiteSpec =
  | { id: number; status?: string; conclusion?: string | null; wf?: number | null; name?: string }
  | { external: true };

/** The nodes of a checkSuites connection as GitHub renders them: uppercase enums, a null workflowRun on external suites. */
function suiteNodes(specs: SuiteSpec[]): unknown[] {
  return specs.map((spec) => {
    if ("external" in spec) {
      return {
        id: "S-external",
        status: "COMPLETED",
        conclusion: "FAILURE",
        app: { slug: "codeql" },
        workflowRun: null,
      };
    }
    const status = (spec.status ?? "completed").toUpperCase();
    const conclusion =
      status !== "COMPLETED" || spec.conclusion === null
        ? null
        : (spec.conclusion ?? "success").toUpperCase();
    return {
      id: `S${spec.id}`,
      status,
      conclusion,
      app: { slug: "github-actions" },
      workflowRun: {
        databaseId: spec.id,
        url: `https://github.com/octocat/repo/actions/runs/${spec.id}`,
        updatedAt: "2026-03-01T10:00:00Z",
        workflow: {
          databaseId: spec.wf === undefined ? 1000 + spec.id : spec.wf,
          name: spec.name ?? `CI-${spec.id}`,
        },
      },
    };
  });
}

function suitesConnection(specs: SuiteSpec[], nextCursor: string | null = null): unknown {
  return {
    nodes: suiteNodes(specs),
    pageInfo: { hasNextPage: nextCursor !== null, endCursor: nextCursor },
  };
}

/** One reply of the paged suites query. */
function suitesPage(specs: SuiteSpec[], nextCursor: string | null = null): string {
  return JSON.stringify({
    data: { repository: { object: { checkSuites: suitesConnection(specs, nextCursor) } } },
  });
}

function run(spec: Exclude<SuiteSpec, { external: true }>): Run {
  const status = spec.status ?? "completed";
  return {
    id: spec.id,
    suiteId: `S${spec.id}`,
    status,
    conclusion:
      status !== "completed" || spec.conclusion === null ? null : (spec.conclusion ?? "success"),
    workflowId: spec.wf === undefined ? 1000 + spec.id : spec.wf,
    updatedAt: "2026-03-01T10:00:00Z",
    name: spec.name ?? `CI-${spec.id}`,
    url: `https://github.com/octocat/repo/actions/runs/${spec.id}`,
  };
}

type PrNodeSpec = Partial<{
  number: number;
  url: string;
  isDraft: boolean;
  state: string;
  mergedAt: string | null;
  baseRefName: string;
  headRefOid: string;
  author: string | null;
  updatedAt: string;
  comments: number;
  threads: number;
  review: { id: string; submittedAt: string | null; state: string; login: string | null } | null;
  rollup: string | null;
  /** The head's check suites, present only when the read asked for them. */
  suites: SuiteSpec[];
  suitesNext: string;
}>;

/** One pullRequest node of the per-repository query, GitHub-shaped. */
function prNode(spec: PrNodeSpec = {}): unknown {
  const review = spec.review === undefined ? null : spec.review;
  const author = spec.author === undefined ? "octocat" : spec.author;
  return {
    number: spec.number ?? 1,
    url: spec.url ?? `https://example.com/octocat/repo/pull/${spec.number ?? 1}`,
    isDraft: spec.isDraft ?? false,
    state: spec.state ?? "OPEN",
    mergedAt: spec.mergedAt ?? null,
    baseRefName: spec.baseRefName ?? "main",
    headRefOid: spec.headRefOid ?? "head0001",
    updatedAt: spec.updatedAt ?? "2026-03-01T10:00:00Z",
    comments: { totalCount: spec.comments ?? 0 },
    reviewThreads: { totalCount: spec.threads ?? 0 },
    reviews: {
      nodes:
        review === null
          ? []
          : [
              {
                fullDatabaseId: review.id,
                submittedAt: review.submittedAt,
                state: review.state,
                author: review.login === null ? null : { login: review.login },
              },
            ],
    },
    commits: {
      nodes: [
        {
          commit: {
            oid: spec.headRefOid ?? "head0001",
            author: { user: author === null ? null : { login: author } },
            statusCheckRollup:
              spec.rollup === undefined || spec.rollup === null ? null : { state: spec.rollup },
            ...(spec.suites === undefined
              ? {}
              : { checkSuites: suitesConnection(spec.suites, spec.suitesNext ?? null) }),
          },
        },
      ],
    },
  };
}

function row(spec: Partial<Row> = {}): Row {
  return {
    number: 1,
    url: "https://example.com/octocat/repo/pull/1",
    isDraft: false,
    state: "OPEN",
    mergedAt: null,
    baseRefName: "main",
    headRefOid: "head0001",
    headAuthor: "octocat",
    updatedAt: "2026-03-01T10:00:00Z",
    issueComments: 0,
    reviewThreads: 0,
    latestReview: null,
    rollupState: null,
    ...spec,
  };
}

/**
 * `at` is the publication instant; `created` (default: the same) is the draft's creation;
 * `review` is the fullDatabaseId of the review that published an inline comment.
 */
type CommentSpec = {
  id: number;
  at: string;
  created?: string;
  login: string | null;
  body: string;
  url: string;
  review?: string;
};

function commentNode(spec: CommentSpec): unknown {
  return {
    databaseId: spec.id,
    publishedAt: spec.at,
    createdAt: spec.created ?? spec.at,
    author: spec.login === null ? null : { login: spec.login },
    body: spec.body,
    url: spec.url,
    ...(spec.review === undefined ? {} : { pullRequestReview: { fullDatabaseId: spec.review } }),
  };
}

type ThreadSpec = {
  id?: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  total: number;
  comments: CommentSpec[];
  /** The startCursor of the fetched comments when the thread has older ones. */
  before?: string;
};

type ReviewSpec = {
  id: string;
  submittedAt: string | null;
  state: string;
  login: string;
  body: string;
  url: string;
};

/** A connection page as GitHub renders it; `before` is the startCursor when older nodes exist. */
function connection(nodes: unknown[], before?: string): unknown {
  return {
    nodes,
    pageInfo: { hasPreviousPage: before !== undefined, startCursor: before ?? null },
  };
}

function reviewNode(review: ReviewSpec): unknown {
  return {
    fullDatabaseId: review.id,
    submittedAt: review.submittedAt,
    state: review.state,
    author: { login: review.login },
    body: review.body,
    url: review.url,
  };
}

function detailPage(spec: {
  comments?: CommentSpec[];
  commentsBefore?: string;
  reviews?: ReviewSpec[];
  reviewsBefore?: string;
  threads: ThreadSpec[];
  nextCursor?: string | null;
}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          comments: connection((spec.comments ?? []).map(commentNode), spec.commentsBefore),
          reviews: connection((spec.reviews ?? []).map(reviewNode), spec.reviewsBefore),
          reviewThreads: {
            nodes: spec.threads.map((thread) => ({
              id: thread.id ?? `thread-${thread.path}`,
              isResolved: thread.isResolved,
              path: thread.path,
              line: thread.line,
              comments: {
                totalCount: thread.total,
                ...(connection(thread.comments.map(commentNode), thread.before) as object),
              },
            })),
            pageInfo: {
              hasNextPage: (spec.nextCursor ?? null) !== null,
              endCursor: spec.nextCursor ?? null,
            },
          },
        },
      },
    },
  });
}

/** An OlderComments or OlderReviews reply: the connection under the pull request. */
function olderPage(
  field: "comments" | "reviews",
  nodes: CommentSpec[] | ReviewSpec[],
  before?: string,
): string {
  const rendered =
    field === "comments"
      ? (nodes as CommentSpec[]).map(commentNode)
      : (nodes as ReviewSpec[]).map(reviewNode);
  return JSON.stringify({
    data: { repository: { pullRequest: { [field]: connection(rendered, before) } } },
  });
}

/** An OlderThreadComments reply: the connection under the thread node. */
function olderThreadPage(comments: CommentSpec[], before?: string): string {
  return JSON.stringify({
    data: { node: { comments: connection(comments.map(commentNode), before) } },
  });
}

// --- gh.mts ------------------------------------------------------------------

describe("gh", () => {
  const VIEWER = JSON.stringify({ data: { viewer: { login: "octocat" } } });
  const VIEWER_ARGS = ["api", "graphql", "-f", "query={ viewer { login } }"];

  test("a nonzero exit throws GhError carrying gh's stderr and the body gh still printed", () => {
    // gh exits 1 on a GraphQL reply with an `errors` entry while the body is on stdout; a wrapper
    // that dropped the body would make a deleted PR fail its whole batch (see readRows).
    const s = scenario({
      "viewer-1.json": VIEWER,
      "viewer-1.exit1": "gh: Could not resolve to a PullRequest with the number of 17.\n",
    });
    let caught: unknown;
    try {
      gh(VIEWER_ARGS);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(GhError);
    const error = caught as GhError;
    expect(error.message).toBe(
      "gh api graphql exited 1: gh: Could not resolve to a PullRequest with the number of 17.",
    );
    expect(error.stdout).toBe(VIEWER);
    expect(s.violations()).toBe("");
  });

  test("a reply past spawnSync's 1 MiB default buffer is read whole, never ENOBUFS", () => {
    // A detail page of 100 threads with three long comments each is a valid reply that large.
    const body = JSON.stringify({
      data: { viewer: { login: "octocat" } },
      pad: "x".repeat(1_200_000),
    });
    const s = scenario({ "viewer-1.json": body });
    expect(gh(VIEWER_ARGS)).toBe(body);
    expect(s.violations()).toBe("");
  });

  test("a call past its timeout throws GhError naming the timeout, never hangs", () => {
    // spawnSync reports the kill as an ETIMEDOUT error with a null status, not as a nonzero exit.
    const s = scenario({ "viewer-1.json": VIEWER, "viewer-1.sleep": "" });
    expect(() => gh(VIEWER_ARGS, 300)).toThrow(
      new GhError("gh api graphql: no answer within 300 ms"),
    );
    expect(s.violations()).toBe("");
  });

  test("gh missing from PATH throws GhError naming the tooling", () => {
    scenario({});
    const path = process.env.PATH;
    process.env.PATH = emptyBinDir;
    try {
      expect(() => gh(VIEWER_ARGS)).toThrow(new GhError("gh api graphql: gh not found on PATH"));
    } finally {
      process.env.PATH = path;
    }
  });
});

// --- github/check-suites.mts and targets/ci.mts ------------------------------

describe("discoverRuns", () => {
  test("external-app suites are not runs and GitHub's enums are lowercased: a CodeQL FAILURE is not judged", () => {
    // Judged, the two CodeQL-style suites (FAILURE, no workflowRun) would turn a green commit red.
    const s = scenario({
      "suites-1.json": suitesPage([{ id: 1 }, { external: true }, { id: 2 }, { external: true }]),
    });
    const runs = discoverRuns("octocat/repo", "deadbeef");
    expect(runs).toEqual([run({ id: 1 }), run({ id: 2 })]);
    expect(judgeHead("SUCCESS", runs, [])).toEqual({
      kind: "green",
      latest: [run({ id: 2 }), run({ id: 1 })],
    });
    expect(s.calls()).toHaveLength(1);
    expect(s.calls()[0]).toContain("-f owner=octocat -f name=repo -f oid=deadbeef");
    expect(s.violations()).toBe("");
  });

  test("an unknown SHA answers a null object: an empty snapshot, not an error", () => {
    const s = scenario({
      "suites-1.json": JSON.stringify({ data: { repository: { object: null } } }),
    });
    expect(discoverRuns("octocat/repo", "deadbeef")).toEqual([]);
    expect(s.violations()).toBe("");
  });

  test("a multi-page snapshot is read twice and judged only when both reads agree; a page-2 run is included", () => {
    // One page is one atomic read; two pages are not. Read 1 sees runs 1-2, run 3 (a failure)
    // registers before read 2, and read 3 confirms it. Judging read 1 would pass over the failure.
    const page1 = suitesPage([{ id: 1 }], "page2");
    const s = scenario({
      "suites-1.json": page1,
      "suites-2.json": suitesPage([{ id: 2 }]),
      "suites-3.json": page1,
      "suites-4.json": suitesPage([{ id: 2 }, { id: 3, conclusion: "failure" }]),
      "suites-5.json": page1,
      "suites-6.json": suitesPage([{ id: 2 }, { id: 3, conclusion: "failure" }]),
    });
    expect(discoverRuns("octocat/repo", "deadbeef")).toEqual([
      run({ id: 1 }),
      run({ id: 2 }),
      run({ id: 3, conclusion: "failure" }),
    ]);
    const calls = s.calls();
    expect(calls).toHaveLength(6);
    expect(calls.map((call) => call.includes("-f cursor=page2"))).toEqual([
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(s.violations()).toBe("");
  });

  test("a gh failure after a first page throws, never a partial run list", () => {
    const s = scenario({ "suites-1.json": suitesPage([{ id: 1 }], "page2"), "suites-2.fail": "" });
    expect(() => discoverRuns("octocat/repo", "deadbeef")).toThrow(
      new GhError("gh api graphql exited 1: gh: boom"),
    );
    expect(s.violations()).toBe("");
  });

  test("a multi-page snapshot changing on every read is refused after 5 rounds, never judged", () => {
    const fixtures: Record<string, string> = {};
    for (let call = 1; call <= 10; call += 1) {
      fixtures[`suites-${call}.json`] =
        call % 2 === 1
          ? suitesPage([{ id: 1 }], "page2")
          : suitesPage(call % 4 === 2 ? [{ id: 2 }] : [{ id: 2 }, { id: 3 }]);
    }
    const s = scenario(fixtures);
    expect(() => discoverRuns("octocat/repo", "deadbeef")).toThrow(
      "kept changing across 5 multi-page reads; refusing to judge a partial snapshot",
    );
    expect(s.calls()).toHaveLength(10);
    expect(s.violations()).toBe("");
  });

  test("check suites spanning more than 10 pages are refused, never judged partially", () => {
    const fixtures: Record<string, string> = {};
    for (let page = 1; page <= 11; page += 1) {
      fixtures[`suites-${page}.json`] = suitesPage([{ id: page }], `page${page + 1}`);
    }
    const s = scenario(fixtures);
    expect(() => discoverRuns("octocat/repo", "deadbeef")).toThrow(
      "span more than 10 pages of 100; refusing to judge a partial snapshot",
    );
    expect(s.calls()).toHaveLength(10);
    expect(s.violations()).toBe("");
  });
});

describe("parseSuites", () => {
  test("a connection with more pages is incomplete and carries the cursor; a null connection is an empty complete page", () => {
    expect(parseSuites(suitesConnection([{ id: 1 }], "page2"))).toEqual({
      runs: [run({ id: 1 })],
      complete: false,
      nextCursor: "page2",
    });
    expect(parseSuites(null)).toEqual({ runs: [], complete: true, nextCursor: null });
  });
});

describe("judgeHead", () => {
  // With no gate named the aggregate rollup decides; with gates, their latest runs do, and the
  // rollup only says when a gate that never registered is missing rather than late.
  const sameWorkflow = { wf: 77, name: "CI" };
  const cases: {
    id: string;
    rollup: string | null;
    runs: Run[];
    gates: string[];
    verdict: ReturnType<typeof judgeHead>;
  }[] = [
    {
      id: "no gate: rollup SUCCESS is green, the latest runs counted newest first",
      rollup: "SUCCESS",
      runs: [run({ id: 1 }), run({ id: 2 })],
      gates: [],
      verdict: { kind: "green", latest: [run({ id: 2 }), run({ id: 1 })] },
    },
    {
      id: "no gate: rollup FAILURE is red naming the failed latest runs",
      rollup: "FAILURE",
      runs: [run({ id: 1, conclusion: "failure" }), run({ id: 2 })],
      gates: [],
      verdict: {
        kind: "red",
        latest: [run({ id: 2 }), run({ id: 1, conclusion: "failure" })],
        failed: [run({ id: 1, conclusion: "failure" })],
        missing: [],
      },
    },
    {
      id: "no gate: rollup ERROR is red even when no Actions run failed (a check outside Actions did)",
      rollup: "ERROR",
      runs: [run({ id: 1 })],
      gates: [],
      verdict: { kind: "red", latest: [run({ id: 1 })], failed: [], missing: [] },
    },
    {
      id: "no gate: no rollup is no CI whatever the runs say, so nothing is pending or said",
      rollup: null,
      runs: [run({ id: 1 })],
      gates: [],
      verdict: { kind: "none" },
    },
    {
      id: "a gate's failed latest run is red at once, while another gate runs and the rollup is pending",
      rollup: "PENDING",
      runs: [
        run({ id: 1, conclusion: "failure", name: "Gate" }),
        run({ id: 2, status: "in_progress", name: "Other" }),
      ],
      gates: ["Gate", "Other"],
      verdict: {
        kind: "red",
        latest: [
          run({ id: 2, status: "in_progress", name: "Other" }),
          run({ id: 1, conclusion: "failure", name: "Gate" }),
        ],
        failed: [run({ id: 1, conclusion: "failure", name: "Gate" })],
        missing: [],
      },
    },
    {
      id: "a failed gate beside one with no run once the rollup settled: red, naming the absent gate so the red does not hide it",
      rollup: "FAILURE",
      runs: [run({ id: 1, conclusion: "failure", name: "Gate" })],
      gates: ["Gate", "MissingGate"],
      verdict: {
        kind: "red",
        latest: [run({ id: 1, conclusion: "failure", name: "Gate" })],
        failed: [run({ id: 1, conclusion: "failure", name: "Gate" })],
        missing: ["MissingGate"],
      },
    },
    {
      id: "two workflow files sharing a gate's name are both that gate: one failed is red, never a green by the other",
      rollup: "FAILURE",
      runs: [
        run({ id: 1, conclusion: "failure", wf: 101, name: "checks" }),
        run({ id: 2, wf: 102, name: "checks" }),
      ],
      gates: ["checks"],
      verdict: {
        kind: "red",
        latest: [
          run({ id: 2, wf: 102, name: "checks" }),
          run({ id: 1, conclusion: "failure", wf: 101, name: "checks" }),
        ],
        failed: [run({ id: 1, conclusion: "failure", wf: 101, name: "checks" })],
        missing: [],
      },
    },
    {
      id: "a gate still running is pending even when the rollup already reads SUCCESS",
      rollup: "SUCCESS",
      runs: [run({ id: 1, status: "in_progress", name: "Gate" })],
      gates: ["Gate"],
      verdict: { kind: "pending" },
    },
    {
      id: "every gate passed is green; a bystander's failure is not judged",
      rollup: "FAILURE",
      runs: [run({ id: 1, name: "Gate" }), run({ id: 2, conclusion: "failure", name: "Other" })],
      gates: ["Gate"],
      verdict: {
        kind: "green",
        latest: [
          run({ id: 2, conclusion: "failure", name: "Other" }),
          run({ id: 1, name: "Gate" }),
        ],
      },
    },
    {
      id: "a gate with no run is pending while the rollup is pending: it can still register",
      rollup: "PENDING",
      runs: [run({ id: 1, name: "Other" })],
      gates: ["Gate"],
      verdict: { kind: "pending" },
    },
    {
      id: "a gate with no run once the rollup settled is missing, by name",
      rollup: "SUCCESS",
      runs: [run({ id: 1, name: "Other" })],
      gates: ["Gate", "Other"],
      verdict: { kind: "missing", gates: ["Gate"], settled: true },
    },
    {
      id: "an older cancelled run of a re-triggered workflow is superseded, not red (numeric newest pick)",
      rollup: "PENDING",
      runs: [
        run({ id: 9, conclusion: "cancelled", ...sameWorkflow }),
        run({ id: 100, ...sameWorkflow }),
      ],
      gates: ["CI"],
      verdict: { kind: "green", latest: [run({ id: 100, ...sameWorkflow })] },
    },
    {
      id: "a cancelled latest run with no newer run is red: no verdict was ever delivered",
      rollup: "PENDING",
      runs: [run({ id: 1, conclusion: "cancelled", name: "CI" })],
      gates: ["CI"],
      verdict: {
        kind: "red",
        latest: [run({ id: 1, conclusion: "cancelled", name: "CI" })],
        failed: [run({ id: 1, conclusion: "cancelled", name: "CI" })],
        missing: [],
      },
    },
    {
      id: "a skipped gate counts as passed",
      rollup: "SUCCESS",
      runs: [run({ id: 1, conclusion: "skipped", name: "CI" })],
      gates: ["CI"],
      verdict: { kind: "green", latest: [run({ id: 1, conclusion: "skipped", name: "CI" })] },
    },
    {
      id: "gate names match exactly, never by prefix",
      rollup: "SUCCESS",
      runs: [run({ id: 1, name: "CI-1" })],
      gates: ["CI"],
      verdict: { kind: "missing", gates: ["CI"], settled: true },
    },
    {
      id: "a gate completed with no conclusion is pending, never green or red",
      rollup: "SUCCESS",
      runs: [run({ id: 1, conclusion: null, name: "CI" })],
      gates: ["CI"],
      verdict: { kind: "pending" },
    },
  ];
  test.each(cases)("$id", (c) => {
    expect(judgeHead(c.rollup, c.runs, c.gates), c.id).toEqual(c.verdict);
  });

  test("a verdict's key tells a red that found a gate absent from a plain red, and either from pending", () => {
    const failed = run({ id: 1, conclusion: "failure", name: "Gate" });
    expect(verdictKey(judgeHead("PENDING", [failed], ["Gate", "Lint"]))).toBe("red");
    expect(verdictKey(judgeHead("FAILURE", [failed], ["Gate", "Lint"]))).toBe(
      "red; no run of Lint",
    );
    expect(verdictKey(judgeHead("SUCCESS", [], ["Lint"]))).toBe("missing Lint");
    expect(verdictKey(judgeHead("PENDING", [], ["Lint"]))).toBeNull();
    expect(verdictKey(judgeHead("SUCCESS", [run({ id: 2 })], []))).toBe("green");
  });
});

describe("describeVerdict", () => {
  test("a red names every failed run: a workflow the jobs read returns no row for is named after another's job rows, never dropped, even when the two share a name", () => {
    const s = scenario({
      "jobs-1.json": JSON.stringify({
        data: {
          nodes: [
            {
              id: "S1",
              checkRuns: {
                nodes: [
                  {
                    name: "check",
                    steps: {
                      nodes: [
                        { name: "Checkout", conclusion: "SUCCESS" },
                        { name: "Run tests", conclusion: "FAILURE" },
                      ],
                    },
                  },
                ],
              },
            },
            { id: "S2", checkRuns: { nodes: [] } },
          ],
        },
      }),
    });
    const checks = run({ id: 1, conclusion: "failure", name: "checks" });
    const cleanup = run({ id: 2, conclusion: "stale", name: "cleanup" });
    const said = describeVerdict(
      "PR octocat/repo#7",
      "deadbeef".repeat(5),
      judgeHead("FAILURE", [checks, cleanup], []),
      "https://github.com/octocat/repo/pull/7/checks",
      () => {},
    );
    expect(said?.text).toBe(
      "PR octocat/repo#7: CI red on deadbeefdead: checks / check / Run tests, cleanup",
    );
    // Two workflow files named alike: the run with no job row is told from the other by suite.
    const twin = run({ id: 2, conclusion: "stale", name: "checks", wf: 102 });
    const alike = describeVerdict(
      "PR octocat/repo#7",
      "deadbeef".repeat(5),
      judgeHead(
        "FAILURE",
        [run({ id: 1, conclusion: "failure", name: "checks", wf: 101 }), twin],
        [],
      ),
      "https://github.com/octocat/repo/pull/7/checks",
      () => {},
    );
    expect(alike?.text).toBe(
      "PR octocat/repo#7: CI red on deadbeefdead: checks / check / Run tests, checks",
    );
    expect(s.violations()).toBe("");
  });
});

describe("readRepository", () => {
  const PENDING_SUITE: SuiteSpec = { id: 5, status: "in_progress" };

  test("one request carries the rows, the branch tips, the suites of the heads still being judged, and the viewer; 31 PRs go as two chunks; a null PR is null while its batch survives gh's exit 1", () => {
    // PR 17 is deleted: GitHub answers null for it with an `errors` entry, on which gh exits 1
    // with the body still on stdout. A batch that failed on that exit would blind 30 PRs for one
    // deletion. Only PR 1 and the main tip are pending, so only they carry their suites.
    const r: Record<string, unknown> = {};
    for (let n = 1; n <= 30; n += 1) {
      r[`p${n}`] =
        n === 17 ? null : prNode({ number: n, suites: n === 1 ? [{ id: 1 }] : undefined });
    }
    r.b0 = {
      target: {
        oid: "tip00001",
        author: { user: { login: "hubot" } },
        statusCheckRollup: { state: "PENDING" },
        checkSuites: suitesConnection([PENDING_SUITE]),
      },
    };
    r.b1 = null;
    const s = scenario({
      "rows-1.json": JSON.stringify({
        data: { viewer: { login: "me" }, r },
        errors: [
          {
            type: "NOT_FOUND",
            message: "Could not resolve to a PullRequest with the number of 17.",
          },
        ],
      }),
      "rows-1.exit1": "gh: Could not resolve to a PullRequest with the number of 17.\n",
      "rows-2.json": JSON.stringify({
        data: {
          r: {
            p31: prNode({
              number: 31,
              author: null,
              review: { id: "901", submittedAt: null, state: "PENDING", login: null },
            }),
          },
        },
      }),
    });
    const reply = readRepository("octocat/repo", {
      prs: Array.from({ length: 31 }, (_, i) => i + 1),
      branches: ["main", "gone"],
      suitesFor: { prs: new Set([1]), branches: new Set(["main"]) },
    });
    expect(reply.viewer).toBe("me");
    expect(reply.rows.size).toBe(31);
    expect(reply.rows.get(17)).toBeNull();
    expect(reply.rows.get(1)).toEqual({
      row: row({ number: 1 }),
      suites: { runs: [run({ id: 1 })], complete: true, nextCursor: null },
    });
    expect(reply.rows.get(2)).toEqual({
      row: row({ number: 2, url: "https://example.com/octocat/repo/pull/2" }),
      suites: null,
    });
    // A deleted account nulls the author; a PENDING review has no submittedAt.
    expect(reply.rows.get(31)?.row).toMatchObject({
      headAuthor: null,
      latestReview: { id: "901", submittedAt: "unsubmitted", state: "PENDING", author: "ghost" },
    });
    expect(reply.tips.get("main")).toEqual({
      tip: { oid: "tip00001", author: "hubot", rollupState: "PENDING" },
      suites: { runs: [run(PENDING_SUITE)], complete: true, nextCursor: null },
    });
    expect(reply.tips.get("gone")).toBeNull();
    const calls = s.calls();
    expect(calls).toHaveLength(2);
    const first = calls[0] as string;
    expect(first).toContain("viewer { login }");
    expect(first).toContain('r: repository(owner: "octocat", name: "repo")');
    expect(first).toContain("p17: pullRequest(number: 17)");
    expect(first).toContain('b0: ref(qualifiedName: "refs/heads/main")');
    expect(first).toContain('b1: ref(qualifiedName: "refs/heads/gone")');
    expect(first.split("checkSuites(first: 100)")).toHaveLength(3);
    expect(calls[1]).toContain("p31: pullRequest(number: 31)");
    expect(calls[1]).not.toContain("viewer");
    expect(calls[1]).not.toContain("ref(");
    expect(s.violations()).toBe("");
  });

  test("a head with more than one page of suites is marked incomplete, for the paged read to follow", () => {
    const s = scenario({
      "rows-1.json": JSON.stringify({
        data: { r: { p1: prNode({ suites: [{ id: 1 }], suitesNext: "page2" }) } },
      }),
    });
    const reply = readRepository("octocat/repo", {
      prs: [1],
      branches: [],
      suitesFor: { prs: new Set([1]), branches: new Set() },
    });
    expect(reply.rows.get(1)?.suites).toEqual({
      runs: [run({ id: 1 })],
      complete: false,
      nextCursor: "page2",
    });
    expect(reply.viewer).toBeNull();
    expect(s.violations()).toBe("");
  });

  test("a repository that answers null is the failed read it is, carrying gh's own error, never a batch of unreadable targets", () => {
    // An error at the repository's path (gone, no access, or GitHub's own) nulls the alias with
    // the viewer still answered; read as every target unreadable, a transient error would end
    // every watch on the repository with a trouble event each.
    const s = scenario({
      "rows-1.json": JSON.stringify({
        data: { viewer: { login: "me" }, r: null },
        errors: [{ type: "INTERNAL", path: ["r"], message: "Something went wrong" }],
      }),
      "rows-1.exit1": "gh: Something went wrong\n",
    });
    expect(() =>
      readRepository("octocat/gone", {
        prs: [1, 2],
        branches: ["main"],
        suitesFor: { prs: new Set(), branches: new Set() },
      }),
    ).toThrow(new GhError("gh api graphql exited 1: gh: Something went wrong"));
    expect(s.violations()).toBe("");
  });

  test("an error other than NOT_FOUND at a PR's alias is the failed read it is, never a deleted target", () => {
    // GitHub nulls the alias for an INTERNAL or RATE_LIMITED error as it does for a deleted PR;
    // read as deleted, a transient error would end the watch with the wrong word.
    const s = scenario({
      "rows-1.json": JSON.stringify({
        data: { viewer: { login: "me" }, r: { p1: prNode(), p7: null } },
        errors: [{ type: "INTERNAL", path: ["r", "p7"], message: "Something went wrong" }],
      }),
      "rows-1.exit1": "gh: Something went wrong\n",
    });
    expect(() =>
      readRepository("octocat/repo", {
        prs: [1, 7],
        branches: [],
        suitesFor: { prs: new Set(), branches: new Set() },
      }),
    ).toThrow(new GhError("gh api graphql exited 1: gh: Something went wrong"));
    expect(s.violations()).toBe("");
  });

  test("a failed request with no data is the gh failure it looks like, not a map of absent PRs", () => {
    // A rate-limited reply carries errors and no data; reading it as "every PR null" would name
    // the PRs instead of the limit.
    const s = scenario({
      "rows-1.json": JSON.stringify({
        errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
      }),
      "rows-1.exit1": "gh: API rate limit exceeded\n",
    });
    expect(() =>
      readRepository("octocat/repo", {
        prs: [1],
        branches: [],
        suitesFor: { prs: new Set(), branches: new Set() },
      }),
    ).toThrow(new GhError("gh api graphql exited 1: gh: API rate limit exceeded"));
    expect(s.violations()).toBe("");
  });
});

describe("rowChanged", () => {
  const base = row({
    latestReview: {
      id: "900",
      submittedAt: "2026-03-01T09:00:00Z",
      state: "APPROVED",
      author: "work-bot",
    },
    rollupState: "PENDING",
  });
  const none = { activity: false, head: false, rollup: false, state: false };
  // Each row changes one field; a diff that compared the wrong field would flip another column.
  const cases: {
    id: string;
    previous: Row | undefined;
    current: Row;
    changed: ReturnType<typeof rowChanged>;
  }[] = [
    {
      id: "a first sighting is a baseline: everything but activity reads as changed",
      previous: undefined,
      current: base,
      changed: { activity: false, head: true, rollup: true, state: true },
    },
    { id: "an identical row changes nothing", previous: base, current: { ...base }, changed: none },
    {
      id: "updatedAt alone is activity",
      previous: base,
      current: { ...base, updatedAt: "2026-03-01T10:00:01Z" },
      changed: { ...none, activity: true },
    },
    {
      id: "an issue comment is activity",
      previous: base,
      current: { ...base, issueComments: 1 },
      changed: { ...none, activity: true },
    },
    {
      id: "a review thread is activity",
      previous: base,
      current: { ...base, reviewThreads: 1 },
      changed: { ...none, activity: true },
    },
    {
      id: "a dismissed review keeps its id: the state change is activity",
      previous: base,
      current: {
        ...base,
        latestReview: {
          ...(base.latestReview as NonNullable<Row["latestReview"]>),
          state: "DISMISSED",
        },
      },
      changed: { ...none, activity: true },
    },
    {
      id: "a first review is activity",
      previous: { ...base, latestReview: null },
      current: base,
      changed: { ...none, activity: true },
    },
    {
      id: "a new head is head alone",
      previous: base,
      current: { ...base, headRefOid: "head0002" },
      changed: { ...none, head: true },
    },
    {
      id: "a rollup state move is rollup alone",
      previous: base,
      current: { ...base, rollupState: "FAILURE" },
      changed: { ...none, rollup: true },
    },
    {
      id: "a merge is state alone",
      previous: base,
      current: { ...base, state: "MERGED" },
      changed: { ...none, state: true },
    },
  ];
  test.each(cases)("$id", (c) => {
    expect(rowChanged(c.previous, c.current), c.id).toEqual(c.changed);
  });
});

// --- github/pr-activity.mts --------------------------------------------------

describe("readPrDetail", () => {
  test("threads are paged past the first page, unresolved counts sum across pages, and a thread's first comment is told from a reply by position", () => {
    // Thread B is five comments long and the query fetches its last three: all replies, drafted
    // at 09:50 and published when review 2 was submitted, so their activity instant is the
    // publication and they name that review. Thread C on page 2 is two long and fully fetched: a
    // review-comment then a reply. The empty-bodied COMMENTED review 2 is activity, for the
    // renderer to headline its inline comments under; the unsubmitted PENDING review is not. The
    // issue comments and reviews come from the first page only.
    const s = scenario({
      "detail-1.json": detailPage({
        comments: [
          {
            id: 1,
            at: "2026-03-01T10:05:00Z",
            login: "work-bot",
            body: "ping",
            url: "https://example.com/c1",
          },
          {
            id: 2,
            at: "2026-03-01T10:06:00Z",
            login: null,
            body: "gone",
            url: "https://example.com/c2",
          },
        ],
        reviews: [
          {
            id: "1",
            submittedAt: "2026-03-01T10:07:00Z",
            state: "APPROVED",
            login: "work-bot",
            body: "LGTM",
            url: "https://example.com/r1",
          },
          {
            id: "2",
            submittedAt: "2026-03-01T10:08:00Z",
            state: "COMMENTED",
            login: "work-bot",
            body: "",
            url: "https://example.com/r2",
          },
          {
            id: "3",
            submittedAt: null,
            state: "PENDING",
            login: "octocat",
            body: "draft",
            url: "https://example.com/r3",
          },
        ],
        threads: [
          {
            isResolved: true,
            path: "src/a.ts",
            line: 12,
            total: 1,
            comments: [
              {
                id: 11,
                at: "2026-03-01T10:01:00Z",
                login: "work-bot",
                body: "nit",
                url: "https://example.com/t1-1",
              },
            ],
          },
          {
            isResolved: false,
            path: "src/b.ts",
            line: null,
            total: 5,
            comments: [
              {
                id: 23,
                at: "2026-03-01T10:02:00Z",
                created: "2026-03-01T09:50:00Z",
                login: "work-bot",
                body: "three",
                url: "https://example.com/t2-3",
                review: "2",
              },
              {
                id: 24,
                at: "2026-03-01T10:03:00Z",
                created: "2026-03-01T09:50:30Z",
                login: "octocat",
                body: "four",
                url: "https://example.com/t2-4",
                review: "2",
              },
              {
                id: 25,
                at: "2026-03-01T10:04:00Z",
                created: "2026-03-01T09:51:00Z",
                login: "work-bot",
                body: "five",
                url: "https://example.com/t2-5",
                review: "2",
              },
            ],
          },
        ],
        nextCursor: "c1",
      }),
      "detail-2.json": detailPage({
        comments: [
          {
            id: 9,
            at: "2026-03-01T10:09:00Z",
            login: "work-bot",
            body: "page-2 noise",
            url: "https://example.com/c9",
          },
        ],
        threads: [
          {
            isResolved: false,
            path: "src/c.ts",
            line: 3,
            total: 2,
            comments: [
              {
                id: 31,
                at: "2026-03-01T10:10:00Z",
                login: "work-bot",
                body: "first",
                url: "https://example.com/t3-1",
              },
              {
                id: 32,
                at: "2026-03-01T10:11:00Z",
                login: "octocat",
                body: "second",
                url: "https://example.com/t3-2",
              },
            ],
          },
        ],
      }),
    });
    const detail = readPrDetail({ repo: "octocat/repo", number: 7 }, null);
    const expected: Activity[] = [
      {
        id: "review-comment:11",
        kind: "review-comment",
        at: "2026-03-01T10:01:00Z",
        author: "work-bot",
        hasBody: true,
        url: "https://example.com/t1-1",
        path: "src/a.ts",
        line: 12,
      },
      {
        id: "review-comment:23",
        kind: "reply",
        at: "2026-03-01T10:02:00Z",
        author: "work-bot",
        hasBody: true,
        url: "https://example.com/t2-3",
        path: "src/b.ts",
        line: null,
        reviewId: "review:2",
      },
      {
        id: "review-comment:24",
        kind: "reply",
        at: "2026-03-01T10:03:00Z",
        author: "octocat",
        hasBody: true,
        url: "https://example.com/t2-4",
        path: "src/b.ts",
        line: null,
        reviewId: "review:2",
      },
      {
        id: "review-comment:25",
        kind: "reply",
        at: "2026-03-01T10:04:00Z",
        author: "work-bot",
        hasBody: true,
        url: "https://example.com/t2-5",
        path: "src/b.ts",
        line: null,
        reviewId: "review:2",
      },
      {
        id: "review-comment:31",
        kind: "review-comment",
        at: "2026-03-01T10:10:00Z",
        author: "work-bot",
        hasBody: true,
        url: "https://example.com/t3-1",
        path: "src/c.ts",
        line: 3,
      },
      {
        id: "review-comment:32",
        kind: "reply",
        at: "2026-03-01T10:11:00Z",
        author: "octocat",
        hasBody: true,
        url: "https://example.com/t3-2",
        path: "src/c.ts",
        line: 3,
      },
      {
        id: "comment:1",
        kind: "comment",
        at: "2026-03-01T10:05:00Z",
        author: "work-bot",
        hasBody: true,
        url: "https://example.com/c1",
      },
      {
        id: "comment:2",
        kind: "comment",
        at: "2026-03-01T10:06:00Z",
        author: "ghost",
        hasBody: true,
        url: "https://example.com/c2",
      },
      {
        id: "review:1",
        kind: "review",
        at: "2026-03-01T10:07:00Z",
        author: "work-bot",
        hasBody: true,
        url: "https://example.com/r1",
        reviewState: "APPROVED",
      },
      {
        id: "review:2",
        kind: "review",
        at: "2026-03-01T10:08:00Z",
        author: "work-bot",
        hasBody: false,
        url: "https://example.com/r2",
        reviewState: "COMMENTED",
      },
    ];
    expect(detail).toEqual({
      unresolvedThreads: 2,
      activities: expected,
      fetchedIds: [
        "review-comment:11",
        "review-comment:23",
        "review-comment:24",
        "review-comment:25",
        "review-comment:31",
        "review-comment:32",
        "comment:1",
        "comment:2",
        "review:1",
        "review:2",
        "review:3",
      ],
      gaps: [],
    });
    const calls = s.calls();
    expect(calls).toHaveLength(2);
    expect(
      calls.map((call) => call.endsWith("-f owner=octocat -f name=repo -F number=7 -f cursor=c1")),
    ).toEqual([false, true]);
    expect(s.violations()).toBe("");
  });

  test("a null pullRequest is an error naming the likely cause", () => {
    const s = scenario({
      "detail-1.json": JSON.stringify({ data: { repository: { pullRequest: null } } }),
    });
    expect(() => readPrDetail({ repo: "octocat/repo", number: 7 }, null)).toThrow(
      new GhError("GraphQL response has no pullRequest (wrong repo or PR number?)"),
    );
    expect(s.violations()).toBe("");
  });

  const PR7 = { repo: "octocat/repo", number: 7 };
  const comment = (id: number, minute: number, body = `c${id}`): CommentSpec => ({
    id,
    at: `2026-03-01T10:${String(minute).padStart(2, "0")}:00Z`,
    login: "work-bot",
    body,
    url: `https://example.com/c${id}`,
  });
  const review = (id: string, minute: number): ReviewSpec => ({
    id,
    submittedAt: `2026-03-01T10:${String(minute).padStart(2, "0")}:00Z`,
    state: "APPROVED",
    login: "work-bot",
    body: `r${id}`,
    url: `https://example.com/r${id}`,
  });

  test("each connection pages back from the newest to the newest reported id: 21 missed comments and a 5-reply thread arrive whole, what is older than that id on the stopping page does not, and the reviews stop at their first page", () => {
    // The fixed windows (comments last 20, thread comments last 3) are what the daemon reads on
    // every poll; after a stop that missed 21 comments, the 21st oldest is beyond the window and
    // would never be reported. A thread's back page is wider than its window, so the stopping
    // page carries the thread's first comment from before the baseline; the seen set (two reads'
    // windows) has never held it, and kept it would come back as new. The reviews page carries
    // a reported id, so it is not paged.
    const missed = Array.from({ length: 21 }, (_, i) => comment(101 + i, 10 + i));
    const replies = Array.from({ length: 5 }, (_, i) => comment(201 + i, 40 + i, `t${201 + i}`));
    const s = scenario({
      "detail-1.json": detailPage({
        comments: missed.slice(1),
        commentsBefore: "c102",
        reviews: [review("1", 1), review("2", 2)],
        reviewsBefore: "r1",
        threads: [
          {
            id: "T1",
            isResolved: false,
            path: "src/a.ts",
            line: 3,
            total: 7,
            comments: replies.slice(2),
            before: "t203",
          },
        ],
      }),
      "older-comments-1.json": olderPage("comments", [comment(100, 9), missed[0] as CommentSpec]),
      "older-thread-1.json": olderThreadPage([
        comment(190, 30, "t190"),
        comment(200, 39, "t200"),
        ...replies.slice(0, 2),
      ]),
    });
    const seen = new Set(["comment:100", "review:1", "review-comment:200"]);
    const detail = readPrDetail(PR7, seen);
    expect(detail.gaps).toEqual([]);
    expect(detail.activities.map((activity) => activity.id)).toEqual([
      "review-comment:200",
      ...replies.map((reply) => `review-comment:${reply.id}`),
      "comment:100",
      ...missed.map((c) => `comment:${c.id}`),
      "review:1",
      "review:2",
    ]);
    expect(detail.activities.map((activity) => activity.kind).slice(0, 2)).toEqual([
      "reply",
      "reply",
    ]);
    expect(detail.fetchedIds).toContain("review-comment:190");
    const calls = s.calls();
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain("query OlderThreadComments(");
    expect(calls[1]).toContain("-f id=T1 -f cursor=t203");
    expect(calls[2]).toContain("query OlderComments(");
    expect(calls[2]).toContain("-f owner=octocat -f name=repo -F number=7 -f cursor=c102");
    expect(s.violations()).toBe("");
  });

  test("a connection with no reported id after 10 pages stops with a gap line, never silently; a first sighting pages nothing", () => {
    // Without the cap a PR with thousands of comments would be read whole on every restart; without
    // the gap line the oldest missed comments would be dropped without a word.
    const fixtures: Record<string, string> = {
      "detail-1.json": detailPage({
        comments: [comment(300, 30)],
        commentsBefore: "c300",
        threads: [],
      }),
    };
    for (let page = 1; page <= 9; page += 1) {
      fixtures[`older-comments-${page}.json`] = olderPage(
        "comments",
        [comment(300 - page, 30 - page)],
        `c${300 - page}`,
      );
    }
    const s = scenario(fixtures);
    const detail = readPrDetail(PR7, new Set(["comment:1"]));
    expect(detail.gaps).toEqual([
      "issue comments: more than 10 pages since the last one reported; the older ones are not reported",
    ]);
    expect(detail.activities.map((activity) => activity.id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `comment:${291 + i}`),
    );
    expect(s.calls()).toHaveLength(10);
    expect(readPrDetail(PR7, null).gaps).toEqual([]);
    expect(s.calls()).toHaveLength(11);
    expect(s.violations()).toBe("");
  });
});

describe("newActivity", () => {
  const activity = (id: string, at: string, author: string): Activity => ({
    id,
    kind: "comment",
    at,
    author,
    hasBody: false,
    url: "https://example.com/c",
  });

  test("news is an unseen id, never a later instant: a same-second comment is new, a seen later one is not; the viewer's own are dropped; oldest first", () => {
    // GitHub's timestamps have one-second grain. Judged by instant against a 10:00:00 watermark,
    // comment 5 (published in that same second) would never be reported, and comment 1 (read
    // ahead of its row last time) would be reported again.
    const detail = {
      unresolvedThreads: 0,
      fetchedIds: [],
      gaps: [],
      activities: [
        activity("comment:1", "2026-03-01T10:00:02Z", "work-bot"),
        activity("comment:2", "2026-03-01T10:00:00Z", "octocat"),
        activity("comment:3", "2026-03-01T10:00:00Z", "work-bot"),
        activity("comment:4", "2026-03-01T09:59:59Z", "work-bot"),
        activity("comment:5", "2026-03-01T10:00:00Z", "example-user"),
        activity("comment:6", "2026-03-01T10:00:01Z", "octocat"),
      ],
    };
    const seen = new Set(["comment:1", "comment:2", "comment:3", "comment:4"]);
    expect(newActivity(detail, seen, "octocat")).toEqual([
      activity("comment:5", "2026-03-01T10:00:00Z", "example-user"),
    ]);
    expect(newActivity(detail, new Set(), "octocat")).toEqual([
      activity("comment:4", "2026-03-01T09:59:59Z", "work-bot"),
      activity("comment:3", "2026-03-01T10:00:00Z", "work-bot"),
      activity("comment:5", "2026-03-01T10:00:00Z", "example-user"),
      activity("comment:1", "2026-03-01T10:00:02Z", "work-bot"),
    ]);
  });
});
