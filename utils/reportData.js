// Assembles everything a quarterly report needs for one committee/group.
const db = require('./db');

const { derivedKpiValue } = require('./derivedKpi');
function ordinal(q) { return ['1st', '2nd', '3rd', '4th'][q - 1]; }

function assemble({ year, quarter, entityType, entityId }) {
  year = Number(year); quarter = Number(quarter); entityId = Number(entityId);
  const isCommittee = entityType === 'committee';
  const entity = entityType === 'congregation'
    ? { code: 'OG', name: 'Congregation (Overarching)', signatories: {} }
    : db.findById(isCommittee ? 'committees' : 'groups', entityId);
  if (!entity) return null;
  const code = entity.code || 'OG';

  const goals = db.findAll('goals', g => g.year === year && g.ownerCode === code);
  const goalIds = new Set(goals.map(g => g.id));
  const kpiEntries = db.findAll('kpi_entries', e => e.year === year && goalIds.has(e.goalId));
  const activities = db.findAll('activities', a => a.year === year && a.entityType === entityType && Number(a.entityId) === entityId);
  const actIds = new Set(activities.map(a => a.id));
  const updates = db.findAll('activity_updates', u => u.year === year && u.quarter === quarter && actIds.has(u.activityId));
  const narrative = db.findOne('narratives', n => n.year === year && n.quarter === quarter && n.entityType === entityType && Number(n.entityId) === entityId) || {};
  const members = db.findAll('members', m => m.entityType === entityType && Number(m.entityId) === entityId);
  const submission = db.findOne('submissions', s => s.year === year && s.quarter === quarter && s.entityType === entityType && Number(s.entityId) === entityId) || null;
  const settings = db.readAll ? null : null;

  // KPI value per goal per quarter.
  //
  // DERIVED FIRST. CLN-01, CLN-02 and SO-1.2 are worked out from the Attendance
  // page, not typed. They used to be stored only as a side-effect of someone
  // having the entry page open while the quarter was unlocked - so a locked
  // quarter reported whatever happened to be saved, usually nothing, while the
  // screen showed the right figure. The report now derives them the same way
  // the screen does, so the two cannot disagree.
  const derivedCache = {};
  const valueFor = (goalId, q, idx) => {
    const goal = goals.find(g => g.id === goalId);
    const d = derivedKpiValue(goal, idx, { year, quarter: q, entityType, entityId, cache: derivedCache });
    if (d !== null && d !== undefined) return d;
    const e = kpiEntries.find(x => x.goalId === goalId && x.quarter === q);
    const v = e && e.values ? e.values[idx] : null;
    return v === undefined ? null : v;
  };

  // ---- Shared goals -------------------------------------------------------
  // A goal this committee is RESPONSIBLE for may also have been extended to the
  // groups — Mission & Evangelism owns "souls are won", and Junior Youth, the
  // Children's Service and the rest win souls too. When this committee reports,
  // it reports on all of it: its own work plus everything the groups did.
  // Nothing here is editable from this side; the figures are whatever each
  // group entered against its own copy.
  const { rollupForGoal } = require('./goalRollup');
  const allGoalsThisYear = db.findAll('goals', g => g.year === year);
  const allEntriesThisYear = db.findAll('kpi_entries', e => e.year === year);
  const rollups = {};
  goals.forEach(g => {
    const r = rollupForGoal(g, { year, quarter, allGoals: allGoalsThisYear, allEntries: allEntriesThisYear });
    if (r) rollups[g.id] = r;
  });

  const kpiTable = [];
  goals.forEach(g => {
    const roll = rollups[g.id];
    (g.kpis || []).forEach((k, i) => {
      const rk = roll ? roll.kpis[i] : null;
      // For a shared, addable KPI the printed figure is the whole effort.
      // For a percentage or a date it stays this committee's own — four groups
      // at 40% is not 160%.
      const quarters = [1, 2, 3, 4].map(q => {
        if (q > quarter) return null;
        const own = valueFor(g.id, q, i);
        if (!rk || !rk.summable) return own;
        const t = rk.quarters[q - 1];
        return t && t.total !== null ? t.total : own;
      });
      kpiTable.push({
        code: i === 0 ? g.code : '', goal: i === 0 ? g.description : '',
        kpi: k.description, unit: k.unit || '',
        prevActual: k.prevActual, target: k.target,
        quarters,
        span: i === 0 ? g.kpis.length : 0,
        // Where the number came from, for the note under the table.
        shared: rk ? {
          summable: rk.summable,
          own: valueFor(g.id, quarter, i),
          contributions: (rk.current ? rk.current.contributions : []).filter(c => c.value !== null)
            .map(c => ({ name: c.name, ownerCode: c.ownerCode, value: c.value })),
        } : null,
      });
    });
  });

  // Per-goal activity tables (Table 2.x) + unassigned bucket
  // Activities the participating groups ran against their own copy of a shared
  // goal, so they appear under the same goal table in this committee's report.
  const participantGoalIds = new Set(
    Object.values(rollups).flatMap(r => r.participants.map(p => p.goalId)));
  const participantName = {};
  Object.values(rollups).forEach(r => r.participants.forEach(p => { participantName[p.goalId] = p.name; }));
  const sharedActs = participantGoalIds.size
    ? db.findAll('activities', a => a.year === year && participantGoalIds.has(a.goalId)) : [];
  const sharedActIds = new Set(sharedActs.map(a => a.id));
  const sharedUpdates = sharedActIds.size
    ? db.findAll('activity_updates', u => u.year === year && u.quarter === quarter && sharedActIds.has(u.activityId)) : [];

  const goalSections = goals.map(g => {
    const roll = rollups[g.id];
    const ids = roll ? new Set(roll.participants.map(p => p.goalId)) : new Set();
    return {
      code: g.code, description: g.description, kpis: (g.kpis || []).map(k => k.description),
      activities: activities.filter(a => a.goalId === g.id).map(a => {
        const u = updates.find(x => x.activityId === a.id) || {};
        return { description: a.description, target: (a.targets || {})['q' + quarter] || '', actual: u.actual || '', remarks: u.remarks || '' };
      }),
      // Read-only. Whoever entered it owns it.
      contributed: sharedActs.filter(a => ids.has(a.goalId)).map(a => {
        const u = sharedUpdates.find(x => x.activityId === a.id) || {};
        return {
          by: participantName[a.goalId] || a.ownerCode,
          description: a.description, target: (a.targets || {})['q' + quarter] || '',
          actual: u.actual || '', remarks: u.remarks || '',
        };
      }).sort((a, b) => a.by.localeCompare(b.by)),
    };
  }).filter(s => s.activities.length || s.contributed.length);
  const generalActivities = activities.filter(a => !a.goalId).map(a => {
    const u = updates.find(x => x.activityId === a.id) || {};
    return { description: a.description, target: (a.targets || {})['q' + quarter] || '', actual: u.actual || '', remarks: u.remarks || '' };
  });

  // Meetings held this quarter with locked attendance -> summary for the report
  let meetings = [];
  let meetingSummary = null;
  try {
    meetings = db.findAll('meetings', m => m.year === year && m.quarter === quarter &&
      m.entityType === entityType && Number(m.entityId) === entityId &&
      m.status !== 'cancelled' && m.attendance && m.attendance.presentMemberIds);
    if (meetings.length) {
      const { entityAttendance } = require('./attendanceStats');
      const stats = entityAttendance(entityType, entityId, { year, quarter });
      meetingSummary = {
        count: stats.count,
        dates: stats.dates.slice().sort(),
        threshold: stats.threshold,
        // Keep the legacy attended/total fields for the existing docx table,
        // plus the richer present/apology/absent/pct/flag breakdown.
        perMember: stats.perMember.map(m => ({
          name: m.name, position: m.position,
          attended: m.present, total: stats.count,
          present: m.present, apology: m.apology, absent: m.absent,
          pct: m.pct, consecutiveAbsences: m.consecutiveAbsences, flag: m.flag,
        })),
        flagged: stats.flagged,
      };
    }
  } catch (e) { meetings = []; }

  return {
    year, quarter, ordinal: ordinal(quarter), entityType, entityId,
    entity: { code, name: entity.name, type: entityType, signatories: entity.signatories || {} },
    isCommittee,
    narrative, members, kpiTable, goalSections, generalActivities, meetings, meetingSummary, submission,
  };
}

module.exports = { assemble, ordinal };
