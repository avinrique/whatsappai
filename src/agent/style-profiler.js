const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const vectordb = require('../data/vectordb');
const { callLLM } = require('./llm');
const { formatTimingStats } = require('../data/chat-parser');

const DOCS_DIR = path.join(config.DATA_DIR, 'style-profiles');
const CHUNK_SIZE = 100; // messages per LLM chunk
const UPDATE_THRESHOLD = 25; // new messages before auto-refresh

function getDocPath(contactId) {
  const safe = contactId.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(DOCS_DIR, `${safe}.md`);
}

function getMetaPath(contactId) {
  const safe = contactId.replace(/[^a-zA-Z0-9]/g, '_');
  return path.join(DOCS_DIR, `${safe}.meta.json`);
}

function loadDocument(contactId) {
  const docPath = getDocPath(contactId);
  if (fs.existsSync(docPath)) {
    return fs.readFileSync(docPath, 'utf-8');
  }
  return null;
}

function loadMeta(contactId) {
  const metaPath = getMetaPath(contactId);
  if (fs.existsSync(metaPath)) {
    try { return JSON.parse(fs.readFileSync(metaPath, 'utf-8')); } catch { return null; }
  }
  return null;
}

function saveDocument(contactId, doc, meta) {
  if (!fs.existsSync(DOCS_DIR)) {
    fs.mkdirSync(DOCS_DIR, { recursive: true });
  }
  fs.writeFileSync(getDocPath(contactId), doc);
  fs.writeFileSync(getMetaPath(contactId), JSON.stringify(meta, null, 2));
}

/**
 * Format messages into a readable conversation block.
 * Shows both sides so the LLM can see the full flow.
 */
function formatConversation(messages, userName, contactName) {
  return messages.map(m => {
    const sender = m.fromMe ? userName : contactName;
    return `[${sender}]: ${m.body}`;
  }).join('\n');
}

/**
 * Analyze one chunk of conversation and extract patterns.
 */
async function analyzeChunk(chunk, userName, contactName, chunkIndex, totalChunks) {
  console.log(`\n[Profile] Pass 1: Analyzing chunk ${chunkIndex + 1}/${totalChunks} (${chunk.length} messages)...`);
  const convo = formatConversation(chunk, userName, contactName);

  const prompt = `You are analyzing a WhatsApp conversation chunk (${chunkIndex + 1}/${totalChunks}) between "${userName}" and "${contactName}".

CONVERSATION:
${convo}

Do a DEEP extraction of how "${userName}" texts. Go through EVERY single message from ${userName} and analyze:

=== STYLE & TONE ===
1. MOODS: What emotional states appear? For EACH mood give 8-10 EXACT messages from ${userName} (WORD FOR WORD, character for character). Moods to look for: casual/chill, happy/excited, annoyed/angry, caring/concerned, joking/playful, sad/down, busy/distracted, flirty, sarcastic.
2. MESSAGE STRUCTURE: How long are messages (word count)? Does ${userName} send one message or multiple short ones in a row? Fragments or full sentences? Use of punctuation, line breaks, emojis, stickers? Give exact examples.
3. FORMALITY LEVEL: How formal/informal is ${userName}? Does it change based on topic or mood?

=== LANGUAGE & WORD CHOICES (MOST IMPORTANT) ===
4. PRIMARY LANGUAGE: What language(s) does ${userName} use? Native script or romanized? Code-switching patterns?
5. PRONOUNS & ADDRESS: EXACT pronouns and address forms for ${contactName} — list every instance with the full message. Note formal vs informal.
6. VERB FORMS: EXACT verb conjugations and grammar patterns. Copy the exact forms — do NOT correct or standardize them.
7. SPELLING FINGERPRINTS: How does ${userName} spell specific words? Every distinct non-standard spelling, abbreviation, and romanization choice. These are unique to the user.
8. RECURRING PHRASES: Greetings, sign-offs, reactions, filler words, exclamations. Copy every distinct one you find.
9. SLANG & EXPRESSIONS: Any slang, colloquialisms, inside jokes, or unique expressions. Quote them exactly.

=== RESPONSE PATTERNS ===
10. HOW ${userName} RESPONDS TO:
    - Questions (direct answer? deflection? counter-question?)
    - Good news/excitement from ${contactName}
    - Bad news/complaints from ${contactName}
    - Jokes/memes
    - Plans/invitations (how do they confirm, decline, or negotiate?)
    - Images/media
    - Long messages vs short messages
    Give 3+ exact examples for EACH response type you see.
11. CONVERSATION FLOW: Who initiates? How do conversations start and end? Does ${userName} leave conversations abruptly or say goodbye?
12. DOUBLE-TEXTING: Does ${userName} send multiple messages when one would do? Give examples.

=== RELATIONSHIP SIGNALS ===
13. How does ${userName} address ${contactName}? (nicknames, terms of endearment, titles)
14. What topics does ${userName} bring up vs avoid?
15. Power dynamics — who asks for favors? Who makes plans? Who apologizes first?

For ALL points: quote EXACT messages from ${userName}. More examples = better. Be exhaustive, not summarative.`;

  return callLLM(
    'You extract texting patterns from conversations with extreme attention to exact word choices, pronouns, verb forms, and spelling. Always copy messages word-for-word. Be exhaustive.',
    [{ role: 'user', content: prompt }],
    2500
  );
}

/**
 * Merge all chunk analyses into one relationship document.
 */
