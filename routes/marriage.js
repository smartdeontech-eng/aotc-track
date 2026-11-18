// AOTC Track — Intended Marriage workflow (CFL), Phase 1.
// Flow: fill the PCG-AOTC-CFL-FR01 interview form online (draft) →
// export a PDF mirroring the original for Session (with-session) →
// wet signatures offline → upload the signed scan (phone photos merged
// into one PDF, or a ready PDF) → stage 'signed', which unlocks the
// counselling phase (Phase 2, coming later).
// CONFIDENTIAL: same access rule as counselling — CFL (counselling.manage)
// and the admin tier only. Files live OUTSIDE public/ and are streamed
// through authenticated routes.
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const db = require('../utils/db');
const { activeUsers } = require('../utils/accountStatus');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const push = require('../utils/push');
const { toLocalDate } = require('../utils/dates');
const { buildMarriageFormPdf, buildSignedScanPdf, buildQuestionnairePdf } = require('../utils/marriagePdf');

const FILES_DIR = path.join(__dirname, '..', 'marriage-files');
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

const { actor } = require('../utils/scope');
function allowed(req) {
  if (['admin', 'localadmin'].includes(req.user.role)) return true;
  const u = db.findById('users', req.user.id) || {};
  return (u.permissions || []).includes('counselling.manage');
}
function guard(req, res) {
  if (allowed(req)) return true;
  res.status(403).json({ error: 'Marriage records are confidential to CFL and administrators.' });
  return false;
}
const manage = [requireAuth, requirePermission('counselling.manage')];
const s = (x, max = 300) => String(x === null || x === undefined ? '' : x).trim().slice(0, max);

// ---- Form normalisation (whitelists every field; nothing else stored) ----
function normPeopleList(list, max, fields) {
  return (Array.isArray(list) ? list : []).slice(0, max)
    .map(p => Object.fromEntries(fields.map(f => [f, s((p || {})[f], 120)])))
    .filter(p => fields.some(f => p[f]));
}
function normForm(f) {
  f = f || {};
  const a = f.a || {}, b = f.b || {}, c = f.c || {}, d = f.d || {}, e = f.e || {}, g = f.g || {}, h = f.h || {};
  const side = x => ({
    fatherSupport: s((x || {}).fatherSupport, 40),
    fatherReasons: s((x || {}).fatherReasons, 500),
    motherSupport: s((x || {}).motherSupport, 40),
    motherReasons: s((x || {}).motherReasons, 500),
    remarks: s((x || {}).remarks, 500),
  });
  return {
    a: {
      date: s(a.date, 10), time: s(a.time, 8),
      committee: normPeopleList(a.committee, 10, ['name', 'role']),
    },
    b: {
      husband: { name: s((b.husband || {}).name, 120), phone: s((b.husband || {}).phone, 30) },
      wife: { name: s((b.wife || {}).name, 120), phone: s((b.wife || {}).phone, 30) },
    },
    c: {
      husbandFamily: normPeopleList(c.husbandFamily, 6, ['name', 'relationship']),
      husbandConsentNote: s(c.husbandConsentNote, 600),
      wifeFamily: normPeopleList(c.wifeFamily, 6, ['name', 'relationship']),
      wifeConsentNote: s(c.wifeConsentNote, 600),
    },
    // Attendance ticked from the CFL roster (memberIds) rather than typed.
    attendance: {
      presentMemberIds: Array.isArray((f.attendance || {}).presentMemberIds)
        ? (f.attendance || {}).presentMemberIds.map(Number).filter(n => !isNaN(n)).slice(0, 60) : [],
    },
    d: Object.fromEntries(Array.from({ length: 17 }, (_, i) => {
      const q = d['q' + (i + 1)] || {};
      return ['q' + (i + 1), { h: s(q.h, 400), w: s(q.w, 400) }];
    })),
    e: { h: side(e.h), w: side(e.w) },
    f: s(f.f, 2500),
    g: {
      recommendation: ['clear', 'concerns'].includes(g.recommendation) ? g.recommendation : '',
      details: s(g.details, 1500),
    },
    h: { coordinatorName: s(h.coordinatorName, 120), secretaryName: s(h.secretaryName, 120), signDate: s(h.signDate, 10) },
  };
}

