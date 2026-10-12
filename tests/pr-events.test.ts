import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";
import { tempDirs } from "./helpers/temp-dirs";

// Contract tests for the PR-events daemon. A stub gh on PATH dispatches each GraphQL query on the
// substring only that query class carries and serves hand-written fixture N for call N of the
// class (the last fixture repeats once the sequence runs out). A PR's first sighting reads its
// detail as the baseline, so every scenario starts with an empty `detail-1` and a scenario's own
// detail fixtures begin at 2. The daemon is started by the test the way a session starts it, as a
// child, owned by a fake Claude Code inbox: a Unix socket named by this live pid, collecting every
// connection's bytes. Polls are driven with `poll`, so no timer fires and the fixture order is the
// poll order. Every daemon a test starts is recorded; the test's end kills what `stop` did not,
// and the file's end asserts none is left alive.

const SCRIPT = join(ROOT, "skills", "watch-prs-and-ci", "scripts", "pr-events.mts");
const temp = tempDirs();

const FAKE_GH = `#!/usr/bin/env bash
{ printf '%s' "$*" | tr '\\n' ' '; printf '\\n'; } >> "\${STUB_ARGS_LOG}"
next() {
  local countfile="\${STUB_DIR}/.$1-count"
  local n=$(( $(cat "$countfile" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$countfile"
  echo "$n"
}
serve() {
  local prefix="$1" n="$2"
  if [ -f "\${STUB_DIR}/fail-\${prefix}" ]; then echo "gh: graphql boom" >&2; exit 1; fi
  if [ -f "\${STUB_DIR}/slow-\${prefix}" ]; then sleep 2; fi
  while [ "$n" -gt 1 ] && [ ! -f "\${STUB_DIR}/\${prefix}-\${n}.json" ]; do n=$((n-1)); done
  local file="\${STUB_DIR}/\${prefix}-\${n}.json"
  if [ ! -f "$file" ]; then echo "stub gh: no \${prefix} fixture" >&2; exit 1; fi
  cat "$file"
}
case "$1" in
  api)
    case "$*" in
      *"checkSuites("*) serve suites "$(next suites)";;
      *"reviewThreads(first:"*) serve detail "$(next detail)";;
      *"query OlderComments("*) serve older "$(next older)";;
      *"pullRequest(number:"*) serve rows "$(next rows)";;
      *viewer*) serve viewer "$(next viewer)";;
      *) echo "unexpected graphql: $*" >> "\${STUB_VIOLATIONS}"; exit 64;;
    esac;;
  run)
    if [ "$2" = "view" ] && [ "$4" = "--log-failed" ]; then
      f="\${STUB_DIR}/log-$3.txt"
      if [ -f "$f" ]; then cat "$f"; else echo "stub gh: no log fixture for run $3" >&2; exit 1; fi
    else
      echo "actions endpoint: $*" >> "\${STUB_VIOLATIONS}"; exit 64
    fi;;
  *) echo "unexpected: $*" >> "\${STUB_VIOLATIONS}"; exit 64;;
esac
`;

const binDir = temp.dir("pr-events-bin-");
writeFileSync(join(binDir, "gh"), FAKE_GH);
chmodSync(join(binDir, "gh"), 0o755);
const emptyBinDir = temp.dir("pr-events-nobin-");

const REPO = "octo/example";
const FORK = "octo/fork";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const MERGE_C = "c".repeat(40);
const SHORT_A = HEAD_A.slice(0, 12);
const SHORT_C = MERGE_C.slice(0, 12);
const T1 = "2026-01-01T00:00:00Z";
const T2 = "2026-01-01T01:00:00Z";
const T3 = "2026-01-01T02:00:00Z";

// --- fixtures, in the shapes the GraphQL API renders them --------------------

interface RowSpec {
  number?: number;
  state?: "OPEN" | "MERGED" | "CLOSED";
  mergedAt?: string;
  mergeCommit?: string;
  head?: string;
  updatedAt?: string;
  comments?: number;
  threads?: number;
  rollup?: string | null;
}

function rows(...specs: RowSpec[]): string {
  const prs: Record<string, unknown> = {};
  for (const spec of specs.length === 0 ? [{}] : specs) {
    const number = spec.number ?? 7;
    prs[`p${number}`] = {
      number,
      url: `https://github.com/${REPO}/pull/${number}`,
      isDraft: false,
      state: spec.state ?? "OPEN",
      mergedAt: spec.mergedAt ?? null,
      mergeCommit: spec.mergeCommit ? { oid: spec.mergeCommit } : null,
      headRefOid: spec.head ?? HEAD_A,
      updatedAt: spec.updatedAt ?? T1,
      comments: { totalCount: spec.comments ?? 0 },
      reviewThreads: { totalCount: spec.threads ?? 0 },
      reviews: { nodes: [] },
      commits: {
        nodes: [{ commit: { statusCheckRollup: spec.rollup ? { state: spec.rollup } : null } }],
      },
    };
  }
  return JSON.stringify({ data: { r0: prs } });
}

/** [workflow name, status, conclusion, run id, workflow id (default: derived from the name)] */
type RunSpec = [string, string, string | null, number?, number?];

function suites(runs: RunSpec[]): string {
  const nodes = runs.map(([name, status, conclusion, id, workflowId], i) => ({
    status,
    conclusion,
    app: { slug: "github-actions" },
    workflowRun: {
      databaseId: id ?? 100 + i,
      updatedAt: T1,
      workflow: {
        databaseId: workflowId ?? [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0),
        name,
      },
    },
  }));
  return JSON.stringify({
    data: {
      repository: {
        object: { checkSuites: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } },
      },
    },
  });
}

interface CommentSpec {
  login: string;
  at: string;
  body: string;
  /** Defaults to the comment's position in its fixture, from 901; the daemon's cursor is by id. */
  id?: number;
  /** For an inline comment, the fullDatabaseId of the review that published it. */
  review?: string;
}

interface ReviewSpec {
  id: string;
  login: string;
  at: string;
  state: string;
  body: string;
}

interface ThreadSpec {
  path: string;
  line: number;
  total: number;
  comments: CommentSpec[];
}

function commentNode(spec: CommentSpec, id: number) {
  return {
    databaseId: id,
    createdAt: spec.at,
    author: { login: spec.login },
    body: spec.body,
    url: `https://github.com/${REPO}/pull/7#discussion_r${id}`,
    ...(spec.review === undefined ? {} : { pullRequestReview: { fullDatabaseId: spec.review } }),
  };
}

/** A connection page as GitHub renders it; `before` is the startCursor when older nodes exist. */
function connection(nodes: unknown[], before?: string) {
  return {
    nodes,
    pageInfo: { hasPreviousPage: before !== undefined, startCursor: before ?? null },
  };
}

function detail(spec: {
  comments?: CommentSpec[];
  /** The startCursor of the comments page when the PR has older comments. */
  commentsBefore?: string;
  reviews?: ReviewSpec[];
  threads?: ThreadSpec[];
  commitAuthor?: string;
}): string {
  let id = 900;
  const nextId = () => {
    id += 1;
    return id;
  };
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          comments: connection(
            (spec.comments ?? []).map((c) => commentNode(c, c.id ?? nextId())),
            spec.commentsBefore,
          ),
          reviews: connection(
            (spec.reviews ?? []).map((review) => ({
              fullDatabaseId: review.id,
              submittedAt: review.at,
              state: review.state,
              author: { login: review.login },
              body: review.body,
              url: `https://github.com/${REPO}/pull/7#pullrequestreview-${review.id}`,
            })),
          ),
          reviewThreads: {
            nodes: (spec.threads ?? []).map((thread, i) => ({
              id: `thread-${i}`,
              isResolved: false,
              path: thread.path,
              line: thread.line,
              comments: {
                totalCount: thread.total,
                ...connection(thread.comments.map((c) => commentNode(c, c.id ?? nextId()))),
              },
            })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
          commits: {
            nodes: [{ commit: { author: { user: { login: spec.commitAuthor ?? "dev" } } } }],
          },
        },
      },
    },
  });
}

/** An OlderComments reply: the page of issue comments before a cursor. */
function olderComments(comments: CommentSpec[], before?: string): string {
  return JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          comments: connection(
            comments.map((c, i) => commentNode(c, c.id ?? 800 + i)),
            before,
          ),
        },
      },
    },
  });
}

const VIEWER = JSON.stringify({ data: { viewer: { login: "me" } } });

// --- plumbing -------------------------------------------------------------------