async function mergeAnalyses(analyses, userName, contactName) {
  console.log(`[Profile] Pass 1: Merging ${analyses.length} chunk analyses...`);
  const combined = analyses.map((a, i) => `--- CHUNK ${i + 1} ANALYSIS ---\n${a}`).join('\n\n');

  const prompt = `You have ${analyses.length} chunk analyses of how "${userName}" texts "${contactName}" on WhatsApp.

ALL ANALYSES:
${combined}

Now create ONE comprehensive, DETAILED relationship document. This is the ONLY reference an AI has to replicate ${userName}'s texting style — it must be exhaustive.

Use this EXACT format:

# How ${userName} texts ${contactName}

## Language & Word Choices (MOST IMPORTANT SECTION)
This section is CRITICAL. The AI must use these EXACT words, not synonyms or alternatives.

### Primary Language & Script
(What language(s) does ${userName} use? Romanized or native script? When does ${userName} code-switch between languages? Give 5+ examples.)

### Pronouns & Address Forms
(EXACT pronouns and address forms for ${contactName}. List every distinct form with 5+ full message examples each. Note: formal vs informal contexts. NEVER mix these up.)

### Nicknames & Terms
(How does ${userName} address ${contactName}? Any nicknames, shortened names, titles, terms of endearment? List every variant with examples.)

### Verb Forms & Grammar
(EXACT verb conjugations and grammar patterns. 8+ examples. Copy exactly — do not correct spelling or grammar.)

### Spelling Fingerprints
(How does ${userName} spell specific words differently from standard? List EVERY distinct spelling. These are unique identifiers — the AI MUST use these exact spellings.)

### Recurring Phrases & Fillers
(Phrases ${userName} uses repeatedly — greetings, sign-offs, reactions, filler words, exclamations. 8+ exact examples. Note which are used most often.)

### Slang & Expressions
(Any slang, colloquialisms, inside jokes, catchphrases, or unique expressions. 5+ examples with context.)

## General Style
(Overall texting patterns with SPECIFIC numbers and examples:
- Average message length in words
- Does ${userName} use emojis? Which ones? How often?
- Capitalization habits (all lowercase? Normal? Caps for emphasis?)
- Punctuation (periods, exclamation marks, question marks — or none?)
- Does ${userName} send single messages or multiple short ones in a row?
- Does ${userName} use voice notes, stickers, or GIFs?)

## When things are normal/casual
(How ${userName} texts in regular everyday conversation. 8-12 EXACT example messages.)

## When happy/excited
(How texting changes when ${userName} is happy/excited. 8-12 EXACT examples. Note specific changes: more emojis? Longer messages? Different words?)

## When annoyed/angry/fighting
(How ${userName} texts when upset. 8-12 EXACT examples. Note: do messages get shorter? Drier? More formal? Less emoji?)

## When caring/concerned
(How ${userName} shows care or worry. 8-12 EXACT examples.)

## When joking/playful
(Humor style — sarcastic? Silly? Teasing? 8-12 EXACT examples.)

## When making plans
(How ${userName} proposes, accepts, declines, or negotiates plans. 8-12 EXACT examples. Note: how ${userName} says yes vs no vs maybe.)

## When distracted/busy
(Short replies, delayed responses, quick acknowledgments. 5-8 EXACT examples.)

## Other moods
(Any other distinct moods observed. EXACT examples for each.)

## Response Patterns (CRITICAL for AI)
How ${userName} typically responds to different inputs. For EACH, give 3-5 exact message examples:

### To questions
### To good news / excitement
### To bad news / complaints
### To jokes / memes
### To images / media
### To plans / invitations
### To requests / favors
### To long messages
### When ${userName} doesn't know the answer

## Conversation Dynamics
- Who initiates conversations more often?
- How do conversations typically start? (exact opening messages)
- How do conversations end? (exact closing patterns)
- Does ${userName} double-text?
- How does ${userName} handle being left on read?
- Any recurring conversation patterns?

## Relationship Context
(What kind of relationship is this? What's the power dynamic? What topics are common vs avoided? What's the current vibe based on recent messages?)

IMPORTANT RULES:
- Every section MUST have real example messages copied EXACTLY from the analyses — word for word, character for character.
- The Language & Word Choices section is the HIGHEST PRIORITY. Every word form, spelling, and pronoun must be preserved exactly.
- Include MORE examples rather than fewer. 8+ per section.
- If a section has no data, write "No clear pattern found" and skip it.
- Do NOT make up examples. Only use what appears in the analyses.
- The document should be LONG and THOROUGH. This is the AI's only reference.`;

  return callLLM(
    'You create comprehensive, detailed texting style documents. You are extremely precise about word choices, pronouns, verb forms, and spelling. Always include exact example messages copied word-for-word. Never make up examples. More detail is always better.',
    [{ role: 'user', content: prompt }],
    6000
  );
}

/**
 * Second pass: re-analyze all messages WITH the first-pass document as context.
 * Catches everything missed, adds more examples, corrects errors.
 */
