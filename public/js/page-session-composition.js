// AOTC Track — Session Composition.
// The Session as a body: who sits on it, in what order the minutes list them,
// how to reach them, who has been co-opted, and how each has attended.
    let me, members = [], tally = { perMember: [], held: 0, threshold: 4 }, mayEdit = false;
    let offices = [];
    let editingId = null;

    const $ = id => document.getElementById(id);

    function statOf(id) { return (tally.perMember || []).find(t => t.memberId === id) || null; }

    async function load() {
      const d = await api('/minutes/composition');
      members = d.members || [];
      offices = d.offices || [];
      tally = d.tally || { perMember: [], held: 0, threshold: 4 };
      mayEdit = !!d.canEdit;
      render();
    }

    // ------------------------------------------------------------------ titles
    // How a person is addressed wherever the minutes or the agenda name them.
    // A list, not a single value: a minister may be both Reverend and Doctor,
    // and the congregation writes that as "Rev Martin Owusu Boamah (Dr)" — one
    // title in front, the other after in brackets. The app knows which goes
    // where, so the Clerk only has to tick them.
    const TITLE_DEFS = [
      { label: 'Very Rev', place: 'pre' }, { label: 'Rt Rev', place: 'pre' }, { label: 'Rev', place: 'pre' },
      { label: 'Catechist', place: 'pre' }, { label: 'Elder', place: 'pre' }, { label: 'Nana', place: 'pre' },
      { label: 'Nii', place: 'pre' }, { label: 'Naa', place: 'pre' }, { label: 'Prof', place: 'pre' },
      { label: 'Mr', place: 'pre' }, { label: 'Mrs', place: 'pre' }, { label: 'Ms', place: 'pre' },
      { label: 'Miss', place: 'pre' }, { label: 'Madam', place: 'pre' },
      { label: 'Dr', place: 'post' }, { label: 'Ing', place: 'post' }, { label: 'Esq', place: 'post' },
    ];
    const placeOf = t => (TITLE_DEFS.find(d => d.label.toLowerCase() === String(t).toLowerCase()) || { place: 'pre' }).place;
    const rankOf = t => { const i = TITLE_DEFS.findIndex(d => d.label.toLowerCase() === String(t).toLowerCase()); return i < 0 ? 999 : i; };
    function orderTitles(list) {
      return (list || []).map(t => String(t || '').trim()).filter(Boolean)
        .sort((a, b) => rankOf(a) - rankOf(b));
    }
    function assemble(titles, name) {
      const t = orderTitles(titles);
      const pre = t.filter(x => placeOf(x) === 'pre');
      const post = t.filter(x => placeOf(x) === 'post');
      return [...pre, name || ''].join(' ').trim() + (post.length ? ` (${post.join(', ')})` : '');
    }

    // The picker. Used both from the table and from the member form; when it is
    // opened for a member it saves straight away, and when it is opened from the
    // form it just hands the titles back.
    let tTarget = null;
    function openTitles(idOrNull, current, name, onDone) {
      tTarget = { id: idOrNull, name: name || '', onDone: onDone || null };
      const chosen = orderTitles(current);
      const box = (list) => list.map(d =>
        `<label><input type="checkbox" value="${d.label}" ${chosen.some(c => c.toLowerCase() === d.label.toLowerCase()) ? 'checked' : ''}> ${d.label}</label>`).join('');
      $('tPre').innerHTML = box(TITLE_DEFS.filter(d => d.place === 'pre'));
      $('tPost').innerHTML = box(TITLE_DEFS.filter(d => d.place === 'post'));
      $('tOther').value = chosen.filter(c => !TITLE_DEFS.some(d => d.label.toLowerCase() === c.toLowerCase())).join(', ');
      $('tWho').textContent = name || '';
      $('tOverlay').querySelectorAll('input').forEach(i => i.addEventListener('change', tPreview));
      tPreview();
      $('tOverlay').style.display = 'flex';
    }
    function openTitlesFor(id) {
      const m = members.find(x => x.id === id);
      if (m) openTitles(m.id, m.titles || [], m.name);
    }
    function tChosen() {
      const ticked = [...$('tOverlay').querySelectorAll('input[type=checkbox]:checked')].map(i => i.value);
      const extra = $('tOther').value.split(',').map(x => x.trim()).filter(Boolean);
      return orderTitles([...ticked, ...extra]);
    }
    // Two forms, because the minutes use two: the roster of a meeting brackets
    // the academic title, a sentence runs the titles together in front.
    function proseForm(titles, name) {
      const t = orderTitles(titles);
      return [...t, name || ''].join(' ').trim();
    }
    function tPreview() {
      const t = tChosen(), n = (tTarget && tTarget.name) || '';
      const listed = assemble(t, n) || '—';
      const prose = proseForm(t, n) || '—';
      $('tPreview').innerHTML = listed === prose
        ? esc(listed)
        : `${esc(listed)}<br><span class="sub">and in a sentence — ${esc(prose)}</span>`;
    }
    // A changed title (Mrs \u2192 Madam): offer to carry it into everything
    // not yet signed. Signed minutes are left as they were approved.
    async function offerRetitle(id, oldTitles) {
      const m = members.find(x => String(x.id) === String(id));
      if (!m || !(oldTitles || []).length) return;
      try {
        const plan = await api('/minutes/roster/' + id + '/retitle', { method: 'POST', body: { from: oldTitles } });
        if (!plan.count && !plan.shortForm) return;
        const where = plan.places.map(p => `\u2022 ${p.where} (${p.n})`).join('\n');
        const ok = await confirmDialog(
          `${plan.name} is still named the old way in ${plan.count} place${plan.count === 1 ? '' : 's'} not yet signed:\n\n${where}`
          + (plan.shortForm ? `\n\nShort form after the first mention becomes \u201c${plan.shortForm}\u201d.` : '')
          + (plan.signedLeftAlone ? `\n\nSigned minutes stay exactly as they were approved.` : ''),
          { title: 'Change it there too?', okText: 'Change them all' });
        if (!ok) return;
        const r = await api('/minutes/roster/' + id + '/retitle', { method: 'POST', body: { from: oldTitles, apply: true } });
        toast(`Changed in ${r.count} place${r.count === 1 ? '' : 's'}.`);
      } catch (e) { toast(e.message, true); }
    }
    const preOf = list => orderTitles(list || []).join('|');
    $('tCancel').addEventListener('click', () => { $('tOverlay').style.display = 'none'; });
    $('tSave').addEventListener('click', async () => {
      const titles = tChosen();
      $('tOverlay').style.display = 'none';
      if (tTarget && tTarget.onDone) { tTarget.onDone(titles); return; }
      if (!tTarget || !tTarget.id) return;
      const was = (members.find(x => String(x.id) === String(tTarget.id)) || {}).titles || [];
      try {
        await api('/minutes/roster/' + tTarget.id, { method: 'PUT', body: { titles } });
        await load();
        if (preOf(was) !== preOf(titles)) await offerRetitle(tTarget.id, was);
      }
      catch (e) { toast(e.message, true); load(); }
    });

    function renderTitleGap() {
      const missing = members.filter(m => m.active !== false && m.needsTitle);
      $('titleGap').innerHTML = missing.length
        ? `<div class="card" style="border-left:4px solid #B7791F; margin-bottom:14px;">
             <b>${missing.length} member${missing.length === 1 ? ' has' : 's have'} no title recorded</b>
             <p class="sub" style="margin:4px 0 0;">
               ${missing.map(m => esc(m.name)).join(', ')} —
               the minutes will use the bare name until a title is set. Click the Title cell below.
             </p>
           </div>`
        : '';

      // Names still carrying their titles inside them. Offering to lift them out
      // gives one rule for everybody and makes the title editable.
      const inName = members.filter(m => m.titleSplit && !(m.titles || []).length);
      $('splitNote').innerHTML = inName.length && mayEdit
        ? `<div class="card" style="border-left:4px solid #1D3F94; margin-bottom:14px;">
             <b>${inName.length} name${inName.length === 1 ? '' : 's'} still carry their titles inside the name</b>
             <p class="sub" style="margin:4px 0 8px;">
               ${inName.map(m => `${esc(m.name)} → <b>${esc(m.titleSplit.to || m.titleSplit.base)}</b> + ${esc((m.titleSplit.titles || []).join(', '))}`).join('<br>')}
             </p>
             <p class="sub" style="margin:0 0 8px;">
               Moving them out changes nothing in the documents — each one is only moved if putting it back
               together reproduces the name exactly — but it means the title can be changed without retyping the name.
             </p>
             <button class="btn btn-secondary btn-sm" id="splitBtn">Move them into the Title column</button>
           </div>`
        : '';
      const b = $('splitBtn');
      if (b) b.addEventListener('click', async () => {
        try {
          const r = await api('/minutes/roster/titles/split', { method: 'POST' });
          toast(r.moved
            ? `${r.moved} name${r.moved === 1 ? '' : 's'} tidied. Nothing printed has changed.`
            : 'Nothing could be moved safely.');
          if ((r.skipped || []).length) {
            toast(`${r.skipped.length} left alone — the split would not reproduce the name exactly.`, true);
          }
          load();
        } catch (e) { toast(e.message, true); }
      });
    }

    // ---------------------------------------------------------------- offices
    // Worked from the office rather than from the person: the question a Clerk
    // actually asks is "who is the Senior Presbyter?", not "what is this member?".
    function memberOptions(selectedId) {
      return '<option value="">— vacant —</option>' + members
        .filter(m => m.active !== false)
        .map(m => `<option value="${m.id}"${Number(selectedId) === m.id ? ' selected' : ''}>`
          + `${esc(m.displayName || m.name)}${m.position && m.position !== 'Member' ? ' · ' + esc(m.position) : ''}</option>`).join('');
    }
    function renderOffices() {
      $('officeRows').innerHTML = offices.map(o => {
        const held = o.holders || [];
        // A Catechist office can be held by more than one person, so it lists
        // the holders and offers one empty picker to add another.
        const pickers = o.unique
          ? `<select data-office="${o.key}" data-was="${held[0] ? held[0].id : ''}" ${mayEdit ? '' : 'disabled'}>
               ${memberOptions(held[0] ? held[0].id : '')}</select>`
          : held.map(h => `<select data-office="${o.key}" data-was="${h.id}" ${mayEdit ? '' : 'disabled'}>
                 ${memberOptions(h.id)}</select>`).join(' ')
            + ` <select data-office="${o.key}" data-was="" ${mayEdit ? '' : 'disabled'}>${memberOptions('')}</select>`;
        return `
          <tr>
            <td style="white-space:nowrap; vertical-align:top; padding-right:14px;">
              <b>${esc(o.label)}</b>${o.constitutional ? '' : '<span class="byarr">by arrangement</span>'}
              <div class="sub" style="font-size:11px;">
                <span class="kind ${o.kind}">${o.kind}</span>
                ${o.note ? ' · ' + esc(o.note) : ''}
              </div>
            </td>
            <td style="vertical-align:top;">
              ${pickers}
              ${!held.length ? '<div class="sub vacant" style="font-size:11.5px; margin-top:3px;">Nobody recorded in this office.</div>' : ''}
            </td>
          </tr>`;
      }).join('');

      $('officeRows').querySelectorAll('select[data-office]').forEach(sel => {
        sel.addEventListener('change', () => setOffice(sel.dataset.office, sel.dataset.was, sel.value));
      });
    }
    // Conferring a unique office takes it off whoever held it — the SERVER does
