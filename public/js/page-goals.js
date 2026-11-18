// Goals & KPIs page (Phase 1).
let me, goals = [], committees = [], groups = [], goalRequests = [];
const SOURCE_BADGE = {
  tyrp: '<span class="badge badge-done">TYRP</span>',
  higher_courts: '<span class="badge badge-done">TYRP</span>',
  local_strategic: '<span class="badge badge-progress">Local Strategic</span>',
  merged: '<span class="badge badge-info">Merged (TYRP + Strategic)</span>',
  committee_tor: '<span class="badge badge-attention">Committee TOR</span>',
};
// Goals rights (Oct 2026). Must match goalAccess() in routes/setup.js:
//  - every goal: admin tier, Session Clerk, goals.manage (Reporting Coordinator)
//  - own goals only, as a PROPOSAL the Session Clerk approves: a secretary
//    (planning.manage) on their own committee or group
function canAllGoals() { const p = me.permissions || []; return isElevated(me) || p.includes('approvals.manage') || p.includes('goals.manage'); }
function canProposeOwn() { return !canAllGoals() && (me.permissions || []).includes('planning.manage') && !!(window.myEntity && window.myEntity.code); }
function canEditGoal(g) { return canAllGoals() || (canProposeOwn() && g && g.ownerCode === window.myEntity.code); }
function canSetup() { return canAllGoals() || canProposeOwn(); }
// Admin tier + Session Clerk (approvals.manage) decide goal requests.
function canApproveGoals() { return isElevated(me) || (me.permissions || []).includes('approvals.manage'); }
function ownerName(code) {
  if (code === 'OG') return 'Congregation (Overarching)';
  const c = committees.find(x => x.code === code);
  if (c) return c.name;
  const g = groups.find(x => x.code === code);
  return g ? g.name : code;
}

async function load() {
  [committees, groups, goals, goalRequests] = await Promise.all([
    api('/setup/committees'),
    api('/setup/groups'),
    api('/setup/goals'),
    api('/setup/goal-requests?status=pending').catch(() => []),
  ]);
  // Owner filter: All owners, then the congregation, then every committee and
  // every group (a goal can belong to any of the three).
  const filter = document.getElementById('ownerFilter');
  const opt = (o, label) => `<option value="${o}">${esc(label)}</option>`;
  // Rebuilding the options resets the select to its first entry. Every save,
  // edit and delete on this page calls load(), so without this the filter
  // snapped back to "All owners" each time and threw you out of the committee
  // you were working in. Keep the choice across the rebuild.
  const keepOwner = filter.value;
  filter.innerHTML = [opt('', 'All owners'), opt('OG', ownerName('OG'))]
    .concat(committees.map(c => opt(c.code, c.name)))
    .concat(groups.map(g => opt(g.code, g.name)))
    .join('');
  // Only restore an owner that still exists — a committee could have been
  // deactivated since the page was opened.
  if (keepOwner && [...filter.options].some(o => o.value === keepOwner)) filter.value = keepOwner;
  // Add-goal owner picker: grouped so a group can be chosen as owner, not only
  // committees. Without groups here, group goals could never be created and the
  // group would never see them.
  const gOwner = document.getElementById('gOwner');
  if (gOwner) {
    gOwner.innerHTML =
      `<optgroup label="Congregation">${opt('OG', ownerName('OG'))}</optgroup>` +
      `<optgroup label="Committees">${committees.map(c => opt(c.code, c.name)).join('')}</optgroup>` +
      `<optgroup label="Groups">${groups.map(g => opt(g.code, g.name)).join('')}</optgroup>`;
  }
  render();
  renderPending();
}