function coupleLabel(kase) {
  const b = (kase.form || {}).b || {};
  const hn = (b.husband || {}).name, wn = (b.wife || {}).name;
  return (hn || wn) ? `${hn || '?'} & ${wn || '?'}` : `case ${kase.refNo}`;
}
function summarise(k) {
  return {
    id: k.id, refNo: k.refNo, stage: k.stage, couple: coupleLabel(k),
    interviewDate: ((k.form || {}).a || {}).date || '',
    recommendation: (((k.form || {}).g || {}).recommendation) || '',
    signedAt: (k.signedScan || {}).uploadedAt || null,
    counsellorName: ((k.sessionApproval || {}).counsellorName) || '',
    marriageDate: ((k.dates || {}).marriageDate) || '',
    // Traditional (customary) marriage and church wedding: time and place too,
    // for when the couple is presented to the Session (Nov 2026).
    customaryDate: ((k.dates || {}).customaryDate) || '',
    marriageTime: ((k.dates || {}).marriageTime) || '', customaryTime: ((k.dates || {}).customaryTime) || '',
    marriageVenue: ((k.dates || {}).marriageVenue) || '', customaryVenue: ((k.dates || {}).customaryVenue) || '',
    thanksgivingDate: ((k.dates || {}).thanksgivingDate) || '', thanksgivingTime: ((k.dates || {}).thanksgivingTime) || '', thanksgivingVenue: ((k.dates || {}).thanksgivingVenue) || '',
    solemnisedDate: ((k.solemnised || {}).date) || '',
    bannsPublished: Array.isArray(k.banns) ? k.banns.filter(b => b.published).length : null,
    createdAt: k.createdAt, updatedAt: k.updatedAt || k.createdAt,
  };
}

// ---- Cases ----
router.get('/cases', requireAuth, (req, res) => {
  if (!guard(req, res)) return;
  res.json(db.findAll('marriage_cases')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
    .map(summarise));
});

router.get('/cases/:id', requireAuth, (req, res) => {
  if (!guard(req, res)) return;
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  res.json(rec);
});

router.post('/cases', ...manage, (req, res) => {
  const hName = s((req.body || {}).husbandName, 120);
  const wName = s((req.body || {}).wifeName, 120);
  if (!hName || !wName) return res.status(400).json({ error: 'Enter both the intended husband and intended wife names.' });
  const year = new Date().getFullYear();
  const seq = db.findAll('marriage_cases', k => (k.refNo || '').includes(`-${year}-`)).length + 1;
  const form = normForm({ b: { husband: { name: hName, phone: s(req.body.husbandPhone, 30) }, wife: { name: wName, phone: s(req.body.wifePhone, 30) } } });
  const rec = db.insert('marriage_cases', {
    refNo: `CFL-M-${year}-${String(seq).padStart(3, '0')}`,
    stage: 'draft', form,
    signedScan: null,
    createdBy: actor(req).userName,
  });
  logActivity({ ...actor(req), action: 'Opened intended-marriage case', entityType: 'marriage_case', entityId: rec.id, entityLabel: `${rec.refNo} — ${coupleLabel(rec)}` });
  res.json(rec);
});

