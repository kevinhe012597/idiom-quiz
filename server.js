const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const mammoth = require('mammoth');

// Helper: convert docx base64 to plain text via mammoth
async function docxToText(base64Data) {
  const buffer = Buffer.from(base64Data, 'base64');
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

// Check if a media type is docx (not PDF)
function isDocx(mediaType) {
  return mediaType && mediaType !== 'application/pdf';
}

// ─── Concept-extraction skills (loaded from skills.md) ───────────────────
// Single source of truth for ALL concept-creation prompts. Edit skills.md and
// restart the server to roll out rule changes across every endpoint.
const SKILLS_MD_PATH = path.join(__dirname, 'skills.md');
let SKILLS_MD = '';
try {
  SKILLS_MD = fs.readFileSync(SKILLS_MD_PATH, 'utf-8');
  console.log(`Loaded ${SKILLS_MD.length} chars of skills from skills.md`);
} catch (err) {
  console.error('WARNING: skills.md not found — concept prompts will be missing rules!', err.message);
}

// Extract a section of skills.md by H2 heading.
// Matches "## Name" (anchored at line start via leading newline) and returns
// everything up to the next H2 or end-of-file, trimmed. Case-insensitive.
function skillSection(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, 'i');
  const m = SKILLS_MD.match(re);
  return m ? m[1].trim() : '';
}

// Compose a "## Header\n<content>" block for a list of skill section names.
// Skips any sections that don't exist (returns empty for those).
function skillsBlock(names) {
  return names
    .map(n => {
      const body = skillSection(n);
      return body ? `## ${n}\n${body}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

// Build a "## Existing Tags" block to inject into prompts. The Tags rule in
// skills.md instructs the model to ONLY pick from this list (no invention).
// If the list is empty, returns an empty string so the prompt falls back to
// the "suggest 1 broad topic tag" branch.
function existingTagsBlock(existingTags) {
  const tags = Array.isArray(existingTags) ? existingTags.filter(t => typeof t === 'string' && t.trim()) : [];
  if (tags.length === 0) return '';
  return `## Existing Tags (the user's current tag taxonomy — pick from these ONLY)\n${tags.map(t => `- ${t}`).join('\n')}\n\nIf none of these fit the card, return an empty array \`[]\` — do NOT invent a new tag.`;
}

// ─── Gemini YouTube analyzer ─────────────────────────────────────────────
// Calls Gemini with a YouTube URL and returns a rich text "transcript-plus"
// (timestamps, speaker attribution, visual context) that the existing concept
// extraction pipeline can chew on. We use Gemini ONLY to convert video → text;
// the actual card synthesis still goes through Claude + skills.md so the
// extraction rules stay in one place.
async function analyzeYoutubeWithGemini(youtubeUrl, guidance) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY not configured on server');
  }
  const model = 'gemini-3-flash-preview';
  const prompt = `Produce a detailed analysis of this YouTube video that another AI model can use to extract flashcard concepts. Format as plain text with these sections:

# VIDEO METADATA
- Title (from intro / on-screen / context)
- Speaker(s) and their role/affiliation if identifiable
- Approximate duration / topic

# RICH TRANSCRIPT
A timestamped transcript of what was said. Use [HH:MM:SS] markers every ~30 seconds. Attribute speakers by name when known (e.g. "Scott:") or by role ("Interviewer:", "Audience question:"). Preserve numbers, names, dates, and direct quotes verbatim — those are what the downstream model will mine.

# VISUAL CONTEXT
Briefly note anything important shown on screen that's not captured in audio: slides, charts, diagrams, demos, on-screen text, visible products, etc. Skip generic visuals.

# KEY THEMES
3-6 bullet points capturing the central thesis or argument of the talk. These help the downstream model identify the SPINE of the content before mining individual cards.

${guidance ? `# USER FOCUS AREA\nThe user specifically cares about: "${guidance}". Spend extra detail on anything related to this in the transcript.\n\n` : ''}Be thorough — the downstream model will create flashcards from your output, so don't skip details that seem minor. Aim for completeness over brevity.`;

  const payload = JSON.stringify({
    contents: [{
      parts: [
        { file_data: { file_uri: youtubeUrl } },
        { text: prompt }
      ]
    }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 32000 }
  });

  const https = require('https');
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/${model}:generateContent`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error('Gemini YouTube error:', res.statusCode, data.slice(0, 500));
          let errMsg = `Gemini API error (${res.statusCode})`;
          try {
            const parsed = JSON.parse(data);
            if (parsed.error?.message) errMsg = parsed.error.message;
          } catch {}
          reject(new Error(errMsg));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const text = parsed.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim();
          if (!text) throw new Error('Empty Gemini response');
          resolve(text);
        } catch (e) {
          console.error('Gemini parse error:', e.message);
          reject(new Error('Failed to parse Gemini response'));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

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

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FIREWORKS_API_KEY = process.env.FIREWORKS_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'idiom-quiz.db');

// ─── Model routing ────────────────────────────────────────────────────────
const FIREWORKS_MODELS = new Set([
  'accounts/fireworks/models/llama4-scout-instruct-basic',
  'accounts/fireworks/models/llama4-maverick-instruct-basic',
  'accounts/fireworks/models/deepseek-v3',
  'accounts/fireworks/models/qwen3-30b-a3b',
]);

const ANTHROPIC_MODELS = new Set([
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);

const OPENAI_MODELS = new Set([
  'gpt-4o-mini', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-5.4', 'gpt-5.4-pro'
]);

const ALLOWED_MODELS = new Set([...OPENAI_MODELS, ...FIREWORKS_MODELS, ...ANTHROPIC_MODELS]);
const DEFAULT_MODEL = 'gpt-5.4-mini';

function pickModel(body) {
  return (body && body.model && ALLOWED_MODELS.has(body.model)) ? body.model : DEFAULT_MODEL;
}

// For Anthropic-direct endpoints (extract-concepts, extract-concepts-more,
// regen-concept) that bypass the OpenAI-compatible compatHttps layer because
// they use document inputs / native Anthropic features. Returns the user's
// selected Anthropic model if they picked one; otherwise Sonnet (fast default).
// Power users can opt into Opus via the dropdown for max quality.
const ANTHROPIC_DEFAULT_FAST = 'claude-sonnet-4-6';
function pickAnthropicModel(body) {
  const m = body && body.model;
  if (m && ANTHROPIC_MODELS.has(m)) return m;
  return ANTHROPIC_DEFAULT_FAST;
}

// ─── Text-to-speech request builders ──────────────────────────────────────
// ElevenLabs is the primary provider — better pronunciation of idioms,
// loan words, names. Voice "Rachel" (default) is clear and natural.
// Free tier = 10K chars/month, Starter ($5) = 30K, Creator ($22) = 100K.
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel
const ELEVENLABS_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_turbo_v2_5'; // fast + good quality

function buildElevenLabsTTSRequest(text) {
  const payload = JSON.stringify({
    text,
    model_id: ELEVENLABS_MODEL_ID,
    voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
    output_format: 'mp3_44100_128',
  });
  return {
    providerName: 'ElevenLabs',
    payload,
    requestOptions: {
      hostname: 'api.elevenlabs.io',
      path: `/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=mp3_44100_128`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': ELEVENLABS_API_KEY,
        'Accept': 'audio/mpeg',
        'Content-Length': Buffer.byteLength(payload),
      },
    },
  };
}

function buildOpenAITTSRequest(text) {
  const payload = JSON.stringify({
    model: 'tts-1',
    input: text,
    voice: 'nova',
    response_format: 'mp3',
    speed: 0.7,
  });
  return {
    providerName: 'OpenAI',
    payload,
    requestOptions: {
      hostname: 'api.openai.com',
      path: '/v1/audio/speech',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    },
  };
}

// ─── Background extraction job queue ──────────────────────────────────────
// In-memory map of long-running extraction jobs. Lets the client kick off
// an extraction, navigate away, and poll for completion later. Sufficient
// for single-instance Railway deployment; can promote to SQLite if we ever
// need persistence across restarts or multi-instance deployment.
const extractionJobs = new Map();
// Auto-clean jobs older than 1 hour
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of extractionJobs.entries()) {
    if ((job.completedAt || job.startedAt) < cutoff) extractionJobs.delete(id);
  }
}, 5 * 60 * 1000);

function generateJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Async core of /api/extract-concepts. Takes a parsed body, returns a Promise
// resolving to { results, suggestedSource }. Used by both the synchronous
// endpoint and the background-job endpoint.
async function runExtractConcepts(_body) {
  const startTs = Date.now();
  let { text, guidance, docBase64, docType, cardCount, youtubeUrl, existingTags } = _body;
  const usedModel = pickAnthropicModel(_body);
  let usedGemini = false;

  // YouTube URL: have Gemini analyze the video, then run the resulting
  // rich text through the normal extraction pipeline below.
  if (youtubeUrl && typeof youtubeUrl === 'string' && youtubeUrl.trim()) {
    usedGemini = true;
    const geminiText = await analyzeYoutubeWithGemini(youtubeUrl.trim(), guidance);
    text = geminiText;
    docBase64 = null;
    docType = null;
  }

  if (!docBase64 && (!text || text.trim().length < 20)) {
    throw new Error('Text too short — paste an article, upload a file, or add a YouTube URL');
  }

  const trimmed = text ? (text.length > 24000 ? text.slice(0, 24000) + '\n[truncated]' : text) : '';
  // parsedText is the canonical text representation we used (or null for raw
  // PDFs which are sent straight to Anthropic). Returned to the client so
  // it can cache the parse and regen with a different cardCount without
  // re-running Gemini or refetching/re-parsing source files.
  let parsedText = trimmed || null;

  const guidanceBlock = guidance
    ? `\n\n## USER'S FOCUS AREA\nThe user specifically cares about: "${guidance}"\nThis MUST shape your extraction:\n- At least half of the extracted items should directly relate to this focus area\n- Go deeper on these topics — extract more granular facts, specific numbers, named entities\n- Still include a few other notable items from the text, but the user's focus area takes clear priority`
    : '';

  const cardCountClause = cardCount
    ? `\n\nExtract EXACTLY ${cardCount} cards. Override the default count guidance.`
    : '';

  const systemPrompt = `You extract memorable knowledge from articles, transcripts, and notes for a flashcard study app.${guidanceBlock}

Read the text and identify the most interesting and worth-remembering items: key concepts, companies, people, specific facts/figures/trends, and non-obvious strategic insights.

You return a JSON OBJECT with two top-level fields:
1. "suggestedSource": A short descriptive label for what this source IS (see Source Inference below).
2. "results": An array of card objects matching the Card Structure below.

${skillsBlock([
  'Card Structure', 'Bullet Format', 'TL;DR First Bullet', 'Self-Explanatory Titles',
  'Tags', 'Beyond-the-Basics Depth', 'Entity-Specific Required Coverage',
  'Source Inference', 'Card Density', 'Speaker Attribution', 'Output',
])}

${existingTagsBlock(existingTags)}${cardCountClause}`;

  const docInstruction = guidance
    ? `Extract key concepts from this document. Focus especially on: ${guidance}`
    : 'Extract key concepts from this document.';
  let userContent;
  if (docBase64) {
    if (isDocx(docType)) {
      const docText = await docxToText(docBase64);
      userContent = `Document content:\n${docText}\n\n${docInstruction}`;
      parsedText = docText; // Cache extracted DOCX text for future regens
    } else {
      userContent = [
        { type: 'document', source: { type: 'base64', media_type: docType || 'application/pdf', data: docBase64 } },
        { type: 'text', text: docInstruction }
      ];
      // parsedText stays null for raw PDFs — client falls back to docBase64 on regen
    }
  } else {
    userContent = trimmed;
  }

  const extractTool = {
    name: 'save_extracted_concepts',
    description: 'Save the concept cards extracted from the article/transcript.',
    input_schema: {
      type: 'object',
      properties: {
        suggestedSource: { type: 'string' },
        results: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              points: { type: 'array', items: { type: 'string' } },
              tags: { type: 'array', items: { type: 'string' } }
            },
            required: ['title', 'points', 'tags']
          }
        }
      },
      required: ['suggestedSource', 'results']
    }
  };

  const payload = JSON.stringify({
    model: usedModel,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: 8000,
    tools: [extractTool],
    tool_choice: { type: 'tool', name: 'save_extracted_concepts' }
  });

  const https = require('https');
  return new Promise((resolve, reject) => {
    const apiReq = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => { data += chunk; });
      apiRes.on('end', () => {
        if (apiRes.statusCode !== 200) {
          console.error('Claude extract error:', apiRes.statusCode, data.slice(0, 500));
          reject(new Error(`Claude API error (${apiRes.statusCode})`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const toolUse = (parsed.content || []).find(b => b.type === 'tool_use');
          let out;
          if (toolUse && toolUse.input) {
            out = toolUse.input;
          } else {
            const textBlock = (parsed.content || []).find(b => b.type === 'text');
            const content = (textBlock?.text || '').trim();
            const jsonStr = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
            out = JSON.parse(jsonStr);
          }
          let results, suggestedSource;
          if (Array.isArray(out)) {
            results = out;
            suggestedSource = '';
          } else if (out && Array.isArray(out.results)) {
            results = out.results;
            suggestedSource = typeof out.suggestedSource === 'string' ? out.suggestedSource : '';
          } else {
            results = [out];
            suggestedSource = '';
          }
          resolve({
            results,
            suggestedSource,
            model: usedModel,
            usedGemini,
            elapsedMs: Date.now() - startTs,
            parsedText, // Lets the client regen with a different cardCount without re-fetching/re-parsing the source
          });
        } catch (e) {
          reject(new Error('Failed to parse extracted concepts: ' + e.message));
        }
      });
    });
    apiReq.on('error', reject);
    apiReq.write(payload);
    apiReq.end();
  });
}

