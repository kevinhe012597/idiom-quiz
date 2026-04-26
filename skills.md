# Lexicon Concept-Extraction Skills

Rules the AI must follow when extracting, looking up, refining, or augmenting concept flashcards. These rules are loaded by `server.js` at startup and injected into every concept-creation prompt — edit this file to evolve the behavior across all endpoints at once.

## Card Structure

Every card is JSON: `{ title, points: [], tags: [] }`.

## Bullet Format

- 5-7 bullets per card by default. Argumentative talks lean to the low end; fact-dense lists lean to the high end.
- Each bullet 20-30 words — one tight sentence (or short two) combining a concrete fact with its significance. Not telegraph-short, not paragraph-long.
- Pack related facts into the same bullet (funding stage + founding year + lead investors + valuation = ONE bullet, not four).
- Do NOT prefix bullets with "•", "-", "*", or any bullet character — just the plain text.
- Markdown is allowed inside bullets: **bold**, *italic*, `code`, [links](url).

## TL;DR First Bullet

The FIRST bullet of every card MUST start with "TL;DR: " and be a cocktail-party takeaway — the single most memorable, punchy, quotable one-sentence framing of the concept. Imagine the user pulling it out at a cocktail party or interview to describe the concept on the fly.

## Self-Explanatory Titles

CRITICAL — drill review surfaces ONLY the title — no bullets, no context. Titles must be recognizable cold.

AVOID vague abstract labels: "X's Framework", "The Bottleneck", "Why Y", "Key Lessons", "Primitive Thinking".

INSTEAD name the concept fully OR attach a concrete hook (specific number, named entity, canonical example, key claim).

Examples:
- BAD: "Primitive Thinking" → GOOD: "'Build the Primitive' Framework: Make the Industry's Foundational Layer (SpaceX = $/kg to orbit)"
- BAD: "The AI Bottleneck Chain" → GOOD: "AI Scaling Bottleneck Chain: Chips → Power → Nuclear → Enrichment"
- BAD: "Germany's Policy" → GOOD: "Germany's Nuclear Shutdown vs France: Self-Defeating Energy Policy Case"

Test: if a stranger saw only the title, would they know what the card is about?

## Tags

- **1-2 tags maximum per card.** Less is more — only add a second tag if it's genuinely distinct from the first.
- **ONLY use tags from the existing tag list provided in the prompt.** Do NOT invent new tags. If none of the existing tags fit, return an empty array `[]` — the user will manually add a new tag if needed.
- If no existing tags are provided in the prompt at all, then (and only then) suggest 1 broad topic tag.
- Format: array of strings, e.g. `["AI"]` or `["AI", "Infrastructure"]`.

## Beyond-the-Basics Depth

Don't just list surface-level facts (school, birth year, founding date). Always go further:

- WHY the concept/company/person matters strategically
- Their MOST INTERESTING views, controversies, contrarian positions
- Specific famous quotes, decisions, products, pivots
- How they relate to broader trends (competitors, industry shifts, historical context)
- Non-obvious insights — what an insider would tell a curious friend

## Entity-Specific Required Coverage

When the concept is a specific entity, the bullets MUST cover these specific facts. Use web search if you don't know them.

### Startups / Companies
- ONE dense bullet packing: funding series, latest valuation, lead investors per round (e.g. "Series C at $5B led by Sequoia in 2024; prior Series B led by a16z in 2023, Series A led by Greylock in 2022")
- ONE bullet covering: founding date, founder name(s), and founder background (prior company / education only if relevant to what they're building)
- ONE bullet on the main product — what it actually does, not just buzzwords
- ONE bullet with a CONCRETE REAL-WORLD USE CASE — describe a specific person/team and what they actually do with the product. Be vivid and specific. Examples:
  - "A growth marketer at a Series A SaaS uses it to generate 50 landing-page variants per week for paid-ad funnels."
  - "A solo iOS developer uses it to add Stripe checkout to a side project in 10 minutes without writing backend code."
  - "An M&A analyst at a mid-market PE firm uses it to summarize 200-page CIMs into 1-page deal memos."
  Avoid generic phrasing like "developers use it to build apps" — name the buyer persona AND the workflow.
- ONE bullet naming 2-4 main competitors (and ideally how this company differentiates)
- ONE bullet placing them in a SPECIFIC sector — not "AI" but "AI infrastructure for video generation" or "robotics foundation models for warehouse automation". Be precise.
- Plus the standard TL;DR cocktail-party bullet at the top

### Politicians / Political Figures
- ONE bullet on their main political views / ideological positioning
- ONE-TWO bullets on their signature policies or legislative achievements (specific bills, executive orders, votes)
- Plus controversies, signature quotes, factional alignment within their party
- Plus the standard TL;DR cocktail-party bullet at the top

### Pop Culture Figures (artists, actors, musicians, athletes)
- ONE bullet on how long they've been active + their career arc (breakthrough year, peak period)
- ONE-TWO bullets naming their most famous works (movies, albums, songs, performances) — be specific with titles and years
- Plus their cultural significance, signature style, controversies, collaborations
- Plus the standard TL;DR cocktail-party bullet at the top

### Concepts / Ideas / Frameworks
- ONE bullet on the core idea — what it actually claims
- ONE bullet on who's pushing it (key proponents, originating thinkers, companies betting on it)
- ONE bullet with a real-world example or canonical case
- ONE bullet on the counterargument, limitation, or critique
- ONE bullet on where it's headed (current adoption, near-future trajectory)
- Plus the standard TL;DR cocktail-party bullet at the top

### People (other public figures, executives, scientists, etc.)
- Cover signature ideas/views/decisions, famous quotes, controversies
- Mention background only if it shapes their worldview or is genuinely surprising
- Plus the standard TL;DR cocktail-party bullet at the top

## Source Inference

Article extraction only. When extracting from an article/transcript/document, also return a `suggestedSource` — a human-friendly label inferred from the CONTENT (not the filename):

- Talk/podcast: "Talk with [speaker] ([their company/role])" e.g. "Talk with Scott Nolan (General Matter, on nuclear + AI)"
- Article: "[Publication]: [topic]" e.g. "NYT: AI energy demand surge"
- Conversation: "Conversation about [topic]"
- Class notes: "[Course/topic] lecture notes"

Keep under 70 characters.

## Card Density

Article extraction only.

- Argumentative talks / long-form articles: 5-8 cards (prefer fewer DENSE cards over many shallow ones)
- Fact-dense lists / structured notes: 8-15 cards
- If text has section headers (e.g. "Trade & Economics:", "Immigration:"), make a card per section — don't collapse.

## Speaker Attribution

Transcripts only. If the source is a transcript with multiple speakers (timestamps, "Speaker N:"), attribute claims explicitly: "Sam Altman in Senate testimony said…", "Scott's framework", etc. Distinguish speaker claims from moderator framing.

## Append Mode

When `existingBullets` is provided (the user is adding bullets to an existing card):

- Generate ONLY new bullets that don't duplicate any fact, angle, or framing already present
- Do NOT include a "TL;DR:" bullet (the existing card already has one)
- No bullet count cap — produce as many or as few new bullets as the user's instruction warrants
- Skip the "first bullet must be TL;DR" rule

## Output

Return valid JSON only. No prose, no markdown fences, no explanation.
