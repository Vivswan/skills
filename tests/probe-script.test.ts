import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../scripts/lib";

// Contract tests for the orchestrator-mode probe tool: every result is
// either evidence-bearing or a loud error, never a bare number. The tests
// pin the failure modes the tool exists to make unrepresentable - a missing
// file reading as 0, a substring matching a longer sibling filename, a
// two-file swap hiding inside a stable count, and a negative token passing
// silently on a broken measurement.

const SCRIPT = join(ROOT, "skills", "orchestrator-mode", "scripts", "probe.mts");

interface Evidence {
  line: number;
  text: string;
  endLine?: number;
}

interface TokenResult {
  file: string;
  token: string;
  expected: ">=1" | number;
  actual: number | null;
  pass: boolean;
  evidence: Evidence[];
  error?: string;
}

interface KeyDiff {
  first: { file: string; keyCount: number };
  second: { file: string; keyCount: number };
  onlyInFirst: string[];
  onlyInSecond: string[];
}

interface ProbeOutput {
  ok: boolean;
  error?: string;
  failures?: number;
  value?: number | string[] | KeyDiff | TokenResult[];
  evidence?: Evidence[];
  sources?: { committed: string[]; dirty: string[] };
}

const fixtures = mkdtempSync(join(tmpdir(), "probe-test-"));
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

let fixtureId = 0;
function fixtureDir(): string {
  fixtureId += 1;
  const dir = join(fixtures, `f${fixtureId}`);
  mkdirSync(dir);
  return dir;
}

// The repo pre-commit hook runs this suite inside `git commit`, where git
// exports GIT_DIR/GIT_INDEX_FILE (pointed at the OUTER repo) into hook
// children. Inherited, they hijack every fixture git call to operate on the
// real repository - fixture commits land on the real branch and the real
// tree gets wiped. Build the env per spawn (the leak can appear at any
// time), strip all GIT_* vars, and pin config and identity so fixtures are
// hermetic under any user setup.
function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("GIT_")) {
      env[key] = value;
    }
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  env.GIT_AUTHOR_NAME = "fixture";
  env.GIT_AUTHOR_EMAIL = "fixture@example.com";
  env.GIT_COMMITTER_NAME = "fixture";
  env.GIT_COMMITTER_EMAIL = "fixture@example.com";
  return env;
}

