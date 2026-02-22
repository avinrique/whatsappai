/**
 * Chain-of-thought reply engine.
 * Think → Decide → Write → Verify → Rewrite (if needed)
 * Each step is a separate LLM call informed by the previous step's output.
 *
 * KEY DESIGN RULES:
 * - If verifier fails ALL retries, return null — DO NOT SEND a bad message.
 * - Feed real recent messages as examples so the LLM sees actual message lengths.
 * - Be extremely strict about message length — the user texts in 1-5 words typically.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config/config');
const vectordb = require('../data/vectordb');
const styleProfiler = require('./style-profiler');
const { callLLM, callOpenAIWithVision } = require('./llm');

// ─── ANSI colors ───
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  gray: '\x1b[90m',
};

const STEP_COLORS = {
  Think: C.cyan,
  Decide: C.magenta,
  Write: C.yellow,
  Verify: C.blue,
  Rewrite: C.red,
};

const LOGS_DIR = path.join(config.DATA_DIR, 'chain-logs');

/**
 * ChainLogger — logs every chain step to terminal (colored) and file.
 */
class ChainLogger {
  constructor(contactId, contactName) {
    this.contactId = contactId;
    this.contactName = contactName;
    this.lines = [];
    this.startTime = Date.now();

    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }

    const safe = contactId.replace(/[^a-zA-Z0-9]/g, '_');
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    this.logFile = path.join(LOGS_DIR, `${safe}_${ts}.log`);

    const header = `Chain Log: ${contactName} (${contactId})\nStarted: ${new Date().toISOString()}\n${'='.repeat(60)}`;
    this.lines.push(header);
  }

  _ts() {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    return `+${elapsed}s`;
  }

  logStep(stepName, { input, output, status, extra } = {}) {
    const color = STEP_COLORS[stepName] || C.gray;
    const ts = this._ts();
    const wordCount = output ? output.split(/\s+/).length : 0;
    const statusTag = status === 'pass' ? `${C.green}PASS${C.reset}` : status === 'fail' ? `${C.red}FAIL${C.reset}` : '';

    // Terminal output
    console.log(`  ${color}${C.bold}[${stepName}]${C.reset} ${C.gray}${ts}${C.reset} ${statusTag ? `(${statusTag}) ` : ''}${C.dim}${wordCount} words${C.reset}`);
    if (extra) {
      console.log(`  ${C.gray}  └─ ${extra}${C.reset}`);
    }

    // File accumulation
    const fileLine = [
      `\n--- ${stepName} [${ts}] ${status ? `(${status.toUpperCase()})` : ''} ---`,
      `Words: ${wordCount}`,
      extra ? `Note: ${extra}` : null,
      input ? `Input: ${String(input).slice(0, 200)}...` : null,
      output ? `Output:\n${output}` : null,
    ].filter(Boolean).join('\n');
    this.lines.push(fileLine);
  }

  logFinal(decision, reply) {
    const ts = this._ts();
    const totalMs = Date.now() - this.startTime;
    const color = decision === 'SKIPPED' ? C.yellow : decision === 'SENT_SUGGESTION' ? C.magenta : reply ? C.green : C.red;
    const label = decision || (reply ? 'SENT' : 'NO_SEND');

    // Terminal
    console.log(`  ${color}${C.bold}[Final]${C.reset} ${C.gray}${ts}${C.reset} ${color}${label}${C.reset}${reply ? `: "${reply}"` : ''} ${C.dim}(${totalMs}ms total)${C.reset}`);

    // File
    this.lines.push(`\n${'='.repeat(60)}\nFINAL: ${label}\nReply: ${reply || '(none)'}\nTotal time: ${totalMs}ms\n`);

    // Flush to disk
    try {
      fs.writeFileSync(this.logFile, this.lines.join('\n'), 'utf-8');
    } catch (err) {
      console.error(`  ${C.red}[Chain] Failed to write log file: ${err.message}${C.reset}`);
    }
  }
}

/**
 * Common 1-word auto-reply outputs that pollute style stats.
 * If the ONLY outgoing messages are these, stats become avg=1 and the bot
 * keeps spamming the same filler words forever.
 */
