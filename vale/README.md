# Vale styles

Three [Vale](https://vale.sh) styles under `styles/`, one per skill that defines a rule a linter can hold. A consumer pins this repository by sha and points Vale here, so the rule and its lint move together.

| Style | Skill | Rules |
|---|---|---|
| `DocsDiscipline/UnitLength` | `/docs-discipline` | a paragraph or list item over 70 words |
| `Unslop/AIVocabulary`, `Unslop/PlainWords` | `/unslop` (vendored under `xeno/`) | rules 7 and 8 (AI vocabulary, fancy ways to say "is"); rules 23 and 31 (filler phrases, plain words) |
| `NaturalWriting/Vocabulary`, `Significance`, `Formula`, `TrailingParticiple` | `/natural-writing` | the word lists of `references/words-to-avoid.md`: vocabulary and copula avoidance, inflated significance, formula endings with weasel attributions and promotional words, sentence-final participles |

One owner per token: no word or phrase is listed by two styles, so a word-level hit is reported once. A phrase rule can still overlap a word rule (`pivotal role` in `Significance`, `pivotal` in `Unslop`), and then both report, which is right: two different tells. `tests/vale-styles.test.ts` pins the exact-token ownership, and pins every token to the skill text it comes from.

## Wiring a consumer

Check this repository out at a pinned sha, then in `.vale.ini`:

```ini
StylesPath = .skills/vale/styles
MinAlertLevel = error

[*.md]
BasedOnStyles = DocsDiscipline, Unslop, NaturalWriting
```

A page that quotes the tells as examples (a style guide, this repository's own skill pages) is not a page to lint with them.

## Verifying a change

```sh
{ printf 'A robust plan is the focal point, ensuring we delve into it. In order to ship, not just this one.\n\n'; printf 'w%s ' $(seq 71); echo; } > control.md
vale --config <ini pointing at vale/styles> --output line control.md
```

Each of the seven rules fires exactly once on its planted token:

```text
control.md:1:3:NaturalWriting.Vocabulary:'robust' is an AI tell
control.md:1:22:NaturalWriting.Significance:'focal point' claims significance
control.md:1:33:NaturalWriting.TrailingParticiple:', ensuring' is trailing analysis
control.md:1:47:Unslop.AIVocabulary:'delve' is an AI tell (unslop rules 7 and 8)
control.md:1:62:Unslop.PlainWords:Write 'to' for 'In order to' (unslop rules 23 and 31)
control.md:1:80:NaturalWriting.Formula:'not just' is a formula
control.md:3:1:DocsDiscipline.UnitLength:71 words in one paragraph or list item; the cap is 70
```
