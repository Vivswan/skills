import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  renameSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type Activity,
  displayName,
  initialTranscript,
  isStopped,
  readIncrement,
  readSidecar,
  readTranscript,
  reduce,
  sessionPaths,
} from "../../../skills/orchestrator-mode/scripts/fleet/transcripts.mts";
import { tempDirs } from "../../helpers/temp-dirs";

// The reducer over the lines Claude Code writes to an agent's transcript: every fixture line here
// is hand-written in that schema (type, uuid, timestamp, message, toolUseResult, attachment), and
// each test pins the whole derived state, since a field that drifted silently (a pending call that
// never clears, a turn that never ends) is exactly what the fleet daemon would then say wrongly.

const temp = tempDirs();

const AGENT = "a1b2c3d4e5f60718";
const CHILD_A = "0a1b2c3d4e5f6071";
const CHILD_B = "1b2c3d4e5f607182";
const CHILD_C = "2c3d4e5f60718293";
const UNKNOWN = "3d4e5f6071829304";
const SESSION = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const MARKER = "MARKER-sunflower-9c1d";

type Line = Record<string, unknown>;

let uuid = 0;

function at(minute: number, second = 0): string {
  const mm = String(minute).padStart(2, "0");
  const ss = String(second).padStart(2, "0");
  return `2026-03-04T10:${mm}:${ss}.000Z`;
}

function envelope(type: string, timestamp: string): Line {
  uuid += 1;
  return {
    type,
    uuid: `u${uuid}`,
    parentUuid: uuid > 1 ? `u${uuid - 1}` : null,
    timestamp,
    sessionId: SESSION,
    agentId: AGENT,
    isSidechain: true,
    cwd: "/home/user/repo",
    gitBranch: "feat/example",
  };
}

function assistant(timestamp: string, block: Line, stopReason: string | null, index = 0): Line {
  return {
    ...envelope("assistant", timestamp),
    message: { id: "msg_01", role: "assistant", content: [block], stop_reason: stopReason },
    apiBlockIndex: index,
  };
}

function toolUse(timestamp: string, id: string, name: string, input: Line): Line {
  return assistant(timestamp, { type: "tool_use", id, name, input }, "tool_use");
}

function thinking(timestamp: string): Line {
  return assistant(timestamp, { type: "thinking", thinking: "weighing the options" }, null);
}

function said(timestamp: string, stopReason: string): Line {
  return assistant(timestamp, { type: "text", text: "done" }, stopReason, 1);
}

function toolResult(
  timestamp: string,
  toolUseId: string,
  options: { content?: unknown; toolUseResult?: unknown; isError?: boolean } = {},
): Line {
  const part: Line = {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: options.content ?? "ok",
  };
  if (options.isError) part.is_error = true;
  return {
    ...envelope("user", timestamp),
    message: { role: "user", content: [part] },
    toolUseResult: options.toolUseResult ?? { stdout: "ok", stderr: "" },
  };
}

function userText(timestamp: string, text: string, origin?: Line): Line {
  const line: Line = { ...envelope("user", timestamp), message: { role: "user", content: text } };
  if (origin) line.origin = origin;
  return line;
}

function attachment(timestamp: string, body: Line): Line {
  return { ...envelope("attachment", timestamp), attachment: body };
}

function notice(taskId: string, status = "completed"): string {
  return [
    "<task-notification>",
    `<task-id>${taskId}</task-id>`,
    `<status>${status}</status>`,
    "<summary>the task finished</summary>",
    "</task-notification>",
  ].join("\n");
}

function idle(name: string): string {
  return `<teammate-message teammate_id="${name}" summary="idle">\n{"type":"idle_notification","agent":"${name}"}\n</teammate-message>`;
}

function fold(lines: Line[]): Activity {
  return lines.reduce(reduce, initialTranscript().state);
}

function activity(overrides: Partial<Activity>): Activity {
  return {
    lastMovedAt: null,
    turn: "open",
    pending: {},
    jobs: {},
    children: {},
    lines: 0,
    skipped: 0,
    ...overrides,
  };
}

const launch = [
  toolUse(at(0), "toolu_01", "Bash", { command: "bun run check", run_in_background: true }),
  toolResult(at(0, 1), "toolu_01", {
    toolUseResult: { backgroundTaskId: "b1a2b3c4d", stdout: "", stderr: "" },
  }),
];