// that, in one request, which matters now that offices keep dated terms: two
// requests would close the outgoing term today and open the new one on the
// induction date, leaving a gap or an overlap between them.
async function setOffice(officeKey, wasId, nowId) {
  const office = offices.find(o => o.key === officeKey);
  const was = members.find(m => String(m.id) === String(wasId));
  const now = members.find(m => String(m.id) === String(nowId));

  // A unique office is a succession, and the record has to say when it
  // happened — an induction is rarely typed up the same evening.
  let officeFrom = '';
  if (office && office.unique && (nowId || wasId)) {
    const what = nowId
      ? `${now ? now.name : 'The new holder'} becomes ${office.label}`
      : `${office.label} falls vacant`;
    const ans = await formDialog('Date of the change', [{
      name: 'from', label: `${what} on`, type: 'date', value: todayInputValue(),
    }], { okText: 'Record' });
    if (!ans) { load(); return; }              // cancelled — put the picker back
    officeFrom = ans.from || todayInputValue();
  }

  try {
    if (nowId) {
      // One request. The server releases the previous holder and closes his
      // term on the same date this one opens.
      const r = await api('/minutes/roster/' + nowId, { method: 'PUT', body: { office: officeKey, officeFrom } });
      const from = r.term && r.term.from;
      toast(r.released
        ? `${r.name} is now ${office.label}${from ? ' from ' + fmtDate(from) : ''} — ${r.released} released from it.`
        : `${r.name} recorded as ${office.label}${from ? ' from ' + fmtDate(from) : ''}.`);
      // Non-unique offices (Catechist) have no single outgoing holder, so the
      // server does not release anyone; do it here.
      if (office && !office.unique && wasId && String(wasId) !== String(nowId)) {
        await api('/minutes/roster/' + wasId, { method: 'PUT', body: { office: '' } });
      }
      // A Session Clerk who loses the office stays a presbyter. A minister who
      // has been transferred has left the congregation altogether — and while
      // he is still marked active he keeps appearing in the roll call. Ask,
      // rather than guess, and never for the person's own record.
      if (r.released && was && office && office.kind === 'agent') await askIfLeft(was, officeFrom);
    } else if (wasId) {
      await api('/minutes/roster/' + wasId, { method: 'PUT', body: { office: '', officeFrom } });
      toast(`${office.label} left vacant${officeFrom ? ' from ' + fmtDate(officeFrom) : ''}.`);
    }
    load();
  } catch (e) { toast(e.message, true); load(); }
}