const AUTO_REPLY_FILLER = new Set([
  'khai', 'hmm', 'okey', 'ok', 'haha', 'lol', 'ohh', 'ahh', 'hm',
  'yes', 'no', 'yep', 'nah', 'sure', 'nice', 'wow', 'damn',
]);

/**
 * Check if a message body looks like a generic auto-reply filler.
 */
function isLikelyAutoFiller(body) {
  if (!body) return false;
  const words = body.trim().split(/\s+/);
  if (words.length > 2) return false; // 3+ word messages are real enough
  return AUTO_REPLY_FILLER.has(words[0].toLowerCase());
}

/**
 * Extract real message examples from conversation flow for the user.
 * EXCLUDES auto-reply filler so the LLM sees the user's REAL style.
 */
function extractUserExamples(conversationFlow, userName, maxExamples = 15) {
  if (!conversationFlow) return '';
  const lines = conversationFlow.split('\n');
  const userMsgs = [];
  for (const line of lines) {
    if (line.startsWith(`[${userName}]`)) {
      const body = line.replace(/^\[[^\]]+\](?:\s*\([^)]*\))?:\s*/, '').trim();
      if (body && body.length > 0 && !body.startsWith('[File:') && !body.startsWith('http')) {
        userMsgs.push(body);
      }
    }
  }
  // Separate real messages from filler
  const real = userMsgs.filter(m => !isLikelyAutoFiller(m));
  // If most messages are filler, still show some but prefer real ones
  const pool = real.length >= 3 ? real : userMsgs;
  return pool.slice(-maxExamples).map(m => `"${m}"`).join(', ');
}

/**
 * Calculate word count RANGE from user's REAL messages (excluding auto-reply filler).
 * Returns { min, avg, max, p75, upper } so prompts use flexible limits.
 */
function getWordCountStats(conversationFlow, userName) {
  const defaults = { min: 1, avg: 3, max: 8, p75: 5, upper: 8 };
  if (!conversationFlow) return defaults;
  const lines = conversationFlow.split('\n');
  const allLengths = [];
  const realLengths = [];
  for (const line of lines) {
    if (line.startsWith(`[${userName}]`)) {
      const body = line.replace(/^\[[^\]]+\](?:\s*\([^)]*\))?:\s*/, '').trim();
      if (body && body.length > 0 && !body.startsWith('[File:') && !body.startsWith('http')) {
        const wc = body.split(/\s+/).length;
        allLengths.push(wc);
        if (!isLikelyAutoFiller(body)) {
          realLengths.push(wc);
        }
      }
    }
  }

  // Use real messages if we have enough; otherwise fall back to all
  const lengths = realLengths.length >= 3 ? realLengths : allLengths;
  if (lengths.length === 0) return defaults;

  lengths.sort((a, b) => a - b);
  const min = lengths[0];
  const max = lengths[lengths.length - 1];
  const avg = Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length);
  const p75Index = Math.floor(lengths.length * 0.75);
  const p75 = lengths[p75Index] || avg;
  // Upper bound: at least avg+3, p75, or 5 — whichever is highest
  const upper = Math.max(avg + 3, p75, 5);

  return { min, avg, max, p75, upper };
}

// ─── Emergency Detection ───
const EMERGENCY_KEYWORDS = [
  'dying', 'die', 'dead', 'death', 'killed',
  'accident', 'crash', 'hospital', 'emergency',
  'help me', 'save me', 'killing', 'suicide',
  'blood', 'ambulance', 'police',
  'hurt', 'injured', 'attack', 'danger',
  'serious problem', 'critical', 'urgent',
  // Hindi/Nepali
  'marna', 'mar gaya', 'mar raha', 'bachao', 'maddat',
];

/**
 * Detect if a message contains emergency/crisis content.
 */
function detectEmergency(message) {
  if (!message) return false;
  const lower = message.toLowerCase();
  return EMERGENCY_KEYWORDS.some(kw => lower.includes(kw));
}

/**
 * Step 1 — Think: Deep situational analysis of the conversation.
 */