router.put('/cases/:id/form', ...manage, (req, res) => {
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  if (rec.stage === 'signed' && req.user.role !== 'admin') {
    return res.status(423).json({ error: 'The signed copy has been filed — the interview form is locked. Ask an admin.' });
  }
  const form = normForm(req.body.form);
  // Section A attendance is ticked from the CFL roster — resolve those members
  // into the committee list (name + their position as the role) so nothing is
  // typed by hand, and the printed form still shows who attended.
  const presentIds = form.attendance.presentMemberIds;
  if (presentIds.length) {
    const roster = db.findAll('members', m => presentIds.includes(Number(m.id)));
    form.a.committee = roster.slice(0, 10).map(m => ({ name: m.name, role: m.position || 'Member' }));
  }
  // Authentication block: the Coordinator and the Secretary (or Assistant
  // Secretary) who were PRESENT sign the form — their names and the meeting
  // date flow straight into Section H.
  const present = form.a.committee;
  const coordinator = present.find(m => /coordinator|chairperson/i.test(m.role || ''));
  const secretary = present.find(m => /^secretary$/i.test(m.role || ''))
    || present.find(m => /secretary/i.test(m.role || ''));   // falls back to Assistant Secretary
  if (coordinator) form.h.coordinatorName = coordinator.name;
  if (secretary) form.h.secretaryName = secretary.name;
  form.h.signDate = form.a.date || form.h.signDate || '';
  const updated = db.update('marriage_cases', rec.id, { form, updatedAt: new Date().toISOString() });
  logActivity({ ...actor(req), action: 'Updated intended-marriage interview form', entityType: 'marriage_case', entityId: rec.id, entityLabel: `${rec.refNo} — ${coupleLabel(updated)}` });
  res.json(updated);
});

// Mark the form as printed & taken to Session (also the point of no big edits)
router.post('/cases/:id/send-to-session', ...manage, (req, res) => {
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  if (rec.stage === 'signed') return res.status(400).json({ error: 'Already signed and filed.' });
  const g = (rec.form || {}).g || {};
  if (!g.recommendation) return res.status(400).json({ error: 'Complete Section G (recommendation to Session) first.' });
  if (g.recommendation === 'concerns' && !g.details) return res.status(400).json({ error: 'Section G: describe the concerns for Session.' });
  const updated = db.update('marriage_cases', rec.id, { stage: 'with-session', sentToSessionAt: new Date().toISOString(), sentToSessionBy: actor(req).userName });
  logActivity({ ...actor(req), action: 'Marriage interview sent to Session', entityType: 'marriage_case', entityId: rec.id, entityLabel: `${rec.refNo} — ${coupleLabel(rec)}` });
  res.json(updated);
});

// ---- Filled-form PDF (mirrors PCG-AOTC-CFL-FR01) ----
router.get('/cases/:id/form.pdf', requireAuth, async (req, res) => {
  if (!guard(req, res)) return;
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  const buf = await buildMarriageFormPdf(rec);
  logActivity({ ...actor(req), action: 'Generated marriage interview form PDF', entityType: 'marriage_case', entityId: rec.id, entityLabel: rec.refNo });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${rec.refNo}_Interview_Form.pdf"`);
  res.send(buf);
});

// ---- Blank pre-marital counselling questionnaire (FR02) — one per person,
// completed privately on paper; the counsellor compares the two copies.
router.get('/cases/:id/questionnaire.pdf', requireAuth, async (req, res) => {
  if (!guard(req, res)) return;
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  const who = req.query.who === 'wife' ? 'wife' : 'husband';
  const buf = await buildQuestionnairePdf(rec, who);
  logActivity({ ...actor(req), action: `Printed counselling questionnaire (${who})`, entityType: 'marriage_case', entityId: rec.id, entityLabel: rec.refNo });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${rec.refNo}_Questionnaire_${who}.pdf"`);
  res.send(buf);
});