// Returns { hostname, path, apiKey, provider } for a given model
function getProvider(model) {
  if (ANTHROPIC_MODELS.has(model)) {
    return {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      apiKey: ANTHROPIC_API_KEY,
      provider: 'anthropic'
    };
  }
  if (FIREWORKS_MODELS.has(model)) {
    return {
      hostname: 'api.fireworks.ai',
      path: '/inference/v1/chat/completions',
      apiKey: FIREWORKS_API_KEY,
      provider: 'fireworks'
    };
  }
  return {
    hostname: 'api.openai.com',
    path: '/v1/chat/completions',
    apiKey: OPENAI_API_KEY,
    provider: 'openai'
  };
}

// Translate an OpenAI-format chat completion payload string into Anthropic Messages API format
// Note: temperature is intentionally dropped — Claude Opus 4.7 deprecated it, and other Claude
// models accept defaults that work well across our use cases.
function translateToAnthropic(payloadStr) {
  const oai = JSON.parse(payloadStr);
  const systemMsgs = (oai.messages || []).filter(m => m.role === 'system');
  const otherMsgs = (oai.messages || []).filter(m => m.role !== 'system');
  const anthropic = {
    model: oai.model,
    max_tokens: oai.max_completion_tokens || oai.max_tokens || 4000,
    ...(systemMsgs.length && { system: systemMsgs.map(m => m.content).join('\n\n') }),
    messages: otherMsgs.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
  };
  return JSON.stringify(anthropic);
}

