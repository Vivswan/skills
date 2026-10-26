// How a source file is read: its module record (imports, exports, re-exports)
// and every relative specifier it names, resolved to a file. lint.mts walks the
// import graph through it; check-page.mts reads a file's exported names.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { ParserPlugin } from "@babel/parser";
import type { ExportNamedDeclaration, Node, Program } from "@babel/types";

// --- Self-build: run as source, bundle into <skill>/.build/ and run the bundle; run as the bundle, do nothing.
// docs/authoring.md > Dependencies owns this block; the smoke test keeps every copy identical.

function buildPaths(source: string) {
  // An entry may sit below scripts/: the skill root is the parent of the scripts/ with the manifest beside it.
  let scripts = dirname(source);
  while (basename(scripts) !== "scripts" || !existsSync(join(dirname(scripts), "package.json"))) {
    if (dirname(scripts) === scripts) {
      console.error(
        `${source}: no scripts/ directory with a package.json beside it above the script`,
      );
      process.exit(2);
    }
    scripts = dirname(scripts);
  }
  const skill = dirname(scripts);
  const built = join(skill, ".build", relative(scripts, source).replace(/\.mts$/, ".js"));
  return { scripts, skill, built };
}

function buildIsStale(scripts: string, skill: string, built: string): boolean {
  if (!existsSync(built)) return true;
  // An entry imports its siblings, and a pin bump changes the bundle, so every script and the manifest count.
  const inputs = readdirSync(scripts, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".mts"))
    .map((name) => join(scripts, name));
  inputs.push(join(skill, "package.json"));
  const newest = Math.max(...inputs.map((path) => statSync(path).mtimeMs));
  return statSync(built).mtimeMs < newest;
}

function runBun(args: string[]): boolean {
  const step = spawnSync("bun", args, { stdio: ["ignore", "ignore", "pipe"] });
  if (step.status !== 0) process.stderr.write(step.stderr);
  return step.status === 0;
}

