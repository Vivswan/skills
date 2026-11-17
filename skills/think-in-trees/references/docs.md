# A Docs Site as a Tree

A reader arrives with a question. The first level is the kind of question, and a page is named like the screen or the job it describes. Names are invented; the shapes are real.

## Runbooks by situation

Before: 24 runbooks in one folder, four kinds of situation interleaved, "something broke" with no home.

```text
docs/runbooks/
  add-a-cloud.md  dead-disk.md  canary-fired.md  migrate-the-pool.md
  new-tv.md  roll-back.md  add-a-machine.md  compromised-machine.md
  resize-a-volume.md  new-laptop.md  add-an-app.md  billing-stopped.md
  restore-one-app.md  filter-a-device.md  runner-down.md  move-an-app.md
  restore-everything.md  yearly-drill.md  pending-reboot.md  ...
docs/decisions.md     30 sections in arrival order, two of them about the same tool
```

```text
docs/
|-- apps/         home-automation.md  media.md  wiki.md
|-- runbooks/
|   |-- incidents/    something broke
|   |   |-- canary-fired  compromised-machine  billing-stopped
|   |   `-- runner-down  pending-reboot
|   |-- changes/      I want to change the lab
|   |   |-- add-an-app  add-a-machine  add-a-cloud  move-an-app
|   |   `-- roll-back  upgrade-the-kernel
|   |-- storage/      disks and backups
|   |   |-- migrate-the-pool  resize-a-volume  restore-one-app
|   |   `-- restore-everything  yearly-drill  dead-disk
|   `-- devices/      things that join
|       `-- new-tv  new-laptop  filter-a-device
`-- decisions.md  eight families, a contents list on top
```

What it showed: the four kinds; three apps with enough human steps for a page each; a decisions file written in arrival order carried duplicates that only grouping into families exposed.

What changed: a pure move with links repointed, and the decisions file regrouped into families, kept as one file at the owner's word.

## A page per screen

Before: `docs/{start, use, run, about}`, where `run/` held eight unrelated pages and meant nothing to the reader.

```text
docs/
  start/   with-an-agent.md  by-hand.md  from-a-terminal.md
  use/     publish.md  who-can-open.md  manage.md  agent-tools.md  back-up.md
  run/     update.md  remove.md  settings.md  domain.md  activity.md
           usage.md  problems.md  refuses.md
  about/   security.md  how-it-is-built.md  limits-and-cost.md (181 lines, 7 topics)
```

```text
docs/
|-- start/        install
|   `-- with-an-agent  by-hand  from-a-terminal  with-opentofu
|-- sites/        publish and manage
|   `-- publish  who-can-open  manage  agent-tools
|-- dashboard/    one page per screen, in the side menu's order
|   `-- sites  activity  usage  access  domain  settings
|-- upkeep/       looking after an install
|   |-- update  back-up  remove
|   `-- cost/     what-can-cost-money  limits  what-one-action-costs
|-- fix/          when something goes wrong
|   `-- an-install-step-fails  refuses  problems
`-- about/        security  between-sites  how-it-is-built
```

What it showed: the docs tree should mirror the product's own tree; "something went wrong" lived in three folders; one 181-line page held seven topics.

What changed: pages moved and split, no text rewritten, and the sidebar order became the tree order.

## Rules on this surface

- **A page about a screen is named like the screen; a page about a job is named like the job.**
- **The docs tree mirrors the product tree.** A dashboard with six screens has six pages under one folder, in the menu's order.
- **A folder name that means nothing to the reader** (`run/`, `misc/`, `other/`) is a missing first level.
- **The words on each page** follow the `/working-text` skill; this page owns only where the page sits.
