const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    process.env[key] = val;
  }
}

const { syncFromNotion } = require('./notion-sync');
const { syncFromAppleNotes } = require('./apple-notes-sync');

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'idiom-quiz.db');

// Notion page IDs to sync (Word List + subpages)
const NOTION_PAGE_IDS = (process.env.NOTION_PAGE_IDS || '6c5f0587-e35c-4c01-9b38-c42ba9f4a230').split(',').map(s => s.trim());

// Apple Notes names to sync
const APPLE_NOTES_NAMES = (process.env.APPLE_NOTES_NAMES || 'List,Words,Second List,2026 words').split(',').map(s => s.trim());

const ALLOWED_MODELS = new Set([
  'gpt-4o-mini', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4', 'gpt-5.4-pro'
]);
const DEFAULT_MODEL = 'gpt-5.4-mini';
function pickModel(body) {
  return (body && body.model && ALLOWED_MODELS.has(body.model)) ? body.model : DEFAULT_MODEL;
}

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY not set. Add it to .env file.');
  process.exit(1);
}

if (!NOTION_TOKEN) {
  console.warn('WARNING: NOTION_TOKEN not set. Live Notion sync will be unavailable. Add it to .env file.');
}

// Ensure DB directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec(`
CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);
const selectAppStateStmt = db.prepare('SELECT value FROM app_state WHERE key = ?');
const upsertAppStateStmt = db.prepare(`
INSERT INTO app_state (key, value, updated_at)
VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
  value = excluded.value,
  updated_at = excluded.updated_at
`);

