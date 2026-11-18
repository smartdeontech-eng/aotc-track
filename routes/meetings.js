// AOTC Track — Meetings module (Phase 6).
// Scheduling with venue + shared-member conflict detection (first-in
// priority), locked attendance capture, and PDF-only minutes upload.
const express = require('express');
const router = express.Router();

// How long the person who recorded a meeting's attendance may go back and fix
// it themselves before a reopening has to be requested. Long enough to catch
// the mistake you notice on the way home; short enough that the record settles.
const SELF_CORRECT_HOURS = 12;
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../utils/db');
const { activeUsers } = require('../utils/accountStatus');
const { toLocalDate } = require('../utils/dates');
const { requireAuth, requirePermission, canManageAllEntities } = require('../middleware/auth');
const { sendPushToEntityUsers, sendPushByContacts } = require('../utils/push');
const { sendMail } = require('../utils/mailer');
const { buildMinutesTemplate } = require('../utils/minutesDocx');
const { buildSessionMinutesDocx } = require('../utils/sessionDocx');
const { buildSessionMinutesPdf } = require('../utils/sessionMinutesPdf');
const { buildActionPointsPdf } = require('../utils/actionPointsPdf');

// Every meeting communication goes out on all channels: a SHORT SMS to the
// roster phones, PUSH to the entity's account holders + matching accounts,
// and (when an email body is supplied, e.g. the full agenda) EMAIL to the
// roster + account holders. SMS deliberately stays short — the agenda body
// travels by push/email, never SMS.
function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function meetingEmailHtml(rec, whenStr, whereStr) {
  return `<div style="font-family:system-ui,Arial,sans-serif;">
    <h2 style="color:#1D3F94; margin:0 0 4px;">${esc(rec.entityName)} — ${esc(rec.title)}</h2>
    <p style="margin:0 0 12px; color:#444;"><b>${esc(whenStr)} at ${esc(rec.time)}</b> · ${esc(whereStr)}${rec.link ? ` · <a href="${esc(rec.link)}">join link</a>` : ''}</p>
    <h3 style="margin:0 0 4px;">Agenda</h3>
    <div style="white-space:pre-wrap; background:#F3F6FC; border-left:3px solid #1D3F94; padding:10px 14px; border-radius:6px;">${esc(rec.agenda) || '—'}</div>
    <p style="color:#889; font-size:12px; margin-top:16px;">— AOTC Track, PCG Adabraka Official Town Congregation</p>
  </div>`;
}

// Notify the committee/group HEAD when members hit the absence flag.
async function notifyHeadOfAbsences(rec, memberIds, th) {
  const { sendPushToUser } = require('../utils/push');
  const names = memberIds
    .map(id => (db.findById('members', id) || {}).name)
    .filter(Boolean);
  if (!names.length) return;
  const list = names.join(', ');
  const msg = `PCG-AOTC: Attendance alert — ${list} ${names.length === 1 ? 'has' : 'have'} now missed ${th} consecutive ${rec.entityName} meetings without apology. Kindly follow up.`;
  // The head is the entity's login-account holder(s) plus the signatory head.
  const heads = activeUsers(u => u.entity && u.entity.type === rec.entityType && Number(u.entity.id) === Number(rec.entityId));
  for (const h of heads) {
    if (h.phone) await sendSms({ to: h.phone, message: msg }).catch(() => {});
    if (h.email) await sendMail({ to: h.email, subject: `Attendance alert — ${rec.entityName}`, html: `<p>${esc(msg)}</p>` }).catch(() => {});
    sendPushToUser(h.id, { title: `Attendance alert — ${rec.entityName}`, body: msg, url: '/meetings.html' }).catch(() => {});
  }
  // Also SMS the signatory head's phone if on file and not already a user.
  const sig = (db.findById(rec.entityType === 'committee' ? 'committees' : 'groups', rec.entityId) || {}).signatories || {};
  const headPhone = sig.head && sig.head.phone;
  if (headPhone) await sendSms({ to: headPhone, message: msg }).catch(() => {});
  logActivity({ userId: 0, userName: 'System', action: `Absence alert sent to ${rec.entityName} head: ${list}`, entityType: 'meeting', entityId: rec.id, entityLabel: rec.entityName });
}

async function notifyMeetingAudience(rec, title, smsMsg, opts = {}) {
  const roster = resolveMeetingRoster(rec);
  const phones = roster.map(x => x.phone).filter(Boolean);
  const emails = roster.map(x => x.email).filter(Boolean);
  // Also include this committee/group's login-account holders' emails.
  activeUsers(u => u.entity && u.entity.type === rec.entityType && Number(u.entity.id) === Number(rec.entityId))
    .forEach(u => { if (u.email) emails.push(u.email); });
  const pushBody = opts.pushBody || smsMsg;
  for (const p of phones.slice(0, 60)) await sendSms({ to: p, message: smsMsg }).catch(() => {});
  if (opts.emailSubject && opts.emailHtml) {
    for (const e of [...new Set(emails)].slice(0, 80)) await sendMail({ to: e, subject: opts.emailSubject, html: opts.emailHtml }).catch(() => {});
  }
  sendPushToEntityUsers(rec.entityType, rec.entityId, { title, body: pushBody, url: '/meetings.html' }).catch(() => {});
  sendPushByContacts({ phones, emails }, { title, body: pushBody, url: '/meetings.html' }).catch(() => {});
}
const { logActivity } = require('../utils/activityLog');
const { sendSms } = require('../utils/sms');

const MINUTES_DIR = path.join(__dirname, '..', 'minutes');
if (!fs.existsSync(MINUTES_DIR)) fs.mkdirSync(MINUTES_DIR, { recursive: true });

const { actor, userEntity, isAdmin, canViewAll } = require('../utils/scope');
const { sortGroups } = require('../utils/groupOrder');
function resolveEntity(req) {
  // Reading across entities needs congregation.view; WRITING for another
  // entity (scheduling on its behalf) needs admin, the Session Clerk
  // (approvals.manage) or the Reporting Coordinator (congregation.manage).
  const clerkish = () => ((db.findById('users', req.user.id) || {}).permissions || []).includes('approvals.manage');
  const crossEntity = req.method === 'GET' ? canViewAll(req) : (canManageAllEntities(req) || clerkish());
  if (crossEntity) {
    const type = req.query.entityType || (req.body && req.body.entityType);
    const id = req.query.entityId !== undefined ? req.query.entityId : (req.body && req.body.entityId);
    if (type && id !== undefined) return { type, id: Number(id) };
  }
  const ent = userEntity(req);
  return ent && ent.type !== 'congregation' ? { type: ent.type, id: Number(ent.id) } : null;
}
function entityName(type, id) {
  const rec = db.findById(type === 'committee' ? 'committees' : 'groups', Number(id));
  return rec ? rec.name : '';
}
// The Session Clerk (approvals.manage) counts as a cross-entity manager for
// congregation-wide meetings, alongside admins and the Reporting Coordinator.
function clerkish(req) {
  return ((db.findById('users', req.user.id) || {}).permissions || []).includes('approvals.manage');
}
function canManageCongregation(req) { return canManageAllEntities(req) || clerkish(req); }
function isLeader(m) { return (m.position || 'Member') !== 'Member'; }
// A friendly label for a congregation-wide meeting's audience (used in the
// meeting list, announcements and minutes header).
function congregationLabel(audience, ents) {
  if (audience === 'leaders') return 'Leadership (all office-holders)';
  if (audience === 'custom') {
    const names = (ents || []).map(e => entityName(e.type, e.id)).filter(Boolean);
    return names.length ? `Congregation — ${names.join(', ')}` : 'Congregation-wide';
  }
  return 'Whole Congregation';
}
// Resolve the list of members whose attendance is taken for a meeting.
//   • committee meeting  -> that committee's full roster
//   • group / executive  -> that group's office-holders only
//   • congregation 'all' -> every member across all committees & groups
//   • congregation 'leaders' -> office-holders across all entities
//   • congregation 'custom'  -> members of the chosen committees/groups
// Congregation rosters are de-duplicated by name (a person sitting on several
// committees is one row), so an orientation list shows each person once.
function resolveMeetingRoster(rec) {
  if (rec.entityType === 'congregation') {
    const audience = rec.audience || 'all';
    let list = db.findAll('members', m => m.entityType === 'committee' || m.entityType === 'group');
    if (audience === 'leaders') list = list.filter(isLeader);
    else if (audience === 'custom') {
      const set = new Set((rec.audienceEntities || []).map(e => `${e.type}:${Number(e.id)}`));
      list = list.filter(m => set.has(`${m.entityType}:${Number(m.entityId)}`));
    }
    const seen = new Set(); const out = [];
    for (const m of list) {
      const k = (m.name || '').trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k); out.push(m);
    }
    return out.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }
  let list = db.findAll('members', x => x.entityType === rec.entityType && Number(x.entityId) === Number(rec.entityId));
  if (rec.kind === 'executive') list = list.filter(isLeader);
  return list;
}
// May this user schedule/edit/record/minute THIS meeting?
function canManageMeeting(req, rec) {
  if (rec.entityType === 'congregation') return canManageCongregation(req);
  if (canManageAllEntities(req)) return true;
  const ent = userEntity(req);
  return !!(ent && ent.type === rec.entityType && Number(ent.id) === Number(rec.entityId));
}
function quarterOf(dateStr) { return Math.floor(new Date(dateStr).getMonth() / 3) + 1; }
function num(v) { return v === '' || v === null || v === undefined ? 0 : Number(v) || 0; }

