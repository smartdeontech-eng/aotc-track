// Elections — the officers' page. CLAN (elections.manage) sets up and runs an
// election; the Session Clerk (approvals.manage) confirms it and certifies the
// result. Everything is wrapped in one function so no name here can clash with
// app.js (scripts/test-global-clashes.js checks that on every deploy).
(function () {
  'use strict';
  let me = null, groups = [], committees = [];
  let detail = null, voters = [], tab = 'overview', poll = null;
  let review = { rows: [], source: 'excel' };
  let candEdit = null, voterEdit = null, posEdit = null, officerOptions = null;
  const $ = id => document.getElementById(id);

  const STATUS = {
    draft: ['Being set up', 'badge-idle'],
    pending: ['Waiting for the Session Clerk', 'badge-attention'],
    confirmed: ['Confirmed — polls not yet open', 'badge-info'],
    open: ['Polls open', 'badge-bright-ok'],
    closed: ['Polls closed', 'badge-progress'],
    certified: ['Results certified', 'badge-done'],
  };
  const SMS = { sent: 'sent', failed: 'FAILED', skipped: 'not sent', sending: 'sending…' };
  const perms = () => (me && me.permissions) || [];
  const canManage = () => isElevated(me) || perms().includes('elections.manage');
  const canConfirm = () => isElevated(me) || perms().includes('approvals.manage');
  const fmtDT = iso => iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '—';
  const fmtT = iso => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
  const pad = n => String(n).padStart(2, '0');
  const toLocalInput = iso => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fromLocalInput = v => v ? new Date(v).toISOString() : null;
  const badge = s => `<span class="badge ${(STATUS[s] || ['', 'badge-idle'])[1]}">${esc((STATUS[s] || [s])[0])}</span>`;
  const initials = n => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  const photo = (url, name, size = 44) => url
    ? `<img class="el-ph" src="${esc(url)}" alt="" style="width:${size}px;height:${size}px;">`
    : `<span class="el-ph" style="width:${size}px;height:${size}px;">${esc(initials(name))}</span>`;
  function show(id, on) { const el = $(id); if (el) el.style.display = on ? '' : 'none'; }
  function openModal(id) { $(id).style.display = 'flex'; }
  function closeModals() { document.querySelectorAll('.modal-overlay').forEach(m => { m.style.display = 'none'; }); }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch (e) { await promptDialog('Copy this:', { title: 'Copy', defaultValue: text, okText: 'Done' }); }
  }
  function fileToBase64(file) {
    return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(file); });
  }

  // ------------------------------------------------------------ list
  async function loadList() {
    stopPoll();
    detail = null;
    show('elListPane', true); show('elDetailPane', false); show('elBack', false);
    show('elNew', canManage());
    $('elH1').textContent = 'Elections';
    $('elSub').textContent = 'Group elections run by CLAN and confirmed by the Session Clerk';
    let list;
    try { list = await api('/elections'); } catch (e) { $('elList').innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }
    $('elList').innerHTML = list.length ? list.map(e => `
      <div class="card el-row" data-act="open" data-id="${e.id}">
        <div>
          <div style="font-weight:700; font-size:15.5px;">${esc(e.title)}</div>
          <div class="sub">${esc(e.entityName || '')} · ${fmtDT(e.openAt)} → ${fmtDT(e.closeAt)}</div>
        </div>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <span class="sub">${e.voted} of ${e.voters} voted</span>${badge(e.status)}
        </div>
      </div>`).join('')
      : `<div class="card"><p class="sub" style="margin:0;">No elections yet.${canManage() ? ' Start one with <b>+ New election</b>.' : ''}</p></div>`;
  }

  // ------------------------------------------------------------ detail
  async function openDetail(id, keepTab) {
    history.replaceState(null, '', `/elections.html?id=${id}`);
    try { detail = await api(`/elections/${id}`); }
    catch (e) { toast(e.message, true); return loadList(); }
    if (!keepTab) tab = 'overview';
    show('elListPane', false); show('elDetailPane', true); show('elBack', true); show('elNew', false);
    render();
    if (tab === 'voters') loadVoters();
    startPoll();
  }
  async function refresh() {
    if (!detail) return;
    try { detail = await api(`/elections/${detail.election.id}`); } catch (e) { return; }
    render();
    if (tab === 'voters') loadVoters();
  }
  function startPoll() {
    stopPoll();
    const s = detail && detail.election.status;
    if (s === 'open' || s === 'confirmed' || s === 'pending') poll = setInterval(refresh, s === 'open' ? 6000 : 20000);
  }
  function stopPoll() { if (poll) clearInterval(poll); poll = null; }

  function render() {
    const d = detail, e = d.election, snap = d.snapshot;
    $('elH1').textContent = e.title;
    $('elSub').textContent = e.entityName || '';
    $('elStatus').innerHTML = badge(e.status);
    // The highlighted step is the one happening or awaited now.
    const cur = { draft: 0, pending: 1, confirmed: 2, open: 2, closed: 4, certified: 5 }[e.status] ?? 0;
    const steps = ['Set up by CLAN', 'Confirmed by Session Clerk', 'Polls open', 'Polls closed', 'Certified'];
    $('elSteps').innerHTML = steps.map((label, i) => `<span class="el-step ${i < cur ? 'done' : i === cur ? 'now' : ''}">${label}</span>`).join('');
    $('elWindow').textContent = `Polls: ${fmtDT(e.openAt)} → ${fmtDT(e.closeAt)}`;

    // Notice
    let notice = '';
    if (e.status === 'draft' && e.returnNote) notice = `<div class="el-note"><b>Returned for changes:</b> ${esc(e.returnNote)}</div>`;
    if (e.status === 'pending') notice = `<div class="el-note">${canConfirm() ? 'Check the ballot, the voters&rsquo; list and the polling times, then <b>Confirm</b>. Confirming locks the list and the ballot.' : 'Sent to the Session Clerk. Nothing can change until it is confirmed or returned.'}</div>`;
    if (e.status === 'confirmed') notice = `<div class="el-note">Polls open automatically at <b>${fmtDT(e.openAt)}</b>. At that moment every voter receives their code and the voting link by SMS.</div>`;
    if (e.status === 'open' && d.sms && (d.sms.failed || d.sms.none)) notice = `<div class="el-note">${d.sms.failed ? `<b>${d.sms.failed}</b> SMS failed. ` : ''}${d.sms.none ? `<b>${d.sms.none}</b> voter(s) have no code yet. ` : ''}Use <b>Send missing codes</b>, or fix numbers in the Voters tab.</div>`;
    if (e.status === 'closed') {
      const s = d.signoff || {};
      const missing = [['president', 'President'], ['groupWitness', 'group witness'], ['clanCoordinator', 'CLAN Coordinator'], ['clanWitness', 'CLAN witness'], ['sessionClerk', 'Session Clerk']].filter(([k]) => !s[k]).map(([, l]) => l);
      if (missing.length) notice = `<div class="el-note">Before printing the report, add the sign-off names in <b>Settings</b> (missing: ${esc(missing.join(', '))}).</div>`;
    }
    $('elNotice').innerHTML = notice;

    // Actions
    const A = [];
    const m = canManage(), c = canConfirm(), officer = m || c;
    if (e.status === 'draft' && m) A.push(['submit', 'Send to the Session Clerk', 'btn-primary']);
    if (e.status === 'pending' && c) { A.push(['confirm', 'Confirm election', 'btn-primary']); A.push(['return', 'Return for changes', 'btn-secondary']); }
    else if (e.status === 'pending' && m) A.push(['return', 'Withdraw to make changes', 'btn-secondary']);
    if (e.status === 'confirmed' && officer) { A.push(['openNow', 'Open polls now', 'btn-primary']); A.push(['extend', 'Change closing time', 'btn-secondary']); A.push(['return', 'Return for changes', 'btn-secondary']); }
    if (e.status === 'open' && officer) { A.push(['sendCodes', 'Send missing codes', 'btn-secondary']); A.push(['extend', 'Change closing time', 'btn-secondary']); A.push(['close', 'Close polls now', 'btn-danger']); }
    if (e.status === 'closed' && c) A.push(['certify', 'Certify results', 'btn-primary']);
    if (['closed', 'certified'].includes(e.status)) { A.push(['pdf', 'Report (PDF)', 'btn-secondary']); A.push(['docx', 'Report (Word)', 'btn-secondary']); }
    $('elActions').innerHTML = A.map(([act, label, cls]) => `<button class="btn ${cls}" data-act="${act}">${label}</button>`).join('');

    // Overview
    $('elStats').innerHTML = [
      ['Eligible voters', snap.eligible, ''],
      ['Votes cast', snap.voted, snap.lastVoteAt ? `last at ${fmtT(snap.lastVoteAt)}` : ''],
      ['Turnout', `${snap.turnoutPct}%`, ''],
      ['At booths / online', `${snap.byChannel.booth} / ${snap.byChannel.online}`, ''],
      ['Code SMS', `${d.sms.sent || 0} sent`, `${d.sms.failed || 0} failed · ${d.sms.skipped || 0} not sent`],
    ].map(([l, v, s]) => `<div class="stat-card"><div class="label">${l}</div><div class="value">${esc(v)}</div>${s ? `<div class="sub">${esc(s)}</div>` : ''}</div>`).join('');
    $('elLinks').innerHTML = `
      <div style="display:grid; gap:12px;">
        <div><div class="sub" style="margin-bottom:4px;"><b>Voting link</b> — goes out in every voter&rsquo;s SMS with their code</div>
          <div class="el-link"><code>${esc(snap.voteUrl)}</code><button class="btn btn-secondary btn-sm" data-act="copy" data-text="${esc(snap.voteUrl)}">Copy</button></div></div>
        <div><div class="sub" style="margin-bottom:4px;"><b>Live display link</b> — for the screens at the venue; updates the moment a vote is cast (${e.liveMode === 'full' ? 'shows running totals' : 'shows turnout only until polls close'})</div>
          <div class="el-link"><code>${esc(snap.liveUrl)}</code><button class="btn btn-secondary btn-sm" data-act="copy" data-text="${esc(snap.liveUrl)}">Copy</button><a class="btn btn-secondary btn-sm" href="${esc(snap.liveUrl)}" target="_blank" rel="noopener">Open</a>${m ? '<button class="btn btn-secondary btn-sm" data-act="newDisplay">New link</button>' : ''}</div></div>
      </div>`;
    $('elLiveTag').textContent = e.status === 'open' ? 'updating live' : '';
    renderResults(snap);
    $('elEvents').innerHTML = d.events.length ? `<table><tbody>${d.events.map(x => `<tr><td style="white-space:nowrap;">${fmtDT(x.at)}</td><td>${esc(x.actor)}</td><td>${esc(x.detail || x.type)}</td></tr>`).join('')}</tbody></table>` : 'Nothing yet.';

    renderBallot();
    renderBooths();
    renderOfficers();
    renderSettings();
    renderVoterTools();
    setTab(tab);
  }

  function renderResults(snap) {
    if (!snap.results) {
      $('elResultsTitle').textContent = 'Results';
      $('elResults').innerHTML = `<p class="sub" style="margin:0;">${snap.election.status === 'open' || snap.election.status === 'confirmed'
        ? 'Hidden until polls close (this election shows turnout only while voting is going on).'
        : 'Results appear here once voting has started.'}</p>`;
      return;
    }
    $('elResultsTitle').textContent = ['closed', 'certified'].includes(snap.election.status) ? 'Results' : 'Running totals';
    $('elResults').innerHTML = snap.results.map(r => {
      const head = `<div style="font-weight:700; margin:12px 0 4px;">${esc(r.title)}${r.seats > 1 ? ` <span class="sub">(${r.seats} seats)</span>` : ''}${r.mode === 'yesno' ? ' <span class="badge badge-idle">unopposed</span>' : ''}</div>`;
      if (r.mode === 'pick') {
        return head + r.options.map(o => `<div class="el-res-row">${photo(o.photo, o.name, 36)}<div><div>${esc(o.name)}${o.leading ? ' <span class="badge badge-done">leading</span>' : ''}</div><div class="el-bar"><span style="width:${o.pct}%"></span></div></div><div style="text-align:right;"><b>${o.votes}</b> <span class="sub">${o.pct}%</span></div></div>`).join('')
          + `<div class="sub">Left blank: ${r.skipped}${r.tieAtCut ? ' · <b style="color:var(--red)">tie at the last seat</b> — the Session Clerk directs how it is resolved' : ''}</div>`;
      }
      return head + r.options.map(o => `<div class="el-res-row">${photo(o.photo, o.name, 36)}<div><div>${esc(o.name)} — ${o.carried ? '<span class="badge badge-done">endorsed</span>' : '<span class="badge badge-critical">not endorsed</span>'}</div><div class="el-bar"><span style="width:${o.yesPct}%; background:var(--pcg-green)"></span></div></div><div style="text-align:right;">Yes <b>${o.yes}</b> · No <b>${o.no}</b></div></div>`).join('');
    }).join('');
  }

  // ------------------------------------------------------------ ballot
  function renderBallot() {
    const draft = detail.election.status === 'draft' && canManage();
    show('elAddPos', draft);
    $('elBallot').innerHTML = detail.positions.length ? detail.positions.map(p => `
      <div class="el-pos">
        <div class="el-pos-head">
          <div><b>${esc(p.title)}</b> <span class="sub">${p.seats} seat${p.seats > 1 ? 's' : ''} · ${p.mode === 'yesno' ? 'unopposed — Yes / No' : 'contested'}</span></div>
          ${draft ? `<div class="el-actions"><button class="btn btn-secondary btn-sm" data-act="addCand" data-pid="${p.id}">+ Candidate</button><button class="btn btn-secondary btn-sm" data-act="editPos" data-pid="${p.id}">Edit</button><button class="btn btn-danger btn-sm" data-act="delPos" data-pid="${p.id}">Remove</button></div>` : ''}
        </div>
        <div class="el-cands">${p.candidates.map(c => `
          <div class="el-cand">${photo(c.photo, c.name)}<div style="flex:1;">${esc(c.name)}</div>
            ${draft ? `<button class="btn btn-secondary btn-sm" data-act="editCand" data-pid="${p.id}" data-cid="${c.id}">Edit</button><button class="btn btn-danger btn-sm" data-act="delCand" data-cid="${c.id}">✕</button>` : ''}
          </div>`).join('') || '<span class="sub">No candidates yet.</span>'}</div>
      </div>`).join('') : `<div class="card"><p class="sub" style="margin:0;">No positions yet.${draft ? ' Add the first one, e.g. President.' : ''}</p></div>`;
  }

  // ------------------------------------------------------------ voters
  function renderVoterTools() {
    const e = detail.election;
    const draft = e.status === 'draft' && canManage();
    const officer = canManage() || canConfirm();
    const t = [];
    if (draft) {
      if (e.entity && e.entity.type !== 'congregation') t.push(['fromMembers', `Load ${esc(e.entityName)} members`, 'btn-primary']);
      t.push(['upload', 'Upload Excel / CSV', 'btn-secondary'], ['template', 'Download template', 'btn-secondary'], ['addVoter', 'Add one person', 'btn-secondary']);
      if (detail.voterCount) t.push(['clearVoters', 'Clear the list', 'btn-danger']);
    }
    if (e.status === 'open' && officer) t.push(['sendCodes', 'Send missing codes', 'btn-secondary']);
    $('elVoterTools').innerHTML = t.map(([a, l, c]) => `<button class="btn ${c} btn-sm" data-act="${a}">${l}</button>`).join('');
    $('elVoterCount').textContent = `${detail.voterCount} on the list${detail.locked ? ` · ${detail.locked} locked` : ''}`;
    $('elVoterHelp').innerHTML = draft
      ? `One voter per phone number. The file needs <b>Name</b> and <b>Phone</b> columns${e.verifyDob ? ', and <b>Date of birth</b> (this election checks it)' : ''}${e.verifyMemberNo ? ', and <b>Member No.</b> (this election checks it)' : ''}. Everything is checked and shown to you before it is saved.`
      : e.status === 'open' ? 'If someone did not get their code, use <b>Resend</b> on their row. A wrong number can be corrected (with a reason, which goes in the report).'
      : 'The list was locked when the Session Clerk confirmed the election.';
  }
  async function loadVoters() {
    try { voters = await api(`/elections/${detail.election.id}/voters`); } catch (e) { return; }
    renderVoters();
  }
  function renderVoters() {
    const e = detail.election;
    const q = ($('elVoterSearch').value || '').trim().toLowerCase();
    const list = voters.filter(v => !q || v.name.toLowerCase().includes(q) || v.phone.includes(q.replace(/\D/g, '') || '~'));
    const draft = e.status === 'draft' && canManage();
    const live = e.status === 'open' && (canManage() || canConfirm());
    $('elVoters').innerHTML = list.map(v => `<tr>
      <td>${esc(v.name)}${v.locked ? ' <span class="badge badge-critical">locked</span>' : ''}</td>
      <td class="mono">${esc(v.phone)}</td>
      <td>${esc(v.dob || '')}</td><td>${esc(v.memberNo || '')}</td>
      <td>${v.sms ? `${SMS[v.sms.status] || esc(v.sms.status)} <span class="sub">${fmtT(v.sms.at)}</span>` : '<span class="sub">—</span>'}</td>
      <td>${v.voted ? `<span class="badge badge-done">${fmtT(v.voted.at)}</span> <span class="sub">${esc(v.voted.booth || 'online')}</span>` : ''}</td>
      <td style="white-space:nowrap; text-align:right;">
        ${draft ? `<button class="btn btn-secondary btn-sm" data-act="editVoter" data-vid="${v.id}">Edit</button> <button class="btn btn-danger btn-sm" data-act="delVoter" data-vid="${v.id}">✕</button>` : ''}
        ${live && !v.voted ? `<button class="btn btn-secondary btn-sm" data-act="resend" data-vid="${v.id}">Resend</button> <button class="btn btn-secondary btn-sm" data-act="fixPhone" data-vid="${v.id}">Fix number</button>` : ''}
        ${live && v.locked ? ` <button class="btn btn-secondary btn-sm" data-act="unlockVoter" data-vid="${v.id}">Unlock</button>` : ''}
      </td></tr>`).join('') || `<tr><td colspan="7" class="sub">${voters.length ? 'No match.' : 'No voters yet.'}</td></tr>`;
  }

  function showReview(data, source) {
    review = { rows: data.rows, source };
    $('elReviewSummary').innerHTML = `<b>${data.ok}</b> ready to add${data.problems ? ` · <b style="color:var(--red)">${data.problems}</b> will be left out (shown in red — fix them in the file or add them one by one)` : ''}.`;
    $('elReviewRows').innerHTML = data.rows.map(r => `<tr class="${r.status}">
      <td>${r.line}</td><td>${esc(r.name)}</td><td class="mono">${esc(r.phone)}</td><td>${esc(r.dob || '')}</td><td>${esc(r.memberNo || '')}</td>
      <td class="${r.status === 'ok' ? '' : 'err'}">${r.status === 'ok' ? '✓' : esc(r.issues.join('; '))}</td></tr>`).join('');
    $('elReviewSave').textContent = `Add ${data.ok} voter${data.ok === 1 ? '' : 's'}`;
    $('elReviewSave').disabled = !data.ok;
    openModal('elReviewOverlay');
  }

  // ------------------------------------------------------------ booths
  function renderBooths() {
    const e = detail.election;
    const over = ['closed', 'certified'].includes(e.status);
    show('elAddBooth', canManage() && !over);
    const votes = new Map(detail.snapshot.booths.map(b => [b.id, b.votes]));
    const origin = location.origin;
    $('elBooths').innerHTML = detail.booths.map(b => {
      const link = `${origin}/booth/${b.token}`;
      return `<tr>
        <td><b>${esc(b.name)}</b>${b.unlockedAt ? `<div class="sub">unlocked ${fmtDT(b.unlockedAt)}</div>` : '<div class="sub">not yet unlocked on a laptop</div>'}</td>
        <td>${votes.get(b.id) || 0}${b.lastVoteAt ? ` <span class="sub">last ${fmtT(b.lastVoteAt)}</span>` : ''}</td>
        <td>${b.enabled ? '<span class="badge badge-done">on</span>' : '<span class="badge badge-critical">off</span>'}</td>
        <td><div class="el-link"><code>${esc(link)}</code><button class="btn btn-secondary btn-sm" data-act="copy" data-text="${esc(link)}">Copy</button></div></td>
        <td style="white-space:nowrap; text-align:right;">${!over && (canManage() || canConfirm()) ? `<button class="btn btn-secondary btn-sm" data-act="toggleBooth" data-bid="${b.id}" data-on="${b.enabled ? 0 : 1}">${b.enabled ? 'Switch off' : 'Switch on'}</button>` : ''}
          ${!over && canManage() ? ` <button class="btn btn-secondary btn-sm" data-act="boothPin" data-bid="${b.id}">New PIN</button> <button class="btn btn-danger btn-sm" data-act="delBooth" data-bid="${b.id}">✕</button>` : ''}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="5" class="sub">No booths. Add one for each laptop at the venue; online voters need none.</td></tr>`;
  }

  // ------------------------------------------------------------ polling officers
  function renderOfficers() {
    const e = detail.election, list = e.officers || [];
    const can = canManage() && ['draft', 'pending', 'confirmed', 'open'].includes(e.status);
    const box = $('elOfficers');
    if (box.contains(document.activeElement)) return;
    const chips = list.length ? list.map(o => `<span class="el-cand" style="min-width:0;">${esc(o.name)}${can ? ` <button class="btn btn-secondary btn-sm" data-act="delOfficer" data-uid="${o.userId}" title="Remove">✕</button>` : ''}</span>`).join('')
      : '<span class="sub">No polling officers named yet. The CLAN Coordinator can always use the desk.</span>';
    const taken = new Set(list.map(o => o.userId));
    const opts = (officerOptions || []).filter(u => !taken.has(u.id));
    box.innerHTML = `<div class="el-cands" style="margin-top:0;">${chips}</div>
      ${can ? `<div style="display:flex; gap:8px; margin-top:12px; flex-wrap:wrap;">
        <select id="elOfficerPick" style="max-width:340px;">${officerOptions ? `<option value="">Choose a person with an AOTC Track account…</option>${opts.map(u => `<option value="${u.id}">${esc(u.name)}${u.position ? ` — ${esc(u.position)}` : ''}</option>`).join('')}` : '<option value="">Loading…</option>'}</select>
        <button class="btn btn-secondary" data-act="addOfficer">Add officer</button></div>` : ''}`;
    if (can && !officerOptions) api(`/elections/${e.id}/officers/options`).then(r => { officerOptions = r; renderOfficers(); }).catch(() => { officerOptions = []; });
  }
  async function saveOfficers(ids) {
    const r = await api(`/elections/${eid()}/officers`, { method: 'PUT', body: { userIds: ids } });
    detail.election.officers = r.officers; renderOfficers();
  }

  // ------------------------------------------------------------ settings form (new + edit)
  function entityOptions(sel) {
    const opt = (v, l) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${esc(l)}</option>`;
    return `<optgroup label="Groups">${groups.map(g => opt(`group:${g.id}`, g.name)).join('')}</optgroup>`
      + `<optgroup label="Committees">${committees.map(c => opt(`committee:${c.id}`, c.name)).join('')}</optgroup>`
      + `<optgroup label="Other">${opt('congregation:0', 'Whole congregation')}</optgroup>`;
  }
  function formHtml(e, editable) {
    const dis = editable ? '' : 'disabled';
    const ent = e && e.entity ? `${e.entity.type}:${e.entity.id}` : (groups[0] ? `group:${groups[0].id}` : 'congregation:0');
    return `
      <div class="field"><label>Title</label><input type="text" name="title" ${dis} required value="${esc(e ? e.title : '')}" placeholder="e.g. YPG Executive Elections 2026"></div>
      <div class="field-row">
        <div class="field"><label>For</label><select name="entity" ${dis}>${entityOptions(ent)}</select></div>
        <div class="field"><label>Short name for the SMS <span class="sub">(optional, 38 letters)</span></label><input type="text" name="smsTitle" maxlength="38" ${dis} value="${esc(e ? e.smsTitle || '' : '')}" placeholder="e.g. YPG Elections"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Polls open</label><input type="datetime-local" name="openAt" ${dis} required value="${toLocalInput(e && e.openAt)}"></div>
        <div class="field"><label>Polls close</label><input type="datetime-local" name="closeAt" ${dis} required value="${toLocalInput(e && e.closeAt)}"></div>
      </div>
      <div class="field"><label>Extra identity check after the SMS code</label>
        <label style="display:flex; gap:8px; font-weight:400;"><input type="checkbox" name="verifyDob" style="width:auto;" ${dis} ${e && e.verifyDob ? 'checked' : ''}> Date of birth (must be on the voters&rsquo; list)</label>
        <label style="display:flex; gap:8px; font-weight:400;"><input type="checkbox" name="verifyMemberNo" style="width:auto;" ${dis} ${e && e.verifyMemberNo ? 'checked' : ''}> Member number</label>
      </div>
      <div class="field"><label>Live display screens while polls are open</label>
        <select name="liveMode" ${dis}>
          <option value="turnout" ${!e || e.liveMode !== 'full' ? 'selected' : ''}>Turnout only — results appear when polls close (recommended)</option>
          <option value="full" ${e && e.liveMode === 'full' ? 'selected' : ''}>Full live tallies — candidates&rsquo; votes update as they are cast</option>
        </select>
        <div class="sub" style="margin-top:4px;">With full live tallies, someone watching a screen next to a booth could match a vote to the person who just cast it.</div>
      </div>
      <label style="display:flex; gap:8px; font-weight:400; margin-bottom:12px;"><input type="checkbox" name="shuffle" style="width:auto;" ${dis} ${e && e.shuffle ? 'checked' : ''}> Shuffle the order of candidates for each voter</label>
      <div class="field"><label>Notes for voters <span class="sub">(optional, shown on the voting page)</span></label><textarea name="description" rows="2" ${dis}>${esc(e ? e.description || '' : '')}</textarea></div>
      ${editable ? `<div class="modal-actions">${e ? '<button type="button" class="btn btn-danger" data-act="delElection">Delete election</button>' : '<button type="button" class="btn btn-secondary" data-close>Cancel</button>'}<button type="submit" class="btn btn-primary">${e ? 'Save settings' : 'Create election'}</button></div>`
        : '<p class="sub">Settings are fixed once the election has gone to the Session Clerk.</p>'}`;
  }
  function readForm(form) {
    const f = new FormData(form);
    const [entityType, entityId] = String(f.get('entity') || 'congregation:0').split(':');
    return {
      title: f.get('title'), smsTitle: f.get('smsTitle'), description: f.get('description'),
      entityType, entityId: Number(entityId),
      openAt: fromLocalInput(f.get('openAt')), closeAt: fromLocalInput(f.get('closeAt')),
      verifyDob: !!f.get('verifyDob'), verifyMemberNo: !!f.get('verifyMemberNo'), shuffle: !!f.get('shuffle'),
      liveMode: f.get('liveMode'),
    };
  }
  function renderSettings() {
    $('elSettings').innerHTML = formHtml(detail.election, detail.election.status === 'draft' && canManage());
    renderSignoff();
  }
  // Who signs the report. CLAN prepares it on behalf of the group: the group's
  // President signs, another executive witnesses; the CLAN Coordinator
  // approves, a CLAN committee member witnesses; the Session Clerk validates.
  function renderSignoff() {
    const e = detail.election, s = detail.signoff || {};
    const form = $('elSignoff');
    if (form.contains(document.activeElement)) return; // don't wipe what someone is typing during a refresh
    const can = (canManage() || canConfirm()) && e.status !== 'certified';
    const dis = can ? '' : 'disabled';
    const g = esc(e.entityName || 'the group');
    const f = (name, label, ph) => `<div class="field"><label>${label}</label><input type="text" name="${name}" maxlength="120" ${dis} value="${esc(s[name] || '')}" placeholder="${esc(ph || '')}"></div>`;
    form.innerHTML = `
      <p class="sub" style="margin-top:0;">CLAN prepares the report on behalf of ${g}. These names are printed under the signature lines.</p>
      <div class="el-sign-tier">${g}</div>
      <div class="field-row">${f('president', `President of ${g} <span class="sub">(signs)</span>`, 'Full name')}${f('groupWitness', 'Executive member <span class="sub">(witnesses)</span>', 'Full name')}</div>
      <div class="field-row">${f('groupWitnessRole', 'Witness&rsquo;s position', 'e.g. Secretary')}<div class="field"></div></div>
      <div class="el-sign-tier">CLAN</div>
      <div class="field-row">${f('clanCoordinator', 'CLAN Coordinator <span class="sub">(approves)</span>', 'Full name')}${f('clanWitness', 'CLAN committee member <span class="sub">(witnesses)</span>', 'Full name')}</div>
      <div class="el-sign-tier">The Session</div>
      <div class="field-row">${f('sessionClerk', 'Session Clerk <span class="sub">(validates)</span>', 'Full name')}<div class="field"></div></div>
      ${can ? '<div class="modal-actions"><button type="submit" class="btn btn-primary">Save names</button></div>' : `<p class="sub">${e.status === 'certified' ? 'Fixed now that the results are certified.' : 'Only the election officer or the Session Clerk can change these.'}</p>`}`;
  }

  // ------------------------------------------------------------ tabs
  function setTab(t) {
    tab = t;
    document.querySelectorAll('#elTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === t));
    document.querySelectorAll('[data-pane]').forEach(p => { p.style.display = p.dataset.pane === t ? '' : 'none'; });
  }

  // ------------------------------------------------------------ actions
  const eid = () => detail.election.id;
  async function act(a, el) {
    const d = el.dataset;
    try {
      switch (a) {
        case 'open': return openDetail(Number(d.id));
        case 'copy': return copy(d.text);
        case 'submit':
          if (!await confirmDialog('Send this election to the Session Clerk to confirm? You will not be able to change it unless it is returned.', { title: 'Send for confirmation', okText: 'Send' })) return;
          await api(`/elections/${eid()}/submit`, { method: 'POST' }); toast('Sent to the Session Clerk'); return refresh().then(startPoll);
        case 'confirm':
          if (!await confirmDialog(`Confirm "${detail.election.title}"? The voters' list (${detail.voterCount}) and the ballot are locked, and polls open automatically at ${fmtDT(detail.election.openAt)}.`, { title: 'Confirm election', okText: 'Confirm' })) return;
          await api(`/elections/${eid()}/confirm`, { method: 'POST' }); toast('Election confirmed'); return refresh().then(startPoll);
        case 'return': {
          const note = await promptDialog('What needs changing? (sent back with the election)', { title: 'Return for changes', multiline: true, okText: 'Return' });
          if (note === null) return;
          await api(`/elections/${eid()}/return`, { method: 'POST', body: { note } }); toast('Returned for changes'); return refresh();
        }
        case 'openNow':
          if (!await confirmDialog('Open the polls now? Every voter is sent their code by SMS straight away.', { title: 'Open polls', okText: 'Open now' })) return;
          await api(`/elections/${eid()}/open`, { method: 'POST' }); toast('Polls open — codes are going out'); return refresh().then(startPoll);
        case 'close':
          if (!await confirmDialog('Close the polls now? Codes stop working at once and nobody else can vote.', { title: 'Close polls', okText: 'Close polls', danger: true })) return;
          await api(`/elections/${eid()}/close`, { method: 'POST' }); toast('Polls closed'); return refresh().then(startPoll);
        case 'extend': {
          const v = await promptDialog('New closing time (e.g. 2026-10-18 17:30)', { title: 'Change closing time', defaultValue: toLocalInput(detail.election.closeAt).replace('T', ' '), okText: 'Save' });
          if (v === null) return;
          await api(`/elections/${eid()}/extend`, { method: 'POST', body: { closeAt: fromLocalInput(String(v).trim().replace(' ', 'T')) } }); toast('Closing time changed'); return refresh();
        }
        case 'certify':
          if (!await confirmDialog('Certify these results as final?', { title: 'Certify results', okText: 'Certify' })) return;
          await api(`/elections/${eid()}/certify`, { method: 'POST' }); toast('Results certified'); return refresh();
        case 'pdf': return openReport('pdf');
        case 'docx': return openReport('docx');
        case 'sendCodes': {
          const r = await api(`/elections/${eid()}/send-codes`, { method: 'POST' }); toast(r.message); return setTimeout(refresh, 2500);
        }
        case 'newDisplay':
          if (!await confirmDialog('Replace the live display link? Screens using the old link stop updating.', { title: 'New display link', okText: 'Replace' })) return;
          await api(`/elections/${eid()}/display/reset`, { method: 'POST' }); return refresh();
        case 'delElection':
          if (!await confirmDialog('Delete this election and everything in it?', { title: 'Delete election', okText: 'Delete', danger: true })) return;
          await api(`/elections/${eid()}`, { method: 'DELETE' }); toast('Deleted'); history.replaceState(null, '', '/elections.html'); return loadList();
        // ballot
        case 'editPos': {
          const p = detail.positions.find(x => x.id === Number(d.pid));
          posEdit = p; $('elPosTitle').textContent = 'Edit position'; $('elPosName').value = p.title; $('elPosSeats').value = p.seats; return openModal('elPosOverlay');
        }
        case 'delPos':
          if (!await confirmDialog('Remove this position and its candidates?', { title: 'Remove position', okText: 'Remove', danger: true })) return;
          await api(`/elections/positions/${d.pid}`, { method: 'DELETE' }); return refresh();
        case 'addCand': case 'editCand': {
          const p = detail.positions.find(x => x.id === Number(d.pid));
          const c = d.cid ? p.candidates.find(x => x.id === Number(d.cid)) : null;
          candEdit = { pid: p.id, cid: c ? c.id : null, photo: undefined };
          $('elCandTitle').textContent = c ? 'Edit candidate' : `Add candidate — ${p.title}`;
          $('elCandName').value = c ? c.name : ''; $('elCandPhoto').value = '';
          $('elCandPreview').style.display = c && c.photo ? '' : 'none'; if (c && c.photo) $('elCandPreview').src = c.photo;
          $('elCandRemoveWrap').style.display = c && c.photo ? 'flex' : 'none'; $('elCandRemove').checked = false;
          return openModal('elCandOverlay');
        }
        case 'delCand':
          if (!await confirmDialog('Remove this candidate?', { title: 'Remove candidate', okText: 'Remove', danger: true })) return;
          await api(`/elections/candidates/${d.cid}`, { method: 'DELETE' }); return refresh();
        // voters
        case 'fromMembers': {
          const r = await api(`/elections/${eid()}/voters/preview`, { method: 'POST', body: { source: 'members' } }); return showReview(r, 'members');
        }
        case 'upload': return $('elFile').click();
        case 'template': return download(`/api/elections/${eid()}/voters/template.xlsx`, 'voters-template.xlsx');
        case 'addVoter': case 'editVoter': {
          const v = d.vid ? voters.find(x => x.id === Number(d.vid)) : null;
          voterEdit = { id: v ? v.id : null, fix: false };
          $('elVoterTitle').textContent = v ? 'Edit voter' : 'Add a voter';
          ['elVName', 'elVDob', 'elVNo'].forEach(id => { $(id).disabled = false; $(id).closest('.field').style.display = ''; });
          $('elVDob').closest('.field-row').style.display = '';
          $('elVName').value = v ? v.name : ''; $('elVPhone').value = v ? v.phone : ''; $('elVDob').value = v && v.dob ? v.dob : ''; $('elVNo').value = v ? v.memberNo || '' : '';
          show('elVReasonWrap', false);
          return openModal('elVoterOverlay');
        }
        case 'fixPhone': {
          const v = voters.find(x => x.id === Number(d.vid));
          voterEdit = { id: v.id, fix: true };
          $('elVoterTitle').textContent = `Correct the number for ${v.name}`;
          $('elVName').value = v.name; $('elVPhone').value = v.phone; $('elVReason').value = '';
          ['elVName', 'elVDob', 'elVNo'].forEach(id => { $(id).closest('.field').style.display = id === 'elVName' ? '' : 'none'; });
          $('elVName').disabled = true; $('elVDob').closest('.field-row').style.display = 'none';
          show('elVReasonWrap', true);
          return openModal('elVoterOverlay');
        }
        case 'delVoter':
          await api(`/elections/${eid()}/voters/${d.vid}`, { method: 'DELETE' }); await loadVoters(); return refresh();
        case 'clearVoters':
          if (!await confirmDialog(`Remove all ${detail.voterCount} voters from the list?`, { title: 'Clear the list', okText: 'Clear', danger: true })) return;
          await api(`/elections/${eid()}/voters`, { method: 'DELETE' }); await refresh(); return loadVoters();
        case 'resend': {
          const r = await api(`/elections/${eid()}/voters/${d.vid}/resend`, { method: 'POST' }); toast(`New code: ${r.status}`); return loadVoters();
        }
        case 'unlockVoter':
          await api(`/elections/${eid()}/voters/${d.vid}/unlock`, { method: 'POST' }); toast('Unlocked'); return loadVoters();
        // booths
        case 'addBooth': {
          const name = await promptDialog('Name of the booth (e.g. Booth 1 — Chapel)', { title: 'Add booth', okText: 'Add' });
          if (name === null) return;
          const b = await api(`/elections/${eid()}/booths`, { method: 'POST', body: { name } });
          showPin(b.name, b.pin, b.token); return refresh();
        }
        case 'toggleBooth':
          await api(`/elections/booths/${d.bid}`, { method: 'PUT', body: { enabled: d.on === '1' } }); return refresh();
        case 'boothPin': {
          if (!await confirmDialog('Issue a new PIN? The laptop at this booth must be unlocked again with it.', { title: 'New PIN', okText: 'Issue' })) return;
          const r = await api(`/elections/booths/${d.bid}/pin`, { method: 'POST' });
          const b = detail.booths.find(x => x.id === Number(d.bid)); return showPin(b.name, r.pin, b.token);
        }
        case 'addOfficer': {
          const id = Number($('elOfficerPick').value);
          if (!id) return toast('Choose a person first', true);
          await saveOfficers([...(detail.election.officers || []).map(o => o.userId), id]); return toast('Polling officer added — they have been notified');
        }
        case 'delOfficer':
          await saveOfficers((detail.election.officers || []).map(o => o.userId).filter(x => x !== Number(d.uid))); return toast('Removed');
        case 'delBooth':
          if (!await confirmDialog('Remove this booth?', { title: 'Remove booth', okText: 'Remove', danger: true })) return;
          await api(`/elections/booths/${d.bid}`, { method: 'DELETE' }); return refresh();
      }
    } catch (err) { toast(err.message, true); }
  }
  function showPin(name, pin, token) {
    $('elPinTitle').textContent = `${name} — PIN`;
    $('elPin').textContent = pin;
    $('elPinLink').textContent = `${location.origin}/booth/${token}`;
    openModal('elPinOverlay');
  }
  async function download(url, filename) {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) { let m = 'Could not download.'; try { m = (await res.json()).error || m; } catch (e) {} throw new Error(m); }
    const u = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = u; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  }
  async function openReport(kind) {
    const url = `/api/elections/${eid()}/report.${kind}`;
    if (kind === 'pdf' && window.openDocViewer) { try { return window.openDocViewer(url, `Election report — ${detail.election.title}`); } catch (e) {} }
    if (kind === 'pdf') return window.open(url, '_blank');
    return download(url, `Election-Report-${detail.election.slug}.docx`);
  }

  // ------------------------------------------------------------ wiring
  document.addEventListener('click', e => {
    const closer = e.target.closest('[data-close]');
    if (closer) { closeModals(); return; }
    const el = e.target.closest('[data-act]');
    if (el && (el.closest('#elDetailPane, #elListPane, .modal-overlay, .page-header'))) { e.preventDefault(); act(el.dataset.act, el); }
  });
  $('elTabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]'); if (!b) return;
    setTab(b.dataset.tab);
    if (b.dataset.tab === 'voters') loadVoters();
  });
  $('elBack').onclick = () => { history.replaceState(null, '', '/elections.html'); loadList(); };
  $('elNew').onclick = () => { $('elNewForm').innerHTML = formHtml(null, true); openModal('elNewOverlay'); };
  $('elAddPos').onclick = () => { posEdit = null; $('elPosTitle').textContent = 'Add position'; $('elPosName').value = ''; $('elPosSeats').value = 1; openModal('elPosOverlay'); };
  $('elAddBooth').onclick = e => act('addBooth', e.target);
  $('elVoterSearch').addEventListener('input', renderVoters);

  $('elNewForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const r = await api('/elections', { method: 'POST', body: readForm(e.target) });
      closeModals(); toast('Election created — now add the ballot and the voters'); openDetail(r.id);
    } catch (err) { toast(err.message, true); }
  });
  $('elSettings').addEventListener('submit', async e => {
    e.preventDefault();
    try { await api(`/elections/${eid()}`, { method: 'PUT', body: readForm(e.target) }); toast('Settings saved'); refresh(); }
    catch (err) { toast(err.message, true); }
  });
  $('elSignoff').addEventListener('submit', async e => {
    e.preventDefault();
    const body = Object.fromEntries(new FormData(e.target).entries());
    try {
      const r = await api(`/elections/${eid()}/signoff`, { method: 'PUT', body });
      detail.signoff = r.signoff; document.activeElement && document.activeElement.blur();
      toast('Report names saved'); renderSignoff();
    } catch (err) { toast(err.message, true); }
  });
  $('elPosForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { title: $('elPosName').value, seats: Number($('elPosSeats').value) || 1 };
    try {
      if (posEdit) await api(`/elections/positions/${posEdit.id}`, { method: 'PUT', body });
      else await api(`/elections/${eid()}/positions`, { method: 'POST', body });
      closeModals(); refresh();
    } catch (err) { toast(err.message, true); }
  });
  $('elCandPhoto').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      candEdit.photo = await downscaleImage(f, 480);
      $('elCandPreview').src = candEdit.photo; $('elCandPreview').style.display = '';
    } catch (err) { toast('That picture could not be read.', true); }
  });
  $('elCandForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { name: $('elCandName').value };
    if (candEdit.photo) body.photo = candEdit.photo;
    else if ($('elCandRemove').checked) body.photo = '';
    try {
      if (candEdit.cid) await api(`/elections/candidates/${candEdit.cid}`, { method: 'PUT', body });
      else await api(`/elections/${eid()}/candidates`, { method: 'POST', body: { ...body, positionId: candEdit.pid } });
      closeModals(); refresh();
    } catch (err) { toast(err.message, true); }
  });
  $('elFile').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    if (f.size > 700 * 1024) return toast('That file is too big. Save it as .xlsx with just the list, or split it.', true);
    try {
      const r = await api(`/elections/${eid()}/voters/preview`, { method: 'POST', body: { file: { name: f.name, base64: await fileToBase64(f) } } });
      showReview(r, 'excel');
    } catch (err) { toast(err.message, true); }
  });
  $('elReviewSave').onclick = async () => {
    try {
      const r = await api(`/elections/${eid()}/voters/import`, { method: 'POST', body: { rows: review.rows.filter(x => x.status === 'ok'), source: review.source } });
      closeModals(); toast(`${r.added} voter(s) added`); await refresh(); loadVoters();
    } catch (err) { toast(err.message, true); }
  };
  $('elVoterForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      if (voterEdit.fix) {
        const r = await api(`/elections/${eid()}/voters/${voterEdit.id}`, { method: 'PUT', body: { phone: $('elVPhone').value, reason: $('elVReason').value } });
        toast(r.sms ? `Number corrected; new code ${r.sms}` : 'Number corrected');
      } else {
        const body = { name: $('elVName').value, phone: $('elVPhone').value, dob: $('elVDob').value || null, memberNo: $('elVNo').value };
        if (voterEdit.id) await api(`/elections/${eid()}/voters/${voterEdit.id}`, { method: 'PUT', body });
        else await api(`/elections/${eid()}/voters`, { method: 'POST', body });
      }
      $('elVDob').closest('.field-row').style.display = '';
      closeModals(); await refresh(); loadVoters();
    } catch (err) { toast(err.message, true); }
  });

  requireAuthAndRenderShell().then(async u => {
    me = u;
    try { ({ groups, committees } = await api('/elections/entities')); } catch (e) {}
    const id = Number(new URLSearchParams(location.search).get('id'));
    if (id) openDetail(id); else loadList();
  });
})();
