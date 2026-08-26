#!/usr/bin/env bun
/**
 * Launch a read-only cross-model reviewer and print its final verdict.
 *
 * Usage:
 *   run-review.mts <codex|claude|copilot> <prompt-file> [--background] [--stdin-prompt]
 *   run-review.mts <codex|claude|copilot> --extract <output-file>
 *
 * The reviewer is spawned directly from an argv array (never through a
 * shell), so backticks and $(...) in the prompt stay literal. stdin is
 * 'ignore' because both codex and claude otherwise block forever reading
 * additional input. The full stdout stream is captured to a scratch file
 * under os.tmpdir(), never the working tree, and the prompt is snapshotted
 * into the same scratch dir so every review artifact cleans up together.
 *
 * --stdin-prompt (codex/claude only) serves the prompt file itself as the
 * reviewer's stdin, for restricted environments that reject large prompt
 * arguments. A file fd is EOF-terminated, so delivery is complete by
 * construction and cannot hang: the stdin hang trap is an OPEN pipe.
 *
 * --background detaches a monitor copy of this script that runs the reviewer
 * to completion and records the reviewer, output filename, and exit status in
 * review.status beside the stream; --extract validates all three against its
 * own invocation and refuses to report a verdict until the recorded status is
 * a success, so extracting too early, from a failed run, or from the wrong
 * capture fails safe.
 *
 * Exit codes:
 *   0  verdict extracted and printed to stdout, or a --background launch
 *      started (that run's verdict comes later, via --extract)
 *   1  review FAILED - relaunch (empty or cut stream, error events, blank
 *      or unrecorded verdicts, or a non-zero reviewer exit; an empty review
 *      must never read as clean)
 *   2  usage error or reviewer binary not found
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS = ["codex", "claude", "copilot"] as const;
type Tool = (typeof TOOLS)[number];

function isTool(value: string): value is Tool {
  return (TOOLS as readonly string[]).includes(value);
}

const TOOL_ARGS: Record<Tool, (prompt: string) => string[]> = {
  // --sandbox read-only: the reviewer can grep/diff/typecheck but not write.
  codex: (prompt) => ["exec", "--json", "--sandbox", "read-only", prompt],
  // --verbose is REQUIRED with --output-format stream-json; without it claude
  // errors to stderr and stdout stays empty.
  claude: (prompt) => [
    "-p",
    "--permission-mode",
    "plan",
    "--verbose",
    "--output-format",
    "stream-json",
    prompt,
  ],
  // -p consumes the next argument, so the prompt must immediately follow it.
  // -s strips the model/stats decoration so stdout is only the response.
  // --available-tools is a visibility allow-list: view/rg/glob are the read
  // tools; shell, write, MCP, web, and subagent tools are not even available.
  // The deny flags stay as belt-and-braces (deny outranks every allow).
  // copilot does not stream JSON, so its stdout is plain text.
  copilot: (prompt) => [
    "-p",
    prompt,
    "-s",
    "--available-tools=view,rg,glob",
    "--deny-tool=write",
    "--deny-tool=shell",
    "--disable-builtin-mcps",
  ],
};

const USAGE = [
  "usage: run-review.mts <codex|claude|copilot> <prompt-file> [--background] [--stdin-prompt]",
  "       run-review.mts <codex|claude|copilot> --extract <output-file>",
  "       run-review.mts <codex|claude|copilot> <prompt-file> --capture <dir>  (internal)",
].join("\n");

/** Thrown after exit output is queued, so `never`-typed helpers stay honest. */
class SilentExit extends Error {}

