// AOTC Track — Quarterly Data Entry (Phase 3).
// Quarter-only KPI actuals (cumulative computed), activity updates with
// remarks + actual spend, narrative sections, and the special panels
// (Finance CQDI-6/7, AHRM membership, PDBP lands/insurance).
// Submitting a quarter LOCKS that entity's data; only Admin can unlock.
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { activeUsers } = require('../utils/accountStatus');
const { requireAuth, requirePermission, requireAnyPermission, canManageAllEntities } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { notifyUser, notifyApprovers } = require('../utils/approvalNotify');
const { sortGroups } = require('../utils/groupOrder');
const { posterSvg } = require('../utils/submissionPoster');
const { statsFor } = require('../utils/derivedKpi');
const { resolveWindow } = require('../utils/unlockKinds');

// How long an approved change request keeps a submitted quarter open when the
// approver picks the short window. The alternative is 'deadline' — open until
// the quarter's own reporting deadline, which is the sensible choice while that
// deadline is still ahead (no point making a secretary re-request in 48 hours
// when the report is not due for another three weeks).
const { reportDueDate } = require('../utils/dates');

// Resolve the requested window to an ISO expiry, or an error string.
// mode: 'hours' (default, CHANGE_WINDOW_HOURS) | 'deadline' — capped so a
// deadline window can never be shorter than the plain 48 hours.

const { actor, userEntity, isAdmin, canViewAll } = require('../utils/scope');
function resolveEntity(req) {
  // Admins, clerk (approvals.manage) and the Reporting Coordinator
  // (congregation.manage) may act on any entity via query/body;
  // scoped users are forced to their own.
  const perms = (db.findById('users', req.user.id) || {}).permissions || [];
  if (isAdmin(req) || perms.includes('approvals.manage') || perms.includes('congregation.manage')) {
    const type = req.query.entityType || req.body.entityType;
    const id = req.query.entityId !== undefined ? req.query.entityId : req.body.entityId;
    if (type !== undefined && id !== undefined) return { type, id: Number(id) };
  }
  const ent = userEntity(req);
  return ent && ent.type !== 'congregation' ? { type: ent.type, id: Number(ent.id) } : (isAdmin(req) ? { type: 'congregation', id: 0 } : null);
}
function entityCode(type, id) {
  if (type === 'congregation') return 'OG';
  const rec = db.findById(type === 'committee' ? 'committees' : 'groups', Number(id));
  return rec ? rec.code : null;
}
// Opening a change window on a submitted quarter.
//
// TWO callers reach this: approving a change request someone raised, and the
// Session Clerk reopening straight from the submission board. They must write
// the SAME fields or the board, the entry page's lock and the auto-relock
// would each believe something different about the same quarter. So the write
// lives here once, and neither caller does it by hand.
function openChangeWindow(sub, expiresAt, mode, actorName) {
  return db.update('submissions', sub.id, {
    reopenedUntil: expiresAt,
    reopenedBy: actorName,
    reopenedAt: new Date().toISOString(),
    reopenedMode: mode,
  });
}

function findSubmission(year, quarter, type, id) {
  return db.findOne('submissions', s =>
    s.year === Number(year) && s.quarter === Number(quarter) &&
    s.entityType === type && Number(s.entityId) === Number(id) && s.status === 'submitted');
}
// An approved change request temporarily REOPENS a submitted quarter:
// submission.reopenedUntil holds the window's end. The lock automatically
// re-engages when the window expires or when the quarter is resubmitted.
function reopenActive(sub) {
  return !!(sub && sub.reopenedUntil && new Date(sub.reopenedUntil) > new Date());
}
function isLocked(year, quarter, type, id) {
  const sub = findSubmission(year, quarter, type, id);
  return !!sub && !reopenActive(sub);
}
function lockedError(res) {
  return res.status(423).json({ error: 'This quarter has been submitted and is locked. Request a change window (approved by the Session Clerk or an admin) or ask an admin to unlock it.' });
}

