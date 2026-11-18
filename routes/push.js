// AOTC Track — device push notification subscriptions + announcements.
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const push = require('../utils/push');
const db = require('../utils/db');
const { sendSms } = require('../utils/sms');
const { sendMail } = require('../utils/mailer');

// Public key for the browser's pushManager.subscribe (null = push not configured).
router.get('/public-key', requireAuth, (req, res) => {
  res.json({ key: push.publicKey(), configured: push.isConfigured() });
});

router.post('/subscribe', requireAuth, (req, res) => {
  const sub = req.body.subscription;
  if (!sub || !sub.endpoint) return res.status(400).json({ error: 'Missing subscription.' });
  push.saveSubscription(req.user.id, sub, req.get('user-agent'));
  res.json({ ok: true });
});

router.post('/unsubscribe', requireAuth, (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint.' });
  push.removeSubscription(endpoint);
  res.json({ ok: true });
});

// Devices registered for the logged-in user (shown in My Account).
router.get('/devices', requireAuth, (req, res) => {
  res.json(push.subscriptionsForUser(req.user.id).map(s => ({
    id: s.id, userAgent: s.userAgent, createdAt: s.createdAt, endpoint: s.endpoint,
  })));
});

// Send a test notification to the logged-in user's devices.
router.post('/test', requireAuth, async (req, res) => {
  const r = await push.sendPushToUsers([req.user.id], {
    title: 'AOTC Track',
    body: 'Push notifications are working on this device. 🎉',
    url: '/account.html',
  });
  res.json(r);
});

// Broadcast an announcement to every user account — push always, SMS and
// email optionally. Admin tier only (Settings → announcement card).
router.post('/broadcast', requireAuth, async (req, res) => {
  if (!['admin', 'localadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only an admin can send announcements.' });
  }
  const title = String(req.body.title || 'AOTC Track').slice(0, 80);
  const message = String(req.body.message || '').trim().slice(0, 300);
  if (!message) return res.status(400).json({ error: 'A message is required.' });
  const wantSms = !!req.body.sms;
  const wantEmail = !!req.body.email;

  const users = db.findAll('users');
  const r = await push.sendPushToUsers(users.map(u => u.id), { title, body: message, url: '/' });
  let smsSent = 0, mailSent = 0;
  if (wantSms) {
    for (const u of users.filter(u => u.phone).slice(0, 100)) {
      try { const s = await sendSms({ to: u.phone, message: `${title}: ${message}` }); if (s && !s.skipped && !s.error) smsSent++; } catch (e) {}
    }
  }
  if (wantEmail) {
    for (const u of users.filter(u => u.email).slice(0, 100)) {
      try { const m = await sendMail({ to: u.email, subject: title, html: `<p>${message}</p><p style="color:#667">— AOTC Track</p>` }); if (!m || !m.error) mailSent++; } catch (e) {}
    }
  }
  res.json({ accounts: users.length, pushSent: r.sent || 0, smsSent, mailSent });
});

module.exports = router;
