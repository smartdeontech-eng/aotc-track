const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { getSettings, updateSettings } = require('../utils/settings');
const { sendMail, getTransport } = require('../utils/mailer');
const { sendSms, isConfigured: smsConfigured } = require('../utils/sms');

const router = express.Router();

const LOGO_DIR = path.join(__dirname, '..', 'public', 'img');
// Extension comes from the validated mimetype, never from the client-supplied
// originalname — see the same note in routes/products.js. A spoofed
// originalname like "logo.svg"/"logo.html" would otherwise be served by
// express.static as image/svg+xml or text/html, i.e. stored XSS on our origin.
const MIME_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LOGO_DIR),
  filename: (req, file, cb) => {
    const ext = MIME_EXT[file.mimetype] || '.png';
    cb(null, `logo-custom-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (MIME_EXT[file.mimetype]) cb(null, true);
    else cb(new Error('Only JPG, PNG, or WEBP images are allowed.'));
  },
});

// Readable by any logged-in user (currency symbol, letterhead info, etc. are
// used throughout the UI) — only staff.manage can change them (below).
router.get('/', requireAuth, (req, res) => {
  res.json(getSettings());
});

// body = { companyName, presbytery, district, addressLines: string[], phones: string[], email }
router.put('/', requireAuth, requirePermission('staff.manage'), (req, res) => {
  const { companyName, presbytery, district, addressLines, phones, email, sessionClerk, minister, absenceFlagThreshold } = req.body;
  const patch = {};
  if (absenceFlagThreshold !== undefined) {
    const n = Number(absenceFlagThreshold);
    if (Number.isFinite(n) && n >= 2 && n <= 12) patch.absenceFlagThreshold = Math.round(n);
  }
  if (companyName !== undefined) patch.companyName = String(companyName).trim();
  if (presbytery !== undefined) patch.presbytery = String(presbytery).trim();
  if (district !== undefined) patch.district = String(district).trim();
  if (email !== undefined) patch.email = String(email).trim();
  if (sessionClerk !== undefined) patch.sessionClerk = String(sessionClerk).trim();
  if (minister !== undefined) patch.minister = String(minister).trim();
  if (Array.isArray(addressLines)) patch.addressLines = addressLines.map(s => String(s).trim()).filter(Boolean);
  if (Array.isArray(phones)) patch.phones = phones.map(s => String(s).trim()).filter(Boolean);
  res.json(updateSettings(patch));
});

// Sends a real test email using whatever SMTP is currently configured, so an
// admin can confirm it works without waiting for a real invoice/reset email.
router.post('/test-email', requireAuth, requirePermission('staff.manage'), async (req, res) => {
  const to = (req.body && req.body.to) || req.user.email;
  if (!getTransport()) {
    return res.status(400).json({ error: 'SMTP is not configured in .env — nothing was sent. See the README\'s "Email setup" section.' });
  }
  const result = await sendMail({
    to,
    subject: 'AOTC Track test email',
    html: `<p>This is a test email from your AOTC Track app, sent at ${new Date().toLocaleString('en-GB')}.</p><p>If you received this, SMTP is working correctly.</p>`,
  });
  if (result && result.error) return res.status(500).json({ error: 'Send failed: ' + result.error });
  res.json({ ok: true, sentTo: to });
});

// Sends a real test SMS via mNotify using whatever's configured in .env, so
// an admin can confirm the sender ID/API key actually deliver without
// waiting for a real reminder to go out.
router.post('/test-sms', requireAuth, requirePermission('staff.manage'), async (req, res) => {
  const to = (req.body && req.body.to) || '';
  const phoneCountry = (req.body && req.body.phoneCountry) || '+233';
  if (!smsConfigured()) {
    return res.status(400).json({ error: 'SMS_API_KEY is not configured in .env — nothing was sent.' });
  }
  if (!to) {
    return res.status(400).json({ error: 'Enter a phone number to send the test to.' });
  }
  const result = await sendSms({
    to, phoneCountry,
    message: `AOTC Track: This is a test message confirming your SMS sender ID is live, sent at ${new Date().toLocaleString('en-GB')}.`,
  });
  if (result && result.error) return res.status(500).json({ error: 'Send failed: ' + result.error });
  if (result && result.skipped) return res.status(400).json({ error: `Not sent (${result.skipped}). mNotify only reliably delivers to +233 numbers in local format.` });
  res.json({ ok: true, sentTo: to });
});

router.post('/logo', requireAuth, requirePermission('staff.manage'), (req, res) => {
  upload.single('logo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No image file received.' });

    // Remove the previous custom logo file (but never delete the bundled defaults).
    const current = getSettings();
    if (current.logoPath && current.logoPath.startsWith('/img/logo-custom-')) {
      const oldPath = path.join(__dirname, '..', 'public', current.logoPath.replace(/^\//, ''));
      fs.existsSync(oldPath) && fs.unlink(oldPath, () => {});
    }
    const logoPath = `/img/${req.file.filename}`;
    res.json(updateSettings({ logoPath }));
  });
});

module.exports = router;