// GET /api/entry/data?year=&quarter=&entityType=&entityId=
router.get('/data', requireAuth, (req, res) => {
  const year = Number(req.query.year) || (db.findOne('years', y => y.active) || {}).year;
  const quarter = Number(req.query.quarter) || Math.floor(new Date().getMonth() / 3) + 1;
  let ent = resolveEntity(req);
  if (!ent) return res.status(403).json({ error: 'Your account is not attached to a committee or group.' });
  if (!canViewAll(req)) {
    const own = userEntity(req);
    if (!own || own.type !== ent.type || Number(own.id) !== Number(ent.id)) {
      return res.status(403).json({ error: 'You can only view your own data.' });
    }
  }
  const code = entityCode(ent.type, ent.id);
  const goals = db.findAll('goals', g => g.year === year && g.ownerCode === code);
  const goalIds = new Set(goals.map(g => g.id));
  const kpiEntries = db.findAll('kpi_entries', e => e.year === year && goalIds.has(e.goalId));
  const activities = db.findAll('activities', a => a.year === year && a.entityType === ent.type && Number(a.entityId) === Number(ent.id));
  const actIds = new Set(activities.map(a => a.id));
  const activityUpdates = db.findAll('activity_updates', u => u.year === year && actIds.has(u.activityId));
  const narrative = db.findOne('narratives', n => n.year === year && n.quarter === quarter && n.entityType === ent.type && Number(n.entityId) === Number(ent.id)) || null;
  const submission = db.findOne('submissions', s => s.year === year && s.quarter === quarter && s.entityType === ent.type && Number(s.entityId) === Number(ent.id)) || null;

  const special = {};
  if (code === 'Fin') special.finance = db.findOne('finance_quarterly', f => f.year === year && f.quarter === quarter) || null;
  if (code === 'AHRM') special.membership = db.findOne('membership_quarterly', m => m.year === year && m.quarter === quarter) || null;
  if (code === 'PDBP') {
    special.pdbp = db.findOne('pdbp_quarterly', p => p.year === year && p.quarter === quarter) || null;
    special.lands = db.findAll('lands');
    special.properties = db.findAll('properties');
  }
  // ---- Live stats gathered elsewhere in the system that inform KPI figures --
  // These are DERIVED, never typed: the Attendance page is the single source of
  // truth and the quarterly figure follows it. Each one is shown read-only on
  // the entry page and written into the stored KPI value so it reaches reports.
  //
  // bibleStudies — Sunday services this year (and this quarter) where the
  //   "Bible study held" box was ticked. Feeds SO-1.2 (CLN).
  // serviceAttendance — Sunday church attendance. Feeds CLN-01 "Average
  //   Attendance". A Sunday with a 1st AND a 2nd service is ONE Sunday whose
  //   figure is both services added together, so an average is per SUNDAY and
  //   never halved by counting the day twice.
  // groupAttendance — generational group meeting attendance, from the Group
  //   meeting attendance form. Feeds CLN-02 "Average Attendance". Scoped: a
  //   group sees its own meetings; CLN and the congregation see every group's,
  //   which is what CLN-02's congregation-level target describes.
  // The three attendance-derived figures. Computed in utils/derivedKpi.js,
  // which the report and the roll-up also use — so what the page shows and
  // what the report prints come from one piece of code, not two that agree
  // only while someone keeps them in step.
  const stats = statsFor(ent.type, ent.id, year, quarter);
  res.json({ year, quarter, entity: { ...ent, code }, goals, kpiEntries, activities, activityUpdates, narrative, submission, special, stats });
});

