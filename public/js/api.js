// Fetch wrapper for all API calls
const api = {
  async get(url) {
    const res = await fetch(url);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  async post(url, data) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  async put(url, data) {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  async del(url) {
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  // Chats
  getChats: () => api.get('/api/chats'),
  getMessages: (contactId, limit = 50) => api.get(`/api/chats/${encodeURIComponent(contactId)}/messages?limit=${limit}`),
  sendMessage: (contactId, message, contactName) => api.post('/api/chats/send', { contactId, message, contactName }),
  previewReply: (contactId, contactName, message) => api.post('/api/chats/preview', { contactId, contactName, message }),

  // Import
  getImportChats: () => api.get('/api/import/chats'),
  startImport: (chatIds) => api.post('/api/import/start', { chatIds }),
  deleteImported: (contactId) => api.del(`/api/import/${encodeURIComponent(contactId)}`),

  // Auto-reply
  getAutoReply: () => api.get('/api/autoreply'),
  enableAutoReply: (contactId, contactName) => api.post('/api/autoreply', { contactId, contactName }),
  disableAutoReply: (contactId) => api.del(`/api/autoreply/${encodeURIComponent(contactId)}`),

  // Profiles
  getProfiles: () => api.get('/api/profiles'),
  getActiveBuilds: () => api.get('/api/profiles/building'),
  getProfile: (contactId) => api.get(`/api/profiles/${encodeURIComponent(contactId)}`),
  generateProfileQuestions: (contactId, contactName) => api.post(`/api/profiles/${encodeURIComponent(contactId)}/questions`, { contactName }),
  buildProfile: (contactId, contactName, relationshipContext, profileQA) => api.post(`/api/profiles/${encodeURIComponent(contactId)}/build`, { contactName, relationshipContext, profileQA }),
  deleteProfile: (contactId) => api.del(`/api/profiles/${encodeURIComponent(contactId)}`),

  // Scheduler
  getScheduled: () => api.get('/api/scheduler'),
  previewScheduled: (contactId, contactName, instruction) => api.post('/api/scheduler/preview', { contactId, contactName, instruction }),
  scheduleMessage: (data) => api.post('/api/scheduler', data),
  updateScheduled: (id, message) => api.put(`/api/scheduler/${id}`, { message }),
  cancelScheduled: (id) => api.del(`/api/scheduler/${id}`),
  smartSchedule: (prompt, contacts) => api.post('/api/scheduler/smart', { prompt, contacts }),

  // Upload chat export
  async uploadChatExport(file, contactId, contactName) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('contactId', contactId);
    formData.append('contactName', contactName);
    const res = await fetch('/api/import/upload', {
      method: 'POST',
      body: formData,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }
    return res.json();
  },

  // Config & Stats
  getConfig: () => api.get('/api/config'),
  updateConfig: (key, value) => api.put('/api/config', { key, value }),
  getStats: () => api.get('/api/stats'),
  getStatus: () => api.get('/api/status'),
};
