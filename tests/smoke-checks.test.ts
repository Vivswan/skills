import { describe, expect, test } from "bun:test";
import {
  checkDescriptionTriggerForm,
  checkExplicitInvocationPairing,
  checkMarketplacePluginVersionBan,
  checkReadmeInvocationGrouping,
  checkReadmeMermaidGraph,
  checkReadmeSkillList,
  checkReadmeUsageExplicitRoster,
  checkSkillDependencies,
  checkSkillScripts,
  ensureBuiltTemplate,
  type SkillDependencyLayout,
} from "../scripts/smoke-checks";
import { expectCheckFailure } from "./helpers/check-failure";

function readme(listArea: string): string {
  return `# Skills\n\n## Available Skills\n${listArea}\n## Installation\n\ntext\n`;
}

describe("checkDescriptionTriggerForm", () => {
  test("accepts a trigger-form description", () => {
    expect(() =>
      checkDescriptionTriggerForm("skills/x/SKILL.md", {
        description: "Use when pushing commits.",
      }),
    ).not.toThrow();
  });

  test.each([
    { id: "summary form", frontmatter: { description: "A skill that watches CI." } },
    {
      id: "bare 'Use when ' with no trigger",
      frontmatter: { description: "Use when " },
      reason: "a summary-shaped dodge that matches the prefix and says nothing",
    },
    { id: "missing description", frontmatter: {} },
  ])("rejects a description that is not trigger-form: $id", ({ id, frontmatter }) => {
    expectCheckFailure(
      () => checkDescriptionTriggerForm("skills/x/SKILL.md", frontmatter),
      /skills\/x\/SKILL\.md: description must be trigger-form, starting with "Use when \.\.\."/,
      id,
    );
  });
});

describe("checkExplicitInvocationPairing", () => {
  function input(frontmatter: Record<string, unknown>, openaiYamlText: string | undefined) {
    return {
      skillMdPath: "skills/x/SKILL.md",
      frontmatter,
      openaiYamlPath: "skills/x/agents/openai.yaml",
      openaiYamlText,
    };
  }
  const disabledYaml = "policy:\n  allow_implicit_invocation: false\n";
  const interfaceOnlyYaml = 'interface:\n  display_name: "X"\n';

  test("accepts both halves set", () => {
    expect(() =>
      checkExplicitInvocationPairing(input({ "disable-model-invocation": true }, disabledYaml)),
    ).not.toThrow();
  });

  test("accepts neither half set", () => {
    expect(() => checkExplicitInvocationPairing(input({}, interfaceOnlyYaml))).not.toThrow();
    expect(() => checkExplicitInvocationPairing(input({}, undefined))).not.toThrow();
  });

  test("rejects frontmatter-only declaration", () => {
    expect(() =>
      checkExplicitInvocationPairing(
        input({ "disable-model-invocation": true }, interfaceOnlyYaml),
      ),
    ).toThrow(/every agent or none/);
  });

  test("rejects yaml-only declaration", () => {
    expect(() => checkExplicitInvocationPairing(input({}, disabledYaml))).toThrow(
      /every agent or none/,
    );
  });

  test("rejects a quoted-string frontmatter boolean", () => {
    expect(() =>
      checkExplicitInvocationPairing(input({ "disable-model-invocation": "true" }, disabledYaml)),
    ).toThrow(/disable-model-invocation must be a plain YAML boolean/);
  });

  test("rejects a quoted-string policy boolean", () => {
    expect(() =>
      checkExplicitInvocationPairing(
        input(
          { "disable-model-invocation": true },
          'policy:\n  allow_implicit_invocation: "false"\n',
        ),
      ),
    ).toThrow(/allow_implicit_invocation must be a plain YAML boolean/);
  });

  test("rejects invalid YAML", () => {
    expect(() =>
      checkExplicitInvocationPairing(input({ "disable-model-invocation": true }, "policy: [\n")),
    ).toThrow(/invalid YAML/);
  });
});

