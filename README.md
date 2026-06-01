# Lexicon

> A personal knowledge tool that learns alongside you. Vocabulary drills, concept flashcards, a people CRM, and a notepad — all queryable by AI.

**Live demo (reviewers, peers):** https://lexicon.up.railway.app/?demo=1
**Live (production, my personal instance):** https://lexicon.up.railway.app
**Repo:** https://github.com/kevinhe012597/idiom-quiz
**Stanford CS 153 — Spring 2026 — by Kevin He**

---

## Try it now

1. Open **https://lexicon.up.railway.app/?demo=1** on a laptop or phone.
2. The `?demo=1` query flag flips your browser into **demo mode** — an isolated sandbox with pre-seeded sample data so you can see what a populated app looks like:
   - 8 vocab cards (`gaslight`, `palpable`, `bite the bullet`, `serendipity`, …)
   - 3 concept flashcards (Spaced Repetition, RAG, PWAs vs Native)
   - 2 dossier entries (Henry Gao the person, Anthropic the firm) with notes
   - 1 Questions topic with 2 example questions
3. You'll see an orange **"🧪 Demo mode"** banner at the top. The URL strips the query param after detection, so screenshots look clean.
4. Tap into any module from the home screen. Try the **Chat with my knowledge** RAG feature: ask *"what does Henry think about AI infrastructure?"* — it cites the seeded dossier note.
5. The orange banner has a **↻ Reset** button if a previous reviewer left the demo in a weird state.

The demo is sandbox-only: data lives under demo-scoped localStorage and a `demo` user ID on the server, fully isolated from any other user. Server enforces this — even hand-crafted requests can't escape demo mode into other users' data.

For **personal use** (production), open `https://lexicon.up.railway.app/` (no query). The app prompts for a unique username on first launch; data stays scoped to that name. There's no real auth (yet); see [Known limitations](#known-limitations) below.

---

## Why this exists

I read a lot, meet a lot of people, and forget most of it. I tried every tool:

- **Anki** is the gold standard for spaced repetition, but its world is fixed — you can drill vocabulary, but you can't drill "what did Henry tell me about AI infra during lunch last month?" There's no concept of *people* or *unstructured notes*. Adding cards is a friction-heavy chore.
- **Notion** is great for notes but doesn't drill you. Information goes in, never tested, slowly forgotten.
- **Quizlet / Duolingo** are public-content engines, not personal-knowledge engines.
- **A CRM** is for sales, not for remembering that Sarah's mom just had surgery.

Lexicon argues these are all the same problem: **retention of a growing personal knowledge base**. So it unifies them under four modules that share a single sync layer, a single AI provider router, and a single RAG index that lets you chat with everything you've ever saved.

The hypothesis: a tool you actually use for ten things will retain you better than ten tools you use for one thing each.

---

## What it does

### Four modules

| Module | What it stores | How you use it |
|---|---|---|
| **📖 Vocabulary** | Words, idioms, phrases with meanings + AI-generated examples | Fill-in-the-blank drills with AI-generated sentences. SRS-style buckets (Nope / Kinda / Nailed it). Daily Mode auto-mixes new + review cards. |
| **💡 Concepts** | Long-form flashcards extracted from articles, YouTube, transcripts, or your own notes | Paste a URL or transcript → AI extracts 5–15 bullet-pointed cards following rules in `skills.md`. Drill via Recall mode. |
| **🗂️ Dossier** | People & firms with chronological notes | CRM for personal use. AI summarizes "what I know" per entity. "Brief me before a meeting" generates a tailored briefing from notes. Extract structured notes from meeting transcripts via AI. |
| **❓ Questions** | Half-formed thoughts grouped by topic | Plain notepad with one twist: ✨ Polish refines a rough question via Claude Sonnet before you save. |

### Cross-cutting features

