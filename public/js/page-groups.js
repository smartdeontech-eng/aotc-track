// Committees page — list, rosters, roster-request flow (Phase 1).
let me, committees = []  // groups, reusing variable names, membersCache = {}, currentCommittee = null;
let memberMode = 'add'; // 'add' (admin) | 'coopt' (secretary request) | 'contact' (secretary request)
let contactMemberId = null;

// Oct 2026: 'setup.manage' was split. Creating / renaming / archiving a
// group is 'setup.structure'; editing any roster is 'roster.manage'. Must
// match routes/setup.js.
function canStructure() { return isElevated(me) || (me.permissions || []).includes('setup.structure'); }
function canRosterAll() { return isElevated(me) || (me.permissions || []).includes('roster.manage'); }
// Admin/setup.manage and the Reporting Coordinator edit contacts DIRECTLY
// (no Session-Clerk approval needed) — everyone else proposes.
function canDirectContact() { return canRosterAll() || (me.permissions || []).includes('congregation.manage'); }
function canApprove() { return isElevated(me) || (me.permissions || []).includes('approvals.manage'); }
function canPropose() { return (me.permissions || []).includes('roster.propose') && me.entity && me.entity.type === 'group'; }
// A group account may directly manage ITS OWN group's roster (self-managed
// pilot); admins / roster.manage may manage any.
function canManageOwn(id) { return canRosterAll() || (me.entity && me.entity.type === 'group' && Number(me.entity.id) === Number(id)); }