// PUT /api/entry/kpi  { year, quarter, goalId, values: [] }
router.put('/kpi', requireAuth, requirePermission('entry.manage'), (req, res) => {
  const { year, quarter, goalId, values } = req.body;
  const goal = db.findById('goals', Number(goalId));
  if (!goal) return res.status(404).json({ error: 'Goal not found.' });
  const ent = userEntity(req);
  const crossEntity = canManageAllEntities(req);
  const isOwn = crossEntity || (ent && entityCode(ent.type, ent.id) === goal.ownerCode);
  if (!isOwn) return res.status(403).json({ error: 'You can only enter data for your own goals.' });
  const type = goal.ownerType === 'congregation' ? 'congregation' : goal.ownerType;
  const entId = type === 'congregation' ? 0 : (crossEntity ? (db.findOne(type === 'committee' ? 'committees' : 'groups', c => c.code === goal.ownerCode) || {}).id : ent.id);
  if (isLocked(year, quarter, type, entId)) return lockedError(res);
  const existing = db.findOne('kpi_entries', e => e.year === Number(year) && e.quarter === Number(quarter) && e.goalId === goal.id);
  const vals = Array.isArray(values) ? values.slice(0, goal.kpis.length) : [];
  let rec;
  if (existing) rec = db.update('kpi_entries', existing.id, { values: vals });
  else rec = db.insert('kpi_entries', { year: Number(year), quarter: Number(quarter), goalId: goal.id, entityType: type, entityId: Number(entId), ownerCode: goal.ownerCode, values: vals });
  logActivity({ ...actor(req), action: `Entered Q${quarter} KPI data`, entityType: 'kpi_entry', entityId: rec.id, entityLabel: goal.code });
  res.json(rec);
});

// PUT /api/entry/activity-update  { year, quarter, activityId, actual, remarks, actualSpend }
router.put('/activity-update', requireAuth, requirePermission('entry.manage'), (req, res) => {
  const { year, quarter, activityId } = req.body;
  const act = db.findById('activities', Number(activityId));
  if (!act) return res.status(404).json({ error: 'Activity not found.' });
  const ent = userEntity(req);
  const isOwn = canManageAllEntities(req) || (ent && ent.type === act.entityType && Number(ent.id) === Number(act.entityId));
  if (!isOwn) return res.status(403).json({ error: 'You can only update your own activities.' });
  if (isLocked(year, quarter, act.entityType, act.entityId)) return lockedError(res);
  const existing = db.findOne('activity_updates', u => u.year === Number(year) && u.quarter === Number(quarter) && u.activityId === act.id);
  const patch = {
    actual: String(req.body.actual || '').trim(),
    remarks: String(req.body.remarks || '').trim(),
    actualSpend: req.body.actualSpend === '' || req.body.actualSpend === null || req.body.actualSpend === undefined ? null : Number(req.body.actualSpend),
  };
  let rec;
  if (existing) rec = db.update('activity_updates', existing.id, patch);
  else rec = db.insert('activity_updates', { year: Number(year), quarter: Number(quarter), activityId: act.id, entityType: act.entityType, entityId: act.entityId, ownerCode: act.ownerCode, ...patch });
  logActivity({ ...actor(req), action: `Updated Q${quarter} activity`, entityType: 'activity_update', entityId: rec.id, entityLabel: act.description.slice(0, 60) });
  res.json(rec);
});

// PUT /api/entry/narrative  { year, quarter, preamble, achievements, challenges, recommendations }
router.put('/narrative', requireAuth, requirePermission('entry.manage'), (req, res) => {
  const { year, quarter } = req.body;
  let ent = resolveEntity(req);
  if (!ent || ent.type === 'congregation' && !isAdmin(req)) return res.status(403).json({ error: 'Your account is not attached to a committee or group.' });
  if (isLocked(year, quarter, ent.type, ent.id)) return lockedError(res);
  const fields = {};
  ['preamble', 'achievements', 'challenges', 'recommendations', 'financial'].forEach(k => {
    if (req.body[k] !== undefined) fields[k] = String(req.body[k]).trim();
  });
  const existing = db.findOne('narratives', n => n.year === Number(year) && n.quarter === Number(quarter) && n.entityType === ent.type && Number(n.entityId) === Number(ent.id));
  let rec;
  if (existing) rec = db.update('narratives', existing.id, fields);
  else rec = db.insert('narratives', { year: Number(year), quarter: Number(quarter), entityType: ent.type, entityId: Number(ent.id), ownerCode: entityCode(ent.type, ent.id), ...fields });
  logActivity({ ...actor(req), action: `Saved Q${quarter} narrative`, entityType: 'narrative', entityId: rec.id, entityLabel: rec.ownerCode });
  res.json(rec);
});

