const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

let client = null;

function createClient() {
  client = new Client({
    authStrategy: new LocalAuth(),
  });

  client.on('qr', (qr) => {
    console.log('\nScan this QR code with WhatsApp:\n');
    qrcode.generate(qr, { small: true });
  });

  client.on('auth_failure', (msg) => {
    console.error('Authentication failed:', msg);
  });

  client.on('disconnected', (reason) => {
    console.log('Disconnected:', reason);
    process.exit(1);
  });

  return client;
}

function getClient() {
  return client;
}

module.exports = { createClient, getClient };
