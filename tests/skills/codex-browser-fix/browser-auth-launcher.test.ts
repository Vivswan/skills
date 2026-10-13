import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { browserAuthLauncher } from "../../../skills/codex-browser-fix/scripts/browser-auth-launcher.mts";
import { tempDirs } from "../../helpers/temp-dirs";

const temp = tempDirs();

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
    const directory = temp.dir("browser-launcher-test-");
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
