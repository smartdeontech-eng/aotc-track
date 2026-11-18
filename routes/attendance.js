// AOTC Track — Service & group attendance (Phase 6, sectioned in Phase 12a).
// Sunday/special services: headcounts per service (1st/2nd/joint) for
// Children's Service, JY and Adult — male/female/online. Groups log their
// weekly meetings (members/leaders). Feeds reports and the District Excel.
//
// Sectioned Sunday model:
//   1. Day setup   — Session Clerk/admin fixes the day's shape (joint | dual).
//   2. Section drafts — CS / JY / Main recorders each save + submit ONLY their
//      own section (merge-writes: nobody can wipe another section's figures).
//   3. Confirm & lock — once all three sections are submitted the Clerk/admin
//      confirms; the day locks and everyone is notified.
// Day metadata lives in `service_days`; the per-service headcounts stay in
// `service_attendance` exactly as before, so reports/District Excel read unchanged.
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const push = require('../utils/push');
const { toLocalDate } = require('../utils/dates');
const { sortGroups } = require('../utils/groupOrder');

const SECTIONS = ['cs', 'jy', 'adult'];
const SECTION_PERM = { cs: 'attendance.cs', jy: 'attendance.jy', adult: 'attendance.main' };
const SECTION_LABEL = { cs: "Children's Service", jy: 'JY', adult: 'Main Church' };

