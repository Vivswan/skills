// The reviewer as an ACP session: the adapter spawned over stdio, one prompt, every session update
// and permission request written to the capture as one JSON line, and the turn's stop reason as the
// outcome. run-review.mts picks the adapter, the mode, the permission policy, and where it runs;
// verdict.mts reads the capture.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
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
import { Readable, Writable } from "node:stream";

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

function ensureBuilt(source: string): boolean {
  if (!source.endsWith(".mts")) return false;
  const { scripts, skill, built } = buildPaths(source);
  if (buildIsStale(scripts, skill, built) && !build(source, scripts, skill, built)) process.exit(2);
  const run = spawnSync("bun", [built, ...process.argv.slice(2)], { stdio: "inherit" });
  // A bundle killed by a signal has no status: die of the same signal.
  if (run.signal) process.kill(process.pid, run.signal);
  process.exitCode = run.status ?? 1;
  return true;
}

// Only the command builds; a test or a sibling importing this file must not.
if (import.meta.main && ensureBuilt(import.meta.path)) process.exit();

// Loaded below the guard: a static import is hoisted above it and would resolve on the source path.

const acp = await import("@agentclientprotocol/sdk");

/** What the policy judges: the tool call's kind, its title, and the paths it names. */
export interface ToolCallFacts {
  kind: string;
  title: string;
  locations: string[];
}

export type PermissionAnswer = "allow" | "deny";

export type PermissionPolicy = (toolCall: ToolCallFacts) => PermissionAnswer;

export interface AcpSession {
  /** The adapter binary on PATH. */
  adapter: string;

  /** The adapter's arguments. */
  args: string[];

  /** Where the adapter runs: the checkout, or the snapshot copy's twin of the cwd. */
  cwd: string | undefined;

  /** The adapter's environment; undefined inherits the launcher's. */
  env: NodeJS.ProcessEnv | undefined;

  /** The session mode the review needs, by the id the adapter advertises. */
  mode: string;

  /** The review prompt, the one user turn of the session. */
  prompt: string;

  /** Answers each permission request. */
  policy: PermissionPolicy;

  /** One JSON object per call, the capture verdict.mts reads. */
  capture: (line: Record<string, unknown>) => void;

  /** The adapter's stderr, chunk by chunk. */
  stderr: (chunk: Buffer) => void;
}

/** How the session ended: the turn's stop reason, or why no turn completed. */
export type AcpEnd = { kind: "stop"; stopReason: string } | { kind: "failed"; reason: string };

export interface AcpRun {
  child: ChildProcess;
  done: Promise<AcpEnd>;
}

type PermissionRequest = import("@agentclientprotocol/sdk").RequestPermissionRequest;
type PermissionResponse = import("@agentclientprotocol/sdk").RequestPermissionResponse;
type SessionNotification = import("@agentclientprotocol/sdk").SessionNotification;
type NewSessionResponse = import("@agentclientprotocol/sdk").NewSessionResponse;
type PromptResponse = import("@agentclientprotocol/sdk").PromptResponse;

/** The option that carries the policy's answer: the first allow_* or reject_* the adapter offers; with none, the
 * request is cancelled, which every adapter reads as a refusal. */
function chooseOption(
  request: PermissionRequest,
  answer: PermissionAnswer,
): PermissionResponse["outcome"] {
  const wanted =
    answer === "allow" ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const kind of wanted) {
    const option = request.options.find((candidate) => candidate.kind === kind);
    if (option !== undefined) return { outcome: "selected", optionId: option.optionId };
  }
  return { outcome: "cancelled" };
}

/** The facts a permission request carries, backed by the tool call's announcement when the request leaves a field
 * out (the SDK lets a request name the call by id alone). A kind no message gave is "other", which no policy allows. */
export function permissionFacts(
  toolCall: {
    toolCallId: string;
    kind?: string | null;
    title?: string | null;
    locations?: { path: string }[] | null;
  },
  announced: ReadonlyMap<string, ToolCallFacts>,
): ToolCallFacts {
  const earlier = announced.get(toolCall.toolCallId);
  const locations = toolCall.locations ?? null;
  return {
    kind: toolCall.kind ?? earlier?.kind ?? "other",
    title: toolCall.title ?? earlier?.title ?? "",
    locations:
      locations === null ? (earlier?.locations ?? []) : locations.map((location) => location.path),
  };
}

/** Remembers a tool call as its updates announce it, so a later permission request can be read against it. */
function announce(
  announced: Map<string, ToolCallFacts>,
  update: SessionNotification["update"],
): void {
  if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update") return;
  const earlier = announced.get(update.toolCallId);
  const locations = update.locations ?? null;
  announced.set(update.toolCallId, {
    kind: update.kind ?? earlier?.kind ?? "other",
    title: update.title ?? earlier?.title ?? "",
    locations:
      locations === null ? (earlier?.locations ?? []) : locations.map((location) => location.path),
  });
}

/** The adapter's modes as it advertised them on session/new; an adapter without modes offers none. */
function modeIds(opened: NewSessionResponse): string[] {
  return opened.modes?.availableModes.map((mode) => mode.id) ?? [];
}

/** Starts the adapter and runs one review turn against it. The child is the caller's to end once `done`
 * settles: the adapter idles after the turn, and a kill is how every review ends. */
export function startAcpSession(session: AcpSession): AcpRun {
  const child = spawn(session.adapter, session.args, {
    cwd: session.cwd,
    env: session.env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  child.stderr?.on("data", session.stderr);
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin as NodeJS.WritableStream),
    Readable.toWeb(child.stdout as NodeJS.ReadableStream) as ReadableStream<Uint8Array>,
  );

  const announced = new Map<string, ToolCallFacts>();
  const done: Promise<AcpEnd> = acp
    .client({ name: "rubber-duck-review" })
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => {
      const request = ctx.params as PermissionRequest;
      const facts = permissionFacts(request.toolCall, announced);
      const answer = session.policy(facts);
      const outcome = chooseOption(request, answer);
      session.capture({ event: "permission", ...facts, answer, outcome });
      return { outcome };
    })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const { update } = ctx.params as SessionNotification;
      announce(announced, update);
      session.capture({ event: "update", update });
    })
    .connectWith(stream, async (ctx): Promise<AcpEnd> => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const opened = (await ctx.request(acp.methods.agent.session.new, {
        cwd: session.cwd ?? process.cwd(),
        mcpServers: [],
      })) as NewSessionResponse;
      const modes = modeIds(opened);
      session.capture({ event: "session", sessionId: opened.sessionId, modes });
      if (!modes.includes(session.mode)) {
        const offered = modes.length === 0 ? "no modes" : modes.join(", ");
        return {
          kind: "failed",
          reason: `the adapter offers no ${session.mode} mode (${offered})`,
        };
      }
      if (opened.modes?.currentModeId !== session.mode) {
        await ctx.request(acp.methods.agent.session.setMode, {
          sessionId: opened.sessionId,
          modeId: session.mode,
        });
      }
      const response = (await ctx.request(acp.methods.agent.session.prompt, {
        sessionId: opened.sessionId,
        prompt: [{ type: "text", text: session.prompt }],
      })) as PromptResponse;
      session.capture({ event: "stop", stopReason: response.stopReason });
      return { kind: "stop", stopReason: response.stopReason };
    })
    .catch((error: unknown): AcpEnd => ({ kind: "failed", reason: reasonOf(error) }));

  return { child, done };
}

/** The adapter's stream closing mid-turn surfaces as the SDK's rejection; the text names the cause as far as it is known. */
function reasonOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `the ACP session failed: ${message}`;
}