describe("checkReadmeSkillList", () => {
  const names: ReadonlySet<string> = new Set(["alpha-one", "beta-two"]);
  const goodList =
    "\n- [/alpha-one](./skills/alpha-one/SKILL.md) - a\n- [/beta-two](./skills/beta-two/SKILL.md) - b\n";

  test("accepts an exact bijection", () => {
    expect(() => checkReadmeSkillList(readme(goodList), names)).not.toThrow();
  });

  test("rejects a missing entry", () => {
    const list = "\n- [/alpha-one](./skills/alpha-one/SKILL.md) - a\n";
    expect(() => checkReadmeSkillList(readme(list), names)).toThrow(/missing an entry/);
  });

  test("rejects a stale entry without a folder", () => {
    const list = `${goodList}- [/gamma-three](./skills/gamma-three/SKILL.md) - c\n`;
    expect(() => checkReadmeSkillList(readme(list), names)).toThrow(/no matching/);
  });

  test("rejects a wrong link target", () => {
    const list =
      "\n- [/alpha-one](./skills/beta-two/SKILL.md) - a\n- [/beta-two](./skills/beta-two/SKILL.md) - b\n";
    expect(() => checkReadmeSkillList(readme(list), names)).toThrow(/must link/);
  });

  test("rejects a duplicate entry", () => {
    expect(() => checkReadmeSkillList(readme(goodList + goodList), names)).toThrow(/duplicate/);
  });

  test("leaves non-kebab-case prose bullets alone", () => {
    const list = `${goodList}- [Installation](./docs/install.md) - prose link\n`;
    expect(() => checkReadmeSkillList(readme(list), names)).not.toThrow();
  });

  test("ignores bullets inside fenced blocks and comments", () => {
    const list = `${goodList}\n\`\`\`text\n- [/gamma-three](./skills/gamma-three/) - hidden\n\`\`\`\n<!-- - [/delta-four](./skills/delta-four/) - hidden -->\n`;
    expect(() => checkReadmeSkillList(readme(list), names)).not.toThrow();
  });

  test("strips comment sequences that reassemble after one pass", () => {
    const list = `${goodList}<!-<!-- x -->-\n- [/gamma-three](./skills/gamma-three/) - hidden\n-->\n`;
    expect(() => checkReadmeSkillList(readme(list), names)).not.toThrow();
  });

  test("rejects a README without the section", () => {
    expect(() => checkReadmeSkillList("# Skills\n", names)).toThrow(/Available Skills/);
  });
});

describe("checkReadmeMermaidGraph", () => {
  const names: ReadonlySet<string> = new Set(["alpha-one", "beta-two"]);
  function withGraph(graphBody: string): string {
    return `# Skills\n\ntext\n\n\`\`\`mermaid\n${graphBody}\`\`\`\n\n## Installation\n`;
  }
  const clicks =
    '  click a "./skills/alpha-one/SKILL.md"\n  click b "./skills/beta-two/SKILL.md"\n';
  const goodGraph = `graph LR\n  a["/alpha-one"] --> b["/beta-two"]\n${clicks}`;

  test("accepts a consistent graph", () => {
    expect(() => checkReadmeMermaidGraph(withGraph(goodGraph), names)).not.toThrow();
  });

  test("accepts a bare alias used before its labeled definition", () => {
    const graph = `graph LR\n  a["/alpha-one"] --> b\n  b["/beta-two"] --> a\n${clicks}`;
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).not.toThrow();
  });

  test("ignores layout frontmatter and reads both endpoints of a bidirectional edge", () => {
    const graph = `---\nconfig:\n  layout: elk\n---\ngraph LR\n  a["/alpha-one"] <--> b["/beta-two"]\n${clicks}`;
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).not.toThrow();
  });

  test("rejects 'end' as a node alias (reserved flowchart keyword)", () => {
    // Mermaid silently breaks the rendering on an 'end' node instead of
    // erroring, so without this check the graph passes and does not draw.
    const graph = `${goodGraph}  end["/beta-two"]\n`;
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(/reserved/);
  });
});

