const Sidebar = {
  connectionState: 'disconnected',
  contacts: [],
  filteredContacts: [],
  searchQuery: '',

  render() {
    const sidebar = document.getElementById('sidebar');
    sidebar.innerHTML = `
      <div class="sidebar-header">
        <h1>WhatsApp AI</h1>
        <div class="connection-status">
          <span class="status-dot ${this.connectionState === 'connected' ? 'connected' : ''}" id="status-dot"></span>
          <span id="status-text">${this.connectionState === 'connected' ? 'Connected' : 'Disconnected'}</span>
        </div>
      </div>
      <nav class="sidebar-nav">
        <a class="nav-item" href="#chats" data-page="chats">
          <span class="nav-icon">&#9993;</span> Chats
        </a>
        <a class="nav-item" href="#import" data-page="import">
          <span class="nav-icon">&#8615;</span> Import
        </a>
        <a class="nav-item" href="#autoreply" data-page="autoreply">
          <span class="nav-icon">&#9889;</span> Auto-Reply
        </a>
        <a class="nav-item" href="#profiles" data-page="profiles">
          <span class="nav-icon">&#9998;</span> Profiles
        </a>
        <a class="nav-item" href="#scheduler" data-page="scheduler">
          <span class="nav-icon">&#9200;</span> Scheduler
        </a>
        <div class="nav-divider"></div>
        <a class="nav-item" href="#settings" data-page="settings">
          <span class="nav-icon">&#9881;</span> Settings
        </a>
      </nav>
      <div class="sidebar-contacts" id="sidebar-contacts">
        <div style="padding: 8px 8px 4px;">
          <input type="text" id="contact-search" placeholder="Search contacts..." style="padding: 6px 10px; font-size: 12px;">
        </div>
        <div id="contact-list"></div>
      </div>
    `;

    this.updateActiveNav();
    this.renderContacts();

    document.getElementById('contact-search').addEventListener('input', (e) => {
      this.searchQuery = e.target.value.toLowerCase();
      this.renderContacts();
    });
  },

  updateActiveNav() {
    const page = location.hash.slice(1).split('/')[0] || 'chats';
    document.querySelectorAll('.nav-item').forEach(el => {
      el.classList.toggle('active', el.dataset.page === page);
    });
  },

  renderContacts() {
    const container = document.getElementById('contact-list');
    if (!container) return;

    let list = this.contacts;
    if (this.searchQuery) {
      list = list.filter(c => (c.name || c.id).toLowerCase().includes(this.searchQuery));
    }

    if (list.length === 0) {
      container.innerHTML = `<div style="padding: 12px; font-size: 12px; color: var(--text-muted);">${this.contacts.length === 0 ? 'No chats loaded' : 'No matches'}</div>`;
      return;
    }

    let html = '';
    for (const c of list) {
      const initial = (c.name || '?')[0].toUpperCase();
      html += `
        <div class="contact-item" data-contact-id="${c.id}" data-contact-name="${c.name || ''}">
          <div class="contact-avatar">${initial}</div>
          <span class="contact-name">${c.name || c.id}</span>
        </div>
      `;
    }
    container.innerHTML = html;

    container.querySelectorAll('.contact-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.contactId;
        location.hash = `chats/${encodeURIComponent(id)}`;
      });
    });
  },

  setConnectionState(state) {
    this.connectionState = state;
    const dot = document.getElementById('status-dot');
    const text = document.getElementById('status-text');
    if (dot) dot.className = 'status-dot' + (state === 'connected' ? ' connected' : '');
    if (text) text.textContent = state === 'connected' ? 'Connected' : 'Disconnected';
  },

  async loadContacts() {
    try {
      const chats = await api.getChats();
      this.contacts = chats;
      this.renderContacts();
    } catch (err) {
      // Silently fail — contacts load when WhatsApp is ready
    }
  },
};