// A group holds two different kinds of meeting:
//   • EXECUTIVE — its office-holders. A named roll, because who came is what
//     drives quorum and the absence flags.
//   • GENERAL   — the whole membership. A headcount, because nobody is ticking
//     eighty names, and the useful number is the total.
// A committee only ever meets as its full membership, so it is always a named
// roll. Congregation-wide meetings likewise.
function isHeadcountMeeting(rec) {
  return !!rec && rec.entityType === 'group' && rec.kind === 'general';
}
function overlap(m, date, startMins, endMins) {
  if (m.date !== date) return false;
  const s = toMins(m.time), e = s + (m.durationMins || 60);
  return s < endMins && startMins < e;
}
function toMins(t) { const [h, m] = String(t || '0:0').split(':').map(Number); return h * 60 + (m || 0); }

// ---- Venues (admin-managed) ----
router.get('/venues', requireAuth, (req, res) => res.json(
  db.findAll('venues').filter(v => v.active !== false).sort((a, b) => (a.name || '').localeCompare(b.name || ''))));
router.post('/venues', requireAuth, requirePermission('setup.venues'), (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Venue name required.' });
  const rec = db.insert('venues', { name, active: true });
  logActivity({ ...actor(req), action: 'Added venue', entityType: 'venue', entityId: rec.id, entityLabel: name });
  res.json(rec);
});
// Rename a venue. Meetings snapshot venueName at save time, so past meetings
// keep the name they were booked under — this only affects future bookings.
router.put('/venues/:id', requireAuth, requirePermission('setup.venues'), (req, res) => {
  const rec = db.findById('venues', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Venue not found.' });
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Venue name required.' });
  const updated = db.update('venues', rec.id, { name });
  logActivity({ ...actor(req), action: 'Renamed venue', entityType: 'venue', entityId: rec.id, entityLabel: `${rec.name} → ${name}` });
  res.json(updated);
});
router.delete('/venues/:id', requireAuth, requirePermission('setup.venues'), (req, res) => {
  const rec = db.findById('venues', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Venue not found.' });
  db.update('venues', rec.id, { active: false });
  res.json({ ok: true });
});

// ---- Conflict check (also used standalone before saving) ----
function findConflicts({ date, time, durationMins, venueId, entityType, entityId, excludeMeetingId }) {
  const startM = toMins(time), endM = startM + (Number(durationMins) || 60);
  const others = db.findAll('meetings', m => m.id !== excludeMeetingId && m.status !== 'cancelled' && overlap(m, date, startM, endM));
  const venueClash = venueId ? others.find(m => Number(m.venueId) === Number(venueId)) : null;

  const myRoster = db.findAll('members', x => x.entityType === entityType && Number(x.entityId) === Number(entityId));
  const myNames = new Set(myRoster.map(m => m.name.trim().toLowerCase()));
  const memberClashes = [];
  others.forEach(m => {
    if (m.entityType === entityType && Number(m.entityId) === Number(entityId)) return;
    const theirRoster = db.findAll('members', x => x.entityType === m.entityType && Number(x.entityId) === Number(m.entityId));
    const shared = theirRoster.filter(x => myNames.has(x.name.trim().toLowerCase()));
    if (shared.length) {
      memberClashes.push({
        meetingId: m.id, with: m.entityName || entityName(m.entityType, m.entityId),
        time: m.time, venue: m.venueName || '',
        members: [...new Set(shared.map(x => x.name))],
      });
    }
  });
  return { venueClash: venueClash ? { meetingId: venueClash.id, with: venueClash.entityName, time: venueClash.time, venue: venueClash.venueName } : null, memberClashes };
}

router.post('/check-conflicts', requireAuth, requirePermission('meetings.manage'), (req, res) => {
  const ent = resolveEntity(req);
  if (!ent) return res.status(403).json({ error: 'Your account is not attached to a committee or group.' });
  const { date, time, durationMins, venueId } = req.body;
  if (!date || !time) return res.status(400).json({ error: 'Date and time are required.' });
  res.json(findConflicts({ date, time, durationMins, venueId, entityType: ent.type, entityId: ent.id }));
});

// ---- Meetings CRUD ----
router.get('/', requireAuth, (req, res) => {
  let list = db.findAll('meetings', m => m.status !== 'cancelled');
  if (!canViewAll(req)) {
    const ent = userEntity(req);
    // Everyone sees congregation-wide meetings (orientations etc.); scoped
    // users additionally see their own committee/group's meetings.
    list = list.filter(m => m.entityType === 'congregation' ||
      (ent && m.entityType === ent.type && Number(m.entityId) === Number(ent.id)));
  } else if (req.query.entityType && req.query.entityId) {
    list = list.filter(m => m.entityType === req.query.entityType && Number(m.entityId) === Number(req.query.entityId));
  }
  res.json(list.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)));
});

