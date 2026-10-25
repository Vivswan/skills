import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { ROOT } from "../../../scripts/lib.mts";
import { writeAllSync } from "../../../skills/rubber-duck-review/scripts/run-review.mts";
import { git } from "../../helpers/scratch-repo";
import { tempDirs } from "../../helpers/temp-dirs";

const temp = tempDirs();

// Contract tests for the run-review helper: stub reviewer binaries on PATH
// drive every exit path, pinning the traps the script encapsulates - the
// prompt travels as one argv element (backticks and $() stay literal), stdin
// is closed so a reviewer that reads it cannot hang, the verdict is the LAST
// codex agent_message / the final claude result and must be the schema
// object with at least one tool call before it, and an empty, cut, blank,
// prose-only, preamble-only, or errored stream exits 1 (never a clean pass),
// and --extract --wait blocks on the launch record until the monitor records
// the exit instead of leaving the caller to poll by hand.
// gh-style violations files catch any drift in the exact reviewer invocations.

const SCRIPT = join(ROOT, "skills", "rubber-duck-review", "scripts", "run-review.mts");
const SCHEMA = join(ROOT, "skills", "rubber-duck-review", "scripts", "verdict-schema.json");

// Prompt content that a shell would mangle: proves no shell ever sees it.
const PROMPT = "Review only.\nRun `git --no-pager diff HEAD` and note $(hostname) stays literal.\n";

const SKILLS_ROOT = join(ROOT, "skills");

/** A page's `## Review Criteria` section up to its next `## ` heading, read the way a reader
 * would, so the launcher's extraction is pinned to the files and never to a pasted copy. */
function reviewCriteriaOf(page: string): string | null {
  const lines = page.split("\n");
  const start = lines.indexOf("## Review Criteria");
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return rest
    .slice(0, end === -1 ? rest.length : end)
    .join("\n")
    .trim();
}

/** The skills under `root` that declare the heading, in directory order, with their sections. */
function declaringSkills(root: string): { name: string; body: string }[] {
  const found: { name: string; body: string }[] = [];
  for (const name of readdirSync(root).sort()) {
    const page = join(root, name, "SKILL.md");
    if (!existsSync(page)) continue;
    const body = reviewCriteriaOf(readFileSync(page, "utf-8"));
    if (body !== null) found.push({ name, body });
  }
  return found;
}

/** The prompt as the reviewer must receive it: the caller's text, then the companion section. */
function withCompanion(prompt: string, skills = declaringSkills(SKILLS_ROOT)): string {
  if (skills.length === 0) return prompt;
  const sections = skills.map(({ name, body }) => `### ${name}\n\n${body}`);
  return `${prompt.trimEnd()}\n\n## Companion review criteria\n\n${sections.join("\n\n")}\n`;
}
const FULL_PROMPT = withCompanion(PROMPT);

const BIG_VERDICT_BYTES = 262144;

/** The verdict object the schema describes, as each stub reviewer reports it. */
function verdictFor(reviewer: string) {
  return {
    blocking: [],
    non_blocking: [
      { where: "src/a.ts:3", claim: "misleading name", evidence: `${reviewer} read it` },
    ],
    recorded_not_built: ["a bound for a caller that does not exist"],
    summary: `${reviewer.toUpperCase()} VERDICT: correct, no blocking findings`,
  };
}
const CODEX_VERDICT = verdictFor("codex");
const CLAUDE_VERDICT = verdictFor("claude");
const COPILOT_VERDICT = verdictFor("copilot");

/** One codex agent_message line carrying the given text (JSON-escaped once,
 * so the stub's single quotes deliver it byte-for-byte). */
function codexMessage(text: string): string {
  return JSON.stringify({ type: "item.completed", item: { type: "agent_message", text } });
}
const CODEX_VERDICT_LINE = codexMessage(JSON.stringify(CODEX_VERDICT));
/** The big-verdict line split around its summary, so the stub can splice in
 * a summary larger than any pipe buffer. */
const [bigOpen, bigClose] = codexMessage(
  JSON.stringify({ blocking: [], non_blocking: [], recorded_not_built: [], summary: "@BIG@" }),
).split("@BIG@") as [string, string];
const CODEX_TOOL_LINE = JSON.stringify({
  type: "item.completed",
  item: { type: "command_execution", command: "git --no-pager diff --cached" },
});
const CLAUDE_TOOL_LINE = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git diff" } }] },
});
const CLAUDE_ANSWER_TOOL_LINE = JSON.stringify({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "StructuredOutput", input: CLAUDE_VERDICT }] },
});
const CLAUDE_RESULT_LINE = JSON.stringify({
  type: "result",
  subtype: "success",
  is_error: false,
  result: JSON.stringify(CLAUDE_VERDICT),
  structured_output: CLAUDE_VERDICT,
});

const FAKE_CODEX = `#!/usr/bin/env bash
violate() { echo "$*" >> "\${STUB_VIOLATIONS}"; }
# The launch probes the sandbox with a no-op first. STUB_SANDBOX=bwrap plays a
# container whose AppArmor profile denies bubblewrap's mount propagation.
if [ "$1 $2 $3" = "sandbox -- true" ] && [ "$#" -eq 3 ]; then
  if [ "\${STUB_SANDBOX:-ok}" = "bwrap" ]; then
    echo 'bwrap: Failed to make / slave: Permission denied' >&2; exit 1
  fi
  exit 0
fi
if [ "\${STUB_SANDBOX:-ok}" = "bwrap" ]; then policy=danger-full-access; else policy=read-only; fi
if [ "$1 $2 $3 $4 $5" != "exec --json --sandbox $policy --output-schema" ] || [ "$#" -ne 7 ]; then
  violate "codex argv: $*"; exit 64
fi
if [ -n "\${STUB_HOME_REPORT:-}" ]; then
  { echo "\${CODEX_HOME:-unset}"; cat "\${CODEX_HOME:-/nonexistent}/config.toml" 2>/dev/null || echo "(no config)"; ls "\${CODEX_HOME:-/nonexistent}" 2>/dev/null | tr '\\n' ' '; echo; } > "\${STUB_HOME_REPORT}"
  # codex's trust write, as the real binary does it: it must land in the scratch home, never the user's
  echo '[projects."'"$PWD"'"]' >> "\${CODEX_HOME:-/nonexistent}/config.toml" 2>/dev/null || true
  # codex's token refresh, which must persist for the user
  if [ -n "\${STUB_REFRESH_AUTH:-}" ]; then printf '%s' "\${STUB_REFRESH_AUTH}" > "\${CODEX_HOME:-/nonexistent}/auth.json"; fi
  # codex's session rollout, the review's transcript, which must persist for the user
  if [ -n "\${STUB_ROLLOUT:-}" ]; then
    mkdir -p "\${CODEX_HOME:-/nonexistent}/sessions/2026/10/11" && printf '%s' "\${STUB_ROLLOUT}" > "\${CODEX_HOME:-/nonexistent}/sessions/2026/10/11/rollout-example.jsonl"
  fi
  # a parallel review refreshing the user's own file while this one runs
  if [ -n "\${STUB_REAL_AUTH_WRITE:-}" ]; then printf '%s' "\${STUB_REAL_AUTH_WRITE}" > "\${STUB_REAL_AUTH_PATH}"; fi
fi
if [ -n "\${STUB_CWD_REPORT:-}" ]; then
  # One line per fact about the copy as the reviewer sees it: cwd, toplevel, branch, status entries
  # joined by |, HEAD (empty when unborn), commits reachable from HEAD, the first line of a.txt as checked out, and the
  # LFS smudge filter the copy's git has configured, the last line of a diff against origin/main, and ORIG_HEAD.
  { printf '%s\\n' "$PWD" "$(git rev-parse --show-toplevel)" "$(git branch --show-current)" \\
      "$(git status --porcelain -uall --ignored | tr '\\n' '|')" "$(git rev-parse -q --verify HEAD)" \\
      "$(git rev-list --count HEAD 2>&1 | tail -1)" "$(head -1 "$(git rev-parse --show-toplevel)/a.txt" 2>/dev/null)" \\
      "$(git config --get filter.lfs.smudge)" "$(git --no-pager diff --stat origin/main...HEAD 2>&1 | tail -1)" "$(git rev-parse -q --verify ORIG_HEAD)"; } > "\${STUB_CWD_REPORT}"
  # A write the prompt forbade: it must land in the copy, never in the checkout under review.
  touch "$(git rev-parse --show-toplevel)/REVIEWER_WROTE"
fi
if [ "$6" != "\${STUB_SCHEMA}" ] || [ ! -f "$6" ]; then
  violate "codex schema: $6"; exit 64
fi
if [ "$7" = "-" ]; then channel=stdin; else channel=argv; fi
if [ "$channel" != "\${STUB_EXPECT_DELIVERY}" ]; then
  violate "codex delivery: $channel"; exit 64
fi
if [ "$7" = "-" ] && [ "\${STUB_SKIP_STDIN:-0}" != "1" ]; then
  cat > "\${STUB_PROMPT_COPY}"
elif [ "$7" != "-" ]; then
  printf '%s' "$7" > "\${STUB_PROMPT_COPY}"
fi
# With stdin open (a pipe) this blocks forever; stdio 'ignore' gives EOF.
if [ "\${STUB_READ_STDIN:-0}" = "1" ]; then cat > /dev/null; fi
if [ -n "\${STUB_SLEEP:-}" ]; then sleep "\${STUB_SLEEP}"; fi
case "\${STUB_MODE:-ok}" in
  ok)
    echo '{"type":"thread.started","thread_id":"t1"}'
    echo '{"type":"turn.started"}'
    echo '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}'
    echo '${codexMessage("intermediate narration")}'
    echo 'mid-stream garbage that is not JSON'
    echo '${CODEX_TOOL_LINE}'
    echo '${CODEX_VERDICT_LINE}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    ;;
  preamble)
    echo '{"type":"turn.started"}'
    echo '${CODEX_VERDICT_LINE}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    ;;
  prose)
    echo '${CODEX_TOOL_LINE}'
    echo '${codexMessage("CODEX VERDICT: correct, no blocking findings")}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    ;;
  badshape)
    echo '${CODEX_TOOL_LINE}'
    echo '${codexMessage(JSON.stringify({ blocking: [], summary: "no non_blocking key" }))}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    ;;
  trunctail)
    echo '${CODEX_TOOL_LINE}'
    echo '${CODEX_VERDICT_LINE}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    printf '{"type":"item.completed","item":{"type":"agent_'
    ;;
  cut)
    echo '{"type":"thread.started","thread_id":"t1"}'
    echo '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}'
    ;;
  cutlate)
    echo '{"type":"thread.started","thread_id":"t1"}'
    echo '${CODEX_TOOL_LINE}'
    echo '${CODEX_VERDICT_LINE}'
    ;;
  cutsecond)
    echo '{"type":"turn.started"}'
    echo '${CODEX_TOOL_LINE}'
    echo '${CODEX_VERDICT_LINE}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    echo '{"type":"turn.started"}'
    ;;
  error)
    echo '{"type":"thread.started","thread_id":"t1"}'
    echo '{"type":"error","message":"stream disconnected before completion"}'
    ;;
  reconnect)
    echo '{"type":"thread.started","thread_id":"t1"}'
    echo '{"type":"turn.started"}'
    echo '${CODEX_TOOL_LINE}'
    echo '{"type":"error","message":"stream disconnected before completion; retrying 1/5"}'
    echo '${CODEX_VERDICT_LINE}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    ;;
  failedturnthenverdict)
    echo '{"type":"turn.started"}'
    echo '{"type":"turn.failed","message":"turn failed before any answer"}'
    echo '{"type":"turn.started"}'
    echo '${CODEX_TOOL_LINE}'
    echo '${CODEX_VERDICT_LINE}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    ;;
  errorafter)
    echo '{"type":"turn.started"}'
    echo '${CODEX_TOOL_LINE}'
    echo '${CODEX_VERDICT_LINE}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    echo '{"type":"error","message":"stream disconnected after the verdict"}'
    ;;
  blank)
    echo '${CODEX_TOOL_LINE}'
    echo '${codexMessage("")}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    ;;
  big)
    big="$(head -c ${BIG_VERDICT_BYTES} /dev/zero | tr '\\0' 'x')"
    echo '${CODEX_TOOL_LINE}'
    printf '%s%s%s\\n' '${bigOpen}' "$big" '${bigClose}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    ;;
  stall)
    echo '${CODEX_TOOL_LINE}'
    sleep 300 & echo "$$ $!" > "\${STUB_PID_FILE}"; wait
    ;;
  trickle)
    for _ in 1 2 3 4 5 6; do echo '{"type":"item.completed","item":{"type":"reasoning","text":"still reading"}}'; sleep 0.3; done
    echo '${CODEX_TOOL_LINE}'
    echo '${CODEX_VERDICT_LINE}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    ;;
  empty) ;;
esac
exit "\${STUB_EXIT:-0}"
`;

