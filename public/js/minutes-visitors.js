// AOTC Track — Minutes page: visitors to the Session.
//
// Visitors are received under the "Presentation" item, one group at a time:
// a delegation with a presentation, a bereaved family, a couple to be married,
// a committee or group of the congregation, a courtesy call. Each group is a
// card showing the paragraph exactly as it will print (VisitorsText), with Edit,
// Remove and move up/down. Visitors are deliberately NOT added to IN ATTENDANCE.
//
// page-minutes.js mounts it with:
//   MinutesVisitors.mount({
//     list: element, addBtn: element,
//     groups: () => doc.proceedings.visitors,
//     save: (groups) => …,              // stores and saves them
//     present: () => pools.present,     // names at tonight's meeting
//     linguist: () => pools.linguist,   // the Linguist, when present
//     mayEdit: () => mayEdit,
//   })
(function () {
  'use strict';
  const V = window.VisitorsText;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const t = (v) => String(v == null ? '' : v).trim();
  const OTHER = '__other__';
  let opts; let editing = -1; let draft = null;
  let cases = null; let entities = null;

  function el(id) { return document.getElementById(id); }
  function groups() { const g = opts.groups(); return Array.isArray(g) ? g : []; }
  function presentNames() {
    return (opts.present() || []).map((m) => (typeof m === 'string' ? m : (m && (m.name || m.label)) || '')).filter(Boolean);
  }
  // The Linguist's name, but only when marked present at this meeting.
  function linguistName() {
    const l = opts.linguist && opts.linguist();
    const n = t(typeof l === 'string' ? l : (l && l.name));
    if (!n) return '';
    const here = (opts.present() || []).find((m) => m && ((l.id && m.id === l.id) || m.name === n || m === n));
    return here ? t(typeof here === 'string' ? here : here.name) : '';
  }
  function purposeLabel(g) {
    if (g.purpose === 'other' && t(g.otherLabel)) return t(g.otherLabel);
    const p = V.PURPOSES.find((x) => x.key === g.purpose);
    return p ? p.label.replace(/ \(.*\)$/, '') : 'Presentation';
  }

  // ---- The list --------------------------------------------------------------
  function render() {
    const list = opts.list; const can = opts.mayEdit();
    const gs = groups();
    opts.addBtn.style.display = can ? '' : 'none';
    if (!gs.length) {
      list.innerHTML = '<p class="sub" style="margin:4px 0;font-size:12.5px;">No visitors recorded. The minutes will read “No presentation was scheduled for the meeting.”</p>';
      return;
    }
    list.innerHTML = gs.map((g, i) => {
      const n = (g.people || []).filter((p) => t(p && p.name)).length;
      return `<div class="vis-card" style="border:1px solid var(--border, #d0d4dc);border-radius:10px;padding:10px 12px;margin:8px 0;">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <strong>${i + 1}. ${esc(V.title(g))}</strong>
          <span class="sub" style="font-size:12px;">${n ? `${n} ${n === 1 ? 'person' : 'people'}` : 'no names yet'}</span>
          <span style="flex:1"></span>
          ${can ? `<button type="button" class="btn btn-secondary btn-sm" data-vis="up" data-i="${i}" ${i ? '' : 'disabled'} aria-label="Move up">↑</button>
          <button type="button" class="btn btn-secondary btn-sm" data-vis="down" data-i="${i}" ${i < gs.length - 1 ? '' : 'disabled'} aria-label="Move down">↓</button>
          <button type="button" class="btn btn-secondary btn-sm" data-vis="edit" data-i="${i}">Edit</button>
          <button type="button" class="btn btn-secondary btn-sm" data-vis="del" data-i="${i}">Remove</button>` : ''}
        </div>
        <div class="vis-preview" style="white-space:pre-wrap;font-size:13px;margin-top:6px;line-height:1.45;">${esc(V.paragraph(g, { letterRef: (id) => (opts.letterRef && opts.letterRef(id)) || (g.letterDate ? { current: false, date: g.letterDate, no: '' } : null) }))}</div>
      </div>`;
    }).join('');
  }

  function onListClick(e) {
    const b = e.target.closest('[data-vis]'); if (!b || !opts.mayEdit()) return;
    const i = Number(b.dataset.i); const gs = groups().slice();
    const act = b.dataset.vis;
    if (act === 'edit') { open(i); return; }
    if (act === 'del') {
      if (!window.confirm(`Remove “${purposeLabel(gs[i])}” from the visitors?`)) return;
      gs.splice(i, 1);
    } else if (act === 'up' && i > 0) { [gs[i - 1], gs[i]] = [gs[i], gs[i - 1]]; }
    else if (act === 'down' && i < gs.length - 1) { [gs[i + 1], gs[i]] = [gs[i], gs[i + 1]]; }
    else return;
    opts.save(gs); render();
  }

  // ---- The form ----------------------------------------------------------------
  function personSelect(id, value, emptyLabel) {
    const names = presentNames(); const v = t(value);
    const known = !v || v === V.SELF || names.some((n) => n === v);
    const ling = linguistName();
    const options = [`<option value="">${esc(emptyLabel)}</option>`, `<option value="${V.SELF}"${v === V.SELF ? ' selected' : ''}>They introduced themselves</option>`]
      .concat(names.map((n) => `<option value="${esc(n)}"${n === v ? ' selected' : ''}>${esc(n)}${ling && n === ling ? ' — Linguist' : ''}</option>`))
      .concat([`<option value="${OTHER}"${known ? '' : ' selected'}>Someone else (type the name)</option>`]);
    return `<select id="${id}">${options.join('')}</select>
      <input type="text" id="${id}__other" style="margin-top:6px;${known ? 'display:none;' : ''}" value="${known ? '' : esc(v)}" placeholder="Type the name">`;
  }
  // Who prayed: anyone present at the meeting, or a name typed in.
  function prayerSelect() {
    const names = presentNames(); const v = t(draft.prayedBy);
    const known = !v || names.includes(v);
    return `<select id="vPrayedBy"><option value="">— the Session —</option>${names.map((n) => `<option value="${esc(n)}"${n === v ? ' selected' : ''}>${esc(n)}</option>`).join('')}<option value="${OTHER}"${known ? '' : ' selected'}>Someone else (type the name)</option></select>
      <input type="text" id="vPrayedBy__other" style="margin-top:6px;${known ? 'display:none;' : ''}" value="${known ? '' : esc(v)}" placeholder="Type the name">`;
  }
  function readSelect(id) {
    const s = el(id); if (!s) return '';
    return s.value === OTHER ? t(el(`${id}__other`).value) : t(s.value);
  }

  function peopleRows() {
    const ps = draft.people.length ? draft.people : [{ name: '', role: '' }];
    return ps.map((p, i) => `<div class="vis-person" data-i="${i}" style="display:flex;gap:6px;align-items:center;margin:4px 0;">
        <input type="text" class="vp-name" value="${esc(p.name)}" placeholder="Name, e.g. Mr Kofi Mensah" style="flex:1.2;min-width:0;">
        <input type="text" class="vp-role" value="${esc(p.role)}" placeholder="${draft.purpose === 'funeral' ? 'e.g. son' : 'e.g. Ghana Water Company'}" style="flex:1;min-width:0;">
        ${ps.length > 1 ? `<label title="Optional — tick the one who spoke for the others; tap again to untick" style="display:flex;align-items:center;gap:5px;font-size:12px;white-space:nowrap;cursor:pointer;"><input type="checkbox" class="vp-leader" ${p.name && p.name === draft.leader ? 'checked' : ''}> ${leaderWord()}</label>` : '<input type="checkbox" class="vp-leader" style="display:none;">'}
        <button type="button" class="btn btn-secondary btn-sm vp-del" aria-label="Remove this person">✕</button>
      </div>`).join('');
  }

  function leaderWord() { return ['presentation', 'committee', 'courtesy'].includes(draft.purpose) ? 'Leader' : 'Spoke for them'; }
  function readPeople() {
    const rows = Array.from(document.querySelectorAll('#visPeople .vis-person'));
    let leader = '';
    draft.people = rows.map((r) => {
      const name = t(r.querySelector('.vp-name').value); const role = t(r.querySelector('.vp-role').value);
      if (r.querySelector('.vp-leader').checked && name) leader = name;
      return { name, role };
    });
    draft.leader = leader;
  }

  function purposeFields() {
    const p = draft.purpose;
    if (p === 'funeral') {
      return `<div class="field-row">
          <div class="field"><label>Name of the deceased</label><input type="text" id="vDeceased" value="${esc(draft.deceased)}" placeholder="e.g. Ophelia Ama Nyarkoaa Obeng"></div>
          <div class="field"><label>Who they were to the family <span class="sub">(optional)</span></label><input type="text" id="vRelation" value="${esc(draft.relation)}" placeholder="e.g. mother" list="vRelList">
            <datalist id="vRelList">${['mother', 'father', 'grandmother', 'grandfather', 'husband', 'wife', 'brother', 'sister', 'son', 'daughter', 'aunt', 'uncle'].map((r) => `<option value="${r}">`).join('')}</datalist></div>
        </div>
`;
    }
    if (p === 'marriage') {
      const caseSel = cases && cases.length
        ? `<div class="field"><label>Marriage case <span class="sub">(optional — fills the names, dates and times)</span></label><select id="vCase"><option value="">— none —</option>${cases.map((c) => `<option value="${esc(c.id)}"${String(c.id) === String(draft.marriageCaseId) ? ' selected' : ''}>${esc(c.refNo ? `${c.refNo} · ` : '')}${esc(c.couple || '')}</option>`).join('')}</select></div>` : '';
      return `${caseSel}<div class="field-row">
          <div class="field"><label>Groom</label><input type="text" id="vGroom" value="${esc(draft.groom)}" placeholder="e.g. Mr Kwabena Asante"></div>
          <div class="field"><label>Bride</label><input type="text" id="vBride" value="${esc(draft.bride)}" placeholder="e.g. Miss Abena Darko"></div>
        </div>
        ${marriageOccasions()}`;
    }
    if (p === 'seminarian') {
      // Who they are; the names go in the list of people below.
      const pro = draft.studentKind === 'probationer';
      return `<div class="field-row">
          <div class="field"><label>Who they are</label><select id="vStudKind">
            <option value="seminarian"${pro ? '' : ' selected'}>Seminarian on attachment</option>
            <option value="probationer"${pro ? ' selected' : ''}>Ministerial probationer</option></select></div>
          ${pro ? '' : `<div class="field"><label>Year <span class="sub">(optional)</span></label><input type="text" id="vStudyYear" list="vYearList" value="${esc(draft.studyYear)}" placeholder="e.g. third">
            <datalist id="vYearList">${['first', 'second', 'third', 'fourth'].map((y) => `<option value="${y}">`).join('')}</datalist></div>`}
        </div>
        ${pro ? '' : `<div class="field"><label>Seminary <span class="sub">(blank = Trinity Theological Seminary)</span></label><input type="text" id="vSeminary" value="${esc(draft.seminary)}" placeholder="Trinity Theological Seminary"></div>`}
        <div class="field-row">
          <div class="field"><label>With the congregation from <span class="sub">(optional)</span></label><input type="date" id="vAttachFrom" value="${esc(draft.attachFrom)}"></div>
          <div class="field"><label>to <span class="sub">(optional)</span></label><input type="date" id="vAttachTo" value="${esc(draft.attachTo)}"></div>
        </div>`;
    }
    if (p === 'committee') {
      const list = entities || [];
      const known = !draft.entityName || list.includes(draft.entityName);
      return `<div class="field"><label>Committee or group</label>
          <select id="vEntity"><option value="">— choose —</option>${list.map((n) => `<option value="${esc(n)}"${n === draft.entityName ? ' selected' : ''}>${esc(n)}</option>`).join('')}<option value="${OTHER}"${known ? '' : ' selected'}>Another (type the name)</option></select>
          <input type="text" id="vEntity__other" style="margin-top:6px;${known ? 'display:none;' : ''}" value="${known ? '' : esc(draft.entityName)}" placeholder="e.g. Finance Committee"></div>`;
    }
    if (p === 'other') {
      return `<div class="field"><label>What kind of visit <span class="sub">(for your list only)</span></label><input type="text" id="vOtherLabel" value="${esc(draft.otherLabel)}" placeholder="e.g. Thanksgiving"></div>`;
    }
    return '';
  }

  // An intended marriage is two occasions: the traditional (customary) marriage,
  // then the church wedding — each with its date, time and place. Either may
  // be left blank. Older entries had only a wedding date: the church wedding.
  const MARRIAGE_KINDS = [['trad', 'traditional marriage', 'Traditional marriage', 'e.g. the bride’s family house, Kaneshie'], ['church', 'church wedding', 'Church wedding', 'e.g. the AOTC Chapel'], ['thanks', 'thanksgiving service', 'Thanksgiving service', 'e.g. the AOTC Chapel']];
  function marriageEventsOf(d) {
    const es = Array.isArray(d.events) ? d.events : [];
    const find = (what) => es.find((e) => e && t(e.what).toLowerCase() === what) || {};
    const church = find('church wedding');
    return {
      trad: find('traditional marriage'),
      church: Object.keys(church).length ? church : (t(d.weddingDate) ? { date: d.weddingDate } : {}),
      thanks: find('thanksgiving service'),
    };
  }
  function marriageOccasions() {
    const m = marriageEventsOf(draft);
    return MARRIAGE_KINDS.map(([k, , label, ph]) => {
      const e = m[k] || {};
      return `<div class="field vis-marr" style="border:1px dashed var(--border, #d0d4dc);border-radius:8px;padding:6px 8px;margin:6px 0;">
          <label>${label} <span class="sub">(optional — date, time and venue)</span></label>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
            <input type="date" id="v${k}Date" value="${esc(e.date)}" style="flex:1 1 140px;min-width:0;" aria-label="${label} — date">
            <input type="text" id="v${k}Time" class="ve-time" value="${esc(e.time)}" placeholder="Time, e.g. 10am" style="flex:0 1 110px;min-width:0;" aria-label="${label} — time">
          </div>
          <input type="text" id="v${k}Venue" value="${esc(e.venue)}" placeholder="Venue — ${ph}" style="margin-top:6px;" aria-label="${label} — venue">
        </div>`;
    }).join('');
  }
  function readMarriage() {
    if (!el('vtradDate')) return;
    draft.events = MARRIAGE_KINDS.map(([k, what]) => ({ what, date: t(el(`v${k}Date`).value), time: t(el(`v${k}Time`).value), venue: t(el(`v${k}Venue`).value) }))
      .filter((e) => e.date || e.time || e.venue);
    // Kept for anything that still reads the one date (it is the church wedding).
    draft.weddingDate = t(el('vchurchDate').value);
  }

  // Funeral arrangements: what, date, time, venue, and anything said about it.
  const EVENT_KINDS = ['one-week observance', 'wake-keeping', 'burial service', 'funeral service', 'thanksgiving service', 'memorial service'];
  function eventRows() {
    const es = Array.isArray(draft.events) && draft.events.length ? draft.events : [{}];
    return `<datalist id="vEvKinds">${EVENT_KINDS.map((k) => `<option value="${k}">`).join('')}</datalist>` + es.map((e, i) => `<div class="vis-event" data-i="${i}" style="border:1px dashed var(--border, #d0d4dc);border-radius:8px;padding:6px 8px;margin:6px 0;">
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
          <input type="text" class="ve-what" list="vEvKinds" value="${esc(e.what)}" placeholder="What — e.g. one-week observance" style="flex:2 1 180px;min-width:0;">
          <input type="date" class="ve-date" value="${esc(e.date)}" style="flex:1 1 130px;min-width:0;">
          <input type="text" class="ve-time" value="${esc(e.time)}" placeholder="Time, e.g. 9am" style="flex:0 1 100px;min-width:0;">
          <button type="button" class="btn btn-secondary btn-sm ve-del" aria-label="Remove this arrangement">✕</button>
        </div>
        <input type="text" class="ve-venue" value="${esc(e.venue)}" placeholder="Venue — e.g. the AOTC premises" style="margin-top:6px;">
        <input type="text" class="ve-note" value="${esc(e.note)}" placeholder="Anything else about it — e.g. after the service the family would meet at Fadama junction to host guests" style="margin-top:6px;">
      </div>`).join('');
  }
  function readEvents() {
    const rows = Array.from(document.querySelectorAll('#vEvents .vis-event'));
    if (!rows.length) return;
    const q = (r, c) => t(r.querySelector(c).value);
    draft.events = rows.map((r) => ({ what: q(r, '.ve-what'), date: q(r, '.ve-date'), time: q(r, '.ve-time'), venue: q(r, '.ve-venue'), note: q(r, '.ve-note') }));
  }
  function funeralArrangements() {
    return `<div class="field"><label>Funeral arrangements <span class="sub">(one each — one-week observance, burial service, thanksgiving…; printed as sentences)</span></label>
          <div id="vEvents">${eventRows()}</div>
          <button type="button" class="btn btn-secondary btn-sm" id="vAddEvent" style="margin-top:4px;">+ Add an arrangement</button></div>
        ${t(draft.funeralDetails) ? `<div class="field"><label>Other arrangements <span class="sub">(older entry)</span></label><input type="text" id="vFuneral" value="${esc(draft.funeralDetails)}"></div>` : ''}`;
  }
  // ---- A letter they brought ------------------------------------------------
  // The letter lives in Correspondence (one photo, one record); the group only
  // points at it. Printed under Presentation with the visit, not again under
  // Correspondence.
  function letters() { return (opts.letters && opts.letters()) || []; }
  function letterBlock() {
    const ls = letters(); const id = String(draft.letterId || '');
    const here = ls.find((c) => String(c.id) === id);
    // A letter from an earlier meeting, picked from the register.
    const earlier = !here && id ? { id, heading: draft.letterHeading, meetingDate: draft.letterDate, files: draft.letterPages ? new Array(draft.letterPages) : [] } : null;
    const cur = here || earlier;
    const pages = cur ? ((cur.files && cur.files.length) || (cur.file ? 1 : 0)) : 0;
    return `<div class="field"><label>Letter they brought <span class="sub">(optional — kept in Correspondence, printed here only)</span></label>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        <select id="vLetter" style="flex:1 1 220px;min-width:0;"><option value="">— no letter —</option>${ls.length ? `<optgroup label="This meeting’s correspondence">${ls.map((c) => `<option value="${esc(c.id)}"${String(c.id) === id ? ' selected' : ''}>${esc(c.heading || 'Untitled letter')}${c.from ? ` · ${esc(c.from)}` : ''}</option>`).join('')}</optgroup>` : ''}${earlier ? `<optgroup label="From an earlier meeting"><option value="${esc(id)}" selected>${esc(draft.letterHeading || 'Letter')}${draft.letterDate ? ` · ${esc(V.longDate(draft.letterDate))}` : ''}</option></optgroup>` : ''}</select>
        <button type="button" class="btn btn-secondary btn-sm" id="vLetterPhoto">📷 Photograph / upload a letter</button>
        <button type="button" class="btn btn-secondary btn-sm" id="vLetterFind">Find one from an earlier meeting</button>
      </div>
      <div id="vLetterSearch" style="display:none;margin-top:6px;">
        <input type="search" id="vLetterQ" placeholder="Search the correspondence register — e.g. Ameyaw, funeral">
        <div id="vLetterHits" style="max-height:220px;overflow:auto;margin-top:4px;"></div>
        <input type="file" id="vLetterFile" accept="image/*,application/pdf" multiple style="display:none;">
      </div>
      ${cur ? `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px;">
          <button type="button" class="btn btn-primary btn-sm" id="vLetterRead" ${pages ? '' : 'disabled'}>Fill in from the letter</button>
          <span class="sub" style="font-size:11.5px;" id="vLetterNote">${pages ? `${pages} page${pages === 1 ? '' : 's'} attached. Fills only the empty boxes — check them after.` : 'No pages on this letter yet — attach them in Correspondence, or photograph it here.'}</span>
        </div>
        <p class="sub" style="margin:4px 0 0;font-size:11.5px;">${here ? 'Prints under Correspondence; the visit refers to its item number, and a funeral’s arrangements are left to the letter.' : 'From an earlier meeting: the visit names that meeting, and the arrangements you enter here print with the visit.'}</p>` : ''}
    </div>`;
  }
  function redrawLetter() { el('vLetterBox').innerHTML = letterBlock(); }
  let searchTimer = null;
  async function searchLetters(q) {
    const box = el('vLetterHits'); if (!box) return;
    box.innerHTML = '<p class="sub" style="font-size:12px;">Searching…</p>';
    try {
      const r = await fetch(`/api/minutes/correspondence/register${q ? `?q=${encodeURIComponent(q)}` : ''}`, { credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error((d && d.error) || 'Could not search the register.');
      const mine = String(opts.minutesId());
      const hits = (Array.isArray(d) ? d : []).filter((c) => c.minutesId && String(c.minutesId) !== mine).slice(0, 30);
      box.innerHTML = hits.length ? hits.map((c) => `<button type="button" class="vl-hit" data-id="${esc(c.id)}" data-h="${esc(c.heading || '')}" data-d="${esc(c.meetingDate || '')}" data-p="${esc(c.pages || 0)}" style="display:block;width:100%;text-align:left;border:1px solid var(--border, #d0d4dc);border-radius:8px;padding:6px 8px;margin:4px 0;background:none;cursor:pointer;">
          <strong>${esc(c.heading || 'Untitled letter')}</strong>${c.from ? ` · ${esc(c.from)}` : ''}<br><span class="sub" style="font-size:11.5px;">Meeting of ${esc(c.meetingDate ? V.longDate(c.meetingDate) : '—')}</span></button>`).join('')
        : '<p class="sub" style="font-size:12px;">No letter from an earlier meeting matches.</p>';
    } catch (err) { box.innerHTML = `<p class="sub" style="font-size:12px;">${esc(err.message)}</p>`; }
  }
  async function uploadLetter(files) {
    if (!files.length) return;
    const note = (m) => { const n = el('vLetterNote'); if (n) n.textContent = m; };
    const btn = el('vLetterPhoto'); btn.disabled = true; btn.textContent = `Saving ${files.length} page${files.length === 1 ? '' : 's'}…`;
    try {
      const fd = new FormData();
      fd.append('heading', 'Letter from visitors');
      files.forEach((f) => fd.append('letter', f));
      const r = await fetch(`/api/minutes/${opts.minutesId()}/correspondence`, { method: 'POST', body: fd, credentials: 'same-origin' });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not save the letter.');
      opts.addLetter(d);
      readForm(); draft.letterId = String(d.id); redrawLetter(); preview();
      readLetter();
    } catch (err) {
      btn.disabled = false; btn.textContent = '📷 Photograph / upload a letter';
      window.alert(err.message);
    }
  }
  // Ask the server to read the letter, then fill only what is still empty.
  async function readLetter() {
    const id = draft.letterId; if (!id) return;
    const b = el('vLetterRead'); const n = el('vLetterNote');
    if (b) { b.disabled = true; b.textContent = 'Reading the letter…'; }
    try {
      const r = await fetch(`/api/minutes/correspondence/${encodeURIComponent(id)}/visitors-read`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ minutesId: opts.minutesId() }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not read the letter.');
      if (d.letter && opts.updateLetter) opts.updateLetter(d.letter);
      readForm();
      const x = d.read || {};
      const fill = (k) => { if (!t(draft[k]) && t(x[k])) draft[k] = x[k]; };
      if (x.purpose && !draft.people.some((p) => p.name) && !t(draft.deceased)) draft.purpose = x.purpose;
      ['from', 'deceased', 'relation', 'groom', 'bride', 'weddingDate', 'why'].forEach(fill);
      if (!draft.people.some((p) => p.name) && Array.isArray(x.people) && x.people.length) draft.people = x.people;
      const noEvents = !(draft.events || []).some((e) => t(e.what) || t(e.date) || t(e.venue));
      if (noEvents && Array.isArray(x.events) && x.events.length) draft.events = x.events;
      drawForm(); loadLists();
      const n2 = el('vLetterNote'); if (n2) n2.textContent = 'Filled from the letter — please check every box.';
    } catch (err) {
      if (b) { b.disabled = false; b.textContent = 'Fill in from the letter'; }
      if (n) n.textContent = err.message;
    }
  }

  // ---- Tidy ------------------------------------------------------------------
  // The same tidy-up as the minutes' own items (opts.tidy → /minutes/polish).
  // The text before the tidy is kept for this form, so it can be put back.
  const beforeTidy = {};
  function tidyButtons(id) {
    if (!opts.tidy) return '';
    return `<div style="display:flex;gap:6px;margin-top:6px;flex-wrap:wrap;">
      <button type="button" class="btn btn-secondary btn-sm" data-tidy="${id}">✨ Tidy</button>
      ${typeof beforeTidy[id] === 'string' ? `<button type="button" class="btn btn-secondary btn-sm" data-untidy="${id}">↶ My notes before tidy-up</button>` : ''}
    </div>`;
  }
  async function tidy(id, btn) {
    const box = el(id); const text = box.value;
    if (!t(text)) { window.alert('Type your notes first.'); return; }
    btn.disabled = true; btn.textContent = 'Tidying…';
    // What has already been written for this group, so the tidied notes carry
    // on from it rather than repeat it.
    readForm();
    const subject = `Presentation — ${id === 'vResponse' ? 'the Session’s response to' : 'what was said by'} visitors to the Session`;
    const lead = V.paragraph({ ...draft, details: id === 'vDetails' ? '' : draft.details, response: '', withdrew: false }, ctx());
    const out = await opts.tidy(text, subject, lead);
    if (out && t(out)) {
      beforeTidy[id] = text;
      if (id === 'vDetails') draft.details = t(out); else draft.response = t(out);
      drawForm();
    } else { btn.disabled = false; btn.textContent = '✨ Tidy'; }
  }

  function readForm() {
    readPeople();
    if (el('vLetter')) {
      draft.letterId = el('vLetter').value;
      if (letters().some((c) => String(c.id) === String(draft.letterId)) || !draft.letterId) { delete draft.letterHeading; delete draft.letterDate; delete draft.letterPages; }
    }
    readEvents();
    if (el('vFrom')) draft.from = t(el('vFrom').value);
    if (el('vTitle')) draft.title = t(el('vTitle').value);
    draft.purpose = el('vPurpose').value;
    draft.introducedBy = readSelect('vIntro');
    draft.introducedByLinguist = !!draft.introducedBy && draft.introducedBy === linguistName();
    draft.why = t(el('vWhy').value);
    draft.details = t(el('vDetails').value);
    draft.response = t(el('vResponse').value);
    draft.responseIsDecision = el('vDecision').checked;
    draft.withdrew = el('vWithdrew').checked;
    draft.prayedFor = el('vPrayed').checked;
    draft.prayedBy = draft.prayedFor ? readSelect('vPrayedBy') : '';
    const v = (id) => (el(id) ? t(el(id).value) : undefined);
    if (el('vDeceased')) { draft.deceased = v('vDeceased'); draft.relation = v('vRelation'); if (el('vFuneral')) draft.funeralDetails = v('vFuneral'); }
    if (draft.purpose !== 'funeral' && draft.purpose !== 'marriage') delete draft.events;
    if (el('vGroom')) { draft.groom = v('vGroom'); draft.bride = v('vBride'); readMarriage(); draft.marriageCaseId = el('vCase') ? el('vCase').value : draft.marriageCaseId; }
    if (el('vStudKind')) {
      draft.studentKind = el('vStudKind').value;
      draft.studyYear = v('vStudyYear') || ''; draft.seminary = v('vSeminary') || '';
      draft.attachFrom = v('vAttachFrom'); draft.attachTo = v('vAttachTo');
    }
    if (el('vEntity')) draft.entityName = readSelect('vEntity');
    if (el('vOtherLabel')) draft.otherLabel = v('vOtherLabel');
  }

  function drawForm() {
    const ling = linguistName();
    el('visForm').innerHTML = `
      <div class="field"><label>Purpose of the visit</label>
        <select id="vPurpose">${V.PURPOSES.map((p) => `<option value="${p.key}"${p.key === draft.purpose ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select></div>
      <div class="field"><label>Heading in the minutes <span class="sub">(its own item under Presentation — leave blank for the suggested one)</span></label><input type="text" id="vTitle" value="${esc(draft.title)}" placeholder="${esc(V.title({ ...draft, title: '' }))}"></div>
      <div id="vLetterBox">${letterBlock()}</div>
      <div id="vPurposeFields">${purposeFields()}</div>
      <div class="field"><label>${draft.purpose === 'seminarian' ? (draft.studentKind === 'probationer' ? 'The probationer' : 'The seminarian') : draft.purpose === 'marriage' ? 'Accompanied by' : draft.purpose === 'committee' ? 'Represented by' : draft.purpose === 'funeral' ? 'Members of the family' : 'The visitors'} <span class="sub">(${draft.purpose === 'funeral' ? 'name, and if you wish who they are, e.g. son' : 'name, then who they are'}. With more than one, you may tick the one who spoke for them — optional)</span></label>
        <div id="visPeople">${peopleRows()}</div>
        <button type="button" class="btn btn-secondary btn-sm" id="vAddPerson" style="margin-top:4px;">+ Add a person</button></div>
      ${draft.purpose === 'committee' ? '' : `<div class="field"><label>Where they came from <span class="sub">(optional — a place, church or company)</span></label><input type="text" id="vFrom" value="${esc(draft.from)}" placeholder="${draft.purpose === 'funeral' ? 'e.g. Osu, Accra' : 'e.g. Ghana Water Company'}"></div>`}
      <div class="field"><label>Introduced by</label>
        ${personSelect('vIntro', draft.introducedBy, '— No introduction (the minutes go straight in) —')}
        <p class="sub" style="margin:4px 0 0;font-size:11.5px;">${ling ? `The Linguist, ${esc(ling)}, is chosen by default. Pick whoever introduced them if it was someone else, “They introduced themselves”, or “No introduction”.` : 'The Linguist is not marked present at this meeting — pick whoever introduced them, “They introduced themselves”, or “No introduction”.'}</p></div>
      <div class="field"><label>${draft.purpose === 'funeral' ? 'Anything more on why they came <span class="sub">(optional — the announcement is written from the name above)</span>' : 'Why they came'}</label><input type="text" id="vWhy" value="${esc(draft.why)}" placeholder="${draft.purpose === 'funeral' ? 'e.g. They also asked for the Session’s support' : draft.purpose === 'marriage' ? 'e.g. to seek the Session’s blessing for their marriage' : 'e.g. to brief the Session on the proposed borehole project'}"></div>
      <div class="field"><label>What they said or presented <span class="sub">(optional — rough notes are fine; Tidy writes them up as minutes)</span></label><textarea id="vDetails" rows="3" placeholder="${draft.purpose === 'funeral' ? 'e.g. she said letter already sent to admin' : 'e.g. explained cost and timetable'}">${esc(draft.details)}</textarea>${tidyButtons('vDetails')}</div>
      ${draft.purpose === 'funeral' ? funeralArrangements() : ''}
      <div class="field"><label>The Session's response <span class="sub">(optional)</span></label><textarea id="vResponse" rows="2" placeholder="e.g. The Session thanked them and prayed with them">${esc(draft.response)}</textarea>${tidyButtons('vResponse')}
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-top:4px;"><input type="checkbox" id="vDecision" ${draft.responseIsDecision ? 'checked' : ''}> This is a decision (prints as “Decision: …”)</label></div>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:6px;"><input type="checkbox" id="vPrayed" ${draft.prayedFor ? 'checked' : ''}> They were prayed for before they left</label>
      <div class="field" id="vPrayedBox" style="${draft.prayedFor ? '' : 'display:none;'}margin-left:24px;"><label>Prayer said by</label>${prayerSelect()}</div>
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;"><input type="checkbox" id="vWithdrew" ${draft.withdrew ? 'checked' : ''}> They left the meeting after being heard <span class="sub" style="font-size:11.5px;">(adds “… took leave of the Session.”)</span></label>
      <div class="field" style="margin-top:10px;"><label>How it will read</label><div id="vPreview" style="white-space:pre-wrap;font-size:13px;line-height:1.45;border-left:3px solid var(--border, #d0d4dc);padding:4px 10px;"></div></div>`;
    preview();
  }
  // Item numbers for the preview come from the page (opts.letterRef); the
  // document works them out again when it is produced.
  function ctx() {
    return { letterRef: (id) => {
      const r = opts.letterRef && opts.letterRef(id);
      if (r) return r;
      if (String(id) === String(draft.letterId) && draft.letterDate) return { current: false, date: draft.letterDate, no: '' };
      return null;
    } };
  }
  function preview() {
    const p = el('vPreview'); if (p) p.textContent = `${V.title(draft)}\n${V.paragraph(draft, ctx())}`;
    const h = el('vTitle'); if (h) h.placeholder = V.title({ ...draft, title: '' });
  }

  function onFormInput(e) {
    const id = e.target.id;
    // Only one person speaks for the group; ticking one unticks the others.
    if (e.target.classList && e.target.classList.contains('vp-leader') && e.target.checked) {
      document.querySelectorAll('#visPeople .vp-leader').forEach((x) => { if (x !== e.target) x.checked = false; });
    }
    if (id === 'vPurpose') { readForm(); draft.purpose = e.target.value; drawForm(); loadLists(); return; }
    if (id === 'vStudKind' && e.type === 'change') { readForm(); drawForm(); loadLists(); return; }
    if (id === 'vLetterQ') { clearTimeout(searchTimer); const q = e.target.value; searchTimer = setTimeout(() => searchLetters(q.trim()), 300); return; }
    if (id === 'vLetterFile') { if (e.type === 'change') uploadLetter(Array.from(e.target.files || [])); return; }
    if (id === 'vLetter') { if (e.type === 'change') { readForm(); redrawLetter(); preview(); } return; }
    // A time typed any way is put in the minutes' style when the box is left.
    if (e.type === 'change' && e.target.classList && e.target.classList.contains('ve-time')) e.target.value = V.clock(e.target.value);
    if (id === 'vPrayed') el('vPrayedBox').style.display = e.target.checked ? '' : 'none';
    if (id === 'vIntro' || id === 'vEntity' || id === 'vPrayedBy') { el(`${id}__other`).style.display = e.target.value === OTHER ? '' : 'none'; }
    if (id === 'vCase') {
      // The select gives a string; case ids are numbers — compare as text, or no case is ever found.
      const c = (cases || []).find((x) => String(x.id) === String(e.target.value));
      if (c) {
        const [h, w] = String(c.couple || '').split(/\s+&\s+/);
        if (h) el('vGroom').value = h; if (w) el('vBride').value = w;
        // The dates, times and places set on the case, without overwriting anything typed.
        const put = (id, val) => { if (el(id) && !t(el(id).value) && t(val)) el(id).value = val; };
        const dayOf = (d) => (/^\d{4}-\d{2}-\d{2}/.test(String(d || '')) ? String(d).slice(0, 10) : '');
        put('vtradDate', dayOf(c.customaryDate)); put('vtradTime', c.customaryTime ? V.clock(c.customaryTime) : ''); put('vtradVenue', c.customaryVenue);
        put('vchurchDate', dayOf(c.marriageDate)); put('vchurchTime', c.marriageTime ? V.clock(c.marriageTime) : ''); put('vchurchVenue', c.marriageVenue);
        put('vthanksDate', dayOf(c.thanksgivingDate)); put('vthanksTime', c.thanksgivingTime ? V.clock(c.thanksgivingTime) : ''); put('vthanksVenue', c.thanksgivingVenue);
      }
    }
    readForm(); preview();
  }
  function onFormClick(e) {
    if (e.target.id === 'vAddPerson') { readForm(); draft.people.push({ name: '', role: '' }); el('visPeople').innerHTML = peopleRows(); const ns = document.querySelectorAll('#visPeople .vp-name'); ns[ns.length - 1].focus(); return; }
    const tb = e.target.closest('[data-tidy]');
    if (tb) { tidy(tb.dataset.tidy, tb); return; }
    const ub = e.target.closest('[data-untidy]');
    if (ub) {
      readForm();
      const id = ub.dataset.untidy;
      if (id === 'vDetails') draft.details = beforeTidy[id]; else draft.response = beforeTidy[id];
      delete beforeTidy[id]; drawForm(); return;
    }
    if (e.target.id === 'vLetterPhoto') { el('vLetterFile').click(); return; }
    if (e.target.id === 'vLetterFind') { el('vLetterSearch').style.display = ''; el('vLetterQ').focus(); searchLetters(''); return; }
    const hit = e.target.closest('.vl-hit');
    if (hit) {
      readForm();
      draft.letterId = hit.dataset.id; draft.letterHeading = hit.dataset.h; draft.letterDate = hit.dataset.d; draft.letterPages = Number(hit.dataset.p) || 0;
      redrawLetter(); preview(); return;
    }
    if (e.target.id === 'vLetterRead') { readForm(); readLetter(); return; }
    if (e.target.id === 'vAddEvent') { readForm(); draft.events = (draft.events || []).concat([{}]); el('vEvents').innerHTML = eventRows(); return; }
    const evDel = e.target.closest('.ve-del');
    if (evDel) { readForm(); draft.events.splice(Number(evDel.closest('.vis-event').dataset.i), 1); el('vEvents').innerHTML = eventRows(); readForm(); preview(); return; }
    const del = e.target.closest('.vp-del');
    if (del) { readForm(); draft.people.splice(Number(del.closest('.vis-person').dataset.i), 1); el('visPeople').innerHTML = peopleRows(); readForm(); preview(); }
  }

  // The marriage register and the congregation's committees and groups, fetched
  // once when first needed; either may be unavailable to this user, which only
  // means typing the names instead.
  async function loadLists() {
    const get = async (u) => { try { const r = await fetch(u, { credentials: 'same-origin' }); return r.ok ? r.json() : null; } catch (_) { return null; } };
    if (draft.purpose === 'marriage' && cases === null) {
      const d = await get('/api/marriage/cases');
      cases = (Array.isArray(d) ? d : (d && (d.cases || d.items)) || []).filter((c) => c && c.id);
      if (draft.purpose === 'marriage') { readForm(); el('vPurposeFields').innerHTML = purposeFields(); }
    }
    if (draft.purpose === 'committee' && entities === null) {
      const [c, g] = await Promise.all([get('/api/setup/committees'), get('/api/setup/groups')]);
      const names = (x) => (Array.isArray(x) ? x : (x && (x.items || x.committees || x.groups)) || []).map((i) => t(typeof i === 'string' ? i : i && i.name)).filter(Boolean);
      entities = Array.from(new Set(names(c).concat(names(g)))).sort((a, b) => a.localeCompare(b));
      if (draft.purpose === 'committee') { readForm(); el('vPurposeFields').innerHTML = purposeFields(); }
    }
  }

  function open(i) {
    editing = i;
    Object.keys(beforeTidy).forEach((k) => { delete beforeTidy[k]; });
    const g = i >= 0 ? groups()[i] : null;
    const ling = linguistName();
    draft = JSON.parse(JSON.stringify(g || { purpose: 'presentation', people: [], introducedBy: ling, introducedByLinguist: !!ling, withdrew: true }));
    draft.people = Array.isArray(draft.people) ? draft.people : [];
    el('visTitle').textContent = i >= 0 ? 'Edit visitors' : 'Add visitors';
    el('visSave').textContent = i >= 0 ? 'Save' : 'Add';
    drawForm(); loadLists();
    el('visOverlay').style.display = 'flex';
  }
  function close() { el('visOverlay').style.display = 'none'; draft = null; editing = -1; }
  function save() {
    readForm();
    draft.people = draft.people.filter((p) => p.name);
    if (!draft.people.length && !draft.deceased && !draft.groom && !draft.bride && !draft.entityName) {
      window.alert('Add at least one name.'); return;
    }
    const gs = groups().slice();
    if (editing >= 0) gs[editing] = draft; else gs.push(draft);
    opts.save(gs); close(); render();
  }

  // The page styles every input as a full-width box; ticks need their own size.
  function addStyles() {
    if (document.getElementById('visStyles')) return;
    const st = document.createElement('style'); st.id = 'visStyles';
    st.textContent = '#visForm input[type=checkbox]{width:18px;height:18px;min-height:0;padding:0;margin:0;flex:0 0 18px;accent-color:var(--primary,#1e3a8a);}'
      + '#visForm label:has(> input[type=checkbox]){justify-content:flex-start;text-align:left;}';
    document.head.appendChild(st);
  }
  function mount(o) {
    opts = o;
    addStyles();
    opts.list.addEventListener('click', onListClick);
    opts.addBtn.addEventListener('click', () => { if (opts.mayEdit()) open(-1); });
    el('visForm').addEventListener('input', onFormInput);
    el('visForm').addEventListener('change', onFormInput);
    el('visForm').addEventListener('click', onFormClick);
    el('visCancel').addEventListener('click', close);
    el('visSave').addEventListener('click', save);
    render();
  }

  window.MinutesVisitors = { mount, render, open, linguistHere: () => linguistName() };
})();