async function think(userName, contactName, conversationFlow, incomingMessage, imageDescriptions, relationshipDoc, qaContext) {
  const systemPrompt = `You are an expert conversation analyst reading a WhatsApp chat between "${userName}" and "${contactName}". Your job is to deeply understand what's happening so the AI can write a perfect reply. Be specific, cite actual messages, and be brutally honest about what you know vs don't know.`;

  let userPrompt = '';

  if (relationshipDoc) {
    userPrompt += `WHO THEY ARE TO EACH OTHER:\n${relationshipDoc.slice(0, 2000)}\n\n`;
  }

  if (qaContext) {
    userPrompt += `PROFILE Q&A (provided by the user about this relationship):\n${qaContext}\n\n`;
  }

  if (conversationFlow) {
    userPrompt += `FULL CONVERSATION FLOW (read EVERY message carefully, in order):\n${conversationFlow}\n\n`;
  }

  userPrompt += `LATEST MESSAGE(S) from ${contactName}:\n"${incomingMessage}"\n\n`;

  if (imageDescriptions && imageDescriptions.length > 0) {
    userPrompt += `IMAGES ${contactName} SENT (you CAN see these):\n${imageDescriptions.map((d, i) => `Image ${i + 1}: ${d}`).join('\n')}\n\nSince you can see the image(s), react to their content naturally — comment on what you see, react to it, joke about it, etc. Do NOT just say "Hmm" when someone sends you an image.\n\n`;
  } else if (incomingMessage === '[image]' || incomingMessage.includes('[image]')) {
    userPrompt += `⚠️ ${contactName} SENT AN IMAGE but we could NOT see its contents. A real person would be curious — ask what it is, react with interest. Do NOT just ignore it. Say something like "K ho yo?", "Dekhau ta", "K pathako?" etc.\n\n`;
  }

  userPrompt += `IMPORTANT: Messages tagged [AI-GENERATED] in the conversation were written by the AI, NOT by ${userName}. Do NOT use those as examples of ${userName}'s style — they may be repetitive filler. Focus on ${userName}'s REAL (untagged) messages for style cues.

Analyze CAREFULLY:

1. CONVERSATION ARC: What have they been discussing? Trace the topic(s). What was the flow?

2. RIGHT NOW: What is ${contactName} saying/asking in their LATEST message(s)? Quote their words. What do they expect back?

3. DOES THIS NEED SPECIFIC KNOWLEDGE? Is ${contactName} asking about something that requires real-world facts the AI wouldn't know (like "did you finish?", "where are you?", "what time is the meeting?")? If yes, say clearly: "NEEDS REAL-WORLD KNOWLEDGE — AI should dodge."

4. MOOD & TONE: What's the vibe? (casual, serious, excited, annoyed, etc.)

5. WHAT ${userName} WOULD NATURALLY DO: Consider what a real person would say. ${userName} is casual and brief — but still gives REAL answers when asked direct questions. Would ${userName}:
   - Give a short direct answer? (e.g., "Om collection ramro", "Bholi free xu")
   - Deflect/dodge because it needs info the AI doesn't have?
   - Ask a follow-up question? (e.g., "Kata janay?", "Kaile?")
   - Just react? ("Okey", "Hmm") — ONLY if the message truly needs no real answer
   Note: Do NOT default to filler ("Khai", "Hmm") when a real answer is possible.

6. CONFIDENCE: HIGH/MEDIUM/LOW — can the AI write a good reply? If LOW, explain why.`;

  return callLLM(systemPrompt, [{ role: 'user', content: userPrompt }], 400);
}

/**
 * Step 2 — Decide: What should the reply convey and what form.
 */
