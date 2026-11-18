// AOTC Track — the weekly finance return (the Sunday money entry).
//
// WHY THIS EXISTS. The quarterly Finance panel asks for five figures and gets
// five typed numbers. Nobody can check them, nothing produces them, and the
// week-by-week record they came from lives in a cash book nobody else can see.
// Meanwhile the same figures are read out in church every Sunday. This module
// makes the Sunday announcement the source: the Accounts Clerk enters the
// week, the Treasurer confirms it, and the quarter is the sum of its weeks.
//
// TWO SIDES, ONE FORM. Receipts (offertory, tithes, dues, pledges) and
// payments (the earmarked heads and total expenditure). They are one record
// because they are one counting session, but only the receipts go into the
// announcement — that is what the congregation is told, and the pasted
// wording totals receipts alone.
//
// LINES ARE DATA, NOT CODE. Every line carries a `feeds` key naming where it
// lands in the quarterly panel. Add a line for a new collection, point it at a
// target, and the quarter picks it up — no code change, no deploy. Several
// lines may feed one target: the four offertory lines add up to Offertory.
//
// NOTHING HERE TOUCHES EXISTING RECORDS. Two new collections
// (finance_weekly_lines, finance_weekly). finance_quarterly is only ever
// written through its own route, and only for a quarter someone has
// explicitly switched to the weekly ledger.
const db = require('./db');

// Where a weekly line lands in the quarterly Finance panel. The keys on the
// right of this map are the keys of finance_quarterly.earmarked, so a line
// feeding 'welfare' adds into the Welfare box and nowhere else.
// '' means captured weekly and reported weekly, but not carried to the quarter.
const FEED_TARGETS = {
  '': 'Not carried to the quarter',
  offertory: 'Offertory',
  tithes: 'Tithes',
  missionsEvangelism: 'Missions & Evangelism',
  welfare: 'Welfare',
  education: 'Education',
  scholarship: 'Scholarship',
  totalAllExpenditure: 'Total ALL expenditure (excl. statutory transfers)',
  higherCourts: 'Transferred to higher courts (Fin-03)',
  kutunse: 'Kutunse Project funds raised (Fin-05)',
};

// Two of those targets are not boxes on the quarterly panel at all - they are
// KPIs on Finance's own goals (Fin-03 weekly transfers, Fin-05 Kutunse). They
// are listed here so a line can point at them and the figure is carried; the
// entry page fills the KPI from the same summary. Kept apart from the
// earmarked keys because writing them takes a different route.
const GOAL_FEEDS = ['higherCourts', 'kutunse'];

// The congregation's own list, in the order it is read out on Sunday.
// Seeded once into finance_weekly_lines; edited from the page thereafter.
const DEFAULT_LINES = [
  { key: 'offertory1', label: '1st Service Offertory', side: 'in', feeds: 'offertory', announce: true },
  { key: 'offertory2', label: '2nd Service Offertory', side: 'in', feeds: 'offertory', announce: true },
  { key: 'offertoryJy', label: 'Junior Youth', side: 'in', feeds: 'offertory', announce: true },
  { key: 'offertoryCs', label: "Children Service Offertory", side: 'in', feeds: 'offertory', announce: true },
  { key: 'tithes', label: 'Tithes', side: 'in', feeds: 'tithes', announce: true },
  { key: 'communionDues', label: 'Communion Dues', side: 'in', feeds: '', announce: true },
  { key: 'thanksOffering', label: 'Voluntary Thanks Offering', side: 'in', feeds: '', announce: true },
  { key: 'buildingPledge', label: 'Building Pledge', side: 'in', feeds: '', announce: true },
  { key: 'buildingSupport', label: 'Building Project Support', side: 'in', feeds: '', announce: true },
  // The Kutunse Project is a DISTRICT project and has nothing to do with the
  // congregation's own building fund above - they are counted separately and
  // reported separately (Fin-05).
  { key: 'kutunse', label: 'Kutunse Project', side: 'in', feeds: 'kutunse', announce: false },
  // Payments. The four earmarked heads are SUBSETS of total expenditure, not
  // additions to it — see validate() below, which is the only thing standing
  // between a slip of the finger and a District return that does not add up.
  { key: 'expMissionsEvangelism', label: 'Missions & Evangelism', side: 'out', feeds: 'missionsEvangelism' },
  { key: 'expWelfare', label: 'Welfare', side: 'out', feeds: 'welfare' },
  { key: 'expEducation', label: 'Education', side: 'out', feeds: 'education' },
  { key: 'expScholarship', label: 'Scholarship', side: 'out', feeds: 'scholarship' },
  { key: 'expTotal', label: 'Total ALL expenditure (excl. statutory transfers)', side: 'out', feeds: 'totalAllExpenditure', isTotal: true },
  // The 50-50: what actually went up to the District this week. Fin-03 asks
  // for the number of weekly transfers and the amount, and until now both were
  // typed from memory a quarter later.
  { key: 'higherCourts', label: 'Transferred to District / higher courts', side: 'out', feeds: 'higherCourts' },
];

