import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { browserAuthLauncher } from "../skills/codex-browser-fix/scripts/browser-auth-launcher.mts";

/**
 * Behavioral coverage for browser-plugin-preflight.mts against a fixture app
 * bundle and codex home: the stale-cache and stale-config repair, the
 * read-only --check refusal, and the required-config gate. The codex home is
 * injected through CODEX_HOME and the bundle through --plugin-dir, so the real
 * ~/.codex is never touched.
 */

const SCRIPT = path.join(
  import.meta.dir,
  "..",
  "skills",
  "codex-browser-fix",
  "scripts",
  "browser-plugin-preflight.mts",
);
const OLD_VERSION = "1.0.0";
const NEW_VERSION = "2.0.0";
const NEW_CLIENT = "export const client = 'new';\n";
const OLD_CLIENT = "export const client = 'old';\n";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0))
    await fs.rm(directory, { recursive: true });
});

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function writeExecutable(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, { mode: 0o755 });
}

async function writeChromePlugin(dir: string, version: string, client: string): Promise<void> {
  await fs.mkdir(path.join(dir, ".codex-plugin"), { recursive: true });
  await fs.writeFile(
    path.join(dir, ".codex-plugin", "plugin.json"),
    JSON.stringify({ name: "chrome", version }),
  );
  await fs.mkdir(path.join(dir, "scripts"), { recursive: true });
  await fs.writeFile(path.join(dir, "scripts", "browser-client.mjs"), client);
  await writeExecutable(
    path.join(dir, "extension-host", "macos", "arm64", "ChatGPT for Chrome"),
    "#!/bin/sh\n",
  );
}

type Fixture = {
  home: string;
  resources: string;
  pluginDir: string;
  browserSourceDir: string;
  configPath: string;
  cacheRoot: string;
  browserCacheRoot: string;
  configText: string;
};

// A codex home whose chrome cache, `latest` link, and config still describe
// OLD_VERSION while the app bundle ships NEW_VERSION, with no launcher yet.
async function staleFixture(
  options: { withConfig?: boolean; pinnedEntry?: "directory" | "link-to-other-bundle" } = {},
): Promise<Fixture> {
  // realpath: the preflight canonicalizes the plugin dir, so expected config
  // values must be built from the same canonical form (macOS tmp is a symlink).
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "browser-preflight-test-")),
  );
  temporaryDirectories.push(root);
  const home = path.join(root, "codex-home");
  const resources = path.join(root, "App.app", "Contents", "Resources");
  const pluginsDir = path.join(resources, "plugins", "openai-bundled", "plugins");
  const pluginDir = path.join(pluginsDir, "chrome");
  const browserSourceDir = path.join(pluginsDir, "browser");

  await writeExecutable(path.join(resources, "codex"), "#!/bin/sh\n");
  await writeChromePlugin(pluginDir, NEW_VERSION, NEW_CLIENT);
  await fs.mkdir(path.join(browserSourceDir, "scripts"), { recursive: true });
  await fs.writeFile(path.join(browserSourceDir, "scripts", "browser-client.mjs"), NEW_CLIENT);
  await fs.writeFile(path.join(browserSourceDir, "scripts", "browser-service.mjs"), "service\n");

  const cacheRoot = path.join(home, "plugins", "cache", "openai-bundled", "chrome");
  const browserCacheRoot = path.join(home, "plugins", "cache", "openai-bundled", "browser");
  if (options.pinnedEntry === "link-to-other-bundle") {
    // The shape a preflight run against a previous app install leaves behind.
    const otherBundle = path.join(root, "Other.app", "Contents", "Resources", "plugins", "chrome");
    await writeChromePlugin(otherBundle, OLD_VERSION, OLD_CLIENT);
    await fs.mkdir(cacheRoot, { recursive: true });
    await fs.symlink(otherBundle, path.join(cacheRoot, OLD_VERSION), "dir");
  } else {
    await writeChromePlugin(path.join(cacheRoot, OLD_VERSION), OLD_VERSION, OLD_CLIENT);
  }
  await fs.symlink(path.join(cacheRoot, OLD_VERSION), path.join(cacheRoot, "latest"), "dir");
  await fs.mkdir(browserCacheRoot, { recursive: true });

  const configPath = path.join(home, "config.toml");
  const configText = [
    'model_provider = "custom"',
    "",
    "[mcp_servers.other.env]",
    'CODEX_CLI_PATH = "/other/cli"',
    `BROWSER_USE_CODEX_APP_VERSION = "${OLD_VERSION}"`,
    "",
    "[mcp_servers.node_repl.env]",
    'NODE_REPL_TRUSTED_CODE_PATHS = "stale"',
    `CODEX_HOME = "${home}"`,
    `BROWSER_USE_CODEX_APP_VERSION = "${OLD_VERSION}"`,
    `CODEX_CLI_PATH = "${path.join(resources, "codex")}"`,
    "",
    "[shell_environment_policy.set]",
    'NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = "stale"',
    "",
  ].join("\n");
  // 0600, as the desktop app writes it; the preflight must preserve that.
  if (options.withConfig !== false) await fs.writeFile(configPath, configText, { mode: 0o600 });

  return {
    home,
    resources,
    pluginDir,
    browserSourceDir,
    configPath,
    cacheRoot,
    browserCacheRoot,
    configText,
  };
}

