const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../../config/config');
const styleProfiler = require('../../agent/style-profiler');

module.exports = function () {
  const router = express.Router();

  // List all profiles
  router.get('/', (req, res) => {
    const profilesDir = path.join(config.DATA_DIR, 'style-profiles');
    if (!fs.existsSync(profilesDir)) {
      return res.json([]);
    }
    const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.meta.json'));
    const profiles = files.map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(profilesDir, f), 'utf-8'));
      } catch {
        return null;
      }
    }).filter(Boolean);
    res.json(profiles);
  });

  // Get a specific profile
  router.get('/:contactId', (req, res) => {
    const doc = styleProfiler.loadDocument(req.params.contactId);
    const meta = styleProfiler.loadMeta(req.params.contactId);
    if (!doc && !meta) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    res.json({ document: doc, meta });
  });

  // Delete a profile
  router.delete('/:contactId', (req, res) => {
    const contactId = req.params.contactId;
    const safe = contactId.replace(/[^a-zA-Z0-9]/g, '_');
    const profilesDir = path.join(config.DATA_DIR, 'style-profiles');
    const docPath = path.join(profilesDir, `${safe}.md`);
    const metaPath = path.join(profilesDir, `${safe}.meta.json`);

    let deleted = false;
    if (fs.existsSync(docPath)) {
      fs.unlinkSync(docPath);
      deleted = true;
    }
    if (fs.existsSync(metaPath)) {
      fs.unlinkSync(metaPath);
      deleted = true;
    }

    res.json({ success: deleted });
  });

  // Build/rebuild a profile
  router.post('/:contactId/build', async (req, res) => {
    try {
      const { contactName, relationshipContext } = req.body;
      if (!contactName) {
        return res.status(400).json({ error: 'contactName required' });
      }

      // Respond immediately, build in background
      res.json({ started: true });

      const { getIO } = require('../server');
      const io = getIO();

      const result = await styleProfiler.buildDocument(
        req.params.contactId,
        contactName,
        (update) => {
          if (io) io.emit('profile:progress', {
            contactId: req.params.contactId,
            ...update,
          });
        },
        relationshipContext || null
      );

      if (io) io.emit('profile:done', {
        contactId: req.params.contactId,
        error: result.error || null,
        meta: result.meta || null,
      });
    } catch (err) {
      const { getIO } = require('../server');
      const io = getIO();
      if (io) io.emit('profile:done', {
        contactId: req.params.contactId,
        error: err.message,
      });
    }
  });

  return router;
};
