// Meetings page (Phase 6) — schedule w/ conflict check, attendance lock, minutes.
let me, meetings = [], venues = [], committees = [], groups = [];
let currentEntity = null, currentMeeting = null, pendingBody = null;
let guests = []; // people added by name on the attendance screen: {name,status,memberId?}

function canManage() {
  if (!me) return false;
  if (isElevated(me)) return true;
  const perms = me.permissions || [];
  if (!perms.includes('meetings.manage')) return false;
  // Reporting Coordinator: congregation.manage = manage any entity's meetings.
  if (perms.includes('congregation.manage')) return true;
  return me.entity && me.entity.type !== 'congregation';
}
// Who may schedule a congregation-wide meeting: admins, the Reporting
// Coordinator (congregation.manage) and the Session Clerk (approvals.manage).
function canCongregation() {
  if (!me) return false;
  if (isElevated(me)) return true;
  const perms = me.permissions || [];
  return perms.includes('congregation.manage') || perms.includes('approvals.manage');
}

async function load() {
  const q = currentEntity && (isElevated(me) || (me.permissions || []).includes('congregation.view'))
    ? `?entityType=${currentEntity.type}&entityId=${currentEntity.id}` : '';
  [meetings, venues] = await Promise.all([api('/meetings' + q), api('/meetings/venues')]);
  document.getElementById('countLabel').textContent =
    (window.myEntity ? `${window.myEntity.name} · ` : '') + `${meetings.length} meetings`;
  document.getElementById('rows').innerHTML = meetings.map(m => {
    const locked = m.attendance && m.attendance.locked;
    const gp = m.attendance ? (m.attendance.guestsPresent || []).length : 0;
    const ga = m.attendance ? (m.attendance.guestsApology || []).length : 0;
    const present = m.attendance ? (m.attendance.presentMemberIds || []).length + gp : null;
    const online = m.attendance ? (m.attendance.onlinePresentMemberIds || []).length + (m.attendance.guestsOnline || []).length : 0;
    const apology = m.attendance ? (m.attendance.apologyMemberIds || []).length + ga : 0;
    const absent = m.attendance ? (m.attendance.absentMemberIds || []).length : 0;
    const headcount = m.attendance && m.attendance.mode === 'headcount';
    const attLabel = headcount
      ? `${(m.attendance.total || 0).toLocaleString()} present (headcount)`
      : `${present} present${online ? ` (${online} online)` : ''} · ${apology} apol · ${absent} absent`;
    // Congregation-wide meetings are visible to everyone but only manageable by
    // admins / the Session Clerk / the Reporting Coordinator.
    const rowManage = m.kind === 'congregation' ? canCongregation() : canManage();
    // Across-the-board view: say WHICH committee or group owns each meeting,
    // otherwise the list is unreadable once every entity is in it.
    const owner = !currentEntity && m.kind !== 'congregation' && m.entityName
      ? ` <span class="badge">${esc(m.entityName)}</span>` : '';
    const kindBadge = (m.kind === 'congregation'
      ? ` <span class="badge badge-info" title="Congregation-wide">${esc(m.entityName || 'congregation-wide')}</span>`
      // A group's meetings are executive meetings — the roster is its
      // office-holders only, not the whole membership. That was already true
      // in the data; it just never said so on screen.
      : m.kind === 'executive' ? ' <span class="badge badge-progress" title="Office-holders only">Executive meeting</span>'
      // Explicitly 'general' only. A group meeting with no kind on the record
      // predates the choice and was an executive meeting, so it must not be
      // relabelled — and must not be offered the headcount form.
      : (m.entityType === 'group' && m.kind === 'general') ? ' <span class="badge badge-info" title="Whole membership — recorded as a headcount">General meeting</span>'
      : m.entityType === 'group' ? ' <span class="badge badge-progress" title="Office-holders only">Executive meeting</span>'
      : ' <span class="badge badge-done" title="Full committee membership">Committee meeting</span>') + owner;
    return `<tr>
      <td>${toLocalDate(m.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })} ${esc(m.time)}</td>
      <td>${esc(m.title)}${kindBadge}${m.conflicts ? ' <span class="badge badge-attention">conflict</span>' : ''}${m.agenda ? `<details style="margin-top:5px;"><summary class="sub" style="cursor:pointer;">Agenda</summary><div class="sub" style="white-space:pre-wrap; margin-top:4px;">${esc(m.agenda)}</div></details>` : ''}</td>
      <td>${m.mode === 'online' ? '<span class="badge badge-info">online</span>' : esc(m.venueName || '—')}${m.mode === 'hybrid' ? ' <span class="badge badge-info">hybrid</span>' : ''}${m.link ? ` <a href="${esc(m.link)}" target="_blank" class="sub">join ↗</a>` : ''}</td>
      <td>${m.status === 'held' ? '<span class="badge badge-done">held</span>' : '<span class="badge badge-progress">scheduled</span>'}</td>
      <td>${locked ? `<span class="badge badge-done" title="locked">${attLabel}</span>${isElevated(me) ? ` <button class="btn btn-secondary btn-sm" onclick="unlockAtt(${m.id})">Unlock</button>` : (rowManage ? ' ' + reopenButtonHtml('meeting-attendance', { meetingId: m.id }, 'Ask to reopen') : '')}`
        : rowManage ? `<button class="btn btn-secondary btn-sm" onclick="openAttendance(${m.id})">Record</button>` : '—'}</td>
      <td style="white-space:nowrap;">${(rowManage && writable(m) && m.status !== 'cancelled') ? `<a class="btn btn-primary btn-sm" href="/meeting-minutes.html?meeting=${m.id}" title="Roll, agenda and minutes for this meeting — Word and PDF are built from them">✍️ Minutes</a> ` : ''}${(m.status === 'held' && rowManage) ? `<button class="btn btn-secondary btn-sm" onclick="downloadMinutesTemplate(${m.id})" title="Word template with attendance + agenda headings">📄 Template</button> <button class="btn btn-secondary btn-sm" onclick="openActionPoints(${m.id})" title="Action points / tasks from this meeting">🎯 Actions</button> ` : ''}${m.minutes ? `<button class="btn btn-secondary btn-sm" onclick="viewMinutes(${m.id})">View PDF</button>${rowManage ? ` <button class="btn btn-secondary btn-sm" onclick="openMinutes(${m.id})" title="Upload a corrected file (replaces this one)">Replace</button> <button class="btn btn-danger btn-sm" onclick="removeMinutes(${m.id})">Remove</button>` : ''}`
        : rowManage ? `<button class="btn btn-secondary btn-sm" onclick="openMinutes(${m.id})">Upload</button>` : '—'}</td>
      <td style="white-space:nowrap;">${rowManage && !locked && m.status === 'scheduled' ? `<button class="btn btn-secondary btn-sm" onclick="openEditMeeting(${m.id})">Edit</button> ` : ''}${rowManage && !locked ? `<button class="btn btn-danger btn-sm" onclick="cancelMeeting(${m.id})">Cancel</button>` : ''}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="sub">No meetings yet.</td></tr>';

  // The overview follows the same scope, so it refreshes with the list.
  loadMeetingsOverview();

  if (isElevated(me) || (me.permissions || []).includes('setup.venues')) {
    document.getElementById('venueCard').style.display = '';
    document.getElementById('venueRows').innerHTML = venues.map(v =>
      `<tr><td>${esc(v.name)}</td><td style="text-align:right; white-space:nowrap;"><button class="btn btn-secondary btn-sm" onclick="renameVenue(${v.id}, '${esc(v.name).replace(/'/g, "\\'")}')">Rename</button> <button class="btn btn-danger btn-sm" onclick="delVenue(${v.id})">Remove</button></td></tr>`).join('');
  }
  document.getElementById('mVenue').innerHTML = '<option value="">— choose venue —</option>' +
    venues.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('');
}

