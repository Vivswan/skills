import { describe, expect, test } from "bun:test";
import { CheckFailure } from "../scripts/lib";
import {
  checkDescriptionTriggerForm,
  checkExplicitInvocationPairing,
  checkMarketplacePluginVersionBan,
  checkReadmeInvocationGrouping,
  checkReadmeMermaidGraph,
  checkReadmeSkillList,
  checkReadmeUsageExplicitRoster,
} from "../scripts/smoke-checks";

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

  test("rejects a summary-form description", () => {
    expect(() =>
      checkDescriptionTriggerForm("skills/x/SKILL.md", { description: "A skill that watches CI." }),
    ).toThrow(CheckFailure);
  });

  test("rejects a bare 'Use when ' with no trigger", () => {
    expect(() =>
      checkDescriptionTriggerForm("skills/x/SKILL.md", { description: "Use when " }),
    ).toThrow(/trigger/);
  });

  test("rejects a missing description", () => {
    expect(() => checkDescriptionTriggerForm("skills/x/SKILL.md", {})).toThrow(CheckFailure);
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
    "\n- [/alpha-one](./skills/alpha-one/) - a\n- [/beta-two](./skills/beta-two/) - b\n";

  test("accepts an exact bijection", () => {
    expect(() => checkReadmeSkillList(readme(goodList), names)).not.toThrow();
  });

  test("rejects a missing entry", () => {
    const list = "\n- [/alpha-one](./skills/alpha-one/) - a\n";
    expect(() => checkReadmeSkillList(readme(list), names)).toThrow(/missing an entry/);
  });

  test("rejects a stale entry without a folder", () => {
    const list = `${goodList}- [/gamma-three](./skills/gamma-three/) - c\n`;
    expect(() => checkReadmeSkillList(readme(list), names)).toThrow(/no matching/);
  });

  test("rejects a wrong link target", () => {
    const list =
      "\n- [/alpha-one](./skills/beta-two/) - a\n- [/beta-two](./skills/beta-two/) - b\n";
    expect(() => checkReadmeSkillList(readme(list), names)).toThrow(/must link/);
  });

  test("rejects a duplicate entry", () => {
    expect(() => checkReadmeSkillList(readme(goodList + goodList), names)).toThrow(/duplicate/);
  });

  test("accepts the no-trailing-slash link form", () => {
    const list =
      "\n- [/alpha-one](./skills/alpha-one) - a\n- [/beta-two](./skills/beta-two/) - b\n";
    expect(() => checkReadmeSkillList(readme(list), names)).not.toThrow();
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
  const goodGraph = 'graph LR\n  a["/alpha-one"] --> b["/beta-two"]\n';

  test("accepts a consistent graph", () => {
    expect(() => checkReadmeMermaidGraph(withGraph(goodGraph), names)).not.toThrow();
  });

  test("accepts a bare alias used before its labeled definition", () => {
    const graph = 'graph LR\n  a["/alpha-one"] --> b\n  b["/beta-two"] --> a\n';
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).not.toThrow();
  });

  test("negative control: a dangling edge endpoint fails", () => {
    const graph = `${goodGraph}  a --> ghost\n`;
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(/dangling/);
  });

  test("rejects a node labeling a skill with no folder", () => {
    const graph = `${goodGraph}  g["/gamma-three"] --> a\n`;
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(/no skills\//);
  });

  test("rejects a graph missing a node for a published skill", () => {
    const graph = 'graph LR\n  a["/alpha-one"] --> a\n';
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(
      /missing a node for 'beta-two'/,
    );
  });

  test("rejects two aliases labeling the same skill", () => {
    // The reverse half of the bijection: without it, a rename could leave a
    // stale duplicate node behind and every skill would still "appear".
    const graph = `${goodGraph}  a2["/alpha-one"] --> b\n`;
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(
      /both label '\/alpha-one'/,
    );
  });

  test("rejects one alias defined with two different labels", () => {
    const graph = 'graph LR\n  a["/alpha-one"] --> a["/beta-two"]\n  b["/beta-two"] --> a\n';
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(/defined twice/);
  });

  test("rejects an unparseable edge endpoint instead of skipping it", () => {
    const graph = `${goodGraph}  a --> b & c\n`;
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(/cannot parse/);
  });

  test("negative control: a standalone node with a non-skill label fails", () => {
    // A label without the leading slash never enters the alias map, so
    // without full line parsing this orphan would pass every check silently.
    const graph = `${goodGraph}  orphan["retired"]\n`;
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(/cannot parse/);
  });

  test("negative control: a bare standalone alias fails", () => {
    const graph = `${goodGraph}  orphan\n`;
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(/cannot parse/);
  });

  test("rejects 'end' as a node alias (reserved flowchart keyword)", () => {
    // Mermaid silently breaks the rendering on an 'end' node instead of
    // erroring, so without this check the graph passes and does not draw.
    const graph = `${goodGraph}  end["/beta-two"]\n`;
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(/reserved/);
  });

  test("accepts a standalone '/skill'-labeled node line", () => {
    const graph = 'graph LR\n  a["/alpha-one"]\n  a --> b["/beta-two"]\n';
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).not.toThrow();
  });

  test("negative control: a malformed edge on the graph-header line still fails", () => {
    // 'graph LR --> ghost' is not a valid header, and its dangling endpoint
    // must not ride a header exemption past validation.
    const graph = 'graph LR --> ghost\n  a["/alpha-one"] --> b["/beta-two"]\n';
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(/must open with/);
  });

  test("rejects a graph without the flowchart header", () => {
    // Mermaid cannot render a block with no 'graph <direction>' declaration.
    const graph = '  a["/alpha-one"] --> b["/beta-two"]\n';
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(/must open with/);
  });

  test("rejects an invalid flowchart direction", () => {
    const graph = 'graph XX\n  a["/alpha-one"] --> b["/beta-two"]\n';
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(/must open with/);
  });

  test("rejects a second header line", () => {
    const graph = `${goodGraph}graph TB\n`;
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(/cannot parse/);
  });

  test("rejects a README without a mermaid block", () => {
    expect(() => checkReadmeMermaidGraph("# Skills\n", names)).toThrow(CheckFailure);
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
    expect(() =>
      checkReadmeInvocationGrouping(readme(area), [{ name: "alpha-one", disabled: true }]),
    ).toThrow(/must be listed under/);
  });

  test("rejects an automatic skill listed under Invoked by you", () => {
    expect(() =>
      checkReadmeInvocationGrouping(readme(area), [{ name: "beta-two", disabled: false }]),
    ).toThrow(/Automatic/);
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
    return `# Skills\n\n## Usage\n\nSkills marked explicit-invocation-only (${roster}) load only when you invoke them (e.g. [\`/beta-two\`](./skills/beta-two/) in Claude Code).\n`;
  }
  const skills = [
    { name: "alpha-one", disabled: false },
    { name: "beta-two", disabled: true },
  ];

  test("accepts a roster naming exactly the disabled skills", () => {
    expect(() =>
      checkReadmeUsageExplicitRoster(usageReadme("[`/beta-two`](./skills/beta-two/)"), skills),
    ).not.toThrow();
  });

  test("negative control: a roster missing a disabled skill fails", () => {
    expect(() =>
      checkReadmeUsageExplicitRoster(usageReadme("[`/alpha-one`](./skills/alpha-one/)"), [
        { name: "alpha-one", disabled: true },
        { name: "beta-two", disabled: true },
      ]),
    ).toThrow(/missing 'beta-two'/);
  });

  test("rejects a roster naming an automatic skill", () => {
    expect(() =>
      checkReadmeUsageExplicitRoster(
        usageReadme("[`/alpha-one`](./skills/alpha-one/), [`/beta-two`](./skills/beta-two/)"),
        skills,
      ),
    ).toThrow(/does not set disable-model-invocation/);
  });

  test("rejects a roster naming a skill that is not published", () => {
    expect(() =>
      checkReadmeUsageExplicitRoster(
        usageReadme("[`/beta-two`](./skills/beta-two/), [`/gamma-three`](./skills/gamma-three/)"),
        skills,
      ),
    ).toThrow(/not a published skill/);
  });

  test("rejects a README where the marker sentence was rewritten away", () => {
    expect(() =>
      checkReadmeUsageExplicitRoster("# Skills\n\n## Usage\n\nAll skills load lazily.\n", skills),
    ).toThrow(/explicit-invocation-only/);
  });

  test("rejects unrecognized text inside the roster instead of ignoring it", () => {
    // The link scan alone failed open: '**/ghost-skill**' is not a link, so
    // it contributed nothing and the roster still passed. Every entry must
    // parse or the check fails.
    expect(() =>
      checkReadmeUsageExplicitRoster(
        usageReadme("[`/beta-two`](./skills/beta-two/), **/ghost-skill**"),
        skills,
      ),
    ).toThrow(/cannot parse Usage explicit-invocation-only roster entry '\*\*\/ghost-skill\*\*'/);
  });

  test("rejects a roster link whose target names a different skill", () => {
    expect(() =>
      checkReadmeUsageExplicitRoster(usageReadme("[`/beta-two`](./skills/alpha-one/)"), skills),
    ).toThrow(/cannot parse/);
  });

  test("ignores a marker sentence hidden inside a fenced block", () => {
    const text =
      "# Skills\n\n## Usage\n\nAll skills load lazily.\n\n```text\nSkills marked explicit-invocation-only ([`/beta-two`](./skills/beta-two/)) load only when you invoke them.\n```\n";
    expect(() => checkReadmeUsageExplicitRoster(text, skills)).toThrow(/explicit-invocation-only/);
  });

  test("ignores a marker sentence hidden inside a tilde-fenced block", () => {
    // CommonMark fences come in both flavors; stripping only backticks let a
    // ~~~ block satisfy the check while the real Usage prose said anything.
    const text =
      "# Skills\n\n## Usage\n\nAll skills load lazily.\n\n~~~text\nSkills marked explicit-invocation-only ([`/beta-two`](./skills/beta-two/)) load only when you invoke them.\n~~~\n";
    expect(() => checkReadmeUsageExplicitRoster(text, skills)).toThrow(/explicit-invocation-only/);
  });

  test("rejects a duplicate roster entry", () => {
    expect(() =>
      checkReadmeUsageExplicitRoster(
        usageReadme("[`/beta-two`](./skills/beta-two/), [`/beta-two`](./skills/beta-two/)"),
        skills,
      ),
    ).toThrow(/duplicate/);
  });

  test("rejects a marker sentence outside the Usage section", () => {
    const text =
      "# Skills\n\n## About\n\nSkills marked explicit-invocation-only ([`/beta-two`](./skills/beta-two/)) load only when you invoke them.\n\n## Usage\n\nAll skills load lazily.\n";
    expect(() => checkReadmeUsageExplicitRoster(text, skills)).toThrow(/explicit-invocation-only/);
  });
});
