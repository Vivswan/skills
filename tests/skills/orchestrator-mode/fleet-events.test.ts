import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../../../scripts/lib.mts";
import {
  digest,
  type Program,
  Scenario,
  sessionEventsHarness,
} from "../../helpers/session-events-scenario";

// Contract tests for the fleet source through the daemon: a session directory laid out the way
// Claude Code writes one, hand-written transcript lines with timestamps in the past so a wait ages
// without sleeping, a scratch git repository with two worktrees for the tree readings, and the
// daemon driven by `watch` and `poll`. Every event is a transition against what was said before.

const { temp } = sessionEventsHarness();
const SCRIPT = join(ROOT, "skills", "orchestrator-mode", "scripts", "fleet-events.mts");
const PROGRAM: Program = { script: SCRIPT, source: "fleet-events", env: () => ({}) };
const SOURCE = "fleet-events";
const SESSION = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const A = "a1b2c3d4e5f60718";
const B = "b2c3d4e5f6071829";
const C = "c3d4e5f607182930";
const D = "d4e5f60718293041";
const MARKER = "MARKER-sunflower-9c1d";
const GIT_TIMEOUT = 60_000;

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

/** A finished exchange: a Bash call and its result, both at `timestamp`. */
function exchange(timestamp: string, id: string, agentId: string = A): Line[] {
  return [
    toolUse(timestamp, id, "Bash", { command: "bun test" }, agentId),
    toolResult(timestamp, id, { agentId }),
  ];
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

function polled(s: Scenario, inbox: string): number {
  const result = s.run(["poll"], { inbox });
  expect(result.code).toBe(0);
  return Number(/polled; (\d+) event\(s\)/.exec(result.stdout)?.[1]);
}

function rows(s: Scenario): Array<[string, string, string]> {
  return s.events().map((event) => [event.kind, event.text, event.url as string]);
}

function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GIT_")) delete env[key];
  }
  return env;
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    timeout: 30_000,
    env: {
      ...cleanEnv(),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

/** A repository of six files with two worktrees, one per track. */
function scratchRepo(root: string): { repo: string; wtA: string; wtB: string } {
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "tracked.txt"), "v1\n");
  mkdirSync(join(repo, "lib"));
  for (const name of ["a", "b", "c", "d", "e"]) {
    writeFileSync(join(repo, "lib", `${name}.txt`), `${name}\n`);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-m", "initial");
  const wtA = join(root, "wt-a");
  const wtB = join(root, "wt-b");
  git(repo, "worktree", "add", wtA, "-b", "track-a");
  git(repo, "worktree", "add", wtB, "-b", "track-b");
  return { repo, wtA, wtB };
}