async function deepRefineChunk(chunk, userName, contactName, existingDoc, chunkIndex, totalChunks) {
  console.log(`[Profile] Pass 2: Refining chunk ${chunkIndex + 1}/${totalChunks} (${chunk.length} messages)...`);
  const convo = formatConversation(chunk, userName, contactName);

  const prompt = `You are doing a DEEP SECOND PASS analysis of a WhatsApp conversation chunk (${chunkIndex + 1}/${totalChunks}) between "${userName}" and "${contactName}".

Here is the document from the first pass:
${existingDoc}

---

CONVERSATION CHUNK TO RE-ANALYZE:
${convo}

---

The first pass may have MISSED things. Your job is to find EVERYTHING the first pass missed. Go through EVERY single message from ${userName} one by one and extract:

=== LANGUAGE GAPS (HIGHEST PRIORITY) ===
1. **Missed word forms** — ANY pronoun, verb conjugation, spelling, or romanization not already in the document. Even slight variations matter (e.g., "k" vs "ke" vs "ka").
2. **Missed phrases & fillers** — Greetings, sign-offs, reactions, filler words, exclamations, one-word replies that aren't in the document. Copy EXACTLY.
3. **Code-switching patterns missed** — When does ${userName} switch languages mid-sentence or mid-conversation? What triggers it?
4. **Spelling variants missed** — Same word spelled differently in different contexts. List every variant.

=== STYLE GAPS ===
5. **Missed mood examples** — For each mood section in the document, find messages from THIS chunk that belong there but weren't included. Copy them exactly.
6. **New moods not in document** — Any emotional state or texting mode not captured: sarcastic, confused, apologetic, bored, affectionate, etc.
7. **Message structure patterns** — Does ${userName} send single messages or chains of short ones? Use line breaks? Trailing punctuation (... or ???)? Send voice notes or stickers? When?
8. **Emphasis & formatting** — Use of CAPS, repeated letters (nooooo), repeated punctuation (???), emojis placement patterns.

=== RESPONSE PATTERNS GAPS ===
9. **How ${userName} responds to specific inputs** — Find response patterns NOT in the document:
   - Responding to questions (direct? deflects? counter-question?)
   - Responding to good/bad news
   - Responding to jokes, memes, images
   - Responding to plans/invitations (how they say yes/no/maybe)
   - Responding to requests/favors
   - Responding to long messages
   - Responding when they don't know something
   Give 3+ exact message examples for EACH pattern you find.
10. **Conversation starters** — How does ${userName} initiate conversations? First message patterns. What triggers a new exchange?
11. **Conversation enders** — How does ${userName} end conversations? Abruptly? With a sign-off? Goes quiet?

=== RELATIONSHIP GAPS ===
12. **Nicknames & address forms missed** — Any way ${userName} addresses ${contactName} not in the document.
13. **Power dynamics** — Who asks favors? Who apologizes? Who changes plans? Who waits for the other?
14. **Topics & interests** — Recurring subjects, shared interests, inside jokes, references not captured.

=== CORRECTIONS ===
15. **Errors in first pass** — If the document says ${userName} does X but you see them doing Y in this chunk, note the CORRECTION with exact evidence.
16. **Overstatements** — If the document says "always" or "never" but this chunk shows exceptions, note them.

List EVERY finding with the EXACT message copied word-for-word. Even if it seems minor — include it. More data = better profile.`;

  return callLLM(
    'You do deep second-pass analysis of conversations. You find everything the first pass missed. You are exhaustive and precise. You copy every message word-for-word. You never skip details.',
    [{ role: 'user', content: prompt }],
    2500
  );
}

/**
 * Merge the first-pass document with second-pass refinements into a final detailed document.
 */
async function mergeRefinements(firstPassDoc, refinements, userName, contactName) {
  console.log(`[Profile] Pass 2: Merging ${refinements.length} refinements into final document...`);
  const combined = refinements.map((r, i) => `--- REFINEMENT ${i + 1} ---\n${r}`).join('\n\n');

  const prompt = `You have a first-pass relationship document and ${refinements.length} second-pass refinements for how "${userName}" texts "${contactName}".

FIRST PASS DOCUMENT:
${firstPassDoc}

---

SECOND PASS REFINEMENTS (new findings, missed examples, corrections):
${combined}

---

Create the FINAL, DEFINITIVE relationship document by merging EVERYTHING from both passes. This is the ONLY reference an AI has to replicate ${userName}'s texting — it must be exhaustive.

Use this EXACT format:

# How ${userName} texts ${contactName}

## Language & Word Choices (MOST IMPORTANT SECTION)
This section is CRITICAL. The AI must use these EXACT words, not synonyms or alternatives.

### Primary Language & Script
(What language(s) does ${userName} use? Romanized or native script? When does ${userName} code-switch between languages? Give 5+ examples.)

### Pronouns & Address Forms
(EXACT pronouns and address forms for ${contactName}. List every distinct form with 5+ full message examples each. Note: formal vs informal contexts. NEVER mix these up.)

### Nicknames & Terms
(How does ${userName} address ${contactName}? Any nicknames, shortened names, titles, terms of endearment? List every variant with examples.)

### Verb Forms & Grammar
(EXACT verb conjugations and grammar patterns. 8+ examples. Copy exactly — do not correct spelling or grammar.)

### Spelling Fingerprints
(How does ${userName} spell specific words differently from standard? List EVERY distinct spelling. These are unique identifiers — the AI MUST use these exact spellings.)

### Recurring Phrases & Fillers
(Phrases ${userName} uses repeatedly — greetings, sign-offs, reactions, filler words, exclamations. 8+ exact examples. Note which are used most often.)

### Slang & Expressions
(Any slang, colloquialisms, inside jokes, catchphrases, or unique expressions. 5+ examples with context.)

## General Style
(Overall texting patterns with SPECIFIC numbers and examples:
- Average message length in words
- Does ${userName} use emojis? Which ones? How often?
- Capitalization habits (all lowercase? Normal? Caps for emphasis?)
- Punctuation (periods, exclamation marks, question marks — or none?)
- Does ${userName} send single messages or multiple short ones in a row?
- Does ${userName} use voice notes, stickers, or GIFs?)

## Message Structure & Habits
(Detailed breakdown:
- Typical message length range (shortest and longest typical messages with examples)
- Single message vs multi-message chains — when does ${userName} split into multiple messages?
- Use of line breaks within messages
- Trailing punctuation patterns (... or ??? or !!! or none)
- Emphasis patterns: CAPS, repeated letters (nooooo), repeated punctuation
- Time-of-day patterns — any difference in texting style at different times?)

## When things are normal/casual
(How ${userName} texts in regular everyday conversation. 8-12 EXACT example messages.)

## When happy/excited
(How texting changes when ${userName} is happy/excited. 8-12 EXACT examples. Note specific changes: more emojis? Longer messages? Different words?)

## When annoyed/angry/fighting
(How ${userName} texts when upset. 8-12 EXACT examples. Note: do messages get shorter? Drier? More formal? Less emoji?)

## When caring/concerned
(How ${userName} shows care or worry. 8-12 EXACT examples.)

## When joking/playful
(Humor style — sarcastic? Silly? Teasing? 8-12 EXACT examples.)

## When making plans
(How ${userName} proposes, accepts, declines, or negotiates plans. 8-12 EXACT examples. Note: how ${userName} says yes vs no vs maybe.)

## When distracted/busy
(Short replies, delayed responses, quick acknowledgments. 5-8 EXACT examples.)

## Other moods
(Any other distinct moods observed — confused, apologetic, bored, flirty, sarcastic, etc. EXACT examples for each.)

## Response Patterns (CRITICAL for AI)
How ${userName} typically responds to different inputs. For EACH, give 3-5 exact message examples:

### To questions
### To good news / excitement
### To bad news / complaints
### To jokes / memes
### To images / media
### To plans / invitations
### To requests / favors
### To long messages
### When ${userName} doesn't know the answer

## Conversation Dynamics
- Who initiates conversations more often?
- How do conversations typically start? (exact opening messages)
- How do conversations end? (exact closing patterns)
- Does ${userName} double-text? (examples)
- How does ${userName} handle being left on read?
- Any recurring conversation patterns or rituals?

## Relationship Context
(What kind of relationship is this? What's the power dynamic? What topics are common vs avoided? What's the current vibe based on recent messages?)

MERGE RULES:
- APPLY corrections from refinements — if first pass got something wrong and refinements found evidence, fix it.
- ADD all new examples from refinements into the appropriate sections.
- ADD new patterns or moods found in refinements as subsections.
- EVERY section must have 8-15 EXACT example messages minimum. The Language section should have MORE.
- Do NOT make up examples. Only use what appears in the first pass and refinements.
- Copy all examples EXACTLY — word for word, character for character.
- If a section has no data from either pass, write "No clear pattern found" and skip it.
- The document should be LONG and THOROUGH. This is the AI's only reference.

Write the COMPLETE final document:`;

  return callLLM(
    'You create the most detailed, comprehensive texting style documents possible. You merge first-pass and second-pass findings into one exhaustive guide. Every example is copied word-for-word. You never make up examples. More detail is always better.',
    [{ role: 'user', content: prompt }],
    6000
  );
}

