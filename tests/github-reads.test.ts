import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  discoverRuns,
  failedJobLog,
  judgeRuns,
  type Run,
} from "../skills/watch-prs-and-ci/scripts/check-suites.mts";
import { GhError, gh } from "../skills/watch-prs-and-ci/scripts/gh.mts";
import {
  type Activity,
  newActivity,
  readPrDetail,
  viewerLogin,
} from "../skills/watch-prs-and-ci/scripts/pr-detail.mts";
import {
  type PrRef,
  type Row,
  readRows,
  rowChanged,
} from "../skills/watch-prs-and-ci/scripts/pr-rows.mts";
import { tempDirs } from "./helpers/temp-dirs";

// Contract tests for the GitHub read modules: a fake `gh` on PATH validates the exact invocation
// it receives, serves hand-written GitHub-shaped JSON (uppercase enums, external suites, null
// PRs), and records every Actions REST call other than `run view <id> --log-failed` as a
// violation, since the modules must never reach those endpoints. Each test names what would
// drift silently without it. The reply is the raw body GitHub would send, so the modules' own
// parsing is under test.
//   <kind>-<n>.json   the body for call n of that kind (the last lower n serves when n is absent)
//   <kind>-<n>.fail   call n dies with no body, like a network failure
//   <kind>-<n>.exit1  call n prints its body, then this file to stderr, and exits 1: gh's
//                     behavior on a reply carrying an `errors` entry
//   <kind>-<n>.sleep  call n answers late
//   log-<id>.txt      the merged --log-failed stream for run <id> (.stderr, .exit alongside)
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
  query=""; owner=""; name=""; oid=""; number=""; cursor=""
  while [ "$#" -gt 0 ]; do
    case "$1 $2" in
      "-f query="*) query="\${2#query=}";;
      "-f owner="*) owner="\${2#owner=}";;
      "-f name="*) name="\${2#name=}";;
      "-f oid="*) oid="\${2#oid=}";;
      "-f cursor="*) cursor="\${2#cursor=}";;
      "-F number="*) number="\${2#number=}";;
      *) violate "graphql arg: $1 $2"; exit 64;;
    esac
    shift 2
  done
  case "$query" in
    *'checkSuites('*)
      [ "$owner/$name/$oid/$number" = "octocat/repo/deadbeef/" ] || { violate "suites target: $owner/$name/$oid/$number"; exit 64; }
      serve suites "$(next suites)";;
    *'reviewThreads(first:'*)
      [ "$owner/$name/$oid/$number" = "octocat/repo//7" ] || { violate "detail target: $owner/$name/$oid/$number"; exit 64; }
      serve detail "$(next detail)";;
    *'pullRequest(number:'*)
      [ -z "$owner$name$oid$number$cursor" ] || { violate "rows query must inline its targets: $owner/$name/$oid/$number/$cursor"; exit 64; }
      serve rows "$(next rows)";;
    *viewer*)
      serve viewer "$(next viewer)";;
    *) violate "graphql query: $query"; exit 64;;
  esac