function usageError(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exitCode = 2;
  throw new SilentExit();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

type Extraction = { ok: true; verdict: string } | { ok: false; reason: string };

interface Delivery {
  args: string[];
  /** null: prompt travels as argv and stdin is 'ignore'. Otherwise the file
   * served as the reviewer's stdin (EOF-terminated, complete by construction). */
  stdinFile: string | null;
}

function argvDelivery(tool: Tool, prompt: string): Delivery {
  return { args: TOOL_ARGS[tool](prompt), stdinFile: null };
}

/** codex reads "-" from stdin; claude -p reads stdin when no prompt argument
 * is given. copilot has no stdin form: -p requires the prompt argument. */
function stdinDelivery(tool: Tool, promptFile: string): Delivery {
  if (tool === "codex") return { args: TOOL_ARGS.codex("-"), stdinFile: promptFile };
  if (tool === "claude") {
    return { args: TOOL_ARGS.claude("").slice(0, -1), stdinFile: promptFile };
  }
  usageError("copilot does not support --stdin-prompt (-p requires the prompt as an argument)");
}

function extractVerdict(tool: Tool, raw: string): Extraction {
  if (tool === "copilot") {
    const text = raw.trim();
    return text ? { ok: true, verdict: text } : { ok: false, reason: "empty output" };
  }
  let verdict: string | null = null;
  let errorEvent: string | null = null;
  // codex: a verdict only counts once its turn completes; a stream cut right
  // after an agent_message is mid-thought narration, not a verdict. A trailing
  // turn.started with no matching end likewise voids any earlier verdict.
  let awaitingTurnEnd = false;
  let turnOpen = false;
  // Mid-stream malformed lines are skippable noise, but a malformed FINAL
  // line means the stream was truncated mid-write: void the verdict.
  let lastLineMalformed = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
      lastLineMalformed = false;
    } catch {
      lastLineMalformed = true;
      continue;
    }
    if (!isRecord(event)) continue;
    if (event.type === "error" || event.type === "turn.failed") {
      errorEvent = typeof event.message === "string" ? event.message : trimmed;
    }
    // codex narrates with intermediate agent_message items; the last one wins.
    if (
      tool === "codex" &&
      event.type === "item.completed" &&
      isRecord(event.item) &&
      event.item.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      verdict = event.item.text;
      awaitingTurnEnd = true;
    }
    if (tool === "codex" && event.type === "turn.started") turnOpen = true;
    if (tool === "codex" && (event.type === "turn.completed" || event.type === "turn.failed")) {
      awaitingTurnEnd = false;
      turnOpen = false;
    }
    if (tool === "claude" && event.type === "result") {
      // claude reports in-band terminal failures as result records with
      // is_error: true (the CLI can still exit 0); those carry no verdict.
      if (event.is_error === true) {
        const subtype = typeof event.subtype === "string" ? event.subtype : "unknown";
        errorEvent = `claude result has is_error: true (subtype: ${subtype})`;
      } else if (typeof event.result === "string") {
        verdict = event.result;
      }
    }
  }
  if (errorEvent !== null) return { ok: false, reason: `error event: ${errorEvent}` };
  if (lastLineMalformed) {
    return { ok: false, reason: "malformed trailing line (stream truncated mid-write)" };
  }
  if (verdict === null) {
    return {
      ok: false,
      reason: raw.trim() === "" ? "empty output" : "stream ended without a verdict event",
    };
  }
  if (awaitingTurnEnd || turnOpen) {
    return { ok: false, reason: "stream cut mid-turn (no turn.completed after the last events)" };
  }
  if (verdict.trim() === "") return { ok: false, reason: "empty verdict" };
  return { ok: true, verdict };
}

// Exits go through process.exitCode + a natural event-loop drain, never
// process.exit(): an explicit exit can truncate a large pending stream write.
function reportVerdict(extraction: Extraction, keptOutputFile?: string): void {
  if (extraction.ok) {
    process.stdout.write(`${extraction.verdict}\n`);
    process.exitCode = 0;
    return;
  }
  const kept = keptOutputFile ? `; output kept at ${keptOutputFile}` : "";
  process.stderr.write(`review FAILED - relaunch (${extraction.reason}${kept})\n`);
  process.exitCode = 1;
}

interface Scratch {
  dir: string;
  outFile: string;
  errFile: string;
  statusFile: string;
}

function scratchPaths(dir: string, tool: Tool): Scratch {
  return {
    dir,
    outFile: join(dir, tool === "copilot" ? "review.out" : "review.jsonl"),
    errFile: join(dir, "review.err"),
    statusFile: join(dir, "review.status"),
  };
}

/** review.status binds a capture to its reviewer and output file, so
 * --extract cannot be pointed at another reviewer's stream (or a non-stream
 * file) and read it with the wrong rules. Written without `status` at launch;
 * rewritten with it on completion. */
function recordStatus(scratch: Scratch, tool: Tool, status?: string): void {
  // Write-then-rename: a concurrent --extract must never observe a truncated
  // record (writeFileSync truncates before writing).
  const pending = `${scratch.statusFile}.tmp`;
  writeFileSync(
    pending,
    JSON.stringify({
      tool,
      output: basename(scratch.outFile),
      ...(status === undefined ? {} : { status }),
    }),
  );
  renameSync(pending, scratch.statusFile);
}

interface ReviewerHooks {
  onLife?: () => void;
  onSpawnError: (error: Error) => void;
  /** Receives the recorded status: "0" is the only success. */
  onDone: (status: string) => void;
}

