import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "../scripts/lib";
import { writeAllSync } from "../skills/rubber-duck-review/scripts/run-review.mts";

// Contract tests for the run-review helper: stub reviewer binaries on PATH
// drive every exit path, pinning the traps the script encapsulates - the
// prompt travels as one argv element (backticks and $() stay literal), stdin
// is closed so a reviewer that reads it cannot hang, the verdict is the LAST
// codex agent_message / the final claude result, and an empty, cut, blank,
// or errored stream exits 1 (never a clean pass). gh-style violations files
// catch any drift in the exact reviewer invocations.

const SCRIPT = join(ROOT, "skills", "rubber-duck-review", "scripts", "run-review.mts");

// Prompt content that a shell would mangle: proves no shell ever sees it.
const PROMPT = "Review only.\nRun `git --no-pager diff HEAD` and note $(hostname) stays literal.\n";

const BIG_VERDICT_BYTES = 262144;

const FAKE_CODEX = `#!/usr/bin/env bash
violate() { echo "$*" >> "\${STUB_VIOLATIONS}"; }
if [ "$1 $2 $3 $4" != "exec --json --sandbox read-only" ] || [ "$#" -ne 5 ]; then
  violate "codex argv: $*"; exit 64
fi
if [ "$5" = "-" ] && [ "\${STUB_SKIP_STDIN:-0}" != "1" ]; then
  cat > "\${STUB_PROMPT_COPY}"
elif [ "$5" != "-" ]; then
  printf '%s' "$5" > "\${STUB_PROMPT_COPY}"
fi
# With stdin open (a pipe) this blocks forever; stdio 'ignore' gives EOF.
if [ "\${STUB_READ_STDIN:-0}" = "1" ]; then cat > /dev/null; fi
case "\${STUB_MODE:-ok}" in
  ok)
    echo '{"type":"thread.started","thread_id":"t1"}'
    echo '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}'
    echo '{"type":"item.completed","item":{"type":"agent_message","text":"intermediate narration"}}'
    echo 'mid-stream garbage that is not JSON'
    echo '{"type":"item.completed","item":{"type":"command_execution","command":"git diff"}}'
    echo '{"type":"item.completed","item":{"type":"agent_message","text":"CODEX VERDICT: correct, no blocking findings"}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    ;;
  trunctail)
    echo '{"type":"item.completed","item":{"type":"agent_message","text":"CODEX VERDICT: correct, no blocking findings"}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    printf '{"type":"item.completed","item":{"type":"agent_'
    ;;
  cut)
    echo '{"type":"thread.started","thread_id":"t1"}'
    echo '{"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}'
    ;;
  cutlate)
    echo '{"type":"thread.started","thread_id":"t1"}'
    echo '{"type":"item.completed","item":{"type":"agent_message","text":"narration that looks like a verdict"}}'
    ;;
  cutsecond)
    echo '{"type":"turn.started"}'
    echo '{"type":"item.completed","item":{"type":"agent_message","text":"first-turn verdict"}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    echo '{"type":"turn.started"}'
    ;;
  error)
    echo '{"type":"thread.started","thread_id":"t1"}'
    echo '{"type":"error","message":"stream disconnected before completion"}'
    ;;
  blank)
    echo '{"type":"item.completed","item":{"type":"agent_message","text":""}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    ;;
  big)
    big="$(head -c ${BIG_VERDICT_BYTES} /dev/zero | tr '\\0' 'x')"
    printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "$big"
    echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
    ;;
  empty) ;;
esac
exit "\${STUB_EXIT:-0}"
`;

