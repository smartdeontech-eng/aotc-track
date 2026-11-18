// AOTC Track — the Home page's "Needs you" and "This week" (Oct 2026 redesign).
//
// One call that gathers, for the person signed in, the things that are waiting
// on THEM and what is coming up in the next fortnight. Every part is checked
// against the same rule the page it links to uses (the Session parts come from
// routes/minutes.js itself), so Home never shows an item the person could not
// open. Committee meetings, report status, approvals and action points are
// still read by the page from their own endpoints, which already scope them.
'use strict';

const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { requireAuth } = require('../middleware/auth');
const { toDayKey, fmtDay } = require('../utils/dates');
// "Sat 24 Oct, 9:00 am" for a moment in time.
const fmtWhen = iso => { const d = new Date(iso); if (isNaN(d)) return ''; return `${fmtDay(toDayKey(d)).replace(',', '')}, ${d.toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }).replace(' ', '\u00a0')}`; };
const SM = require('../utils/sessionMinutes');
const E = require('../utils/elections');

const HORIZON_DAYS = 14;
const dayKeyPlus = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return toDayKey(d); };
const daysUntil = (key) => {
  const a = new Date(`${key}T12:00:00`), b = new Date(); b.setHours(12, 0, 0, 0);
  return Math.round((a - b) / 86400000);
};
const perms = req => (db.findById('users', req.user.id) || {}).permissions || [];
const isAdmin = req => ['admin', 'localadmin'].includes(req.user.role);
const unsettled = c => !String(c.action || '').trim() || /^for decision$/i.test(String(c.action || '').trim());

