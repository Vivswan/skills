/**
 * Parameterized consistency checks extracted from smoke.mts so they can
 * be unit-tested: importing smoke.mts executes the whole smoke run, so
 * anything a test needs lives here instead. Callers do the file IO and pass
 * content plus display paths; these functions only judge the content and
 * throw CheckFailure (via fail) on a violation.
 */

import { isBuiltin } from "node:module";
import { posix } from "node:path";
import { parse } from "@babel/parser";
import { type Node, traverseFast } from "@babel/types";
import type { Frontmatter } from "./lib.mts";
import { errorMessage, fail, isRecord, KEBAB_CASE } from "./lib.mts";

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

  /** The parsed SKILL.md frontmatter, read for its disable-model-invocation key. */
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

/** semver.org's own pattern, so a range, a tag, or a git or file specifier never reads as an exact pin. */
export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

/** The docs/authoring.md section every dependency message points at; ensureBuiltTemplate reads the same heading. */
const DEPENDENCIES_DOC = "docs/authoring.md > Dependencies";

/** The extensions a skill script may carry, in bun's resolution order. */
export const SCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/** The other package.json dependency fields: a skill's pins are one list, under dependencies. */
const OTHER_DEPENDENCY_FIELDS = ["devDependencies", "optionalDependencies", "peerDependencies"];

export interface SkillDependencyLayout {
  /** The skill's display path, e.g. skills/working-text. */
  readonly skillPath: string;

  /** Display paths of every package.json under the skill, node_modules and .build excluded. */
  readonly manifestPaths: readonly string[];

  /** Display paths of every node_modules directory under the skill. */
  readonly nodeModulesPaths: readonly string[];

  /** Display paths of every lockfile under the skill. */
  readonly lockfilePaths: readonly string[];

  /** The parsed skills/<name>/package.json, when the skill root carries one. */
  readonly manifest: Record<string, unknown> | undefined;

  /** The root package.json devDependencies: where tsc resolves every skill import. */
  readonly rootDevDependencies: Record<string, unknown>;
}

function checkDependencyFiles(layout: SkillDependencyLayout): void {
  for (const path of layout.nodeModulesPaths) {
    fail(
      `${path}: node_modules under a skill folder; a script installs its pins for the build's duration only,` +
        ` and the bundle it leaves lives in .build/ (${DEPENDENCIES_DOC})`,
    );
  }
  for (const path of layout.lockfilePaths) {
    fail(
      `${path}: a lockfile under a skill folder; the exact pins in package.json are the lock (${DEPENDENCIES_DOC})`,
    );
  }
  const rootManifest = `${layout.skillPath}/package.json`;
  for (const path of layout.manifestPaths) {
    if (path !== rootManifest) {
      fail(
        `${path}: a skill's package.json sits at ${rootManifest}, nowhere deeper (${DEPENDENCIES_DOC})`,
      );
    }
  }
}

function checkDependencyPin(
  rootManifest: string,
  name: string,
  version: unknown,
  rootVersion: unknown,
): void {
  if (typeof version !== "string" || !SEMVER.test(version)) {
    fail(
      `${rootManifest}: dependencies entry '${name}' is ${JSON.stringify(version)} -- a skill pins an` +
        ` exact version only (1.2.3; no range, tag, git or file specifier), see ${DEPENDENCIES_DOC}`,
    );
  }
  if (rootVersion !== version) {
    const rootState =
      rootVersion === undefined ? "do not list it" : `pin ${JSON.stringify(rootVersion)}`;
    fail(
      `${rootManifest}: dependencies entry '${name}' is ${version} but the root package.json` +
        ` devDependencies ${rootState} -- tsc resolves skill imports from the root node_modules, so` +
        ` both pins stay identical (${DEPENDENCIES_DOC})`,
    );
  }
}

