import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./lib";

// Exit-matrix test for the watch-ci helper: a fake `gh` on PATH drives every
// branch of the script, pinning the contract its reviews established - a red
// run exits 1, a gh operational failure exits 2 (never 1), a green fleet
// exits 0, and a red run outranks a gh hiccup. A fake `sleep` keeps the
// discovery-retry scenarios instant.

const SCRIPT = join(ROOT, "skills", "watch-ci-after-push", "scripts", "watch-ci.sh");

// Dispatch validates the EXACT invocations watch-ci.sh makes. Every mismatch
// is appended to the GH_VIOLATIONS file, which each test asserts is empty -
// that is the guaranteed detection channel, since the script normalizes some
// list/view failures to exit 2 and deliberately ignores the watch exit
// status. list/view mismatches also exit 64 as a secondary signal.
const FAKE_GH = `#!/usr/bin/env bash
violate() { echo "$*" >> "\${GH_VIOLATIONS}"; }
jq_view='"\\(.conclusion)\\t\\(.name)"'
if [ "$1 $2" = "run list" ]; then
  if [ "$*" != "run list --commit deadbeef --json databaseId --jq .[].databaseId" ]; then
    violate "list: $*"; exit 64
  fi
  [ "\${GH_LIST_EXIT:-0}" -ne 0 ] && exit "\${GH_LIST_EXIT}"
  if [ -n "\${GH_LIST_READY_AFTER:-}" ]; then
    n=0; [ -f "\${GH_LIST_COUNTER}" ] && n="$(cat "\${GH_LIST_COUNTER}")"
    n=$((n + 1)); printf '%s' "$n" > "\${GH_LIST_COUNTER}"
    [ "$n" -lt "\${GH_LIST_READY_AFTER}" ] && exit 0
  fi
  [ -n "\${GH_LIST_IDS:-}" ] && printf '%s\\n' \${GH_LIST_IDS}
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
  case "$spec" in
    FAILCMD) exit 4;;
    EMPTY) printf '\\tCI-%s\\n' "$id"; exit 0;;
    *) printf '%s\\tCI-%s\\n' "$spec" "$id"; exit 0;;
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
    expect(readFileSync(counter, "utf-8")).toBe("3");
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
});
