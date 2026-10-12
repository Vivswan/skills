---
name: project-naming
description: Use when asked to name or rename a project, repository, tool, package, or paper, or when a name is rejected as hard to say, taken, or misleading.
license: SEE LICENSE IN LICENSE.md
metadata:
  author: Vivswan
---

# Project Naming

> A name is chosen from a table, never from a list. Every candidate reaches the owner with its registry row, its meaning check, and its score against the names the owner already likes. The owner's taste is asked for first and never guessed.

```text
1 interview -> 2 brief -> 3 lanes (parallel) -> 4 machine check -> 5 meaning check
                   ^                                                      |
                   |                                                      v
              7 rejection round  <--  6 one table to the owner  <--  verdicts
                                              |
                                              v  (owner picks)
                                8 re-verify same day -> 9 record and "not checked"
```

## When to Apply

- "name this project" / "is there a better name for this?" / "what should I call the package?"
- A name was rejected: hard to pronounce, already taken, or it points the reader the wrong way
- A paper, tool, or dataset needs a name before it is published

## Workflow

### 1. Interview

Ask before generating anything. The owner's answers are the brief; a lane without them converges on the generator's taste.

```text
Which two or three existing names do you like the SOUND of? (any product, any field)
What killed the last name, in your words?
What must this project be able to grow into?
Where will the name be claimed? (PyPI, npm, crates, Hugging Face, GitHub, which domains, arXiv)
Which languages do your users read?
```

### 2. Brief

Turn the answers into one page every lane reads. The owner approves it before any name is generated.

```text
exemplars:   <the names the owner likes>, scored 1 to 5 by closeness
grows into:  <scope in one line>
claims:      pypi npm hf github dns:com,ai
languages:   <the languages the users read, from the interview>
hard gate:   the table under Conditions, plus anything the owner added
soft scores: exemplar closeness, elegance, room to grow
```

The hard gate is general. The owner's taste lives in the exemplars, so a different owner gets a different search from the same skill.

### 3. Lanes

One lane per style, run in parallel (the `/orchestrator-mode` skill, where installed, owns the fan-out). Each lane brainstorms 50 to 100 names, drops what fails the gate by eye, and checks its best 20 with the script in step 4.

| Lane | Generates |
| --- | --- |
| real word | one existing word, common or rare |
| invented | a coined word with the exemplars' sound |
| Latin or Romance | forms from Latin, Italian, Spanish, Portuguese roots |
| metaphor | an object or place that evokes the work |
| two short words | a compound of two real words |
| borrowed | a word from a named language, with its plain meaning |

Drop a lane the brief rules out. Add a lane when the owner's exemplars share a style the table lacks.

### 4. Machine check

```bash
bun "<skill-dir>/scripts/check-name.mts" --domain com --domain ai <name> <name> ...
```

One row per name, one column per registry. Every cell reads `free`, `taken(<why>)`, or `unknown(<why>)`:

```text
name    pypi  npm                 crates  hf    github-user           github-repo  arxiv  dns-com                     dns-ai  wiktionary                   urban
lumera  free  taken(npm package)  free    free  taken(github handle)  free         free   taken(lumera.com resolves)  free    taken(word in Italian,Latin)  free
tarnix  free  free                free    free  free                  free         free   free                        free    free                         taken(1 entry: ...)
```

