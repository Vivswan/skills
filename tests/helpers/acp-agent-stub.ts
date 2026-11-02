#!/usr/bin/env bun
// A fake ACP agent for the tests, reached through a wrapper on PATH under an adapter's name
// (codex-acp, claude-agent-acp): the SDK's own agent() builder over stdio, a scripted turn per
// session/prompt, and a violations file for anything off-script. STUB_SCENARIO names the script:
// a Scenario (below) of Steps.
//
// Environment:
//   STUB_SCENARIO     the scenario file (required)
//   STUB_VIOLATIONS   a line per unexpected method, parameter, or mode
//   STUB_ARGS_LOG     argv, one line per launch
//   STUB_PROMPT_COPY  the first prompt's text, for the test to compare
//   STUB_PERMISSIONS  one JSON line per permission request: title, kind, and the option the client chose
//   STUB_STEERS       one line per _session/steering request's text
//   STUB_CWD_REPORT   git facts about the session's cwd, and a write into its toplevel (the copy-mode tests)
//   STUB_PID_FILE     this process's pid, for the stall tests to confirm the kill
//   STUB_EXIT         the exit status once the client hangs up (default 0)

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

interface ToolStep {
  type: "tool";
  title: string;
  kind: acp.ToolKind;
  permission?: boolean;
  output?: string;
  onReject?: "cancel" | "continue";
  locations?: { path: string }[];
}

/** One step of a turn, run in order:
 *   { "type": "message", "text": "...", "chunks": 3 }      agent_message_chunk, the text split into chunks
 *   { "type": "thought", "text": "..." }                   agent_thought_chunk
 *   { "type": "tool", "title": "git diff", "kind": "execute", "permission": true, "output": "...",
 *     "onReject": "cancel" }                               tool_call, then session/request_permission when permission
 *                                                           is set; a rejection ends the turn with stopReason cancelled
 *                                                           (codex) or marks the call failed and goes on ("continue", claude)
 *   { "type": "stop", "reason": "end_turn" }               the prompt's response; end_turn when no step says
 *   { "type": "exit", "code": 1 }                          the adapter dies mid-turn
 *   { "type": "sleep", "ms": 300 }                         silence */
type Step =
  | { type: "message"; text: string; chunks?: number }
  | { type: "thought"; text: string }
  | ToolStep
  | { type: "stop"; reason: acp.StopReason }
  | { type: "exit"; code: number }
  | { type: "sleep"; ms: number };

/** The scenario file: what the agent advertises and what each turn does.
 *   {
 *     "steering": true,                        advertise _meta.steering in the initialize response and accept
 *                                              _session/steering: injected while a turn runs, else promptRequired
 *                                              when the request asks for it, else a new turn from the next script
 *     "modes": { "currentModeId": "read-only", "availableModes": [{ "id": "read-only", "name": "Read-only" }] },
 *     "expectMode": "read-only",               the id session/set_mode must carry before the first prompt; another id, or no set_mode, is a violation
 *     "turns": [ [ <step>, ... ], ... ]        one list per session/prompt, in order
 *   } */
interface Scenario {
  steering?: boolean;
  modes?: acp.NewSessionResponse["modes"];
  expectMode?: string | null;
  turns: Step[][];
}

/** The steering extension's request: the prompt's content blocks plus the idle behaviour the client asks for. */
interface SteerParams {
  sessionId: string;
  prompt: acp.ContentBlock[];
  _meta?: { steering?: { idleBehavior?: string } } | null;
}

const SESSION_ID = "stub-session-1";
const PERMISSION_OPTIONS: acp.PermissionOption[] = [
  { optionId: "allow_once", name: "Yes, proceed", kind: "allow_once" },
  { optionId: "allow_always", name: "Yes, and don't ask again", kind: "allow_always" },
  {
    optionId: "cancel",
    name: "No, and tell the agent what to do differently",
    kind: "reject_once",
  },
];

const env = (name: string): string | undefined => process.env[name];
const scenarioPath = env("STUB_SCENARIO");
if (scenarioPath === undefined) {
  process.stderr.write("acp-agent-stub: STUB_SCENARIO is not set\n");
  process.exit(64);
}
const scenario = JSON.parse(readFileSync(scenarioPath, "utf8")) as Scenario;

let turnIndex = 0;
let toolCalls = 0;
let modeSet = false;
let cancelled = false;
let turnRunning = false;
/** The connection's context, for the updates and requests a turn sends outside the prompt handler. */
let client: acp.AgentContext;

