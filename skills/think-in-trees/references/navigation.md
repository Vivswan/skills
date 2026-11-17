# Navigation as a Tree

A menu, a dashboard, a home page: the reader goes here, then there. One place per thing. Names are invented; the shapes are real.

## A side menu

Before: top tabs with sub-tabs, sign-out hidden in a menu, a "Computers" page nobody could place.

```text
[Sites] [Activity | Usage] [Settings | Domain] [Computers]        (menu) Sign out
          Settings also holds: users, tokens, "sign everyone out"
```

```text
<dashboard>
|-- Sites
|-- Activity
|-- Usage
|-- Access
|   `-- Users  Tokens       "sign everyone out" lives here, not under Settings
|-- Domain
`-- Settings
```

What it showed: sub-tabs were siblings pretending to be children; one thing was reachable two ways; "sign everyone out" lived under Settings and belonged under Access > Users.

What changed: a side menu in two groups, and the rule the owner gave: one place per thing.

## A home page of a lab

Before: one grid of about thirty tiles, every app and every machine tool mixed, in the order a configuration map happened to serialise.

```text
[Cockpit] [DNS] [Files] [Git Mirror] [Home Automation] [Media] [Netdata]
[Cockpit] [Files] [Netdata] [Proxy] [Wiki] ...
  alphabetical, two machines' tools interleaved, no bookmarks,
  the eight kill switches spread over seven consoles
```

```text
<home page>
|-- Apps              lab-wide
|   `-- Home Automation  Media  Wiki  DNS  Git Mirror  Proxy
|-- Machines          one card per machine: CPU, memory, disk, temperature
|   `-- <machine-1>  <machine-2>
|-- <machine> tools   per machine
|   `-- Cockpit  Files  Netdata
`-- Operations        one bookmark column per account
    |-- Kill switches     first column, one line of instruction each
    |   |-- delete the device  delete the tunnel  pause the zone
    |   `-- stop the machine  deny all
    `-- <cloud-1>  <cloud-2>  <dns provider>  <mesh network>  <git host>
```

What it showed: which tile is a lab app and which a machine tool; the kill switches lived in seven consoles and nobody could find them in a hurry; the page ordered groups alphabetically because a map serialises that way, a defect only the tree view exposed.

What changed: a layout list that fixes the order, and the kill switches in one column with a one-line instruction each.

## Rules on this surface

- **One place per thing.** A page reachable two ways has one of them removed.
- **A sub-tab is a child only if it belongs to the tab.** Two things of equal rank are siblings in the menu.
- **The order is chosen, never inherited** from how a map or a list happens to serialise.
- **What a reader needs in a hurry** sits in the first column of its group.
