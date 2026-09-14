import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, parseSources, renderSources, type Source, update } from "../scripts/sync-xeno.mts";
import { tempDirs } from "./helpers/temp-dirs";

const temp = tempDirs();

function git(cwd: string, ...args: string[]): string {
  const proc = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr}`);
  return proc.stdout.trim();
}

function upstream(files: Record<string, string>): { url: string; dir: string; head: string } {
  const dir = temp.dir("sync-xeno-upstream-");
  git(dir, "init", "-q", "-b", "main");
  writeUpstream(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "one");
  return { url: `file://${dir}`, dir, head: git(dir, "rev-parse", "HEAD") };
}

function writeUpstream(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function commitUpstream(dir: string, files: Record<string, string>, message: string): string {
  writeUpstream(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
  return git(dir, "rev-parse", "HEAD");
}

const SKILL =
  "---\nname: alpha\ndescription: Use when testing.\ndisable-model-invocation: true\n---\n\n# Alpha\n\nbody\n";

function source(url: string, commit: string, extra: Partial<Source> = {}): Source {
  return { url, path: "plugins/skills/alpha", commit, license: "MIT", ...extra };
}

describe("update", () => {
  test("copies the whole upstream folder, recursively, and moves the pin to the ref's head", () => {
    const up = upstream({
      "plugins/skills/alpha/SKILL.md": SKILL,
      "plugins/skills/alpha/references/r.md": "ref\n",
    });
    const xeno = temp.dir("sync-xeno-copy-");
    const result = update({ alpha: source(up.url, "0".repeat(40)) }, xeno);
    expect(result.reports).toEqual([
      {
        name: "alpha",
        status: "updated",
        detail: `0000000 -> ${up.head.slice(0, 7)} on the default branch`,
      },
    ]);
    expect(result.sources.alpha?.commit).toBe(up.head);
    expect(readFileSync(join(xeno, "alpha", "SKILL.md"), "utf8")).toBe(SKILL);
    expect(readFileSync(join(xeno, "alpha", "references", "r.md"), "utf8")).toBe("ref\n");
  });

  test("a file the upstream removed leaves the copy; a copy already at the head is reported current", () => {
    const up = upstream({
      "plugins/skills/alpha/SKILL.md": SKILL,
      "plugins/skills/alpha/old.md": "old\n",
    });
    const xeno = temp.dir("sync-xeno-copy-");
    const first = update({ alpha: source(up.url, "0".repeat(40)) }, xeno);
    git(up.dir, "rm", "-q", "plugins/skills/alpha/old.md");
    const head = commitUpstream(up.dir, { "plugins/skills/alpha/SKILL.md": SKILL }, "drop old");
    const second = update(first.sources, xeno);
    expect(second.reports[0]?.status).toBe("updated");
    expect(existsSync(join(xeno, "alpha", "old.md"))).toBe(false);
    const third = update(second.sources, xeno);
    expect(third.reports).toEqual([
      { name: "alpha", status: "current", detail: `at ${head.slice(0, 7)}` },
    ]);
  });

  test("a frontmatter override removes or sets only the named keys and touches no other file", () => {
    const up = upstream({
      "plugins/skills/alpha/SKILL.md": SKILL,
      "plugins/skills/alpha/x.md": "x\n",
    });
    const xeno = temp.dir("sync-xeno-copy-");
    update(
      {
        alpha: source(up.url, "0".repeat(40), {
          frontmatter: { "disable-model-invocation": null, license: "MIT" },
        }),
      },
      xeno,
    );
    expect(readFileSync(join(xeno, "alpha", "SKILL.md"), "utf8")).toBe(
      "---\nname: alpha\ndescription: Use when testing.\nlicense: MIT\n---\n\n# Alpha\n\nbody\n",
    );
    expect(readFileSync(join(xeno, "alpha", "x.md"), "utf8")).toBe("x\n");
  });

  test("a named ref is followed instead of the default branch", () => {
    const up = upstream({ "plugins/skills/alpha/SKILL.md": SKILL });
    git(up.dir, "checkout", "-q", "-b", "stable");
    const stable = commitUpstream(
      up.dir,
      { "plugins/skills/alpha/SKILL.md": `${SKILL}stable\n` },
      "stable",
    );
    git(up.dir, "checkout", "-q", "main");
    const xeno = temp.dir("sync-xeno-copy-");
    const result = update({ alpha: source(up.url, "0".repeat(40), { ref: "stable" }) }, xeno);
    expect(result.sources.alpha?.commit).toBe(stable);
    expect(readFileSync(join(xeno, "alpha", "SKILL.md"), "utf8")).toEndWith("stable\n");
  });
});

describe("check", () => {
  test("current, outdated (ref moved), and modified (copy edited by hand) are told apart", () => {
    const up = upstream({ "plugins/skills/alpha/SKILL.md": SKILL });
    const xeno = temp.dir("sync-xeno-copy-");
    const synced = update({ alpha: source(up.url, "0".repeat(40)) }, xeno).sources;
    expect(check(synced, xeno)[0]?.status).toBe("current");

    writeFileSync(join(xeno, "alpha", "SKILL.md"), `${SKILL}edited\n`);
    expect(check(synced, xeno)[0]).toEqual({
      name: "alpha",
      status: "modified",
      detail: `differs from ${up.head.slice(0, 7)}: SKILL.md`,
    });

    writeFileSync(join(xeno, "alpha", "SKILL.md"), SKILL);
    const moved = commitUpstream(
      up.dir,
      { "plugins/skills/alpha/SKILL.md": `${SKILL}v2\n` },
      "two",
    );
    expect(check(synced, xeno)[0]).toEqual({
      name: "alpha",
      status: "outdated",
      detail: `${up.head.slice(0, 7)} -> ${moved.slice(0, 7)} on the default branch`,
    });
  });

  test("the check compares against upstream WITH the overrides applied, so an override is not drift", () => {
    const up = upstream({ "plugins/skills/alpha/SKILL.md": SKILL });
    const xeno = temp.dir("sync-xeno-copy-");
    const sources = {
      alpha: source(up.url, "0".repeat(40), { frontmatter: { "disable-model-invocation": null } }),
    };
    const synced = update(sources, xeno).sources;
    expect(check(synced, xeno)[0]?.status).toBe("current");
  });
});

describe("what a copy must keep", () => {
  test("a file git marks executable is executable in the copy, and losing the bit is drift", () => {
    const up = upstream({
      "plugins/skills/alpha/SKILL.md": SKILL,
      "plugins/skills/alpha/run.sh": "#!/bin/sh\n",
    });
    chmodSync(join(up.dir, "plugins/skills/alpha/run.sh"), 0o755);
    git(up.dir, "add", "-A");
    git(up.dir, "commit", "-q", "-m", "mode");
    const xeno = temp.dir("sync-xeno-copy-");
    const synced = update({ alpha: source(up.url, "0".repeat(40)) }, xeno).sources;
    expect(statSync(join(xeno, "alpha", "run.sh")).mode & 0o111).not.toBe(0);
    chmodSync(join(xeno, "alpha", "run.sh"), 0o644);
    expect(check(synced, xeno)[0]?.status).toBe("modified");
  });

  test("an override on a CRLF SKILL.md keeps CRLF throughout; a folded value keeps its style when set", () => {
    const crlf =
      "---\r\nname: alpha\r\ndescription: >-\r\n  Use when\r\n  testing.\r\ndisable-model-invocation: true\r\n---\r\n\r\n# Alpha\r\n";
    const up = upstream({ "plugins/skills/alpha/SKILL.md": crlf });
    const xeno = temp.dir("sync-xeno-copy-");
    update(
      {
        alpha: source(up.url, "0".repeat(40), {
          frontmatter: { description: "Use when testing.", "disable-model-invocation": null },
        }),
      },
      xeno,
    );
    expect(readFileSync(join(xeno, "alpha", "SKILL.md"), "utf8")).toBe(
      "---\r\nname: alpha\r\ndescription: >-\r\n  Use when testing.\r\n---\r\n\r\n# Alpha\r\n",
    );
  });

  test("a hand-edited copy stops the sync instead of being overwritten", () => {
    const up = upstream({ "plugins/skills/alpha/SKILL.md": SKILL });
    const xeno = temp.dir("sync-xeno-copy-");
    const synced = update({ alpha: source(up.url, "0".repeat(40)) }, xeno).sources;
    writeFileSync(join(xeno, "alpha", "SKILL.md"), `${SKILL}edited\n`);
    expect(() => update(synced, xeno)).toThrow(
      /differs from its pin .*SKILL\.md.*never overwrites a hand edit/,
    );
    expect(readFileSync(join(xeno, "alpha", "SKILL.md"), "utf8")).toBe(`${SKILL}edited\n`);
  });
});

describe("bodies are bytes", () => {
  test("a body that is not UTF-8 survives an override unchanged, and a one-byte edit to it is refused", () => {
    const body = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const up = upstream({ "README.md": "upstream\n" });
    mkdirSync(join(up.dir, "plugins/skills/alpha"), { recursive: true });
    writeFileSync(
      join(up.dir, "plugins/skills/alpha/SKILL.md"),
      Buffer.concat([Buffer.from(SKILL.split("\n\n")[0] as string), Buffer.from("\n\n"), body]),
    );
    git(up.dir, "add", "-A");
    git(up.dir, "commit", "-q", "-m", "latin1");
    const xeno = temp.dir("sync-xeno-copy-");
    const synced = update(
      {
        alpha: source(up.url, "0".repeat(40), {
          frontmatter: { "disable-model-invocation": null },
        }),
      },
      xeno,
    ).sources;
    const copied = readFileSync(join(xeno, "alpha", "SKILL.md"));
    expect(copied.subarray(copied.length - body.length).equals(body)).toBe(true);
    const edited = Buffer.from(copied);
    edited[edited.length - 2] = 0xf1;
    writeFileSync(join(xeno, "alpha", "SKILL.md"), edited);
    expect(() => update(synced, xeno)).toThrow(/never overwrites a hand edit/);
  });
});

describe("changing an override is not a hand edit", () => {
  test("adding a frontmatter override to a synced source re-syncs instead of stopping", () => {
    const up = upstream({ "plugins/skills/alpha/SKILL.md": SKILL });
    const xeno = temp.dir("sync-xeno-copy-");
    const synced = update({ alpha: source(up.url, "0".repeat(40)) }, xeno).sources;
    const withOverride = {
      alpha: { ...(synced.alpha as Source), frontmatter: { "disable-model-invocation": null } },
    };
    expect(update(withOverride, xeno).reports[0]?.status).toBe("updated");
    expect(readFileSync(join(xeno, "alpha", "SKILL.md"), "utf8")).not.toContain(
      "disable-model-invocation",
    );
  });
});

describe("sources.yml round-trips through Bun.YAML", () => {
  test("every string the parser accepts comes back as the same string, and an empty registry is valid", () => {
    // Bun.YAML reads a bare 1e3 as a number and a bare @foo as an error, so the
    // renderer must quote them; a comment-only file parses to null.
    const sources = {
      alpha: source("https://example.com/r.git", "a".repeat(40), {
        ref: "main",
        frontmatter: {
          "disable-model-invocation": null,
          note: "quoted: yes",
          version: "1e3",
          trailing: "foo:",
          True: "kept as a string key",
          handle: "@foo",
          flag: true,
        },
      }),
      beta: source("https://example.com/s.git", "b".repeat(40), { license: "none published" }),
    };
    const text = renderSources(sources, "# header\n# two");
    expect(text.startsWith("# header\n# two\n\nalpha:\n")).toBe(true);
    expect(parseSources(text)).toEqual(sources);
    expect(parseSources(renderSources({}, "# empty"))).toEqual({});
  });
});
