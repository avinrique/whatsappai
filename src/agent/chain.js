/**
 * Chain-of-thought reply engine.
 * Three-step process: Think → Decide → Write
 * Each step is a separate LLM call informed by the previous step's output.
 */

const config = require('../config/config');
const vectordb = require('../data/vectordb');
const styleProfiler = require('./style-profiler');
const { callLLM, callOpenAIWithVision } = require('./llm');

/**
 * Step 1 — Think: Deep situational analysis of the conversation.
 * Reads the FULL conversation flow, understands what's being discussed,
 * detects the arc of the conversation, and figures out what's happening RIGHT NOW.
 */
async function think(userName, contactName, conversationFlow, incomingMessage, imageDescriptions, relationshipDoc) {
  const systemPrompt = `You are an expert conversation analyst reading a WhatsApp chat between "${userName}" and "${contactName}". Your job is to deeply understand what's happening so the AI can write a perfect reply. Be specific, cite actual messages, and be brutally honest about what you know vs don't know.`;

  let userPrompt = '';

  if (relationshipDoc) {
    // Give relationship context first so the analyst understands the dynamic
    userPrompt += `WHO THEY ARE TO EACH OTHER:\n${relationshipDoc.slice(0, 2000)}\n\n`;
  }

  if (conversationFlow) {
    userPrompt += `FULL CONVERSATION FLOW (read EVERY message carefully, in order):\n${conversationFlow}\n\n`;
  }

  userPrompt += `LATEST MESSAGE(S) from ${contactName}:\n"${incomingMessage}"\n\n`;

  if (imageDescriptions && imageDescriptions.length > 0) {
    userPrompt += `IMAGES ${contactName} SENT:\n${imageDescriptions.map((d, i) => `Image ${i + 1}: ${d}`).join('\n')}\n\n`;
  }

  userPrompt += `Analyze CAREFULLY:

1. CONVERSATION ARC: What have they been discussing? Trace the topic(s) from the start of this conversation snippet. What was the flow? (e.g., "They were talking about X, then ${contactName} asked about Y, ${userName} said Z, now ${contactName} is responding to that")

2. RIGHT NOW: What is ${contactName} saying/asking in their LATEST message(s)? Be specific — quote their words. What do they expect back?

3. DOES THIS NEED SPECIFIC KNOWLEDGE? Is ${contactName} asking about something that requires real-world facts the AI wouldn't know (like "did you finish the assignment?", "what time is the meeting?", "where did you put my keys?")? If yes, say so clearly.

4. MOOD & TONE: What's the emotional vibe right now? (casual banter, serious talk, excited, annoyed, tired, flirty, etc.)

5. WHAT ${userName} WOULD NATURALLY DO: Based on the style doc and conversation patterns, would ${userName} likely:
   - Give a direct answer?
   - Deflect/dodge with humor?
   - Ask a follow-up question?
   - Just react (haha, emoji, short acknowledgment)?
   - Leave it on read for now?

6. CONFIDENCE: On a scale of HIGH/MEDIUM/LOW, how confident are you that the AI can write a good reply? If LOW, explain why (e.g., "needs real-world info the AI doesn't have", "topic is too personal/specific").`;

  return callLLM(systemPrompt, [{ role: 'user', content: userPrompt }], 500);
}

/**
 * Step 2 — Decide: Based on the analysis and style document,
 * determine what the reply should convey and what form it should take.
 * KEY: Knows when to dodge and when to commit.
 */
