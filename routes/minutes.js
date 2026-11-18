// AOTC Track — Session minutes module.
//
// Everything the Session Clerk needs to produce a meeting's papers:
//   • the Session roster (rank-ordered, drives Members Present/Apologies/Absent)
//   • an agenda builder that times itself and seeds the minutes sections
//   • a section-by-section minutes editor following the AOTC running order
//   • a correspondence register, with Claude drafting the heading and summary
//     from a photograph of the letter
//   • Agenda and Minutes as Word and PDF, in the congregation's house format
//
// Deliberately self-contained (its own router, its own collections) so it does
// not disturb the existing meetings module. A minutes document may optionally
// be linked to a scheduled meeting, in which case the roll can be pulled from
// that meeting's recorded attendance instead of ticked here.
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const db = require('../utils/db');
const { toLocalDate, isSunday, toDayKey } = require('../utils/dates');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { sendMail } = require('../utils/mailer');
const { sendSms } = require('../utils/sms');
const push = require('../utils/push');
const SM = require('../utils/sessionMinutes');
const OT = require('../utils/officeTerms');
const { buildSessionMinutesDocx, buildSessionAgendaDocx } = require('../utils/sessionDocx');
const CX = require('../utils/correspondenceExport');
const { buildSessionMinutesPdf, buildSessionAgendaPdf } = require('../utils/sessionMinutesPdf');
const ai = require('../utils/aiAssist');

const router = express.Router();

// Uploaded letters live under minutes/correspondence — inside a folder the
// deploy scripts already exclude, so a release can never overwrite them.
const FILES_DIR = path.join(__dirname, '..', 'minutes', 'correspondence');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});
const ALLOWED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf'];
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp', 'application/pdf': '.pdf' };

function actor(req) {
  const u = db.findById('users', req.user.id) || {};
  return { userId: req.user.id, userName: u.name || 'Unknown' };
}
function perms(req) {
  const u = db.findById('users', req.user.id) || {};
  return u.permissions || [];
}
function isAdmin(req) { return ['admin', 'localadmin'].includes(req.user.role); }
// The Session Clerk keeps the Session's minutes; admins may act too. The
// dedicated 'session.manage' right grants the same Session-area access without
// the Clerk's wider approval authority (e.g. a Senior Presbyter or Treasurer).
function canEdit(req) { return isAdmin(req) || perms(req).includes('approvals.manage') || perms(req).includes('session.manage'); }
function canView(req) {
  return canEdit(req) || perms(req).includes('congregation.view') || perms(req).includes('congregation.manage');
}
function requireEdit(req, res) {
  if (canEdit(req)) return true;
  res.status(403).json({ error: 'Only the Session Clerk or an administrator can edit Session minutes.' });
  return false;
}
// The Church Administrator scans letters into the inbox as they arrive. She may
// work on a letter while it is still in the inbox; once the Clerk has brought it
// into a set of minutes it is part of the record and only he may change it.
function canIntake(req) { return canEdit(req) || perms(req).includes('correspondence.intake'); }
function requireLetterEdit(req, res, rec) {
  if (canEdit(req)) return true;
  if (canIntake(req) && rec && !rec.minutesId) return true;
  res.status(403).json({ error: rec && rec.minutesId
    ? 'That letter is in the Session minutes now — only the Session Clerk can change it.'
    : 'You do not have access to the correspondence inbox.' });
  return false;
}
function requireView(req, res) {
  if (canView(req)) return true;
  res.status(403).json({ error: 'You do not have access to Session minutes.' });
  return false;
}
function clean(v, max = 400) { return String(v == null ? '' : v).trim().slice(0, max); }

// A letter may be photographed page by page. Records created before that stored
// one `file`; both shapes read the same way through here.
const MAX_PAGES = 10;
function pagesOf(rec) {
  if (!rec) return [];
  if (Array.isArray(rec.files) && rec.files.length) return rec.files;
  return rec.file ? [rec.file] : [];
}
function storePages(list, prefix) {
  return (list || []).map((f, i) => {
    const filename = `${prefix}-${Date.now()}-${i + 1}${EXT[f.mimetype] || ''}`;
    fs.writeFileSync(path.join(FILES_DIR, filename), f.buffer);
    return { filename, originalName: f.originalname, mimetype: f.mimetype, size: f.size };
  });
}
function unlinkPages(rec) {
  pagesOf(rec).forEach(f => {
    if (f && f.filename) { try { fs.unlinkSync(path.join(FILES_DIR, path.basename(f.filename))); } catch (e) {} }
  });
}
function badTypes(list) {
  return (list || []).some(f => !ALLOWED.includes(f.mimetype));
}

// ---------------------------------------------------------------- roster ----
function roster() {
  return db.findAll('session_members').filter(m => m.active !== false).sort(SM.byRank);
}

// The Session AS IT STOOD on the date of a set of minutes. Someone who has
// since left — a minister transferred away — is still part of the sittings he
// attended, so he stays in their roll and their printed attendance lists. He
// does not appear in sittings after he left.
//   leftOn set:     on the roll for any sitting before that day.
//   leftOn missing: (taken off before the date was kept) only where the roll
//                   already records him present or with apologies.
function membersFor(doc) {
  const d = String((doc && doc.date) || '');
  const roll = (doc && doc.roll) || {};
  const marked = new Set([...(roll.presentIds || []), ...(roll.apologyIds || [])].map(Number));
  return db.findAll('session_members').filter(m => {
    if (m.active !== false) return true;
    if (m.leftOn) return !!d && d < m.leftOn;
    return marked.has(Number(m.id));
  }).sort(SM.byRank);
}

// The position a member held ON THE DATE of a sitting, from the dated office
// terms. Without this, reprinting the minutes of a meeting chaired by a
// minister since transferred lists him as "Member" — his position today.
// Offices with no recorded terms fall back to the roster, as before.
function sameHolder(t, m) {
  if (t.memberId != null && m.id != null) return Number(t.memberId) === Number(m.id);
  return !!t.name && SM.bareName(t.name) === SM.bareName(m.name);
}
function positionOn(m, date) {
  if (!date) return m.position;
  for (const o of SM.OFFICES) {
    if (!o.unique || !OT.termsFor(o.key).length) continue;
    const t = OT.holderOn(o.key, date);
    if (t && sameHolder(t, m)) return o.label;
  }
  // Holds a dated office today, but did not hold it on this date.
  const now = SM.officeByKey(SM.officeOf(m));
  if (now && now.unique && OT.termsFor(now.key).length) return 'Member';
  return m.position;
}

router.get('/roster', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  res.json(db.findAll('session_members').sort(SM.byRank));
});

// One-time convenience: create the Session roster in the confirmed rank order.
router.post('/roster/seed', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  if (db.findAll('session_members').length) {
    return res.status(409).json({ error: 'The Session roster already exists. Add or edit members individually.' });
  }
  SM.seedRoster().forEach(m => db.insert('session_members', m));
  logActivity({ ...actor(req), action: 'Seeded the Session roster', entityType: 'session', entityId: 0, entityLabel: 'Session roster' });
  res.status(201).json(roster());
});

// Taking a unique office off someone who already holds it is a succession, and
// the record has to say when — otherwise the roster shows the new holder while
// every document goes on signing with the old one, silently and for good.
// Roster set-up is exempt: when nobody holds a term yet there is nothing to
// succeed, and "Record current holders" dates that open-ended.
function handoverDateRequired(officeKey, officeFrom, memberId) {
  const office = officeKey ? SM.officeByKey(officeKey) : null;
  if (!office || !office.unique) return null;
  if (clean(officeFrom, 10)) return null;
  const open = OT.currentHolder(office.key);
  if (!open) return null;
  if (memberId != null && Number(open.memberId) === Number(memberId)) return null;  // no change
  return `${open.name} currently holds the office of ${office.label}. Say when the change took effect — the induction or election date — so that everything signed before it keeps his name.`;
}

// Offices the Session confers. A unique office can only be held by one person,
// so conferring it takes it off whoever held it before — which is exactly what
// happens when a new minister arrives, or the presbyters elect a new Clerk.
function applyOffice(rec, officeKey, actorInfo) {
  const office = SM.officeByKey(officeKey);
  if (officeKey && !office) return { error: 'That is not an office of the Session.' };
  let released = null;
  if (office && office.unique) {
    const holder = db.findAll('session_members')
      .find(m => m.id !== rec.id && m.active !== false && SM.officeOf(m) === office.key);
    if (holder) {
      db.update('session_members', holder.id, { office: '', position: 'Member' });
      released = holder.name;
      if (actorInfo) logActivity({ ...actorInfo, action: `Released ${holder.name} from ${office.label}`, entityType: 'session_member', entityId: holder.id, entityLabel: holder.name });
    }
  }
  return { office, released };
}
// The printed roster shows the position, so it follows the office unless the
// Clerk has typed something of his own.
function positionFor(office, typed) {
  const t = clean(typed, 60);
  if (office) return office.label;
  if (t && SM.officeKeyForPosition(t)) return 'Member';   // office cleared, stale label
  return t || 'Member';
}

router.post('/roster', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const name = clean(req.body.name, 120);
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const all = db.findAll('session_members');
  const maxRank = all.reduce((m, x) => Math.max(m, Number(x.rank) || 0), 0);
  const rank = Number(req.body.rank) > 0 ? Number(req.body.rank) : maxRank + 10;
  const officeKey = clean(req.body.office, 40);
  const needsDate = handoverDateRequired(officeKey, req.body.officeFrom, null);
  if (needsDate) return res.status(400).json({ error: needsDate });
  const applied = applyOffice({ id: 0 }, officeKey, actor(req));
  if (applied.error) return res.status(400).json({ error: applied.error });
  const rec = db.insert('session_members', {
    name,
    // How the person is addressed in the agenda and in the minutes' prose.
    // A list, because a minister may be both Reverend and Doctor.
    titles: cleanTitles(req.body.titles !== undefined ? req.body.titles : req.body.title),
    office: officeKey,
    // 'agent' or 'presbyter'. Normally implied by the office; kept explicit so
    // a minister holding no listed office can still be marked an agent.
    kind: ['agent', 'presbyter'].includes(req.body.kind) ? req.body.kind : '',
    position: positionFor(applied.office, req.body.position),
    // Used only to circulate the draft minutes for review.
    email: clean(req.body.email, 160).toLowerCase(),
    phone: clean(req.body.phone, 40),
    // A co-opted person is a full member of the court; this only records the
    // standing so Composition can show it and a term can be seen to lapse.
    coOpted: !!req.body.coOpted,
    coOptedOn: clean(req.body.coOptedOn, 10),
    coOptedFor: clean(req.body.coOptedFor, 200),
    coOptedUntil: clean(req.body.coOptedUntil, 10),
    rank,
    active: true,
  });
  // Adding someone to the roster is usually SETTING THE RECORD UP, not a
  // succession — the Clerk is typing in the Session as it already stands. A
  // term dated today would then claim the minister took office the day he was
  // typed in, and every earlier sitting would fall outside it.
  //
  // So a term is opened here only when the Clerk says when it began. Otherwise
  // it is left to "Record current holders", which dates the term open-ended —
  // "since before these records began" — which is what is actually true.
  if (applied.office && applied.office.unique && clean(req.body.officeFrom, 10)) {
    OT.confer(applied.office.key, rec, req.body.officeFrom);
  }
  res.status(201).json({ ...rec, released: applied.released || null });
});

router.put('/roster/:id', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const rec = db.findById('session_members', req.params.id);
  if (!rec) return res.status(404).json({ error: 'Member not found.' });
  const patch = {};
  if (req.body.name !== undefined) {
    const n = clean(req.body.name, 120);
    if (!n) return res.status(400).json({ error: 'Name cannot be empty.' });
    patch.name = n;
  }
  let released = null;
  if (req.body.office !== undefined) {
    const needsDate = handoverDateRequired(clean(req.body.office, 40), req.body.officeFrom, rec.id);
    if (needsDate) return res.status(400).json({ error: needsDate });
    const applied = applyOffice(rec, clean(req.body.office, 40), actor(req));
    if (applied.error) return res.status(400).json({ error: applied.error });
    patch.office = applied.office ? applied.office.key : '';
    patch.position = positionFor(applied.office, req.body.position !== undefined ? req.body.position : rec.position);
    released = applied.released;
  } else if (req.body.position !== undefined) {
    patch.position = clean(req.body.position, 60) || 'Member';
  }
  if (req.body.kind !== undefined) patch.kind = ['agent', 'presbyter'].includes(req.body.kind) ? req.body.kind : '';
  if (req.body.titles !== undefined) patch.titles = cleanTitles(req.body.titles);
  else if (req.body.title !== undefined) patch.titles = cleanTitles(req.body.title);
  if (req.body.email !== undefined) patch.email = clean(req.body.email, 160).toLowerCase();
  if (req.body.phone !== undefined) patch.phone = clean(req.body.phone, 40);
  // How the minutes refer to him after the first mention in an item. Typed
  // here it is 'manual' and the learner leaves it alone; cleared, the default
  // (title + surname) applies again.
  if (req.body.shortForm !== undefined) {
    patch.shortForm = clean(req.body.shortForm, 120);
    patch.shortFormSource = patch.shortForm ? 'manual' : '';
  }
  if (req.body.rank !== undefined && Number(req.body.rank) > 0) patch.rank = Number(req.body.rank);
  if (req.body.active !== undefined) {
    patch.active = !!req.body.active;
    // The day he left the Session. Sittings before it keep him on their roll;
    // sittings from it onward do not. See membersFor.
    if (patch.active) patch.leftOn = '';
    else {
      const d = clean(req.body.leftOn, 10);
      patch.leftOn = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : new Date().toISOString().slice(0, 10);
    }
  }
  if (req.body.coOpted !== undefined) patch.coOpted = !!req.body.coOpted;
  ['coOptedOn', 'coOptedUntil'].forEach(k => {
    if (req.body[k] !== undefined) {
      const d = clean(req.body[k], 10);
      patch[k] = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
    }
  });
  if (req.body.coOptedFor !== undefined) patch.coOptedFor = clean(req.body.coOptedFor, 200);
  const updated = db.update('session_members', rec.id, patch);

  // Offices change hands; the record has to say when. A conferral opens a term
  // for the new holder and closes the outgoing one on the same day, so every
  // document already printed keeps the name that really signed it. Written
  // BEFORE the response, so a failure here is a failed request rather than a
  // 200 with nothing recorded.
  let term = null;
  if (req.body.office !== undefined) {
    // Only a UNIQUE office has a single-holder timeline. Catechist is held by
    // more than one person at once, so "the term that was open" is meaningless
    // there and conferring on a second Catechist would wrongly end the first
    // one's term. Terms are read for District Minister and Session Clerk; both
    // are unique.
    const conferred = req.body.office ? SM.officeByKey(clean(req.body.office, 40)) : null;
    if (conferred && conferred.unique) {
      const r = OT.confer(conferred.key, { id: rec.id, name: updated.name, titles: updated.titles }, req.body.officeFrom);
      term = { office: conferred.key, from: r.opened.from, closed: r.closed ? { name: r.closed.name, to: r.closed.to } : null };
      if (r.closed) {
        logActivity({ ...actor(req), action: `Recorded ${updated.name} as ${conferred.label} from ${r.opened.from} (${r.closed.name} until then)`, entityType: 'session_member', entityId: rec.id, entityLabel: updated.name });
      }
    } else if (!conferred && rec.office && (SM.officeByKey(rec.office) || {}).unique) {
      const v = OT.vacate(rec.office, req.body.officeFrom);
      if (v) term = { office: rec.office, vacatedOn: v.to };
    }
  }
  res.json({ ...updated, released, term });
});

// ---- Office terms -----------------------------------------------------------
// Who held an office, and when. Read by the minutes and the quarterly report so
// a document is signed by whoever held the office on the date it is about.

router.get('/offices/terms', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const key = clean(req.query.office, 40);
  const rows = key ? OT.termsFor(key) : db.findAll(OT.COLLECTION);
  res.json({
    offices: SM.OFFICES.map(o => ({ key: o.key, label: o.label })),
    terms: rows.sort((a, b) => String(a.officeKey).localeCompare(String(b.officeKey))
      || String(a.from || '').localeCompare(String(b.from || ''))),
  });
});

// Back-fill: give each office one open-ended term for whoever holds it now, so
// every document already in the system resolves to the person who really
// signed it. Deliberately does not invent a start date — an open-ended term
// means "since before these records began".
//
// RUN THIS BEFORE RECORDING A HANDOVER. Seeding after the roster has already
// been changed would back-date the new holder over his predecessor's minutes.
router.post('/offices/seed', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  // Normally read off the roster. But if the roster has ALREADY been changed
  // to the new holder, reading it would back-date him over his predecessor's
  // minutes — so the outgoing names can be given explicitly instead:
  //   { holders: { district_minister: { name: 'Rev ...' } } }
  const given = (req.body && req.body.holders) || {};
  const all = roster();
  const holders = {};
  SM.OFFICES.filter(o => o.unique).forEach(o => {
    if (given[o.key] && clean(given[o.key].name, 120)) {
      holders[o.key] = { id: given[o.key].id, name: clean(given[o.key].name, 120), titles: given[o.key].titles };
      return;
    }
    const m = all.find(x => SM.officeOf(x) === o.key);
    if (m) holders[o.key] = { id: m.id, name: m.name, titles: m.titles };
  });
  // Before the roster existed these two lived in Settings; bridge them across
  // so a congregation that has only ever used Settings is still covered.
  const s = require('../utils/settings').getSettings();
  if (!holders.district_minister && s.minister) holders.district_minister = { name: s.minister };
  if (!holders.session_clerk && s.sessionClerk) holders.session_clerk = { name: s.sessionClerk };

  const created = OT.seedFrom(holders);
  if (created.length) {
    logActivity({ ...actor(req), action: `Recorded the current holders of ${created.length} office${created.length === 1 ? '' : 's'}`, entityType: 'session', entityId: 0, entityLabel: 'Office terms' });
  }
  res.json({ created, alreadyHeld: SM.OFFICES.map(o => o.key).filter(k => OT.termsFor(k).length && !created.some(c => c.officeKey === k)) });
});

router.delete('/roster/:id', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const rec = db.findById('session_members', req.params.id);
  if (!rec) return res.status(404).json({ error: 'Member not found.' });
  db.remove('session_members', rec.id);
  res.json({ ok: true });
});

// Re-rank in one call: [{id, rank}, …]
router.post('/roster/reorder', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const list = Array.isArray(req.body.order) ? req.body.order : [];
  list.forEach(o => {
    if (o && o.id && Number(o.rank) > 0) db.update('session_members', Number(o.id), { rank: Number(o.rank) });
  });
  res.json(roster());
});

// ------------------------------------------------------------- documents ----
function summarise(d) {
  return {
    id: d.id, title: d.title, date: d.date, venue: d.venue, status: d.status,
    kind: d.kind, meetingId: d.meetingId || null,
    // Which kind of sitting it was, and what to call it in a sentence. The
    // Review of minutes dropdown needs the second of these.
    meetingKind: SM.meetingKindOf(d), kindLabel: SM.meetingTitleOf(d),
    present: (d.roll && d.roll.presentIds || []).length,
    rollLocked: !!(d.roll && d.roll.locked),
    updatedAt: d.updatedAt || d.createdAt,
  };
}

router.get('/', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const list = db.findAll('minutes_docs').sort((a, b) => String(b.date).localeCompare(String(a.date)));
  res.json(list.map(summarise));
});

// Where the Session sits (21 Oct 2026, the Clerk's list): its OWN short list,
// in his order — Rev Adu-Mante Hall first, then the Chapel — kept in the
// settings as `sessionVenues`, and added to from the venue box ("+ Add a new
// venue…"). The first is the default for a new meeting. Every name on it is
// also kept in the shared venue book the committee meetings use, so a double
// booking of a hall is still caught. Meetings store the venue as text, so a
// past meeting keeps the name it was held under (e.g. "Rev Adu-Mante Session
// Hall", the old default).
const SESSION_VENUES = ['Rev Adu-Mante Hall', 'Chapel'];
const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
// The Session Hall was "Rev Adu-Mante Session Hall" until 21 Oct 2026; the
// Clerk calls it "Rev Adu-Mante Hall". Once, the first time the list is asked
// for: the shared venue book's entry is renamed (same hall, so a clash with a
// committee booking is still caught), and every Session meeting still to come
// is moved to the new name — on its minutes record and on the Meetings page —
// without sending anyone a notice. Meetings already held keep the name they
// were held under, so their minutes do not change.
const OLD_HALL = 'Rev Adu-Mante Session Hall';
function renameOldHall(newName) {
  const st = settings.getSettings();
  if (st.sessionHallRenamed) return;
  try {
    const book = db.findAll('venues');
    const old = book.find(v => sameName(v.name, OLD_HALL));
    if (old && !book.some(v => sameName(v.name, newName))) db.update('venues', old.id, { name: newName, active: true });
    const today = new Date().toISOString().slice(0, 10);
    let moved = 0;
    db.findAll('minutes_docs', d => sameName(d.venue, OLD_HALL) && !d.locked && String(d.date || '') >= today).forEach(d => {
      db.update('minutes_docs', d.id, { venue: newName });
      const m = d.meetingId ? db.findById('meetings', d.meetingId) : null;
      if (m && sameName(m.venueName, OLD_HALL)) db.update('meetings', m.id, { venueName: newName });
      moved += 1;
    });
    settings.updateSettings({ sessionHallRenamed: new Date().toISOString() });
    if (old || moved) console.log(`[session] "${OLD_HALL}" is now "${newName}"; ${moved} upcoming Session meeting(s) moved to the new name.`);
  } catch (e) { console.error('[session] hall rename failed:', e.message); }
}
function sessionVenues() {
  renameOldHall(SESSION_VENUES[0]);
  const saved = settings.getSettings().sessionVenues;
  const list = (Array.isArray(saved) && saved.length ? saved : SESSION_VENUES)
    .map(v => String(v || '').trim()).filter(Boolean);
  const book = db.findAll('venues');
  list.forEach(name => {
    const rec = book.find(v => sameName(v.name, name));
    if (!rec) db.insert('venues', { name, active: true });
    else if (rec.active === false) db.update('venues', rec.id, { active: true });
  });
  return list;
}
function defaultVenue() { return sessionVenues()[0] || ''; }
function venueIdFor(name) {
  if (!String(name || '').trim()) return null;
  const v = db.findAll('venues').find(x => sameName(x.name, name));
  return v ? v.id : null;
}

router.get('/venues', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  res.json({
    venues: sessionVenues().map(name => ({ id: venueIdFor(name), name })),
    defaultVenue: defaultVenue(),
    // The two kinds of sitting, served rather than hardcoded in the page, so
    // the labels cannot drift from the ones the documents are headed with.
    meetingKinds: SM.MEETING_KINDS,
  });
});

