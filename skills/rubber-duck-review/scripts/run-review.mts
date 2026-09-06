#!/usr/bin/env bun
/**
 * Launch a read-only cross-model reviewer and print its final verdict.
 *
 * Usage:
 *   run-review.mts <codex|claude|copilot> <prompt-file> [--background] [--stdin-prompt]
 *   run-review.mts <codex|claude|copilot> --extract <output-file>
 *   run-review.mts prepare <section>
 *
 * The verdict is the structured object in verdict-schema.json (blocking,
 * non_blocking, recorded_not_built, summary). codex and claude receive that
 * schema through their CLIs (--output-schema / --json-schema), so their final
 * message cannot be free text; copilot has no schema flag and must emit the
 * object itself. A message that does not parse as the schema object fails
 * the review.
 *
 * A well-formed message is still not a verdict on its own: codex applies the
 * schema to its narration too, so a turn that ends after "I will review the
 * changes now" produces a schema-valid object with empty findings. A review
 * has to read something, so the verdict counts only when at least one tool
 * call (a command, a file read) precedes it in the same turn; a turn with
 * none is a preamble and fails the review. copilot's plain-text output has no
 * trajectory to check, which is one reason it is the last-resort reviewer.
 *
 * On success stdout is one JSON object: the verdict, the tool-call count, the
 * path of the kept capture (the full reviewer stream, for inspecting any
 * message), and a compact trajectory (one row per reviewer step). Every run
 * that reached the reviewer keeps its capture dir so a surprising verdict can
 * be traced; remove it once triaged. A foreground launch that never started
 * the reviewer (binary not found) has nothing to keep and removes it; a
 * --background one keeps the dir, since --extract reads the recorded
 * not-found status from it.
 *
 * prepare mints a private directory under os.tmpdir() with mkdtemp (atomic,
 * so concurrent reviews can never share a path), leaves its marker file in
 * it, and prints the section's prompt file inside it. A launch accepts only a
 * regular file directly inside a marked directory: a predictable shared path,
 * which one agent could overwrite under another before the launch reads it,
 * is refused as a usage error, as is a symlink out of the directory. The
 * marker, not the location, is the provenance, so the prepare and launch
 * shells need not share TMPDIR.
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
 *   1  review FAILED - relaunch (empty or cut stream, error events, a final
 *      message that is not the schema object, a verdict with no tool calls
 *      before it, blank or unrecorded verdicts, or a non-zero reviewer exit;
 *      an empty review must never read as clean)
 *   2  usage error or reviewer binary not found
 */

import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  lstatSync,
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

const SCHEMA_FILE = join(dirname(fileURLToPath(import.meta.url)), "verdict-schema.json");

/** Read once at launch; a missing or malformed schema beside the script is a
 * broken install, not a review failure. */
function schemaText(): string {
  return readFileSync(SCHEMA_FILE, "utf-8");
}