async function decide(userName, contactName, thinkOutput, relationshipDoc, incomingMessage, conversationFlow) {
  const systemPrompt = `You are deciding what "${userName}" should text back to "${contactName}" on WhatsApp. You must make a SMART decision — not every message needs a direct answer. Sometimes the smartest reply is a dodge, a deflection, or a question back. Think like a real person, not a helpful AI assistant.`;

  let userPrompt = `SITUATION ANALYSIS:\n${thinkOutput}\n\n`;

  if (conversationFlow) {
    userPrompt += `CONVERSATION SO FAR:\n${conversationFlow}\n\n`;
  }

  userPrompt += `${contactName}'s LATEST: "${incomingMessage}"\n\n`;

  if (relationshipDoc) {
    userPrompt += `${userName}'s STYLE DOCUMENT:\n${relationshipDoc.slice(0, 2500)}\n\n`;
  }

  userPrompt += `Make your decision. Consider these scenarios:

IF THE AI CAN'T KNOW THE ANSWER (e.g., "did you finish the homework?", "where are you?", "what time is the meeting?"):
→ ${userName} would NOT just make up an answer. Look at the style doc — how does ${userName} dodge? Common patterns:
  - Deflect with a question back: "kina?" / "why?" / "k bhako?"
  - Vague non-answer: "khai" / "haha" / "later"
  - Change the subject naturally
  - Short acknowledgment that doesn't commit to anything

IF IT'S SIMPLE CONVERSATION (casual chat, banter, greetings, reactions):
→ Reply naturally, matching ${userName}'s style exactly

IF ${contactName} IS SHARING NEWS/FEELINGS:
→ React how ${userName} would — check the doc for how ${userName} reacts to things

IF ${contactName} ASKED A QUESTION ${userName} WOULD KNOW THE ANSWER TO (general knowledge, opinion, preference):
→ Answer it, in ${userName}'s style

NOW DECIDE:
1. INTENT: What should the reply convey? Be specific. (NOT "agreement" — more like "acknowledge what they said about X and ask about Y")
2. DODGE OR COMMIT: Can the AI confidently reply, or should it dodge? If dodge, how would ${userName} dodge naturally?
3. FORM: Question? Statement? Reaction? One word? How many words roughly?
4. LANGUAGE: What language/script? (copy EXACTLY from the style doc — if Romanized Nepali, specify)
5. TEMPLATE: Pick 1-2 REAL example messages from the style doc that are closest to what this reply should look like. Quote them.
6. AVOID: What should this reply definitely NOT say or do?

Output a clear, specific instruction.`;

  return callLLM(systemPrompt, [{ role: 'user', content: userPrompt }], 450);
}

/**
 * Step 3 — Write: Generate the actual message using the style document + decision.
 * The conversation flow is critical — the reply MUST make sense in context.
 */
