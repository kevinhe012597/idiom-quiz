const fs = require('fs');
const path = require('path');
const https = require('https');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    process.env[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
  }
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('ERROR: OPENAI_API_KEY not set in .env');
  process.exit(1);
}

// ─── Skip patterns ──────────────────────────────────────────────────────

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
  if (line.length > 120) return true; // Skip overly long sentences that aren't vocab entries
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  return false;
}

// ─── Parse ──────────────────────────────────────────────────────────────

function parseLine(line) {
  // Clean up
  line = line.replace(/<br\s*\/?>/g, '').trim();
  line = line.replace(/\*\*/g, '').trim(); // Remove bold markers
  line = line.replace(/^[-•]\s*/, '').trim(); // Remove bullet prefixes
  line = line.replace(/\t+/g, ' ').trim();

  if (shouldSkip(line)) return null;

  let phrase = '';
  let meaning = '';

  // Split on first colon to separate phrase from meaning
  const colonIdx = line.indexOf(':');
  if (colonIdx > 0 && colonIdx < line.length - 1) {
    phrase = line.slice(0, colonIdx).trim();
    meaning = line.slice(colonIdx + 1).trim();
  } else {
    phrase = line.trim();
    meaning = '';
  }

  // Clean up phrase
  phrase = phrase.replace(/\s+/g, ' ').trim();

  // Skip if phrase is too short or clearly not vocabulary
  if (phrase.length < 2) return null;
  if (/^\d+$/.test(phrase)) return null;

  // Remove trailing / leading punctuation artifacts
  meaning = meaning.replace(/^\s*[-–]\s*/, '').trim();

  // Auto-categorize
  const category = categorize(phrase);

  return { phrase, meaning, example: '', category };
}

function categorize(phrase) {
  const wordCount = phrase.split(/\s+/).length;

  // Single word → "word"
  if (wordCount === 1) return 'word';

  // Common idiom patterns
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

  // Two words are often compound terms → "phrase"
  if (wordCount === 2) return 'word';

  // Longer phrases are likely idioms or phrases
  return wordCount >= 4 ? 'idiom' : 'phrase';
}

// ─── OpenAI backfill ────────────────────────────────────────────────────

function callOpenAI(messages) {
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
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
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

async function backfillDefinitions(entries) {
  const needsDefinition = entries.filter(e => !e.meaning);
  if (needsDefinition.length === 0) {
    console.log('All entries already have definitions.');
    return;
  }

  console.log(`Backfilling definitions for ${needsDefinition.length} entries...`);

  // Process in batches of 25
  const batchSize = 25;
  for (let i = 0; i < needsDefinition.length; i += batchSize) {
    const batch = needsDefinition.slice(i, i + batchSize);
    const phraseList = batch.map((e, idx) => `${idx + 1}. ${e.phrase}`).join('\n');

    console.log(`  Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(needsDefinition.length / batchSize)} (${batch.length} phrases)...`);

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
      ]);

      const jsonStr = response.replace(/^```json\s*/, '').replace(/\s*```$/, '');
      const definitions = JSON.parse(jsonStr);

      // Match definitions back to entries
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

      // Small delay between batches to avoid rate limits
      if (i + batchSize < needsDefinition.length) {
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error(`  Error in batch: ${err.message}`);
      // Continue with next batch
    }
  }

  // Report remaining undefined
  const stillMissing = entries.filter(e => !e.meaning);
  if (stillMissing.length > 0) {
    console.log(`  ${stillMissing.length} entries still have no definition (will use empty).`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────

async function main() {
  const rawPath = path.join(__dirname, 'notion-raw.txt');
  if (!fs.existsSync(rawPath)) {
    console.error('ERROR: notion-raw.txt not found. Create it first.');
    process.exit(1);
  }

  const raw = fs.readFileSync(rawPath, 'utf-8');
  const lines = raw.split('\n');

  console.log(`Read ${lines.length} lines from notion-raw.txt`);

  // Parse all lines
  const entries = [];
  const seen = new Set();

  for (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;

    // Deduplicate by lowercase phrase
    const key = parsed.phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    entries.push(parsed);
  }

  console.log(`Parsed ${entries.length} unique entries`);
  console.log(`  With definitions: ${entries.filter(e => e.meaning).length}`);
  console.log(`  Without definitions: ${entries.filter(e => !e.meaning).length}`);

  // Backfill missing definitions via OpenAI
  await backfillDefinitions(entries);

  // Write output
  const outputPath = path.join(__dirname, 'notion-cards.json');
  fs.writeFileSync(outputPath, JSON.stringify(entries, null, 2));
  console.log(`\nWrote ${entries.length} cards to notion-cards.json`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
