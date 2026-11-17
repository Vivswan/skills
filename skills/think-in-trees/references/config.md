# Where Settings Live

A configuration surface has owners and targets. Held as a tree, the pattern repeats at every level, and a new scope is one more branch.

## Settings as code for repositories, organizations, and users

Before: a tool applied one repository's settings from a file in that repository, and a central mode applied others from a folder; organization and user scopes were an open question.

```text
.github/settings.yml          this repository
.github/repos/*.yml           other repositories, central mode
org settings?  user settings?  a user who administers an org?        (no answer)
```

```text
some-user/                        A PERSONAL ACCOUNT
`-- <home>/.github/               the user's settings home
    |-- workflows/settings.yml    one workflow applies everything below
    |-- settings.yml              me, the repository
    |-- user.yml                  me, the user                  (reserved)
    |-- defaults.yml              what every governed repository starts from
    |-- repos/                    other repositories this home governs
    |   |-- dotfiles.yml              -> some-user/dotfiles
    |   `-- example-org/api.yml       -> example-org/api
    `-- orgs/                     organizations this home governs
        `-- example-org.yml           -> the organization example-org

example-org/                      AN ORGANIZATION that governs itself instead
`-- <home>/.github/
    |-- workflows/settings.yml
    |-- settings.yml              me, the repository
    |-- org.yml                   me, the organization
    |-- defaults.yml
    `-- repos/api.yml                 -> example-org/api
```

What it showed: the same shape at both levels, so a new scope is one more branch; a user who administers an organization governs it from the same home.

What changed: the architecture adopted the tree as a hierarchical settings folder with an outer-to-inner merge, and an unreserved name in the tree is refused so a typo is loud.

## Rules on this surface

- **The name of a file says what it governs,** from the file alone.
- **One pattern at every level.** A scope that needs a new pattern is a sign the tree is wrong.
- **An unknown node is refused,** never silently ignored.
