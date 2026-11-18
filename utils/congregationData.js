// Assembles the consolidated congregational quarterly report (AOT format):
// every committee's goals with the selected quarter's values, membership
// statistics, congregation-level narrative, Session Clerk + Minister sigs.
const db = require('./db');
const OT = require('./officeTerms');
const { getSettings } = require('./settings');

function ordinal(q) { return ['1st', '2nd', '3rd', '4th'][q - 1]; }

const SECTION_ORDER = [
  { code: 'OG', title: 'Overarching Goals - Agent in Charge' },
  { code: 'ME', title: 'Committee on Mission and Evangelism' },
  { code: 'AHRM', title: 'Committee on Administration and Human Resource Management' },
  { code: 'PDBP', title: 'Committee on Physical Development, Building and Property' },
  { code: 'ESR', title: 'Committee on Ecumenical and Social Relations' },
  { code: 'DSS', title: 'Committee on Development and Social Services' },
  { code: 'Wel', title: 'Committee on Welfare' },
  { code: 'Fin', title: 'Committee on Finance' },
  { code: 'Edu', title: 'Committee on Education' },
  { code: 'Sch', title: 'Committee on Scholarships' },
  { code: 'CLN', title: 'Committee on Church Life and Nurture' },
  { code: 'CFL', title: 'Committee on Counselling and Family Life' },
];

function assembleCongregation({ year, quarter }) {
  year = Number(year); quarter = Number(quarter);
  const settings = getSettings();
  const goals = db.findAll('goals', g => g.year === year && g.source !== 'committee_tor' && (g.ownerType === 'committee' || g.ownerType === 'congregation'));
  const entries = db.findAll('kpi_entries', e => e.year === year && e.quarter === quarter);
  // A goal the committee shares with the groups is reported by the committee on
  // everyone's behalf. Same helper the committee's own report and the District
  // Excel use — computing it separately here is how three documents end up
  // disagreeing about one goal.
  const { reportedValue } = require('./goalRollup');
  const allGoalsThisYear = db.findAll('goals', g => g.year === year);
  const allEntriesThisYear = db.findAll('kpi_entries', e => e.year === year);

  const sections = SECTION_ORDER.map(sec => {
    const secGoals = goals.filter(g => g.ownerCode === sec.code && (g.source === 'tyrp' || g.source === 'merged'));
    const rows = [];
    secGoals.forEach(g => {
      const entry = entries.find(e => e.goalId === g.id);
      (g.kpis || []).forEach((k, i) => {
        if (k.origin === 'so') return; // strategic add-ons stay out of the District-format tables
        const own = entry && entry.values ? (entry.values[i] !== undefined ? entry.values[i] : null) : null;
        rows.push({
          code: i === 0 ? g.code : '', goal: i === 0 ? g.description : '',
          kpi: k.description, unit: k.unit || '',
          value: reportedValue(g, i, { year, quarter, ownValue: own, allGoals: allGoalsThisYear, allEntries: allEntriesThisYear }),
        });
      });
    });
    return { ...sec, rows };
  }).filter(s => s.rows.length);

  // Membership statistics table: one row per quarter to date, category columns + total
  const CAT_COLS = [
    ['children', 'Children'], ['juniorYouth', 'Junior Youth'], ['youth', 'Youth'],
    ['youngAdults', 'Young Adults'], ['adults', 'Adults'],
  ];
  const membershipTable = { header: ['Quarter', ...CAT_COLS.map(c => c[1]), 'Total'], rows: [] };
  for (let q = 1; q <= quarter; q++) {
    const m = db.findOne('membership_quarterly', x => x.year === year && x.quarter === q);
    if (m && m.categories) {
      const vals = CAT_COLS.map(([k]) => Number(m.categories[k]) || 0);
      const total = vals.reduce((a, b) => a + b, 0);
      if (total) membershipTable.rows.push([`${ordinal(q)} Quarter ${year}`, ...vals.map(v => v.toLocaleString()), total.toLocaleString()]);
    }
  }

  const narrative = db.findOne('narratives', n => n.year === year && n.quarter === quarter && n.entityType === 'congregation') || {};
  const submissions = db.findAll('submissions', s => s.year === year && s.quarter === quarter && s.status === 'submitted');

  // Roll up attendance flags across every committee & group for the Session.
  const { entityAttendance } = require('./attendanceStats');
  const attendanceFlags = [];
  ['committee', 'group'].forEach(type => {
    db.findAll(type === 'committee' ? 'committees' : 'groups', e => e.active !== false).forEach(e => {
      const st = entityAttendance(type, e.id, { year, quarter });
      st.flagged.forEach(m => attendanceFlags.push({
        entity: e.name, member: m.name, position: m.position, flag: m.flag,
        consecutiveAbsences: m.consecutiveAbsences, pct: m.pct,
      }));
    });
  });
  attendanceFlags.sort((a, b) => (a.flag === b.flag ? 0 : a.flag === 'red' ? -1 : 1));

  return {
    year, quarter, ordinal: ordinal(quarter),
    congregationName: settings.companyName,
    // Whoever held the office at the END OF THE QUARTER the report is for —
    // so a second-quarter report printed after a new District Minister is
    // inducted still carries the name of the man who served that quarter.
    // settings.* remains the fallback until office terms are recorded.
    sessionClerk: OT.nameOn('session_clerk', OT.quarterEndDay(year, quarter)) || settings.sessionClerk || '',
    minister: OT.nameOn('district_minister', OT.quarterEndDay(year, quarter)) || settings.minister || '',
    membershipTable, narrative, sections,
    committeeSubmissions: submissions.length,
    attendanceFlags,
  };
}

module.exports = { assembleCongregation };
