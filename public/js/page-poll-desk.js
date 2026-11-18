// Elections — the Polling Desk. A voter who comes to the booth without their
// phone sees a polling officer. The officer enters the voter's phone number
// (it must be on the list), checks the date of birth the voter states — or
// confirms they know the person — and releases the ballot to a booth. No code
// is read out and the officer never sees the ballot. When the vote is cast the
// voter's phone gets an SMS saying so.
// Wrapped in one function so nothing here clashes with app.js globals.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const fmtT = iso => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
  const STATE = {
    'waiting at booth': ['Waiting at booth', 'badge-attention'], voting: ['Voting now', 'badge-info'], voted: ['Voted', 'badge-done'],
    'voted elsewhere': ['Voted elsewhere', 'badge-done'], cancelled: ['Cancelled', 'badge-idle'],
    'not picked up': ['Not picked up', 'badge-critical'], 'did not finish': ['Did not finish', 'badge-critical'],
  };
  let elections = [], eid = null, status = null, voter = null, method = null, timer = null;

  async function loadStatus() {
    if (!eid) return;
    try { status = await api(`/elections/${eid}/desk/status`); } catch (e) { $('pdBooths').textContent = e.message; return; }
    const e = status.election;
    $('pdSub').textContent = `${e.title}${e.entityName ? ` — ${e.entityName}` : ''} · ${e.status === 'open' ? `polls close ${fmtT(e.closeAt)}` : 'polls not open'}`;
    $('pdBooths').innerHTML = status.booths.length ? status.booths.map(b => `
      <div class="pd-booth"><div><b>${esc(b.name)}</b><div class="sub">${!b.enabled ? 'switched off' : b.waitingFor ? `waiting for <b>${esc(b.waitingFor)}</b>` : 'ready'}</div></div>
        ${b.waitingFor ? `<button class="btn btn-secondary btn-sm" data-cancel="${b.id}">Cancel</button>` : `<span class="badge ${b.enabled ? 'badge-done' : 'badge-critical'}">${b.enabled ? 'ready' : 'off'}</span>`}</div>`).join('')
      : 'No booths set up for this election.';
    $('pdRecent').innerHTML = status.recent.length ? `<table><tbody>${status.recent.map(r => `<tr><td style="white-space:nowrap;">${fmtT(r.releasedAt)}</td><td>${esc(r.name)}<div class="sub">${esc(r.booth)} · ${esc(r.officer)}</div></td><td><span class="badge ${(STATE[r.state] || ['', 'badge-idle'])[1]}">${esc((STATE[r.state] || [r.state])[0])}</span></td></tr>`).join('')}</tbody></table>` : 'Nothing yet.';
    if (voter) renderVoter(); // keep the booth list in the release form current
  }

  function boothOptions() {
    const list = (status && status.booths || []).filter(b => b.enabled);
    if (!list.length) return '<option value="">No booth is switched on</option>';
    const free = list.find(b => !b.waitingFor);
    return list.map(b => `<option value="${b.id}" ${free && b.id === free.id ? 'selected' : ''} ${b.waitingFor ? 'disabled' : ''}>${esc(b.name)}${b.waitingFor ? ` — waiting for ${esc(b.waitingFor)}` : ''}</option>`).join('');
  }

  function renderVoter(msg) {
    if (!voter) { $('pdVoter').innerHTML = msg ? `<div class="el-err" style="color:var(--red); font-weight:600; margin-top:6px;">${esc(msg)}</div>` : ''; return; }
    const keep = {
      d: $('pdDobD') ? $('pdDobD').value : '', m: $('pdDobM') ? $('pdDobM').value : '', y: $('pdDobY') ? $('pdDobY').value : '',
      note: $('pdNote') ? $('pdNote').value : '', booth: $('pdBooth') ? $('pdBooth').value : '',
    };
    // The 4-second refresh (msg undefined) never redraws under someone typing.
    if (msg === undefined && document.activeElement && $('pdVoter').contains(document.activeElement)) return;
    $('pdVoter').innerHTML = `
      <div class="pd-who"><div><b>${esc(voter.name)}</b><div class="sub">${esc(voter.phone)} · on the voters&rsquo; list, not yet voted</div></div></div>
      <div class="sub" style="font-weight:600;">How have you checked it is really them?</div>
      <div class="pd-method">
        <label class="opt ${method === 'dob' ? 'on' : ''}" ${voter.dobOnList ? '' : 'style="opacity:.55"'}><input type="radio" name="pdM" value="dob" ${method === 'dob' ? 'checked' : ''} ${voter.dobOnList ? '' : 'disabled'}>
          <div><b>They told me their date of birth</b><div class="sub">${voter.dobOnList ? 'Ask them to say it; type what they say. It is checked against the list (you are not shown the date).' : 'No date of birth is on the list for this person.'}</div>
          ${method === 'dob' ? `<div class="pd-dob"><input id="pdDobD" inputmode="numeric" maxlength="2" placeholder="Day"><select id="pdDobM"><option value="">Month</option>${MONTHS.map((x, i) => `<option value="${i + 1}">${x}</option>`).join('')}</select><input id="pdDobY" inputmode="numeric" maxlength="4" placeholder="Year"></div>` : ''}</div></label>
        <label class="opt ${method === 'known' ? 'on' : ''}"><input type="radio" name="pdM" value="known" ${method === 'known' ? 'checked' : ''}>
          <div><b>I know this person</b><div class="sub">Say how — it goes in the election report with your name.</div>
          ${method === 'known' ? '<input id="pdNote" type="text" maxlength="200" placeholder="e.g. same Bible study group" style="margin-top:8px;">' : ''}</div></label>
      </div>
      <div class="field"><label>Send the ballot to</label><select id="pdBooth">${boothOptions()}</select></div>
      ${msg ? `<div style="color:var(--red); font-weight:600; margin:6px 0;">${esc(msg)}</div>` : ''}
      <div style="display:flex; gap:8px; flex-wrap:wrap;"><button class="btn btn-primary" id="pdRelease" ${method ? '' : 'disabled'}>Release ballot to the booth</button><button class="btn btn-secondary" id="pdClear">Next person</button></div>`;
    if ($('pdDobD')) { $('pdDobD').value = keep.d; $('pdDobM').value = keep.m; $('pdDobY').value = keep.y; }
    if ($('pdNote')) $('pdNote').value = keep.note;
    if (keep.booth && [...$('pdBooth').options].some(o => o.value === keep.booth && !o.disabled)) $('pdBooth').value = keep.booth;
    document.querySelectorAll('input[name=pdM]').forEach(r => { r.onchange = () => { method = r.value; renderVoter(''); const f = $('pdDobD') || $('pdNote'); if (f) f.focus(); }; });
    $('pdRelease').onclick = release;
    $('pdClear').onclick = clear;
  }
  function dobValue() {
    const d = Number($('pdDobD').value), m = Number($('pdDobM').value), y = Number($('pdDobY').value);
    if (!d || !m || !y || y < 1900 || d > 31) return '';
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function clear() {
    voter = null; method = null; $('pdPhone').value = ''; $('pdVoter').innerHTML = ''; $('pdPhone').focus();
  }

  async function find(e) {
    e.preventDefault();
    $('pdDone').innerHTML = '';
    voter = null; method = null;
    const phone = $('pdPhone').value.trim();
    if (!phone) return;
    try {
      voter = await api(`/elections/${eid}/desk/lookup`, { method: 'POST', body: { phone } });
      voter.rawPhone = phone;
      method = voter.dobOnList ? 'dob' : null;
      renderVoter('');
      const f = $('pdDobD'); if (f) f.focus();
    } catch (err) { renderVoter(err.message); }
  }
  async function release() {
    const body = { phone: voter.rawPhone, boothId: Number($('pdBooth').value), method };
    if (method === 'dob') { body.dob = dobValue(); if (!body.dob) return renderVoter('Enter the full date of birth they told you: day, month and year.'); }
    if (method === 'known') body.note = $('pdNote').value.trim();
    if (!body.boothId) return renderVoter('No booth is free. Wait for a booth, or switch one on.');
    $('pdRelease').disabled = true;
    try {
      const r = await api(`/elections/${eid}/desk/release`, { method: 'POST', body });
      $('pdDone').innerHTML = `<div class="pd-done">Ballot sent to <b>${esc(r.booth)}</b>. Ask <b>${esc(r.name)}</b> to go to ${esc(r.booth)} now — their ballot opens there by itself within a few seconds.</div>`;
      clear(); loadStatus();
    } catch (err) {
      if (err.status === 409 || err.status === 423) { voter = null; method = null; renderVoter(err.message); }
      else renderVoter(err.message);
    }
  }

  async function pick(id) {
    eid = id; voter = null; method = null;
    $('pdVoter').innerHTML = ''; $('pdDone').innerHTML = '';
    history.replaceState(null, '', `/poll-desk.html?e=${id}`);
    await loadStatus();
    clearInterval(timer); timer = setInterval(loadStatus, 4000);
  }

  document.addEventListener('click', async ev => {
    const b = ev.target.closest('[data-cancel]'); if (!b) return;
    if (!await confirmDialog('Cancel this release? The person will need to come back to the desk.', { title: 'Cancel release', okText: 'Cancel release' })) return;
    try { await api(`/elections/${eid}/desk/cancel`, { method: 'POST', body: { boothId: Number(b.dataset.cancel) } }); loadStatus(); } catch (e) { toast(e.message, true); }
  });
  $('pdFind').addEventListener('submit', find);
  $('pdElection').addEventListener('change', e => pick(Number(e.target.value)));

  requireAuthAndRenderShell('/poll-desk.html').then(async u => {
    if (!u) return;
    try { elections = await api('/elections/desk/mine'); } catch (e) { elections = []; }
    if (!elections.length) {
      $('pdEmpty').style.display = '';
      $('pdEmpty').innerHTML = '<p class="sub" style="margin:0;">You are not a polling officer for any election that is open or about to open. The CLAN Coordinator names the polling officers on the election&rsquo;s Booths tab.</p>';
      return;
    }
    $('pdMain').style.display = '';
    const want = Number(new URLSearchParams(location.search).get('e'));
    const first = elections.find(x => x.id === want) || elections.find(x => x.status === 'open') || elections[0];
    if (elections.length > 1) {
      $('pdElection').style.display = '';
      $('pdElection').innerHTML = elections.map(x => `<option value="${x.id}" ${x.id === first.id ? 'selected' : ''}>${esc(x.title)}</option>`).join('');
    }
    pick(first.id);
    $('pdPhone').focus();
  });
})();