fi
if [ "$*" = "run view $3 --log-failed --repo octocat/repo" ]; then
  [ ! -f "\${STUB_DIR}/log-$3.txt" ] || cat "\${STUB_DIR}/log-$3.txt"
  [ ! -f "\${STUB_DIR}/log-$3.sleep" ] || sleep 5
  [ ! -f "\${STUB_DIR}/log-$3.stderr" ] || cat "\${STUB_DIR}/log-$3.stderr" >&2
  exit "$(cat "\${STUB_DIR}/log-$3.exit" 2>/dev/null || echo 0)"
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
  } catch {
    return fallback;
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

/** A checkSuites page as GitHub renders it: uppercase enums, a null workflowRun on external suites. */
function suitesPage(specs: SuiteSpec[], nextCursor: string | null = null): string {
  const nodes = specs.map((spec) => {
    if ("external" in spec) {
      return {
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
      status,
      conclusion,
      app: { slug: "github-actions" },
      workflowRun: {
        databaseId: spec.id,
        updatedAt: "2026-03-01T10:00:00Z",
        workflow: {
          databaseId: spec.wf === undefined ? 1000 + spec.id : spec.wf,
          name: spec.name ?? `CI-${spec.id}`,
        },
      },
    };
  });
  const pageInfo = { hasNextPage: nextCursor !== null, endCursor: nextCursor };
  return JSON.stringify({
    data: { repository: { object: { checkSuites: { nodes, pageInfo } } } },
  });
}

function run(spec: Exclude<SuiteSpec, { external: true }>): Run {
  const status = spec.status ?? "completed";
  return {
    id: spec.id,
    status,
    conclusion:
      status !== "completed" || spec.conclusion === null ? null : (spec.conclusion ?? "success"),
    workflowId: spec.wf === undefined ? 1000 + spec.id : spec.wf,
    updatedAt: "2026-03-01T10:00:00Z",
    name: spec.name ?? `CI-${spec.id}`,
  };
}

type PrNodeSpec = Partial<{
  number: number;
  url: string;
  isDraft: boolean;
  state: string;
  mergedAt: string | null;
  mergeCommitOid: string | null;
  headRefOid: string;
  updatedAt: string;
  comments: number;
  threads: number;
  review: { id: string; submittedAt: string | null; state: string; login: string | null } | null;
  rollup: string | null;
}>;

/** One pullRequest node of the rows query, GitHub-shaped. */
function prNode(spec: PrNodeSpec = {}): unknown {
  const review = spec.review === undefined ? null : spec.review;
  return {
    number: spec.number ?? 1,
    url: spec.url ?? `https://example.com/octocat/repo/pull/${spec.number ?? 1}`,
    isDraft: spec.isDraft ?? false,
    state: spec.state ?? "OPEN",
    mergedAt: spec.mergedAt ?? null,
    mergeCommit: spec.mergeCommitOid === undefined ? null : { oid: spec.mergeCommitOid },
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
            statusCheckRollup:
              spec.rollup === undefined || spec.rollup === null ? null : { state: spec.rollup },
          },
        },
      ],
    },
  };
}

function row(spec: Partial<Row> = {}): Row {
  return {
    repo: "octocat/repo",
    number: 1,
    url: "https://example.com/octocat/repo/pull/1",
    isDraft: false,
    state: "OPEN",
    mergedAt: null,
    mergeCommitOid: null,
    headRefOid: "head0001",
    updatedAt: "2026-03-01T10:00:00Z",
    issueComments: 0,
    reviewThreads: 0,
    latestReview: null,
    rollupState: null,
    ...spec,
  };
}

/** `at` is the publication instant; `created` (default: the same) is the draft's creation. */
type CommentSpec = {
  at: string;
  created?: string;
  login: string | null;
  body: string;
  url: string;
};

function commentNode(spec: CommentSpec): unknown {
  return {
    databaseId: 1,
    publishedAt: spec.at,
    createdAt: spec.created ?? spec.at,
    author: spec.login === null ? null : { login: spec.login },
    body: spec.body,
    url: spec.url,
  };
}

type ThreadSpec = {
  isResolved: boolean;
  path: string;
  line: number | null;
  total: number;
  comments: CommentSpec[];
};

type ReviewSpec = {
  submittedAt: string | null;
  state: string;
  login: string;
  body: string;
  url: string;
};

function detailPage(spec: {
  comments?: CommentSpec[];
  reviews?: ReviewSpec[];
  threads: ThreadSpec[];
  nextCursor?: string | null;
  commitAuthor?: string | null;
}): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          comments: { nodes: (spec.comments ?? []).map(commentNode) },
          reviews: {
            nodes: (spec.reviews ?? []).map((review) => ({
              fullDatabaseId: "1",
              submittedAt: review.submittedAt,
              state: review.state,
              author: { login: review.login },
              body: review.body,
              url: review.url,
            })),
          },
          reviewThreads: {
            nodes: spec.threads.map((thread) => ({
              isResolved: thread.isResolved,
              path: thread.path,
              line: thread.line,
              comments: { totalCount: thread.total, nodes: thread.comments.map(commentNode) },
            })),
            pageInfo: {
              hasNextPage: (spec.nextCursor ?? null) !== null,
              endCursor: spec.nextCursor ?? null,
            },
          },
          commits: {
            nodes: [
              {
                commit: {
                  author: {
                    user:
                      spec.commitAuthor === undefined || spec.commitAuthor === null
                        ? null
                        : { login: spec.commitAuthor },
                  },
                },
              },
            ],
          },
        },
      },
    },
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

// --- check-suites.mts --------------------------------------------------------

