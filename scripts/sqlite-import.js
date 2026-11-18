// Look before the move to SQLite: what the first start of the new code will
// read from each JSON file. It only READS — it never opens or creates the
// database and never moves a file — so it is safe on the live server:
//
//   node scripts/sqlite-import.js /opt/aotc-track/data
//
// Prints each collection with its record count, any record that will get a new
// id (none had one, or it repeated another's — the JSON store could not find
// those by id either), and any file that cannot be read. A file that cannot be
// read stops the app at start-up rather than letting it run without that
// collection, so fix it first. Exit code 1 if there is one.
const path = require('path');
const fs = require('fs');
const { jsonCollections, planCollection } = require('../utils/jsonImportPlan');
const dir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'data'));
if (!fs.existsSync(dir)) { console.error(`No such folder: ${dir}`); process.exit(1); }
const dbFile = path.join(dir, 'aotc.db');
console.log(`JSON collections in ${dir}${fs.existsSync(dbFile) ? `  (aotc.db already exists there: a collection that already has rows is NOT read again)` : ''}\n`);
let total = 0, errors = 0, moved = 0;
const names = jsonCollections(dir).sort();
names.forEach(c => {
  const p = planCollection(c, dir);
  if (p.error) { errors++; console.log(`  ✗ ${c}: ${p.error}`); return; }
  total += p.rows.length;
  console.log(`  ${c.padEnd(28)} ${String(p.rows.length).padStart(6)}`);
  p.reassigned.forEach(x => { moved++; console.log(`      record #${x.index}${x.from !== null ? ` (id ${JSON.stringify(x.from)})` : ''}: ${x.why}${x.to ? ` → id ${x.to}` : ''}`); });
});
console.log(`\n${names.length} collections, ${total} records${moved ? `, ${moved} given a new id` : ''}${errors ? `, ${errors} FILE(S) THAT CANNOT BE READ — fix before deploying` : ' — ready'}.`);
process.exit(errors ? 1 : 0);
