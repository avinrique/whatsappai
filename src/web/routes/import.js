const express = require('express');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const importer = require('../../data/importer');
const config = require('../../config/config');
const vectordb = require('../../data/vectordb');
const { parseWhatsAppChat, analyzeReplyTiming } = require('../../data/chat-parser');
const styleProfiler = require('../../agent/style-profiler');
const { describeImages } = require('../../agent/chain');

module.exports = function (client, upload) {
  const router = express.Router();

  // List available chats to import (with import stats)
  router.get('/chats', async (req, res) => {
    try {
      const chats = await importer.listChats(client);
      const importState = config.get('importState') || {};

      // Get message counts from vectordb
      let stats;
      try {
        stats = await vectordb.getStats();
      } catch {
        stats = { contacts: [] };
      }
      const countMap = {};
      for (const c of stats.contacts) {
        countMap[c.id] = c.messageCount;
      }

      const enriched = chats.map(c => ({
        ...c,
        importedMessages: countMap[c.id] || 0,
        lastImport: importState[c.id] ? new Date(importState[c.id] * 1000).toLocaleString() : null,
      }));

      res.json(enriched);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Start import for selected chats
  router.post('/start', async (req, res) => {
    try {
      const { chatIds } = req.body;
      if (!chatIds || !Array.isArray(chatIds) || chatIds.length === 0) {
        return res.status(400).json({ error: 'chatIds array required' });
      }

      const allChats = await importer.listChats(client);
      const selected = allChats.filter(c => chatIds.includes(c.id));

      if (selected.length === 0) {
        return res.status(400).json({ error: 'No matching chats found' });
      }

      res.json({ started: true, chatCount: selected.length });

      const { getIO } = require('../server');
      const io = getIO();

      const totalStored = await importer.importChats(client, selected, (update) => {
        if (io) io.emit('import:progress', update);
      });

      if (io) io.emit('import:done', { totalStored });
    } catch (err) {
      const { getIO } = require('../server');
      const io = getIO();
      if (io) io.emit('import:done', { error: err.message });
    }
  });

  // Upload WhatsApp chat export (zip file)
  // Wrap multer in manual call so we can catch MulterError (file too large etc.)
  router.post('/upload', (req, res, next) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
          ? `File too large. Max is 500MB. Try exporting without media.`
          : `Upload error: ${err.message}`;
        return res.status(413).json({ error: msg });
      }
      next();
    });
  }, async (req, res) => {
    const { getIO } = require('../server');
    const io = getIO();

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
      }

      const { contactId, contactName } = req.body;
      if (!contactId || !contactName) {
        // Clean up uploaded file
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'contactId and contactName are required' });
      }

      const userName = config.get('userName') || 'Avin';

      // Respond immediately, process in background
      res.json({ started: true });

      if (io) io.emit('upload:progress', { phase: 'unzipping', message: 'Extracting zip file...' });

      // Unzip the file
      const extractDir = req.file.path + '_extracted';
      fs.mkdirSync(extractDir, { recursive: true });

      try {
        execSync(`unzip -o -q "${req.file.path}" -d "${extractDir}"`, { timeout: 30000 });
      } catch (err) {
        fs.unlinkSync(req.file.path);
        fs.rmSync(extractDir, { recursive: true, force: true });
        if (io) io.emit('upload:done', { error: 'Failed to extract zip file: ' + err.message });
        return;
      }

      // Find the WhatsApp chat .txt file
      // Strategy: prioritize _chat.txt, then try every .txt and pick the one
      // that actually parses as a WhatsApp chat (first few lines match the format)
      const files = getAllFiles(extractDir);
      const txtFiles = files.filter(f => f.endsWith('.txt'));

      if (txtFiles.length === 0) {
        cleanup(req.file.path, extractDir);
        if (io) io.emit('upload:done', {
          error: 'No .txt file found in the zip. Make sure you\'re uploading a WhatsApp "Export Chat" zip file.'
        });
        return;
      }

      if (io) io.emit('upload:progress', { phase: 'parsing', message: `Found ${txtFiles.length} .txt file(s). Looking for WhatsApp chat...` });

      // Try to find the actual chat file
      let chatFile = null;
      let txtContent = null;
      let messages = null;

      // First pass: prefer files named _chat.txt or WhatsApp Chat
      const prioritized = [
        ...txtFiles.filter(f => path.basename(f) === '_chat.txt'),
        ...txtFiles.filter(f => /whatsapp.*chat/i.test(path.basename(f)) && path.basename(f) !== '_chat.txt'),
        ...txtFiles.filter(f => path.basename(f) !== '_chat.txt' && !/whatsapp.*chat/i.test(path.basename(f))),
      ];

      for (const candidate of prioritized) {
        try {
          const content = fs.readFileSync(candidate, 'utf-8');
          const parsed = parseWhatsAppChat(content, userName);
          console.log(`[Upload] Tried ${path.basename(candidate)}: ${parsed.length} messages`);

          if (parsed.length > 0) {
            chatFile = candidate;
            txtContent = content;
            messages = parsed;
            break;
          }
        } catch (err) {
          console.log(`[Upload] Failed to read ${path.basename(candidate)}: ${err.message}`);
        }
      }

      if (!messages || messages.length === 0) {
        // Show what we found so the user knows what went wrong
        const fileNames = txtFiles.map(f => path.basename(f)).join(', ');
        const firstFile = fs.readFileSync(txtFiles[0], 'utf-8');
        const preview = firstFile.split('\n').slice(0, 3).join(' | ').slice(0, 150);
        cleanup(req.file.path, extractDir);
        if (io) io.emit('upload:done', {
          error: `This doesn't look like a WhatsApp chat export. Found files: [${fileNames}]. ` +
                 `First file preview: "${preview}...". ` +
                 `To export: open a chat in WhatsApp → tap ⋮ → More → Export chat → choose "Without media" or "Include media".`
        });
        return;
      }

      console.log(`[Upload] Chat file: ${chatFile} — ${messages.length} messages, first sender: "${messages[0].sender}"`);

      if (io) io.emit('upload:progress', { phase: 'timing', message: `Parsed ${messages.length} messages. Analyzing timing...` });

      // Analyze reply timing
      const timingStats = analyzeReplyTiming(messages, userName);

      // Find and describe sample images from the export (up to 15-20)
      let imageDescriptions = [];
      const imageFiles = files.filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));

      if (imageFiles.length > 0) {
        if (io) io.emit('upload:progress', { phase: 'images', message: `Found ${imageFiles.length} images. Analyzing sample...` });

        const sampleSize = Math.min(imageFiles.length, 15);
        const sampled = imageFiles.length <= sampleSize
          ? imageFiles
          : [...imageFiles].sort(() => Math.random() - 0.5).slice(0, sampleSize);

        const base64Images = [];
        for (const imgPath of sampled) {
          try {
            const imgData = fs.readFileSync(imgPath);
            const ext = path.extname(imgPath).toLowerCase().replace('.', '');
            const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
            base64Images.push(`data:${mime};base64,${imgData.toString('base64')}`);
          } catch {
            // Skip unreadable images
          }
        }

        if (base64Images.length > 0) {
          try {
            imageDescriptions = await describeImages(base64Images);
          } catch (err) {
            console.error(`[Upload] Image description failed: ${err.message}`);
          }
        }
      }

      // Store messages in vectordb in batches of 50
      if (io) io.emit('upload:progress', { phase: 'storing', message: `Storing ${messages.length} messages in vector database...` });

      const BATCH_SIZE = 50;
      let totalStored = 0;

      for (let i = 0; i < messages.length; i += BATCH_SIZE) {
        const batch = messages.slice(i, i + BATCH_SIZE);
        const records = batch.map((m, idx) => ({
          id: `upload_${contactId}_${m.timestamp}_${i + idx}`,
          body: m.body,
          contactId,
          contactName,
          fromMe: m.fromMe,
          timestamp: m.timestamp,
          type: 'chat',
          chatIsGroup: false,
        }));

        try {
          await vectordb.storeMessages(records);
          totalStored += records.length;
        } catch (err) {
          console.error(`[Upload] Batch store failed: ${err.message}`);
        }

        if (io && i % (BATCH_SIZE * 5) === 0) {
          io.emit('upload:progress', {
            phase: 'storing',
            message: `Stored ${totalStored}/${messages.length} messages...`,
            current: totalStored,
            total: messages.length,
          });
        }
      }

      // Save timing stats in meta for smart reply timing
      const meta = styleProfiler.loadMeta(contactId);
      if (meta) {
        meta.hasTimingStats = true;
        meta.timingStats = timingStats;
        const safe = contactId.replace(/[^a-zA-Z0-9]/g, '_');
        const metaPath = path.join(config.DATA_DIR, 'style-profiles', `${safe}.meta.json`);
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      }

      // Cleanup temp files
      cleanup(req.file.path, extractDir);

      if (io) io.emit('upload:done', {
        totalStored,
        totalMessages: messages.length,
        imageCount: imageDescriptions.length,
        timingStats,
        imageDescriptions,
      });

    } catch (err) {
      // Cleanup on error
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
        const extractDir = req.file.path + '_extracted';
        if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
      }
      if (io) io.emit('upload:done', { error: err.message });
    }
  });

  // Delete imported messages for a contact (and reset import state)
  router.delete('/:contactId', async (req, res) => {
    try {
      const contactId = req.params.contactId;
      const deleted = await vectordb.deleteByContact(contactId);

      // Reset import state so it can be re-imported fresh
      const importState = config.get('importState') || {};
      delete importState[contactId];
      config.set('importState', importState);

      res.json({ success: true, deletedMessages: deleted });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};

/**
 * Recursively get all files in a directory.
 */
function getAllFiles(dirPath, files = []) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      getAllFiles(fullPath, files);
    } else if (!entry.name.startsWith('.')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Clean up temp upload files.
 */
function cleanup(filePath, extractDir) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
  } catch {
    // Best effort cleanup
  }
}