function fmtDay(date) {
  // `date` is a calendar day ('YYYY-MM-DD'), not an instant — see utils/dates.
  return toLocalDate(date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}
function dayMeta(date) {
  return db.findOne('service_days', d => d.date === date) || null;
}
function sectionsForUser(req) {
  if (isClerkOrAdmin(req)) return [...SECTIONS];
  const u = db.findById('users', req.user.id) || {};
  const perms = u.permissions || [];
  return SECTIONS.filter(s => perms.includes(SECTION_PERM[s]));
}
function emptySectionState() {
  const out = {};
  SECTIONS.forEach(s => { out[s] = { status: 'pending', by: null, at: null }; });
  return out;
}
// Merge one section's counts into the (date, service) record without
// touching the other sections — the fix for the old overwrite problem.
function mergeSectionCounts(date, service, section, values) {
  const zero = { male: 0, female: 0, online: 0 };
  const extras = section === 'cs' ? { teachersMale: 0, teachersFemale: 0 }
    : section === 'jy' ? { leadersMale: 0, leadersFemale: 0 } : {};
  const clean = { ...zero, ...extras };
  Object.keys(clean).forEach(k => { clean[k] = n((values || {})[k]); });
  const existing = db.findOne('service_attendance', s => s.date === date && s.service === service);
  if (existing) {
    const counts = { ...existing.counts, [section]: clean };
    return db.update('service_attendance', existing.id, { counts });
  }
  const counts = {};
  SECTIONS.forEach(s => {
    counts[s] = { male: 0, female: 0, online: 0 };
    if (s === 'cs') { counts[s].teachersMale = 0; counts[s].teachersFemale = 0; }
    if (s === 'jy') { counts[s].leadersMale = 0; counts[s].leadersFemale = 0; }
  });
  counts[section] = clean;
  return db.insert('service_attendance', {
    date, service, year: new Date(date).getFullYear(), quarter: quarterOf(date), counts, enteredBy: '',
  });
}

const { actor, userEntity, isAdmin, isClerkOrAdmin } = require('../utils/scope');
function quarterOf(d) { return Math.floor(new Date(d).getMonth() / 3) + 1; }
function n(v) { return v === '' || v === null || v === undefined ? 0 : Number(v) || 0; }

// ============ Sectioned Sunday flow ============

// What can I do here? (drives the page)
router.get('/my-access', requireAuth, (req, res) => {
  res.json({
    clerk: isClerkOrAdmin(req),
    sections: sectionsForUser(req),
  });
});

// Day list/detail: meta + this day's entries, for the attendance page.
router.get('/days', requireAuth, (req, res) => {
  const mine = sectionsForUser(req);
  if (!mine.length) return res.status(403).json({ error: 'You have no Sunday attendance access.' });
  if (req.query.date) {
    const date = req.query.date;
    const day = dayMeta(date);
    const entries = {};
    const bible = {}; // per-service "Bible study held" flag (Main service only)
    // Recorders only receive their own section's figures — they should see
    // exactly what applies to them, nothing else.
    db.findAll('service_attendance', s => s.date === date).forEach(s => {
      const filtered = {};
      mine.forEach(sec => { if (s.counts[sec]) filtered[sec] = s.counts[sec]; });
      entries[s.service] = filtered;
      bible[s.service] = !!s.bibleStudy;
    });
    // The Sunday before, for the recorder to check against (Oct 2026): the same
    // sections only, shown faintly beside each box — never filled in.
    const before = db.findAll('service_attendance', s => s.date < date).map(s => s.date).sort().pop();
    let prev = null;
    if (before) {
      prev = { date: before, entries: {} };
      db.findAll('service_attendance', s => s.date === before).forEach(s => {
        const filtered = {};
        mine.forEach(sec => { if (s.counts[sec]) filtered[sec] = s.counts[sec]; });
        prev.entries[s.service] = filtered;
      });
    }
    return res.json({ day, entries, bible, prev, sections: mine, clerk: isClerkOrAdmin(req) });
  }
  const days = db.findAll('service_days').sort((a, b) => b.date.localeCompare(a.date)).slice(0, 30);
  res.json({ days, sections: mine, clerk: isClerkOrAdmin(req) });
});

// 1. Day setup — Clerk/admin fixes the shape (joint | dual).
router.post('/days', requireAuth, (req, res) => {
  if (!isClerkOrAdmin(req)) return res.status(403).json({ error: 'Only the Session Clerk or an admin can set up the day.' });
  const { date, shape } = req.body;
  if (!date || !['joint', 'dual'].includes(shape)) return res.status(400).json({ error: 'Date and shape (joint/dual) are required.' });
  const existing = dayMeta(date);
  if (existing && existing.status === 'confirmed') return res.status(400).json({ error: 'This day is confirmed and locked. An admin must unlock it first.' });
  // Changing shape after entries exist for the other shape would orphan them.
  const sameDay = db.findAll('service_attendance', s => s.date === date);
  if (shape === 'joint' && sameDay.some(s => s.service !== 'joint')) {
    return res.status(400).json({ error: 'This date already has 1st/2nd figures. Delete them first if the day was actually joint.' });
  }
  if (shape === 'dual' && sameDay.some(s => s.service === 'joint')) {
    return res.status(400).json({ error: 'This date already has joint-service figures. Delete them first if the day actually had two services.' });
  }
  const payload = {
    date, shape,
    year: new Date(date).getFullYear(), quarter: quarterOf(date),
    status: 'open',
    sections: existing ? existing.sections : emptySectionState(),
    setBy: actor(req).userName,
  };
  const day = existing ? db.update('service_days', existing.id, payload) : db.insert('service_days', payload);
  logActivity({ ...actor(req), action: 'Set up service day', entityType: 'service_day', entityId: day.id, entityLabel: `${date} (${shape})` });
  // Tell the section recorders the day is ready for their figures.
  const recorders = push.userIdsWithPermission(...Object.values(SECTION_PERM))
    .filter(id => id !== req.user.id);
  push.sendPushToUsers(recorders, {
    title: 'Sunday attendance open',
    body: `${fmtDay(date)} is set up as a ${shape === 'dual' ? '1st + 2nd service' : 'joint service'} day — you can now enter your section.`,
    url: '/attendance.html', tag: `day-setup-${date}`,
  }).catch(() => {});
  res.json(day);
});

// A section recorder asking the Clerk to set the day up.
router.post('/days/request-setup', requireAuth, (req, res) => {
  const mine = sectionsForUser(req);
  if (!mine.length) return res.status(403).json({ error: 'You have no Sunday attendance access.' });
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Date is required.' });
  if (dayMeta(date)) return res.status(400).json({ error: 'This day is already set up.' });
  const clerks = push.userIdsWithPermission('approvals.manage').filter(id => id !== req.user.id);
  push.sendPushToUsers(clerks, {
    title: 'Day setup requested',
    body: `${actor(req).userName} is ready to enter ${fmtDay(date)} attendance — please set the day as joint or 1st + 2nd.`,
    url: '/attendance.html', tag: `day-request-${date}`,
  }).catch(() => {});
  res.json({ ok: true });
});

// 2. Section save (draft) — merge-writes ONLY the caller's section.
// Record whether a Bible study was held at a given MAIN service (1st/2nd/joint).
// Feeds the CLN KPI "Number of Bible Studies in Sunday worship per year".
// Recorded by the Main Church (adult) recorder or a clerk/admin — bible studies
// are captured for the main service only.
router.post('/bible-study', requireAuth, (req, res) => {
  const { date, service, held } = req.body;
  if (!date || !service) return res.status(400).json({ error: 'Date and service are required.' });
  if (!sectionsForUser(req).includes('adult')) {
    return res.status(403).json({ error: 'Only the Main Church recorder can record Bible studies.' });
  }
  const day = dayMeta(date);
  if (!day) return res.status(400).json({ error: 'Set the day up first.' });
  if (day.status === 'confirmed' && !isClerkOrAdmin(req)) {
    return res.status(400).json({ error: 'This day is confirmed and locked.' });
  }
  let rec = db.findOne('service_attendance', s => s.date === date && s.service === service);
  if (rec) {
    rec = db.update('service_attendance', rec.id, { bibleStudy: !!held });
  } else {
    const counts = {};
    SECTIONS.forEach(s => {
      counts[s] = { male: 0, female: 0, online: 0 };
      if (s === 'cs') { counts[s].teachersMale = 0; counts[s].teachersFemale = 0; }
      if (s === 'jy') { counts[s].leadersMale = 0; counts[s].leadersFemale = 0; }
    });
    rec = db.insert('service_attendance', {
      date, service, year: new Date(date).getFullYear(), quarter: quarterOf(date),
      counts, bibleStudy: !!held, enteredBy: actor(req).userName,
    });
  }
  logActivity({ ...actor(req), action: `Bible study ${held ? 'recorded' : 'unmarked'} — ${service} service`, entityType: 'service_attendance', entityId: rec.id, entityLabel: `${date} (${service})` });
  res.json({ ok: true });
});

router.put('/sections', requireAuth, (req, res) => {
  const { date, section, entries } = req.body;
  if (!date || !SECTIONS.includes(section)) return res.status(400).json({ error: 'Date and section (cs/jy/adult) are required.' });
  if (!sectionsForUser(req).includes(section)) {
    return res.status(403).json({ error: `You are not a ${SECTION_LABEL[section]} recorder.` });
  }
  const day = dayMeta(date);
  if (!day) return res.status(400).json({ error: 'This day has not been set up yet. Ask the Session Clerk to set it as joint or 1st + 2nd first.' });
  if (day.status === 'confirmed') return res.status(400).json({ error: 'This day is confirmed and locked.' });
  const secState = (day.sections || {})[section] || {};
  if (secState.status === 'submitted' && !isClerkOrAdmin(req)) {
    return res.status(400).json({ error: 'Your section is already submitted. Ask the Session Clerk if something needs correcting.' });
  }
  const wanted = day.shape === 'dual' ? ['1st', '2nd'] : ['joint'];
  const given = Object.keys(entries || {});
  if (!given.length || given.some(s => !wanted.includes(s))) {
    return res.status(400).json({ error: `This day is ${day.shape === 'dual' ? '1st + 2nd services' : 'a joint service'} — figures must match.` });
  }
  wanted.forEach(svc => mergeSectionCounts(date, svc, section, (entries || {})[svc] || {}));
  const sections = { ...(day.sections || emptySectionState()) };
  sections[section] = { status: 'draft', by: actor(req).userName, at: new Date().toISOString() };
  db.update('service_days', day.id, { sections });
  logActivity({ ...actor(req), action: `Saved ${SECTION_LABEL[section]} attendance`, entityType: 'service_day', entityId: day.id, entityLabel: `${date} ${section}` });
  res.json({ ok: true, sections });
});

// Section submit — freezes the section for its recorder, notifies the Clerk.
router.post('/sections/submit', requireAuth, (req, res) => {
  const { date, section } = req.body;
  if (!date || !SECTIONS.includes(section)) return res.status(400).json({ error: 'Date and section are required.' });
  if (!sectionsForUser(req).includes(section)) return res.status(403).json({ error: `You are not a ${SECTION_LABEL[section]} recorder.` });
  const day = dayMeta(date);
  if (!day) return res.status(400).json({ error: 'This day has not been set up yet.' });
  if (day.status === 'confirmed') return res.status(400).json({ error: 'This day is already confirmed.' });
  const sections = { ...(day.sections || emptySectionState()) };
  if ((sections[section] || {}).status === 'pending') {
    return res.status(400).json({ error: 'Save your figures first, then submit.' });
  }
  sections[section] = { ...sections[section], status: 'submitted', by: actor(req).userName, at: new Date().toISOString() };
  db.update('service_days', day.id, { sections });
  logActivity({ ...actor(req), action: `Submitted ${SECTION_LABEL[section]} attendance`, entityType: 'service_day', entityId: day.id, entityLabel: `${date} ${section}` });
  const allIn = SECTIONS.every(s => (sections[s] || {}).status === 'submitted');
  const clerks = push.userIdsWithPermission('approvals.manage').filter(id => id !== req.user.id);
  push.sendPushToUsers(clerks, {
    title: allIn ? 'Sunday attendance — all sections in' : 'Attendance section submitted',
    body: allIn
      ? `All three sections for ${fmtDay(date)} are submitted — ready to confirm and lock.`
      : `${SECTION_LABEL[section]} submitted for ${fmtDay(date)} by ${actor(req).userName}.`,
    url: '/attendance.html', tag: `submit-${date}-${section}`,
  }).catch(() => {});
  res.json({ ok: true, sections, allIn });
});

// Clerk sending a section back for correction (before the day is confirmed).
router.post('/sections/reopen', requireAuth, (req, res) => {
  if (!isClerkOrAdmin(req)) return res.status(403).json({ error: 'Only the Session Clerk or an admin can reopen a section.' });
  const { date, section } = req.body;
  const day = dayMeta(date);
  if (!day || !SECTIONS.includes(section)) return res.status(400).json({ error: 'Day/section not found.' });
  if (day.status === 'confirmed') return res.status(400).json({ error: 'Unlock the day first (admin), then reopen the section.' });
  const sections = { ...(day.sections || emptySectionState()) };
  sections[section] = { ...sections[section], status: 'draft' };
  db.update('service_days', day.id, { sections });
  const ids = push.userIdsWithPermission(SECTION_PERM[section]).filter(id => id !== req.user.id);
  push.sendPushToUsers(ids, {
    title: 'Attendance section reopened',
    body: `${SECTION_LABEL[section]} for ${fmtDay(date)} was reopened for correction — please review and resubmit.`,
    url: '/attendance.html', tag: `reopen-${date}-${section}`,
  }).catch(() => {});
  res.json({ ok: true, sections });
});

// 3. Confirm & lock — Clerk/admin, all sections must be submitted.
router.post('/days/confirm', requireAuth, (req, res) => {
  if (!isClerkOrAdmin(req)) return res.status(403).json({ error: 'Only the Session Clerk or an admin can confirm the day.' });
  const { date } = req.body;
  const day = dayMeta(date);
  if (!day) return res.status(400).json({ error: 'This day has not been set up yet.' });
  if (day.status === 'confirmed') return res.status(400).json({ error: 'Already confirmed.' });
  const missing = SECTIONS.filter(s => ((day.sections || {})[s] || {}).status !== 'submitted');
  if (missing.length && !req.body.force) {
    return res.status(400).json({
      error: `Not all sections are submitted yet: ${missing.map(s => SECTION_LABEL[s]).join(', ')}.`,
      missing,
    });
  }
  const updated = db.update('service_days', day.id, {
    status: 'confirmed', confirmedBy: actor(req).userName, confirmedAt: new Date().toISOString(),
  });
  logActivity({ ...actor(req), action: 'Confirmed & locked service day', entityType: 'service_day', entityId: day.id, entityLabel: date });
  // 4. Notification after approval — recorders + clerks.
  const ids = push.userIdsWithPermission(...Object.values(SECTION_PERM), 'approvals.manage')
    .filter(id => id !== req.user.id);
  push.sendPushToUsers(ids, {
    title: 'Sunday attendance confirmed',
    body: `${fmtDay(date)} attendance has been confirmed and locked by ${actor(req).userName}. Thank you!`,
    url: '/attendance.html', tag: `confirm-${date}`,
  }).catch(() => {});
  res.json(updated);
});

// Admin-only unlock (logged, like quarter unlocks).
router.post('/days/unlock', requireAuth, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only an admin can unlock a confirmed day.' });
  const { date } = req.body;
  const day = dayMeta(date);
  if (!day || day.status !== 'confirmed') return res.status(400).json({ error: 'This day is not confirmed.' });
  const updated = db.update('service_days', day.id, { status: 'open', confirmedBy: null, confirmedAt: null });
  logActivity({ ...actor(req), action: 'UNLOCKED confirmed service day', entityType: 'service_day', entityId: day.id, entityLabel: date });
  res.json(updated);
});

