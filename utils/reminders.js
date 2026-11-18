// AOTC Track — Reminder engine (Phase 7).
// Three job families, all deduplicated through reminder_log so restarting
// the server never double-sends:
//   1. Meeting reminders     — 24h and 2h before start, to the relevant roster
//   2. Quarter-end reminders — from 30 days before quarter end until the
//      entity submits; weekly, then daily in the last 5 days (due = 5th of
//      the month after the quarter; District deadline is the 7th)
//   3. Statutory deadlines   — fixed PCG dates, reminded 14 and 3 days ahead
// Channels: SMS (mNotify) for anyone with a phone, email (SMTP) for anyone
// with an address, and device push notifications for any login user who has
// enabled them — all three degrade gracefully when unconfigured.
const db = require('./db');
const { activeUsers } = require('./accountStatus');
const { sendSms } = require('./sms');
const { sendMail } = require('./mailer');
const push = require('./push');
const { toLocalDate } = require('./dates');

const STATUTORY = [
  { key: 'form-c', label: 'Membership Form C submission to the District', month: 0, day: 7, code: 'AHRM' },
  { key: 'annual-plan', label: 'Congregational Annual Plan + Q4 report to the District', month: 0, day: 7, code: 'OG' },
  { key: 'audited-accounts', label: 'Annual audited accounts to the District Minister', month: 3, day: 30, code: 'Fin' },
];

function alreadySent(key) { return !!db.findOne('reminder_log', r => r.key === key); }
function logSent(key, type, detail, results) {
  db.insert('reminder_log', {
    key, type, detail,
    sms: results.sms, emails: results.emails, pushes: results.pushes || 0,
    sentAt: new Date().toISOString(),
  });
}

// Contacts for an entity: its login users (email + phone) and any
// office-holders on the roster who have contacts on file.
function entityContacts(entityType, entityId, executivesOnly) {
  const phones = new Set(); const emails = new Set(); const userIds = new Set();
  activeUsers(u => u.entity && u.entity.type === entityType && Number(u.entity.id) === Number(entityId))
    .forEach(u => { if (u.phone) phones.add(u.phone); if (u.email) emails.add(u.email); userIds.add(u.id); });
  db.findAll('members', m => m.entityType === entityType && Number(m.entityId) === Number(entityId))
    .filter(m => !executivesOnly || (m.position || 'Member') !== 'Member')
    .forEach(m => { if (m.phone) phones.add(m.phone); if (m.email) emails.add(m.email); });
  return { phones: [...phones], emails: [...emails], userIds: [...userIds] };
}
// The Session is its own body — its roll lives in session_members, not in the
// committee/group members table — so its meeting reminders resolve here.
// Push goes to the Session Clerk's login (approvals.manage); the members
// themselves are reached by SMS and email.
function sessionContacts() {
  const phones = new Set(); const emails = new Set();
  db.findAll('session_members', m => m.active !== false).forEach(m => {
    if (m.phone) phones.add(m.phone);
    if (m.email) emails.add(m.email);
  });
  let userIds = [];
  try { userIds = push.userIdsWithPermission('approvals.manage'); } catch (e) {}
  return { phones: [...phones], emails: [...emails], userIds };
}
function rosterContacts(entityType, entityId, executivesOnly) {
  const phones = new Set();
  db.findAll('members', m => m.entityType === entityType && Number(m.entityId) === Number(entityId))
    .filter(m => !executivesOnly || (m.position || 'Member') !== 'Member')
    .forEach(m => { if (m.phone) phones.add(m.phone); });
  return [...phones];
}

async function deliver(message, subject, { phones = [], emails = [], userIds = [] }, url = '/') {
  let sms = 0, mails = 0, pushes = 0;
  for (const to of phones.slice(0, 60)) {
    try { const r = await sendSms({ to, message }); if (r && !r.skipped && !r.error) sms++; } catch (e) {}
  }
  for (const to of emails.slice(0, 60)) {
    try { const r = await sendMail({ to, subject, html: `<p>${message}</p><p style="color:#667">— AOTC Track</p>` }); if (!r || !r.error) mails++; } catch (e) {}
  }
  try { const r = await push.sendPushToUsers(userIds, { title: subject, body: message, url }); pushes = r.sent || 0; } catch (e) {}
  return { sms, emails: mails, pushes };
}

