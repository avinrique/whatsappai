const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  llmProvider: 'openai',
  openaiModel: 'gpt-4o',
  ollamaModel: 'llama3',
  ollamaHost: 'http://localhost:11434',
  autoReplyContacts: [],
  excludedChats: [],
  importState: {},
  scheduledMessages: [],
  userName: 'Avin',
  triggerWord: 'alex',
};

let _config = null;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const stylesDir = path.join(DATA_DIR, 'style-profiles');
  if (!fs.existsSync(stylesDir)) {
    fs.mkdirSync(stylesDir, { recursive: true });
  }
}

function load() {
  ensureDataDir();
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
      _config = { ...DEFAULTS, ...JSON.parse(raw) };
    } catch {
      _config = { ...DEFAULTS };
    }
  } else {
    _config = { ...DEFAULTS };
  }
  return _config;
}

function save() {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(_config, null, 2));
}

function get(key) {
  if (!_config) load();
  return _config[key];
}

function set(key, value) {
  if (!_config) load();
  _config[key] = value;
  save();
}

function getAll() {
  if (!_config) load();
  return { ..._config };
}

function addAutoReplyContact(contactId, contactName) {
  if (!_config) load();
  const existing = _config.autoReplyContacts.find(c => c.id === contactId);
  if (!existing) {
    _config.autoReplyContacts.push({ id: contactId, name: contactName });
    save();
  }
}

function removeAutoReplyContact(contactId) {
  if (!_config) load();
  _config.autoReplyContacts = _config.autoReplyContacts.filter(c => c.id !== contactId);
  save();
}

function isAutoReplyEnabled(contactId) {
  if (!_config) load();
  return _config.autoReplyContacts.some(c => c.id === contactId);
}

function updateImportState(chatId, timestamp) {
  if (!_config) load();
  _config.importState[chatId] = timestamp;
  save();
}

module.exports = {
  load,
  save,
  get,
  set,
  getAll,
  addAutoReplyContact,
  removeAutoReplyContact,
  isAutoReplyEnabled,
  updateImportState,
  DATA_DIR,
  DEFAULTS,
};