describe("fleet-events.mts", () => {
  test("the baseline poll says nothing, a transcript first seen later is started at once while its wait needs a second observation, and a usage mistake exits 2 before any poll", async () => {
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

    const watch = s.run(["watch", session.dir, "--quiet-after", "1"], { inbox: box.path });
    expect(watch.code).toBe(0);
    expect(watch.stdout).toContain(`watching ${session.dir} for session`);
    expect(polled(s, box.path)).toBe(0);
    expect(s.events()).toEqual([]);

    // The new agent arrives already waiting: its first poll says started and observes the wait,
    // the second says the wait, the third nothing.
    const pathB = writeAgent(
      session,
      B,
      { description: "review the source", agentType: "Explore" },
      [toolUse(ago(5), "toolu_02", "Bash", { command: "bun test" }, B)],
    );
    expect(polled(s, box.path)).toBe(1);
    expect(polled(s, box.path)).toBe(1);
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      ["agent", "agent review the source: started", fileUrl(pathB)],
      ["agent", "agent review the source: waiting on Bash for 5 min", fileUrl(pathB)],
    ]);
    expect(s.events().map((event) => event.agentId)).toEqual([B, B]);
    const [frame] = await box.frames(1);
    expect(digest(frame as string, SOURCE)).toBe(
      `agent review the source: started\n${fileUrl(pathB)}\nautomated notice from ${SOURCE}; no reply needed`,
    );
    expect(s.run(["--help"], { inbox: box.path })).toMatchObject({
      code: 0,
      stdout: expect.stringMatching(/^usage: fleet-events\.mts/),
    });
    s.stop({ inbox: box.path });
  }, 30000);

  test("a pending Bash past the window is one waiting event once two polls agree, silent while it holds, and moving again when its result lands", async () => {
    const s = new Scenario(PROGRAM, "wait");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const path = writeAgent(session, A, { name: "builder-a", description: "build it" }, [
      ...exchange(ago(9), "toolu_01"),
      toolUse(ago(5), "toolu_02", "Bash", { command: "bun run check" }),
    ]);
    await s.start({ inbox: box.path });
    expect(s.run(["watch", session.dir, "--quiet-after", "1"], { inbox: box.path }).code).toBe(0);
    expect(polled(s, box.path)).toBe(1);
    expect(polled(s, box.path)).toBe(0);
    expect(polled(s, box.path)).toBe(0);

    appendLines(path, [toolResult(ago(0), "toolu_02")]);
    expect(polled(s, box.path)).toBe(1);
    expect(rows(s)).toEqual([
      ["agent", "agent builder-a: waiting on Bash for 5 min", fileUrl(path)],
      ["agent", "agent builder-a: moving again", fileUrl(path)],
    ]);
    expect(s.state().targets[session.dir]).toMatchObject({
      form: "dir",
      quietAfterMinutes: 1,
      polls: 5,
      agents: { [A]: { said: "moving", observed: "moving" } },
    });
    s.stop({ inbox: box.path });
  }, 30000);

  test("a background launch past the window is a wait on its job; the notice clears it as a user string in one agent and as a queued_command attachment in another", async () => {
    const s = new Scenario(PROGRAM, "jobs");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
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
    const pathA = writeAgent(
      session,
      A,
      { name: "builder-a", description: "build" },
      launched(A, "b1a2b3c4d"),
    );
    const pathB = writeAgent(
      session,
      B,
      { name: "builder-b", description: "build" },
      launched(B, "b9z8y7x6w"),
    );
    await s.start({ inbox: box.path });
    expect(s.run(["watch", session.dir, "--quiet-after", "1"], { inbox: box.path }).code).toBe(0);
    expect(polled(s, box.path)).toBe(2);

    appendLines(pathA, [userText(ago(0), notice("b1a2b3c4d"))]);
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
    expect(polled(s, box.path)).toBe(2);
    expect(rows(s)).toEqual([
      ["agent", "agent builder-a: waiting on 1 background job for 6 min", fileUrl(pathA)],
      ["agent", "agent builder-b: waiting on 1 background job for 6 min", fileUrl(pathB)],
      ["agent", "agent builder-a: moving again", fileUrl(pathA)],
      ["agent", "agent builder-b: moving again", fileUrl(pathB)],
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a wait on a child names the child and its last move: a foreground Agent call joined through the child's sidecar toolUseId, and a background spawn through its agentId", async () => {
    const s = new Scenario(PROGRAM, "kids");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const pathA = writeAgent(session, A, { name: "builder-a", description: "build" }, [
      toolUse(ago(6), "toolu_fg", "Agent", {
        description: "scout the repo",
        subagent_type: "Explore",
        prompt: "look",
      }),
    ]);
    writeAgent(
      session,
      C,
      {
        description: "scout the repo",
        agentType: "Explore",
        toolUseId: "toolu_fg",
        parentAgentId: A,
      },
      [...exchange(ago(0), "toolu_c1", C)],
    );
    const pathB = writeAgent(session, B, { name: "builder-b", description: "build" }, [
      toolUse(
        ago(4),
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
      toolResult(ago(4), "toolu_bg", {
        toolUseResult: { status: "async_launched", agentId: D },
        agentId: B,
      }),
      said(ago(4), "end_turn", B),
    ]);
    writeAgent(
      session,
      D,
      { name: "runner", description: "run it", parentAgentId: B },
      exchange(ago(0), "toolu_d1", D),
    );
    await s.start({ inbox: box.path });
    expect(s.run(["watch", session.dir, "--quiet-after", "1"], { inbox: box.path }).code).toBe(0);
    expect(polled(s, box.path)).toBe(2);
    expect(rows(s)).toEqual([
      [
        "agent",
        "agent builder-a: waiting on agent scout the repo for 6 min; scout the repo last moved 0 min ago",
        fileUrl(pathA),
      ],
      [
        "agent",
        "agent builder-b: waiting on agent runner for 4 min; runner last moved 0 min ago",
        fileUrl(pathB),
      ],
    ]);
    expect(polled(s, box.path)).toBe(0);
    s.stop({ inbox: box.path });
  }, 30000);

  test("an end_turn with nothing outstanding is turn ended, once; a TaskStop in the session file on a quiet agent is stopped, never a stall, while a quiet agent nobody stopped is a stall", async () => {
    const s = new Scenario(PROGRAM, "ends");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const pathA = writeAgent(session, A, { name: "builder-a", description: "build" }, [
      ...exchange(ago(3), "toolu_01"),
      said(ago(3), "end_turn"),
    ]);
    const pathB = writeAgent(session, B, { name: "builder-b", description: "build" }, [
      ...exchange(ago(5), "toolu_02", B),
      said(ago(5), null, B),
    ]);
    const pathC = writeAgent(session, C, { name: "builder-c", description: "build" }, [
      ...exchange(ago(5), "toolu_03", C),
      said(ago(5), null, C),
    ]);
    // The lead's own file: the spawn that named builder-b, then the stop by that name.
    appendLines(session.sessionFile, [
      toolUse(
        ago(8),
        "toolu_spawn",
        "Agent",
        {
          name: "builder-b",
          description: "build",
          subagent_type: "general-purpose",
          prompt: "build",
        },
        null,
      ),
      toolResult(ago(8), "toolu_spawn", {
        toolUseResult: { status: "teammate_spawned", agentId: B, name: "builder-b" },
        agentId: null,
      }),
      toolUse(ago(2), "toolu_stop", "TaskStop", { task_id: "builder-b" }, null),
      toolResult(ago(2), "toolu_stop", { agentId: null }),
    ]);
    await s.start({ inbox: box.path });
    expect(s.run(["watch", session.dir, "--quiet-after", "1"], { inbox: box.path }).code).toBe(0);
    expect(polled(s, box.path)).toBe(3);
    expect(polled(s, box.path)).toBe(0);
    expect(rows(s)).toEqual([
      ["agent", "agent builder-a: turn ended 3 min ago, nothing outstanding", fileUrl(pathA)],
      ["agent", "agent builder-b: stopped by the lead", fileUrl(pathB)],
      ["agent", "agent builder-c: quiet for 5 min mid-turn, nothing pending", fileUrl(pathC)],
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test(
    "with --repo, a head move is head (with ahead and behind against --base), a tree collapse is wipe, an unclaimed idle worktree is quiet after two polls, a claimed one or one holding a sleep is not, and a claim ending starts the count at zero",
    async () => {
      const s = new Scenario(PROGRAM, "tree");
      const box = await s.inbox("a");
      const session = sessionDir(s.fixtureDir);
      const { repo, wtA, wtB } = scratchRepo(s.fixtureDir);
      writeAgent(
        session,
        A,
        { name: "builder-a", description: "build", worktreePath: wtA, worktreeBranch: "track-a" },
        [...exchange(ago(0), "toolu_01")],
      );
      const parked = Bun.spawn(["sleep", "60"], { cwd: repo, stdout: "ignore" });
      try {
        await s.start({ inbox: box.path });
        expect(
          s.run(["watch", session.dir, "--repo", repo, "--base", "main", "--quiet-after", "1"], {
            inbox: box.path,
          }).code,
        ).toBe(0);
        expect(s.events()).toEqual([]);

        writeFileSync(join(wtA, "built.txt"), "output\n");
        git(wtA, "add", "built.txt");
        git(wtA, "commit", "-m", "track work");
        const headA = git(wtA, "rev-parse", "HEAD").trim();
        expect(polled(s, box.path)).toBe(1);

        git(wtB, "rm", "-r", "-q", "lib");
        git(wtB, "commit", "-m", "wipe");
        const headB = git(wtB, "rev-parse", "HEAD").trim();
        expect(polled(s, box.path)).toBe(2);
        expect(polled(s, box.path)).toBe(0);
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);
        expect(rows(s)).toEqual([
          ["head", `worktree track-a: head moved to ${headA.slice(0, 12)}`, fileUrl(wtA)],
          ["head", `worktree track-b: head moved to ${headB.slice(0, 12)}`, fileUrl(wtB)],
          ["wipe", "worktree track-b: 6 files at HEAD -> 1", fileUrl(wtB)],
          ["quiet", "worktree track-b: no worker process and no change for 2 polls", fileUrl(wtB)],
        ]);
        expect(s.events()[0]).toMatchObject({ worktree: wtA, sha: headA, ahead: 1, behind: 0 });
        expect(s.state().targets[session.dir]).toMatchObject({
          worktrees: {
            [repo]: { branch: "main", processes: { workers: 1, shells: 0 }, quietPolls: 0 },
            [wtA]: { branch: "track-a", headSha: headA, treeFileCount: 7, quietPolls: 0 },
            [wtB]: { branch: "track-b", headSha: headB, treeFileCount: 1, quietPolls: 3 },
          },
        });
        // A sidecar malformed for a poll is that agent's trouble; its last good reading keeps the claim.
        const sidecarA = join(session.subagents, `agent-${A}.meta.json`);
        writeFileSync(sidecarA, "{");
        expect(polled(s, box.path)).toBe(1);
        expect(polled(s, box.path)).toBe(0);
        expect(rows(s).at(-1)).toEqual([
          "trouble",
          `fleet: cannot read agent-${A}.meta.json: ${sidecarA} is not a JSON object`,
          fileUrl(sidecarA),
        ]);
        expect(s.state().targets[session.dir]).toMatchObject({
          worktrees: { [wtA]: { quietPolls: 0 } },
        });
        // The claim ends: the count starts from zero, so two unchanged unclaimed polls say quiet.
        writeFileSync(
          join(session.subagents, `agent-${A}.meta.json`),
          JSON.stringify({ name: "builder-a", description: "build" }),
        );
        expect(polled(s, box.path)).toBe(0);
        expect(polled(s, box.path)).toBe(1);
        expect(rows(s).at(-1)).toEqual([
          "quiet",
          "worktree track-a: no worker process and no change for 2 polls",
          fileUrl(wtA),
        ]);
      } finally {
        parked.kill();
      }
      s.stop({ inbox: box.path });
    },
    GIT_TIMEOUT,
  );

  test("a FIFO transcript, a directory for a sidecar, and a vanished subagents dir are trouble, said once, one agent's while the rest are polled; a failed read is no observation, so a wait seen before an outage is said once seen again", async () => {
    const s = new Scenario(PROGRAM, "fifo");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    const lines = [toolUse(ago(5), "toolu_01", "Bash", { command: "bun test" })];
    const meta = { name: "builder-a", description: "build" };
    const pathA = writeAgent(session, A, meta, lines);
    writeAgent(
      session,
      C,
      { name: "builder-c", description: "build" },
      exchange(ago(0), "toolu_c1", C),
    );
    const sidecarC = join(session.subagents, `agent-${C}.meta.json`);
    rmSync(sidecarC);
    mkdirSync(sidecarC);
    const fifo = join(session.subagents, `agent-${B}.jsonl`);
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    await s.start({ inbox: box.path });
    expect(s.run(["watch", session.dir, "--quiet-after", "1"], { inbox: box.path }).code).toBe(0);

    rmSync(session.subagents, { recursive: true });
    expect(polled(s, box.path)).toBe(1);
    expect(polled(s, box.path)).toBe(0);
    mkdirSync(session.subagents);
    writeAgent(session, A, meta, lines);
    expect(polled(s, box.path)).toBe(0);
    expect(polled(s, box.path)).toBe(1);
    expect(rows(s)).toEqual([
      [
        "trouble",
        `fleet: cannot read agent-${B}.jsonl: ${fifo} is not a regular file`,
        fileUrl(fifo),
      ],
      [
        "trouble",
        expect.stringMatching(new RegExp(`^fleet: cannot read agent-${C}\\.meta\\.json: EISDIR`)),
        fileUrl(sidecarC),
      ],
      ["trouble", `fleet: cannot list ${session.subagents}: ENOENT`, fileUrl(session.subagents)],
      ["agent", "agent builder-a: waiting on Bash for 5 min", fileUrl(pathA)],
    ]);
    expect(s.log()).toContain(`${B}: ${fifo} is not a regular file`);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a marker planted in a tool_result body, in toolUseResult, and in a prompt_snapshot attachment reaches no frame, no log line, no event, and no state file", async () => {
    const s = new Scenario(PROGRAM, "mark");
    const box = await s.inbox("a");
    const session = sessionDir(s.fixtureDir);
    writeAgent(session, A, { name: "builder-a", description: "build" }, [
      toolUse(ago(7), "toolu_01", "Bash", { command: `echo ${MARKER}` }),
      toolResult(ago(7), "toolu_01", {
        content: [{ type: "text", text: MARKER }],
        toolUseResult: { stdout: MARKER, stderr: "" },
      }),
      attachment(ago(7), { type: "prompt_snapshot", prompt: `${MARKER} ${notice("b1a2b3c4d")}` }),
      toolUse(ago(6), "toolu_02", "Bash", { command: `grep ${MARKER}` }),
    ]);
    await s.start({ inbox: box.path });
    expect(s.run(["watch", session.dir, "--quiet-after", "1"], { inbox: box.path }).code).toBe(0);
    expect(polled(s, box.path)).toBe(1);
    const frames = await box.frames(1);
    expect(frames).toHaveLength(1);
    expect(rows(s).map((row) => row[1])).toEqual(["agent builder-a: waiting on Bash for 6 min"]);
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

  test("watch session resolves the session directory from CLAUDE_CODE_SESSION_ID, the cwd slug, and HOME in the CLI process; without the variable it exits 2 naming it", async () => {
    const s = new Scenario(PROGRAM, "self");
    const box = await s.inbox("a");
    const home = join(s.fixtureDir, "home");
    const slug = process.cwd().replace(/[^A-Za-z0-9]/g, "-");
    const session = sessionDir(join(home, ".claude", "projects", slug));
    const env = { CLAUDE_CODE_SESSION_ID: SESSION, HOME: home };
    await s.start({ inbox: box.path });
    const unset = s.run(["watch", "session"], {
      inbox: box.path,
      env: { ...env, CLAUDE_CODE_SESSION_ID: "" },
    });
    expect(unset.code).toBe(2);
    expect(unset.stderr).toContain("CLAUDE_CODE_SESSION_ID is unset");

    const watch = s.run(["watch", "session", "--quiet-after", "1"], { inbox: box.path, env });
    expect(watch.code).toBe(0);
    expect(watch.stdout).toContain("watching session for session");
    expect(s.state().targets.session).toMatchObject({
      form: "session",
      sessionFile: session.sessionFile,
      subagentsDir: session.subagents,
    });
    const path = writeAgent(
      session,
      A,
      { name: "builder-a", description: "build" },
      exchange(ago(0), "toolu_01"),
    );
    expect(polled(s, box.path)).toBe(1);
    expect(rows(s)).toEqual([["agent", "agent builder-a: started", fileUrl(path)]]);
    s.stop({ inbox: box.path });
  }, 30000);
});

describe("the two skills side by side", () => {
  test("installed as sibling folders, copied or symlinked, the fleet source finds the library; with the base removed it exits 2 naming the install command", () => {
    const root = temp.dir("fleet-events-layout-");
    const canon = join(root, "canonical");
    mkdirSync(canon);
    for (const skill of ["session-events", "orchestrator-mode"]) {
      cpSync(join(ROOT, "skills", skill), join(canon, skill), { recursive: true });
    }
    const agent = join(root, "agent");
    mkdirSync(agent);
    for (const skill of ["session-events", "orchestrator-mode"]) {
      symlinkSync(join(canon, skill), join(agent, skill));
    }
    const runtime = join(root, "runtime");
    mkdirSync(runtime);
    const run = (skillsDir: string) => {
      const result = Bun.spawnSync(
        [
          process.execPath,
          join(skillsDir, "orchestrator-mode", "scripts", "fleet-events.mts"),
          "status",
          "--id",
          "layout",
        ],
        { env: { ...process.env, SESSION_EVENTS_DIR: runtime }, stdout: "pipe", stderr: "pipe" },
      );
      return { code: result.exitCode, stderr: result.stderr.toString() };
    };
    for (const skillsDir of [canon, agent]) {
      const r = run(skillsDir);
      expect(r.code).toBe(3);
      expect(r.stderr).toContain(
        `bun "${join(canon, "orchestrator-mode", "scripts", "fleet-events.mts")}" daemon --id layout`,
      );
    }
    rmSync(join(canon, "session-events"), { recursive: true });
    for (const skillsDir of [canon, agent]) {
      const r = run(skillsDir);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(
        "install it beside this skill: npx skills add Vivswan/skills -g --skill session-events",
      );
    }
  }, 30000);
});