// ---- Special panels ----
function specialGuard(req, res, code) {
  // Admins and the Reporting Coordinator may fill any special panel they
  // hold the module permission for; otherwise it belongs to that committee.
  if (canManageAllEntities(req)) return true;
  const ent = userEntity(req);
  if (ent && entityCode(ent.type, ent.id) === code) return true;
  res.status(403).json({ error: 'This panel belongs to another committee.' });
  return false;
}

router.put('/finance', requireAuth, requirePermission('finance.quarterly'), (req, res) => {
  if (!specialGuard(req, res, 'Fin')) return;
  const { year, quarter, earmarked, almanac } = req.body;
  const finEnt = db.findOne('committees', c => c.code === 'Fin');
  if (isLocked(year, quarter, 'committee', finEnt.id)) return lockedError(res);
  const existing = db.findOne('finance_quarterly', f => f.year === Number(year) && f.quarter === Number(quarter));
  // A quarter that has been switched to the weekly returns is written by
  // utils/financeWeekly.applyToQuarter and by nothing else. The page disables
  // the boxes, but a stale tab or a direct call must be refused too, or the
  // panel and the ledger would silently disagree about the same quarter.
  if (existing && existing.source === 'weekly' && earmarked !== undefined) {
    return res.status(409).json({ error: `Q${quarter} is taken from the weekly finance returns. Change the figures on the Weekly finance page, or switch this quarter back to typed figures first.` });
  }
  const patch = {};
  if (earmarked !== undefined) patch.earmarked = earmarked;
  if (almanac !== undefined) patch.almanac = almanac;
  const rec = existing ? db.update('finance_quarterly', existing.id, patch)
    : db.insert('finance_quarterly', { year: Number(year), quarter: Number(quarter), ...patch });
  logActivity({ ...actor(req), action: `Saved Q${quarter} finance figures`, entityType: 'finance_quarterly', entityId: rec.id, entityLabel: `Q${quarter} ${year}` });
  res.json(rec);
});

router.put('/membership', requireAuth, requirePermission('entry.manage'), (req, res) => {
  if (!specialGuard(req, res, 'AHRM')) return;
  const { year, quarter, categories } = req.body;
  const ahrm = db.findOne('committees', c => c.code === 'AHRM');
  if (isLocked(year, quarter, 'committee', ahrm.id)) return lockedError(res);
  const existing = db.findOne('membership_quarterly', m => m.year === Number(year) && m.quarter === Number(quarter));
  const rec = existing ? db.update('membership_quarterly', existing.id, { categories })
    : db.insert('membership_quarterly', { year: Number(year), quarter: Number(quarter), categories });
  logActivity({ ...actor(req), action: `Saved Q${quarter} membership statistics`, entityType: 'membership_quarterly', entityId: rec.id, entityLabel: `Q${quarter} ${year}` });
  res.json(rec);
});

router.put('/pdbp', requireAuth, requirePermission('entry.manage'), (req, res) => {
  if (!specialGuard(req, res, 'PDBP')) return;
  const { year, quarter, lands, properties } = req.body;
  const pd = db.findOne('committees', c => c.code === 'PDBP');
  if (isLocked(year, quarter, 'committee', pd.id)) return lockedError(res);
  const existing = db.findOne('pdbp_quarterly', p => p.year === Number(year) && p.quarter === Number(quarter));
  const patch = {};
  if (lands !== undefined) patch.lands = lands;
  if (properties !== undefined) patch.properties = properties;
  const rec = existing ? db.update('pdbp_quarterly', existing.id, patch)
    : db.insert('pdbp_quarterly', { year: Number(year), quarter: Number(quarter), ...patch });
  logActivity({ ...actor(req), action: `Saved Q${quarter} land/property status`, entityType: 'pdbp_quarterly', entityId: rec.id, entityLabel: `Q${quarter} ${year}` });
  res.json(rec);
});

