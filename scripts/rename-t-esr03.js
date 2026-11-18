// One-off migration: rename goal T-ESR-03 to T-ESR-02 (fills the gap left
// when the old T-ESR-02 was merged into ESR-02 — see merge-esr02.js).
// Goals are referenced everywhere by numeric id, not code, so renaming the
// code is display-only and safe.
//
// Idempotent: run from the app root:  node scripts/rename-t-esr03.js
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const db = require('../utils/db');

if (db.findOne('goals', g => g.code === 'T-ESR-02')) {
  console.log('A goal with code T-ESR-02 already exists — nothing to do.');
  process.exit(0);
}
const goal = db.findOne('goals', g => g.code === 'T-ESR-03');
if (!goal) { console.log('T-ESR-03 not found — already renamed. Nothing to do.'); process.exit(0); }

db.update('goals', goal.id, { code: 'T-ESR-02' });
console.log(`Renamed T-ESR-03 (id ${goal.id}) to T-ESR-02: "${goal.description.slice(0, 70)}..."`);
