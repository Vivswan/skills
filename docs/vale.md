# Vale styles

Three skills ship their rules as [Vale](https://vale.sh) styles, each inside its own folder under `vale/`. A consumer pins this repository by sha and points Vale at the checkout root, so a skill and its lint move together, vendored skills included.

| Rule | Skill | What it reports |
|---|---|---|
| `skills.docs-discipline.vale.UnitLength` | `/docs-discipline` | a paragraph or list item over 70 words |
| `xeno.unslop.vale.AIVocabulary`, `xeno.unslop.vale.PlainWords` | `/unslop` (vendored; the folder is declared `own` in `xeno/sources.yaml`) | rules 7 and 8 (AI vocabulary, fancy ways to say "is"); rules 23 and 31 (filler phrases, plain words) |
| `skills.natural-writing.vale.Vocabulary`, `Significance`, `Formula`, `TrailingParticiple` | `/natural-writing` | the lists of `references/words-to-avoid.md`: vocabulary and copula avoidance, inflated significance, formula endings with weasel attributions and promotional words, sentence-final participles |

One owner per token: no word or phrase is listed by two rules, so a word-level hit is reported once. A phrase rule can still overlap a word rule (`pivotal role` in `Significance`, `pivotal` in `Unslop`), and then both report, which is right: two different tells.

`tests/vale-styles.test.ts` pins three things: the exact-token ownership, every token's presence in the skill text it comes from, and that no other `.yml` sits under `skills/` or `xeno/`, since Vale would read it as a rule.

## Wiring a consumer

Check this repository out at a pinned sha, then in `.vale.ini`:

```ini
StylesPath = .skills
MinAlertLevel = error

[*.md]
BasedOnStyles = skills, xeno
```

Vale reads the `*.yml` files under the two named folders and ignores everything else there. A page that quotes the tells as examples (a style guide, this repository's own skill pages) is not a page to lint with them.

## Verifying a change

```sh
{ printf 'A robust plan is the focal point, ensuring we delve into it. In order to ship, not just this one.\n\n'; printf 'w%s ' $(seq 71); echo; } > control.md
vale --config <ini pointing at the checkout root> --output line control.md
```

Each of the seven rules fires exactly once on its planted token:

```text
control.md:1:3:skills.natural-writing.vale.Vocabulary:'robust' is an AI tell
control.md:1:22:skills.natural-writing.vale.Significance:'focal point' claims significance
control.md:1:33:skills.natural-writing.vale.TrailingParticiple:', ensuring' is trailing analysis
control.md:1:47:xeno.unslop.vale.AIVocabulary:'delve' is an AI tell (unslop rules 7 and 8)
control.md:1:62:xeno.unslop.vale.PlainWords:Write 'to' for 'In order to' (unslop rules 23 and 31)
control.md:1:80:skills.natural-writing.vale.Formula:'not just' is a formula
control.md:3:1:skills.docs-discipline.vale.UnitLength:71 words in one paragraph or list item; the cap is 70
```