// ---- 1. Meeting reminders ----
async function checkMeetingReminders(now = new Date()) {
  const meetings = db.findAll('meetings', m => m.status === 'scheduled');
  for (const m of meetings) {
    const start = new Date(`${m.date}T${m.time || '09:00'}:00`);
    const hoursAway = (start - now) / 36e5;
    if (hoursAway < 0) continue;
    const windows = [
      { tag: 'h24', min: 2.5, max: 24, when: 'tomorrow' },
      { tag: 'h2', min: 0, max: 2.5, when: 'today' },
    ];
    for (const w of windows) {
      if (hoursAway > w.max || hoursAway < w.min) continue;
      const key = `meeting:${m.id}:${w.tag}`;
      if (alreadySent(key)) continue;
      const where = m.mode === 'online' ? `online${m.link ? ': ' + m.link : ''}` : (m.venueName || 'venue TBA') + (m.link ? ` / online: ${m.link}` : '');
      // A Session meeting is titled on its own ("Session Meeting"), not
      // "Session Session Meeting".
      const isSession = !!m.sessionMinutesId;
      const who = isSession ? m.title : `${m.entityName} ${m.title}`;
      let msg = `PCG-AOTC: Reminder — ${who} on ${toLocalDate(m.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} at ${m.time}, ${where}.`;
      if (m.conflicts && m.conflicts.memberClashes && m.conflicts.memberClashes.length) {
        msg += ' Note: this clashes with another meeting for some members.';
      }
      const to = isSession
        ? sessionContacts()
        : { phones: rosterContacts(m.entityType, m.entityId, m.kind === 'executive'), emails: [], userIds: push.userIdsForEntity(m.entityType, m.entityId) };
      const results = await deliver(msg, `Meeting reminder: ${m.title}`, to, isSession ? '/minutes.html' : '/meetings.html');
      logSent(key, 'meeting', `${m.entityName} ${m.date} ${m.time} (${w.tag})`, results);
    }
  }
}

// ---- 2. Quarter-end report reminders ----
function quarterInfo(now = new Date()) {
  const q = Math.floor(now.getMonth() / 3) + 1;
  const year = now.getFullYear();
  const qEnd = new Date(year, q * 3, 0);
  const due = new Date(year, q * 3, 5);
  return { q, year, qEnd, due };
}
async function checkQuarterReminders(now = new Date()) {
  const { q, year, qEnd, due } = quarterInfo(now);
  const daysToEnd = Math.ceil((qEnd - now) / 864e5);
  const daysToDue = Math.ceil((due - now) / 864e5);
  if (daysToEnd > 30 && daysToDue > 30) return;
  // bucket: weekly until 5 days before due, then daily
  const bucket = daysToDue <= 5 ? `final-${Math.max(0, daysToDue)}` : `week-${Math.ceil(daysToDue / 7)}`;

  const entities = [
    ...db.findAll('committees').filter(c => c.active !== false).map(c => ({ type: 'committee', id: c.id, code: c.code, name: c.name })),
    ...db.findAll('groups').filter(g => g.active !== false).map(g => ({ type: 'group', id: g.id, code: g.code, name: g.name })),
  ];
  for (const ent of entities) {
    const submitted = db.findOne('submissions', s => s.year === year && s.quarter === q &&
      s.entityType === ent.type && Number(s.entityId) === Number(ent.id) && s.status === 'submitted');
    if (submitted) continue;
    const key = `quarter:${year}:${q}:${ent.type}:${ent.id}:${bucket}`;
    if (alreadySent(key)) continue;

    const goals = db.findAll('goals', g => g.year === year && g.ownerCode === ent.code);
    const entered = new Set(db.findAll('kpi_entries', e => e.year === year && e.quarter === q).map(e => e.goalId));
    const missingKpis = goals.filter(g => (g.kpis || []).length && !entered.has(g.id)).length;
    const acts = db.findAll('activities', a => a.year === year && a.entityType === ent.type && Number(a.entityId) === Number(ent.id));
    const updated = new Set(db.findAll('activity_updates', u => u.year === year && u.quarter === q).map(u => u.activityId));
    const missingActs = acts.filter(a => !updated.has(a.id)).length;

    const dueStr = due.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
    let msg = `PCG-AOTC: Q${q} ${year} ends soon — ${ent.name}'s report is due by ${dueStr}.`;
    if (missingKpis || missingActs) msg += ` Outstanding: ${missingKpis} goal figure(s), ${missingActs} activity update(s).`;
    msg += ' Please complete and submit on AOTC Track.';
    const contacts = entityContacts(ent.type, ent.id, true);
    const results = await deliver(msg, `Q${q} report due ${dueStr} — ${ent.name}`, contacts, '/entry.html');
    logSent(key, 'quarter', `${ent.name} Q${q} (${bucket})`, results);
  }
}