async function delVenue(id) {
  if (!await confirmDialog('Remove this venue?')) return;
  try { await api(`/meetings/venues/${id}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, true); }
}
async function renameVenue(id, current) {
  const name = await promptDialog('Venue name:', { title: 'Rename venue', defaultValue: current, okText: 'Rename' });
  if (name === null || !name.trim() || name.trim() === current) return;
  try { await api(`/meetings/venues/${id}`, { method: 'PUT', body: { name: name.trim() } }); toast('Venue renamed'); load(); }
  catch (e) { toast(e.message, true); }
}
document.getElementById('addVenueBtn').onclick = async () => {
  const name = document.getElementById('newVenue').value.trim();
  if (!name) return;
  try { await api('/meetings/venues', { method: 'POST', body: { name } }); document.getElementById('newVenue').value = ''; toast('Venue added'); load(); }
  catch (e) { toast(e.message, true); }
};

// ---- scheduling with conflict flow ----
// May this account schedule on another committee's or group's behalf?
// Mirrors resolveEntity() in routes/meetings.js.
function canScheduleForAny() {
  if (!me) return false;
  const perms = me.permissions || [];
  return isElevated(me) || perms.includes('congregation.manage') || perms.includes('approvals.manage');
}
// Fill the "for which committee/group" picker, preselecting whatever the
// list is currently filtered to.
function populateEntityPicker() {
  const sel = document.getElementById('mEntity');
  if (!sel) return;
  sel.innerHTML = committees.map(c => `<option value="committee:${c.id}">Committee — ${esc(c.name)}</option>`)
    .concat(groups.map(g => `<option value="group:${g.id}">Group — ${esc(g.name)}</option>`)).join('');
  if (currentEntity) sel.value = `${currentEntity.type}:${currentEntity.id}`;
}
function isCongregationScope() {
  return document.getElementById('scopeField').style.display !== 'none'
    && document.getElementById('mScope').value === 'congregation';
}
function buildBody() {
  const base = {
    mode: document.getElementById('mMode').value,
    link: document.getElementById('mLink').value.trim(),
    title: document.getElementById('mTitle').value.trim(),
    agenda: document.getElementById('mAgenda').value.trim(),
    date: document.getElementById('mDate').value,
    time: document.getElementById('mTime').value,
    durationMins: numVal(document.getElementById('mDuration').value) || 60,
    venueId: document.getElementById('mVenue').value || null,
  };
  if (isCongregationScope()) {
    base.scope = 'congregation';
    base.audience = document.getElementById('mAudience').value;
    if (base.audience === 'custom') {
      base.audienceEntities = [...document.querySelectorAll('#audienceEntitiesList input[type="checkbox"]:checked')]
        .map(cb => { const [type, id] = cb.value.split(':'); return { type, id: Number(id) }; });
    }
    return base;
  }
  base.kind = document.getElementById('mKind').value;
  // Cross-entity managers say explicitly who the meeting is for — the list
  // filter is a view, not a destination, so it can't be relied on (and is
  // "All" by default).
  const entField = document.getElementById('entityField');
  if (entField && entField.style.display !== 'none') {
    const [t, i] = (document.getElementById('mEntity').value || '').split(':');
    if (t && i) { base.entityType = t; base.entityId = Number(i); }
  } else if (currentEntity && canScheduleForAny()) {
    base.entityType = currentEntity.type; base.entityId = currentEntity.id;
  }
  return base;
}
function showConflicts(c) {
  const parts = [];
  if (c.venueClash) parts.push(`<b>Venue taken:</b> ${esc(c.venueClash.with || 'another meeting')} at ${esc(c.venueClash.time)} (${esc(c.venueClash.venue)})`);
  (c.memberClashes || []).forEach(x => parts.push(`<b>${esc(x.with)}</b> meets at ${esc(x.time)} — shared members: ${x.members.map(esc).join(', ')}`));
  document.getElementById('conflictList').innerHTML = parts.join('<br>');
  document.getElementById('conflictBox').style.display = '';
  document.getElementById('mProceedBtn').style.display = '';
}
let editingMeetingId = null; // null = scheduling new; otherwise editing

function submitMeeting(body) {
  return editingMeetingId
    ? api(`/meetings/${editingMeetingId}`, { method: 'PUT', body })
    : api('/meetings', { method: 'POST', body });
}

document.getElementById('mForm').addEventListener('submit', async e => {
  e.preventDefault();
  pendingBody = buildBody();
  try {
    const wasNew = !editingMeetingId;
    const rec = await submitMeeting(pendingBody);
    toast(editingMeetingId ? 'Meeting updated — members are being notified of the change' : 'Meeting scheduled');
    document.getElementById('mOverlay').style.display = 'none';
    editingMeetingId = null;
    load();
    if (wasNew && rec && rec.status === 'scheduled') showMeetingAnnouncement(rec);
  } catch (err) {
    if (err.data && err.data.conflicts) showConflicts(err.data.conflicts);
    else toast(err.message, true);
  }
});
document.getElementById('mProceedBtn').onclick = async () => {
  try {
    const wasNew = !editingMeetingId;
    const rec = await submitMeeting({ ...pendingBody, proceedAnyway: true });
    toast(editingMeetingId ? 'Meeting updated with conflicts — members are being notified' : 'Scheduled with conflicts — affected members are being notified');
    document.getElementById('mOverlay').style.display = 'none';
    editingMeetingId = null;
    load();
    if (wasNew && rec && rec.status === 'scheduled') showMeetingAnnouncement(rec);
  } catch (err) { toast(err.message, true); }
};

// ---- Post-schedule WhatsApp announcement ----
function buildMeetingAnnouncement(rec) {
  const dstr = toLocalDate(rec.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = fmtTime12(rec.time) || rec.time || '';
  let where;
  if (rec.mode === 'online') where = `💻 Online${rec.link ? `: ${rec.link}` : ''}`;
  else if (rec.mode === 'hybrid') where = `📍 ${rec.venueName || 'Venue TBA'}${rec.link ? ` · 💻 Online: ${rec.link}` : ''}`;
  else where = `📍 ${rec.venueName || 'Venue TBA'}`;
  let t = `*${rec.entityName || ''} — ${rec.title || 'Meeting'}*\n🗓 ${dstr}${time ? ` at ${time}` : ''}\n${where}\n`;
  if (rec.agenda && rec.agenda.trim()) t += `\n*Agenda*\n${rec.agenda.trim()}\n`;
  t += `\nKindly make it a point to attend. Thank you.`;
  return t;
}
function showMeetingAnnouncement(rec) {
  document.getElementById('annText').value = buildMeetingAnnouncement(rec);
  document.getElementById('annOverlay').style.display = 'flex';
}
async function copyAnnouncement() {
  const text = document.getElementById('annText').value;
  try { await navigator.clipboard.writeText(text); toast('Copied — paste into your WhatsApp group'); }
  catch (e) { const ta = document.getElementById('annText'); ta.focus(); ta.select(); toast('Select-all done — press Ctrl/Cmd+C to copy'); }
}
async function shareAnnouncement() {
  const text = document.getElementById('annText').value;
  if (navigator.share) { try { await navigator.share({ text }); } catch (e) {} }
  else copyAnnouncement();
}
const annCopyBtn = document.getElementById('annCopyBtn');
if (annCopyBtn) annCopyBtn.onclick = copyAnnouncement;
const annShareBtn = document.getElementById('annShareBtn');
if (annShareBtn) annShareBtn.onclick = shareAnnouncement;
const annCloseBtn = document.getElementById('annCloseBtn');
if (annCloseBtn) annCloseBtn.onclick = () => document.getElementById('annOverlay').style.display = 'none';

// Edit a scheduled meeting: reuse the schedule modal, prefilled.
function openEditMeeting(id) {
  const m = meetings.find(x => x.id === id);
  if (!m) return;
  editingMeetingId = id;
  document.getElementById('mTitle').value = m.title || '';
  document.getElementById('mAgenda').value = m.agenda || '';
  document.getElementById('mDate').value = m.date || '';
  document.getElementById('mTime').value = m.time || '';
  document.getElementById('mDuration').value = m.durationMins || 60;
  document.getElementById('mMode').value = m.mode || 'in-person';
  document.getElementById('mLink').value = m.link || '';
  document.getElementById('mVenue').value = m.venueId || '';
  document.getElementById('mKind').value = m.kind || 'general';
  document.getElementById('mMode').dispatchEvent(new Event('change')); // show/hide link & venue fields
  // Scope/audience are fixed once a meeting exists — editing only changes
  // when/where/agenda/title. Hide the scope picker and keep it on 'entity' so
  // buildBody() sends an ordinary edit for congregation meetings too.
  document.getElementById('mScope').value = 'entity';
  document.getElementById('scopeField').style.display = 'none';
  document.getElementById('audienceBlock').style.display = 'none';
  document.getElementById('audienceEntitiesField').style.display = 'none';
  // A meeting cannot be moved to another committee/group once it exists.
  const entField = document.getElementById('entityField');
  if (entField) entField.style.display = 'none';
  // A meeting's type is fixed once it exists — it decides the roster and how
  // attendance is recorded, and changing it would orphan either.
  const kindSel = document.getElementById('mKindSelect');
  if (kindSel) { kindSel.value = m.kind === 'general' ? 'general' : 'executive'; kindSel.style.display = 'none'; }
  const kindLbl = document.getElementById('mKindLabel');
  if (kindLbl) {
    kindLbl.style.display = '';
    kindLbl.value = m.kind === 'executive' ? 'Executive meeting (office-holders)'
      : m.entityType === 'group' ? 'General meeting (whole membership)'
      : 'Committee meeting (full membership)';
  }
  document.getElementById('kindField').style.display = m.kind === 'congregation' ? 'none' : '';
  document.querySelector('#mOverlay h2').textContent = 'Edit meeting';
  document.getElementById('mSaveBtn').textContent = 'Save changes';
  document.getElementById('conflictBox').style.display = 'none';
  document.getElementById('mProceedBtn').style.display = 'none';
  document.getElementById('mOverlay').style.display = 'flex';
}

async function cancelMeeting(id) {
  if (!await confirmDialog('Cancel this meeting?')) return;
  try { await api(`/meetings/${id}`, { method: 'DELETE' }); toast('Meeting cancelled'); load(); }
  catch (e) { toast(e.message, true); }
}

// ---- attendance ----
// ---- Headcount attendance (a group's GENERAL meeting) ----
// MF records men only, WF women only — the same rule the Attendance page
// applies, so the two screens can't disagree about what to ask for.
function hcApplyGenderRule(code) {
  const maleOnly = code === 'MF', femaleOnly = code === 'WF';
  document.querySelectorAll('#hOverlay .hc-male').forEach(el => el.style.display = femaleOnly ? 'none' : '');
  document.querySelectorAll('#hOverlay .hc-female').forEach(el => el.style.display = maleOnly ? 'none' : '');
  if (maleOnly) { document.getElementById('hMembersFemale').value = ''; document.getElementById('hOnlineFemale').value = ''; }
  if (femaleOnly) { document.getElementById('hMembersMale').value = ''; document.getElementById('hOnlineMale').value = ''; }
}
const HC_FIELDS = ['hMembersMale', 'hMembersFemale', 'hOnlineMale', 'hOnlineFemale'];
function hcRefreshTotal() {
  const t = HC_FIELDS.reduce((n, id) => n + (numVal((document.getElementById(id) || {}).value) || 0), 0);
  const el = document.getElementById('hTotal');
  if (el) el.innerHTML = `<b>${t.toLocaleString()}</b>`;
}
document.addEventListener('input', e => { if (HC_FIELDS.includes(e.target.id)) hcRefreshTotal(); });

function groupCodeFor(m) {
  const g = (groups || []).find(x => Number(x.id) === Number(m.entityId));
  if (g) return g.code;
  return (window.myEntity && Number(window.myEntity.id) === Number(m.entityId)) ? window.myEntity.code : null;
}

function openHeadcount(m) {
  currentMeeting = m;
  const a = m.attendance || {};
  document.getElementById('hTitle').textContent = `Attendance — ${m.title} (${m.date})`;
  document.getElementById('hIntro').textContent =
    `${m.entityName || 'This group'} — general meeting, so this is a headcount of everyone who came, not a name-by-name roll. It saves to the same place as the Attendance page, so don't enter this date there as well.`;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('hMembersMale', a.membersMale); set('hMembersFemale', a.membersFemale);
  set('hOnlineMale', a.onlineMale); set('hOnlineFemale', a.onlineFemale);
  hcApplyGenderRule(groupCodeFor(m));
  hcRefreshTotal();
  document.getElementById('hOverlay').style.display = 'flex';
}
const hCancel = document.getElementById('hCancelBtn');
if (hCancel) hCancel.onclick = () => document.getElementById('hOverlay').style.display = 'none';
const hSave = document.getElementById('hSaveBtn');
if (hSave) hSave.onclick = async () => {
  try {
    await api(`/meetings/${currentMeeting.id}/attendance`, { method: 'POST', body: {
      membersMale: numVal(document.getElementById('hMembersMale').value) || 0,
      membersFemale: numVal(document.getElementById('hMembersFemale').value) || 0,
      onlineMale: numVal(document.getElementById('hOnlineMale').value) || 0,
      onlineFemale: numVal(document.getElementById('hOnlineFemale').value) || 0,
    } });
    document.getElementById('hOverlay').style.display = 'none';
    toast('Attendance recorded and locked.');
    load();
  } catch (e) { toast(e.message, true); }
};

async function openAttendance(id) {
  const m = meetings.find(x => x.id === id);
  // A group's general meeting is a headcount, not a roll — different form.
  if (m && m.entityType === 'group' && m.kind === 'general') return openHeadcount(m);
  currentMeeting = meetings.find(m2 => m2.id === id);
  // The server resolves the roster for us — the executive filter for group
  // meetings and the chosen audience for congregation-wide meetings.
  const roster = await api(`/meetings/${id}/roster`);
  const congregation = currentMeeting.kind === 'congregation';
  document.getElementById('aTitle').textContent = `Attendance — ${currentMeeting.title} (${currentMeeting.date})`;
  // Each member starts "absent"; tapping Present/Apology sets their status.
  document.getElementById('aList').innerHTML = roster.map(m => `
    <div class="att-row" data-mid="${m.id}" data-status="absent"
         style="display:flex; align-items:center; gap:10px; padding:7px 4px; border-bottom:1px solid var(--rule);">
      <span style="flex:1;">${esc(m.name)} <span class="sub">— ${esc(m.position || 'Member')}${congregation && m.entityName ? ' · ' + esc(m.entityName) : ''}</span></span>
      <span class="att-seg" style="display:inline-flex; border:1px solid var(--rule); border-radius:8px; overflow:hidden;">
        <button type="button" class="att-btn" data-s="present" style="border:none; padding:5px 9px; font-size:12px; background:transparent; cursor:pointer;">Present</button>
        <button type="button" class="att-btn" data-s="online" style="border:none; border-left:1px solid var(--rule); padding:5px 9px; font-size:12px; background:transparent; cursor:pointer;" title="Present, but joined online">Online</button>
        <button type="button" class="att-btn" data-s="apology" style="border:none; border-left:1px solid var(--rule); padding:5px 9px; font-size:12px; background:transparent; cursor:pointer;">Apology</button>
      </span>
    </div>`).join('') || '<p class="sub">No one on this list yet — add people by name below.</p>';
  // Wire the segmented toggles: tapping toggles that status (tap again = back to absent).
  document.querySelectorAll('#aList .att-row').forEach(row => {
    row.querySelectorAll('.att-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const s = btn.dataset.s;
        row.dataset.status = row.dataset.status === s ? 'absent' : s;
        paintAttRow(row);
        updateAttSummary();
      });
    });
  });
  // Reset the "add by name" area for this meeting.
  guests = [];
  document.getElementById('aGuestName').value = '';
  document.getElementById('aGuestStatus').value = 'present';
  document.getElementById('aGuestSave').checked = false;
  document.getElementById('aGuestSaveFields').style.display = 'none';
  document.getElementById('aGuestSex').value = '';
  // "Save to Members" entity options: for a committee/group meeting default to
  // that entity; for a congregation meeting the recorder picks the entity.
  const opts = committees.map(c => `<option value="committee:${c.id}">Committee — ${esc(c.name)}</option>`)
    .concat(groups.map(g => `<option value="group:${g.id}">Group — ${esc(g.name)}</option>`)).join('');
  const gsel = document.getElementById('aGuestEntity');
  if (opts) {
    gsel.innerHTML = opts;
    if (!congregation) gsel.value = `${currentMeeting.entityType}:${currentMeeting.entityId}`;
  } else if (currentMeeting.entityType !== 'congregation') {
    // Entity account (no full committee/group list loaded) — only its own roster.
    gsel.innerHTML = `<option value="${currentMeeting.entityType}:${currentMeeting.entityId}">${esc(currentMeeting.entityName || 'This meeting\'s group')}</option>`;
  } else {
    gsel.innerHTML = '';
  }
  renderGuests();
  updateAttSummary();
  buildProceedings(roster);
  document.getElementById('aOverlay').style.display = 'flex';
}