const EARMARKED_KEYS = ['missionsEvangelism', 'welfare', 'education', 'scholarship'];

// Does this line appear in the Sunday announcement?
//
// Entering a figure and announcing it are two different decisions, and the
// congregation is told a shorter list than the books keep. Kutunse ships off
// the list for exactly that reason: it is recorded every week and reported to
// the District, but it is not one of the lines read out. The flag is per line
// and editable, so the list read from the pulpit can change without code.
//
// Receipts only. The headline is "funds received ... amounted to", and that
// total is the sum of the announced lines - let a payment in and the sentence
// stops being true. An older row with no flag set falls back to its side,
// which is how the list behaved before the flag existed.
function isAnnounced(l) {
  if (!l || l.side !== 'in') return false;
  return l.announce === undefined ? true : !!l.announce;
}

function num(v) {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : 0;
}
function quarterOf(dateStr) {
  const m = Number(String(dateStr).slice(5, 7));
  return Math.floor((m - 1) / 3) + 1;
}
function yearOf(dateStr) { return Number(String(dateStr).slice(0, 4)); }

// The line list, seeded on first use. Idempotent: if the collection already
// holds rows this only reads. Retired lines stay in the store so historic
// weeks keep their labels — they are just hidden from new entry.
function lines({ includeRetired = false } = {}) {
  let rows = db.findAll('finance_weekly_lines');
  if (!rows.length) {
    DEFAULT_LINES.forEach((l, i) => db.insert('finance_weekly_lines', { ...l, order: i, active: true }));
    rows = db.findAll('finance_weekly_lines');
  }
  return rows
    .filter(l => includeRetired || l.active !== false)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// The figures a week reports, keyed by line. Unknown keys (a line retired
// after the week was entered) are kept so nothing silently vanishes.
function amountsOf(rec) { return (rec && rec.amounts) || {}; }

// ---- Programmes during the week (Nov 2026) ----------------------------------
// A revival, a convention, a 2-, 3- or 5-day programme: an offering is taken on
// each day it runs. They are kept on the week as
//   programmes: [{ name, diaryKey, days: [{ date, amount }] }]
// and, as the Session Clerk decided, they COUNT AS OFFERTORY (carried to the
// quarter's Offertory) and ARE READ OUT, one line per programme with its days:
//   "Revival offering (Mon 2 – Wed 4 November)   1,250.00"
// The days are the week the Sunday return covers: the six days before the
// Sunday, and the Sunday itself.
const PROGRAMME_LINE = { key: 'programmes', label: 'Programme offerings (revivals and the like)', side: 'in', feeds: 'offertory', announce: true };
function programmesOf(rec) { return Array.isArray(rec && rec.programmes) ? rec.programmes : []; }
function programmeTotal(p) { return (p && Array.isArray(p.days) ? p.days : []).reduce((t, d) => t + num(d && d.amount), 0); }
function programmesTotal(rec) { return programmesOf(rec).reduce((t, p) => t + programmeTotal(p), 0); }
function weekDays(sunday) {
  const out = [];
  const base = new Date(`${sunday}T12:00:00`);
  for (let i = 6; i >= 0; i -= 1) { const d = new Date(base); d.setDate(base.getDate() - i); out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); }
  return out;
}
// "Mon 2 – Wed 4 November" for days in a row; "Tue 3 and Thu 5 November" otherwise.
function daysLabel(dates) {
  const ds = (dates || []).filter(Boolean).slice().sort();
  if (!ds.length) return '';
  const D = k => new Date(`${k}T12:00:00`);
  const wd = k => D(k).toLocaleDateString('en-GB', { weekday: 'short' });
  const dm = k => D(k).getDate();
  const mon = k => D(k).toLocaleDateString('en-GB', { month: 'long' });
  if (ds.length === 1) return `${wd(ds[0])} ${dm(ds[0])} ${mon(ds[0])}`;
  const inRow = ds.every((k, i) => i === 0 || (D(k) - D(ds[i - 1])) === 86400000);
  const one = mon(ds[0]) === mon(ds[ds.length - 1]);
  const part = (k, withMonth) => `${wd(k)} ${dm(k)}${withMonth ? ` ${mon(k)}` : ''}`;
  if (inRow) return `${part(ds[0], !one)} – ${part(ds[ds.length - 1], true)}`;
  const parts = ds.map((k, i) => part(k, !one || i === ds.length - 1));
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
// What the page sends, made safe: up to 8 programmes, days only within the week.
function cleanProgrammes(input, sunday) {
  const allowed = new Set(weekDays(sunday));
  return (Array.isArray(input) ? input : []).slice(0, 8).map(p => ({
    name: String((p && p.name) || '').trim().slice(0, 120),
    diaryKey: String((p && p.diaryKey) || '').slice(0, 60),
    days: (Array.isArray(p && p.days) ? p.days : []).filter(d => d && allowed.has(String(d.date)))
      .map(d => ({ date: String(d.date), amount: Math.max(0, num(d.amount)) }))
      .filter((d, i, all) => all.findIndex(x => x.date === d.date) === i)
      .sort((a, b) => a.date.localeCompare(b.date)),
  })).filter(p => p.name || p.days.some(d => d.amount));
}
function programmeLabel(p) {
  const name = String(p.name || 'Programme').trim();
  const lbl = daysLabel((p.days || []).filter(d => num(d.amount) > 0).map(d => d.date));
  return `${/offering$/i.test(name) ? name : `${name} offering`}${lbl ? ` (${lbl})` : ''}`;
}

function receiptsTotal(rec, defs) {
  const a = amountsOf(rec);
  return (defs || lines({ includeRetired: true })).filter(l => l.side === 'in')
    .reduce((t, l) => t + num(a[l.key]), 0) + programmesTotal(rec);
}

// Warnings, not errors: the clerk is told, the save still goes through. A hard
// block on a Sunday evening would just mean the figures never get entered.
function validate(amounts, defs) {
  defs = defs || lines({ includeRetired: true });
  const a = amounts || {};
  const out = [];
  const totalLine = defs.find(l => l.isTotal);
  if (totalLine) {
    const total = num(a[totalLine.key]);
    const heads = defs.filter(l => EARMARKED_KEYS.includes(l.feeds));
    const sum = heads.reduce((t, l) => t + num(a[l.key]), 0);
    if (total > 0 && sum > total) {
      out.push(`The earmarked heads add up to ${sum.toLocaleString()} but total expenditure is ${total.toLocaleString()}. The heads are part of the total, not extra to it.`);
    }
  }
  defs.forEach(l => { if (num(a[l.key]) < 0) out.push(`${l.label} is negative.`); });
  return out;
}

// Every confirmed week of a quarter, added up per feed target. This is the
// single place the quarterly panel gets its figures from, so the panel, the
// report and the District return cannot drift apart.
//
// confirmedOnly is the default on purpose: a week the Treasurer has not
// confirmed is a draft, and a draft must never move a reported figure.
function quarterSummary(year, quarter, { confirmedOnly = true } = {}) {
  const defs = lines({ includeRetired: true });
  const all = db.findAll('finance_weekly', w => Number(w.year) === Number(year) && Number(w.quarter) === Number(quarter));
  const weeks = all.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const counted = weeks.filter(w => (confirmedOnly ? w.status === 'confirmed' : w.status !== 'draft'));
  const byFeed = {};
  const byLine = {};
  counted.forEach(w => {
    const a = amountsOf(w);
    defs.forEach(l => {
      const v = num(a[l.key]);
      if (!v) return;
      byLine[l.key] = (byLine[l.key] || 0) + v;
      if (l.feeds) byFeed[l.feeds] = (byFeed[l.feeds] || 0) + v;
    });
    // Revivals and other programmes in the week count as Offertory.
    const pv = programmesTotal(w);
    if (pv) { byLine[PROGRAMME_LINE.key] = (byLine[PROGRAMME_LINE.key] || 0) + pv; byFeed[PROGRAMME_LINE.feeds] = (byFeed[PROGRAMME_LINE.feeds] || 0) + pv; }
  });
  return {
    year: Number(year), quarter: Number(quarter),
    byFeed, byLine,
    weeks: weeks.map(w => ({ date: w.date, status: w.status, total: receiptsTotal(w, defs) })),
    entered: weeks.length,
    confirmed: counted.length,
    // Fin-03 wants a COUNT of weeks a transfer actually went up, which is not
    // the same as the number of weeks entered.
    higherCourtWeeks: counted.filter(w => defs.some(l => l.feeds === 'higherCourts' && num(amountsOf(w)[l.key]) > 0)).length,
    kutunseWeeks: counted.filter(w => defs.some(l => l.feeds === 'kutunse' && num(amountsOf(w)[l.key]) > 0)).length,
  };
}

// How many Sundays fall in a quarter — so the panel can say "9 of 13", which
// is the difference between a figure that is low and a figure that is wrong.
function sundaysBetween(start, end) {
  let n = 0;
  for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) if (d.getDay() === 0) n++;
  return n;
}
function sundaysInQuarter(year, quarter) {
  return sundaysBetween(new Date(Number(year), (Number(quarter) - 1) * 3, 1), new Date(Number(year), Number(quarter) * 3, 0));
}
function sundaysInYear(year) {
  return sundaysBetween(new Date(Number(year), 0, 1), new Date(Number(year), 11, 31));
}

