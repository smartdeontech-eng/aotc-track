// AOTC Track — the Session agenda editor, shared.
//
// The agenda can be edited from two places: the Session Meetings page, where a
// meeting is set up, and the Agenda tab of the Session Minutes page, where the
// clerk works on the night. They edit the SAME doc.agenda, so they must behave
// the same — this file is that behaviour, in one copy, because when it lived in
// two copies they drifted and only one of them grew the dropdowns.
//
// Each page keeps its own agSet / agSubSet / agDel / agSubAdd / agSubDel and
// its own saving, since one autosaves the whole document and the other saves
// the agenda alone. The markup below calls those by name.
window.AgendaEditor = (function () {
  const esc2 = s => (window.esc ? esc(s) : String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));

  // ---- the two running orders ----------------------------------------------
  const STANDARD = [
    { mins: 8, item: 'Devotion', responsible: '' },
    { mins: 1, item: 'Constitution of The Session', responsible: 'District Minister' },
    { mins: 1, item: 'Roll and Apology', responsible: 'Session Clerk' },
    { mins: 10, item: 'Presentation', responsible: '' },
    { mins: 10, item: 'Review of minutes', responsible: 'Session Clerk' },
    { mins: 15, item: 'Matters Arising', responsible: '', subItems: [] },
    { mins: 20, item: 'Main Business', responsible: '', subItems: [] },
    { mins: 10, item: 'Correspondence', responsible: 'Session Clerk' },
    { mins: 10, item: 'Other Matters', responsible: 'All' },
    { mins: 10, item: 'Prayers', responsible: 'Senior Presbyter' },
    { mins: 0, item: 'Closure', responsible: '' },
  ];
  // The reports the Session receives. They do not come to every meeting, so
  // they are a second running order rather than part of the first — and they
  // sit after Main Business, where the minutes expect them.
  const REPORTS = {
    mins: 25, item: 'Reports', responsible: '',
    subItems: [
      { item: 'Church Finance', responsible: 'Treasurer' },
      // CLAN added 21 Oct 2026 — it was missing here though the minutes have
      // always had a CLAN report slot (REPORT_SLOTS in utils/sessionMinutes.js).
      { item: 'CLAN', responsible: 'CLAN Coordinator' },
      { item: 'Mission and Evangelism', responsible: '' },
      { item: 'Presbyters on Duty', responsible: '' },
    ],
  };
  function standardOrder(withReports) {
    const rows = STANDARD.map(r => ({ ...r, subItems: (r.subItems || []).map(s => ({ ...s })) }));
    if (!withReports) return rows;
    const at = rows.findIndex(r => /main business/i.test(r.item || ''));
    const reports = { ...REPORTS, subItems: REPORTS.subItems.map(s => ({ ...s })) };
    rows.splice(at < 0 ? rows.length : at + 1, 0, reports);
    return rows;
  }

  // ---- who an agenda item belongs to ---------------------------------------
  // Three ways of saying it, in the order a Clerk thinks of them:
  //   the OFFICE   — "Constitution of the Session, District Minister". Still
  //                  true after the minister changes, which is the point.
  //   the PERSON   — "Building project, Ing Sampson Agudze", by name.
  //   anyone else  — typed in, for someone not on the Session at all.
  const STOCK = ['Presbyters on Duty', 'All'];
  function options(current, offices, roster) {
    const cur = String(current || '').trim();
    const names = (roster || []).filter(m => m.active !== false)
      .map(m => m.proseName || m.displayName || m.name);
    const known = [...(offices || []).map(o => o.label), ...names, ...STOCK];
    const opt = v => `<option value="${esc2(v)}"${v === cur ? ' selected' : ''}>${esc2(v)}</option>`;
    let html = `<option value=""${cur ? '' : ' selected'}>— nobody named —</option>`;
    // Anything already recorded that is on neither list — two names from the
    // duty roster, an outside body — stays selected rather than vanishing.
    if (cur && !known.includes(cur)) html += `<optgroup label="Recorded">${opt(cur)}</optgroup>`;
    if ((offices || []).length) {
      html += '<optgroup label="By office">' + offices.map(o => opt(o.label)).join('') + '</optgroup>';
    }
    html += '<optgroup label="Commonly">' + STOCK.map(opt).join('') + '</optgroup>';
    if (names.length) {
      html += '<optgroup label="By name">' + names.map(opt).join('') + '</optgroup>';
    }
    html += '<option value="__other__">Someone else — type a name…</option>';
    return html;
  }

  // ---- the rows ------------------------------------------------------------
  function rows(o) {
    const { agenda = [], times = [], mayEdit = false, offices = [], roster = [],
            meetings = [], date = '' } = o || {};
    const dis = mayEdit ? '' : 'disabled';
    const resp = (current, handler) => `
            <div>
              <select onchange="${handler}(this)" ${dis}>${options(current, offices, roster)}</select>
              <input type="text" class="respOther" placeholder="Type the name" style="display:none; margin-top:5px;"
                     onchange="${handler}Typed(this)" ${dis}>
            </div>`;
    return agenda.map((r, i) => `
      <div class="ag-row">
        <div class="at">${esc2(times[i] || '')}</div>
        <input type="number" min="0" step="1" value="${r.mins || 0}" onchange="agSet(${i},'mins',this.value)" ${dis}>
        <input type="text" value="${esc2(r.item || '')}" placeholder="Agenda item" onchange="agSet(${i},'item',this.value)" ${dis}>
        <div>
          <select onchange="agResp(${i},null,this)" ${dis}>${options(r.responsible, offices, roster)}</select>
          <input type="text" class="respOther" placeholder="Type the name" style="display:none; margin-top:5px;"
                 onchange="agRespTyped(${i},null,this)" ${dis}>
        </div>
        ${mayEdit ? `<button class="btn btn-danger btn-sm" onclick="agDel(${i})" title="Remove">✕</button>` : '<span></span>'}
      </div>
      ${(r.subItems || []).map((s, j) => `
        <div class="ag-sub">
          <input type="text" value="${esc2(s.item || '')}" placeholder="Sub-item" onchange="agSubSet(${i},${j},'item',this.value)" ${dis}>
          <div>
            <select onchange="agResp(${i},${j},this)" ${dis}>${options(s.responsible, offices, roster)}</select>
            <input type="text" class="respOther" placeholder="Type the name" style="display:none; margin-top:5px;"
                   onchange="agRespTyped(${i},${j},this)" ${dis}>
          </div>
          ${mayEdit ? `<button class="btn btn-danger btn-sm" onclick="agSubDel(${i},${j})">✕</button>` : '<span></span>'}
        </div>`).join('')}
      ${mayEdit ? `<div class="ag-sub"><div style="display:flex; gap:6px; justify-self:start;">
        <button class="btn btn-secondary btn-sm" onclick="agSubAdd(${i})">+ sub-item</button>
        ${MATTERS_ROW.test(r.item || '')
          ? `<button class="btn btn-secondary btn-sm" onclick="agFromRegister(${i})"
               title="Choose which outstanding headings come onto this agenda">⤢ Bring in from the register</button>` : ''}
        ${REVIEW_ROW.test(r.item || '') ? reviewPicker(i, r, meetings, date, agenda) : ''}
      </div></div>` : ''}
    `).join('');
  }

  // The Matters Arising row is the one the Outstanding Matters register feeds.
  const MATTERS_ROW = /matters\s+arising/i;

  // Everything the Session is still carrying, turned into sub-items of Matters
  // Arising — the whole point of keeping the register.
  //
  // ONE SUB-ITEM PER HEADING, not per matter. The register holds the detail —
  // the second legal counsel, the consultants' response — but several of those
  // sit under one agenda heading, "Update on Building Project". The agenda
  // carries the heading; dealing with it deals with everything beneath it.
  //
  // `groups` are the {heading, owner, matters} groups the API returns. An item
  // already on the agenda is left alone, so pressing this twice does not double
  // anything up.
  function fromRegister(row, groups) {
    row.subItems = Array.isArray(row.subItems) ? row.subItems : [];
    const have = new Set(row.subItems
      .map(s => String((s && s.item) || '').trim().toLowerCase()).filter(Boolean));
    let added = 0;
    (Array.isArray(groups) ? groups : []).forEach(g => {
      const heading = String((g && g.heading) || '').trim();
      if (!heading || have.has(heading.toLowerCase())) return;
      have.add(heading.toLowerCase());
      row.subItems.push({ item: heading, responsible: String((g && g.owner) || '').trim() });
      added += 1;
    });
    return added;
  }

  // "Someone else" opens a box to type into; nothing is saved until it is typed.
  function pick(sel, apply) {
    const other = sel.parentElement.querySelector('.respOther');
    if (sel.value === '__other__') {
      other.style.display = ''; other.value = ''; other.focus();
      return false;
    }
    other.style.display = 'none'; other.value = '';
    apply(sel.value);
    return true;
  }

  // ---- which minutes the Session is reviewing -------------------------------
  // The Review of minutes row names the sitting whose minutes are being taken.
  // The Clerk used to type it, and a typed date is a date that will not match:
  // the minutes page finds the sitting by looking for its date inside the
  // sub-item text, and "11/6/26" or "11 June" does not find it.
  //
  // So the row offers the meetings the app already holds, most recent first, and
  // the pick writes the sentence. Where more than one set is being reviewed the
  // dropdown stays put, so picking again adds another — one sub-item per set,
  // which is the form the minutes' review section reads.
  const REVIEW_ROW = /review\s+of\s+minutes/i;
  // How many sittings to offer. Ten is more than anyone reviews and makes the
  // list a chore to read; five reaches back far enough for a set that was
  // deferred a couple of meetings running.
  const REVIEW_CHOICES = 5;

  function ordinalDay(n) {
    const t = n % 100;
    if (t >= 11 && t <= 13) return `${n}th`;
    return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
  }
  // The congregation's own way of writing a date — "11th June 2026" — and the
  // form the minutes match on, so this must stay in step with ordinalDate in
  // utils/sessionMinutes.js.
  function ordinalDate(iso) {
    const d = new Date(String(iso || '') + 'T00:00:00');
    if (isNaN(d)) return String(iso || '');
    return `${ordinalDay(d.getDate())} ${d.toLocaleDateString('en-GB', { month: 'long' })} ${d.getFullYear()}`;
  }
  // The row is already "Review of minutes"; the sub-item names the sitting and
  // nothing more. Repeating the words underneath gives the Session two reviews
  // where it has one — a heading, and then a heading again — which is not how
  // the congregation writes it. Their own agenda reads:
  //
  //   4.  Review of Minutes
  //       a)  11th June 2026 Session Meeting
  //       b)  9th July 2026 Session Meeting
  function reviewLabel(iso, title) {
    const what = String(title || '').trim() || 'Session Meeting';
    return `${ordinalDate(iso)} ${what}`;
  }

  // The sittings worth offering: earlier than this meeting, most recent first,
  // and not already named on the row. `exceptDate` is tonight's own date — the
  // Session does not review the minutes of the meeting it is sitting in.
  // `agenda` is optional: when it is given, a sitting named ANYWHERE on the
  // agenda is out of the list, not just on this row. An agenda with two review
  // rows on it would otherwise offer the same sitting twice, and the Session
  // would be handed the same minutes to adopt in two places.
  function reviewChoices(row, meetings, exceptDate, agenda) {
    const rowsToScan = Array.isArray(agenda) && agenda.length
      ? agenda.filter(r => REVIEW_ROW.test((r && r.item) || ''))
      : [row];
    const named = rowsToScan.filter(Boolean).flatMap(r =>
      (Array.isArray(r.subItems) ? r.subItems : []).map(x => String((x && x.item) || '').toLowerCase()));
    const mine = String(exceptDate || '').trim();
    return (Array.isArray(meetings) ? meetings : [])
      .filter(m => m && m.date && m.date !== mine)
      .filter(m => !mine || m.date < mine)
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .filter(m => !named.some(t => t.includes(ordinalDate(m.date).toLowerCase()) || t.includes(String(m.date))))
      .slice(0, REVIEW_CHOICES);
  }

  // Adds one sitting to the row. Returns the sentence written, or '' when that
  // sitting is already named — so pressing it twice cannot double anything up.
  function addReview(row, iso, title, agenda) {
    if (!row || !iso) return '';
    row.subItems = Array.isArray(row.subItems) ? row.subItems : [];
    const want = ordinalDate(iso).toLowerCase();
    // Every review sub-item on the agenda, not only this row's, so a sitting
    // cannot be blocked in one place and offered again in another.
    const scan = Array.isArray(agenda) && agenda.length
      ? agenda.filter(r => REVIEW_ROW.test((r && r.item) || ''))
      : [row];
    const already = scan.filter(Boolean).some(r =>
      (Array.isArray(r.subItems) ? r.subItems : []).some(x => {
        const t = String((x && x.item) || '').toLowerCase();
        return t.includes(want) || t.includes(String(iso));
      }));
    if (already) return '';
    const label = reviewLabel(iso, title);
    // The Session Clerk takes the minutes through; the row already says so, and
    // repeating it on every sub-item clutters the agenda.
    row.subItems.push({ item: label, responsible: '' });
    return label;
  }

  // The dropdown itself. Empty when there is nothing left to offer, so the row
  // does not carry a control that cannot do anything.
  function reviewPicker(i, row, meetings, exceptDate, agenda) {
    const choices = reviewChoices(row, meetings, exceptDate, agenda);
    if (!choices.length) return '';
    const some = (row.subItems || []).length;
    return `<select onchange="agAddReview(${i}, this)" style="max-width:280px;">
      <option value="" selected>${some ? '+ another set of minutes…' : '+ minutes being reviewed…'}</option>
      ${choices.map(m => `<option value="${esc2(m.date)}">${esc2(ordinalDate(m.date))}${
        m.title && !/^session meeting$/i.test(m.title) ? ` · ${esc2(m.title)}` : ''}</option>`).join('')}
    </select>`;
  }

  // ---- choosing which headings come onto the agenda ------------------------
  // Taking the whole register every time is wrong: some of what the Session is
  // carrying is not for tonight. So the register is offered as a list to scroll
  // and tick. Each row is a HEADING, with the sub-notes it gathers shown
  // beneath it so the Clerk can see what dealing with it would cover, and what
  // is already on the agenda is shown as such and cannot be ticked twice.
  //
  // The panel builds its own overlay, so both agenda pages get it without
  // either of them growing markup for it.
  // The picker. Each register heading can be taken whole — one agenda line that
  // covers everything beneath it — or, since 21 Oct 2026 (the Clerk's request),
  // any matter beneath it can be taken as the line instead, when that is what
  // is actually before the Session tonight: "Outstanding payments from Session
  // members" rather than its heading "Second Mini Harvest Support". Within one
  // heading the two are either/or: ticking a matter unticks its heading, and
  // ticking the heading unticks its matters.
  // A matter taken on its own keeps its heading in front of it, so the agenda
  // and the minutes still say what subject it belongs to (the Clerk, 21 Oct
  // 2026): "Second Mini Harvest Support: Outstanding payments from Session
  // members". A subject that already starts with the heading is left as it is.
  function lineFor(heading, subject) {
    const h = String(heading || '').trim(), s = String(subject || '').trim();
    if (!h || !s) return s || h;
    return s.toLowerCase().startsWith(h.toLowerCase()) ? s : `${h}: ${s}`;
  }
  function pickFromRegister(row, groups) {
    return new Promise(resolve => {
      const norm = v => String(v || '').trim().toLowerCase();
      const already = new Set((Array.isArray(row.subItems) ? row.subItems : [])
        .map(x => norm(x && x.item)).filter(Boolean));
      const list = (Array.isArray(groups) ? groups : []).map(g => {
        const matters = (g.matters || []).map(m => ({ ...m, on: false,
          already: already.has(norm(m.subject)) || already.has(norm(lineFor(g.heading, m.subject))) }));
        // A matter can stand as its own line only when it says something the
        // heading does not.
        const own = matters.filter(m => norm(m.subject) && norm(m.subject) !== norm(g.heading));
        const anyAlready = matters.some(m => m.already);
        const headAlready = already.has(norm(g.heading));
        return { ...g, matters, pickable: own.length > 0, already: headAlready,
          on: !headAlready && !anyAlready };
      });

      const ov = document.createElement('div');
      ov.className = 'modal-overlay';
      ov.style.display = 'flex';
      ov.innerHTML = `
        <div class="modal" style="max-width:660px;">
          <h2 style="margin-bottom:4px;">Bring in from the register</h2>
          <p class="sub" style="margin:0 0 10px; font-size:12.5px;">
            Tick a <b>heading</b> to take it as one line covering everything beneath it, or tick
            a <b>matter beneath it</b> to use that as the line instead — for example the latest
            update on the subject.</p>
          <div style="display:flex; gap:8px; margin:0 0 8px;">
            <button type="button" class="btn btn-secondary btn-sm" data-all="1">Tick all headings</button>
            <button type="button" class="btn btn-secondary btn-sm" data-all="0">Untick all</button>
          </div>
          <div id="agPickList" style="max-height:50vh; overflow-y:auto; border-top:1px solid var(--line,#d5dae6);"></div>
          <p class="sub" id="agPickCount" style="margin:9px 0 0; font-size:12px;"></p>
          <div class="modal-actions" style="margin-top:12px;">
            <button type="button" class="btn btn-secondary" data-act="cancel">Cancel</button>
            <button type="button" class="btn btn-primary" data-act="add">Bring in</button>
          </div>
        </div>`;
      document.body.appendChild(ov);

      const listEl = ov.querySelector('#agPickList');
      const countEl = ov.querySelector('#agPickCount');
      const addBtn = ov.querySelector('[data-act="add"]');

      function draw() {
        listEl.innerHTML = list.map((g, i) => `
          <div style="padding:10px 2px; border-bottom:1px solid var(--line,#d5dae6);">
            <label style="display:flex; gap:9px; align-items:flex-start; ${g.already ? 'opacity:.55;' : 'cursor:pointer;'}">
              <input type="checkbox" data-i="${i}" style="width:auto; margin-top:3px;"
                ${g.on ? 'checked' : ''} ${g.already ? 'disabled' : ''}>
              <span style="flex:1; min-width:0;">
                <b style="font-size:13.5px;">${esc2(g.heading)}</b>
                ${g.already ? '<span class="st closed" style="margin-left:6px;">already on the agenda</span>' : ''}
                ${g.owner ? `<span class="sub" style="font-size:11.5px;"> · ${esc2(g.owner)}</span>` : ''}
                <span class="sub" style="display:block; font-size:11.5px; margin-top:2px;">
                  ${g.matters.length} matter${g.matters.length === 1 ? '' : 's'} beneath it${g.pickable ? ' — or tick one below to use it as the line' : ''}</span>
              </span>
            </label>
            ${g.matters.length ? `<div style="margin:5px 0 0 26px; padding-left:10px; border-left:2px solid var(--line,#d5dae6);">${g.matters.map((m, j) => {
              const own = norm(m.subject) && norm(m.subject) !== norm(g.heading);
              const who = m.owner && m.owner !== g.owner ? ` — ${esc2(m.owner)}` : '';
              return own && g.pickable
                ? `<label style="display:flex; gap:7px; align-items:flex-start; padding:2px 0; ${m.already ? 'opacity:.55;' : 'cursor:pointer;'}">
                     <input type="checkbox" data-g="${i}" data-m="${j}" style="width:auto; margin-top:2px;"
                       ${m.on ? 'checked' : ''} ${m.already ? 'disabled' : ''}>
                     <span class="sub" style="font-size:12.5px;">${esc2(m.subject)}${who}${m.already ? ' <span class="st closed">already on the agenda</span>' : ''}
                       ${m.on ? `<span style="display:block; font-size:11.5px; color:var(--primary,#1D3F94);">Agenda line: ${esc2(lineFor(g.heading, m.subject))}</span>` : ''}</span>
                   </label>`
                : `<span class="sub" style="display:block; font-size:12px; padding:2px 0;">· ${esc2(m.subject)}${who}</span>`;
            }).join('')}</div>` : ''}
          </div>`).join('');
        listEl.querySelectorAll('input[data-i]').forEach(cb => {
          cb.addEventListener('change', () => {
            const g = list[Number(cb.dataset.i)];
            g.on = cb.checked;
            if (g.on) g.matters.forEach(m => { m.on = false; });
            draw();
          });
        });
        listEl.querySelectorAll('input[data-g]').forEach(cb => {
          cb.addEventListener('change', () => {
            const g = list[Number(cb.dataset.g)];
            g.matters[Number(cb.dataset.m)].on = cb.checked;
            if (cb.checked) g.on = false;
            draw();
          });
        });
        sync();
      }
      // What goes onto the agenda: a whole heading, or each matter ticked under
      // it as a line of its own (shaped like a heading, so fromRegister and the
      // toast need nothing new).
      function chosen() {
        const out = [];
        list.forEach(g => {
          if (g.on && !g.already) { out.push({ heading: g.heading, owner: g.owner, matters: g.matters }); return; }
          g.matters.filter(m => m.on && !m.already).forEach(m => out.push({
            heading: lineFor(g.heading, m.subject), owner: m.owner || g.owner || '', matters: [m], parent: g.heading,
          }));
        });
        return out;
      }
      function sync() {
        const take = chosen();
        const under = take.reduce((n, g) => n + (g.matters || []).length, 0);
        countEl.textContent = take.length
          ? `${take.length} line${take.length === 1 ? '' : 's'} selected, covering ${under} matter${under === 1 ? '' : 's'}.`
          : 'Nothing selected.';
        addBtn.disabled = !take.length;
      }

      function close(result) { ov.remove(); resolve(result); }
      ov.querySelectorAll('[data-all]').forEach(b => b.addEventListener('click', () => {
        const on = b.dataset.all === '1';
        list.forEach(g => { if (!g.already) g.on = on; g.matters.forEach(m => { m.on = false; }); });
        draw();
      }));
      ov.querySelector('[data-act="cancel"]').addEventListener('click', () => close(null));
      addBtn.addEventListener('click', () => close(chosen()));
      // Clicking the backdrop is a cancel; clicking inside the panel is not.
      ov.addEventListener('mousedown', e => { if (e.target === ov) close(null); });
      draw();
    });
  }

  // ---- the devotion fills itself from the duty roster ----------------------
  // The meeting date decides the week, the week decides who is on duty. Only
  // ever written into an empty cell or the generic placeholder — a name the
  // Clerk typed is never overwritten. Returns true when something was filled.
  const DUTY_PLACEHOLDER = /^(presbyters?\s+on\s+duty|pod|on\s+duty)$/i;
  function autoFillDuty(agenda, onDuty, mayEdit) {
    if (!mayEdit || !onDuty || !onDuty.hasRoster || !(onDuty.names || []).length) return false;
    let changed = false;
    (agenda || []).forEach(r => {
      if (!/devotion/i.test(r.item || '')) return;
      const cur = String(r.responsible || '').trim();
      if (cur && !DUTY_PLACEHOLDER.test(cur)) return;      // the Clerk has named someone
      if (cur === onDuty.label) return;
      r.responsible = onDuty.label;
      changed = true;
    });
    return changed;
  }

  return { STANDARD, REPORTS, standardOrder, options, rows, pick, autoFillDuty, DUTY_PLACEHOLDER, STOCK,
    fromRegister, pickFromRegister, lineFor, MATTERS_ROW,
    REVIEW_ROW, REVIEW_CHOICES, ordinalDate, reviewLabel, reviewChoices, addReview };
})();
