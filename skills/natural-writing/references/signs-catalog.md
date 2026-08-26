# Signs of AI writing: full catalog

Distilled from [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) (WP:AISIGNS). Snapshot synced 2026-08-26 from page revision 1371415133 (2026-08-26T08:17:42Z). The live page is the source of truth; refresh per SKILL.md when it changes.

The page catalogs patterns observed in LLM output. Each entry below states the pattern, why it happens, and what to do instead. Two framing notes from the source apply throughout:

- These are signs, not sins. Any one pattern also occurs in human writing. The tell is density and co-occurrence: where there is one, there are usually others. Aim for prose where these patterns don't cluster. Nervously dodging a keyword list is not the goal.
- The pattern is the symptom. The root causes are regression to the mean (generic statements that fit any topic replace specific facts) and trained helpfulness (puffery, summaries, reassurance). Fix the cause: be specific and neutral, and stop when the information is delivered.

Quoted phrases and characters inside this catalog are examples of the tells, not license to use them.

## 1. Content patterns

### 1.1 Inflated significance, legacy, and broader trends

Watch for: *stands/serves as*, *is a testament/reminder*, *a vital/ significant/crucial/pivotal/key role/moment*, *underscores/highlights its importance/significance*, *reflects broader*, *symbolizing its ongoing/ enduring/lasting*, *contributing to the*, *setting the stage for*, *marking/shaping the*, *represents/marks a shift*, *key turning point*, *evolving landscape*, *focal point*, *indelible mark*, *deeply rooted*.

LLMs puff up arbitrary aspects of a subject as representing or contributing to some broader topic ("marking a pivotal moment in the evolution of regional statistics"). They situate subjects amid vague "debates" the subject has "prompted" or "shaped", or note that a subject "participated in public discussions". They attach importance-claims to even mundane material such as etymology or population data. For biology topics they belabor ecosystem connections and conservation status even when unknown.

Instead: State what happened. If something matters, show the specific, checkable fact that makes it matter and let the reader conclude. "Founded in 1989" needs no "marking a pivotal moment."

### 1.2 Canned emphasis on notability, attribution, and coverage

Watch for: *independent coverage*, *local/regional/national media outlets*, *trade publications*, *profiled in*, *written by a leading expert*, *maintains an active social media presence*, *featured in X, Y, and other prominent outlets*.

LLMs prove importance by cataloging where a subject was covered and what kind of sources those are, often echoing notability-guideline language verbatim, and often misattributing their own superficial analysis to the named source.

Instead: Report the substance a source contains, not the fact of coverage. Never claim a source says something it does not.

### 1.3 Superficial trailing analysis

Watch for sentence-final present-participle clauses: *…, highlighting/ underscoring/emphasizing X*, *…, ensuring Y*, *…, reflecting/symbolizing Z*, *…, contributing to*, *…, cultivating/fostering*, *…, enhancing*, *…, offering valuable insights*, *…, aligning/resonating with*.

The clause bolts an unearned significance-claim onto a factual sentence ("The station has 8 tracks and 6 platforms, reflecting its continued relevance in the regional transportation landscape"). It is unattributed opinion, and retrieval-equipped models will pin it on named sources that never said it.

Instead: End the sentence at the fact. If analysis is warranted, make it a separate, attributed, specific claim.

### 1.4 Promotional and advertisement-like language

Watch for: *boasts a*, *vibrant*, *rich*, *profound*, *enhancing*, *showcasing*, *exemplifies*, *commitment to*, *natural beauty*, *nestled*, *in the heart of*, *groundbreaking*, *renowned*, *featuring*, *diverse array*, *seamlessly*, *rich cultural heritage*, *stunning*, and press-release cadence generally.

LLM output drifts toward travel-guide or press-release tone even when asked for neutral style, sometimes while claiming to have removed promotional tone. Newer models are subtler (they avoid "the best") but still skew positive.

Instead: Neutral register. Describe; don't sell. If a rewrite claims to remove promotion, verify it actually did.

### 1.5 Vague attributions and overgeneralized opinions (weasel wording)

Watch for: *industry reports*, *observers have cited*, *experts argue*, *some critics argue*, *several sources/publications* (when few are cited), *such as* before supposedly non-exhaustive lists, *described in scholarship as*, *researchers and conservationists*.