// ---- 3. Statutory deadlines ----
async function checkStatutoryReminders(now = new Date()) {
  for (const s of STATUTORY) {
    const dueThisYear = new Date(now.getFullYear(), s.month, s.day);
    const dueNext = new Date(now.getFullYear() + 1, s.month, s.day);
    const dueDate = dueThisYear >= now ? dueThisYear : dueNext;
    const days = Math.ceil((dueDate - now) / 864e5);
    for (const lead of [14, 3]) {
      if (days !== lead) continue;
      const key = `statutory:${dueDate.getFullYear()}:${s.key}:d${lead}`;
      if (alreadySent(key)) continue;
      const msg = `PCG-AOTC: ${s.label} is due ${dueDate.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })} (${days} days away).`;
      let contacts;
      if (s.code === 'OG') {
        const clerkish = activeUsers(u => u.role === 'admin' || (u.permissions || []).includes('approvals.manage'));
        contacts = {
          phones: clerkish.filter(u => u.phone).map(u => u.phone),
          emails: clerkish.map(u => u.email).filter(Boolean),
          userIds: clerkish.map(u => u.id),
        };
      } else {
        const com = db.findOne('committees', c => c.code === s.code);
        contacts = com ? entityContacts('committee', com.id, true) : { phones: [], emails: [], userIds: [] };
      }
      const results = await deliver(msg, s.label, contacts);
      logSent(key, 'statutory', `${s.label} (${lead}d ahead)`, results);
    }
  }
}

// ---- 4. Stalled new-member follow-ups (weekly nudge to M&E) ----
async function checkVisitorFollowups(now = new Date()) {
  const people = db.findAll('visitors', v => v.status === 'new-member');
  const stalled = people.filter(v => {
    const created = new Date(v.createdAt || v.firstSeen);
    const ageDays = (now - created) / 864e5;
    const call = (v.steps || []).find(s => s.key === 'call7');
    if (call && !call.done && ageDays > 7) return true;
    const lastTouch = (v.followups || []).length
      ? new Date(v.followups[v.followups.length - 1].at)
      : created;
    return (now - lastTouch) / 864e5 > 14;
  });
  if (!stalled.length) return;
  const week = `${now.getFullYear()}-w${Math.ceil(((now - new Date(now.getFullYear(), 0, 1)) / 864e5 + 1) / 7)}`;
  const key = `visitors:stalled:${week}`;
  if (alreadySent(key)) return;
  const me = db.findOne('committees', c => c.code === 'ME');
  if (!me) return;
  const names = stalled.slice(0, 5).map(v => v.name).join(', ');
  const msg = `PCG-AOTC: ${stalled.length} new member(s) need follow-up (${names}${stalled.length > 5 ? '…' : ''}). Please check Visitors & New Members on AOTC Track.`;
  const results = await deliver(msg, 'New members needing follow-up', entityContacts('committee', me.id, true), '/visitors.html');
  logSent(key, 'visitors', `${stalled.length} stalled new member(s)`, results);
}