/**
 * Verify the quality of a built document — checks that it has real exact examples,
 * not generic summaries. If sections are weak, patches them with re-extracted examples.
 *
 * @param {string} document - The built style document
 * @param {Array} allMessages - All messages for this contact (to re-extract from)
 * @param {string} userName
 * @param {string} contactName
 * @param {Function} onProgress
 * @returns {Promise<string>} The verified (and possibly patched) document
 */
async function verifyDocument(document, allMessages, userName, contactName, onProgress) {
  console.log(`[Profile] Verifying document quality...`);
  if (onProgress) onProgress({ phase: 'verifying', message: 'Verifying document quality...' });

  // Step 1: Ask LLM to audit the document
  const auditPrompt = `You are a strict quality auditor for a texting style document. This document is used by an AI to perfectly replicate how "${userName}" texts "${contactName}" on WhatsApp.

DOCUMENT TO AUDIT:
${document}

---

Audit EVERY section in the document. For EACH section, check:
1. Does it contain REAL, EXACT example messages copied word-for-word? (not paraphrased, not summarized, not described)
2. How many exact example messages does it have? (count messages in quotes or on their own lines that look like real texts)
3. Are the examples specific enough to be useful? (vague descriptions like "he says casual things" = USELESS. Exact quoted messages = USEFUL)
4. For the Language section specifically: Are pronouns, verb forms, and spellings listed with exact examples? Generic descriptions = FAIL.

REQUIRED SECTIONS TO CHECK:
- Language & Word Choices (subsections: Primary Language, Pronouns, Nicknames, Verb Forms, Spelling, Phrases, Slang)
- General Style
- Message Structure & Habits
- When things are normal/casual
- When happy/excited
- When annoyed/angry/fighting
- When caring/concerned
- When joking/playful
- When making plans
- When distracted/busy
- Response Patterns (subsections: questions, good news, bad news, jokes, images, plans, requests, long messages, unknown answers)
- Conversation Dynamics
- Relationship Context

Grading:
- PASS: Has 5+ real exact examples that are specific and useful
- WEAK: Has 1-4 examples, or examples seem vague/generic/possibly made up, or section exists but lacks depth
- FAIL: No real examples at all, just descriptions or summaries, or section is missing entirely
- MISSING: Section doesn't exist in the document at all

Output format — one line per section/subsection:
SECTION_NAME: PASS/WEAK/FAIL/MISSING — reason (count of real examples found)

At the end, list ALL sections that got WEAK, FAIL, or MISSING.`;

  const audit = await callLLM(
    'You audit texting style documents for quality. You can tell the difference between real copied messages and vague descriptions. Be strict.',
    [{ role: 'user', content: auditPrompt }],
    800
  );

  // Check if any sections failed or are weak
  const hasWeakSections = /\b(WEAK|FAIL)\b/i.test(audit);

  if (!hasWeakSections) {
    // Document passes — all sections have real examples
    return document;
  }

  if (onProgress) onProgress({ phase: 'patching', message: 'Patching weak sections with real examples...' });

  // Step 2: Re-extract real examples for weak sections directly from messages
  // Sample messages from the user (fromMe=true) for direct extraction
  const userMessages = allMessages.filter(m => m.fromMe);
  const sampleSize = Math.min(userMessages.length, 300);
  const step = Math.max(1, Math.floor(userMessages.length / sampleSize));
  const sampled = userMessages.filter((_, i) => i % step === 0).slice(0, sampleSize);

  // Also get conversation pairs (what contact said → what user replied) for context
  const pairs = [];
  for (let i = 1; i < allMessages.length && pairs.length < 150; i++) {
    if (allMessages[i].fromMe && !allMessages[i - 1].fromMe) {
      pairs.push(`${contactName}: ${allMessages[i - 1].body}\n${userName}: ${allMessages[i].body}`);
    }
  }

  const rawExamples = sampled.map(m => m.body).join('\n');
  const pairExamples = pairs.join('\n---\n');

  const patchPrompt = `A style document for how "${userName}" texts "${contactName}" was audited and these sections were found WEAK, FAILING, or MISSING:

AUDIT RESULT:
${audit}

---

Here are ${sampled.length} REAL messages from ${userName} (copied exactly from the chat):
${rawExamples}

---

Here are ${pairs.length} conversation pairs (${contactName} said something → ${userName} replied):
${pairExamples}

---

EXISTING DOCUMENT:
${document}

---

Your job: Rewrite the COMPLETE document. Fix ALL issues found in the audit:

FOR WEAK/FAIL SECTIONS:
1. Find REAL messages from the raw examples above that fit that section
2. Add them as exact examples (copy word-for-word, no modifications)
3. Each section needs 5-8+ real examples minimum
4. For Response Patterns — use the conversation PAIRS to find how ${userName} replies to different inputs

FOR MISSING SECTIONS:
1. Create the missing section with the correct heading
2. Analyze the raw messages and pairs to find relevant examples
3. Populate with 5+ real examples
4. Required sections that MUST exist:
   - Language & Word Choices (with subsections for Pronouns, Verb Forms, Spelling, Phrases, Slang)
   - General Style
   - Message Structure & Habits
   - Mood sections (casual, happy, annoyed, caring, joking, plans, busy)
   - Response Patterns (with subsections for each input type)
   - Conversation Dynamics
   - Relationship Context

FOR PASSED SECTIONS:
- Keep them exactly as they are — do not remove good content.

RULES:
- ONLY use messages that actually appear in the raw examples or pairs above. Do NOT make up messages.
- Copy messages CHARACTER FOR CHARACTER. Don't fix spelling, don't add punctuation, don't translate.
- If you truly can't find enough examples for a section, write "Limited examples found — need more data" and include whatever you found.
- The final document must be comprehensive and follow the full template structure.
- For the Language section: extract EVERY distinct pronoun, verb form, spelling variant, and recurring phrase from the raw messages. This is the most important section.

Write the COMPLETE patched document:`;

  const patched = await callLLM(
    'You patch style documents by inserting REAL examples from raw message data. You never make up messages. You copy them character-for-character from the provided data. You ensure all required sections exist.',
    [{ role: 'user', content: patchPrompt }],
    6000
  );

  return patched;
}

