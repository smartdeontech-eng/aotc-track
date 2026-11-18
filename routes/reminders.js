// Reminder log + manual trigger (admin).
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { runAllReminders } = require('../utils/reminders');

function isAdmin(req) { return ['admin','localadmin'].includes(req.user.role); }

router.get('/log', requireAuth, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only.' });
  res.json(db.findAll('reminder_log').sort((a, b) => (b.sentAt || '').localeCompare(a.sentAt || '')).slice(0, 100));
});

router.post('/run-now', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only.' });
  await runAllReminders();
  res.json({ ok: true, log: db.findAll('reminder_log').slice(-10) });
});

module.exports = router;
