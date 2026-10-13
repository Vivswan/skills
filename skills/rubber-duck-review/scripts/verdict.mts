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

export interface Review {
  verdict: Verdict;
  /** Tool calls (commands, file reads) that preceded the verdict in its turn. */
  toolCalls: number;
  trajectory: TrajectoryRow[];
}

export type Extraction = { ok: true; review: Review } | { ok: false; reason: string };

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

export function extractVerdict(tool: Tool, raw: string): Extraction {
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
  // A failed turn is final; a later verdict never clears it, unlike a reconnect error.
  let turnFailed: string | null = null;
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
      if (event.type === "turn.failed") turnFailed = errorEvent;
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
          // A stream reconnect ("stream disconnected ... retrying") is an error event the
          // reviewer recovered from; a message landing after it is the verdict. An error with
          // no message after it still fails the capture, and a turn.failed always does.
          errorEvent = null;
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
  if (turnFailed !== null) return { ok: false, reason: `error event: ${turnFailed}` };
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