function runReviewer(
  tool: Tool,
  delivery: Delivery,
  scratch: Scratch,
  hooks: ReviewerHooks,
): ReturnType<typeof spawn> | null {
  let stdinFd: number | null = null;
  if (delivery.stdinFile !== null) {
    try {
      stdinFd = openSync(delivery.stdinFile, "r");
    } catch (error) {
      usageError(`cannot open prompt file for stdin delivery: ${String(error)}`);
    }
  }
  const outFd = openSync(scratch.outFile, "w");
  const errFd = openSync(scratch.errFile, "w");
  recordStatus(scratch, tool);
  const closeFds = () => {
    closeSync(outFd);
    closeSync(errFd);
    if (stdinFd !== null) closeSync(stdinFd);
  };
  // spawn can also throw synchronously (e.g. a NUL byte in an argv element);
  // that must reach onSpawnError like an async spawn failure, not crash.
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(tool, delivery.args, {
      stdio: [stdinFd ?? "ignore", "pipe", "pipe"],
    });
  } catch (error) {
    closeFds();
    hooks.onSpawnError(error instanceof Error ? error : new Error(String(error)));
    return null;
  }
  let sawLife = false;
  // stdio[1] and stdio[2] are "pipe" in the spawn call above, so both streams
  // exist; the null in their types only covers other stdio configurations.
  child.stdout!.on("data", (chunk: Buffer) => {
    if (!sawLife) {
      sawLife = true;
      hooks.onLife?.();
    }
    writeSync(outFd, chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    writeSync(errFd, chunk);
  });
  // A spawn failure emits 'error' and may still emit 'close'; settle once.
  let settled = false;
  const settle = (handle: () => void) => {
    if (settled) return;
    settled = true;
    closeFds();
    handle();
  };
  child.on("error", (error) => {
    settle(() => hooks.onSpawnError(error));
  });
  child.on("close", (code) => {
    settle(() => {
      const status = String(code ?? "signal");
      recordStatus(scratch, tool, status);
      hooks.onDone(status);
    });
  });
  return child;
}

function runForeground(tool: Tool, delivery: Delivery, scratch: Scratch): void {
  runReviewer(tool, delivery, scratch, {
    onLife: () => process.stderr.write("review stream alive\n"),
    onSpawnError: (error) => {
      // Nothing was captured; a retained empty scratch dir would be noise.
      rmSync(scratch.dir, { recursive: true, force: true });
      if (isEnoent(error)) {
        process.stderr.write(`reviewer binary not found: ${tool}\n`);
        process.exitCode = 2;
        return;
      }
      process.stderr.write(`review FAILED - relaunch (spawn failed: ${String(error)})\n`);
      process.exitCode = 1;
    },
    onDone: (status) => {
      process.stderr.write(`reviewer exited (status=${status})\n`);
      let extraction = extractVerdict(tool, readFileSync(scratch.outFile, "utf-8"));
      if (status !== "0" && extraction.ok) {
        extraction = {
          ok: false,
          reason: `reviewer status: ${status} (stderr kept at ${scratch.errFile})`,
        };
      }
      if (extraction.ok) {
        rmSync(scratch.dir, { recursive: true, force: true });
        reportVerdict(extraction);
        return;
      }
      reportVerdict(extraction, scratch.outFile);
    },
  });
}

/** Detached monitor: capture the stream and record the exit status, silently. */
function runCapture(tool: Tool, delivery: Delivery, scratch: Scratch): void {
  const child = runReviewer(tool, delivery, scratch, {
    onSpawnError: (error) => {
      recordStatus(scratch, tool, isEnoent(error) ? "not-found" : `spawn failed: ${String(error)}`);
    },
    onDone: () => {},
  });
  if (child === null) return;
  // Killing the printed monitor PID must not orphan the reviewer. Signal
  // listeners do not hold the event loop open, so a finished monitor still
  // exits normally.
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(signal, () => {
      child.kill(signal);
    });
  }
}

function runBackground(tool: Tool, prompt: string, stdinPrompt: boolean): void {
  const scratch = scratchPaths(mkdtempSync(join(tmpdir(), "rubber-duck-")), tool);
  // Snapshot the prompt: the caller's file may be edited or deleted before
  // the detached monitor gets around to reading it.
  const promptSnapshot = join(scratch.dir, "prompt.txt");
  writeFileSync(promptSnapshot, prompt);
  const monitorArgs = [
    fileURLToPath(import.meta.url),
    tool,
    promptSnapshot,
    "--capture",
    scratch.dir,
  ];
  if (stdinPrompt) monitorArgs.push("--stdin-prompt");
  const monitor = spawn(process.execPath, monitorArgs, { detached: true, stdio: "ignore" });
  monitor.on("error", (error) => {
    process.stderr.write(`review FAILED - relaunch (failed to detach monitor: ${String(error)})\n`);
    process.exitCode = 1;
  });
  monitor.on("spawn", () => {
    monitor.unref();
    process.stdout.write(`output: ${scratch.outFile}\npid: ${monitor.pid}\n`);
  });
}