const money = n => Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The Sunday announcement, in the wording the congregation already hears.
// Receipts only, and the headline total is their sum — which is exactly how
// the figure read out from the pulpit is arrived at.
function announcementText(rec, defs) {
  defs = defs || lines({ includeRetired: true });
  const a = amountsOf(rec);
  const shown = defs.filter(l => isAnnounced(l) && num(a[l.key]) > 0).map(l => ({ label: l.label, v: num(a[l.key]) }));
  // Programmes during the week, each on its own line with its days.
  programmesOf(rec).forEach(p => { const v = programmeTotal(p); if (v > 0) shown.push({ label: programmeLabel(p), v }); });
  const total = shown.reduce((t, x) => t + x.v, 0);
  const body = shown.map(x => `•\t${x.label}\t${money(x.v)}`).join('\n');
  return `Funds received within the previous week amounted to GHS ${money(total)}.\n${body}`;
}

// ---- Giving per member (CLN's SO-2.1) --------------------------------------
//
// SO-2.1 asks for the "percentage increase in average weekly offertory per
// member" and the "percentage increase in average monthly tithe per member".
// Both have been typed by hand because nothing produced either figure. The
// weekly ledger supplies the numerator; AHRM's membership panel supplies the
// denominator.
//
// WHO COUNTS. "Per member" is not obvious: the roll includes 433 children,
// who do not tithe, so counting them roughly halves the answer. The basis is
// therefore a stored choice, not a guess baked into code, and the panel names
// the categories it counted so the figure can never be silently wrong about
// what it divided by. Default: everyone 18 and over.
const MEMBER_CATEGORIES = [
  { key: 'children', label: 'Children (up to 12)' },
  { key: 'juniorYouth', label: 'Junior Youth (12-18)' },
  { key: 'youth', label: 'Youth (18-30)' },
  { key: 'youngAdults', label: 'Young Adults (30-40)' },
  { key: 'adults', label: 'Adults (40+)' },
];
const DEFAULT_BASIS = ['youth', 'youngAdults', 'adults'];
const WEEKS_PER_MONTH = 52 / 12;

