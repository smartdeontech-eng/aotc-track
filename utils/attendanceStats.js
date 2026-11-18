// Attendance analytics for committee/group meetings.
// Turns the per-meeting present/apology/absent records into a per-member
// summary for a period, with the flags the Session cares about:
//   • RED  — absent >= threshold consecutive meetings with NO apology
//   • AMBER — overall attendance under 50% (with at least 2 meetings held)
// The consecutive threshold defaults to 4 but is Session-tunable in Settings.
//
// A member is only measured against meetings they were INVITED to. An
// executive meeting (every group meeting on the Meetings page, and any
// committee meeting marked executive) has a roster of office-holders only —
// see resolveMeetingRoster in routes/meetings.js — so an ordinary member of
// Women's Fellowship must not be scored 0/4 for executive meetings she was
// never called to. Before this, two executive meetings were enough to amber-
// flag every ordinary member of the group.
const db = require('./db');
const { getSettings } = require('./settings');

// Same rule as routes/meetings.js — anyone holding a position is an
// office-holder; everyone else is an ordinary member.
function isLeader(m) { return (m && m.position ? m.position : 'Member') !== 'Member'; }

function threshold() {
  const t = Number((getSettings() || {}).absenceFlagThreshold);
  return Number.isFinite(t) && t >= 2 ? t : 4;
}

// meetings: locked, non-cancelled meetings for the entity+period, ascending.
function meetingsFor(entityType, entityId, { year, quarter } = {}) {
  return db.findAll('meetings', m =>
    m.entityType === entityType && Number(m.entityId) === Number(entityId) &&
    m.status !== 'cancelled' && m.attendance && m.attendance.locked &&
    // A group's GENERAL meeting is a headcount with no names in it. Counting it
    // here would mark every member absent from a meeting they attended.
    m.attendance.mode !== 'headcount' &&
    (year === undefined || m.year === Number(year)) &&
    (quarter === undefined || m.quarter === Number(quarter)))
    .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

// Returns { count, dates, threshold, perMember:[{memberId,name,position,
//   held,present,apology,absent,pct,consecutiveAbsences,flag}], flagged:[...] }
function entityAttendance(entityType, entityId, period = {}) {
  const meetings = meetingsFor(entityType, entityId, period);
  const members = db.findAll('members', x => x.entityType === entityType && Number(x.entityId) === Number(entityId));
  const th = threshold();

  const perMember = members.map(mem => {
    const invited = m => !(m.kind === 'executive') || isLeader(mem);
    let held = 0, present = 0, apology = 0, absent = 0, streak = 0, streakOpen = true;
    // Walk newest -> oldest for the trailing consecutive-absence streak.
    for (let i = meetings.length - 1; i >= 0; i--) {
      if (!invited(meetings[i])) continue; // not their meeting — not their record
      held++;
      const a = meetings[i].attendance;
      const isPresent = (a.presentMemberIds || []).includes(mem.id);
      const isApology = (a.apologyMemberIds || []).includes(mem.id);
      const isAbsent = (a.absentMemberIds || []).length
        ? (a.absentMemberIds || []).includes(mem.id)
        : (!isPresent && !isApology); // older records without absentMemberIds
      if (isPresent) present++; else if (isApology) apology++; else if (isAbsent) absent++;
      if (streakOpen) {
        if (isAbsent && !isApology && !isPresent) streak++;
        else streakOpen = false;
      }
    }
    const pct = held ? Math.round((present / held) * 100) : null;
    let flag = null;
    if (streak >= th) flag = 'red';
    else if (held >= 2 && pct !== null && pct < 50) flag = 'amber';
    return {
      memberId: mem.id, name: mem.name, position: mem.position || 'Member',
      held, present, apology, absent, pct, consecutiveAbsences: streak, flag,
    };
  });

  const flagged = perMember.filter(m => m.flag);
  return {
    count: meetings.length,
    dates: meetings.map(m => m.date),
    threshold: th,
    perMember,
    flagged,
  };
}

// The trailing consecutive-absence streak for one member (used to decide
// whether a just-recorded meeting tips them over the flag threshold).
function consecutiveAbsences(entityType, entityId, memberId) {
  const meetings = meetingsFor(entityType, entityId, {});
  const mem = db.findById('members', Number(memberId)) || {};
  let streak = 0;
  for (let i = meetings.length - 1; i >= 0; i--) {
    // Executive meetings only count against office-holders (see above).
    if (meetings[i].kind === 'executive' && !isLeader(mem)) continue;
    const a = meetings[i].attendance;
    const isPresent = (a.presentMemberIds || []).includes(memberId);
    const isApology = (a.apologyMemberIds || []).includes(memberId);
    const isAbsent = (a.absentMemberIds || []).length
      ? (a.absentMemberIds || []).includes(memberId)
      : (!isPresent && !isApology);
    if (isAbsent && !isApology && !isPresent) streak++; else break;
  }
  return streak;
}

module.exports = { entityAttendance, consecutiveAbsences, threshold };
