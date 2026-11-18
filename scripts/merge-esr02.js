// One-off migration: merge goal T-ESR-02 ("Participate in Bible Week and
// Local Council of Churches celebrations") INTO ESR-02 ("Participation in
// Local Council of Churches (LCC) programs is promoted") — they cover the
// same TOR mandate. Any activities or KPI entries pointing at T-ESR-02 are
// repointed to ESR-02, ESR-02's description absorbs the Bible Week wording,
// and T-ESR-02 is removed.
//
// Idempotent: safe to run more than once (does nothing if already merged).
// Run from the app root:  node scripts/merge-esr02.js
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const db = require('../utils/db');

const keep = db.findOne('goals', g => g.code === 'ESR-02');
const drop = db.findOne('goals', g => g.code === 'T-ESR-02');

if (!keep) { console.log('ESR-02 not found — nothing to do.'); process.exit(0); }
if (!drop) { console.log('T-ESR-02 not found — already merged. Nothing to do.'); process.exit(0); }

let moved = 0;
db.findAll('activities', a => a.goalId === drop.id).forEach(a => { db.update('activities', a.id, { goalId: keep.id }); moved++; });
db.findAll('kpi_entries', e => e.goalId === drop.id).forEach(e => { db.update('kpi_entries', e.id, { goalId: keep.id }); moved++; });

db.update('goals', keep.id, {
  description: 'Participation in Bible Week and Local Council of Churches (LCC) programs and celebrations is promoted',
});
db.remove('goals', drop.id);

console.log(`Merged T-ESR-02 (id ${drop.id}) into ESR-02 (id ${keep.id}); ${moved} record(s) repointed; description updated.`);
