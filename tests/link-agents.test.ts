import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckFailure } from "../scripts/lib";
import { linkSkills } from "../scripts/link-agents";

interface Fixture {
  readonly repoSkill: string;
  readonly agentsSkills: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "skills-link-test-"));
  const repoSkill = join(root, "repo", "skills", "demo-skill");
  mkdirSync(repoSkill, { recursive: true });
  writeFileSync(join(repoSkill, "SKILL.md"), "---\nname: demo-skill\n---\nbody\n");
  const agentsSkills = join(root, "agents-skills");
  mkdirSync(agentsSkills);
  return { repoSkill, agentsSkills };
}

describe("linkSkills", () => {
  test("replaces an installed copy with a symlink to the repo", () => {
    const { repoSkill, agentsSkills } = fixture();
    const installed = join(agentsSkills, "demo-skill");
    mkdirSync(installed);
    writeFileSync(join(installed, "SKILL.md"), "installed copy");

    const actions = linkSkills([repoSkill], agentsSkills);

    expect(actions).toEqual([{ skill: "demo-skill", kind: "linked" }]);
    expect(lstatSync(installed).isSymbolicLink()).toBe(true);
    expect(realpathSync(installed)).toBe(realpathSync(repoSkill));
  });

  test("creates a symlink when the skill was never installed", () => {
    const { repoSkill, agentsSkills } = fixture();

    const actions = linkSkills([repoSkill], agentsSkills);

    expect(actions).toEqual([{ skill: "demo-skill", kind: "created" }]);
    expect(readlinkSync(join(agentsSkills, "demo-skill"))).toBe(repoSkill);
  });

  test("is idempotent once linked", () => {
    const { repoSkill, agentsSkills } = fixture();
    linkSkills([repoSkill], agentsSkills);

    const actions = linkSkills([repoSkill], agentsSkills);

    expect(actions).toEqual([{ skill: "demo-skill", kind: "already-linked" }]);
  });

  test("repoints a symlink that targets somewhere else", () => {
    const { repoSkill, agentsSkills } = fixture();
    const stale = join(agentsSkills, "stale-target");
    mkdirSync(stale);
    symlinkSync(stale, join(agentsSkills, "demo-skill"), "dir");

    const actions = linkSkills([repoSkill], agentsSkills);

    expect(actions).toEqual([{ skill: "demo-skill", kind: "linked" }]);
    expect(realpathSync(join(agentsSkills, "demo-skill"))).toBe(realpathSync(repoSkill));
  });

  test("dry run reports actions without touching the filesystem", () => {
    const { repoSkill, agentsSkills } = fixture();
    const installed = join(agentsSkills, "demo-skill");
    mkdirSync(installed);
    writeFileSync(join(installed, "SKILL.md"), "installed copy");

    const actions = linkSkills([repoSkill], agentsSkills, true);

    expect(actions).toEqual([{ skill: "demo-skill", kind: "linked" }]);
    expect(lstatSync(installed).isDirectory()).toBe(true);
  });

  test("refuses to replace a directory without a SKILL.md", () => {
    const { repoSkill, agentsSkills } = fixture();
    mkdirSync(join(agentsSkills, "demo-skill"));

    expect(() => linkSkills([repoSkill], agentsSkills)).toThrow(CheckFailure);
  });

  test("refuses when the target is a plain file", () => {
    const { repoSkill, agentsSkills } = fixture();
    writeFileSync(join(agentsSkills, "demo-skill"), "not a skill");

    expect(() => linkSkills([repoSkill], agentsSkills)).toThrow(CheckFailure);
  });

  test("fails when the agents skills directory is missing", () => {
    const { repoSkill, agentsSkills } = fixture();

    expect(() => linkSkills([repoSkill], join(agentsSkills, "nope"))).toThrow(CheckFailure);
  });
});
