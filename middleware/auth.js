const jwt = require('jsonwebtoken');

// No insecure fallback here on purpose — server.js refuses to start at all
// if JWT_SECRET is missing/weak, so by the time this module is used it's
// guaranteed to be set. If something imports this module without going
// through server.js's check, signing/verifying will just throw rather than
// silently using a well-known default secret.
const JWT_SECRET = process.env.JWT_SECRET;

// ---- Permission catalog ----
// Every grantable right in AOTC Track lives here with a human-readable label.
// Admins always have every permission, regardless of what's in their `permissions` array.
// NOTE: most rights are ENTITY-SCOPED — they apply only to the committee/group
// the user's account is attached to (see requireEntityScope below).
const PERMISSIONS = {
  'planning.manage': "Plan own committee/group's activities, targets and costs",
  'entry.manage': "Enter own committee/group's quarterly KPI data, activity updates and narratives",
  'attendance.manage': "Record attendance for own committee/group (meetings; services for authorised roles)",
  'attendance.cs': "Sunday recorder — Children's Service section only",
  'attendance.jy': "Sunday recorder — JY section only",
  'attendance.main': "Sunday recorder — Main Church (adults) section only",
  'meetings.manage': 'Schedule meetings and record who attended for own committee/group',
  'reports.generate': "Generate own committee/group's quarterly and conference reports",
  'roster.propose': 'Propose member contact updates and co-opted members (Session Clerk approval required)',
  'visitors.manage': 'Register and follow up visitors and new members (Mission & Evangelism)',
  'counselling.manage': 'Manage counsellors, counselling cases and assignments (CFL — confidential)',
  'fundraising.manage': 'Fundraising — ENTER: record fundraising days, expenses and targets',
  'fundraising.verify': 'Fundraising — VERIFY: level-1 sign-off (Accounts Clerk)',
  'fundraising.approve': 'Fundraising — APPROVE: level-2 sign-off, locks the day (Treasurer)',
  'finance.quarterly': "Enter the Finance quarterly financials (earmarked expenditure, transfers, almanac)",
  'finance.weekly': 'Weekly finance return — ENTER: record each Sunday\u2019s receipts and payments (Accounts Clerk)',
  'finance.weekly.confirm': 'Weekly finance return — CONFIRM: sign off the week so it counts towards the quarter (Treasurer)',
  'correspondence.intake': 'Correspondence inbox — scan in letters received for the Session and draft their summaries (Church Administrator)',
  'diary.manage': 'Church Diary — add, change and remove entries, confirm what the app finds, and add the preaching plan (the Session Clerk and the Church Administrator can already)',
  'docs.upload': 'ShareHub — upload documents and manage the ones you uploaded (who may see them stays with an admin)',
  'approvals.manage': 'Approve roster changes, co-opted members, change requests and mark reports received (Session Clerk)',
  'session.manage': "The Session — keep the Session's meetings, composition, minutes, outstanding matters & correspondence",
  // Group elections are run by CLAN (led by the CLAN Coordinator) and confirmed
  // by the Session Clerk: elections.manage sets an election up and runs it;
  // approvals.manage (the Clerk) confirms it before polls open and certifies it.
  'elections.manage': 'Elections — set up and run group elections: ballot, candidates, voters list, booths, polls (CLAN Coordinator)',
  // Oct 2026: these seven replaced the single 'setup.manage' ("Manage years,
  // goals, KPIs, committees, groups and codes"). That one box had been ticked on
  // 30 secretaries' accounts and let any of them archive any group, run the year
  // rollover or rewrite any goal. Each power now stands alone, and the sensitive
  // ones (SENSITIVE_PERMISSIONS below) can be granted only by an administrator.
  'setup.years': 'Church years — add a year, change the active year, run the year rollover',
  'setup.structure': 'Committees & groups — create, rename, archive and restore them',
  'setup.venues': 'Meeting venues — add, rename and remove them',
  'goals.manage': 'Goals & KPIs — edit ANY committee or group\u2019s goals (a secretary proposes changes to their own instead)',
  'roster.manage': 'Rosters — edit ANY committee or group\u2019s members directly, import contacts, print check-in cards',
  'members.photos': 'Member photos — see members\u2019 photos across the whole congregation',
  'finance.weekly.lines': 'Weekly finance — change which lines the weekly return counts (offertory, tithes\u2026)',
  'users.request': 'Propose new platform users for administrator approval (Reporting Coordinator)',
  'staff.manage': 'Manage user accounts and permissions',
  'congregation.view': 'View all committees, groups, dashboards and reports (read-only)',
  'congregation.manage': 'Work across ALL committees and groups — planning, entries, meetings, attendance, reports (Reporting Coordinator)',
};

