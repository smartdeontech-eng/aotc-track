// The day is SET UP first, as Sunday attendance is (19 Nov 2026, evening): event,
// date, joint or 1st and 2nd service, optional day target → "Set up the day".
// Until then only the set-up panel shows; after it, the three steps.
// Record fundraising day — one window for the whole day (19 Nov 2026: the day
// and its sheets are one thing). Set up the day (event and its target, date,
// services), 1 print the sheets, 2 enter them as they come back, 3 tally and
// report. The totals form (no sheets) is still there for small days.
// Harvest basket sheets — the entry desk (17 Nov 2026).
// The counting team fills in one printed, numbered sheet per basket; the desk
// types each sheet in as it arrives, several people at once, while counting
// goes on. Type the sheet number and the basket fills itself in; type the
// pieces and lists; type the totals written on the sheet. AOTC Track will not
// save a sheet whose figures do not agree with what is written on it, so a
// typing slip is caught at the desk. The board shows every sheet of the day.
// Uses page-fundraising.js / app.js globals: data, api, toast, esc, gh, r2,
// canManage, load, todayInputValue.
(function () {
  const $ = id => document.getElementById(id);
  const S = { board: null, sheet: null, photoId: null, busy: false, step: null };
  const LISTS = {
    momo: [['name', 'Name or number', 160], ['reference', 'Transaction ID', 130], ['amount', 'Amount', 100, true]],
    cheques: [['number', 'Cheque no.', 110], ['bank', 'Bank', 140], ['amount', 'Amount', 100, true]],
    transfers: [['bank', 'Bank', 140], ['reference', 'Reference', 120], ['amount', 'Amount', 100, true]],
    forex: [['currency', 'Currency', 80], ['amount', 'Amount', 90, true], ['rate', 'Rate', 80, true]],
    ious: [['name', 'Name', 140], ['contact', 'Phone', 110], ['dueDate', 'By (date)', 130, false, 'date'], ['amount', 'Amount', 90, true]],
  };
  const DRAFT_KEY = 'aotc.harvestSheetDraft';
  const num = v => { const x = Number(String(v == null ? '' : v).replace(/[, ]/g, '')); return Number.isFinite(x) ? x : 0; };
  const pad2 = v => String(v).padStart(2, '0');
  const svc = s => s === 'joint' ? 'Joint service' : `${s} service`;
  const day = () => ({ eventId: Number($('sEvent').value), date: $('sDate').value, services: $('sDayType').value });
  const q = () => { const d = day(); return `eventId=${d.eventId}&date=${d.date}&services=${d.services}`; };
  const denoms = () => (S.board && S.board.denominations) || (data && data.denominations) || [];

  // ---- Opening ---------------------------------------------------------------
  function open(eventId, date) {
    if (!data || !data.events.length) return toast('Add the fundraising event first (Events, above).', true);
    fillEvents(eventId);
    $('sDate').value = date || todayInputValue();
    const list = data.entries.filter(e => e.eventId === Number($('sEvent').value) && e.date === $('sDate').value);
    $('sDayType').value = list.some(e => e.service !== 'joint') ? 'dual' : (list.length ? 'joint' : $('sDayType').value || 'joint');
    $('sOverlay').style.display = 'flex';
    S.step = null;
    renderCash(); resetLists(); clearForm();
    refresh().then(() => { restoreDraft(); if (S.step === 'enter') $('sNo').focus(); });
  }
  function fillEvents(selectId) {
    $('sEvent').innerHTML = data.events.map(ev => `<option value="${ev.id}">${esc(ev.name)}</option>`).join('')
      + (canManage() ? '<option value="new">＋ New event…</option>' : '');
    if (selectId) $('sEvent').value = String(selectId);
    S.lastEvent = $('sEvent').value;
  }
  async function newEvent() {
    const name = (prompt('Name of the fundraising event (e.g. Main Harvest):') || '').trim();
    if (!name) { $('sEvent').value = S.lastEvent || ''; return false; }
    const t = prompt(`Target for ${name} in GHS (leave empty for none):`, '');
    try {
      const ev = await api('/fundraising/events', { method: 'POST', body: { name, target: t ? num(t) : null, year: data.year } });
      await load(); fillEvents(ev.id); toast(`${name} added`); return true;
    } catch (e) { toast(e.message, true); $('sEvent').value = S.lastEvent || ''; return false; }
  }
  async function editTarget() {
    const ev = S.board && S.board.event; if (!ev) return;
    const t = prompt(`Target for ${ev.name} in GHS:`, ev.target || '');
    if (t === null) return;
    try { await api(`/fundraising/events/${ev.id}`, { method: 'PUT', body: { target: t ? num(t) : null } }); toast('Target saved'); await load(); refresh(); }
    catch (e) { toast(e.message, true); }
  }
  async function setUpDay(shape, target) {
    const d = day();
    try {
      await api('/fundraising/days', { method: 'POST', body: { eventId: d.eventId, date: d.date, shape, target } });
      toast('Day set up. The desk team has been told.');
      S.step = null; await load(); await refresh();
    } catch (e) { toast(e.message, true); await refresh(); }
  }
  async function editDayTarget() {
    const b = S.board; if (!b || !b.day) return;
    const t = prompt('Target for this day in GHS (leave empty for none):', b.day.target || '');
    if (t === null) return;
    const d = day();
    try { await api('/fundraising/days', { method: 'POST', body: { eventId: d.eventId, date: d.date, shape: b.day.shape, target: t ? num(t) : 0 } }); toast('Day target saved'); refresh(); }
    catch (e) { toast(e.message, true); }
  }
  async function removeDay() {
    const d = day();
    if (!confirm('Remove this day? Nothing has been entered for it.')) return;
    try { await api(`/fundraising/days?eventId=${d.eventId}&date=${d.date}`, { method: 'DELETE' }); toast('Day removed'); S.step = null; await load(); refresh(); }
    catch (e) { toast(e.message, true); }
  }
  function showStep(step) {
    S.step = step;
    document.querySelectorAll('.hs-step').forEach(b => { b.classList.toggle('on', b.dataset.step === step); b.setAttribute('aria-selected', b.dataset.step === step); });
    document.querySelectorAll('.hs-sec').forEach(sec => { sec.hidden = sec.dataset.sec !== step; });
    if (step === 'tally') renderTally();
    if (step === 'enter') setTimeout(() => $('sNo').focus(), 30);
  }
  async function refresh() {
    const d = day();
    if (!d.eventId || !d.date) return;
    try { S.board = await api('/fundraising/sheets?' + q()); }
    catch (e) { S.board = null; $('sBoard').innerHTML = ''; $('sProgress').textContent = e.message; return; }
    const b = S.board;
    // Set up or not: before it, only the set-up panel.
    const setUp = b.setUp;
    $('sSetup').hidden = setUp;
    document.querySelector('.hs-steps').hidden = !setUp;
    $('sProgress').hidden = !setUp;
    if (!setUp) {
      document.querySelectorAll('.hs-sec').forEach(sec => { sec.hidden = true; });
      $('sDayType').closest('.field').hidden = true;
      const shape = $('sDayType').value || 'joint';
      document.querySelectorAll('#sSetup [data-shape]').forEach(x => x.classList.toggle('on', x.dataset.shape === shape));
      $('sSetupBtn').hidden = !canManage();
      if (!canManage()) $('sSetup').querySelector('p').textContent = 'This day has not been set up yet. Ask the Harvest Committee to set it up.';
    } else $('sDayType').closest('.field').hidden = false;
    // The day decides joint or two services; the box shows it.
    $('sDayType').value = b.services.length > 1 ? 'dual' : 'joint';
    $('sDayType').disabled = !canManage() || b.rows.some(r => r.status !== 'missing') || !!b.locked;
    const done = b.entered === b.total;
    $('sProgress').innerHTML = `<b>${b.entered} of ${b.total}</b> sheets entered · day total <b class="mono">GHS ${gh(b.dayTotal)}</b>`
      + (b.locked ? ' · <span class="badge badge-info">signed off — locked</span>' : '')
      + (done && !b.locked ? ' · <span class="badge badge-done">every sheet is in</span> <button type="button" class="btn btn-primary btn-sm" id="sSubmitBtn">Submit the day for verification</button>' : '');
    const sb = $('sSubmitBtn');
    if (sb) sb.onclick = submitDay;
    const ev = b.event;
    $('sTarget').innerHTML = `<b>${esc(ev.name)}</b> · target ${ev.target ? `<b class="mono">GHS ${gh(ev.target)}</b>` : '<span class="sub">not set</span>'}`
      + ` · raised so far <b class="mono">GHS ${gh(ev.raised)}</b>${ev.target ? ` <span class="sub">(${Math.round(ev.raised / ev.target * 100)}%)</span>` : ''}`
      + (canManage() ? ' <button type="button" class="linklike" id="sTargetBtn">change target</button>' : '')
      + (b.day ? `<br><span class="sub">Day set up by ${esc(b.day.setBy || '')} · ${b.day.shape === 'dual' ? '1st and 2nd service' : 'joint service'}</span>`
        + ` · day target ${b.day.target ? `<b class="mono">GHS ${gh(b.day.target)}</b> <span class="sub">(${Math.round(b.dayTotal / b.day.target * 100)}% so far)</span>` : '<span class="sub">none</span>'}`
        + (canManage() && !b.locked ? ' <button type="button" class="linklike" id="sDayTargetBtn">change</button>' : '')
        + (canManage() && b.rows.every(r => r.status === 'missing') ? ' · <button type="button" class="linklike" id="sRemoveDayBtn">remove this day</button>' : '') : '');
    if ($('sTargetBtn')) $('sTargetBtn').onclick = editTarget;
    if ($('sDayTargetBtn')) $('sDayTargetBtn').onclick = editDayTarget;
    if ($('sRemoveDayBtn')) $('sRemoveDayBtn').onclick = removeDay;
    if (!setUp) return;
    if (!S.step) showStep(b.entered === b.total && b.total ? 'tally' : b.rows.some(r => r.status !== 'missing') ? 'enter' : 'print');
    else if (S.step === 'tally') renderTally();
    $('sBoard').innerHTML = b.services.map(s => `<div class="hs-svc"><div class="hs-svc-name">${esc(svc(s))}</div><div class="hs-tiles">`
      + b.rows.filter(r => r.service === s).map(r => `<button type="button" class="hs-tile hs-${r.status}${S.sheet && S.sheet.no === r.no ? ' hs-on' : ''}" data-tile="${r.no}"
          title="${esc(r.label)} — ${r.status === 'entered' ? 'entered by ' + esc(r.enteredBy || '') : r.status === 'photo' ? 'photo received, not typed yet' : 'not entered yet'}">
          <span class="hs-no">${pad2(r.no)}</span><span class="hs-lbl">${esc(short(r.label))}</span>
          <span class="hs-amt mono">${r.status === 'entered' ? gh(r.total) : r.status === 'photo' ? '📷 to type' : '—'}</span></button>`).join('')
      + '</div></div>').join('');
    $('sBoard').querySelectorAll('[data-tile]').forEach(el => el.onclick = () => { $('sNo').value = el.dataset.tile; pickSheet(); });
    $('sEntry').style.opacity = b.locked ? .55 : 1;
    $('sSaveBtn').disabled = b.locked;
  }
  // ---- 3 · Tally & report ------------------------------------------------------
  function renderTally() {
    const b = S.board; if (!b) return;
    const ev = b.event;
    const left = b.total - b.entered;
    $('sKpis').innerHTML = [
      ['Day total', `GHS ${gh(b.dayTotal)}`],
      ['Sheets entered', `${b.entered} of ${b.total}`],
      [`${ev.name} raised`, `GHS ${gh(ev.raised)}${ev.target ? ` · ${Math.round(ev.raised / ev.target * 100)}%` : ''}`],
      ['Day target', b.day && b.day.target ? `GHS ${gh(b.day.target)} · ${Math.round(b.dayTotal / b.day.target * 100)}%` : '—'],
      [`${ev.name} target`, ev.target ? `GHS ${gh(ev.target)}` : '—'],
    ].map(([k, v]) => `<div class="hs-kpi"><span>${esc(k)}</span><b class="mono">${v}</b></div>`).join('');
    // One line per basket, a column per service.
    const svcs = b.services;
    const byKey = new Map();
    b.rows.forEach(r => {
      const k = r.key;
      if (!byKey.has(k)) byKey.set(k, { label: r.key === 'seed' ? 'Seed contributions' : r.label, per: {}, total: 0, missing: 0 });
      const x = byKey.get(k);
      if (r.status === 'entered') { x.per[r.service] = (x.per[r.service] || 0) + r.total; x.total += r.total; } else x.missing++;
    });
    const head = `<tr><th>Basket</th>${svcs.length > 1 ? svcs.map(s => `<th class="num">${esc(s)}</th>`).join('') : ''}<th class="num">Total (GHS)</th></tr>`;
    const lines = [...byKey.values()].map(x => `<tr${x.missing === svcs.length ? ' class="hs-miss"' : ''}><td>${esc(x.label)}${x.missing ? ` <span class="sub">(${x.missing === svcs.length ? 'not entered' : x.missing + ' sheet not entered'})</span>` : ''}</td>`
      + (svcs.length > 1 ? svcs.map(s => `<td class="num mono">${x.per[s] != null ? gh(x.per[s]) : '—'}</td>`).join('') : '')
      + `<td class="num mono"><b>${gh(x.total)}</b></td></tr>`).join('');
    const totals = `<tr class="hs-tot"><th>Day total</th>${svcs.length > 1 ? svcs.map(s => `<th class="num mono">${gh(b.rows.filter(r => r.service === s && r.status === 'entered').reduce((t, r) => t + r.total, 0))}</th>`).join('') : ''}<th class="num mono">${gh(b.dayTotal)}</th></tr>`;
    $('sTally').innerHTML = `<tbody><tr class="hs-headrow">${head.slice(4, -5)}</tr>${lines}${totals}</tbody>`;
    const m = b.methods || {};
    $('sMethods').innerHTML = '<b>By payment type</b>' + [['Cash', m.cash], ['MoMo', m.momo], ['Cheques', m.cheque], ['Transfers', m.transfer], ['Foreign (in GHS)', m.forex], ['Pledges (IOU)', m.ious]]
      .map(([k, v]) => `<span><span class="sub">${k}</span> <b class="mono">${gh(v || 0)}</b></span>`).join('');
    $('sSubmitWrap').innerHTML = b.locked ? '<span class="badge badge-info">signed off — locked</span>'
      : b.status === 'submitted' ? '<span class="badge badge-info">submitted · awaiting Accounts Clerk</span>'
        : left ? `<span class="sub">${left} sheet${left === 1 ? '' : 's'} still to enter before the day is submitted</span>`
          : (canManage() ? '<button type="button" class="btn btn-primary" id="sSubmit2">Submit the day for verification</button>' : '');
    if ($('sSubmit2')) $('sSubmit2').onclick = submitDay;
  }

  const short = l => l.replace('Chairpersons & Co-chairpersons', 'Chairpersons').replace('Gratitude & Thanksgiving', 'Gratitude').replace('Seed contributions', 'Seed').replace('Seed — ', 'Seed: ').replace('Harvest Week — ', '');

  // ---- The form ----------------------------------------------------------------
  function renderCash() {
    $('sCash').innerHTML = denoms().map(d => `<tr><td>${esc(d.label)}</td>
      <td class="num"><input data-denom="${d.key}" inputmode="numeric" class="hs-pcs" data-nav autocomplete="off"></td>
      <td class="num mono" data-amt="${d.key}"></td></tr>`).join('');
  }
  function rowHtml(kind, v) {
    return `<div class="hs-row" data-row="${kind}">` + LISTS[kind].map(([k, label, w, isNum, type]) =>
      `<input data-k="${k}" placeholder="${label}" style="width:${w}px" ${type ? `type="${type}"` : ''} ${isNum ? 'inputmode="decimal"' : ''} data-nav value="${v && v[k] != null ? esc(String(v[k])) : ''}">`).join('')
      + '<button type="button" class="btn btn-secondary btn-sm" data-del title="Remove this line">✕</button></div>';
  }
  function addRow(kind, v) { const box = document.querySelector(`[data-list="${kind}"] .hs-rows`); box.insertAdjacentHTML('beforeend', rowHtml(kind, v)); }
  function resetLists() { Object.keys(LISTS).forEach(k => { document.querySelector(`[data-list="${k}"] .hs-rows`).innerHTML = ''; addRow(k); }); }
  function readRows(kind) {
    return [...document.querySelectorAll(`[data-row="${kind}"]`)].map(row => {
      const o = {}; row.querySelectorAll('[data-k]').forEach(i => { o[i.dataset.k] = i.value.trim(); }); return o;
    }).filter(o => Object.values(o).some(Boolean));
  }
  function collect() {
    const cashCount = {};
    document.querySelectorAll('[data-denom]').forEach(i => { const n = Math.floor(num(i.value)); if (n > 0) cashCount[i.dataset.denom] = n; });
    const rows = Object.fromEntries(Object.keys(LISTS).map(k => [k, readRows(k)]));
    rows.momo.forEach(m => { m.amount = num(m.amount); });
    rows.cheques.forEach(c => { c.amount = num(c.amount); });
    rows.transfers.forEach(t => { t.amount = num(t.amount); });
    rows.forex.forEach(f => { f.amount = num(f.amount); f.rate = num(f.rate); f.currency = String(f.currency || '').toUpperCase(); });
    rows.ious.forEach(i => { i.amount = num(i.amount); });
    return { cashCount, ...rows };
  }
  function rateOf(cur, typed) {
    const day = ((S.sheet && S.sheet.rates) || []).find(r => r.currency === cur);
    return day ? day.rate : typed;
  }
  function compute() {
    const c = collect();
    let cash = 0;
    denoms().forEach(d => {
      const n = c.cashCount[d.key] || 0, amt = r2(n * d.value); cash += amt;
      const cell = document.querySelector(`[data-amt="${d.key}"]`); if (cell) cell.textContent = n ? gh(amt) : '';
    });
    cash = r2(cash);
    const sum = arr => r2(arr.reduce((s, x) => s + (x.amount || 0), 0));
    const parts = {
      A: cash, B: sum(c.momo), C: sum(c.cheques), D: sum(c.transfers),
      E: r2(c.forex.reduce((s, f) => s + r2((f.amount || 0) * (rateOf(f.currency, f.rate) || 0)), 0)), F: sum(c.ious),
    };
    const total = r2(Object.values(parts).reduce((a, b) => a + b, 0));
    $('sCashTotal').textContent = gh(cash);
    const names = { A: 'Cash', B: 'MoMo', C: 'Cheques', D: 'Transfers', E: 'Foreign (GHS)', F: 'Pledges' };
    $('sSum').innerHTML = Object.entries(parts).map(([k, v]) => `<div><span>${k} · ${names[k]}</span><b class="mono">${gh(v)}</b></div>`).join('')
      + `<div class="hs-sum-total"><span>Typed total</span><b class="mono">${gh(total)}</b></div>`;
    const wc = $('sWrittenCash').value.trim(), wt = $('sWrittenTotal').value.trim();
    const cashOk = !wc || Math.abs(num(wc) - cash) <= 0.01;
    const totOk = wt && Math.abs(num(wt) - total) <= 0.01;
    $('sWrittenCash').classList.toggle('hs-bad', !!wc && !cashOk);
    $('sWrittenCash').classList.toggle('hs-good', !!wc && cashOk);
    $('sWrittenTotal').classList.toggle('hs-bad', !!wt && !totOk);
    $('sWrittenTotal').classList.toggle('hs-good', !!totOk);
    $('sCheck').innerHTML = !wt ? '<span class="sub">Type the basket total from the sheet to check it.</span>'
      : totOk && cashOk ? '<b class="hs-okmsg">✓ Agrees with the sheet — ready to save</b>'
        : `<b class="hs-badmsg">✗ ${!cashOk ? `Cash: sheet ${gh(num(wc))}, typed ${gh(cash)}. ` : ''}${!totOk ? `Total: sheet ${gh(num(wt))}, typed ${gh(total)}.` : ''}</b>`;
    return { c, cash, total };
  }
  function clearForm(keepNo) {
    if (!keepNo) { $('sNo').value = ''; S.sheet = null; $('sWhich').textContent = 'Type the number printed on the sheet.'; $('sSeedWrap').style.display = 'none'; }
    document.querySelectorAll('[data-denom]').forEach(i => { i.value = ''; });
    resetLists();
    $('sWrittenCash').value = ''; $('sWrittenTotal').value = '';
    $('sCorrected').checked = false; $('sNote').value = ''; $('sNoteWrap').style.display = 'none';
    S.photoId = null; $('sPhoto').innerHTML = '';
    compute();
  }

  // ---- Choosing a sheet --------------------------------------------------------
  async function pickSheet() {
    const no = Math.floor(num($('sNo').value));
    if (!no) return;
    let s;
    try { s = await api(`/fundraising/sheets/${no}?` + q()); }
    catch (e) { $('sWhich').innerHTML = `<span class="hs-badmsg">${esc(e.message)}</span>`; S.sheet = null; return; }
    S.sheet = s;
    clearForm(true);
    $('sWhich').innerHTML = `<b>${esc(s.entryKey && s.entryKey.startsWith('seed.') ? 'Seed — ' + s.entryKey.slice(5) : s.label)}</b> · ${esc(svc(s.service))}`
      + (s.entered ? ` · <span class="badge badge-done">entered by ${esc((s.sheet && s.sheet.enteredBy) || '')}</span> <span class="sub">— change it and save to replace</span>` : '');
    $('sSeedWrap').style.display = s.key === 'seed' ? '' : 'none';
    if (s.key === 'seed') {
      $('sSeedBody').innerHTML = '<option value="">— choose —</option>' + s.seedCategories.map(c => `<option>${esc(c)}</option>`).join('');
      if (s.entryKey && s.entryKey.startsWith('seed.')) $('sSeedBody').value = s.entryKey.slice(5);
      else if (s.seedCategories.length === 1) $('sSeedBody').value = s.seedCategories[0];
    }
    S.photoId = (s.sheet && s.sheet.photoId) || null;
    showPhoto();
    if (s.entered && s.breakdown) {
      const bd = s.breakdown;
      Object.entries(bd.cashCount || {}).forEach(([k, n]) => { const i = document.querySelector(`[data-denom="${k}"]`); if (i) i.value = n; });
      const fill = (kind, rows) => { const box = document.querySelector(`[data-list="${kind}"] .hs-rows`); if (rows && rows.length) { box.innerHTML = ''; rows.forEach(r => addRow(kind, r)); } };
      fill('momo', (s.sheet && s.sheet.momo) || []);
      fill('cheques', bd.cheques); fill('transfers', bd.transfers); fill('forex', bd.forex);
      fill('ious', (bd.ious || []).map(i => ({ ...i })));
      $('sWrittenCash').value = s.sheet && s.sheet.writtenCash != null ? s.sheet.writtenCash : '';
      $('sWrittenTotal').value = s.sheet && s.sheet.writtenTotal != null ? s.sheet.writtenTotal : '';
      if (s.sheet && s.sheet.corrected) { $('sCorrected').checked = true; $('sNoteWrap').style.display = ''; $('sNote').value = s.sheet.note || ''; }
    }
    compute();
    refreshTilesOnly();
    const first = s.key === 'seed' && !$('sSeedBody').value ? $('sSeedBody') : document.querySelector('[data-denom]');
    if (first) first.focus();
  }
  function refreshTilesOnly() { document.querySelectorAll('[data-tile]').forEach(el => el.classList.toggle('hs-on', !!S.sheet && Number(el.dataset.tile) === S.sheet.no)); }
  function showPhoto() {
    $('sPhoto').innerHTML = S.photoId
      ? `<a href="/api/fundraising/sheet-photo/${encodeURIComponent(S.photoId)}" target="_blank" rel="noopener" title="Open the photo of this sheet">
           <img src="/api/fundraising/sheet-photo/${encodeURIComponent(S.photoId)}" alt="Photo of the sheet"></a>` : '';
  }

  // ---- Saving -------------------------------------------------------------------
  async function save(replace) {
    if (S.busy) return;
    if (!S.sheet) { $('sNo').focus(); return toast('Type the sheet number first.', true); }
    const { c } = compute();
    const body = { ...day(), ...c, writtenCash: $('sWrittenCash').value.trim(), writtenTotal: $('sWrittenTotal').value.trim(),
      seedBody: $('sSeedBody').value, corrected: $('sCorrected').checked, note: $('sNote').value.trim(), photoId: S.photoId || undefined,
      replace: replace || (S.sheet.entered ? true : undefined) };
    if (!body.writtenTotal) { $('sWrittenTotal').focus(); return toast('Type the BASKET TOTAL written on the sheet.', true); }
    S.busy = true; $('sSaveBtn').disabled = true;
    try {
      const r = await api(`/fundraising/sheets/${S.sheet.no}`, { method: 'PUT', body });
      toast(`Sheet ${pad2(r.no)} saved — ${r.label}, GHS ${gh(r.total)}`);
      try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* storage off */ }
      clearForm(); await refresh(); $('sNo').focus();
      load();   // the page behind (inflows, totals)
    } catch (e) {
      if (e.status === 409 && e.data && e.data.already) {
        if (confirm(`${e.message}\n\nReplace it with what you have typed?`)) { S.busy = false; $('sSaveBtn').disabled = false; return save(true); }
      } else {
        toast(e.message, true);
        if (e.data && e.data.field === 'cash') $('sWrittenCash').focus();
        if (e.data && e.data.field === 'total') $('sWrittenTotal').focus();
      }
    } finally { S.busy = false; $('sSaveBtn').disabled = !!(S.board && S.board.locked); }
  }
  async function submitDay() {
    const d = day();
    if (!confirm('Every sheet is in. Submit the day to the Accounts Clerk for verification?')) return;
    try { await api('/fundraising/submit-day', { method: 'POST', body: { eventId: d.eventId, date: d.date } }); toast('Submitted for verification'); refresh(); load(); }
    catch (e) { toast(e.message, true); }
  }

  // ---- Photo: resized in the browser, then sent ---------------------------------
  function resize(file, max = 1600, quality = 0.72) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * k); cv.height = Math.round(img.height * k);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(img.src);
        resolve(cv.toDataURL('image/jpeg', quality));
      };
      img.onerror = () => reject(new Error('That file could not be read as a photo.'));
      img.src = URL.createObjectURL(file);
    });
  }
  async function sendPhoto(file) {
    if (!S.sheet) { $('sNo').focus(); return toast('Type the sheet number first, then take the photo.', true); }
    try {
      const image = await resize(file);
      const r = await api(`/fundraising/sheets/${S.sheet.no}/photo`, { method: 'POST', body: { ...day(), image } });
      S.photoId = r.photoId; showPhoto();
      toast(`Photo of sheet ${pad2(S.sheet.no)} sent${S.sheet.entered ? '' : ' — it shows on the board as "to type"'}`);
      refresh();
    } catch (e) { toast(e.message, true); }
  }

  // ---- Nothing typed is lost (a reload, a dropped connection) -------------------
  function saveDraft() {
    if (!S.sheet) return;
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...day(), no: S.sheet.no, at: Date.now(), form: collect(),
      writtenCash: $('sWrittenCash').value, writtenTotal: $('sWrittenTotal').value, seedBody: $('sSeedBody').value })); } catch (e) { /* storage off */ }
  }
  async function restoreDraft() {
    let d; try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (e) { d = null; }
    const cur = day();
    if (!d || d.eventId !== cur.eventId || d.date !== cur.date || Date.now() - d.at > 12 * 3600e3) return;
    $('sNo').value = d.no; await pickSheet();
    Object.entries(d.form.cashCount || {}).forEach(([k, n]) => { const i = document.querySelector(`[data-denom="${k}"]`); if (i) i.value = n; });
    Object.keys(LISTS).forEach(k => { const rows = d.form[k] || []; if (rows.length) { document.querySelector(`[data-list="${k}"] .hs-rows`).innerHTML = ''; rows.forEach(r => addRow(k, r)); } });
    $('sWrittenCash').value = d.writtenCash || ''; $('sWrittenTotal').value = d.writtenTotal || '';
    if (d.seedBody) $('sSeedBody').value = d.seedBody;
    compute();
    toast(`Sheet ${pad2(d.no)}: what you were typing has been put back (not saved yet).`);
  }

  // ---- Wiring --------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {});
  $('entryBtn').onclick = () => open();
  $('sCloseBtn').onclick = () => { $('sOverlay').style.display = 'none'; };
  document.querySelectorAll('.hs-step').forEach(b => { b.onclick = () => showStep(b.dataset.step); });
  $('sTotalsBtn').onclick = () => { const d = day(); $('sOverlay').style.display = 'none'; openTotalsForm(d.eventId, d.date, d.services); };
  $('sResultsBtn').onclick = () => { const d = day(); viewDay(d.eventId, d.date); };
  $('sAnnounceBtn').onclick = () => { const d = day(); window.open(`/api/fundraising/announcement.pdf?eventId=${d.eventId}&date=${d.date}`, '_blank'); };
  $('sPrintBtn').onclick = () => { const d = day(); if (!d.date) return toast('Choose the date first.', true); window.open('/api/fundraising/basket-sheets.pdf?' + q(), '_blank'); };
  $('sSummaryBtn').onclick = () => window.open('/api/fundraising/day-summary.pdf?' + q(), '_blank');
  $('sEvent').addEventListener('change', async () => {
    if ($('sEvent').value === 'new' && !(await newEvent())) return;
    S.lastEvent = $('sEvent').value; S.step = null; clearForm(); refresh();
  });
  $('sDate').addEventListener('change', () => { S.step = null; clearForm(); refresh(); });
  $('sDayType').addEventListener('change', async () => {
    const b = S.board;
    if (b && b.setUp) {
      const to = $('sDayType').value;
      if (!confirm(`Change this day to ${to === 'dual' ? '1st and 2nd service' : 'a joint service'}? The sheet numbers change with it.`)) { $('sDayType').value = b.services.length > 1 ? 'dual' : 'joint'; return; }
      return setUpDay(to, b.day ? b.day.target : null);
    }
    refresh();
  });
  document.querySelectorAll('#sSetup [data-shape]').forEach(x => { x.onclick = () => {
    $('sDayType').value = x.dataset.shape;
    document.querySelectorAll('#sSetup [data-shape]').forEach(y => y.classList.toggle('on', y === x));
  }; });
  $('sSetupBtn').onclick = () => setUpDay($('sDayType').value, $('sDayTarget').value.trim() ? num($('sDayTarget').value) : null);
  $('sNo').addEventListener('change', pickSheet);
  $('sNo').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pickSheet(); } });
  $('sCorrected').addEventListener('change', () => { $('sNoteWrap').style.display = $('sCorrected').checked ? '' : 'none'; if ($('sCorrected').checked) $('sNote').focus(); });
  $('sSaveBtn').onclick = () => save();
  $('sClearBtn').onclick = () => { clearForm(true); try { localStorage.removeItem(DRAFT_KEY); } catch (e) { /* */ } };
  $('sPhotoInput').addEventListener('change', e => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) sendPhoto(f); });
  const entry = $('sEntry');
  entry.addEventListener('input', () => { compute(); saveDraft(); });
  entry.addEventListener('click', e => {
    const add = e.target.closest('[data-add]');
    if (add) { addRow(add.dataset.add); const rows = document.querySelectorAll(`[data-row="${add.dataset.add}"]`); rows[rows.length - 1].querySelector('input').focus(); return; }
    const del = e.target.closest('[data-del]');
    if (del) { const row = del.closest('.hs-row'); const box = row.parentElement; row.remove(); if (!box.children.length) addRow(box.parentElement.dataset.list); compute(); saveDraft(); }
  });
  // Enter moves down the sheet, as Tab does — the desk types with one hand on the
  // number pad. Ctrl/⌘+Enter saves.
  entry.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.matches('[data-nav]') || e.target.id === 'sNo') return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) return save();
    const all = [...entry.querySelectorAll('[data-nav]')].filter(x => x.offsetParent !== null && !x.disabled);
    const i = all.indexOf(e.target);
    if (e.target.id === 'sWrittenTotal') return save();
    if (all[i + 1]) all[i + 1].focus();
  });
  $('sOverlay').addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); } });
  window.openHarvestSheets = open;
})();
