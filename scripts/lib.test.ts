import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  CheckFailure,
  KEBAB_CASE,
  loadJson,
  loadJsonObject,
  loadMarketplace,
  loadRootManifest,
  parseFrontmatter,
  ROOT,
  rel,
  skillDirs,
} from "./lib";

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

  test("fails on a missing file", () => {
    const run = () => parseFrontmatter("/nonexistent/SKILL.md");
    expect(run).toThrow(CheckFailure);
    expect(run).toThrow(/nonexistent\/SKILL\.md: cannot read file/);
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

describe("loadJsonObject", () => {
  test("parses a JSON object root", () => {
    expect(loadJsonObject(tempFile('{"a": 1}', "x.json"))).toEqual({ a: 1 });
  });

  test("fails when the root is not an object", () => {
    for (const content of ["[1]", '"text"', "null", "3"]) {
      const run = () => loadJsonObject(tempFile(content, "x.json"));
      expect(run).toThrow(CheckFailure);
      expect(run).toThrow(/x\.json: root must be an object/);
    }
  });

  test("fails on a missing file", () => {
    const run = () => loadJsonObject("/nonexistent/x.json");
    expect(run).toThrow(CheckFailure);
    expect(run).toThrow(/nonexistent\/x\.json: cannot read file/);
  });
});

describe("loadRootManifest", () => {
  test("returns the typed name, skill paths, and the path it read", () => {
    const path = tempFile(
      '{"name": "my-plugin", "skills": ["./skills/a", "./skills/b"], "license": "MIT"}',
      "plugin.json",
    );
    const manifest = loadRootManifest(path);
    expect(manifest.path).toBe(path);
    expect(manifest.name).toBe("my-plugin");
    expect(manifest.skills).toEqual(["./skills/a", "./skills/b"]);
    expect(manifest.raw.license).toBe("MIT");
  });

  test("loads the repo manifest listing exactly the skill folders", () => {
    const manifest = loadRootManifest();
    expect(KEBAB_CASE.test(manifest.name)).toBe(true);
    const listed = manifest.skills.map((skillPath) => resolve(ROOT, skillPath)).sort();
    const folders = skillDirs();
    const missing = folders.filter((dir) => !listed.includes(dir)).map(rel);
    expect(missing, "skill folders not listed in .claude-plugin/plugin.json skills").toEqual([]);
    const extra = listed.filter((dir) => !folders.includes(dir)).map(rel);
    expect(
      extra,
      "paths listed in .claude-plugin/plugin.json skills without a skill folder",
    ).toEqual([]);
    expect(listed).toEqual(folders);
  });

  test("fails when name is missing or not kebab-case", () => {
    for (const content of [
      '{"skills": ["./skills/a"]}',
      '{"name": "Not Kebab", "skills": ["./skills/a"]}',
    ]) {
      const run = () => loadRootManifest(tempFile(content, "plugin.json"));
      expect(run).toThrow(CheckFailure);
      expect(run).toThrow(/plugin\.json: name .* must be kebab-case/);
    }
  });

  test("fails when skills is missing or empty", () => {
    for (const content of ['{"name": "my-plugin"}', '{"name": "my-plugin", "skills": []}']) {
      const run = () => loadRootManifest(tempFile(content, "plugin.json"));
      expect(run).toThrow(CheckFailure);
      expect(run).toThrow(/plugin\.json: skills must be a non-empty array/);
    }
  });

  test("fails when a skill path is not a string", () => {
    const run = () =>
      loadRootManifest(tempFile('{"name": "my-plugin", "skills": [1]}', "plugin.json"));
    expect(run).toThrow(CheckFailure);
    expect(run).toThrow(/plugin\.json: skill paths must be strings/);
  });

  test("fails on a missing file", () => {
    const run = () => loadRootManifest("/nonexistent/plugin.json");
    expect(run).toThrow(CheckFailure);
    expect(run).toThrow(/nonexistent\/plugin\.json: cannot read file/);
  });
});

describe("loadMarketplace", () => {
  test("returns the typed plugin entries and the path it read", () => {
    const path = tempFile(
      '{"plugins": [{"name": "my-plugin"}], "metadata": {"version": "1.0.0"}}',
      "marketplace.json",
    );
    const marketplace = loadMarketplace(path);
    expect(marketplace.path).toBe(path);
    expect(marketplace.plugins).toEqual([{ name: "my-plugin" }]);
    expect(marketplace.raw.metadata).toEqual({ version: "1.0.0" });
  });

  test("loads the repo marketplace", () => {
    expect(loadMarketplace().plugins.length).toBeGreaterThan(0);
  });

  test("fails when the root is not an object", () => {
    const run = () => loadMarketplace(tempFile("[]", "marketplace.json"));
    expect(run).toThrow(CheckFailure);
    expect(run).toThrow(/marketplace\.json: root must be an object/);
  });

  test("fails when plugins is missing or empty", () => {
    for (const content of ["{}", '{"plugins": []}']) {
      const run = () => loadMarketplace(tempFile(content, "marketplace.json"));
      expect(run).toThrow(CheckFailure);
      expect(run).toThrow(/marketplace\.json: missing plugins array/);
    }
  });

  test("fails when a plugin entry is not an object", () => {
    const run = () => loadMarketplace(tempFile('{"plugins": ["oops"]}', "marketplace.json"));
    expect(run).toThrow(CheckFailure);
    expect(run).toThrow(/marketplace\.json: each plugin entry must be an object/);
  });

  test("fails on a missing file", () => {
    const run = () => loadMarketplace("/nonexistent/marketplace.json");
    expect(run).toThrow(CheckFailure);
    expect(run).toThrow(/nonexistent\/marketplace\.json: cannot read file/);
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
