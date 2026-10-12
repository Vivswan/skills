import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";
import { tempDirs } from "./helpers/temp-dirs";

// Contract tests for the PR-events daemon. A stub gh on PATH dispatches each GraphQL query on the
// substring only that query class carries and serves hand-written fixture N for call N of the
// class (the last fixture repeats once the sequence runs out). Each subscriber is a fake Claude
// Code inbox: a Unix socket named by this live pid, collecting every connection's bytes. Polls are
// driven with `poll`, so no timer fires and the fixture order is the poll order. Every test ends
// with `stop` and the control socket gone, so no daemon outlives its test.

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
      *"pullRequest(number:"*)
        if [ -f "\${STUB_DIR}/fail-rows" ]; then echo "gh: graphql boom" >&2; exit 1; fi
        serve rows "$(next rows)";;
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

const REPO = "octo/example";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const MERGE_C = "c".repeat(40);
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

function detail(spec: {
  comments?: CommentSpec[];
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
          comments: { nodes: (spec.comments ?? []).map((c) => commentNode(c, nextId())) },
          reviews: { nodes: [] },
          reviewThreads: {
            nodes: (spec.threads ?? []).map((thread) => ({
              isResolved: false,
              path: thread.path,
              line: thread.line,
              comments: {
                totalCount: thread.total,
                nodes: thread.comments.map((c) => commentNode(c, nextId())),
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

const VIEWER = JSON.stringify({ data: { viewer: { login: "me" } } });

// --- plumbing -------------------------------------------------------------------

interface Inbox {
  path: string;
  /** Waits for `expected` closed connections (or gives up after a few seconds), then settles: the
   * bytes arrived while spawnSync held this process's event loop. */
  frames: (expected: number) => Promise<string[]>;
  close: () => void;
}

/** A fake Claude Code inbox at <dir>/<this pid>.sock: a live pid, so the liveness rule keeps it. */
function inbox(dir: string): Promise<Inbox> {
  const path = join(dir, `${process.pid}.sock`);
  const connections: string[] = [];
  return new Promise((resolve, reject) => {
    const server: Server = createServer((socket) => {
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
  if (!existsSync(path))
    throw new Error(`no dead socket file at ${path} (exit ${result.exitCode})`);
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const scenarios: Scenario[] = [];

class Scenario {
  readonly dir: string;
  readonly stubDir: string;
  private readonly inboxes: Inbox[] = [];
  private stopped = false;

  constructor(name: string) {
    this.dir = temp.dir(`pr-events-${name}-`);
    this.stubDir = join(this.dir, "stub");
    mkdirSync(this.stubDir);
    scenarios.push(this);
  }

  fixtures(files: Record<string, string>): void {
    for (const [name, body] of Object.entries(files)) {
      writeFileSync(join(this.stubDir, name.includes(".") ? name : `${name}.json`), body);
    }
  }

  env(inboxPath?: string): Record<string, string> {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      PATH: `${binDir}:${process.env.PATH}`,
      STUB_DIR: this.stubDir,
      STUB_ARGS_LOG: join(this.stubDir, "args.log"),
      STUB_VIOLATIONS: join(this.stubDir, "violations.log"),
      PR_EVENTS_DIR: this.dir,
    };
    // The test process may itself run inside a Claude Code session; the inbox is the test's choice.
    delete env.CLAUDE_CODE_MESSAGING_SOCKET;
    if (inboxPath !== undefined) env.CLAUDE_CODE_MESSAGING_SOCKET = inboxPath;
    return env;
  }

  run(args: string[], inboxPath?: string): RunResult {
    const result = Bun.spawnSync([process.execPath, SCRIPT, ...args], {
      env: this.env(inboxPath),
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
    const box = await inbox(dir);
    this.inboxes.push(box);
    return box;
  }

  ghCalls(): string[] {
    try {
      return readFileSync(join(this.stubDir, "args.log"), "utf-8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  }

  violations(): string {
    try {
      return readFileSync(join(this.stubDir, "violations.log"), "utf-8");
    } catch {
      return "";
    }
  }

  events(): Array<{
    id: number;
    kind: string;
    text: string;
    pr: number | null;
    sha: string | null;
  }> {
    try {
      return readFileSync(join(this.dir, "events.jsonl"), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }

  log(): string {
    try {
      return readFileSync(join(this.dir, "daemon.log"), "utf-8");
    } catch {
      return "";
    }
  }

  socketPath(): string {
    return join(this.dir, "daemon.sock");
  }

  /** `stop`, then the control socket must be gone: the test's last assertion. */
  stop(): void {
    this.stopped = true;
    const result = this.run(["stop"]);
    expect(result.code).toBe(0);
    expect(existsSync(this.socketPath())).toBe(false);
  }

  cleanup(): void {
    if (!this.stopped) this.run(["stop"]);
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

const PR7 = `${REPO}#7`;

// --- tests ------------------------------------------------------------------------

describe("pr-events.mts", () => {
  test("the frame on the wire: one connection, one line, the asserted from_mode, from = the control socket", async () => {
    const s = new Scenario("frame");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
    });
    const r = s.run(["watch", PR7, "--mode", "prompting"], box.path);
    expect(r.code).toBe(0);
    const frames = await box.frames(1);
    expect(frames).toHaveLength(1);
    const frame = parseFrame(frames[0] as string);
    expect(frame.type).toBe("user");
    expect(frame.message.role).toBe("user");
    expect(frame.message.content.split("\n")[0]).toBe(
      `PR ${PR7}: CI green on ${HEAD_A.slice(0, 12)}`,
    );
    expect(frame.message.content.split("\n").at(-1)).toBe(
      "automated notice from pr-events; no reply needed",
    );
    expect(frame.message.content).toContain(`https://github.com/${REPO}/pull/7`);
    expect(frame.from).toBe(`uds:${s.socketPath()}`);
    expect(frame.from_name).toBe("pr-events");
    expect(frame.from_mode).toBe("prompting");
    expect(typeof frame.msg_id).toBe("string");
    expect(s.events().map((e) => [e.id, e.kind])).toEqual([[1, "ci"]]);
    s.stop();
  }, 30000);

  test("watch without --mode exits 2 before any daemon, gh call, or frame", async () => {
    const s = new Scenario("nomode");
    const box = await s.inbox("a");
    const r = s.run(["watch", PR7], box.path);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--mode is required");
    expect(s.ghCalls()).toHaveLength(0);
    expect(await box.frames(0)).toHaveLength(0);
    expect(existsSync(s.socketPath())).toBe(false);
    s.stop();
  }, 30000);

  test("a rollup flip with updatedAt unchanged is a CI event and reads no detail", async () => {
    const s = new Scenario("rollup");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "PENDING" }),
      "suites-1": suites([["ci", "in_progress", null]]),
      "rows-2": rows({ rollup: "SUCCESS" }),
      "suites-2": suites([["ci", "completed", "success"]]),
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], box.path).code).toBe(0);
    expect(await box.frames(0)).toHaveLength(0);
    const r = s.run(["poll"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1 event(s)");
    const frames = await box.frames(1);
    expect(frames).toHaveLength(1);
    const frame = parseFrame(frames[0] as string);
    expect(frame.message.content).toContain("CI green");
    expect(frame.message.content).toContain("pass: ci (100)");
    expect(frame.from_mode).toBe("bypass");
    expect(s.ghCalls().some((call) => call.includes("reviewThreads(first:"))).toBe(false);
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
    expect(s.run(["watch", PR7, "--mode", "bypass"], box.path).code).toBe(0);
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

  test("a row whose head differs from the --head recorded is a head-moved event naming the author; the recorded head is not", async () => {
    const cases: Array<[string, string, string[]]> = [
      ["moved", HEAD_A, [`PR ${PR7}: head moved to ${HEAD_B.slice(0, 12)} by carol`]],
      ["same", HEAD_B, []],
    ];
    for (const [name, recorded, frames] of cases) {
      const s = new Scenario(`head-${name}`);
      const box = await s.inbox("a");
      s.fixtures({
        "rows-1": rows({ head: HEAD_B, rollup: null }),
        "detail-1": detail({ commitAuthor: "carol" }),
        "suites-1": suites([["ci", "in_progress", null]]),
      });
      expect(s.run(["watch", PR7, "--mode", "bypass", "--head", recorded], box.path).code).toBe(0);
      expect(
        (await box.frames(frames.length)).map((f) => parseFrame(f).message.content.split("\n")[0]),
      ).toEqual(frames);
      s.stop();
    }
  }, 30000);

  test("a merged row: merged event, then the MERGE commit is judged until settled, then the mainline CI event", async () => {
    const s = new Scenario("merged");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
      "rows-2": rows({ state: "MERGED", mergedAt: T2, mergeCommit: MERGE_C, rollup: "SUCCESS" }),
      "suites-2": suites([["ci", "in_progress", null, 200]]),
      "suites-3": suites([["ci", "completed", "success", 200]]),
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], box.path).code).toBe(0);
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    const heads = (await box.frames(3)).map((f) => parseFrame(f).message.content.split("\n")[0]);
    expect(heads).toEqual([
      `PR ${PR7}: CI green on ${HEAD_A.slice(0, 12)}`,
      `PR ${PR7}: merged at ${T2}; mainline commit ${MERGE_C.slice(0, 12)} is now watched for CI`,
      `commit ${REPO}@${MERGE_C.slice(0, 12)}: CI green on ${MERGE_C.slice(0, 12)}`,
    ]);
    const suiteOids = s
      .ghCalls()
      .filter((call) => call.includes("checkSuites("))
      .map((call) => /-f oid=([0-9a-f]+)/.exec(call)?.[1]);
    expect(suiteOids).toEqual([HEAD_A, MERGE_C, MERGE_C]);
    const status = s.run(["status"]).stdout;
    expect(status).toContain("prs: 0");
    expect(status).toContain("pending commits: 0");
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
    expect(s.run(["watch", PR7, "--mode", "bypass"], box.path).code).toBe(0);
    const frames = await box.frames(1);
    expect(frames).toHaveLength(1);
    const content = parseFrame(frames[0] as string).message.content;
    expect(content).toContain(`CI red on ${HEAD_A.slice(0, 12)}`);
    expect(content).toContain("FAIL(failure): ci (501)");
    expect(content).toContain("pass: lint (502)");
    expect(content).toContain("Error: boom at src/a.ts:12");
    expect(s.ghCalls().filter((call) => call.startsWith("run "))).toEqual([
      `run view 501 --log-failed --repo ${REPO}`,
    ]);
    expect(s.violations()).toBe("");
    s.stop();
  }, 30000);

  test("rollup SUCCESS with the --expect-workflow gate absent is a trouble notice after the grace, never green", async () => {
    const s = new Scenario("gate");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["bystander", "completed", "success"]]),
    });
    expect(
      s.run(["watch", PR7, "--mode", "bypass", "--expect-workflow", "gate"], box.path).code,
    ).toBe(0);
    expect(await box.frames(0)).toHaveLength(0);
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    const frames = await box.frames(1);
    expect(frames).toHaveLength(1);
    const content = parseFrame(frames[0] as string).message.content;
    expect(content).toContain("CI run not registered");
    expect(content).toContain("no run registered for gate");
    expect(content).not.toContain("green");
    expect(s.events().map((e) => e.kind)).toEqual(["trouble"]);
    expect(s.run(["poll"]).stdout).toContain("0 event(s)");
    s.stop();
  }, 30000);

  test("two concurrent watch calls: one daemon binds, both subscriptions land", async () => {
    const s = new Scenario("race");
    const a = await s.inbox("a");
    const b = await s.inbox("b");
    s.fixtures({
      "rows-1": rows({ rollup: "PENDING" }),
      "suites-1": suites([["ci", "queued", null]]),
    });
    const spawn = (inboxPath: string) =>
      Bun.spawn([process.execPath, SCRIPT, "watch", PR7, "--mode", "bypass"], {
        env: s.env(inboxPath),
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
    expect(s.run(["watch", PR7, "--mode", "bypass"], box.path).code).toBe(0);
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
    expect(s.run(["watch", PR7, "--mode", "bypass"], a.path).code).toBe(0);
    expect(s.run(["watch", PR7, "--mode", "prompting"], b.path).code).toBe(0);
    unlinkSync(a.path);
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    expect(await a.frames(0)).toHaveLength(0);
    expect(await b.frames(1)).toHaveLength(1);
    expect(parseFrame((await b.frames(1))[0] as string).from_mode).toBe("prompting");
    const status = s.run(["status"]).stdout;
    expect(status).toContain("subscribers: 1");
    expect(status).toContain(`${a.path} delivery=pruned: inbox gone`);
    s.stop();
  }, 30000);

  test("stop, fixtures advance, watch again: exactly the missed deltas arrive, none twice", async () => {
    const s = new Scenario("resume");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS", comments: 1, updatedAt: T1 }),
      "suites-1": suites([["ci", "completed", "success"]]),
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], box.path).code).toBe(0);
    s.stop();
    s.fixtures({
      "rows-2": rows({ rollup: "SUCCESS", comments: 2, updatedAt: T2 }),
      "detail-1": detail({ comments: [{ login: "bob", at: T2, body: "ship it" }] }),
      "viewer-1": VIEWER,
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], box.path).code).toBe(0);
    expect(s.run(["poll"]).stdout).toContain("0 event(s)");
    const heads = (await box.frames(2)).map((f) => parseFrame(f).message.content.split("\n")[0]);
    expect(heads).toEqual([
      `PR ${PR7}: CI green on ${HEAD_A.slice(0, 12)}`,
      `PR ${PR7}: 1 new comment by bob`,
    ]);
    expect(s.events().map((e) => e.id)).toEqual([1, 2]);
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

  test("the WAL line exists before delivery: a refusing inbox leaves the event logged and status shows the failure", async () => {
    const s = new Scenario("refused");
    const dead = join(s.dir, `${process.pid}.sock`);
    deadSocketFile(dead);
    s.fixtures({
      "rows-1": rows({ rollup: "SUCCESS" }),
      "suites-1": suites([["ci", "completed", "success"]]),
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], dead).code).toBe(0);
    expect(s.events().map((e) => [e.id, e.kind])).toEqual([[1, "ci"]]);
    const status = s.run(["status"]).stdout;
    expect(status).toContain("subscribers: 0");
    expect(status).toContain(`${dead} delivery=failed: ECONNREFUSED (#1 at `);
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
      "detail-1": detail({ comments: [{ login: "bob", at: T3, body: "again" }] }),
      "viewer-1": VIEWER,
    });
    expect(
      s.run(["watch", PR7, "--mode", "prompting", "--sink", "file", "--id", "probe"]).code,
    ).toBe(0);
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    const since1 = s.run(["wait", "--since", "1", "--timeout", "1", "--id", "probe"]);
    expect(since1.code).toBe(0);
    const lines = since1.stdout.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] as string)).toMatchObject({ id: 2, kind: "ci", pr: 7 });
    expect(lines[1]).toBe("cursor: 2");
    const timedOut = s.run(["wait", "--since", "2", "--timeout", "1"]);
    expect(timedOut.code).toBe(3);
    expect(timedOut.stdout).toContain("cursor: 2");
    const blocking = Bun.spawn(
      [process.execPath, SCRIPT, "wait", "--since", "2", "--timeout", "20"],
      {
        env: s.env(),
        stdout: "pipe",
        stderr: "pipe",
      },
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
    expect(state.subscriptions.probe.leaseUntil > new Date().toISOString()).toBe(true);
    state.subscriptions.probe.leaseUntil = "2000-01-01T00:00:00Z";
    writeFileSync(statePath, JSON.stringify(state));
    expect(s.run(["poll"]).code).toBe(0);
    const status = s.run(["status"]).stdout;
    expect(status).toContain("subscribers: 0");
    expect(status).toContain("probe delivery=pruned: lease lapsed");
    s.stop();
  }, 40000);

  test("three failed polls in a row are one trouble notice, then one recovery, and the daemon stays up", async () => {
    const s = new Scenario("trouble");
    const box = await s.inbox("a");
    s.fixtures({
      "rows-1": rows({ rollup: "PENDING" }),
      "suites-1": suites([["ci", "queued", null]]),
    });
    expect(s.run(["watch", PR7, "--mode", "bypass"], box.path).code).toBe(0);
    writeFileSync(join(s.stubDir, "fail-rows"), "");
    for (const expected of ["0 event(s)", "0 event(s)", "1 event(s)", "0 event(s)"]) {
      expect(s.run(["poll"]).stdout).toContain(expected);
    }
    unlinkSync(join(s.stubDir, "fail-rows"));
    expect(s.run(["poll"]).stdout).toContain("1 event(s)");
    const heads = (await box.frames(2)).map((f) => parseFrame(f).message.content.split("\n")[0]);
    expect(heads).toEqual([
      "pr-events: polling failed 3 times in a row (gh api graphql exited 1: gh: graphql boom); not a verdict. Auth errors in " +
        `${join(s.dir, "daemon.log")}: run stop, then watch again`,
      "pr-events: polling recovered",
    ]);
    expect(s.run(["status"]).stdout).toContain("daemon: running");
    s.stop();
  }, 30000);
});
