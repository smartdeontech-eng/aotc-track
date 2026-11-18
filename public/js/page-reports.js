// Reports page (Phase 4).
let me, committees = [], groups = [];
let quarter = Math.min(4, Math.floor(new Date().getMonth() / 3) + 1);
let currentEntity = null;

function qs() {
  const e = currentEntity ? `&entityType=${currentEntity.type}&entityId=${currentEntity.id}` : '';
  return `?quarter=${quarter}${e}`;
}

async function load() {
  document.querySelectorAll('#quarterToggle button').forEach(b => b.classList.toggle('active', Number(b.dataset.q) === quarter));
  try {
    const d = await api('/reports/data' + qs());
    document.getElementById('genTitle').textContent = `${d.entity.name} — ${d.ordinal} Quarter Report ${d.year}`;
    document.getElementById('genStatus').textContent = d.submission
      ? `✓ Q${d.quarter} data was submitted & locked by ${d.submission.submittedBy} — this will be a FINAL report.`
      : `Q${d.quarter} data has not been submitted yet — this will be a DRAFT report (you can still generate it).`;
    document.getElementById('countLabel').textContent = `${d.entity.name} · reports & archive`;
  } catch (e) {
    document.getElementById('genStatus').textContent = e.message;
  }
  loadHistory();
  loadConference();
  loadBoard();
}

async function loadHistory() {
  const list = await api('/reports/history').catch(() => []);
  const mine = currentEntity ? list.filter(r => r.entityType === currentEntity.type && Number(r.entityId) === Number(currentEntity.id)) : list;
  document.getElementById('historyRows').innerHTML = mine.map(r => `<tr>
    <td>${esc(r.entityName)} — Q${r.quarter} ${r.year}${r.submittedAtGeneration ? ' <span class="badge badge-done">final</span>' : ' <span class="badge badge-progress">draft</span>'}</td>
    <td class="mono">v${r.version}</td>
    <td>${esc(r.generatedBy)}</td>
    <td>${fmtDate(r.generatedAt)}</td>
    <td class="mono">${r.filename.endsWith('.pdf') ? 'PDF' : 'Word'}</td>
    <td><a class="btn btn-secondary btn-sm" href="/api/reports/download/${r.id}" ${r.filename.endsWith('.pdf') ? 'target="_blank"' : ''}>${r.filename.endsWith('.pdf') ? 'View' : 'Download'}</a></td>
  </tr>`).join('') || '<tr><td colspan="5" class="sub">No reports generated yet.</td></tr>';
}

