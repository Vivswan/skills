import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  browserAuthLauncher,
  withTomlValues,
} from "../skills/codex-browser-fix/scripts/browser-auth-launcher.mts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await fs.rm(directory, { recursive: true });
});

test.each([
  [
    "auth app-server",
    ["app-server", "--listen", "stdio://"],
    ["app-server", "--listen", "stdio://", "-c", 'model_provider="openai"'],
  ],
  [
    "existing provider override",
    ["app-server", "-c", 'model_provider="custom"'],
    ["app-server", "-c", 'model_provider="custom"', "-c", 'model_provider="openai"'],
  ],
  [
    "sandbox launch",
    ["sandbox", "macos", "--", "echo", "spaces $quotes"],
    ["sandbox", "macos", "--", "echo", "spaces $quotes"],
  ],
  ["normal CLI", ["login", "status"], ["login", "status"]],
] as Array<[string, string[], string[]]>)(
  "launcher scopes the override to %s and preserves process behavior",
  async (_, args, expected) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-launcher-test-"));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, "CLI with 'quotes' and $spaces");
    const launcher = path.join(directory, "browser-cli");
    await fs.writeFile(executable, '#!/bin/sh\nprintf "%s\\n" "$@"\nexit 23\n', { mode: 0o700 });
    await fs.writeFile(launcher, browserAuthLauncher(executable), { mode: 0o700 });
    const child = Bun.spawn([launcher, ...args], { stdout: "pipe", stderr: "pipe" });
    expect({
      args: (await new Response(child.stdout).text()).trimEnd().split("\n"),
      stderr: await new Response(child.stderr).text(),
      exitCode: await child.exited,
    }).toEqual({ args: expected, stderr: "", exitCode: 23 });
  },
);

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
