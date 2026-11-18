// AOTC Track — Annual Planning module (Phase 2).
// Committees/groups plan activities (strategies) against their goals, with
// quarterly performance targets and estimated annual cost — the digital AQT.
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { requireAuth, requirePermission, canManageAllEntities } = require('../middleware/auth');
const { logActivity } = require('../utils/activityLog');

const { actor, userEntity, isAdmin, canViewAll } = require('../utils/scope');
// Writers may only touch activities of their own entity — except admins and
// congregation.manage holders (Reporting Coordinator), who work across all.
function assertOwn(req, entityType, entityId) {
  if (canManageAllEntities(req)) return null;
  const ent = userEntity(req);
  if (!ent || ent.type !== entityType || Number(ent.id) !== Number(entityId)) {
    return 'You can only plan for your own committee or group.';
  }
  return null;
}
function entityCode(entityType, entityId) {
  if (entityType === 'congregation') return 'OG';
  const rec = db.findById(entityType === 'committee' ? 'committees' : 'groups', Number(entityId));
  return rec ? rec.code : null;
}

// GET /api/planning/activities?entityType=&entityId=&year=
router.get('/activities', requireAuth, (req, res) => {
  let list = db.findAll('activities');
  const year = Number(req.query.year);
  if (year) list = list.filter(a => a.year === year);
  if (req.query.entityType) list = list.filter(a => a.entityType === req.query.entityType);
  if (req.query.entityId) list = list.filter(a => Number(a.entityId) === Number(req.query.entityId));
  if (!canViewAll(req)) {
    const ent = userEntity(req);
    if (!ent || ent.type === 'congregation') return res.json([]);
    list = list.filter(a => a.entityType === ent.type && Number(a.entityId) === Number(ent.id));
  }
  res.json(list);
});

router.post('/activities', requireAuth, requirePermission('planning.manage'), (req, res) => {
  const { description, entityType, entityId, goalId } = req.body;
  if (!description || !String(description).trim()) return res.status(400).json({ error: 'Describe the activity/strategy.' });
  let type = entityType, id = entityId;
  if (!canManageAllEntities(req)) { const ent = userEntity(req); type = ent && ent.type; id = ent && ent.id; }
  if (!type || id === undefined || id === null) return res.status(400).json({ error: 'Entity is required.' });
  const denied = assertOwn(req, type, id);
  if (denied) return res.status(403).json({ error: denied });
  if (goalId) {
    const goal = db.findById('goals', Number(goalId));
    if (!goal) return res.status(400).json({ error: 'Goal not found.' });
    if (goal.ownerCode !== entityCode(type, id)) return res.status(400).json({ error: 'That goal does not belong to this committee/group.' });
  }
  const t = req.body.targets || {};
  const activeYear = db.findOne('years', y => y.active) || { year: new Date().getFullYear() };
  const rec = db.insert('activities', {
    year: Number(req.body.year) || activeYear.year,
    goalId: goalId ? Number(goalId) : null,
    entityType: type, entityId: Number(id), ownerCode: entityCode(type, id),
    description: String(description).trim(),
    targets: { q1: String(t.q1 || '').trim(), q2: String(t.q2 || '').trim(), q3: String(t.q3 || '').trim(), q4: String(t.q4 || '').trim() },
    annualCost: req.body.annualCost !== undefined && req.body.annualCost !== '' && req.body.annualCost !== null ? Number(req.body.annualCost) : null,
    actualSpend: null,
  });
  logActivity({ ...actor(req), action: 'Added planned activity', entityType: 'activity', entityId: rec.id, entityLabel: rec.description.slice(0, 60) });
  res.json(rec);
});

router.put('/activities/:id', requireAuth, requirePermission('planning.manage'), (req, res) => {
  const rec = db.findById('activities', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Activity not found.' });
  const denied = assertOwn(req, rec.entityType, rec.entityId);
  if (denied) return res.status(403).json({ error: denied });
  const patch = {};
  if (req.body.description !== undefined) patch.description = String(req.body.description).trim();
  if (req.body.targets !== undefined) {
    const t = req.body.targets || {};
    patch.targets = { q1: String(t.q1 || '').trim(), q2: String(t.q2 || '').trim(), q3: String(t.q3 || '').trim(), q4: String(t.q4 || '').trim() };
  }
  if (req.body.annualCost !== undefined) patch.annualCost = req.body.annualCost === '' || req.body.annualCost === null ? null : Number(req.body.annualCost);
  if (req.body.goalId !== undefined) {
    if (req.body.goalId) {
      const goal = db.findById('goals', Number(req.body.goalId));
      if (!goal) return res.status(400).json({ error: 'Goal not found.' });
      if (goal.ownerCode !== rec.ownerCode) return res.status(400).json({ error: 'That goal does not belong to this committee/group.' });
      patch.goalId = Number(req.body.goalId);
    } else patch.goalId = null;
  }
  const updated = db.update('activities', rec.id, patch);
  logActivity({ ...actor(req), action: 'Updated planned activity', entityType: 'activity', entityId: rec.id, entityLabel: updated.description.slice(0, 60) });
  res.json(updated);
});

router.delete('/activities/:id', requireAuth, requirePermission('planning.manage'), (req, res) => {
  const rec = db.findById('activities', Number(req.params.id));
  if (!rec) return res.status(404).json({ error: 'Activity not found.' });
  const denied = assertOwn(req, rec.entityType, rec.entityId);
  if (denied) return res.status(403).json({ error: denied });
  db.remove('activities', rec.id);
  logActivity({ ...actor(req), action: 'Removed planned activity', entityType: 'activity', entityId: rec.id, entityLabel: rec.description.slice(0, 60), snapshot: rec });
  res.json({ ok: true });
});

// Budget totals per entity (admin/clerk view) or own entity
router.get('/budget', requireAuth, (req, res) => {
  let list = db.findAll('activities');
  if (!canViewAll(req)) {
    const ent = userEntity(req);
    if (!ent || ent.type === 'congregation') return res.json([]);
    list = list.filter(a => a.entityType === ent.type && Number(a.entityId) === Number(ent.id));
  }
  const totals = {};
  list.forEach(a => {
    const k = `${a.entityType}:${a.entityId}`;
    totals[k] = totals[k] || { entityType: a.entityType, entityId: a.entityId, ownerCode: a.ownerCode, activities: 0, plannedCost: 0 };
    totals[k].activities += 1;
    totals[k].plannedCost += a.annualCost || 0;
  });
  res.json(Object.values(totals));
});

module.exports = router;
