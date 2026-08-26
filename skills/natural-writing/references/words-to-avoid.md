# Words and phrases to avoid

Term lists from [Wikipedia:Signs of AI writing](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing), grouped by pattern for scanning a draft against.

- The lists are written for reading, not for `grep -f`. For mechanical checks, use the two grep commands in SKILL.md step 4 (dash punctuation and tool residue are hard errors, the vocabulary grep is a prompt to reread).
- A hit is not automatically wrong. It means reread the sentence against the catalog and rewrite if the underlying pattern is there.
- Clusters of hits are the real signal.

## AI vocabulary (empirically overused words)

additionally (sentence-initial), align with, boasts, bolstered, causal (Grok), correlate (Grok), crucial, deep dive, delve, emphasizing, empirical (Grok), enduring, enhance, fostering, garner, highlight (verb), highlighting, interplay, intricate, intricacies, key (adjective), landscape (abstract noun), meticulous, meticulously, pivotal, robust, showcase, showcasing, tapestry (abstract noun), testament, underscore (verb), underscores, valuable, vibrant

Era notes: 2023 to mid-2024 output leans on delve, tapestry, testament, intricate, bolstered, garner; mid-2024 to mid-2025 on align with, fostering, showcasing, enduring, vibrant; mid-2025 onward on emphasizing, enhance, highlighting, showcasing.

## Inflated significance and legacy

stands as, serves as, is a testament, is a reminder, vital role, significant role, crucial role, pivotal role, pivotal moment, key moment, underscores its importance, highlights its significance, reflects broader, symbolizing its ongoing, enduring legacy, lasting legacy, contributing to the, setting the stage for, marking the, shaping the, represents a shift, marks a shift, key turning point, evolving landscape, focal point, indelible mark, deeply rooted, generated debate, prompted broader reflection, shaped emerging discussions, raising philosophical questions

## Promotional language

boasts a, vibrant, rich, profound, enhancing, showcasing, exemplifies, commitment to, natural beauty, nestled, in the heart of, groundbreaking, renowned, featuring, diverse array, seamlessly, rich cultural heritage, stunning, breathtaking, gateway to, value-driven, state-of-the-art

## Coverage and notability boilerplate

independent coverage, media outlets, trade publications, profiled in, featured in, written by a leading expert, active social media presence, strong digital presence, significant coverage, widely-read outlets, Awards and recognition (section heading), Recognition (section heading)

## Superficial trailing analysis (sentence-final participles)

, highlighting, , underscoring, , emphasizing, , ensuring, , reflecting, , symbolizing, , contributing to, , cultivating, , fostering, , encompassing, , enhancing, , demonstrating, , confirming, , illustrating, , facilitating, valuable insights, resonate with

## Weasel attributions

industry reports, observers have cited, observers have noted, experts argue, some critics argue, several sources, several publications, described in scholarship, researchers and conservationists, widely regarded, widely interpreted

## Formula endings and framings

despite its, despite these challenges, faces several challenges, future outlook, future prospects, continues to thrive, positions them as, in summary, in conclusion, overall (sentence-initial), it's important to note, it is important to note, it's crucial to note, worth noting, may vary

## Copula avoidance

serves as a, stands as a, marks a, functions as a, operates as a, represents a, boasts, features a, maintains a, offers a, refers to, holds the distinction of, began his career as, began her career as, ventured into

## Vague connection or association

in connection with, in connection to, connected with, connected to, in association with, associated with, particularly associated, widely associated

## Negative parallelisms

not just, not only ... but also, isn't just, doesn't just, it's not ... it's, is not ... but, no ... no ... just, rather than (as a reversed parallelism)

## Chat and disclaimer artifacts

I hope this helps, of course!, certainly!, you're absolutely right, would you like, is there anything else, let me know, here is a, here's a, detailed breakdown, as of my last knowledge update, up to my last training update, while specific details are limited, not widely documented, not publicly available, in the provided search results, based on available information, maintains a low profile, keeps personal details private, as an AI language model, I'm sorry, I cannot

## Placeholders

[Your Name], [Describe, [link to, XX-XX, INSERT_, PASTE_, TODO, TBD

## Process writing (summaries and self-reports)

ensured that ... adheres to, refined, enhanced, enriched, streamlined, in compliance with, complies with, neutrality, neutral tone, encyclopedic tone, clarity, flow, preserved, preserving, retained, retaining, avoided, avoiding, ensuring, aiming to, added sourced, added verified, improved attribution, with independent sources, per reviewer feedback, addressed reviewer feedback

## Tool residue (grep patterns)

turn0, oaicite, oai_citation, contentReference, attributableIndex, attached_file, grok_card, grok_render_citation_card_json, 【, [cite:, [web:, start_span, ppl-ai-file-upload, :::writing, utm_source=chatgpt.com, utm_source=openai, utm_source=copilot.com, referrer=grok.com, ↩

## Punctuation and formatting (house rules)

- Em dash (—): never. En dash (–) or spaced hyphen ( - ) used as the same connector: never. Rewrite the sentence.
- Curly quotes and apostrophes (“ ” ‘ ’): only where house style requires; never in code, wikis, or plain text; never mixed with straight quotes.
- Emoji in headings or lists: no.
- Bold-label bullets (**Term**: text): no.
- Title Case Headings: no; use sentence case.
- Horizontal rules before headings: no.
