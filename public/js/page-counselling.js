// Counselling page (Phase 9, CFL — confidential).
let me, cases = [], counsellors = [], current = null;
const BADGE = { open: '<span class="badge badge-attention">open</span>', 'in-progress': '<span class="badge badge-progress">in progress</span>', completed: '<span class="badge badge-done">completed</span>' };

async function load() {
  [cases, counsellors] = await Promise.all([api('/counselling/cases'), api('/counselling/counsellors')]);
  document.getElementById('caseRows').innerHTML = cases.map(k => `<tr>
    <td class="mono">#${k.id} · ${esc(k.type)}</td>
    <td>${esc(k.clients)}</td>
    <td>${esc(k.counsellorName || '—')}</td>
    <td class="mono">${(k.sessions || []).length}</td>
    <td>${BADGE[k.status] || esc(k.status)}</td>
    <td style="white-space:nowrap;"><button class="btn btn-secondary btn-sm" onclick="openCase(${k.id})">Open</button>${isElevated(me) ? ` <button class="btn btn-danger btn-sm" onclick="delCase(${k.id})">Delete</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="sub">No cases yet.</td></tr>';
  document.getElementById('cRows').innerHTML = counsellors.map(c => `<tr>
    <td>${esc(c.name)}</td><td class="sub">${esc(c.specialties || '')}</td>
    <td class="mono">${esc(c.phone || c.email || '—')}</td>
    <td style="white-space:nowrap;">${isElevated(me) ? `<button class="btn btn-secondary btn-sm" onclick="editCounsellor(${c.id})">Edit</button> <button class="btn btn-danger btn-sm" onclick="delCounsellor(${c.id})">Remove</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="4" class="sub">No counsellors yet — an admin adds them below.</td></tr>';
}

function openCase(id) {
  current = cases.find(k => k.id === id);
  document.getElementById('dTitle').textContent = `Case #${current.id} — ${current.type}`;
  const sessions = (current.sessions || []).slice().reverse().map(s =>
    `<p style="margin:0 0 6px;"><span class="sub">${fmtDate(s.date)} — ${esc(s.by)}:</span> ${esc(s.note)}</p>`).join('');
  document.getElementById('dBody').innerHTML = `
    <p style="margin:0 0 4px;"><b>${esc(current.clients)}</b> ${current.phone ? `<span class="mono sub">· ${esc(current.phone)}</span>` : ''}
      ${current.status !== 'completed' ? '<button class="btn btn-secondary btn-sm" onclick="editCase()" style="margin-left:6px;">✎ Edit details</button>' : ''}</p>
    ${current.notes ? `<p class="sub" style="margin:0 0 10px;">${esc(current.notes)}</p>` : ''}
    ${current.status !== 'completed' ? `
      <div style="display:flex; gap:8px; align-items:center; margin:10px 0;">
        <select id="assignSel" style="max-width:240px;">
          <option value="">— assign counsellor —</option>
          ${counsellors.map(c => `<option value="${c.id}" ${current.counsellorId === c.id ? 'selected' : ''}>${esc(c.name)}${c.specialties ? ' (' + esc(c.specialties) + ')' : ''}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-sm" onclick="assign()">Assign</button>
      </div>` : `<p class="sub">Signed off${current.signOff ? ': ' + esc(current.signOff) : ''} on ${fmtDate(current.completedAt)}.</p>`}
    <div class="section-title" style="margin-top:8px;"><h3>Sessions</h3></div>
    <div style="max-height:150px; overflow-y:auto;">${sessions || '<p class="sub">No sessions logged.</p>'}</div>
    ${current.status !== 'completed' ? `
      <div style="display:flex; gap:8px; margin-top:10px;">
        <input type="date" id="sessDate" style="max-width:160px;">
        <input type="text" id="sessNote" placeholder="Session note" style="flex:1;">
        <button class="btn btn-secondary" onclick="addSession()">Log</button>
      </div>
      <div style="display:flex; gap:8px; margin-top:14px;">
        <input type="text" id="signOff" placeholder="Sign-off note (e.g. couple ready for marriage)" style="flex:1;">
        <button class="btn btn-primary" onclick="complete()">Complete &amp; sign off</button>
      </div>` : ''}`;
  const sd = document.getElementById('sessDate');
  if (sd) sd.value = todayInputValue();
  document.getElementById('dOverlay').style.display = 'flex';
}

async function refresh() { await load(); if (current) { const f = cases.find(k => k.id === current.id); if (f) openCase(f.id); } }
async function assign() {
  const cid = document.getElementById('assignSel').value;
  if (!cid) return;
  try { await api(`/counselling/cases/${current.id}/assign`, { method: 'POST', body: { counsellorId: cid } }); toast('Assigned — counsellor notified'); refresh(); }
  catch (e) { toast(e.message, true); }
}
async function addSession() {
  const note = document.getElementById('sessNote').value.trim();
  if (!note) return;
  try { await api(`/counselling/cases/${current.id}/sessions`, { method: 'POST', body: { note, date: document.getElementById('sessDate').value } }); refresh(); }
  catch (e) { toast(e.message, true); }
}
async function complete() {
  if (!await confirmDialog('Complete and sign off this case?')) return;
  try { await api(`/counselling/cases/${current.id}/complete`, { method: 'POST', body: { signOff: document.getElementById('signOff').value } }); toast('Case completed'); refresh(); }
  catch (e) { toast(e.message, true); }
}
// Admin-only: permanently delete a case (for mistakes and training/test cases).
// The backend restricts this to administrators and keeps a snapshot in the log.
async function delCase(id) {
  const k = cases.find(x => x.id === id);
  const label = k ? `#${k.id} — ${k.clients}` : `#${id}`;
  if (!await confirmDialog(`Permanently delete counselling case ${label}? This cannot be undone.`)) return;
  try {
    await api(`/counselling/cases/${id}`, { method: 'DELETE' });
    toast('Case deleted');
    if (current && current.id === id) document.getElementById('dOverlay').style.display = 'none';
    load();
  } catch (e) { toast(e.message, true); }
}
async function delCounsellor(id) {
  if (!await confirmDialog('Remove this counsellor from the list?')) return;
  try { await api(`/counselling/counsellors/${id}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, true); }
}

// Correct a counsellor's details — a wrong phone misroutes the assignment SMS.
async function editCounsellor(id) {
  const c = counsellors.find(x => x.id === id);
  if (!c) return;
  const out = await formDialog('Edit counsellor', [
    { name: 'name', label: 'Name', value: c.name || '' },
    { name: 'phone', label: 'Phone', value: c.phone || '' },
    { name: 'email', label: 'Email', value: c.email || '' },
    { name: 'specialties', label: 'Specialties', value: c.specialties || '' },
  ]);
  if (!out) return;
  try {
    await api(`/counselling/counsellors/${id}`, { method: 'PUT', body: {
      name: out.name, phone: out.phone, email: out.email, specialties: out.specialties,
    } });
    toast('Counsellor updated'); load();
  } catch (e) { toast(e.message, true); }
}

// Correct a case's details (locked once completed).
async function editCase() {
  if (!current) return;
  const out = await formDialog('Edit case details', [
    { name: 'clients', label: 'Client name(s)', value: current.clients || '' },
    { name: 'phone', label: 'Phone', value: current.phone || '' },
    { name: 'notes', label: 'Notes', value: current.notes || '', multiline: true },
  ]);
  if (!out) return;
  try {
    await api(`/counselling/cases/${current.id}`, { method: 'PUT', body: {
      clients: out.clients, phone: out.phone, notes: out.notes,
    } });
    toast('Case updated');
    await load();
    const fresh = cases.find(k => k.id === current.id);
    if (fresh) openCase(fresh.id);
  } catch (e) { toast(e.message, true); }
}

document.getElementById('caseForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/counselling/cases', { method: 'POST', body: {
      type: document.getElementById('kType').value,
      clients: document.getElementById('kClients').value,
      phone: document.getElementById('kPhone').value,
      notes: document.getElementById('kNotes').value,
    } });
    toast('Case opened');
    document.getElementById('caseOverlay').style.display = 'none';
    load();
  } catch (err) { toast(err.message, true); }
});
document.getElementById('addCounsellorBtn').onclick = async () => {
  try {
    await api('/counselling/counsellors', { method: 'POST', body: {
      name: document.getElementById('cName').value, specialties: document.getElementById('cSpec').value,
      phone: document.getElementById('cPhone').value, email: document.getElementById('cEmail').value,
    } });
    toast('Counsellor added');
    ['cName', 'cSpec', 'cPhone', 'cEmail'].forEach(id => document.getElementById(id).value = '');
    load();
  } catch (e) { toast(e.message, true); }
};
document.getElementById('caseCancelBtn').onclick = () => document.getElementById('caseOverlay').style.display = 'none';
document.getElementById('dCloseBtn').onclick = () => document.getElementById('dOverlay').style.display = 'none';
document.getElementById('addCaseBtn').onclick = () => { document.getElementById('caseForm').reset(); document.getElementById('caseOverlay').style.display = 'flex'; };

requireAuthAndRenderShell().then(u => {
  me = u;
  if (isElevated(me)) document.getElementById('addCounsellorRow').style.display = '';
  load();
});