// ---- Signed-scan upload: phone photos (merged into one PDF) or a ready PDF.
const scanUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 16 },
  fileFilter: (req, file, cb) => {
    if (['image/jpeg', 'image/png', 'application/pdf'].includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only JPEG/PNG photos or a PDF are accepted.'));
  },
});
router.post('/cases/:id/signed', ...manage, (req, res) => {
  scanUpload.array('pages', 16)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const rec = db.findById('marriage_cases', Number(req.params.id));
    if (!rec) return res.status(404).json({ error: 'Case not found.' });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'Attach the scanned pages (photos) or a PDF.' });
    try {
      let buf, pages;
      const pdfs = files.filter(f => f.mimetype === 'application/pdf');
      if (pdfs.length) {
        if (files.length > 1) return res.status(400).json({ error: 'Upload EITHER one PDF OR page photos — not a mix.' });
        if (pdfs[0].buffer.slice(0, 5).toString() !== '%PDF-') return res.status(400).json({ error: 'That file is not a real PDF.' });
        buf = pdfs[0].buffer; pages = null;
      } else {
        buf = await buildSignedScanPdf(files.map(f => f.buffer)); // photos → one PDF
        pages = files.length;
      }
      const filename = `signed-${rec.id}-${Date.now()}.pdf`;
      fs.writeFileSync(path.join(FILES_DIR, filename), buf);
      const who = actor(req);
      const updated = db.update('marriage_cases', rec.id, {
        stage: 'signed',
        signedScan: { filename, pages, size: buf.length, uploadedBy: who.userName, uploadedAt: new Date().toISOString() },
      });
      // Unlocks Phase 2 — tell the CFL team (inbox + push).
      const cflIds = activeUsers(u => (u.permissions || []).includes('counselling.manage')).map(u => u.id);
      push.sendPushToUsers(cflIds, {
        title: 'Signed marriage form filed',
        body: `${rec.refNo} (${coupleLabel(rec)}): signed interview form uploaded by ${who.userName}. Counselling phase is now unlocked.`,
        url: '/marriage.html',
      }).catch(() => {});
      logActivity({ ...who, action: 'Uploaded SIGNED marriage interview form', entityType: 'marriage_case', entityId: rec.id, entityLabel: `${rec.refNo}${pages ? ` (${pages} page photos)` : ' (PDF)'}` });
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: 'Could not process the scan: ' + e.message });
    }
  });
});

// ---- Parents' consent form (per side) — phone photos or a PDF ----
// Stored alongside the case; does not change the stage.
router.post('/cases/:id/consent/:side', ...manage, (req, res) => {
  scanUpload.array('pages', 16)(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    const side = req.params.side === 'wife' ? 'wife' : 'husband';
    const rec = db.findById('marriage_cases', Number(req.params.id));
    if (!rec) return res.status(404).json({ error: 'Case not found.' });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: 'Attach the consent form (photos or a PDF).' });
    try {
      let buf, pages;
      const pdfs = files.filter(f => f.mimetype === 'application/pdf');
      if (pdfs.length) {
        if (files.length > 1) return res.status(400).json({ error: 'Upload EITHER one PDF OR page photos — not a mix.' });
        if (pdfs[0].buffer.slice(0, 5).toString() !== '%PDF-') return res.status(400).json({ error: 'That file is not a real PDF.' });
        buf = pdfs[0].buffer; pages = null;
      } else {
        buf = await buildSignedScanPdf(files.map(f => f.buffer));
        pages = files.length;
      }
      const filename = `consent-${side}-${rec.id}-${Date.now()}.pdf`;
      fs.writeFileSync(path.join(FILES_DIR, filename), buf);
      const who = actor(req);
      const consents = { ...(rec.consents || {}) };
      consents[side] = { filename, pages, size: buf.length, uploadedBy: who.userName, uploadedAt: new Date().toISOString() };
      const updated = db.update('marriage_cases', rec.id, { consents });
      logActivity({ ...who, action: `Uploaded parents' consent form (${side})`, entityType: 'marriage_case', entityId: rec.id, entityLabel: rec.refNo });
      res.json(updated);
    } catch (e) {
      res.status(500).json({ error: 'Could not process the upload: ' + e.message });
    }
  });
});

router.get('/cases/:id/consent/:side.pdf', requireAuth, (req, res) => {
  const side = req.params.side === 'wife' ? 'wife' : 'husband';
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec || !rec.consents || !rec.consents[side]) return res.status(404).json({ error: 'No consent form on file.' });
  const fp = path.join(FILES_DIR, path.basename(rec.consents[side].filename));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File missing.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${rec.refNo}-consent-${side}.pdf"`);
  fs.createReadStream(fp).pipe(res);
});