/**
 * Analyze conversation topics — WHAT do they talk about, not just HOW they type.
 */
async function analyzeTopics(messages, userName, contactName) {
  console.log(`[Profile] Analyzing topics from ${messages.length} messages...`);
  // Sample up to 500 messages spread across the conversation
  const step = Math.max(1, Math.floor(messages.length / 500));
  const sampled = messages.filter((_, i) => i % step === 0).slice(0, 500);
  const convo = formatConversation(sampled, userName, contactName);

  const prompt = `Analyze this WhatsApp conversation between "${userName}" and "${contactName}" for CONTENT and CONTEXT (not style — that's handled elsewhere).

CONVERSATION SAMPLE (${sampled.length} messages):
${convo}

Do a thorough content analysis:

### 1. Main Topics (rank by frequency)
What do they discuss most? (work, school, relationships, hobbies, gaming, food, plans, gossip, etc.)
For each topic: give 3+ exact message examples showing how it comes up.

### 2. People & Places Referenced
- Names of other people mentioned (friends, family, coworkers, crushes). Who are they? How often do they come up?
- Places mentioned (restaurants, schools, cities, hangout spots). Are they recurring?
- Give exact quotes referencing each person/place.

### 3. Inside Jokes & Shared References
- Any recurring jokes, callback humor, or memes they share?
- Phrases that seem to have special meaning between them?
- Running gags or references to past events?
- Give exact examples.

### 4. Shared Interests & Activities
- Games, shows, anime, movies, music, sports, apps they both reference?
- Activities they do together (hanging out, studying, gaming, eating)?
- Give exact examples.

### 5. Recurring Patterns & Rituals
- Things that come up again and again (a specific habit, a daily check-in, a recurring argument)?
- Conversation patterns that repeat (always talking about X after Y)?
- Regular plans or routines?

### 6. Current Context & Life Situations
- What's going on in their lives RIGHT NOW based on recent messages?
- Any ongoing situations (exams, new job, relationship drama, travel plans)?
- Recent events referenced?

### 7. Conversation Triggers
- How do new conversations typically start? What triggers a new exchange?
- Does one person usually initiate?
- Are conversations triggered by events, boredom, or routine?

### 8. Sensitive Topics & Boundaries
- Any topics that seem to create tension or get avoided?
- Topics where the tone shifts noticeably?
- Areas where one person deflects or goes quiet?

Be SPECIFIC. Use EXACT quotes from the conversation for every point. This analysis helps an AI understand the WORLD and CONTEXT of these two people's relationship, not just how they type.`;

  return callLLM(
    'You analyze conversation content, topics, and context. You are specific and always use exact quotes as evidence. You identify people, places, interests, and relationship dynamics.',
    [{ role: 'user', content: prompt }],
    1800
  );
}

