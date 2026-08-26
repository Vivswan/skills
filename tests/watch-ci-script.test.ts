import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";

// Exit-matrix test for the watch-ci helper: a fake `gh` on PATH drives every
// branch of the script, pinning the contract its reviews established - a red
// run exits 1, a gh operational failure exits 2 (never 1), a green fleet
// exits 0, and a red run outranks a gh hiccup. The unit of judgment is the
// workflow: only the latest run per workflow is judged (re-decided by a
// capped wait/re-discover fixed-point loop, so mid-watch retriggers
// supersede rather than FAIL), and older re-triggered runs are reported as
// superseded without affecting the exit code. A fake `sleep` keeps the
// discovery-retry scenarios instant.

const SCRIPT = join(ROOT, "skills", "watch-ci-after-push", "scripts", "watch-ci.sh");

// Dispatch validates the EXACT invocations watch-ci.sh makes. Every mismatch
// is appended to the GH_VIOLATIONS file, which each test asserts is empty -
// that is the guaranteed detection channel, since the script normalizes some
// list/view failures to exit 2 and deliberately ignores the watch exit
// status. list/view mismatches also exit 64 as a secondary signal.
// GH_LIST_IDS entries are "id" or "id@attempt" (attempt defaults to 1);
// GH_LIST_IDS2/GH_LIST_IDS3 swap in later discovery snapshots.
const FAKE_GH = `#!/usr/bin/env bash
violate() { echo "$*" >> "\${GH_VIOLATIONS}"; }
jq_view='"\\(.conclusion)\\t\\(.name)"'
jq_list='.[] | "\\(.databaseId)\\t=\\(.attempt)\\t=\\(.workflowDatabaseId)\\t\\(.workflowName)"'
if [ "$1 $2" = "run list" ]; then
  if [ "$*" != "run list --commit deadbeef --limit 100 --json databaseId,attempt,workflowDatabaseId,workflowName --jq $jq_list" ]; then
    violate "list: $*"; exit 64
  fi
  [ "\${GH_LIST_EXIT:-0}" -ne 0 ] && exit "\${GH_LIST_EXIT}"
  if [ -n "\${GH_LIST_READY_AFTER:-}" ]; then
    n=0; [ -f "\${GH_LIST_COUNTER}" ] && n="$(cat "\${GH_LIST_COUNTER}")"
    n=$((n + 1)); printf '%s' "$n" > "\${GH_LIST_COUNTER}"
    [ "$n" -lt "\${GH_LIST_READY_AFTER}" ] && exit 0
  fi
  ids="\${GH_LIST_IDS:-}"
  if [ -n "\${GH_LIST_IDS2+x}" ]; then
    c=0; [ -f "\${GH_LIST_CALLS}" ] && c="$(cat "\${GH_LIST_CALLS}")"
    c=$((c + 1)); printf '%s' "$c" > "\${GH_LIST_CALLS}"
    [ "$c" -ge 2 ] && ids="\${GH_LIST_IDS2}"
    if [ -n "\${GH_LIST_IDS3+x}" ] && [ "$c" -ge 3 ]; then ids="\${GH_LIST_IDS3}"; fi
  fi
  for entry in $ids; do
    lid="\${entry%%@*}"
    att=1; case "$entry" in *@*) att="\${entry#*@}";; esac
    nvar="GH_NAME_\${lid}"
    wvar="GH_WF_\${lid}"
    printf '%s\\t=%s\\t=%s\\t%s\\n' "$lid" "$att" "\${!wvar-wf-$lid}" "\${!nvar:-CI-$lid}"
  done
  exit 0
fi
if [ "$1 $2" = "run watch" ]; then
  [ "$#" -eq 3 ] || violate "watch: $*"
  exit "\${GH_WATCH_EXIT:-0}"
fi
if [ "$1 $2" = "run view" ]; then
  id="$3"
  if [ "$*" = "run view $id --log-failed" ]; then
    echo "log excerpt for $id"; exit "\${GH_LOG_EXIT:-1}"
  fi
  if [ "$*" != "run view $id --json name,conclusion --jq $jq_view" ]; then
    violate "view: $*"; exit 64
  fi
  var="GH_VIEW_\${id}"
  spec="\${!var:-success}"
  nvar="GH_NAME_\${id}"
  name="\${!nvar:-CI-$id}"
  case "$spec" in
    FAILCMD) exit 4;;
    EMPTY) printf '\\t%s\\n' "$name"; exit 0;;
    *) printf '%s\\t%s\\n' "$spec" "$name"; exit 0;;
  esac
fi
violate "unknown: $*"
exit 64
`;

