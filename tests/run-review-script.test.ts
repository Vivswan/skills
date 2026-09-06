import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ROOT } from "../scripts/lib";
import { writeAllSync } from "../skills/rubber-duck-review/scripts/run-review.mts";

// Contract tests for the run-review helper: stub reviewer binaries on PATH
// drive every exit path, pinning the traps the script encapsulates - the
// prompt travels as one argv element (backticks and $() stay literal), stdin
// is closed so a reviewer that reads it cannot hang, the verdict is the LAST
// codex agent_message / the final claude result and must be the schema
// object with at least one tool call before it, and an empty, cut, blank,
// prose-only, preamble-only, or errored stream exits 1 (never a clean pass).
// gh-style violations files catch any drift in the exact reviewer invocations.

const SCRIPT = join(ROOT, "skills", "rubber-duck-review", "scripts", "run-review.mts");
const SCHEMA = join(ROOT, "skills", "rubber-duck-review", "scripts", "verdict-schema.json");

// Prompt content that a shell would mangle: proves no shell ever sees it.
const PROMPT = "Review only.\nRun `git --no-pager diff HEAD` and note $(hostname) stays literal.\n";

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
if [ "$1 $2 $3 $4 $5" != "exec --json --sandbox read-only --output-schema" ] || [ "$#" -ne 7 ]; then
  violate "codex argv: $*"; exit 64
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

const binDir = mkdtempSync(join(tmpdir(), "run-review-test-"));
const emptyBinDir = mkdtempSync(join(tmpdir(), "run-review-nobin-"));
for (const [name, body] of [
  ["codex", FAKE_CODEX],
  ["claude", FAKE_CLAUDE],
  ["copilot", FAKE_COPILOT],
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
  rmSync(binDir, { recursive: true, force: true });
  rmSync(emptyBinDir, { recursive: true, force: true });
  for (const dir of mintedDirs) rmSync(dir, { recursive: true, force: true });
});

interface Report {
  verdict: Record<string, unknown>;
  tool_calls: number;
  capture: string;
  trajectory: { event: string; text?: string }[];
}

let scenario = 0;
function run(args: string[], env: Record<string, string> = {}, path?: string) {
  scenario += 1;
  const violations = join(binDir, `violations-${scenario}`);
  const promptCopy = join(binDir, `prompt-copy-${scenario}`);
  // process.execPath is absolute, so the script launches even when PATH is
  // reduced to the stub dir (the missing-binary scenario).
  const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
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
  if (kept) rmSync(dirname(kept), { recursive: true, force: true });
  let report: Report | null = null;
  if (result.exitCode === 0 && stdout.startsWith("{")) {
    report = JSON.parse(stdout) as Report;
    expect(existsSync(report.capture)).toBe(true);
    rmSync(dirname(report.capture), { recursive: true, force: true });
  }
  return {
    code: result.exitCode,
    stdout,
    stderr,
    promptCopy,
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

function backgroundOutputFile(stdout: string): string {
  const line = stdout.split("\n").find((candidate) => candidate.startsWith("output: "));
  if (line === undefined) throw new Error(`no output line in: ${stdout}`);
  return line.slice("output: ".length);
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
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(PROMPT);
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
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(PROMPT);
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
      expect(readFileSync(r.promptCopy, "utf-8"), mode).toBe(PROMPT);
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
      expect(readFileSync(r.promptCopy, "utf-8"), tool).toBe(PROMPT);
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
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(hugeContent);
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

  test("a prompt file that prepare did not mint is refused: exit 2", () => {
    // Negative controls for the collision guard. Each row is a way a shared
    // or predictable prompt could reach a launch without going through prepare.
    const predictable = join(binDir, "prompt.txt");
    writeFileSync(predictable, PROMPT);
    const nested = join(dirname(promptFile), "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "prompt.md"), PROMPT);
    // Right prefix, hand-made: no marker.
    const handMade = mkdtempSync(join(tmpdir(), "rubber-duck-prompt-"));
    mintedDirs.push(handMade);
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
    const scratch = mkdtempSync(join(tmpdir(), "rubber-duck-"));
    mintedDirs.push(scratch);
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

  test("--background prints output path and pid; --extract reads the verdict later", () => {
    // A private prompt file, deleted right after launch: the monitor must
    // review its snapshot, not re-read the caller's (now gone) file.
    const bgPrompt = mintPrompt("bg-prompt");
    const r = run(["codex", bgPrompt, "--background"]);
    rmSync(bgPrompt);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/pid: \d+/);
    const outputFile = backgroundOutputFile(r.stdout);
    expect(waitForStatus(outputFile)).toBe("0");
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(PROMPT);
    const extracted = run(["codex", "--extract", outputFile]);
    expect(extracted.code).toBe(0);
    expect(extracted.report().verdict).toEqual(CODEX_VERDICT);
    expect(extracted.report().capture).toBe(outputFile);
    rmSync(dirname(outputFile), { recursive: true, force: true });
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
      const earlyDir = mkdtempSync(join(tmpdir(), "run-review-early-"));
      const outputFile = join(earlyDir, "review.jsonl");
      if (stream) {
        writeFileSync(
          outputFile,
          '{"type":"item.completed","item":{"type":"agent_message","text":"looks complete"}}\n{"type":"turn.completed"}\n',
        );
      }
      const extracted = run(["codex", "--extract", outputFile]);
      expectFailure(extracted, { code: 1, stderr: "no exit status recorded" }, id);
      rmSync(earlyDir, { recursive: true, force: true });
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
    const pendingDir = mkdtempSync(join(tmpdir(), "run-review-launched-"));
    const outputFile = join(pendingDir, "review.jsonl");
    writeFileSync(
      outputFile,
      '{"type":"item.completed","item":{"type":"agent_message","text":"looks complete"}}\n{"type":"turn.completed"}\n',
    );
    writeFileSync(join(pendingDir, "review.status"), '{"tool":"codex","output":"review.jsonl"}');
    const extracted = run(["codex", "--extract", outputFile]);
    expect(extracted.code).toBe(1);
    expect(extracted.stderr).toContain("no exit status recorded");
    rmSync(pendingDir, { recursive: true, force: true });
  });

  test("--extract on a corrupt or non-string-status record is a usage error: exit 2", () => {
    const corruptDir = mkdtempSync(join(tmpdir(), "run-review-corrupt-"));
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
    rmSync(corruptDir, { recursive: true, force: true });
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
    const dir = mkdtempSync(join(tmpdir(), "write-all-"));
    try {
      const file = join(dir, "out");
      const fd = openSync(file, "w");
      const chunk = Buffer.from("review body\n");
      try {
        writeAllSync(fd, chunk);
      } finally {
        closeSync(fd);
      }
      expect(readFileSync(file)).toEqual(chunk);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