const FAKE_CLAUDE = `#!/usr/bin/env bash
violate() { echo "$*" >> "\${STUB_VIOLATIONS}"; }
if [ "$1 $2 $3 $4 $5 $6 $7" != "-p --permission-mode plan --verbose --output-format stream-json --json-schema" ]; then
  violate "claude argv: $*"; exit 64
fi
case "$8" in *'"recorded_not_built"'*) ;; *) violate "claude schema: $8"; exit 64;; esac
if [ "$#" -eq 9 ]; then
  channel=argv
  printf '%s' "$9" > "\${STUB_PROMPT_COPY}"
elif [ "$#" -eq 8 ]; then
  channel=stdin
  cat > "\${STUB_PROMPT_COPY}"
else
  violate "claude argv: $*"; exit 64
fi
if [ "$channel" != "\${STUB_EXPECT_DELIVERY}" ]; then
  violate "claude delivery: $channel"; exit 64
fi
case "\${STUB_MODE:-ok}" in
  ok)
    echo '{"type":"system","subtype":"init"}'
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"looking around"}]}}'
    echo '${CLAUDE_TOOL_LINE}'
    echo '{"type":"user","message":{"content":[{"type":"tool_result","content":"diff"}]}}'
    echo '${CLAUDE_ANSWER_TOOL_LINE}'
    echo '${CLAUDE_RESULT_LINE}'
    ;;
  preamble)
    echo '{"type":"system","subtype":"init"}'
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"I will review the changes now."}]}}'
    echo '${CLAUDE_ANSWER_TOOL_LINE}'
    echo '${CLAUDE_RESULT_LINE}'
    ;;
  resultstring)
    echo '${CLAUDE_TOOL_LINE}'
    echo '${JSON.stringify({ type: "result", subtype: "success", result: JSON.stringify(CLAUDE_VERDICT) })}'
    ;;
  iserror)
    echo '{"type":"system","subtype":"init"}'
    echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Execution failed mid-run"}'
    ;;
  cut)
    echo '{"type":"system","subtype":"init"}'
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"partial narration"}]}}'
    ;;
  blank)
    echo '{"type":"system","subtype":"init"}'
    echo '${CLAUDE_TOOL_LINE}'
    echo '{"type":"result","subtype":"success","result":"   "}'
    ;;
esac
exit "\${STUB_EXIT:-0}"
`;

const FAKE_COPILOT = `#!/usr/bin/env bash
violate() { echo "$*" >> "\${STUB_VIOLATIONS}"; }
ro='-s --available-tools=view,rg,glob --deny-tool=write --deny-tool=shell --disable-builtin-mcps'
if [ "$1" != "-p" ] || [ "$3 $4 $5 $6 $7" != "$ro" ] || [ "$#" -ne 7 ]; then
  violate "copilot argv: $*"; exit 64
fi
printf '%s' "$2" > "\${STUB_PROMPT_COPY}"
case "\${STUB_MODE:-ok}" in
  ok) echo '${JSON.stringify(COPILOT_VERDICT)}';;
  fenced) printf '\\x60\\x60\\x60json\\n%s\\n\\x60\\x60\\x60\\n' '${JSON.stringify(COPILOT_VERDICT)}';;
  extrakey) echo '${JSON.stringify({ ...COPILOT_VERDICT, severity: "high" })}';;
  extrafindingkey) echo '${JSON.stringify({ ...COPILOT_VERDICT, blocking: [{ where: "x", claim: "c", evidence: "e", severity: "high" }] })}';;
  prose) echo "COPILOT VERDICT: correct";;
  blank) printf '   \\n';;
esac
exit "\${STUB_EXIT:-0}"
`;

/** The snapshot runs git through PATH, so this stub can fail the subcommand STUB_GIT_FAIL names
 * midway; every other call goes to the machine's git. */
const REAL_GIT = Bun.which("git");
if (REAL_GIT === null) throw new Error("git is not installed");
const FAKE_GIT = `#!/usr/bin/env bash
for arg in "$@"; do
  if [ -n "\${STUB_GIT_FAIL:-}" ] && [ "$arg" = "\${STUB_GIT_FAIL}" ]; then echo "fatal: disk full" >&2; exit 128; fi
done
exec "${REAL_GIT}" "$@"
`;

const binDir = temp.dir("run-review-test-");
const emptyBinDir = temp.dir("run-review-nobin-");
for (const [name, body] of [
  ["codex", FAKE_CODEX],
  ["claude", FAKE_CLAUDE],
  ["copilot", FAKE_COPILOT],
  ["git", FAKE_GIT],
] as const) {
  writeFileSync(join(binDir, name), body);
  chmodSync(join(binDir, name), 0o755);
}
const mintedDirs: string[] = [];
/** Prompt files reach a launch only through a `prepare`-minted path. */
function mintPrompt(section: string, content: string = PROMPT): string {
  const result = Bun.spawnSync([process.execPath, SCRIPT, "prepare", section], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.stderr.toString()).toBe("");
  expect(result.exitCode).toBe(0);
  const file = result.stdout.toString().trimEnd();
  mintedDirs.push(dirname(file));
  writeFileSync(file, content);
  return file;
}
const promptFile = mintPrompt("prompt");

afterAll(() => {
  for (const dir of mintedDirs) rmSync(dir, { recursive: true, force: true });
});

interface Report {
  verdict: Record<string, unknown>;
  tool_calls: number;
  capture: string;
  sandbox?: "copy";
  criteria: string[];
  trajectory: { event: string; text?: string }[];
}

let scenario = 0;
function run(
  args: string[],
  env: Record<string, string> = {},
  path?: string,
  cwd?: string,
  script: string = SCRIPT,
) {
  scenario += 1;
  const violations = join(binDir, `violations-${scenario}`);
  const promptCopy = join(binDir, `prompt-copy-${scenario}`);
  // process.execPath is absolute, so the script launches even when PATH is
  // reduced to the stub dir (the missing-binary scenario).
  const result = Bun.spawnSync([process.execPath, script, ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: path ?? `${binDir}:${process.env.PATH}`,
      STUB_VIOLATIONS: violations,
      STUB_PROMPT_COPY: promptCopy,
      STUB_SCHEMA: SCHEMA,
      // The stubs report the channel the prompt actually arrived on, so a
      // --stdin-prompt run that fell back to argv fails as a violation.
      STUB_EXPECT_DELIVERY: args.includes("--stdin-prompt") ? "stdin" : "argv",
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
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  // Every review run keeps its scratch dir for inspection: a success names
  // the capture in its report, a failure in its message. Sweep both.
  const kept = /(?:output|stderr) kept at ([^)\n]+)/.exec(stderr)?.[1];
  // Copy mode keeps its repository snapshot at <scratch>/repo only while the
  // reviewer runs; read whether one survived before the sweeps below.
  let copyLeft = false;
  let homeLeft = false;
  let captureKept = false;
  if (kept) {
    captureKept = existsSync(kept);
    copyLeft = existsSync(join(dirname(kept), "repo"));
    rmSync(dirname(kept), { recursive: true, force: true });
  }
  let report: Report | null = null;
  if (result.exitCode === 0 && stdout.startsWith("{")) {
    report = JSON.parse(stdout) as Report;
    expect(existsSync(report.capture)).toBe(true);
    copyLeft = existsSync(join(dirname(report.capture), "repo"));
    homeLeft = existsSync(join(dirname(report.capture), "codex-home"));
    rmSync(dirname(report.capture), { recursive: true, force: true });
  }
  return {
    code: result.exitCode,
    stdout,
    stderr,
    promptCopy,
    copyLeft,
    homeLeft,
    captureKept,
    /** The parsed JSON report of a successful review, or a throw. */
    report(): Report {
      if (report === null) throw new Error(`no report on stdout: ${stdout}\n${stderr}`);
      return report;
    },
  };
}

/** A failed review or usage error prints nothing on stdout: a verdict beside
 * a non-zero exit would read as a clean pass to a caller. */
function expectFailure(
  r: ReturnType<typeof run>,
  expected: { code: 1 | 2; stderr: string },
  id?: string,
): void {
  expect(r.code, id).toBe(expected.code);
  expect(r.stdout, id).toBe("");
  expect(r.stderr, id).toContain(expected.stderr);
}

/** Poll for the completed review.status record a background monitor writes
 * (present without `status` from launch; `status` lands on completion). */
function waitForStatus(outputFile: string): string {
  const statusFile = join(dirname(outputFile), "review.status");
  for (let i = 0; i < 100; i += 1) {
    try {
      const record = JSON.parse(readFileSync(statusFile, "utf-8"));
      if (typeof record.status === "string") return record.status;
    } catch {
      // record not written yet
    }
    Bun.sleepSync(50);
  }
  throw new Error(`no completed ${statusFile} after 5s`);
}

/** The pids a stalled stub wrote: its shell and the sleep it left in the background. */
function stubPids(pidFile: string): number[] {
  return readFileSync(pidFile, "utf-8").trim().split(" ").map(Number);
}

/** A killed process answers signal 0 until it is reaped; an orphan is reaped by init within moments. */
function expectGone(pid: number): void {
  for (let i = 0; i < 40; i += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    Bun.sleepSync(50);
  }
  throw new Error(`pid ${pid} is still alive 2 s after the review ended`);
}

function backgroundOutputFile(stdout: string): string {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("output-file: "));
  if (line === undefined) throw new Error(`no output-file line in: ${stdout}`);
  return line.slice("output-file: ".length);
}

