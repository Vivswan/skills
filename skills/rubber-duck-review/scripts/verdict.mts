// The verdict a reviewer's capture carries, read and checked: the final message must be the object the
// reviewer prompt's report format describes, and an ACP reviewer's turn must have called a tool before
// it. codex's and claude's capture is the ACP session acp.mts writes, copilot's is plain text. No IO;
// run-review.mts launches the reviewer, captures the stream, and reports this.

import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";

// --- Self-build: run as source, bundle into <skill>/.build/ and run the bundle; run as the bundle, do nothing.
// docs/authoring.md > Dependencies owns this block; the smoke test keeps every copy identical.

function buildPaths(source: string) {
  // An entry may sit below scripts/: the skill root is the parent of the scripts/ with the manifest beside it.
  let scripts = dirname(source);
  while (basename(scripts) !== "scripts" || !existsSync(join(dirname(scripts), "package.json"))) {
    if (dirname(scripts) === scripts) {
      console.error(
        `${source}: no scripts/ directory with a package.json beside it above the script`,
      );
      process.exit(2);
    }
    scripts = dirname(scripts);
  }
  const skill = dirname(scripts);
  const built = join(skill, ".build", relative(scripts, source).replace(/\.mts$/, ".js"));
  return { scripts, skill, built };
}

function buildIsStale(scripts: string, skill: string, built: string): boolean {
  if (!existsSync(built)) return true;
  // An entry imports its siblings, and a pin bump changes the bundle, so every script and the manifest count.
  const inputs = readdirSync(scripts, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".mts"))
    .map((name) => join(scripts, name));
  inputs.push(join(skill, "package.json"));
  const newest = Math.max(...inputs.map((path) => statSync(path).mtimeMs));
  return statSync(built).mtimeMs < newest;
}

function runBun(args: string[]): boolean {
  const step = spawnSync("bun", args, { stdio: ["ignore", "ignore", "pipe"] });
  if (step.status !== 0) process.stderr.write(step.stderr);
  return step.status === 0;
}

