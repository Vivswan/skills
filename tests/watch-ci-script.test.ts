import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
// superseded without affecting the exit code. The expected-workflow gate
// (default "CI", overridden by --expect-workflow) turns an absent gate
// workflow into exit 2 with evidence, never a vacuous pass. A fake `sleep`
// keeps the discovery-retry scenarios instant.

const SCRIPT = join(ROOT, "skills", "watch-ci-after-push", "scripts", "watch-ci.sh");

// Dispatch validates the EXACT invocations watch-ci.sh makes. Every mismatch
// is appended to the GH_VIOLATIONS file, which each test asserts is empty -
// that is the guaranteed detection channel, since the script normalizes some
// list/view failures to exit 2 and deliberately ignores the watch exit
// status. list/view mismatches also exit 64 as a secondary signal.
// GH_LIST_IDS entries are "id" or "id@attempt" (attempt defaults to 1); with
// GH_LIST_CALLS set, GH_LIST_IDS<n> swaps in the snapshot served from the
// n-th discovery call onward.
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
  if [ -n "\${GH_LIST_CALLS:-}" ]; then
    c=0; [ -f "\${GH_LIST_CALLS}" ] && c="$(cat "\${GH_LIST_CALLS}")"
    c=$((c + 1)); printf '%s' "$c" > "\${GH_LIST_CALLS}"
    k=2
    while [ "$k" -le "$c" ]; do
      v="GH_LIST_IDS$k"
      if [ -n "\${!v+x}" ]; then ids="\${!v}"; fi
      k=$((k + 1))
    done
  fi
  # Transient-failure injection: fail (exit 4, no output) on exactly the
  # listed discovery-call numbers, succeeding on every other call.
  if [ -n "\${GH_LIST_FAIL_CALLS:-}" ]; then
    for fc in \${GH_LIST_FAIL_CALLS}; do
      if [ "\${c:-1}" -eq "$fc" ]; then exit 4; fi
    done
  fi
  for entry in $ids; do
    lid="\${entry%%@*}"
    att=1; case "$entry" in *@*) att="\${entry#*@}";; esac
    nvar="GH_NAME_\${lid}"
    wvar="GH_WF_\${lid}"
    printf '%s\\t=%s\\t=%s\\t%s\\n' "$lid" "$att" "\${!wvar-wf-$lid}" "\${!nvar:-CI-$lid}"
  done
  # Partial-then-fail: rows above were already printed, then gh dies. Fires
  # from the second discovery call on (the first must register the runs).
  if [ -n "\${GH_LIST_EXIT_AFTER_OUTPUT:-}" ] && [ "\${c:-1}" -ge 2 ]; then
    exit "\${GH_LIST_EXIT_AFTER_OUTPUT}"
  fi
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
    FAILONCE)
      # Fails the first view of this id (exit 4, no output), succeeds after.
      if [ ! -f "\${GH_ONCE_MARKER}-$id" ]; then : > "\${GH_ONCE_MARKER}-$id"; exit 4; fi
      printf 'success\\t%s\\n' "$name"; exit 0;;
    EMPTYONCE)
      # First view returns no conclusion (watch cut short), then concludes.
      if [ ! -f "\${GH_ONCE_MARKER}-$id" ]; then : > "\${GH_ONCE_MARKER}-$id"; printf '\\t%s\\n' "$name"; exit 0; fi
      printf 'success\\t%s\\n' "$name"; exit 0;;
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
// Spawns the script with the given argv exactly; run() below is the common
// flags-then-SHA shape. The default expectation pins the fixture's default
// workflow name so each scenario keeps testing its own branch, not the
// expected-workflow gate (which has dedicated tests below).
function runArgv(env: Record<string, string>, argv: string[]) {
  scenario += 1;
  const violations = join(binDir, `violations-${scenario}`);
  const result = Bun.spawnSync(["bash", SCRIPT, ...argv], {
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

function run(env: Record<string, string>, args: string[] = ["--expect-workflow", "CI-1"]) {
  return runArgv(env, [...args, "deadbeef"]);
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

  test("a transient view failure heals on the bounded retry: exits 0, never 2", () => {
    // The stub gh fails the first conclusion read of run 1 and succeeds on
    // the retry. Before the bounded retry this single blip concluded
    // "gh failed while checking run 1" and exit 2.
    const r = run({
      GH_LIST_IDS: "1",
      GH_VIEW_1: "FAILONCE",
      GH_ONCE_MARKER: join(binDir, "view-once-heals"),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pass: CI-1 (1)");
    expect(r.stderr).not.toContain("gh failed");
  });

  test("a watch cut short once (no conclusion) heals on re-watch and re-read", () => {
    // First read returns an empty conclusion (the watch aborted mid-run);
    // the retry re-watches and reads the settled conclusion. Before the
    // bounded retry this exited 2 with "run not concluded".
    const r = run({
      GH_LIST_IDS: "1",
      GH_VIEW_1: "EMPTYONCE",
      GH_ONCE_MARKER: join(binDir, "empty-once-heals"),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pass: CI-1 (1)");
    expect(r.stderr).not.toContain("not concluded");
  });

  test("a transient re-discovery failure heals on the bounded retry", () => {
    // Discovery call 1 registers the run; the post-watch re-discovery (call
    // 2) dies; its retry (call 3) succeeds with the same snapshot, so the
    // selection converges and is judged instead of exiting 2.
    const calls = join(binDir, "list-calls-transient-rediscovery");
    const r = run({
      GH_LIST_IDS: "1",
      GH_LIST_CALLS: calls,
      GH_LIST_FAIL_CALLS: "2",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pass: CI-1 (1)");
    expect(r.stderr).not.toContain("re-discovery after the watch returned nothing");
    expect(readFileSync(calls, "utf-8")).toBe("3");
  });

  test("a run retriggered during a conclusion-retry wait is refused, never judged stale", () => {
    // The retry's re-watch is a wait like any other: run 2 (same workflow)
    // appears while it waits, so the judged selection (run 1) is stale by
    // verdict time. The selection-stability re-check must refuse with exit 2
    // instead of letting run 1's green stand for a superseded selection.
    const calls = join(binDir, "list-calls-retry-race");
    const r = run(
      {
        GH_LIST_IDS: "1",
        GH_LIST_IDS3: "2 1",
        GH_LIST_CALLS: calls,
        GH_VIEW_1: "EMPTYONCE",
        GH_ONCE_MARKER: join(binDir, "retry-race-marker"),
        GH_WF_1: "77",
        GH_WF_2: "77",
        GH_NAME_1: "CI",
        GH_NAME_2: "CI",
      },
      [],
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("retriggered while the conclusion retries waited");
    expect(r.stderr).toContain("refusing to judge a stale snapshot");
    // The refusal must carry NO verdict about the superseded selection: the
    // judgment output is buffered and dropped, so run 1's healed green (or a
    // red and its logs) never reaches the report.
    expect(r.stdout).not.toContain("pass:");
    expect(r.stdout).not.toContain("FAIL");
    // Registration, post-watch re-discovery, and the stability re-check.
    expect(readFileSync(calls, "utf-8")).toBe("3");
  });

  test("a stability refusal carries no stale missing-workflow diagnostic", () => {
    // The expected gate ("CI") is absent from every pre-refusal snapshot: a
    // bystander is the only run until the conclusion retry's wait, during
    // which run 2 (the gate, a different workflow) registers. The stability
    // re-check refuses the stale selection; the refusal must not also claim
    // the gate workflow "was not found" when the freshest snapshot has it.
    const calls = join(binDir, "list-calls-stale-missing");
    const r = run(
      {
        GH_LIST_IDS: "1",
        GH_LIST_IDS7: "2 1",
        GH_LIST_CALLS: calls,
        GH_VIEW_1: "EMPTYONCE",
        GH_ONCE_MARKER: join(binDir, "stale-missing-marker"),
        GH_WF_1: "77",
        GH_WF_2: "88",
        GH_NAME_1: "Bystander",
        GH_NAME_2: "CI",
      },
      [],
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("retriggered while the conclusion retries waited");
    expect(r.stderr).not.toContain("expected workflow(s) not found");
    expect(r.stdout).not.toContain("pass:");
    // 5 registration polls (gate absent), post-watch re-discovery, and the
    // stability re-check that reveals the late gate run.
    expect(readFileSync(calls, "utf-8")).toBe("7");
  });

  test("a mktemp failure is tooling trouble: exits 2, never a red-pipeline 1", () => {
    // The judgment-buffer mktemp calls run under set -e; unguarded, a full or
    // unwritable tmpdir exited 1, which callers read as "red pipeline".
    const mktempFailDir = join(binDir, "mktemp-fail-bin");
    mkdirSync(mktempFailDir, { recursive: true });
    writeFileSync(join(mktempFailDir, "mktemp"), "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(join(mktempFailDir, "mktemp"), 0o755);
    const r = run({
      GH_LIST_IDS: "1",
      PATH: `${mktempFailDir}:${binDir}:${process.env.PATH ?? ""}`,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("mktemp failed");
    expect(r.stdout).not.toContain("pass:");
  });

  test("a second-mktemp failure exits 2 and the EXIT trap reclaims the first file", () => {
    // The first mktemp succeeds and hands out a real file; the second dies.
    // The guard must still exit 2, and the EXIT trap (installed before the
    // mktemp calls) must remove the file the first call created.
    const scratch = join(binDir, "mktemp-second-fail");
    const stubBin = join(scratch, "bin");
    mkdirSync(stubBin, { recursive: true });
    writeFileSync(
      join(stubBin, "mktemp"),
      '#!/usr/bin/env bash\nn=0; [ -f "$MKTEMP_COUNT" ] && n="$(cat "$MKTEMP_COUNT")"\n' +
        'n=$((n + 1)); printf \'%s\' "$n" > "$MKTEMP_COUNT"\n' +
        'if [ "$n" -ge 2 ]; then exit 1; fi\n' +
        'f="$MKTEMP_DIR/judgment-$n"\n: > "$f"\nprintf \'%s\\n\' "$f"\n',
    );
    chmodSync(join(stubBin, "mktemp"), 0o755);
    const r = run({
      GH_LIST_IDS: "1",
      MKTEMP_COUNT: join(scratch, "count"),
      MKTEMP_DIR: scratch,
      PATH: `${stubBin}:${binDir}:${process.env.PATH ?? ""}`,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("mktemp failed");
    expect(r.stdout).not.toContain("pass:");
    expect(existsSync(join(scratch, "judgment-1"))).toBe(false);
  });

  test("an unexpected internal tool failure exits 2 via the ERR trap, never 1", () => {
    // sort is unguarded plumbing inside compute_missing: before the ERR trap,
    // its failure rode set -e out as the script's raw exit status, which
    // callers read as a red pipeline. Any future unguarded command joins the
    // same class, so the trap, not a per-call guard, is the fix.
    const sortFailDir = join(binDir, "sort-fail-bin");
    mkdirSync(sortFailDir, { recursive: true });
    writeFileSync(join(sortFailDir, "sort"), "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(join(sortFailDir, "sort"), 0o755);
    const r = run({
      GH_LIST_IDS: "1",
      PATH: `${sortFailDir}:${binDir}:${process.env.PATH ?? ""}`,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unexpected command failure");
    expect(r.stdout).not.toContain("pass:");
  });

  test("a tr failure while splitting the expectations exits 2, never a vacuous green", () => {
    // tr feeds the expected-workflow list. When it ran inside the heredoc's
    // command substitution, its failure only exited that subshell: the
    // expectation loop saw an empty list, computed missing="" and the run
    // exited 0 - a tooling failure disabling the vacuous-green gate. The
    // assignment form must route it to the ERR trap instead.
    const trFailDir = join(binDir, "tr-fail-bin");
    mkdirSync(trFailDir, { recursive: true });
    writeFileSync(join(trFailDir, "tr"), "#!/usr/bin/env bash\nexit 1\n");
    chmodSync(join(trFailDir, "tr"), 0o755);
    const r = run({
      GH_LIST_IDS: "1",
      PATH: `${trFailDir}:${binDir}:${process.env.PATH ?? ""}`,
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unexpected command failure");
    expect(r.stdout).not.toContain("pass:");
  });

  test("a transient re-discovery failure after the conclusion retries heals on the bounded retry", () => {
    // Run 1's first view fails, so the conclusion retry re-watches (a wait)
    // and the stability re-check must re-discover: that discovery (call 3)
    // dies and its retry (call 4) returns the same snapshot, so the healed
    // verdict stands instead of exiting 2.
    const calls = join(binDir, "list-calls-retry-rediscovery-heal");
    const r = run({
      GH_LIST_IDS: "1",
      GH_LIST_CALLS: calls,
      GH_LIST_FAIL_CALLS: "3",
      GH_VIEW_1: "FAILONCE",
      GH_ONCE_MARKER: join(binDir, "retry-rediscovery-heal-marker"),
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pass: CI-1 (1)");
    expect(r.stderr).not.toContain("re-discovery after the conclusion retries returned nothing");
    // Registration, post-watch re-discovery, the failed stability re-check,
    // and its healing retry.
    expect(readFileSync(calls, "utf-8")).toBe("4");
  });

  test("a re-discovery failing outright after the conclusion retries exits 2 with no verdict leak", () => {
    // All 3 attempts of the post-retry stability re-discovery die (calls
    // 3-5): the buffered judgment about run 1 is dropped, so the refusal
    // carries no verdict lines at all - not even the healed green.
    const calls = join(binDir, "list-calls-retry-rediscovery-fail");
    const r = run({
      GH_LIST_IDS: "1",
      GH_LIST_CALLS: calls,
      GH_LIST_FAIL_CALLS: "3 4 5",
      GH_VIEW_1: "FAILONCE",
      GH_ONCE_MARKER: join(binDir, "retry-rediscovery-fail-marker"),
    });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("re-discovery after the conclusion retries returned nothing");
    expect(r.stdout).toBe("");
    expect(readFileSync(calls, "utf-8")).toBe("5");
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
    const r = run(
      {
        GH_LIST_IDS: "9 100",
        GH_WF_9: "77",
        GH_WF_100: "77",
        GH_NAME_9: name,
        GH_NAME_100: name,
        GH_VIEW_9: "cancelled",
      },
      ["--expect-workflow", name],
    );
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
    const r = run(
      {
        GH_LIST_IDS: "1 2",
        GH_WF_1: "",
        GH_WF_2: "",
        GH_NAME_1: "CI",
        GH_NAME_2: "CI",
        GH_VIEW_1: "cancelled",
      },
      ["--expect-workflow", "CI"],
    );
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("FAIL(cancelled): CI (1)");
    expect(r.stdout).toContain("pass: CI (2)");
    expect(r.stdout).not.toContain("superseded");
  });

  test("anything after the SHA is a usage error, never silently dropped", () => {
    // The flag loop breaks at the first non-flag word, so a flag placed
    // after the SHA used to be dropped without a trace: watch-ci.sh <sha>
    // --expect-workflow Deploy left the default expectation in force and
    // could exit 0 green off a bystander run - the vacuous green the flag
    // exists to prevent.
    for (const trailing of [["--expect-workflow", "Deploy"], ["oops"]]) {
      const r = runArgv({ GH_LIST_IDS: "1" }, ["deadbeef", ...trailing]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unexpected argument(s) after the SHA");
      expect(r.stderr).toContain(trailing.join(" "));
      expect(r.stdout).not.toContain("pass:");
    }
  });

  test("never-settling retriggers are refused after a final re-discovery, never judged stale", () => {
    // Every discovery snapshot reveals a newer run of the same workflow, so
    // the capped fixed-point loop ends without converging. The judgment must
    // then be gated on one more re-discovery: here it reveals run 7, whose
    // FAILURE the stale selection (green run 6) would have hidden behind an
    // exit 0. The script must refuse with exit 2 instead.
    const calls = join(binDir, "list-calls-never-converge");
    const names: Record<string, string> = {};
    for (const id of ["1", "2", "3", "4", "5", "6", "7"]) {
      names[`GH_NAME_${id}`] = "CI";
      names[`GH_WF_${id}`] = "77";
    }
    const r = run(
      {
        GH_LIST_IDS: "1",
        GH_LIST_IDS2: "2 1",
        GH_LIST_IDS3: "3 2 1",
        GH_LIST_IDS4: "4 3 2 1",
        GH_LIST_IDS5: "5 4 3 2 1",
        GH_LIST_IDS6: "6 5 4 3 2 1",
        GH_LIST_IDS7: "7 6 5 4 3 2 1",
        GH_LIST_CALLS: calls,
        ...names,
        GH_VIEW_7: "failure",
      },
      [],
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("refusing to judge a stale snapshot");
    expect(r.stdout).not.toContain("pass:");
    // 1 registration poll + 5 fixed-point rounds + the final re-discovery.
    expect(readFileSync(calls, "utf-8")).toBe("7");
  });

  test("a non-converged selection confirmed by the final re-discovery is judged", () => {
    // Same churn through the 5 capped rounds, but the final re-discovery
    // returns the identical snapshot: the selection is confirmed stable at
    // judgment time and run 6 is judged normally.
    const calls = join(binDir, "list-calls-late-converge");
    const names: Record<string, string> = {};
    for (const id of ["1", "2", "3", "4", "5", "6"]) {
      names[`GH_NAME_${id}`] = "CI";
      names[`GH_WF_${id}`] = "77";
    }
    const r = run(
      {
        GH_LIST_IDS: "1",
        GH_LIST_IDS2: "2 1",
        GH_LIST_IDS3: "3 2 1",
        GH_LIST_IDS4: "4 3 2 1",
        GH_LIST_IDS5: "5 4 3 2 1",
        GH_LIST_IDS6: "6 5 4 3 2 1",
        GH_LIST_IDS7: "6 5 4 3 2 1",
        GH_LIST_CALLS: calls,
        ...names,
      },
      [],
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("final re-discovery confirmed");
    expect(r.stdout).toContain("pass: CI (6)");
    expect(r.stdout).toContain("superseded: CI (5)");
    expect(readFileSync(calls, "utf-8")).toBe("7");
  });

  test("a run cancelled by a mid-watch retrigger is superseded after re-discovery", () => {
    // The first discovery sees only run 1; the retrigger (run 2, same
    // workflow) appears while the script waits. The post-watch re-discovery
    // must re-select run 2 and demote run 1 to superseded instead of
    // reporting its concurrency cancellation as FAIL.
    // No --expect-workflow here: the runs are named "CI", so this scenario
    // also pins the script's default expectation.
    const calls = join(binDir, "list-calls");
    const r = run(
      {
        GH_LIST_IDS: "1",
        GH_LIST_IDS2: "2 1",
        GH_LIST_CALLS: calls,
        GH_WF_1: "77",
        GH_WF_2: "77",
        GH_NAME_1: "CI",
        GH_NAME_2: "CI",
        GH_VIEW_1: "cancelled",
      },
      [],
    );
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
    const r = run(
      {
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
      },
      [],
    );
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

  test("a re-discovery failing AFTER partial output exits 2, never judges the fragment", () => {
    // gh can die mid-stream after printing some rows; a fragment accepted as
    // a complete snapshot would judge a selection with runs missing from it.
    // discover must turn partial-then-fail into "no output", which the
    // stale-snapshot check refuses.
    const calls = join(binDir, "list-calls-partial-fail");
    const r = run({
      GH_LIST_IDS: "1",
      GH_LIST_IDS2: "2 1",
      GH_LIST_CALLS: calls,
      GH_LIST_EXIT_AFTER_OUTPUT: "3",
    });
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

  test("green bystanders with the expected workflow absent exit 2, never 0", () => {
    // THE hole this gate closes: the push's event fails to register the CI
    // run, discovery finds only other workflows on the SHA, and all of them
    // pass. No flag, so the default expectation "CI" applies; the runs are
    // named CI-1 and CI-2, which must NOT satisfy it.
    const r = run({ GH_LIST_IDS: "1 2" }, []);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("expected workflow(s) not found for deadbeef: CI;");
    expect(r.stderr).toContain("discovered only: CI-1, CI-2");
    expect(r.stderr).toContain("gh workflow run ci.yml --ref <branch>");
    expect(r.stdout).toContain("pass: CI-1 (1)");
  });

  test("a red run outranks a missing expected workflow: exits 1, message still printed", () => {
    const r = run({ GH_LIST_IDS: "1", GH_VIEW_1: "failure" }, []);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("FAIL(failure): CI-1 (1)");
    expect(r.stderr).toContain("expected workflow(s) not found");
  });

  test("--expect-workflow overrides the default expectation", () => {
    const r = run({ GH_LIST_IDS: "1", GH_NAME_1: "Build" }, ["--expect-workflow", "Build"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pass: Build (1)");
  });

  test("comma-separated expectations each must be present", () => {
    const r = run({ GH_LIST_IDS: "1", GH_NAME_1: "Build" }, ["--expect-workflow", "Build,Deploy"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("expected workflow(s) not found for deadbeef: Deploy;");
    expect(r.stdout).toContain("pass: Build (1)");
  });

  test("repeatable --expect-workflow flags accumulate", () => {
    const r = run({ GH_LIST_IDS: "1 2", GH_NAME_1: "Build", GH_NAME_2: "Deploy" }, [
      "--expect-workflow",
      "Build",
      "--expect-workflow",
      "Deploy",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pass: Build (1)");
    expect(r.stdout).toContain("pass: Deploy (2)");
  });

  test("--expect-workflow with an empty name is a usage error", () => {
    const r = run({}, ["--expect-workflow", ""]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--expect-workflow requires a workflow name");
  });

  test("delimiter-only and trailing-comma expectations are usage errors, never a disabled gate", () => {
    // A value that splits to zero names ("," here) would otherwise leave
    // nothing to check and let green bystanders exit 0 - the exact hole the
    // gate exists to close, reopened through its own flag.
    for (const value of [",", "Build,", ",Build", "Build,,Deploy"]) {
      const r = run({ GH_LIST_IDS: "1" }, ["--expect-workflow", value]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(
        `--expect-workflow requires a workflow name (empty entry in "${value}")`,
      );
      expect(r.stdout).not.toContain("pass:");
    }
  });

  test("newlines in an expectation are usage errors, never a shrunken gate", () => {
    // The expectation list is matched line-by-line and command substitution
    // strips trailing newlines, so "\n" would empty the set, "CI\n" would
    // silently become "CI", and "A\nB" would become two expectations.
    for (const value of ["\n", "CI\n", "\nCI", "A\nB"]) {
      const r = run({ GH_LIST_IDS: "1" }, ["--expect-workflow", value]);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("--expect-workflow value must not contain newlines");
      expect(r.stdout).not.toContain("pass:");
    }
  });

  test("a bystander registering before the expected workflow does not trip the gate", () => {
    // The first TWO snapshots have only the fast bystander; the gate
    // workflow registers on the third poll. The registration-lag loop must
    // keep polling within its bounded window instead of reporting the
    // merely-late gate as missing. Two bystander-only snapshots make the
    // test discriminating: with the old break-on-first-run behavior the
    // convergence loop would stabilize on the bystander alone after 2 list
    // calls and exit 2.
    const calls = join(binDir, "list-calls-late-gate");
    const r = run(
      {
        GH_LIST_IDS: "2",
        GH_LIST_IDS2: "2",
        GH_LIST_IDS3: "2 1",
        GH_LIST_CALLS: calls,
        GH_NAME_1: "CI",
        GH_NAME_2: "Bystander",
      },
      [],
    );
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("pass: CI (1)");
    expect(r.stdout).toContain("pass: Bystander (2)");
    expect(r.stderr).not.toContain("expected workflow(s) not found");
    // 3 registration polls (bystander, bystander, both) + 1 post-watch
    // re-discovery.
    expect(readFileSync(calls, "utf-8")).toBe("4");
  });
});
