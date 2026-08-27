/**
 * Parameterized consistency checks extracted from smoke-test.ts so they can
 * be unit-tested: importing smoke-test.ts executes the whole smoke run, so
 * anything a test needs lives here instead. Callers do the file IO and pass
 * content plus display paths; these functions only judge the content and
 * throw CheckFailure (via fail) on a violation.
 */

import type { Frontmatter } from "./lib";
import { errorMessage, fail, isRecord, KEBAB_CASE } from "./lib";

// The frontmatter description is a trigger, not a summary (AGENTS.md >
// "Creating a new skill"); make the convention self-enforcing. A bare
// "Use when " with nothing after it is a summary-shaped dodge, not a trigger.
export function checkDescriptionTriggerForm(displayPath: string, frontmatter: Frontmatter): void {
  const description = frontmatter.description;
  if (typeof description !== "string" || !/^Use when \S/.test(description)) {
    fail(
      `${displayPath}: description must be trigger-form, starting with "Use when ..."` +
        " followed by the actual trigger (see AGENTS.md > Creating a new skill)",
    );
  }
}

export interface ExplicitInvocationInput {
  /** Display path of SKILL.md for failure messages. */
  readonly skillMdPath: string;
  readonly frontmatter: Frontmatter;
  /** Display path of agents/openai.yaml for failure messages. */
  readonly openaiYamlPath: string;
  /** File content, or undefined when the file does not exist. */
  readonly openaiYamlText: string | undefined;
}

// "Explicit-invocation-only" spans two files: disable-model-invocation in
// SKILL.md frontmatter (Claude Code) and policy.allow_implicit_invocation in
// agents/openai.yaml (Codex). Either alone drifts silently, so require both
// or neither, and reject non-boolean values (a quoted "true" is a string
// that would otherwise pass as "not disabled").
export function checkExplicitInvocationPairing(input: ExplicitInvocationInput): void {
  const frontmatterValue = input.frontmatter["disable-model-invocation"];
  if (frontmatterValue !== undefined && typeof frontmatterValue !== "boolean") {
    fail(
      `${input.skillMdPath}: disable-model-invocation must be a plain YAML boolean,` +
        ` got ${JSON.stringify(frontmatterValue)} (a quoted "true"/"false" is a string)`,
    );
  }
  const frontmatterDisabled = frontmatterValue === true;
  let policyDisabled = false;
  if (input.openaiYamlText !== undefined) {
    let doc: unknown;
    try {
      doc = Bun.YAML.parse(input.openaiYamlText);
    } catch (error) {
      fail(`${input.openaiYamlPath}: invalid YAML (${errorMessage(error)})`);
    }
    const policy = isRecord(doc) && isRecord(doc.policy) ? doc.policy : undefined;
    const policyValue = policy === undefined ? undefined : policy.allow_implicit_invocation;
    if (policyValue !== undefined && typeof policyValue !== "boolean") {
      fail(
        `${input.openaiYamlPath}: policy.allow_implicit_invocation must be a plain YAML boolean,` +
          ` got ${JSON.stringify(policyValue)}`,
      );
    }
    policyDisabled = policyValue === false;
  }
  if (frontmatterDisabled !== policyDisabled) {
    fail(
      `${input.skillMdPath}: explicit-invocation-only must be declared for every agent or none:` +
        " set both 'disable-model-invocation: true' in the frontmatter and" +
        " 'policy.allow_implicit_invocation: false' in agents/openai.yaml, or neither",
    );
  }
}

// Extract the Available Skills area of the README, with fenced blocks (the
// mermaid graph) and HTML comments removed so they cannot contribute entries.
// Stripping runs to a fixpoint: a single pass can reassemble a new `<!--` or
// fence from the surrounding fragments (CodeQL js/incomplete-multi-character-
// sanitization), letting crafted content hide from or leak into the checks.
function readmeSkillsArea(readmeText: string): string {
  const heading = "\n## Available Skills\n";
  const start = readmeText.indexOf(heading);
  if (start === -1) fail("README.md: missing the '## Available Skills' section");
  const body = readmeText.slice(start + heading.length);
  const end = body.search(/^## /m);
  let area = end === -1 ? body : body.slice(0, end);
  let previous: string;
  do {
    previous = area;
    area = area.replace(/```[\s\S]*?```/g, "").replace(/<!--[\s\S]*?-->/g, "");
  } while (area !== previous);
  return area;
}

// Bijection between README's Available Skills list and skill folders: every
// published skill appears as a linked bullet '- [/name](./skills/name/)', an
// entry whose folder is gone is stale documentation, each link must point at
// the skill's own folder, and a duplicate entry is drift. Only kebab-case
// names count as skill entries, so prose bullets are left alone.
export function checkReadmeSkillList(readmeText: string, skillNames: ReadonlySet<string>): void {
  const scannable = readmeSkillsArea(readmeText);
  const listed = new Map<string, string>();
  for (const match of scannable.matchAll(/^- \[\/?([^\]]+)\]\(([^)]+)\)/gm)) {
    const name = (match[1] ?? "").trim();
    if (!KEBAB_CASE.test(name)) continue;
    if (listed.has(name)) {
      fail(`README.md: duplicate Available Skills entry for '${name}'`);
    }
    listed.set(name, match[2] ?? "");
  }
  for (const [name, target] of listed) {
    if (!skillNames.has(name)) {
      fail(
        `README.md: '[${name}]' in the Available Skills list has no matching` +
          ` skills/${name}/ folder -- remove the stale entry or restore the folder`,
      );
    }
    if (target !== `./skills/${name}/` && target !== `./skills/${name}`) {
      fail(`README.md: the '[${name}]' entry must link to ./skills/${name}/`);
    }
  }
  for (const name of skillNames) {
    if (!listed.has(name)) {
      fail(`README.md: the Available Skills list is missing an entry for '${name}'`);
    }
  }
}