describe("checkReadmeInvocationGrouping", () => {
  const area =
    "### Automatic\n\n- [/alpha-one](./skills/alpha-one/) - a\n\n### Invoked by you\n\n- [/beta-two](./skills/beta-two/) - b\n";

  test("accepts a grouping that matches the flags", () => {
    expect(() =>
      checkReadmeInvocationGrouping(readme(area), [
        { name: "alpha-one", disabled: false },
        { name: "beta-two", disabled: true },
      ]),
    ).not.toThrow();
  });

  test("rejects a disabled skill listed under Automatic", () => {
    expectCheckFailure(
      () => checkReadmeInvocationGrouping(readme(area), [{ name: "alpha-one", disabled: true }]),
      /'alpha-one' must be listed under 'Invoked by you'/,
    );
  });

  test("rejects an automatic skill listed under Invoked by you", () => {
    expectCheckFailure(
      () => checkReadmeInvocationGrouping(readme(area), [{ name: "beta-two", disabled: false }]),
      /'beta-two' must be listed under 'Automatic'/,
    );
  });

  test("rejects a README without the Invoked by you subsection", () => {
    expect(() => checkReadmeInvocationGrouping(readme("### Automatic\n"), [])).toThrow(
      /Invoked by you/,
    );
  });

  test("ignores entries inside fenced blocks when grouping", () => {
    const fenced = `${area}\n\`\`\`mermaid\n- [/alpha-one](./skills/alpha-one/) - hidden\n\`\`\`\n`;
    expect(() =>
      checkReadmeInvocationGrouping(readme(fenced), [{ name: "alpha-one", disabled: false }]),
    ).not.toThrow();
  });
});

describe("checkMarketplacePluginVersionBan", () => {
  test("accepts plugins without a version field", () => {
    expect(() =>
      checkMarketplacePluginVersionBan(".claude-plugin/marketplace.json", [
        { name: "vivswan-skills", source: "./" },
      ]),
    ).not.toThrow();
  });

  test("rejects a version on a plugins[] entry", () => {
    // metadata.version is the catalog's single source of truth; a second
    // version on the plugin entry passed every other check and only drifted.
    expect(() =>
      checkMarketplacePluginVersionBan(".claude-plugin/marketplace.json", [
        { name: "vivswan-skills", source: "./", version: "9.9.9" },
      ]),
    ).toThrow(/single.*source of truth/s);
  });
});

