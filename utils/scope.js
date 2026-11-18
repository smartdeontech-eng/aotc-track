// Shared request-scope & permission helpers.
//
// These small functions were previously copy-pasted at the top of nearly
// every route module (routes/*.js) — an identical `actor` / `userEntity` /
// `isAdmin` / `canViewAll` block in a dozen files. Centralising them here
// means a change to the scoping rules (e.g. the linked-workspace walk in
// userEntityIds, which had to be fixed once already) is made in ONE place
// instead of fourteen, and two parallel edits to different route files no
// longer collide on identical helper blocks.
//
// Every function keeps the exact behaviour of the copies it replaces, so
// route handlers that call actor(req) / canViewAll(req) / … are unchanged.
const db = require('./db');

// The acting user's id + display name, for activity-log / audit stamps.
function actor(req) {
  const u = db.findById('users', req.user.id) || {};
  return { userId: req.user.id, userName: u.name || 'Unknown' };
}

// The active session's single entity (the committee/group "hat" currently
// worn), or null for a congregation-level account.
function userEntity(req) {
  const u = db.findById('users', req.user.id) || {};
  return u.entity || null;
}

// Admin tier: full-access national / local administrators.
function isAdmin(req) {
  return ['admin', 'localadmin'].includes(req.user.role);
}

// May this person read across ALL entities (the whole congregation) rather
// than just their own? Admins, anyone with congregation.view, and the Session
// Clerk (approvals.manage).
function canViewAll(req) {
  if (isAdmin(req)) return true;
  const perms = (db.findById('users', req.user.id) || {}).permissions || [];
  return perms.includes('congregation.view') || perms.includes('approvals.manage');
}

// Admin tier OR the Session Clerk (approvals.manage) — used where the clerk has
// the same reach as an admin (attendance sign-off, check-in scanning, …).
function isClerkOrAdmin(req) {
  if (isAdmin(req)) return true;
  return ((db.findById('users', req.user.id) || {}).permissions || []).includes('approvals.manage');
}

// EVERY committee/group this person belongs to (all their portfolios), not just
// the active one. Linked-account model (see routes/auth.js): one person is a
// primary user record plus one linked record per extra committee/group they
// serve, joined by `linkedTo`. The active session is only one of those records,
// so we walk the whole person-group to collect every portfolio's entity — the
// `workspaces` array exists only on the /auth/me response, never on the stored
// record, so reading it off the active record alone would miss the other hats.
function userEntityIds(req, type) {
  const u = db.findById('users', req.user.id) || {};
  const list = [];
  const primaryId = u.linkedTo ? Number(u.linkedTo) : Number(u.id);
  if (primaryId) {
    db.findAll('users', x => Number(x.id) === primaryId || Number(x.linkedTo) === primaryId)
      .forEach(x => { if (x.entity) list.push(x.entity); });
  }
  // Also honour any inline workspaces/entities, in case a record ever carries them.
  if (Array.isArray(u.workspaces)) u.workspaces.forEach(w => w && w.entity && list.push(w.entity));
  if (Array.isArray(u.entities)) u.entities.forEach(e => e && list.push(e));
  if (u.entity) list.push(u.entity);
  return [...new Set(list.filter(e => e && e.type === type).map(e => Number(e.id)))];
}

// Resolve a goal/owner code to its type. 'OG' is the congregation-wide owner;
// otherwise the code belongs to exactly one committee or one group (codes never
// collide across the two). Returns null for an unknown code.
function deriveOwnerType(ownerCode) {
  if (ownerCode === 'OG') return 'congregation';
  if (db.findOne('committees', c => c.code === ownerCode)) return 'committee';
  if (db.findOne('groups', g => g.code === ownerCode)) return 'group';
  return null;
}

module.exports = {
  actor,
  userEntity,
  isAdmin,
  canViewAll,
  isClerkOrAdmin,
  userEntityIds,
  deriveOwnerType,
};
