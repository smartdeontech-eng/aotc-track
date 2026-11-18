// AOTC Track — the Church Diary page (Nov 2026). See routes/diary.js.
// Month view (a grid; dots on a phone) or List view, filters by kind, the
// "Put this on the diary?" box for those who keep it, add/change, and the
// preaching plan read from the Word or PDF it is shared as.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const ENTERABLE = ['programme', 'funeral', 'wedding', 'traditional', 'thanksgiving', 'preaching', 'other'];
  const SOURCE_NOTE = {
    session: 'From Session Meetings — change it there.',
    meeting: 'From Meetings — change it there.',
    marriage: 'From Intended Marriages (approved by the Session) — change the dates there.',
  };
  const pad = n => String(n).padStart(2, '0');
  const keyOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromKey = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); };
  const longDay = k => fromKey(k).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const shortDay = k => fromKey(k).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  let me = null, kinds = {}, items = [], canManage = false, sugs = [];
  let cursor = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1, 12); })();
  let selDay = keyOf(new Date());
  const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; } return v; };
  let view = store('aotc.diary.view') || (window.innerWidth < 760 ? 'list' : 'month');
  let hidden = new Set(); try { hidden = new Set(JSON.parse(store('aotc.diary.hidden') || '[]')); } catch (e) {}

  function range() {
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 12);
    const start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
    const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0, 12);
    const end = new Date(last); end.setDate(last.getDate() + (6 - ((last.getDay() + 6) % 7)));
    return { start, end, first, last };
  }
  async function load() {
    const r = range();
    try {
      const d = await api(`/diary?from=${keyOf(r.start)}&to=${keyOf(r.end)}`);
      kinds = d.kinds || {}; items = d.items || []; canManage = !!d.canManage;
      $('addBtn').style.display = canManage ? '' : 'none';
      $('ppBtn').style.display = canManage ? '' : 'none';
      if (canManage) sugs = await api('/diary/suggestions').catch(() => []);
      draw();
    } catch (e) {
      $('view').innerHTML = `<div class="card"><p>Could not open the diary: ${esc(e.message)}</p></div>`;
    }
  }
  const shown = () => items.filter(i => !hidden.has(i.kind));
  const onDay = k => shown().filter(i => i.date <= k && (i.endDate || i.date) >= k);
  const timeOf = i => (i.time ? i.time : (i.endDate && i.endDate !== i.date ? 'all days' : ''));

  function draw() {
    $('monthLabel').textContent = `${MONTHS[cursor.getMonth()]} ${cursor.getFullYear()}`;
    document.querySelectorAll('.dy-views button').forEach(b => b.classList.toggle('on', b.dataset.view === view));
    $('kinds').innerHTML = Object.entries(kinds).map(([k, label]) => `<button type="button" class="dy-kind${hidden.has(k) ? ' off' : ''}" data-kind="${k}" style="--k:var(--k-${k})" aria-pressed="${!hidden.has(k)}"><i></i>${esc(label)}</button>`).join('');
    drawConfirm();
    if (view === 'month') drawMonth(); else drawList();
  }

  // ---- What the app found, waiting to go on -----------------------------------
  function drawConfirm() {
    const box = $('confirmBox');
    if (!canManage || !sugs.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="dy-confirm"><h3>Put these on the diary? (${sugs.length})</h3>
      <p class="sub" style="margin:0;">Dates the app found in letters and in what visitors announced to the Session. Nothing goes on until you say so.</p>
      ${sugs.map((s, i) => `<div class="dy-sug" style="--k:var(--k-${s.kind})">
        <div class="w"><span class="dy-tag">${esc(kinds[s.kind] || s.kind)}</span><b>${esc(s.title)}</b>
          <div>${esc(longDay(s.date))}${s.time ? ` · ${esc(s.time)}` : ''}${s.venue ? ` · ${esc(s.venue)}` : ''}</div>
          <div class="f">Found in: ${s.foundIn && s.foundIn.href ? `<a href="${esc(s.foundIn.href)}">${esc(s.foundIn.label)}</a>` : esc((s.foundIn || {}).label || '')}</div></div>
        <div class="b"><button class="btn btn-primary btn-sm" data-sug-add="${i}">Put on the diary</button>
          <button class="btn btn-secondary btn-sm" data-sug-no="${i}">Not for the diary</button></div>
      </div>`).join('')}</div>`;
  }

  // ---- Month ---------------------------------------------------------------------
  function drawMonth() {
    const r = range(); const today = keyOf(new Date());
    const cells = [];
    for (let d = new Date(r.start); d <= r.end; d.setDate(d.getDate() + 1)) {
      const k = keyOf(d); const list = onDay(k);
      const out = d.getMonth() !== cursor.getMonth();
      cells.push(`<div class="dy-day${out ? ' out' : ''}${k === today ? ' today' : ''}${k === selDay ? ' sel' : ''}" data-day="${k}" tabindex="0" aria-label="${esc(longDay(k))}, ${list.length} on the diary">
        <span class="n">${d.getDate()}</span>
        ${list.slice(0, 3).map(i => `<span class="dy-chip" style="--k:var(--k-${i.kind})" title="${esc(kinds[i.kind] || '')}: ${esc(i.title)}">${i.time ? `${esc(i.time.replace(/:00 /, ' '))} ` : ''}${esc(i.title)}</span>`).join('')}
        ${list.length > 3 ? `<span class="dy-more">+${list.length - 3} more</span>` : ''}
        <span class="dy-dots">${list.slice(0, 6).map(i => `<i style="--k:var(--k-${i.kind})"></i>`).join('')}</span>
      </div>`);
    }
    $('view').innerHTML = `<div class="dy-grid">${DOW.map(x => `<div class="hd">${x}</div>`).join('')}${cells.join('')}</div>`;
    drawDay();
  }
  function itemRow(i) {
    return `<div class="dy-item" style="--k:var(--k-${i.kind})" data-item="${esc(i.key)}" tabindex="0">
      <time>${esc(timeOf(i)) || '—'}</time>
      <div><div><span class="dy-tag">${esc(kinds[i.kind] || i.kind)}</span></div><div class="t">${esc(i.title)}</div>
      ${[i.venue, i.kind === 'preaching' && i.theme ? `Theme: ${i.theme}` : '', i.endDate && i.endDate !== i.date ? `until ${shortDay(i.endDate)}` : ''].filter(Boolean).length ? `<div class="m">${esc([i.venue, i.kind === 'preaching' && i.theme ? `Theme: ${i.theme}` : '', i.endDate && i.endDate !== i.date ? `until ${shortDay(i.endDate)}` : ''].filter(Boolean).join(' · '))}</div>` : ''}</div>
    </div>`;
  }
  function drawDay() {
    const list = onDay(selDay);
    $('dayPanel').innerHTML = `<h4>${esc(longDay(selDay))}</h4>${list.length ? list.map(itemRow).join('') : `<p class="dy-empty">Nothing on the diary this day.${canManage ? ' Use “+ Add to the diary”.' : ''}</p>`}`;
  }
  // ---- List ----------------------------------------------------------------------
  function drawList() {
    $('dayPanel').innerHTML = '';
    const r = range(); const a = keyOf(r.first), b = keyOf(r.last);
    const days = {};
    shown().forEach(i => { const k = i.date < a ? a : i.date; if (k > b) return; (days[k] = days[k] || []).push(i); });
    const keys = Object.keys(days).sort();
    $('view').innerHTML = `<div class="dy-list">${keys.length ? keys.map(k => `<h4>${esc(longDay(k))}</h4>${days[k].map(itemRow).join('')}`).join('') : `<p class="dy-empty">Nothing on the diary in ${MONTHS[cursor.getMonth()]}.</p>`}</div>`;
  }

  // ---- An entry: details --------------------------------------------------------
  function openItem(i) {
    const rows = [
      ['When', `${longDay(i.date)}${i.endDate && i.endDate !== i.date ? ` – ${longDay(i.endDate)}` : ''}${i.time ? `, ${i.time}` : ''}`],
      ['Venue', i.venue], ['Service', i.service], ['Preacher', i.preacher], ['Theme', i.theme], ['Readings', i.readings], ['Details', i.details],
    ].filter(r => r[1]);
    $('itemTitle').textContent = i.title || kinds[i.kind];
    $('itemBody').innerHTML = `<p style="margin:0 0 8px;"><span class="dy-tag" style="--k:var(--k-${i.kind})">${esc(kinds[i.kind] || i.kind)}</span></p>
      ${rows.map(([l, v]) => `<div class="field" style="margin:0 0 8px;"><label>${l}</label><div style="white-space:pre-wrap;">${esc(v)}</div></div>`).join('')}
      ${i.foundIn && i.foundIn.label ? `<p class="sub">Came from: ${i.foundIn.href ? `<a href="${esc(i.foundIn.href)}">${esc(i.foundIn.label)}</a>` : esc(i.foundIn.label)}</p>` : ''}
      ${SOURCE_NOTE[i.source] ? `<p class="sub">${SOURCE_NOTE[i.source]}${i.href ? ` <a href="${esc(i.href)}">Open it →</a>` : ''}</p>` : ''}`;
    $('itemActions').innerHTML = `<button class="btn btn-secondary" data-close>Close</button>
      ${i.editable ? `<button class="btn btn-danger" data-del="${i.id}">Take off the diary</button><button class="btn btn-primary" data-edit="${esc(i.key)}">Change</button>` : ''}`;
    $('itemOverlay').style.display = 'flex';
  }
  // ---- Add / change --------------------------------------------------------------
  let editing = null;   // { id } when changing; { fromKey, foundIn } when from a suggestion
  function openForm(seed, ctx) {
    editing = ctx || {};
    const s = seed || {};
    const kind = s.kind || 'programme';
    $('itemTitle').textContent = editing.id ? 'Change this entry' : 'Add to the diary';
    $('itemBody').innerHTML = `
      ${editing.foundIn ? `<p class="sub" style="margin-top:-4px;">From: ${esc(editing.foundIn.label || '')} — check every box.</p>` : ''}
      <div class="field"><label>What kind</label><select id="fKind">${ENTERABLE.map(k => `<option value="${k}"${k === kind ? ' selected' : ''}>${esc(kinds[k] || k)}</option>`).join('')}</select></div>
      <div class="field" id="fTitleBox"><label id="fTitleLbl">What it is</label><input type="text" id="fTitle" value="${esc(s.title || '')}" placeholder="e.g. Harvest launch · Funeral of the late Madam Ama Owusu"></div>
      <div class="field-row">
        <div class="field"><label>Date</label><input type="date" id="fDate" value="${esc(s.date || selDay)}"></div>
        <div class="field"><label>Last day <span class="sub">(if more than one day)</span></label><input type="date" id="fEnd" value="${esc(s.endDate || '')}"></div>
        <div class="field" style="max-width:130px;"><label>Time</label><input type="text" id="fTime" value="${esc(s.time || '')}" placeholder="e.g. 9am"></div>
      </div>
      <div class="field"><label>Venue</label><input type="text" id="fVenue" value="${esc(s.venue || '')}" placeholder="e.g. the AOTC Chapel"></div>
      <div id="fPreach">
        <div class="field-row">
          <div class="field"><label>Service <span class="sub">(if more than one)</span></label><input type="text" id="fService" value="${esc(s.service || '')}" placeholder="e.g. 1st service"></div>
          <div class="field"><label>Preacher</label><input type="text" id="fPreacher" value="${esc(s.preacher || '')}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Theme</label><input type="text" id="fTheme" value="${esc(s.theme || '')}"></div>
          <div class="field"><label>Readings</label><input type="text" id="fReadings" value="${esc(s.readings || '')}"></div>
        </div>
      </div>
      <div class="field"><label>Details <span class="sub">(optional)</span></label><textarea id="fDetails" rows="3">${esc(s.details || '')}</textarea></div>`;
    $('itemActions').innerHTML = `<button class="btn btn-secondary" data-close>Cancel</button><button class="btn btn-primary" id="fSave">${editing.id ? 'Save' : 'Put on the diary'}</button>`;
    const sync = () => { const p = $('fKind').value === 'preaching'; $('fPreach').style.display = p ? '' : 'none'; $('fTitleLbl').textContent = p ? 'Occasion (optional) — e.g. Harvest Sunday' : 'What it is'; };
    $('fKind').addEventListener('change', sync); sync();
    $('fTime').addEventListener('change', e => { if (window.VisitorsText) e.target.value = VisitorsText.clock(e.target.value); });
    $('itemOverlay').style.display = 'flex';
  }
  async function saveForm() {
    const v = id => ($(id) ? $(id).value.trim() : '');
    const body = { kind: v('fKind'), title: v('fTitle'), date: v('fDate'), endDate: v('fEnd'), time: v('fTime'), venue: v('fVenue'), details: v('fDetails'),
      service: v('fService'), preacher: v('fPreacher'), theme: v('fTheme'), readings: v('fReadings') };
    if (editing.fromKey) { body.fromKey = editing.fromKey; body.foundIn = editing.foundIn; }
    try {
      if (editing.id) await api(`/diary/${editing.id}`, { method: 'PUT', body });
      else await api('/diary', { method: 'POST', body });
      $('itemOverlay').style.display = 'none';
      toast(editing.id ? 'Saved.' : 'On the diary.');
      if (body.date) { selDay = body.date; const d = fromKey(body.date); cursor = new Date(d.getFullYear(), d.getMonth(), 1, 12); }
      load();
    } catch (e) { toast(e.message, true); }
  }

  // ---- The preaching plan --------------------------------------------------------
  let ppRows = [], ppFileName = '';
  function drawPP() {
    if (!ppRows.length) { $('ppRows').innerHTML = ''; $('ppSave').style.display = 'none'; return; }
    $('ppRows').innerHTML = `<table class="pp-table"><thead><tr><th></th><th>Date</th><th>Service</th><th>Preacher</th><th>Theme</th><th>Readings</th><th>Notes</th></tr></thead><tbody>
      ${ppRows.map((r, i) => `<tr data-pp="${i}"><td><input type="checkbox" class="pp-on" ${r.on !== false ? 'checked' : ''} style="width:auto;min-width:0;" aria-label="Include"></td>
        <td><input type="date" class="pp-date" value="${esc(r.date)}"></td><td><input class="pp-service" value="${esc(r.service)}"></td>
        <td><input class="pp-preacher" value="${esc(r.preacher)}"></td><td><input class="pp-theme" value="${esc(r.theme)}"></td>
        <td><input class="pp-readings" value="${esc(r.readings)}"></td><td><input class="pp-notes" value="${esc(r.notes)}">${r.already ? '<div class="sub" style="font-size:11px;">already on — will be updated</div>' : ''}</td></tr>`).join('')}
    </tbody></table>`;
    $('ppSave').style.display = '';
    $('ppSave').textContent = `Put ${ppRows.length} on the diary`;
  }
  function readPP() {
    document.querySelectorAll('#ppRows tr[data-pp]').forEach(tr => {
      const r = ppRows[Number(tr.dataset.pp)]; const q = c => tr.querySelector(c);
      r.on = q('.pp-on').checked; r.date = q('.pp-date').value; r.service = q('.pp-service').value.trim(); r.preacher = q('.pp-preacher').value.trim();
      r.theme = q('.pp-theme').value.trim(); r.readings = q('.pp-readings').value.trim(); r.notes = q('.pp-notes').value.trim();
    });
  }
  async function readPlan() {
    const f = $('ppFile').files[0];
    if (!f) { toast('Choose the plan first.', true); return; }
    const fd = new FormData(); fd.append('file', f); fd.append('year', $('ppYear').value || new Date().getFullYear());
    $('ppStatus').textContent = 'Reading the plan… (this can take a minute)'; $('ppRead').disabled = true;
    try {
      const res = await fetch('/api/diary/preaching/read', { method: 'POST', body: fd, credentials: 'same-origin' });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'Could not read the plan.');
      ppRows = j.rows || []; ppFileName = j.fileName || f.name;
      $('ppStatus').textContent = ppRows.length ? `${ppRows.length} service${ppRows.length === 1 ? '' : 's'} read from ${ppFileName}. Check them, untick any to leave out, then put them on the diary.` : 'No services with a date could be read from that file.';
      drawPP();
    } catch (e) { $('ppStatus').textContent = ''; toast(e.message, true); }
    $('ppRead').disabled = false;
  }
  async function savePlan() {
    readPP();
    const rows = ppRows.filter(r => r.on !== false && r.date);
    if (!rows.length) { toast('Nothing ticked to put on.', true); return; }
    try {
      const r = await api('/diary/preaching', { method: 'POST', body: { rows, fileName: ppFileName } });
      toast(`Preaching plan on the diary: ${r.added} added${r.updated ? `, ${r.updated} updated` : ''}.`);
      $('ppOverlay').style.display = 'none'; ppRows = []; drawPP(); load();
    } catch (e) { toast(e.message, true); }
  }

  // ---- Events ---------------------------------------------------------------------
  document.addEventListener('click', async e => {
    const t = e.target;
    const kindBtn = t.closest('[data-kind]');
    if (kindBtn) { const k = kindBtn.dataset.kind; if (hidden.has(k)) hidden.delete(k); else hidden.add(k); store('aotc.diary.hidden', JSON.stringify([...hidden])); draw(); return; }
    const v = t.closest('[data-view]');
    if (v) { view = v.dataset.view; store('aotc.diary.view', view); draw(); return; }
    const dayEl = t.closest('[data-day]');
    if (dayEl && !t.closest('[data-item]')) { selDay = dayEl.dataset.day; document.querySelectorAll('.dy-day.sel').forEach(x => x.classList.remove('sel')); dayEl.classList.add('sel'); drawDay(); return; }
    const it = t.closest('[data-item]');
    if (it) { const i = items.find(x => x.key === it.dataset.item); if (i) openItem(i); return; }
    if (t.closest('[data-close]')) { $('itemOverlay').style.display = 'none'; return; }
    const ed = t.closest('[data-edit]');
    if (ed) { const i = items.find(x => x.key === ed.dataset.edit); if (i) openForm(i, { id: i.id }); return; }
    const del = t.closest('[data-del]');
    if (del) {
      const ok = await confirmDialog('Take this off the Church Diary?', { okText: 'Take it off', danger: true });
      if (!ok) return;
      try { await api(`/diary/${del.dataset.del}`, { method: 'DELETE' }); $('itemOverlay').style.display = 'none'; toast('Taken off the diary.'); load(); } catch (err) { toast(err.message, true); }
      return;
    }
    const sa = t.closest('[data-sug-add]');
    if (sa) { const s = sugs[Number(sa.dataset.sugAdd)]; if (s) openForm(s, { fromKey: s.key, foundIn: s.foundIn }); return; }
    const sn = t.closest('[data-sug-no]');
    if (sn) {
      const s = sugs[Number(sn.dataset.sugNo)]; if (!s) return;
      try { await api('/diary/suggestions/dismiss', { method: 'POST', body: { key: s.key } }); sugs = sugs.filter(x => x.key !== s.key); drawConfirm(); toast('Left off the diary.'); } catch (err) { toast(err.message, true); }
      return;
    }
    if (t.id === 'fSave') { saveForm(); return; }
    if (t.id === 'itemOverlay') { $('itemOverlay').style.display = 'none'; return; }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { $('itemOverlay').style.display = 'none'; $('ppOverlay').style.display = 'none'; }
    if (e.key === 'Enter' && document.activeElement && document.activeElement.matches('[data-day],[data-item]')) document.activeElement.click();
  });
  $('prevBtn').addEventListener('click', () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() - 1, 1, 12); load(); });
  $('nextBtn').addEventListener('click', () => { cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1, 12); load(); });
  $('todayBtn').addEventListener('click', () => { const d = new Date(); cursor = new Date(d.getFullYear(), d.getMonth(), 1, 12); selDay = keyOf(d); load(); });
  $('addBtn').addEventListener('click', () => openForm({ date: selDay }, {}));
  $('ppBtn').addEventListener('click', () => { $('ppYear').value = cursor.getFullYear(); $('ppStatus').textContent = ''; $('ppOverlay').style.display = 'flex'; drawPP(); });
  $('ppCancel').addEventListener('click', () => { $('ppOverlay').style.display = 'none'; });
  $('ppRead').addEventListener('click', readPlan);
  $('ppSave').addEventListener('click', savePlan);

  (async () => {
    me = await requireAuthAndRenderShell('/diary.html');
    if (!me) return;
    // Arriving with ?day=YYYY-MM-DD (from Home) opens that day.
    const want = new URLSearchParams(location.search).get('day');
    if (/^\d{4}-\d{2}-\d{2}$/.test(want || '')) { selDay = want; const d = fromKey(want); cursor = new Date(d.getFullYear(), d.getMonth(), 1, 12); }
    load();
  })();
})();