function build(source: string, scripts: string, skill: string, built: string): boolean {
  // bun build resolves installed packages only, from a node_modules beside the entry, and two first runs at
  // once must never share one: each build gets its own scratch under .build/ and publishes by one rename.
  mkdirSync(join(skill, ".build"), { recursive: true });
  const scratch = mkdtempSync(join(skill, ".build", "scratch-"));
  try {
    cpSync(scripts, join(scratch, "scripts"), { recursive: true });
    copyFileSync(join(skill, "package.json"), join(scratch, "package.json"));
    const entry = join(scratch, "scripts", relative(scripts, source));
    const bundle = join(scratch, "bundle.js");
    const ok =
      runBun(["install", "--production", "--no-save", "--cwd", scratch]) &&
      runBun(["build", entry, "--target", "bun", "--outfile", bundle]);
    if (!ok) return false;
    mkdirSync(dirname(built), { recursive: true });
    renameSync(bundle, built);
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function ensureBuilt(source: string): Promise<boolean> {
  if (!source.endsWith(".mts")) return Promise.resolve(false);
  const { scripts, skill, built } = buildPaths(source);
  if (buildIsStale(scripts, skill, built) && !build(source, scripts, skill, built)) process.exit(2);
  // The bundle runs on this process's stdio, and a signal to this process goes on to it; this process then ends as
  // the bundle did, by its status, or by the same signal once the forwarding is off and the signal's default is back.
  const run = spawn("bun", [built, ...process.argv.slice(2)], { stdio: "inherit" });
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  const forward = (signal: NodeJS.Signals) => {
    run.kill(signal);
  };
  for (const signal of signals) process.on(signal, forward);
  return new Promise((resolve) => {
    const settle = (status: number | null, signal: NodeJS.Signals | null) => {
      for (const name of signals) process.off(name, forward);
      if (signal !== null) {
        process.kill(process.pid, signal);
        return;
      }
      process.exitCode = status ?? 1;
      resolve(true);
    };
    run.on("exit", settle);
    // A bundle that never started (no bun on PATH) emits error and no exit: that is the run's failure.
    run.on("error", (error) => {
      console.error(String(error));
      settle(1, null);
    });
  });
}

// Only the command builds; a test or a sibling importing this file must not.
if (import.meta.main && (await ensureBuilt(import.meta.path))) process.exit();

// Loaded below the guard: a static import is hoisted above it and would resolve on the source path.

const z = await import("zod/mini");

const TOOLS = ["codex", "claude", "copilot"] as const;
export type Tool = (typeof TOOLS)[number];

export function isTool(value: string): value is Tool {
  return (TOOLS as readonly string[]).includes(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Finding {
  where: string;
  claim: string;
  evidence: string;
}

/** The verdict object the reviewer prompt's report format describes. */
export interface Verdict {
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

/** A usable capture: the verdict, and the tool calls (commands, file reads) that preceded it in its turn. */
export interface Review {
  verdict: Verdict;
  toolCalls: number;
  trajectory: TrajectoryRow[];
}

export type Extraction = { ok: true; review: Review } | { ok: false; reason: string };

/** The reading of one stream so far, as the final judgment weighs it. */
interface Reading {
  /** The rows the report prints, in stream order: tool calls, messages, and the errors among them. */
  trajectory: TrajectoryRow[];

  /** null until a final message lands, "" for a blank one, else the parsed verdict or the reason it is none. */
  verdict: Verdict | string | null;

  /** Why no verdict came: the session's failure, a stop other than end_turn, a refused permission behind a cancel. */
  turnFailed: string | null;

  /** Tool calls seen so far in the turn. */
  toolCallsThisTurn: number;

  /** The count at the moment the winning message landed: what proves the reviewer read something first. */
  toolCallsBeforeVerdict: number;

  /** Mid-stream malformed lines are skippable noise; a malformed final line means the stream was truncated mid-write. */
  lastLineMalformed: boolean;

  /** ACP: the agent's text since the last tool call, the final message once the turn ends. */
  message: string;

  /** ACP: the text segments since the last tool call in stream order, narration and reasoning alternating; each becomes one trajectory row. */
  segments: { event: "agent_message" | "reasoning"; text: string }[];

  /** ACP: the permission the review refused, which codex answers by ending the turn. */
  refused: string | null;
}

const EXCERPT_CHARS = 160;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_CHARS ? `${flat.slice(0, EXCERPT_CHARS)}...` : flat;
}

// The report format's object, every key named and no other; the reviewer prompt asks the model for the same.

const FINDING = z.strictObject({ where: z.string(), claim: z.string(), evidence: z.string() });
const VERDICT = z.strictObject({
  blocking: z.array(FINDING),
  non_blocking: z.array(FINDING),
  recorded_not_built: z.array(z.string()),
  summary: z.string().check(z.refine((text) => text.trim() !== "")),
});

/** Why a value is not the verdict object, in the report format's words: the issue's first path step names the field. */
function verdictIssue(issue: { code: string; path: PropertyKey[]; keys?: string[] }): string {
  const field = issue.path[0];
  if (field === undefined) {
    if (issue.code !== "unrecognized_keys") return "final message is not a JSON object";
    return `unexpected key(s): ${(issue.keys ?? []).join(", ")}`;
  }
  if (field === "blocking" || field === "non_blocking") {
    return `${field} is not an array of exactly {where, claim, evidence}`;
  }
  if (field === "recorded_not_built") return "recorded_not_built is not an array of strings";
  return "summary is missing or blank";
}

/** No schema holds any reviewer to the shape: this check is the contract, the
 * same for every reviewer's final message. */
function parseVerdict(value: unknown): Verdict | string {
  const read = VERDICT.safeParse(value);
  if (read.success) return read.data;
  const [issue] = read.error.issues;
  return verdictIssue({
    code: issue?.code ?? "invalid_type",
    path: issue?.path ?? [],
    keys: issue !== undefined && "keys" in issue ? (issue.keys as string[]) : undefined,
  });
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

/** copilot answers in plain text: the whole output is the verdict, and there are no tool calls to count. */
function copilotVerdict(raw: string): Extraction {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty output" };

  const verdict = parseVerdictText(text);
  if (typeof verdict === "string") return { ok: false, reason: `not a verdict: ${verdict}` };

  return { ok: true, review: { verdict, toolCalls: 0, trajectory: [] } };
}

/** A chunk of narration or reasoning joins the last segment of its kind, or opens one, so the rows keep the stream's order. */
function addText(reading: Reading, event: "agent_message" | "reasoning", text: string): void {
  if (event === "agent_message") reading.message += text;
  const last = reading.segments.at(-1);
  if (last !== undefined && last.event === event) {
    last.text += text;
    return;
  }
  reading.segments.push({ event, text });
}

/** The text so far becomes trajectory rows, in the order it streamed: at a tool call, a permission, or the stop. */
function flushSegments(reading: Reading): void {
  for (const segment of reading.segments) {
    if (segment.text.trim() !== "") {
      reading.trajectory.push({ event: segment.event, text: excerpt(segment.text) });
    }
  }
  reading.segments = [];
}

/** A boundary that also starts the message over: the verdict is the text after the last tool call. */
function flushText(reading: Reading): void {
  flushSegments(reading);
  reading.message = "";
}

/** The final message's verdict: the whole text when it is the object, else the trailing object after the sentence
 * an unschema'd reviewer puts before it; the outermost `{` whose remainder parses wins, so prose stays prose. */
function parseVerdictMessage(text: string): Verdict | string {
  const whole = parseVerdictText(text);
  if (typeof whole !== "string" || whole !== "final message is not JSON") return whole;

  for (let at = text.indexOf("{"); at !== -1; at = text.indexOf("{", at + 1)) {
    const trailing = parseVerdictText(text.slice(at));
    if (typeof trailing !== "string" || trailing !== "final message is not JSON") return trailing;
  }
  return "final message is not JSON";
}

/** One session update of the ACP capture: text accumulates, a tool call (codex's Guardian Review is a `think`, not a read) is a boundary and a count. */
function readAcpUpdate(reading: Reading, update: Record<string, unknown>): void {
  const content = isRecord(update.content) ? update.content : undefined;
  const text = content?.type === "text" && typeof content.text === "string" ? content.text : "";
  if (update.sessionUpdate === "agent_message_chunk") addText(reading, "agent_message", text);
  if (update.sessionUpdate === "agent_thought_chunk") addText(reading, "reasoning", text);
  if (update.sessionUpdate !== "tool_call") return;

  flushText(reading);
  const title = typeof update.title === "string" ? update.title : "tool call";
  reading.trajectory.push({ event: "tool_call", text: excerpt(title) });
  if (update.kind !== "think") reading.toolCallsThisTurn += 1;
}

/** The turn's end: end_turn makes the text since the last tool call the verdict; any other stop reason fails the
 * review, a cancel named by the permission the review refused (codex ends the turn on a refusal). */
function readAcpStop(reading: Reading, stopReason: string): void {
  if (stopReason !== "end_turn") {
    reading.trajectory.push({ event: "stop", text: stopReason });
    const refusal = stopReason === "cancelled" ? reading.refused : null;
    reading.turnFailed = refusal ?? `turn ended ${stopReason}`;
    return;
  }
  const message = reading.message;
  reading.verdict = message.trim() === "" ? "" : parseVerdictMessage(message);
  reading.toolCallsBeforeVerdict = reading.toolCallsThisTurn;
  flushText(reading);
  reading.trajectory.push({ event: "stop", text: stopReason });
}

/** One line of the capture acp.mts writes: a session update, a permission request with the review's answer, the stop, or the failure. */
function readAcpEvent(reading: Reading, event: Record<string, unknown>): void {
  if (event.event === "update" && isRecord(event.update)) readAcpUpdate(reading, event.update);
  if (event.event === "permission") {
    flushSegments(reading);
    const kind = typeof event.kind === "string" ? event.kind : "other";
    const title = typeof event.title === "string" ? event.title : "";
    reading.trajectory.push({
      event: "permission",
      text: excerpt(`${event.answer} ${kind}: ${title}`),
    });
    if (event.answer === "deny")
      reading.refused = `the reviewer asked to ${kind} (${title}); a review is read-only`;
  }
  if (event.event === "stop" && typeof event.stopReason === "string") {
    readAcpStop(reading, event.stopReason);
  }
  if (event.event === "failed" && typeof event.reason === "string") {
    reading.turnFailed = event.reason;
    reading.trajectory.push({ event: "failed", text: excerpt(event.reason) });
  }
}

/** The stream read event by event, one JSON object per line; a line that is not one is skipped and remembered
 * only when it is the last. */
function readStream(raw: string): Reading {
  const reading: Reading = {
    trajectory: [],
    verdict: null,
    turnFailed: null,
    toolCallsThisTurn: 0,
    toolCallsBeforeVerdict: 0,
    lastLineMalformed: false,
    message: "",
    segments: [],
    refused: null,
  };
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: unknown;
    try {
      event = JSON.parse(trimmed);
      reading.lastLineMalformed = false;
    } catch {
      reading.lastLineMalformed = true;
      continue;
    }
    if (!isRecord(event)) continue;

    readAcpEvent(reading, event);
  }

  return reading;
}

/** What the reading amounts to, each failure outranking the ones below it. */
function judgeReading(raw: string, reading: Reading): Extraction {
  const { verdict, toolCallsBeforeVerdict, trajectory } = reading;
  if (reading.turnFailed !== null)
    return { ok: false, reason: `error event: ${reading.turnFailed}` };
  if (reading.lastLineMalformed) {
    return { ok: false, reason: "malformed trailing line (stream truncated mid-write)" };
  }
  if (verdict === null) {
    return {
      ok: false,
      reason: raw.trim() === "" ? "empty output" : "stream ended without a verdict event",
    };
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

export function extractVerdict(tool: Tool, raw: string): Extraction {
  if (tool === "copilot") return copilotVerdict(raw);

  return judgeReading(raw, readStream(raw));
}
