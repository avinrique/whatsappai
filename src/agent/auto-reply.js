const config = require('../config/config');
const vectordb = require('../data/vectordb');
const agent = require('./agent');
const chain = require('./chain');
const styleProfiler = require('./style-profiler');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs)) + minMs;
}

/**
 * Debounce map: contactId → { timeout, messages[], images[] }
 * When messages come in rapid succession, we wait for a pause
 * then reply to ALL of them at once (like a real person would).
 */
const pendingReplies = new Map();
const DEBOUNCE_MS = 4000; // wait 4 seconds after last message before replying

/**
 * Get smart reply delay based on timing stats from the style profile.
 * Falls back to default random delay if no timing data available.
 */
function getSmartDelay(contactId) {
  const meta = styleProfiler.loadMeta(contactId);

  if (meta && meta.hasTimingStats) {
    const doc = styleProfiler.loadDocument(contactId);
    if (doc) {
      // Try to extract timing from the document
      const avgMatch = doc.match(/Average reply time:\s*(\d+)(s|m|h)/);
      if (avgMatch) {
        const val = parseInt(avgMatch[1]);
        const unit = avgMatch[2];
        let baseMs = val * 1000;
        if (unit === 'm') baseMs = val * 60000;
        if (unit === 'h') baseMs = val * 3600000;

        // Add some randomness (±30%) but cap at reasonable bounds
        const variance = baseMs * 0.3;
        const delay = baseMs + randomDelay(-variance, variance);
        return Math.max(2000, Math.min(delay, 300000)); // 2s to 5min
      }
    }
  }

  // Default: think delay + type delay will handle it
  return null;
}

/**
 * Download and describe images from a message.
 * For < 10 images, read all. For >= 10, read ~5 random ones.
 */
async function getImageDescriptions(messages, chat) {
  const imageMessages = [];

  for (const msg of messages) {
    if (msg.hasMedia && (msg.type === 'image' || msg.type === 'sticker')) {
      imageMessages.push(msg);
    }
  }

  if (imageMessages.length === 0) return [];

  // Select which images to process
  let toProcess = imageMessages;
  if (imageMessages.length >= 10) {
    // Random sample of ~5
    const shuffled = [...imageMessages].sort(() => Math.random() - 0.5);
    toProcess = shuffled.slice(0, 5);
  }

  const base64Images = [];
  for (const imgMsg of toProcess) {
    try {
      const media = await imgMsg.downloadMedia();
      if (media && media.data) {
        base64Images.push(`data:${media.mimetype};base64,${media.data}`);
      }
    } catch (err) {
      console.error(`  [Auto-reply] Failed to download image: ${err.message}`);
    }
  }

  if (base64Images.length === 0) return [];

  try {
    return await chain.describeImages(base64Images);
  } catch (err) {
    console.error(`  [Auto-reply] Image description failed: ${err.message}`);
    return [];
  }
}