// A new venue for the Session's list, added from the venue box.
router.post('/venues', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const name = clean(req.body && req.body.name, 120);
  if (!name) return res.status(400).json({ error: 'Type the name of the venue.' });
  const list = sessionVenues();
  if (!list.some(v => sameName(v, name))) {
    settings.updateSettings({ sessionVenues: [...list, name] });
    logActivity({ ...actor(req), action: 'Added a Session venue', entityType: 'settings', entityId: 0, entityLabel: name });
  }
  const now = sessionVenues();
  res.json({ venues: now.map(n => ({ id: venueIdFor(n), name: n })), defaultVenue: now[0] || '', added: now.find(v => sameName(v, name)) });
});

// ---------------------------------------------------------------- notices
// One editable sentence telling members where the agenda is. It lives here
// rather than in the code because it follows practice, not the software.
const settings = require('../utils/settings');
const escHtml = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function agendaNoteLine() {
  const s = settings.getSettings();
  return String(s.sessionAgendaNote == null ? settings.DEFAULTS.sessionAgendaNote : s.sessionAgendaNote).trim();
}

router.get('/notice-settings', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  res.json({
    agendaNote: agendaNoteLine(),
    suggestion: settings.DEFAULTS.sessionAgendaNote,
    correspondenceStyle: String(settings.getSettings().correspondenceStyle || ''),
  });
});

router.put('/notice-settings', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const patch = {};
  if (req.body.agendaNote !== undefined) patch.sessionAgendaNote = clean(req.body.agendaNote, 200);
  // The Clerk's own instructions for how correspondence should be written.
  if (req.body.correspondenceStyle !== undefined) patch.correspondenceStyle = clean(req.body.correspondenceStyle, 4000);
  settings.updateSettings(patch);
  const agendaNote = patch.sessionAgendaNote !== undefined ? patch.sessionAgendaNote : agendaNoteLine();
  logActivity({ ...actor(req), action: 'Changed what meeting notices say about the agenda', entityType: 'settings', entityId: 0, entityLabel: agendaNote || '(none)' });
  res.json({ agendaNote, correspondenceStyle: String(settings.getSettings().correspondenceStyle || '') });
});

// Titles arrive either as a list or as the older single string. Only titles
// the app knows are kept, and the model puts them in their proper order.
function cleanTitles(input) {
  const raw = Array.isArray(input) ? input : String(input == null ? '' : input).split(',');
  return SM.titlesOf({ titles: raw.map(t => clean(t, 20)).filter(Boolean) });
}

// ---- A changed title, carried into the text --------------------------------
// When a member's title changes (Mrs → Madam), the roster is right at once, but
// minutes already written still say "Mrs …". This finds those mentions in
// everything not yet signed — minutes that are not final, open matters, and
// letters not in signed minutes — and, when asked, rewrites them. Signed
// minutes are the record of what was approved and are never touched.
function retitlePlan(rec, from, apply) {
  const to = SM.titlesOf(rec);
  const sur = SM.surnameOf(rec).toLowerCase();
  const shared = db.findAll('session_members').filter(m => m.id !== rec.id && SM.surnameOf(m).toLowerCase() === sur).length > 0;
  const hits = [];
  const fix = (val, where) => {
    if (typeof val !== 'string') return val;
    const r = SM.retitleText(val, rec, from, to, shared);
    if (r.n) hits.push({ where, n: r.n });
    return r.text;
  };
  const deep = (v, where) => (typeof v === 'string' ? fix(v, where)
    : Array.isArray(v) ? v.map(x => deep(x, where))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x, where)])) : v);
  const signed = new Set();
  db.findAll('minutes_docs').forEach(doc => {
    if (doc.locked || doc.status === 'final') { signed.add(doc.id); return; }
    const where = `Minutes of ${doc.date || 'a meeting'}`;
    const before = hits.length;
    const sections = deep(doc.sections || [], where);
    const proceedings = deep(doc.proceedings || {}, where);
    if (apply && hits.length > before) db.update('minutes_docs', doc.id, { sections, proceedings });
  });
  db.findAll('session_matters').forEach(mt => {
    if (!SM.isMatterOpen(mt)) return;
    const where = `Outstanding matter: ${mt.subject || mt.heading || '#' + mt.id}`;
    const before = hits.length;
    const patch = {};
    ['subject', 'heading', 'note', 'action', 'detail'].forEach(k => { if (typeof mt[k] === 'string') patch[k] = fix(mt[k], where); });
    if (Array.isArray(mt.updates)) patch.updates = deep(mt.updates, where);
    if (apply && hits.length > before) db.update('session_matters', mt.id, patch);
  });
  db.findAll('correspondence').forEach(c => {
    if (c.minutesId && signed.has(c.minutesId)) return;
    const where = `Letter: ${c.heading || '#' + c.id}`;
    const before = hits.length;
    const patch = {};
    ['heading', 'summary', 'action', 'handledNote'].forEach(k => { if (typeof c[k] === 'string') patch[k] = fix(c[k], where); });
    if (apply && hits.length > before) db.update('correspondence', c.id, patch);
  });
  let shortForm = null;
  if (rec.shortForm) {
    const r = SM.retitleText(rec.shortForm, rec, from, to, false);
    if (r.n) { shortForm = r.text; if (apply) db.update('session_members', rec.id, { shortForm: r.text }); }
  }
  const places = {};
  hits.forEach(h => { places[h.where] = (places[h.where] || 0) + h.n; });
  return {
    count: hits.reduce((a, h) => a + h.n, 0),
    places: Object.entries(places).map(([where, n]) => ({ where, n })),
    shortForm, signedLeftAlone: signed.size, name: SM.proseName(rec),
  };
}
router.post('/roster/:id/retitle', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const rec = db.findById('session_members', req.params.id);
  if (!rec) return res.status(404).json({ error: 'Member not found.' });
  const from = (Array.isArray(req.body.from) ? req.body.from : []).map(t => clean(t, 20)).filter(Boolean);
  if (!from.length) return res.status(400).json({ error: 'Which title did the member have before?' });
  const apply = !!req.body.apply;
  const plan = retitlePlan(rec, from, apply);
  if (apply && (plan.count || plan.shortForm)) {
    logActivity({ ...actor(req), action: `Changed how ${plan.name} is named in ${plan.count} place${plan.count === 1 ? '' : 's'} (${from.join(', ')} → ${SM.titlesOf(rec).join(', ')})`, entityType: 'session_member', entityId: rec.id, entityLabel: rec.name });
  }
  res.json({ ...plan, applied: apply });
});

// ---- Moving titles out of the names ----------------------------------------
// The roster was first entered with titles written into the name. This lifts
// them into the title field so there is one rule for everybody and a title can
// be changed without retyping a name. A member is only ever changed when
// reassembling the split reproduces the original name exactly; anything else is
// reported and left alone.
function titleSplitPlan() {
  const done = [], skip = [], already = [];
  db.findAll('session_members').sort(SM.byRank).forEach(m => {
    const d = SM.splitName(m.name);
    const row = { id: m.id, from: m.name, to: d.base, titles: d.titles, rebuilt: d.rebuilt };
    if (!d.titles.length) return;
    if (SM.titlesOf(m).length) already.push(row);
    else if (d.exact) done.push(row);
    else skip.push({ ...row, why: 'reassembling it would not reproduce the name exactly' });
  });
  return { move: done, skip, already };
}

router.get('/roster/titles/split', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  res.json(titleSplitPlan());
});

router.post('/roster/titles/split', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const plan = titleSplitPlan();
  const only = Array.isArray(req.body.ids) ? req.body.ids.map(Number) : null;
  const moved = [];
  plan.move.forEach(row => {
    if (only && !only.includes(row.id)) return;
    db.update('session_members', row.id, { name: row.to, titles: row.titles });
    moved.push(row);
  });
  if (moved.length) {
    logActivity({ ...actor(req), action: `Moved the titles of ${moved.length} member${moved.length === 1 ? '' : 's'} into the title field`, entityType: 'session_member', entityId: 0, entityLabel: moved.map(r => r.from).join('; ').slice(0, 200) });
  }
  res.json({ moved: moved.length, rows: moved, skipped: plan.skip });
});

// ---- The register of outstanding matters ------------------------------------
// Things the Session is carrying between meetings. Kept as its own record
// rather than only inside a set of minutes, so that a matter deferred in
// January is still in front of the Session in June and cannot quietly lapse.
function meetingDates() {
  return db.findAll('minutes_docs', d => d.kind === 'session')
    .map(d => d.date).filter(Boolean).sort();
}
function matterOut(m) {
  return { ...m, updates: (m.updates || []) };
}

router.get('/matters', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const today = new Date().toISOString().slice(0, 10);
  const all = db.findAll('session_matters')
    .sort((a, b) => String(a.raisedAt || '').localeCompare(String(b.raisedAt || '')) || (a.id - b.id));
  const view = SM.summariseMatters(all.map(matterOut), meetingDates(), today);
  const want = clean(req.query.status, 20);
  res.json({
    ...view,
    matters: want === 'open' ? view.matters.filter(m => m.open)
      : want ? view.matters.filter(m => (m.status || 'open') === want)
      : view.matters,
    statuses: SM.MATTER_STATUSES,
    canEdit: canEdit(req),
  });
});

function matterPatch(body, existing) {
  const p = {};
  // The agenda heading this matter is gathered under — several matters share
  // one, and the next agenda carries the heading rather than each detail. A
  // container label ("Other Matters") is not stored: it would put unrelated
  // concerns on one agenda line and name neither, so it is dropped and the
  // heading falls back to the matter's own subject.
  if (body.heading !== undefined) {
    const h = clean(body.heading, 200);
    p.heading = SM.isCatchAllHeading(h) ? '' : h;
  }
  if (body.subject !== undefined) p.subject = clean(body.subject, 200);
  if (body.detail !== undefined) p.detail = clean(body.detail, 4000);
  if (body.owner !== undefined) p.owner = clean(body.owner, 160);
  if (body.due !== undefined) {
    const d = clean(body.due, 10);
    p.due = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
  }
  if (body.raisedAt !== undefined) {
    const d = clean(body.raisedAt, 10);
    p.raisedAt = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
  }
  if (body.raisedIn !== undefined) p.raisedIn = Number(body.raisedIn) || null;
  if (body.decision !== undefined) p.decision = clean(body.decision, 4000);
  if (body.status !== undefined) {
    const st = clean(body.status, 20);
    if (!SM.MATTER_STATUSES.some(x => x.key === st)) return { error: 'That is not a status the register uses.' };
    p.status = st;
    // Closing stamps itself; re-opening clears the stamp so the register never
    // shows a closing date on something still being carried.
    if (st === 'closed') {
      p.closedAt = (existing && existing.closedAt) || new Date().toISOString().slice(0, 10);
    } else {
      p.closedAt = '';
    }
  }
  return { patch: p };
}

router.post('/matters', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const built = matterPatch(req.body, null);
  if (built.error) return res.status(400).json({ error: built.error });
  const p = built.patch;
  if (!p.subject) return res.status(400).json({ error: 'Give the matter a short subject.' });
  const rec = db.insert('session_matters', {
    heading: p.heading || '',
    subject: p.subject,
    detail: p.detail || '',
    owner: SM.resolveName(roster(), p.owner || ''),
    due: p.due || '',
    raisedAt: p.raisedAt || new Date().toISOString().slice(0, 10),
    raisedIn: p.raisedIn || null,
    status: p.status || 'open',
    decision: p.decision || '',
    closedAt: p.closedAt || '',
    updates: [],
    raisedBy: actor(req).userName,
  });
  logActivity({ ...actor(req), action: 'Added a matter to the Session register', entityType: 'session_matter', entityId: rec.id, entityLabel: rec.subject });
  res.status(201).json(matterOut(rec));
});

router.put('/matters/:id', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const rec = db.findById('session_matters', req.params.id);
  if (!rec) return res.status(404).json({ error: 'That matter is not in the register.' });
  const built = matterPatch(req.body, rec);
  if (built.error) return res.status(400).json({ error: built.error });
  const p = built.patch;
  if (p.subject !== undefined && !p.subject) return res.status(400).json({ error: 'The subject cannot be empty.' });
  if (p.owner !== undefined) p.owner = SM.resolveName(roster(), p.owner);
  if (p.status && p.status !== rec.status) {
    logActivity({ ...actor(req), action: `Marked "${rec.subject}" ${SM.matterStatus(p.status).label.toLowerCase()}`, entityType: 'session_matter', entityId: rec.id, entityLabel: rec.subject });
  }
  res.json(matterOut(db.update('session_matters', rec.id, p)));
});

// What was said about this matter when the Session last looked at it. The
// register keeps every one of these, so the history of a long-running matter
// can be read back rather than reconstructed from six sets of minutes.
router.post('/matters/:id/update', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const rec = db.findById('session_matters', req.params.id);
  if (!rec) return res.status(404).json({ error: 'That matter is not in the register.' });
  const note = clean(req.body.note, 4000);
  if (!note) return res.status(400).json({ error: 'Say what was reported or decided.' });
  const meetingId = Number(req.body.meetingId) || null;
  const mtg = meetingId ? db.findById('minutes_docs', meetingId) : null;
  const entry = {
    date: (mtg && mtg.date) || clean(req.body.date, 10) || new Date().toISOString().slice(0, 10),
    meetingId: mtg ? mtg.id : null,
    note,
    by: actor(req).userName,
  };
  const updated = db.mutate('session_matters', rec.id, cur => ({
    ...cur,
    updates: [...(cur.updates || []), entry],
    lastReviewedAt: entry.date,
  }));
  res.json(matterOut(updated));
});

router.delete('/matters/:id', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const rec = db.findById('session_matters', req.params.id);
  if (!rec) return res.status(404).json({ error: 'That matter is not in the register.' });
  db.remove('session_matters', rec.id);
  logActivity({ ...actor(req), action: 'Removed a matter from the Session register', entityType: 'session_matter', entityId: rec.id, entityLabel: rec.subject });
  res.json({ ok: true });
});

// A reading of the whole minutes, not just the rows that happen to carry an
// action — which is the point of asking Claude rather than the rule above.
function minutesAsText(doc) {
  const rows = SM.renderRows(doc, { includeEmpty: false, members: roster() }) || [];
  const lines = [`Session meeting held on ${doc.date || 'an unrecorded date'}.`, ''];
  rows.forEach(r => {
    const bits = [r.no, r.subject].filter(Boolean).join(' ');
    if (bits) lines.push(bits);
    if (r.body) lines.push(String(r.body));
    if (r.action) lines.push(`ACTION: ${r.action}`);
    lines.push('');
  });
  return lines.join('\n').trim();
}

// What these minutes say about each matter, checked against the register:
//   already   — brought in from these very minutes before (or already updated
//               from them), so taking it again would double it
//   updateOf  — an OPEN matter from an earlier meeting that this item continues;
//               adding it appends an update to that matter instead of opening
//               a twin (Oct 2026)
function annotateAgainstRegister(doc, found) {
  const all = db.findAll('session_matters');
  const fromHere = all.filter(m => Number(m.raisedIn) === Number(doc.id));
  const have = new Set(fromHere.map(m => String(m.subject || '').trim().toLowerCase()));
  const candidates = all.filter(m => SM.isMatterOpen(m) && Number(m.raisedIn) !== Number(doc.id));
  const byId = new Map(candidates.map(m => [Number(m.id), m]));
  return found.map(f => {
    const item = { ...f };
    let target = (item.continues && byId.get(Number(item.continues))) || null;
    if (!target) target = SM.continuingMatter(candidates, item);
    delete item.continues;
    if (target) {
      const done = (target.updates || []).some(u => Number(u.meetingId) === Number(doc.id));
      return { ...item, updateOf: { id: target.id, heading: target.heading || '', subject: target.subject, status: target.status || 'open' }, already: done };
    }
    return { ...item, already: have.has(String(item.subject || '').trim().toLowerCase()) };
  });
}

router.post('/matters/propose/:docId', requireAuth, async (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  try {
    const all = db.findAll('session_matters');
    const out = await ai.proposeMatters({
      minutes: minutesAsText(doc),
      people: roster().map(m => SM.proseName(m)),
      // Already brought in from THESE minutes (new, or as an update): skipped,
      // so reading again after a cut-off list moves on to the rest.
      skip: all.filter(m => Number(m.raisedIn) === Number(doc.id) || (m.updates || []).some(u => Number(u.meetingId) === Number(doc.id))).map(m => m.subject),
      // The open matters from earlier meetings, so a continuing matter comes
      // back as an update to it.
      register: all.filter(m => SM.isMatterOpen(m) && Number(m.raisedIn) !== Number(doc.id)),
    });
    // Nothing is saved here. Claude proposes; the Clerk chooses.
    res.json({
      date: doc.date,
      // True when Claude's answer hit the length cap: what is listed is real,
      // but there may be more after it. The page says so.
      truncated: !!out.truncated,
      found: annotateAgainstRegister(doc, out.matters),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not read those minutes.' });
  }
});

// ---- The Session's decisions (Oct 2026) -------------------------------------
// Every "Decision: …" line in every set of Session minutes, newest first, with
// the meeting and item it came from — so "when did we decide that?" is a search,
// not an afternoon with the minute books. Minutes written before the label
// existed are read too, for sentences that plainly record the Session agreeing,
// approving, resolving or deferring; those are marked as found in the prose.
const OLD_DECISION = /^(?:After deliberation,\s+)?the Session (?:agreed|approved|resolved|decided|directed)\b|^The matter was deferred\b/i;
router.get('/decisions', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const q = clean(req.query.q, 120).toLowerCase();
  const out = [];
  db.findAll('minutes_docs', d => d.kind === 'session' || !d.kind).forEach(d => {
    let rows = [];
    try { rows = SM.renderRows(d, { correspondence: correspondenceFor(d.id), members: membersFor(d), earlierLetters: earlierLettersFor(d) }) || []; } catch (e) { return; }
    rows.forEach(r => {
      // Motions recorded as motions: who moved, who seconded, what became of it.
      (r.motions || []).map(require('@deontech/minutes').normaliseMotion).forEach(m => {
        if (!m.text && !m.movedBy) return;
        out.push({ date: d.date, docId: d.id, no: r.no || '', subject: r.subject || '', text: m.text, labelled: true, kind: 'motion',
          movedBy: m.movedBy || '', secondedBy: m.secondedBy || '', result: m.result || 'pending', votes: m.votes || null, unanimous: !!m.unanimous });
      });
      SM.bulletise(r.body || '').forEach(l => {
        if (l.motion) return;   // already listed above, from the record itself
        if (l.decision) {
          out.push({ date: d.date, docId: d.id, no: r.no || '', subject: r.subject || '', text: l.text.replace(/^Decision:\s*/, ''), labelled: true });
          return;
        }
        // Older minutes: a sentence within the paragraph.
        String(l.text).split(/(?<=\.)\s+(?=[A-Z])/).forEach(sentence => {
          if (OLD_DECISION.test(sentence.trim())) out.push({ date: d.date, docId: d.id, no: r.no || '', subject: r.subject || '', text: sentence.trim(), labelled: false });
        });
      });
    });
  });
  const list = out
    .filter(x => !q || `${x.text} ${x.subject}`.toLowerCase().includes(q))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(a.no).localeCompare(String(b.no), undefined, { numeric: true }));
  res.json({ decisions: list.slice(0, 500), total: list.length });
});

// Everything still open in the last set of minutes, offered for the register —
// each item checked against the register, so a continuing matter is offered as
// an update to it rather than as a second entry.
router.get('/matters/from/:docId', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  const found = annotateAgainstRegister(doc, SM.mattersFromDoc(doc)).filter(m => !m.already);
  res.json({ date: doc.date, found });
});

router.post('/matters/from/:docId', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.docId);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  const have = new Set(db.findAll('session_matters', m => Number(m.raisedIn) === Number(doc.id)).map(m => String(m.subject || '').trim().toLowerCase()));
  const wanted = Array.isArray(req.body.matters) ? req.body.matters : annotateAgainstRegister(doc, SM.mattersFromDoc(doc));
  const added = [], updated = [];
  const who = actor(req).userName;
  const order = ['open', 'in-progress', 'decided', 'closed'];
  wanted.forEach(m => {
    // An update to a matter the Session is already carrying.
    const target = m.updateOf && !m.asNew ? db.findById('session_matters', Number(m.updateOf.id)) : null;
    if (target) {
      if ((target.updates || []).some(u => Number(u.meetingId) === Number(doc.id))) return;   // already updated from these minutes
      const note = clean(m.detail, 4000) || clean(m.subject, 200);
      const st = order.includes(m.status) ? m.status : '';
      updated.push(db.mutate('session_matters', target.id, cur => {
        const next = {
          ...cur,
          updates: [...(cur.updates || []), { date: doc.date || '', meetingId: doc.id, note, by: who }],
          lastReviewedAt: doc.date || cur.lastReviewedAt,
        };
        // Only ever moves a matter FORWARD. A reading that calls it "open"
        // again does not undo progress already recorded.
        if (st && order.indexOf(st) > order.indexOf(cur.status || 'open')) {
          next.status = st;
          if (st === 'closed') next.closedAt = doc.date || new Date().toISOString().slice(0, 10);
        }
        return next;
      }));
      return;
    }
    const subject = clean(m.subject, 200);
    if (!subject || have.has(subject.toLowerCase())) return;
    have.add(subject.toLowerCase());
    added.push(db.insert('session_matters', {
      // The heading the matter was gathered under in those minutes. Without
      // this the entry reaches the register headless and the next agenda lists
      // it as its own line, which is the thing headings exist to prevent.
      heading: SM.headingFor(clean(m.heading, 200), subject, clean(m.detail, 4000)),
      subject,
      detail: clean(m.detail, 4000),
      owner: SM.resolveName(roster(), clean(m.owner, 160)),
      due: /^\d{4}-\d{2}-\d{2}$/.test(clean(m.due, 10)) ? clean(m.due, 10) : '',
      raisedAt: doc.date || '',
      raisedIn: doc.id,
      status: ['open', 'in-progress', 'decided'].includes(m.status) ? m.status : 'open',
      decision: '', closedAt: '', updates: [],
      raisedBy: who,
    }));
  });
  logActivity({ ...actor(req), action: `Brought ${added.length} new matter${added.length === 1 ? '' : 's'} into the Session register and updated ${updated.length}`, entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
  res.json({ added: added.length, updated: updated.length, matters: added.map(matterOut), updatedMatters: updated.map(matterOut) });
});

router.get('/pod', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const list = db.findAll('pod_roster')
    .sort((a, b) => (b.year - a.year) || (b.half - a.half))
    .map(r => ({
      id: r.id, year: r.year, half: r.half, label: SM.halfLabel(r.year, r.half),
      entries: r.entries || [], file: r.file || null,
      sundays: SM.sundaysInHalf(r.year, r.half).length,
      uploadedBy: r.uploadedBy, updatedAt: r.updatedAt || r.createdAt,
    }));
  res.json(list);
});


