const config = require('../config/config');
const vectordb = require('../data/vectordb');
const importer = require('../data/importer');
const styleProfiler = require('../agent/style-profiler');
const agent = require('../agent/agent');
const autoReply = require('../agent/auto-reply');
const scheduler = require('../scheduler/scheduler');

// State for CLI
const recentChats = new Map();
let chatCounter = 0;

function trackChat(id, name) {
  chatCounter++;
  recentChats.set(chatCounter, { id, name });
  if (recentChats.size > 50) {
    const firstKey = recentChats.keys().next().value;
    recentChats.delete(firstKey);
  }
  return chatCounter;
}

function getRecentChat(num) {
  return recentChats.get(num);
}

function printHelp() {
  console.log('\nCommands:');
  console.log('  /text <name> <message>         Send exact message to a contact (no AI)');
  console.log('  /reply <#> <message>           Reply to a recent chat');
  console.log('  /send <phone> <message>        Send to a phone number');
  console.log('  /chats                         Show recent chats');
  console.log('  /history <#> [count]           Fetch past messages from WhatsApp');
  console.log('  /import                        Import chat history to vector DB');
  console.log('  /autoreply add <name>          Enable auto-reply for a contact');
  console.log('  /autoreply remove <name>       Disable auto-reply');
  console.log('  /autoreply list                Show auto-reply contacts');
  console.log('  /ask <name> <message>          Preview AI reply (don\'t send)');
  console.log('  /style <name>                  View/rebuild style profile');
  console.log('  /schedule <name> <time> <msg>  Schedule a message');
  console.log('  /schedule list                 Show pending scheduled messages');
  console.log('  /schedule cancel <id>          Cancel scheduled message');
  console.log('  /stats                         Show system stats');
  console.log('  /config <key> <value>          Update config');
  console.log('  /exclude <name>                Exclude chat from import');
  console.log('  /exit                          Quit\n');
}