async function handleIncomingMessage(msg, client) {
  const chat = await msg.getChat();
  const contact = await msg.getContact();
  const contactId = msg.from;
  const contactName = contact.pushname || contact.name || msg.from;
  const isGroup = chat.isGroup;

  // Store message in vector DB
  try {
    await vectordb.storeMessage({
      id: msg.id._serialized || `${msg.from}_${msg.timestamp}`,
      body: msg.body || '',
      contactId,
      contactName,
      fromMe: false,
      timestamp: msg.timestamp,
      type: msg.type,
      chatIsGroup: isGroup,
    });
  } catch (err) {
    console.error(`Failed to store message: ${err.message}`);
  }

  // Track for relationship document refresh
  const shouldUpdate = styleProfiler.trackNewMessage(contactId);
  if (shouldUpdate) {
    styleProfiler.updateDocument(contactId, contactName).then(() => {
      console.log(`\n[Profile] Updated relationship document for ${contactName}`);
    }).catch(err => {
      console.error(`\n[Profile] Failed to update for ${contactName}: ${err.message}`);
    });
  }

  // Only auto-reply to 1-on-1 chats (text or image)
  if (isGroup) return { stored: true, replied: false, reason: 'group chat' };
  if (!config.isAutoReplyEnabled(contactId)) return { stored: true, replied: false, reason: 'not in auto-reply list' };

  // Accept text messages and images
  const isText = msg.type === 'chat' && msg.body;
  const isImage = msg.type === 'image' || msg.type === 'sticker';
  if (!isText && !isImage) return { stored: true, replied: false, reason: 'non-text/image' };

  // Debounce: collect messages, reply after a pause
  const pending = pendingReplies.get(contactId);
  if (pending) {
    clearTimeout(pending.timeout);
    pending.messages.push(msg.body || '[image]');
    pending.rawMessages.push(msg);
  } else {
    pendingReplies.set(contactId, {
      messages: [msg.body || '[image]'],
      rawMessages: [msg],
      timeout: null,
      contactName,
      chat,
      client,
    });
  }

  const entry = pendingReplies.get(contactId);

  // Set a new timer — reply after DEBOUNCE_MS of silence
  entry.timeout = setTimeout(async () => {
    pendingReplies.delete(contactId);
    try {
      await sendDebouncedReply(contactId, entry);
    } catch (err) {
      console.error(`Auto-reply error for ${contactName}: ${err.message}`);
    }
  }, DEBOUNCE_MS);

  return { stored: true, replied: 'pending', reason: 'debouncing' };
}

/**
 * Send one reply for all the messages that came in during the debounce window.
 * Uses chain-of-thought for smarter replies.
 */
async function sendDebouncedReply(contactId, entry) {
  const { messages, rawMessages, contactName, chat, client } = entry;

  // Combine all pending messages into context
  const combinedMessage = messages.length === 1
    ? messages[0]
    : messages.join('\n');

  // Check for images and describe them
  let imageDescriptions = [];
  const imageMessages = rawMessages.filter(m => m.type === 'image' || m.type === 'sticker');
  if (imageMessages.length > 0) {
    imageDescriptions = await getImageDescriptions(rawMessages, chat);
  }

  // Use chain-of-thought reply
  let reply;
  try {
    reply = await chain.thinkAndReply(contactId, contactName, combinedMessage, imageDescriptions);
  } catch (err) {
    console.error(`  [Chain] Failed, falling back to basic reply: ${err.message}`);
    reply = await agent.generateReply(contactId, contactName, combinedMessage);
  }

  // Smart timing delay
  const smartDelay = getSmartDelay(contactId);

  if (smartDelay) {
    // Use timing-aware delay
    await sleep(smartDelay);
  } else {
    // Default: simulate thinking + typing
    const thinkDelay = randomDelay(1500, 3500);
    const typeDelay = reply.length * 40;
    await sleep(thinkDelay);
    try { await chat.sendStateTyping(); } catch {}
    await sleep(Math.min(typeDelay, 8000));
    try { await chat.clearState(); } catch {}
  }

  // Send the reply
  await client.sendMessage(contactId, reply);

  // Store the reply in vector DB
  await vectordb.storeMessage({
    id: `auto_${Date.now()}_${contactId}`,
    body: reply,
    contactId,
    contactName,
    fromMe: true,
    timestamp: Math.floor(Date.now() / 1000),
    type: 'chat',
    chatIsGroup: false,
  });

  styleProfiler.trackNewMessage(contactId);

  console.log(`  [Auto-replied] ${reply}`);
  return reply;
}

async function handleOutgoingMessage(msg) {
  if (!msg.fromMe) return;

  const chat = await msg.getChat();
  const contactId = msg.to;
  const contactName = chat.name || msg.to;

  try {
    await vectordb.storeMessage({
      id: msg.id._serialized || `out_${msg.timestamp}_${contactId}`,
      body: msg.body || '',
      contactId,
      contactName,
      fromMe: true,
      timestamp: msg.timestamp,
      type: msg.type,
      chatIsGroup: chat.isGroup,
    });

    styleProfiler.trackNewMessage(contactId);
  } catch (err) {
    console.error(`Failed to store outgoing message: ${err.message}`);
  }
}

module.exports = {
  handleIncomingMessage,
  handleOutgoingMessage,
};
