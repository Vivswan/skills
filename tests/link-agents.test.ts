import { describe, expect, test } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { CheckFailure } from "../scripts/lib";
import {
  discoverAgentSkillDirs,
  linkSkills,
  loadLockAttribution,
  type PruneAction,
  type PruneOptions,
  pruneStaleSkills,
  repoSourceIds,
} from "../scripts/link-agents";

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

function expectCheckFailure(run: () => unknown, message: RegExp): void {
  let thrown: unknown;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(CheckFailure);
  expect((thrown as CheckFailure).message).toMatch(message);
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

  test("dry run reports the relink and leaves an installed copy in place", () => {
    const { repoSkill, agentsSkills } = fixture();
    const installed = join(agentsSkills, "demo-skill");
    mkdirSync(installed);
    writeFileSync(join(installed, "SKILL.md"), "installed copy");

    const actions = linkSkills([repoSkill], agentsSkills, true);

    expect(actions).toEqual([{ skill: "demo-skill", kind: "linked" }]);
    expect(lstatSync(installed, { throwIfNoEntry: false })?.isDirectory()).toBe(true);
    expect(readFileSync(join(installed, "SKILL.md"), "utf-8")).toBe("installed copy");
  });

  test("dry run reports the repoint and leaves a foreign symlink in place", () => {
    const { repoSkill, agentsSkills } = fixture();
    const stale = join(agentsSkills, "stale-target");
    mkdirSync(stale);
    const target = join(agentsSkills, "demo-skill");
    symlinkSync(stale, target, "dir");

    const actions = linkSkills([repoSkill], agentsSkills, true);

    expect(actions).toEqual([{ skill: "demo-skill", kind: "linked" }]);
    expect(readlinkSync(target)).toBe(stale);
  });

  test("refuses to replace a directory without a SKILL.md", () => {
    const { repoSkill, agentsSkills } = fixture();
    const target = join(agentsSkills, "demo-skill");
    mkdirSync(target);

    expectCheckFailure(() => linkSkills([repoSkill], agentsSkills), /no SKILL\.md; refusing/);
    expect(lstatSync(target, { throwIfNoEntry: false })?.isDirectory()).toBe(true);
  });

  test("refuses when the target is a plain file", () => {
    const { repoSkill, agentsSkills } = fixture();
    const target = join(agentsSkills, "demo-skill");
    writeFileSync(target, "not a skill");

    expectCheckFailure(
      () => linkSkills([repoSkill], agentsSkills),
      /neither a directory nor a symlink/,
    );
    expect(lstatSync(target, { throwIfNoEntry: false })?.isFile()).toBe(true);
    expect(readFileSync(target, "utf-8")).toBe("not a skill");
  });

  test("fails when the agents skills directory is missing", () => {
    const { repoSkill, agentsSkills } = fixture();

    expectCheckFailure(() => linkSkills([repoSkill], join(agentsSkills, "nope")), /missing; run/);
  });
});

interface PruneFixture {
  readonly root: string;
  readonly repoSkills: string;
  readonly agentsSkills: string;
  readonly agentDir: string;
  readonly options: (overrides?: Partial<PruneOptions>) => PruneOptions;
}

function pruneFixture(): PruneFixture {
  const root = mkdtempSync(join(tmpdir(), "skills-prune-test-"));
  const repoSkills = join(root, "repo", "skills");
  const demoSkill = join(repoSkills, "demo-skill");
  mkdirSync(demoSkill, { recursive: true });
  writeFileSync(join(demoSkill, "SKILL.md"), "---\nname: demo-skill\n---\nbody\n");
  const agentsSkills = join(root, "agents-skills");
  mkdirSync(agentsSkills);
  const agentDir = join(root, "claude-skills");
  mkdirSync(agentDir);
  const options = (overrides: Partial<PruneOptions> = {}): PruneOptions => ({
    repoSkillsDir: repoSkills,
    currentSkills: new Set(["demo-skill"]),
    agentsSkillsDir: agentsSkills,
    agentSkillDirs: [agentDir],
    lockAttribution: new Map(),
    ...overrides,
  });
  return { root, repoSkills, agentsSkills, agentDir, options };
}

function installedCopy(dir: string, name: string): string {
  const copy = join(dir, name);
  mkdirSync(copy);
  writeFileSync(join(copy, "SKILL.md"), "installed copy");
  return copy;
}

