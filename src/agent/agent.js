const config = require('../config/config');
const vectordb = require('../data/vectordb');
const styleProfiler = require('./style-profiler');
const { callLLM } = require('./llm');

/**
 * Build the full context (style doc + recent messages) for a contact.
 */
async function buildContext(contactId, contactName) {
  const userName = config.get('userName') || 'Avin';
  const relationshipDoc = styleProfiler.loadDocument(contactId);
  const recentMessages = await vectordb.getRecentMessages(contactId, 40);

  let conversationFlow = '';
  if (recentMessages.length > 0) {
    conversationFlow = recentMessages.map(m => {
      const sender = m.fromMe ? userName : contactName;
      return `[${sender}]: ${m.body}`;
    }).join('\n');
  }

  return { userName, relationshipDoc, conversationFlow };
}

/**
 * Build the system prompt.
 * The style doc is the BIBLE. The AI must follow it word for word.
 */
function buildSystemPrompt(userName, contactName, relationshipDoc, mode) {
  let prompt = `You are ghostwriting as "${userName}" on WhatsApp, texting "${contactName}".

YOUR #1 RULE: Text IDENTICALLY to ${userName}. Not similar. Not close. IDENTICAL.`;

  if (relationshipDoc) {
    prompt += `

========== STYLE DOCUMENT — YOUR BIBLE ==========
${relationshipDoc}
========== END STYLE DOCUMENT ==========

HOW TO USE THIS DOCUMENT:

1. FIND THE RIGHT LANGUAGE: Read "Language & Word Choices". Match EXACTLY the language(s) and script ${userName} uses. If ${userName} texts in a non-English language or a romanized version, YOU do the same. NEVER switch languages unless ${userName} does.

2. COPY EXACT WORDS: Use the EXACT spellings and word forms from the document. If ${userName} has specific transliterations or slang, copy them character-for-character. NEVER substitute with "standard" spellings.

3. MATCH MESSAGE LENGTH: Count the words in ${userName}'s example messages. If most are 1-5 words, yours must be 1-5 words. If ${userName} sends "eh la" or "huss" or "khai", you send messages that short. NEVER write sentences when ${userName} writes fragments.

4. READ THE MOOD: Look at the conversation flow. What's happening RIGHT NOW? ${contactName} just said something — what did they say? What would ${userName} naturally say back?

5. USE EXAMPLES AS TEMPLATES: The example messages in the document are REAL. Pick the examples that match the current mood/situation and model your reply after them.

ABSOLUTE BANS — NEVER DO THESE:
- NEVER use generic English phrases like "Sure", "Sure my boy", "No worries", "Sounds good", "Got it", "Alright", "Of course", "Absolutely", "That's great" UNLESS the style document shows ${userName} actually using those exact phrases.
- NEVER switch to a different language than what the style document shows ${userName} using.
- NEVER write longer messages than ${userName}'s typical length.
- NEVER be more formal or polished than ${userName}'s actual texts.
- NEVER add words, emojis, or patterns that aren't in the document.`;
  } else {
    prompt += `

No style document exists for ${contactName}. Text very casually. Keep it to 2-5 words max. Use common texting slang.`;
  }

  if (mode === 'reply') {
    prompt += `

REPLY INSTRUCTIONS:
- Read the FULL conversation flow below. Understand what ${contactName} is saying.
- If ${contactName} sent MULTIPLE messages, read ALL of them and reply to the overall conversation, not just one message.
- Your reply must make SENSE in context. If they said "goodnight"/"sutne", say something like goodnight back. If they asked a question, answer it. If they're chatting casually, chat back.
- Output ONLY the message text. No quotes. No labels. No explanation.`;
  } else if (mode === 'instruction') {
    prompt += `

INSTRUCTION MODE:
- You are NOT replying to ${contactName}. You are writing a NEW message to send TO ${contactName}.
- The instruction below is from ${userName} telling YOU (the AI) what the message should convey. It is NOT the message itself.
- CRITICAL: The instruction is a META-INSTRUCTION. "${userName}" is talking to YOU, not to ${contactName}.
  Examples of how to interpret instructions:
  - "tell him to bring it tomorrow" → message to ${contactName} in ${userName}'s language and style, saying to bring it tomorrow
  - "ask her when she's free" → message to ${contactName} in ${userName}'s language and style, asking when they're free
  - "wish him good morning" → message to ${contactName} in ${userName}'s language and style, saying good morning
  - "give me a report" → WRONG INTERPRETATION. This means send ${contactName} a message asking for a report, in ${userName}'s style
  - "tell him why was he doing that" → message to ${contactName}: "kina testo gareko?" (asking ${contactName} why they were doing that)
- Convert the INTENT into a direct message FROM ${userName} TO ${contactName}.
- Write it in ${userName}'s EXACT texting style from the document.
- Output ONLY the message text. No quotes. No labels. No explanation.`;
  }

  return prompt;
}

