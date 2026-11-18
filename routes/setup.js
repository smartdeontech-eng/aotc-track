// AOTC Track — Setup module (Phase 1).
// Years, committees, groups, member rosters, goals/KPIs, and the
// roster-change approval flow (committee proposes -> Session Clerk approves).
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { requireAuth, requirePermission, requireAnyPermission } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');
const { notifyUser, notifyApprovers } = require('../utils/approvalNotify');
const { ensureIdentity } = require('../utils/memberIdentity');
const { saveMemberPhoto, memberPhotoPath, deleteMemberPhoto } = require('../utils/imageStore');

// Oct 2026: 'setup.manage' was split. Years, structure (committees & groups)
// and rosters each have their own right now — see middleware/auth.js.
const yearsManage = [requireAuth, requirePermission('setup.years')];
const structureManage = [requireAuth, requirePermission('setup.structure')];
const approve = [requireAuth, requirePermission('approvals.manage')];
// Goals & KPIs can also be edited by goals.manage holders (Reporting
// Coordinator) without granting them the rest of setup (years, committees,
// groups, codes, rosters), which each have their own right.
// A secretary (planning.manage) reaches these too, for their OWN body only, and
// what they send is held for the Session Clerk — see goalAccess() below.
const goalsManage = [requireAuth, requireAnyPermission('goals.manage', 'planning.manage')];

// Shared request-scope helpers (see utils/scope.js) — actor, userEntity,
// isAdmin, canViewAll, userEntityIds and deriveOwnerType were duplicated across
// a dozen route files and now live in one place.
const { actor, userEntity, isAdmin, canViewAll, userEntityIds, deriveOwnerType } = require('../utils/scope');
const { sortGroups } = require('../utils/groupOrder');
// May a goal this person creates go live immediately? Only the Admin tier and
// the Session Clerk (approvals.manage). Everyone else who can reach the goals
// form (e.g. the Reporting Coordinator with goals.manage) must submit the goal
// for the Session Clerk to approve first.
function canApproveGoals(req) {
  if (isAdmin(req)) return true;
  const u = db.findById('users', req.user.id) || {};
  return (u.permissions || []).includes('approvals.manage');
}
// (deriveOwnerType and canViewAll now come from utils/scope.js, imported above.)

// How may this person change goals owned by `ownerCode`?
//   'direct'  admin tier / Session Clerk — any goal, goes live at once
//   'all'     goals.manage (Reporting Coordinator) — any goal; new goals still
//             wait for the Clerk, edits go straight in (unchanged since Sept)
//   'propose' a secretary (planning.manage) on their OWN committee or group —
//             new goals AND edits wait for the Session Clerk (decided Oct 2026)
//   null      nothing
// Before Oct 2026 an edit needed only 'setup.manage', with no check on whose
// goal it was: 30 secretaries could rewrite, or re-own, any goal in the church.
function ownEntityCode(req) {
  const ent = userEntity(req);
  if (!ent || !ent.type || ent.type === 'congregation') return null;
  const rec = db.findById(ent.type === 'committee' ? 'committees' : 'groups', Number(ent.id));
  return rec ? rec.code : null;
}
function goalAccess(req, ownerCode) {
  if (canApproveGoals(req)) return 'direct';
  const u = db.findById('users', req.user.id) || {};
  const perms = u.permissions || [];
  if (perms.includes('goals.manage')) return 'all';
  const own = ownEntityCode(req);
  if (perms.includes('planning.manage') && own && ownerCode === own) return 'propose';
  return null;
}
// Who may directly manage a roster: admins / roster.manage anywhere, and a GROUP
// account may manage the roster of ITS OWN group (self-managed group pilot).
// Committees still use the propose→approve flow (not covered here).
function canManageRoster(req, entityType, entityId) {
  if (isAdmin(req)) return true;
  const u = db.findById('users', req.user.id) || {};
  if ((u.permissions || []).includes('roster.manage')) return true;
  const ent = u.entity;
  return !!(entityType === 'group' && ent && ent.type === 'group' && Number(ent.id) === Number(entityId));
}

// ---------- Years ----------
router.get('/years', requireAuth, (req, res) => {
  res.json(db.findAll('years').sort((a, b) => b.year - a.year));
});

router.post('/years', ...yearsManage, (req, res) => {
  const year = parseInt(req.body.year, 10);
  if (!year || year < 2020 || year > 2100) return res.status(400).json({ error: 'Enter a valid year.' });
  if (db.findOne('years', y => y.year === year)) return res.status(400).json({ error: `${year} already exists.` });
  const rec = db.insert('years', { year, active: false, quarters: { 1: 'open', 2: 'open', 3: 'open', 4: 'open' } });
  logActivity({ ...actor(req), action: 'Created year', entityType: 'year', entityId: rec.id, entityLabel: String(year) });
  res.json(rec);
});

