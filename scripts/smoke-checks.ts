/**
 * Parameterized consistency checks extracted from smoke-test.ts so they can
 * be unit-tested: importing smoke-test.ts executes the whole smoke run, so
 * anything a test needs lives here instead. Callers do the file IO and pass
 * content plus display paths; these functions only judge the content and
 * throw CheckFailure (via fail) on a violation.
 */

import { isBuiltin } from "node:module";
import { isDeepStrictEqual } from "node:util";
import type { Frontmatter } from "./lib";
import { errorMessage, fail, isRecord, KEBAB_CASE } from "./lib";

// The frontmatter description is a trigger, not a summary; make the convention self-enforcing. A bare
// "Use when " with nothing after it is a summary-shaped dodge, not a trigger.
export function checkDescriptionTriggerForm(displayPath: string, frontmatter: Frontmatter): void {
  const description = frontmatter.description;
  if (typeof description !== "string" || !/^Use when \S/.test(description)) {
    fail(
      `${displayPath}: description must be trigger-form, starting with "Use when ..."` +
        " followed by the actual trigger (see docs/authoring.md)",
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

// The version ban's marketplace surface: metadata.version at the top of
// marketplace.json is the single source of truth, so a `version` on a
// plugins[] entry is a second copy that only drifts. The manifest-equality
// check cannot catch it because plugin.json (correctly) has no version field
// to compare against.
export function checkMarketplacePluginVersionBan(
  displayPath: string,
  plugins: readonly Record<string, unknown>[],
): void {
  for (const plugin of plugins) {
    if ("version" in plugin) {
      fail(
        `${displayPath}: plugin '${String(plugin.name)}' carries a 'version' field -- the single` +
          " source of truth is marketplace.json metadata.version (see docs/authoring.md > Validation Checklist)",
      );
    }
  }
}

export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const DEPENDENCIES_DOC = "docs/authoring.md > Dependencies";

export interface SkillDependencyLayout {
  /** The skill's display path, e.g. skills/working-text. */
  readonly skillPath: string;
  /** Display paths of every package.json under the skill, node_modules excluded. */
  readonly manifestPaths: readonly string[];
  /** Display paths of every node_modules directory under the skill. */
  readonly nodeModulesPaths: readonly string[];
  /** The parsed skills/<name>/package.json, when the skill root carries one. */
  readonly manifest: Record<string, unknown> | undefined;
  /** The parsed skills/<name>/bun.lock, when present. */
  readonly lock: Record<string, unknown> | undefined;
  /** The root package.json devDependencies: where tsc resolves every skill import. */
  readonly rootDevDependencies: Record<string, unknown>;
}

// Why a lockfile per skill and a root pin of the same version: bun's auto-install ignores a package.json pin, and an
// inline `pkg@1.2.3` specifier breaks once a second version of the package was ever fetched on the machine, so a
// skill's dependencies install from its own bun.lock into a shared cache (the bootstrap in docs/authoring.md) while
// tsc resolves the same bare import against the root node_modules.
export function checkSkillDependencies(
  layout: SkillDependencyLayout,
): ReadonlySet<string> | undefined {
  const { skillPath, manifest } = layout;
  for (const path of layout.nodeModulesPaths) {
    fail(
      `${path}: node_modules under a skill folder; dependencies install into the shared cache, never` +
        ` here (${DEPENDENCIES_DOC})`,
    );
  }
  const rootManifest = `${skillPath}/package.json`;
  for (const path of layout.manifestPaths) {
    if (path !== rootManifest) {
      fail(
        `${path}: a skill's package.json sits at ${rootManifest}, nowhere deeper (${DEPENDENCIES_DOC})`,
      );
    }
  }
  if (manifest === undefined) {
    if (layout.lock !== undefined) {
      fail(
        `${skillPath}/bun.lock: a lockfile with no package.json beside it; commit both or neither`,
      );
    }
    return undefined;
  }
  const declared = new Set<string>();
  for (const field of DEPENDENCY_FIELDS) {
    const entries = manifest[field];
    if (entries === undefined) continue;
    if (!isRecord(entries)) {
      fail(`${rootManifest}: ${field} must be an object of package name to exact version`);
    }
    for (const [name, version] of Object.entries(entries)) {
      if (typeof version !== "string" || !SEMVER.test(version)) {
        fail(
          `${rootManifest}: ${field} entry '${name}' is ${JSON.stringify(version)} -- a skill pins an` +
            ` exact version only (1.2.3; no range, tag, git or file specifier), see ${DEPENDENCIES_DOC}`,
        );
      }
      const rootVersion = layout.rootDevDependencies[name];
      if (rootVersion !== version) {
        const rootState =
          rootVersion === undefined ? "do not list it" : `pin ${JSON.stringify(rootVersion)}`;
        fail(
          `${rootManifest}: ${field} entry '${name}' is ${version} but the root package.json` +
            ` devDependencies ${rootState} -- tsc resolves skill imports from the root node_modules, so` +
            ` both pins stay identical (${DEPENDENCIES_DOC})`,
        );
      }
      declared.add(name);
    }
  }
  if (declared.size === 0) {
    fail(
      `${rootManifest}: declares no dependency; a skill without dependencies ships neither package.json` +
        ` nor bun.lock (${DEPENDENCIES_DOC})`,
    );
  }
  if (layout.lock === undefined) {
    fail(
      `${skillPath}/bun.lock: missing beside a package.json with dependencies; run` +
        ` bun install --lockfile-only --cwd ${skillPath} and commit it (${DEPENDENCIES_DOC})`,
    );
  }
  // A bumped pin with a stale lock lands in a fresh bootstrap directory where `--frozen-lockfile` refuses it at
  // the consumer's first run; this is the author's earlier warning. Pins are compared as one name-to-version map
  // across the fields, since bun records a package named in both dependencies and optionalDependencies once.
  const workspaces = isRecord(layout.lock.workspaces) ? layout.lock.workspaces : undefined;
  const locked = workspaces !== undefined && isRecord(workspaces[""]) ? workspaces[""] : {};
  const declaredPins = mergedPins(manifest);
  const lockedPins = mergedPins(locked);
  if (!isDeepStrictEqual(declaredPins, lockedPins)) {
    fail(
      `${skillPath}/bun.lock: records ${JSON.stringify(lockedPins)} but package.json declares` +
        ` ${JSON.stringify(declaredPins)}; run bun install --lockfile-only --cwd ${skillPath} and commit it`,
    );
  }
  return declared;
}

function mergedPins(fields: Record<string, unknown>): Record<string, unknown> {
  const pins: Record<string, unknown> = {};
  for (const field of DEPENDENCY_FIELDS) {
    const entries = fields[field];
    if (isRecord(entries)) Object.assign(pins, entries);
  }
  return pins;
}

export interface SkillDependencyScope {
  readonly skillPath: string;
  /** Package names the skill's package.json declares; undefined when the skill has none. */
  readonly declared: ReadonlySet<string> | undefined;
}

/** `bun` and `bun:*` are the runtime's own modules; isBuiltin covers `node:*` and the bare builtin names. */
function isRuntimeModule(specifier: string): boolean {
  return /^bun(?::|$)/.test(specifier) || isBuiltin(specifier);
}

/** The package a specifier names: `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
function packageName(specifier: string): string {
  const segments = specifier.split("/");
  return specifier.startsWith("@") ? segments.slice(0, 2).join("/") : (segments[0] ?? specifier);
}

// bun's own transpiler is what a consumer runs, so the requests left after it erases types are the runtime truth:
// `import type`, all-type specifier lists, `typeof import()` and ambient `declare module` bodies vanish (tsc owns
// them), while every form that loads a module, through parentheses, `as const`, `!`, a template or a folded
// concatenation, comes back as one path. A computed `import(Bun.resolveSync(name, DEPS_DIR))`, the bootstrap's
// own form, has no literal path and is left alone. autoImportJSX makes the import bun synthesizes for JSX
// (react/jsx-dev-runtime) visible to the scanner, since a consumer's run loads it like any other package.
const TRANSPILERS = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx", autoImportJSX: true }),
};

export function checkSkillScriptImports(
  displayPath: string,
  sourceText: string,
  scope: SkillDependencyScope,
): void {
  const transpiler = /\.[jt]sx$/.test(displayPath) ? TRANSPILERS.tsx : TRANSPILERS.ts;
  let runtime: string;
  try {
    runtime = transpiler.transformSync(sourceText);
  } catch (error) {
    fail(`${displayPath}: does not parse: ${errorMessage(error)}`);
  }
  for (const { kind, path } of transpiler.scanImports(runtime)) {
    if (/^(?:\.|\/|file:|data:)/.test(path) || isRuntimeModule(path)) continue;
    if (scope.declared === undefined) {
      fail(
        `${displayPath}: imports '${path}' but ${scope.skillPath} has no package.json -- a dependency` +
          ` ships ${scope.skillPath}/package.json + bun.lock and loads through the bootstrap (${DEPENDENCIES_DOC})`,
      );
    }
    if (!scope.declared.has(packageName(path))) {
      fail(
        `${displayPath}: imports '${path}', which ${scope.skillPath}/package.json does not declare` +
          ` (${DEPENDENCIES_DOC})`,
      );
    }
    if (kind === "dynamic-import") {
      fail(
        `${displayPath}: import("${path}") resolves from the user's project, not the skill's` +
          ` dependencies -- import(Bun.resolveSync("${path}", DEPS_DIR)) per the template (${DEPENDENCIES_DOC})`,
      );
    }
    fail(
      `${displayPath}: static import of '${path}' runs before the bootstrap installs it -- load it` +
        ` with the typed dynamic import from the template (${DEPENDENCIES_DOC})`,
    );
  }
}

// Extract a '## <title>' section of the README, with fenced blocks (backtick
// or tilde, e.g. the mermaid graph) and HTML comments removed so they cannot
// contribute entries. Stripping runs to a fixpoint: a single pass can
// reassemble a new `<!--` or fence from the surrounding fragments (CodeQL
// js/incomplete-multi-character-sanitization), letting crafted content hide
// from or leak into the checks.
function readmeSection(readmeText: string, title: string): string {
  const heading = `\n## ${title}\n`;
  const start = readmeText.indexOf(heading);
  if (start === -1) fail(`README.md: missing the '## ${title}' section`);
  const body = readmeText.slice(start + heading.length);
  const end = body.search(/^## /m);
  let area = end === -1 ? body : body.slice(0, end);
  let previous: string;
  do {
    previous = area;
    area = area.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, "").replace(/<!--[\s\S]*?-->/g, "");
  } while (area !== previous);
  return area;
}

// Bijection between README's Available Skills list and skill folders: every
// published skill appears as a linked bullet '- [/name](./skills/name/)', an
// entry whose folder is gone is stale documentation, each link must point at
// the skill's own folder, and a duplicate entry is drift. Only kebab-case
// names count as skill entries, so prose bullets are left alone.
/** Vendored skills sit under '### Xeno' and link into xeno/; our own never do. */
export function checkReadmeSkillList(
  readmeText: string,
  skillNames: ReadonlySet<string>,
  xenoNames: ReadonlySet<string> = new Set(),
): void {
  const scannable = readmeSection(readmeText, "Available Skills");
  const xenoStart = scannable.indexOf("### Xeno");
  if (xenoNames.size > 0 && xenoStart === -1) {
    fail("README.md: missing the '### Xeno' subsection for the vendored skills");
  }
  const nextHeading = xenoStart === -1 ? -1 : scannable.indexOf("\n### ", xenoStart + 1);
  const xenoEnd = nextHeading === -1 ? scannable.length : nextHeading;
  const listed = new Map<string, { target: string; underExternal: boolean }>();
  for (const match of scannable.matchAll(/^- \[\/?([^\]]+)\]\(([^)]+)\)/gm)) {
    const name = (match[1] ?? "").trim();
    if (!KEBAB_CASE.test(name)) continue;
    if (listed.has(name)) {
      fail(`README.md: duplicate Available Skills entry for '${name}'`);
    }
    listed.set(name, {
      target: match[2] ?? "",
      underExternal:
        xenoStart !== -1 && (match.index ?? 0) > xenoStart && (match.index ?? 0) < xenoEnd,
    });
  }
  for (const [name, { target, underExternal }] of listed) {
    const xeno = xenoNames.has(name);
    if (!xeno && !skillNames.has(name)) {
      fail(
        `README.md: '[${name}]' in the Available Skills list has no matching` +
          ` skills/${name}/ folder -- remove the stale entry or restore the folder`,
      );
    }
    const page = `./${xeno ? "xeno" : "skills"}/${name}/SKILL.md`;
    if (target !== page) {
      fail(`README.md: the '[${name}]' entry must link to ${page}`);
    }
    if (xeno !== underExternal) {
      fail(
        `README.md: '${name}' must be listed ${xeno ? "under" : "outside"} '### Xeno'` +
          ` -- it is ${xeno ? "a vendored copy" : "one of this repository's own skills"}`,
      );
    }
  }
  for (const name of [...skillNames, ...xenoNames]) {
    if (!listed.has(name)) {
      fail(`README.md: the Available Skills list is missing an entry for '${name}'`);
    }
  }
}

// The README's mermaid skill-reference graph is stripped out of the list
// checks above (fenced block), so nothing else keeps it honest: a retired
// skill's node, a dangling edge, or a new skill missing from the graph would
// render fine and drift silently. This check reads node definitions, edge
// endpoints, and click targets and holds them to the catalog; whether the
// block renders is the renderer's verdict, not parsed here.
export function checkReadmeMermaidGraph(
  readmeText: string,
  skillNames: ReadonlySet<string>,
  xenoNames: ReadonlySet<string> = new Set(),
): void {
  const fence = /```mermaid\n([\s\S]*?)```/.exec(readmeText);
  if (fence === null) fail("README.md: missing the mermaid skill-reference graph");
  const body = fence[1] ?? "";

  const aliases = new Map<string, string>();
  for (const def of body.matchAll(/([A-Za-z0-9_]+)\["\/([^"\]]*)"\]/g)) {
    const alias = def[1] ?? "";
    const name = def[2] ?? "";
    // 'end' is a reserved flowchart keyword: mermaid silently breaks the
    // rendering instead of erroring, so the graph would pass every check
    // here and still not draw.
    if (alias === "end") {
      fail(
        "README.md: mermaid node alias 'end' is a reserved flowchart keyword" +
          " and breaks rendering -- pick another alias",
      );
    }
    const existing = aliases.get(alias);
    if (existing !== undefined && existing !== name) {
      fail(
        `README.md: mermaid node '${alias}' is defined twice with different labels` +
          ` ('/${existing}' vs '/${name}')`,
      );
    }
    aliases.set(alias, name);
  }

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

  const clicked = new Set<string>();
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    const click = /^click ([A-Za-z0-9_]+) "([^"]*)"$/.exec(line);
    if (click !== null) {
      const alias = click[1] ?? "";
      const name = aliases.get(alias);
      if (name === undefined) {
        fail(`README.md: mermaid click '${line}' references '${alias}', which no node labels`);
      }
      const page = `./${xenoNames.has(name) ? "xeno" : "skills"}/${name}/SKILL.md`;
      if (click[2] !== page) {
        fail(`README.md: mermaid click for '${alias}' must link to ${page}, found '${click[2]}'`);
      }
      if (clicked.has(alias)) fail(`README.md: mermaid node '${alias}' has two click lines`);
      clicked.add(alias);
      continue;
    }
    if (!line.includes("-->")) continue;
    // `a <--> b` is the two-way arrow; its endpoints are the same as `a --> b`'s.
    for (const rawEndpoint of line.replaceAll("<-->", "-->").split("-->")) {
      // The endpoint is an alias, with or without its inline label; nothing else.
      const alias = rawEndpoint.trim().replace(/\["\/[^"\]]*"\]$/, "");
      if (!aliases.has(alias)) {
        fail(
          `README.md: mermaid edge '${line}' references '${alias}', which no node` +
            " definition labels -- a dangling endpoint",
        );
      }
    }
  }
  for (const alias of aliases.keys()) {
    if (!clicked.has(alias)) {
      fail(`README.md: mermaid node '${alias}' has no click line to its SKILL.md`);
    }
  }
}