// Meeting proceedings captured with attendance — times + movers/seconders picked
// from the roster. These auto-write the minutes; blanks stay fill-ins in Word.
function buildProceedings(roster) {
  const opts = '<option value="">—</option>' + (roster || []).map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
  const start = (currentMeeting && currentMeeting.time) || '';
  document.getElementById('aProceedings').innerHTML = `
    <div class="sub" style="font-weight:600; margin-bottom:6px;">Meeting proceedings (for the minutes)</div>
    <div class="field-row">
      <div class="field"><label>Commenced at</label><input type="time" id="pCommenced" value="${esc(start)}"></div>
      <div class="field"><label>Closed at</label><input type="time" id="pClosed"></div>
    </div>
    <div class="field"><label>Opening prayer led by</label><select id="pOpeningBy">${opts}</select></div>
    <div class="field-row">
      <div class="field"><label>Minutes adoption — moved by</label><select id="pMinMoved">${opts}</select></div>
      <div class="field"><label>Seconded by</label><select id="pMinSeconded">${opts}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Closure — moved by</label><select id="pCloseMoved">${opts}</select></div>
      <div class="field"><label>Seconded by</label><select id="pCloseSeconded">${opts}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Constituted at <span class="sub">(optional)</span></label><input type="time" id="pConstitutedAt"></div>
      <div class="field"><label>Constituted by <span class="sub">(optional)</span></label><input type="text" id="pConstitutedBy" placeholder="e.g. Minister-in-Charge"></div>
    </div>`;
}
// 24h "HH:MM" -> "h:mm am/pm" for the minutes wording ("6:30 pm", Oct 2026). Empty stays empty.
function fmtTime12(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return '';
  let h = Number(m[1]); const mm = m[2];
  const ampm = h < 12 ? 'am' : 'pm';
  h = h % 12; if (h === 0) h = 12;
  return `${h}:${mm} ${ampm}`;
}
function collectProceedings() {
  const val = id => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  return {
    commencedAt: fmtTime12(val('pCommenced')),
    closedAt: fmtTime12(val('pClosed')),
    constitutedAt: fmtTime12(val('pConstitutedAt')),
    constitutedBy: val('pConstitutedBy'),
    openingBy: val('pOpeningBy'),
    minutesMovedBy: val('pMinMoved'),
    minutesSecondedBy: val('pMinSeconded'),
    closureMovedBy: val('pCloseMoved'),
    closureSecondedBy: val('pCloseSeconded'),
  };
}
// ---- add a person by name (guests / walk-ins) ----
function renderGuests() {
  const box = document.getElementById('aGuestList');
  box.innerHTML = guests.map((g, i) => `
    <div style="display:flex; align-items:center; gap:8px; font-size:13px;">
      <span style="flex:1;">${esc(g.name)} <span class="sub">— ${g.status === 'apology' ? 'apology' : (g.status === 'online' ? 'present (online)' : 'present')}${g.memberId ? ' · saved to Members' : ''}</span></span>
      <button type="button" class="btn btn-danger btn-sm" onclick="removeGuest(${i})">Remove</button>
    </div>`).join('');
}
function removeGuest(i) { guests.splice(i, 1); renderGuests(); updateAttSummary(); }
document.getElementById('aGuestSave').addEventListener('change', e => {
  document.getElementById('aGuestSaveFields').style.display = e.target.checked ? 'flex' : 'none';
});
document.getElementById('aGuestAdd').addEventListener('click', async () => {
  const name = document.getElementById('aGuestName').value.trim();
  const gv = document.getElementById('aGuestStatus').value;
  const status = ['apology', 'online'].includes(gv) ? gv : 'present';
  if (!name) { toast('Type a name first.', true); return; }
  const save = document.getElementById('aGuestSave').checked;
  if (save) {
    // Persist as a real member via the roster endpoint, then record by id.
    const sel = document.getElementById('aGuestEntity').value;
    const sex = document.getElementById('aGuestSex').value;
    if (!sel) { toast('Choose a committee or group to save the person to.', true); return; }
    if (!sex) { toast('Choose Male or Female to save to Members.', true); return; }
    const [entityType, entityId] = sel.split(':');
    try {
      const created = await api('/setup/members', { method: 'POST', body: { name, entityType, entityId: Number(entityId), sex } });
      guests.push({ name, status, memberId: created.id });
    } catch (e) { toast(e.message || 'Could not save to Members.', true); return; }
  } else {
    guests.push({ name, status });
  }
  document.getElementById('aGuestName').value = '';
  document.getElementById('aGuestName').focus();
  renderGuests();
  updateAttSummary();
});
// Colour the segmented control to reflect the row's current status.
function paintAttRow(row) {
  const s = row.dataset.status;
  const colour = s === 'present' ? 'var(--pcg-green, #2E7D32)' : (s === 'online' ? '#1D4E89' : '#C9A227');
  row.querySelectorAll('.att-btn').forEach(b => {
    const on = b.dataset.s === s;
    b.style.background = on ? colour : 'transparent';
    b.style.color = on ? '#fff' : 'var(--ink)';
    b.style.fontWeight = on ? '600' : '400';
  });
}
function attCounts() {
  const rows = [...document.querySelectorAll('#aList .att-row')];
  const inPerson = rows.filter(r => r.dataset.status === 'present').map(r => Number(r.dataset.mid));
  const online = rows.filter(r => r.dataset.status === 'online').map(r => Number(r.dataset.mid));
  const apology = rows.filter(r => r.dataset.status === 'apology').map(r => Number(r.dataset.mid));
  const absent = rows.filter(r => r.dataset.status === 'absent').length;
  // A guest saved to Members is recorded by their new member id; guests kept
  // for this meeting only travel as plain names. Online guests count as present.
  guests.forEach(g => {
    if (!g.memberId) return;
    if (g.status === 'apology') apology.push(g.memberId);
    else if (g.status === 'online') online.push(g.memberId);
    else inPerson.push(g.memberId);
  });
  const guestsPresent = guests.filter(g => !g.memberId && g.status === 'present').map(g => g.name);
  const guestsOnline = guests.filter(g => !g.memberId && g.status === 'online').map(g => g.name);
  const guestsApology = guests.filter(g => !g.memberId && g.status === 'apology').map(g => g.name);
  return { inPerson, online, apology, absent, guestsPresent, guestsOnline, guestsApology };
}
function updateAttSummary() {
  const c = attCounts();
  const online = c.online.length + c.guestsOnline.length;
  const p = c.inPerson.length + c.guestsPresent.length + online;
  const a = c.apology.length + c.guestsApology.length;
  document.getElementById('aSummary').textContent = `${p} present${online ? ` (${online} online)` : ''} · ${a} apology · ${c.absent} absent`;
}

