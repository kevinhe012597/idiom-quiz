const { execFile } = require('child_process');
const https = require('https');
const path = require('path');
const fs = require('fs');

// ─── JXA: Read notes from Apple Notes ──────────────────────────────────

function fetchNotesViaJXA(noteNames) {
  const os = require('os');
  const tmpFile = path.join(os.tmpdir(), `apple-notes-jxa-${Date.now()}.js`);

  // Write the JXA script to a temp file to avoid shell escaping issues
  const jxaScript = `
var app = Application("Notes");
var folders = app.folders();
var targetNames = ${JSON.stringify(noteNames)};
var results = [];
for (var f = 0; f < folders.length; f++) {
  var notes = folders[f].notes();
  for (var n = 0; n < notes.length; n++) {
    var name = notes[n].name();
    if (targetNames.indexOf(name) !== -1) {
      results.push({
        name: name,
        body: notes[n].body()
      });
    }
  }
}
JSON.stringify(results);
`;

  fs.writeFileSync(tmpFile, jxaScript, 'utf-8');

  return new Promise((resolve, reject) => {
    execFile('osascript', ['-l', 'JavaScript', tmpFile], {
      encoding: 'utf-8',
      timeout: 180000, // 3 minutes — Notes.app body() is slow
      maxBuffer: 10 * 1024 * 1024, // 10MB
    }, (error, stdout, stderr) => {
      try { fs.unlinkSync(tmpFile); } catch {}

      if (error) {
        reject(new Error(`JXA error: ${error.message}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout.trim()));
      } catch (e) {
        reject(new Error(`Failed to parse JXA output: ${e.message}`));
      }
    });
  });
}

// ─── HTML to plain text lines ──────────────────────────────────────────

function htmlToLines(html) {
  const lines = [];

  // Split on <div>, <br>, <li>, </div>, newlines
  const chunks = html
    .replace(/<\/?(div|p|li|ol|ul|h[1-6])[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '') // strip remaining tags
    .split('\n');

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (trimmed) lines.push(trimmed);
  }

  return lines;
}

// ─── Skip patterns (shared with notion-sync) ───────────────────────────

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
  // Apple Notes specific skips
  /^How do companies/i,
  /^What is pre training/i,
  /^What is eval/i,
  /^What is a circuit/i,
  /^What is ideal cold/i,
  /^Klara AI$/i,
  /^System of record/i,
  /^Open evidence$/i,
  /^Second List$/i,
  /^List$/i,
  /^Words$/i,
  /^2026 words$/i,
];

function shouldSkip(line) {
  if (!line || line.length < 2) return true;
  if (line.length > 120) return true;
  // Skip lines that are only Chinese characters
  if (/^[\u4e00-\u9fff\u3000-\u303f]+$/.test(line)) return true;
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(line)) return true;
  }
  return false;
}

// ─── Parse a single line ────────────────────────────────────────────────

function parseLine(line) {
  line = line.replace(/<br\s*\/?>/g, '').trim();
  line = line.replace(/\*\*/g, '').trim();
  line = line.replace(/^[-•]\s*/, '').trim();
  line = line.replace(/^\d+\.\s*/, '').trim(); // numbered lists
  line = line.replace(/\t+/g, ' ').trim();

  if (shouldSkip(line)) return null;

  let phrase = '';
  let meaning = '';

  const colonIdx = line.indexOf(':');
  if (colonIdx > 0 && colonIdx < line.length - 1) {
    phrase = line.slice(0, colonIdx).trim();
    meaning = line.slice(colonIdx + 1).trim();
  } else if (colonIdx > 0 && colonIdx === line.length - 1) {
    // Trailing colon, no meaning
    phrase = line.slice(0, colonIdx).trim();
    meaning = '';
  } else {
    phrase = line.trim();
    meaning = '';
  }

  phrase = phrase.replace(/\s+/g, ' ').trim();
  // Remove trailing question marks from phrases like "Cheesy?"
  phrase = phrase.replace(/\?+$/, '').trim();

  if (phrase.length < 2) return null;
  if (/^\d+$/.test(phrase)) return null;

  meaning = meaning.replace(/^\s*[-–]\s*/, '').trim();

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

async function syncFromAppleNotes(openaiKey, noteNames, onProgress) {
  if (onProgress) onProgress('Reading Apple Notes...');

  // Fetch notes via JXA (async — Notes.app body() is slow, ~60-90s for multiple notes)
  let notes;
  try {
    notes = await fetchNotesViaJXA(noteNames);
  } catch (err) {
    throw new Error(`Failed to read Apple Notes: ${err.message}`);
  }

  if (notes.length === 0) {
    throw new Error(`No notes found matching: ${noteNames.join(', ')}`);
  }

  if (onProgress) onProgress(`Found ${notes.length} note(s): ${notes.map(n => n.name).join(', ')}`);

  // Extract all lines from all notes, tracking which note each line came from
  const allLines = []; // { text, noteName }
  for (const note of notes) {
    const lines = htmlToLines(note.body);
    if (onProgress) onProgress(`  "${note.name}": ${lines.length} lines`);
    for (const line of lines) {
      allLines.push({ text: line, noteName: note.name });
    }
  }

  if (onProgress) onProgress(`Total: ${allLines.length} lines. Parsing...`);

  // Parse and deduplicate
  const entries = [];
  const seen = new Set();

  for (const { text, noteName } of allLines) {
    const parsed = parseLine(text);
    if (!parsed) continue;

    const key = parsed.phrase.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    parsed.source = `Apple Notes — ${noteName}`;
    entries.push(parsed);
  }

  const withDef = entries.filter(e => e.meaning).length;
  const withoutDef = entries.length - withDef;

  if (onProgress) onProgress(`Parsed ${entries.length} entries. ${withDef} with definitions, ${withoutDef} need backfill.`);

  // Backfill missing definitions
  if (openaiKey && withoutDef > 0) {
    await backfillDefinitions(entries, openaiKey, onProgress);
  }

  // Save to disk
  const outputPath = path.join(__dirname, 'apple-cards.json');
  fs.writeFileSync(outputPath, JSON.stringify(entries, null, 2));

  if (onProgress) onProgress(`Done! ${entries.length} cards saved to apple-cards.json`);

  return entries;
}

module.exports = { syncFromAppleNotes };
