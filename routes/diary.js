// AOTC Track — the Church Diary (Nov 2026).
//
// One calendar of everything happening in the congregation. Two kinds of item:
//
//   ON BY THEMSELVES — things already scheduled elsewhere in the app, read at
//   the moment the diary is opened (nothing is copied, so nothing goes stale):
//   Session meetings, committee and group meetings, and marriages the Session
//   has finally approved (traditional marriage, church wedding, thanksgiving).
//
//   ENTERED — kept in `diary_entries`: church programmes, funerals, the
//   preaching plan (read from the uploaded Word/PDF and confirmed), anything
//   else typed in.
//
// And SUGGESTIONS: dates the app has only spotted — a letter in the
// Correspondence inbox or in a set of minutes that names a date (a funeral, a
// wedding, a programme), or visitors announcing a funeral or a marriage under
// Presentation. They are offered as "Put this on the diary?" to the people who
// keep the diary. Accepting makes an entry; declining is remembered
// (`diary_decisions`), so the same thing is never offered twice.
//
// WHO SEES IT: everyone who can sign in.
// WHO KEEPS IT: the admin tier, the Session Clerk (approvals.manage), the
// Church Administrator (correspondence.intake), or anyone given diary.manage.
'use strict';

const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { actor } = require('../utils/scope');
const { toDayKey } = require('../utils/dates');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// The kinds of thing on the diary. Each has its own colour on the page AND its
// own word, so nothing depends on telling colours apart.
const KINDS = {
  session: 'Session meeting',
  meeting: 'Meeting',
  programme: 'Church programme',
  preaching: 'Preaching plan',
  funeral: 'Funeral',
  wedding: 'Church wedding',
  traditional: 'Traditional marriage',
  thanksgiving: 'Thanksgiving service',
  other: 'Other',
};
const ENTERABLE = ['programme', 'preaching', 'funeral', 'wedding', 'traditional', 'thanksgiving', 'other'];

const clean = (v, max = 300) => String(v == null ? '' : v).trim().slice(0, max);
const day = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
const userOf = req => db.findById('users', req.user.id) || {};
function canManage(req) {
  if (['admin', 'localadmin'].includes(req.user.role)) return true;
  const p = userOf(req).permissions || [];
  return ['diary.manage', 'approvals.manage', 'correspondence.intake'].some(k => p.includes(k));
}
function canViewSession(req) {
  if (['admin', 'localadmin', 'minister'].includes(req.user.role)) return true;
  const p = userOf(req).permissions || [];
  return ['approvals.manage', 'session.manage', 'congregation.view'].some(k => p.includes(k));
}
const todayKey = () => toDayKey(new Date());
const plus = (key, n) => { const d = new Date(`${key}T12:00:00`); d.setDate(d.getDate() + n); return toDayKey(d); };

let clockFn = null;
const clock = v => { try { clockFn = clockFn || require('../public/js/visitors-text.js').clock; return clockFn(v); } catch (e) { return clean(v, 20); } };

// ---- Items that come from elsewhere in the app --------------------------------
function autoItems(req, from, to) {
  const out = [];
  const inRange = d => d && d >= from && d <= to;
  // Session meetings: the date for everyone; the link only for those who can open them.
  const sessionLink = canViewSession(req);
  let SM = null; try { SM = require('../utils/sessionMinutes'); } catch (e) {}
  db.findAll('minutes_docs', d => (d.kind === 'session' || !d.kind) && inRange(d.date)).forEach(d => {
    out.push({ key: `session:${d.id}`, kind: 'session', date: d.date, time: d.startTime ? clock(clean(d.startTime, 20)) : '', venue: clean(d.venue, 160),
      title: (SM && SM.meetingTitleOf && SM.meetingTitleOf(d)) || 'Session meeting', source: 'session',
      href: sessionLink ? `/minutes.html?meeting=${d.id}` : '' });
  });
  // Committee, group and congregation meetings that are not cancelled.
  db.findAll('meetings', m => m.status !== 'cancelled' && inRange(m.date)).forEach(m => {
    out.push({ key: `meeting:${m.id}`, kind: 'meeting', date: m.date, time: m.time ? clock(clean(m.time, 20)) : '', venue: clean(m.venueName, 160),
      title: m.entityName ? `${m.entityName} — ${m.title || 'Meeting'}` : (m.title || 'Meeting'), source: 'meeting', href: '/meetings.html' });
  });
  // Marriages the Session has finally approved (the banns are public by then).
  db.findAll('marriage_cases', k => ['approved', 'married'].includes(k.stage)).forEach(k => {
    const b = (k.form || {}).b || {}; const hn = (b.husband || {}).name, wn = (b.wife || {}).name;
    const couple = (hn || wn) ? `${hn || '?'} & ${wn || '?'}` : `case ${k.refNo}`;
    const dts = k.dates || {};
    [['traditional', 'customary', 'Traditional marriage'], ['wedding', 'marriage', 'Church wedding'], ['thanksgiving', 'thanksgiving', 'Thanksgiving service']].forEach(([kind, pre, label]) => {
      const d = dts[`${pre}Date`];
      if (!inRange(d)) return;
      out.push({ key: `marriage:${k.id}:${kind}`, kind, date: d, time: clean(dts[`${pre}Time`], 20), venue: clean(dts[`${pre}Venue`], 160),
        title: `${label} — ${couple}`, source: 'marriage', href: '' });
    });
  });
  return out;
}