// Stored in the ordinary db store (not utils/settings.js, which writes to a
// hardcoded data/ path and so cannot be exercised against a test copy).
function config() {
  const rows = db.findAll('finance_config');
  if (rows.length) return rows[0];
  return db.insert('finance_config', {
    memberBasis: DEFAULT_BASIS.slice(),
    baseline: { offertoryPerMemberWeek: null, tithePerMemberMonth: null, label: 'January 2026' },
  });
}
function saveConfig(patch) {
  const c = config();
  return db.update('finance_config', c.id, patch);
}

// The membership figure to divide by: the most recent AHRM return at or
// before this quarter. Falls back to the latest of any quarter, because a
// slightly old roll is far better than no figure at all - and the panel says
// which quarter it came from.
function membersOnRoll(year, quarter, basis) {
  const rows = db.findAll('membership_quarterly').slice()
    .sort((a, b) => (a.year - b.year) || (a.quarter - b.quarter));
  if (!rows.length) return null;
  const upto = rows.filter(r => Number(r.year) < Number(year)
    || (Number(r.year) === Number(year) && Number(r.quarter) <= Number(quarter)));
  const rec = (upto.length ? upto[upto.length - 1] : rows[rows.length - 1]);
  const cats = rec.categories || {};
  const count = basis.reduce((t, k) => t + (Number(cats[k]) || 0), 0);
  return { count, from: `Q${rec.quarter} ${rec.year}`, stale: !upto.length || rec.year !== Number(year) || rec.quarter !== Number(quarter) };
}

