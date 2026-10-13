import { expect, test } from "bun:test";
import { withTomlValues } from "../../../skills/codex-browser-fix/scripts/codex-config-toml.mts";

// The same key under three tables plus a look-alike inside a multiline
// string: only the addressed table's assignment may change.
const configLines = [
  'model_provider = "custom"',
  'instructions = """',
  'CODEX_CLI_PATH = "instruction text"',
  'BROWSER_USE_CODEX_APP_VERSION = "instruction text"',
  '"""',
  "[mcp_servers.other.env]",
  'CODEX_CLI_PATH = "other process"',
  'BROWSER_USE_CODEX_APP_VERSION = "0.0.0"',
  "[mcp_servers.node_repl.env]",
  'CODEX_CLI_PATH = "/original/cli"',
  'BROWSER_USE_CODEX_APP_VERSION = "1.0.0"',
  'CODEX_HOME = "/existing/home"',
  "[shell_environment_policy.set]",
  'NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = "stale"',
  "",
];

test.each(["\n", "\r\n"])("changes only the addressed assignments with newline %j", (newline) => {
  const source = configLines.join(newline);
  const settings = {
    "mcp_servers.node_repl.env.CODEX_CLI_PATH": "/browser/helper",
    "mcp_servers.node_repl.env.BROWSER_USE_CODEX_APP_VERSION": "2.0.0",
    "shell_environment_policy.set.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S": "fresh",
  };
  const updated = withTomlValues(source, settings);
  expect({
    text: updated,
    config: Bun.TOML.parse(updated),
    repeated: withTomlValues(updated, settings),
  }).toEqual({
    text: source
      .replace('CODEX_CLI_PATH = "/original/cli"', 'CODEX_CLI_PATH = "/browser/helper"')
      .replace('BROWSER_USE_CODEX_APP_VERSION = "1.0.0"', 'BROWSER_USE_CODEX_APP_VERSION = "2.0.0"')
      .replace(
        'NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = "stale"',
        'NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = "fresh"',
      ),
    repeated: updated,
    config: {
      model_provider: "custom",
      instructions:
        'CODEX_CLI_PATH = "instruction text"\nBROWSER_USE_CODEX_APP_VERSION = "instruction text"\n',
      mcp_servers: {
        other: { env: { CODEX_CLI_PATH: "other process", BROWSER_USE_CODEX_APP_VERSION: "0.0.0" } },
        node_repl: {
          env: {
            CODEX_CLI_PATH: "/browser/helper",
            BROWSER_USE_CODEX_APP_VERSION: "2.0.0",
            CODEX_HOME: "/existing/home",
          },
        },
      },
      shell_environment_policy: { set: { NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: "fresh" } },
    },
  });
});

test.each([
  [
    "the key exists only under another server",
    '[mcp_servers.other.env]\nCODEX_CLI_PATH = "/original/cli"\n',
    { "mcp_servers.node_repl.env.CODEX_CLI_PATH": "/browser/helper" },
    "Missing mcp_servers.node_repl.env.CODEX_CLI_PATH",
  ],
  [
    "the key exists only in the node_repl table",
    '[mcp_servers.node_repl.env]\nNODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = "x"\n',
    { "shell_environment_policy.set.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S": "y" },
    "Missing shell_environment_policy.set.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S",
  ],
  [
    "the value is not a string",
    "[mcp_servers.node_repl.env]\nCODEX_CLI_PATH = 3\n",
    { "mcp_servers.node_repl.env.CODEX_CLI_PATH": "/browser/helper" },
    "Missing mcp_servers.node_repl.env.CODEX_CLI_PATH",
  ],
])("refuses to add a value when %s", (_, source, settings, message) => {
  expect(() => withTomlValues(source, settings)).toThrow(message);
});

// Regression: the edit used to rewrite the whole assignment line, so the
// trailing comment and the spacing around `=` were lost. Only the value
// token may change; a `#` inside the quotes is part of the value.
test.each([
  [
    "commented",
    'CODEX_CLI_PATH = "/old" # selected by preflight',
    'CODEX_CLI_PATH = "/new#2" # selected by preflight',
  ],
  ["tight spacing", 'CODEX_CLI_PATH="/old"#note', 'CODEX_CLI_PATH="/new#2"#note'],
  [
    "wide spacing",
    '  CODEX_CLI_PATH   =   "/old"   # note  ',
    '  CODEX_CLI_PATH   =   "/new#2"   # note  ',
  ],
  ["hash inside the value", 'CODEX_CLI_PATH = "/old#1" # note', 'CODEX_CLI_PATH = "/new#2" # note'],
  ["literal string", "CODEX_CLI_PATH = '/old#1' # note", 'CODEX_CLI_PATH = "/new#2" # note'],
  ["quoted key", '"CODEX_CLI_PATH" = "/old" # note', '"CODEX_CLI_PATH" = "/new#2" # note'],
])("replaces only the value token on a %s line", (_, line, expectedLine) => {
  const source = `[env]\n${line}\nOTHER = "kept" # other comment\n`;
  const updated = withTomlValues(source, { "env.CODEX_CLI_PATH": "/new#2" });
  expect(updated).toBe(`[env]\n${expectedLine}\nOTHER = "kept" # other comment\n`);
  expect(Bun.TOML.parse(updated)).toEqual({ env: { CODEX_CLI_PATH: "/new#2", OTHER: "kept" } });
});