/**
 * Build an enhanced document from uploaded chat export data.
 * Includes topic analysis, timing stats, image context, and relationship context.
 *
 * @param {string} contactId
 * @param {string} contactName
 * @param {Array} messages - Pre-parsed messages [{sender, body, timestamp, fromMe}]
 * @param {string} relationshipContext - User-provided relationship description
 * @param {string[]} imageDescriptions - Descriptions of images from the export
 * @param {Object} timingStats - Output of analyzeReplyTiming()
 * @param {Function} onProgress
 */
async function buildDocumentFromUpload(contactId, contactName, messages, relationshipContext, imageDescriptions, timingStats, onProgress) {
  const userName = config.get('userName') || 'Avin';
  const llmProvider = config.get('llmProvider') || 'openai';
  const llmModel = llmProvider === 'ollama' ? (config.get('ollamaModel') || 'llama3') : (config.get('openaiModel') || 'gpt-4o');
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[Profile/Upload] Building profile for ${contactName} (${messages.length} messages)`);
  console.log(`[Profile/Upload] LLM: ${llmProvider}/${llmModel}`);
  console.log(`${'='.repeat(50)}`);

  if (messages.length < 10) {
    return { error: `Only ${messages.length} messages found. Need at least 10 to build a profile.` };
  }

  // Split into chunks
  const chunks = [];
  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    chunks.push(messages.slice(i, i + CHUNK_SIZE));
  }

  // Total steps: topic analysis + pass1 chunks + merge1 + pass2 chunks + merge2
  const totalSteps = 1 + chunks.length + 1 + chunks.length + 1;
  let stepCounter = 0;

  // ===== Step 0: Topic analysis =====
  if (onProgress) onProgress({ phase: 'topics', message: 'Analyzing conversation topics...', step: ++stepCounter, total: totalSteps });
  const topicAnalysis = await analyzeTopics(messages, userName, contactName);

  // ===== PASS 1: Initial analysis =====
  if (onProgress) onProgress({ phase: 'pass1', message: 'Pass 1: Analyzing patterns...' });

  const analyses = [];
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress({
      phase: 'chunk', pass: 1, current: i + 1, total: totalSteps, step: ++stepCounter,
      message: `Pass 1: Chunk ${i + 1}/${chunks.length}`,
    });
    const analysis = await analyzeChunk(chunks[i], userName, contactName, i, chunks.length);
    analyses.push(analysis);
  }

  if (onProgress) onProgress({ phase: 'merging', pass: 1, step: ++stepCounter, total: totalSteps, message: 'Pass 1: Merging analyses...' });
  const firstPassDoc = await mergeAnalyses(analyses, userName, contactName);

  // ===== PASS 2: Deep refinement =====
  if (onProgress) onProgress({ phase: 'pass2', message: 'Pass 2: Deep refinement...' });

  const refinements = [];
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress({
      phase: 'chunk', pass: 2, current: chunks.length + i + 2, total: totalSteps, step: ++stepCounter,
      message: `Pass 2: Refining chunk ${i + 1}/${chunks.length}`,
    });
    const refinement = await deepRefineChunk(chunks[i], userName, contactName, firstPassDoc, i, chunks.length);
    refinements.push(refinement);
  }

  if (onProgress) onProgress({ phase: 'merging', pass: 2, step: ++stepCounter, total: totalSteps, message: 'Pass 2: Building final document...' });

  // Enhanced merge with extra context sections
  let baseDoc = await mergeRefinements(firstPassDoc, refinements, userName, contactName);

  // ===== Verify & patch weak sections =====
  baseDoc = await verifyDocument(baseDoc, messages, userName, contactName, onProgress);

  // Append enhanced sections
  let finalDocument = baseDoc;

  // Add relationship context
  if (relationshipContext) {
    finalDocument += `\n\n## Relationship Context (provided by ${userName})\n${relationshipContext}`;
  }

  // Add topic analysis
  finalDocument += `\n\n## Topic & Content Analysis\n${topicAnalysis}`;

  // Add timing stats
  if (timingStats) {
    finalDocument += `\n\n${formatTimingStats(timingStats)}`;
  }

  // Add image context
  if (imageDescriptions && imageDescriptions.length > 0) {
    finalDocument += `\n\n## Shared Image Context\nImages commonly shared in this conversation:\n`;
    imageDescriptions.forEach((desc, i) => {
      finalDocument += `- Image ${i + 1}: ${desc}\n`;
    });
  }

  // Save
  const meta = {
    contactId,
    contactName,
    builtAt: new Date().toISOString(),
    totalMessages: messages.length,
    lastMessageTimestamp: messages[messages.length - 1]?.timestamp || 0,
    messagesSinceLastUpdate: 0,
    source: 'upload',
    hasTopicAnalysis: true,
    hasTimingStats: !!timingStats,
    hasImageContext: imageDescriptions && imageDescriptions.length > 0,
    hasRelationshipContext: !!relationshipContext,
  };

  saveDocument(contactId, finalDocument, meta);
  return { document: finalDocument, meta };
}

/**
 * Build the full relationship document from scratch.
 * Two-pass approach: first pass extracts patterns, second pass catches everything missed.
 */