describe("checkReadmeUsageExplicitRoster", () => {
  function usageReadme(roster: string): string {
    return `# Skills\n\n## Usage\n\nSkills marked explicit-invocation-only (${roster}) load only when you invoke them (e.g. [\`/beta-two\`](./skills/beta-two/SKILL.md) in Claude Code).\n`;
  }
  const skills = [
    { name: "alpha-one", disabled: false },
    { name: "beta-two", disabled: true },
  ];

  test("accepts a roster naming exactly the disabled skills", () => {
    expect(() =>
      checkReadmeUsageExplicitRoster(
        usageReadme("[`/beta-two`](./skills/beta-two/SKILL.md)"),
        skills,
      ),
    ).not.toThrow();
  });

  test("negative control: a roster missing a disabled skill fails", () => {
    expect(() =>
      checkReadmeUsageExplicitRoster(usageReadme("[`/alpha-one`](./skills/alpha-one/SKILL.md)"), [
        { name: "alpha-one", disabled: true },
        { name: "beta-two", disabled: true },
      ]),
    ).toThrow(/missing 'beta-two'/);
  });

  test("rejects a roster naming an automatic skill", () => {
    expect(() =>
      checkReadmeUsageExplicitRoster(
        usageReadme(
          "[`/alpha-one`](./skills/alpha-one/SKILL.md), [`/beta-two`](./skills/beta-two/SKILL.md)",
        ),
        skills,
      ),
    ).toThrow(/does not set disable-model-invocation/);
  });

  test("rejects a roster naming a skill that is not published", () => {
    expect(() =>
      checkReadmeUsageExplicitRoster(
        usageReadme(
          "[`/beta-two`](./skills/beta-two/SKILL.md), [`/gamma-three`](./skills/gamma-three/SKILL.md)",
        ),
        skills,
      ),
    ).toThrow(/not a published skill/);
  });

  const hiddenSentence =
    "Skills marked explicit-invocation-only ([`/beta-two`](./skills/beta-two/SKILL.md)) load only when you invoke them.";

  test.each([
    {
      id: "the marker sentence was rewritten away",
      text: "# Skills\n\n## Usage\n\nAll skills load lazily.\n",
    },
    {
      id: "the sentence sits inside a backtick-fenced block",
      text: `# Skills\n\n## Usage\n\nAll skills load lazily.\n\n\`\`\`text\n${hiddenSentence}\n\`\`\`\n`,
      reason: "a code example is not the Usage prose",
    },
    {
      id: "the sentence sits inside a tilde-fenced block",
      text: `# Skills\n\n## Usage\n\nAll skills load lazily.\n\n~~~text\n${hiddenSentence}\n~~~\n`,
      reason:
        "CommonMark fences come in both flavors; stripping only backticks let ~~~ satisfy the check",
    },
    {
      id: "the sentence is outside the Usage section",
      text: `# Skills\n\n## About\n\n${hiddenSentence}\n\n## Usage\n\nAll skills load lazily.\n`,
    },
  ])("rejects a README missing the Usage marker sentence: $id", ({ id, text }) => {
    expectCheckFailure(
      () => checkReadmeUsageExplicitRoster(text, skills),
      /the Usage section is missing the sentence/,
      id,
    );
  });

  test("rejects unrecognized text inside the roster instead of ignoring it", () => {
    // The link scan alone failed open: '**/ghost-skill**' is not a link, so
    // it contributed nothing and the roster still passed. Every entry must
    // parse or the check fails.
    expect(() =>
      checkReadmeUsageExplicitRoster(
        usageReadme("[`/beta-two`](./skills/beta-two/SKILL.md), **/ghost-skill**"),
        skills,
      ),
    ).toThrow(/cannot parse Usage explicit-invocation-only roster entry '\*\*\/ghost-skill\*\*'/);
  });

  test("rejects a roster link whose target names a different skill", () => {
    expect(() =>
      checkReadmeUsageExplicitRoster(
        usageReadme("[`/beta-two`](./skills/alpha-one/SKILL.md)"),
        skills,
      ),
    ).toThrow(/cannot parse/);
  });

  test("rejects a duplicate roster entry", () => {
    expect(() =>
      checkReadmeUsageExplicitRoster(
        usageReadme(
          "[`/beta-two`](./skills/beta-two/SKILL.md), [`/beta-two`](./skills/beta-two/SKILL.md)",
        ),
        skills,
      ),
    ).toThrow(/duplicate/);
  });
});

