// AOTC Track datastore — SQLite since Oct 2026 (it was one JSON file per
// collection before).
//
// WHY: the JSON store's insert() (max(id) + 1) and mutate() (read, modify,
// write) are safe only inside ONE process. Blue-green deploys put two
// processes on the same records for a few seconds at every switch, and a
// maintenance script or a backup is another. IFAIMA measured the JSON store
// with two writers and it kept 163 of 300 records; SQLite kept all 300. SQLite
// in WAL mode locks across processes, and every write here runs inside
// BEGIN IMMEDIATE (utils/sqliteDatastore.js, from @deontech/db 0.4.1).
//
// THE CONTRACT DID NOT CHANGE. insert, findAll, findOne, findById, update,
// remove, mutate, readAll and writeAll behave as before — same ids, same
// order (insertion order), same createdAt/updatedAt stamps — so no route
// changed. Each record is one row of the `records` table, its document held
// as JSON, so a new field still needs no migration.
//
// WHERE: data/aotc.db (DB_PATH overrides it), so the deploy excludes, the
// blue-green symlinks and the systemd ReadWritePaths all still apply.
// AOTC_DATA_DIR still points the whole store at a throwaway folder (tests).
//
// THE OLD JSON FILES: when the database is opened and a collection has no rows
// but data/<collection>.json exists, that file is read into the database — in
// order, in one transaction — and moved to data/json-before-sqlite/. On the
// server this happens once, at the first start of this code; on a laptop or in
// a test it picks up whatever JSON files are in the folder. Nothing is ever
// read from a JSON file again once its collection has rows. settings.json is
// not a collection (utils/settings.js keeps it) and is left alone.
//
// To go back to the JSON store: scripts/sqlite-export.js writes every
// collection out as data/<collection>.json again.
const fs = require('fs');
const path = require('path');

// node:sqlite labels itself experimental and says so once per process. It is
// what IFAIMA runs on; the warning is noise in the logs, so only that one is
// dropped.
const _emit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] && rest[0].type);
  if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning && warning.message || warning))) return;
  return _emit.call(process, warning, ...rest);
};
const { createSqliteDatastore } = require('./sqliteDatastore');

const DATA_DIR = process.env.AOTC_DATA_DIR
  ? path.resolve(process.env.AOTC_DATA_DIR)
  : path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.join(DATA_DIR, 'aotc.db');
const ARCHIVE_DIR = path.join(DATA_DIR, 'json-before-sqlite');
const NOT_COLLECTIONS = new Set(['settings']);

// The database is opened on first use, not when this file is required:
// plenty of code requires db only for constants, and opening means creating
// data/aotc.db and reading the JSON files in.
//
// SAFETY ON A LAPTOP: the project's own data/ lives in OneDrive and is a copy
// of the server's records. Outside production the store therefore opens it
// only when asked to (AOTC_LOCAL_DB=1); tests and tools point AOTC_DATA_DIR or
// DB_PATH at a throwaway copy, and anything else gets a clear error instead of
// quietly turning the local copy into a database. (Found 9 Oct 2026, when a
// page test that only needed a list of names opened the local data/.)
const IS_PROD = process.env.NODE_ENV === 'production';
const DEFAULT_DIR = !process.env.AOTC_DATA_DIR && !process.env.DB_PATH;
let store = null, COUNT, INS;
function open() {
  if (store) return store;
  if (!IS_PROD && DEFAULT_DIR && process.env.AOTC_LOCAL_DB !== '1') {
    throw new Error(`[db] Not opening ${DB_PATH}: outside production the records are only opened from a throwaway copy. ` +
      'Set AOTC_DATA_DIR to a copy of data/ (the tests do), or AOTC_LOCAL_DB=1 to really use this folder.');
  }
  if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  // WAL needs a real local disk; the server's data/ is one. A synced folder
  // (OneDrive) is not: in production that is refused, because a sync client
  // copying a live database corrupts it; on a laptop the store falls back to
  // SQLite's ordinary journal (one process at a time) and says so.
  try {
    store = createSqliteDatastore({ dbPath: DB_PATH });
  } catch (e) {
    if (IS_PROD || !/WAL mode/.test(e.message)) throw e;
    console.warn(`[db] ${DB_PATH} is not on a local disk (synced folder?) — running without WAL. Fine for one process on a laptop; never for the server.`);
    store = createSqliteDatastore({ dbPath: DB_PATH, requireWal: false });
  }
  COUNT = store.connection.prepare('SELECT COUNT(*) AS n FROM records WHERE collection = ?');
  INS = store.connection.prepare('INSERT INTO records (collection, id, doc) VALUES (?, ?, ?)');
  jsonCollections().forEach(ensure);
  if (importLog.length && !process.env.AOTC_DATA_DIR) {
    const report = `Read into ${DB_PATH} on ${new Date().toISOString()}:\n` + importLog.map(l => '  ' + l).join('\n') + '\n';
    try { fs.mkdirSync(ARCHIVE_DIR, { recursive: true }); fs.appendFileSync(path.join(ARCHIVE_DIR, 'IMPORTED.txt'), report); } catch (e) {}
    console.log(`[db] JSON files read into the database (moved to ${ARCHIVE_DIR}):\n` + importLog.map(l => '  ' + l).join('\n'));
  }
  return store;
}

