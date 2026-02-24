const https = require('https');
const path = require('path');
const fs = require('fs');

// ─── Notion API helpers ────────────────────────────────────────────────

function notionRequest(endpoint, token, method = 'GET', body = null) {
  const payload = body ? JSON.stringify(body) : null;

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.notion.com',
      path: `/v1${endpoint}`,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Notion API ${res.statusCode}: ${data.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Failed to parse Notion response'));
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Fetch all blocks from a page (handles pagination)
async function fetchAllBlocks(pageId, token) {
  let blocks = [];
  let cursor = undefined;

  do {
    const url = `/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
    const result = await notionRequest(url, token);
    blocks = blocks.concat(result.results);
    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);

  return blocks;
}

// Extract plain text from Notion rich text array
function richTextToPlain(richTextArr) {
  if (!richTextArr || !Array.isArray(richTextArr)) return '';
  return richTextArr.map(t => t.plain_text || '').join('');
}

// Extract text from a block
function blockToText(block) {
  const type = block.type;
  if (!block[type]) return '';

  const richText = block[type].rich_text;
  if (!richText) return '';

  return richTextToPlain(richText);
}

// ─── Skip patterns (same as import-notion.js) ──────────────────────────

const SKIP_PATTERNS = [
  /^reviewed\s+(above|here)/i,
  /^\[start\s+here\]/i,
  /^===\s/,
  /^<empty-block/,
  /^<br\s*\/?>/,
  /^\d+\/\d+\s+(call|meeting)/i,
  /^(Bob Iger|Joshua Bassett|Marshawn Lynch|Thom Browne|Donna|Patrick|WSET3|MLS:|GDS:|Lagunitas|Silent Hill|Moloco)/i,
  /^Lie \/ Lay \/ Lain$/,
  /^Lay \/ Laid \/ Laid$/,
  /^Urban Legends Rather Than/i,
  /^(Manga|Anime Figurines|Ketamine|Croquet \(cro shet\))$/i,
  /^Izakaya:/,
  /^Yakitori:/,
  /^(Nanjing Massacre|Eight-nation Alliance|Century of Humiliation|Merchant bank)$/i,
  /^(Stereo:|Gecko:|French Riviera|Ironworks:|Brasserie)$/i,
];

function shouldSkip(line) {
  if (!line || line.length < 2) return true;
  if (line.length > 120) return true;
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  return false;
}

// ─── Parse ──────────────────────────────────────────────────────────────

function parseLine(line) {
  line = line.replace(/<br\s*\/?>/g, '').trim();
  line = line.replace(/\*\*/g, '').trim();
  line = line.replace(/^[-\u2022]\s*/, '').trim();
  line = line.replace(/\t+/g, ' ').trim();

  if (shouldSkip(line)) return null;

  let phrase = '';
  let meaning = '';

  const colonIdx = line.indexOf(':');
  if (colonIdx > 0 && colonIdx < line.length - 1) {
    phrase = line.slice(0, colonIdx).trim();
    meaning = line.slice(colonIdx + 1).trim();
  } else {
    phrase = line.trim();
    meaning = '';
  }

  phrase = phrase.replace(/\s+/g, ' ').trim();

  if (phrase.length < 2) return null;
  if (/^\d+$/.test(phrase)) return null;

  meaning = meaning.replace(/^\s*[-\u2013]\s*/, '').trim();

  const category = categorize(phrase);

  return { phrase, meaning, example: '', category };
}

function categorize(phrase) {
  const wordCount = phrase.split(/\s+/).length;

  if (wordCount === 1) return 'word';

  const idiomPatterns = [
    /^(a|the|to)\s/i,
    /in (the|a|my|your|his|her|someone's)/i,
    /one's/i,
    /(the|a) (road|bullet|bag|boat|ice|beans|fire|wall|tree|cat|dog|horse|moon|cake|bridge|hat|head)/i,
    /by (and|the|a|my)/i,
    /at (someone|large|odds|stake)/i,
    /on (the|a|brand|edge|someone)/i,
    /off (the|to|someone|some)/i,
    /out (of|the|on)/i,
  ];

  for (const p of idiomPatterns) {
    if (p.test(phrase)) return 'idiom';
  }

  if (wordCount === 2) return 'word';
  return wordCount >= 4 ? 'idiom' : 'phrase';
}

// ─── OpenAI backfill ────────────────────────────────────────────────────

function callOpenAI(messages, apiKey) {
  const payload = JSON.stringify({
    model: 'gpt-4o-mini',
    temperature: 0.3,
    max_tokens: 4000,
    messages,
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`OpenAI API error: ${res.statusCode} — ${data.slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed.choices[0].message.content.trim());
        } catch (e) {
          reject(new Error('Failed to parse OpenAI response'));
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function backfillDefinitions(entries, apiKey, onProgress) {
  const needsDefinition = entries.filter(e => !e.meaning);
  if (needsDefinition.length === 0) return;

  const batchSize = 25;
  for (let i = 0; i < needsDefinition.length; i += batchSize) {
    const batch = needsDefinition.slice(i, i + batchSize);
    const phraseList = batch.map((e, idx) => `${idx + 1}. ${e.phrase}`).join('\n');
    const batchNum = Math.floor(i / batchSize) + 1;
    const totalBatches = Math.ceil(needsDefinition.length / batchSize);

    if (onProgress) onProgress(`Backfilling definitions: batch ${batchNum}/${totalBatches}`);

    try {
      const response = await callOpenAI([
        {
          role: 'system',
          content: `You are a dictionary. For each English idiom, word, or phrase provided, give a short, clear definition (1 sentence max). If it's slang, explain its informal meaning. Respond as a JSON array of objects with "phrase" and "meaning" fields. Only output valid JSON, nothing else.`
        },
        {
          role: 'user',
          content: `Define each of these:\n${phraseList}`
        }
      ], apiKey);

      const jsonStr = response.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      const definitions = JSON.parse(jsonStr);

      for (const def of definitions) {
        const match = batch.find(e =>
          e.phrase.toLowerCase() === def.phrase.toLowerCase() ||
          e.phrase.toLowerCase().includes(def.phrase.toLowerCase()) ||
          def.phrase.toLowerCase().includes(e.phrase.toLowerCase())
        );
        if (match && def.meaning) {
          match.meaning = def.meaning;
        }
      }

      if (i + batchSize < needsDefinition.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error(`  Backfill batch error: ${err.message}`);
    }
  }
}

// ─── Main sync function ─────────────────────────────────────────────────

async function syncFromNotion(notionToken, openaiKey, pageIds, onProgress) {
  if (onProgress) onProgress('Fetching pages from Notion...');

  // Fetch blocks from all pages, tracking source
  const allLines = []; // { text, pageName }
  let currentPageName = 'Word List';

  for (const pageId of pageIds) {
    if (onProgress) onProgress(`Fetching page ${pageId.slice(0, 8)}...`);

    try {
      // Try to get the page title
      try {
        const pageInfo = await notionRequest(`/pages/${pageId}`, notionToken);
        if (pageInfo.properties && pageInfo.properties.title) {
          const titleProp = pageInfo.properties.title;
          if (titleProp.title && titleProp.title.length > 0) {
            currentPageName = titleProp.title.map(t => t.plain_text).join('');
          }
        }
      } catch {}

      const blocks = await fetchAllBlocks(pageId, notionToken);

      for (const block of blocks) {
        const text = blockToText(block);
        if (text) {
          const subLines = text.split(/<br\s*\/?>/g);
          for (const sub of subLines) {
            allLines.push({ text: sub.trim(), pageName: currentPageName });
          }
        }

        // Check for child page blocks — fetch their children too
        if (block.type === 'child_page' && block.has_children) {
          const subPageName = block.child_page.title || currentPageName;
          if (onProgress) onProgress(`Fetching subpage: ${subPageName}...`);
          try {
            const childBlocks = await fetchAllBlocks(block.id, notionToken);
            for (const cb of childBlocks) {
              const childText = blockToText(cb);
              if (childText) {
                const subLines = childText.split(/<br\s*\/?>/g);
                for (const sub of subLines) {
                  allLines.push({ text: sub.trim(), pageName: subPageName });
                }
              }
            }
          } catch (err) {
            console.error(`Error fetching subpage ${block.id}: ${err.message}`);
          }
        }
      }
    } catch (err) {
      console.error(`Error fetching page ${pageId}: ${err.message}`);
      throw new Error(`Failed to fetch Notion page ${pageId}: ${err.message}`);
    }
  }

  if (onProgress) onProgress(`Fetched ${allLines.length} lines. Parsing...`);

  // Parse
  const entries = [];
  const seen = new Set();

  for (const { text, pageName } of allLines) {
    const parsed = parseLine(text);
    if (!parsed) continue;

    const key = parsed.phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    parsed.source = `Notion — ${pageName}`;
    entries.push(parsed);
  }

  if (onProgress) onProgress(`Parsed ${entries.length} entries. ${entries.filter(e => !e.meaning).length} need definitions.`);

  // Backfill
  if (openaiKey) {
    await backfillDefinitions(entries, openaiKey, onProgress);
  }

  // Save to disk
  const outputPath = path.join(__dirname, 'notion-cards.json');
  fs.writeFileSync(outputPath, JSON.stringify(entries, null, 2));

  if (onProgress) onProgress(`Done! ${entries.length} cards saved.`);

  return entries;
}

module.exports = { syncFromNotion };