- **Chat with my knowledge (RAG):** "What did Henry tell me about AI infra?" Embeds the question via OpenAI `text-embedding-3-small`, runs a sqlite-vec KNN search over concepts + dossier entities + dossier notes scoped to the current user, hydrates context, calls Claude Sonnet, returns an answer with clickable citation chips that route to the source card.
- **Look Up screen with 10 AI tools:** word definition, complete-the-sentence (with optional constraints like "must start with p"), reverse lookup, find-the-right-phrase, critique my word choice, name the vibe, synonyms, polish my sentence, translate ZH↔EN. A **Triage** flow lets you paste a dump and route each line to a different tool in one place.
- **iOS native app:** Wrapped with Capacitor, sideloaded on my iPhone. Adds: native haptic feedback on rating, 9pm daily local notification, safe-area padding for the Dynamic Island, swipe-from-left-edge back gesture.
- **Multi-user namespacing:** Every API request carries an `X-User-Id` header; server scopes all SQLite reads/writes (and the vector index) by user. Lets me share the app with friends without commingling data. No real auth yet — see Limitations.

---

## Architecture

```
   ┌────────────────────────────────────────────────────┐
   │  iPhone (Capacitor native shell — WKWebview)       │
   │  ┌──────────────────────────────────────────────┐  │
   │  │ index.html (single-file PWA, ~14k LOC)       │  │
   │  │  • 4 modules + Look Up + RAG chat            │  │
   │  │  • Service worker (offline cache, v178)      │  │
   │  │  • Local notifications + haptics plugins     │  │
   │  └──────────────────────────────────────────────┘  │
   └──────────────────┬─────────────────────────────────┘
                      │  HTTPS  (X-User-Id header)
                      ▼
   ┌────────────────────────────────────────────────────┐
   │  Railway: Node.js server.js (~5.5k LOC)            │
   │  ┌──────────────────────────────────────────────┐  │
   │  │ Router: 30+ endpoints                        │  │
   │  │  • /api/cards /api/concepts /api/dossier     │  │
   │  │  • /api/questions /api/scratchpad ...        │  │
   │  │  • /api/knowledge-chat (RAG)                 │  │
   │  │  • /api/polish /api/critique /api/vibe ...   │  │
   │  └──────────────────────────────────────────────┘  │
   │  ┌──────────────────────────────────────────────┐  │
   │  │ Multi-model router (pickModel / pickAnthro): │  │
   │  │  OpenAI · Anthropic · Fireworks · Gemini     │  │
   │  └──────────────────────────────────────────────┘  │
   │  ┌──────────────────────────────────────────────┐  │
   │  │ SQLite (/data/idiom-quiz.db, ~50MB):         │  │
   │  │  • app_state (KV, user-scoped)               │  │
   │  │  • embeddings (1536-dim float32 BLOBs)       │  │
   │  │  • sqlite-vec extension for KNN              │  │
   │  └──────────────────────────────────────────────┘  │
   └──────────────────┬─────────────────────────────────┘
                      ▼
   OpenAI · Anthropic · Fireworks · Gemini · ElevenLabs
```

---

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | Vanilla HTML/CSS/JS in one `index.html` | No build step. Fast to iterate. PWA-compatible. |
| iOS shell | Capacitor 8 (`@capacitor/ios`) | Webview wrapper points at the Railway URL, so every web deploy updates the iOS app too. Plugins for haptics + local notifications. |
| Backend | Node 22 + native `node:sqlite` | Zero runtime dependencies for SQL. Single-file server. |
| Vector store | `sqlite-vec` extension + float32 BLOBs in SQLite | No separate vector DB needed. Falls back to JS cosine if extension fails. |
| Embeddings | OpenAI `text-embedding-3-small` (1536-dim) | Cheap ($0.02/M tokens), well-supported, fast. |
| Chat / RAG generation | Anthropic Claude Sonnet 4.6 | Best instruction-following for citation-aware answers. |
| Card extraction & polish | Claude Sonnet 4.6 with tool-use | Structured JSON via tool schemas is more reliable than asking for raw JSON. |
| Fast lookups (translation, etc.) | OpenAI GPT-5.4 Mini default, swappable | Cheap and fast. UI lets me swap to any of 13 models on the fly. |
| YouTube transcription | Google Gemini 2.5 | Native YouTube ingestion + transcription in one call. |
| Audio TTS | ElevenLabs (with Speech Synthesis fallback) | Better-than-default pronunciation for vocab drills. |
| Hosting | Railway + 500MB persistent volume | Simple `railway up` deploy, sticky `/data` volume for the SQLite file. |

---

## How to run locally

Requires **Node 22+** and (optionally) an Apple Developer environment for the iOS shell.

