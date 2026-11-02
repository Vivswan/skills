// Contract tests for the run-review helper: stub reviewer binaries on PATH
// drive every exit path, pinning the traps the script encapsulates - the
// prompt travels as one argv element (backticks and $() stay literal), stdin
// is closed so a CLI reviewer that reads it cannot hang, codex runs as an ACP
// session (the fake agent in tests/helpers/acp-agent-stub.ts, behind a
// codex-acp wrapper) in its read-only mode where a refused edit ends the turn,
// the verdict is the text after codex's last tool call / the final claude
// result and must be the schema object with at least one tool call before it,
// and an empty, cut, blank, prose-only, preamble-only, or errored capture
// exits 1 (never a clean pass), and --extract --wait blocks on the launch
// record until the monitor records the exit instead of leaving the caller to
// poll by hand. gh-style violations files catch any drift in the exact
// reviewer invocations.

import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
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
import { permissionFacts } from "../../../skills/rubber-duck-review/scripts/acp.mts";
import { git } from "../../helpers/scratch-repo";
import { tempDirs } from "../../helpers/temp-dirs";

const temp = tempDirs();

const SCRIPT = join(ROOT, "skills", "rubber-duck-review", "scripts", "run-review.mts");
const SCHEMA = join(ROOT, "skills", "rubber-duck-review", "scripts", "verdict-schema.json");
const PROMPT = "Review only.\nRun `git --no-pager diff HEAD` and note $(hostname) stays literal.\n";
const SKILLS_ROOT = join(ROOT, "skills");

/** The skills under `root` whose page carries the `## Review Criteria` heading, in directory
 * order, each with its page's real path, read from the files and never from a pasted copy. */
function declaringSkills(root: string): { name: string; page: string }[] {
  const found: { name: string; page: string }[] = [];
  for (const name of readdirSync(root).sort()) {
    const page = join(root, name, "SKILL.md");
    if (!existsSync(page)) continue;
    if (/^## Review Criteria[^\S\n]*$/m.test(readFileSync(page, "utf-8"))) {
      found.push({ name, page: realpathSync(page) });
    }
  }
  return found;
}

/** The block the reviewer must receive after the caller's prompt: the pages to read, one line each. */
function companionBlock(skills: { name: string; page: string }[]): string {
  if (skills.length === 0) return "";
  const pages = skills.map(({ name, page }) => `- ${name}: ${page}`);
  return `## Companion review criteria\nRead the \`## Review Criteria\` section of each page below and apply it as part of this review:\n${pages.join("\n")}\n`;
}

