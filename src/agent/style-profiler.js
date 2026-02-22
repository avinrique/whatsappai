const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const vectordb = require('../data/vectordb');
const { callLLM } = require('./llm');
const { formatTimingStats } = require('../data/chat-parser');

const DOCS_DIR = path.join(config.DATA_DIR, 'style-profiles');
const CHUNK_SIZE = 80; // messages per LLM chunk
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
  const convo = formatConversation(chunk, userName, contactName);

  const prompt = `You are analyzing a WhatsApp conversation chunk (${chunkIndex + 1}/${totalChunks}) between "${userName}" and "${contactName}".

CONVERSATION:
${convo}

Analyze ONLY how "${userName}" texts in this chunk. Focus on:
1. What moods/emotional states appear? (happy, annoyed, fighting, flirty, sad, casual, etc.)
2. For EACH mood you see, give 5-8 EXACT message examples from ${userName} (copy them WORD FOR WORD, character for character)
3. Texting patterns: message length, emoji, slang, capitalization, language mixing
4. How does ${userName} respond to different things ${contactName} says?
5. Any notable conversation dynamics (who initiates, response speed patterns, topic changes)

LANGUAGE & WORD CHOICE (CRITICAL — pay very close attention):
6. What language(s) does ${userName} use? (English, Nepali, Hindi, Romanized Nepali/Hindi, mix, etc.)
7. EXACT pronouns and address forms ${userName} uses for ${contactName} — e.g. "timi" vs "ta" vs "tapai", "tero" vs "timro" vs "tapako". List every instance you find with the exact message.
8. EXACT verb conjugations ${userName} uses — e.g. "xau" vs "xas" vs "hunuhunxa", "garxau" vs "garxas", "aau" vs "aa". Copy the exact verb forms used.
9. Specific spelling choices and transliteration habits — e.g. does ${userName} write "cha" or "xa" or "chha"? "hai" or "ha"? "kasto" or "ksto"? "garo" or "garyo"?
10. Recurring phrases, greetings, sign-offs, filler words that ${userName} always uses. Copy them exactly.

For points 6-10, list EVERY example you find. These exact word choices are the most important part of the analysis. The AI must replicate these EXACTLY.

Write your analysis as plain text, organized by section. Include as many exact example messages as possible. Be specific, not generic.`;

  return callLLM(
    'You extract texting patterns from conversations with extreme attention to exact word choices, pronouns, verb forms, and spelling. Always copy messages word-for-word.',
    [{ role: 'user', content: prompt }],
    1500
  );
}

/**
 * Merge all chunk analyses into one relationship document.
 */
async function mergeAnalyses(analyses, userName, contactName) {
  const combined = analyses.map((a, i) => `--- CHUNK ${i + 1} ANALYSIS ---\n${a}`).join('\n\n');

  const prompt = `You have ${analyses.length} chunk analyses of how "${userName}" texts "${contactName}" on WhatsApp.

ALL ANALYSES:
${combined}

Now create ONE comprehensive relationship document. Use this EXACT format:

# How ${userName} texts ${contactName}

## Language & Word Choices (MOST IMPORTANT SECTION)
This section is CRITICAL. The AI must use these EXACT words, not synonyms or alternatives.

### Pronouns & Address Forms
(What pronoun does ${userName} use for ${contactName}? "timi"/"ta"/"tapai"? "timro"/"tero"/"tapako"? List the EXACT forms used with 5+ example messages. NEVER substitute one form for another.)

### Verb Conjugations
(What verb endings does ${userName} use? e.g. "xau"/"xas"/"hunuhunxa", "garxau"/"garxas", "aau"/"aa"/"aaunus". These MUST match the pronoun form. List 5+ examples.)

### Spelling & Transliteration
(How does ${userName} spell specific words? e.g. "xa" vs "cha", "xau" vs "chau", "k" vs "ke", "ksto" vs "kasto". List every distinct spelling choice found.)

### Recurring Phrases & Fillers
(Phrases ${userName} uses repeatedly — greetings, sign-offs, reactions, filler words. 5+ exact examples.)

## General Style
(Overall texting patterns: message length, emoji habits, capitalization, slang, language mixing. Be specific with numbers and examples.)

## When things are normal/casual
(How ${userName} texts in regular everyday conversation. 5-8 EXACT example messages.)

## When happy/excited
(How the texting changes when ${userName} is happy or excited. 5-8 EXACT examples.)

## When annoyed/angry/fighting
(How ${userName} texts when upset with ${contactName}. 5-8 EXACT examples. Note how messages get shorter/drier/etc.)

## When caring/concerned
(How ${userName} shows care. 5-8 EXACT examples.)

## When joking/playful
(Humor style. 5-8 EXACT examples.)

## Other moods
(Any other distinct moods you noticed. EXACT examples for each.)

## Response patterns
(How ${userName} typically responds to: questions, news, complaints, jokes, voice notes, media. With examples.)

## Conversation dynamics
(Who initiates more, how conversations start/end, any recurring patterns.)

## Current relationship vibe
(Based on the most recent messages, what's the current state of the relationship.)

IMPORTANT RULES:
- Every section MUST have real example messages copied EXACTLY from the analyses — word for word, character for character.
- The Language & Word Choices section is the HIGHEST PRIORITY. If ${userName} uses "timi" never output "ta". If they write "xau" never output "xas". These are NOT interchangeable.
- Include MORE examples rather than fewer. 5-8 per section minimum.
- If a section has no data, write "No clear pattern found" and skip it.
- Do NOT make up examples. Only use what appears in the analyses.`;

  return callLLM(
    'You create comprehensive texting style documents with extreme precision on word choices, pronouns, verb conjugations, and spelling. Always include exact example messages copied word-for-word. Never make up examples.',
    [{ role: 'user', content: prompt }],
    3500
  );
}

