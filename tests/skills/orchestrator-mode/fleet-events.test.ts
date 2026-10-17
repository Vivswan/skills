import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../../../scripts/lib.mts";
import { git, park, scratchRepo } from "../../helpers/scratch-repo";
import {
  digest,
  type Program,
  Scenario,
  sessionEventsHarness,
} from "../../helpers/session-events-scenario";
import { sideBySide } from "../../helpers/skill-layout";

// Contract tests for the fleet source through the daemon: a session directory laid out the way
// Claude Code writes one, hand-written transcript lines with timestamps in the past so a wait ages
// without sleeping, a scratch git repository with two worktrees for the tree readings, and the
// daemon driven by `watch` and `poll`. An alert reaches the inbox as a message; a note reaches the
// events log alone, where `wait` and the rows below read it.

const { temp } = sessionEventsHarness();
const SCRIPT = join(ROOT, "skills", "orchestrator-mode", "scripts", "fleet-events.mts");
const PROGRAM: Program = { script: SCRIPT, source: "fleet-events", env: () => ({}) };
const SOURCE = "fleet-events";
const SESSION = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const A = "a1b2c3d4e5f60718";
const B = "b2c3d4e5f6071829";
const C = "c3d4e5f607182930";
const D = "d4e5f60718293041";
const E = "e5f6071829304152";
const F = "f60718293041526a";
const MARKER = "MARKER-sunflower-9c1d";
const GIT_TIMEOUT = 60_000;
const TRACKS = { "wt-a": "track-a", "wt-b": "track-b" };
const TWO_MINUTES_MS = 120_000;
const HOUR_MS = 3_600_000;
// In minutes, what `ago` takes: a transcript from a session days old.
const FOUR_DAYS = 4 * 24 * 60;

type Line = Record<string, unknown>;

let uuid = 0;

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function envelope(type: string, timestamp: string, agentId: string | null): Line {
  uuid += 1;
  const line: Line = {
    type,
    uuid: `u${uuid}`,
    parentUuid: uuid > 1 ? `u${uuid - 1}` : null,
    timestamp,
    sessionId: SESSION,
    cwd: "/home/user/repo",
    gitBranch: "feat/example",
  };
  if (agentId !== null) {
    line.agentId = agentId;
    line.isSidechain = true;
  }
  return line;
}

function toolUse(
  timestamp: string,
  id: string,
  name: string,
  input: Line,
  agentId: string | null = A,
): Line {
  return {
    ...envelope("assistant", timestamp, agentId),
    message: {
      id: `msg_${id}`,
      role: "assistant",
      content: [{ type: "tool_use", id, name, input }],
      stop_reason: "tool_use",
    },
    apiBlockIndex: 0,
  };
}

function said(timestamp: string, stopReason: string | null, agentId: string | null = A): Line {
  return {
    ...envelope("assistant", timestamp, agentId),
    message: {
      id: "msg_text",
      role: "assistant",
      content: [{ type: stopReason === null ? "thinking" : "text", text: "done" }],
      stop_reason: stopReason,
    },
    apiBlockIndex: 0,
  };
}

function toolResult(
  timestamp: string,
  toolUseId: string,
  options: { content?: unknown; toolUseResult?: unknown; agentId?: string | null } = {},
): Line {
  return {
    ...envelope("user", timestamp, options.agentId === undefined ? A : options.agentId),
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: options.content ?? "ok" }],
    },
    toolUseResult: options.toolUseResult ?? { stdout: "ok", stderr: "" },
  };
}

function userText(timestamp: string, text: string, agentId: string | null = A): Line {
  return { ...envelope("user", timestamp, agentId), message: { role: "user", content: text } };
}

function attachment(timestamp: string, body: Line, agentId: string | null = A): Line {
  return { ...envelope("attachment", timestamp, agentId), attachment: body };
}

function notice(taskId: string, status = "completed"): string {
  return `<task-notification>\n<task-id>${taskId}</task-id>\n<status>${status}</status>\n<summary>the task finished</summary>\n</task-notification>`;
}

/** A teammate's idle notification as the lead's transcript carries it. */
function idle(name: string): string {
  return `<teammate-message teammate_id="${name}" summary="idle">\n{"type":"idle_notification","agent":"${name}"}\n</teammate-message>`;
}

/** A finished exchange: a Bash call and its result, both at `timestamp`. */
function exchange(timestamp: string, id: string, agentId: string = A): Line[] {
  return [
    toolUse(timestamp, id, "Bash", { command: "bun test" }, agentId),
    toolResult(timestamp, id, { agentId }),
  ];
}

/** A Bash call still pending since `timestamp`, with the call's own timeout when given. */
function pendingBash(timestamp: string, id: string, agentId: string, timeout?: number): Line {
  const input: Line = { command: "bun run check" };
  if (timeout !== undefined) input.timeout = timeout;
  return toolUse(timestamp, id, "Bash", input, agentId);
}

interface SessionDir {
  dir: string;
  subagents: string;
  sessionFile: string;
}

/** A session directory as Claude Code lays one out: <root>/<sessionId>/subagents/ and <root>/<sessionId>.jsonl beside it. */
function sessionDir(root: string): SessionDir {
  const dir = join(root, SESSION);
  const subagents = join(dir, "subagents");
  mkdirSync(subagents, { recursive: true });
  const sessionFile = join(root, `${SESSION}.jsonl`);
  writeFileSync(sessionFile, "");
  return { dir, subagents, sessionFile };
}

/** Appends the lines and sets the file's mtime to the newest of them, as a file last written then would carry. */
function appendLines(path: string, lines: Line[]): void {
  appendFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  const newest = Math.max(...lines.map((line) => Date.parse(line.timestamp as string)));
  utimesSync(path, new Date(newest), new Date(newest));
}

function writeAgent(session: SessionDir, agentId: string, meta: Line, lines: Line[]): string {
  writeFileSync(join(session.subagents, `agent-${agentId}.meta.json`), JSON.stringify(meta));
  const path = join(session.subagents, `agent-${agentId}.jsonl`);
  writeFileSync(path, "");
  appendLines(path, lines);
  return path;
}

function fileUrl(path: string): string {
  return pathToFileURL(path).href;
}

/** The lead's transcript lines spawning a named teammate whose result carries the agent id. */
function spawnLines(id: string, name: string, agentId: string, timestamp = ago(30)): Line[] {
  return [
    toolUse(
      timestamp,
      id,
      "Agent",
      { name, description: "build", subagent_type: "general-purpose", prompt: "build" },
      null,
    ),
    toolResult(timestamp, id, {
      toolUseResult: { status: "teammate_spawned", agentId, name },
      agentId: null,
    }),
  ];
}

/** The harness's temp root the watch is told about, and the tasks directory it lays out under it for this session. */
function claudeTmp(s: Scenario): { root: string; tasks: string } {
  const root = join(s.fixtureDir, "claude-tmp");
  return { root, tasks: join(root, basename(s.fixtureDir), SESSION, "tasks") };
}

/** `watch` of the session directory with the harness temp root set, so a job's output file is found under the fixture. */
function watch(s: Scenario, inbox: string, session: SessionDir, ...flags: string[]): void {
  const result = s.run(["watch", session.dir, ...flags], {
    inbox,
    env: { CLAUDE_CODE_TMPDIR: claudeTmp(s).root },
  });
  expect(result.code).toBe(0);
}

/** The saved target as JSON holds it: the maps a test rewrites into an older version's shape. */
interface PersistedTarget {
  polls: number;
  subagentsListed?: boolean;
  tasksDir?: string;
  lead: { cursor: Record<string, unknown>; state: Record<string, unknown> };
  agents: Record<string, Record<string, unknown> & { state: Record<string, unknown> }>;
  worktrees: Record<string, Record<string, unknown>>;
  trouble: Record<string, unknown>;
}

function persistedTarget(s: Scenario): PersistedTarget {
  const targets = Object.values(s.state().targets);
  expect(targets).toHaveLength(1);
  return targets[0] as PersistedTarget;
}

/** Rewrites the one saved target in place while the daemon is stopped. */
function rewriteState(s: Scenario, mutate: (target: PersistedTarget) => void): void {
  const state = s.state();
  for (const target of Object.values(state.targets as Record<string, PersistedTarget>))
    mutate(target);
  writeFileSync(s.files().state, JSON.stringify(state));
}

function polled(s: Scenario, inbox: string): number {
  const result = s.run(["poll"], { inbox });
  expect(result.code).toBe(0);
  return Number(/polled; (\d+) event\(s\)/.exec(result.stdout)?.[1]);
}

/** Every event as the log holds it: its level, its text, and its URL. */
function rows(s: Scenario): Array<[string, string, string]> {
  return s.events().map((event) => [event.level as string, event.text, event.url as string]);
}

/** The texts the inbox received, one array per frame. */
async function delivered(box: { frames: (n: number) => Promise<string[]> }, n: number) {
  const frames = await box.frames(n);
  return frames.map((frame) =>
    digest(frame, SOURCE)
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("agent ") || line.startsWith("worktree ") || line.startsWith("fleet: "),
      ),
  );
}

/** The `summary` lines `status` prints under the one target. */
function standing(s: Scenario, inbox: string): string[] {
  const out = s.run(["status"], { inbox }).stdout.split("\n");
  return out.filter((line) => line.startsWith("    ")).map((line) => line.slice(4));
}