function entryExists(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

describe("pruneStaleSkills", () => {
  test("prunes a dangling symlink into this repo", () => {
    const { repoSkills, agentsSkills, options } = pruneFixture();
    const stale = join(agentsSkills, "retired-skill");
    symlinkSync(join(repoSkills, "retired-skill"), stale, "dir");

    const actions = pruneStaleSkills(options());

    expect(actions).toEqual([
      { path: stale, kind: "pruned", reason: expect.stringContaining("dangling symlink") },
    ]);
    expect(entryExists(stale)).toBe(false);
  });

  test("prunes a this-repo symlink whose name is no longer a current skill", () => {
    const { repoSkills, agentsSkills, options } = pruneFixture();
    const renamed = join(agentsSkills, "old-name");
    symlinkSync(join(repoSkills, "demo-skill"), renamed, "dir");

    const actions = pruneStaleSkills(options());

    expect(actions).toEqual([
      { path: renamed, kind: "pruned", reason: expect.stringContaining("not a current skill") },
    ]);
    expect(entryExists(renamed)).toBe(false);
  });

  test("a live symlink for a current skill survives", () => {
    const { repoSkills, agentsSkills, options } = pruneFixture();
    const linked = join(agentsSkills, "demo-skill");
    symlinkSync(join(repoSkills, "demo-skill"), linked, "dir");

    const actions = pruneStaleSkills(options());

    expect(actions).toEqual([]);
    expect(realpathSync(linked)).toBe(realpathSync(join(repoSkills, "demo-skill")));
  });

  test("never touches a foreign symlink, even a dangling one", () => {
    const { root, agentsSkills, options } = pruneFixture();
    const foreignLive = join(root, "other-repo", "skills", "their-skill");
    mkdirSync(foreignLive, { recursive: true });
    const live = join(agentsSkills, "their-skill");
    symlinkSync(foreignLive, live, "dir");
    const dangling = join(agentsSkills, "their-gone-skill");
    symlinkSync(join(root, "other-repo", "skills", "their-gone-skill"), dangling, "dir");

    const actions = pruneStaleSkills(options());

    expect(actions).toEqual([]);
    expect(entryExists(live)).toBe(true);
    expect(entryExists(dangling)).toBe(true);
  });

  test("never touches a copy the lockfile attributes to another repo", () => {
    const { agentsSkills, options } = pruneFixture();
    const foreign = installedCopy(agentsSkills, "their-skill");

    const actions = pruneStaleSkills(
      options({ lockAttribution: new Map([["their-skill", "foreign" as const]]) }),
    );

    expect(actions).toEqual([]);
    expect(entryExists(foreign)).toBe(true);
  });

  test("keeps and reports a copy with conflicting lockfile identity", () => {
    const { agentsSkills, options } = pruneFixture();
    const conflicted = installedCopy(agentsSkills, "conflicted");

    const actions = pruneStaleSkills(
      options({ lockAttribution: new Map([["conflicted", "unknown" as const]]) }),
    );

    expect(actions).toEqual([
      { path: conflicted, kind: "kept", reason: expect.stringContaining("conflicting") },
    ]);
    expect(entryExists(conflicted)).toBe(true);
  });

  test("keeps and reports a copy with no lockfile attribution", () => {
    const { agentsSkills, options } = pruneFixture();
    const orphan = installedCopy(agentsSkills, "who-knows");

    const actions = pruneStaleSkills(options());

    expect(actions).toEqual([
      { path: orphan, kind: "kept", reason: expect.stringContaining("cannot attribute") },
    ]);
    expect(entryExists(orphan)).toBe(true);
  });

  test("prunes a copy of a retired skill the lockfile attributes to this repo", () => {
    const { agentsSkills, options } = pruneFixture();
    const retired = installedCopy(agentsSkills, "retired-skill");

    const actions = pruneStaleSkills(
      options({ lockAttribution: new Map([["retired-skill", "ours" as const]]) }),
    );

    expect(actions).toEqual([
      { path: retired, kind: "pruned", reason: expect.stringContaining("retired skill") },
    ]);
    expect(entryExists(retired)).toBe(false);
  });

  test("keeps a copy of a skill the repo still ships", () => {
    const { agentsSkills, options } = pruneFixture();
    const current = installedCopy(agentsSkills, "demo-skill");

    const actions = pruneStaleSkills(
      options({ lockAttribution: new Map([["demo-skill", "ours" as const]]) }),
    );

    expect(actions).toEqual([]);
    expect(entryExists(current)).toBe(true);
  });

  test("ignores plain files like .DS_Store", () => {
    const { agentsSkills, options } = pruneFixture();
    writeFileSync(join(agentsSkills, ".DS_Store"), "junk");

    expect(pruneStaleSkills(options())).toEqual([]);
    expect(entryExists(join(agentsSkills, ".DS_Store"))).toBe(true);
  });

  test("prunes a symlink dangling several levels below this repo's skills dir", () => {
    const { repoSkills, agentsSkills, options } = pruneFixture();
    const stale = join(agentsSkills, "retired-skill");
    symlinkSync(join(repoSkills, "retired-skill", "nested"), stale, "dir");

    const actions = pruneStaleSkills(options());

    expect(actions).toEqual([
      { path: stale, kind: "pruned", reason: expect.stringContaining("dangling symlink") },
    ]);
    expect(entryExists(stale)).toBe(false);
  });

  test("dry run reports would-prune and removes nothing", () => {
    const { repoSkills, agentsSkills, agentDir, options } = pruneFixture();
    const staleLink = join(agentsSkills, "retired-skill");
    symlinkSync(join(repoSkills, "retired-skill"), staleLink, "dir");
    const staleCopy = installedCopy(agentsSkills, "retired-copy");
    const agentLink = join(agentDir, "retired-skill");
    symlinkSync(staleLink, agentLink, "dir");
    const gonePointer = join(agentDir, "gone-skill");
    symlinkSync(join(agentsSkills, "gone-skill"), gonePointer, "dir");

    const actions = pruneStaleSkills(
      options({
        lockAttribution: new Map([
          ["retired-copy", "ours" as const],
          ["gone-skill", "ours" as const],
        ]),
        dryRun: true,
      }),
    );

    expect(actions).toEqual([
      { path: staleCopy, kind: "would-prune", reason: expect.stringContaining("retired skill") },
      { path: staleLink, kind: "would-prune", reason: expect.stringContaining("dangling symlink") },
      {
        path: gonePointer,
        kind: "would-prune",
        reason: expect.stringContaining("dangling pointer"),
      },
      { path: agentLink, kind: "would-prune", reason: expect.stringContaining("pruned canonical") },
    ]);
    expect(entryExists(staleLink)).toBe(true);
    expect(entryExists(staleCopy)).toBe(true);
    expect(entryExists(agentLink)).toBe(true);
    expect(entryExists(gonePointer)).toBe(true);
  });

  test("cleans the per-agent pointer left behind by a canonical prune", () => {
    const { repoSkills, agentsSkills, agentDir, options } = pruneFixture();
    const staleCanonical = join(agentsSkills, "retired-skill");
    symlinkSync(join(repoSkills, "retired-skill"), staleCanonical, "dir");
    const agentLink = join(agentDir, "retired-skill");
    // Relative link, matching how npx skills wires e.g. ~/.claude/skills.
    symlinkSync(relative(agentDir, staleCanonical), agentLink, "dir");

    const actions = pruneStaleSkills(options());

    expect(actions).toEqual([
      { path: staleCanonical, kind: "pruned", reason: expect.stringContaining("dangling") },
      { path: agentLink, kind: "pruned", reason: expect.stringContaining("pruned canonical") },
    ]);
    expect(entryExists(agentLink)).toBe(false);
  });

  test("cleans a per-agent pointer already dangling into an attributed missing entry", () => {
    const { agentsSkills, agentDir, options } = pruneFixture();
    const agentLink = join(agentDir, "retired-skill");
    symlinkSync(join(agentsSkills, "retired-skill"), agentLink, "dir");

    const actions = pruneStaleSkills(
      options({ lockAttribution: new Map([["retired-skill", "ours" as const]]) }),
    );

    expect(actions).toEqual([
      { path: agentLink, kind: "pruned", reason: expect.stringContaining("dangling pointer") },
    ]);
    expect(entryExists(agentLink)).toBe(false);
  });

  test("keeps and reports a dangling per-agent pointer it cannot attribute", () => {
    const { agentsSkills, agentDir, options } = pruneFixture();
    const agentLink = join(agentDir, "who-knows");
    symlinkSync(join(agentsSkills, "who-knows"), agentLink, "dir");

    const actions = pruneStaleSkills(options());

    expect(actions).toEqual([
      { path: agentLink, kind: "kept", reason: expect.stringContaining("cannot attribute") },
    ]);
    expect(entryExists(agentLink)).toBe(true);
  });

  test("leaves per-agent pointers to live foreign skills and to elsewhere alone", () => {
    const { root, agentsSkills, agentDir, options } = pruneFixture();
    const foreignCopy = installedCopy(agentsSkills, "their-skill");
    const foreignPointer = join(agentDir, "their-skill");
    symlinkSync(foreignCopy, foreignPointer, "dir");
    const unrelated = join(agentDir, "unrelated");
    symlinkSync(join(root, "somewhere-else", "gone"), unrelated, "dir");

    const actions = pruneStaleSkills(options());

    // The foreign copy itself is reported (no lockfile entry), never removed.
    expect(actions).toEqual([
      { path: foreignCopy, kind: "kept", reason: expect.stringContaining("cannot attribute") },
    ]);
    expect(entryExists(foreignPointer)).toBe(true);
    expect(entryExists(unrelated)).toBe(true);
  });

  test("never touches a pointer into a nested path below the canonical dir", () => {
    const { repoSkills, agentsSkills, agentDir, options } = pruneFixture();
    // Canonical "retired-skill" gets pruned this run...
    const staleCanonical = join(agentsSkills, "retired-skill");
    symlinkSync(join(repoSkills, "retired-skill"), staleCanonical, "dir");
    // ...but this pointer targets a same-named entry nested in a foreign tree.
    const nestedForeign = join(agentsSkills, "foreign-container", "retired-skill");
    mkdirSync(nestedForeign, { recursive: true });
    const nestedPointer = join(agentDir, "retired-skill");
    symlinkSync(nestedForeign, nestedPointer, "dir");

    const actions = pruneStaleSkills(options());

    expect(actions).toEqual([
      {
        path: join(agentsSkills, "foreign-container"),
        kind: "kept",
        reason: expect.stringContaining("cannot attribute"),
      },
      { path: staleCanonical, kind: "pruned", reason: expect.stringContaining("dangling") },
    ]);
    expect(entryExists(nestedPointer)).toBe(true);
  });

  test("streams actions through onAction so earlier removals stay reported after a failure", () => {
    const { repoSkills, agentsSkills, options } = pruneFixture();
    const first = join(agentsSkills, "a-retired");
    symlinkSync(join(repoSkills, "a-retired"), first, "dir");
    const second = join(agentsSkills, "b-retired");
    symlinkSync(join(repoSkills, "b-retired"), second, "dir");

    const seen: PruneAction[] = [];
    let atFirstReport: { first: boolean; second: boolean } | undefined;
    expect(() =>
      pruneStaleSkills(
        options({
          onAction: (action) => {
            seen.push(action);
            if (seen.length === 1) {
              atFirstReport = { first: entryExists(first), second: entryExists(second) };
            }
            if (seen.length === 2) throw new Error("downstream failure");
          },
        }),
      ),
    ).toThrow("downstream failure");

    expect(seen).toEqual([
      { path: first, kind: "pruned", reason: expect.stringContaining("dangling symlink") },
      { path: second, kind: "pruned", reason: expect.stringContaining("dangling symlink") },
    ]);
    // When the first removal was reported, the sweep had not yet reached the second entry.
    expect(atFirstReport).toEqual({ first: false, second: true });
    expect(entryExists(first)).toBe(false);
    expect(entryExists(second)).toBe(false);
  });

  test("dry run and real run agree when a stale canonical link has a live target", () => {
    const { repoSkills, agentsSkills, agentDir, options } = pruneFixture();
    const setup = () => {
      const staleCanonical = join(agentsSkills, "old-name");
      symlinkSync(join(repoSkills, "demo-skill"), staleCanonical, "dir");
      const pointer = join(agentDir, "old-name");
      symlinkSync(staleCanonical, pointer, "dir");
      return { staleCanonical, pointer };
    };

    const { staleCanonical, pointer } = setup();
    const dryActions = pruneStaleSkills(options({ dryRun: true }));
    expect(dryActions).toEqual([
      { path: staleCanonical, kind: "would-prune", reason: expect.any(String) },
      { path: pointer, kind: "would-prune", reason: expect.any(String) },
    ]);
    expect(entryExists(staleCanonical)).toBe(true);
    expect(entryExists(pointer)).toBe(true);

    const realActions = pruneStaleSkills(options());
    expect(realActions.map((action) => [action.path, action.kind])).toEqual([
      [staleCanonical, "pruned"],
      [pointer, "pruned"],
    ]);
    expect(entryExists(staleCanonical)).toBe(false);
    expect(entryExists(pointer)).toBe(false);
  });
});

describe("discoverAgentSkillDirs", () => {
  test("finds dot-dir skills directories and skips the canonical one", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-discover-test-"));
    const agentsSkills = join(root, ".agents", "skills");
    mkdirSync(agentsSkills, { recursive: true });
    mkdirSync(join(root, ".claude", "skills"), { recursive: true });
    mkdirSync(join(root, ".empty-agent"));
    mkdirSync(join(root, "not-hidden", "skills"), { recursive: true });

    expect(discoverAgentSkillDirs(root, agentsSkills)).toEqual([join(root, ".claude", "skills")]);
  });
});