document.getElementById('aSaveBtn').onclick = async () => {
  const c = attCounts();
  const online = c.online.length + c.guestsOnline.length;
  const p = c.inPerson.length + c.guestsPresent.length + online;
  const a = c.apology.length + c.guestsApology.length;
  if (!await confirmDialog(`Save attendance — ${p} present${online ? ` (${online} online)` : ''}, ${a} apology, ${c.absent} absent? This locks the record.`)) return;
  try {
    await api(`/meetings/${currentMeeting.id}/attendance`, { method: 'POST', body: {
      presentMemberIds: c.inPerson, onlinePresentMemberIds: c.online, apologyMemberIds: c.apology,
      guestsPresent: c.guestsPresent, guestsOnline: c.guestsOnline, guestsApology: c.guestsApology,
      proceedings: collectProceedings(),
    } });
    toast('Attendance saved & locked');
    document.getElementById('aOverlay').style.display = 'none';
    load();
  } catch (e) { toast(e.message, true); }
};
async function unlockAtt(id) {
  if (!await confirmDialog('Unlock this attendance record? The unlock is logged.')) return;
  try { await api(`/meetings/${id}/unlock-attendance`, { method: 'POST' }); toast('Unlocked'); load(); }
  catch (e) { toast(e.message, true); }
}