async function buildDocument(contactId, contactName, onProgress, relationshipContext, profileQA) {
  const userName = config.get('userName') || 'Avin';
  const llmProvider = config.get('llmProvider') || 'openai';
  const llmModel = llmProvider === 'ollama' ? (config.get('ollamaModel') || 'llama3') : (config.get('openaiModel') || 'gpt-4o');
  console.log(`\n${'='.repeat(50)}`);
  console.log(`[Profile] Building profile for ${contactName}`);
  console.log(`[Profile] LLM: ${llmProvider}/${llmModel}`);
  console.log(`${'='.repeat(50)}`);

  // Get ALL messages for this contact (both sides, in order)
  const allMessages = await vectordb.getMessagesByContact(contactId, undefined, 5000);
  console.log(`[Profile] Found ${allMessages.length} messages in DB`);

  if (allMessages.length < 10) {
    console.log(`[Profile] Not enough messages (${allMessages.length} < 10). Aborting.`);
    return { error: `Only ${allMessages.length} messages found. Need at least 10 to build a profile.` };
  }

  // Split into chunks
  const chunks = [];
  for (let i = 0; i < allMessages.length; i += CHUNK_SIZE) {
    chunks.push(allMessages.slice(i, i + CHUNK_SIZE));
  }

  // +1 for topic analysis, +1 per pass merge
  const totalSteps = 1 + chunks.length + 1 + chunks.length + 1;
  let stepCounter = 0;

  // ===== Topic analysis =====
  if (onProgress) onProgress({ phase: 'topics', message: 'Analyzing conversation topics...', step: ++stepCounter, total: totalSteps });
  const topicAnalysis = await analyzeTopics(allMessages, userName, contactName);

  // ===== PASS 1: Initial analysis =====
  if (onProgress) onProgress({ phase: 'pass1', message: 'Pass 1: Analyzing patterns...' });

  const analyses = [];
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress({
      phase: 'chunk',
      pass: 1,
      current: i + 1,
      total: totalSteps,
      step: ++stepCounter,
      message: `Pass 1: Chunk ${i + 1}/${chunks.length}`,
    });
    const analysis = await analyzeChunk(chunks[i], userName, contactName, i, chunks.length);
    analyses.push(analysis);
  }

  if (onProgress) onProgress({
    phase: 'merging',
    pass: 1,
    step: ++stepCounter,
    total: totalSteps,
    message: 'Pass 1: Merging analyses...',
  });
  const firstPassDoc = await mergeAnalyses(analyses, userName, contactName);

  // ===== PASS 2: Deep refinement =====
  if (onProgress) onProgress({ phase: 'pass2', message: 'Pass 2: Deep refinement...' });

  const refinements = [];
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress({
      phase: 'chunk',
      pass: 2,
      current: chunks.length + i + 2,
      total: totalSteps,
      step: ++stepCounter,
      message: `Pass 2: Refining chunk ${i + 1}/${chunks.length}`,
    });
    const refinement = await deepRefineChunk(chunks[i], userName, contactName, firstPassDoc, i, chunks.length);
    refinements.push(refinement);
  }

  if (onProgress) onProgress({
    phase: 'merging',
    pass: 2,
    step: ++stepCounter,
    total: totalSteps,
    message: 'Pass 2: Building final document...',
  });
  let finalDocument = await mergeRefinements(firstPassDoc, refinements, userName, contactName);

  // ===== Verify & patch weak sections =====
  finalDocument = await verifyDocument(finalDocument, allMessages, userName, contactName, onProgress);

  // Append enhanced sections
  if (relationshipContext) {
    finalDocument += `\n\n## Relationship Context (provided by ${userName})\n${relationshipContext}`;
  }

  // Append Profile Q&A section if provided
  if (profileQA && profileQA.length > 0) {
    const qaEntries = profileQA
      .filter(qa => qa.answer && qa.answer.trim())
      .map(qa => `**Q:** ${qa.question}\n**A:** ${qa.answer}`)
      .join('\n\n');
    if (qaEntries) {
      finalDocument += `\n\n## Profile Q&A (provided by user)\n${qaEntries}`;
    }
  }

  finalDocument += `\n\n## Topic & Content Analysis\n${topicAnalysis}`;

  // Save
  const meta = {
    contactId,
    contactName,
    builtAt: new Date().toISOString(),
    totalMessages: allMessages.length,
    lastMessageTimestamp: allMessages[allMessages.length - 1]?.timestamp || 0,
    messagesSinceLastUpdate: 0,
    hasTopicAnalysis: true,
    hasRelationshipContext: !!relationshipContext,
    profileQA: profileQA || null,
    hasProfileQA: !!(profileQA && profileQA.length > 0 && profileQA.some(qa => qa.answer && qa.answer.trim())),
  };

  saveDocument(contactId, finalDocument, meta);
  console.log(`[Profile] Done! Profile saved for ${contactName} (${finalDocument.length} chars)`);
  console.log(`${'='.repeat(50)}\n`);

  return { document: finalDocument, meta };
}

/**
 * Incrementally update the document with new messages.
 * Called automatically after UPDATE_THRESHOLD new messages.
 */