router.post('/', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const date = clean(req.body.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A valid meeting date is required.' });
  if (db.findOne('minutes_docs', d => d.date === date && d.kind === 'session')) {
    return res.status(409).json({ error: 'Minutes already exist for that date.' });
  }
  const mk = SM.meetingKind(clean(req.body.meetingKind, 20));
  const typed = clean(req.body.title, 120);
  const doc = SM.newMinutesDoc({
    date,
    meetingKind: mk.key,
    venue: clean(req.body.venue, 160) || defaultVenue(),
    // A title the Clerk wrote himself is kept; otherwise the kind names it, so
    // an emergency sitting is headed as one everywhere it appears.
    title: typed || mk.label,
    startTime: clean(req.body.startTime, 5) || '18:30',
    meetingId: Number(req.body.meetingId) || null,
  });
  const rec = db.insert('minutes_docs', { ...doc, recordedBy: actor(req).userName });
  logActivity({ ...actor(req), action: 'Started Session minutes', entityType: 'minutes', entityId: rec.id, entityLabel: date });
  res.status(201).json(rec);
});

// Letters visitors brought that were received at an EARLIER meeting: their
// item number in those minutes and that meeting's date, for the sentence
// "Their letter was received at the meeting of … (item 7.3 of those minutes)."
function earlierLettersFor(doc) {
  const out = {};
  const groups = ((doc && doc.proceedings && doc.proceedings.visitors) || []).filter(g => g && g.letterId);
  groups.forEach(g => {
    const c = db.findById('correspondence', g.letterId);
    if (!c || !c.minutesId || Number(c.minutesId) === Number(doc.id)) return;
    const d = db.findById('minutes_docs', c.minutesId);
    if (!d) return;
    let no = '';
    try {
      const list = correspondenceFor(d.id);
      const rows = SM.renderRows(d, { correspondence: list, members: roster() }) || [];
      const sec = rows.find(r => r.level === 0 && /^correspondence$/i.test(String(r.subject || '').trim()));
      // Every letter prints, in register order (an untitled one as "Correspondence").
      const i = list.findIndex(x => Number(x.id) === Number(c.id));
      if (sec && i >= 0) no = `${sec.no.replace(/\.0$/, '')}.${i + 1}`;
    } catch (e) { /* the date alone still reads well */ }
    out[String(c.id)] = { no, date: d.date || '' };
  });
  return out;
}

function correspondenceFor(id) {
  return db.findAll('correspondence', c => Number(c.minutesId) === Number(id))
    .sort((a, b) => (a.order || 0) - (b.order || 0) || a.id - b.id);
}

// ---- Composition: who sits on the Session, and how they attend --------------
// One call for the Composition page: the roster in rank order, each person's
// attendance record across Session meetings, and any co-option whose term has
// run out (surfaced for the Clerk to decide on, never auto-removed).
router.get('/composition', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const members = db.findAll('session_members').sort(SM.byRank);
  let th = 4;
  try { th = require('../utils/attendanceStats').threshold(); } catch (e) {}
  const docs = db.findAll('minutes_docs', d => d.kind === 'session');
  const tally = SM.sessionAttendance(docs, members.filter(m => m.active !== false), th);
  const today = new Date().toISOString().slice(0, 10);
  res.json({
    members: members.map(m => ({
      ...m,
      office: SM.officeOf(m),
      officeLabel: (SM.officeByKey(SM.officeOf(m)) || {}).label || '',
      titles: SM.titlesOf(m),
      displayName: SM.displayName(m),
      proseName: SM.proseName(m),
      needsTitle: SM.needsTitle(m),
      // What moving the title out of the name would produce, so the Clerk can
      // see it before agreeing to it.
      titleSplit: (() => { const d = SM.splitName(m.name); return d.titles.length ? d : null; })(),
      memberKind: SM.memberKind(m),
      coOptionNote: SM.coOptionNote(m),
      coOptionExpired: SM.coOptionExpired(m, today),
    })),
    // Who holds what. Vacant offices are listed too — a Session with no Senior
    // Presbyter recorded is a thing the Clerk should be able to see.
    offices: SM.officeTable(members),
    tally,
    canEdit: canEdit(req),
  });
});

// ---- Search every minute ever recorded --------------------------------------
// Declared before the /:id routes so "search" is not read as a document id.
router.get('/search', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const q = String(req.query.q || '').trim().toLowerCase();
  if (q.length < 2) return res.json([]);
  const snippet = (text, term) => {
    const s = String(text || '');
    const i = s.toLowerCase().indexOf(term);
    if (i === -1) return s.slice(0, 180);
    return (i > 40 ? '…' : '') + s.slice(Math.max(0, i - 40), i + 140) + (s.length > i + 140 ? '…' : '');
  };
  const hits = [];
  db.findAll('minutes_docs').forEach(d => {
    const rows = SM.renderRows(d, { correspondence: correspondenceFor(d.id), members: roster(), earlierLetters: earlierLettersFor(d) });
    rows.forEach(r => {
      if (`${r.subject} ${r.body} ${r.action}`.toLowerCase().includes(q)) {
        hits.push({
          minutesId: d.id, date: d.date, title: d.title, no: r.no,
          subject: r.subject, snippet: snippet(`${r.subject}. ${r.body}`, q),
        });
      }
    });
  });
  hits.sort((a, b) => String(b.date).localeCompare(String(a.date)) || String(a.no).localeCompare(String(b.no)));
  res.json(hits.slice(0, 120));
});

// (Before '/:id', which would otherwise take these paths.)
// The corrections-per-1,000-words figure for every proofread meeting — the
// measure of whether the gap is closing.
router.get('/proofreads/trend', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const byDoc = new Map();
  db.findAll('minutes_proofreads').forEach(r => { const k = Number(r.docId); if (!byDoc.has(k) || r.uploadedAt > byDoc.get(k).uploadedAt) byDoc.set(k, r); });
  res.json([...byDoc.values()].map(prOut).map(r => ({ date: r.date, docId: r.docId, proofreader: r.proofreader, words: r.words, corrections: r.corrections, rate: r.rate }))
    .sort((a, b) => String(a.date).localeCompare(String(b.date))));
});
router.get('/house-rules', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  res.json(db.findAll('house_style_rules').sort((a, b) => String(b.approvedAt).localeCompare(String(a.approvedAt))));
});

router.get('/:id', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  const prev = previousDoc(doc);
  const el = SM.eligibility(doc, prev);
  const all = membersFor(doc).map(m => ({ ...m, position: positionOn(m, doc.date) }));
  // Names offered for the prose take the running-text form — "Rev Dr Martin
  // Owusu Boamah" — because that is what a sentence of the minutes says. The
  // printed roster block brackets the academic title instead; see minutesData.
  const pick = ids => ids.map(i => all.find(m => m.id === i)).filter(Boolean).sort(SM.byRank)
    .map(m => ({ id: m.id, name: SM.proseName(m), position: m.position }));
  const finance = doc.finance && SM.hasFinanceFigures(doc.finance)
    ? { grid: SM.financeGrid(doc.finance), warnings: SM.computeFinance(doc.finance).warnings } : null;
  res.json({
    doc,
    // Office and standing are derived, so a roster entered before offices
    // existed still classifies correctly without a migration.
    // displayName is the listing form (brackets); proseName is what a sentence
    // of the minutes says. Pages pick whichever they are writing.
    roster: all.map(m => ({ ...m, office: SM.officeOf(m), memberKind: SM.memberKind(m),
      displayName: SM.displayName(m), proseName: SM.proseName(m) })),
    correspondence: correspondenceFor(doc.id),
    // The offices, so the agenda can be assigned to a post rather than a
    // person: "Constitution of the Session — District Minister" holds true
    // after the minister changes.
    offices: SM.OFFICES.map(o => ({ key: o.key, label: o.label, constitutional: o.constitutional })),
    // Which minutes may be reviewed tonight: what the agenda names, then the
    // earlier sittings the app holds.
    reviewOptions: SM.reviewOptions(doc, db.findAll('minutes_docs', d => d.kind === 'session' && d.date < doc.date)
      .sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 10)),
    agenda: SM.computeAgenda(doc.agenda || [], doc.startTime),
    aiEnabled: ai.isConfigured(),
    canEdit: canEdit(req) && !doc.locked,
    canConfirm: isAdmin(req) || req.user.role === 'minister',
    eligibility: {
      present: pick(el.todayIds), adoption: pick(el.adoptionIds), ineligible: pick(el.ineligibleIds),
      // Only an agent may chair, so only an agent may constitute the Session.
      // Every agent is offered, not just those on tonight's roll — the meeting
      // is arranged long before anyone knows who can come.
      agents: SM.agentsOf(all).map(m => ({ id: m.id, name: SM.proseName(m), position: m.position })),
      // The Linguist normally introduces visitors; offered first when present.
      linguist: (m => m ? { id: m.id, name: SM.proseName(m), position: m.position } : null)(SM.linguistOf(all)),
      // A separate list for every earlier meeting, because the adoption of each
      // set of minutes may only be moved by someone who was actually at THAT
      // meeting — and a sitting may review more than one set.
      adoptionByDate: db.findAll('minutes_docs', d => d.kind === 'session' && d.date < doc.date)
        .sort((a, b) => String(b.date).localeCompare(String(a.date)))
        .slice(0, 8)
        .reduce((acc, prev) => {
          const then = SM.presentIdsOf(prev);
          acc[prev.date] = [...SM.presentIdsOf(doc)].filter(i => then.has(i))
            .map(i => all.find(m => m.id === i)).filter(Boolean).sort(SM.byRank)
            .map(m => ({ id: m.id, name: SM.proseName(m), position: m.position }));
          return acc;
        }, {}),
    },
    previous: prev ? { id: prev.id, date: prev.date, adopted: prev.adopted || null, locked: !!prev.locked } : null,
    carryForward: prev ? SM.openItemsOf(prev) : [],
    finance,
    // The presbyters rostered for the week of this meeting — they take the
    // devotion, so the agenda and the devotion line can be filled from here.
    onDuty: (() => {
      // Matched back to the Session roster so the devotion line addresses them
      // the way the congregation does.
      const names = SM.titledNames(onDutyFor(doc.date), all);
      return { names, label: SM.podLabel(names), sunday: SM.sundayOnOrBefore(doc.date), hasRoster: !!podPeriod(doc.date) };
    })(),
  });
});

// Patch any part of the document. Sections/agenda/roll are replaced wholesale
// (the editor always sends the current full array); everything else merges.
router.put('/:id', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  // Once the Session has adopted minutes they are the signed record — reopening
  // is no longer the clerk's to do, and a correction must be tabled at a
  // meeting instead.
  if (doc.locked) {
    return res.status(400).json({ error: 'These minutes have been adopted by the Session and can no longer be altered. Table any correction at the next meeting.' });
  }
  if (doc.status === 'final' && !req.body.reopen) {
    return res.status(400).json({ error: 'These minutes are final. Reopen them before editing.' });
  }
  const b = req.body || {};
  const updated = db.mutate('minutes_docs', doc.id, cur => {
    const next = { ...cur };
    ['title', 'venue', 'date', 'startTime'].forEach(k => { if (b[k] !== undefined) next[k] = clean(b[k], 160); });
    // Changing the kind renames the meeting too, unless the Clerk has given it
    // a title of his own — which meetingTitleOf leaves alone.
    if (b.meetingKind !== undefined) {
      const k = SM.meetingKind(clean(b.meetingKind, 20));
      next.meetingKind = k.key;
      if (b.title === undefined && SM.meetingTitleOf({ ...cur, meetingKind: k.key }) === k.label) {
        next.title = k.label;
      }
    }
    if (b.meetingId !== undefined) next.meetingId = Number(b.meetingId) || null;
    if (b.proceedings && typeof b.proceedings === 'object') {
      next.proceedings = { ...(cur.proceedings || {}) };
      Object.keys(b.proceedings).forEach(k => { next.proceedings[k] = clean(b.proceedings[k], 300); });
    }
    if (Array.isArray(b.sections)) {
      // An Action may carry who is responsible and by when, so it can be
      // followed up and carried into the next meeting. Only the action TEXT is
      // ever printed — the rest is tracking.
      const rowFields = r => ({
        subject: clean(r.subject, 200),
        body: clean(r.body, 20000),
        action: clean(r.action, 2000),
        actionResponsible: clean(r.actionResponsible, 160),
        actionDate: clean(r.actionDate, 10),
        actionStatus: ['open', 'done'].includes(r.actionStatus) ? r.actionStatus : 'open',
        deferred: !!r.deferred,
        ...tidyMarks(r),
      });
      next.sections = b.sections.map(s => ({
        key: clean(s.key, 40),
        enabled: !!s.enabled,
        ...rowFields(s),
        children: (Array.isArray(s.children) ? s.children : []).map(c => ({
          ...rowFields(c),
          // Where a carried-forward item came from, shown as context in the
          // editor and never printed.
          carriedFrom: c.carriedFrom && c.carriedFrom.date ? {
            minutesId: Number(c.carriedFrom.minutesId) || null,
            date: clean(c.carriedFrom.date, 10),
            no: clean(c.carriedFrom.no, 12),
            text: clean(c.carriedFrom.text, 500),
            deferred: !!c.carriedFrom.deferred,
          } : undefined,
        })),
      }));
    }
    if (Array.isArray(b.agenda)) {
      next.agenda = b.agenda.map(r => ({
        mins: Number(r.mins) > 0 ? Number(r.mins) : 0,
        item: clean(r.item, 200),
        responsible: clean(r.responsible, 160),
        subItems: (Array.isArray(r.subItems) ? r.subItems : []).map(s => ({
          item: clean(s.item, 200), responsible: clean(s.responsible, 160),
        })).filter(s => s.item),
      })).filter(r => r.item);
    }
    if (Array.isArray(b.reviews)) next.reviews = cleanReviews(b.reviews);
    if (Array.isArray(b.appendices)) {
      next.appendices = b.appendices.map(a => ({ title: clean(a.title, 300), body: clean(a.body, 60000) }));
    }
    // A locked roll is never rewritten by a whole-document save.
    if (b.roll && typeof b.roll === 'object' && !(cur.roll && cur.roll.locked)) {
      const ids = v => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(Boolean))];
      const presentIds = ids(b.roll.presentIds);
      const apologyIds = ids(b.roll.apologyIds).filter(i => !presentIds.includes(i));
      const known = new Set([...presentIds, ...apologyIds]);
      // Anyone on the roster who is neither present nor apologising is absent.
      const absentIds = membersFor({ ...cur, date: next.date || cur.date, roll: { presentIds, apologyIds } }).map(m => m.id).filter(i => !known.has(i));
      next.roll = {
        locked: false,
        presentIds, apologyIds, absentIds,
        onlineIds: ids(b.roll.onlineIds).filter(i => presentIds.includes(i)),
        guests: (Array.isArray(b.roll.guests) ? b.roll.guests : [])
          .map(g => ({ name: clean(g.name, 120), position: clean(g.position, 60) || 'In attendance', ...(clean(g.details, 300) ? { details: clean(g.details, 300) } : {}) }))
          .filter(g => g.name),
      };
    }
    if (b.reopen) next.status = 'draft';
    return next;
  });
  res.json(updated);
});

// The Session meeting immediately before this one, by date — the meeting whose
// minutes are under review, and the source of anything carried forward.
function previousDoc(doc) {
  return db.findAll('minutes_docs', d =>
    d.id !== doc.id && d.kind === doc.kind && String(d.date) < String(doc.date))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))[0] || null;
}

// Who may take each part tonight. Adoption of the previous minutes is limited
// to people who were at THAT meeting and are also here now.
router.get('/:id/eligibility', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  const prev = previousDoc(doc);
  const el = SM.eligibility(doc, prev);
  const all = roster();
  const pick = ids => ids.map(i => all.find(m => m.id === i)).filter(Boolean).sort(SM.byRank)
    .map(m => ({ id: m.id, name: m.name, position: m.position }));
  const asPerson = m => ({ id: m.id, name: SM.proseName(m), position: m.position });
  res.json({
    present: pick(el.todayIds),
    adoption: pick(el.adoptionIds),
    ineligible: pick(el.ineligibleIds),
    // Only an agent may chair, and so only an agent may constitute the Session.
    // Not filtered by tonight's roll: a meeting is arranged well before anyone
    // knows which of the ministers will be able to come.
    agents: SM.agentsOf(all).map(asPerson),
    linguist: (m => m ? asPerson(m) : null)(SM.linguistOf(all)),
    previous: prev ? { id: prev.id, date: prev.date, present: (prev.roll && prev.roll.presentIds || []).length } : null,
  });
});

// ---- Corrections to the minutes under review -------------------------------
router.put('/:id/corrections', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  const list = (Array.isArray(req.body.corrections) ? req.body.corrections : []).map(c => ({
    ref: clean(c.ref, 12), where: clean(c.where, 160),
    was: clean(c.was, 500), now: clean(c.now, 500), note: clean(c.note, 500),
  }));
  res.json(db.update('minutes_docs', doc.id, { corrections: list }));
});

// Apply one correction to the stored text of the previous minutes, so the
// corrected Word can simply be regenerated instead of retyped. Scoped to that
// document's own sections — never to the roster, which other minutes share.
// A correction belongs to one reviewed set of minutes, so it is addressed by
// which block it is in and which correction within that block — and it is
// applied to THAT meeting's minutes, not simply to the previous ones.
// The older path, without a block, still works and means the first block —
// which is what a document recorded before multiple reviews existed has.
router.post('/:id/corrections/:idx/apply', requireAuth, (req, res) => {
  req.params.block = '0';
  return applyCorrection(req, res);
});
router.post('/:id/corrections/:block/:idx/apply', requireAuth, applyCorrection);

function applyCorrection(req, res) {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  const blocks = SM.reviewBlocks(doc);
  const block = blocks[Number(req.params.block)];
  if (!block) return res.status(404).json({ error: 'That set of minutes is not recorded as reviewed.' });
  const c = (block.corrections || [])[Number(req.params.idx)];
  if (!c) return res.status(404).json({ error: 'Correction not found.' });
  // The minutes this correction is against: matched on the date the clerk
  // typed, falling back to the previous sitting when it cannot be matched.
  const raw = (Array.isArray(doc.reviews) ? doc.reviews : [])[Number(req.params.block)] || {};
  const wanted = String(block.date || '').trim().toLowerCase();
  const target = (raw.iso ? db.findOne('minutes_docs', d => d.kind === 'session' && d.date === raw.iso) : null)
    || (wanted
    ? db.findAll('minutes_docs', d => d.kind === 'session' && d.id !== doc.id)
        .find(d => {
          const dt = toLocalDate(d.date);
          if (isNaN(dt)) return false;
          const long = dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).toLowerCase();
          return wanted === long
            || (wanted.includes(String(dt.getDate())) && wanted.includes(long.split(' ')[1]) && wanted.includes(String(dt.getFullYear())));
        })
    : null) || previousDoc(doc);
  if (!target) return res.status(400).json({ error: 'Those minutes are not in the app, so there is nothing to correct here.' });
  if (target.locked) return res.status(400).json({ error: 'Those minutes are locked as adopted and can no longer be altered.' });
  const was = (c.was || '').trim();
  const now = (c.now || '').trim();
  if (!was) return res.status(400).json({ error: 'This correction has no “from” text to look for.' });

  let hits = 0;
  const swap = s => {
    const str = String(s == null ? '' : s);
    if (!str.includes(was)) return str;
    hits += str.split(was).length - 1;
    return str.split(was).join(now);
  };
  const sections = (target.sections || []).map(s => ({
    ...s,
    subject: swap(s.subject), body: swap(s.body), action: swap(s.action),
    children: (s.children || []).map(ch => ({ ...ch, subject: swap(ch.subject), body: swap(ch.body), action: swap(ch.action) })),
  }));
  if (!hits) {
    return res.status(404).json({ error: `“${was}” does not appear in the minutes of ${target.date}. Please make that correction by hand.` });
  }
  db.update('minutes_docs', target.id, { sections });
  logActivity({ ...actor(req), action: `Applied a correction to the minutes of ${target.date}`, entityType: 'minutes', entityId: target.id, entityLabel: target.date });
  res.json({ ok: true, replacements: hits, targetId: target.id, targetDate: target.date });
}


// ---- Adoption: close the loop on the earlier minutes ------------------------
router.post('/:id/adopt-previous', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  const target = previousDoc(doc);
  if (!target) return res.status(400).json({ error: 'There are no earlier minutes in the app to adopt.' });
  const p = doc.proceedings || {};
  if (!p.minutesMovedBy || !p.minutesSecondedBy) {
    return res.status(400).json({ error: 'Record who moved and who seconded the adoption first.' });
  }
  // Records only THAT the Session adopted these minutes, and who moved and
  // seconded — never when. The date of adoption belongs to the reviewing
  // meeting's own minutes (its Adoption item); stamping it onto this document
  // would put a second date on a record already dated by its own meeting.
  const updated = db.update('minutes_docs', target.id, {
    adopted: { movedBy: p.minutesMovedBy, secondedBy: p.minutesSecondedBy },
    locked: true,
    status: 'final',
  });
  logActivity({ ...actor(req), action: `Recorded adoption of the minutes of ${target.date}`, entityType: 'minutes', entityId: target.id, entityLabel: target.date });
  res.json({ ok: true, adopted: updated.adopted, targetId: target.id, targetDate: target.date });
});

// The Minister-in-Charge confirms the record — the "Confirmed by" line becomes
// a real approval rather than only a printed name.
router.post('/:id/confirm', requireAuth, (req, res) => {
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  const allowed = isAdmin(req) || req.user.role === 'minister';
  if (!allowed) return res.status(403).json({ error: 'Only the Minister-in-Charge or an administrator can confirm minutes.' });
  const a = actor(req);
  res.json(db.update('minutes_docs', doc.id, {
    confirmation: { byUserId: a.userId, byName: a.userName, at: new Date().toISOString() },
  }));
});

// ---- Carry-forward ---------------------------------------------------------
// Anything still open last time meets the Session again: open action points and
// items that were deferred become Matters Arising sub-items and agenda entries.
router.get('/:id/carry-forward', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  const prev = previousDoc(doc);
  res.json({
    previous: prev ? { id: prev.id, date: prev.date } : null,
    items: prev ? SM.openItemsOf(prev) : [],
  });
});

