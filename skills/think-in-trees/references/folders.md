# Folders as Trees

A folder tree is read before any file is opened, and it costs nothing to read. Three runs, each a before, the tree, what it showed, what changed. Names are invented; the shapes are real.

## A platform by concept

Before: 22 modules in one folder, their scripts in another, every option declared in one file far from the module that read it.

```text
src/platform/
  options.nix  assertions.nix  manifest.nix  secrets.nix  render.nix  facts.nix
  network.nix  storage.nix  provision.nix  bluetooth.nix  reboot.nix  watchdog.nix
  deploy.nix  alerts.nix  backup.nix  canaries.nix  card.nix  oci.nix  installer.nix
  containers.nix  images.nix  lifecycle.nix
  scripts/
    deploy.ts (600 lines)  alert.ts  backup.ts  canaries.ts  bluetooth.ts
    http.ts (copied three times)
```

```text
src/platform/
|-- default.nix
|-- app/          what an app is
|   `-- kind.nix  containers.nix  images.nix  lifecycle.nix  seed.nix
|-- machine/      one machine's body
|   |-- network.nix  provision.nix  reboot.nix  watchdog.nix
|   |-- storage/      layout.nix  pool.nix
|   `-- bluetooth/    bluetooth.nix  bluetooth.ts
|-- secrets/      secrets.nix  render.nix  facts.nix
|-- deploy/       deploy.nix  deploy.ts  host.ts  steps/
|-- alerts/       alerts.nix  alert.ts
|-- backup/       backup.nix  backup.ts  restore.ts
|-- canaries/     canaries.nix  canaries.ts
`-- image/        card.nix  oci.nix  installer.nix
```

What it showed: each concept's module and its script side by side; an option belongs in the module that reads it; three scripts had copied one HTTP helper, which fell out into one shared library.

What changed: eight pure-move commits, each with a build-output proof, then the feature rounds built on the folders.

## Apps by state ownership

Before: every app one file in one folder, one secrets file for all of them, first-run seeds as shell inside strings.

```text
apps/
  dns.nix  git-mirror.nix  homepage.nix  home-automation.nix  media.nix
  wiki.nix  proxy.nix
  secrets.yaml                        every app's keys in one file
  (each seed: 80 lines of shell inside its .nix string)
```

```text
src/apps/
|-- code/         fully declared: rebuilds from git
|   |-- dns/              default.nix  secrets.yaml
|   |-- git-mirror/       default.nix  image.nix  template/
|   |-- homepage/         default.nix  background.svg
|   `-- proxy/            default.nix
`-- ui/           keeps state in its UI: back it up first
    |-- home-automation/  default.nix  seed.ts  secrets.yaml
    |-- media/            default.nix  seed.ts
    `-- wiki/             default.nix  seed.ts

tests/            mirrors src/, so a folder carries its proof by shape
|-- apps/
|   |-- code/     dns.nix  git-mirror.nix  homepage.nix  proxy.nix
|   `-- ui/       home-automation.nix  media.nix  wiki.nix
`-- platform/     app.nix  machine.nix  secrets.nix  deploy.nix  ...
```

What it showed: which apps hold hand-set state, from the path alone; a secret belongs beside its only reader (readers became a build check); an 80-line seed in a string is a file.

What changed: three rounds (the split, per-app secrets, seeds as files), then the tests moved out of `src/` into a tree that mirrors it.

A folder may exist only to tell the reader a fact no code reads. The test is the reader, not the code: does a reader learn something here they could not learn as fast another way? A level whose fact the file names already show fails it (a `scripts/` folder holding every `.ts` file).

## A provider as a sibling folder

Before: provider code mixed into the portable app, infrastructure files at the root, twenty tests in one folder.

```text
packages/
  core/src/    names.ts  sites.ts  records.ts  auth.ts  storage.ts  ... (25 files)
  app/src/     sites.ts  limits.ts  login.ts  api.ts  s3-bucket.ts  s3-policy.ts  ...
  worker/src/  index.ts  bindings.ts  s3-driver.ts  db-driver.ts
  tests/       20 files, flat
tofu/          at the root, provider-specific
```

```text
packages/
|-- core/         the product's rules, no provider
|   |-- src/      names/  sites/  records/  auth/  storage/
|   |             database/  migrations/  actions/
|   `-- tests/    mirrors src/ one to one
|-- app/          serving, no provider word anywhere
|   `-- src/      sites/  limits/  login/  api/  dashboard/
|-- cli/
|   `-- src/
|       |-- commands/   line/  site/  install/  backup/  auth/
|       `-- files/  local/  client/  mcp/
`-- providers/
    `-- s3/       a second provider is a sibling folder here
        `-- src/  shared/  with-domain/  without-domain/
```

What it showed: provider words inside portable code; a second provider is a sibling folder; `if (noDomain)` scattered through one path was two systems sharing one engine.

What changed: one pure-rename move of 148 files, then three guards: tests mirror sources, a size cap per folder never raised except for a new concept, and a portable-words check. Two files stayed where older builds load them by path.

## Rules on this surface

- **Concept folders, never kind folders.** `actions/` with 25 files is a kind; `commands/{line, site, install, backup, auth}` is concepts.
- **The file inside the folder** follows the `/code-standards` skill: named after its main public thing, helpers beside it, every sibling on one template.
- **A move is a pure move,** its own change, with an export census and an equal test count (the `/code-standards` skill's structure page).
- **A folder is a concept:** the base sits beside one file per variant, so adding a variant adds one file and nothing else moves.
- **Entry points sit at the root,** one runnable per run. Small functions several stages share sit under one shared folder, grouped by what they serve, as a stage keeps its own in its `util` module.