async function handleCommand(input, client, rl) {
  if (!input) return;

  // /exit
  if (input === '/exit') {
    console.log('Disconnecting...');
    await client.destroy();
    process.exit(0);
  }

  // /help
  if (input === '/help') {
    printHelp();
    return;
  }

  // /chats
  if (input === '/chats') {
    console.log('\nRecent chats:');
    if (recentChats.size === 0) {
      console.log('  No recent chats yet. Wait for messages or use /import.');
    }
    for (const [num, chat] of recentChats) {
      const autoTag = config.isAutoReplyEnabled(chat.id) ? ' [AUTO]' : '';
      console.log(`  #${num} - ${chat.name} (${chat.id})${autoTag}`);
    }
    console.log('');
    return;
  }

  // /stats
  if (input === '/stats') {
    try {
      const stats = await vectordb.getStats();
      console.log('\n=== System Stats ===');
      console.log(`Total messages in DB: ${stats.totalMessages}`);
      console.log(`Contacts: ${stats.contacts.length}`);
      console.log(`LLM provider: ${config.get('llmProvider')}`);
      console.log(`Auto-reply contacts: ${(config.get('autoReplyContacts') || []).length}`);
      const jobs = scheduler.listJobs();
      console.log(`Scheduled messages: ${jobs.length}`);
      if (stats.contacts.length > 0) {
        console.log('\nTop contacts by messages:');
        for (const c of stats.contacts.slice(0, 10)) {
          console.log(`  ${c.name}: ${c.messageCount} messages`);
        }
      }
      console.log('');
    } catch (err) {
      console.log(`Stats error: ${err.message}`);
    }
    return;
  }

  // /history <number> [count]
  const historyMatch = input.match(/^\/history\s+(\d+)(?:\s+(\d+))?/);
  if (historyMatch) {
    const num = parseInt(historyMatch[1]);
    const count = parseInt(historyMatch[2] || '20');
    const chatInfo = recentChats.get(num);
    if (!chatInfo) {
      console.log(`Chat #${num} not found. Use /chats to see recent chats.`);
    } else {
      try {
        const chat = await client.getChatById(chatInfo.id);
        const messages = await chat.fetchMessages({ limit: count });
        console.log(`\n--- Last ${messages.length} messages with ${chatInfo.name} ---`);
        for (const m of messages) {
          const time = new Date(m.timestamp * 1000).toLocaleString();
          const sender = m.fromMe ? 'You' : chatInfo.name;
          console.log(`  [${time}] ${sender}: ${m.body || `(${m.type})`}`);
        }
        console.log('--- end ---\n');
      } catch (err) {
        console.log(`Failed to fetch history: ${err.message}`);
      }
    }
    return;
  }

  // /import
  if (input === '/import') {
    await handleImport(client, rl);
    return;
  }

  // /text <name> <message> — send exactly what you type, no AI
  const textMatch = input.match(/^\/text\s+(\S+)\s+(.+)/s);
  if (textMatch) {
    const name = textMatch[1];
    const message = textMatch[2];
    const contact = await findContactByName(name, client);
    if (contact) {
      try {
        await client.sendMessage(contact.id, message);
        console.log(`Sent to ${contact.name}: ${message}`);
        await vectordb.storeMessage({
          id: `manual_${Date.now()}_${contact.id}`,
          body: message,
          contactId: contact.id,
          contactName: contact.name,
          fromMe: true,
          timestamp: Math.floor(Date.now() / 1000),
          type: 'chat',
          chatIsGroup: false,
        });
      } catch (err) {
        console.log(`Failed to send: ${err.message}`);
      }
    }
    return;
  }

  // /autoreply
  const autoMatch = input.match(/^\/autoreply\s+(.+)/);
  if (autoMatch) {
    await handleAutoReply(autoMatch[1], client);
    return;
  }

  // /ask <name> <message>
  const askMatch = input.match(/^\/ask\s+(\S+)\s+(.+)/s);
  if (askMatch) {
    await handleAsk(askMatch[1], askMatch[2], client);
    return;
  }

  // /style <name>
  const styleMatch = input.match(/^\/style\s+(.+)/);
  if (styleMatch) {
    await handleStyle(styleMatch[1], client);
    return;
  }

  // /schedule
  const schedMatch = input.match(/^\/schedule\s+(.+)/);
  if (schedMatch) {
    await handleSchedule(schedMatch[1], client);
    return;
  }

  // /config
  const configMatch = input.match(/^\/config\s+(\S+)\s+(.+)/);
  if (configMatch) {
    handleConfig(configMatch[1], configMatch[2]);
    return;
  }

  // /exclude <name>
  const excludeMatch = input.match(/^\/exclude\s+(.+)/);
  if (excludeMatch) {
    handleExclude(excludeMatch[1]);
    return;
  }

  // /reply <number> <message>
  const replyMatch = input.match(/^\/reply\s+(\d+)\s+(.+)/s);
  if (replyMatch) {
    const num = parseInt(replyMatch[1]);
    const message = replyMatch[2];
    const chat = recentChats.get(num);
    if (!chat) {
      console.log(`Chat #${num} not found. Use /chats to see recent chats.`);
    } else {
      try {
        await client.sendMessage(chat.id, message);
        console.log(`Sent to ${chat.name}: ${message}`);
        // Store in vector DB
        await vectordb.storeMessage({
          id: `manual_${Date.now()}_${chat.id}`,
          body: message,
          contactId: chat.id,
          contactName: chat.name,
          fromMe: true,
          timestamp: Math.floor(Date.now() / 1000),
          type: 'chat',
          chatIsGroup: false,
        });
      } catch (err) {
        console.log(`Failed to send: ${err.message}`);
      }
    }
    return;
  }

  // /send <phone> <message>
  const sendMatch = input.match(/^\/send\s+(\d+)\s+(.+)/s);
  if (sendMatch) {
    const phone = sendMatch[1];
    const message = sendMatch[2];
    const chatId = `${phone}@c.us`;
    try {
      await client.sendMessage(chatId, message);
      console.log(`Sent to ${phone}: ${message}`);
      await vectordb.storeMessage({
        id: `manual_${Date.now()}_${chatId}`,
        body: message,
        contactId: chatId,
        contactName: phone,
        fromMe: true,
        timestamp: Math.floor(Date.now() / 1000),
        type: 'chat',
        chatIsGroup: false,
      });
    } catch (err) {
      console.log(`Failed to send: ${err.message}`);
    }
    return;
  }

  console.log('Unknown command. Type /help for available commands.');
}