// Why exact pins and a root pin of the same version: the skill's package.json is the list bun installs before a
// script's bundle is built (the ensureBuilt block in docs/authoring.md), while tsc resolves the same bare import
// against the root node_modules; one version in both places keeps the code that runs the code that was checked.
export function checkSkillDependencies(
  layout: SkillDependencyLayout,
): ReadonlySet<string> | undefined {
  const { skillPath, manifest } = layout;
  checkDependencyFiles(layout);
  if (manifest === undefined) return undefined;

  const rootManifest = `${skillPath}/package.json`;
  for (const field of OTHER_DEPENDENCY_FIELDS) {
    if (manifest[field] !== undefined) {
      fail(
        `${rootManifest}: ${field}: a skill declares its packages under dependencies only, the one list` +
          ` the install reads, the root mirrors, and the bundle holds (${DEPENDENCIES_DOC})`,
      );
    }
  }
  const entries = manifest.dependencies;
  if (entries !== undefined && !isRecord(entries)) {
    fail(`${rootManifest}: dependencies must be an object of package name to exact version`);
  }
  const declared = new Set<string>();
  for (const [name, version] of Object.entries(entries ?? {})) {
    checkDependencyPin(rootManifest, name, version, layout.rootDevDependencies[name]);
    declared.add(name);
  }
  if (declared.size === 0) {
    fail(
      `${rootManifest}: declares no dependency; a skill without dependencies ships no package.json` +
        ` (${DEPENDENCIES_DOC})`,
    );
  }
  return declared;
}

export interface SkillScript {
  /** Display path, e.g. skills/x/scripts/x.mts. */
  readonly path: string;

  /** The source as committed; the ensureBuilt block is matched in it byte for byte. */
  readonly text: string;
}

export interface SkillScriptScope {
  /** The skill's display path, e.g. skills/working-text. */
  readonly skillPath: string;

  /** Package names the skill's package.json declares; undefined when the skill has none. */
  readonly declared: ReadonlySet<string> | undefined;

  /** The ensureBuilt block as docs/authoring.md prints it. */
  readonly buildBlock: string;
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
// them), while every form that loads a module, static, dynamic or require, comes back as one path. autoImportJSX
// makes the import bun synthesizes for JSX (react/jsx-dev-runtime) visible, since a bundle holds it like any package.

const TRANSPILERS = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx", autoImportJSX: true }),
};

interface RuntimeImport {
  /** The specifier as written: a package name with its subpath, or a relative path. */
  readonly path: string;

  /** A static ESM import, hoisted above every statement; `await import()` and `require()` run where they stand. */
  readonly hoisted: boolean;

  /** Offset of an in-place load in the type-erased text, or -1 for a hoisted import or one not found there. */
  readonly position: number;
}

interface RuntimeImports {
  /** The loads of a package, bare or scoped; runtime modules (node:, bun:) are left out. */
  readonly packages: readonly RuntimeImport[];

  /** The loads of a ./ or ../ path, which resolve among the skill's own scripts. */
  readonly relatives: readonly RuntimeImport[];

  /** Offset of `function ensureBuilt` in the type-erased text, or -1 without a block. */
  readonly blockAt: number;
}

interface LoadSites {
  /** Each literal specifier's `import("x")` and `require("x")` offsets, in source order. */
  readonly loads: ReadonlyMap<string, number[]>;

  /** Offset of `function ensureBuilt` in the type-erased text, or -1 without a block. */
  readonly blockAt: number;
}

/** The literal specifier of an `import("x")` or `require("x")` node, or undefined for any other node. */
function loadRequest(node: Node): string | undefined {
  if (node.type === "ImportExpression" && node.source.type === "StringLiteral") {
    return node.source.value;
  }
  if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return undefined;

  const [first] = node.arguments;
  if (node.callee.name === "require" && first?.type === "StringLiteral") return first.value;

  return undefined;
}