const binDir = mkdtempSync(join(tmpdir(), "watch-ci-test-"));
writeFileSync(join(binDir, "gh"), FAKE_GH);
chmodSync(join(binDir, "gh"), 0o755);
writeFileSync(join(binDir, "sleep"), "#!/usr/bin/env bash\nexit 0\n");
chmodSync(join(binDir, "sleep"), 0o755);

afterAll(() => rmSync(binDir, { recursive: true, force: true }));

let scenario = 0;
function run(env: Record<string, string>) {
  scenario += 1;
  const violations = join(binDir, `violations-${scenario}`);
  const result = Bun.spawnSync(["bash", SCRIPT, "deadbeef"], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      GH_VIOLATIONS: violations,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  let violated = "";
  try {
    violated = readFileSync(violations, "utf-8");
  } catch {
    // no violations file means no violations
  }
  expect(violated).toBe("");
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

describe("watch-ci.sh exit matrix", () => {
  test("gh broken at discovery exits 2, not 1", () => {
    const r = run({ GH_LIST_EXIT: "4" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no workflow runs registered");
  });

  test("no runs registered exits 2", () => {
    const r = run({ GH_LIST_IDS: "" });
    expect(r.code).toBe(2);
  });

  test("runs registering on the third discovery attempt still succeed", () => {
    const counter = join(binDir, "lag-counter");
    const r = run({ GH_LIST_IDS: "1", GH_LIST_READY_AFTER: "3", GH_LIST_COUNTER: counter });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pass: CI-1 (1)");
    // 3 polls until runs register, plus the single post-watch re-discovery.
    expect(readFileSync(counter, "utf-8")).toBe("4");
  });

  test("all green exits 0 with a pass line per run", () => {
    const r = run({ GH_LIST_IDS: "1 2" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pass: CI-1 (1)");
    expect(r.stdout).toContain("pass: CI-2 (2)");
  });

  test("a red run exits 1 and survives a failing --log-failed pipeline", () => {
    const r = run({ GH_LIST_IDS: "1 2", GH_VIEW_1: "failure", GH_LOG_EXIT: "3" });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("FAIL(failure): CI-1 (1)");
    expect(r.stdout).toContain("log excerpt for 1");
    expect(r.stdout).toContain("pass: CI-2 (2)");
  });

  test("a gh failure on one run exits 2, not 1", () => {
    const r = run({ GH_LIST_IDS: "1 2", GH_VIEW_1: "FAILCMD" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("gh failed while checking run 1");
    expect(r.stdout).toContain("pass: CI-2 (2)");
  });

  test("an unconcluded run (watch aborted early) exits 2", () => {
    const r = run({ GH_LIST_IDS: "1", GH_VIEW_1: "EMPTY", GH_WATCH_EXIT: "7" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not concluded");
  });

  test("a jq-rendered null conclusion also exits 2, never FAIL(null)", () => {
    const r = run({ GH_LIST_IDS: "1", GH_VIEW_1: "null" });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not concluded");
    expect(r.stdout).not.toContain("FAIL(null)");
  });

  test("a red run outranks a gh hiccup: exits 1", () => {
    const r = run({ GH_LIST_IDS: "1 2", GH_VIEW_1: "failure", GH_VIEW_2: "FAILCMD" });
    expect(r.code).toBe(1);
  });

  test("an older cancelled run of a re-triggered workflow is superseded, not red", () => {
    // Unsorted ids of different digit lengths pin the numeric (not lexical)
    // newest-run pick, and the glob-metacharacter name pins the quoting in
    // the membership test. GH_VIEW_9 is a trap: if the script judged the
    // superseded run instead of skipping it, the cancelled conclusion would
    // surface as FAIL and exit 1.
    const name = "CI *?[x]";
    const r = run({
      GH_LIST_IDS: "9 100",
      GH_WF_9: "77",
      GH_WF_100: "77",
      GH_NAME_9: name,
      GH_NAME_100: name,
      GH_VIEW_9: "cancelled",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`superseded: ${name} (9)`);
    expect(r.stdout).toContain(`pass: ${name} (100)`);
    expect(r.stdout).not.toContain("FAIL");
  });

  test("runs without a workflow id are judged individually, never superseded", () => {
    const r = run({ GH_LIST_IDS: "1 2", GH_WF_1: "null", GH_WF_2: "null", GH_VIEW_1: "cancelled" });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("FAIL(cancelled): CI-1 (1)");
    expect(r.stdout).toContain("pass: CI-2 (2)");
    expect(r.stdout).not.toContain("superseded");
  });

  test("an empty workflow-id field neither collapses nor groups", () => {
    // Tab is IFS whitespace, so an unguarded empty middle field would shift
    // the name into the id slot and same-name runs would supersede each
    // other; the sentinel-prefixed field must keep both runs judged.
    const r = run({
      GH_LIST_IDS: "1 2",
      GH_WF_1: "",
      GH_WF_2: "",
      GH_NAME_1: "CI",
      GH_NAME_2: "CI",
      GH_VIEW_1: "cancelled",
    });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("FAIL(cancelled): CI (1)");
    expect(r.stdout).toContain("pass: CI (2)");
    expect(r.stdout).not.toContain("superseded");
  });

  test("a run cancelled by a mid-watch retrigger is superseded after re-discovery", () => {
    // The first discovery sees only run 1; the retrigger (run 2, same
    // workflow) appears while the script waits. The post-watch re-discovery
    // must re-select run 2 and demote run 1 to superseded instead of
    // reporting its concurrency cancellation as FAIL.
    const calls = join(binDir, "list-calls");
    const r = run({
      GH_LIST_IDS: "1",
      GH_LIST_IDS2: "2 1",
      GH_LIST_CALLS: calls,
      GH_WF_1: "77",
      GH_WF_2: "77",
      GH_NAME_1: "CI",
      GH_NAME_2: "CI",
      GH_VIEW_1: "cancelled",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("superseded: CI (1)");
    expect(r.stdout).toContain("pass: CI (2)");
    expect(r.stdout).not.toContain("FAIL");
  });

  test("a run appearing in the second wait batch is still converged on", () => {
    // Wait batch 1 watches run 1; run 2 appears (second snapshot). Wait
    // batch 2 watches run 2; run 3 appears (third snapshot). The fixed-point
    // loop must keep re-selecting until the selection is stable and judge
    // only run 3, with runs 1 and 2 demoted to superseded.
    const calls = join(binDir, "list-calls-batch2");
    const r = run({
      GH_LIST_IDS: "1",
      GH_LIST_IDS2: "2 1",
      GH_LIST_IDS3: "3 2 1",
      GH_LIST_CALLS: calls,
      GH_WF_1: "77",
      GH_WF_2: "77",
      GH_WF_3: "77",
      GH_NAME_1: "CI",
      GH_NAME_2: "CI",
      GH_NAME_3: "CI",
      GH_VIEW_1: "cancelled",
      GH_VIEW_2: "cancelled",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("superseded: CI (2)");
    expect(r.stdout).toContain("superseded: CI (1)");
    expect(r.stdout).toContain("pass: CI (3)");
    expect(r.stdout).not.toContain("FAIL");
  });

  test("a failed or empty re-discovery exits 2, never judges the stale snapshot", () => {
    const calls = join(binDir, "list-calls-refresh");
    const r = run({ GH_LIST_IDS: "1", GH_LIST_IDS2: "", GH_LIST_CALLS: calls });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("re-discovery after the watch returned nothing");
    expect(r.stdout).not.toContain("pass:");
  });

  test("a re-run (same id, higher attempt) is waited on again before judgment", () => {
    // GitHub re-runs keep the run id and increment attempt, so an id-only
    // convergence check would read the re-discovery as "unchanged" and judge
    // the in-flight re-run. The id:attempt signature must force one more
    // wait round: 3 list calls (initial, changed, stable), not 2.
    const calls = join(binDir, "list-calls-rerun");
    const r = run({ GH_LIST_IDS: "1@1", GH_LIST_IDS2: "1@2", GH_LIST_CALLS: calls });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pass: CI-1 (1)");
    expect(readFileSync(calls, "utf-8")).toBe("3");
  });

  test("a cancelled latest run with no newer run is a real failure", () => {
    const r = run({ GH_LIST_IDS: "1", GH_VIEW_1: "cancelled" });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("FAIL(cancelled): CI-1 (1)");
  });

  test("a skipped conclusion counts as pass", () => {
    const r = run({ GH_LIST_IDS: "1", GH_VIEW_1: "skipped" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("skip: CI-1 (1)");
    expect(r.stdout).not.toContain("FAIL");
  });
});