function render() {
  const owner = document.getElementById('ownerFilter').value;
  const list = goals.filter(g => !owner || g.ownerCode === owner);
  document.getElementById('countLabel').textContent = `${list.length} goals · ${list.reduce((n, g) => n + (g.kpis || []).length, 0)} KPIs`;
  if (window.myEntity) {
    const h1 = document.querySelector('.page-header h1');
    if (h1) h1.textContent = `${window.myEntity.name} — Goals & KPIs`;
  }
  document.getElementById('rows').innerHTML = list.map(g => {
    const kpis = g.kpis || [];
    const noTarget = kpis.filter(k => k.target === null || k.target === undefined || k.target === '').length;
    return `<tr>
    <td class="mono">${esc(g.code)}</td>
    <td>${esc(g.description)}</td>
    <td>${esc(ownerName(g.ownerCode))}</td>
    <td>${SOURCE_BADGE[g.source] || esc(g.source || '')}</td>
    <td>${kpis.length}${noTarget ? ` <span class="badge badge-progress" title="${noTarget} KPI(s) still need this year's target">${noTarget} need target</span>` : ''}${g.sharedWith ? ` <span class="badge badge-info" title="This goal is also worked on by ${g.sharedWith} group(s); you report on their work too">shared with ${g.sharedWith}</span>` : ''}</td>
    <td style="white-space:nowrap;"><button class="btn ${noTarget ? 'btn-primary' : 'btn-secondary'} btn-sm" onclick="openKpis(${g.id})">${noTarget ? 'Set targets' : 'KPIs'}</button>${g.sharedWith ? ` <button class="btn btn-secondary btn-sm" onclick="openShared(${g.id})">Shared work</button>` : ''}${canEditGoal(g) ? ` <button class="btn btn-secondary btn-sm" onclick="editGoal(${g.id})">${canAllGoals() ? 'Edit' : 'Propose change'}</button>` : ''}${isElevated(me) ? ` <button class="btn btn-danger btn-sm" onclick="deleteGoal(${g.id})">Delete</button>` : ''}</td>
  </tr>`; }).join('') || '<tr><td colspan="6" class="sub">No goals found.</td></tr>';
  // Summary of outstanding targets across the visible goals.
  const missing = list.reduce((n, g) => n + (g.kpis || []).filter(k => k.target === null || k.target === undefined || k.target === '').length, 0);
  const cl = document.getElementById('countLabel');
  if (cl && missing) cl.textContent += ` · ${missing} KPI target(s) still to be set for the year`;
}

