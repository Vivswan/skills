# PR and Issue Discipline

`/pr-and-issue-discipline` fires when an agent opens a pull request, writes or changes its body or title, or writes an issue. It holds every PR and issue to the same discipline:

- **Show, do not describe.** A fenced block is the text form of a picture.
  - Real captured output where behavior is observable.
  - A diagram, table, or contract shape where nothing runs.
  - The reader skims it and gets the change.
- **Shaped to the change.** What-this-adds, before/after (or what-this-changes for a pure refactor), or what-this-specifies.
  - Then `## How`: short bullets, or one small diagram or table where that explains the mechanism faster.
  - Then `## Proof`: the tests and gates, latest totals only.
  - Secrets stripped and machine paths genericized before publishing.
- **Two parts, the human part under a size budget.**
  - Part one is for a human skimming: at most 150 words of prose outside the blocks.
  - `## How` is 3 to 6 bullets by default, `## Proof` 2 to 4. More when the change needs it.
  - Part two is one collapsed `Technical details` section at the bottom, for anything written for a bot reviewer or another agent. No length cap, one fact per line.
  - A PR without such detail has no part two.
- **Readable as an accessibility requirement.** Readers include people with dyslexia.
  - A mix of devices the reader can skim: short paragraphs, bullets for lists, tables, fenced blocks.
  - Short sentences, no semicolon chains, no nesting past one level, anywhere in the body.
- **Review rounds replace, never append.**
  - A fix edits the existing How or Proof bullet. A count is overwritten with the latest total.
  - No line says which round produced it.
  - The part-one word count is re-run after every round and before the flip.
  - An agent that believes the cap must break asks the user rather than deciding alone.
- **Release-please reads the body.** In a release-please repository, a merge that must carry Conventional Commit footers closes `Technical details` with a commit-override block.
  - Release-please reads it from the merged PR's body in place of the squash message, so the marker words appear nowhere else in the body.
  - Several breaks share one multi-line `BREAKING CHANGE` footer, since release-please keeps one note per commit.
  - The block changes release-please's parsed message, not the git commit. A repository whose release tool reads the squash commit keeps its footers there.
- **Issues too.** What breaks (shown), a minimal repro, expected vs actual, environment only when it matters.
- **Someone else's thread is another skill's**: replies to issue reporters and reviews of someone else's PR follow [`/reply-and-review-discipline`](../reply-and-review-discipline/), which points back here for the Readability rules and the redaction rule
- **Template check, once per session, at plan time.** When the target repository ships a PR or issue template, ask the user once whether to use it or the skill's shapes, then carry that answer for the whole session.
  - No template means the shapes apply directly.
  - `CONTRIBUTING` guidance is honored either way.
- **Re-read before the human reads.** Before the PR is offered ready, the body is checked against the final diff: every claim, the scope, the part-one sorting, the title, and the size. It is edited before the flip.
- **Hands the PR over once it exists.** Opened as a draft, then [`/pr-landing-discipline`](../pr-landing-discipline/) owns the draft flips, the review rounds, who merges, and the gates before landing.

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app integrations can be added later without moving the skill.