describe("fleet-events.mts", () => {
  test("a usage mistake (a relative or missing target, an unknown flag, --base, a bad --quiet-after, a bad --repo) exits 2 before any poll; " +
    "the first poll says nothing for an agent within every bound; an agent first seen later with a call past the bound is started and stuck in one poll, " +
    "the message carries the alert alone, wait shows both, and status lists the alert", async () => {
    const s = new Scenario(PROGRAM, "base");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    writeAgent(
      session,
      A,
      { name: "builder-a", description: "build it", agentType: "general-purpose" },
      [...exchange(ago(0), "toolu_01")],
    );
    await s.start({ inbox: box.path });
    for (const [args, reason] of [
      [["watch", "relative/dir"], "target must be session or an absolute path"],
      [["watch", join(s.fixtureDir, "missing")], "not a directory"],
      [["watch", session.dir, "--follow"], "unknown option: --follow"],
      [["watch", session.dir, "--base", "main"], "unknown option: --base"],
      [["watch", session.dir, "--notes"], "unknown option: --notes"],
      [
        ["watch", session.dir, "--quiet-after", "0"],
        "--quiet-after must be a positive whole number",
      ],
      [
        ["watch", session.dir, "--quiet-after", "soon"],
        "--quiet-after must be a positive whole number",
      ],
      [["watch", session.dir, "--repo", "repo"], "--repo must be an absolute path"],
      [["watch", session.dir, "--repo"], "--repo needs a value"],
    ] as Array<[string[], string]>) {
      const r = s.run(args, { inbox: box.path });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(reason);
    }
    expect(s.events()).toEqual([]);

    const watched = s.run(["watch", session.dir, "--quiet-after", "1"], { inbox: box.path });
    expect(watched.code).toBe(0);
    expect(watched.stdout).toContain(`watching ${session.dir} for session`);
    expect(polled(s, box.path)).toBe(0);
    expect(s.events()).toEqual([]);

    // The new agent arrives already stuck: one poll says it started (a note) and that it is stuck
    // (an alert); the next says nothing, since the alert holds and its duration has not doubled.
    const pathB = writeAgent(
      session,
      B,
      { description: "review the source", agentType: "Explore" },
      [pendingBash(ago(35), "toolu_02", B)],
    );
    expect(polled(s, box.path)).toBe(2);
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      ["note", "agent review the source: started", fileUrl(pathB)],
      ["alert", "agent review the source: stuck 35 min on Bash", fileUrl(pathB)],
    ]);
    expect(s.events().map((event) => [event.kind, event.agentId])).toEqual([
      ["agent", B],
      ["agent", B],
    ]);
    expect(await delivered(box, 1)).toEqual([["agent review the source: stuck 35 min on Bash"]]);
    const all = s.run(["wait", "--since", "0", "--timeout", "1"], { inbox: box.path });
    expect(all.code).toBe(0);
    expect(all.stdout.trim().split("\n")).toHaveLength(3);
    expect(standing(s, box.path)).toEqual(["agent review the source: stuck 35 min on Bash"]);
    expect(s.run(["--help"], { inbox: box.path })).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(/^usage: fleet-events\.mts/),
    });
    s.stop({ inbox: box.path });
  }, 30000);

  test("a pending call is stuck past its own timeout plus ten minutes, and past thirty with no timeout of its own; the result landing is fine again, a note that sends no message", async () => {
    const s = new Scenario(PROGRAM, "stuck");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const pathA = writeAgent(session, A, { name: "builder-a", description: "build" }, [
      ...exchange(ago(20), "toolu_a0"),
      pendingBash(ago(13), "toolu_a1", A, TWO_MINUTES_MS),
    ]);
    const pathB = writeAgent(session, B, { name: "builder-b", description: "build" }, [
      ...exchange(ago(20), "toolu_b0", B),
      pendingBash(ago(13), "toolu_b1", B),
    ]);
    const pathC = writeAgent(session, C, { name: "builder-c", description: "build" }, [
      ...exchange(ago(40), "toolu_c0", C),
      pendingBash(ago(31), "toolu_c1", C),
    ]);
    const pathD = writeAgent(session, D, { name: "builder-d", description: "build" }, [
      ...exchange(ago(20), "toolu_d0", D),
      pendingBash(ago(11), "toolu_d1", D, TWO_MINUTES_MS),
    ]);
    await s.start({ inbox: box.path });
    watch(s, box.path, session);
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      ["alert", "agent builder-a: stuck 13 min on Bash", fileUrl(pathA)],
      ["alert", "agent builder-c: stuck 31 min on Bash", fileUrl(pathC)],
    ]);
    expect(await delivered(box, 1)).toEqual([
      ["agent builder-a: stuck 13 min on Bash", "agent builder-c: stuck 31 min on Bash"],
    ]);

    appendLines(pathA, [toolResult(ago(0), "toolu_a1")]);
    appendLines(pathB, [toolResult(ago(0), "toolu_b1", { agentId: B })]);
    appendLines(pathD, [toolResult(ago(0), "toolu_d1", { agentId: D })]);
    expect(polled(s, box.path)).toBe(1);
    expect(rows(s).slice(2)).toEqual([["note", "agent builder-a: fine again", fileUrl(pathA)]]);
    // The control: the next frame is still the first; the note sent nothing.
    expect(await delivered(box, 2)).toHaveLength(1);
    expect(s.state().targets[session.dir]).toMatchObject({
      form: "dir",
      quietAfterMinutes: 10,
      polls: 3,
      agents: {
        [A]: { said: null },
        [C]: { said: { level: "alert", key: "tool:toolu_c1", duration: 31, repeats: 0 } },
      },
    });
    s.stop({ inbox: box.path });
  }, 30000);

  test("a background job is a wait while it runs; one whose output file ends with the harness's exit line and has no notice in the transcript is stranded, at once; " +
    "the notice is fine again, as a user string in one agent and as a queued_command attachment in another", async () => {
    const s = new Scenario(PROGRAM, "jobs");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const { tasks } = claudeTmp(s);
    mkdirSync(tasks, { recursive: true });
    const launched = (agentId: string, taskId: string): Line[] => [
      toolUse(
        ago(6),
        "toolu_bg",
        "Bash",
        { command: "bun run check", run_in_background: true },
        agentId,
      ),
      toolResult(ago(6), "toolu_bg", { toolUseResult: { backgroundTaskId: taskId }, agentId }),
      said(ago(6), "end_turn", agentId),
    ];
    const pathA = writeAgent(session, A, { name: "builder-a", description: "build" }, [
      ...exchange(ago(9), "toolu_a0", A),
      ...launched(A, "b1a2b3c4d"),
    ]);
    const pathB = writeAgent(session, B, { name: "builder-b", description: "build" }, [
      ...exchange(ago(9), "toolu_b0", B),
      ...launched(B, "b9z8y7x6w"),
    ]);
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    expect(polled(s, box.path)).toBe(0);
    expect(persistedTarget(s).tasksDir).toBe(tasks);

    // A's output ended; B's is still being written (no exit line yet).
    writeFileSync(
      join(tasks, "b1a2b3c4d.output"),
      "checking...\nall green\n[exited with code 0]\n",
    );
    writeFileSync(join(tasks, "b9z8y7x6w.output"), "checking...\n");
    expect(polled(s, box.path)).toBe(1);
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      ["alert", "agent builder-a: stranded, job b1a2b3c4d ended with no notice", fileUrl(pathA)],
    ]);

    appendLines(pathA, [userText(ago(0), notice("b1a2b3c4d"))]);
    writeFileSync(join(tasks, "b9z8y7x6w.output"), "checking...\n[exited with code 1]\n");
    appendLines(pathB, [
      attachment(
        ago(0),
        {
          type: "queued_command",
          commandMode: "task-notification",
          prompt: notice("b9z8y7x6w", "failed"),
        },
        B,
      ),
    ]);
    expect(polled(s, box.path)).toBe(1);
    expect(rows(s).slice(1)).toEqual([["note", "agent builder-a: fine again", fileUrl(pathA)]]);
    expect(await delivered(box, 1)).toEqual([
      ["agent builder-a: stranded, job b1a2b3c4d ended with no notice"],
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a child still for thirty minutes is stuck on agent, a foreground one joined through its sidecar toolUseId and a background one through its agentId, " +
    "naming the child and its last move; a moving child is never stuck, and the child moving again is fine again", async () => {
    const s = new Scenario(PROGRAM, "kids");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const pathA = writeAgent(session, A, { name: "builder-a", description: "build" }, [
      ...exchange(ago(50), "toolu_a0", A),
      toolUse(ago(45), "toolu_fg", "Agent", {
        description: "scout the repo",
        subagent_type: "Explore",
        prompt: "look",
      }),
    ]);
    const pathC = writeAgent(
      session,
      C,
      {
        description: "scout the repo",
        agentType: "Explore",
        toolUseId: "toolu_fg",
        parentAgentId: A,
      },
      [pendingBash(ago(35), "toolu_c1", C, HOUR_MS)],
    );
    const pathB = writeAgent(session, B, { name: "builder-b", description: "build" }, [
      ...exchange(ago(50), "toolu_b0", B),
      toolUse(
        ago(45),
        "toolu_bg",
        "Agent",
        {
          name: "runner",
          description: "run it",
          subagent_type: "general-purpose",
          prompt: "run",
          run_in_background: true,
        },
        B,
      ),
      toolResult(ago(45), "toolu_bg", {
        toolUseResult: { status: "async_launched", agentId: D },
        agentId: B,
      }),
      said(ago(45), "end_turn", B),
    ]);
    writeAgent(
      session,
      D,
      { name: "runner", description: "run it", parentAgentId: B },
      exchange(ago(0), "toolu_d1", D),
    );
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      [
        "alert",
        "agent builder-a: stuck on agent scout the repo, scout the repo last moved 35 min ago",
        fileUrl(pathA),
      ],
    ]);

    // D goes still, C moves: B is stuck on its runner, A is fine again.
    const stillD = join(session.subagents, `agent-${D}.jsonl`);
    writeFileSync(stillD, "");
    appendLines(stillD, [pendingBash(ago(40), "toolu_d0", D, HOUR_MS)]);
    appendLines(pathC, [toolResult(ago(0), "toolu_c1", { agentId: C })]);
    expect(polled(s, box.path)).toBe(2);
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s).slice(1)).toEqual([
      ["note", "agent builder-a: fine again", fileUrl(pathA)],
      [
        "alert",
        "agent builder-b: stuck on agent runner, runner last moved 40 min ago",
        fileUrl(pathB),
      ],
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a judgment that rests on an agent whose read failed this poll is held: a parent whose call lands while its still child's sidecar is unreadable " +
    "says nothing from the child's stale reading, and a child whose turn ends while its parent's read fails says nothing of it; the next readable poll judges both afresh", async () => {
    const s = new Scenario(PROGRAM, "unread");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    // B waits on a long command while its background child D stands still past the bound.
    const pathB = writeAgent(session, B, { name: "builder-b", description: "build" }, [
      ...exchange(ago(60), "toolu_b0", B),
      toolUse(
        ago(50),
        "toolu_bg",
        "Agent",
        {
          name: "runner",
          description: "run it",
          subagent_type: "general-purpose",
          prompt: "run",
          run_in_background: true,
        },
        B,
      ),
      toolResult(ago(50), "toolu_bg", {
        toolUseResult: { status: "async_launched", agentId: D },
        agentId: B,
      }),
      pendingBash(ago(5), "toolu_b1", B, HOUR_MS),
    ]);
    const pathD = writeAgent(
      session,
      D,
      { name: "runner", description: "run it", parentAgentId: B },
      [pendingBash(ago(40), "toolu_d0", D, HOUR_MS)],
    );
    const sidecarD = join(session.subagents, `agent-${D}.meta.json`);
    // A spawned E, which waits on a long command; A's map keeps it running.
    const pathA = writeAgent(session, A, { name: "builder-a", description: "build" }, [
      ...exchange(ago(30), "toolu_a0", A),
      toolUse(
        ago(20),
        "toolu_spawn_e",
        "Agent",
        { description: "scout", subagent_type: "Explore", prompt: "look", run_in_background: true },
        A,
      ),
      toolResult(ago(20), "toolu_spawn_e", {
        toolUseResult: { status: "async_launched", agentId: E },
        agentId: A,
      }),
      pendingBash(ago(10), "toolu_a1", A, HOUR_MS),
    ]);
    const pathE = writeAgent(session, E, { description: "scout", parentAgentId: A }, [
      ...exchange(ago(20), "toolu_e0", E),
      pendingBash(ago(20), "toolu_e1", E, HOUR_MS),
    ]);
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    expect(s.events()).toEqual([]);

    // B's call lands while D's sidecar is unreadable, and E's turn ends while A's transcript is
    // unreadable: a daemon judging from the stale cache would say B stuck on D (still 40 min) and
    // E ended with no signal; both are held.
    appendLines(pathB, [toolResult(ago(0), "toolu_b1", { agentId: B })]);
    appendLines(pathE, [
      toolResult(ago(6), "toolu_e1", { agentId: E }),
      said(ago(6), "end_turn", E),
    ]);
    writeFileSync(sidecarD, "{");
    rmSync(pathA);
    mkdirSync(pathA);
    expect(polled(s, box.path)).toBe(2);
    expect(rows(s).map((row) => [row[0], row[1]])).toEqual([
      ["alert", `fleet: cannot read agent-${A}.jsonl: ${pathA} is not a regular file`],
      ["alert", `fleet: cannot read agent-${D}.meta.json: ${sidecarD} is not a JSON object`],
    ]);
    expect(s.state().targets[session.dir]).toMatchObject({
      agents: { [B]: { said: null }, [E]: { said: null } },
    });

    // Both readable again, D having moved: B is fine with nothing to retract, E's ended turn is
    // judged against A's map and alerts.
    writeFileSync(
      sidecarD,
      JSON.stringify({ name: "runner", description: "run it", parentAgentId: B }),
    );
    appendLines(pathD, [toolResult(ago(0), "toolu_d0", { agentId: D })]);
    rmSync(pathA, { recursive: true });
    writeFileSync(pathA, "");
    appendLines(pathA, [
      ...exchange(ago(30), "toolu_a0", A),
      pendingBash(ago(10), "toolu_a1", A, HOUR_MS),
    ]);
    expect(polled(s, box.path)).toBe(3);
    expect(rows(s).slice(2)).toEqual([
      ["note", "fleet: reading restored", fileUrl(pathA)],
      ["note", "fleet: reading restored", fileUrl(sidecarD)],
      ["alert", "agent scout: ended 6 min ago, no signal reached the lead", fileUrl(pathE)],
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("an ended turn past the grace is a note when the one waiting on the agent has its signal (a teammate's idle notification, a one-shot child's notice) " +
    "and an alert when it does not, or when nobody the fleet read spawned it; a stop is a note; a stall past --quiet-after is an alert; " +
    "each note once, and status lists the alerts", async () => {
    const s = new Scenario(PROGRAM, "ends");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const ended = (agentId: string): Line[] => [
      ...exchange(ago(20), `toolu_${agentId.slice(0, 4)}`, agentId),
      said(ago(7), "end_turn", agentId),
    ];
    const pathA = writeAgent(session, A, { name: "builder-a", description: "build" }, ended(A));
    const pathB = writeAgent(session, B, { name: "builder-b", description: "build" }, [
      ...exchange(ago(20), "toolu_b0", B),
      said(ago(5), null, B),
    ]);
    const pathC = writeAgent(session, C, { name: "builder-c", description: "build" }, [
      ...exchange(ago(20), "toolu_c0", C),
      said(ago(5), null, C),
    ]);
    const pathD = writeAgent(
      session,
      D,
      { description: "run it", parentAgentId: SESSION },
      ended(D),
    );
    const pathE = writeAgent(
      session,
      E,
      { description: "review it", parentAgentId: "0000000000000000" },
      ended(E),
    );
    // The lead's own file: builder-a spawned and idle, builder-b spawned and stopped, D launched
    // in the background with no notice yet.
    appendLines(session.sessionFile, [
      ...spawnLines("toolu_spawn_a", "builder-a", A),
      ...spawnLines("toolu_spawn_b", "builder-b", B),
      toolUse(
        ago(30),
        "toolu_spawn_d",
        "Agent",
        {
          description: "run it",
          subagent_type: "general-purpose",
          prompt: "run",
          run_in_background: true,
        },
        null,
      ),
      toolResult(ago(30), "toolu_spawn_d", {
        toolUseResult: { status: "async_launched", agentId: D },
        agentId: null,
      }),
      userText(ago(6), idle("builder-a"), null),
      toolUse(ago(2), "toolu_stop", "TaskStop", { task_id: "builder-b" }, null),
      toolResult(ago(2), "toolu_stop", { agentId: null }),
    ]);
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      ["note", "agent builder-a: ended 7 min ago, report received", fileUrl(pathA)],
      ["note", "agent builder-b: stopped by the lead", fileUrl(pathB)],
      ["alert", "agent builder-c: stuck 5 min mid-turn, nothing pending", fileUrl(pathC)],
      ["alert", "agent run it: ended 7 min ago, no signal reached the lead", fileUrl(pathD)],
      ["alert", "agent review it: ended 7 min ago, no signal reached the lead", fileUrl(pathE)],
    ]);
    expect(await delivered(box, 1)).toEqual([
      [
        "agent builder-c: stuck 5 min mid-turn, nothing pending",
        "agent run it: ended 7 min ago, no signal reached the lead",
        "agent review it: ended 7 min ago, no signal reached the lead",
      ],
    ]);
    expect(standing(s, box.path)).toEqual([
      "agent builder-c: stuck 5 min mid-turn, nothing pending",
      "agent run it: ended 7 min ago, no signal reached the lead",
      "agent review it: ended 7 min ago, no signal reached the lead",
    ]);
    // D's notice reaches the lead: fine again is not said for an ended turn, the note is.
    appendLines(session.sessionFile, [userText(ago(0), notice(D), null)]);
    expect(polled(s, box.path)).toBe(1);
    expect(rows(s).slice(5)).toEqual([
      ["note", "agent run it: ended 7 min ago, report received", fileUrl(pathD)],
    ]);
    expect(polled(s, box.path)).toBe(0);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a foreground child's signal is its result closing the parent's call: ended past the grace with the call answered is a note, with the call still pending an alert; the parent whose idle notification the lead holds is a note", async () => {
    const s = new Scenario(PROGRAM, "foreground");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const spawnCall = (id: string, agentId: string): Line =>
      toolUse(
        ago(20),
        id,
        "Agent",
        { description: "scout", subagent_type: "Explore", prompt: "look" },
        agentId,
      );
    const pathA = writeAgent(session, A, { name: "builder-a", description: "build" }, [
      ...exchange(ago(30), "toolu_a0", A),
      spawnCall("toolu_fg1", A),
      toolResult(ago(6), "toolu_fg1", { agentId: A }),
      said(ago(6), "end_turn", A),
    ]);
    const pathC = writeAgent(
      session,
      C,
      { description: "scout one", agentType: "Explore", toolUseId: "toolu_fg1", parentAgentId: A },
      [...exchange(ago(20), "toolu_c0", C), said(ago(7), "end_turn", C)],
    );
    writeAgent(session, B, { name: "builder-b", description: "build" }, [
      ...exchange(ago(30), "toolu_b0", B),
      spawnCall("toolu_fg2", B),
    ]);
    const pathD = writeAgent(
      session,
      D,
      { description: "scout two", agentType: "Explore", toolUseId: "toolu_fg2", parentAgentId: B },
      [...exchange(ago(20), "toolu_d0", D), said(ago(7), "end_turn", D)],
    );
    appendLines(session.sessionFile, [
      ...spawnLines("toolu_spawn_a", "builder-a", A),
      ...spawnLines("toolu_spawn_b", "builder-b", B),
      userText(ago(5), idle("builder-a"), null),
    ]);
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      ["note", "agent builder-a: ended 6 min ago, report received", fileUrl(pathA)],
      ["note", "agent scout one: ended 7 min ago, report received", fileUrl(pathC)],
      ["alert", "agent scout two: ended 7 min ago, no signal reached the lead", fileUrl(pathD)],
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a new child whose sidecar reads but whose transcript does not is found by the parent's Agent call through the poll's failed reads, and the parent is held: " +
    "the trouble alert is the poll's only line, and the next readable poll says the child started and judges the parent afresh; a parent already stuck on a childless call " +
    "keeps its alert while the child it gains reads badly, and is fine again once it reads; the control child reads at once and its parent is never stuck", async () => {
    const s = new Scenario(PROGRAM, "firstread");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const call = (agentId: string, id: string): Line[] => [
      ...exchange(ago(50), `toolu_${agentId.slice(0, 4)}`, agentId),
      toolUse(
        ago(45),
        id,
        "Agent",
        { description: "scout", subagent_type: "Explore", prompt: "look" },
        agentId,
      ),
    ];
    writeAgent(session, A, { name: "builder-a", description: "build" }, call(A, "toolu_fg1"));
    writeAgent(session, B, { name: "builder-b", description: "build" }, call(B, "toolu_fg2"));
    // E's call has no child listed yet: stuck on Agent, rightly, until a child appears.
    const pathE = writeAgent(
      session,
      E,
      { name: "builder-e", description: "build" },
      call(E, "toolu_fg3"),
    );
    // C: sidecar readable, transcript a directory. D: the control, readable and moving.
    const pathC = writeAgent(
      session,
      C,
      { description: "scout one", agentType: "Explore", toolUseId: "toolu_fg1", parentAgentId: A },
      exchange(ago(0), "toolu_c0", C),
    );
    rmSync(pathC);
    mkdirSync(pathC);
    writeAgent(
      session,
      D,
      { description: "scout two", agentType: "Explore", toolUseId: "toolu_fg2", parentAgentId: B },
      exchange(ago(0), "toolu_d0", D),
    );
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    expect(rows(s)).toEqual([
      [
        "alert",
        `fleet: cannot read agent-${C}.jsonl: ${pathC} is not a regular file`,
        fileUrl(pathC),
      ],
      ["alert", "agent builder-e: stuck 45 min on Agent", fileUrl(pathE)],
    ]);
    // Nothing is saved for the unread child: the failed read stays no observation.
    const saved = s.state().targets[session.dir] as { agents: Record<string, { said: unknown }> };
    expect(Object.keys(saved.agents).sort()).toEqual([A, B, D, E].sort());
    expect([saved.agents[A]?.said, saved.agents[B]?.said]).toEqual([null, null]);

    // C reads; E gains a child F whose transcript reads badly: E's alert is held, not retracted.
    rmSync(pathC, { recursive: true });
    writeFileSync(pathC, "");
    appendLines(pathC, exchange(ago(0), "toolu_c1", C));
    const pathF = writeAgent(
      session,
      F,
      {
        description: "scout three",
        agentType: "Explore",
        toolUseId: "toolu_fg3",
        parentAgentId: E,
      },
      exchange(ago(0), "toolu_f0", F),
    );
    rmSync(pathF);
    mkdirSync(pathF);
    expect(polled(s, box.path)).toBe(3);
    expect(rows(s).slice(2)).toEqual([
      [
        "alert",
        `fleet: cannot read agent-${F}.jsonl: ${pathF} is not a regular file`,
        fileUrl(pathF),
      ],
      ["note", "fleet: reading restored", fileUrl(pathC)],
      ["note", "agent scout one: started", fileUrl(pathC)],
    ]);
    expect(s.state().targets[session.dir]).toMatchObject({
      agents: { [A]: { said: null }, [E]: { said: { level: "alert", key: "tool:toolu_fg3" } } },
    });

    // F reads and moves: E is fine again.
    rmSync(pathF, { recursive: true });
    writeFileSync(pathF, "");
    appendLines(pathF, exchange(ago(0), "toolu_f1", F));
    expect(polled(s, box.path)).toBe(3);
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s).slice(5)).toEqual([
      ["note", "fleet: reading restored", fileUrl(pathF)],
      ["note", "agent scout three: started", fileUrl(pathF)],
      ["note", "agent builder-e: fine again", fileUrl(pathE)],
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("the first poll says what stands, however old: a turn ended long before the watch is a note or an alert by whether its signal arrived, said once; an agent that moves after it says nothing more", async () => {
    const s = new Scenario(PROGRAM, "old");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const endedAt = ago(1222);
    const finished = (agentId: string): Line[] => [
      ...exchange(endedAt, `toolu_${agentId.slice(0, 4)}`, agentId),
      said(endedAt, "end_turn", agentId),
    ];
    const pathA = writeAgent(session, A, { name: "scout-a", description: "explore" }, finished(A));
    const pathB = writeAgent(session, B, { name: "scout-b", description: "explore" }, finished(B));
    appendLines(session.sessionFile, [
      ...spawnLines("toolu_spawn_a", "scout-a", A, ago(1300)),
      ...spawnLines("toolu_spawn_b", "scout-b", B, ago(1300)),
      userText(ago(1220), idle("scout-a"), null),
    ]);
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    expect(rows(s)).toEqual([
      ["note", "agent scout-a: ended 1222 min ago, report received", fileUrl(pathA)],
      ["alert", "agent scout-b: ended 1222 min ago, no signal reached the lead", fileUrl(pathB)],
    ]);
    expect(polled(s, box.path)).toBe(0);
    expect(s.state().targets[session.dir]).toMatchObject({
      agents: {
        [A]: { said: { level: "note", key: `ended:${endedAt}` } },
        [B]: { said: { level: "alert", key: `ended:${endedAt}`, duration: null, repeats: 0 } },
      },
    });

    appendLines(pathA, exchange(ago(0), "toolu_a9", A));
    expect(polled(s, box.path)).toBe(0);
    expect(s.state().targets[session.dir]).toMatchObject({
      agents: { [A]: { said: null } },
    });
    s.stop({ inbox: box.path });
  }, 30000);

  test("a stillness already older than a day when first judged is history: on a watch started over an old session, a stall and an unsignalled ended turn four days old are one note each, never an alert, " +
    "while a stall of twenty minutes alerts as before; a transcript first seen later and four days old is started and history in one poll; a history agent moving is no retraction, " +
    "its next stillness is judged fresh, and a restart over the saved state repeats no note", async () => {
    const s = new Scenario(PROGRAM, "history");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const stilled = (agentId: string, at: string): Line[] => [
      ...exchange(at, `toolu_${agentId.slice(0, 4)}`, agentId),
      said(at, null, agentId),
    ];
    const pathA = writeAgent(
      session,
      A,
      { name: "builder-a", description: "build" },
      stilled(A, ago(FOUR_DAYS)),
    );
    const pathB = writeAgent(session, B, { name: "builder-b", description: "build" }, [
      ...exchange(ago(FOUR_DAYS), "toolu_b0", B),
      said(ago(FOUR_DAYS), "end_turn", B),
    ]);
    const pathC = writeAgent(
      session,
      C,
      { name: "builder-c", description: "build" },
      stilled(C, ago(20)),
    );
    await s.start({ inbox: box.path });
    watch(s, box.path, session);
    expect(rows(s)).toEqual([
      ["note", "agent builder-a: still 5760 min, long before this watch", fileUrl(pathA)],
      ["note", "agent builder-b: ended 5760 min ago, long before this watch", fileUrl(pathB)],
      ["alert", "agent builder-c: stuck 20 min mid-turn, nothing pending", fileUrl(pathC)],
    ]);
    expect(polled(s, box.path)).toBe(0);
    expect(await delivered(box, 1)).toEqual([
      ["agent builder-c: stuck 20 min mid-turn, nothing pending"],
    ]);
    expect(standing(s, box.path)).toEqual([
      "agent builder-c: stuck 20 min mid-turn, nothing pending",
    ]);

    // A transcript first seen on a later poll, four days old: started, and history, in one poll.
    const pathD = writeAgent(
      session,
      D,
      { name: "builder-d", description: "build" },
      stilled(D, ago(FOUR_DAYS)),
    );
    expect(polled(s, box.path)).toBe(2);
    expect(rows(s).slice(3)).toEqual([
      ["note", "agent builder-d: started", fileUrl(pathD)],
      ["note", "agent builder-d: still 5760 min, long before this watch", fileUrl(pathD)],
    ]);

    // B moves: nothing alerted, so nothing retracts. A moves and is quiet again past
    // --quiet-after: a new stillness, judged fresh, so an alert.
    const movedA = ago(15);
    appendLines(pathB, exchange(ago(0), "toolu_b9", B));
    appendLines(pathA, exchange(movedA, "toolu_a9", A));
    expect(polled(s, box.path)).toBe(1);
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s).slice(5)).toEqual([
      ["alert", "agent builder-a: stuck 15 min mid-turn, nothing pending", fileUrl(pathA)],
    ]);
    expect(s.state().targets[session.dir]).toMatchObject({
      agents: {
        [A]: { said: { level: "alert", key: `stall:${movedA}`, duration: 15 } },
        [B]: { said: null },
        [D]: { said: { level: "note" } },
      },
    });

    // The restart's own poll reads the saved notes back: nothing is said again.
    s.stop({ inbox: box.path });
    await s.start({ inbox: box.path });
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toHaveLength(6);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a stillness that crosses the day under the watch stays an alert: with its repeats spent it is held in silence and still listed by status, " +
    "and after a day with no poll it repeats once more; history is only what was already old when first judged", async () => {
    const s = new Scenario(PROGRAM, "crossing");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const began = ago(1500);
    const stilled = (agentId: string): Line[] => [
      ...exchange(began, `toolu_${agentId.slice(0, 4)}`, agentId),
      said(began, null, agentId),
    ];
    const pathA = writeAgent(session, A, { name: "builder-a", description: "build" }, stilled(A));
    const pathB = writeAgent(session, B, { name: "builder-b", description: "build" }, stilled(B));
    // Both files were last written twenty minutes ago, so each stall is judged at twenty minutes.
    const written = ago(20);
    for (const path of [pathA, pathB]) utimesSync(path, new Date(written), new Date(written));
    await s.start({ inbox: box.path });
    watch(s, box.path, session);
    expect(rows(s)).toEqual([
      ["alert", "agent builder-a: stuck 20 min mid-turn, nothing pending", fileUrl(pathA)],
      ["alert", "agent builder-b: stuck 20 min mid-turn, nothing pending", fileUrl(pathB)],
    ]);
    s.stop({ inbox: box.path });

    // Twenty-five hours on by the transcript's clock, each stall's start as its file's last line
    // says it. A's saved alert is what a day of polling leaves: said when the stall was twenty
    // minutes old, repeated at 40, 80, and 160, its repeats spent. B's is what a daemon stopped
    // since the first alert left: said once at twenty minutes.
    const spent = {
      text: "agent builder-a: stuck 160 min mid-turn, nothing pending",
      since: ago(1480),
      duration: 160,
      repeats: 3,
    };
    rewriteState(s, (target) => {
      for (const [agentId, alert] of [
        [A, spent],
        [B, { since: ago(1480) }],
      ] as const) {
        const entry = target.agents[agentId] as PersistedTarget["agents"][string];
        entry.state.lastMovedAt = began;
        Object.assign(entry.said as Record<string, unknown>, { key: `stall:${began}`, ...alert });
      }
    });
    for (const path of [pathA, pathB]) utimesSync(path, new Date(began), new Date(began));
    await s.start({ inbox: box.path });
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s).slice(2)).toEqual([
      ["alert", "agent builder-b: stuck 1500 min mid-turn, nothing pending", fileUrl(pathB)],
    ]);
    expect(standing(s, box.path)).toEqual([
      "agent builder-a: stuck 160 min mid-turn, nothing pending",
      "agent builder-b: stuck 1500 min mid-turn, nothing pending",
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("an alert that changes kind is said anew without a retraction between: a stuck call, then once its result lands a child still past the bound, then fine again once the child's notice arrives", async () => {
    const s = new Scenario(PROGRAM, "again");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const pathA = writeAgent(session, A, { name: "builder-a", description: "build" }, [
      toolUse(ago(50), "toolu_bg", "Agent", {
        name: "runner",
        description: "run it",
        subagent_type: "general-purpose",
        prompt: "run",
        run_in_background: true,
      }),
      toolResult(ago(50), "toolu_bg", {
        toolUseResult: { status: "async_launched", agentId: C },
      }),
      pendingBash(ago(14), "toolu_b", A, TWO_MINUTES_MS),
    ]);
    writeAgent(session, C, { name: "runner", description: "run it", parentAgentId: A }, [
      pendingBash(ago(35), "toolu_c1", C, HOUR_MS),
    ]);
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    appendLines(pathA, [toolResult(ago(0), "toolu_b")]);
    expect(polled(s, box.path)).toBe(1);
    appendLines(pathA, [userText(ago(0), notice(C))]);
    expect(polled(s, box.path)).toBe(1);
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      ["alert", "agent builder-a: stuck 14 min on Bash", fileUrl(pathA)],
      [
        "alert",
        "agent builder-a: stuck on agent runner, runner last moved 35 min ago",
        fileUrl(pathA),
      ],
      ["note", "agent builder-a: fine again", fileUrl(pathA)],
    ]);
    expect(s.state().targets[session.dir]).toMatchObject({
      agents: { [A]: { said: null } },
    });
    s.stop({ inbox: box.path });
  }, 30000);

  test("a subagents directory that does not exist yet is an empty fleet: the first poll happens with no agents, the first transcript is started and stuck in one poll, and once listed a directory that vanishes is a fleet-wide trouble alert", async () => {
    const s = new Scenario(PROGRAM, "none");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    rmSync(session.subagents, { recursive: true });
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    expect(s.events()).toEqual([]);
    expect(polled(s, box.path)).toBe(0);

    mkdirSync(session.subagents);
    const pathA = writeAgent(session, A, { name: "builder-a", description: "build" }, [
      pendingBash(ago(35), "toolu_01", A),
    ]);
    expect(polled(s, box.path)).toBe(2);
    expect(polled(s, box.path)).toBe(0);

    rmSync(session.subagents, { recursive: true });
    expect(polled(s, box.path)).toBe(1);
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      ["note", "agent builder-a: started", fileUrl(pathA)],
      ["alert", "agent builder-a: stuck 35 min on Bash", fileUrl(pathA)],
      ["alert", `fleet: cannot list ${session.subagents}: ENOENT`, fileUrl(session.subagents)],
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test(
    "an unclaimed worktree goes idle only after work was seen in it: a worker that came and went makes it idle two polls later, a worktree where nothing ever worked never does, and the instrument excludes itself from the worktree it was started in",
    async () => {
      const s = new Scenario(PROGRAM, "own");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const {
        repo,
        worktrees: { "wt-a": wtA, "wt-b": wtB },
      } = scratchRepo(s.fixtureDir, TRACKS);
      const parked = park(repo);
      const cwd = process.cwd();
      try {
        // The daemon inherits the test process's cwd at spawn: park it in wt-b for the start only.
        process.chdir(wtB);
        try {
          await s.start({ inbox: box.path });
        } finally {
          process.chdir(cwd);
        }
        watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
        expect(polled(s, box.path)).toBe(0);
        expect(polled(s, box.path)).toBe(0);
        expect(polled(s, box.path)).toBe(0);

        const worker = park(wtA);
        expect(polled(s, box.path)).toBe(0);
        worker.kill();
        await worker.exited;
        expect(polled(s, box.path)).toBe(0);
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);
        expect(rows(s)).toEqual([
          ["alert", "worktree track-a: idle 2 polls after work", fileUrl(wtA)],
        ]);
        expect(s.state().targets[session.dir]).toMatchObject({
          worktrees: {
            [wtA]: {
              workSeen: true,
              idlePolls: 3,
              said: { level: "alert", key: "idle", duration: 2, repeats: 0 },
            },
            [wtB]: { workSeen: false, processes: { workers: 0, shells: 0 }, said: null },
          },
        });
      } finally {
        parked.kill();
      }
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test(
    "an idle alert repeats as its count doubles, three times, then holds in silence; a worker arriving is active again, a note, and the next idle starts the count afresh",
    async () => {
      const s = new Scenario(PROGRAM, "repeat");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const {
        repo,
        worktrees: { "wt-a": wtA },
      } = scratchRepo(s.fixtureDir, TRACKS);
      const parked = park(repo);
      let worker: ReturnType<typeof park> | null = null;
      try {
        await s.start({ inbox: box.path });
        watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
        worker = park(wtA);
        expect(polled(s, box.path)).toBe(0);
        worker.kill();
        await worker.exited;
        worker = null;
        const counts: number[] = [];
        for (let i = 0; i < 33; i += 1) counts.push(polled(s, box.path));
        const saidAt = counts.flatMap((count, i) => (count === 1 ? [i + 1] : []));
        expect(saidAt).toEqual([2, 4, 8, 16]);
        expect(counts.filter((count) => count > 1)).toEqual([]);
        expect(rows(s).map((row) => [row[0], row[1]])).toEqual([
          ["alert", "worktree track-a: idle 2 polls after work"],
          ["alert", "worktree track-a: idle 4 polls after work"],
          ["alert", "worktree track-a: idle 8 polls after work"],
          ["alert", "worktree track-a: idle 16 polls after work"],
        ]);
        expect(standing(s, box.path)).toEqual(["worktree track-a: idle 16 polls after work"]);

        worker = park(wtA);
        expect(polled(s, box.path)).toBe(1);
        worker.kill();
        await worker.exited;
        worker = null;
        expect(polled(s, box.path)).toBe(0);
        expect(polled(s, box.path)).toBe(1);
        expect(rows(s).slice(4)).toEqual([
          ["note", "worktree track-a: active again", fileUrl(wtA)],
          ["alert", "worktree track-a: idle 2 polls after work", fileUrl(wtA)],
        ]);
      } finally {
        worker?.kill();
        parked.kill();
      }
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test(
    "a worktree an agent's sidecar claims is not read: a commit there is no event while the claim holds, a listed agent whose sidecar read fails keeps its claim, " +
      "and an agent gone from a successful listing loses it, so the next commit there is a head note",
    async () => {
      const s = new Scenario(PROGRAM, "claim");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const {
        repo,
        worktrees: { "wt-a": wtA },
      } = scratchRepo(s.fixtureDir, TRACKS);
      const pathA = writeAgent(
        session,
        A,
        { name: "builder-a", description: "build", worktreePath: wtA, worktreeBranch: "track-a" },
        exchange(ago(0), "toolu_01"),
      );
      const sidecarA = join(session.subagents, `agent-${A}.meta.json`);
      const parked = park(repo);
      try {
        await s.start({ inbox: box.path });
        watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
        expect(polled(s, box.path)).toBe(0);
        git(wtA, "commit", "--allow-empty", "-m", "claimed work");
        expect(polled(s, box.path)).toBe(0);
        expect(s.state().targets[session.dir]).not.toMatchObject({ worktrees: { [wtA]: {} } });

        // Still listed, sidecar unreadable: that agent's trouble, its claim kept.
        rmSync(sidecarA);
        mkdirSync(sidecarA);
        git(wtA, "commit", "--allow-empty", "-m", "still claimed");
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);

        // Gone from the listing: the claim goes with it, and the worktree enters the reading fresh.
        rmSync(sidecarA, { recursive: true });
        rmSync(pathA);
        expect(polled(s, box.path)).toBe(1);
        git(wtA, "commit", "--allow-empty", "-m", "unclaimed");
        const head = git(wtA, "rev-parse", "HEAD").trim();
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);
        expect(rows(s)).toEqual([
          [
            "alert",
            `fleet: cannot read agent-${A}.meta.json: ${sidecarA} is not a regular file`,
            fileUrl(sidecarA),
          ],
          ["note", "fleet: reading restored", fileUrl(sidecarA)],
          ["note", `worktree track-a: head moved to ${head.slice(0, 12)}`, fileUrl(wtA)],
        ]);
      } finally {
        parked.kill();
      }
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test(
    "a failed per-agent read is no observation for that agent: its sidecar removed and its transcript unreadable in one poll keep the claim, while a removed sidecar beside a readable transcript drops it",
    async () => {
      const s = new Scenario(PROGRAM, "held");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const {
        repo,
        worktrees: { "wt-a": wtA },
      } = scratchRepo(s.fixtureDir, TRACKS);
      const pathA = writeAgent(
        session,
        A,
        { name: "builder-a", description: "build", worktreePath: wtA, worktreeBranch: "track-a" },
        exchange(ago(0), "toolu_01"),
      );
      const sidecarA = join(session.subagents, `agent-${A}.meta.json`);
      const parked = park(repo);
      try {
        await s.start({ inbox: box.path });
        watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
        expect(polled(s, box.path)).toBe(0);

        // Sidecar gone AND transcript unreadable: the agent's poll failed as a whole, its claim holds.
        rmSync(sidecarA);
        rmSync(pathA);
        mkdirSync(pathA);
        git(wtA, "commit", "--allow-empty", "-m", "claimed work");
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);

        // Control: the transcript readable again with no sidecar, so the claim is gone and the
        // worktree is read; the next commit is a head note.
        rmSync(pathA, { recursive: true });
        writeFileSync(pathA, "");
        appendLines(pathA, exchange(ago(0), "toolu_02"));
        expect(polled(s, box.path)).toBe(1);
        git(wtA, "commit", "--allow-empty", "-m", "unclaimed");
        const head = git(wtA, "rev-parse", "HEAD").trim();
        expect(polled(s, box.path)).toBe(1);
        expect(rows(s)).toEqual([
          [
            "alert",
            `fleet: cannot read agent-${A}.jsonl: ${pathA} is not a regular file`,
            fileUrl(pathA),
          ],
          ["note", "fleet: reading restored", fileUrl(pathA)],
          ["note", `worktree track-a: head moved to ${head.slice(0, 12)}`, fileUrl(wtA)],
        ]);
      } finally {
        parked.kill();
      }
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test(
    "a bare head move keeps an idle worktree idle: a commit from outside with a clean tree and no process is a head note and no retraction, while a head move with a worker in the tree is active again and idle re-fires once the worker leaves",
    async () => {
      const s = new Scenario(PROGRAM, "rest");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const {
        repo,
        worktrees: { "wt-a": wtA },
      } = scratchRepo(s.fixtureDir, TRACKS);
      const parked = park(repo);
      let worker: ReturnType<typeof Bun.spawn> | null = null;
      try {
        await s.start({ inbox: box.path });
        watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
        worker = park(wtA);
        expect(polled(s, box.path)).toBe(0);
        worker.kill();
        await worker.exited;
        worker = null;
        expect(polled(s, box.path)).toBe(0);
        expect(polled(s, box.path)).toBe(1);

        // The lead restacks from outside: the tree is clean before and after, nobody is in it.
        git(wtA, "commit", "--allow-empty", "-m", "restack");
        const restacked = git(wtA, "rev-parse", "HEAD").trim();
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);

        // A worker in the tree while the head moves: active again, and idle re-fires once it leaves.
        worker = park(wtA);
        git(wtA, "commit", "--allow-empty", "-m", "worked");
        const worked = git(wtA, "rev-parse", "HEAD").trim();
        expect(polled(s, box.path)).toBe(2);
        expect(polled(s, box.path)).toBe(0);
        worker.kill();
        await worker.exited;
        worker = null;
        expect(polled(s, box.path)).toBe(0);
        expect(polled(s, box.path)).toBe(1);
        expect(rows(s)).toEqual([
          ["alert", "worktree track-a: idle 2 polls after work", fileUrl(wtA)],
          ["note", `worktree track-a: head moved to ${restacked.slice(0, 12)}`, fileUrl(wtA)],
          ["alert", "worktree track-a: idle 4 polls after work", fileUrl(wtA)],
          ["note", `worktree track-a: head moved to ${worked.slice(0, 12)}`, fileUrl(wtA)],
          ["note", "worktree track-a: active again", fileUrl(wtA)],
          ["alert", "worktree track-a: idle 2 polls after work", fileUrl(wtA)],
        ]);
        expect(s.events()[1]).toMatchObject({ kind: "head", worktree: wtA, sha: restacked });
        expect(s.events()[1]).not.toHaveProperty("ahead");
      } finally {
        worker?.kill();
        parked.kill();
      }
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test(
    "a dirty file landing in an idle worktree is active again by the tree reading alone, and a worktree whose worker never left never goes idle",
    async () => {
      const s = new Scenario(PROGRAM, "wake");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const {
        repo,
        worktrees: { "wt-a": wtA, "wt-b": wtB },
      } = scratchRepo(s.fixtureDir, TRACKS);
      const parked = park(repo);
      const workers: Array<ReturnType<typeof Bun.spawn>> = [];
      try {
        await s.start({ inbox: box.path });
        watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
        workers.push(park(wtA), park(wtB));
        expect(polled(s, box.path)).toBe(0);
        const [leaving] = workers.splice(0, 1);
        leaving?.kill();
        await leaving?.exited;
        expect(polled(s, box.path)).toBe(0);
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);
        writeFileSync(join(wtA, "scratch.txt"), "notes\n");
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);
        expect(rows(s)).toEqual([
          ["alert", "worktree track-a: idle 2 polls after work", fileUrl(wtA)],
          ["note", "worktree track-a: active again", fileUrl(wtA)],
        ]);
      } finally {
        for (const worker of workers) worker.kill();
        parked.kill();
      }
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test(
    "a worktree a successful discovery no longer lists is gone, a note once with its last head as a field, and its row is dropped; " +
      "one claimed since its last reading, by sidecar or by a command, and removed is its agent's, no note",
    async () => {
      const s = new Scenario(PROGRAM, "gone");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const {
        repo,
        worktrees: { "wt-a": wtA, "wt-b": wtB },
      } = scratchRepo(s.fixtureDir, TRACKS);
      // Both worktrees sit on the same initial commit, so one sha is every head.
      const head = git(wtB, "rev-parse", "HEAD").trim();
      const parked = park(repo);
      try {
        await s.start({ inbox: box.path });
        watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
        // Both were read unclaimed; before the next poll a sidecar claims wt-a, a command names
        // wt-b, and wt-b is removed.
        const pathA = writeAgent(
          session,
          A,
          { name: "builder-a", description: "build", worktreePath: wtA, worktreeBranch: "track-a" },
          exchange(ago(0), "toolu_01"),
        );
        const pathC = writeAgent(session, C, { name: "builder-c", description: "build" }, [
          toolUse(ago(0), "toolu_c1", "Bash", { command: `git -C ${wtB} log --oneline -1` }, C),
          toolResult(ago(0), "toolu_c1", { agentId: C }),
        ]);
        git(repo, "worktree", "remove", "--force", wtB);
        expect(polled(s, box.path)).toBe(2);
        expect(rows(s)).toEqual([
          ["note", "agent builder-a: started", fileUrl(pathA)],
          ["note", "agent builder-c: started", fileUrl(pathC)],
        ]);
        // wt-a's claim ends with a sidecar that drops the path: read again, then removed, it is gone.
        writeFileSync(
          join(session.subagents, `agent-${A}.meta.json`),
          JSON.stringify({ name: "builder-a", description: "build" }),
        );
        expect(polled(s, box.path)).toBe(0);
        git(repo, "worktree", "remove", "--force", wtA);
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);
        expect(rows(s).slice(2)).toEqual([["note", "worktree track-a: gone", fileUrl(wtA)]]);
        expect(s.events()[2]).toMatchObject({ kind: "gone", worktree: wtA, sha: head });
        expect(await delivered(box, 1)).toEqual([]);
        const target = s.state().targets[session.dir] as { worktrees: Record<string, unknown> };
        expect(Object.keys(target.worktrees)).toEqual([repo]);
      } finally {
        parked.kill();
      }
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test(
    "process attribution down, then degraded, is one trouble alert each, and each is followed by one reading-restored note when attribution works again; the idle count holds at zero while attribution is off",
    async () => {
      const s = new Scenario(PROGRAM, "lsof");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const {
        repo,
        worktrees: { "wt-a": wtA },
      } = scratchRepo(s.fixtureDir, TRACKS);
      // A stand-in lsof the test can take down (exit 1, no output) or degrade (real output, exit 1).
      const realLsof = Bun.which("lsof");
      if (realLsof === null) throw new Error("lsof is not installed");
      const bin = join(s.fixtureDir, "bin");
      const down = join(s.fixtureDir, "lsof-down");
      const degraded = join(s.fixtureDir, "lsof-degraded");
      mkdirSync(bin);
      writeFileSync(
        join(bin, "lsof"),
        `#!/bin/sh\n[ -e "${down}" ] && exit 1\nif [ -e "${degraded}" ]; then "${realLsof}" "$@"; exit 1; fi\nexec "${realLsof}" "$@"\n`,
        { mode: 0o755 },
      );
      const parked = park(repo);
      let worker: ReturnType<typeof park> | null = null;
      try {
        await s.start({ inbox: box.path, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
        watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
        worker = park(wtA);
        expect(polled(s, box.path)).toBe(0);
        worker.kill();
        await worker.exited;
        worker = null;
        writeFileSync(down, "");
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);
        rmSync(down);
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(1);
        writeFileSync(degraded, "");
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);
        rmSync(degraded);
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);
        expect(rows(s).map((row) => [row[0], row[1]])).toEqual([
          ["alert", expect.stringMatching(/^fleet: process attribution is down: /)],
          ["note", "fleet: reading restored"],
          ["alert", "worktree track-a: idle 2 polls after work"],
          ["alert", expect.stringMatching(/^fleet: process attribution degraded: /)],
          ["note", "fleet: reading restored"],
        ]);
        expect(rows(s)[2]?.[2]).toBe(fileUrl(wtA));
        expect(await delivered(box, 3)).toHaveLength(3);
      } finally {
        worker?.kill();
        parked.kill();
      }
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test(
    "an agent claims a worktree by naming its path in a tool call's input: a worker seen there and gone brings no idle line ever, " +
      "while the same path in a tool result's body claims nothing and that worktree idles after work; the main checkout is never claimed by a command",
    async () => {
      const s = new Scenario(PROGRAM, "commands");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const {
        repo,
        worktrees: { "wt-a": wtA, "wt-b": wtB },
      } = scratchRepo(s.fixtureDir, TRACKS);
      // A third worktree nested inside the main checkout, as this repository lays its own out.
      const nested = join(repo, ".worktrees", "nested");
      git(repo, "worktree", "add", nested, "-b", "track-n");
      writeAgent(session, A, { name: "builder-a", description: "build" }, [
        toolUse(ago(0), "toolu_01", "Bash", { command: `git -C ${wtA} status --short` }),
        toolResult(ago(0), "toolu_01", { content: [{ type: "text", text: `${wtB} is clean` }] }),
        toolUse(ago(0), "toolu_02", "Read", { file_path: join(repo, "README.md") }),
        toolResult(ago(0), "toolu_02"),
        toolUse(ago(0), "toolu_03", "Bash", { command: `/usr/bin/git -C ${nested} status` }),
        toolResult(ago(0), "toolu_03"),
      ]);
      const workers = [park(wtA), park(wtB), park(nested)];
      try {
        await s.start({ inbox: box.path });
        watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
        expect(polled(s, box.path)).toBe(0);
        // The claimed nested worktree's worker lands nowhere else: its ancestor, the main checkout,
        // saw no work (the main checkout holds no worker of its own in this scenario).
        expect(s.state().targets[session.dir]).toMatchObject({
          worktrees: { [repo]: { processes: { workers: 0 }, workSeen: false } },
        });
        const read = s.state().targets[session.dir] as { worktrees: Record<string, unknown> };
        expect(Object.keys(read.worktrees).sort()).toEqual([repo, wtB].sort());
        for (const worker of workers.splice(0)) {
          worker.kill();
          await worker.exited;
        }
        expect(polled(s, box.path)).toBe(0);
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);
        expect(rows(s)).toEqual([
          ["alert", "worktree track-b: idle 2 polls after work", fileUrl(wtB)],
        ]);
        const target = s.state().targets[session.dir] as { worktrees: Record<string, unknown> };
        expect(Object.keys(target.worktrees).sort()).toEqual([repo, wtB].sort());
        // The claim ends with the listing: the agent's transcript gone, the worktree is read again
        // (the one event is wt-b's idle alert doubling to 4 polls).
        rmSync(join(session.subagents, `agent-${A}.jsonl`));
        rmSync(join(session.subagents, `agent-${A}.meta.json`));
        expect(polled(s, box.path)).toBe(1);
        expect(rows(s).at(-1)).toEqual([
          "alert",
          "worktree track-b: idle 4 polls after work",
          fileUrl(wtB),
        ]);
        const after = s.state().targets[session.dir] as { worktrees: Record<string, unknown> };
        expect(Object.keys(after.worktrees).sort()).toEqual([repo, wtA, wtB, nested].sort());
      } finally {
        for (const worker of workers) worker.kill();
      }
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test(
    "the lead's own commands claim a worktree as an agent's do: one named only in the session transcript's Bash input sees a worker come and go with no idle line, " +
      "while one named nowhere idles two polls after work",
    async () => {
      const s = new Scenario(PROGRAM, "leadclaim");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const {
        repo,
        worktrees: { "wt-a": wtA, "wt-b": wtB },
      } = scratchRepo(s.fixtureDir, TRACKS);
      appendLines(session.sessionFile, [
        toolUse(ago(5), "toolu_lead", "Bash", { command: `git -C ${wtA} log --oneline -3` }, null),
        toolResult(ago(5), "toolu_lead", { agentId: null }),
      ]);
      const parked = park(repo);
      const workers = [park(wtA), park(wtB)];
      try {
        await s.start({ inbox: box.path });
        watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
        expect(polled(s, box.path)).toBe(0);
        for (const worker of workers.splice(0)) {
          worker.kill();
          await worker.exited;
        }
        expect(polled(s, box.path)).toBe(0);
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);
        expect(rows(s)).toEqual([
          ["alert", "worktree track-b: idle 2 polls after work", fileUrl(wtB)],
        ]);
        const target = s.state().targets[session.dir] as { worktrees: Record<string, unknown> };
        expect(Object.keys(target.worktrees).sort()).toEqual([repo, wtB].sort());
      } finally {
        for (const worker of workers) worker.kill();
        parked.kill();
      }
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test(
    "the lead's claim is transient: a worktree the lead named is unread while that command is under 30 minutes old, and read again as unclaimed after, " +
      "with no work remembered from the claimed period, so a worker that then comes and goes yields the idle line; a lead command naming it again at 20 minutes keeps it claimed, " +
      "and an agent's command of any age keeps its claim",
    async () => {
      const s = new Scenario(PROGRAM, "leadlapse");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const {
        repo,
        worktrees: { "wt-a": wtA, "wt-b": wtB },
      } = scratchRepo(s.fixtureDir, TRACKS);
      const leadCommand = (id: string, at: string, path: string): Line[] => [
        toolUse(at, id, "Bash", { command: `git -C ${path} status --short` }, null),
        toolResult(at, id, { agentId: null }),
      ];
      appendLines(session.sessionFile, [
        ...leadCommand("toolu_l1", ago(5), wtA),
        ...leadCommand("toolu_l2", ago(5), wtB),
      ]);
      // The agent control: a third worktree named by an agent 40 minutes ago, claimed for good.
      const nested = join(repo, ".worktrees", "nested");
      git(repo, "worktree", "add", nested, "-b", "track-n");
      writeAgent(session, A, { name: "builder-a", description: "build" }, [
        toolUse(ago(40), "toolu_a1", "Bash", { command: `git -C ${nested} status --short` }),
        toolResult(ago(40), "toolu_a1"),
        ...exchange(ago(0), "toolu_a2"),
      ]);
      const parked = park(repo);
      const workers: Array<ReturnType<typeof park>> = [park(wtA), park(wtB), park(nested)];
      const leave = async () => {
        for (const worker of workers.splice(0)) {
          worker.kill();
          await worker.exited;
        }
      };
      try {
        await s.start({ inbox: box.path });
        watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
        expect(polled(s, box.path)).toBe(0);
        await leave();
        expect(polled(s, box.path)).toBe(0);
        expect(polled(s, box.path)).toBe(0);
        expect(polled(s, box.path)).toBe(0);
        expect(s.events()).toEqual([]);

        // 31 minutes on, by the transcript's clock: the session file shrinks to nothing (so the
        // daemon reads it from its start) and then carries wt-a's command 31 minutes old and wt-b
        // named again at 20.
        writeFileSync(session.sessionFile, "");
        expect(polled(s, box.path)).toBe(0);
        appendLines(session.sessionFile, [
          ...leadCommand("toolu_l1", ago(31), wtA),
          ...leadCommand("toolu_l2", ago(31), wtB),
          ...leadCommand("toolu_l3", ago(20), wtB),
        ]);
        expect(polled(s, box.path)).toBe(0);
        workers.push(park(wtA), park(wtB), park(nested));
        expect(polled(s, box.path)).toBe(0);
        await leave();
        expect(polled(s, box.path)).toBe(0);
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);
        expect(rows(s)).toEqual([
          ["alert", "worktree track-a: idle 2 polls after work", fileUrl(wtA)],
        ]);
        const target = s.state().targets[session.dir] as { worktrees: Record<string, unknown> };
        expect(Object.keys(target.worktrees).sort()).toEqual([repo, wtA].sort());
      } finally {
        for (const worker of workers) worker.kill();
        parked.kill();
      }
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test(
    "with every worktree claimed, the poll runs no process reading: a downed lsof is no trouble until an unclaimed worktree needs it",
    async () => {
      const s = new Scenario(PROGRAM, "allclaimed");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const {
        repo,
        worktrees: { "wt-a": wtA, "wt-b": wtB },
      } = scratchRepo(s.fixtureDir, TRACKS);
      const bin = join(s.fixtureDir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "lsof"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      const claim = (agentId: string, name: string, worktreePath: string) =>
        writeAgent(
          session,
          agentId,
          { name, description: "build", worktreePath },
          exchange(ago(0), `toolu_${agentId.slice(0, 4)}`, agentId),
        );
      claim(A, "builder-a", wtA);
      claim(B, "builder-b", wtB);
      claim(C, "lead-twin", repo);
      await s.start({ inbox: box.path, env: { PATH: `${bin}:${process.env.PATH ?? ""}` } });
      watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
      expect(polled(s, box.path)).toBe(0);
      expect(s.events()).toEqual([]);
      // The control: one claim ends, the reading needs lsof, and lsof is down.
      writeFileSync(
        join(session.subagents, `agent-${C}.meta.json`),
        JSON.stringify({ name: "lead-twin", description: "build" }),
      );
      expect(polled(s, box.path)).toBe(1);
      expect(rows(s).map((row) => [row[0], row[1]])).toEqual([
        ["alert", expect.stringMatching(/^fleet: process attribution is down: /)],
      ]);
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test("a state file from before `stops`, `since`, and the standing alert loads: the poll takes the defaults, says the stop it then reads as a note, and saves the current shape", async () => {
    const s = new Scenario(PROGRAM, "older");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    appendLines(session.sessionFile, spawnLines("toolu_spawn_a", "builder-a", A));
    const pathA = writeAgent(
      session,
      A,
      { name: "builder-a", description: "build" },
      exchange(ago(0), "toolu_a1"),
    );
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    expect(polled(s, box.path)).toBe(0);
    s.stop({ inbox: box.path });

    // What the version before `stops` wrote: activities without it, children without `since`,
    // agents with the three situation keys, a trouble ledger of texts, and no tasks directory.
    rewriteState(s, (target) => {
      const older = (activity: Record<string, unknown>) => {
        delete activity.stops;
        for (const child of Object.values(
          activity.children as Record<string, Record<string, unknown>>,
        ))
          delete child.since;
      };
      older(target.lead.state);
      for (const entry of Object.values(target.agents)) {
        older(entry.state);
        delete entry.said;
        entry.observed = "moving";
        entry.baseline = null;
        entry.said = "moving";
      }
      target.trouble = { lsof: "fleet: process attribution is down: no lsof" };
      delete target.tasksDir;
    });
    // The lead stopped A while the daemon was down; the restart polls at once and says it.
    appendLines(session.sessionFile, [
      toolUse(ago(2), "toolu_stop", "TaskStop", { task_id: "builder-a" }, null),
      toolResult(ago(2), "toolu_stop", { agentId: null }),
    ]);
    await s.start({ inbox: box.path, env: { CLAUDE_CODE_TMPDIR: claudeTmp(s).root } });
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      ["note", "fleet: reading restored", ""],
      ["note", "agent builder-a: stopped by the lead", fileUrl(pathA)],
    ]);
    const saved = persistedTarget(s);
    expect(saved.lead.state.stops).toEqual({});
    const child = (saved.lead.state.children as Record<string, Record<string, unknown>>)[A];
    expect(child?.since).toBe(child?.at);
    expect(saved.agents[A]).toMatchObject({ said: { level: "note", key: "stopped" } });
    expect(saved.agents[A]).not.toHaveProperty("observed");
    expect(saved.tasksDir).toBe(claudeTmp(s).tasks);
    expect(s.log()).not.toContain("poll failed");
    s.stop({ inbox: box.path });
  }, 30000);

  test("worktree rows saved before `workSeen` and the standing alert load: the idle count carries over with no work seen and nothing standing, so a worker arriving is no retraction", async () => {
    const s = new Scenario(PROGRAM, "olderwt");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const {
      repo,
      worktrees: { "wt-a": wtA },
    } = scratchRepo(s.fixtureDir, TRACKS);
    const parked = park(repo);
    let worker: ReturnType<typeof park> | null = null;
    try {
      await s.start({ inbox: box.path });
      watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
      expect(polled(s, box.path)).toBe(0);
      expect(polled(s, box.path)).toBe(0);
      s.stop({ inbox: box.path });

      // What the version before wrote: rows with a quiet count and a said quiet, no workSeen.
      rewriteState(s, (target) => {
        for (const row of Object.values(target.worktrees)) {
          row.quietPolls = row.idlePolls;
          delete row.idlePolls;
          delete row.workSeen;
          row.said = "quiet";
        }
      });
      await s.start({ inbox: box.path });
      expect(polled(s, box.path)).toBe(0);
      expect(s.state().targets[session.dir]).toMatchObject({
        worktrees: { [wtA]: { idlePolls: 4, workSeen: false, said: null } },
      });
      worker = park(wtA);
      expect(polled(s, box.path)).toBe(0);
      expect(s.events()).toEqual([]);
      expect(s.log()).not.toContain("poll failed");
      s.stop({ inbox: box.path });
    } finally {
      parked.kill();
      worker?.kill();
    }
  }, 30000);

  test("a saved map that is not an object starts the target over instead of failing every poll", async () => {
    const s = new Scenario(PROGRAM, "reshape");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    appendLines(session.sessionFile, spawnLines("toolu_spawn_a", "builder-a", A));
    const pathA = writeAgent(
      session,
      A,
      { name: "builder-a", description: "build" },
      exchange(ago(0), "toolu_a1"),
    );
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    expect(polled(s, box.path)).toBe(0);
    expect(persistedTarget(s).polls).toBe(2);
    s.stop({ inbox: box.path });

    rewriteState(s, (target) => {
      target.lead.state.children = 5;
    });
    // The restart's own poll is the first again; this one is the second.
    await s.start({ inbox: box.path });
    expect(polled(s, box.path)).toBe(0);
    expect(persistedTarget(s).polls).toBe(2);
    expect(s.log()).toContain("the target starts over");
    expect(s.log()).not.toContain("poll failed");
    appendLines(session.sessionFile, [
      toolUse(ago(2), "toolu_stop", "TaskStop", { task_id: "builder-a" }, null),
      toolResult(ago(2), "toolu_stop", { agentId: null }),
    ]);
    expect(polled(s, box.path)).toBe(1);
    expect(rows(s)).toEqual([["note", "agent builder-a: stopped by the lead", fileUrl(pathA)]]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a saved target from before `subagentsListed` that polled an empty subagents directory treats its disappearance as a failed listing, not an empty fleet", async () => {
    const s = new Scenario(PROGRAM, "olderdir");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    s.stop({ inbox: box.path });

    rewriteState(s, (target) => {
      delete target.subagentsListed;
    });
    rmSync(session.subagents, { recursive: true });
    await s.start({ inbox: box.path });
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      ["alert", `fleet: cannot list ${session.subagents}: ENOENT`, fileUrl(session.subagents)],
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a child finished and resumed between two polls is a new wait: stuck on it is said anew, with the run in its key, and the child moving at last is fine again", async () => {
    const s = new Scenario(PROGRAM, "rerun");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const pathB = writeAgent(session, B, { name: "builder-b", description: "build" }, [
      ...exchange(ago(60), "toolu_b0", B),
      toolUse(
        ago(50),
        "toolu_spawn",
        "Agent",
        {
          name: "reviewer",
          description: "review",
          subagent_type: "general-purpose",
          prompt: "review",
          run_in_background: true,
        },
        B,
      ),
      toolResult(ago(50), "toolu_spawn", {
        toolUseResult: { status: "async_launched", agentId: C },
        agentId: B,
      }),
    ]);
    const pathC = writeAgent(
      session,
      C,
      { name: "reviewer", description: "review", parentAgentId: B },
      [pendingBash(ago(45), "toolu_c1", C, HOUR_MS)],
    );
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    expect(polled(s, box.path)).toBe(0);
    // Between two polls the reviewer finishes and the parent's message resumes it: a new run.
    appendLines(pathB, [
      userText(ago(0), notice(C), B),
      toolUse(ago(0), "toolu_msg", "SendMessage", { to: C, message: "once more", summary: "s" }, B),
      toolResult(ago(0), "toolu_msg", { agentId: B }),
    ]);
    expect(polled(s, box.path)).toBe(1);
    expect(polled(s, box.path)).toBe(0);
    appendLines(pathC, [toolResult(ago(0), "toolu_c1", { agentId: C })]);
    expect(polled(s, box.path)).toBe(1);
    expect(rows(s)).toEqual([
      [
        "alert",
        "agent builder-b: stuck on agent reviewer, reviewer last moved 45 min ago",
        fileUrl(pathB),
      ],
      [
        "alert",
        "agent builder-b: stuck on agent reviewer, reviewer last moved 45 min ago",
        fileUrl(pathB),
      ],
      ["note", "agent builder-b: fine again", fileUrl(pathB)],
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a failed read after a restart leaves the saved state as it was: the older shape is normalized only by the poll that reads, so no history is lost to a trouble poll", async () => {
    const s = new Scenario(PROGRAM, "unread");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    appendLines(session.sessionFile, spawnLines("toolu_spawn_a", "builder-a", A));
    const pathA = writeAgent(
      session,
      A,
      { name: "builder-a", description: "build" },
      exchange(ago(0), "toolu_a1"),
    );
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    s.stop({ inbox: box.path });

    rewriteState(s, (target) => {
      const older = (activity: Record<string, unknown>) => {
        delete activity.stops;
        for (const child of Object.values(
          activity.children as Record<string, Record<string, unknown>>,
        ))
          delete child.since;
      };
      older(target.lead.state);
      for (const entry of Object.values(target.agents)) older(entry.state);
      target.trouble = { lsof: "fleet: process attribution is down: no lsof" };
    });
    const before = persistedTarget(s);
    const offset = (before.lead.cursor as { offset: number }).offset;
    expect(offset).toBeGreaterThan(0);
    // The session transcript cannot be read: a directory stands where the file was.
    const parked = `${session.sessionFile}.parked`;
    renameSync(session.sessionFile, parked);
    mkdirSync(session.sessionFile);
    await s.start({ inbox: box.path });
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s).map((row) => row[0])).toEqual(["alert"]);
    expect(rows(s)[0]?.[1]).toContain("cannot read the session transcript");
    // The saved shape is older than this daemon and the read failed, so nothing normalized it yet;
    // status still lists the legacy condition by its text.
    expect(standing(s, box.path)).toEqual([
      "fleet: process attribution is down: no lsof",
      expect.stringContaining("cannot read the session transcript"),
    ]);
    const after = persistedTarget(s);
    expect((after.lead.cursor as { offset: number }).offset).toBe(offset);
    expect(after.lead.state.stops).toBeUndefined();
    expect(Object.keys(after.lead.state.children as Record<string, unknown>)).toEqual([A]);

    // Readable again, with a stop appended: this poll normalizes, replays, retracts the trouble,
    // and says the stop.
    rmSync(session.sessionFile, { recursive: true });
    renameSync(parked, session.sessionFile);
    appendLines(session.sessionFile, [
      toolUse(ago(2), "toolu_stop", "TaskStop", { task_id: "builder-a" }, null),
      toolResult(ago(2), "toolu_stop", { agentId: null }),
    ]);
    expect(polled(s, box.path)).toBe(3);
    expect(rows(s).slice(1)).toEqual([
      ["note", "fleet: reading restored", ""],
      ["note", "fleet: reading restored", fileUrl(session.sessionFile)],
      ["note", "agent builder-a: stopped by the lead", fileUrl(pathA)],
    ]);
    const normalized = persistedTarget(s);
    expect(normalized.lead.state.stops).toEqual({});
    expect((normalized.lead.cursor as { offset: number }).offset).toBeGreaterThan(0);
    s.stop({ inbox: box.path });
  }, 30000);

  test("with two children still past the bound, the one named is the oldest current run: a finished elder resumed by message counts from the message, so the child spawned meanwhile is named", async () => {
    const s = new Scenario(PROGRAM, "elder");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const spawn = (id: string, name: string, agentId: string, timestamp: string): Line[] => [
      toolUse(
        timestamp,
        id,
        "Agent",
        {
          name,
          description: "run",
          subagent_type: "general-purpose",
          prompt: "run",
          run_in_background: true,
        },
        B,
      ),
      toolResult(timestamp, id, {
        toolUseResult: { status: "async_launched", agentId },
        agentId: B,
      }),
    ];
    const pathB = writeAgent(session, B, { name: "builder-b", description: "build" }, [
      ...exchange(ago(70), "toolu_b0", B),
      ...spawn("toolu_elder", "elder", D, ago(69)),
      userText(ago(65), notice(D), B),
      ...spawn("toolu_ongoing", "ongoing", E, ago(60)),
      toolUse(ago(50), "toolu_msg", "SendMessage", { to: D, message: "carry on", summary: "s" }, B),
      toolResult(ago(50), "toolu_msg", { agentId: B }),
    ]);
    writeAgent(session, D, { name: "elder", description: "run", parentAgentId: B }, [
      pendingBash(ago(40), "toolu_d1", D, HOUR_MS),
    ]);
    writeAgent(session, E, { name: "ongoing", description: "run", parentAgentId: B }, [
      pendingBash(ago(40), "toolu_e1", E, HOUR_MS),
    ]);
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      [
        "alert",
        "agent builder-b: stuck on agent ongoing, ongoing last moved 40 min ago",
        fileUrl(pathB),
      ],
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a TaskStop by exact id stops a nested worker the lead never spawned, a note once with nothing further from it, its stuck call included; a stop by name reaches the lead's own child the same way", async () => {
    const s = new Scenario(PROGRAM, "exact");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    appendLines(session.sessionFile, [
      ...spawnLines("toolu_spawn_a", "builder-a", A),
      ...spawnLines("toolu_spawn_b", "builder-b", B),
    ]);
    const pathA = writeAgent(
      session,
      A,
      { name: "builder-a", description: "build" },
      exchange(ago(0), "toolu_a1"),
    );
    writeAgent(
      session,
      B,
      { name: "builder-b", description: "build" },
      exchange(ago(0), "toolu_b1", B),
    );
    const pathC = writeAgent(
      session,
      C,
      { name: "reviewer", description: "review B's patch", parentAgentId: B },
      [...exchange(ago(45), "toolu_c0", C), pendingBash(ago(45), "toolu_c1", C, HOUR_MS)],
    );
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    expect(polled(s, box.path)).toBe(0);

    // C's long command returns and a call past the plain bound stands; the lead stops C by its id and A by its name.
    appendLines(pathC, [
      toolResult(ago(40), "toolu_c1", { agentId: C }),
      pendingBash(ago(40), "toolu_c2", C),
    ]);
    appendLines(session.sessionFile, [
      toolUse(ago(2), "toolu_stop_c", "TaskStop", { task_id: C }, null),
      toolResult(ago(2), "toolu_stop_c", { agentId: null }),
      toolUse(ago(2), "toolu_stop_a", "TaskStop", { task_id: "builder-a" }, null),
      toolResult(ago(2), "toolu_stop_a", { agentId: null }),
    ]);
    expect(polled(s, box.path)).toBe(2);
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      ["note", "agent builder-a: stopped by the lead", fileUrl(pathA)],
      ["note", "agent reviewer: stopped by the lead", fileUrl(pathC)],
    ]);
    expect(await delivered(box, 1)).toEqual([]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("the lead's stop by name reaches only its own children: a nested agent under a name the lead once stopped is started and its stuck call alerted, whether its parent is a fleet agent or one the fleet never read", async () => {
    const s = new Scenario(PROGRAM, "nest");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    // The lead spawned A as "reviewer" and stopped it; B is a builder that will spawn its own reviewer.
    appendLines(session.sessionFile, [
      ...spawnLines("toolu_spawn_a", "reviewer", A),
      toolUse(ago(20), "toolu_stop_a", "TaskStop", { task_id: "reviewer" }, null),
      toolResult(ago(20), "toolu_stop_a", { agentId: null }),
    ]);
    const pathA = writeAgent(
      session,
      A,
      { name: "reviewer", description: "review" },
      exchange(ago(25), "toolu_a1"),
    );
    writeAgent(
      session,
      B,
      { name: "builder-b", description: "build" },
      exchange(ago(0), "toolu_b1", B),
    );
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    expect(rows(s)).toEqual([["note", "agent reviewer: stopped by the lead", fileUrl(pathA)]]);
    expect(polled(s, box.path)).toBe(0);

    const pathC = writeAgent(
      session,
      C,
      { name: "reviewer", description: "review B's patch", parentAgentId: B },
      [pendingBash(ago(35), "toolu_c1", C)],
    );
    // E's parent D has no entry: never listed, or its first read failed. Not the lead's child either way.
    const pathE = writeAgent(
      session,
      E,
      { name: "reviewer", description: "review D's patch", parentAgentId: D },
      [pendingBash(ago(35), "toolu_e1", E)],
    );
    expect(polled(s, box.path)).toBe(4);
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s).slice(1)).toEqual([
      ["note", "agent reviewer: started", fileUrl(pathC)],
      ["note", "agent reviewer: started", fileUrl(pathE)],
      ["alert", "agent reviewer: stuck 35 min on Bash", fileUrl(pathC)],
      ["alert", "agent reviewer: stuck 35 min on Bash", fileUrl(pathE)],
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test(
    "with --repo, a head move is a note and a tree collapse an alert, both only for a worktree no agent claims; a claimed worktree's commits say nothing, a sidecar malformed for a poll keeps the claim, and the claim ending starts the reading afresh",
    async () => {
      const s = new Scenario(PROGRAM, "tree");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const {
        repo,
        worktrees: { "wt-a": wtA, "wt-b": wtB },
      } = scratchRepo(s.fixtureDir, TRACKS);
      writeAgent(
        session,
        A,
        { name: "builder-a", description: "build", worktreePath: wtA, worktreeBranch: "track-a" },
        [...exchange(ago(0), "toolu_01")],
      );
      const parked = park(repo);
      try {
        await s.start({ inbox: box.path });
        watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
        expect(s.events()).toEqual([]);

        writeFileSync(join(wtA, "built.txt"), "output\n");
        git(wtA, "add", "built.txt");
        git(wtA, "commit", "-m", "track work");
        expect(polled(s, box.path)).toBe(0);

        git(wtB, "rm", "-r", "-q", "lib");
        git(wtB, "commit", "-m", "wipe");
        const headB = git(wtB, "rev-parse", "HEAD").trim();
        expect(polled(s, box.path)).toBe(2);
        expect(polled(s, box.path)).toBe(0);
        expect(rows(s)).toEqual([
          ["note", `worktree track-b: head moved to ${headB.slice(0, 12)}`, fileUrl(wtB)],
          ["alert", "worktree track-b: 6 files at HEAD -> 1", fileUrl(wtB)],
        ]);
        expect(await delivered(box, 1)).toEqual([["worktree track-b: 6 files at HEAD -> 1"]]);
        expect(s.state().targets[session.dir]).toMatchObject({
          worktrees: {
            [repo]: { branch: "main", processes: { workers: 1, shells: 0 }, idlePolls: 0 },
            [wtB]: { branch: "track-b", headSha: headB, treeFileCount: 1, workSeen: false },
          },
        });
        expect(
          Object.keys((s.state().targets[session.dir] as { worktrees: object }).worktrees).sort(),
        ).toEqual([repo, wtB].sort());
        // A sidecar malformed for a poll is that agent's trouble; its last good reading keeps the claim.
        const sidecarA = join(session.subagents, `agent-${A}.meta.json`);
        writeFileSync(sidecarA, "{");
        git(wtA, "commit", "--allow-empty", "-m", "still claimed");
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);
        expect(rows(s).at(-1)).toEqual([
          "alert",
          `fleet: cannot read agent-${A}.meta.json: ${sidecarA} is not a JSON object`,
          fileUrl(sidecarA),
        ]);
        // The claim ends: the worktree is read from this poll, so the next commit is a head note.
        writeFileSync(sidecarA, JSON.stringify({ name: "builder-a", description: "build" }));
        expect(polled(s, box.path)).toBe(1);
        expect(rows(s).at(-1)).toEqual(["note", "fleet: reading restored", fileUrl(sidecarA)]);
        git(wtA, "commit", "--allow-empty", "-m", "unclaimed");
        const headA = git(wtA, "rev-parse", "HEAD").trim();
        expect(polled(s, box.path)).toBe(1);
        expect(rows(s).at(-1)).toEqual([
          "note",
          `worktree track-a: head moved to ${headA.slice(0, 12)}`,
          fileUrl(wtA),
        ]);
      } finally {
        parked.kill();
      }
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test("a FIFO transcript, a directory or FIFO sidecar, and a vanished subagents dir are trouble alerts, said once and restored once; " +
    "a per-agent failure leaves the others' transitions flowing, a fleet-wide failure is a non-observation that keeps every continuity", async () => {
    const s = new Scenario(PROGRAM, "fifo");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const metaA = { name: "builder-a", description: "build" };
    const baseA = [...exchange(ago(40), "toolu_a0", A), pendingBash(ago(35), "toolu_a1", A)];
    const pathA = writeAgent(session, A, metaA, baseA);
    const fifo = join(session.subagents, `agent-${B}.jsonl`);
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    writeAgent(
      session,
      C,
      { name: "builder-c", description: "build" },
      exchange(ago(0), "toolu_c1", C),
    );
    const sidecarC = join(session.subagents, `agent-${C}.meta.json`);
    rmSync(sidecarC);
    mkdirSync(sidecarC);
    writeAgent(
      session,
      D,
      { name: "builder-d", description: "build" },
      exchange(ago(0), "toolu_d1", D),
    );
    const sidecarD = join(session.subagents, `agent-${D}.meta.json`);
    rmSync(sidecarD);
    expect(Bun.spawnSync(["mkfifo", sidecarD]).exitCode).toBe(0);
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    // The three failures are said beside agent A's stuck call: a per-agent failure is that agent's alone.
    expect(polled(s, box.path)).toBe(0);

    const metaE = { name: "builder-e", description: "build" };
    const pathE = writeAgent(session, E, metaE, [pendingBash(ago(35), "toolu_e1", E)]);
    expect(polled(s, box.path)).toBe(2);
    // The listing fails: a non-observation, said once; the fleet comes back with the same failures.
    rmSync(session.subagents, { recursive: true });
    expect(polled(s, box.path)).toBe(1);
    expect(polled(s, box.path)).toBe(0);
    mkdirSync(session.subagents);
    writeAgent(session, A, metaA, baseA);
    writeAgent(session, E, metaE, [pendingBash(ago(35), "toolu_e1", E)]);
    expect(polled(s, box.path)).toBe(4);
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      [
        "alert",
        `fleet: cannot read agent-${B}.jsonl: ${fifo} is not a regular file`,
        fileUrl(fifo),
      ],
      [
        "alert",
        `fleet: cannot read agent-${C}.meta.json: ${sidecarC} is not a regular file`,
        fileUrl(sidecarC),
      ],
      [
        "alert",
        `fleet: cannot read agent-${D}.meta.json: ${sidecarD} is not a regular file`,
        fileUrl(sidecarD),
      ],
      ["alert", "agent builder-a: stuck 35 min on Bash", fileUrl(pathA)],
      ["note", "agent builder-e: started", fileUrl(pathE)],
      ["alert", "agent builder-e: stuck 35 min on Bash", fileUrl(pathE)],
      ["alert", `fleet: cannot list ${session.subagents}: ENOENT`, fileUrl(session.subagents)],
      ["note", "fleet: reading restored", fileUrl(fifo)],
      ["note", "fleet: reading restored", fileUrl(sidecarC)],
      ["note", "fleet: reading restored", fileUrl(sidecarD)],
      ["note", "fleet: reading restored", fileUrl(session.subagents)],
    ]);
    expect(s.log()).toContain(`${B}: ${fifo} is not a regular file`);
    expect(standing(s, box.path)).toEqual([
      "agent builder-a: stuck 35 min on Bash",
      "agent builder-e: stuck 35 min on Bash",
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a session transcript that cannot be read makes the whole poll a non-observation: one trouble alert, no transition from the stale lead state; the next readable poll restores the reading and says the stop", async () => {
    const s = new Scenario(PROGRAM, "lead");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const pathA = writeAgent(session, A, { name: "builder-a", description: "build" }, [
      pendingBash(ago(9), "toolu_01", A),
    ]);
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    appendLines(pathA, [toolResult(ago(5), "toolu_01"), said(ago(5), null)]);

    // The lead's file becomes unreadable on the poll that would have said the stall.
    rmSync(session.sessionFile);
    mkdirSync(session.sessionFile);
    expect(polled(s, box.path)).toBe(1);
    expect(polled(s, box.path)).toBe(0);

    rmSync(session.sessionFile, { recursive: true });
    writeFileSync(session.sessionFile, "");
    appendLines(session.sessionFile, [
      ...spawnLines("toolu_spawn", "builder-a", A, ago(8)),
      toolUse(ago(2), "toolu_stop", "TaskStop", { task_id: "builder-a" }, null),
      toolResult(ago(2), "toolu_stop", { agentId: null }),
    ]);
    expect(polled(s, box.path)).toBe(2);
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      [
        "alert",
        `fleet: cannot read the session transcript: ${session.sessionFile} is not a regular file`,
        fileUrl(session.sessionFile),
      ],
      ["note", "fleet: reading restored", fileUrl(session.sessionFile)],
      ["note", "agent builder-a: stopped by the lead", fileUrl(pathA)],
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test(
    "a subagents listing that fails under --repo is a non-observation for the worktrees too: no idle count advances and nothing is said; the next readable poll honours the claim the unread sidecar carried",
    async () => {
      const s = new Scenario(PROGRAM, "wide");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const {
        repo,
        worktrees: { "wt-a": wtA, "wt-b": wtB },
      } = scratchRepo(s.fixtureDir, TRACKS);
      writeAgent(
        session,
        A,
        { name: "builder-a", description: "build" },
        exchange(ago(0), "toolu_01"),
      );
      const parked = park(repo);
      try {
        await s.start({ inbox: box.path });
        watch(s, box.path, session, "--repo", repo, "--quiet-after", "1");
        const worker = park(wtB);
        expect(polled(s, box.path)).toBe(0);
        worker.kill();
        await worker.exited;
        expect(polled(s, box.path)).toBe(0);

        const pathB = writeAgent(
          session,
          B,
          { name: "builder-b", description: "build", worktreePath: wtA, worktreeBranch: "track-a" },
          exchange(ago(0), "toolu_02", B),
        );
        renameSync(session.subagents, `${session.subagents}.aside`);
        writeFileSync(session.subagents, "");
        expect(polled(s, box.path)).toBe(1);
        expect(s.state().targets[session.dir]).toMatchObject({
          worktrees: { [wtB]: { idlePolls: 1 } },
        });

        rmSync(session.subagents);
        renameSync(`${session.subagents}.aside`, session.subagents);
        expect(polled(s, box.path)).toBe(3);
        expect(polled(s, box.path)).toBe(0);
        expect(rows(s)).toEqual([
          ["alert", `fleet: cannot list ${session.subagents}: ENOTDIR`, fileUrl(session.subagents)],
          ["note", "fleet: reading restored", fileUrl(session.subagents)],
          ["note", "agent builder-b: started", fileUrl(pathB)],
          ["alert", "worktree track-b: idle 2 polls after work", fileUrl(wtB)],
        ]);
        const target = s.state().targets[session.dir] as { worktrees: Record<string, unknown> };
        expect(Object.keys(target.worktrees).sort()).toEqual([repo, wtB].sort());
      } finally {
        parked.kill();
      }
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test("a marker planted in a tool_result body, in toolUseResult, and in a prompt_snapshot attachment reaches no frame, no log line, no event, and no state file", async () => {
    const s = new Scenario(PROGRAM, "mark");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    writeAgent(session, A, { name: "builder-a", description: "build" }, [
      toolUse(ago(20), "toolu_01", "Bash", { command: `echo ${MARKER}` }),
      toolResult(ago(20), "toolu_01", {
        content: [{ type: "text", text: MARKER }],
        toolUseResult: { stdout: MARKER, stderr: "" },
      }),
      attachment(ago(20), { type: "prompt_snapshot", prompt: `${MARKER} ${notice("b1a2b3c4d")}` }),
      toolUse(ago(15), "toolu_02", "Bash", { command: `grep ${MARKER}`, timeout: TWO_MINUTES_MS }),
    ]);
    await s.start({ inbox: box.path });
    watch(s, box.path, session, "--quiet-after", "1");
    const frames = await box.frames(1);
    expect(frames).toHaveLength(1);
    expect(rows(s).map((row) => row[1])).toEqual(["agent builder-a: stuck 15 min on Bash"]);
    for (const text of [
      frames.join("\n"),
      s.log(),
      readFileSync(s.files().events, "utf-8"),
      readFileSync(s.files().state, "utf-8"),
    ]) {
      expect(text).not.toContain(MARKER);
    }
    s.stop({ inbox: box.path });
  }, 30000);

  test("watch session finds the session directory by CLAUDE_CODE_SESSION_ID under HOME in the CLI process, under a project directory that is not the cwd's slug, " +
    "and lays the tasks directory out under the harness temp root by that slug; without the variable, or with an id no project holds, it exits 2 naming it", async () => {
    const s = new Scenario(PROGRAM, "self");
    const box = await s.inbox("a");
    const home = join(s.fixtureDir, "home");
    // The project directory is the session's launch cwd, which the CLI's cwd no longer matches.
    const session = sessionDir(join(home, ".claude", "projects", "-home-user-repo"));
    const env = {
      CLAUDE_CODE_SESSION_ID: SESSION,
      HOME: home,
      CLAUDE_CODE_TMPDIR: claudeTmp(s).root,
    };
    await s.start({ inbox: box.path });
    const unset = s.run(["watch", "session"], {
      inbox: box.path,
      env: { ...env, CLAUDE_CODE_SESSION_ID: "" },
    });
    expect(unset.code).toBe(2);
    expect(unset.stderr).toContain("CLAUDE_CODE_SESSION_ID is unset");
    const lost = "00000000-0000-4000-8000-000000000000";
    const nowhere = s.run(["watch", "session"], {
      inbox: box.path,
      env: { ...env, CLAUDE_CODE_SESSION_ID: lost },
    });
    expect(nowhere.code).toBe(2);
    expect(nowhere.stderr).toContain(
      `no transcript ${lost}.jsonl under ${join(home, ".claude", "projects")}`,
    );

    const watched = s.run(["watch", "session", "--quiet-after", "1"], { inbox: box.path, env });
    expect(watched.code).toBe(0);
    expect(watched.stdout).toContain("watching session for session");
    expect(s.state().targets.session).toMatchObject({
      form: "session",
      sessionFile: session.sessionFile,
      subagentsDir: session.subagents,
      tasksDir: join(claudeTmp(s).root, "-home-user-repo", SESSION, "tasks"),
    });
    const path = writeAgent(
      session,
      A,
      { name: "builder-a", description: "build" },
      exchange(ago(0), "toolu_01"),
    );
    expect(polled(s, box.path)).toBe(1);
    expect(rows(s)).toEqual([["note", "agent builder-a: started", fileUrl(path)]]);
    // A note alone: the log has it, wait prints it with its level, and no message went out.
    const all = s.run(["wait", "--since", "0", "--timeout", "1"], { inbox: box.path });
    expect(all.code).toBe(0);
    expect(JSON.parse(all.stdout.trim().split("\n")[0] as string)).toMatchObject({
      id: 1,
      kind: "agent",
      level: "note",
      text: "agent builder-a: started",
    });
    expect(await delivered(box, 1)).toEqual([]);
    s.stop({ inbox: box.path });
  }, 30000);
});

describe("the two skills side by side", () => {
  test("installed as sibling folders, copied or symlinked, the fleet source finds the library; with the base removed it exits 2 naming the install command", () => {
    const layout = sideBySide(temp.dir("fleet-events-layout-"), [
      "session-events",
      "orchestrator-mode",
    ]);
    const run = (skillsDir: string) => {
      const result = Bun.spawnSync(
        [
          process.execPath,
          join(skillsDir, "orchestrator-mode", "scripts", "fleet-events.mts"),
          "status",
          "--id",
          "layout",
        ],
        {
          env: { ...process.env, SESSION_EVENTS_DIR: layout.runtime },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      return { code: result.exitCode, stderr: result.stderr.toString() };
    };
    for (const skillsDir of [layout.canon, layout.agent]) {
      const r = run(skillsDir);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain(
        `bun "${join(layout.canon, "orchestrator-mode", "scripts", "fleet-events.mts")}" daemon --id layout`,
      );
    }
    layout.remove("session-events");
    for (const skillsDir of [layout.canon, layout.agent]) {
      const r = run(skillsDir);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(
        "install it beside this skill: npx skills add Vivswan/skills -g --skill session-events",
      );
    }
  }, 30000);
});