const spawns = [
  toolUse(at(0), "toolu_01", "Agent", {
    description: "build the reducer",
    subagent_type: "general-purpose",
    prompt: "build it",
    run_in_background: true,
  }),
  toolResult(at(0, 1), "toolu_01", {
    toolUseResult: { status: "async_launched", agentId: CHILD_A, description: "build the reducer" },
  }),
  toolUse(at(1), "toolu_02", "Agent", {
    name: "builder-b",
    description: "build the source",
    subagent_type: "general-purpose",
    prompt: "build it",
  }),
  toolResult(at(1, 1), "toolu_02", {
    toolUseResult: { status: "teammate_spawned", agentId: CHILD_B, name: "builder-b" },
  }),
  toolUse(at(2), "toolu_03", "Agent", {
    name: "reviewer",
    description: "review the source",
    subagent_type: "general-purpose",
    prompt: "review it",
    run_in_background: true,
  }),
  toolResult(at(2, 1), "toolu_03", {
    toolUseResult: { status: "async_launched", agentId: CHILD_C },
  }),
];

describe("the transcript reducer", () => {
  test("a tool_use with no tool_result is pending under its id with the tool's name and start time; the result clears it and the turn stays open", () => {
    const lines = [
      toolUse(at(0), "toolu_01", "Bash", { command: "bun test" }),
      toolResult(at(5), "toolu_01"),
    ];
    expect(fold(lines.slice(0, 1))).toEqual(
      activity({
        lastMovedAt: at(0),
        pending: { toolu_01: { tool: "Bash", at: at(0), taskId: null } },
        lines: 1,
      }),
    );
    expect(fold(lines)).toEqual(activity({ lastMovedAt: at(5), lines: 2 }));
  });

  test("a string user line arriving with calls pending abandons every one of them: the interruption reached the agent before any result did", () => {
    const lines = [
      toolUse(at(0), "toolu_01", "Bash", { command: "bun test" }),
      toolUse(at(0, 1), "toolu_02", "Read", { file_path: "/home/user/repo/README.md" }),
      userText(at(2), "stop, change of plan"),
    ];
    expect(fold(lines)).toEqual(activity({ lastMovedAt: at(2), lines: 3 }));
  });

  test("only a message's last block ends the turn: a thinking block's null stop_reason keeps it open, the final end_turn block ends it, a later user line reopens it, and a synthetic API-error stop_sequence never ends it", () => {
    const lines = [
      toolUse(at(0), "toolu_01", "Bash", { command: "bun test" }),
      toolResult(at(1), "toolu_01"),
      thinking(at(3)),
      said(at(3, 1), "end_turn"),
      userText(at(9), "one more thing"),
    ];
    expect(fold(lines.slice(0, 3))).toEqual(activity({ lastMovedAt: at(3), lines: 3 }));
    expect(fold(lines.slice(0, 4))).toEqual(
      activity({ lastMovedAt: at(3, 1), turn: "ended", lines: 4 }),
    );
    expect(fold(lines)).toEqual(activity({ lastMovedAt: at(9), lines: 5 }));
    expect(fold([said(at(0), "stop_sequence")])).toEqual(
      activity({ lastMovedAt: at(0), lines: 1 }),
    );
  });

  test("a backgroundTaskId is a job until its notice clears it, as a user string (form A) or a queued_command attachment (form B); a foreground command that timed out and moved to the background is a job the same way", () => {
    const movedOut = [
      toolUse(at(1), "toolu_02", "Bash", { command: "sleep 500", timeout: 120000 }),
      toolResult(at(3), "toolu_02", {
        toolUseResult: { backgroundTaskId: "b9z8y7x6w", stdout: "", stderr: "", timedOut: true },
      }),
    ];
    expect(fold([...launch, ...movedOut])).toEqual(
      activity({
        lastMovedAt: at(3),
        jobs: { b1a2b3c4d: { at: at(0, 1) }, b9z8y7x6w: { at: at(3) } },
        lines: 4,
      }),
    );
    const formA = userText(at(5), notice("b1a2b3c4d"), { kind: "task-notification" });
    const formB = attachment(at(6), {
      type: "queued_command",
      commandMode: "task-notification",
      prompt: notice("b9z8y7x6w", "failed"),
    });
    expect(fold([...launch, ...movedOut, formA, formB])).toEqual(
      activity({ lastMovedAt: at(6), lines: 6 }),
    );
  });

  test("a prompt_snapshot or any other attachment spelling the notification tags is noise, never a notice: the job it names stays", () => {
    const lines = [
      ...launch,
      attachment(at(2), { type: "prompt_snapshot", prompt: notice("b1a2b3c4d") }),
      attachment(at(2, 1), { type: "environment", content: notice("b1a2b3c4d") }),
      attachment(at(2, 2), {
        type: "queued_command",
        commandMode: "prompt",
        prompt: notice("b1a2b3c4d"),
      }),
    ];
    expect(fold(lines)).toEqual(
      activity({ lastMovedAt: at(2, 2), jobs: { b1a2b3c4d: { at: at(0, 1) } }, lines: 5 }),
    );
  });

  test("either spawn status is a running child named by the result or the call; a notice finishes one, an idle notification another, a TaskStop by name stops the third once its result lands, an errored stop or an unknown id records nothing", () => {
    const running = activity({
      lastMovedAt: at(2, 1),
      children: {
        [CHILD_A]: { name: null, at: at(0, 1), outcome: "running" },
        [CHILD_B]: { name: "builder-b", at: at(1, 1), outcome: "running" },
        [CHILD_C]: { name: "reviewer", at: at(2, 1), outcome: "running" },
      },
      lines: 6,
    });
    expect(fold(spawns)).toEqual(running);
    const stopping = [
      ...spawns,
      attachment(at(10), {
        type: "queued_command",
        commandMode: "task-notification",
        prompt: notice(CHILD_A),
      }),
      userText(at(11), idle("builder-b")),
      toolUse(at(12), "toolu_04", "TaskStop", { task_id: "reviewer" }),
    ];
    // Before the result lands, the stop is a pending call and the child still runs.
    expect(fold(stopping)).toEqual(
      activity({
        lastMovedAt: at(12),
        pending: { toolu_04: { tool: "TaskStop", at: at(12), taskId: "reviewer" } },
        children: {
          [CHILD_A]: { name: null, at: at(0, 1), outcome: "finished" },
          [CHILD_B]: { name: "builder-b", at: at(1, 1), outcome: "finished" },
          [CHILD_C]: { name: "reviewer", at: at(2, 1), outcome: "running" },
        },
        lines: 9,
      }),
    );
    const state = fold([
      ...stopping,
      toolResult(at(12, 1), "toolu_04"),
      toolUse(at(13), "toolu_05", "TaskStop", { task_id: UNKNOWN }),
      toolResult(at(13, 1), "toolu_05"),
      toolUse(at(14), "toolu_06", "TaskStop", { task_id: CHILD_A }),
      toolResult(at(14, 1), "toolu_06", { content: "no running task", isError: true }),
    ]);
    expect(state).toEqual(
      activity({
        lastMovedAt: at(14, 1),
        children: {
          [CHILD_A]: { name: null, at: at(0, 1), outcome: "finished" },
          [CHILD_B]: { name: "builder-b", at: at(1, 1), outcome: "finished" },
          [CHILD_C]: { name: "reviewer", at: at(2, 1), outcome: "stopped" },
        },
        lines: 14,
      }),
    );
    expect([CHILD_A, CHILD_B, CHILD_C, UNKNOWN].map((id) => isStopped(state, id, null))).toEqual([
      false,
      false,
      true,
      false,
    ]);
    // A sidecar names the agent and the stop named it too, under an id the stop did not carry.
    expect(isStopped(state, "ffffffffffffffff", "reviewer")).toBe(true);
    expect(isStopped(state, "ffffffffffffffff", null)).toBe(false);
  });

  test("a name is rebound to the latest agent spawned under it (Claude Code's own rule): isStopped, an idle notification, and a TaskStop by that name resolve to it, never to a stopped or finished predecessor", () => {
    const REBORN = "4e5f607182930415";
    const lines = [
      ...spawns,
      toolUse(at(12), "toolu_04", "TaskStop", { task_id: "reviewer" }),
      toolResult(at(12, 1), "toolu_04"),
      toolUse(at(20), "toolu_05", "Agent", {
        name: "reviewer",
        description: "review the source again",
        subagent_type: "general-purpose",
        prompt: "review it",
      }),
      toolResult(at(20, 1), "toolu_05", {
        toolUseResult: { status: "teammate_spawned", agentId: REBORN, name: "reviewer" },
      }),
    ];
    const rebound = fold(lines);
    expect(rebound.children).toEqual({
      [CHILD_A]: { name: null, at: at(0, 1), outcome: "running" },
      [CHILD_B]: { name: "builder-b", at: at(1, 1), outcome: "running" },
      [CHILD_C]: { name: "reviewer", at: at(2, 1), outcome: "stopped" },
      [REBORN]: { name: "reviewer", at: at(20, 1), outcome: "running" },
    });
    expect(isStopped(rebound, REBORN, "reviewer")).toBe(false);
    expect(isStopped(rebound, CHILD_C, "reviewer")).toBe(true);
    expect(isStopped(rebound, "ffffffffffffffff", "reviewer")).toBe(false);

    const idled = fold([...lines, userText(at(25), idle("reviewer"))]);
    expect(idled.children[REBORN]?.outcome).toBe("finished");
    expect(idled.children[CHILD_C]?.outcome).toBe("stopped");

    const stopped = fold([
      ...lines,
      toolUse(at(30), "toolu_06", "TaskStop", { task_id: "reviewer" }),
      toolResult(at(30, 1), "toolu_06"),
    ]);
    expect(stopped.children[REBORN]?.outcome).toBe("stopped");
    expect(isStopped(stopped, REBORN, "reviewer")).toBe(true);
  });

  test("timestamps are not monotonic (a queued attachment keeps its enqueue time), and lastMovedAt never moves backwards", () => {
    const lines = [
      toolUse(at(30), "toolu_01", "Bash", { command: "bun test" }),
      toolResult(at(31), "toolu_01"),
      attachment(at(0), { type: "total_tokens_reminder", content: "n tokens left" }),
      said(at(31, 5), "end_turn"),
    ];
    expect(fold(lines.slice(0, 3))).toEqual(activity({ lastMovedAt: at(31), lines: 3 }));
    expect(fold(lines)).toEqual(activity({ lastMovedAt: at(31, 5), turn: "ended", lines: 4 }));
  });

  test("the state carries ids, names, tool names, and times only: a marker planted in a tool_result body (string and array forms), in toolUseResult, in a call's input, in a prompt, and in a prompt_snapshot reaches no field", () => {
    const lines = [
      toolUse(at(0), "toolu_01", "Bash", { command: `echo ${MARKER}` }),
      toolResult(at(1), "toolu_01", {
        content: [{ type: "text", text: MARKER }],
        toolUseResult: { stdout: MARKER, stderr: "" },
      }),
      toolResult(at(1, 1), "toolu_09", { content: `${MARKER} again`, isError: true }),
      attachment(at(2), { type: "prompt_snapshot", prompt: MARKER }),
      userText(at(3), `please ${MARKER}`),
      toolUse(at(4), "toolu_02", "Agent", {
        description: MARKER,
        prompt: MARKER,
        subagent_type: "general-purpose",
        run_in_background: true,
      }),
      toolResult(at(4, 1), "toolu_02", {
        toolUseResult: { status: "async_launched", agentId: CHILD_A, description: MARKER },
      }),
    ];
    const state = fold(lines);
    expect(JSON.stringify(state)).not.toContain(MARKER);
    expect(state).toEqual(
      activity({
        lastMovedAt: at(4, 1),
        children: { [CHILD_A]: { name: null, at: at(4, 1), outcome: "running" } },
        lines: 7,
      }),
    );
  });
});