const server = http.createServer(async (req, res) => {
  // CORS headers (for local dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // API endpoint
  if (req.method === 'POST' && req.url === '/api/evaluate') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { phrase, meaning, userAnswer } = _body;

        if (!phrase || !meaning || !userAnswer) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields: phrase, meaning, userAnswer' }));
          return;
        }

        const result = await callOpenAI(phrase, meaning, userAnswer, pickModel(_body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('Evaluation error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Notion cards import
  if (req.method === 'GET' && req.url === '/api/notion-cards') {
    const cardsPath = path.join(__dirname, 'notion-cards.json');
    try {
      const data = fs.readFileSync(cardsPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'notion-cards.json not found. Run: node import-notion.js' }));
    }
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', hasApiKey: !!OPENAI_API_KEY, hasNotionToken: !!NOTION_TOKEN }));
    return;
  }

  // Persistent deck storage (SQLite)
  if (req.method === 'GET' && req.url === '/api/cards') {
    try {
      const cards = loadCardsFromDb();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cards }));
    } catch (err) {
      console.error('Load cards error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'PUT' && req.url === '/api/cards') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (!Array.isArray(parsed.cards)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required field: cards (array)' }));
          return;
        }

        const cards = sanitizeCards(parsed.cards);
        saveCardsToDb(cards);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, count: cards.length }));
      } catch (err) {
        console.error('Save cards error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Daily session sync (GET / PUT)
  if (req.url === '/api/daily-session') {
    if (req.method === 'GET') {
      try {
        const row = selectAppStateStmt.get('daily_session');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(row ? row.value : 'null');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const session = JSON.parse(body || 'null');
          upsertAppStateStmt.run('daily_session', JSON.stringify(session), new Date().toISOString());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  // Daily completions sync (GET / PUT)
  if (req.url === '/api/daily-completions') {
    if (req.method === 'GET') {
      try {
        const row = selectAppStateStmt.get('daily_completions');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(row ? row.value : '[]');
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }
    if (req.method === 'PUT') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try {
          const completions = JSON.parse(body || '[]');
          upsertAppStateStmt.run('daily_completions', JSON.stringify(completions), new Date().toISOString());
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }
  }

  // Notion live sync — fetches from Notion API, parses, backfills, saves
  if (req.method === 'POST' && req.url === '/api/sync-notion') {
    if (!NOTION_TOKEN) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'NOTION_TOKEN not configured. Add it to your .env file.' }));
      return;
    }

    try {
      console.log('Starting Notion sync...');
      const entries = await syncFromNotion(NOTION_TOKEN, OPENAI_API_KEY, NOTION_PAGE_IDS, (msg) => {
        console.log(`  [sync] ${msg}`);
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: entries.length, cards: entries }));
    } catch (err) {
      console.error('Notion sync error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Apple Notes live sync
  if (req.method === 'POST' && req.url === '/api/sync-apple') {
    try {
      console.log('Starting Apple Notes sync...');
      const entries = await syncFromAppleNotes(OPENAI_API_KEY, APPLE_NOTES_NAMES, (msg) => {
        console.log(`  [apple-sync] ${msg}`);
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, count: entries.length, cards: entries }));
    } catch (err) {
      console.error('Apple Notes sync error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // Apple Notes cached cards
  if (req.method === 'GET' && req.url === '/api/apple-cards') {
    const cardsPath = path.join(__dirname, 'apple-cards.json');
    try {
      const data = fs.readFileSync(cardsPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'apple-cards.json not found. Sync from Apple Notes first.' }));
    }
    return;
  }

  // Generate example sentence on-the-fly
  if (req.method === 'POST' && req.url === '/api/generate-example') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { phrase, meaning } = _body;
        if (!phrase) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing phrase' }));
          return;
        }

        const example = await generateExample(phrase, meaning || '', pickModel(_body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ example }));
      } catch (err) {
        console.error('Example generation error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Generate fill-in-the-blank sentence
  if (req.method === 'POST' && req.url === '/api/generate-blank') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body2 = JSON.parse(body);
        const { phrase, meaning, blankInstruction } = _body2;
        if (!phrase) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing phrase' }));
          return;
        }

        const result = await generateBlankSentence(phrase, meaning || '', pickModel(_body2), blankInstruction || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('Blank generation error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Generate progressive hints for fill-in-the-blank (no AI needed)
  if (req.method === 'POST' && req.url === '/api/blank-hint') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { phrase, hintLevel, category } = JSON.parse(body);
        if (!phrase) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing phrase' }));
          return;
        }

        const hint = generateBlankHint(phrase, hintLevel || 1, category);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(hint));
      } catch (err) {
        console.error('Hint generation error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Evaluate fill-in-the-blank answer
  if (req.method === 'POST' && req.url === '/api/evaluate-blank') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { phrase, meaning, sentence, expectedAnswer, userAnswer } = _body;
        if (!phrase || !userAnswer) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields' }));
          return;
        }

        const result = await evaluateBlankAnswer(
          phrase,
          meaning || '',
          sentence || '',
          expectedAnswer || phrase,
          userAnswer,
          pickModel(_body)
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error('Blank evaluation error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Refine card: re-interpret a word/phrase based on user feedback
  if (req.method === 'POST' && req.url === '/api/refine-card') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { phrase, currentMeaning, feedback } = _body;
        if (!phrase || !feedback) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields: phrase, feedback' }));
          return;
        }

        const _model = pickModel(_body);
        const payload = JSON.stringify({
          model: _model,
          temperature: 0.3,
          max_completion_tokens: 500,
          messages: [
            {
              role: 'system',
              content: `You help refine vocabulary flashcards. The user has a flashcard for an English word/phrase but wants to change how it's defined or used. Based on their feedback, provide an updated definition and example that matches their intended meaning.

Respond with a JSON object with exactly: "meaning" (1-2 sentence definition matching the user's intent), "example" (natural example sentence using the word in the way the user wants), "category" (one of "idiom", "word", or "phrase").

Only output valid JSON, nothing else.`
            },
            {
              role: 'user',
              content: `Word/phrase: "${phrase}"
Current meaning: "${currentMeaning || 'none'}"
User feedback: "${feedback}"

Please redefine this card according to the user's feedback.`
            }
          ]
        });

        const https = require('https');
        const result = await new Promise((resolve, reject) => {
          const options = {
            hostname: 'api.openai.com',
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${OPENAI_API_KEY}`,
              'Content-Length': Buffer.byteLength(payload),
            },
          };
          const apiReq = https.request(options, (apiRes) => {
            let data = '';
            apiRes.on('data', chunk => { data += chunk; });
            apiRes.on('end', () => {
              if (apiRes.statusCode !== 200) {
                reject(new Error(`OpenAI API error: ${apiRes.statusCode} — ${data}`));
                return;
              }
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices[0].message.content.trim();
                const jsonStr = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
                resolve(JSON.parse(jsonStr));
              } catch (e) {
                reject(new Error('Failed to parse refine response'));
              }
            });
          });
          apiReq.on('error', reject);
          apiReq.write(payload);
          apiReq.end();
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          meaning: result.meaning || '',
          example: result.example || '',
          category: result.category || 'word'
        }));
      } catch (err) {
        console.error('Refine card error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Batch enrich: takes a list of words/phrases, returns meanings, examples, categories
  if (req.method === 'POST' && req.url === '/api/batch-enrich') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { phrases } = _body;
        if (!Array.isArray(phrases) || phrases.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required field: phrases (non-empty array)' }));
          return;
        }

        const _model = pickModel(_body);
        // Process in batches of 10
        const BATCH_SIZE = 10;
        const results = [];
        for (let i = 0; i < phrases.length; i += BATCH_SIZE) {
          const batch = phrases.slice(i, i + BATCH_SIZE);
          const batchResults = await enrichBatch(batch, _model);
          results.push(...batchResults);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ results }));
      } catch (err) {
        console.error('Batch enrich error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Reverse lookup: description → matching words/phrases
  if (req.method === 'POST' && req.url === '/api/reverse-lookup') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { description } = _body;
        if (!description) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing description' }));
          return;
        }

        const payload = JSON.stringify({
          model: pickModel(_body),
          messages: [
            {
              role: 'system',
              content: `You are a vocabulary expert. Given a description of a concept or situation, suggest 3-5 English words, idioms, or phrases that best capture that meaning. For each, provide the phrase, its category (word, phrase, or idiom), a concise meaning, and a natural example sentence. Return JSON array: [{"phrase":"...","category":"...","meaning":"...","example":"..."}]`
            },
            {
              role: 'user',
              content: description
            }
          ],
          temperature: 0.8
        });

        const https = require('https');
        const options = {
          hostname: 'api.openai.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Length': Buffer.byteLength(payload),
          },
        };

        const apiReq = https.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `OpenAI API error: ${apiRes.statusCode}` }));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices[0].message.content.trim();
              const jsonStr = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
              const results = JSON.parse(jsonStr);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ results }));
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to parse response' }));
            }
          });
        });

        apiReq.on('error', (err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        apiReq.write(payload);
        apiReq.end();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Chinese → English translate + key phrases endpoint
  if (req.method === 'POST' && req.url === '/api/translate-zh') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { text } = _body;
        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing text' }));
          return;
        }

        const payload = JSON.stringify({
          model: pickModel(_body),
          messages: [
            {
              role: 'system',
              content: `You are a translation and vocabulary expert. The user will provide Chinese text. You must:
1. Translate it into natural, fluent English.
2. Identify 2-5 key English words, idioms, or phrases from the translation that are especially useful vocabulary — words that are expressive, nuanced, or worth learning. Prioritize idioms, phrasal verbs, and advanced vocabulary over common words.
3. For each key phrase, provide its category (word, phrase, or idiom), a concise meaning, and a natural example sentence.

Return JSON:
{
  "translation": "The full English translation",
  "keyPhrases": [
    {"phrase": "...", "category": "word|phrase|idiom", "meaning": "...", "example": "..."}
  ]
}`
            },
            {
              role: 'user',
              content: text
            }
          ],
          temperature: 0.7
        });

        const https = require('https');
        const options = {
          hostname: 'api.openai.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Length': Buffer.byteLength(payload),
          },
        };

        const apiReq = https.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `OpenAI API error: ${apiRes.statusCode}` }));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices[0].message.content.trim();
              const jsonStr = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
              const result = JSON.parse(jsonStr);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to parse response' }));
            }
          });
        });

        apiReq.on('error', (err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        apiReq.write(payload);
        apiReq.end();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Word choice critique endpoint
  if (req.method === 'POST' && req.url === '/api/critique') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { sentence, word } = _body;
        if (!sentence || !word) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing sentence or word' }));
          return;
        }

        const payload = JSON.stringify({
          model: pickModel(_body),
          messages: [
            {
              role: 'system',
              content: `You are an expert English language coach. The user has written a sentence and is unsure whether a specific word is used correctly. Analyze the word in context and respond with JSON:
{
  "verdict": "correct" | "incorrect" | "awkward",
  "explanation": "Brief explanation of why the word works or doesn't work in this context",
  "correctedSentence": "The sentence with the better word choice (only if incorrect/awkward, otherwise same as original)",
  "suggestedWord": "The better word to use (only if incorrect/awkward, otherwise the same word)",
  "alternatives": ["2-3 other words that could also work well here"],
  "originalWordMeaning": "The meaning of the word the user asked about",
  "originalWordExample": "An example sentence where the user's original word WOULD be used correctly and naturally"
}
Be concise but helpful. If the word is correct, acknowledge it and still offer alternatives for variety. Always provide originalWordMeaning and originalWordExample showing proper usage of the queried word.`
            },
            {
              role: 'user',
              content: `Sentence: "${sentence}"\nWord I'm unsure about: "${word}"`
            }
          ],
          temperature: 0.5
        });

        const https = require('https');
        const options = {
          hostname: 'api.openai.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Length': Buffer.byteLength(payload),
          },
        };

        const apiReq = https.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `OpenAI API error: ${apiRes.statusCode}` }));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices[0].message.content.trim();
              const jsonStr = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
              const result = JSON.parse(jsonStr);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to parse response' }));
            }
          });
        });

        apiReq.on('error', (err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        apiReq.write(payload);
        apiReq.end();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Polish sentence endpoint
  if (req.method === 'POST' && req.url === '/api/polish') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { sentence } = _body;
        if (!sentence) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing sentence' }));
          return;
        }

        const payload = JSON.stringify({
          model: pickModel(_body),
          messages: [
            {
              role: 'system',
              content: `You are an expert English writing coach. The user will give you a rough, casual, or awkwardly phrased sentence. Your job is to:
1. Rewrite it into a polished, natural, fluent English sentence that preserves the original meaning and tone (don't make it overly formal unless the context calls for it — aim for clear, confident, natural English).
2. Briefly explain 2-4 key changes you made and why.
3. Identify 1-3 notable words or phrases from your polished version that are good vocabulary to learn.

Return JSON:
{
  "polished": "The refined sentence",
  "changes": [
    {"original": "rough part", "improved": "polished part", "reason": "why this is better"}
  ],
  "keyPhrases": [
    {"phrase": "...", "category": "word|phrase|idiom", "meaning": "...", "example": "..."}
  ]
}`
            },
            {
              role: 'user',
              content: sentence
            }
          ],
          temperature: 0.7
        });

        const https = require('https');
        const options = {
          hostname: 'api.openai.com',
          path: '/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Length': Buffer.byteLength(payload),
          },
        };

        const apiReq = https.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `OpenAI API error: ${apiRes.statusCode}` }));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices[0].message.content.trim();
              const jsonStr = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
              const result = JSON.parse(jsonStr);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to parse response' }));
            }
          });
        });

        apiReq.on('error', (err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        apiReq.write(payload);
        apiReq.end();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // TTS endpoint
  if (req.method === 'POST' && req.url === '/api/tts') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        if (!text) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing text' }));
          return;
        }

        const https = require('https');
        const payload = JSON.stringify({
          model: 'tts-1',
          input: text,
          voice: 'nova',
          response_format: 'mp3',
          speed: 0.7
        });

        const options = {
          hostname: 'api.openai.com',
          path: '/v1/audio/speech',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Length': Buffer.byteLength(payload),
          },
        };

        const apiReq = https.request(options, (apiRes) => {
          if (apiRes.statusCode !== 200) {
            let errData = '';
            apiRes.on('data', chunk => { errData += chunk; });
            apiRes.on('end', () => {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `TTS API error: ${apiRes.statusCode}` }));
            });
            return;
          }
          // Buffer the full response before sending to avoid partial audio playback
          const chunks = [];
          apiRes.on('data', chunk => { chunks.push(chunk); });
          apiRes.on('end', () => {
            const buffer = Buffer.concat(chunks);
            res.writeHead(200, {
              'Content-Type': 'audio/mpeg',
              'Content-Length': buffer.length
            });
            res.end(buffer);
          });
        });

        apiReq.on('error', (err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        apiReq.write(payload);
        apiReq.end();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Serve static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
  };

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

async function callOpenAI(phrase, correctMeaning, userAnswer, model) {
  const payload = JSON.stringify({
    model: model || DEFAULT_MODEL,
    temperature: 0.3,
    max_completion_tokens: 200,
    messages: [
      {
        role: 'system',
        content: `You evaluate whether a user correctly used an English idiom, word, or phrase in an example sentence they wrote. Check that:
1. The phrase/word is used in the sentence (or a reasonable conjugation/variation of it)
2. It's used correctly in context with the right meaning
3. The sentence is grammatically reasonable

Be lenient — the sentence doesn't need to be perfect, just demonstrate they understand how to use the phrase correctly in context.

Respond in JSON with exactly these fields:
- "verdict": one of "correct", "partial", or "incorrect"
- "explanation": 1-2 sentences of feedback. If correct, briefly affirm their usage. If partial, say what could be improved. If incorrect, explain the correct usage and give a brief example.

Only output valid JSON, nothing else.`
      },
      {
        role: 'user',
        content: `Phrase: "${phrase}"\nCorrect meaning: "${correctMeaning}"\nUser's example sentence: "${userAnswer}"`
      }
    ]
  });

  const https = require('https');

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => { data += chunk; });
      apiRes.on('end', () => {
        if (apiRes.statusCode !== 200) {
          reject(new Error(`OpenAI API error: ${apiRes.statusCode} — ${data}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices[0].message.content.trim();
          const jsonStr = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
          resolve(JSON.parse(jsonStr));
        } catch (e) {
          reject(new Error('Failed to parse OpenAI response'));
        }
      });
    });

    apiReq.on('error', reject);
    apiReq.write(payload);
    apiReq.end();
  });
}

async function generateExample(phrase, meaning, model) {
  const payload = JSON.stringify({
    model: model || DEFAULT_MODEL,
    temperature: 1.2,
    max_completion_tokens: 100,
    messages: [
      {
        role: 'system',
        content: `Write one short, natural example sentence using the given English word, phrase, or idiom. The sentence should clearly demonstrate the meaning in context. Be creative — vary the setting, characters, and tone each time (e.g. workplace, travel, relationships, sports, cooking, history). Avoid generic or cliché constructions. Output ONLY the sentence, nothing else.`
      },
      {
        role: 'user',
        content: meaning
          ? `Phrase: "${phrase}"\nMeaning: "${meaning}"`
          : `Phrase: "${phrase}"`
      }
    ]
  });

  const https = require('https');

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => { data += chunk; });
      apiRes.on('end', () => {
        if (apiRes.statusCode !== 200) {
          reject(new Error(`OpenAI API error: ${apiRes.statusCode} — ${data}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const sentence = parsed.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
          resolve(sentence);
        } catch (e) {
          reject(new Error('Failed to parse OpenAI response'));
        }
      });
    });

    apiReq.on('error', reject);
    apiReq.write(payload);
    apiReq.end();
  });
}