// Pending goal requests. Approvers (Admin / Session Clerk) see everyone's with
// Approve/Decline; a proposer sees only their own (read-only, "Awaiting approval").
function renderPending() {
  const card = document.getElementById('pendingCard');
  if (!card) return;
  const list = goalRequests.filter(r => r.status === 'pending');
  if (!list.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  const approver = canApproveGoals();
  document.getElementById('pendingCount').textContent =
    `${list.length} goal${list.length === 1 ? '' : 's'} awaiting approval`;
  document.getElementById('pendingRows').innerHTML = list.map(r => `<tr>
    <td class="mono">${esc(r.code)}</td>
    <td>${r.kind === 'edit' ? `<span class="badge badge-info">change</span> ${esc(changeSummary(r))}` : `<span class="badge badge-progress">new</span> ${esc(r.description)}`}</td>
    <td>${esc(ownerName(r.ownerCode))}</td>
    <td>${SOURCE_BADGE[r.source] || esc(r.source || '')}</td>
    <td>${esc(r.requestedBy || '')}</td>
    <td>${approver
      ? `<button class="btn btn-primary btn-sm" onclick="approveGoal(${r.id})">Approve</button>
         <button class="btn btn-secondary btn-sm" onclick="declineGoal(${r.id})">Decline</button>`
      : '<span class="badge badge-progress">Awaiting approval</span>'}</td>
  </tr>`).join('');
}

// What a proposed change actually changes, in words the Clerk can judge.
function changeSummary(r) {
  const p = r.patch || {}, b = r.before || {}, out = [];
  if (p.description !== undefined) out.push(`Description: \u201c${p.description}\u201d (was \u201c${b.description || ''}\u201d)`);
  if (p.source !== undefined) out.push(`Source: ${p.source} (was ${b.source || '\u2014'})`);
  if (p.kpis !== undefined) {
    const was = b.kpis || [], now = p.kpis || [];
    const lines = now.map((k, i) => {
      const o = was[i] || {};
      if (!was[i]) return `new KPI \u201c${k.description}\u201d target ${k.target ?? '\u2014'}`;
      const bits = [];
      if (o.description !== k.description) bits.push(`\u201c${o.description}\u201d \u2192 \u201c${k.description}\u201d`);
      if ((o.target ?? null) !== (k.target ?? null)) bits.push(`target ${o.target ?? '\u2014'} \u2192 ${k.target ?? '\u2014'}`);
      if ((o.unit || '') !== (k.unit || '')) bits.push(`unit ${o.unit || '\u2014'} \u2192 ${k.unit || '\u2014'}`);
      return bits.length ? `KPI ${i + 1}: ${bits.join(', ')}` : null;
    }).filter(Boolean);
    if (was.length > now.length) lines.push(`${was.length - now.length} KPI(s) removed`);
    out.push(lines.length ? lines.join('; ') : 'KPIs (no visible difference)');
  }
  return out.join(' \u00b7 ') || 'No changes';
}

async function approveGoal(id) {
  try {
    await api(`/setup/goal-requests/${id}/approve`, { method: 'POST' });
    toast('Goal approved');
    load();
  } catch (err) { toast(err.message, true); }
}

async function declineGoal(id) {
  const reason = await promptDialog('Reason for declining (optional):', { title: 'Decline goal', multiline: true, okText: 'Decline', placeholder: 'Optional note to the proposer' });
  if (reason === null) return;
  try {
    await api(`/setup/goal-requests/${id}/decline`, { method: 'POST', body: { reason } });
    toast('Goal request declined');
    load();
  } catch (err) { toast(err.message, true); }
}

function fmtVal(v, unit) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') {
    if (unit === '%') return (v * 100).toFixed(1).replace(/\.0$/, '') + '%';
    return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
  }
  return String(v);
}

let kpiGoalId = null;

// KPI dialog. Read-only for most people; anyone with goals rights (admin,
// setup.manage or goals.manage) can edit the KPIs and — importantly — set
// this year's TARGET, including on goals imported from the TYRP.
function openKpis(id) {
  const g = goals.find(x => x.id === id);
  kpiGoalId = id;
  const editable = canEditGoal(g);
  document.getElementById('kpiTitle').textContent = g.code;
  document.getElementById('kpiDesc').textContent = g.description;
  document.getElementById('kpiHint').style.display = editable ? '' : 'none';
  document.getElementById('kpiAddBtn').style.display = editable ? '' : 'none';
  document.getElementById('kpiSaveBtn').style.display = editable ? '' : 'none';
  document.getElementById('kpiActionsHead').style.display = editable ? '' : 'none';
  renderKpiRows(g.kpis || [], editable);
  document.getElementById('kpiOverlay').style.display = 'flex';
}

function kpiRowHtml(k, editable) {
  if (!editable) {
    return `<tr>
      <td>${esc(k.description)}</td><td>${esc(k.unit || '')}</td>
      <td class="mono">${fmtVal(k.prevActual, k.unit)}</td><td class="mono">${fmtVal(k.target, k.unit)}</td>
    </tr>`;
  }
  const needsTarget = k.target === null || k.target === undefined || k.target === '';
  return `<tr class="kpi-row">
    <td><input type="text" data-f="description" value="${esc(k.description || '')}" placeholder="KPI description"></td>
    <td><input type="text" data-f="unit" style="max-width:90px;" value="${esc(k.unit || '')}" placeholder="No. / % / GHS"></td>
    <td><input type="text" data-f="prevActual" style="max-width:110px;" value="${k.prevActual == null ? '' : esc(String(k.prevActual))}"></td>
    <td><input type="text" data-f="target" style="max-width:110px;${needsTarget ? ' border-color:var(--pcg-red); background:rgba(201,162,39,.08);' : ''}" value="${k.target == null ? '' : esc(String(k.target))}" placeholder="${needsTarget ? 'set target' : ''}"></td>
    <td><button type="button" class="btn btn-danger btn-sm" onclick="this.closest('tr').remove()">Remove</button></td>
  </tr>`;
}

