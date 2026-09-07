// Generates the browser-only codex launcher and edits string values in a
// config.toml by full dotted path. Every edit is verified by re-parsing: it
// must change exactly the requested value and nothing else, or it refuses.
// Shared with the preflight and the authoring repository's tests.
import { isDeepStrictEqual } from "node:util";

export function browserAuthLauncher(realCliPath: string): string {
  const executable = `'${realCliPath.replaceAll("'", "'\\''")}'`;
  return `#!/bin/sh
case "$1" in
  app-server)
    exec ${executable} "$@" -c 'model_provider="openai"'
    ;;
  *)
    exec ${executable} "$@"
    ;;
esac
`;
}

type Toml = Record<string, unknown>;

function isTable(value: unknown): value is Toml {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// The table holding the last segment of `dottedPath`, or undefined when any
// intermediate segment is not a table.
function parentTable(config: Toml, segments: readonly string[]): Toml | undefined {
  let table: Toml = config;
  for (const segment of segments.slice(0, -1)) {
    const next = table[segment];
    if (!isTable(next)) return undefined;
    table = next;
  }
  return table;
}

// Rewrite one `key = ...` assignment so the parsed document equals `expected`.
// Candidates are every assignment line for that key anywhere in the file; the
// one in the right table is the one whose replacement parses to `expected`.
function replaceAssignment(source: string, key: string, value: string, expected: Toml): string {
  const escaped = key.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const assignments = source.matchAll(
    new RegExp(`^[\\t ]*(?:${escaped}|"${escaped}"|'${escaped}')[\\t ]*=[^\\r\\n]*`, "gm"),
  );
  for (const match of assignments) {
    const updated =
      source.slice(0, match.index) +
      `${key} = ${JSON.stringify(value)}` +
      source.slice(match.index + match[0].length);
    try {
      if (isDeepStrictEqual(Bun.TOML.parse(updated), expected)) return updated;
    } catch {
      // Matching text inside a multiline string is not a configuration assignment.
    }
  }
  throw new Error(`Cannot safely update ${key} without changing unrelated configuration.`);
}

/**
 * Set string values by full dotted path (e.g. `mcp_servers.node_repl.env.CODEX_CLI_PATH`).
 * Each path must already be assigned a string (a key that only exists in
 * another table is missing); the source is returned unchanged when every
 * value already matches.
 */
export function withTomlValues(source: string, settings: Record<string, string>): string {
  const expected = Bun.TOML.parse(source) as Toml;
  const targets = Object.entries(settings).map(([dottedPath, value]) => {
    const segments = dottedPath.split(".");
    const key = segments[segments.length - 1] ?? "";
    const table = parentTable(expected, segments);
    if (table === undefined || typeof table[key] !== "string") {
      throw new Error(`Missing ${dottedPath} in browser configuration.`);
    }
    return { table, key, value };
  });
  let updated = source;
  for (const { table, key, value } of targets) {
    if (table[key] === value) continue;
    table[key] = value;
    updated = replaceAssignment(updated, key, value, expected);
  }
  return updated;
}
