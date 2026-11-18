// The way back: write every collection in the database out as
// <folder>/<collection>.json, in the JSON store's own format.
//
//   node scripts/sqlite-export.js /tmp/aotc-json        # anywhere, to look at
//   sudo -u aotc env NODE_ENV=production node scripts/sqlite-export.js /opt/aotc-track/data   # to return to the JSON code
//   (on a laptop the store only opens a throwaway copy: AOTC_DATA_DIR=<copy>, see utils/db.js)
//
// Stop the app before exporting into its own data/ folder — the JSON code reads
// those files only when it starts — and move aotc.db* aside, or the SQLite code
// would simply carry on from the database next time.
const path = require('path');
const dest = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node scripts/sqlite-export.js <folder>'); process.exit(1); }
const db = require('../utils/db');
const done = db.exportJson(dest);
db.collections().forEach(({ collection, n }) => console.log(`  ${collection.padEnd(28)} ${String(n).padStart(6)}`));
console.log(`\n${done.length} collections written to ${dest}`);
