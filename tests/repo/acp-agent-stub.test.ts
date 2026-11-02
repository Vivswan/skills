// What would drift silently without this: the fake ACP agent's JSON-RPC framing and field names
// against what @agentclientprotocol/sdk's client sends and reads. Every suite that drives an adapter
// through the stub (the reviewer launcher, the builder runner) trusts it to speak the protocol.
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { ROOT } from "../../scripts/lib.mts";
import { tempDirs } from "../helpers/temp-dirs";

const STUB = join(ROOT, "tests", "helpers", "acp-agent-stub.ts");
const temp = tempDirs();

const READ_ONLY = {
  modes: {
    currentModeId: "read-only",
    availableModes: [{ id: "read-only", name: "Read-only", description: "" }],
  },
  expectMode: "read-only",
};

interface Seen {
  updates: string[];
  permissions: string[];
}

/** A _session/steering request: mid-turn when `afterMs` is set (that long after the first prompt starts), else idle,
 * right after the prompt `afterPrompt` indexes (the last by default), followed by a wait of `settleMs` for the turn
 * the steer started. */
interface Steer {
  text: string;
  afterMs?: number;
  afterPrompt?: number;
  settleMs?: number;
  idleBehavior?: string;
}

/** One session against the stub through the SDK's client: the mode to set, the answer to every permission request,
 * the prompts in order, the steers, and two timings against the first prompt's start: `cancelAfterMs` sends
 * session/cancel, `overlapAfterMs` sends a second prompt and records how the stub answered it. */
interface DriveOptions {
  mode?: string;
  answer: string;
  prompts: string[];
  steers?: Steer[];
  cancelAfterMs?: number;
  overlapAfterMs?: number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The rows the assertions read: each update keyed on its tool call id and status with its text, or a message chunk's text. */
function describeUpdate(update: acp.SessionNotification["update"]): string {
  switch (update.sessionUpdate) {
    case "tool_call":
      return `tool_call ${update.toolCallId} ${update.status}`;
    case "tool_call_update": {
      const texts = (update.content ?? [])
        .map((block) =>
          block.type === "content" && block.content.type === "text" ? block.content.text : "",
        )
        .join("");
      return `tool_call_update ${update.toolCallId} ${update.status}${texts === "" ? "" : ` ${texts}`}`;
    }
    case "agent_message_chunk":
      return `message ${update.content.type === "text" ? update.content.text : update.content.type}`;
    default:
      return update.sessionUpdate;
  }
}

type Session = { ctx: acp.ClientContext; sessionId: string };

function sendPrompt(session: Session, text: string): Promise<acp.PromptResponse> {
  return session.ctx.request(acp.methods.agent.session.prompt, {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text }],
  }) as Promise<acp.PromptResponse>;
}

async function sendSteer(session: Session, entry: Steer): Promise<string> {
  const outcome = await session.ctx.request<{ outcome: string }>("_session/steering", {
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: entry.text }],
    _meta:
      entry.idleBehavior === undefined
        ? undefined
        : { steering: { idleBehavior: entry.idleBehavior } },
  });
  return outcome.outcome;
}

/** The actions timed against the first turn, each at its own offset from the prompt's start: the cancel, the overlapping prompt, the mid-turn steers. */
async function duringFirstTurn(
  session: Session,
  options: DriveOptions,
  out: { steered: string[]; overlap: string[] },
): Promise<void> {
  const actions: { at: number; run: () => Promise<void> }[] = [];
  if (options.cancelAfterMs !== undefined) {
    actions.push({
      at: options.cancelAfterMs,
      run: () =>
        session.ctx.notify(acp.methods.agent.session.cancel, { sessionId: session.sessionId }),
    });
  }
  if (options.overlapAfterMs !== undefined) {
    actions.push({
      at: options.overlapAfterMs,
      run: async () => {
        out.overlap.push(await sendPrompt(session, "overlap").then(() => "accepted", String));
      },
    });
  }
  for (const entry of options.steers ?? []) {
    if (entry.afterMs === undefined) continue;
    actions.push({
      at: entry.afterMs,
      run: async () => {
        out.steered.push(await sendSteer(session, entry));
      },
    });
  }
  let elapsed = 0;
  for (const action of actions.sort((a, b) => a.at - b.at)) {
    await wait(action.at - elapsed);
    elapsed = action.at;
    await action.run();
  }
}

