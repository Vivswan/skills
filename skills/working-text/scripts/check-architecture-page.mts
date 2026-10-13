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
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Nodes, Paragraph, Root } from "mdast";
import { parseSync, pathLabel, resolveImport, SOURCE_EXTENSIONS } from "./arch-lint.mts";

const SKILL_DIR = join(import.meta.dir, "..");
const SKILL = basename(SKILL_DIR);
if (!existsSync(join(SKILL_DIR, "package.json")) || !existsSync(join(SKILL_DIR, "bun.lock"))) {
  console.error(`${SKILL} scripts need the skill's package.json and bun.lock beside scripts/`);
  process.exit(2);
}
const DEPS_HASH = createHash("sha256")
  .update(readFileSync(join(SKILL_DIR, "package.json")))
  .update(readFileSync(join(SKILL_DIR, "bun.lock")))
  .digest("hex")
  .slice(0, 12);
const DEPS_DIR = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "skills-deps",
  `${SKILL}-${DEPS_HASH}`,
);
// One shell word, so the printed recovery command runs as printed whatever the path holds.
const DEPS_DIR_QUOTED = `'${DEPS_DIR.replace(/'/g, "'\\''")}'`;
if (!existsSync(join(DEPS_DIR, "node_modules"))) {
  mkdirSync(DEPS_DIR, { recursive: true });
  for (const file of ["package.json", "bun.lock"]) {
    copyFileSync(join(SKILL_DIR, file), join(DEPS_DIR, file));
  }
  const install = spawnSync("bun", ["install", "--frozen-lockfile", "--cwd", DEPS_DIR], {
    encoding: "utf8",
  });
  if (install.status !== 0) {
    process.stderr.write(install.stderr ?? "");
    console.error(
      `${SKILL} dependencies did not install; run: bun install --frozen-lockfile --cwd ${DEPS_DIR_QUOTED}`,
    );
    process.exit(2);
  }
}
// Bun.resolveSync falls through to auto-install when DEPS_DIR holds no node_modules, so check the directory first.
for (const name of [
  "mdast-util-from-markdown",
  "mdast-util-gfm",
  "mdast-util-to-string",
  "micromark-extension-gfm",
]) {
  if (!existsSync(join(DEPS_DIR, "node_modules", name))) {
    console.error(
      `${SKILL} scripts need ${name}: bun install --frozen-lockfile --cwd ${DEPS_DIR_QUOTED}`,
    );
    process.exit(2);
  }
}
const { fromMarkdown }: typeof import("mdast-util-from-markdown") = await import(
  Bun.resolveSync("mdast-util-from-markdown", DEPS_DIR)
);
const { gfmFromMarkdown }: typeof import("mdast-util-gfm") = await import(
  Bun.resolveSync("mdast-util-gfm", DEPS_DIR)
);
const { toString: plainText }: typeof import("mdast-util-to-string") = await import(
  Bun.resolveSync("mdast-util-to-string", DEPS_DIR)
);
const { gfm }: typeof import("micromark-extension-gfm") = await import(
  Bun.resolveSync("micromark-extension-gfm", DEPS_DIR)
);

