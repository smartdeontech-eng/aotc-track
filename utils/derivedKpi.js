// Attendance-derived KPI values, computed on the SERVER.
//
// THE BUG THIS FIXES. Three KPIs are worked out from the Attendance page
// rather than typed: CLN-01 (Sunday service average), CLN-02 (generational
// group meeting average) and SO-1.2 (Bible studies in Sunday worship). The
// entry page computed them live and showed them, but only WROTE them into
// kpi_entries while the quarter was still editable. So a quarter that was
// submitted and locked - or one nobody happened to open at the right moment -
// kept whatever was stored before, usually nothing. The clerk saw 46 on
// screen and the report printed 0, which is exactly what Women's Fellowship
// hit for Q3 2026.
//
// Deriving in the browser and persisting as a side-effect was the mistake. A
// reported figure must not depend on someone having had a page open. The
// derivation lives here now, and the report and the roll-up both read it, so
// the number is the same wherever it is asked for, locked or not.
//
// The stats block below is lifted verbatim from routes/entry.js, which now
// calls this instead of computing its own - one definition, so the figure on
// screen and the figure in the report cannot drift apart.
const db = require('./db');
const { sortGroups } = require('./groupOrder');

// A KPI literally called "Average Attendance" - CLN-01 and CLN-02 both have
// one, so the goal CODE is what tells them apart. "Bible Study LEADERS" must
// not match the Bible-studies KPI, hence the tight pattern.
const isBibleWorship = k => /studies?\s+in\s+sunday\s+worship/i.test((k && k.description) || '');
const isAvgAttendance = k => /^\s*average\s+attendance\s*$/i.test((k && k.description) || '');

function entityCodeFor(entityType, entityId) {
  if (entityType === 'congregation') return 'OG';
  const rec = db.findById(entityType === 'committee' ? 'committees' : 'groups', Number(entityId));
  return rec ? rec.code : null;
}

function statsFor(entityType, entityId, year, quarter) {
  year = Number(year); quarter = Number(quarter);
  const bsAll = db.findAll('service_attendance', s => s.year === year && s.bibleStudy);

  const n2 = v => (v === '' || v === null || v === undefined ? 0 : Number(v) || 0);
  const serviceTotal = rec => {
    const c = rec.counts || {};
    const g2 = (k, f) => n2((c[k] || {})[f]);
    return g2('cs', 'male') + g2('cs', 'female') + g2('cs', 'online')
      + g2('cs', 'teachersMale') + g2('cs', 'teachersFemale')
      + g2('jy', 'male') + g2('jy', 'female') + g2('jy', 'online')
      + g2('jy', 'leadersMale') + g2('jy', 'leadersFemale')
      + g2('adult', 'male') + g2('adult', 'female') + g2('adult', 'online');
  };
  // Collapse every service record of a day into one Sunday.
  const sundaysIn = list => {
    const byDate = {};
    list.forEach(r => { byDate[r.date] = (byDate[r.date] || 0) + serviceTotal(r); });
    return Object.entries(byDate).map(([date, total]) => ({ date, total }));
  };
  const summarise = rows => {
    const total = rows.reduce((a, r) => a + r.total, 0);
    return { count: rows.length, total, average: rows.length ? Math.round(total / rows.length) : null };
  };

  const svcYear = db.findAll('service_attendance', s => s.year === year);
  const serviceAttendance = {
    year: summarise(sundaysIn(svcYear)),
    quarter: summarise(sundaysIn(svcYear.filter(s => Number(s.quarter) === quarter))),
  };

  const groupTotal = r => n2(r.membersMale ?? r.members) + n2(r.membersFemale)
    + n2(r.onlineMale ?? r.online) + n2(r.onlineFemale);
  let gaRows = db.findAll('group_attendance', r => Number(r.year) === year);
  if (entityType === 'group') gaRows = gaRows.filter(r => Number(r.entityId) === Number(entityId));
  const gaMap = rows => rows.map(r => ({ date: r.date, total: groupTotal(r) }));
  const groupAttendance = {
    scope: entityType === 'group' ? 'own' : 'all groups',
    year: summarise(gaMap(gaRows)),
    quarter: summarise(gaMap(gaRows.filter(r => Number(r.quarter) === quarter))),
  };

  // The congregation-level CLN-02 figure is NOT the one above.
  //
  // summarise() over every group's meetings gives the average SIZE of a group
  // meeting - around 25. CLN-02's target is 100.1, because the figure the
  // District wants is each group's own average ADDED TOGETHER: what the
  // generational groups draw between them in a round of meetings.
  //
  // That is also, exactly, what utils/goalRollup.js totals for CLN's copy of
  // CLN-02 (own + every participant). Computing it the same way here is what
  // keeps the number in the entry field equal to the number in the report.
  // Hence the scope: only the groups that actually hold a CLN-02 copy count,
  // so a group that records meetings but does not share the goal (and so
  // contributes nothing to the roll-up) cannot inflate the field either.
  //
  // Built ONLY for the entity that actually holds a CLN-02 copy - in practice
  // Church Life and Nurture. It was gated on "not a group", which is every
  // committee in the congregation: Development and Social Services opened its
  // quarterly return and found a table of the generational groups' headcounts
  // sitting under its own KPIs. Attendance is nothing to do with DSS, and a
  // figure on a page that does not need it is not neutral - it invites
  // someone to act on it.
  //
  // A group secretary is excluded for the other reason: one group has no
  // business reading another's numbers. Same line as /attendance/days.
  // The route had the entity's goals to hand; here we ask for them.
  const entCode = entityCodeFor(entityType, entityId);
  const ownsGroupAttendanceKpi = !!db.findOne('goals',
    g => Number(g.year) === year && g.code === 'CLN-02' && g.ownerCode === entCode);
  if (entityType !== 'group' && ownsGroupAttendanceKpi) {
    const shared = db.findAll('goals', g => Number(g.year) === year && g.code === 'CLN-02');
    const shareCodes = new Set(shared.filter(g => g.ownerType === 'group').map(g => g.ownerCode));
    const perGroup = sortGroups(db.findAll('groups'))
      .filter(grp => !shareCodes.size || shareCodes.has(grp.code))
      .map(grp => {
        const mine = gaRows.filter(r => Number(r.entityId) === Number(grp.id));
        return {
          entityId: grp.id, code: grp.code || null, name: grp.name,
          year: summarise(gaMap(mine)),
          quarter: summarise(gaMap(mine.filter(r => Number(r.quarter) === quarter))),
        };
      })
      .filter(g => g.year.count); // a group with nothing recorded all year is noise
    // Sum of the per-group AVERAGES - never total/meetings, which would give
    // the per-meeting figure back again.
    const combine = key => {
      const rows = perGroup.filter(g => g[key].count);
      return {
        groups: rows.length,
        meetings: rows.reduce((a, g) => a + g[key].count, 0),
        total: rows.reduce((a, g) => a + g[key].total, 0),
        average: rows.length ? rows.reduce((a, g) => a + (g[key].average || 0), 0) : null,
      };
    };
    groupAttendance.perGroup = perGroup;
    groupAttendance.combined = { year: combine('year'), quarter: combine('quarter') };
  }

  return {
    bibleStudies: { year: bsAll.length, quarter: bsAll.filter(s => s.quarter === quarter).length },
    serviceAttendance,
    groupAttendance,
  };
}