async function decide(userName, contactName, thinkOutput, relationshipDoc, incomingMessage, conversationFlow, qaContext, wordStats, isEmergency, imageDescriptions) {
  const userExamples = extractUserExamples(conversationFlow, userName);
  const s = wordStats;
  const effectiveUpper = isEmergency ? 15 : s.upper;
  const hasImages = imageDescriptions && imageDescriptions.length > 0;
  const sentImageButCantSee = !hasImages && (incomingMessage === '[image]' || incomingMessage.includes('[image]'));

  let systemPrompt = `You are deciding what "${userName}" should text back to "${contactName}" on WhatsApp. Think like a real person, not a helpful AI.

MESSAGE LENGTH FACTS: ${userName}'s messages range from ${s.min} to ${s.max} words. Average is ${s.avg}, but 75th percentile is ${s.p75}. The length should fit the SITUATION — simple acknowledgements can be 1-2 words, real answers can go up to ${effectiveUpper} words.
${userName}'s REAL recent messages: ${userExamples || '(none available)'}

The reply should feel natural for the situation — short for casual, longer when the topic needs it.`;

  if (isEmergency) {
    systemPrompt += `\n\n⚠️ EMERGENCY DETECTED: "${contactName}" seems to be in distress or danger. This is NOT the time for short casual replies. Respond with genuine concern. Up to ${effectiveUpper} words is acceptable. Show you care. Ask what happened / if they're okay / how you can help.`;
  }

  let userPrompt = `SITUATION ANALYSIS:\n${thinkOutput}\n\n`;
  userPrompt += `${contactName}'s LATEST: "${incomingMessage}"\n\n`;

  if (relationshipDoc) {
    userPrompt += `${userName}'s STYLE DOCUMENT:\n${relationshipDoc.slice(0, 2500)}\n\n`;
  }

  if (qaContext) {
    userPrompt += `PROFILE Q&A (user-provided context about this relationship):\n${qaContext}\n\n`;
  }

  if (hasImages) {
    userPrompt += `IMAGE CONTEXT: ${contactName} sent image(s). You CAN see them:\n${imageDescriptions.map((d, i) => `Image ${i + 1}: ${d}`).join('\n')}\nReact to what you see — comment, joke, ask about it. Do NOT ignore the image.\n\n`;
  } else if (sentImageButCantSee) {
    userPrompt += `IMAGE CONTEXT: ${contactName} sent an image but you CANNOT see it. Be curious! Ask what it is. A real person would say something like "K ho yo?", "K pathako?", "Dekhau ta". Do NOT just say "Hmm".\n\n`;
  }

  userPrompt += `DECIDE — IMPORTANT: Do NOT default to filler words like "Khai" or "Hmm" unless the message TRULY needs no real answer. If ${contactName} asks a question, give a REAL answer (even if short). Only use filler for pure small talk or when the AI genuinely can't answer.

IF ${contactName} SENT AN IMAGE:
→ React to the image! Comment on it, ask about it, show curiosity. Never just "Hmm" for an image.

IF THE AI CAN'T KNOW THE ANSWER (the analysis says "NEEDS REAL-WORLD KNOWLEDGE"):
→ DODGE with a question back or vague deflection — but NOT just "Khai" repeatedly. Vary the dodge.

IF ${contactName} ASKS A QUESTION (opinion, plan, suggestion):
→ Give a SHORT but REAL answer. 2-${effectiveUpper} words. Not filler.

IF IT'S SIMPLE CHAT / SMALL TALK:
→ Reply naturally. 1-${effectiveUpper} words depending on what's needed.

IF ${contactName} IS SHARING INFO/NEWS:
→ React briefly but show you engaged: "Ohh thik xa", "Ahh ramro", etc.
${isEmergency ? `\nIF EMERGENCY/DISTRESS:\n→ Respond with concern. Ask if they are okay. Be caring. Up to ${effectiveUpper} words is fine.\n` : ''}
NOW DECIDE:
1. INTENT: What should the reply convey? (1 sentence)
2. DODGE OR COMMIT: Should the AI dodge? Only if the answer requires real-world knowledge the AI doesn't have.
3. LENGTH: How many words? (1-${effectiveUpper}, fit the situation — questions deserve 2+ word answers)
4. LANGUAGE: What language? (match the conversation)
5. TEMPLATE: Quote 1-2 of ${userName}'s REAL messages that this reply should look like
6. AVOID: What must the reply NOT do? (avoid repeating "Khai"/"Hmm" if already used recently)`;

  return callLLM(systemPrompt, [{ role: 'user', content: userPrompt }], 350);
}

/**
 * Step 3 — Write: Generate the actual message.
 */