router.get('/cases/:id/signed.pdf', requireAuth, (req, res) => {
  if (!guard(req, res)) return;
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec || !rec.signedScan) return res.status(404).json({ error: 'No signed copy on file.' });
  const fp = path.join(FILES_DIR, path.basename(rec.signedScan.filename));
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Stored file is missing on the server.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${rec.refNo}_Signed.pdf"`);
  fs.createReadStream(fp).pipe(res);
});

// ==================== PHASE 2 ====================
// signed → (Session approval + counsellor) → counselling → (meetings, dates,
// counsellor clears) → cleared → (Session final approval) → approved, with
// banns auto-scheduled on the 3 Sundays before the marriage date.

// Session-side actions may be recorded by CFL or the Session Clerk.
function canSessionActions(req) {
  if (['admin', 'localadmin'].includes(req.user.role)) return true;
  const u = db.findById('users', req.user.id) || {};
  return (u.permissions || []).includes('counselling.manage') || (u.permissions || []).includes('approvals.manage');
}
function notifyCfl(title, body) {
  const ids = activeUsers(u => (u.permissions || []).includes('counselling.manage')).map(u => u.id);
  push.sendPushToUsers(ids, { title, body, url: '/marriage.html' }).catch(() => {});
}

// The three banns Sundays: the Sunday immediately before the marriage date
// and the two Sundays before that (banns no. 3 is the final call).
function bannsSundays(marriageDate) {
  const d = toLocalDate(marriageDate);
  if (isNaN(d)) return null;
  const back = d.getDay() === 0 ? 7 : d.getDay(); // last Sunday STRICTLY before
  const last = new Date(d); last.setDate(d.getDate() - back);
  return [14, 7, 0].map((off, i) => {
    const s = new Date(last); s.setDate(last.getDate() - off);
    return { no: i + 1, date: s.toISOString().slice(0, 10), published: false, publishedAt: null, publishedBy: null };
  });
}

// ---- Session approval (Section I) + counsellor assignment ----
router.post('/cases/:id/session-approval', requireAuth, (req, res) => {
  if (!canSessionActions(req)) return res.status(403).json({ error: 'Only CFL, the Session Clerk or an admin can record Session approval.' });
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  if (rec.stage !== 'signed') return res.status(400).json({ error: 'Record Session approval once the signed interview form is on file.' });
  const date = s(req.body.date, 10);
  const minuteRef = s(req.body.minuteRef, 60);
  if (!date || !minuteRef) return res.status(400).json({ error: 'Session approval date and minute/ref number are required.' });
  const counsellor = db.findById('counsellors', Number(req.body.counsellorId));
  if (!counsellor) return res.status(400).json({ error: 'Assign a counsellor from the counsellors list.' });
  const who = actor(req);
  const updated = db.update('marriage_cases', rec.id, {
    stage: 'counselling',
    sessionApproval: {
      date, minuteRef,
      counsellingStartDate: s(req.body.counsellingStartDate, 10),
      coupleInformedDate: s(req.body.coupleInformedDate, 10),
      counsellorId: counsellor.id, counsellorName: counsellor.name,
      recordedBy: who.userName, recordedAt: new Date().toISOString(),
    },
    counselling: { meetings: [], summary: '', durationNote: '' },
  });
  // Tell the counsellor (never with case details over SMS) + the CFL team.
  const { sendSms } = require('../utils/sms');
  if (counsellor.phone) sendSms({ to: counsellor.phone, message: 'PCG-AOTC: You have been assigned a marriage counselling case. Kindly contact the CFL secretary for details. God bless you.' }).catch(() => {});
  notifyCfl('Marriage case approved by Session',
    `${rec.refNo} (${coupleLabel(rec)}): approved ${date}, minute ${minuteRef}. Counsellor: ${counsellor.name}. Counselling phase open.`);
  logActivity({ ...who, action: 'Recorded Session approval (marriage)', entityType: 'marriage_case', entityId: rec.id, entityLabel: `${rec.refNo} — minute ${minuteRef}` });
  res.json(updated);
});

