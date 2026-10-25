import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  renameSync,
  statSync,
  symlinkSync,
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
  locateSession,
  normalizeTranscript,
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

/** Every fixture opens with an assistant line at `at(0)`, so the newest run begins there until an input and the line after it move it. */
function activity(overrides: Partial<Activity>): Activity {
  return {
    lastMovedAt: null,
    runSince: at(0),
    runPending: false,
    turn: "open",
    pending: {},
    jobs: {},
    children: {},
    stops: {},
    named: {},
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
  test("a tool_use with no tool_result is pending under its id with the tool's name, start time, and its own timeout when it names one; the result clears it and the turn stays open", () => {
    const lines = [
      toolUse(at(0), "toolu_01", "Bash", { command: "bun test" }),
      toolResult(at(5), "toolu_01"),
    ];
    expect(fold(lines.slice(0, 1))).toEqual(
      activity({
        lastMovedAt: at(0),
        pending: { toolu_01: { tool: "Bash", at: at(0), taskId: null, timeoutMs: null } },
        lines: 1,
      }),
    );
    expect(fold(lines)).toEqual(activity({ lastMovedAt: at(5), lines: 2 }));
    const timed = toolUse(at(0), "toolu_02", "Bash", { command: "bun test", timeout: 120000 });
    expect(fold([timed]).pending).toEqual({
      toolu_02: { tool: "Bash", at: at(0), taskId: null, timeoutMs: 120000 },
    });
  });

  test("a string user line arriving with calls pending abandons every one of them: the interruption reached the agent before any result did", () => {
    const lines = [
      toolUse(at(0), "toolu_01", "Bash", { command: "bun test" }),
      toolUse(at(0, 1), "toolu_02", "Read", { file_path: "/home/user/repo/README.md" }),
      userText(at(2), "stop, change of plan"),
    ];
    expect(fold(lines)).toEqual(
      activity({
        lastMovedAt: at(2),
        runPending: true,
        named: { "/home/user/repo/README.md": at(0, 1) },
        lines: 3,
      }),
    );
  });

  test("a user line whose content is an array with no tool_result is injected input like a string: its text blocks abandon pending calls and carry an idle notice, while an array with a tool_result clears that call alone", () => {
    const pending = [
      toolUse(at(0), "toolu_01", "Bash", { command: "bun test" }),
      toolUse(at(0, 1), "toolu_02", "Read", { file_path: "/home/user/repo/README.md" }),
    ];
    const blocks = (...texts: string[]): Line => ({
      ...envelope("user", at(2)),
      message: { role: "user", content: texts.map((text) => ({ type: "text", text })) },
    });
    expect(fold([...pending, blocks("stop,", "change of plan")])).toEqual(
      activity({
        lastMovedAt: at(2),
        runPending: true,
        named: { "/home/user/repo/README.md": at(0, 1) },
        lines: 3,
      }),
    );
    const mixed: Line = {
      ...envelope("user", at(2)),
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_01", content: "ok" },
          { type: "text", text: "and a note beside the result" },
        ],
      },
      toolUseResult: { stdout: "ok", stderr: "" },
    };
    expect(fold([...pending, mixed])).toEqual(
      activity({
        lastMovedAt: at(2),
        pending: { toolu_02: { tool: "Read", at: at(0, 1), taskId: null, timeoutMs: null } },
        named: { "/home/user/repo/README.md": at(0, 1) },
        lines: 3,
      }),
    );
    const idleInArray = {
      ...blocks(
        '<teammate-message teammate_id="reviewer" summary="s">\n{"type":"idle_notification","agent":"reviewer"}\n</teammate-message>',
      ),
      timestamp: at(10),
    };
    expect(fold([...spawns, idleInArray]).children[CHILD_C]).toEqual({
      name: "reviewer",
      at: at(2, 1),
      since: at(2, 1),
      outcome: "finished",
      finishedAt: at(10),
    });
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
    expect(fold(lines)).toEqual(activity({ lastMovedAt: at(9), runPending: true, lines: 5 }));
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
      activity({ lastMovedAt: at(6), runPending: true, lines: 6 }),
    );
  });

  test("a task notification reopens the turn in either form: after an end_turn, the attachment form clears the job and leaves the turn open, as the string form does", () => {
    const ended = [...launch, said(at(2), "end_turn")];
    expect(fold(ended).turn).toBe("ended");
    const formB = attachment(at(6), {
      type: "queued_command",
      commandMode: "task-notification",
      prompt: notice("b1a2b3c4d"),
    });
    expect(fold([...ended, formB])).toEqual(
      activity({ lastMovedAt: at(6), runPending: true, lines: 4 }),
    );
    const formA = userText(at(6), notice("b1a2b3c4d"), { kind: "task-notification" });
    expect(fold([...ended, formA])).toEqual(
      activity({ lastMovedAt: at(6), runPending: true, lines: 4 }),
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

  test("either spawn status is a running child; a notice finishes one, an idle notification another, a TaskStop by name stops the third at its result; an errored stop records nothing, an id never spawned here is a stop by that id", () => {
    const running = activity({
      lastMovedAt: at(2, 1),
      children: {
        [CHILD_A]: {
          name: null,
          at: at(0, 1),
          since: at(0, 1),
          outcome: "running",
          finishedAt: null,
        },
        [CHILD_B]: {
          name: "builder-b",
          at: at(1, 1),
          since: at(1, 1),
          outcome: "running",
          finishedAt: null,
        },
        [CHILD_C]: {
          name: "reviewer",
          at: at(2, 1),
          since: at(2, 1),
          outcome: "running",
          finishedAt: null,
        },
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
        runSince: at(12),
        pending: {
          toolu_04: { tool: "TaskStop", at: at(12), taskId: "reviewer", timeoutMs: null },
        },
        children: {
          [CHILD_A]: {
            name: null,
            at: at(0, 1),
            since: at(0, 1),
            outcome: "finished",
            finishedAt: at(10),
          },
          [CHILD_B]: {
            name: "builder-b",
            at: at(1, 1),
            since: at(1, 1),
            outcome: "finished",
            finishedAt: at(11),
          },
          [CHILD_C]: {
            name: "reviewer",
            at: at(2, 1),
            since: at(2, 1),
            outcome: "running",
            finishedAt: null,
          },
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
        runSince: at(12),
        children: {
          [CHILD_A]: {
            name: null,
            at: at(0, 1),
            since: at(0, 1),
            outcome: "finished",
            finishedAt: at(10),
          },
          [CHILD_B]: {
            name: "builder-b",
            at: at(1, 1),
            since: at(1, 1),
            outcome: "finished",
            finishedAt: at(11),
          },
          [CHILD_C]: {
            name: "reviewer",
            at: at(2, 1),
            since: at(2, 1),
            outcome: "stopped",
            finishedAt: null,
          },
        },
        stops: { [UNKNOWN]: at(13, 1) },
        lines: 14,
      }),
    );
    expect([CHILD_A, CHILD_B, CHILD_C, UNKNOWN].map((id) => isStopped(state, id, null))).toEqual([
      false,
      false,
      true,
      true,
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
      [CHILD_A]: {
        name: null,
        at: at(0, 1),
        since: at(0, 1),
        outcome: "running",
        finishedAt: null,
      },
      [CHILD_B]: {
        name: "builder-b",
        at: at(1, 1),
        since: at(1, 1),
        outcome: "running",
        finishedAt: null,
      },
      [CHILD_C]: {
        name: "reviewer",
        at: at(2, 1),
        since: at(2, 1),
        outcome: "stopped",
        finishedAt: null,
      },
      [REBORN]: {
        name: "reviewer",
        at: at(20, 1),
        since: at(20, 1),
        outcome: "running",
        finishedAt: null,
      },
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

  test("an idle notification is one bare JSON body under its own envelope tag whose top-level type says so: only its sender is finished whatever the order, a nested type field or a quoted tag is no notification, a batch with none interrupts", () => {
    const batch = (...parts: Array<[string, string]>): string =>
      parts
        .map(
          ([name, body]) =>
            `<teammate-message teammate_id="${name}" summary="s">\n${body}\n</teammate-message>`,
        )
        .join("\n");
    const idleReviewer = '{"type":"idle_notification","agent":"reviewer"}';
    const running: Activity["children"] = {
      [CHILD_A]: {
        name: null,
        at: at(0, 1),
        since: at(0, 1),
        outcome: "running",
        finishedAt: null,
      },
      [CHILD_B]: {
        name: "builder-b",
        at: at(1, 1),
        since: at(1, 1),
        outcome: "running",
        finishedAt: null,
      },
      [CHILD_C]: {
        name: "reviewer",
        at: at(2, 1),
        since: at(2, 1),
        outcome: "running",
        finishedAt: null,
      },
    };
    const reviewerDone: Activity["children"] = {
      ...running,
      [CHILD_C]: {
        name: "reviewer",
        at: at(2, 1),
        since: at(2, 1),
        outcome: "finished",
        finishedAt: at(10),
      },
    };
    const line = (...parts: Array<[string, string]>) => userText(at(10), batch(...parts));
    expect(
      fold([...spawns, line(["builder-b", "still working on it"], ["reviewer", idleReviewer])])
        .children,
    ).toEqual(reviewerDone);
    expect(
      fold([...spawns, line(["reviewer", idleReviewer], ["builder-b", "still working on it"])])
        .children,
    ).toEqual(reviewerDone);
    const quotedTag = 'I saw `<teammate-message teammate_id="quoted">` in the parser';
    expect(
      fold([
        ...spawns,
        line(["builder-b", quotedTag], ["reviewer", idleReviewer], ["other", "fine"]),
      ]).children,
    ).toEqual(reviewerDone);
    const tagInJson = '{"note":"a literal <teammate-message tag","type":"idle_notification"}';
    expect(fold([...spawns, line(["reviewer", tagInJson])]).children).toEqual(running);
    // Idleness is the body's top-level type, parsed, never a nested field that spells it.
    const nestedType = '{"type":"message","example":{"type":"idle_notification"}}';
    expect(fold([...spawns, line(["reviewer", nestedType])]).children).toEqual(running);
    const reordered = '{"agent":"reviewer","type":"idle_notification"}';
    expect(fold([...spawns, line(["reviewer", reordered])]).children).toEqual(reviewerDone);
    const interrupted = fold([
      ...spawns,
      toolUse(at(11), "toolu_09", "Bash", { command: "bun test" }),
      line(["builder-b", "still working on it"]),
    ]);
    expect(interrupted.pending).toEqual({});
  });

  test(
    "a notice block is pure or counts nothing: every notice in a block of notices alone counts, in one string or in two text blocks, " +
      "while a block carrying a teammate envelope or prose counts no notice, quoted ones included, and an idle envelope beside a notice still finishes its sender",
    () => {
      const twoJobs = [
        ...launch,
        toolUse(at(1), "toolu_02", "Bash", { command: "bun run lint", run_in_background: true }),
        toolResult(at(1, 1), "toolu_02", {
          toolUseResult: { backgroundTaskId: "b9z8y7x6w", stdout: "", stderr: "" },
        }),
      ];
      const both = `${notice("b1a2b3c4d")}\n${notice("b9z8y7x6w", "failed")}`;
      expect(fold([...twoJobs, userText(at(5), both)])).toEqual(
        activity({ lastMovedAt: at(5), runPending: true, lines: 5 }),
      );
      const blocks: Line = {
        ...envelope("user", at(5)),
        message: {
          role: "user",
          content: [
            { type: "text", text: notice("b1a2b3c4d") },
            { type: "text", text: notice("b9z8y7x6w", "failed") },
          ],
        },
      };
      expect(fold([...twoJobs, blocks])).toEqual(
        activity({ lastMovedAt: at(5), runPending: true, lines: 5 }),
      );
      // The harness writes each queued item as its own block, so a notice beside an envelope is a
      // teammate's words: the idle envelope still finishes its sender, the notice counts for nothing.
      const idleReviewer =
        '<teammate-message teammate_id="reviewer" summary="s">\n{"type":"idle_notification","agent":"reviewer"}\n</teammate-message>';
      const mixed = fold([
        ...spawns,
        ...launch,
        userText(at(10), `${notice("b1a2b3c4d")}\n${idleReviewer}`),
      ]);
      expect(mixed.jobs).toEqual({ b1a2b3c4d: { at: at(0, 1) } });
      expect(mixed.children[CHILD_C]?.outcome).toBe("finished");
      expect(mixed.children[CHILD_A]?.outcome).toBe("running");
      // A notice quoted inside a teammate's message is that teammate's words: the job runs on, and the
      // message interrupts the pending call like any other.
      const quoted = `<teammate-message teammate_id="reviewer" summary="example">\nUse this parser fixture: ${notice("b1a2b3c4d")}\n</teammate-message>`;
      const interrupted = fold([
        ...launch,
        toolUse(at(2), "toolu_09", "Read", { file_path: "/home/user/repo/README.md" }),
        userText(at(3), quoted),
      ]);
      expect(interrupted).toEqual(
        activity({
          lastMovedAt: at(3),
          runPending: true,
          jobs: { b1a2b3c4d: { at: at(0, 1) } },
          named: { "/home/user/repo/README.md": at(2) },
          lines: 4,
        }),
      );
      // A real notice up front lends nothing to the block: with an envelope in it, neither counts.
      const quotedB = `<teammate-message teammate_id="reviewer" summary="example">\nUse this parser fixture: ${notice("b9z8y7x6w")}\n</teammate-message>`;
      expect(fold([...twoJobs, userText(at(5), `${notice("b1a2b3c4d")}\n${quotedB}`)])).toEqual(
        activity({
          lastMovedAt: at(5),
          runPending: true,
          jobs: { b1a2b3c4d: { at: at(0, 1) }, b9z8y7x6w: { at: at(1, 1) } },
          lines: 5,
        }),
      );
      // A teammate's envelope that itself quotes an envelope: the inner closing tag once ended the
      // span the reducer stripped, and the quoted notice after it finished the job it named.
      const nested = `${notice("b1a2b3c4d")}\n<teammate-message teammate_id="reviewer">\nExamples: <teammate-message teammate_id="example">text</teammate-message> and ${notice("b9z8y7x6w")}\n</teammate-message>`;
      expect(fold([...twoJobs, userText(at(5), nested)]).jobs).toEqual({
        b1a2b3c4d: { at: at(0, 1) },
        b9z8y7x6w: { at: at(1, 1) },
      });
      // Written as the harness writes it, each queued item its own block, the real notice counts.
      const split: Line = {
        ...envelope("user", at(5)),
        message: {
          role: "user",
          content: [
            { type: "text", text: notice("b1a2b3c4d") },
            { type: "text", text: nested.slice(notice("b1a2b3c4d").length + 1) },
          ],
        },
      };
      expect(fold([...twoJobs, split]).jobs).toEqual({ b9z8y7x6w: { at: at(1, 1) } });
      // Prose around a notice, or a notice cut short, is not a block of notices.
      const prosed = `Done: ${notice("b1a2b3c4d")}`;
      expect(fold([...launch, userText(at(5), prosed)]).jobs).toEqual({
        b1a2b3c4d: { at: at(0, 1) },
      });
      const cut = notice("b1a2b3c4d").replace("</task-notification>", "");
      expect(fold([...launch, userText(at(5), cut)]).jobs).toEqual({ b1a2b3c4d: { at: at(0, 1) } });
      // Prose or an envelope BETWEEN two notices is as impure as one around them: a pattern over the
      // whole block once backtracked across the first closing tag and counted both.
      const between = `${notice("b1a2b3c4d")}\nprose\n${notice("b9z8y7x6w")}`;
      expect(fold([...twoJobs, userText(at(5), between)]).jobs).toEqual({
        b1a2b3c4d: { at: at(0, 1) },
        b9z8y7x6w: { at: at(1, 1) },
      });
      // A block of many empty elements and a stray byte is read in one pass, never by backtracking.
      const many = `${"<task-notification></task-notification>".repeat(5000)}!`;
      const unclosed = `<task-notification><task-id>x${" ".repeat(200_000)}</task-notification>`;
      const started = performance.now();
      expect(fold([...launch, userText(at(5), many)]).jobs).toEqual({
        b1a2b3c4d: { at: at(0, 1) },
      });
      expect(fold([...launch, userText(at(5), unclosed)]).jobs).toEqual({
        b1a2b3c4d: { at: at(0, 1) },
      });
      expect(performance.now() - started).toBeLessThan(1000);
    },
  );

  test(
    "the absolute paths a tool call's input names are kept, resolved and distinct: a path field's value whole, a command's quoted paths whole and its bare paths, " +
      "a nested or flag value, never a tool result or a user text; a space never cuts a path short, and a command that starts with a program's path is still read for its paths",
    () => {
      const named = fold([
        toolUse(at(0), "toolu_01", "Bash", {
          command: "git -C /repo/.worktrees/alerts/ status && ls /repo/.worktrees/alerts",
        }),
        toolResult(at(1), "toolu_01", {
          content: [{ type: "text", text: "/repo/.worktrees/other is clean" }],
        }),
        toolUse(at(2), "toolu_02", "Agent", {
          description: "look",
          prompt: "read /repo/docs/a.md and /repo/docs/b.md, then `/repo/.worktrees/x[1]/file`",
          nested: { paths: ["/repo/docs/a.md", "--repo=/repo/here"] },
        }),
        toolResult(at(3), "toolu_02"),
        toolUse(at(4), "toolu_03", "Read", { file_path: "/repo/.worktrees/x y/notes.md" }),
        toolResult(at(5), "toolu_03"),
        toolUse(at(6), "toolu_04", "Bash", {
          command: `/usr/bin/git -C "/repo/.worktrees/x y" status; ls '/repo/.worktrees/x z'`,
        }),
        toolResult(at(7), "toolu_04"),
        toolUse(at(8), "toolu_05", "Bash", { command: "git -C C:/repo/.worktrees/x status" }),
        toolResult(at(9), "toolu_05"),
        userText(at(10), "and /tmp/user-text is not a tool call"),
      ]).named;
      // Least recently named first, each with the time of its newest naming: a.md, named in the
      // prompt and again in the nested list, sits after b.md.
      expect(Object.entries(named)).toEqual([
        ["/repo/.worktrees/alerts", at(0)],
        ["/repo/docs/b.md", at(2)],
        ["/repo/.worktrees/x[1]/file", at(2)],
        ["/repo/docs/a.md", at(2)],
        ["/repo/here", at(2)],
        ["/repo/.worktrees/x y/notes.md", at(4)],
        ["/usr/bin/git", at(6)],
        ["/repo/.worktrees/x y", at(6)],
        ["/repo/.worktrees/x z", at(6)],
      ]);
    },
  );

  test("a path named again moves to the newest position, so a worktree a builder names in every command never lapses from the thousand-path bound, while a path named once early is the one evicted", () => {
    const lines: Line[] = [toolUse(at(0), "toolu_once", "Read", { file_path: "/once/early" })];
    for (let n = 0; n < 1000; n += 1) {
      lines.push(
        toolUse(at(1, n % 60), `toolu_${n}`, "Bash", {
          command: `cd /repo/.worktrees/x && cat /other/file-${n}`,
        }),
      );
    }
    const named = fold(lines).named;
    const paths = Object.keys(named);
    expect(paths).toHaveLength(1000);
    expect(paths.slice(-2)).toEqual(["/repo/.worktrees/x", "/other/file-999"]);
    expect(named["/repo/.worktrees/x"]).toBe(at(1, 999 % 60));
    expect(paths).not.toContain("/once/early");
  });

  test("a resume keeps the child's spawn time: a send or a TaskStop by name reaches the latest spawn, not the resumed elder, while the elder's idle notification by that name finishes the elder, the running one", () => {
    const reviewer = {
      name: "reviewer",
      description: "review",
      subagent_type: "general-purpose",
      prompt: "review",
      run_in_background: true,
    };
    const twoReviewers = [
      toolUse(at(1), "toolu_old", "Agent", reviewer),
      toolResult(at(1, 1), "toolu_old", {
        toolUseResult: { status: "async_launched", agentId: CHILD_B },
      }),
      toolUse(at(2), "toolu_new", "Agent", reviewer),
      toolResult(at(2, 1), "toolu_new", {
        toolUseResult: { status: "async_launched", agentId: CHILD_C },
      }),
      attachment(at(10), {
        type: "queued_command",
        commandMode: "task-notification",
        prompt: notice(CHILD_B),
      }),
      attachment(at(10, 1), {
        type: "queued_command",
        commandMode: "task-notification",
        prompt: notice(CHILD_C),
      }),
    ];
    const send = (id: string, to: string, timestamp: string): Line =>
      toolUse(timestamp, id, "SendMessage", { to, message: "carry on", summary: "s" });
    const resumedOld = [
      ...twoReviewers,
      send("toolu_m1", CHILD_B, at(20)),
      toolResult(at(20, 1), "toolu_m1"),
    ];
    expect(fold(resumedOld).children[CHILD_B]).toMatchObject({ at: at(1, 1), outcome: "running" });
    expect(fold(resumedOld).children[CHILD_C]?.outcome).toBe("finished");

    // The elder's own idle notification arrives under the shared name: it finishes the running one, the elder.
    const idledOld = [...resumedOld, userText(at(20, 30), idle("reviewer"))];
    expect(fold(idledOld).children[CHILD_B]?.outcome).toBe("finished");
    expect(fold(idledOld).children[CHILD_C]?.outcome).toBe("finished");

    const sentByName = [
      ...resumedOld,
      send("toolu_m2", "reviewer", at(21)),
      toolResult(at(21, 1), "toolu_m2"),
    ];
    expect(fold(sentByName).children[CHILD_C]?.outcome).toBe("running");

    const stoppedByName = [
      ...sentByName,
      toolUse(at(22), "toolu_stop", "TaskStop", { task_id: "reviewer" }),
      toolResult(at(22, 1), "toolu_stop"),
    ];
    const children = fold(stoppedByName).children;
    expect(children[CHILD_C]?.outcome).toBe("stopped");
    expect(children[CHILD_B]).toMatchObject({ at: at(1, 1), outcome: "running" });
  });

  test("a saved transcript without `stops` is replayed from its start, since its children's `at` may be resume times; one with `stops` keeps its cursor, a cursor without `size` taking its offset; a map that is not an object is no transcript", () => {
    const children = {
      [CHILD_B]: { name: "reviewer", at: at(20, 1), outcome: "running", finishedAt: null },
      [CHILD_C]: { name: "reviewer", at: at(2, 1), outcome: "finished" },
    };
    const saved = {
      cursor: { offset: 4096, ino: 7, size: 4200 },
      state: { ...activity({}), children },
    };
    const { stops: _stops, ...withoutStops } = saved.state;
    expect(normalizeTranscript({ ...saved, state: withoutStops })).toEqual(initialTranscript());
    // A pending call saved before `timeoutMs` would be judged by the plain bound: replayed too.
    const withoutTimeout = {
      ...saved.state,
      pending: { toolu_01: { tool: "Bash", at: at(3), taskId: null } },
    };
    expect(normalizeTranscript({ ...saved, state: withoutTimeout })).toEqual(initialTranscript());
    // An activity saved before `runSince`, or before `runPending`, cannot say whether a finished child
    // ran again: replayed too.
    const { runSince: _runSince, ...withoutRun } = saved.state;
    expect(normalizeTranscript({ ...saved, state: withoutRun })).toEqual(initialTranscript());
    const { runPending: _runPending, ...withoutPending } = saved.state;
    expect(normalizeTranscript({ ...saved, state: withoutPending })).toEqual(initialTranscript());

    const kept = normalizeTranscript({
      cursor: { offset: 4096 },
      state: { ...saved.state, children: { [CHILD_C]: { ...children[CHILD_C], since: at(2, 1) } } },
    });
    expect(kept?.cursor).toEqual({ offset: 4096, ino: null, size: 4096 });
    expect(kept?.state.named).toEqual({});
    // The version before kept the paths alone: each loads as named long ago.
    const pathsAlone = normalizeTranscript({
      ...saved,
      state: { ...saved.state, named: ["/repo/.worktrees/x", 7] },
    });
    expect(pathsAlone?.state.named).toEqual({ "/repo/.worktrees/x": "1970-01-01T00:00:00.000Z" });
    expect(kept?.state.children).toEqual({
      [CHILD_C]: {
        name: "reviewer",
        at: at(2, 1),
        since: at(2, 1),
        outcome: "finished",
        finishedAt: null,
      },
    });

    expect(normalizeTranscript({ ...saved, state: { ...saved.state, children: 5 } })).toBeNull();
    expect(normalizeTranscript({ ...saved, state: { ...withoutStops, children: 5 } })).toBeNull();
    expect(normalizeTranscript({ cursor: "far", state: saved.state })).toBeNull();
  });

  test("a SendMessage to a finished named child (the latest spawn under that name) resumes it as of the message, keeping its spawn time; a stopped one stays stopped, and an errored or unknown send resumes nothing", () => {
    const finished = [
      ...spawns,
      attachment(at(10), {
        type: "queued_command",
        commandMode: "task-notification",
        prompt: notice(CHILD_C),
      }),
      toolUse(at(11), "toolu_stop", "TaskStop", { task_id: "builder-b" }),
      toolResult(at(11, 1), "toolu_stop"),
    ];
    const send = (id: string, to: string, timestamp: string): Line =>
      toolUse(timestamp, id, "SendMessage", { to, message: "carry on", summary: "s" });
    // The errored send comes while the reviewer is still finished, so a missing error guard would show.
    const untouched = fold([
      ...finished,
      send("toolu_m4", "reviewer", at(19)),
      toolResult(at(19, 1), "toolu_m4", { content: "no such agent", isError: true }),
      send("toolu_m3", "nobody", at(19, 2)),
      toolResult(at(19, 3), "toolu_m3"),
    ]);
    expect(untouched.children).toEqual({
      [CHILD_A]: {
        name: null,
        at: at(0, 1),
        since: at(0, 1),
        outcome: "running",
        finishedAt: null,
      },
      [CHILD_B]: {
        name: "builder-b",
        at: at(1, 1),
        since: at(1, 1),
        outcome: "stopped",
        finishedAt: null,
      },
      [CHILD_C]: {
        name: "reviewer",
        at: at(2, 1),
        since: at(2, 1),
        outcome: "finished",
        finishedAt: at(10),
      },
    });
    const resumed = fold([
      ...finished,
      send("toolu_m1", "reviewer", at(20)),
      toolResult(at(20, 1), "toolu_m1"),
      send("toolu_m2", "builder-b", at(21)),
      toolResult(at(21, 1), "toolu_m2"),
    ]);
    expect(resumed.children).toEqual({
      [CHILD_A]: {
        name: null,
        at: at(0, 1),
        since: at(0, 1),
        outcome: "running",
        finishedAt: null,
      },
      [CHILD_B]: {
        name: "builder-b",
        at: at(1, 1),
        since: at(1, 1),
        outcome: "stopped",
        finishedAt: null,
      },
      [CHILD_C]: {
        name: "reviewer",
        at: at(2, 1),
        since: at(20, 1),
        outcome: "running",
        finishedAt: null,
      },
    });
    expect(resumed.pending).toEqual({});
  });

  test("a newer notice for a finished child refreshes its finish time, so a child a sibling resumed and that finished again is finished as of the newer notice; a stopped child takes no notice", () => {
    const finishedTwice = fold([
      ...spawns,
      attachment(at(10), {
        type: "queued_command",
        commandMode: "task-notification",
        prompt: notice(CHILD_C),
      }),
      toolUse(at(11), "toolu_stop", "TaskStop", { task_id: "builder-b" }),
      toolResult(at(11, 1), "toolu_stop"),
      userText(at(22), notice(CHILD_C)),
      userText(at(23), idle("builder-b")),
      // A queued notice read later keeps its enqueue time: an older stamp never moves the finish back.
      attachment(at(10), {
        type: "queued_command",
        commandMode: "task-notification",
        prompt: notice(CHILD_C),
      }),
    ]);
    expect(finishedTwice.children[CHILD_C]).toMatchObject({
      outcome: "finished",
      finishedAt: at(22),
    });
    expect(finishedTwice.children[CHILD_B]).toMatchObject({ outcome: "stopped", finishedAt: null });
  });

  test("the run start is the first assistant line after an input and holds across a later input with no line after it yet, so an input alone never erases a run that began after a finish", () => {
    const lines = [
      toolUse(at(0), "toolu_01", "Bash", { command: "bun test" }),
      toolResult(at(1), "toolu_01"),
      userText(at(5), "carry on"),
      toolUse(at(6), "toolu_02", "Bash", { command: "bun test" }),
      toolResult(at(6, 1), "toolu_02"),
      userText(at(8), "and this too"),
    ];
    expect(fold(lines)).toMatchObject({ runSince: at(6), runPending: true });
    expect(fold([...lines, toolUse(at(9), "toolu_03", "Read", { file_path: "/x" })])).toMatchObject(
      {
        runSince: at(9),
        runPending: false,
      },
    );
  });

  test("timestamps are not monotonic (a queued attachment keeps its enqueue time), and lastMovedAt never moves backwards", () => {
    const lines = [
      toolUse(at(30), "toolu_01", "Bash", { command: "bun test" }),
      toolResult(at(31), "toolu_01"),
      attachment(at(0), { type: "total_tokens_reminder", content: "n tokens left" }),
      said(at(31, 5), "end_turn"),
    ];
    expect(fold(lines.slice(0, 3))).toEqual(
      activity({ lastMovedAt: at(31), runSince: at(30), lines: 3 }),
    );
    expect(fold(lines)).toEqual(
      activity({ lastMovedAt: at(31, 5), runSince: at(30), turn: "ended", lines: 4 }),
    );
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
        runSince: at(4),
        children: {
          [CHILD_A]: {
            name: null,
            at: at(4, 1),
            since: at(4, 1),
            outcome: "running",
            finishedAt: null,
          },
        },
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
      pending: { toolu_01: { tool: "Bash", at: at(0), taskId: null, timeoutMs: null } },
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
      state: activity({ lastMovedAt: at(40), runSince: at(40), turn: "ended", lines: 1 }),
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
        runSince: at(50),
        pending: { toolu_09: { tool: "Bash", at: at(50), taskId: null, timeoutMs: null } },
        lines: 1,
      }),
    });

    // Same inode, an unfinished tail, then a shrink that stays above the offset of the last complete
    // line: the bytes before that offset are gone too, so the state starts over.
    appendFileSync(file, "z".repeat(900));
    utimesSync(file, new Date(at(57)), new Date(at(57)));
    expect(readTranscript(transcript, file)).toBe(true);
    const before = { ...transcript.cursor };
    const other = JSON.stringify(toolUse(at(59), "toolu_12", "Bash", { command: "b".repeat(650) }));
    expect(Buffer.byteLength(other) + 1).toBeGreaterThan(before.offset);
    expect(Buffer.byteLength(other) + 1).toBeLessThan(before.size);
    writeFileSync(file, `${other}\n`);
    utimesSync(file, new Date(at(59)), new Date(at(59)));
    expect(readTranscript(transcript, file)).toBe(true);
    expect(transcript).toEqual({
      cursor: cursor(Buffer.byteLength(other) + 1),
      state: activity({
        lastMovedAt: at(59),
        runSince: at(59),
        pending: { toolu_12: { tool: "Bash", at: at(59), taskId: null, timeoutMs: null } },
        lines: 1,
      }),
    });
    expect(transcript.cursor.ino).toBe(before.ino);

    expect(() => readIncrement(dir, { offset: 0, ino: null, size: 0 })).toThrow(
      `${dir} is not a regular file`,
    );
  });
});

describe("the files Claude Code writes", () => {
  test("sessionPaths maps the cwd to the project slug (every non-alphanumeric becomes a dash); displayName falls back name, description, agentId; a missing sidecar is null, a malformed one throws; locateSession finds a session by id", () => {
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

    // A session's project directory is its launch cwd; the shell may have moved since, so the id finds it.
    const home = temp.dir("fleet-home-");
    const project = join(home, ".claude", "projects", "-home-user-repo");
    mkdirSync(join(project, SESSION, "subagents"), { recursive: true });
    writeFileSync(join(project, `${SESSION}.jsonl`), "");
    const expected = {
      sessionFile: join(project, `${SESSION}.jsonl`),
      subagentsDir: join(project, SESSION, "subagents"),
    };
    expect(locateSession(SESSION, home, "/home/user/repo")).toEqual(expected);
    expect(locateSession(SESSION, home, "/home/user/repo/packages/app")).toEqual(expected);
    expect(
      locateSession("00000000-0000-4000-8000-000000000000", home, "/home/user/repo"),
    ).toBeNull();
    // A project directory that is a symlink is scanned too.
    const elsewhere = temp.dir("fleet-elsewhere-");
    const linked = "11111111-2222-4333-8444-555555555555";
    mkdirSync(join(elsewhere, linked, "subagents"), { recursive: true });
    writeFileSync(join(elsewhere, `${linked}.jsonl`), "");
    symlinkSync(elsewhere, join(home, ".claude", "projects", "-home-user-linked"));
    expect(locateSession(linked, home, "/home/user/repo")).toEqual({
      sessionFile: join(home, ".claude", "projects", "-home-user-linked", `${linked}.jsonl`),
      subagentsDir: join(home, ".claude", "projects", "-home-user-linked", linked, "subagents"),
    });
    expect(locateSession(SESSION, temp.dir("fleet-nohome-"), "/home/user/repo")).toBeNull();
  });
});