// Translate an Anthropic Messages API response back into OpenAI chat completion format
function translateFromAnthropic(rawDataStr) {
  try {
    const ar = JSON.parse(rawDataStr);
    if (ar.error) return rawDataStr; // pass through errors
    const text = (ar.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    return JSON.stringify({
      id: ar.id,
      choices: [{ message: { role: 'assistant', content: text }, finish_reason: ar.stop_reason || 'stop', index: 0 }],
      usage: ar.usage,
      model: ar.model,
    });
  } catch {
    return rawDataStr;
  }
}

// Build https.request options + body from a payload string (auto-detects provider from model)
function buildRequestOptions(payload) {
  let model = DEFAULT_MODEL;
  try { model = JSON.parse(payload).model || DEFAULT_MODEL; } catch {}
  const prov = getProvider(model);
  let body = payload;
  let headers;
  if (prov.provider === 'anthropic') {
    body = translateToAnthropic(payload);
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': prov.apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body),
    };
  } else {
    headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${prov.apiKey}`,
      'Content-Length': Buffer.byteLength(body),
    };
  }
  const options = {
    hostname: prov.hostname,
    path: prov.path,
    method: 'POST',
    headers,
  };
  // Attach helpers for callers to use the translated body and translate the response
  options._body = body;
  options._isAnthropic = prov.provider === 'anthropic';
  return options;
}

// Transparent wrapper around https.request. Translates Anthropic responses
// to OpenAI chat-completion format on the fly, AND automatically swaps the
// outbound body to Anthropic format when writing. Drop-in replacement for
// https.request — call sites do not need to know which provider they hit.
const compatHttps = {
  request(options, callback) {
    const https = require('https');
    const isAnthropic = options.hostname === 'api.anthropic.com';
    const translatedBody = options._body; // attached by buildRequestOptions
    const realReq = https.request(options, (apiRes) => {
      if (!isAnthropic) { callback(apiRes); return; }
      let buf = '';
      apiRes.on('data', chunk => { buf += chunk; });
      apiRes.on('end', () => {
        const { EventEmitter } = require('events');
        const synth = new EventEmitter();
        synth.statusCode = apiRes.statusCode;
        synth.headers = apiRes.headers;
        callback(synth);
        const out = apiRes.statusCode === 200 ? translateFromAnthropic(buf) : buf;
        synth.emit('data', out);
        synth.emit('end');
      });
    });
    if (isAnthropic && translatedBody) {
      // Patch write() so callers passing the original OpenAI-format payload
      // automatically send the translated Anthropic-format body.
      const origWrite = realReq.write.bind(realReq);
      realReq.write = function(_chunk) {
        return origWrite(translatedBody);
      };
    }
    return realReq;
  }
};

// Generic chat completion helper — works with OpenAI, Fireworks, and Anthropic
function chatCompletion(model, messages, opts = {}) {
  const payload = JSON.stringify({
    model,
    messages,
    ...(opts.temperature !== undefined && { temperature: opts.temperature }),
    ...(opts.max_tokens && { max_completion_tokens: opts.max_tokens }),
    ...(opts.response_format && { response_format: opts.response_format }),
  });

  return new Promise((resolve, reject) => {
    const options = buildRequestOptions(payload);
    const apiReq = compatHttps.request(options, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => { data += chunk; });
      apiRes.on('end', () => {
        if (apiRes.statusCode !== 200) {
          reject(new Error(`${options.hostname} API error: ${apiRes.statusCode} — ${data}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(new Error('Failed to parse API response'));
        }
      });
    });
    apiReq.on('error', reject);
    apiReq.write(payload);
    apiReq.end();
  });
}

if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY not set. Add it to .env file.');
  process.exit(1);
}

