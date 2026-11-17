# Streams as Trees

Alerts, notifications, mail from a system: a flat stream hides what the reader is supposed to do next. The first level is that action.

## Alert tiers

Before: one stream of mails under one subject shape, a dozen a day.

```text
[lab] unit media failed      [lab] unit media recovered     [lab] disk 81%
[lab] door check ok          [lab] canary fired             [lab] disk 82%
[lab] dependency PR waiting  [lab] new admin token          [lab] reboot pending
```

```text
<alerts>
|-- warning     read later: one digest at 07:00
|   `-- disk nearing full  a dependency update waiting  a reboot pending
|-- alert       look now: once, plus a recovery mail
|   `-- a unit down  a door down  a machine too hot
`-- urgent      act now: hourly until acknowledged
    `-- a canary fired  a new admin user or token  a budget line crossed
```

What it showed: three reader actions (read later, look now, act now) under one prefix.

What changed: the subject carries the tier, the body says what to do, and the digest replaced a dozen mails a day.

## Rules on this surface

- **First level: what the reader does next.** Not the source, not the severity word the system uses.
- **A tier has a delivery shape:** a digest, a single mail with its recovery, a repeat until acknowledged.
- **The subject names the tier** so a mail client can sort by it.
