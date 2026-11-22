// AOTC Track — Harvest & Fundraising module (Phase 9).
// Events (Launch / 1st / 2nd / Main Harvest + custom) with targets;
// per-service inflow entries (Seed contributions, Gratitude & Thanksgiving,
// day-born offertory, chairpersons); payment-method breakdown per service
// (Cash with a denomination counting sheet / Cheque rows / MoMo / Bank
// transfer rows / IOU / Forex) that must reconcile to the streams total; IOU register with
// automatic reminders; outflows (expenses); announcement PDF per fundraising
// day with day-borns ranked highest-first.
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { activeUsers } = require('../utils/accountStatus');
const { requireAuth, requirePermission } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { notifyUser } = require('../utils/approvalNotify');
const { buildAnnouncementPdf, buildStatementPdf, buildCountingSheetPdf, buildBasketSheetsPdf, buildDaySummaryPdf } = require('../utils/fundraisingPdf');
const fs = require('fs');
const path = require('path');
const push = require('../utils/push');

const DAYBORN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Seed contributions: at the launch the leadership pledges a lead gift to
// encourage the congregation. The money may arrive earlier, but it is booked
// against the fundraising day it was made available for, attributed to the
// body that gave it. The sub-categories are configurable per year.
const SEED_DEFAULT = ['Harvest Committee', 'Session', 'Congregation'];
const SEED_MAX = 16;

// Cash counting sheet — Ghana cedi denominations. Keys are stable ids so the
// GH2 note and the GH2 coin (and the GH1 note / GH1 coin) never collide.
const DENOMS = [
  { key: 'n200', label: 'GHS 200 note', value: 200, kind: 'note' },
  { key: 'n100', label: 'GHS 100 note', value: 100, kind: 'note' },
  { key: 'n50', label: 'GHS 50 note', value: 50, kind: 'note' },
  { key: 'n20', label: 'GHS 20 note', value: 20, kind: 'note' },
  { key: 'n10', label: 'GHS 10 note', value: 10, kind: 'note' },
  { key: 'n5', label: 'GHS 5 note', value: 5, kind: 'note' },
  { key: 'n2', label: 'GHS 2 note', value: 2, kind: 'note' },
  { key: 'n1', label: 'GHS 1 note', value: 1, kind: 'note' },
  { key: 'c2', label: 'GHS 2 coin', value: 2, kind: 'coin' },
  { key: 'c1', label: 'GHS 1 coin', value: 1, kind: 'coin' },
  { key: 'c50', label: '50 pesewas', value: 0.5, kind: 'coin' },
  { key: 'c20', label: '20 pesewas', value: 0.2, kind: 'coin' },
  { key: 'c10', label: '10 pesewas', value: 0.1, kind: 'coin' },
  { key: 'c5', label: '5 pesewas', value: 0.05, kind: 'coin' },
  { key: 'c1p', label: '1 pesewa', value: 0.01, kind: 'coin' },
];

