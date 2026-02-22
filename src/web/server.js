const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const config = require('../config/config');
const vectordb = require('../data/vectordb');

// Multer config for file uploads
const UPLOAD_DIR = path.join(config.DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
const upload = multer({ dest: UPLOAD_DIR, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB max — WhatsApp exports with media can be large

let io = null;

function createWebServer(whatsappClient) {
  const app = express();
  const server = http.createServer(app);
  io = new Server(server);

  // Middleware
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  // Routes
  app.use('/api/chats', require('./routes/chats')(whatsappClient));
  app.use('/api/import', require('./routes/import')(whatsappClient, upload));
  app.use('/api/autoreply', require('./routes/autoreply')());
  app.use('/api/profiles', require('./routes/profiles')());
  app.use('/api/scheduler', require('./routes/scheduler')(whatsappClient));
  app.use('/api/config', require('./routes/config')());
  app.use('/api/stats', require('./routes/stats')());
  app.use('/api/status', (req, res) => {
    const state = whatsappClient.info ? 'connected' : 'disconnected';
    res.json({ state });
  });

  // Wire WhatsApp events to socket.io + persist to vectordb
  whatsappClient.on('message', async (msg) => {
    try {
      const contact = await msg.getContact();
      const chat = await msg.getChat();
      const contactName = contact.pushname || contact.name || msg.from;

      io.emit('message:incoming', {
        id: msg.id._serialized,
        from: msg.from,
        contactName,
        chatName: chat.name || contactName,
        body: msg.body || '',
        type: msg.type,
        timestamp: msg.timestamp,
        isGroup: chat.isGroup,
      });

      // Store in vectordb so messages persist across sessions (skip if already stored by auto-reply)
      if (msg.body) {
        const msgId = msg.id._serialized || `${msg.from}_${msg.timestamp}`;
        const exists = await vectordb.messageExists(msgId).catch(() => false);
        if (!exists) {
          vectordb.storeMessage({
            id: msgId,
            body: msg.body,
            contactId: msg.from,
            contactName,
            fromMe: false,
            timestamp: msg.timestamp,
            type: msg.type,
            chatIsGroup: chat.isGroup,
          }).catch(() => {}); // best-effort
        }
      }
    } catch (err) {
      // Silently ignore socket errors for messages
    }
  });

  whatsappClient.on('message_create', async (msg) => {
    if (!msg.fromMe) return;
    try {
      const chat = await msg.getChat();
      const chatName = chat.name || msg.to;

      io.emit('message:outgoing', {
        id: msg.id._serialized,
        to: msg.to,
        chatName,
        body: msg.body || '',
        type: msg.type,
        timestamp: msg.timestamp,
      });

      // Store outgoing messages in vectordb (skip if already stored by send route or auto-reply)
      if (msg.body) {
        const msgId = msg.id._serialized || `${msg.to}_${msg.timestamp}`;
        const exists = await vectordb.messageExists(msgId).catch(() => false);
        if (!exists) {
          vectordb.storeMessage({
            id: msgId,
            body: msg.body,
            contactId: msg.to,
            contactName: chatName,
            fromMe: true,
            timestamp: msg.timestamp,
            type: msg.type,
            chatIsGroup: chat.isGroup,
          }).catch(() => {}); // best-effort
        }
      }
    } catch (err) {
      // Silently ignore
    }
  });

  whatsappClient.on('qr', (qr) => {
    io.emit('client:qr', { qr });
  });

  whatsappClient.on('ready', () => {
    io.emit('client:ready');
  });

  whatsappClient.on('disconnected', (reason) => {
    io.emit('client:disconnected', { reason });
  });

  // Socket.io connection
  io.on('connection', (socket) => {
    // Send current connection state on connect
    const state = whatsappClient.info ? 'connected' : 'disconnected';
    socket.emit('client:status', { state });
  });

  return { app, server, io };
}

function getIO() {
  return io;
}

module.exports = { createWebServer, getIO };