// The README's mermaid skill-reference graph is stripped out of the list
// checks above (fenced block), so nothing else keeps it honest: a retired
// skill's node, a dangling edge, or a new skill missing from the graph would
// all render fine and drift silently. Bijection plus referential integrity:
// every node label resolves to a published skill, one node per skill, every
// published skill has a node, and every edge endpoint names a defined node.
export function checkReadmeMermaidGraph(readmeText: string, skillNames: ReadonlySet<string>): void {
  const fence = /```mermaid\n([\s\S]*?)```/.exec(readmeText);
  if (fence === null) fail("README.md: missing the mermaid skill-reference graph");
  const body = fence[1] ?? "";

  // Node definitions may appear standalone or inline inside an edge; collect
  // them all first so a bare alias used before its labeled definition still
  // resolves (mermaid allows that order).
  const aliases = new Map<string, string>();
  for (const def of body.matchAll(/([A-Za-z0-9_]+)\["\/([^"\]]*)"\]/g)) {
    const alias = def[1] ?? "";
    const name = def[2] ?? "";
    const existing = aliases.get(alias);
    if (existing !== undefined && existing !== name) {
      fail(
        `README.md: mermaid node '${alias}' is defined twice with different labels` +
          ` ('/${existing}' vs '/${name}')`,
      );
    }
    aliases.set(alias, name);
  }

  // Bijection, both directions: every label resolves to a published skill,
  // one node per skill (a second alias for the same skill is drift from a
  // rename or a stale duplicate), and every published skill has a node.
  const aliasBySkill = new Map<string, string>();
  for (const [alias, name] of aliases) {
    if (!skillNames.has(name)) {
      fail(
        `README.md: mermaid node '${alias}' labels '/${name}', which has no` +
          ` skills/${name}/ folder -- remove the stale node or restore the folder`,
      );
    }
    const prior = aliasBySkill.get(name);
    if (prior !== undefined && prior !== alias) {
      fail(
        `README.md: mermaid nodes '${prior}' and '${alias}' both label '/${name}'` +
          " -- one skill, one node",
      );
    }
    aliasBySkill.set(name, alias);
  }
  for (const name of skillNames) {
    if (!aliasBySkill.has(name)) {
      fail(`README.md: the mermaid skill-reference graph is missing a node for '${name}'`);
    }
  }

  // Every remaining line must be something this checker understands: an
  // edge, the exact `graph <direction>` header, or a standalone
  // '/skill'-labeled node. Anything else (a bare alias, a node whose label
  // lacks the leading slash, syntax this parser does not know) fails loudly
  // instead of slipping past the guarantees above unparsed. Edges are
  // matched first so a malformed line starting with `graph` cannot ride the
  // header exemption past endpoint validation.
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line === "") continue;
    if (line.includes("-->")) {
      for (const rawEndpoint of line.split("-->")) {
        const endpoint = rawEndpoint.trim();
        const parsed = /^([A-Za-z0-9_]+)(\["\/[^"\]]*"\])?$/.exec(endpoint);
        if (parsed === null) {
          fail(`README.md: cannot parse mermaid edge endpoint '${endpoint}' in '${line}'`);
        }
        const alias = parsed[1] ?? "";
        if (!aliases.has(alias)) {
          fail(
            `README.md: mermaid edge '${line}' references '${alias}', which no node` +
              " definition labels -- a dangling endpoint",
          );
        }
      }
      continue;
    }
    if (/^graph [A-Z]{2}$/.test(line)) continue;
    if (!/^[A-Za-z0-9_]+\["\/[^"\]]*"\]$/.test(line)) {
      fail(
        `README.md: cannot parse mermaid graph line '${line}' -- expected the graph` +
          " header, an edge, or a node labeled '/skill-name'",
      );
    }
  }
}

export interface InvocationGroupingEntry {
  readonly name: string;
  readonly disabled: boolean;
}

// The README's Automatic vs "Invoked by you" grouping must track the
// explicit-invocation flag: a skill sits under "Invoked by you" exactly when
// its frontmatter sets disable-model-invocation. Accurate prose otherwise
// drifts silently the first time someone flips the flag.
export function checkReadmeInvocationGrouping(
  readmeText: string,
  skills: readonly InvocationGroupingEntry[],
): void {
  const area = readmeSkillsArea(readmeText);
  const invokedIndex = area.indexOf("### Invoked by you");
  if (invokedIndex === -1) fail("README.md: missing the '### Invoked by you' subsection");
  const invokedArea = area.slice(invokedIndex);
  for (const { name, disabled } of skills) {
    const inInvoked = invokedArea.includes(`- [/${name}](`);
    if (disabled !== inInvoked) {
      fail(
        `README.md: '${name}' must be listed under` +
          ` '${disabled ? "Invoked by you" : "Automatic"}' to match its` +
          " disable-model-invocation frontmatter",
      );
    }
  }
}