// ---- Submit / lock / unlock ----
router.post('/submit', requireAuth, requirePermission('entry.manage'), (req, res) => {
  const { year, quarter } = req.body;
  let ent = resolveEntity(req);
  if (!ent || (ent.type === 'congregation' && !isAdmin(req))) return res.status(403).json({ error: 'Your account is not attached to a committee or group.' });
  if (isLocked(year, quarter, ent.type, ent.id)) return res.status(400).json({ error: 'Already submitted.' });
  // Resubmitting during an approved change window closes the window and
  // re-locks immediately (rather than inserting a duplicate submission).
  const existing = findSubmission(year, quarter, ent.type, ent.id);
  let rec;
  if (existing) {
    rec = db.update('submissions', existing.id, {
      reopenedUntil: null,
      resubmittedBy: actor(req).userName, resubmittedAt: new Date().toISOString(),
    });
    // Mark the change request(s) that opened this window as completed.
    db.findAll('change_requests', r => r.status === 'approved' &&
      r.entityType === ent.type && Number(r.entityId) === Number(ent.id) &&
      Number(r.year) === Number(year) && Number(r.quarter) === Number(quarter)
    ).forEach(r => db.update('change_requests', r.id, { status: 'completed', completedAt: new Date().toISOString() }));
    logActivity({ ...actor(req), action: `Resubmitted Q${quarter} ${year} (change window closed)`, entityType: 'submission', entityId: rec.id, entityLabel: rec.ownerCode });
  } else {
    rec = db.insert('submissions', {
      year: Number(year), quarter: Number(quarter), entityType: ent.type, entityId: Number(ent.id),
      ownerCode: entityCode(ent.type, ent.id), status: 'submitted',
      submittedBy: actor(req).userName, submittedAt: new Date().toISOString(),
    });
    logActivity({ ...actor(req), action: `Submitted Q${quarter} ${year}`, entityType: 'submission', entityId: rec.id, entityLabel: rec.ownerCode });
  }
  res.json(rec);
});

router.post('/unlock', requireAuth, (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Only an administrator can unlock a submitted quarter.' });
  const { year, quarter, entityType, entityId } = req.body;
  const sub = db.findOne('submissions', s => s.year === Number(year) && s.quarter === Number(quarter) && s.entityType === entityType && Number(s.entityId) === Number(entityId) && s.status === 'submitted');
  if (!sub) return res.status(404).json({ error: 'No submitted quarter found to unlock.' });
  db.update('submissions', sub.id, { status: 'unlocked', unlockedBy: actor(req).userName, unlockedAt: new Date().toISOString() });
  logActivity({ ...actor(req), action: `UNLOCKED Q${quarter} ${year}`, entityType: 'submission', entityId: sub.id, entityLabel: sub.ownerCode });
  res.json({ ok: true });
});

// Submissions overview (clerk/admin) — who has submitted, who hasn't
router.get('/submissions', requireAuth, (req, res) => {
  if (!canViewAll(req)) {
    const ent = userEntity(req);
    if (!ent) return res.json([]);
    return res.json(db.findAll('submissions', s => s.entityType === ent.type && Number(s.entityId) === Number(ent.id)));
  }
  res.json(db.findAll('submissions'));
});