// ---- Church services (admin / Session Clerk) ----
router.get('/services', requireAuth, (req, res) => {
  let list = db.findAll('service_attendance');
  const year = Number(req.query.year); const quarter = Number(req.query.quarter);
  if (year) list = list.filter(s => s.year === year);
  if (quarter) list = list.filter(s => s.quarter === quarter);
  res.json(list.sort((a, b) => b.date.localeCompare(a.date)));
});

router.put('/services', requireAuth, (req, res) => {
  if (!isClerkOrAdmin(req)) return res.status(403).json({ error: 'Only the Session Clerk or an admin can record service attendance.' });
  const { date, service } = req.body;
  if (!date || !['1st', '2nd', 'joint'].includes(service)) return res.status(400).json({ error: 'Date and service (1st/2nd/joint) are required.' });
  const meta = dayMeta(date);
  if (meta && meta.status === 'confirmed') return res.status(400).json({ error: 'This day is confirmed and locked. An admin must unlock it first.' });
  const c = req.body.counts || {};
  const counts = {};
  ['cs', 'jy', 'adult'].forEach(k => {
    const x = c[k] || {};
    counts[k] = { male: n(x.male), female: n(x.female), online: n(x.online) };
    if (k === 'cs') { counts[k].teachersMale = n(x.teachersMale); counts[k].teachersFemale = n(x.teachersFemale); } // CS teachers (adults)
    if (k === 'jy') { counts[k].leadersMale = n(x.leadersMale); counts[k].leadersFemale = n(x.leadersFemale); }     // JY leaders (adults)
  });
  // A day is EITHER joint OR dual (1st+2nd) — never both.
  const sameDay = db.findAll('service_attendance', s => s.date === date);
  if (service === 'joint' && sameDay.some(s => s.service !== 'joint')) {
    return res.status(400).json({ error: 'This date already has 1st/2nd service entries. Delete them first if the day was actually a joint service.' });
  }
  if (service !== 'joint' && sameDay.some(s => s.service === 'joint')) {
    return res.status(400).json({ error: 'This date already has a joint-service entry. Delete it first if the day actually had two services.' });
  }
  const existing = db.findOne('service_attendance', s => s.date === date && s.service === service);
  const payload = { date, service, year: new Date(date).getFullYear(), quarter: quarterOf(date), counts, enteredBy: actor(req).userName };
  const rec = existing ? db.update('service_attendance', existing.id, payload) : db.insert('service_attendance', payload);
  logActivity({ ...actor(req), action: 'Recorded service attendance', entityType: 'service_attendance', entityId: rec.id, entityLabel: `${date} ${service}` });
  res.json(rec);
});