// A seed sub-category name doubles as an object key and a DOM attribute value,
// so keep it plain.
function cleanSeedName(v) {
  return String(v == null ? '' : v).replace(/["'.<>\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}
function seedCats(year) {
  const meta = db.findOne('fundraising_meta', m => m.year === Number(year));
  const list = meta && Array.isArray(meta.seedCategories) ? meta.seedCategories.map(cleanSeedName).filter(Boolean) : [];
  return list.length ? list : SEED_DEFAULT.slice();
}
// ---- Harvest week activities ----------------------------------------------
// A fifth giving area, for the money the week's own activities bring in — the
// health walk, the bazaar, a games night. It is neither the Sunday offering nor
// the seed the leadership pledged at the launch, so it is counted on its own
// and reported on its own line.
//
// Configurable per year and per activity, exactly like seed, because the
// week's programme changes every year. Nothing is defaulted: a congregation
// that runs no activities should see no rows, and one that runs six should not
// be stuck with three.
function activityCats(year) {
  const meta = db.findOne('fundraising_meta', m => m.year === Number(year));
  return meta && Array.isArray(meta.activityCategories)
    ? [...new Set(meta.activityCategories.map(cleanSeedName).filter(Boolean))]
    : [];
}

const { actor } = require('../utils/scope');
function canView(req) {
  if (['admin','localadmin'].includes(req.user.role)) return true;
  const u = db.findById('users', req.user.id) || {};
  return (u.permissions || []).includes('fundraising.manage') || (u.permissions || []).includes('finance.quarterly') || (u.permissions || []).includes('fundraising.verify') || (u.permissions || []).includes('fundraising.approve') || (u.permissions || []).includes('approvals.manage') || (u.permissions || []).includes('congregation.view');
}
// Two-level sign-off: the Accounts Clerk VERIFIES (level 1), then the
// Treasurer APPROVES & locks (level 2). Harvest cannot sign off its own
// figures. Admin can act at either level.
function canVerify(req) {
  if (['admin','localadmin'].includes(req.user.role)) return true;
  const u = db.findById('users', req.user.id) || {};
  return (u.permissions || []).includes('fundraising.verify');
}
function canApprove(req) {
  if (['admin','localadmin'].includes(req.user.role)) return true;
  const u = db.findById('users', req.user.id) || {};
  return (u.permissions || []).includes('fundraising.approve');
}
function canMarkPaid(req) {
  const u = db.findById('users', req.user.id) || {};
  return ['admin','localadmin'].includes(req.user.role)
    || (u.permissions || []).includes('fundraising.manage')
    || (u.permissions || []).includes('fundraising.verify')
    || (u.permissions || []).includes('fundraising.approve');
}
const manage = [requireAuth, requirePermission('fundraising.manage')];
function n(v) { return v === '' || v === null || v === undefined ? 0 : Number(v) || 0; }
function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }
function seedTotal(cats) {
  return Object.values((cats || {}).seed || {}).reduce((s, v) => s + n(v), 0);
}
function activityTotal(cats) {
  return Object.values((cats || {}).activities || {}).reduce((s, v) => s + n(v), 0);
}
// Special sheets (22 Nov 2026): a named basket added on the day for something
// that came up — stored under categories.special[name], key 'special.<name>'.
function specialTotal(cats) {
  return Object.values((cats || {}).special || {}).reduce((s, v) => s + n(v), 0);
}
function entryTotal(cats) {
  return n(cats.gratitude) + n(cats.chairpersons)
    + DAYBORN.reduce((s, d) => s + n((cats.dayborn || {})[d]), 0)
    + seedTotal(cats) + activityTotal(cats) + specialTotal(cats);
}

// ---- Notification fan-out (best-effort, never blocks the action) ----
// Holders of a permission; falls back to admins when nobody holds it yet.
function notifyHolders(perm, subject, text, excludeUserId) {
  let list = activeUsers(u => (u.permissions || []).includes(perm));
  if (!list.length) list = activeUsers(u => ['admin', 'localadmin'].includes(u.role));
  list.filter(u => Number(u.id) !== Number(excludeUserId)).forEach(u => notifyUser(u, subject, text));
}
// Level-1 notice. The Treasurer now holds the verify right as a fallback, but
// the "awaiting verification" nudge belongs to the Accounts Clerk — the
// Treasurer is only pulled in when nobody else holds it.
function notifyVerifiers(subject, text, excludeUserId) {
  let list = activeUsers(u => (u.permissions || []).includes('fundraising.verify') && u.role !== 'treasurer');
  if (!list.length) list = activeUsers(u => (u.permissions || []).includes('fundraising.verify'));
  if (!list.length) list = activeUsers(u => ['admin', 'localadmin'].includes(u.role));
  list.filter(u => Number(u.id) !== Number(excludeUserId)).forEach(u => notifyUser(u, subject, text));
}
// Whoever entered the figures for these entries (approved / declined push).
function notifyEnterers(entries, subject, text) {
  const ids = [...new Set(entries.map(e => e.enteredById).filter(Boolean))];
  ids.forEach(id => { const u = db.findById('users', id); if (u) notifyUser(u, subject, text); });
}

// ---- Payment methods / forex / IOU normalisation ----
function normMethods(m) {
  const src = m || {};
  return { cash: r2(n(src.cash)), cheque: r2(n(src.cheque)), momo: r2(n(src.momo)), transfer: r2(n(src.transfer)) };
}
// Cash counting sheet: quantity per denomination -> GHS.
function normCashCount(o) {
  const src = o || {};
  const out = {};
  DENOMS.forEach(d => {
    const q = Math.floor(n(src[d.key]));
    if (q > 0) out[d.key] = q;
  });
  return out;
}
function cashCountTotal(counts) {
  return r2(DENOMS.reduce((s, d) => s + (Number(counts[d.key]) || 0) * d.value, 0));
}
// ---- Category keys ----
// Every giving basket has a stable key: 'seed.<body>', 'gratitude',
// 'dayborn.<Day>' or 'chairpersons'. A basket can be counted on its own, so
// each one may carry its own payment breakdown.
function catKeys(year) {
  return [
    ...seedCats(year).map(x => 'seed.' + x),
    'gratitude',
    ...DAYBORN.map(d => 'dayborn.' + d),
    'chairpersons',
    ...activityCats(year).map(x => 'activity.' + x),
  ];
}
function catLabel(key) {
  if (key.startsWith('seed.')) return 'Seed — ' + key.slice(5);
  if (key.startsWith('activity.')) return 'Harvest Week — ' + key.slice(9);
  if (key.startsWith('special.')) return key.slice(8);
  if (key.startsWith('dayborn.')) return key.slice(8) + '-borns';
  if (key === 'gratitude') return 'Gratitude & Thanksgiving';
  if (key === 'chairpersons') return 'Chairpersons & Co-chairpersons';
  return key;
}
// The reader that matches setCatAmount below.
function catAmountOf(categories, key) {
  const c = categories || {};
  if (key.startsWith('seed.')) return n((c.seed || {})[key.slice(5)]);
  if (key.startsWith('activity.')) return n((c.activities || {})[key.slice(9)]);
  if (key.startsWith('special.')) return n((c.special || {})[key.slice(8)]);
  if (key.startsWith('dayborn.')) return n((c.dayborn || {})[key.slice(8)]);
  return n(c[key]);
}
function setCatAmount(categories, key, value) {
  if (key.startsWith('seed.')) categories.seed[key.slice(5)] = value;
  else if (key.startsWith('special.')) {
    if (!categories.special) categories.special = {};
    categories.special[key.slice(8)] = value;
  } else if (key.startsWith('activity.')) {
    if (!categories.activities) categories.activities = {};
    categories.activities[key.slice(9)] = value;
  } else if (key.startsWith('dayborn.')) categories.dayborn[key.slice(8)] = value;
  else categories[key] = value;
}

// Cheques: one row per cheque received, so the Treasurer can tie each one to
// the bank statement.
function normCheques(list) {
  return (Array.isArray(list) ? list : [])
    .map(c => {
      // Drawer = the name on the cheque, as the paper sheet asks (kept only when given).
      const drawer = String(c.drawer || '').trim().slice(0, 80);
      return {
        number: String(c.number || '').trim().slice(0, 40),
        bank: String(c.bank || '').trim().slice(0, 80),
        ...(drawer ? { drawer } : {}),
        amount: r2(n(c.amount)),
      };
    })
    .filter(c => c.amount > 0 || c.number);
}
// Bank transfers: bank + transaction reference + amount.
function normTransfers(list) {
  return (Array.isArray(list) ? list : [])
    .map(t => ({
      bank: String(t.bank || '').trim().slice(0, 80),
      reference: String(t.reference || '').trim().slice(0, 60),
      amount: r2(n(t.amount)),
    }))
    .filter(t => t.amount > 0 || t.reference);
}
// The RATE belongs to the day — the dollar does not have one rate in the
// Sunday-borns basket and another in Gratitude. Rates are declared once at the
// top of the entry; each basket only records how much foreign money was in it.
function normRates(list) {
  return (Array.isArray(list) ? list : [])
    .map(x => ({ currency: String(x.currency || '').trim().toUpperCase().slice(0, 8), rate: Number(x.rate) || 0 }))
    .filter(x => x.currency && x.rate > 0)
    .filter((x, i, a) => a.findIndex(y => y.currency === x.currency) === i);
}
function rateFor(rates, cur, fallback) {
  const hit = rates.find(x => x.currency === cur);
  return hit ? hit.rate : (Number(fallback) || 0);
}
// Foreign amounts, converted at the day's rate. A row whose currency has no
// rate is reported rather than silently dropped.
function normForex(list, rates) {
  const rows = (Array.isArray(list) ? list : [])
    .map(f => {
      const currency = String(f.currency || '').trim().toUpperCase().slice(0, 8);
      const amount = r2(n(f.amount));
      const rate = rateFor(rates || [], currency, f.rate);
      return { currency, amount, rate, ghs: r2(amount * rate) };
    })
    .filter(f => f.currency && f.amount > 0);
  return rows;
}
function forexRateError(rows, where) {
  const bad = (rows || []).find(f => !(f.rate > 0));
  if (!bad) return null;
  return `No exchange rate for ${bad.currency}${where ? ` (${where})` : ''} — add it under “Today’s rates”.`;
}
function normIous(list) {
  return (Array.isArray(list) ? list : [])
    .map(i => ({
      name: String(i.name || '').trim(),
      contact: String(i.contact || '').trim(),
      amount: r2(n(i.amount)),
      dueDate: String(i.dueDate || '').slice(0, 10),
    }))
    .filter(i => i.name && i.amount > 0);
}

// One basket's own payment breakdown: cash (typed or counted), MoMo, cheques
// and bank transfers. When a basket carries a breakdown, its breakdown total
// IS its amount — the counting sheet is the source of truth, not a typed
// figure. IOUs and forex stay at service level: they attach to a named person
// or a currency, not to a basket.
function normCatMethods(src, valid, rates) {
  const out = {};
  Object.entries(src || {}).forEach(([key, v]) => {
    if (!valid.includes(key) || !v || typeof v !== 'object') return;
    const cashCount = normCashCount(v.cashCount);
    const counted = cashCountTotal(cashCount);
    const hasCount = Object.keys(cashCount).length > 0;
    const cash = hasCount ? counted : r2(n(v.cash));
    const momo = r2(n(v.momo));
    const cheques = normCheques(v.cheques);
    const transfers = normTransfers(v.transfers);
    const forex = normForex(v.forex, rates);
    const ious = normIous(v.ious);
    if (!hasCount && !cash && !momo && !cheques.length && !transfers.length && !forex.length && !ious.length) return;
    const chequeTotal = r2(cheques.reduce((a, q) => a + q.amount, 0));
    const transferTotal = r2(transfers.reduce((a, t) => a + t.amount, 0));
    const forexGhs = r2(forex.reduce((a, f) => a + f.ghs, 0));
    const iouTotal = r2(ious.reduce((a, i) => a + i.amount, 0));
    out[key] = {
      cash, momo, cashCount, cashCounted: counted, cheques, transfers, forex, ious,
      chequeTotal, transferTotal, forexGhs, iouTotal,
      total: r2(cash + momo + chequeTotal + transferTotal + forexGhs + iouTotal),
    };
  });
  return out;
}
// Cheque numbers and transfer banks are what tie a row to the bank statement,
// so both are required wherever the row was entered.
function validateRows(cheques, transfers, where) {
  const at = where ? ` (${where})` : '';
  const badCheque = cheques.find(q => !q.number);
  if (badCheque) return `A cheque of GHS ${badCheque.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}${at} has no cheque number.`;
  const zeroCheque = cheques.find(q => !(q.amount > 0));
  if (zeroCheque) return `Cheque ${zeroCheque.number}${at}: enter the amount.`;
  const badTransfer = transfers.find(t => !t.bank);
  if (badTransfer) return `A bank transfer of GHS ${badTransfer.amount.toLocaleString(undefined, { minimumFractionDigits: 2 })}${at} has no bank.`;
  const zeroTransfer = transfers.find(t => !(t.amount > 0));
  if (zeroTransfer) return `Bank transfer from ${zeroTransfer.bank}${at}: enter the amount.`;
  return null;
}

router.get('/overview', requireAuth, (req, res) => {
  if (!canView(req)) return res.status(403).json({ error: 'This module belongs to the Harvest Committee.' });
  const year = Number(req.query.year) || new Date().getFullYear();
  const events = db.findAll('fundraising_events', e => e.year === year).sort((a, b) => a.order - b.order);
  const entries = db.findAll('fundraising_entries', e => e.year === year);
  const expenses = db.findAll('fundraising_expenses', e => e.year === year);
  const ious = db.findAll('fundraising_ious', i => i.year === year);
  const meta = db.findOne('fundraising_meta', m => m.year === year) || { annualTarget: null };
  const perEvent = events.map(ev => {
    const evEntries = entries.filter(e => e.eventId === ev.id);
    const raised = evEntries.reduce((s, e) => s + (e.total || 0), 0);
    const spent = expenses.filter(x => x.eventId === ev.id).reduce((s, x) => s + (x.amount || 0), 0);
    return { ...ev, raised, spent, net: raised - spent };
  });
  res.json({
    year, events: perEvent, entries, expenses, ious,
    days: db.findAll('fundraising_days', d => d.year === year),
    annualTarget: meta.annualTarget,
    seedCategories: seedCats(year),
    activityCategories: activityCats(year),
    denominations: DENOMS,
    categoryKeys: catKeys(year),
    totalRaised: perEvent.reduce((s, e) => s + e.raised, 0),
    totalSpent: perEvent.reduce((s, e) => s + e.spent, 0),
    iouOutstanding: ious.filter(i => i.status !== 'paid').reduce((s, i) => s + (i.amount || 0), 0),
  });
});

router.put('/targets', ...manage, (req, res) => {
  const year = Number(req.body.year) || new Date().getFullYear();
  if (req.body.annualTarget !== undefined) {
    const meta = db.findOne('fundraising_meta', m => m.year === year);
    if (meta) db.update('fundraising_meta', meta.id, { annualTarget: n(req.body.annualTarget) || null });
    else db.insert('fundraising_meta', { year, annualTarget: n(req.body.annualTarget) || null });
  }
  (req.body.eventTargets || []).forEach(t => {
    const ev = db.findById('fundraising_events', Number(t.id));
    if (ev) db.update('fundraising_events', ev.id, { target: n(t.target) || null });
  });
  logActivity({ ...actor(req), action: 'Updated fundraising targets', entityType: 'fundraising', entityId: year, entityLabel: String(year) });
  res.json({ ok: true });
});

// Seed contribution sub-categories for the year (who the lead gift came from).
// A sub-category that already carries figures cannot be dropped.
router.put('/seed-categories', ...manage, (req, res) => {
  const year = Number(req.body.year) || new Date().getFullYear();
  const incoming = (Array.isArray(req.body.categories) ? req.body.categories : []).map(cleanSeedName).filter(Boolean);
  const list = [...new Set(incoming)];
  if (!list.length) return res.status(400).json({ error: 'Keep at least one seed sub-category.' });
  if (list.length > SEED_MAX) return res.status(400).json({ error: `At most ${SEED_MAX} seed sub-categories.` });
  const dropped = seedCats(year).filter(c => !list.includes(c));
  const inUse = dropped.filter(c => db.findAll('fundraising_entries', e => e.year === year)
    .some(e => n(((e.categories || {}).seed || {})[c]) > 0));
  if (inUse.length) {
    return res.status(400).json({ error: `${inUse.join(', ')} already carr${inUse.length > 1 ? 'y' : 'ies'} figures this year — zero them before removing.` });
  }
  const meta = db.findOne('fundraising_meta', m => m.year === year);
  if (meta) db.update('fundraising_meta', meta.id, { seedCategories: list });
  else db.insert('fundraising_meta', { year, annualTarget: null, seedCategories: list });
  logActivity({ ...actor(req), action: 'Updated seed contribution sub-categories', entityType: 'fundraising', entityId: year, entityLabel: list.join(', ') });
  res.json({ ok: true, seedCategories: list });
});

// The week's activities, per year. Unlike seed this may legitimately be EMPTY —
// a congregation that runs no activities should see no rows — so there is no
// "keep at least one" rule here.
router.put('/activity-categories', ...manage, (req, res) => {
  const year = Number(req.body.year) || new Date().getFullYear();
  const incoming = (Array.isArray(req.body.categories) ? req.body.categories : []).map(cleanSeedName).filter(Boolean);
  const list = [...new Set(incoming)];
  if (list.length > SEED_MAX) return res.status(400).json({ error: `At most ${SEED_MAX} harvest week activities.` });
  const dropped = activityCats(year).filter(c => !list.includes(c));
  const inUse = dropped.filter(c => db.findAll('fundraising_entries', e => e.year === year)
    .some(e => n(((e.categories || {}).activities || {})[c]) > 0));
  if (inUse.length) {
    return res.status(400).json({ error: `${inUse.join(', ')} already carr${inUse.length > 1 ? 'y' : 'ies'} figures this year — zero them before removing.` });
  }
  const meta = db.findOne('fundraising_meta', m => m.year === year);
  if (meta) db.update('fundraising_meta', meta.id, { activityCategories: list });
  else db.insert('fundraising_meta', { year, annualTarget: null, activityCategories: list });
  logActivity({ ...actor(req), action: 'Updated harvest week activities', entityType: 'fundraising', entityId: year, entityLabel: list.join(', ') || '(none)' });
  res.json({ ok: true, activityCategories: list });
});

router.post('/events', ...manage, (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Event name required.' });
  const year = Number(req.body.year) || new Date().getFullYear();
  const order = db.findAll('fundraising_events', e => e.year === year).length + 1;
  const rec = db.insert('fundraising_events', { year, name, target: n(req.body.target) || null, order });
  logActivity({ ...actor(req), action: 'Added fundraising event', entityType: 'fundraising', entityId: rec.id, entityLabel: name });
  res.json(rec);
});

// Rename an event / adjust its target.
router.put('/events/:id', ...manage, (req, res) => {
  const rec = db.findById('fundraising_events', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Event not found.' });
  const patch = {};
  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: 'Event name required.' });
    patch.name = name;
  }
  if (req.body.target !== undefined) patch.target = n(req.body.target) || null;
  const updated = db.update('fundraising_events', rec.id, patch);
  // Entries carry a denormalised eventName — keep them in step after a rename.
  if (patch.name) {
    db.findAll('fundraising_entries', e => e.eventId === rec.id).forEach(e => db.update('fundraising_entries', e.id, { eventName: patch.name }));
    db.findAll('fundraising_expenses', e => e.eventId === rec.id).forEach(e => db.update('fundraising_expenses', e.id, { eventName: patch.name }));
  }
  logActivity({ ...actor(req), action: 'Updated fundraising event', entityType: 'fundraising', entityId: rec.id, entityLabel: updated.name });
  res.json(updated);
});