// ---- Counselling log ----
router.post('/cases/:id/meetings', ...manage, (req, res) => {
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  if (rec.stage !== 'counselling') return res.status(400).json({ error: 'Meetings are recorded during the counselling phase.' });
  const date = s(req.body.date, 10) || new Date().toISOString().slice(0, 10);
  const note = s(req.body.note, 500);
  const counselling = rec.counselling || { meetings: [] };
  counselling.meetings = counselling.meetings || [];
  counselling.meetings.push({ date, note, by: actor(req).userName });
  const updated = db.update('marriage_cases', rec.id, { counselling });
  logActivity({ ...actor(req), action: 'Logged marriage counselling meeting', entityType: 'marriage_case', entityId: rec.id, entityLabel: `${rec.refNo} — ${date}` });
  res.json(updated);
});

router.put('/cases/:id/counselling', ...manage, (req, res) => {
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  if (!['counselling', 'cleared'].includes(rec.stage)) return res.status(400).json({ error: 'Not in the counselling phase.' });
  const counselling = rec.counselling || { meetings: [] };
  counselling.summary = s(req.body.summary, 2000);
  counselling.durationNote = s(req.body.durationNote, 200);
  res.json(db.update('marriage_cases', rec.id, { counselling }));
});

// ---- Proposed marriage dates (required before clearance) ----
router.put('/cases/:id/dates', ...manage, (req, res) => {
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  if (!['counselling', 'cleared'].includes(rec.stage)) return res.status(400).json({ error: 'Dates are set during counselling, before clearance.' });
  const marriageDate = s(req.body.marriageDate, 10);
  const customaryDate = s(req.body.customaryDate, 10);
  if (marriageDate && isNaN(toLocalDate(marriageDate))) return res.status(400).json({ error: 'Invalid marriage date.' });
  if (customaryDate && isNaN(toLocalDate(customaryDate))) return res.status(400).json({ error: 'Invalid customary marriage date.' });
  // Times in the minutes' style ("10:00 am"); places as typed.
  const { clock } = require('../public/js/visitors-text.js');
  const marriageTime = clock(s(req.body.marriageTime, 20)), customaryTime = clock(s(req.body.customaryTime, 20));
  const marriageVenue = s(req.body.marriageVenue, 160), customaryVenue = s(req.body.customaryVenue, 160);
  // The thanksgiving service after the wedding is optional.
  const thanksgivingDate = s(req.body.thanksgivingDate, 10);
  if (thanksgivingDate && isNaN(toLocalDate(thanksgivingDate))) return res.status(400).json({ error: 'Invalid thanksgiving service date.' });
  const thanksgivingTime = clock(s(req.body.thanksgivingTime, 20)), thanksgivingVenue = s(req.body.thanksgivingVenue, 160);
  const updated = db.update('marriage_cases', rec.id, { dates: { ...(rec.dates || {}), marriageDate, customaryDate, marriageTime, customaryTime, marriageVenue, customaryVenue, thanksgivingDate, thanksgivingTime, thanksgivingVenue } });
  logActivity({ ...actor(req), action: 'Set proposed marriage dates', entityType: 'marriage_case', entityId: rec.id, entityLabel: `${rec.refNo} — ${marriageDate || '?'} / customary ${customaryDate || '?'}` });
  res.json(updated);
});