async function write(userName, contactName, decideOutput, thinkOutput, relationshipDoc, conversationFlow, incomingMessage, wordStats, isEmergency, imageDescriptions) {
  const userExamples = extractUserExamples(conversationFlow, userName);
  const s = wordStats;
  const effectiveUpper = isEmergency ? 15 : s.upper;
  const hasImages = imageDescriptions && imageDescriptions.length > 0;
  const sentImageButCantSee = !hasImages && (incomingMessage === '[image]' || incomingMessage.includes('[image]'));

  let systemPrompt = `You are ghostwriting as "${userName}" on WhatsApp, texting "${contactName}".

RULE #1: Match ${userName}'s typical message length. Usually ${s.avg}-${s.upper} words, depending on the situation. Simple replies can be ${s.min}-${s.avg} words. More substantive replies up to ${effectiveUpper} words.
RULE #2: Text IDENTICALLY to ${userName}. Not similar. IDENTICAL style.
RULE #3: The reply must make sense in the conversation flow.

${userName}'s REAL recent messages for reference: ${userExamples || '(check the style doc)'}

Match the length to the SITUATION. Casual = short. Needs a real answer = can be longer.`;

  if (hasImages) {
    systemPrompt += `\n\n📷 IMAGE: ${contactName} sent image(s) you can see:\n${imageDescriptions.map((d, i) => `Image ${i + 1}: ${d}`).join('\n')}\nReact to the image naturally — comment on what you see, like a real friend would.`;
  } else if (sentImageButCantSee) {
    systemPrompt += `\n\n📷 IMAGE: ${contactName} sent an image but you CANNOT see it. Be curious! Ask what it shows. Examples: "K ho yo?", "K pathako?", "Dekhau ta", "Ke xa tyo ma?"`;
  }

  if (isEmergency) {
    systemPrompt += `\n\n⚠️ EMERGENCY: ${contactName} is in distress. Respond with genuine concern. Up to ${effectiveUpper} words is fine. Show you care.`;
  }

  if (relationshipDoc) {
    systemPrompt += `\n\n========== STYLE DOCUMENT ==========\n${relationshipDoc}\n========== END STYLE DOCUMENT ==========`;
  }

  systemPrompt += `\n\nABSOLUTE BANS:
- NEVER write more than ${effectiveUpper} words.
- NEVER write in a polished, formal style. ${userName} writes casually — fragments, not essays.
- NEVER use generic AI phrases.
- NEVER write in English if ${userName} texts in Nepali/mixed.
- NEVER make up facts. Dodge if unsure.
- NEVER sound helpful, enthusiastic, or formal. Be lazy and casual like a real person.
- NEVER repeat the same filler word ("Khai", "Hmm") if it was already used in recent messages. Vary your responses. If asked a real question, give a real answer — not filler.
- NEVER ignore an image with just "Hmm". React to it or ask about it.`;

  let userPrompt = '';
  if (conversationFlow) {
    userPrompt += `CONVERSATION:\n${conversationFlow}\n\n`;
  }
  userPrompt += `${contactName} just sent: "${incomingMessage}"\n\n`;
  userPrompt += `DECISION:\n${decideOutput}\n\n`;
  userPrompt += `Write ONLY the message text. ${s.avg}-${effectiveUpper} words depending on context. Be ${userName}.`;

  const reply = await callLLM(systemPrompt, [{ role: 'user', content: userPrompt }], 100);

  // Clean up
  let cleaned = reply.replace(/^["']|["']$/g, '').trim();
  const prefix = `${userName}:`;
  if (cleaned.toLowerCase().startsWith(prefix.toLowerCase())) {
    cleaned = cleaned.slice(prefix.length).trim();
  }
  const bracketPrefix = `[${userName}]:`;
  if (cleaned.toLowerCase().startsWith(bracketPrefix.toLowerCase())) {
    cleaned = cleaned.slice(bracketPrefix.length).trim();
  }

  return cleaned;
}

/**
 * Step 4 — Verify: Check if the reply is good enough to send.
 * Returns { pass, reason, suggestion }
 */
async function verify(userName, contactName, reply, incomingMessage, conversationFlow, relationshipDoc, wordStats, isEmergency) {
  const userExamples = extractUserExamples(conversationFlow, userName);
  const s = wordStats;
  const effectiveUpper = isEmergency ? 15 : s.upper;
  const replyWordCount = reply.split(/\s+/).length;

  // Hard fail: only if WAY beyond the upper bound (2x+ the effective limit)
  if (replyWordCount > effectiveUpper * 2 && replyWordCount > 12) {
    return {
      pass: false,
      reason: `Reply is ${replyWordCount} words — way beyond the ${effectiveUpper}-word upper limit for this context.`,
      suggestion: `Shorten to around ${s.avg}-${effectiveUpper} words. Use fragments like: ${userExamples.split(',').slice(0, 3).join(',')}`,
    };
  }

  let systemPrompt = `You are a quality checker for AI-generated WhatsApp messages. You check if a reply would pass as a REAL message from "${userName}".

LENGTH CONTEXT: ${userName}'s messages range from ${s.min} to ${s.max} words. Average is ${s.avg}, 75th percentile is ${s.p75}. The acceptable range for this reply is ${s.avg}-${effectiveUpper} words depending on the situation. The generated reply is ${replyWordCount} words.
${userName}'s REAL messages: ${userExamples || '(none available)'}`;

  if (isEmergency) {
    systemPrompt += `\n\n⚠️ EMERGENCY SITUATION: ${contactName} appears to be in distress. Replies showing concern and being up to ${effectiveUpper} words are ACCEPTABLE. Do NOT fail for being "too long" if the reply shows genuine care.`;
  }

  let userPrompt = '';

  if (conversationFlow) {
    userPrompt += `RECENT CONVERSATION:\n${conversationFlow}\n\n`;
  }

  userPrompt += `${contactName} JUST SENT: "${incomingMessage}"
AI'S REPLY AS ${userName}: "${reply}"\n\n`;

  if (relationshipDoc) {
    const langSection = relationshipDoc.match(/## Language & Word Choices[\s\S]*?(?=\n## [A-Z])/i)?.[0] || '';
    const styleSection = relationshipDoc.match(/## General Style[\s\S]*?(?=\n## [A-Z])/i)?.[0] || '';
    userPrompt += `STYLE REFERENCE:\n${langSection}\n${styleSection}\n\n`;
  }

  userPrompt += `CHECK — FAIL only if the reply is genuinely bad:

1. LENGTH: Is "${reply}" within 1-${effectiveUpper} words? A few words over is okay if the content warrants it. Only FAIL if it's dramatically longer than ${effectiveUpper} words.

2. CONVERSATION FIT: Does it make sense after what ${contactName} said? Is it on-topic?

3. FILLER SPAM: If ${contactName} asked a real question and the reply is just filler ("Khai", "Hmm", "Okey") — FAIL. Questions deserve actual answers, even if short (2-5 words).

4. REPETITION: Check the recent conversation. If the same filler word was used in the last few replies — FAIL. The AI must vary its responses.

5. RIGHT LANGUAGE: If the conversation is in Nepali/mixed, reply must match.

6. SOUNDS HUMAN: Does it sound like a real person texting? Overly polished full sentences = likely AI.

7. NO FABRICATION: Does it claim to know something the AI can't know?

VERDICT (output EXACTLY this format):
PASS or FAIL
REASON: one sentence
SUGGESTION: if FAIL, write the correct reply (1-${effectiveUpper} words, in ${userName}'s style, actually addressing what was said). If PASS, write "none"`;

  const result = await callLLM(systemPrompt, [{ role: 'user', content: userPrompt }], 250);

  const pass = /^PASS/i.test(result.trim());
  const reasonMatch = result.match(/REASON:\s*(.+)/i);
  const suggestionMatch = result.match(/SUGGESTION:\s*(.+)/i);

  return {
    pass,
    reason: reasonMatch ? reasonMatch[1].trim() : '',
    suggestion: suggestionMatch ? suggestionMatch[1].trim() : '',
  };
}

/**
 * Rewrite a failed reply using verifier feedback.
 */
async function rewrite(userName, contactName, failedReply, verifyReason, verifySuggestion, decideOutput, relationshipDoc, conversationFlow, incomingMessage, wordStats, isEmergency) {
  const userExamples = extractUserExamples(conversationFlow, userName);
  const s = wordStats;
  const effectiveUpper = isEmergency ? 15 : s.upper;

  let systemPrompt = `You are ghostwriting as "${userName}" on WhatsApp. A previous reply FAILED quality check.

${userName}'s real messages: ${userExamples || '(check style doc)'}
Acceptable range: ${s.avg}-${effectiveUpper} words depending on situation.`;

  if (isEmergency) {
    systemPrompt += `\n⚠️ EMERGENCY: ${contactName} is in distress. Respond with care. Up to ${effectiveUpper} words.`;
  }

  if (relationshipDoc) {
    systemPrompt += `\n\n========== STYLE DOCUMENT ==========\n${relationshipDoc}\n========== END STYLE DOCUMENT ==========`;
  }

  let userPrompt = '';
  if (conversationFlow) {
    userPrompt += `CONVERSATION:\n${conversationFlow}\n\n`;
  }

  userPrompt += `${contactName} said: "${incomingMessage}"

FAILED REPLY: "${failedReply}"
PROBLEM: ${verifyReason}
VERIFIER'S SUGGESTION: ${verifySuggestion}

The verifier's suggestion is a STRONG hint. If the suggestion looks like something ${userName} would say, use it directly. Just make sure it matches ${userName}'s spelling patterns (e.g., "okey" not "okay", "xa" not "cha").

Write a BETTER reply. ${effectiveUpper} words MAX. Output ONLY the message text.`;

  const reply = await callLLM(systemPrompt, [{ role: 'user', content: userPrompt }], 100);

  let cleaned = reply.replace(/^["']|["']$/g, '').trim();
  const prefix = `${userName}:`;
  if (cleaned.toLowerCase().startsWith(prefix.toLowerCase())) {
    cleaned = cleaned.slice(prefix.length).trim();
  }
  const bracketPrefix = `[${userName}]:`;
  if (cleaned.toLowerCase().startsWith(bracketPrefix.toLowerCase())) {
    cleaned = cleaned.slice(bracketPrefix.length).trim();
  }

  return cleaned;
}

/**
 * Describe images using GPT-4o vision.
 */
async function describeImages(base64Images) {
  if (!base64Images || base64Images.length === 0) return [];

  const systemPrompt = `Describe each image concisely in 1-2 sentences. Focus on: what's in the image, any text visible, the mood/context. If it's a meme, describe the joke. If it's a screenshot, describe what it shows.`;

  const userPrompt = `Describe these ${base64Images.length} image(s) from a WhatsApp chat. Be concise.`;

  try {
    const result = await callOpenAIWithVision(
      systemPrompt,
      [{ role: 'user', content: userPrompt }],
      base64Images,
      500
    );
    if (base64Images.length === 1) return [result];
    const descriptions = result.split(/\n(?=\d+[.):])/).filter(Boolean);
    return descriptions.length > 0 ? descriptions : [result];
  } catch (err) {
    console.error(`[Chain] Image description failed: ${err.message}`);
    return base64Images.map(() => '[Image description unavailable]');
  }
}

/**
 * Full chain-of-thought reply generation.
 *
 * Returns the reply string, or NULL if the verifier rejects all attempts.
 * When null is returned, the caller should NOT send any message.
 */
async function thinkAndReply(contactId, contactName, incomingMessage, imageDescriptions = []) {
  const logger = new ChainLogger(contactId, contactName);
  const userName = config.get('userName') || 'Avin';
  const relationshipDoc = styleProfiler.loadDocument(contactId);
  const recentMessages = await vectordb.getRecentMessages(contactId, 60);

  // Load Q&A context from profile meta if available
  const meta = styleProfiler.loadMeta(contactId);
  let qaContext = '';
  if (meta && meta.profileQA && meta.profileQA.length > 0) {
    qaContext = meta.profileQA
      .filter(qa => qa.answer && qa.answer.trim())
      .map(qa => `Q: ${qa.question}\nA: ${qa.answer}`)
      .join('\n\n');
  }

  let conversationFlow = '';
  if (recentMessages.length > 0) {
    conversationFlow = recentMessages.map(m => {
      const sender = m.fromMe ? userName : contactName;
      const time = m.timestamp ? new Date(m.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      // Tag auto-generated messages so the LLM knows not to blindly copy their style
      const isAutoGenerated = m.fromMe && m.id && (m.id.startsWith('auto_') || m.id.startsWith('web_'));
      const autoTag = isAutoGenerated ? ' [AI-GENERATED]' : '';
      return `[${sender}]${time ? ` (${time})` : ''}${autoTag}: ${m.body}`;
    }).join('\n');
  }

  const wordStats = getWordCountStats(conversationFlow, userName);
  const isEmergency = detectEmergency(incomingMessage);
  if (isEmergency) {
    console.log(`  ${C.red}${C.bold}⚠️  EMERGENCY DETECTED in message from ${contactName}!${C.reset}`);
  }
  const hasImages = imageDescriptions && imageDescriptions.length > 0;
  const sentImageNoDesc = !hasImages && (incomingMessage === '[image]' || incomingMessage.includes('[image]'));
  logger.logStep('Think', { extra: `Word stats: avg=${wordStats.avg} p75=${wordStats.p75} upper=${wordStats.upper}${isEmergency ? ' | ⚠️ EMERGENCY' : ''}${hasImages ? ` | 📷 ${imageDescriptions.length} image(s) described` : ''}${sentImageNoDesc ? ' | 📷 image sent but NO description' : ''} | Q&A: ${qaContext ? 'yes' : 'none'}` });

  // Step 1: Think
  const thinkOutput = await think(userName, contactName, conversationFlow, incomingMessage, imageDescriptions, relationshipDoc, qaContext);
  const isLowConfidence = /confidence:\s*LOW/i.test(thinkOutput);
  logger.logStep('Think', {
    output: thinkOutput,
    status: isLowConfidence ? 'fail' : 'pass',
    extra: isLowConfidence ? 'LOW confidence — will dodge/deflect' : undefined,
  });

  // Step 2: Decide
  const decideOutput = await decide(userName, contactName, thinkOutput, relationshipDoc, incomingMessage, conversationFlow, qaContext, wordStats, isEmergency, imageDescriptions);
  logger.logStep('Decide', { output: decideOutput, status: 'pass' });

  // Step 3: Write
  let reply = await write(userName, contactName, decideOutput, thinkOutput, relationshipDoc, conversationFlow, incomingMessage, wordStats, isEmergency, imageDescriptions);
  logger.logStep('Write', {
    output: reply,
    status: 'pass',
    extra: `Draft: "${reply}" (${reply.split(/\s+/).length} words)`,
  });

  // Step 4: Verify + Rewrite loop
  const MAX_RETRIES = 2;
  let lastVerdict = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const verdict = await verify(userName, contactName, reply, incomingMessage, conversationFlow, relationshipDoc, wordStats, isEmergency);
      lastVerdict = verdict;

      logger.logStep('Verify', {
        output: `${verdict.pass ? 'PASS' : 'FAIL'}: ${verdict.reason}${verdict.suggestion && verdict.suggestion !== 'none' ? ` | Suggestion: ${verdict.suggestion}` : ''}`,
        status: verdict.pass ? 'pass' : 'fail',
        extra: `Attempt ${attempt + 1}/${MAX_RETRIES + 1}`,
      });

      if (verdict.pass) {
        logger.logFinal('SENT', reply);
        return reply;
      }

      if (attempt < MAX_RETRIES) {
        reply = await rewrite(
          userName, contactName, reply, verdict.reason, verdict.suggestion,
          decideOutput, relationshipDoc, conversationFlow, incomingMessage, wordStats, isEmergency
        );
        logger.logStep('Rewrite', {
          output: reply,
          status: 'pass',
          extra: `Rewrite ${attempt + 1}: "${reply}" (${reply.split(/\s+/).length} words)`,
        });
      }
    } catch (err) {
      logger.logStep('Verify', { status: 'fail', extra: `Error: ${err.message}` });
      logger.logFinal('SENT', reply);
      return reply;
    }
  }

  // ALL retries failed — use the verifier's last suggestion if available
  if (lastVerdict && lastVerdict.suggestion && lastVerdict.suggestion !== 'none' && lastVerdict.suggestion.length > 0 && lastVerdict.suggestion.length < 100) {
    let suggestion = lastVerdict.suggestion.replace(/^["']|["']$/g, '').trim();
    logger.logFinal('SENT_SUGGESTION', suggestion);
    return suggestion;
  }

  // No good suggestion either — return null, caller should NOT send
  logger.logFinal('SKIPPED', null);
  return null;
}

module.exports = {
  thinkAndReply,
  describeImages,
  detectEmergency,
  think,
  decide,
  write,
  verify,
  rewrite,
};