/** A complete codex stream whose verdict extracts cleanly once a status lands. */
const COMPLETE_CODEX_STREAM = `${CODEX_TOOL_LINE}\n${CODEX_VERDICT_LINE}\n{"type":"turn.completed"}\n`;
const LAUNCH_RECORD = '{"tool":"codex","output":"review.jsonl"}';

/** A capture dir as a --background launch leaves it: stream and launch
 * record present, no status yet. */
function pendingCapture(stream = true): string {
  const dir = temp.dir("run-review-pending-");
  if (stream) writeFileSync(join(dir, "review.jsonl"), COMPLETE_CODEX_STREAM);
  writeFileSync(join(dir, "review.status"), LAUNCH_RECORD);
  return join(dir, "review.jsonl");
}

/** Complete a pending capture the way the monitor does: write-then-rename,
 * so a waiter polling mid-write never reads a truncated record. */
function recordStatus(outputFile: string, status: string): void {
  const statusFile = join(dirname(outputFile), "review.status");
  writeFileSync(
    `${statusFile}.tmp`,
    JSON.stringify({ tool: "codex", output: "review.jsonl", status }),
  );
  renameSync(`${statusFile}.tmp`, statusFile);
}

/** A script run left in flight, for the --wait cases observed mid-wait. */
function start(args: string[]) {
  return Bun.spawn([process.execPath, SCRIPT, ...args], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("run-review.mts", () => {
  test("codex: last agent_message wins, the report carries verdict, tool calls, capture, trajectory", () => {
    const r = run(["codex", promptFile]);
    expect(r.code).toBe(0);
    const report = r.report();
    expect(report.verdict).toEqual(CODEX_VERDICT);
    expect(report.tool_calls).toBe(1);
    expect(basename(report.capture)).toBe("review.jsonl");
    // The narration is visible as a trajectory step, never as the verdict;
    // long steps are excerpted, the full text stays in the capture.
    expect(report.trajectory.slice(0, 3)).toEqual([
      { event: "reasoning", text: "thinking" },
      { event: "agent_message", text: "intermediate narration" },
      { event: "command_execution", text: "git --no-pager diff --cached" },
    ]);
    expect(report.trajectory[3]?.event).toBe("agent_message");
    expect(report.trajectory[3]?.text).toMatch(/^\{"blocking":\[\].*\.\.\.$/);
    expect(report.trajectory).toHaveLength(4);
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(FULL_PROMPT);
    const statusLines = r.stderr.split("\n").filter(Boolean);
    expect(statusLines).toEqual(["review stream alive", "reviewer exited (status=0)"]);
  });

  test("claude: verdict is the structured_output on the final result event", () => {
    const r = run(["claude", promptFile]);
    expect(r.code).toBe(0);
    const report = r.report();
    expect(report.verdict).toEqual(CLAUDE_VERDICT);
    // The StructuredOutput call delivers the answer; only Bash is a review step.
    expect(report.tool_calls).toBe(1);
    expect(report.trajectory.map((row) => row.event)).toEqual(["text", "tool_use", "result"]);
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(FULL_PROMPT);
  });

  test("claude: a result string carrying the object is the verdict when structured_output is absent", () => {
    const r = run(["claude", promptFile], { STUB_MODE: "resultstring" });
    expect(r.code).toBe(0);
    expect(r.report().verdict).toEqual(CLAUDE_VERDICT);
  });

  test("copilot: prompt immediately after -p, plain stdout must be the verdict object", () => {
    for (const mode of ["ok", "fenced"]) {
      const r = run(["copilot", promptFile], { STUB_MODE: mode });
      expect(r.code, mode).toBe(0);
      expect(r.report().verdict, mode).toEqual(COPILOT_VERDICT);
      expect(readFileSync(r.promptCopy, "utf-8"), mode).toBe(FULL_PROMPT);
    }
  });

  test("copilot whitespace-only output is a failed review, not a verdict", () => {
    const r = run(["copilot", promptFile], { STUB_MODE: "blank" });
    expectFailure(r, { code: 1, stderr: "review FAILED - relaunch (empty output" });
  });

  test("a schema-valid verdict with no tool call before it is a preamble, not a review", () => {
    // Issue 94: codex ended its turn on the narration line and the empty
    // verdict read as clean. The schema cannot catch it (codex fills the
    // narration into the schema too); the missing reads do.
    for (const tool of ["codex", "claude"]) {
      const r = run([tool, promptFile], { STUB_MODE: "preamble" });
      expectFailure(
        r,
        { code: 1, stderr: "review FAILED - relaunch (no tool calls before the final message" },
        tool,
      );
    }
  });

  test("a final message that is not the verdict object fails the review", () => {
    const cases = [
      { id: "codex prose", tool: "codex", mode: "prose", reason: "final message is not JSON" },
      {
        id: "codex missing key",
        tool: "codex",
        mode: "badshape",
        reason: "non_blocking is not an array",
      },
      { id: "copilot prose", tool: "copilot", mode: "prose", reason: "final message is not JSON" },
      // The schema says additionalProperties false; the script's own reading
      // of a plain-text (copilot) verdict must be exactly as strict.
      {
        id: "copilot extra key",
        tool: "copilot",
        mode: "extrakey",
        reason: "unexpected key(s): severity",
      },
      {
        id: "copilot extra finding key",
        tool: "copilot",
        mode: "extrafindingkey",
        reason: "blocking is not an array of exactly",
      },
    ];
    for (const { id, tool, mode, reason } of cases) {
      const r = run([tool, promptFile], { STUB_MODE: mode });
      expectFailure(
        r,
        { code: 1, stderr: `review FAILED - relaunch (not a verdict: ${reason}` },
        id,
      );
    }
  });

  test("a stub that reads stdin completes: stdin is 'ignore', not an open pipe", () => {
    const r = run(["codex", promptFile], { STUB_READ_STDIN: "1" });
    expect(r.code).toBe(0);
    expect(r.report().verdict).toEqual(CODEX_VERDICT);
  });

  test("--stdin-prompt serves the prompt file as stdin for codex and claude", () => {
    const cases = [
      { id: "codex", verdict: CODEX_VERDICT },
      { id: "claude", verdict: CLAUDE_VERDICT },
    ];
    for (const { id: tool, verdict } of cases) {
      const r = run([tool, promptFile, "--stdin-prompt"]);
      expect(r.code, tool).toBe(0);
      expect(r.report().verdict, tool).toEqual(verdict);
      expect(readFileSync(r.promptCopy, "utf-8"), tool).toBe(FULL_PROMPT);
    }
  });

  test("--stdin-prompt with copilot is a usage error: exit 2", () => {
    const r = run(["copilot", promptFile, "--stdin-prompt"]);
    expectFailure(r, { code: 2, stderr: "copilot does not support --stdin-prompt" });
  });

  test("--stdin-prompt delivers a prompt larger than any pipe buffer in full", () => {
    const hugePrompt = mintPrompt("huge-prompt", "");
    const hugeContent = "p".repeat(1 << 20);
    writeFileSync(hugePrompt, hugeContent);
    const r = run(["codex", hugePrompt, "--stdin-prompt"]);
    expect(r.code).toBe(0);
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(withCompanion(hugeContent));
  });

  test("a reviewer that ignores its stdin prompt file cannot hang or crash the run", () => {
    const hugePrompt = mintPrompt("huge-prompt-ignored", "p".repeat(1 << 20));
    const r = run(["codex", hugePrompt, "--stdin-prompt"], { STUB_SKIP_STDIN: "1" });
    expect(r.code).toBe(0);
    expect(r.report().verdict).toEqual(CODEX_VERDICT);
  });

  test("a large verdict is printed in full, not truncated at exit", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "big" });
    expect(r.code).toBe(0);
    expect(r.report().verdict.summary).toBe("x".repeat(BIG_VERDICT_BYTES));
  });

  test("codex stream cut before a verdict exits 1", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "cut" });
    expectFailure(r, {
      code: 1,
      stderr: "review FAILED - relaunch (stream ended without a verdict event",
    });
  });

  test("codex agent_message without a following turn.completed is narration, not a verdict", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "cutlate" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no turn.completed");
  });

  test("a stream cut inside a later turn voids the earlier turn's verdict", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "cutsecond" });
    expectFailure(r, { code: 1, stderr: "review FAILED - relaunch (stream cut mid-turn" });
  });

  test("a malformed trailing line voids the verdict even after turn.completed", () => {
    // The ok-mode fixture proves mid-stream garbage stays skippable; only a
    // truncated FINAL line may fail the review.
    const r = run(["codex", promptFile], { STUB_MODE: "trunctail" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("malformed trailing line");
  });

  test("claude stream ending without a result event exits 1", () => {
    const r = run(["claude", promptFile], { STUB_MODE: "cut" });
    expectFailure(r, {
      code: 1,
      stderr: "review FAILED - relaunch (stream ended without a verdict event",
    });
  });

  test("a claude result with is_error true is a failed review, even on CLI exit 0", () => {
    const r = run(["claude", promptFile], { STUB_MODE: "iserror" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("error_during_execution");
  });

  test("a reconnect error event followed by a verdict is a recovered stream: the verdict counts", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "reconnect" });
    expect(r.code).toBe(0);
    expect(r.report().verdict).toEqual(CODEX_VERDICT);
    expect(r.report().trajectory.map((row) => row.event)).toContain("error");
  });

  test("a failed turn is never cleared by a later turn's verdict", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "failedturnthenverdict" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("turn failed before any answer");
  });

  test("an error event after the last verdict still fails the capture", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "errorafter" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stream disconnected after the verdict");
  });

  test("an error event exits 1 even though the reviewer exited 0", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "error" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("stream disconnected before completion");
  });

  test("an empty stream exits 1: an empty review never reads as clean", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "empty" });
    expectFailure(r, { code: 1, stderr: "review FAILED - relaunch (empty output" });
  });

  test("a whitespace-only verdict exits 1 for both stream formats", () => {
    for (const tool of ["codex", "claude"]) {
      const r = run([tool, promptFile], { STUB_MODE: "blank" });
      expectFailure(r, { code: 1, stderr: "review FAILED - relaunch (empty verdict" }, tool);
    }
  });

  test("a verdict from a reviewer that exited non-zero still fails", () => {
    const r = run(["codex", promptFile], { STUB_EXIT: "3" });
    expectFailure(r, {
      code: 1,
      stderr: "review FAILED - relaunch (reviewer status: 3 (stderr kept at",
    });
  });

  test("missing reviewer binary exits 2, not 1", () => {
    const r = run(["codex", promptFile], {}, emptyBinDir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("reviewer binary not found");
  });

  /** A repository the shape a pre-commit review targets, carrying everything a copy of the checkout
   * once dragged along: a staged change under an unstaged edit, an untracked file, an ignored tree
   * and a nested worktree; `git status` must read the same after the run. */
  function fixtureRepo(): string {
    const repo = temp.dir("run-review-repo-");
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "one\n");
    mkdirSync(join(repo, "sub"));
    writeFileSync(join(repo, "sub", "tracked.txt"), "tracked\n");
    writeFileSync(join(repo, ".gitignore"), ".venv/\n.claude/\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    writeFileSync(join(repo, "a.txt"), "two\n");
    git(repo, "add", "a.txt");
    writeFileSync(join(repo, "a.txt"), "three\n");
    writeFileSync(join(repo, "sub", "note.txt"), "untracked\n");
    mkdirSync(join(repo, ".venv"));
    writeFileSync(join(repo, ".venv", "big.bin"), "x".repeat(1 << 16));
    git(repo, "worktree", "add", "-q", join(repo, ".claude", "worktrees", "other"), "-b", "other");
    return repo;
  }

  function porcelain(repo: string): string {
    return git(repo, "status", "--porcelain", "-uall");
  }

  /** The stub's report of the copy as the reviewer saw it (the stub's cwd-report block names the lines). */
  function cwdReport(file: string) {
    const [cwd, top, branch, status, head, commits, aText, lfsSmudge, branchDiff, origHead] =
      readFileSync(file, "utf-8").split("\n");
    return {
      cwd,
      top,
      branch,
      status: status?.split("|").filter(Boolean) ?? [],
      head,
      commits,
      aText,
      lfsSmudge,
      branchDiff,
      origHead,
    };
  }

  const BWRAP_LINE =
    "codex sandbox unavailable (bwrap: Failed to make / slave: Permission denied): reviewing an unsandboxed snapshot copy at ";

  test("codex whose bubblewrap sandbox cannot start reviews an unsandboxed snapshot copy that dies with the review", () => {
    const repo = fixtureRepo();
    const before = porcelain(repo);
    const reportFile = join(binDir, "cwd-report-copy");
    const r = run(
      ["codex", promptFile],
      { STUB_SANDBOX: "bwrap", STUB_CWD_REPORT: reportFile },
      undefined,
      join(repo, "sub"),
    );
    expect(r.code).toBe(0);
    expect(r.report().sandbox).toBe("copy");
    expect(r.report().verdict).toEqual(CODEX_VERDICT);
    // The reviewer ran in the cwd's twin inside the copy, on the branch, with the staged change intact.
    const seen = cwdReport(reportFile);
    expect(seen.cwd).toMatch(/\/rubber-duck-[^/]+\/repo\/sub$/);
    expect(seen.top).toBe(dirname(seen.cwd as string));
    expect(seen.branch).toBe("main");
    // One status line is the whole proof that nothing else travelled: a.txt reads as staged, not as
    // edited, and the untracked note, the ignored tree, and the nested worktree are absent.
    expect(seen.status).toEqual(["M  a.txt"]);
    expect(seen.aText).toBe("two");
    // Its write landed in the copy, the copy is gone, and the checkout reads as before.
    expect(r.copyLeft).toBe(false);
    expect(existsSync(join(repo, "REVIEWER_WROTE"))).toBe(false);
    expect(porcelain(repo)).toBe(before);
    expect(r.stderr).toContain(BWRAP_LINE);
  });

  test("a launch directory with no directory twin inside the copy (ignored, or under a staged file or symlink) starts at the copy's root", () => {
    const ignored = fixtureRepo();
    // sub/ replaced by a staged file named sub, then recreated unstaged with a child, so the twin of
    // sub is that file (no cwd) and the twin of sub/deep lies under a file (ENOTDIR, no cwd either).
    const replaced = fixtureRepo();
    rmSync(join(replaced, "sub"), { recursive: true });
    writeFileSync(join(replaced, "sub"), "a file where the directory was\n");
    git(replaced, "add", "-A", "sub");
    rmSync(join(replaced, "sub"));
    mkdirSync(join(replaced, "sub", "deep"), { recursive: true });
    // sub/ replaced by a staged symlink to its own live path, then recreated unstaged with a child: the
    // twin of sub is a symlink into the live checkout and the twin of sub/deep resolves through it, and
    // following either would start the reviewer in the checkout under review.
    const linked = fixtureRepo();
    rmSync(join(linked, "sub"), { recursive: true });
    symlinkSync(join(linked, "sub"), join(linked, "sub"));
    git(linked, "add", "-A", "sub");
    rmSync(join(linked, "sub"));
    mkdirSync(join(linked, "sub", "deep"), { recursive: true });
    for (const [id, cwd] of [
      ["ignored", join(ignored, ".venv")],
      ["replaced-by-a-file", join(replaced, "sub")],
      ["under-a-file", join(replaced, "sub", "deep")],
      ["replaced-by-a-symlink", join(linked, "sub")],
      ["under-a-symlink", join(linked, "sub", "deep")],
    ] as const) {
      const reportFile = join(binDir, `cwd-report-${id}`);
      const r = run(
        ["codex", promptFile],
        { STUB_SANDBOX: "bwrap", STUB_CWD_REPORT: reportFile },
        undefined,
        cwd,
      );
      expect(r.code, id).toBe(0);
      const seen = cwdReport(reportFile);
      expect(seen.cwd, id).toMatch(/\/rubber-duck-[^/]+\/repo$/);
      expect(seen.top, id).toBe(seen.cwd);
    }
  });

  test("a blobless partial clone snapshots as it is: sparse entries stay out, and a base blob the checkout lacks arrives from its promisor remote", () => {
    // The origin allows filtered fetches; the clone takes no blobs and checks out the sub/ cone, so
    // other/b.txt is skip-worktree with its blob only on the promisor remote. The topic branch changes
    // a.txt, whose base blob the clone never fetched either.
    const origin = temp.dir("run-review-promisor-");
    git(origin, "init", "-q", "-b", "main");
    writeFileSync(join(origin, "a.txt"), "one\n");
    mkdirSync(join(origin, "sub"));
    writeFileSync(join(origin, "sub", "tracked.txt"), "tracked\n");
    mkdirSync(join(origin, "other"));
    writeFileSync(join(origin, "other", "b.txt"), "elsewhere\n");
    git(origin, "add", ".");
    git(origin, "commit", "-q", "-m", "init");
    git(origin, "config", "uploadpack.allowFilter", "true");
    git(origin, "checkout", "-q", "-b", "topic");
    writeFileSync(join(origin, "a.txt"), "two\n");
    git(origin, "commit", "-q", "-am", "two");
    // Three spellings of one local promisor URL, each behind an insteadOf alias, with the promisor
    // flag in another of git's boolean spellings: git's own reading of the flag and the alias must
    // travel, and the path git reads from the checkout's top level must hold where the copy lives:
    // a plain relative path, one through a symlink that a lexical `..` would collapse wrongly, and
    // git's own `~/` expansion.
    const shapes: [string, (sparse: string) => string, Record<string, string>][] = [
      ["relative", (sparse) => relative(sparse, origin), {}],
      [
        "through-a-symlink",
        (sparse) => {
          symlinkSync(join(origin, ".git"), join(sparse, "link"));
          return "link/..";
        },
        {},
      ],
      ["home-relative", () => `~/${basename(origin)}`, { HOME: dirname(origin) }],
    ];
    for (const [id, alias, env] of shapes) {
      const sparse = temp.dir("run-review-sparse-");
      git(
        sparse,
        "clone",
        "-q",
        "--filter=blob:none",
        "--no-checkout",
        "-b",
        "topic",
        `file://${origin}`,
        ".",
      );
      git(sparse, "sparse-checkout", "set", "--cone", "sub");
      git(sparse, "checkout", "-q", "topic");
      writeFileSync(join(sparse, "sub", "tracked.txt"), "changed\n");
      git(sparse, "add", "sub/tracked.txt");
      git(sparse, "config", "remote.origin.promisor", "yes");
      git(sparse, "config", "remote.origin.url", "lazy:origin");
      git(sparse, "config", `url.${alias(sparse)}.insteadOf`, "lazy:origin");
      const reportFile = join(binDir, `cwd-report-sparse-${id}`);
      const r = run(
        ["codex", promptFile],
        { STUB_SANDBOX: "bwrap", STUB_CWD_REPORT: reportFile, ...env },
        undefined,
        sparse,
      );
      expect(r.code, id).toBe(0);
      const seen = cwdReport(reportFile);
      expect(seen.status, id).toEqual(["M  sub/tracked.txt"]);
      // A content diff against origin/main needs the base blob of a.txt, which only the promisor remote has.
      expect(seen.branchDiff, id).toBe(" 1 file changed, 1 insertion(+), 1 deletion(-)");
    }
  });

  test("ORIG_HEAD travels with the snapshot, so the tip before a reset or rebase resolves as a diff base in the copy", () => {
    const repo = fixtureRepo();
    git(repo, "reset", "-q", "--soft", "HEAD");
    const reportFile = join(binDir, "cwd-report-orig-head");
    const r = run(
      ["codex", promptFile],
      { STUB_SANDBOX: "bwrap", STUB_CWD_REPORT: reportFile },
      undefined,
      repo,
    );
    expect(r.code).toBe(0);
    const seen = cwdReport(reportFile);
    expect(seen.origHead).toBe(seen.head);
  });

  test("a linked worktree, a detached checkout, and an unborn branch each snapshot their own HEAD and index", () => {
    const repo = fixtureRepo();
    const linked = temp.dir("run-review-linked-");
    git(repo, "worktree", "add", "-q", linked, "-b", "topic");
    writeFileSync(join(linked, "a.txt"), "topic\n");
    git(linked, "add", "a.txt");
    const detached = temp.dir("run-review-detached-");
    git(repo, "worktree", "add", "-q", "--detach", detached);
    writeFileSync(join(detached, "a.txt"), "detached\n");
    git(detached, "add", "a.txt");
    const unborn = temp.dir("run-review-unborn-");
    git(unborn, "init", "-q", "-b", "main");
    writeFileSync(join(unborn, "a.txt"), "unborn\n");
    git(unborn, "add", "a.txt");
    const cases = [
      {
        id: "linked",
        cwd: linked,
        branch: "topic",
        head: git(linked, "rev-parse", "HEAD").trim(),
        status: "M  a.txt",
      },
      {
        id: "detached",
        cwd: detached,
        branch: "",
        head: git(detached, "rev-parse", "HEAD").trim(),
        status: "M  a.txt",
      },
      { id: "unborn", cwd: unborn, branch: "main", head: "", status: "A  a.txt" },
    ];
    for (const { id, cwd, branch, head, status } of cases) {
      const reportFile = join(binDir, `cwd-report-${id}`);
      const r = run(
        ["codex", promptFile],
        { STUB_SANDBOX: "bwrap", STUB_CWD_REPORT: reportFile },
        undefined,
        cwd,
      );
      expect(r.code, id).toBe(0);
      const seen = cwdReport(reportFile);
      expect(seen.top, id).toMatch(/\/rubber-duck-[^/]+\/repo$/);
      expect(seen.branch, id).toBe(branch);
      expect(seen.head, id).toBe(head);
      expect(seen.status, id).toEqual([status]);
      expect(existsSync(join(cwd, "REVIEWER_WROTE")), id).toBe(false);
    }
  });

  test("a shallow clone's boundary travels with the snapshot, so the copy's history reads as far as the clone's", () => {
    const origin = temp.dir("run-review-origin-");
    git(origin, "init", "-q", "-b", "main");
    for (const text of ["one", "two"]) {
      writeFileSync(join(origin, "a.txt"), `${text}\n`);
      git(origin, "add", "a.txt");
      git(origin, "commit", "-q", "-m", text);
    }
    const shallow = temp.dir("run-review-shallow-");
    git(shallow, "clone", "-q", "--depth", "1", `file://${origin}`, ".");
    writeFileSync(join(shallow, "a.txt"), "three\n");
    git(shallow, "add", "a.txt");
    const reportFile = join(binDir, "cwd-report-shallow");
    const r = run(
      ["codex", promptFile],
      { STUB_SANDBOX: "bwrap", STUB_CWD_REPORT: reportFile },
      undefined,
      shallow,
    );
    expect(r.code).toBe(0);
    const seen = cwdReport(reportFile);
    expect(seen.status).toEqual(["M  a.txt"]);
    // Without the boundary, counting dies at the clone's missing parent instead of stopping at it.
    expect(seen.commits).toBe("1");
  });

  // A removal that only ran on the success path would leave one full checkout
  // behind per failed review, and a failed review is the one most often rerun.
  test("a failed verdict in copy mode keeps the capture its failure names and still removes the snapshot copy", () => {
    const repo = fixtureRepo();
    const r = run(
      ["codex", promptFile],
      { STUB_SANDBOX: "bwrap", STUB_MODE: "prose" },
      undefined,
      repo,
    );
    expectFailure(r, {
      code: 1,
      stderr: "review FAILED - relaunch (not a verdict: final message is not JSON; output kept at",
    });
    expect(r.captureKept).toBe(true);
    expect(r.copyLeft).toBe(false);
  });

  test("copy mode drops every GIT_* variable, so the reviewer's git reads the copy, not the checkout", () => {
    const repo = fixtureRepo();
    const reportFile = join(binDir, "cwd-report-redirect");
    const r = run(
      ["codex", promptFile],
      {
        STUB_SANDBOX: "bwrap",
        STUB_CWD_REPORT: reportFile,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.worktree",
        GIT_CONFIG_VALUE_0: repo,
        GIT_DIR: join(repo, ".git"),
      },
      undefined,
      repo,
    );
    expect(r.code).toBe(0);
    const seen = cwdReport(reportFile);
    expect(seen.top).toBe(seen.cwd);
    expect(seen.top).not.toBe(repo);
    expect(seen.status).toEqual(["M  a.txt"]);
    expect(existsSync(join(repo, "REVIEWER_WROTE"))).toBe(false);
  });

  test("a relative GIT_DIR and GIT_WORK_TREE, valid from the launch directory, still snapshot the whole index", () => {
    const repo = fixtureRepo();
    const reportFile = join(binDir, "cwd-report-relative-gitdir");
    const r = run(
      ["codex", promptFile],
      {
        STUB_SANDBOX: "bwrap",
        STUB_CWD_REPORT: reportFile,
        GIT_DIR: "../.git",
        GIT_WORK_TREE: "..",
      },
      undefined,
      join(repo, "sub"),
    );
    expect(r.code).toBe(0);
    const seen = cwdReport(reportFile);
    expect(seen.top).not.toBe(repo);
    // Read from the subdirectory, the snapshot still holds the whole index: a.txt is staged, not deleted.
    expect(seen.status).toEqual(["M  a.txt"]);
    expect(seen.aText).toBe("two");
  });

  test("an intent-to-add entry stays intent-to-add in the copy, so the staged diff there is the checkout's", () => {
    const repo = fixtureRepo();
    writeFileSync(join(repo, "new.txt"), "not staged yet\n");
    git(repo, "add", "-N", "new.txt");
    const reportFile = join(binDir, "cwd-report-intent-to-add");
    const r = run(
      ["codex", promptFile],
      { STUB_SANDBOX: "bwrap", STUB_CWD_REPORT: reportFile },
      undefined,
      repo,
    );
    expect(r.code).toBe(0);
    // A listing of the index entries would have staged new.txt as an empty file: "A  new.txt".
    expect(cwdReport(reportFile).status).toEqual(["M  a.txt", " A new.txt"]);
  });

  test.skipIf(Bun.which("git-lfs") === null)(
    "a Git LFS pointer is checked out as the pointer, never fetched: the copy has no remote to fetch from",
    () => {
      // A hand-written pointer committed as-is, and a home whose global config wires the real
      // git-lfs filters the way `git lfs install` does. The launcher drops every GIT_* variable for
      // the copy, so the config reaches the copy's git through HOME, and the copy has no LFS objects.
      const repo = temp.dir("run-review-lfs-");
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(join(repo, ".gitattributes"), "a.txt filter=lfs diff=lfs merge=lfs -text\n");
      writeFileSync(
        join(repo, "a.txt"),
        `version https://git-lfs.github.com/spec/v1\noid sha256:${"0123456789abcdef".repeat(4)}\nsize 5\n`,
      );
      writeFileSync(join(repo, "b.txt"), "one\n");
      git(repo, "add", ".");
      git(repo, "commit", "-q", "-m", "init");
      writeFileSync(join(repo, "b.txt"), "two\n");
      git(repo, "add", "b.txt");
      const home = temp.dir("run-review-lfs-home-");
      writeFileSync(
        join(home, ".gitconfig"),
        '[filter "lfs"]\n\tclean = git-lfs clean -- %f\n\tsmudge = git-lfs smudge -- %f\n\tprocess = git-lfs filter-process\n\trequired = true\n',
      );
      const reportFile = join(binDir, "cwd-report-lfs");
      const r = run(
        ["codex", promptFile],
        {
          STUB_SANDBOX: "bwrap",
          STUB_CWD_REPORT: reportFile,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
        },
        undefined,
        repo,
      );
      expect(r.code).toBe(0);
      const seen = cwdReport(reportFile);
      // The positive control: the copy's git did have the smudge filter to run.
      expect(seen.lfsSmudge).toBe("git-lfs smudge -- %f");
      expect(seen.status).toEqual(["M  b.txt"]);
      expect(seen.aText).toBe("version https://git-lfs.github.com/spec/v1");
    },
  );

  test("copy mode runs codex under a scratch CODEX_HOME holding copies of the user's config and credentials, so codex's trust write never reaches the user's file", () => {
    const repo = fixtureRepo();
    const home = temp.dir("run-review-codex-home-");
    writeFileSync(join(home, "config.toml"), 'model = "example"\n');
    writeFileSync(join(home, "auth.json"), '{"token":"example"}\n');
    const homeReport = join(binDir, "home-report-copy");
    const r = run(
      ["codex", promptFile],
      { STUB_SANDBOX: "bwrap", STUB_HOME_REPORT: homeReport, CODEX_HOME: home },
      undefined,
      repo,
    );
    expect(r.code).toBe(0);
    const [seenHome, seenConfig, seenFiles] = readFileSync(homeReport, "utf-8").split("\n");
    expect(seenHome).toMatch(/\/rubber-duck-[^/]+\/codex-home$/);
    expect(seenConfig).toBe('model = "example"');
    expect(seenFiles?.trim().split(/\s+/).sort()).toEqual(["auth.json", "config.toml", "sessions"]);
    // The stub appended a trust block to the config it saw; the user's file is byte-identical.
    expect(readFileSync(join(home, "config.toml"), "utf-8")).toBe('model = "example"\n');
    expect(r.homeLeft).toBe(false);
  });

  test("the review's transcript codex writes under the scratch home's sessions lands in the user's own sessions directory and survives the cleanup", () => {
    const repo = fixtureRepo();
    const home = temp.dir("run-review-codex-home-");
    writeFileSync(join(home, "config.toml"), 'model = "example"\n');
    // An earlier review's transcript already in the user's directory must not be touched.
    mkdirSync(join(home, "sessions", "2026", "10", "10"), { recursive: true });
    const earlier = join(home, "sessions", "2026", "10", "10", "rollout-earlier.jsonl");
    writeFileSync(earlier, '{"earlier":true}\n');
    const homeReport = join(binDir, "home-report-sessions");
    const r = run(
      ["codex", promptFile],
      {
        STUB_SANDBOX: "bwrap",
        STUB_HOME_REPORT: homeReport,
        STUB_ROLLOUT: '{"review":true}',
        CODEX_HOME: home,
      },
      undefined,
      repo,
    );
    expect(r.code).toBe(0);
    expect(r.homeLeft).toBe(false);
    expect(lstatSync(join(home, "sessions")).isDirectory()).toBe(true);
    expect(
      readFileSync(join(home, "sessions", "2026", "10", "11", "rollout-example.jsonl"), "utf-8"),
    ).toBe('{"review":true}');
    expect(readFileSync(earlier, "utf-8")).toBe('{"earlier":true}\n');
  });

  test("a CODEX_HOME given as a relative path still receives the transcript: the link is read from inside the scratch home, not from the cwd", () => {
    const repo = fixtureRepo();
    const homeReport = join(binDir, "home-report-sessions-relative");
    const r = run(
      ["codex", promptFile],
      {
        STUB_SANDBOX: "bwrap",
        STUB_HOME_REPORT: homeReport,
        STUB_ROLLOUT: '{"relative":true}',
        CODEX_HOME: ".codex-home",
      },
      undefined,
      repo,
    );
    expect(r.code).toBe(0);
    expect(
      readFileSync(
        join(repo, ".codex-home", "sessions", "2026", "10", "11", "rollout-example.jsonl"),
        "utf-8",
      ),
    ).toBe('{"relative":true}');
  });

  test("a codex home without a sessions directory yet gets one, so the first review's transcript has a place to land", () => {
    const repo = fixtureRepo();
    const home = temp.dir("run-review-codex-home-");
    const homeReport = join(binDir, "home-report-sessions-fresh");
    const r = run(
      ["codex", promptFile],
      {
        STUB_SANDBOX: "bwrap",
        STUB_HOME_REPORT: homeReport,
        STUB_ROLLOUT: '{"first":true}',
        CODEX_HOME: join(home, "fresh"),
      },
      undefined,
      repo,
    );
    expect(r.code).toBe(0);
    expect(
      readFileSync(
        join(home, "fresh", "sessions", "2026", "10", "11", "rollout-example.jsonl"),
        "utf-8",
      ),
    ).toBe('{"first":true}');
  });

  test("a token refresh codex writes into the scratch auth.json goes back to the user's home; the config does not", () => {
    const repo = fixtureRepo();
    const home = temp.dir("run-review-codex-home-");
    writeFileSync(join(home, "config.toml"), 'model = "example"\n');
    writeFileSync(join(home, "auth.json"), '{"token":"old"}\n');
    const homeReport = join(binDir, "home-report-refresh");
    const r = run(
      ["codex", promptFile],
      {
        STUB_SANDBOX: "bwrap",
        STUB_HOME_REPORT: homeReport,
        STUB_REFRESH_AUTH: '{"token":"refreshed"}',
        CODEX_HOME: home,
      },
      undefined,
      repo,
    );
    expect(r.code).toBe(0);
    expect(readFileSync(join(home, "auth.json"), "utf-8")).toBe('{"token":"refreshed"}');
    expect(readFileSync(join(home, "config.toml"), "utf-8")).toBe('model = "example"\n');
    expect(r.homeLeft).toBe(false);
  });

  test("a parallel review's refresh of the user's auth.json is not rolled back by a review whose scratch copy never changed", () => {
    const repo = fixtureRepo();
    const home = temp.dir("run-review-codex-home-");
    writeFileSync(join(home, "config.toml"), 'model = "example"\n');
    writeFileSync(join(home, "auth.json"), '{"token":"old"}\n');
    const homeReport = join(binDir, "home-report-parallel");
    const r = run(
      ["codex", promptFile],
      {
        STUB_SANDBOX: "bwrap",
        STUB_HOME_REPORT: homeReport,
        STUB_REAL_AUTH_PATH: join(home, "auth.json"),
        STUB_REAL_AUTH_WRITE: '{"token":"refreshed-by-the-other-review"}',
        CODEX_HOME: home,
      },
      undefined,
      repo,
    );
    expect(r.code).toBe(0);
    expect(readFileSync(join(home, "auth.json"), "utf-8")).toBe(
      '{"token":"refreshed-by-the-other-review"}',
    );
  });

  test("a scratch refresh is not returned over credentials another review changed meanwhile; the run warns instead", () => {
    const repo = fixtureRepo();
    const home = temp.dir("run-review-codex-home-");
    writeFileSync(join(home, "config.toml"), 'model = "example"\n');
    writeFileSync(join(home, "auth.json"), '{"token":"old"}\n');
    const homeReport = join(binDir, "home-report-conflict");
    const r = run(
      ["codex", promptFile],
      {
        STUB_SANDBOX: "bwrap",
        STUB_HOME_REPORT: homeReport,
        STUB_REFRESH_AUTH: '{"token":"mine"}',
        STUB_REAL_AUTH_PATH: join(home, "auth.json"),
        STUB_REAL_AUTH_WRITE: '{"token":"theirs"}',
        CODEX_HOME: home,
      },
      undefined,
      repo,
    );
    expect(r.code).toBe(0);
    expect(readFileSync(join(home, "auth.json"), "utf-8")).toBe('{"token":"theirs"}');
    expect(r.stderr).toContain("codex credentials changed elsewhere during the review");
  });

  test.skipIf(process.getuid?.() === 0)(
    "a credentials file the launcher cannot read fails the review cleanly, copy and scratch home removed",
    () => {
      const repo = fixtureRepo();
      const home = temp.dir("run-review-codex-home-");
      writeFileSync(join(home, "config.toml"), 'model = "example"\n');
      writeFileSync(join(home, "auth.json"), "{}\n");
      chmodSync(join(home, "auth.json"), 0o000);
      // A foreground spawn failure removes its whole scratch dir, so the proof of cleanup is an
      // empty private TMPDIR afterwards (shared tmp would show other sessions' reviews).
      const privateTmp = temp.dir("run-review-cleanup-");
      const scratchDirs = () =>
        new Set(readdirSync(privateTmp).filter((name) => name.startsWith("rubber-duck-")));
      const before = scratchDirs();
      try {
        const r = run(
          ["codex", promptFile],
          { STUB_SANDBOX: "bwrap", CODEX_HOME: home, TMPDIR: privateTmp },
          undefined,
          repo,
        );
        expectFailure(r, { code: 1, stderr: "spawn failed: Error: scratch codex home failed" });
        expect([...scratchDirs()].filter((name) => !before.has(name))).toEqual([]);
      } finally {
        chmodSync(join(home, "auth.json"), 0o600);
      }
    },
  );

  test("read-only mode leaves CODEX_HOME alone", () => {
    const repo = fixtureRepo();
    const home = temp.dir("run-review-codex-home-");
    const homeReport = join(binDir, "home-report-readonly");
    const r = run(
      ["codex", promptFile],
      { STUB_HOME_REPORT: homeReport, CODEX_HOME: home },
      undefined,
      repo,
    );
    expect(r.code).toBe(0);
    expect(readFileSync(homeReport, "utf-8").split("\n")[0]).toBe(home);
  });

  test("the sandbox probe passing keeps codex read-only: no copy, no fallback line", () => {
    const repo = fixtureRepo();
    const r = run(["codex", promptFile], {}, undefined, repo);
    expect(r.code).toBe(0);
    expect(r.report().sandbox).toBeUndefined();
    expect(r.copyLeft).toBe(false);
    expect(r.stderr).not.toContain("snapshot copy");
  });

  test("codex whose sandbox cannot start, outside a git repository, is a usage error: exit 2", () => {
    // The launcher names the resolved path (on macOS the temp root is a symlink under /private).
    const bare = realpathSync(temp.dir("run-review-norepo-"));
    const r = run(["codex", promptFile], { STUB_SANDBOX: "bwrap" }, undefined, bare);
    expectFailure(r, {
      code: 2,
      stderr: `codex sandbox unavailable (bwrap: Failed to make / slave: Permission denied) and ${bare} is not inside a git repository: nothing to snapshot`,
    });
  });

  test("--background in copy mode: the launch record carries the sandbox and --extract reports it", () => {
    const repo = fixtureRepo();
    const launched = run(
      ["codex", promptFile, "--background"],
      { STUB_SANDBOX: "bwrap" },
      undefined,
      repo,
    );
    expect(launched.code).toBe(0);
    const outputFile = backgroundOutputFile(launched.stdout);
    expect(
      JSON.parse(readFileSync(join(dirname(outputFile), "review.status"), "utf-8")),
    ).toMatchObject({ tool: "codex", output: "review.jsonl", sandbox: "copy" });
    expect(waitForStatus(outputFile)).toBe("0");
    const extracted = run(["codex", "--extract", outputFile]);
    expect(extracted.code).toBe(0);
    expect(extracted.report().sandbox).toBe("copy");
    expect(extracted.copyLeft).toBe(false);
  });

  test("a launch record naming an unknown sandbox is a usage error: exit 2", () => {
    const dir = temp.dir("run-review-sandbox-");
    writeFileSync(join(dir, "review.jsonl"), COMPLETE_CODEX_STREAM);
    writeFileSync(
      join(dir, "review.status"),
      JSON.stringify({ tool: "codex", output: "review.jsonl", sandbox: "none", status: "0" }),
    );
    expectFailure(run(["codex", "--extract", join(dir, "review.jsonl")]), {
      code: 2,
      stderr: "unknown sandbox",
    });
  });

  test("a snapshot that fails midway leaves no partial copy in the retained capture dir", () => {
    const repo = fixtureRepo();
    const launched = run(
      ["codex", promptFile, "--background"],
      { STUB_SANDBOX: "bwrap", STUB_GIT_FAIL: "checkout-index" },
      undefined,
      repo,
    );
    expect(launched.code).toBe(0);
    const outputFile = backgroundOutputFile(launched.stdout);
    const status = waitForStatus(outputFile);
    expect(status).toContain(
      `spawn failed: Error: snapshot of ${realpathSync(repo)} failed: git checkout-index`,
    );
    expect(status).toContain(": fatal: disk full");
    expect(existsSync(join(dirname(outputFile), "repo"))).toBe(false);
    rmSync(dirname(outputFile), { recursive: true, force: true });
  });

  test("unknown reviewer or missing prompt file are usage errors: exit 2", () => {
    const cases = [
      { id: "unknown-reviewer", args: ["gemini", promptFile], message: "unknown reviewer: gemini" },
      { id: "no-prompt-file", args: ["codex"], message: "expected exactly one <prompt-file>" },
      {
        id: "unreadable-prompt-file",
        args: ["codex", join(dirname(promptFile), "no-such-prompt.txt")],
        message: "cannot read prompt file",
      },
    ];
    for (const { id, args, message } of cases) {
      const r = run(args);
      expectFailure(r, { code: 2, stderr: message }, id);
    }
  });

  test("prepare mints a distinct tmp directory per call and prints the section file inside it", () => {
    const first = mintPrompt("api-gateway");
    const second = mintPrompt("api-gateway");
    expect(first).not.toBe(second);
    for (const file of [first, second]) {
      expect(dirname(dirname(file))).toBe(tmpdir());
      expect(basename(dirname(file)).startsWith("rubber-duck-prompt-")).toBe(true);
      expect(basename(file)).toBe("api-gateway.md");
      expect(readFileSync(join(dirname(file), ".minted-by-run-review"), "utf-8")).toBe("");
    }
  });

  test("prepare rejects a section that is not a bare file name, or a missing one: exit 2", () => {
    for (const [id, args] of [
      ["path-separator", ["prepare", "sub/dir"]],
      ["dot-dot", ["prepare", ".."]],
      ["empty", ["prepare", ""]],
      ["missing", ["prepare"]],
      ["extra", ["prepare", "a", "b"]],
    ] as const) {
      const r = run([...args]);
      expectFailure(r, { code: 2, stderr: "prepare" }, id);
    }
  });

  test("prepare and a launch purge sibling rubber-duck-* dirs older than 24 h, by age alone", () => {
    // Without this pin scratch dirs accumulate forever, or a purge that reaches
    // by name instead of age removes another session's in-flight review, or
    // follows a symlink out of tmp.
    const privateTmp = temp.dir("run-review-purge-");
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    const makeDir = (name: string, stale: boolean): string => {
      const dir = join(privateTmp, name);
      mkdirSync(dir);
      writeFileSync(join(dir, "review.jsonl"), "");
      if (stale) utimesSync(dir, dayAgo, dayAgo);
      return dir;
    };
    const staleCapture = makeDir("rubber-duck-stale", true);
    const stalePrompt = makeDir("rubber-duck-prompt-stale", true);
    const fresh = makeDir("rubber-duck-fresh", false);
    const unrelated = makeDir("other-tool-stale", true);
    const linkTarget = makeDir("not-rubber-duck-target", true);
    const link = join(privateTmp, "rubber-duck-link");
    symlinkSync(linkTarget, link);
    const staleFile = join(privateTmp, "rubber-duck-file");
    writeFileSync(staleFile, "");
    utimesSync(staleFile, dayAgo, dayAgo);

    const prepared = run(["prepare", "purge-probe"], { TMPDIR: privateTmp });
    expect(prepared.code).toBe(0);
    expect(prepared.stderr).toBe("");
    expect(dirname(prepared.stdout.trimEnd())).toStartWith(join(privateTmp, "rubber-duck-prompt-"));
    expect(existsSync(staleCapture)).toBe(false);
    expect(existsSync(stalePrompt)).toBe(false);
    for (const kept of [fresh, unrelated, linkTarget, link, staleFile]) {
      expect(existsSync(kept), kept).toBe(true);
    }

    // A launch purges too, and its own fresh capture dir survives its own purge.
    const staleAgain = makeDir("rubber-duck-stale-again", true);
    const launched = run(["codex", promptFile], { TMPDIR: privateTmp });
    expect(launched.code).toBe(0);
    expect(dirname(launched.report().capture)).toStartWith(join(privateTmp, "rubber-duck-"));
    expect(existsSync(staleAgain)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(link)).toBe(true);

    // A stale dir whose own modes refuse removal is made writable and removed, silently.
    if (process.getuid?.() !== 0) {
      const locked = makeDir("rubber-duck-locked", false);
      writeFileSync(join(locked, "pinned"), "");
      chmodSync(locked, 0o555);
      utimesSync(locked, dayAgo, dayAgo);
      try {
        const r = run(["prepare", "purge-probe"], { TMPDIR: privateTmp });
        expect(r.code).toBe(0);
        expect(r.stdout).toStartWith(join(privateTmp, "rubber-duck-prompt-"));
        expect(r.stderr).toBe("");
        expect(existsSync(locked)).toBe(false);
      } finally {
        if (existsSync(locked)) chmodSync(locked, 0o755);
      }
    }
  });

  test("a prompt file that prepare did not mint is refused: exit 2", () => {
    // Negative controls for the collision guard. Each row is a way a shared
    // or predictable prompt could reach a launch without going through prepare.
    const predictable = join(binDir, "prompt.txt");
    writeFileSync(predictable, PROMPT);
    const nested = join(dirname(promptFile), "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "prompt.md"), PROMPT);
    // Right prefix, hand-made: no marker.
    const handMade = temp.dir("rubber-duck-prompt-");
    writeFileSync(join(handMade, "prompt.md"), PROMPT);
    // A symlink inside a minted dir that points at a shared file elsewhere.
    const linked = join(dirname(promptFile), "linked.md");
    symlinkSync(predictable, linked);
    // A hard link inside a minted dir to a shared file elsewhere.
    const hardLinked = join(dirname(promptFile), "hard-linked.md");
    linkSync(predictable, hardLinked);
    // A symlinked directory, prefix-named, pointing at a genuine minted dir.
    const aliasDir = join(tmpdir(), `rubber-duck-prompt-alias-${process.pid}`);
    symlinkSync(dirname(promptFile), aliasDir);
    mintedDirs.push(aliasDir);
    const notMinted = "prompt file must live in a directory minted by";
    for (const [id, file, message] of [
      ["hand-picked-tmp-path", predictable, notMinted],
      ["nested-inside-minted-dir", join(nested, "prompt.md"), notMinted],
      ["prefix-without-marker", join(handMade, "prompt.md"), notMinted],
      ["symlinked-minted-dir", join(aliasDir, basename(promptFile)), notMinted],
      ["symlink-out-of-minted-dir", linked, "not a symlink or hard link"],
      ["hard-link-to-shared-file", hardLinked, "not a symlink or hard link"],
    ] as const) {
      expectFailure(run(["codex", file]), { code: 2, stderr: message }, id);
    }
    // --background is a caller-facing launch too, not the internal capture.
    expectFailure(run(["codex", predictable, "--background"]), { code: 2, stderr: notMinted });
  });

  test("--capture without its --background launch record is refused: exit 2", () => {
    // --capture must not be a side door around the minted-prompt guard.
    const predictable = join(binDir, "capture-prompt.txt");
    writeFileSync(predictable, PROMPT);
    const scratch = temp.dir("rubber-duck-");
    const snapshot = join(scratch, "prompt.txt");
    writeFileSync(snapshot, PROMPT);
    const refused = { code: 2, stderr: "--capture is internal to --background" } as const;
    // Each row sets up the scratch dir, then launches against exactly that state.
    for (const [id, record, prompt] of [
      ["no-record", null, snapshot],
      ["record-for-other-reviewer", '{"tool":"claude","output":"review.jsonl"}', snapshot],
      ["record-for-other-output-file", '{"tool":"codex","output":"review.out"}', snapshot],
      ["prompt-not-the-snapshot", '{"tool":"codex","output":"review.jsonl"}', predictable],
    ] as const) {
      if (record === null) rmSync(join(scratch, "review.status"), { force: true });
      else writeFileSync(join(scratch, "review.status"), record);
      expectFailure(run(["codex", prompt, "--capture", scratch]), refused, id);
    }
  });

  test("the launcher appends every declaring skill's Review Criteria to the prompt, so a prompt cannot omit them", () => {
    const declaring = declaringSkills(SKILLS_ROOT);
    expect(declaring.map((skill) => skill.name)).toContain("code-standards");
    expect(declaring.map((skill) => skill.name)).not.toContain("rubber-duck-review");
    const r = run(["codex", promptFile]);
    expect(r.code).toBe(0);
    expect(r.report().criteria).toEqual(declaring.map((skill) => skill.name));
    const delivered = readFileSync(r.promptCopy, "utf-8");
    expect(delivered.startsWith(PROMPT.trimEnd())).toBe(true);
    expect(delivered).toBe(FULL_PROMPT);
  });

  test("the criteria subcommand prints the block a launch appends, so a review through a dedicated tool pastes the same text", () => {
    const launched = run(["codex", promptFile]);
    expect(launched.code).toBe(0);
    const delivered = readFileSync(launched.promptCopy, "utf-8");
    const block = delivered.slice(`${PROMPT.trimEnd()}\n\n`.length);
    expect(block.startsWith("## Companion review criteria\n")).toBe(true);
    const printed = run(["criteria"]);
    expect(printed.code).toBe(0);
    expect(printed.stdout).toBe(block);
    const none = run(["criteria", "--criteria", "none"]);
    expect(none.code).toBe(0);
    expect(none.stdout).toBe("");
    const only = run(["criteria", "--criteria", "code-standards"]);
    expect(only.code).toBe(0);
    expect(only.stdout).toBe(
      withCompanion(
        "x",
        declaringSkills(SKILLS_ROOT).filter((s) => s.name === "code-standards"),
      ).slice(3),
    );
    expectFailure(run(["criteria", "--criteria", "rubber-duck-review"]), {
      code: 2,
      stderr: "--criteria: rubber-duck-review declares no ## Review Criteria",
    });
  });

  test("--criteria none sends the caller's prompt unchanged and reports an empty criteria list", () => {
    const r = run(["codex", promptFile, "--criteria", "none"]);
    expect(r.code).toBe(0);
    expect(r.report().criteria).toEqual([]);
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(PROMPT);
  });

  test("--criteria <name> keeps that skill's section alone, for the lens choice on someone else's PR", () => {
    const only = declaringSkills(SKILLS_ROOT).filter((skill) => skill.name === "code-standards");
    const r = run(["codex", promptFile, "--criteria", "code-standards"]);
    expect(r.code).toBe(0);
    expect(r.report().criteria).toEqual(["code-standards"]);
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(withCompanion(PROMPT, only));
  });

  test("--criteria naming a skill that declares no section is a usage error that names the ones that do", () => {
    const declaring = declaringSkills(SKILLS_ROOT).map((skill) => skill.name);
    expectFailure(run(["codex", promptFile, "--criteria", "code-standards,rubber-duck-review"]), {
      code: 2,
      stderr: `--criteria: rubber-duck-review declares no ## Review Criteria; the installed skills that do: ${declaring.join(", ")}`,
    });
    expectFailure(run(["codex", "--extract", "--criteria", "none", pendingCapture()]), {
      code: 2,
      stderr: "--criteria applies only to a launch",
    });
  });

  test("discovery reads the siblings of the script's own skill directory and skips a context-specific heading", () => {
    // A scratch skills root: this skill copied whole (the script finds its root through its own
    // real path), one sibling declaring the heading, one declaring a context-specific variant.
    const root = temp.dir("run-review-skills-root-");
    cpSync(join(SKILLS_ROOT, "rubber-duck-review"), join(root, "rubber-duck-review"), {
      recursive: true,
    });
    mkdirSync(join(root, "alpha"));
    writeFileSync(
      join(root, "alpha", "SKILL.md"),
      "# Alpha\n\n## Review Criteria\n\n- an alpha rule\n- another\n\n## After\n\nnot criteria\n",
    );
    mkdirSync(join(root, "beta"));
    writeFileSync(
      join(root, "beta", "SKILL.md"),
      "# Beta\n\n## Landing Review Criteria\n\n- a beta rule\n",
    );
    // A page saved with CRLF endings: the heading still matches and the body comes through LF-normalised.
    mkdirSync(join(root, "gamma"));
    writeFileSync(
      join(root, "gamma", "SKILL.md"),
      "# Gamma\r\n\r\n## Review Criteria\r\n\r\n- a gamma rule\r\n- another\r\n\r\n## After\r\n",
    );
    const copiedScripts = join(root, "rubber-duck-review", "scripts");
    // The stub checks the schema path the launcher passes, which is the copy's.
    const r = run(
      ["codex", promptFile],
      { STUB_SCHEMA: realpathSync(join(copiedScripts, "verdict-schema.json")) },
      undefined,
      undefined,
      join(copiedScripts, "run-review.mts"),
    );
    expect(r.code).toBe(0);
    expect(r.report().criteria).toEqual(["alpha", "gamma"]);
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(
      `${PROMPT.trimEnd()}\n\n## Companion review criteria\n\n### alpha\n\n- an alpha rule\n- another\n\n### gamma\n\n- a gamma rule\n- another\n`,
    );
  });

  test("a reviewer silent past --stall is killed with its process group, the sleep it left behind included, and the run fails as a stall", () => {
    const pidFile = join(binDir, "stall-pids");
    const r = run(["codex", promptFile, "--stall", "1"], {
      STUB_MODE: "stall",
      STUB_PID_FILE: pidFile,
    });
    expectFailure(r, {
      code: 1,
      stderr: "review FAILED - relaunch (stalled: no stream event for 1 s",
    });
    expect(r.stderr).toContain(
      "review stalled: no stream event for 1 s; killing the reviewer (pid ",
    );
    expect(r.captureKept).toBe(true);
    const pids = stubPids(pidFile);
    expect(pids).toHaveLength(2);
    for (const pid of pids) expectGone(pid);
  }, 15000);

  test("a reviewer that keeps streaming past --stall is never a stall: each byte winds the clock again", () => {
    const r = run(["codex", promptFile, "--stall", "1"], { STUB_MODE: "trickle" });
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain("stalled");
    expect(r.report().verdict).toEqual(CODEX_VERDICT);
  }, 15000);

  test("--background records a stall as the run's status, so --extract --wait fails at once instead of waiting out --timeout", () => {
    const pidFile = join(binDir, "stall-bg-pids");
    const launch = run(["codex", promptFile, "--background", "--stall", "1"], {
      STUB_MODE: "stall",
      STUB_PID_FILE: pidFile,
    });
    expect(launch.code).toBe(0);
    const started = Date.now();
    const r = run([
      "codex",
      "--extract",
      "--wait",
      backgroundOutputFile(launch.stdout),
      "--timeout",
      "600",
    ]);
    expect(Date.now() - started).toBeLessThan(30000);
    expectFailure(r, {
      code: 1,
      stderr: "review FAILED - relaunch (stalled: no stream event for 1 s",
    });
    for (const pid of stubPids(pidFile)) expectGone(pid);
  }, 40000);

  test("--stall rejects a non-number and a delay past the 32-bit timer limit, and is refused on --extract", () => {
    // 2147484 s is 2147484000 ms, past the 32-bit limit, where a timer fires after 1 ms and
    // would kill the reviewer at once.
    for (const bad of ["soon", "2147484"]) {
      expectFailure(run(["codex", promptFile, "--stall", bad]), {
        code: 2,
        stderr: "--stall requires a whole number of seconds, 1 to 2147483",
      });
    }
    expectFailure(run(["codex", "--extract", "--stall", "5", pendingCapture()]), {
      code: 2,
      stderr: "--stall applies only to a launch",
    });
  });

  test("--background prints output-file and pid; --extract --wait returns the verdict once the monitor records the exit", () => {
    // A private prompt file, deleted right after launch: the monitor must
    // review its snapshot, not re-read the caller's (now gone) file. The
    // stub sleeps so the wait starts on a record that has no status yet.
    const bgPrompt = mintPrompt("bg-prompt");
    const r = run(["codex", bgPrompt, "--background"], { STUB_SLEEP: "1" });
    rmSync(bgPrompt);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/^output-file: \S+\/review\.jsonl\npid: \d+\n$/);
    const outputFile = backgroundOutputFile(r.stdout);
    const extracted = run(["codex", "--extract", "--wait", outputFile]);
    expect(extracted.code).toBe(0);
    expect(extracted.stderr).toBe("");
    expect(extracted.report().verdict).toEqual(CODEX_VERDICT);
    expect(extracted.report().capture).toBe(outputFile);
    expect(extracted.report().criteria).toEqual(declaringSkills(SKILLS_ROOT).map((s) => s.name));
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(FULL_PROMPT);
    rmSync(dirname(outputFile), { recursive: true, force: true });
  }, 15000);

  test("--extract --wait blocks on a launch record without a status, then reports the status that lands", async () => {
    const cases = [
      { status: "0", code: 0, stderr: "" },
      {
        status: "3",
        code: 1,
        stderr: "review FAILED - relaunch (recorded reviewer status: 3; output kept at <file>)\n",
      },
      { status: "not-found", code: 2, stderr: "reviewer binary not found: codex\n" },
    ];
    for (const { status, code, stderr } of cases) {
      const outputFile = pendingCapture();
      const proc = start(["codex", "--extract", "--wait", outputFile]);
      await Bun.sleep(1000);
      expect(proc.exitCode, status).toBeNull();
      recordStatus(outputFile, status);
      expect(await proc.exited, status).toBe(code);
      const stdout = await new Response(proc.stdout).text();
      expect(await new Response(proc.stderr).text(), status).toBe(
        stderr.replace("<file>", outputFile),
      );
      if (code === 0) {
        const report = JSON.parse(stdout) as Report;
        expect(report.verdict, status).toEqual(CODEX_VERDICT);
        expect(report.capture, status).toBe(outputFile);
      } else {
        expect(stdout, status).toBe("");
      }
    }
  }, 30000);

  test("--extract --wait --timeout 1 on a record that never completes exits 1 naming the file and the seconds", () => {
    for (const stream of [true, false]) {
      const outputFile = pendingCapture(stream);
      const started = Date.now();
      const r = run(["codex", "--extract", "--wait", "--timeout", "1", outputFile]);
      expect(Date.now() - started, String(stream)).toBeGreaterThanOrEqual(1000);
      expect(r.code, String(stream)).toBe(1);
      expect(r.stdout, String(stream)).toBe("");
      const file = escapeRegExp(outputFile);
      const kept = stream ? `; output kept at ${file}` : "";
      expect(r.stderr, String(stream)).toMatch(
        new RegExp(
          `^review FAILED - relaunch \\(--wait timed out: no exit status recorded beside ${file} after \\d+ s${kept}\\)\\n$`,
        ),
      );
    }
  }, 15000);

  test("--extract --wait fails at once, exit 2, when the record is missing or names another launch", () => {
    // The launch writes the record before printing the output-file line, so
    // no record on the first read is a wrong path: it must not poll for an hour.
    const missingDir = join(tmpdir(), `run-review-missing-${process.pid}`, "review.jsonl");
    const bareDir = temp.dir("run-review-bare-");
    writeFileSync(join(bareDir, "review.jsonl"), COMPLETE_CODEX_STREAM);
    const codexCapture = pendingCapture();
    const noRecord = "no launch record beside";
    for (const [id, tool, file, message] of [
      ["missing-directory", "codex", missingDir, noRecord],
      ["directory-without-record", "codex", join(bareDir, "review.jsonl"), noRecord],
      ["other-reviewer", "claude", codexCapture, "launched with reviewer 'codex', not 'claude'"],
      [
        "other-file",
        "codex",
        join(dirname(codexCapture), "prompt.txt"),
        "output file is 'review.jsonl'",
      ],
    ] as const) {
      const started = Date.now();
      const r = run([tool, "--extract", "--wait", file]);
      expect(Date.now() - started, id).toBeLessThan(1900);
      expectFailure(r, { code: 2, stderr: message }, id);
    }
  });

  test("--wait and --timeout outside --extract --wait, or a bad timeout, are usage errors: exit 2", () => {
    const outputFile = pendingCapture();
    const badTimeout = "--timeout requires a whole number of seconds, 1 to 2147483";
    for (const [id, args, message] of [
      ["wait-on-launch", ["codex", promptFile, "--wait"], "--wait applies only to --extract"],
      [
        "timeout-on-launch",
        ["codex", promptFile, "--timeout", "5"],
        "--timeout applies only to --extract",
      ],
      [
        "timeout-without-wait",
        ["codex", "--extract", "--timeout", "5", outputFile],
        "--timeout applies only to --extract --wait",
      ],
      ["timeout-zero", ["codex", "--extract", "--wait", "--timeout", "0", outputFile], badTimeout],
      [
        "timeout-word",
        ["codex", "--extract", "--wait", "--timeout", "soon", outputFile],
        badTimeout,
      ],
      ["timeout-no-value", ["codex", "--extract", "--wait", outputFile, "--timeout"], badTimeout],
      ["no-file", ["codex", "--extract", "--wait"], "--extract takes exactly one <output-file>"],
      [
        "two-files",
        ["codex", "--extract", "--wait", outputFile, outputFile],
        "--extract takes exactly one <output-file>",
      ],
      ["unknown-flag", ["codex", "--extract", "--bogus", outputFile], "unknown flag: --bogus"],
    ] as const) {
      expectFailure(run([...args]), { code: 2, stderr: message }, id);
    }
  });

  test("--extract fails a background run whose reviewer exited non-zero", () => {
    const r = run(["codex", promptFile, "--background"], { STUB_EXIT: "3" });
    expect(r.code).toBe(0);
    const outputFile = backgroundOutputFile(r.stdout);
    expect(waitForStatus(outputFile)).toBe("3");
    const extracted = run(["codex", "--extract", outputFile]);
    expect(extracted.code).toBe(1);
    expect(extracted.stderr).toContain("recorded reviewer status: 3");
    // Positive control for the kept-output suffix: the stream is still there.
    expect(extracted.stderr).toContain(`output kept at ${outputFile}`);
  });

  test("--extract on a completed run whose stream was deleted fails without naming a kept file", () => {
    const r = run(["codex", promptFile, "--background"]);
    const outputFile = backgroundOutputFile(r.stdout);
    expect(waitForStatus(outputFile)).toBe("0");
    rmSync(outputFile);
    const extracted = run(["codex", "--extract", outputFile]);
    expectFailure(extracted, { code: 1, stderr: "cannot read output file" });
    expect(extracted.stderr).not.toContain("output kept at");
    rmSync(dirname(outputFile), { recursive: true, force: true });
  });

  test("a background run with a missing binary records not-found; --extract exits 2", () => {
    const r = run(["codex", promptFile, "--background"], {}, emptyBinDir);
    expect(r.code).toBe(0);
    const outputFile = backgroundOutputFile(r.stdout);
    expect(waitForStatus(outputFile)).toBe("not-found");
    const extracted = run(["codex", "--extract", outputFile]);
    expect(extracted.code).toBe(2);
    expect(extracted.stderr).toContain("reviewer binary not found");
    rmSync(dirname(outputFile), { recursive: true, force: true });
  });

  test("--extract with no exit status recorded fails safe, stream complete or not yet created", () => {
    const cases = [
      { id: "full stream, no record", stream: true },
      { id: "nothing created yet", stream: false },
    ];
    for (const { id, stream } of cases) {
      const earlyDir = temp.dir("run-review-early-");
      const outputFile = join(earlyDir, "review.jsonl");
      if (stream) {
        writeFileSync(
          outputFile,
          '{"type":"item.completed","item":{"type":"agent_message","text":"looks complete"}}\n{"type":"turn.completed"}\n',
        );
      }
      const extracted = run(["codex", "--extract", outputFile]);
      expectFailure(extracted, { code: 1, stderr: "no exit status recorded" }, id);
    }
  });

  test("--extract with a different reviewer than the launch is refused: exit 2", () => {
    const r = run(["codex", promptFile, "--background"]);
    const outputFile = backgroundOutputFile(r.stdout);
    expect(waitForStatus(outputFile)).toBe("0");
    const extracted = run(["claude", "--extract", outputFile]);
    expect(extracted.code).toBe(2);
    expect(extracted.stderr).toContain("launched with reviewer 'codex'");
    rmSync(dirname(outputFile), { recursive: true, force: true });
  });

  test("--extract pointed at a different file in the capture dir is refused: exit 2", () => {
    const r = run(["codex", promptFile, "--background"]);
    const outputFile = backgroundOutputFile(r.stdout);
    expect(waitForStatus(outputFile)).toBe("0");
    // prompt.txt sits beside review.status; it must not pass as the stream.
    const extracted = run(["codex", "--extract", join(dirname(outputFile), "prompt.txt")]);
    expect(extracted.code).toBe(2);
    expect(extracted.stderr).toContain("output file is 'review.jsonl'");
    rmSync(dirname(outputFile), { recursive: true, force: true });
  });

  test("--extract on a launch-time record without a status yet exits 1", () => {
    const pendingDir = temp.dir("run-review-launched-");
    const outputFile = join(pendingDir, "review.jsonl");
    writeFileSync(
      outputFile,
      '{"type":"item.completed","item":{"type":"agent_message","text":"looks complete"}}\n{"type":"turn.completed"}\n',
    );
    writeFileSync(join(pendingDir, "review.status"), '{"tool":"codex","output":"review.jsonl"}');
    const extracted = run(["codex", "--extract", outputFile]);
    expect(extracted.code).toBe(1);
    expect(extracted.stderr).toContain("no exit status recorded");
  });

  test("--extract on a corrupt or non-string-status record is a usage error: exit 2", () => {
    const corruptDir = temp.dir("run-review-corrupt-");
    const outputFile = join(corruptDir, "review.jsonl");
    writeFileSync(
      outputFile,
      '{"type":"item.completed","item":{"type":"agent_message","text":"looks complete"}}\n{"type":"turn.completed"}\n',
    );
    const statusFile = join(corruptDir, "review.status");
    writeFileSync(statusFile, "not json");
    const corrupt = run(["codex", "--extract", outputFile]);
    expectFailure(corrupt, { code: 2, stderr: "not a run-review capture" });
    writeFileSync(statusFile, '{"tool":"codex","output":"review.jsonl","status":0}');
    const extracted = run(["codex", "--extract", outputFile]);
    expectFailure(extracted, { code: 2, stderr: "non-string status" });
  });
});

describe("writeAllSync", () => {
  test("a short-writing fd still receives every byte, exactly once, in order", () => {
    // writeSync may legally write fewer bytes than asked; dropping the
    // remainder tears the captured stream, and a torn error line then parses
    // as a clean review. The stub write caps each call at 3 bytes to force
    // the loop through many short writes.
    const chunk = Buffer.from('{"type":"error","message":"stream disconnected"}\n');
    const landed: Buffer[] = [];
    writeAllSync(7, chunk, (_fd, buf, offset, length) => {
      const n = Math.min(3, length);
      landed.push(Buffer.from(buf.subarray(offset, offset + n)));
      return n;
    });
    expect(Buffer.concat(landed).toString()).toBe(chunk.toString());
  });

  test("with the real writeSync, a file receives the chunk byte-identically", () => {
    const dir = temp.dir("write-all-");
    const file = join(dir, "out");
    const fd = openSync(file, "w");
    const chunk = Buffer.from("review body\n");
    try {
      writeAllSync(fd, chunk);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(file)).toEqual(chunk);
  });
});