interface Inbox {
  path: string;
  /** Waits for `expected` closed connections (or gives up after a few seconds), then settles: the
   * bytes arrived while spawnSync held this process's event loop. */
  frames: (expected: number) => Promise<string[]>;
  /** The write-ahead log's event ids as they stood when each connection arrived. */
  walAtConnect: number[][];
  /** When each connection arrived, meaningful only while this process's event loop was free. */
  arrivedAt: number[];
  close: () => void;
}

function readOr<T>(read: () => T, absent: T): T {
  try {
    return read();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return absent;
    throw error;
  }
}

function eventIds(walPath: string): number[] {
  return readOr(() => readFileSync(walPath, "utf-8"), "")
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { id: number }).id);
}

/** One JSON line to a Unix socket, the way an inbox reports a delivery's state to its sender. */
function sendLine(socketPath: string, frame: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath, () => socket.end(`${JSON.stringify(frame)}\n`));
    socket.on("error", reject);
    socket.on("close", () => resolve());
  });
}

/**
 * A fake Claude Code inbox at <dir>/<this pid>.sock: the owner it names is this live process.
 * With `reportState`, every frame received is answered to its `from` with a peer_message_status
 * frame in that state, as a session does for a held or refused delivery.
 */
function inbox(dir: string, walPath: string, reportState?: string): Promise<Inbox> {
  const path = join(dir, `${process.pid}.sock`);
  const connections: string[] = [];
  const walAtConnect: number[][] = [];
  const arrivedAt: number[] = [];
  return new Promise((resolve, reject) => {
    const server: Server = createServer((socket) => {
      walAtConnect.push(eventIds(walPath));
      arrivedAt.push(Date.now());
      let bytes = "";
      socket.setEncoding("utf-8");
      socket.on("data", (chunk: string) => {
        bytes += chunk;
      });
      socket.on("close", () => {
        connections.push(bytes);
        if (reportState === undefined) return;
        const frame = JSON.parse(bytes.split("\n")[0] as string) as {
          from: string;
          msg_id: string;
        };
        void sendLine(frame.from.replace(/^uds:/, ""), {
          type: "peer_message_status",
          orig_msg_id: frame.msg_id,
          state: reportState,
        });
      });
    });
    server.once("error", reject);
    server.listen(path, () =>
      resolve({
        path,
        frames: async (expected: number) => {
          const deadline = Date.now() + 3000;
          while (connections.length < expected && Date.now() < deadline) await Bun.sleep(20);
          await Bun.sleep(150);
          return [...connections];
        },
        walAtConnect,
        arrivedAt,
        close: () => server.close(),
      }),
    );
  });
}

/** A socket file nobody listens on: the listener was killed before it could unlink it. */
function deadSocketFile(path: string): void {
  const result = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      'require("node:net").createServer().listen(process.env.DEAD_SOCKET, () => process.kill(process.pid, "SIGKILL"))',
    ],
    { env: { ...process.env, DEAD_SOCKET: path }, stdout: "ignore", stderr: "inherit" },
  );
  if (!existsSync(path)) {
    throw new Error(`no dead socket file at ${path} (exit ${result.exitCode})`);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  /** The owner's inbox, handed to the process as CLAUDE_CODE_MESSAGING_SOCKET. */
  inbox?: string;
  env?: Record<string, string>;
}

interface StartOptions extends RunOptions {
  /** A file-sink daemon's name; without it and without an inbox the daemon exits 2. */
  id?: string;
  args?: string[];
}

type Daemon = ReturnType<typeof Bun.spawn>;

const scenarios: Scenario[] = [];
/** Every daemon any test started; the file's end asserts each is gone. */
const started: Daemon[] = [];

class Scenario {
  readonly dir: string;
  readonly stubDir: string;
  private readonly inboxes: Inbox[] = [];
  private readonly daemons: Daemon[] = [];

  constructor(name: string) {
    this.dir = temp.dir(`pr-events-${name}-`);
    this.stubDir = join(this.dir, "stub");
    mkdirSync(this.stubDir);
    this.fixtures({ "detail-1": detail({}) });
    scenarios.push(this);
  }

  fixtures(files: Record<string, string>): void {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(this.stubDir, name.includes(".") ? name : `${name}.json`), body);
    }
  }

  env(options: RunOptions = {}): Record<string, string> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: `${binDir}:${process.env.PATH}`,
      STUB_DIR: this.stubDir,
      STUB_ARGS_LOG: join(this.stubDir, "args.log"),
      STUB_VIOLATIONS: join(this.stubDir, "violations.log"),
      PR_EVENTS_DIR: this.dir,
      ...options.env,
    };
    // The test process may itself run inside a Claude Code session; the owner is the test's choice.
    delete env.CLAUDE_CODE_MESSAGING_SOCKET;
    delete env.CLAUDE_PID;
    if (options.inbox !== undefined) env.CLAUDE_CODE_MESSAGING_SOCKET = options.inbox;
    return env;
  }

  run(args: string[], options: RunOptions = {}): RunResult {
    const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
      env: this.env(options),
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString(),
      stderr: result.stderr.toString(),
    };
  }

  /** Starts a daemon as a session would, as a child, and waits for its socket (or its exit). */
  async start(options: StartOptions = {}): Promise<Daemon> {
    const args = ["daemon", ...(options.id === undefined ? [] : ["--id", options.id])];
    const daemon = Bun.spawn([process.execPath, SCRIPT, ...args, ...(options.args ?? [])], {
      env: this.env(options),
      stdout: "pipe",
      stderr: "pipe",
    });
    this.daemons.push(daemon);
    started.push(daemon);
    // A stale socket file can pre-exist, so the banner in the log, not the socket, says it is up.
    const key = options.id ?? /(\d+)\.sock$/.exec(options.inbox ?? "")?.[1] ?? String(process.pid);
    const banner = `pr-events daemon ${daemon.pid} for `;
    const deadline = Date.now() + 5000;
    while (!this.log(key).includes(banner) && daemon.exitCode === null && Date.now() < deadline) {
      await Bun.sleep(20);
    }
    return daemon;
  }

  async inbox(name: string, reportState?: string): Promise<Inbox> {
    const dir = join(this.dir, name);
    mkdirSync(dir);
    const box = await inbox(dir, this.file("events.jsonl"), reportState);
    this.inboxes.push(box);
    return box;
  }

  /** `<dir>/<owner key>.<suffix>`; the key defaults to this process, the fake inboxes' owner. */
  file(suffix: string, key: string = String(process.pid)): string {
    return join(this.dir, `${key}.${suffix}`);
  }

  socketPath(key: string = String(process.pid)): string {
    return this.file("sock", key);
  }

  ghCalls(): string[] {
    return readOr(() => readFileSync(join(this.stubDir, "args.log"), "utf-8"), "")
      .split("\n")
      .filter(Boolean);
  }

  violations(): string {
    return readOr(() => readFileSync(join(this.stubDir, "violations.log"), "utf-8"), "");
  }

  events(key?: string): Array<{
    id: number;
    kind: string;
    text: string;
    repo: string;
    pr: number | null;
    sha: string | null;
  }> {
    return readOr(() => readFileSync(this.file("events.jsonl", key), "utf-8"), "")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  log(key?: string): string {
    return readOr(() => readFileSync(this.file("log", key), "utf-8"), "");
  }

  stop(options: RunOptions & { id?: string } = {}): void {
    const args = ["stop", ...(options.id === undefined ? [] : ["--id", options.id])];
    const result = this.run(args, options);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("daemon stopped");
    expect(existsSync(this.socketPath(options.id))).toBe(false);
  }

  /** Every daemon this scenario started is gone: SIGTERM, then SIGKILL for one that ignores it. */
  async cleanup(): Promise<void> {
    for (const daemon of this.daemons.splice(0)) {
      if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill("SIGTERM");
      const exited = await Promise.race([daemon.exited, Bun.sleep(3000).then(() => null)]);
      if (exited === null) {
        daemon.kill("SIGKILL");
        await daemon.exited;
      }
    }
    for (const box of this.inboxes.splice(0)) box.close();
  }
}

afterEach(async () => {
  for (const scenario of scenarios.splice(0)) await scenario.cleanup();
});

afterAll(() => {
  const alive = started.filter((daemon) => isAlive(daemon.pid)).map((daemon) => daemon.pid);
  expect(alive).toEqual([]);
});

function parseFrame(
  raw: string,
): Record<string, unknown> & { message: { role: string; content: string } } {
  const lines = raw.split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toBe("");
  return JSON.parse(lines[0] as string);
}