describe("checkSkillDependencies", () => {
  // What drifts: the skill's package.json is the list bun installs before a script's bundle is built, and the
  // root devDependency at the same version is what tsc checks; nothing else in the repository holds the two
  // together, and a lockfile or node_modules under a skill is generated state the layout forbids.
  function layout(overrides: Partial<SkillDependencyLayout> = {}): SkillDependencyLayout {
    return {
      skillPath: "skills/x",
      manifestPaths: ["skills/x/package.json"],
      nodeModulesPaths: [],
      lockfilePaths: [],
      manifest: { name: "x-dependencies", private: true, dependencies: { left: "1.2.3" } },
      rootDevDependencies: { left: "1.2.3" },
      ...overrides,
    };
  }

  test("accepts exact pins and returns the declared names", () => {
    const pins = { left: "1.0.0-beta.2", "@scope/right": "2.0.0+build.7" };
    expect(
      checkSkillDependencies(
        layout({ manifest: { dependencies: pins }, rootDevDependencies: pins }),
      ),
    ).toEqual(new Set(["left", "@scope/right"]));
  });

  test("rejects a range with a message naming the rule", () => {
    expectCheckFailure(
      () => checkSkillDependencies(layout({ manifest: { dependencies: { left: "^1.2.3" } } })),
      /^skills\/x\/package\.json: dependencies entry 'left' is "\^1\.2\.3" .* exact version/,
    );
  });

  test.each<[kind: string, version: unknown]>([
    ["a tilde range", "~1.2.0"],
    ["an x-range", "1.x"],
    ["a partial version", "1.2"],
    ["a compound range", ">=1.0.0 <2.0.0"],
    ["a dist-tag", "latest"],
    ["a star", "*"],
    ["an empty string", ""],
    ["a leading v", "v1.2.3"],
    ["a git specifier", "github:oven-sh/bun#v1.2.3"],
    ["a git URL", "git+https://example.com/left.git#1.2.3"],
    ["a file specifier", "file:../left"],
    ["an npm alias", "npm:other@1.2.3"],
    ["a workspace specifier", "workspace:*"],
    ["a JSON number", 1],
  ])("rejects %s as a version", (_kind, version) => {
    expectCheckFailure(
      () => checkSkillDependencies(layout({ manifest: { dependencies: { left: version } } })),
      /dependencies entry 'left' is .* exact version/,
    );
  });

  test.each<[state: string, rootDevDependencies: Record<string, unknown>, detail: RegExp]>([
    ["pins another version", { left: "1.2.4" }, /devDependencies pin "1\.2\.4"/],
    ["lacks the package", {}, /devDependencies do not list it/],
  ])("rejects a pin the root package.json %s", (_state, rootDevDependencies, detail) => {
    expectCheckFailure(
      () => checkSkillDependencies(layout({ rootDevDependencies })),
      /^skills\/x\/package\.json: dependencies entry 'left' is 1\.2\.3 but the root package\.json/,
    );
    expectCheckFailure(() => checkSkillDependencies(layout({ rootDevDependencies })), detail);
  });

  test.each(["devDependencies", "optionalDependencies", "peerDependencies"])(
    "rejects a pin under %s: a skill's pins are one list",
    (field) => {
      expectCheckFailure(
        () =>
          checkSkillDependencies(
            layout({ manifest: { dependencies: { left: "1.2.3" }, [field]: { right: "1.0.0" } } }),
          ),
        new RegExp(
          `^skills/x/package\\.json: ${field}: a skill declares its packages under dependencies only`,
        ),
      );
    },
  );

  test.each<[reason: string, overrides: Partial<SkillDependencyLayout>, message: RegExp]>([
    [
      "a package.json that declares no dependency",
      { manifest: { name: "x-dependencies", private: true } },
      /^skills\/x\/package\.json: declares no dependency; a skill without dependencies ships no package\.json/,
    ],
    [
      "a package.json below the skill root",
      { manifestPaths: ["skills/x/package.json", "skills/x/scripts/package.json"] },
      /^skills\/x\/scripts\/package\.json: a skill's package\.json sits at skills\/x\/package\.json, nowhere deeper/,
    ],
    [
      "a node_modules directory under the skill",
      { nodeModulesPaths: ["skills/x/node_modules"] },
      /^skills\/x\/node_modules: node_modules under a skill folder; a script installs its pins for the build's duration only/,
    ],
    [
      "a lockfile under the skill",
      { lockfilePaths: ["skills/x/bun.lock"] },
      /^skills\/x\/bun\.lock: a lockfile under a skill folder; the exact pins in package\.json are the lock/,
    ],
    [
      "a dependency field that is not a name-to-version object",
      { manifest: { dependencies: ["left@1.2.3"] } },
      /^skills\/x\/package\.json: dependencies must be an object of package name to exact version/,
    ],
  ])("rejects %s", (_reason, overrides, message) => {
    expectCheckFailure(() => checkSkillDependencies(layout(overrides)), message);
  });
});