// ---- 5. Harvest IOU reminders ----
// Cadence (confirmed with the Harvest Committee): a halfway reminder between
// pledge and proposed payment date, then 3 days before, then on the day,
// then flagged OVERDUE weekly until marked paid. The debtor gets an SMS;
// the Harvest Committee (fundraising.manage) and Financial Secretary
// (finance.quarterly) get push + SMS. Dedupe via reminder_log as usual.
function mid(dateStr) { const d = toLocalDate(dateStr); return isNaN(d) ? null : d; }
async function checkIouReminders(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ious = db.findAll('fundraising_ious', i => i.status !== 'paid' && i.dueDate);
  const officers = activeUsers(u =>
    (u.permissions || []).includes('fundraising.manage') || (u.permissions || []).includes('finance.quarterly'));
  for (const iou of ious) {
    const due = mid(iou.dueDate);
    if (!due) continue;
    const created = mid((iou.createdAt || '').slice(0, 10)) || due;
    const daysToDue = Math.round((due - today) / 864e5);
    const totalDays = Math.round((due - created) / 864e5);
    let tag = null, when = null;
    if (daysToDue < 0 && (-daysToDue) % 7 === 0) { tag = `over-${-daysToDue / 7}`; when = 'overdue'; }
    else if (daysToDue === 0) { tag = 'd0'; when = 'due TODAY'; }
    else if (daysToDue === 3) { tag = 'd3'; when = 'due in 3 days'; }
    else if (totalDays >= 6 && daysToDue === Math.ceil(totalDays / 2)) { tag = 'half'; when = `due in ${daysToDue} days`; }
    if (!tag) continue;
    const key = `iou:${iou.id}:${tag}`;
    if (alreadySent(key)) continue;

    const dueStr = due.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    const amt = (iou.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
    let sms = 0, pushes = 0;
    // Debtor SMS
    if (iou.contact) {
      const msg = when === 'overdue'
        ? `PCG-AOTC Harvest: Dear ${iou.name}, your Harvest pledge of GHS ${amt} was due ${dueStr}. Kindly redeem it at your earliest convenience. Thank you and God bless you.`
        : `PCG-AOTC Harvest: Dear ${iou.name}, a gentle reminder of your Harvest pledge of GHS ${amt}, ${when === 'due TODAY' ? 'due today' : 'due ' + dueStr}. Thank you and God bless you.`;
      try { const r = await sendSms({ to: iou.contact, message: msg }); if (r && !r.skipped && !r.error) sms++; } catch (e) {}
    }
    // Harvest Chairperson + Financial Secretary: push + SMS
    const offMsg = `PCG-AOTC: IOU ${when.toUpperCase()} — ${iou.name}, GHS ${amt} (${iou.eventName} ${iou.date}), proposed payment ${dueStr}.${iou.contact ? '' : ' No contact on file — debtor NOT reminded directly.'}`;
    try {
      const r = await push.sendPushToUsers(officers.map(u => u.id), { title: `IOU ${when}`, body: offMsg, url: '/fundraising.html' });
      pushes = (r && r.sent) || 0;
    } catch (e) {}
    for (const u of officers) {
      if (u.phone) { try { const r = await sendSms({ to: u.phone, message: offMsg }); if (r && !r.skipped && !r.error) sms++; } catch (e) {} }
    }
    logSent(key, 'iou', `${iou.name} GHS ${amt} (${tag})`, { sms, emails: 0, push: pushes });
  }
}

// ---- 6. Banns of marriage reminders ----
// After Session's final approval, each of the three banns Sundays gets:
// a reminder 2 days ahead (Friday), one on the Sunday itself, and a
// "missed" flag the day after if it wasn't marked published. Goes to the
// Session Clerk (approvals.manage) — push + inbox + SMS.
async function checkBannsReminders(now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cases = db.findAll('marriage_cases', k => k.stage === 'approved' && Array.isArray(k.banns));
  const clerks = activeUsers(u => (u.permissions || []).includes('approvals.manage'));
  for (const kase of cases) {
    const b = ((kase.form || {}).b) || {};
    const couple = `${((b.husband || {}).name) || '?'} & ${((b.wife || {}).name) || '?'}`;
    for (const bann of kase.banns) {
      if (bann.published) continue;
      const due = mid(bann.date);
      if (!due) continue;
      const days = Math.round((due - today) / 864e5);
      let tag = null, msg = null;
      const dStr = due.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
      if (days === 2) { tag = 'd2'; msg = `PCG-AOTC: Banns of marriage ${bann.no} of 3 for ${couple} (${kase.refNo}) are to be published this ${dStr}. Marriage: ${(kase.dates || {}).marriageDate}.`; }
      else if (days === 0) { tag = 'd0'; msg = `PCG-AOTC: TODAY — publish banns ${bann.no} of 3 for ${couple} (${kase.refNo}). Mark them as published on AOTC Track afterwards.`; }
      else if (days === -1) { tag = 'missed'; msg = `PCG-AOTC: Banns ${bann.no} of 3 for ${couple} (${kase.refNo}) were due ${dStr} but are NOT marked as published. Please confirm on AOTC Track.`; }
      if (!tag) continue;
      const key = `banns:${kase.id}:${bann.no}:${tag}`;
      if (alreadySent(key)) continue;
      let sms = 0, pushes = 0;
      try {
        const r = await push.sendPushToUsers(clerks.map(u => u.id), { title: `Banns ${bann.no} of 3 — ${couple}`, body: msg, url: '/marriage.html' });
        pushes = (r && r.sent) || 0;
      } catch (e) {}
      for (const u of clerks) {
        if (u.phone) { try { const r = await sendSms({ to: u.phone, message: msg }); if (r && !r.skipped && !r.error) sms++; } catch (e) {} }
      }
      logSent(key, 'banns', `${kase.refNo} bann ${bann.no} (${tag})`, { sms, emails: 0, push: pushes });
    }
  }
}

// ---- 7. Sunday service attendance escalation ----
// If a Sunday's service figures aren't submitted + confirmed, nag the people
// responsible. On the service Sunday the first push goes out ~1pm (after the
// 12:30 deadline), then ~4pm, then ~6pm; the 6pm one — the last of each day —
// also goes by SMS + email. If it's still not done, the same 3-a-day cadence
// repeats on the following days until the Clerk confirms the day (we stop
// chasing a Sunday once it's >14 days old). Recipients are only the people who
// still owe something: recorders of any pending section (Children's / JY / Main)
// plus the Session Clerk (who sets up and confirms the day).
const SVC_SECTION_PERM = { cs: 'attendance.cs', jy: 'attendance.jy', adult: 'attendance.main' };
const SVC_SECTION_LABEL = { cs: "Children's Service", jy: 'JY', adult: 'Main Church' };
// Three daily slots; the last one each day escalates to SMS + email too.
// On the service Sunday the first push waits until after the 12:30 deadline
// (1pm), then 4pm, then 6pm. On the following days the three are spread evenly
// across the day at sensible hours (morning / midday / evening).
const SVC_SLOTS_SUNDAY = [{ tag: '1pm', hour: 13 }, { tag: '4pm', hour: 16 }, { tag: '6pm', hour: 18, full: true }];
const SVC_SLOTS_AFTER = [{ tag: 'am', hour: 9 }, { tag: 'midday', hour: 13 }, { tag: 'eve', hour: 18, full: true }];

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function mostRecentSunday(now) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - d.getDay()); // getDay(): 0 = Sunday
  return d;
}
async function checkServiceAttendanceReminders(now = new Date()) {
  const sunday = mostRecentSunday(now);
  const sundayStr = ymd(sunday);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const ageDays = Math.floor((today - sunday) / 864e5);
  if (ageDays > 14) return; // give up after two weeks

  const day = db.findOne('service_days', d => d.date === sundayStr);
  if (day && day.status === 'confirmed') return; // fully done

  // Sunday uses the 1/4/6pm escalation; later days spread evenly (9am/1pm/6pm).
  const slots = ageDays === 0 ? SVC_SLOTS_SUNDAY : SVC_SLOTS_AFTER;
  // Only the current (most-recent passed) slot fires each run — no backfilling
  // a burst if the server was down across several slot times.
  const passed = slots.filter(s => now.getHours() >= s.hour);
  if (!passed.length) return; // before ~1pm today
  const slot = passed[passed.length - 1];
  const key = `svcatt:${sundayStr}:${ymd(today)}:${slot.tag}`;
  if (alreadySent(key)) return;

  // Work out who still owes something and what's outstanding.
  const clerks = activeUsers(u =>
    u.role === 'admin' || u.role === 'localadmin' || (u.permissions || []).includes('approvals.manage'));
  const recipients = new Map(); // id -> user (dedupe)
  const add = list => list.forEach(u => recipients.set(u.id, u));
  const outstanding = [];
  if (!day) {
    outstanding.push('day not set up');
    add(clerks);
    Object.values(SVC_SECTION_PERM).forEach(p => add(activeUsers(u => (u.permissions || []).includes(p))));
  } else {
    const sec = day.sections || {};
    const pending = ['cs', 'jy', 'adult'].filter(s => !(sec[s] && sec[s].status === 'submitted'));
    if (pending.length) {
      pending.forEach(s => { outstanding.push(SVC_SECTION_LABEL[s]); add(activeUsers(u => (u.permissions || []).includes(SVC_SECTION_PERM[s]))); });
      add(clerks);
    } else {
      outstanding.push('final confirmation by the Clerk');
      add(clerks);
    }
  }
  const users = [...recipients.values()];
  if (!users.length) return;

  const dayLabel = sunday.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const outStr = outstanding.join(', ');
  const msg = `PCG-AOTC: Sunday attendance for ${dayLabel} is not complete yet (outstanding: ${outStr}). Please enter and confirm the figures on AOTC Track.`;
  const subject = `Sunday attendance outstanding — ${dayLabel}`;
  const userIds = users.map(u => u.id);

  let results;
  if (slot.full) {
    // Last push of the day → also SMS + email.
    const phones = users.map(u => u.phone).filter(Boolean);
    const emails = users.map(u => u.email).filter(Boolean);
    results = await deliver(msg, subject, { phones, emails, userIds }, '/attendance.html');
  } else {
    let pushes = 0;
    try { const r = await push.sendPushToUsers(userIds, { title: subject, body: msg, url: '/attendance.html' }); pushes = (r && r.sent) || 0; } catch (e) {}
    results = { sms: 0, emails: 0, pushes };
  }
  logSent(key, 'svc-attendance', `${sundayStr} ${slot.tag} — ${outStr}`, results);
}