// ---- Counsellor clears the couple ----
router.post('/cases/:id/clear', ...manage, (req, res) => {
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  if (rec.stage !== 'counselling') return res.status(400).json({ error: 'Only a case in counselling can be cleared.' });
  const d = rec.dates || {};
  if (!d.marriageDate || !d.customaryDate) {
    return res.status(400).json({ error: 'Capture the proposed marriage date AND the proposed customary marriage date before clearing the couple.' });
  }
  if (req.body.summary !== undefined) {
    const counselling = rec.counselling || { meetings: [] };
    counselling.summary = s(req.body.summary, 2000) || counselling.summary;
    db.update('marriage_cases', rec.id, { counselling });
  }
  const who = actor(req);
  const updated = db.update('marriage_cases', rec.id, {
    stage: 'cleared', clearedAt: new Date().toISOString(), clearedBy: who.userName,
  });
  notifyCfl('Couple cleared by counsellor',
    `${rec.refNo} (${coupleLabel(rec)}): cleared. Proposed marriage ${d.marriageDate}, customary ${d.customaryDate}. Awaiting Session's final approval.`);
  logActivity({ ...who, action: 'Counsellor CLEARED couple', entityType: 'marriage_case', entityId: rec.id, entityLabel: rec.refNo });
  res.json(updated);
});

// ---- Session final approval → banns scheduled ----
router.post('/cases/:id/final-approval', requireAuth, (req, res) => {
  if (!canSessionActions(req)) return res.status(403).json({ error: 'Only CFL, the Session Clerk or an admin can record the final approval.' });
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  if (rec.stage !== 'cleared') return res.status(400).json({ error: 'Final approval comes after the counsellor clears the couple.' });
  const date = s(req.body.date, 10);
  const minuteRef = s(req.body.minuteRef, 60);
  if (!date || !minuteRef) return res.status(400).json({ error: 'Final approval date and minute/ref number are required.' });
  const banns = bannsSundays((rec.dates || {}).marriageDate);
  if (!banns) return res.status(400).json({ error: 'The proposed marriage date is missing or invalid.' });
  const who = actor(req);
  const updated = db.update('marriage_cases', rec.id, {
    stage: 'approved',
    finalApproval: { date, minuteRef, recordedBy: who.userName, recordedAt: new Date().toISOString() },
    banns,
  });
  const clerkIds = activeUsers(u => (u.permissions || []).includes('approvals.manage')).map(u => u.id);
  push.sendPushToUsers(clerkIds, {
    title: 'Banns of marriage scheduled',
    body: `${coupleLabel(rec)} (${rec.refNo}): marriage ${(rec.dates || {}).marriageDate}. Banns to be published ${banns.map(b => toLocalDate(b.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })).join(', ')}. Reminders will follow before each Sunday.`,
    url: '/marriage.html',
  }).catch(() => {});
  notifyCfl('Session FINAL approval recorded', `${rec.refNo} (${coupleLabel(rec)}): approved ${date}, minute ${minuteRef}. Banns scheduled.`);
  logActivity({ ...who, action: 'Session FINAL approval — banns scheduled', entityType: 'marriage_case', entityId: rec.id, entityLabel: `${rec.refNo} — ${banns.map(b => b.date).join(', ')}` });
  res.json(updated);
});

// ---- Mark a bann as published ----
router.post('/cases/:id/banns/:no/published', requireAuth, (req, res) => {
  if (!canSessionActions(req)) return res.status(403).json({ error: 'Only CFL, the Session Clerk or an admin can mark banns as published.' });
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec || !Array.isArray(rec.banns)) return res.status(404).json({ error: 'No banns scheduled on this case.' });
  const no = Number(req.params.no);
  const banns = rec.banns.map(b => b.no === no
    ? { ...b, published: true, publishedAt: new Date().toISOString(), publishedBy: actor(req).userName }
    : b);
  if (!banns.some(b => b.no === no)) return res.status(404).json({ error: 'Bann not found.' });
  const updated = db.update('marriage_cases', rec.id, { banns });
  logActivity({ ...actor(req), action: `Bann ${no} of 3 published`, entityType: 'marriage_case', entityId: rec.id, entityLabel: rec.refNo });
  res.json(updated);
});

// ==================== PHASE 3 ====================
// After the three banns, the marriage is solemnised and entered in the
// congregation's marriage register.