// Who has submitted this quarter, and who has not.
//
// The data for this has always existed - one submissions row per entity per
// quarter - but nothing ever added it up. The quarter-end reminders chase each
// committee individually and the Session Clerk could see the result only by
// opening all twenty-five entries one at a time. This is the board: every
// committee and group, what state its quarter is in, and how long is left.
//
// The page orders the rows: submitted, then reopened, then not submitted. The
// server returns them by entity (committees alphabetically, groups in their
// generational order) and leaves presentation to the page.
//
// On the lifecycle: there are three states, not four. Submitting IS what locks
// a quarter - there is no separate "final draft" step - and nothing in the app
// records a report being RECEIVED by anyone, so this board reports what the
// entity did, never what the clerk thinks of it.
// Assembled once and read twice - the JSON the page draws, and the SVG poster
// that goes to WhatsApp. If these ever diverged, the picture the congregation
// sees would disagree with the board the clerk is working from.
function buildBoard(year, quarter) {
  const subs = db.findAll('submissions', s => Number(s.year) === year && Number(s.quarter) === quarter);
  const now = new Date();

  const rowFor = (type, e) => {
    const sub = subs.find(s => s.entityType === type && Number(s.entityId) === Number(e.id)) || null;
    // Two ways a submitted quarter can be open again: a timed change window,
    // or an admin stripping the lock outright (POST /unlock sets status to
    // 'unlocked' and no expiry). Both are "open"; counting the second as
    // Submitted would tell the clerk the opposite of the truth.
    const unlocked = !!(sub && sub.status === 'unlocked');
    const reopened = unlocked || !!(sub && sub.reopenedUntil && new Date(sub.reopenedUntil) > now);
    return {
      entityType: type, entityId: e.id, code: e.code || null, name: e.name,
      status: !sub ? 'outstanding' : (reopened ? 'reopened' : 'submitted'),
      // 'unlocked' has no expiry, so the page says "open" rather than a date.
      openEnded: unlocked,
      canReopen: !!sub && !reopened && sub.status === 'submitted',
      submittedBy: sub ? sub.submittedBy : null,
      submittedAt: sub ? sub.submittedAt : null,
      reopenedUntil: reopened ? sub.reopenedUntil : null,
      reopenedBy: reopened ? sub.reopenedBy : null,
      reopenedMode: reopened ? sub.reopenedMode : null,
    };
  };
  // Archived committees and groups are left off. Archiving is how a wound-up
  // body leaves the lists (its history is kept); counting it here put a second
  // "Church Choir" on the board in Oct 2026 after the original was archived and
  // re-created, and would chase an archived body for a report forever.
  const live = e => e.active !== false;
  const committees = db.findAll('committees', live).slice()
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    .map(c => rowFor('committee', c));
  const groups = sortGroups(db.findAll('groups', live)).map(g => rowFor('group', g));
  const rows = committees.concat(groups);

  const due = reportDueDate(year, quarter);
  const count = st => rows.filter(r => r.status === st).length;
  return {
    year, quarter, rows,
    total: rows.length,
    submitted: count('submitted'),
    outstanding: count('outstanding'),
    reopened: count('reopened'),
    dueAt: due.toISOString(),
    // Negative once the deadline has gone, which the page says out loud
    // rather than showing a cheerful "0 days left".
    daysLeft: Math.ceil((due - now) / 864e5),
  };
}

function boardQuery(req) {
  return {
    year: Number(req.query.year) || (db.findOne('years', y => y.active) || {}).year,
    quarter: Number(req.query.quarter) || Math.floor(new Date().getMonth() / 3) + 1,
  };
}

router.get('/submission-board', requireAuth, (req, res) => {
  if (!canViewAll(req)) return res.status(403).json({ error: 'This is a congregation-wide view.' });
  const { year, quarter } = boardQuery(req);
  res.json(buildBoard(year, quarter));
});

// The same board as a shareable image.
//
// SVG, not PNG: nothing on the server can rasterise, and adding a native image
// library to the VPS for one poster is a poor trade. The page draws this into a
// canvas and saves the PNG, which also keeps it working offline.
router.get('/submission-board/poster.svg', requireAuth, (req, res) => {
  if (!canViewAll(req)) return res.status(403).json({ error: 'This is a congregation-wide view.' });
  const { year, quarter } = boardQuery(req);
  const svg = posterSvg(buildBoard(year, quarter));
  res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg);
});