async function updateDocument(contactId, contactName) {
  const userName = config.get('userName') || 'Avin';
  const existingDoc = loadDocument(contactId);
  const meta = loadMeta(contactId);

  if (!existingDoc || !meta) {
    // No existing doc, build from scratch
    return buildDocument(contactId, contactName);
  }

  // Get messages newer than what we last analyzed
  const allMessages = await vectordb.getMessagesByContact(contactId, undefined, 2000);
  const newMessages = allMessages.filter(m => m.timestamp > (meta.lastMessageTimestamp || 0));

  if (newMessages.length < 5) {
    return { document: existingDoc, meta, skipped: true };
  }

  const convo = formatConversation(newMessages, userName, contactName);

  const prompt = `Here is the existing relationship document for how "${userName}" texts "${contactName}":

${existingDoc}

---

Here are ${newMessages.length} NEW messages since the last update:

${convo}

---

Update the relationship document to incorporate these new messages.

RULES:
- Keep the SAME format and ALL existing sections — do not remove or restructure sections
- Add any new example messages that show existing patterns (more examples = better)
- Don't remove old examples, just add new ones if they're good

WHAT TO UPDATE:
1. **Language & Word Choices** (HIGHEST PRIORITY):
   - Any NEW pronouns, verb forms, spellings, or phrases in the new messages? ADD them.
   - Any word choices that have CHANGED (e.g., switched from formal to informal)? NOTE that.
   - Any new slang, filler words, or expressions? ADD them.

2. **Mood sections**:
   - Do new messages show existing moods? Add them as examples.
   - Do new messages show NEW moods not in the document? Add a new subsection.

3. **Response Patterns**:
   - Do new messages show how ${userName} responds to specific things? Add examples to the right subsection.
   - Any new response patterns? Add them.

4. **Conversation Dynamics**:
   - Any changes in who initiates, how conversations start/end?
   - New conversation starters or enders?

5. **Relationship Context**:
   - Update the current vibe based on these latest messages.
   - Any new topics, people, or events referenced?

6. **Message Structure**:
   - Have message lengths changed? New punctuation patterns? Update stats.

Write the COMPLETE updated document (keep all sections, add new content):`;

  const updated = await callLLM(
    'You update texting style documents with new data. Keep all existing content and add new findings. Be thorough and preserve the full document structure.',
    [{ role: 'user', content: prompt }],
    4000
  );

  const newMeta = {
    ...meta,
    updatedAt: new Date().toISOString(),
    totalMessages: allMessages.length,
    lastMessageTimestamp: newMessages[newMessages.length - 1]?.timestamp || meta.lastMessageTimestamp,
    messagesSinceLastUpdate: 0,
  };

  saveDocument(contactId, updated, newMeta);

  return { document: updated, meta: newMeta };
}

/**
 * Track a new message and trigger update if threshold reached.
 */
function trackNewMessage(contactId) {
  const meta = loadMeta(contactId);
  if (!meta) return false;

  meta.messagesSinceLastUpdate = (meta.messagesSinceLastUpdate || 0) + 1;
  fs.writeFileSync(getMetaPath(contactId), JSON.stringify(meta, null, 2));

  return meta.messagesSinceLastUpdate >= UPDATE_THRESHOLD;
}

/**
 * Check if a document needs updating.
 */
function needsUpdate(contactId) {
  const meta = loadMeta(contactId);
  if (!meta) return false;
  return (meta.messagesSinceLastUpdate || 0) >= UPDATE_THRESHOLD;
}

/**
 * Generate smart, context-aware profile questions by analyzing recent chat messages.
 * Returns 3-5 questions specific to this conversation for the user to answer
 * before building a profile.
 */
async function generateProfileQuestions(contactId, contactName) {
  const userName = config.get('userName') || 'Avin';

  // Fetch up to 200 recent messages
  const messages = await vectordb.getMessagesByContact(contactId, undefined, 200);
  const messageCount = messages.length;

  if (messageCount < 5) {
    // Too few messages — return generic questions
    return {
      questions: [
        { id: 'relationship', text: `What is your relationship with ${contactName}? (e.g. close friend, college buddy, coworker, sibling)` },
        { id: 'language', text: `What language(s) do you primarily use when texting ${contactName}?` },
        { id: 'vibe', text: `How would you describe the vibe/energy of your conversations with ${contactName}?` },
      ],
      messageCount,
    };
  }

  const convo = formatConversation(messages, userName, contactName);

  const prompt = `You are analyzing a WhatsApp conversation between "${userName}" and "${contactName}" (${messageCount} messages).

CONVERSATION:
${convo.slice(0, 6000)}

---

Based on what you see in this conversation, generate 3-5 smart questions to ask "${userName}" about their relationship with "${contactName}". The answers will be used to build a better AI texting profile.

RULES:
- ALWAYS include these two questions:
  1. What is your relationship with ${contactName}? (friend, partner, sibling, coworker, etc.)
  2. What language(s) do you primarily use when texting ${contactName}?
- Then add 1-3 CONTEXT-SPECIFIC questions based on what you observe in the conversation. Examples:
  - If you see inside jokes, ask about them
  - If you see references to specific people/places/events, ask about them
  - If you see recurring topics, ask about them
  - If you see a distinct mood pattern, ask about it
  - If you see media/memes being shared, ask what kind
- Make questions specific to THIS conversation, not generic
- Keep questions concise and easy to answer
- Each question should help the AI understand context that isn't obvious from the messages alone

OUTPUT FORMAT (strict JSON array):
[
  {"id": "relationship", "text": "question text here"},
  {"id": "language", "text": "question text here"},
  {"id": "topic1", "text": "question text here"}
]`;

  try {
    const result = await callLLM(
      'You generate smart profile-building questions based on conversation analysis. Output strict JSON only.',
      [{ role: 'user', content: prompt }],
      500
    );

    // Parse the JSON from the response
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const questions = JSON.parse(jsonMatch[0]);
      if (Array.isArray(questions) && questions.length >= 2) {
        return { questions, messageCount };
      }
    }
  } catch (err) {
    console.error(`[StyleProfiler] Failed to generate smart questions: ${err.message}`);
  }

  // Fallback: generic questions
  return {
    questions: [
      { id: 'relationship', text: `What is your relationship with ${contactName}? (e.g. close friend, college buddy, coworker, sibling)` },
      { id: 'language', text: `What language(s) do you primarily use when texting ${contactName}?` },
      { id: 'vibe', text: `How would you describe the vibe/energy of your conversations with ${contactName}?` },
    ],
    messageCount,
  };
}

module.exports = {
  buildDocument,
  buildDocumentFromUpload,
  verifyDocument,
  updateDocument,
  loadDocument,
  loadMeta,
  trackNewMessage,
  needsUpdate,
  analyzeTopics,
  generateProfileQuestions,
  UPDATE_THRESHOLD,
};
