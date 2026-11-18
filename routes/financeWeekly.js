// AOTC Track — the weekly finance return.
//
// One record per Sunday, entered by the Accounts Clerk, confirmed by the
// Treasurer, and only then counted towards the quarter. The Session Clerk is
// told when a week is confirmed, because the Sunday announcement is read from
// these figures and the clerk is the one who reads it.
//
// The three states, and why there are three:
//   draft      — started, not finished. Invisible to the quarter.
//   entered    — the clerk is done. Still invisible to the quarter: one pair
//                of eyes is not enough for a figure that reaches the District.
//   confirmed  — the Treasurer has signed it off. Now it counts.
// Reopening a confirmed week is deliberately noisy (logged, and the quarter
// figure moves) because it is the only way a signed-off number can change.
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { activeUsers } = require('../utils/accountStatus');
const { requireAuth, requirePermission, requireAnyPermission } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { notifyUser } = require('../utils/approvalNotify');
const { actor, isAdmin } = require('../utils/scope');
const { isSunday, fmtDayLong } = require('../utils/dates');
const fw = require('../utils/financeWeekly');

// Reading the weekly book is open to the money offices and anyone with
// congregation-wide sight; writing is not.
const canRead = requireAnyPermission('finance.weekly', 'finance.weekly.confirm', 'finance.quarterly', 'congregation.view', 'approvals.manage');

function weekFor(date) {
  return db.findOne('finance_weekly', w => w.date === date) || null;
}
function shape(rec, defs) {
  if (!rec) return null;
  return { ...rec, receiptsTotal: fw.receiptsTotal(rec, defs), announcement: fw.announcementText(rec, defs) };
}

// ---- line definitions ------------------------------------------------------
router.get('/lines', requireAuth, canRead, (req, res) => {
  res.json({ lines: fw.lines({ includeRetired: req.query.all === '1' }), feedTargets: fw.FEED_TARGETS });
});

// Replace the line list. Admin tier / finance.weekly.lines (Treasurer) only: these keys are what
// historic weeks are stored against, so renaming is safe but re-keying is not.
// A line that is dropped from the list is RETIRED, never deleted, so a week
// entered last year keeps its figures and its labels.
router.put('/lines', requireAuth, requirePermission('finance.weekly.lines'), (req, res) => {
  const incoming = Array.isArray(req.body.lines) ? req.body.lines : null;
  if (!incoming) return res.status(400).json({ error: 'Send a lines array.' });
  const valid = Object.keys(fw.FEED_TARGETS);
  const seen = new Set();
  for (const l of incoming) {
    if (!l.key || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(l.key)) return res.status(400).json({ error: `Bad line key: ${l.key}` });
    if (seen.has(l.key)) return res.status(400).json({ error: `Duplicate line key: ${l.key}` });
    seen.add(l.key);
    if (!String(l.label || '').trim()) return res.status(400).json({ error: 'Every line needs a label.' });
    if (!['in', 'out'].includes(l.side)) return res.status(400).json({ error: `Line ${l.key} must be receipts (in) or payments (out).` });
    if (!valid.includes(l.feeds || '')) return res.status(400).json({ error: `Line ${l.key} points at an unknown quarterly field.` });
  }
  if (incoming.filter(l => l.isTotal).length > 1) return res.status(400).json({ error: 'Only one line can be the expenditure total.' });

  const existing = db.findAll('finance_weekly_lines');
  const byKey = {};
  existing.forEach(l => { byKey[l.key] = l; });
  incoming.forEach((l, i) => {
    // A payment can never be announced - the headline totals the announced
    // lines and calls them funds received.
    const patch = { key: l.key, label: String(l.label).trim(), side: l.side, feeds: l.feeds || '',
      isTotal: !!l.isTotal, announce: l.side === 'in' && l.announce !== false, order: i, active: true };
    if (byKey[l.key]) db.update('finance_weekly_lines', byKey[l.key].id, patch);
    else db.insert('finance_weekly_lines', patch);
  });
  // Anything not in the incoming list is retired, not removed.
  existing.filter(l => !seen.has(l.key) && l.active !== false)
    .forEach(l => db.update('finance_weekly_lines', l.id, { active: false }));
  logActivity({ ...actor(req), action: 'Updated the weekly finance line list', entityType: 'finance_weekly_lines', entityId: 0, entityLabel: `${incoming.length} lines` });
  res.json({ lines: fw.lines() });
});

// ---- weeks -----------------------------------------------------------------
router.get('/weeks', requireAuth, canRead, (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const defs = fw.lines({ includeRetired: true });
  const weeks = db.findAll('finance_weekly', w => Number(w.year) === year)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .map(w => shape(w, defs));
  res.json({ year, weeks, lines: fw.lines() });
});

router.get('/week/:date', requireAuth, canRead, (req, res) => {
  const date = String(req.params.date);
  if (!isSunday(date)) return res.status(400).json({ error: 'The weekly return is kept per Sunday. Pick a Sunday.' });
  const defs = fw.lines({ includeRetired: true });
  const rec = weekFor(date);
  res.json({
    date, week: shape(rec, defs), lines: fw.lines(),
    warnings: rec ? fw.validate(rec.amounts, defs) : [],
  });
});