// ---- reading the old JSON files in ------------------------------------------
const importLog = [];

const { jsonCollections: _jc, planCollection: _pc } = require('./jsonImportPlan');
const jsonCollections = (dir = DATA_DIR) => _jc(dir).filter(c => !NOT_COLLECTIONS.has(c));
const planCollection = (collection, dir = DATA_DIR) => _pc(collection, dir);

function importCollection(collection) {
  const plan = planCollection(collection);
  if (plan.error) {
    // Refuse to start rather than run on an empty collection: an app that
    // shows no members and starts writing new ones would be worse than one
    // that does not start. scripts/sqlite-import.js --check finds this first.
    throw new Error(`[db] ${collection}.json could not be read into the database: ${plan.error}. Nothing was changed. Fix or remove ${plan.source}.`);
  }
  store.transaction(() => {
    if (COUNT.get(collection).n) return;            // another process got there first
    plan.rows.forEach(r => INS.run(collection, r.id, r.doc));
  });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  let dest = path.join(ARCHIVE_DIR, `${collection}.json`);
  if (fs.existsSync(dest)) dest = path.join(ARCHIVE_DIR, `${collection}.${Date.now()}.json`);
  fs.renameSync(plan.source, dest);
  const line = `${collection}: ${plan.rows.length} record${plan.rows.length === 1 ? '' : 's'}` +
    (plan.reassigned.length ? ` (${plan.reassigned.length} given a new id: ${plan.reassigned.map(x => `#${x.index}${x.from !== null ? ' id ' + x.from : ''} → ${x.to}`).join(', ')})` : '');
  importLog.push(line);
  return line;
}

// A collection's JSON file is read in the first time the collection is used
// with no rows (and at start-up, for all of them at once).
const checked = new Set();
function ensure(collection) {
  if (checked.has(collection)) return;
  checked.add(collection);
  if (NOT_COLLECTIONS.has(collection)) return;
  const fp = path.join(DATA_DIR, `${collection}.json`);
  if (fs.existsSync(fp) && !COUNT.get(collection).n) importCollection(collection);
}

// ---- the contract -----------------------------------------------------------
const wrap = name => (collection, ...args) => { const st = open(); ensure(collection); return st[name](collection, ...args); };

// Every collection that has records, with its count — for backups and checks.
function collections() {
  return open().sql.all('SELECT collection, COUNT(*) AS n FROM records GROUP BY collection ORDER BY collection');
}

// A consistent copy of the whole database at `dest` (a new file), taken while
// the app keeps running. A plain file copy of a WAL database can be torn.
function snapshot(dest) {
  // Never at, or through a link to, the live database (9 Oct 2026: a backup
  // folder that was a symlink to data/ made this delete and replace the live
  // file while the app held it open).
  const realOf = p => { try { return fs.realpathSync(p); } catch (e) { return null; } };
  const liveReal = realOf(DB_PATH) || path.resolve(DB_PATH);
  const destDirReal = realOf(path.dirname(dest)) || path.resolve(path.dirname(dest));
  const destReal = path.join(destDirReal, path.basename(dest));
  if (destReal === liveReal || destDirReal === (realOf(path.dirname(DB_PATH)) || path.resolve(path.dirname(DB_PATH)))) {
    throw new Error(`[db] refusing to snapshot to ${dest}: that is the live database folder`);
  }
  if (fs.existsSync(dest)) fs.rmSync(dest);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  open().connection.exec(`VACUUM INTO '${String(dest).replace(/'/g, "''")}'`);
  return dest;
}

// Every collection as <dir>/<collection>.json, in the JSON store's format.
function exportJson(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  collections().forEach(({ collection }) => {
    fs.writeFileSync(path.join(dir, `${collection}.json`), JSON.stringify(open().readAll(collection), null, 2));
    out.push(collection);
  });
  return out;
}

module.exports = {
  readAll: wrap('readAll'),
  writeAll: wrap('writeAll'),
  insert: wrap('insert'),
  findAll: wrap('findAll'),
  findOne: wrap('findOne'),
  findById: wrap('findById'),
  update: wrap('update'),
  remove: wrap('remove'),
  mutate: wrap('mutate'),
  // beyond the old contract
  get sql() { return open().sql; },
  transaction: fn => open().transaction(fn),
  collections, snapshot, exportJson, planCollection, jsonCollections,
  DATA_DIR, DB_PATH, importLog, open,
  ping: () => open().sql.get('SELECT 1 AS ok').ok === 1,
};