router.post('/', requireAuth, requirePermission('meetings.manage'), async (req, res) => {
  // A meeting is either scoped to one committee/group (the default) or is a
  // congregation-wide gathering (orientations, a leaders' meeting, etc.).
  const isCongregation = req.body.scope === 'congregation';
  let ent, audience = null, audienceEntities = null;
  if (isCongregation) {
    if (!canManageCongregation(req)) {
      return res.status(403).json({ error: 'Only an administrator, the Session Clerk or the Reporting Coordinator can schedule a congregation-wide meeting.' });
    }
    audience = ['all', 'leaders', 'custom'].includes(req.body.audience) ? req.body.audience : 'all';
    if (audience === 'custom') {
      audienceEntities = (Array.isArray(req.body.audienceEntities) ? req.body.audienceEntities : [])
        .map(e => ({ type: e && e.type === 'group' ? 'group' : 'committee', id: Number(e && e.id) }))
        .filter(e => e.id);
      if (!audienceEntities.length) return res.status(400).json({ error: 'Choose at least one committee or group for this meeting.' });
    }
    ent = { type: 'congregation', id: 0 };
  } else {
    ent = resolveEntity(req);
    if (!ent) return res.status(403).json({ error: 'Your account is not attached to a committee or group.' });
  }
  const { title, date, time, durationMins, venueId, kind, proceedAnyway, mode, link, agenda } = req.body;
  if (!date || !time) return res.status(400).json({ error: 'Date and time are required.' });
  const meetingMode = ['online', 'hybrid'].includes(mode) ? mode : 'in-person';
  // A meeting dated in the past is a RETROSPECTIVE record — it already
  // happened. It's saved as "held" straight away (so minutes can be uploaded
  // for it), with no conflict checks and no announcements to members.
  const isPast = new Date(`${date}T${time}:00`) < new Date();
  // Every UPCOMING meeting must carry an agenda (it's communicated to all).
  // Past "record only" meetings don't need one — they already happened.
  if (!isPast && !String(agenda || '').trim()) {
    return res.status(400).json({ error: 'An agenda is required for a scheduled meeting — it is sent to everyone invited.' });
  }
  // Online meetings have no venue, so no venue clash is possible for them.
  const effectiveVenueId = meetingMode === 'online' ? null : venueId;
  const conflicts = isPast ? { venueClash: null, memberClashes: [] }
    : findConflicts({ date, time, durationMins, venueId: effectiveVenueId, entityType: ent.type, entityId: ent.id });
  const hasConflict = conflicts.venueClash || conflicts.memberClashes.length;
  if (hasConflict && !proceedAnyway) {
    return res.status(409).json({ error: 'conflicts', conflicts });
  }
  const venue = effectiveVenueId ? db.findById('venues', Number(effectiveVenueId)) : null;
  const rec = db.insert('meetings', {
    entityType: ent.type, entityId: Number(ent.id),
    entityName: isCongregation ? congregationLabel(audience, audienceEntities) : entityName(ent.type, ent.id),
    title: String(title || (isCongregation ? 'Congregation meeting' : kind === 'executive' ? 'Executive meeting' : 'Meeting')).trim(),
    date, time, durationMins: Number(durationMins) || 60,
    venueId: venue ? venue.id : null, venueName: venue ? venue.name : (meetingMode === 'online' ? 'Online' : ''),
    mode: meetingMode, link: String(link || '').trim(),
    agenda: String(agenda || '').trim(),
    // Committees hold Committee Meetings (full roster); groups hold Executive
    // Meetings (office-holders only); congregation-wide meetings carry an
    // audience (all / leaders / chosen entities) — the type follows the scope.
    // Groups choose; committees have only one kind. Defaulting a group to
    // 'executive' keeps every meeting scheduled before this existed correct.
    kind: isCongregation ? 'congregation'
      : ent.type === 'group' ? (req.body.kind === 'general' ? 'general' : 'executive')
      : 'general',
    audience: isCongregation ? audience : null,
    audienceEntities: isCongregation && audience === 'custom' ? audienceEntities : null,
    year: new Date(date).getFullYear(), quarter: quarterOf(date),
    status: isPast ? 'held' : 'scheduled',
    attendance: null, minutes: null,
    conflicts: hasConflict ? conflicts : null,
    createdBy: actor(req).userName,
  });
  logActivity({ ...actor(req), action: `Scheduled meeting${hasConflict ? ' (with conflicts)' : ''}`, entityType: 'meeting', entityId: rec.id, entityLabel: `${rec.entityName} ${date} ${time}` });

  // Announce the new meeting to the people it concerns: SMS to the roster
  // (executives only for group/executive meetings) and push to this
  // committee/group's account holders. Best-effort — never blocks scheduling.
  // Retrospective records (past meetings) are never announced.
  if (!isPast) try {
    const whenStr = toLocalDate(date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const whereStr = rec.mode === 'online' ? `online${rec.link ? ': ' + rec.link : ''}` : (rec.venueName || 'venue TBA');
    const announceMsg = `PCG-AOTC: New meeting — ${rec.entityName} ${rec.title} on ${whenStr} at ${time}, ${whereStr}. See the app for the agenda.`;
    await notifyMeetingAudience(rec, `New meeting: ${rec.title}`, announceMsg, {
      pushBody: `${rec.entityName} ${rec.title} — ${whenStr} at ${time}, ${whereStr}.\nAgenda: ${rec.agenda}`,
      emailSubject: `Meeting: ${rec.title} — ${whenStr} at ${time}`,
      emailHtml: meetingEmailHtml(rec, whenStr, whereStr),
    });
  } catch (e) { console.error('[meetings] schedule announcement failed:', e.message); }

  // proceed-anyway notifications: courtesy to the first meeting's entity + affected members (best-effort SMS)
  if (hasConflict) {
    try {
      const msgs = [];
      (conflicts.memberClashes || []).forEach(c => {
        c.members.forEach(name => {
          const recs = db.findAll('members', x => x.name.trim().toLowerCase() === name.trim().toLowerCase() && x.phone);
          const phone = recs.length ? recs[0].phone : null;
          if (phone) msgs.push({ to: phone, message:
            `PCG-AOTC: You have two meetings clashing on ${date} at ${time}: ${c.with} and ${rec.entityName} (${rec.venueName || 'venue TBA'}). Kindly decide which to attend.` });
        });
      });
      for (const m of msgs.slice(0, 25)) {
        await sendSms(m).catch(() => {});
        sendPushByContacts({ phones: [m.to] }, { title: 'Meeting clash', body: m.message, url: '/meetings.html' }).catch(() => {});
      }
    } catch (e) { console.error('[meetings] clash notifications failed:', e.message); }
  }
  res.json(rec);
});

// Edit a meeting that hasn't happened yet. Any change to when/where is
// announced to the same people who heard about the original scheduling.
router.put('/:id', requireAuth, requirePermission('meetings.manage'), async (req, res) => {
  const rec = db.findById('meetings', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Meeting not found.' });
  if (!canManageMeeting(req, rec)) {
    return res.status(403).json({ error: 'You can only manage your own meetings.' });
  }
  if (rec.status !== 'scheduled') {
    return res.status(400).json({ error: 'Only meetings that have not yet come off can be edited.' });
  }
  if (rec.attendance && rec.attendance.locked) {
    return res.status(400).json({ error: 'Attendance has been recorded and locked for this meeting.' });
  }
  const { title, date, time, durationMins, venueId, mode, link, proceedAnyway, agenda } = req.body;
  const newDate = date || rec.date;
  const newTime = time || rec.time;
  const newMode = ['online', 'hybrid', 'in-person'].includes(mode) ? mode : rec.mode;
  const effectiveVenueId = newMode === 'online' ? null : (venueId !== undefined ? venueId : rec.venueId);
  // Re-check clashes at the new slot (ignoring this meeting itself).
  const conflicts = findConflicts({
    date: newDate, time: newTime, durationMins: Number(durationMins) || rec.durationMins,
    venueId: effectiveVenueId, entityType: rec.entityType, entityId: rec.entityId,
    excludeMeetingId: rec.id,
  });
  const hasConflict = conflicts.venueClash || conflicts.memberClashes.length;
  if (hasConflict && !proceedAnyway) return res.status(409).json({ error: 'conflicts', conflicts });

  const venue = effectiveVenueId ? db.findById('venues', Number(effectiveVenueId)) : null;
  const newAgenda = agenda !== undefined ? String(agenda).trim() : rec.agenda;
  if (!newAgenda) return res.status(400).json({ error: 'An agenda is required for a scheduled meeting.' });
  const movedOrRelocated = newDate !== rec.date || newTime !== rec.time || newMode !== rec.mode ||
    Number(effectiveVenueId || 0) !== Number(rec.venueId || 0) || String(link || '') !== String(rec.link || '');
  const agendaChanged = newAgenda !== (rec.agenda || '');
  const updated = db.update('meetings', rec.id, {
    title: title !== undefined ? String(title).trim() : rec.title,
    date: newDate, time: newTime,
    durationMins: Number(durationMins) || rec.durationMins,
    venueId: venue ? venue.id : null,
    venueName: venue ? venue.name : (newMode === 'online' ? 'Online' : ''),
    mode: newMode, link: link !== undefined ? String(link).trim() : rec.link,
    agenda: newAgenda,
    year: new Date(newDate).getFullYear(), quarter: quarterOf(newDate),
    conflicts: hasConflict ? conflicts : null,
  });
  logActivity({ ...actor(req), action: 'Edited scheduled meeting', entityType: 'meeting', entityId: rec.id, entityLabel: `${updated.entityName} ${updated.date} ${updated.time}` });

  // Tell everyone if the details OR the agenda changed — same audience.
  if (movedOrRelocated || agendaChanged) {
    try {
      const whenStr = toLocalDate(updated.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const whereStr = updated.mode === 'online' ? `online${updated.link ? ': ' + updated.link : ''}` : (updated.venueName || 'venue TBA');
      const msg = `PCG-AOTC: UPDATED — ${updated.entityName} ${updated.title}, ${whenStr} at ${updated.time}, ${whereStr}. See the app for the latest agenda.`;
      await notifyMeetingAudience(updated, `Meeting updated: ${updated.title}`, msg, {
        pushBody: `${updated.entityName} ${updated.title} — ${whenStr} at ${updated.time}, ${whereStr}.\nAgenda: ${updated.agenda}`,
        emailSubject: `Updated meeting: ${updated.title} — ${whenStr} at ${updated.time}`,
        emailHtml: meetingEmailHtml(updated, whenStr, whereStr),
      });
    } catch (e) { console.error('[meetings] change announcement failed:', e.message); }
  }
  res.json(updated);
});

router.delete('/:id', requireAuth, requirePermission('meetings.manage'), async (req, res) => {
  const rec = db.findById('meetings', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Meeting not found.' });
  if (!canManageMeeting(req, rec)) {
    return res.status(403).json({ error: 'You can only manage your own meetings.' });
  }
  if (rec.attendance && rec.attendance.locked) return res.status(400).json({ error: 'Attendance is locked — this meeting is part of the records now.' });
  db.update('meetings', rec.id, { status: 'cancelled' });
  logActivity({ ...actor(req), action: 'Cancelled meeting', entityType: 'meeting', entityId: rec.id, entityLabel: `${rec.entityName} ${rec.date}` });
  // Tell everyone who was told it was on — but only if it was still upcoming
  // (cancelling an old/held record needs no announcement).
  const isUpcoming = rec.status === 'scheduled' && new Date(`${rec.date}T${rec.time || '09:00'}:00`) > new Date();
  if (isUpcoming) {
    try {
      const whenStr = toLocalDate(rec.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
      const msg = `PCG-AOTC: CANCELLED — ${rec.entityName} ${rec.title} that was scheduled for ${whenStr} at ${rec.time} will no longer hold.`;
      await notifyMeetingAudience(rec, `Meeting cancelled: ${rec.title}`, msg);
    } catch (e) { console.error('[meetings] cancellation notice failed:', e.message); }
  }
  res.json({ ok: true });
});

// ---- Attendance: tick present members, save -> LOCKS ----
router.post('/:id/attendance', requireAuth, requirePermission('attendance.manage'), (req, res) => {
  const rec = db.findById('meetings', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Meeting not found.' });
  if (!canManageMeeting(req, rec)) {
    return res.status(403).json({ error: 'You can only record attendance for your own meetings.' });
  }
  // SELF-CORRECT WINDOW. Attendance locks the instant it is saved, so a name
  // ticked wrongly on a phone during the meeting used to need an administrator.
  // For a few hours afterwards the person who recorded it can simply fix it —
  // no request, no approver, no phone call. After that the lock is real and a
  // reopening has to be asked for, which is the point at which somebody else
  // should be looking.
  if (rec.attendance && rec.attendance.locked) {
    const own = rec.attendance.recordedBy && rec.attendance.recordedBy === actor(req).userName;
    const at = rec.attendance.recordedAt ? new Date(rec.attendance.recordedAt) : null;
    const hrs = at ? (Date.now() - at.getTime()) / 3600000 : Infinity;
    const inWindow = own && hrs >= 0 && hrs <= SELF_CORRECT_HOURS;
    if (!inWindow) {
      return res.status(423).json({
        error: at && own
          ? `Attendance for this meeting locked ${Math.floor(hrs)} hours ago, past the ${SELF_CORRECT_HOURS}-hour window for correcting your own entry. Ask for it to be reopened.`
          : 'Attendance for this meeting is locked. Ask for it to be reopened — the Session Clerk or an admin can approve it.',
        canRequestUnlock: true, kind: 'meeting-attendance', target: { meetingId: rec.id },
      });
    }
  }

  // A group's general meeting is a headcount, and it is written to the SAME
  // place the Attendance page writes to (`group_attendance`, upserted on
  // date+group). One row per group per day however it was entered, so the Home
  // chart and the Attendance page can never disagree and nothing is counted
  // twice. No member ids are stored, so a general meeting never touches
  // anyone's absence record — see utils/attendanceStats.js.
  if (isHeadcountMeeting(rec)) {
    const group = db.findById('groups', Number(rec.entityId));
    if (!group) return res.status(404).json({ error: 'Group not found.' });
    const counts = {
      membersMale: num(req.body.membersMale), membersFemale: num(req.body.membersFemale),
      onlineMale: num(req.body.onlineMale), onlineFemale: num(req.body.onlineFemale),
    };
    const total = counts.membersMale + counts.membersFemale + counts.onlineMale + counts.onlineFemale;
    const existing = db.findOne('group_attendance', g => g.date === rec.date && Number(g.entityId) === Number(rec.entityId));
    const payload = {
      entityType: 'group', entityId: Number(rec.entityId), ownerCode: group.code, date: rec.date,
      year: new Date(rec.date).getFullYear(), quarter: quarterOf(rec.date),
      ...counts, meetingId: rec.id, enteredBy: actor(req).userName,
    };
    const log = existing ? db.update('group_attendance', existing.id, payload) : db.insert('group_attendance', payload);
    const updated = db.update('meetings', rec.id, {
      status: 'held',
      attendance: {
        locked: true, mode: 'headcount', ...counts, total,
        groupAttendanceId: log.id,
        recordedBy: actor(req).userName, recordedAt: new Date().toISOString(),
      },
    });
    logActivity({ ...actor(req), action: `Recorded general meeting attendance (${total} present)`, entityType: 'meeting', entityId: rec.id, entityLabel: `${rec.entityName} ${rec.date}` });
    return res.json(updated);
  }

  const inPersonIds = Array.isArray(req.body.presentMemberIds) ? req.body.presentMemberIds.map(Number) : [];
  const onlineIds = Array.isArray(req.body.onlinePresentMemberIds) ? req.body.onlinePresentMemberIds.map(Number) : [];
  // "Online" is a way of being present (a member joined on the link), so it
  // counts toward present everywhere — presentMemberIds holds EVERYONE present
  // (in-person + online) so existing analytics/quorum are unchanged; the online
  // subset is kept separately purely as a label for the summary and minutes.
  const ids = [...new Set([...inPersonIds, ...onlineIds])];
  const apologyIds = Array.isArray(req.body.apologyMemberIds) ? req.body.apologyMemberIds.map(Number) : [];
  // Names typed in at the meeting for people not on any roster (visitors,
  // walk-ins). They are recorded on this meeting only and never touch the
  // Members database — a person the recorder wants kept is saved separately
  // through the roster, which then gives them a normal member id.
  const cleanNames = (arr) => (Array.isArray(arr) ? arr : [])
    .map(s => String(s == null ? '' : s).trim()).filter(Boolean).slice(0, 400);
  const guestsOnline = cleanNames(req.body.guestsOnline);
  const guestsPresent = [...new Set([...cleanNames(req.body.guestsPresent), ...guestsOnline])];
  const guestsApology = cleanNames(req.body.guestsApology);
  // Everyone on the meeting's roster who is neither present nor apologising is
  // counted absent (unexcused) — computed here so the record is self-contained
  // for attendance analytics later.
  const roster = resolveMeetingRoster(rec);
  const present = new Set(ids), apology = new Set(apologyIds);
  const absentIds = roster.map(m => m.id).filter(id => !present.has(id) && !apology.has(id));
  // Meeting proceedings captured alongside attendance: the actual times and the
  // movers/seconders picked from the roster. These auto-write into the minutes
  // template; anything left blank stays a fill-in there.
  const rawProc = (req.body.proceedings && typeof req.body.proceedings === 'object') ? req.body.proceedings : {};
  const proceedings = {};
  ['commencedAt', 'constitutedAt', 'constitutedBy', 'closedAt', 'openingBy', 'minutesMovedBy', 'minutesSecondedBy', 'closureMovedBy', 'closureSecondedBy'].forEach(k => {
    const v = rawProc[k];
    if (v != null && String(v).trim()) proceedings[k] = String(v).trim().slice(0, 120);
  });
  const updated = db.update('meetings', rec.id, {
    status: 'held',
    attendance: {
      locked: true,
      presentMemberIds: ids,
      onlinePresentMemberIds: onlineIds,
      apologyMemberIds: apologyIds,
      absentMemberIds: absentIds,
      guestsPresent, guestsApology, guestsOnline,
      proceedings,
      recordedBy: actor(req).userName, recordedAt: new Date().toISOString(),
    },
  });
  const guestNote = (guestsPresent.length || guestsApology.length) ? `, +${guestsPresent.length + guestsApology.length} added by name` : '';
  logActivity({ ...actor(req), action: `Recorded attendance — ${ids.length} present, ${apologyIds.length} apology, ${absentIds.length} absent${guestNote} (LOCKED)`, entityType: 'meeting', entityId: rec.id, entityLabel: `${rec.entityName} ${rec.date}` });

  // Absence flagging: any member whose trailing consecutive no-apology absence
  // streak just reached the threshold gets escalated to the committee/group
  // HEAD (Coordinator/Chairperson/President) via push + email + SMS. This is a
  // committee/group discipline signal, so it never runs for congregation-wide
  // meetings (missing an orientation isn't a committee-attendance offence).
  if (rec.entityType !== 'congregation') try {
    const { consecutiveAbsences, threshold } = require('../utils/attendanceStats');
    const th = threshold();
    const newlyFlagged = absentIds.filter(id => consecutiveAbsences(rec.entityType, rec.entityId, id) === th);
    if (newlyFlagged.length) notifyHeadOfAbsences(rec, newlyFlagged, th).catch(() => {});
  } catch (e) { console.error('[attendance] flag check failed:', e.message); }

  res.json(updated);
});

// Resolved attendance roster for a meeting (the people to tick present/absent).
// Congregation meetings resolve to their chosen audience (all / leaders /
// selected entities); committee/group meetings to that roster (executives
// filtered to office-holders). Each row carries the person's home entity so a
// mixed congregation list can show where everyone is from.
router.get('/:id/roster', requireAuth, (req, res) => {
  const rec = db.findById('meetings', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Meeting not found.' });
  if (!canViewAll(req) && !canManageMeeting(req, rec)) {
    return res.status(403).json({ error: 'You cannot view this meeting\'s roster.' });
  }
  const roster = resolveMeetingRoster(rec).map(m => ({
    id: m.id, name: m.name, position: m.position || 'Member',
    entityName: entityName(m.entityType, m.entityId),
  }));
  res.json(roster);
});

router.post('/:id/unlock-attendance', requireAuth, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only an administrator can unlock meeting attendance.' });
  const rec = db.findById('meetings', Number(req.params.id));
  if (!rec || !rec.attendance) return res.status(404).json({ error: 'No locked attendance found.' });
  db.update('meetings', rec.id, { attendance: { ...rec.attendance, locked: false, unlockedAt: new Date().toISOString() } });
  logActivity({ ...actor(req), action: 'UNLOCKED meeting attendance', entityType: 'meeting', entityId: rec.id, entityLabel: `${rec.entityName} ${rec.date}` });
  res.json({ ok: true });
});

// ---- Minutes upload: PDF ONLY (mimetype + magic bytes), 10 MB cap ----
const minutesUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted for minutes.'));
  },
});
router.post('/:id/minutes', requireAuth, requirePermission('meetings.manage'), (req, res) => {
  minutesUpload.single('minutes')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const rec = db.findById('meetings', Number(req.params.id));
    if (!rec) return res.status(404).json({ error: 'Meeting not found.' });
    if (!canManageMeeting(req, rec)) {
      return res.status(403).json({ error: 'You can only upload minutes for your own meetings.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    if (req.file.buffer.slice(0, 5).toString() !== '%PDF-') {
      return res.status(400).json({ error: 'That file is not a real PDF.' });
    }
    // Replacing a wrong upload: drop the previous file so it isn't orphaned.
    if (rec.minutes && rec.minutes.filename) {
      try { fs.unlinkSync(path.join(MINUTES_DIR, path.basename(rec.minutes.filename))); } catch (e) {}
    }
    const filename = `minutes-${rec.id}-${Date.now()}.pdf`;
    fs.writeFileSync(path.join(MINUTES_DIR, filename), req.file.buffer);
    const updated = db.update('meetings', rec.id, {
      minutes: { filename, originalName: req.file.originalname, uploadedBy: actor(req).userName, uploadedAt: new Date().toISOString(), size: req.file.size },
    });
    logActivity({ ...actor(req), action: 'Uploaded meeting minutes (PDF)', entityType: 'meeting', entityId: rec.id, entityLabel: `${rec.entityName} ${rec.date}` });
    res.json(updated);
  });
});
router.get('/:id/minutes', requireAuth, (req, res) => {
  const rec = db.findById('meetings', Number(req.params.id));
  if (!rec || !rec.minutes) return res.status(404).json({ error: 'No minutes uploaded for this meeting.' });
  if (!canViewAll(req) && rec.entityType !== 'congregation') {
    const ent = userEntity(req);
    if (!ent || ent.type !== rec.entityType || Number(ent.id) !== Number(rec.entityId)) {
      return res.status(403).json({ error: 'You can only view your own minutes.' });
    }
  }
  const fp = path.join(MINUTES_DIR, path.basename(rec.minutes.filename));
  if (!fs.existsSync(fp)) return res.status(410).json({ error: 'Minutes file missing on server.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${rec.minutes.originalName || rec.minutes.filename}"`);
  res.send(fs.readFileSync(fp));
});

// Ready-to-fill Word minutes template for a held meeting (auto attendance +
// agenda headings). Same view scope as the minutes PDF.
// Remove a wrongly-uploaded minutes PDF (managers / own entity). Deletes the
// file and clears the record so a correct one can be uploaded.
router.delete('/:id/minutes', requireAuth, requirePermission('meetings.manage'), (req, res) => {
  const rec = db.findById('meetings', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Meeting not found.' });
  if (!canManageMeeting(req, rec)) {
    return res.status(403).json({ error: 'You can only manage minutes for your own meetings.' });
  }
  if (!rec.minutes) return res.status(404).json({ error: 'No minutes uploaded.' });
  try { fs.unlinkSync(path.join(MINUTES_DIR, path.basename(rec.minutes.filename))); } catch (e) {}
  const updated = db.update('meetings', rec.id, { minutes: null });
  logActivity({ ...actor(req), action: 'Removed meeting minutes', entityType: 'meeting', entityId: rec.id, entityLabel: `${rec.entityName} ${rec.date}` });
  res.json(updated);
});

router.get('/:id/minutes-template.docx', requireAuth, async (req, res) => {
  const rec = db.findById('meetings', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Meeting not found.' });
  if (!canViewAll(req) && rec.entityType !== 'congregation') {
    const ent = userEntity(req);
    if (!ent || ent.type !== rec.entityType || Number(ent.id) !== Number(rec.entityId)) {
      return res.status(403).json({ error: 'You can only build minutes for your own meetings.' });
    }
  }
  const nameOf = id => { const m = db.findById('members', id); return m ? m.name : 'Member #' + id; };
  const memberOf = id => { const m = db.findById('members', id); return { name: m ? m.name : 'Member #' + id, position: (m && m.position) || 'Member' }; };
  const att = rec.attendance || {};
  const onlineSet = new Set((att.onlinePresentMemberIds || []).map(Number));
  const guestOnlineSet = new Set(att.guestsOnline || []);
  const presentEntry = id => { const m = memberOf(id); return onlineSet.has(Number(id)) ? { name: `${m.name} (online)`, position: m.position } : m; };
  const entity = db.findById(rec.entityType === 'committee' ? 'committees' : 'groups', rec.entityId) || {};

  // Previous held-and-locked meeting for this same entity, for the
  // "Review / Confirmation of Minutes" line.
  const prior = db.findAll('meetings', x =>
    x.id !== rec.id && x.entityType === rec.entityType && Number(x.entityId) === Number(rec.entityId) &&
    x.attendance && x.attendance.locked &&
    (x.date < rec.date || (x.date === rec.date && (x.time || '') < (rec.time || ''))))
    .sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')))[0];
  const previousDateStr = prior ? toLocalDate(prior.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';

  // Real business items only — drop the standard boilerplate lines so they
  // don't duplicate the fixed 1.0/3.0/6.0/7.0 sections in the minutes body.
  const BOILER = /(opening|prayer|welcome|constitut|previous minutes|review of minutes|confirmation of minutes|matters arising|any other business|a\.?\s*o\.?\s*b|closing|closure|adjourn|benediction)/i;
  const agendaItems = String(rec.agenda || '').split(/\r?\n/)
    .map(s => s.replace(/^\s*\d+([.)]\d*)*[.)]?\s*/, '').trim())
    .filter(Boolean).filter(s => !BOILER.test(s));

  // This meeting's captured action points fill the Action Points table.
  const dshort = d => d ? toLocalDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const actionPoints = db.findAll('action_points', a => Number(a.meetingId) === rec.id)
    .sort((a, b) => (a.targetDate || '').localeCompare(b.targetDate || ''))
    .map(a => ({ text: a.text, responsible: a.responsibleName || '', targetDate: dshort(a.targetDate), done: a.status === 'done' }));
  // Still-open action points from PRIOR meetings of this entity → Matters Arising.
  const mattersArising = db.findAll('action_points', a =>
    a.status === 'open' && a.entityType === rec.entityType && Number(a.entityId) === Number(rec.entityId) && Number(a.meetingId) !== rec.id)
    .sort((a, b) => (a.targetDate || '').localeCompare(b.targetDate || ''))
    .map(a => `${a.text}${a.responsibleName ? ` — ${a.responsibleName}` : ''}${a.targetDate ? ` (target ${dshort(a.targetDate)})` : ''}`);

  const buf = await buildMinutesTemplate({
    entityName: rec.entityName || '',
    title: rec.title || 'Meeting',
    dateStr: toLocalDate(rec.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
    startTime: rec.time || '',
    venue: rec.venueName || (rec.mode === 'online' ? 'Online' : ''),
    present: [...(att.presentMemberIds || []).map(presentEntry), ...(att.guestsPresent || []).map(n => ({ name: guestOnlineSet.has(n) ? `${n} (online)` : n, position: 'Guest' }))],
    apologies: [...(att.apologyMemberIds || []).map(nameOf), ...(att.guestsApology || []).map(n => `${n} (guest)`)],
    absent: (att.absentMemberIds || []).map(nameOf),
    agendaItems,
    previousDateStr,
    proceedings: att.proceedings || {},
    actionPoints,
    mattersArising,
    signatories: entity.signatories || {},
  });
  const fname = `Minutes_${(rec.entityName || 'meeting').replace(/\s+/g, '_')}_${rec.date}.docx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(buf);
});

// Live attendance summary for a committee/group (shown on their page).
// Defaults to the current year; pass ?quarter= to narrow it.
router.get('/attendance-summary', requireAuth, (req, res) => {
  const { entityAttendance } = require('../utils/attendanceStats');
  let type = req.query.entityType, id = req.query.entityId;
  if (!canViewAll(req)) {
    const ent = userEntity(req);
    if (!ent) return res.status(403).json({ error: 'No entity.' });
    type = ent.type; id = ent.id;
  }
  if (!type || id === undefined) return res.status(400).json({ error: 'entityType and entityId required.' });
  const period = {};
  if (req.query.year) period.year = Number(req.query.year);
  if (req.query.quarter) period.quarter = Number(req.query.quarter);
  res.json(entityAttendance(type, Number(id), period));
});

// ---------- Overview (the page's summary tab) ----------
// Opening Meetings should answer "where do we stand?" before anything else:
// what has been held, what is still unrecorded, who is drifting out of
// attendance, and what was promised and not yet done. Scope mirrors the list:
// nothing selected = every committee and group this account may see.
router.get('/overview', requireAuth, (req, res) => {
  const { entityAttendance } = require('../utils/attendanceStats');
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const quarter = Number(req.query.quarter) || (Math.floor(now.getMonth() / 3) + 1);
  const wide = canViewAll(req);

  // Which entities are in scope?
  let scope = null; // null = everything visible
  if (req.query.entityType && req.query.entityId !== undefined && wide) {
    scope = { type: req.query.entityType, id: Number(req.query.entityId) };
  } else if (!wide) {
    const ent = userEntity(req);
    if (!ent || ent.type === 'congregation') return res.status(403).json({ error: 'Your account is not attached to a committee or group.' });
    scope = { type: ent.type, id: Number(ent.id) };
  }

  const visible = m => m.status !== 'cancelled' && (
    scope ? (m.entityType === scope.type && Number(m.entityId) === Number(scope.id))
          : (wide || m.entityType === 'congregation'));
  const all = db.findAll('meetings', visible);
  const inQuarter = all.filter(m => Number(m.year) === year && Number(m.quarter) === quarter);
  const held = inQuarter.filter(m => m.status === 'held');
  const locked = held.filter(m => m.attendance && m.attendance.locked);

  // Turnout across the quarter's locked meetings: present (in person + online,
  // members + guests) over everyone the meeting expected.
  let presentSum = 0, expectedSum = 0;
  locked.forEach(m => {
    const a = m.attendance || {};
    const present = (a.presentMemberIds || []).length + (a.onlinePresentMemberIds || []).length
      + (a.guestsPresent || []).length + (a.guestsOnline || []).length;
    const expected = present + (a.apologyMemberIds || []).length + (a.absentMemberIds || []).length;
    presentSum += present; expectedSum += expected;
  });

  const { toDayKey } = require('../utils/dates');
  const todayKey = toDayKey(new Date()); // local day, not UTC — see utils/dates
  const upcoming = all.filter(m => m.status === 'scheduled' && m.date >= todayKey)
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
    .slice(0, 5)
    .map(m => ({ id: m.id, title: m.title, date: m.date, time: m.time, entityName: m.entityName || '', venueName: m.venueName || '', mode: m.mode }));

  // Per-entity roll-up, only worth showing when several are in view.
  const entities = scope ? [scope] : [
    ...db.findAll('committees', c => c.active !== false).map(c => ({ type: 'committee', id: c.id, code: c.code, name: c.name })),
    ...db.findAll('groups', g => g.active !== false).map(g => ({ type: 'group', id: g.id, code: g.code, name: g.name })),
  ].filter(e => wide);
  // entityAttendance() re-reads the JSON store on every call, so it is run
  // ONCE per entity here and the result reused for both the roll-up and the
  // flag list — calling it twice doubled the disk reads for no benefit.
  const flagged = [];
  const perEntityRows = entities.map(e => {
    const name = e.name || entityName(e.type, e.id);
    // The group table is about EXECUTIVES. A group's general meetings are a
    // headcount reported on Attendance, and counting them here would read as
    // executive discipline they say nothing about.
    const mine = inQuarter.filter(m => m.entityType === e.type && Number(m.entityId) === Number(e.id)
      && !(e.type === 'group' && m.kind === 'general'));
    const h = mine.filter(m => m.status === 'held');
    const l = h.filter(m => m.attendance && m.attendance.locked);
    const stats = entityAttendance(e.type, e.id, { year, quarter });
    (stats.flagged || []).forEach(m => flagged.push({ ...m, entityName: name }));
    return {
      type: e.type, id: e.id, code: e.code || null, name,
      held: h.length, scheduled: mine.length - h.length,
      attendanceMissing: h.length - l.length,
      minutesMissing: h.filter(m => !m.minutes).length,
      flagged: (stats.flagged || []).length,
    };
  });
  // Committees alphabetically, then groups in the congregation's own order —
  // a table you scan for one body, not a league table of who met most.
  const perEntity = [
    ...perEntityRows.filter(e => e.type === 'committee').sort((a, b) => a.name.localeCompare(b.name)),
    ...sortGroups(perEntityRows.filter(e => e.type === 'group')),
  ];
  flagged.sort((a, b) => (a.flag === b.flag ? b.consecutiveAbsences - a.consecutiveAbsences : a.flag === 'red' ? -1 : 1));

  // Action points carried out of those meetings.
  let aps = db.findAll('action_points');
  aps = aps.filter(a => scope
    ? (a.entityType === scope.type && Number(a.entityId) === Number(scope.id))
    : (wide || a.entityType === 'congregation'));
  const open = aps.filter(a => a.status === 'open');
  const overdue = open.filter(a => a.targetDate && a.targetDate < todayKey);

  res.json({
    year, quarter, wide, scope,
    held: held.length,
    scheduledInQuarter: inQuarter.length - held.length,
    attendanceRecorded: locked.length,
    attendanceMissing: held.length - locked.length,
    minutesUploaded: held.filter(m => m.minutes).length,
    minutesMissing: held.filter(m => !m.minutes).length,
    turnoutPct: expectedSum ? Math.round((presentSum / expectedSum) * 100) : null,
    upcoming,
    perEntity: scope ? [] : perEntity,
    flagged: flagged.slice(0, 12),
    flaggedTotal: flagged.length,
    actionPoints: { open: open.length, overdue: overdue.length },
  });
});

// ---------- Action points (tasks carried out of a meeting) ----------
function apMemberName(id) { const m = db.findById('members', Number(id)); return m ? m.name : ''; }
function apCanView(req, rec) {
  if (canViewAll(req)) return true;
  if (rec.entityType === 'congregation') return true;
  const ent = userEntity(req);
  return !!(ent && ent.type === rec.entityType && Number(ent.id) === Number(rec.entityId));
}

// Scoped list for the tracker / dashboard (own entity, or everything for
// congregation-view accounts). ?status=open narrows it.
router.get('/action-points-list', requireAuth, (req, res) => {
  let list = db.findAll('action_points');
  if (!canViewAll(req)) {
    const ent = userEntity(req);
    list = (ent && ent.type !== 'congregation') ? list.filter(a => a.entityType === ent.type && Number(a.entityId) === Number(ent.id)) : [];
  }
  if (req.query.status) list = list.filter(a => a.status === req.query.status);
  res.json(list.sort((a, b) => (a.targetDate || '').localeCompare(b.targetDate || '')));
});

router.get('/:id/action-points', requireAuth, (req, res) => {
  const rec = db.findById('meetings', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Meeting not found.' });
  if (!apCanView(req, rec)) return res.status(403).json({ error: 'You cannot view this meeting.' });
  res.json(db.findAll('action_points', a => Number(a.meetingId) === rec.id).sort((a, b) => (a.targetDate || '').localeCompare(b.targetDate || '')));
});

// Branded PDF of a meeting's action points (for printing / sharing).
router.get('/:id/action-points.pdf', requireAuth, async (req, res) => {
  const rec = db.findById('meetings', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Meeting not found.' });
  if (!apCanView(req, rec)) return res.status(403).json({ error: 'You cannot view this meeting.' });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const dshort = d => d ? toLocalDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
  const statusOf = a => a.status === 'done' ? 'Done' : (a.targetDate && toLocalDate(a.targetDate) < today ? 'Overdue' : 'Open');
  const order = { Overdue: 0, Open: 1, Done: 2 };
  const rows = db.findAll('action_points', a => Number(a.meetingId) === rec.id)
    .map(a => ({ text: a.text, responsible: a.responsibleName || 'Unassigned', target: dshort(a.targetDate), status: statusOf(a) }))
    .sort((x, y) => (order[x.status] - order[y.status]));
  const buf = await buildActionPointsPdf({
    entityName: rec.entityName || '', meetingTitle: rec.title || 'Meeting',
    dateStr: toLocalDate(rec.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    generatedOn: new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
    rows,
  });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="ActionPoints_${(rec.entityName || 'meeting').replace(/\s+/g, '_')}_${rec.date}.pdf"`);
  res.send(buf);
});

router.post('/:id/action-points', requireAuth, requirePermission('meetings.manage'), (req, res) => {
  const rec = db.findById('meetings', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Meeting not found.' });
  if (!canManageMeeting(req, rec)) return res.status(403).json({ error: 'You can only manage action points for your own meetings.' });
  const items = Array.isArray(req.body.items) ? req.body.items : [req.body];
  const created = [];
  items.forEach(it => {
    const text = String(it.text || '').trim();
    if (!text) return;
    const mid = (it.responsibleMemberId != null && it.responsibleMemberId !== '') ? Number(it.responsibleMemberId) : null;
    const responsibleName = mid ? apMemberName(mid) : String(it.responsibleName || '').trim();
    const targetDate = /^\d{4}-\d{2}-\d{2}$/.test(it.targetDate || '') ? it.targetDate : '';
    created.push(db.insert('action_points', {
      meetingId: rec.id, entityType: rec.entityType, entityId: rec.entityId, entityName: rec.entityName || '',
      meetingTitle: rec.title || '', meetingDate: rec.date,
      text, responsibleMemberId: mid, responsibleName, targetDate,
      status: 'open', createdBy: actor(req).userName,
    }));
  });
  if (!created.length) return res.status(400).json({ error: 'Add at least one action point with a description.' });
  logActivity({ ...actor(req), action: `Added ${created.length} action point(s)`, entityType: 'meeting', entityId: rec.id, entityLabel: `${rec.entityName} ${rec.date}` });
  res.json(created);
});

router.put('/action-points/:id', requireAuth, requirePermission('meetings.manage'), (req, res) => {
  const ap = db.findById('action_points', Number(req.params.id));
  if (!ap) return res.status(404).json({ error: 'Action point not found.' });
  const rec = db.findById('meetings', Number(ap.meetingId)) || { entityType: ap.entityType, entityId: ap.entityId };
  if (!canManageMeeting(req, rec)) return res.status(403).json({ error: 'You can only manage your own action points.' });
  const patch = {};
  if (req.body.text !== undefined) patch.text = String(req.body.text).trim();
  if (req.body.targetDate !== undefined) patch.targetDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.targetDate || '') ? req.body.targetDate : '';
  if (req.body.responsibleMemberId !== undefined) {
    const mid = req.body.responsibleMemberId ? Number(req.body.responsibleMemberId) : null;
    patch.responsibleMemberId = mid; patch.responsibleName = mid ? apMemberName(mid) : '';
  }
  if (req.body.status !== undefined && ['open', 'done'].includes(req.body.status)) {
    patch.status = req.body.status;
    patch.doneAt = req.body.status === 'done' ? new Date().toISOString() : null;
    patch.doneBy = req.body.status === 'done' ? actor(req).userName : null;
  }
  res.json(db.update('action_points', ap.id, patch));
});

router.delete('/action-points/:id', requireAuth, requirePermission('meetings.manage'), (req, res) => {
  const ap = db.findById('action_points', Number(req.params.id));
  if (!ap) return res.status(404).json({ error: 'Action point not found.' });
  const rec = db.findById('meetings', Number(ap.meetingId)) || { entityType: ap.entityType, entityId: ap.entityId };
  if (!canManageMeeting(req, rec)) return res.status(403).json({ error: 'You can only manage your own action points.' });
  db.remove('action_points', ap.id);
  res.json({ ok: true });
});

// ============================================================================
// Minutes written in the app — committees and group executives.
//
// The same shape as the Session's minutes, built from what the meeting already
// holds: the roll and proceedings recorded with its attendance, its agenda, and
// the open action points of earlier meetings. There is no AI tidy-up here; the
// secretary writes each item and the Word and PDF are built from it, in the
// Session's own layout. The Word template download and the signed-PDF upload
// stay as they were.
//
// One record per meeting in `meeting_minutes`:
//   { meetingId, status: 'draft'|'final', finalisedBy, finalisedAt,
//     openingNote, previousDate, corrections: [{ from, to }],
//     matters: [row], main: [row], other: [row], closingNote }
//   row = { subject, body, action }
// ============================================================================
const MM_BOILER = /(opening|prayer|welcome|constitut|previous minutes|review of minutes|confirmation of minutes|matters arising|any other business|a\.?\s*o\.?\s*b|other matters|closing|closure|adjourn|benediction)/i;
function hasPerm(req, perm) {
  if (isAdmin(req)) return true;
  const u = db.findById('users', req.user.id) || {};
  return (u.permissions || []).includes(perm);
}
function minutesEligible(rec) {
  if (!rec || rec.entityType === 'congregation') return false;
  if (rec.entityType === 'group') return rec.kind !== 'general';   // a headcount meeting has no roll to minute
  return rec.entityType === 'committee';
}
function canViewMeeting(req, rec) {
  if (canViewAll(req) || canManageMeeting(req, rec)) return true;
  const ent = userEntity(req);
  return !!(ent && ent.type === rec.entityType && Number(ent.id) === Number(rec.entityId));
}
function mmClean(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function mmRows(list) {
  const { cleanMotions } = require('@deontech/minutes');
  return (Array.isArray(list) ? list : []).slice(0, 60).map(r => {
    const out = { subject: mmClean(r && r.subject, 200), body: mmClean(r && r.body, 20000), action: mmClean(r && r.action, 400) };
    const motions = cleanMotions(r && r.motions);
    if (motions.length) out.motions = motions;
    return out;
  });
}
// The last earlier meeting of the same body AND the same kind — a committee's
// previous committee meeting, a group's previous executive meeting.
function previousMeeting(rec) {
  const kindOf = m => m.entityType === 'group' ? (m.kind === 'general' ? 'general' : 'executive') : m.entityType;
  return db.findAll('meetings', x =>
    x.id !== rec.id && x.entityType === rec.entityType && Number(x.entityId) === Number(rec.entityId) &&
    kindOf(x) === kindOf(rec) && x.status !== 'cancelled' &&
    (x.date < rec.date || (x.date === rec.date && (x.time || '') < (rec.time || ''))))
    .sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')))[0] || null;
}
// Started from the meeting itself: agenda lines become Main Business, and the
// action points still open from earlier meetings become Matters Arising.
function seedMinutes(rec) {
  const main = String(rec.agenda || '').split(/\r?\n/)
    .map(x => x.replace(/^\s*\d+([.)]\d*)*[.)]?\s*/, '').replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean).filter(x => !MM_BOILER.test(x))
    .map(subject => ({ subject, body: '', action: '' }));
  const matters = db.findAll('action_points', a =>
    a.status === 'open' && a.entityType === rec.entityType && Number(a.entityId) === Number(rec.entityId) && Number(a.meetingId) !== rec.id)
    .sort((a, b) => (a.targetDate || '').localeCompare(b.targetDate || ''))
    .map(a => ({ subject: a.text, body: '', action: a.responsibleName ? `${a.responsibleName}` : '' }));
  const prev = previousMeeting(rec);
  return {
    meetingId: rec.id, status: 'draft',
    openingNote: '', previousDate: prev ? prev.date : '', corrections: [],
    matters, main, other: [], closingNote: '',
  };
}
function minutesDocFor(rec, create) {
  const found = db.findAll('meeting_minutes', d => Number(d.meetingId) === Number(rec.id))[0];
  if (found || !create) return found || null;
  return db.insert('meeting_minutes', seedMinutes(rec));
}
function mmLongDate(iso) {
  return iso ? toLocalDate(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : '';
}
function mmOrdinalDate(iso) {
  if (!iso) return '';
  const d = toLocalDate(iso), n = d.getDate();
  const suf = (n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return `${n}${suf} ${d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`;
}
function stop(v) { const t = String(v || '').trim(); return !t ? '' : /[.!?]$/.test(t) ? t : t + '.'; }
const PROC_KEYS = ['commencedAt', 'constitutedAt', 'constitutedBy', 'closedAt', 'openingBy', 'minutesMovedBy', 'minutesSecondedBy', 'closureMovedBy', 'closureSecondedBy'];
// What happened at the meeting — times, who opened, who moved what. Typed on
// the Minutes tab (doc.proceedings) and also captured when attendance is
// recorded on the Meetings page; what is typed here wins.
function effectiveProceedings(rec, doc) {
  const out = { ...((rec.attendance && rec.attendance.proceedings) || {}) };
  const mine = (doc && doc.proceedings) || {};
  PROC_KEYS.forEach(k => { if (String(mine[k] || '').trim()) out[k] = String(mine[k]).trim(); });
  return out;
}
// The roll: the recorded attendance once there is one; until then the draft
// ticked on the Roll tab, with everyone unticked counted absent.
function effectiveRoll(rec, doc) {
  const att = rec.attendance;
  const recorded = att && Array.isArray(att.presentMemberIds) && att.mode !== 'headcount';
  // Unlocked for a correction: the recorded roll is the starting point, and any
  // ticks made since then are the draft until it is confirmed again.
  if (recorded && !att.locked) {
    const r = (doc && doc.roll) || {};
    const edited = r.savedAt && r.savedAt > (att.unlockedAt || att.recordedAt || '');
    if (!edited) {
      return {
        source: 'draft', locked: false,
        presentIds: att.presentMemberIds.map(Number), onlineIds: (att.onlinePresentMemberIds || []).map(Number),
        apologyIds: (att.apologyMemberIds || []).map(Number),
        absentIds: resolveMeetingRoster(rec).map(m => Number(m.id)).filter(i => !att.presentMemberIds.map(Number).includes(i) && !(att.apologyMemberIds || []).map(Number).includes(i)),
        guestsPresent: att.guestsPresent || [], guestsApology: att.guestsApology || [],
      };
    }
  }
  if (recorded && att.locked) {
    return {
      source: 'recorded', locked: !!att.locked,
      presentIds: att.presentMemberIds.map(Number), onlineIds: (att.onlinePresentMemberIds || []).map(Number),
      apologyIds: (att.apologyMemberIds || []).map(Number), absentIds: (att.absentMemberIds || []).map(Number),
      guestsPresent: att.guestsPresent || [], guestsApology: att.guestsApology || [],
    };
  }
  const r = (doc && doc.roll) || {};
  const presentIds = (r.presentIds || []).map(Number), apologyIds = (r.apologyIds || []).map(Number).filter(i => !presentIds.includes(i));
  const known = new Set([...presentIds, ...apologyIds]);
  return {
    source: 'draft', locked: false,
    presentIds, onlineIds: (r.onlineIds || []).map(Number).filter(i => presentIds.includes(i)), apologyIds,
    absentIds: resolveMeetingRoster(rec).map(m => Number(m.id)).filter(i => !known.has(i)),
    guestsPresent: r.guestsPresent || [], guestsApology: r.guestsApology || [],
  };
}
// The numbered rows the Word and PDF print, sections left out when empty.
// Committee and group minutes, through the same engine as the Session's
// (@deontech/minutes): numbering, lead-ins that agree with how many items
// follow, and motions with a mover, a seconder and a result.
const COMMITTEE_SECTIONS = {
  opening: { prefix: true },
  constitution: {},
  review: { prefix: true },
  matters: { container: true, lead: n => n === 1 ? 'The following was discussed under matters arising.' : 'The following were discussed under matters arising.' },
  main: { container: true, lead: n => n === 1 ? 'The following was discussed under main business.' : 'The following were discussed under main business.' },
  other: { container: true, lead: n => n === 1 ? 'The following other matter was discussed.' : 'The following other matters were discussed.' },
  closure: { prefix: true },
};
function minutesRows(rec, doc) {
  const MIN = require('@deontech/minutes');
  // Times print as "6:30 pm", whatever form they were typed in (Oct 2026).
  const p = { ...effectiveProceedings(rec, doc) };
  ['commencedAt', 'constitutedAt', 'closedAt'].forEach(k => { if (p[k]) p[k] = MIN.minuteTime(p[k]); });
  const filled = list => (list || []).filter(r => (r.subject || '').trim() || (r.body || '').trim() || (r.motions || []).length);
  const fixes = (doc.corrections || []).filter(c => (c.from || '').trim() || (c.to || '').trim());
  const reviewed = !!(doc.previousDate || fixes.length || p.minutesMovedBy);
  const adopt = p.minutesMovedBy
    ? `${p.minutesMovedBy} moved for the adoption of the minutes${fixes.length ? ' as corrected' : ''}${p.minutesSecondedBy ? `, and ${p.minutesSecondedBy} seconded the motion` : ''}.`
    : '';
  const matters = filled(doc.matters), main = filled(doc.main), other = filled(doc.other);
  const sections = [
    { key: 'opening', subject: 'Opening', enabled: true, body: doc.openingNote || '' },
    { key: 'constitution', subject: 'Constitution of the Meeting', enabled: !!(p.constitutedBy || p.constitutedAt) },
    { key: 'review', subject: 'Review of Minutes', enabled: reviewed,
      children: fixes.map(c => ({ subject: 'Correction', body: `‘${(c.from || '').trim()}’ amended to ‘${(c.to || '').trim()}’.` }))
        .concat(adopt ? [{ subject: 'Adoption of Minutes', body: adopt }] : []) },
    { key: 'matters', subject: 'Matters Arising', enabled: matters.length > 0, children: matters },
    { key: 'main', subject: 'Main Business', enabled: main.length > 0, children: main },
    { key: 'other', subject: 'Other Matters', enabled: other.length > 0, children: other },
    { key: 'closure', subject: 'Closure', enabled: true, body: doc.closingNote || '' },
  ];
  const auto = sec => {
    if (sec.key === 'opening') return [p.commencedAt ? `The meeting commenced at ${stop(p.commencedAt)}` : '', p.openingBy ? `${p.openingBy} led the opening prayer.` : ''].filter(Boolean).join(' ');
    if (sec.key === 'constitution') return `${p.constitutedBy || 'The Chairperson'} duly constituted the meeting${p.constitutedAt ? ` at ${p.constitutedAt}` : ''} in the name of the Triune God.`;
    if (sec.key === 'review') return doc.previousDate ? `The minutes of the meeting held on ${mmOrdinalDate(doc.previousDate)} were read and reviewed.` : 'The minutes of the previous meeting were read and reviewed.';
    if (sec.key === 'closure') return p.closureMovedBy
      ? `${p.closureMovedBy} moved for the closure of the meeting${p.closedAt ? ` at ${p.closedAt}` : ''}${p.closureSecondedBy ? `, and this was seconded by ${p.closureSecondedBy}` : ''}.`
      : (p.closedAt ? `The meeting closed at ${stop(p.closedAt)}` : '');
    return '';
  };
  return MIN.renderSections(sections, { meta: k => COMMITTEE_SECTIONS[k] || {}, auto });
}
function minutesPrintData(rec, doc) {
  const roll = effectiveRoll(rec, doc);
  const member = id => db.findById('members', id);
  const online = new Set(roll.onlineIds);
  const pick = ids => (ids || []).map(Number).map(member).filter(Boolean)
    .map(m => ({ name: online.has(Number(m.id)) ? `${m.name} (online)` : m.name, position: m.position || 'Member' }));
  const entity = db.findById(rec.entityType === 'committee' ? 'committees' : 'groups', rec.entityId) || {};
  const sig = entity.signatories || {};
  const ownerName = rec.entityName || entity.name || '';
  // "Committee on Welfare" + "Committee Meeting" reads "Committee on Welfare Meeting", not "… Committee Committee Meeting".
  let title = String(rec.title || 'Meeting');
  if (/committee/i.test(ownerName)) title = title.replace(/^committee\s+/i, '');
  const heading = new RegExp(ownerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(title) ? title : `${ownerName} ${title}`;
  return {
    heading, date: rec.date, venue: rec.venueName || (rec.mode === 'online' ? 'online' : ''),
    present: pick(roll.presentIds),
    inAttendance: roll.guestsPresent.map(g => ({ name: g, position: 'Guest' })),
    apologies: pick(roll.apologyIds).concat(roll.guestsApology.map(g => ({ name: g, position: 'Guest' }))),
    absent: pick(roll.absentIds),
    rows: minutesRows(rec, doc),
    appendices: [],
    signatories: {
      recordedBy: { name: (sig.secretary && sig.secretary.name) || '', title: (sig.secretary && sig.secretary.title) || 'Secretary' },
      confirmedBy: { name: (sig.head && sig.head.name) || '', title: (sig.head && sig.head.title) || (rec.entityType === 'group' ? 'President' : 'Chairperson') },
    },
    owner: ownerName,
  };
}
function loadForMinutes(req, res, edit) {
  const rec = db.findById('meetings', Number(req.params.id));
  if (!rec) { res.status(404).json({ error: 'Meeting not found.' }); return null; }
  if (!minutesEligible(rec)) { res.status(400).json({ error: 'Minutes are written here for committee and group executive meetings only.' }); return null; }
  if (rec.status === 'cancelled') { res.status(400).json({ error: 'That meeting was cancelled.' }); return null; }
  if (edit ? !canManageMeeting(req, rec) : !canViewMeeting(req, rec)) {
    res.status(403).json({ error: edit ? 'You can only write minutes for your own meetings.' : 'You can only view your own minutes.' });
    return null;
  }
  return rec;
}

router.get('/:id/write', requireAuth, (req, res) => {
  const rec = loadForMinutes(req, res, false); if (!rec) return;
  const mayEdit = canManageMeeting(req, rec) && hasPerm(req, 'meetings.manage');
  const doc = minutesDocFor(rec, mayEdit) || seedMinutes(rec);
  const att = rec.attendance || null;
  const prev = previousMeeting(rec);
  res.json({
    meeting: {
      id: rec.id, title: rec.title, entityName: rec.entityName, entityType: rec.entityType, kind: rec.kind || '',
      date: rec.date, time: rec.time, venueName: rec.venueName, agenda: rec.agenda || '', status: rec.status,
      minutesPdf: rec.minutes ? { originalName: rec.minutes.originalName, uploadedAt: rec.minutes.uploadedAt, uploadedBy: rec.minutes.uploadedBy } : null,
    },
    roster: resolveMeetingRoster(rec).map(m => ({ id: m.id, name: m.name, position: m.position || 'Member' })),
    roll: effectiveRoll(rec, doc),
    attendance: att ? { recorded: true, locked: !!att.locked, recordedBy: att.recordedBy || '', recordedAt: att.recordedAt || '' } : { recorded: false },
    proceedings: effectiveProceedings(rec, doc),
    previous: prev ? { id: prev.id, date: prev.date } : null,
    doc,
    canEdit: mayEdit,
    canRecord: canManageMeeting(req, rec) && hasPerm(req, 'attendance.manage'),
    canUnlock: isAdmin(req),
  });
});

router.put('/:id/write', requireAuth, requirePermission('meetings.manage'), (req, res) => {
  const rec = loadForMinutes(req, res, true); if (!rec) return;
  const doc = minutesDocFor(rec, true);
  if (doc.status === 'final') return res.status(400).json({ error: 'These minutes are final. Reopen them before editing.' });
  const b = req.body || {};
  const patch = {};
  if (b.openingNote !== undefined) patch.openingNote = mmClean(b.openingNote, 8000);
  if (b.closingNote !== undefined) patch.closingNote = mmClean(b.closingNote, 8000);
  if (b.previousDate !== undefined) { const d = mmClean(b.previousDate, 10); patch.previousDate = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : ''; }
  if (Array.isArray(b.corrections)) patch.corrections = b.corrections.slice(0, 40).map(c => ({ from: mmClean(c && c.from, 1000), to: mmClean(c && c.to, 1000) }));
  ['matters', 'main', 'other'].forEach(k => { if (Array.isArray(b[k])) patch[k] = mmRows(b[k]); });
  if (b.proceedings && typeof b.proceedings === 'object') {
    patch.proceedings = {};
    PROC_KEYS.forEach(k => { patch.proceedings[k] = mmClean(b.proceedings[k], 120); });
  }
  // The draft roll, ticked through the meeting. Once attendance is recorded
  // (and locked) the recorded roll is the record and this is ignored.
  if (b.roll && typeof b.roll === 'object') {
    const ids = v => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(Boolean))];
    const names = v => (Array.isArray(v) ? v : []).map(x => mmClean(x, 120)).filter(Boolean).slice(0, 100);
    const presentIds = ids(b.roll.presentIds);
    patch.roll = {
      presentIds, apologyIds: ids(b.roll.apologyIds).filter(i => !presentIds.includes(i)),
      onlineIds: ids(b.roll.onlineIds).filter(i => presentIds.includes(i)),
      guestsPresent: names(b.roll.guestsPresent), guestsApology: names(b.roll.guestsApology),
      savedAt: new Date().toISOString(),
    };
  }
  patch.updatedBy = actor(req).userName;
  res.json(db.update('meeting_minutes', doc.id, patch));
});

// The agenda, edited from the minutes page. Saved quietly — no notice goes out;
// rescheduling from the Meetings page is still the way to tell members.
router.put('/:id/write/agenda', requireAuth, requirePermission('meetings.manage'), (req, res) => {
  const rec = loadForMinutes(req, res, true); if (!rec) return;
  const items = (Array.isArray(req.body && req.body.items) ? req.body.items : [])
    .map(x => mmClean(x, 200)).filter(Boolean).slice(0, 60);
  const updated = db.update('meetings', rec.id, { agenda: items.map((x, i) => `${i + 1}. ${x}`).join('\n') });
  res.json({ agenda: updated.agenda });
});

router.post('/:id/write/final', requireAuth, requirePermission('meetings.manage'), (req, res) => {
  const rec = loadForMinutes(req, res, true); if (!rec) return;
  const doc = minutesDocFor(rec, true);
  const reopen = !!(req.body && req.body.reopen);
  const updated = db.update('meeting_minutes', doc.id, reopen
    ? { status: 'draft', finalisedBy: '', finalisedAt: '' }
    : { status: 'final', finalisedBy: actor(req).userName, finalisedAt: new Date().toISOString() });
  logActivity({ ...actor(req), action: reopen ? 'Reopened meeting minutes' : 'Marked meeting minutes final', entityType: 'meeting', entityId: rec.id, entityLabel: `${rec.entityName} ${rec.date}` });
  res.json(updated);
});

async function sendMinutesFile(req, res, kind) {
  const rec = loadForMinutes(req, res, false); if (!rec) return;
  const doc = minutesDocFor(rec, false) || seedMinutes(rec);
  const data = minutesPrintData(rec, doc);
  const base = `Minutes_${(rec.entityName || 'meeting').replace(/[^\w]+/g, '_')}_${rec.date}`;
  try {
    if (kind === 'pdf') {
      const buf = await buildSessionMinutesPdf(data);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${base}.pdf"`);
      return res.send(buf);
    }
    const buf = await buildSessionMinutesDocx(data);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${base}.docx"`);
    res.send(buf);
  } catch (e) {
    console.error('[meeting-minutes]', e);
    res.status(500).json({ error: 'Could not build the minutes.' });
  }
}
router.get('/:id/write.docx', requireAuth, (req, res) => sendMinutesFile(req, res, 'docx'));
router.get('/:id/write.pdf', requireAuth, (req, res) => sendMinutesFile(req, res, 'pdf'));

module.exports = router;