async function runPreflight(
  fixture: Fixture,
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return spawnPreflight(fixture, ["--plugin-dir", fixture.pluginDir, ...args]);
}

async function spawnPreflight(
  fixture: Fixture,
  args: string[],
  options: { cwd?: string; home?: string } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", SCRIPT, ...args], {
    cwd: options.cwd,
    env: { ...process.env, CODEX_HOME: options.home ?? fixture.home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
    exitCode: await child.exited,
  };
}

async function readOrNull(file: string): Promise<string | null> {
  return fs.readFile(file, "utf8").catch(() => null);
}

async function realpathOrNull(file: string): Promise<string | null> {
  return fs.realpath(file).catch(() => null);
}

// The whole post-repair state in one object: caches, links, rollback,
// launcher, and the parsed config, so a regression in any of them fails here.
async function snapshot(fixture: Fixture) {
  const launcherPath = path.join(fixture.home, "scripts", "browser-codex");
  const launcherStat = await fs.stat(launcherPath).catch(() => null);
  const configStat = await fs.stat(fixture.configPath).catch(() => null);
  return {
    config: Bun.TOML.parse((await readOrNull(fixture.configPath)) ?? ""),
    configMode: configStat === null ? null : configStat.mode & 0o777,
    launcher: await readOrNull(launcherPath),
    launcherMode: launcherStat === null ? null : launcherStat.mode & 0o777,
    chromeLatest: await realpathOrNull(path.join(fixture.cacheRoot, "latest")),
    chromeNewEntry: await realpathOrNull(path.join(fixture.cacheRoot, NEW_VERSION)),
    chromeOldEntryClient: await readOrNull(
      path.join(fixture.cacheRoot, OLD_VERSION, "scripts", "browser-client.mjs"),
    ),
    chromeOldEntryVersion: JSON.parse(
      (await readOrNull(
        path.join(fixture.cacheRoot, OLD_VERSION, ".codex-plugin", "plugin.json"),
      )) ?? "{}",
    ).version,
    rollbackClient: await readOrNull(
      path.join(
        fixture.home,
        "plugin-rollbacks",
        "openai-bundled",
        "chrome",
        OLD_VERSION,
        "scripts",
        "browser-client.mjs",
      ),
    ),
    browserLatest: await realpathOrNull(path.join(fixture.browserCacheRoot, "latest")),
    browserEntryClient: await readOrNull(
      path.join(fixture.browserCacheRoot, NEW_VERSION, "scripts", "browser-client.mjs"),
    ),
  };
}

test("sync repairs a stale codex home and --check then passes", async () => {
  const fixture = await staleFixture();
  const sync = await runPreflight(fixture);
  const after = await snapshot(fixture);
  const check = await runPreflight(fixture, "--check");
  const realCli = path.join(fixture.resources, "codex");

  expect({ sync, after, check }).toEqual({
    sync: {
      exitCode: 0,
      stderr: "",
      stdout: [
        "Chrome plugin preflight synchronized.",
        `App bundle: ${NEW_VERSION}`,
        `Latest: ${await fs.realpath(fixture.pluginDir)}`,
        `Pinned cache entries: ${OLD_VERSION}`,
        `Browser companion caches: ${fixture.browserCacheRoot}`,
        "Browser auth: process-only OpenAI provider override installed; main provider unchanged.",
        "",
      ].join("\n"),
    },
    after: {
      configMode: 0o600,
      config: {
        model_provider: "custom",
        mcp_servers: {
          other: {
            env: { CODEX_CLI_PATH: "/other/cli", BROWSER_USE_CODEX_APP_VERSION: OLD_VERSION },
          },
          node_repl: {
            env: {
              NODE_REPL_TRUSTED_CODE_PATHS: [
                fixture.home,
                path.join(fixture.home, "plugins"),
                path.join(fixture.resources, "cua_node/lib/node_modules"),
              ].join(":"),
              CODEX_HOME: fixture.home,
              BROWSER_USE_CODEX_APP_VERSION: NEW_VERSION,
              CODEX_CLI_PATH: path.join(fixture.home, "scripts", "browser-codex"),
            },
          },
        },
        shell_environment_policy: {
          set: { NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: sha256(NEW_CLIENT) },
        },
      },
      launcher: browserAuthLauncher(realCli),
      launcherMode: 0o700,
      chromeLatest: await fs.realpath(fixture.pluginDir),
      chromeNewEntry: await fs.realpath(fixture.pluginDir),
      chromeOldEntryClient: NEW_CLIENT,
      chromeOldEntryVersion: NEW_VERSION,
      rollbackClient: OLD_CLIENT,
      browserLatest: await fs.realpath(fixture.browserSourceDir),
      browserEntryClient: NEW_CLIENT,
    },
    check: {
      exitCode: 0,
      stderr: "",
      // The sync created the NEW_VERSION link, so the check now lists it too.
      stdout: sync.stdout
        .replace("synchronized", "verified")
        .replace(`entries: ${OLD_VERSION}`, `entries: ${OLD_VERSION}, ${NEW_VERSION}`),
    },
  });
});

