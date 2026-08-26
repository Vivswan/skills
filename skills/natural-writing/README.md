# Natural writing

Write and edit prose that avoids the documented signs of AI writing, based on [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing).

This skill is explicit-invocation-only: agents load it when you invoke it (e.g. `/natural-writing` in Claude Code), not on their own.

## What it does

- Drafts new text (docs, articles, READMEs, emails, PR descriptions) that avoids the cataloged AI tells
- Rewrites existing text to strip the tells while preserving facts and voice
- Audits text and reports which signs appear, with the false-positive caveats the source page insists on

## How it works

- `references/signs-catalog.md` holds a distilled snapshot of the full Wikipedia field guide, pinned to a specific page revision and sync date.
- `references/words-to-avoid.md` holds the term lists.
- The Wikipedia page changes as models and community observations change, so the workflow prefers the live page when online and falls back to the snapshot offline.
- `SKILL.md` records the pinned revision and documents how to update the snapshot when the page moves on.

House rule on top of the Wikipedia catalog: no dash-as-punctuation at all (no em dashes, and no en-dash or spaced-hyphen substitutes).

## Install

```bash
npx skills add Vivswan/skills -g --skill natural-writing
```

## Usage

- "Humanize this blog post"
- "Remove the AI tells from this README"
- "Does this paragraph read as AI-generated?"
- "Write the announcement, and keep it natural"
- "Update the natural-writing skill from the current Wikipedia page"
