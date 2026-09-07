#!/usr/bin/env bun
// Keeps the Codex desktop app's bundled Chrome plugin usable from ~/.codex:
// the plugin cache and Node REPL trust settings follow the installed app
// bundle, and the browser helper's `codex app-server` gets a launcher that
// overrides model_provider for that one subprocess (see
// browser-auth-launcher.mts). Run with bun; node builtins only.
//
// Default: synchronize, then verify. `--check`: verify only, throwing on the
// first drift instead of repairing it. Any error exits 1 with the message;
// a pass is never reported over a missing file or setting.
//
// Roots: the codex home is $CODEX_HOME or ~/.codex; the plugin is the first
// existing bundled Chrome plugin of the ChatGPT or Codex desktop app, or the
// directory given with `--plugin-dir <dir>`.

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { browserAuthLauncher, withTomlValues } from "./browser-auth-launcher.mts";

type PluginManifest = {
  name: string;
  version: string;
};

function usage(): never {
  console.error("usage: browser-plugin-preflight.mts [--check] [--plugin-dir <dir>]");
  process.exit(2);
}

// Strict: an unknown flag must not fall through to a synchronizing run.
let checkOnly = false;
let pluginDirOverride: string | undefined;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--check") checkOnly = true;
  else if (arg === "--plugin-dir" && args[index + 1] !== undefined) {
    index += 1;
    pluginDirOverride = args[index];
  } else usage();
}
const appPluginCandidates = pluginDirOverride
  ? [pluginDirOverride]
  : [
      "/Applications/ChatGPT.app/Contents/Resources/plugins/openai-bundled/plugins/chrome",
      "/Applications/Codex.app/Contents/Resources/plugins/openai-bundled/plugins/chrome",
    ];
