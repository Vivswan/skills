import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";
import { tempDirs } from "./helpers/temp-dirs";

// Contract tests for the PR-events daemon. A stub gh on PATH dispatches each GraphQL query on the
// substring only that query class carries and serves hand-written fixture N for call N of the
// class (the last fixture repeats once the sequence runs out). A PR's first sighting reads its
// detail as the baseline, so every scenario starts with an empty `detail-1` and a scenario's own
// detail fixtures begin at 2. Each subscriber is a fake Claude Code inbox: a Unix socket named by
// this live pid, collecting every connection's bytes. Polls are driven with `poll`, so no timer
// fires and the fixture order is the poll order. Every test ends with `stop` and the control
// socket gone, so no daemon outlives its test.

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

/** [workflow name, status, conclusion, run id] */
type RunSpec = [string, string, string | null, number?];

function suites(runs: RunSpec[]): string {
  const nodes = runs.map(([name, status, conclusion, id], i) => ({
    status,
    conclusion,
    app: { slug: "github-actions" },
    workflowRun: {
      databaseId: id ?? 100 + i,
      updatedAt: T1,
      workflow: { databaseId: [...name].reduce((sum, c) => sum + c.charCodeAt(0), 0), name },
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
          reviews: connection([]),
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

/** A fake Claude Code inbox at <dir>/<this pid>.sock: a live pid, so the liveness rule keeps it. */
function inbox(dir: string, walPath: string): Promise<Inbox> {
  const path = join(dir, `${process.pid}.sock`);
  const connections: string[] = [];
  const walAtConnect: number[][] = [];
  return new Promise((resolve, reject) => {
    const server: Server = createServer((socket) => {
      walAtConnect.push(eventIds(walPath));
      let bytes = "";
      socket.setEncoding("utf-8");
      socket.on("data", (chunk: string) => {
        bytes += chunk;
      });
      socket.on("close", () => connections.push(bytes));
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

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface RunOptions {
  inbox?: string;
  cwd?: string;
  env?: Record<string, string>;
}

const scenarios: Scenario[] = [];

class Scenario {
  readonly dir: string;
  readonly stubDir: string;
  private readonly inboxes: Inbox[] = [];

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
    // The test process may itself run inside a Claude Code session; the inbox is the test's choice.
    delete env.CLAUDE_CODE_MESSAGING_SOCKET;
    if (options.inbox !== undefined) env.CLAUDE_CODE_MESSAGING_SOCKET = options.inbox;
    return env;
  }

  run(args: string[], options: RunOptions = {}): RunResult {
    const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
      cwd: options.cwd,
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

  async inbox(name: string): Promise<Inbox> {
    const dir = join(this.dir, name);
    mkdirSync(dir);
    const box = await inbox(dir, join(this.dir, "events.jsonl"));
    this.inboxes.push(box);
    return box;
  }

  ghCalls(): string[] {
    return readOr(() => readFileSync(join(this.stubDir, "args.log"), "utf-8"), "")
      .split("\n")
      .filter(Boolean);
  }

  violations(): string {
    return readOr(() => readFileSync(join(this.stubDir, "violations.log"), "utf-8"), "");
  }

  events(): Array<{
    id: number;
    kind: string;
    text: string;
    repo: string;
    pr: number | null;
    sha: string | null;
    to: string[];
  }> {
    return readOr(() => readFileSync(join(this.dir, "events.jsonl"), "utf-8"), "")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  log(): string {
    return readOr(() => readFileSync(join(this.dir, "daemon.log"), "utf-8"), "");
  }

  socketPath(): string {
    return join(this.dir, "daemon.sock");
  }

  stop(): void {
    const result = this.run(["stop"]);
    expect(result.code).toBe(0);
    expect(existsSync(this.socketPath())).toBe(false);
  }

  cleanup(): void {
    this.run(["stop"]);
    for (const box of this.inboxes.splice(0)) box.close();
  }
}

afterAll(() => {
  for (const scenario of scenarios) scenario.cleanup();
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

function listeningPid(log: string): string {
  const match = /daemon (\d+) listening on/.exec(log);
  if (!match) throw new Error("no listening line in the daemon log");
  return match[1] as string;
}

const PR7 = `${REPO}#7`;
const GREEN_A = `PR ${PR7}: CI green on ${SHORT_A}: ci`;

// --- tests ------------------------------------------------------------------------

describe("pr-events.mts", () => {
  test("the frame on the wire: one connection, one line, the asserted from_mode, from = the control socket", async () => {
    const s = new Scenario("frame");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
    });
    const r = s.run(["watch", PR7, "--mode", "prompting"], { inbox: box.path });
    expect(r.code).toBe(0);
    const frames = await box.frames(1);
    expect(frames).toHaveLength(1);
    const frame = parseFrame(frames[0] as string);
    expect(frame.type).toBe("user");
    expect(frame.message.role).toBe("user");
    expect(frame.message.content.split("\n")).toEqual([
      GREEN_A,
      `https://github.com/${REPO}/pull/7`,
      "automated notice from pr-events; no reply needed",
    ]);
    expect(frame.from).toBe(`uds:${s.socketPath()}`);
    expect(frame.from_name).toBe("pr-events");
    expect(frame.from_mode).toBe("prompting");
    expect(typeof frame.msg_id).toBe("string");
    expect(s.events().map((e) => [e.id, e.kind, e.to])).toEqual([[1, "ci", [box.path]]]);
    s.stop();
  }, 30000);

  test("watch without --mode, or with --pid on an inbox, exits 2 before any daemon, gh call, or frame", async () => {
    const s = new Scenario("nomode");
    const box = await s.inbox("a");
    const r = s.run(["watch", PR7], { inbox: box.path });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--mode is required");
    const pinned = s.run(["watch", PR7, "--mode", "bypass", "--pid", "1"], { inbox: box.path });
    expect(pinned.code).toBe(2);
    expect(pinned.stderr).toContain("--pid applies to the file sink");
    for (const id of ["constructor", "__proto__", "a/b"]) {
      const bad = s.run(["watch", PR7, "--mode", "bypass", "--sink", "file", "--id", id]);
      expect(bad.code).toBe(2);
      expect(bad.stderr).toContain("--id must be a name");
    }
    expect(s.ghCalls()).toHaveLength(0);
    expect(await box.frames(0)).toHaveLength(0);
    expect(existsSync(s.socketPath())).toBe(false);
    s.stop();
  }, 30000);

  test("gh missing from PATH exits 2 for watch and for daemon alike, naming the tool", () => {
    const s = new Scenario("nogh");
    for (const args of [
      ["watch", PR7, "--mode", "bypass", "--sink", "file", "--id", "x"],
      ["daemon", "--idle-seconds", "1"],
    ]) {
      const r = s.run(args, { env: { PATH: emptyBinDir } });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("gh not found on PATH");
    }
    expect(existsSync(s.socketPath())).toBe(false);
    s.stop();
  }, 30000);

  test("a relative PR_EVENTS_DIR names the same directory in the CLI and in the daemon it spawns", async () => {
    const s = new Scenario("reldir");
    s.fixtures({
      "rows-1": rows({ rollup: "PENDING" }),
      "suites-1": suites([["ci", "queued", null]]),
    });
    const r = s.run(["watch", PR7, "--mode", "bypass", "--sink", "file", "--id", "x"], {
      cwd: s.dir,
      env: { PR_EVENTS_DIR: "runtime" },
    });
    expect(r.code).toBe(0);
    expect(existsSync(join(s.dir, "runtime", "daemon.sock"))).toBe(true);
    const stopped = s.run(["stop"], { cwd: s.dir, env: { PR_EVENTS_DIR: "runtime" } });
    expect(stopped.stdout).toContain("daemon stopped");
    expect(existsSync(join(s.dir, "runtime", "daemon.sock"))).toBe(false);
    s.stop();
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
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: box.path }).code).toBe(0);
    expect(await box.frames(0)).toHaveLength(0);
    const detailReads = () => s.ghCalls().filter((call) => call.includes("reviewThreads(first:"));
    expect(detailReads()).toHaveLength(1);
    const r = s.run(["poll"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1 event(s)");
    const frames = await box.frames(1);
    expect(headlines(frames)).toEqual([`PR ${PR7}: CI green on ${SHORT_A}: ci, lint`]);
    expect(parseFrame(frames[0] as string).from_mode).toBe("bypass");
    expect(detailReads()).toHaveLength(1);
    s.stop();
  }, 30000);

  test("a reply inside an existing thread (thread count unchanged) is a comment event with path:line; the viewer's own is not", async () => {
    const s = new Scenario("reply");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS", threads: 1, updatedAt: T1 }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "rows-2": rows({ rollup: "SUCCESS", threads: 1, updatedAt: T2 }),
      "detail-1": detail({
        threads: [
          {
            path: "src/a.ts",
            line: 12,
            total: 2,
            comments: [
              { login: "alice", at: "2025-12-31T00:00:00Z", body: "first" },
              { login: "me", at: "2026-01-01T00:30:00Z", body: "my own reply" },
            ],
          },
        ],
      }),
      "detail-2": detail({
        threads: [
          {
            path: "src/a.ts",
            line: 12,
            total: 3,
            comments: [
              { login: "alice", at: "2025-12-31T00:00:00Z", body: "first" },
              { login: "me", at: "2026-01-01T00:30:00Z", body: "my own reply" },
              { login: "bob", at: T2, body: "Looks wrong\nhere" },
            ],
          },
        ],
      }),
      "viewer-1": VIEWER,
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"]).code).toBe(0);
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
    s.stop();
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
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: box.path }).code).toBe(0);
    writeFileSync(join(s.stubDir, "fail-suites"), "");
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    expect(s.run(["poll"]).stdout).toContain("0 event(s)");
    unlinkSync(join(s.stubDir, "fail-suites"));
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    expect(s.events().map((e) => e.kind)).toEqual(["ci", "comment", "ci"]);
    s.stop();
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
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: box.path }).code).toBe(0);
    for (const expected of ["1 event(s)", "1 event(s)", "0 event(s)"]) {
      expect(s.run(["poll"]).stdout).toContain(expected);
    }
    expect(headlines(await box.frames(3))).toEqual([
      GREEN_A,
      `PR ${PR7}: 1 new comment by alice`,
      `PR ${PR7}: 1 new comment by carol`,
    ]);
    s.stop();
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
      const r = s.run(["watch", PR7, "--mode", "bypass", "--head", recorded], { inbox: box.path });
      expect(r.code).toBe(0);
      expect(headlines(await box.frames(expected.length))).toEqual(expected);
      s.stop();
    }
  }, 30000);

  test("a merged row: merged event, then the MERGE commit is judged until settled, then the mainline CI event; wait --id still routes the dropped PR's events", async () => {
    const s = new Scenario("merged");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "rows-2": rows({ state: "MERGED", mergedAt: T2, mergeCommit: MERGE_C, rollup: "SUCCESS" }),
      "suites-2": suites([["ci", "in_progress", null, 200]]),
      "suites-3": suites([["ci", "completed", "success", 200]]),
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
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
    const status = s.run(["status"]).stdout;
    expect(status).toContain("subscribers: 0");
    expect(status).toContain("prs: 0");
    expect(status).toContain("pending commits: 0");
    const routed = s.run(["wait", "--since", "0", "--timeout", "1", "--id", box.path]);
    expect(routed.code).toBe(0);
    expect(routed.stdout.trim().split("\n")).toHaveLength(4);
    s.stop();
  }, 30000);

  test("the same sha watched in two repositories is judged in each", async () => {
    const s = new Scenario("fork");
    // Each watch polls at once, and a poll judges every pending commit: suites calls 1 to 3 belong
    // to the two watches, 4 and 5 to the explicit poll.
    s.fixtures({
      "suites-1": suites([["ci", "queued", null]]),
      "suites-4": suites([["ci", "completed", "success"]]),
    });
    for (const [repo, id] of [
      [REPO, "a"],
      [FORK, "b"],
    ]) {
      const r = s.run([
        "watch-commit",
        repo as string,
        HEAD_A,
        "--mode",
        "bypass",
        "--sink",
        "file",
        "--id",
        id as string,
      ]);
      expect(r.code).toBe(0);
    }
    expect(s.run(["poll"]).stdout).toContain("2 event(s)");
    expect(s.events().map((e) => [e.repo, e.sha, e.to])).toEqual([
      [REPO, HEAD_A, ["a"]],
      [FORK, HEAD_A, ["b"]],
    ]);
    const repos = s
      .ghCalls()
      .filter((call) => call.includes("checkSuites("))
      .map((call) => /-f name=(\S+)/.exec(call)?.[1]);
    expect(repos).toEqual(["example", "example", "fork", "example", "fork"]);
    expect(s.run(["status"]).stdout).toContain("pending commits: 0");
    s.stop();
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
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: box.path }).code).toBe(0);
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
    s.stop();
  }, 30000);

  test("a gate named after a green verdict re-judges the head; a gate absent from the suites is a trouble notice after the grace, never green", async () => {
    const s = new Scenario("gate");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["bystander", "completed", "success"]]),
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: box.path }).code).toBe(0);
    const gated = s.run(["watch", PR7, "--mode", "bypass", "--expect-workflow", "gate"], {
      inbox: box.path,
    });
    expect(gated.code).toBe(0);
    expect(headlines(await box.frames(1))).toEqual([
      `PR ${PR7}: CI green on ${SHORT_A}: bystander`,
    ]);
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    const frames = await box.frames(2);
    const content = parseFrame(frames[1] as string).message.content;
    expect(content).toContain("CI run not registered");
    expect(content).toContain("no run registered for gate");
    expect(content).not.toContain("green");
    expect(s.events().map((e) => e.kind)).toEqual(["ci", "trouble"]);
    expect(s.run(["poll"]).stdout).toContain("0 event(s)");
    s.fixtures({
      "suites-5": suites([
        ["bystander", "completed", "success"],
        ["gate", "completed", "success"],
      ]),
    });
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    expect(headlines(await box.frames(3)).at(-1)).toBe(
      `PR ${PR7}: CI green on ${SHORT_A}: bystander, gate`,
    );
    expect(s.run(["unwatch", PR7], { inbox: box.path }).code).toBe(0);
    expect(s.run(["status"]).stdout).toContain("subscribers: 0");
    s.stop();
  }, 30000);

  test("a gate name with a comma is one name", async () => {
    const s = new Scenario("comma");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["CI, Linux", "completed", "success"]]),
    });
    const r = s.run(["watch", PR7, "--mode", "bypass", "--expect-workflow", "CI, Linux"], {
      inbox: box.path,
    });
    expect(r.code).toBe(0);
    expect(headlines(await box.frames(1))).toEqual([
      `PR ${PR7}: CI green on ${SHORT_A}: CI, Linux`,
    ]);
    s.stop();
  }, 30000);

  test("a merge commit keeps the gates named for it by watch-commit and for the PR; a trouble notice does not end its watch", async () => {
    const s = new Scenario("gates");
    const sink = ["--sink", "file", "--id", "a"];
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
    expect(
      s.run(["watch", PR7, "--mode", "bypass", "--expect-workflow", "pr-gate", ...sink]).code,
    ).toBe(0);
    expect(
      s.run([
        "watch-commit",
        REPO,
        MERGE_C,
        "--mode",
        "bypass",
        "--expect-workflow",
        "main-gate",
        ...sink,
      ]).code,
    ).toBe(0);
    expect(s.run(["poll"]).stdout).toContain("2 event(s)");
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    const events = s.events();
    expect(events.map((e) => e.kind)).toEqual(["ci", "merged", "trouble", "ci"]);
    expect(events[2]?.text).toContain("no run registered for main-gate");
    expect(events[3]?.text).toBe(`CI green on ${SHORT_C}: main-gate, pr-gate`);
    expect(s.run(["status"]).stdout).toContain("pending commits: 0");
    s.stop();
  }, 30000);

  test("a failed PR-row read does not stop the pending commits from being judged", () => {
    const s = new Scenario("rows-down");
    const sink = ["--sink", "file", "--id", "a"];
    s.fixtures({
      // Suites calls 1 to 3 belong to the two watches (the PR twice, the commit once); with the
      // rows read failing, the explicit poll's only suites call, the fourth, is the commit's.
      "rows-1": rows({ rollup: "PENDING" }),
      "suites-1": suites([["ci", "queued", null]]),
      "suites-4": suites([["ci", "completed", "success"]]),
    });
    expect(s.run(["watch", PR7, "--mode", "bypass", ...sink]).code).toBe(0);
    expect(s.run(["watch-commit", REPO, MERGE_C, "--mode", "bypass", ...sink]).code).toBe(0);
    writeFileSync(join(s.stubDir, "fail-rows"), "");
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    expect(s.events().map((e) => [e.kind, e.sha])).toEqual([["ci", MERGE_C]]);
    s.stop();
  }, 30000);

  test("a subscribed PR missing from the rows read counts as a failed poll, so three in a row raise the trouble notice", () => {
    const s = new Scenario("omitted");
    const sink = ["--sink", "file", "--id", "a"];
    s.fixtures({
      "rows-1": rows({ rollup: "PENDING" }, { number: 8, rollup: "PENDING" }),
      "suites-1": suites([["ci", "queued", null]]),
      "rows-3": rows({ rollup: "PENDING" }),
    });
    expect(s.run(["watch", PR7, "--mode", "bypass", ...sink]).code).toBe(0);
    expect(s.run(["watch", `${REPO}#8`, "--mode", "bypass", ...sink]).code).toBe(0);
    for (const expected of ["0 event(s)", "0 event(s)", "1 event(s)"]) {
      expect(s.run(["poll"]).stdout).toContain(expected);
    }
    const events = s.events();
    expect(events.map((e) => e.kind)).toEqual(["trouble"]);
    expect(events[0]?.text).toContain(`${REPO}#8: not in the rows read`);
    s.stop();
  }, 30000);

  test("two concurrent watch calls over a stale control socket: one daemon binds, both subscriptions land", async () => {
    const s = new Scenario("race");
    const a = await s.inbox("a");
    const b = await s.inbox("b");
    deadSocketFile(s.socketPath());
    s.fixtures({
      "rows-1": rows({ rollup: "PENDING" }),
      "suites-1": suites([["ci", "queued", null]]),
    });
    const spawn = (inboxPath: string) =>
      Bun.spawn([process.execPath, SCRIPT, "watch", PR7, "--mode", "bypass"], {
        env: s.env({ inbox: inboxPath }),
        stdout: "pipe",
        stderr: "pipe",
      });
    const [first, second] = [spawn(a.path), spawn(b.path)];
    expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
    const status = s.run(["status"]).stdout;
    expect(status).toContain("subscribers: 2");
    expect(status).toContain(`socket ${a.path}`);
    expect(status).toContain(`socket ${b.path}`);
    expect(
      s
        .log()
        .split("\n")
        .filter((line) => line.includes("listening on")),
    ).toHaveLength(1);
    expect(s.run(["status"]).stdout).toContain(`daemon: running (pid ${listeningPid(s.log())})`);
    s.stop();
  }, 30000);

  test("a stale control socket file is replaced and the daemon starts", async () => {
    const s = new Scenario("stale");
    const box = await s.inbox("a");
    deadSocketFile(s.socketPath());
    s.fixtures({
      "rows-1": rows({ rollup: "PENDING" }),
      "suites-1": suites([["ci", "queued", null]]),
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: box.path }).code).toBe(0);
    expect(s.log()).toContain("replacing the stale control socket");
    expect(s.run(["status"]).stdout).toContain("daemon: running");
    s.stop();
  }, 30000);

  test("a subscriber whose inbox socket is gone is pruned; the other subscriber of the PR still receives", async () => {
    const s = new Scenario("prune");
    const a = await s.inbox("a");
    const b = await s.inbox("b");
    s.fixtures({
      "rows-1": rows({ rollup: "PENDING" }),
      "suites-1": suites([["ci", "queued", null]]),
      "rows-3": rows({ rollup: "SUCCESS" }),
      "suites-3": suites([["ci", "completed", "success"]]),
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: a.path }).code).toBe(0);
    expect(s.run(["watch", PR7, "--mode", "prompting"], { inbox: b.path }).code).toBe(0);
    unlinkSync(a.path);
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    expect(await a.frames(0)).toHaveLength(0);
    const frames = await b.frames(1);
    expect(frames).toHaveLength(1);
    expect(parseFrame(frames[0] as string).from_mode).toBe("prompting");
    const status = s.run(["status"]).stdout;
    expect(status).toContain("subscribers: 1");
    expect(status).toContain(`${a.path} pruned=inbox gone`);
    s.stop();
  }, 30000);

  test("stop, fixtures advance, watch again: exactly the missed deltas arrive, none twice", async () => {
    const s = new Scenario("resume");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS", comments: 1, updatedAt: T1 }),
      "suites-1": suites([["ci", "completed", "success"]]),
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: box.path }).code).toBe(0);
    s.stop();
    s.fixtures({
      "rows-2": rows({ rollup: "SUCCESS", comments: 2, updatedAt: T2 }),
      "detail-2": detail({ comments: [{ login: "bob", at: T2, body: "ship it" }] }),
      "viewer-1": VIEWER,
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"]).stdout).toContain("0 event(s)");
    expect(headlines(await box.frames(2))).toEqual([GREEN_A, `PR ${PR7}: 1 new comment by bob`]);
    expect(s.events().map((e) => e.id)).toEqual([1, 2]);
    s.stop();
  }, 30000);

  test("stop, 21 comments land, watch again: all 21 arrive in one event, the oldest included", async () => {
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
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: box.path }).code).toBe(0);
    s.stop();
    s.fixtures({
      "rows-2": rows({ rollup: "SUCCESS", comments: 22, updatedAt: T2 }),
      "detail-2": detail({ comments: missed.slice(1), commentsBefore: "c902" }),
      "older-1": olderComments([opening, missed[0] as CommentSpec]),
      "viewer-1": VIEWER,
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: box.path }).code).toBe(0);
    const frames = await box.frames(2);
    const content = parseFrame(frames[1] as string).message.content.split("\n");
    expect(content[0]).toBe(`PR ${PR7}: 21 new comments by bob`);
    expect(content[1]).toBe("  bob  missed 1");
    expect(content[21]).toBe("  bob  missed 21");
    expect(s.events().map((e) => e.kind)).toEqual(["ci", "comment"]);
    expect(s.run(["poll"]).stdout).toContain("0 event(s)");
    s.stop();
  }, 30000);

  test("a backlog past the paging cap is a trouble event beside the comments that were read", async () => {
    const s = new Scenario("gap");
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
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: box.path }).code).toBe(0);
    expect(s.run(["poll"]).stdout).toContain("2 event(s)");
    expect(headlines(await box.frames(3))).toEqual([
      GREEN_A,
      `PR ${PR7}: 10 new comments by bob`,
      `PR ${PR7}: issue comments: more than 10 pages since the last one reported; the older ones are not reported; read the PR`,
    ]);
    expect(s.ghCalls().filter((call) => call.includes("query OlderComments("))).toHaveLength(9);
    s.stop();
  }, 30000);

  test("unwatch with no daemon running edits the saved state, so the next start does not resume the subscription", () => {
    const s = new Scenario("offline");
    s.fixtures({
      "rows-1": rows({ rollup: "PENDING" }),
      "suites-1": suites([["ci", "queued", null]]),
    });
    const sink = ["--sink", "file", "--id", "probe"];
    expect(s.run(["watch", PR7, "--mode", "bypass", ...sink]).code).toBe(0);
    s.stop();
    const r = s.run(["unwatch", "--all", ...sink]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("unwatched everything for probe");
    const offline = s.run(["status"]).stdout;
    expect(offline).toContain("daemon: not running\n");
    expect(offline).toContain("prs: 0");
    expect(s.run(["poll"]).code).toBe(0);
    expect(s.run(["status"]).stdout).toContain("subscribers: 0");
    s.stop();
  }, 30000);

  test("a daemon with no subscribers exits at --idle-seconds and removes its socket", async () => {
    const s = new Scenario("idle");
    const daemon = Bun.spawn([process.execPath, SCRIPT, "daemon", "--idle-seconds", "1"], {
      env: s.env(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const exit = await Promise.race([
      daemon.exited,
      Bun.sleep(10000).then(() => "timeout" as const),
    ]);
    expect(exit).toBe(0);
    expect(existsSync(s.socketPath())).toBe(false);
    expect(s.log()).toContain("no subscribers for 1 s; exiting");
    expect(existsSync(join(s.dir, "state.json"))).toBe(true);
    s.stop();
  }, 30000);

  test("the WAL line exists when delivery is attempted; a refusing inbox leaves it logged and status shows the failure", async () => {
    const s = new Scenario("wal-first");
    const box = await s.inbox("a");
    const dead = join(s.dir, `${process.pid}.sock`);
    deadSocketFile(dead);
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "rows-2": rows({ rollup: "SUCCESS" }, { number: 8, rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
    });
    // Spawned asynchronously: the fake inbox samples the log at the moment the daemon connects,
    // which a spawnSync would postpone until the CLI had exited.
    const watch = Bun.spawn([process.execPath, SCRIPT, "watch", PR7, "--mode", "bypass"], {
      env: s.env({ inbox: box.path }),
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await watch.exited).toBe(0);
    expect(await box.frames(1)).toHaveLength(1);
    expect(box.walAtConnect).toEqual([[1]]);
    expect(s.run(["watch", `${REPO}#8`, "--mode", "bypass"], { inbox: dead }).code).toBe(0);
    expect(s.events().map((e) => [e.id, e.kind, e.to])).toEqual([
      [1, "ci", [box.path]],
      [2, "ci", [dead]],
    ]);
    const status = s.run(["status"]).stdout;
    expect(status).toContain("subscribers: 1");
    expect(status).toContain("prs: 1");
    expect(status).toContain(`${dead} pruned=inbox refused (ECONNREFUSED) at `);
    expect(status).toContain("delivery=failed: ECONNREFUSED (#2 at ");
    s.stop();
  }, 30000);

  test("a WAL tail cut mid-line does not swallow the next event appended", () => {
    const s = new Scenario("wal-tail");
    writeFileSync(
      join(s.dir, "events.jsonl"),
      `${JSON.stringify({ id: 1, at: T1, repo: REPO, pr: 7, sha: null, kind: "comment", text: "old", url: "", to: [] })}\n{"id":2,"at":`,
    );
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
    });
    const sink = ["--sink", "file", "--id", "probe"];
    expect(s.run(["watch", PR7, "--mode", "bypass", ...sink]).code).toBe(0);
    const r = s.run(["wait", "--since", "1", "--timeout", "1"]);
    expect(r.code).toBe(0);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ id: 2, kind: "ci", to: ["probe"] });
    s.stop();
  }, 30000);

  test("wait --since returns only newer matching lines and the cursor, blocks until a poll appends, exits 3 at timeout; a file subscriber past its lease is pruned", async () => {
    const s = new Scenario("wait");
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
    const sink = ["--sink", "file", "--id", "probe"];
    expect(s.run(["watch", PR7, "--mode", "prompting", ...sink]).code).toBe(0);
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    const since1 = s.run(["wait", "--since", "1", "--timeout", "1", "--id", "probe"]);
    expect(since1.code).toBe(0);
    const lines = since1.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ id: 2, kind: "ci", pr: 7 });
    expect(lines[1]).toBe("cursor: 2");
    const other = s.run(["wait", "--since", "0", "--timeout", "1", "--id", "someone-else"]);
    expect(other.code).toBe(3);
    const timedOut = s.run(["wait", "--since", "2", "--timeout", "1"]);
    expect(timedOut.code).toBe(3);
    expect(timedOut.stdout).toContain("cursor: 2");
    const blocking = Bun.spawn(
      [process.execPath, SCRIPT, "wait", "--since", "2", "--timeout", "20"],
      { env: s.env(), stdout: "pipe", stderr: "pipe" },
    );
    await Bun.sleep(300);
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    expect(await blocking.exited).toBe(0);
    const unblocked = (await new Response(blocking.stdout).text()).trim().split("\n");
    expect(JSON.parse(unblocked[0] as string)).toMatchObject({ id: 3, kind: "comment" });
    expect(unblocked[1]).toBe("cursor: 3");

    s.stop();
    const statePath = join(s.dir, "state.json");
    const state = JSON.parse(readFileSync(statePath, "utf-8"));
    expect(state.subscriptions.probe.liveness.until > new Date().toISOString()).toBe(true);
    state.subscriptions.probe.liveness.until = "2000-01-01T00:00:00Z";
    writeFileSync(statePath, JSON.stringify(state));
    expect(s.run(["poll"]).code).toBe(0);
    const status = s.run(["status"]).stdout;
    expect(status).toContain("subscribers: 0");
    expect(status).toContain("probe pruned=lease lapsed");
    s.stop();
  }, 40000);

  test("three failed polls in a row are one trouble notice, then one recovery, and the daemon stays up", async () => {
    const s = new Scenario("trouble");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "PENDING" }),
      "suites-1": suites([["ci", "queued", null]]),
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], { inbox: box.path }).code).toBe(0);
    writeFileSync(join(s.stubDir, "fail-rows"), "");
    for (const expected of ["0 event(s)", "0 event(s)", "1 event(s)", "0 event(s)"]) {
      expect(s.run(["poll"]).stdout).toContain(expected);
    }
    unlinkSync(join(s.stubDir, "fail-rows"));
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    expect(headlines(await box.frames(2))).toEqual([
      `pr-events: polling failed 3 times in a row (rows: gh api graphql exited 1: gh: graphql boom); not a verdict. Auth errors in ${join(s.dir, "daemon.log")}: run stop, then watch again`,
      "pr-events: polling recovered",
    ]);
    expect(s.run(["status"]).stdout).toContain("daemon: running");
    s.stop();
  }, 30000);
});
