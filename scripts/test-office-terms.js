// Who signs a document, and when.
//
//   node scripts/test-office-terms.js
//
// A document is signed by whoever held the office ON THE DATE THE DOCUMENT IS
// ABOUT, not by whoever holds it on the day it is printed. This drives the
// real case: a District Minister is transferred, a successor is inducted, and
// afterwards the minutes of an earlier sitting and the earlier quarter's
// report must still carry the first man's name.
//
// It runs against a throwaway data directory and never touches live records.
const os = require('os'), path = require('path'), fs = require('fs');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aotc-ot-'));
process.env.AOTC_DATA_DIR = DATA;
process.env.TZ = process.env.TZ || 'Africa/Accra';

const OT = require('../utils/officeTerms');
const db = require('../utils/db');

let pass = 0, fail = 0;
function check(what, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ok    ${what}`); }
  else { fail++; console.log(`  FAIL  ${what}\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`); }
}

const OLD = 'Rev Joseph Richmond Tettey';
const NEW = 'Rev Emmanuel Nii Ayi Mensah';
const HANDOVER = '2026-09-14';

// ---- 1. Back-fill: the sitting minister, with no invented start date -------
OT.seedFrom({
  district_minister: { id: 1, name: OLD, titles: ['Rev'] },
  session_clerk: { id: 2, name: 'Gideon Adjiereh Adjei' },
});
check('back-fill records one open term', OT.termsFor('district_minister').length, 1);
check('it has no start date — "since before the record began"', OT.termsFor('district_minister')[0].from, null);
check('a minutes date from before the app existed still resolves', OT.nameOn('district_minister', '2024-01-15'), OLD);
check('seeding twice does not duplicate', OT.seedFrom({ district_minister: { id: 1, name: OLD } }).length, 0);

// ---- 2. The handover -------------------------------------------------------
const r = OT.confer('district_minister', { id: 9, name: NEW, titles: ['Rev'] }, HANDOVER);
check('the outgoing term is closed on the handover date', r.closed.to, HANDOVER);
check('the new term opens on the handover date', r.opened.from, HANDOVER);
check('there are now two terms', OT.termsFor('district_minister').length, 2);

// ---- 3. The boundary -------------------------------------------------------
check('the day before the handover is the outgoing minister', OT.nameOn('district_minister', '2026-09-13'), OLD);
check('the handover day itself is the new minister (he was inducted)', OT.nameOn('district_minister', HANDOVER), NEW);
check('the day after is the new minister', OT.nameOn('district_minister', '2026-09-15'), NEW);
check('a year earlier is still the outgoing minister', OT.nameOn('district_minister', '2025-09-15'), OLD);

// ---- 4. Quarterly reports, printed AFTER the handover ----------------------
// This is the case a snapshot-at-lock-time would have got wrong: the report is
// compiled late, so the name must come from the quarter, not from today.
check('Q1 2026 report signs with the outgoing minister', OT.nameOn('district_minister', OT.quarterEndDay(2026, 1)), OLD);
check('Q2 2026 report signs with the outgoing minister', OT.nameOn('district_minister', OT.quarterEndDay(2026, 2)), OLD);
check('Q3 2026 ends 30 Sep, after the 14 Sep handover, so it signs with the new minister',
  OT.nameOn('district_minister', OT.quarterEndDay(2026, 3)), NEW);
check('Q4 2026 signs with the new minister', OT.nameOn('district_minister', OT.quarterEndDay(2026, 4)), NEW);

// ---- 5. The outgoing man leaves the roster entirely ------------------------
// A transferred minister is taken off the Session. His name must survive on
// the terms, or every document he signed would reprint blank.
db.remove('session_members', 1);
check('his name still prints on an earlier sitting after he is off the roster',
  OT.nameOn('district_minister', '2026-06-10'), OLD);

// ---- 6. Corrections, while the term is still open -------------------------
// The induction date is often typed in a day or two late, then corrected.
OT.confer('district_minister', { id: 9, name: NEW }, '2026-09-10');
check('re-conferring on the same open term corrects the date instead of opening a second',
  OT.termsFor('district_minister').length, 2);
check('and the corrected date takes effect', OT.nameOn('district_minister', '2026-09-11'), NEW);
check('so the day before it is the outgoing minister again', OT.nameOn('district_minister', '2026-09-09'), OLD);

// ---- 7. Vacancy, and a return ---------------------------------------------
OT.vacate('district_minister', '2026-12-31');
check('after the office falls vacant there is no name to print', OT.nameOn('district_minister', '2027-01-05'), '');
check('but the past is unchanged', OT.nameOn('district_minister', '2026-10-01'), NEW);
// Re-appointing the same man AFTER a vacancy is a genuine second term, not a
// correction — the gap is part of the record and must not be papered over.
OT.confer('district_minister', { id: 9, name: NEW }, '2027-03-01');
check('re-appointment after a vacancy opens a third term', OT.termsFor('district_minister').length, 3);
check('the vacancy itself still reads as vacant', OT.nameOn('district_minister', '2027-02-01'), '');
check('and the new spell reads correctly', OT.nameOn('district_minister', '2027-03-02'), NEW);

// ---- 8. Offices are independent -------------------------------------------
check('the Session Clerk is untouched by a minister changing',
  OT.nameOn('session_clerk', '2026-10-01'), 'Gideon Adjiereh Adjei');
check('an office never held returns nothing rather than guessing',
  OT.nameOn('treasurer', '2026-10-01'), '');

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