// ---- Items entered on the diary ----------------------------------------------
function entryItem(e, manage) {
  const title = e.kind === 'preaching'
    ? [e.title || (e.service ? `${e.service}` : 'Sunday service'), e.preacher ? `— ${e.preacher}` : ''].filter(Boolean).join(' ')
    : e.title;
  return { key: `entry:${e.id}`, id: e.id, kind: e.kind, date: e.date, endDate: e.endDate || '', time: e.time || '', venue: e.venue || '',
    title, details: e.details || '', preacher: e.preacher || '', theme: e.theme || '', readings: e.readings || '', service: e.service || '',
    source: e.kind === 'preaching' ? 'preaching' : 'entry', foundIn: e.foundIn || null, editable: manage };
}
function enteredItems(req, from, to) {
  const manage = canManage(req);
  return db.findAll('diary_entries', e => e.date && e.date <= to && (e.endDate || e.date) >= from).map(e => entryItem(e, manage));
}

// ---- Suggestions --------------------------------------------------------------
// The kind a letter's heading or summary points to.
function guessKind(text) {
  const t = String(text || '').toLowerCase();
  if (/funeral|burial|passing|death|demise|memorial|one[- ]week|wake[- ]keeping|bereave|late\s/.test(t)) return 'funeral';
  if (/traditional marriage|customary marriage|engagement/.test(t)) return 'traditional';
  if (/wedding|marriage|nuptial/.test(t)) return 'wedding';
  if (/thanksgiving/.test(t)) return 'thanksgiving';
  return 'programme';
}
function suggestions(req) {
  const today = todayKey();
  const decided = new Set(db.findAll('diary_decisions').map(d => d.key));
  const out = [];
  // Letters that name a date still ahead: in the inbox or read at a meeting.
  db.findAll('correspondence', c => day(c.eventDate) && c.eventDate >= today).forEach(c => {
    const key = `letter:${c.id}`;
    if (decided.has(key)) return;
    const kind = guessKind(`${c.heading || ''} ${c.summary || ''}`);
    out.push({ key, kind, date: c.eventDate, time: '', venue: '', title: clean(c.heading, 160) || 'From a letter',
      details: clean(c.summary, 600),
      foundIn: { type: 'letter', label: `Letter${c.from ? ` from ${clean(c.from, 120)}` : ''}${c.minutesId ? ' (read at a Session meeting)' : ' (Correspondence Inbox)'}`,
        href: c.minutesId ? `/minutes.html?meeting=${c.minutesId}` : '/correspondence.html' } });
  });
  // Visitors who announced a funeral or a marriage to the Session.
  let V = null; try { V = require('../public/js/visitors-text.js'); } catch (e) {}
  db.findAll('minutes_docs', d => d.date && d.date >= plus(today, -120)).forEach(d => {
    ((d.proceedings || {}).visitors || []).forEach((g, gi) => {
      if (!g || !['funeral', 'marriage'].includes(g.purpose)) return;
      let evs = Array.isArray(g.events) ? g.events : [];
      if (g.purpose === 'marriage' && !evs.length && day(g.weddingDate)) evs = [{ what: 'church wedding', date: g.weddingDate }];
      evs.forEach((e, ei) => {
        if (!e || !day(e.date) || e.date < today) return;
        const key = `visit:${d.id}:${gi}:${ei}`;
        if (decided.has(key)) return;
        const what = clean(e.what, 80);
        let kind, title;
        if (g.purpose === 'funeral') {
          kind = 'funeral';
          const who = clean(g.deceased, 160).replace(/^the late\s+/i, '');
          title = `${what ? what[0].toUpperCase() + what.slice(1) : 'Funeral'}${who ? ` — the late ${who}` : ''}`;
        } else {
          kind = /traditional|customary/i.test(what) ? 'traditional' : /thanksgiving/i.test(what) ? 'thanksgiving' : 'wedding';
          title = `${KINDS[kind]} — ${clean(g.groom, 120) || '?'} & ${clean(g.bride, 120) || '?'}`;
        }
        out.push({ key, kind, date: e.date, time: e.time ? clock(e.time) : '', venue: clean(e.venue, 160), title, details: clean(e.note, 600),
          foundIn: { type: 'visitors', label: `Announced to the Session on ${V && V.longDate ? V.longDate(d.date) : d.date}${V && V.title ? ` — ${V.title(g)}` : ''}`, href: `/minutes.html?meeting=${d.id}` } });
      });
    });
  });
  // Anything already on the diary that day, of the same kind, is not offered again.
  const onDiary = [...autoItems(req, today, '9999-12-31'), ...enteredItems(req, today, '9999-12-31')];
  return out.filter(s => !onDiary.some(i => i.date === s.date && i.kind === s.kind)).sort((a, b) => a.date.localeCompare(b.date));
}

