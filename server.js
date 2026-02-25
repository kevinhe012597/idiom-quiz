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
const DB_PATH = path.join(__dirname, 'idiom-quiz.db');

// Notion page IDs to sync (Word List + subpages)
const NOTION_PAGE_IDS = (process.env.NOTION_PAGE_IDS || '6c5f0587-e35c-4c01-9b38-c42ba9f4a230').split(',').map(s => s.trim());

// Apple Notes names to sync
const APPLE_NOTES_NAMES = (process.env.APPLE_NOTES_NAMES || 'List,Words,Second List,2026 words').split(',').map(s => s.trim());

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY not set. Add it to .env file.');
  process.exit(1);
}

if (!NOTION_TOKEN) {
  console.warn('WARNING: NOTION_TOKEN not set. Live Notion sync will be unavailable. Add it to .env file.');
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
        const { phrase, meaning, userAnswer } = JSON.parse(body);

        if (!phrase || !meaning || !userAnswer) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields: phrase, meaning, userAnswer' }));
          return;
        }

        const result = await callOpenAI(phrase, meaning, userAnswer);
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
        const { phrase, meaning } = JSON.parse(body);
        if (!phrase) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing phrase' }));
          return;
        }

        const example = await generateExample(phrase, meaning || '');
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
        const { phrase, meaning } = JSON.parse(body);
        if (!phrase) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing phrase' }));
          return;
        }

        const result = await generateBlankSentence(phrase, meaning || '');
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
        const { phrase, meaning, sentence, expectedAnswer, userAnswer } = JSON.parse(body);
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
          userAnswer
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

async function callOpenAI(phrase, correctMeaning, userAnswer) {
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    max_tokens: 200,
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

async function generateExample(phrase, meaning) {
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    temperature: 0.7,
    max_tokens: 100,
    messages: [
      {
        role: 'system',
        content: `Write one short, natural example sentence using the given English word, phrase, or idiom. The sentence should clearly demonstrate the meaning in context. Output ONLY the sentence, nothing else.`
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
async function generateBlankSentence(phrase, meaning) {
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    temperature: 0.7,
    max_tokens: 200,
    messages: [
      {
        role: 'system',
        content: `You create fill-in-the-blank exercises for English vocabulary learning.

Given a phrase and meaning, generate:
1. A natural sentence using the exact phrase in context (do not change phrase wording)
2. The exact missing answer text to blank from that phrase
3. A short meaning/intention hint

Rules for choosing what to blank:
- For multi-word phrases, usually blank only the key content word(s), not all words
- Never blank only function words (e.g. "the", "a", "and", "in", "on", "to")
- Keep it challenging but fair; avoid giveaways where almost the whole phrase is visible
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
          const isWholePhraseForMultiWord =
            phrase.trim().split(/\s+/).length > 1 &&
            normalizedAnswerPhrase === normalizedPhrase;
          const isLowInfoSingleWord =
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
  const answerWords = [];

  const blankedWords = words.map((word, idx) => {
    if (!contentIndexes.has(idx)) return word;

    const { leading, core, trailing } = splitToken(word);
    answerWords.push(core || word);
    return `${leading}_____${trailing}`;
  });

  return {
    blankedPhrase: blankedWords.join(' '),
    answer: answerWords.join(' ')
  };
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

function sentenceContainsPhrase(sentence, phrase) {
  const safeSentence = (sentence || '').trim();
  if (!safeSentence) return false;

  const exactPattern = new RegExp(escapeRegex(phrase), 'i');
  if (exactPattern.test(safeSentence)) return true;

  const flexiblePattern = new RegExp(
    phrase.trim().split(/\s+/).map(escapeRegex).join('\\s+'),
    'i'
  );
  return flexiblePattern.test(safeSentence);
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
async function evaluateBlankAnswer(phrase, meaning, sentence, expectedAnswer, userAnswer) {
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    max_tokens: 200,
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

server.listen(PORT, () => {
  console.log(`Idiom Quiz running at http://localhost:${PORT}`);
});
