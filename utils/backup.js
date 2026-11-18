// Automatic + on-demand backups of the data/ folder (the SQLite database, as a
// snapshot plus a JSON copy of every collection, and settings/photos) and
// public/uploads/ (product photos). Backups are plain directory copies under
// backups/<timestamp>/ — no extra dependency needed to create them, and
// they're trivial to restore (just copy back). A ZIP of any backup can be
// streamed on demand for downloading via the browser (uses `archiver`).
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { logNotification } = require('./notifications');

const ROOT = path.join(__dirname, '..');
const DATA_DIR_LINK = path.join(ROOT, 'data');
const UPLOADS_DIR_LINK = path.join(ROOT, 'public', 'uploads');
const BACKUPS_DIR = path.join(ROOT, 'backups');

const RETENTION_COUNT = 14; // keep the most recent 14 backups, prune older ones

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function timestampName() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// On a blue-green line data/, public/uploads and backups/ are SYMLINKS to the
// shared records in /opt/aotc-track. fs.cpSync copies a symlink as a symlink,
// so the backup's "data" was a link back to the live folder — and the database
// snapshot was then written THROUGH it, over the live data/aotc.db (9 Oct
// 2026). Every path here is resolved to the real folder first.
const real = p => { try { return fs.realpathSync(p); } catch (e) { return p; } };

function runBackup() {
  ensureDir(BACKUPS_DIR);
  const DATA_DIR = real(DATA_DIR_LINK), UPLOADS_DIR = real(UPLOADS_DIR_LINK), BACKUPS_DIR_REAL = real(BACKUPS_DIR);
  const name = timestampName();
  const dest = path.join(BACKUPS_DIR_REAL, name);
  ensureDir(dest);
  // The copy must land in a real new folder, never inside the records.
  if (real(dest).startsWith(DATA_DIR + path.sep) || real(dest) === DATA_DIR) throw new Error(`backup destination ${dest} is inside the records folder — refusing`);

  if (fs.existsSync(DATA_DIR)) {
    // The records are a SQLite database since Oct 2026 (utils/db.js). A plain
    // copy of a live database file can be torn, so the database goes in as a
    // consistent snapshot, and every collection also as JSON — readable by
    // anyone, and what scripts/sqlite-export.js would give back. The rest of
    // data/ (settings.json, member photos, the old JSON files) is copied as
    // before.
    const db = require('./db');
    const isDb = src => /\.db(-wal|-shm|-journal)?$/.test(src);
    fs.cpSync(DATA_DIR, path.join(dest, 'data'), { recursive: true, dereference: true, filter: src => !isDb(src) });
    if (fs.lstatSync(path.join(dest, 'data')).isSymbolicLink()) throw new Error('backup data folder came out as a link — refusing to write the snapshot through it');
    db.snapshot(path.join(dest, 'data', path.basename(db.DB_PATH)));
    db.exportJson(path.join(dest, 'data', 'json'));
  }
  if (fs.existsSync(UPLOADS_DIR)) {
    fs.cpSync(UPLOADS_DIR, path.join(dest, 'uploads'), { recursive: true, dereference: true });
  }

  pruneOldBackups();
  mirrorOffsite(name, dest);

  const info = { name, createdAt: new Date().toISOString(), sizeBytes: dirSize(dest) };
  console.log(`[backup] created ${name} (${(info.sizeBytes / 1024).toFixed(0)} KB)`);
  return info;
}

// Off-site copy. Set BACKUP_MIRROR_DIR in .env to a path that lives on OTHER
// hardware — a mounted external/network drive, an rclone/S3 mount, or a synced
// folder (Dropbox/OneDrive/Google Drive) — so a VPS failure never loses the
// congregation's records. Never crashes the backup if the mirror is unavailable.
function mirrorOffsite(name, dest) {
  const mirror = process.env.BACKUP_MIRROR_DIR;
  if (!mirror) return;
  try {
    ensureDir(mirror);
    fs.cpSync(dest, path.join(mirror, name), { recursive: true });
    const entries = fs.readdirSync(mirror, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('backup-')).map(e => e.name).sort();
    const excess = entries.length - RETENTION_COUNT;
    if (excess > 0) entries.slice(0, excess).forEach(n => fs.rmSync(path.join(mirror, n), { recursive: true, force: true }));
    console.log(`[backup] mirrored ${name} -> ${mirror}`);
  } catch (e) {
    console.error('[backup] off-site mirror failed:', e.message);
  }
}

function pruneOldBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return;
  const entries = fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('backup-'))
    .map(e => e.name)
    .sort(); // timestamp-prefixed names sort chronologically
  const excess = entries.length - RETENTION_COUNT;
  if (excess > 0) {
    entries.slice(0, excess).forEach(name => {
      fs.rmSync(path.join(BACKUPS_DIR, name), { recursive: true, force: true });
    });
  }
}

function listBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];
  return fs.readdirSync(BACKUPS_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory() && e.name.startsWith('backup-'))
    .map(e => {
      const full = path.join(BACKUPS_DIR, e.name);
      const stat = fs.statSync(full);
      return { name: e.name, createdAt: stat.birthtime.toISOString(), sizeBytes: dirSize(full) };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

// Streams a ZIP of the given backup directly to an HTTP response.
function streamBackupZip(name, res) {
  const dir = path.join(BACKUPS_DIR, name);
  if (!fs.existsSync(dir)) throw new Error('Backup not found.');
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => { throw err; });
  archive.pipe(res);
  archive.directory(dir, false);
  archive.finalize();
}

// Runs a backup shortly after startup, then every `intervalMs` (default 24h).
// Failures are logged but never crash the app.
function scheduleAutomaticBackups(intervalMs = 24 * 60 * 60 * 1000) {
  const attempt = () => {
    try {
      runBackup();
    } catch (e) {
      console.error('[backup] failed:', e.message);
      logNotification({ level: 'error', source: 'backup', message: `Automatic backup failed: ${e.message}` });
    }
  };
  setTimeout(attempt, 60 * 1000); // small delay so it doesn't compete with server startup
  setInterval(attempt, intervalMs);
}

module.exports = { runBackup, listBackups, streamBackupZip, scheduleAutomaticBackups, BACKUPS_DIR };