if (!FIREWORKS_API_KEY) {
  console.warn('WARNING: FIREWORKS_API_KEY not set. Open-source models will be unavailable.');
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

  // Health check
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', hasApiKey: !!OPENAI_API_KEY }));
    return;
  }

  // ─── Concepts storage (SQLite) ─────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/concepts') {
    try {
      const row = selectAppStateStmt.get('concepts');
      const concepts = row && row.value ? JSON.parse(row.value) : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ concepts: Array.isArray(concepts) ? concepts : [] }));
    } catch (err) {
      console.error('Load concepts error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'PUT' && req.url === '/api/concepts') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        if (!Array.isArray(parsed.concepts)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing required field: concepts (array)' }));
          return;
        }
        const concepts = parsed.concepts
          .filter(c => c && typeof c === 'object' && typeof c.title === 'string' && c.title.trim().length > 0)
          .map(c => ({ ...c, title: c.title.trim() }));
        upsertAppStateStmt.run('concepts', JSON.stringify(concepts), new Date().toISOString());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, count: concepts.length }));
      } catch (err) {
        console.error('Save concepts error:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ─── Scratchpad (single string) ──────────────────────────────────────────
  if (req.method === 'GET' && req.url === '/api/scratchpad') {
    try {
      const row = selectAppStateStmt.get('scratchpad');
      const text = row && row.value ? row.value : '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ text }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'PUT' && req.url === '/api/scratchpad') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const text = typeof parsed.text === 'string' ? parsed.text : '';
        upsertAppStateStmt.run('scratchpad', text, new Date().toISOString());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ─── Lookup usage counters (object of key→count) ─────────────────────────
  if (req.method === 'GET' && req.url === '/api/lookup-usage') {
    try {
      const row = selectAppStateStmt.get('lookup_usage');
      const usage = row && row.value ? JSON.parse(row.value) : {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ usage: typeof usage === 'object' && usage !== null ? usage : {} }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === 'PUT' && req.url === '/api/lookup-usage') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body || '{}');
        const usage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : {};
        upsertAppStateStmt.run('lookup_usage', JSON.stringify(usage), new Date().toISOString());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Concept lookup (AI-powered)
  if (req.method === 'POST' && req.url === '/api/concept-lookup') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { query, appendMode, existingBullets, existingTags } = _body;
        if (!query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing query' }));
          return;
        }

        // Concept lookup uses OpenAI's Responses API + web_search_preview, which
        // is OpenAI-only. Force an OpenAI model regardless of the user's selection.
        const lookupModel = OPENAI_MODELS.has(pickModel(_body)) ? pickModel(_body) : DEFAULT_MODEL;

        // APPEND MODE: user wants to ADD bullets without dropping existing ones.
        // We tell the model: here's what's already saved; generate ONLY new bullets
        // that don't duplicate, no TL;DR, no bullet count cap.
        const existingList = (Array.isArray(existingBullets) && existingBullets.length > 0)
          ? existingBullets.map((b, i) => `${i + 1}. ${b}`).join('\n')
          : '';

        const instructions = appendMode
          ? `You are adding NEW bullets to an existing flashcard concept. The user already has the bullets listed below — generate ADDITIONAL bullets that complement them WITHOUT duplicating any fact, angle, or framing already covered.

Return JSON: { title (echo the existing concept), points (NEW bullets only), tags (1-3 if relevant) }

Existing bullets (DO NOT REPEAT THESE):
${existingList || '(none provided)'}

Use web search aggressively for fresh, specific details. Cite numbers, names, dates. Don't guess.

${skillsBlock([
  'Card Structure',
  'Bullet Format',
  'Self-Explanatory Titles',
  'Tags',
  'Beyond-the-Basics Depth',
  'Entity-Specific Required Coverage',
  'Append Mode',
  'Output',
])}

${existingTagsBlock(existingTags)}`
          : `You are a knowledgeable research assistant. Given a concept name, topic, company, technology, or description, return a structured explanation optimized for memorization and recall.

Return JSON matching the Card Structure: { title, points, tags }.

Use web search aggressively for the latest specifics, opinions, and color. Don't guess; search.

${skillsBlock([
  'Card Structure',
  'Bullet Format',
  'TL;DR First Bullet',
  'Self-Explanatory Titles',
  'Tags',
  'Beyond-the-Basics Depth',
  'Entity-Specific Required Coverage',
  'Output',
])}

${existingTagsBlock(existingTags)}`;

        const payload = JSON.stringify({
          model: lookupModel,
          instructions,
          input: query,
          tools: [{ type: 'web_search_preview' }],
          temperature: 0.5
        });

        const https = require('https');
        const options = {
          hostname: 'api.openai.com',
          path: '/v1/responses',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'Content-Length': Buffer.byteLength(payload),
          },
        };

        const apiReq = compatHttps.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'OpenAI API error' }));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              // Responses API: extract text from output array
              let content = '';
              for (const item of parsed.output) {
                if (item.type === 'message' && item.content) {
                  for (const block of item.content) {
                    if (block.type === 'output_text') content += block.text;
                  }
                }
              }
              content = content.trim();
              const jsonStr = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
              const result = JSON.parse(jsonStr);
              result._model = lookupModel;
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

  // Follow-up chat
  if (req.method === 'POST' && req.url === '/api/followup-chat') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { context, history, mode } = _body;
        if (!context || !history || history.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing context or question' }));
          return;
        }

        // Web search is ALWAYS available — Claude decides when to use it.
        // Encourage it for time-sensitive or factual questions but don't force it.
        const webSearchClause = '\n\nYou have access to a web_search tool. USE IT WHENEVER the question touches on anything that could have changed since training: current events, today\'s status, latest news, recent prices/valuations/funding, statistics, quotes, public sentiment. For purely conceptual or definitional questions, answer directly without searching. When you do search, cite the sources inline.';

        const styleClause = '\n\nFormatting: write naturally as a knowledgeable friend would — no bullet lists or headers unless the answer truly demands them. Markdown is supported (**bold**, *italic*, `code`, [links](url)). Keep answers tight (3-6 sentences) unless more depth is genuinely needed.';

        const systemPrompt = mode === 'concept'
          ? `You are a knowledgeable tutor helping a student learn about a concept. Use specific facts, numbers, and names when relevant.${webSearchClause}${styleClause}\n\nContext:\n${context}`
          : `You are a vocabulary tutor helping a student master English words and phrases. Give examples, explain nuances, and clarify usage.${webSearchClause}${styleClause}\n\nContext:\n${context}`;

        const claudeMessages = history.map(h => ({ role: h.role, content: h.content }));

        const payloadObj = {
          model: 'claude-opus-4-20250514',
          system: systemPrompt,
          messages: claudeMessages,
          max_tokens: 1500,  // generous budget so search results + answer fit
          tools: [{ type: 'web_search_20250305', name: 'web_search' }]
        };
        const payload = JSON.stringify(payloadObj);

        const https = require('https');
        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(payload),
          },
        };

        // Use raw https.request — this endpoint speaks Anthropic format natively
        // and parses Claude's content blocks directly. With web search, the response
        // can contain multiple blocks (text + server_tool_use + web_search_tool_result + text).
        // We concatenate ALL text blocks because the model often splits the answer
        // around search calls — taking only the last block strips the opening.
        const apiReq = https.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              console.error('followup-chat Claude error:', apiRes.statusCode, data);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              try {
                const errParsed = JSON.parse(data);
                res.end(JSON.stringify({ error: errParsed.error?.message || 'Claude API error' }));
              } catch {
                res.end(JSON.stringify({ error: `Claude API error (${apiRes.statusCode})` }));
              }
              return;
            }
            try {
              const parsed = JSON.parse(data);
              // Concatenate all text blocks. Joins with a space so adjacent blocks
              // don't smush together if the model wrote separate sentences.
              const textParts = [];
              for (const block of (parsed.content || [])) {
                if (block.type === 'text' && block.text) textParts.push(block.text.trim());
              }
              const answer = textParts.filter(Boolean).join(' ').trim();
              if (!answer) throw new Error('Empty response');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ answer }));
            } catch (e) {
              console.error('followup-chat parse error:', e.message, data.slice(0, 500));
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

  // Concept batch enrich
  if (req.method === 'POST' && req.url === '/api/concept-enrich') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { concepts: conceptList, existingTags } = _body;
        if (!Array.isArray(conceptList) || conceptList.length === 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing concepts array' }));
          return;
        }

        const numbered = conceptList.map((c, i) => `${i + 1}. ${c}`).join('\n');
        const payload = JSON.stringify({
          model: pickModel(_body),
          messages: [
            {
              role: 'system',
              content: `You enrich knowledge concepts for a flashcard app. For each concept given, return one card object matching the Card Structure below.

Return a JSON ARRAY in the same order as the input.

${skillsBlock([
  'Card Structure',
  'Bullet Format',
  'TL;DR First Bullet',
  'Self-Explanatory Titles',
  'Tags',
  'Beyond-the-Basics Depth',
  'Entity-Specific Required Coverage',
  'Output',
])}

${existingTagsBlock(existingTags)}`
            },
            {
              role: 'user',
              content: numbered
            }
          ],
          temperature: 0.3
        });

        const https = require('https');
        const options = buildRequestOptions(payload);

        const apiReq = compatHttps.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'OpenAI API error' }));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices[0].message.content.trim();
              const jsonStr = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
              const results = JSON.parse(jsonStr);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ results: Array.isArray(results) ? results : [results] }));
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

  // Fetch + extract article body from a URL (Mozilla Readability)
  if (req.method === 'POST' && req.url === '/api/fetch-article') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      try {
        const { url } = JSON.parse(body);
        if (!url || typeof url !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing url' }));
          return;
        }
        let parsedUrl;
        try { parsedUrl = new URL(url); } catch (_) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid URL' }));
          return;
        }
        if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Only http(s) URLs allowed' }));
          return;
        }
        if (/(?:^|\.)(youtube\.com|youtu\.be)$/i.test(parsedUrl.hostname)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'YouTube URLs — use the YouTube tab instead' }));
          return;
        }

        // Fetch with browser-like headers + 12s timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000);
        let resp;
        try {
          resp = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
          });
        } catch (e) {
          clearTimeout(timeoutId);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.name === 'AbortError' ? 'Request timed out' : ('Fetch failed: ' + e.message) }));
          return;
        }
        clearTimeout(timeoutId);

        if (!resp.ok) {
          // 401/403/429 strongly suggest paywall or rate-limit
          const status = resp.status;
          const isPaywall = status === 401 || status === 402 || status === 403 || status === 429;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: `Server returned HTTP ${status}`,
            paywalled: isPaywall,
            paywallReason: isPaywall ? `Site returned HTTP ${status} — likely paywalled or bot-blocked` : undefined,
          }));
          return;
        }

        const ctype = resp.headers.get('content-type') || '';
        if (!/text\/html|application\/xhtml/i.test(ctype)) {
          res.writeHead(415, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Unsupported content-type: ${ctype}` }));
          return;
        }

        const html = await resp.text();
        const finalUrl = resp.url || url;

        // Run Readability
        const { JSDOM } = require('jsdom');
        const { Readability } = require('@mozilla/readability');
        const dom = new JSDOM(html, { url: finalUrl });
        const article = new Readability(dom.window.document).parse();
        const title = article?.title || dom.window.document.title || '';
        const text = (article?.textContent || '').trim();
        const excerpt = (article?.excerpt || '').trim();
        const byline = (article?.byline || '').trim();
        const siteName = (article?.siteName || '').trim();
        const length = text.length;

        // Paywall heuristics
        const PAYWALL_HOSTS = [
          'nytimes.com','wsj.com','ft.com','bloomberg.com','economist.com',
          'theinformation.com','newyorker.com','wired.com','theatlantic.com',
          'washingtonpost.com','barrons.com','foreignaffairs.com','hbr.org',
          'medium.com','seekingalpha.com','stratechery.com','restofworld.org',
        ];
        const hostMatchesPaywall = PAYWALL_HOSTS.some(h => parsedUrl.hostname.endsWith(h));
        const PAYWALL_PHRASES = [
          'subscribe to read', 'subscribers only', 'subscriber-only',
          'log in to continue', 'sign in to continue reading',
          'this article is for subscribers', 'create a free account to continue',
          'become a subscriber', 'subscribe now to keep reading',
          'subscribe to keep reading', 'paid subscribers only',
          'access this story', 'unlock this article', 'unlock the full',
        ];
        const lowerText = text.toLowerCase();
        const lowerHtml = html.toLowerCase();
        const phraseHit = PAYWALL_PHRASES.find(p => lowerText.includes(p) || lowerHtml.includes(p));
        const tooShort = length > 0 && length < 600;
        const empty = length === 0;

        let paywalled = false;
        let paywallReason = '';
        if (empty) {
          paywalled = true;
          paywallReason = 'No article body could be extracted — likely paywalled, JS-rendered, or bot-blocked';
        } else if (phraseHit) {
          paywalled = true;
          paywallReason = `Paywall phrase detected: "${phraseHit}"`;
        } else if (tooShort && hostMatchesPaywall) {
          paywalled = true;
          paywallReason = `Only ${length} chars extracted from a typically-paywalled site (${parsedUrl.hostname}) — likely truncated`;
        } else if (tooShort) {
          paywalled = true;
          paywallReason = `Only ${length} chars extracted — article body looks truncated`;
        }

        // Suggested source label
        let suggestedSource = '';
        const pubName = siteName || parsedUrl.hostname.replace(/^www\./, '');
        if (title && pubName) suggestedSource = `${pubName}: ${title}`.slice(0, 100);
        else if (title) suggestedSource = title.slice(0, 100);
        else if (pubName) suggestedSource = pubName;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          url: finalUrl,
          title, text, excerpt, byline, siteName,
          length,
          paywalled,
          paywallReason: paywalled ? paywallReason : undefined,
          suggestedSource,
        }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Extract concepts from article/transcript text — synchronous (waits for completion)
  if (req.method === 'POST' && req.url === '/api/extract-concepts') {
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 30 * 1024 * 1024) { tooLarge = true; req.destroy(); }
    });
    req.on('end', async () => {
      if (tooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File too large — max 30MB' }));
        return;
      }
      try {
        const _body = JSON.parse(body);
        const result = await runExtractConcepts(_body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Start an extraction in the background — returns jobId immediately so the
  // client can navigate away and poll for completion later.
  if (req.method === 'POST' && req.url === '/api/extract-concepts/start') {
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 30 * 1024 * 1024) { tooLarge = true; req.destroy(); }
    });
    req.on('end', () => {
      if (tooLarge) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File too large — max 30MB' }));
        return;
      }
      let _body;
      try { _body = JSON.parse(body); }
      catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Bad JSON' })); return; }

      // Create the job up front so the client can poll immediately
      const jobId = generateJobId();
      const sourceHint = _body.youtubeUrl
        ? `YouTube: ${_body.youtubeUrl}`
        : (_body.docBase64 ? 'Uploaded document' : (typeof _body.text === 'string' ? _body.text.slice(0, 60).trim() + (_body.text.length > 60 ? '…' : '') : 'Article'));
      extractionJobs.set(jobId, {
        status: 'running',
        startedAt: Date.now(),
        meta: { sourceHint, kind: _body.youtubeUrl ? 'youtube' : 'article' },
      });

      // Respond immediately with the jobId
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jobId, status: 'running' }));

      // Fire the actual extraction async — store result/error against the jobId
      runExtractConcepts(_body)
        .then(result => {
          const job = extractionJobs.get(jobId);
          if (!job) return; // job was cleaned up
          job.status = 'done';
          job.result = result;
          job.completedAt = Date.now();
        })
        .catch(err => {
          const job = extractionJobs.get(jobId);
          if (!job) return;
          job.status = 'error';
          job.error = err.message;
          job.completedAt = Date.now();
          console.error(`Extraction job ${jobId} failed:`, err.message);
        });
    });
    return;
  }

  // Poll the status of a background extraction job
  if (req.method === 'GET' && req.url.startsWith('/api/extract-concepts/status/')) {
    const jobId = req.url.split('/').pop();
    const job = extractionJobs.get(jobId);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job not found (may have expired)' }));
      return;
    }
    const payload = {
      status: job.status,
      elapsedMs: (job.completedAt || Date.now()) - job.startedAt,
      meta: job.meta,
    };
    if (job.status === 'done') payload.result = job.result;
    if (job.status === 'error') payload.error = job.error;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
    return;
  }

  // List in-flight jobs (for the dashboard widget)
  if (req.method === 'GET' && req.url === '/api/extract-concepts/jobs') {
    const jobs = [];
    for (const [id, job] of extractionJobs.entries()) {
      jobs.push({
        jobId: id,
        status: job.status,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        meta: job.meta,
      });
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jobs }));
    return;
  }

  // Merge multiple concept cards into one — used when the user selects 2+
  // overlapping cards in Browse and wants to consolidate them.
  if (req.method === 'POST' && req.url === '/api/merge-concepts') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { cards, existingTags } = _body;
        if (!Array.isArray(cards) || cards.length < 2) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Need at least 2 cards to merge' }));
          return;
        }

        // Compose the input for the AI: each card's title + bullets + notes
        const cardsText = cards.map((c, i) => {
          const lines = [`### Card ${i + 1}: ${c.title || '(untitled)'}`];
          if (c.tags && c.tags.length) lines.push(`Tags: ${c.tags.join(', ')}`);
          if (c.points && c.points.length) {
            lines.push('Bullets:');
            c.points.forEach(p => lines.push(`- ${p}`));
          } else if (c.summary) {
            lines.push(`Summary: ${c.summary}`);
          }
          if (c.notes) lines.push(`User notes: ${c.notes}`);
          return lines.join('\n');
        }).join('\n\n');

        const systemPrompt = `You are merging multiple concept flashcards that the user believes are about the same topic. Produce ONE consolidated card that:
- Has a single self-explanatory title (pick the best of the inputs, or improve)
- Combines bullets WITHOUT duplicates — when two bullets overlap, keep the more informative version
- Preserves specific facts (numbers, names, dates) from ALL inputs
- Keeps the FIRST bullet as a "TL;DR: " cocktail-party takeaway
- Stays within 5-7 total bullets — synthesize ruthlessly, don't just concatenate
- Combines tags (deduplicated) — pick from existing taxonomy, don't invent new

${skillsBlock([
  'Card Structure',
  'Bullet Format',
  'TL;DR First Bullet',
  'Self-Explanatory Titles',
  'Tags',
  'Beyond-the-Basics Depth',
  'Output',
])}

${existingTagsBlock(existingTags)}`;

        const userContent = `Merge these ${cards.length} cards into one:\n\n${cardsText}`;

        const mergeTool = {
          name: 'save_merged_card',
          description: 'Save the merged concept card.',
          input_schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              points: { type: 'array', items: { type: 'string' } },
              tags: { type: 'array', items: { type: 'string' } }
            },
            required: ['title', 'points', 'tags']
          }
        };

        const payload = JSON.stringify({
          model: pickAnthropicModel(_body),
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
          max_tokens: 4000,
          tools: [mergeTool],
          tool_choice: { type: 'tool', name: 'save_merged_card' }
        });

        const https = require('https');
        const apiReq = https.request({
          hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload) }
        }, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              console.error('merge-concepts error:', apiRes.statusCode, data.slice(0, 500));
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Claude API error' }));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const toolUse = (parsed.content || []).find(b => b.type === 'tool_use' && b.name === 'save_merged_card');
              if (toolUse && toolUse.input) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ merged: toolUse.input }));
                return;
              }
              throw new Error('No tool_use in response');
            } catch (e) {
              console.error('merge-concepts parse error:', e.message);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to parse merge response' }));
            }
          });
        });
        apiReq.on('error', (err) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); });
        apiReq.write(payload);
        apiReq.end();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Regenerate a single concept card
  if (req.method === 'POST' && req.url === '/api/regen-concept') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 30 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { title, currentPoints, instruction, context, useWebSearch, existingTags } = _body;
        if (!title || !instruction) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing title or instruction' }));
          return;
        }

        const webSearchClause = useWebSearch
          ? '\n\nUse web search aggressively for the latest specific facts, numbers, quotes, and color. Do not guess.'
          : '';

        const systemPrompt = `You are regenerating a flashcard about "${title}" for a study app.

Current bullet points:
${(currentPoints || []).map(p => '• ' + p).join('\n')}

The user wants you to regenerate this card with a different angle: "${instruction}"${webSearchClause}

Return a single JSON OBJECT matching the Card Structure below (fields: title, points, tags). The title should stay the same or improve.

${skillsBlock([
  'Card Structure',
  'Bullet Format',
  'TL;DR First Bullet',
  'Self-Explanatory Titles',
  'Tags',
  'Beyond-the-Basics Depth',
  'Entity-Specific Required Coverage',
  'Output',
])}

${existingTagsBlock(existingTags)}

CRITICAL: Your FINAL message must contain ONLY a valid JSON object. No prose, no explanation, no markdown fences. If you searched the web first, put ALL findings into the JSON points.`;

        const https = require('https');

        // Build user content (shared for both modes)
        let userContent;
        if (context?.docBase64) {
          if (isDocx(context.docType)) {
            const docText = await docxToText(context.docBase64);
            userContent = `Source document:\n${docText.slice(0, 8000)}\n\nRegenerate the card about "${title}" with this angle: ${instruction}`;
          } else {
            userContent = [
              { type: 'document', source: { type: 'base64', media_type: context.docType || 'application/pdf', data: context.docBase64 } },
              { type: 'text', text: `Regenerate the card about "${title}" with this angle: ${instruction}` }
            ];
          }
        } else if (context?.text) {
          userContent = `Source article (for reference):\n${context.text.slice(0, 8000)}\n\nRegenerate the card about "${title}" with this angle: ${instruction}`;
        } else {
          userContent = `Regenerate the card about "${title}" with this angle: ${instruction}`;
        }

        // Force structured output via tool_use
        const regenTool = {
          name: 'save_regenerated_card',
          description: 'Save the regenerated concept card.',
          input_schema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              points: { type: 'array', items: { type: 'string' } },
              tags: { type: 'array', items: { type: 'string' } }
            },
            required: ['title', 'points', 'tags']
          }
        };
        const tools = [regenTool];
        if (useWebSearch) tools.push({ type: 'web_search_20250305', name: 'web_search' });
        const payloadObj = {
          model: pickAnthropicModel(_body),
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
          max_tokens: 8000,
          tools,
          // With web search, let the model decide when to call which tool
          // (it'll search first, then save). Without, force the save tool.
          tool_choice: useWebSearch ? { type: 'auto' } : { type: 'tool', name: 'save_regenerated_card' }
        };
        const payload = JSON.stringify(payloadObj);

        const apiReq = https.request({
          hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload) }
        }, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              console.error('regen-concept error:', apiRes.statusCode, data);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Claude API error' }));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              // Look for the structured tool_use response first (preferred path)
              const toolUse = (parsed.content || []).find(b => b.type === 'tool_use' && b.name === 'save_regenerated_card');
              if (toolUse && toolUse.input) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(toolUse.input));
                return;
              }
              // Fallback: parse from text block (in case the model returned text)
              let textContent = '';
              for (const block of parsed.content) {
                if (block.type === 'text') textContent = block.text;
              }
              let content = textContent.trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
              if (!content.startsWith('{')) {
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (jsonMatch) content = jsonMatch[0];
              }
              const result = JSON.parse(content);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (e) {
              console.error('regen-concept parse error:', e.message, data.slice(0, 500));
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to parse response' }));
            }
          });
        });
        apiReq.on('error', (err) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); });
        apiReq.write(payload);
        apiReq.end();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // Extract additional concepts from the same article
  if (req.method === 'POST' && req.url === '/api/extract-concepts-more') {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 30 * 1024 * 1024) req.destroy(); });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { instruction, existingTitles, context, existingTags } = _body;
        if (!instruction) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing instruction' }));
          return;
        }

        const existingList = (existingTitles || []).map(t => `- ${t}`).join('\n');
        const systemPrompt = `You extract ADDITIONAL concept cards from a document for a flashcard study app.

The user already has these cards (DO NOT DUPLICATE):
${existingList}

The user wants MORE cards focused on: "${instruction}"

Return a JSON ARRAY of new card objects matching the Card Structure below.

${skillsBlock([
  'Card Structure',
  'Bullet Format',
  'TL;DR First Bullet',
  'Self-Explanatory Titles',
  'Tags',
  'Beyond-the-Basics Depth',
  'Entity-Specific Required Coverage',
  'Output',
])}

${existingTagsBlock(existingTags)}`;

        let userContent;
        if (context?.docBase64) {
          if (isDocx(context.docType)) {
            const docText = await docxToText(context.docBase64);
            userContent = `Source document:\n${docText.slice(0, 8000)}\n\nExtract additional concepts: ${instruction}`;
          } else {
            userContent = [
              { type: 'document', source: { type: 'base64', media_type: context.docType || 'application/pdf', data: context.docBase64 } },
              { type: 'text', text: `Extract additional concepts: ${instruction}` }
            ];
          }
        } else if (context?.text) {
          userContent = `Source article:\n${context.text.slice(0, 8000)}\n\nExtract additional concepts: ${instruction}`;
        } else {
          userContent = `Extract additional concepts: ${instruction}`;
        }

        // Force structured output via tool_use
        const moreTool = {
          name: 'save_additional_concepts',
          description: 'Save the additional concept cards.',
          input_schema: {
            type: 'object',
            properties: {
              results: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    title: { type: 'string' },
                    points: { type: 'array', items: { type: 'string' } },
                    tags: { type: 'array', items: { type: 'string' } }
                  },
                  required: ['title', 'points', 'tags']
                }
              }
            },
            required: ['results']
          }
        };

        const payload = JSON.stringify({
          model: pickAnthropicModel(_body),
          system: systemPrompt,
          messages: [{ role: 'user', content: userContent }],
          max_tokens: 8000,
          tools: [moreTool],
          tool_choice: { type: 'tool', name: 'save_additional_concepts' }
        });

        const https = require('https');
        const apiReq = https.request({
          hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload) }
        }, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              console.error('extract-more error:', apiRes.statusCode, data);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Claude API error' }));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              // Prefer tool_use response shape
              const toolUse = (parsed.content || []).find(b => b.type === 'tool_use' && b.name === 'save_additional_concepts');
              let results;
              if (toolUse && toolUse.input && Array.isArray(toolUse.input.results)) {
                results = toolUse.input.results;
              } else {
                // Fallback to text parsing
                const textBlock = (parsed.content || []).find(b => b.type === 'text');
                const content = (textBlock?.text || '').trim().replace(/^```json\s*/, '').replace(/\s*```$/, '');
                const out = JSON.parse(content);
                results = Array.isArray(out) ? out : (Array.isArray(out.results) ? out.results : [out]);
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ results }));
            } catch (e) {
              console.error('extract-more parse error:', e.message);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to parse response' }));
            }
          });
        });
        apiReq.on('error', (err) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); });
        apiReq.write(payload);
        apiReq.end();
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
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
          const options = buildRequestOptions(payload);
          const apiReq = compatHttps.request(options, (apiRes) => {
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

  // Extract phrases from handwritten notes image
  if (req.method === 'POST' && req.url === '/api/extract-from-image') {
    const chunks = [];
    req.on('data', chunk => { chunks.push(chunk); });
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks).toString();
        const _body = JSON.parse(body);
        const { image } = _body; // base64 data URL
        if (!image) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing image data' }));
          return;
        }

        // Image extraction needs an OpenAI vision model — force GPT-4o regardless of selection
        const imgModel = OPENAI_MODELS.has(pickModel(_body)) ? pickModel(_body) : 'gpt-4o';
        const payload = JSON.stringify({
          model: imgModel,
          messages: [
            {
              role: 'system',
              content: `You are an expert at reading handwritten notes. The user has uploaded a photo of handwritten notes containing English vocabulary words, idioms, or phrases they want to learn.

Extract every distinct word, phrase, or idiom you can read from the image. The handwriting may be messy or illegible in places — do your best to interpret it. If you're unsure about a word, make your best guess based on context.

Return a JSON array of strings, one per word/phrase found. Only include the raw words/phrases, no definitions or explanations. Deduplicate and clean up capitalization.

Example output: ["break the ice", "eloquent", "beat around the bush", "tenacious"]

Only output valid JSON, nothing else.`
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: 'Extract all vocabulary words and phrases from these handwritten notes:' },
                { type: 'image_url', image_url: { url: image } }
              ]
            }
          ],
          temperature: 0.3,
          max_completion_tokens: 1000
        });

        const https = require('https');
        const options = buildRequestOptions(payload);

        const apiReq = compatHttps.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              console.error('OpenAI vision error:', data);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Vision API error' }));
              return;
            }
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices[0].message.content.trim();
              const jsonStr = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
              const phrases = JSON.parse(jsonStr);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ phrases }));
            } catch (e) {
              console.error('Parse error:', e.message);
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to parse extracted phrases' }));
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
        console.error('Image extract error:', err.message);
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
  // Name-this-vibe: given a quote, exchange, or description of a social dynamic,
  // return words that capture the TONE / DEMEANOR / EMOTIONAL TEXTURE
  // (e.g. "defensive", "dismissive", "passive-aggressive", "earnest", "patronizing").
  // Distinct from /api/reverse-lookup, which targets concepts not affect.
  if (req.method === 'POST' && req.url === '/api/name-vibe') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { description, sentiment } = _body;
        if (!description) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing description' }));
          return;
        }

        // Sentiment bias — slider value mapped to a phrase the model can act on
        const sentimentClause = (() => {
          switch (sentiment) {
            case 'strongly-positive':
              return '\n\nSENTIMENT FILTER: Return ONLY warm, generous, or admiring words (e.g. earnest, magnanimous, gracious, candid, self-effacing). Skip anything ambivalent or critical.';
            case 'lean-positive':
              return '\n\nSENTIMENT FILTER: Lean toward positive / sympathetic words. About 4 of 5 should be warm or neutral-favorable. One mildly critical word is fine if it genuinely fits.';
            case 'lean-negative':
              return '\n\nSENTIMENT FILTER: Lean toward critical / unflattering words. About 4 of 5 should be unflattering, but include one that\'s neutral or sympathetic if it fits.';
            case 'strongly-negative':
              return '\n\nSENTIMENT FILTER: Return ONLY unflattering, critical, or pointed words (e.g. defensive, dismissive, snide, sycophantic, mealy-mouthed). Skip anything neutral or sympathetic.';
            case 'either':
            default:
              return '\n\nSENTIMENT FILTER: Mix freely — include both flattering and unflattering interpretations of the moment if the wording supports it.';
          }
        })();

        const payload = JSON.stringify({
          model: pickModel(_body),
          messages: [
            {
              role: 'system',
              content: `You are a vocabulary expert specializing in social and emotional language. Given a quote, an exchange between people, or a description of a moment, suggest 4-6 English words, idioms, or phrases that capture the TONE, DEMEANOR, or EMOTIONAL TEXTURE — how the speaker is being or how the dynamic feels.

Examples of the kind of words you'd return:
- defensive, dismissive, deflective, evasive, condescending, patronizing
- earnest, sincere, candid, vulnerable, self-deprecating
- passive-aggressive, cutting, snide, sardonic, biting
- enthusiastic, gushing, effusive, fawning, sycophantic
- hedging, equivocating, mealy-mouthed, weaselly
- magnanimous, gracious, generous-spirited${sentimentClause}

For each, provide the phrase, its category (word, phrase, or idiom), a concise meaning that explains the tone/dynamic, and a natural example sentence showing the word used to describe how someone is acting.

Return ONLY valid JSON array with this exact shape: [{"phrase":"...","category":"...","meaning":"...","example":"..."}]`
            },
            {
              role: 'user',
              content: description
            }
          ],
          temperature: 0.8
        });

        const options = buildRequestOptions(payload);
        const apiReq = compatHttps.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `API error: ${apiRes.statusCode}` }));
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
        const options = buildRequestOptions(payload);

        const apiReq = compatHttps.request(options, (apiRes) => {
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

  // Synonyms & other ways to say it
  if (req.method === 'POST' && req.url === '/api/synonyms') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { query } = _body;
        if (!query) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing query' }));
          return;
        }

        const payload = JSON.stringify({
          model: pickModel(_body),
          messages: [
            {
              role: 'system',
              content: `You are a vocabulary and thesaurus expert. The user will give you a word, phrase, or a description of what they're trying to say. Your job is to find synonyms, alternative phrases, and richer ways to express the same idea.

Organize results into 2-4 groups by register/context (e.g. "Formal Alternatives", "Casual / Conversational", "Idioms & Expressions", "Precise / Academic"). Each group should have 2-4 items.

For each item provide:
- phrase: the word or phrase
- category: "word", "phrase", or "idiom"
- meaning: a concise definition
- example: a natural example sentence
- register: one of "formal", "casual", "neutral", "literary", "slang"
- nuance: a short note on when to use this vs the original (optional, only if helpful)

If the input isn't a standard word/phrase but rather a description (like "ways to say I'm angry"), still find the best matches.

If the input word/phrase is uncommon or possibly confused with something else, include a "note" field at the top level explaining this.

Return JSON: {"note":"optional note","groups":[{"label":"Group Name","items":[{"phrase":"...","category":"...","meaning":"...","example":"...","register":"...","nuance":"..."}]}]}`
            },
            {
              role: 'user',
              content: query
            }
          ],
          temperature: 0.8
        });

        const https = require('https');
        const options = buildRequestOptions(payload);

        const apiReq = compatHttps.request(options, (apiRes) => {
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

  // Complete my sentence endpoint
  if (req.method === 'POST' && req.url === '/api/complete-sentence') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const _body = JSON.parse(body);
        const { text, meaning } = _body;
        if (!text && !meaning) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing text or meaning' }));
          return;
        }

        const userMessage = [text && `Sentence: ${text}`, meaning && `Meaning: ${meaning}`].filter(Boolean).join('\n');

        const payload = JSON.stringify({
          model: pickModel(_body),
          messages: [
            {
              role: 'system',
              content: `You are a vocabulary and idiom expert. The user has a partial sentence where they can't think of the exact word, phrase, or idiom. They may provide the sentence, the intended meaning, or both. Help them find the missing word.

CRITICAL: The user marks the gap with one of these placeholders: "..." (three dots), "…" (ellipsis char), "___" (underscores), or "[blank]". Treat THAT EXACT POSITION as the missing slot. The suggested word/phrase/idiom MUST fit grammatically and semantically into that slot — it should be substitutable for the placeholder. Do NOT change the surrounding words; preserve them verbatim around the filled-in slot.

If no placeholder is present, treat the end of the sentence as the gap (or wherever the meaning indicates).

1. Identify the gap and pick the most likely word/phrase/idiom that fills it.
2. Build the "completedSentence" by replacing the placeholder with the chosen phrase — keep all other words exactly as the user wrote them.
3. Suggest 1-3 candidate phrases (each must independently fit the slot). Provide each one's meaning and a brief example.

Return JSON:
{
  "completedSentence": "The user's sentence with the placeholder replaced (other words unchanged)",
  "phrases": [
    {"phrase": "...", "category": "word|phrase|idiom", "meaning": "...", "example": "..."}
  ]
}`
            },
            { role: 'user', content: userMessage }
          ],
          temperature: 0.7
        });

        const https = require('https');
        const options = buildRequestOptions(payload);

        const apiReq = compatHttps.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `OpenAI API error: ${apiRes.statusCode}` }));
              return;
            }
            try {
              const json = JSON.parse(data);
              let content = json.choices[0].message.content.trim();
              content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
              const result = JSON.parse(content);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to parse response' }));
            }
          });
        });
        apiReq.on('error', (e) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
        apiReq.write(payload);
        apiReq.end();
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // English → Chinese translate endpoint
  if (req.method === 'POST' && req.url === '/api/translate-en2zh') {
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
              content: `You are a translation expert. Translate the English text into natural, fluent Chinese (Simplified). Also provide the pinyin romanization and any useful notes about the translation (e.g. formality level, alternative translations, cultural context).

Return JSON:
{
  "translation": "中文翻译",
  "pinyin": "zhōng wén fān yì",
  "notes": "Optional notes about formality, alternatives, or cultural context"
}`
            },
            { role: 'user', content: text }
          ],
          temperature: 0.7
        });

        const https = require('https');
        const options = buildRequestOptions(payload);

        const apiReq = compatHttps.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => { data += chunk; });
          apiRes.on('end', () => {
            if (apiRes.statusCode !== 200) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `OpenAI API error: ${apiRes.statusCode}` }));
              return;
            }
            try {
              const json = JSON.parse(data);
              let content = json.choices[0].message.content.trim();
              content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '');
              const result = JSON.parse(content);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (e) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Failed to parse response' }));
            }
          });
        });
        apiReq.on('error', (e) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        });
        apiReq.write(payload);
        apiReq.end();
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
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
        const options = buildRequestOptions(payload);

        const apiReq = compatHttps.request(options, (apiRes) => {
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
        const { sentence, word, intendedMeaning } = _body;
        if (!sentence || !word) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing sentence or word' }));
          return;
        }

        const meaningContext = intendedMeaning
          ? `\nThe user has also explained what they are trying to convey: "${intendedMeaning}". Use this to better judge whether the word fits their intent and suggest alternatives that match what they actually mean.`
          : '';

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
Be concise but helpful. If the word is correct, acknowledge it and still offer alternatives for variety. Always provide originalWordMeaning and originalWordExample showing proper usage of the queried word.${meaningContext}`
            },
            {
              role: 'user',
              content: `Sentence: "${sentence}"\nWord I'm unsure about: "${word}"${intendedMeaning ? `\nWhat I'm trying to say: "${intendedMeaning}"` : ''}`
            }
          ],
          temperature: 0.5
        });

        const https = require('https');
        const options = buildRequestOptions(payload);

        const apiReq = compatHttps.request(options, (apiRes) => {
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
        const options = buildRequestOptions(payload);

        const apiReq = compatHttps.request(options, (apiRes) => {
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

        // Provider selection: ElevenLabs is the primary TTS provider for
        // higher-quality pronunciation (idioms, loan words, names, etc.).
        // OpenAI tts-1 is the fallback when ELEVENLABS_API_KEY isn't set
        // or when the ElevenLabs request fails (e.g. quota exceeded).
        const useElevenLabs = !!ELEVENLABS_API_KEY;
        const opts = useElevenLabs
          ? buildElevenLabsTTSRequest(text)
          : buildOpenAITTSRequest(text);

        const https = require('https');
        const apiReq = https.request(opts.requestOptions, (apiRes) => {
          if (apiRes.statusCode !== 200) {
            let errData = '';
            apiRes.on('data', chunk => { errData += chunk; });
            apiRes.on('end', () => {
              console.error(`TTS ${opts.providerName} error ${apiRes.statusCode}:`, errData.slice(0, 200));
              // Fallback to OpenAI if ElevenLabs failed and OpenAI key is available
              if (useElevenLabs && OPENAI_API_KEY) {
                console.warn('Falling back to OpenAI TTS');
                const fallback = buildOpenAITTSRequest(text);
                const fbReq = https.request(fallback.requestOptions, (fbRes) => {
                  if (fbRes.statusCode !== 200) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: `TTS API error: ${fbRes.statusCode}` }));
                    return;
                  }
                  const chunks = [];
                  fbRes.on('data', c => chunks.push(c));
                  fbRes.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Content-Length': buffer.length });
                    res.end(buffer);
                  });
                });
                fbReq.on('error', (e) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); });
                fbReq.write(fallback.payload);
                fbReq.end();
                return;
              }
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
        apiReq.write(opts.payload);
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
  const m = model || DEFAULT_MODEL;
  const messages = [
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
  ];
  const parsed = await chatCompletion(m, messages, { temperature: 0.3, max_tokens: 200 });
  const content = parsed.choices[0].message.content.trim();
  const jsonStr = content.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(jsonStr);
}