// Both roots are persisted (symlink targets, launcher path, config values):
// given relative to the caller's cwd they must yield the same absolute paths
// as when given absolute, or the next --check from elsewhere reports drift.
test("relative --plugin-dir and CODEX_HOME resolve against the caller's cwd", async () => {
  const fixture = await staleFixture();
  const cwd = path.dirname(fixture.home);
  const sync = await spawnPreflight(
    fixture,
    ["--plugin-dir", path.relative(cwd, fixture.pluginDir)],
    { cwd, home: path.relative(cwd, fixture.home) },
  );
  const config = Bun.TOML.parse((await readOrNull(fixture.configPath)) ?? "") as {
    mcp_servers: { node_repl: { env: Record<string, string> } };
  };
  expect({
    exitCode: sync.exitCode,
    stderr: sync.stderr,
    chromeLatest: await realpathOrNull(path.join(fixture.cacheRoot, "latest")),
    chromeNewEntry: await realpathOrNull(path.join(fixture.cacheRoot, NEW_VERSION)),
    launcherPath: config.mcp_servers.node_repl.env.CODEX_CLI_PATH,
    check: (await runPreflight(fixture, "--check")).exitCode,
  }).toEqual({
    exitCode: 0,
    stderr: "",
    chromeLatest: fixture.pluginDir,
    chromeNewEntry: fixture.pluginDir,
    launcherPath: path.join(fixture.home, "scripts", "browser-codex"),
    check: 0,
  });
});

test("a pinned entry linking to another bundle is repointed, not copied into", async () => {
  const fixture = await staleFixture({ pinnedEntry: "link-to-other-bundle" });
  const sync = await runPreflight(fixture);
  expect({
    exitCode: sync.exitCode,
    stderr: sync.stderr,
    oldEntry: await realpathOrNull(path.join(fixture.cacheRoot, OLD_VERSION)),
    check: (await runPreflight(fixture, "--check")).exitCode,
  }).toEqual({ exitCode: 0, stderr: "", oldEntry: fixture.pluginDir, check: 0 });
});

test("an unreadable hosts directory fails the check instead of passing as no hosts", async () => {
  const fixture = await staleFixture();
  await runPreflight(fixture);
  const hostsRoot = path.join(fixture.home, "hosts");
  await fs.mkdir(hostsRoot, { mode: 0o000 });
  try {
    const check = await runPreflight(fixture, "--check");
    expect({ exitCode: check.exitCode, eacces: check.stderr.includes("EACCES") }).toEqual({
      exitCode: 1,
      eacces: true,
    });
  } finally {
    await fs.chmod(hostsRoot, 0o700);
  }
});

test("--check refuses a stale codex home without writing anything", async () => {
  const fixture = await staleFixture();
  const before = await snapshot(fixture);
  const check = await runPreflight(fixture, "--check");
  expect({ check, after: await snapshot(fixture) }).toEqual({
    check: {
      exitCode: 1,
      stdout: "",
      stderr: `Chrome plugin preflight failed: Browser auth launcher is missing or stale: ${path.join(fixture.home, "scripts", "browser-codex")}\n`,
    },
    after: before,
  });
});

test.each([
  [
    "the global config.toml is missing",
    { withConfig: false },
    ["--check"],
    1,
    (fixture: Fixture) => `Codex configuration is missing: ${fixture.configPath}`,
  ],
  [
    "--plugin-dir has no value",
    {},
    ["--check", "--plugin-dir"],
    2,
    () => "usage: browser-plugin-preflight.mts [--check] [--plugin-dir <dir>]",
  ],
  [
    "an unknown flag is given (it must not fall through to a sync)",
    {},
    ["--dry-run"],
    2,
    () => "usage: browser-plugin-preflight.mts [--check] [--plugin-dir <dir>]",
  ],
])("fails without writing when %s", async (_, options, args, exitCode, message) => {
  const fixture = await staleFixture(options);
  const before = await snapshot(fixture);
  const result = await spawnPreflight(fixture, [
    ...(args.includes("--plugin-dir") ? [] : ["--plugin-dir", fixture.pluginDir]),
    ...args,
  ]);
  expect({
    ...result,
    stderr: result.stderr.includes(message(fixture)),
    after: await snapshot(fixture),
  }).toEqual({
    stdout: "",
    stderr: true,
    exitCode,
    after: before,
  });
});