document.getElementById('pdfBtn').onclick = () => {
  window.open('/api/reports/pdf' + qs(), '_blank');
  setTimeout(loadHistory, 1500);
};
// ---- Conference notes + PDF ----
async function loadConference() {
  try {
    const entQ = currentEntity ? `?entityType=${currentEntity.type}&entityId=${currentEntity.id}` : '?';
    const [notes, goals] = await Promise.all([
      api('/reports/conference-notes' + entQ.replace('?&', '?')),
      api('/setup/goals' + (currentEntity && (isElevated(me) || (me.permissions || []).includes('congregation.view')) ? `?ownerCode=` : '')),
    ]);
    // goals for current entity
    let entGoals = goals;
    if (currentEntity && (isElevated(me) || (me.permissions || []).includes('congregation.view'))) {
      const list = currentEntity.type === 'committee' ? committees : groups;
      const rec = list.find(x => x.id === Number(currentEntity.id));
      entGoals = goals.filter(g => rec && g.ownerCode === rec.code);
    }
    document.getElementById('cfPreamble').value = notes.preamble || '';
    document.getElementById('cfAchievements').value = notes.achievements || '';
    document.getElementById('cfChallenges').value = notes.challenges || '';
    document.getElementById('cfFocus').value = notes.emergingFocus || '';
    const gn = notes.goalNotes || {};
    document.getElementById('cfGoals').innerHTML = entGoals.map(g => `
      <div style="border:1px solid var(--rule); border-radius:8px; padding:10px 12px; margin-bottom:10px;">
        <p style="margin:0 0 6px;"><b class="mono">${esc(g.code)}</b> <span class="sub">${esc(g.description.slice(0, 90))}</span></p>
        <div class="field"><label>Performance narrative</label><textarea data-gperf="${g.id}" rows="2">${esc((gn[g.id] || {}).performance || '')}</textarea></div>
        <div class="field"><label>Way forward</label><textarea data-gway="${g.id}" rows="1">${esc((gn[g.id] || {}).wayForward || '')}</textarea></div>
      </div>`).join('') || '<p class="sub">No goals found.</p>';
  } catch (e) { /* scoped users without access */ }
}
document.getElementById('confSaveBtn').onclick = async () => {
  const goalNotes = {};
  document.querySelectorAll('[data-gperf]').forEach(el => {
    const id = el.dataset.gperf;
    goalNotes[id] = goalNotes[id] || {};
    goalNotes[id].performance = el.value.trim();
  });
  document.querySelectorAll('[data-gway]').forEach(el => {
    const id = el.dataset.gway;
    goalNotes[id] = goalNotes[id] || {};
    goalNotes[id].wayForward = el.value.trim();
  });
  try {
    await api('/reports/conference-notes', { method: 'PUT', body: {
      preamble: document.getElementById('cfPreamble').value,
      achievements: document.getElementById('cfAchievements').value,
      challenges: document.getElementById('cfChallenges').value,
      emergingFocus: document.getElementById('cfFocus').value,
      goalNotes,
      ...(currentEntity ? { entityType: currentEntity.type, entityId: currentEntity.id } : {}),
    } });
    toast('Conference notes saved');
  } catch (e) { toast(e.message, true); }
};
document.getElementById('confPdfBtn').onclick = () => {
  const entQ = currentEntity ? `&entityType=${currentEntity.type}&entityId=${currentEntity.id}` : '';
  window.open(`/api/reports/conference/pdf?x=1${entQ}`, '_blank');
  setTimeout(loadHistory, 1500);
};

document.getElementById('wordBtn').onclick = () => {
  window.location.href = '/api/reports/docx' + qs();
  setTimeout(loadHistory, 1500);
};

document.querySelectorAll('#quarterToggle button').forEach(b => b.onclick = () => { quarter = Number(b.dataset.q); load(); });

requireAuthAndRenderShell().then(async u => {
  me = u;
  const clerkish = isElevated(me) || (me.permissions || []).includes('approvals.manage');
  if (clerkish) {
    document.getElementById('congCard').style.display = '';
    document.getElementById('congPdfBtn').onclick = () => { window.open(`/api/reports/congregation/pdf?quarter=${quarter}`, '_blank'); setTimeout(loadHistory, 1500); };
    document.getElementById('congWordBtn').onclick = () => { window.location.href = `/api/reports/congregation/docx?quarter=${quarter}`; setTimeout(loadHistory, 1500); };
    document.getElementById('congExcelBtn').onclick = () => { window.location.href = `/api/reports/district-excel?quarter=${quarter}`; setTimeout(loadHistory, 1500); };
  }
  [committees, groups] = await Promise.all([api('/setup/committees').catch(() => []), api('/setup/groups').catch(() => [])]);
  const filter = document.getElementById('entityFilter');
  if (isElevated(me) || (me.permissions || []).includes('congregation.view')) {
    filter.style.display = '';
    filter.innerHTML = committees.map(c => `<option value="committee:${c.id}">Committee — ${esc(c.name)}</option>`)
      .concat(groups.map(g => `<option value="group:${g.id}">Group — ${esc(g.name)}</option>`)).join('');
    currentEntity = committees[0] ? { type: 'committee', id: committees[0].id } : null;
    if (currentEntity) filter.value = `${currentEntity.type}:${currentEntity.id}`;
    filter.onchange = e => { const [t, i] = e.target.value.split(':'); currentEntity = { type: t, id: Number(i) }; load(); };
  } else if (me.entity && me.entity.type !== 'congregation') {
    currentEntity = { type: me.entity.type, id: Number(me.entity.id) };
  }
  load();
});

