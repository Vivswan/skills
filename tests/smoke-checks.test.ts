import { describe, expect, test } from "bun:test";
import { CheckFailure } from "../scripts/lib";
import {
  checkDescriptionTriggerForm,
  checkExplicitInvocationPairing,
  checkReadmeInvocationGrouping,
  checkReadmeMermaidGraph,
  checkReadmeSkillList,
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
    const graph = 'graph LR\n  a["/alpha-one"] --> a2["/alpha-one"]\n';
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).toThrow(
      /missing a node for 'beta-two'/,
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

  test("accepts a standalone '/skill'-labeled node line", () => {
    const graph = 'graph LR\n  a["/alpha-one"]\n  a --> b["/beta-two"]\n';
    expect(() => checkReadmeMermaidGraph(withGraph(graph), names)).not.toThrow();
  });

  test("negative control: a malformed edge on the graph-header line still fails", () => {
    // The header exemption must be exact: 'graph LR --> ghost' is an edge
    // with a dangling endpoint, not a header, and must not ride the
    // /^graph/ prefix past endpoint validation.
    const graph = 'graph LR --> ghost\n  a["/alpha-one"] --> b["/beta-two"]\n';
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