/**
 * Second pass: re-analyze all messages WITH the first-pass document as context.
 * Catches everything missed, adds more examples, corrects errors.
 */
async function deepRefineChunk(chunk, userName, contactName, existingDoc, chunkIndex, totalChunks) {
  const convo = formatConversation(chunk, userName, contactName);

  const prompt = `You are doing a DEEP SECOND PASS analysis of a WhatsApp conversation chunk (${chunkIndex + 1}/${totalChunks}) between "${userName}" and "${contactName}".

Here is the document from the first pass:
${existingDoc}

---

CONVERSATION CHUNK TO RE-ANALYZE:
${convo}

---

The first pass may have MISSED things. Your job is to find EVERYTHING the first pass missed. Go through EVERY single message from ${userName} and extract:

1. **Missed examples** — messages that show patterns already in the document but weren't included as examples. Copy them EXACTLY.
2. **Missed patterns** — any texting habit, mood, word choice, or style not captured in the document.
3. **Corrections** — if the document says ${userName} does X but you see them doing Y in this chunk, note it.
4. **Language details missed** — ANY word, pronoun, verb form, spelling, slang, filler, or phrase that isn't in the document. Even one-word messages matter.
5. **Conversation starters** — how does ${userName} start conversations? What's the first message they typically send?
6. **Reactions** — how does ${userName} react to good news, bad news, jokes, questions, media, voice notes?
7. **Message structure** — does ${userName} send one long message or multiple short ones? Do they use punctuation? Line breaks?
8. **Time patterns** — do they text differently at different times? Short messages late at night vs longer ones during the day?

List EVERY finding with the EXACT message copied word-for-word. Even if it seems minor — include it. More is better.`;

  return callLLM(
    'You do deep second-pass analysis of conversations. You find everything the first pass missed. You copy every message word-for-word.',
    [{ role: 'user', content: prompt }],
    1500
  );
}

/**
 * Merge the first-pass document with second-pass refinements into a final detailed document.
 */
