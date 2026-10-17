// reaches: bin/install-shared.mjs
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { markExplicitOnly, markExplicitOnlyUpstreams } from "../../bin/install-shared.mjs";
import { tempDirs } from "../helpers/temp-dirs";

const temp = tempDirs();

// What drifts: the two files are external contracts, `disable-model-invocation` in SKILL.md's frontmatter is
// what Claude Code reads and `policy.allow_implicit_invocation` in agents/openai.yaml is what Codex reads, and
// an upstream copy arrives in whatever shape its author chose, so the mark must land in each shape and leave
// the rest of the file as it was.
function skillCopy(skillMd: string, openaiYaml?: string): string {
  const dir = temp.dir("install-shared-");
  writeFileSync(join(dir, "SKILL.md"), skillMd);
  if (openaiYaml !== undefined) {
    mkdirSync(join(dir, "agents"));
    writeFileSync(join(dir, "agents", "openai.yaml"), openaiYaml);
  }
  return dir;
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), "utf8");

describe("markExplicitOnly", () => {
  test("adds the frontmatter key and writes the sidecar when the copy has neither", () => {
    const dir = skillCopy("---\nname: alpha-one\ndescription: Use when asked.\n---\n\n# Alpha\n");

    expect(markExplicitOnly(dir)).toBe(true);
    expect(read(dir, "SKILL.md")).toBe(
      "---\nname: alpha-one\ndescription: Use when asked.\ndisable-model-invocation: true\n---\n\n# Alpha\n",
    );
    expect(read(dir, "agents/openai.yaml")).toBe("policy:\n  allow_implicit_invocation: false\n");
  });

  test("flips a frontmatter key set false and adds the policy block ahead of an interface-only sidecar", () => {
    const dir = skillCopy(
      "---\nname: alpha-one\ndisable-model-invocation: false\nmetadata:\n  version: 1.0.0\n---\nbody\n",
      "interface:\n  display_name: Alpha\n",
    );

    markExplicitOnly(dir);

    expect(read(dir, "SKILL.md")).toBe(
      "---\nname: alpha-one\nmetadata:\n  version: 1.0.0\ndisable-model-invocation: true\n---\nbody\n",
    );
    expect(read(dir, "agents/openai.yaml")).toBe(
      "policy:\n  allow_implicit_invocation: false\n\ninterface:\n  display_name: Alpha\n",
    );
  });

  test("flips an existing policy line in place and keeps the rest of the sidecar", () => {
    const dir = skillCopy(
      "---\nname: alpha-one\n---\nbody\n",
      "policy:\n  allow_implicit_invocation: true\n\ninterface:\n  display_name: Alpha\n",
    );

    markExplicitOnly(dir);

    expect(read(dir, "agents/openai.yaml")).toBe(
      "policy:\n  allow_implicit_invocation: false\n\ninterface:\n  display_name: Alpha\n",
    );
  });

  test("fills a bare policy block", () => {
    const dir = skillCopy(
      "---\nname: alpha-one\n---\nbody\n",
      "policy:\ninterface:\n  display_name: Alpha\n",
    );

    markExplicitOnly(dir);

    expect(read(dir, "agents/openai.yaml")).toBe(
      "policy:\n  allow_implicit_invocation: false\ninterface:\n  display_name: Alpha\n",
    );
  });

  test("finds a closing fence at the end of the file, with no newline after it", () => {
    const dir = skillCopy("---\nname: alpha-one\n---");

    markExplicitOnly(dir);

    expect(read(dir, "SKILL.md")).toBe(
      "---\nname: alpha-one\ndisable-model-invocation: true\n---\n",
    );
  });

  test("leaves a horizontal rule in the body alone", () => {
    const dir = skillCopy("---\nname: alpha-one\n---\n\nbody\n\n---\n\nrest\n");

    markExplicitOnly(dir);

    expect(read(dir, "SKILL.md")).toBe(
      "---\nname: alpha-one\ndisable-model-invocation: true\n---\n\nbody\n\n---\n\nrest\n",
    );
  });

  test("flips the policy child only, never a look-alike line inside another block", () => {
    const dir = skillCopy(
      "---\nname: alpha-one\n---\nbody\n",
      "interface:\n  short_description: |\n    allow_implicit_invocation: true\npolicy:\n  allow_implicit_invocation: true\n",
    );

    markExplicitOnly(dir);

    expect(read(dir, "agents/openai.yaml")).toBe(
      "interface:\n  short_description: |\n    allow_implicit_invocation: true\npolicy:\n  allow_implicit_invocation: false\n",
    );
  });

  test("gives a SKILL.md without frontmatter one", () => {
    const dir = skillCopy("# Alpha\n\nbody\n");

    markExplicitOnly(dir);

    expect(read(dir, "SKILL.md")).toBe(
      "---\ndisable-model-invocation: true\n---\n# Alpha\n\nbody\n",
    );
  });

  test("is idempotent: a second mark changes no byte", () => {
    const dir = skillCopy(
      "---\nname: alpha-one\n---\nbody\n",
      "interface:\n  display_name: Alpha\n",
    );
    markExplicitOnly(dir);
    const once = [read(dir, "SKILL.md"), read(dir, "agents/openai.yaml")];

    markExplicitOnly(dir);

    expect([read(dir, "SKILL.md"), read(dir, "agents/openai.yaml")]).toEqual(once);
  });

  test("writes nothing and reports false where there is no SKILL.md", () => {
    const dir = temp.dir("install-shared-empty-");

    expect(markExplicitOnly(dir)).toBe(false);
    expect(existsSync(join(dir, "agents"))).toBe(false);
  });
});

describe("markExplicitOnlyUpstreams", () => {
  test("marks the flagged copies that exist, reports the flagged copies that do not, skips the unflagged", () => {
    const skills = temp.dir("install-shared-skills-");
    for (const name of ["alpha-one", "gamma-three"]) {
      mkdirSync(join(skills, name));
      writeFileSync(join(skills, name, "SKILL.md"), `---\nname: ${name}\n---\nbody\n`);
    }
    const upstream = [
      { name: "alpha-one", target: "example-org/alpha/skills/alpha-one", explicitOnly: true },
      { name: "beta-two", target: "example-org/beta/skills/beta-two", explicitOnly: true },
      { name: "gamma-three", target: "example-org/gamma/gamma", explicitOnly: false },
    ];

    expect(markExplicitOnlyUpstreams(upstream, skills)).toEqual({
      marked: [join(skills, "alpha-one")],
      missing: [join(skills, "beta-two")],
    });
    expect(read(skills, "alpha-one/SKILL.md")).toContain("disable-model-invocation: true");
    expect(read(skills, "gamma-three/SKILL.md")).toBe("---\nname: gamma-three\n---\nbody\n");
  });
});
