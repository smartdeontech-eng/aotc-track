// AOTC Track — Dashboard analytics (Phase 10).
const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const { requireAuth } = require('../middleware/auth');

const { userEntity, canViewAll } = require('../utils/scope');
const { sortGroups } = require('../utils/groupOrder');

router.get('/dashboard', requireAuth, (req, res) => {
  const now = new Date();
  const year = now.getFullYear();
  const quarter = Math.floor(now.getMonth() / 3) + 1;

  // ---- Sunday attendance trend (last 8 service days, combined totals) ----
  const services = db.findAll('service_attendance').sort((a, b) => a.date.localeCompare(b.date));
  const byDate = {};
  // A Sunday with a 1st AND a 2nd service is ONE day whose figure is both added
  // together. Keep the per-service split alongside it so the table under the
  // chart can open a day out, instead of showing two rows that read as two
  // different Sundays.
  const splitByDate = {};
  services.forEach(s => {
    const t = ['cs', 'jy', 'adult'].reduce((n, k) => n + s.counts[k].male + s.counts[k].female + s.counts[k].online, 0)
      + (s.counts.cs.teachersMale || 0) + (s.counts.cs.teachersFemale || 0)
      + (s.counts.jy.leadersMale || 0) + (s.counts.jy.leadersFemale || 0);
    byDate[s.date] = (byDate[s.date] || 0) + t;
    (splitByDate[s.date] = splitByDate[s.date] || []).push({ service: s.service, total: t });
  });
  const attendanceTrend = Object.entries(byDate).slice(-8).map(([date, total]) => ({ date, total }));

  if (!canViewAll(req)) {
    // ---- entity view ----
    const ent = userEntity(req);
    if (!ent || ent.type === 'congregation') return res.json({ scope: 'entity', kpiProgress: [], submissions: [], attendanceTrend: [] });
    const rec = db.findById(ent.type === 'committee' ? 'committees' : 'groups', Number(ent.id));
    const code = rec ? rec.code : null;
    const goals = db.findAll('goals', g => g.year === year && g.ownerCode === code);
    const entries = db.findAll('kpi_entries', e => e.year === year);
    const kpiProgress = [];
    goals.forEach(g => (g.kpis || []).forEach((k, i) => {
      if (typeof k.target !== 'number' || !k.target) return;
      let ytd = 0;
      for (let q = 1; q <= quarter; q++) {
        const e = entries.find(x => x.goalId === g.id && x.quarter === q);
        const v = e && e.values ? Number(e.values[i]) : NaN;
        if (!isNaN(v)) ytd += v;
      }
      if ((k.unit || '') === '%') return;
      kpiProgress.push({ code: g.code, kpi: k.description, target: k.target, ytd, pct: Math.min(100, Math.round(ytd / k.target * 100)) });
    }));
    const submissions = [1, 2, 3, 4].map(q => ({
      quarter: q,
      submitted: !!db.findOne('submissions', s => s.year === year && s.quarter === q && s.entityType === ent.type && Number(s.entityId) === Number(ent.id) && s.status === 'submitted'),
    }));
    // group's own attendance trend
    let groupTrend = [];
    if (ent.type === 'group') {
      groupTrend = db.findAll('group_attendance', g => Number(g.entityId) === Number(ent.id))
        .sort((a, b) => a.date.localeCompare(b.date)).slice(-8)
        .map(g => ({ date: g.date, total: (g.membersMale || 0) + (g.membersFemale || 0) + (g.onlineMale || 0) + (g.onlineFemale || 0) }));
    }
    return res.json({ scope: 'entity', kpiProgress: kpiProgress.slice(0, 6), submissions, attendanceTrend: ent.type === 'group' ? groupTrend : [] });
  }

  // ---- congregation view ----
  const entities = [
    ...db.findAll('committees').filter(c => c.active !== false).map(c => ({ type: 'committee', id: c.id, name: c.name, code: c.code })),
    ...db.findAll('groups').filter(g => g.active !== false).map(g => ({ type: 'group', id: g.id, name: g.name, code: g.code })),
  ];
  const board = entities.map(ent => ({
    name: ent.name, code: ent.code, type: ent.type,
    submitted: !!db.findOne('submissions', s => s.year === year && s.quarter === quarter && s.entityType === ent.type && Number(s.entityId) === Number(ent.id) && s.status === 'submitted'),
  }));
  const fund = (() => {
    const meta = db.findOne('fundraising_meta', m => m.year === year) || {};
    const raised = db.findAll('fundraising_entries', e => e.year === year).reduce((s, e) => s + (e.total || 0), 0);
    return { raised, target: meta.annualTarget || null };
  })();
  const visitors = db.findAll('visitors');
  // New faces this quarter: first seen since the quarter began, and how many
  // of them have since become members.
  const qStartKey = `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01`;
  const seenQ = visitors.filter(v => String(v.firstSeen || '') >= qStartKey);
  const newThisQuarter = { seen: seenQ.length, joined: seenQ.filter(v => ['new-member', 'integrated'].includes(v.status)).length };
  const visitorFunnel = {
    visitors: visitors.filter(v => v.status === 'visitor').length,
    newMembers: visitors.filter(v => v.status === 'new-member').length,
    integrated: visitors.filter(v => v.status === 'integrated').length,
  };

  // ---- Group meeting attendance ----
  // SOURCE: the "Group meeting attendance" form on the Attendance page
  // (the `group_attendance` collection) — the headcount a group secretary
  // enters for each of their meetings.
  //
  // NOT the Meetings page. Those records are a different thing: who sat in a
  // committee or group meeting, named member by member, for quorum and absence
  // flags. They are reported on the Meetings Overview tab. Counting them under
  // the heading "Group meeting attendance" is what made this card look stale —
  // secretaries were entering figures on Attendance every week while the chart
  // was reading a collection almost nobody was filling in.
  //
  // Junior Youth and Children's Service are excluded here exactly as they are
  // on the Attendance page: they meet WITHIN Sunday services, so their numbers
  // are on the Sunday grid and counting them again would double-count.
  const SUNDAY_GROUPS = ['JY', 'CS'];
  const num = v => (v === '' || v === null || v === undefined ? 0 : Number(v) || 0);
  // Legacy rows carry `members` / `online` instead of the split male/female
  // fields — read exactly the way the Attendance page's own table reads them.
  const logTotal = r => num(r.membersMale ?? r.members) + num(r.membersFemale)
    + num(r.onlineMale ?? r.online) + num(r.onlineFemale);
  const grpName = id => (db.findById('groups', Number(id)) || {}).name || '';

  const logs = db.findAll('group_attendance').sort((a, b) => String(a.date).localeCompare(String(b.date)));

  // Combined trend — every group's meetings on a given day added together.
  const mByDate = {};
  logs.forEach(r => { mByDate[r.date] = (mByDate[r.date] || 0) + logTotal(r); });
  const meetingAttendanceTrend = Object.entries(mByDate).slice(-8).map(([date, total]) => ({ date, total }));

  const meetingAttendanceRecent = logs.slice(-12).reverse().map(r => ({
    date: r.date, entityId: Number(r.entityId), group: grpName(r.entityId) || r.ownerCode || '',
    members: num(r.membersMale ?? r.members) + num(r.membersFemale),
    online: num(r.onlineMale ?? r.online) + num(r.onlineFemale),
    present: logTotal(r),
  }));

  // Per-group breakdown. Combined, two groups meeting on the same day read as
  // one bar and a group that never logs has no bar to be missed.
  //
  // EVERY eligible group is seeded, not just the ones with figures. A group
  // with nothing logged is exactly the one someone goes looking for, and
  // leaving it out makes the app look like it has forgotten the group (this is
  // why Women's Fellowship was missing from the picker). An empty group answers
  // "nothing logged yet", which is information; absence is not.
  const byGroup = {};
  db.findAll('groups', g => g.active !== false && !SUNDAY_GROUPS.includes(g.code)).forEach(g => {
    byGroup[Number(g.id)] = { id: Number(g.id), code: g.code, name: g.name, trend: [], meetings: 0, total: 0, lastDate: null };
  });
  logs.forEach(r => {
    const id = Number(r.entityId);
    // A row against a group since deleted or deactivated still counts — better
    // a row named from the record than a silently dropped figure.
    const g = (byGroup[id] = byGroup[id] || { id, code: r.ownerCode || null, name: grpName(id) || r.ownerCode || 'Former group', trend: [], meetings: 0, total: 0, lastDate: null });
    g.trend.push({ date: r.date, total: logTotal(r) });
    g.meetings++;
    g.total += logTotal(r);
    g.lastDate = r.date;
  });
  const todayMs = Date.now();
  const meetingAttendanceByGroup = sortGroups(Object.values(byGroup)).map(g => ({
    ...g,
    trend: g.trend.slice(-8),
    average: g.meetings ? Math.round(g.total / g.meetings) : null,
    daysSince: g.lastDate ? Math.round((todayMs - new Date(g.lastDate).getTime()) / 864e5) : null,
  }));

  // Groups that have gone quiet — nothing logged in over five weeks, or never.
  // The equivalent of the old "unrecorded" note, but against the right source.
  const meetingAttendanceQuiet = meetingAttendanceByGroup
    .filter(g => g.daysSince === null || g.daysSince > 35)
    .map(g => ({ id: g.id, name: g.name, lastDate: g.lastDate, daysSince: g.daysSince }));

  // EVERY Sunday for the detail table (newest first) — the chart plots the last
  // eight, but "View details" underneath should account for all of them, not
  // just the ones that happened to fit on the chart.
  const attendanceRecent = Object.entries(byDate)
    .map(([date, total]) => ({ date, total, services: (splitByDate[date] || []).slice().sort((a, b) => String(a.service).localeCompare(String(b.service))) }))
    .reverse();

  res.json({
    scope: 'congregation', year, quarter,
    attendanceTrend, attendanceRecent,
    meetingAttendanceTrend, meetingAttendanceRecent,
    meetingAttendanceByGroup, meetingAttendanceQuiet,
    board, fund, visitorFunnel, newThisQuarter,
  });
});

module.exports = router;
