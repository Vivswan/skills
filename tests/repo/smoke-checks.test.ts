import { describe, expect, test } from "bun:test";
import {
  checkDescriptionTriggerForm,
  checkExplicitInvocationPairing,
  checkMarketplacePluginVersionBan,
  checkReadmeExplicitUpstreams,
  checkReadmeInvocationGrouping,
  checkReadmeMermaidGraph,
  checkReadmeSkillList,
  checkSkillDependencies,
  checkSkillScripts,
  ensureBuiltTemplate,
  type SkillDependencyLayout,
} from "../../scripts/smoke-checks.mts";
import { expectCheckFailure } from "../helpers/check-failure";

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

describe("checkReadmeExplicitUpstreams", () => {
  // What drifts: the install commands mark the copies the marketplace flags; the README names them in prose.
  const upstream = [
    { name: "alpha-one", repo: "example-org/alpha", path: "skills/alpha-one", explicitOnly: true },
    { name: "beta-two", repo: "example-org/beta", path: "skills/beta-two", explicitOnly: true },
    { name: "gamma-three", repo: "example-org/gamma", path: "gamma", explicitOnly: false },
  ];
  const page = (roster: string) =>
    readme(
      `\n### Upstream skills\n\nInstalled by \`one\` or \`two\`, ${roster} load only when you invoke them.\n`,
    );

  test("accepts a roster naming exactly the flagged entries, in any order", () => {
    expect(() =>
      checkReadmeExplicitUpstreams(page("`beta-two` and `alpha-one`"), upstream),
    ).not.toThrow();
    expect(() =>
      checkReadmeExplicitUpstreams(page("`alpha-one`, and `beta-two`"), upstream),
    ).not.toThrow();
  });

  test("accepts a page without the sentence when nothing is flagged", () => {
    expect(() =>
      checkReadmeExplicitUpstreams(readme("\n### Upstream skills\n"), [
        upstream[2] as (typeof upstream)[number],
      ]),
    ).not.toThrow();
  });

  test.each([
    {
      id: "a flagged entry missing",
      roster: "`alpha-one`",
      pattern: /names \[alpha-one\], the marketplace flags \[alpha-one, beta-two\]/,
    },
    {
      id: "an unflagged entry named",
      roster: "`alpha-one`, `beta-two`, and `gamma-three`",
      pattern: /the two must agree/,
    },
    {
      id: "prose that is not a name",
      roster: "`alpha-one` and **beta-two**",
      pattern: /cannot parse explicit-invocation-only upstream roster entry '\*\*beta-two\*\*'/,
    },
  ])("rejects $id", ({ roster, pattern }) => {
    expectCheckFailure(() => checkReadmeExplicitUpstreams(page(roster), upstream), pattern);
  });

  test("rejects a page without the sentence when an entry is flagged", () => {
    expectCheckFailure(
      () => checkReadmeExplicitUpstreams(readme("\n### Upstream skills\n"), upstream),
      /missing the sentence/,
    );
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

  const HOISTED_LOADS = [
    'import { pad } from "left-pad";',
    'export { pad } from "left-pad";',
    'import { type Node, pad } from "left-pad";',
    'export * from "@scope/pkg/sub";',
  ];
  // `import X = require()` compiles to a require call, which runs where it stands like `await import()`.
  const IN_PLACE_LOADS = [
    'const o = await import("left-pad");',
    'const o = await import("left-" + "pad");',
    "const o = await import(`left-pad`);",
    'const o = await import("@scope/pkg/sub");',
    'import Pad = require("left-pad");',
    'const r = require("left-pad");',
    'const o = await import("left-pad", { with: { type: "json" } });',
  ];
  const LOADS = [...HOISTED_LOADS, ...IN_PLACE_LOADS];

  test.each(LOADS)("rejects %s in a skill with no package.json, naming the policy", (source) => {
    expectCheckFailure(
      () => checkSkillScripts([script(source)], none),
      /^skills\/x\/scripts\/x\.mts: imports '[^']+' but skills\/x has no package\.json -- a dependency is declared in skills\/x\/package\.json and bundled on first run/,
    );
  });

  test.each(IN_PLACE_LOADS)(
    "accepts %s below the block in a skill that declares the package",
    (source) => {
      expect(() => checkSkillScripts([script(`${BLOCK}${source}`)], declared)).not.toThrow();
    },
  );

  test.each(HOISTED_LOADS)(
    "rejects %s even with the block: ESM hoists it above the guard",
    (source) => {
      expectCheckFailure(
        () => checkSkillScripts([script(`${BLOCK}${source}`)], declared),
        /^skills\/x\/scripts\/x\.mts: static import of '[^']+' is hoisted above the ensureBuilt guard, so the source path resolves it before the bundle exists; load it below the guard with await import\(\)/,
      );
    },
  );

  test.each(IN_PLACE_LOADS)("rejects %s without the block, naming the missing block", (source) => {
    expectCheckFailure(
      () => checkSkillScripts([script(source)], declared),
      /^skills\/x\/scripts\/x\.mts: loads a package, directly or through a relative import, so it carries the ensureBuilt block above its program/,
    );
  });

  test.each(IN_PLACE_LOADS)(
    "rejects %s placed above the block: it runs before the guard",
    (source) => {
      expectCheckFailure(
        () => checkSkillScripts([script(`${source}\n${BLOCK}`)], declared),
        /^skills\/x\/scripts\/x\.mts: loads '[^']+' above the ensureBuilt block, so the source path resolves it before the guard decides; move the load below the guard/,
      );
    },
  );

  test("positions come from the erased text's syntax: a string spelling a load or the block is text", () => {
    expect(() =>
      checkSkillScripts(
        [
          script(
            `const example = 'import("left-pad")';\n${BLOCK}const o = await import("left-pad");`,
          ),
        ],
        declared,
      ),
    ).not.toThrow();
    expectCheckFailure(
      () =>
        checkSkillScripts(
          [
            script(
              `const example = "function ensureBuilt(";\nconst o = await import("left-pad");\n${BLOCK}`,
            ),
          ],
          declared,
        ),
      /loads 'left-pad' above the ensureBuilt block/,
    );
  });

  test("a sibling that loads a package, loaded in place above the block, is rejected too", () => {
    const lib = script(
      `${BLOCK}const { pad } = await import("left-pad");\nexport const x = pad;`,
      "skills/x/scripts/lib.mts",
    );
    const cli = (text: string) => script(text, "skills/x/scripts/cli.mts");
    expectCheckFailure(
      () =>
        checkSkillScripts(
          [lib, cli(`const { x } = await import("./lib.mts");\n${BLOCK}`)],
          declared,
        ),
      /^skills\/x\/scripts\/cli\.mts: loads '\.\/lib\.mts' above the ensureBuilt block/,
    );
    expect(() =>
      checkSkillScripts([lib, cli(`${BLOCK}const { x } = await import("./lib.mts");`)], declared),
    ).not.toThrow();
  });

  test("a block that differs by a byte is drift, not a block", () => {
    const drifted = BLOCK.replace("return source", "return  source");
    expectCheckFailure(
      () =>
        checkSkillScripts(
          [script(`${drifted}const { pad } = await import("left-pad");`)],
          declared,
        ),
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
      `${BLOCK}const { pad } = await import("left-pad");\nexport const x = pad;`,
      "skills/x/scripts/lib.mts",
    );
    const cli = (text: string) => script(text, "skills/x/scripts/cli.mts");
    expectCheckFailure(
      () => checkSkillScripts([lib, cli('const { x } = await import("./lib.mts");')], declared),
      /^skills\/x\/scripts\/cli\.mts: loads a package, directly or through a relative import, so it carries the ensureBuilt block/,
    );
    // A static import of the sibling runs the sibling's package loads above this script's guard.
    expectCheckFailure(
      () => checkSkillScripts([lib, cli(`${BLOCK}import { x } from "./lib.mts";`)], declared),
      /^skills\/x\/scripts\/cli\.mts: static import of '\.\/lib\.mts' is hoisted above the ensureBuilt guard/,
    );
    // bun's resolution: a .js specifier names the .mts sibling, an extension-less one gains it, a directory
    // its index file; a chain of two relative imports is followed.
    for (const specifier of ["./lib.js", "./lib", "./lib/"]) {
      const target =
        specifier === "./lib/" ? "skills/x/scripts/lib/index.mts" : "skills/x/scripts/lib.mts";
      expectCheckFailure(
        () =>
          checkSkillScripts(
            [{ ...lib, path: target }, cli(`await import("${specifier}");`)],
            declared,
          ),
        /^skills\/x\/scripts\/cli\.mts: loads a package/,
      );
    }
    const mid = script(
      `${BLOCK}export const m = await import("./lib");`,
      "skills/x/scripts/mid.mts",
    );
    expectCheckFailure(
      () => checkSkillScripts([lib, mid, cli('await import("./mid");')], declared),
      /^skills\/x\/scripts\/cli\.mts: loads a package/,
    );
    expect(() =>
      checkSkillScripts([lib, mid, cli(`${BLOCK}await import("./mid");`)], declared),
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
