// The figure on screen and the figure in the report must be the same figure.
//
// Reproduces the Women's Fellowship Q3 2026 fault: the entry page showed an
// average attendance of 46 from 12 recorded meetings, and the exported report
// printed 0, because the derived value was only ever written into kpi_entries
// as a side-effect of having the page open while the quarter was unlocked.
process.env.AOTC_DATA_DIR = process.env.AOTC_DATA_DIR || (process.env.HOME + '/sbx');
const path = require('path');
const root = path.join(__dirname, '..');
const db = require(path.join(root, 'utils/db'));
const { statsFor, derivedKpiValue } = require(path.join(root, 'utils/derivedKpi'));
const { assemble } = require(path.join(root, 'utils/reportData'));
const { rollupForGoal } = require(path.join(root, 'utils/goalRollup'));

let fail = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const head = t => console.log('\n── ' + t);

const YEAR = 2026, Q = 3;
const wf = db.findOne('groups', g => g.code === 'WF');
const cln = db.findOne('committees', c => c.code === 'CLN');

head('Record 12 Women’s Fellowship meetings totalling 556');
db.findAll('group_attendance', r => Number(r.entityId) === wf.id && Number(r.year) === YEAR)
  .forEach(r => db.update('group_attendance', r.id, { year: 1990 }));
const per = [46, 46, 47, 45, 46, 48, 44, 46, 47, 45, 48, 48]; // 556
per.forEach((v, i) => db.insert('group_attendance', {
  entityType: 'group', entityId: wf.id, ownerCode: 'WF',
  date: `2026-07-${String(5 + i).padStart(2, '0')}`, year: YEAR, quarter: Q,
  membersMale: 0, membersFemale: v, onlineMale: 0, onlineFemale: 0,
}));
const st = statsFor('group', wf.id, YEAR, Q);
ok(st.groupAttendance.quarter.count === 12 && st.groupAttendance.quarter.total === 556,
   `12 meetings, 556 in total`);
ok(st.groupAttendance.quarter.average === 46, `average 46 — the figure the clerk saw on screen`);

head('The quarter is SUBMITTED AND LOCKED, and nothing is stored');
const goal = db.findOne('goals', g => g.year === YEAR && g.code === 'CLN-02' && g.ownerCode === 'WF');
db.findAll('kpi_entries', e => e.goalId === goal.id && Number(e.quarter) === Q)
  .forEach(e => db.update('kpi_entries', e.id, { values: [0, null] }));
if (!db.findOne('kpi_entries', e => e.goalId === goal.id && Number(e.quarter) === Q)) {
  db.insert('kpi_entries', { year: YEAR, quarter: Q, goalId: goal.id, entityType: 'group', entityId: wf.id, ownerCode: 'WF', values: [0, null] });
}
db.findAll('submissions', s => s.year === YEAR && s.quarter === Q && s.entityType === 'group' && Number(s.entityId) === wf.id)
  .forEach(s => db.update('submissions', s.id, { status: 'submitted' }));
if (!db.findOne('submissions', s => s.year === YEAR && s.quarter === Q && s.entityType === 'group' && Number(s.entityId) === wf.id)) {
  db.insert('submissions', { year: YEAR, quarter: Q, entityType: 'group', entityId: wf.id, ownerCode: 'WF', status: 'submitted', submittedBy: 'Mavis Perbi', submittedAt: '2026-10-02T09:00:00Z' });
}
const stored = db.findOne('kpi_entries', e => e.goalId === goal.id && Number(e.quarter) === Q);
ok(stored && Number(stored.values[0]) === 0, 'the stored figure is 0 — exactly the fault reported');

head('The report must still print 46');
const data = assemble({ year: YEAR, quarter: Q, entityType: 'group', entityId: wf.id });
const row = (data.kpiTable || []).find(r => r.code === 'CLN-02' && /average attendance/i.test(r.kpi || ''));
ok(!!row, 'CLN-02 Average Attendance is on the report');
console.log('    report row quarters:', JSON.stringify(row && row.quarters));
ok(row && Number(row.quarters[Q - 1]) === 46, `Q${Q} prints 46, not 0 (got ${row && row.quarters[Q - 1]})`);
ok(row && row.quarters.filter((v, i) => i !== Q - 1).every(v => v === null || v === undefined || Number(v) === 0),
   'and the derivation did not leak into the other quarters');

head('Direct derivation, for completeness');
ok(derivedKpiValue(goal, 0, { year: YEAR, quarter: Q, entityType: 'group', entityId: wf.id }) === 46,
   'derivedKpiValue returns 46 for the group’s own copy');
const parent = db.findOne('goals', g => g.year === YEAR && g.code === 'CLN-02' && g.ownerType === 'committee');
ok(derivedKpiValue(parent, 0, { year: YEAR, quarter: Q, entityType: 'committee', entityId: cln.id }) === null,
   'and null for CLN’s parent copy — that figure belongs to the roll-up');

head('Church Life and Nurture’s roll-up picks the real figure up too');
const roll = rollupForGoal(parent, { year: YEAR, quarter: Q });
const contrib = roll && roll.kpis[0].quarters[Q - 1].contributions.find(c => c.ownerCode === 'WF');
ok(contrib && contrib.value === 46, `WF contributes 46 to the congregation total (got ${contrib && contrib.value})`);
ok(roll.kpis[0].quarters[Q - 1].total >= 46, 'so the total is no longer short by that group');

console.log(`\n${n - fail}/${n} checks — ${fail ? fail + ' FAILED (above)' : 'all green'}`);
process.exit(fail ? 1 : 0);
