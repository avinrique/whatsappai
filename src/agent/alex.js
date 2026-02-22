const config = require('../config/config');
const agent = require('./agent');
const scheduler = require('../scheduler/scheduler');
const vectordb = require('../data/vectordb');
const { callLLM } = require('./llm');

// Pending clarification state — when Alex asks "which contact?"
let pendingClarification = null;
const PENDING_TTL = 60000; // 1 minute to reply

function isSelfChat(msg) {
  return msg.fromMe && msg.from === msg.to && msg.body && msg.body.trim();
}

/**
 * Check if a message is an Alex command:
 * - fromMe (sent by the user)
 * - self-chat (msg.from === msg.to)
 * - body ends with trigger word (case-insensitive)
 * - body has more than just the trigger word
 */
function isAlexCommand(msg) {
  if (!isSelfChat(msg)) return false;

  const trigger = (config.get('triggerWord') || 'alex').toLowerCase();
  const body = msg.body.trim().toLowerCase();

  // Must end with trigger word
  if (!body.endsWith(trigger)) return false;

  // Must have more than just the trigger word
  const stripped = body.slice(0, body.length - trigger.length).trim();
  if (!stripped || stripped.replace(/[,.\s]/g, '') === '') return false;

  return true;
}

/**
 * Check if there's a pending clarification waiting for a reply.
 */
function hasPendingClarification(msg) {
  if (!isSelfChat(msg)) return false;
  if (!pendingClarification) return false;
  // Expire after TTL
  if (Date.now() - pendingClarification.timestamp > PENDING_TTL) {
    pendingClarification = null;
    return false;
  }
  // Don't intercept if this is another alex command
  if (isAlexCommand(msg)) return false;
  return true;
}

/**
 * Strip trigger word from end of body, trim trailing punctuation and whitespace.
 */
function stripTrigger(body) {
  const trigger = (config.get('triggerWord') || 'alex').toLowerCase();
  const lower = body.trim().toLowerCase();

  if (!lower.endsWith(trigger)) return body.trim();

  let stripped = body.trim().slice(0, body.trim().length - trigger.length);
  // Remove trailing comma, period, whitespace
  stripped = stripped.replace(/[\s,.\-:;]+$/, '').trim();
  return stripped;
}

/**
 * Gather all available contacts: auto-reply contacts + WhatsApp contacts.
 */
async function gatherContacts(client) {
  const contacts = [];
  const seen = new Set();

  // Auto-reply contacts first (high priority)
  const autoContacts = config.get('autoReplyContacts') || [];
  for (const c of autoContacts) {
    contacts.push({ id: c.id, name: c.name, autoReply: true });
    seen.add(c.id);
  }

  // All WhatsApp contacts
  try {
    const waContacts = await client.getContacts();
    for (const c of waContacts) {
      if (seen.has(c.id._serialized)) continue;
      const name = c.pushname || c.name;
      if (!name) continue;
      if (c.isMe) continue;
      contacts.push({ id: c.id._serialized, name, autoReply: false });
      seen.add(c.id._serialized);
    }
  } catch (err) {
    console.log(`[Alex] Warning: Could not fetch WhatsApp contacts: ${err.message}`);
  }

  return contacts;
}

/**
 * Parse the command using LLM.
 * Returns: { action, contactQuery, matchedContactId, matchedContactName, intent, time }
 */
/**
 * Pre-filter contacts by extracting likely name words from the command text.
 * Returns a small subset that the LLM can handle within token limits.
 */
