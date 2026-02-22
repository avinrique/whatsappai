const SchedulerPage = {
  jobs: [],
  allChats: [],

  render() {
    const main = document.getElementById('main');
    main.innerHTML = `
      <div class="page">
        <div class="page-header">
          <h2>Message Scheduler</h2>
          <p>Tell the AI what to send, to whom, and when — in plain language.</p>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Quick Schedule</span>
          </div>
          <p style="font-size: 13px; color: var(--text-secondary); margin-bottom: 10px;">
            Type naturally. Examples: "send Ayush a message tonight asking about dinner", "tell Mom good morning tomorrow at 8am", "ask Rohan if he's free this weekend"
          </p>
          <div style="display: flex; gap: 8px;">
            <input type="text" id="smart-prompt" placeholder="e.g. send Ayush a message in the evening asking him to have dinner" style="flex: 1;">
            <button class="btn btn-primary" id="btn-smart-schedule">Send</button>
          </div>
          <div id="smart-status" style="margin-top: 10px; display: none;"></div>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Manual Schedule</span>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label>Contact</label>
              <select id="sched-contact">
                <option value="">Loading...</option>
              </select>
            </div>
            <div class="form-group">
              <label>Send At</label>
              <input type="datetime-local" id="sched-time">
            </div>
          </div>
          <div class="form-group">
            <label>What do you want to say?</label>
            <textarea id="sched-instruction" placeholder="e.g. ask him when he's free, wish her good morning, tell him about the plan tonight..."></textarea>
          </div>
          <div style="display: flex; gap: 8px;">
            <button class="btn btn-primary" id="btn-schedule">Generate & Schedule</button>
            <button class="btn btn-outline" id="btn-schedule-own">Schedule My Own Text</button>
          </div>
          <div id="sched-status" style="margin-top: 10px; display: none;"></div>
        </div>

        <div class="card">
          <div class="card-header">
            <span class="card-title">Scheduled Messages</span>
          </div>
          <div id="sched-list"><div class="empty-state"><span class="spinner"></span> Loading...</div></div>
        </div>
      </div>
    `;

    this.loadData();
    document.getElementById('btn-smart-schedule').addEventListener('click', () => this.handleSmartPrompt());
    document.getElementById('smart-prompt').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleSmartPrompt();
    });
    document.getElementById('btn-schedule').addEventListener('click', () => this.scheduleWithAI());
    document.getElementById('btn-schedule-own').addEventListener('click', () => this.scheduleOwn());
  },

  async loadData() {
    try {
      const [jobs, chats] = await Promise.all([
        api.getScheduled(),
        api.getChats().catch(() => []),
      ]);
      this.jobs = jobs;
      this.allChats = chats.filter(c => !c.isGroup);
      this.renderSelect();
      this.renderJobs();
    } catch (err) {
      document.getElementById('sched-list').innerHTML = `<div class="empty-state">Error: ${err.message}</div>`;
    }
  },

  renderSelect() {
    const select = document.getElementById('sched-contact');
    if (!select) return;
    select.innerHTML = this.allChats.length > 0
      ? '<option value="">Select contact...</option>' + this.allChats.map(c => `<option value="${c.id}" data-name="${c.name}">${c.name || c.id}</option>`).join('')
      : '<option value="">No contacts</option>';
  },

  // ===== Smart Prompt =====

  showSmart(html) {
    const el = document.getElementById('smart-status');
    if (el) { el.style.display = 'block'; el.innerHTML = html; }
  },

  hideSmart() {
    const el = document.getElementById('smart-status');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  },

  async handleSmartPrompt() {
    const input = document.getElementById('smart-prompt');
    const prompt = input.value.trim();
    if (!prompt) return App.toast('Type what you want to schedule');

    const btn = document.getElementById('btn-smart-schedule');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
    this.showSmart('<span class="spinner"></span> Understanding your request...');

    try {
      // Step 1: Parse the prompt
      const parsed = await api.smartSchedule(prompt, this.allChats);

      // Step 2: Check if contact was matched
      if (parsed.ambiguous && parsed.candidates && parsed.candidates.length > 1) {
        // Multiple matches — ask user to pick
        this.showSmartDisambiguation(parsed, prompt);
        btn.disabled = false;
        btn.textContent = 'Send';
        return;
      }

      if (!parsed.matchedContactId) {
        // No match — show what we found and let them pick manually
        this.showSmartNoMatch(parsed, prompt);
        btn.disabled = false;
        btn.textContent = 'Send';
        return;
      }

      // Step 3: We have contact + intent. Generate message and schedule.
      await this.executeSmartSchedule(
        parsed.matchedContactId,
        parsed.matchedContactName,
        parsed.intent || prompt,
        parsed.time
      );

    } catch (err) {
      this.showSmart(`<div style="color: var(--red);">Error: ${err.message}</div>`);
    }

    btn.disabled = false;
    btn.textContent = 'Send';
  },

  showSmartDisambiguation(parsed, originalPrompt) {
    const candidates = parsed.candidates || [];
    let html = `<div style="margin-bottom: 8px;">Multiple contacts match "<strong>${this.escapeHtml(parsed.contactQuery)}</strong>". Which one?</div>`;
    html += `<div style="display: flex; flex-wrap: wrap; gap: 6px;">`;
    candidates.forEach(c => {
      html += `<button class="btn btn-outline btn-sm smart-pick" data-id="${c.id}" data-name="${c.name || c.id}">${c.name || c.id} <span style="font-size:10px;color:var(--text-muted);">${c.id.replace('@c.us','')}</span></button>`;
    });
    html += `</div>`;

    this.showSmart(html);

    // Attach click handlers
    document.querySelectorAll('.smart-pick').forEach(btn => {
      btn.addEventListener('click', async () => {
        this.showSmart('<span class="spinner"></span> Generating message...');
        const contactId = btn.dataset.id;
        const contactName = btn.dataset.name;
        await this.executeSmartSchedule(contactId, contactName, parsed.intent || originalPrompt, parsed.time);
      });
    });
  },

  showSmartNoMatch(parsed, originalPrompt) {
    let html = `<div style="margin-bottom: 8px;">Couldn't find "<strong>${this.escapeHtml(parsed.contactQuery || '?')}</strong>" in your contacts. Pick one:</div>`;
    html += `<div style="max-height: 150px; overflow-y: auto;">`;
    this.allChats.forEach(c => {
      html += `<div class="contact-item smart-pick-any" data-id="${c.id}" data-name="${c.name || ''}" style="padding: 4px 8px; cursor: pointer; font-size: 12px;">
        <span>${c.name || c.id}</span>
      </div>`;
    });
    html += `</div>`;

    this.showSmart(html);

    document.querySelectorAll('.smart-pick-any').forEach(el => {
      el.addEventListener('click', async () => {
        this.showSmart('<span class="spinner"></span> Generating message...');
        await this.executeSmartSchedule(el.dataset.id, el.dataset.name || el.dataset.id, parsed.intent || originalPrompt, parsed.time);
      });
    });
  },

  async executeSmartSchedule(contactId, contactName, intent, timeStr) {
    try {
      // Generate the AI message
      this.showSmart('<span class="spinner"></span> Generating message in your style...');
      const { message } = await api.previewScheduled(contactId, contactName, intent);

      if (!timeStr) {
        // No time = send now
        this.showSmart(
          `<div style="margin-bottom: 8px;">Sending to <strong>${this.escapeHtml(contactName)}</strong> now:</div>` +
          `<div style="background: var(--bg-tertiary); padding: 8px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 8px;">${this.escapeHtml(message)}</div>` +
          `<span class="spinner"></span> Sending...`
        );

        // Send it directly
        await api.sendMessage(contactId, message, contactName);
        this.showSmart(`<div style="color: var(--green); font-weight: 500;">Sent to ${this.escapeHtml(contactName)}: "${this.escapeHtml(message)}"</div>`);
        document.getElementById('smart-prompt').value = '';
        setTimeout(() => this.hideSmart(), 4000);
        return;
      }

      // Schedule it
      const sendAt = new Date(timeStr);
      const timeDisplay = sendAt.toLocaleString();

      this.showSmart(
        `<div style="margin-bottom: 8px;">Scheduling for <strong>${this.escapeHtml(contactName)}</strong> at ${timeDisplay}:</div>` +
        `<div style="background: var(--bg-tertiary); padding: 8px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 8px;">${this.escapeHtml(message)}</div>` +
        `<span class="spinner"></span> Scheduling...`
      );

      const result = await api.scheduleMessage({
        contactId,
        contactName,
        sendAt: sendAt.toISOString(),
        message,
      });

      this.showSmart(`<div style="color: var(--green); font-weight: 500;">Scheduled for ${timeDisplay}! Message: "${this.escapeHtml(message)}"</div>`);
      document.getElementById('smart-prompt').value = '';
      setTimeout(() => this.hideSmart(), 4000);

      if (result.job) {
        this.jobs.push(result.job);
        this.renderJobs();
      }
      this.loadData();

    } catch (err) {
      this.showSmart(`<div style="color: var(--red);">Error: ${err.message}</div>`);
    }
  },

  // ===== Manual Schedule =====

  renderJobs() {
    const container = document.getElementById('sched-list');
    if (!container) return;

    if (this.jobs.length === 0) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon">&#9200;</div>No scheduled messages</div>';
      return;
    }

    container.innerHTML = this.jobs.map(j => {
      const time = new Date(j.sendAt).toLocaleString();
      const msgText = j.message || '';
      return `<div class="card" style="margin-bottom: 8px;">
        <div style="display: flex; justify-content: space-between; align-items: start; margin-bottom: 8px;">
          <div>
            <div style="font-weight: 600; font-size: 14px;">${j.contactName}</div>
            <div style="font-size: 12px; color: var(--text-muted);">Scheduled for ${time}</div>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-outline btn-sm btn-edit-job" data-id="${j.id}">Edit</button>
            <button class="btn btn-danger btn-sm btn-cancel-job" data-id="${j.id}">Cancel</button>
          </div>
        </div>
        <div id="job-msg-${j.id}" style="background: var(--bg-tertiary); padding: 10px 14px; border-radius: 8px; font-size: 14px; line-height: 1.5;">
          ${this.escapeHtml(msgText)}
        </div>
        <div id="job-edit-${j.id}" style="display: none; margin-top: 8px;">
          <textarea id="job-edit-text-${j.id}" rows="2" style="margin-bottom: 8px;">${this.escapeHtml(msgText)}</textarea>
          <div style="display: flex; gap: 6px;">
            <button class="btn btn-primary btn-sm btn-save-job" data-id="${j.id}">Save</button>
            <button class="btn btn-outline btn-sm btn-cancel-edit" data-id="${j.id}">Cancel</button>
          </div>
        </div>
      </div>`;
    }).join('');

    container.querySelectorAll('.btn-cancel-job').forEach(btn => {
      btn.addEventListener('click', () => this.cancelJob(parseInt(btn.dataset.id)));
    });

    container.querySelectorAll('.btn-edit-job').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        document.getElementById('job-msg-' + id).style.display = 'none';
        document.getElementById('job-edit-' + id).style.display = 'block';
      });
    });

    container.querySelectorAll('.btn-cancel-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id;
        document.getElementById('job-msg-' + id).style.display = 'block';
        document.getElementById('job-edit-' + id).style.display = 'none';
      });
    });

    container.querySelectorAll('.btn-save-job').forEach(btn => {
      btn.addEventListener('click', () => this.saveJobEdit(parseInt(btn.dataset.id)));
    });
  },

  getFormData() {
    const select = document.getElementById('sched-contact');
    const contactId = select.value;
    if (!contactId) { App.toast('Select a contact'); return null; }
    const contactName = select.options[select.selectedIndex].dataset.name || contactId;
    const sendAt = document.getElementById('sched-time').value;
    if (!sendAt) { App.toast('Select a time'); return null; }
    const instruction = document.getElementById('sched-instruction').value.trim();
    if (!instruction) { App.toast('Type what you want to say'); return null; }
    return { contactId, contactName, sendAt, instruction };
  },

  showStatus(html) {
    const el = document.getElementById('sched-status');
    if (el) { el.style.display = 'block'; el.innerHTML = html; }
  },

  hideStatus() {
    const el = document.getElementById('sched-status');
    if (el) { el.style.display = 'none'; el.innerHTML = ''; }
  },

  async scheduleWithAI() {
    const data = this.getFormData();
    if (!data) return;

    const btn = document.getElementById('btn-schedule');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Generating...';
    this.showStatus('<span class="spinner"></span> AI is writing the message in your style...');

    try {
      const { message } = await api.previewScheduled(data.contactId, data.contactName, data.instruction);

      btn.innerHTML = '<span class="spinner"></span> Scheduling...';
      this.showStatus(`<div style="margin-bottom: 6px; font-size: 12px; color: var(--text-muted);">Generated message:</div><div style="background: var(--bg-tertiary); padding: 8px 12px; border-radius: 6px; font-size: 14px; margin-bottom: 8px;">${this.escapeHtml(message)}</div><span class="spinner"></span> Scheduling...`);

      const result = await api.scheduleMessage({
        contactId: data.contactId,
        contactName: data.contactName,
        sendAt: data.sendAt,
        message,
      });

      App.toast('Scheduled!');
      this.showStatus(`<div style="color: var(--green); font-weight: 500;">Scheduled! Message: "${this.escapeHtml(message)}"</div>`);
      setTimeout(() => this.hideStatus(), 3000);

      document.getElementById('sched-instruction').value = '';
      document.getElementById('sched-time').value = '';

      if (result.job) {
        this.jobs.push(result.job);
        this.renderJobs();
      }
      this.loadData();
    } catch (err) {
      App.toast('Error: ' + err.message);
      this.showStatus(`<div style="color: var(--red);">Error: ${err.message}</div>`);
    }

    btn.disabled = false;
    btn.textContent = 'Generate & Schedule';
  },

  async scheduleOwn() {
    const data = this.getFormData();
    if (!data) return;

    const btn = document.getElementById('btn-schedule-own');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Scheduling...';

    try {
      const result = await api.scheduleMessage({
        contactId: data.contactId,
        contactName: data.contactName,
        sendAt: data.sendAt,
        message: data.instruction,
      });

      App.toast('Scheduled!');
      document.getElementById('sched-instruction').value = '';
      document.getElementById('sched-time').value = '';

      if (result.job) {
        this.jobs.push(result.job);
        this.renderJobs();
      }
      this.loadData();
    } catch (err) {
      App.toast('Error: ' + err.message);
    }

    btn.disabled = false;
    btn.textContent = 'Schedule My Own Text';
  },

  async saveJobEdit(id) {
    const text = document.getElementById('job-edit-text-' + id).value.trim();
    if (!text) return App.toast('Message cannot be empty');

    try {
      await api.updateScheduled(id, text);
      App.toast('Message updated');
      this.loadData();
    } catch (err) {
      App.toast('Error: ' + err.message);
    }
  },

  async cancelJob(id) {
    if (!confirm('Cancel this scheduled message?')) return;
    try {
      await api.cancelScheduled(id);
      App.toast('Cancelled');
      this.loadData();
    } catch (err) {
      App.toast('Error: ' + err.message);
    }
  },

  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },
};
