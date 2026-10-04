# Redaction and PII

In `SKILL.md`, the PR Bodies paragraph starting "Redact captured output" states the rule for a PR author and points here for its definition.

**Redact captured output before publishing, and publish no PII anywhere.** Strip secrets, tokens, and credentials. PII is anything that tells a reader who the author is, how they work, or how their machine is set up.

The rule covers everything a PR or issue publishes: titles, bodies, commit messages, code, test fixtures, docs, captured Before/After blocks, review replies, CI comments, and issue replies. Redaction is not paraphrase: the command and the output structure stay verbatim. This page is the single definition; the skills that gate on it point here.

That test decides, whatever form the information takes. The two kinds met most often, with their substitutes:

- **Identity.** Names, employers, real account logins and usernames, hostnames and machine names, home paths under a real user, emails. One substitute per kind, in the table below.
- **Anything measured or copied from the author's real environment.** Figures, statistics, and profiles computed from real logs or sessions; real settings, configuration, transcripts, and logs; inventories of what the author has installed or uses. All of it identifies the author with no name in it. Substitute: hand-written example values that show only what the text discusses, and the text says they are examples.

The identity substitutes:

| Kind | Substitute |
| --- | --- |
| a login or username | `octocat`, `work-bot`, or `example-user` |
| an employer, a domain, or a hostname | `example.com` |
| a whole email | `example-user@example.com`, never just its host |
| a home path | `/home/user` or `~` |
| the checkout path | `/repo/...` |

A captured row published with `/repo/...` in place of the machine's real checkout path is the worked example.

What follows for anything measured or copied:

- **Fixtures are hand-authored, never derived from real data.** A fixture recorded from real data is PII the moment it is committed, and only a history rewrite removes it. The `/code-standards` skill's `references/tests.md` owns the fixture rule and the output-path rule for tools that measure real data.
- **A CI check posts no figure derived from real data.** It reports pass or fail and points at the artifact.

Specimens: a real account login copied from pasted terminal output into a test fixture and a PR body, shipped as `work-bot`; a statistical profile measured from the author's real sessions and committed as a test fixture, replaced by a hand-written one, every figure of the old file grepped out of the replacing PR, and the history rewritten to drop the original.

A product file name that happens to contain a vendor's word (a PowerShell profile filename, a devcontainer base image), a repository's own `owner/repo` coordinate in its install command, and the repository's own tooling and gates (the review tool a body's Gates line names, a check's run count) are facts about the repository, not the author, and stay.