function preFilterContacts(text, contacts) {
  const words = text.toLowerCase().split(/\s+/);

  // Skip common command words — only keep potential name words
  const skipWords = new Set([
    'send', 'tell', 'ask', 'text', 'message', 'msg', 'remind', 'wish',
    'say', 'to', 'a', 'an', 'the', 'at', 'in', 'on', 'for', 'about',
    'good', 'morning', 'night', 'evening', 'afternoon', 'hi', 'hello',
    'hey', 'tomorrow', 'tonight', 'today', 'now', 'please', 'can', 'you',
    'that', 'this', 'him', 'her', 'them', 'his', 'their', 'my', 'me',
    'turn', 'auto', 'reply', 'autoreply', 'auto-reply', 'enable', 'disable',
    'off', 'schedule', 'have', 'sleep', 'come', 'bring', 'call', 'check',
    'how', 'what', 'when', 'where', 'why', 'with', 'from', 'will', 'be',
    'is', 'are', 'was', 'were', 'do', 'does', 'did', 'not', 'don\'t',
    'pm', 'am', 'hours', 'hour', 'minutes', 'minute', 'ok', 'okay',
  ]);

  const nameWords = words.filter(w => !skipWords.has(w) && w.length > 1);

  if (nameWords.length === 0) return contacts.slice(0, 50);

  // Score each contact by how many name words match
  const scored = contacts.map(c => {
    const nameLower = c.name.toLowerCase();
    let score = 0;
    for (const w of nameWords) {
      if (nameLower.includes(w)) score += 2;
      // Partial match (first 3+ chars)
      if (w.length >= 3 && nameLower.includes(w.slice(0, 3))) score += 1;
    }
    // Boost auto-reply contacts
    if (c.autoReply) score += 1;
    return { ...c, score };
  });

  // Get contacts with score > 0, sorted by score desc
  const matched = scored.filter(c => c.score > 0).sort((a, b) => b.score - a.score);

  if (matched.length > 0) {
    // Always include auto-reply contacts + matched contacts, cap at 50
    const autoReply = contacts.filter(c => c.autoReply && !matched.find(m => m.id === c.id));
    return [...matched, ...autoReply].slice(0, 50);
  }

  // No matches at all — send auto-reply contacts only
  const autoOnly = contacts.filter(c => c.autoReply);
  return autoOnly.length > 0 ? autoOnly : contacts.slice(0, 50);
}

async function parseCommand(text, contacts) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

  // Pre-filter to avoid sending 2000+ contacts to LLM
  const filteredContacts = preFilterContacts(text, contacts);
  console.log(`[Alex] Pre-filtered to ${filteredContacts.length} contacts (from ${contacts.length})`);

  const contactList = filteredContacts.map(c =>
    `- "${c.name}" (ID: ${c.id})${c.autoReply ? ' [auto-reply ON]' : ''}`
  ).join('\n');

  const systemPrompt = `You are a command parser for a WhatsApp AI assistant. Parse the user's command and return STRICT JSON.

Current date: ${dateStr}
Current time: ${timeStr}

Available contacts:
${contactList}

Return JSON with these fields:
{
  "action": "send_message" | "schedule_message" | "toggle_autoreply" | "unknown",
  "contactQuery": "the name/reference the user used for the contact",
  "matchedContactId": "the exact contact ID from the list above, or null if no match",
  "matchedContactName": "the matched contact's name from the list, or null",
  "intent": "the message content/instruction stripped of contact name and time references",
  "time": "ISO 8601 datetime string for scheduled messages, or null for immediate",
  "autoReplyAction": "on" | "off" | null
}

Rules:
- "send X a message about Y" or "tell X Y" → action: "send_message" (no time mentioned = immediate)
- "send X a message at 8pm" or "tell X Y tomorrow morning" → action: "schedule_message"
- "turn on auto-reply for X" → action: "toggle_autoreply", autoReplyAction: "on"
- "turn off auto-reply for X" → action: "toggle_autoreply", autoReplyAction: "off"
- Match contact names FUZZILY: "mom" could match "Mom", "ayush" matches "Ayush Sharma", etc.
- For time resolution:
  - "at 8" with no am/pm: if current time is before 8am, use 8:00 AM today; if after 8am but before 8pm, use 8:00 PM today; if after 8pm, use 8:00 AM tomorrow
  - "tonight" → today 21:00
  - "tomorrow morning" → tomorrow 09:00
  - "tomorrow evening" → tomorrow 18:00
  - "in 2 hours" → current time + 2 hours
  - No time mentioned → null (immediate send)
- The "intent" should be ONLY the message instruction, stripped of the contact reference and time. E.g. "tell ayush to come at 5" → intent: "tell him to come at 5". "send mom a good morning message tomorrow at 8" → intent: "send a good morning message"
- Output ONLY valid JSON. No explanation. No markdown.`;

  const response = await callLLM(systemPrompt, [{ role: 'user', content: text }], 400);

  // Parse the JSON response
  let parsed;
  try {
    // Strip markdown code fences if present
    const cleaned = response.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch {
    console.log(`[Alex] LLM returned invalid JSON: ${response}`);
    return { action: 'unknown', error: 'Failed to parse command' };
  }

  // Always check for multiple matches using the ORIGINAL query (e.g. "ayush")
  // not the LLM's matchedContactName (which could be "Ayush Kumar Mahato")
  const query = parsed.contactQuery;
  if (query) {
    const allMatches = fuzzyMatchContacts(query, contacts);

    if (allMatches.length > 1) {
      // Multiple contacts match the query — force clarification
      parsed.multipleMatches = allMatches;
      // Don't let LLM's pick auto-resolve — user must choose
      parsed.matchedContactId = null;
      parsed.matchedContactName = null;
    } else if (allMatches.length === 1) {
      // Exactly one match — use it (overrides LLM if it picked wrong)
      parsed.matchedContactId = allMatches[0].id;
      parsed.matchedContactName = allMatches[0].name;
    }
    // 0 matches: keep whatever LLM returned (it had the filtered list)
  }

  return parsed;
}