router.delete('/services/:id', requireAuth, (req, res) => {
  if (!isClerkOrAdmin(req)) return res.status(403).json({ error: 'Only the Session Clerk or an admin can do this.' });
  const rec = db.findById('service_attendance', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Entry not found.' });
  const dMeta = dayMeta(rec.date);
  if (dMeta && dMeta.status === 'confirmed') return res.status(400).json({ error: 'This day is confirmed and locked. An admin must unlock it first.' });
  db.remove('service_attendance', rec.id);
  logActivity({ ...actor(req), action: 'Deleted service attendance entry', entityType: 'service_attendance', entityId: rec.id, entityLabel: `${rec.date} ${rec.service}`, snapshot: rec });
  res.json({ ok: true });
});

// ---- Group meetings (group accounts; JY-style members/leaders log) ----
router.get('/groups', requireAuth, (req, res) => {
  let list = db.findAll('group_attendance');
  if (!isClerkOrAdmin(req) && !(db.findById('users', req.user.id).permissions || []).includes('congregation.view')) {
    const ent = userEntity(req);
    if (!ent || ent.type !== 'group') return res.json([]);
    list = list.filter(g => Number(g.entityId) === Number(ent.id));
  } else if (req.query.entityId) {
    list = list.filter(g => Number(g.entityId) === Number(req.query.entityId));
  }
  res.json(list.sort((a, b) => b.date.localeCompare(a.date)));
});

router.put('/groups', requireAuth, requirePermission('attendance.manage'), (req, res) => {
  let entId = null;
  const ent = userEntity(req);
  if (ent && ent.type === 'group') entId = Number(ent.id);
  else if (isAdmin(req) && req.body.entityId) entId = Number(req.body.entityId);
  if (!entId) return res.status(403).json({ error: 'Only group accounts (or an admin choosing a group) can record group attendance.' });
  const group = db.findById('groups', entId);
  if (!group) return res.status(404).json({ error: 'Group not found.' });
  // JY and Children's Service meet WITHIN Sunday services — their attendance
  // is captured on the Sunday grid, so no separate weekly log (avoids double-counting).
  if (['JY', 'CS'].includes(group.code)) {
    return res.status(400).json({ error: `${group.name} attendance is captured under Sunday services, not here.` });
  }
  const { date } = req.body;
  if (!date) return res.status(400).json({ error: 'Date is required.' });
  const existing = db.findOne('group_attendance', g => g.date === date && Number(g.entityId) === entId);
  const payload = {
    entityType: 'group', entityId: entId, ownerCode: group.code, date,
    year: new Date(date).getFullYear(), quarter: quarterOf(date),
    membersMale: n(req.body.membersMale), membersFemale: n(req.body.membersFemale),
    onlineMale: n(req.body.onlineMale), onlineFemale: n(req.body.onlineFemale),
    enteredBy: actor(req).userName,
  };
  const rec = existing ? db.update('group_attendance', existing.id, payload) : db.insert('group_attendance', payload);
  logActivity({ ...actor(req), action: 'Recorded group attendance', entityType: 'group_attendance', entityId: rec.id, entityLabel: `${group.code} ${date}` });
  res.json(rec);
});

router.delete('/groups/:id', requireAuth, requirePermission('attendance.manage'), (req, res) => {
  const rec = db.findById('group_attendance', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Entry not found.' });
  const ent = userEntity(req);
  if (!isAdmin(req) && (!ent || ent.type !== 'group' || Number(ent.id) !== Number(rec.entityId))) {
    return res.status(403).json({ error: 'You can only manage your own group\'s attendance.' });
  }
  db.remove('group_attendance', rec.id);
  res.json({ ok: true });
});

// ============ Overview (the page's summary tab) ============
// A read-only roll-up so opening Attendance answers "how are we doing?"
// before anyone drills into a single Sunday or a single group. Scope follows
// the same rules as everything else here: congregation-wide accounts see the
// whole picture, a group account sees only its own.
const { toDayKey } = require('../utils/dates');

function serviceTotals(rec) {
  const c = rec.counts || {};
  const g = (k, f) => n((c[k] || {})[f]);
  const cs = g('cs', 'male') + g('cs', 'female');
  const jy = g('jy', 'male') + g('jy', 'female');
  const staff = g('cs', 'teachersMale') + g('cs', 'teachersFemale') + g('jy', 'leadersMale') + g('jy', 'leadersFemale');
  const adults = g('adult', 'male') + g('adult', 'female') + staff;
  const online = g('cs', 'online') + g('jy', 'online') + g('adult', 'online');
  return { cs, jy, adults, online, total: cs + jy + adults + online };
}

router.get('/overview', requireAuth, (req, res) => {
  const now = new Date();
  const year = Number(req.query.year) || now.getFullYear();
  const quarter = Number(req.query.quarter) || (Math.floor(now.getMonth() / 3) + 1);
  const wide = isClerkOrAdmin(req) ||
    ((db.findById('users', req.user.id) || {}).permissions || []).includes('congregation.view');
  const out = { year, quarter, wide, sunday: null, groups: null };

  // ---- Sunday services ----
  // Congregation-wide accounts only. A section recorder is deliberately shown
  // ONLY their own section's figures everywhere else in this file (see the
  // /days handler), so handing them whole-congregation totals here would
  // quietly undo that decision.
  if (wide) {
    const all = db.findAll('service_attendance');
    const byDate = {};
    all.forEach(r => {
      const t = serviceTotals(r);
      const d = (byDate[r.date] = byDate[r.date] || { date: r.date, total: 0, cs: 0, jy: 0, adults: 0, online: 0, services: 0 });
      d.total += t.total; d.cs += t.cs; d.jy += t.jy; d.adults += t.adults; d.online += t.online; d.services++;
    });
    const dates = Object.keys(byDate).sort();
    const weeks = dates.slice(-8).map(d => byDate[d]);
    const inQuarter = dates.filter(d => {
      const rec = all.find(r => r.date === d);
      return rec && Number(rec.year) === year && Number(rec.quarter) === quarter;
    });
    const qTotal = inQuarter.reduce((a, d) => a + byDate[d].total, 0);
    const days = db.findAll('service_days');
    const dayByDate = {};
    days.forEach(d => { dayByDate[d.date] = d; });
    // Sundays that are set up but not yet confirmed, newest first, with the
    // sections still outstanding — this is the "what needs chasing" list.
    const awaiting = days
      .filter(d => d.status !== 'confirmed')
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 6)
      .map(d => {
        const missing = SECTIONS.filter(sec => ((d.sections || {})[sec] || {}).status !== 'submitted')
          .map(sec => SECTION_LABEL[sec]);
        // No sections outstanding = every recorder is done and the day is
        // sitting on the Clerk's desk waiting to be confirmed and locked.
        return { date: d.date, shape: d.shape, missing, readyToConfirm: missing.length === 0 };
      });
    const bs = db.findAll('service_attendance', r => Number(r.year) === year && r.bibleStudy);
    const latestDate = dates[dates.length - 1] || null;
    out.sunday = {
      latest: latestDate ? { ...byDate[latestDate], status: (dayByDate[latestDate] || {}).status || null } : null,
      weeks,
      quarterSundays: inQuarter.length,
      quarterTotal: qTotal,
      quarterAvg: inQuarter.length ? Math.round(qTotal / inQuarter.length) : null,
      confirmed: days.filter(d => d.status === 'confirmed').length,
      awaiting,
      bibleStudies: { year: bs.length, quarter: bs.filter(r => Number(r.quarter) === quarter).length },
    };
  }

  // ---- Group meeting attendance ----
  let groups = db.findAll('groups', g => g.active !== false && !['JY', 'CS'].includes(g.code));
  let records = db.findAll('group_attendance');
  if (!wide) {
    const ent = userEntity(req);
    if (!ent || ent.type !== 'group') { res.json(out); return; }
    groups = groups.filter(g => Number(g.id) === Number(ent.id));
    records = records.filter(r => Number(r.entityId) === Number(ent.id));
  }
  const today = toDayKey(new Date());
  const perGroupUnsorted = groups.map(g => {
    const mine = records.filter(r => Number(r.entityId) === Number(g.id));
    const inQ = mine.filter(r => Number(r.year) === year && Number(r.quarter) === quarter);
    const sum = list => list.reduce((a, r) =>
      a + n(r.membersMale ?? r.members) + n(r.membersFemale) + n(r.onlineMale ?? r.online) + n(r.onlineFemale), 0);
    const last = mine.map(r => r.date).sort().pop() || null;
    const total = sum(inQ);
    return {
      id: g.id, code: g.code, name: g.name,
      meetings: inQ.length, total, avg: inQ.length ? Math.round(total / inQ.length) : null,
      lastDate: last,
      daysSince: last ? Math.round((new Date(today) - new Date(last)) / 864e5) : null,
    };
  });
  // Congregation order, not a ranking: this is a table people scan for one
  // particular group, so it must be in the same order as every other group
  // list in the app.
  const perGroup = sortGroups(perGroupUnsorted);
  out.groups = {
    groupCount: groups.length,
    meetings: perGroup.reduce((a, g) => a + g.meetings, 0),
    total: perGroup.reduce((a, g) => a + g.total, 0),
    reporting: perGroup.filter(g => g.meetings > 0).length,
    perGroup,
    // "Nothing logged in five weeks" — the groups worth a nudge.
    stale: perGroup.filter(g => g.daysSince === null || g.daysSince > 35),
  };
  res.json(out);
});

module.exports = router;
