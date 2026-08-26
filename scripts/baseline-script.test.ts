import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ROOT } from "./lib";

// Contract test for the baseline snapshot helper: pinned copies plus git
// diff --no-index must turn every landing-verification failure mode into a
// visible diff. The scenarios pin the exact regressions substring tokens
// could not see - a reflow must read as drift (not "content missing"), a
// resurrected deleted line must be caught, and a file vanishing from the
// tree must be a loud finding, never a silent pass.

const SCRIPT = join(ROOT, "skills", "orchestrator-mode", "scripts", "baseline.mts");

const fixtures: string[] = [];
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  readonly tree: string;
  readonly baseline: string;
  write(path: string, content: string): void;
}

function makeFixture(files: Record<string, string>): Fixture {
  const root = mkdtempSync(join(tmpdir(), "baseline-test-"));
  fixtures.push(root);
  const tree = join(root, "tree");
  const baseline = join(root, "baseline");
  mkdirSync(tree, { recursive: true });
  const write = (path: string, content: string) => {
    const full = join(tree, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  for (const [path, content] of Object.entries(files)) write(path, content);
  return { tree, baseline, write };
}

interface Summary {
  ok: boolean;
  action: string;
  error?: string;
  files: { path: string; status?: string; pinned?: boolean; reason?: string; detail?: string }[];
}

function runBaseline(args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync(["bun", SCRIPT, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString();
  return {
    code: result.exitCode,
    stdout,
    stderr: result.stderr.toString(),
    summary: (stdout.trim() === "" ? null : JSON.parse(stdout)) as Summary | null,
  };
}

function fileStatus(summary: Summary | null, path: string) {
  const entry = summary?.files.find((file) => file.path === path);
  expect(entry).toBeDefined();
  return entry as NonNullable<typeof entry>;
}

describe("baseline.mts pin/check", () => {
  test("pin then check on an untouched tree is clean", () => {
    const fx = makeFixture({
      "docs/a.md": "alpha beta\n",
      "b.txt": "unchanged\n",
    });
    const pin = runBaseline(["pin", fx.baseline, fx.tree, "docs/a.md", "b.txt"]);
    expect(pin.code).toBe(0);
    expect(pin.summary?.ok).toBe(true);
    expect(fileStatus(pin.summary, "docs/a.md").pinned).toBe(true);
    expect(fileStatus(pin.summary, "b.txt").pinned).toBe(true);
    expect(readFileSync(join(fx.baseline, "content", "docs", "a.md"), "utf-8")).toBe(
      "alpha beta\n",
    );

    const check = runBaseline(["check", fx.baseline, fx.tree]);
    expect(check.code).toBe(0);
    expect(check.summary?.ok).toBe(true);
    expect(fileStatus(check.summary, "docs/a.md").status).toBe("identical");
    expect(fileStatus(check.summary, "b.txt").status).toBe("identical");
  });

  test("an edited file is drifted, and the summary carries the diff", () => {
    const fx = makeFixture({ "docs/a.md": "alpha beta\n" });
    expect(runBaseline(["pin", fx.baseline, fx.tree, "docs/a.md"]).code).toBe(0);
    fx.write("docs/a.md", "alpha gamma\n");

    const check = runBaseline(["check", fx.baseline, fx.tree]);
    expect(check.code).toBe(1);
    expect(check.summary?.ok).toBe(false);
    const entry = fileStatus(check.summary, "docs/a.md");
    expect(entry.status).toBe("drifted");
    expect(entry.detail).toContain("-alpha beta");
    expect(entry.detail).toContain("+alpha gamma");
    expect(check.stderr).toContain("+alpha gamma");
  });

  test("a reflow (same words re-wrapped) is a drift diff, not missing content", () => {
    const fx = makeFixture({
      "note.md": "the quick brown fox jumps over the lazy dog\n",
    });
    expect(runBaseline(["pin", fx.baseline, fx.tree, "note.md"]).code).toBe(0);
    fx.write("note.md", "the quick brown fox\njumps over the lazy dog\n");

    const check = runBaseline(["check", fx.baseline, fx.tree]);
    expect(check.code).toBe(1);
    const entry = fileStatus(check.summary, "note.md");
    expect(entry.status).toBe("drifted");
    // The diff must show both shapes of the same sentence; a substring token
    // for the full sentence would instead have read 0 hits ("lost sentence").
    expect(entry.detail).toContain("-the quick brown fox jumps over the lazy dog");
    expect(entry.detail).toContain("+the quick brown fox");
    expect(entry.detail).toContain("+jumps over the lazy dog");
    expect(entry.status).not.toBe("missing-in-tree");
  });

  test("a deleted line resurrected by a bad merge shows up as +line drift", () => {
    const fx = makeFixture({ "policy.md": "keep one\nkeep two\n" });
    expect(runBaseline(["pin", fx.baseline, fx.tree, "policy.md"]).code).toBe(0);
    fx.write("policy.md", "keep one\nobsolete line resurrected\nkeep two\n");

    const check = runBaseline(["check", fx.baseline, fx.tree]);
    expect(check.code).toBe(1);
    const entry = fileStatus(check.summary, "policy.md");
    expect(entry.status).toBe("drifted");
    // Presence checks pass here (all pinned lines still exist); only the
    // pinned-content diff makes the resurrected line visible.
    expect(entry.detail).toContain("+obsolete line resurrected");
  });

  test("a file deleted from the tree is a loud missing-in-tree finding", () => {
    const fx = makeFixture({ "docs/a.md": "alpha\n", "b.txt": "beta\n" });
    expect(runBaseline(["pin", fx.baseline, fx.tree, "docs/a.md", "b.txt"]).code).toBe(0);
    rmSync(join(fx.tree, "docs", "a.md"));

    const check = runBaseline(["check", fx.baseline, fx.tree]);
    expect(check.code).toBe(1);
    expect(check.summary?.ok).toBe(false);
    const entry = fileStatus(check.summary, "docs/a.md");
    expect(entry.status).toBe("missing-in-tree");
    expect(entry.detail).toContain("absent from the tree");
    expect(check.stderr).toContain("missing-in-tree: docs/a.md");
    expect(fileStatus(check.summary, "b.txt").status).toBe("identical");
  });

  test("a pinned copy deleted from the baseline is a missing-baseline finding", () => {
    const fx = makeFixture({ "docs/a.md": "alpha\n" });
    expect(runBaseline(["pin", fx.baseline, fx.tree, "docs/a.md"]).code).toBe(0);
    rmSync(join(fx.baseline, "content", "docs", "a.md"));

    const check = runBaseline(["check", fx.baseline, fx.tree]);
    expect(check.code).toBe(1);
    expect(fileStatus(check.summary, "docs/a.md").status).toBe("missing-baseline");
  });

  test("pin with a missing source pins nothing and says so per file", () => {
    const fx = makeFixture({ "docs/a.md": "alpha\n" });
    const pin = runBaseline(["pin", fx.baseline, fx.tree, "docs/a.md", "ghost.md"]);
    expect(pin.code).toBe(1);
    expect(pin.summary?.ok).toBe(false);
    expect(pin.summary?.error).toContain("ghost.md");
    const ghost = fileStatus(pin.summary, "ghost.md");
    expect(ghost.pinned).toBe(false);
    expect(ghost.reason).toContain("source missing");
    const present = fileStatus(pin.summary, "docs/a.md");
    expect(present.pinned).toBe(false);
    expect(present.reason).toContain("another source file is missing");
    // Transactional: no manifest and no partial copies were left behind.
    expect(existsSync(join(fx.baseline, "manifest.json"))).toBe(false);
    expect(existsSync(join(fx.baseline, "content", "docs", "a.md"))).toBe(false);
    expect(pin.stderr).toContain("not pinned: docs/a.md");
    expect(pin.stderr).toContain("not pinned: ghost.md");
  });

  test("check without a manifest fails loudly instead of passing empty", () => {
    const fx = makeFixture({ "docs/a.md": "alpha\n" });
    const check = runBaseline(["check", fx.baseline, fx.tree]);
    expect(check.code).toBe(1);
    expect(check.summary?.ok).toBe(false);
    expect(check.summary?.error).toContain("no manifest");
  });

  test("a tree file literally named manifest.json round-trips clean", () => {
    const fx = makeFixture({ "manifest.json": '{"app": true}\n', "docs/a.md": "alpha\n" });
    const pin = runBaseline(["pin", fx.baseline, fx.tree, "manifest.json", "docs/a.md"]);
    expect(pin.code).toBe(0);

    const check = runBaseline(["check", fx.baseline, fx.tree]);
    expect(check.code).toBe(0);
    expect(fileStatus(check.summary, "manifest.json").status).toBe("identical");
  });

  test("a corrupt manifest (null root) fails as JSON, not a crash", () => {
    const fx = makeFixture({ "docs/a.md": "alpha\n" });
    mkdirSync(fx.baseline, { recursive: true });
    writeFileSync(join(fx.baseline, "manifest.json"), "null\n");

    const check = runBaseline(["check", fx.baseline, fx.tree]);
    expect(check.code).toBe(1);
    expect(check.summary?.ok).toBe(false);
    expect(check.summary?.error).toContain("root must be an object");
  });

  test("a manifest entry with path traversal is a check failure, not usage", () => {
    const fx = makeFixture({ "docs/a.md": "alpha\n" });
    mkdirSync(fx.baseline, { recursive: true });
    writeFileSync(join(fx.baseline, "manifest.json"), '{"files": ["../outside.md"]}\n');

    const check = runBaseline(["check", fx.baseline, fx.tree]);
    expect(check.code).toBe(1);
    expect(check.summary?.ok).toBe(false);
    expect(check.summary?.error).toContain("path traversal");
  });

  test.skipIf(process.getuid?.() === 0)(
    "a copy failure mid-pin leaves the previous baseline untouched",
    () => {
      const fx = makeFixture({ "docs/a.md": "alpha\n", "locked.md": "secret\n" });
      expect(runBaseline(["pin", fx.baseline, fx.tree, "docs/a.md"]).code).toBe(0);

      // Unreadable source passes the exists pre-check but fails the copy.
      chmodSync(join(fx.tree, "locked.md"), 0o000);
      const pin = runBaseline(["pin", fx.baseline, fx.tree, "docs/a.md", "locked.md"]);
      expect(pin.code).toBe(1);
      expect(pin.summary?.ok).toBe(false);
      expect(pin.summary?.error).toContain("staging failed");
      expect(fileStatus(pin.summary, "docs/a.md").pinned).toBe(false);
      expect(fileStatus(pin.summary, "locked.md").pinned).toBe(false);

      // The first pin still checks clean: nothing was half-replaced.
      const check = runBaseline(["check", fx.baseline, fx.tree]);
      expect(check.code).toBe(0);
      expect(fileStatus(check.summary, "docs/a.md").status).toBe("identical");
    },
  );

  test("pin refuses a tree-root inside the baseline-dir before mutating", () => {
    const fx = makeFixture({ "docs/a.md": "alpha\n" });
    // tree inside baseline: installing the new baseline would delete the tree.
    const inside = runBaseline(["pin", dirname(fx.tree), fx.tree, "docs/a.md"]);
    expect(inside.code).toBe(2);
    expect(inside.stderr).toContain("must not be inside");
    const same = runBaseline(["pin", fx.tree, fx.tree, "docs/a.md"]);
    expect(same.code).toBe(2);
    // The source tree is untouched.
    expect(readFileSync(join(fx.tree, "docs", "a.md"), "utf-8")).toBe("alpha\n");
  });

  test("a case-variant baseline-dir cannot delete the tree", () => {
    const fx = makeFixture({ "docs/a.md": "alpha\n" });
    // On a case-insensitive filesystem (macOS) this aliases the tree itself
    // and must be refused (exit 2); on a case-sensitive one it is simply a
    // distinct directory and pin succeeds. Either way the tree survives.
    const caseFlipped = join(dirname(fx.tree), "TREE");
    const pin = runBaseline(["pin", caseFlipped, fx.tree, "docs/a.md"]);
    expect([0, 2]).toContain(pin.code);
    expect(readFileSync(join(fx.tree, "docs", "a.md"), "utf-8")).toBe("alpha\n");
    if (pin.code === 2) expect(pin.stderr).toContain("must not be inside");
  });

  test("an empty manifest file list is a check failure, never a vacuous pass", () => {
    const fx = makeFixture({ "docs/a.md": "alpha\n" });
    mkdirSync(fx.baseline, { recursive: true });
    writeFileSync(join(fx.baseline, "manifest.json"), '{"files": []}\n');

    const check = runBaseline(["check", fx.baseline, fx.tree]);
    expect(check.code).toBe(1);
    expect(check.summary?.ok).toBe(false);
    expect(check.summary?.error).toContain('"files" is empty');
  });

  test("a symlinked tree file is checked by content: clean, then drift on retarget", () => {
    const fx = makeFixture({ "AGENTS.md": "the real guidance\n", "other.md": "different words\n" });
    symlinkSync("AGENTS.md", join(fx.tree, "CLAUDE.md"));
    expect(runBaseline(["pin", fx.baseline, fx.tree, "CLAUDE.md"]).code).toBe(0);

    // Unchanged symlink round-trips clean: pin stored the target's content,
    // so check must compare content too, not the link value (mode 120000).
    const clean = runBaseline(["check", fx.baseline, fx.tree]);
    expect(clean.code).toBe(0);
    expect(fileStatus(clean.summary, "CLAUDE.md").status).toBe("identical");

    rmSync(join(fx.tree, "CLAUDE.md"));
    symlinkSync("other.md", join(fx.tree, "CLAUDE.md"));
    const drifted = runBaseline(["check", fx.baseline, fx.tree]);
    expect(drifted.code).toBe(1);
    const entry = fileStatus(drifted.summary, "CLAUDE.md");
    expect(entry.status).toBe("drifted");
    expect(entry.detail).toContain("-the real guidance");
    expect(entry.detail).toContain("+different words");
  });

  test("an inherited GIT_EXTERNAL_DIFF cannot corrupt the verdict", () => {
    const fx = makeFixture({ "docs/a.md": "alpha beta\n" });
    expect(runBaseline(["pin", fx.baseline, fx.tree, "docs/a.md"]).code).toBe(0);
    fx.write("docs/a.md", "alpha gamma\n");

    // /usr/bin/true as an external diff driver would swallow the comparison
    // and report the drifted file as identical; the scrubbed git env must
    // ignore it and still produce the real diff.
    const check = runBaseline(["check", fx.baseline, fx.tree], {
      GIT_EXTERNAL_DIFF: "/usr/bin/true",
    });
    expect(check.code).toBe(1);
    const entry = fileStatus(check.summary, "docs/a.md");
    expect(entry.status).toBe("drifted");
    expect(entry.detail).toContain("+alpha gamma");
  });

  test("bad usage exits 2 and still emits an ok:false JSON summary", () => {
    const empty = runBaseline([]);
    expect(empty.code).toBe(2);
    expect(empty.summary?.ok).toBe(false);
    const shortArgs = runBaseline(["pin", "only-one-arg"]);
    expect(shortArgs.code).toBe(2);
    expect(shortArgs.summary?.ok).toBe(false);
    const unknown = runBaseline(["frobnicate", "a", "b"]);
    expect(unknown.code).toBe(2);
    expect(unknown.summary?.ok).toBe(false);
    const traversal = runBaseline(["pin", "/tmp/x", "/tmp/y", "../escape.md"]);
    expect(traversal.code).toBe(2);
    expect(traversal.summary?.ok).toBe(false);
    expect(traversal.stderr).toContain("path traversal");
  });
});