```bash
git clone https://github.com/kevinhe012597/idiom-quiz.git
cd idiom-quiz
npm install
```

Create a `.env` file at the project root:

```bash
# Required
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...

# Optional — Lexicon will work without these, but some features will be missing
FIREWORKS_API_KEY=fw_...           # cheap OSS-model alternates
GEMINI_API_KEY=AIza...             # YouTube ingestion
ELEVENLABS_API_KEY=el_...          # premium TTS (falls back to browser SpeechSynthesis)

# Optional
PORT=3000                           # default
DB_PATH=./idiom-quiz.db             # default
```

Then:

```bash
node server.js
```

Open http://localhost:3000.

For the iOS app:

```bash
npx cap sync ios
npx cap open ios     # opens Xcode
```

Then run on a simulator or sideload to a physical device (requires a free Apple ID for 7-day signing or an Apple Developer account for TestFlight).

---

## Repo tour

| Path | Purpose |
|---|---|
| `server.js` | Single-file Node server. Routes all `/api/*` endpoints; sets up SQLite + sqlite-vec; routes between AI providers; runs the embed backfill loop. |
| `index.html` | Single-file PWA frontend. Contains every screen, every CSS rule, every JS function. Heavy, but no build pipeline. |
| `sw.js` | Service worker. Network-first for HTML/API, cache-first for static assets. |
| `skills.md` | Plain-text rules the server loads at startup and injects into every concept-extraction prompt. Edit this file to change extraction behavior globally — no code changes needed. |
| `manifest.json` | PWA manifest (icons, theme color, etc.). |
| `package.json` | Node deps + start script. |
| `capacitor.config.json` | Capacitor iOS shell config (points at the Railway URL). |
| `ios/` | Generated Xcode project. Regenerable via `npx cap add ios`. |
| `idiom-quiz.db` | **Local dev DB only** — gitignored in `.gitignore`. Production DB lives on the Railway volume. |
| `.env` | Local secrets — gitignored. |

---

## Evaluation & evidence

### Self-as-user usage (as of submission)

| Metric | Value |
|---|---|
| Total vocab cards added | ~155 |
| Concepts saved | ~30 |
| Dossier entities | ~10 |
| Days using the app daily | ~70 |
| Most-drilled card | Whatever I was about to forget — drilled 20+ times |
| Cost to run (Apr–May) | ~$2 in API calls + $5/mo Railway |

I am the heaviest user. The fact that I open it daily — for vocab drills, jotting down half-formed questions, and looking up people before meetings — is the strongest evidence I can offer in this timeframe.

### How Lexicon compares to alternatives

| Capability | Lexicon | Anki | Notion | Recall.ai |
|---|---|---|---|---|
| Spaced-repetition drilling | ✅ | ✅✅ (gold standard) | ❌ | ❌ |
| AI-generated examples & fill-in-the-blank | ✅ | ⚠️ (plugin) | ❌ | ❌ |
| Long-form note storage | ✅ | ❌ | ✅✅ | ✅ |
| People CRM / chronological notes | ✅ | ❌ | ⚠️ (manual templates) | ❌ |
| Chat with your knowledge (RAG) | ✅ | ❌ | ⚠️ (Notion AI, generic) | ✅✅ |
| Native iOS app | ✅ | ✅✅ | ✅ | ❌ |
| Self-hostable | ✅ | ⚠️ (sync server only) | ❌ | ❌ |

Lexicon's claim isn't "better than each tool in its category." It's "good enough at all four to remove the friction of switching."

### Known limitations

- **No real auth.** Multi-user is namespacing-only. Anyone who knows your username can read your data. Real Sign-in-with-Apple is the next milestone.
- **Cold-start cost.** The app shines after you've added ~20 cards. Day-1 it feels empty.
- **iOS sideloading expires every 7 days.** Free Apple ID limit; only fixable with a $99/yr Apple Developer Program account.
- **API costs scale with daily use.** Heavy use ≈ $0.10–$0.50/day. Not prohibitive for solo use but would be for a public free tier.
- **Single-file frontend.** `index.html` is ~14k lines. Maintainable for one developer; would not survive a team without modularization.
- **No automated tests.** The product is dogfooded daily, which catches most bugs, but a regression suite would catch the rest.

### What worked, what didn't