// View an uploaded minutes PDF. In a normal browser, open it in a new tab.
// In the installed app (standalone), a plain PDF link renders over the app with
// no way back — so fetch it and hand it to the OS viewer as a download, which
// has its own Done/back that returns to the app.
async function viewMinutes(id) {
  // The app-wide document viewer has Close, Download and Share, so it works
  // the same in the browser and in the installed app.
  if (window.openDocViewer) { window.openDocViewer(`/api/meetings/${id}/minutes`, 'Minutes'); return; }
  const standalone = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone;
  if (!standalone) { window.open(`/api/meetings/${id}/minutes`, '_blank'); return; }
  try {
    const res = await fetch(`/api/meetings/${id}/minutes`, { credentials: 'same-origin' });
    if (!res.ok) { let m = 'Could not open the minutes.'; try { m = (await res.json()).error || m; } catch (e) {} throw new Error(m); }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = `minutes-${id}.pdf`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { toast(e.message, true); }
}

// Committees and group EXECUTIVE meetings can have their minutes written in the
// app. A group general meeting is a headcount with no roll, so it cannot.
function writable(m) {
  if (!m || m.entityType === 'congregation') return false;
  if (m.entityType === 'group') return m.kind !== 'general';
  return m.entityType === 'committee';
}
// Download the ready-to-fill Word minutes template (auto attendance + agenda).
async function downloadMinutesTemplate(id) {
  try {
    const res = await fetch(`/api/meetings/${id}/minutes-template.docx`, { credentials: 'same-origin' });
    if (!res.ok) { let m = 'Could not build the template.'; try { m = (await res.json()).error || m; } catch (e) {} throw new Error(m); }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url; a.download = `minutes-template-${id}.docx`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('Minutes template downloaded — fill it in, then upload the signed PDF.');
  } catch (e) { toast(e.message, true); }
}

// Remove a wrongly-uploaded minutes PDF so a correct one can be uploaded.
async function removeMinutes(id) {
  if (!await confirmDialog('Remove the uploaded minutes for this meeting? You can then upload the correct file.', { title: 'Remove minutes?', okText: 'Remove', danger: true })) return;
  try { await api(`/meetings/${id}/minutes`, { method: 'DELETE' }); toast('Minutes removed.'); load(); }
  catch (e) { toast(e.message, true); }
}

// ---- minutes upload (drag & drop + browse, PDF only) ----
function openMinutes(id) {
  currentMeeting = meetings.find(m => m.id === id);
  document.getElementById('minStatus').textContent = '';
  document.getElementById('minOverlay').style.display = 'flex';
}
async function uploadMinutes(file) {
  if (file.type !== 'application/pdf') { document.getElementById('minStatus').textContent = 'Only PDF files are accepted.'; return; }
  if (file.size > 10 * 1024 * 1024) { document.getElementById('minStatus').textContent = 'PDF must be under 10 MB.'; return; }
  const fd = new FormData();
  fd.append('minutes', file);
  document.getElementById('minStatus').textContent = 'Uploading…';
  try {
    const res = await fetch(`/api/meetings/${currentMeeting.id}/minutes`, { method: 'POST', body: fd, credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed.');
    toast('Minutes uploaded');
    document.getElementById('minOverlay').style.display = 'none';
    load();
  } catch (e) { document.getElementById('minStatus').textContent = e.message; }
}
const minDrop = document.getElementById('minDrop');
minDrop.addEventListener('click', () => document.getElementById('minFile').click());
document.getElementById('minFile').addEventListener('change', e => {
  const f = e.target.files[0]; e.target.value = '';
  if (f) uploadMinutes(f);
});
['dragenter', 'dragover'].forEach(evt => minDrop.addEventListener(evt, e => { e.preventDefault(); minDrop.classList.add('drag-over'); }));
['dragleave', 'dragend'].forEach(evt => minDrop.addEventListener(evt, e => { e.preventDefault(); minDrop.classList.remove('drag-over'); }));
minDrop.addEventListener('drop', e => {
  e.preventDefault(); minDrop.classList.remove('drag-over');
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) uploadMinutes(f);
});

document.getElementById('mMode').onchange = e => {
  const m = e.target.value;
  document.getElementById('linkField').style.display = m === 'in-person' ? 'none' : '';
  document.getElementById('mVenue').closest('.field').style.display = m === 'online' ? 'none' : '';
};

// ---- congregation-wide scope + audience ----
function populateAudienceEntities() {
  const box = document.getElementById('audienceEntitiesList');
  const items = committees.map(c => ({ v: `committee:${c.id}`, label: `Committee — ${c.name}` }))
    .concat(groups.map(g => ({ v: `group:${g.id}`, label: `Group — ${g.name}` })));
  box.innerHTML = items.map(it =>
    `<label class="sub" style="display:flex; align-items:center; gap:8px; padding:3px 0; cursor:pointer;">
       <input type="checkbox" value="${it.v}" style="width:auto; margin:0;"> ${esc(it.label)}</label>`).join('')
    || '<span class="sub">No committees or groups found.</span>';
}
function applyScopeUI() {
  const congregation = isCongregationScope();
  document.getElementById('audienceBlock').style.display = congregation ? '' : 'none';
  document.getElementById('kindField').style.display = congregation ? 'none' : '';
  const entField = document.getElementById('entityField');
  if (entField) entField.style.display = (!congregation && canScheduleForAny() && !window.myEntity) ? '' : 'none';
  if (congregation && document.getElementById('mAudience').value === 'custom') {
    document.getElementById('audienceEntitiesField').style.display = '';
    if (!document.getElementById('audienceEntitiesList').children.length) populateAudienceEntities();
  } else {
    document.getElementById('audienceEntitiesField').style.display = 'none';
  }
}
document.getElementById('mScope').onchange = () => { applyScopeUI(); syncKindLabel(); };
const mEntitySel = document.getElementById('mEntity');
if (mEntitySel) mEntitySel.onchange = syncKindLabel;
const mKindSel = document.getElementById('mKindSelect');
if (mKindSel) mKindSel.onchange = () => { document.getElementById('mKind').value = mKindSel.value; };
document.getElementById('mAudience').onchange = () => {
  if (document.getElementById('mAudience').value === 'custom') populateAudienceEntities();
  applyScopeUI();
};
document.getElementById('mCancelBtn').onclick = () => document.getElementById('mOverlay').style.display = 'none';
document.getElementById('aCancelBtn').onclick = () => document.getElementById('aOverlay').style.display = 'none';
document.getElementById('minCancelBtn').onclick = () => document.getElementById('minOverlay').style.display = 'none';

// Insert the standard PCG agenda skeleton, auto-dating the "previous minutes"
// item from the most recent held meeting. Editable afterwards.
const stdAgendaBtn = document.getElementById('mAgendaStd');
if (stdAgendaBtn) stdAgendaBtn.onclick = async () => {
  const held = (meetings || []).filter(m => m.status === 'held')
    .sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
  const prev = held.length ? fmtDateLong(held[0].date) : '';
  const skeleton = [
    '1. Opening prayer',
    `2. Confirmation of minutes of the previous meeting${prev ? ` held on ${prev}` : ''}`,
    '3. Matters arising',
    '4. ',
    '5. Any Other Business (A.O.B.)',
    '6. Closing / Adjournment',
  ].join('\n');
  const ta = document.getElementById('mAgenda');
  if (ta.value.trim() && !(await confirmDialog('Replace the current agenda with the standard skeleton?'))) return;
  ta.value = skeleton;
  ta.focus();
};
// ---- Action points ----
let apMeetingId = null, apRoster = [], apMeeting = null, apItems = [];
async function openActionPoints(id) {
  apMeetingId = id;
  const m = meetings.find(x => x.id === id);
  apMeeting = m || null;
  document.getElementById('apTitle').textContent = `Action points — ${m ? m.title : ''}`;
  apRoster = await api(`/meetings/${id}/roster`).catch(() => []);
  document.getElementById('apResp').innerHTML = '<option value="">— responsible —</option>' + apRoster.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  document.getElementById('apText').value = '';
  document.getElementById('apDate').value = '';
  document.getElementById('apResp').value = '';
  await renderActionPoints();
  document.getElementById('apOverlay').style.display = 'flex';
}
async function renderActionPoints() {
  const list = await api(`/meetings/${apMeetingId}/action-points`).catch(() => []);
  apItems = list;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  document.getElementById('apList').innerHTML = list.map(a => {
    const overdue = a.status === 'open' && a.targetDate && toLocalDate(a.targetDate) < today;
    const dstr = a.targetDate ? toLocalDate(a.targetDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
    return `<div style="display:flex; align-items:flex-start; gap:8px; padding:7px 0; border-bottom:1px solid var(--rule);">
      <div style="flex:1;">
        <div style="${a.status === 'done' ? 'text-decoration:line-through; opacity:.6;' : ''}">${esc(a.text)}</div>
        <div class="sub" style="font-size:11.5px;">${esc(a.responsibleName || 'Unassigned')} · ${a.status === 'done' ? 'done' : `due ${dstr}`}${overdue ? ' <span class="badge badge-attention">overdue</span>' : ''}</div>
      </div>
      <button class="btn btn-secondary btn-sm" onclick="toggleActionDone(${a.id}, '${a.status === 'done' ? 'open' : 'done'}')">${a.status === 'done' ? 'Reopen' : 'Done'}</button>
      <button class="btn btn-danger btn-sm" onclick="deleteAction(${a.id})">✕</button>
    </div>`;
  }).join('') || '<p class="sub">No action points yet.</p>';
}
const apAddBtn = document.getElementById('apAddBtn');
if (apAddBtn) apAddBtn.onclick = async () => {
  const text = document.getElementById('apText').value.trim();
  if (!text) { toast('Type what is to be done.', true); return; }
  try {
    await api(`/meetings/${apMeetingId}/action-points`, { method: 'POST', body: {
      text,
      responsibleMemberId: document.getElementById('apResp').value || null,
      targetDate: document.getElementById('apDate').value || '',
    } });
    document.getElementById('apText').value = '';
    document.getElementById('apDate').value = '';
    document.getElementById('apResp').value = '';
    renderActionPoints();
  } catch (e) { toast(e.message, true); }
};
async function toggleActionDone(id, status) {
  try { await api(`/meetings/action-points/${id}`, { method: 'PUT', body: { status } }); renderActionPoints(); }
  catch (e) { toast(e.message, true); }
}
async function deleteAction(id) {
  if (!await confirmDialog('Delete this action point?')) return;
  try { await api(`/meetings/action-points/${id}`, { method: 'DELETE' }); renderActionPoints(); }
  catch (e) { toast(e.message, true); }
}
const apCloseBtn = document.getElementById('apCloseBtn');
if (apCloseBtn) apCloseBtn.onclick = () => { document.getElementById('apOverlay').style.display = 'none'; load(); };

// Build a WhatsApp-friendly summary, grouped by responsible person.
function buildActionPointsText() {
  const entity = (apMeeting && apMeeting.entityName) || (window.myEntity ? window.myEntity.name : '');
  const title = apMeeting ? apMeeting.title : '';
  const dstr = apMeeting ? fmtDateLong(apMeeting.date) : '';
  const open = apItems.filter(a => a.status !== 'done');
  const done = apItems.filter(a => a.status === 'done');
  const shortD = d => d ? toLocalDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  const byPerson = {};
  open.forEach(a => { const k = a.responsibleName || 'Unassigned'; (byPerson[k] = byPerson[k] || []).push(a); });
  let t = `*Action Points — ${entity}*\n_${title}${dstr ? ' · ' + dstr : ''}_\n`;
  const people = Object.keys(byPerson).sort((a, b) => a === 'Unassigned' ? 1 : b === 'Unassigned' ? -1 : a.localeCompare(b));
  if (!people.length) t += '\n_No open action points._\n';
  people.forEach(person => {
    t += `\n*${person}*\n`;
    byPerson[person].forEach(a => { const due = a.targetDate ? ` (by ${shortD(a.targetDate)})` : ''; t += ` • ${a.text}${due}\n`; });
  });
  if (done.length) {
    t += `\n_Recently completed:_\n`;
    done.forEach(a => { t += ` • ${a.text} ✅${a.responsibleName ? ` (${a.responsibleName})` : ''}\n`; });
  }
  t += `\n_Please update the Secretary once your item is done._`;
  return t;
}
async function copyActionPoints() {
  const text = buildActionPointsText();
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied — paste into your WhatsApp group');
  } catch (e) {
    // Fallback: show the text in a dialog so it can be selected and copied.
    await promptDialog('Select the text below and copy it:', { title: 'Copy action points', defaultValue: text, multiline: true, okText: 'Close', cancelText: '' });
  }
}
async function shareActionPoints() {
  const text = buildActionPointsText();
  if (navigator.share) {
    try { await navigator.share({ title: 'Action Points', text }); } catch (e) {}
  } else {
    copyActionPoints();
  }
}
const apCopyBtn = document.getElementById('apCopyBtn');
if (apCopyBtn) apCopyBtn.onclick = copyActionPoints;
const apShareBtn = document.getElementById('apShareBtn');
if (apShareBtn) apShareBtn.onclick = shareActionPoints;
const apPdfBtn = document.getElementById('apPdfBtn');
if (apPdfBtn) apPdfBtn.onclick = () => window.open(`/api/meetings/${apMeetingId}/action-points.pdf`, '_blank');

function currentEntityType() {
  if (window.myEntity) return window.myEntity.type;
  const entField = document.getElementById('entityField');
  if (entField && entField.style.display !== 'none') {
    return (document.getElementById('mEntity').value || '').split(':')[0] || 'committee';
  }
  return currentEntity ? currentEntity.type : 'committee';
}
// A committee only meets as its full membership, so there is nothing to pick.
// A group meets both ways — the whole membership (a headcount) or just its
// office-holders (a named roll) — so it gets a real choice. Executive stays the
// default, because that is what every group meeting scheduled before now was.
function syncKindLabel() {
  const isGroup = currentEntityType() === 'group';
  const sel = document.getElementById('mKindSelect');
  const lbl = document.getElementById('mKindLabel');
  if (sel) sel.style.display = isGroup ? '' : 'none';
  if (lbl) lbl.style.display = isGroup ? 'none' : '';
  if (isGroup) {
    document.getElementById('mKind').value = sel ? sel.value : 'executive';
  } else {
    document.getElementById('mKind').value = 'general';
    if (lbl) lbl.value = 'Committee meeting (full membership)';
  }
}
document.getElementById('addBtn').onclick = () => {
  editingMeetingId = null;
  document.querySelector('#mOverlay h2').textContent = 'Schedule meeting';
  document.getElementById('mSaveBtn').textContent = 'Schedule';
  document.getElementById('mForm').reset();
  const isGroup = currentEntityType() === 'group';
  document.getElementById('mKind').value = isGroup ? 'executive' : 'general';
  document.getElementById('mKindLabel').value = isGroup ? 'Executive meeting (office-holders)' : 'Committee meeting (full membership)';
  document.getElementById('mDuration').value = '90';
  document.getElementById('conflictBox').style.display = 'none';
  document.getElementById('linkField').style.display = 'none';
  document.getElementById('mVenue').closest('.field').style.display = '';
  document.getElementById('mProceedBtn').style.display = 'none';
  // Scope selector: only offered to those who may hold congregation-wide
  // meetings. Default to an ordinary committee/group meeting.
  document.getElementById('mScope').value = 'entity';
  document.getElementById('mAudience').value = 'all';
  document.getElementById('audienceEntitiesList').innerHTML = '';
  document.getElementById('scopeField').style.display = canCongregation() ? '' : 'none';
  populateEntityPicker();
  const kindSel = document.getElementById('mKindSelect');
  if (kindSel) kindSel.value = 'executive';
  applyScopeUI();
  syncKindLabel();
  document.getElementById('mOverlay').style.display = 'flex';
};

requireAuthAndRenderShell().then(async u => {
  me = u;
  if (!me) return; // not signed in — the shell helper is already redirecting
  if (canManage()) document.getElementById('addBtn').style.display = '';
  // Matches canViewAll() on the server: admin tier, congregation.view, or the
  // Session Clerk (approvals.manage). The clerk was previously left out here
  // even though the API lets them read and schedule across entities, so their
  // filter — and the new "for which committee" picker — came up empty.
  if (canScheduleForAny() || (me.permissions || []).includes('congregation.view')) {
    [committees, groups] = await Promise.all([api('/setup/committees'), api('/setup/groups')]);
    const filter = document.getElementById('entityFilter');
    filter.style.display = '';
    // "All" is the default: someone who can see every committee and group
    // should land on everything at once, not on whichever committee happens
    // to sort first. Narrowing is then a deliberate choice.
    filter.innerHTML = '<option value="all">All committees &amp; groups</option>' +
      committees.map(c => `<option value="committee:${c.id}">Committee — ${esc(c.name)}</option>`)
        .concat(groups.map(g => `<option value="group:${g.id}">Group — ${esc(g.name)}</option>`)).join('');
    currentEntity = null;
    filter.value = 'all';
    filter.onchange = e => {
      if (e.target.value === 'all') { currentEntity = null; }
      else { const [t, i] = e.target.value.split(':'); currentEntity = { type: t, id: Number(i) }; }
      load();
    };
  }
  load();
});

// ============ Overview tab ============
// Headline figures first; the meeting-by-meeting list stays one click away.
// Follows the scope selector — "All committees & groups" by default.

function mtgTile(label, value, note, warn) {
  return `<div class="stat-card"><div class="label">${esc(label)}</div>` +
    `<div class="value${warn ? ' warn' : ''}">${value === null || value === undefined ? '—' : esc(String(value))}</div>` +
    `${note ? `<div class="sub" style="margin-top:6px;">${note}</div>` : ''}</div>`;
}

async function loadMeetingsOverview() {
  const q = currentEntity ? `?entityType=${currentEntity.type}&entityId=${currentEntity.id}` : '';
  let o;
  try { o = await api('/meetings/overview' + q); }
  catch (e) { document.getElementById('mtgStats').innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }

  document.getElementById('mtgStats').innerHTML = [
    mtgTile(`Held in Q${o.quarter}`, o.held, `${o.scheduledInQuarter} more scheduled this quarter`),
    mtgTile('Attendance not recorded', o.attendanceMissing,
      `${o.attendanceRecorded} of ${o.held} held meeting${o.held === 1 ? '' : 's'} signed off`, o.attendanceMissing > 0),
    mtgTile('Average turnout', o.turnoutPct === null ? '—' : `${o.turnoutPct}%`,
      o.turnoutPct === null ? 'no locked attendance yet' : 'of everyone expected, across locked meetings'),
    mtgTile('Open action points', o.actionPoints.open,
      `${o.actionPoints.overdue} past their target date`, o.actionPoints.overdue > 0),
  ].join('');

  document.getElementById('mtgUpcoming').innerHTML = o.upcoming.length
    // Date and time on the left; the meeting, then who and where, on the right
    // — so a long committee name or venue wraps in its own line instead of
    // squeezing the venue to one letter a line on a phone (Oct 2026).
    ? o.upcoming.map(m => `<div class="mtg-next">
        <time><b>${esc(toLocalDate(m.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', ''))}</b>${esc(m.time || '')}</time>
        <div><div class="t">${esc(m.title)}</div>
          <div class="m">${[m.entityName, m.mode === 'online' ? 'Online' : m.venueName].filter(Boolean).map(esc).join(' · ') || '—'}</div></div>
      </div>`).join('')
    : emptyState({ icon: 'calendar', title: 'Nothing scheduled', text: 'No meeting is in the diary yet for these committees and groups.', action: '+ Schedule a meeting', click: 'addBtn' });

  const entCard = document.getElementById('mtgEntityCard');
  if (o.perEntity && o.perEntity.length) {
    entCard.style.display = '';
    document.getElementById('mtgEntityTitle').textContent = `Q${o.quarter} ${o.year}`;
    // Committees and group executives are different bodies meeting for
    // different reasons — one list made a group's executive discipline
    // impossible to see next to thirteen committees.
    const row = e => `<tr>
      <td>${esc(e.name)}</td>
      <td class="mono">${e.held}</td>
      <td class="mono">${e.scheduled}</td>
      <td class="mono">${e.attendanceMissing ? `<span class="badge badge-attention">${e.attendanceMissing}</span>` : '—'}</td>
      <td class="mono">${e.minutesMissing ? `<span class="badge badge-progress">${e.minutesMissing}</span>` : '—'}</td>
      <td class="mono">${e.flagged ? `<span class="badge badge-attention">${e.flagged}</span>` : '—'}</td>
    </tr>`;
    const fill = (id, list, empty) => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = list.map(row).join('') || `<tr><td colspan="6" class="sub">${empty}</td></tr>`;
    };
    fill('mtgCommitteeRows', o.perEntity.filter(e => e.type === 'committee'), 'No committees.');
    fill('mtgGroupRows', o.perEntity.filter(e => e.type === 'group'), 'No groups.');
  } else {
    entCard.style.display = 'none';
  }

  // Flags carry an icon and a word as well as the colour — never colour alone.
  document.getElementById('mtgFlags').innerHTML = o.flagged.length
    ? o.flagged.map(f => `<div class="sub" style="padding:5px 0; border-bottom:1px solid var(--rule);">
        <span class="badge ${f.flag === 'red' ? 'badge-attention' : 'badge-progress'}">${f.flag === 'red' ? '● missing' : '▲ low'}</span>
        <b>${esc(f.name)}</b>${f.entityName ? ` — ${esc(f.entityName)}` : ''}
        · ${f.present}/${f.held} attended${f.pct === null ? '' : ` (${f.pct}%)`}${f.consecutiveAbsences ? ` · ${f.consecutiveAbsences} in a row missed without apology` : ''}
      </div>`).join('') +
      (o.flaggedTotal > o.flagged.length ? `<p class="sub" style="margin:8px 0 0;">…and ${o.flaggedTotal - o.flagged.length} more.</p>` : '')
    : '<p class="sub" style="margin:0;">Nobody is flagged this quarter.</p>';
}

function showMeetingTab(tab) {
  document.getElementById('mtgOverviewPane').style.display = tab === 'overview' ? '' : 'none';
  document.getElementById('mtgRecordsPane').style.display = tab === 'records' ? '' : 'none';
  document.querySelectorAll('#mtgTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}
document.querySelectorAll('#mtgTabs button').forEach(b => {
  b.onclick = () => showMeetingTab(b.dataset.tab);
});