async function runPrompts(
  session: Session,
  options: DriveOptions,
  out: { stops: string[]; steered: string[]; overlap: string[] },
): Promise<void> {
  const last = options.prompts.length - 1;
  for (const [index, text] of options.prompts.entries()) {
    const turn = sendPrompt(session, text);
    if (index === 0) await duringFirstTurn(session, options, out);
    out.stops.push((await turn).stopReason);
    const idle = (options.steers ?? []).filter(
      (candidate) => candidate.afterMs === undefined && (candidate.afterPrompt ?? last) === index,
    );
    for (const entry of idle) {
      out.steered.push(await sendSteer(session, entry));
      if (entry.settleMs !== undefined) await wait(entry.settleMs);
    }
  }
}

async function drive(
  scenario: object,
  options: DriveOptions,
): Promise<{
  seen: Seen;
  stops: string[];
  steered: string[];
  overlap: string[];
  dir: string;
  init: acp.InitializeResponse;
  session: acp.NewSessionResponse;
}> {
  const dir = temp.dir("acp-stub-test-");
  writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario));
  const child = spawn(process.execPath, [STUB], {
    cwd: dir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      STUB_SCENARIO: join(dir, "scenario.json"),
      STUB_VIOLATIONS: join(dir, "violations"),
      STUB_PERMISSIONS: join(dir, "permissions"),
      STUB_PROMPT_COPY: join(dir, "prompt"),
      STUB_STEERS: join(dir, "steers"),
    },
  });
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin as NodeJS.WritableStream),
    Readable.toWeb(child.stdout as NodeJS.ReadableStream) as ReadableStream<Uint8Array>,
  );
  const seen: Seen = { updates: [], permissions: [] };
  const stops: string[] = [];
  const steered: string[] = [];
  const overlap: string[] = [];
  let init: acp.InitializeResponse | undefined;
  let session: acp.NewSessionResponse | undefined;
  try {
    await acp
      .client({ name: "acp-stub-test" })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const params = ctx.params as acp.RequestPermissionRequest;
        seen.permissions.push(`${params.toolCall.kind}:${params.toolCall.title}`);
        return { outcome: { outcome: "selected", optionId: options.answer } };
      })
      .onNotification(acp.methods.client.session.update, async (ctx) => {
        const update = (ctx.params as acp.SessionNotification).update;
        seen.updates.push(describeUpdate(update));
      })
      .connectWith(stream, async (ctx) => {
        init = (await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {},
        })) as acp.InitializeResponse;
        const opened = (await ctx.request(acp.methods.agent.session.new, {
          cwd: dir,
          mcpServers: [],
        })) as acp.NewSessionResponse;
        session = opened;
        if (options.mode !== undefined) {
          await ctx.request(acp.methods.agent.session.setMode, {
            sessionId: opened.sessionId,
            modeId: options.mode,
          });
        }
        await runPrompts({ ctx, sessionId: opened.sessionId }, options, {
          stops,
          steered,
          overlap,
        });
        return opened;
      });
  } finally {
    child.kill();
  }
  if (init === undefined || session === undefined) throw new Error("the handshake never answered");
  return { seen, stops, steered, overlap, dir, init, session };
}

function fileOr(path: string, fallback: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : fallback;
}

