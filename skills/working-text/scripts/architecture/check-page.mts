#!/usr/bin/env bun
// The page test: every box that names a file names one that exists, every
// symbol after the path is exported by that file, every concept diagram has a
// "Demonstrated by:" line whose links resolve, and the number of concept
// diagrams is pinned. Existence only: a caption-only box passes untouched, and
// a demonstration link is checked to resolve, not to test its diagram's claim.
//
// Label grammar, per <br> segment:
//   starts with a path (top-level directory, slash, segments)  -> binds that path; the rest are its exported symbols
//   no path, a path bound earlier in the label                 -> more symbols of the bound path
//   no path, nothing bound yet                                 -> a caption; a slash or `()` inside it is reported
// Diagrams inside a generated region are the declaration's, not the author's,
// and need no demonstration line.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Fence, Marker, Page } from "./page.mts";

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

function build(source: string, skill: string, built: string): void {
  // bun build resolves installed packages only: install the pins for the build's duration, then remove them.
  const ok =
    runBun(["install", "--production", "--no-save", "--cwd", skill]) &&
    runBun(["build", source, "--target", "bun", "--outfile", built]);
  rmSync(join(skill, "node_modules"), { recursive: true, force: true });
  if (!ok) process.exit(2);
}

function ensureBuilt(source: string): boolean {
  if (!source.endsWith(".mts")) return false;
  const { scripts, skill, built } = buildPaths(source);
  if (buildIsStale(scripts, skill, built)) build(source, skill, built);
  const run = spawnSync("bun", [built, ...process.argv.slice(2)], { stdio: "inherit" });
  // A bundle killed by a signal has no status: die of the same signal.
  if (run.signal) process.kill(process.pid, run.signal);
  process.exitCode = run.status ?? 1;
  return true;
}

// Only the command builds; a test or a sibling importing this file must not.
if (import.meta.main && ensureBuilt(import.meta.path)) process.exit();

// Loaded below the guard: a static import is hoisted above it and would resolve on the source path.
const { DEMONSTRATED, readPage } = await import("./page.mts");
const { pathLabel, withinRoot } = await import("./paths.mts");
const { parseModule, resolveImport, SOURCE_EXTENSIONS } = await import("./sources.mts");

// An ECMAScript identifier name, so `$run` and a Unicode-letter export are symbols too.
const SYMBOL_TOKEN = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*(?:\(\))?$/u;

const exportOriginsByFile = new Map<string, ReadonlyMap<string, string>>();

/**
 * The names `file` exports, each with the module that declares its binding: `export { a as b }`
 * exports b, a default export is `default`, `export * from` brings the target's names (its default
 * stays behind, as in the language), `export * as ns` is `ns`. A name reached through two star
 * paths is one export when both paths end at the same binding and no export at all when they do
 * not, as ECMAScript resolves it. A star cycle contributes nothing on the second visit; only a
 * top-level result is cached.
 */
