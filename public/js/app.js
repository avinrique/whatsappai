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

    // Emergency notification
    this.socket.on('emergency', (data) => {
      App.showEmergencyAlert(data);
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

  showEmergencyAlert(data) {
    // Remove existing emergency alerts
    document.querySelectorAll('.emergency-alert').forEach(el => el.remove());

    const alert = document.createElement('div');
    alert.className = 'emergency-alert';
    alert.innerHTML = `
      <div class="emergency-content">
        <div class="emergency-icon">&#9888;</div>
        <div class="emergency-text">
          <strong>EMERGENCY from ${data.contactName}</strong>
          <p>"${data.message}"</p>
        </div>
        <button class="emergency-dismiss" onclick="this.closest('.emergency-alert').remove()">&#10005;</button>
      </div>
    `;
    alert.style.cssText = `
      position: fixed; top: 0; left: 0; right: 0; z-index: 10000;
      background: #dc2626; color: white; padding: 12px 20px;
      font-size: 14px; box-shadow: 0 4px 12px rgba(220,38,38,0.4);
      animation: slideDown 0.3s ease;
    `;
    const content = alert.querySelector('.emergency-content');
    content.style.cssText = 'display: flex; align-items: center; gap: 12px; max-width: 800px; margin: 0 auto;';
    alert.querySelector('.emergency-icon').style.cssText = 'font-size: 28px;';
    alert.querySelector('.emergency-text p').style.cssText = 'margin: 4px 0 0; opacity: 0.9; font-size: 13px;';
    alert.querySelector('.emergency-dismiss').style.cssText = 'background: none; border: none; color: white; font-size: 20px; cursor: pointer; margin-left: auto; padding: 4px 8px;';

    document.body.prepend(alert);

    // Also play a notification sound if available
    try { new Audio('data:audio/wav;base64,UklGRnoGAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQoGAACBhYqFbF1fdH+Jj4yAcWBRTU9eao+fl4V0Y1dPT11zjJOPgnRmW1JQWW2IkY+Dd2hjXVxfb4WOj4V5bmZgYGNriIyLhXtya2hmZ2+FiYqFfXRuamhpc4SIiIV+dnBsanB3g4eGhH95dHBuc3d/hIaFg396d3V0dnp+goSEg4B9e3l5en1/gYKCgoGAf359fX5/gIGBgYGBgIB/f39/gICAgYGBgQ==').play(); } catch {}

    // Auto-dismiss after 30 seconds
    setTimeout(() => alert.remove(), 30000);
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
