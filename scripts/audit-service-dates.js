// AOTC Track — did any Sunday's figures get filed under the wrong day?
//
// Read-only. Before the date fix, the Sunday grid pre-filled its date field
// with `valueAsDate`, which WRITES the UTC day: from 20:00 onward on a machine
// at UTC-4 the field offered tomorrow, so a Sunday-evening entry could be
// saved against the Monday. This lists any service record that does not fall
// on a Sunday, so the Clerk can re-date it by hand.
//
// Run it where the live data is:
//   ssh deploy@172.93.52.195
//   sudo -u aotc node /opt/aotc-track/scripts/audit-service-dates.js

const fs = require('fs');
const path = require('path');
const { isSunday, fmtDay } = require('../utils/dates');

const DATA = process.env.AOTC_DATA_DIR || path.join(__dirname, '..', 'data');
const read = f => {
  const p = path.join(DATA, f);
  if (!fs.existsSync(p)) return [];
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j) ? j : (Object.values(j).find(Array.isArray) || []);
  } catch (e) { console.error(`could not read ${f}: ${e.message}`); return []; }
};

console.log(`data: ${DATA}\n`);
let problems = 0;

for (const file of ['service_attendance.json', 'service_days.json']) {
  const rows = read(file);
  const bad = rows.filter(r => r && r.date && !isSunday(r.date));
  console.log(`${file}: ${rows.length} record(s), ${bad.length} not on a Sunday`);
  bad.forEach(r => {
    problems++;
    console.log(`  ${r.date} (${fmtDay(r.date)})` +
      `${r.service ? ' service=' + r.service : ''}${r.status ? ' status=' + r.status : ''}` +
      `${r.enteredBy ? ' by ' + r.enteredBy : ''} id=${r.id}`);
  });
  // A Sunday recorded twice under the same service is the other shape this
  // took: the real day plus its neighbour.
  const seen = {};
  rows.forEach(r => { if (r && r.date) { const k = r.date + '|' + (r.service || ''); seen[k] = (seen[k] || 0) + 1; } });
  Object.entries(seen).filter(([, n]) => n > 1)
    .forEach(([k, n]) => { problems++; console.log(`  duplicate: ${k} appears ${n} times`); });
}

// Adjacent days both carrying figures is the fingerprint worth a human look.
const svc = read('service_attendance.json').filter(r => r && r.date);
const days = [...new Set(svc.map(r => r.date))].sort();
for (let i = 1; i < days.length; i++) {
  const a = new Date(days[i - 1] + 'T00:00:00Z'), b = new Date(days[i] + 'T00:00:00Z');
  if ((b - a) / 864e5 === 1) {
    problems++;
    console.log(`\nadjacent days both hold figures: ${days[i - 1]} and ${days[i]} — check whether one is a mis-dated copy of the other`);
  }
}

console.log(problems
  ? `\n${problems} thing(s) to look at.`
  : '\nNothing mis-dated: every service record falls on a Sunday, with no duplicates or adjacent pairs.');
