// Annual Plan page (Phase 2) — activities per goal with quarterly targets & cost.
let me, activities = [], goals = [], committees = [], groups = [];
let currentEntity = null; // {type, id, code, name}
let editingId = null;

function canPlan() {
  if (!me) return false;
  if (isElevated(me)) return true;
  const perms = me.permissions || [];
  if (!perms.includes('planning.manage')) return false;
  // Reporting Coordinator: congregation.manage = plan for any committee/group.
  if (perms.includes('congregation.manage')) return true;
  return me.entity && me.entity.type !== 'congregation';
}

function entityLabel(a) {
  if (a.entityType === 'congregation') return 'Congregation (Overarching)';
  const list = a.entityType === 'committee' ? committees : groups;
  const rec = list.find(x => x.id === Number(a.entityId));
  return rec ? rec.name : a.ownerCode;
}

async function load() {
  [committees, groups, goals] = await Promise.all([
    api('/setup/committees').catch(() => []),
    api('/setup/groups').catch(() => []),
    api('/setup/goals'),
  ]);

  const filter = document.getElementById('entityFilter');
  if (isElevated(me) || (me.permissions || []).includes('congregation.view')) {
    filter.style.display = '';
    const opts = [`<option value="congregation:0">Congregation (Overarching)</option>`]
      .concat(committees.map(c => `<option value="committee:${c.id}">Committee — ${esc(c.name)}</option>`))
      .concat(groups.map(g => `<option value="group:${g.id}">Group — ${esc(g.name)}</option>`));
    filter.innerHTML = opts.join('');
    if (!currentEntity) {
      const first = committees[0];
      currentEntity = first ? { type: 'committee', id: first.id, code: first.code, name: first.name } : { type: 'congregation', id: 0, code: 'OG', name: 'Congregation' };
    }
    // Always re-point the select at whatever is actually selected. Rebuilding
    // the options resets it to the first entry, so if load() ever runs a second
    // time the dropdown would say "Congregation" while the page was still
    // showing a committee's plan — the control and the data disagreeing.
    filter.value = `${currentEntity.type}:${currentEntity.id}`;
  } else if (window.myEntity) {
    currentEntity = { type: window.myEntity.type, id: Number(window.myEntity.id), code: window.myEntity.code, name: window.myEntity.name };
    const h1 = document.querySelector('.page-header h1');
    if (h1) h1.textContent = `${currentEntity.name} — Annual Plan`;
  }
  await loadActivities();
}

async function loadActivities() {
  const q = currentEntity ? `?entityType=${currentEntity.type}&entityId=${currentEntity.id}` : '';
  activities = await api('/planning/activities' + q);
  render();
}

function myGoals() {
  const code = currentEntity ? currentEntity.code : null;
  return goals.filter(g => g.ownerCode === code);
}

function render() {
  const linked = activities.filter(a => a.goalId);
  const cost = activities.reduce((n, a) => n + (a.annualCost || 0), 0);
  document.getElementById('statActs').textContent = activities.length;
  document.getElementById('statLinked').textContent = linked.length;
  document.getElementById('statUnlinked').textContent = activities.length - linked.length;
  document.getElementById('statCost').textContent = cost.toLocaleString();
  document.getElementById('countLabel').textContent = currentEntity
    ? `${currentEntity.name} · ${new Date().getFullYear()} plan` : '';

  const body = document.getElementById('planBody');
  const gl = myGoals();
  const sections = [];

  const unassigned = activities.filter(a => !a.goalId);
  if (unassigned.length) {
    sections.push(card('⚠ Not yet linked to a goal — imported from the Excel plan; edit each one to choose its goal', unassigned, true));
  }
  gl.forEach(g => {
    const list = activities.filter(a => a.goalId === g.id);
    if (list.length || canPlan()) {
      sections.push(card(`${g.code} — ${g.description}`, list, false, g.id));
    }
  });
  body.innerHTML = sections.join('') || '<div class="card"><p class="sub">No goals found for this committee/group.</p></div>';
}