// Remove an event — only while it has no figures recorded against it.
router.delete('/events/:id', ...manage, (req, res) => {
  const rec = db.findById('fundraising_events', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Event not found.' });
  const entries = db.findAll('fundraising_entries', e => e.eventId === rec.id);
  const expenses = db.findAll('fundraising_expenses', e => e.eventId === rec.id);
  if (entries.length || expenses.length) {
    return res.status(400).json({ error: `This event has ${entries.length} entry(ies) and ${expenses.length} expense(s) recorded — it cannot be removed.` });
  }
  db.remove('fundraising_events', rec.id);
  logActivity({ ...actor(req), action: 'Removed fundraising event', entityType: 'fundraising', entityId: rec.id, entityLabel: rec.name, snapshot: rec });
  res.json({ ok: true });
});

// Inflow entry: one per event+date+service.
// Carries the giving STREAMS (gratitude, day-borns, chairpersons) and the
// payment METHODS (cash, cheque, momo, IOUs, forex). When any method figure
// is supplied, methods must reconcile with the streams total to the pesewa.
// Streams are recorded all-in GHS (forex converted at the given rates), so:
//   streams total = cash + cheque + momo + IOU total + Σ(forex amount × rate)
// The whole computation of an entry, in one place, because there are now two
// ways in: the whole-day form (`PUT /entries`) and one basket at a time
// (`PUT /entries/basket`). Two copies of this arithmetic would have drifted
// inside a month, and it is the money path.
//
// Returns `{ error }`, or `{ payload, iousLive, total, methodsTotal, diff }`.
// `enforceRecon` is the only behavioural difference between the callers: the
// whole-day save refuses figures that do not reconcile, a per-basket save
// cannot — a half-counted day legitimately does not balance, so that gate
// lives at submit instead.
function buildEntry(ev, body, existing, req, opts = {}) {
  const service = body.service;
  const date = body.date;
  const c = body.categories || {};
  // Seed sub-categories: this year's configured list, plus any legacy name that
  // still carries a figure so historic entries never lose money on a re-save.
  const seedIn = c.seed || {};
  const seedKeys = seedCats(ev.year);
  const seedAll = [...new Set([...seedKeys, ...Object.keys(seedIn).map(cleanSeedName).filter(Boolean)])];
  // Same rule for the week's activities: this year's configured list, plus any
  // name that still carries a figure, so a re-save after the programme changed
  // never loses money.
  const actIn = c.activities || {};
  const actKeys = activityCats(ev.year);
  const actAll = [...new Set([...actKeys, ...Object.keys(actIn).map(cleanSeedName).filter(Boolean)])];
  const categories = {
    seed: Object.fromEntries(seedAll
      .map(k => [k, n(seedIn[k])])
      .filter(([k, v]) => seedKeys.includes(k) || v > 0)),
    gratitude: n(c.gratitude),
    chairpersons: n(c.chairpersons),
    dayborn: Object.fromEntries(DAYBORN.map(d => [d, n((c.dayborn || {})[d])])),
    activities: Object.fromEntries(actAll
      .map(k => [k, n(actIn[k])])
      .filter(([k, v]) => actKeys.includes(k) || v > 0)),
    // Special sheets: a form that doesn't carry them (the totals form) keeps
    // what is stored, so editing the day's totals never drops their money.
    special: Object.fromEntries(Object.entries(c.special !== undefined ? (c.special || {})
      : ((existing && existing.categories && existing.categories.special) || {}))
      .map(([k, v]) => [cleanSeedName(k), n(v)]).filter(([k, v]) => k && v > 0)),
  };

  // ---- Per-basket breakdowns ----
  // A basket that was counted on its own has its amount REPLACED by what the
  // count says. A basket left without a breakdown keeps its typed figure and is
  // covered by the service-level method figures below.
  const rates = normRates(body.rates);
  const validKeys = [...new Set([...catKeys(ev.year),
    ...Object.keys(categories.seed).map(k => 'seed.' + k),
    ...Object.keys(categories.activities).map(k => 'activity.' + k),
    ...Object.keys(categories.special).map(k => 'special.' + k),
    ...Object.keys(body.catMethods || {}).filter(k => k.startsWith('special.') && cleanSeedName(k.slice(8)))])];
  // The totals form doesn't send per-basket counts for special sheets: keep them.
  if (c.special === undefined && existing && existing.catMethods) {
    body.catMethods = { ...(body.catMethods || {}) };
    Object.entries(existing.catMethods).forEach(([k, v]) => { if (k.startsWith('special.') && !body.catMethods[k]) body.catMethods[k] = v; });
  }
  const catMethods = normCatMethods(body.catMethods, validKeys, rates);
  Object.entries(catMethods).forEach(([key, bd]) => setCatAmount(categories, key, bd.total));
  const total = r2(entryTotal(categories));

  // ---- Service-level methods (money not attributed to one basket) ----
  const direct = normMethods(body.methods);
  const directCashCount = normCashCount(body.cashCount);
  if (Object.keys(directCashCount).length) direct.cash = cashCountTotal(directCashCount);
  const directCheques = normCheques(body.cheques);
  const directTransfers = normTransfers(body.transfers);
  const rowError = validateRows(directCheques, directTransfers, '')
    || Object.entries(catMethods).reduce((err, [key, bd]) => err || validateRows(bd.cheques, bd.transfers, catLabel(key)), null);
  if (rowError) return { error: rowError };
  direct.cheque = r2(directCheques.reduce((s, q) => s + q.amount, 0));
  direct.transfer = r2(directTransfers.reduce((s, t) => s + t.amount, 0));
  const methodsDirect = { ...direct, cashCount: directCashCount, cheques: directCheques, transfers: directTransfers };

  // ---- Combined view: what the day actually received, however it was entered.
  // Everything downstream (reconciliation, results, PDFs) reads these.
  const cats = Object.values(catMethods);
  const cashCount = { ...directCashCount };
  cats.forEach(bd => Object.entries(bd.cashCount).forEach(([k, q]) => { cashCount[k] = (cashCount[k] || 0) + q; }));
  const cashCounted = cashCountTotal(cashCount);
  const cheques = [
    ...directCheques.map(q => ({ ...q, category: '' })),
    ...Object.entries(catMethods).flatMap(([key, bd]) => bd.cheques.map(q => ({ ...q, category: catLabel(key) }))),
  ];
  const transfers = [
    ...directTransfers.map(t => ({ ...t, category: '' })),
    ...Object.entries(catMethods).flatMap(([key, bd]) => bd.transfers.map(t => ({ ...t, category: catLabel(key) }))),
  ];
  const methods = {
    cash: r2(direct.cash + cats.reduce((s, bd) => s + bd.cash, 0)),
    momo: r2(direct.momo + cats.reduce((s, bd) => s + bd.momo, 0)),
    cheque: r2(cheques.reduce((s, q) => s + q.amount, 0)),
    transfer: r2(transfers.reduce((s, t) => s + t.amount, 0)),
  };
  // Foreign currency and IOUs: entered inside a basket where they belong to
  // one, at service level where they do not. Both lists are merged so the
  // reconciliation, the register and the reports see the whole day.
  const directForex = normForex(body.forex, rates);
  const forex = [
    ...directForex.map(f => ({ ...f, category: '' })),
    ...Object.entries(catMethods).flatMap(([key, bd]) => bd.forex.map(f => ({ ...f, category: catLabel(key) }))),
  ];
  const rateErr = forexRateError(directForex, '')
    || Object.entries(catMethods).reduce((err, [key, bd]) => err || forexRateError(bd.forex, catLabel(key)), null);
  if (rateErr) return { error: rateErr };
  const forexGhs = r2(forex.reduce((s, f) => s + f.ghs, 0));

  const directIous = normIous(body.ious);
  const iousIn = [
    ...directIous.map(i => ({ ...i, category: '' })),
    ...Object.entries(catMethods).flatMap(([key, bd]) => bd.ious.map(i => ({ ...i, category: catLabel(key) }))),
  ];
  const badIou = iousIn.find(i => !i.dueDate);
  if (badIou) return { error: `IOU for ${badIou.name}: a proposed payment date is required (it drives the reminders).` };

  // IOUs already marked PAID on this entry stay on the register untouched;
  // the request only carries the still-editable (unpaid) ones.
  const paidIous = existing ? db.findAll('fundraising_ious', x => x.entryId === existing.id && x.status === 'paid') : [];
  // A pledge already redeemed is counted through the register. If the form sent
  // it back (a stale tab, or a basket breakdown saved before it was paid), drop
  // it here rather than counting the same money twice.
  const iousLive = iousIn.filter(i => !paidIous.some(x =>
    x.name === i.name && Number(x.amount) === Number(i.amount) && (x.dueDate || '') === (i.dueDate || '')));
  const iouTotal = r2(iousLive.reduce((s, i) => s + i.amount, 0) + paidIous.reduce((s, i) => s + (i.amount || 0), 0));

  const methodsTotal = r2(methods.cash + methods.cheque + methods.momo + methods.transfer + iouTotal + forexGhs);
  const diff = r2(total - methodsTotal);
  if (opts.enforceRecon && methodsTotal > 0 && Math.abs(diff) > 0.01) {
    return { error: `Methods do not reconcile: streams total GHS ${total.toLocaleString(undefined,{minimumFractionDigits:2})} vs methods total GHS ${methodsTotal.toLocaleString(undefined,{minimumFractionDigits:2})} (${diff > 0 ? 'short' : 'over'} by GHS ${Math.abs(diff).toLocaleString(undefined,{minimumFractionDigits:2})}).` };
  }

  const who = actor(req);
  const payload = {
    eventId: ev.id, eventName: ev.name, year: ev.year, date, service, categories, total,
    methods, methodsDirect, catMethods, rates, cashCount, cashCounted, cheques, transfers, forex, forexGhs, iouTotal,
    ghsSubtotal: r2(methods.cash + methods.cheque + methods.momo + methods.transfer + iouTotal),
    enteredBy: who.userName, enteredById: who.userId,
    status: existing ? existing.status : 'pending',
  };
  if (['admin','localadmin'].includes(req.user.role) && existing && existing.status === 'confirmed') payload.status = 'confirmed';
  return { payload, iousLive, total, methodsTotal, diff, who };
}

// Guards shared by both ways in.
function dayShapeError(ev, date, service) {
  // A fundraising day is EITHER joint OR dual (1st+2nd) — never both. Once the
  // day is set up (fundraising_days), its shape decides.
  const rec = dayRecord(ev.id, date);
  if (rec && rec.shape === 'joint' && service !== 'joint') return 'This day is set up as a joint service. Change it to 1st and 2nd service first (Record fundraising day → Services).';
  if (rec && rec.shape === 'dual' && service === 'joint') return 'This day is set up as 1st and 2nd service. Change it to a joint service first (Record fundraising day → Services).';
  const sameDay = db.findAll('fundraising_entries', e => e.eventId === ev.id && e.date === date);
  if (service === 'joint' && sameDay.some(e => e.service !== 'joint')) {
    return 'This date already has 1st/2nd service entries. Delete them first if the day was actually joint.';
  }
  if (service !== 'joint' && sameDay.some(e => e.service === 'joint')) {
    return 'This date already has a joint entry. Delete it first if the day actually had two services.';
  }
  return null;
}
function lockedError(existing, req) {
  if (existing && existing.status && existing.status !== 'pending' && req.user.role !== 'admin') {
    return existing.status === 'verified'
      ? 'These figures have been verified by the Accounts Clerk — no more edits. Ask an admin to unlock.'
      : 'These figures are approved and locked. Ask an admin to unlock.';
  }
  return null;
}
// Writes the entry and re-syncs its unpaid pledges.
function persistEntry(ev, built, existing) {
  const rec = existing
    ? db.update('fundraising_entries', existing.id, built.payload)
    : db.insert('fundraising_entries', built.payload);
  db.findAll('fundraising_ious', x => x.entryId === rec.id && x.status !== 'paid')
    .forEach(x => db.remove('fundraising_ious', x.id));
  built.iousLive.forEach(i => db.insert('fundraising_ious', {
    entryId: rec.id, eventId: ev.id, eventName: ev.name, year: ev.year,
    date: built.payload.date, service: built.payload.service,
    name: i.name, contact: i.contact, amount: i.amount, dueDate: i.dueDate, category: i.category || '',
    status: 'outstanding', enteredBy: built.who.userName, createdAt: new Date().toISOString(),
  }));
  return rec;
}

router.put('/entries', ...manage, (req, res) => {
  const { eventId, date, service } = req.body;
  const ev = db.findById('fundraising_events', Number(eventId));
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  if (!date || !['1st', '2nd', 'joint'].includes(service)) return res.status(400).json({ error: 'Date and service (1st/2nd/joint) required.' });
  const shape = dayShapeError(ev, date, service);
  if (shape) return res.status(400).json({ error: shape });
  const existing = db.findOne('fundraising_entries', e => e.eventId === ev.id && e.date === date && e.service === service);
  const locked = lockedError(existing, req);
  if (locked) return res.status(423).json({ error: locked });
  // The whole-day form carries every basket. If anything was saved to this
  // service after the form was opened (a sheet typed at another desk, a basket
  // saved on its own), saving the form would put the old figures back over it.
  if (existing && req.body.baseUpdatedAt !== undefined && (existing.updatedAt || existing.createdAt || null) !== (req.body.baseUpdatedAt || null)) {
    return res.status(409).json({ error: `Figures for the ${service === 'joint' ? 'joint' : service} service were saved by someone else after you opened this form. Close it and open the day again, so nothing they entered is overwritten.` });
  }

  const built = buildEntry(ev, req.body, existing, req, { enforceRecon: true });
  if (built.error) return res.status(400).json({ error: built.error });
  const rec = persistEntry(ev, built, existing);
  ensureDay(ev, date, service, req);
  logActivity({ ...built.who, action: 'Recorded fundraising inflows', entityType: 'fundraising', entityId: rec.id, entityLabel: `${ev.name} ${date} ${built.payload.service} — GHS ${built.total.toLocaleString()}` });
  res.json(rec);
});

// ---- One basket at a time ---------------------------------------------------
// The counting happens basket by basket: the Gratitude offering, the
// Chairpersons, then the day-borns one day at a time. Holding all of it until a
// single save at the end meant a mistake surfaced at the end too, as an error
// about the whole service rather than about the basket that was wrong.
//
// This takes ONE basket, merges it into whatever the day already has, and
// answers about that basket. Everything else on the entry is read back from
// storage and passed through untouched, so the merge cannot quietly drop the
// baskets already counted.
//
// A basket counted in its own panel reconciles on its own — its figure IS its
// breakdown total. A basket typed without a breakdown has no methods of its
// own; it is covered by the service-level figures, so there is nothing to check
// at this grain and the reply says so rather than implying a clean bill.
router.put('/entries/basket', ...manage, (req, res) => {
  const { eventId, date, service, key } = req.body;
  const ev = db.findById('fundraising_events', Number(eventId));
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  if (!date || !['1st', '2nd', 'joint'].includes(service)) return res.status(400).json({ error: 'Date and service (1st/2nd/joint) required.' });
  const shape = dayShapeError(ev, date, service);
  if (shape) return res.status(400).json({ error: shape });

  const existing = db.findOne('fundraising_entries', e => e.eventId === ev.id && e.date === date && e.service === service);
  const locked = lockedError(existing, req);
  if (locked) return res.status(423).json({ error: locked });

  const validKeys = [...new Set([
    ...catKeys(ev.year),
    ...Object.keys((existing && existing.categories && existing.categories.seed) || {}).map(k => 'seed.' + k),
    ...Object.keys((existing && existing.categories && existing.categories.activities) || {}).map(k => 'activity.' + k),
    ...Object.keys((existing && existing.categories && existing.categories.special) || {}).map(k => 'special.' + k),
    ...((dayRecord(ev.id, date) || {}).extras || []).filter(x => x.service === service).map(x => 'special.' + x.name),
  ])];
  if (!validKeys.includes(key)) return res.status(400).json({ error: `"${key}" is not a basket on this day.` });

  // The stored entry, put back into the shape the form sends. `methodsDirect`
  // is the service-level part — using `methods` here would count every basket
  // twice.
  const prev = existing || {};
  const md = prev.methodsDirect || {};
  const body = {
    date, service,
    categories: JSON.parse(JSON.stringify(prev.categories || { seed: {}, dayborn: {} })),
    methods: { cash: md.cash || 0, momo: md.momo || 0 },
    cashCount: md.cashCount || {},
    cheques: md.cheques || [],
    transfers: md.transfers || [],
    catMethods: JSON.parse(JSON.stringify(prev.catMethods || {})),
    rates: prev.rates || req.body.rates || [],
    forex: (prev.forex || []).filter(f => !f.category),
    // Only the still-editable service-level pledges; paid ones live on the
    // register and buildEntry re-adds them.
    ious: existing
      ? db.findAll('fundraising_ious', x => x.entryId === existing.id && x.status === 'outstanding' && !x.category)
        .map(x => ({ name: x.name, contact: x.contact, amount: x.amount, dueDate: x.dueDate }))
      : [],
  };
  // The day's rates may have been declared in this sitting before anything was
  // saved, so a rate table on the request wins.
  if (Array.isArray(req.body.rates) && req.body.rates.length) body.rates = req.body.rates;

  // ---- Merge this one basket ----
  const bd = req.body.breakdown;
  const counted = !!bd && typeof bd === 'object';
  if (counted) body.catMethods[key] = bd;
  else {
    delete body.catMethods[key];
    setCatAmount(body.categories, key, n(req.body.amount));
  }
  if (!body.categories.seed) body.categories.seed = {};
  if (!body.categories.dayborn) body.categories.dayborn = {};
  if (!body.categories.activities) body.categories.activities = {};
  if (!body.categories.special) body.categories.special = {};

  const built = buildEntry(ev, body, existing, req, { enforceRecon: false });
  if (built.error) return res.status(400).json({ error: built.error });
  const rec = persistEntry(ev, built, existing);
  ensureDay(ev, date, service, req);

  // ---- What to say about it ----
  const saved = (rec.catMethods || {})[key];
  const basketAmount = catAmountOf(rec.categories, key);
  const basket = counted
    ? {
      counted: true,
      // A counted basket's figure IS its breakdown, so this can only disagree
      // if the arithmetic is wrong — it is asserted, not assumed.
      reconciles: !!saved && Math.abs(r2(saved.total) - r2(basketAmount)) <= 0.01,
      amount: r2(basketAmount),
      breakdownTotal: saved ? r2(saved.total) : 0,
      parts: saved ? {
        cash: saved.cash, momo: saved.momo, cheque: saved.chequeTotal,
        transfer: saved.transferTotal, forex: saved.forexGhs, ious: saved.iouTotal,
      } : null,
    }
    : { counted: false, amount: r2(basketAmount), reconciles: null };

  // The day so far, so the Clerk can see where he is without a verdict that
  // reads as an error while the counting is still going on.
  const all = db.findAll('fundraising_entries', e => e.eventId === ev.id && e.date === date);
  const countedKeys = [...new Set(all.flatMap(e => Object.keys(e.catMethods || {})))];
  const withFigures = validKeys.filter(k => all.some(e => r2(catAmountOf(e.categories, k)) > 0));

  logActivity({ ...built.who, action: `Saved ${catLabel(key)}`, entityType: 'fundraising', entityId: rec.id,
    entityLabel: `${ev.name} ${date} ${service} — ${catLabel(key)} GHS ${r2(basketAmount).toLocaleString()}` });

  res.json({
    ok: true,
    key,
    label: catLabel(key),
    basket,
    day: {
      total: r2(all.reduce((a, e) => a + (e.total || 0), 0)),
      methodsTotal: built.methodsTotal,
      serviceTotal: built.total,
      diff: built.diff,
      balances: Math.abs(built.diff) <= 0.01,
      countedBaskets: countedKeys.length,
      basketsWithFigures: withFigures.length,
      baskets: validKeys.length,
    },
    entry: rec,
  });
});

// ---- Harvest basket sheets ---------------------------------------------------
// The paper-first flow (Harvest Committee, 17 Nov 2026): AOTC Track prints one
// numbered A4 sheet per basket per service, the counting team fills it in by
// hand, and the entry desk types each sheet in as soon as it arrives —
// several people at once, while the counting is still going on. A sheet is
// checked against its own written totals before it is saved, so a typing slip
// is caught at the desk and not at the end of the day.
//
// Numbering runs through the DAY, so no two sheets on one day share a number:
// a joint service is 01..N; a dual day is 01..N for the 1st service and
// N+1..2N for the 2nd. Seed is ONE sheet (the counter circles which body it
// came from); the entry desk picks the body.
const SHEET_PHOTO_DIR = path.join(db.DATA_DIR, 'fundraising-sheets');

// ---- The fundraising day (19 Nov 2026) ------------------------------------------
// As Sunday attendance does: the day is SET UP first — event, date, joint or
// 1st and 2nd service, and (if it has one) a target for the day — and
// everything follows from it: the sheets are printed for it, entered against
// it, tallied and reported for it. A day that already has figures from before
// this (no record) counts as set up, in the shape its figures have.
function dayRecord(eventId, date) {
  return db.findOne('fundraising_days', d => d.eventId === Number(eventId) && d.date === date) || null;
}
function daySetUp(ev, date) {
  return !!dayRecord(ev.id, date) || db.findAll('fundraising_entries', e => e.eventId === ev.id && e.date === date).length > 0;
}
// Figures typed in the totals form for a day nobody set up: the day is set up by
// the save, in the shape of the service saved (so it lists, prints and tallies
// like any other day).
function ensureDay(ev, date, service, req) {
  if (dayRecord(ev.id, date)) return;
  const who = actor(req);
  db.insert('fundraising_days', { eventId: ev.id, eventName: ev.name, year: ev.year, date, shape: service === 'joint' ? 'joint' : 'dual',
    target: null, status: 'open', setBy: who.userName, setById: who.userId, setAt: new Date().toISOString(), via: 'totals form' });
}
const NOT_SET_UP = 'Set up the day first: Record fundraising day → choose the event, date and services → Set up the day.';

router.post('/days', ...manage, (req, res) => {
  const ev = db.findById('fundraising_events', Number(req.body.eventId));
  const date = String(req.body.date || '').slice(0, 10);
  const shape = req.body.shape;
  if (!ev || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !['joint', 'dual'].includes(shape)) return res.status(400).json({ error: 'Event, date and services (joint, or 1st and 2nd) are required.' });
  const entries = db.findAll('fundraising_entries', e => e.eventId === ev.id && e.date === date);
  if (entries.some(e => e.status && e.status !== 'pending') && req.user.role !== 'admin') return res.status(423).json({ error: 'This day has been signed off and is locked.' });
  // Changing the shape after figures exist for the other shape would orphan them.
  const hasFigures = e => (e.total || 0) > 0 || Object.keys(e.sheets || {}).length > 0;
  if (shape === 'joint' && entries.some(e => e.service !== 'joint' && hasFigures(e))) return res.status(400).json({ error: 'This day already has 1st/2nd service figures. Delete them first if the day was actually joint.' });
  if (shape === 'dual' && entries.some(e => e.service === 'joint' && hasFigures(e))) return res.status(400).json({ error: 'This day already has joint-service figures. Delete them first if the day actually had two services.' });
  const who = actor(req);
  const existing = dayRecord(ev.id, date);
  const target = req.body.target === '' || req.body.target == null ? (existing ? existing.target || null : null) : (n(req.body.target) || null);
  const payload = { eventId: ev.id, eventName: ev.name, year: ev.year, date, shape, target, setBy: who.userName, setById: who.userId, setAt: new Date().toISOString() };
  const rec = existing ? db.update('fundraising_days', existing.id, payload) : db.insert('fundraising_days', { ...payload, status: 'open' });
  // Empty entries of the other shape (a photo-only start) go with the change.
  entries.filter(e => !hasFigures(e) && (shape === 'joint' ? e.service !== 'joint' : e.service === 'joint')).forEach(e => db.remove('fundraising_entries', e.id));
  logActivity({ ...who, action: existing ? 'Changed fundraising day' : 'Set up fundraising day', entityType: 'fundraising', entityId: rec.id,
    entityLabel: `${ev.name} ${date} (${shape === 'dual' ? '1st and 2nd service' : 'joint service'})${target ? ` — day target GHS ${target}` : ''}` });
  // The desk team: the day is ready for its sheets.
  try {
    const team = push.userIdsWithPermission('fundraising.manage').filter(id => id !== req.user.id);
    push.sendPushToUsers(team, {
      title: `${ev.name}: day set up`,
      body: `${date} — ${shape === 'dual' ? '1st and 2nd service' : 'joint service'}. Sheets can be printed and entered.`,
      url: '/fundraising.html', tag: `fr-day-${ev.id}-${date}`,
    }).catch(() => {});
  } catch (e) { /* notifications are best effort */ }
  res.json(rec);
});
// A day set up by mistake, with nothing recorded against it.
router.delete('/days', ...manage, (req, res) => {
  const ev = db.findById('fundraising_events', Number(req.query.eventId));
  const date = String(req.query.date || '').slice(0, 10);
  const rec = ev && dayRecord(ev.id, date);
  if (!rec) return res.status(404).json({ error: 'That day is not set up.' });
  const entries = db.findAll('fundraising_entries', e => e.eventId === ev.id && e.date === date);
  if (entries.some(e => (e.total || 0) > 0 || Object.keys(e.sheets || {}).length)) return res.status(400).json({ error: 'This day has figures or sheets. Delete those first.' });
  entries.forEach(e => db.remove('fundraising_entries', e.id));
  db.remove('fundraising_days', rec.id);
  logActivity({ ...actor(req), action: 'Removed fundraising day', entityType: 'fundraising', entityId: rec.id, entityLabel: `${ev.name} ${date}` });
  res.json({ ok: true });
});

// ---- Special sheets: "+ Add a sheet" (22 Nov 2026, per Gideon) ----
// "Something can always come up": the desk adds a sheet with a name, for one
// service of a set-up day. It prints, enters, tallies and reports like any
// basket, on its own line. Removing one is allowed only while nothing is saved
// on it.
router.post('/days/sheets', ...manage, (req, res) => {
  const ev = db.findById('fundraising_events', Number(req.body.eventId));
  const date = String(req.body.date || '').slice(0, 10);
  if (!ev || !date) return res.status(400).json({ error: 'Event and date are required.' });
  let rec = dayRecord(ev.id, date);
  // A day set up by its figures alone (no set-up record — entered before the
  // set-up step, or via the totals form) is set up: give it its record now,
  // in the shape its figures have (22 Nov 2026 — "+ Add a sheet" refused it).
  if (!rec && daySetUp(ev, date)) {
    const svcs = dayServices(ev, date);
    ensureDay(ev, date, svcs.includes('joint') ? 'joint' : '1st', req);
    rec = dayRecord(ev.id, date);
  }
  if (!rec) return res.status(400).json({ error: NOT_SET_UP });
  const services = rec.shape === 'dual' ? ['1st', '2nd'] : ['joint'];
  const service = services.length === 1 ? 'joint' : String(req.body.service || '');
  if (!services.includes(service)) return res.status(400).json({ error: 'Choose the service the sheet is for (1st or 2nd).' });
  const name = cleanSeedName(req.body.name).slice(0, 60);
  if (!name || name.length < 2) return res.status(400).json({ error: 'Give the sheet a name — what the money is for.' });
  const entries = db.findAll('fundraising_entries', e => e.eventId === ev.id && e.date === date);
  if (entries.some(e => e.status && e.status !== 'pending') && req.user.role !== 'admin') return res.status(423).json({ error: 'This day has been signed off and is locked.' });
  const taken = sheetBaskets(ev.year).map(b => b.label.toLowerCase());
  const extras = (rec.extras || []).slice();
  if (taken.includes(name.toLowerCase()) || extras.some(x => x.service === service && x.name.toLowerCase() === name.toLowerCase())) {
    return res.status(400).json({ error: `There is already a sheet called "${name}" for this service.` });
  }
  const who = actor(req);
  extras.push({ name, service, addedBy: who.userName, addedById: who.userId, at: new Date().toISOString() });
  db.update('fundraising_days', rec.id, { extras });
  const p = sheetPlan(ev, date).plan.find(x => x.special && x.service === service && x.label === name);
  logActivity({ ...who, action: `Added harvest sheet ${String(p.no).padStart(2, '0')} "${name}"`, entityType: 'fundraising', entityId: rec.id,
    entityLabel: `${ev.name} ${date} ${service}` });
  res.json({ ok: true, no: p.no, name, service });
});
router.delete('/days/sheets/:no', ...manage, (req, res) => {
  const ev = db.findById('fundraising_events', Number(req.query.eventId));
  const date = String(req.query.date || '').slice(0, 10);
  const rec = ev && dayRecord(ev.id, date);
  if (!rec) return res.status(404).json({ error: 'That day is not set up.' });
  const p = sheetPlan(ev, date).plan.find(x => x.no === Number(req.params.no));
  if (!p || !p.special) return res.status(400).json({ error: 'Only a sheet added on the day can be taken away; the regular sheets stay.' });
  const e = db.findOne('fundraising_entries', x => x.eventId === ev.id && x.date === date && x.service === p.service);
  const hit = recordFor(e, p);
  if (hit && (hit.bd || hit.amount > 0 || (hit.sheet && (hit.sheet.empty || hit.sheet.enteredBy)))) {
    return res.status(400).json({ error: `Sheet ${String(p.no).padStart(2, '0')} has figures saved. Use "Remove this sheet" on it first.` });
  }
  const extras = (rec.extras || []).filter(x => !(x.service === p.service && x.name === p.label));
  db.update('fundraising_days', rec.id, { extras });
  logActivity({ ...actor(req), action: `Took away harvest sheet "${p.label}"`, entityType: 'fundraising', entityId: rec.id, entityLabel: `${ev.name} ${date} ${p.service}` });
  res.json({ ok: true });
});

function sheetBaskets(year) {
  // Gratitude & Thanksgiving comes first in the service, so it is sheet 01
  // (Harvest Committee, 19 Nov 2026); then the day-borns, Chairpersons, Seed.
  return [
    { key: 'gratitude', label: 'Gratitude & Thanksgiving' },
    ...DAYBORN.map(d => ({ key: 'dayborn.' + d, label: d + '-borns' })),
    { key: 'chairpersons', label: 'Chairpersons & Co-chairpersons' },
    { key: 'seed', label: 'Seed contributions' },
    ...activityCats(year).map(a => ({ key: 'activity.' + a, label: 'Harvest Week — ' + a })),
  ];
}
// The services of a day: what is already recorded decides; otherwise the
// caller says (`dual` = 1st and 2nd).
function dayServices(ev, date, hint) {
  const rec = dayRecord(ev.id, date);
  if (rec) return rec.shape === 'dual' ? ['1st', '2nd'] : ['joint'];
  const have = [...new Set(db.findAll('fundraising_entries', e => e.eventId === ev.id && e.date === date).map(e => e.service))];
  if (have.includes('joint')) return ['joint'];
  if (have.length) return ['1st', '2nd'];
  return hint === 'dual' || hint === '1st' || hint === '2nd' ? ['1st', '2nd'] : ['joint'];
}
function sheetPlan(ev, date, hint) {
  const baskets = sheetBaskets(ev.year);
  const services = dayServices(ev, date, hint);
  const plan = [];
  services.forEach((service, si) => baskets.forEach((b, bi) => plan.push({
    no: si * baskets.length + bi + 1, service, key: b.key, label: b.label,
  })));
  // Special sheets added on the day come after every regular sheet, in the
  // order they were added — so no printed number ever moves.
  const rec = dayRecord(ev.id, date);
  ((rec && rec.extras) || []).filter(x => services.includes(x.service)).forEach(x => plan.push({
    no: plan.length + 1, service: x.service, key: 'special.' + x.name, label: x.name, special: true,
  }));
  return { services, plan, perService: baskets.length };
}
// The entry key a sheet's figures are stored under ('seed' becomes seed.<body>).
function sheetEntryKey(p, body, year) {
  if (p.key !== 'seed') return p.key;
  const cats = seedCats(year);
  const pick = cleanSeedName(body) || (cats.length === 1 ? cats[0] : '');
  return pick && cats.includes(pick) ? 'seed.' + pick : null;
}
function sheetsOf(ev, date) {
  return db.findAll('fundraising_entries', e => e.eventId === ev.id && e.date === date);
}
// What is recorded for one planned sheet: found by BASKET (not by the number
// stored with it), so renumbering the sheets never loses a record, and figures
// typed in the totals form (no sheet) still show on the board. A seed sheet is
// whichever seed.<body> holds the sheet record, else the first body with money.
function recordFor(e, p) {
  if (!e) return null;
  const sheets = e.sheets || {}, cm = e.catMethods || {}, cats = e.categories || {};
  let keys;
  if (p.key === 'seed') {
    keys = [...new Set([...Object.keys(sheets), ...Object.keys(cm), ...Object.keys(cats.seed || {}).map(b => 'seed.' + b)])]
      .filter(k => k === 'seed' || k.startsWith('seed.'));
  } else keys = [p.key];
  const amt = k => (k === 'seed' ? 0 : catAmountOf(cats, k) || 0);
  const key = keys.find(k => sheets[k] && cm[k]) || keys.find(k => sheets[k]) || keys.find(k => cm[k]) || keys.find(k => amt(k) > 0);
  if (!key) return null;
  return { entry: e, key, sheet: sheets[key] || null, bd: cm[key] || null, amount: amt(key),
    // all the money on this sheet's basket (every seed body for the seed sheet)
    basketTotal: r2(keys.reduce((t, k) => t + amt(k), 0)) };
}

// Every non-cash item of the day — cheques, MoMo, transfers, foreign notes and
// pledges — each with the sheet, basket and service it came from (22 Nov 2026,
// per Gideon: "we should be able to tell where this is coming from"). Used by
// the tally screen and the day summary PDF. Items typed outside any sheet
// (service-level figures) are listed as "Not on a sheet".
const ITEM_TYPES = ['cheque', 'momo', 'transfer', 'forex', 'iou'];
function sheetItems(plan, entries) {
  const out = [];
  const push = (type, p, basket, x) => out.push({ type, no: p ? p.no : null, basket, service: p ? p.service : x.service, ...x });
  plan.forEach(p => {
    const e = entries.find(x => x.service === p.service);
    const hit = recordFor(e, p);
    if (!hit) return;
    const cm = e.catMethods || {};
    const keys = p.key === 'seed' ? Object.keys(cm).filter(k => k.startsWith('seed.')) : [hit.key];
    const sheetMomo = ((hit.sheet || {}).momo || []).filter(m => m.amount > 0);
    keys.forEach(k => {
      const bd = cm[k];
      if (!bd) return;
      const basket = k.startsWith('seed.') ? catLabel(k) : p.label;
      (bd.cheques || []).forEach(q => push('cheque', p, basket, { ref: q.number, party: q.drawer || '', bank: q.bank || '', amount: r2(q.amount) }));
      if (!sheetMomo.length && n(bd.momo) > 0) push('momo', p, basket, { ref: '', party: '(no details typed)', bank: '', amount: r2(bd.momo) });
      (bd.transfers || []).forEach(t => push('transfer', p, basket, { ref: t.reference || '', party: '', bank: t.bank || '', amount: r2(t.amount) }));
      (bd.forex || []).forEach(f => push('forex', p, basket, { ref: `${f.currency} ${n(f.amount).toLocaleString('en-GB', { minimumFractionDigits: 2 })} @ ${n(f.rate).toFixed(2)}`, party: '', bank: '', amount: r2(f.ghs) }));
      (bd.ious || []).forEach(i => push('iou', p, basket, { ref: i.dueDate ? 'by ' + i.dueDate : '', party: [i.name, i.contact].filter(Boolean).join(' · '), bank: '', amount: r2(i.amount) }));
    });
    const momoBasket = keys.length === 1 && keys[0].startsWith('seed.') ? catLabel(keys[0]) : p.label;
    sheetMomo.forEach(m => push('momo', p, momoBasket, { ref: m.reference || '', party: m.name || '', bank: '', amount: r2(m.amount) }));
  });
  entries.forEach(e => {
    const md = e.methodsDirect || {};
    (md.cheques || []).forEach(q => push('cheque', null, 'Not on a sheet', { service: e.service, ref: q.number, party: q.drawer || '', bank: q.bank || '', amount: r2(q.amount) }));
    (md.transfers || []).forEach(t => push('transfer', null, 'Not on a sheet', { service: e.service, ref: t.reference || '', party: '', bank: t.bank || '', amount: r2(t.amount) }));
    (e.forex || []).filter(f => !f.category).forEach(f => push('forex', null, 'Not on a sheet', { service: e.service, ref: `${f.currency} ${n(f.amount).toFixed(2)} @ ${n(f.rate).toFixed(2)}`, party: '', bank: '', amount: r2(f.ghs) }));
    db.findAll('fundraising_ious', x => x.entryId === e.id && !x.category && x.status !== 'cancelled')
      .forEach(i => push('iou', null, 'Not on a sheet', { service: e.service, ref: i.dueDate ? 'by ' + i.dueDate : '', party: [i.name, i.contact].filter(Boolean).join(' · '), bank: '', amount: r2(i.amount) }));
  });
  const svcOrder = { joint: 0, '1st': 1, '2nd': 2 };
  return out.sort((a, b) => ITEM_TYPES.indexOf(a.type) - ITEM_TYPES.indexOf(b.type)
    || (svcOrder[a.service] - svcOrder[b.service]) || ((a.no || 999) - (b.no || 999)));
}

router.get('/sheets', requireAuth, (req, res) => {
  if (!canView(req)) return res.status(403).json({ error: 'This module belongs to the Harvest Committee.' });
  const ev = db.findById('fundraising_events', Number(req.query.eventId));
  const date = String(req.query.date || '').slice(0, 10);
  if (!ev || !date) return res.status(400).json({ error: 'eventId and date are required.' });
  const { services, plan } = sheetPlan(ev, date, req.query.services);
  const entries = sheetsOf(ev, date);
  const rows = plan.map(p => {
    const hit = recordFor(entries.find(e => e.service === p.service), p);
    if (!hit) return { ...p, status: 'missing' };
    const s = hit.sheet || {};
    const bd = hit.bd;
    if (!bd && !(hit.basketTotal > 0) && !s.empty) return { ...p, status: s.photoId ? 'photo' : 'missing', photoId: s.photoId || null, entryKey: hit.key };
    const seedMany = p.key === 'seed' && Math.abs(hit.basketTotal - (bd ? bd.total : hit.amount)) > 0.005;
    return {
      ...p, status: 'entered', entryKey: hit.key, source: s.enteredBy ? 'sheet' : 'form',
      label: seedMany ? 'Seed (several bodies)' : hit.key.startsWith('seed.') ? catLabel(hit.key) : p.label,
      total: p.key === 'seed' ? hit.basketTotal : r2(bd ? bd.total : hit.amount),
      cash: bd ? r2(bd.cash) : null, momo: bd ? r2(bd.momo) : null, cheque: bd ? r2(bd.chequeTotal) : null,
      transfer: bd ? r2(bd.transferTotal) : null, forex: bd ? r2(bd.forexGhs) : null, ious: bd ? r2(bd.iouTotal) : null,
      enteredBy: s.enteredBy || hit.entry.enteredBy || null, at: s.at || null, photoId: s.photoId || null,
      corrected: !!s.corrected,
    };
  });
  // Cash by denomination, for the cash handover.
  const cashCount = {};
  entries.forEach(e => Object.entries(e.cashCount || {}).forEach(([k, q]) => { cashCount[k] = (cashCount[k] || 0) + q; }));
  const dayTotal = r2(entries.reduce((s, e) => s + (e.total || 0), 0));
  const status = entries.length ? dayStatusOf(entries) : 'pending';
  // The tally: the day by payment type, and the event against its target.
  const sumOf = f => r2(entries.reduce((t, e) => t + (Number(f(e)) || 0), 0));
  const methods = {
    cash: sumOf(e => (e.methods || {}).cash), momo: sumOf(e => (e.methods || {}).momo),
    cheque: sumOf(e => (e.methods || {}).cheque), transfer: sumOf(e => (e.methods || {}).transfer),
    forex: sumOf(e => e.forexGhs), ious: sumOf(e => e.iouTotal),
  };
  const raised = r2(db.findAll('fundraising_entries', e => e.eventId === ev.id).reduce((t, e) => t + (e.total || 0), 0));
  const rec = dayRecord(ev.id, date);
  res.json({
    day: rec ? { id: rec.id, shape: rec.shape, target: rec.target || null, setBy: rec.setBy, setAt: rec.setAt } : null,
    setUp: !!rec || entries.length > 0,
    event: { id: ev.id, name: ev.name, year: ev.year, target: ev.target || null, raised }, date, services, rows, methods,
    items: sheetItems(plan, entries),
    seedCategories: seedCats(ev.year), denominations: DENOMS,
    entered: rows.filter(r => r.status === 'entered').length, total: rows.length,
    dayTotal, cashCount, cashCounted: cashCountTotal(cashCount), status,
    locked: entries.some(e => e.status && e.status !== 'pending'),
  });
});
function dayStatusOf(entries) {
  if (entries.every(e => e.status === 'confirmed')) return 'confirmed';
  if (entries.some(e => e.status === 'verified')) return 'verified';
  if (entries.some(e => e.submittedAt)) return 'submitted';
  return 'pending';
}

// One sheet as stored, so the desk can open an entered sheet and correct it.
router.get('/sheets/:no', requireAuth, (req, res) => {
  if (!canView(req)) return res.status(403).json({ error: 'This module belongs to the Harvest Committee.' });
  const ev = db.findById('fundraising_events', Number(req.query.eventId));
  const date = String(req.query.date || '').slice(0, 10);
  if (!ev || !date) return res.status(400).json({ error: 'eventId and date are required.' });
  const no = Number(req.params.no);
  const { plan } = sheetPlan(ev, date, req.query.services);
  const p = plan.find(x => x.no === no);
  if (!p) return res.status(404).json({ error: `Sheet ${no} is not one of this day's sheets (01 to ${String(plan.length).padStart(2, '0')}).` });
  const e = db.findOne('fundraising_entries', x => x.eventId === ev.id && x.date === date && x.service === p.service);
  const hit = recordFor(e, p);
  const bd = hit && hit.bd;
  res.json({
    ...p, seedCategories: seedCats(ev.year), rates: normRates([...((e && e.rates) || [])]),
    entryKey: hit ? hit.key : null, entered: !!bd || !!(hit && hit.sheet && hit.sheet.empty), sheet: hit ? hit.sheet : null,
    breakdown: bd ? { cashCount: bd.cashCount, cheques: bd.cheques, transfers: bd.transfers, forex: bd.forex, ious: bd.ious, total: bd.total, cash: bd.cash } : null,
    locked: !!(e && e.status && e.status !== 'pending'),
  });
});

// One sheet. Same arithmetic and storage as "Save this basket" (PUT
// /entries/basket, via buildEntry), plus the sheet's own checks:
//   - the sheet number belongs to this day, service and basket;
//   - the cash total and the basket total written on the sheet equal what the
//     typed pieces and lists add up to (unless the desk marks the sheet's own
//     arithmetic as wrong, with a note — recorded on the trail);
//   - a sheet already entered is not entered again by accident (409), only
//     replaced on purpose.
router.put('/sheets/:no', ...manage, (req, res) => {
  const ev = db.findById('fundraising_events', Number(req.body.eventId));
  const date = String(req.body.date || '').slice(0, 10);
  if (!ev || !date) return res.status(400).json({ error: 'Event and date are required.' });
  if (!daySetUp(ev, date)) return res.status(400).json({ error: NOT_SET_UP });
  const no = Number(req.params.no);
  const { plan } = sheetPlan(ev, date, req.body.services);
  const p = plan.find(x => x.no === no);
  if (!p) return res.status(400).json({ error: `Sheet ${no} is not one of this day's sheets (01 to ${String(plan.length).padStart(2, '0')}).` });
  const key = sheetEntryKey(p, req.body.seedBody, ev.year);
  if (!key) return res.status(400).json({ error: 'Seed sheet: choose which body the seed came from.' });
  const service = p.service;
  const shape = dayShapeError(ev, date, service);
  if (shape) return res.status(400).json({ error: shape });

  const existing = db.findOne('fundraising_entries', e => e.eventId === ev.id && e.date === date && e.service === service);
  const locked = lockedError(existing, req);
  if (locked) return res.status(423).json({ error: locked });
  const already = recordFor(existing, p);
  if (already && (already.bd || already.amount > 0 || (already.sheet && already.sheet.empty)) && !req.body.replace) {
    const by = (already.sheet && already.sheet.enteredBy) || existing.enteredBy || 'someone';
    return res.status(409).json({ error: `Sheet ${String(no).padStart(2, '0')} (${p.label}) was already entered by ${by}${already.sheet && already.sheet.enteredBy ? '' : ' in the totals form'}. Open it to change it.`, already: { by, at: already.sheet && already.sheet.at } });
  }
  // A seed sheet re-entered under another body must not leave the old one counted.
  const staleKey = already && already.key !== key ? already.key : null;

  // The breakdown, exactly as a basket breakdown. MoMo rows are kept on the
  // sheet record; their sum is the basket's MoMo.
  const momoRows = (Array.isArray(req.body.momo) ? req.body.momo : [])
    .map(m => ({ name: String(m.name || '').trim().slice(0, 80), reference: String(m.reference || '').trim().slice(0, 60), amount: r2(n(m.amount)) }))
    .filter(m => m.amount > 0);
  const breakdown = {
    cashCount: req.body.cashCount || {},
    momo: r2(momoRows.reduce((s, m) => s + m.amount, 0)),
    cheques: req.body.cheques || [], transfers: req.body.transfers || [],
    forex: req.body.forex || [], ious: req.body.ious || [],
  };
  // Sheet-typed rates (a foreign row with a rate) become the day's rate when the
  // day has none for that currency; a clash with the day's rate is an error.
  // The day is both services: the dollar has one rate on the day.
  const rates = normRates([...((existing && existing.rates) || []),
    ...db.findAll('fundraising_entries', e => e.eventId === ev.id && e.date === date && e.service !== service).flatMap(e => e.rates || [])]);
  for (const f of (breakdown.forex || [])) {
    const cur = String(f.currency || '').trim().toUpperCase();
    const rate = Number(f.rate) || 0;
    if (!cur || !(rate > 0)) continue;
    const have = rates.find(x => x.currency === cur);
    if (!have) rates.push({ currency: cur, rate });
    else if (Math.abs(have.rate - rate) > 1e-9) return res.status(400).json({ error: `${cur}: today's rate is already ${have.rate}. One rate per currency for the whole day.` });
  }
  const counted = normCatMethods({ [key]: breakdown }, [key], rates)[key];
  const total = counted ? counted.total : 0;
  const cash = counted ? counted.cash : 0;
  const writtenCash = req.body.writtenCash === '' || req.body.writtenCash == null ? null : r2(n(req.body.writtenCash));
  const writtenTotal = req.body.writtenTotal === '' || req.body.writtenTotal == null ? null : r2(n(req.body.writtenTotal));
  // An empty basket is a real answer (22 Nov 2026): it is saved as GHS 0 when the
  // sheet's own total says 0, so the board shows the sheet as in. A sheet saved
  // by mistake is taken away with DELETE below, not by saving it blank.
  if (!(total > 0) && writtenTotal !== 0) {
    return res.status(400).json({ error: 'Nothing typed on this sheet adds up to more than zero. If the basket really was empty, type 0 as the BASKET TOTAL and save. To take away a sheet saved by mistake, use "Remove this sheet".', field: 'total' });
  }
  const corrected = !!req.body.corrected;
  const note = String(req.body.note || '').trim().slice(0, 300);
  if (writtenTotal === null) return res.status(400).json({ error: 'Type the BASKET TOTAL written on the sheet — it is the check that the sheet was typed correctly.' });
  const gh = v => v.toLocaleString(undefined, { minimumFractionDigits: 2 });
  if (!corrected) {
    if (writtenCash !== null && Math.abs(writtenCash - cash) > 0.01) {
      return res.status(400).json({ error: `Cash does not agree: the sheet says GHS ${gh(writtenCash)}, the pieces typed add up to GHS ${gh(cash)}. Check the pieces against the sheet.`, field: 'cash', counted: cash, written: writtenCash });
    }
    if (Math.abs(writtenTotal - total) > 0.01) {
      return res.status(400).json({ error: `Basket total does not agree: the sheet says GHS ${gh(writtenTotal)}, what was typed adds up to GHS ${gh(total)}.`, field: 'total', counted: total, written: writtenTotal });
    }
  } else if (!note) {
    return res.status(400).json({ error: 'Say what was wrong on the sheet (for the record) before saving the typed figures over it.' });
  }

  // Reuse the basket save: read the stored day back, merge this one basket.
  const prev = existing || {};
  const md = prev.methodsDirect || {};
  const catMethods = JSON.parse(JSON.stringify(prev.catMethods || {}));
  if (staleKey) delete catMethods[staleKey];
  catMethods[key] = breakdown;
  const categories = JSON.parse(JSON.stringify(prev.categories || { seed: {}, dayborn: {} }));
  if (!categories.seed) categories.seed = {};
  if (!categories.dayborn) categories.dayborn = {};
  if (!categories.activities) categories.activities = {};
  if (!categories.special) categories.special = {};
  if (staleKey && staleKey !== 'seed') setCatAmount(categories, staleKey, 0);
  const body = {
    date, service, categories,
    methods: { cash: md.cash || 0, momo: md.momo || 0 },
    cashCount: md.cashCount || {}, cheques: md.cheques || [], transfers: md.transfers || [],
    catMethods, rates,
    forex: (prev.forex || []).filter(f => !f.category),
    ious: existing ? db.findAll('fundraising_ious', x => x.entryId === existing.id && x.status === 'outstanding' && !x.category)
      .map(x => ({ name: x.name, contact: x.contact, amount: x.amount, dueDate: x.dueDate })) : [],
  };
  const built = buildEntry(ev, body, existing, req, { enforceRecon: false });
  if (built.error) return res.status(400).json({ error: built.error });
  const who = built.who;
  const sheets = { ...(prev.sheets || {}) };
  if (staleKey) delete sheets[staleKey];
  const old = sheets[key] || (already && already.sheet) || {};
  sheets[key] = {
    no, enteredBy: who.userName, enteredById: who.userId, at: new Date().toISOString(),
    writtenCash, writtenTotal, corrected, note: corrected ? note : '', momo: momoRows,
    photoId: req.body.photoId || old.photoId || null,
    ...(total > 0 ? {} : { empty: true }),   // the basket was empty: in, at GHS 0
  };
  built.payload.sheets = sheets;
  const rec = persistEntry(ev, built, existing);
  logActivity({ ...who, action: `${already ? 'Re-entered' : 'Entered'} harvest sheet ${String(no).padStart(2, '0')}`, entityType: 'fundraising', entityId: rec.id,
    entityLabel: `${ev.name} ${date} ${service} — ${catLabel(key)} GHS ${gh(total)}${corrected ? ` (sheet corrected: ${note})` : ''}` });
  const all = sheetsOf(ev, date);
  res.json({ ok: true, no, key, label: catLabel(key), total, cash, dayTotal: r2(all.reduce((s, e) => s + (e.total || 0), 0)) });
});

// Take a sheet off the day (22 Nov 2026) — a trial run, or a sheet typed under
// the wrong number. Its basket goes back to "not entered" and its money leaves
// the service's figures; everything else on the day is untouched. Same locks
// as entering it; recorded on the trail with what was removed.
router.delete('/sheets/:no', ...manage, (req, res) => {
  const ev = db.findById('fundraising_events', Number(req.body.eventId || req.query.eventId));
  const date = String(req.body.date || req.query.date || '').slice(0, 10);
  if (!ev || !date) return res.status(400).json({ error: 'Event and date are required.' });
  const no = Number(req.params.no);
  const { plan } = sheetPlan(ev, date, req.body.services || req.query.services);
  const p = plan.find(x => x.no === no);
  if (!p) return res.status(400).json({ error: `Sheet ${no} is not one of this day's sheets.` });
  const existing = db.findOne('fundraising_entries', e => e.eventId === ev.id && e.date === date && e.service === p.service);
  const locked = lockedError(existing, req);
  if (locked) return res.status(423).json({ error: locked });
  const hit = recordFor(existing, p);
  if (!hit || !(hit.bd || hit.amount > 0 || hit.sheet)) return res.status(404).json({ error: `Sheet ${String(no).padStart(2, '0')} has nothing saved to remove.` });
  const key = hit.key;
  const removed = r2(hit.bd ? (normCatMethods({ [key]: hit.bd }, [key], existing.rates || [])[key] || { total: 0 }).total : hit.amount);
  const prev = existing;
  const md = prev.methodsDirect || {};
  const catMethods = JSON.parse(JSON.stringify(prev.catMethods || {}));
  delete catMethods[key];
  const categories = JSON.parse(JSON.stringify(prev.categories || { seed: {}, dayborn: {} }));
  if (!categories.seed) categories.seed = {};
  if (!categories.dayborn) categories.dayborn = {};
  if (!categories.activities) categories.activities = {};
  if (!categories.special) categories.special = {};
  if (key !== 'seed') setCatAmount(categories, key, 0);
  const body = {
    date, service: p.service, categories,
    methods: { cash: md.cash || 0, momo: md.momo || 0 },
    cashCount: md.cashCount || {}, cheques: md.cheques || [], transfers: md.transfers || [],
    catMethods, rates: prev.rates || [],
    forex: (prev.forex || []).filter(f => !f.category),
    ious: db.findAll('fundraising_ious', x => x.entryId === existing.id && x.status === 'outstanding' && !x.category)
      .map(x => ({ name: x.name, contact: x.contact, amount: x.amount, dueDate: x.dueDate })),
  };
  const built = buildEntry(ev, body, existing, req, { enforceRecon: false });
  if (built.error) return res.status(400).json({ error: built.error });
  const sheets = { ...(prev.sheets || {}) };
  delete sheets[key];
  built.payload.sheets = sheets;
  const rec = persistEntry(ev, built, existing);
  const gh = v => v.toLocaleString(undefined, { minimumFractionDigits: 2 });
  logActivity({ ...built.who, action: `Removed harvest sheet ${String(no).padStart(2, '0')}`, entityType: 'fundraising', entityId: rec.id,
    entityLabel: `${ev.name} ${date} ${p.service} — ${catLabel(key)} GHS ${gh(removed)} taken off` });
  const all = sheetsOf(ev, date);
  res.json({ ok: true, no, key, removed, dayTotal: r2(all.reduce((t, e) => t + (e.total || 0), 0)) });
});

// A photo of a filled sheet: kept as the record, and lets a counting table far
// from the desk send the sheet straight away. Stored outside public/ and only
// served to people who can see the module.
router.post('/sheets/:no/photo', ...manage, (req, res) => {
  const ev = db.findById('fundraising_events', Number(req.body.eventId));
  const date = String(req.body.date || '').slice(0, 10);
  if (!ev || !date) return res.status(400).json({ error: 'Event and date are required.' });
  if (!daySetUp(ev, date)) return res.status(400).json({ error: NOT_SET_UP });
  const no = Number(req.params.no);
  const { plan } = sheetPlan(ev, date, req.body.services);
  const p = plan.find(x => x.no === no);
  if (!p) return res.status(400).json({ error: `Sheet ${no} is not one of this day's sheets.` });
  const m = String(req.body.image || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return res.status(400).json({ error: 'That is not a photo AOTC Track can keep (JPEG, PNG or WebP).' });
  const buf = Buffer.from(m[2], 'base64');
  if (!buf.length || buf.length > 3 * 1024 * 1024) return res.status(400).json({ error: 'The photo is too large (3 MB at most).' });
  const shape = dayShapeError(ev, date, p.service);
  if (shape) return res.status(400).json({ error: shape });
  fs.mkdirSync(SHEET_PHOTO_DIR, { recursive: true });
  const photoId = `${ev.id}-${date}-${String(no).padStart(2, '0')}-${Date.now()}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(SHEET_PHOTO_DIR, photoId), buf);
  const who = actor(req);
  let existing = db.findOne('fundraising_entries', e => e.eventId === ev.id && e.date === date && e.service === p.service);
  const locked = lockedError(existing, req);
  if (locked) return res.status(423).json({ error: locked });
  const sheets = { ...((existing && existing.sheets) || {}) };
  const hit = recordFor(existing, p);
  const key = hit ? hit.key : p.key;
  sheets[key] = { ...(sheets[key] || { no }), no, photoId, photoBy: who.userName, photoAt: new Date().toISOString() };
  if (existing) db.update('fundraising_entries', existing.id, { sheets });
  else {
    // The first thing to arrive for this service may be a photo: start the
    // entry empty so the sheet shows as "photo received" on the board.
    existing = db.insert('fundraising_entries', {
      eventId: ev.id, eventName: ev.name, year: ev.year, date, service: p.service,
      categories: { seed: {}, gratitude: 0, chairpersons: 0, dayborn: Object.fromEntries(DAYBORN.map(d => [d, 0])), activities: {} },
      total: 0, methods: { cash: 0, cheque: 0, momo: 0, transfer: 0 }, methodsDirect: {}, catMethods: {}, rates: [],
      cashCount: {}, cashCounted: 0, cheques: [], transfers: [], forex: [], forexGhs: 0, iouTotal: 0, ghsSubtotal: 0,
      enteredBy: who.userName, enteredById: who.userId, status: 'pending', sheets,
    });
  }
  logActivity({ ...who, action: `Sent a photo of harvest sheet ${String(no).padStart(2, '0')}`, entityType: 'fundraising', entityId: existing.id, entityLabel: `${ev.name} ${date} ${p.service} — ${p.label}` });
  res.json({ ok: true, photoId });
});
router.get('/sheet-photo/:id', requireAuth, (req, res) => {
  if (!canView(req)) return res.status(403).json({ error: 'This module belongs to the Harvest Committee.' });
  const id = String(req.params.id);
  if (!/^[0-9]+-\d{4}-\d{2}-\d{2}-\d{2,3}-\d+\.(jpg|png|webp)$/.test(id)) return res.status(400).json({ error: 'Bad photo id.' });
  const f = path.join(SHEET_PHOTO_DIR, id);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'Photo not found.' });
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(f);
});

// The printed set for the day: one sheet per basket per service, then the
// "sheets returned" list. Works before anything is saved.
router.get('/basket-sheets.pdf', requireAuth, async (req, res) => {
  if (!canView(req)) return res.status(403).json({ error: 'This module belongs to the Harvest Committee.' });
  const ev = db.findById('fundraising_events', Number(req.query.eventId));
  const date = String(req.query.date || '').slice(0, 10);
  if (!ev || !date) return res.status(400).json({ error: 'Choose the event and the date first.' });
  if (!daySetUp(ev, date)) return res.status(400).json({ error: NOT_SET_UP });
  const { services, plan } = sheetPlan(ev, date, req.query.services);
  const only = Number(req.query.no) || null;
  if (only && !plan.some(x => x.no === only)) return res.status(404).json({ error: `Sheet ${only} is not one of this day's sheets.` });
  const buf = await buildBasketSheetsPdf({ event: ev, date, services, plan, denoms: DENOMS, only });
  logActivity({ ...actor(req), action: 'Printed harvest basket sheets', entityType: 'fundraising', entityId: ev.id, entityLabel: `${ev.name} ${date} (${services.join(' + ')}, ${plan.length} sheets)` });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Harvest_Sheets_${ev.name.replace(/\s+/g, '_')}_${date}.pdf"`);
  res.send(buf);
});
// After the last sheet: the day on one page per service plus the cash handover
// (cash by denomination, every cheque) for signatures.
router.get('/day-summary.pdf', requireAuth, async (req, res) => {
  if (!canView(req)) return res.status(403).json({ error: 'This module belongs to the Harvest Committee.' });
  const ev = db.findById('fundraising_events', Number(req.query.eventId));
  const date = String(req.query.date || '').slice(0, 10);
  if (!ev || !date) return res.status(400).json({ error: 'eventId and date are required.' });
  const entries = sheetsOf(ev, date);
  if (!entries.length) return res.status(404).json({ error: 'Nothing has been entered for that day yet.' });
  const { plan } = sheetPlan(ev, date, req.query.services);
  const rows = plan.map(p => {
    const e = entries.find(x => x.service === p.service);
    const hit = recordFor(e, p);
    const bd = hit && hit.bd;
    const formOnly = !!hit && !bd && hit.basketTotal > 0;
    return { ...p, label: hit && hit.key.startsWith('seed.') ? catLabel(hit.key) : p.label,
      bd: bd || (formOnly ? { total: hit.basketTotal, formOnly: true } : null), sheet: hit ? hit.sheet : null };
  });
  const buf = await buildDaySummaryPdf({ event: ev, date, rows, entries, denoms: DENOMS, items: sheetItems(plan, entries) });
  logActivity({ ...actor(req), action: 'Printed harvest day summary', entityType: 'fundraising', entityId: ev.id, entityLabel: `${ev.name} ${date}` });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Harvest_Day_Summary_${ev.name.replace(/\s+/g, '_')}_${date}.pdf"`);
  res.send(buf);
});

router.delete('/entries/:id', ...manage, (req, res) => {
  const rec = db.findById('fundraising_entries', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Entry not found.' });
  if (rec.status && rec.status !== 'pending' && req.user.role !== 'admin') {
    return res.status(423).json({ error: 'Signed off — locked. Ask an admin.' });
  }
  db.remove('fundraising_entries', rec.id);
  db.findAll('fundraising_ious', x => x.entryId === rec.id && x.status !== 'paid')
    .forEach(x => db.remove('fundraising_ious', x.id));
  logActivity({ ...actor(req), action: 'Deleted fundraising entry', entityType: 'fundraising', entityId: rec.id, entityLabel: `${rec.eventName} ${rec.date}`, snapshot: rec });
  res.json({ ok: true });
});

// ---- IOU register ----
router.post('/ious/:id/paid', requireAuth, (req, res) => {
  if (!canMarkPaid(req)) return res.status(403).json({ error: 'You cannot mark IOUs as paid.' });
  const iou = db.findById('fundraising_ious', Number(req.params.id));
  if (!iou) return res.status(404).json({ error: 'IOU not found.' });
  if (iou.status === 'paid') return res.json(iou);
  const who = actor(req);
  const rec = db.update('fundraising_ious', iou.id, { status: 'paid', paidAt: new Date().toISOString(), paidBy: who.userName });
  logActivity({ ...who, action: 'IOU redeemed (marked paid)', entityType: 'fundraising', entityId: iou.id, entityLabel: `${iou.name} — GHS ${(iou.amount || 0).toLocaleString()}` });
  res.json(rec);
});

// Outflows
router.post('/expenses', ...manage, (req, res) => {
  const ev = db.findById('fundraising_events', Number(req.body.eventId));
  if (!ev) return res.status(404).json({ error: 'Event not found.' });
  const description = String(req.body.description || '').trim();
  if (!description) return res.status(400).json({ error: 'Describe the expense.' });
  const rec = db.insert('fundraising_expenses', {
    eventId: ev.id, eventName: ev.name, year: ev.year,
    description, amount: n(req.body.amount), date: req.body.date || new Date().toISOString().slice(0, 10),
    enteredBy: actor(req).userName,
  });
  logActivity({ ...actor(req), action: 'Recorded fundraising expense', entityType: 'fundraising', entityId: rec.id, entityLabel: `${description} — GHS ${rec.amount.toLocaleString()}` });
  res.json(rec);
});
// Correct an expense (description, amount, date).
router.put('/expenses/:id', ...manage, (req, res) => {
  const rec = db.findById('fundraising_expenses', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Expense not found.' });
  const patch = {};
  if (req.body.description !== undefined) {
    const d = String(req.body.description).trim();
    if (!d) return res.status(400).json({ error: 'Describe the expense.' });
    patch.description = d;
  }
  if (req.body.amount !== undefined) patch.amount = n(req.body.amount);
  if (req.body.date !== undefined && req.body.date) patch.date = req.body.date;
  const updated = db.update('fundraising_expenses', rec.id, patch);
  logActivity({ ...actor(req), action: 'Updated fundraising expense', entityType: 'fundraising', entityId: rec.id, entityLabel: `${updated.description} — GHS ${Number(updated.amount || 0).toLocaleString()}` });
  res.json(updated);
});
router.delete('/expenses/:id', ...manage, (req, res) => {
  const rec = db.findById('fundraising_expenses', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Expense not found.' });
  db.remove('fundraising_expenses', rec.id);
  logActivity({ ...actor(req), action: 'Deleted fundraising expense', entityType: 'fundraising', entityId: rec.id, entityLabel: rec.description, snapshot: rec });
  res.json({ ok: true });
});

// Announcement PDF for one fundraising day (all services on that date for the event)
// The paper pro-forma the counting team fills in BEFORE anything is typed.
// Generated rather than kept as a file, so it always carries this year's seed
// sub-categories and the current denominations — a stale printed sheet is how
// a basket ends up with nowhere to write it. Works with no entries saved yet,
// which is the whole point, and `date` is optional so a blank pad can be run
// off ahead of the season.
router.get('/counting-sheet.pdf', requireAuth, async (req, res) => {
  if (!canView(req)) return res.status(403).json({ error: 'This module belongs to the Harvest Committee.' });
  const ev = req.query.eventId ? db.findById('fundraising_events', Number(req.query.eventId)) : null;
  if (req.query.eventId && !ev) return res.status(404).json({ error: 'Event not found.' });
  const year = ev ? ev.year : (Number(req.query.year) || new Date().getFullYear());
  const date = req.query.date || '';
  const buf = await buildCountingSheetPdf({
    event: ev, date, dayborn: DAYBORN, seedCategories: seedCats(year),
    activityCategories: activityCats(year), denoms: DENOMS,
  });
  logActivity({ ...actor(req), action: 'Printed a fundraising counting sheet', entityType: 'fundraising',
    entityId: ev ? ev.id : 0, entityLabel: `${ev ? ev.name : year}${date ? ' ' + date : ''}` });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Counting_Sheet_${(ev ? ev.name : String(year)).replace(/\s+/g, '_')}${date ? '_' + date : ''}.pdf"`);
  res.send(buf);
});

router.get('/announcement.pdf', requireAuth, async (req, res) => {
  if (!canView(req)) return res.status(403).json({ error: 'This module belongs to the Harvest Committee.' });
  const ev = db.findById('fundraising_events', Number(req.query.eventId));
  const date = req.query.date;
  if (!ev || !date) return res.status(400).json({ error: 'eventId and date are required.' });
  const entries = db.findAll('fundraising_entries', e => e.eventId === ev.id && e.date === date);
  if (!entries.length) return res.status(404).json({ error: 'No entries for that date.' });
  const buf = await buildAnnouncementPdf({ event: ev, date, entries, dayborn: DAYBORN,
    seedCategories: seedCats(ev.year), activityCategories: activityCats(ev.year), denoms: DENOMS });
  logActivity({ ...actor(req), action: 'Generated fundraising announcement PDF', entityType: 'fundraising', entityId: ev.id, entityLabel: `${ev.name} ${date}` });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${ev.name.replace(/\s+/g, '_')}_${date}_announcement.pdf"`);
  res.send(buf);
});

// Year statement PDF — the committee's printable account to Session
router.get('/statement.pdf', requireAuth, async (req, res) => {
  if (!canView(req)) return res.status(403).json({ error: 'This module belongs to the Harvest Committee.' });
  const year = Number(req.query.year) || new Date().getFullYear();
  const events = db.findAll('fundraising_events', e => e.year === year).sort((a, b) => a.order - b.order);
  const entries = db.findAll('fundraising_entries', e => e.year === year);
  const expenses = db.findAll('fundraising_expenses', e => e.year === year);
  const ious = db.findAll('fundraising_ious', i => i.year === year);
  const meta = db.findOne('fundraising_meta', m => m.year === year) || {};
  const perEvent = events.map(ev => {
    const raised = entries.filter(e => e.eventId === ev.id).reduce((s, e) => s + (e.total || 0), 0);
    const spent = expenses.filter(x => x.eventId === ev.id).reduce((s, x) => s + (x.amount || 0), 0);
    return { ...ev, raised, spent, net: raised - spent };
  });
  const buf = await buildStatementPdf({ year, events: perEvent, entries, expenses, ious, annualTarget: meta.annualTarget, seedCategories: seedCats(year), activityCategories: activityCats(year), denoms: DENOMS });
  logActivity({ ...actor(req), action: 'Generated fundraising statement PDF', entityType: 'fundraising', entityId: year, entityLabel: String(year) });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="Fundraising_Statement_${year}.pdf"`);
  res.send(buf);
});

// Harvest submits the day for sign-off → notify the Accounts Clerk(s).
router.post('/submit-day', ...manage, (req, res) => {
  const { eventId, date } = req.body;
  const entries = db.findAll('fundraising_entries', e => e.eventId === Number(eventId) && e.date === date);
  if (!entries.length) return res.status(404).json({ error: 'No entries for that day.' });
  if (entries.some(e => e.status !== 'pending')) return res.status(400).json({ error: 'This day is already in the sign-off pipeline.' });

  // THE reconciliation gate. It used to sit on every save, which is no longer
  // possible: baskets are saved one at a time and a half-counted day
  // legitimately does not balance. So the day must balance HERE, before it goes
  // to the Accounts Clerk — nothing enters the sign-off pipeline unbalanced.
  const off = entries
    .map(e => {
      const mt = r2((e.methods || {}).cash + (e.methods || {}).cheque + (e.methods || {}).momo
        + (e.methods || {}).transfer + (e.iouTotal || 0) + (e.forexGhs || 0));
      return { service: e.service, streams: r2(e.total || 0), methods: mt, diff: r2((e.total || 0) - mt) };
    })
    .filter(x => x.methods > 0 && Math.abs(x.diff) > 0.01);
  if (off.length) {
    const gh = v => v.toLocaleString(undefined, { minimumFractionDigits: 2 });
    return res.status(400).json({
      error: 'This day does not reconcile yet, so it cannot go for verification: '
        + off.map(x => `${x.service === 'joint' ? 'Joint service' : x.service + ' service'} — baskets GHS ${gh(x.streams)} against methods GHS ${gh(x.methods)}, ${x.diff > 0 ? 'short' : 'over'} by GHS ${gh(Math.abs(x.diff))}`).join('; ')
        + '.',
      unreconciled: off,
    });
  }

  const who = actor(req);
  const now = new Date().toISOString();
  entries.forEach(e => db.update('fundraising_entries', e.id, { submittedAt: now, submittedBy: who.userName, declined: null }));
  const total = entries.reduce((s, e) => s + (e.total || 0), 0);
  const label = `${entries[0].eventName} ${date}`;
  notifyVerifiers(
    'Harvest figures awaiting verification',
    `${label} — GHS ${total.toLocaleString(undefined, { minimumFractionDigits: 2 })} submitted by ${who.userName}. Please verify on AOTC Track (Fundraising).`,
    who.userId);
  logActivity({ ...who, action: 'Submitted fundraising day for sign-off', entityType: 'fundraising', entityId: Number(eventId), entityLabel: label });
  res.json({ ok: true });
});

// Level 1: Accounts Clerk verifies the whole fundraising day
router.post('/verify-day', requireAuth, (req, res) => {
  if (!canVerify(req)) return res.status(403).json({ error: 'Only the Accounts Clerk (or an admin) can verify fundraising figures.' });
  const { eventId, date } = req.body;
  const entries = db.findAll('fundraising_entries', e => e.eventId === Number(eventId) && e.date === date);
  if (!entries.length) return res.status(404).json({ error: 'No entries for that day.' });
  if (entries.some(e => e.status === 'confirmed')) return res.status(400).json({ error: 'Already approved and locked.' });
  const who = actor(req);
  entries.forEach(e => db.update('fundraising_entries', e.id, {
    status: 'verified', verifiedBy: who.userName, verifiedAt: new Date().toISOString(),
  }));
  const label = `${entries[0].eventName} ${date}`;
  const total = entries.reduce((s, e) => s + (e.total || 0), 0);
  notifyHolders('fundraising.approve',
    'Harvest figures awaiting your approval',
    `${label} — GHS ${total.toLocaleString(undefined, { minimumFractionDigits: 2 })} verified by ${who.userName} (Accounts Clerk). Awaiting Treasurer approval on AOTC Track.`,
    who.userId);
  logActivity({ ...who, action: 'VERIFIED fundraising day (level 1)', entityType: 'fundraising', entityId: Number(eventId), entityLabel: label });
  res.json({ ok: true });
});

// Level 2: Treasurer approves & locks.
// Normally the Accounts Clerk has verified first. Someone who holds BOTH
// rights (the Treasurer, or an admin) may close an unverified day on their
// own — the verification is stamped in their name first, so the record still
// shows both levels and who took each one.
router.post('/approve-day', requireAuth, (req, res) => {
  if (!canApprove(req)) return res.status(403).json({ error: 'Only the Treasurer (or an admin) can approve fundraising figures.' });
  const { eventId, date } = req.body;
  const entries = db.findAll('fundraising_entries', e => e.eventId === Number(eventId) && e.date === date);
  if (!entries.length) return res.status(404).json({ error: 'No entries for that day.' });
  const who = actor(req);
  const unverified = entries.filter(e => e.status !== 'verified');
  if (unverified.length && !canVerify(req)) {
    return res.status(400).json({ error: 'The Accounts Clerk must verify these figures before the Treasurer approves.' });
  }
  if (unverified.length) {
    const at = new Date().toISOString();
    unverified.forEach(e => db.update('fundraising_entries', e.id, { status: 'verified', verifiedBy: who.userName, verifiedAt: at }));
    logActivity({ ...who, action: 'VERIFIED fundraising day (level 1 — taken with the approval)', entityType: 'fundraising', entityId: Number(eventId), entityLabel: `${entries[0].eventName} ${date}` });
  }
  entries.forEach(e => db.update('fundraising_entries', e.id, {
    status: 'confirmed', confirmedBy: who.userName, confirmedAt: new Date().toISOString(),
  }));
  const label = `${entries[0].eventName} ${date}`;
  const total = entries.reduce((s, e) => s + (e.total || 0), 0);
  notifyEnterers(entries,
    'Harvest figures APPROVED',
    `${label} — GHS ${total.toLocaleString(undefined, { minimumFractionDigits: 2 })} approved & locked by ${who.userName} (Treasurer).`);
  logActivity({ ...who, action: 'APPROVED fundraising day (level 2 — locked)', entityType: 'fundraising', entityId: Number(eventId), entityLabel: label });
  res.json({ ok: true });
});

// Decline at either level: figures go back to the Harvest Committee with a
// reason; whoever entered them is notified.
router.post('/decline-day', requireAuth, (req, res) => {
  if (!canVerify(req) && !canApprove(req)) return res.status(403).json({ error: 'Only the Accounts Clerk or Treasurer (or an admin) can decline figures.' });
  const { eventId, date } = req.body;
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Give a reason so the Harvest Committee knows what to correct.' });
  const entries = db.findAll('fundraising_entries', e => e.eventId === Number(eventId) && e.date === date);
  if (!entries.length) return res.status(404).json({ error: 'No entries for that day.' });
  if (entries.some(e => e.status === 'confirmed') && req.user.role !== 'admin') {
    return res.status(400).json({ error: 'Already approved and locked — ask an admin to unlock instead.' });
  }
  const who = actor(req);
  const stage = entries.every(e => e.status === 'verified') ? 'approval' : 'verification';
  entries.forEach(e => db.update('fundraising_entries', e.id, {
    status: 'pending', submittedAt: null, submittedBy: null,
    declined: { by: who.userName, at: new Date().toISOString(), reason, stage },
  }));
  const label = `${entries[0].eventName} ${date}`;
  notifyEnterers(entries,
    'Harvest figures DECLINED',
    `${label} declined at ${stage} by ${who.userName}: "${reason}". Please correct and resubmit on AOTC Track.`);
  logActivity({ ...who, action: `DECLINED fundraising day (${stage})`, entityType: 'fundraising', entityId: Number(eventId), entityLabel: `${label} — ${reason}` });
  res.json({ ok: true });
});

router.post('/unconfirm-day', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an administrator can unlock a signed-off day.' });
  const { eventId, date } = req.body;
  const entries = db.findAll('fundraising_entries', e => e.eventId === Number(eventId) && e.date === date);
  entries.forEach(e => db.update('fundraising_entries', e.id, { status: 'pending', submittedAt: null, submittedBy: null }));
  logActivity({ ...actor(req), action: 'UNLOCKED fundraising day', entityType: 'fundraising', entityId: Number(eventId), entityLabel: `${date}` });
  res.json({ ok: true });
});

module.exports = router;
