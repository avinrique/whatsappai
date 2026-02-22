const AutoReplyPage = {
  contacts: [],
  allChats: [],

  render() {
    const main = document.getElementById('main');
    main.innerHTML = `
      <div class="page">
        <div class="page-header">
          <h2>Auto-Reply</h2>
          <p>Enable AI auto-replies for specific contacts. The AI will respond using their style profile.</p>
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">Add Contact</span>
          </div>
          <div class="form-row">
            <div class="form-group" style="flex: 2;">
              <select id="ar-contact-select">
                <option value="">Loading chats...</option>
              </select>
            </div>
            <div class="form-group" style="flex: 0;">
              <button class="btn btn-primary" id="btn-enable-ar">Enable</button>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-header">
            <span class="card-title">Active Auto-Replies</span>
          </div>
          <div id="ar-list"><div class="empty-state"><span class="spinner"></span> Loading...</div></div>
        </div>
      </div>
    `;

    this.loadData();
    document.getElementById('btn-enable-ar').addEventListener('click', () => this.enable());
  },

  async loadData() {
    try {
      const [contacts, chats] = await Promise.all([
        api.getAutoReply(),
        api.getChats().catch(() => []),
      ]);
      this.contacts = contacts;
      this.allChats = chats.filter(c => !c.isGroup);
      this.renderSelect();
      this.renderList();
    } catch (err) {
      document.getElementById('ar-list').innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
    }
  },

  renderSelect() {
    const select = document.getElementById('ar-contact-select');
    const enabledIds = new Set(this.contacts.map(c => c.id));
    const available = this.allChats.filter(c => !enabledIds.has(c.id));

    select.innerHTML = available.length > 0
      ? '<option value="">Select a contact...</option>' + available.map(c => `<option value="${c.id}" data-name="${c.name}">${c.name || c.id}</option>`).join('')
      : '<option value="">No contacts available</option>';
  },

  renderList() {
    const container = document.getElementById('ar-list');
    if (this.contacts.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">&#9889;</div>No auto-replies configured</div>';
      return;
    }

    container.innerHTML = `<table class="table">
      <thead><tr><th>Contact</th><th>Status</th><th></th></tr></thead>
      <tbody>${this.contacts.map(c => `
        <tr>
          <td>${c.name || c.id}</td>
          <td><span class="badge badge-green">Active</span></td>
          <td style="text-align:right;"><button class="btn btn-danger btn-sm" data-id="${c.id}">Disable</button></td>
        </tr>
      `).join('')}</tbody>
    </table>`;

    container.querySelectorAll('.btn-danger').forEach(btn => {
      btn.addEventListener('click', () => this.disable(btn.dataset.id));
    });
  },

  async enable() {
    const select = document.getElementById('ar-contact-select');
    const contactId = select.value;
    if (!contactId) return;
    const contactName = select.options[select.selectedIndex].dataset.name || contactId;

    try {
      await api.enableAutoReply(contactId, contactName);
      App.toast('Auto-reply enabled for ' + contactName);
      this.loadData();
    } catch (err) {
      App.toast('Error: ' + err.message);
    }
  },

  async disable(contactId) {
    try {
      await api.disableAutoReply(contactId);
      App.toast('Auto-reply disabled');
      this.loadData();
    } catch (err) {
      App.toast('Error: ' + err.message);
    }
  },
};