function headlines(frames: string[]): string[] {
  return frames.map((frame) => parseFrame(frame).message.content.split("\n")[0] as string);
}

const PR7 = `${REPO}#7`;
const GATE_CI = ["--expect-workflow", "ci"];
const GREEN_A = `PR ${PR7}: CI green on ${SHORT_A}: ci`;
const CLOSING = "automated notice from pr-events; no reply needed";

// --- tests ------------------------------------------------------------------------

describe("pr-events.mts", () => {
  test("the frame on the wire: one connection, one line of raw text, from = the control socket, no mode; the WAL line names no recipients", async () => {
    // A child of the session is rendered as plain text, so an envelope or a from_mode would be
    // read literally; the receiver's own fields are what it keys on.
    const s = new Scenario("frame");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
    });
    await s.start({ inbox: box.path });
    const r = s.run(["watch", PR7, ...GATE_CI], { inbox: box.path });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1 target(s)");
    const frames = await box.frames(1);
    expect(frames).toHaveLength(1);
    const frame = parseFrame(frames[0] as string);
    expect(frame.type).toBe("user");
    expect(frame.message.role).toBe("user");
    expect(frame.message.content.split("\n")).toEqual([
      GREEN_A,
      `https://github.com/${REPO}/pull/7`,
      CLOSING,
    ]);
    expect(frame.from).toBe(`uds:${s.socketPath()}`);
    expect(frame.from_name).toBe("pr-events");
    expect(Object.keys(frame).sort()).toEqual(["from", "from_name", "message", "msg_id", "type"]);
    expect(typeof frame.msg_id).toBe("string");
    const [event] = s.events();
    expect(event).toMatchObject({ id: 1, kind: "ci", sha: HEAD_A });
    expect(Object.keys(event as object)).not.toContain("to");
    s.stop({ inbox: box.path });
  }, 30000);

  test("outside a session without --id, with a bad --id, or with --pid on a session, every command exits 2 before any socket, gh call, or frame", async () => {
    const s = new Scenario("usage");
    const box = await s.inbox("a");
    const outside = s.run(["watch", PR7]);
    expect(outside.code).toBe(2);
    expect(outside.stderr).toContain("CLAUDE_CODE_MESSAGING_SOCKET is unset");
    for (const id of ["a/b", "..", "x y"]) {
      const bad = s.run(["watch", PR7, "--id", id]);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain("--id must be a name");
    }
    const pinned = s.run(["daemon", "--pid", "1"], { inbox: box.path });
    expect(pinned.code).toBe(2);
    expect(pinned.stderr).toContain("--pid applies to --id");
    const long = s.run(["daemon", "--id", "x".repeat(120)]);
    expect(long.code).toBe(2);
    expect(long.stderr).toContain("longer than the 104 bytes a Unix socket allows");
    expect(s.ghCalls()).toHaveLength(0);
    expect(await box.frames(0)).toHaveLength(0);
    expect(existsSync(s.socketPath())).toBe(false);
  }, 30000);

  test("with no daemon answering, watch, unwatch, status, and wait exit 3 naming the exact background command; stop is a no-op", async () => {
    // The CLI never starts the daemon: a child of the CLI would be a detached, cross-session
    // sender whose frames the session holds. The agent starts it, so the agent needs the command.
    const s = new Scenario("nodaemon");
    const box = await s.inbox("a");
    for (const args of [
      ["watch", PR7],
      ["unwatch", "--all"],
      ["status"],
      ["wait", "--timeout", "1"],
    ]) {
      const r = s.run(args, { inbox: box.path });
      expect(r.code).toBe(3);
      expect(r.stderr).toContain(`no pr-events daemon answers for session ${process.pid}`);
      expect(r.stderr).toContain(`\n  bun "${SCRIPT}" daemon\n`);
    }
    const named = s.run(["status", "--id", "codex-12"]);
    expect(named.code).toBe(3);
    expect(named.stderr).toContain(`\n  bun "${SCRIPT}" daemon --id codex-12\n`);
    const stopped = s.run(["stop"], { inbox: box.path });
    expect(stopped.code).toBe(0);
    expect(stopped.stdout).toContain("no daemon running");
    expect(s.ghCalls()).toHaveLength(0);
  }, 30000);

  test("gh missing from PATH: the daemon exits 2 naming the tool", async () => {
    const s = new Scenario("nogh");
    const box = await s.inbox("a");
    const daemon = await s.start({ inbox: box.path, env: { PATH: emptyBinDir } });
    expect(await daemon.exited).toBe(2);
    expect(await new Response(daemon.stderr as ReadableStream).text()).toContain(
      "gh not found on PATH",
    );
    expect(existsSync(s.socketPath())).toBe(false);
  }, 30000);

  test("CLAUDE_CODE_TMPDIR is a runtime directory ahead of the OS temp dir, which does not read it", async () => {
    const s = new Scenario("ladder");
    const box = await s.inbox("a");
    const env = s.env({ inbox: box.path });
    delete env.PR_EVENTS_DIR;
    delete env.XDG_RUNTIME_DIR;
    const result = Bun.spawnSync([process.execPath, SCRIPT, "status"], {
      env: { ...env, CLAUDE_CODE_TMPDIR: join(s.dir, "cc-tmp") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode).toBe(3);
    const uid = process.getuid?.() ?? 0;
    expect(result.stderr.toString()).toContain(
      ` on ${join(s.dir, "cc-tmp", `pr-events-${uid}`, `${process.pid}.sock`)};`,
    );
  }, 30000);

  test("the daemon exits on its own, socket removed, once the session whose inbox named it is gone", async () => {
    // Started as a background task, nothing else ends it when the session exits; left running it
    // would poll GitHub for a session that can no longer read the events.
    const s = new Scenario("owner-gone");
    const session = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"]);
    const inboxPath = join(s.dir, `${session.pid}.inbox`, `${session.pid}.sock`);
    mkdirSync(join(s.dir, `${session.pid}.inbox`));
    const daemon = await s.start({ inbox: inboxPath });
    const socket = s.socketPath(String(session.pid));
    expect(existsSync(socket)).toBe(true);
    expect(s.run(["status"], { inbox: inboxPath }).stdout).toContain(`for session ${session.pid}`);
    session.kill();
    await session.exited;
    const exit = await Promise.race([
      daemon.exited,
      Bun.sleep(5000).then(() => "timeout" as const),
    ]);
    expect(exit).toBe(0);
    expect(existsSync(socket)).toBe(false);
    expect(s.log(String(session.pid))).toContain(`session ${session.pid} exited`);
  }, 30000);

  test("the session's end is noticed before every gh read, within one target's reads too", async () => {
    // Every gh read holds the event loop; a target whose detail read is slow would otherwise go on
    // to its check-suite read for a session that is gone.
    const s = new Scenario("owner-gone-midpoll");
    const session = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"]);
    const inboxPath = join(s.dir, `${session.pid}.inbox`, `${session.pid}.sock`);
    mkdirSync(join(s.dir, `${session.pid}.inbox`));
    s.fixtures({
      "rows-1": rows({ rollup: "PENDING" }),
      "suites-1": suites([["ci", "queued", null]]),
      "rows-2": rows({ rollup: "PENDING", comments: 1, updatedAt: T2 }),
      "detail-2": detail({ comments: [{ login: "bob", at: T2, body: "hm" }] }),
      "viewer-1": VIEWER,
    });
    const daemon = await s.start({ inbox: inboxPath });
    expect(s.run(["watch", PR7], { inbox: inboxPath }).code).toBe(0);
    const suiteReads = () => s.ghCalls().filter((call) => call.includes("checkSuites(")).length;
    expect(suiteReads()).toBe(1);
    writeFileSync(join(s.stubDir, "slow-detail"), "");
    const poll = Bun.spawn([process.execPath, SCRIPT, "poll"], {
      env: s.env({ inbox: inboxPath }),
      stdout: "pipe",
      stderr: "pipe",
    });
    // The fake logs a call as it starts, so the session ends while the slow detail read is in flight.
    const detailReads = () =>
      s.ghCalls().filter((call) => call.includes("reviewThreads(first:")).length;
    const started = Date.now() + 5000;
    while (detailReads() < 2 && Date.now() < started) await Bun.sleep(20);
    expect(detailReads()).toBe(2);
    session.kill();
    await session.exited;
    const exit = await Promise.race([
      daemon.exited,
      Bun.sleep(6000).then(() => "timeout" as const),
    ]);
    expect(exit).toBe(0);
    await poll.exited;
    expect(suiteReads()).toBe(1);
    expect(s.log(String(session.pid))).toContain(`session ${session.pid} exited`);
  }, 30000);

  test("a watch on a connection accepted before the stop is refused, and a stop drains the poll in flight before the socket goes", async () => {
    // Released at once, the socket would let a replacement daemon start while this one still
    // delivers and saves over its state; answered ok, the watch would add work no poll runs.
    const s = new Scenario("stop-drain");
    const box = await s.inbox("a");
    s.fixtures({ "suites-1": suites([["ci", "completed", "success"]]) });
    await s.start({ inbox: box.path });
    expect(s.run(["watch-commit", REPO, HEAD_A, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    const held = connect(s.socketPath());
    await new Promise<void>((resolve) => held.once("connect", () => resolve()));
    // A second poll right after the first waits its delivery gap; the stop lands inside that wait.
    const poll = Bun.spawn([process.execPath, SCRIPT, "watch-commit", REPO, HEAD_B, ...GATE_CI], {
      env: s.env({ inbox: box.path }),
      stdout: "pipe",
      stderr: "pipe",
    });
    await Bun.sleep(300);
    const stopped = Date.now();
    s.stop({ inbox: box.path });
    expect(Date.now() - stopped).toBeGreaterThanOrEqual(500);
    expect(await poll.exited).toBe(0);
    expect(headlines(await box.frames(2))).toHaveLength(2);
    held.setEncoding("utf-8");
    const replied = new Promise<string>((resolve) => {
      let bytes = "";
      held.on("data", (chunk: string) => {
        bytes += chunk;
      });
      held.on("close", () => resolve(bytes));
    });
    held.write(
      `${JSON.stringify({
        cmd: "watch",
        target: { kind: "pr", repo: REPO, number: 7, head: null, expected: [] },
      })}\n`,
    );
    expect(await replied).toBe('{"ok":false,"error":"daemon stopping; retry"}\n');
    expect(JSON.parse(readFileSync(s.file("state.json"), "utf-8")).prs).toEqual({});
  }, 30000);

  test("two polls seconds apart deliver two messages at least a second apart, so the receiver keeps both", async () => {
    // The receiver drops a second frame from one sender within the same second; two `watch`
    // calls in a row each poll at once.
    const s = new Scenario("gap");
    const box = await s.inbox("a");
    s.fixtures({ "suites-1": suites([["ci", "completed", "success"]]) });
    await s.start({ inbox: box.path });
    for (const sha of [HEAD_A, HEAD_B]) {
      // Spawned asynchronously, so the fake inbox stamps each arrival as it happens.
      const watch = Bun.spawn([process.execPath, SCRIPT, "watch-commit", REPO, sha, ...GATE_CI], {
        env: s.env({ inbox: box.path }),
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await watch.exited).toBe(0);
    }
    expect(headlines(await box.frames(2))).toEqual([
      `commit ${REPO}@${SHORT_A}: CI green on ${SHORT_A}: ci`,
      `commit ${REPO}@${HEAD_B.slice(0, 12)}: CI green on ${HEAD_B.slice(0, 12)}: ci`,
    ]);
    const [first, second] = box.arrivedAt as [number, number];
    expect(second - first).toBeGreaterThanOrEqual(1000);
    s.stop({ inbox: box.path });
  }, 30000);

  test("the registered workflow set is compared by workflow id: a second workflow under the same name is a change, so the green waits", async () => {
    // Two workflow files can share a name; by name the set would read unchanged and the first
    // all-green read would settle before the second workflow had run.
    const s = new Scenario("same-name");
    const id = ["--id", "same-name"];
    s.fixtures({
      "suites-1": suites([["CI", "completed", "success", 1, 11]]),
      "suites-2": suites([
        ["CI", "completed", "success", 1, 11],
        ["CI", "completed", "success", 2, 22],
      ]),
    });
    await s.start({ id: "same-name" });
    expect(s.run(["watch-commit", REPO, HEAD_A, ...id]).code).toBe(0);
    expect(s.run(["poll", ...id]).stdout).toContain("0 event(s)");
    expect(s.run(["poll", ...id]).stdout).toContain("1 event(s)");
    expect(s.events("same-name").map((e) => e.text)).toEqual([`CI green on ${SHORT_A}: CI`]);
    s.stop({ id: "same-name" });
  }, 30000);

  test("a repeated watch restarts the missing-workflow grace: two calls seconds apart are not the two polls a minute apart", async () => {
    const s = new Scenario("regrace");
    const id = ["--id", "regrace"];
    s.fixtures({ "suites-1": suites([["bystander", "completed", "success"]]) });
    await s.start({ id: "regrace" });
    const gate = ["--expect-workflow", "checks"];
    expect(s.run(["watch-commit", REPO, HEAD_A, ...gate, ...id]).code).toBe(0);
    expect(s.run(["watch-commit", REPO, HEAD_A, ...gate, ...id]).code).toBe(0);
    expect(s.events("regrace")).toEqual([]);
    expect(s.run(["poll", ...id]).stdout).toContain("1 event(s)");
    expect(s.events("regrace").map((e) => e.kind)).toEqual(["trouble"]);
    s.stop({ id: "regrace" });
  }, 30000);

  test("a watch queued behind a poll when the stop arrives is refused instead of polling after the socket is gone", async () => {
    // The queued watch awaited the poll in flight, as the stop did; once that poll was drained it
    // would start another, delivering and saving after the socket had been released.
    const s = new Scenario("queued-watch");
    const box = await s.inbox("a");
    s.fixtures({ "suites-1": suites([["ci", "completed", "success"]]) });
    await s.start({ inbox: box.path });
    expect(s.run(["watch-commit", REPO, HEAD_A, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    const cli = (args: string[]) =>
      Bun.spawn([process.execPath, SCRIPT, ...args], {
        env: s.env({ inbox: box.path }),
        stdout: "pipe",
        stderr: "pipe",
      });
    // A's poll waits in its delivery gap; B queues behind it; the stop lands in the same wait.
    const a = cli(["watch-commit", REPO, HEAD_B, ...GATE_CI]);
    await Bun.sleep(200);
    const b = cli(["watch-commit", REPO, MERGE_C, ...GATE_CI]);
    await Bun.sleep(200);
    const stop = cli(["stop"]);
    expect(await a.exited).toBe(0);
    expect(await b.exited).toBe(2);
    expect(await new Response(b.stderr).text()).toContain("daemon stopping; retry");
    expect(await stop.exited).toBe(0);
    expect(existsSync(s.socketPath())).toBe(false);
    expect(headlines(await box.frames(2))).toHaveLength(2);
    expect(s.events().map((e) => e.sha)).toEqual([HEAD_A, HEAD_B]);
    expect(Object.keys(JSON.parse(readFileSync(s.file("state.json"), "utf-8")).commits)).toEqual([
      `${REPO}@${MERGE_C}`,
    ]);
  }, 30000);

  test("a stop arriving while a signal's shutdown drains waits for that same shutdown, so it answers once the socket is gone", async () => {
    const s = new Scenario("double-stop");
    const box = await s.inbox("a");
    s.fixtures({ "suites-1": suites([["ci", "completed", "success"]]) });
    const daemon = await s.start({ inbox: box.path });
    expect(s.run(["watch-commit", REPO, HEAD_A, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    const a = Bun.spawn([process.execPath, SCRIPT, "watch-commit", REPO, HEAD_B, ...GATE_CI], {
      env: s.env({ inbox: box.path }),
      stdout: "pipe",
      stderr: "pipe",
    });
    await Bun.sleep(300);
    daemon.kill("SIGTERM");
    s.stop({ inbox: box.path });
    expect(await a.exited).toBe(0);
    expect(await daemon.exited).toBe(0);
    expect(headlines(await box.frames(2))).toHaveLength(2);
  }, 30000);

  test("a second daemon for the same session exits 0 saying so and leaves the first serving; a stale socket file is replaced", async () => {
    const s = new Scenario("second");
    const box = await s.inbox("a");
    deadSocketFile(s.socketPath());
    const first = await s.start({ inbox: box.path });
    expect(s.log()).toContain("replacing the stale control socket");
    const second = await s.start({ inbox: box.path });
    expect(await second.exited).toBe(0);
    expect(await new Response(second.stdout as ReadableStream).text()).toContain(
      "another pr-events daemon already serves",
    );
    expect(first.exitCode).toBeNull();
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain(
      `daemon: running (pid ${first.pid})`,
    );
    s.stop({ inbox: box.path });
  }, 30000);

  test("a rollup flip with updatedAt unchanged is a CI event and reads no detail", async () => {
    const s = new Scenario("rollup");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "PENDING" }),
      "suites-1": suites([["ci", "in_progress", null]]),
      "rows-2": rows({ rollup: "SUCCESS" }),
      "suites-2": suites([
        ["ci", "completed", "success"],
        ["lint", "completed", "skipped"],
      ]),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    expect(await box.frames(0)).toHaveLength(0);
    const detailReads = () => s.ghCalls().filter((call) => call.includes("reviewThreads(first:"));
    expect(detailReads()).toHaveLength(1);
    const r = s.run(["poll"], { inbox: box.path });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1 event(s)");
    expect(headlines(await box.frames(1))).toEqual([`PR ${PR7}: CI green on ${SHORT_A}: ci, lint`]);
    expect(detailReads()).toHaveLength(1);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a reply inside an existing thread (thread count unchanged) is a comment event with path:line; the viewer's own is not", async () => {
    const s = new Scenario("reply");
    const box = await s.inbox("a");
    const thread = (comments: CommentSpec[]): ThreadSpec => ({
      path: "src/a.ts",
      line: 12,
      total: comments.length,
      comments,
    });
    const first = { login: "alice", at: "2025-12-31T00:00:00Z", body: "first" };
    const mine = { login: "me", at: "2026-01-01T00:30:00Z", body: "my own reply" };
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS", threads: 1, updatedAt: T1 }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "rows-2": rows({ rollup: "SUCCESS", threads: 1, updatedAt: T2 }),
      "detail-1": detail({ threads: [thread([first, mine])] }),
      "detail-2": detail({
        threads: [thread([first, mine, { login: "bob", at: T2, body: "Looks wrong\nhere" }])],
      }),
      "viewer-1": VIEWER,
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).code).toBe(0);
    const frames = await box.frames(2);
    expect(frames).toHaveLength(2);
    const content = parseFrame(frames[1] as string).message.content;
    expect(content.split("\n").slice(0, 2)).toEqual([
      `PR ${PR7}: 1 new comment by bob`,
      "  src/a.ts:12  Looks wrong here",
    ]);
    expect(content).not.toContain("my own reply");
    expect(content).not.toContain("first");
    expect(s.events().map((e) => e.kind)).toEqual(["ci", "comment"]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("the page's specimen is the rendered text, byte for byte: inline comments headlined under the review that published them, aligned", async () => {
    // The page promises the shape; a renderer that listed the two inline comments as "2 new
    // comments" or dropped the review wrapper would leave the specimen describing an event the
    // daemon never sends.
    const page = readFileSync(join(ROOT, "skills", "watch-prs-and-ci", "SKILL.md"), "utf-8");
    const block = /```text\n(PR octocat\/repo#12: new review[\s\S]*?)```/.exec(page);
    expect(block).not.toBeNull();
    const specimen = (block as RegExpExecArray)[1]?.trimEnd().split("\n") as string[];
    const [headline, first, second, url, closing] = specimen;
    expect(specimen).toHaveLength(5);
    const reviewer = /new review by (\S+) \(COMMENTED\)/.exec(headline as string)?.[1] as string;
    const inline = (line: string) => {
      const match = /^ {2}(\S+):(\d+) +(.*)$/.exec(line) as RegExpMatchArray;
      return { path: match[1] as string, line: Number(match[2]), body: match[3] as string };
    };
    const [a, b] = [inline(first as string), inline(second as string)];
    const s = new Scenario("specimen");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "rows-2": rows({ rollup: "SUCCESS", threads: 2, updatedAt: T2 }),
      "detail-2": detail({
        reviews: [{ id: "77", login: reviewer, at: T2, state: "COMMENTED", body: "" }],
        threads: [a, b].map((comment) => ({
          path: comment.path,
          line: comment.line,
          total: 1,
          comments: [{ login: reviewer, at: T2, body: comment.body, review: "77" }],
        })),
      }),
      "viewer-1": VIEWER,
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    const frames = await box.frames(2);
    expect(parseFrame(frames[1] as string).message.content).toBe(
      [
        (headline as string).replace("PR octocat/repo#12", `PR ${PR7}`),
        first,
        second,
        (url as string).replace("octocat/repo/pull/12", `${REPO}/pull/7`),
        closing,
      ].join("\n"),
    );
    expect(s.events().map((e) => e.kind)).toEqual(["ci", "review"]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a comment event is not replayed when the CI read that follows it fails", async () => {
    const s = new Scenario("replay");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "rows-2": rows({ rollup: "FAILURE", comments: 1, updatedAt: T2 }),
      "detail-2": detail({ comments: [{ login: "bob", at: T2, body: "hm" }] }),
      "viewer-1": VIEWER,
      "suites-2": suites([["ci", "completed", "failure", 700]]),
      "log-700.txt": "boom",
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    writeFileSync(join(s.stubDir, "fail-suites"), "");
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    unlinkSync(join(s.stubDir, "fail-suites"));
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(s.events().map((e) => e.kind)).toEqual(["ci", "comment", "ci"]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a comment in the baseline's own second, and one read ahead of its row, each arrive exactly once", async () => {
    // Judged by instant against the row's updatedAt, alice's T1 comment is never newer than the
    // T1 baseline, and carol's T3 comment (published between the row read and the detail read
    // that followed it) is reported now and again when the row catches up to T3.
    const s = new Scenario("cursor");
    const box = await s.inbox("a");
    const baseline = { login: "dev", at: T1, body: "opening", id: 901 };
    const sameSecond = { login: "alice", at: T1, body: "same second", id: 902 };
    const ahead = { login: "carol", at: T3, body: "ahead of the row", id: 903 };
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS", comments: 1, updatedAt: T1 }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "detail-1": detail({ comments: [baseline] }),
      "rows-2": rows({ rollup: "SUCCESS", comments: 2, updatedAt: T1 }),
      "detail-2": detail({ comments: [baseline, sameSecond] }),
      "viewer-1": VIEWER,
      "rows-3": rows({ rollup: "SUCCESS", comments: 3, updatedAt: T2 }),
      "detail-3": detail({ comments: [baseline, sameSecond, ahead] }),
      "rows-4": rows({ rollup: "SUCCESS", comments: 3, updatedAt: T3 }),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    for (const expected of ["1 event(s)", "1 event(s)", "0 event(s)"]) {
      expect(s.run(["poll"], { inbox: box.path }).stdout).toContain(expected);
    }
    expect(headlines(await box.frames(3))).toEqual([
      GREEN_A,
      `PR ${PR7}: 1 new comment by alice`,
      `PR ${PR7}: 1 new comment by carol`,
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("reads with nothing new keep the whole window seen, so deleting the newest comment does not replay the baseline", async () => {
    // A read cut below the newest reported comment must not narrow what counts as seen: after two
    // such reads the seen set would hold that one comment alone, and its deletion would make the
    // baseline comments beneath it new again.
    const s = new Scenario("deleted");
    const box = await s.inbox("a");
    const baseline = [1, 2, 3].map((n) => ({ login: "dev", at: T1, body: `c${n}`, id: 900 + n }));
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS", comments: 3, updatedAt: T1 }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "detail-1": detail({ comments: baseline }),
      "rows-2": rows({ rollup: "SUCCESS", comments: 3, updatedAt: T2 }),
      "rows-3": rows({ rollup: "SUCCESS", comments: 3, updatedAt: T3 }),
      "rows-4": rows({ rollup: "SUCCESS", comments: 2, updatedAt: T3 }),
      "detail-4": detail({ comments: baseline.slice(0, 2) }),
      "viewer-1": VIEWER,
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    for (let poll = 0; poll < 3; poll += 1) {
      expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    }
    expect(s.events().map((e) => e.kind)).toEqual(["ci"]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a row whose head differs from the --head recorded is a head-moved event naming the author; the recorded head is not", async () => {
    const cases: Array<[string, string, string[]]> = [
      ["moved", HEAD_A, [`PR ${PR7}: head moved to ${HEAD_B.slice(0, 12)} by carol`]],
      ["same", HEAD_B, []],
    ];
    for (const [name, recorded, expected] of cases) {
      const s = new Scenario(`head-${name}`);
      const box = await s.inbox("a");
      s.fixtures({
        "rows-1": rows({ head: HEAD_B, rollup: null }),
        "detail-1": detail({ commitAuthor: "carol" }),
        "suites-1": suites([["ci", "in_progress", null]]),
      });
      await s.start({ inbox: box.path });
      const r = s.run(["watch", PR7, "--head", recorded], { inbox: box.path });
      expect(r.code).toBe(0);
      expect(headlines(await box.frames(expected.length))).toEqual(expected);
      s.stop({ inbox: box.path });
    }
  }, 30000);

  test("a merged row: merged event, then the MERGE commit is judged with the PR's gates until settled, then the mainline CI event; wait still reads the dropped PR's lines", async () => {
    const s = new Scenario("merged");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "rows-2": rows({ state: "MERGED", mergedAt: T2, mergeCommit: MERGE_C, rollup: "SUCCESS" }),
      "suites-2": suites([["ci", "in_progress", null, 200]]),
      "suites-3": suites([["ci", "completed", "success", 200]]),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain(
      `  ${REPO}@${SHORT_C} since 20`,
    );
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(headlines(await box.frames(3))).toEqual([
      GREEN_A,
      `PR ${PR7}: merged at ${T2}; mainline commit ${SHORT_C} is now watched for CI`,
      `commit ${REPO}@${SHORT_C}: CI green on ${SHORT_C}: ci`,
    ]);
    const suiteOids = s
      .ghCalls()
      .filter((call) => call.includes("checkSuites("))
      .map((call) => /-f oid=([0-9a-f]+)/.exec(call)?.[1]);
    expect(suiteOids).toEqual([HEAD_A, MERGE_C, MERGE_C]);
    const status = s.run(["status"], { inbox: box.path }).stdout;
    expect(status).toContain("prs: 0");
    expect(status).toContain("commits: 0");
    const routed = s.run(["wait", "--since", "0", "--timeout", "1"], { inbox: box.path });
    expect(routed.code).toBe(0);
    expect(routed.stdout.trim().split("\n")).toHaveLength(4);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a merged row without a merge commit yet keeps its target, and the merged event carries the commit once GitHub reports it", async () => {
    // Dropped at the first merged read, a merge commit reported one poll later would never be
    // watched, and the mainline verdict would never arrive.
    const s = new Scenario("merge-oid-late");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "rows-2": rows({ state: "MERGED", mergedAt: T2, rollup: "SUCCESS" }),
      "rows-4": rows({ state: "MERGED", mergedAt: T2, mergeCommit: MERGE_C, rollup: "SUCCESS" }),
      "suites-2": suites([["ci", "in_progress", null, 200]]),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain(`  ${PR7} head=`);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(headlines(await box.frames(2))).toEqual([
      GREEN_A,
      `PR ${PR7}: merged at ${T2}; mainline commit ${SHORT_C} is now watched for CI`,
    ]);
    const status = s.run(["status"], { inbox: box.path }).stdout;
    expect(status).toContain("prs: 0");
    expect(status).toContain("commits: 1");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a merged row whose merge commit never comes is given up after 5 polls with a trouble notice, not silently", async () => {
    const s = new Scenario("merge-oid-never");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "rows-2": rows({ state: "MERGED", mergedAt: T2, rollup: "SUCCESS" }),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    for (let poll = 1; poll <= 4; poll += 1) {
      expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    }
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(headlines(await box.frames(2))).toEqual([
      GREEN_A,
      `PR ${PR7}: merged at ${T2}; no merge commit reported after 5 polls, so its mainline CI is not watched`,
    ]);
    const status = s.run(["status"], { inbox: box.path }).stdout;
    expect(status).toContain("prs: 0");
    expect(status).toContain("commits: 0");
    s.stop({ inbox: box.path });
  }, 30000);

  test("the same sha watched in two repositories is judged in each", async () => {
    const s = new Scenario("fork");
    const id = ["--id", "codex"];
    // Each watch polls at once, and a poll judges every watched commit: suites calls 1 to 3 belong
    // to the two watches, 4 and 5 to the explicit poll.
    s.fixtures({
      "suites-1": suites([["ci", "queued", null]]),
      "suites-4": suites([["ci", "completed", "success"]]),
    });
    await s.start({ id: "codex" });
    for (const repo of [REPO, FORK]) {
      expect(s.run(["watch-commit", repo, HEAD_A, ...id]).code).toBe(0);
    }
    expect(s.run(["poll", ...id]).stdout).toContain("2 event(s)");
    expect(s.events("codex").map((e) => [e.repo, e.sha])).toEqual([
      [REPO, HEAD_A],
      [FORK, HEAD_A],
    ]);
    const repos = s
      .ghCalls()
      .filter((call) => call.includes("checkSuites("))
      .map((call) => /-f name=(\S+)/.exec(call)?.[1]);
    expect(repos).toEqual(["example", "example", "fork", "example", "fork"]);
    expect(s.run(["status", ...id]).stdout).toContain("commits: 0");
    s.stop({ id: "codex" });
  }, 30000);

  test("a red CI event carries the --log-failed tail, and no other Actions endpoint is touched", async () => {
    const s = new Scenario("red");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "FAILURE" }),
      "suites-1": suites([
        ["ci", "completed", "failure", 501],
        ["lint", "completed", "success", 502],
      ]),
      "log-501.txt": "test\tUnit tests\t2026-01-01T00:00:00Z Error: boom at src/a.ts:12\n",
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7], { inbox: box.path }).code).toBe(0);
    const frames = await box.frames(1);
    expect(frames).toHaveLength(1);
    const content = parseFrame(frames[0] as string).message.content;
    expect(content).toContain(`CI red on ${SHORT_A}`);
    expect(content).toContain("FAIL(failure): ci (501)");
    expect(content).toContain("pass: lint (502)");
    expect(content).toContain("Error: boom at src/a.ts:12");
    expect(s.ghCalls().filter((call) => call.startsWith("run "))).toEqual([
      `run view 501 --log-failed --repo ${REPO}`,
    ]);
    expect(s.violations()).toBe("");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a changed gate set re-judges the head: a gate absent while a bystander still runs is a trouble notice after the grace, never green, and the corrected name replaces the typo", async () => {
    // Ranked below a pending bystander, the missing gate would be waited on for as long as
    // anything ran; unioned with the typo, the corrected gate set could never go green.
    const s = new Scenario("gate");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["bystander", "completed", "success"]]),
      "suites-2": suites([
        ["bystander", "completed", "success"],
        ["other", "queued", null],
      ]),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, "--expect-workflow", "bystander"], { inbox: box.path }).code).toBe(
      0,
    );
    expect(headlines(await box.frames(1))).toEqual([
      `PR ${PR7}: CI green on ${SHORT_A}: bystander`,
    ]);
    expect(s.run(["watch", PR7, "--expect-workflow", "gaet"], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    const frames = await box.frames(2);
    const content = parseFrame(frames[1] as string).message.content;
    expect(content).toContain("CI run not registered");
    expect(content).toContain("no run registered for gaet");
    expect(content).toContain("pending(queued): other");
    expect(content).not.toContain("green");
    expect(s.events().map((e) => e.kind)).toEqual(["ci", "trouble"]);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    s.fixtures({
      "suites-5": suites([
        ["bystander", "completed", "success"],
        ["gate", "completed", "success"],
        ["other", "completed", "success"],
      ]),
    });
    expect(s.run(["watch", PR7, "--expect-workflow", "gate"], { inbox: box.path }).code).toBe(0);
    expect(headlines(await box.frames(3)).at(-1)).toBe(
      `PR ${PR7}: CI green on ${SHORT_A}: bystander, gate, other`,
    );
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain(" gates=gate ");
    expect(s.run(["unwatch", PR7], { inbox: box.path }).code).toBe(0);
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain("prs: 0");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a gate name with a comma is one name", async () => {
    const s = new Scenario("comma");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["CI, Linux", "completed", "success"]]),
    });
    await s.start({ inbox: box.path });
    const r = s.run(["watch", PR7, "--expect-workflow", "CI, Linux"], { inbox: box.path });
    expect(r.code).toBe(0);
    expect(headlines(await box.frames(1))).toEqual([
      `PR ${PR7}: CI green on ${SHORT_A}: CI, Linux`,
    ]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("a merge commit keeps the gates watch-commit named for it over the PR's; a trouble notice does not end its watch", async () => {
    const s = new Scenario("gates");
    const id = ["--id", "a"];
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["pr-gate", "completed", "success"]]),
      "suites-2": suites([]),
      "rows-3": rows({ state: "MERGED", mergedAt: T2, mergeCommit: MERGE_C, rollup: "SUCCESS" }),
      "suites-3": suites([["pr-gate", "completed", "success", 300]]),
      "suites-4": suites([
        ["pr-gate", "completed", "success", 300],
        ["main-gate", "completed", "success", 301],
      ]),
    });
    await s.start({ id: "a" });
    expect(s.run(["watch", PR7, "--expect-workflow", "pr-gate", ...id]).code).toBe(0);
    expect(
      s.run(["watch-commit", REPO, MERGE_C, "--expect-workflow", "main-gate", ...id]).code,
    ).toBe(0);
    expect(s.run(["poll", ...id]).stdout).toContain("2 event(s)");
    expect(s.run(["poll", ...id]).stdout).toContain("1 event(s)");
    const events = s.events("a");
    expect(events.map((e) => e.kind)).toEqual(["ci", "merged", "trouble", "ci"]);
    expect(events[2]?.text).toContain("no run registered for main-gate");
    expect(events[2]?.text).not.toContain("no run registered for pr-gate");
    expect(events[3]?.text).toBe(`CI green on ${SHORT_C}: main-gate, pr-gate`);
    expect(s.run(["status", ...id]).stdout).toContain("commits: 0");
    s.stop({ id: "a" });
  }, 30000);

  test("with no gate named, a first all-green read is not a verdict: a workflow registering red on the next read is reported, and an unchanged set is confirmed green", async () => {
    // Poll 1 sees only a quick housekeeping run; the gate registers afterwards. Settled on poll 1,
    // the red gate would never be reported.
    const cases: Array<[string, RunSpec[], string]> = [
      [
        "late-red",
        [
          ["assign", "completed", "success", 1],
          ["gate", "completed", "failure", 2],
        ],
        `CI red on ${SHORT_A}`,
      ],
      ["confirmed", [["assign", "completed", "success", 1]], `CI green on ${SHORT_A}: assign`],
    ];
    for (const [name, second, expected] of cases) {
      const s = new Scenario(`register-${name}`);
      const id = ["--id", name];
      s.fixtures({
        "suites-1": suites([["assign", "completed", "success", 1]]),
        "suites-2": suites(second),
        "log-2.txt": "gate failed",
      });
      await s.start({ id: name });
      expect(s.run(["watch-commit", REPO, HEAD_A, ...id]).code).toBe(0);
      expect(s.events(name)).toEqual([]);
      expect(s.run(["poll", ...id]).stdout).toContain("1 event(s)");
      expect(s.events(name).map((e) => e.text.split("\n")[0])).toEqual([expected]);
      expect(s.run(["status", ...id]).stdout).toContain("commits: 0");
      s.stop({ id: name });
    }
  }, 30000);

  test("a failed PR-row read does not stop the watched commits from being judged", async () => {
    const s = new Scenario("rows-down");
    const id = ["--id", "a"];
    s.fixtures({
      // Suites calls 1 to 3 belong to the two watches (the PR twice, the commit once); with the
      // rows read failing, the explicit poll's only suites call, the fourth, is the commit's.
      "rows-1": rows({ rollup: "PENDING" }),
      "suites-1": suites([["ci", "queued", null]]),
      "suites-4": suites([["ci", "completed", "success"]]),
    });
    await s.start({ id: "a" });
    expect(s.run(["watch", PR7, ...id]).code).toBe(0);
    expect(s.run(["watch-commit", REPO, MERGE_C, ...id]).code).toBe(0);
    writeFileSync(join(s.stubDir, "fail-rows"), "");
    expect(s.run(["poll", ...id]).stdout).toContain("1 event(s)");
    expect(s.events("a").map((e) => [e.kind, e.sha])).toEqual([["ci", MERGE_C]]);
    s.stop({ id: "a" });
  }, 30000);

  test("a watched PR missing from the rows read counts as a failed poll, so three in a row raise the trouble notice", async () => {
    const s = new Scenario("omitted");
    const id = ["--id", "a"];
    s.fixtures({
      "rows-1": rows({ rollup: "PENDING" }, { number: 8, rollup: "PENDING" }),
      "suites-1": suites([["ci", "queued", null]]),
      "rows-3": rows({ rollup: "PENDING" }),
    });
    await s.start({ id: "a" });
    expect(s.run(["watch", PR7, ...id]).code).toBe(0);
    expect(s.run(["watch", `${REPO}#8`, ...id]).code).toBe(0);
    for (const expected of ["0 event(s)", "0 event(s)", "1 event(s)"]) {
      expect(s.run(["poll", ...id]).stdout).toContain(expected);
    }
    const events = s.events("a");
    expect(events.map((e) => e.kind)).toEqual(["trouble"]);
    expect(events[0]?.text).toContain(`${REPO}#8: not in the rows read`);
    s.stop({ id: "a" });
  }, 30000);

  test("stop, fixtures advance, start again: the restarted daemon polls at once and exactly the missed deltas arrive, none twice, a second after the last message", async () => {
    // A restart right after a stop would otherwise send its first message within a second of
    // the previous daemon's last one, which the receiver drops.
    const s = new Scenario("resume");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS", comments: 1, updatedAt: T1 }),
      "suites-1": suites([["ci", "completed", "success"]]),
    });
    await s.start({ inbox: box.path });
    // Spawned asynchronously, so the fake inbox stamps the arrival as it happens.
    const watch = Bun.spawn([process.execPath, SCRIPT, "watch", PR7, ...GATE_CI], {
      env: s.env({ inbox: box.path }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await watch.exited).toBe(0);
    s.stop({ inbox: box.path });
    s.fixtures({
      "rows-2": rows({ rollup: "SUCCESS", comments: 2, updatedAt: T2 }),
      "detail-2": detail({ comments: [{ login: "bob", at: T2, body: "ship it" }] }),
      "viewer-1": VIEWER,
    });
    await s.start({ inbox: box.path });
    expect(headlines(await box.frames(2))).toEqual([GREEN_A, `PR ${PR7}: 1 new comment by bob`]);
    const [first, second] = box.arrivedAt as [number, number];
    expect(second - first).toBeGreaterThanOrEqual(1000);
    expect(s.run(["watch", PR7, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    expect(s.events().map((e) => e.id)).toEqual([1, 2]);
    s.stop({ inbox: box.path });
  }, 30000);

  test("the WAL line exists when delivery is attempted; a refusing inbox leaves it logged and status shows the failure", async () => {
    const live = new Scenario("wal-first");
    const box = await live.inbox("a");
    live.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
    });
    await live.start({ inbox: box.path });
    // Spawned asynchronously: the fake inbox samples the log at the moment the daemon connects,
    // which a spawnSync would postpone until the CLI had exited.
    const watch = Bun.spawn([process.execPath, SCRIPT, "watch", PR7, ...GATE_CI], {
      env: live.env({ inbox: box.path }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await watch.exited).toBe(0);
    expect(await box.frames(1)).toHaveLength(1);
    expect(box.walAtConnect).toEqual([[1]]);
    expect(live.run(["status"], { inbox: box.path }).stdout).toContain("delivery: sent (#1 at ");
    live.stop({ inbox: box.path });

    const refused = new Scenario("wal-refused");
    const dead = join(refused.dir, "dead", `${process.pid}.sock`);
    mkdirSync(join(refused.dir, "dead"));
    deadSocketFile(dead);
    refused.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
    });
    await refused.start({ inbox: dead });
    expect(refused.run(["watch", PR7, ...GATE_CI], { inbox: dead }).code).toBe(0);
    expect(refused.events().map((e) => [e.id, e.kind])).toEqual([[1, "ci"]]);
    expect(refused.run(["status"], { inbox: dead }).stdout).toContain(
      "delivery: failed: ECONNREFUSED (#1 at ",
    );
    refused.stop({ inbox: dead });
  }, 30000);

  test("a WAL tail cut mid-line does not swallow the next event appended", async () => {
    const s = new Scenario("wal-tail");
    const id = ["--id", "probe"];
    writeFileSync(
      s.file("events.jsonl", "probe"),
      `${JSON.stringify({ id: 1, at: T1, repo: REPO, pr: 7, sha: null, kind: "comment", text: "old", url: "" })}\n{"id":2,"at":`,
    );
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
    });
    await s.start({ id: "probe" });
    expect(s.run(["watch", PR7, ...GATE_CI, ...id]).code).toBe(0);
    const r = s.run(["wait", "--since", "1", "--timeout", "1", ...id]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ id: 2, kind: "ci" });
    s.stop({ id: "probe" });
  }, 30000);

  test("wait --since returns only newer lines and the cursor, blocks until a poll appends, exits 4 at timeout, and exits 3 once the daemon is gone", async () => {
    const s = new Scenario("wait");
    const id = ["--id", "probe"];
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "rows-2": rows({ rollup: "FAILURE" }),
      "suites-2": suites([["ci", "completed", "failure", 700]]),
      "log-700.txt": "boom",
      "rows-3": rows({ rollup: "FAILURE", updatedAt: T3, comments: 1 }),
      "detail-2": detail({ comments: [{ login: "bob", at: T3, body: "again" }] }),
      "viewer-1": VIEWER,
    });
    await s.start({ id: "probe" });
    expect(s.run(["watch", PR7, ...GATE_CI, ...id]).code).toBe(0);
    expect(s.run(["poll", ...id]).stdout).toContain("1 event(s)");
    const since1 = s.run(["wait", "--since", "1", "--timeout", "1", ...id]);
    expect(since1.code).toBe(0);
    const lines = since1.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ id: 2, kind: "ci", pr: 7 });
    expect(lines[1]).toBe("cursor: 2");
    const timedOut = s.run(["wait", "--since", "2", "--timeout", "1", ...id]);
    expect(timedOut.code).toBe(4);
    expect(timedOut.stdout).toContain("cursor: 2");
    const blocking = Bun.spawn(
      [process.execPath, SCRIPT, "wait", "--since", "2", "--timeout", "20", ...id],
      { env: s.env(), stdout: "pipe", stderr: "pipe" },
    );
    await Bun.sleep(300);
    expect(s.run(["poll", ...id]).stdout).toContain("1 event(s)");
    expect(await blocking.exited).toBe(0);
    const unblocked = (await new Response(blocking.stdout).text()).trim().split("\n");
    expect(JSON.parse(unblocked[0] as string)).toMatchObject({ id: 3, kind: "comment" });
    expect(unblocked[1]).toBe("cursor: 3");
    s.stop({ id: "probe" });
    expect(s.run(["wait", "--since", "3", "--timeout", "1", ...id]).code).toBe(3);
  }, 40000);

  test("three failed polls in a row are one trouble notice, then one recovery, and the daemon stays up", async () => {
    const s = new Scenario("trouble");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "PENDING" }),
      "suites-1": suites([["ci", "queued", null]]),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7], { inbox: box.path }).code).toBe(0);
    writeFileSync(join(s.stubDir, "fail-rows"), "");
    for (const expected of ["0 event(s)", "0 event(s)", "1 event(s)", "0 event(s)"]) {
      expect(s.run(["poll"], { inbox: box.path }).stdout).toContain(expected);
    }
    unlinkSync(join(s.stubDir, "fail-rows"));
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("1 event(s)");
    expect(headlines(await box.frames(2))).toEqual([
      `pr-events: polling failed 3 times in a row (rows: gh api graphql exited 1: gh: graphql boom); not a verdict. Auth errors in ${s.file("log")}: run stop, then start the daemon again`,
      "pr-events: polling recovered",
    ]);
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain("daemon: running");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a held delivery reported back by the inbox is what status shows; a report for an unknown message is logged and changes nothing", async () => {
    // A session that holds a frame says so only by a peer_message_status frame to the daemon's
    // control socket; a daemon that ignored frames without `cmd` would show the delivery as sent
    // for good.
    const s = new Scenario("held");
    const box = await s.inbox("a", "held");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    expect(await box.frames(1)).toHaveLength(1);
    const deadline = Date.now() + 3000;
    let status = s.run(["status"], { inbox: box.path }).stdout;
    while (!status.includes("delivery: held") && Date.now() < deadline) {
      await Bun.sleep(50);
      status = s.run(["status"], { inbox: box.path }).stdout;
    }
    expect(status).toContain("delivery: held (#1 at ");
    await sendLine(s.socketPath(), {
      type: "peer_message_status",
      orig_msg_id: "pr-events-1-not-ours",
      state: "released",
    });
    while (!s.log().includes("unknown delivery") && Date.now() < deadline) await Bun.sleep(50);
    expect(s.log()).toContain(
      "peer_message_status for an unknown delivery pr-events-1-not-ours; ignored",
    );
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain("delivery: held (#1 at ");
    s.stop({ inbox: box.path });
    expect(JSON.parse(readFileSync(s.file("state.json"), "utf-8")).delivery).toMatchObject({
      eventIds: [1],
      outcome: "held",
    });
  }, 30000);

  test("a poll with several events sends one frame: the events separated by a blank line, each with its own text and URL, one closing line", async () => {
    // The receiver drops a second frame from one sender within the same second, so a poll that
    // sent one frame per event would lose every event after the first.
    const s = new Scenario("digest");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "rows-2": rows({ rollup: "FAILURE", comments: 1, updatedAt: T2 }),
      "detail-2": detail({ comments: [{ login: "bob", at: T2, body: "hm" }] }),
      "viewer-1": VIEWER,
      "suites-2": suites([["ci", "completed", "failure", 700]]),
      "log-700.txt": "boom",
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("2 event(s)");
    const frames = await box.frames(2);
    expect(frames).toHaveLength(2);
    const content = parseFrame(frames[1] as string).message.content;
    const url = `https://github.com/${REPO}/pull/7`;
    expect(content.split("\n\n")).toEqual([
      `PR ${PR7}: 1 new comment by bob\n  bob  hm\n${url}`,
      `PR ${PR7}: CI red on ${SHORT_A}\n  FAIL(failure): ci (700)\n  --- ci (700) failed-step log tail ---\n  boom\n${url}\n${CLOSING}`,
    ]);
    expect(s.run(["status"], { inbox: box.path }).stdout).toContain("delivery: sent (#2,#3 at ");
    s.stop({ inbox: box.path });
  }, 30000);

  test("stop, 21 comments land, start again: all 21 arrive in one event, the oldest included", async () => {
    // The detail read's window is the last 20 comments; the 21st oldest is beyond it and, with
    // the window alone, would never be reported.
    const s = new Scenario("backlog");
    const box = await s.inbox("a");
    const opening = { login: "dev", at: T1, body: "opening", id: 900 };
    const missed = Array.from({ length: 21 }, (_, i) => ({
      login: "bob",
      at: T2,
      body: `missed ${i + 1}`,
      id: 901 + i,
    }));
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS", comments: 1, updatedAt: T1 }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "detail-1": detail({ comments: [opening] }),
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    s.stop({ inbox: box.path });
    s.fixtures({
      "rows-2": rows({ rollup: "SUCCESS", comments: 22, updatedAt: T2 }),
      "detail-2": detail({ comments: missed.slice(1), commentsBefore: "c902" }),
      "older-1": olderComments([opening, missed[0] as CommentSpec]),
      "viewer-1": VIEWER,
    });
    await s.start({ inbox: box.path });
    const frames = await box.frames(2);
    const content = parseFrame(frames[1] as string).message.content.split("\n");
    expect(content[0]).toBe(`PR ${PR7}: 21 new comments by bob`);
    expect(content[1]).toBe("  bob  missed 1");
    expect(content[21]).toBe("  bob  missed 21");
    expect(s.events().map((e) => e.kind)).toEqual(["ci", "comment"]);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("0 event(s)");
    s.stop({ inbox: box.path });
  }, 30000);

  test("a backlog past the paging cap is a trouble event beside the comments that were read", async () => {
    const s = new Scenario("paging-cap");
    const box = await s.inbox("a");
    const older: Record<string, string> = {};
    for (let page = 1; page <= 9; page += 1) {
      older[`older-${page}`] = olderComments(
        [{ login: "bob", at: T2, body: `older ${page}`, id: 800 - page }],
        `c${800 - page}`,
      );
    }
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS", comments: 1, updatedAt: T1 }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "rows-2": rows({ rollup: "SUCCESS", comments: 500, updatedAt: T2 }),
      "detail-2": detail({
        comments: [{ login: "bob", at: T2, body: "newest", id: 800 }],
        commentsBefore: "c800",
      }),
      ...older,
      "viewer-1": VIEWER,
    });
    await s.start({ inbox: box.path });
    expect(s.run(["watch", PR7, ...GATE_CI], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"], { inbox: box.path }).stdout).toContain("2 event(s)");
    const frames = await box.frames(2);
    const content = parseFrame(frames[1] as string).message.content;
    expect(content.split("\n")[0]).toBe(`PR ${PR7}: 10 new comments by bob`);
    expect(content).toContain(
      `PR ${PR7}: issue comments: more than 10 pages since the last one reported; the older ones are not reported; read the PR`,
    );
    expect(s.ghCalls().filter((call) => call.includes("query OlderComments("))).toHaveLength(9);
    s.stop({ inbox: box.path });
  }, 30000);
});
