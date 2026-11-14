---
name: project-naming
description: Use when asked to name or rename a project, repository, tool, package, or paper, when about to offer the owner any name at all, even one, or when a name is rejected as hard to say, taken, or misleading.
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
                      8 sleep on it -> re-verify same day -> 9 record and "not checked"
```

## When to Apply

- "name this project" / "is there a better name for this?" / "what should I call the package?"
- "do you have any names for it?" in a session deep in something else: a name offered to the owner, even one, goes through this skill first
- A name was rejected: hard to pronounce, already taken, or it points the reader the wrong way
- A paper, tool, or dataset needs a name before it is published

## Workflow

### 1. Interview

Ask before generating anything. The owner's answers are the brief; a lane without them converges on the generator's taste.

```text
Which two or three existing names do you like the SOUND of? (any product, any field)
Name three software companies whose names you find elegant.
What killed the last name, in your words?
What must this project be able to grow into?
How does it ship? (an npm package, a binary, a Homebrew formula, a Docker image, a hosted site, a paper)
Where will the name be claimed? (PyPI, npm, crates, Homebrew, Docker Hub, Maven, Hugging Face, GitHub, Bluesky, which domains, arXiv)
From how many stars does a GitHub repository of that name count as taken? (default 1000: only a famous one)
Which neighbour kills a name: any product using it, one that shipped and is findable, or only one in your category or well known?
Which languages do your users read?
Should the name read in one glance for neurodivergent readers (dyslexia, ADHD, autism, and readers who struggle with long or irregular words)? (default yes)
Should the name say what the project does, hint at it, or stand on its own like Obsidian?
```

A name need not describe the project. The last question decides, and the exemplars usually show the answer: Obsidian and Orca are words unconnected to what they name. When the answer and the exemplars disagree, the brief says so and the answer stands.

The claims follow from how the project ships, so that question comes first. An owner who has not settled delivery (a CLI on npm, or only `npx`?) settles it before the claims are listed.

When npm or PyPI is a claim and the exemplars are familiar English, the trade-off is said before any lane runs: short common words are mostly gone there as bare names.

The owner picks one of three: a scoped package on npm (`@handle/name`, free under a handle you own; the script checks bare names only, so npm leaves the claims and the scope is recorded), a dead placeholder accepted knowingly, or a hunt in the longest region the brief allows (7 to 8 letters; 7 letters and two syllables at `one glance: yes`), where free familiar words still exist.

### 2. Brief

Turn the answers into one page every lane reads. The owner approves it before any name is generated.

```text
exemplars:   <the names the owner likes>, scored 1 to 5 by closeness
vector:      <per exemplar: letters, syllables, stress, open or closed vowels, Latinate or Germanic, hard letters>
familiarity: familiar English | rare | foreign | coined, read off the exemplars
register:    <the companies the owner named>, the list the company-list test scores against
connection:  none | hint | descriptive, from the interview (the exemplars usually show it)
grows into:  <scope in one line>
claims:      pypi npm docker hf github-repo>=1000 dns:com,ai
neighbour:   any | shipped | same category, the bar a web-search collision must clear to be TAKEN
one glance:  yes | no, default yes
languages:   <the languages the users read, from the interview>
hard gate:   the table under Conditions, plus anything the owner added
soft scores: exemplar closeness, company-list test, elegance, room to grow
```

The hard gate is general. The owner's taste lives in the exemplars, so a different owner gets a different search from the same skill.

The vector decomposes each exemplar once, so every lane scores closeness against the same six facts instead of its own impression. An example, for an owner who likes `vercel` and `linear`:

```text
vercel:  6 letters, 2 syllables, stress on the first, closed vowels, Latinate, no hard letters
linear:  6 letters, 3 syllables, stress on the first, open vowels, Latinate, no hard letters
```

The vector carries sound, not familiarity. Obsidian, orca, and linear are words every English reader knows, and a rare, foreign, or coined form can match their vector exactly, so `familiarity` is its own line and it steers which lanes run (step 3).

The register is a third thing. Sound exemplars did not surface it in one run, where the standard turned out to be "would pass unnoticed in a list of well-funded 2024 software companies" (Vercel, Linear, Figma, Notion, Loom, Stripe, Turso, Vanta, Resend).

Vercel is coined yet reads natural and easy to say. The `register` line names that list, and the company-list test scores every candidate against it.

### 3. Lanes

One lane per style, run in parallel (the `/orchestrator-mode` skill, where installed, owns the fan-out). Each lane brainstorms 50 to 100 names, drops what fails the gate by eye, and checks its best 20 with the script in step 4.

The batches of ten run one after another, never in parallel: the registries rate-limit per client. One lane of 191 words ran its batches at once and lost the Wiktionary reading for the first 140.

| Lane                | Generates                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------- |
| familiar nouns      | an everyday English noun, concrete or abstract                                              |
| familiar adjectives | an everyday English adjective                                                               |
| real word           | one existing word, common or rare                                                           |
| invented            | a coined word made the way brand names are: clipped, one letter changed, fused, a worn root |
| Latin or Romance    | forms from Latin, Italian, Spanish, Portuguese roots                                        |
| metaphor            | an object or place that evokes the work                                                     |
| two short words     | a compound of two real words                                                                |
| borrowed            | a word from a named language, with its plain meaning                                        |
| any style           | judged by the company-list test alone, on a different model from the other lanes            |

Every lane reads the brief's `connection`. At `none` a candidate that names, describes, or belongs to the trade of the work is dropped, in any language and however rare (`quire`, `folio`, `pagedrop` for a page tool); a word kept for its sound alone stays. At `hint` a candidate may evoke the work, and at `descriptive` it may say it.

The brief's `familiarity` orders the lanes. At `familiar English` the familiar nouns and familiar adjectives lanes run first, and the invented, Latin or Romance, and borrowed lanes are dropped or run last; at `rare`, `foreign`, or `coined` the matching lanes lead.

For an npm claim, plain English words are dense. At `familiar English` the familiar lanes run anyway and target the longest region the brief allows first, 7 to 8 letters, or 7 letters and two syllables at `one glance: yes`: the short words are mostly gone. Otherwise the real word lane favours rare words, and the invented and Latin or Romance lanes carry the shortlist.

Specimen: of 40 gate-passing familiar adjectives, 37 were taken on npm as bare names. The three free ones, `pastoral`, `balmy`, `umber`, each had an AI neighbour. A scoped package was offered; the hunt for a bare name went on.

Drop a lane the brief rules out. Add a lane when the owner's exemplars share a style the table lacks.

Where the harness has a pipeline or workflow tool, steps 3 to 6 are one run, not prose between agents.

Each lane returns rows in a fixed shape (name, say it, the four scores, soft flags, registries, neighbour with the bar it fails, meaning verdict, verdict) plus what it dropped. A lane with no survivor reruns once with a tightened prompt.

At `one glance: yes`, the default, every lane also holds to: five to seven letters, two syllables, stress on the first, no silent letter, no doubled letter, no trailing silent e, no letter with two readings. These rules make a name easier for everyone, which is why the default is yes. `auburn` passed them; `roan` (one syllable, two readings) and `ecru` (two readings) were rejected at the table on sight.

A lane's verdict is the hard gates alone: registries, neighbour, bad meaning. Soft flags ("au is said aw", "contains burn", "edges toward the place-name class") are columns, never a rank or a recommendation. Ranking belongs to the blind judge and the owner.

The merge dedupes against the brief's rejected list and runs the arXiv and `github-repo` columns once.

A lane does not stop at the registry gate. It reports its near-misses with their raw counts, and runs the neighbour and meaning search (step 5) on every word within reach of a plausible gate change, not only on its survivors. The gate decides at the table, not inside the lane.

One run raised the GitHub bar after the lanes had reported, and about 95 words came back needing a fresh neighbour pass at the same cost again.

The rejection round (step 7) sits between runs: rewrite the brief, rerun only the lanes it changed. A lane report that travels as a message gets cut; rows in a schema do not.

### 4. Machine check

```bash
export GH_TOKEN="$(gh auth token)"   # first: without it GitHub allows 10 searches a minute, shared by every lane
bun "<skill-dir>/scripts/check-name.mts" --no-arxiv --registries pypi,npm,docker,hf,github-user,dns-com,dns-ai <name> ...   # a lane: the brief's claims except github-repo
bun "<skill-dir>/scripts/check-name.mts" --registries github-repo,arxiv --github-stars 1000 <name> ...                      # the lead, once, over the merged shortlist: arXiv and github-repo at the brief's bar
```

```text usage=skills/project-naming/scripts/check-name.mts
usage: check-name.mts [--domain <tld>]... [--registries <id,id,...>] [--github-stars <n>] [--no-arxiv] [--json] <name>...
       check-name.mts --list-registries
  --domain <tld>          a DNS column per zone (default: com, ai, dev; the list replaces the default)
  --registries <id,...>   the availability columns to run; the gate columns run on every name regardless
  --github-stars <n>      stars from which an exact-name GitHub repository is taken (default 1000); one with 20 or more stars under it reads free(repo with <n> stars)
  --no-arxiv              skip the arXiv column (one request every three seconds)
  --json                  one JSON object, rows and failures, instead of the table
  --list-registries       the live column table: id, label, taken control, gate