// Positions come from an AST of the erased text, never from searching it: a string or comment that spells
// `import("x")` or `function ensureBuilt(` is text there, and `import("x", { with: ... })` is still a load.
function loadSites(runtime: string, displayPath: string): LoadSites {
  let program: ReturnType<typeof parse>;
  try {
    program = parse(runtime, {
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowUndeclaredExports: true,
    });
  } catch (error) {
    fail(`${displayPath}: the type-erased text does not parse (${errorMessage(error)})`);
  }
  const loads = new Map<string, number[]>();
  let blockAt = -1;
  traverseFast(program, (node) => {
    const request = loadRequest(node);
    if (request !== undefined) {
      loads.set(request, [...(loads.get(request) ?? []), node.start ?? -1]);
    }
    if (blockAt === -1 && node.type === "FunctionDeclaration" && node.id?.name === "ensureBuilt") {
      blockAt = node.start ?? -1;
    }
  });
  return { loads, blockAt };
}

/** The package and relative specifiers a script loads at runtime, each with where its load stands. */
function runtimeImports(script: SkillScript): RuntimeImports {
  const transpiler = /\.[jt]sx$/.test(script.path) ? TRANSPILERS.tsx : TRANSPILERS.ts;
  let runtime: string;
  try {
    runtime = transpiler.transformSync(script.text);
  } catch (error) {
    fail(`${script.path}: does not parse: ${errorMessage(error)}`);
  }
  const sites = loadSites(runtime, script.path);
  const packages: RuntimeImport[] = [];
  const relatives: RuntimeImport[] = [];
  // scanImports lists loads in source order, so the n-th in-place load of a specifier is its n-th site.
  for (const { kind, path } of transpiler.scanImports(runtime)) {
    const hoisted = kind === "import-statement";
    const position = hoisted ? -1 : (sites.loads.get(path)?.shift() ?? -1);
    const entry = { path, hoisted, position };
    if (/^\.\.?\//.test(path)) relatives.push(entry);
    else if (!/^(?:\/|file:|data:)/.test(path) && !isRuntimeModule(path)) packages.push(entry);
  }
  return { packages, relatives, blockAt: sites.blockAt };
}

/** The runtime imports of every script of one skill, by display path. */
type SkillImports = ReadonlyMap<string, RuntimeImports>;

function checkPackagesDeclared(
  script: SkillScript,
  packages: readonly RuntimeImport[],
  scope: SkillScriptScope,
): void {
  for (const { path } of packages) {
    if (scope.declared === undefined) {
      fail(
        `${script.path}: imports '${path}' but ${scope.skillPath} has no package.json -- a dependency is` +
          ` declared in ${scope.skillPath}/package.json and bundled on first run (${DEPENDENCIES_DOC})`,
      );
    }
    if (!scope.declared.has(packageName(path))) {
      fail(
        `${script.path}: imports '${path}', which ${scope.skillPath}/package.json does not declare` +
          ` (${DEPENDENCIES_DOC})`,
      );
    }
  }
}

// Relative imports resolve among the skill's own scripts as bun resolves them: the path as written, a
// .js-family extension standing for the TypeScript file, an extension added, or a directory's index file.
// One resolving to no script (a JSON file) holds no package.
function resolveRelative(
  imports: SkillImports,
  from: string,
  specifier: string,
): string | undefined {
  const target = posix.normalize(posix.join(posix.dirname(from), specifier));
  const stem = target.replace(/\.(?:[mc]?js|jsx)$/, "");
  const candidates = [
    target,
    ...SCRIPT_EXTENSIONS.map((ext) => `${stem}${ext}`),
    ...SCRIPT_EXTENSIONS.map((ext) => posix.join(target, `index${ext}`)),
  ];
  return candidates.find((candidate) => imports.has(candidate));
}

/** Whether a script's bundle would hold a package, through its own imports or a relative import's. */
function needsBundle(imports: SkillImports, path: string, visiting: ReadonlySet<string>): boolean {
  if (visiting.has(path)) return false;
  const found = imports.get(path);
  if (found === undefined) return false;
  const inner = new Set([...visiting, path]);
  return (
    found.packages.length > 0 ||
    found.relatives.some((entry) => {
      const target = resolveRelative(imports, path, entry.path);
      return target !== undefined && needsBundle(imports, target, inner);
    })
  );
}

function checkEnsureBuiltBlock(
  script: SkillScript,
  imports: SkillImports,
  scope: SkillScriptScope,
): void {
  const carries = script.text.includes(scope.buildBlock);
  const hasSome = script.text.includes("function ensureBuilt(");
  const found = imports.get(script.path);
  if (found === undefined || !needsBundle(imports, script.path, new Set())) {
    if (hasSome) {
      fail(
        `${script.path}: carries an ensureBuilt block but loads no package; the block makes bun a requirement,` +
          ` so a dependency-free script has none (${DEPENDENCIES_DOC})`,
      );
    }
    return;
  }

  // ESM hoists a static import above the guard, where the source path would resolve the package through
  // bun's unpinned auto-install; a static import of a sibling that loads packages is the same, one step
  // away. An in-place load written above the block runs before the guard just the same.
  const reaching = (entry: RuntimeImport): boolean => {
    const target = resolveRelative(imports, script.path, entry.path);
    return target !== undefined && needsBundle(imports, target, new Set());
  };
  const loads = [...found.packages, ...found.relatives.filter(reaching)];
  for (const entry of loads.filter((entry) => entry.hoisted)) {
    fail(
      `${script.path}: static import of '${entry.path}' is hoisted above the ensureBuilt guard, so the` +
        ` source path resolves it before the bundle exists; load it below the guard with await import()` +
        ` (${DEPENDENCIES_DOC})`,
    );
  }
  for (const entry of loads) {
    if (entry.position >= 0 && found.blockAt >= 0 && entry.position < found.blockAt) {
      fail(
        `${script.path}: loads '${entry.path}' above the ensureBuilt block, so the source path resolves it` +
          ` before the guard decides; move the load below the guard (${DEPENDENCIES_DOC})`,
      );
    }
  }
  if (!carries) {
    fail(
      `${script.path}: loads a package, directly or through a relative import, ${
        hasSome
          ? "but its ensureBuilt block differs from the template; paste it again"
          : "so it carries the ensureBuilt block above its program"
      } (${DEPENDENCIES_DOC})`,
    );
  }
}

/**
 * Every package a skill's scripts load is declared in its package.json, and every script whose bundle would
 * hold a package, through its own imports or a relative import's, carries the ensureBuilt block byte for
 * byte and loads those packages and siblings below its guard with `await import()`. A script that needs no
 * bundle carries no block: the block makes bun a requirement.
 */
export function checkSkillScripts(scripts: readonly SkillScript[], scope: SkillScriptScope): void {
  const imports = new Map<string, RuntimeImports>();
  for (const script of scripts) {
    const found = runtimeImports(script);
    checkPackagesDeclared(script, found.packages, scope);
    imports.set(script.path, found);
  }
  for (const script of scripts) checkEnsureBuiltBlock(script, imports, scope);
}

/** The ensureBuilt block as docs/authoring.md prints it: the first ts fence of the Dependencies section. */
export function ensureBuiltTemplate(docText: string, displayPath = "docs/authoring.md"): string {
  const heading = "\n## Dependencies\n";
  const start = docText.indexOf(heading);
  if (start === -1) fail(`${displayPath}: missing the '## Dependencies' section`);
  const section = docText.slice(start + heading.length).split("\n## ")[0] ?? "";
  const fence = /```ts\n([\s\S]*?)```\n/.exec(section);
  if (fence?.[1] === undefined || !fence[1].includes("function ensureBuilt(")) {
    fail(`${displayPath}: the Dependencies section has no ts fence holding function ensureBuilt`);
  }
  return fence[1];
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

/** A skill of another repository, published by a marketplace entry whose source is a git-subdir object. */
export interface UpstreamSkill {
  /** The entry's name, which is the skill's install name. */
  readonly name: string;

  /** The upstream repository as GitHub owner/repo. */
  readonly repo: string;

  /** The skill folder inside it, repository-relative. */
  readonly path: string;

  /** The entry's `metadata["disable-model-invocation"]`: both install commands mark the installed copy. */
  readonly explicitOnly: boolean;
}

/** The GitHub page of an upstream skill's folder at its default branch head, where the README links to it. */
export function upstreamPage(skill: UpstreamSkill): string {
  return `https://github.com/${skill.repo}/tree/HEAD/${skill.path}`;
}

const UPSTREAM_HEADING = "### Upstream skills";

/** One linked bullet of the Available Skills list: its link target and whether it sits under the upstream subsection. */
interface ListedSkill {
  readonly target: string;
  readonly underUpstream: boolean;
}

/** The kebab-case bullets of the section by name; a prose bullet is left alone, a duplicate is drift. */
function listedSkills(
  scannable: string,
  upstreamStart: number,
  upstreamEnd: number,
): Map<string, ListedSkill> {
  const listed = new Map<string, ListedSkill>();
  for (const match of scannable.matchAll(/^- \[\/?([^\]]+)\]\(([^)]+)\)/gm)) {
    const name = (match[1] ?? "").trim();
    if (!KEBAB_CASE.test(name)) continue;
    if (listed.has(name)) {
      fail(`README.md: duplicate Available Skills entry for '${name}'`);
    }
    listed.set(name, {
      target: match[2] ?? "",
      underUpstream:
        upstreamStart !== -1 &&
        (match.index ?? 0) > upstreamStart &&
        (match.index ?? 0) < upstreamEnd,
    });
  }
  return listed;
}

