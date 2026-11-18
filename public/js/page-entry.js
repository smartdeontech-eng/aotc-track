// Quarterly Entry page (Phase 3).
let me, data = null, committees = [], groups = [];
let quarter = Math.min(4, Math.floor(new Date().getMonth() / 3) + 1);
let currentEntity = null;
// KPIs that are DERIVED from the Attendance page rather than typed. Collected
// during render, then written back so the stored figure — and therefore every
// report — follows attendance. [{goalId, index, count}]
let _derivedSync = [];
let _anyDerived = false;  // does this entity hold any attendance-derived KPI?

const LAND_STATUSES = ['Land Title Certificate','Registered Deed','Missionary Deed','Fully Signed Indenture','Partially Signed Indenture','Unsigned Indenture','Site Plan','Allocation Note/Receipt','None'];

function canEnter() {
  if (!me) return false;
  if (isElevated(me)) return true;
  return (me.permissions || []).includes('entry.manage');
}
// An approved change request sets submission.reopenedUntil — while that is
// in the future, the quarter is temporarily editable again (mirrors server).
function reopenActive() {
  const s = data && data.submission;
  return !!(s && s.reopenedUntil && new Date(s.reopenedUntil) > new Date());
}
function locked() { return !!(data && data.submission && data.submission.status === 'submitted' && !reopenActive()); }
function dis() { return locked() || !canEnter() ? 'disabled' : ''; }
function canApprove() { return me && (isElevated(me) || (me.permissions || []).includes('approvals.manage')); }

async function load() {
  const q = currentEntity ? `&entityType=${currentEntity.type}&entityId=${currentEntity.id}` : '';
  try {
    data = await api(`/entry/data?quarter=${quarter}${q}`);
    // The Finance panel reads the weekly returns beside its own figures. Only
    // fetched for Finance, and a failure here must never stop the page loading
    // - the typed figures have to stay reachable if the weekly book is down.
    data.weekly = null;
    if (data.entity && data.entity.code === 'Fin') {
      try { data.weekly = await api(`/finance-weekly/summary?year=${data.year}&quarter=${quarter}`); } catch (err) { data.weekly = null; }
    }
  } catch (e) {
    document.getElementById('entryBody').innerHTML = `<div class="card"><p class="sub">${esc(e.message)}</p></div>`;
    return;
  }
  document.getElementById('countLabel').textContent =
    `${entityName()} · Q${data.quarter} ${data.year} — enter figures for THIS quarter only; totals add up automatically`;
  document.querySelectorAll('#quarterToggle button').forEach(b => b.classList.toggle('active', Number(b.dataset.q) === quarter));

  const banner = document.getElementById('lockBanner');
  banner.style.display = locked() ? '' : 'none';
  if (locked()) document.getElementById('lockInfo').textContent =
    ` Submitted by ${data.submission.submittedBy} on ${fmtDate(data.submission.submittedAt)}.`;
  const reopen = document.getElementById('reopenBanner');
  reopen.style.display = reopenActive() ? '' : 'none';
  if (reopenActive()) document.getElementById('reopenInfo').textContent =
    ` Approved by ${data.submission.reopenedBy || 'the Session Clerk'} — open until ${new Date(data.submission.reopenedUntil).toLocaleString('en-GB')}` +
    `${data.submission.reopenedMode === 'deadline' ? ` (the Q${quarter} reporting deadline)` : ''}. Resubmit when done to re-lock.`;
  document.getElementById('submitBtn').style.display = canEnter() && !locked() ? '' : 'none';
  document.getElementById('submitBtn').textContent = reopenActive() ? 'Resubmit quarter' : 'Submit quarter';
  document.getElementById('unlockBtn').style.display = isElevated(me) && locked() ? '' : 'none';
  loadChangeRequests();

  render();
}

