// AOTC Track — QR check-in (Phase 11).
// Named check-ins at services (clerk/admin) and group meetings (group
// accounts), by camera QR scan or manual name search. Headcount entry
// remains the source for report figures; check-ins add the per-person record.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const QRCode = require('qrcode');
const db = require('../utils/db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { buildCardSheet } = require('../utils/memberCards');
const { ensureIdentity } = require('../utils/memberIdentity');

const { actor, userEntity, isClerkOrAdmin } = require('../utils/scope');
function contextKey(ctx) {
  if (ctx.type === 'service') return `service:${ctx.date}:${ctx.service || 'joint'}`;
  if (ctx.meetingId) return `gmtg:${ctx.meetingId}`;          // meeting-based group check-in
  return `group:${ctx.entityId}:${ctx.date}`;                 // legacy date-based fallback
}
function canScan(req, ctx) {
  if (ctx.type === 'service') return isClerkOrAdmin(req);
  // For a meeting, the owning group comes from the meeting itself (a group
  // can't check into another group's meeting by spoofing entityId).
  let entityId = ctx.entityId;
  if (ctx.meetingId) { const m = db.findById('group_meetings', Number(ctx.meetingId)); if (m) entityId = m.entityId; }
  const ent = userEntity(req);
  return ['admin', 'localadmin'].includes(req.user.role) || (ent && ent.type === 'group' && Number(ent.id) === Number(entityId));
}
// Who may create/manage a group's meetings: admins, the Clerk, or that group.
function canManageMeeting(req, entityId) {
  if (isClerkOrAdmin(req)) return true;
  const ent = userEntity(req);
  return !!(ent && ent.type === 'group' && Number(ent.id) === Number(entityId));
}
// (member number + QR token assignment lives in utils/memberIdentity.js)

// ---- Card sheets ----
router.get('/cards.pdf', requireAuth, async (req, res) => {
  const { entityType, entityId } = req.query;
  const ent = userEntity(req);
  const own = ent && ent.type === entityType && Number(ent.id) === Number(entityId);
  // Admins, local admins, roster managers (roster.manage), or the entity's own
  // account may print its cards (the cards are just QR tokens, not sensitive).
  const u = db.findById('users', req.user.id) || {};
  const privileged = ['admin', 'localadmin'].includes(req.user.role) || (u.permissions || []).includes('roster.manage');
  if (!privileged && !own) return res.status(403).json({ error: 'You can only print cards for your own committee or group.' });
  let members = db.findAll('members', m => m.entityType === entityType && Number(m.entityId) === Number(entityId));
  if (!members.length) return res.status(404).json({ error: 'No members found.' });
  members = members.map(ensureIdentity);
  const rec = db.findById(entityType === 'committee' ? 'committees' : 'groups', Number(entityId));
  const buf = await buildCardSheet({ members, entityName: rec ? rec.name : '' });
  logActivity({ ...actor(req), action: `Generated ${members.length} member QR cards`, entityType: 'checkin', entityId: Number(entityId), entityLabel: rec ? rec.name : '' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${(rec ? rec.name : 'members').replace(/\s+/g, '_')}_QR_cards.pdf"`);
  res.send(buf);
});

// ---- Scan / manual check-in ----
function doCheckin(req, res, member, ctx) {
  const key = contextKey(ctx);
  const existing = db.findOne('checkins', c => c.memberId === member.id && c.key === key);
  if (existing) return res.json({ ok: true, already: true, name: member.name });
  const rec = db.insert('checkins', {
    memberId: member.id, name: member.name,
    entityType: member.entityType, entityId: member.entityId,
    key, context: ctx, date: ctx.date,
    at: new Date().toISOString(), by: actor(req).userName,
  });
  res.json({ ok: true, already: false, name: member.name, id: rec.id });
}

router.post('/scan', requireAuth, requirePermission('attendance.manage'), (req, res) => {
  const { code, context } = req.body;
  if (!context || !context.date) return res.status(400).json({ error: 'Missing check-in context.' });
  if (!canScan(req, context)) return res.status(403).json({ error: 'You cannot check people in for this context.' });
  const m = String(code || '').match(/^AOTC:(\d+):([a-f0-9]+)$/i);
  if (!m) return res.status(400).json({ error: 'Not an AOTC member card.' });
  const member = db.findById('members', Number(m[1]));
  if (!member || member.qrToken !== m[2]) return res.status(404).json({ error: 'Card not recognised — reprint may be needed.' });
  doCheckin(req, res, member, context);
});

router.post('/manual', requireAuth, requirePermission('attendance.manage'), (req, res) => {
  const { memberId, memberNo, context } = req.body;
  if (!context || !context.date) return res.status(400).json({ error: 'Missing check-in context.' });
  if (!canScan(req, context)) return res.status(403).json({ error: 'You cannot check people in for this context.' });
  // Look up by database id (name-search fallback) or by the member's printed
  // number (for people who've forgotten their card).
  let member = null;
  if (memberId) member = db.findById('members', Number(memberId));
  else if (memberNo != null && String(memberNo).trim()) {
    const wanted = String(memberNo).trim();
    member = db.findOne('members', m => String(m.memberNo) === wanted);
  }
  if (!member) return res.status(404).json({ error: memberNo ? 'No member found with that number.' : 'Member not found.' });
  // Group accounts may only check in their own roster by number; clerks/admins
  // (who run service check-in) are unrestricted.
  if (!isClerkOrAdmin(req)) {
    const ent = userEntity(req);
    if (!ent || member.entityType !== ent.type || Number(member.entityId) !== Number(ent.id)) {
      return res.status(403).json({ error: 'That number is not in your roster.' });
    }
  }
  doCheckin(req, res, member, context);
});

// Look up a member by their printed number WITHOUT checking them in, so the
// operator can confirm identity (name + photo) before it counts.
router.post('/lookup', requireAuth, requirePermission('attendance.manage'), (req, res) => {
  const { memberNo, context } = req.body;
  if (!context) return res.status(400).json({ error: 'Missing check-in context.' });
  if (!canScan(req, context)) return res.status(403).json({ error: 'You cannot check people in for this context.' });
  const wanted = String(memberNo == null ? '' : memberNo).trim();
  if (!wanted) return res.status(400).json({ error: 'Enter a member number.' });
  const member = db.findOne('members', m => String(m.memberNo) === wanted);
  if (!member) return res.status(404).json({ error: 'No member found with that number.' });
  if (!isClerkOrAdmin(req)) {
    const ent = userEntity(req);
    if (!ent || member.entityType !== ent.type || Number(member.entityId) !== Number(ent.id)) {
      return res.status(403).json({ error: 'That number is not in your roster.' });
    }
  }
  const already = !!db.findOne('checkins', c => c.memberId === member.id && c.key === contextKey(context));
  res.json({ id: member.id, name: member.name, position: member.position || 'Member', hasPhoto: !!member.photoFile, already });
});

// ---- Personal card page data (PUBLIC — the qrToken in the link IS the secret,
// exactly like holding the paper card; no login/account needed). Powers
// /card.html so a member can show their QR from their own phone. ----
router.get('/card', async (req, res) => {
  const token = String(req.query.t || '').trim();
  if (!token) return res.status(400).json({ error: 'Missing card token.' });
  const member = db.findOne('members', m => m.qrToken && m.qrToken === token);
  if (!member) return res.status(404).json({ error: 'Card not found. Ask your committee/group head to re-share your link.' });
  const rec = db.findById(member.entityType === 'committee' ? 'committees' : 'groups', Number(member.entityId));
  let qr = '';
  try { qr = await QRCode.toDataURL(`AOTC:${member.id}:${member.qrToken}`, { margin: 1, width: 320 }); } catch (e) {}
  res.json({
    name: member.name,
    memberNo: member.memberNo || null,
    position: member.position || 'Member',
    entityName: rec ? rec.name : '',
    qr,
  });
});

// ---- Group meetings ----
// A group creates a meeting (date + label, e.g. "Men's Fellowship — Mon eve")
// BEFORE check-in; the Check-in page then picks it and check-ins roll up to it.
router.get('/meetings', requireAuth, (req, res) => {
  const entityId = Number(req.query.entityId);
  if (!entityId) return res.json([]);
  if (!canManageMeeting(req, entityId)) return res.status(403).json({ error: 'Not your group.' });
  const list = db.findAll('group_meetings', m => Number(m.entityId) === entityId)
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || '').localeCompare(a.createdAt || ''));
  res.json(list.slice(0, 60));
});
router.post('/meetings', requireAuth, (req, res) => {
  const { entityId, date, label, time } = req.body;
  if (!entityId || !date) return res.status(400).json({ error: 'Group and date are required.' });
  if (!canManageMeeting(req, Number(entityId))) return res.status(403).json({ error: 'You can only create meetings for your own group.' });
  const rec = db.insert('group_meetings', {
    entityId: Number(entityId), date: String(date),
    label: String(label || 'Meeting').trim() || 'Meeting', time: String(time || '').trim(),
    createdBy: actor(req).userName,
  });
  logActivity({ ...actor(req), action: 'Created group meeting', entityType: 'group_meeting', entityId: rec.id, entityLabel: `${rec.label} ${rec.date}` });
  res.json(rec);
});
// Correct a group meeting's date/label/time (e.g. created with the wrong date).
router.put('/meetings/:id', requireAuth, (req, res) => {
  const rec = db.findById('group_meetings', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Meeting not found.' });
  if (!canManageMeeting(req, rec.entityId)) return res.status(403).json({ error: 'Not your group.' });
  const patch = {};
  if (req.body.date !== undefined && req.body.date) patch.date = String(req.body.date);
  if (req.body.label !== undefined) patch.label = String(req.body.label).trim() || 'Meeting';
  if (req.body.time !== undefined) patch.time = String(req.body.time).trim();
  const updated = db.update('group_meetings', rec.id, patch);
  logActivity({ ...actor(req), action: 'Updated group meeting', entityType: 'group_meeting', entityId: rec.id, entityLabel: `${updated.label} ${updated.date}` });
  res.json(updated);
});
router.delete('/meetings/:id', requireAuth, (req, res) => {
  const rec = db.findById('group_meetings', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Meeting not found.' });
  if (!canManageMeeting(req, rec.entityId)) return res.status(403).json({ error: 'Not your group.' });
  // Don't silently discard check-ins already recorded against this meeting.
  const checkins = db.findAll('checkins', c => c.key === `gmtg:${rec.id}`);
  if (checkins.length) {
    return res.status(400).json({ error: `${checkins.length} person(s) already checked in to this meeting — it cannot be removed.` });
  }
  db.remove('group_meetings', rec.id);
  logActivity({ ...actor(req), action: 'Removed group meeting', entityType: 'group_meeting', entityId: rec.id, entityLabel: `${rec.label} ${rec.date}`, snapshot: rec });
  res.json({ ok: true });
});

// Live tally for a meeting: counts checked-in members, split by their Male/
// Female field. Informational only — the official figures stay the manually
// entered ones (per the "keep both separate" decision).
router.get('/meeting-tally', requireAuth, (req, res) => {
  const meetingId = Number(req.query.meetingId);
  const m = meetingId && db.findById('group_meetings', meetingId);
  if (!m) return res.status(404).json({ error: 'Meeting not found.' });
  if (!canScan(req, { type: 'group', meetingId })) return res.status(403).json({ error: 'Not your group.' });
  const rows = db.findAll('checkins', c => c.key === `gmtg:${meetingId}`);
  let male = 0, female = 0, unknown = 0;
  for (const c of rows) {
    const mem = db.findById('members', c.memberId);
    if (mem && mem.sex === 'male') male++;
    else if (mem && mem.sex === 'female') female++;
    else unknown++;
  }
  res.json({ total: rows.length, male, female, unknown });
});

// ---- Lists ----
router.get('/list', requireAuth, (req, res) => {
  const ctx = { type: req.query.type, date: req.query.date, service: req.query.service, entityId: req.query.entityId, meetingId: req.query.meetingId };
  if (!canScan(req, ctx) && !isClerkOrAdmin(req)) return res.status(403).json({ error: 'Not your context.' });
  const key = contextKey(ctx);
  res.json(db.findAll('checkins', c => c.key === key).sort((a, b) => (b.at || '').localeCompare(a.at || '')));
});

// members for manual fallback (scoped: groups get own roster; clerk/admin get all)
router.get('/members-lite', requireAuth, requirePermission('attendance.manage'), (req, res) => {
  let list = db.findAll('members');
  if (!isClerkOrAdmin(req)) {
    const ent = userEntity(req);
    if (!ent) return res.json([]);
    list = list.filter(m => m.entityType === ent.type && Number(m.entityId) === Number(ent.id));
  }
  res.json(list.map(m => ({ id: m.id, name: m.name, entity: m.entityType })));
});

module.exports = router;