router.post('/:id/carry-forward', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  const prev = previousDoc(doc);
  if (!prev) return res.status(400).json({ error: 'There are no earlier minutes to carry anything forward from.' });
  const wanted = Array.isArray(req.body.items) ? req.body.items : SM.openItemsOf(prev);
  if (!wanted.length) return res.json({ doc, added: 0 });

  const updated = db.mutate('minutes_docs', doc.id, cur => {
    const next = { ...cur };
    next.sections = (cur.sections || []).map(s => ({ ...s, children: (s.children || []).slice() }));
    const matters = next.sections.find(s => s.key === 'matters');
    if (!matters) return next;
    let added = 0;
    wanted.forEach(it => {
      const subject = clean(it.subject, 200) || clean(it.action, 200);
      if (!subject) return;
      if (matters.children.some(c => (c.subject || '').toLowerCase() === subject.toLowerCase())) return;
      matters.children.push({
        subject, body: '', action: '',
        carriedFrom: { minutesId: prev.id, date: prev.date, no: clean(it.no, 12), text: clean(it.action, 500), deferred: !!it.deferred },
      });
      added += 1;
    });
    // Mirror them onto the agenda so the paper matches the meeting.
    next.agenda = (cur.agenda || []).slice();
    let row = next.agenda.find(r => /matters arising/i.test(r.item || ''));
    if (!row) { row = { mins: 15, item: 'Matters Arising', responsible: '', subItems: [] }; next.agenda.splice(Math.min(4, next.agenda.length), 0, row); }
    row.subItems = row.subItems || [];
    wanted.forEach(it => {
      const subject = clean(it.subject, 200) || clean(it.action, 200);
      if (subject && !row.subItems.some(s => (s.item || '').toLowerCase() === subject.toLowerCase())) {
        row.subItems.push({ item: subject, responsible: clean(it.responsible, 160) });
      }
    });
    next._added = added;
    return next;
  });
  res.json({ doc: updated, added: updated._added || 0 });
});

// ---- Presbyters on Duty roster ---------------------------------------------
// Uploaded half a year at a time. The pair on duty for the week of a meeting
// take the devotion, so the agenda and the minutes fill themselves from here.
function podPeriod(dateISO) {
  const year = Number(String(dateISO || '').slice(0, 4));
  if (!year) return null;
  const half = SM.halfOf(dateISO);
  return db.findOne('pod_roster', r => Number(r.year) === year && Number(r.half) === half) || null;
}
function onDutyFor(dateISO) {
  const period = podPeriod(dateISO);
  return period ? SM.podOnDuty(period.entries, dateISO) : [];
}

// Who is on duty for a given date (defaults to a minutes document's own date).
router.get('/pod/on-duty', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const date = clean(req.query.date, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'A valid date is required.' });
  const names = onDutyFor(date);
  res.json({ date, sunday: SM.sundayOnOrBefore(date), names, label: SM.podLabel(names) });
});

// Read an uploaded roster — nothing is saved until the clerk confirms it.
router.post('/pod/read', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  upload.array('roster', MAX_PAGES)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'One of those files is larger than 12 MB.' : err.message });
    if (badTypes(req.files)) {
      return res.status(400).json({ error: 'Please upload the roster pages as JPG, PNG or PDF.' });
    }
    try {
      const year = Number(req.body.year) || new Date().getFullYear();
      const half = Number(req.body.half) === 2 ? 2 : 1;
      const read = await ai.readPodRoster({ files: req.files, year, half });
      // Point out any Sunday in the half-year the roster does not cover.
      const covered = new Set(read.entries.map(e => e.date));
      const missing = SM.sundaysInHalf(year, half).filter(d => !covered.has(d));
      res.json({ ...read, missing });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'Could not read the roster.' });
    }
  });
});

// Save (or replace) a half-year's roster.
router.post('/pod', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  upload.array('roster', MAX_PAGES)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'One of those files is larger than 12 MB.' : err.message });
    const year = Number(req.body.year) || 0;
    const half = Number(req.body.half) === 2 ? 2 : 1;
    if (!year) return res.status(400).json({ error: 'A year is required.' });
    let entries = req.body.entries;
    if (typeof entries === 'string') { try { entries = JSON.parse(entries); } catch (e) { entries = []; } }
    const lo = `${year}-${half === 2 ? '07' : '01'}-01`;
    const hi = `${year}-${half === 2 ? '12-31' : '06-30'}`;
    // Duty runs Sunday to Sunday, and the lookup keys on the Sunday of the
    // meeting's week — so an entry dated to any other day could never match.
    // Drop those rather than storing something that silently never applies.
    const raw = (Array.isArray(entries) ? entries : []).map(e => ({
      date: clean(e.date, 10),
      names: (Array.isArray(e.names) ? e.names : []).map(n => clean(n, 120)).filter(Boolean).slice(0, 4),
    })).filter(e => e.names.length);
    const cleaned = raw
      .filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date >= lo && e.date <= hi && isSunday(e.date))
      .sort((a, b) => a.date.localeCompare(b.date));
    const dropped = raw.length - cleaned.length;

    if (badTypes(req.files)) return res.status(400).json({ error: 'Please upload the roster pages as JPG, PNG or PDF.' });
    const stored = storePages(req.files, `pod-${year}-H${half}`);
    const file = stored[0] || null;

    const existing = db.findOne('pod_roster', r => Number(r.year) === year && Number(r.half) === half);
    const payload = { year, half, entries: cleaned, uploadedBy: actor(req).userName };
    if (stored.length) { payload.files = stored; payload.file = file; }
    const saved = existing
      ? db.update('pod_roster', existing.id, payload)
      : db.insert('pod_roster', { ...payload, files: stored, file: file || null });
    logActivity({ ...actor(req), action: `Saved the Presbyters on Duty roster for ${SM.halfLabel(year, half)}`, entityType: 'pod', entityId: saved.id, entityLabel: SM.halfLabel(year, half) });
    res.json({ ...saved, dropped });
  });
});

router.delete('/pod/:id', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const rec = db.findById('pod_roster', req.params.id);
  if (!rec) return res.status(404).json({ error: 'Roster not found.' });
  if (rec.file && rec.file.filename) { try { fs.unlinkSync(path.join(FILES_DIR, path.basename(rec.file.filename))); } catch (e) {} }
  db.remove('pod_roster', rec.id);
  res.json({ ok: true });
});