/** The prompt as the reviewer must receive it: the caller's text, then the companion section. */
function withCompanion(prompt: string, skills = declaringSkills(SKILLS_ROOT)): string {
  if (skills.length === 0) return prompt;
  return `${prompt.trimEnd()}\n\n${companionBlock(skills)}`;
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

/** One line of the capture acp.mts writes for a session update. */
function acpUpdate(update: Record<string, unknown>): string {
  return JSON.stringify({ event: "update", update });
}

const ACP_TOOL_LINE = acpUpdate({
  sessionUpdate: "tool_call",
  toolCallId: "call-1",
  title: "cat src/a.ts",
  kind: "read",
  status: "in_progress",
});
const ACP_VERDICT_LINE = acpUpdate({
  sessionUpdate: "agent_message_chunk",
  content: { type: "text", text: JSON.stringify(CODEX_VERDICT) },
});
const ACP_STOP_LINE = JSON.stringify({ event: "stop", stopReason: "end_turn" });
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
# codex itself is on PATH for the sandbox probe alone: STUB_SANDBOX=bwrap plays a container whose AppArmor
# profile denies bubblewrap's mount propagation. Any other invocation is a violation.
violate() { echo "$*" >> "\${STUB_VIOLATIONS}"; }
if [ "$1 $2 $3" = "sandbox -- true" ] && [ "$#" -eq 3 ]; then
  if [ "\${STUB_SANDBOX:-ok}" = "bwrap" ]; then
    echo 'bwrap: Failed to make / slave: Permission denied' >&2; exit 1
  fi
  exit 0
fi
violate "codex argv: $*"; exit 64
`;

const ACP_STUB = join(ROOT, "tests", "helpers", "acp-agent-stub.ts");
const FAKE_CODEX_ACP = `#!/usr/bin/env bash
# The adapter runs the fake ACP agent from its real path, where the SDK resolves; STUB_SCENARIO names the script.
exec "${process.execPath}" "${ACP_STUB}" "$@"
`;
const CODEX_MODES = {
  currentModeId: "workspace-write",
  availableModes: [
    { id: "read-only", name: "Read-only", description: "" },
    { id: "workspace-write", name: "Workspace access", description: "" },
  ],
};
const VERDICT_TEXT = JSON.stringify(CODEX_VERDICT);
const READ_STEP = {
  type: "tool",
  title: "cat src/a.ts",
  kind: "read",
  permission: true,
  output: "one",
};
const EXEC_STEP = {
  type: "tool",
  title: "git --no-pager diff --cached",
  kind: "execute",
  permission: true,
};
const EDIT_STEP = {
  type: "tool",
  title: "apply_patch",
  kind: "edit",
  permission: true,
  locations: [{ path: "src/a.ts" }],
};
const BARE_EDIT_STEP = { ...EDIT_STEP, askBare: true };
const END = { type: "stop", reason: "end_turn" };
const THINK = { type: "thought", text: "still reading" };

/** One scripted turn under the codex modes, whose current mode is not read-only, so the launch must set it.
 * ACP_SCENARIOS keys these by the STUB_MODE a run names; the stub plays one per session/prompt. */
function acpScenario(turn: unknown[], extra: Record<string, unknown> = {}): unknown {
  return { modes: CODEX_MODES, expectMode: "read-only", turns: [turn], ...extra };
}

const ACP_SCENARIOS: Record<string, unknown> = {
  ok: acpScenario([
    { type: "thought", text: "thinking" },
    { type: "message", text: "intermediate narration" },
    READ_STEP,
    { type: "message", text: VERDICT_TEXT, chunks: 3 },
    END,
  ]),
  // A command: allowed inside the snapshot copy, refused under codex's own sandbox.
  execute: acpScenario([EXEC_STEP, { type: "message", text: VERDICT_TEXT }, END]),
  // A file edit: refused under both; the stub, like codex, ends the turn on a refusal.
  edit: acpScenario([READ_STEP, EDIT_STEP, { type: "message", text: VERDICT_TEXT }, END]),
  // The same edit, its permission request naming the call by id alone: the announcement says what it is.
  bareedit: acpScenario([READ_STEP, BARE_EDIT_STEP, { type: "message", text: VERDICT_TEXT }, END]),
  // codex without a schema puts a sentence before the object, in the same message.
  narrated: acpScenario([
    READ_STEP,
    { type: "message", text: `Done reading; the change holds.${VERDICT_TEXT}` },
    END,
  ]),
  // Narration first, reasoning second: the rows keep that order.
  ordered: acpScenario([
    { type: "message", text: "I will read" },
    { type: "thought", text: "inspect a.ts" },
    READ_STEP,
    { type: "message", text: VERDICT_TEXT },
    END,
  ]),
  preamble: acpScenario([{ type: "message", text: VERDICT_TEXT }, END]),
  prose: acpScenario([
    READ_STEP,
    { type: "message", text: "CODEX VERDICT: correct, no blocking findings" },
    END,
  ]),
  badshape: acpScenario([
    READ_STEP,
    { type: "message", text: JSON.stringify({ blocking: [], summary: "no non_blocking key" }) },
    END,
  ]),
  blank: acpScenario([READ_STEP, { type: "message", text: "" }, END]),
  big: acpScenario([
    READ_STEP,
    {
      type: "message",
      text: JSON.stringify({ ...CODEX_VERDICT, summary: "x".repeat(BIG_VERDICT_BYTES) }),
      chunks: 64,
    },
    END,
  ]),
  cut: acpScenario([
    { type: "thought", text: "thinking" },
    { type: "exit", code: 0 },
  ]),
  maxtokens: acpScenario([
    READ_STEP,
    { type: "message", text: "half a" },
    { type: "stop", reason: "max_tokens" },
  ]),
  nomodes: { modes: null, turns: [[]] },
  stall: acpScenario([READ_STEP, { type: "sleep", ms: 300000 }]),
  trickle: acpScenario([
    ...Array.from({ length: 6 }, () => [THINK, { type: "sleep", ms: 300 }]).flat(),
    READ_STEP,
    { type: "message", text: VERDICT_TEXT },
    END,
  ]),
  slow: acpScenario([
    { type: "sleep", ms: 1000 },
    READ_STEP,
    { type: "message", text: VERDICT_TEXT },
    END,
  ]),
};

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
  # STUB_SKIP_STDIN plays a reviewer that never reads its stdin prompt: the file is EOF-ended, so nothing blocks.
  if [ "\${STUB_SKIP_STDIN:-0}" != "1" ]; then cat > "\${STUB_PROMPT_COPY}"; fi
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

const REAL_GIT = Bun.which("git");
if (REAL_GIT === null) throw new Error("git is not installed");
const FAKE_GIT = `#!/usr/bin/env bash
# The snapshot runs git through PATH, so this stub can fail the subcommand STUB_GIT_FAIL names
# midway; every other call goes to the machine's git.
for arg in "$@"; do
  if [ -n "\${STUB_GIT_FAIL:-}" ] && [ "$arg" = "\${STUB_GIT_FAIL}" ]; then echo "fatal: disk full" >&2; exit 128; fi
done
exec "${REAL_GIT}" "$@"
`;

const binDir = temp.dir("run-review-test-");
const emptyBinDir = temp.dir("run-review-nobin-");
// A reviewer-less PATH still holds bun: the launcher runs its bundle through the bun on PATH.
symlinkSync(process.execPath, join(emptyBinDir, "bun"));

/** The test process's environment without another suite's STUB_* leftovers: a stale STUB_ARGS_LOG into a removed
 * scratch directory kills the adapter stub at startup, and every ACP session then reads as a closed connection. */
function inheritedEnv(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("STUB_")),
  );
}

for (const [name, body] of [
  ["codex", FAKE_CODEX],
  ["codex-acp", FAKE_CODEX_ACP],
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
  // A codex launch plays the scenario STUB_MODE names (ok by default) through the adapter stub.
  const scenarioFile = join(binDir, `scenario-${scenario}.json`);
  const played = ACP_SCENARIOS[env.STUB_MODE ?? "ok"];
  if (args[0] === "codex" && played !== undefined) {
    writeFileSync(scenarioFile, JSON.stringify(played));
  }
  // process.execPath is absolute, so the script launches even when PATH is
  // reduced to the stub dir (the missing-binary scenario).
  const result = Bun.spawnSync([process.execPath, script, ...args], {
    cwd,
    env: {
      ...inheritedEnv(),
      PATH: path ?? `${binDir}:${process.env.PATH}`,
      STUB_VIOLATIONS: violations,
      STUB_PROMPT_COPY: promptCopy,
      STUB_SCENARIO: scenarioFile,
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
    rmSync(dirname(report.capture), { recursive: true, force: true });
  }
  return {
    code: result.exitCode,
    stdout,
    stderr,
    promptCopy,
    copyLeft,
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

/** The pid the stalled adapter stub wrote: the wrapper exec'd into it, so the group is one process. */
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

const COMPLETE_CODEX_STREAM = `${ACP_TOOL_LINE}\n${ACP_VERDICT_LINE}\n${ACP_STOP_LINE}\n`;
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
    env: { ...inheritedEnv(), PATH: `${binDir}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe("run-review.mts", () => {
  test("codex: the text after the last tool call is the verdict; the report carries verdict, tool calls, capture, trajectory", () => {
    const r = run(["codex", promptFile]);
    expect(r.code).toBe(0);
    const report = r.report();
    expect(report.verdict).toEqual(CODEX_VERDICT);
    expect(report.tool_calls).toBe(1);
    expect(basename(report.capture)).toBe("review.jsonl");
    // The narration and the reasoning are trajectory steps, never the verdict; the permission the
    // read asked for is a step with the answer; long steps are excerpted, the full text stays in
    // the capture.
    expect(report.trajectory.slice(0, 4)).toEqual([
      { event: "reasoning", text: "thinking" },
      { event: "agent_message", text: "intermediate narration" },
      { event: "tool_call", text: "cat src/a.ts" },
      { event: "permission", text: "allow read: cat src/a.ts" },
    ]);
    expect(report.trajectory[4]?.event).toBe("agent_message");
    expect(report.trajectory[4]?.text).toMatch(/^\{"blocking":\[\].*\.\.\.$/);
    expect(report.trajectory[5]).toEqual({ event: "stop", text: "end_turn" });
    expect(report.trajectory).toHaveLength(6);
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

  test("--stdin-prompt serves the prompt file as claude's stdin; codex takes the prompt in the ACP request, so for it the flag is a usage error", () => {
    const r = run(["claude", promptFile, "--stdin-prompt"]);
    expect(r.code).toBe(0);
    expect(r.report().verdict).toEqual(CLAUDE_VERDICT);
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(FULL_PROMPT);
    expectFailure(run(["codex", promptFile, "--stdin-prompt"]), {
      code: 2,
      stderr: "codex takes the prompt in the ACP request; drop --stdin-prompt",
    });
  });

  test("--stdin-prompt with copilot is a usage error: exit 2", () => {
    const r = run(["copilot", promptFile, "--stdin-prompt"]);
    expectFailure(r, { code: 2, stderr: "copilot does not support --stdin-prompt" });
  });

  test("--stdin-prompt delivers a prompt larger than any pipe buffer in full", () => {
    const hugePrompt = mintPrompt("huge-prompt", "");
    const hugeContent = "p".repeat(1 << 20);
    writeFileSync(hugePrompt, hugeContent);
    const r = run(["claude", hugePrompt, "--stdin-prompt"]);
    expect(r.code).toBe(0);
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(withCompanion(hugeContent));
  });

  test("a reviewer that ignores its stdin prompt file cannot hang or crash the run", () => {
    const hugePrompt = mintPrompt("huge-prompt-ignored", "p".repeat(1 << 20));
    const r = run(["claude", hugePrompt, "--stdin-prompt"], { STUB_SKIP_STDIN: "1" });
    expect(r.code).toBe(0);
    expect(r.report().verdict).toEqual(CLAUDE_VERDICT);
  });

  test("a large verdict is printed in full, not truncated at exit", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "big" });
    expect(r.code).toBe(0);
    expect(r.report().verdict.summary).toBe("x".repeat(BIG_VERDICT_BYTES));
  });

  test("an adapter that dies mid-turn fails the review as a broken session, never a verdict", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "cut" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(
      /review FAILED - relaunch \(error event: (the ACP session failed|the adapter exited \(0\) before the turn ended)/,
    );
  });

  test("a sentence before the object in the final message leaves the object as the verdict; the rows keep narration and reasoning in stream order", () => {
    const narrated = run(["codex", promptFile], { STUB_MODE: "narrated" });
    expect(narrated.code).toBe(0);
    expect(narrated.report().verdict).toEqual(CODEX_VERDICT);
    expect(narrated.report().trajectory.at(-2)?.text).toMatch(
      /^Done reading; the change holds\.\{/,
    );
    const ordered = run(["codex", promptFile], { STUB_MODE: "ordered" });
    expect(ordered.code).toBe(0);
    expect(ordered.report().trajectory.slice(0, 3)).toEqual([
      { event: "agent_message", text: "I will read" },
      { event: "reasoning", text: "inspect a.ts" },
      { event: "tool_call", text: "cat src/a.ts" },
    ]);
  });

  test("a permission request that names the call by id alone is read against the call's announcement; one no message classified is 'other', which no policy allows", () => {
    const announced = new Map([
      ["edit-1", { kind: "edit", title: "apply_patch", locations: ["src/a.ts"] }],
    ]);
    expect(permissionFacts({ toolCallId: "edit-1" }, announced)).toEqual({
      kind: "edit",
      title: "apply_patch",
      locations: ["src/a.ts"],
    });
    expect(
      permissionFacts({ toolCallId: "edit-1", kind: "read", locations: [] }, announced),
    ).toEqual({
      kind: "read",
      title: "apply_patch",
      locations: [],
    });
    expect(permissionFacts({ toolCallId: "never-announced" }, announced)).toEqual({
      kind: "other",
      title: "",
      locations: [],
    });
  });

  test("a file edit codex asks for is refused, codex ends the turn, and the review fails naming the refusal; a request naming the call by id alone is read against the call's announcement, inside the copy too", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "edit" });
    expectFailure(r, {
      code: 1,
      stderr:
        "review FAILED - relaunch (error event: the reviewer asked to edit (apply_patch); a review is read-only",
    });
    const repo = fixtureRepo();
    const bare = run(
      ["codex", promptFile],
      { STUB_MODE: "bareedit", STUB_SANDBOX: "bwrap" },
      undefined,
      repo,
    );
    expectFailure(bare, {
      code: 1,
      stderr:
        "review FAILED - relaunch (error event: the reviewer asked to edit (apply_patch); a review is read-only",
    });
  });

  test("a turn that ends for any reason but end_turn is no verdict: max_tokens", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "maxtokens" });
    expectFailure(r, {
      code: 1,
      stderr: "review FAILED - relaunch (error event: turn ended max_tokens",
    });
  });

  test("an adapter that offers no read-only mode fails before any prompt is sent", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "nomodes" });
    expectFailure(r, {
      code: 1,
      stderr:
        "review FAILED - relaunch (error event: the adapter offers no read-only mode (no modes)",
    });
    expect(readFileSync(r.promptCopy, { encoding: "utf-8", flag: "a+" })).toBe("");
  });

  test("a command codex asks to run is refused under its own sandbox, where asking means escaping it, and allowed inside the snapshot copy", () => {
    const refused = run(["codex", promptFile], { STUB_MODE: "execute" });
    expectFailure(refused, {
      code: 1,
      stderr: "the reviewer asked to execute (git --no-pager diff --cached); a review is read-only",
    });
    const repo = fixtureRepo();
    const permissions = join(binDir, "permissions-execute");
    const allowed = run(
      ["codex", promptFile],
      { STUB_MODE: "execute", STUB_SANDBOX: "bwrap", STUB_PERMISSIONS: permissions },
      undefined,
      repo,
    );
    expect(allowed.code).toBe(0);
    expect(allowed.report().verdict).toEqual(CODEX_VERDICT);
    expect(JSON.parse(readFileSync(permissions, "utf-8"))).toMatchObject({
      kind: "execute",
      chosen: "allow_once",
    });
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

  test("a whitespace-only verdict exits 1 for both stream formats", () => {
    for (const tool of ["codex", "claude"]) {
      const r = run([tool, promptFile], { STUB_MODE: "blank" });
      expectFailure(r, { code: 1, stderr: "review FAILED - relaunch (empty verdict" }, tool);
    }
  });

  test("a verdict from a CLI reviewer that exited non-zero still fails", () => {
    const r = run(["claude", promptFile], { STUB_EXIT: "3" });
    expectFailure(r, {
      code: 1,
      stderr: "review FAILED - relaunch (reviewer status: 3 (stderr kept at",
    });
  });

  test("a missing reviewer binary exits 2, not 1, and for codex the binary is the adapter", () => {
    const r = run(["codex", promptFile], {}, emptyBinDir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("reviewer binary not found: codex-acp");
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
    const [
      cwd,
      top,
      branch,
      status,
      head,
      commits,
      aText,
      lfsSmudge,
      branchDiff,
      origHead,
      codexHome,
    ] = readFileSync(file, "utf-8").split("\n");
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
      codexHome,
    };
  }

  const BWRAP_LINE =
    "codex sandbox unavailable (bwrap: Failed to make / slave: Permission denied): reviewing a snapshot copy at ";

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
  }, 30000);

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
  }, 30000);

  test("a relative CODEX_HOME names the launcher's directory, not the copy's: the adapter sees it absolute", () => {
    const repo = fixtureRepo();
    const reportFile = join(binDir, "cwd-report-codex-home");
    const r = run(
      ["codex", promptFile],
      { STUB_SANDBOX: "bwrap", STUB_CWD_REPORT: reportFile, CODEX_HOME: ".codex-home" },
      undefined,
      repo,
    );
    expect(r.code).toBe(0);
    expect(cwdReport(reportFile).codexHome).toBe(join(repo, ".codex-home"));
  });

  test("a relative CODEX_HOME through a symlink and .. resolves as codex does, by the filesystem, not by the text", () => {
    const repo = fixtureRepo();
    const home = temp.dir("run-review-codex-home-");
    mkdirSync(join(home, "child"));
    symlinkSync(join(home, "child"), join(repo, "link"));
    const reportFile = join(binDir, "cwd-report-codex-home-link");
    const r = run(
      ["codex", promptFile],
      { STUB_SANDBOX: "bwrap", STUB_CWD_REPORT: reportFile, CODEX_HOME: "link/.." },
      undefined,
      repo,
    );
    expect(r.code).toBe(0);
    expect(cwdReport(reportFile).codexHome).toBe(realpathSync(home));
  });

  test("an empty CODEX_HOME stays empty: codex reads it as unset", () => {
    const repo = fixtureRepo();
    const reportFile = join(binDir, "cwd-report-codex-home-empty");
    const r = run(
      ["codex", promptFile],
      { STUB_SANDBOX: "bwrap", STUB_CWD_REPORT: reportFile, CODEX_HOME: "" },
      undefined,
      repo,
    );
    expect(r.code).toBe(0);
    expect(cwdReport(reportFile).codexHome).toBe("");
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

  test("the launcher names this collection's declaring skills' pages in the prompt, so a prompt cannot omit their criteria", () => {
    const declaring = declaringSkills(SKILLS_ROOT);
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
      companionBlock(declaringSkills(SKILLS_ROOT).filter((s) => s.name === "code-standards")),
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

  test("--criteria <name> names that skill's page alone, for the lens choice on someone else's PR", () => {
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

  /** A scratch install: this skill copied whole under <base>/skills (the script finds its root
   * through its own real path), beside the siblings the case needs. The run uses the copy's script,
   * so the stub is told the copy's schema path. */
  function scratchInstall(
    base: string,
    rootUnderBase = "skills",
    extraEnv: Record<string, string> = {},
  ): {
    launch: (...args: string[]) => ReturnType<typeof run>;
    print: (...args: string[]) => ReturnType<typeof run>;
    page: (name: string) => string;
  } {
    const root = join(base, rootUnderBase);
    mkdirSync(root, { recursive: true });
    cpSync(join(SKILLS_ROOT, "rubber-duck-review"), join(root, "rubber-duck-review"), {
      recursive: true,
    });
    const sibling = (name: string, page: string) => {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, "SKILL.md"), page);
    };
    // A heading with trailing spaces is still the heading, and a fence opener quoted in the
    // frontmatter's description hides nothing in the body.
    sibling(
      "alpha",
      "---\nname: alpha\ndescription: |\n  Use when a page shows:\n  ```markdown\n---\n# Alpha\n\n## Review Criteria  \n\n- an alpha rule\n\n## After\n\nnot criteria\n",
    );
    // A context-specific heading is not the heading.
    sibling("beta", "# Beta\n\n## Landing Review Criteria\n\n- a beta rule\n");
    // A page saved with CRLF endings still declares the heading.
    sibling("gamma", "# Gamma\r\n\r\n## Review Criteria\r\n\r\n- a gamma rule\r\n");
    // User-invoke-only, the marker in a YAML form a line regex would miss: named or nothing.
    sibling(
      "delta",
      "---\nname: delta\ndescription: Use when asked by name.\ndisable-model-invocation : true # explicit only\n---\n\n# Delta\n\n## Review Criteria\n\n- a delta rule\n",
    );
    // Declares the heading but was installed from another collection.
    sibling("epsilon", "# Epsilon\n\n## Review Criteria\n\n- a foreign rule\n");
    // The heading only inside a code fence is a sample, not a declaration.
    sibling("zeta", "# Zeta\n\n```md\n## Review Criteria\n```\n");
    // So is the heading only inside a quoted example.
    sibling("eta", "# Eta\n\n> ## Review Criteria\n>\n> - a quoted rule\n");
    // The heading only inside the frontmatter's description is not in the body at all.
    sibling(
      "theta",
      "---\nname: theta\ndescription: |\n  Use when checking pages containing:\n  ## Review Criteria\n---\n# Sample\n",
    );
    const scripts = join(root, "rubber-duck-review", "scripts");
    const script = join(scripts, "run-review.mts");
    const env = { STUB_SCHEMA: realpathSync(join(scripts, "verdict-schema.json")), ...extraEnv };
    return {
      launch: (...args) => run(["codex", promptFile, ...args], env, undefined, undefined, script),
      print: (...args) => run(["criteria", ...args], extraEnv, undefined, undefined, script),
      page: (name) => realpathSync(join(root, name, "SKILL.md")),
    };
  }

  /** The installer's record: every name under one source, spelled as the installer may spell it. */
  function lockfile(entries: Record<string, string>, sourceType = "github", version = 3): string {
    const skills = Object.fromEntries(
      Object.entries(entries).map(([name, source]) => [name, { source, sourceType }]),
    );
    return JSON.stringify({ version, skills });
  }

  /** The one global record, where the skills CLI keeps it under $XDG_STATE_HOME. */
  function globalRecord(base: string, content: string): Record<string, string> {
    const state = join(base, "state");
    mkdirSync(join(state, "skills"), { recursive: true });
    writeFileSync(join(state, "skills", ".skill-lock.json"), content);
    return { XDG_STATE_HOME: state };
  }

  test("by default the launcher names this collection's declaring pages alone: the installer's record decides the collection, a foreign or user-only skill rides in only when named, and a record left beside the root is not the record", () => {
    const base = temp.dir("run-review-install-");
    const env = globalRecord(
      base,
      lockfile({
        "rubber-duck-review": "example/skills",
        alpha: "Example/Skills",
        gamma: "example/skills/",
        delta: "example/skills.git",
        epsilon: "other/collection",
        eta: "example/skills",
        theta: "example/skills",
      }),
    );
    // An older record beside the root, from before XDG_STATE_HOME was set: the CLI reads only the XDG one.
    writeFileSync(
      join(base, ".skill-lock.json"),
      lockfile({ "rubber-duck-review": "x/y", gamma: "x/y" }),
    );
    const install = scratchInstall(base, "skills", env);
    const r = install.launch();
    expect(r.code).toBe(0);
    expect(r.report().criteria).toEqual(["alpha", "gamma"]);
    const block = companionBlock([
      { name: "alpha", page: install.page("alpha") },
      { name: "gamma", page: install.page("gamma") },
    ]);
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(`${PROMPT.trimEnd()}\n\n${block}`);
    expect(install.print().stdout).toBe(block);

    for (const name of ["delta", "epsilon"]) {
      const named = install.launch("--criteria", name);
      expect(named.code).toBe(0);
      expect(named.report().criteria).toEqual([name]);
      const one = companionBlock([{ name, page: install.page(name) }]);
      expect(readFileSync(named.promptCopy, "utf-8")).toBe(`${PROMPT.trimEnd()}\n\n${one}`);
      expect(install.print("--criteria", name).stdout).toBe(one);
    }

    // eta is in the collection, and its only heading sits in a quoted example: it declares nothing.
    expectFailure(install.launch("--criteria", "eta"), {
      code: 2,
      stderr:
        "--criteria: eta declares no ## Review Criteria; the installed skills that do: alpha, delta, epsilon, gamma",
    });
  }, 60000);

  test("a checkout of the repository is its plugin manifest listing this skill, and the collection is what the manifest lists; another plugin's manifest beside the root is not a checkout, and a root with no record names nothing, out loud", () => {
    const checkout = temp.dir("run-review-checkout-");
    mkdirSync(join(checkout, ".claude-plugin"));
    const manifest = (skills: string[]) =>
      writeFileSync(join(checkout, ".claude-plugin", "plugin.json"), JSON.stringify({ skills }));
    manifest([
      "./skills/rubber-duck-review",
      "./skills/alpha",
      "./skills/gamma",
      "./skills/delta",
      "./skills/eta",
      "./skills/theta",
    ]);
    const inCheckout = scratchInstall(checkout).launch();
    expect(inCheckout.code).toBe(0);
    expect(inCheckout.report().criteria).toEqual(["alpha", "gamma"]);

    const strayBase = realpathSync(temp.dir("run-review-stray-"));
    mkdirSync(join(strayBase, ".claude-plugin"));
    writeFileSync(
      join(strayBase, ".claude-plugin", "plugin.json"),
      JSON.stringify({ skills: ["./skills/other"] }),
    );
    const stray = scratchInstall(strayBase, "skills", {
      XDG_STATE_HOME: join(strayBase, "state"),
    }).launch();
    expect(stray.code).toBe(0);
    expect(stray.report().criteria).toEqual([]);
    expect(readFileSync(stray.promptCopy, "utf-8")).toBe(PROMPT);
    // Beside the launch's own progress lines: the notice names where it looked.
    expect(stray.stderr).toContain(
      `no companion criteria: no skills-lock.json from ${strayBase} upward names rubber-duck-review, nor ${join(strayBase, "state", "skills", ".skill-lock.json")}\n`,
    );
  }, 60000);

  test("a project install is recorded at the project's top as skills-lock.json, whatever depth the agent's directory sits at, local sources relative to it and a .git suffix kept; a copy under an agent's own directory is in the global record", () => {
    // Two project layouts the skills CLI writes: <project>/.posit/assistant/skills and <project>/skills,
    // both recorded in <project>/skills-lock.json (getLocalLockPath), local sources relative to the project.
    for (const under of [join(".posit", "assistant", "skills"), "skills"]) {
      const project = temp.dir("run-review-project-");
      const inProject = scratchInstall(project, under, { XDG_STATE_HOME: join(project, "state") });
      // The collection's directory, and a link to it: two spellings of one place.
      mkdirSync(join(project, "vendor", "collection"), { recursive: true });
      symlinkSync(join(project, "vendor", "collection"), join(project, "link"));
      writeFileSync(
        join(project, "skills-lock.json"),
        lockfile(
          {
            "rubber-duck-review": "./vendor/collection",
            alpha: "vendor/collection/",
            gamma: "./link",
            epsilon: "./vendor/collection.git",
          },
          "local",
          1,
        ),
      );
      const projectRun = inProject.launch();
      expect(projectRun.code).toBe(0);
      expect(projectRun.report().criteria).toEqual(["alpha", "gamma"]);
    }

    // ~/.claude/skills as a copy, recorded in $XDG_STATE_HOME/skills/.skill-lock.json (getSkillLockPath).
    const home = temp.dir("run-review-home-");
    const env = globalRecord(
      home,
      lockfile({ "rubber-duck-review": "example/skills", gamma: "example/skills" }),
    );
    const asCopy = scratchInstall(home, join(".claude", "skills"), env);
    const copyRun = asCopy.launch();
    expect(copyRun.code).toBe(0);
    expect(copyRun.report().criteria).toEqual(["gamma"]);
    expect(asCopy.print().stdout).toBe(
      companionBlock([{ name: "gamma", page: asCopy.page("gamma") }]),
    );

    // The same copy under the home directory itself (HOME, no XDG), with a global record at ~/.agents
    // and a project record from an install run from the home directory: no record says where it
    // installed to, so every record naming this skill speaks for it, and both collections count.
    const ownHome = realpathSync(temp.dir("run-review-ownhome-"));
    mkdirSync(join(ownHome, ".agents"), { recursive: true });
    writeFileSync(
      join(ownHome, ".agents", ".skill-lock.json"),
      lockfile({ "rubber-duck-review": "example/skills", alpha: "example/skills" }),
    );
    writeFileSync(
      join(ownHome, "skills-lock.json"),
      lockfile({ "rubber-duck-review": "x/y", gamma: "x/y" }),
    );
    const underHome = scratchInstall(ownHome, join(".claude", "skills"), {
      HOME: ownHome,
      XDG_STATE_HOME: "",
    });
    const homeRun = underHome.launch();
    expect(homeRun.code).toBe(0);
    expect(homeRun.report().criteria).toEqual(["alpha", "gamma"]);
  }, 60000);

  test("a page whose frontmatter never closes is a usage error naming the page: read as a body, its metadata would declare criteria and its invocation policy would be lost", () => {
    const base = realpathSync(temp.dir("run-review-openfm-"));
    const env = globalRecord(base, lockfile({ "rubber-duck-review": "example/skills" }));
    const install = scratchInstall(base, "skills", env);
    const kappa = join(base, "skills", "kappa");
    mkdirSync(kappa);
    writeFileSync(
      join(kappa, "SKILL.md"),
      "---\nname: kappa\ndisable-model-invocation: true\ndescription: |\n  ## Review Criteria\n",
    );
    expectFailure(install.launch(), {
      code: 2,
      stderr: `the frontmatter of ${join(kappa, "SKILL.md")} never closes`,
    });
  }, 60000);

  test("a record that does not parse, or has no skills object, is a usage error naming the file, never a guess at the collection", () => {
    const base = realpathSync(temp.dir("run-review-badlock-"));
    const env = globalRecord(base, "{ not json");
    const install = scratchInstall(base, "skills", env);
    const lock = join(base, "state", "skills", ".skill-lock.json");
    expectFailure(install.launch(), { code: 2, stderr: `cannot parse ${lock}:` });
    writeFileSync(lock, JSON.stringify({ version: 3 }));
    expectFailure(install.launch(), {
      code: 2,
      stderr: `${lock}: expected a "skills" object; the lockfile format has changed`,
    });

    // Opting out reads no record: the same broken record stops neither a launch nor the subcommand.
    const optedOut = install.launch("--criteria", "none");
    expect(optedOut.code).toBe(0);
    expect(optedOut.report().criteria).toEqual([]);
    expect(readFileSync(optedOut.promptCopy, "utf-8")).toBe(PROMPT);
    const printedNone = install.print("--criteria", "none");
    expect([printedNone.code, printedNone.stdout, printedNone.stderr]).toEqual([0, "", ""]);
  }, 60000);

  test("a reviewer silent past --stall is killed with its process group and the run fails as a stall", () => {
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
    for (const pid of stubPids(pidFile)) expectGone(pid);
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
    const r = run(["codex", bgPrompt, "--background"], { STUB_MODE: "slow" });
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
      { status: "not-found", code: 2, stderr: "reviewer binary not found: codex-acp\n" },
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

  test("--extract fails a background run whose CLI reviewer exited non-zero", () => {
    const r = run(["claude", promptFile, "--background"], { STUB_EXIT: "3" });
    expect(r.code).toBe(0);
    const outputFile = backgroundOutputFile(r.stdout);
    expect(waitForStatus(outputFile)).toBe("3");
    const extracted = run(["claude", "--extract", outputFile]);
    expect(extracted.code).toBe(1);
    expect(extracted.stderr).toContain("recorded reviewer status: 3");
    // Positive control for the kept-output suffix: the stream is still there.
    expect(extracted.stderr).toContain(`output kept at ${outputFile}`);
  });

  test("a capture whose last line was cut mid-write fails the review even after a stop line", () => {
    const outputFile = pendingCapture();
    writeFileSync(outputFile, `${COMPLETE_CODEX_STREAM}{"event":"update","update":{"sessionUpd`);
    recordStatus(outputFile, "0");
    expectFailure(run(["codex", "--extract", outputFile]), {
      code: 1,
      stderr: "review FAILED - relaunch (malformed trailing line (stream truncated mid-write)",
    });
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
