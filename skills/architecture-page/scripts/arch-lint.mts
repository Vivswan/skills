#!/usr/bin/env bun
// One layering declaration (architecture.yml), two readers: this lint and the
// module map. The lint fails in both directions so the declaration cannot rot:
//   import between layers with no declared edge  -> "forbidden import", exit 1
//   declared edge no file draws                  -> "stale allowance", exit 1
//   computed import() or require()               -> exit 2, never a silently dropped edge
//
// An edge is any way one file names another: runtime imports, type-only
// imports, re-exports, `import("./x").T` in a type position, and
// `import X = require("./x")`. Only relative specifiers are edges; a path
// alias is invisible here, so the declaration names the tree, not the alias.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Node, parseSync as ParseSync } from "oxc-parser";

// The adopting repository adds the parser (bun add -d oxc-parser); a copied
// script without it says so once instead of failing on a missing module path.
export const parseSync: typeof ParseSync = await (async () => {
  try {
    return (await import("oxc-parser")).parseSync;
  } catch {
    console.error("architecture-page scripts need oxc-parser: bun add -d oxc-parser");
    process.exit(2);
  }
})();

export const DEFAULT_CONFIG = "architecture.yml";

export interface Architecture {
  /** layer -> the repo-relative paths it owns; a trailing slash means a directory. */
  readonly layers: Readonly<Record<string, readonly string[]>>;
  /** Glob patterns of files that are not sources of the graph (tests, fixtures). An import INTO one is still an edge. */
  readonly exclude: readonly string[];
  /** from -> the layers it may import; a layer absent here imports nothing outside itself. */
  readonly edges: Readonly<Record<string, readonly string[]>>;
}

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringListRecord(value: unknown): value is Record<string, string[]> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isStringList)
  );
}