// ---- Change requests (temporary reopening of a locked quarter) ----
async function loadChangeRequests() {
  const area = document.getElementById('changeReqArea');
  area.innerHTML = '';
  // Requester side: button / status inside the lock banner.
  if (locked() && canEnter()) {
    try {
      const mine = await api(`/entry/change-requests?entityType=${data.entity.type}&entityId=${data.entity.id}`);
      const current = mine.find(r => Number(r.year) === Number(data.year) && Number(r.quarter) === Number(quarter) && r.status === 'pending');
      const declined = mine.find(r => Number(r.year) === Number(data.year) && Number(r.quarter) === Number(quarter) && r.status === 'declined');
      if (current) {
        area.innerHTML = `<span class="badge badge-progress">Change request pending</span> <span class="sub">sent to the Session Clerk by ${esc(current.requestedBy)} on ${fmtDate(current.createdAt)}.</span>`;
      } else {
        area.innerHTML = `<button class="btn btn-secondary btn-sm" id="reqChangeBtn">Request change window</button>
          <span class="sub"> Needs approval from the Session Clerk or an admin, who can open a 48-hour window or leave it open until the quarter's reporting deadline.</span>
          ${declined ? `<div class="sub" style="margin-top:6px;">Last request was declined${declined.declineReason ? ': ' + esc(declined.declineReason) : ''}.</div>` : ''}`;
        document.getElementById('reqChangeBtn').onclick = requestChange;
      }
    } catch (e) { /* non-fatal */ }
  }
  // Approver side: pending requests card for clerk/admin.
  const card = document.getElementById('approvalsCard');
  if (!canApprove()) { card.style.display = 'none'; return; }
  try {
    const pending = await api('/entry/change-requests?status=pending');
    card.style.display = pending.length ? '' : 'none';
    document.getElementById('approvalRows').innerHTML = pending.map(r => `<tr>
      <td>${esc(entityLabelFor(r.entityType, r.entityId))}</td>
      <td class="mono">Q${r.quarter} ${r.year}</td>
      <td>${esc(r.requestedBy)}<div class="sub">${fmtDate(r.createdAt)}</div></td>
      <td class="sub" style="max-width:280px;">${esc(r.reason)}</td>
      <td style="text-align:right; white-space:nowrap;">
        <button class="btn btn-secondary btn-sm" onclick="decideChange(${r.id}, 'approve', 'hours')">Approve 48h</button>
        ${r.deadlineAhead ? `<button class="btn btn-primary btn-sm" onclick="decideChange(${r.id}, 'approve', 'deadline')" title="Leaves Q${r.quarter} editable for the next ${daysUntil(r.reportDueAt)} day(s), until the reporting deadline">Open till deadline — ${shortDue(r.reportDueAt)} (${daysUntil(r.reportDueAt)}d)</button>` : ''}
        <button class="btn btn-danger btn-sm" onclick="decideChange(${r.id}, 'decline')">Decline</button>
      </td>
    </tr>`).join('');
  } catch (e) { card.style.display = 'none'; }
}

function entityLabelFor(type, id) {
  const list = type === 'committee' ? committees : groups;
  const rec = list.find(x => x.id === Number(id));
  return rec ? rec.name : type;
}

async function requestChange() {
  const reason = prompt('What needs to change, and why? (goes to the Session Clerk for approval)');
  if (reason === null) return;
  try {
    await api('/entry/change-requests', { method: 'POST', body: {
      entityType: data.entity.type, entityId: data.entity.id, year: data.year, quarter, reason,
    } });
    toast('Request sent to the Session Clerk.');
    loadChangeRequests();
  } catch (err) { toast(err.message, true); }
}

