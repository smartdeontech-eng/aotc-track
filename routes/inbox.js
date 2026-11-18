// AOTC Track — per-user notification inbox.
// Everything sent through the push layer is also stored per user
// (utils/push.js saveToInbox), so this route just reads/marks the store.
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { requireAuth } = require('../middleware/auth');

const MAX_ITEMS = 100;   // newest kept per user (older pruned on read)
const PAGE = 50;

// GET /api/inbox → { items (newest first, max 50), unread }
router.get('/', requireAuth, (req, res) => {
  const mine = db.findAll('user_notifications', n => Number(n.userId) === Number(req.user.id))
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  // Light housekeeping: keep the store from growing forever.
  mine.slice(MAX_ITEMS).forEach(n => db.remove('user_notifications', n.id));
  res.json({
    items: mine.slice(0, PAGE).map(n => ({
      id: n.id, title: n.title, body: n.body, url: n.url,
      readAt: n.readAt || null, createdAt: n.createdAt,
    })),
    unread: mine.filter(n => !n.readAt).length,
  });
});

// POST /api/inbox/read { ids?: [] } → mark given ids (or ALL unread) as read
router.post('/read', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : null;
  const now = new Date().toISOString();
  const mine = db.findAll('user_notifications', n =>
    Number(n.userId) === Number(req.user.id) && !n.readAt && (!ids || ids.includes(Number(n.id))));
  mine.forEach(n => db.update('user_notifications', n.id, { readAt: now }));
  res.json({ ok: true, marked: mine.length });
});

module.exports = router;