function extractRecorded(tool: Tool, outputFile: string): void {
  // Status first: before the monitor records completion (or even creates the
  // stream), extraction must fail as an unfinished review, not a usage error.
  let recordText: string | null = null;
  try {
    recordText = readFileSync(join(dirname(outputFile), "review.status"), "utf-8");
  } catch {
    // no record beside the file: the monitor may not have started yet
  }
  if (recordText === null) {
    reportVerdict(
      { ok: false, reason: "no exit status recorded (reviewer still running?)" },
      outputFile,
    );
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(recordText);
  } catch {
    usageError(`unrecognized review.status beside ${outputFile}: not a run-review capture`);
  }
  if (!isRecord(parsed)) {
    usageError(`unrecognized review.status beside ${outputFile}: not a run-review capture`);
  }
  const { tool: recordedTool, output: recordedOutput, status: recordedStatus } = parsed;
  if (typeof recordedTool !== "string" || typeof recordedOutput !== "string") {
    usageError(`unrecognized review.status beside ${outputFile}: not a run-review capture`);
  }
  if (recordedTool !== tool) {
    usageError(
      `this capture was launched with reviewer '${recordedTool}', not '${tool}'; extract with the same reviewer`,
    );
  }
  if (recordedOutput !== basename(outputFile)) {
    usageError(`this capture's output file is '${recordedOutput}', not '${basename(outputFile)}'`);
  }
  if (!("status" in parsed)) {
    reportVerdict(
      { ok: false, reason: "no exit status recorded (reviewer still running?)" },
      outputFile,
    );
    return;
  }
  if (typeof recordedStatus !== "string") {
    usageError(`unrecognized review.status beside ${outputFile}: non-string status`);
  }
  if (recordedStatus === "not-found") {
    process.stderr.write(`reviewer binary not found: ${tool}\n`);
    process.exitCode = 2;
    return;
  }
  if (recordedStatus !== "0") {
    reportVerdict({ ok: false, reason: `recorded reviewer status: ${recordedStatus}` }, outputFile);
    return;
  }
  let raw: string;
  try {
    raw = readFileSync(outputFile, "utf-8");
  } catch (error) {
    reportVerdict({ ok: false, reason: `cannot read output file: ${String(error)}` });
    return;
  }
  reportVerdict(extractVerdict(tool, raw), outputFile);
}

function main(): void {
  const argv = process.argv.slice(2);
  const toolArg = argv[0];
  if (toolArg === undefined || !isTool(toolArg)) {
    usageError(`unknown reviewer: ${toolArg ?? "(none)"}`);
  }
  const tool = toolArg;
  const rest = argv.slice(1);

  if (rest[0] === "--extract") {
    const outputFile = rest[1];
    if (outputFile === undefined || rest.length !== 2) {
      usageError("--extract takes exactly one <output-file>");
    }
    extractRecorded(tool, outputFile);
    return;
  }

  let background = false;
  let stdinPrompt = false;
  let captureDir: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] as string;
    if (arg === "--background") background = true;
    else if (arg === "--stdin-prompt") stdinPrompt = true;
    else if (arg === "--capture") {
      i += 1;
      captureDir = rest[i] ?? usageError("--capture requires a directory");
    } else if (arg.startsWith("--")) usageError(`unknown flag: ${arg}`);
    else positional.push(arg);
  }
  if (background && captureDir !== null) {
    usageError("--background and --capture are mutually exclusive");
  }
  const promptFile = positional[0];
  if (promptFile === undefined || positional.length !== 1) {
    usageError("expected exactly one <prompt-file>");
  }
  let prompt: string;
  try {
    prompt = readFileSync(promptFile, "utf-8");
  } catch (error) {
    usageError(`cannot read prompt file ${promptFile}: ${String(error)}`);
  }
  if (prompt.trim() === "") usageError(`prompt file is empty: ${promptFile}`);

  // stdinDelivery owns the copilot rejection; validate up front (against the
  // caller's path) so a bad tool/flag combination is a parent-side usage
  // error even for --background, not a silent failure in the monitor.
  if (stdinPrompt) stdinDelivery(tool, promptFile);
  if (background) {
    runBackground(tool, prompt, stdinPrompt);
    return;
  }
  const scratch = scratchPaths(captureDir ?? mkdtempSync(join(tmpdir(), "rubber-duck-")), tool);
  // Snapshot the prompt into the scratch dir (in capture mode this rewrites
  // the snapshot the parent already made): every review artifact, including
  // any code excerpts in the prompt, lives and dies with the capture. The
  // caller's own prompt file stays theirs.
  const promptSnapshot = join(scratch.dir, "prompt.txt");
  writeFileSync(promptSnapshot, prompt);
  const delivery = stdinPrompt ? stdinDelivery(tool, promptSnapshot) : argvDelivery(tool, prompt);
  if (captureDir !== null) {
    runCapture(tool, delivery, scratch);
    return;
  }
  runForeground(tool, delivery, scratch);
}

try {
  main();
} catch (error) {
  if (!(error instanceof SilentExit)) throw error;
}