// Absolute: the home is persisted into config values and the launcher path,
// which the helper later resolves from its own cwd.
const codexHome = path.resolve(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"));
const cacheRoot = path.join(codexHome, "plugins", "cache", "openai-bundled", "chrome");
const rollbackRoot = path.join(codexHome, "plugin-rollbacks", "openai-bundled", "chrome");
const browserRollbackRoot = path.join(codexHome, "plugin-rollbacks", "openai-bundled", "browser");
const codexConfigPath = path.join(codexHome, "config.toml");
const codexHostsRoot = path.join(codexHome, "hosts");
const versionPattern = /^\d+\.\d+\.\d+$/;

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

// Canonical (realpath) so every derived value is the same however the
// directory was given: symlink targets, the launcher's CLI path, and the
// trusted code paths all land in config and must match on the next --check.
// Host-local codex homes (<home>/hosts/<host>/). Only a missing hosts
// directory means "no hosts"; any other error (EACCES) must fail the run.
async function listHostDirectories(): Promise<string[]> {
  try {
    const entries = await fs.readdir(codexHostsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(codexHostsRoot, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

// The desktop app may rewrite the config while the preflight runs: stage the
// new content, then refuse the swap if the file no longer matches the
// snapshot the edit was computed from. The check sits right before the
// rename, so only the app writing in that gap can still be lost; the app
// takes no lock the preflight could honor.
async function writeConfig(configPath: string, snapshot: string, updated: string): Promise<void> {
  const mode = (await fs.stat(configPath)).mode & 0o777;
  const temporaryPath = `${configPath}.preflight-${process.pid}`;
  try {
    await fs.writeFile(temporaryPath, updated, { mode });
    await fs.chmod(temporaryPath, mode); // writeFile's mode is subject to umask
    if ((await fs.readFile(configPath, "utf8")) !== snapshot) {
      throw new Error(`${configPath} changed while the preflight ran; rerun it`);
    }
    await fs.rename(temporaryPath, configPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}

async function findAppPlugin(): Promise<string> {
  for (const candidate of appPluginCandidates) {
    if (await exists(path.join(candidate, ".codex-plugin", "plugin.json"))) {
      return fs.realpath(candidate);
    }
  }
  throw new Error(
    `Could not find the Chrome plugin bundled with ChatGPT or Codex (looked in ${appPluginCandidates.join(", ")}).`,
  );
}

async function readManifest(pluginDir: string): Promise<PluginManifest> {
  const manifestPath = path.join(pluginDir, ".codex-plugin", "plugin.json");
  const parsed = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Partial<PluginManifest>;
  if (parsed.name !== "chrome" || !parsed.version) {
    throw new Error(`Invalid Chrome plugin manifest: ${manifestPath}`);
  }
  return { name: parsed.name, version: parsed.version };
}

async function sha256(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

async function syncNodeReplBrowserTrust(sourceDir: string, version: string): Promise<void> {
  const realCliPath = path.resolve(sourceDir, "../../../..", "codex");
  await fs.access(realCliPath, fsConstants.X_OK);
  const launcherSource = browserAuthLauncher(realCliPath);
  const clientHash = await sha256(path.join(sourceDir, "scripts", "browser-client.mjs"));
  // The global config is required: without it there is no node_repl helper
  // to fix, so a pass would be vacuous. Host-local configs exist only on
  // some installs and are synchronized where present.
  if (!(await exists(codexConfigPath))) {
    throw new Error(`Codex configuration is missing: ${codexConfigPath}`);
  }
  const hostConfigPaths = (await listHostDirectories()).map((host) =>
    path.join(host, "config.toml"),
  );
  const configPaths = [codexConfigPath];
  for (const hostConfigPath of hostConfigPaths) {
    if (await exists(hostConfigPath)) configPaths.push(hostConfigPath);
  }

  for (const configPath of configPaths) {
    const config = await fs.readFile(configPath, "utf8");
    const configHome = path.dirname(configPath);
    const launcherPath = path.join(configHome, "scripts", "browser-codex");
    const installedLauncher = await fs.readFile(launcherPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (installedLauncher !== launcherSource) {
      if (checkOnly) throw new Error(`Browser auth launcher is missing or stale: ${launcherPath}`);
      await fs.mkdir(path.dirname(launcherPath), { recursive: true });
      await fs.writeFile(launcherPath, launcherSource, { mode: 0o700 });
      await fs.chmod(launcherPath, 0o700);
    }
    await fs.access(launcherPath, fsConstants.X_OK);
    // Settings the browser helper reads. Each must already be assigned at
    // its path (a missing one is an error, not an insertion) and the edit
    // must leave every other setting untouched. The client hash lives in
    // the shell environment policy, not the node_repl env table.
    const updated = withTomlValues(config, {
      "mcp_servers.node_repl.env.CODEX_CLI_PATH": launcherPath,
      "mcp_servers.node_repl.env.BROWSER_USE_CODEX_APP_VERSION": version,
      "mcp_servers.node_repl.env.NODE_REPL_TRUSTED_CODE_PATHS": [
        configHome,
        path.join(codexHome, "plugins"),
        path.resolve(sourceDir, "../../../..", "cua_node/lib/node_modules"),
      ].join(":"),
      "shell_environment_policy.set.NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S": clientHash,
    });
    if (updated === config) continue;
    if (checkOnly) throw new Error(`Node REPL browser trust settings are stale in ${configPath}`);
    await writeConfig(configPath, config, updated);
  }
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.realpath(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function rollbackPathFor(cachePath: string, root = rollbackRoot): string {
  return path.join(root, path.basename(cachePath));
}

async function ensureSymlink(
  linkPath: string,
  targetPath: string,
  rollbackBase = rollbackRoot,
): Promise<void> {
  const resolvedLink = await realpathOrNull(linkPath);
  const resolvedTarget = await fs.realpath(targetPath);
  if (resolvedLink === resolvedTarget) return;
  if (checkOnly) throw new Error(`${linkPath} does not resolve to ${targetPath}`);

  if (await exists(linkPath)) {
    const stat = await fs.lstat(linkPath);
    if (!stat.isSymbolicLink()) {
      const rollbackPath = rollbackPathFor(linkPath, rollbackBase);
      if (await exists(rollbackPath)) {
        throw new Error(
          `Refusing to replace ${linkPath}; rollback already exists at ${rollbackPath}`,
        );
      }
      await fs.rename(linkPath, rollbackPath);
    } else {
      await fs.unlink(linkPath);
    }
  }
  await fs.symlink(targetPath, linkPath, "dir");
}

async function browserCacheRoots(): Promise<string[]> {
  const roots = [path.join(codexHome, "plugins", "cache", "openai-bundled", "browser")];
  for (const host of await listHostDirectories()) {
    roots.push(path.join(host, "plugins", "cache", "openai-bundled", "browser"));
  }
  return roots;
}

async function syncBrowserCompanionDirectory(sourceDir: string, targetDir: string): Promise<void> {
  const requiredRelativePaths = [
    path.join("scripts", "browser-client.mjs"),
    path.join("scripts", "browser-service.mjs"),
  ];
  const targetStat = await fs.lstat(targetDir).catch(() => null);
  const matches =
    targetStat?.isDirectory() === true &&
    !targetStat.isSymbolicLink() &&
    (
      await Promise.all(
        requiredRelativePaths.map(async (relativePath) => {
          const targetFile = path.join(targetDir, relativePath);
          return (
            (await exists(targetFile)) &&
            (await sha256(path.join(sourceDir, relativePath))) === (await sha256(targetFile))
          );
        }),
      )
    ).every(Boolean);
  if (matches) return;
  if (checkOnly)
    throw new Error(`${targetDir} is not a verified local copy of the Browser companion`);

  if (targetStat) {
    if (targetStat.isSymbolicLink()) {
      await fs.unlink(targetDir);
    } else {
      const fingerprint = createHash("sha256").update(targetDir).digest("hex").slice(0, 12);
      const rollbackPath = path.join(
        browserRollbackRoot,
        `${path.basename(targetDir)}-${fingerprint}`,
      );
      if (await exists(rollbackPath))
        throw new Error(`Browser companion rollback already exists: ${rollbackPath}`);
      await fs.rename(targetDir, rollbackPath);
    }
  }
  await fs.cp(sourceDir, targetDir, { recursive: true, force: false });
}

async function syncBrowserCompanion(chromeSourceDir: string, version: string): Promise<string[]> {
  const browserSourceDir = path.join(path.dirname(chromeSourceDir), "browser");
  const requiredFiles = [
    path.join(browserSourceDir, "scripts", "browser-client.mjs"),
    path.join(browserSourceDir, "scripts", "browser-service.mjs"),
  ];
  for (const requiredFile of requiredFiles) {
    if (!(await exists(requiredFile)))
      throw new Error(`Bundled Browser companion is missing: ${requiredFile}`);
  }

  const roots = await browserCacheRoots();
  if (!checkOnly) await fs.mkdir(browserRollbackRoot, { recursive: true });
  for (const root of roots) {
    if (!checkOnly) await fs.mkdir(root, { recursive: true });
    if (checkOnly && !(await exists(root)))
      throw new Error(`Browser companion cache is missing: ${root}`);
    await syncBrowserCompanionDirectory(browserSourceDir, path.join(root, version));
    await ensureSymlink(path.join(root, "latest"), browserSourceDir, browserRollbackRoot);
  }
  return roots;
}

async function syncPinnedDirectory(sourceDir: string, targetDir: string): Promise<void> {
  const sourceRealpath = await fs.realpath(sourceDir);
  if ((await realpathOrNull(targetDir)) === sourceRealpath) return;

  const sourceManifest = await readManifest(sourceDir);
  const targetManifest = await readManifest(targetDir).catch(() => null);
  const sourceController = path.join(sourceDir, "scripts", "browser-client.mjs");
  const targetController = path.join(targetDir, "scripts", "browser-client.mjs");
  const controllerMatches =
    (await exists(targetController)) &&
    (await sha256(sourceController)) === (await sha256(targetController));

  if (targetManifest?.version === sourceManifest.version && controllerMatches) return;
  if (checkOnly) {
    throw new Error(`${targetDir} is not synchronized with app plugin ${sourceManifest.version}`);
  }

  // A pinned entry that is a link to another bundle has no content of its
  // own to back up or copy into; repoint it (fs.cp onto a link fails EISDIR).
  if ((await fs.lstat(targetDir)).isSymbolicLink()) {
    await fs.unlink(targetDir);
    await fs.symlink(sourceDir, targetDir, "dir");
    return;
  }

  const rollbackPath = rollbackPathFor(targetDir);
  if (!(await exists(rollbackPath))) {
    await fs.cp(targetDir, rollbackPath, { recursive: true, force: false });
  }
  await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
}

async function verifyPlugin(pluginDir: string, sourceDir: string): Promise<void> {
  const manifest = await readManifest(pluginDir);
  const sourceManifest = await readManifest(sourceDir);
  if (manifest.version !== sourceManifest.version) {
    throw new Error(`${pluginDir} reports ${manifest.version}; expected ${sourceManifest.version}`);
  }

  const controllerRelativePath = path.join("scripts", "browser-client.mjs");
  const sourceHash = await sha256(path.join(sourceDir, controllerRelativePath));
  const targetHash = await sha256(path.join(pluginDir, controllerRelativePath));
  if (sourceHash !== targetHash) throw new Error(`Controller hash mismatch in ${pluginDir}`);

  // The bundle ships one architecture directory under extension-host/macos
  // (arm64 today); require an executable native host in whichever it is.
  const hostRoot = path.join(pluginDir, "extension-host", "macos");
  const architectures = await fs.readdir(hostRoot).catch(() => []);
  const hosts = await Promise.all(
    architectures.map((arch) =>
      fs
        .access(path.join(hostRoot, arch, "ChatGPT for Chrome"), fsConstants.X_OK)
        .then(() => true)
        .catch(() => false),
    ),
  );
  if (!hosts.some(Boolean)) {
    throw new Error(`No executable "ChatGPT for Chrome" native host under ${hostRoot}`);
  }
}

async function main(): Promise<void> {
  const sourceDir = await findAppPlugin();
  const sourceManifest = await readManifest(sourceDir);
  await syncNodeReplBrowserTrust(sourceDir, sourceManifest.version);
  if (checkOnly && !(await exists(cacheRoot))) {
    throw new Error(`Chrome plugin cache is missing: ${cacheRoot}`);
  }
  if (!checkOnly) await fs.mkdir(cacheRoot, { recursive: true });
  if (!checkOnly) await fs.mkdir(rollbackRoot, { recursive: true });

  const entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  const pinnedNames = entries
    .filter(
      (entry) => versionPattern.test(entry.name) && (entry.isDirectory() || entry.isSymbolicLink()),
    )
    .map((entry) => entry.name);

  for (const pinnedName of pinnedNames) {
    await syncPinnedDirectory(sourceDir, path.join(cacheRoot, pinnedName));
  }

  const currentVersionPath = path.join(cacheRoot, sourceManifest.version);
  if (!(await exists(currentVersionPath))) {
    if (checkOnly) throw new Error(`Missing current-version link: ${currentVersionPath}`);
    await fs.symlink(sourceDir, currentVersionPath, "dir");
  } else {
    await syncPinnedDirectory(sourceDir, currentVersionPath);
  }

  await ensureSymlink(path.join(cacheRoot, "latest"), sourceDir);
  const companionRoots = await syncBrowserCompanion(sourceDir, sourceManifest.version);

  for (const pinnedName of pinnedNames) {
    await verifyPlugin(path.join(cacheRoot, pinnedName), sourceDir);
  }
  await verifyPlugin(currentVersionPath, sourceDir);
  await verifyPlugin(path.join(cacheRoot, "latest"), sourceDir);

  console.log(
    [
      `Chrome plugin preflight ${checkOnly ? "verified" : "synchronized"}.`,
      `App bundle: ${sourceManifest.version}`,
      `Latest: ${await fs.realpath(path.join(cacheRoot, "latest"))}`,
      `Pinned cache entries: ${pinnedNames.length ? pinnedNames.join(", ") : "none"}`,
      `Browser companion caches: ${companionRoots.join(", ")}`,
      "Browser auth: process-only OpenAI provider override installed; main provider unchanged.",
    ].join("\n"),
  );
}

main().catch((error: unknown) => {
  console.error(
    `Chrome plugin preflight failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
