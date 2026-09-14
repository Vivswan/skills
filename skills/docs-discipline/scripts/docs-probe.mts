#!/usr/bin/env bun
// The page probe of /docs-discipline: the two readings a reviewer otherwise
// takes by eye, made exact.
//   a paragraph or list item over the word cap (default 70)  -> finding, exit 1
//   a repository path the prose names that does not exist    -> finding, exit 1
// Block structure comes from Bun's Markdown renderer, so what counts as prose
// is what Markdown renders as a paragraph or a tight list item: headings,
// code (fenced or indented), tables, raw HTML, and images contribute nothing.
// Front matter is blanked before rendering; a BEGIN/END GENERATED region is
// dropped where the renderer sees its markers as HTML blocks, so a marker
// quoted inside a fence is code and changes nothing.
// A path is a backticked token with a slash and an extension (or ./, ../, a
// trailing slash), or a relative link destination; placeholders (<...>),
// globs, owner/repo slugs, and bare file names are left alone, since a page
// may name files the reader will create.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

export const DEFAULT_MAX_WORDS = 70;

export interface Finding {
  readonly file: string;
  /** One-based line where the unit or token starts. */
  readonly line: number;
  readonly message: string;
}

export interface ProbeOptions {
  /** Repository root every slash path resolves against. */
  readonly root: string;
  readonly maxWords: number;
  /** false: word counts only, for pages that describe another repository's files. */
  readonly paths: boolean;
}

export interface Unit {
  readonly kind: "paragraph" | "item";
  readonly line: number;
  /** The prose as the reader sees it: link labels and code spans kept, markup gone. */
  readonly text: string;
}

export interface Scan {
  readonly units: Unit[];
  readonly codespans: { readonly text: string; readonly line: number }[];
  readonly links: { readonly href: string; readonly line: number }[];
}

// Marker bytes the renderer callbacks emit; blocks nest, inlines do not. P and L are prose
// (paragraph, list item); N is a block whose paths and links are checked but whose words are not counted.
const OPEN = "";
const INLINE_END = "";
const BLOCK_END = "";
const isBlockKind = (ch: string | undefined) => ch === "P" || ch === "L" || ch === "N";

/** The page with front matter blanked, line for line, so line numbers still match the file. */
function blankFrontMatter(text: string): string[] {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const out = [...lines];
  // Only a closed block is front matter; a lone --- is a thematic break and the page is prose.
  if (lines[0] === "---") {
    const close = lines.indexOf("---", 1);
    if (close !== -1) for (let i = 0; i <= close; i++) out[i] = "";
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};
const unescapeEntities = (s: string) =>
  s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITIES[m] ?? m);

/** Characters at block depth 0 of `s`: nested block segments (and their contents) removed, inline markers kept. */
function ownText(s: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    if (ch === OPEN && isBlockKind(s[i + 1])) depth++;
    else if (ch === BLOCK_END) depth--;
    else if (depth === 0) out += ch;
  }
  return out;
}

