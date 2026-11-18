// Access Requests page.
// A Coordinator (users.request) can (a) propose a NEW person for an account, or
// (b) request ADDITIONAL committees/groups for an EXISTING person. An
// administrator or the Session Clerk approves. On approval a new person's
// account is created (initial password sent by SMS + email) plus a linked
// workspace per extra committee/group; for an existing person the extra
// committees/groups are added as linked workspaces (no new login/password).
let me, requests = [], COMS = [], GRPS = [], PEOPLE = [], approving = null;

// Access levels a request may propose (admin/local-admin excluded). The
// committee/group office holders all carry the same entity-scoped access
// ('secretary'); value encodes "role::defaultPosition".
const REQUESTABLE_ROLES = [
  { value: 'secretary::Secretary', role: 'secretary', position: 'Secretary', label: 'Secretary — committee/group office' },
  { value: 'secretary::Chairperson', role: 'secretary', position: 'Chairperson', label: 'Chairperson — committee/group office' },
  { value: 'secretary::Coordinator', role: 'secretary', position: 'Coordinator', label: 'Coordinator — committee/group office' },
  { value: 'secretary::President', role: 'secretary', position: 'President', label: 'President — committee/group office' },
  { value: 'coordinator::', role: 'coordinator', position: '', label: 'Reporting Coordinator — works across all committees/groups' },
  { value: 'attendance::', role: 'attendance', position: '', label: 'Attendance Officer — Sunday-service attendance' },
  { value: 'treasurer::', role: 'treasurer', position: '', label: 'Treasurer — congregation office, approves fundraising figures' },
  { value: 'accounts::', role: 'accounts', position: '', label: 'Accounts Clerk — congregation office, verifies fundraising figures' },
  { value: 'clerk::', role: 'clerk', position: '', label: 'Session Clerk — approvals & setup' },
  { value: 'viewer::', role: 'viewer', position: '', label: 'Viewer — read-only' },
];
// Role display names come from ROLE_LABELS in app.js — one map for the whole
// application. (This file used to keep its own, which drifted: "Secretary
// access", "Admin", "Local Admin".)
const POSITION_OPTIONS = ['Chairperson', 'President', 'Coordinator', 'Secretary', 'Asst. Secretary'];
const STATUS_BADGE = {
  pending: '<span class="badge badge-progress">Awaiting approval</span>',
  approved: '<span class="badge badge-done">Approved</span>',
  declined: '<span class="badge badge-idle">Declined</span>',
};

function canRequest() { return isElevated(me) || (me.permissions || []).includes('users.request') || (me.permissions || []).includes('staff.manage'); }
function canApprove() { return isElevated(me) || (me.permissions || []).includes('staff.manage') || (me.permissions || []).includes('approvals.manage'); }

function entityLabel(ent) {
  if (!ent || ent.type === 'congregation') return 'Congregation-wide';
  const rec = (ent.type === 'committee' ? COMS : GRPS).find(x => x.id === Number(ent.id));
  return rec ? rec.name : `${ent.type === 'committee' ? 'Committee' : 'Group'} #${ent.id}`;
}

// Assignments carried by a request (array), with a fallback to the old single fields.
function reqAssignments(r) {
  if (Array.isArray(r.assignments) && r.assignments.length) return r.assignments;
  return [{ role: r.role, position: r.position, entity: r.entity }];
}
function assignmentsSummary(r) {
  return reqAssignments(r).map(a => {
    const place = entityLabel(a.entity);
    const title = a.position ? `${a.position}` : roleLabel(a.role);
    return `${esc(place)} <span class="sub">(${esc(title)})</span>`;
  }).join('<br>');
}

// ---- Option HTML builders (shared by every assignment row) ----
function roleOptsHtml() {
  return '<option value="">— access level —</option>' + REQUESTABLE_ROLES.map(r => `<option value="${r.value}">${esc(r.label)}</option>`).join('');
}
function entityOptsHtml() {
  return '<option value="">None (congregation-wide)</option>'
    + COMS.map(c => `<option value="committee:${c.id}">Committee — ${esc(c.name)}</option>`).join('')
    + GRPS.map(g => `<option value="group:${g.id}">Group — ${esc(g.name)}</option>`).join('');
}
function positionOptsHtml() {
  return '<option value="">— position —</option>' + POSITION_OPTIONS.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('') + '<option value="__other">Other…</option>';
}

async function load() {
  [COMS, GRPS, requests, PEOPLE] = await Promise.all([
    api('/setup/committees').catch(() => []),
    api('/setup/groups').catch(() => []),
    api('/auth/access-requests').catch(() => []),
    api('/auth/access-people').catch(() => []),
  ]);
  const personSel = document.getElementById('rPerson');
  personSel.innerHTML = '<option value="">— choose person —</option>'
    + PEOPLE.map(p => `<option value="${p.id}">${esc(p.name)}${p.email ? ' · ' + esc(p.email) : ''}</option>`).join('');
  render();
}