export function exportOrigins(
  file: string,
  visiting: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, string> {
  const cached = exportOriginsByFile.get(file);
  if (cached) return cached;
  if (visiting.has(file)) return new Map();
  const inner = new Set([...visiting, file]);
  const { exports, stars } = parseModule(file, readFileSync(file, "utf8"));
  const isRelative = (request: string): boolean => /^\.\.?\//.test(request);
  const direct = new Map<string, string>();
  const starred = new Map<string, Set<string>>();
  for (const entry of exports) {
    // `export { x as y } from "./m"`, and `import { x } from "./m"; export { x as y }`, keep the binding of ./m,
    // not a new one here; a name bound in this file, a default export included, is this file's.
    const from =
      entry.from !== undefined && isRelative(entry.from.request) ? entry.from : undefined;
    const origin =
      from === undefined
        ? `${file}#${entry.name}`
        : (exportOrigins(resolveImport(file, from.request), inner).get(from.imported) ??
          `${resolveImport(file, from.request)}#${from.imported}`);
    direct.set(entry.name, origin);
  }
  for (const request of stars) {
    if (!isRelative(request)) continue;
    const target = resolveImport(file, request);
    for (const [name, origin] of exportOrigins(target, inner)) {
      if (name === "default") continue;
      const origins = starred.get(name) ?? new Set<string>();
      origins.add(origin);
      starred.set(name, origins);
    }
  }
  const names = new Map(direct);
  for (const [name, origins] of starred) {
    if (!names.has(name) && origins.size === 1) names.set(name, [...origins][0] as string);
  }
  if (visiting.size === 0) exportOriginsByFile.set(file, names);
  return names;
}

export function exportedNames(file: string): ReadonlySet<string> {
  return new Set(exportOrigins(file).keys());
}

// A node definition wherever it sits: an id, an opening shape run (`[`, `((`, `{{`, `[/`, `[\`, `>` ...), and what follows it.
const NODE_DEFINITION = /(?<![\w"-])([A-Za-z_][\w-]*)([[({>]+[/\\]?)(?![-|])/g;
const QUOTED_LABEL = /^"([^"]*)"[/\\]?[\])}]+/;
// Edge-label text is not a node: `-->|run()|`, `-- run() -->`, `== run() ==>`, `-. run() .->`.
// Text-form label text holds no node or arrow character, so `a --- b["x"] --> c` is two bare links, not one label.
const EDGE_LABEL = /\|[^|\n]*\||(?:--|==|-\.)\s[^\n[\](){}|>=.-]+\s(?:-->|---|==>|===|\.->|\.-)/g;
// The flowchart header alone is dropped, not its whole line: `flowchart LR; a["x"]` defines a node.
const FLOWCHART_HEADER = /^\s*(?:flowchart|graph)(?:\s+(?:TB|TD|BT|LR|RL))?\b\s*;?/;

/**
 * `text` with every edge-label span blanked to spaces, offsets kept. A `|` or
 * arrow inside a quoted label is label text, so the spans are found on a copy
 * whose quoted contents are masked, then blanked in the original.
 */
function blankEdgeLabels(text: string): string {
  // Regex offsets are UTF-16 indices; slicing the string keeps that unit, where a
  // code-point array would shift every span after an astral character.
  const masked = text.replace(/"[^"\n]*"/g, (quoted) => `"${"_".repeat(quoted.length - 2)}"`);
  let blanked = text;
  for (const match of masked.matchAll(EDGE_LABEL)) {
    const end = match.index + match[0].length;
    blanked = `${blanked.slice(0, match.index)}${" ".repeat(match[0].length)}${blanked.slice(end)}`;
  }
  return blanked;
}

/** The quoted labels of a mermaid block's nodes; an unquoted label is reported, since the pins cannot read it. */
export function nodeLabels(mermaid: string): { labels: string[]; problems: string[] } {
  const labels: string[] = [];
  const problems: string[] = [];
  const reportedLines = new Set<number>();
  const headed = FLOWCHART_HEADER.test(mermaid)
    ? mermaid.replace(FLOWCHART_HEADER, "")
    : mermaid.split("\n").slice(1).join("\n");
  // A `%%` line is a Mermaid comment: a node written there is not drawn, so it is not checked.
  // Blanking keeps every offset, so a reported line is read back from `drawn` as written.
  const drawn = headed
    .split("\n")
    .map((line) => (line.trimStart().startsWith("%%") ? "" : line))
    .join("\n");
  const body = blankEdgeLabels(drawn);
  const quotedSpans = [...body.matchAll(/"[^"]*"/g)].map(
    (span) => [span.index, span.index + span[0].length] as const,
  );
  for (const match of body.matchAll(NODE_DEFINITION)) {
    if (quotedSpans.some(([start, end]) => match.index > start && match.index < end)) continue;
    const rest = body.slice(match.index + match[0].length);
    const quoted = rest.match(QUOTED_LABEL);
    if (quoted === null) {
      const lineStart = body.lastIndexOf("\n", match.index) + 1;
      if (!reportedLines.has(lineStart)) {
        reportedLines.add(lineStart);
        const line = drawn.slice(lineStart).split("\n")[0] ?? "";
        problems.push(
          `node "${line.trim()}" has an unquoted label; quote it so the pins can read it`,
        );
      }
      continue;
    }
    labels.push(quoted[1] ?? "");
  }
  return { labels, problems };
}

export interface PageCheckOptions {
  /** The repository root the label paths are relative to. */
  root: string;
  /** The top-level directories a label path may start with (default: the directories under root). */
  pathRoots?: readonly string[];
  /** The URL prefix an absolute demonstration link must carry to map onto a repository file. */
  repoUrl?: string;
  /** The page's own path, for resolving relative demonstration links. */
  pagePath?: string;
}

function defaultPathRoots(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Problems with one label, as `"label": problem`. */
export function labelProblems(
  label: string,
  root: string,
  pathRoots: readonly string[] = defaultPathRoots(root),
): string[] {
  // A path starts under a top-level directory, or is a root-level file with a source or document extension (main.ts, README.md).
  const rootFile = `[\\w.-]+(?:${[...SOURCE_EXTENSIONS, ".md", ".yml", ".yaml", ".json"].map(escapeRe).join("|")})`;
  const pathToken = new RegExp(
    `^(?:(?:${pathRoots.map(escapeRe).join("|")})/[\\w./-]*|${rootFile})$`,
  );
  const problems: string[] = [];
  const missing = new Set<string>();
  let bound: string | undefined;
  for (const segment of label.split("<br>")) {
    const tokens = segment
      .trim()
      .split(/[\s,]+/)
      .filter((token) => token !== "");
    const [head] = tokens;
    let path: string;
    let symbols: string[];
    if (head !== undefined && pathToken.test(head)) {
      path = head;
      symbols = tokens.slice(1);
    } else if (bound !== undefined) {
      path = bound;
      symbols = tokens;
    } else {
      if (segment.includes("/") || segment.includes("()")) {
        problems.push(
          `"${label}": "${segment.trim()}" looks like code but reads as a caption; a code segment starts with a path under ${pathRoots.join(", ")}`,
        );
      }
      continue;
    }
    bound = path;
    const file = resolve(root, path);
    if (path.split("/").includes("..") || !withinRoot(root, file)) {
      problems.push(`"${label}": ${path} escapes the repository`);
      continue;
    }
    if (!existsSync(file)) {
      if (!missing.has(path)) {
        missing.add(path);
        problems.push(`"${label}": ${path} does not exist`);
      }
      continue;
    }
    for (const symbol of symbols) {
      if (!SYMBOL_TOKEN.test(symbol)) {
        problems.push(
          `"${label}": "${symbol}" is neither a symbol nor a path; after a path, a label lists only exported symbols`,
        );
        continue;
      }
      const name = symbol.replace(/\(\)$/, "");
      if (path.endsWith("/") || statSync(file).isDirectory()) {
        problems.push(`"${label}": ${path} is a directory, so it exports no ${name}`);
      } else if (!exportedNames(file).has(name)) {
        problems.push(`"${label}": ${path} exports no ${name}`);
      }
    }
  }
  return problems;
}

/** Every BEGIN GENERATED marker needs the END marker of the same name after it; an unmatched one would hide every later diagram. */
function regionProblems(markers: readonly Marker[]): string[] {
  const problems: string[] = [];
  let open: Marker | undefined;
  for (const marker of markers) {
    if (marker.kind === "BEGIN") {
      if (open)
        problems.push(
          `line ${marker.line}: BEGIN GENERATED: ${marker.name} opens inside the region ${open.name} opened at line ${open.line}`,
        );
      open = marker;
    } else {
      if (!open)
        problems.push(`line ${marker.line}: END GENERATED: ${marker.name} closes no open region`);
      else if (open.name !== marker.name)
        problems.push(
          `line ${marker.line}: END GENERATED: ${marker.name} closes the region ${open.name} opened at line ${open.line}`,
        );
      open = undefined;
    }
  }
  if (open) problems.push(`line ${open.line}: BEGIN GENERATED: ${open.name} is never closed`);
  return problems;
}

/** The file a link addresses: no fragment, no query, percent-escapes decoded when they are valid. */
function linkFile(link: string): string {
  const bare = link.split("#")[0]?.split("?")[0] ?? "";
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

/** The repository file a demonstration link names, or a problem string. */
function resolveLink(
  link: string,
  options: PageCheckOptions,
): { file: string } | { problem: string } {
  const target = linkFile(link);
  if (/^[a-z]+:\/\//.test(target)) {
    if (options.repoUrl === undefined) {
      return {
        problem: `"${link}" is an absolute link; pass --repo-url <prefix> so it can be resolved`,
      };
    }
    if (!target.startsWith(options.repoUrl)) {
      return { problem: `"${link}" is not a ${options.repoUrl} link` };
    }
    const file = resolve(options.root, target.slice(options.repoUrl.length));
    if (!withinRoot(options.root, file))
      return { problem: `"${link}" resolves outside the repository` };
    return { file };
  }
  if (options.pagePath === undefined) {
    return { problem: `"${link}" is a relative link, but the page's own path is unknown` };
  }
  const file = resolve(dirname(options.pagePath), target);
  if (!withinRoot(options.root, file)) {
    return { problem: `"${link}" resolves outside the repository` };
  }
  return { file };
}

/** The concept diagrams of a page: the mermaid fences outside generated regions. */
function conceptFences(page: Page): Fence[] {
  return page.fences.filter((fence) => fence.mermaid && !fence.generated);
}

/**
 * Every problem in one page: a node naming a missing path or an unexported
 * symbol, a concept diagram without its "Demonstrated by:" line before the
 * next heading, or a demonstration link that does not resolve to a file.
 */
export function diagramProblems(markdown: string, options: PageCheckOptions): string[] {
  const pathRoots = options.pathRoots ?? defaultPathRoots(options.root);
  const problems: string[] = [];
  const page = readPage(markdown);
  problems.push(...regionProblems(page.markers));
  for (const fence of page.fences) {
    if (!fence.mermaid) continue;
    const nodes = nodeLabels(fence.body);
    problems.push(...nodes.problems);
    for (const label of nodes.labels) {
      problems.push(...labelProblems(label, options.root, pathRoots));
    }
  }
  // One demonstration line proves one diagram: two fences under one heading need two lines.
  const claimed = new Set<number>();
  for (const fence of conceptFences(page)) {
    const sectionEnd = page.headings.find((line) => line > fence.end) ?? Number.POSITIVE_INFINITY;
    const demo = page.demonstrations.find(
      ({ line }) => line > fence.end && line < sectionEnd && !claimed.has(line),
    );
    if (demo !== undefined) claimed.add(demo.line);
    const at = `line ${fence.line}`;
    if (demo === undefined) {
      problems.push(`${at}: the diagram has no "${DEMONSTRATED}" line before the next heading`);
      continue;
    }
    if (demo.links.length === 0) {
      problems.push(`${at}: the "${DEMONSTRATED}" line links nothing`);
    }
    for (const link of demo.links) {
      const resolved = resolveLink(link, options);
      if ("problem" in resolved) {
        problems.push(`${at}: ${resolved.problem}`);
      } else if (!existsSync(resolved.file)) {
        problems.push(`${at}: "${link}" names a file that does not exist`);
      } else if (statSync(resolved.file).isDirectory()) {
        problems.push(`${at}: "${link}" names a directory, not a test or scenario file`);
      }
    }
  }
  return problems;
}

/** The concept diagrams and demonstration lines a page carries. */
export function conceptCounts(markdown: string): { diagrams: number; demonstrations: number } {
  const page = readPage(markdown);
  return { diagrams: conceptFences(page).length, demonstrations: page.demonstrations.length };
}

const USAGE = [
  "usage: check-page.mts --page <path> [--root <dir>] [--repo-url <prefix>] [--expect-diagrams <n>]",
  "  --page             the architecture page to check",
  "  --root             the repository root the label paths are relative to (default: cwd)",
  "  --repo-url         the URL prefix an absolute demonstration link maps onto the root with",
  "                     (e.g. https://github.com/owner/repo/blob/main/); relative links resolve from the page",
  "  --expect-diagrams  the number of concept diagrams the page must carry",
  "exit 0: the page names real code; 1: problems, each printed; 2: usage or an unreadable page",
].join("\n");

interface CliOptions extends PageCheckOptions {
  pagePath: string;
  expectDiagrams?: number;
}

function parseArgs(argv: readonly string[]): CliOptions {
  let root = process.cwd();
  let page: string | undefined;
  let repoUrl: string | undefined;
  let expectDiagrams: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    if (arg === "--root") root = resolve(value());
    else if (arg === "--page") page = resolve(value());
    else if (arg === "--repo-url") repoUrl = value();
    else if (arg === "--expect-diagrams") {
      const count = value();
      if (!/^\d+$/.test(count)) throw new Error(`--expect-diagrams needs a whole number\n${USAGE}`);
      expectDiagrams = Number(count);
    } else throw new Error(`unknown argument: ${arg}\n${USAGE}`);
  }
  if (page === undefined) throw new Error(`--page is required\n${USAGE}`);
  return { root, pagePath: page, repoUrl, expectDiagrams };
}

if (import.meta.main) {
  if (process.argv[2] === "--help" || process.argv[2] === "-h") {
    console.log(USAGE);
    process.exit(0);
  }
  let options: CliOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  const pageLabel = pathLabel(options.root, options.pagePath);
  if (!existsSync(options.pagePath)) {
    console.error(`check-architecture-page: ${pageLabel} does not exist`);
    process.exit(2);
  }
  try {
    const markdown = readFileSync(options.pagePath, "utf8");
    const problems = diagramProblems(markdown, options);
    const counts = conceptCounts(markdown);
    if (options.expectDiagrams !== undefined && counts.diagrams !== options.expectDiagrams) {
      problems.push(
        `expected ${options.expectDiagrams} concept diagrams, found ${counts.diagrams}; change --expect-diagrams only when a diagram was added or removed on purpose`,
      );
    }
    if (counts.demonstrations !== counts.diagrams) {
      problems.push(
        `${counts.diagrams} concept diagrams but ${counts.demonstrations} "${DEMONSTRATED}" lines; one line per diagram`,
      );
    }
    if (problems.length > 0) {
      console.error(
        `check-architecture-page: ${pageLabel}: ${problems.length} problem(s)\n  ${problems.join("\n  ")}`,
      );
      process.exit(1);
    }
    console.log(
      `check-architecture-page: ${pageLabel} names real code (concept diagrams: ${counts.diagrams})`,
    );
  } catch (error) {
    console.error(
      `check-architecture-page: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(2);
  }
}