// ---- Routes ----------------------------------------------------------------------
router.get('/', requireAuth, (req, res) => {
  const from = day(req.query.from) || plus(todayKey(), -31);
  const to = day(req.query.to) || plus(todayKey(), 62);
  if (to < from) return res.status(400).json({ error: 'The end of the range is before its start.' });
  const items = [...autoItems(req, from, to), ...enteredItems(req, from, to)]
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
  const manage = canManage(req);
  res.json({ from, to, items, kinds: KINDS, canManage: manage, suggestions: manage ? suggestions(req).length : 0 });
});

router.get('/suggestions', requireAuth, (req, res) => {
  if (!canManage(req)) return res.status(403).json({ error: 'Only those who keep the Church Diary see what is waiting to go on it.' });
  res.json(suggestions(req));
});

function entryFrom(body) {
  const kind = ENTERABLE.includes(body.kind) ? body.kind : 'other';
  return {
    kind, title: clean(body.title, 200), date: day(body.date), endDate: day(body.endDate), time: body.time ? clock(clean(body.time, 20)) : '',
    venue: clean(body.venue, 200), details: clean(body.details, 2000),
    preacher: clean(body.preacher, 160), theme: clean(body.theme, 300), readings: clean(body.readings, 300), service: clean(body.service, 80),
  };
}
router.post('/', requireAuth, (req, res) => {
  if (!canManage(req)) return res.status(403).json({ error: 'Only those who keep the Church Diary can add to it.' });
  const e = entryFrom(req.body || {});
  if (!e.date) return res.status(400).json({ error: 'Give the date.' });
  if (!e.title && e.kind !== 'preaching') return res.status(400).json({ error: 'Say what it is.' });
  if (e.endDate && e.endDate < e.date) return res.status(400).json({ error: 'The last day is before the first.' });
  const fromKey = clean(req.body.fromKey, 80);
  const foundIn = req.body.foundIn && typeof req.body.foundIn === 'object'
    ? { type: clean(req.body.foundIn.type, 20), label: clean(req.body.foundIn.label, 300), href: clean(req.body.foundIn.href, 200) } : null;
  const rec = db.insert('diary_entries', { ...e, foundIn, fromKey: fromKey || '', addedBy: actor(req).userName, addedAt: new Date().toISOString() });
  if (fromKey) db.insert('diary_decisions', { key: fromKey, decision: 'added', entryId: rec.id, by: actor(req).userName, at: new Date().toISOString() });
  logActivity({ ...actor(req), action: `Added to the Church Diary: ${KINDS[e.kind]}${fromKey ? ' (from a suggestion)' : ''}`, entityType: 'diary', entityId: rec.id, entityLabel: `${e.date} ${e.title}`.slice(0, 80) });
  res.status(201).json(entryItem(rec, true));
});
router.put('/:id', requireAuth, (req, res) => {
  if (!canManage(req)) return res.status(403).json({ error: 'Only those who keep the Church Diary can change it.' });
  const rec = db.findById('diary_entries', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'That entry is not on the diary.' });
  const e = entryFrom({ ...rec, ...(req.body || {}) });
  if (!e.date) return res.status(400).json({ error: 'Give the date.' });
  if (e.endDate && e.endDate < e.date) return res.status(400).json({ error: 'The last day is before the first.' });
  const up = db.update('diary_entries', rec.id, { ...e, changedBy: actor(req).userName, changedAt: new Date().toISOString() });
  logActivity({ ...actor(req), action: 'Changed a Church Diary entry', entityType: 'diary', entityId: rec.id, entityLabel: `${e.date} ${e.title}`.slice(0, 80) });
  res.json(entryItem(up, true));
});
router.delete('/:id', requireAuth, (req, res) => {
  if (!canManage(req)) return res.status(403).json({ error: 'Only those who keep the Church Diary can take things off it.' });
  const rec = db.findById('diary_entries', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'That entry is not on the diary.' });
  db.remove('diary_entries', rec.id);
  // A suggestion it came from stays decided ("removed"), so it is not offered again.
  logActivity({ ...actor(req), action: 'Took an entry off the Church Diary', entityType: 'diary', entityId: rec.id, entityLabel: `${rec.date} ${rec.title}`.slice(0, 80) });
  res.json({ ok: true });
});
router.post('/suggestions/dismiss', requireAuth, (req, res) => {
  if (!canManage(req)) return res.status(403).json({ error: 'Only those who keep the Church Diary can do that.' });
  const key = clean(req.body && req.body.key, 80);
  if (!key) return res.status(400).json({ error: 'Which suggestion?' });
  if (!db.findOne('diary_decisions', d => d.key === key)) db.insert('diary_decisions', { key, decision: 'not for the diary', by: actor(req).userName, at: new Date().toISOString() });
  res.json({ ok: true });
});

