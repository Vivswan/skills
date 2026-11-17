---
name: think-in-trees
description: "Use when working out where something belongs or how a set of things relates, before answering: a file or folder, a command or flag, a page, a menu item, a setting, an alert, a task, a step in a failing chain. Place it in the whole tree first; clashes, duplicates, and wrong parents then show by themselves, to you and to the reader."
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Think in Trees

> Anything with parts is a tree, and the tree is the analysis. Before placing, naming, or judging a thing, know its parent and its siblings in the whole tree. Clashes, duplicates, and wrong parents then show by themselves, to the agent doing the work and to the reader who comes after.

The picture is how the analysis is shown, not where it happens. An agent that thinks this way catches the faults while reasoning, before anything is written; the drawn tree lets the owner see the same thing in one look.

One CLI's `--help`, before and after. Twenty commands under prose titles became a tree, and five faults showed at once.

Before, the help as it was (the CLI is invented, the faults are real):

```text
one vault
  backup <path>  set  show  list  prune  new-link  duplicate  delete  restore
you, on this machine
  login  logout  whoami  --login <email>  --log-in  --no-log-in  --logins
the install
  install  uninstall  doctor  --repair  --update  --add-user  update
  config  export  import  mcp
```

After, the same commands as a tree:

```text
<cli>
|-- backup <path>
|-- vaults      set  show  list  prune  new-link  duplicate  delete  restore
|-- auth        login  logout  whoami
|-- install
|   |-- install <provider>
|   |   `-- s3           --bucket <name> | --no-bucket
|   |-- doctor
|   |   `-- --repair
|   |       `-- --update  --add-user <email>
|   `-- uninstall  update  config
|-- transfer    export  import
`-- agent       mcp
```

- **Look-alike siblings:** `--login <email>` sat beside `--log-in/--no-log-in`, one hyphen apart, two meanings.
- **One concept, two names:** `--logins`, `--add-user`, and a "Users" page were one thing.
- **Wrong parent:** export, import, and mcp sat under "the install".
- **Missing leaf:** `--bucket` existed and was not in the help.
- **Undrawn branch:** `doctor --repair` owned flags that were only legal under it.

## When to Apply

- Any time the question is "where does this go" or "what is this next to": a file, a folder, a command, a flag, a page, a menu item, a setting, an alert, a task
- Before designing or reviewing a folder layout, a CLI, a docs site, a menu, a settings surface, an alert stream, or a work queue, and during the analysis that precedes them
- A failure crosses layers and the path it walks has not been laid out
- The owner says "show me the whole tree structure", "it is still a little bit flat", or "don't make it flat"; "expand the tree" or "detail tree" asks for every node on its own line

## The Method

1. **Hold the whole tree before answering.** For anything placed or named, know its parent, its siblings, and its depth. Shown to the owner, it is a text tree before any prose; in the agent's own reasoning, it is the same structure.
2. **The first level is the dimension the reader arrives with.** A flat form hides one every time: situation kind, state ownership, concept, account, reader action, dependency.
3. **Run the checks** in the table below on the tree, drawn or held. They need no judgment once the structure exists, which is why the agent catches them unprompted.
4. **Agree the tree, then move.** A pure move with every reference repointed is its own change; splits and rewrites follow it (the `/code-standards` skill's pure-move rule).
5. **Make the tree a guard.** A folder cap, a test that mirrors sources, a portable-words check, a sidebar ordered by the tree. A tree nobody guards goes flat again.

## The Checks

| Check                  | Fails when                                                            | Seen as                           |
| ---------------------- | --------------------------------------------------------------------- | --------------------------------- |
| look-alike siblings    | two children differ by a letter or a hyphen and mean different things | `--login` beside `--log-in`       |
| one concept, two names | the same thing is reachable under two names or two parents            | `--logins`, `--add-user`, "Users" |
| wrong parent           | a child belongs to another node                                       | `export` under "install"          |
| missing leaf           | a child exists and its parent's listing does not show it              | `--bucket` absent from help       |
| undrawn branch         | a leaf is legal only under another leaf                               | `doctor --repair` and its flags   |
| too wide               | a node has more than about eight children                             | a runbooks folder of 24 files     |
| duplicate rows         | grouping puts two entries side by side that say one thing             | two decisions about one tool      |

## Rules That Held in Every Run

- **Group by concept, never by kind.** `actions/`, `console/`, `commands/` with 20 to 30 files each became one folder per concept, with tests mirroring.
- **A node name says what is under it,** in one word where it can. A folder called `run/` meant nothing to its reader.
- **One place per thing.** A sub-tab that is a sibling pretending to be a child, or an action under the wrong page, is reached one way after the tree.
- **Mirror trees:** tests mirror sources, docs mirror the product (a page per screen), the CLI mirrors the code (a command's code lives where the tree says).
- **Kinds are branches, not if-branches.** `providers/<name>/{shared, with-domain, without-domain}` replaced `if (noDomain)` scattered through one path.
- **Some leaves are pinned from outside.** An older build loads a file by its path; the tree marks it and the move leaves it.
- **The listing is the tree.** One-word group titles in `--help`, the whole tree on one page under `--full-help`, the folder listing readable without opening a file.
- **The picture reads in one pass.** Tree lines for the branches, leaves of one kind sharing a line, a short note at one column, no line past about 80 characters. Too much on a line is read twice; one leaf per line makes the picture too tall.
- **Two renderings.** The tree, as above, is the default. The expanded tree puts every node on its own line, every level shown: drawn when the owner says "expand the tree" or "detail tree", or when a leaf needs a note of its own.

## Surfaces

Each page carries the specimen for its surface: before, the tree, what it showed, what changed, the guard.

- `references/folders.md`: source trees, apps by state ownership, a provider as a sibling folder
- `references/cli.md`: commands as branches, flags as leaves, `--full-help`
- `references/docs.md`: runbooks by situation, a page per screen, decisions in families
- `references/navigation.md`: a side menu, a dashboard home page, kill switches in one column
- `references/config.md`: where settings live, a home governing other repositories and organizations
- `references/streams.md`: alerts tiered by what the reader does next
- `references/debugging.md`: the call tree a failure walks, and a landing queue as a dependency table

## Related

- `/code-standards`: the file inside the folder (named after its main thing, siblings share a template) and the pure-move PR; its structure page hands the folders themselves to this skill.
- `/no-invalid-states`: a leaf legal only under another leaf, once drawn as a branch, becomes a type.
- `/working-text`: the tree picture is a device; the words beside it follow that skill.
- `/orchestrator-mode`: a brief that touches a layout, a CLI, or docs points here.

## Review Criteria

- A layout, CLI, docs set, menu, or config change made with no whole-tree picture drawn first.
- A first level grouped by kind (files, scripts, misc) instead of the dimension the reader arrives with.
- Look-alike siblings, one concept under two names, a child under the wrong parent, a leaf missing from its listing, a leaf legal only under another leaf left undrawn, or a node with more than about eight children.
- A folder called a defect for being "read by nothing" without the reader test: does a reader learn something from the path they could not learn as fast another way?
- A tree agreed without a guard: no cap, no mirror test, no order check.