// --- Import Handler ---
async function handleImport(client, rl) {
  console.log('\nFetching chat list...');
  const chats = await importer.listChats(client);

  if (chats.length === 0) {
    console.log('No chats found.');
    return;
  }

  console.log(`\nFound ${chats.length} chats:\n`);
  for (const c of chats) {
    const type = c.isGroup ? '[Group]' : '[1-on-1]';
    console.log(`  ${c.index}. ${type} ${c.name}`);
  }

  console.log('\nSelect chats to import:');
  console.log('  Examples: "1,3,5" or "1-10" or "all" or "all !3 !7"');

  const answer = await question(rl, 'Import selection: ');
  const selected = importer.parseSelection(answer, chats.length);

  if (selected.length === 0) {
    console.log('No chats selected.');
    return;
  }

  const selectedChats = selected.map(i => chats[i - 1]);
  console.log(`\nImporting ${selectedChats.length} chats...\n`);

  const total = await importer.importChats(client, selectedChats, (update) => {
    if (update.phase === 'chat') {
      process.stdout.write(`[${update.chatIndex}/${update.chatTotal}] Importing "${update.chatName}"...`);
    } else if (update.status === 'progress') {
      process.stdout.write(`\r[${update.chatName}] ${update.current}/${update.total} messages  `);
    } else if (update.status === 'skip') {
      console.log(` skipped (${update.reason})`);
    } else if (update.error) {
      console.log(` error: ${update.error}`);
    }
  });

  console.log(`\n\nImport complete! Stored ${total} messages in vector DB.`);
  console.log('Tip: Run /style <name> to build a style profile for a contact.\n');
}

// --- Auto-Reply Handler ---
async function handleAutoReply(subcommand, client) {
  const parts = subcommand.trim().split(/\s+/);
  const action = parts[0];

  if (action === 'list') {
    const contacts = config.get('autoReplyContacts') || [];
    if (contacts.length === 0) {
      console.log('\nNo auto-reply contacts configured.');
    } else {
      console.log('\nAuto-reply enabled for:');
      for (const c of contacts) {
        console.log(`  - ${c.name} (${c.id})`);
      }
    }
    console.log('');
    return;
  }

  if (action === 'add' && parts.length > 1) {
    const name = parts.slice(1).join(' ');
    const contact = await findContactByName(name, client);
    if (contact) {
      config.addAutoReplyContact(contact.id, contact.name);
      console.log(`Auto-reply enabled for ${contact.name}`);
    }
    return;
  }

  if (action === 'remove' && parts.length > 1) {
    const name = parts.slice(1).join(' ');
    const contacts = config.get('autoReplyContacts') || [];
    const match = contacts.find(c => c.name.toLowerCase().includes(name.toLowerCase()));
    if (match) {
      config.removeAutoReplyContact(match.id);
      console.log(`Auto-reply disabled for ${match.name}`);
    } else {
      console.log(`No auto-reply contact matching "${name}" found.`);
    }
    return;
  }

  console.log('Usage: /autoreply add <name> | /autoreply remove <name> | /autoreply list');
}

// --- Ask (Preview) Handler ---
async function handleAsk(name, message, client) {
  const contact = await findContactByName(name, client);
  if (!contact) return;

  console.log(`\nGenerating reply as ${config.get('userName')} to ${contact.name}...`);
  try {
    const reply = await agent.previewReply(contact.id, contact.name, message);
    console.log(`\n[Preview] Would reply: "${reply}"\n`);
  } catch (err) {
    console.log(`Error generating reply: ${err.message}`);
  }
}

// --- Style Handler ---
async function handleStyle(name, client) {
  const contact = await findContactByName(name, client);
  if (!contact) return;

  const existingDoc = styleProfiler.loadDocument(contact.id);
  const meta = styleProfiler.loadMeta(contact.id);

  if (existingDoc) {
    console.log(`\n--- Existing relationship document for ${contact.name} ---`);
    console.log(existingDoc);
    console.log(`\n--- Built: ${meta?.builtAt} | Messages: ${meta?.totalMessages} | Since update: ${meta?.messagesSinceLastUpdate || 0} ---`);
    console.log('Rebuilding...\n');
  } else {
    console.log(`\nBuilding relationship document for ${contact.name}...`);
    console.log('This analyzes your entire chat history in chunks. May take a minute.\n');
  }

  try {
    const result = await styleProfiler.buildDocument(contact.id, contact.name, (progress) => {
      if (progress.phase === 'analyzing') {
        console.log(`Splitting into ${progress.totalChunks} chunks for analysis...`);
      } else if (progress.phase === 'chunk') {
        process.stdout.write(`\rAnalyzing chunk ${progress.current}/${progress.total}...`);
      } else if (progress.phase === 'merging') {
        console.log('\nMerging analyses into relationship document...');
      }
    });

    if (result.error) {
      console.log(`Error: ${result.error}`);
    } else {
      console.log(`\n--- Relationship document for ${contact.name} ---`);
      console.log(result.document);
      console.log(`\n--- Done! ${result.meta.totalMessages} messages analyzed ---`);
    }
  } catch (err) {
    console.log(`Failed to build document: ${err.message}`);
  }
  console.log('');
}