function build(source: string, scripts: string, skill: string, built: string): boolean {
  // bun build resolves installed packages only, from a node_modules beside the entry, and two first runs at
  // once must never share one: each build gets its own scratch under .build/ and publishes by one rename.
  mkdirSync(join(skill, ".build"), { recursive: true });
  const scratch = mkdtempSync(join(skill, ".build", "scratch-"));
  try {
    cpSync(scripts, join(scratch, "scripts"), { recursive: true });
    copyFileSync(join(skill, "package.json"), join(scratch, "package.json"));
    const entry = join(scratch, "scripts", relative(scripts, source));
    const bundle = join(scratch, "bundle.js");
    const ok =
      runBun(["install", "--production", "--no-save", "--cwd", scratch]) &&
      runBun(["build", entry, "--target", "bun", "--outfile", bundle]);
    if (!ok) return false;
    mkdirSync(dirname(built), { recursive: true });
    renameSync(bundle, built);
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function ensureBuilt(source: string): boolean {
  if (!source.endsWith(".mts")) return false;
  const { scripts, skill, built } = buildPaths(source);
  if (buildIsStale(scripts, skill, built) && !build(source, scripts, skill, built)) process.exit(2);
  const run = spawnSync("bun", [built, ...process.argv.slice(2)], { stdio: "inherit" });
  // A bundle killed by a signal has no status: die of the same signal.
  if (run.signal) process.kill(process.pid, run.signal);
  process.exitCode = run.status ?? 1;
  return true;
}

// Only the command builds; a test or a sibling importing this file must not.
if (import.meta.main && ensureBuilt(import.meta.path)) process.exit();

// Loaded below the guard: a static import is hoisted above it and would resolve on the source path.

const { parse } = await import("@babel/parser");
const { isFile } = await import("./paths.mts");

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

/**
 * One export of a module: `name` as an importer sees it, and `from` when the binding is another
 * module's (`export { a as b } from "./m"`, or `import { a } from "./m"; export { a as b }`).
 */
export interface ExportEntry {
  readonly name: string;
  readonly from?: { readonly request: string; readonly imported: string };
}

export interface ModuleRecord {
  /** The whole tree, for importSpecifiers to walk: `import()`, `require()`, and type-position imports are not in `requests`. */
  readonly program: Program;

  /** The module requests of the static imports and re-exports, in source order. */
  readonly requests: readonly string[];

  /** The exports in source order; check-page.mts follows each one's `from` to its binding. */
  readonly exports: readonly ExportEntry[];

  /** The module requests of `export * from`, in source order. */
  readonly stars: readonly string[];
}

/** The string an export or import name is: `export { a as "b c" }` names "b c". */
function moduleExportName(node: Node): string {
  if (node.type === "Identifier") return node.name;
  if (node.type === "StringLiteral") return node.value;
  return "";
}

/** The identifiers a declaration binds: `export const { a, b: [c] } = x` exports a and c. */
function* boundNames(node: Node | null | undefined): Generator<string> {
  if (!node) return;
  switch (node.type) {
    case "Identifier":
      yield node.name;
      return;
    case "VariableDeclaration":
      for (const declarator of node.declarations) yield* boundNames(declarator.id);
      return;
    case "ObjectPattern":
      for (const property of node.properties) {
        yield* boundNames(property.type === "RestElement" ? property.argument : property.value);
      }
      return;
    case "ArrayPattern":
      for (const element of node.elements) yield* boundNames(element);
      return;
    case "AssignmentPattern":
      yield* boundNames(node.left);
      return;
    case "RestElement":
      yield* boundNames(node.argument);
      return;
    case "FunctionDeclaration":
    case "ClassDeclaration":
    case "TSDeclareFunction":
    case "TSTypeAliasDeclaration":
    case "TSInterfaceDeclaration":
    case "TSEnumDeclaration":
    case "TSImportEqualsDeclaration":
      yield* boundNames(node.id);
      return;
    case "TSModuleDeclaration":
      // `declare module "x"` is ambient and binds no name here.
      if (node.id.type === "Identifier") yield node.id.name;
      return;
    default:
      return;
  }
}

/**
 * The grammar follows the extension, as oxc's did: a .js file has no TypeScript syntax, so `a < b > (c)`
 * is a comparison there, not a call with type arguments. tsc owns binding checks, so an export ahead of
 * its import parses, and a CommonJS file may return at top level; .cjs is a script, where `package` is a
 * plain name, and .js is a module unless only script syntax parses it.
 */
function parseProgram(file: string, text: string): Program {
  const plugins: ParserPlugin[] = ["decorators", "decoratorAutoAccessors"];
  if (!/\.[mc]?jsx?$/.test(file)) plugins.push("typescript");
  if (/\.[jt]sx$|\.[mc]?js$/.test(file)) plugins.push("jsx");
  const options = {
    plugins,
    attachComment: false,
    allowUndeclaredExports: true,
    allowReturnOutsideFunction: true,
  };
  if (file.endsWith(".cjs")) return parse(text, { ...options, sourceType: "script" }).program;
  try {
    return parse(text, { ...options, sourceType: "module" }).program;
  } catch (error) {
    if (!/\.jsx?$/.test(file)) throw error;
    try {
      return parse(text, { ...options, sourceType: "script" }).program;
    } catch {
      throw error;
    }
  }
}

function importedBindings(program: Program): Map<string, { request: string; imported: string }> {
  const imported = new Map<string, { request: string; imported: string }>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers) {
      if (specifier.type === "ImportSpecifier") {
        imported.set(specifier.local.name, {
          request: statement.source.value,
          imported: moduleExportName(specifier.imported),
        });
      } else if (specifier.type === "ImportDefaultSpecifier") {
        imported.set(specifier.local.name, {
          request: statement.source.value,
          imported: "default",
        });
      }
    }
  }
  return imported;
}

