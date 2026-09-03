import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckFailure } from "../scripts/lib";
import { validateSkillDir } from "../scripts/validate-skills";

// Regression test for the metadata.internal guard: the npx skills CLI
// silently drops internal skills from installs and listings, so the key on a
// published skill makes it vanish for consumers while every repo gate stays
// green. The validator must reject the key under skills/ (template/ is the
// only place that carries it).

const base = mkdtempSync(join(tmpdir(), "validate-skills-test-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let fixture = 0;
// A minimal well-formed published skill folder; extraFrontmatter is spliced
// into the SKILL.md frontmatter verbatim.
function makeSkillDir(extraFrontmatter: string): string {
  fixture += 1;
  const dir = join(base, `fixture-${fixture}`, "my-skill");
  mkdirSync(join(dir, ".codex-plugin"), { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: my-skill\ndescription: Use when testing the validator.\n${extraFrontmatter}---\n\n# My Skill\n`,
  );
  writeFileSync(join(dir, "README.md"), "# My Skill\n");
  writeFileSync(join(dir, ".codex-plugin", "plugin.json"), `{ "name": "my-skill" }\n`);
  return dir;
}

describe("validateSkillDir metadata.internal guard", () => {
  test.each([
    ["true", "the marker template/ carries"],
    ["false", "key presence, not truthiness, is what bans it"],
  ])("metadata.internal: %s on a published skill fails naming the key (%s)", (value) => {
    const dir = makeSkillDir(`metadata:\n  internal: ${value}\n`);
    expect(() => validateSkillDir(dir)).toThrow(CheckFailure);
    expect(() => validateSkillDir(dir)).toThrow(/metadata\.internal/);
  });

  test("control: the same skill without the key passes", () => {
    const dir = makeSkillDir("metadata:\n  author: Vivswan\n");
    expect(() => validateSkillDir(dir)).not.toThrow();
  });
});
