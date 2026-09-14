# PR and Issue Discipline

`/pr-and-issue-discipline` fires when an agent opens a pull request, writes or changes its body or title, writes an issue, or replies to an issue reporter or outside contributor. It holds every PR and issue to the same discipline:

- **Show, do not describe**: a fenced block is the text form of a picture. Inside the chosen shape or template, the change is shown with real captured output where behavior is observable, or a diagram, table, or contract shape where nothing runs, so the reader skims it and gets the change
- **Shaped to the change**: what-this-adds, before/after (or what-this-changes for a pure refactor), or what-this-specifies; then `## How` in whatever carrier explains the mechanism fastest (one carrier, programmer to programmer); then `## Proof` naming tests and gates; secrets stripped and machine paths genericized before publishing
- **Two parts, the human part short**: part one is for a human skimming, as short as the change allows, no paragraph over three sentences; part two is one collapsed `Technical details` section at the bottom for anything written for a bot reviewer or another agent, and a PR without such detail has no part two
- **Release-please reads the body**: in a release-please repository, a merge that must carry Conventional Commit footers closes the `Technical details` section with a commit-override block, which release-please reads from the merged PR's body in place of the squash message, so the marker words appear nowhere else in the body; several breaks share one multi-line `BREAKING CHANGE` footer, since release-please keeps one note per commit; the block changes release-please's parsed message, not the git commit, so a repository whose release tool reads the squash commit itself keeps its footers there
- **Issues too**: what breaks (shown), a minimal repro, expected vs actual, environment only when it matters
- **Replies to issue reporters and outside contributors**: plain first. The questions whose answers would help, asked as questions, a plain-language explanation, and the technical reading collapsed only when it adds something
- **Template check, once per session, at plan time**: when the target repository ships a PR or issue template, ask the user once, up front, whether to use it or the skill's shapes, then carry that answer for the whole session; no template means the shapes apply directly, and `CONTRIBUTING` guidance is honored either way
- **Re-read before the human reads**: before the PR is offered ready, the body is checked against the final diff, every claim, the scope, the part-one sorting, and the title, and edited before the flip
- **Hands the PR over once it exists**: opened as a draft, then [`/pr-landing-discipline`](../pr-landing-discipline/) owns the draft flips, the review rounds, who merges, and the gates before landing

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app integrations can be added later without moving the skill.