// What a newly created user of each role starts with (editable afterwards per person).
// Roles: admin (everything, implicit) · clerk (Session Clerk) · coordinator
// (Reporting Coordinator — reports to the Session Clerk; plans, enters and
// reports across ALL committees/groups but has no admin/user/setup powers and
// no ministry modules) · secretary (committee/group secretary or head —
// entity-scoped) · viewer (Minister/Session, read-only).
const ROLE_DEFAULT_PERMISSIONS = {
  admin: Object.keys(PERMISSIONS),
  // Local Admin: second-tier admin. Can do EVERYTHING in the system
  // (all permissions, all unlocks, all entities, broadcasts, backups) —
  // EXCEPT touch the admin tier: cannot create/edit/reset/delete/promote
  // any Admin or Local Admin account. Control flows down, never up.
  localadmin: Object.keys(PERMISSIONS),
  clerk: ['approvals.manage', 'session.manage', 'setup.years', 'setup.structure', 'setup.venues', 'goals.manage', 'roster.manage', 'members.photos', 'entry.manage', 'planning.manage', 'reports.generate', 'attendance.manage', 'meetings.manage', 'congregation.view'],
  coordinator: ['planning.manage', 'entry.manage', 'attendance.manage', 'meetings.manage', 'reports.generate', 'goals.manage', 'users.request', 'congregation.view', 'congregation.manage'],
  secretary: ['planning.manage', 'entry.manage', 'attendance.manage', 'meetings.manage', 'reports.generate', 'roster.propose'],
  // Attendance Officer — congregation-wide, records Sunday-service attendance
  // only. With the section-recorder model this role holds all three section
  // rights; individual accounts can be trimmed to a single section.
  attendance: ['attendance.cs', 'attendance.jy', 'attendance.main'],
  // Treasurer — a congregation OFFICE, not a committee seat: assign the role
  // and the Fundraising module appears with level-2 authority (approve & lock).
  // The Treasurer also holds the level-1 verify right so a day can still be
  // closed when the Accounts Clerk is away, and fundraising.manage so they can
  // record and correct figures themselves. That is a deliberate choice: the
  // office can therefore take a day from entry to lock single-handed, and the
  // audit trail will show one name at every stage. If that ever needs
  // tightening, the guard belongs in routes/fundraising.js — whoever entered
  // or submitted a day may not verify or approve that same day.
  treasurer: ['fundraising.manage', 'fundraising.approve', 'fundraising.verify', 'finance.weekly.confirm', 'finance.weekly.lines', 'congregation.view'],
  // Accounts Clerk — the other congregation office on the money side: level-1
  // verification of Harvest figures, entry rights so the clerk can record and
  // correct them, the Finance quarterly books, and read-only sight of the whole
  // congregation. Marking a redeemed pledge paid comes with the verify right.
  // Like the Treasurer, the clerk can therefore enter and verify the same day;
  // approval still belongs to the Treasurer, so a second person closes it.
  accounts: ['fundraising.manage', 'fundraising.verify', 'finance.quarterly', 'finance.weekly', 'congregation.view'],
  // Minister — read-only oversight of the whole congregation. Same read-only
  // power as Viewer (congregation.view: view every committee/group, dashboards
  // and reports; the server blocks all writes), but a distinct role so
  // Ministers can be identified and, if ever needed, diverge from lay viewers.
  minister: ['congregation.view'],
  viewer: ['congregation.view'],
};