router.get('/pod/:id/file', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const rec = db.findById('pod_roster', req.params.id);
  if (!rec || !rec.file) return res.status(404).json({ error: 'No roster file stored.' });
  const fp = path.join(FILES_DIR, path.basename(rec.file.filename));
  if (!fs.existsSync(fp)) return res.status(410).json({ error: 'The roster file is missing on the server.' });
  res.setHeader('Content-Type', rec.file.mimetype || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(rec.file.originalName || rec.file.filename).replace(/"/g, '')}"`);
  res.send(fs.readFileSync(fp));
});

// ---- Put the Session meeting on the Meetings page --------------------------
// Creates (or updates) an ordinary meeting record so a Session meeting is
// scheduled and visible alongside committee and group meetings, without
// touching the meetings module's own code. Attendance for the Session is still
// kept here, on the Roll tab.
router.post('/:id/schedule', requireAuth, async (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(doc.date || ''))) {
    return res.status(400).json({ error: 'Set the meeting date first.' });
  }
  const time = clean(req.body.time, 5) || (doc.startTime || '18:30');
  const durationMins = Number(req.body.durationMins) || 120;
  const agendaText = SM.computeAgenda(doc.agenda || [], doc.startTime)
    .map((r, i) => `${i + 1}. ${r.item}${r.label ? ` — ${r.label}` : ''}`).join('\n');
  const quarterOf = d => Math.floor(new Date(d).getMonth() / 3) + 1;
  const isPast = new Date(`${doc.date}T${time}`) < new Date();

  const payload = {
    entityType: 'congregation', entityId: 0,
    entityName: 'Session',
    title: doc.title || 'Session Meeting',
    date: doc.date, time, durationMins,
    // Resolved against the shared venue book so the Meetings page can spot a
    // clash on the hall; the name is what prints in the notice and the agenda.
    venueId: venueIdFor(doc.venue), venueName: doc.venue || '',
    mode: 'in-person', link: '',
    agenda: agendaText,
    kind: 'congregation',
    // The Session is its own body; its roll is kept on the minutes document,
    // so this record carries no derived audience roster.
    audience: 'leaders', audienceEntities: null,
    year: Number(String(doc.date).slice(0, 4)), quarter: quarterOf(doc.date),
    status: isPast ? 'held' : 'scheduled',
    conflicts: null,
    createdBy: actor(req).userName,
    sessionMinutesId: doc.id,
  };

  const existing = doc.meetingId ? db.findById('meetings', doc.meetingId) : null;
  let meeting;
  if (existing) {
    meeting = db.update('meetings', existing.id, {
      ...payload,
      // never clobber attendance or an uploaded minutes PDF held on the meeting
      attendance: existing.attendance, minutes: existing.minutes,
    });
  } else {
    meeting = db.insert('meetings', { ...payload, attendance: null, minutes: null });
    db.update('minutes_docs', doc.id, { meetingId: meeting.id });
  }
  logActivity({ ...actor(req), action: existing ? 'Updated the Session meeting' : 'Scheduled the Session meeting', entityType: 'meeting', entityId: meeting.id, entityLabel: `Session ${doc.date}` });

  // Tell the Session it has been called — the same notice a committee gets when
  // its meeting is scheduled. Only on the first scheduling, or when the WHEN or
  // WHERE actually changes: pressing the button again to pick up an agenda edit
  // must not text everybody a second time. Never blocks scheduling.
  const movedOrChanged = existing && (
    existing.date !== payload.date || existing.time !== payload.time ||
    (existing.venueName || '') !== (payload.venueName || ''));

  // Notifying is now the caller's decision, because a meeting is often put in
  // the diary before the Session is ready to be told:
  //   notify === false  → stay quiet, whatever changed
  //   notify === true   → send now, even if nothing changed (the Clerk asked)
  //   omitted           → the old behaviour: first scheduling, or a move
  const want = req.body.notify;
  const shouldNotify = want === false ? false
    : want === true ? true
    : (!existing || movedOrChanged);

  let notified = null;
  if (!isPast && shouldNotify) {
    try {
      notified = await noticeToSession(doc, meeting, !!existing);
      db.update('minutes_docs', doc.id, {
        noticeSentAt: new Date().toISOString(),
        noticeSentBy: actor(req).userName,
      });
    } catch (e) { console.error('[session-meeting] notice failed:', e.message); }
  }
  res.json({
    ok: true, meeting, updated: !!existing, notified,
    quiet: !shouldNotify,
    // a meeting already in the past is never announced, however the button was pressed
    tooLate: shouldNotify && isPast,
  });
});

// The Session's own contacts: its roster's phones and emails, plus a push to
// the Clerk's login. Members are not app users, so SMS is the main channel —
// which is why the roster carries a phone field.
function sessionContacts() {
  const phones = new Set(); const emails = new Set();
  roster().forEach(m => {
    if ((m.phone || '').trim()) phones.add(m.phone.trim());
    if ((m.email || '').trim()) emails.add(m.email.trim());
  });
  let userIds = [];
  try { userIds = push.userIdsWithPermission('approvals.manage', 'session.manage'); } catch (e) { userIds = []; }
  return { phones: [...phones], emails: [...emails], userIds };
}

async function noticeToSession(doc, meeting, isUpdate) {
  const when = toLocalDate(doc.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const where = meeting.venueName || 'venue to be confirmed';
  const title = meeting.title || 'Session Meeting';
  // Most of the Session are not app users, so the notice says where the agenda
  // really goes. Editable under AOTC Session → Meetings.
  const agendaNote = agendaNoteLine();
  const msg = `PCG-AOTC: ${isUpdate ? 'Changed' : 'Notice of'} meeting — ${title} on ${when} at ${meeting.time}, ${where}.`
    + (agendaNote ? ` ${agendaNote}` : '');
  const { phones, emails, userIds } = sessionContacts();

  let sms = 0, mails = 0, pushes = 0;
  for (const to of phones.slice(0, 60)) {
    try { const r = await sendSms({ to, message: msg }); if (r && !r.skipped && !r.error) sms += 1; } catch (e) {}
  }

  // Email can carry the agenda itself, so it does — a pointer to somewhere else
  // is no use to someone reading on their phone. A failure here must never stop
  // the notice going out.
  let attachments;
  if ((doc.agenda || []).length) {
    try {
      const buf = await buildSessionAgendaPdf(agendaData(doc));
      attachments = [{ filename: `${fileBase(doc, 'Agenda')}.pdf`, content: buf }];
    } catch (e) { console.error('[session-meeting] agenda attachment failed:', e.message); }
  }
  const html = `<p>Dear Member,</p><p>${isUpdate ? 'The details of the following meeting have changed.' : 'You are invited to the following meeting.'}</p>`
    + `<p><b>${title}</b><br>${when} at ${meeting.time}<br>${where}</p>`
    + (attachments ? '<p>The agenda is attached.</p>' : (agendaNote ? `<p>${escHtml(agendaNote)}</p>` : ''))
    + `<p>Yours in service,<br>The Session Clerk</p>`;
  for (const to of emails.slice(0, 60)) {
    try {
      const r = await sendMail({ to, subject: `${isUpdate ? 'Changed' : 'Notice of'} meeting — ${title}, ${when}`, html, attachments });
      if (!r || !r.error) mails += 1;
    } catch (e) {}
  }
  try {
    const r = await push.sendPushToUsers(userIds, { title: `${isUpdate ? 'Meeting changed' : 'Meeting called'}: ${title}`, body: msg, url: '/minutes.html' });
    pushes = (r && r.sent) || 0;
  } catch (e) {}
  return {
    sms, emails: mails, pushes, phones: phones.length,
    withoutPhone: roster().length - phones.length,
    agendaAttached: !!attachments,
  };
}

// ---- Church Finance --------------------------------------------------------
router.put('/:id/finance', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  const b = req.body || {};
  const accounts = (Array.isArray(b.accounts) && b.accounts.length ? b.accounts : SM.DEFAULT_ACCOUNTS)
    .map(a => ({ key: clean(a.key, 24).replace(/[^a-z0-9_]/gi, '').toLowerCase(), label: clean(a.label, 40) }))
    .filter(a => a.key && a.label);
  const keys = new Set(accounts.map(a => a.key));
  const values = {};
  SM.FINANCE_INPUTS.forEach(r => {
    values[r.key] = {};
    Object.entries((b.values || {})[r.key] || {}).forEach(([k, v]) => {
      if (keys.has(k) && v !== '' && v !== null && v !== undefined) values[r.key][k] = SM.num(v);
    });
  });
  const stated = {};
  ['opening', 'closing', 'payments'].forEach(k => {
    const v = (b.stated || {})[k];
    stated[k] = (v === '' || v === null || v === undefined) ? null : SM.num(v);
  });
  const finance = { asOf: clean(b.asOf, 10), accounts, values, stated, note: clean(b.note, 2000) };
  const updated = db.update('minutes_docs', doc.id, { finance });
  // Make sure the Reports section is on and has a Church Finance slot, so the
  // figures actually have somewhere to print.
  if (SM.hasFinanceFigures(finance)) {
    const sections = (updated.sections || []).map(s => {
      if (s.key !== 'reports') return s;
      const children = (s.children || []).slice();
      if (!children.some(c => /finance/i.test(c.subject || ''))) children.unshift({ subject: 'Church Finance', body: '', action: '' });
      return { ...s, enabled: true, children };
    });
    db.update('minutes_docs', doc.id, { sections });
  }
  const computed = SM.computeFinance(finance);
  res.json({ finance, grid: SM.financeGrid(finance), warnings: computed.warnings });
});

router.post('/:id/finance/read', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  upload.array('statement', MAX_PAGES)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'One of those files is larger than 12 MB.' : err.message });
    const doc = db.findById('minutes_docs', req.params.id);
    if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
    if (badTypes(req.files)) {
      return res.status(400).json({ error: 'Please upload the statement pages as JPG, PNG or PDF.' });
    }
    try {
      const accounts = (doc.finance && doc.finance.accounts) || SM.DEFAULT_ACCOUNTS;
      const read = await ai.readFinanceStatement({ files: req.files, accounts });
      // Show what the figures come to, and where they disagree with the
      // statement's own totals — reviewed by the clerk before anything saves.
      const trial = { ...(doc.finance || SM.newFinance()), accounts, values: read.values, stated: read.stated, asOf: read.asOf || (doc.finance && doc.finance.asOf) || '' };
      const computed = SM.computeFinance(trial);
      res.json({ read, grid: SM.financeGrid(trial), warnings: computed.warnings, unreadable: read.unreadable });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'Could not read the statement.' });
    }
  });
});

// ---- Rough notes → minute prose --------------------------------------------
// The self-writing opening of a section — "The meeting commenced at 6.32 p.m.
// Ing Kwaku Koranteng led the Session in devotion …" — for the sections that
// have one. Empty for every other section.
function autoLead(docId, sectionKey) {
  if (!docId || !sectionKey) return '';
  const doc = db.findById('minutes_docs', docId);
  if (!doc) return '';
  const p = SM.prosePeople(doc.proceedings || {}, roster());
  return SM.autoBody(sectionKey, p) || '';
}

router.post('/polish', requireAuth, async (req, res) => {
  if (!requireEdit(req, res)) return;
  try {
    const out = await ai.polishNotes({
      notes: req.body.notes,
      subject: req.body.subject,
      // The Session's own names, so short forms in the notes come back in full.
      // For a past sitting, the Session as it stood then — a transferred
      // minister is still named in full in the minutes of meetings he chaired.
      people: (() => { const d = req.body.docId && db.findById('minutes_docs', req.body.docId); return d ? membersFor(d) : roster(); })()
        .map(m => ({ full: SM.proseName(m), short: String(m.shortForm || '').trim() })),
      // The sentence the app has already written for this item, so the tidied
      // notes carry on from it instead of saying the same thing again. Computed
      // here rather than trusted from the browser, so it is always the sentence
      // that will actually be printed.
      lead: autoLead(req.body.docId, req.body.sectionKey)
        // The Visitors form sends what is already written for its group.
        || (req.body.sectionKey ? '' : clean(req.body.lead, 3000)),
      meetingDate: (() => { const d = req.body.docId && db.findById('minutes_docs', req.body.docId); return d ? d.date : ''; })(),
      // Rules the Clerk approved from proofreading — they apply at once.
      extraRules: db.findAll('house_style_rules', r => r.active !== false),
    });
    res.json(out);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not tidy those notes.' });
  }
});

// ---- Proofreading: tracked changes and comments back into the minutes ------
// (Oct 2026.) The proofreader returns the Word minutes with Track Changes and
// comments. Uploaded here, every change is matched to its item and the Clerk
// accepts or rejects it; every comment is put to the Clerk, who gives a
// directive (Claude carries it out on that paragraph, the Clerk checks it).
// Accepted text is written into the minutes in the app — the Word file is made
// from the app, so a correction kept only in Word would be lost on the next
// export. The corrections also feed proposed house-style rules, which the Clerk
// approves, and a corrections-per-1,000-words figure for each meeting.
const PR = require('../utils/proofread');
const docxUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function prOut(rec) {
  let changes = rec.changes || [], comments = rec.comments || [];
  // Where each still-open item sits is worked out afresh on every read, from
  // the minutes as they stand now — not frozen at upload. So a matching rule
  // improved later (bullets, headings: Oct 2026) reaches files already
  // uploaded, and an item the Clerk has since put back reads as Accept-able.
  const doc = db.findById('minutes_docs', rec.docId);
  if (doc) {
    const lines = PR.editableLines(doc, SM.meta);
    changes = changes.map(c => {
      if (c.status !== 'pending') return c;
      const at = PR.locate(lines, c.before);
      // Edited since export: show the Clerk's current wording and what merging
      // the proofreader's corrections into it would give (Oct 2026) — and, if
      // that paragraph no longer takes them, wherever they do fit (Nov 2026).
      if (at.match === 'exact') return { ...c, at, merge: null };
      const mm = mergeFor(doc, c);
      if (mm) return { ...c, at: mm.loc, merge: mm.m };
      return { ...c, at, merge: at.match === 'close' ? mergePreview(doc, at, c) : null };
    });
    comments = comments.map(c => {
      if (c.status !== 'pending') return c;
      let at = PR.locate(lines, c.paragraph);
      let now = null;
      if (at.match !== 'exact') {
        // A comment often sits on words the proofreader himself inserted or
        // changed. Once his tracked change in that paragraph is accepted (or
        // merged), the paragraph is HIS corrected version — not an edit of the
        // Clerk's — so look for that version before calling it "changed".
        const mine = changes.find(ch => (Number.isFinite(c.para) && ch.para === c.para) || PR.norm(ch.before) === PR.norm(c.paragraph));
        const versions = [c.paragraphAfter, mine && mine.after, mine && mine.mergedTo].filter(Boolean);
        for (const v of versions) {
          const a2 = PR.locate(lines, v);
          if (a2.match === 'exact') { at = { ...a2, viaCorrection: true }; now = v; break; }
        }
      }
      if (at.match === 'close') now = currentLine(doc, at);
      return { ...c, at, current: now };
    });
  }
  return {
    ...rec, changes, comments,
    rate: rec.words ? Math.round((rec.corrections / rec.words) * 10000) / 10 : null,
    pending: changes.filter(c => c.status === 'pending').length + comments.filter(c => c.status === 'pending').length,
  };
}
function currentLine(doc, loc) {
  const sec = (doc.sections || []).find(x => x.key === loc.key);
  if (!sec || loc.li === 'subject') return null;
  const row = loc.ci < 0 ? sec : (sec.children || [])[loc.ci];
  if (!row) return null;
  const line = String(row.body || '').split('\n')[loc.li];
  return line == null ? null : line;
}
function mergePreview(doc, loc, ch) {
  const current = currentLine(doc, loc);
  if (current == null || !ch.segs) return null;
  const m = PR.mergeSegs(current, ch.segs);
  return { current, text: m.text, applied: m.applied, failed: m.failed, total: m.total };
}
// Replace one line of an item, but only if it still says what it said.
function applyLine(doc, loc, expected, replacement) {
  let ok = false;
  const updated = db.mutate('minutes_docs', doc.id, cur => ({
    ...cur,
    sections: (cur.sections || []).map(sec => {
      if (sec.key !== loc.key) return sec;
      const edit = row => {
        // A corrected item heading (Oct 2026).
        if (loc.li === 'subject') {
          if (!PR.headingMatches(expected, row.subject)) return row;
          const subject = PR.subjectFrom(expected, replacement, row.subject);
          if (!subject) return row;
          ok = true;
          return { ...row, subject };
        }
        const lines = String(row.body || '').split('\n');
        if (PR.bare(lines[loc.li]) !== PR.bare(expected)) return row;
        lines[loc.li] = PR.withMarker(lines[loc.li], replacement);
        ok = true;
        return { ...row, body: lines.join('\n') };
      };
      if (loc.ci < 0) return edit(sec);
      return { ...sec, children: (sec.children || []).map((c, i) => (i === loc.ci ? edit(c) : c)) };
    }),
  }));
  return ok ? updated : null;
}
// Only the portions he marked, wherever the paragraph is now (Nov 2026).
// When the Clerk has edited a paragraph since the export — even heavily, or
// after the page showed "Accept" — his corrections are carried onto the
// current wording word by word: each one is found by its own words and a
// little untouched text either side, never guessed. First the paragraph the
// copy most resembles; failing that, any editable paragraph that still reads
// like it and where the marked words are found. Returns { loc, m } or null.
function mergeFor(doc, ch) {
  if (!ch || !ch.segs) return null;
  const loc = relocate(doc, ch.before);
  if (loc.match === 'close') {
    const m = mergePreview(doc, loc, ch);
    if (m && m.applied) return { loc, m };
  }
  const fresh = db.findById('minutes_docs', doc.id);
  let best = null;
  PR.editableLines(fresh, SM.meta).forEach(l => {
    if (l.heading || PR.similarity(l.text, String(ch.before || '')) < 0.3) return;
    const r = PR.mergeSegs(l.text, ch.segs);
    if (!r.applied) return;
    if (!best || r.applied > best.m.applied) {
      best = { loc: { match: 'close', key: l.key, ci: l.ci, li: l.li, no: l.no, subject: l.subject, portions: true },
        m: { current: l.text, text: r.text, applied: r.applied, failed: r.failed, total: r.total } };
    }
  });
  return best;
}
function relocate(doc, before) {
  return PR.locate(PR.editableLines(db.findById('minutes_docs', doc.id), SM.meta), before);
}

router.post('/:id/proofread', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  docxUpload.single('docx')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 20 MB.' : err.message });
    const doc = db.findById('minutes_docs', req.params.id);
    if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
    if (doc.locked) return res.status(400).json({ error: 'These minutes have been adopted and can no longer be altered.' });
    if (!req.file) return res.status(400).json({ error: 'Choose the proofread Word file (.docx).' });
    let parsed;
    try { parsed = await PR.parseProofread(req.file.buffer); }
    catch (e) { return res.status(e.status || 400).json({ error: e.status ? e.message : 'That file could not be read as a Word document.' }); }
    const lines = PR.editableLines(doc, SM.meta);
    const changes = parsed.paragraphs.filter(p => p.changed).map((p, i) => ({
      id: i + 1, para: p.idx, before: p.before, after: p.after, segs: p.segs,
      at: PR.locate(lines, p.before), status: 'pending',
    }));
    const comments = parsed.comments.map((c, i) => ({
      id: i + 1, para: c.para, author: c.author, text: c.text, anchor: c.anchor,
      paragraph: c.paraBefore, paragraphAfter: c.paraAfter || '', at: PR.locate(lines, c.paraBefore),
      status: 'pending', directive: '', proposal: '', resolution: '',
    }));
    if (!changes.length && !comments.length) return res.status(400).json({ error: 'There are no tracked changes or comments in that file. Was Track Changes switched on?' });
    const rec = db.insert('minutes_proofreads', {
      docId: doc.id, date: doc.date, fileName: clean(req.file.originalname, 200),
      uploadedAt: new Date().toISOString(), uploadedBy: actor(req).userName,
      proofreader: parsed.authors.join(', '), words: parsed.words, corrections: parsed.corrections,
      changes, comments, lessons: [],
    });
    logActivity({ ...actor(req), action: `Uploaded proofreading: ${changes.length} change(s), ${comments.length} comment(s)`, entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
    res.status(201).json(prOut(rec));
  });
});

router.get('/:id/proofreads', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const list = db.findAll('minutes_proofreads', r => Number(r.docId) === Number(req.params.id))
    .sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
  res.json(list.map(prOut));
});


function prFind(req, res) {
  const rec = db.findById('minutes_proofreads', req.params.pid);
  if (!rec) { res.status(404).json({ error: 'That proofreading is not on record.' }); return null; }
  const doc = db.findById('minutes_docs', rec.docId);
  if (!doc) { res.status(404).json({ error: 'Minutes not found.' }); return null; }
  if (doc.locked) { res.status(400).json({ error: 'These minutes have been adopted and can no longer be altered.' }); return null; }
  return { rec, doc };
}
function prSave(rec, patch) { return db.update('minutes_proofreads', rec.id, patch); }

// Accept or reject one tracked change.
router.post('/proofreads/:pid/changes/:cid', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const f = prFind(req, res); if (!f) return;
  const { rec, doc } = f;
  const ch = (rec.changes || []).find(c => c.id === Number(req.params.cid));
  if (!ch) return res.status(404).json({ error: 'That change is not in this proofreading.' });
  const action = req.body.action;
  let status = ch.status;
  // Undo (Oct 2026): any decision can be taken back. Undoing an accept also
  // puts the paragraph back as it was exported — but only while it still reads
  // exactly as the accepted correction left it, so later editing is never lost.
  if (action === 'undo') {
    if (ch.status === 'merged') {
      const loc = relocate(doc, ch.mergedTo);
      if (loc.match !== 'exact' || !applyLine(doc, loc, ch.mergedTo, ch.mergedFrom)) {
        return res.status(409).json({ error: 'That paragraph has been edited since the merge, so it cannot be put back automatically. Change it by hand on the Minutes tab if you need to.' });
      }
    }
    if (ch.status === 'accepted') {
      const loc = relocate(doc, ch.after);
      if (loc.match !== 'exact' || !applyLine(doc, loc, ch.after, ch.before)) {
        return res.status(409).json({ error: `That paragraph has been edited since you accepted the change, so it cannot be put back automatically. Change it by hand on the Minutes tab if you need to.` });
      }
    }
    const updated = prSave(rec, { changes: rec.changes.map(c => (c.id === ch.id ? { ...c, status: 'pending', decidedAt: null, mergedFrom: undefined, mergedTo: undefined, mergeFailed: undefined } : c)) });
    logActivity({ ...actor(req), action: 'Undid a proofreading decision', entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
    return res.json(prOut(updated));
  }
  if (action === 'merge') {
    // His corrections, carried onto the Clerk's newer wording.
    const mm = mergeFor(doc, ch);
    if (!mm) return res.status(409).json({ error: 'None of the corrections fit your wording any more, so make them by hand on the Minutes tab, then mark it done.' });
    const { loc, m } = mm;
    if (!applyLine(doc, loc, m.current, m.text)) return res.status(409).json({ error: 'The item changed while you were working. Reload and try again.' });
    const updated = prSave(rec, { changes: rec.changes.map(c => (c.id === ch.id ? { ...c, status: 'merged', decidedAt: new Date().toISOString(), mergedFrom: m.current, mergedTo: m.text, mergeFailed: m.failed } : c)) });
    logActivity({ ...actor(req), action: `Merged a proofreading correction into edited text${m.failed.length ? ` (${m.failed.length} left to do by hand)` : ''}`, entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
    return res.json(prOut(updated));
  }
  if (action === 'reject') status = 'rejected';
  else if (action === 'done') status = 'done-by-hand';       // the Clerk applied it himself
  else if (action === 'accept') {
    const loc = relocate(doc, ch.before);
    if (loc.match !== 'exact') {
      // Changed since the export (perhaps after this page showed "Accept"):
      // amend just the portions he marked, in the wording as it is now.
      const mm = mergeFor(doc, ch);
      if (mm && applyLine(doc, mm.loc, mm.m.current, mm.m.text)) {
        const updated = prSave(rec, { changes: rec.changes.map(c => (c.id === ch.id ? { ...c, status: 'merged', decidedAt: new Date().toISOString(), mergedFrom: mm.m.current, mergedTo: mm.m.text, mergeFailed: mm.m.failed } : c)) });
        logActivity({ ...actor(req), action: `Applied a proofreading correction to edited text${mm.m.failed.length ? ` (${mm.m.failed.length} left to do by hand)` : ''}`, entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
        return res.json({ ...prOut(updated), amended: { applied: mm.m.applied, failed: mm.m.failed.length } });
      }
      return res.status(409).json({ error: loc.match === 'close'
        ? `Item ${loc.no} has been edited since the minutes were exported, so this change cannot be applied safely. Make it by hand on the Minutes tab, then mark it done.`
        : 'This paragraph is written by the app from the meeting details (or could not be found), so it cannot be changed here. Make the change in the meeting details, then mark it done.' });
    }
    if (!applyLine(doc, loc, ch.before, ch.after)) return res.status(409).json({ error: 'The item changed while you were working. Reload and try again.' });
    status = 'accepted';
  } else return res.status(400).json({ error: 'Accept, reject or done?' });
  const updated = prSave(rec, { changes: rec.changes.map(c => (c.id === ch.id ? { ...c, status, decidedAt: new Date().toISOString() } : c)) });
  if (status === 'accepted') logActivity({ ...actor(req), action: 'Accepted a proofreading correction', entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
  res.json(prOut(updated));
});

// Every change that still matches its paragraph exactly, in one go.
router.post('/proofreads/:pid/accept-all', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const f = prFind(req, res); if (!f) return;
  const { rec, doc } = f;
  let n = 0;
  const changes = rec.changes.map(c => {
    if (c.status !== 'pending') return c;
    const loc = relocate(doc, c.before);
    if (req.body && req.body.merge) {
      // "Merge all that fit": edited paragraphs where every correction fits.
      const mm = loc.match === 'exact' ? null : mergeFor(doc, c);
      const m = mm && mm.m;
      if (!m || !m.applied || m.failed.length || !applyLine(doc, mm.loc, m.current, m.text)) return c;
      n += 1;
      return { ...c, status: 'merged', decidedAt: new Date().toISOString(), mergedFrom: m.current, mergedTo: m.text, mergeFailed: [] };
    }
    if (loc.match !== 'exact' || !applyLine(doc, loc, c.before, c.after)) return c;
    n += 1;
    return { ...c, status: 'accepted', decidedAt: new Date().toISOString() };
  });
  const updated = prSave(rec, { changes });
  logActivity({ ...actor(req), action: `Accepted ${n} proofreading correction(s)`, entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
  res.json({ accepted: n, proofread: prOut(updated) });
});

// A comment: the Clerk's directive → Claude's proposed paragraph.
router.post('/proofreads/:pid/comments/:cid/propose', requireAuth, async (req, res) => {
  if (!requireEdit(req, res)) return;
  const f = prFind(req, res); if (!f) return;
  const { rec, doc } = f;
  const cm = (rec.comments || []).find(c => c.id === Number(req.params.cid));
  if (!cm) return res.status(404).json({ error: 'That comment is not in this proofreading.' });
  const directive = clean(req.body.directive, 2000);
  if (!directive) return res.status(400).json({ error: 'Say what should be done about this comment.' });
  // Work on the paragraph as it stands in the app now (an earlier accepted
  // change may already have altered it), else the one he commented on.
  // prOut works out where the comment's paragraph is now — including after
  // his own tracked change in it was accepted — so use the same answer here.
  const view = (prOut(rec).comments || []).find(c => c.id === cm.id) || {};
  const current = view.current || cm.paragraph;
  try {
    // The rules the Clerk has taught — including one typed a moment ago on
    // another card of this same proofreading — shape this draft too.
    const out = await ai.applyDirective({ paragraph: current, comment: cm.text, anchor: cm.anchor, directive, people: membersFor(doc).map(m => SM.proseName(m)), extraRules: db.findAll('house_style_rules', r => r.active !== false) });
    const updated = prSave(rec, { comments: rec.comments.map(c => (c.id === cm.id ? { ...c, directive, proposal: out.text, proposalFrom: current, proposalOriginal: undefined, adjustedBy: undefined, adjustedRule: undefined } : c)) });
    res.json(prOut(updated));
  } catch (e) { res.status(e.status || 500).json({ error: e.message || 'Could not carry out that directive.' }); }
});

// Close a comment: apply the (possibly edited) proposal, or record "no change".
router.post('/proofreads/:pid/comments/:cid/resolve', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const f = prFind(req, res); if (!f) return;
  const { rec, doc } = f;
  const cm = (rec.comments || []).find(c => c.id === Number(req.params.cid));
  if (!cm) return res.status(404).json({ error: 'That comment is not in this proofreading.' });
  const action = req.body.action;
  let patch;
  if (action === 'undo') {
    if (cm.status === 'applied') {
      const back = cm.proposalFrom || cm.paragraph;
      const loc = relocate(doc, cm.resolution);
      if (loc.match !== 'exact' || !applyLine(doc, loc, cm.resolution, back)) {
        return res.status(409).json({ error: 'That paragraph has been edited since the change was applied, so it cannot be put back automatically. Change it by hand on the Minutes tab if you need to.' });
      }
    }
    // The directive and the draft are kept, so they can be reused.
    const updated = prSave(rec, { comments: rec.comments.map(c => (c.id === cm.id ? { ...c, status: 'pending', resolution: '', decidedAt: null } : c)) });
    logActivity({ ...actor(req), action: 'Undid a proofreading decision', entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
    return res.json(prOut(updated));
  }
  if (action === 'apply') {
    const text = clean(req.body.text || cm.proposal, 20000);
    const from = cm.proposalFrom || cm.paragraph;
    if (!text) return res.status(400).json({ error: 'There is no new text to apply.' });
    const loc = relocate(doc, from);
    if (loc.match !== 'exact' || !applyLine(doc, loc, from, text)) {
      return res.status(409).json({ error: 'That paragraph is not in the app in that form (it is written from the meeting details, or has been edited). Copy the text and make the change by hand, then mark the comment done.' });
    }
    patch = { status: 'applied', resolution: text, directive: clean(req.body.directive, 2000) || cm.directive };
  } else if (action === 'no-change' || action === 'done') {
    patch = { status: action === 'done' ? 'done-by-hand' : 'no-change', directive: clean(req.body.directive, 2000) || cm.directive };
  } else return res.status(400).json({ error: 'Apply, no change, or done?' });
  const updated = prSave(rec, { comments: rec.comments.map(c => (c.id === cm.id ? { ...c, ...patch, decidedAt: new Date().toISOString() } : c)) });
  logActivity({ ...actor(req), action: `Answered a proofreading comment (${patch.status})`, entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
  res.json(prOut(updated));
});

// Proposed house-style rules from the accepted corrections.
router.post('/proofreads/:pid/lessons', requireAuth, async (req, res) => {
  if (!requireEdit(req, res)) return;
  const rec = db.findById('minutes_proofreads', req.params.pid);
  if (!rec) return res.status(404).json({ error: 'That proofreading is not on record.' });
  try {
    const out = await ai.suggestRules({
      corrections: (rec.changes || []).filter(c => c.status !== 'rejected').map(c => ({ before: c.before, after: c.after })),
      comments: (rec.comments || []).map(c => `${c.text}${c.directive ? ` — Clerk: ${c.directive}` : ''}`),
      existing: db.findAll('house_style_rules', r => r.active !== false).map(r => r.rule),
    });
    const lessons = out.rules.map((r, i) => ({ id: i + 1, ...r, status: 'proposed' }));
    res.json(prOut(prSave(rec, { lessons })));
  } catch (e) { res.status(e.status || 500).json({ error: e.message || 'Could not suggest rules.' }); }
});
router.post('/proofreads/:pid/lessons/:lid', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const rec = db.findById('minutes_proofreads', req.params.pid);
  if (!rec) return res.status(404).json({ error: 'That proofreading is not on record.' });
  const l = (rec.lessons || []).find(x => x.id === Number(req.params.lid));
  if (!l) return res.status(404).json({ error: 'That suggestion is not here.' });
  const approve = req.body.approve === true;
  if (approve && l.status !== 'approved') {
    db.insert('house_style_rules', {
      rule: clean(req.body.rule || l.rule, 400), wrong: clean(l.wrong, 400), right: clean(l.right, 400),
      fromDate: rec.date, fromProofread: rec.id, approvedBy: actor(req).userName, approvedAt: new Date().toISOString(), active: true,
    });
    logActivity({ ...actor(req), action: `Approved a house-style rule: ${l.rule}`, entityType: 'minutes', entityId: rec.docId, entityLabel: rec.date });
  }
  res.json(prOut(prSave(rec, { lessons: rec.lessons.map(x => (x.id === l.id ? { ...x, status: approve ? 'approved' : 'skipped' } : x)) })));
});
// ---- "Why?" — the Clerk's reason behind a correction (Oct 2026) -------------
// On any change or comment card the Clerk can type the idea behind it ("we
// write Rev without a full stop"). It becomes a house-style rule at once, so
// every later tidy-up follows it, and it is carried through the minutes being
// proofread now: paragraphs elsewhere that break it come up as new suggested
// changes (accept or reject like the proofreader's), and the proofreader's
// still-open changes and any unapplied comment drafts are brought into line.
// Words, spaces and each punctuation mark apart, so "Dr." → "Dr" shows as
// just the full stop struck out.
const wordToks = s => String(s || '').match(/\s+|[\p{L}\p{N}'’]+|[^\s\p{L}\p{N}'’]/gu) || [];
// Word-level difference as the same segs the Word file gives: '', 'ins', 'del'.
function wordDiffSegs(a, b) {
  const A = wordToks(a), B = wordToks(b);
  if (A.length * B.length > 250000) return [{ mode: 'del', text: String(a) }, { mode: 'ins', text: String(b) }];
  const n = A.length, m = B.length;
  const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) for (let j = m - 1; j >= 0; j -= 1) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const segs = [];
  const add = (mode, text) => { const last = segs[segs.length - 1]; if (last && last.mode === mode) last.text += text; else segs.push({ mode, text }); };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) { add('', A[i]); i += 1; j += 1; } else if (L[i + 1][j] >= L[i][j + 1]) { add('del', A[i]); i += 1; } else { add('ins', B[j]); j += 1; }
  }
  while (i < n) { add('del', A[i]); i += 1; }
  while (j < m) { add('ins', B[j]); j += 1; }
  return segs;
}
// A short "wrong → right" example: just the changed words with a few either side.
function diffWindow(before, after) {
  const A = String(before || '').split(/\s+/).filter(Boolean), B = String(after || '').split(/\s+/).filter(Boolean);
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p += 1;
  let q = 0; while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q += 1;
  if (p === A.length && p === B.length) return { wrong: '', right: '' };
  const from = Math.max(0, p - 4);
  return {
    wrong: A.slice(from, Math.min(A.length, A.length - q + 4)).join(' ').slice(0, 300),
    right: B.slice(from, Math.min(B.length, B.length - q + 4)).join(' ').slice(0, 300),
  };
}
const MARK_RX = /^\s*[-*•–—]\s+/;
// Carry one rule through this proofreading: Claude reads the lines nobody is
// working on, the proofreader's open changes and any unapplied drafts, and
// returns the fixes it would make.
async function carryRule(rec, doc, rule, skipItem) {
  const view = prOut(rec);
  const busy = new Set();
  const at = a => a && a.match === 'exact' ? `${a.key}|${a.ci}|${a.li}` : null;
  view.changes.filter(c => c.status === 'pending').forEach(c => { const k = at(c.at); if (k) busy.add(k); });
  view.comments.filter(c => c.status === 'pending').forEach(c => { const k = at(c.at); if (k) busy.add(k); });
  const paras = [], targets = [];
  const push = (text, target) => { const t = String(text || '').replace(MARK_RX, '').trim(); if (!t) return; targets.push({ ...target, text: t }); paras.push({ i: targets.length, text: t }); };
  // Lines of the minutes nobody is working on yet (headings excepted).
  PR.editableLines(doc, SM.meta).forEach(l => {
    if (l.heading || busy.has(`${l.key}|${l.ci}|${l.li}`)) return;
    push(l.text, { kind: 'line' });
  });
  // The proofreader's open changes — his corrected wording — and unapplied drafts.
  view.changes.forEach(c => { if (c.status === 'pending' && c.source !== 'rule' && skipItem !== `ch:${c.id}`) push(c.after, { kind: 'change', id: c.id }); });
  view.comments.forEach(c => { if (c.status === 'pending' && c.proposal && skipItem !== `cm:${c.id}`) push(c.proposal, { kind: 'proposal', id: c.id }); });
  if (!paras.length) return [];
  const { edits } = await ai.applyRuleElsewhere({ rule: rule.rule, wrong: rule.wrong, right: rule.right, paragraphs: paras });
  const ops = [];
  const seen = new Set();
  edits.forEach(e => {
    const t = targets[e.i - 1];
    if (!t || seen.has(e.i)) return;
    seen.add(e.i);
    const text = e.text.replace(MARK_RX, '').trim();
    // A real, small fix — not a rewrite, not the same words.
    if (!text || PR.norm(text) === PR.norm(t.text) || PR.similarity(t.text, text) < 0.6) return;
    ops.push({ ...t, to: text });
  });
  return ops;
}
// Apply the found fixes to the record as it is NOW (the Clerk may have accepted
// something while Claude was reading), skipping any target that has moved on.
function applyRuleOps(rec, doc, rule, ops) {
  let changes = (rec.changes || []).slice(), comments = (rec.comments || []).slice();
  let nextId = changes.reduce((mx, c) => Math.max(mx, Number(c.id) || 0), 0) + 1;
  const lines = PR.editableLines(doc, SM.meta);
  let found = 0;
  ops.forEach(o => {
    if (o.kind === 'line') {
      if (changes.some(c => c.status === 'pending' && PR.bare(c.before) === PR.bare(o.text))) return;
      const at = PR.locate(lines, o.text);
      if (at.match !== 'exact') return;
      changes.push({ id: nextId++, para: null, before: o.text, after: o.to, segs: wordDiffSegs(o.text, o.to), status: 'pending', source: 'rule', ruleId: rule.id, ruleText: rule.rule, at });
      found += 1;
    } else if (o.kind === 'change') {
      const c = changes.find(x => x.id === o.id);
      if (!c || c.status !== 'pending' || PR.norm(c.after).replace(/^[-*•–—]\s+/, '') !== PR.norm(o.text)) return;
      changes = changes.map(x => (x.id === o.id ? { ...x, afterOriginal: x.afterOriginal || x.after, segsOriginal: x.segsOriginal || x.segs, after: o.to, segs: wordDiffSegs(x.before, o.to), adjustedBy: rule.id, adjustedRule: rule.rule } : x));
      found += 1;
    } else {
      const c = comments.find(x => x.id === o.id);
      if (!c || c.status !== 'pending' || PR.norm(c.proposal) !== PR.norm(o.text)) return;
      comments = comments.map(x => (x.id === o.id ? { ...x, proposalOriginal: x.proposalOriginal || x.proposal, proposal: o.to, adjustedBy: rule.id, adjustedRule: rule.rule } : x));
      found += 1;
    }
  });
  return { changes, comments, found };
}
// Take a rule back out of this proofreading: its open suggestions go, and
// anything it adjusted returns to what it was.
function uncarryRule(rec, ruleId) {
  return {
    changes: (rec.changes || []).filter(c => !(c.source === 'rule' && c.ruleId === ruleId && c.status === 'pending'))
      .map(c => (c.adjustedBy === ruleId && c.status === 'pending' && c.afterOriginal
        ? { ...c, after: c.afterOriginal, segs: c.segsOriginal || wordDiffSegs(c.before, c.afterOriginal), afterOriginal: undefined, segsOriginal: undefined, adjustedBy: undefined, adjustedRule: undefined } : c)),
    comments: (rec.comments || []).map(c => (c.adjustedBy === ruleId && c.status === 'pending' && c.proposalOriginal
      ? { ...c, proposal: c.proposalOriginal, proposalOriginal: undefined, adjustedBy: undefined, adjustedRule: undefined } : c)),
  };
}
router.post('/proofreads/:pid/reason', requireAuth, async (req, res) => {
  if (!requireEdit(req, res)) return;
  const f = prFind(req, res); if (!f) return;
  let { rec, doc } = f;
  const kind = req.body.kind === 'cm' ? 'cm' : 'ch';
  const id = Number(req.body.id);
  const list = kind === 'cm' ? (rec.comments || []) : (rec.changes || []);
  const item = list.find(x => x.id === id);
  if (!item) return res.status(404).json({ error: 'That item is not in this proofreading.' });
  const reason = clean(req.body.reason, 400);
  const fromItem = `${kind}:${id}`;
  const existing = db.findAll('house_style_rules', r => Number(r.fromProofread) === Number(rec.id) && r.fromItem === fromItem)[0];
  const saveItem = (r, patch) => {
    const key = kind === 'cm' ? 'comments' : 'changes';
    return prSave(r, { [key]: (r[key] || []).map(x => (x.id === id ? { ...x, ...patch } : x)) });
  };
  // Cleared: the rule is switched off and taken back out of this proofreading.
  if (!reason) {
    if (existing) {
      db.update('house_style_rules', existing.id, { active: false });
      rec = prSave(rec, uncarryRule(rec, existing.id));
    }
    rec = saveItem(rec, { reason: '', ruleId: null });
    logActivity({ ...actor(req), action: 'Removed the reason given for a proofreading correction', entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
    return res.json({ proofread: prOut(rec), found: 0 });
  }
  let ex;
  if (kind === 'ch') ex = diffWindow(item.before, item.afterOriginal || item.after);
  else {
    const done = item.resolution || item.proposal;
    ex = done ? diffWindow(item.proposalFrom || item.paragraph, done) : { wrong: clean(item.anchor, 300), right: '' };
  }
  const fields = { rule: reason, wrong: ex.wrong, right: ex.right, fromDate: rec.date, fromProofread: rec.id, fromItem, source: 'clerk-reason', approvedBy: actor(req).userName, approvedAt: new Date().toISOString(), active: true };
  let rule;
  if (existing) {
    // A changed reason: undo what the old wording did here, then redo with the new.
    rec = prSave(rec, uncarryRule(rec, existing.id));
    rule = db.update('house_style_rules', existing.id, fields);
  } else rule = db.insert('house_style_rules', fields);
  rec = saveItem(rec, { reason, ruleId: rule.id });
  logActivity({ ...actor(req), action: `Gave the reason for a proofreading correction (now a house-style rule): ${reason}`, entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
  if (!ai.isConfigured() || req.body.carry === false) return res.json({ proofread: prOut(rec), found: 0, carried: false });
  try {
    const ops = await carryRule(rec, db.findById('minutes_docs', doc.id), rule, fromItem);
    const fresh = db.findById('minutes_proofreads', rec.id);
    const out = applyRuleOps(fresh, db.findById('minutes_docs', doc.id), rule, ops);
    rec = prSave(fresh, { changes: out.changes, comments: out.comments });
    res.json({ proofread: prOut(rec), found: out.found, carried: true });
  } catch (e) {
    res.json({ proofread: prOut(rec), found: 0, carried: false, warning: `The rule is saved, but the rest of these minutes could not be checked just now (${e.message}).` });
  }
});

router.post('/house-rules/:id', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const r = db.findById('house_style_rules', req.params.id);
  if (!r) return res.status(404).json({ error: 'Rule not found.' });
  res.json(db.update('house_style_rules', r.id, { active: req.body.active !== false }));
});

// ---- Versions: the tabled draft and the final adopted PDF -------------------
const VERSION_KINDS = ['tabled', 'final'];
router.post('/:id/versions', requireAuth, (req, res) => {
  if (!requireEdit(req, res) && !isAdmin(req)) return;
  upload.single('pdf')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is larger than 12 MB.' : err.message });
    const doc = db.findById('minutes_docs', req.params.id);
    if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
    const kind = VERSION_KINDS.includes(String(req.body.kind)) ? String(req.body.kind) : 'tabled';
    if (!req.file) return res.status(400).json({ error: 'No file received.' });
    if (req.file.buffer.slice(0, 5).toString() !== '%PDF-') {
      return res.status(400).json({ error: 'That file is not a real PDF.' });
    }
    const filename = `minutes-${doc.id}-${kind}-${Date.now()}.pdf`;
    fs.writeFileSync(path.join(FILES_DIR, filename), req.file.buffer);
    const updated = db.mutate('minutes_docs', doc.id, cur => {
      const versions = (cur.versions || []).slice();
      versions.push({
        kind, filename, originalName: req.file.originalname, size: req.file.size,
        uploadedBy: actor(req).userName, uploadedAt: new Date().toISOString(),
      });
      return { ...cur, versions };
    });
    logActivity({ ...actor(req), action: `Uploaded the ${kind} minutes PDF`, entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
    res.status(201).json(updated.versions[updated.versions.length - 1]);
  });
});

router.get('/:id/versions/:vi/file', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  const v = doc && (doc.versions || [])[Number(req.params.vi)];
  if (!v) return res.status(404).json({ error: 'That version was not found.' });
  const fp = path.join(FILES_DIR, path.basename(v.filename));
  if (!fs.existsSync(fp)) return res.status(410).json({ error: 'The file is missing on the server.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${(v.originalName || v.filename).replace(/"/g, '')}"`);
  res.send(fs.readFileSync(fp));
});

