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
import { dirname, join, resolve } from "node:path";
import { parseSync, pathLabel, resolveImport } from "./arch-lint.mts";

const SYMBOL_TOKEN = /^[A-Za-z_]\w*(?:\(\))?$/;
const DEMONSTRATED = "Demonstrated by:";

const exportedNamesByFile = new Map<string, ReadonlySet<string>>();

/**
 * The names `file` exports, as the module record sees them: `export { a as b }`
 * exports b, a default export is `default`, `export * from` unions the target's
 * names (its default stays behind, as in the language), `export * as ns` is `ns`.
 * A star cycle contributes nothing on the second visit; only a top-level result is cached.
 */
export function exportedNames(
  file: string,
  visiting: ReadonlySet<string> = new Set(),
): ReadonlySet<string> {
  const cached = exportedNamesByFile.get(file);
  if (cached) return cached;
  if (visiting.has(file)) return new Set();
  const inner = new Set([...visiting, file]);
  const { module } = parseSync(file, readFileSync(file, "utf8"));
  const names = new Set<string>();
  for (const statement of module.staticExports) {
    for (const entry of statement.entries) {
      if (entry.exportName.kind === "Default") {
        names.add("default");
      } else if (entry.exportName.name !== null) {
        names.add(entry.exportName.name);
      } else if (entry.moduleRequest && /^\.\.?\//.test(entry.moduleRequest.value)) {
        for (const name of exportedNames(resolveImport(file, entry.moduleRequest.value), inner)) {
          if (name !== "default") names.add(name);
        }
      }
    }
  }
  if (visiting.size === 0) exportedNamesByFile.set(file, names);
  return names;
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

const FENCE_OPEN = /^([ \t]*)(`{3,})(.*)$/;
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
    const indent = open[1] ?? "";
    const ticks = open[2] ?? "```";
    const close = new RegExp(`^[ \\t]*\`{${ticks.length},}[ \\t]*$`);
    const body: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && !close.test(lines[cursor] ?? "")) {
      const text = lines[cursor] ?? "";
      body.push(text.startsWith(indent) ? text.slice(indent.length) : text);
      cursor += 1;
    }
    found.push({
      line: index,
      end: Math.min(cursor, lines.length - 1),
      mermaid: MERMAID_INFO.test(open[3] ?? ""),
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

interface Page {
  lines: readonly string[];
  fences: readonly Fence[];
  /** `lines[i]` when line i is page text, undefined inside any fence: headings, region markers, and demonstration lines are read from here only, so a quoted example never steers the walk. */
  text: ReadonlyArray<string | undefined>;
}

function readPage(markdown: string): Page {
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
// The flowchart header alone is dropped, not its whole line: `flowchart LR; a["x"]` defines a node.
const FLOWCHART_HEADER = /^\s*(?:flowchart|graph)(?:\s+(?:TB|TD|BT|LR|RL))?\b\s*;?/;

/** The quoted labels of a mermaid block's nodes; an unquoted label is reported, since the pins cannot read it. */
export function nodeLabels(mermaid: string): { labels: string[]; problems: string[] } {
  const labels: string[] = [];
  const problems: string[] = [];
  const reportedLines = new Set<number>();
  const headed = FLOWCHART_HEADER.test(mermaid)
    ? mermaid.replace(FLOWCHART_HEADER, "")
    : mermaid.split("\n").slice(1).join("\n");
  // A `%%` line is a Mermaid comment: a node written there is not drawn, so it is not checked.
  const body = headed
    .split("\n")
    .map((line) => (line.trimStart().startsWith("%%") ? "" : line))
    .join("\n");
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
        const line = body.slice(lineStart).split("\n")[0] ?? "";
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
  const pathToken = new RegExp(`^(?:${pathRoots.map(escapeRe).join("|")})/[\\w./-]*$`);
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
    const file = join(root, path);
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

function insideGeneratedRegion(page: Page, line: number): boolean {
  let open = false;
  for (const [index, text] of page.text.entries()) {
    if (index === line) return open;
    if (text === undefined) continue;
    if (/^<!-- BEGIN GENERATED: /.test(text)) open = true;
    else if (/^<!-- END GENERATED: /.test(text)) open = false;
  }
  return open;
}

/** The repository file a demonstration link names, or a problem string. */
function resolveLink(
  link: string,
  options: PageCheckOptions,
): { file: string } | { problem: string } {
  const target = link.split("#")[0] ?? "";
  if (/^[a-z]+:\/\//.test(target)) {
    if (options.repoUrl === undefined) {
      return {
        problem: `"${link}" is an absolute link; pass --repo-url <prefix> so it can be resolved`,
      };
    }
    if (!target.startsWith(options.repoUrl)) {
      return { problem: `"${link}" is not a ${options.repoUrl} link` };
    }
    return { file: join(options.root, target.slice(options.repoUrl.length)) };
  }
  if (options.pagePath === undefined) {
    return { problem: `"${link}" is a relative link, but the page's own path is unknown` };
  }
  return { file: resolve(dirname(options.pagePath), target) };
}

/** The concept diagrams of a page: the mermaid fences outside generated regions. */
function conceptFences(page: Page): Fence[] {
  return page.fences.filter((fence) => fence.mermaid && !insideGeneratedRegion(page, fence.line));
}

/** The lines of page text matching `pattern`. */
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
  for (const fence of page.fences) {
    if (!fence.mermaid) continue;
    const nodes = nodeLabels(fence.body);
    problems.push(...nodes.problems);
    for (const label of nodes.labels) {
      problems.push(...labelProblems(label, options.root, pathRoots));
    }
  }
  const headings = textLines(page, /^#{1,6}\s/);
  const demonstrations = textLines(page, /^Demonstrated by:/);
  for (const fence of conceptFences(page)) {
    const sectionEnd = headings.find((line) => line > fence.end) ?? page.lines.length;
    const demoLine = demonstrations.find((line) => line > fence.end && line < sectionEnd);
    const at = `line ${fence.line + 1}`;
    if (demoLine === undefined) {
      problems.push(`${at}: the diagram has no "${DEMONSTRATED}" line before the next heading`);
      continue;
    }
    const demo = page.lines[demoLine] ?? "";
    const links = [...demo.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1] ?? "");
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
