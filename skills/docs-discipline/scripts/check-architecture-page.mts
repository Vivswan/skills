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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseSync, pathLabel, resolveImport, SOURCE_EXTENSIONS } from "./arch-lint.mts";

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
  /** Zero-based line of the opening fence. */
  line: number;
  /** Zero-based line of the closing fence (or the last line when the fence never closes). */
  end: number;
  /** The info string names mermaid; other fences are text the page quotes. */
  mermaid: boolean;
  body: string;
}

// A fence may sit inside block quotes (`> `), then up to three spaces of indent, as Markdown allows;
// four spaces make indented code, which is quoted text. The closer carries the same quote prefix.
const FENCE_OPEN = /^((?:>[ ]?)*)( {0,3})(`{3,}|~{3,})(.*)$/;
const MERMAID_INFO = /^\s*mermaid\s*$/;

/** `markdown` with CRLF line ends folded, so every reader counts the same lines. */
function normalizedLines(markdown: string): string[] {
  return markdown.replace(/\r\n/g, "\n").split("\n");
}

/**
 * Every fence in `lines`, whatever its language. A fence runs to a closer at
 * least as long as its opener, so a ```mermaid example nested inside a
 * ````markdown block is that block's text, not a diagram. The body drops the
 * indentation the opener has.
 */
function fences(lines: readonly string[]): Fence[] {
  const found: Fence[] = [];
  for (let index = 0; index < lines.length; index++) {
    const open = FENCE_OPEN.exec(lines[index] ?? "");
    if (open === null) continue;
    // Block-quote depth is what carries over line to line; the space after each `>` is optional on every line.
    const depth = (open[1] ?? "").split(">").length - 1;
    const quotePrefix = new RegExp(`^(?:>[ ]?){${depth}}`);
    const indent = open[2] ?? "";
    const ticks = open[3] ?? "```";
    // A closer repeats the opener's marker character at least as many times, at the same quote depth and at most three spaces in.
    const close = new RegExp(
      `^(?:>[ ]?){${depth}} {0,3}${ticks[0] === "~" ? "~" : "`"}{${ticks.length},}[ \\t]*$`,
    );
    const body: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && !close.test(lines[cursor] ?? "")) {
      const text = (lines[cursor] ?? "").replace(quotePrefix, "");
      body.push(text.startsWith(indent) ? text.slice(indent.length) : text);
      cursor += 1;
    }
    found.push({
      line: index,
      end: Math.min(cursor, lines.length - 1),
      mermaid: MERMAID_INFO.test(open[4] ?? ""),
      body: body.join("\n"),
    });
    index = cursor;
  }
  return found;
}

/** The live mermaid diagrams of `markdown`. */
export function mermaidFences(markdown: string): Fence[] {
  return readPage(markdown).fences.filter((fence) => fence.mermaid);
}

export interface Page {
  lines: readonly string[];
  fences: readonly Fence[];
  /** `lines[i]` when line i is page text, undefined inside any fence: headings, region markers, and demonstration lines are read from here only, so a quoted example never steers the walk. */
  text: ReadonlyArray<string | undefined>;
}

export function readPage(markdown: string): Page {
  const lines = normalizedLines(markdown);
  const all = fences(lines);
  const text = lines.map((line, index) =>
    all.some((fence) => index >= fence.line && index <= fence.end) ? undefined : line,
  );
  return { lines, fences: all, text };
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

// A marker line as the renderer reads it: up to three spaces in, the name, an optional hint on BEGIN.
const MARKER = /^ {0,3}<!-- (BEGIN|END) GENERATED: (\S+?)(?: \([^)]*\))? -->\s*$/;