function renderKpiRows(kpis, editable) {
  const body = document.getElementById('kpiRows');
  body.innerHTML = kpis.map(k => kpiRowHtml(k, editable)).join('')
    || (editable ? '' : `<tr><td colspan="4" class="sub">No KPIs recorded.</td></tr>`);
}

document.getElementById('kpiAddBtn').onclick = () => {
  document.getElementById('kpiRows').insertAdjacentHTML('beforeend', kpiRowHtml({}, true));
};

document.getElementById('kpiSaveBtn').onclick = async () => {
  const rows = [...document.querySelectorAll('#kpiRows tr.kpi-row')];
  const kpis = rows.map(tr => {
    const val = f => tr.querySelector(`[data-f="${f}"]`).value.trim();
    const num = v => v === '' ? null : (isNaN(Number(v.replace(/,/g, ''))) ? v : Number(v.replace(/,/g, '')));
    return {
      description: val('description'),
      unit: val('unit'),
      prevActual: num(val('prevActual')),
      target: num(val('target')),
    };
  }).filter(k => k.description);
  try {
    const r = await api(`/setup/goals/${kpiGoalId}`, { method: 'PUT', body: { kpis } });
    toast(r && r.pending ? 'KPI changes sent to the Session Clerk for approval.' : 'KPIs and targets saved.');
    document.getElementById('kpiOverlay').style.display = 'none';
    load();
  } catch (e) { toast(e.message, true); }
};

// Open the goal form to EDIT an existing goal. The code and year are the
// goal's identity (KPI entries key off them), so they stay locked — only the
// description, owner and source can change.
let editingGoalId = null;
function editGoal(id) {
  const g = goals.find(x => x.id === id);
  if (!g) return;
  editingGoalId = id;
  document.querySelector('#goalOverlay h2').textContent = `Edit ${g.code}`;
  document.getElementById('gCode').value = g.code || '';
  document.getElementById('gCode').disabled = true;   // identity — never edited
  document.getElementById('gDesc').value = g.description || '';
  document.getElementById('gOwner').value = g.ownerCode || '';
  document.getElementById('gOwner').disabled = !canAllGoals();
  document.getElementById('gSource').value = g.source || 'committee_tor';
  const kpiField = document.getElementById('gKpi').closest('.field');
  if (kpiField) kpiField.style.display = 'none';      // KPIs are edited in the KPI dialog
  document.getElementById('goalOverlay').style.display = 'flex';
}

document.getElementById('goalForm').addEventListener('submit', async e => {
  e.preventDefault();
  // ---- editing an existing goal ----
  if (editingGoalId) {
    try {
      const body = {
        description: document.getElementById('gDesc').value.trim(),
        source: document.getElementById('gSource').value,
      };
      // Only someone with every-goal rights may move a goal to another owner.
      if (canAllGoals()) body.ownerCode = document.getElementById('gOwner').value;
      const r = await api(`/setup/goals/${editingGoalId}`, { method: 'PUT', body });
      toast(r && r.pending ? 'Change sent to the Session Clerk for approval' : 'Goal updated');
      document.getElementById('goalOverlay').style.display = 'none';
      load();
    } catch (err) { toast(err.message, true); }
    return;
  }
  // ---- adding a new goal ----
  const kpiRaw = document.getElementById('gKpi').value.trim();
  const kpis = [];
  if (kpiRaw) {
    const [d, u, t] = kpiRaw.split('|').map(s => s.trim());
    kpis.push({ description: d || kpiRaw, unit: u || '', prevActual: null, target: isNaN(Number(t)) ? (t || null) : Number(t) });
  }
  try {
    const activeYears = await api('/setup/years');
    const year = (activeYears.find(y => y.active) || activeYears[0] || { year: new Date().getFullYear() }).year;
    const result = await api('/setup/goals', { method: 'POST', body: {
      year,
      code: document.getElementById('gCode').value.trim(),
      description: document.getElementById('gDesc').value.trim(),
      ownerCode: document.getElementById('gOwner').value,
      source: document.getElementById('gSource').value,
      kpis,
    } });
    toast(result && result.pending ? 'Goal submitted for the Session Clerk to approve' : 'Goal added');
    document.getElementById('goalOverlay').style.display = 'none';
    load();
  } catch (err) { toast(err.message, true); }
});

