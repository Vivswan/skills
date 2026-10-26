// The layering declaration (architecture.yml), shape-checked, and the module
// map rendered from it. Two commands read it: lint.mts and render-map.mts.

import { readFileSync } from "node:fs";

export const DEFAULT_CONFIG = "architecture.yml";

export interface Architecture {
  /** layer -> the repo-relative paths it owns; a trailing slash means a directory. */
  readonly layers: Readonly<Record<string, readonly string[]>>;

  /** Glob patterns of files that are not sources of the graph (tests, fixtures). An import INTO one is still an edge. */
  readonly exclude: readonly string[];

  /** from -> the layers it may import; a layer absent here imports nothing outside itself. */
  readonly edges: Readonly<Record<string, readonly string[]>>;
}

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

function requireShape(parsed: unknown, label: string): Architecture {
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
  return { layers, exclude, edges };
}

function requireEdgesNameLayers(arch: Architecture, label: string): void {
  for (const [from, targets] of Object.entries(arch.edges)) {
    for (const name of [from, ...targets]) {
      if (!Object.hasOwn(arch.layers, name)) {
        throw new Error(`${label}: edges name "${name}", which is not a layer`);
      }
    }
  }
}

function requireRelativePaths(arch: Architecture, label: string): void {
  for (const [layer, paths] of Object.entries(arch.layers)) {
    for (const path of paths) {
      if (path.startsWith("/") || path.split("/").includes("..")) {
        throw new Error(
          `${label}: layer ${layer} names ${path}, which leaves the repository; paths are repository-relative`,
        );
      }
      // The scanner emits src/main.ts, never ./src/main.ts, so a dot segment could own nothing.
      if (path.split("/").includes(".")) {
        throw new Error(`${label}: layer ${layer} names ${path}; write it without the . segment`);
      }
    }
  }
}

function overlaps(a: string, b: string): boolean {
  return a === b || (a.endsWith("/") && b.startsWith(a)) || (b.endsWith("/") && a.startsWith(b));
}

/** layerOf takes the first match in YAML order, so an overlap would hand one layer's files to another silently; the declaration refuses it instead. */
function requireOneOwner(arch: Architecture, label: string): void {
  const owned = Object.entries(arch.layers).flatMap(([layer, paths]) =>
    paths.map((path) => ({ layer, path })),
  );
  for (const [i, a] of owned.entries()) {
    for (const b of owned.slice(i + 1)) {
      if (a.layer === b.layer || !overlaps(a.path, b.path)) continue;
      const inner = a.path.length >= b.path.length ? a.path : b.path;
      throw new Error(
        `${label}: layers ${a.layer} and ${b.layer} overlap on ${inner}; a file has one owner`,
      );
    }
  }
}

/** The declaration at `path`, shape-checked: a typo in a layer name under edges is an error here, not a silent pass. */
export function readArchitecture(path: string, label = path): Architecture {
  const parsed: unknown = Bun.YAML.parse(readFileSync(path, "utf8"));
  const arch = requireShape(parsed, label);
  requireEdgesNameLayers(arch, label);
  requireRelativePaths(arch, label);
  requireOneOwner(arch, label);
  return arch;
}

/** The layer owning a repo-relative path, or undefined. */
export function layerOf(arch: Architecture, path: string): string | undefined {
  return Object.entries(arch.layers).find(([, paths]) =>
    paths.some((owned) => (owned.endsWith("/") ? path.startsWith(owned) : path === owned)),
  )?.[0];
}

const MERMAID_KEYWORDS = new Set([
  "end",
  "graph",
  "flowchart",
  "subgraph",
  "style",
  "class",
  "classdef",
  "click",
  "linkstyle",
  "direction",
]);

/**
 * The module map over the DECLARED edges. A hyphen in a layer name is edge syntax to mermaid, so ids
 * use underscores; two names that collapse to one id (api-v1, api_v1) get a numbered suffix, so no
 * node is drawn over another.
 */
export function renderArchitectureMermaid(arch: Architecture): string {
  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const layer of Object.keys(arch.layers)) {
    const sanitized = layer.replace(/[^A-Za-z0-9_]/g, "_");
    // `end` and the other flowchart keywords break the parse as node ids; a trailing underscore keeps the name readable.
    const base = MERMAID_KEYWORDS.has(sanitized.toLowerCase()) ? `${sanitized}_` : sanitized;
    let candidate = base;
    for (let n = 2; taken.has(candidate); n++) candidate = `${base}_${n}`;
    taken.add(candidate);
    ids.set(layer, candidate);
  }
  const id = (layer: string): string => ids.get(layer) ?? layer;
  return [
    "graph TD",
    ...Object.entries(arch.layers).map(([name, paths]) => `  ${id(name)}["${paths.join("<br>")}"]`),
    ...Object.entries(arch.edges).flatMap(([from, targets]) =>
      targets.map((to) => `  ${id(from)} --> ${id(to)}`),
    ),
  ].join("\n");
}