describe("checkSkillScripts", () => {
  // What drifts: a bare import in an installed skill resolves from nothing until the script's bundle holds it,
  // so every package a script loads is declared, and every script whose bundle would hold one carries the block
  // that builds it, byte for byte. The judge reads what bun's transpiler leaves after erasing types, so these
  // cases pin bun's erasure rules too: type-only forms vanish and need no declaration.
  const BLOCK = [
    "/**",
    " * the template",
    " */",
    "function ensureBuilt(source: string): boolean {",
    "  return source.endsWith('.js');",
    "}",
    "if (import.meta.main && ensureBuilt(import.meta.path)) process.exit();",
    "",
  ].join("\n");
  const none = { skillPath: "skills/x", declared: undefined, buildBlock: BLOCK };
  const declared = {
    skillPath: "skills/x",
    declared: new Set(["left-pad", "@scope/pkg"]),
    buildBlock: BLOCK,
  };
  const script = (text: string, path = "skills/x/scripts/x.mts") => ({ path, text });

  test.each([
    'import { a } from "./a.mts";',
    'import b from "../b.json" with { type: "json" };',
    'export * from "./c.mts";',
    'import { readFileSync } from "node:fs";',
    'import { readFileSync } from "fs";',
    'import "file:///tmp/example/helper.mts";',
    'const n = await import("data:text/javascript,export default 42");',
    'import { Database } from "bun:sqlite";',
    'import { $ } from "bun";',
    'const m = await import("./d.mts");',
    'import type { Node } from "left-pad";',
    'import /* erased at runtime */ type { Node } from "left-pad";',
    'export type * from "left-pad";',
    'export type { Node } from "left-pad";',
    'import type { Sub } from "@scope/pkg/sub";',
    'import { type Node, type Span } from "left-pad";',
    'export { type Node } from "left-pad";',
    'import type Parser = require("left-pad");',
    'declare module "virtual" { export { pad } from "left-pad"; }',
    'const t: typeof import("left-pad") = o;',
  ])("accepts %s in a skill with no package.json: nothing loads at runtime", (source) => {
    expect(() => checkSkillScripts([script(source)], none)).not.toThrow();
  });

  const LOADS = [
    'import { pad } from "left-pad";',
    'export { pad } from "left-pad";',
    'const o = await import("left-pad");',
    'import Pad = require("left-pad");',
    'const r = require("left-pad");',
    'const o = await import("left-" + "pad");',
    "const o = await import(`left-pad`);",
    'import { type Node, pad } from "left-pad";',
    'export * from "@scope/pkg/sub";',
  ];

  test.each(LOADS)("rejects %s in a skill with no package.json, naming the policy", (source) => {
    expectCheckFailure(
      () => checkSkillScripts([script(source)], none),
      /^skills\/x\/scripts\/x\.mts: imports '[^']+' but skills\/x has no package\.json -- a dependency is declared in skills\/x\/package\.json and bundled on first run/,
    );
  });

  test.each(LOADS)("accepts %s with the block in a skill that declares the package", (source) => {
    expect(() => checkSkillScripts([script(`${BLOCK}${source}`)], declared)).not.toThrow();
  });

  test.each(LOADS)("rejects %s without the block, naming the missing block", (source) => {
    expectCheckFailure(
      () => checkSkillScripts([script(source)], declared),
      /^skills\/x\/scripts\/x\.mts: loads a package, directly or through a relative import, so it carries the ensureBuilt block above its program/,
    );
  });

  test("a block that differs by a byte is drift, not a block", () => {
    const drifted = BLOCK.replace("return source", "return  source");
    expectCheckFailure(
      () => checkSkillScripts([script(`${drifted}import { pad } from "left-pad";`)], declared),
      /^skills\/x\/scripts\/x\.mts: loads a package, .* but its ensureBuilt block differs from the template; paste it again/,
    );
  });

  test("a package the manifest does not declare fails before the block is judged", () => {
    expectCheckFailure(
      () => checkSkillScripts([script(`${BLOCK}import { x } from "right-pad";`)], declared),
      /^skills\/x\/scripts\/x\.mts: imports 'right-pad', which skills\/x\/package\.json does not declare/,
    );
  });

  test("a script reaching a package through a relative import needs the block too", () => {
    const lib = script(
      `${BLOCK}import { pad } from "left-pad";\nexport const x = pad;`,
      "skills/x/scripts/lib.mts",
    );
    const cli = (text: string) => script(text, "skills/x/scripts/cli.mts");
    expectCheckFailure(
      () => checkSkillScripts([lib, cli('import { x } from "./lib.mts";')], declared),
      /^skills\/x\/scripts\/cli\.mts: loads a package, directly or through a relative import, so it carries the ensureBuilt block/,
    );
    // bun's resolution: a .js specifier names the .mts sibling, an extension-less one gains it, a directory
    // its index file; a chain of two relative imports is followed.
    for (const specifier of ["./lib.js", "./lib", "./lib/"]) {
      const target =
        specifier === "./lib/" ? "skills/x/scripts/lib/index.mts" : "skills/x/scripts/lib.mts";
      expectCheckFailure(
        () =>
          checkSkillScripts([{ ...lib, path: target }, cli(`import "${specifier}";`)], declared),
        /^skills\/x\/scripts\/cli\.mts: loads a package/,
      );
    }
    const mid = script(`${BLOCK}export * from "./lib";`, "skills/x/scripts/mid.mts");
    expectCheckFailure(
      () => checkSkillScripts([lib, mid, cli('import "./mid";')], declared),
      /^skills\/x\/scripts\/cli\.mts: loads a package/,
    );
    expect(() =>
      checkSkillScripts([lib, mid, cli(`${BLOCK}import "./mid";`)], declared),
    ).not.toThrow();
  });

  test("a dependency-free script carrying the block fails: the block makes bun a requirement", () => {
    expectCheckFailure(
      () => checkSkillScripts([script(`${BLOCK}console.log(1);`)], none),
      /^skills\/x\/scripts\/x\.mts: carries an ensureBuilt block but loads no package/,
    );
    expectCheckFailure(
      () => checkSkillScripts([script('function ensureBuilt() {}\nimport "./a.mts";')], declared),
      /carries an ensureBuilt block but loads no package/,
    );
  });

  test("a relative import cycle between dependency-free scripts terminates", () => {
    expect(() =>
      checkSkillScripts(
        [
          script('import "./b.mts";', "skills/x/scripts/a.mts"),
          script('import "./a.mts";', "skills/x/scripts/b.mts"),
        ],
        none,
      ),
    ).not.toThrow();
  });

  test("JSX in a .tsx script is judged by the import bun synthesizes for it", () => {
    // bun 1.4.2 compiles `<div />` to an import of react/jsx-dev-runtime; the source text names no package.
    expectCheckFailure(
      () => checkSkillScripts([script("console.log(<div />);", "skills/x/scripts/view.tsx")], none),
      /^skills\/x\/scripts\/view\.tsx: imports 'react\/jsx-dev-runtime' but skills\/x has no package\.json/,
    );
  });

  test("a script that does not parse fails instead of passing with no imports seen", () => {
    expectCheckFailure(
      () => checkSkillScripts([script("import { from ;")], none),
      /^skills\/x\/scripts\/x\.mts: does not parse: /,
    );
  });
});