router.put('/week/:date', requireAuth, requirePermission('finance.weekly'), (req, res) => {
  const date = String(req.params.date);
  if (!isSunday(date)) return res.status(400).json({ error: 'The weekly return is kept per Sunday. Pick a Sunday.' });
  const defs = fw.lines({ includeRetired: true });
  const existing = weekFor(date);
  if (existing && existing.status === 'confirmed' && !isAdmin(req)) {
    return res.status(409).json({ error: 'This week has been confirmed by the Treasurer. Ask for it to be reopened before changing it.' });
  }
  // Only known line keys are stored, so a stale browser cannot invent fields.
  const known = new Set(defs.map(l => l.key));
  const amounts = {};
  Object.entries(req.body.amounts || {}).forEach(([k, v]) => { if (known.has(k)) amounts[k] = fw.num(v); });
  const status = req.body.status === 'entered' ? 'entered' : 'draft';
  const patch = {
    date, year: fw.yearOf(date), quarter: fw.quarterOf(date),
    amounts, note: String(req.body.note || '').slice(0, 500), status,
    // Revivals and other programmes during the week (Nov 2026) — see utils/financeWeekly.js.
    programmes: fw.cleanProgrammes(req.body.programmes, date),
    enteredBy: req.user.name || req.user.email, enteredAt: new Date().toISOString(),
  };
  const rec = existing ? db.update('finance_weekly', existing.id, patch) : db.insert('finance_weekly', patch);
  logActivity({ ...actor(req), action: status === 'entered' ? 'Submitted the weekly finance return' : 'Saved a draft weekly finance return', entityType: 'finance_weekly', entityId: rec.id, entityLabel: date });

  // Tell the Treasurer there is something to confirm — the moment it is ready,
  // not on the next reminder sweep.
  if (status === 'entered' && (!existing || existing.status !== 'entered')) {
    const total = fw.receiptsTotal(rec, defs);
    activeUsers(u => (u.permissions || []).includes('finance.weekly.confirm') || u.role === 'treasurer')
      .forEach(u => notifyUser(u, 'Weekly finance return ready to confirm',
        `The weekly finance return for ${fmtDayLong(date)} has been entered (receipts GHS ${fw.money(total)}). Please confirm it.`,
        { url: `/finance-weekly.html?date=${date}` }));
  }
  res.json({ week: shape(rec, defs), warnings: fw.validate(amounts, defs) });
});

router.post('/week/:date/confirm', requireAuth, requirePermission('finance.weekly.confirm'), (req, res) => {
  const date = String(req.params.date);
  const defs = fw.lines({ includeRetired: true });
  const rec = weekFor(date);
  if (!rec) return res.status(404).json({ error: 'Nothing has been entered for that Sunday yet.' });
  if (rec.status === 'draft') return res.status(409).json({ error: 'The Accounts Clerk has not finished this week yet.' });
  if (rec.status === 'confirmed') return res.json({ week: shape(rec, defs) });
  const saved = db.update('finance_weekly', rec.id, {
    status: 'confirmed', confirmedBy: req.user.name || req.user.email, confirmedAt: new Date().toISOString(),
  });
  logActivity({ ...actor(req), action: 'Confirmed the weekly finance return', entityType: 'finance_weekly', entityId: rec.id, entityLabel: date });
  fw.applyToQuarter(saved.year, saved.quarter); // no-op unless that quarter runs off the weekly ledger

  // The Session Clerk reads these figures out. Tell them it is settled.
  const total = fw.receiptsTotal(saved, defs);
  activeUsers(u => (u.permissions || []).includes('approvals.manage') || u.role === 'clerk')
    .forEach(u => notifyUser(u, 'Weekly finance return confirmed',
      `${fmtDayLong(date)}: funds received GHS ${fw.money(total)}, confirmed by ${saved.confirmedBy}. The announcement text is ready to copy.`,
      { url: `/finance-weekly.html?date=${date}` }));
  res.json({ week: shape(saved, defs) });
});

// Reopening moves a figure the Treasurer has already signed. Restricted to the
// Treasurer and the admin tier, and always logged with a reason.
router.post('/week/:date/reopen', requireAuth, requireAnyPermission('finance.weekly.confirm'), (req, res) => {
  const date = String(req.params.date);
  const defs = fw.lines({ includeRetired: true });
  const rec = weekFor(date);
  if (!rec) return res.status(404).json({ error: 'Nothing has been entered for that Sunday yet.' });
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Say why the week is being reopened.' });
  const saved = db.update('finance_weekly', rec.id, { status: 'entered', reopenedBy: req.user.name || req.user.email, reopenedAt: new Date().toISOString(), reopenReason: reason });
  logActivity({ ...actor(req), action: `Reopened the weekly finance return — ${reason}`, entityType: 'finance_weekly', entityId: rec.id, entityLabel: date });
  fw.applyToQuarter(saved.year, saved.quarter); // the quarter must drop the figure it no longer has
  res.json({ week: shape(saved, defs) });
});

