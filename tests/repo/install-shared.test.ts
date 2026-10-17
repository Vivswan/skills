// reaches: bin/install-shared.mjs
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  agentSkillDirs,
  copiesBefore,
  markExplicitOnly,
  markWrittenCopies,
} from "../../bin/install-shared.mjs";
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

describe("agentSkillDirs", () => {
  // What drifts: the CLI's layout, `~/.<agent>/skills` beside the canonical `~/.agents/skills`, is an external
  // contract, and a symlink may reach the canonical directory, or a directory inside it, under another name.
  test("finds dot-dir skills directories and skips the canonical tree, even behind a symlink", () => {
    const root = temp.dir("install-shared-discover-");
    const agentsSkills = join(root, ".agents", "skills");
    mkdirSync(agentsSkills, { recursive: true });
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    mkdirSync(join(root, ".empty-agent"));
    mkdirSync(join(root, "not-hidden", "skills"), { recursive: true });
    mkdirSync(join(root, ".alias"));
    symlinkSync(agentsSkills, join(root, ".alias", "skills"), "dir");
    mkdirSync(join(agentsSkills, "container"));
    mkdirSync(join(root, ".inner"));
    symlinkSync(join(agentsSkills, "container"), join(root, ".inner", "skills"), "dir");

    expect(agentSkillDirs(root, agentsSkills)).toEqual([join(root, ".claude", "skills")]);
  });
});

describe("copiesBefore and markWrittenCopies", () => {
  // What drifts: which copies a `skills add` call wrote is the CLI's behavior (the canonical copy, or under
  // `--copy` the per-agent ones), told apart from copies that were already there by their SKILL.md mtime; a
  // canonical entry that is a symlink is another tool's wiring and must never be written through.
  const PAST = new Date(Date.now() - 60_000);
  function copyAt(dir: string, name: string): string {
    const copy = join(dir, name);
    mkdirSync(copy, { recursive: true });
    writeFileSync(join(copy, "SKILL.md"), `---\nname: ${name}\n---\nbody\n`);
    utimesSync(join(copy, "SKILL.md"), PAST, PAST);
    return copy;
  }
  const rewrite = (copy: string) => utimesSync(join(copy, "SKILL.md"), new Date(), new Date());

  test("marks the real copy the call wrote and leaves one it did not; nothing written is one notice", () => {
    const skills = temp.dir("install-shared-skills-");
    const alpha = copyAt(skills, "alpha-one");
    const before = copiesBefore("alpha-one", skills, dirname(dirname(skills)));
    rewrite(alpha);

    expect(markWrittenCopies(before)).toEqual({ marked: [alpha], notices: [] });
    expect(read(alpha, "SKILL.md")).toContain("disable-model-invocation: true");

    const untouched = copiesBefore("alpha-one", skills, dirname(dirname(skills)));
    expect(markWrittenCopies(untouched)).toEqual({
      marked: [],
      notices: [`no fresh copy at ${alpha} to mark explicit-invocation-only`],
    });
  });

  test("never writes through a symlinked canonical entry, and marks a per-agent real copy the call wrote", () => {
    const home = temp.dir("install-shared-home-");
    const skills = join(home, ".agents", "skills");
    mkdirSync(skills, { recursive: true });
    const foreign = copyAt(join(home, "foreign"), "alpha-one");
    symlinkSync(foreign, join(skills, "alpha-one"), "dir");
    const copied = copyAt(join(home, ".claude", "skills"), "alpha-one");
    const before = copiesBefore("alpha-one", skills, home);
    rewrite(foreign);
    rewrite(copied);

    expect(markWrittenCopies(before)).toEqual({
      marked: [copied],
      notices: [`${join(skills, "alpha-one")} is a symlink, left alone`],
    });
    expect(read(foreign, "SKILL.md")).toBe("---\nname: alpha-one\n---\nbody\n");
    expect(read(copied, "SKILL.md")).toContain("disable-model-invocation: true");
  });

  test("skips a per-agent symlink without a notice, and marks a copy that appeared during the call", () => {
    const home = temp.dir("install-shared-home-");
    const skills = join(home, ".agents", "skills");
    const linked = join(home, ".claude", "skills");
    mkdirSync(skills, { recursive: true });
    mkdirSync(linked, { recursive: true });
    const before = copiesBefore("alpha-one", skills, home);
    const alpha = copyAt(skills, "alpha-one");
    symlinkSync(alpha, join(linked, "alpha-one"), "dir");

    expect(markWrittenCopies(before)).toEqual({ marked: [alpha], notices: [] });
    expect(read(linked, "alpha-one/SKILL.md")).toContain("disable-model-invocation: true");
  });

  // A `--copy` install for an agent that had no skills directory yet creates it during the call.
  test("marks a copy in a per-agent directory the call itself created", () => {
    const home = temp.dir("install-shared-home-");
    const skills = join(home, ".agents", "skills");
    mkdirSync(skills, { recursive: true });
    const before = copiesBefore("alpha-one", skills, home);
    const copied = copyAt(join(home, ".claude", "skills"), "alpha-one");

    expect(markWrittenCopies(before)).toEqual({
      marked: [copied],
      notices: [],
    });
  });
});
