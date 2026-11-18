// Shared goals — a committee's goal extended to the groups.
//
// THE MODEL, as it already exists in the data: a goal that several bodies work
// on is stored as one row PER OWNER, all sharing the same `code`. ME-02
// ("Mission activities are undertaken") is one row for Mission & Evangelism
// plus one for each group that also wins souls. Each copy carries its own KPI
// targets, its own quarterly entry, and its own lock — which is exactly right,
// because each body plans and reports its own work.
//
// What was missing was the link between the copies, and the tally.
//
// NOTHING HERE WRITES. The relationship is derived at read time from data that
// already exists, so this can go live against the running server without a
// migration, a backfill, or a new field on a single record.
//
// Deriving the parent:
//   • A "family" is every goal row sharing a code within a year.
//   • The PARENT is the copy owned by a committee (or the congregation); the
//     PARTICIPANTS are the group-owned copies.
//   • If a code does not have exactly one committee/congregation-owned copy,
//     there is no family and everything behaves exactly as it does today.
// The code PREFIX is deliberately not used: 68 goals have a prefix that is not
// their owner (AHRM-05 belongs to PDBP, Edu-05 to Sch), so prefix-matching
// would invent relationships that do not exist.
const db = require('./db');
const { derivedKpiValue, ownerOf } = require('./derivedKpi');

// Units that can be added up. A count or an amount totals honestly; a
// percentage or a date never does — four groups at 40% is not 160%.
const SUMMABLE_UNITS = new Set(['no.', 'no', 'number', 'ghs', 'ghc', 'person.day', '']);
function isSummable(unit) {
  return SUMMABLE_UNITS.has(String(unit === null || unit === undefined ? '' : unit).trim().toLowerCase());
}

function isParentOwner(g) {
  return g.ownerType === 'committee' || g.ownerType === 'congregation';
}

// Every goal row sharing this code and year. Cached per call-site by the
// caller where it matters; the JSON store makes each findAll a disk read.
function familyOf(goal, allGoals) {
  if (!goal) return null;
  const rows = (allGoals || db.findAll('goals', g => g.year === goal.year && g.code === goal.code))
    .filter(g => g.year === goal.year && g.code === goal.code);
  if (rows.length < 2) return null;
  const parents = rows.filter(isParentOwner);
  if (parents.length !== 1) return null; // ambiguous — leave it alone
  return { parent: parents[0], participants: rows.filter(g => g.id !== parents[0].id) };
}

function entityName(type, id) {
  const rec = db.findById(type === 'committee' ? 'committees' : 'groups', Number(id));
  return rec ? rec.name : '';
}

// The roll-up for ONE goal. Returns null unless this goal is the parent of a
// family, so every caller can treat "no roll-up" as "behave as before".
//
//   own          — what the parent itself reported (its own work)
//   contributions— one row per participating group
//   total        — own + contributions, for addable units only
//   valueFor(q, i) is per-quarter, so reports can show the year to date.
function rollupForGoal(goal, { year, quarter, allGoals, allEntries } = {}) {
  const fam = familyOf(goal, allGoals);
  if (!fam || fam.parent.id !== goal.id) return null;
  year = Number(year || goal.year);

  const ids = new Set([fam.parent.id, ...fam.participants.map(p => p.id)]);
  const entries = (allEntries || db.findAll('kpi_entries', e => e.year === year && ids.has(e.goalId)))
    .filter(e => Number(e.year) === year && ids.has(e.goalId));
  // Same rule as the report: a derived KPI is derived, not looked up. The
  // groups' CLN-02 figures come from their own meeting attendance, so a group
  // that never had its entry page open while unlocked still contributes its
  // real average to Church Life and Nurture's total instead of a zero.
  const byId = {};
  [fam.parent, ...fam.participants].forEach(g => { byId[g.id] = g; });
  const derivedCache = {};
  const valueOf = (goalId, q, i) => {
    const g = byId[goalId];
    if (g) {
      const own = ownerOf(g);
      if (own) {
        const d = derivedKpiValue(g, i, { year, quarter: q, entityType: own.entityType, entityId: own.entityId, cache: derivedCache });
        if (d !== null && d !== undefined) return d;
      }
    }
    const e = entries.find(x => x.goalId === goalId && Number(x.quarter) === Number(q));
    const v = e && e.values ? e.values[i] : null;
    return v === undefined ? null : v;
  };
  const numOf = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const participants = fam.participants.map(p => ({
    goalId: p.id, ownerCode: p.ownerCode, entityType: p.ownerType,
    entityId: p.ownerType === 'congregation' ? 0 : lookupEntityId(p),
    name: nameForGoal(p),
  }));

  // One row per KPI index. The copies share KPI shape (same descriptions,
  // units and order), so index is a safe join.
  const kpis = (goal.kpis || []).map((k, i) => {
    const summable = isSummable(k.unit);
    const per = q => {
      const own = numOf(valueOf(goal.id, q, i));
      const contributions = participants.map(p => ({ ...p, value: numOf(valueOf(p.goalId, q, i)) }));
      const given = [own, ...contributions.map(c => c.value)].filter(v => v !== null);
      return {
        own,
        contributions,
        total: summable && given.length ? given.reduce((a, b) => a + b, 0) : null,
        reported: given.length,
      };
    };
    return {
      index: i, description: k.description, unit: k.unit || '', target: k.target,
      summable,
      quarters: [1, 2, 3, 4].map(q => per(q)),
      current: quarter ? per(Number(quarter)) : null,
    };
  });

  return { code: goal.code, parent: { goalId: goal.id, ownerCode: goal.ownerCode, name: nameForGoal(goal) }, participants, kpis };
}

function lookupEntityId(goal) {
  const coll = goal.ownerType === 'committee' ? 'committees' : 'groups';
  const rec = db.findOne(coll, x => x.code === goal.ownerCode);
  return rec ? rec.id : null;
}
function nameForGoal(goal) {
  if (goal.ownerType === 'congregation') return 'Congregation';
  const id = lookupEntityId(goal);
  return id ? entityName(goal.ownerType, id) : goal.ownerCode;
}

// The value a REPORT should print for one KPI of one goal: the rolled-up total
// when this goal is a parent and the unit adds up, otherwise the goal's own
// figure exactly as before. This is the single place all three documents —
// the committee's own report, the congregation report and the District Excel —
// must go through, or they will quietly disagree about the same goal.
function reportedValue(goal, kpiIndex, { year, quarter, ownValue, allGoals, allEntries } = {}) {
  const roll = rollupForGoal(goal, { year, quarter, allGoals, allEntries });
  if (!roll) return ownValue;
  const k = roll.kpis[kpiIndex];
  if (!k || !k.summable) return ownValue;
  const q = k.quarters[Number(quarter) - 1];
  return q && q.total !== null ? q.total : ownValue;
}

module.exports = { rollupForGoal, familyOf, reportedValue, isSummable, isParentOwner };