function note(file: string | undefined, line: string): void {
  if (file !== undefined) appendFileSync(file, `${line}\n`);
}
const violate = (what: string): void => note(env("STUB_VIOLATIONS"), what);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function update(body: acp.SessionNotification["update"]): Promise<void> {
  return client.notify(acp.methods.client.session.update, { sessionId: SESSION_ID, update: body });
}

/** The git facts the copy-mode tests read, from the cwd the client named, plus a write into its toplevel. */
function reportCwd(cwd: string, file: string): void {
  const git = (...args: string[]): string => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    return `${result.stdout.toString()}${result.stderr.toString()}`.trim();
  };
  const top = git("rev-parse", "--show-toplevel");
  let aText = "";
  try {
    aText = readFileSync(join(top, "a.txt"), "utf8").split("\n")[0] ?? "";
  } catch {
    // no a.txt in this fixture
  }
  const lines = [
    cwd,
    top,
    git("branch", "--show-current"),
    git("status", "--porcelain", "-uall", "--ignored").split("\n").filter(Boolean).join("|"),
    git("rev-parse", "-q", "--verify", "HEAD"),
    git("rev-list", "--count", "HEAD").split("\n").at(-1) ?? "",
    aText,
    git("config", "--get", "filter.lfs.smudge"),
    git("--no-pager", "diff", "--stat", "origin/main...HEAD").split("\n").at(-1) ?? "",
    git("rev-parse", "-q", "--verify", "ORIG_HEAD"),
  ];
  writeFileSync(file, `${lines.join("\n")}\n`);
  // A write the prompt forbade: it must land in the copy, never in the checkout under review.
  writeFileSync(join(top, "REVIEWER_WROTE"), "");
}

function promptText(blocks: acp.ContentBlock[]): string {
  return blocks.map((block) => (block.type === "text" ? block.text : "")).join("");
}

async function emitMessage(text: string, chunks: number): Promise<void> {
  if (text.length === 0) {
    await update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } });
    return;
  }
  const size = Math.ceil(text.length / chunks) || 1;
  for (let at = 0; at < text.length; at += size) {
    await update({
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: text.slice(at, at + size) },
    });
  }
}

