const ImportPage = {
  chats: [],
  importing: false,
  uploading: false,
  searchQuery: '',
  filter: 'all', // 'all' | 'imported' | 'not_imported'

  render() {
    const main = document.getElementById('main');
    main.innerHTML = `
      <div class="page">
        <div class="page-header">
          <h2>Import Chat History</h2>
          <p>Import messages into the vector database for AI context. Use WhatsApp's "Export Chat" zip or import from connected chats.</p>
        </div>

        <div class="card" id="upload-card">
          <div class="card-header">
            <span class="card-title">Upload Chat Export</span>
          </div>
          <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 12px;">
            Export a chat from WhatsApp (Settings > Chat > Export Chat) and upload the .zip file here.
          </p>
          <div style="display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 12px;">
            <div style="flex: 1; min-width: 200px;">
              <label style="font-size: 12px; color: var(--text-muted); display: block; margin-bottom: 4px;">Contact ID (phone@c.us or pick below)</label>
              <input type="text" id="upload-contact-id" placeholder="e.g. 9779812345678@c.us" style="width: 100%;">
            </div>
            <div style="flex: 1; min-width: 150px;">
              <label style="font-size: 12px; color: var(--text-muted); display: block; margin-bottom: 4px;">Contact Name</label>
              <input type="text" id="upload-contact-name" placeholder="e.g. John" style="width: 100%;">
            </div>
          </div>
          <div id="upload-contact-picker" style="max-height: 150px; overflow-y: auto; margin-bottom: 12px; display: none;"></div>
          <div style="display: flex; gap: 10px; align-items: center;">
            <input type="file" id="upload-file" accept=".zip" style="flex: 1;">
            <button class="btn btn-primary" id="btn-upload" disabled>Upload & Import</button>
          </div>
          <div id="upload-progress" style="display: none; margin-top: 12px;"></div>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Chats from WhatsApp</span>
            <div style="display: flex; gap: 8px;">
              <button class="btn btn-outline btn-sm" id="btn-select-all">Select All Visible</button>
              <button class="btn btn-primary" id="btn-start-import" disabled>Import Selected</button>
            </div>
          </div>

          <div style="margin-bottom: 12px;">
            <input type="text" id="import-search" placeholder="Search contacts..." style="margin-bottom: 10px;">
            <div style="display: flex; gap: 6px;" id="import-filters">
              <button class="btn btn-sm filter-btn active" data-filter="all">All</button>
              <button class="btn btn-sm filter-btn" data-filter="imported">Imported</button>
              <button class="btn btn-sm filter-btn" data-filter="not_imported">Not Imported</button>
            </div>
          </div>

          <div id="chat-list"><div class="empty-state"><span class="spinner"></span> Loading chats...</div></div>
        </div>

        <div class="card" id="import-progress-card" style="display:none;">
          <div class="card-title">Import Progress</div>
          <div id="import-progress" style="margin-top: 12px;"></div>
        </div>
      </div>
    `;

    this.loadChats();
    this.setupUploadHandlers();

    document.getElementById('btn-select-all').addEventListener('click', () => this.selectAll());
    document.getElementById('btn-start-import').addEventListener('click', () => this.startImport());
    document.getElementById('import-search').addEventListener('input', (e) => {
      this.searchQuery = e.target.value.toLowerCase();
      this.renderChats();
    });
    document.getElementById('import-filters').addEventListener('click', (e) => {
      const btn = e.target.closest('.filter-btn');
      if (!btn) return;
      this.filter = btn.dataset.filter;
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      this.renderChats();
    });
  },

  setupUploadHandlers() {
    const fileInput = document.getElementById('upload-file');
    const contactIdInput = document.getElementById('upload-contact-id');
    const contactNameInput = document.getElementById('upload-contact-name');
    const uploadBtn = document.getElementById('btn-upload');

    const updateUploadBtn = () => {
      uploadBtn.disabled = !fileInput.files.length || !contactIdInput.value.trim() || !contactNameInput.value.trim() || this.uploading;
    };

    fileInput.addEventListener('change', updateUploadBtn);
    contactIdInput.addEventListener('input', updateUploadBtn);
    contactNameInput.addEventListener('input', updateUploadBtn);

    uploadBtn.addEventListener('click', () => this.startUpload());

    // Show contact picker when chats are loaded
    this.loadContactPicker();
  },

  async loadContactPicker() {
    try {
      const chats = await api.getChats().catch(() => []);
      const contacts = chats.filter(c => !c.isGroup);
      const picker = document.getElementById('upload-contact-picker');
      if (!picker || contacts.length === 0) return;

      picker.style.display = 'block';
      picker.innerHTML = `<div style="font-size: 11px; color: var(--text-muted); margin-bottom: 4px;">Or pick an existing contact:</div>` +
        contacts.map(c => `
          <div class="contact-item upload-pick" data-id="${c.id}" data-name="${c.name || ''}" style="padding: 4px 8px; cursor: pointer; font-size: 12px;">
            <span class="contact-name">${c.name || c.id}</span>
            <span style="color: var(--text-muted); font-size: 10px; margin-left: 6px;">${c.id}</span>
          </div>
        `).join('');

      picker.querySelectorAll('.upload-pick').forEach(el => {
        el.addEventListener('click', () => {
          document.getElementById('upload-contact-id').value = el.dataset.id;
          document.getElementById('upload-contact-name').value = el.dataset.name || el.dataset.id;
          // Trigger input event for button state update
          document.getElementById('upload-contact-id').dispatchEvent(new Event('input'));
        });
      });
    } catch {
      // Silently fail — picker is optional
    }
  },

  async startUpload() {
    const file = document.getElementById('upload-file').files[0];
    const contactId = document.getElementById('upload-contact-id').value.trim();
    const contactName = document.getElementById('upload-contact-name').value.trim();

    if (!file || !contactId || !contactName) return;

    this.uploading = true;
    const btn = document.getElementById('btn-upload');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Uploading...';

    const progress = document.getElementById('upload-progress');
    progress.style.display = 'block';
    progress.innerHTML = '<div class="progress-text"><span class="spinner"></span> Uploading file...</div>';

    try {
      await api.uploadChatExport(file, contactId, contactName);
    } catch (err) {
      progress.innerHTML = `<div style="color: var(--red);">Upload failed: ${err.message}</div>`;
      this.uploading = false;
      btn.disabled = false;
      btn.textContent = 'Upload & Import';
    }
  },

  onUploadProgress(data) {
    const progress = document.getElementById('upload-progress');
    if (!progress) return;

    let html = `<div class="progress-text"><span class="spinner"></span> ${data.message}</div>`;

    if (data.current && data.total) {
      const pct = Math.round((data.current / data.total) * 100);
      html = `
        <div class="progress-bar"><div class="progress-fill" style="width: ${pct}%"></div></div>
        <div class="progress-text">${data.message} (${pct}%)</div>
      `;
    }

    progress.innerHTML = html;
  },

  onUploadDone(data) {
    this.uploading = false;
    const btn = document.getElementById('btn-upload');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Upload & Import';
    }

    const progress = document.getElementById('upload-progress');
    if (!progress) return;

    if (data.error) {
      progress.innerHTML = `<div style="color: var(--red);">Error: ${data.error}</div>`;
    } else {
      let msg = `Done! ${data.totalStored} messages imported.`;
      if (data.imageCount > 0) msg += ` ${data.imageCount} images analyzed.`;
      progress.innerHTML = `<div style="color: var(--green); font-weight: 500;">${msg}</div>`;
      setTimeout(() => this.loadChats(), 1500);
    }
  },

  async loadChats() {
    try {
      this.chats = await api.getImportChats();
      this.renderChats();
    } catch (err) {
      document.getElementById('chat-list').innerHTML = `<div class="empty-state">Failed to load: ${err.message}</div>`;
    }
  },

  getFilteredChats() {
    let list = this.chats;

    // Search filter
    if (this.searchQuery) {
      list = list.filter(c => (c.name || c.id).toLowerCase().includes(this.searchQuery));
    }

    // Tab filter
    if (this.filter === 'imported') {
      list = list.filter(c => (c.importedMessages || 0) > 0);
    } else if (this.filter === 'not_imported') {
      list = list.filter(c => (c.importedMessages || 0) === 0);
    }

    return list;
  },

  renderChats() {
    const container = document.getElementById('chat-list');
    const filtered = this.getFilteredChats();

    // Show counts in filter buttons
    const allCount = this.chats.length;
    const importedCount = this.chats.filter(c => (c.importedMessages || 0) > 0).length;
    const notCount = allCount - importedCount;
    document.querySelector('[data-filter="all"]').textContent = `All (${allCount})`;
    document.querySelector('[data-filter="imported"]').textContent = `Imported (${importedCount})`;
    document.querySelector('[data-filter="not_imported"]').textContent = `Not Imported (${notCount})`;

    if (filtered.length === 0) {
      container.innerHTML = `<div class="empty-state">${this.searchQuery ? 'No matches' : 'No chats in this category'}</div>`;
      return;
    }

    container.innerHTML = `<div class="checklist">${filtered.map(c => {
      const imported = c.importedMessages || 0;
      const hasImport = imported > 0;

      return `<div class="check-item" style="justify-content: stretch;">
        <input type="checkbox" value="${c.id}" data-name="${c.name || ''}">
        <span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${c.name || c.id}</span>
        <span style="display: flex; align-items: center; gap: 6px; flex-shrink: 0;">
          ${c.isGroup ? '<span class="badge badge-blue">Group</span>' : ''}
          ${hasImport
            ? `<span class="badge badge-green">${imported} msgs</span>`
            : '<span class="badge badge-yellow">Not imported</span>'}
          ${c.lastImport ? `<span style="font-size: 10px; color: var(--text-muted);">${c.lastImport}</span>` : ''}
          ${hasImport ? `<button class="btn btn-danger btn-sm btn-delete-import" data-id="${c.id}" data-name="${c.name || c.id}" data-count="${imported}" style="padding: 3px 8px; font-size: 11px;">Delete</button>` : ''}
        </span>
      </div>`;
    }).join('')}</div>`;

    // Checkbox change handler
    container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => this.updateButton());
    });

    // Delete buttons
    container.querySelectorAll('.btn-delete-import').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.deleteImported(btn.dataset.id, btn.dataset.name, parseInt(btn.dataset.count));
      });
    });
  },

  selectAll() {
    const checks = document.querySelectorAll('#chat-list input[type="checkbox"]');
    const allChecked = [...checks].every(c => c.checked);
    checks.forEach(c => c.checked = !allChecked);
    this.updateButton();
  },

  updateButton() {
    const checked = document.querySelectorAll('#chat-list input:checked').length;
    const btn = document.getElementById('btn-start-import');
    btn.disabled = checked === 0 || this.importing;
    btn.textContent = checked > 0 ? `Import Selected (${checked})` : 'Import Selected';
  },

  async deleteImported(contactId, contactName, count) {
    if (!confirm(`Delete ${count} imported messages for ${contactName}?\nThis resets import state so you can re-import fresh.`)) return;

    try {
      const result = await api.deleteImported(contactId);
      App.toast(`Deleted ${result.deletedMessages} messages for ${contactName}`);
      this.loadChats();
    } catch (err) {
      App.toast('Error: ' + err.message);
    }
  },

  async startImport() {
    const checked = document.querySelectorAll('#chat-list input:checked');
    const chatIds = [...checked].map(c => c.value);
    if (chatIds.length === 0) return;

    this.importing = true;
    document.getElementById('btn-start-import').disabled = true;
    document.getElementById('btn-start-import').innerHTML = '<span class="spinner"></span> Importing...';
    document.getElementById('import-progress-card').style.display = 'block';

    try {
      await api.startImport(chatIds);
    } catch (err) {
      App.toast('Import start failed: ' + err.message);
      this.importing = false;
    }
  },

  onProgress(data) {
    const container = document.getElementById('import-progress');
    if (!container) return;

    if (data.phase === 'chat') {
      container.innerHTML = `
        <div style="margin-bottom: 8px; font-weight: 500;">${data.chatName} (${data.chatIndex}/${data.chatTotal})</div>
        <div class="progress-bar"><div class="progress-fill" style="width: ${(data.chatIndex / data.chatTotal) * 100}%"></div></div>
        <div class="progress-text">Processing chat ${data.chatIndex} of ${data.chatTotal}</div>
      `;
    } else if (data.status === 'progress') {
      const pct = Math.round((data.current / data.total) * 100);
      container.innerHTML = `
        <div style="margin-bottom: 8px; font-weight: 500;">${data.chatName}</div>
        <div class="progress-bar"><div class="progress-fill" style="width: ${pct}%"></div></div>
        <div class="progress-text">${data.current} / ${data.total} messages (${pct}%)</div>
      `;
    } else if (data.status === 'skip') {
      container.innerHTML += `<div class="progress-text" style="color: var(--text-muted);">${data.chatName}: ${data.reason}</div>`;
    }
  },

  onDone(data) {
    this.importing = false;
    const btn = document.getElementById('btn-start-import');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Import Selected';
    }

    const container = document.getElementById('import-progress');
    if (!container) return;

    if (data.error) {
      container.innerHTML += `<div style="color: var(--red); margin-top: 8px;">Error: ${data.error}</div>`;
    } else {
      container.innerHTML += `<div style="color: var(--green); margin-top: 12px; font-weight: 500;">Done! ${data.totalStored} messages imported.</div>`;
      setTimeout(() => this.loadChats(), 1500);
    }
  },
};