function card(title, list, warn, goalId) {
  const rows = list.map(a => `<tr>
    <td>${esc(a.description)}</td>
    <td>${esc(a.targets.q1 || '—')}</td><td>${esc(a.targets.q2 || '—')}</td>
    <td>${esc(a.targets.q3 || '—')}</td><td>${esc(a.targets.q4 || '—')}</td>
    <td class="mono">${a.annualCost != null ? a.annualCost.toLocaleString() : '—'}</td>
    <td>${canPlan() ? `<button class="btn btn-secondary btn-sm" onclick="editAct(${a.id})">Edit</button>
        <button class="btn btn-danger btn-sm" onclick="delAct(${a.id})">Del</button>` : ''}</td>
  </tr>`).join('') || `<tr><td colspan="7" class="sub">No activities planned yet${canPlan() ? ' — use “+ Add activity”' : ''}.</td></tr>`;
  return `<div class="card" style="margin-bottom:18px; ${warn ? 'border-left:4px solid var(--pcg-red);' : ''}">
    <div class="section-title"><h3 style="font-size:15px;">${esc(title)}</h3></div>
    <table>
      <thead><tr><th style="min-width:220px;">Activity / Strategy</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th><th>Cost (GHS)</th><th></th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function goalOptions(selected) {
  return '<option value="">— choose a goal —</option>' + myGoals()
    .map(g => `<option value="${g.id}" ${Number(selected) === g.id ? 'selected' : ''}>${esc(g.code)} — ${esc(g.description.slice(0, 60))}</option>`).join('');
}

function editAct(id) {
  const a = activities.find(x => x.id === id);
  editingId = id;
  document.getElementById('actTitle').textContent = 'Edit activity';
  document.getElementById('aDesc').value = a.description;
  document.getElementById('aGoal').innerHTML = goalOptions(a.goalId);
  document.getElementById('aQ1').value = a.targets.q1 || '';
  document.getElementById('aQ2').value = a.targets.q2 || '';
  document.getElementById('aQ3').value = a.targets.q3 || '';
  document.getElementById('aQ4').value = a.targets.q4 || '';
  document.getElementById('aCost').value = a.annualCost != null ? a.annualCost.toLocaleString() : '';
  document.getElementById('actOverlay').style.display = 'flex';
}

async function delAct(id) {
  if (!await confirmDialog('Remove this planned activity?')) return;
  try { await api(`/planning/activities/${id}`, { method: 'DELETE' }); toast('Activity removed'); loadActivities(); }
  catch (e) { toast(e.message, true); }
}

document.getElementById('actForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {
    description: document.getElementById('aDesc').value.trim(),
    goalId: document.getElementById('aGoal').value || null,
    targets: {
      q1: document.getElementById('aQ1').value, q2: document.getElementById('aQ2').value,
      q3: document.getElementById('aQ3').value, q4: document.getElementById('aQ4').value,
    },
    annualCost: numVal(document.getElementById('aCost').value),
  };
  try {
    if (editingId) await api(`/planning/activities/${editingId}`, { method: 'PUT', body });
    else await api('/planning/activities', { method: 'POST', body: { ...body, entityType: currentEntity.type, entityId: currentEntity.id } });
    toast('Saved');
    document.getElementById('actOverlay').style.display = 'none';
    loadActivities();
  } catch (err) { toast(err.message, true); }
});

document.getElementById('entityFilter').onchange = e => {
  const [type, id] = e.target.value.split(':');
  const list = type === 'committee' ? committees : groups;
  const rec = list.find(x => x.id === Number(id));
  currentEntity = { type, id: Number(id), code: type === 'congregation' ? 'OG' : (rec ? rec.code : null), name: rec ? rec.name : 'Congregation (Overarching)' };
  loadActivities();
};
document.getElementById('actCancelBtn').onclick = () => document.getElementById('actOverlay').style.display = 'none';
document.getElementById('addBtn').onclick = () => {
  editingId = null;
  document.getElementById('actTitle').textContent = 'Add activity';
  document.getElementById('actForm').reset();
  document.getElementById('aGoal').innerHTML = goalOptions(null);
  document.getElementById('actOverlay').style.display = 'flex';
};

requireAuthAndRenderShell().then(u => {
  me = u;
  if (canPlan()) document.getElementById('addBtn').style.display = '';
  load();
});
