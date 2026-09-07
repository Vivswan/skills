# Codex Browser Fix

`/codex-browser-fix` keeps the Codex desktop app's bundled Chrome plugin driving your Chromium browser (Brave, Vivaldi, Opera, Edge, Chrome) on macOS. It fixes the two things the vendor skill does not: the `Codex auth token is unavailable` error under a custom model provider, and the stale plugin cache after a desktop app update. It also selects browser families the vendor skill has no named selector for.

Codex only. Claude Code and GitHub Copilot have no Chrome plugin to fix; the skill is inert there.

## Install

From the collection:

```bash
npx skills add Vivswan/skills -g --skill codex-browser-fix -a codex
```

Directly from this folder:

```bash
npx skills add https://github.com/Vivswan/skills/tree/main/skills/codex-browser-fix -g -a codex
```

## What It Does

- Syncs `~/.codex/plugins/cache/openai-bundled/{chrome,browser}` and the Node REPL trust settings to the installed app bundle
- Installs a launcher that overrides `model_provider` for the browser helper's `app-server` subprocess only; your main provider and credentials stay put
- Selects Brave and other Chromium families by `family` from the plugin's connection list
- Verifies read-only with `--check`, from any terminal with Bun

```bash
bun scripts/browser-plugin-preflight.mts          # sync + verify
bun scripts/browser-plugin-preflight.mts --check  # read-only verify
```

## Layout

- [`SKILL.md`](./SKILL.md): symptom table, preflight, family selection, recovery
- [`references/recovery.md`](./references/recovery.md): the auth incident specimen, what the preflight synchronizes, extension-versus-tab failures
- [`scripts/browser-plugin-preflight.mts`](./scripts/browser-plugin-preflight.mts): the sole setup implementation
- [`scripts/browser-auth-launcher.mts`](./scripts/browser-auth-launcher.mts): launcher generator and the `config.toml` edit; tested in the authoring repository's `tests/browser-auth-launcher.test.ts`

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app manifests can be added later without moving the skill.