/** Every BEGIN GENERATED marker needs the END marker of the same name after it; an unmatched one would hide every later diagram. */
function regionProblems(page: Page): string[] {
  const problems: string[] = [];
  let open: { name: string; line: number } | undefined;
  for (const [index, text] of page.text.entries()) {
    if (text === undefined) continue;
    const marker = MARKER.exec(text);
    const begin = marker?.[1] === "BEGIN" ? marker : null;
    const end = marker?.[1] === "END" ? marker : null;
    if (begin) {
      if (open)
        problems.push(
          `line ${index + 1}: BEGIN GENERATED: ${begin[2]} opens inside the region ${open.name} opened at line ${open.line + 1}`,
        );
      open = { name: begin[2] ?? "", line: index };
    } else if (end) {
      if (!open) problems.push(`line ${index + 1}: END GENERATED: ${end[2]} closes no open region`);
      else if (open.name !== end[2])
        problems.push(
          `line ${index + 1}: END GENERATED: ${end[2]} closes the region ${open.name} opened at line ${open.line + 1}`,
        );
      open = undefined;
    }
  }
  if (open) problems.push(`line ${open.line + 1}: BEGIN GENERATED: ${open.name} is never closed`);
  return problems;
}

function insideGeneratedRegion(page: Page, line: number): boolean {
  let open = false;
  for (const [index, text] of page.text.entries()) {
    if (index === line) return open;
    if (text === undefined) continue;
    const marker = MARKER.exec(text);
    if (marker?.[1] === "BEGIN") open = true;
    else if (marker?.[1] === "END") open = false;
  }
  return open;
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
  return page.fences.filter((fence) => fence.mermaid && !insideGeneratedRegion(page, fence.line));
}

/** The lines of page text matching `pattern`. */
/** Link destinations as Markdown reads them, so a title or angle brackets never become part of the path. */
function markdownLinks(line: string, page: Page): string[] {
  const links: string[] = [];
  // Reference-style links resolve through definitions elsewhere on the page, so those ride along.
  const definitions = page.text.filter(
    (text): text is string => text !== undefined && /^ {0,3}\[[^\]]+\]:\s+\S/.test(text),
  );
  Bun.markdown.render([line, "", ...definitions].join("\n"), {
    link: (children: string, attrs: { href?: string }) => {
      links.push(attrs.href ?? "");
      return children;
    },
  });
  return links;
}

function textLines(page: Page, pattern: RegExp): number[] {
  return [...page.text.keys()].filter((line) => {
    const text = page.text[line];
    return text !== undefined && pattern.test(text);
  });
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
  problems.push(...regionProblems(page));
  for (const fence of page.fences) {
    if (!fence.mermaid) continue;
    const nodes = nodeLabels(fence.body);
    problems.push(...nodes.problems);
    for (const label of nodes.labels) {
      problems.push(...labelProblems(label, options.root, pathRoots));
    }
  }
  // ATX headings, plus Setext ones: a text line under a line of = or - signs.
  const headings = [
    // Up to three leading spaces and an empty heading are still ATX headings to Markdown.
    ...textLines(page, /^ {0,3}#{1,6}(?:\s|$)/),
    ...textLines(page, /\S/).filter((line) => {
      const under = page.text[line + 1];
      const text = page.text[line] ?? "";
      return (
        under !== undefined &&
        /^ {0,3}(=+|-+)\s*$/.test(under) &&
        !/^\s*([-*+]|\d+\.)\s|^\s*\|/.test(text)
      );
    }),
  ].sort((x, y) => x - y);
  const demonstrations = textLines(page, /^Demonstrated by:/);
  // One demonstration line proves one diagram: two fences under one heading need two lines.
  const claimed = new Set<number>();
  for (const fence of conceptFences(page)) {
    const sectionEnd = headings.find((line) => line > fence.end) ?? page.lines.length;
    const demoLine = demonstrations.find(
      (line) => line > fence.end && line < sectionEnd && !claimed.has(line),
    );
    if (demoLine !== undefined) claimed.add(demoLine);
    const at = `line ${fence.line + 1}`;
    if (demoLine === undefined) {
      problems.push(`${at}: the diagram has no "${DEMONSTRATED}" line before the next heading`);
      continue;
    }
    const demo = page.lines[demoLine] ?? "";
    const links = markdownLinks(demo, page);
    if (links.length === 0) {
      problems.push(`${at}: the "${DEMONSTRATED}" line links nothing`);
    }
    for (const link of links) {
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
  return {
    diagrams: conceptFences(page).length,
    demonstrations: textLines(page, /^Demonstrated by:/).length,
  };
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
