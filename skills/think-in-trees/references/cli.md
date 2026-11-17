# A CLI as a Tree

Commands are branches, flags are leaves, a provider or a mode is a nested branch. The help output is the tree, not a description of it.

## The specimen

The CLI tree, before and after, with the five faults it exposed, is the specimen at the top of this skill's SKILL.md. Two of its shapes bear repeating here.

```text
|-- install
|   |-- install <provider>
|   |   `-- s3           --bucket <name> | --no-bucket
|   |                    (a provider is a nested branch)
|   `-- doctor
|       `-- --repair
|           `-- --update  --add-user <email>
|               (legal only under --repair: a branch)
```

## Rules on this surface

- **Group titles are one word** and say what is under them: `vaults`, `auth`, `install`, `transfer`, `agent`.
- **A flag legal only under another flag is a branch.** Draw it as one, then make it one: a subcommand, or a type the `/no-invalid-states` skill owns.
- **The CLI tree mirrors the code tree.** A command's code lives in the folder the tree says: `commands/install/`, `commands/vault/`.
- **Siblings read apart at a glance.** Two flags one hyphen apart are renamed before anything else.
- **The help lists every leaf.** A flag the parser accepts and the help omits is a missing leaf, found only by drawing.