// ---- Circulate the draft for corrections ------------------------------------
router.post('/:id/circulate', requireAuth, async (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  const onlyPresent = req.body.onlyPresent !== false;
  const ids = new Set(((doc.roll && doc.roll.presentIds) || []).map(Number));
  const people = roster().filter(m => (m.email || '').trim() && (!onlyPresent || ids.has(m.id)));
  if (!people.length) {
    return res.status(400).json({ error: 'No email addresses on file for those members. Add them on the Session roster first.' });
  }
  let attachments = [];
  try {
    const buf = await buildSessionMinutesPdf(docData(doc));
    attachments = [{ filename: `${fileBase(doc, 'Minutes')}.pdf`, content: buf }];
  } catch (e) {
    console.error('[circulate] could not attach PDF:', e.message);
  }
  const when = SM.fmtTime ? doc.date : doc.date;
  const html = `<p>Dear Member,</p>
    <p>Please find attached the draft minutes of the ${doc.title || 'Session Meeting'} held on ${doc.date}, circulated for your review ahead of the next meeting.</p>
    <p>Kindly send any correction to the Session Clerk before the meeting so it can be tabled under Review of Minutes.</p>
    <p>Yours in service,<br>The Session Clerk</p>`;
  let sent = 0, failed = 0;
  for (const m of people) {
    const r = await sendMail({ to: m.email, subject: `Draft minutes — ${doc.title || 'Session Meeting'}, ${doc.date}`, html, attachments });
    if (r && (r.error || r.skipped)) failed += 1; else sent += 1;
  }
  logActivity({ ...actor(req), action: `Circulated the draft minutes to ${sent} member(s)`, entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
  res.json({ sent, failed, total: people.length, when });
});

// ---- The roll, saved on its own --------------------------------------------
// Members arrive at different times, so the roll is ticked through the meeting
// and saved by itself — nothing else in the document is touched by a tick.
function computeRoll(body, doc) {
  const ids = v => [...new Set((Array.isArray(v) ? v : []).map(Number).filter(Boolean))];
  const presentIds = ids(body.presentIds);
  const apologyIds = ids(body.apologyIds).filter(i => !presentIds.includes(i));
  const known = new Set([...presentIds, ...apologyIds]);
  return {
    presentIds, apologyIds,
    absentIds: (doc ? membersFor({ ...doc, roll: { presentIds, apologyIds } }) : roster()).map(m => m.id).filter(i => !known.has(i)),
    onlineIds: ids(body.onlineIds).filter(i => presentIds.includes(i)),
    guests: (Array.isArray(body.guests) ? body.guests : [])
      .map(g => ({ name: clean(g.name, 120), position: clean(g.position, 80) || 'In attendance', ...(clean(g.details, 300) ? { details: clean(g.details, 300) } : {}) }))
      .filter(g => g.name),
  };
}

router.put('/:id/roll', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Meeting not found.' });
  if (doc.locked) return res.status(400).json({ error: 'These minutes have been adopted and can no longer be altered.' });
  if (doc.roll && doc.roll.locked) {
    return res.status(400).json({ error: 'The attendance is confirmed and locked. Unlock it first to make a correction.' });
  }
  const next = computeRoll((req.body && req.body.roll) || {}, doc);
  const updated = db.mutate('minutes_docs', doc.id, cur => ({ ...cur, roll: { ...next, locked: false } }));
  res.json({ roll: updated.roll });
});

router.post('/:id/roll/lock', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Meeting not found.' });
  const a = actor(req);
  const updated = db.mutate('minutes_docs', doc.id, cur => ({
    ...cur,
    roll: { ...(cur.roll || {}), locked: true, lockedBy: a.userName, lockedAt: new Date().toISOString() },
  }));
  logActivity({ ...a, action: 'Confirmed and locked the Session attendance', entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
  res.json({ roll: updated.roll });
});

// Unlocking stays with the Clerk as well as admins: they are the one sitting
// in the meeting when a mistake is spotted. It is logged either way.
router.post('/:id/roll/unlock', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Meeting not found.' });
  if (doc.locked) return res.status(400).json({ error: 'These minutes have been adopted and can no longer be altered.' });
  const a = actor(req);
  const updated = db.mutate('minutes_docs', doc.id, cur => ({
    ...cur, roll: { ...(cur.roll || {}), locked: false, unlockedBy: a.userName, unlockedAt: new Date().toISOString() },
  }));
  logActivity({ ...a, action: 'Unlocked the Session attendance', entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
  res.json({ roll: updated.roll });
});

// ---- One section at a time -------------------------------------------------
// The Clerk works through the minutes during the meeting — Correspondence now,
// Other Matters later. Saving a section rewrites ONLY that section, so a stale
// copy of one part can never overwrite work done on another.
// Whether an item's text has been through the tidy-up, or been checked by hand
// instead. Never printed. tidiedWords is the length of the text the tidy-up
// returned, so the page can tell when a lot has been added since. The export
// check on the Documents tab uses it to stop raw dictation reaching the Word
// file, which is how 6.1 and 8.2 of 27th August 2026 went out untidied.
// What the Clerk typed before the last tidy-up, and what the tidy-up gave back
// (Oct 2026). Kept with the item for good, so the notes can be recovered days
// later, and so the three versions — notes, tidy-up, and the minute as finally
// signed — can be compared to teach the tidy-up the corrections it keeps
// needing. Never printed.
function tidyHistory(r) {
  const out = {};
  if (r && typeof r.rawNotes === 'string') out.rawNotes = clean(r.rawNotes, 20000);
  if (r && typeof r.aiText === 'string') out.aiText = clean(r.aiText, 20000);
  if (r && /^\d{4}-\d{2}-\d{2}T/.test(String(r.tidiedAt || ''))) out.tidiedAt = clean(r.tidiedAt, 40);
  return out;
}
function tidyMarks(r) {
  const w = Math.round(Number(r && r.tidiedWords));
  return { tidiedWords: Number.isFinite(w) && w > 0 ? Math.min(w, 20000) : 0, handChecked: !!(r && r.handChecked) };
}

// ---- "Carry to Matters Arising" (Oct 2026) ---------------------------------
// Beside "defer to next meeting" on every item. Deferred means the Session did
// not get to it; CARRIED means it was discussed and is still open — so it goes
// into the register of outstanding matters, and onto the next agenda's Matters
// Arising from there. If the register already holds the same matter from an
// earlier meeting, this adds an UPDATE to it rather than a second entry.
// Unticking takes back exactly what ticking did.
function firstSentences(text, max = 400) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\u201d'));
  return (stop > 80 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, '') + ' \u2026');
}
router.post('/:id/to-matters', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  if (doc.locked) return res.status(400).json({ error: 'These minutes have been adopted and can no longer be altered.' });
  const key = clean(req.body.key, 40);
  const ci = Number.isInteger(Number(req.body.ci)) ? Number(req.body.ci) : -1;
  const sec = (doc.sections || []).find(x => x.key === key);
  if (!sec) return res.status(404).json({ error: 'That item is not in these minutes.' });
  const row = ci >= 0 ? (sec.children || [])[ci] : sec;
  if (!row) return res.status(404).json({ error: 'That item is not in these minutes.' });
  const on = req.body.on === true;
  const who = actor(req).userName;
  let link = row.toMatters && row.toMatters.matterId ? { ...row.toMatters } : null;

  if (on && !link) {
    const subject = clean(ci >= 0 ? (row.subject || sec.subject) : sec.subject, 200);
    if (!subject) return res.status(400).json({ error: 'Give the item a heading first.' });
    const detail = clean(row.action, 2000) || firstSentences(row.body);
    const item = { heading: ci >= 0 ? sec.subject : '', subject, detail, owner: row.actionResponsible || '', status: 'open' };
    const [a] = annotateAgainstRegister(doc, [item]);
    if (a.updateOf) {
      const target = db.findById('session_matters', a.updateOf.id);
      if (!(target.updates || []).some(u => Number(u.meetingId) === Number(doc.id))) {
        db.mutate('session_matters', target.id, cur => ({ ...cur,
          updates: [...(cur.updates || []), { date: doc.date || '', meetingId: doc.id, note: detail || subject, by: who }],
          lastReviewedAt: doc.date || cur.lastReviewedAt }));
      }
      link = { matterId: target.id, kind: 'update' };
    } else {
      const existing = db.findOne('session_matters', m => Number(m.raisedIn) === Number(doc.id) && String(m.subject || '').trim().toLowerCase() === subject.toLowerCase());
      const rec = existing || db.insert('session_matters', {
        heading: SM.headingFor(clean(item.heading, 200), subject, detail),
        subject, detail,
        owner: SM.resolveName(roster(), clean(item.owner, 160)),
        due: /^\d{4}-\d{2}-\d{2}$/.test(String(row.actionDate || '')) ? row.actionDate : '',
        raisedAt: doc.date || '', raisedIn: doc.id, status: 'open',
        decision: '', closedAt: '', updates: [], raisedBy: who,
      });
      link = { matterId: rec.id, kind: 'new' };
    }
    logActivity({ ...actor(req), action: `Carried "${subject}" to Matters Arising (${link.kind === 'update' ? 'update to an open matter' : 'new matter'})`, entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
  } else if (!on && link) {
    const m = db.findById('session_matters', link.matterId);
    if (m) {
      if (link.kind === 'update') {
        db.mutate('session_matters', m.id, cur => ({ ...cur, updates: (cur.updates || []).filter(u => Number(u.meetingId) !== Number(doc.id)) }));
      } else if (!(m.updates || []).length && Number(m.raisedIn) === Number(doc.id)) {
        db.remove('session_matters', m.id);
      }
      // A new matter that has since gathered updates stays: it has a life of its own now.
    }
    logActivity({ ...actor(req), action: 'Took an item back out of Matters Arising', entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
    link = null;
  }

  db.mutate('minutes_docs', doc.id, cur => ({
    ...cur,
    sections: (cur.sections || []).map(x => {
      if (x.key !== key) return x;
      if (ci < 0) return { ...x, toMatters: link || undefined };
      return { ...x, children: (x.children || []).map((c, i) => (i === ci ? { ...c, toMatters: link || undefined } : c)) };
    }),
  }));
  const matter = link ? db.findById('session_matters', link.matterId) : null;
  res.json({ toMatters: link, matter: matter ? matterOut(matter) : null });
});

router.put('/:id/section', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  if (doc.locked) return res.status(400).json({ error: 'These minutes have been adopted and can no longer be altered.' });
  if (doc.status === 'final') return res.status(400).json({ error: 'These minutes are final. Reopen them before editing.' });
  const key = clean(req.body.key, 40);
  if (!key) return res.status(400).json({ error: 'Which section?' });

  const rowFields = r => ({
    subject: clean(r.subject, 200),
    body: clean(r.body, 20000),
    action: clean(r.action, 2000),
    actionResponsible: clean(r.actionResponsible, 160),
    actionDate: clean(r.actionDate, 10),
    actionStatus: ['open', 'done'].includes(r.actionStatus) ? r.actionStatus : 'open',
    deferred: !!r.deferred,
    // Set by POST /:id/to-matters, never by the browser directly; carried
    // through a save untouched so the link to the register is not lost.
    toMatters: r.toMatters && Number(r.toMatters.matterId) > 0
      ? { matterId: Number(r.toMatters.matterId), kind: r.toMatters.kind === 'update' ? 'update' : 'new' } : undefined,
    ...tidyMarks(r),
    ...tidyHistory(r),
    ...motionsOf(r.motions),
  });
  // Motions as records (Oct 2026): mover, seconder, result, votes. Names are
  // expanded to the roster's full form, as everywhere else in the minutes.
  const all = roster();
  function motionsOf(list) {
    const m = require('@deontech/minutes').cleanMotions(list)
      .map(x => ({ ...x, movedBy: SM.resolveName(all, x.movedBy), secondedBy: SM.resolveName(all, x.secondedBy) }));
    return m.length ? { motions: m } : {};
  }

  // Learn short forms from the Clerk's corrections to tidied text. Only rows
  // that HAD been tidied and whose text the Clerk has now changed are looked
  // at: a correction to the tidy-up's wording is the signal, nothing else.
  try {
    const old = (doc.sections || []).find(x => x.key === key) || {};
    const pairs = [];
    if (req.body.body !== undefined && Number(old.tidiedWords) > 0 && old.body !== req.body.body) pairs.push([old.body, req.body.body]);
    if (Array.isArray(req.body.children)) {
      (old.children || []).forEach((c, i) => {
        const n = req.body.children[i];
        if (n && Number(c.tidiedWords) > 0 && typeof n.body === 'string' && n.body !== c.body) pairs.push([c.body, n.body]);
      });
    }
    if (pairs.length) {
      const members = membersFor(doc);
      pairs.forEach(([a, b]) => SM.learnShortForms(a, b, members).forEach(l => {
        const m = db.findById('session_members', l.id);
        if (!m || m.shortFormSource === 'manual') return;
        db.update('session_members', m.id, { shortForm: l.form, shortFormSource: 'learned' });
        logActivity({ ...actor(req), action: `Learned how the minutes refer to ${m.name}: "${l.form}"`, entityType: 'session_member', entityId: m.id, entityLabel: m.name });
      }));
    }
  } catch (e) { /* learning is a nicety; never block a save */ }

  const updated = db.mutate('minutes_docs', doc.id, cur => {
    const sections = (cur.sections || []).map(sec => {
      if (sec.key !== key) return sec;
      const next = { ...sec };
      if (req.body.enabled !== undefined) next.enabled = !!req.body.enabled;
      if (req.body.subject !== undefined) next.subject = clean(req.body.subject, 200);
      if (req.body.body !== undefined) next.body = clean(req.body.body, 20000);
      if (req.body.action !== undefined) next.action = clean(req.body.action, 2000);
      if (req.body.motions !== undefined) { delete next.motions; Object.assign(next, motionsOf(req.body.motions)); }
      if (req.body.tidiedWords !== undefined || req.body.handChecked !== undefined) Object.assign(next, tidyMarks(req.body));
      Object.assign(next, tidyHistory(req.body));
      if (Array.isArray(req.body.children)) {
        next.children = req.body.children.map(c => ({
          ...rowFields(c),
          carriedFrom: c.carriedFrom && c.carriedFrom.date ? c.carriedFrom : undefined,
        }));
      }
      return next;
    });
    return { ...cur, sections };
  });
  res.json({ section: (updated.sections || []).find(x => x.key === key) || null });
});

// Proceedings merge field by field for the same reason.
// Each set of minutes reviewed on the night, in the order the Session took
// them. Saved on its own so working here cannot disturb anything else.
function cleanReviews(list) {
  return (Array.isArray(list) ? list : []).map(r => ({
    date: clean(r.date, 60),
    // The ISO date of the meeting picked, where the app knows it — used to
    // match corrections and to work out who may move that adoption.
    iso: /^\d{4}-\d{2}-\d{2}$/.test(clean(r.iso, 10)) ? clean(r.iso, 10) : '',
    readBy: clean(r.readBy, 160),
    movedBy: clean(r.movedBy, 160),
    secondedBy: clean(r.secondedBy, 160),
    note: clean(r.note, 4000),
    corrections: (Array.isArray(r.corrections) ? r.corrections : []).map(c => ({
      where: clean(c.where, 200),
      ref: clean(c.ref, 12),
      was: clean(c.was, 2000),
      now: clean(c.now, 2000),
      note: clean(c.note, 2000),
    })).filter(c => c.where || c.was || c.now || c.note),
  })).filter(r => r.date || r.readBy || r.movedBy || r.secondedBy || r.note || r.corrections.length);
}

router.put('/:id/reviews', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  if (doc.locked) return res.status(400).json({ error: 'These minutes have been adopted and can no longer be altered.' });
  const all = roster();
  const reviews = cleanReviews(req.body.reviews).map(r => ({
    ...r,
    // Whoever is named gets their full name as the roster has it.
    readBy: SM.resolveName(all, r.readBy),
    movedBy: SM.resolveName(all, r.movedBy),
    secondedBy: SM.resolveName(all, r.secondedBy),
  }));
  const updated = db.mutate('minutes_docs', doc.id, cur => ({ ...cur, reviews }));
  res.json({ reviews: updated.reviews });
});

router.put('/:id/proceedings', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  if (doc.locked) return res.status(400).json({ error: 'These minutes have been adopted and can no longer be altered.' });
  const patch = (req.body && req.body.proceedings) || {};
  // Whoever is named gets their full name as the roster has it, so a hurried
  // "A. Twum" typed during the meeting prints as Mr Emmanuel Adjei Twum. A name
  // the roster does not recognise is left exactly as it was typed.
  const all = roster();
  const updated = db.mutate('minutes_docs', doc.id, cur => {
    const next = { ...(cur.proceedings || {}) };
    Object.keys(patch).forEach(k => {
      // graceSaid is a tick, not a name — the Grace is said by the meeting
      // together, so it carries no one's name.
      if (k === 'graceSaid') { next[k] = !!patch[k]; return; }
      // Constituted on the word shared at the devotion (a tick), optionally a scripture.
      if (k === 'constitutedOnWord') { next[k] = !!patch[k]; return; }
      // Prayers are a small structure, not a line of text: who led, the points
      // in the order they were prayed, and anything else said afterwards.
      if (k === 'prayers') {
        const v = patch[k] || {};
        next[k] = {
          ledBy: SM.resolveName(all, clean(v.ledBy, 120)),
          points: (Array.isArray(v.points) ? v.points : []).slice(0, 40)
            .map(x => clean(x, 300)).filter(Boolean),
          note: clean(v.note, 1500),
          ...tidyMarks(v),
        };
        return;
      }
      // Visitors: groups of people received by the Session, each a small
      // structure (see public/js/visitors-text.js). The Linguist's or another
      // member's name is put in the roster's form; visitors' own names are
      // kept exactly as typed — they are not on the roster.
      if (k === 'visitors') {
        const PURPOSES = ['presentation', 'funeral', 'marriage', 'seminarian', 'committee', 'courtesy', 'other'];
        const day = x => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || '')) ? String(x) : '');
        next[k] = (Array.isArray(patch[k]) ? patch[k] : []).slice(0, 20).map(g => {
          g = g || {};
          const people = (Array.isArray(g.people) ? g.people : []).slice(0, 40)
            .map(x => ({ name: clean(x && x.name, 120), role: clean(x && x.role, 160) })).filter(x => x.name);
          const leader = clean(g.leader, 120);
          return {
            purpose: PURPOSES.includes(g.purpose) ? g.purpose : 'presentation',
            otherLabel: clean(g.otherLabel, 80),
            people,
            leader: people.some(x => x.name === leader) ? leader : '',
            from: clean(g.from, 160),
            // '__self__' — they introduced themselves.
            introducedBy: g.introducedBy === '__self__' ? '__self__' : SM.resolveName(all, clean(g.introducedBy, 120)),
            introducedByLinguist: !!g.introducedByLinguist,
            why: clean(g.why, 400),
            deceased: clean(g.deceased, 160), relation: clean(g.relation, 60), funeralDetails: clean(g.funeralDetails, 400),
            events: (Array.isArray(g.events) ? g.events : []).slice(0, 8).map(e => ({
              what: clean(e && e.what, 80), date: day(e && e.date), time: clean(e && e.time, 20),
              venue: clean(e && e.venue, 200), note: clean(e && e.note, 600),
            })).filter(e => e.what || e.date || e.venue || e.note),
            groom: clean(g.groom, 120), bride: clean(g.bride, 120), weddingDate: day(g.weddingDate),
            marriageCaseId: clean(g.marriageCaseId, 60),
            // A seminarian on attachment or a ministerial probationer (Nov 2026).
            studentKind: g.studentKind === 'probationer' ? 'probationer' : 'seminarian',
            seminary: clean(g.seminary, 160), studyYear: clean(g.studyYear, 30),
            attachFrom: day(g.attachFrom), attachTo: day(g.attachTo),
            entityName: clean(g.entityName, 160),
            // A letter they brought, kept in Correspondence (its id).
            letterId: g.letterId ? clean(String(g.letterId), 60) : '',
            // For a letter from an earlier meeting: what the form shows it as.
            letterHeading: clean(g.letterHeading, 200),
            letterDate: day(g.letterDate),
            letterPages: Math.max(0, Math.min(50, Number(g.letterPages) || 0)),
            details: clean(g.details, 3000),
            response: clean(g.response, 1500), responseIsDecision: !!g.responseIsDecision,
            withdrew: !!g.withdrew,
            // Prayed for before they left; by a member present (roster form) or a typed name.
            prayedFor: !!g.prayedFor,
            prayedBy: g.prayedFor ? SM.resolveName(all, clean(g.prayedBy, 120)) : '',
          };
        });
        return;
      }
      const v = clean(patch[k], 300);
      next[k] = SM.PERSON_KEYS.includes(k) ? SM.resolveName(all, v)
        : k === 'devotionBy' ? SM.resolveNameList(all, v)
        : v;
    });
    return { ...cur, proceedings: next };
  });
  res.json({ proceedings: updated.proceedings });
});