router.put('/years/:id/activate', ...yearsManage, (req, res) => {
  const rec = db.findById('years', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Year not found.' });
  db.findAll('years').forEach(y => db.update('years', y.id, { active: y.id === rec.id }));
  logActivity({ ...actor(req), action: 'Activated year', entityType: 'year', entityId: rec.id, entityLabel: String(rec.year) });
  res.json(db.findById('years', rec.id));
});

// ---------- Year rollover ----------
// Creates the new year: copies every goal, auto-filling "previous year
// actual" from this year's entered figures (sum for counts, last value for
// %/dates). TYRP targets are cleared (the new template sets them); local
// goals keep their text targets. Activities copy as drafts.
router.post('/rollover', ...yearsManage, (req, res) => {
  const newYear = Number(req.body.newYear);
  if (!newYear || newYear < 2020 || newYear > 2100) return res.status(400).json({ error: 'Enter a valid year.' });
  if (db.findAll('goals', g => g.year === newYear).length) return res.status(400).json({ error: `${newYear} already has goals — rollover was already done.` });
  const fromYear = newYear - 1;
  const goals = db.findAll('goals', g => g.year === fromYear);
  if (!goals.length) return res.status(400).json({ error: `No ${fromYear} goals to roll over.` });
  const entries = db.findAll('kpi_entries', e => e.year === fromYear);

  let created = 0;
  goals.forEach(g => {
    const kpis = (g.kpis || []).map((k, i) => {
      let prev = null;
      const unit = (k.unit || '').toLowerCase();
      if (unit === '%' || unit === 'date') {
        for (let q = 4; q >= 1; q--) {
          const e = entries.find(x => x.goalId === g.id && x.quarter === q);
          const v = e && e.values ? e.values[i] : null;
          if (v !== null && v !== undefined && v !== '') { prev = v; break; }
        }
      } else {
        let sum = 0, any = false;
        for (let q = 1; q <= 4; q++) {
          const e = entries.find(x => x.goalId === g.id && x.quarter === q);
          const v = e && e.values ? Number(e.values[i]) : NaN;
          if (!isNaN(v)) { sum += v; any = true; }
        }
        prev = any ? sum : null;
      }
      return { ...k, prevActual: prev, target: (g.source === 'tyrp' || g.source === 'merged') ? null : k.target };
    });
    db.insert('goals', { ...g, id: undefined, year: newYear, kpis, createdAt: undefined });
    created++;
  });

  // carry activities as drafts
  let acts = 0;
  if (req.body.copyActivities !== false) {
    db.findAll('activities', a => a.year === fromYear).forEach(a => {
      db.insert('activities', { ...a, id: undefined, year: newYear, actualSpend: null, createdAt: undefined });
      acts++;
    });
  }
  // fundraising events for the new year
  ['Launch', '1st Fundraising', '2nd Fundraising', 'Main Harvest'].forEach((name, i) => {
    if (!db.findOne('fundraising_events', e => e.year === newYear && e.name === name)) {
      db.insert('fundraising_events', { year: newYear, name, target: null, order: i + 1 });
    }
  });
  if (!db.findOne('fundraising_meta', m => m.year === newYear)) db.insert('fundraising_meta', { year: newYear, annualTarget: null });

  const yr = db.findOne('years', y => y.year === newYear) || db.insert('years', { year: newYear, active: false, quarters: { 1: 'open', 2: 'open', 3: 'open', 4: 'open' } });
  logActivity({ ...actor(req), action: `Rolled over to ${newYear} (${created} goals, ${acts} activities)`, entityType: 'year', entityId: yr.id, entityLabel: String(newYear) });
  res.json({ ok: true, goals: created, activities: acts });
});

// ---------- Committees ----------
router.get('/committees', requireAuth, (req, res) => {
  let list = db.findAll('committees').filter(c => c.active !== false);
  if (!canViewAll(req)) {
    const ids = userEntityIds(req, 'committee');
    list = list.filter(c => ids.includes(Number(c.id)));
  }
  res.json(list.sort((a, b) => (a.name || '').localeCompare(b.name || '')));
});

// Codes and names are compared the way a person reads them: "CC", "cc " and
// "C C" are the same code, and "Church Choir" / "church choir" the same name.
// On 4 Oct 2026 the Choir was archived by mistake and re-created as "C-C"
// because nothing refused a second "Church Choir"; the board then showed two.
// Archived bodies count too — the fix for an archived one is Restore, not a twin.
const normEntCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const normEntName = n => String(n || '').toLowerCase().replace(/\s+/g, ' ').trim();
function clash(collection, { code, name }, exceptId) {
  const all = db.findAll(collection, r => Number(r.id) !== Number(exceptId));
  const byCode = code !== undefined && all.find(r => normEntCode(r.code) === normEntCode(code));
  if (byCode) return `The code ${byCode.code} is already used by \u201c${byCode.name}\u201d${byCode.active === false ? ' (archived \u2014 restore it instead)' : ''}.`;
  const byName = name !== undefined && all.find(r => normEntName(r.name) === normEntName(name));
  if (byName) return `\u201c${byName.name}\u201d already exists${byName.active === false ? ' but is archived \u2014 restore it instead of creating a new one' : ''}.`;
  return null;
}

// Archive / restore get their own log lines so the activity log says what
// happened, not "Updated group" (which is all it said for the Choir).
function logStructureChange(req, kind, rec, patch) {
  const label = kind === 'group' ? 'group' : 'committee';
  let action = `Updated ${label}`;
  if (patch.active === false && rec.active !== false) action = `ARCHIVED ${label}`;
  else if (patch.active === true && rec.active === false) action = `RESTORED ${label}`;
  logActivity({ ...actor(req), action, entityType: label, entityId: rec.id, entityLabel: rec.name });
}

// Archived bodies, for the Restore list. Structure managers only.
router.get('/committees/archived', ...structureManage, (req, res) => {
  res.json(db.findAll('committees', c => c.active === false).sort((a, b) => (a.name || '').localeCompare(b.name || '')));
});

router.post('/committees', ...structureManage, (req, res) => {
  const { code, name, type } = req.body;
  if (!String(code || '').trim() || !String(name || '').trim()) return res.status(400).json({ error: 'Code and name are required.' });
  const c = clash('committees', { code, name });
  if (c) return res.status(409).json({ error: c });
  const rec = db.insert('committees', {
    code: String(code).trim(), name: String(name).trim(),
    type: type === 'local' ? 'local' : 'standard',
    special: req.body.special || null,
    signatories: req.body.signatories || {}, active: true,
  });
  logActivity({ ...actor(req), action: 'Created committee', entityType: 'committee', entityId: rec.id, entityLabel: rec.name });
  res.json(rec);
});

router.put('/committees/:id', ...structureManage, (req, res) => {
  const rec = db.findById('committees', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Committee not found.' });
  const patch = {};
  ['name', 'type', 'special', 'signatories', 'active'].forEach(k => {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  });
  if (patch.name !== undefined) {
    if (!String(patch.name).trim()) return res.status(400).json({ error: 'A name is required.' });
    const c = clash('committees', { name: patch.name }, rec.id);
    if (c) return res.status(409).json({ error: c });
    patch.name = String(patch.name).trim();
  }
  const updated = db.update('committees', rec.id, patch);
  logStructureChange(req, 'committee', rec, patch);
  res.json(updated);
});

// ---------- Groups ----------
router.get('/groups', requireAuth, (req, res) => {
  let list = db.findAll('groups').filter(g => g.active !== false);
  if (!canViewAll(req)) {
    const ids = userEntityIds(req, 'group');
    list = list.filter(g => ids.includes(Number(g.id)));
  }
  // Generational groups first, in the congregation's own order, then the rest
  // alphabetically — see utils/groupOrder.js. Sorting HERE means every group
  // dropdown in the app (Attendance, Meetings, Users, Access, ShareHub) picks
  // the order up without each page having to know about it.
  res.json(sortGroups(list));
});

router.get('/groups/archived', ...structureManage, (req, res) => {
  res.json(sortGroups(db.findAll('groups', g => g.active === false)));
});

router.post('/groups', ...structureManage, (req, res) => {
  const { code, name, type } = req.body;
  if (!String(code || '').trim() || !String(name || '').trim()) return res.status(400).json({ error: 'Code and name are required.' });
  const c = clash('groups', { code, name });
  if (c) return res.status(409).json({ error: c });
  const rec = db.insert('groups', {
    code: String(code).trim(), name: String(name).trim(),
    type: type === 'generational' ? 'generational' : 'non-generational',
    meetingDay: req.body.meetingDay || '', signatories: req.body.signatories || {}, active: true,
  });
  logActivity({ ...actor(req), action: 'Created group', entityType: 'group', entityId: rec.id, entityLabel: rec.name });
  res.json(rec);
});

router.put('/groups/:id', ...structureManage, (req, res) => {
  const rec = db.findById('groups', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Group not found.' });
  const patch = {};
  ['name', 'type', 'meetingDay', 'special', 'signatories', 'active'].forEach(k => {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  });
  if (patch.name !== undefined) {
    if (!String(patch.name).trim()) return res.status(400).json({ error: 'A name is required.' });
    const c = clash('groups', { name: patch.name }, rec.id);
    if (c) return res.status(409).json({ error: c });
    patch.name = String(patch.name).trim();
  }
  const updated = db.update('groups', rec.id, patch);
  logStructureChange(req, 'group', rec, patch);
  res.json(updated);
});

// ---------- Members (rosters) ----------
// Read: admins/clerk/viewers see any roster; committee/group accounts see only their own.
router.get('/members', requireAuth, (req, res) => {
  const { entityType, entityId } = req.query;
  let list = db.findAll('members');
  if (entityType) list = list.filter(m => m.entityType === entityType);
  if (entityId) list = list.filter(m => Number(m.entityId) === Number(entityId));
  if (!canViewAll(req)) {
    const ent = userEntity(req);
    if (!ent) return res.status(403).json({ error: 'Your account is not attached to a committee or group.' });
    list = list.filter(m => m.entityType === ent.type && Number(m.entityId) === Number(ent.id));
  }
  res.json(list.sort((a, b) => (a.name || '').localeCompare(b.name || '')));
});

// Direct roster edits: admin / roster.manage.
router.post('/members', requireAuth, (req, res) => {
  const { name, entityType, entityId, sex } = req.body;
  if (!name || !entityType || !entityId) return res.status(400).json({ error: 'Name, entity type and entity are required.' });
  if (!canManageRoster(req, entityType, Number(entityId))) return res.status(403).json({ error: 'You can only manage your own group\'s roster.' });
  if (!['male', 'female'].includes(String(sex))) return res.status(400).json({ error: 'Please select Male or Female for the member.' });
  const photoFile = req.body.photo ? saveMemberPhoto(req.body.photo) : null;
  const rec = ensureIdentity(db.insert('members', {
    name: String(name).trim(), sex: String(sex),
    phone: String(req.body.phone || '').trim(), email: String(req.body.email || '').trim(),
    entityType, entityId: Number(entityId), position: req.body.position || 'Member',
    photoFile: photoFile || null,
    coopted: !!req.body.coopted, notifyPref: req.body.notifyPref || ['sms'], contactApproved: true,
  }));
  logActivity({ ...actor(req), action: 'Added roster member', entityType: 'member', entityId: rec.id, entityLabel: rec.name });
  res.json(rec);
});

// Admin/roster.manage may edit everything about a member; the Reporting
// Coordinator (congregation.manage) may update CONTACT details only (phone/
// email) — directly, without the propose->approve flow.
router.put('/members/:id', requireAuth, (req, res) => {
  const rec = db.findById('members', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Member not found.' });
  const caller = db.findById('users', req.user.id) || {};
  // Full edit: admins / roster.manage anywhere, and a group account on its OWN
  // group's members. Contact-only: the Coordinator (congregation.manage).
  const fullEdit = canManageRoster(req, rec.entityType, rec.entityId);
  const coordinator = (caller.permissions || []).includes('congregation.manage');
  if (!fullEdit && !coordinator) return res.status(403).json({ error: 'You cannot edit this member.' });
  const allowed = fullEdit
    ? ['name', 'sex', 'phone', 'email', 'position', 'coopted', 'notifyPref', 'contactApproved', 'photo']
    : ['phone', 'email'];
  const patch = {};
  allowed.forEach(k => {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  });
  // Photo (full-edit only): a base64 data URL replaces it, an empty string
  // removes it. Old file is deleted either way. Never a raw copy from the body.
  if (fullEdit && req.body.photo !== undefined) {
    if (rec.photoFile) deleteMemberPhoto(rec.photoFile);
    patch.photoFile = req.body.photo ? saveMemberPhoto(req.body.photo) : null;
  }
  // A direct edit by admin/coordinator counts as approved contact info.
  if (!fullEdit && (patch.phone !== undefined || patch.email !== undefined)) patch.contactApproved = true;
  const updated = db.update('members', rec.id, patch);
  logActivity({ ...actor(req), action: 'Updated roster member', entityType: 'member', entityId: rec.id, entityLabel: rec.name });
  res.json(updated);
});

// A face photo is sensitive, so it's only served to people with a legitimate
// reason to see this member: admins, roster editors / congregation viewers,
// attendance recorders (for check-in), or that member's own group account.
function canViewMemberPhoto(req, member) {
  if (isAdmin(req)) return true;
  const u = db.findById('users', req.user.id) || {};
  const perms = u.permissions || [];
  if (['members.photos', 'roster.manage', 'congregation.view', 'approvals.manage', 'attendance.cs', 'attendance.jy', 'attendance.main'].some(p => perms.includes(p))) return true;
  const ent = u.entity;
  return !!(ent && ent.type === member.entityType && Number(ent.id) === Number(member.entityId));
}
// Auth-gated member photo (never a public URL).
router.get('/members/:id/photo', requireAuth, (req, res) => {
  const rec = db.findById('members', Number(req.params.id));
  if (!rec || !rec.photoFile || !canViewMemberPhoto(req, rec)) return res.status(404).end();
  const p = memberPhotoPath(rec.photoFile);
  if (!p) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(p);
});

router.delete('/members/:id', requireAuth, (req, res) => {
  const rec = db.findById('members', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Member not found.' });
  if (!canManageRoster(req, rec.entityType, rec.entityId)) return res.status(403).json({ error: 'You can only remove members from your own group.' });
  if (rec.photoFile) deleteMemberPhoto(rec.photoFile);
  db.remove('members', rec.id);
  logActivity({ ...actor(req), action: 'Removed roster member', entityType: 'member', entityId: rec.id, entityLabel: rec.name, snapshot: rec });
  res.json({ ok: true });
});

// ---------- Import contacts from user logins ----------
// The people with login accounts (secretaries, coordinators, presidents...)
// already gave us their phone/email. This copies those contacts onto every
// roster member with the same name, across ALL committees and groups —
// filling gaps only, never overwriting contacts already on the roster.
function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')                                  // drop "(Dr)", "(Pharm.)"...
    .replace(/\b(dr|ing|rev|pharm|prof|mr|mrs|ms|esq)\.?\b/g, ' ') // drop honourifics
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

router.post('/import-user-contacts', requireAuth, requireAnyPermission('roster.manage', 'congregation.manage'), (req, res) => {
  const users = db.findAll('users').filter(u => u.phone || u.email);
  const members = db.findAll('members');
  const entityName = m => {
    const rec = db.findById(m.entityType === 'committee' ? 'committees' : 'groups', Number(m.entityId));
    return rec ? rec.name : `${m.entityType} ${m.entityId}`;
  };
  const updated = [];
  const noMatch = [];
  for (const u of users) {
    const key = normName(u.name);
    if (!key) continue;
    const matches = members.filter(m => normName(m.name) === key);
    if (!matches.length) { noMatch.push(u.name); continue; }
    for (const m of matches) {
      const patch = {};
      if (!m.phone && u.phone) patch.phone = u.phone;
      if (!m.email && u.email) patch.email = u.email;
      if (Object.keys(patch).length) {
        patch.contactApproved = true; // contacts from a verified login are trusted
        db.update('members', m.id, patch);
        updated.push({ member: m.name, entity: entityName(m), filled: Object.keys(patch).filter(k => k !== 'contactApproved') });
      }
    }
  }
  logActivity({ ...actor(req), action: `Imported contacts from user logins (${updated.length} roster entr${updated.length === 1 ? 'y' : 'ies'} filled)`, entityType: 'member', entityId: 0, entityLabel: 'bulk import' });
  res.json({ updated, noMatch, usersChecked: users.length });
});

// ---------- Roster requests (propose -> Session Clerk approves) ----------
// type: 'contact-update' (member of own roster) | 'co-opt' (new person: name + contact)
router.post('/roster-requests', requireAuth, requirePermission('roster.propose'), (req, res) => {
  const ent = userEntity(req);
  if (!ent || ent.type === 'congregation') return res.status(403).json({ error: 'Your account is not attached to a committee or group.' });
  const { type } = req.body;
  if (type === 'contact-update') {
    const member = db.findById('members', Number(req.body.memberId));
    if (!member || member.entityType !== ent.type || Number(member.entityId) !== Number(ent.id)) {
      return res.status(400).json({ error: 'That member is not on your roster.' });
    }
    if (!req.body.phone && !req.body.email) return res.status(400).json({ error: 'Provide a phone number or email.' });
    const rec = db.insert('roster_requests', {
      type, status: 'pending', entityType: ent.type, entityId: Number(ent.id),
      memberId: member.id, memberName: member.name,
      phone: String(req.body.phone || '').trim(), email: String(req.body.email || '').trim(),
      requestedBy: actor(req).userName, requestedById: req.user.id,
    });
    logActivity({ ...actor(req), action: 'Proposed contact update', entityType: 'roster_request', entityId: rec.id, entityLabel: member.name });
    notifyApprovers('Roster request awaiting approval',
      `${rec.requestedBy} proposed a contact update for ${member.name}. Approve or decline on the Committees/Groups page.`,
      req.user.id, ent.type === 'group' ? '/groups.html' : '/committees.html');
    return res.json(rec);
  }
  if (type === 'co-opt') {
    if (!req.body.name || (!req.body.phone && !req.body.email)) {
      return res.status(400).json({ error: 'A co-opt request needs the person\'s name and a contact.' });
    }
    const rec = db.insert('roster_requests', {
      type, status: 'pending', entityType: ent.type, entityId: Number(ent.id),
      memberName: String(req.body.name).trim(), sex: ['male', 'female'].includes(String(req.body.sex)) ? String(req.body.sex) : '',
      phone: String(req.body.phone || '').trim(), email: String(req.body.email || '').trim(),
      requestedBy: actor(req).userName, requestedById: req.user.id,
    });
    logActivity({ ...actor(req), action: 'Proposed co-opted member', entityType: 'roster_request', entityId: rec.id, entityLabel: rec.memberName });
    notifyApprovers('Roster request awaiting approval',
      `${rec.requestedBy} proposed co-opting ${rec.memberName}. Approve or decline on the Committees/Groups page.`,
      req.user.id, ent.type === 'group' ? '/groups.html' : '/committees.html');
    return res.json(rec);
  }
  res.status(400).json({ error: 'Request type must be contact-update or co-opt.' });
});

router.get('/roster-requests', requireAuth, (req, res) => {
  let list = db.findAll('roster_requests');
  if (!canViewAll(req)) {
    const ent = userEntity(req);
    if (!ent) return res.json([]);
    list = list.filter(r => r.entityType === ent.type && Number(r.entityId) === Number(ent.id));
  }
  res.json(list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
});

router.post('/roster-requests/:id/approve', ...approve, (req, res) => {
  const rec = db.findById('roster_requests', Number(req.params.id));
  if (!rec || rec.status !== 'pending') return res.status(404).json({ error: 'No pending request found.' });
  if (rec.type === 'contact-update') {
    db.update('members', rec.memberId, {
      ...(rec.phone ? { phone: rec.phone } : {}), ...(rec.email ? { email: rec.email } : {}),
      contactApproved: true,
    });
  } else if (rec.type === 'co-opt') {
    ensureIdentity(db.insert('members', {
      name: rec.memberName, sex: rec.sex || '', phone: rec.phone, email: rec.email,
      entityType: rec.entityType, entityId: rec.entityId, position: 'Member',
      coopted: true, notifyPref: ['sms'], contactApproved: true,
    }));
  }
  db.update('roster_requests', rec.id, { status: 'approved', decidedBy: actor(req).userName, decidedAt: new Date().toISOString() });
  logActivity({ ...actor(req), action: `Approved ${rec.type === 'co-opt' ? 'co-opted member' : 'contact update'}`, entityType: 'roster_request', entityId: rec.id, entityLabel: rec.memberName });
  notifyUser(db.findById('users', rec.requestedById), 'Roster request approved',
    `Your ${rec.type === 'co-opt' ? `request to co-opt ${rec.memberName}` : `contact update for ${rec.memberName}`} was approved by ${actor(req).userName}.`,
    { url: rec.entityType === 'group' ? '/groups.html' : '/committees.html' });
  res.json({ ok: true });
});

router.post('/roster-requests/:id/decline', ...approve, (req, res) => {
  const rec = db.findById('roster_requests', Number(req.params.id));
  if (!rec || rec.status !== 'pending') return res.status(404).json({ error: 'No pending request found.' });
  db.update('roster_requests', rec.id, { status: 'declined', decidedBy: actor(req).userName, decidedAt: new Date().toISOString(), reason: req.body.reason || '' });
  logActivity({ ...actor(req), action: 'Declined roster request', entityType: 'roster_request', entityId: rec.id, entityLabel: rec.memberName });
  notifyUser(db.findById('users', rec.requestedById), 'Roster request declined',
    `Your ${rec.type === 'co-opt' ? `request to co-opt ${rec.memberName}` : `contact update for ${rec.memberName}`} was declined by ${actor(req).userName}${req.body.reason ? `: ${req.body.reason}` : '.'}`,
    { url: rec.entityType === 'group' ? '/groups.html' : '/committees.html' });
  res.json({ ok: true });
});

// ---------- Goals & KPIs ----------
router.get('/goals', requireAuth, (req, res) => {
  const year = Number(req.query.year) || null;
  let list = db.findAll('goals');
  if (year) list = list.filter(g => g.year === year);
  if (req.query.ownerCode) list = list.filter(g => g.ownerCode === req.query.ownerCode);
  if (!canViewAll(req)) {
    const ent = userEntity(req);
    if (!ent || ent.type === 'congregation') return res.json([]);
    const coll = ent.type === 'committee' ? 'committees' : 'groups';
    const rec = db.findById(coll, Number(ent.id));
    const code = rec ? rec.code : null;
    list = list.filter(g => g.ownerCode === code);
  }
  // Mark the goals this account is RESPONSIBLE for that other bodies also work
  // on, so the page can offer the roll-up. A scoped committee only receives its
  // own goals, so it cannot work this out for itself. Derived, never stored.
  const { isParentOwner } = require('../utils/goalRollup');
  const years = [...new Set(list.map(g => g.year))];
  if (years.length) {
    const fam = {};
    db.findAll('goals', g => years.includes(g.year)).forEach(g => {
      const k = g.year + '|' + g.code;
      (fam[k] = fam[k] || []).push(g);
    });
    list = list.map(g => {
      const rows = fam[g.year + '|' + g.code] || [];
      const parents = rows.filter(isParentOwner);
      const isParent = rows.length > 1 && parents.length === 1 && parents[0].id === g.id;
      return isParent ? { ...g, sharedWith: rows.length - 1 } : g;
    });
  }
  // Alphanumeric by goal code (SO-1.1 before SO-1.2 before SO-2.1 ...).
  res.json(list.sort((a, b) => (a.code || '').localeCompare(b.code || '', undefined, { numeric: true })));
});

// The roll-up behind a shared goal: what each participating group reported and
// what they actually did, for the committee RESPONSIBLE for that goal.
//
// Strictly read-only, and deliberately narrow: it opens a window onto other
// entities' data only for a goal this account's own committee parents. It is
// not a widening of congregation.view — a committee sees the groups working on
// its goal and nothing else.
router.get('/goals/:id/rollup', requireAuth, (req, res) => {
  const { rollupForGoal } = require('../utils/goalRollup');
  const goal = db.findById('goals', Number(req.params.id));
  if (!goal) return res.status(404).json({ error: 'Goal not found.' });

  if (!canViewAll(req)) {
    const ent = userEntity(req);
    const coll = ent && ent.type === 'committee' ? 'committees' : 'groups';
    const rec = ent && ent.type !== 'congregation' ? db.findById(coll, Number(ent.id)) : null;
    if (!rec || rec.code !== goal.ownerCode) {
      return res.status(403).json({ error: 'Only the committee responsible for this goal can see how the groups are working on it.' });
    }
  }

  const year = Number(req.query.year) || goal.year;
  const quarter = Number(req.query.quarter) || (Math.floor(new Date().getMonth() / 3) + 1);
  const roll = rollupForGoal(goal, { year, quarter });
  if (!roll) return res.json({ shared: false });

  const pGoalIds = new Set(roll.participants.map(p => p.goalId));
  const acts = db.findAll('activities', a => a.year === year && pGoalIds.has(a.goalId));
  const actIds = new Set(acts.map(a => a.id));
  const updates = actIds.size
    ? db.findAll('activity_updates', u => u.year === year && u.quarter === quarter && actIds.has(u.activityId)) : [];

  const participants = roll.participants.map(p => {
    const mine = acts.filter(a => Number(a.goalId) === Number(p.goalId));
    const submitted = !!db.findOne('submissions', x => x.year === year && x.quarter === quarter &&
      x.entityType === p.entityType && Number(x.entityId) === Number(p.entityId) && x.status === 'submitted');
    return {
      ...p, submitted,
      activities: mine.map(a => {
        const u = updates.find(x => x.activityId === a.id) || {};
        return {
          description: a.description,
          target: (a.targets || {})['q' + quarter] || '',
          actual: u.actual || '', remarks: u.remarks || '',
        };
      }),
      values: roll.kpis.map(k => (k.current.contributions.find(c => c.goalId === p.goalId) || {}).value ?? null),
    };
  });

  res.json({
    shared: true, year, quarter, code: goal.code, description: goal.description,
    parent: roll.parent,
    kpis: roll.kpis.map(k => ({
      description: k.description, unit: k.unit, summable: k.summable,
      own: k.current.own, total: k.current.total, reported: k.current.reported,
    })),
    participants,
    // Oversight, not interference: who has nothing planned, and who has not
    // sent their quarter in yet.
    noActivities: participants.filter(p => !p.activities.length).map(p => p.name),
    notSubmitted: participants.filter(p => !p.submitted).map(p => p.name),
  });
});

router.post('/goals', ...goalsManage, (req, res) => {
  const { year, code, description, ownerCode, source } = req.body;
  if (!year || !code || !description || !ownerCode) return res.status(400).json({ error: 'Year, code, description and owning committee/group are required.' });
  if (db.findOne('goals', g => g.year === Number(year) && g.code === code)) return res.status(400).json({ error: `Goal ${code} already exists for ${year}.` });
  // Derive ownerType from the code itself (never trust the client): a scoped
  // account only ever sees goals whose ownerCode equals its own code, and the
  // entry page uses ownerType to know which collection the owner lives in — so
  // a group goal MUST be stored as ownerType 'group', not 'committee'.
  const ownerType = deriveOwnerType(ownerCode);
  if (!ownerType) return res.status(400).json({ error: 'Unknown owner — pick a committee, a group, or the congregation.' });
  if (!goalAccess(req, ownerCode)) return res.status(403).json({ error: 'You can only propose goals for your own committee or group.' });
  const payload = {
    year: Number(year), code: String(code).trim(), description: String(description).trim(),
    ownerType, ownerCode, source: source || 'committee_tor',
    kpis: Array.isArray(req.body.kpis) ? req.body.kpis : [],
    interventionRef: req.body.interventionRef || null,
  };

  // Admin tier + Session Clerk: the goal goes live straight away.
  if (canApproveGoals(req)) {
    const rec = db.insert('goals', payload);
    logActivity({ ...actor(req), action: 'Created goal', entityType: 'goal', entityId: rec.id, entityLabel: rec.code });
    return res.json(rec);
  }

  // Everyone else: the goal is held as a pending request until the Session
  // Clerk approves it. It does NOT enter the live goals list yet.
  if (db.findOne('goal_requests', r => r.status === 'pending' && r.year === payload.year && r.code === payload.code)) {
    return res.status(400).json({ error: `Goal ${payload.code} for ${payload.year} is already awaiting approval.` });
  }
  const reqRec = db.insert('goal_requests', {
    ...payload, status: 'pending',
    requestedBy: actor(req).userName, requestedById: req.user.id,
  });
  logActivity({ ...actor(req), action: 'Proposed goal', entityType: 'goal_request', entityId: reqRec.id, entityLabel: reqRec.code });
  notifyApprovers('Goal awaiting approval',
    `${reqRec.requestedBy} proposed goal ${reqRec.code} (${reqRec.description}). Approve or decline on the Goals & KPIs page.`,
    req.user.id, '/goals.html');
  res.json({ pending: true, request: reqRec });
});

// ---------- Goal requests (propose -> Session Clerk approves) ----------
// Approvers see every pending request; a proposer sees only their own.
router.get('/goal-requests', requireAuth, (req, res) => {
  let list = db.findAll('goal_requests');
  if (!canApproveGoals(req)) list = list.filter(r => Number(r.requestedById) === Number(req.user.id));
  if (req.query.status) list = list.filter(r => r.status === req.query.status);
  res.json(list.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')));
});

router.post('/goal-requests/:id/approve', ...approve, (req, res) => {
  const rec = db.findById('goal_requests', Number(req.params.id));
  if (!rec || rec.status !== 'pending') return res.status(404).json({ error: 'No pending goal request found.' });
  if (rec.kind === 'edit') {
    const goal = db.findById('goals', Number(rec.goalId));
    if (!goal) {
      db.update('goal_requests', rec.id, { status: 'declined', decidedBy: actor(req).userName, decidedAt: new Date().toISOString(), reason: 'The goal no longer exists.' });
      return res.status(400).json({ error: `Goal ${rec.code} no longer exists — the request was closed.` });
    }
    const patch = { ...(rec.patch || {}) };
    delete patch.ownerCode; delete patch.ownerType;
    const updated = db.update('goals', goal.id, patch);
    db.update('goal_requests', rec.id, { status: 'approved', decidedBy: actor(req).userName, decidedAt: new Date().toISOString() });
    logActivity({ ...actor(req), action: 'Approved goal change', entityType: 'goal', entityId: goal.id, entityLabel: goal.code });
    notifyUser(db.findById('users', rec.requestedById), 'Goal change approved',
      `Your change to goal ${rec.code} was approved by ${actor(req).userName} and is now live.`,
      { url: '/goals.html' });
    return res.json({ ok: true, goal: updated });
  }
  if (db.findOne('goals', g => g.year === Number(rec.year) && g.code === rec.code)) {
    db.update('goal_requests', rec.id, { status: 'declined', decidedBy: actor(req).userName, decidedAt: new Date().toISOString(), reason: 'A goal with this code already exists.' });
    return res.status(400).json({ error: `Goal ${rec.code} already exists for ${rec.year} — the request was closed.` });
  }
  const goal = db.insert('goals', {
    year: Number(rec.year), code: rec.code, description: rec.description,
    ownerType: rec.ownerType, ownerCode: rec.ownerCode, source: rec.source,
    kpis: Array.isArray(rec.kpis) ? rec.kpis : [], interventionRef: rec.interventionRef || null,
  });
  db.update('goal_requests', rec.id, { status: 'approved', decidedBy: actor(req).userName, decidedAt: new Date().toISOString(), goalId: goal.id });
  logActivity({ ...actor(req), action: 'Approved goal', entityType: 'goal', entityId: goal.id, entityLabel: goal.code });
  notifyUser(db.findById('users', rec.requestedById), 'Goal approved',
    `Your goal ${rec.code} was approved by ${actor(req).userName} and is now live.`,
    { url: '/goals.html' });
  res.json({ ok: true, goal });
});

router.post('/goal-requests/:id/decline', ...approve, (req, res) => {
  const rec = db.findById('goal_requests', Number(req.params.id));
  if (!rec || rec.status !== 'pending') return res.status(404).json({ error: 'No pending goal request found.' });
  db.update('goal_requests', rec.id, { status: 'declined', decidedBy: actor(req).userName, decidedAt: new Date().toISOString(), reason: req.body.reason || '' });
  logActivity({ ...actor(req), action: 'Declined goal request', entityType: 'goal_request', entityId: rec.id, entityLabel: rec.code });
  notifyUser(db.findById('users', rec.requestedById), 'Goal request declined',
    `Your goal ${rec.code} was declined by ${actor(req).userName}${req.body.reason ? `: ${req.body.reason}` : '.'}`,
    { url: '/goals.html' });
  res.json({ ok: true });
});

router.put('/goals/:id', ...goalsManage, (req, res) => {
  const rec = db.findById('goals', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Goal not found.' });
  const access = goalAccess(req, rec.ownerCode);
  if (!access) return res.status(403).json({ error: 'You can only change goals that belong to your own committee or group.' });
  const patch = {};
  ['description', 'ownerCode', 'source', 'kpis', 'interventionRef'].forEach(k => {
    if (req.body[k] !== undefined) patch[k] = req.body[k];
  });
  // If the owner is being changed, re-derive ownerType from the new code so it
  // always matches (never trust a client-sent ownerType).
  if (patch.ownerCode !== undefined) {
    const t = deriveOwnerType(patch.ownerCode);
    if (!t) return res.status(400).json({ error: 'Unknown owner — pick a committee, a group, or the congregation.' });
    patch.ownerType = t;
  }

  if (access === 'propose') {
    // A secretary may not hand their goal to somebody else.
    if (patch.ownerCode !== undefined && patch.ownerCode !== rec.ownerCode) {
      return res.status(403).json({ error: 'Only the Session Clerk can move a goal to another committee or group.' });
    }
    delete patch.ownerCode; delete patch.ownerType;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });
    if (db.findOne('goal_requests', r => r.status === 'pending' && r.kind === 'edit' && Number(r.goalId) === rec.id)) {
      return res.status(409).json({ error: `A change to ${rec.code} is already waiting for the Session Clerk.` });
    }
    // Keep what it said before, so the Clerk sees the change, not just the result.
    const before = {};
    Object.keys(patch).forEach(k => { before[k] = rec[k] === undefined ? null : rec[k]; });
    const reqRec = db.insert('goal_requests', {
      kind: 'edit', goalId: rec.id, year: rec.year, code: rec.code,
      description: patch.description !== undefined ? patch.description : rec.description,
      ownerType: rec.ownerType, ownerCode: rec.ownerCode,
      patch, before, status: 'pending',
      requestedBy: actor(req).userName, requestedById: req.user.id,
    });
    logActivity({ ...actor(req), action: 'Proposed goal change', entityType: 'goal_request', entityId: reqRec.id, entityLabel: rec.code });
    notifyApprovers('Goal change awaiting approval',
      `${reqRec.requestedBy} proposed a change to goal ${rec.code}. Approve or decline on the Goals & KPIs page.`,
      req.user.id, '/goals.html');
    return res.json({ pending: true, request: reqRec });
  }

  const updated = db.update('goals', rec.id, patch);
  logActivity({ ...actor(req), action: 'Updated goal', entityType: 'goal', entityId: rec.id, entityLabel: rec.code });
  res.json(updated);
});

// Delete a goal. Admin tier only — this is destructive and a Reporting
// Coordinator should be editing goals, not removing them.
//
// A goal is rarely alone: quarterly figures (kpi_entries) hang off its id, so
// do the activities planned to achieve it, and a goal shared with the groups is
// the parent of a family of copies. Deleting blind would silently orphan real
// reported data. So the first attempt REFUSES and says exactly what is attached;
// only a deliberate ?force=1 (a second, explicit confirmation in the UI) goes
// ahead, and even then activities are UNLINKED rather than deleted — the work a
// committee planned is theirs, and it outlives the goal it was filed under.
router.delete('/goals/:id', requireAuth, (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Only an administrator can delete a goal.' });
  }
  const rec = db.findById('goals', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Goal not found.' });

  const entries = db.findAll('kpi_entries', e => Number(e.goalId) === rec.id);
  const acts = db.findAll('activities', a => Number(a.goalId) === rec.id);
  const { familyOf } = require('../utils/goalRollup');
  const fam = familyOf(rec);
  const isParent = !!(fam && fam.parent.id === rec.id);

  if (!['1', 'true', 'yes'].includes(String(req.query.force || ''))) {
    if (entries.length || acts.length || isParent) {
      const parts = [];
      if (entries.length) parts.push(`${entries.length} quarter${entries.length === 1 ? '' : 's'} of reported figures`);
      if (acts.length) parts.push(`${acts.length} activit${acts.length === 1 ? 'y' : 'ies'}`);
      if (isParent) parts.push(`${fam.participants.length} group${fam.participants.length === 1 ? '' : 's'} sharing it`);
      return res.status(409).json({
        error: `${rec.code} has ${parts.join(', ')} attached.`,
        blockers: {
          entries: entries.length,
          activities: acts.length,
          sharedWith: isParent ? fam.participants.length : 0,
          quarters: [...new Set(entries.map(e => `Q${e.quarter} ${e.year}`))].sort(),
        },
      });
    }
  }

  // Forced (or nothing attached): remove the figures, keep the work.
  entries.forEach(e => db.remove('kpi_entries', e.id));
  acts.forEach(a => db.update('activities', a.id, { goalId: null }));
  db.remove('goals', rec.id);
  logActivity({
    ...actor(req),
    action: `DELETED goal${entries.length ? ` with ${entries.length} KPI entr${entries.length === 1 ? 'y' : 'ies'}` : ''}${acts.length ? `; ${acts.length} activit${acts.length === 1 ? 'y' : 'ies'} unlinked` : ''}`,
    entityType: 'goal', entityId: rec.id, entityLabel: `${rec.code} (${rec.ownerCode})`,
  });
  res.json({ ok: true, removedEntries: entries.length, unlinkedActivities: acts.length });
});

// ---------- Dashboard summary (personalised for scoped accounts) ----------
router.get('/summary', requireAuth, (req, res) => {
  const activeYear = db.findOne('years', y => y.active);
  if (!canViewAll(req)) {
    const ent = userEntity(req);
    if (ent && ent.type !== 'congregation') {
      const coll = ent.type === 'committee' ? 'committees' : 'groups';
      const rec = db.findById(coll, Number(ent.id));
      const code = rec ? rec.code : null;
      const myGoals = db.findAll('goals').filter(g => g.ownerCode === code && (!activeYear || g.year === activeYear.year));
      return res.json({
        scope: 'entity',
        entityName: rec ? rec.name : '', entityCode: code, entityType: ent.type,
        year: activeYear ? activeYear.year : null,
        goals: myGoals.length,
        kpis: myGoals.reduce((n, g) => n + (g.kpis || []).length, 0),
        roster: db.findAll('members').filter(m => m.entityType === ent.type && Number(m.entityId) === Number(ent.id)).length,
        myPendingRequests: db.findAll('roster_requests').filter(r => r.status === 'pending' && r.entityType === ent.type && Number(r.entityId) === Number(ent.id)).length,
      });
    }
  }
  res.json({
    scope: 'congregation',
    year: activeYear ? activeYear.year : null,
    committees: db.findAll('committees').filter(c => c.active !== false).length,
    groups: db.findAll('groups').filter(g => g.active !== false).length,
    members: db.findAll('members').length,
    goals: db.findAll('goals').filter(g => !activeYear || g.year === activeYear.year).length,
    pendingRequests: db.findAll('roster_requests').filter(r => r.status === 'pending').length,
    pendingGoalRequests: db.findAll('goal_requests').filter(r => r.status === 'pending').length,
  });
});

module.exports = router;