/** The nested block segments of `s`, in order, each with its markers. */
function nestedBlocks(s: string): string[] {
  const blocks: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === OPEN && isBlockKind(s[i + 1])) {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === BLOCK_END) {
      depth--;
      if (depth === 0 && start !== -1) {
        blocks.push(s.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return blocks;
}

/** Removes HTML comments innermost-first until none opens, so remains never reassemble into one. */
function stripComments(text: string): string {
  let out = text;
  for (let open = out.indexOf("<!--"); open !== -1; open = out.indexOf("<!--")) {
    const close = out.indexOf("-->", open + 4);
    out = close === -1 ? out.slice(0, open) : out.slice(0, open) + out.slice(close + 3);
  }
  return out;
}

/** Cuts each BEGIN region through the END marker of the same name; a BEGIN with no matching END, or a stray END, hides nothing. */
function dropGeneratedRegions(stream: string): string {
  let out = stream;
  const begin = new RegExp(`${OPEN}G([^${BLOCK_END}]*)${BLOCK_END}`);
  for (let m = begin.exec(out); m; m = begin.exec(out)) {
    const close = `${OPEN}g${m[1]}${BLOCK_END}`;
    const at = out.indexOf(close, m.index + m[0].length);
    out =
      at === -1
        ? out.slice(0, m.index) + out.slice(m.index + m[0].length)
        : out.slice(0, m.index) + out.slice(at + close.length);
  }
  return out.replace(new RegExp(`${OPEN}g[^${BLOCK_END}]*${BLOCK_END}`, "g"), "");
}

export function scanPage(text: string): Scan {
  const lines = blankFrontMatter(text);
  const nothing = () => "";
  const same = (c: string) => c;
  const stream = Bun.markdown.render(lines.join("\n"), {
    text: same,
    strong: same,
    emphasis: same,
    strikethrough: same,
    blockquote: same,
    list: same,
    heading: (c: string) => `${OPEN}N${c}${BLOCK_END}`,
    code: nothing,
    table: (c: string) => `${OPEN}N${c}${BLOCK_END}`,
    html: (c: string) => {
      // Only the documented marker comment, with its name, opens or closes a region.
      const begin = /^\s*<!-- BEGIN GENERATED: (\S+)/.exec(c);
      const end = /^\s*<!-- END GENERATED: (\S+)/.exec(c);
      if (begin) return `${OPEN}G${begin[1]}${BLOCK_END}`;
      if (end) return `${OPEN}g${end[1]}${BLOCK_END}`;
      return "";
    },
    hr: nothing,
    image: nothing,
    codespan: (c: string) => `${OPEN}C${c}${INLINE_END}`,
    link: (c: string, attrs: { href?: string }) => `${OPEN}A${attrs.href ?? ""}${INLINE_END}${c}`,
    paragraph: (c: string) => `${OPEN}P${c}${BLOCK_END}`,
    listItem: (c: string) => `${OPEN}L${c}${BLOCK_END}`,
  });

  const prose = dropGeneratedRegions(stream);

  const scan: Scan = { units: [], codespans: [], links: [] };
  let cursor = 0;
  // Rendered text has lost its markup (**bold**, [label](url) with the url between label and text),
  // so a line matches when it carries the unit's first two words, letters and digits only.
  const letters = (text: string) => text.replace(/[^A-Za-z0-9]+/g, "");
  const locate = (needle: string): number => {
    const probes = unescapeEntities(needle).split(/\s+/).map(letters).filter(Boolean).slice(0, 2);
    if (probes.length === 0) return cursor;
    for (let i = cursor; i < lines.length; i++) {
      const line = letters(lines[i] ?? "");
      if (probes.every((probe) => line.includes(probe))) return i;
    }
    return cursor;
  };
  const visit = (block: string) => {
    const prose = block[1] !== "N";
    const kind = block[1] === "L" ? "item" : "paragraph";
    const inner = block.slice(2, -1);
    const own = ownText(inner);
    // Inline HTML is invisible to the reader: a comment says nothing, a tag is at most a break.
    const withoutTags = own
      .replace(new RegExp(`${OPEN}A[^${INLINE_END}]*${INLINE_END}`, "g"), "")
      .replace(new RegExp(`${OPEN}C([^${INLINE_END}]*)${INLINE_END}`, "g"), "$1")
      .replace(/<\/?[a-zA-Z][^>]*>/g, " ");
    const plain = stripComments(withoutTags);
    const firstLine = plain.split("\n").find((l) => l.trim() !== "") ?? "";
    const line = locate(firstLine);
    if (prose && plain.trim() !== "") {
      scan.units.push({ kind, line: line + 1, text: unescapeEntities(plain) });
    }
    for (const m of own.matchAll(new RegExp(`${OPEN}C([^${INLINE_END}]*)${INLINE_END}`, "g"))) {
      const code = unescapeEntities(m[1] ?? "");
      scan.codespans.push({ text: code, line: locate(`\`${code}\``) + 1 });
    }
    for (const m of own.matchAll(new RegExp(`${OPEN}A([^${INLINE_END}]*)${INLINE_END}`, "g"))) {
      const href = unescapeEntities(m[1] ?? "");
      scan.links.push({ href, line: locate(href) + 1 });
    }
    // The next unit starts after this one, so a repeated opening line finds its own line, not this one again.
    if (plain.trim() !== "") cursor = line + plain.trim().split("\n").length;
    for (const nested of nestedBlocks(inner)) visit(nested);
  };
  for (const block of nestedBlocks(prose)) visit(block);
  return scan;
}

export function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const EXTENSION = /\.[a-z0-9]{1,10}$/i;

/** The repository path a backticked token names, or null when the token is not one. */
export function pathCandidate(token: string): string | null {
  let path = token
    .trim()
    .replace(/[.,;:]+$/, "")
    .replace(/:\d+(?:-\d+)?$/, "")
    .replace(/[.,;:]+$/, "");
  if (path === "" || /[<>*?${}|\s~[\]]/.test(path) || SCHEME.test(path) || /^[-/]/.test(path))
    return null;
  if (path.startsWith("./") || path.startsWith("../") || path.endsWith("/")) {
    path = path.replace(/\/$/, "");
    return path === "" || path === "." || path === ".." ? null : path;
  }
  return path.includes("/") && EXTENSION.test(path) ? path : null;
}

/** True when `file` is `root` or sits under it, judged by the relative path so the host's separator does not matter. */
function withinRoot(root: string, file: string): boolean {
  const rel = relative(resolve(root), file);
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/** The root, the page's directory, and every directory between: a skill's reference page names `scripts/x.mts` from the skill folder. */
function bases(root: string, pageDir: string): string[] {
  const out = [pageDir];
  for (let dir = pageDir; dir !== root && dir.startsWith(root); dir = dirname(dir))
    out.push(dirname(dir));
  return out;
}

/**
 * A slash path is checked only when its first segment exists at one of the bases:
 * `agents/openai.yaml` in a page about some other layout names nothing here and is left alone,
 * while `skills/gone/SKILL.md` under a real `skills/` is the stale pointer the probe exists for.
 */
function verdict(
  root: string,
  pageDir: string,
  path: string,
): "ok" | "missing" | "foreign" | "outside" {
  const dirs = path.startsWith("./") || path.startsWith("../") ? [pageDir] : bases(root, pageDir);
  const hits = dirs.map((base) => resolve(base, path)).filter((file) => existsSync(file));
  if (hits.some((file) => withinRoot(root, file))) return "ok";
  if (hits.length > 0) return "outside";
  const first = path.split("/")[0] ?? "";
  const anchored =
    first === "." || first === ".." || dirs.some((base) => existsSync(resolve(base, first)));
  return anchored ? "missing" : "foreign";
}

/** The file a relative link addresses: no fragment, no query, percent-escapes decoded when they are valid. */
function linkPath(href: string): string {
  const bare = href.split("#")[0]?.split("?")[0] ?? "";
  try {
    return decodeURIComponent(bare);
  } catch {
    return bare;
  }
}

export function probePage(text: string, file: string, options: ProbeOptions): Finding[] {
  const findings: Finding[] = [];
  const pageDir = dirname(resolve(options.root, file));
  const scan = scanPage(text);
  for (const unit of scan.units) {
    const words = wordCount(unit.text);
    if (words > options.maxWords) {
      const noun = unit.kind === "item" ? "list item" : "paragraph";
      findings.push({
        file,
        line: unit.line,
        message: `${noun} of ${words} words; the cap is ${options.maxWords}. Split it, or turn its facts into bullets, a table, or numbered steps`,
      });
    }
  }
  if (!options.paths) return findings;
  for (const { text: code, line } of scan.codespans) {
    const path = pathCandidate(code);
    const state = path ? verdict(options.root, pageDir, path) : "foreign";
    if (state === "missing") findings.push({ file, line, message: `\`${path}\` does not exist` });
    if (state === "outside")
      findings.push({ file, line, message: `\`${path}\` escapes the repository` });
  }
  for (const { href, line } of scan.links) {
    const target = linkPath(href);
    if (target === "" || SCHEME.test(target) || isAbsolute(target)) continue;
    const resolved = resolve(pageDir, target);
    if (!withinRoot(options.root, resolved)) {
      findings.push({ file, line, message: `link target ${target} escapes the repository` });
    } else if (!existsSync(resolved)) {
      findings.push({ file, line, message: `link target ${target} does not exist` });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

const USAGE = [
  "usage: docs-probe.mts [--root <dir>] [--max-words <n>] [--shape-only] <page.md>...",
  "  --root        the repository root paths resolve against (default: cwd)",
  "  --max-words   the cap on a paragraph or list item (default: 70)",
  "  --shape-only  word counts only; skip the check that named paths exist",
  "exit 0: every page is clean; 1: findings, one per line as page:line: message; 2: usage or an unreadable page",
].join("\n");

interface CliOptions {
  readonly root: string;
  readonly maxWords: number;
  readonly paths: boolean;
  readonly pages: readonly string[];
}

/** Symlinked temp dirs (macOS /var -> /private/var) would otherwise make the page label a ../ chain. */
function realpath(path: string): string {
  const absolute = resolve(path);
  return existsSync(absolute) ? realpathSync.native(absolute) : absolute;
}

export function parseArgs(argv: readonly string[]): CliOptions {
  let root = realpath(process.cwd());
  let maxWords = DEFAULT_MAX_WORDS;
  let paths = true;
  const pages: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? "";
    const value = () => {
      const next = argv[++index];
      if (next === undefined) throw new Error(`${arg} needs a value\n${USAGE}`);
      return next;
    };
    if (arg === "--root") {
      root = realpath(value());
      if (!statSync(root, { throwIfNoEntry: false })?.isDirectory())
        throw new Error(`--root ${root} is not a directory`);
    } else if (arg === "--max-words") {
      maxWords = Number(value());
      if (!Number.isInteger(maxWords) || maxWords < 1)
        throw new Error(`--max-words needs a positive integer\n${USAGE}`);
    } else if (arg === "--shape-only") paths = false;
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n${USAGE}`);
    else pages.push(arg);
  }
  if (pages.length === 0) throw new Error(USAGE);
  return { root, maxWords, paths, pages };
}

if (import.meta.main) {
  let options: CliOptions;
  const findings: Finding[] = [];
  try {
    options = parseArgs(process.argv.slice(2));
    for (const page of options.pages) {
      const absolute = realpath(page);
      if (!statSync(absolute, { throwIfNoEntry: false })?.isFile())
        throw new Error(`${page} is not a readable file`);
      const label = relative(options.root, absolute) || page;
      findings.push(...probePage(readFileSync(absolute, "utf8"), label, options));
    }
  } catch (error) {
    console.error(`docs-probe: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }
  if (findings.length === 0) {
    console.log(
      `docs-probe: ${options.pages.length} page(s) clean (cap ${options.maxWords} words)`,
    );
    process.exit(0);
  }
  console.error(`docs-probe: ${findings.length} finding(s)`);
  for (const finding of findings)
    console.error(`  ${finding.file}:${finding.line}: ${finding.message}`);
  process.exit(1);
}
