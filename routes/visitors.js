// AOTC Track — Visitors & New Members (Phase 8, Mission & Evangelism).
// Register visitors and new members, welcome SMS, engagement checklist,
// follow-up log, and integration tracking. Feeds ME-01/ME-04 statistics.
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { sendSms } = require('../utils/sms');

const STEPS = [
  { key: 'welcome', label: 'Welcome SMS sent' },
  { key: 'call7', label: 'Follow-up call within 1 week' },
  { key: 'orientation', label: 'New-convert / orientation class' },
  { key: 'group', label: 'Introduced to a generational group' },
  { key: 'integrated', label: 'Integration confirmed (~3 months)' },
];

const { actor, canViewAll } = require('../utils/scope');
const manage = [requireAuth, requirePermission('visitors.manage')];

router.get('/', requireAuth, (req, res) => {
  const u = db.findById('users', req.user.id) || {};
  if (!canViewAll(req) && !(u.permissions || []).includes('visitors.manage')) {
    return res.status(403).json({ error: 'This module belongs to Mission & Evangelism.' });
  }
  res.json(db.findAll('visitors').sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
});

router.post('/', ...manage, async (req, res) => {
  const { name, phone, email, type } = req.body;
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required.' });
  const isNewMember = type === 'new-member';
  const rec = db.insert('visitors', {
    name: String(name).trim(), phone: String(phone || '').trim(), email: String(email || '').trim(),
    dayBorn: String(req.body.dayBorn || '').trim(), source: String(req.body.source || '').trim(),
    notes: String(req.body.notes || '').trim(),
    status: isNewMember ? 'new-member' : 'visitor',
    firstSeen: req.body.firstSeen || new Date().toISOString().slice(0, 10),
    steps: isNewMember ? STEPS.map(s => ({ ...s, done: false, doneAt: null })) : null,
    followups: [],
    registeredBy: actor(req).userName,
  });
  // Welcome SMS (best-effort)
  if (rec.phone) {
    const msg = isNewMember
      ? `Welcome to the PCG Adabraka Official Town Congregation family, ${rec.name.split(' ')[0]}! We are glad you have joined us. God richly bless you. — PCG-AOTC`
      : `Thank you for worshipping with us at PCG Adabraka Official Town Congregation, ${rec.name.split(' ')[0]}! You are always welcome. — PCG-AOTC`;
    try {
      const r = await sendSms({ to: rec.phone, message: msg });
      if (r && !r.skipped && !r.error && rec.steps) {
        rec.steps[0].done = true; rec.steps[0].doneAt = new Date().toISOString();
        db.update('visitors', rec.id, { steps: rec.steps });
      }
    } catch (e) {}
  }
  logActivity({ ...actor(req), action: `Registered ${rec.status}`, entityType: 'visitor', entityId: rec.id, entityLabel: rec.name });
  res.json(db.findById('visitors', rec.id));
});

router.put('/:id', ...manage, (req, res) => {
  const rec = db.findById('visitors', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Person not found.' });
  const patch = {};
  ['name', 'phone', 'email', 'dayBorn', 'source', 'notes', 'firstSeen'].forEach(k => {
    if (req.body[k] !== undefined) patch[k] = String(req.body[k]).trim();
  });
  // convert visitor -> new member (starts the engagement track)
  if (req.body.status === 'new-member' && rec.status === 'visitor') {
    patch.status = 'new-member';
    patch.steps = STEPS.map(s => ({ ...s, done: false, doneAt: null }));
    patch.convertedAt = new Date().toISOString();
  }
  if (req.body.status === 'inactive') patch.status = 'inactive';
  const updated = db.update('visitors', rec.id, patch);
  logActivity({ ...actor(req), action: 'Updated visitor/new member', entityType: 'visitor', entityId: rec.id, entityLabel: rec.name });
  res.json(updated);
});

router.post('/:id/followups', ...manage, (req, res) => {
  const rec = db.findById('visitors', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Person not found.' });
  const note = String(req.body.note || '').trim();
  if (!note) return res.status(400).json({ error: 'Write a short note about the follow-up.' });
  const followups = rec.followups || [];
  followups.push({ note, by: actor(req).userName, at: new Date().toISOString() });
  const updated = db.update('visitors', rec.id, { followups });
  logActivity({ ...actor(req), action: 'Logged follow-up', entityType: 'visitor', entityId: rec.id, entityLabel: rec.name });
  res.json(updated);
});

router.post('/:id/steps/:key/toggle', ...manage, (req, res) => {
  const rec = db.findById('visitors', Number(req.params.id));
  if (!rec || !rec.steps) return res.status(404).json({ error: 'No engagement track for this person.' });
  const step = rec.steps.find(s => s.key === req.params.key);
  if (!step) return res.status(404).json({ error: 'Unknown step.' });
  step.done = !step.done;
  step.doneAt = step.done ? new Date().toISOString() : null;
  const patch = { steps: rec.steps };
  if (req.params.key === 'integrated') patch.status = step.done ? 'integrated' : 'new-member';
  const updated = db.update('visitors', rec.id, patch);
  logActivity({ ...actor(req), action: `${step.done ? 'Completed' : 'Reopened'} step: ${step.label}`, entityType: 'visitor', entityId: rec.id, entityLabel: rec.name });
  res.json(updated);
});

module.exports = router;