function probeWithEnv(
  env: Record<string, string>,
  args: string[],
): { code: number | null; out: ProbeOutput; stderr: string } {
  const result = Bun.spawnSync(["bun", SCRIPT, ...args], {
    env: { ...cleanEnv(), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  let out: ProbeOutput;
  try {
    out = JSON.parse(stdout);
  } catch {
    throw new Error(`probe ${args.join(" ")} emitted non-JSON stdout: ${stdout}`);
  }
  return { code: result.exitCode, out, stderr: result.stderr.toString() };
}

function probe(...args: string[]): { code: number | null; out: ProbeOutput; stderr: string } {
  return probeWithEnv({}, args);
}

function sh(cwd: string, ...cmd: string[]): string {
  const result = Bun.spawnSync(cmd, { cwd, env: cleanEnv(), stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

function initRepo(dir: string): void {
  sh(dir, "git", "init", "-q", "-b", "main");
  sh(dir, "git", "config", "user.email", "probe-test@example.com");
  sh(dir, "git", "config", "user.name", "Probe Test");
  sh(dir, "git", "config", "commit.gpgsign", "false");
}

describe("fixture hygiene", () => {
  // The class regression for the hook-leak disaster: GIT_DIR/GIT_INDEX_FILE/
  // GIT_WORK_TREE set in the PARENT env (as a pre-commit hook does, aimed at
  // an outer repo) must not leak into fixture git calls - the fixture must
  // commit to itself and the outer repo must be untouched.
  test("hook-leaked GIT_* vars cannot hijack fixture git calls", () => {
    const outer = fixtureDir();
    initRepo(outer);
    writeFileSync(join(outer, "keep.txt"), "outer\n");
    sh(outer, "git", "add", "keep.txt");
    sh(outer, "git", "commit", "-q", "-m", "outer base");
    const outerHead = sh(outer, "git", "rev-parse", "HEAD").trim();
    const leak: Record<string, string> = {
      GIT_DIR: join(outer, ".git"),
      GIT_INDEX_FILE: join(outer, ".git", "index"),
      GIT_WORK_TREE: outer,
    };
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(leak)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      const inner = fixtureDir();
      initRepo(inner);
      writeFileSync(join(inner, "inner.txt"), "inner\n");
      sh(inner, "git", "add", "inner.txt");
      sh(inner, "git", "commit", "-q", "-m", "inner base");
      expect(sh(inner, "git", "ls-files").trim()).toBe("inner.txt");
      const measured = probe("set", inner, sh(inner, "git", "rev-parse", "HEAD").trim());
      expect(measured.code).toBe(0);
      expect(measured.out.value).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
    expect(sh(outer, "git", "rev-parse", "HEAD").trim()).toBe(outerHead);
    expect(sh(outer, "git", "status", "--porcelain").trim()).toBe("");
    expect(sh(outer, "git", "log", "--format=%s").trim()).toBe("outer base");
  });
});

describe("probe count", () => {
  test("missing file is a loud error and exit 1, never value 0", () => {
    const { code, out } = probe("count", join(fixtures, "does-not-exist.txt"), "anything");
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("no such file");
    expect(out.value).toBeUndefined();
  });

  test("a broken path (symlink loop) is not reported as a missing file", () => {
    const dir = fixtureDir();
    const loop = join(dir, "loop.txt");
    symlinkSync(loop, loop);
    const { code, out } = probe("count", loop, "anything");
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    // A loop is a broken measurement, not an absent file; the errno must
    // survive so the two states stay distinguishable.
    expect(out.error).toContain("ELOOP");
    expect(out.error).not.toContain("no such file");
    expect(out.value).toBeUndefined();
  });

  test("release.yml does not match update-release.yml (exact-file semantics)", () => {
    const dir = fixtureDir();
    const file = join(dir, "workflows.txt");
    writeFileSync(file, "  - update-release.yml\n  - release.yml\n  - deploy.yml\n");
    const { code, out } = probe("count", file, "release.yml");
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.value).toBe(1);
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence?.[0]).toEqual({ line: 2, text: "  - release.yml" });
    const longer = probe("count", file, "update-release.yml");
    expect(longer.out.value).toBe(1);
    expect(longer.out.evidence?.[0]?.line).toBe(1);
  });

  test("value always equals the number of evidence lines", () => {
    const dir = fixtureDir();
    const file = join(dir, "notes.txt");
    writeFileSync(file, "alpha token here\nnothing\ntoken again\n");
    const { code, out } = probe("count", file, "token");
    expect(code).toBe(0);
    expect(out.value).toBe(2);
    expect(out.evidence?.map((e) => e.line)).toEqual([1, 3]);
  });
});

describe("probe json-keys", () => {
  test("bad JSON is a loud parse error, not a key list", () => {
    const dir = fixtureDir();
    const file = join(dir, "broken.json");
    writeFileSync(file, '{"a": 1,,}\n');
    const { code, out } = probe("json-keys", file);
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("broken.json");
    expect(out.value).toBeUndefined();
  });

  test("valid JSON yields sorted full key paths", () => {
    const dir = fixtureDir();
    const file = join(dir, "strings.json");
    writeFileSync(file, '{"b": {"c": 1}, "a": [10, 20]}\n');
    const { code, out } = probe("json-keys", file);
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.value).toEqual(["a", "a[0]", "a[1]", "b", "b.c"]);
  });

  test("two files report the key-set diff and fail on mismatch", () => {
    const dir = fixtureDir();
    const first = join(dir, "en.json");
    const second = join(dir, "de.json");
    writeFileSync(first, '{"shared": 1, "onlyEn": 2}\n');
    writeFileSync(second, '{"shared": 1, "onlyDe": 3}\n');
    const { code, out } = probe("json-keys", first, second);
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    const diff = out.value as KeyDiff;
    expect(diff.onlyInFirst).toEqual(["onlyEn"]);
    expect(diff.onlyInSecond).toEqual(["onlyDe"]);
    const same = probe("json-keys", first, first);
    expect(same.code).toBe(0);
    expect(same.out.ok).toBe(true);
  });

  test("keys that are not valid JS identifiers are bracket-quoted", () => {
    const dir = fixtureDir();
    const file = join(dir, "idents.json");
    // "1st" and "foo-bar" parse fine as JSON keys but are not JS
    // identifiers; rendered bare they would break pasted accessor chains.
    writeFileSync(file, '{"plain_Key$": 1, "1st": 2, "foo-bar": {"ok": 3}}\n');
    const { code, out } = probe("json-keys", file);
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.value).toEqual(['["1st"]', '["foo-bar"]', '["foo-bar"].ok', "plain_Key$"]);
  });

  test("a key literally named a[0] cannot collide with a real array index", () => {
    const dir = fixtureDir();
    const arrayFile = join(dir, "array.json");
    const trickFile = join(dir, "trick.json");
    writeFileSync(arrayFile, '{"a": [0]}\n');
    writeFileSync(trickFile, '{"a": 0, "a[0]": 0}\n');
    const { code, out } = probe("json-keys", arrayFile, trickFile);
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
  });
});

describe("probe set", () => {
  test("catches a two-file swap that leaves the file count at 14", () => {
    const dir = fixtureDir();
    initRepo(dir);
    const names = "abcdefghijklmn".split("");
    for (const name of names) {
      writeFileSync(join(dir, `${name}.txt`), `${name}\n`);
    }
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-q", "-m", "base: 14 files");
    const base = sh(dir, "git", "rev-parse", "HEAD").trim();
    rmSync(join(dir, "b.txt"));
    writeFileSync(join(dir, "o.txt"), "o\n");
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-q", "-m", "swap b for o");
    // The count probe is blind here: still exactly 14 files in the tree.
    expect(sh(dir, "git", "ls-files").trim().split("\n")).toHaveLength(14);
    const { code, out } = probe("set", dir, base);
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.value).toEqual(["b.txt", "o.txt"]);
  });

  test("unions committed and dirty/untracked paths", () => {
    const dir = fixtureDir();
    initRepo(dir);
    writeFileSync(join(dir, "committed.txt"), "v1\n");
    writeFileSync(join(dir, "dirty.txt"), "v1\n");
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-q", "-m", "base");
    const base = sh(dir, "git", "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "committed.txt"), "v2\n");
    sh(dir, "git", "add", "committed.txt");
    sh(dir, "git", "commit", "-q", "-m", "change committed.txt");
    writeFileSync(join(dir, "dirty.txt"), "v2\n");
    writeFileSync(join(dir, "untracked.txt"), "new\n");
    const { code, out } = probe("set", dir, base);
    expect(code).toBe(0);
    expect(out.value).toEqual(["committed.txt", "dirty.txt", "untracked.txt"]);
    expect(out.sources?.committed).toEqual(["committed.txt"]);
    expect(out.sources?.dirty).toEqual(["dirty.txt", "untracked.txt"]);
  });

  test("a staged rename yields both paths and corrupts nothing after it", () => {
    const dir = fixtureDir();
    initRepo(dir);
    writeFileSync(join(dir, "old-name.txt"), "stable content for rename detection\n");
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-q", "-m", "base");
    const base = sh(dir, "git", "rev-parse", "HEAD").trim();
    sh(dir, "git", "mv", "old-name.txt", "new-name.txt");
    writeFileSync(join(dir, "untracked.txt"), "after the rename record\n");
    const { code, out } = probe("set", dir, base);
    expect(code).toBe(0);
    // Both rename endpoints must survive: losing the origin path would hide
    // the disappearance of old-name.txt from any check reading the set.
    expect(out.value).toEqual(["new-name.txt", "old-name.txt", "untracked.txt"]);
  });

  test("nested untracked files are listed individually, never as dir/", () => {
    const dir = fixtureDir();
    initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "a\n");
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-q", "-m", "base");
    const base = sh(dir, "git", "rev-parse", "HEAD").trim();
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "sub", "inner.txt"), "nested untracked\n");
    const { code, out } = probe("set", dir, base);
    expect(code).toBe(0);
    expect(out.value).toEqual(["sub/inner.txt"]);
  });

  test("a commit landing mid-measurement is a loud error, not a silent gap", () => {
    const dir = fixtureDir();
    initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "a\n");
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-q", "-m", "base");
    const base = sh(dir, "git", "rev-parse", "HEAD").trim();
    // A fake git on PATH answers the second `rev-parse HEAD` with a moved
    // sha, simulating a worker committing between the diff and the status.
    const realGit = Bun.which("git");
    if (!realGit) {
      throw new Error("git not found on PATH");
    }
    const shimDir = join(dir, "shim");
    mkdirSync(shimDir);
    const counter = join(shimDir, "rev-parse-count");
    writeFileSync(
      join(shimDir, "git"),
      [
        "#!/usr/bin/env bash",
        'if [ "$3" = "rev-parse" ] && [ "$4" = "HEAD" ]; then',
        '  n=0; [ -f "$PROBE_RP_COUNTER" ] && n="$(cat "$PROBE_RP_COUNTER")"',
        '  n=$((n + 1)); printf "%s" "$n" > "$PROBE_RP_COUNTER"',
        '  if [ "$n" -ge 2 ]; then',
        '    echo "dddddddddddddddddddddddddddddddddddddddd"; exit 0',
        "  fi",
        "fi",
        'exec "$PROBE_REAL_GIT" "$@"',
        "",
      ].join("\n"),
    );
    chmodSync(join(shimDir, "git"), 0o755);
    const { code, out } = probeWithEnv(
      {
        PATH: `${shimDir}:${process.env.PATH}`,
        PROBE_REAL_GIT: realGit,
        PROBE_RP_COUNTER: counter,
      },
      ["set", dir, base],
    );
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("HEAD moved during measurement");
    expect(out.value).toBeUndefined();
  });

  test("a committed rename keeps both endpoints in the set", () => {
    const dir = fixtureDir();
    initRepo(dir);
    writeFileSync(join(dir, "src.txt"), "stable content for rename detection\n");
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-q", "-m", "base");
    const base = sh(dir, "git", "rev-parse", "HEAD").trim();
    sh(dir, "git", "mv", "src.txt", "dst.txt");
    sh(dir, "git", "commit", "-q", "-m", "rename src to dst");
    const { code, out } = probe("set", dir, base);
    expect(code).toBe(0);
    // Rename detection would collapse this to the destination only; the
    // origin path vanishing would hide the deletion from a forbidden-path
    // or coverage check reading the set.
    expect(out.value).toEqual(["dst.txt", "src.txt"]);
  });

  test("nonexistent repo root is a loud error", () => {
    const { code, out } = probe("set", join(fixtures, "no-such-repo"), "HEAD");
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("no such directory");
  });

  test("leaked repo-local GIT_* env vars cannot redirect the measurement", () => {
    const dir = fixtureDir();
    initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "v1\n");
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-q", "-m", "base");
    const base = sh(dir, "git", "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "a.txt"), "v2\n");
    // Inside a git hook these leak into children and would point the probe's
    // git at the calling repo (or nowhere) instead of <repo-root>.
    const { code, out } = probeWithEnv(
      {
        GIT_COMMON_DIR: "/bogus/common",
        GIT_DIR: "/bogus/gitdir",
        GIT_INDEX_FILE: "/bogus/index",
        GIT_INTERNAL_SUPER_PREFIX: "bogus/prefix/",
        GIT_WORK_TREE: "/bogus/worktree",
      },
      ["set", dir, base],
    );
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.value).toEqual(["a.txt"]);
  });

  test("a bad base ref is a loud error, never an empty set", () => {
    const dir = fixtureDir();
    initRepo(dir);
    writeFileSync(join(dir, "a.txt"), "a\n");
    sh(dir, "git", "add", "-A");
    sh(dir, "git", "commit", "-q", "-m", "base");
    const { code, out } = probe("set", dir, "no-such-ref");
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("git diff");
    expect(out.value).toBeUndefined();
  });
});

