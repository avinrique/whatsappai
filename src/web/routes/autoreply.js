const express = require('express');
const config = require('../../config/config');

module.exports = function () {
  const router = express.Router();

  // List auto-reply contacts
  router.get('/', (req, res) => {
    const contacts = config.get('autoReplyContacts') || [];
    res.json(contacts);
  });

  // Enable auto-reply for a contact
  router.post('/', (req, res) => {
    const { contactId, contactName } = req.body;
    if (!contactId || !contactName) {
      return res.status(400).json({ error: 'contactId and contactName required' });
    }
    config.addAutoReplyContact(contactId, contactName);
    res.json({ success: true });
  });

  // Disable auto-reply for a contact
  router.delete('/:contactId', (req, res) => {
    config.removeAutoReplyContact(req.params.contactId);
    res.json({ success: true });
  });

  return router;
};
