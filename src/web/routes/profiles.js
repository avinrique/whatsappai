const express = require('express');
const fs = require('fs');
const path = require('path');
const config = require('../../config/config');
const styleProfiler = require('../../agent/style-profiler');

// Track active builds so the frontend can resume progress after refresh
const activeBuilds = new Map(); // contactId → { contactName, startedAt, lastProgress }

module.exports = function () {
  const router = express.Router();

  // Get active builds (for resuming progress after refresh)
  router.get('/building', (req, res) => {
    const builds = [];
    for (const [contactId, info] of activeBuilds) {
      builds.push({ contactId, ...info });
    }
    res.json(builds);
  });

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

  // Generate smart profile questions
  router.post('/:contactId/questions', async (req, res) => {
    try {
      const { contactName } = req.body;
      if (!contactName) {
        return res.status(400).json({ error: 'contactName required' });
      }
      const result = await styleProfiler.generateProfileQuestions(req.params.contactId, contactName);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Build/rebuild a profile
  router.post('/:contactId/build', async (req, res) => {
    const contactId = req.params.contactId;

    try {
      const { contactName, relationshipContext, profileQA } = req.body;
      if (!contactName) {
        return res.status(400).json({ error: 'contactName required' });
      }

      // Track this build
      activeBuilds.set(contactId, {
        contactName,
        startedAt: new Date().toISOString(),
        lastProgress: { phase: 'starting', message: 'Starting profile build...' },
      });

      // Respond immediately, build in background
      res.json({ started: true });

      const { getIO } = require('../server');
      const io = getIO();

      const result = await styleProfiler.buildDocument(
        contactId,
        contactName,
        (update) => {
          // Save latest progress so frontend can resume after refresh
          const build = activeBuilds.get(contactId);
          if (build) build.lastProgress = update;

          if (io) io.emit('profile:progress', {
            contactId,
            ...update,
          });
        },
        relationshipContext || null,
        profileQA || null
      );

      activeBuilds.delete(contactId);

      if (io) io.emit('profile:done', {
        contactId,
        error: result.error || null,
        meta: result.meta || null,
      });
    } catch (err) {
      activeBuilds.delete(contactId);

      const { getIO } = require('../server');
      const io = getIO();
      if (io) io.emit('profile:done', {
        contactId,
        error: err.message,
      });
    }
  });

  return router;
};