async function generateReply(contactId, contactName, incomingMessage) {
  const { userName, relationshipDoc, conversationFlow } = await buildContext(contactId, contactName);

  const systemPrompt = buildSystemPrompt(userName, contactName, relationshipDoc, 'reply');

  let userPrompt = '';
  if (conversationFlow) {
    userPrompt += `CONVERSATION FLOW (this is what happened recently — read it ALL):\n${conversationFlow}\n\n`;
  }

  // If multiple messages came in (debounced), show them clearly
  const lines = incomingMessage.split('\n').filter(l => l.trim());
  if (lines.length > 1) {
    userPrompt += `${contactName} just sent these messages:\n`;
    lines.forEach(l => { userPrompt += `- "${l}"\n`; });
    userPrompt += `\nRead ALL of them. Reply with ONE message as ${userName}. Use ${userName}'s exact language, words, and style from the document.`;
  } else {
    userPrompt += `${contactName} just sent: "${incomingMessage}"\n\nReply as ${userName}. Use ${userName}'s exact language, words, and style from the document.`;
  }

  const reply = await callLLM(systemPrompt, [{ role: 'user', content: userPrompt }], 200);

  // Clean up: remove quotes, labels, etc.
  let cleaned = reply.replace(/^["']|["']$/g, '').trim();
  // Remove any "userName:" prefix the LLM might add
  const prefix = `${userName}:`;
  if (cleaned.toLowerCase().startsWith(prefix.toLowerCase())) {
    cleaned = cleaned.slice(prefix.length).trim();
  }
  // Remove [userName]: prefix
  const bracketPrefix = `[${userName}]:`;
  if (cleaned.toLowerCase().startsWith(bracketPrefix.toLowerCase())) {
    cleaned = cleaned.slice(bracketPrefix.length).trim();
  }

  return cleaned;
}

async function previewReply(contactId, contactName, message) {
  return generateReply(contactId, contactName, message);
}

/**
 * Generate a message from a user instruction (for scheduler).
 */
async function generateFromInstruction(contactId, contactName, instruction) {
  const { userName, relationshipDoc, conversationFlow } = await buildContext(contactId, contactName);

  const systemPrompt = buildSystemPrompt(userName, contactName, relationshipDoc, 'instruction');

  let userPrompt = '';
  if (conversationFlow) {
    userPrompt += `RECENT CONVERSATION:\n${conversationFlow}\n\n`;
  }
  userPrompt += `INSTRUCTION FROM ${userName} TO THE AI: "${instruction}"

This is what ${userName} wants the message to CONVEY to ${contactName}. Do NOT copy the instruction word-for-word.
Convert it into a direct message FROM ${userName} TO ${contactName} in ${userName}'s exact texting style.
If the instruction says "tell him X", the message should say X directly to ${contactName}.
If the instruction says "ask her Y", the message should ask Y directly to ${contactName}.
Write it naturally — same language, same words, same spelling, same length as ${userName}'s real texts.`;

  const reply = await callLLM(systemPrompt, [{ role: 'user', content: userPrompt }], 200);

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

module.exports = { generateReply, previewReply, generateFromInstruction };