- Two controls run with every batch: per column, a name known to be taken there (the registry's own `nic` host for DNS, a word with a flagged sense for Wiktionary), and one random string that must be free everywhere. A column that answers either wrongly is reported on stderr as a failed instrument and the exit code is 1. Do not read that column.
- `unknown` is not `free`. A rate-limited arXiv or a 5xx stays `unknown` in the table; rerun later or drop the column with `--no-arxiv`.
- arXiv allows one request every three seconds, and the script spaces its own that far. Lanes run with `--no-arxiv`; the lead runs the arXiv column once, over the merged shortlist, in step 6.
- GitHub counts an exact-name repository as taken from 20 stars. Pass `GH_TOKEN` or be logged into `gh` for the search rate limit.
- `--json` prints the rows and the control verdicts as one object for a lane report.

### 5. Meaning check

The script's Wiktionary column reads every sense in every language from the page's wikitext and flags a register label (vulgar, offensive, slur, derogatory) on any of them; the Urban Dictionary column reads exact entries only. That covers the exact spelling. Near-homophones and transliterations are judgment, done on the names that survived step 4:

```text
for each survivor:
  say it aloud in every language the brief lists, then in Spanish, Portuguese, French,
    Italian, German, Hindi, Turkish, Arabic, Japanese, Mandarin, Russian, Korean:
    which word is it one sound away from?
  is it a drug, a perfume, a car, a company, an ML method? (one web search: "<name>" AI OR company OR app)
verdict per name: SERIOUS (the word named), MILD (the word named), NONE, each with its source
```

Native speakers do this step at naming agencies. The report says it was done by a model and lists it under "not checked" in step 9.

### 6. One table to the owner

All lanes merge into one ranked table. A name never reaches the owner without its row.

| name | say it | exemplar 1-5 | elegance 1-5 | grow 1-5 | registries | meaning | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `<name>` | `<stress and vowels>` | `<score>` | `<score>` | `<score>` | `<free, or the taken cells named>` | `<NONE, MILD: word, SERIOUS: word>` | CLEAR / MINOR: `<the one collision>` / TAKEN |

- CLEAR: free on every claimed registry, meaning NONE.
- MINOR: one collision the owner can accept knowingly, named in the cell.
- TAKEN: fails the hard gate; shown only when the owner asked to see what was ruled out.

### 7. Rejection round

"None of these" is information, not failure. Ask what put them off and which row came closest. Rewrite the brief with the new exemplar and rerun the lanes that produced the near misses. Two or three rounds is the normal count.

### 8. Re-verify

The chosen name alone, same script, same day, run by the lead and not by the lane that proposed it. Registries change weekly; the row in the decision carries its date.

### 9. Record

```text
chosen:       <name>, claimed at <registries> on <date>
why it won:   <the exemplar it matched, the gate it passed>
not checked:  trademark offices, app stores, social handles, native-speaker review, <anything the brief skipped>
```

## Conditions

A name fails the hard gate on any one row:

| Gate | Fails when |
| --- | --- |
| said as spelled | a reader can say it two ways, or has to be told how |
| short | more than 3 syllables, more than about 8 letters, or more than one token |
| free | taken on any registry the brief claims, or an exact-name repository with 20 or more stars |
| no neighbour | an AI company, product, or ML method already uses it (web search) |
| no bad meaning | a SERIOUS meaning finding in any language |
| no wrong signal | the name means something, and that something is not what the project is |
| not a typosquat | one letter from a popular package on a claimed registry |

Meaning is either plain at a glance or absent. A name that means nothing passes; a name that means the wrong thing fails; a name whose meaning the reader must decode (a pun, a reference, a chain of hops) is rejected by default.

Soft scores, 1 to 5 each, shown in the table and never used to rescue a gate failure:

- **Exemplar closeness**, the main score: how much it sounds like the names the owner gave in step 1.
- **Elegance**: soft consonants, open vowels, reads cleanly in lowercase and in Title Case.
- **Room to grow**: not tied to one feature the project may outgrow.

Rejected by default unless the brief says otherwise: acronyms, the letters x q k z, doubled letters, consonant clusters, the suffixes -lens -scope -lux -ly -ify, version numbers, overused references (jarvis, alfred, hal).

## What the script does not check

Trademark registers, app stores, social handles, and registered-but-unresolved domains. The decision record names them under "not checked" every time, so the owner knows what a later claim may still hit.

## Related

- `/verify-with-controls`: the control rows in step 4 are its rule 2 (a positive control before trusting a zero) and rule 6 (a checker seen failing).
- `/orchestrator-mode`: the step 3 lanes as parallel subagents, where installed.
