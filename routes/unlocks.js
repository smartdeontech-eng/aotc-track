// Asking for something locked to be opened again.
//
// One request, one queue, five kinds — see utils/unlockKinds.js. Before this,
// four of the five locks in the app ended at "ask an admin", so the reason, the
// asker and the decision all happened on the phone and none of it was recorded.
// The approval is not really the point; the record is.
//
// WHO MAY ASK: anyone who can sign in. Asking is harmless and the approver is
// the control — making people qualify for the right to ask would just send them
// back to the phone, which is the thing being fixed.
// WHO MAY DECIDE: the admin tier, or whoever holds that kind's permission.
// Money goes to the Treasurer, the rest to the Session Clerk.
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { activeUsers } = require('../utils/accountStatus');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { notifyUser } = require('../utils/approvalNotify');
const { actor } = require('../utils/scope');
const { kind, canApprove, approvableKinds, resolveWindow } = require('../utils/unlockKinds');

function me(req) {
  const u = db.findById('users', req.user.id) || {};
  return { role: u.role, permissions: u.permissions || [], name: u.name || 'Unknown', id: req.user.id };
}
const sameTarget = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});

// Everyone who should be told a request is waiting.
function approversFor(name) {
  const k = kind(name);
  return activeUsers(u => ['admin', 'localadmin'].includes(u.role)
    || (k && k.approvers.some(p => (u.permissions || []).includes(p))));
}

// ---- ask -------------------------------------------------------------------
router.post('/', requireAuth, (req, res) => {
  const name = String(req.body.kind || '');
  const k = kind(name);
  if (!k) return res.status(400).json({ error: 'Unknown kind of lock.' });
  const target = req.body.target || {};
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Say what needs correcting — the reason is the point of asking.' });

  const rec = k.find(target);
  if (!rec) return res.status(404).json({ error: `That ${k.label.toLowerCase()} could not be found.` });
  if (!k.isLocked(rec)) return res.status(400).json({ error: `That ${k.label.toLowerCase()} is not locked — you can edit it directly.` });

  const dup = db.findAll('unlock_requests', r => r.kind === name && r.status === 'pending')
    .find(r => sameTarget(r.target, target));
  if (dup) return res.status(409).json({ error: 'Someone has already asked for this one. It is waiting to be decided.' });

  const u = me(req);
  const row = db.insert('unlock_requests', {
    kind: name, target, reason,
    label: k.describe(target),
    requestedBy: u.name, requestedById: u.id,
    status: 'pending', createdAt: new Date().toISOString(),
  });
  logActivity({ ...actor(req), action: `Asked for ${k.label.toLowerCase()} to be reopened — ${reason}`, entityType: 'unlock_request', entityId: row.id, entityLabel: row.label });
  approversFor(name).forEach(a => notifyUser(a, 'Request to reopen',
    `${u.name} has asked for ${k.label.toLowerCase()} (${row.label}) to be reopened: ${reason}`,
    { url: '/unlocks.html' }));
  res.json(row);
});

// ---- the queue -------------------------------------------------------------
// An approver sees what they may decide. Everyone sees their own, so you can
// tell whether your request has been dealt with without asking anybody.
router.get('/', requireAuth, (req, res) => {
  const u = me(req);
  const mine = approvableKinds(u.role, u.permissions);
  const status = req.query.status;
  let list = db.findAll('unlock_requests', r => mine.includes(r.kind) || Number(r.requestedById) === Number(u.id));
  if (status) list = list.filter(r => r.status === status);
  list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  res.json({
    requests: list.map(r => ({ ...r, canDecide: canApprove(r.kind, u.role, u.permissions) && r.status === 'pending' })),
    approvableKinds: mine,
    pending: list.filter(r => r.status === 'pending' && mine.includes(r.kind)).length,
  });
});

// ---- decide ----------------------------------------------------------------
router.post('/:id/approve', requireAuth, (req, res) => {
  const row = db.findById('unlock_requests', Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Request not found.' });
  if (row.status !== 'pending') return res.status(400).json({ error: `This request was already ${row.status}.` });
  const u = me(req);
  if (!canApprove(row.kind, u.role, u.permissions)) {
    return res.status(403).json({ error: 'This kind of request is not yours to decide.' });
  }
  const k = kind(row.kind);
  const rec = k.find(row.target);
  if (!rec) return res.status(404).json({ error: 'The thing being unlocked has gone.' });
  if (!k.isLocked(rec)) {
    db.update('unlock_requests', row.id, { status: 'moot', decidedBy: u.name, decidedAt: new Date().toISOString() });
    return res.status(400).json({ error: 'It is already open — nothing to do.' });
  }

  // Only a timed kind takes a window; the rest unlock and are re-locked by
  // their owner when the correction is done.
  let expiresAt = null, mode = null;
  if (k.timed) {
    const win = resolveWindow(req.body.window, row.target.year, row.target.quarter);
    if (win.error) return res.status(400).json({ error: win.error });
    expiresAt = win.expiresAt; mode = win.mode;
  }
  k.open(rec, { expiresAt, mode, actorName: u.name, reason: row.reason });

  const saved = db.update('unlock_requests', row.id, {
    status: 'approved', decidedBy: u.name, decidedAt: new Date().toISOString(), expiresAt, window: mode,
  });
  logActivity({ ...actor(req), action: `APPROVED reopening of ${k.label.toLowerCase()} (${row.label})`, entityType: 'unlock_request', entityId: row.id, entityLabel: row.label });
  notifyUser(db.findById('users', row.requestedById), 'Your request was approved',
    `${u.name} reopened ${k.label.toLowerCase()} (${row.label})${expiresAt ? ` until ${new Date(expiresAt).toLocaleString('en-GB')}` : ''}. Make the correction and confirm it again.`,
    { url: '/' });
  res.json(saved);
});

router.post('/:id/decline', requireAuth, (req, res) => {
  const row = db.findById('unlock_requests', Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Request not found.' });
  if (row.status !== 'pending') return res.status(400).json({ error: `This request was already ${row.status}.` });
  const u = me(req);
  if (!canApprove(row.kind, u.role, u.permissions)) {
    return res.status(403).json({ error: 'This kind of request is not yours to decide.' });
  }
  const why = String(req.body.reason || '').trim();
  const saved = db.update('unlock_requests', row.id, {
    status: 'declined', decidedBy: u.name, decidedAt: new Date().toISOString(), declineReason: why || null,
  });
  logActivity({ ...actor(req), action: `Declined reopening of ${kind(row.kind).label.toLowerCase()} (${row.label})`, entityType: 'unlock_request', entityId: row.id, entityLabel: row.label });
  notifyUser(db.findById('users', row.requestedById), 'Your request was declined',
    `${u.name} declined reopening ${kind(row.kind).label.toLowerCase()} (${row.label})${why ? `: ${why}` : '.'}`,
    { url: '/unlocks.html' });
  res.json(saved);
});

module.exports = router;
