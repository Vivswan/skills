import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";

// Exit-matrix test for the watch-ci helper: a fake `gh` on PATH drives every
// branch of the script, pinning the contract its reviews established - a red
// run exits 1, a gh operational failure exits 2 (never 1), a green fleet
// exits 0, and a red run outranks a gh hiccup. The unit of judgment is the
// workflow: only the latest run per workflow is judged, older re-triggered
// runs are reported as superseded without affecting the exit code, and every
// poll is one GraphQL snapshot so a run registered or re-run mid-watch is
// waited on like any other. The expected-workflow gate (default "CI",
// overridden by --expect-workflow) turns an absent gate workflow into exit 2
// with evidence, never a vacuous pass. Polls sleep 60 s; a fake `sleep` logs
// each duration and returns at once.

const SCRIPT = join(ROOT, "skills", "watch-ci-after-push", "scripts", "watch-ci.sh");

// Dispatch validates the EXACT invocations watch-ci.sh makes. Every mismatch
// is appended to the GH_VIOLATIONS file, which each test asserts is empty.
// The Actions REST endpoints (run list/watch/view --json) answer a 403 rate
// limit AND record a violation: the script must never reach them.
// The graphql answer is raw GraphQL JSON built from the fixture and piped
// through the real jq with the --jq filter the script passed, so the filter's
// field order, enum lowercasing, and external-suite drop are under test.
// GH_RUNS entries are "id" (COMPLETED), "id@<status>" (still running), or
// "id@<status>@<updatedAt>" (an empty status is COMPLETED; default t1); with
// GH_RUNS<n> set, that snapshot is served from the n-th snapshot onward (a
// snapshot is one first-page call plus its cursor pages). GH_PAGE_SIZE splits
// a snapshot into pages; the cursor for page k is "page<k>".
const FAKE_GH = `#!/usr/bin/env bash
violate() { echo "$*" >> "\${GH_VIOLATIONS}"; }
rate_limited() { echo "HTTP 403: API rate limit exceeded for user ID 1" >&2; exit 1; }
if [ "$*" = "repo view --json nameWithOwner -q .nameWithOwner" ]; then
  [ "\${GH_REPO_EXIT:-0}" -ne 0 ] && exit "\${GH_REPO_EXIT}"
  echo "octo/example"; exit 0
fi
if [ "$1 $2" = "api graphql" ]; then
  shift 2
  query=""; owner=""; name=""; oid=""; cursor=""; filter=""
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -f) case "$2" in
            query=*) query="\${2#query=}";; owner=*) owner="\${2#owner=}";; name=*) name="\${2#name=}";;
            oid=*) oid="\${2#oid=}";; cursor=*) cursor="\${2#cursor=}";;
            *) violate "graphql var: $2"; exit 64;;
          esac; shift 2;;
      --jq) filter="$2"; shift 2;;
      *) violate "graphql arg: $1"; exit 64;;
    esac
  done
  [ "$owner/$name/$oid" = "octo/example/deadbeef" ] || { violate "graphql target: $owner/$name/$oid"; exit 64; }
  case "$query" in
    'query($owner: String!, $name: String!, $oid: GitObjectID!, $cursor: String)'*'object(oid: $oid)'*'checkSuites(first: 100, after: $cursor)'*'pageInfo { hasNextPage endCursor }'*) ;;
    *) violate "graphql query: $query"; exit 64;;
  esac
  [ -n "$filter" ] || { violate "graphql without --jq"; exit 64; }
  [ "\${GH_GQL_EXIT:-0}" -ne 0 ] && exit "\${GH_GQL_EXIT}"
  page=1
  case "$cursor" in "") ;; page[0-9]*) page="\${cursor#page}";; *) violate "graphql cursor: $cursor"; exit 64;; esac
  c=0; [ -f "\${GH_CALLS}" ] && c="$(cat "\${GH_CALLS}")"
  if [ "$page" -eq 1 ]; then c=$((c + 1)); printf '%s' "$c" > "\${GH_CALLS}"; fi
  runs="\${GH_RUNS:-}"
  k=2
  while [ "$k" -le "$c" ]; do
    v="GH_RUNS$k"
    if [ -n "\${!v+x}" ]; then runs="\${!v}"; fi
    k=$((k + 1))
  done
  if [ -n "\${GH_READY_AFTER:-}" ] && [ "$c" -lt "\${GH_READY_AFTER}" ]; then runs=""; fi
  for fc in \${GH_FAIL_CALLS:-}; do [ "$c" -eq "$fc" ] && exit 4; done
  size="\${GH_PAGE_SIZE:-100000}"
  nodes=""; i=0; more=false
  for entry in $runs; do
    i=$((i + 1))
    [ "$i" -gt $(( (page - 1) * size )) ] || continue
    if [ "$i" -gt $(( page * size )) ]; then more=true; break; fi
    id="\${entry%%@*}"; rest=""; case "$entry" in *@*) rest="\${entry#*@}";; esac
    updated="\${rest#*@}"; [ "$updated" != "$rest" ] || updated=t1
    status="$(printf '%s' "\${rest%%@*}" | tr a-z A-Z)"; [ -n "$status" ] || status=COMPLETED
    cvar="GH_CONCLUSION_\${id}"; conclusion="$(printf '%s' "\${!cvar:-success}" | tr a-z A-Z)"
    if [ "$status" != COMPLETED ] || [ "$conclusion" = NULL ]; then conclusion=null; else conclusion="\\"$conclusion\\""; fi
    nvar="GH_NAME_\${id}"; wvar="GH_WF_\${id}"; wfid="\${!wvar:-$((1000 + id))}"
    node="{\\"status\\":\\"$status\\",\\"conclusion\\":$conclusion,\\"app\\":{\\"slug\\":\\"github-actions\\"},"
    node="$node\\"workflowRun\\":{\\"databaseId\\":$id,\\"updatedAt\\":\\"$updated\\",\\"workflow\\":{\\"databaseId\\":$wfid,\\"name\\":\\"\${!nvar:-CI-$id}\\"}}}"
    nodes="\${nodes:+$nodes,}$node"
  done
  if [ "$page" -eq 1 ]; then
    e=0
    while [ "$e" -lt "\${GH_EXTERNAL_SUITES:-0}" ]; do
      e=$((e + 1))
      nodes="\${nodes:+$nodes,}{\\"status\\":\\"COMPLETED\\",\\"conclusion\\":\\"FAILURE\\",\\"app\\":{\\"slug\\":\\"codeql\\"},\\"workflowRun\\":null}"
    done
  fi
  if [ "$more" = true ]; then info="{\\"hasNextPage\\":true,\\"endCursor\\":\\"page$((page + 1))\\"}"; else info="{\\"hasNextPage\\":false,\\"endCursor\\":null}"; fi
  printf '{"data":{"repository":{"object":{"checkSuites":{"nodes":[%s],"pageInfo":%s}}}}}' "$nodes" "$info" | jq -r "$filter"
  # Partial-then-fail: rows above were already printed, then gh dies, from the second snapshot on.
  if [ -n "\${GH_EXIT_AFTER_OUTPUT:-}" ] && [ "$c" -ge 2 ]; then exit "\${GH_EXIT_AFTER_OUTPUT}"; fi
  exit 0
fi
if [ "$*" = "run view $3 --log-failed" ]; then
  echo "\${GH_LOG_TEXT:-log excerpt for $3}"; exit "\${GH_LOG_EXIT:-1}"
fi
case "$1 $2" in
  "run list" | "run watch" | "run view") violate "actions rest: $*"; rate_limited;;
esac
violate "unknown: $*"
exit 64
`;