describe("the incremental reader", () => {
  test("the reader resumes at its byte offset: a cut line completes next read, growth inside it is movement, a 1.3 MB line is one line, a non-JSON line is skipped and counted, mtime floors lastMovedAt, a shrunk or replaced file starts over", () => {
    const dir = temp.dir("fleet-transcripts-");
    const file = join(dir, `agent-${AGENT}.jsonl`);
    const cursor = (offset: number) => {
      const stat = statSync(file);
      return { offset, ino: stat.ino, size: stat.size };
    };
    const first = JSON.stringify(toolUse(at(0), "toolu_01", "Bash", { command: "bun test" }));
    const second = JSON.stringify(toolResult(at(1), "toolu_01"));
    writeFileSync(file, `${first}\n${second.slice(0, 40)}`);
    utimesSync(file, new Date(at(0, 30)), new Date(at(0, 30)));
    const transcript = initialTranscript();

    expect(readTranscript(transcript, file)).toBe(true);
    const pending = activity({
      lastMovedAt: at(0, 30),
      pending: { toolu_01: { tool: "Bash", at: at(0), taskId: null } },
      lines: 1,
    });
    expect(transcript).toEqual({ cursor: cursor(Buffer.byteLength(first) + 1), state: pending });
    expect(readTranscript(transcript, file)).toBe(false);

    // The unfinished line grows without a newline: movement, nothing new to fold.
    appendFileSync(file, second.slice(40, 60));
    utimesSync(file, new Date(at(0, 45)), new Date(at(0, 45)));
    expect(readTranscript(transcript, file)).toBe(true);
    expect(transcript).toEqual({
      cursor: cursor(Buffer.byteLength(first) + 1),
      state: { ...pending, lastMovedAt: at(0, 45) },
    });

    const big = JSON.stringify(toolResult(at(2), "toolu_02", { content: "x".repeat(1_300_000) }));
    appendFileSync(file, `${second.slice(60)}\n${big}\nnot json at all\n`);
    utimesSync(file, new Date(at(1)), new Date(at(1)));
    expect(readTranscript(transcript, file)).toBe(true);
    expect(transcript).toEqual({
      cursor: cursor(Buffer.byteLength(`${first}\n${second}\n${big}\nnot json at all\n`)),
      state: activity({ lastMovedAt: at(2), lines: 3, skipped: 1 }),
    });

    const fresh = JSON.stringify(said(at(40), "end_turn"));
    truncateSync(file, 0);
    appendFileSync(file, `${fresh}\n`);
    utimesSync(file, new Date(at(40)), new Date(at(40)));
    expect(readTranscript(transcript, file)).toBe(true);
    expect(transcript).toEqual({
      cursor: cursor(Buffer.byteLength(fresh) + 1),
      state: activity({ lastMovedAt: at(40), turn: "ended", lines: 1 }),
    });

    // Replaced by a longer file under the same name: another inode, so the old offset means nothing.
    const swapped = JSON.stringify(
      toolUse(at(50), "toolu_09", "Bash", { command: "y".repeat(600) }),
    );
    const staging = `${file}.next`;
    writeFileSync(staging, `${swapped}\n`);
    utimesSync(staging, new Date(at(50)), new Date(at(50)));
    renameSync(staging, file);
    expect(readTranscript(transcript, file)).toBe(true);
    expect(transcript).toEqual({
      cursor: cursor(Buffer.byteLength(swapped) + 1),
      state: activity({
        lastMovedAt: at(50),
        pending: { toolu_09: { tool: "Bash", at: at(50), taskId: null } },
        lines: 1,
      }),
    });

    expect(() => readIncrement(dir, { offset: 0, ino: null, size: 0 })).toThrow(
      `${dir} is not a regular file`,
    );
  });
});