// ---- 8. Close-of-day approval escalation ----
// Approval requests notify approvers by PUSH (+ email) the moment they're
// raised. This is the SECOND level: if a request is still pending at close of
// day, send the approvers a summary by SMS (and one more push) so it isn't
// forgotten overnight. Repeats each evening until the queue is cleared.
const APPROVAL_CLOSE_HOUR = 18; // 6pm — close of day
async function checkPendingApprovalReminders(now = new Date()) {
  if (now.getHours() < APPROVAL_CLOSE_HOUR) return;
  const today = ymd(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  const key = `approvals-eod:${today}`;
  if (alreadySent(key)) return;

  const rosterPending = db.findAll('roster_requests', r => r.status === 'pending').length;
  const changePending = db.findAll('change_requests', r => r.status === 'pending').length;
  const total = rosterPending + changePending;
  if (!total) return;

  const approvers = activeUsers(u =>
    u.role === 'admin' || u.role === 'localadmin' || (u.permissions || []).includes('approvals.manage'));
  if (!approvers.length) return;

  const parts = [];
  if (rosterPending) parts.push(`${rosterPending} roster request${rosterPending === 1 ? '' : 's'}`);
  if (changePending) parts.push(`${changePending} change request${changePending === 1 ? '' : 's'}`);
  const msg = `PCG-AOTC: ${total} approval${total === 1 ? '' : 's'} still awaiting your decision (${parts.join(', ')}). Please review on AOTC Track.`;

  // Second level = push + SMS + email to every approver. Deep-link to where the
  // bulk of the queue is handled (roster requests live on Committees/Groups).
  const url = rosterPending ? '/committees.html' : '/entry.html';
  const results = await deliver(msg, 'Approvals still pending', {
    phones: approvers.map(u => u.phone).filter(Boolean),
    emails: approvers.map(u => u.email).filter(Boolean),
    userIds: approvers.map(u => u.id),
  }, url);
  logSent(key, 'approvals-eod', `${total} pending (${parts.join(', ')})`, results);
}

// ---- Action point reminders ----
// Nudge the responsible member (SMS + email) and the entity office (push) as an
// open action point's target date approaches, on the day, and weekly while
// overdue. Deduped via reminder_log so hourly re-runs are harmless.
async function checkActionPointReminders(now = new Date()) {
  const day = 864e5;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const opens = db.findAll('action_points', a => a.status === 'open' && a.targetDate);
  for (const ap of opens) {
    const due = toLocalDate(ap.targetDate);
    if (isNaN(due)) continue;
    const daysTo = Math.round((due - today) / day);
    let tag = null, when = null;
    if (daysTo === 3) { tag = 'd3'; when = 'is due in 3 days'; }
    else if (daysTo === 0) { tag = 'due'; when = 'is due today'; }
    else if (daysTo < 0) {
      const wk = Math.ceil(-daysTo / 7);
      if (wk >= 1 && wk <= 8) { tag = `over-${wk}`; when = `is overdue (was due ${toLocalDate(ap.targetDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })})`; }
    }
    if (!tag) continue;
    const key = `action:${ap.id}:${tag}`;
    if (alreadySent(key)) continue;
    const mem = ap.responsibleMemberId ? db.findById('members', ap.responsibleMemberId) : null;
    const phones = mem && mem.phone ? [mem.phone] : [];
    const emails = mem && mem.email ? [mem.email] : [];
    const userIds = (ap.entityType && ap.entityType !== 'congregation') ? push.userIdsForEntity(ap.entityType, ap.entityId) : [];
    const who = ap.responsibleName ? ` for ${ap.responsibleName}` : '';
    const msg = `PCG-AOTC: Action point${who} ${when} — "${ap.text}" [${ap.entityName}].`;
    const results = await deliver(msg, 'Action point reminder', { phones, emails, userIds }, '/meetings.html');
    logSent(key, 'action', `${ap.entityName} #${ap.id} ${tag}`, results);
  }
}

// ---- 10. Weekly finance return ----
// The Sunday money entry. Nothing goes out on the Sunday itself or the Monday
// - the counting and banking happen then, and a reminder while someone is
// still counting is noise. From the TUESDAY it chases once a day until the
// week is confirmed, and it chases WHOSE TURN IT IS rather than everybody:
// the Accounts Clerk while it is unentered, the Treasurer once it is waiting
// on confirmation. By the Friday it stops being a quiet push and goes out as
// SMS and email too.
//
// Chases the OLDEST outstanding Sunday inside the window, not the newest, so a
// week that slipped is not buried by the one after it. One message per run.
const FINWK_FIRST_DAY = 2;   // Tuesday
const FINWK_HOUR = 9;        // mid-morning
const FINWK_LOUD_FROM = 5;   // Friday onwards: SMS + email, not just push
const FINWK_GIVE_UP = 14;
async function checkFinanceWeeklyReminders(now = new Date()) {
  if (now.getHours() < FINWK_HOUR) return;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const latest = mostRecentSunday(now);

  // Every Sunday still inside the window, oldest first.
  const candidates = [];
  for (let back = FINWK_GIVE_UP; back >= 0; back -= 7) {
    const d = new Date(latest); d.setDate(d.getDate() - back);
    const age = Math.floor((today - d) / 864e5);
    if (age >= FINWK_FIRST_DAY && age <= FINWK_GIVE_UP) candidates.push({ date: ymd(d), age });
  }
  if (!candidates.length) return;

  const outstanding = candidates.find(c => {
    const rec = db.findOne('finance_weekly', w => w.date === c.date);
    return !rec || rec.status !== 'confirmed';
  });
  if (!outstanding) return;

  const key = `finweek:${outstanding.date}:${ymd(today)}`;
  if (alreadySent(key)) return;

  const rec = db.findOne('finance_weekly', w => w.date === outstanding.date);
  const waitingOnClerk = !rec || rec.status === 'draft';
  const users = waitingOnClerk
    ? activeUsers(u => (u.permissions || []).includes('finance.weekly') || u.role === 'accounts')
    : activeUsers(u => (u.permissions || []).includes('finance.weekly.confirm') || u.role === 'treasurer');
  if (!users.length) return;

  const dayLabel = toLocalDate(outstanding.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const msg = waitingOnClerk
    ? `PCG-AOTC: the weekly finance return for ${dayLabel} has not been entered yet. Please record the week's receipts and payments on AOTC Track.`
    : `PCG-AOTC: the weekly finance return for ${dayLabel} is entered and waiting for the Treasurer to confirm it. It does not count towards the quarter until then.`;
  const subject = `Weekly finance return outstanding \u2014 ${dayLabel}`;
  const userIds = users.map(u => u.id);
  const url = `/finance-weekly.html?date=${outstanding.date}`;

  let results;
  if (outstanding.age >= FINWK_LOUD_FROM) {
    results = await deliver(msg, subject, {
      phones: users.map(u => u.phone).filter(Boolean),
      emails: users.map(u => u.email).filter(Boolean),
      userIds,
    }, url);
  } else {
    let pushes = 0;
    try { const r = await push.sendPushToUsers(userIds, { title: subject, body: msg, url }); pushes = (r && r.sent) || 0; } catch (e) {}
    results = { sms: 0, emails: 0, pushes };
  }
  logSent(key, 'finance-weekly', `${outstanding.date} \u2014 ${waitingOnClerk ? 'not entered' : 'awaiting Treasurer'} (day ${outstanding.age})`, results);
}

async function runAllReminders() {
  const now = new Date();
  await checkMeetingReminders(now);
  await checkActionPointReminders(now);
  await checkQuarterReminders(now);
  await checkStatutoryReminders(now);
  await checkVisitorFollowups(now);
  await checkIouReminders(now);
  await checkBannsReminders(now);
  await checkServiceAttendanceReminders(now);
  await checkPendingApprovalReminders(now);
  await checkFinanceWeeklyReminders(now);
}

function scheduleReminderJobs() {
  // Meetings every 15 minutes; the daily families hourly (dedupe keys make
  // repeated runs harmless).
  setInterval(() => checkMeetingReminders().catch(e => console.error('[reminders]', e.message)), 15 * 60 * 1000);
  setInterval(() => {
    checkQuarterReminders().catch(e => console.error('[reminders]', e.message));
    checkStatutoryReminders().catch(e => console.error('[reminders]', e.message));
    checkVisitorFollowups().catch(e => console.error('[reminders]', e.message));
    checkIouReminders().catch(e => console.error('[reminders]', e.message));
    checkBannsReminders().catch(e => console.error('[reminders]', e.message));
    checkServiceAttendanceReminders().catch(e => console.error('[reminders]', e.message));
    checkPendingApprovalReminders().catch(e => console.error('[reminders]', e.message));
    checkActionPointReminders().catch(e => console.error('[reminders]', e.message));
    checkFinanceWeeklyReminders().catch(e => console.error('[reminders]', e.message));
  }, 60 * 60 * 1000);
  setTimeout(() => runAllReminders().catch(e => console.error('[reminders]', e.message)), 20 * 1000);
  console.log('[reminders] jobs scheduled (meetings 15m, deadlines hourly)');
}

module.exports = { runAllReminders, scheduleReminderJobs, checkMeetingReminders, checkIouReminders, checkBannsReminders, checkServiceAttendanceReminders, checkActionPointReminders, checkFinanceWeeklyReminders };
