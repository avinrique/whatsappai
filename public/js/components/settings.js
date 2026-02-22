const SettingsPage = {
  config: {},
  stats: null,

  render() {
    const main = document.getElementById('main');
    main.innerHTML = `
      <div class="page">
        <div class="page-header">
          <h2>Settings & Stats</h2>
          <p>Configure the AI agent and view system statistics.</p>
        </div>
        <div id="stats-section"></div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">API Keys</span>
          </div>
          <div id="api-keys-form"><div class="empty-state"><span class="spinner"></span> Loading...</div></div>
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">Configuration</span>
          </div>
          <div id="config-form"><div class="empty-state"><span class="spinner"></span> Loading...</div></div>
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">Top Contacts</span>
          </div>
          <div id="top-contacts"><div class="empty-state"><span class="spinner"></span> Loading...</div></div>
        </div>
      </div>
    `;

    this.loadData();
  },

  async loadData() {
    try {
      const [config, stats] = await Promise.all([
        api.getConfig(),
        api.getStats().catch(() => ({ totalMessages: 0, contacts: [] })),
      ]);
      this.config = config;
      this.stats = stats;
      this.renderStats();
      this.renderApiKeys();
      this.renderConfig();
      this.renderTopContacts();
    } catch (err) {
      document.getElementById('config-form').innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
    }
  },

  renderStats() {
    const container = document.getElementById('stats-section');
    if (!this.stats) return;

    container.innerHTML = `
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">${this.stats.totalMessages.toLocaleString()}</div>
          <div class="stat-label">Total Messages</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${this.stats.contacts.length}</div>
          <div class="stat-label">Contacts</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${(this.config.autoReplyContacts || []).length}</div>
          <div class="stat-label">Auto-Replies</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">${this.config.llmProvider || 'openai'}</div>
          <div class="stat-label">LLM Provider</div>
        </div>
      </div>
    `;
  },

  renderApiKeys() {
    const container = document.getElementById('api-keys-form');
    const keyStatus = this.config._keyStatus || {};

    container.innerHTML = `
      <div class="form-group">
        <label>OpenAI API Key</label>
        <div style="display: flex; gap: 8px; align-items: center;">
          <input type="password" id="api-key-openai" placeholder="${keyStatus.openaiApiKey ? 'Key is set (' + (this.config.openaiApiKey || '****') + ')' : 'Enter your OpenAI API key...'}" style="flex: 1;">
          <button class="btn btn-sm btn-outline" id="btn-toggle-key" type="button">Show</button>
        </div>
        <div style="margin-top: 6px;">
          ${keyStatus.openaiApiKey
            ? '<span class="badge badge-green">Connected</span>'
            : '<span class="badge badge-red">Not set</span>'}
          <span style="font-size: 12px; color: var(--text-muted); margin-left: 8px;">Required for OpenAI provider</span>
        </div>
      </div>
      <button class="btn btn-primary" id="btn-save-keys">Save API Keys</button>
    `;

    document.getElementById('btn-toggle-key').addEventListener('click', () => {
      const input = document.getElementById('api-key-openai');
      const btn = document.getElementById('btn-toggle-key');
      if (input.type === 'password') {
        input.type = 'text';
        btn.textContent = 'Hide';
      } else {
        input.type = 'password';
        btn.textContent = 'Show';
      }
    });

    document.getElementById('btn-save-keys').addEventListener('click', () => this.saveApiKeys());
  },

  renderConfig() {
    const container = document.getElementById('config-form');
    const fields = [
      { key: 'userName', label: 'Your Name', type: 'text' },
      { key: 'llmProvider', label: 'LLM Provider', type: 'select', options: ['openai', 'ollama'] },
      { key: 'openaiModel', label: 'OpenAI Model', type: 'text' },
      { key: 'ollamaModel', label: 'Ollama Model', type: 'text' },
      { key: 'ollamaHost', label: 'Ollama Host', type: 'text' },
    ];

    container.innerHTML = fields.map(f => {
      if (f.type === 'select') {
        return `<div class="form-group">
          <label>${f.label}</label>
          <select data-key="${f.key}">${f.options.map(o => `<option value="${o}" ${this.config[f.key] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>
        </div>`;
      }
      return `<div class="form-group">
        <label>${f.label}</label>
        <input type="text" data-key="${f.key}" value="${this.config[f.key] || ''}">
      </div>`;
    }).join('') + '<button class="btn btn-primary" id="btn-save-config">Save Changes</button>';

    document.getElementById('btn-save-config').addEventListener('click', () => this.saveConfig());
  },

  renderTopContacts() {
    const container = document.getElementById('top-contacts');
    if (!this.stats || this.stats.contacts.length === 0) {
      container.innerHTML = '<div class="empty-state">No message data yet</div>';
      return;
    }

    container.innerHTML = `<table class="table">
      <thead><tr><th>Contact</th><th>Messages</th></tr></thead>
      <tbody>${this.stats.contacts.slice(0, 15).map(c => `
        <tr><td>${c.name || c.id}</td><td>${c.messageCount.toLocaleString()}</td></tr>
      `).join('')}</tbody>
    </table>`;
  },

  async saveApiKeys() {
    const btn = document.getElementById('btn-save-keys');
    const input = document.getElementById('api-key-openai');
    const key = input.value.trim();

    if (!key) {
      App.toast('Enter an API key');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
      await api.updateConfig('openaiApiKey', key);
      input.value = '';
      App.toast('API key saved');
      // Reload to update status badges
      this.loadData();
    } catch (err) {
      App.toast('Error: ' + err.message);
    }

    btn.disabled = false;
    btn.textContent = 'Save API Keys';
  },

  async saveConfig() {
    const inputs = document.querySelectorAll('#config-form [data-key]');
    const btn = document.getElementById('btn-save-config');
    btn.disabled = true;
    btn.textContent = 'Saving...';

    try {
      for (const input of inputs) {
        const key = input.dataset.key;
        const value = input.value;
        if (value !== (this.config[key] || '')) {
          await api.updateConfig(key, value);
        }
      }
      App.toast('Settings saved');
    } catch (err) {
      App.toast('Error: ' + err.message);
    }

    btn.disabled = false;
    btn.textContent = 'Save Changes';
  },
};
