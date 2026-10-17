#!/usr/bin/env bun
// The page probe of /working-text: the two readings a reviewer otherwise
// takes by eye, made exact.
//   a paragraph or list item over the word cap (default 70)  -> finding, exit 1
//   a repository path the prose names that does not exist    -> finding, exit 1
// Block structure is the page's Markdown tree (CommonMark plus GFM tables), so
// what counts as prose is what Markdown makes a paragraph or a tight list item:
// headings, code (fenced or indented), tables, raw HTML, and images contribute
// nothing. Front matter is blanked before parsing; a BEGIN/END GENERATED region
// is dropped where its markers are top-level HTML blocks, so a marker quoted
// inside a fence, under >, or mid-paragraph is text and changes nothing.
// A path is a backticked token with a slash and an extension (or ./, ../, a
// trailing slash), or a relative link destination; placeholders (<...>),
// globs, owner/repo slugs, and bare file names are left alone, since a page
// may name files the reader will create.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { List, Nodes, RootContent } from "mdast";
import type { Position } from "unist";

// The bundle in .build/ is <name>.js built from <name>.mts; a vendored copy under another name prints that name,
// an importer never its own.
const SELF = basename(import.meta.path).replace(/\.js$/, ".mts");
const USAGE = [
  `usage: ${SELF} [--root <dir>] [--base <dir>]... [--max-words <n>] [--shape-only] <page.md>...`,
  "  --root        the repository root paths resolve against (default: cwd)",
  "  --base        a directory under the root that paths also resolve against (repeatable)",
  "  --max-words   the cap on a paragraph or list item (default: 70)",
  "  --shape-only  word counts only; skip the check that named paths exist",
  "exits: 0 every page is clean; 1 findings, one per line as page:line: message; 2 usage or an unreadable page",
].join("\n");

// Above the self-build: a cold install with no network still answers --help.
if (import.meta.main && (process.argv[2] === "--help" || process.argv[2] === "-h")) {
  console.log(USAGE);
  process.exit(0);
}

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
const { fromMarkdown } = await import("mdast-util-from-markdown");
const { gfmFromMarkdown } = await import("mdast-util-gfm");
const { gfm } = await import("micromark-extension-gfm");
const { visit } = await import("unist-util-visit");

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
  /** Extra directories a slash path also resolves against: a shipped tree that mirrors the layout the page describes. */
  readonly bases?: readonly string[];
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

// A marker line as the renderer that splices regions reads it: up to three spaces in, the name, an optional hint on BEGIN.
const MARKER = /^ {0,3}<!-- (BEGIN|END) GENERATED: (\S+?)(?: \([^)\r\n]*\))? -->[ \t]*$/;

/** The region name a top-level HTML block opens or closes; a comment that only begins like a marker is not one. */
function markerName(node: RootContent, kind: "BEGIN" | "END"): string | undefined {
  const marker = node.type === "html" ? MARKER.exec(node.value) : null;
  return marker?.[1] === kind ? marker[2] : undefined;
}

/** `blocks` without each BEGIN region through the END marker of the same name; a BEGIN with no matching END, or a stray END, hides nothing. */
function withoutGenerated(blocks: readonly RootContent[]): RootContent[] {
  const kept: RootContent[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as RootContent;
    const name = markerName(block, "BEGIN");
    const close =
      name === undefined ? -1 : blocks.findIndex((n, j) => j > i && markerName(n, "END") === name);
    if (close !== -1) i = close;
    else kept.push(block);
  }
  return kept;
}

/** A tight list renders its items' text bare; one blank line anywhere in it makes every item a paragraph. */
function isTight(list: List): boolean {
  return !list.spread && !list.children.some((item) => item.spread);
}

/** fromMarkdown positions every node; the type leaves it optional for trees built by hand. */
function startLine(node: Nodes): number {
  const position: Position | undefined = node.position;
  if (position === undefined) throw new Error(`${node.type} node without a position`);
  return position.start.line;
}

