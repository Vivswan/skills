import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";

// Contract tests for the PR-activity waiter: a stub gh on PATH serves a
// canned JSON SEQUENCE across calls (fixture N for call N, repeating the
// last fixture once the sequence runs out), driving every exit path - a
// failed baseline exits 2 before any wait, watched deltas exit 0 with the
// change named, merged/closed unwatched exits 1, timeout exits 3 with the
// baseline and final snapshots, and bad arguments exit 2 without a single
// gh call.

const SCRIPT = join(ROOT, "skills", "watch-ci-after-push", "scripts", "wait-for-pr-event.mts");

const FAKE_GH = `#!/usr/bin/env bash
# One log line per call: the graphql query argument itself spans lines.
{ printf '%s' "$*" | tr '\\n' ' '; printf '\\n'; } >> "\${STUB_ARGS_LOG}"
serve() {
  local prefix="$1"
  local countfile="\${STUB_DIR}/.\${prefix}-count"
  local n=$(( $(cat "$countfile" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$countfile"
  while [ "$n" -gt 1 ] && [ ! -f "\${STUB_DIR}/\${prefix}-\${n}.json" ]; do n=$((n-1)); done
  local file="\${STUB_DIR}/\${prefix}-\${n}.json"
  if [ ! -f "$file" ]; then echo "stub gh: no \${prefix} fixture" >&2; exit 1; fi
  cat "$file"
}
case "$1" in
  api)
    if [ "\${STUB_FAIL_GQL:-0}" = "1" ]; then echo "gh: graphql boom" >&2; exit 1; fi
    serve gql
    ;;
  pr)
    if [ "\${STUB_FAIL_PR:-0}" = "1" ]; then echo "gh: pr view boom" >&2; exit 1; fi
    serve pr
    ;;
  repo)
    echo '{"nameWithOwner":"octo/example"}'
    ;;
  *) echo "stub gh: unexpected: $*" >&2; exit 64;;
esac
`;

const binDir = mkdtempSync(join(tmpdir(), "wait-for-pr-event-bin-"));
const emptyBinDir = mkdtempSync(join(tmpdir(), "wait-for-pr-event-nobin-"));
writeFileSync(join(binDir, "gh"), FAKE_GH);
chmodSync(join(binDir, "gh"), 0o755);

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
  rmSync(emptyBinDir, { recursive: true, force: true });
});

interface GqlShape {
  state?: string;
  mergedAt?: string | null;
  comments?: number;
  reviewCount?: number;
  review?: { id: string; login: string; state: string; submittedAt: string } | null;
  /** isResolved per thread on this page. */
  threads?: boolean[];
  hasNextPage?: boolean;
  endCursor?: string | null;
}

function gql(shape: GqlShape = {}): string {
  const review = shape.review === undefined ? null : shape.review;
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: shape.state ?? "OPEN",
          mergedAt: shape.mergedAt ?? null,
          comments: { totalCount: shape.comments ?? 3 },
          reviews: {
            totalCount: shape.reviewCount ?? (review === null ? 0 : 1),
            nodes:
              review === null
                ? []
                : [
                    {
                      fullDatabaseId: review.id,
                      state: review.state,
                      submittedAt: review.submittedAt,
                      author: { login: review.login },
                    },
                  ],
          },
          reviewThreads: {
            nodes: (shape.threads ?? []).map((isResolved) => ({ isResolved })),
            pageInfo: {
              hasNextPage: shape.hasNextPage ?? false,
              endCursor: shape.endCursor ?? null,
            },
          },
        },
      },
    },
  });
}

/** checks as [name, conclusion, status] rows, gh pr view rollup shape. */
function prView(checks: Array<[string, string, string?]> = []): string {
  return JSON.stringify({
    statusCheckRollup: checks.map(([name, conclusion, status]) => ({
      __typename: "CheckRun",
      name,
      conclusion,
      status: status ?? (conclusion === "" ? "IN_PROGRESS" : "COMPLETED"),
    })),
  });
}

