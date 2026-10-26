// The verdict a reviewer's captured stream carries, read and checked: the final message must be the
// object verdict-schema.json (beside this file) describes, and a codex or claude turn must have called a
// tool before it. No IO; run-review.mts launches the reviewer, captures the stream, and reports this.

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

/** The verdict object verdict-schema.json describes. */
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

  /** The last error the reviewer reported and did not recover from; a codex message after one clears it. */
  errorEvent: string | null;

  /** A failed turn is final; a later verdict never clears it, unlike a reconnect error. */
  turnFailed: string | null;

  /** Tool calls seen so far in the current turn; codex opens a new count at turn.started. */
  toolCallsThisTurn: number;

  /** The count at the moment the winning message landed: what proves the reviewer read something first. */
  toolCallsBeforeVerdict: number;

  /** codex: a verdict counts only once its turn completes; a stream cut right after an agent_message is mid-thought narration. */
  awaitingTurnEnd: boolean;

  /** codex: a trailing turn.started with no matching end voids any earlier verdict. */
  turnOpen: boolean;

  /** Mid-stream malformed lines are skippable noise; a malformed final line means the stream was truncated mid-write. */
  lastLineMalformed: boolean;
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

/** Claude's read-only turn calls tools by name; StructuredOutput only delivers the schema answer, so it is no evidence of a review. */
const CLAUDE_ANSWER_TOOL = "StructuredOutput";

/** copilot answers in plain text: the whole output is the verdict, and there are no tool calls to count. */
function copilotVerdict(raw: string): Extraction {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty output" };

  const verdict = parseVerdictText(text);
  if (typeof verdict === "string") return { ok: false, reason: `not a verdict: ${verdict}` };

  return { ok: true, review: { verdict, toolCalls: 0, trajectory: [] } };
}

/** An error event or a failed turn, which either reviewer may report. */
function readErrorEvent(reading: Reading, event: Record<string, unknown>, line: string): void {
  if (event.type !== "error" && event.type !== "turn.failed") return;

  const message = typeof event.message === "string" ? event.message : line;
  reading.errorEvent = message;
  if (event.type === "turn.failed") reading.turnFailed = message;
  reading.trajectory.push({ event: String(event.type), text: excerpt(message) });
}

/** A completed codex item: a tool call is counted, any text is a step, and an agent_message is the verdict
 * (codex narrates with intermediate ones; the last wins). */
function readCodexItem(reading: Reading, item: Record<string, unknown>): void {
  const kind = typeof item.type === "string" ? item.type : "item";
  if (kind === "command_execution" || kind === "mcp_tool_call") {
    reading.toolCallsThisTurn += 1;
    const command = typeof item.command === "string" ? item.command : kind;
    reading.trajectory.push({ event: kind, text: excerpt(command) });
  } else if (typeof item.text === "string") {
    reading.trajectory.push({ event: kind, text: excerpt(item.text) });
  }

  if (kind !== "agent_message" || typeof item.text !== "string") return;

  reading.verdict = item.text.trim() === "" ? "" : parseVerdictText(item.text);
  reading.toolCallsBeforeVerdict = reading.toolCallsThisTurn;
  reading.awaitingTurnEnd = true;
  // A stream reconnect ("stream disconnected ... retrying") is an error event the
  // reviewer recovered from; a message landing after it is the verdict. An error with
  // no message after it still fails the capture, and a turn.failed always does.
  reading.errorEvent = null;
}

function readCodexEvent(reading: Reading, event: Record<string, unknown>): void {
  if (event.type === "turn.started") {
    reading.turnOpen = true;
    reading.toolCallsThisTurn = 0;
  }
  if (event.type === "item.completed" && isRecord(event.item)) readCodexItem(reading, event.item);
  if (event.type === "turn.completed" || event.type === "turn.failed") {
    reading.awaitingTurnEnd = false;
    reading.turnOpen = false;
  }
}

/** The blocks of one assistant message: every tool call but the schema answer's is counted, every text is a step. */
function readClaudeContent(reading: Reading, content: unknown[]): void {
  for (const block of content) {
    if (!isRecord(block)) continue;

    if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "tool";
      if (name === CLAUDE_ANSWER_TOOL) continue;
      reading.toolCallsThisTurn += 1;
      reading.trajectory.push({
        event: "tool_use",
        text: excerpt(`${name} ${JSON.stringify(block.input ?? {})}`),
      });
    } else if (block.type === "text" && typeof block.text === "string") {
      reading.trajectory.push({ event: "text", text: excerpt(block.text) });
    }
  }
}

/** The verdict a claude result carries: its structured output, else its result text; null when it has neither. */
function claudeResultVerdict(event: Record<string, unknown>): Verdict | string | null {
  if ("structured_output" in event) return parseVerdict(event.structured_output);
  if (typeof event.result !== "string") return null;

  return event.result.trim() === "" ? "" : parseVerdictText(event.result);
}

/** claude reports in-band terminal failures as result records with is_error: true (the CLI can still exit 0);
 * those carry no verdict. */
function readClaudeResult(reading: Reading, event: Record<string, unknown>): void {
  if (event.is_error === true) {
    const subtype = typeof event.subtype === "string" ? event.subtype : "unknown";
    reading.errorEvent = `claude result has is_error: true (subtype: ${subtype})`;
    reading.trajectory.push({ event: "result", text: excerpt(reading.errorEvent) });
    return;
  }

  const verdict = claudeResultVerdict(event);
  if (verdict === null) return;

  reading.verdict = verdict;
  reading.toolCallsBeforeVerdict = reading.toolCallsThisTurn;
  reading.trajectory.push({ event: "result" });
}

function readClaudeEvent(reading: Reading, event: Record<string, unknown>): void {
  if (
    event.type === "assistant" &&
    isRecord(event.message) &&
    Array.isArray(event.message.content)
  ) {
    readClaudeContent(reading, event.message.content);
  }
  if (event.type === "result") readClaudeResult(reading, event);
}

/** The stream read event by event, one JSON object per line; a line that is not one is skipped and remembered
 * only when it is the last. */
function readStream(tool: "codex" | "claude", raw: string): Reading {
  const reading: Reading = {
    trajectory: [],
    verdict: null,
    errorEvent: null,
    turnFailed: null,
    toolCallsThisTurn: 0,
    toolCallsBeforeVerdict: 0,
    awaitingTurnEnd: false,
    turnOpen: false,
    lastLineMalformed: false,
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

    readErrorEvent(reading, event, trimmed);
    if (tool === "codex") readCodexEvent(reading, event);
    else readClaudeEvent(reading, event);
  }

  return reading;
}

/** What the reading amounts to, each failure outranking the ones below it. */
function judgeReading(raw: string, reading: Reading): Extraction {
  const { verdict, toolCallsBeforeVerdict, trajectory } = reading;
  if (reading.turnFailed !== null)
    return { ok: false, reason: `error event: ${reading.turnFailed}` };
  if (reading.errorEvent !== null)
    return { ok: false, reason: `error event: ${reading.errorEvent}` };
  if (reading.lastLineMalformed) {
    return { ok: false, reason: "malformed trailing line (stream truncated mid-write)" };
  }
  if (verdict === null) {
    return {
      ok: false,
      reason: raw.trim() === "" ? "empty output" : "stream ended without a verdict event",
    };
  }
  if (reading.awaitingTurnEnd || reading.turnOpen) {
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

export function extractVerdict(tool: Tool, raw: string): Extraction {
  if (tool === "copilot") return copilotVerdict(raw);

  return judgeReading(raw, readStream(tool, raw));
}
