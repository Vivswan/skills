// Generates the browser-only codex launcher: a shell wrapper that appends the
// provider override to `codex app-server` and passes every other subcommand
// through. Shared with the preflight and the authoring repository's tests.

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