// Reopen a quarter straight from the submission board.
//
// The board is where you SEE that a committee needs to fix something, so it is
// where you should be able to act. This is not a new kind of unlock: it opens
// exactly the same window the change-request route opens, through the same
// helper, and re-locks itself the same way. The difference is only who starts
// it - here the clerk does, without waiting for the committee to ask.
//
// Deliberately NOT the admin `/unlock` route, which strips the lock entirely
// with no expiry. A window that closes by itself is the safer default; a
// permanent unlock stays an admin act.
router.post('/reopen-quarter', requireAuth, requireAnyPermission('approvals.manage'), (req, res) => {
  const { year, quarter, entityType, entityId } = req.body;
  const sub = findSubmission(year, quarter, entityType, entityId);
  if (!sub) return res.status(404).json({ error: 'That quarter is not submitted, so there is nothing to reopen.' });
  const win = resolveWindow(req.body.window, year, quarter);
  if (win.error) return res.status(400).json({ error: win.error });
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Say why the quarter is being reopened.' });
  const { expiresAt, mode } = win;
  const saved = openChangeWindow(sub, expiresAt, mode, actor(req).userName);

  const untilText = mode === 'deadline'
    ? `the Q${quarter} reporting deadline (${new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })})`
    : new Date(expiresAt).toLocaleString('en-GB');
  logActivity({ ...actor(req),
    action: `REOPENED Q${quarter} ${year} from the submission board (${mode === 'deadline' ? 'until the reporting deadline' : '48 hours'}) \u2014 ${reason}`,
    entityType: 'submission', entityId: sub.id, entityLabel: sub.ownerCode });

  // Tell the people who have to act on it. Nobody asked for this window, so
  // without a notification the committee would never know it had been given.
  activeUsers(u => u.entity && u.entity.type === entityType && Number(u.entity.id) === Number(entityId))
    .forEach(u => notifyUser(u, 'Your quarter has been reopened',
      `${actor(req).userName} reopened Q${quarter} ${year} for ${sub.ownerCode}: ${reason}. You can edit until ${untilText} \u2014 resubmit when done.`,
      { url: '/entry.html' }));
  res.json(saved);
});

// ---- Change requests (temporary reopening of a submitted quarter) ----
// Anyone who can enter data (entry.manage) may ASK for a change window on a
// locked quarter — their own entity for secretaries, any entity for the
// Reporting Coordinator (congregation.manage). The Session Clerk
// (approvals.manage) or any admin approves/declines. Approval reopens the
// quarter for CHANGE_WINDOW_HOURS; it re-locks on expiry or resubmission.

function canApproveChanges(req) {
  if (isAdmin(req)) return true;
  const u = db.findById('users', req.user.id) || {};
  return (u.permissions || []).includes('approvals.manage');
}

// POST /api/entry/change-requests { entityType, entityId, year, quarter, reason }
router.post('/change-requests', requireAuth, requirePermission('entry.manage'), (req, res) => {
  const { entityType, entityId, year, quarter, reason } = req.body;
  if (!entityType || entityId === undefined || !year || !quarter) {
    return res.status(400).json({ error: 'Entity, year and quarter are required.' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'Briefly say what needs to change and why.' });
  }
  // Requester must own the entity, or hold congregation.manage.
  if (!canManageAllEntities(req)) {
    const ent = userEntity(req);
    if (!ent || ent.type !== entityType || Number(ent.id) !== Number(entityId)) {
      return res.status(403).json({ error: 'You can only request changes for your own committee or group.' });
    }
  }
  const sub = findSubmission(year, quarter, entityType, entityId);
  if (!sub) return res.status(400).json({ error: 'That quarter is not locked — you can edit it directly.' });
  if (reopenActive(sub)) return res.status(400).json({ error: 'A change window is already open for that quarter.' });
  const dup = db.findOne('change_requests', r => r.status === 'pending' &&
    r.entityType === entityType && Number(r.entityId) === Number(entityId) &&
    Number(r.year) === Number(year) && Number(r.quarter) === Number(quarter));
  if (dup) return res.status(409).json({ error: 'A request for that quarter is already awaiting approval.' });
  const rec = db.insert('change_requests', {
    entityType, entityId: Number(entityId), ownerCode: entityCode(entityType, entityId),
    year: Number(year), quarter: Number(quarter),
    reason: String(reason).trim(), status: 'pending',
    requestedById: req.user.id, requestedBy: actor(req).userName,
    createdAt: new Date().toISOString(),
  });
  logActivity({ ...actor(req), action: `Requested change window for Q${quarter} ${year}`, entityType: 'change_request', entityId: rec.id, entityLabel: rec.ownerCode });
  notifyApprovers('Change request awaiting approval',
    `${rec.requestedBy} requests to reopen Q${rec.quarter} ${rec.year} for ${rec.ownerCode}. Reason: ${rec.reason}. Approve or decline on the Quarterly Entry page.`,
    req.user.id, '/entry.html');
  res.status(201).json(rec);
});