// A statsFor() call is several disk reads, and a report asks for a value per
// KPI per quarter. Callers pass a cache object (any plain {}) and share it for
// the life of one request.
function statsCached(cache, entityType, entityId, year, quarter) {
  const key = `${entityType}:${entityId}:${year}:${quarter}`;
  if (cache && cache[key]) return cache[key];
  const st = statsFor(entityType, entityId, year, quarter);
  if (cache) cache[key] = st;
  return st;
}

// The derived value for one KPI, or null when this KPI is not derived at all.
//
// CLN-02 for a NON-group owner returns null on purpose. Church Life and
// Nurture holds the parent copy, and its figure is the roll-up of the groups'
// copies (utils/goalRollup.js). Deriving it here as well would count every
// group twice - the same trap the entry page avoids with readOnlyOnly.
function derivedKpiValue(goal, kpiIndex, { year, quarter, entityType, entityId, cache } = {}) {
  if (!goal) return null;
  const k = (goal.kpis || [])[kpiIndex];
  if (!k) return null;
  const isDerivedKind = isBibleWorship(k)
    || ((goal.code === 'CLN-01' || goal.code === 'CLN-02') && isAvgAttendance(k));
  if (!isDerivedKind) return null;

  const st = statsCached(cache, entityType, entityId, year, quarter);
  if (isBibleWorship(k)) return st.bibleStudies ? st.bibleStudies.quarter : null;
  if (goal.code === 'CLN-01') return st.serviceAttendance ? st.serviceAttendance.quarter.average : null;
  if (goal.code === 'CLN-02') {
    if (entityType !== 'group') return null;
    return st.groupAttendance ? st.groupAttendance.quarter.average : null;
  }
  return null;
}

// Which entity a goal belongs to, for callers that only hold the goal.
function ownerOf(goal) {
  if (!goal) return null;
  if (goal.ownerType === 'congregation') return { entityType: 'congregation', entityId: 0 };
  const coll = goal.ownerType === 'committee' ? 'committees' : 'groups';
  const rec = db.findOne(coll, x => x.code === goal.ownerCode);
  return rec ? { entityType: goal.ownerType, entityId: rec.id } : null;
}

module.exports = { statsFor, statsCached, derivedKpiValue, ownerOf, isBibleWorship, isAvgAttendance };