describe("lockfile attribution", () => {
  const repoIds = repoSourceIds("https://github.com/Vivswan/skills");

  test.each([
    {
      id: "https",
      url: "https://github.com/Vivswan/skills",
      urlId: "https://github.com/vivswan/skills",
    },
    {
      id: "https with .git suffix",
      url: "https://github.com/Vivswan/skills.git",
      urlId: "https://github.com/vivswan/skills",
    },
    {
      id: "https with trailing slash",
      url: "https://github.com/Vivswan/skills/",
      urlId: "https://github.com/vivswan/skills",
    },
    {
      id: "ssh form keeps its scheme",
      url: "git@github.com:Vivswan/skills.git",
      urlId: "git@github.com:vivswan/skills",
    },
  ])("derives exactly the normalized URL and owner/repo slug ids: $id", ({ url, urlId }) => {
    expect(repoSourceIds(url)).toEqual(new Set([urlId, "vivswan/skills"]));
  });

  test("attributes by source slug or sourceUrl, case- and .git-insensitive", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-lock-test-"));
    const lockfile = join(root, ".skill-lock.json");
    writeFileSync(
      lockfile,
      JSON.stringify({
        version: 3,
        skills: {
          "ours-by-slug": { source: "Vivswan/skills", sourceUrl: "" },
          "ours-by-url": { sourceUrl: "https://github.com/Vivswan/skills.git" },
          "theirs": { source: "vercel-labs/skills" },
          "conflicting": {
            source: "Vivswan/skills",
            sourceUrl: "https://github.com/someone-else/skills.git",
          },
          "malformed-identity": { source: "Vivswan/skills", sourceUrl: { nested: true } },
          "no-identity": { installedAt: "2026-01-01T00:00:00.000Z" },
          "malformed": "not an object",
        },
      }),
    );

    const attribution = loadLockAttribution(lockfile, repoIds);

    expect(attribution.get("ours-by-slug")).toBe("ours");
    expect(attribution.get("ours-by-url")).toBe("ours");
    expect(attribution.get("theirs")).toBe("foreign");
    expect(attribution.get("conflicting")).toBe("unknown");
    expect(attribution.get("malformed-identity")).toBe("unknown");
    expect(attribution.get("no-identity")).toBe("unknown");
    expect(attribution.get("malformed")).toBe("unknown");
    expect(attribution.get("not-installed")).toBeUndefined();
  });

  test("a missing lockfile yields no attributions", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-lock-test-"));

    expect(loadLockAttribution(join(root, "nope.json"), repoIds).size).toBe(0);
  });

  test("a malformed lockfile fails instead of guessing", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-lock-test-"));
    const lockfile = join(root, ".skill-lock.json");
    writeFileSync(lockfile, "not json");

    expect(() => loadLockAttribution(lockfile, repoIds)).toThrow(CheckFailure);
  });

  test("a drifted lockfile shape fails instead of guessing", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-lock-test-"));
    const lockfile = join(root, ".skill-lock.json");
    writeFileSync(lockfile, JSON.stringify({ version: 3, skills: ["flat", "list"] }));

    expect(() => loadLockAttribution(lockfile, repoIds)).toThrow(CheckFailure);
  });

  test("an unsupported lockfile version fails instead of guessing", () => {
    const root = mkdtempSync(join(tmpdir(), "skills-lock-test-"));
    const lockfile = join(root, ".skill-lock.json");
    writeFileSync(
      lockfile,
      JSON.stringify({ version: 4, skills: { "ours": { source: "Vivswan/skills" } } }),
    );

    expect(() => loadLockAttribution(lockfile, repoIds)).toThrow(CheckFailure);
  });
});