// A minister who has been transferred has left the congregation altogether.
// While he is still on the roster he keeps appearing in every new roll call.
// Asked on BOTH routes into an office — the office picker and the Add/Edit
// member form — because the form used to skip it.
async function askIfLeft(was, on) {
  const go = await confirmDialog(
    `${was.name} no longer holds an office. Has he left the congregation?\n\n` +
    `If so he is taken off the Session from ${on ? fmtDate(on) : 'today'}: he stops appearing in the roll for meetings from that day, ` +
    `and stays in the attendance of every meeting before it. Everything he signed keeps his name.`,
    { title: 'Take him off the Session?', okText: 'Yes, take him off', cancelText: 'No, he stays' });
  if (go) await api('/minutes/roster/' + was.id, { method: 'PUT', body: { active: false, leftOn: on || todayInputValue() } });
  return go;
}

// ---- Who held an office, and when ------------------------------------------
// The signature on a set of minutes or a quarterly report is whoever held the
// office on the date that document is about, so the history is worth seeing.
async function renderOfficeHistory() {
  const box = $('officeHistory');
  let d;
  try { d = await api('/minutes/offices/terms'); }
  catch (e) { box.innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }

  const label = k => (d.offices.find(o => o.key === k) || {}).label || k;
  const byOffice = {};
  (d.terms || []).forEach(t => { (byOffice[t.officeKey] = byOffice[t.officeKey] || []).push(t); });
  const keys = Object.keys(byOffice);

  box.innerHTML = keys.length
    ? keys.map(k => `
        <div style="margin-bottom:12px;">
          <b style="font-size:12.5px;">${esc(label(k))}</b>
          <table style="width:100%; margin-top:3px;"><tbody>
            ${byOffice[k].map(t => `<tr>
              <td style="padding:2px 10px 2px 0;">${esc(t.name)}</td>
              <td class="sub" style="white-space:nowrap; font-size:11.5px; text-align:right;">
                ${t.from ? esc(fmtDate(t.from)) : 'before these records'} &ndash;
                ${t.to ? esc(fmtDate(t.to)) : '<b>present</b>'}
              </td></tr>`).join('')}
          </tbody></table>
        </div>`).join('')
    : `<p class="sub" style="font-size:11.5px;">Nothing recorded yet. <b>Record current holders</b> notes who holds
       each office now, so every set of minutes and every quarterly report already in the system keeps the name
       that really signed it. Do that <b>before</b> recording a change of office.</p>`;
}