export interface InvocationGroupingEntry {
  readonly name: string;
  readonly disabled: boolean;
  /** A vendored copy under xeno/: grouped under '### Xeno', not by invocation. */
  readonly xeno?: boolean;
}

// The README's Automatic vs "Invoked by you" grouping must track the
// explicit-invocation flag: a skill sits under "Invoked by you" exactly when
// its frontmatter sets disable-model-invocation. Accurate prose otherwise
// drifts silently the first time someone flips the flag.
export function checkReadmeInvocationGrouping(
  readmeText: string,
  skills: readonly InvocationGroupingEntry[],
): void {
  const area = readmeSection(readmeText, "Available Skills");
  const invokedIndex = area.indexOf("### Invoked by you");
  if (invokedIndex === -1) fail("README.md: missing the '### Invoked by you' subsection");
  const invokedArea = area.slice(invokedIndex);
  for (const { name, disabled, xeno } of skills) {
    if (xeno) continue;
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

// The Usage paragraph names the explicit-invocation-only skills in running
// prose, outside the grouped list the check above covers; nothing else kept
// that roster honest, so a rewrite could name the wrong skills and still
// pass. Scoped to the '## Usage' section (fenced examples stripped) so a
// code block elsewhere cannot satisfy it, and the roster is parsed strictly
// entry by entry so unrecognized text fails instead of hiding: the
// parenthetical must name exactly the skills whose frontmatter sets
// disable-model-invocation.
export function checkReadmeUsageExplicitRoster(
  readmeText: string,
  skills: readonly InvocationGroupingEntry[],
): void {
  const area = readmeSection(readmeText, "Usage");
  const sentence =
    /Skills marked explicit-invocation-only \((.*?)\) load only when you invoke them/.exec(area);
  if (sentence === null) {
    fail(
      "README.md: the Usage section is missing the sentence 'Skills marked" +
        " explicit-invocation-only (<roster>) load only when you invoke them'",
    );
  }
  const named = new Set<string>();
  for (const entry of (sentence[1] ?? "").split(", ")) {
    const link = /^\[`\/([a-z0-9-]+)`\]\(\.\/(?:skills|(xeno))\/\1\/SKILL\.md\)$/.exec(entry);
    if (link === null) {
      fail(
        `README.md: cannot parse Usage explicit-invocation-only roster entry '${entry}'` +
          " -- expected '[`/skill-name`](./skills/skill-name/SKILL.md)' entries separated by ', '",
      );
    }
    const name = link[1] ?? "";
    if (named.has(name)) {
      fail(`README.md: duplicate Usage explicit-invocation-only roster entry for '${name}'`);
    }
    named.add(name);
    const xeno = skills.find((skill) => skill.name === name)?.xeno === true;
    if (xeno !== (link[2] !== undefined)) {
      fail(
        `README.md: the Usage roster entry for '${name}' must link to` +
          ` ./${xeno ? "xeno" : "skills"}/${name}/SKILL.md`,
      );
    }
  }
  const known = new Set(skills.map(({ name }) => name));
  for (const name of named) {
    if (!known.has(name)) {
      fail(
        `README.md: the Usage explicit-invocation-only roster names '${name}', which is not` +
          " a published skill -- remove the stale entry",
      );
    }
  }
  for (const { name, disabled } of skills) {
    if (disabled && !named.has(name)) {
      fail(
        `README.md: the Usage explicit-invocation-only roster is missing '${name}',` +
          " whose frontmatter sets disable-model-invocation: true",
      );
    }
    if (!disabled && named.has(name)) {
      fail(
        `README.md: the Usage explicit-invocation-only roster names '${name}',` +
          " whose frontmatter does not set disable-model-invocation: true",
      );
    }
  }
}
