const express = require('express');
const scheduler = require('../../scheduler/scheduler');
const agent = require('../../agent/agent');
const { callLLM } = require('../../agent/llm');

module.exports = function (client) {
  const router = express.Router();

  /**
   * Smart schedule — parse natural language prompt into contact + time + intent.
   * "send Ayush a message in the evening asking about dinner"
   * → { contactQuery: "Ayush", time: "19:00", intent: "ask about dinner" }
   */
  router.post('/smart', async (req, res) => {
    try {
      const { prompt, contacts } = req.body;
      if (!prompt) return res.status(400).json({ error: 'prompt required' });

      // Build a contact list string for the LLM
      const contactList = (contacts || []).map(c => `- "${c.name}" (${c.id})`).join('\n');

      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);
      const currentHour = now.getHours();
      const currentTimeStr = now.toTimeString().slice(0, 5);

      const systemPrompt = `You parse natural language scheduling instructions into structured data. Output ONLY valid JSON, nothing else.`;

      const userPrompt = `Parse this scheduling instruction:
"${prompt}"

Current date: ${todayStr}
Current time: ${currentTimeStr}

Available contacts:
${contactList || '(no contacts provided — extract the name from the prompt)'}

Output JSON with these fields:
{
  "contactQuery": "the contact name mentioned in the prompt (just the name, like 'Ayush' or 'Mom')",
  "intent": "what the message should say — convert to a direct instruction for the AI, e.g. 'ask him to have dinner' → 'ask about having dinner'",
  "time": "ISO datetime string for when to send. Interpret relative times: 'in the evening' = today at 19:00, 'tomorrow morning' = tomorrow at 09:00, 'in 2 hours' = ${new Date(now.getTime() + 7200000).toISOString()}, 'tonight' = today at 21:00, 'now' = null (send immediately). If no time specified, use null.",
  "matchedContactId": "if you can find an exact match in the contact list above, put the contact ID here. Otherwise null.",
  "matchedContactName": "if you matched, put the display name. Otherwise null.",
  "ambiguous": false
}

If the contact name could match MULTIPLE people in the list (e.g. two people named "Ayush"), set ambiguous=true and set contactQuery to what was said.

ONLY output the JSON object. No explanation.`;

      const result = await callLLM(systemPrompt, [{ role: 'user', content: userPrompt }], 400);

      // Parse the JSON from LLM response
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return res.status(400).json({ error: 'Could not parse prompt. Try being more specific.' });
      }

      let parsed;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        return res.status(400).json({ error: 'Could not parse prompt. Try being more specific.' });
      }

      // If LLM didn't match, try fuzzy match ourselves
      if (!parsed.matchedContactId && parsed.contactQuery && contacts) {
        const query = parsed.contactQuery.toLowerCase().trim();
        const matches = contacts.filter(c => {
          const name = (c.name || '').toLowerCase();
          const id = (c.id || '').toLowerCase();
          return name.includes(query) || query.includes(name) || id.includes(query);
        });

        if (matches.length === 1) {
          parsed.matchedContactId = matches[0].id;
          parsed.matchedContactName = matches[0].name;
          parsed.ambiguous = false;
        } else if (matches.length > 1) {
          parsed.ambiguous = true;
          parsed.candidates = matches.map(c => ({ id: c.id, name: c.name }));
        }
      }

      res.json(parsed);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * Resolve a contact query — for disambiguation when multiple contacts match.
   */
  router.post('/resolve-contact', (req, res) => {
    try {
      const { query, contacts } = req.body;
      if (!query || !contacts) return res.status(400).json({ error: 'query and contacts required' });

      const q = query.toLowerCase().trim();
      const matches = contacts.filter(c => {
        const name = (c.name || '').toLowerCase();
        const id = (c.id || '').toLowerCase();
        // Match by name substring, full name, or phone number
        return name.includes(q) || q.includes(name) || id.includes(q) || name === q;
      });

      res.json({ matches });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // List scheduled messages
  router.get('/', (req, res) => {
    const jobs = scheduler.listJobs();
    res.json(jobs);
  });

  // Generate AI message preview (doesn't schedule, just returns the text)
  router.post('/preview', async (req, res) => {
    try {
      const { contactId, contactName, instruction } = req.body;
      if (!contactId || !contactName || !instruction) {
        return res.status(400).json({ error: 'contactId, contactName, and instruction required' });
      }
      const message = await agent.generateFromInstruction(contactId, contactName, instruction);
      res.json({ message });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create a scheduled message (always sends the exact message text provided)
  router.post('/', (req, res) => {
    try {
      const { contactId, contactName, sendAt, message } = req.body;
      if (!contactId || !contactName || !sendAt || !message) {
        return res.status(400).json({ error: 'contactId, contactName, sendAt, and message required' });
      }
      const id = scheduler.scheduleMessage(contactId, contactName, sendAt, message, false);
      if (id) {
        // Return the created job so frontend can display it immediately
        const jobs = scheduler.listJobs();
        const job = jobs.find(j => j.id === id);
        res.json({ success: true, id, job });
      } else {
        res.status(400).json({ error: 'Failed to schedule — time may be in the past' });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update a scheduled message
  router.put('/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message required' });
    }
    const updated = scheduler.updateJobMessage(id, message);
    res.json({ success: updated });
  });

  // Cancel a scheduled message
  router.delete('/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const cancelled = scheduler.cancelJob(id);
    res.json({ success: cancelled });
  });

  return router;
};