// GET /api/entry/change-requests?status=&entityType=&entityId=
// Clerk/admin see all; everyone else sees their own entity's + own requests.
router.get('/change-requests', requireAuth, (req, res) => {
  let list = db.findAll('change_requests');
  if (!canApproveChanges(req) && !canManageAllEntities(req)) {
    const ent = userEntity(req) || {};
    list = list.filter(r => r.requestedById === req.user.id ||
      (r.entityType === ent.type && Number(r.entityId) === Number(ent.id)));
  }
  if (req.query.status) list = list.filter(r => r.status === req.query.status);
  if (req.query.entityType) list = list.filter(r => r.entityType === req.query.entityType);
  if (req.query.entityId !== undefined) list = list.filter(r => Number(r.entityId) === Number(req.query.entityId));
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  // Hand the approver the quarter's reporting deadline so the UI can offer
  // "open until the deadline" only while that deadline is genuinely ahead.
  const now = new Date();
  res.json(list.map(r => {
    const due = reportDueDate(r.year, r.quarter);
    return { ...r, reportDueAt: due.toISOString(), deadlineAhead: due > now };
  }));
});

// POST /api/entry/change-requests/:id/approve — Session Clerk or admin.
router.post('/change-requests/:id/approve', requireAuth, requireAnyPermission('approvals.manage'), (req, res) => {
  const rec = db.findById('change_requests', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Request not found.' });
  if (rec.status !== 'pending') return res.status(400).json({ error: `This request was already ${rec.status}.` });
  const sub = findSubmission(rec.year, rec.quarter, rec.entityType, rec.entityId);
  if (!sub) return res.status(400).json({ error: 'That quarter is no longer locked.' });
  const win = resolveWindow(req.body.window, rec.year, rec.quarter);
  if (win.error) return res.status(400).json({ error: win.error });
  const { expiresAt, mode } = win;
  openChangeWindow(sub, expiresAt, mode, actor(req).userName);
  const updated = db.update('change_requests', rec.id, {
    status: 'approved', decidedBy: actor(req).userName, decidedAt: new Date().toISOString(), expiresAt, window: mode,
  });
  const untilText = mode === 'deadline'
    ? `the Q${rec.quarter} reporting deadline (${new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })})`
    : new Date(expiresAt).toLocaleString('en-GB');
  logActivity({ ...actor(req), action: `APPROVED change window for Q${rec.quarter} ${rec.year} (${mode === 'deadline' ? 'until the reporting deadline' : '48 hours'}, until ${expiresAt})`, entityType: 'change_request', entityId: rec.id, entityLabel: rec.ownerCode });
  notifyUser(db.findById('users', rec.requestedById), 'Change request approved',
    `Your request to reopen Q${rec.quarter} ${rec.year} for ${rec.ownerCode} was approved by ${actor(req).userName}. You can edit until ${untilText} — resubmit when done.`,
    { url: '/entry.html' });
  res.json(updated);
});

// POST /api/entry/change-requests/:id/decline — Session Clerk or admin.
router.post('/change-requests/:id/decline', requireAuth, requireAnyPermission('approvals.manage'), (req, res) => {
  const rec = db.findById('change_requests', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Request not found.' });
  if (rec.status !== 'pending') return res.status(400).json({ error: `This request was already ${rec.status}.` });
  const updated = db.update('change_requests', rec.id, {
    status: 'declined', decidedBy: actor(req).userName, decidedAt: new Date().toISOString(),
    declineReason: String(req.body.reason || '').trim() || null,
  });
  logActivity({ ...actor(req), action: `Declined change window for Q${rec.quarter} ${rec.year}`, entityType: 'change_request', entityId: rec.id, entityLabel: rec.ownerCode });
  notifyUser(db.findById('users', rec.requestedById), 'Change request declined',
    `Your request to reopen Q${rec.quarter} ${rec.year} for ${rec.ownerCode} was declined by ${actor(req).userName}${updated.declineReason ? `: ${updated.declineReason}` : '.'}`,
    { url: '/entry.html' });
  res.json(updated);
});

module.exports = router;
