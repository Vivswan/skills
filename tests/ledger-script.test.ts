import { afterAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";

// Contract tests for the orchestrator-mode session ledger. Each test drives
// the real script as a child process against a throwaway ledger file, pinning
// the CLI shapes and the exit matrix: 0 ok, 1 refused/not found/corrupt, 2 usage.

const SCRIPT = join(ROOT, "skills", "orchestrator-mode", "scripts", "ledger.mts");

const dir = mkdtempSync(join(tmpdir(), "ledger-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let fileCount = 0;
function freshFile(): string {
  fileCount += 1;
  return join(dir, `ledger-${fileCount}.json`);
}

// Children get a hermetic environment: the suite's own lock knobs must never
// leak in from the parent shell.
function childEnv(overrides: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.LEDGER_LOCK_TIMEOUT_MS;
  delete env.LEDGER_LOCK_STALE_MS;
  return { ...env, ...overrides };
}

// A trailing object argument is an env overlay for the child process.
type RunArg = string | Record<string, string>;

function run(file: string, ...args: RunArg[]) {
  const last = args[args.length - 1];
  const env = last !== undefined && typeof last !== "string" ? last : undefined;
  const cliArgs = (env ? args.slice(0, -1) : args) as string[];
  const result = Bun.spawnSync(["bun", SCRIPT, file, ...cliArgs], {
    stdout: "pipe",
    stderr: "pipe",
    env: childEnv(env),
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function runJson(file: string, ...args: RunArg[]) {
  const r = run(file, ...args);
  return { ...r, json: JSON.parse(r.stdout) };
}

// Whole-outcome check: the exit code and the complete JSON as one comparison,
// so a command whose output is deterministic is never pinned by a single field.
function expectRun(
  file: string,
  args: RunArg[],
  expected: { code: number; json: unknown },
  id?: string,
) {
  const r = runJson(file, ...args);
  expect({ code: r.code, json: r.json }, id).toEqual(expected);
  return r;
}

describe("init / state / show round-trip", () => {
  test("init creates, re-init never clobbers, state transitions are reported", () => {
    const file = freshFile();

    expectRun(file, ["init"], { code: 0, json: { ok: true, created: true, file } });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ workers: {}, flags: [] });

    expectRun(file, ["state", "builder-a", "active"], {
      code: 0,
      json: { ok: true, worker: "builder-a", previous: null, state: "active" },
    });
    expectRun(file, ["state", "builder-a", "dormant-by-design"], {
      code: 0,
      json: { ok: true, worker: "builder-a", previous: "active", state: "dormant-by-design" },
    });

    expectRun(file, ["init"], { code: 0, json: { ok: true, created: false, file } });

    expectRun(file, ["show", "builder-a"], {
      code: 0,
      json: { worker: "builder-a", state: "dormant-by-design", grants: [], flags: [] },
    });
    expectRun(file, ["show"], {
      code: 0,
      json: { workers: { "builder-a": { state: "dormant-by-design", grants: [] } }, flags: [] },
    });
  });

  test("show of an unknown worker exits 1", () => {
    const file = freshFile();
    run(file, "init");
    const r = runJson(file, "show", "nobody");
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
  });

  test("an invalid state name is a usage error (exit 2) with JSON on stdout", () => {
    const file = freshFile();
    run(file, "init");
    const r = runJson(file, "state", "builder-a", "sleeping");
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("invalid state");
    expect(r.json.ok).toBe(false);
  });

  test("a missing ledger file is exit 1, not silently created", () => {
    const file = freshFile();
    const r = runJson(file, "state", "builder-a", "active");
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.stderr).toContain("not found");
  });

  test("a missing command is a usage error (exit 2)", () => {
    const r = run(freshFile());
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  test("worker names that collide with Object.prototype are plain data", () => {
    const file = freshFile();
    run(file, "init");
    expect(runJson(file, "state", "__proto__", "active").code).toBe(0);
    expect(runJson(file, "grant", "constructor", "owns nothing", "none/**").code).toBe(0);

    const shown = runJson(file, "show", "__proto__");
    expect(shown.code).toBe(0);
    expect(shown.json.state).toBe("active");

    const persisted = JSON.parse(readFileSync(file, "utf-8"));
    expect(Object.keys(persisted.workers).sort()).toEqual(["__proto__", "constructor"]);
  });

  test("show <worker> includes the worker's flags even without a state entry", () => {
    const file = freshFile();
    run(file, "init");
    run(file, "flag", "builder-c", "only a flag, never a state");
    const r = runJson(file, "show", "builder-c");
    expect(r.code).toBe(0);
    expect(r.json.state).toBeNull();
    expect(r.json.grants).toEqual([]);
    expect(r.json.flags).toHaveLength(1);
    expect(r.json.flags[0].text).toBe("only a flag, never a state");
  });
});

describe("flags", () => {
  test("an identical standing flag is refused with exit 1", () => {
    const file = freshFile();
    run(file, "init");

    const first = runJson(file, "flag", "builder-a", "tests are red on main");
    expect(first.code).toBe(0);
    expect(first.json.ok).toBe(true);
    expect(first.json.hash).toMatch(/^[0-9a-f]{64}$/);

    const dup = runJson(file, "flag", "builder-a", "tests are red on main");
    expect(dup.code).toBe(1);
    expect(dup.json).toMatchObject({ ok: false, refused: "duplicate", hash: first.json.hash });

    const otherText = runJson(file, "flag", "builder-a", "tests are red on release");
    expect(otherText.code).toBe(0);
    const otherWorker = runJson(file, "flag", "builder-b", "tests are red on main");
    expect(otherWorker.code).toBe(0);
    expect(otherWorker.json.hash).not.toBe(first.json.hash);
  });

  test("retract by unique prefix, then re-flagging the same text is accepted", () => {
    const file = freshFile();
    run(file, "init");

    const flagged = runJson(file, "flag", "builder-a", "suspicious commit on main");
    const hash: string = flagged.json.hash;

    const retracted = runJson(file, "retract", hash.slice(0, 12));
    expect(retracted.code).toBe(0);
    expect(retracted.json).toMatchObject({ ok: true, hash, status: "retracted" });

    const again = runJson(file, "retract", hash.slice(0, 12));
    expect(again.code).toBe(1);
    expect(again.json).toMatchObject({ ok: false, refused: "already-retracted" });

    const reflag = runJson(file, "flag", "builder-a", "suspicious commit on main");
    expect(reflag.code).toBe(0);
    expect(reflag.json).toMatchObject({ ok: true, hash });

    const shown = runJson(file, "show");
    const entry = shown.json.flags.find((f: { hash: string }) => f.hash === hash);
    expect(entry.status).toBe("standing");
    expect(entry.retractedAt).toBeUndefined();
    // The superseded cycle is archived, not erased: retraction stays a
    // recorded transition across the re-flag.
    expect(entry.history).toEqual([
      { at: flagged.json.at, retractedAt: retracted.json.retractedAt },
    ]);
  });

  test("every completed flag->retract cycle accumulates in history", () => {
    const file = freshFile();
    run(file, "init");
    const first = runJson(file, "flag", "builder-a", "hot path regression");
    const hash: string = first.json.hash;
    const retract1 = runJson(file, "retract", hash.slice(0, 12));
    const second = runJson(file, "flag", "builder-a", "hot path regression");
    const retract2 = runJson(file, "retract", hash.slice(0, 12));
    expect(runJson(file, "flag", "builder-a", "hot path regression").code).toBe(0);

    const entry = runJson(file, "show").json.flags.find((f: { hash: string }) => f.hash === hash);
    expect(entry.status).toBe("standing");
    expect(entry.retractedAt).toBeUndefined();
    expect(entry.history).toEqual([
      { at: first.json.at, retractedAt: retract1.json.retractedAt },
      { at: second.json.at, retractedAt: retract2.json.retractedAt },
    ]);
  });

  test("a prefix matching no flag exits 1", () => {
    const file = freshFile();
    run(file, "init");
    expectRun(file, ["retract", "deadbeef"], {
      code: 1,
      json: { ok: false, error: 'no flag matches hash prefix "deadbeef"' },
    });
  });

  test("the worker/text boundary cannot collide in the hash", () => {
    const file = freshFile();
    run(file, "init");
    const a = runJson(file, "flag", "a\nb", "c");
    const b = runJson(file, "flag", "a", "b\nc");
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.json.hash).not.toBe(b.json.hash);
  });

  test("an ambiguous prefix exits 1 and lists the candidates", () => {
    const file = freshFile();
    run(file, "init");
    // 17 flags over 16 possible first hex chars: pigeonhole guarantees two
    // hashes share a one-character prefix, deterministically.
    const hashes: string[] = [];
    for (let i = 0; i < 17; i += 1) {
      hashes.push(runJson(file, "flag", "builder-a", `note ${i}`).json.hash);
    }
    const byFirstChar = new Map<string, string[]>();
    for (const hash of hashes) {
      const char = hash[0] as string;
      byFirstChar.set(char, [...(byFirstChar.get(char) ?? []), hash]);
    }
    const collided = [...byFirstChar.entries()].find(([, group]) => group.length > 1);
    expect(collided).toBeDefined();
    const [prefix, group] = collided as [string, string[]];

    const r = runJson(file, "retract", prefix);
    expect(r.code).toBe(1);
    expect(r.json.error).toContain("ambiguous");
    expect(r.json.matches).toEqual(expect.arrayContaining(group));
  });
});

describe("grants", () => {
  test("grant records the exact wording and every glob verbatim", () => {
    const file = freshFile();
    run(file, "init");
    const wording = "you own the parser and ONLY the parser; report drift instead of fixing it";
    const r = runJson(
      file,
      "grant",
      "builder-a",
      wording,
      "src/parser/**",
      "tests/parser/*.test.ts",
    );
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({ ok: true, worker: "builder-a", wording });
    expect(r.json.globs).toEqual(["src/parser/**", "tests/parser/*.test.ts"]);

    const shown = runJson(file, "show", "builder-a");
    expect(shown.json.grants).toHaveLength(1);
    expect(shown.json.grants[0].wording).toBe(wording);
    expect(shown.json.grants[0].globs).toEqual(["src/parser/**", "tests/parser/*.test.ts"]);
  });

  test("grant without globs or with a blank glob is a usage error (exit 2)", () => {
    const file = freshFile();
    run(file, "init");
    expect(run(file, "grant", "builder-a", "wording only").code).toBe(2);
    expect(run(file, "grant", "builder-a", "wording", "").code).toBe(2);
    expect(run(file, "grant", "builder-a", "wording", "   ").code).toBe(2);
  });
});

describe("corrupt ledger files", () => {
  test("unparseable JSON is a loud error on every command and is never clobbered", () => {
    const file = freshFile();
    const garbage = "{ this is not json";
    writeFileSync(file, garbage);

    for (const args of [
      ["show"],
      ["init"],
      ["state", "builder-a", "active"],
      ["flag", "builder-a", "text"],
      ["retract", "abc"],
      ["grant", "builder-a", "wording", "glob/**"],
    ]) {
      const r = runJson(file, ...args);
      expect(r.code).toBe(1);
      expect(r.json.ok).toBe(false);
      expect(r.stderr).toContain("not valid JSON");
      expect(readFileSync(file, "utf-8")).toBe(garbage);
    }
  });

  test("valid JSON with the wrong shape is also refused, not treated as empty", () => {
    const file = freshFile();
    writeFileSync(file, "[]");
    const r = runJson(file, "flag", "builder-a", "text");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("malformed");
    expect(readFileSync(file, "utf-8")).toBe("[]");
  });

  test("malformed nested entries are refused, not treated as empty", () => {
    for (const bad of [
      { workers: {}, flags: [null] },
      { workers: {}, flags: [{ hash: "x" }] },
      { workers: { a: { state: "bogus", grants: [] } }, flags: [] },
      {
        workers: { a: { state: "active", grants: [{ wording: 1, globs: [], at: "t" }] } },
        flags: [],
      },
      {
        workers: { a: { state: "active", grants: [{ wording: "w", globs: [], at: "t" }] } },
        flags: [],
      },
      {
        workers: { a: { state: "active", grants: [{ wording: "w", globs: [""], at: "t" }] } },
        flags: [],
      },
      {
        workers: { a: { state: "active", grants: [{ wording: "w", globs: ["   "], at: "t" }] } },
        flags: [],
      },
      // retractedAt travels with the retracted status and only with it; a
      // hand-edit that decouples them (or a malformed history cycle) would
      // corrupt the archive on the next re-flag.
      {
        workers: {},
        flags: [
          { hash: "h", worker: "w", text: "t", status: "standing", at: "t", retractedAt: "r" },
        ],
      },
      {
        workers: {},
        flags: [{ hash: "h", worker: "w", text: "t", status: "retracted", at: "t" }],
      },
      {
        workers: {},
        flags: [
          {
            hash: "h",
            worker: "w",
            text: "t",
            status: "standing",
            at: "t",
            history: [{ at: "t" }],
          },
        ],
      },
    ]) {
      const file = freshFile();
      const raw = JSON.stringify(bad);
      writeFileSync(file, raw);
      const r = runJson(file, "flag", "builder-a", "text");
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("malformed");
      expect(readFileSync(file, "utf-8")).toBe(raw);
    }
  });

  test("a hand-edited hash or duplicated flag entry is refused as malformed", () => {
    const seeded = freshFile();
    run(seeded, "init");
    run(seeded, "flag", "builder-a", "text");
    const goodFlag = JSON.parse(readFileSync(seeded, "utf-8")).flags[0];

    for (const flags of [[{ ...goodFlag, hash: "0".repeat(64) }], [goodFlag, goodFlag]]) {
      const file = freshFile();
      const raw = JSON.stringify({ workers: {}, flags });
      writeFileSync(file, raw);
      const r = runJson(file, "retract", goodFlag.hash.slice(0, 12));
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("malformed");
      expect(readFileSync(file, "utf-8")).toBe(raw);
    }
  });
});

describe("atomic writes", () => {
  test("writes leave no temp files behind", () => {
    const file = freshFile();
    run(file, "init");
    run(file, "flag", "builder-a", "text");
    const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  test("racing inits create the ledger exactly once and never clobber", async () => {
    const file = freshFile();
    const procs = Array.from({ length: 8 }, () =>
      Bun.spawn(["bun", SCRIPT, file, "init"], { stdout: "pipe", stderr: "pipe", env: childEnv() }),
    );
    const results = await Promise.all(
      procs.map(async (proc) => {
        const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        return { code: proc.exitCode, json: JSON.parse(stdout) };
      }),
    );
    for (const r of results) {
      expect(r.code).toBe(0);
    }
    expect(results.filter((r) => r.json.created).length).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ workers: {}, flags: [] });
  });

  test("eight serialized exit-0 writers all persist", () => {
    const file = freshFile();
    run(file, "init");
    for (let i = 0; i < 8; i += 1) {
      expect(runJson(file, "flag", `builder-${i}`, "serialized write").code).toBe(0);
    }
    const ledger = JSON.parse(readFileSync(file, "utf-8"));
    const workers = ledger.flags.map((f: { worker: string }) => f.worker).sort();
    expect(workers).toEqual(Array.from({ length: 8 }, (_, i) => `builder-${i}`).sort());
  });

  test("eight identical CONCURRENT flags: exactly one accepted, seven refused", async () => {
    const file = freshFile();
    run(file, "init");
    const procs = Array.from({ length: 8 }, () =>
      Bun.spawn(["bun", SCRIPT, file, "flag", "builder-a", "same standing flag"], {
        stdout: "pipe",
        stderr: "pipe",
        env: childEnv(),
      }),
    );
    const results = await Promise.all(
      procs.map(async (proc) => {
        const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        return { code: proc.exitCode, json: JSON.parse(stdout) };
      }),
    );
    const accepted = results.filter((r) => r.code === 0 && r.json.ok === true);
    const refused = results.filter((r) => r.code === 1 && r.json.refused === "duplicate");
    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(7);

    const ledger = JSON.parse(readFileSync(file, "utf-8"));
    expect(ledger.flags).toHaveLength(1);
    expect(ledger.flags[0].hash).toBe(accepted[0]?.json.hash);
  });

  test("eight distinct CONCURRENT flags: all persist, every hash in the file, never torn or corrupt", async () => {
    const file = freshFile();
    run(file, "init");
    const procs = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn(["bun", SCRIPT, file, "flag", `builder-${i}`, "distinct concurrent write"], {
        stdout: "pipe",
        stderr: "pipe",
        env: childEnv(),
      }),
    );
    const results = await Promise.all(
      procs.map(async (proc) => {
        const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
        return { code: proc.exitCode, json: JSON.parse(stdout) };
      }),
    );
    for (const r of results) {
      expect(r.code).toBe(0);
      expect(r.json.ok).toBe(true);
    }

    const ledger = JSON.parse(readFileSync(file, "utf-8"));
    expect(ledger.flags).toHaveLength(8);
    const persisted = new Set(ledger.flags.map((f: { hash: string }) => f.hash));
    for (const r of results) {
      // An exit-0 hash the caller may later retract must actually be durable.
      expect(persisted.has(r.json.hash)).toBe(true);
    }
    // show runs the full loader (shape + hash integrity): exit 0 means not corrupt.
    expectRun(file, ["show"], { code: 0, json: ledger });
  });
});

describe("ledger lock", () => {
  // A pid guaranteed dead: a child that has already exited.
  function deadPid(): number {
    return Bun.spawnSync(["true"]).pid;
  }

  test("a stale lock whose holder is dead is broken and the write proceeds", () => {
    const file = freshFile();
    run(file, "init");
    const lock = `${file}.lock`;
    writeFileSync(lock, `${deadPid()}\n`);
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);

    const r = runJson(file, "flag", "builder-a", "after stale lock");
    expect(r.code).toBe(0);
    expect(JSON.parse(readFileSync(file, "utf-8")).flags).toHaveLength(1);
    expect(existsSync(`${lock}.break`)).toBe(false);
  });

  test("noncanonical lock content is never attributed to a dead holder", () => {
    for (const content of ["123junk\n", "123.5\n", "0\n", "123", "-4\n", ""]) {
      const file = freshFile();
      run(file, "init");
      const lock = `${file}.lock`;
      writeFileSync(lock, content);
      const past = new Date(Date.now() - 60_000);
      utimesSync(lock, past, past);

      const r = runJson(file, "flag", "builder-a", "must not happen", {
        LEDGER_LOCK_TIMEOUT_MS: "200",
      });
      expect(r.code).toBe(1);
      expect(JSON.parse(readFileSync(file, "utf-8")).flags).toHaveLength(0);
      expect(readFileSync(lock, "utf-8")).toBe(content);
    }
  });

  test("an orphaned break mutex gates acquisition: loud timeout, no steal, no lock created", () => {
    for (const { id, staleLock } of [
      {
        id: "stale dead-holder lock present: the gate is taken before the break, so no steal",
        staleLock: true,
      },
      {
        id: "no lock present: the gate is taken before the create, so no lock appears",
        staleLock: false,
      },
    ]) {
      const file = freshFile();
      run(file, "init");
      const lock = `${file}.lock`;
      const gate = `${lock}.break`;
      const seededLock = staleLock ? `${deadPid()}\n` : null;
      if (seededLock !== null) {
        writeFileSync(lock, seededLock);
        const past = new Date(Date.now() - 60_000);
        utimesSync(lock, past, past);
      }
      writeFileSync(gate, "1\n");

      const r = expectRun(
        file,
        ["flag", "builder-a", "must not happen", { LEDGER_LOCK_TIMEOUT_MS: "200" }],
        {
          code: 1,
          json: { ok: false, error: expect.stringContaining("could not acquire ledger lock") },
        },
        id,
      );
      expect(r.stderr, id).toContain("could not acquire ledger lock");
      expect(
        {
          flags: JSON.parse(readFileSync(file, "utf-8")).flags,
          lock: existsSync(lock) ? readFileSync(lock, "utf-8") : null,
          gate: existsSync(gate) ? readFileSync(gate, "utf-8") : null,
        },
        id,
      ).toEqual({ flags: [], lock: seededLock, gate: "1\n" });
    }
  });

  test("an aged lock whose holder is ALIVE is never stolen", () => {
    const file = freshFile();
    run(file, "init");
    const lock = `${file}.lock`;
    // This test process is the live holder; age the lock far past staleness.
    writeFileSync(lock, `${process.pid}\n`);
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);

    const r = runJson(file, "flag", "builder-a", "must not happen", {
      LEDGER_LOCK_TIMEOUT_MS: "300",
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("lock");
    expect(JSON.parse(readFileSync(file, "utf-8")).flags).toHaveLength(0);
    expect(existsSync(lock)).toBe(true);
  });

  test("a live lock times out loudly; the mutation never proceeds unlocked", () => {
    const file = freshFile();
    run(file, "init");
    writeFileSync(`${file}.lock`, `${process.pid}\n`);

    const r = runJson(file, "flag", "builder-a", "blocked write", {
      LEDGER_LOCK_TIMEOUT_MS: "200",
    });
    expect(r.code).toBe(1);
    expect(r.json.ok).toBe(false);
    expect(r.stderr).toContain("lock");
    expect(JSON.parse(readFileSync(file, "utf-8")).flags).toHaveLength(0);
  });

  test("commands leave no lock or gate files behind", () => {
    const file = freshFile();
    run(file, "init");
    run(file, "state", "builder-a", "active");
    run(file, "flag", "builder-a", "text");
    run(file, "grant", "builder-a", "wording", "glob/**");
    expect(existsSync(`${file}.lock`)).toBe(false);
    expect(existsSync(`${file}.lock.break`)).toBe(false);
  });

  test("invalid lock env knobs fail loudly instead of hanging or stealing", () => {
    for (const bad of ["NaN", "Infinity", "0", "-5", "1.5", "abc"]) {
      const file = freshFile();
      run(file, "init");
      const r = runJson(file, "flag", "builder-a", "text", { LEDGER_LOCK_TIMEOUT_MS: bad });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("positive integer");
      expect(JSON.parse(readFileSync(file, "utf-8")).flags).toHaveLength(0);

      const s = runJson(file, "flag", "builder-a", "text", { LEDGER_LOCK_STALE_MS: bad });
      expect(s.code).toBe(1);
      expect(s.stderr).toContain("positive integer");
    }
  });

  test("concurrent waiters on a stale lock: both writes land, neither steals the other", async () => {
    const file = freshFile();
    run(file, "init");
    const lock = `${file}.lock`;
    writeFileSync(lock, `${deadPid()}\n`);
    const past = new Date(Date.now() - 60_000);
    utimesSync(lock, past, past);

    const procs = Array.from({ length: 2 }, (_, i) =>
      Bun.spawn(["bun", SCRIPT, file, "flag", `builder-${i}`, "after stale break"], {
        stdout: "pipe",
        stderr: "pipe",
        env: childEnv(),
      }),
    );
    await Promise.all(procs.map((proc) => proc.exited));
    for (const proc of procs) {
      expect(proc.exitCode).toBe(0);
    }
    const ledger = JSON.parse(readFileSync(file, "utf-8"));
    expect(ledger.flags).toHaveLength(2);
    expect(existsSync(lock)).toBe(false);
  });
});