let scenario = 0;
function run(
  args: string[],
  fixtures: Record<string, string> = {},
  env: Record<string, string> = {},
  path?: string,
) {
  scenario += 1;
  const stubDir = join(binDir, `scenario-${scenario}`);
  mkdirSync(stubDir);
  for (const [name, body] of Object.entries(fixtures)) {
    writeFileSync(join(stubDir, `${name}.json`), body);
  }
  const argsLog = join(stubDir, "args.log");
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
    env: {
      ...process.env,
      PATH: path ?? `${binDir}:${process.env.PATH}`,
      STUB_DIR: stubDir,
      STUB_ARGS_LOG: argsLog,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let ghCalls: string[] = [];
  try {
    ghCalls = readFileSync(argsLog, "utf-8").split("\n").filter(Boolean);
  } catch {
    // no log file means no gh calls
  }
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    ghCalls,
  };
}

const STATIC = { "gql-1": gql({ threads: [true] }), "pr-1": prView([["ci", "SUCCESS"]]) };

describe("wait-for-pr-event.mts", () => {
  test("baseline failure exits 2 before any wait or retry", () => {
    const r = run(["7", "--repo", "octo/example"], {}, { STUB_FAIL_GQL: "1" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("baseline read failed");
    expect(r.stdout).not.toContain("watching");
    // One graphql attempt, no retries, no checks call: the wait never started.
    expect(r.ghCalls).toHaveLength(1);
  });

  test("a failed checks read is also a failed baseline: exit 2", () => {
    const r = run(["7", "--repo", "octo/example"], STATIC, { STUB_FAIL_PR: "1" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("baseline read failed");
  });

  test("a new review exits 0 naming reviewer, state, and time", () => {
    const r = run(["7", "--repo", "octo/example", "--until", "review"], {
      "gql-1": gql({ review: { id: "10", login: "alice", state: "APPROVED", submittedAt: "t1" } }),
      "gql-2": gql({
        reviewCount: 2,
        review: { id: "11", login: "bob", state: "CHANGES_REQUESTED", submittedAt: "t2" },
      }),
      "pr-1": prView(),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("new review by bob (CHANGES_REQUESTED) at t2");
  });

  test("thread-count deltas exit 0 with the counts named", () => {
    const r = run(["7", "--repo", "octo/example", "--until", "comment"], {
      "gql-1": gql({ threads: [true, true] }),
      "gql-2": gql({ threads: [true, false, false] }),
      "pr-1": prView(),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("review threads 2 -> 3");
    expect(r.stdout).toContain("unresolved threads 0 -> 2");
  });

  test("an issue-comment delta exits 0", () => {
    const r = run(["7", "--repo", "octo/example", "--until", "comment"], {
      "gql-1": gql({ comments: 3 }),
      "gql-2": gql({ comments: 4 }),
      "pr-1": prView(),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("issue comments 3 -> 4");
  });

  test("unresolved counts sum across thread pages, cursor passed to page 2", () => {
    const page1 = { threads: [false], hasNextPage: true, endCursor: "c1" };
    const r = run(["7", "--repo", "octo/example", "--until", "comment"], {
      "gql-1": gql(page1),
      "gql-2": gql({ threads: [true, false] }),
      "gql-3": gql(page1),
      "gql-4": gql({ threads: [false, false] }),
      "pr-1": prView(),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("unresolved threads 2 -> 3");
    const gqlCalls = r.ghCalls.filter((call) => call.startsWith("api graphql"));
    expect(gqlCalls[1]).toContain("cursor=c1");
    expect(gqlCalls[3]).toContain("cursor=c1");
  });

  test("a check delta is ignored when checks are not watched: timeout, exit 3", () => {
    const r = run(
      ["7", "--repo", "octo/example", "--until", "comment", "--timeout", "1", "--interval", "15"],
      {
        "gql-1": gql(),
        "pr-1": prView([["ci", "", "IN_PROGRESS"]]),
        "pr-2": prView([["ci", "FAILURE"]]),
      },
    );
    expect(r.code).toBe(3);
    expect(r.stdout).not.toContain("check ci ->");
  });

  test("a check delta exits 0 when checks are watched", () => {
    const r = run(["7", "--repo", "octo/example", "--until", "checks"], {
      "gql-1": gql(),
      "pr-1": prView([["ci", "", "IN_PROGRESS"]]),
      "pr-2": prView([["ci", "FAILURE"]]),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check ci -> failure (was pending)");
  });

  test("merged while merge is not watched exits 1: the wait's job ended", () => {
    const r = run(["7", "--repo", "octo/example"], {
      "gql-1": gql(),
      "gql-2": gql({ state: "MERGED", mergedAt: "2026-08-26T00:00:00Z" }),
      "pr-1": prView(),
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("merged at 2026-08-26T00:00:00Z but merge is not watched");
  });

  test("merged while watched exits 0 with the merge named", () => {
    const r = run(["7", "--repo", "octo/example", "--until", "merge"], {
      "gql-1": gql(),
      "gql-2": gql({ state: "MERGED", mergedAt: "2026-08-26T00:00:00Z" }),
      "pr-1": prView(),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("merged at 2026-08-26T00:00:00Z");
    expect(r.stdout).not.toContain("not watched");
  });

  test("already merged at the baseline settles immediately, no wait", () => {
    const merged = gql({ state: "MERGED", mergedAt: "t" });
    const watched = run(["7", "--repo", "octo/example", "--until", "merge"], {
      "gql-1": merged,
      "pr-1": prView(),
    });
    expect(watched.code).toBe(0);
    const unwatched = run(["7", "--repo", "octo/example"], { "gql-1": merged, "pr-1": prView() });
    expect(unwatched.code).toBe(1);
    // Baseline only: one graphql call and one checks call each.
    expect(unwatched.ghCalls).toHaveLength(2);
  });

  test("closed without merging exits 1 regardless of the watch set", () => {
    const r = run(["7", "--repo", "octo/example", "--until", "merge"], {
      "gql-1": gql(),
      "gql-2": gql({ state: "CLOSED" }),
      "pr-1": prView(),
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("closed without merging");
  });

  test("timeout exits 3 with baseline and final snapshots as evidence", () => {
    const r = run(["7", "--repo", "octo/example", "--timeout", "1", "--interval", "15"], STATIC);
    expect(r.code).toBe(3);
    expect(r.stdout).toContain("no watched change in comment,review after 1s");
    expect(r.stdout).toContain("baseline: state OPEN");
    expect(r.stdout).toContain("final:    state OPEN");
    expect(r.stdout).toContain("checks ci=success");
  });

  test("the interval floor is enforced as a usage error before any gh call", () => {
    const r = run(["7", "--repo", "octo/example", "--interval", "5"], STATIC);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--interval must be at least 15 seconds");
    expect(r.ghCalls).toHaveLength(0);
  });

  test("a dash-prefixed value after a flag is rejected, not consumed", () => {
    const r = run(["7", "--until", "--interval", "45"], STATIC);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--until requires a value");
    expect(r.ghCalls).toHaveLength(0);
  });

  test("unknown flags, bad numbers, and extra arguments are usage errors", () => {
    expect(run(["7", "--frobnicate"], STATIC).code).toBe(2);
    expect(run(["abc"], STATIC).code).toBe(2);
    expect(run(["7", "extra"], STATIC).code).toBe(2);
    expect(run([], STATIC).code).toBe(2);
    expect(run(["7", "--until", "comment,mail"], STATIC).code).toBe(2);
    expect(run(["7", "--repo", "not-a-repo"], STATIC).code).toBe(2);
  });

  test("without --repo the current repo is resolved via gh repo view", () => {
    const r = run(["7"], {
      "gql-1": gql(),
      "gql-2": gql({ comments: 9 }),
      "pr-1": prView(),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("PR #7 (octo/example)");
    expect(r.ghCalls[0]).toBe("repo view --json nameWithOwner");
    expect(r.ghCalls.some((call) => call.startsWith("pr view 7 --repo octo/example"))).toBe(true);
  });

  test("gh missing from PATH exits 2 with the tooling named", () => {
    const r = run(["7", "--repo", "octo/example"], {}, {}, emptyBinDir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("gh not found on PATH");
  });
});