function namedExports(
  statement: ExportNamedDeclaration,
  imported: ReadonlyMap<string, { request: string; imported: string }>,
): ExportEntry[] {
  const request = statement.source?.value;
  const entries: ExportEntry[] = [];
  for (const name of boundNames(statement.declaration)) entries.push({ name });
  for (const specifier of statement.specifiers) {
    if (specifier.type === "ExportNamespaceSpecifier") {
      entries.push({ name: moduleExportName(specifier.exported) });
    } else if (specifier.type === "ExportSpecifier") {
      const local = moduleExportName(specifier.local);
      const from = request === undefined ? imported.get(local) : { request, imported: local };
      entries.push({ name: moduleExportName(specifier.exported), from });
    }
  }
  return entries;
}

function programOf(file: string, text: string): Program {
  try {
    return parseProgram(file, text);
  } catch (error) {
    const line = (error as { loc?: { line?: number } }).loc?.line ?? 1;
    throw new Error(
      `${file}:${line} does not parse: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The module record of `text`: its static imports and exports, read from the TypeScript AST. A file
 * that does not parse throws naming the line.
 */
export function parseModule(file: string, text: string): ModuleRecord {
  const program = programOf(file, text);
  // Bindings first, since `export { v }` may precede `import { v } from "./a"` and still forward it.
  const imported = importedBindings(program);
  const requests: string[] = [];
  const exports: ExportEntry[] = [];
  const stars: string[] = [];
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      requests.push(statement.source.value);
    } else if (statement.type === "ExportAllDeclaration") {
      requests.push(statement.source.value);
      stars.push(statement.source.value);
    } else if (statement.type === "ExportDefaultDeclaration") {
      exports.push({ name: "default" });
    } else if (statement.type === "ExportNamedDeclaration") {
      const request = statement.source?.value;
      if (request !== undefined) requests.push(request);
      exports.push(...namedExports(statement, imported));
    }
  }
  return { program, requests, exports, stars };
}

/** Every AST node under `value`, in source order. */
export function* nodesOf(value: unknown): Generator<Node> {
  if (Array.isArray(value)) {
    for (const item of value) yield* nodesOf(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  if ("type" in value && typeof value.type === "string") yield value as Node;
  for (const [key, child] of Object.entries(value)) {
    if (key !== "loc") yield* nodesOf(child);
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
  if (node?.type === "StringLiteral") return node.value;
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
  const { program, requests } = parseModule(file, text);
  const found = new Set<string>(requests);
  const computed = (node: Node): never => {
    throw new Error(
      `${file}:${node.loc?.start.line ?? 0} loads a module through a computed specifier, which the import graph cannot follow; use a string literal`,
    );
  };
  for (const node of nodesOf(program)) {
    if (node.type === "ImportExpression") {
      found.add(literalSpecifier(node.source) ?? computed(node));
    } else if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      if (isRequireCallee(unwrapped(node.callee))) {
        found.add(literalSpecifier(node.arguments[0]) ?? computed(node));
      }
    } else if (node.type === "TSImportType") {
      found.add(node.source.value);
    } else if (node.type === "TSExternalModuleReference") {
      found.add(node.expression.value);
    }
  }
  return [...found].filter((specifier) => /^\.\.?\//.test(specifier));
}

/** `require(...)` and CommonJS's `module.require(...)` load, through `?.` too; `require.resolve(...)` does not. */
function isRequireCallee(callee: Node): boolean {
  if (callee.type === "Identifier") return callee.name === "require";
  if (callee.type !== "MemberExpression" && callee.type !== "OptionalMemberExpression")
    return false;
  if (callee.computed) return false;
  const { object, property } = callee;
  return (
    object.type === "Identifier" &&
    object.name === "module" &&
    property.type === "Identifier" &&
    property.name === "require"
  );
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