router.post('/cases/:id/solemnised', requireAuth, (req, res) => {
  if (!canSessionActions(req)) return res.status(403).json({ error: 'Only CFL, the Session Clerk or an admin can record a solemnisation.' });
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  if (rec.stage !== 'approved') return res.status(400).json({ error: 'Solemnisation is recorded on a finally-approved case.' });
  const unpublished = (rec.banns || []).filter(b => !b.published);
  if (unpublished.length && req.user.role !== 'admin') {
    return res.status(400).json({ error: `Banns ${unpublished.map(b => b.no).join(' & ')} of 3 are not marked as published. Confirm them first (or ask an admin to override).` });
  }
  const date = s(req.body.date, 10);
  const officiant = s(req.body.officiant, 120);
  if (!date || !officiant) return res.status(400).json({ error: 'Marriage date and officiating minister are required.' });
  const who = actor(req);
  const updated = db.update('marriage_cases', rec.id, {
    stage: 'married',
    solemnised: {
      date, officiant,
      venue: s(req.body.venue, 160),
      certificateNo: s(req.body.certificateNo, 60),
      customaryDone: !!req.body.customaryDone,
      recordedBy: who.userName, recordedAt: new Date().toISOString(),
    },
  });
  notifyCfl('Marriage solemnised 🎉',
    `${rec.refNo} (${coupleLabel(rec)}): solemnised ${date} by ${officiant}. Entered in the marriage register.`);
  logActivity({ ...who, action: 'Marriage SOLEMNISED — entered in register', entityType: 'marriage_case', entityId: rec.id, entityLabel: `${rec.refNo} — ${date}` });
  res.json(updated);
});

// ---- Marriage register (year) ----
function registerRows(year) {
  return db.findAll('marriage_cases', k => k.stage === 'married' && ((k.solemnised || {}).date || '').startsWith(String(year)))
    .sort((a, b) => (a.solemnised.date || '').localeCompare(b.solemnised.date || ''))
    .map((k, i) => {
      const b = (k.form || {}).b || {};
      return {
        no: i + 1, refNo: k.refNo,
        date: k.solemnised.date,
        husband: ((b.husband || {}).name) || '',
        wife: ((b.wife || {}).name) || '',
        officiant: k.solemnised.officiant || '',
        venue: k.solemnised.venue || '',
        certificateNo: k.solemnised.certificateNo || '',
        customaryDate: ((k.dates || {}).customaryDate) || '',
        counsellor: ((k.sessionApproval || {}).counsellorName) || '',
      };
    });
}
router.get('/register', requireAuth, (req, res) => {
  if (!guard(req, res)) return;
  const year = Number(req.query.year) || new Date().getFullYear();
  res.json({ year, rows: registerRows(year) });
});

router.get('/register.pdf', requireAuth, async (req, res) => {
  if (!guard(req, res)) return;
  const year = Number(req.query.year) || new Date().getFullYear();
  const { buildMarriageRegisterPdf } = require('../utils/marriagePdf');
  const buf = await buildMarriageRegisterPdf(year, registerRows(year));
  logActivity({ ...actor(req), action: 'Generated marriage register PDF', entityType: 'marriage_case', entityId: year, entityLabel: String(year) });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Marriage_Register_${year}.pdf"`);
  res.send(buf);
});

router.delete('/cases/:id', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can delete a marriage case.' });
  const rec = db.findById('marriage_cases', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Case not found.' });
  if (rec.signedScan && rec.signedScan.filename) {
    try { fs.unlinkSync(path.join(FILES_DIR, path.basename(rec.signedScan.filename))); } catch (e) {}
  }
  db.remove('marriage_cases', rec.id);
  logActivity({ ...actor(req), action: 'DELETED marriage case', entityType: 'marriage_case', entityId: rec.id, entityLabel: rec.refNo, snapshot: rec });
  res.json({ ok: true });
});

module.exports = router;