async function load() {
  committees = await api('/setup/groups');
  if (window.myEntity && window.myEntity.type === 'group') {
    const h1 = document.querySelector('.page-header h1');
    if (h1) h1.textContent = window.myEntity.name;
    document.getElementById('countLabel').textContent = 'Group workspace';
  } else {
    document.getElementById('countLabel').textContent = `${committees.length} groups`;
  }
  document.getElementById('rows').innerHTML = committees.map(c => {
    const head = c.signatories && c.signatories.head ? c.signatories.head.name : '—';
    const sec = c.signatories && c.signatories.secretary ? c.signatories.secretary.name : '—';
    return `<tr>
      <td>${esc(c.name)}</td>
      <td class="mono">${esc(c.code)}</td>
      <td>${c.type === 'generational' ? 'Generational' : 'Non-generational'}</td>
      <td>${esc(c.meetingDay || '—')}</td>
      <td>${esc(head)}</td><td>${esc(sec)}</td>
      <td><button class="btn btn-secondary btn-sm" onclick="openRoster(${c.id})">Members</button>
          ${canStructure() ? `<button class="btn btn-secondary btn-sm" onclick="editCommittee(${c.id})">Edit</button> <button class="btn btn-danger btn-sm" onclick="archiveGroup(${c.id}, '${esc(c.name).replace(/'/g, "\\'")}')">Archive</button>` : ''}</td>
    </tr>`;
  }).join('');
  if (canApprove()) loadRequests();
  if (canStructure()) loadArchived();
}

async function loadRequests() {
  const reqs = (await api('/setup/roster-requests')).filter(r => r.status === 'pending' && r.entityType === 'group');
  const card = document.getElementById('requestsCard');
  if (!reqs.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  document.getElementById('requestRows').innerHTML = reqs.map(r => {
    const com = committees.find(c => c.id === Number(r.entityId));
    return `<tr>
      <td>${r.type === 'co-opt' ? 'Co-opt member' : 'Contact update'}</td>
      <td>${com ? esc(com.name) : r.entityId}</td>
      <td>${esc(r.memberName || '')}</td>
      <td class="mono">${esc(r.phone || '')} ${esc(r.email || '')}</td>
      <td>${esc(r.requestedBy || '')}</td>
      <td><button class="btn btn-primary btn-sm" onclick="decideRequest(${r.id},'approve')">Approve</button>
          <button class="btn btn-danger btn-sm" onclick="decideRequest(${r.id},'decline')">Decline</button></td>
    </tr>`;
  }).join('');
}

async function decideRequest(id, action) {
  try { await api(`/setup/roster-requests/${id}/${action}`, { method: 'POST' }); toast(`Request ${action}d`); load(); }
  catch (e) { toast(e.message, true); }
}

async function openRoster(id) {
  currentCommittee = committees.find(c => c.id === id);
  document.getElementById('rosterTitle').textContent = `${currentCommittee.name} — Members`;
  const members = (await api(`/setup/members?entityType=group&entityId=${id}`))
    .sort((a, b) => ((a.position === 'Member') - (b.position === 'Member')) || (a.name || '').localeCompare(b.name || ''));
  const att = await api(`/meetings/attendance-summary?entityType=group&entityId=${id}`).catch(() => null);
  const stat = {};
  if (att) att.perMember.forEach(m => { stat[m.memberId] = m; });
  const flagBadge = s => s && s.flag === 'red'
    ? ` <span class="badge badge-critical" title="Absent ${s.consecutiveAbsences} consecutive meetings without apology">⚠ absence</span>`
    : s && s.flag === 'amber' ? ` <span class="badge badge-progress" title="Low attendance this year">low</span>` : '';
  document.getElementById('rosterRows').innerHTML = members.map(m => `<tr>
    <td class="mono">${esc(m.memberNo || '—')}</td>
    <td>${esc(m.name)}${m.coopted ? ' <span class="badge badge-progress">co-opted</span>' : ''}${flagBadge(stat[m.id])}</td>
    <td>${esc(m.position || 'Member')}</td>
    <td class="mono">${esc(m.phone || '—')}</td>
    <td>${esc(m.email || '—')}</td>
    <td>${canManageOwn(id) ? `<button class="btn btn-secondary btn-sm" onclick="directContact(${m.id}, '${esc(m.name).replace(/'/g, "\\'")}', '${m.sex || ''}', '${esc(m.position || '').replace(/'/g, "\\'")}')">Edit</button>` : canPropose() && Number(me.entity.id) === id ? `<button class="btn btn-secondary btn-sm" onclick="proposeContact(${m.id}, '${esc(m.name).replace(/'/g, "\\'")}')">Update contact</button>` : ''}
        ${canManageOwn(id) ? `<button class="btn btn-danger btn-sm" onclick="removeMember(${m.id})">Remove</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="6" class="sub">No members yet.</td></tr>';
  const sumEl = document.getElementById('rosterAttSummary');
  if (sumEl) sumEl.innerHTML = att && att.count
    ? `Attendance (this year): ${att.count} meeting(s) held. ${att.flagged.length ? `<b style="color:var(--pcg-red);">${att.flagged.length} member(s) flagged for attention.</b>` : 'No attendance concerns.'}`
    : '';
  document.getElementById('addMemberBtn').style.display = canManageOwn(id) ? '' : 'none';
  // Propose-co-opt is only for groups that can't add directly; a self-managing
  // group adds members itself, so hide it for them.
  document.getElementById('proposeCooptBtn').style.display = (canPropose() && Number(me.entity.id) === id && !canManageOwn(id)) ? '' : 'none';
  // Print QR cards: admins / roster managers, or this group's own account.
  const cardsBtn = document.getElementById('rosterCardsBtn');
  cardsBtn.style.display = canManageOwn(id) ? '' : 'none';
  cardsBtn.onclick = () => printMemberCards('group', id, currentCommittee ? currentCommittee.name : '');
  document.getElementById('rosterOverlay').style.display = 'flex';
}

async function removeMember(id) {
  if (!await confirmDialog('Remove this member from the roster?')) return;
  try { await api(`/setup/members/${id}`, { method: 'DELETE' }); toast('Member removed'); openRoster(currentCommittee.id); load(); }
  catch (e) { toast(e.message, true); }
}

function openMemberModal(mode, title, note) {
  memberMode = mode;
  document.getElementById('memberTitle').textContent = title;
  document.getElementById('memberForm').reset();
  document.getElementById('memberNote').style.display = note ? '' : 'none';
  document.getElementById('mName').disabled = false;
  // Sex applies when adding/co-opting a member or when an admin edits one —
  // not on a group's contact-only update.
  document.getElementById('mSexField').style.display = (mode === 'contact') ? 'none' : '';
  // Photo applies when adding directly or an admin editing; not for co-opt
  // requests / contact updates (those flows don't carry a photo).
  const pf = document.getElementById('mPhotoField');
  if (pf) pf.style.display = (mode === 'add' || mode === 'direct') ? '' : 'none';
  resetMemberPhotoField();
  document.getElementById('memberOverlay').style.display = 'flex';
}

function proposeContact(memberId, name) {
  contactMemberId = memberId;
  openMemberModal('contact', `Update contact — ${name}`, true);
  document.getElementById('mName').value = name;
  document.getElementById('mName').disabled = true;
}

// Direct contact edit (admin / setup.manage / Reporting Coordinator) —
// saves immediately, no approval round-trip.
function directContact(memberId, name, sex, position) {
  contactMemberId = memberId;
  openMemberModal('direct', `Edit member — ${name}`, false);
  document.getElementById('mName').value = name;
  // An admin/setup editor may correct a misspelt name — the member's identity
  // (memberNo / QR card) is separate and stays untouched.
  document.getElementById('mName').disabled = false;
  document.getElementById('mSex').value = sex || '';
  document.getElementById('mPosition').value = position || 'Member';
  showMemberPhotoFor(memberId);
}

document.getElementById('memberForm').addEventListener('submit', async e => {
  e.preventDefault();
  const body = {
    name: document.getElementById('mName').value.trim(),
    sex: document.getElementById('mSex').value,
    phone: document.getElementById('mPhone').value.trim(),
    email: document.getElementById('mEmail').value.trim(),
    position: document.getElementById('mPosition').value.trim() || 'Member',
    photo: getMemberPhoto(),
  };
  if ((memberMode === 'add' || memberMode === 'coopt') && !body.sex) {
    toast('Please select Male or Female for the member.', true); return;
  }
  try {
    if (memberMode === 'add') {
      await api('/setup/members', { method: 'POST', body: { ...body, entityType: 'group', entityId: currentCommittee.id } });
      toast('Member added');
    } else if (memberMode === 'direct') {
      // Send name and photo too — the form collects both, and omitting them
      // made the photo picker a silent no-op and froze misspelt names.
      await api(`/setup/members/${contactMemberId}`, { method: 'PUT', body: {
        name: body.name, phone: body.phone, email: body.email,
        sex: body.sex, position: body.position, photo: body.photo,
      } });
      toast('Member updated');
    } else if (memberMode === 'coopt') {
      await api('/setup/roster-requests', { method: 'POST', body: { type: 'co-opt', ...body } });
      toast('Co-opt request sent to the Session Clerk');
    } else {
      await api('/setup/roster-requests', { method: 'POST', body: { type: 'contact-update', memberId: contactMemberId, phone: body.phone, email: body.email } });
      toast('Contact update sent to the Session Clerk');
    }
    document.getElementById('memberOverlay').style.display = 'none';
    if (currentCommittee) openRoster(currentCommittee.id);
  } catch (err) { toast(err.message, true); }
});

// ---- committee add/edit (admin) ----
let editingId = null;
// Archive a wound-up group: drops out of lists/reports, history kept.
// Archived groups, with Restore. Archiving used to be one-way: there was no
// way back in the app, so on 4 Oct 2026 an archived Church Choir was simply
// re-created and the board showed two. Restoring brings back the same record,
// so its goals, members, reports and history come back with it.
async function loadArchived() {
  const card = document.getElementById('archivedCard');
  if (!card) return;
  const list = await api('/setup/groups/archived').catch(() => []);
  card.style.display = list.length ? '' : 'none';
  document.getElementById('archivedRows').innerHTML = list.map(c => `<tr>
    <td>${esc(c.name)}</td><td class="mono">${esc(c.code)}</td>
    <td style="text-align:right;"><button class="btn btn-secondary btn-sm" onclick="restoreGroup(${c.id}, '${esc(c.name).replace(/'/g, "\\'")}')">Restore</button></td>
  </tr>`).join('');
}
async function restoreGroup(id, name) {
  if (!await confirmDialog(`Restore \u201c${name}\u201d? It comes back into every list and report, with its past records.`)) return;
  try { await api(`/setup/groups/${id}`, { method: 'PUT', body: { active: true } }); toast('Group restored'); load(); }
  catch (e) { toast(e.message, true); }
}

async function archiveGroup(id, name) {
  if (!await confirmDialog(`Archive “${name}”? It will no longer appear in lists or reports. Its past records are kept, and it can be restored from “Archived” below.`)) return;
  try { await api(`/setup/groups/${id}`, { method: 'PUT', body: { active: false } }); toast('Group archived'); load(); }
  catch (e) { toast(e.message, true); }
}

function editCommittee(id) {
  const c = committees.find(x => x.id === id);
  editingId = id;
  document.getElementById('comTitle').textContent = `Edit — ${c.name}`;
  document.getElementById('cName').value = c.name;
  document.getElementById('cCode').value = c.code;
  document.getElementById('cCode').disabled = true;
  document.getElementById('cType').value = c.type;
  if (document.getElementById('cDay')) document.getElementById('cDay').value = c.meetingDay || '';
  document.getElementById('cHead').value = c.signatories && c.signatories.head ? c.signatories.head.name : '';
  document.getElementById('cSecretary').value = c.signatories && c.signatories.secretary ? c.signatories.secretary.name : '';
  document.getElementById('comOverlay').style.display = 'flex';
}

document.getElementById('comForm').addEventListener('submit', async e => {
  e.preventDefault();
  const sig = {};
  const head = document.getElementById('cHead').value.trim();
  const sec = document.getElementById('cSecretary').value.trim();
  if (head) sig.head = { name: head, title: 'President', phone: '', email: '' };
  if (sec) sig.secretary = { name: sec, title: 'Secretary', phone: '', email: '' };
  const body = {
    name: document.getElementById('cName').value.trim(),
    code: document.getElementById('cCode').value.trim(),
    type: document.getElementById('cType').value,
    meetingDay: document.getElementById('cDay') ? document.getElementById('cDay').value : '',
    signatories: sig,
  };
  try {
    if (editingId) {
      const existing = committees.find(x => x.id === editingId);
      body.signatories = { ...existing.signatories, ...sig };
      await api(`/setup/groups/${editingId}`, { method: 'PUT', body });
    } else {
      await api('/setup/groups', { method: 'POST', body });
    }
    toast('Saved');
    document.getElementById('comOverlay').style.display = 'none';
    load();
  } catch (err) { toast(err.message, true); }
});

document.getElementById('rosterCloseBtn').onclick = () => document.getElementById('rosterOverlay').style.display = 'none';
document.getElementById('memberCancelBtn').onclick = () => document.getElementById('memberOverlay').style.display = 'none';
document.getElementById('comCancelBtn').onclick = () => document.getElementById('comOverlay').style.display = 'none';
document.getElementById('addMemberBtn').onclick = () => openMemberModal('add', `Add member — ${currentCommittee.name}`, false);
document.getElementById('proposeCooptBtn').onclick = () => openMemberModal('coopt', `Request co-opted member — ${currentCommittee.name}`, true);
document.getElementById('addBtn').onclick = () => { editingId = null; document.getElementById('comTitle').textContent = 'Add group'; document.getElementById('comForm').reset(); document.getElementById('cCode').disabled = false; document.getElementById('comOverlay').style.display = 'flex'; };

requireAuthAndRenderShell().then(u => {
  me = u;
  if (canStructure()) document.getElementById('addBtn').style.display = '';
  if (canDirectContact()) {
    const impBtn = document.getElementById('importContactsBtn');
    impBtn.style.display = '';
    impBtn.addEventListener('click', async () => {
      if (!await confirmDialog('Copy phone/email from login accounts onto matching roster members (all committees AND groups)?\nOnly blank fields are filled — nothing is overwritten.')) return;
      impBtn.disabled = true;
      try {
        const r = await api('/setup/import-user-contacts', { method: 'POST' });
        const lines = r.updated.map(u => `• ${u.member} — ${u.entity}: ${u.filled.join(' + ')}`);
        await infoDialog(`Checked ${r.usersChecked} login account(s).\nFilled ${r.updated.length} roster entr${r.updated.length === 1 ? 'y' : 'ies'}${lines.length ? ':\n' + lines.join('\n') : '.'}` +
          (r.noMatch.length ? `\n\nNo matching roster member found for: ${r.noMatch.join(', ')}` : ''));
        load();
      } catch (e) { toast(e.message, true); }
      impBtn.disabled = false;
    });
  }
  load();
});
