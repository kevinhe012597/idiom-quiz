const http = require('http');
const fs = require('fs');
const path = require('path');

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

const server = http.createServer(async (req, res) => {
  // CORS headers (for local dev)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
        const { phrase, meaning, sentence, userAnswer } = JSON.parse(body);
        if (!phrase || !userAnswer) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required fields' }));
          return;
        }

        const result = await evaluateBlankAnswer(phrase, meaning || '', sentence || '', userAnswer);
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
        content: `You create fill-in-the-blank exercises for English vocabulary learning. Given a phrase/word and its meaning, generate:
1. A natural sentence that uses the phrase, with the phrase replaced by "_____"
2. A short hint describing the intention or meaning the speaker wants to convey (not the phrase itself, but what they're trying to express)

Respond in JSON with exactly these fields:
- "sentence": the sentence with "_____" where the phrase belongs
- "hint": a short description of what the speaker is trying to express (e.g. "wanting to say something happens very rarely" for "once in a blue moon")

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
          result.answer = phrase; // The correct answer is always the phrase
          resolve(result);
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
async function evaluateBlankAnswer(phrase, meaning, sentence, userAnswer) {
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    max_tokens: 200,
    messages: [
      {
        role: 'system',
        content: `You evaluate a fill-in-the-blank answer for an English vocabulary exercise. The user was given a sentence with a blank and needs to fill in the correct word or phrase.

Compare the user's answer to the correct phrase. Be lenient with:
- Minor spelling variations
- Capitalization differences
- Reasonable conjugations or tense changes (e.g. "broke the ice" for "break the ice")

But the answer should essentially be the same phrase or a very close variation.

Respond in JSON with exactly these fields:
- "verdict": one of "correct", "partial", or "incorrect"
- "explanation": 1-2 sentences of feedback. If correct, affirm. If partial, explain what's close. If incorrect, reveal the correct answer.

Only output valid JSON, nothing else.`
      },
      {
        role: 'user',
        content: `Correct phrase: "${phrase}"\nMeaning: "${meaning}"\nSentence with blank: "${sentence}"\nUser's answer: "${userAnswer}"`
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

server.listen(PORT, () => {
  console.log(`Idiom Quiz running at http://localhost:${PORT}`);
});