const binDir = mkdtempSync(join(tmpdir(), "watch-ci-test-"));
writeFileSync(join(binDir, "gh"), FAKE_GH);
chmodSync(join(binDir, "gh"), 0o755);
writeFileSync(join(binDir, "sleep"), '#!/usr/bin/env bash\necho "$1" >> "$SLEEP_LOG"\nexit 0\n');
chmodSync(join(binDir, "sleep"), 0o755);

afterAll(() => rmSync(binDir, { recursive: true, force: true }));

let scenario = 0;
// Handled gh failures used to fire the ERR trap inside their $(...) subshell
// as well, so every scenario asserts this message is absent; the unhandled
// table opts out via { unhandled: true } and counts it itself.
const TRAP_MESSAGE = "unexpected command failure";
// Spawns the script with the given argv exactly; run() below is the common
// flags-then-SHA shape. Returns the snapshot count (first-page graphql calls)
// and every sleep the script asked for, so a scenario pins its whole polling shape.
function runArgv(env: Record<string, string>, argv: string[], opts: { unhandled?: boolean } = {}) {
  scenario += 1;
  const violations = join(binDir, `violations-${scenario}`);
  const calls = join(binDir, `calls-${scenario}`);
  const sleepLog = join(binDir, `sleeps-${scenario}`);
  const result = Bun.spawnSync(["bash", SCRIPT, ...argv], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      GH_VIOLATIONS: violations,
      GH_CALLS: calls,
      SLEEP_LOG: sleepLog,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const readOr = (path: string, fallback: string) => {
    try {
      return readFileSync(path, "utf-8");
    } catch {
      return fallback;
    }
  };
  expect(readOr(violations, "")).toBe("");
  const stderr = result.stderr.toString();
  if (!opts.unhandled) {
    expect(stderr).not.toContain(TRAP_MESSAGE);
  }
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr,
    snapshots: Number(readOr(calls, "0")),
    sleeps: readOr(sleepLog, "").split("\n").filter(Boolean),
  };
}