describe("acp-agent-stub", () => {
  test("a scripted turn round-trips through the SDK client: the tool call, its permission request, the chunked message, the stop reason", async () => {
    const scenario = {
      ...READ_ONLY,
      turns: [
        [
          { type: "tool", title: "git diff", kind: "execute", permission: true, output: "ok" },
          { type: "message", text: '{"ok":true}', chunks: 2 },
          { type: "stop", reason: "end_turn" },
        ],
      ],
    };
    const { seen, stops, dir, init, session } = await drive(scenario, {
      mode: "read-only",
      answer: "allow_once",
      prompts: ["review this"],
    });
    expect(init.protocolVersion).toBe(acp.PROTOCOL_VERSION);
    expect(session.sessionId).not.toBe("");
    expect(session.modes?.currentModeId).toBe("read-only");
    expect(seen.updates).toEqual([
      "tool_call call-1 in_progress",
      "tool_call_update call-1 completed ok",
      'message {"ok":',
      "message true}",
    ]);
    expect(seen.permissions).toEqual(["execute:git diff"]);
    expect(stops).toEqual(["end_turn"]);
    expect(readFileSync(join(dir, "prompt"), "utf8")).toBe("review this");
    expect(JSON.parse(readFileSync(join(dir, "permissions"), "utf8"))).toEqual({
      title: "git diff",
      kind: "execute",
      chosen: "allow_once",
    });
    expect(fileOr(join(dir, "violations"), "")).toBe("");
  });

  test("a rejected permission ends the turn cancelled, a mode the scenario did not expect and a prompt past the script are violations", async () => {
    const scenario = {
      ...READ_ONLY,
      turns: [[{ type: "tool", title: "apply_patch", kind: "edit", permission: true }]],
    };
    const { seen, stops, dir } = await drive(scenario, {
      mode: "workspace-write",
      answer: "cancel",
      prompts: ["first", "second"],
    });
    expect(seen.updates).toEqual([
      "tool_call call-1 in_progress",
      "tool_call_update call-1 failed",
    ]);
    expect(stops).toEqual(["cancelled", "end_turn"]);
    expect(readFileSync(join(dir, "violations"), "utf8")).toBe(
      "set_mode: workspace-write\nprompt 2: the scenario has no turn for it\n",
    );
  });

  test("steering, when advertised: a steer during a turn is injected and recorded, an idle steer that asks for promptRequired starts nothing", async () => {
    const scenario = {
      steering: true,
      turns: [
        [
          { type: "sleep", ms: 400 },
          { type: "message", text: "done" },
          { type: "stop", reason: "end_turn" },
        ],
      ],
    };
    const { seen, stops, steered, dir, init } = await drive(scenario, {
      answer: "allow_once",
      prompts: ["go"],
      steers: [
        { text: "adjust the plan", afterMs: 150 },
        { text: "one more thing", idleBehavior: "promptRequired" },
      ],
    });
    expect((init._meta as { steering: { supported: boolean } }).steering.supported).toBe(true);
    expect(steered).toEqual(["injected", "promptRequired"]);
    expect(readFileSync(join(dir, "steers"), "utf8")).toBe("adjust the plan\none more thing\n");
    expect(seen.updates).toEqual(["message done"]);
    expect(stops).toEqual(["end_turn"]);
    expect(fileOr(join(dir, "violations"), "")).toBe("");
  });

  test("a cancel during the last step ends the turn cancelled, an idle steer right after it runs its script, tool-call ids count across the session, and a prompt during a turn is refused", async () => {
    const scenario = {
      steering: true,
      turns: [
        [{ type: "sleep", ms: 300 }],
        [
          { type: "tool", title: "git status", kind: "execute" },
          { type: "message", text: "second" },
        ],
        [
          { type: "tool", title: "cat notes.md", kind: "read" },
          { type: "message", text: "third" },
        ],
      ],
    };
    const { seen, stops, steered, overlap, dir } = await drive(scenario, {
      answer: "allow_once",
      prompts: ["first", "third"],
      cancelAfterMs: 100,
      overlapAfterMs: 50,
      steers: [{ text: "go on", afterPrompt: 0, settleMs: 300 }],
    });
    expect(overlap).toEqual(["RequestError: Invalid request"]);
    expect(stops).toEqual(["cancelled", "end_turn"]);
    expect(steered).toEqual(["startedNewTurn"]);
    expect(seen.updates).toEqual([
      "tool_call call-1 in_progress",
      "tool_call_update call-1 completed",
      "message second",
      "tool_call call-2 in_progress",
      "tool_call_update call-2 completed",
      "message third",
    ]);
    expect(readFileSync(join(dir, "violations"), "utf8")).toBe("prompt while a turn runs\n");
  });
});
