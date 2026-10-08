# Reply and Review Discipline

`/reply-and-review-discipline` fires when an agent replies to an issue reporter or outside contributor, or reviews someone else's pull request under the user's account. Everything written there publishes under the user's name to a reader who does not know the code:

- **The report decides the opening**: when the reporter's log shows the cause, the reply leads with their own log lines under "What the report shows" and a numbered "What to do" list, closed by one fallback line; a "Questions" heading exists only when the diagnosis depends on the answers, three at most, the most useful named
- **Plain first, technical collapsed**: part one says what the reader did and sees, never that it is the plain version; the technical reading sits in one collapsed `Technical details` block, present only when it adds something; a guess goes last and is labeled one
- **The reporter's language first, then English**: a reporter who writes in another language, or whose pasted text reveals one, gets the full reply in that language and then the full reply in English, each half complete, with its own collapsed block when the reply has one
- **Lenses chosen once per PR, before reading**: the repository's owner sets the recommendation, the full house standards on the user's own repository or their organization's, the repository's conventions first on one they do not own; the candidates (review-criteria skills, `/rubber-duck-review`, `/working-text`) and the memories about the repository go to the user in one dialog, recommended set first, a reason per lens
- **Reviewing someone else's PR**: every comment staged in one pending review under the user's account; publishing is the user's act, done by them or on their explicit instruction
  - The verdict is an inline summary comment for the user to paste into the summary box: a bracketed recommendation, then Works and Blocks
  - Each comment is one or two plain sentences opening with a bracketed hint for the publisher, anchored on the finding's whole range
  - Only what changes behavior, reliability, or the truth of a stated fact; nothing Windows-only; a re-review comments only on what is still open
- **Shared rules**: the Readability rules and the redaction rule of [`/pr-and-issue-discipline`](../pr-and-issue-discipline/) apply to every reply and every staged comment unchanged

Full specimens of both reply shapes and the two-language layout: [`references/issue-replies.md`](./references/issue-replies.md).

## Plugin-Ready Layout

This skill directory already includes plugin metadata in [`.codex-plugin/plugin.json`](./.codex-plugin/plugin.json) so MCP servers, hooks, or app integrations can be added later without moving the skill.