/**
 * Fuzzy match: return ALL contacts matching a query, ordered by match quality.
 * Priority: exact > starts with > contains > reverse contains
 */
function fuzzyMatchContacts(query, contacts) {
  if (!query) return [];
  const q = query.toLowerCase().trim();

  const exact = contacts.filter(c => c.name.toLowerCase() === q);
  if (exact.length === 1) return exact;

  const startsWith = contacts.filter(c => c.name.toLowerCase().startsWith(q));
  if (startsWith.length === 1) return startsWith;
  if (startsWith.length > 1) return startsWith;

  const contains = contacts.filter(c => c.name.toLowerCase().includes(q));
  if (contains.length >= 1) return contains;

  const reverse = contacts.filter(c => q.includes(c.name.toLowerCase()));
  if (reverse.length >= 1) return reverse;

  return [];
}

/**
 * Execute a parsed command.
 * Returns { success, message } for confirmation.
 */
async function executeCommand(parsed, client) {
  switch (parsed.action) {
    case 'send_message':
      return executeSendMessage(parsed, client);
    case 'schedule_message':
      return executeScheduleMessage(parsed, client);
    case 'toggle_autoreply':
      return executeToggleAutoReply(parsed);
    default:
      return { success: false, message: `Could not understand the command.` };
  }
}

async function executeSendMessage(parsed, client) {
  if (!parsed.matchedContactId || !parsed.matchedContactName) {
    return { success: false, message: `Could not find any contact matching "${parsed.contactQuery}". Check the name and try again.` };
  }

  const { matchedContactId, matchedContactName, intent } = parsed;

  // Generate the message in the user's style for this contact
  const messageBody = await agent.generateFromInstruction(
    matchedContactId,
    matchedContactName,
    intent
  );

  // Send it
  await client.sendMessage(matchedContactId, messageBody);

  // Store in vectordb
  try {
    await vectordb.storeMessage({
      id: `alex_${Date.now()}_${matchedContactId}`,
      body: messageBody,
      contactId: matchedContactId,
      contactName: matchedContactName,
      fromMe: true,
      timestamp: Math.floor(Date.now() / 1000),
      type: 'chat',
      chatIsGroup: false,
    });
  } catch (err) {
    console.log(`[Alex] Warning: Failed to store message: ${err.message}`);
  }

  return {
    success: true,
    message: `Sent to ${matchedContactName}: "${messageBody}"`,
  };
}

async function executeScheduleMessage(parsed, client) {
  if (!parsed.matchedContactId || !parsed.matchedContactName) {
    return { success: false, message: `Could not find any contact matching "${parsed.contactQuery}". Check the name and try again.` };
  }

  if (!parsed.time) {
    return { success: false, message: `No time specified for scheduling.` };
  }

  const { matchedContactId, matchedContactName, intent, time } = parsed;
  const sendAt = new Date(time);

  if (isNaN(sendAt.getTime())) {
    return { success: false, message: `Invalid time: "${time}"` };
  }

  if (sendAt.getTime() <= Date.now()) {
    return { success: false, message: `Scheduled time is in the past.` };
  }

  // Schedule with AI generation at send time (so the style is fresh)
  const jobId = scheduler.scheduleMessage(
    matchedContactId,
    matchedContactName,
    sendAt,
    intent,
    true // generateWithAI
  );

  if (!jobId) {
    return { success: false, message: `Failed to schedule message.` };
  }

  const timeStr = sendAt.toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: true,
  });

  return {
    success: true,
    message: `Scheduled for ${matchedContactName} at ${timeStr}: "${intent}"`,
  };
}

