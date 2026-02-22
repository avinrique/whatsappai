require('dotenv').config();

const readline = require('readline');
const config = require('./src/config/config');
const { createClient, getClient } = require('./src/whatsapp/client');
const embeddings = require('./src/data/embeddings');
const vectordb = require('./src/data/vectordb');
const autoReply = require('./src/agent/auto-reply');
const scheduler = require('./src/scheduler/scheduler');
const commands = require('./src/cli/commands');
const { createWebServer } = require('./src/web/server');

// --- Init ---
config.load();
const client = createClient();

// --- Web Dashboard ---
const WEB_PORT = process.env.WEB_PORT || 3000;
const { server } = createWebServer(client);
server.listen(WEB_PORT, () => {
  console.log(`Dashboard: http://localhost:${WEB_PORT}`);
});

let rl;
try {
  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });
} catch {
  // Running without TTY (background mode)
  rl = { prompt: () => {}, on: () => {}, close: () => {} };
}

// --- Startup ---
client.on('ready', async () => {
  console.log('\n=== WhatsApp AI Agent Connected! ===');
  console.log(`User: ${config.get('userName')} | LLM: ${config.get('llmProvider')}`);

  // Init subsystems
  try {
    await vectordb.init();
    console.log('Vector DB ready.');
  } catch (err) {
    console.error(`Vector DB init failed: ${err.message}`);
  }

  // Init embeddings in background
  embeddings.initPipeline().catch(err => {
    console.error(`Embedding model failed to load: ${err.message}`);
  });

  // Init scheduler
  scheduler.init();

  const autoContacts = config.get('autoReplyContacts') || [];
  if (autoContacts.length > 0) {
    console.log(`Auto-reply active for: ${autoContacts.map(c => c.name).join(', ')}`);
  }

  console.log('\nType /help for commands.\n');
  try { rl.prompt(); } catch {}
});

// --- Incoming Messages ---
client.on('message', async (msg) => {
  const contact = await msg.getContact();
  const chat = await msg.getChat();
  const name = contact.pushname || contact.name || msg.from;
  const chatName = chat.name || name;
  const contactId = msg.from;

  // Track for CLI
  const num = commands.trackChat(contactId, chatName);

  const timestamp = new Date().toLocaleTimeString();
  const autoTag = config.isAutoReplyEnabled(contactId) ? ' [AUTO]' : '';
  console.log(`\n[${timestamp}] #${num} ${chatName}: ${msg.body || `(${msg.type})`}${autoTag}`);
  if (msg.hasMedia) {
    console.log(`  (includes media: ${msg.type})`);
  }

  // Process through auto-reply system (stores + optionally replies)
  const result = await autoReply.handleIncomingMessage(msg, client);
  if (result.replied === 'pending') {
    // Reply will be sent after debounce — auto-reply.js logs the actual reply
  } else if (result.replied && result.reply) {
    console.log(`  [Auto-replied] ${result.reply}`);
  }

  try { rl.prompt(true); } catch {}
});

// --- Outgoing Messages (sent from phone) ---
client.on('message_create', async (msg) => {
  if (!msg.fromMe) return;
  await autoReply.handleOutgoingMessage(msg);
});

// --- CLI Input ---
rl.on('line', async (line) => {
  const input = line.trim();
  if (!input) {
    rl.prompt();
    return;
  }

  try {
    await commands.handleCommand(input, client, rl);
  } catch (err) {
    console.log(`Error: ${err.message}`);
  }

  try { rl.prompt(); } catch {}
});

// --- Start ---
console.log('Starting WhatsApp AI Agent...');
client.initialize();
