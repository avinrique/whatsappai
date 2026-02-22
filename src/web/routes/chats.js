const express = require('express');
const vectordb = require('../../data/vectordb');
const agent = require('../../agent/agent');

module.exports = function (client) {
  const router = express.Router();

  // List all WhatsApp chats
  router.get('/', async (req, res) => {
    try {
      const importer = require('../../data/importer');
      const chats = await importer.listChats(client);
      res.json(chats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get recent messages for a contact — merges vectordb + live WhatsApp
  router.get('/:contactId/messages', async (req, res) => {
    try {
      const contactId = req.params.contactId;
      const limit = parseInt(req.query.limit) || 50;

      // Fetch from both sources in parallel
      const [dbMessages, liveMessages] = await Promise.all([
        vectordb.getRecentMessages(contactId, limit).catch(() => []),
        fetchLiveMessages(client, contactId, limit).catch(() => []),
      ]);

      // Merge and deduplicate by timestamp + body (same message from both sources)
      const seen = new Set();
      const merged = [];

      for (const m of [...dbMessages, ...liveMessages]) {
        // Key: timestamp + first 50 chars of body + direction
        const key = `${m.timestamp}_${(m.body || '').slice(0, 50)}_${m.fromMe}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(m);
        }
      }

      // Sort by timestamp ascending, return latest N
      merged.sort((a, b) => a.timestamp - b.timestamp);
      res.json(merged.slice(-limit));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Send a literal message
  router.post('/send', async (req, res) => {
    try {
      const { contactId, message } = req.body;
      if (!contactId || !message) {
        return res.status(400).json({ error: 'contactId and message required' });
      }
      await client.sendMessage(contactId, message);
      // Store in vectordb
      await vectordb.storeMessage({
        id: `web_${Date.now()}_${contactId}`,
        body: message,
        contactId,
        contactName: req.body.contactName || contactId,
        fromMe: true,
        timestamp: Math.floor(Date.now() / 1000),
        type: 'chat',
        chatIsGroup: false,
      });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Preview AI reply
  router.post('/preview', async (req, res) => {
    try {
      const { contactId, contactName, message } = req.body;
      if (!contactId || !message) {
        return res.status(400).json({ error: 'contactId and message required' });
      }
      const reply = await agent.previewReply(contactId, contactName || contactId, message);
      res.json({ reply });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

/**
 * Fetch recent messages from the live WhatsApp client.
 * Returns them in the same shape as vectordb messages.
 */
async function fetchLiveMessages(client, contactId, limit) {
  if (!client) return [];
  try {
    const chat = await client.getChatById(contactId);
    if (!chat) return [];
    const msgs = await chat.fetchMessages({ limit });
    return msgs
      .filter(m => m.body || m.type === 'image' || m.type === 'sticker')
      .map(m => ({
        body: m.body || `[${m.type}]`,
        contactId,
        fromMe: m.fromMe,
        timestamp: m.timestamp || 0,
        type: m.type,
      }));
  } catch {
    return [];
  }
}