// An ECMAScript identifier name, so `$run` and a Unicode-letter export are symbols too.
const SYMBOL_TOKEN = /^[\p{ID_Start}$_][\p{ID_Continue}$\u200C\u200D]*(?:\(\))?$/u;
const DEMONSTRATED = "Demonstrated by:";

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
  const { module } = parseSync(file, readFileSync(file, "utf8"));
  const direct = new Map<string, string>();
  const starred = new Map<string, Set<string>>();
  for (const statement of module.staticExports) {
    for (const entry of statement.entries) {
      const request = entry.moduleRequest?.value;
      const relativeRequest = request !== undefined && /^\.\.?\//.test(request);
      if (entry.exportName.kind === "Default") {
        direct.set("default", `${file}#default`);
      } else if (entry.exportName.name !== null) {
        // `export { x as y } from "./m"`, and `import { x } from "./m"; export { x as y }`, which the
        // module record already folds into the same shape, keep the binding of ./m, not a new one here.
        const imported = entry.importName.kind === "Name" ? entry.importName.name : null;
        const origin =
          relativeRequest && imported !== null
            ? (exportOrigins(resolveImport(file, request), inner).get(imported) ??
              `${resolveImport(file, request)}#${imported}`)
            : `${file}#${entry.exportName.name}`;
        direct.set(entry.exportName.name, origin);
      } else if (relativeRequest) {
        const target = resolveImport(file, request);
        for (const [name, origin] of exportOrigins(target, inner)) {
          if (name === "default") continue;
          const origins = starred.get(name) ?? new Set<string>();
          origins.add(origin);
          starred.set(name, origins);
        }
      }
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

export interface Fence {
  /** One-based line of the opening fence. */
  line: number;
  /** One-based line of the closing fence (or the last line when the fence never closes). */
  end: number;
  /** The info string names mermaid; other fences are text the page quotes. */
  mermaid: boolean;
  body: string;
  /** Between a BEGIN and an END GENERATED marker: the declaration's diagram, not the author's. */
  generated: boolean;
}

export interface Marker {
  kind: "BEGIN" | "END";
  name: string;
  /** One-based line of the marker. */
  line: number;
  /** Offsets of the marker in the page text, from its line's first character (indent included) to its last. */
  start: number;
  end: number;
}

export interface Page {
  /** Every fence, whatever its language, at any depth. */
  fences: readonly Fence[];
  /** The region markers, in page order: a top-level HTML block that is one marker line. */
  markers: readonly Marker[];
  /** One-based lines of the top-level headings, ATX and Setext alike. */
  headings: readonly number[];
  /** Top-level paragraphs opening with "Demonstrated by:", each with the destinations it links. */
  demonstrations: readonly { line: number; links: string[] }[];
}

// A marker line as the renderer reads it: up to three spaces in, the name, an optional hint on BEGIN.
const MARKER = /^ {0,3}<!-- (BEGIN|END) GENERATED: (\S+?)(?: \([^)\r\n]*\))? -->[ \t]*$/;

/** A node's extent, with the offsets a splice needs. */
interface Span {
  start: { line: number; offset: number };
  end: { line: number; offset: number };
}

/** fromMarkdown positions every node, offsets included; the types leave both optional for trees built by hand. */
function positionOf(node: Nodes): Span {
  const { position } = node;
  if (position?.start.offset === undefined || position.end.offset === undefined) {
    throw new Error(`${node.type} node without a position`);
  }
  return {
    start: { line: position.start.line, offset: position.start.offset },
    end: { line: position.end.line, offset: position.end.offset },
  };
}

/** Every node under `node`, itself first, in page order. */
function* descendants(node: Nodes): Generator<Nodes> {
  yield node;
  if ("children" in node) for (const child of node.children) yield* descendants(child);
}

/** The destinations a paragraph links, a reference link through its definition. */
function linkTargets(paragraph: Paragraph, definitions: ReadonlyMap<string, string>): string[] {
  const links: string[] = [];
  for (const node of descendants(paragraph)) {
    if (node.type === "link") links.push(node.url);
    else if (node.type === "linkReference") {
      const url = definitions.get(node.identifier);
      if (url !== undefined) links.push(url);
    }
  }
  return links;
}

/**
 * The page as Markdown reads it: a marker quoted in a fence is code, one under `> ` is quoted
 * text, and a heading or fence inside a longer fence is that fence's text, so none of them steers
 * the walk. Only a top-level marker opens or closes a region, as the renderer splices it.
 */
export function readPage(markdown: string): Page {
  const root: Root = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const definitions = new Map<string, string>();
  for (const node of descendants(root)) {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
  }
  const fences: Fence[] = [];
  const markers: Marker[] = [];
  const headings: number[] = [];
  const demonstrations: { line: number; links: string[] }[] = [];
  let generated = false;
  for (const block of root.children) {
    const { start, end } = positionOf(block);
    const marker = block.type === "html" ? MARKER.exec(block.value) : null;
    if (marker) {
      const kind = marker[1] === "BEGIN" ? "BEGIN" : "END";
      markers.push({
        kind,
        name: marker[2] ?? "",
        line: start.line,
        start: start.offset,
        end: end.offset,
      });
      generated = kind === "BEGIN";
      continue;
    }
    if (block.type === "heading") headings.push(start.line);
    if (block.type === "paragraph" && plainText(block).startsWith(DEMONSTRATED)) {
      demonstrations.push({ line: start.line, links: linkTargets(block, definitions) });
    }
    for (const node of descendants(block)) {
      if (node.type !== "code") continue;
      const at = positionOf(node);
      fences.push({
        line: at.start.line,
        end: at.end.line,
        mermaid: node.lang === "mermaid",
        body: node.value,
        generated,
      });
    }
  }
  return { fences, markers, headings, demonstrations };
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

/** True when `file` is `root` or sits under it, judged by the relative path so the host's separator does not matter. */
function withinRoot(root: string, file: string): boolean {
  const rel = relative(resolve(root), file);
  return !rel.startsWith("..") && !isAbsolute(rel);
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
  "usage: check-architecture-page.mts --page <path> [--root <dir>] [--repo-url <prefix>] [--expect-diagrams <n>]",
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