function sessionPart(req, needs, week) {
  const M = require('./minutes')._home;
  if (!M) return;
  const view = M.canView(req), edit = M.canEdit(req), intake = M.canIntake(req);
  const today = dayKeyPlus(0), horizon = dayKeyPlus(HORIZON_DAYS);
  const docs = db.findAll('minutes_docs', d => d.kind === 'session' || !d.kind);

  if (view) {
    // The next sitting(s) of the Session.
    docs.filter(d => !d.locked && d.date >= today && d.date <= horizon).sort((a, b) => a.date.localeCompare(b.date)).forEach(d => {
      const n = daysUntil(d.date);
      week.push({
        kind: 'session', date: d.date, time: d.startTime || '', title: SM.meetingTitleOf(d) || 'Session meeting',
        meta: [d.venue, `${M.membersFor(d).filter(m => m.active !== false).length} members`].filter(Boolean).join(' · '),
        href: `/minutes.html?meeting=${d.id}`, meetingId: d.meetingId || null,
      });
      if (edit && !d.noticeSentAt && n <= 10) {
        needs.push({
          rank: n <= 3 ? 1 : 3, tone: n <= 3 ? 'red' : 'amber', icon: 'calendar',
          title: `${SM.meetingTitleOf(d) || 'Session meeting'} — notice not yet sent`,
          meta: [`${n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`}`, d.venue].filter(Boolean).join(' · '),
          due: n <= 3 ? 'members not yet told' : '',
          date: d.date, time: d.startTime || '',
          href: '/session-meetings.html', cta: 'Send notice',
        });
      }
    });

    // Sundays coming up: who is on duty.
    for (let i = 0; i <= 7; i += 1) {
      const key = dayKeyPlus(i);
      if (new Date(`${key}T12:00:00`).getDay() !== 0) continue;
      let names = [];
      try { names = M.onDutyFor(key) || []; } catch (e) { names = []; }
      week.push({ kind: 'sunday', date: key, time: '', title: 'Sunday services', meta: names.length ? `Presbyters on duty: ${SM.podLabel(names)}` : '', href: '/attendance.html' });
    }
  }

  if (edit) {
    // Minutes of sittings already held and not yet adopted: open proofreading
    // and letters with no Action. One line per set of minutes.
    docs.filter(d => !d.locked && d.date < today).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3).forEach(d => {
      const recs = db.findAll('minutes_proofreads', r => Number(r.docId) === Number(d.id)).sort((a, b) => String(b.uploadedAt).localeCompare(String(a.uploadedAt)));
      const pr = recs[0];
      const prLeft = pr ? (pr.changes || []).filter(c => c.status === 'pending').length + (pr.comments || []).filter(c => c.status === 'pending').length : 0;
      const corrSec = (d.sections || []).find(s => s.key === 'correspondence');
      const noAction = corrSec && corrSec.enabled === false ? 0 : db.findAll('correspondence', c => Number(c.minutesId) === Number(d.id) && unsettled(c)).length;
      if (!prLeft && !noAction) return;
      const parts = [];
      if (prLeft) parts.push(`${prLeft} proofreading item${prLeft === 1 ? '' : 's'} waiting${pr.proofreader ? ` (from ${pr.proofreader})` : ''}`);
      if (noAction) parts.push(`${noAction} letter${noAction === 1 ? '' : 's'} with no Action`);
      needs.push({
        rank: 4, tone: '', icon: 'doc',
        title: `Minutes of ${fmtDay(d.date, { day: 'numeric', month: 'short' })}: ${prLeft ? 'proofreading to finish' : 'letters need an Action'}`,
        meta: parts.join(' · '), date: d.date, href: `/minutes.html?meeting=${d.id}`, cta: prLeft ? 'Review' : 'Fill in',
      });
    });
  }

  if (intake) {
    const letters = db.findAll('correspondence', c => !c.minutesId);
    const fresh = letters.filter(c => M.letterStatus(c) === 'new');
    const nextMeeting = docs.map(d => d.date).filter(x => x >= today).sort()[0] || '';
    const soon = letters.filter(c => M.letterStatus(c) !== 'handled' && c.eventDate && c.eventDate >= today && (!nextMeeting || c.eventDate < nextMeeting));
    if (fresh.length && edit) {
      const oldest = fresh.map(c => c.receivedOn || String(c.createdAt || '').slice(0, 10)).filter(Boolean).sort()[0];
      needs.push({
        rank: soon.length ? 2 : 5, tone: 'amber', icon: 'mail',
        title: `${fresh.length} letter${fresh.length === 1 ? '' : 's'} to sort in the Correspondence Inbox`,
        meta: [oldest ? `Oldest received ${fmtDay(oldest).replace(',', '')}` : '', soon.length ? `${soon.length} ask${soon.length === 1 ? 's' : ''} for something before the next meeting` : ''].filter(Boolean).join(' · '),
        oldest, href: '/correspondence.html', cta: 'Sort letters',
      });
    }
    soon.slice(0, 3).forEach(c => week.push({ kind: 'letter', date: c.eventDate, time: '', title: c.heading || 'Letter', meta: `From the inbox${c.from ? ` · ${c.from}` : ''}`, href: '/correspondence.html' }));
  }
}

function electionPart(req, needs, week) {
  const manage = isAdmin(req) || perms(req).includes('elections.manage');
  const confirm = isAdmin(req) || perms(req).includes('approvals.manage');
  const u = db.findById('users', req.user.id) || {};
  const horizon = Date.now() + HORIZON_DAYS * 86400000;
  db.findAll(E.C.elections).forEach(e => {
    const officer = E.isOfficer(e, u);
    if (!manage && !confirm && !officer) return;
    if (confirm && e.status === 'pending') {
      needs.push({ rank: 2, tone: 'red', icon: 'ballot', title: `${e.title} — waiting for your confirmation`, meta: [e.entityName, e.openAt ? `polls ${new Date(e.openAt) > new Date() ? 'open' : 'were to open'} ${fmtWhen(e.openAt)}` : ''].filter(Boolean).join(' · '), href: `/elections.html?id=${e.id}`, cta: 'Confirm' });
    }
    if (confirm && e.status === 'closed') {
      needs.push({ rank: 3, tone: 'amber', icon: 'ballot', title: `${e.title} — results to certify`, meta: e.entityName || '', href: `/elections.html?id=${e.id}`, cta: 'Certify' });
    }
    if (E.isOpenNow(e) && (officer || manage)) {
      needs.push({ rank: 1, tone: 'green', icon: 'ballot', title: `${e.title} — polls are open`, meta: e.closeAt ? `Polls close ${fmtWhen(e.closeAt)}` : '', href: officer ? `/poll-desk.html?e=${e.id}` : `/elections.html?id=${e.id}`, cta: officer ? 'Polling Desk' : 'Watch' });
    }
    if (['confirmed', 'open'].includes(e.status) && e.openAt && new Date(e.openAt).getTime() <= horizon && new Date(e.openAt).getTime() >= Date.now() - 86400000) {
      week.push({ kind: 'election', at: e.openAt, date: toDayKey(new Date(e.openAt)), title: `${e.title} — polls open`, meta: e.entityName || '', href: officer ? `/poll-desk.html?e=${e.id}` : `/elections.html?id=${e.id}` });
    }
  });
}

router.get('/', requireAuth, (req, res) => {
  const needs = [], week = [];
  try { sessionPart(req, needs, week); } catch (e) { console.error('[home] session:', e.message); }
  try { electionPart(req, needs, week); } catch (e) { console.error('[home] elections:', e.message); }
  needs.sort((a, b) => a.rank - b.rank);
  week.sort((a, b) => String(a.date + (a.time || a.at || '')).localeCompare(String(b.date + (b.time || b.at || ''))));
  res.json({ today: dayKeyPlus(0), needs, week });
});

module.exports = router;