function render() {
  const approver = canApprove();
  document.getElementById('rows').innerHTML = requests.map(r => {
    const kindLabel = r.kind === 'add-workspace' ? 'Add committee/group' : 'New account';
    const contact = [r.phone, r.email].filter(Boolean).join(' · ');
    let actions = '';
    if (approver && r.status === 'pending') {
      actions = `<button class="btn btn-primary btn-sm" onclick="openApprove(${r.id})">Approve</button>
                 <button class="btn btn-secondary btn-sm" onclick="declineReq(${r.id})">Decline</button>`;
    } else if (r.status === 'declined' && r.reason) {
      actions = `<span class="sub" title="${esc(r.reason)}">Reason</span>`;
    }
    return `<tr>
      <td>${esc(r.name)}<div class="sub" style="font-size:11.5px;">by ${esc(r.requestedBy || '')}</div></td>
      <td>${esc(kindLabel)}</td>
      <td>${assignmentsSummary(r)}</td>
      <td class="mono">${esc(contact || '—')}</td>
      <td>${STATUS_BADGE[r.status] || esc(r.status)}</td>
      <td style="white-space:nowrap;">${actions}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="6" class="sub">No access requests yet.</td></tr>`;
}

// ---- Assignment rows ----
function addAssignRow(preset) {
  const wrap = document.getElementById('assignRows');
  const row = document.createElement('div');
  row.className = 'assign-row';
  row.innerHTML = `
    <div class="assign-head"><span class="sub">Committee / Group</span>
      <button type="button" class="btn btn-secondary btn-sm a-remove">Remove</button></div>
    <div class="field-row">
      <div class="field"><label>Access level</label><select class="a-role">${roleOptsHtml()}</select></div>
      <div class="field"><label>Committee / Group</label><select class="a-entity">${entityOptsHtml()}</select></div>
    </div>
    <div class="field"><label>Position / title</label><select class="a-position">${positionOptsHtml()}</select>
      <input class="a-position-other" type="text" placeholder="Type the position / title" style="display:none; margin-top:8px;"></div>`;
  wrap.appendChild(row);
  if (preset && preset.role) row.querySelector('.a-role').value = preset.role;
  updateRemoveButtons();
}
function updateRemoveButtons() {
  const rows = [...document.querySelectorAll('#assignRows .assign-row')];
  rows.forEach(r => { const b = r.querySelector('.a-remove'); if (b) b.style.visibility = rows.length > 1 ? 'visible' : 'hidden'; });
}
// Delegated handlers for the rows.
document.getElementById('assignRows').addEventListener('change', e => {
  const row = e.target.closest('.assign-row');
  if (!row) return;
  if (e.target.classList.contains('a-position')) {
    const other = row.querySelector('.a-position-other');
    const isOther = e.target.value === '__other';
    other.style.display = isOther ? '' : 'none';
    if (!isOther) other.value = '';
  }
  if (e.target.classList.contains('a-role')) {
    const opt = REQUESTABLE_ROLES.find(x => x.value === e.target.value);
    const posSel = row.querySelector('.a-position');
    if (opt && opt.position && !posSel.value && POSITION_OPTIONS.includes(opt.position)) posSel.value = opt.position;
  }
});
document.getElementById('assignRows').addEventListener('click', e => {
  if (e.target.classList.contains('a-remove')) {
    const rows = document.querySelectorAll('#assignRows .assign-row');
    if (rows.length > 1) { e.target.closest('.assign-row').remove(); updateRemoveButtons(); }
  }
});
document.getElementById('addAssignBtn').onclick = () => addAssignRow();

function readAssignments() {
  return [...document.querySelectorAll('#assignRows .assign-row')].map(row => {
    const opt = REQUESTABLE_ROLES.find(x => x.value === row.querySelector('.a-role').value);
    if (!opt) return null;
    let position = row.querySelector('.a-position').value;
    if (position === '__other') position = row.querySelector('.a-position-other').value.trim();
    if (!position) position = opt.position;
    const entSel = row.querySelector('.a-entity').value;
    const entity = entSel ? { type: entSel.split(':')[0], id: Number(entSel.split(':')[1]) } : null;
    return { role: opt.role, position, entity };
  }).filter(Boolean);
}

// ---- Request type toggle ----
function applyKind() {
  const kind = document.getElementById('rKind').value;
  document.getElementById('newPersonFields').style.display = kind === 'add-workspace' ? 'none' : '';
  document.getElementById('existingPersonField').style.display = kind === 'add-workspace' ? '' : 'none';
}
document.getElementById('rKind').addEventListener('change', applyKind);
document.getElementById('rPerson').addEventListener('change', e => {
  const p = PEOPLE.find(x => String(x.id) === e.target.value);
  const hint = document.getElementById('rPersonHint');
  hint.textContent = p && p.entities && p.entities.length
    ? 'Already holds: ' + p.entities.map(entityLabel).join(', ')
    : (p ? 'No committee/group yet.' : '');
});

// ---- Submit ----
document.getElementById('requestForm').addEventListener('submit', async e => {
  e.preventDefault();
  const kind = document.getElementById('rKind').value;
  const assignments = readAssignments();
  if (!assignments.length) { toast('Add at least one committee/group with an access level.', true); return; }
  const body = { kind, assignments, notes: document.getElementById('rNotes').value.trim() };
  if (kind === 'add-workspace') {
    body.targetUserId = Number(document.getElementById('rPerson').value);
    if (!body.targetUserId) { toast('Choose the existing person.', true); return; }
    if (assignments.some(a => !a.entity)) { toast('Each added workspace must be a committee or group.', true); return; }
  } else {
    body.name = document.getElementById('rName').value.trim();
    body.email = document.getElementById('rEmail').value.trim();
    body.phone = document.getElementById('rPhone').value.trim();
    if (!body.name || !body.email) { toast('Name and email are required.', true); return; }
  }
  try {
    await api('/auth/access-requests', { method: 'POST', body });
    toast('Submitted for approval');
    document.getElementById('requestOverlay').style.display = 'none';
    load();
  } catch (err) { toast(err.message, true); }
});

// ---- Approve ----
function openApprove(id) {
  const r = requests.find(x => x.id === id);
  if (!r) return;
  approving = r;
  const isNew = r.kind !== 'add-workspace';
  document.getElementById('approveTitle').textContent = isNew ? 'Approve — create account' : 'Approve — add committee/group';
  document.getElementById('approveDetails').innerHTML =
    `<b>${esc(r.name)}</b>${isNew && (r.phone || r.email) ? `<br>${esc([r.phone, r.email].filter(Boolean).join(' · '))}` : ''}`
    + `<br>${assignmentsSummary(r)}`
    + (r.notes ? `<br><span class="sub">Note: ${esc(r.notes)}</span>` : '');
  // Password only needed when creating a brand-new account.
  document.getElementById('approvePwWrap').style.display = isNew ? '' : 'none';
  document.getElementById('initPassword').value = '';
  document.getElementById('initPwMeter').innerHTML = passwordChecklistHtml('');
  document.getElementById('approveOverlay').style.display = 'flex';
}

function genPassword() {
  const U = 'ABCDEFGHJKLMNPQRSTUVWXYZ', L = 'abcdefghijkmnpqrstuvwxyz', D = '23456789', S = '@#$%&*';
  const pick = set => set[Math.floor(Math.random() * set.length)];
  let core = '';
  for (let i = 0; i < 6; i++) core += pick(L);
  return `${pick(U)}${core}-${pick(D)}${pick(D)}${pick(D)}${pick(S)}`;
}
document.getElementById('genPwBtn').onclick = () => {
  const input = document.getElementById('initPassword');
  input.value = genPassword();
  input.dispatchEvent(new Event('input'));
};

document.getElementById('approveConfirmBtn').onclick = async () => {
  if (!approving) return;
  const isNew = approving.kind !== 'add-workspace';
  const body = {};
  if (isNew) {
    body.password = document.getElementById('initPassword').value;
    if (!body.password) { toast('Set or generate an initial password first.', true); return; }
  }
  try {
    await api(`/auth/access-requests/${approving.id}/approve`, { method: 'POST', body });
    toast(isNew ? 'Approved — account created and login details sent' : 'Approved — committee/group added');
    document.getElementById('approveOverlay').style.display = 'none';
    load();
  } catch (err) {
    toast(err.message + (err.failedRules ? ' ' + err.failedRules.join(', ') : ''), true);
  }
};

async function declineReq(id) {
  const reason = await promptDialog('Reason for declining (optional):', { title: 'Decline request', multiline: true, okText: 'Decline', placeholder: 'Optional note to the requester' });
  if (reason === null) return;
  try {
    await api(`/auth/access-requests/${id}/decline`, { method: 'POST', body: { reason } });
    toast('Request declined');
    load();
  } catch (err) { toast(err.message, true); }
}

// ---- Open / close ----
document.getElementById('requestBtn').onclick = () => {
  document.getElementById('requestForm').reset();
  document.getElementById('assignRows').innerHTML = '';
  addAssignRow();
  applyKind();
  document.getElementById('rPersonHint').textContent = '';
  document.getElementById('requestOverlay').style.display = 'flex';
};
document.getElementById('requestCancelBtn').onclick = () => document.getElementById('requestOverlay').style.display = 'none';
document.getElementById('approveCancelBtn').onclick = () => document.getElementById('approveOverlay').style.display = 'none';

requireAuthAndRenderShell('/access.html').then(u => {
  me = u;
  if (!me) return;
  if (!canRequest() && !canApprove()) { location.href = '/index.html'; return; }
  if (canRequest()) document.getElementById('requestBtn').style.display = '';
  if (canApprove() && !canRequest()) document.getElementById('subLabel').textContent = 'Review and approve platform access requests';
  wirePasswordMeter(document.getElementById('initPassword'), document.getElementById('initPwMeter'));
  load();
});