// The default expectation pins the fixture's default workflow name so each
// scenario keeps testing its own branch, not the expected-workflow gate
// (which has dedicated tests below).
const DEFAULT_ARGS = ["--expect-workflow", "CI-1"];

function run(
  env: Record<string, string>,
  args: string[] = DEFAULT_ARGS,
  opts: { unhandled?: boolean } = {},
) {
  return runArgv(env, [...args, "deadbeef"], opts);
}

/** Same workflow id and name for every listed run id: the retrigger fixtures. */
function sameWorkflow(ids: string[], name = "CI"): Record<string, string> {
  const env: Record<string, string> = {};
  for (const id of ids) {
    env[`GH_NAME_${id}`] = name;
    env[`GH_WF_${id}`] = "77";
  }
  return env;
}

describe("watch-ci.sh exit matrix", () => {
  test("gh broken at discovery exits 2, not 1", () => {
    const r = run({ GH_GQL_EXIT: "4" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no workflow runs registered");
    expect(r.stdout).toBe("");
    expect(r.sleeps).toEqual(["3", "3", "3", "3"]);
  });

  test("a GraphQL rate limit is a gh failure: exits 2 with no REST fallback", () => {
    // The fake's REST endpoints record a violation, so a fallback to
    // gh run list would fail the empty-violations assertion in runArgv.
    const r = run({ GH_GQL_EXIT: "1" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no workflow runs registered");
    expect(r.stdout).toBe("");
  });

  test("an unresolvable repository exits 2 before any discovery", () => {
    const r = run({ GH_REPO_EXIT: "4" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("cannot resolve the repository");
    expect(r.stdout).toBe("");
    expect(r.snapshots).toBe(0);
  });

  test("no runs registered exits 2 with no verdict", () => {
    const r = run({ GH_RUNS: "" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no workflow runs registered");
    expect(r.stdout).toBe("");
    expect(r.snapshots).toBe(5);
  });

  test("runs registering on the third discovery attempt still succeed", () => {
    const r = run({ GH_RUNS: "1", GH_READY_AFTER: "3" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("pass: CI-1 (1)\n");
    // Two registration sleeps, then the completed snapshot is judged at once.
    expect(r.snapshots).toBe(3);
    expect(r.sleeps).toEqual(["3", "3"]);
  });

  test("all green exits 0 with a pass line per run; external suites are not runs", () => {
    // The two CodeQL-style suites carry FAILURE and no workflowRun: judged,
    // they would exit 1; counted, they would break the pass-line shape.
    // One page is one atomic read: exactly one graphql call.
    const r = run({ GH_RUNS: "1 2", GH_EXTERNAL_SUITES: "2" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("pass: CI-2 (2)\npass: CI-1 (1)\n");
    expect(r.stderr).toBe("");
    expect(r.snapshots).toBe(1);
    expect(r.sleeps).toEqual([]);
  });

  test("a red run exits 1 and survives a failing --log-failed pipeline", () => {
    const r = run({ GH_RUNS: "1 2", GH_CONCLUSION_1: "failure", GH_LOG_EXIT: "3" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("pass: CI-2 (2)\nFAIL(failure): CI-1 (1)\nlog excerpt for 1\n");
  });

  // The incident this design exists for: every Actions REST endpoint answers
  // a 403 secondary rate limit for an hour while GraphQL keeps answering. The
  // verdict must still be reached; only the log excerpt shows the limit.
  const incidentCases: {
    id: string;
    env: Record<string, string>;
    code: number;
    stdout: string;
  }[] = [
    {
      id: "green fleet",
      env: { GH_RUNS: "1 2" },
      code: 0,
      stdout: "pass: CI-2 (2)\npass: CI-1 (1)\n",
    },
    {
      id: "red run, log fetch rate-limited",
      env: {
        GH_RUNS: "1 2",
        GH_CONCLUSION_1: "failure",
        GH_LOG_TEXT: "HTTP 403: API rate limit exceeded for user ID 1",
        GH_LOG_EXIT: "1",
      },
      code: 1,
      stdout:
        "pass: CI-2 (2)\nFAIL(failure): CI-1 (1)\nHTTP 403: API rate limit exceeded for user ID 1\n",
    },
  ];
  test.each(incidentCases)(
    "Actions REST rate-limited while GraphQL answers still reaches a verdict: $id",
    (c) => {
      const r = run(c.env);
      expect(r.code, c.id).toBe(c.code);
      expect(r.stdout, c.id).toBe(c.stdout);
      expect(r.stderr, c.id).toBe("");
    },
  );

  test("a failed run on the second page of check suites is still judged", () => {
    // Page size 2 puts run 3 on page 2. An unpaginated read would see only
    // runs 1 and 2, print their passes, and exit 0 over the hidden failure.
    // Two pages are not one atomic read, so the snapshot is read twice.
    const r = run({ GH_RUNS: "1 2 3", GH_PAGE_SIZE: "2", GH_CONCLUSION_3: "failure" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(
      "FAIL(failure): CI-3 (3)\nlog excerpt for 3\npass: CI-2 (2)\npass: CI-1 (1)\n",
    );
    expect(r.snapshots).toBe(2);
  });

  test("a multi-page snapshot that changes between reads is judged from the confirmed read", () => {
    // Read 1 sees runs 1-2; run 3 (a failure) registers before read 2, which
    // read 3 confirms. Judging read 1 would exit 0 over the failure.
    const r = run({
      GH_RUNS: "1 2",
      GH_RUNS2: "1 2 3",
      GH_PAGE_SIZE: "1",
      GH_CONCLUSION_3: "failure",
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe(
      "FAIL(failure): CI-3 (3)\nlog excerpt for 3\npass: CI-2 (2)\npass: CI-1 (1)\n",
    );
    expect(r.snapshots).toBe(3);
  });

  test("identical statuses across two multi-page reads still re-read when a run's updatedAt moved", () => {
    // Runs A and B on separate pages: A is re-run and completes again between
    // the two reads, so both read success/success while a re-run was in
    // flight. Only the updatedAt column can see it; read 3 must confirm.
    const r = run({ GH_RUNS: "1 2", GH_RUNS2: "1@@t2 2", GH_PAGE_SIZE: "1" }, [
      "--expect-workflow",
      "CI-1",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("pass: CI-2 (2)\npass: CI-1 (1)\n");
    expect(r.snapshots).toBe(3);
  });

  test("a multi-page snapshot changing on every read is refused after 5 rounds, never judged", () => {
    // Reads alternate between two multi-page run lists, so no two
    // consecutive reads agree. Each of the 5 registration attempts spends
    // its 5 rounds.
    const env: Record<string, string> = { GH_PAGE_SIZE: "1" };
    for (let read = 1; read <= 25; read += 1) {
      env[read === 1 ? "GH_RUNS" : `GH_RUNS${read}`] = read % 2 === 1 ? "1 2" : "1 2 3";
    }
    const r = run(env);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      "kept changing across 5 multi-page reads; refusing to judge a partial snapshot",
    );
    expect(r.stderr).toContain("no workflow runs registered");
    expect(r.stdout).toBe("");
    expect(r.snapshots).toBe(25);
  });

  test("check suites spanning more than 10 pages are refused, never judged partially", () => {
    const ids = Array.from({ length: 11 }, (_, i) => String(i + 1));
    const r = run({ GH_RUNS: ids.join(" "), GH_PAGE_SIZE: "1" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(
      "span more than 10 pages of 100; refusing to judge a partial snapshot",
    );
    expect(r.stderr).toContain("no workflow runs registered");
    expect(r.stdout).toBe("");
  });

  // Every non-completed status keeps the poll loop going at the 60 s interval;
  // the completed snapshot is judged, whatever the run was doing before.
  const runningCases = ["queued", "in_progress", "waiting", "pending", "requested"].map((s) => ({
    status: s,
  }));
  test.each(runningCases)("a $status run is polled every 60 s until completed", (c) => {
    const r = run({ GH_RUNS: `1@${c.status}`, GH_RUNS3: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("pass: CI-1 (1)\n");
    expect(r.snapshots).toBe(3);
    expect(r.sleeps).toEqual(["60", "60"]);
  });

  test("a transient poll failure heals on the bounded retry: exits 0, never 2", () => {
    // Call 1 registers the running run; the first poll (call 2) dies; its
    // retry (call 3) returns the completed snapshot, which is judged.
    const r = run({ GH_RUNS: "1@in_progress", GH_RUNS2: "1", GH_FAIL_CALLS: "2" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("pass: CI-1 (1)\n");
    expect(r.stderr).toBe("");
    expect(r.snapshots).toBe(3);
    expect(r.sleeps).toEqual(["60", "2"]);
  });

  test("a poll failing outright after the retries exits 2 with no verdict", () => {
    const r = run({ GH_RUNS: "1@in_progress", GH_FAIL_CALLS: "2 3 4" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("refusing to judge without a fresh snapshot");
    expect(r.stdout).toBe("");
    expect(r.snapshots).toBe(4);
    expect(r.sleeps).toEqual(["60", "2", "2"]);
  });

  test("a poll returning an empty snapshot exits 2, never judges the stale one", () => {
    const r = run({ GH_RUNS: "1@in_progress", GH_RUNS2: "" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("refusing to judge without a fresh snapshot");
    expect(r.stdout).toBe("");
    expect(r.snapshots).toBe(4);
  });

  test("a poll failing AFTER partial output exits 2, never judges the fragment", () => {
    // gh can die mid-stream after printing some rows; a fragment accepted as
    // a complete snapshot would judge a selection with runs missing from it.
    const r = run({ GH_RUNS: "1@in_progress", GH_RUNS2: "2 1", GH_EXIT_AFTER_OUTPUT: "3" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("refusing to judge without a fresh snapshot");
    expect(r.stdout).toBe("");
    expect(r.snapshots).toBe(4);
  });

  test("a completed run without a conclusion exits 2, never FAIL or pass", () => {
    const r = run({ GH_RUNS: "1", GH_CONCLUSION_1: "null" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("run 1 (CI-1) is completed but carries no conclusion");
    expect(r.stdout).toBe("");
  });

  test("a red run outranks a gh hiccup: exits 1 with both reported", () => {
    const r = run({ GH_RUNS: "1 2", GH_CONCLUSION_1: "failure", GH_CONCLUSION_2: "null" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("FAIL(failure): CI-1 (1)\nlog excerpt for 1\n");
    expect(r.stderr).toContain("run 2 (CI-2) is completed but carries no conclusion");
  });

  // sort and tr die inside compute_missing (registration polling); sleep dies
  // at the first poll of a running run. Exactly one message: a subshell
  // re-raise must not print its own.
  const unhandledCases: { id: string; env: Record<string, string>; reason: string }[] = [
    { id: "sort", env: {}, reason: "unguarded plumbing must reach the trap, not set -e" },
    { id: "tr", env: {}, reason: "the expectation split must fail loudly, not empty the gate" },
    {
      id: "sleep",
      env: { GH_RUNS: "1@in_progress" },
      reason: "a failure in the poll loop must surface as tooling trouble",
    },
  ];
  test.each(unhandledCases)(
    "an unguarded internal tool failure exits 2 with no verdict, never 1 or a vacuous 0: $id ($reason)",
    (c) => {
      const failDir = join(binDir, `${c.id}-fail-bin`);
      mkdirSync(failDir, { recursive: true });
      writeFileSync(join(failDir, c.id), "#!/usr/bin/env bash\nexit 1\n");
      chmodSync(join(failDir, c.id), 0o755);
      const r = run(
        { GH_RUNS: "1", PATH: `${failDir}:${binDir}:${process.env.PATH ?? ""}`, ...c.env },
        DEFAULT_ARGS,
        { unhandled: true },
      );
      expect(r.code, c.id).toBe(2);
      expect(r.stderr.split(TRAP_MESSAGE).length - 1, c.id).toBe(1);
      expect(r.stdout, c.id).toBe("");
    },
  );

  test("an older cancelled run of a re-triggered workflow is superseded, not red", () => {
    // Unsorted ids of different digit lengths pin the numeric (not lexical)
    // newest-run pick, and the glob-metacharacter name pins the quoting in
    // the membership test. The cancelled conclusion on run 9 is a trap: if
    // the script judged the superseded run, it would surface as FAIL.
    const name = "CI *?[x]";
    const r = run(
      { GH_RUNS: "9 100", ...sameWorkflow(["9", "100"], name), GH_CONCLUSION_9: "cancelled" },
      ["--expect-workflow", name],
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`superseded: ${name} (9)\npass: ${name} (100)\n`);
  });

  test("an older superseded run still running never delays judgment", () => {
    // Only the latest run per workflow is waited on: the snapshot with run 2
    // completed is judged at once, although run 1 is still in progress.
    const r = run({ GH_RUNS: "2 1@in_progress", ...sameWorkflow(["1", "2"]) }, []);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("superseded: CI (1)\npass: CI (2)\n");
    expect(r.snapshots).toBe(1);
    expect(r.sleeps).toEqual([]);
  });

  test("runs without a workflow id are judged individually, never superseded", () => {
    const r = run({
      GH_RUNS: "1 2",
      GH_WF_1: "null",
      GH_WF_2: "null",
      GH_CONCLUSION_1: "cancelled",
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("pass: CI-2 (2)\nFAIL(cancelled): CI-1 (1)\nlog excerpt for 1\n");
  });

  // The flag loop breaks at the first non-flag word, so a flag placed after the
  // SHA used to be dropped silently, leaving the default expectation in force:
  // a green bystander run could then exit 0, the vacuous green the flag prevents.
  const trailingCases: { id: string; trailing: string[] }[] = [
    { id: "misplaced flag", trailing: ["--expect-workflow", "Deploy"] },
    { id: "stray word", trailing: ["oops"] },
  ];
  test.each(trailingCases)(
    "anything after the SHA is a usage error, never silently dropped: $id",
    (c) => {
      const r = runArgv({ GH_RUNS: "1" }, ["deadbeef", ...c.trailing]);
      expect(r.code, c.id).toBe(2);
      expect(r.stderr, c.id).toContain("unexpected argument(s) after the SHA");
      expect(r.stderr, c.id).toContain(c.trailing.join(" "));
      expect(r.stdout, c.id).toBe("");
      expect(r.snapshots, c.id).toBe(0);
    },
  );

  test("a run cancelled by a mid-watch retrigger is superseded after the next poll", () => {
    // The first snapshot sees only run 1, still running; the retrigger (run
    // 2, same workflow) appears queued while the script waits and run 1 is
    // cancelled by the concurrency group. The poll must wait for run 2 and
    // demote run 1 to superseded instead of reporting its cancellation.
    // No --expect-workflow here: the runs are named "CI", so this scenario
    // also pins the script's default expectation.
    const r = run(
      {
        GH_RUNS: "1@in_progress",
        GH_RUNS2: "2@queued 1",
        GH_RUNS3: "2 1",
        ...sameWorkflow(["1", "2"]),
        GH_CONCLUSION_1: "cancelled",
      },
      [],
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("superseded: CI (1)\npass: CI (2)\n");
    expect(r.snapshots).toBe(3);
    expect(r.sleeps).toEqual(["60", "60"]);
  });

  test("a run appearing while the previous retrigger runs is still waited on", () => {
    // Snapshot 2 adds run 2, snapshot 3 adds run 3 while run 2 still runs.
    // The selection is recomputed from every snapshot, so judgment waits for
    // run 3 and reports runs 1 and 2 as superseded exactly once each.
    const r = run(
      {
        GH_RUNS: "1@in_progress",
        GH_RUNS2: "2@in_progress 1",
        GH_RUNS3: "3@in_progress 2 1",
        GH_RUNS4: "3 2 1",
        ...sameWorkflow(["1", "2", "3"]),
        GH_CONCLUSION_1: "cancelled",
        GH_CONCLUSION_2: "cancelled",
      },
      [],
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("superseded: CI (2)\nsuperseded: CI (1)\npass: CI (3)\n");
    expect(r.snapshots).toBe(4);
  });

  test("a re-run flipping a completed run back to queued is waited on again", () => {
    // GitHub re-runs keep the run id; the only signal is the status leaving
    // completed. The registration snapshot already shows run 1 re-queued, so
    // the script must poll rather than judge the stale conclusion.
    const r = run({ GH_RUNS: "1@queued", GH_RUNS2: "1", GH_CONCLUSION_1: "success" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("pass: CI-1 (1)\n");
    expect(r.snapshots).toBe(2);
    expect(r.sleeps).toEqual(["60"]);
  });

  test("a cancelled latest run with no newer run is a real failure", () => {
    const r = run({ GH_RUNS: "1", GH_CONCLUSION_1: "cancelled" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("FAIL(cancelled): CI-1 (1)\nlog excerpt for 1\n");
  });

  test("a skipped conclusion counts as pass", () => {
    const r = run({ GH_RUNS: "1", GH_CONCLUSION_1: "skipped" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("skip: CI-1 (1)\n");
  });

  test("green bystanders with the expected workflow absent exit 2, never 0", () => {
    // THE hole this gate closes: the push's event fails to register the CI
    // run, discovery finds only other workflows on the SHA, and all of them
    // pass. No flag, so the default expectation "CI" applies; the runs are
    // named CI-1 and CI-2, which must NOT satisfy it.
    const r = run({ GH_RUNS: "1 2" }, []);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("expected workflow(s) not found for deadbeef: CI;");
    expect(r.stderr).toContain("discovered only: CI-1, CI-2");
    expect(r.stderr).toContain("gh workflow run ci.yml --ref <branch>");
    expect(r.stdout).toBe("pass: CI-2 (2)\npass: CI-1 (1)\n");
    // The registration burst keeps polling for the gate through its window.
    expect(r.snapshots).toBe(5);
    expect(r.sleeps).toEqual(["3", "3", "3", "3"]);
  });

  test("a red run outranks a missing expected workflow: exits 1, message still printed", () => {
    const r = run({ GH_RUNS: "1", GH_CONCLUSION_1: "failure" }, []);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("FAIL(failure): CI-1 (1)\nlog excerpt for 1\n");
    expect(r.stderr).toContain("expected workflow(s) not found");
  });

  test("--expect-workflow overrides the default expectation", () => {
    const r = run({ GH_RUNS: "1", GH_NAME_1: "Build" }, ["--expect-workflow", "Build"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("pass: Build (1)\n");
  });

  test("comma-separated expectations each must be present", () => {
    const r = run({ GH_RUNS: "1", GH_NAME_1: "Build" }, ["--expect-workflow", "Build,Deploy"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("expected workflow(s) not found for deadbeef: Deploy;");
    expect(r.stdout).toBe("pass: Build (1)\n");
  });

  test("repeatable --expect-workflow flags with every name discovered exit 0", () => {
    const r = run({ GH_RUNS: "1 2", GH_NAME_1: "Build", GH_NAME_2: "Deploy" }, [
      "--expect-workflow",
      "Build",
      "--expect-workflow",
      "Deploy",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("pass: Deploy (2)\npass: Build (1)\n");
    expect(r.stderr).toBe("");
  });

  // Only one of the two expected names is discovered, so a parser keeping
  // just the first or just the last flag would exit 0 on one of these rows;
  // accumulation is the only reading that reports a missing name on both.
  const accumulateCases: { id: string; name: string; missing: string; reason: string }[] = [
    {
      id: "only Build discovered",
      name: "Build",
      missing: "Deploy",
      reason: "the second flag is not dropped by the first",
    },
    {
      id: "only Deploy discovered",
      name: "Deploy",
      missing: "Build",
      reason: "the first flag survives the second",
    },
  ];
  test.each(accumulateCases)(
    "repeatable --expect-workflow flags accumulate: neither flag drops the other: $id ($reason)",
    (c) => {
      const r = run({ GH_RUNS: "1", GH_NAME_1: c.name }, [
        "--expect-workflow",
        "Build",
        "--expect-workflow",
        "Deploy",
      ]);
      expect(r.code, c.id).toBe(2);
      expect(r.stdout, c.id).toBe(`pass: ${c.name} (1)\n`);
      expect(r.stderr, c.id).toContain(
        `expected workflow(s) not found for deadbeef: ${c.missing};`,
      );
    },
  );

  test("delimiter-only, trailing-comma, and empty expectations are usage errors, never a disabled gate", () => {
    // A value that splits to zero names ("" or "," here) would otherwise
    // leave nothing to check and let green bystanders exit 0 - the exact hole
    // the gate exists to close, reopened through its own flag.
    for (const value of ["", ",", "Build,", ",Build", "Build,,Deploy"]) {
      const r = run({ GH_RUNS: "1" }, ["--expect-workflow", value]);
      expect(r.code, JSON.stringify(value)).toBe(2);
      expect(r.stderr, JSON.stringify(value)).toContain(
        `--expect-workflow requires a workflow name (empty entry in "${value}")`,
      );
      expect(r.stdout, JSON.stringify(value)).toBe("");
    }
  });

  test("--expect-workflow as the last argument is a usage error, not a silent default", () => {
    const r = runArgv({}, ["--expect-workflow"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--expect-workflow requires a workflow name");
    expect(r.stderr).not.toContain("empty entry");
    expect(r.stdout).toBe("");
  });

  test("newlines in an expectation are usage errors, never a shrunken gate", () => {
    // The expectation list is matched line-by-line and command substitution
    // strips trailing newlines, so "\n" would empty the set, "CI\n" would
    // silently become "CI", and "A\nB" would become two expectations.
    for (const value of ["\n", "CI\n", "\nCI", "A\nB"]) {
      const r = run({ GH_RUNS: "1" }, ["--expect-workflow", value]);
      expect(r.code, JSON.stringify(value)).toBe(2);
      expect(r.stderr, JSON.stringify(value)).toContain(
        "--expect-workflow value must not contain newlines",
      );
      expect(r.stdout, JSON.stringify(value)).toBe("");
    }
  });

  test("a bystander registering before the expected workflow does not trip the gate", () => {
    // The first TWO snapshots have only the fast bystander; the gate
    // workflow registers on the third poll. The registration-lag loop must
    // keep polling within its bounded window instead of reporting the
    // merely-late gate as missing.
    const r = run({ GH_RUNS: "2", GH_RUNS3: "2 1", GH_NAME_1: "CI", GH_NAME_2: "Bystander" }, []);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("pass: Bystander (2)\npass: CI (1)\n");
    expect(r.stderr).toBe("");
    expect(r.snapshots).toBe(3);
    expect(r.sleeps).toEqual(["3", "3"]);
  });

  test("a gate workflow registering after the registration window heals at judgment", () => {
    // Five registration polls see only the running bystander; the gate run
    // appears in the first watch poll. The missing check runs against the
    // final snapshot, so the late gate is judged, not reported missing.
    const r = run(
      { GH_RUNS: "2@in_progress", GH_RUNS6: "2 1", GH_NAME_1: "CI", GH_NAME_2: "Bystander" },
      [],
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("pass: Bystander (2)\npass: CI (1)\n");
    expect(r.stderr).toBe("");
    expect(r.snapshots).toBe(6);
    expect(r.sleeps).toEqual(["3", "3", "3", "3", "60"]);
  });
});