describe("probe tokens", () => {
  test("presence passes with evidence, resurrection fails a negative token", () => {
    const dir = fixtureDir();
    const tree = join(dir, "tree");
    mkdirSync(tree);
    writeFileSync(
      join(tree, "doc.md"),
      "The kept sentence is here.\nThe deleted sentence came back.\n",
    );
    const table = join(dir, "table.json");
    writeFileSync(
      table,
      JSON.stringify({
        "doc.md": [
          { "text": "The kept sentence is here", "expect": ">=1" },
          { "text": "The deleted sentence came back", "expect": 0 },
        ],
      }),
    );
    const { code, out } = probe("tokens", table, tree);
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.failures).toBe(1);
    const [kept, resurrected] = out.value as TokenResult[];
    expect(kept?.pass).toBe(true);
    expect(kept?.actual).toBe(1);
    expect(kept?.evidence[0]?.text).toContain("kept sentence");
    expect(resurrected?.pass).toBe(false);
    expect(resurrected?.expected).toBe(0);
    expect(resurrected?.actual).toBe(1);
    expect(resurrected?.evidence[0]?.text).toContain("deleted sentence came back");
  });

  test("a missing file fails ALL its tokens loudly, including negatives", () => {
    const dir = fixtureDir();
    const tree = join(dir, "tree");
    mkdirSync(tree);
    const table = join(dir, "table.json");
    writeFileSync(
      table,
      JSON.stringify({
        "ghost.md": [
          { "text": "must be present", "expect": ">=1" },
          { "text": "must be absent", "expect": 0 },
        ],
      }),
    );
    const { code, out } = probe("tokens", table, tree);
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.failures).toBe(2);
    const results = out.value as TokenResult[];
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.pass).toBe(false);
      expect(result.actual).toBeNull();
      expect(result.error).toContain("no such file");
    }
  });

  test("an all-green table exits 0 with per-token evidence", () => {
    const dir = fixtureDir();
    const tree = join(dir, "tree");
    mkdirSync(tree);
    writeFileSync(join(tree, "doc.md"), "one marker\ntwo marker\n");
    const table = join(dir, "table.json");
    writeFileSync(
      table,
      JSON.stringify({
        "doc.md": [
          { "text": "marker", "expect": 2 },
          { "text": "one marker", "expect": ">=1" },
          { "text": "never present", "expect": 0 },
        ],
      }),
    );
    const { code, out } = probe("tokens", table, tree);
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.failures).toBe(0);
    const results = out.value as TokenResult[];
    expect(results[0]?.actual).toBe(2);
    expect(results[0]?.evidence).toHaveLength(2);
    expect(results[2]?.actual).toBe(0);
    expect(results[2]?.evidence).toEqual([]);
  });

  test("a malformed table is a loud error, not a 0-token pass", () => {
    const dir = fixtureDir();
    const table = join(dir, "table.json");
    writeFileSync(table, JSON.stringify({ "doc.md": [{ "text": "x", "expect": ">=2" }] }));
    const { code, out } = probe("tokens", table, dir);
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('"expect"');
  });

  test("an empty table cannot pass", () => {
    const dir = fixtureDir();
    const table = join(dir, "table.json");
    writeFileSync(table, "{}");
    const { code, out } = probe("tokens", table, dir);
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("empty");
    const noTokens = join(dir, "no-tokens.json");
    writeFileSync(noTokens, JSON.stringify({ "doc.md": [] }));
    const empty = probe("tokens", noTokens, dir);
    expect(empty.code).toBe(1);
    expect(empty.out.ok).toBe(false);
  });

  test("a table entry escaping the tree root is rejected", () => {
    const dir = fixtureDir();
    const tree = join(dir, "tree");
    mkdirSync(tree);
    writeFileSync(join(dir, "outside.md"), "escaped content\n");
    const table = join(dir, "table.json");
    writeFileSync(
      table,
      JSON.stringify({ "../outside.md": [{ "text": "escaped content", "expect": ">=1" }] }),
    );
    const { code, out } = probe("tokens", table, tree);
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("relative path inside the tree root");
  });

  test("a symlink resolving outside the tree root is a loud error, not a reading", () => {
    const dir = fixtureDir();
    const tree = join(dir, "tree");
    mkdirSync(tree);
    writeFileSync(join(dir, "outside.md"), "escaped content\n");
    // Lexically clean entry, but the symlink resolves outside the tree.
    symlinkSync(join(dir, "outside.md"), join(tree, "link.md"));
    const table = join(dir, "table.json");
    writeFileSync(
      table,
      JSON.stringify({ "link.md": [{ "text": "escaped content", "expect": ">=1" }] }),
    );
    const { code, out } = probe("tokens", table, tree);
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("resolves outside tree root");
    expect(out.value).toBeUndefined();
  });

  test("a symlink staying inside the tree root is still measured", () => {
    const dir = fixtureDir();
    const tree = join(dir, "tree");
    mkdirSync(tree);
    writeFileSync(join(tree, "real.md"), "inside content\n");
    symlinkSync(join(tree, "real.md"), join(tree, "alias.md"));
    const table = join(dir, "table.json");
    writeFileSync(
      table,
      JSON.stringify({ "alias.md": [{ "text": "inside content", "expect": ">=1" }] }),
    );
    const { code, out } = probe("tokens", table, tree);
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
  });

  test("containment still accepts descendants when the tree root is /", () => {
    const dir = fixtureDir();
    writeFileSync(join(dir, "doc.md"), "root containment content\n");
    const table = join(dir, "table.json");
    // The entry is the fixture file's path relative to the filesystem root;
    // with a naive rootReal + sep prefix ("//") every descendant of "/" is
    // rejected as outside the tree.
    const entry = join(dir, "doc.md").replace(/^\/+/, "");
    writeFileSync(
      table,
      JSON.stringify({ [entry]: [{ "text": "root containment content", "expect": ">=1" }] }),
    );
    const { code, out } = probe("tokens", table, "/");
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
  });

  test("a FIFO at a probed path fails loudly instead of blocking forever", () => {
    const dir = fixtureDir();
    const tree = join(dir, "tree");
    mkdirSync(tree);
    sh(dir, "mkfifo", join(tree, "pipe.md"));
    const table = join(dir, "table.json");
    writeFileSync(table, JSON.stringify({ "pipe.md": [{ "text": "anything", "expect": ">=1" }] }));
    // A plain readFileSync would hang here with no writer on the FIFO; the
    // probe must classify and refuse it instead. The same fd-based read
    // backs count and json-keys, so cover that entry point too.
    const viaTokens = probe("tokens", table, tree);
    expect(viaTokens.code).toBe(1);
    expect(viaTokens.out.ok).toBe(false);
    expect(viaTokens.out.error).toContain("pipe.md: not a regular file");
    const viaCount = probe("count", join(tree, "pipe.md"), "anything");
    expect(viaCount.code).toBe(1);
    expect(viaCount.out.ok).toBe(false);
    expect(viaCount.out.error).toContain("not a regular file");
    expect(viaCount.out.value).toBeUndefined();
  });
});