// The agenda drives the minutes, in one direction only:
//
//   ADDED to the agenda    →  brought into the minutes automatically, so an item
//                             remembered late never has to be typed twice.
//   REMOVED from the agenda →  the matching item in the minutes is FLAGGED, not
//                             deleted. A body may already have been written
//                             against it, and no automatic rule should throw
//                             away something a clerk wrote.
//
// Only items the agenda itself put there are ever flagged; anything typed
// straight into the minutes on the night is left alone.
function agendaDiff(doc) {
  const current = doc.sections && doc.sections.length ? doc.sections : SM.newSections();
  const next = SM.seedSectionsFromAgenda(current, doc.agenda || []);
  const label = key => (SM.SECTION_TEMPLATE.find(t => t.key === key) || {}).subject || key;
  const add = [];
  next.forEach(sec => {
    const had = (current.find(c => c.key === sec.key) || {}).children || [];
    const names = new Set(had.map(c => String(c.subject || '').trim().toLowerCase()));
    (sec.children || []).forEach(c => {
      const nm = String(c.subject || '').trim();
      if (nm && !names.has(nm.toLowerCase())) add.push({ key: sec.key, section: label(sec.key), subject: nm });
    });
  });
  const orphans = SM.orphanedFromAgenda(current, doc.agenda || [])
    .map(o => ({ ...o, section: label(o.key) }));
  return { add, orphans, inSync: add.length === 0 && orphans.length === 0 };
}

router.get('/:id/agenda-sync', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  res.json({ ...agendaDiff(doc), agendaItems: (doc.agenda || []).length });
});

// Brings across everything the agenda has gained. Additive only — nothing
// already written into the minutes is removed or overwritten.
router.post('/:id/agenda-sync', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  if (doc.locked) return res.status(400).json({ error: 'These minutes have been adopted and can no longer be altered.' });

  const diff = agendaDiff(doc);
  if (!diff.add.length) return res.json({ added: 0, orphans: diff.orphans, sections: doc.sections });

  const updated = db.mutate('minutes_docs', doc.id, cur => {
    const sections = SM.seedSectionsFromAgenda(
      cur.sections && cur.sections.length ? cur.sections : SM.newSections(), cur.agenda || []);
    return { ...cur, sections, seededFromAgenda: true };
  });
  if (!req.body || req.body.quiet !== true) {
    logActivity({ ...actor(req), action: `Brought ${diff.add.length} agenda item${diff.add.length === 1 ? '' : 's'} into the minutes`, entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
  }
  res.json({
    added: diff.add.length, items: diff.add,
    orphans: SM.orphanedFromAgenda(updated.sections, updated.agenda || []),
    sections: updated.sections,
  });
});

// The minutes follow the agenda: every item and sub-item on the running order
// becomes a numbered item to write against, so the clerk opens the minutes to
// the shape of the meeting rather than to a blank template.
//
// `auto` is how the minutes page seeds itself the first time it is opened. It
// happens once and is stamped, so an item the clerk deliberately deleted is
// never quietly put back on the next visit. The button on the Agenda tab is the
// deliberate version and always runs.
router.post('/:id/seed-from-agenda', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  if (doc.locked) return res.status(400).json({ error: 'These minutes have been adopted and can no longer be altered.' });

  const auto = req.body && req.body.auto === true;
  if (auto && (doc.seededFromAgenda || !(doc.agenda || []).length)) {
    return res.json({ ...doc, seeded: false });
  }
  const before = JSON.stringify(doc.sections || []);
  const sections = SM.seedSectionsFromAgenda(
    doc.sections && doc.sections.length ? doc.sections : SM.newSections(), doc.agenda || []);
  const patch = { sections };
  if (auto) patch.seededFromAgenda = true;
  const saved = db.update('minutes_docs', doc.id, patch);
  res.json({ ...saved, seeded: JSON.stringify(sections) !== before });
});

// Pull the roll from a linked meeting's recorded attendance, matching people
// by name against the Session roster.
router.post('/:id/pull-attendance', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  const meetingId = Number(req.body.meetingId) || doc.meetingId;
  const meeting = meetingId ? db.findById('meetings', meetingId) : null;
  if (!meeting || !meeting.attendance || !meeting.attendance.locked) {
    return res.status(400).json({ error: 'That meeting has no locked attendance to pull from.' });
  }
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const byName = new Map(roster().map(m => [norm(m.name), m.id]));
  const map = idList => [...new Set((idList || []).map(id => {
    const mem = db.findById('members', id);
    return mem ? byName.get(norm(mem.name)) : null;
  }).filter(Boolean))];
  const presentIds = map(meeting.attendance.presentMemberIds);
  const apologyIds = map(meeting.attendance.apologyMemberIds).filter(i => !presentIds.includes(i));
  const known = new Set([...presentIds, ...apologyIds]);
  const absentIds = roster().map(m => m.id).filter(i => !known.has(i));
  const updated = db.update('minutes_docs', doc.id, {
    meetingId,
    roll: { ...(doc.roll || {}), presentIds, apologyIds, absentIds },
  });
  res.json({ doc: updated, matched: presentIds.length + apologyIds.length });
});

router.post('/:id/finalise', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  const updated = db.update('minutes_docs', doc.id, { status: 'final', finalisedBy: actor(req).userName, finalisedAt: new Date().toISOString() });
  logActivity({ ...actor(req), action: 'Finalised Session minutes', entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
  res.json(updated);
});

router.delete('/:id', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  correspondenceFor(doc.id).forEach(c => {
    unlinkPages(c);
    db.remove('correspondence', c.id);
  });
  db.remove('minutes_docs', doc.id);
  logActivity({ ...actor(req), action: 'Deleted Session minutes', entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
  res.json({ ok: true });
});

// ---------------------------------------------------- correspondence inbox ----
// Letters are scanned in by the Church Administrator as they arrive, before
// there is any meeting to put them in. The Clerk sorts each one:
//   new       scanned, waiting to be sorted
//   session   for the Session — offered on the Correspondence tab of the next
//             minutes, where he brings in the ones to be read
//   handled   dealt with without coming to the Session
//   tabled    brought into a set of minutes (minutesId set)
// Nothing is deleted when a letter moves on, so the register keeps every
// letter received and where it went. Letters recorded straight into minutes
// before the inbox existed have a minutesId and no status, and read as tabled.
const INBOX_STATES = ['new', 'session', 'handled'];
function letterStatus(c) { return c.minutesId ? 'tabled' : (INBOX_STATES.includes(c.status) ? c.status : 'new'); }
function nextSessionDate() {
  const today = toDayKey(new Date());
  const ahead = db.findAll('minutes_docs').map(d => String(d.date || '')).filter(d => d >= today).sort();
  return ahead[0] || '';
}
function inboxView(c, dates) {
  return { ...c, status: letterStatus(c), pages: pagesOf(c).length, meetingDate: (dates && dates[c.minutesId]) || '' };
}

router.get('/correspondence/inbox', requireAuth, (req, res) => {
  if (!canIntake(req)) return res.status(403).json({ error: 'You do not have access to the correspondence inbox.' });
  const dates = {};
  db.findAll('minutes_docs').forEach(d => { dates[d.id] = d.date; });
  const all = db.findAll('correspondence').map(c => inboxView(c, dates));
  const waiting = all.filter(c => c.status !== 'tabled')
    .sort((a, b) => String(a.receivedOn || '').localeCompare(String(b.receivedOn || '')) || a.id - b.id);
  const tabled = all.filter(c => c.status === 'tabled' && c.fromInbox)
    .sort((a, b) => String(b.meetingDate).localeCompare(String(a.meetingDate)) || b.id - a.id).slice(0, 60);
  const counts = { new: 0, session: 0, handled: 0 };
  waiting.forEach(c => { counts[c.status] = (counts[c.status] || 0) + 1; });
  res.json({
    letters: waiting.concat(tabled), counts,
    nextMeeting: nextSessionDate(),
    canSort: canEdit(req),
    aiEnabled: ai.isConfigured(),
  });
});

// Scan a letter in. Pages are optional here — a letter can be opened and its
// pages attached afterwards, as on the minutes page.
router.post('/correspondence/inbox', requireAuth, (req, res) => {
  if (!canIntake(req)) return res.status(403).json({ error: 'You do not have access to the correspondence inbox.' });
  upload.array('letter', MAX_PAGES)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'One of those files is larger than 12 MB.' : err.message });
    if (badTypes(req.files)) return res.status(400).json({ error: 'Please upload the letter pages as JPG, PNG or PDF.' });
    const files = storePages(req.files, 'corr-inbox');
    const on = clean(req.body.receivedOn, 10);
    const rec = db.insert('correspondence', {
      minutesId: null,
      status: 'new',
      heading: clean(req.body.heading, 200) || 'New correspondence',
      summary: '', action: '', from: '', letterDate: '', eventDate: '',
      receivedOn: /^\d{4}-\d{2}-\d{2}$/.test(on) ? on : toDayKey(new Date()),
      files, file: files[0] || null, order: 0,
      addedBy: actor(req).userName,
    });
    logActivity({ ...actor(req), action: 'Scanned in a letter', entityType: 'correspondence', entityId: rec.id, entityLabel: rec.heading });
    res.status(201).json(inboxView(rec));
  });
});

// The Clerk's sorting: for the Session, handled without it, or back to new.
router.post('/correspondence/:cid/sort', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const rec = db.findById('correspondence', req.params.cid);
  if (!rec) return res.status(404).json({ error: 'Correspondence not found.' });
  if (rec.minutesId) return res.status(400).json({ error: 'That letter is already in a set of minutes.' });
  const to = clean(req.body.to, 20);
  if (!INBOX_STATES.includes(to)) return res.status(400).json({ error: 'Sort it to new, session or handled.' });
  const patch = { status: to, sortedBy: actor(req).userName, sortedAt: new Date().toISOString() };
  if (to === 'handled') patch.handledNote = clean(req.body.note, 500);
  const updated = db.update('correspondence', rec.id, patch);
  logActivity({ ...actor(req), action: to === 'handled' ? 'Handled a letter without the Session' : to === 'session' ? 'Sent a letter to the Session' : 'Returned a letter to the inbox', entityType: 'correspondence', entityId: rec.id, entityLabel: rec.heading });
  res.json(inboxView(updated));
});

// Bring letters from the inbox into these minutes. They join after any letter
// already recorded here, in the order they were received.
router.post('/:id/correspondence/bring', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  if (doc.locked || doc.status === 'final') return res.status(400).json({ error: 'These minutes are final. Reopen them before bringing in letters.' });
  const ids = [...new Set((Array.isArray(req.body.ids) ? req.body.ids : []).map(Number).filter(Boolean))];
  const picked = ids.map(i => db.findById('correspondence', i)).filter(c => c && !c.minutesId)
    .sort((a, b) => String(a.receivedOn || '').localeCompare(String(b.receivedOn || '')) || a.id - b.id);
  if (!picked.length) return res.status(400).json({ error: 'Choose at least one letter from the inbox.' });
  let order = correspondenceFor(doc.id).reduce((m, c) => Math.max(m, c.order || 0), 0);
  const brought = picked.map(c => {
    order += 10;
    return db.update('correspondence', c.id, { minutesId: doc.id, status: 'tabled', fromInbox: true, order, tabledAt: new Date().toISOString(), tabledBy: actor(req).userName });
  });
  logActivity({ ...actor(req), action: `Brought ${brought.length} letter${brought.length === 1 ? '' : 's'} into the minutes`, entityType: 'minutes', entityId: doc.id, entityLabel: doc.date });
  res.json({ brought, correspondence: correspondenceFor(doc.id) });
});

// Take a letter back out of the minutes — deferred to another meeting, or
// brought in by mistake. It returns to the inbox as "for the Session".
router.post('/correspondence/:cid/return', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  const rec = db.findById('correspondence', req.params.cid);
  if (!rec) return res.status(404).json({ error: 'Correspondence not found.' });
  const doc = rec.minutesId && db.findById('minutes_docs', rec.minutesId);
  if (!doc) return res.status(400).json({ error: 'That letter is not in any minutes.' });
  if (doc.locked || doc.status === 'final') return res.status(400).json({ error: 'Those minutes are final — the letter stays where it was read.' });
  const updated = db.update('correspondence', rec.id, {
    minutesId: null, status: 'session', order: 0,
    returnedFrom: { minutesId: doc.id, date: doc.date },
  });
  logActivity({ ...actor(req), action: 'Sent a letter back to the inbox', entityType: 'correspondence', entityId: rec.id, entityLabel: rec.heading });
  res.json(inboxView(updated));
});

// -------------------------------------------------------- correspondence ----
// Searchable register across every meeting — "did we ever get a letter from…".
router.get('/correspondence/register', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const q = String(req.query.q || '').trim().toLowerCase();
  const dates = {};
  db.findAll('minutes_docs').forEach(d => { dates[d.id] = d.date; });
  let list = db.findAll('correspondence').map(c => ({ ...c, meetingDate: dates[c.minutesId] || '', pages: pagesOf(c).length }));
  if (q) {
    list = list.filter(c => `${c.heading} ${c.summary} ${c.from}`.toLowerCase().includes(q));
  }
  list.sort((a, b) => String(b.meetingDate).localeCompare(String(a.meetingDate)) || b.id - a.id);
  res.json(list.slice(0, 300));
});

// Correspondence exported to share, as Word or PDF (Oct 2026). One route for
// every place letters are listed:
//   scope=inbox     the Correspondence Inbox — view=new|session|handled|tabled|all
//   scope=register  the Session's register of every letter — q= as searched
//   scope=minutes   the letters read at one meeting — id=<minutes id>
//   scope=waiting   the letters waiting for the Session (the box on the
//                   Correspondence tab of a set of minutes)
// ids=1,2,3 narrows any of them to the letters ticked; pages=1 puts the scanned
// pages in after each letter.
router.get('/correspondence/export', requireAuth, async (req, res) => {
  const scope = String(req.query.scope || 'register');
  const format = req.query.format === 'docx' ? 'docx' : 'pdf';
  const inboxSide = scope === 'inbox' || scope === 'waiting';
  if (inboxSide ? !canIntake(req) : !canView(req)) {
    return res.status(403).json({ error: inboxSide ? 'You do not have access to the correspondence inbox.' : 'You do not have access to the Session minutes.' });
  }
  const dates = {};
  db.findAll('minutes_docs').forEach(d => { dates[d.id] = d.date; });
  const view = c => ({ ...inboxView(c, dates), pageCount: pagesOf(c).length, files: pagesOf(c) });
  const byReceived = (a, b) => String(a.receivedOn || '').localeCompare(String(b.receivedOn || '')) || a.id - b.id;
  let letters = [], title = 'Correspondence', subtitle = '', stem = 'Correspondence';
  const VIEW_TITLE = { new: 'Letters to be sorted', session: 'Letters for the Session', handled: 'Letters handled without the Session', tabled: 'Letters brought into minutes', all: 'All letters in the inbox' };
  if (scope === 'inbox') {
    const v = VIEW_TITLE[req.query.view] ? String(req.query.view) : 'all';
    letters = db.findAll('correspondence').map(view)
      .filter(c => (v === 'all' ? (c.status !== 'tabled' || c.fromInbox) : c.status === v))
      .sort(v === 'tabled' ? (a, b) => String(b.meetingDate).localeCompare(String(a.meetingDate)) || b.id - a.id : byReceived);
    title = 'Correspondence Inbox';
    subtitle = VIEW_TITLE[v];
    stem = `Correspondence_Inbox_${v}`;
  } else if (scope === 'waiting') {
    letters = db.findAll('correspondence').map(view).filter(c => c.status === 'session').sort(byReceived);
    title = 'Correspondence for the Session';
    const next = nextSessionDate();
    subtitle = next ? `Waiting for the meeting of ${CX.longDay(next)}` : 'Waiting for the next meeting';
    stem = 'Correspondence_for_the_Session';
  } else if (scope === 'minutes') {
    const doc = db.findById('minutes_docs', req.query.id);
    if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
    letters = correspondenceFor(doc.id).map(view);
    title = 'Correspondence';
    subtitle = `Read at the ${doc.title || 'Session meeting'} of ${CX.longDay(doc.date)}`;
    stem = `Correspondence_${doc.date || doc.id}`;
  } else {
    const q = String(req.query.q || '').trim().toLowerCase();
    letters = db.findAll('correspondence').map(view)
      .filter(c => !q || `${c.heading} ${c.summary} ${c.from}`.toLowerCase().includes(q))
      .sort((a, b) => String(b.meetingDate).localeCompare(String(a.meetingDate)) || b.id - a.id);
    title = 'Correspondence Register';
    subtitle = q ? `Letters matching “${String(req.query.q).trim()}”` : 'Every letter received by the Session';
    stem = 'Correspondence_Register';
  }
  const ids = String(req.query.ids || '').split(',').map(Number).filter(Boolean);
  if (ids.length) letters = letters.filter(c => ids.includes(c.id));
  const today = toDayKey(new Date());
  subtitle = `${subtitle} · ${letters.length} letter${letters.length === 1 ? '' : 's'}`;
  const footer = `Prepared from AOTC Track on ${CX.longDay(today)} by ${actor(req).userName || 'the Session'}`;
  const opts = { pages: req.query.pages === '1', filesDir: FILES_DIR };
  try {
    const data = { title, subtitle, footer, letters };
    const buf = format === 'docx' ? await CX.buildCorrespondenceDocx(data, opts) : await CX.buildCorrespondencePdf(data, opts);
    const name = `${stem}_${today}.${format}`.replace(/[^\w.-]+/g, '_');
    res.setHeader('Content-Type', format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf');
    res.setHeader('Content-Disposition', `${format === 'pdf' ? 'inline' : 'attachment'}; filename="${name}"`);
    logActivity({ ...actor(req), action: `Exported ${letters.length} letter${letters.length === 1 ? '' : 's'} (${format === 'docx' ? 'Word' : 'PDF'})`, entityType: 'correspondence', entityId: 0, entityLabel: title });
    res.send(buf);
  } catch (e) {
    console.error('[correspondence export]', e);
    res.status(500).json({ error: 'Could not build the file: ' + e.message });
  }
});

// Ask Claude to draft heading + summary from the letter. Nothing is saved here
// — the clerk reviews the draft first.
// The Action is what the SESSION did with the letter, so the draft never fills
// it in (Oct 2026: AI drafts were leaving "For decision" in every letter and it
// went into the minutes). Claude's view comes back as a suggestion only, shown
// beside the empty Action box for the Clerk to take or ignore.
const asSuggestion = d => ({ ...d, action: '', actionSuggested: d.action || '' });
router.post('/correspondence/draft', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  upload.array('letter', MAX_PAGES)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'One of those files is larger than 12 MB.' : err.message });
    try {
      if (badTypes(req.files)) {
        return res.status(400).json({ error: 'Please upload the letter pages as JPG, PNG or PDF.' });
      }
      const draft = await ai.draftCorrespondence({ files: req.files, text: req.body.text, style: settings.getSettings().correspondenceStyle });
      res.json(asSuggestion(draft));
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'Could not draft the summary.' });
    }
  });
});

