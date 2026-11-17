# Debugging With a Tree

A failure that crosses layers is found by laying out the path it walks. A queue of work with dependencies is read the same way.

## The call tree a secret walks

The symptom: a release step failed with "token is not set", though the token was set in the repository and two workflows had already used it.

```text
ci.yml                        passes TOKEN explicitly
`-- release.yml               receives TOKEN, calls the next workflow
    `-- deploy.yml            receives nothing: stops one edge short
        `-- "token is not set"
```

What it showed: secrets pass one edge at a time; the third level got none. No log said so; the tree did.

What changed: one line in the second workflow, and a rule for the repository's own CI pages: a reusable workflow chain is drawn with what each edge passes.

## A landing queue

Before: status to the owner as prose, with two builders stacked on a branch that had not landed.

```text
"installer is building, audit is nearly done, fence waits on audit, detect and tiers are
 both ready and based on fence, the VM is busy"
```

```text
main
`-- installer                 holds the one heavy slot
    `-- audit
        `-- fence
            `-- detect  tiers     stacked on fence: rebase after it lands
```

What it showed: who holds the one heavy slot, who is stacked on whom, which builders must rebase.

What changed: the status became that tree; collisions on the shared machine stopped.

## Rules on this surface

- **Lay out the path before reading logs.** The layer where a value stops is visible in the tree and invisible in any one log.
- **Dependencies are edges.** A queue, a stack of branches, a chain of workflows: show the edge, and the wait or the rebase is obvious.
- **The picture is the status.** A reader who sees the tree does not need the paragraph.