/**
 * The text a reader sees: a comment is nothing (it joins what it sits between), any other inline
 * HTML is at most a break, a hard break is a line, an image is nothing.
 */
function visibleText(node: Nodes): string {
  if (node.type === "html") return node.value.startsWith("<!--") ? "" : " ";
  if (node.type === "break") return "\n";
  if ("value" in node) return node.value;
  return "children" in node ? node.children.map(visibleText).join("") : "";
}

export function scanPage(text: string): Scan {
  const tree = fromMarkdown(blankFrontMatter(text).join("\n"), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  // A definition resolves references anywhere on the page, a generated region included; one no reference uses renders no link.
  const definitions = new Map<string, string>();
  visit(tree, "definition", (node) => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
  const scan: Scan = { units: [], codespans: [], links: [] };
  const walk = (nodes: readonly RootContent[], itemText: boolean) => {
    for (const node of nodes) {
      const line = startLine(node);
      if (node.type === "paragraph") {
        const prose = visibleText(node);
        if (prose.trim() !== "") {
          scan.units.push({ kind: itemText ? "item" : "paragraph", line, text: prose });
        }
      } else if (node.type === "inlineCode") {
        scan.codespans.push({ text: node.value, line });
      } else if (node.type === "link") {
        scan.links.push({ href: node.url, line });
      } else if (node.type === "linkReference") {
        const href = definitions.get(node.identifier);
        if (href !== undefined) scan.links.push({ href, line });
      }
      if (!("children" in node)) continue;
      const tight = node.type === "list" ? isTight(node) : node.type === "listItem" && itemText;
      walk(node.children, tight);
    }
  };
  // Only a top-level pair is a region, as the renderer splices it; one under > or in a list is quoted text.
  walk(withoutGenerated(tree.children), false);
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
  // A bare startsWith("..") would also reject a directory named `..vendor`.
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The page's directory, every directory up to the root, then the extra bases: a skill's reference
 * page names `scripts/x.mts` from the skill folder.
 */
function bases(root: string, pageDir: string, extra: readonly string[]): string[] {
  const out = [pageDir];
  for (let dir = pageDir; dir !== root && dir.startsWith(root); dir = dirname(dir))
    out.push(dirname(dir));
  return [...out, ...extra];
}

/**
 * A slash path is checked only when its first segment exists at one of the bases:
 * `agents/openai.yaml` in a page about some other layout names nothing here and is left alone,
 * while `skills/gone/SKILL.md` under a real `skills/` is the stale pointer the probe exists for.
 */
function verdict(
  root: string,
  pageDir: string,
  extra: readonly string[],
  path: string,
): "ok" | "missing" | "foreign" | "outside" {
  const dirs =
    path.startsWith("./") || path.startsWith("../") ? [pageDir] : bases(root, pageDir, extra);
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
    const state = path ? verdict(options.root, pageDir, options.bases ?? [], path) : "foreign";
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

interface CliOptions {
  readonly root: string;
  readonly bases: readonly string[];
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
  const baseArgs: string[] = [];
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
    } else if (arg === "--base") {
      baseArgs.push(value());
    } else if (arg === "--max-words") {
      maxWords = Number(value());
      if (!Number.isInteger(maxWords) || maxWords < 1)
        throw new Error(`--max-words needs a positive integer\n${USAGE}`);
    } else if (arg === "--shape-only") paths = false;
    else if (arg.startsWith("-")) throw new Error(`unknown option ${arg}\n${USAGE}`);
    else pages.push(arg);
  }
  if (pages.length === 0) throw new Error(USAGE);
  // Resolved after the loop so a --root given later still governs every --base.
  const bases = baseArgs.map((arg) => {
    const base = realpath(resolve(root, arg));
    if (!statSync(base, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(`--base ${base} is not a directory`);
    if (!withinRoot(root, base)) throw new Error(`--base ${base} is outside the root ${root}`);
    return base;
  });
  return { root, bases, maxWords, paths, pages };
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