/** The declaration at `path`, shape-checked: a typo in a layer name under edges is an error here, not a silent pass. */
export function readArchitecture(path: string, label = path): Architecture {
  const parsed: unknown = Bun.YAML.parse(readFileSync(path, "utf8"));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${label}: the declaration must be a mapping with layers, exclude, and edges`);
  }
  const { layers, exclude = [], edges = {} } = parsed as Record<string, unknown>;
  if (!isStringListRecord(layers) || Object.keys(layers).length === 0) {
    throw new Error(`${label}: layers must map each layer name to a list of paths`);
  }
  if (!isStringList(exclude)) {
    throw new Error(`${label}: exclude must be a list of glob patterns`);
  }
  if (!isStringListRecord(edges)) {
    throw new Error(`${label}: edges must map each layer name to a list of layer names`);
  }
  for (const [from, targets] of Object.entries(edges)) {
    for (const name of [from, ...targets]) {
      if (!(name in layers)) {
        throw new Error(`${label}: edges name "${name}", which is not a layer`);
      }
    }
  }
  // layerOf takes the first match in YAML order, so an overlap would hand
  // one layer's files to another silently; the declaration refuses it instead.
  const owned = Object.entries(layers).flatMap(([layer, paths]) =>
    paths.map((path) => ({ layer, path })),
  );
  for (const [i, a] of owned.entries()) {
    for (const b of owned.slice(i + 1)) {
      if (a.layer === b.layer) continue;
      const overlap =
        a.path === b.path ||
        (a.path.endsWith("/") && b.path.startsWith(a.path)) ||
        (b.path.endsWith("/") && a.path.startsWith(b.path));
      if (overlap) {
        const inner = a.path.length >= b.path.length ? a.path : b.path;
        throw new Error(
          `${label}: layers ${a.layer} and ${b.layer} overlap on ${inner}; a file has one owner`,
        );
      }
    }
  }
  return { layers, exclude, edges };
}

/** The layer owning a repo-relative path, or undefined. */
export function layerOf(arch: Architecture, path: string): string | undefined {
  return Object.entries(arch.layers).find(([, paths]) =>
    paths.some((owned) => (owned.endsWith("/") ? path.startsWith(owned) : path === owned)),
  )?.[0];
}

// --- source scanning ---------------------------------------------------------

/** Every AST node under `value`, in source order. */
export function* nodesOf(value: unknown): Generator<Node> {
  if (Array.isArray(value)) {
    for (const item of value) yield* nodesOf(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if ("type" in value && typeof value.type === "string") yield value as Node;
  for (const [key, child] of Object.entries(value)) {
    if (key !== "parent") yield* nodesOf(child);
  }
}

/** `node` without its parentheses and `!` wrappers: `(require)("./m")` and `require!("./m")` load like `require("./m")`. */
function unwrapped(node: Node): Node {
  let current = node;
  while (current.type === "ParenthesizedExpression" || current.type === "TSNonNullExpression") {
    current = current.expression;
  }
  return current;
}

/** The string a literal or substitution-free template specifier holds, else undefined. */
function literalSpecifier(node: Node | null | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join("");
  }
  return undefined;
}

/**
 * Every relative specifier `text` names, runtime and type-level alike. A
 * computed `import(x)` or `require(x)` throws, naming file and line: a missing
 * edge is the one failure this lint exists to catch, so the file is rewritten, not skipped.
 */
export function importSpecifiers(text: string, file: string): string[] {
  const { program, module, errors } = parseSync(file, text);
  const lineOf = (offset: number): number => text.slice(0, offset).split("\n").length;
  const [error] = errors;
  if (error) {
    throw new Error(
      `${file}:${lineOf(error.labels[0]?.start ?? 0)} does not parse: ${error.message}`,
    );
  }
  const found = new Set<string>();
  for (const entry of module.staticImports) found.add(entry.moduleRequest.value);
  for (const statement of module.staticExports) {
    for (const entry of statement.entries) {
      if (entry.moduleRequest) found.add(entry.moduleRequest.value);
    }
  }
  const computed = (offset: number): never => {
    throw new Error(
      `${file}:${lineOf(offset)} loads a module through a computed specifier, which the import graph cannot follow; use a string literal`,
    );
  };
  for (const node of nodesOf(program)) {
    if (node.type === "ImportExpression") {
      found.add(literalSpecifier(node.source) ?? computed(node.start));
    } else if (node.type === "CallExpression") {
      const callee = unwrapped(node.callee);
      if (callee.type === "Identifier" && callee.name === "require") {
        found.add(literalSpecifier(node.arguments[0]) ?? computed(node.start));
      }
    } else if (node.type === "TSImportType") {
      found.add(node.source.value);
    } else if (node.type === "TSExternalModuleReference") {
      found.add(node.expression.value);
    }
  }
  return [...found].filter((specifier) => /^\.\.?\//.test(specifier));
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** The file `specifier` names from `importer`, trying the source extensions and index files; nothing found throws. */
export function resolveImport(importer: string, specifier: string): string {
  const target = resolve(dirname(importer), specifier);
  if (isFile(target)) return target;
  const stem = target.replace(/\.(?:[mc]?[jt]sx?)$/, "");
  const candidates = [
    ...SOURCE_EXTENSIONS.map((ext) => `${stem}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => join(target, `index${ext}`)),
  ];
  const found = candidates.find(isFile);
  if (found === undefined) {
    throw new Error(
      `${importer} imports "${specifier}", which resolves to no file (tried ${candidates.join(", ")})`,
    );
  }
  return found;
}

// --- the lint ----------------------------------------------------------------

function toPosix(path: string): string {
  return path.split("\\").join("/");
}

/** The top-level directories the layers live in, so a file beside them outside every layer is seen. */
function scanRoots(arch: Architecture): string[] {
  const roots = new Set<string>();
  for (const paths of Object.values(arch.layers)) {
    for (const path of paths) {
      const [head] = path.split("/");
      if (head !== undefined && head !== "" && path.includes("/")) roots.add(head);
    }
  }
  return [...roots].sort();
}

/**
 * The lint verdict for the tree at `root`. Empty means the declaration is
 * exactly the tree. `configLabel` is how the messages name the declaration file.
 */
