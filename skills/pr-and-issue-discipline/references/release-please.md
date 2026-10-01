# Release-please Reads the Body

The headline rule is in `SKILL.md` (PR Bodies, "Release-please reads the body"); this page carries the mechanics.

**Release-please reads the body.** In a repository released by release-please, footers travel in the PR body as a commit-override block, whatever the squash setting put in the commit message. Release-please reads the merged PR's body at run time and, when it holds the block, parses that block in place of the commit message; a commit whose message it cannot parse is dropped from the changelog.

- **The marker words appear nowhere else in the body.** Release-please splits the body at the first occurrence of the opening marker, so a prose mention before the block ("the block below", spelled with the marker) becomes the message, fails to parse, and drops the commit from the release. Call it the commit-override block in prose; spell the markers only as the block itself.
- **One `BREAKING CHANGE` note per commit** (the last footer wins): several breaks go into one footer whose value spans several lines, one break per line, or into one `BEGIN_NESTED_COMMIT` / `END_NESTED_COMMIT` block per break.
- **A bad block is repaired after the merge** by editing the merged PR's body; release-please re-reads it on its next run, and the dropped commit returns to the release.

The override changes release-please's parsed message, not the git commit: a repository whose release tool reads the squash commit itself keeps its footers in that commit message, under its own rules. The block is written for a tool, so it is the last element inside the Technical details section; release-please matches the markers inside a `<details>` element. In a release-please repository, a PR whose merge must carry Conventional Commit footers (`BREAKING CHANGE`, `Release-As`) closes its details section with:

```text
BEGIN_COMMIT_OVERRIDE
<conventional subject line>

<footer>: <value, one line per break>
END_COMMIT_OVERRIDE
```