// A TYPED figure for one quarter, where the weekly ledger cannot produce one.
//
// Q1 to Q3 2026 happened before any of this existed, so there is nothing to
// compute from - but the figures are known, and the report still needs them.
// So each measure, per quarter, is either computed or typed.
//
// The typed figure is stored SEPARATELY and never replaces the computed one.
// Both travel together to the page, so it can say which is in force, show
// what the other one would be, and switch back without anything being lost.
// Reverting is just clearing the override; the computation was never touched.
// This is the same bargain as the quarterly Finance panel's manual/weekly
// switch, and for the same reason: history must be enterable, and entering
// it must never damage what the software works out for itself.
function overrideFor(year, quarter) {
  return db.findOne('finance_permember', o => Number(o.year) === Number(year) && Number(o.quarter) === Number(quarter)) || null;
}
function setOverride(year, quarter, patch) {
  const existing = overrideFor(year, quarter);
  const clean = {};
  ['offertoryPerMemberWeek', 'tithePerMemberMonth', 'members'].forEach(k => {
    if (!(k in patch)) return;
    const v = patch[k];
    // null / '' clears that one field and hands it back to the computation.
    clean[k] = (v === null || v === undefined || v === '') ? null : (Number.isFinite(Number(v)) ? Number(v) : null);
  });
  if (!Object.keys(clean).length) return existing;
  return existing
    ? db.update('finance_permember', existing.id, clean)
    : db.insert('finance_permember', { year: Number(year), quarter: Number(quarter), ...clean });
}