// The quarter's reporting deadline, short form — for the approver's button.
function shortDue(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
// How long "until the deadline" actually is — early in a quarter that can be
// two months, which the approver should see before choosing it.
function daysUntil(iso) {
  return Math.max(0, Math.ceil((new Date(iso) - Date.now()) / 864e5));
}

// mode: 'hours' → the standard 48-hour window; 'deadline' → open until the
// quarter's own reporting deadline (only offered while that is still ahead).
async function decideChange(id, action, mode) {
  const declineReason = action === 'decline' ? (prompt('Reason for declining (optional):') || '') : '';
  try {
    await api(`/entry/change-requests/${id}/${action}`, { method: 'POST', body:
      action === 'decline' ? { reason: declineReason } : { window: mode || 'hours' } });
    toast(action !== 'approve' ? 'Request declined.'
      : mode === 'deadline' ? 'Quarter reopened until the reporting deadline.'
      : 'Change window opened for 48 hours.');
    load();
  } catch (err) { toast(err.message, true); }
}

function entityName() {
  if (!data) return '';
  if (data.entity.type === 'congregation') return 'Congregation (Overarching)';
  const list = data.entity.type === 'committee' ? committees : groups;
  const rec = list.find(x => x.id === Number(data.entity.id));
  return rec ? rec.name : data.entity.code;
}

function valOf(goalId, q, idx) {
  const e = data.kpiEntries.find(x => x.goalId === goalId && x.quarter === q);
  return e && e.values ? (e.values[idx] !== undefined && e.values[idx] !== null ? e.values[idx] : '') : '';
}
function cumulative(goal, idx) {
  const unit = (goal.kpis[idx].unit || '').toLowerCase();
  if (unit === 'date' || unit === '%') {
    for (let q = quarter; q >= 1; q--) { const v = valOf(goal.id, q, idx); if (v !== '') return v; }
    return '—';
  }
  let sum = 0, any = false;
  for (let q = 1; q <= quarter; q++) {
    const v = Number(valOf(goal.id, q, idx));
    if (!isNaN(v) && valOf(goal.id, q, idx) !== '') { sum += v; any = true; }
  }
  return any ? sum.toLocaleString() : '—';
}

function render() {
  const parts = [];

  // ---- KPI section ----
  // The "Number of Bible Studies in Sunday worship per year" KPI (SO-1.2, CLN)
  // is DERIVED from the Attendance page (per-service Bible-study ticks), so it's
  // shown read-only here — attendance is the single source of truth. (Matched
  // precisely so "Bible Study LEADERS" is NOT treated as this KPI.)
  const isBibleWorship = k => /studies?\s+in\s+sunday\s+worship/i.test(k.description || '');
  const isAvgAttendance = k => /^\s*average\s+attendance\s*$/i.test(k.description || '');
  const st = data.stats || {};

  // Which KPIs fill themselves in from Attendance, and with what.
  // Matched on GOAL CODE, not description alone — CLN-01 and CLN-02 both have a
  // KPI called exactly "Average Attendance", and only the code tells them apart.
  //   CLN-01 — Sunday church services (a 1st + 2nd Sunday counts once, combined)
  //   CLN-02 — generational group meetings (a group sees its own; CLN sees all)
  //   SO-1.2 — Bible studies held in Sunday worship
  function derivedFor(g, k) {
    if (isBibleWorship(k) && st.bibleStudies) {
      return { quarter: st.bibleStudies.quarter, year: st.bibleStudies.year, note: 'Auto from Attendance — Sunday Bible studies' };
    }
    if (g.code === 'CLN-01' && isAvgAttendance(k) && st.serviceAttendance) {
      const q = st.serviceAttendance.quarter;
      return { quarter: q.average, year: st.serviceAttendance.year.average,
        note: q.count ? `Auto from Attendance — ${q.count} Sunday${q.count === 1 ? '' : 's'}, ${q.total.toLocaleString()} in total` : 'Auto from Attendance — no Sundays recorded yet' };
    }
    if (g.code === 'CLN-02' && isAvgAttendance(k) && st.groupAttendance) {
      // CLN-02 is SHARED: Church Life and Nurture owns it and each generational
      // group holds its own copy. A group's copy takes that group's own average.
      //
      // CLN's copy SHOWS the combined figure but never STORES it.
      //
      // Both halves of that sentence are load-bearing. Shown, because the
      // Session Clerk should be able to open CLN's entry and see the
      // congregation-level number sitting in the field against its 100.1
      // target, quarter and year to date, exactly as CLN-01 shows the Sunday
      // figure. Never stored, because the report already adds the groups'
      // figures together (utils/goalRollup.js: total = own + participants), so
      // writing it here as well would count every group twice — 99 + 99 = 198
      // against a target of 100.
      //
      // So: the same number in the field as in the report, arrived at the same
      // way (each group's own average added together — see routes/entry.js),
      // and no kpi_entry row for the parent. readOnlyOnly keeps the sync out.
      if (data.entity.type !== 'group') {
        const c = st.groupAttendance.combined;
        if (!c) {
          return { quarter: null, year: null, readOnlyOnly: true,
            note: 'Added up from each group&rsquo;s own entry — see Shared work on Goals &amp; KPIs' };
        }
        const cq = c.quarter;
        return { quarter: cq.average, year: c.year.average, readOnlyOnly: true,
          note: cq.groups
            ? `Auto from Attendance — ${cq.groups} group${cq.groups === 1 ? '' : 's'}, each group&rsquo;s own average added together`
            : 'Auto from Attendance — no group meetings recorded yet' };
      }
      const q = st.groupAttendance.quarter;
      return { quarter: q.average, year: st.groupAttendance.year.average,
        note: q.count ? `Auto from Attendance — ${q.count} meeting${q.count === 1 ? '' : 's'}, ${q.total.toLocaleString()} in total` : 'Auto from Attendance — no meetings recorded yet' };
    }
    return null;
  }
  _derivedSync = [];
  // Does this entity have anything attendance-derived at all? Only then is the
  // working shown underneath. See attendanceFootnote().
  _anyDerived = false;
  // Code cell is rendered on EVERY KPI row (blank on the continuation rows of a
  // multi-KPI goal) rather than a single rowspan cell (keeps column count
  // constant so stacked-mobile labels line up; empty cell hidden on phones).
  const kpiRows = data.goals.map(g => (g.kpis || []).map((k, i) => {
    let valueCell, ytd;
    const derived = derivedFor(g, k);
    if (derived) {
      _anyDerived = true;
      const q = derived.quarter;
      // read-only, but keep data-kpi + value so a goal save still persists it,
      // and remember to sync it into the stored figures on load.
      // readOnlyOnly: shown locked but never stored — the figure belongs to the
      // roll-up, and writing it here would double count.
      if (canEnter() && !locked() && !derived.readOnlyOnly) _derivedSync.push({ goalId: g.id, index: i, count: q });
      valueCell = `<td><input style="max-width:130px;" data-kpi="${g.id}:${i}" value="${q === null || q === undefined ? '' : q}" disabled title="Counted automatically from the Attendance page — it cannot be typed here">
        <div class="sub" style="margin-top:2px; font-size:11px;">${derived.note}</div></td>`;
      ytd = derived.year === null || derived.year === undefined ? '—' : derived.year;
    } else {
      valueCell = `<td><input style="max-width:130px;" ${dis()} ${(k.unit || '').toLowerCase() === 'date' ? '' : 'data-num'} data-kpi="${g.id}:${i}" value="${esc(String(valOf(g.id, quarter, i)))}" onchange="saveKpi(${g.id})"></td>`;
      ytd = cumulative(g, i);
    }
    return `<tr>
    <td class="mono kpi-code${i === 0 ? '' : ' kpi-code-cont'}" style="vertical-align:top;">${i === 0 ? esc(g.code) : ''}</td>
    <td>${esc(k.description)}</td><td>${esc(k.unit || '')}</td>
    ${valueCell}
    <td class="mono">${ytd}</td>
  </tr>`;
  }).join('')).join('');
  parts.push(`<div class="card" style="margin-bottom:18px;">
    <div class="section-title"><h3>1 · KPI actuals for Q${quarter}</h3></div>
    <table><thead><tr><th>Code</th><th>Key Performance Indicator</th><th>Unit</th><th>Q${quarter} actual</th><th>Year to date</th></tr></thead>
    <tbody>${kpiRows || '<tr><td colspan="5" class="sub">No goals with KPIs.</td></tr>'}</tbody></table>
    ${attendanceFootnote()}
  </div>`);

  // ---- Activities section ----
  const actRows = data.activities.map(a => {
    const u = data.activityUpdates.find(x => x.activityId === a.id && x.quarter === quarter) || {};
    const target = a.targets ? a.targets['q' + quarter] : '';
    return `<tr>
      <td>${esc(a.description)}</td>
      <td class="sub">${esc(target || '—')}</td>
      <td><input ${dis()} data-act="${a.id}" data-f="actual" value="${esc(u.actual || '')}" placeholder="Done / Ongoing / Nil…" onchange="saveAct(${a.id})"></td>
      <td><input ${dis()} data-act="${a.id}" data-f="remarks" value="${esc(u.remarks || '')}" onchange="saveAct(${a.id})"></td>
      <td><input inputmode="decimal" data-num style="max-width:110px;" ${dis()} data-act="${a.id}" data-f="spend" value="${u.actualSpend != null ? u.actualSpend.toLocaleString() : ''}" onchange="saveAct(${a.id})"></td>
    </tr>`;
  }).join('');
  parts.push(`<div class="card" style="margin-bottom:18px;">
    <div class="section-title"><h3>2 · Activity updates for Q${quarter}</h3></div>
    <table><thead><tr><th style="min-width:200px;">Activity</th><th>Q${quarter} target</th><th>Actual performance</th><th>Remarks</th><th>Spent (GHS)</th></tr></thead>
    <tbody>${actRows || '<tr><td colspan="5" class="sub">No planned activities — add them on the Annual Plan page.</td></tr>'}</tbody></table>
  </div>`);

  // ---- Narrative section ----
  const n = data.narrative || {};
  parts.push(`<div class="card" style="margin-bottom:18px;">
    <div class="section-title"><h3>3 · Report narrative for Q${quarter}</h3></div>
    <div class="field"><label>Preamble (scripture &amp; reference)</label>
      <input id="nPreamble" ${dis()} value="${esc(n.preamble || '')}" placeholder='e.g. "…" – Eph. 4:16'></div>
    ${data.entity.type === 'congregation' ? `<div class="field"><label>Financial report</label>
      <textarea id="nFinancial" rows="2" ${dis()}>${esc(n.financial || '')}</textarea></div>` : ''}
    <div class="field"><label>Notable achievements &amp; events</label>
      <textarea id="nAchievements" rows="3" ${dis()}>${esc(n.achievements || '')}</textarea></div>
    <div class="field"><label>Major challenges</label>
      <textarea id="nChallenges" rows="3" ${dis()}>${esc(n.challenges || '')}</textarea></div>
    <div class="field"><label>Recommendations</label>
      <textarea id="nRecommendations" rows="2" ${dis()}>${esc(n.recommendations || '')}</textarea></div>
    ${canEnter() && !locked() ? '<button class="btn btn-secondary" onclick="saveNarrative()">Save narrative</button>' : ''}
  </div>`);

  // ---- Special panels ----
  if (data.entity.code === 'Fin') parts.push(financePanel());
  if (data.entity.code === 'AHRM') parts.push(membershipPanel());
  if (data.entity.code === 'PDBP') parts.push(pdbpPanel());

  document.getElementById('entryBody').innerHTML = parts.join('');
  syncDerivedKpis(); // keep the attendance-derived figures in step with Attendance
}

// What the attendance-derived figures are built from, spelled out under the KPI
// table so the numbers above can be checked at a glance rather than taken on
// trust.
//
// Shown ONLY where something on this page is actually derived from attendance.
// It used to render for every entity on the grounds that the Session Clerk
// wanted to confirm the figures were there - which meant Development and
// Social Services, whose work has nothing to do with attendance, opened its
// quarterly return to a Sunday-service table it could do nothing with. The
// clerk's own need is met by the Attendance page overview. The test is the
// page's own content, not a list of committee codes, so a committee that
// gains an attendance KPI gets the working automatically and one that loses
// it stops seeing it.
function attendanceFootnote() {
  const st = data.stats || {};
  const sv = st.serviceAttendance, ga = st.groupAttendance;
  if (!sv && !ga) return '';
  if (!_anyDerived) return '';
  const line = (label, s, unitWord) => {
    if (!s || !s.count) return `<tr><td>${label}</td><td class="sub" colspan="3">Nothing recorded this quarter</td></tr>`;
    return `<tr>
      <td>${label}</td>
      <td class="mono">${s.count} ${unitWord}${s.count === 1 ? '' : 's'}</td>
      <td class="mono">${s.total.toLocaleString()}</td>
      <td class="mono"><b>${s.average === null ? '—' : s.average.toLocaleString()}</b></td>
    </tr>`;
  };
  return `<div style="border-top:1px solid var(--rule); margin-top:14px; padding-top:12px;">
    <div class="section-title" style="margin-bottom:6px;"><h3 style="font-size:13.5px;">Attendance counted for Q${quarter}</h3></div>
    <table style="max-width:560px;">
      <thead><tr><th></th><th>Recorded</th><th style="text-align:left;">Total</th><th style="text-align:left;">Average</th></tr></thead>
      <tbody>
        ${line('Sunday church services', sv && sv.quarter, 'Sunday')}
        ${line(`Group meetings${ga && ga.scope === 'all groups' ? ' (all groups)' : ''}`, ga && ga.quarter, 'meeting')}
      </tbody>
    </table>
    <p class="sub" style="margin:8px 0 0;">A Sunday with a 1st and a 2nd service counts once, with both services added together.
      These come straight from the Attendance page — correct them there, not here.</p>
    ${groupBreakdown()}
  </div>`;
}

// The per-group working behind CLN-02's congregation-level figure.
//
// Without this the field just asserts a number. The combined average is each
// group's OWN average added together, not the average size of a group meeting,
// and those two differ by a factor of four — so the arithmetic is laid out row
// by row and the reader can add the column up themselves.
//
// Only ever rendered for committee/congregation views: the server withholds
// perGroup from a group's own entry so one group cannot read another's numbers.
function groupBreakdown() {
  const ga = (data.stats || {}).groupAttendance;
  if (!ga || !ga.perGroup || !ga.perGroup.length) return '';
  const c = ga.combined || {};
  const num = v => (v === null || v === undefined ? '—' : Number(v).toLocaleString());
  const rows = ga.perGroup.map(g => `<tr>
      <td>${esc(g.name)}</td>
      <td class="mono">${g.quarter.count}</td>
      <td class="mono">${num(g.quarter.total)}</td>
      <td class="mono"><b>${num(g.quarter.average)}</b></td>
      <td class="mono">${num(g.year.average)}</td>
    </tr>`).join('');
  return `<div style="margin-top:16px;">
    <div class="section-title" style="margin-bottom:6px;"><h3 style="font-size:13.5px;">Group meeting attendance by group — what CLN-02 reports</h3></div>
    <table style="max-width:640px;">
      <thead><tr><th>Group</th><th>Meetings</th><th style="text-align:left;">Total</th><th style="text-align:left;">Q${quarter} average</th><th style="text-align:left;">Year average</th></tr></thead>
      <tbody>${rows}
        <tr style="border-top:2px solid var(--rule);">
          <td><b>Combined</b></td>
          <td class="mono">${(c.quarter && c.quarter.meetings) || 0}</td>
          <td class="mono">${num(c.quarter && c.quarter.total)}</td>
          <td class="mono"><b>${num(c.quarter && c.quarter.average)}</b></td>
          <td class="mono"><b>${num(c.year && c.year.average)}</b></td>
        </tr>
      </tbody>
    </table>
    <p class="sub" style="margin:8px 0 0;">Combined is each group&rsquo;s own average <b>added together</b> — what the generational
      groups draw between them in one round of meetings. It is the figure in CLN-02 above, and the same figure the
      roll-up prints in the report; it is shown there but not stored against CLN, so the groups are never counted twice.</p>
  </div>`;
}

// Persist the attendance-derived figures into the stored KPI values so they
// flow into reports and the year-to-date totals. Silent, no re-render; only
// runs when the quarter is editable and a figure is out of step.
// Grouped by goal so a goal carrying two derived KPIs is written once, not
// twice with the second overwriting the first.
async function syncDerivedKpis() {
  if (!_derivedSync.length) return;
  const byGoal = {};
  _derivedSync.forEach(d => { (byGoal[d.goalId] = byGoal[d.goalId] || []).push(d); });

  for (const [goalId, items] of Object.entries(byGoal)) {
    const goal = data.goals.find(g => String(g.id) === String(goalId));
    if (!goal) continue;
    const e = data.kpiEntries.find(x => String(x.goalId) === String(goalId) && x.quarter === quarter);
    const same = items.every(d => {
      const current = e && e.values ? e.values[d.index] : null;
      return Number(current || 0) === Number(d.count || 0);
    });
    if (same) continue; // already in step
    const values = goal.kpis.map((k, i) => {
      const hit = items.find(d => d.index === i);
      if (hit) return hit.count;
      return (e && e.values) ? (e.values[i] ?? null) : null;
    });
    try {
      await api('/entry/kpi', { method: 'PUT', body: { year: data.year, quarter, goalId: goal.id, values } });
      if (e) e.values = values; else data.kpiEntries.push({ goalId: goal.id, quarter, year: data.year, values });
    } catch (err) { /* non-fatal */ }
  }
}

// The quarterly Finance figures.
//
// Two blocks, because the old single "earmarked expenditure" card had Tithes
// and Offertory sitting under a heading that called them expenditure. Money in
// and money out are now separated; the stored keys are unchanged, so the
// District workbook and the reports read exactly what they always read.
//
// Each row shows what the WEEKLY returns make the figure, beside what is
// typed. While a quarter is on the typed figures the weekly column is advice -
// it is how you see the two converging before you trust the switch. Once the
// quarter is switched to the weekly returns the typed boxes are locked and the
// figure is the ledger's, materialised into the same field as before.
const FIN_RECEIPTS = [['offertory', 'Offertory'], ['tithes', 'Tithes']];
const FIN_SPEND = [
  ['missionsEvangelism', 'Missions & Evangelism'], ['welfare', 'Welfare'],
  ['education', 'Education'], ['scholarship', 'Scholarship'],
  ['totalAllExpenditure', 'Total ALL expenditure (excl. statutory transfers)'],
];

function financePanel() {
  const f = (data.special && data.special.finance) || { earmarked: {}, almanac: [] };
  const e = f.earmarked || {};
  const w = data.weekly;
  const fromWeekly = f.source === 'weekly';
  const fed = (w && w.byFeed) || {};
  const money = n => Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const row = ([k, label]) => {
    const wv = w && (k in fed) ? fed[k] : null;
    const typed = e[k];
    // Only flag a gap once there is something to compare against.
    const gap = !fromWeekly && wv !== null && typed != null && Math.abs(Number(typed) - wv) >= 1;
    return `<tr>
      <td>${label}</td>
      <td><input inputmode="decimal" data-num style="max-width:150px;" ${fromWeekly ? 'disabled' : dis()} data-fin="${k}"
        value="${typed != null ? Number(typed).toLocaleString() : ''}"
        ${fromWeekly ? 'title="This quarter is taken from the weekly returns. Change it on the Weekly finance page."' : ''}></td>
      <td class="mono sub" style="white-space:nowrap;">${wv === null ? '\u2014' : money(wv)}</td>
      <td class="sub" style="font-size:11.5px;">${gap ? `Typed figure differs from the weekly returns by ${money(Math.abs(Number(typed) - wv))}` : ''}</td>
    </tr>`;
  };

  const coverage = w
    ? `${w.confirmed} of ${w.sundaysInQuarter} Sunday${w.sundaysInQuarter === 1 ? '' : 's'} confirmed${w.entered > w.confirmed ? ` (${w.entered - w.confirmed} entered, awaiting the Treasurer)` : ''}`
    : 'No weekly returns yet';

  const banner = fromWeekly
    ? `<div class="sub" style="background:var(--surface-2); border-left:3px solid var(--pcg-green); padding:8px 12px; border-radius:6px; margin-bottom:12px;">
         <b>These figures come from the weekly returns</b> \u2014 ${coverage}. Correct them on the Weekly finance page, not here.
         ${canEnter() ? ` <button class="btn btn-secondary btn-sm" style="margin-left:8px;" onclick="setFinanceSource('manual')">Go back to typed figures</button>` : ''}
       </div>`
    : `<div class="sub" style="background:var(--surface-2); border-left:3px solid var(--rule); padding:8px 12px; border-radius:6px; margin-bottom:12px;">
         <b>These figures are typed.</b> The weekly column shows what the returns would make them \u2014 ${coverage}.
         ${w && w.confirmed ? (canEnter() ? ` <button class="btn btn-secondary btn-sm" style="margin-left:8px;" onclick="setFinanceSource('weekly')">Take this quarter from the weekly returns</button>` : '')
            : ' Once the Sundays are entered and confirmed you can switch this quarter over.'}
       </div>`;

  const alm = (f.almanac && f.almanac.length ? f.almanac : ["Children's Week","Youth and Students' Week","YAF Week","Women's Week","Men's Week","JY Week","NOP Week"].map(nm => ({ name: nm, date: '', amount: null })));
  const head = `<thead><tr><th style="width:44%;">Head</th><th>Q${quarter} (GHS)</th><th style="text-align:left;">From weekly</th><th></th></tr></thead>`;
  return `<div class="card" style="margin-bottom:18px; border-top:3px solid var(--pcg-green);">
    <div class="section-title"><h3>4 \u00b7 Finance \u2014 Q${quarter} figures (GHS)</h3></div>
    ${banner}
    <div class="section-title" style="margin-bottom:6px;"><h3 style="font-size:13.5px;">Receipts</h3></div>
    <table>${head}<tbody>${FIN_RECEIPTS.map(row).join('')}</tbody></table>
    <div class="section-title" style="margin:16px 0 6px;"><h3 style="font-size:13.5px;">Earmarked expenditure</h3></div>
    <table>${head}<tbody>${FIN_SPEND.map(row).join('')}</tbody></table>
    <p class="sub" style="margin:8px 0 0;">The four earmarked heads are part of total expenditure, not additional to it.</p>
    <div class="section-title" style="margin-top:16px;"><h3 style="font-size:13.5px;">Almanac week transfers</h3></div>
    <table><thead><tr><th>Celebration</th><th>Date transferred</th><th>Amount (GHS)</th></tr></thead><tbody>
    ${alm.map((a, i) => `<tr><td>${esc(a.name)}</td>
      <td><input type="date" ${dis()} data-alm="${i}" data-f="date" value="${esc(a.date || '')}"></td>
      <td><input inputmode="decimal" data-num style="max-width:130px;" ${dis()} data-alm="${i}" data-f="amount" value="${a.amount != null ? a.amount.toLocaleString() : ''}"></td></tr>`).join('')}
    </tbody></table>
    ${canEnter() && !locked() ? '<button class="btn btn-secondary" style="margin-top:12px;" onclick="saveFinance()">Save finance figures</button>' : ''}
  </div>`;
}

// Switching a quarter between typed figures and the weekly ledger. Confirmed
// first, because switching to the ledger overwrites what is in the boxes.
async function setFinanceSource(source) {
  const w = data.weekly;
  const msg = source === 'weekly'
    ? `The Q${quarter} figures will be replaced by the total of the confirmed weekly returns`
      + `${w ? ` (${w.confirmed} of ${w.sundaysInQuarter} Sundays)` : ''}.`
      + `\n\nAnything typed here now will be overwritten, and the boxes will lock.`
    : `Q${quarter} goes back to typed figures. The current numbers stay where they are \u2014 they just stop updating from the weekly returns.`;
  if (!await confirmDialog(msg, {
    title: source === 'weekly' ? 'Take this quarter from the weekly returns?' : 'Go back to typed figures?',
    okText: source === 'weekly' ? 'Use the weekly returns' : 'Go back to typed',
    danger: source === 'weekly',
  })) return;
  try {
    await api(`/finance-weekly/quarter/${data.year}/${quarter}/source`, { method: 'POST', body: { source } });
    toast(source === 'weekly' ? 'Q' + quarter + ' now follows the weekly returns' : 'Q' + quarter + ' back on typed figures');
    load();
  } catch (e) { toast(e.message, true); }
}

function membershipPanel() {
  const m = (data.special && data.special.membership) || { categories: {} };
  const c = m.categories || {};
  const cats = [['children', 'Children (up to 12)'], ['juniorYouth', 'Junior Youth (12–18)'], ['youth', 'Youth (18–30)'], ['youngAdults', 'Young Adults (30–40)'], ['adults', 'Adults (40+)']];
  const total = cats.reduce((n, [k]) => n + (Number(c[k]) || 0), 0);
  return `<div class="card" style="margin-bottom:18px; border-top:3px solid var(--pcg-green);">
    <div class="section-title"><h3>4 · AHRM — membership on roll at end of Q${quarter}</h3></div>
    <table><thead><tr><th>Category</th><th>Members on roll</th></tr></thead><tbody>
    ${cats.map(([k, label]) => `<tr><td>${label}</td>
      <td><input inputmode="numeric" data-num style="max-width:130px;" ${dis()} data-mem="${k}" value="${c[k] != null ? c[k].toLocaleString() : ''}"></td></tr>`).join('')}
    <tr><td><b>Total</b></td><td class="mono"><b>${total.toLocaleString()}</b></td></tr>
    </tbody></table>
    ${canEnter() && !locked() ? '<button class="btn btn-secondary" style="margin-top:12px;" onclick="saveMembership()">Save membership</button>' : ''}
  </div>`;
}

function pdbpPanel() {
  const p = (data.special && data.special.pdbp) || {};
  const lands = p.lands || (data.special.lands || []).map(l => ({ landId: l.id, name: l.name, status: '' }));
  const props = p.properties || (data.special.properties || []).map(x => ({ propertyId: x.id, name: x.name, insured: '' }));
  return `<div class="card" style="margin-bottom:18px; border-top:3px solid var(--pcg-green);">
    <div class="section-title"><h3>4 · PDBP — land ownership status (Q${quarter})</h3></div>
    <table><thead><tr><th>Land</th><th>Status</th></tr></thead><tbody>
    ${lands.map((l, i) => `<tr><td>${esc(l.name)}</td>
      <td><select ${dis()} data-land="${i}"><option value=""></option>
        ${LAND_STATUSES.map(s => `<option ${l.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select></td></tr>`).join('')}
    </tbody></table>
    <div class="section-title" style="margin-top:14px;"><h3>Property insurance</h3></div>
    <table><thead><tr><th>Property</th><th>Insured?</th></tr></thead><tbody>
    ${props.map((x, i) => `<tr><td>${esc(x.name)}</td>
      <td><select ${dis()} data-prop="${i}"><option value=""></option>
        <option ${x.insured === 'Yes' ? 'selected' : ''}>Yes</option><option ${x.insured === 'No' ? 'selected' : ''}>No</option>
      </select></td></tr>`).join('')}
    </tbody></table>
    ${canEnter() && !locked() ? '<button class="btn btn-secondary" style="margin-top:12px;" onclick="savePdbp()">Save land &amp; property status</button>' : ''}
  </div>`;
}

// ---- save handlers ----
async function saveKpi(goalId) {
  const goal = data.goals.find(g => g.id === goalId);
  const values = goal.kpis.map((k, i) => {
    const el = document.querySelector(`[data-kpi="${goalId}:${i}"]`);
    const v = el ? el.value.trim() : '';
    if (v === '') return null;
    const n = numVal(v);
    return n !== null && !isNaN(n) ? n : v;
  });
  try {
    await api('/entry/kpi', { method: 'PUT', body: { year: data.year, quarter, goalId, values } });
    toast(`${goal.code} saved`);
    const e = data.kpiEntries.find(x => x.goalId === goalId && x.quarter === quarter);
    if (e) e.values = values; else data.kpiEntries.push({ goalId, quarter, year: data.year, values });
    render();
  } catch (err) { toast(err.message, true); }
}

async function saveAct(id) {
  const get = f => { const el = document.querySelector(`[data-act="${id}"][data-f="${f}"]`); return el ? el.value : ''; };
  try {
    await api('/entry/activity-update', { method: 'PUT', body: {
      year: data.year, quarter, activityId: id,
      actual: get('actual'), remarks: get('remarks'), actualSpend: numVal(get('spend')),
    } });
    toast('Activity update saved');
    const u = data.activityUpdates.find(x => x.activityId === id && x.quarter === quarter);
    const patch = { actual: get('actual'), remarks: get('remarks'), actualSpend: numVal(get('spend')) };
    if (u) Object.assign(u, patch); else data.activityUpdates.push({ activityId: id, quarter, year: data.year, ...patch });
  } catch (err) { toast(err.message, true); }
}

async function saveNarrative() {
  try {
    const body = {
      year: data.year, quarter,
      preamble: document.getElementById('nPreamble').value,
      achievements: document.getElementById('nAchievements').value,
      challenges: document.getElementById('nChallenges').value,
      financial: document.getElementById('nFinancial') ? document.getElementById('nFinancial').value : undefined,
      recommendations: document.getElementById('nRecommendations').value,
    };
    if (currentEntity) { body.entityType = currentEntity.type; body.entityId = currentEntity.id; }
    await api('/entry/narrative', { method: 'PUT', body });
    toast('Narrative saved');
  } catch (err) { toast(err.message, true); }
}

async function saveFinance() {
  const earmarked = {};
  document.querySelectorAll('[data-fin]').forEach(el => { earmarked[el.dataset.fin] = numVal(el.value); });
  const names = ["Children's Week","Youth and Students' Week","YAF Week","Women's Week","Men's Week","JY Week","NOP Week"];
  const almanac = names.map((nm, i) => ({
    name: nm,
    date: (document.querySelector(`[data-alm="${i}"][data-f="date"]`) || {}).value || '',
    amount: (() => { const v = (document.querySelector(`[data-alm="${i}"][data-f="amount"]`) || {}).value; return v === undefined ? null : numVal(v); })(),
  }));
  try { await api('/entry/finance', { method: 'PUT', body: { year: data.year, quarter, earmarked, almanac } }); toast('Finance figures saved'); }
  catch (err) { toast(err.message, true); }
}

async function saveMembership() {
  const categories = {};
  document.querySelectorAll('[data-mem]').forEach(el => { categories[el.dataset.mem] = numVal(el.value); });
  try { await api('/entry/membership', { method: 'PUT', body: { year: data.year, quarter, categories } }); toast('Membership saved'); load(); }
  catch (err) { toast(err.message, true); }
}

async function savePdbp() {
  const landsMaster = data.special.lands || [];
  const propsMaster = data.special.properties || [];
  const lands = [...document.querySelectorAll('[data-land]')].map((el, i) => ({
    landId: landsMaster[i] ? landsMaster[i].id : i + 1, name: landsMaster[i] ? landsMaster[i].name : '', status: el.value,
  }));
  const properties = [...document.querySelectorAll('[data-prop]')].map((el, i) => ({
    propertyId: propsMaster[i] ? propsMaster[i].id : i + 1, name: propsMaster[i] ? propsMaster[i].name : '', insured: el.value,
  }));
  try { await api('/entry/pdbp', { method: 'PUT', body: { year: data.year, quarter, lands, properties } }); toast('Land & property status saved'); }
  catch (err) { toast(err.message, true); }
}

document.getElementById('submitBtn').onclick = async () => {
  if (!await confirmDialog(reopenActive()
    ? `Resubmit Q${quarter} ${data.year}? This closes the change window and locks the quarter again.`
    : `Submit Q${quarter} ${data.year}? Data locks after submission — changes then need an approved change request or an admin unlock.`)) return;
  try {
    const body = { year: data.year, quarter };
    if (currentEntity) { body.entityType = currentEntity.type; body.entityId = currentEntity.id; }
    await api('/entry/submit', { method: 'POST', body });
    toast(`Q${quarter} submitted & locked`);
    load();
  } catch (err) { toast(err.message, true); }
};
document.getElementById('unlockBtn').onclick = async () => {
  if (!await confirmDialog('Unlock this submitted quarter? The unlock is recorded in the activity log.')) return;
  try {
    await api('/entry/unlock', { method: 'POST', body: { year: data.year, quarter, entityType: data.entity.type, entityId: data.entity.id } });
    toast('Unlocked');
    load();
  } catch (err) { toast(err.message, true); }
};
document.querySelectorAll('#quarterToggle button').forEach(b => b.onclick = () => { quarter = Number(b.dataset.q); load(); });

requireAuthAndRenderShell().then(async u => {
  me = u;
  [committees, groups] = await Promise.all([api('/setup/committees').catch(() => []), api('/setup/groups').catch(() => [])]);
  const filter = document.getElementById('entityFilter');
  if (isElevated(me) || (me.permissions || []).includes('congregation.view')) {
    filter.style.display = '';
    filter.innerHTML = [`<option value="congregation:0">Congregation (Overarching)</option>`]
      .concat(committees.map(c => `<option value="committee:${c.id}">Committee — ${esc(c.name)}</option>`))
      .concat(groups.map(g => `<option value="group:${g.id}">Group — ${esc(g.name)}</option>`)).join('');
    const first = committees[0];
    currentEntity = first ? { type: 'committee', id: first.id } : { type: 'congregation', id: 0 };
    filter.value = `${currentEntity.type}:${currentEntity.id}`;
    filter.onchange = e => { const [t, i] = e.target.value.split(':'); currentEntity = { type: t, id: Number(i) }; load(); };
  }
  load();
});
