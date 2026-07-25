import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CheckFailure, KEBAB_CASE, loadJson, parseFrontmatter, skillDirs } from "./lib";

function tempFile(content: string, name = "SKILL.md"): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-lib-test-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("parseFrontmatter", () => {
  test("parses top-level and nested keys with YAML types", () => {
    const path = tempFile(
      [
        "---",
        "name: test-skill",
        "metadata:",
        "  internal: true",
        "  author: Vivswan",
        "---",
        "body",
      ].join("\n"),
    );
    expect(parseFrontmatter(path)).toEqual({
      name: "test-skill",
      metadata: { internal: true, author: "Vivswan" },
    });
  });

  test("strips surrounding quotes from values", () => {
    const path = tempFile("---\ndescription: \"A quoted description\"\nlicense: 'MIT'\n---\n");
    expect(parseFrontmatter(path)).toEqual({
      description: "A quoted description",
      license: "MIT",
    });
  });

  test("parses folded block scalars as their full text", () => {
    const path = tempFile("---\ndescription: >-\n  first line\n  second line\n---\n");
    expect(parseFrontmatter(path)).toEqual({ description: "first line second line" });
  });

  test("sees keys inside inline maps", () => {
    const path = tempFile("---\nmetadata: { version: 1.2.3 }\n---\n");
    const metadata = parseFrontmatter(path).metadata as Record<string, unknown>;
    expect("version" in metadata).toBe(true);
  });

  test("fails without a frontmatter start marker", () => {
    expect(() => parseFrontmatter(tempFile("# no frontmatter\n"))).toThrow(CheckFailure);
  });

  test("fails without a frontmatter end marker", () => {
    expect(() => parseFrontmatter(tempFile("---\nname: x\n"))).toThrow(CheckFailure);
  });

  test("fails on invalid YAML", () => {
    expect(() => parseFrontmatter(tempFile("---\nname: [unclosed\n---\n"))).toThrow(CheckFailure);
  });

  test("fails when frontmatter is not a mapping", () => {
    expect(() => parseFrontmatter(tempFile("---\n- just\n- a list\n---\n"))).toThrow(CheckFailure);
  });

  test("parses every published SKILL.md, name matching its folder", () => {
    for (const dir of skillDirs()) {
      const frontmatter = parseFrontmatter(join(dir, "SKILL.md"));
      expect(frontmatter.name).toBe(basename(dir));
      expect(typeof frontmatter.description).toBe("string");
    }
  });
});

describe("loadJson", () => {
  test("parses valid JSON", () => {
    expect(loadJson(tempFile('{"a": 1}', "x.json"))).toEqual({ a: 1 });
  });

  test("fails on invalid JSON", () => {
    expect(() => loadJson(tempFile("{oops", "x.json"))).toThrow(CheckFailure);
  });

  test("fails on a missing file", () => {
    expect(() => loadJson("/nonexistent/x.json")).toThrow(CheckFailure);
  });
});

describe("KEBAB_CASE", () => {
  test("accepts kebab-case names", () => {
    for (const name of ["skills", "natural-writing", "a1-b2"]) {
      expect(KEBAB_CASE.test(name)).toBe(true);
    }
  });

  test("rejects everything else", () => {
    for (const name of ["Natural-Writing", "a_b", "-leading", "trailing-", "a--b", ""]) {
      expect(KEBAB_CASE.test(name)).toBe(false);
    }
  });
});