// ---- The preaching plan ------------------------------------------------------------
// The plan is shared as a Word or PDF document. Claude reads every Sunday (and
// any other service) off it; the page shows the rows to check and correct; only
// what is confirmed goes on the diary.
async function docxText(buffer) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  const un = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const out = [];
  // Table rows as "cell | cell | cell", paragraphs as lines, in document order.
  const body = xml.replace(/<w:tr[ >][\s\S]*?<\/w:tr>/g, row => {
    const cells = (row.match(/<w:tc[ >][\s\S]*?<\/w:tc>/g) || []).map(c => (c.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map(t => un(t.replace(/<[^>]+>/g, ''))).join(' ').trim());
    return `\n§ROW§${cells.join(' | ')}\n`;
  });
  body.split(/<\/w:p>|\n/).forEach(p => {
    if (p.startsWith('§ROW§')) { out.push(p.slice(5)); return; }
    const t = (p.match(/<w:t[^>]*>[^<]*<\/w:t>/g) || []).map(x => un(x.replace(/<[^>]+>/g, ''))).join('').trim();
    if (t) out.push(t);
  });
  return out.join('\n');
}
const PREACHING_PROMPT = `You read a church preaching plan (Presbyterian Church of Ghana) and list every service on it.
Return ONLY a JSON object: {"rows":[{"date":"YYYY-MM-DD","service":"","preacher":"","theme":"","readings":"","notes":""}]}.
- One row per service. If a Sunday has more than one service with different preachers, one row each; "service" says which ("1st service", "2nd service", "Joint service", "Harvest", …). Otherwise leave "service" empty.
- "preacher": the name and title exactly as written. "theme": the sermon theme or topic. "readings": the lessons/scriptures as written. "notes": anything else on that row (liturgical colour, occasion such as Communion, Harvest, Youth Sunday).
- Dates: the plan's own year; a date written without a year takes the year of the plan. Skip rows with no date you can work out.
- Do not invent anything that is not on the plan.`;
router.post('/preaching/read', requireAuth, upload.single('file'), async (req, res) => {
  if (!canManage(req)) return res.status(403).json({ error: 'Only those who keep the Church Diary can add the preaching plan.' });
  if (!req.file) return res.status(400).json({ error: 'Choose the preaching plan (Word or PDF).' });
  const ai = require('../utils/aiAssist');
  if (!ai.isConfigured()) return res.status(503).json({ error: 'Reading the plan needs ANTHROPIC_API_KEY in the server .env file. You can still add Sundays one by one.' });
  const name = String(req.file.originalname || '').toLowerCase();
  const year = Number(req.body.year) || new Date().getFullYear();
  let content;
  try {
    if (/\.docx$/.test(name) || /wordprocessingml/.test(req.file.mimetype || '')) {
      const text = await docxText(req.file.buffer);
      if (!text.trim()) return res.status(400).json({ error: 'No text could be read from that Word file.' });
      content = [{ type: 'text', text: `The plan's year, if it does not say: ${year}.\n\nTHE PLAN (table rows are "cell | cell | cell"):\n${text.slice(0, 60000)}` }];
    } else if (/\.pdf$/.test(name) || req.file.mimetype === 'application/pdf') {
      content = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: req.file.buffer.toString('base64') } },
        { type: 'text', text: `The plan's year, if it does not say: ${year}. List every service.` }];
    } else return res.status(400).json({ error: 'Please upload the preaching plan as a Word (.docx) or PDF file.' });
  } catch (e) { return res.status(400).json({ error: 'That file could not be read.' }); }
  try {
    const out = await ai.callClaudeFull({ system: PREACHING_PROMPT, content, maxTokens: 8000 });
    if (out.stopReason === 'max_tokens') return res.status(502).json({ error: 'The plan is too long to read in one go. Upload it a quarter at a time.' });
    const m = String(out.text || '').match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : { rows: [] };
    const rows = (Array.isArray(parsed.rows) ? parsed.rows : []).map(r => ({
      date: day(r.date), service: clean(r.service, 80), preacher: clean(r.preacher, 160), theme: clean(r.theme, 300), readings: clean(r.readings, 300), notes: clean(r.notes, 300),
    })).filter(r => r.date).sort((a, b) => (a.date + a.service).localeCompare(b.date + b.service));
    const have = db.findAll('diary_entries', e => e.kind === 'preaching');
    rows.forEach(r => { r.already = have.some(e => e.date === r.date && (e.service || '') === r.service); });
    res.json({ rows, fileName: clean(req.file.originalname, 200) });
  } catch (e) { res.status(e.status || 502).json({ error: e.message || 'Could not read the plan.' }); }
});
// Put the confirmed rows on the diary. A row for a date (and service) already
// on the diary replaces that one, so uploading a corrected plan just updates it.
router.post('/preaching', requireAuth, (req, res) => {
  if (!canManage(req)) return res.status(403).json({ error: 'Only those who keep the Church Diary can add the preaching plan.' });
  const rows = (Array.isArray(req.body && req.body.rows) ? req.body.rows : []).slice(0, 400);
  let added = 0, updated = 0;
  rows.forEach(r => {
    const date = day(r.date); if (!date) return;
    const service = clean(r.service, 80);
    const data = { kind: 'preaching', title: service || 'Sunday service', date, service, preacher: clean(r.preacher, 160), theme: clean(r.theme, 300),
      readings: clean(r.readings, 300), details: clean(r.notes, 300), venue: clean(r.venue, 200), time: r.time ? clock(clean(r.time, 20)) : '' };
    const prev = db.findOne('diary_entries', e => e.kind === 'preaching' && e.date === date && (e.service || '') === service);
    if (prev) { db.update('diary_entries', prev.id, { ...data, changedBy: actor(req).userName, changedAt: new Date().toISOString() }); updated += 1; }
    else { db.insert('diary_entries', { ...data, foundIn: { type: 'preaching', label: `Preaching plan${req.body.fileName ? ` — ${clean(req.body.fileName, 160)}` : ''}`, href: '' }, addedBy: actor(req).userName, addedAt: new Date().toISOString() }); added += 1; }
  });
  logActivity({ ...actor(req), action: `Preaching plan on the Church Diary: ${added} added, ${updated} updated`, entityType: 'diary', entityId: null, entityLabel: clean(req.body && req.body.fileName, 80) });
  res.json({ added, updated });
});

module.exports = router;
module.exports._suggestions = suggestions;
module.exports.KINDS = KINDS;
