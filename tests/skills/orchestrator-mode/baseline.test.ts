import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../../../scripts/lib.mts";
import { relativeStaysWithin } from "../../../skills/orchestrator-mode/scripts/baseline.mts";
import { tempDirs } from "../../helpers/temp-dirs";

const temp = tempDirs();

// Contract test for the baseline snapshot helper: pinned copies compared
// byte for byte and rendered as a unified diff must turn every
// landing-verification failure mode into a visible diff. The scenarios pin
// the exact regressions substring tokens could not see - a reflow must read
// as drift (not "content missing"), a resurrected deleted line must be
// caught, and a file vanishing from the tree must be a loud finding, never a
// silent pass.

const SCRIPT = join(ROOT, "skills", "orchestrator-mode", "scripts", "baseline.mts");

interface Fixture {
  readonly tree: string;
  readonly baseline: string;
  write(path: string, content: string | Uint8Array): void;
}

function makeFixture(files: Record<string, string>): Fixture {
  const root = temp.dir("baseline-test-");
  const tree = join(root, "tree");
  const baseline = join(root, "baseline");
  mkdirSync(tree, { recursive: true });
  const write = (path: string, content: string | Uint8Array) => {
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

function runBaseline(args: string[]) {
  const result = Bun.spawnSync(["bun", SCRIPT, ...args], {
    env: process.env,
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

describe("baseline.mts pure helpers", () => {
  test("relativeStaysWithin recognizes parent escapes with either separator", () => {
    expect(relativeStaysWithin("")).toBe(true);
    expect(relativeStaysWithin("sub/dir")).toBe(true);
    expect(relativeStaysWithin("..")).toBe(false);
    expect(relativeStaysWithin("../sibling")).toBe(false);
    expect(relativeStaysWithin("..\\sibling")).toBe(false); // Windows path.relative output
    expect(relativeStaysWithin("/elsewhere")).toBe(false);
  });
});

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

  test("an overlapping tree-root and baseline-dir is refused before mutating or comparing", () => {
    const fx = makeFixture({ "docs/a.md": "alpha\n" });
    expect(runBaseline(["pin", fx.baseline, fx.tree, "docs/a.md"]).code).toBe(0);
    fx.write("docs/a.md", "real drift the self-compare would hide\n");
    const link = join(dirname(fx.tree), "link");
    symlinkSync(fx.tree, link);
    const cases = [
      // Installing the new baseline would delete the tree being pinned.
      { id: "tree-inside-baseline", args: ["pin", dirname(fx.tree), fx.tree, "docs/a.md"] },
      { id: "same-dir", args: ["pin", fx.tree, fx.tree, "docs/a.md"] },
      // A symlink is the same directory under another name on every platform,
      // so only a canonicalized comparison can refuse it.
      { id: "symlink-alias", args: ["pin", link, fx.tree, "docs/a.md"] },
      // Checking the baseline's own content dir would compare every pinned
      // file with itself and report clean despite the drift written above.
      { id: "check-self-compare", args: ["check", fx.baseline, join(fx.baseline, "content")] },
    ];
    for (const c of cases) {
      const r = runBaseline(c.args);
      expect(r.code, c.id).toBe(2);
      expect(r.summary?.ok, c.id).toBe(false);
      expect(r.stderr, c.id).toContain("must not be inside");
    }
    // The source tree survived every attempt.
    expect(readFileSync(join(fx.tree, "docs", "a.md"), "utf-8")).toBe(
      "real drift the self-compare would hide\n",
    );
  });

  test("a case-variant baseline-dir cannot delete the tree", () => {
    const fx = makeFixture({ "docs/a.md": "alpha\n" });
    // Only a case-insensitive filesystem (macOS) makes the flipped-case path
    // alias the tree itself; elsewhere it is a distinct, not-yet-existing
    // sibling. Probe which world we are in so the exit code is pinned exactly.
    const caseFlipped = join(dirname(fx.tree), "TREE");
    const aliases = existsSync(caseFlipped);
    const pin = runBaseline(["pin", caseFlipped, fx.tree, "docs/a.md"]);
    expect(pin.code).toBe(aliases ? 2 : 0);
    expect(pin.summary?.ok).toBe(!aliases);
    if (aliases) expect(pin.stderr).toContain("must not be inside");
    expect(readFileSync(join(fx.tree, "docs", "a.md"), "utf-8")).toBe("alpha\n");
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

  test("a binary pair reports drift as 'binary files differ', never a text patch", () => {
    // git's rule: a NUL in the first 8000 bytes makes a file binary.
    const fx = makeFixture({});
    fx.write("logo.bin", Buffer.from([0x00, 0x01]));
    expect(runBaseline(["pin", fx.baseline, fx.tree, "logo.bin"]).code).toBe(0);
    fx.write("logo.bin", Buffer.from([0x00, 0x02]));

    const check = runBaseline(["check", fx.baseline, fx.tree]);
    expect(check.code).toBe(1);
    const entry = fileStatus(check.summary, "logo.bin");
    expect(entry.status).toBe("drifted");
    expect(entry.detail).toContain("binary files differ");
    expect(entry.detail).toContain("2 bytes pinned, 2 bytes in the tree");
    expect(entry.detail).not.toContain("@@");
  });

  test("a Latin-1 text file (not valid UTF-8) still renders as a text patch", () => {
    const fx = makeFixture({});
    fx.write("notes.txt", Buffer.from("café\n", "latin1"));
    expect(runBaseline(["pin", fx.baseline, fx.tree, "notes.txt"]).code).toBe(0);
    fx.write("notes.txt", Buffer.from("café updated\n", "latin1"));

    const check = runBaseline(["check", fx.baseline, fx.tree]);
    expect(check.code).toBe(1);
    const entry = fileStatus(check.summary, "notes.txt");
    expect(entry.status).toBe("drifted");
    expect(entry.detail).toContain("-café\n");
    expect(entry.detail).toContain("+café updated\n");
    expect(entry.detail).not.toContain("binary files differ");
  });

  test("a one-line edit in a multi-megabyte file renders as one focused hunk within the timeout", () => {
    const lines = Array.from(
      { length: 60_000 },
      (_, i) => `line ${i} of a generated document with some words to pad it out`,
    );
    const fx = makeFixture({ "big.txt": `${lines.join("\n")}\n` });
    expect(runBaseline(["pin", fx.baseline, fx.tree, "big.txt"]).code).toBe(0);
    lines[30_000] = "line 30000 was edited";
    fx.write("big.txt", `${lines.join("\n")}\n`);

    const check = runBaseline(["check", fx.baseline, fx.tree]);
    expect(check.code).toBe(1);
    const entry = fileStatus(check.summary, "big.txt");
    expect(entry.status).toBe("drifted");
    expect(entry.detail).toContain("-line 30000 of a generated document");
    expect(entry.detail).toContain("+line 30000 was edited");
    expect(entry.detail).toContain(" line 29997 of");
    expect(entry.detail?.split("\n").length).toBeLessThan(20);
  });

  test("bad usage exits 2 and the ok:false JSON summary names the reason", () => {
    const cases = [
      { id: "no-subcommand", args: [], message: "missing subcommand" },
      {
        id: "unknown-subcommand",
        args: ["frobnicate", "a", "b"],
        message: "unknown subcommand: frobnicate",
      },
      { id: "pin-short", args: ["pin", "only-one-arg"], message: "pin requires" },
      { id: "check-short", args: ["check", "only-one"], message: "check requires" },
      { id: "check-extra", args: ["check", "a", "b", "c"], message: "check requires" },
      {
        id: "traversal",
        args: ["pin", "/tmp/x", "/tmp/y", "../escape.md"],
        message: "path traversal",
      },
      {
        id: "backslash",
        args: ["pin", "/tmp/x", "/tmp/y", "..\\outside.md"],
        message: "backslash",
      },
      {
        id: "drive-relative",
        args: ["pin", "/tmp/x", "/tmp/y", "C:outside.md"],
        message: "drive-prefixed",
      },
    ];
    for (const c of cases) {
      const r = runBaseline(c.args);
      expect(r.code, c.id).toBe(2);
      expect(r.summary?.ok, c.id).toBe(false);
      expect(r.summary?.error, c.id).toContain(c.message);
    }
  });
});