exits: 0 every row printed and every control answered as expected;
       1 a control answered wrongly: the named columns are not evidence; 2 usage error
```

One row per name, one column per registry; the registries live in one table in `scripts/columns/registries/table.mts`, and `--list-registries` prints it. Every cell reads `free`, `taken(<why>)`, or `unknown(<why>)`, except the `say` column's `note(<reading>)`:

```text
name    pypi  npm                 crates  homebrew                        docker                  maven  hf    github-user           github-repo  bluesky                arxiv  dns-com                     dns-ai  wiktionary                    urban                typosquat                                                         say
lumera  free  taken(npm package)  free    free                            taken(docker hub user)  free   free  taken(github handle)  free         taken(bluesky handle)  free   taken(lumera.com resolves)  free    taken(word in Italian,Latin)  free                 free                                                              note(ok(3s))
tarnix  free  free                free    taken(homebrew formula tarnix)  free                    free   free  free                  free         free                   free   free                        free    free                          taken(1 entry: ...)  free                                                              note(flag(2s; hard x))
numpi   free  free                free    free                            free                    free   free  free                  free         free                   free   free                        free    free                          free                 taken(1 edit from numpy on claimed pypi (top 5000 by downloads))  note(ok(2s))
```

- `--registries` selects the availability columns; the gate columns `say`, `typosquat`, `wiktionary`, and `urban` run on every name whatever it names, so a selective run cannot skip them: the hard gate reads the first two, and step 5 reads the two meaning columns, on every name.
- Two controls run with every batch: per registry column, a name known to be taken there (the zone's own delegation for DNS, spelled `@`; a word with a flagged sense for Wiktionary), and one random string that must be free everywhere. A column that answers either wrongly is reported on stderr as a failed instrument and the exit code is 1. Do not read that column.
- A 429 is waited out and asked again three times, the wait doubling from two seconds and never under the registry's own gap. A column still rate-limited after that reads `unknown` with its own rate-limit message, and the row is rerun later.
- `unknown` is not `free`. A rate-limited arXiv or a 5xx stays `unknown` in the table; rerun later or drop the column with `--no-arxiv`.
- arXiv allows one request every three seconds, and the script spaces its own that far. Lanes run with `--no-arxiv`; the lead runs the arXiv column once, over the merged shortlist, in step 6.
- Maven Central's search holds some requests for half a minute and more, so the script runs its lookups one at a time and asks again after a short wait; an `unknown(maven TimeoutError ...)` cell is three holds in a row, rerun later.
- Docker Hub ids are 4 to 30 lowercase letters and digits; a name outside that reads `unknown` there because Docker would refuse it, not because it is free.
- GitHub counts an exact-name repository as taken from the brief's `--github-stars` bar (default 1000: only a famous repository). Under it, one with 20 or more stars reads `free(repo with 240 stars)`, a MINOR note in the table: a search nuisance at `<owner>/<name>`, not a conflict. Under 20 it is not even a note.
- GitHub allows 30 searches a minute per token, 10 with none, shared by every lane (pass `GH_TOKEN` or be logged into `gh`), so the script spaces its searches two seconds apart with a token and six without: a 20-name batch takes about a minute on the `github-repo` column, three with no token. A rate-limited reply is `unknown(github search rate-limited; retry later)`.
- Lanes leave `github-repo` out of `--registries`; the lead runs that column once, over the merged shortlist, in step 6, as with arXiv.
- Homebrew's per-name pages answer an entry's own name only (`python` is an alias of `python@3.15` and has no page), so the script reads the formula and cask indexes whole, kept a day in the same cache as the typosquat lists. The cell names the formula or cask, and `via alias`, `via old name`, or `via old token` when the name is one of those.
- The `typosquat` column is one edit (a letter added, dropped, changed, or two swapped) from a popular package. The cell names the package, the registry as `claimed` or `unclaimed` (`--registries` names the claimed ones; without it every registry is claimed), and the list it came from. The lists are kept a day under the OS temp dir in `check-name-cache`.
- A list that could not be read is named in the same cell beside any hit (`taken(1 edit from lumeras on unclaimed pypi (...); claimed crates lookup failed (crates ranking page 1 HTTP 503))`), and is the cell when nothing hit. A hit list with a failed source is not complete: rerun before reading it as the only collision.
- Those lists: PyPI's top 5000 by downloads (the public top-pypi-packages JSON); npm's top 5000 by downloads from the npm-high-impact dataset (npm publishes no ranking and its search is not fuzzy); crates.io's top 2000 by downloads, read from its crate list 100 a page (it publishes no ranking file, and its search returns what matches the name, not the popular crate one edit away).
- A list shorter than its source publishes is a cut list, not a shorter ranking: a crates page under its 100 entries, or a PyPI or npm list under the 5000 the column reads, fails that source the same way (`claimed crates lookup failed (crates ranking page 7 reply malformed: page has 40 entries, expected 100)`), since the names past the cut were never compared.
- crates.io asks automated clients for one request a second. Within a process the script spaces its crate lookups and the ranking's twenty pages that far: a 20-name batch is about twenty seconds on the `crates` column, per process.
- Across processes the ranking is fetched once a day: the first process to reach a page holds a lock file beside the cache entry while it fetches, and the others wait on it and read what it wrote, so six lanes on a cold cache are one fetch of the ranking, about twenty seconds.
- The `say` column reads the spelling alone, so it is a `note`, never free or taken, and runs no control: `ok(<syllables>s)` or `flag(<syllables>s; <reasons>)`. The "said as spelled" row under Conditions names each reason.
- `--json` prints the rows and the control verdicts as one object for a lane report.

### 5. Meaning check

The script's Wiktionary column reads every sense in every language from the page's wikitext and flags a register label (vulgar, offensive, slur, derogatory) on any of them; the Urban Dictionary column reads exact entries only. That covers the exact spelling. Near-homophones and transliterations are judgment, done on every name a plausible gate change could bring back, survivors first:

```text
for each name:
  say it aloud in every language the brief lists, then in Spanish, Portuguese, French,
    Italian, German, Hindi, Turkish, Arabic, Japanese, Mandarin, Russian, Korean:
    which word is it one sound away from?
  is it a drug, a perfume, a car, a company, an ML method? (one web search: "<name>" AI OR company OR app)
