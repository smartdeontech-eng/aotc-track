// Everything that locks, and how to ask for it back.
//
// WHY ONE FILE. Five things in this app lock: a submitted quarter, a confirmed
// Sunday, a meeting's attendance, a signed-off fundraising day and a confirmed
// weekly finance return. Until now exactly one of them — the quarter — could be
// reopened by asking. The other four told the user "ask an admin", which is the
// software instructing people to leave the software. The reason for the change,
// who asked and who agreed all ended up in a phone call and nowhere else.
//
// The fix is one request model, not five. Each kind declares four things —
// where the record lives, whether it is locked, who may judge a request, and
// how to open it — and routes/unlocks.js does the rest once. Adding a sixth
// lockable thing later means adding an entry here and nothing else.
//
// EACH KIND OPENS ITSELF ITS OWN WAY. These are not re-implementations: every
// `open` below does exactly what that module's existing admin unlock does, so
// an approved request and an admin acting by hand leave identical records.
const db = require('./db');
const { reportDueDate } = require('./dates');

// Admins can always approve. Beyond that, a kind is judged by whoever is
// actually placed to judge it: money goes to the Treasurer, the rest to the
// Session Clerk. One queue, filtered — not one person approving everything.
const KINDS = {
  'quarter': {
    label: 'Quarterly entry',
    approvers: ['approvals.manage'],
    describe: t => `Q${t.quarter} ${t.year} — ${t.ownerCode || t.entityType}`,
    find: t => db.findOne('submissions', s => Number(s.year) === Number(t.year)
      && Number(s.quarter) === Number(t.quarter) && s.entityType === t.entityType
      && Number(s.entityId) === Number(t.entityId)),
    isLocked: rec => !!rec && rec.status === 'submitted'
      && !(rec.reopenedUntil && new Date(rec.reopenedUntil) > new Date()),
    // The only kind with a timed window, because it already had one and the
    // quarter re-locks itself on resubmission. The rest are plain unlocks that
    // the owner re-confirms when they are done, exactly as before.
    timed: true,
    open: (rec, { expiresAt, mode, actorName }) => db.update('submissions', rec.id, {
      reopenedUntil: expiresAt, reopenedBy: actorName,
      reopenedAt: new Date().toISOString(), reopenedMode: mode,
    }),
  },

  'service-day': {
    label: 'Sunday attendance',
    approvers: ['approvals.manage'],
    describe: t => `Sunday ${t.date}`,
    find: t => db.findOne('service_days', d => d.date === t.date),
    isLocked: rec => !!rec && rec.status === 'confirmed',
    timed: false,
    // Mirrors POST /attendance/days/unlock.
    open: rec => db.update('service_days', rec.id, { status: 'open', confirmedBy: null, confirmedAt: null }),
  },

  'meeting-attendance': {
    label: 'Meeting attendance',
    approvers: ['approvals.manage'],
    describe: t => `Meeting #${t.meetingId}`,
    find: t => db.findById('meetings', Number(t.meetingId)),
    isLocked: rec => !!(rec && rec.attendance && rec.attendance.locked),
    timed: false,
    // Mirrors POST /meetings/:id/unlock-attendance.
    open: rec => db.update('meetings', rec.id, {
      attendance: { ...rec.attendance, locked: false, unlockedAt: new Date().toISOString() },
    }),
  },

  'fundraising-day': {
    label: 'Fundraising day',
    approvers: ['fundraising.approve'],
    describe: t => `${t.date}`,
    find: t => {
      const rows = db.findAll('fundraising_entries', e => Number(e.eventId) === Number(t.eventId) && e.date === t.date);
      return rows.length ? { id: `${t.eventId}:${t.date}`, eventId: Number(t.eventId), date: t.date, rows } : null;
    },
    isLocked: rec => !!rec && rec.rows.some(e => e.status === 'confirmed' || e.status === 'verified'),
    timed: false,
    // Mirrors POST /fundraising/unconfirm-day.
    open: rec => {
      rec.rows.forEach(e => db.update('fundraising_entries', e.id, { status: 'pending', submittedAt: null, submittedBy: null }));
      return rec;
    },
  },

  'finance-week': {
    label: 'Weekly finance return',
    approvers: ['finance.weekly.confirm'],
    describe: t => `Week of ${t.date}`,
    find: t => db.findOne('finance_weekly', w => w.date === t.date),
    isLocked: rec => !!rec && rec.status === 'confirmed',
    timed: false,
    // Mirrors POST /finance-weekly/week/:date/reopen.
    open: (rec, { actorName, reason }) => db.update('finance_weekly', rec.id, {
      status: 'entered', reopenedBy: actorName, reopenedAt: new Date().toISOString(), reopenReason: reason,
    }),
  },
};


// The change window a timed kind gets when approved: a short fixed window, or
// open until that quarter's own reporting deadline while that deadline is still
// ahead. Lives here rather than in routes/entry.js so the quarterly approval
// and the generic one cannot drift to different lengths.
const CHANGE_WINDOW_HOURS = 48;
function resolveWindow(mode, year, quarter) {
  if (mode !== 'deadline') {
    return { expiresAt: new Date(Date.now() + CHANGE_WINDOW_HOURS * 3600 * 1000).toISOString(), mode: 'hours' };
  }
  const due = reportDueDate(year, quarter);
  if (due <= new Date()) {
    return { error: `The Q${quarter} ${year} reporting deadline (${due.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}) has already passed — approve a 48-hour window instead.` };
  }
  return { expiresAt: due.toISOString(), mode: 'deadline', due };
}

function kind(name) { return KINDS[name] || null; }

// May this person decide this request? Admin tier always; otherwise the one
// permission that kind names.
function canApprove(name, role, permissions) {
  if (['admin', 'localadmin'].includes(role)) return true;
  const k = kind(name);
  if (!k) return false;
  return k.approvers.some(p => (permissions || []).includes(p));
}

// Everything this person is placed to judge, for filtering the queue.
function approvableKinds(role, permissions) {
  return Object.keys(KINDS).filter(n => canApprove(n, role, permissions));
}

module.exports = { KINDS, kind, canApprove, approvableKinds, resolveWindow, CHANGE_WINDOW_HOURS };