const FAKE_CLAUDE = `#!/usr/bin/env bash
violate() { echo "$*" >> "\${STUB_VIOLATIONS}"; }
if [ "$1 $2 $3 $4 $5 $6" != "-p --permission-mode plan --verbose --output-format stream-json" ]; then
  violate "claude argv: $*"; exit 64
fi
if [ "$#" -eq 7 ]; then
  printf '%s' "$7" > "\${STUB_PROMPT_COPY}"
elif [ "$#" -eq 6 ]; then
  cat > "\${STUB_PROMPT_COPY}"
else
  violate "claude argv: $*"; exit 64
fi
case "\${STUB_MODE:-ok}" in
  ok)
    echo '{"type":"system","subtype":"init"}'
    echo '{"type":"assistant","message":{"content":[{"type":"text","text":"looking around"}]}}'
    echo '{"type":"result","subtype":"success","is_error":false,"result":"CLAUDE VERDICT: correct, no blocking findings"}'
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
  ok) echo "COPILOT VERDICT: correct";;
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
const promptFile = join(binDir, "prompt.txt");
writeFileSync(promptFile, PROMPT);

afterAll(() => {
  rmSync(binDir, { recursive: true, force: true });
  rmSync(emptyBinDir, { recursive: true, force: true });
});

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
  const stderr = result.stderr.toString();
  // Expected-failure runs keep their scratch dir for inspection; sweep it.
  const kept = /(?:output|stderr) kept at ([^)\n]+)/.exec(stderr)?.[1];
  if (kept) rmSync(dirname(kept), { recursive: true, force: true });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr,
    promptCopy,
  };
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
  test("codex: last agent_message wins and the prompt arrives shell-untouched", () => {
    const r = run(["codex", promptFile]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("CODEX VERDICT: correct, no blocking findings\n");
    expect(r.stdout).not.toContain("intermediate narration");
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(PROMPT);
    const statusLines = r.stderr.split("\n").filter(Boolean);
    expect(statusLines).toEqual(["review stream alive", "reviewer exited (status=0)"]);
  });

  test("claude: verdict is the result string on the final result event", () => {
    const r = run(["claude", promptFile]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("CLAUDE VERDICT: correct, no blocking findings\n");
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(PROMPT);
  });

  test("copilot: prompt immediately after -p, plain stdout is the verdict", () => {
    const r = run(["copilot", promptFile]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("COPILOT VERDICT: correct\n");
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(PROMPT);
  });

  test("copilot whitespace-only output is a failed review, not a verdict", () => {
    const r = run(["copilot", promptFile], { STUB_MODE: "blank" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("review FAILED - relaunch");
  });

  test("a stub that reads stdin completes: stdin is 'ignore', not an open pipe", () => {
    const r = run(["codex", promptFile], { STUB_READ_STDIN: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("CODEX VERDICT");
  });

  test("--stdin-prompt serves the prompt file as stdin for codex and claude", () => {
    for (const [tool, verdict] of [
      ["codex", "CODEX VERDICT: correct, no blocking findings\n"],
      ["claude", "CLAUDE VERDICT: correct, no blocking findings\n"],
    ] as const) {
      const r = run([tool, promptFile, "--stdin-prompt"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe(verdict);
      expect(readFileSync(r.promptCopy, "utf-8")).toBe(PROMPT);
    }
  });

  test("--stdin-prompt with copilot is a usage error: exit 2", () => {
    const r = run(["copilot", promptFile, "--stdin-prompt"]);
    expect(r.code).toBe(2);
  });

  test("--stdin-prompt delivers a prompt larger than any pipe buffer in full", () => {
    const hugePrompt = join(binDir, "huge-prompt.txt");
    const hugeContent = "p".repeat(1 << 20);
    writeFileSync(hugePrompt, hugeContent);
    const r = run(["codex", hugePrompt, "--stdin-prompt"]);
    expect(r.code).toBe(0);
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(hugeContent);
  });

  test("a reviewer that ignores its stdin prompt file cannot hang or crash the run", () => {
    const hugePrompt = join(binDir, "huge-prompt-ignored.txt");
    writeFileSync(hugePrompt, "p".repeat(1 << 20));
    const r = run(["codex", hugePrompt, "--stdin-prompt"], { STUB_SKIP_STDIN: "1" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("CODEX VERDICT");
  });

  test("a large verdict is printed in full, not truncated at exit", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "big" });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${"x".repeat(BIG_VERDICT_BYTES)}\n`);
  });

  test("codex stream cut before a verdict exits 1", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "cut" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("review FAILED - relaunch");
  });

  test("codex agent_message without a following turn.completed is narration, not a verdict", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "cutlate" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("no turn.completed");
  });

  test("a stream cut inside a later turn voids the earlier turn's verdict", () => {
    const r = run(["codex", promptFile], { STUB_MODE: "cutsecond" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("review FAILED - relaunch");
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
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("review FAILED - relaunch");
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
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("review FAILED - relaunch");
  });

  test("a whitespace-only verdict exits 1 for both stream formats", () => {
    for (const tool of ["codex", "claude"]) {
      const r = run([tool, promptFile], { STUB_MODE: "blank" });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("review FAILED - relaunch");
    }
  });

  test("a verdict from a reviewer that exited non-zero still fails", () => {
    const r = run(["codex", promptFile], { STUB_EXIT: "3" });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("review FAILED - relaunch");
  });

  test("missing reviewer binary exits 2, not 1", () => {
    const r = run(["codex", promptFile], {}, emptyBinDir);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("reviewer binary not found");
  });

  test("unknown reviewer or missing prompt file are usage errors: exit 2", () => {
    expect(run(["gemini", promptFile]).code).toBe(2);
    expect(run(["codex"]).code).toBe(2);
    expect(run(["codex", join(binDir, "no-such-prompt.txt")]).code).toBe(2);
  });

  test("--background prints output path and pid; --extract reads the verdict later", () => {
    // A private prompt file, deleted right after launch: the monitor must
    // review its snapshot, not re-read the caller's (now gone) file.
    const bgPrompt = join(binDir, "bg-prompt.txt");
    writeFileSync(bgPrompt, PROMPT);
    const r = run(["codex", bgPrompt, "--background"]);
    rmSync(bgPrompt);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/pid: \d+/);
    const outputFile = backgroundOutputFile(r.stdout);
    expect(waitForStatus(outputFile)).toBe("0");
    expect(readFileSync(r.promptCopy, "utf-8")).toBe(PROMPT);
    const extracted = run(["codex", "--extract", outputFile]);
    expect(extracted.code).toBe(0);
    expect(extracted.stdout).toBe("CODEX VERDICT: correct, no blocking findings\n");
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

  test("--extract before the exit status is recorded fails safe, even on a full stream", () => {
    const earlyDir = mkdtempSync(join(tmpdir(), "run-review-early-"));
    const outputFile = join(earlyDir, "review.jsonl");
    writeFileSync(
      outputFile,
      '{"type":"item.completed","item":{"type":"agent_message","text":"looks complete"}}\n{"type":"turn.completed"}\n',
    );
    const extracted = run(["codex", "--extract", outputFile]);
    expect(extracted.code).toBe(1);
    expect(extracted.stderr).toContain("no exit status recorded");
    rmSync(earlyDir, { recursive: true, force: true });
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
    expect(run(["codex", "--extract", outputFile]).code).toBe(2);
    writeFileSync(statusFile, '{"tool":"codex","output":"review.jsonl","status":0}');
    const extracted = run(["codex", "--extract", outputFile]);
    expect(extracted.code).toBe(2);
    expect(extracted.stderr).toContain("non-string status");
    rmSync(corruptDir, { recursive: true, force: true });
  });

  test("--extract before the monitor even creates the stream exits 1, not 2", () => {
    const pendingDir = mkdtempSync(join(tmpdir(), "run-review-pending-"));
    const extracted = run(["codex", "--extract", join(pendingDir, "review.jsonl")]);
    expect(extracted.code).toBe(1);
    expect(extracted.stderr).toContain("no exit status recorded");
    rmSync(pendingDir, { recursive: true, force: true });
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
