const schedule = require('node-schedule');
const config = require('../config/config');
const agent = require('../agent/agent');

const activeJobs = new Map();
let jobCounter = 0;

function init() {
  // Restore persisted scheduled messages
  const saved = config.get('scheduledMessages') || [];
  const now = Date.now();

  for (const entry of saved) {
    // Update jobCounter to avoid ID collisions
    if (entry.id && entry.id >= jobCounter) {
      jobCounter = entry.id;
    }
    const sendTime = new Date(entry.sendAt);
    if (sendTime.getTime() > now) {
      scheduleJob(entry, false); // Don't re-persist
    }
  }

  if (saved.length > 0) {
    // Clean up expired entries
    const active = saved.filter(e => new Date(e.sendAt).getTime() > now);
    config.set('scheduledMessages', active);
  }
}

function scheduleJob(entry, persist = true) {
  const id = entry.id || ++jobCounter;
  entry.id = id;

  const sendTime = new Date(entry.sendAt);
  const job = schedule.scheduleJob(sendTime, async () => {
    try {
      await executeScheduledMessage(entry);
    } catch (err) {
      console.error(`\nScheduled message #${id} failed: ${err.message}`);
    }
    activeJobs.delete(id);
    removeFromConfig(id);
  });

  if (job) {
    activeJobs.set(id, { job, entry });
    if (persist) {
      const saved = config.get('scheduledMessages') || [];
      saved.push(entry);
      config.set('scheduledMessages', saved);
    }
    return id;
  }

  return null;
}

async function executeScheduledMessage(entry) {
  const { getClient } = require('../whatsapp/client');
  const client = getClient();

  if (!client) {
    console.error(`\nScheduled message #${entry.id}: WhatsApp not connected`);
    return;
  }

  let messageBody;
  if (entry.generateWithAI && entry.instruction) {
    // Generate message from instruction in user's texting style
    messageBody = await agent.generateFromInstruction(
      entry.contactId,
      entry.contactName,
      entry.instruction
    );
  } else {
    // Send the pre-written/pre-generated message
    messageBody = entry.message || entry.instruction; // backward compat
  }

  await client.sendMessage(entry.contactId, messageBody);
  console.log(`\n[Scheduled] Sent to ${entry.contactName}: ${messageBody}`);
}

function scheduleMessage(contactId, contactName, sendAt, message, generateWithAI = false) {
  const entry = {
    contactId,
    contactName,
    sendAt: new Date(sendAt).toISOString(),
    message,
    instruction: generateWithAI ? message : null, // original instruction if AI will generate at send time
    generateWithAI,
    createdAt: new Date().toISOString(),
  };

  return scheduleJob(entry);
}

function updateJobMessage(id, newMessage) {
  const item = activeJobs.get(id);
  if (!item) return false;

  item.entry.message = newMessage;
  item.entry.instruction = newMessage; // backward compat

  // Update in persisted config too
  const saved = config.get('scheduledMessages') || [];
  const entry = saved.find(e => e.id === id);
  if (entry) {
    entry.message = newMessage;
    entry.instruction = newMessage;
    config.set('scheduledMessages', saved);
  }

  return true;
}

function cancelJob(id) {
  const entry = activeJobs.get(id);
  if (entry) {
    entry.job.cancel();
    activeJobs.delete(id);
    removeFromConfig(id);
    return true;
  }
  return false;
}

function removeFromConfig(id) {
  const saved = config.get('scheduledMessages') || [];
  config.set('scheduledMessages', saved.filter(e => e.id !== id));
}

function listJobs() {
  const jobs = [];
  for (const [id, { entry }] of activeJobs) {
    jobs.push({
      id,
      contactName: entry.contactName,
      contactId: entry.contactId,
      sendAt: entry.sendAt,
      message: entry.message || entry.instruction || '', // backward compat
      generateWithAI: entry.generateWithAI,
      createdAt: entry.createdAt,
    });
  }
  return jobs.sort((a, b) => new Date(a.sendAt) - new Date(b.sendAt));
}

module.exports = { init, scheduleMessage, cancelJob, updateJobMessage, listJobs };
