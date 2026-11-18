// Copied from @deontech/db 0.4.1 (sqliteDatastore.js), as used by IFAIMA, on 8 Oct 2026.
// AOTC Track does not install the @deontech packages (deploys never run npm install), so
// the file is carried here unchanged. Keep it in step with the package by hand.

// SQLite-backed datastore — the same contract as datastore.js, different
// durability and concurrency properties.
//
// WHY THIS EXISTS, and why it is a separate factory rather than an option on
// createDatastore(): this package's rule is that the moment a package grows a
// flag so one app can behave differently from another, the thing being
// configured belongs in the app. A storage backend is not vocabulary, but a
// boolean inside createDatastore() would still put a branch in shared code on
// every read and write. An app chooses a backend by calling a different
// function, exactly as it already chooses its data directory. No branch.
//
// WHAT THE JSON STORE CANNOT DO, and why that started to matter:
//
//   insert() computes the next id as max(id) + 1 across every record, and
//   mutate() is a read-modify-write. Both are safe today only because Node
//   executes them synchronously inside ONE process — nothing can interleave.
//   The blue-green deployment topology puts TWO processes on one data
//   directory. Across processes those synchronous file operations do
//   interleave: two inserts can take the same id, and one mutate() can
//   overwrite another's change. writeAll()'s temp-file-and-rename makes the
//   swap atomic, which stops a reader seeing half a file — it does not stop a
//   lost update.
//
//   In fairness the window is narrow: only one line serves traffic at a time,
//   so it opens during a cutover when both are briefly live, and whenever
//   anything else touches the data directory — a backup, a maintenance
//   script. It is not a constant hazard. It is one that shows up rarely, in
//   production, in the money.
//
//   SQLite in WAL mode has real cross-process locking. Every write below runs
//   inside a BEGIN IMMEDIATE transaction, so two processes serialise instead
//   of racing.
//
// DEPENDENCIES: none. node:sqlite ships with Node and needs no build tools,
// which keeps both of this workspace's constraints — no third-party packages,
// and no native compilation. Node still labels it experimental and prints a
// warning on first use; it is stable enough to hold a members register, and
// the alternative (better-sqlite3) would break both constraints at once.
//
// STORAGE SHAPE: one row per record in a single `records` table, the document
// held as JSON. That preserves the schemaless contract the JSON store gives —
// records are arbitrary objects and no migration is needed to add a field.
// An application that wants real relational tables (foreign keys, joins,
// aggregates) creates them in the same file through sql() below, and they
// share one transaction domain with everything here.
'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