LLMs attribute opinions to vague authorities, present one or two sources as a crowd ("reviewers" and "scholars" backed by a single citation), and imply lists are samples when the source gives everything it has.

Instead: Name who said it, or cut it. Match the stated quantity of support to the actual citations.

### 1.6 Formulaic "challenges" and "future prospects" conclusions

Watch for: *Despite its … faces several challenges…*, *Despite these challenges…*, sections titled *Challenges*, *Challenges and Legacy*, *Future Outlook*, *Future Prospects*, and endings that pivot to vague optimism ("continues to thrive", "positions them as critical components", "could enhance…").

The tell is the rigid formula bolted onto the end of an outline-shaped piece: a challenges paragraph, then a hopeful kicker.

Instead: If challenges are real and sourced, cover them where they belong. End when the content ends; no synthetic arc from adversity to promise.

### 1.7 Term-definition openings

Watch for first sentences that treat a descriptive title as a proper noun or a term to define: "*Catchment area (health)* refers to…", "*The 'List of songs about Mexico'* is a curated compilation of…".

Instead: Open about the subject itself, in a natural sentence. "Refers to" almost never belongs in an opening; the piece is about the thing, not the phrase.

### 1.8 "Awards and recognition" sections

Watch for section headings shaped "X and Y", and especially *Awards and recognition* or plain *Recognition* sections.

The wording "Awards and recognition" is nearly ubiquitous in AI-generated articles. It is the heading-level form of inflated legacy (1.1) and canned coverage-claims (1.2).

Instead: Name sections after their actual content. If awards matter, state which award, from whom, for what.

### 1.9 Content biases

The page documents a pro-authoritarian bias in large models (as of 2026): training data includes state propaganda, and vendors cite user safety in authoritarian countries. The bias is stronger in Chinese-language responses, and models criticize governments of freer countries more readily than repressive ones.

Instead: On politically sensitive or censorship-adjacent topics, verify claims against sources instead of trusting the model's framing.

## 2. Language and grammar

### 2.1 "AI vocabulary" clusters

Empirically overused words (each backed by published studies): *additionally* (especially sentence-initial), *align with*, *boasts* (= has), *bolstered*, *crucial*, *deep dive*, *delve*, *emphasizing*, *enduring*, *enhance*, *fostering*, *garner*, *highlight* (verb), *interplay*, *intricate/intricacies*, *key* (adjective), *landscape* (abstract), *meticulous(ly)*, *pivotal*, *robust*, *showcase*, *tapestry* (abstract), *testament*, *underscore* (verb), *valuable*, *vibrant*.

The overused set shifts by model era. *Delve* peaked in 2023 and 2024, then fell off; *emphasizing*, *enhance*, *highlighting*, and *showcasing* persist in newer output; Grok overuses pseudo-scientific *causal*, *empirical*, and *correlate*. One occurrence is coincidence; a cluster is one of the strongest tells. The flag is literal: these specific words, not their synonyms. Thesaurus-swapping keeps the pattern and adds stiffness.

Instead: Plain verbs and nouns. "Delve into" becomes "examine". "Crucial" becomes "needed for X because Y", or nothing. If a word from the list is genuinely the right word once, fine; a sprinkle of them is not.

### 2.2 Avoidance of "is"/"are"/"has"

Watch for: *serves as/stands as/marks/functions as/operates as/represents [a]*, *boasts/features/ maintains/offers [a]*, *refers to*, *holds the distinction of being*, *ventured into politics as a candidate* (= was a candidate), *began his career as* (= was).

Measured effect: usage of *is/are* dropped over 10% in post-2023 academic text, and AI "copyedits" often replace copulas with these constructions.

Instead: *Is, are, was, has.* The plainest linking verb is usually right, and using it is itself a sign of human writing.

### 2.3 Vague expression of connection or association

Watch for: *in connection with/to*, *connected with/to*, *in association with*, *associated with*, and intensified forms like *particularly/widely associated*.

Newer LLMs abstract a relationship away instead of stating it. The fix words are plain: *of*, *for*, *by*, or a defined relationship (*working in/with*, *used in/for*, *caused by*). This indirection alone proves nothing; its abundance alongside other signs does.

Instead: State the actual relationship. "Is associated with the orchestra" becomes "plays in the orchestra", "conducted the orchestra", or whatever is true.

### 2.4 Negative parallelisms

Three templates:

