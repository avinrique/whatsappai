// App — hash router + socket.io init
const App = {
  socket: null,

  init() {
    // Socket.io
    this.socket = io();

    this.socket.on('client:status', (data) => {
      Sidebar.setConnectionState(data.state);
      if (data.state === 'connected') Sidebar.loadContacts();
    });

    this.socket.on('client:ready', () => {
      Sidebar.setConnectionState('connected');
      Sidebar.loadContacts();
      App.toast('WhatsApp connected');
    });

    this.socket.on('client:disconnected', () => {
      Sidebar.setConnectionState('disconnected');
      App.toast('WhatsApp disconnected');
    });

    this.socket.on('client:qr', (data) => {
      this.showQR(data.qr);
    });

    // Real-time messages
    this.socket.on('message:incoming', (data) => {
      ChatsPage.addRealtimeMessage(data, false);
    });

    this.socket.on('message:outgoing', (data) => {
      ChatsPage.addRealtimeMessage(data, true);
    });

    // Import progress
    this.socket.on('import:progress', (data) => {
      ImportPage.onProgress(data);
    });

    this.socket.on('import:done', (data) => {
      ImportPage.onDone(data);
    });

    // Upload progress (chat export zip)
    this.socket.on('upload:progress', (data) => {
      ImportPage.onUploadProgress(data);
    });

    this.socket.on('upload:done', (data) => {
      ImportPage.onUploadDone(data);
    });

    // Profile build progress
    this.socket.on('profile:progress', (data) => {
      ProfilesPage.onProgress(data);
    });

    this.socket.on('profile:done', (data) => {
      ProfilesPage.onDone(data);
    });

    // Render sidebar
    Sidebar.render();

    // Initial status check
    api.getStatus().then(data => {
      Sidebar.setConnectionState(data.state);
      if (data.state === 'connected') Sidebar.loadContacts();
    }).catch(() => {});

    // Hash router
    window.addEventListener('hashchange', () => this.route());
    this.route();
  },

  route() {
    const hash = location.hash.slice(1) || 'chats';
    const [page, ...rest] = hash.split('/');
    const param = rest.join('/');

    Sidebar.updateActiveNav();

    switch (page) {
      case 'chats':
        ChatsPage.render(param || null);
        break;
      case 'import':
        ImportPage.render();
        break;
      case 'autoreply':
        AutoReplyPage.render();
        break;
      case 'profiles':
        ProfilesPage.render();
        break;
      case 'scheduler':
        SchedulerPage.render();
        break;
      case 'settings':
        SettingsPage.render();
        break;
      default:
        ChatsPage.render(null);
    }
  },

  showQR(qrData) {
    // Remove existing
    const existing = document.getElementById('qr-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'qr-overlay';
    overlay.id = 'qr-overlay';
    overlay.innerHTML = `
      <div class="qr-box">
        <h3>Scan QR Code</h3>
        <p style="color: var(--text-secondary); margin-bottom: 16px; font-size: 13px;">Open WhatsApp on your phone and scan this code</p>
        <div id="qr-canvas" style="background: white; padding: 16px; display: inline-block; border-radius: 8px;"></div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Render QR as a simple text grid (the QR data is a string from whatsapp-web.js)
    // We'll render it as a table of blocks
    this.renderQRCode(qrData);
  },

  renderQRCode(qrData) {
    const container = document.getElementById('qr-canvas');
    if (!container) return;
    // qrData is a raw QR string — render as styled text
    container.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qrData)}" alt="QR Code" style="width: 256px; height: 256px;">`;
  },

  toast(message) {
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3500);
  },
};

// Start
document.addEventListener('DOMContentLoaded', () => App.init());