const TOOL_ARGS: Record<Tool, (prompt: string) => string[]> = {
  // --sandbox read-only: the reviewer can grep/diff/typecheck but not write.
  // --output-schema: the final message must be the verdict object.
  codex: (prompt) => [
    "exec",
    "--json",
    "--sandbox",
    "read-only",
    "--output-schema",
    SCHEMA_FILE,
    prompt,
  ],
  // --verbose is REQUIRED with --output-format stream-json; without it claude
  // errors to stderr and stdout stays empty. --json-schema takes the schema
  // inline and delivers the verdict as the result's structured_output.
  claude: (prompt) => [
    "-p",
    "--permission-mode",
    "plan",
    "--verbose",
    "--output-format",
    "stream-json",
    "--json-schema",
    schemaText(),
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
  "       run-review.mts prepare <section>",
].join("\n");

const PROMPT_DIR_PREFIX = "rubber-duck-prompt-";
const MINT_MARKER = ".minted-by-run-review";
const SECTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Thrown after exit output is queued, so `never`-typed helpers stay honest. */
class SilentExit extends Error {}

function usageError(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exitCode = 2;
  throw new SilentExit();
}

/** Mint a private directory for one review's prompt files and print the
 * section's prompt file path inside it. mkdtemp is atomic, so two callers can
 * never receive the same directory. */
function preparePrompt(section: string): void {
  if (!SECTION_NAME.test(section)) {
    usageError(`prepare: section must match ${SECTION_NAME}, got ${JSON.stringify(section)}`);
  }
  const dir = mkdtempSync(join(tmpdir(), PROMPT_DIR_PREFIX));
  writeFileSync(join(dir, MINT_MARKER), "");
  process.stdout.write(`${join(dir, `${section}.md`)}\n`);
}

/** A launch accepts only a regular, singly-linked file directly inside a
 * prepare-minted directory (prefix plus marker, and not itself a symlink), so
 * a predictable shared path cannot come back, and no symlink or hard link can
 * alias the launch onto a shared file elsewhere. */
function requireMintedPrompt(promptFile: string): void {
  const dir = dirname(promptFile);
  const notMinted = (): never =>
    usageError(
      `prompt file must live in a directory minted by \`run-review.mts prepare <section>\`, got ${promptFile}`,
    );
  if (!basename(dir).startsWith(PROMPT_DIR_PREFIX) || !existsSync(join(dir, MINT_MARKER))) {
    notMinted();
  }
  let dirStat: ReturnType<typeof lstatSync>;
  let stat: ReturnType<typeof lstatSync>;
  try {
    dirStat = lstatSync(dir);
    stat = lstatSync(promptFile);
  } catch (error) {
    usageError(`cannot read prompt file ${promptFile}: ${String(error)}`);
  }
  if (dirStat.isSymbolicLink()) notMinted();
  if (!stat.isFile() || stat.nlink !== 1) {
    usageError(
      `prompt file must be a regular file with a single link in its minted directory, not a symlink or hard link: ${promptFile}`,
    );
  }
}

/** --capture is the monitor half of --background: it may consume only the
 * prompt snapshot inside a scratch dir whose launch record names this
 * reviewer. A caller cannot use it to launch an unminted prompt. */
function requireCaptureProvenance(tool: Tool, promptFile: string, captureDir: string): void {
  const scratch = scratchPaths(captureDir, tool);
  const refuse = (): never =>
    usageError(
      `--capture is internal to --background: ${captureDir} has no matching launch record`,
    );
  let record: unknown;
  try {
    record = JSON.parse(readFileSync(scratch.statusFile, "utf-8"));
  } catch {
    refuse();
  }
  if (
    !isRecord(record) ||
    record.tool !== tool ||
    record.output !== basename(scratch.outFile) ||
    promptFile !== join(captureDir, "prompt.txt")
  ) {
    refuse();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

interface Finding {
  where: string;
  claim: string;
  evidence: string;
}

/** The verdict object verdict-schema.json describes. */
interface Verdict {
  blocking: Finding[];
  non_blocking: Finding[];
  recorded_not_built: string[];
  summary: string;
}

/** One reviewer step, for the compact trajectory on stdout. */
interface TrajectoryRow {
  event: string;
  text?: string;
}

interface Review {
  verdict: Verdict;
  /** Tool calls (commands, file reads) that preceded the verdict in its turn. */
  toolCalls: number;
  trajectory: TrajectoryRow[];
}

type Extraction = { ok: true; review: Review } | { ok: false; reason: string };

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

const EXCERPT_CHARS = 160;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}...` : flat;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** Exactly the schema's keys: verdict-schema.json says additionalProperties
 * false, and this reading of a reviewer's message must not be looser. */
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

const FINDING_KEYS = ["where", "claim", "evidence"] as const;
const VERDICT_KEYS = ["blocking", "non_blocking", "recorded_not_built", "summary"] as const;

function isFinding(value: unknown): value is Finding {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, FINDING_KEYS) &&
    typeof value.where === "string" &&
    typeof value.claim === "string" &&
    typeof value.evidence === "string"
  );
}

/** The schema gives codex and claude the shape; this check is what makes the
 * script's own reading of any reviewer's final message the same contract. */
function parseVerdict(value: unknown): Verdict | string {
  if (!isRecord(value)) return "final message is not a JSON object";
  if (!hasOnlyKeys(value, VERDICT_KEYS)) {
    return `unexpected key(s): ${Object.keys(value)
      .filter((key) => !VERDICT_KEYS.includes(key as (typeof VERDICT_KEYS)[number]))
      .join(", ")}`;
  }
  const { blocking, non_blocking, recorded_not_built, summary } = value;
  if (!Array.isArray(blocking) || !blocking.every(isFinding)) {
    return "blocking is not an array of exactly {where, claim, evidence}";
  }
  if (!Array.isArray(non_blocking) || !non_blocking.every(isFinding)) {
    return "non_blocking is not an array of exactly {where, claim, evidence}";
  }
  if (!isStringArray(recorded_not_built)) return "recorded_not_built is not an array of strings";
  if (typeof summary !== "string" || summary.trim() === "") return "summary is missing or blank";
  return { blocking, non_blocking, recorded_not_built, summary };
}

/** copilot answers in plain text, so the object may arrive inside a ```json
 * fence; anything else around it is a failed review, not something to guess at. */
function parseVerdictText(text: string): Verdict | string {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/, "")
    .replace(/\n?```\s*$/, "");
  let value: unknown;
  try {
    value = JSON.parse(unfenced);
  } catch {
    return "final message is not JSON";
  }
  return parseVerdict(value);
}

/** Claude's read-only turn calls tools by name; StructuredOutput is how the
 * schema answer itself is delivered, so it is not evidence of a review. */
const CLAUDE_ANSWER_TOOL = "StructuredOutput";

function extractVerdict(tool: Tool, raw: string): Extraction {
  if (tool === "copilot") {
    const text = raw.trim();
    if (!text) return { ok: false, reason: "empty output" };
    const verdict = parseVerdictText(text);
    if (typeof verdict === "string") return { ok: false, reason: `not a verdict: ${verdict}` };
    return { ok: true, review: { verdict, toolCalls: 0, trajectory: [] } };
  }
  const trajectory: TrajectoryRow[] = [];
  let verdict: Verdict | string | null = null;
  let errorEvent: string | null = null;
  // Tool calls seen so far in the current turn; the count at the moment the
  // winning message lands is what proves the reviewer read something first.
  let toolCallsThisTurn = 0;
  let toolCallsBeforeVerdict = 0;
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
      trajectory.push({ event: String(event.type), text: excerpt(errorEvent) });
    }
    if (tool === "codex") {
      if (event.type === "turn.started") {
        turnOpen = true;
        toolCallsThisTurn = 0;
      }
      if (event.type === "item.completed" && isRecord(event.item)) {
        const item = event.item;
        const kind = typeof item.type === "string" ? item.type : "item";
        if (kind === "command_execution" || kind === "mcp_tool_call") {
          toolCallsThisTurn += 1;
          const command = typeof item.command === "string" ? item.command : kind;
          trajectory.push({ event: kind, text: excerpt(command) });
        } else if (typeof item.text === "string") {
          trajectory.push({ event: kind, text: excerpt(item.text) });
        }
        // codex narrates with intermediate agent_message items; the last one wins.
        if (kind === "agent_message" && typeof item.text === "string") {
          verdict = item.text.trim() === "" ? "" : parseVerdictText(item.text);
          toolCallsBeforeVerdict = toolCallsThisTurn;
          awaitingTurnEnd = true;
        }
      }
      if (event.type === "turn.completed" || event.type === "turn.failed") {
        awaitingTurnEnd = false;
        turnOpen = false;
      }
    }
    if (tool === "claude") {
      if (
        event.type === "assistant" &&
        isRecord(event.message) &&
        Array.isArray(event.message.content)
      ) {
        for (const block of event.message.content) {
          if (!isRecord(block)) continue;
          if (block.type === "tool_use") {
            const name = typeof block.name === "string" ? block.name : "tool";
            if (name === CLAUDE_ANSWER_TOOL) continue;
            toolCallsThisTurn += 1;
            trajectory.push({
              event: "tool_use",
              text: excerpt(`${name} ${JSON.stringify(block.input ?? {})}`),
            });
          } else if (block.type === "text" && typeof block.text === "string") {
            trajectory.push({ event: "text", text: excerpt(block.text) });
          }
        }
      }
      if (event.type === "result") {
        // claude reports in-band terminal failures as result records with
        // is_error: true (the CLI can still exit 0); those carry no verdict.
        if (event.is_error === true) {
          const subtype = typeof event.subtype === "string" ? event.subtype : "unknown";
          errorEvent = `claude result has is_error: true (subtype: ${subtype})`;
          trajectory.push({ event: "result", text: excerpt(errorEvent) });
        } else if ("structured_output" in event) {
          verdict = parseVerdict(event.structured_output);
          toolCallsBeforeVerdict = toolCallsThisTurn;
          trajectory.push({ event: "result" });
        } else if (typeof event.result === "string") {
          verdict = event.result.trim() === "" ? "" : parseVerdictText(event.result);
          toolCallsBeforeVerdict = toolCallsThisTurn;
          trajectory.push({ event: "result" });
        }
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
  if (verdict === "") return { ok: false, reason: "empty verdict" };
  if (typeof verdict === "string") return { ok: false, reason: `not a verdict: ${verdict}` };
  if (toolCallsBeforeVerdict === 0) {
    return {
      ok: false,
      reason: "no tool calls before the final message (a preamble, not a review)",
    };
  }
  return { ok: true, review: { verdict, toolCalls: toolCallsBeforeVerdict, trajectory } };
}

// Exits go through process.exitCode + a natural event-loop drain, never
// process.exit(): an explicit exit can truncate a large pending stream write.
function reportVerdict(extraction: Extraction, outputFile: string): void {
  if (extraction.ok) {
    const { verdict, toolCalls, trajectory } = extraction.review;
    const report = { verdict, tool_calls: toolCalls, capture: outputFile, trajectory };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 0;
    return;
  }
  // Name the capture only when it is there to read: an --extract whose
  // stream was already deleted must not point at a path that is gone.
  const kept = existsSync(outputFile) ? `; output kept at ${outputFile}` : "";
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

/** writeSync may write FEWER bytes than asked (pipes and signal interruption
 * make short writes legal); dropping the remainder would tear the captured
 * stream, and a torn error line can then parse as a clean review. Loop until
 * every byte lands. The injectable `write` exists for the unit test, which
 * cannot force a real partial write deterministically. */
export function writeAllSync(
  fd: number,
  chunk: Buffer,
  write: (fd: number, chunk: Buffer, offset: number, length: number) => number = writeSync,
): void {
  let offset = 0;
  while (offset < chunk.length) {
    offset += write(fd, chunk, offset, chunk.length - offset);
  }
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
    writeAllSync(outFd, chunk);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    writeAllSync(errFd, chunk);
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
      // The capture stays on success too: the printed report names it, so a
      // surprising verdict can be traced to the exact reviewer message.
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
  // The launch record is what lets the monitor's --capture prove its
  // provenance (and what --extract reads while the run is still pending).
  recordStatus(scratch, tool);
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
    reportVerdict({ ok: false, reason: `cannot read output file: ${String(error)}` }, outputFile);
    return;
  }
  reportVerdict(extractVerdict(tool, raw), outputFile);
}

function main(): void {
  const argv = process.argv.slice(2);
  if (argv[0] === "prepare") {
    const section = argv[1];
    if (section === undefined || argv.length !== 2)
      usageError("prepare takes exactly one <section>");
    preparePrompt(section);
    return;
  }
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
  if (captureDir === null) requireMintedPrompt(promptFile);
  else requireCaptureProvenance(tool, promptFile, captureDir);
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

// Guarded so importing the exported helpers (unit tests) runs nothing.
if (import.meta.main) {
  try {
    main();
  } catch (error) {
    if (!(error instanceof SilentExit)) throw error;
  }
}