// --- Schedule Handler ---
async function handleSchedule(subcommand, client) {
  const parts = subcommand.trim();

  if (parts === 'list') {
    const jobs = scheduler.listJobs();
    if (jobs.length === 0) {
      console.log('\nNo scheduled messages.');
    } else {
      console.log('\nScheduled messages:');
      for (const j of jobs) {
        console.log(`  #${j.id} - ${j.contactName} at ${new Date(j.sendAt).toLocaleString()}`);
        console.log(`    ${j.generateWithAI ? '[AI]' : '[Literal]'} "${j.instruction}"`);
      }
    }
    console.log('');
    return;
  }

  const cancelMatch = parts.match(/^cancel\s+(\d+)/);
  if (cancelMatch) {
    const id = parseInt(cancelMatch[1]);
    if (scheduler.cancelJob(id)) {
      console.log(`Cancelled scheduled message #${id}`);
    } else {
      console.log(`No scheduled message #${id} found.`);
    }
    return;
  }

  // /schedule <name> <datetime> <instruction>
  // Parse: first word is contact name, then datetime, then rest is instruction
  const scheduleMatch = parts.match(/^(\S+)\s+([\d\-]+\s+[\d:]+)\s+(.+)/s);
  if (scheduleMatch) {
    const name = scheduleMatch[1];
    const dateStr = scheduleMatch[2];
    const instruction = scheduleMatch[3];

    const contact = await findContactByName(name, client);
    if (!contact) return;

    const sendAt = new Date(dateStr);
    if (isNaN(sendAt.getTime())) {
      console.log('Invalid date format. Use: YYYY-MM-DD HH:MM');
      return;
    }

    if (sendAt.getTime() <= Date.now()) {
      console.log('Scheduled time must be in the future.');
      return;
    }

    const id = scheduler.scheduleMessage(contact.id, contact.name, sendAt, instruction);
    if (id) {
      console.log(`Scheduled message #${id} for ${contact.name} at ${sendAt.toLocaleString()}`);
      console.log(`  Instruction: "${instruction}" (will be AI-generated at send time)`);
    } else {
      console.log('Failed to schedule message.');
    }
    return;
  }

  console.log('Usage:');
  console.log('  /schedule <name> <YYYY-MM-DD HH:MM> <instruction>');
  console.log('  /schedule list');
  console.log('  /schedule cancel <id>');
}

// --- Config Handler ---
function handleConfig(key, value) {
  const validKeys = ['llmProvider', 'openaiModel', 'ollamaModel', 'ollamaHost', 'userName'];

  // Shorthand: "llm" maps to "llmProvider"
  if (key === 'llm') key = 'llmProvider';

  if (!validKeys.includes(key)) {
    console.log(`Invalid config key. Valid keys: ${validKeys.join(', ')}`);
    return;
  }

  config.set(key, value);
  console.log(`Config updated: ${key} = ${value}`);
}

// --- Exclude Handler ---
function handleExclude(name) {
  const excluded = config.get('excludedChats') || [];
  // For simplicity, store by name pattern - will be matched during import
  excluded.push(name.toLowerCase());
  config.set('excludedChats', excluded);
  console.log(`Excluded "${name}" from future imports.`);
}

// --- Helper: Find Contact ---
async function findContactByName(name, client) {
  // First check recent chats
  for (const [, chat] of recentChats) {
    if (chat.name.toLowerCase().includes(name.toLowerCase())) {
      return chat;
    }
  }

  // Check auto-reply list
  const autoContacts = config.get('autoReplyContacts') || [];
  const autoMatch = autoContacts.find(c => c.name.toLowerCase().includes(name.toLowerCase()));
  if (autoMatch) {
    return autoMatch;
  }

  // Search WhatsApp contacts
  try {
    const chats = await client.getChats();
    const match = chats.find(c => c.name && c.name.toLowerCase().includes(name.toLowerCase()));
    if (match) {
      return { id: match.id._serialized, name: match.name };
    }
  } catch {
    // Fall through
  }

  console.log(`Contact "${name}" not found. Try using /chats first.`);
  return null;
}

// --- Helper: Question prompt ---
function question(rl, prompt) {
  return new Promise(resolve => {
    rl.question(prompt, resolve);
  });
}

module.exports = {
  handleCommand,
  trackChat,
  getRecentChat,
  printHelp,
  recentChats,
};