async function mergeRefinements(firstPassDoc, refinements, userName, contactName) {
  const combined = refinements.map((r, i) => `--- REFINEMENT ${i + 1} ---\n${r}`).join('\n\n');

  const prompt = `You have a first-pass relationship document and ${refinements.length} second-pass refinements for how "${userName}" texts "${contactName}".

FIRST PASS DOCUMENT:
${firstPassDoc}

---

SECOND PASS REFINEMENTS (new findings, missed examples, corrections):
${combined}

---

Create the FINAL, DEFINITIVE relationship document. This must be EXTREMELY detailed — it's the complete guide for an AI to perfectly replicate how ${userName} texts ${contactName}.

Rules:
- Keep the same section format as the first pass document.
- MERGE all new examples from the refinements into the appropriate sections.
- If refinements found corrections, apply them (e.g., if first pass said "uses ta" but refinements show "uses timi", fix it).
- If refinements found new patterns or moods, add new subsections.
- EVERY section should now have 8-15 EXACT example messages minimum.
- The Language & Word Choices section should be EXHAUSTIVE — every pronoun, verb form, spelling variant, and recurring phrase.
- Add a new section "## Message Structure & Habits" covering: message length, single vs multiple messages, punctuation, line breaks, time-of-day patterns.
- Add a new section "## Conversation Starters & Openers" with exact examples of how ${userName} initiates conversations.
- Add a new section "## Reactions & Responses" covering how ${userName} reacts to specific things (good news, bad news, jokes, media, etc.)
- The document should be LONG and DETAILED. More is better. This is the AI's only reference for texting as ${userName}.
- Do NOT make up examples. Only use what appears in the first pass and refinements.
- Copy all examples EXACTLY — word for word, character for character.

Write the COMPLETE final document:`;

  return callLLM(
    'You create the most detailed, comprehensive texting style documents possible. You merge first-pass and second-pass findings into one exhaustive guide. Every example is copied word-for-word. You never make up examples.',
    [{ role: 'user', content: prompt }],
    4096
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
  if (onProgress) onProgress({ phase: 'verifying', message: 'Verifying document quality...' });

  // Step 1: Ask LLM to audit the document
  const auditPrompt = `You are a strict quality auditor for a texting style document. This document is used by an AI to perfectly replicate how "${userName}" texts "${contactName}" on WhatsApp.

DOCUMENT TO AUDIT:
${document}

---

Audit each section. For EACH section, answer:
1. Does it contain REAL, EXACT example messages copied word-for-word? (not paraphrased, not summarized, not described)
2. How many exact example messages does it have? (count messages in quotes or on their own lines that look like real texts)
3. Are the examples specific enough to be useful? ("he says casual things" = USELESS. "he says 'khai bro kasto xau'" = USEFUL)

Mark each section as:
- PASS: Has 5+ real exact examples that are specific
- WEAK: Has 1-4 examples, or examples seem vague/generic/possibly made up
- FAIL: No real examples at all, just descriptions or summaries

Output format — one line per section:
SECTION_NAME: PASS/WEAK/FAIL — reason (count of real examples found)

At the end, list ALL sections that got WEAK or FAIL.`;

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

  const patchPrompt = `A style document for how "${userName}" texts "${contactName}" was audited and these sections were found WEAK or FAILING:

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

Your job: Rewrite the COMPLETE document. For every section that was WEAK or FAIL:
1. Find REAL messages from the raw examples above that fit that section
2. Add them as exact examples (copy word-for-word, no modifications)
3. Each section needs 5-8+ real examples minimum

For sections that PASSED: keep them exactly as they are.

RULES:
- ONLY use messages that actually appear in the raw examples above. Do NOT make up messages.
- Copy messages CHARACTER FOR CHARACTER. Don't fix spelling, don't add punctuation, don't translate.
- If you truly can't find enough examples for a section, write "Limited examples found — need more data" and include whatever you found.
- Keep all existing PASS sections intact — do not remove good content.

Write the COMPLETE patched document:`;

  const patched = await callLLM(
    'You patch style documents by inserting REAL examples from raw message data. You never make up messages. You copy them character-for-character from the provided data.',
    [{ role: 'user', content: patchPrompt }],
    4096
  );

  return patched;
}

/**
 * Analyze conversation topics — WHAT do they talk about, not just HOW they type.
 */
async function analyzeTopics(messages, userName, contactName) {
  // Sample up to 500 messages spread across the conversation
  const step = Math.max(1, Math.floor(messages.length / 500));
  const sampled = messages.filter((_, i) => i % step === 0).slice(0, 500);
  const convo = formatConversation(sampled, userName, contactName);

  const prompt = `Analyze this WhatsApp conversation between "${userName}" and "${contactName}".

CONVERSATION SAMPLE (${sampled.length} messages):
${convo}

Identify:
1. **Main Topics**: What do they discuss most? (work, school, relationships, hobbies, plans, etc.)
2. **Inside Jokes**: Any recurring jokes, references, or memes they share?
3. **Shared Interests**: Games, shows, music, sports, people they both reference?
4. **Recurring Subjects**: Things that come up again and again (a specific friend, a place, an event, a habit)?
5. **Current Context**: What seems to be going on in their lives right now based on recent messages?
6. **Conversation Starters**: How do conversations typically begin? What triggers a new exchange?

Be specific. Use exact examples from the conversation. This analysis helps an AI understand WHAT to talk about, not just how to type.`;

  return callLLM(
    'You analyze conversation content and topics. Be specific with exact examples.',
    [{ role: 'user', content: prompt }],
    1200
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

  // Get ALL messages for this contact (both sides, in order)
  const allMessages = await vectordb.getMessagesByContact(contactId, undefined, 5000);

  if (allMessages.length < 10) {
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

Update the relationship document to incorporate these new messages. Rules:
- Keep the same format and sections
- Add any new example messages that show patterns
- Update "Current relationship vibe" based on these latest messages
- If you see new moods or patterns not in the original doc, add them
- Don't remove old examples, just add new ones if they're good
- Update any stats that changed (like if messages got shorter/longer recently)
- PAY SPECIAL ATTENTION to the "Language & Word Choices" section — if you see new pronoun usage, verb conjugations, spelling patterns, or recurring phrases in the new messages, add them
- If any word choices have CHANGED (e.g. switched from formal to informal), note that in the document

Write the COMPLETE updated document:`;

  const updated = await callLLM(
    'You update texting style documents with new data. Keep all existing examples and add new ones.',
    [{ role: 'user', content: prompt }],
    2500
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
