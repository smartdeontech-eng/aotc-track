// One-time migration, Oct 2026: split 'setup.manage' and tidy the accounts
// the permissions review found. Runs once at server start (server.js), records
// itself in the `migrations` collection, and never runs again.
//
// What it does, and why (the user's decisions of 5 Oct 2026):
//  1. 'setup.manage' is removed from every account. It had been ticked on 30
//     secretaries (accounts #4–#38 — a bulk grant, not a per-person decision)
//     and let any of them archive any group, run the year rollover or rewrite
//     any goal. The Session Clerk (and anyone holding approvals.manage) gets the
//     seven rights it was split into instead.
//  2. Treasurer accounts get the role defaults they are missing — the account
//     predated finance.weekly.confirm, so no-one could confirm a weekly return.
//  3. Naa Akwele Atiapa (the Church Administrator, on the Attendance account):
//     staff.manage removed; all three Sunday sections and correspondence intake
//     added. Matched on id AND name, so it does nothing on any other dataset.
//
// Every account it changes is written to the migration record with its
// permissions BEFORE and AFTER, so the change can be read back or undone by
// hand, and each one gets an activity-log line.
const db = require('../db');
const { logActivity } = require('../activityLog');
const { ROLE_DEFAULT_PERMISSIONS } = require('../../middleware/auth');

const KEY = 'perm-split-2026-10';
const SPLIT_FOR_CLERK = ['setup.years', 'setup.structure', 'setup.venues', 'goals.manage', 'roster.manage', 'members.photos'];

function plan(users) {
  const out = [];
  users.forEach(u => {
    if (['admin', 'localadmin'].includes(u.role)) return;
    const before = (u.permissions || []).slice();
    let p = before.slice();
    const why = [];
    const add = list => list.forEach(x => { if (!p.includes(x)) p.push(x); });

    if (p.includes('setup.manage')) {
      p = p.filter(x => x !== 'setup.manage');
      if (u.role === 'clerk' || p.includes('approvals.manage')) {
        add(SPLIT_FOR_CLERK);
        why.push('setup.manage split into its separate rights (Session Clerk)');
      } else {
        why.push('setup.manage removed (not needed for own committee/group work)');
      }
    }
    if (u.role === 'treasurer') {
      const missing = (ROLE_DEFAULT_PERMISSIONS.treasurer || []).filter(x => !p.includes(x));
      if (missing.length) { add(missing); why.push(`Treasurer role defaults added: ${missing.join(', ')}`); }
    }
    if (Number(u.id) === 15 && /^naa akwele atiapa$/i.test(String(u.name || '').trim()) && u.role === 'attendance') {
      if (p.includes('staff.manage')) { p = p.filter(x => x !== 'staff.manage'); why.push('staff.manage removed'); }
      const want = ['attendance.cs', 'attendance.jy', 'attendance.main', 'correspondence.intake'].filter(x => !p.includes(x));
      if (want.length) { add(want); why.push(`Church Administrator: ${want.join(', ')} added`); }
    }
    const same = before.length === p.length && before.every(x => p.includes(x));
    if (!same) out.push({ id: u.id, name: u.name, role: u.role, before, after: p, why });
  });
  return out;
}

function run({ backup = true } = {}) {
  if (db.findOne('migrations', m => m.key === KEY)) return null;
  // A full data backup first, on the real server only (tests run against a
  // throwaway AOTC_DATA_DIR, and utils/backup.js always copies ./data).
  if (backup && !process.env.AOTC_DATA_DIR) {
    try { require('../backup').runBackup(); } catch (e) { console.error('pre-migration backup failed:', e.message); return null; }
  }
  const changes = plan(db.findAll('users'));
  changes.forEach(c => {
    db.update('users', c.id, { permissions: c.after });
    logActivity({ userId: null, userName: 'System (permissions update, Oct 2026)', action: `Permissions changed: ${c.why.join('; ')}`, entityType: 'user', entityId: c.id, entityLabel: c.name });
  });
  db.insert('migrations', { key: KEY, ranAt: new Date().toISOString(), changed: changes.length, changes });
  return changes;
}

module.exports = { run, plan, KEY };