- **Worked:** Single-file `index.html` + `server.js` kept iteration speed *insanely* high. Over 90 deploys in 7 weeks. Skills.md as a prompt-rules file means I can change extraction behavior without touching code.
- **Worked:** Capacitor wrap was 1-day work and delivered native haptics, notifications, swipe gestures, and an app icon on my home screen.
- **Didn't work the first time:** Sonnet 4.6 returns JSON wrapped in markdown / prose ~10% of the time. Strict `JSON.parse` failed silently. Fix: a tolerant `extractJsonObject(content)` helper that strips fences, then slices from the first `{` to the last `}`. Lives at `server.js:3981`.
- **Didn't work the first time:** Tried JS-cosine vector search for the RAG. Fine to ~1k vectors, jittery past 10k. Switched to the `sqlite-vec` extension; kept the JS fallback path so the code degrades gracefully if the extension fails to load.
- **Almost broke production:** Accidentally `git add -A`-ed a personal data export to the public repo on commit `1ba645fc`. Caught immediately. Added `.gitignore` rules to prevent recurrence. The file is still in git history — a real public-launch checklist item.
- **Didn't work:** Tried browser-native PWA install on iOS — Safari evicts localStorage after 7 days of inactivity. Capacitor's WKWebview persistence solved it.

---

## AI usage disclosure

Per CS 153 policy, AI tools were used extensively. Honest accounting:

### Development (code authoring)

The codebase was written collaboratively with **Anthropic's Claude Code (Opus 4.7)**. Most of `server.js` and `index.html` was generated by Claude under my direction. I:

- Designed the architecture and product direction
- Drove all design decisions (UI, data model, AI provider routing, what features to build and ship)
- Reviewed every diff before deploy
- Wrote prompts, debugged failures, and made the calls when Claude's first attempt was wrong
- Tested every feature by daily-driving the app

Claude did the typing. The 92 public commits reflect ~6 weeks of paired development where I prompted, reviewed, course-corrected, and shipped.

### Runtime (in-app AI features)

The app makes API calls to multiple providers. Specific use:

| Provider | Models | Used in |
|---|---|---|
| **Anthropic** | Claude Sonnet 4.6 (default), Opus 4.7, Haiku 4.5 | Knowledge-chat (RAG), concept extraction, polish-thought, polish-question, dossier summarization, meeting-note extraction |
| **OpenAI** | GPT-5.4 Mini (default), 5.4, 5.4 Pro, 5.5, GPT-4o Mini, `text-embedding-3-small` | Word lookups, translation, synonyms, name-the-vibe, embeddings for RAG |
| **Fireworks** | DeepSeek V3.2, Llama 3.3, Qwen 3.6, Kimi K2.6 | Open-source-model parity option; user can switch any AI feature to OSS |
| **Google** | Gemini 2.5 | YouTube ingestion (transcription + extraction in one call) |
| **ElevenLabs** | Turbo v2.5 | Vocab pronunciation TTS |

The user can switch the active model for any given AI feature via the dropdown on the home screen.

---

## What's next

In rough priority order:

1. **Real authentication** — Sign in with Apple is the natural next step (one-tap on iOS, free Apple Developer account requirement).
2. **Apple Intelligence Foundation Models** — call iOS 26's on-device LLM for polish + lookups to drive API costs to zero on iPhone 15 Pro+.
3. **TestFlight distribution** — pay the $99/yr to ship to friends without weekly USB re-signing.
4. **Home-screen widget + Live Activities** — drill count in the Dynamic Island.
5. **Speech recognition for drills** — say the answer out loud instead of typing.
6. **Production analytics** — instrument card retention curves so I can measure whether Lexicon actually beats Anki for retention.

---

## Acknowledgments

- **Stanford CS 153** — the framing of "the one-person frontier lab" pushed the scope I was willing to attempt.
- **SuperMemo / Anki** for the SM-2 spaced-repetition algorithm used in the Vocabulary module.
- **Recall.ai** for popularizing the "chat with your knowledge" framing.
- **Anthropic Claude Code** for being the most capable pair-programming partner I've ever used.
- **Railway** for $5/mo "it just works" deploy.
- **sqlite-vec** by Alex Garcia for making vector search a one-line dependency.

---

## License

MIT.
