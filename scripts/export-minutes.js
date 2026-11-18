// Lays out all uploaded meeting minutes with human-readable names in ONE
// flat folder, ready to sync to OneDrive:
//   minutes-export/<Committee or Group> - <date> - <title> (mtg N).pdf
//
// The app itself keeps serving the original files from minutes/ — this is a
// mirror for offsite backup and easy browsing. Idempotent: re-running only
// (re)copies what's needed and removes exports whose meeting was deleted.
//
// Run from the app root:  node scripts/export-minutes.js
const fs = require('fs');
const path = require('path');
process.chdir(path.join(__dirname, '..'));
const db = require('../utils/db');

const MINUTES_DIR = path.join(process.cwd(), 'minutes');
const EXPORT_DIR = path.join(process.cwd(), 'minutes-export');

function safe(s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80);
}

const meetings = db.findAll('meetings', m => m.minutes && m.minutes.filename);
fs.mkdirSync(EXPORT_DIR, { recursive: true });

const expected = new Set();
let copied = 0, kept = 0, missing = 0;

for (const m of meetings) {
  const src = path.join(MINUTES_DIR, m.minutes.filename);
  if (!fs.existsSync(src)) { missing++; continue; }
  const entity = safe(m.entityName || `${m.entityType}-${m.entityId}`);
  const dest = path.join(EXPORT_DIR, `${entity} - ${m.date} - ${safe(m.title)} (mtg ${m.id}).pdf`);
  expected.add(dest);
  // Copy only if new or the source changed (minutes re-uploaded).
  const need = !fs.existsSync(dest) || fs.statSync(dest).mtimeMs < fs.statSync(src).mtimeMs;
  if (need) { fs.copyFileSync(src, dest); copied++; } else kept++;
}

// Prune exports whose meeting/minutes no longer exists.
let pruned = 0;
for (const f of fs.readdirSync(EXPORT_DIR)) {
  const p = path.join(EXPORT_DIR, f);
  if (fs.statSync(p).isDirectory()) continue;
  if (!expected.has(p)) { fs.unlinkSync(p); pruned++; }
}

console.log(`minutes-export: ${copied} copied, ${kept} up to date, ${pruned} pruned${missing ? `, ${missing} source file(s) missing` : ''}.`);