/** Runs one tool step; false when a rejection ends the turn. Ids count across the session, as ACP requires. */
async function runTool(step: ToolStep): Promise<boolean> {
  toolCalls += 1;
  const toolCallId = `call-${toolCalls}`;
  const locations = step.locations ?? [];
  await update({
    sessionUpdate: "tool_call",
    toolCallId,
    title: step.title,
    kind: step.kind,
    status: "in_progress",
    locations,
    rawInput: { command: step.title },
  });
  if (step.permission === true) {
    const answer: acp.RequestPermissionResponse = await client.request(
      acp.methods.client.session.requestPermission,
      {
        sessionId: SESSION_ID,
        toolCall: {
          toolCallId,
          title: step.title,
          kind: step.kind,
          status: "in_progress",
          locations,
        },
        options: PERMISSION_OPTIONS,
      },
    );
    const chosen = answer.outcome.outcome === "selected" ? answer.outcome.optionId : "cancelled";
    note(env("STUB_PERMISSIONS"), JSON.stringify({ title: step.title, kind: step.kind, chosen }));
    if (chosen === "cancel" || chosen === "cancelled") {
      await update({ sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
      return step.onReject === "continue";
    }
  }
  await update({
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    content:
      step.output === undefined
        ? []
        : [{ type: "content", content: { type: "text", text: step.output } }],
  });
  return true;
}

async function runStep(step: Step): Promise<acp.PromptResponse | null> {
  switch (step.type) {
    case "message":
      await emitMessage(step.text, step.chunks ?? 1);
      return null;
    case "thought":
      await update({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: step.text },
      });
      return null;
    case "tool":
      return (await runTool(step)) ? null : { stopReason: "cancelled" };
    case "stop":
      return { stopReason: step.reason };
    case "exit":
      process.exit(step.code);
      return null;
    case "sleep":
      await sleep(step.ms);
      return null;
  }
}

/** A cancel landing during any step, the last included, ends the turn cancelled. */
async function runTurn(steps: Step[]): Promise<acp.PromptResponse> {
  turnRunning = true;
  try {
    for (const step of steps) {
      if (cancelled) return { stopReason: "cancelled" };
      const ended = await runStep(step);
      if (ended !== null) return ended;
    }
    return cancelled ? { stopReason: "cancelled" } : { stopReason: "end_turn" };
  } finally {
    turnRunning = false;
  }
}

/** The next scripted turn, or null past the script (a violation the caller names). */
function nextTurn(): Step[] | null {
  const steps = scenario.turns[turnIndex];
  turnIndex += 1;
  return steps ?? null;
}

function initialize(): acp.InitializeResponse {
  return {
    protocolVersion: acp.PROTOCOL_VERSION,
    agentCapabilities: { loadSession: false },
    agentInfo: { name: "acp-agent-stub", version: "0" },
    authMethods: [],
    _meta: scenario.steering === true ? { steering: { supported: true } } : {},
  };
}

function newSession(params: acp.NewSessionRequest): acp.NewSessionResponse {
  const report = env("STUB_CWD_REPORT");
  if (report !== undefined) reportCwd(params.cwd, report);
  const result: acp.NewSessionResponse = { sessionId: SESSION_ID };
  if (scenario.modes !== undefined && scenario.modes !== null) result.modes = scenario.modes;
  return result;
}

function setMode(params: acp.SetSessionModeRequest): acp.SetSessionModeResponse {
  modeSet = true;
  if (scenario.expectMode !== undefined && params.modeId !== scenario.expectMode) {
    violate(`set_mode: ${params.modeId}`);
  }
  return {};
}

/** One turn at a time per session, as ACP has it: an overlapping prompt is refused and recorded, never run. */
async function prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
  if (turnRunning) {
    violate("prompt while a turn runs");
    throw acp.RequestError.invalidRequest({ reason: "a turn is running" });
  }
  if (turnIndex === 0) {
    const copy = env("STUB_PROMPT_COPY");
    if (copy !== undefined) writeFileSync(copy, promptText(params.prompt));
    if (scenario.expectMode != null && !modeSet)
      violate(`set_mode: never called, expected ${scenario.expectMode}`);
  }
  const steps = nextTurn();
  if (steps === null) {
    violate(`prompt ${turnIndex}: the scenario has no turn for it`);
    return { stopReason: "end_turn" };
  }
  cancelled = false;
  return await runTurn(steps);
}

/** The pre-standard steering extension both real adapters ship: mid-turn input joins the running turn. */
function steer(params: SteerParams): { outcome: string; reason?: string } {
  if (scenario.steering !== true) {
    violate("method: _session/steering (not advertised)");
    throw new Error("steering is not advertised");
  }
  note(env("STUB_STEERS"), promptText(params.prompt));
  if (turnRunning) return { outcome: "injected" };
  if (params._meta?.steering?.idleBehavior === "promptRequired") {
    return { outcome: "promptRequired", reason: "noRunningTurn" };
  }
  const steps = nextTurn();
  if (steps === null) {
    violate(`steer ${turnIndex}: the scenario has no turn for it`);
    return { outcome: "failed" };
  }
  // The response arrives once the turn runs; its updates follow on their own, as the real adapter does it.
  cancelled = false;
  void runTurn(steps);
  return { outcome: "startedNewTurn" };
}

note(env("STUB_ARGS_LOG"), process.argv.slice(2).join(" "));
const pidFile = env("STUB_PID_FILE");
if (pidFile !== undefined) writeFileSync(pidFile, String(process.pid));

const connection = acp
  .agent({ name: "acp-agent-stub" })
  .onRequest(acp.methods.agent.initialize, initialize)
  .onRequest(acp.methods.agent.session.new, (ctx) => newSession(ctx.params))
  .onRequest(acp.methods.agent.session.setMode, (ctx) => setMode(ctx.params))
  .onRequest(acp.methods.agent.session.prompt, (ctx) => prompt(ctx.params))
  .onRequest(
    "_session/steering",
    (params) => params as SteerParams,
    (ctx) => steer(ctx.params),
  )
  .onNotification(acp.methods.agent.session.cancel, () => {
    cancelled = true;
  })
  .onRequest("*", (ctx) => {
    violate(`method: ${ctx.method}`);
    throw acp.RequestError.methodNotFound(ctx.method);
  })
  .connect(
    acp.ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );
client = connection.client;
await connection.closed;
process.exit(Number(env("STUB_EXIT") ?? "0"));