/** One listed entry against the catalog: a folder of this repository or an upstream page, the link that goes with it, the right subsection. */
function checkListedSkill(
  name: string,
  entry: ListedSkill,
  page: string | undefined,
  skillNames: ReadonlySet<string>,
): void {
  if (page === undefined && !skillNames.has(name)) {
    fail(
      `README.md: '[${name}]' in the Available Skills list has no matching` +
        ` skills/${name}/ folder -- remove the stale entry or restore the folder`,
    );
  }
  const wanted = page ?? `./skills/${name}/SKILL.md`;
  if (entry.target !== wanted) {
    fail(`README.md: the '[${name}]' entry must link to ${wanted}`);
  }
  if ((page !== undefined) !== entry.underUpstream) {
    fail(
      `README.md: '${name}' must be listed ${page === undefined ? "outside" : "under"}` +
        ` '${UPSTREAM_HEADING}' -- it is ${page === undefined ? "one of this repository's own skills" : "an upstream skill"}`,
    );
  }
}

// Bijection between README's Available Skills list and skill folders: every
// published skill appears as a linked bullet '- [/name](./skills/name/)', an
// entry whose folder is gone is stale documentation, each link must point at
// the skill's own folder, and a duplicate entry is drift. Only kebab-case
// names count as skill entries, so prose bullets are left alone.
/** Upstream skills sit under '### Upstream skills' and link to their upstream folder; our own never do. */
export function checkReadmeSkillList(
  readmeText: string,
  skillNames: ReadonlySet<string>,
  upstream: readonly UpstreamSkill[] = [],
): void {
  const scannable = readmeSection(readmeText, "Available Skills");
  const upstreamStart = scannable.indexOf(UPSTREAM_HEADING);
  if (upstream.length > 0 && upstreamStart === -1) {
    fail(`README.md: missing the '${UPSTREAM_HEADING}' subsection for the upstream skills`);
  }
  const nextHeading = upstreamStart === -1 ? -1 : scannable.indexOf("\n### ", upstreamStart + 1);
  const upstreamEnd = nextHeading === -1 ? scannable.length : nextHeading;
  const listed = listedSkills(scannable, upstreamStart, upstreamEnd);
  const pages = new Map(upstream.map((skill) => [skill.name, upstreamPage(skill)]));
  for (const [name, entry] of listed) {
    checkListedSkill(name, entry, pages.get(name), skillNames);
  }
  for (const name of [...skillNames, ...pages.keys()]) {
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
/** The graph's node definitions, alias to skill name; a node defined twice must keep its label. */
function mermaidAliases(body: string): Map<string, string> {
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
  return aliases;
}

/** One node per skill of the catalog and one skill per node. */
function checkMermaidNodes(
  aliases: ReadonlyMap<string, string>,
  skillNames: ReadonlySet<string>,
): void {
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
}

/** The node a click line names, once its target is that node's page. */
function clickedAlias(
  line: string,
  click: RegExpExecArray,
  aliases: ReadonlyMap<string, string>,
  pages: ReadonlyMap<string, string>,
): string {
  const alias = click[1] ?? "";
  const name = aliases.get(alias);
  if (name === undefined) {
    fail(`README.md: mermaid click '${line}' references '${alias}', which no node labels`);
  }
  const page = pages.get(name) ?? `./skills/${name}/SKILL.md`;
  if (click[2] !== page) {
    fail(`README.md: mermaid click for '${alias}' must link to ${page}, found '${click[2]}'`);
  }
  return alias;
}

function checkMermaidEdge(line: string, aliases: ReadonlyMap<string, string>): void {
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

/** Every click line targets a defined node's page, each node has one, and every edge endpoint is a defined node. */
function checkMermaidClicksAndEdges(
  body: string,
  aliases: ReadonlyMap<string, string>,
  pages: ReadonlyMap<string, string>,
): void {
  const clicked = new Set<string>();
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    const click = /^click ([A-Za-z0-9_]+) "([^"]*)"$/.exec(line);
    if (click !== null) {
      const alias = clickedAlias(line, click, aliases, pages);
      if (clicked.has(alias)) fail(`README.md: mermaid node '${alias}' has two click lines`);
      clicked.add(alias);
      continue;
    }
    if (line.includes("-->")) checkMermaidEdge(line, aliases);
  }
  for (const alias of aliases.keys()) {
    if (!clicked.has(alias)) {
      fail(`README.md: mermaid node '${alias}' has no click line to its SKILL.md`);
    }
  }
}

