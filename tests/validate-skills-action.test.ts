import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CheckFailure,
  kebabToTitle,
  listedInOutput,
  loadJson,
  loadJsonObject,
  loadPluginManifest,
  parseFrontmatter,
  skillDirs,
  validateMarketplace,
  validateSkillDir,
  validateStructure,
} from "../.github/actions/validate-skills/validate_skills.ts";
import { tempDirs } from "./helpers/temp-dirs.ts";

const temp = tempDirs();

function tempDir(): string {
  return temp.dir("validate-skills-test-");
}

function tempFile(content: string, name = "SKILL.md"): string {
  const path = join(tempDir(), name);
  writeFileSync(path, content);
  return path;
}

function fixtureRepo(options: { skills?: string[]; skillNames?: string[] } = {}): string {
  const root = tempDir();
  const skillNames = options.skillNames ?? ["good-skill"];
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "fixture-skills",
      skills: options.skills ?? skillNames.map((name) => `./skills/${name}`),
    }),
  );
  for (const name of skillNames) {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(
      join(root, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: A fixture skill.\n---\nbody\n`,
    );
  }
  if (skillNames.length > 0) writeFileSync(join(root, "skills", "README.md"), "# Skills\n");
  return root;
}

describe("parseFrontmatter", () => {
  test("parses top-level and nested keys with YAML types", () => {
    const path = tempFile(
      ["---", "name: test-skill", "metadata:", "  internal: true", "---", "body"].join("\n"),
    );
    expect(parseFrontmatter(path, "SKILL.md")).toEqual({
      name: "test-skill",
      metadata: { internal: true },
    });
  });

  test("strips surrounding quotes from values", () => {
    const path = tempFile("---\ndescription: \"A quoted description\"\nlicense: 'MIT'\n---\n");
    expect(parseFrontmatter(path, "SKILL.md")).toEqual({
      description: "A quoted description",
      license: "MIT",
    });
  });

  test("accepts CRLF line endings around and inside the frontmatter", () => {
    const path = tempFile("---\r\nname: crlf-skill\r\ndescription: d\r\n---\r\nbody\r\n");
    expect(parseFrontmatter(path, "SKILL.md")).toEqual({ name: "crlf-skill", description: "d" });
    const run = () => parseFrontmatter(tempFile("# no frontmatter\r\n"), "fixture/SKILL.md");
    expect(run).toThrow(CheckFailure);
    expect(run).toThrow(/^fixture\/SKILL\.md: missing YAML frontmatter start/);
  });

  test("parses folded block scalars as their full text", () => {
    const path = tempFile("---\ndescription: >-\n  first line\n  second line\n---\n");
    expect(parseFrontmatter(path, "SKILL.md")).toEqual({ description: "first line second line" });
  });

  // Every fail() raises the same CheckFailure class, so each row also pins
  // the message that proves which branch of the loader fired.
  test.each<[reason: string, fixture: () => string, message: RegExp]>([
    [
      "no start marker",
      () => tempFile("# no frontmatter\n"),
      /^fixture\/SKILL\.md: missing YAML frontmatter start/,
    ],
    [
      "no end marker",
      () => tempFile("---\nname: x\n"),
      /^fixture\/SKILL\.md: missing YAML frontmatter end/,
    ],
    [
      "invalid YAML",
      () => tempFile("---\nname: [unclosed\n---\n"),
      /^fixture\/SKILL\.md: invalid YAML frontmatter/,
    ],
    [
      "a list instead of a mapping",
      () => tempFile("---\n- just\n- a list\n---\n"),
      /^fixture\/SKILL\.md: frontmatter must be a YAML mapping/,
    ],
    ["a missing file", () => "/nonexistent/SKILL.md", /^fixture\/SKILL\.md: cannot read file/],
  ])("fails on %s, naming the file and the cause", (_reason, fixture, message) => {
    const run = () => parseFrontmatter(fixture(), "fixture/SKILL.md");
    expect(run).toThrow(CheckFailure);
    expect(run).toThrow(message);
  });
});

describe("loadJson / loadJsonObject", () => {
  test("parses valid JSON", () => {
    expect(loadJson(tempFile('{"a": 1}', "x.json"), "x.json")).toEqual({ a: 1 });
  });

  test.each<[reason: string, fixture: () => string, message: RegExp]>([
    ["invalid JSON", () => tempFile("{oops", "x.json"), /^fixture\/x\.json: invalid JSON/],
    ["a missing file", () => "/nonexistent/x.json", /^fixture\/x\.json: cannot read file/],
  ])("fails on %s, naming the file and the cause", (_reason, fixture, message) => {
    const run = () => loadJson(fixture(), "fixture/x.json");
    expect(run).toThrow(CheckFailure);
    expect(run).toThrow(message);
  });

  test("fails when the root is not an object", () => {
    for (const content of ["[1]", '"text"', "null", "3"]) {
      const run = () => loadJsonObject(tempFile(content, "x.json"), "x.json");
      expect(run).toThrow(CheckFailure);
      expect(run).toThrow(/x\.json: root must be an object/);
    }
  });
});

describe("loadPluginManifest", () => {
  test("accepts the starter's empty skills array", () => {
    const path = tempFile('{"name": "my-skills", "skills": []}', "plugin.json");
    expect(loadPluginManifest(path, "plugin.json")).toEqual({ name: "my-skills", skills: [] });
  });

  test("rejects a non-kebab-case name", () => {
    for (const name of ["My Skills", "my_skills", "-lead", "", 3]) {
      const path = tempFile(JSON.stringify({ name, skills: [] }), "plugin.json");
      expect(() => loadPluginManifest(path, "plugin.json")).toThrow(/must be kebab-case/);
    }
  });

  test("rejects a missing or non-array skills key", () => {
    for (const skills of [undefined, "skills", { a: 1 }]) {
      const path = tempFile(JSON.stringify({ name: "x-y", skills }), "plugin.json");
      expect(() => loadPluginManifest(path, "plugin.json")).toThrow(/skills must be an array/);
    }
  });

  test("rejects non-string skill paths", () => {
    const path = tempFile('{"name": "x-y", "skills": [3]}', "plugin.json");
    expect(() => loadPluginManifest(path, "plugin.json")).toThrow(/must be strings/);
  });
});

describe("validateSkillDir", () => {
  function skillFixture(folder: string, frontmatter: string): string {
    const dir = join(tempDir(), folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), frontmatter);
    return dir;
  }

  const LONG_NAME = `x${"-x".repeat(40)}`; // 81 chars, kebab-case

  // The whole error list per SKILL.md, so a spurious or duplicated message
  // fails the row instead of hiding behind a substring match.
  test.each<[reason: string, folder: string, frontmatter: string, errors: string[]]>([
    [
      "a conforming skill",
      "good-skill",
      "---\nname: good-skill\ndescription: Does things.\n---\n",
      [],
    ],
    [
      "name/folder mismatch and missing description, reported together",
      "real-name",
      "---\nname: other-name\n---\n",
      [
        "skills/real-name/SKILL.md: frontmatter name 'other-name' does not match folder 'real-name'",
        "skills/real-name/SKILL.md: missing frontmatter description",
      ],
    ],
    [
      "a non-kebab-case name",
      "Bad_Name",
      "---\nname: Bad_Name\ndescription: d\n---\n",
      ["skills/Bad_Name/SKILL.md: name 'Bad_Name' must be kebab-case"],
    ],
    [
      "a whitespace-only description",
      "blank-skill",
      '---\nname: blank-skill\ndescription: "   "\n---\n',
      ["skills/blank-skill/SKILL.md: missing frontmatter description"],
    ],
    [
      "name and description over their length limits",
      LONG_NAME,
      `---\nname: ${LONG_NAME}\ndescription: ${"d".repeat(1025)}\n---\n`,
      [
        `skills/${LONG_NAME}/SKILL.md: name exceeds 64 characters`,
        `skills/${LONG_NAME}/SKILL.md: description exceeds 1024 characters`,
      ],
    ],
  ])("reports %s", (_reason, folder, frontmatter, errors) => {
    const dir = skillFixture(folder, frontmatter);
    expect(validateSkillDir(dir, `skills/${folder}`)).toEqual(errors);
  });

  test("reports a missing SKILL.md", () => {
    const dir = join(tempDir(), "empty-skill");
    mkdirSync(dir, { recursive: true });
    const errors = validateSkillDir(dir, "skills/empty-skill");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/cannot read file/);
  });

  test("parses .mcp.json when the skill carries one", () => {
    const dir = skillFixture("mcp-skill", "---\nname: mcp-skill\ndescription: d\n---\n");
    writeFileSync(join(dir, ".mcp.json"), "{oops");
    const errors = validateSkillDir(dir, "skills/mcp-skill");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/\.mcp\.json: invalid JSON/);
    writeFileSync(join(dir, ".mcp.json"), '{"mcpServers": {}}');
    expect(validateSkillDir(dir, "skills/mcp-skill")).toEqual([]);
  });
});

describe("validateStructure", () => {
  test("passes a valid tree", () => {
    expect(validateStructure(fixtureRepo(), "skills", ".claude-plugin/plugin.json")).toEqual([]);
  });

  test("passes the starter state (empty catalog, no skills dir)", () => {
    const root = fixtureRepo({ skills: [], skillNames: [] });
    expect(validateStructure(root, "skills", ".claude-plugin/plugin.json")).toEqual([]);
  });

  test("requires an index README.md when the skills dir exists", () => {
    const root = fixtureRepo();
    rmSync(join(root, "skills", "README.md"));
    const errors = validateStructure(root, "skills", ".claude-plugin/plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /skills\/README\.md: missing; a skills directory must carry an index README\.md at its root/,
    );
  });

  test("an empty skills dir needs the README too; a missing dir does not", () => {
    const root = fixtureRepo({ skills: [], skillNames: [] });
    mkdirSync(join(root, "skills"));
    const errors = validateStructure(root, "skills", ".claude-plugin/plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/skills\/README\.md: missing/);
    writeFileSync(join(root, "skills", "README.md"), "# Skills\n");
    expect(validateStructure(root, "skills", ".claude-plugin/plugin.json")).toEqual([]);
  });

  test("rejects a non-directory entry at the skills path", () => {
    const root = fixtureRepo({ skills: [], skillNames: [] });
    writeFileSync(join(root, "skills"), "not a directory\n");
    const errors = validateStructure(root, "skills", ".claude-plugin/plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/skills: exists but is a regular file/);
  });

  test("rejects a symlinked skills-root README.md", () => {
    const root = fixtureRepo();
    rmSync(join(root, "skills", "README.md"));
    writeFileSync(join(root, "real-readme.md"), "# Skills\n");
    symlinkSync(join(root, "real-readme.md"), join(root, "skills", "README.md"));
    const errors = validateStructure(root, "skills", ".claude-plugin/plugin.json");
    // Exactly one error: the file-specific message replaces the directory
    // walk's generic symlinked-entry remediation for this path.
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/skills\/README\.md: must be a real file, not a symlink/);
  });

  test("reports a missing plugin manifest", () => {
    const errors = validateStructure(tempDir(), "skills", ".claude-plugin/plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/plugin\.json: cannot read file/);
  });

  test.each<[reason: string, path: string]>([
    ["a traversal that collapses out of the skills dir", "./skills/a/../../evil"],
    ["a path above the repository", "../outside"],
    ["a sibling directory outside skills/", "./other/dir"],
  ])("rejects %s as a skill path", (_reason, path) => {
    const root = fixtureRepo({ skills: [path], skillNames: [] });
    expect(validateStructure(root, "skills", ".claude-plugin/plugin.json")).toEqual([
      `.claude-plugin/plugin.json: skill path ${path} must be a direct child of skills/`,
    ]);
  });

  test("rejects a referenced skill without SKILL.md", () => {
    const root = fixtureRepo({ skills: ["./skills/ghost"], skillNames: [] });
    expect(validateStructure(root, "skills", ".claude-plugin/plugin.json")).toEqual([
      ".claude-plugin/plugin.json: referenced skill ./skills/ghost has no SKILL.md",
    ]);
  });

  test("validates unlisted folders under the skills dir too", () => {
    const root = fixtureRepo();
    mkdirSync(join(root, "skills", "stray-skill"));
    writeFileSync(join(root, "skills", "stray-skill", "SKILL.md"), "---\nname: wrong\n---\n");
    expect(validateStructure(root, "skills", ".claude-plugin/plugin.json")).toEqual([
      "skills/stray-skill/SKILL.md: frontmatter name 'wrong' does not match folder 'stray-skill'",
      "skills/stray-skill/SKILL.md: missing frontmatter description",
    ]);
  });

  test("honors a custom skills dir", () => {
    const root = tempDir();
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      '{"name": "x-y", "skills": ["./lib/skills/a-skill"]}',
    );
    mkdirSync(join(root, "lib", "skills", "a-skill"), { recursive: true });
    writeFileSync(join(root, "lib", "skills", "README.md"), "# Skills\n");
    writeFileSync(
      join(root, "lib", "skills", "a-skill", "SKILL.md"),
      "---\nname: a-skill\ndescription: d\n---\n",
    );
    expect(validateStructure(root, "lib/skills", ".claude-plugin/plugin.json")).toEqual([]);
    expect(validateStructure(root, "skills", ".claude-plugin/plugin.json")).toEqual([
      ".claude-plugin/plugin.json: skill path ./lib/skills/a-skill must be a direct child of skills/",
    ]);
  });
});

describe("validateMarketplace", () => {
  const ROOT_PLUGIN = { name: "x-y", skills: [] } as const;
  // null (not undefined - a default parameter would resurrect ROOT_PLUGIN)
  // models plugin.json having failed to load.
  const run = (
    root: string,
    content: unknown,
    rootPlugin: typeof ROOT_PLUGIN | null = ROOT_PLUGIN,
  ) => {
    const path = join(root, "marketplace.json");
    writeFileSync(path, JSON.stringify(content));
    return validateMarketplace(
      path,
      "marketplace.json",
      root,
      join(root, "skills"),
      "skills",
      rootPlugin ?? undefined,
    );
  };

  test("passes the starter shape", () => {
    const root = tempDir();
    expect(run(root, { name: "x-y", plugins: [{ name: "x-y", source: "./" }] })).toEqual([]);
  });

  test("rejects malformed roots and entries", () => {
    const root = tempDir();
    const cases: [unknown, RegExp][] = [
      [{ plugins: [{ name: "x-y", source: "./" }] }, /name undefined must be kebab-case/],
      [{ name: "Not Kebab", plugins: [{ name: "x-y", source: "./" }] }, /must be kebab-case/],
      [{ name: "x-y" }, /missing plugins array/],
      [{ name: "x-y", plugins: [] }, /missing plugins array/],
      [{ name: "x-y", plugins: ["x"] }, /must be an object/],
      [{ name: "x-y", plugins: [{ name: "Bad Name", source: "./" }] }, /must be kebab-case/],
      [{ name: "x-y", plugins: [{ name: "x-y" }] }, /needs a source path/],
      [
        { name: "x-y", plugins: [{ name: "x-y", source: "../../outside" }] },
        /escapes the repository/,
      ],
      [{ name: "x-y", plugins: [{ name: "x-y", source: "./gone" }] }, /is not a directory/],
      [
        { name: "x-y", plugins: [{ name: "other-name", source: "./" }] },
        /the two manifests must agree/,
      ],
      [
        { name: "x-y", plugins: [{ name: "x-y", source: "./", skills: ["./gone"] }] },
        /must be a direct child of skills\//,
      ],
      [
        { name: "x-y", plugins: [{ name: "x-y", source: "./", skills: ["./skills/gone"] }] },
        /has no SKILL\.md/,
      ],
      [
        {
          name: "x-y",
          plugins: [{ name: "x-y", source: "./", skills: ["./skills/a/../../evil"] }],
        },
        /must be a direct child of skills\//,
      ],
    ];
    for (const [content, message] of cases) {
      const errors = run(root, content);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatch(message);
    }
  });

  test("accepts a single skill path string, as the marketplace schema allows", () => {
    const root = tempDir();
    mkdirSync(join(root, "skills", "one-skill"), { recursive: true });
    writeFileSync(join(root, "skills", "one-skill", "SKILL.md"), "---\nname: one-skill\n---\n");
    const plugin = { name: "x-y", source: "./", skills: "./skills/one-skill" };
    expect(run(root, { name: "x-y", plugins: [plugin] })).toEqual([]);
    const errors = run(root, { name: "x-y", plugins: [{ ...plugin, skills: 3 }] });
    expect(errors).toEqual(["marketplace.json: plugin 'x-y' skills must be a list"]);
  });

  test("resolves a sub-plugin's skill paths anywhere under its source", () => {
    const root = tempDir();
    const plugin = { name: "sub-plugin", source: "./plugins/foo" };
    const manifest = (skills: string[]) => ({ name: "x-y", plugins: [{ ...plugin, skills }] });
    mkdirSync(join(root, "plugins", "foo", "extra"), { recursive: true });
    expect(run(root, manifest(["./extra/bar"]))).toEqual([
      "marketplace.json: plugin 'sub-plugin': skill path ./extra/bar (plugins/foo/extra/bar): has no SKILL.md",
    ]);
    mkdirSync(join(root, "plugins", "foo", "extra", "bar"));
    writeFileSync(
      join(root, "plugins", "foo", "extra", "bar", "SKILL.md"),
      "---\nname: bar\n---\n",
    );
    expect(run(root, manifest(["./extra/bar"]))).toEqual([]);
    mkdirSync(join(root, "plugins", "foo", "extra", "Bad_Leaf"));
    writeFileSync(join(root, "plugins", "foo", "extra", "Bad_Leaf", "SKILL.md"), "---\n---\n");
    expect(run(root, manifest(["./extra/Bad_Leaf"]))).toEqual([
      "marketplace.json: plugin 'sub-plugin': skill path ./extra/Bad_Leaf (plugins/foo/extra/Bad_Leaf): " +
        "skill folder name 'Bad_Leaf' must be kebab-case",
    ]);
    // Escaping the source, and a repository-root path that would pass for `source: "./"`, both fail.
    for (const outside of ["../x", "../../skills/bar", "./extra/../.."]) {
      expect(run(root, manifest([outside]))).toEqual([
        `marketplace.json: plugin 'sub-plugin': skill path ${outside} escapes the plugin source`,
      ]);
    }
  });

  test("a sub-plugin's skill path must be symlink-free from the repository root down", () => {
    const root = tempDir();
    const outside = tempDir();
    mkdirSync(join(outside, "bar"));
    writeFileSync(join(outside, "bar", "SKILL.md"), "---\nname: bar\n---\n");
    mkdirSync(join(root, "plugins", "foo"), { recursive: true });
    symlinkSync(outside, join(root, "plugins", "foo", "skills"));
    const manifest = {
      name: "x-y",
      plugins: [{ name: "sub-plugin", source: "./plugins/foo", skills: ["./skills/bar"] }],
    };
    const errors = run(root, manifest);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /^marketplace\.json: plugin 'sub-plugin': skill path \.\/skills\/bar \(plugins\/foo\/skills\/bar\): resolves through a symlink to /,
    );
    // The same shape through validateStructure, so the whole-tree entry point reports it too.
    mkdirSync(join(root, ".claude-plugin"));
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), '{"name": "x-y", "skills": []}');
    writeFileSync(join(root, ".claude-plugin", "marketplace.json"), JSON.stringify(manifest));
    expect(validateStructure(root, "skills", ".claude-plugin/plugin.json")).toEqual([
      `.claude-plugin/${errors[0]}`,
    ]);
  });

  test("aggregates across entries instead of stopping at the first bad one", () => {
    const root = tempDir();
    const errors = run(root, {
      name: "x-y",
      plugins: [{ name: "Bad Name", source: "./" }, "not-an-object", { name: "x-y", source: "./" }],
    });
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/must be kebab-case/);
    expect(errors[1]).toMatch(/must be an object/);
  });

  test("skips the root-name consistency check when plugin.json failed to load", () => {
    const root = tempDir();
    expect(
      run(root, { name: "x-y", plugins: [{ name: "other-name", source: "./" }] }, null),
    ).toEqual([]);
  });
});

describe("symlink policy", () => {
  test("rejects a symlinked skills directory", () => {
    const root = fixtureRepo({ skills: [], skillNames: [] });
    const real = join(root, "real-skills");
    mkdirSync(real);
    symlinkSync(real, join(root, "skills"));
    const errors = validateStructure(root, "skills", ".claude-plugin/plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/skills: resolves through a symlink/);
  });

  test("rejects a symlinked ancestor of the skills directory", () => {
    // skills_dir=lib/skills with lib/ itself a symlink: only the physical
    // root comparison sees this shape (the leaf lstat would pass).
    const root = tempDir();
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(
      join(root, ".claude-plugin", "plugin.json"),
      '{"name": "x-y", "skills": ["./lib/skills/a-skill"]}',
    );
    mkdirSync(join(root, "real-lib", "skills", "a-skill"), { recursive: true });
    writeFileSync(
      join(root, "real-lib", "skills", "a-skill", "SKILL.md"),
      "---\nname: a-skill\ndescription: d\n---\n",
    );
    symlinkSync(join(root, "real-lib"), join(root, "lib"));
    const errors = validateStructure(root, "lib/skills", ".claude-plugin/plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/lib\/skills: resolves through a symlink/);
  });

  test("rejects a dangling ancestor symlink even with an empty starter catalog", () => {
    // lib -> nothing: realpath fails, so the lstat walk up the chain must
    // name the link instead of reading the tree as an absent starter dir.
    const root = fixtureRepo({ skills: [], skillNames: [] });
    symlinkSync(join(root, "missing-target"), join(root, "lib"));
    const errors = validateStructure(root, "lib/skills", ".claude-plugin/plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/lib\/skills: lib is a symlink \(dangling or diverted\)/);
    expect(validateStructure(root, "absent/skills", ".claude-plugin/plugin.json")).toEqual([]);
  });

  test("rejects a symlinked plugin manifest", () => {
    const root = fixtureRepo({ skills: [], skillNames: [] });
    writeFileSync(join(root, "real-plugin.json"), '{"name": "x-y", "skills": []}');
    const manifest = join(root, ".claude-plugin", "linked-plugin.json");
    symlinkSync(join(root, "real-plugin.json"), manifest);
    const errors = validateStructure(root, "skills", ".claude-plugin/linked-plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/linked-plugin\.json: resolves through a symlink/);
  });

  test("rejects a symlinked skill folder, listed or not", () => {
    const root = fixtureRepo({ skills: ["./skills/linked-skill"], skillNames: ["good-skill"] });
    symlinkSync(join(root, "skills", "good-skill"), join(root, "skills", "linked-skill"));
    // The manifest side and the directory walk each name it once; nothing
    // beneath the link is validated.
    expect(validateStructure(root, "skills", ".claude-plugin/plugin.json")).toEqual([
      ".claude-plugin/plugin.json: skill path ./skills/linked-skill is a symlink; publish the real directory",
      "skills/linked-skill: symlinked entries are not validated and must not ship; publish a real directory",
    ]);
  });

  test("rejects a symlinked SKILL.md", () => {
    const root = fixtureRepo({ skills: ["./skills/link-md"], skillNames: ["good-skill"] });
    mkdirSync(join(root, "skills", "link-md"));
    symlinkSync(
      join(root, "skills", "good-skill", "SKILL.md"),
      join(root, "skills", "link-md", "SKILL.md"),
    );
    expect(validateStructure(root, "skills", ".claude-plugin/plugin.json")).toEqual([
      ".claude-plugin/plugin.json: ./skills/link-md/SKILL.md is a symlink; commit the real file",
      "skills/link-md/SKILL.md: must be a real file, not a symlink (a link can point outside the checkout)",
    ]);
  });

  test("rejects a symlinked .mcp.json", () => {
    const root = fixtureRepo();
    writeFileSync(join(root, "real-mcp.json"), '{"mcpServers": {}}');
    symlinkSync(join(root, "real-mcp.json"), join(root, "skills", "good-skill", ".mcp.json"));
    const errors = validateStructure(root, "skills", ".claude-plugin/plugin.json");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/\.mcp\.json: must be a real file, not a symlink/);
  });

  test("marketplace source may pass through an in-repo symlink but not leave the repo", () => {
    const root = fixtureRepo({ skills: [], skillNames: [] });
    const outside = tempDir();
    mkdirSync(join(root, "real-source"));
    symlinkSync(join(root, "real-source"), join(root, "in-repo-link"));
    symlinkSync(outside, join(root, "escape-link"));
    const marketplace = join(root, ".claude-plugin", "marketplace.json");
    const run = (source: string) => {
      writeFileSync(
        marketplace,
        JSON.stringify({ name: "x-y", plugins: [{ name: "x-y", source }] }),
      );
      return validateStructure(root, "skills", ".claude-plugin/plugin.json");
    };
    expect(run("./in-repo-link")).toEqual([]);
    const errors = run("./escape-link");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(
      /source \.\/escape-link resolves through a symlink to .*outside the repository/,
    );
  });

  test("a self-link source publishes the repository root and must match plugin.json's name", () => {
    // self-link -> . reaches the root physically; the name-consistency
    // check must compare physically too, not just for the literal "./".
    const root = fixtureRepo({ skills: [], skillNames: [] });
    symlinkSync(root, join(root, "self-link"));
    const marketplace = join(root, ".claude-plugin", "marketplace.json");
    const run = (name: string) => {
      writeFileSync(
        marketplace,
        JSON.stringify({ name: "x-y", plugins: [{ name, source: "./self-link" }] }),
      );
      return validateStructure(root, "skills", ".claude-plugin/plugin.json");
    };
    const errors = run("other-name");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/publishes the repository root but the plugin manifest names it/);
    expect(run("fixture-skills")).toEqual([]);
  });
});

describe("discovery helpers", () => {
  test("skillDirs handles missing dirs, sorts children, and flags symlinks", () => {
    expect(skillDirs(join(tempDir(), "nope"), "skills")).toEqual({ dirs: [], errors: [] });
    const root = tempDir();
    for (const name of ["b-skill", "a-skill"]) mkdirSync(join(root, name));
    writeFileSync(join(root, "not-a-dir"), "");
    symlinkSync(join(root, "a-skill"), join(root, "c-link"));
    const { dirs, errors } = skillDirs(root, "skills");
    expect(dirs).toEqual(["a-skill", "b-skill"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/skills\/c-link: symlinked entries/);
  });

  test("listedInOutput matches on name boundaries only", () => {
    expect(listedInOutput("foo", "installs foo (v1)")).toBe(true);
    expect(listedInOutput("foo", "installs foo-bar")).toBe(false);
    expect(listedInOutput("foo-bar", "has foo listed")).toBe(false);
    expect(listedInOutput("foo-bar", "> foo-bar\n")).toBe(true);
  });

  test("kebabToTitle capitalizes each segment", () => {
    expect(kebabToTitle("vivswan-skills")).toBe("Vivswan Skills");
    expect(kebabToTitle("x")).toBe("X");
  });
});