// Running totals for the page's "Totals so far" panel.
router.get('/totals', requireAuth, canRead, (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const quarter = Number(req.query.quarter) || Math.floor(new Date().getMonth() / 3) + 1;
  res.json({ ...fw.totals(year, quarter), perMember: fw.perMember(year, quarter), memberCategories: fw.MEMBER_CATEGORIES });
});

// Type a per-member figure for one quarter, or hand it back to the software.
//
// Send a number to override; send null (or an empty string) to clear that one
// field, after which the computed figure is in force again. Nothing is
// destroyed either way - the computation is derived and the typed value is
// stored apart from it.
router.put('/per-member/:year/:quarter', requireAuth, requirePermission('finance.quarterly'), (req, res) => {
  const year = Number(req.params.year), quarter = Number(req.params.quarter);
  if (!year || quarter < 1 || quarter > 4) return res.status(400).json({ error: 'Bad year or quarter.' });
  const fields = ['offertoryPerMemberWeek', 'tithePerMemberMonth', 'members'];
  const patch = {};
  fields.forEach(k => { if (k in req.body) patch[k] = req.body[k]; });
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === '') continue;
    if (!Number.isFinite(Number(v)) || Number(v) < 0) return res.status(400).json({ error: `${k} must be a number, or blank to go back to the computed figure.` });
  }
  fw.setOverride(year, quarter, patch);
  const now = fw.perMember(year, quarter);
  const typedNow = Object.entries(patch).filter(([, v]) => v !== null && v !== '').map(([k]) => k);
  logActivity({ ...actor(req),
    action: typedNow.length ? `Typed per-member figures for Q${quarter} ${year}` : `Reverted per-member figures for Q${quarter} ${year} to the computed values`,
    entityType: 'finance_permember', entityId: 0, entityLabel: `Q${quarter} ${year}` });
  res.json(now);
});

// Who counts as a contributing member, and the baseline SO-2.1 measures
// against. Finance-level decision, so it needs the quarterly-books right.
router.put('/config', requireAuth, requirePermission('finance.quarterly'), (req, res) => {
  const patch = {};
  if (Array.isArray(req.body.memberBasis)) {
    const valid = fw.MEMBER_CATEGORIES.map(c => c.key);
    const basis = req.body.memberBasis.filter(k => valid.includes(k));
    if (!basis.length) return res.status(400).json({ error: 'Choose at least one membership category to divide by.' });
    patch.memberBasis = basis;
  }
  if (req.body.baseline) {
    const b = req.body.baseline;
    const n = v => (v === '' || v === null || v === undefined ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
    patch.baseline = {
      label: String(b.label || 'January 2026').slice(0, 60),
      offertoryPerMemberWeek: n(b.offertoryPerMemberWeek),
      tithePerMemberMonth: n(b.tithePerMemberMonth),
    };
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });
  const saved = fw.saveConfig(patch);
  logActivity({ ...actor(req), action: 'Updated the per-member giving basis', entityType: 'finance_config', entityId: saved.id, entityLabel: (saved.memberBasis || []).join(', ') });
  res.json(saved);
});

// ---- the quarter -----------------------------------------------------------
// What the quarterly Finance panel reads. Confirmed weeks only.
router.get('/summary', requireAuth, canRead, (req, res) => {
  const year = Number(req.query.year) || new Date().getFullYear();
  const quarter = Number(req.query.quarter) || Math.floor(new Date().getMonth() / 3) + 1;
  const sum = fw.quarterSummary(year, quarter);
  res.json({ ...sum, sundaysInQuarter: fw.sundaysInQuarter(year, quarter), feedTargets: fw.FEED_TARGETS });
});

// Switch a quarter between the typed figures and the weekly ledger.
//
// Every quarter starts on 'manual', including every quarter that already
// exists, so nothing anyone has already typed is disturbed by this feature
// being deployed. Switching to 'weekly' is a deliberate act, it is logged, and
// it takes effect immediately. Switching back leaves the last applied figures
// in place rather than blanking them - reverting should not lose data either.
router.post('/quarter/:year/:quarter/source', requireAuth, requirePermission('finance.quarterly'), (req, res) => {
  const year = Number(req.params.year), quarter = Number(req.params.quarter);
  const source = req.body.source === 'weekly' ? 'weekly' : 'manual';
  if (!year || quarter < 1 || quarter > 4) return res.status(400).json({ error: 'Bad year or quarter.' });
  const existing = db.findOne('finance_quarterly', f => Number(f.year) === year && Number(f.quarter) === quarter);
  const rec = existing
    ? db.update('finance_quarterly', existing.id, { source })
    : db.insert('finance_quarterly', { year, quarter, earmarked: {}, almanac: [], source });
  const applied = source === 'weekly' ? fw.applyToQuarter(year, quarter) : null;
  logActivity({ ...actor(req), action: `Q${quarter} ${year} finance figures now come from the ${source === 'weekly' ? 'weekly returns' : 'typed entries'}`, entityType: 'finance_quarterly', entityId: rec.id, entityLabel: `Q${quarter} ${year}` });
  res.json({ source, record: applied || rec, summary: fw.quarterSummary(year, quarter) });
});

module.exports = router;
