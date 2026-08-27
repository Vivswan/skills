# Memories

One-line rule memories consumable by agent memory tooling. Each memory file carries exactly one standing rule: the frontmatter `description` is the always-loaded one-liner, and the body is what an agent reads when the rule fires. This README describes the contract; it is not itself a memory.

## File contract

| Field | Convention |
| --- | --- |
| `name` | Matches the filename stem, kebab-case |
| `description` | Single line, trigger-shaped ("Use when/before ..."), never a content summary |
| `metadata.type` | `feedback` |
| Body | The rule first, then a `**Why:**` line (the failure mode it prevents) and a `**How to apply:**` line |
| `[[wikilinks]]` | Only to other memories in this directory; a dangling link is an error |

## Memories are not skills

Skills (`skills/`) are workflows: multi-step procedures loaded on demand when a matching task starts. Memories are standing rules: their one-liners stay loaded all the time, and their bodies apply at specific moments (a commit, a merge, a spawn). A rule that must hold at every gate belongs here; a procedure an agent follows end to end belongs in a skill.