export function lintArchitecture(
  root: string,
  arch: Architecture,
  configLabel = DEFAULT_CONFIG,
): string[] {
  const excluded = arch.exclude.map((pattern) => new Bun.Glob(pattern));
  const drawn = new Map<string, string[]>();
  const problems: string[] = [];
  for (const [layer, paths] of Object.entries(arch.layers)) {
    for (const path of paths) {
      if (!existsSync(join(root, path))) {
        problems.push(`layer ${layer} names ${path}, which does not exist`);
      }
    }
  }
  const files: string[] = [];
  for (const scanRoot of scanRoots(arch)) {
    if (!existsSync(join(root, scanRoot))) continue;
    for (const entry of readdirSync(join(root, scanRoot), { recursive: true, encoding: "utf8" })) {
      const file = toPosix(join(scanRoot, entry));
      if (!SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext))) continue;
      if (!isFile(join(root, file))) continue;
      if (excluded.some((glob) => glob.match(file))) continue;
      files.push(file);
    }
  }
  for (const file of files.sort()) {
    const from = layerOf(arch, file);
    if (from === undefined) {
      problems.push(`${file} belongs to no layer in ${configLabel}`);
      continue;
    }
    const absolute = join(root, file);
    for (const specifier of importSpecifiers(readFileSync(absolute, "utf8"), file)) {
      const target = toPosix(relative(root, resolveImport(absolute, specifier)));
      const to = layerOf(arch, target);
      if (to === undefined) {
        problems.push(`${target} (imported by ${file}) belongs to no layer in ${configLabel}`);
      } else if (to !== from) {
        const key = `${from} -> ${to}`;
        drawn.set(key, [...(drawn.get(key) ?? []), `${file} -> ${target}`]);
      }
    }
  }
  const declared = new Set(
    Object.entries(arch.edges).flatMap(([from, targets]) =>
      targets.map((to) => `${from} -> ${to}`),
    ),
  );
  for (const [key, sites] of [...drawn].sort()) {
    if (!declared.has(key)) {
      problems.push(`forbidden import ${key}: ${sites.join(", ")}; move it or declare the edge`);
    }
  }
  for (const key of [...declared].sort()) {
    if (!drawn.has(key)) {
      problems.push(`stale allowance ${key}: no file draws it; remove it from ${configLabel}`);
    }
  }
  return problems;
}

/** The module map over the DECLARED edges; a hyphen in a layer name is edge syntax to mermaid, so ids use underscores. */
export function renderArchitectureMermaid(arch: Architecture): string {
  const id = (layer: string): string => layer.replace(/-/g, "_");
  return [
    "graph TD",
    ...Object.entries(arch.layers).map(([name, paths]) => `  ${id(name)}["${paths.join("<br>")}"]`),
    ...Object.entries(arch.edges).flatMap(([from, targets]) =>
      targets.map((to) => `  ${id(from)} --> ${id(to)}`),
    ),
  ].join("\n");
}

// --- CLI ---------------------------------------------------------------------

const USAGE = [
  "usage: arch-lint.mts [--config <architecture.yml>] [--root <dir>] [--mermaid]",
  "  --config   the layering declaration (default: <root>/architecture.yml)",
  "  --root     the repository root the paths are relative to (default: cwd)",
  "  --mermaid  print the module map instead of linting",
  "exit 0: the tree matches the declaration; 1: forbidden or stale edges; 2: usage or an unreadable graph",
].join("\n");

export interface CliOptions {
  root: string;
  config: string;
  mermaid: boolean;
}

/** How messages name `path`: relative to `root` when it lives inside, absolute otherwise. Symlinked temp dirs compare by real path. */
export function pathLabel(root: string, path: string): string {
  const real = (candidate: string): string =>
    existsSync(candidate) ? realpathSync(candidate) : candidate;
  const rel = toPosix(relative(real(root), real(path)));
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? toPosix(path) : rel;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let root = process.cwd();
  let config: string | undefined;
  let mermaid = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    if (arg === "--root") root = resolve(value());
    else if (arg === "--config") config = resolve(value());
    else if (arg === "--mermaid") mermaid = true;
    else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  return { root, config: config ?? join(root, DEFAULT_CONFIG), mermaid };
}

if (import.meta.main) {
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const configLabel = pathLabel(options.root, options.config);
  try {
    const arch = readArchitecture(options.config, configLabel);
    if (options.mermaid) {
      console.log(renderArchitectureMermaid(arch));
      process.exit(0);
    }
    const problems = lintArchitecture(options.root, arch, configLabel);
    if (problems.length > 0) {
      console.error(`arch-lint: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`);
      process.exit(1);
    }
    console.log(`arch-lint: imports under ${scanRoots(arch).join(", ")} match ${configLabel}`);
  } catch (error) {
    console.error(`arch-lint: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
}