// The list of roles a user account may hold (validated in routes/auth.js).
const ROLES = Object.keys(ROLE_DEFAULT_PERMISSIONS);

// ---- Session (the court) role presets ----
// Attaching a person to "The Session" (entity type 'session') offers these
// offices instead of the generic access levels. The chosen office sets the
// account role, the permission bundle and the display title — mirroring the way
// a committee's special module auto-grants its permission. `permissions:null`
// means "use that role's defaults"; `add` layers extra rights on top. The
// workspace layer always strips staff.manage. Presets carrying a SENSITIVE
// permission (Session Clerk / Deputy / Treasurer) therefore remain admin-only
// to assign, exactly as those permissions are everywhere else.
const SESSION_ROLE_PRESETS = {
  session_clerk: {
    label: 'Session Clerk', position: 'Session Clerk', role: 'clerk',
    permissions: null, add: ['session.manage', 'correspondence.intake'],
  },
  deputy_session_clerk: {
    label: 'Deputy Session Clerk', position: 'Deputy Session Clerk', role: 'clerk',
    // Same access as the Session Clerk (confirmed by Gideon, 18 Oct 2026): a
    // deputy stands in for the Clerk, so carries exactly the Clerk's rights.
    permissions: null, add: ['session.manage', 'correspondence.intake'],
  },
  senior_presbyter: {
    label: 'Senior Presbyter', position: 'Senior Presbyter', role: 'viewer',
    permissions: ['session.manage', 'congregation.view'],
  },
  deputy_senior_presbyter: {
    label: 'Deputy Senior Presbyter', position: 'Deputy Senior Presbyter', role: 'viewer',
    permissions: ['session.manage', 'congregation.view'],
  },
  session_treasurer: {
    label: 'Treasurer', position: 'Treasurer', role: 'treasurer',
    // treasurer defaults (the money sign-off bundle) + Session access so the
    // Treasurer can enter the Session finance table in the minutes.
    permissions: null, add: ['session.manage'],
  },
  session_minister: {
    label: 'Minister', position: 'Minister', role: 'minister',
    permissions: ['congregation.view'], // read-only oversight
  },
  session_member: {
    label: 'Presbyter (member)', position: 'Presbyter', role: 'viewer',
    permissions: ['congregation.view'], // read-only Session member
  },
};

// Resolve a Session preset id -> { role, permissions, position }. Final
// permissions = (preset.permissions || that role's defaults) + preset.add, with
// staff.manage always stripped (a scoped workspace never manages accounts).
function resolveSessionPreset(presetId) {
  const p = SESSION_ROLE_PRESETS[presetId];
  if (!p) return null;
  const base = Array.isArray(p.permissions) ? p.permissions : (ROLE_DEFAULT_PERMISSIONS[p.role] || []);
  const permissions = [...new Set([...base, ...(p.add || [])])].filter(x => x !== 'staff.manage');
  return { role: p.role, permissions, position: p.position };
}

// Rights that reach beyond the holder's own committee or group, touch money
// sign-off, confidential records or other people's accounts. Only an
// administrator may grant (or remove) these; anyone else with staff.manage can
// still manage the ordinary ones. The Users page marks them.
const SENSITIVE_PERMISSIONS = [
  'staff.manage', 'approvals.manage', 'congregation.manage',
  'setup.years', 'setup.structure', 'goals.manage', 'roster.manage', 'members.photos',
  'fundraising.approve', 'finance.weekly.confirm', 'finance.weekly.lines',
  'counselling.manage', 'elections.manage',
];

