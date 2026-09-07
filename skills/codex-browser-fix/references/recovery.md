# Recovery

## Provider authentication

Specimen, 2026-09-07, desktop app bundle `26.901.51231`: discovery found the Brave extension, but every command failed with `Codex auth token is unavailable`. The message came from `cua_node/bin/node_repl`, which launches `codex app-server --listen stdio://` to authenticate the browser helper.

The same `getAuthStatus` request with `includeToken: false` returned:

| Helper launch | Auth method |
| --- | --- |
| Inherits the custom `model_provider` from `config.toml` | `null` |
| Process-only `-c 'model_provider="openai"'` | `chatgpt` |

So the sign-in was fine; the helper just asked the wrong provider for it.

The fix is scoped to that one subprocess:

- `scripts/browser-auth-launcher.mts` generates `~/.codex/scripts/browser-codex`. Its `app-server` branch appends the provider override; every other subcommand (sandbox launch, `login status`, anything else) passes through untouched.
- The preflight points only `mcp_servers.node_repl.env.CODEX_CLI_PATH` at that launcher, in `<home>/config.toml` and any `<home>/hosts/*/config.toml`. Every config edit is verified by parsing: if changing the addressed value would alter any other setting, the preflight refuses. The same key under another server's table is left alone.
- `CODEX_HOME`, the main `model_provider`, and the stored credentials stay as they are. No temporary home, no credential copy, no global provider toggle.

If the error persists after a new helper starts:

1. Check the helper's actual launch command; a helper started before the preflight still has the old `CODEX_CLI_PATH`.
2. Run the preflight with `--check`.
3. Follow the installed Chrome plugin's `chrome-troubleshooting` guidance.
4. If sign-in is genuinely required, report that as the user's action. Never extract or copy tokens.

## App bundle and cache drift

The desktop app updates in place; the plugin cache under `~/.codex` does not follow. `scripts/browser-plugin-preflight.mts` is the sole implementation and verifies or synchronizes:

- pinned Chrome cache entries and the `latest` link under `<home>/plugins/cache/openai-bundled/chrome`
- the Browser companion files (`browser-client.mjs`, `browser-service.mjs`) in the global and host-local caches
- app version and trusted code paths in `[mcp_servers.node_repl.env]`, and the `browser-client.mjs` hash in `[shell_environment_policy.set]`
- the browser-only CLI launcher beside each config

Replaced cache contents move to `<home>/plugin-rollbacks/`. They are repair backups, never alternate runtimes. A missing bundle, `config.toml`, or executable is an error; the preflight never reports a pass over one (the authoring repository's `tests/browser-plugin-preflight.test.ts` pins this).

## Extension or tab failures

Distinguish a missing connection from a missing tab first:

| Signal | Meaning | Action |
| --- | --- | --- |
| Tab reported missing, stale, or closed | Tab binding is dead, browser binding is fine | Get a fresh tab from the existing browser binding |
| `list()` shows no `extension` entry for the family | Extension not connected | Read `bootstrap-troubleshooting`, then `chrome-troubleshooting`, from the plugin's documentation |
| Explicit browser-disconnected error | Browser binding is dead | Re-select the browser; only this or a user-requested switch justifies re-selection |

Never switch browser families, launch a standalone browser, or use another control mechanism to route around a failure. If recovery needs the user (installing the extension, signing in), report that exact action and preserve live work. Do not promise a connection will stay active indefinitely.
