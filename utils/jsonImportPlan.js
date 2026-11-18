// Reading an old JSON collection file: what would be stored, without storing
// anything. Shared by utils/db.js (the real import) and
// scripts/sqlite-import.js --check (the look-first on the server), so the two
// cannot disagree. Requires nothing but fs — it never opens the database.
const fs = require('fs');
const path = require('path');

function jsonCollections(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^[A-Za-z0-9_-]+\.json$/.test(f))
    .map(f => f.replace(/\.json$/, ''))
    .filter(c => c !== 'settings');
}

// Read one JSON collection file and work out exactly what will be stored.
// Pure: changes nothing. Used by the import below and by
// scripts/sqlite-import.js --check, so the check and the real thing agree.
//   - records without an id, or repeating an id already seen, get the next
//     free id (the JSON store could never find them by id anyway) — reported;
//   - a file that is not valid JSON, or not a list, is an error: nothing of
//     that collection is imported, and the caller decides what to do.
function planCollection(collection, dir) {
  const fp = path.join(dir, `${collection}.json`);
  const raw = fs.readFileSync(fp, 'utf8').trim();
  if (!raw) return { collection, rows: [], reassigned: [], error: null, source: fp };
  let list;
  try { list = JSON.parse(raw); } catch (e) { return { collection, error: `not valid JSON (${e.message})`, source: fp }; }
  if (!Array.isArray(list)) return { collection, error: 'not a list of records', source: fp };
  const seen = new Set();
  let max = list.reduce((m, r) => (r && Number.isInteger(Number(r.id)) && r.id !== null && r.id !== '' ? Math.max(m, Number(r.id)) : m), 0);
  const rows = [], reassigned = [];
  list.forEach((r, i) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) { reassigned.push({ index: i, from: null, to: null, why: 'not a record — skipped' }); return; }
    let id = r.id === null || r.id === undefined || r.id === '' ? NaN : Number(r.id);
    if (!Number.isInteger(id) || seen.has(id)) {
      const to = ++max;
      reassigned.push({ index: i, from: r.id === undefined ? null : r.id, to, why: Number.isInteger(id) ? 'repeated id' : 'no id' });
      id = to;
    }
    seen.add(id);
    rows.push({ id, doc: JSON.stringify({ ...r, id }) });
  });
  return { collection, rows, reassigned, error: null, source: fp };
}


module.exports = { jsonCollections, planCollection };