- *Not just X, but Y*: "not only dismissive but also unnecessarily harsh"; "doesn't just undermine the argument; it questions their very right to participate".
- *Not X, but Y*: "It's not a mirror but a portal"; "Not a career, not a body of work, not sustained relevance — just an algorithmic moment".
- *X rather than Y*: the reversed form; especially common in Grok output.

The construction preemptively corrects a misconception nobody had.

Instead: Assert the true thing directly. Use contrast only when a real, relevant alternative view exists, and then name it.

### 2.5 Rule of three

Triads everywhere: "adjective, adjective, adjective"; "short phrase, short phrase, and short phrase"; three-item example lists ("tiles, metals, and plastics") used to make thin analysis look comprehensive.

Instead: Let the content set the count. Two items, four items, one item. If every list in the piece has exactly three members, that's the tell.

## 3. Style and formatting

### 3.1 Title Case headings

AI headings capitalize All Main Words ("Impact of Technology and Digitalization"). Instead: Sentence case, unless the house style says otherwise.

### 3.2 Boldface overuse

Mechanical "key takeaways" bolding: every occurrence of chosen terms, bold scattered through running prose, bold **assurances** in arguments. Instead: Bold almost nothing. One defined term at first use is plenty.

### 3.3 Inline-header vertical lists

The signature format: a bullet or number, a **Bold Label**, a colon, then description text, repeated for a wall of entries. Often with bullets rendered as •, -, or broken markup, and often paired with rule-of-three content. Instead: Prose paragraphs. Use a list only when items are genuinely parallel and enumerable, and even then, plain items without bolded labels usually read better.

### 3.4 Dashes as punctuation (house rule: never)

The Wikipedia page flags overuse: LLM text uses em dashes (—) more often than comparable human text, in places humans use commas, parentheses, or colons, in punchy sales rhythm ("we do seem to have different interpretations — and that's the problem"), and usually spaced, contrary to typographic practice. The rate varies by model era: a July 2026 study found that of contemporary models only Claude used em dashes more than professional writers, and ChatGPT used them less.

This skill goes further: never use a dash as a sentence-level connector. That means no em dash, and no substituting the same construction with an en dash (–) or a spaced hyphen ( - ); swapping the character keeps the tell. Rewrite with a comma, a colon, parentheses, or two sentences. Hyphens remain for compound words, and en dashes for numeric ranges where house style wants them.

### 3.5 Emoji as formatting

Emoji decorating headings or bullet lists (🚀 for launches, 🧠 for analysis, 👋 welcome sections). Instead: None, unless the user's own style calls for them.

### 3.6 Unnecessary tables

