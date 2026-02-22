const ProfilesPage = {
  profiles: [],
  allChats: [],
  contactSearchQuery: '',

  render() {
    const main = document.getElementById('main');
    main.innerHTML = `
      <div class="page">
        <div class="page-header">
          <h2>Style Profiles</h2>
          <p>Relationship documents that teach the AI how you text each person.</p>
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">Build New Profile</span>
          </div>
          <div style="margin-bottom: 10px;">
            <input type="text" id="profile-contact-search" placeholder="Search contacts..." style="margin-bottom: 8px;">
          </div>
          <div id="profile-contact-list" style="max-height: 250px; overflow-y: auto; margin-bottom: 12px;"></div>
          <div id="profile-selected" style="display: none; margin-bottom: 12px;">
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 10px;">
              <span style="font-size: 13px; color: var(--text-secondary);">Selected:</span>
              <span id="profile-selected-name" style="font-weight: 600;"></span>
              <button class="btn btn-outline btn-sm" id="btn-clear-selection">Clear</button>
            </div>
            <div style="margin-bottom: 10px;">
              <label style="font-size: 12px; color: var(--text-muted); display: block; margin-bottom: 4px;">Who is this person to you? (optional but recommended)</label>
              <textarea id="profile-relationship-context" rows="3" placeholder="e.g. Close friend from college. We share memes, talk about tech, and roast each other. He's sarcastic and I match his energy." style="width: 100%; resize: vertical;"></textarea>
              <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">This helps the AI understand the relationship dynamic, not just how you type.</div>
            </div>
            <button class="btn btn-primary" id="btn-build-profile">Build Profile</button>
          </div>
          <div id="profile-build-progress" style="display:none; margin-top: 12px;"></div>
        </div>
        <div id="profiles-list"><div class="empty-state"><span class="spinner"></span> Loading profiles...</div></div>
      </div>
    `;

    this.selectedContactId = null;
    this.selectedContactName = null;
    this.loadData();

    document.getElementById('profile-contact-search').addEventListener('input', (e) => {
      this.contactSearchQuery = e.target.value.toLowerCase();
      this.renderContactList();
    });
  },

  async loadData() {
    try {
      const [profiles, chats] = await Promise.all([
        api.getProfiles(),
        api.getChats().catch(() => []),
      ]);
      this.profiles = profiles;
      this.allChats = chats;
      this.renderContactList();
      this.renderProfiles();
    } catch (err) {
      document.getElementById('profiles-list').innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
    }
  },

  renderContactList() {
    const container = document.getElementById('profile-contact-list');
    if (!container) return;

    let contacts = this.allChats.filter(c => !c.isGroup);

    if (this.contactSearchQuery) {
      contacts = contacts.filter(c => (c.name || c.id).toLowerCase().includes(this.contactSearchQuery));
    }

    if (contacts.length === 0) {
      container.innerHTML = `<div style="padding: 12px; font-size: 12px; color: var(--text-muted);">${this.contactSearchQuery ? 'No matches' : 'No contacts available'}</div>`;
      return;
    }

    // Check which contacts already have profiles
    const profileIds = new Set(this.profiles.map(p => p.contactId));

    container.innerHTML = contacts.map(c => {
      const hasProfile = profileIds.has(c.id);
      return `<div class="contact-item profile-pick" data-id="${c.id}" data-name="${c.name || ''}" style="padding: 6px 10px;">
        <div class="contact-avatar" style="width: 24px; height: 24px; font-size: 11px;">${(c.name || '?')[0].toUpperCase()}</div>
        <span class="contact-name">${c.name || c.id}</span>
        ${hasProfile ? '<span class="badge badge-green" style="margin-left: auto;">Has profile</span>' : ''}
      </div>`;
    }).join('');

    container.querySelectorAll('.profile-pick').forEach(el => {
      el.addEventListener('click', () => {
        this.selectContact(el.dataset.id, el.dataset.name);
      });
    });
  },

  selectContact(id, name) {
    this.selectedContactId = id;
    this.selectedContactName = name || id;
    document.getElementById('profile-selected').style.display = 'block';
    document.getElementById('profile-selected-name').textContent = this.selectedContactName;

    document.getElementById('btn-build-profile').addEventListener('click', () => this.buildProfile());
    document.getElementById('btn-clear-selection').addEventListener('click', () => {
      this.selectedContactId = null;
      this.selectedContactName = null;
      document.getElementById('profile-selected').style.display = 'none';
    });
  },

  renderProfiles() {
    const container = document.getElementById('profiles-list');
    if (this.profiles.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">&#9998;</div>No profiles built yet. Search and select a contact above to build one.</div>';
      return;
    }

    container.innerHTML = this.profiles.map(p => {
      const badges = [];
      badges.push(`<span class="badge badge-blue">${p.totalMessages} msgs</span>`);
      if (p.hasTopicAnalysis) badges.push('<span class="badge badge-green">Topics</span>');
      if (p.hasTimingStats) badges.push('<span class="badge badge-green">Timing</span>');
      if (p.hasImageContext) badges.push('<span class="badge badge-green">Images</span>');
      if (p.hasRelationshipContext) badges.push('<span class="badge badge-green">Relationship</span>');
      if (p.source === 'upload') badges.push('<span class="badge badge-yellow">Uploaded</span>');

      return `
      <div class="card" id="profile-card-${CSS.escape(p.contactId)}">
        <div class="card-header">
          <span class="card-title">${p.contactName || p.contactId}</span>
          <div style="display: flex; align-items: center; gap: 8px;">
            ${badges.join('')}
            <span style="font-size: 12px; color: var(--text-muted);">${this.timeAgo(p.builtAt)}</span>
            <button class="btn btn-outline btn-sm btn-view-profile" data-id="${p.contactId}" data-name="${p.contactName}">View</button>
            <button class="btn btn-outline btn-sm btn-rebuild-profile" data-id="${p.contactId}" data-name="${p.contactName}">Rebuild</button>
            <button class="btn btn-danger btn-sm btn-delete-profile" data-id="${p.contactId}" data-name="${p.contactName}">Delete</button>
          </div>
        </div>
        ${p.messagesSinceLastUpdate > 0 ? `<div style="font-size: 12px; color: var(--yellow);">${p.messagesSinceLastUpdate} new messages since last update</div>` : ''}
      </div>
    `}).join('');

    container.querySelectorAll('.btn-view-profile').forEach(btn => {
      btn.addEventListener('click', () => this.viewProfile(btn.dataset.id, btn.dataset.name));
    });

    container.querySelectorAll('.btn-rebuild-profile').forEach(btn => {
      btn.addEventListener('click', () => this.rebuildProfile(btn.dataset.id, btn.dataset.name));
    });

    container.querySelectorAll('.btn-delete-profile').forEach(btn => {
      btn.addEventListener('click', () => this.deleteProfile(btn.dataset.id, btn.dataset.name));
    });
  },

  async viewProfile(contactId, contactName) {
    try {
      const { document: doc } = await api.getProfile(contactId);
      const main = document.getElementById('main');
      main.innerHTML = `
        <div class="page">
          <div class="page-header" style="display: flex; align-items: center; gap: 12px;">
            <button class="btn btn-outline btn-sm" id="btn-back-profiles">&larr; Back</button>
            <div>
              <h2>${contactName}</h2>
              <p>Relationship document</p>
            </div>
          </div>
          <div class="profile-doc">${this.escapeHtml(doc || 'No document content')}</div>
        </div>
      `;
      document.getElementById('btn-back-profiles').addEventListener('click', () => this.render());
    } catch (err) {
      App.toast('Error: ' + err.message);
    }
  },

  async buildProfile() {
    if (!this.selectedContactId) return;

    const btn = document.getElementById('btn-build-profile');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Building...';
    document.getElementById('profile-build-progress').style.display = 'block';

    const relationshipContext = (document.getElementById('profile-relationship-context')?.value || '').trim();

    try {
      await api.buildProfile(this.selectedContactId, this.selectedContactName, relationshipContext || undefined);
    } catch (err) {
      App.toast('Build failed: ' + err.message);
      btn.disabled = false;
      btn.textContent = 'Build Profile';
    }
  },

  async rebuildProfile(contactId, contactName) {
    try {
      App.toast('Rebuilding profile for ' + contactName + '...');
      await api.buildProfile(contactId, contactName);
    } catch (err) {
      App.toast('Rebuild failed: ' + err.message);
    }
  },

  async deleteProfile(contactId, contactName) {
    if (!confirm(`Delete profile for ${contactName}? You can rebuild it later.`)) return;

    try {
      await api.deleteProfile(contactId);
      App.toast('Profile deleted');
      this.loadData();
    } catch (err) {
      App.toast('Error: ' + err.message);
    }
  },

  onProgress(data) {
    const container = document.getElementById('profile-build-progress');
    if (!container) return;

    if (data.phase === 'topics') {
      container.innerHTML = `<div class="progress-text"><span class="spinner"></span> ${data.message}</div>`;
    } else if (data.phase === 'pass1' || data.phase === 'pass2') {
      container.innerHTML = `<div class="progress-text"><span class="spinner"></span> ${data.message}</div>`;
    } else if (data.phase === 'chunk') {
      const pct = Math.round((data.step / data.total) * 100);
      const passLabel = data.pass === 1 ? 'Pass 1 — Pattern extraction' : 'Pass 2 — Deep refinement';
      container.innerHTML = `
        <div style="font-size: 12px; color: var(--accent); margin-bottom: 6px; font-weight: 500;">${passLabel}</div>
        <div class="progress-bar"><div class="progress-fill" style="width: ${pct}%"></div></div>
        <div class="progress-text">${data.message} (${pct}% overall)</div>
      `;
    } else if (data.phase === 'merging') {
      const pct = Math.round((data.step / data.total) * 100);
      const passLabel = data.pass === 1 ? 'Pass 1' : 'Pass 2';
      container.innerHTML = `
        <div style="font-size: 12px; color: var(--accent); margin-bottom: 6px; font-weight: 500;">${passLabel} — Merging</div>
        <div class="progress-bar"><div class="progress-fill" style="width: ${pct}%"></div></div>
        <div class="progress-text"><span class="spinner"></span> ${data.message} (${pct}% overall)</div>
      `;
    }
  },

  onDone(data) {
    const btn = document.getElementById('btn-build-profile');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Build Profile';
    }

    const container = document.getElementById('profile-build-progress');
    if (container) {
      if (data.error) {
        container.innerHTML = `<div style="color: var(--red);">Error: ${data.error}</div>`;
      } else {
        container.innerHTML = `<div style="color: var(--green); font-weight: 500;">Profile built successfully!</div>`;
        setTimeout(() => this.loadData(), 1000);
      }
    }
  },

  timeAgo(isoStr) {
    if (!isoStr) return '';
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};