document.getElementById('ownerFilter').onchange = render;
document.getElementById('kpiCloseBtn').onclick = () => document.getElementById('kpiOverlay').style.display = 'none';
document.getElementById('goalCancelBtn').onclick = () => document.getElementById('goalOverlay').style.display = 'none';
document.getElementById('addBtn').onclick = () => {
  editingGoalId = null;
  document.getElementById('goalForm').reset();
  document.querySelector('#goalOverlay h2').textContent = 'Add goal';
  document.getElementById('gCode').disabled = false;
  // A secretary proposes goals for their own body only.
  const own = document.getElementById('gOwner');
  own.disabled = !canAllGoals();
  if (!canAllGoals() && window.myEntity) own.value = window.myEntity.code;
  const kpiField = document.getElementById('gKpi').closest('.field');
  if (kpiField) kpiField.style.display = '';
  document.getElementById('goalOverlay').style.display = 'flex';
};

requireAuthAndRenderShell().then(u => {
  me = u;
  if (canSetup()) document.getElementById('addBtn').style.display = '';
  load();
});


// ---- Shared goals: what the groups working on this goal have done ----------
// The committee responsible for a goal reports on everyone's work, so it needs
// to see everyone's work. Read-only, deliberately: the figures and activities
// belong to whoever entered them, and this view has no way to change them.
async function openShared(goalId) {
  const q = Math.min(4, Math.floor(new Date().getMonth() / 3) + 1);
  document.getElementById('shBody').innerHTML = '<p class="sub">Loading…</p>';
  document.getElementById('shOverlay').style.display = 'flex';
  let r;
  try { r = await api(`/setup/goals/${goalId}/rollup?quarter=${q}`); }
  catch (e) { document.getElementById('shBody').innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }
  if (!r.shared) { document.getElementById('shBody').innerHTML = '<p class="sub">This goal is not shared with any group.</p>'; return; }

  document.getElementById('shTitle').textContent = `${r.code} — shared with ${r.participants.length} group${r.participants.length === 1 ? '' : 's'}`;
  document.getElementById('shDesc').textContent = `${r.description} · Q${r.quarter} ${r.year}`;

  const tally = r.kpis.map(k => `<tr>
      <td>${esc(k.description)}</td><td class="mono">${esc(k.unit || '')}</td>
      <td class="mono" style="text-align:right;">${k.own === null ? '—' : k.own.toLocaleString()}</td>
      <td class="mono" style="text-align:right;"><b>${k.summable ? (k.total === null ? '—' : k.total.toLocaleString()) : '<span class="sub">not added up</span>'}</b></td>
    </tr>`).join('');

  const active = r.participants.filter(p => p.activities.length || p.values.some(v => v !== null));
  const blocks = active.map(p => `
    <div style="border:1px solid var(--rule); border-radius:8px; padding:10px 12px; margin-bottom:8px;">
      <div style="display:flex; gap:8px; align-items:baseline; flex-wrap:wrap;">
        <b>${esc(p.name)}</b>
        ${p.values.map((v, i) => v === null ? '' : `<span class="badge badge-info">${esc(r.kpis[i].description)}: ${v.toLocaleString()}</span>`).join('')}
        ${p.submitted ? '<span class="badge badge-done">quarter submitted</span>' : '<span class="badge badge-attention">not submitted yet</span>'}
      </div>
      ${p.activities.length ? `<table style="margin-top:8px;">
        <thead><tr><th>Activity</th><th>Target</th><th>Actual</th><th>Remarks</th></tr></thead>
        <tbody>${p.activities.map(a => `<tr><td>${esc(a.description)}</td><td class="sub">${esc(a.target)}</td><td>${esc(a.actual)}</td><td class="sub">${esc(a.remarks)}</td></tr>`).join('')}</tbody>
      </table>` : '<p class="sub" style="margin:6px 0 0;">Figures reported, but no activities planned against this goal.</p>'}
    </div>`).join('');

  document.getElementById('shBody').innerHTML = `
    <div class="section-title" style="margin-top:4px;"><h3 style="font-size:14px;">The tally you report</h3></div>
    <table>
      <thead><tr><th>Key Performance Indicator</th><th>Unit</th><th style="text-align:right;">${esc(r.parent.name)} alone</th><th style="text-align:right;">Total reported</th></tr></thead>
      <tbody>${tally}</tbody>
    </table>
    <p class="sub" style="margin:8px 0 0;">The total is what appears in your quarterly report, the congregation report and the District return. Percentages and dates are never added up.</p>

    <div class="section-title" style="margin-top:16px;"><h3 style="font-size:14px;">What the groups are doing</h3></div>
    ${blocks || '<p class="sub">No group has recorded anything against this goal yet.</p>'}
    ${r.noActivities.length ? `<p class="sub" style="margin-top:10px;"><b>Nothing planned against this goal:</b> ${r.noActivities.map(esc).join(', ')}.</p>` : ''}
    <p class="sub" style="margin-top:10px;">You can see this work but not change it — each group owns what it entered.</p>`;
}
const shClose = document.getElementById('shCloseBtn');
if (shClose) shClose.onclick = () => document.getElementById('shOverlay').style.display = 'none';