function createSqliteDatastore({ dbPath, busyTimeoutMs = 5000, requireWal = true }) {
  if (!dbPath) throw new Error('createSqliteDatastore() needs dbPath.');

  const dir = path.dirname(dbPath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const connection = new DatabaseSync(dbPath);

  // busy_timeout MUST be set first, on its own, before any statement that
  // takes a lock. Setting journal_mode acquires one, and so does CREATE TABLE.
  // With the timeout set afterwards, two processes opening the store at the
  // same moment meant the second threw "database is locked" during setup —
  // the exact scenario this backend exists to survive, failing in the
  // constructor. It is a connection-level setting, so one statement, first.
  connection.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs) || 0}`);

  // WAL is what makes this backend worth choosing: it is the mode in which
  // readers and a writer coexist across processes. It needs a real local
  // filesystem, because it keeps a shared-memory index (-shm) beside the
  // database. A network or cloud-synced mount — OneDrive, Dropbox, SMB, NFS —
  // usually cannot provide one, and SQLite reports that as a bare
  // "disk I/O error" from the pragma, which says nothing about the cause.
  // Catch it and say what actually happened.
  //
  // Refusing rather than quietly continuing in rollback-journal mode is
  // deliberate. Failing here almost always means the database is sitting in a
  // folder something else is synchronising, and a sync client copying a live
  // database out from under it corrupts the database — a slower, quieter
  // failure than this one.
  const walProblem = (detail) => new Error(
    `Could not put the database into WAL mode at ${dbPath}${detail ? ` (${detail})` : ''}. ` +
    'This usually means the file is on a network or cloud-synced folder ' +
    '(OneDrive, Dropbox, an SMB or NFS share), which cannot host the shared-memory ' +
    'index WAL needs. Point DB_PATH at a local disk. Keeping a live database inside ' +
    'a synced folder risks corruption in any case, because the sync client copies ' +
    'the file while it is being written. To run without WAL anyway, pass ' +
    'requireWal: false — concurrent readers will then block on the writer.'
  );

  try {
    connection.exec('PRAGMA journal_mode = WAL');
  } catch (e) {
    if (requireWal) throw walProblem(e.message);
  }
  // `|| {}` because a pragma is not guaranteed to return a row in every state,
  // and a TypeError here would bury the real problem under a stack trace.
  const mode = String((connection.prepare('PRAGMA journal_mode').get() || {}).journal_mode || '').toLowerCase();
  if (mode !== 'wal' && requireWal) throw walProblem(`still in ${mode} mode`);

  connection.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS records (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT    NOT NULL,
      id         INTEGER NOT NULL,
      doc        TEXT    NOT NULL,
      UNIQUE (collection, id)
    );
    CREATE INDEX IF NOT EXISTS ix_records_collection ON records(collection, seq);
  `);

  const stmt = (sql) => connection.prepare(sql);

  // Insertion order, not id order — an explicit id may be lower than one
  // already present, and the JSON store returns records in the order they
  // were appended to the array.
  const SEL_ALL = stmt('SELECT doc FROM records WHERE collection = ? ORDER BY seq');
  const SEL_ONE = stmt('SELECT doc FROM records WHERE collection = ? AND id = ?');
  const SEL_MAX = stmt('SELECT IFNULL(MAX(id), 0) AS m FROM records WHERE collection = ?');
  const INS = stmt('INSERT INTO records (collection, id, doc) VALUES (?, ?, ?)');
  const UPD = stmt('UPDATE records SET doc = ? WHERE collection = ? AND id = ?');
  const UPD_ID = stmt('UPDATE records SET id = ?, doc = ? WHERE collection = ? AND id = ?');
  const DEL = stmt('DELETE FROM records WHERE collection = ? AND id = ?');
  const DEL_ALL = stmt('DELETE FROM records WHERE collection = ?');

  // BEGIN IMMEDIATE takes the write lock up front rather than on first write,
  // so two processes cannot both read, both decide, and both write. Without
  // IMMEDIATE, SQLite would let both begin and fail the second at COMMIT —
  // which is safe, but surfaces as an error where serialising is what we want.
  function transaction(fn) {
    connection.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      connection.exec('COMMIT');
      return out;
    } catch (e) {
      try { connection.exec('ROLLBACK'); } catch (_) {}
      throw e;
    }
  }

  const parse = (row) => JSON.parse(row.doc);

  function readAll(collection) {
    return SEL_ALL.all(collection).map(parse);
  }

  // Replaces the whole collection. Present for contract parity; prefer the
  // record-level calls, which do not rewrite rows that did not change.
  function writeAll(collection, records) {
    transaction(() => {
      DEL_ALL.run(collection);
      let synthetic = 0;
      for (const r of records) {
        const id = r && r.id != null ? Number(r.id) : ++synthetic;
        INS.run(collection, id, JSON.stringify({ ...r, id }));
      }
    });
  }

  function nextId(collection) {
    return SEL_MAX.get(collection).m + 1;
  }

  // `record` is spread AFTER id so a record carrying its own id overrides the
  // generated one — the JSON store behaves this way, code relies on it when
  // re-importing a record under its original id, and a test pins it there.
  function insert(collection, record) {
    return transaction(() => {
      const id = SEL_MAX.get(collection).m + 1;
      const withId = { id, ...record, createdAt: new Date().toISOString() };
      INS.run(collection, Number(withId.id), JSON.stringify(withId));
      return withId;
    });
  }

  function findAll(collection, filterFn) {
    const records = readAll(collection);
    return filterFn ? records.filter(filterFn) : records;
  }

  function findOne(collection, filterFn) {
    return readAll(collection).find(filterFn) || null;
  }

  function findById(collection, id) {
    const row = SEL_ONE.get(collection, Number(id));
    return row ? parse(row) : null;
  }

  // KNOWN ASYMMETRY, carried over deliberately: `patch` is spread after the
  // existing record, so a patch containing an `id` rewrites the record's
  // identity. mutate() below does not allow that. Both forks behaved this way,
  // 221 call sites depend on update(), and a backend swap is the wrong moment
  // to change identity handling. Pinned by a test in both backends.
  function update(collection, id, patch) {
    return transaction(() => {
      const row = SEL_ONE.get(collection, Number(id));
      if (!row) return null;
      const next = { ...parse(row), ...patch, updatedAt: new Date().toISOString() };
      if (Number(next.id) !== Number(id)) UPD_ID.run(Number(next.id), JSON.stringify(next), collection, Number(id));
      else UPD.run(JSON.stringify(next), collection, Number(id));
      return next;
    });
  }

  function remove(collection, id) {
    return transaction(() => DEL.run(collection, Number(id)).changes > 0);
  }

  // Atomic read-modify-write of ONE record. In the JSON store this is atomic
  // because the whole function is synchronous within a single process; here it
  // is atomic because it holds the database write lock, which also holds
  // against a second process.
  function mutate(collection, id, fn) {
    return transaction(() => {
      const row = SEL_ONE.get(collection, Number(id));
      if (!row) return null;
      const current = parse(row);
      const next = fn({ ...current });
      if (!next) return current;
      const merged = { ...next, id: current.id, updatedAt: new Date().toISOString() };
      UPD.run(JSON.stringify(merged), collection, Number(current.id));
      return merged;
    });
  }

  // The JSON store's filePath(collection) names a file a caller may read,
  // copy or overwrite. There is no such file here, and returning the database
  // path would invite a caller to write over a collection and take the whole
  // database with it. Fail loudly and say what to use instead — the same
  // choice this package makes for a corrupt data file.
  function filePath() {
    throw new Error(
      'filePath() has no meaning for the SQLite datastore: collections are not separate files. ' +
      'Use databasePath for backups, or sql() to reach the data directly.'
    );
  }

  // The escape hatch. An application creates its own relational tables in this
  // same database and queries them here — joins and aggregates that the
  // record-level interface above cannot express, inside the same transaction
  // domain as everything else.
  const sql = {
    exec: (text) => connection.exec(text),
    all: (text, ...params) => connection.prepare(text).all(...params),
    get: (text, ...params) => connection.prepare(text).get(...params),
    run: (text, ...params) => connection.prepare(text).run(...params),
  };

  return {
    readAll, writeAll, insert, findAll, findOne, findById, update, remove, mutate, filePath,
    // beyond the JSON store's contract
    sql, transaction, databasePath: dbPath, connection,
    close: () => connection.close(),
  };
}

module.exports = { createSqliteDatastore };