verdict per name: SERIOUS (the word named), MILD (the word named), NONE, each with its source
neighbour per name: the collision named, and the bar it fails: any | shipped | same category
```

The brief's `neighbour` bar decides which collision is TAKEN:

| bar             | TAKEN                                                                  | MINOR                                               |
| --------------- | ---------------------------------------------------------------------- | --------------------------------------------------- |
| `any`           | every AI company, product, or model using the name                     | nothing                                             |
| `shipped`       | a live product with users or funding                                   | a contact-form placeholder, a one-person repository |
| `same category` | a competitor, an agent or developer tool, a name most people recognise | an unrelated startup                                |

A word owned in search by a university or a town is a nuisance row, not a flag against the name.

The `same category` bar is offered because that is how a name is judged in practice: a funded consumer app in an unrelated field, a small fintech, or a maths library sharing the word stops no one, while a word with lighter neighbours still loses on sound.

In 2026 every pleasant noun has a seed-stage AI company. One run put 95 free-on-registries English words through the pass: about 85 fell at `any` (`sorrel`, `heron`, `spool`, `frost`, `aster`, `laurel`), about 60 at `shipped`, about 25 at `same category`.

Native speakers do this step at naming agencies. The report says it was done by a model and lists it under "not checked" in step 9.

A neighbour that competes with the project itself, not only with the name (a product in the same category the owner's survey missed), is reported to the owner as a survey finding, separate from the name's verdict. One run found a hosted service doing the project's own job this way.

### 6. One table to the owner

All lanes merge into one ranked table. A name never reaches the owner without its row.

| name     | say it                | exemplar 1-5 | elegance 1-5 | grow 1-5  | register 1-5 | registries                         | meaning                             | judge                          | why that name                        | verdict                                      |
| -------- | --------------------- | ------------ | ------------ | --------- | ------------ | ---------------------------------- | ----------------------------------- | ------------------------------ | ------------------------------------ | -------------------------------------------- |
| `<name>` | `<stress and vowels>` | `<score>`    | `<score>`    | `<score>` | `<score>`    | `<free, or the taken cells named>` | `<NONE, MILD: word, SERIOUS: word>` | `<one line: why it sits here>` | `<the sentence the owner would say>` | CLEAR / MINOR: `<the one collision>` / TAKEN |
- CLEAR: free on every claimed registry with no cell naming a collision, meaning NONE.
- MINOR: one collision the owner can accept knowingly, named in the cell.
- TAKEN: fails the hard gate; shown only when the owner asked to see what was ruled out.

A blind judge sets the order. A fresh agent that saw no lane output gets the exemplars, their vector, the `register` list, and the merged shortlist alone, ranks the names, scores the company-list test, and writes two lines per row: why it sits where it sits, and the one sentence the owner could say when asked "why that name".

Its order is the table's order. The lanes' own scores stay as columns.

Two more checks run on each finalist before the table goes out, and their results join the `say it` and `meaning` cells:

- **Say it to a stranger.** Spell the name, letter by letter, to a fresh agent with no context, and ask it to pronounce the name and spell it back. A pronunciation that differs from the row's `say it` cell, or a spelling that differs from the name, is MILD, with the stranger's reading quoted.
- **Look at it.** Write the name four ways: lowercase, Title Case, as a terminal command (`<name> --help`), and as a short icon label. A form that misreads (a lowercase `l` for an `I`, a word that splits wrong in Title Case) is named in the row.

### 7. Rejection round

"None of these" is information, not failure. Ask what put them off and which row came closest.

Rewrite the brief with the new exemplar and rerun the lanes that produced the near misses. Two or three rounds is the normal count.

Once a liked word is named, the next round's brief is built from that word's shape (letters, syllables, register), not from the original brief.

After a second rejected table the claims are re-opened before another lane runs, with the lanes' numbers in front of the owner: "<n> of <m> gate-passing names were taken on <registry>". A claim can be the thing that is wrong, not the name. The owner drops or scopes the registry, or keeps it knowing the price.

Specimen: a lead offered `broadside`, `showbill`, `pubpage`, and `pagedrop` for a page-publishing tool, chosen by meaning and without the interview. They were rejected as compound words and not elegant against Obsidian, Orca, Vercel, and Linear, words unconnected to what they name. The response: the brief gains `connection: none` and the lanes rerun against it.

Specimen: a first table rejected whole as "too foreign" (the Latin or Romance and borrowed survivors), "coined, empty" (the invented lane's), "odd real meanings" (`neroli`, `mustela`, `perca`, `tadorna`). The exemplars obsidian, orca, and linear are familiar words, and the vector had carried their sound alone. The brief gained `familiarity: familiar English`, and three lanes reran: familiar nouns, familiar adjectives, and invented held to near-words in the vercel shape.

The same run's round two, the vercel-shaped near-words (`fervel`, `mervil`, `vensel`), was rejected as "still coined, too soft, no weight". The standard was a register, not a sound. The brief gained `register:` with nine company names, and round three ran brand near-words, real words with a twist (the Notion, Loom, Stripe class, 7 to 8 letters for npm), and an any-style lane under the company-list test alone, on three models.

Round three (`halden`, `radnor`, `denholm`, `tanvel`, `orbel`) was rejected as "too made up or too complicated". The lead re-opened the claims with the numbers: 2 of 30 nouns, 3 of 40 adjectives, 19 of 110 real words that passed every gate were free on npm.

npm was dropped as a claim in that run: the CLI ships as a binary and on Homebrew. Round four ran simple real words against GitHub and Homebrew alone. The claims should have been re-opened one round earlier, after the second rejected table; that is the round the rule above saves.

Round four met the GitHub gate: 103 of 110 gate-passing simple words (`ember`, `anvil`, `pivot`, `harbor`, `velvet`, `otter`, `summit`) had some repository of that name with 20 or more stars. The bar moved to where only a famous repository counts, about 1,000 stars, and the rest became MINOR notes.

Round four's outcome: 97 words through the neighbour pass, 1 CLEAR (`auburn`), about 10 MINOR, the rest TAKEN. `auburn` passed every gate, the reading rules included. Its lane had put it in a MINOR row on its own soft flags and recommended two words above it that the neighbour pass then killed, which is why a lane ranks on nothing.

### 8. Sleep on it, then re-verify

The owner picked. Before any check or claim, one more message asks them to say it aloud, spell it, and picture the README title and the install line with it. A no reopens the rejection round at no cost; a yes goes on to re-verify.

The chosen name alone, same script, same day, run by the lead and not by the lane that proposed it. Registries change weekly; the row in the decision carries its date.

### 9. Record

```text
chosen:       <name>, claimed at <registries> on <date>
why it won:   <the exemplar it matched, the gate it passed>
not checked:  trademark offices, app stores, social handles, native-speaker review, <anything the brief skipped>
```

## Conditions

A name fails the hard gate on any one row:

| Gate            | Fails when                                                                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| said as spelled | the `say` column flags it: `hard x,q,z,k`; `doubled ll`; `cluster str` (three consonants together); `two readings` for ch, gh, ough, ea, a trailing e, or c and g before e, i, y; `spoken digits 1,2,3` (a digit is said, and counted one syllable) |
| one glance      | the brief says yes (the default) and the name breaks one of the seven reading rules under step 3                                                                                                                                                    |
| short           | more than 3 syllables, more than about 8 letters, or more than one token                                                                                                                                                                            |
| free            | taken on any registry the brief claims, or an exact-name repository at or above the brief's star bar (`--github-stars`, default 1000)                                                                                                               |
| no neighbour    | a web-search collision at or above the brief's `neighbour` bar (any, shipped, or same category); one under it is MINOR                                                                                                                              |
| no bad meaning  | a SERIOUS meaning finding in any language                                                                                                                                                                                                           |
| no wrong signal | the name points the reader at a feature, field, or kind of tool the project is not; at `connection: none` an unrelated word (Orca, Obsidian) is no signal and passes, a trade word of the project's own field fails                                 |
| not a typosquat | the `typosquat` column names a package on a registry the brief claims; a hit on an unclaimed registry is a MINOR note                                                                                                                               |

Meaning is either plain at a glance or absent. A name that means nothing passes, and so does an unrelated word at `connection: none`; a name that misleads about the project fails; a name whose meaning the reader must decode (a pun, a reference, a chain of hops) is rejected by default.

Soft scores, 1 to 5 each, shown in the table and never used to rescue a gate failure:

- **Exemplar closeness**, the main score: how much it sounds like the names the owner gave in step 1.
- **Elegance**: soft consonants, open vowels, reads cleanly in lowercase and in Title Case.
- **Company-list test**: would it sit unnoticed in the brief's `register` list? Scored by each lane and again by the blind judge.
- **Room to grow**: not tied to one feature the project may outgrow.

Rejected by default unless the brief says otherwise: acronyms, the letters x q k z, doubled letters, consonant clusters, the suffixes -lens -scope -lux -ly -ify, version numbers, overused references (jarvis, alfred, hal).

## What the script does not check

Trademark registers, app stores, social handles other than Bluesky, and registered-but-unresolved domains. The decision record names them under "not checked" every time, so the owner knows what a later claim may still hit.

Go modules: a module path is a URL (`github.com/<owner>/<name>`), so a bare name is not claimable there, and pkg.go.dev serves its search as HTML only. The GitHub columns cover the repository the path would point at.

## Related

- `/verify-with-controls`: the control rows in step 4 are its rule 2 (a positive control before trusting a zero) and rule 6 (a checker seen failing).
- `/orchestrator-mode`: the step 3 lanes as parallel subagents, where installed.