describe("the files Claude Code writes", () => {
  test("sessionPaths maps the cwd to the project slug (every non-alphanumeric becomes a dash) under <home>/.claude/projects; displayName falls back name, description, agentId; a missing sidecar is null, a malformed or non-regular one throws", () => {
    expect(sessionPaths("/home/user/repo", SESSION, "/home/user")).toEqual({
      sessionFile: `/home/user/.claude/projects/-home-user-repo/${SESSION}.jsonl`,
      subagentsDir: `/home/user/.claude/projects/-home-user-repo/${SESSION}/subagents`,
    });
    expect(sessionPaths("/srv/my_app.v2", SESSION, "/root")).toEqual({
      sessionFile: `/root/.claude/projects/-srv-my-app-v2/${SESSION}.jsonl`,
      subagentsDir: `/root/.claude/projects/-srv-my-app-v2/${SESSION}/subagents`,
    });

    const dir = temp.dir("fleet-sidecars-");
    const named = join(dir, `agent-${CHILD_A}.meta.json`);
    writeFileSync(
      named,
      JSON.stringify({
        name: "builder-a",
        description: "move the sweep",
        agentType: "general-purpose",
        spawnDepth: 1,
        toolUseId: "toolu_01",
        taskKind: "teammate",
        teamName: "fleet",
        worktreePath: "/home/user/repo/.worktrees/sweep",
        worktreeBranch: "refactor/sweep",
      }),
    );
    utimesSync(named, new Date(at(0)), new Date(at(0)));
    const described = join(dir, `agent-${CHILD_B}.meta.json`);
    writeFileSync(
      described,
      JSON.stringify({ description: "review the source", agentType: "Explore", spawnDepth: 1 }),
    );
    const broken = join(dir, `agent-${CHILD_C}.meta.json`);
    writeFileSync(broken, "{ not json");

    const sidecar = readSidecar(named);
    expect(sidecar).toEqual({
      name: "builder-a",
      description: "move the sweep",
      agentType: "general-purpose",
      parentAgentId: null,
      worktreePath: "/home/user/repo/.worktrees/sweep",
      worktreeBranch: "refactor/sweep",
      toolUseId: "toolu_01",
      spawnedAt: at(0),
    });
    expect(displayName(CHILD_A, sidecar)).toBe("builder-a");
    expect(displayName(CHILD_B, readSidecar(described))).toBe("review the source");
    expect(() => readSidecar(broken)).toThrow(`${broken} is not a JSON object`);
    expect(() => readSidecar(dir)).toThrow(`${dir} is not a regular file`);
    expect(readSidecar(join(dir, `agent-${UNKNOWN}.meta.json`))).toBeNull();
  });
});
