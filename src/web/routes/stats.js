const express = require('express');
const vectordb = require('../../data/vectordb');

module.exports = function () {
  const router = express.Router();

  router.get('/', async (req, res) => {
    try {
      const stats = await vectordb.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
};