Small tables for facts that read naturally as prose ("Market Valuation (2024)
| ~USD 2.1 billion"). Instead: Prose for a handful of facts; tables only
for genuinely tabular data.

### 3.7 Curly quotation marks and apostrophes

ChatGPT and DeepSeek emit curly quotes (“ ” ‘ ’) and curly apostrophes, sometimes inconsistently mixed with straight ones. Word processors and typeset publications also produce them, so this is context-dependent, but in code-adjacent or plain-text contexts they are a tell and often a bug. Instead: Match the destination: straight quotes in code, wikis, Markdown; follow house style elsewhere. Never mix.

### 3.8 Skipped heading levels

Starting sections at h3 with no h2 above them, common in chatbot output and rare in hand-written documents. Instead: Descend one level at a time.

### 3.9 Thematic breaks between sections

A horizontal rule (`---` / `----`) between each section, a Markdown-output habit. Instead: Headings separate sections on their own.

### 3.10 Title heading at the top

A heading repeating the document's title before the content, because the model does not picture the title as already there. Instead: Start with the content; the title exists once, where the medium puts it.

### 3.11 Headings that only contain other headings

A heading whose entire body is more headings, with no text of its own. Instead: A heading earns its place with content; merge or drop empty levels.

### 3.12 Level 1 headings for sections

Sections set at h1 (`=` in wikitext, `#` in Markdown), often from mistranslated Markdown; most media reserve h1 for the title. Instead: Sections start at h2 and descend one level at a time.

## 4. Chat artifacts leaking into deliverables

### 4.1 Collaborative chatter

Watch for: *I hope this helps*, *Of course!*, *Certainly!*, *You're absolutely right*, *Would you like…*, *is there anything else*, *let me know*, *here is a…*, *more detailed breakdown*, meta-advice about the deliverable ("ensure the content is presented in a neutral tone"), and leftover instructions ("Delete this section before submission").

Instead: The deliverable contains only the deliverable. Conversation goes in the conversation.

### 4.2 Knowledge-cutoff disclaimers and speculation about gaps

Watch for: *as of my last knowledge update*, *up to my last training update*, *while specific details are limited/scarce…*, *not widely available/ documented/disclosed*, *…in the provided/available sources/search results…*, *based on available information*, *maintains a low profile*, *keeps personal details private*, and "likely/probably" bridges into invented specifics ("the mountain likely supports…").

The claim that information "is not documented" is itself speculation, and what follows it is usually fabrication.

Instead: Say plainly what you verified and what you don't know, without boilerplate, and never backfill a gap with plausible-sounding guesses.

### 4.3 Placeholders and phrasal templates

Watch for: `[Your Name]`, `[Describe the specific section…]`, `[link to the revised article]`, `2025-XX-XX`, `INSERT_SOURCE_URL`, `PASTE_URL_HERE`, and Mad-Libs sentence frames left unfilled.

Instead: Fill every blank with real content or remove the frame. Grep for `[`, `XX`, `INSERT`, `PASTE`, `TODO` before delivering.

## 5. Markup and reference integrity

### 5.1 Wrong markup for the medium

Markdown syntax (`**bold**`, `## heading`, `[text](url)`, `---`) in destinations that use another language (wikitext, HTML, plain email, rich-text platforms), or a mix of both from a partial conversion. The double footprint (for example, Markdown headers plus fenced ` ```wikitext ` blocks) is a strong tell. Related: hallucinated wikitext, non-existent templates, plausible-sounding but non-existent categories, and broken syntax generally.

Instead: Know the destination's markup and emit only that, syntactically valid. Never invent templates, categories, config keys, or link targets. Verify anything you didn't copy from a real source.

### 5.2 Tool residue

Machine artifacts pasted from chatbot UIs:

- `citeturn0search0`, `turn0image0` (ChatGPT link placeholders)
- `:contentReference[oaicite:0]{index=0}`, `oai_citation`, `Example+1`
- `[attached_file:1]`, `[web:1]` (Perplexity)
- `ppl-ai-file-upload` in citation URLs pointing at an Amazon S3 bucket (Perplexity)
- `<grok-card …>`, `grok_render_citation_card_json` (Grok)
- `【85†L261-269】` lenticular-bracket citations (DeepSeek)
- `[cite: 17]` markers (Gemini)
- `[span_1](start_span)`, `[span_1](end_span)` formatting bugs (Gemini)
- `({"attribution":{"attributableIndex":"1009-1"}})`
- `:::writing{variant="document" id="12345"}`
- URL trackers: `utm_source=chatgpt.com`, `utm_source=openai`, `utm_source=copilot.com`, `referrer=grok.com`
- `↩` footnote back-arrows

Instead: These are always bugs. Grep output for them (`turn0`, `oaicite`, `utm_source=`, `【`, `[cite:`, `:::`, `grok_`, `start_span`, `end_span`, `ppl-ai-file-upload`) and strip trackers off URLs.

### 5.3 Citation fabrication and sloppiness

Documented failure modes:

- Broken external links: multiple dead, never-archived links in one piece signal invented references.
- Invalid DOIs and ISBNs: checksums fail, or the DOI resolves to an unrelated paper (real-looking citation, wrong target).
- Book citations without page numbers: a plausible book, an unverifiable claim; or a real book and page whose text doesn't contain the claim.
- Declared-but-unused references, wrong reference-reuse syntax, and footnotes attached to sentences they don't support.
- Stale or placeholder access dates (`access-date=2025-XX-XX`, or a date a year before the edit).

Instead: Cite only sources you actually retrieved and read. Verify every URL resolves, every DOI/ISBN matches the work, every page number contains the claim. A missing citation is honest; a fabricated one is poison.

## 6. Process writing (summaries, commit messages, self-reports)

From the page's "edit summaries", "comments", and "submission statements" sections, generalized: AI process-writing over-justifies, in rigid formulae. Watch for:

- First-person formal paragraphs itemizing virtues ("ensured neutral tone", "adheres to guidelines").
- Exhaustive summaries of trivial changes.
- Preemptive compliance claims ("This draft is neutral and well-sourced and meets all standards").
- Canned assurance vocabulary: *ensured that ... adheres to*, *refined*, *enhanced*, *streamlined*, *in compliance with*, *neutrality*, *clarity*, *flow*. Verbose yet unspecific, unlike a human's brief "removed excessive links per MOS:OVERLINK".
- Procedural statements about what was NOT changed: *preserved/retained X*, *avoided Y*, *while preserving the original meaning*. Humans rarely list what they didn't do; a prompted model does.
- Overemphasis on citedness: "added sourced content", "with independent sources", instead of saying what the content is.
- Itemized markup minutiae: naming infobox or reference parameters and templates, with brackets and equals signs, at a granularity new editors never volunteer.
- Stating the obvious about review feedback: "addressed reviewer feedback", "per reviewer feedback".
- Deflection when questioned: downplaying AI use while assuring effort and compliance, dismissing concerns as speculation rather than "concrete" evidence, urging critics to focus on the content instead of its origin, and letter openings like "Dear Wikipedia Editorial Team".
- Assurances in place of evidence.

These are rigid formulae: the more a summary deviates from the pattern, the less likely it is AI, even when long or formal.

Instead: Commit messages and summaries state what changed and why, in the project's conventional length and register. Don't certify your own compliance; let the work show it. Never include self-congratulation or defensive justification.

## 7. Historical tells, still worth avoiding

Common in older models, rarer now, still instantly recognizable:

- Didactic disclaimers: *it's important/crucial to note/remember/ consider*, *worth noting*, *may vary*, safety caveats for imagined readers.
- Forced synonym cycling (elegant variation): repetition penalties in older models rotated synonyms for the same referent ("the constraints of socialist realism", then "the challenging climate of Soviet artistic constraints", then "state-imposed artistic norms"), blurring it with each rotation. Call the same thing by the same name every time; repetition of the right word is clarity, not a defect. (Caveat: some non-native English writers are taught to avoid repetition too. The source page reclassified this as historical in 2026.)
- Section summaries: *In summary*, *In conclusion*, *Overall*, sections titled "Conclusion" that restate the piece, paragraph-final restatements.
- Prompt-refusal residue: *as an AI language model*, *I cannot… but I can…*, *I'm sorry*.
- Abrupt cutoffs: text that stops mid-sentence from a token limit.

Deliver complete text that ends when the content ends: no recap, no disclaimer, no apology.

## 8. Write like a human (positive signs)

Patterns empirically more common in human writing. Use them:

- Simple *is/has* phrases: "there is a", "it has a".
- Plain words over stiff synonyms: *wrote* not *authored*, *used* not *utilized*, *moved* not *relocated*, *tried* not *attempted*, *died* not *passed away*.
- Definite statements when true: "was the first", "is the only", "one of the best". Commit; don't sand every claim down to hedged mush.
- Natural hedges and intensifiers where uncertainty is real: *very*, *perhaps*, *tends to*.
- Ordinary wordy constructions in moderation: "as a result of", "in order to", "the fact that". Human prose has texture; ruthlessly "optimized" prose reads generated.
- Being able to explain any choice you made in the text. If asked why a sentence, source, or number is there, have a real answer.

## 9. Do not overcorrect (ineffective indicators)

The page lists signals that do NOT indicate AI. Don't contort writing to avoid them, and don't cite them when auditing:

- Perfect grammar, or formal, academic, "fancy" prose in general (only the specific vocabulary above is flagged).
- Mixed casual/formal register (a human trait: field-specific, generational, or just a preference).
- A "bland" or "robotic" feel as a vibe, without specific signs.
- Letter-like formalities, in isolation.
- Ordinary transition words in isolation (an occasional "However" is fine; formulaic sentence-initial "Additionally," is the flagged form).
- Unsourced content (mostly human), or conversely present-but-real citations.
- Correct markup, or bizarre markup errors of the human kind.

Also from the source's caveats:

- Humans detect AI text barely better than chance (heavy LLM users reach roughly 90%, still with false positives), and automated detectors have real error rates.
- Human writing is drifting toward LLM style as people absorb it.
- So in audit mode: report signs and density, state likelihood, never claim certainty.
- The deeper problems behind the signs (fabrication, unverified claims, promotion) matter more than the surface tells. Fixing only the surface makes text harder to check, not better.