function requireAuth(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not logged in.' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.purpose && payload.purpose !== 'session') {
      return res.status(401).json({ error: 'Not logged in.' });
    }
    const db = require('../utils/db');
    const fresh = db.findById('users', payload.id);
    if (!fresh) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    // Checked before the session version, so the person is told the real
    // reason. A switched-off account (or a workspace of one) is refused on every call,
    // so an open tab stops working at once — see utils/accountStatus.js.
    const { isDisabled, DISABLED_MESSAGE } = require('../utils/accountStatus');
    if (isDisabled(fresh)) return res.status(401).json({ error: DISABLED_MESSAGE, disabled: true });
    if ((fresh.sessionVersion || 0) !== (payload.sv || 0)) {
      return res.status(401).json({ error: 'Your session was signed out remotely (e.g. a password reset). Please log in again.' });
    }
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Session expired. Please log in again.' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to do this.' });
    }
    next();
  };
}

// Grants access if the user is an admin OR has been given the named right.
// Reads the user fresh so permission changes take effect without re-login.
function requirePermission(permission) {
  const db = require('../utils/db');
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
    // Local Admin holds every right by definition — go by the role, not by
    // whatever happens to be in the stored permissions array.
    if (['admin', 'localadmin'].includes(req.user.role)) return next();
    const fresh = db.findById('users', req.user.id);
    const perms = (fresh && fresh.permissions) || [];
    if (!perms.includes(permission)) {
      return res.status(403).json({ error: 'You have not been given permission to do this. Ask an admin for access.' });
    }
    next();
  };
}

// Grants access if the user is an admin OR holds ANY of the named rights.
function requireAnyPermission(...permissions) {
  const db = require('../utils/db');
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
    if (['admin', 'localadmin'].includes(req.user.role)) return next();
    const fresh = db.findById('users', req.user.id);
    const perms = (fresh && fresh.permissions) || [];
    if (!permissions.some(p => perms.includes(p))) {
      return res.status(403).json({ error: 'You have not been given permission to do this. Ask an admin for access.' });
    }
    next();
  };
}

// True if this user may WORK ON (not just view) any committee/group:
// admins always, plus congregation.manage holders (Reporting Coordinator).
// Route modules use this wherever they previously checked "is admin" to
// decide whether a cross-entity write is allowed. Admin-ONLY actions
// (unlocking submitted quarters, unlocking attendance, deleting users)
// must keep checking role === 'admin' directly — do NOT swap those.
function canManageAllEntities(req) {
  if (!req.user) return false;
  if (req.user.role === 'admin') return true;
  const db = require('../utils/db');
  const fresh = db.findById('users', req.user.id);
  return !!fresh && (fresh.permissions || []).includes('congregation.manage');
}

// ---- Entity scoping (AOTC Track extension) ----
// Committee/group accounts carry entity = { type: 'committee'|'group'|'congregation', id }.
// A route guarded by requireEntityScope() only allows:
//   - admins (always),
//   - users whose entity matches the :entityType/:entityId in the route
//     (or entityType/entityId in the request body when the route has no params).
// Viewers with congregation.view may READ (GET) any entity but never write.
function requireEntityScope() {
  const db = require('../utils/db');
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
    if (['admin', 'localadmin'].includes(req.user.role)) return next();
    const fresh = db.findById('users', req.user.id);
    if (!fresh) return res.status(401).json({ error: 'Session expired. Please log in again.' });
    const type = req.params.entityType || req.body.entityType || req.query.entityType;
    const id = Number(req.params.entityId || req.body.entityId || req.query.entityId);
    if (req.method === 'GET' && (fresh.permissions || []).includes('congregation.view')) return next();
    // Reporting Coordinator: congregation.manage = full cross-entity access.
    if ((fresh.permissions || []).includes('congregation.manage')) return next();
    const ent = fresh.entity || {};
    if (ent.type === type && Number(ent.id) === id) return next();
    return res.status(403).json({ error: 'You can only work on your own committee or group.' });
  };
}

module.exports = {
  requireAuth,
  requireEntityScope,
  requireRole,
  requirePermission,
  requireAnyPermission,
  canManageAllEntities,
  JWT_SECRET,
  PERMISSIONS,
  ROLE_DEFAULT_PERMISSIONS,
  ROLES,
  SENSITIVE_PERMISSIONS,
  SESSION_ROLE_PRESETS,
  resolveSessionPreset,
};
