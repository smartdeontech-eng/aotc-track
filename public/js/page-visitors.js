// Visitors & New Members page (Phase 8).
let me, people = [], current = null;

const STATUS_BADGE = {
  visitor: '<span class="badge badge-progress">visitor</span>',
  'new-member': '<span class="badge badge-info">new member</span>',
  integrated: '<span class="badge badge-done">integrated</span>',
  inactive: '<span class="badge badge-attention">inactive</span>',
};
function q(d) { return Math.floor(new Date(d).getMonth() / 3) + 1; }

async function load() {
  people = await api('/visitors');
  const now = new Date(); const curQ = Math.floor(now.getMonth() / 3) + 1; const yr = now.getFullYear();
  const inQ = d => d && new Date(d).getFullYear() === yr && q(d) === curQ;
  document.getElementById('statVisitors').textContent = people.filter(p => p.status === 'visitor' && inQ(p.firstSeen)).length;
  document.getElementById('statNew').textContent = people.filter(p => (p.status === 'new-member' || p.status === 'integrated') && inQ(p.firstSeen)).length;
  document.getElementById('statIntegrated').textContent = people.filter(p => p.status === 'integrated').length;
  const stalled = people.filter(p => {
    if (p.status !== 'new-member') return false;
    const last = (p.followups || []).length ? p.followups[p.followups.length - 1].at : (p.createdAt || p.firstSeen);
    return (now - new Date(last)) / 864e5 > 14;
  });
  document.getElementById('statStalled').textContent = stalled.length;
  document.getElementById('countLabel').textContent = `${people.length} people on record`;

  document.getElementById('rows').innerHTML = people.map(p => {
    const steps = p.steps || [];
    const done = steps.filter(s => s.done).length;
    const last = (p.followups || []).length ? fmtDate(p.followups[p.followups.length - 1].at) : '—';
    return `<tr>
      <td>${esc(p.name)}</td>
      <td class="mono">${esc(p.phone || '—')}</td>
      <td>${p.firstSeen ? fmtDate(p.firstSeen) : '—'}</td>
      <td>${STATUS_BADGE[p.status] || esc(p.status)}</td>
      <td>${steps.length ? `${done}/${steps.length} steps` : '—'}</td>
      <td>${last}</td>
      <td><button class="btn btn-secondary btn-sm" onclick="openPerson(${p.id})">Open</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="sub">No one registered yet.</td></tr>';
}

function openPerson(id) {
  current = people.find(p => p.id === id);
  document.getElementById('pTitle').textContent = current.name;
  const steps = (current.steps || []).map(s => `
    <label style="display:flex; align-items:center; gap:10px; padding:4px 0; font-weight:400;">
      <input type="checkbox" ${s.done ? 'checked' : ''} onchange="toggleStep('${s.key}')" style="width:auto;">
      ${esc(s.label)} ${s.doneAt ? `<span class="sub">(${fmtDate(s.doneAt)})</span>` : ''}
    </label>`).join('');
  const fups = (current.followups || []).slice().reverse().map(f =>
    `<p style="margin:0 0 6px;"><span class="sub">${fmtDate(f.at)} — ${esc(f.by)}:</span> ${esc(f.note)}</p>`).join('');
  document.getElementById('pBody').innerHTML = `
    <p class="sub" style="margin:0 0 10px;">${esc(current.phone || 'no phone')} · first seen ${current.firstSeen ? fmtDate(current.firstSeen) : '—'}
      ${current.source ? ' · heard of us: ' + esc(current.source) : ''}${current.notes ? ' · ' + esc(current.notes) : ''}</p>
    <button class="btn btn-secondary btn-sm" onclick="toggleEditPerson()" style="margin-bottom:12px;">✎ Edit details</button>
    <div id="pEdit" style="display:none; border:1px solid var(--rule); border-radius:10px; padding:12px; margin-bottom:12px;">
      <div class="field-row">
        <div class="field"><label>Name</label><input type="text" id="eName" value="${esc(current.name || '')}"></div>
        <div class="field"><label>Phone</label><input type="tel" id="ePhone" value="${esc(current.phone || '')}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Email</label><input type="email" id="eEmail" value="${esc(current.email || '')}"></div>
        <div class="field"><label>Day born</label><input type="text" id="eDayBorn" value="${esc(current.dayBorn || '')}" placeholder="e.g. Wednesday"></div>
      </div>
      <div class="field" style="max-width:200px;"><label>First seen</label><input type="date" id="eFirstSeen" value="${esc((current.firstSeen || '').slice(0, 10))}"></div>
      <div class="field"><label>How they heard of us</label><input type="text" id="eSource" value="${esc(current.source || '')}"></div>
      <div class="field"><label>Notes</label><textarea id="eNotes" rows="2">${esc(current.notes || '')}</textarea></div>
      <button class="btn btn-primary btn-sm" onclick="savePerson()">Save changes</button>
      <button class="btn btn-secondary btn-sm" onclick="toggleEditPerson()">Cancel</button>
    </div>
    ${current.status === 'visitor' ? `<button class="btn btn-primary btn-sm" onclick="convert()" style="margin-bottom:12px;">They are joining us → start engagement track</button>` : ''}
    ${steps ? `<div class="section-title"><h3>Engagement track</h3></div>${steps}` : ''}
    <div class="section-title" style="margin-top:12px;"><h3>Follow-ups</h3></div>
    <div style="max-height:150px; overflow-y:auto;">${fups || '<p class="sub">None logged yet.</p>'}</div>
    <div style="display:flex; gap:8px; margin-top:10px;">
      <input type="text" id="fupNote" placeholder="e.g. Called — will attend orientation Sunday" style="flex:1;">
      <button class="btn btn-secondary" onclick="addFollowup()">Log follow-up</button>
    </div>`;
  document.getElementById('pOverlay').style.display = 'flex';
}

// Show/hide the inline edit panel on the person view.
function toggleEditPerson() {
  const el = document.getElementById('pEdit');
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none';
}

// Save edited details for a visitor / new member.
async function savePerson() {
  const v = id => (document.getElementById(id) || {}).value || '';
  try {
    await api(`/visitors/${current.id}`, { method: 'PUT', body: {
      name: v('eName').trim(),
      phone: v('ePhone').trim(),
      email: v('eEmail').trim(),
      dayBorn: v('eDayBorn').trim(),
      source: v('eSource').trim(),
      notes: v('eNotes').trim(),
      firstSeen: v('eFirstSeen') || undefined,
    } });
    toast('Details updated');
    refreshPerson();
  } catch (e) { toast(e.message, true); }
}

async function refreshPerson() {
  await load();
  if (current) { const fresh = people.find(p => p.id === current.id); if (fresh) openPerson(fresh.id); }
}
async function toggleStep(key) {
  try { await api(`/visitors/${current.id}/steps/${key}/toggle`, { method: 'POST' }); refreshPerson(); }
  catch (e) { toast(e.message, true); }
}
async function convert() {
  try { await api(`/visitors/${current.id}`, { method: 'PUT', body: { status: 'new-member' } }); toast('Engagement track started'); refreshPerson(); }
  catch (e) { toast(e.message, true); }
}
async function addFollowup() {
  const note = document.getElementById('fupNote').value.trim();
  if (!note) return;
  try { await api(`/visitors/${current.id}/followups`, { method: 'POST', body: { note } }); refreshPerson(); }
  catch (e) { toast(e.message, true); }
}

document.getElementById('regForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/visitors', { method: 'POST', body: {
      name: document.getElementById('vName').value,
      phone: document.getElementById('vPhone').value,
      email: document.getElementById('vEmail').value,
      type: document.getElementById('vType').value,
      firstSeen: document.getElementById('vDate').value,
      source: document.getElementById('vSource').value,
      notes: document.getElementById('vNotes').value,
    } });
    toast('Registered — welcome SMS sent if a phone was given');
    document.getElementById('regOverlay').style.display = 'none';
    load();
  } catch (err) { toast(err.message, true); }
});
document.getElementById('regCancelBtn').onclick = () => document.getElementById('regOverlay').style.display = 'none';
document.getElementById('pCloseBtn').onclick = () => document.getElementById('pOverlay').style.display = 'none';
document.getElementById('addBtn').onclick = () => {
  document.getElementById('regForm').reset();
  document.getElementById('vDate').value = todayInputValue();
  document.getElementById('regOverlay').style.display = 'flex';
};

requireAuthAndRenderShell().then(u => { me = u; load(); });