function executeToggleAutoReply(parsed) {
  if (!parsed.matchedContactId || !parsed.matchedContactName) {
    return { success: false, message: `Could not find any contact matching "${parsed.contactQuery}". Check the name and try again.` };
  }

  const { matchedContactId, matchedContactName, autoReplyAction } = parsed;

  if (autoReplyAction === 'on') {
    config.addAutoReplyContact(matchedContactId, matchedContactName);
    return {
      success: true,
      message: `Auto-reply turned ON for ${matchedContactName}.`,
    };
  } else if (autoReplyAction === 'off') {
    config.removeAutoReplyContact(matchedContactId);
    return {
      success: true,
      message: `Auto-reply turned OFF for ${matchedContactName}.`,
    };
  }

  return { success: false, message: `Unclear: turn auto-reply on or off?` };
}

/**
 * Main entry point: handle an Alex command message.
 */
async function handleAlexCommand(msg, client) {
  // Clear any old pending clarification
  pendingClarification = null;

  const commandText = stripTrigger(msg.body);
  console.log(`\n[Alex] Command: "${commandText}"`);

  try {
    // Gather contacts for matching
    const contacts = await gatherContacts(client);
    console.log(`[Alex] ${contacts.length} contacts available for matching`);

    // Parse the command
    const parsed = await parseCommand(commandText, contacts);
    console.log(`[Alex] Parsed: ${parsed.action} → ${parsed.matchedContactName || parsed.contactQuery || '?'} | "${parsed.intent || ''}"`);

    // Check if we need clarification (multiple matches)
    if (parsed.multipleMatches && parsed.multipleMatches.length > 1) {
      const list = parsed.multipleMatches.map((c, i) =>
        `${i + 1}. ${c.name} (${c.id.replace('@c.us', '')})`
      ).join('\n');

      // Store pending state
      pendingClarification = {
        parsed,
        timestamp: Date.now(),
        selfChatId: msg.from,
      };

      const prompt = `Multiple contacts match "${parsed.contactQuery}":\n${list}\n\nReply with the number or full name.`;
      await client.sendMessage(msg.from, prompt);
      console.log(`[Alex] Waiting for clarification (${parsed.multipleMatches.length} matches)`);
      return;
    }

    // Execute
    const result = await executeCommand(parsed, client);

    // Send confirmation to self-chat
    const icon = result.success ? '\u2713' : '\u2717';
    const confirmation = `${icon} ${result.message}`;
    await client.sendMessage(msg.from, confirmation);
    console.log(`[Alex] ${confirmation}`);
  } catch (err) {
    console.error(`[Alex] Error: ${err.message}`);
    try {
      await client.sendMessage(msg.from, `\u2717 Alex error: ${err.message}`);
    } catch {}
  }
}

/**
 * Handle a clarification reply (user picked a contact from the list).
 */
async function handleClarification(msg, client) {
  const pending = pendingClarification;
  pendingClarification = null; // consume it

  const reply = msg.body.trim();
  const { parsed } = pending;
  const matches = parsed.multipleMatches;

  console.log(`\n[Alex] Clarification reply: "${reply}"`);

  // Try to resolve: number pick, or name match
  let picked = null;

  // Check if it's a number (e.g. "1", "2")
  const num = parseInt(reply, 10);
  if (!isNaN(num) && num >= 1 && num <= matches.length) {
    picked = matches[num - 1];
  }

  // Try matching by name
  if (!picked) {
    const q = reply.toLowerCase();
    picked = matches.find(c => c.name.toLowerCase() === q)
      || matches.find(c => c.name.toLowerCase().includes(q))
      || matches.find(c => q.includes(c.name.toLowerCase()));
  }

  if (!picked) {
    try {
      await client.sendMessage(msg.from, `\u2717 Could not match "${reply}" to any of the options. Try again with the command.`);
    } catch {}
    return;
  }

  // Resolve the contact in the parsed command
  parsed.matchedContactId = picked.id;
  parsed.matchedContactName = picked.name;
  delete parsed.multipleMatches;

  console.log(`[Alex] Resolved to: ${picked.name} (${picked.id})`);

  try {
    const result = await executeCommand(parsed, client);
    const icon = result.success ? '\u2713' : '\u2717';
    const confirmation = `${icon} ${result.message}`;
    await client.sendMessage(msg.from, confirmation);
    console.log(`[Alex] ${confirmation}`);
  } catch (err) {
    console.error(`[Alex] Error: ${err.message}`);
    try {
      await client.sendMessage(msg.from, `\u2717 Alex error: ${err.message}`);
    } catch {}
  }
}

module.exports = {
  isAlexCommand,
  hasPendingClarification,
  stripTrigger,
  parseCommand,
  executeCommand,
  handleAlexCommand,
  handleClarification,
};