// Back-fill: note who holds each office NOW, open-ended, so existing documents
// resolve to the people who really signed them. Must be done BEFORE a handover
// is recorded, or the new holder is back-dated over his predecessor.
async function seedOfficeTerms() {
  const go = await confirmDialog(
    'This notes who holds each office today, with no start date \u2014 meaning "since before these records began".\n\n' +
    'Every set of minutes and every quarterly report already in the system will then keep the name of the person who really signed it.\n\n' +
    'Do this BEFORE recording a change of office.',
    { title: 'Record the current office holders', okText: 'Record them' });
  if (!go) return;
  try {
    const r = await api('/minutes/offices/seed', { method: 'POST' });
    toast(r.created.length
      ? `Recorded the current holder of ${r.created.length} office${r.created.length === 1 ? '' : 's'}.`
      : 'Every office already has its history recorded.');
    $('officeHistory').style.display = '';
    renderOfficeHistory();
  } catch (e) { toast(e.message, true); }
}

function render() {
      const active = members.filter(m => m.active !== false);
      $('sCount').textContent = active.length;
      $('sAgents').textContent = active.filter(m => m.memberKind === 'agent').length;
      $('sCoOpted').textContent = active.filter(m => m.coOpted).length;
      $('sHeld').textContent = tally.held || 0;
      $('sPhones').textContent = active.filter(m => (m.phone || '').trim()).length;
      $('sFlagged').textContent = (tally.flagged || []).length;

      // A co-option whose term has run out is raised for a decision, never
      // acted on automatically.
      const expired = members.filter(m => m.coOptionExpired);
      $('expiredNote').innerHTML = expired.length
        ? `<div class="card" style="border-left:4px solid #B7791F; margin-bottom:14px;">
             <b>Co-option term ended</b>
             <p class="sub" style="margin:4px 0 0;">${expired.map(m => esc(m.name)).join(', ')} —
             the term recorded for ${expired.length === 1 ? 'this co-option has' : 'these co-options have'} passed.
             Nothing has been changed; edit the member to extend or end it.</p>
           </div>`
        : '';

      $('rows').innerHTML = members.length ? members.map((m, i) => {
        const t = statOf(m.id);
        const pct = t && t.pct !== null ? t.pct : null;
        const att = t && t.held
          ? `<div style="display:flex;align-items:center;gap:8px;">
               <div class="bar" title="${t.present} of ${t.held} meetings"><span style="width:${pct}%;"></span></div>
               <span class="sub" style="font-size:11.5px;white-space:nowrap;">${t.present}/${t.held}${pct !== null ? ` · ${pct}%` : ''}</span>
               ${t.flag ? `<span class="flag ${t.flag}" title="${t.flag === 'red'
                   ? `${t.consecutiveAbsences} consecutive absences without apology`
                   : 'attendance under half'}">${t.flag === 'red' ? 'follow up' : 'low'}</span>` : ''}
             </div>`
          : '<span class="sub" style="font-size:11.5px;">—</span>';
        return `
        <tr${m.active === false ? ' style="opacity:.5;"' : ''}>
          <td class="mono">${i + 1}</td>
          <td>
            <button class="tbtn ${(m.titles || []).length ? '' : 'none'}" onclick="openTitlesFor(${m.id})"
                    ${mayEdit ? '' : 'disabled'}
                    title="${(m.titles || []).length ? 'Change how this person is addressed' : 'Set how this person is addressed'}">
              ${(m.titles || []).length ? esc((m.titles || []).join(', '))
                : (m.needsTitle ? '— set —' : 'in the name')}
            </button>
          </td>
          <td>
            <b>${esc(m.name)}</b>${m.coOpted ? '<span class="co-badge">Co-opted</span>' : ''}
            ${(m.titles || []).length && m.displayName !== m.name
                ? `<div class="sub" style="font-size:11px;">lists as ${esc(m.displayName)}`
                  + (m.proseName && m.proseName !== m.displayName ? ` · in a sentence, ${esc(m.proseName)}` : '')
                  + '</div>'
                : ''}
            ${m.shortForm ? `<div class="sub" style="font-size:11px;">after first mention, ${esc(m.shortForm)}${m.shortFormSource === 'learned' ? ' <i>(learned from your corrections)</i>' : ''}</div>` : ''}
            ${m.coOptionNote ? `<div class="sub" style="font-size:11px;">${esc(m.coOptionNote)}</div>` : ''}
            ${m.email ? `<div class="sub" style="font-size:11px;">${esc(m.email)}</div>` : ''}
          </td>
          <td>${esc(m.officeLabel || m.position || 'Member')}</td>
          <td><span class="kind ${m.memberKind || 'presbyter'}">${esc(m.memberKind || 'presbyter')}</span></td>
          <td class="mono">${esc(m.phone) || '<span class="sub">— none —</span>'}</td>
          <td>${att}</td>
          <td style="text-align:right; white-space:nowrap;">
            ${mayEdit ? `
              <button class="btn btn-secondary btn-sm" onclick="move(${m.id},-1)" title="Move up">↑</button>
              <button class="btn btn-secondary btn-sm" onclick="move(${m.id},1)" title="Move down">↓</button>
              <button class="btn btn-secondary btn-sm" onclick="edit(${m.id})">Edit</button>
              <button class="btn btn-danger btn-sm" onclick="del(${m.id})">Take off the Session</button>` : ''}
          </td>
        </tr>`;
      }).join('')
        : '<tr><td colspan="8" class="sub">No one on the Session yet — press “Set up Session roster” to create it.</td></tr>';
      renderOffices();
      renderTitleGap();

      $('tallyNote').textContent = tally.held
        ? `Attendance is counted across ${tally.held} recorded Session meeting${tally.held === 1 ? '' : 's'}. `
          + `“Follow up” appears after ${tally.threshold} consecutive absences without apology.`
        : 'Attendance appears here once meetings have been held and the roll taken.';
    }

    async function move(id, dir) {
      const i = members.findIndex(m => m.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= members.length) return;
      const a = members[i], b = members[j];
      await api('/minutes/roster/reorder', { method: 'POST', body: { order: [{ id: a.id, rank: b.rank }, { id: b.id, rank: a.rank }] } });
      load();
    }

    // Taking someone off the Session keeps his record: deleting it would take
    // him out of the attendance of every meeting he sat in. He is marked as
    // having left on a date, and only meetings from that date leave him out.
    async function del(id) {
      const m = members.find(x => x.id === id);
      const ans = await formDialog(`Take ${m ? m.name : 'this member'} off the Session`, [{
        name: 'on', label: 'Left the Session on', type: 'date', value: todayInputValue(),
      }], { okText: 'Take off the Session' });
      if (!ans) return;
      try { await api('/minutes/roster/' + id, { method: 'PUT', body: { active: false, leftOn: ans.on || todayInputValue() } }); load(); }
      catch (e) { toast(e.message, true); }
    }

    function openForm(m, asCoOption) {
      editingId = m ? m.id : null;
      $('memTitle').textContent = m ? 'Edit member' : (asCoOption ? 'Co-opt onto the Session' : 'Add member');
      $('memForm').reset();
      $('mOfficeFrom').value = '';
      $('mName').value = m ? m.name : '';
      formTitles = m ? orderTitles(m.titles || []) : [];
      renderFormTitles();
      $('mOffice').innerHTML = '<option value="">No office — an ordinary member of the Session</option>'
        + offices.map(o => `<option value="${o.key}"${m && m.office === o.key ? ' selected' : ''}>`
          + `${esc(o.label)}${o.constitutional ? '' : ' (by arrangement)'}</option>`).join('');
      $('mKind').value = m ? (m.kind || '') : '';
      officeNote();
      $('mPosition').value = m ? (m.position || '') : '';
      $('mPhone').value = m ? (m.phone || '') : '';
      $('mEmail').value = m ? (m.email || '') : '';
      $('mShort').value = m ? (m.shortForm || '') : '';
      $('mShort').placeholder = m && m.name ? `Leave blank for title + surname, e.g. ${defaultShort(m)}` : 'Leave blank for title + surname';
      $('mRank').value = m ? (m.rank || '') : '';
      const co = m ? !!m.coOpted : !!asCoOption;
      $('mCoOpted').checked = co;
      $('mCoOptedOn').value = m ? (m.coOptedOn || '') : new Date().toISOString().slice(0, 10);
      $('mCoOptedUntil').value = m ? (m.coOptedUntil || '') : '';
      $('mCoOptedFor').value = m ? (m.coOptedFor || '') : '';
      $('coFields').style.display = co ? '' : 'none';
      syncOfficeFrom();
      $('memOverlay').style.display = 'flex';
    }
    // The default short form the tidy-up uses: titles + surname.
    function defaultShort(m) {
      const parts = String(m.name || '').replace(/\(.*?\)/g, ' ').trim().split(/\s+/);
      const sur = parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
      return [...orderTitles(m.titles || []), sur].join(' ');
    }
    function edit(id) { openForm(members.find(m => m.id === id), false); }

    let formTitles = [];
    function renderFormTitles() {
      $('mTitleBtn').textContent = formTitles.length ? formTitles.join(', ') : 'Choose…';
    }
    $('mTitleBtn').addEventListener('click', () => {
      openTitles(null, formTitles, $('mName').value, t => { formTitles = t; renderFormTitles(); });
    });

    // The office decides the standing, so the standing picker only matters for
    // someone who holds none.
    function officeNote() {
      const o = offices.find(x => x.key === $('mOffice').value);
      $('mOfficeNote').textContent = o
        ? `${o.kind === 'agent' ? 'An agent — may chair and constitute the Session.' : 'A presbyter.'}`
          + `${o.constitutional ? '' : ' Not a constitutional office.'}${o.note ? ' ' + o.note + '.' : ''}`
        : '';
      $('mKindField').style.display = o ? 'none' : '';
      if (o) $('mKind').value = o.kind === 'agent' ? 'agent' : '';
    }
    $('mOffice').addEventListener('change', () => {
      const o = offices.find(x => x.key === $('mOffice').value);
      const cur = $('mPosition').value.trim();
      const wasAnOfficeLabel = offices.some(x => x.label === cur);
      if (o && (!cur || wasAnOfficeLabel)) $('mPosition').value = o.label;
      else if (!o && wasAnOfficeLabel) $('mPosition').value = 'Member';
      officeNote();
    });
    // Only a unique office that someone already holds is a succession; taking a
    // vacant office, or one of several Catechist seats, needs no date.
    function syncOfficeFrom() {
      const o = offices.find(x => x.key === $('mOffice').value);
      const held = !!(o && o.unique && (o.holders || []).length);
      $('mOfficeFromField').style.display = held ? '' : 'none';
      if (held && !$('mOfficeFrom').value) $('mOfficeFrom').value = todayInputValue();
    }
    $('mOffice').addEventListener('change', syncOfficeFrom);
    $('mCoOpted').addEventListener('change', e => { $('coFields').style.display = e.target.checked ? '' : 'none'; });
    $('addBtn').addEventListener('click', () => openForm(null, false));
    $('coOptBtn').addEventListener('click', () => openForm(null, true));
    $('memCancel').addEventListener('click', () => { $('memOverlay').style.display = 'none'; });

    $('memForm').addEventListener('submit', async e => {
      e.preventDefault();
      const body = {
        name: $('mName').value,
        titles: formTitles,
        office: $('mOffice').value,
        kind: $('mKind').value,
        position: $('mPosition').value || 'Member',
        phone: $('mPhone').value,
        email: $('mEmail').value,
        shortForm: $('mShort').value.trim(),
        officeFrom: $('mOfficeFromField').style.display === 'none' ? '' : $('mOfficeFrom').value,
        coOpted: $('mCoOpted').checked,
        coOptedOn: $('mCoOpted').checked ? $('mCoOptedOn').value : '',
        coOptedUntil: $('mCoOpted').checked ? $('mCoOptedUntil').value : '',
        coOptedFor: $('mCoOpted').checked ? $('mCoOptedFor').value : '',
      };
      if ($('mRank').value) body.rank = Number($('mRank').value);
      try {
        const before = members.slice();
        const r = editingId
          ? await api('/minutes/roster/' + editingId, { method: 'PUT', body })
          : await api('/minutes/roster', { method: 'POST', body });
        $('memOverlay').style.display = 'none';
        const office = offices.find(o => o.key === body.office);
        const was = r && r.released ? before.find(m => m.name === r.released && String(m.id) !== String(r.id)) : null;
        if (was && office && office.kind === 'agent') await askIfLeft(was, body.officeFrom);
        const old = editingId ? ((before.find(m => String(m.id) === String(editingId)) || {}).titles || []) : [];
        const savedId = editingId;
        await load();
        if (savedId && preOf(old) !== preOf(body.titles)) await offerRetitle(savedId, old);
      } catch (err) { toast(err.message, true); }
    });

    $('officeSeedBtn').addEventListener('click', seedOfficeTerms);
    $('officeHistBtn').addEventListener('click', () => {
      const box = $('officeHistory'), open = box.style.display !== 'none';
      box.style.display = open ? 'none' : '';
      $('officeHistBtn').textContent = open ? 'Show history' : 'Hide history';
      if (!open) renderOfficeHistory();
    });

    $('seedBtn').addEventListener('click', async () => {
      try {
        await api('/minutes/roster/seed', { method: 'POST' });
        load();
        toast('Session roster created — check the names, then add phone numbers.');
      } catch (e) { toast(e.message, true); }
    });

    (async () => {
      me = await requireAuthAndRenderShell('/session-composition.html');
      if (!me) return;
      load();
    })();
