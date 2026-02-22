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

      // Fetch from both sources in parallel — request more from each to ensure good coverage
      const fetchLimit = limit * 2;
      const [dbMessages, liveMessages] = await Promise.all([
        vectordb.getRecentMessages(contactId, fetchLimit).catch(err => {
          console.error(`[Chats] DB fetch failed for ${contactId}: ${err.message}`);
          return [];
        }),
        fetchLiveMessages(client, contactId, fetchLimit).catch(err => {
          console.error(`[Chats] Live fetch failed for ${contactId}: ${err.message}`);
          return [];
        }),
      ]);

      console.log(`[Chats] ${contactId}: DB=${dbMessages.length}, Live=${liveMessages.length}`);

      // Backfill: store any live messages not in DB (fire-and-forget)
      if (liveMessages.length > 0) {
        const dbTimestamps = new Set(dbMessages.map(m => `${m.timestamp}_${(m.body || '').slice(0, 50)}_${m.fromMe}`));
        const newLive = liveMessages.filter(m => {
          const key = `${m.timestamp}_${(m.body || '').slice(0, 50)}_${m.fromMe}`;
          return !dbTimestamps.has(key);
        });
        if (newLive.length > 0) {
          console.log(`[Chats] Backfilling ${newLive.length} live messages to DB for ${contactId}`);
          const chatName = newLive[0].contactName || contactId;
          for (const m of newLive) {
            vectordb.storeMessage({
              id: `live_${m.timestamp}_${contactId}_${m.fromMe}`,
              body: m.body || '',
              contactId,
              contactName: chatName,
              fromMe: m.fromMe,
              timestamp: m.timestamp,
              type: m.type || 'chat',
              chatIsGroup: false,
            }).catch(() => {});
          }
        }
      }

      // Merge: prioritize live messages (more up-to-date), then fill from DB
      const seen = new Set();
      const merged = [];

      // Add live messages first (they're the source of truth for recent messages)
      for (const m of liveMessages) {
        const key = `${m.timestamp}_${(m.body || '').slice(0, 50)}_${m.fromMe}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(m);
        }
      }

      // Then add DB messages (for older history)
      for (const m of dbMessages) {
        const key = `${m.timestamp}_${(m.body || '').slice(0, 50)}_${m.fromMe}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(m);
        }
      }

      // Sort by timestamp ascending, fixing future timestamps from DD/MM vs MM/DD import bugs
      const now = Math.floor(Date.now() / 1000);
      const fix = (ts) => {
        if (!ts || ts <= now) return ts || 0;
        const d = new Date(ts * 1000);
        const day = d.getUTCDate();
        const month = d.getUTCMonth();
        if (day <= 12) {
          const fixed = new Date(d);
          fixed.setUTCMonth(day - 1);
          fixed.setUTCDate(month + 1);
          const fixedTs = Math.floor(fixed.getTime() / 1000);
          if (fixedTs <= now) return fixedTs;
        }
        return now;
      };
      // Fix timestamps in-place so UI shows correct times too
      for (const m of merged) {
        m.timestamp = fix(m.timestamp);
      }
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

  // Sync: pull live WhatsApp messages and store in DB to fill gaps
  router.post('/:contactId/sync', async (req, res) => {
    const contactId = req.params.contactId;
    if (!client || !client.info) {
      return res.status(503).json({ error: 'WhatsApp client not ready' });
    }

    try {
      const chat = await client.getChatById(contactId);
      if (!chat) return res.status(404).json({ error: 'Chat not found' });

      // Fetch a large batch from WhatsApp
      const msgs = await chat.fetchMessages({ limit: 200 });
      const textMsgs = msgs.filter(m => m.body);

      let stored = 0;
      let skipped = 0;

      for (const m of textMsgs) {
        const msgId = m.id._serialized || `sync_${m.timestamp}_${contactId}`;
        try {
          const exists = await vectordb.messageExists(msgId);
          if (!exists) {
            await vectordb.storeMessage({
              id: msgId,
              body: m.body,
              contactId,
              contactName: chat.name || contactId,
              fromMe: m.fromMe,
              timestamp: m.timestamp,
              type: m.type,
              chatIsGroup: chat.isGroup,
            });
            stored++;
          } else {
            skipped++;
          }
        } catch (err) {
          console.error(`[Sync] Failed to store message: ${err.message}`);
        }
      }

      res.json({ total: textMsgs.length, stored, skipped });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Debug endpoint: diagnose message sources for a contact
  router.get('/:contactId/debug', async (req, res) => {
    const contactId = req.params.contactId;
    const results = { contactId, db: {}, live: {}, client: {} };

    // Client status
    results.client.exists = !!client;
    results.client.ready = !!(client && client.info);

    // DB messages
    try {
      const dbMsgs = await vectordb.getRecentMessages(contactId, 10);
      results.db.count = dbMsgs.length;
      results.db.newest = dbMsgs.length > 0 ? {
        time: new Date(dbMsgs[dbMsgs.length - 1].timestamp * 1000).toISOString(),
        body: (dbMsgs[dbMsgs.length - 1].body || '').slice(0, 50),
      } : null;
    } catch (err) {
      results.db.error = err.message;
    }

    // Live messages
    try {
      if (!client) {
        results.live.error = 'No client';
      } else if (!client.info) {
        results.live.error = 'Client not ready';
      } else {
        const chat = await client.getChatById(contactId);
        results.live.chatFound = !!chat;
        if (chat) {
          results.live.chatName = chat.name;
          const msgs = await chat.fetchMessages({ limit: 10 });
          results.live.fetchedCount = msgs.length;
          results.live.rawTypes = msgs.map(m => m.type);
          const textMsgs = msgs.filter(m => m.body);
          results.live.textCount = textMsgs.length;
          if (textMsgs.length > 0) {
            const last = textMsgs[textMsgs.length - 1];
            results.live.newest = {
              time: new Date(last.timestamp * 1000).toISOString(),
              body: (last.body || '').slice(0, 50),
              fromMe: last.fromMe,
            };
          }
        }
      }
    } catch (err) {
      results.live.error = err.message;
      results.live.stack = err.stack?.split('\n').slice(0, 3);
    }

    res.json(results);
  });

  return router;
};

/**
 * Fetch recent messages from the live WhatsApp client.
 * Returns them in the same shape as vectordb messages.
 */
async function fetchLiveMessages(client, contactId, limit) {
  if (!client) {
    console.log(`[Chats] Live fetch skipped: no client`);
    return [];
  }
  if (!client.info) {
    console.log(`[Chats] Live fetch skipped: client not ready`);
    return [];
  }
  try {
    const chat = await client.getChatById(contactId);
    if (!chat) {
      console.log(`[Chats] Live fetch: chat not found for ${contactId}`);
      return [];
    }
    // Fetch in smaller batches if large limit requested (WhatsApp can choke on big fetches)
    const fetchLimit = Math.min(limit, 50);
    const msgs = await chat.fetchMessages({ limit: fetchLimit });
    console.log(`[Chats] Live fetch got ${msgs.length} raw messages for ${contactId}`);
    const filtered = msgs
      .filter(m => m.body || m.type === 'image' || m.type === 'sticker')
      .map(m => ({
        body: m.body || `[${m.type}]`,
        contactId,
        contactName: chat.name || contactId,
        fromMe: m.fromMe,
        timestamp: m.timestamp || 0,
        type: m.type,
      }));
    return filtered;
  } catch (err) {
    console.error(`[Chats] Live fetch error for ${contactId}: ${err.message}`);
    return [];
  }
}