// Averages, normalised per week so a part-finished quarter is not understated.
// A quarter with 4 confirmed Sundays gives the average of those 4 weeks, not
// a quarter's worth divided by 13.
function perMember(year, quarter) {
  const cfg = config();
  const basis = Array.isArray(cfg.memberBasis) && cfg.memberBasis.length ? cfg.memberBasis : DEFAULT_BASIS;
  const roll = membersOnRoll(year, quarter, basis);
  const sum = quarterSummary(year, quarter);
  const weeks = sum.confirmed;
  const offertory = sum.byFeed.offertory || 0;
  const tithes = sum.byFeed.tithes || 0;
  const can = !!(roll && roll.count > 0 && weeks > 0);
  const offPerWeek = can ? offertory / weeks / roll.count : null;
  const titPerMonth = can ? (tithes / weeks / roll.count) * WEEKS_PER_MONTH : null;
  const base = cfg.baseline || {};
  const pct = (now, was) => (now === null || !was || Number(was) <= 0) ? null : ((now - Number(was)) / Number(was)) * 100;

  const ov = overrideFor(year, quarter) || {};
  const computed = {
    members: roll ? roll.count : null,
    offertoryPerMemberWeek: offPerWeek,
    tithePerMemberMonth: titPerMonth,
  };
  // A typed figure wins only where one was actually typed. Each measure
  // decides for itself, so a quarter can have a typed tithe and a computed
  // offertory - which is exactly what happens when a record is half complete.
  const pick = k => (ov[k] === null || ov[k] === undefined) ? computed[k] : ov[k];
  const src = k => (ov[k] === null || ov[k] === undefined) ? 'computed' : 'typed';
  const effOff = pick('offertoryPerMemberWeek');
  const effTit = pick('tithePerMemberMonth');

  return {
    basis,
    basisLabels: basis.map(k => (MEMBER_CATEGORIES.find(c => c.key === k) || {}).label || k),
    members: pick('members'),
    membersFrom: roll ? roll.from : null,
    membersStale: roll ? roll.stale : false,
    weeksCounted: weeks,
    offertoryTotal: offertory, tithesTotal: tithes,
    offertoryPerMemberWeek: effOff,
    tithePerMemberMonth: effTit,
    // What the software works out, always returned even when overridden, so
    // the page can show what reverting would give you before you do it.
    computed,
    typed: {
      members: ov.members ?? null,
      offertoryPerMemberWeek: ov.offertoryPerMemberWeek ?? null,
      tithePerMemberMonth: ov.tithePerMemberMonth ?? null,
    },
    source: {
      members: src('members'),
      offertoryPerMemberWeek: src('offertoryPerMemberWeek'),
      tithePerMemberMonth: src('tithePerMemberMonth'),
    },
    baseline: { label: base.label || 'January 2026', offertoryPerMemberWeek: base.offertoryPerMemberWeek ?? null, tithePerMemberMonth: base.tithePerMemberMonth ?? null },
    offertoryIncreasePct: pct(effOff, base.offertoryPerMemberWeek),
    titheIncreasePct: pct(effTit, base.tithePerMemberMonth),
  };
}

// Running totals per line: this quarter and this year.
//
// The weekly form asks for Tithes every Sunday and, until now, showed the
// answer nowhere - the clerk could see one week at a time and had to go to
// the quarterly Finance panel, which only carries the lines that feed a box
// and only for one quarter. This is the plain running picture: every line,
// quarter to date and year to date.
//
// CONFIRMED WEEKS ONLY, deliberately - the same rule the quarter uses. A
// figure here and the figure in the report must never disagree. Weeks still
// waiting on the Treasurer are counted separately so the clerk can see the
// total is going to move.
function totals(year, quarter) {
  year = Number(year); quarter = Number(quarter);
  const defs = lines({ includeRetired: true });
  const all = db.findAll('finance_weekly', w => Number(w.year) === year);
  const confirmed = all.filter(w => w.status === 'confirmed');
  const inQ = confirmed.filter(w => Number(w.quarter) === quarter);
  const sumBy = rows => {
    const o = {};
    rows.forEach(w => {
      const a = amountsOf(w); defs.forEach(l => { const v = num(a[l.key]); if (v) o[l.key] = (o[l.key] || 0) + v; });
      const pv = programmesTotal(w); if (pv) o[PROGRAMME_LINE.key] = (o[PROGRAMME_LINE.key] || 0) + pv;
    });
    return o;
  };
  const q = sumBy(inQ), y = sumBy(confirmed);
  // Active lines always show, even at zero, so the clerk can see the line
  // exists. A RETIRED line only shows if it actually carries a figure this
  // year - otherwise the table fills up with history nobody needs.
  const rows = defs
    .filter(l => l.active !== false || q[l.key] || y[l.key])
    .map(l => ({ key: l.key, label: l.label, side: l.side, feeds: l.feeds || '',
      retired: l.active === false, quarter: q[l.key] || 0, year: y[l.key] || 0 }));
  // Programme offerings get their own row once there are any (they are not a stored line).
  if (q[PROGRAMME_LINE.key] || y[PROGRAMME_LINE.key]) {
    const at = rows.findIndex(r => r.side === 'out');
    rows.splice(at < 0 ? rows.length : at, 0, { key: PROGRAMME_LINE.key, label: PROGRAMME_LINE.label, side: 'in', feeds: PROGRAMME_LINE.feeds, retired: false, quarter: q[PROGRAMME_LINE.key] || 0, year: y[PROGRAMME_LINE.key] || 0 });
  }
  const tot = (side, k) => rows.filter(r => r.side === side && !(defs.find(d => d.key === r.key) || {}).isTotal)
    .reduce((t, r) => t + r[k], 0);
  return {
    year, quarter, lines: rows,
    receipts: { quarter: tot('in', 'quarter'), year: tot('in', 'year') },
    quarterConfirmed: inQ.length,
    quarterAwaiting: all.filter(w => Number(w.quarter) === quarter && w.status === 'entered').length,
    yearConfirmed: confirmed.length,
    sundaysInQuarter: sundaysInQuarter(year, quarter),
    sundaysInYear: sundaysInYear(year),
    // The FIRST and LAST Sunday actually on record. A "this year" column that
    // holds one quarter of a year is not wrong, but it reads as a full year
    // unless it says otherwise - and 2026 will only ever have a part-year,
    // because the weekly book starts in September. Say the period out loud.
    firstWeek: confirmed.length ? confirmed.map(w => w.date).sort()[0] : null,
    lastWeek: confirmed.length ? confirmed.map(w => w.date).sort().slice(-1)[0] : null,
  };
}

