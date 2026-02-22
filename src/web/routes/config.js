const express = require('express');
const config = require('../../config/config');

const API_KEY_FIELDS = ['openaiApiKey'];

function maskKey(key) {
  if (!key || key.length < 8) return key ? '****' : '';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

module.exports = function () {
  const router = express.Router();

  // Get all config
  router.get('/', (req, res) => {
    const all = config.getAll();
    const safe = { ...all };
    delete safe.importState;
    delete safe.scheduledMessages;
    // Mask API keys
    for (const field of API_KEY_FIELDS) {
      if (safe[field]) safe[field] = maskKey(safe[field]);
    }
    // Show whether keys are set
    safe._keyStatus = {
      openaiApiKey: !!(config.get('openaiApiKey') || process.env.OPENAI_API_KEY),
    };
    res.json(safe);
  });

  // Update a config setting
  router.put('/', (req, res) => {
    const { key, value } = req.body;
    if (!key) {
      return res.status(400).json({ error: 'key required' });
    }
    const blocked = ['importState', 'scheduledMessages', 'autoReplyContacts'];
    if (blocked.includes(key)) {
      return res.status(400).json({ error: `Cannot set ${key} via config API` });
    }
    config.set(key, value);
    res.json({ success: true, key, value: API_KEY_FIELDS.includes(key) ? maskKey(value) : value });
  });

  return router;
};