// ---- Quarterly submission board ----
// Who is in and who is not, for the whole congregation. Sits above the
// congregational report because that is the order the work happens in: you
// find out what is missing, chase it, and only then generate.
//
// Congregation-wide accounts only - the server refuses it to anyone else, and
// a committee secretary has no business with the other twenty-four returns.
// A traffic light, read at a glance: green is done, amber is in hand, red is
// the gap. badge-done carries the crest green, so "Submitted" here reads the
// same as "done" everywhere else in the app.
// The same three colours as the WhatsApp poster, so the board the clerk works
// from and the picture the congregation sees cannot say different things.
// Scoped to this board: `badge-bright-*` exists nowhere else in the app.
const BOARD_STATUS = {
  outstanding: { label: 'Not submitted', cls: 'badge-bright-no' },
  reopened: { label: 'Reopened', cls: 'badge-bright-warn' },
  submitted: { label: 'Submitted', cls: 'badge-bright-ok' },
};
// Reopening needs approvals.manage - the same right that approves a change
// request someone raised. Seeing the board is a wider club than acting on it.
let boardCanReopen = false;
let boardDeadlineAhead = true;

// The same window the change-request route opens, started from the board
// instead of from a committee's request. 48 hours, or until the quarter's own
// reporting deadline while that deadline is still ahead.
// Save the board as a PNG, ready to attach to the WhatsApp group.
//
// The server renders the poster as SVG; the browser rasterises it. Drawing an
// SVG data URL into a canvas does NOT taint it, so toBlob works and no server
// image library is needed. Nothing external is fetched, so this also works with
// no connection beyond the app itself.
//
// Rendered at 2x for a crisp image on a phone screen, then saved as PNG -
// WhatsApp re-encodes anything it is given, and PNG survives that better than
// a JPEG that has already been compressed once.
async function downloadBoardImage() {
  const btn = document.getElementById('boardImgBtn');
  const was = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing\u2026'; }
  try {
    const res = await fetch(`/api/entry/submission-board/poster.svg?year=${boardYear}&quarter=${quarter}`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(res.status === 403 ? 'You do not have access to the congregation-wide view.' : 'The poster could not be built.');
    const svg = await res.text();
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('The image could not be rendered in this browser.'));
      img.src = url;
    });
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = img.width * scale; canvas.height = img.height * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    if (!blob) throw new Error('The image could not be saved in this browser.');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Q${quarter}-${boardYear}-report-submissions.png`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    toast('Image saved \u2014 attach it to the group');
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = was; }
  }
}

async function openReopen(entityType, entityId, name) {
  const body = document.createElement('div');
  body.innerHTML = `<div class="modal-overlay app-dialog"><div class="modal" style="max-width:520px;">
    <h2>Reopen ${esc(name)}</h2>
    <p class="sub">This opens the same change window a committee would get by asking for one. It re-locks by itself
      when the window closes, or as soon as they resubmit.</p>
    <div class="field"><label>How long</label>
      <select id="roWindow">
        <option value="hours">48 hours</option>
        ${boardDeadlineAhead ? '<option value="deadline">Until the quarter\u2019s reporting deadline</option>' : ''}
      </select>
      ${boardDeadlineAhead ? '' : '<div class="sub" style="margin-top:4px;">The reporting deadline has passed, so only a 48-hour window can be given.</div>'}
    </div>
    <div class="field"><label>Why (they will be told)</label>
      <input id="roReason" placeholder="e.g. attendance figures need correcting"></div>
    <div class="modal-actions"><button class="btn btn-secondary" id="roCancel">Cancel</button>
      <button class="btn btn-primary" id="roGo">Reopen</button></div>
  </div></div>`;
  document.body.appendChild(body);
  body.querySelector('#roCancel').onclick = () => body.remove();
  body.querySelector('#roGo').onclick = async () => {
    const reason = body.querySelector('#roReason').value.trim();
    if (!reason) { toast('Say why it is being reopened.', true); return; }
    try {
      await api('/entry/reopen-quarter', { method: 'POST', body: {
        year: boardYear, quarter, entityType, entityId,
        window: body.querySelector('#roWindow').value, reason,
      } });
      body.remove(); toast('Reopened \u2014 they have been told'); loadBoard();
    } catch (e) { toast(e.message, true); }
  };
}

let boardYear = null;
async function loadBoard() {
  const host = document.getElementById('boardCard');
  if (!host) return;
  // Must match canViewAll() on the server exactly - admin tier, congregation.view
  // OR approvals.manage. It used to omit approvals.manage, so a Session Clerk
  // whose congregation.view had been trimmed would be allowed by the API and
  // shown nothing by the page. A client gate narrower than the server's is a
  // disappearing feature; wider is a dead card. Keep them identical.
  const perms = me.permissions || [];
  if (!(isElevated(me) || perms.includes('congregation.view') || perms.includes('approvals.manage'))) { host.innerHTML = ''; return; }
  let b;
  try { b = await api(`/entry/submission-board?quarter=${quarter}`); }
  catch (e) { host.innerHTML = `<div class="card" style="margin-bottom:20px;"><p class="sub">Submission board unavailable \u2014 ${esc(e.message)}</p></div>`; return; }

  boardYear = b.year;
  boardDeadlineAhead = b.daysLeft >= 0;
  const perms2 = me.permissions || [];
  boardCanReopen = isElevated(me) || perms2.includes('approvals.manage');
  const when = iso => iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
  const row = r => `<tr>
      <td>${esc(r.name)}<div class="sub" style="font-size:11.5px;">${r.entityType === 'committee' ? 'Committee' : 'Group'}</div></td>
      <td><span class="badge ${BOARD_STATUS[r.status].cls}">${BOARD_STATUS[r.status].label}</span></td>
      <td class="sub">${r.submittedBy ? esc(r.submittedBy) : '\u2014'}</td>
      <td class="sub">${r.submittedAt ? when(r.submittedAt) : '\u2014'}${
        r.openEnded ? '<br><span style="font-size:11px;">unlocked by an admin \u2014 no expiry</span>'
        : r.reopenedUntil ? `<br><span style="font-size:11px;">open until ${when(r.reopenedUntil)}</span>` : ''}</td>
      <td>${r.canReopen && boardCanReopen
        ? `<button class="btn btn-secondary btn-sm" onclick="openReopen('${r.entityType}',${r.entityId},${JSON.stringify(r.name).replace(/"/g, '&quot;')})">Reopen</button>`
        : ''}</td>
    </tr>`;
  // Submitted, then reopened, then not submitted. The list reads as progress
  // through the quarter rather than as a complaint: what is done, what is in
  // hand, what is still missing. The counts in the heading carry the urgency.
  const order = { submitted: 0, reopened: 1, outstanding: 2 };
  const rows = b.rows.slice().sort((x, y) => order[x.status] - order[y.status]);

  const late = b.daysLeft < 0;
  const deadline = late
    ? `<b>The Q${b.quarter} deadline passed ${Math.abs(b.daysLeft)} day${Math.abs(b.daysLeft) === 1 ? '' : 's'} ago.</b>`
    : `${b.daysLeft} day${b.daysLeft === 1 ? '' : 's'} to the Q${b.quarter} deadline.`;

  host.innerHTML = `<div class="card" style="margin-bottom:20px; border-top:3px solid ${b.outstanding ? 'var(--pcg-red)' : 'var(--pcg-green)'};">
    <div class="section-title" style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
      <h3>Q${b.quarter} ${b.year} submissions \u2014 ${b.submitted} of ${b.total} in</h3>
      <button class="btn btn-secondary btn-sm" id="boardImgBtn" onclick="downloadBoardImage()">\u2b07 Download image</button>
    </div>
    <p class="sub" style="margin:0 0 10px;">
      ${b.outstanding ? `<b>${b.outstanding} still to come.</b>` : '<b>Everyone is in.</b>'}
      ${b.reopened ? ` ${b.reopened} reopened for changes.` : ''}
      ${deadline}</p>
    <table>
      <thead><tr><th style="width:38%;">Committee / Group</th><th>Status</th><th>Submitted by</th><th>When</th><th></th></tr></thead>
      <tbody>${rows.map(row).join('')}</tbody>
    </table>
    <p class="sub" style="margin:10px 0 0;">Submitting is what locks a quarter \u2014 there is no separate final-draft step. A reopened
      quarter is editable until the date shown, then re-locks on resubmission.</p>
  </div>`;
}
