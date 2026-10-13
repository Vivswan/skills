// The architecture page as Markdown reads it: every fence, the GENERATED region
// markers, the headings, and the "Demonstrated by:" lines. check-page.mts tests
// the page through it; render-map.mts finds the region to splice through it.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Nodes, Paragraph, Root } from "mdast";

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
const { fromMarkdown } = await import("mdast-util-from-markdown");
const { gfmFromMarkdown } = await import("mdast-util-gfm");
const { toString: plainText } = await import("mdast-util-to-string");
const { gfm } = await import("micromark-extension-gfm");
const { visit } = await import("unist-util-visit");

export const DEMONSTRATED = "Demonstrated by:";

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

/** The destinations a paragraph links, a reference link through its definition. */
function linkTargets(paragraph: Paragraph, definitions: ReadonlyMap<string, string>): string[] {
  const links: string[] = [];
  visit(paragraph, (node) => {
    if (node.type === "link") links.push(node.url);
    else if (node.type === "linkReference") {
      const url = definitions.get(node.identifier);
      if (url !== undefined) links.push(url);
    }
  });
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
  visit(root, "definition", (node) => {
    if (!definitions.has(node.identifier)) definitions.set(node.identifier, node.url);
  });
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
    visit(block, "code", (node) => {
      const at = positionOf(node);
      fences.push({
        line: at.start.line,
        end: at.end.line,
        mermaid: node.lang === "mermaid",
        body: node.value,
        generated,
      });
    });
  }
  return { fences, markers, headings, demonstrations };
}
