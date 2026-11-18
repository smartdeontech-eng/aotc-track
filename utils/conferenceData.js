// Assembles the Congregational Conference (annual) report for a committee
// or group — CLAN.docx / JY.docx structure: full-year KPI table, per-goal
// narratives (performance + way forward), auto "Meeting Reporting Deadlines"
// from submission timestamps, annual achievements/challenges, emerging focus.
const db = require('./db');

function assembleConference({ year, entityType, entityId }) {
  year = Number(year); entityId = Number(entityId);
  const isCommittee = entityType === 'committee';
  const entity = db.findById(isCommittee ? 'committees' : 'groups', entityId);
  if (!entity) return null;
  const code = entity.code;

  const goals = db.findAll('goals', g => g.year === year && g.ownerCode === code);
  const entries = db.findAll('kpi_entries', e => e.year === year);
  const members = db.findAll('members', m => m.entityType === entityType && Number(m.entityId) === entityId);
  const notes = db.findOne('conference_notes', n => n.year === year && n.entityType === entityType && Number(n.entityId) === entityId) || {};
  const q4narr = db.findOne('narratives', n => n.year === year && n.quarter === 4 && n.entityType === entityType && Number(n.entityId) === entityId) || {};

  const valueFor = (goalId, q, idx) => {
    const e = entries.find(x => x.goalId === goalId && x.quarter === q);
    const v = e && e.values ? e.values[idx] : null;
    return v === undefined ? null : v;
  };
  const kpiTable = [];
  goals.forEach(g => (g.kpis || []).forEach((k, i) => {
    kpiTable.push({
      code: i === 0 ? g.code : '', goal: i === 0 ? g.description : '',
      kpi: k.description, unit: k.unit || '', prevActual: k.prevActual, target: k.target,
      quarters: [1, 2, 3, 4].map(q => valueFor(g.id, q, i)),
    });
  }));

  // Auto: reporting deadlines met? (submission by 5th of month after quarter)
  const deadlines = [1, 2, 3, 4].map(q => {
    const sub = db.findOne('submissions', s => s.year === year && s.quarter === q && s.entityType === entityType && Number(s.entityId) === entityId && s.status === 'submitted');
    const due = new Date(year, q * 3, 5);
    return {
      quarter: q,
      submitted: !!sub,
      onTime: sub ? new Date(sub.submittedAt) <= new Date(due.getTime() + 86399000) : false,
      submittedAt: sub ? sub.submittedAt : null,
    };
  });
  const dl = deadlines.filter(d => d.submitted);
  const deadlineText = dl.length
    ? [1, 2, 3, 4].map(q => {
        const d = deadlines[q - 1];
        if (!d.submitted) return `Q${q}: not submitted`;
        return `Q${q}: submitted ${d.onTime ? 'on time' : 'late'}`;
      }).join('; ') + '.'
    : 'No quarterly submissions were recorded in the system for the year.';

  // Per-goal sections with narratives + activities across the year
  const activities = db.findAll('activities', a => a.year === year && a.entityType === entityType && Number(a.entityId) === entityId);
  const updates = db.findAll('activity_updates', u => u.year === year);
  const goalSections = goals.map(g => ({
    code: g.code, description: g.description,
    kpis: (g.kpis || []).map(k => k.description).join('; '),
    performance: ((notes.goalNotes || {})[g.id] || {}).performance || '',
    wayForward: ((notes.goalNotes || {})[g.id] || {}).wayForward || '',
    activities: activities.filter(a => a.goalId === g.id).map(a => {
      const yearActuals = [1, 2, 3, 4].map(q => {
        const u = updates.find(x => x.activityId === a.id && x.quarter === q);
        return u && u.actual ? `Q${q}: ${u.actual}` : null;
      }).filter(Boolean).join(' · ');
      return { description: a.description, actuals: yearActuals || '—' };
    }),
  }));

  return {
    year, entityType, entityId, isCommittee,
    entity: { code, name: entity.name, signatories: entity.signatories || {} },
    members, kpiTable, goalSections, deadlineText,
    preamble: notes.preamble || q4narr.preamble || '',
    achievements: notes.achievements || '',
    challenges: notes.challenges || '',
    emergingFocus: notes.emergingFocus || '',
  };
}

module.exports = { assembleConference };