export function checkReadmeMermaidGraph(
  readmeText: string,
  skillNames: ReadonlySet<string>,
  upstream: readonly UpstreamSkill[] = [],
): void {
  const fence = /```mermaid\n([\s\S]*?)```/.exec(readmeText);
  if (fence === null) fail("README.md: missing the mermaid skill-reference graph");
  const body = fence[1] ?? "";

  const aliases = mermaidAliases(body);
  checkMermaidNodes(aliases, skillNames);

  const pages = new Map(upstream.map((skill) => [skill.name, upstreamPage(skill)]));
  checkMermaidClicksAndEdges(body, aliases, pages);
}

// The README names the upstream skills the install commands mark explicit-invocation-only; the
// marketplace's metadata flags are what the commands read, so the two would drift apart silently.
// The sentence under '### Upstream skills' must name exactly the flagged entries, parsed entry by
// entry so unrecognized text fails instead of hiding.
export function checkReadmeExplicitUpstreams(
  readmeText: string,
  upstream: readonly UpstreamSkill[],
): void {
  const flagged = upstream.filter((skill) => skill.explicitOnly).map((skill) => skill.name);
  const area = readmeSection(readmeText, "Available Skills");
  const sentence = /^Installed by [^,]+, (.+?) load only when you invoke (?:it|them)/m.exec(area);
  if (sentence === null) {
    if (flagged.length === 0) return;
    fail(
      "README.md: the Upstream skills subsection is missing the sentence 'Installed by <the two" +
        " commands>, <roster> load only when you invoke them'",
    );
  }
  const named: string[] = [];
  for (const entry of (sentence[1] ?? "").split(/, and |, | and /)) {
    const name = /^`([a-z0-9-]+)`$/.exec(entry)?.[1];
    if (name === undefined) {
      fail(
        `README.md: cannot parse explicit-invocation-only upstream roster entry '${entry}'` +
          " -- expected backticked skill names separated by ', ' and ', and '",
      );
    }
    named.push(name);
  }
  const want = [...flagged].sort().join(", ");
  const got = [...named].sort().join(", ");
  if (want !== got) {
    fail(
      `README.md: the explicit-invocation-only upstream roster names [${got}], the marketplace` +
        ` flags [${want}] -- the two must agree`,
    );
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
  const area = readmeSection(readmeText, "Available Skills");
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