// ---- Delete a goal (admin tier only) --------------------------------------
// Two steps on purpose. The first call refuses if anything real is attached and
// tells us what; only then do we ask a second, specific question naming the
// figures that would be destroyed. Activities are never deleted — the server
// unlinks them, so a committee's planned work survives the goal it sat under.
async function deleteGoal(id) {
  const g = goals.find(x => x.id === id);
  if (!g) return;
  if (!await confirmDialog(g.description, {
    title: `Delete goal ${g.code}?`, okText: 'Delete', danger: true,
  })) return;

  try {
    await api(`/setup/goals/${id}`, { method: 'DELETE' });
    toast(`${g.code} deleted.`);
    return load();
  } catch (e) {
    const b = e.data && e.data.blockers;
    if (!b) { toast(e.message, true); return; }

    const lines = [];
    if (b.entries) lines.push(`• ${b.entries} quarter${b.entries === 1 ? '' : 's'} of reported figures (${(b.quarters || []).join(', ')}) — these are PERMANENTLY deleted`);
    if (b.activities) lines.push(`• ${b.activities} activit${b.activities === 1 ? 'y' : 'ies'} — kept, but unlinked from this goal`);
    if (b.sharedWith) lines.push(`• ${b.sharedWith} group${b.sharedWith === 1 ? '' : 's'} share this goal — their copies stay, but ${g.code} stops rolling up to you`);

    if (!await confirmDialog(lines.join('\n') + '\n\nDelete it anyway?', {
      title: `${g.code} still has data attached`, okText: 'Delete anyway', danger: true,
    })) return;

    try {
      const r = await api(`/setup/goals/${id}?force=1`, { method: 'DELETE' });
      toast(`${g.code} deleted — ${r.removedEntries} figure set(s) removed, ${r.unlinkedActivities} activity(ies) kept.`);
      load();
    } catch (err) { toast(err.message, true); }
  }
}