describe("ensureBuiltTemplate", () => {
  const fence = "```ts\nfunction ensureBuilt(source: string): boolean {\n  return false;\n}\n```\n";

  test("returns the first ts fence of the Dependencies section, not one of another section", () => {
    const doc = [
      "# A",
      "",
      "## Other",
      "",
      "```ts",
      "function ensureBuilt() {}",
      "```",
      "",
      "## Dependencies",
      "",
      "text",
      "",
      "```text",
      "layout",
      "```",
      "",
      fence,
      "## Next",
      "",
    ].join("\n");
    expect(ensureBuiltTemplate(doc)).toBe(
      "function ensureBuilt(source: string): boolean {\n  return false;\n}\n",
    );
  });

  test.each<[reason: string, doc: string, message: RegExp]>([
    [
      "no Dependencies section",
      `# A\n\n## Other\n\n${fence}`,
      /^docs\/authoring\.md: missing the '## Dependencies' section/,
    ],
    [
      "a section without the fence",
      `# A\n\n## Dependencies\n\ntext\n\n## Next\n\n${fence}`,
      /^docs\/authoring\.md: the Dependencies section has no ts fence holding function ensureBuilt/,
    ],
    [
      "a ts fence holding something else",
      "# A\n\n## Dependencies\n\n```ts\nconst x = 1;\n```\n",
      /no ts fence holding function ensureBuilt/,
    ],
  ])("rejects %s", (_reason, doc, message) => {
    expectCheckFailure(() => ensureBuiltTemplate(doc), message);
  });
});