async function generateExample(phrase, meaning, model) {
  const m = model || DEFAULT_MODEL;
  const messages = [
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
  ];
  const parsed = await chatCompletion(m, messages, { temperature: 1.2, max_tokens: 100 });
  return parsed.choices[0].message.content.trim().replace(/^["']|["']$/g, '');
}

// Generate a fill-in-the-blank sentence
async function generateBlankSentence(phrase, meaning, model, blankInstruction) {
  const blankRules = blankInstruction
    ? `IMPORTANT — The user has specified how to blank this phrase: "${blankInstruction}". Follow their instruction exactly for what to hide/show.`
    : `Rules for choosing what to blank:
- For multi-word phrases, usually blank only the key content word(s), not all words
- Never blank only function words (e.g. "the", "a", "and", "in", "on", "to")
- Keep it challenging but fair; avoid giveaways where almost the whole phrase is visible`;

  const m = model || DEFAULT_MODEL;
  const messages = [
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
  ];

  try {
    const parsed = await chatCompletion(m, messages, { temperature: 0.7, max_tokens: 200 });
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
          return {
            sentence: sentenceWithBlank,
            fullSentence: fullSentence || '',
            hint,
            answer,
            answerCategory
          };
  } catch (e) {
    throw new Error('Failed to generate blank sentence: ' + e.message);
  }
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

// Pronoun placeholders that should match any word in the sentence
const PRONOUN_PLACEHOLDERS = new Set([
  'someone', 'somebody', 'something', 'oneself', "one's",
  'anyone', 'anybody', 'anything',
]);
// Possessive/object pronouns that may be swapped in context
const FLEXIBLE_PRONOUNS = new Set([
  'their', 'them', 'they', 'his', 'her', 'your', 'my', 'our',
]);

// Common irregular verb forms: base → [past, past participle, present participle, 3rd person]
const IRREGULAR_VERBS = {
  'hold': ['held', 'held', 'holding', 'holds'],
  'beat': ['beat', 'beaten', 'beating', 'beats'],
  'break': ['broke', 'broken', 'breaking', 'breaks'],
  'bring': ['brought', 'brought', 'bringing', 'brings'],
  'bite': ['bit', 'bitten', 'biting', 'bites'],
  'blow': ['blew', 'blown', 'blowing', 'blows'],
  'burn': ['burned', 'burnt', 'burning', 'burns'],
  'buy': ['bought', 'bought', 'buying', 'buys'],
  'catch': ['caught', 'caught', 'catching', 'catches'],
  'come': ['came', 'come', 'coming', 'comes'],
  'cut': ['cut', 'cut', 'cutting', 'cuts'],
  'dig': ['dug', 'dug', 'digging', 'digs'],
  'do': ['did', 'done', 'doing', 'does'],
  'draw': ['drew', 'drawn', 'drawing', 'draws'],
  'drink': ['drank', 'drunk', 'drinking', 'drinks'],
  'drive': ['drove', 'driven', 'driving', 'drives'],
  'eat': ['ate', 'eaten', 'eating', 'eats'],
  'fall': ['fell', 'fallen', 'falling', 'falls'],
  'feel': ['felt', 'felt', 'feeling', 'feels'],
  'fight': ['fought', 'fought', 'fighting', 'fights'],
  'find': ['found', 'found', 'finding', 'finds'],
  'fly': ['flew', 'flown', 'flying', 'flies'],
  'get': ['got', 'gotten', 'getting', 'gets'],
  'give': ['gave', 'given', 'giving', 'gives'],
  'go': ['went', 'gone', 'going', 'goes'],
  'grow': ['grew', 'grown', 'growing', 'grows'],
  'hang': ['hung', 'hung', 'hanging', 'hangs'],
  'have': ['had', 'had', 'having', 'has'],
  'hear': ['heard', 'heard', 'hearing', 'hears'],
  'hide': ['hid', 'hidden', 'hiding', 'hides'],
  'hit': ['hit', 'hit', 'hitting', 'hits'],
  'keep': ['kept', 'kept', 'keeping', 'keeps'],
  'know': ['knew', 'known', 'knowing', 'knows'],
  'lay': ['laid', 'laid', 'laying', 'lays'],
  'lead': ['led', 'led', 'leading', 'leads'],
  'leave': ['left', 'left', 'leaving', 'leaves'],
  'lend': ['lent', 'lent', 'lending', 'lends'],
  'let': ['let', 'let', 'letting', 'lets'],
  'lie': ['lay', 'lain', 'lying', 'lies'],
  'lose': ['lost', 'lost', 'losing', 'loses'],
  'make': ['made', 'made', 'making', 'makes'],
  'mean': ['meant', 'meant', 'meaning', 'means'],
  'meet': ['met', 'met', 'meeting', 'meets'],
  'pay': ['paid', 'paid', 'paying', 'pays'],
  'put': ['put', 'put', 'putting', 'puts'],
  'read': ['read', 'read', 'reading', 'reads'],
  'ride': ['rode', 'ridden', 'riding', 'rides'],
  'ring': ['rang', 'rung', 'ringing', 'rings'],
  'rise': ['rose', 'risen', 'rising', 'rises'],
  'run': ['ran', 'run', 'running', 'runs'],
  'say': ['said', 'said', 'saying', 'says'],
  'see': ['saw', 'seen', 'seeing', 'sees'],
  'sell': ['sold', 'sold', 'selling', 'sells'],
  'send': ['sent', 'sent', 'sending', 'sends'],
  'set': ['set', 'set', 'setting', 'sets'],
  'shake': ['shook', 'shaken', 'shaking', 'shakes'],
  'shoot': ['shot', 'shot', 'shooting', 'shoots'],
  'show': ['showed', 'shown', 'showing', 'shows'],
  'shut': ['shut', 'shut', 'shutting', 'shuts'],
  'sing': ['sang', 'sung', 'singing', 'sings'],
  'sit': ['sat', 'sat', 'sitting', 'sits'],
  'speak': ['spoke', 'spoken', 'speaking', 'speaks'],
  'spend': ['spent', 'spent', 'spending', 'spends'],
  'stand': ['stood', 'stood', 'standing', 'stands'],
  'steal': ['stole', 'stolen', 'stealing', 'steals'],
  'stick': ['stuck', 'stuck', 'sticking', 'sticks'],
  'strike': ['struck', 'struck', 'striking', 'strikes'],
  'swim': ['swam', 'swum', 'swimming', 'swims'],
  'take': ['took', 'taken', 'taking', 'takes'],
  'teach': ['taught', 'taught', 'teaching', 'teaches'],
  'tear': ['tore', 'torn', 'tearing', 'tears'],
  'tell': ['told', 'told', 'telling', 'tells'],
  'think': ['thought', 'thought', 'thinking', 'thinks'],
  'throw': ['threw', 'thrown', 'throwing', 'throws'],
  'wear': ['wore', 'worn', 'wearing', 'wears'],
  'win': ['won', 'won', 'winning', 'wins'],
  'write': ['wrote', 'written', 'writing', 'writes'],
};

// Build a regex pattern for a single word, handling verb inflections
function buildWordPattern(word, isFirstWord) {
  const lower = word.toLowerCase();

  // Pronoun placeholders match any word
  if (PRONOUN_PLACEHOLDERS.has(lower)) return "\\S+(?:'s)?";
  // Flexible pronouns match common pronoun alternatives
  if (FLEXIBLE_PRONOUNS.has(lower)) return "(?:their|them|they|his|him|her|hers|your|yours|my|mine|our|ours|its|one's)";

  // Check irregular verb table
  const irregular = IRREGULAR_VERBS[lower];
  if (irregular) {
    const allForms = new Set([lower, ...irregular]);
    return '(?:' + [...allForms].map(escapeRegex).join('|') + ')';
  }

  // For the first word (or any verb-like word), add regular inflection suffixes
  if (isFirstWord) {
    const base = word.replace(/e$/i, '');
    return escapeRegex(base) + 'e?' + '(?:s|es|ed|d|ing|en|ting)?';
  }

  return escapeRegex(word);
}

// Build a regex that matches the phrase even when conjugated or with pronoun substitutions
// e.g. "hold someone to their promise" matches "held him to his promise"
function buildInflectedPhrasePattern(phrase) {
  const words = phrase.trim().split(/\s+/);
  if (words.length === 0) return new RegExp(escapeRegex(phrase), 'i');
  const patterns = words.map((w, i) => buildWordPattern(w, i === 0));
  return new RegExp(patterns.join('\\s+'), 'i');
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
    const options = buildRequestOptions(payload);

    const apiReq = compatHttps.request(options, (apiRes) => {
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
  const _m = model || DEFAULT_MODEL;
  const numbered = phrases.map((p, i) => `${i + 1}. ${p}`).join('\n');
  const payload = JSON.stringify({
    model: _m,
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
    const options = buildRequestOptions(payload);

    const apiReq = compatHttps.request(options, (apiRes) => {
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