// Materialise a quarter from its confirmed weeks.
//
// The weekly ledger is the source of truth, but it is NOT read at report time.
// The summed figures are WRITTEN into finance_quarterly.earmarked instead, so
// every existing reader - the District workbook, the congregational report,
// the quarterly panel - keeps working untouched and cannot disagree with the
// panel about the same quarter. Same reasoning as the attendance-derived KPIs:
// materialise once, read everywhere.
//
// Only ever runs for a quarter someone has explicitly switched to 'weekly'.
// A quarter left on 'manual' - which is every quarter that existed before this
// was built - is never written to by this function. That is the whole
// safeguard: historic typed figures cannot be clobbered by an empty ledger.
function applyToQuarter(year, quarter) {
  const rec = db.findOne('finance_quarterly', f => Number(f.year) === Number(year) && Number(f.quarter) === Number(quarter));
  if (!rec || rec.source !== 'weekly') return null;
  const sum = quarterSummary(year, quarter);
  const earmarked = { ...(rec.earmarked || {}) };
  // Only the keys that are boxes on the panel. The goal-KPI feeds
  // (higherCourts, kutunse) are carried by the entry page, not stored here.
  Object.entries(sum.byFeed).forEach(([k, v]) => { if (!GOAL_FEEDS.includes(k)) earmarked[k] = v; });
  // A target with no confirmed figure this quarter reads zero, not stale.
  Object.keys(FEED_TARGETS).forEach(k => {
    if (!k || GOAL_FEEDS.includes(k)) return;
    if (!(k in sum.byFeed)) earmarked[k] = 0;
  });
  return db.update('finance_quarterly', rec.id, { earmarked, weeklyAppliedAt: new Date().toISOString() });
}

module.exports = {
  FEED_TARGETS, DEFAULT_LINES, EARMARKED_KEYS, GOAL_FEEDS,
  lines, num, quarterOf, yearOf, receiptsTotal, validate, isAnnounced,
  PROGRAMME_LINE, programmesTotal, programmeTotal, cleanProgrammes, weekDays, daysLabel, programmeLabel,
  quarterSummary, sundaysInQuarter, sundaysInYear, announcementText, money, applyToQuarter, totals,
  MEMBER_CATEGORIES, DEFAULT_BASIS, config, saveConfig, membersOnRoll, perMember, overrideFor, setOverride,
};
