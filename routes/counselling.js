// AOTC Track — Counselling module (Phase 9, CFL). CONFIDENTIAL:
// only CFL accounts (counselling.manage) and admins can access cases.
// (Whether BOTH admins keep access is a flagged Session decision.)
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { sendSms } = require('../utils/sms');
const { sendMail } = require('../utils/mailer');

const { actor } = require('../utils/scope');
function allowed(req) {
  if (['admin','localadmin'].includes(req.user.role)) return true;
  const u = db.findById('users', req.user.id) || {};
  return (u.permissions || []).includes('counselling.manage');
}
function guard(req, res) {
  if (allowed(req)) return true;
  res.status(403).json({ error: 'Counselling records are confidential to CFL and administrators.' });
  return false;
}

// ---- Counsellors (list managed by admin; CFL can view) ----
router.get('/counsellors', requireAuth, (req, res) => {
  if (!guard(req, res)) return;
  res.json(db.findAll('counsellors').filter(c => c.active !== false));
});
router.post('/counsellors', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can add counsellors.' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Counsellor name required.' });
  const rec = db.insert('counsellors', {
    name, phone: String(req.body.phone || '').trim(), email: String(req.body.email || '').trim(),
    specialties: String(req.body.specialties || '').trim(), active: true,
  });
  logActivity({ ...actor(req), action: 'Added counsellor', entityType: 'counsellor', entityId: rec.id, entityLabel: name });
  res.json(rec);
});
// Edit a counsellor's details (a wrong phone misroutes assignment SMS).
router.put('/counsellors/:id', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can edit counsellors.' });
  const rec = db.findById('counsellors', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Not found.' });
  const patch = {};
  ['name', 'phone', 'email', 'specialties'].forEach(k => {
    if (req.body[k] !== undefined) patch[k] = String(req.body[k]).trim();
  });
  if (patch.name === '') return res.status(400).json({ error: 'Counsellor name required.' });
  const updated = db.update('counsellors', rec.id, patch);
  logActivity({ ...actor(req), action: 'Updated counsellor', entityType: 'counsellor', entityId: rec.id, entityLabel: updated.name });
  res.json(updated);
});
router.delete('/counsellors/:id', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can remove counsellors.' });
  const rec = db.findById('counsellors', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Not found.' });
  db.update('counsellors', rec.id, { active: false });
  res.json({ ok: true });
});

// ---- Cases ----
router.get('/cases', requireAuth, (req, res) => {
  if (!guard(req, res)) return;
  res.json(db.findAll('counselling_cases').sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
});

router.post('/cases', requireAuth, requirePermission('counselling.manage'), (req, res) => {
  const { type, clients } = req.body;
  if (!clients || !String(clients).trim()) return res.status(400).json({ error: 'Enter the client name(s) — e.g. the couple-to-be.' });
  const rec = db.insert('counselling_cases', {
    type: ['marriage', 'grief', 'career', 'family', 'other'].includes(type) ? type : 'other',
    clients: String(clients).trim(), phone: String(req.body.phone || '').trim(),
    notes: String(req.body.notes || '').trim(),
    counsellorId: null, counsellorName: '',
    status: 'open', sessions: [],
    openedBy: actor(req).userName,
  });
  logActivity({ ...actor(req), action: 'Opened counselling case', entityType: 'counselling_case', entityId: rec.id, entityLabel: `${rec.type} case #${rec.id}` });
  res.json(rec);
});

// Correct a case's details. Closed once completed — a finished case is a record.
router.put('/cases/:id', requireAuth, requirePermission('counselling.manage'), (req, res) => {
  const rec = db.findById('counselling_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  if (rec.status === 'completed') {
    return res.status(423).json({ error: 'This case is completed and can no longer be edited.' });
  }
  const patch = {};
  if (req.body.type !== undefined && ['marriage', 'grief', 'career', 'family', 'other'].includes(req.body.type)) patch.type = req.body.type;
  ['clients', 'phone', 'notes'].forEach(k => {
    if (req.body[k] !== undefined) patch[k] = String(req.body[k]).trim();
  });
  if (patch.clients === '') return res.status(400).json({ error: 'Client name(s) required.' });
  const updated = db.update('counselling_cases', rec.id, patch);
  logActivity({ ...actor(req), action: 'Updated counselling case', entityType: 'counselling_case', entityId: rec.id, entityLabel: `case #${rec.id}` });
  res.json(updated);
});

router.post('/cases/:id/assign', requireAuth, requirePermission('counselling.manage'), async (req, res) => {
  const rec = db.findById('counselling_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  const counsellor = db.findById('counsellors', Number(req.body.counsellorId));
  if (!counsellor) return res.status(400).json({ error: 'Choose a counsellor from the list.' });
  const updated = db.update('counselling_cases', rec.id, {
    counsellorId: counsellor.id, counsellorName: counsellor.name, status: 'in-progress',
  });
  // notify the counsellor (never includes client details in the SMS)
  const msg = `PCG-AOTC: You have been assigned a ${rec.type} counselling case. Kindly contact the CFL secretary for details. God bless you.`;
  try { if (counsellor.phone) await sendSms({ to: counsellor.phone, message: msg }); } catch (e) {}
  try { if (counsellor.email) await sendMail({ to: counsellor.email, subject: 'Counselling case assigned', html: `<p>${msg}</p>` }); } catch (e) {}
  logActivity({ ...actor(req), action: `Assigned case to ${counsellor.name}`, entityType: 'counselling_case', entityId: rec.id, entityLabel: `${rec.type} case #${rec.id}` });
  res.json(updated);
});

router.post('/cases/:id/sessions', requireAuth, requirePermission('counselling.manage'), (req, res) => {
  const rec = db.findById('counselling_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  const note = String(req.body.note || '').trim();
  const date = req.body.date || new Date().toISOString().slice(0, 10);
  if (!note) return res.status(400).json({ error: 'Add a short session note.' });
  const sessions = rec.sessions || [];
  sessions.push({ date, note, by: actor(req).userName });
  const updated = db.update('counselling_cases', rec.id, { sessions });
  logActivity({ ...actor(req), action: 'Logged counselling session', entityType: 'counselling_case', entityId: rec.id, entityLabel: `case #${rec.id}` });
  res.json(updated);
});

router.post('/cases/:id/complete', requireAuth, requirePermission('counselling.manage'), (req, res) => {
  const rec = db.findById('counselling_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  const updated = db.update('counselling_cases', rec.id, {
    status: 'completed', completedAt: new Date().toISOString(), signOff: String(req.body.signOff || '').trim(),
  });
  logActivity({ ...actor(req), action: 'Completed counselling case (signed off)', entityType: 'counselling_case', entityId: rec.id, entityLabel: `${rec.type} case #${rec.id}` });
  res.json(updated);
});

// Permanently delete a case. Restricted to administrators (Admin / Local Admin)
// — CFL staff open, edit and complete cases but never erase the record; deletion
// is for the admin to remove mistakes and training/test cases. The full case is
// kept in the activity log snapshot so an erased case can still be traced.
router.delete('/cases/:id', requireAuth, (req, res) => {
  if (!['admin', 'localadmin'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Only an administrator can delete a counselling case.' });
  }
  const rec = db.findById('counselling_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  db.remove('counselling_cases', rec.id);
  logActivity({ ...actor(req), action: 'Deleted counselling case', entityType: 'counselling_case', entityId: rec.id, entityLabel: `${rec.type} case #${rec.id}`, snapshot: rec });
  res.json({ ok: true });
});

module.exports = router;