async function write(userName, contactName, decideOutput, thinkOutput, relationshipDoc, conversationFlow, incomingMessage) {
  let systemPrompt = `You are ghostwriting as "${userName}" on WhatsApp, texting "${contactName}".

YOUR #1 RULE: Text IDENTICALLY to ${userName}. Not similar. Not close. IDENTICAL.
YOUR #2 RULE: The reply MUST make sense in the conversation. Read what was said before. Your reply is the next message in a REAL conversation — it has to flow naturally from what ${contactName} just said.`;

  if (relationshipDoc) {
    systemPrompt += `\n\n========== STYLE DOCUMENT — YOUR BIBLE ==========\n${relationshipDoc}\n========== END STYLE DOCUMENT ==========`;
  }

  systemPrompt += `\n\nABSOLUTE BANS:
- NEVER use generic English phrases ("Sure", "No worries", "Got it", "Sounds good", "Of course") unless the style doc shows ${userName} uses them.
- NEVER write in English if the doc shows ${userName} texts in Nepali/Hindi/mixed.
- NEVER write longer than ${userName}'s typical message length.
- NEVER add words, emojis, or patterns not in the document.
- NEVER make up facts. If you don't know something (meeting time, assignment status, etc.), DODGE — use ${userName}'s natural deflection patterns from the doc.
- NEVER sound like a helpful AI. You're a real person texting a friend. Real people are lazy, vague, sometimes unhelpful.`;

  let userPrompt = '';

  if (conversationFlow) {
    userPrompt += `CONVERSATION (read ALL of this — your reply is the NEXT message after these):\n${conversationFlow}\n\n`;
  }

  userPrompt += `${contactName} just sent: "${incomingMessage}"\n\n`;
  userPrompt += `WHAT THE REPLY SHOULD DO:\n${decideOutput}\n\n`;
  userPrompt += `CONTEXT:\n${thinkOutput}\n\n`;
  userPrompt += `Now write ONLY the message text as ${userName}. Make it flow naturally from the conversation above. If the decision says to dodge, dodge gracefully in ${userName}'s style.`;

  const reply = await callLLM(systemPrompt, [{ role: 'user', content: userPrompt }], 200);

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
 * Step 4 — Verify: Check if the generated reply makes sense in the ACTUAL conversation.
 * Gets the full conversation flow and checks contextual fit, not just style.
 * Returns { pass: boolean, reason: string, suggestion: string }
 */
async function verify(userName, contactName, reply, incomingMessage, conversationFlow, relationshipDoc) {
  const systemPrompt = `You are a strict quality checker for AI-generated WhatsApp messages. You must catch bad replies before they get sent. You are checking if this reply would pass as a REAL message from "${userName}" to "${contactName}". Be harsh — a bad reply is worse than no reply. Output ONLY your verdict in the exact format specified.`;

  let userPrompt = `An AI generated this reply as "${userName}" texting "${contactName}" on WhatsApp.\n\n`;

  // Show the FULL conversation so the verifier can check contextual fit
  if (conversationFlow) {
    userPrompt += `FULL RECENT CONVERSATION (the reply must flow naturally after these messages):\n${conversationFlow}\n\n`;
  }

  userPrompt += `${contactName} JUST SENT: "${incomingMessage}"\n\n`;
  userPrompt += `AI'S GENERATED REPLY AS ${userName}: "${reply}"\n\n`;

  if (relationshipDoc) {
    // Send more of the doc — language, style, AND example messages
    const langSection = relationshipDoc.match(/## Language & Word Choices[\s\S]*?(?=\n## [A-Z])/i)?.[0] || '';
    const styleSection = relationshipDoc.match(/## General Style[\s\S]*?(?=\n## [A-Z])/i)?.[0] || '';
    const exampleSection = relationshipDoc.match(/## (?:Example Messages|Message Examples|Real Examples)[\s\S]*?(?=\n## [A-Z])/i)?.[0] || '';
    const topicSection = relationshipDoc.match(/## (?:Topics|What They Discuss|Conversation Topics)[\s\S]*?(?=\n## [A-Z])/i)?.[0] || '';
    userPrompt += `${userName}'s STYLE REFERENCE:\n${langSection}\n${styleSection}\n${exampleSection}\n${topicSection}\n\n`;
  }

  userPrompt += `CHECK ALL OF THESE (be strict):

1. CONVERSATION FIT: Read the full conversation above. Does "${reply}" make sense as the NEXT message after everything that was said? Would a human reading this conversation think "${reply}" is a natural continuation? If ${contactName} was talking about topic X, does the reply relate to topic X?

2. ANSWERS CORRECTLY: If ${contactName} asked a question, does the reply address it? If it's a factual question the AI can't know (like "where are you?" or "did you finish?"), is the reply a natural dodge rather than a made-up answer? Dodging is OK — making up facts is NOT.

3. NOT GENERIC: Is the reply a lazy filler? ("Sure", "No worries", "Got it", "Sounds good", "Okay", "Alright", "Of course", "That's great", "Nice", "Cool", "Haha nice") — unless ${userName}'s real messages in the style doc use these exact phrases, they're WRONG.

4. RIGHT LANGUAGE: Check the style doc and the conversation. If ${userName} has been texting in Nepali/Hindi/mixed, the reply MUST be in that language. English reply when the conversation is in Nepali = FAIL.

5. RIGHT LENGTH: Compare to ${userName}'s messages in the conversation and style doc. Way too long or way too short = FAIL.

6. SOUNDS HUMAN: Does it sound like a tired 20-something texting their friend? Or does it sound like a helpful AI assistant? (Too polished, too complete, too enthusiastic, too formal = AI-sounding = FAIL)

7. NO FABRICATION: Does the reply claim to know something the AI couldn't know? ("Yeah I finished it", "I'm at home", "The meeting is at 3") — unless this info was in the conversation = FAIL.

VERDICT FORMAT (output EXACTLY this, nothing else):
PASS or FAIL
REASON: one sentence explaining why
SUGGESTION: if FAIL, write what the reply SHOULD be instead (in ${userName}'s exact style and language). If PASS, write "none"`;

  const result = await callLLM(systemPrompt, [{ role: 'user', content: userPrompt }], 300);

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
 * Rewrite a failed reply using the verifier's feedback.
 * If the verifier provided a suggestion, use it as a strong hint.
 */
async function rewrite(userName, contactName, failedReply, verifyReason, verifySuggestion, decideOutput, relationshipDoc, conversationFlow, incomingMessage) {
  let systemPrompt = `You are ghostwriting as "${userName}" on WhatsApp, texting "${contactName}".

YOUR #1 RULE: Text IDENTICALLY to ${userName}. Not similar. Not close. IDENTICAL.
YOUR #2 RULE: The reply MUST fit the conversation naturally. Read what came before.`;

  if (relationshipDoc) {
    systemPrompt += `\n\n========== STYLE DOCUMENT ==========\n${relationshipDoc}\n========== END STYLE DOCUMENT ==========`;
  }

  systemPrompt += `\n\nABSOLUTE BANS:
- NEVER use generic English phrases unless the style doc shows ${userName} uses them.
- NEVER write in English if the doc shows ${userName} texts in another language.
- NEVER write longer than ${userName}'s typical message length.
- NEVER make up facts. Dodge naturally if unsure.
- NEVER sound like a helpful AI assistant.`;

  let userPrompt = '';

  if (conversationFlow) {
    userPrompt += `CONVERSATION (your reply goes AFTER these):\n${conversationFlow}\n\n`;
  }

  userPrompt += `${contactName} just said: "${incomingMessage}"

PREVIOUS ATTEMPT FAILED:
- Reply: "${failedReply}"
- Problem: ${verifyReason}
- Verifier's suggestion: ${verifySuggestion}

WHAT THE REPLY SHOULD DO: ${decideOutput}

Write a BETTER reply. The verifier's suggestion is a strong hint — use it as a starting point but make sure it matches ${userName}'s exact style. Output ONLY the message text.`;

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

/**
 * Describe images using GPT-4o vision.
 * @param {Array<string>} base64Images - Base64-encoded images
 * @returns {Promise<string[]>} Array of image descriptions
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
    // Split by numbered lines if multiple images
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
 * @param {string} contactId
 * @param {string} contactName
 * @param {string} incomingMessage
 * @param {string[]} imageDescriptions - Pre-computed image descriptions (optional)
 * @returns {Promise<string>} The generated reply
 */
async function thinkAndReply(contactId, contactName, incomingMessage, imageDescriptions = []) {
  const userName = config.get('userName') || 'Avin';
  const relationshipDoc = styleProfiler.loadDocument(contactId);

  // Get MORE recent messages for better context (60 instead of 40)
  const recentMessages = await vectordb.getRecentMessages(contactId, 60);

  let conversationFlow = '';
  if (recentMessages.length > 0) {
    conversationFlow = recentMessages.map(m => {
      const sender = m.fromMe ? userName : contactName;
      const time = m.timestamp ? new Date(m.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      return `[${sender}]${time ? ` (${time})` : ''}: ${m.body}`;
    }).join('\n');
  }

  // Step 1: Think — deep conversation analysis
  console.log(`  [Chain] Step 1: Think...`);
  const thinkOutput = await think(userName, contactName, conversationFlow, incomingMessage, imageDescriptions, relationshipDoc);
  console.log(`  [Chain] Think done. Checking confidence...`);

  // Check if think step flagged LOW confidence
  const isLowConfidence = /confidence:\s*LOW/i.test(thinkOutput);
  if (isLowConfidence) {
    console.log(`  [Chain] LOW confidence detected — will dodge/deflect`);
  }

  // Step 2: Decide — what to say (or how to dodge)
  console.log(`  [Chain] Step 2: Decide...`);
  const decideOutput = await decide(userName, contactName, thinkOutput, relationshipDoc, incomingMessage, conversationFlow);

  // Step 3: Write — generate the actual message
  console.log(`  [Chain] Step 3: Write...`);
  let reply = await write(userName, contactName, decideOutput, thinkOutput, relationshipDoc, conversationFlow, incomingMessage);

  // Step 4: Verify + Rewrite loop (up to 2 retries)
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      console.log(`  [Chain] Step 4: Verify (attempt ${attempt + 1})...`);
      const verdict = await verify(userName, contactName, reply, incomingMessage, conversationFlow, relationshipDoc);

      if (verdict.pass) {
        console.log(`  [Chain] Verify PASSED`);
        break;
      }

      console.log(`  [Chain] Verify FAILED: ${verdict.reason}`);

      // If verifier provided a good suggestion, use it as a strong hint
      if (verdict.suggestion && verdict.suggestion !== 'none' && verdict.suggestion.length > 0) {
        console.log(`  [Chain] Rewriting with suggestion: "${verdict.suggestion}"`);
      }

      // Rewrite using the feedback
      reply = await rewrite(
        userName, contactName, reply, verdict.reason, verdict.suggestion,
        decideOutput, relationshipDoc, conversationFlow, incomingMessage
      );
    } catch (err) {
      console.error(`  [Chain] Verify error: ${err.message}`);
      break; // Don't block the reply on verifier errors
    }
  }

  console.log(`  [Chain] Final reply: "${reply}"`);
  return reply;
}

module.exports = {
  thinkAndReply,
  describeImages,
  think,
  decide,
  write,
  verify,
  rewrite,
};