describe("discoverRuns", () => {
  test("external-app suites are not runs and GitHub's enums are lowercased: a CodeQL FAILURE is not judged", () => {
    // Judged, the two CodeQL-style suites (FAILURE, no workflowRun) would turn a green commit red.
    const s = scenario({
      "suites-1.json": suitesPage([{ id: 1 }, { external: true }, { id: 2 }, { external: true }]),
    });
    const runs = discoverRuns("octocat/repo", "deadbeef");
    expect(runs).toEqual([run({ id: 1 }), run({ id: 2 })]);
    expect(judgeRuns(runs, [])).toEqual({
      kind: "green",
      lines: ["pass: CI-2 (2)", "pass: CI-1 (1)"],
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

describe("judgeRuns", () => {
  // The verdict kinds rank red > pending > missing > trouble > green; every row below would
  // read differently under another order or under per-run (not per-workflow) judgment.
  const sameWorkflow = { wf: 77, name: "CI" };
  const cases: {
    id: string;
    runs: Run[];
    expected: string[];
    verdict: ReturnType<typeof judgeRuns>;
  }[] = [
    {
      id: "red outranks missing outranks trouble, all three reported",
      runs: [run({ id: 1, conclusion: "failure" }), run({ id: 2, conclusion: null })],
      expected: ["CI-1", "Gate"],
      verdict: {
        kind: "red",
        lines: [
          "run 2 (CI-2) is completed but carries no conclusion (gh or GitHub trouble?)",
          "FAIL(failure): CI-1 (1)",
          "no run registered for Gate",
        ],
      },
    },
    {
      id: "missing outranks trouble",
      runs: [run({ id: 1 }), run({ id: 2, conclusion: null })],
      expected: ["Gate"],
      verdict: {
        kind: "missing",
        lines: [
          "run 2 (CI-2) is completed but carries no conclusion (gh or GitHub trouble?)",
          "pass: CI-1 (1)",
          "no run registered for Gate",
        ],
      },
    },
    {
      id: "a completed run without a conclusion alone is trouble, never red or green",
      runs: [run({ id: 1, conclusion: null })],
      expected: [],
      verdict: {
        kind: "trouble",
        lines: ["run 1 (CI-1) is completed but carries no conclusion (gh or GitHub trouble?)"],
      },
    },
    {
      id: "pending outranks missing: the gate can still register while a run is in progress",
      runs: [run({ id: 1, status: "in_progress" }), run({ id: 2 })],
      expected: ["Gate"],
      verdict: {
        kind: "pending",
        lines: ["pass: CI-2 (2)", "pending(in_progress): CI-1 (1)", "no run registered for Gate"],
      },
    },
    {
      id: "red outranks pending: a failed run is reported while others still run",
      runs: [run({ id: 1, conclusion: "failure" }), run({ id: 2, status: "queued" })],
      expected: [],
      verdict: { kind: "red", lines: ["pending(queued): CI-2 (2)", "FAIL(failure): CI-1 (1)"] },
    },
    {
      id: "green with a skipped run",
      runs: [run({ id: 1 }), run({ id: 2, conclusion: "skipped" })],
      expected: ["CI-1", "CI-2"],
      verdict: { kind: "green", lines: ["skip: CI-2 (2)", "pass: CI-1 (1)"] },
    },
    {
      id: "an older cancelled run of a re-triggered workflow is superseded, not red (numeric newest pick)",
      runs: [
        run({ id: 9, conclusion: "cancelled", ...sameWorkflow }),
        run({ id: 100, ...sameWorkflow }),
      ],
      expected: ["CI"],
      verdict: { kind: "green", lines: ["superseded: CI (9)", "pass: CI (100)"] },
    },
    {
      id: "a cancelled latest run with no newer run is a real failure",
      runs: [run({ id: 1, conclusion: "cancelled" })],
      expected: [],
      verdict: { kind: "red", lines: ["FAIL(cancelled): CI-1 (1)"] },
    },
    {
      id: "runs without a workflow id are judged individually, never superseded",
      runs: [run({ id: 1, conclusion: "cancelled", wf: null }), run({ id: 2, wf: null })],
      expected: [],
      verdict: { kind: "red", lines: ["pass: CI-2 (2)", "FAIL(cancelled): CI-1 (1)"] },
    },
    {
      id: "expected names match exactly, never by prefix",
      runs: [run({ id: 1 }), run({ id: 2 })],
      expected: ["CI"],
      verdict: {
        kind: "missing",
        lines: ["pass: CI-2 (2)", "pass: CI-1 (1)", "no run registered for CI"],
      },
    },
    {
      id: "no runs and nothing expected is pending, never a vacuous green",
      runs: [],
      expected: [],
      verdict: { kind: "pending", lines: ["no workflow runs registered"] },
    },
    {
      id: "no runs with an expected workflow is missing",
      runs: [],
      expected: ["CI"],
      verdict: { kind: "missing", lines: ["no run registered for CI"] },
    },
  ];
  test.each(cases)("$id", (c) => {
    expect(judgeRuns(c.runs, c.expected), c.id).toEqual(c.verdict);
  });
});

describe("failedJobLog", () => {
  test("the excerpt is the last 80 lines of gh's merged stream, kept through a nonzero exit; the only REST call", () => {
    // The stderr line keeps its place in the merged stream, a log past spawnSync's 1 MiB default
    // buffer still ends with its final lines instead of a truncated prefix's tail, and
    // --log-failed's nonzero exit (a run with no failed step) never loses the text. The run's
    // repository is named on the call, since the daemon's working directory is not the run's.
    // The fake records every other Actions REST endpoint, and an unnamed repository, as a
    // violation.
    const lines = Array.from(
      { length: 20000 },
      (_, i) => `log line ${i + 1} xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    );
    const s = scenario({
      "log-7.txt": `${lines.join("\n")}\n`,
      "log-7.stderr": "warning after the log\n",
      "log-7.exit": "3",
    });
    expect(failedJobLog("octocat/repo", 7)).toBe(
      [...lines.slice(-79), "warning after the log"].join("\n"),
    );
    expect(s.calls()).toEqual(["run view 7 --log-failed --repo octocat/repo"]);
    expect(s.violations()).toBe("");
  });

  test("a hung log fetch is cut off at the timeout, keeping what gh printed and noting the cut", () => {
    // The excerpt is informational, so a hung gh must not stall the caller: spawnSync reports
    // the kill as an ETIMEDOUT error with the partial stdout still attached.
    const s = scenario({ "log-7.txt": "first line\nsecond line\n", "log-7.sleep": "" });
    expect(failedJobLog("octocat/repo", 7, 300)).toBe(
      "first line\nsecond line\ngh run view 7 --log-failed: no answer within 300 ms",
    );
    expect(s.violations()).toBe("");
  });
});

// --- pr-rows.mts -------------------------------------------------------------

describe("readRows", () => {
  test("31 refs across two repositories go out as two aliased requests; a null PR is absent while its batch survives gh's exit 1", () => {
    // Chunk 1 holds 29 PRs of one repository plus one of another, chunk 2 the 31st. PR 17 is
    // deleted: GitHub answers null for it with an `errors` entry, on which gh exits 1 with the
    // body still on stdout. A batch that failed on that exit would blind 29 PRs for one deletion.
    const refs: PrRef[] = Array.from({ length: 29 }, (_, i) => ({
      repo: "octocat/repo",
      number: i + 1,
    }));
    refs.push({ repo: "octocat/other", number: 5 }, { repo: "octocat/repo", number: 30 });
    const r0: Record<string, unknown> = {};
    for (let n = 1; n <= 29; n += 1) r0[`p${n}`] = n === 17 ? null : prNode({ number: n });
    const s = scenario({
      "rows-1.json": JSON.stringify({
        data: {
          r0,
          r1: {
            p5: prNode({
              number: 5,
              url: "https://example.com/octocat/other/pull/5",
              isDraft: true,
              state: "MERGED",
              mergedAt: "2026-03-02T12:00:00Z",
              mergeCommitOid: "merge0005",
              headRefOid: "head0005",
              updatedAt: "2026-03-02T12:00:00Z",
              comments: 4,
              threads: 2,
              review: {
                id: "900",
                submittedAt: "2026-03-02T11:00:00Z",
                state: "APPROVED",
                login: "work-bot",
              },
              rollup: "SUCCESS",
            }),
          },
        },
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
          r0: {
            p30: prNode({
              number: 30,
              review: { id: "901", submittedAt: null, state: "PENDING", login: null },
            }),
          },
        },
      }),
    });
    const rows = readRows(refs);
    expect(rows.size).toBe(30);
    expect(rows.has("octocat/repo#17")).toBe(false);
    expect(rows.get("octocat/repo#1")).toEqual(row());
    expect(rows.get("octocat/other#5")).toEqual({
      repo: "octocat/other",
      number: 5,
      url: "https://example.com/octocat/other/pull/5",
      isDraft: true,
      state: "MERGED",
      mergedAt: "2026-03-02T12:00:00Z",
      mergeCommitOid: "merge0005",
      headRefOid: "head0005",
      updatedAt: "2026-03-02T12:00:00Z",
      issueComments: 4,
      reviewThreads: 2,
      latestReview: {
        id: "900",
        submittedAt: "2026-03-02T11:00:00Z",
        state: "APPROVED",
        author: "work-bot",
      },
      rollupState: "SUCCESS",
    });
    // A deleted account nulls the author; a PENDING review has no submittedAt.
    expect(rows.get("octocat/repo#30")?.latestReview).toEqual({
      id: "901",
      submittedAt: "unsubmitted",
      state: "PENDING",
      author: "ghost",
    });
    const calls = s.calls();
    expect(calls).toHaveLength(2);
    // The coordinates leave the program inlined in the query text, by repository alias.
    expect(calls[0]).toContain('r0: repository(owner: "octocat", name: "repo")');
    expect(calls[0]).toContain('r1: repository(owner: "octocat", name: "other")');
    expect(calls[0]).toContain("p17: pullRequest(number: 17)");
    expect(calls[1]).toContain("p30: pullRequest(number: 30)");
    expect(calls[1]).not.toContain("pullRequest(number: 17)");
    expect(s.violations()).toBe("");
  });

  test("a chunk whose every PR is null is an error naming them, never an empty map", () => {
    const s = scenario({
      "rows-1.json": JSON.stringify({ data: { r0: { p1: null, p2: null } } }),
    });
    expect(() =>
      readRows([
        { repo: "octocat/repo", number: 1 },
        { repo: "octocat/repo", number: 2 },
      ]),
    ).toThrow(
      new GhError("GraphQL response has no pullRequest for octocat/repo#1, octocat/repo#2"),
    );
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
    expect(() => readRows([{ repo: "octocat/repo", number: 1 }])).toThrow(
      new GhError("gh api graphql exited 1: gh: API rate limit exceeded"),
    );
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

// --- pr-detail.mts -----------------------------------------------------------

describe("readPrDetail", () => {
  test("threads are paged past the first page, unresolved counts sum across pages, and a thread's first comment is told from a reply by position", () => {
    // Thread B is five comments long and the query fetches its last three: all replies, drafted
    // at 09:50 and published when their review was submitted, so their activity instant is the
    // publication. Thread C on page 2 is two long and fully fetched: a review-comment then a
    // reply. The empty-bodied COMMENTED review wrapping inline comments and the unsubmitted
    // PENDING review are not activity; the issue comments, reviews, and commit author come from
    // the first page only.
    const s = scenario({
      "detail-1.json": detailPage({
        comments: [
          {
            at: "2026-03-01T10:05:00Z",
            login: "work-bot",
            body: "ping",
            url: "https://example.com/c1",
          },
          { at: "2026-03-01T10:06:00Z", login: null, body: "gone", url: "https://example.com/c2" },
        ],
        reviews: [
          {
            submittedAt: "2026-03-01T10:07:00Z",
            state: "APPROVED",
            login: "work-bot",
            body: "LGTM",
            url: "https://example.com/r1",
          },
          {
            submittedAt: "2026-03-01T10:08:00Z",
            state: "COMMENTED",
            login: "work-bot",
            body: "",
            url: "https://example.com/r2",
          },
          {
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
                at: "2026-03-01T10:02:00Z",
                created: "2026-03-01T09:50:00Z",
                login: "work-bot",
                body: "three",
                url: "https://example.com/t2-3",
              },
              {
                at: "2026-03-01T10:03:00Z",
                created: "2026-03-01T09:50:30Z",
                login: "octocat",
                body: "four",
                url: "https://example.com/t2-4",
              },
              {
                at: "2026-03-01T10:04:00Z",
                created: "2026-03-01T09:51:00Z",
                login: "work-bot",
                body: "five",
                url: "https://example.com/t2-5",
              },
            ],
          },
        ],
        nextCursor: "c1",
        commitAuthor: "octocat",
      }),
      "detail-2.json": detailPage({
        comments: [
          {
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
                at: "2026-03-01T10:10:00Z",
                login: "work-bot",
                body: "first",
                url: "https://example.com/t3-1",
              },
              {
                at: "2026-03-01T10:11:00Z",
                login: "octocat",
                body: "second",
                url: "https://example.com/t3-2",
              },
            ],
          },
        ],
        commitAuthor: null,
      }),
    });
    const detail = readPrDetail({ repo: "octocat/repo", number: 7 });
    const expected: Activity[] = [
      {
        kind: "review-comment",
        at: "2026-03-01T10:01:00Z",
        author: "work-bot",
        body: "nit",
        url: "https://example.com/t1-1",
        path: "src/a.ts",
        line: 12,
      },
      {
        kind: "reply",
        at: "2026-03-01T10:02:00Z",
        author: "work-bot",
        body: "three",
        url: "https://example.com/t2-3",
        path: "src/b.ts",
        line: null,
      },
      {
        kind: "reply",
        at: "2026-03-01T10:03:00Z",
        author: "octocat",
        body: "four",
        url: "https://example.com/t2-4",
        path: "src/b.ts",
        line: null,
      },
      {
        kind: "reply",
        at: "2026-03-01T10:04:00Z",
        author: "work-bot",
        body: "five",
        url: "https://example.com/t2-5",
        path: "src/b.ts",
        line: null,
      },
      {
        kind: "review-comment",
        at: "2026-03-01T10:10:00Z",
        author: "work-bot",
        body: "first",
        url: "https://example.com/t3-1",
        path: "src/c.ts",
        line: 3,
      },
      {
        kind: "reply",
        at: "2026-03-01T10:11:00Z",
        author: "octocat",
        body: "second",
        url: "https://example.com/t3-2",
        path: "src/c.ts",
        line: 3,
      },
      {
        kind: "comment",
        at: "2026-03-01T10:05:00Z",
        author: "work-bot",
        body: "ping",
        url: "https://example.com/c1",
      },
      {
        kind: "comment",
        at: "2026-03-01T10:06:00Z",
        author: "ghost",
        body: "gone",
        url: "https://example.com/c2",
      },
      {
        kind: "review",
        at: "2026-03-01T10:07:00Z",
        author: "work-bot",
        body: "LGTM",
        url: "https://example.com/r1",
        reviewState: "APPROVED",
      },
    ];
    expect(detail).toEqual({
      lastCommitAuthor: "octocat",
      unresolvedThreads: 2,
      activities: expected,
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
    expect(() => readPrDetail({ repo: "octocat/repo", number: 7 })).toThrow(
      new GhError("GraphQL response has no pullRequest (wrong repo or PR number?)"),
    );
    expect(s.violations()).toBe("");
  });
});

describe("newActivity", () => {
  const activity = (at: string, author: string): Activity => ({
    kind: "comment",
    at,
    author,
    body: "",
    url: "https://example.com/c",
  });

  test("filters by instant, not string order, drops the viewer's own, and sorts oldest first", () => {
    // sinceIso carries milliseconds while GitHub's timestamps do not: compared as strings,
    // "...00Z" sorts after "...00.000Z", so an equal instant would read as new.
    const detail = {
      lastCommitAuthor: null,
      unresolvedThreads: 0,
      activities: [
        activity("2026-03-01T10:00:02Z", "work-bot"),
        activity("2026-03-01T10:00:00Z", "octocat"),
        activity("2026-03-01T10:00:00Z", "work-bot"),
        activity("2026-03-01T09:59:59Z", "work-bot"),
        activity("2026-03-01T10:00:01Z", "octocat"),
        activity("2026-03-01T10:00:01Z", "example-user"),
      ],
    };
    expect(newActivity(detail, "2026-03-01T10:00:00.000Z", "octocat")).toEqual([
      activity("2026-03-01T10:00:01Z", "example-user"),
      activity("2026-03-01T10:00:02Z", "work-bot"),
    ]);
  });

  test("an unparsable sinceIso is refused, never read as nothing new", () => {
    expect(() =>
      newActivity(
        { lastCommitAuthor: null, unresolvedThreads: 0, activities: [] },
        "yesterday",
        "octocat",
      ),
    ).toThrow("sinceIso is not a timestamp: yesterday");
  });
});

describe("viewerLogin", () => {
  test("reads the login through GraphQL", () => {
    const s = scenario({
      "viewer-1.json": JSON.stringify({ data: { viewer: { login: "octocat" } } }),
    });
    expect(viewerLogin()).toBe("octocat");
    expect(s.calls()).toHaveLength(1);
    expect(s.violations()).toBe("");
  });
});