// Generate a fill-in-the-blank sentence
async function generateBlankSentence(phrase, meaning, model, blankInstruction) {
  const blankRules = blankInstruction
    ? `IMPORTANT — The user has specified how to blank this phrase: "${blankInstruction}". Follow their instruction exactly for what to hide/show.`
    : `Rules for choosing what to blank:
- For multi-word phrases, usually blank only the key content word(s), not all words
- Never blank only function words (e.g. "the", "a", "and", "in", "on", "to")
- Keep it challenging but fair; avoid giveaways where almost the whole phrase is visible`;

  const payload = JSON.stringify({
    model: model || DEFAULT_MODEL,
    temperature: 0.7,
    max_completion_tokens: 200,
    messages: [
      {
        role: 'system',
        content: `You create fill-in-the-blank exercises for English vocabulary learning.

Given a phrase and meaning, generate:
1. A natural sentence using the exact phrase in context (do not change phrase wording)
2. The exact missing answer text to blank from that phrase
3. A short meaning/intention hint

${blankRules}
- The answer must be a contiguous part of the original phrase text

Respond in JSON with exactly these fields:
- "sentence": full sentence containing the exact phrase (not blanked)
- "answer": exact text to blank from that phrase
- "hint": short meaning/intention clue

Only output valid JSON, nothing else.`
      },
      {
        role: 'user',
        content: `Phrase: "${phrase}"\nMeaning: "${meaning}"`
      }
    ]
  });

  const https = require('https');

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => { data += chunk; });
      apiRes.on('end', () => {
        if (apiRes.statusCode !== 200) {
          reject(new Error(`OpenAI API error: ${apiRes.statusCode} — ${data}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices[0].message.content.trim();
          const jsonStr = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
          const result = JSON.parse(jsonStr);
          const fullSentence = (result.sentence || '').trim();
          let answer = (result.answer || '').trim();
          const hint = (result.hint || '').trim();

          // If model misses fields or picks low-info answers, fall back to local blanking.
          const fallback = buildContentWordBlank(phrase);
          const normalizedAnswer = normalizeToken(answer);
          const normalizedPhrase = phrase.trim().toLowerCase().replace(/\s+/g, ' ');
          const normalizedAnswerPhrase = answer.trim().toLowerCase().replace(/\s+/g, ' ');
          // When user has a blankInstruction, trust the model's answer — skip safety guards
          const hasUserBlankPref = !!blankInstruction;
          const isWholePhraseForMultiWord = !hasUserBlankPref &&
            phrase.trim().split(/\s+/).length > 1 &&
            normalizedAnswerPhrase === normalizedPhrase;
          const isLowInfoSingleWord = !hasUserBlankPref &&
            answer.split(/\s+/).length === 1 &&
            NON_BLANKABLE_FALLBACK.has(normalizedAnswer);

          let blankSpec = null;
          if (answer && !isLowInfoSingleWord && !isWholePhraseForMultiWord) {
            blankSpec = buildBlankFromAnswerInPhrase(phrase, answer);
          }

          if (!blankSpec) {
            blankSpec = fallback;
          }
          answer = blankSpec.answer;

          let sentenceWithBlank = '';
          if (!fullSentence) {
            sentenceWithBlank = blankSpec.blankedPhrase;
          } else if (sentenceContainsPhrase(fullSentence, phrase)) {
            sentenceWithBlank = replacePhraseInSentence(fullSentence, phrase, blankSpec.blankedPhrase);
          } else {
            const replacedByAnswer = replaceTextInSentence(fullSentence, answer, '_____');
            sentenceWithBlank = replacedByAnswer !== fullSentence
              ? replacedByAnswer
              : `${fullSentence} (${blankSpec.blankedPhrase})`;
          }

          if (!/_____/.test(sentenceWithBlank)) sentenceWithBlank += ' _____';

          const answerCategory = answer.split(/\s+/).length > 1 ? 'phrase' : 'word';
          resolve({
            sentence: sentenceWithBlank,
            fullSentence: fullSentence || '',
            hint,
            answer,
            answerCategory
          });
        } catch (e) {
          reject(new Error('Failed to parse OpenAI response'));
        }
      });
    });

    apiReq.on('error', reject);
    apiReq.write(payload);
    apiReq.end();
  });
}

const FUNCTION_WORDS = new Set([
  'a', 'an', 'the', 'some', 'any', 'this', 'that', 'these', 'those',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'in', 'on', 'at', 'by', 'for', 'from', 'to', 'of', 'with', 'without',
  'into', 'onto', 'over', 'under', 'as',
  'and', 'or', 'but', 'if', 'than', 'then', 'so', 'very', 'just',
  // Light carrier words that often should stay visible in phrase context.
  'way', 'thing', 'stuff', 'kind', 'sort', 'part', 'point'
]);

const NON_BLANKABLE_FALLBACK = new Set([
  'a', 'an', 'the', 'some', 'any', 'this', 'that', 'these', 'those',
  'my', 'your', 'his', 'her', 'its', 'our', 'their',
  'in', 'on', 'at', 'by', 'for', 'from', 'to', 'of', 'with', 'without',
  'into', 'onto', 'over', 'under', 'as',
  'and', 'or', 'but', 'if', 'than', 'then', 'so'
]);

function normalizeToken(word) {
  return (word || '').toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
}

function pickContentIndexes(words) {
  const content = [];
  for (let i = 0; i < words.length; i++) {
    const normalized = normalizeToken(words[i]);
    if (!normalized) continue;
    if (!FUNCTION_WORDS.has(normalized)) {
      content.push(i);
    }
  }

  if (content.length > 0) {
    // If a token repeats (e.g. "up ... up"), blank only first occurrence.
    const unique = [];
    const seen = new Set();
    for (const idx of content) {
      const token = normalizeToken(words[idx]);
      if (seen.has(token)) continue;
      seen.add(token);
      unique.push(idx);
    }
    return unique;
  }

  // Fallback: avoid blanking obvious glue words like "the", "and", "in".
  const candidates = [];
  for (let i = 0; i < words.length; i++) {
    const token = normalizeToken(words[i]);
    if (!token) continue;
    if (!NON_BLANKABLE_FALLBACK.has(token)) {
      candidates.push(i);
    }
  }

  const pool = candidates.length > 0 ? candidates : words.map((_, i) => i);
  let longestIdx = 0;
  let longestLen = 0;
  for (const i of pool) {
    const len = normalizeToken(words[i]).length;
    if (len > longestLen) {
      longestLen = len;
      longestIdx = i;
    }
  }
  return [longestIdx];
}

function splitToken(word) {
  const leading = (word.match(/^[^A-Za-z0-9]*/) || [''])[0];
  const trailing = (word.match(/[^A-Za-z0-9]*$/) || [''])[0];
  const core = word.slice(leading.length, word.length - trailing.length);
  return { leading, core, trailing };
}

function collapseSpanToBlank(words, start, end) {
  const first = splitToken(words[start]);
  const last = splitToken(words[end]);
  const blankToken = `${first.leading}_____${last.trailing}`;
  const answer = words
    .slice(start, end + 1)
    .map(w => splitToken(w).core)
    .filter(Boolean)
    .join(' ');

  const blankedWords = [
    ...words.slice(0, start),
    blankToken,
    ...words.slice(end + 1)
  ];

  return {
    blankedPhrase: blankedWords.join(' '),
    answer: answer || words.slice(start, end + 1).join(' ')
  };
}

function findRepeatedConjunctionSpan(words) {
  for (let i = 0; i <= words.length - 3; i++) {
    const a = normalizeToken(words[i]);
    const mid = normalizeToken(words[i + 1]);
    const c = normalizeToken(words[i + 2]);
    if (!a || !mid || !c) continue;
    if ((mid === 'and' || mid === 'or') && a === c) {
      return { start: i, end: i + 2 };
    }
  }
  return null;
}

function buildContentWordBlank(phrase) {
  const words = phrase.trim().split(/\s+/);
  if (words.length === 1) {
    return { blankedPhrase: '_____', answer: words[0] };
  }

  // Pattern like "up and up" => blank as one unit to avoid giveaway.
  const repeatedSpan = findRepeatedConjunctionSpan(words);
  if (repeatedSpan) {
    return collapseSpanToBlank(words, repeatedSpan.start, repeatedSpan.end);
  }

  const contentIndexes = new Set(pickContentIndexes(words));

  // Find the span from first to last content word and collapse to a single blank
  const contentIdxList = [...contentIndexes].sort((a, b) => a - b);
  if (contentIdxList.length === 0) {
    // Fallback: blank entire phrase
    return { blankedPhrase: '_____', answer: phrase.trim() };
  }
  const spanStart = contentIdxList[0];
  const spanEnd = contentIdxList[contentIdxList.length - 1];
  return collapseSpanToBlank(words, spanStart, spanEnd);
}

function findAnswerSpanInPhraseWords(phraseWords, answerWords) {
  if (answerWords.length === 0 || answerWords.length > phraseWords.length) return null;
  const normalizedPhrase = phraseWords.map(normalizeToken);
  const normalizedAnswer = answerWords.map(normalizeToken);

  for (let start = 0; start <= phraseWords.length - answerWords.length; start++) {
    let ok = true;
    for (let i = 0; i < answerWords.length; i++) {
      if (!normalizedAnswer[i] || normalizedPhrase[start + i] !== normalizedAnswer[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { start, end: start + answerWords.length - 1 };
  }
  return null;
}

function buildBlankFromAnswerInPhrase(phrase, answer) {
  const phraseWords = phrase.trim().split(/\s+/);
  const answerWords = answer.trim().split(/\s+/);
  const span = findAnswerSpanInPhraseWords(phraseWords, answerWords);
  if (!span) return null;
  return collapseSpanToBlank(phraseWords, span.start, span.end);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Build a regex that matches the phrase even when the first word is conjugated
// e.g. "beat around the bush" also matches "beating around the bush", "beats around the bush"
function buildInflectedPhrasePattern(phrase) {
  const words = phrase.trim().split(/\s+/);
  if (words.length === 0) return new RegExp(escapeRegex(phrase), 'i');
  // Allow the first word to have common verb suffixes: -s, -es, -ed, -ing, -en, -d
  // Also handle e-dropping (e.g. "make" → "making") by making trailing 'e' optional
  const base = words[0].replace(/e$/i, '');
  const firstWordPattern = escapeRegex(base) + 'e?' + '(?:s|es|ed|d|ing|en|ting)?';
  const rest = words.slice(1).map(escapeRegex).join('\\s+');
  const full = rest ? firstWordPattern + '\\s+' + rest : firstWordPattern;
  return new RegExp(full, 'i');
}

function sentenceContainsPhrase(sentence, phrase) {
  const safeSentence = (sentence || '').trim();
  if (!safeSentence) return false;

  const exactPattern = new RegExp(escapeRegex(phrase), 'i');
  if (exactPattern.test(safeSentence)) return true;

  const flexiblePattern = new RegExp(
    phrase.trim().split(/\s+/).map(escapeRegex).join('\\s+'),
    'i'
  );
  if (flexiblePattern.test(safeSentence)) return true;

  // Try with verb inflection on first word
  return buildInflectedPhrasePattern(phrase).test(safeSentence);
}

function replaceTextInSentence(sentence, text, replacement) {
  const safeSentence = (sentence || '').trim();
  const target = (text || '').trim();
  if (!safeSentence || !target) return safeSentence;

  const exactPattern = new RegExp(escapeRegex(target), 'i');
  if (exactPattern.test(safeSentence)) {
    return safeSentence.replace(exactPattern, replacement);
  }

  const flexiblePattern = new RegExp(
    target.split(/\s+/).map(escapeRegex).join('\\s+'),
    'i'
  );
  if (flexiblePattern.test(safeSentence)) {
    return safeSentence.replace(flexiblePattern, replacement);
  }

  return safeSentence;
}

function replacePhraseInSentence(sentence, phrase, replacement) {
  const safeSentence = (sentence || '').trim();
  if (!safeSentence) return replacement;

  const exactPattern = new RegExp(escapeRegex(phrase), 'i');
  if (exactPattern.test(safeSentence)) {
    return safeSentence.replace(exactPattern, replacement);
  }

  // Fallback: allow flexible whitespace between phrase tokens.
  const flexiblePattern = new RegExp(
    phrase.trim().split(/\s+/).map(escapeRegex).join('\\s+'),
    'i'
  );
  if (flexiblePattern.test(safeSentence)) {
    return safeSentence.replace(flexiblePattern, replacement);
  }

  // Try with verb inflection on first word (e.g. "beat" → "beating")
  const inflectedPattern = buildInflectedPhrasePattern(phrase);
  if (inflectedPattern.test(safeSentence)) {
    return safeSentence.replace(inflectedPattern, replacement);
  }

  // Last resort: append a blank form so user can still answer.
  return `${safeSentence} (${replacement})`;
}

// Generate progressive hints (no AI needed — pure string manipulation)
function generateBlankHint(phrase, hintLevel, category) {
  const words = phrase.split(/\s+/);
  const cat = (category || '').toLowerCase();
  const isMultiWord = (cat === 'idiom' || cat === 'phrase') && words.length > 1;

  if (isMultiWord) {
    // For idioms/phrases: each hint reveals one more word
    const maxLevel = words.length;
    const level = Math.min(Math.max(1, hintLevel), maxLevel);
    const revealed = words.slice(0, level).join(' ');
    const hint = level < words.length ? `${revealed} ...` : revealed;
    return { hint, level, maxLevel };
  }

  // For single words: 3 progressive hints
  const level = Math.min(Math.max(1, hintLevel), 3);

  if (level === 1) {
    const firstLetter = phrase.charAt(0).toUpperCase();
    return {
      hint: `Starts with "${firstLetter}", ${phrase.length} letters total`,
      level: 1,
      maxLevel: 3
    };
  }

  if (level === 2) {
    const pattern = words.map(w => w[0] + '_'.repeat(w.length - 1)).join(' ');
    return { hint: pattern, level: 2, maxLevel: 3 };
  }

  // Level 3: reveal roughly half the letters
  const pattern = words.map(w => {
    const chars = w.split('');
    const revealCount = Math.ceil(chars.length / 2);
    return chars.map((ch, i) => i < revealCount ? ch : '_').join('');
  }).join(' ');

  return { hint: pattern, level: 3, maxLevel: 3 };
}

// Evaluate fill-in-the-blank answer
async function evaluateBlankAnswer(phrase, meaning, sentence, expectedAnswer, userAnswer, model) {
  const payload = JSON.stringify({
    model: model || DEFAULT_MODEL,
    temperature: 0.3,
    max_completion_tokens: 200,
    messages: [
      {
        role: 'system',
        content: `You evaluate a fill-in-the-blank answer for an English vocabulary exercise. The user was given a sentence with a blank and needs to fill in the expected missing word(s).

Compare the user's answer to the expected answer. Be lenient with:
- Minor spelling variations
- Capitalization differences
- Reasonable inflections/word-form changes when meaning is clearly the same

But the answer should essentially match the expected missing word(s), while staying consistent with the full phrase context.

Respond in JSON with exactly these fields:
- "verdict": one of "correct", "partial", or "incorrect"
- "explanation": 1-2 sentences of feedback. If correct, affirm. If partial, explain what's close. If incorrect, reveal the correct answer.

Only output valid JSON, nothing else.`
      },
      {
        role: 'user',
        content: `Full phrase: "${phrase}"\nExpected answer for blank: "${expectedAnswer}"\nMeaning: "${meaning}"\nSentence with blank: "${sentence}"\nUser's answer: "${userAnswer}"`
      }
    ]
  });

  const https = require('https');

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => { data += chunk; });
      apiRes.on('end', () => {
        if (apiRes.statusCode !== 200) {
          reject(new Error(`OpenAI API error: ${apiRes.statusCode} — ${data}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices[0].message.content.trim();
          const jsonStr = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
          resolve(JSON.parse(jsonStr));
        } catch (e) {
          reject(new Error('Failed to parse OpenAI response'));
        }
      });
    });

    apiReq.on('error', reject);
    apiReq.write(payload);
    apiReq.end();
  });
}

function loadCardsFromDb() {
  const row = selectAppStateStmt.get('cards');
  if (!row || !row.value) return [];

  const parsed = JSON.parse(row.value);
  return Array.isArray(parsed) ? parsed : [];
}

function sanitizeCards(cards) {
  return cards
    .filter(card => card && typeof card === 'object')
    .map(card => ({ ...card }))
    .filter(card => typeof card.phrase === 'string' && card.phrase.trim().length > 0)
    .map(card => ({ ...card, phrase: card.phrase.trim() }));
}

function saveCardsToDb(cards) {
  upsertAppStateStmt.run('cards', JSON.stringify(cards), new Date().toISOString());
}

async function enrichBatch(phrases, model) {
  const numbered = phrases.map((p, i) => `${i + 1}. ${p}`).join('\n');
  const payload = JSON.stringify({
    model: model || DEFAULT_MODEL,
    temperature: 0.3,
    max_completion_tokens: 2000,
    messages: [
      {
        role: 'system',
        content: `You enrich English vocabulary entries. For each word/phrase given, provide:
1. "meaning": a clear, concise definition (1-2 sentences)
2. "example": a natural example sentence using it in context
3. "category": one of "idiom", "word", or "phrase"
   - "idiom" = figurative expression whose meaning isn't obvious from the words (e.g. "break the ice", "under the weather")
   - "phrase" = multi-word expression that isn't an idiom (e.g. "pros and cons", "take into account")
   - "word" = single word or compound word (e.g. "ubiquitous", "shortchange")
4. "isIdiomatic": true if this is a recognized, commonly-used English word, idiom, or established expression. false if it's not a real phrase, is a malapropism, a garbled/made-up expression, or a near-miss of a real phrase (e.g. "blessing in the skies" → false, "break the freeze" → false)
5. "suggestions": if isIdiomatic is false, provide 2-4 real English words, idioms, or phrases the user might have been thinking of. Empty array [] if isIdiomatic is true.

Respond with a JSON array in the same order as the input. Each element must have exactly: "phrase", "meaning", "example", "category", "isIdiomatic", "suggestions".

Only output valid JSON, nothing else.`
      },
      {
        role: 'user',
        content: numbered
      }
    ]
  });

  const https = require('https');

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const apiReq = https.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => { data += chunk; });
      apiRes.on('end', () => {
        if (apiRes.statusCode !== 200) {
          reject(new Error(`OpenAI API error: ${apiRes.statusCode} — ${data}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices[0].message.content.trim();
          const jsonStr = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
          const results = JSON.parse(jsonStr);
          // Ensure we return the original phrase text even if the model tweaks it
          resolve(results.map((r, i) => ({
            phrase: phrases[i],
            meaning: r.meaning || '',
            example: r.example || '',
            category: r.category || 'word',
            isIdiomatic: r.isIdiomatic !== false,
            suggestions: Array.isArray(r.suggestions) ? r.suggestions : []
          })));
        } catch (e) {
          reject(new Error('Failed to parse OpenAI response for batch enrich'));
        }
      });
    });

    apiReq.on('error', reject);
    apiReq.write(payload);
    apiReq.end();
  });
}

server.listen(PORT, () => {
  console.log(`Idiom Quiz running at http://localhost:${PORT}`);
});