router.post('/:id/correspondence', requireAuth, (req, res) => {
  if (!requireEdit(req, res)) return;
  upload.array('letter', MAX_PAGES)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'One of those files is larger than 12 MB.' : err.message });
    const doc = db.findById('minutes_docs', req.params.id);
    if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
    // A letter may be opened as an empty entry and filled in afterwards, so a
    // heading is not demanded up front — only that it has one by the time the
    // minutes are produced.
    const heading = clean(req.body.heading, 200) || 'New correspondence';
    if (badTypes(req.files)) return res.status(400).json({ error: 'Please upload the letter pages as JPG, PNG or PDF.' });
    const files = storePages(req.files, `corr-${doc.id}`);
    const order = correspondenceFor(doc.id).reduce((m, c) => Math.max(m, c.order || 0), 0) + 10;
    const rec = db.insert('correspondence', {
      minutesId: doc.id,
      heading,
      summary: clean(req.body.summary, 4000),
      action: clean(req.body.action, 60),
      from: clean(req.body.from, 200),
      letterDate: /^\d{4}-\d{2}-\d{2}$/.test(clean(req.body.letterDate, 10)) ? clean(req.body.letterDate, 10) : '',
      draftedByAi: req.body.draftedByAi === 'true' || req.body.draftedByAi === true,
      files, file: files[0] || null, order,
      addedBy: actor(req).userName,
    });
    res.status(201).json(rec);
  });
});

// Draft from the pages already attached to this one letter. Scoped to a single
// correspondence record on purpose: pages belonging to different letters are
// never read together, so a summary can't be built from the wrong sheets.
router.post('/correspondence/:cid/draft', requireAuth, async (req, res) => {
  const rec = db.findById('correspondence', req.params.cid);
  if (!rec) return res.status(404).json({ error: 'Correspondence not found.' });
  if (!requireLetterEdit(req, res, rec)) return;
  const pages = pagesOf(rec);
  const typed = clean(req.body && req.body.text, 20000);
  if (!pages.length && !typed) {
    return res.status(400).json({ error: 'Attach the pages of this letter first, or paste its text.' });
  }
  // Re-read the stored pages off disk in order.
  const files = [];
  for (const pg of pages) {
    const fp = path.join(FILES_DIR, path.basename(pg.filename));
    if (!fs.existsSync(fp)) continue;
    files.push({ buffer: fs.readFileSync(fp), mimetype: pg.mimetype, originalname: pg.originalName });
  }
  try {
    const draft = await ai.draftCorrespondence({ files, text: typed, style: settings.getSettings().correspondenceStyle });
    res.json({ ...asSuggestion(draft), pages: files.length });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not draft the summary.' });
  }
});

// A letter the visitors brought: read for the Visitors form (see
// ai.readVisitorLetter). The letter itself stays in Correspondence.
router.post('/correspondence/:cid/visitors-read', requireAuth, async (req, res) => {
  const rec = db.findById('correspondence', req.params.cid);
  if (!rec) return res.status(404).json({ error: 'Correspondence not found.' });
  if (!requireLetterEdit(req, res, rec)) return;
  const files = [];
  for (const pg of pagesOf(rec)) {
    const fp = path.join(FILES_DIR, path.basename(pg.filename));
    if (fs.existsSync(fp)) files.push({ buffer: fs.readFileSync(fp), mimetype: pg.mimetype, originalname: pg.originalName });
  }
  if (!files.length) return res.status(400).json({ error: 'This letter has no pages attached yet.' });
  try {
    const read = await ai.readVisitorLetter({ files });
    // Give the register entry a proper heading and summary if it has none yet.
    const patch = {};
    // Only a letter of the meeting being written gets its register entry
    // filled; a letter from an earlier meeting is read, never changed.
    const sameMeeting = Number(req.body && req.body.minutesId) === Number(rec.minutesId);
    if (!sameMeeting) return res.json({ read, letter: rec });
    if ((!rec.heading || /^(new correspondence|letter from visitors)$/i.test(rec.heading)) && read.heading) patch.heading = read.heading;
    if (!String(rec.summary || '').trim() && read.summary) { patch.summary = read.summary; patch.draftedByAi = true; }
    const letter = Object.keys(patch).length ? db.update('correspondence', rec.id, patch) : rec;
    res.json({ read, letter });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || 'Could not read the letter.' });
  }
});

// Add more pages to a letter already recorded.
router.post('/correspondence/:cid/pages', requireAuth, (req, res) => {
  const pre = db.findById('correspondence', req.params.cid);
  if (!pre) return res.status(404).json({ error: 'Correspondence not found.' });
  if (!requireLetterEdit(req, res, pre)) return;
  upload.array('letter', MAX_PAGES)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'One of those files is larger than 12 MB.' : err.message });
    const rec = db.findById('correspondence', req.params.cid);
    if (!rec) return res.status(404).json({ error: 'Correspondence not found.' });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No pages received.' });
    if (badTypes(req.files)) return res.status(400).json({ error: 'Please upload the pages as JPG, PNG or PDF.' });
    const existing = pagesOf(rec);
    if (existing.length + req.files.length > MAX_PAGES) {
      return res.status(400).json({ error: `A letter can hold at most ${MAX_PAGES} pages.` });
    }
    const files = existing.concat(storePages(req.files, `corr-${rec.minutesId || 'inbox'}`));
    res.json(db.update('correspondence', rec.id, { files, file: files[0] || null }));
  });
});

// Remove one page from a letter, keeping the rest.
router.delete('/correspondence/:cid/pages/:idx', requireAuth, (req, res) => {
  const rec = db.findById('correspondence', req.params.cid);
  if (!rec) return res.status(404).json({ error: 'Correspondence not found.' });
  if (!requireLetterEdit(req, res, rec)) return;
  const files = pagesOf(rec).slice();
  const i = Number(req.params.idx);
  if (!files[i]) return res.status(404).json({ error: 'That page was not found.' });
  try { fs.unlinkSync(path.join(FILES_DIR, path.basename(files[i].filename))); } catch (e) {}
  files.splice(i, 1);
  res.json(db.update('correspondence', rec.id, { files, file: files[0] || null }));
});

router.put('/correspondence/:cid', requireAuth, (req, res) => {
  const rec = db.findById('correspondence', req.params.cid);
  if (!rec) return res.status(404).json({ error: 'Correspondence not found.' });
  if (!requireLetterEdit(req, res, rec)) return;
  const patch = {};
  ['heading', 'from', 'action', 'actionSuggested'].forEach(k => { if (req.body[k] !== undefined) patch[k] = clean(req.body[k], 200); });
  if (req.body.summary !== undefined) patch.summary = clean(req.body.summary, 4000);
  // What the Session said when the letter was read. Kept apart from the summary
  // while editing — the drafting rewrites the summary and must never touch this
  // — but printed as a continuation of the same paragraph.
  if (req.body.deliberation !== undefined) patch.deliberation = clean(req.body.deliberation, 4000);
  // Tidy marks for "What the Session said" — see tidyMarks. Never printed.
  if (req.body.delibTidiedWords !== undefined) patch.delibTidiedWords = tidyMarks({ tidiedWords: req.body.delibTidiedWords }).tidiedWords;
  if (req.body.delibHandChecked !== undefined) patch.delibHandChecked = !!req.body.delibHandChecked;
  if (req.body.letterDate !== undefined) {
    const d = clean(req.body.letterDate, 10);
    patch.letterDate = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
  }
  if (req.body.draftedByAi !== undefined) patch.draftedByAi = !!req.body.draftedByAi;
  ['receivedOn', 'eventDate'].forEach(k => {
    if (req.body[k] === undefined) return;
    const d = clean(req.body[k], 10);
    patch[k] = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
  });
  if (req.body.order !== undefined) patch.order = Number(req.body.order) || rec.order;
  res.json(db.update('correspondence', rec.id, patch));
});

router.delete('/correspondence/:cid', requireAuth, (req, res) => {
  const rec = db.findById('correspondence', req.params.cid);
  if (!rec) return res.status(404).json({ error: 'Correspondence not found.' });
  if (!requireLetterEdit(req, res, rec)) return;
  unlinkPages(rec);
  db.remove('correspondence', rec.id);
  res.json({ ok: true });
});

function sendPage(req, res, idx) {
  const rec = db.findById('correspondence', req.params.cid);
  if (!(canView(req) || (canIntake(req) && rec && !rec.minutesId))) return requireView(req, res);
  const page = pagesOf(rec)[idx];
  if (!page) return res.status(404).json({ error: 'No letter page there.' });
  const fp = path.join(FILES_DIR, path.basename(page.filename));
  if (!fs.existsSync(fp)) return res.status(410).json({ error: 'The attached file is missing on the server.' });
  res.setHeader('Content-Type', page.mimetype || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${(page.originalName || page.filename).replace(/"/g, '')}"`);
  res.send(fs.readFileSync(fp));
}
// The first page — the URL older records and links already use.
router.get('/correspondence/:cid/file', requireAuth, (req, res) => sendPage(req, res, 0));
// Any page of a multi-page letter.
router.get('/correspondence/:cid/file/:idx', requireAuth, (req, res) => sendPage(req, res, Number(req.params.idx) || 0));

// ------------------------------------------------------------- documents ----
// People in attendance, as printed (21 Oct 2026, the Clerk's choice): NAME and
// a SHORT title in the same columns as the members, and any longer description
// on its own line underneath in ordinary letters. The same person entered twice
// (e.g. copied in as a presenter and added by hand) prints once. An older entry
// whose whole description sits in the title is split at its first natural
// break: "Third-year seminarian from Trinity Theological Seminary. He is on
// attachment" → SEMINARIAN-style title "Third-year seminarian" + details.
const TITLE_MAX = 32;
function splitTitle(pos) {
  const t = String(pos || '').trim();
  if (t.length <= TITLE_MAX) return { position: t, details: '' };
  const m = t.match(/^(.{3,32}?)(?:\s*[,;:.(–—-]\s+|\s+(?=(?:from|of|at|with|on|who|in)\b))(.+)$/i);
  if (m) return { position: m[1].trim(), details: m[2].trim().replace(/^\w/, c => c.toUpperCase()) };
  return { position: 'In attendance', details: t };
}
function attendanceList(guests) {
  const out = [], seen = new Map();
  (guests || []).forEach(g => {
    const name = String(g.name || '').trim();
    if (!name) return;
    const split = g.details ? { position: g.position, details: g.details } : splitTitle(g.position);
    const entry = { name, position: split.position || 'In attendance', details: String(split.details || '').trim() };
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const had = seen.get(key);
    if (had) {
      // Keep one line per person: the fuller description wins.
      if ((entry.details || '').length > (had.details || '').length) had.details = entry.details;
      if (/^(in attendance|presenter)$/i.test(had.position) && !/^(in attendance)$/i.test(entry.position)) had.position = entry.position;
      return;
    }
    seen.set(key, entry); out.push(entry);
  });
  return out.map(e => (e.details ? e : { name: e.name, position: e.position }));
}

// Assemble everything the Word/PDF builders need from the stored document.
function docData(doc) {
  // Everyone who sat on the Session on that date, in the position held then.
  const all = membersFor(doc).map(m => ({ ...m, position: positionOn(m, doc.date) }));
  const byId = new Map(all.map(m => [m.id, m]));
  const roll = doc.roll || {};
  const online = new Set((roll.onlineIds || []).map(Number));
  // The listing form, with the academic title in brackets, because that is how
  // the roster of a meeting is set out: "Rev Martin Owusu Boamah (Dr)".
  const pick = ids => (ids || []).map(Number).map(i => byId.get(i)).filter(Boolean).sort(SM.byRank)
    .map(m => ({ ...m, name: SM.displayName(m), position: SM.rosterPosition(m.position) }));

  // Members present and people in attendance are listed separately: the Session
  // is a court of its members, and a visitor is not one of them.
  const present = pick(roll.presentIds).map(m => ({
    name: online.has(m.id) ? `${m.name} (online)` : m.name, position: m.position, rank: m.rank,
  }));
  const inAttendance = attendanceList(roll.guests);

  // The signature block names whoever held the office ON THE DATE OF THE
  // MEETING, not whoever holds it today — otherwise reprinting last quarter's
  // minutes after a new District Minister is inducted puts his name on a
  // sitting he never attended. See utils/officeTerms.
  // The roster is the fallback, so minutes still sign correctly before any
  // terms have been recorded.
  const byPosition = pos => roster().find(m => String(m.position || '').toLowerCase() === pos);
  const clerkNow = byPosition('session clerk');
  const ministerNow = byPosition('district minister');
  const clerkName = OT.nameOn('session_clerk', doc.date) || (clerkNow && clerkNow.name) || '';
  const ministerName = OT.nameOn('district_minister', doc.date) || (ministerNow && ministerNow.name) || '';
  // Minutes are confirmed by the CHAIRMAN of the meeting — whoever constituted
  // the Session that night — not automatically by the minister in charge. On
  // 24 Sept 2026 Rev Dr Martin Owusu Boamah chaired, yet the export put Rev
  // Akyeampong's name under "Confirmed by". When the minister chaired, the
  // panel keeps his office; anyone else signs as Chairman. No chair recorded:
  // the minister, as before.
  const chair = String((doc.proceedings || {}).constitutedBy || '').trim();
  const chairIsMinister = !chair || (ministerName && SM.isSameMember(chair, ministerName));

  // Minutes are signed by whoever recorded them. Normally the Session Clerk;
  // when someone else took them (proceedings.recordedBy, e.g. the Assistant
  // Session Clerk), that person signs as Recorder in his place.
  const recorder = String((doc.proceedings || {}).recordedBy || '').trim();
  const recorderIsClerk = !recorder || (clerkName && SM.isSameMember(recorder, clerkName))
    || roster().some(m => /^session clerk$/i.test(String(m.position || '').trim()) && SM.isSameMember(m.name, recorder));

  return {
    heading: (doc.title || 'AOTC Session Meeting').toUpperCase().startsWith('AOTC')
      ? doc.title : `AOTC ${doc.title || 'Session Meeting'}`,
    date: doc.date,
    venue: doc.venue,
    present,
    inAttendance,
    apologies: pick(roll.apologyIds),
    absent: pick(roll.absentIds),
    rows: SM.renderRows(doc, { correspondence: correspondenceFor(doc.id), members: membersFor(doc), clerk: clerkName, earlierLetters: earlierLettersFor(doc) }),
    appendices: doc.appendices || [],
    signatories: {
      recordedBy: recorderIsClerk
        ? { name: clerkName || doc.recordedBy || '', title: 'Session Clerk' }
        : { name: recorder, title: 'Recorder' },
      confirmedBy: chairIsMinister
        ? { name: ministerName || chair, title: 'Minister-in-Charge' }
        : { name: chair, title: 'Chairman' },
    },
    footerName: 'Session',
  };
}

function fileBase(doc, what) {
  return `${String(doc.date || '').replace(/-/g, '')}_${what}_of_Session_Meeting`;
}

async function sendDoc(res, buf, filename, mime, inline) {
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`);
  res.send(buf);
}

router.get('/:id/minutes.docx', requireAuth, async (req, res) => {
  if (!requireView(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  try {
    const buf = await buildSessionMinutesDocx(docData(doc));
    sendDoc(res, buf, `${fileBase(doc, 'Minutes')}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', false);
  } catch (e) {
    console.error('[minutes-docx]', e);
    res.status(500).json({ error: 'Could not build the Word minutes.' });
  }
});

router.get('/:id/minutes.pdf', requireAuth, async (req, res) => {
  if (!requireView(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  try {
    const buf = await buildSessionMinutesPdf(docData(doc));
    sendDoc(res, buf, `${fileBase(doc, 'Minutes')}.pdf`, 'application/pdf', true);
  } catch (e) {
    console.error('[minutes-pdf]', e);
    res.status(500).json({ error: 'Could not build the PDF minutes.' });
  }
});

// The agenda is posted to the Session's WhatsApp group by hand, so the app
// writes the post: the same numbering and clock times as the printed agenda,
// in WhatsApp's own light formatting, ready to paste. The app cannot post it —
// that needs a WhatsApp Business account — but it can save the retyping.
// "27th", "1st", "22nd" — the way the Clerk writes a date in the group.
function ordinal(n) {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}
function longDate(iso) {
  if (!iso) return 'date to be confirmed';
  const d = toLocalDate(iso);
  if (isNaN(d)) return iso;
  const day = d.toLocaleDateString('en-GB', { weekday: 'long' });
  const month = d.toLocaleDateString('en-GB', { month: 'long' });
  return `${day}, ${ordinal(d.getDate())} ${month} ${d.getFullYear()}`;
}
// Ghana keeps UTC, so the server clock is the Clerk's clock.
// The closing line follows the time of day. The page swaps it again at the
// moment the message is shared or copied (freshBlessing in app.js), so a post
// written in the afternoon and sent at night still says "night".
function blessing() {
  const h = new Date().getHours();
  if (h < 12) return 'Have a blessed day.';
  if (h < 16) return 'Have a blessed afternoon.';
  if (h < 20) return 'Have a blessed evening.';
  return 'Have a blessed night.';
}

// The invitation as the Clerk writes it in the group — the wording is his, the
// details are the app's, and it is editable before it goes out.
function whatsappNotice(doc) {
  const title = doc.title || 'Session Meeting';
  const article = /^[aeiou]/i.test(title) ? 'an' : 'a';
  const startMins = SM.parseTime(doc.startTime);
  const time = startMins == null ? 'to be confirmed' : SM.fmtTime(startMins).replace(' ', '');
  const hasAgenda = (doc.agenda || []).length > 0;
  return [
    'May the peace of the Lord be with you.',
    `You are kindly invited to attend ${article} ${title} scheduled as follows:`,
    ` • Date: ${longDate(doc.date)}`,
    ` • Time: ${time}`,
    ` • Venue: ${doc.venue || 'to be confirmed'}`,
    hasAgenda
      ? 'Please find the agenda for the meeting attached.'
      : 'The agenda for the meeting would be shared soon.',
    'Thank you, and may the Lord guide our deliberations.',
    `${blessing()} 🙏🏾🙏🏾`,
  ].join('\n');
}

// The message that goes WITH the agenda picture when it is shared to WhatsApp
// (21 Oct 2026, the Clerk's request) — short, because the picture carries the
// agenda itself, and opening as every post to the group does.
function whatsappImageCaption(doc) {
  const title = doc.title || 'Session Meeting';
  const startMins = SM.parseTime(doc.startTime);
  const time = startMins == null ? '' : ` at ${SM.fmtTime(startMins).replace(' ', '')}`;
  const v = String(doc.venue || '').trim();
  const venue = v ? `, at ${/^the\b/i.test(v) ? '' : 'the '}${v}` : '';
  return [
    'May the peace of the Lord be with you.',
    `Please find attached the agenda for the ${title} scheduled for ${longDate(doc.date)}${time}${venue}.`,
    // "Kindly note the time" taken out at the Clerk's request (21 Oct 2026).
    'Thank you, and may the Lord guide our deliberations.',
    `${blessing()} 🙏🏾🙏🏾`,
  ].join('\n');
}

router.get('/:id/whatsapp', requireAuth, (req, res) => {
  if (!requireView(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });

  // Two posts get made to the group: the invitation when the meeting is
  // called, and the agenda once it is settled.
  if (String(req.query.kind || '') === 'notice') {
    return res.json({ text: whatsappNotice(doc) });
  }
  if (String(req.query.kind || '') === 'image') {
    return res.json({ text: whatsappImageCaption(doc) });
  }

  const when = doc.date
    ? toLocalDate(doc.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : 'date to be confirmed';
  const lines = [];
  lines.push(`*PCG-AOTC — ${doc.title || 'Session Meeting'}*`);
  const startMins = SM.parseTime(doc.startTime);
  lines.push(when + (startMins == null ? '' : ` at ${SM.fmtTime(startMins)}`));
  if (doc.venue) lines.push(doc.venue);

  const rows = SM.computeAgenda(doc.agenda || [], doc.startTime);
  if (rows.length) {
    lines.push('');
    lines.push('*AGENDA*');
    rows.forEach((r, i) => {
      lines.push(`${i + 1}. ${r.item}${r.label ? ` — ${r.label}` : ''}`);
      (r.subItems || []).forEach((s, j) => {
        const item = typeof s === 'string' ? s : (s.item || '');
        if (item) lines.push(`    ${String.fromCharCode(97 + j)}) ${item}`);
      });
    });
  }
  const note = agendaNoteLine();
  lines.push('');
  lines.push(rows.length ? 'Kindly note the time. Thank you.' : (note || 'Kindly note the time. Thank you.'));

  res.json({ text: lines.join('\n') });
});

function agendaData(doc) {
  return {
    heading: (doc.title || 'Session Meeting'),
    date: doc.date,
    rows: SM.computeAgenda(doc.agenda || [], doc.startTime),
    footerName: 'Session',
  };
}

router.get('/:id/agenda.docx', requireAuth, async (req, res) => {
  if (!requireView(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  try {
    const buf = await buildSessionAgendaDocx(agendaData(doc));
    sendDoc(res, buf, `${fileBase(doc, 'Agenda')}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', false);
  } catch (e) {
    console.error('[agenda-docx]', e);
    res.status(500).json({ error: 'Could not build the Word agenda.' });
  }
});

router.get('/:id/agenda.pdf', requireAuth, async (req, res) => {
  if (!requireView(req, res)) return;
  const doc = db.findById('minutes_docs', req.params.id);
  if (!doc) return res.status(404).json({ error: 'Minutes not found.' });
  try {
    const buf = await buildSessionAgendaPdf(agendaData(doc));
    sendDoc(res, buf, `${fileBase(doc, 'Agenda')}.pdf`, 'application/pdf', true);
  } catch (e) {
    console.error('[agenda-pdf]', e);
    res.status(500).json({ error: 'Could not build the PDF agenda.' });
  }
});

// The venue list is settled (and the old hall name moved on) as the server
// starts, so reminders sent before anyone opens a Session page already carry
// the right venue.
setImmediate(() => { try { sessionVenues(); } catch (e) { console.error('[session] venues:', e.message); } });
// One time (Oct 2026): letters whose Action was only ever Claude's default
// "For decision" — drafted, still waiting in the inbox or in minutes not yet
// adopted — get an empty Action, with "For decision" kept as the suggestion,
// so the Clerk is asked to record what the Session did. Adopted minutes are
// never touched.
function clearDefaultActions() {
  const st = settings.getSettings();
  if (st.corrDefaultActionCleared) return;
  try {
    let n = 0;
    db.findAll('correspondence', c => c.draftedByAi && String(c.action || '').trim().toLowerCase() === 'for decision').forEach(c => {
      const doc = c.minutesId ? db.findById('minutes_docs', c.minutesId) : null;
      if (doc && doc.locked) return;
      db.update('correspondence', c.id, { action: '', actionSuggested: c.actionSuggested || 'For decision' });
      n += 1;
    });
    settings.updateSettings({ corrDefaultActionCleared: new Date().toISOString() });
    if (n) console.log(`[session] ${n} letter(s) had Claude's "For decision" as their Action; now left for the Clerk.`);
  } catch (e) { console.error('[session] clearing default actions failed:', e.message); }
}
setImmediate(clearDefaultActions);

module.exports = router;
module.exports._attendanceList = attendanceList;
// For the Home page (routes/home.js): the same rules this file uses, so Home
// never shows a Session item to someone the Session pages would turn away.
module.exports._home = { canView, canEdit, canIntake, letterStatus, onDutyFor, membersFor };
module.exports._docData = docData;
