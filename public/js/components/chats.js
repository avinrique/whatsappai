const ChatsPage = {
  currentContactId: null,
  currentContactName: null,
  messages: [],

  render(contactId) {
    const main = document.getElementById('main');

    if (!contactId) {
      main.innerHTML = `
        <div class="chat-container">
          <div class="chat-select-prompt">
            Select a chat from the sidebar to view messages
          </div>
        </div>
      `;
      return;
    }

    this.currentContactId = decodeURIComponent(contactId);
    // Find name from sidebar contacts
    const contact = Sidebar.contacts.find(c => c.id === this.currentContactId);
    this.currentContactName = contact ? contact.name : this.currentContactId;

    main.innerHTML = `
      <div class="chat-container">
        <div class="chat-header-bar">
          <div class="contact-avatar">${(this.currentContactName || '?')[0].toUpperCase()}</div>
          <div>
            <h3>${this.currentContactName}</h3>
            <div class="live-indicator"><span class="live-dot"></span> Live</div>
          </div>
          <div style="margin-left: auto; display: flex; gap: 8px;">
            <button class="btn btn-outline btn-sm" id="btn-preview-ai">Preview AI Reply</button>
          </div>
        </div>
        <div class="chat-messages" id="chat-messages"></div>
        <div class="chat-input-area">
          <input type="text" id="chat-input" placeholder="Type a message..." autocomplete="off">
          <button class="btn btn-primary" id="btn-send">Send</button>
        </div>
      </div>
    `;

    this.loadMessages();
    this.bindEvents();
  },

  async loadMessages() {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    try {
      this.messages = await api.getMessages(this.currentContactId, 100);
      this.renderMessages();
    } catch (err) {
      container.innerHTML = `<div class="empty-state">Failed to load messages: ${err.message}</div>`;
    }
  },

  renderMessages() {
    const container = document.getElementById('chat-messages');
    if (!container) return;

    if (this.messages.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">&#128172;</div>No messages yet. Import chat history first.</div>';
      return;
    }

    container.innerHTML = this.messages.map(m => {
      const cls = m.fromMe ? 'outgoing' : 'incoming';
      const time = new Date(m.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `<div class="msg ${cls}"><div>${this.escapeHtml(m.body)}</div><div class="msg-time">${time}</div></div>`;
    }).join('');

    container.scrollTop = container.scrollHeight;
  },

  bindEvents() {
    const input = document.getElementById('chat-input');
    const btnSend = document.getElementById('btn-send');
    const btnPreview = document.getElementById('btn-preview-ai');

    if (btnSend) {
      btnSend.addEventListener('click', () => this.sendMessage());
    }

    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') this.sendMessage();
      });
    }

    if (btnPreview) {
      btnPreview.addEventListener('click', () => this.previewAI());
    }
  },

  async sendMessage() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    input.disabled = true;
    document.getElementById('btn-send').disabled = true;

    try {
      await api.sendMessage(this.currentContactId, text, this.currentContactName);
      // Add to local messages
      this.messages.push({
        body: text,
        fromMe: true,
        timestamp: Math.floor(Date.now() / 1000),
      });
      this.renderMessages();
    } catch (err) {
      App.toast('Send failed: ' + err.message);
    }

    input.disabled = false;
    document.getElementById('btn-send').disabled = false;
    input.focus();
  },

  async previewAI() {
    const input = document.getElementById('chat-input');
    const btn = document.getElementById('btn-preview-ai');
    const lastIncoming = [...this.messages].reverse().find(m => !m.fromMe);

    if (!lastIncoming) {
      App.toast('No incoming message to reply to');
      return;
    }

    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Generating...';

    try {
      const { reply } = await api.previewReply(this.currentContactId, this.currentContactName, lastIncoming.body);
      input.value = reply;
      input.focus();
    } catch (err) {
      App.toast('Preview failed: ' + err.message);
    }

    btn.disabled = false;
    btn.textContent = 'Preview AI Reply';
  },

  addRealtimeMessage(data, fromMe) {
    if (!this.currentContactId) return;
    const matchId = fromMe ? data.to : data.from;
    if (matchId !== this.currentContactId) return;

    this.messages.push({
      body: data.body,
      fromMe,
      timestamp: data.timestamp || Math.floor(Date.now() / 1000),
    });
    this.renderMessages();
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};