describe("probe usage", () => {
  test("missing or unknown subcommand exits 2 with usage", () => {
    const none = probe();
    expect(none.code).toBe(2);
    expect(none.out.ok).toBe(false);
    expect(none.out.error).toContain("usage:");
    const unknown = probe("frobnicate");
    expect(unknown.code).toBe(2);
  });
});

describe("reflow safety", () => {
  // The class regression: a reflow commit rewraps a markdown paragraph and
  // splits a long token across a line boundary. A per-line matcher then
  // reads a false 0, indistinguishable from the sentence being genuinely
  // deleted. Whitespace-normalized matching makes a pure reflow (which only
  // changes whitespace) unable to change any count.
  const sentence = "the retired doctrine split long tokens across rewrapped lines";
  const flat = `# Doc\n\nSome intro prose. ${sentence}. Trailing prose stays put.\n`;
  const rewrapped = [
    "# Doc",
    "",
    "Some intro prose. the retired doctrine split long",
    "tokens across rewrapped lines. Trailing prose stays put.",
    "",
  ].join("\n");

  test("a token split across a line boundary by rewrapping still counts 1", () => {
    const dir = fixtureDir();
    const before = join(dir, "before.md");
    const after = join(dir, "after.md");
    writeFileSync(before, flat);
    writeFileSync(after, rewrapped);
    const unwrapped = probe("count", before, sentence);
    expect(unwrapped.code).toBe(0);
    expect(unwrapped.out.value).toBe(1);
    expect(unwrapped.out.evidence?.[0]?.line).toBe(3);
    expect(unwrapped.out.evidence?.[0]?.endLine).toBeUndefined();
    const wrapped = probe("count", after, sentence);
    expect(wrapped.code).toBe(0);
    expect(wrapped.out.value).toBe(1);
    // Evidence points at the ORIGINAL first line of the span and notes the
    // wrap via endLine.
    expect(wrapped.out.evidence?.[0]?.line).toBe(3);
    expect(wrapped.out.evidence?.[0]?.text).toBe(
      "Some intro prose. the retired doctrine split long",
    );
    expect(wrapped.out.evidence?.[0]?.endLine).toBe(4);
  });

  test("whitespace differences inside the literal cannot change the count", () => {
    const dir = fixtureDir();
    const file = join(dir, "doc.md");
    writeFileSync(file, "alpha  beta\tgamma\n");
    const { code, out } = probe("count", file, "alpha beta gamma");
    expect(code).toBe(0);
    expect(out.value).toBe(1);
    expect(out.evidence?.[0]).toEqual({ line: 1, text: "alpha  beta\tgamma" });
  });

  test("counting is per occurrence, not per line: reflow cannot merge counts", () => {
    const dir = fixtureDir();
    const merged = join(dir, "merged.md");
    const split = join(dir, "split.md");
    // The same two occurrences, once on one line and once on two: per-line
    // counting would read 1 vs 2 and a reflow joining the lines would look
    // like a deletion. Occurrence counting reads 2 for both.
    writeFileSync(merged, "the marker and the marker again\n");
    writeFileSync(split, "the marker and\nthe marker again\n");
    const one = probe("count", merged, "marker");
    expect(one.out.value).toBe(2);
    expect(one.out.evidence?.map((e) => e.line)).toEqual([1, 1]);
    const two = probe("count", split, "marker");
    expect(two.out.value).toBe(2);
    expect(two.out.evidence?.map((e) => e.line)).toEqual([1, 2]);
  });

  test("literal edge whitespace is boundary noise: file edges still match", () => {
    const dir = fixtureDir();
    const file = join(dir, "doc.md");
    // "beta " must match even though the file ends "beta\n" (the trailing
    // newline IS whitespace), and " alpha" must match at the very start of
    // the file. Asymmetric edge handling here would let an expect:0 token
    // silently pass on content that is really present.
    writeFileSync(file, "alpha beta\n");
    const trailing = probe("count", file, "beta ");
    expect(trailing.code).toBe(0);
    expect(trailing.out.value).toBe(1);
    const leading = probe("count", file, " alpha");
    expect(leading.code).toBe(0);
    expect(leading.out.value).toBe(1);
  });

  test("a whitespace-only literal is a loud error, never a count", () => {
    const dir = fixtureDir();
    const file = join(dir, "doc.md");
    writeFileSync(file, "some content\n");
    const { code, out } = probe("count", file, " \t ");
    expect(code).toBe(2);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("non-whitespace");
    const table = join(dir, "table.json");
    writeFileSync(table, JSON.stringify({ "doc.md": [{ "text": "  ", "expect": ">=1" }] }));
    const viaTokens = probe("tokens", table, dir);
    expect(viaTokens.code).toBe(1);
    expect(viaTokens.out.ok).toBe(false);
    expect(viaTokens.out.error).toContain("non-whitespace");
  });

  test("lone CR, CRLF, and U+2028 breaks keep evidence line numbers honest", () => {
    const dir = fixtureDir();
    const file = join(dir, "doc.md");
    // Line 1 ends with lone CR, line 2 with CRLF, line 3 with U+2028; the
    // token spans lines 2-3. Counting only \n would misreport the span.
    writeFileSync(file, "first line\rsecond alpha\r\nbeta third\u2028fourth line\n");
    const { code, out } = probe("count", file, "alpha beta");
    expect(code).toBe(0);
    expect(out.value).toBe(1);
    expect(out.evidence?.[0]?.line).toBe(2);
    expect(out.evidence?.[0]?.text).toBe("second alpha");
    expect(out.evidence?.[0]?.endLine).toBe(3);
  });

  test("release.yml still cannot match update-release.yml after normalization", () => {
    const dir = fixtureDir();
    const file = join(dir, "workflows.md");
    writeFileSync(file, "The gate keeps update-release.yml wired\ninto the pipeline.\n");
    const { code, out } = probe("count", file, "release.yml");
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.value).toBe(0);
    expect(out.evidence).toEqual([]);
  });

  test("a genuinely deleted sentence still reads 0 on the reflowed file", () => {
    const dir = fixtureDir();
    const file = join(dir, "after.md");
    writeFileSync(file, rewrapped);
    const { code, out } = probe("count", file, "this sentence was genuinely deleted");
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.value).toBe(0);
    expect(out.evidence).toEqual([]);
  });

  test("tokens tables survive a reflow: presence stays 1, absence stays 0", () => {
    const dir = fixtureDir();
    const tree = join(dir, "tree");
    mkdirSync(tree);
    writeFileSync(join(tree, "doc.md"), rewrapped);
    const table = join(dir, "table.json");
    writeFileSync(
      table,
      JSON.stringify({
        "doc.md": [
          { "text": sentence, "expect": 1 },
          { "text": "this sentence was genuinely deleted", "expect": 0 },
        ],
      }),
    );
    const { code, out } = probe("tokens", table, tree);
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.failures).toBe(0);
    const [kept, deleted] = out.value as TokenResult[];
    expect(kept?.actual).toBe(1);
    expect(kept?.evidence[0]?.line).toBe(3);
    expect(kept?.evidence[0]?.endLine).toBe(4);
    expect(deleted?.actual).toBe(0);
    expect(deleted?.evidence).toEqual([]);
  });
});
