// AOTC Track — a committee or group executive meeting, from roll to minutes.
//
// Four tabs, like the Session's minutes: the Roll (ticked as members arrive,
// then confirmed), the Agenda, the Minutes, and the Documents. Minutes can be
// written from the moment the meeting is opened — they do not wait for the
// attendance to be recorded. There is no AI tidy-up here; what is typed is
// what prints.
    let me, mtg = null, mdoc = null, prevMtg = null, roster = [], roll = null, attInfo = null, procs = {};
    let mayEdit = false, mayRecord = false, mayUnlock = false;
    const $ = id => document.getElementById(id);
    const SECTIONS = [
      { key: 'matters', title: 'Matters Arising', add: '+ Add a matter arising', hint: 'Open action points from earlier meetings are brought in here to start with.' },
      { key: 'main', title: 'Main Business', add: '+ Add an item', hint: 'Started from the agenda.' },
      { key: 'other', title: 'Other Matters', add: '+ Add another matter', hint: 'Anything raised that was not on the agenda.' },
    ];
    const BOIL = /(opening|prayer|welcome|constitut|previous minutes|review of minutes|confirmation of minutes|matters arising|any other business|a\.?\s*o\.?\s*b|other matters|closing|closure|adjourn|benediction)/i;
    function mmId() { return Number(new URLSearchParams(location.search).get('meeting')) || 0; }
    function ord(iso) {
      if (!iso) return '';
      const d = toLocalDate(iso), n = d.getDate();
      const suf = (n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
      return `${n}${suf} ${d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`;
    }
    function stopText(v) { const t = String(v || '').trim(); return !t ? '' : /[.!?]$/.test(t) ? t : t + '.'; }
    function editable() { return mayEdit && mdoc && mdoc.status !== 'final'; }
    function rollEditable() { return editable() && roll && !roll.locked; }
    function nameById(id) { const m = roster.find(x => Number(x.id) === Number(id)); return m ? m.name : ''; }
    function presentNames() { return roll.presentIds.map(nameById).filter(Boolean); }

    document.querySelectorAll('.mtab').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.mtab').forEach(x => x.classList.toggle('active', x === b));
      document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + b.dataset.pane));
    }));

    // ---- saving --------------------------------------------------------------------
    let saveTimer = null;
    function queueSave() {
      if (!editable()) return;
      $('saveNote').textContent = 'Saving…';
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, 700);
    }
    async function saveNow() {
      clearTimeout(saveTimer); saveTimer = null;
      if (!editable()) return;
      const body = {
        openingNote: mdoc.openingNote, closingNote: mdoc.closingNote, previousDate: mdoc.previousDate,
        corrections: mdoc.corrections, matters: mdoc.matters, main: mdoc.main, other: mdoc.other,
        proceedings: mdoc.proceedings || {},
      };
      if (roll && roll.source === 'draft') body.roll = roll;
      try { await api(`/meetings/${mtg.id}/write`, { method: 'PUT', body }); $('saveNote').textContent = 'Saved'; }
      catch (e) { $('saveNote').textContent = ''; toast(e.message, true); }
    }

    // ---- ROLL ------------------------------------------------------------------------
    function stateOf(id) {
      id = Number(id);
      if (roll.presentIds.includes(id)) return roll.onlineIds.includes(id) ? 'online' : 'present';
      if (roll.apologyIds.includes(id)) return 'apology';
      return 'absent';
    }
    function setRoll(id, st) {
      if (!rollEditable()) return;
      id = Number(id);
      const drop = a => a.filter(x => x !== id);
      roll.presentIds = drop(roll.presentIds); roll.onlineIds = drop(roll.onlineIds); roll.apologyIds = drop(roll.apologyIds);
      if (st === 'present' || st === 'online') roll.presentIds.push(id);
      if (st === 'online') roll.onlineIds.push(id);
      if (st === 'apology') roll.apologyIds.push(id);
      renderRoll(); renderMinutes(); queueSave();
    }
    function allPresent() { if (!rollEditable()) return; roll.presentIds = roster.map(m => Number(m.id)); roll.apologyIds = []; renderRoll(); renderMinutes(); queueSave(); }
    function addGuest(kind) {
      const el = $(kind === 'apology' ? 'gApo' : 'gPre');
      const n = el.value.trim(); if (!n) return;
      (kind === 'apology' ? roll.guestsApology : roll.guestsPresent).push(n);
      el.value = ''; renderRoll(); queueSave();
    }
    function dropGuest(kind, i) { (kind === 'apology' ? roll.guestsApology : roll.guestsPresent).splice(i, 1); renderRoll(); queueSave(); }
    function renderRoll() {
      const box = $('rollBox');
      const p = roll.presentIds.length, a = roll.apologyIds.length, ab = roster.length - p - a;
      const locked = roll.locked;
      const dis = rollEditable() ? '' : 'disabled';
      let h = `<div class="counts card"><div><b>${p}</b><span class="sub">Present</span></div><div><b>${a}</b><span class="sub">Apologies</span></div><div><b>${Math.max(0, ab)}</b><span class="sub">Absent</span></div>
        <div><b>${roll.guestsPresent.length}</b><span class="sub">Guests</span></div></div>`;
      if (locked) {
        h += `<div class="final-note">Attendance recorded and locked${attInfo.recordedBy ? ' by ' + esc(attInfo.recordedBy) : ''}. It is the record now${mayUnlock ? '' : ' — only an administrator can unlock it'}.
          ${mayUnlock ? ' <button class="btn btn-secondary btn-sm" onclick="unlockRoll()">Unlock to correct</button>' : ''}</div>`;
      } else if (rollEditable()) {
        h += `<p class="sub" style="margin:0 0 8px;">Tick members as they arrive — it saves as you go. When the meeting is over, confirm it: that records the attendance, locks it, and counts it in everyone's attendance record.</p>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px;"><button class="btn btn-secondary btn-sm" onclick="allPresent()">Everyone present</button>
          ${mayRecord ? '<button class="btn btn-primary btn-sm" onclick="confirmRoll()">Confirm and lock attendance</button>' : ''}</div>`;
      }
      h += `<div class="card">${roster.length ? roster.map(m => {
        const st = stateOf(m.id);
        return `<div class="roll-row"><div class="who"><b>${esc(m.name)}</b><span>${esc(m.position || 'Member')}</span></div>
          <div class="seg">
            <button class="${st === 'present' ? 'on' : ''}" onclick="setRoll(${m.id},'present')" ${dis}>P</button>
            <button class="${st === 'online' ? 'on' : ''}" onclick="setRoll(${m.id},'online')" ${dis} title="Joined online">Online</button>
            <button class="${st === 'apology' ? 'on apo' : ''}" onclick="setRoll(${m.id},'apology')" ${dis}>Apol</button>
            <button class="${st === 'absent' ? 'on abs' : ''}" onclick="setRoll(${m.id},'absent')" ${dis}>Abs</button>
          </div></div>`;
      }).join('') : '<p class="sub">No members on this meeting’s roster yet — add them to the committee or group first.</p>'}</div>`;
      h += `<div class="card" style="margin-top:12px;"><b>Guests</b> <span class="sub" style="font-size:12px;">— people not on the roster</span>
        ${roll.guestsPresent.map((g, i) => `<div class="ag-row"><span style="flex:1;">${esc(g)} <span class="sub">present</span></span>${rollEditable() ? `<button class="btn btn-danger btn-sm" onclick="dropGuest('present',${i})">✕</button>` : ''}</div>`).join('')}
        ${roll.guestsApology.map((g, i) => `<div class="ag-row"><span style="flex:1;">${esc(g)} <span class="sub">apology</span></span>${rollEditable() ? `<button class="btn btn-danger btn-sm" onclick="dropGuest('apology',${i})">✕</button>` : ''}</div>`).join('')}
        ${rollEditable() ? `<div class="ag-row"><input type="text" id="gPre" placeholder="Guest present — name"><button class="btn btn-secondary btn-sm" onclick="addGuest('present')">Add</button></div>
          <div class="ag-row"><input type="text" id="gApo" placeholder="Guest with apologies — name"><button class="btn btn-secondary btn-sm" onclick="addGuest('apology')">Add</button></div>` : ''}
      </div>`;
      box.innerHTML = h;
    }
    async function confirmRoll() {
      if (!await confirmDialog(`Record this attendance — ${roll.presentIds.length} present, ${roll.apologyIds.length} with apologies — and lock it?`, { okText: 'Record and lock' })) return;
      await saveNow();
      const inPerson = roll.presentIds.filter(i => !roll.onlineIds.includes(i));
      try {
        await api(`/meetings/${mtg.id}/attendance`, { method: 'POST', body: {
          presentMemberIds: inPerson, onlinePresentMemberIds: roll.onlineIds, apologyMemberIds: roll.apologyIds,
          guestsPresent: roll.guestsPresent, guestsApology: roll.guestsApology, proceedings: currentProcs(),
        } });
        toast('Attendance recorded and locked.');
        await load();
      } catch (e) { toast(e.message, true); }
    }
    async function unlockRoll() {
      if (!await confirmDialog('Unlock this attendance so it can be corrected? Confirm it again afterwards.', { okText: 'Unlock' })) return;
      try { await api(`/meetings/${mtg.id}/unlock-attendance`, { method: 'POST' }); await load(); toast('Unlocked — correct the roll, then confirm it again.'); }
      catch (e) { toast(e.message, true); }
    }

    // ---- AGENDA ----------------------------------------------------------------------
    function agendaItems() {
      return String(mtg.agenda || '').split(/\r?\n/).map(x => x.replace(/^\s*\d+([.)]\d*)*[.)]?\s*/, '').replace(/^[-*•]\s*/, '').trim()).filter(Boolean);
    }
    let agendaDraft = null;
    function renderAgenda() {
      if (!agendaDraft) agendaDraft = agendaItems();
      const dis = editable() ? '' : 'disabled';
      $('agendaBox').innerHTML = `<div class="card">
        <p class="sub" style="margin-top:0;">One line per item. Items other than the standard ones (opening, review of minutes, matters arising, other matters, closure) become the Main Business of the minutes. Changes here are saved quietly — members are not sent a new notice.</p>
        ${agendaDraft.map((x, i) => `<div class="ag-row"><span class="sub" style="width:22px;">${i + 1}.</span>
          <input type="text" value="${esc(x)}" onchange="agSet(${i},this.value)" ${dis}>
          ${editable() ? `<button class="btn btn-secondary btn-sm" onclick="agMove(${i},-1)" ${i === 0 ? 'disabled' : ''}>▲</button><button class="btn btn-secondary btn-sm" onclick="agMove(${i},1)" ${i === agendaDraft.length - 1 ? 'disabled' : ''}>▼</button><button class="btn btn-danger btn-sm" onclick="agDrop(${i})">✕</button>` : ''}</div>`).join('')}
        ${editable() ? `<div class="ag-row"><input type="text" id="agNew" placeholder="Add an agenda item" onkeydown="if(event.key==='Enter'){agAdd();}"><button class="btn btn-secondary btn-sm" onclick="agAdd()">Add</button></div>` : ''}
        ${editable() && missingAgenda().length ? `<button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="pullAgenda()">Put ${missingAgenda().length} new item${missingAgenda().length === 1 ? '' : 's'} into Main Business</button>` : ''}
      </div>`;
    }
    let agTimer = null;
    function agSave() {
      clearTimeout(agTimer);
      agTimer = setTimeout(async () => {
        try { const r = await api(`/meetings/${mtg.id}/write/agenda`, { method: 'PUT', body: { items: agendaDraft } }); mtg.agenda = r.agenda; $('saveNote').textContent = 'Saved'; renderAgenda(); renderMinutes(); }
        catch (e) { toast(e.message, true); }
      }, 500);
    }
    function agSet(i, v) { agendaDraft[i] = v; agSave(); }
    function agAdd() { const el = $('agNew'); const v = el.value.trim(); if (!v) return; agendaDraft.push(v); renderAgenda(); agSave(); setTimeout(() => $('agNew') && $('agNew').focus(), 0); }
    function agDrop(i) { agendaDraft.splice(i, 1); renderAgenda(); agSave(); }
    function agMove(i, d) { const j = i + d; if (j < 0 || j >= agendaDraft.length) return; [agendaDraft[i], agendaDraft[j]] = [agendaDraft[j], agendaDraft[i]]; renderAgenda(); agSave(); }
    function missingAgenda() {
      const have = new Set((mdoc.main || []).map(r => (r.subject || '').trim().toLowerCase()));
      return agendaItems().filter(x => !BOIL.test(x)).filter(x => !have.has(x.toLowerCase()));
    }
    function pullAgenda() { missingAgenda().forEach(subject => mdoc.main.push({ subject, body: '', action: '' })); renderAgenda(); renderMinutes(); queueSave(); toast('Added to Main Business on the Minutes tab.'); }

    // ---- MINUTES ---------------------------------------------------------------------
    function currentProcs() {
      const out = { ...procs };
      Object.entries(mdoc.proceedings || {}).forEach(([k, v]) => { if (String(v || '').trim()) out[k] = String(v).trim(); });
      return out;
    }
    function setProc(k, v) { mdoc.proceedings = mdoc.proceedings || {}; mdoc.proceedings[k] = v; renderMinutes(); queueSave(); }
    function personPick(k, label) {
      const cur = currentProcs()[k] || '';
      const names = presentNames();
      const pool = names.length ? names : roster.map(m => m.name);
      const opts = ['<option value="">—</option>'].concat(pool.map(n => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`));
      if (cur && !pool.includes(cur)) opts.push(`<option selected>${esc(cur)}</option>`);
      return `<div><label>${label}</label><select onchange="setProc('${k}',this.value)" ${editable() ? '' : 'disabled'}>${opts.join('')}</select></div>`;
    }
    function timeField(k, label) {
      return `<div><label>${label}</label><input type="text" value="${esc(currentProcs()[k] || '')}" placeholder="e.g. 6:10 pm" onchange="setProc('${k}',this.value)" ${editable() ? '' : 'disabled'}></div>`;
    }
    function autoBox(text, missing) { return text ? `<p class="auto">${esc(text)}</p>` : `<p class="auto missing">${esc(missing)}</p>`; }
    function renderMinutes() {
      const dis = editable() ? '' : 'disabled';
      const p = currentProcs();
      let n = 0;
      const no = () => `${++n}.0`;
      const opening = [p.commencedAt ? `The meeting commenced at ${stopText(p.commencedAt)}` : '', p.openingBy ? `${p.openingBy} led the opening prayer.` : ''].filter(Boolean).join(' ');
      let h = `<div class="sec"><div class="sec-head"><span class="sec-no">${no()}</span><span class="sec-title">Opening</span></div>
        <div class="pfields">${timeField('commencedAt', 'Commenced at')}${personPick('openingBy', 'Opening prayer led by')}</div>
        ${autoBox(opening, 'Fill in the time and who led the opening prayer, and this sentence writes itself.')}
        <textarea rows="3" placeholder="Anything else in the opening — the devotion, a welcome…" onchange="setDoc('openingNote',this.value)" ${dis}>${esc(mdoc.openingNote || '')}</textarea></div>`;
      h += `<div class="sec"><div class="sec-head"><span class="sec-no">${(p.constitutedBy || p.constitutedAt) ? no() : '—'}</span><span class="sec-title">Constitution of the Meeting</span></div>
        <div class="pfields">${personPick('constitutedBy', 'Constituted by')}${timeField('constitutedAt', 'Constituted at')}</div>
        ${(p.constitutedBy || p.constitutedAt) ? autoBox(`${p.constitutedBy || 'The Chairperson'} duly constituted the meeting${p.constitutedAt ? ` at ${p.constitutedAt}` : ''} in the name of the Triune God.`, '') : '<p class="sub" style="font-size:12px;margin:0;">Leave empty if the meeting was not constituted — this item is then not printed.</p>'}</div>`;
      const fixed = (mdoc.corrections || []).some(c => (c.from || '').trim() || (c.to || '').trim());
      const adopt = p.minutesMovedBy ? `${p.minutesMovedBy} moved for the adoption of the minutes${fixed ? ' as corrected' : ''}${p.minutesSecondedBy ? `, and ${p.minutesSecondedBy} seconded the motion` : ''}.` : '';
      h += `<div class="sec"><div class="sec-head"><span class="sec-no">${no()}</span><span class="sec-title">Review of Minutes</span></div>
        <div class="field"><label>Minutes of the meeting held on</label>
          <input type="date" value="${esc(mdoc.previousDate || '')}" onchange="setDoc('previousDate',this.value)" ${dis} style="max-width:220px;">
          <p class="sub" style="margin:4px 0 0;font-size:11.5px;">${prevMtg ? `The last ${mtg.entityType === 'group' ? 'executive' : 'committee'} meeting in the app was on ${esc(ord(prevMtg.date))}.` : 'No earlier meeting of this body is in the app — enter the date by hand.'}</p></div>
        <label style="font-weight:600;font-size:13px;">Corrections</label>
        ${(mdoc.corrections || []).map((c, i) => `
          <div class="fix">
            <input type="text" value="${esc(c.from || '')}" placeholder="As written" onchange="setFix(${i},'from',this.value)" ${dis}>
            <span class="sub">amended to</span>
            <input type="text" value="${esc(c.to || '')}" placeholder="Corrected to" onchange="setFix(${i},'to',this.value)" ${dis}>
            ${editable() ? `<button class="btn btn-danger btn-sm" onclick="dropFix(${i})">✕</button>` : '<span></span>'}
          </div>`).join('') || '<p class="sub" style="margin:4px 0;">No corrections.</p>'}
        ${editable() ? '<button class="btn btn-secondary btn-sm" onclick="addFix()">+ Add a correction</button>' : ''}
        <div class="pfields" style="margin-top:10px;">${personPick('minutesMovedBy', 'Adoption moved by')}${personPick('minutesSecondedBy', 'Seconded by')}</div>
        ${autoBox(adopt, 'Choose who moved and seconded the adoption, and this sentence writes itself.')}</div>`;
      SECTIONS.forEach(S => {
        const list = mdoc[S.key] || [];
        h += `<div class="sec"><div class="sec-head"><span class="sec-no">${no()}</span><span class="sec-title">${S.title}</span></div>
          <p class="sub" style="margin:-4px 0 6px;font-size:11.5px;">${S.hint} Left empty, this section is not printed.</p>
          ${list.map((r, i) => `
            <div class="child">
              <div class="row-2">
                <input type="text" value="${esc(r.subject || '')}" placeholder="Heading" onchange="setRow('${S.key}',${i},'subject',this.value)" ${dis}>
                <input type="text" value="${esc(r.action || '')}" placeholder="Action (optional)" onchange="setRow('${S.key}',${i},'action',this.value)" ${dis}>
              </div>
              <textarea rows="4" placeholder="What was said or decided…" onchange="setRow('${S.key}',${i},'body',this.value)" ${dis}>${esc(r.body || '')}</textarea>
              ${motionsBlock(S.key, i, r)}
              ${editable() ? `<div class="tools">
                <button class="btn btn-secondary btn-sm" onclick="moveRow('${S.key}',${i},-1)" ${i === 0 ? 'disabled' : ''}>▲</button>
                <button class="btn btn-secondary btn-sm" onclick="moveRow('${S.key}',${i},1)" ${i === list.length - 1 ? 'disabled' : ''}>▼</button>
                <button class="btn btn-danger btn-sm" onclick="dropRow('${S.key}',${i})">Remove</button></div>` : ''}
            </div>`).join('')}
          ${editable() ? `<button class="btn btn-secondary btn-sm" onclick="addRow('${S.key}')">${S.add}</button>` : ''}
          ${editable() && S.key === 'main' && missingAgenda().length ? ` <button class="btn btn-secondary btn-sm" onclick="pullAgenda()">Bring in ${missingAgenda().length} agenda item${missingAgenda().length === 1 ? '' : 's'} not here yet</button>` : ''}
        </div>`;
      });
      const closure = p.closureMovedBy ? `${p.closureMovedBy} moved for the closure of the meeting${p.closedAt ? ` at ${p.closedAt}` : ''}${p.closureSecondedBy ? `, and this was seconded by ${p.closureSecondedBy}` : ''}.` : (p.closedAt ? `The meeting closed at ${stopText(p.closedAt)}` : '');
      h += `<div class="sec"><div class="sec-head"><span class="sec-no">${no()}</span><span class="sec-title">Closure</span></div>
        <div class="pfields">${personPick('closureMovedBy', 'Closure moved by')}${personPick('closureSecondedBy', 'Seconded by')}${timeField('closedAt', 'Closed at')}</div>
        ${autoBox(closure, 'Choose who moved and seconded the closure, and the time.')}
        <textarea rows="2" placeholder="e.g. The meeting closed with a prayer led by …" onchange="setDoc('closingNote',this.value)" ${dis}>${esc(mdoc.closingNote || '')}</textarea></div>`;
      $('body').innerHTML = h;
    }
    function setDoc(k, v) { mdoc[k] = v; queueSave(); if (k === 'previousDate') renderMinutes(); }
    function setFix(i, k, v) { mdoc.corrections[i][k] = v; renderMinutes(); queueSave(); }
    function addFix() { (mdoc.corrections = mdoc.corrections || []).push({ from: '', to: '' }); renderMinutes(); queueSave(); }
    function dropFix(i) { mdoc.corrections.splice(i, 1); renderMinutes(); queueSave(); }
    function setRow(k, i, f, v) { mdoc[k][i][f] = v; queueSave(); }
    function addRow(k) { (mdoc[k] = mdoc[k] || []).push({ subject: '', body: '', action: '' }); renderMinutes(); queueSave(); }
    async function dropRow(k, i) {
      const r = mdoc[k][i];
      if ((r.body || '').trim() && !await confirmDialog('Remove this item and what is written under it?', { okText: 'Remove', danger: true })) return;
      mdoc[k].splice(i, 1); renderMinutes(); queueSave();
    }
    // Motions (Oct 2026), as on the Session minutes page: kept as records and
    // printed as "Motion: X moved that …, and Y seconded the motion. The motion was carried."
    const MOTION_RESULTS = [['pending', 'Not yet put'], ['carried', 'Carried'], ['lost', 'Lost'], ['withdrawn', 'Withdrawn'], ['deferred', 'Deferred']];
    function motionsBlock(k, i, r) {
      const list = r.motions || [];
      const dis = editable() ? '' : 'disabled';
      if (!list.length && !editable()) return '';
      const people = `<datalist id="motionPeople">${roster.map(m => `<option value="${esc(m.name)}"></option>`).join('')}</datalist>`;
      return `<div class="motions">${list.map((mo, mi) => { const v = mo.votes || {}; return `
        <div class="motion" style="border-left:3px solid var(--primary,#1f4e79);padding:6px 0 6px 10px;margin:6px 0;">
          <textarea rows="2" placeholder="Moved that … (e.g. the quotation from Firm A be accepted)" onchange="motionSet('${k}',${i},${mi},'text',this.value)" ${dis}>${esc(mo.text || '')}</textarea>
          <div class="row-2"><input type="text" list="motionPeople" value="${esc(mo.movedBy || '')}" placeholder="Moved by" onchange="motionSet('${k}',${i},${mi},'movedBy',this.value)" ${dis}>
            <input type="text" list="motionPeople" value="${esc(mo.secondedBy || '')}" placeholder="Seconded by" onchange="motionSet('${k}',${i},${mi},'secondedBy',this.value)" ${dis}></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px;">
            <select onchange="motionSet('${k}',${i},${mi},'result',this.value)" ${dis}>${MOTION_RESULTS.map(([x, l]) => `<option value="${x}"${(mo.result || 'pending') === x ? ' selected' : ''}>${l}</option>`).join('')}</select>
            <input type="number" min="0" style="width:70px" value="${v.for ?? ''}" placeholder="For" onchange="motionVote('${k}',${i},${mi},'for',this.value)" ${dis}>
            <input type="number" min="0" style="width:70px" value="${v.against ?? ''}" placeholder="Against" onchange="motionVote('${k}',${i},${mi},'against',this.value)" ${dis}>
            <input type="number" min="0" style="width:70px" value="${v.abstain ?? ''}" placeholder="Abst." onchange="motionVote('${k}',${i},${mi},'abstain',this.value)" ${dis}>
            <label class="sub" style="display:inline-flex;gap:4px;align-items:center;"><input type="checkbox" style="width:auto;" ${mo.unanimous ? 'checked' : ''} onchange="motionSet('${k}',${i},${mi},'unanimous',this.checked)" ${dis}> unanimous</label>
            ${editable() ? `<button class="btn btn-danger btn-sm" onclick="motionDel('${k}',${i},${mi})">✕</button>` : ''}
          </div></div>`; }).join('')}
        ${editable() ? `<button class="btn btn-secondary btn-sm" onclick="motionAdd('${k}',${i})">+ Record a motion</button>${people}` : ''}</div>`;
    }
    function motionAdd(k, i) { const r = mdoc[k][i]; (r.motions = r.motions || []).push({ text: '', movedBy: '', secondedBy: '', result: 'pending', votes: {} }); renderMinutes(); }
    function motionDel(k, i, mi) { mdoc[k][i].motions.splice(mi, 1); renderMinutes(); queueSave(); }
    function motionSet(k, i, mi, f, v) { mdoc[k][i].motions[mi][f] = v; queueSave(); }
    function motionVote(k, i, mi, f, v) { const m = mdoc[k][i].motions[mi]; m.votes = { ...(m.votes || {}), [f]: v === '' ? null : Number(v) }; queueSave(); }
    function moveRow(k, i, d) { const a = mdoc[k], j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; renderMinutes(); queueSave(); }

    // ---- DOCUMENTS -------------------------------------------------------------------
    function renderDocs() {
      $('dlDocx').href = `/api/meetings/${mtg.id}/write.docx`;
      $('dlPdf').href = `/api/meetings/${mtg.id}/write.pdf`;
      $('statusText').textContent = mdoc.status === 'final'
        ? `Marked final${mdoc.finalisedBy ? ' by ' + mdoc.finalisedBy : ''}. Reopen to make further changes.`
        : 'A draft — every tab can still be edited.';
      $('finalBtn').style.display = mayEdit && mdoc.status !== 'final' ? '' : 'none';
      $('reopenBtn').style.display = mayEdit && mdoc.status === 'final' ? '' : 'none';
      const s = mtg.minutesPdf;
      $('signedBox').innerHTML = (s ? `<p class="sub" style="margin-top:0;">Uploaded: <b>${esc(s.originalName || 'minutes.pdf')}</b>${s.uploadedBy ? ' by ' + esc(s.uploadedBy) : ''}${s.uploadedAt ? ', ' + esc(fmtDate(s.uploadedAt)) : ''}.</p>
          <a class="btn btn-secondary btn-sm" href="/api/meetings/${mtg.id}/minutes" target="_blank">View signed PDF</a> ` : '<p class="sub" style="margin-top:0;">Once the minutes are signed, scan them to PDF and upload them here.</p>')
        + (mayEdit ? `<button class="btn btn-secondary btn-sm" onclick="$('signedIn').click()">${s ? 'Replace' : 'Upload signed PDF'}</button>` : '');
    }
    $('signedIn').addEventListener('change', async e => {
      const f = e.target.files[0]; e.target.value = '';
      if (!f) return;
      const fd = new FormData(); fd.append('minutes', f);
      try {
        const r = await fetch(`/api/meetings/${mtg.id}/minutes`, { method: 'POST', body: fd, credentials: 'same-origin' });
        const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Could not upload.');
        mtg.minutesPdf = d.minutes ? { originalName: d.minutes.originalName, uploadedAt: d.minutes.uploadedAt, uploadedBy: d.minutes.uploadedBy } : null;
        renderDocs(); toast('Signed minutes uploaded.');
      } catch (err) { toast(err.message, true); }
    });
    $('finalBtn').addEventListener('click', async () => {
      if (!await confirmDialog('Mark these minutes as final? They cannot be edited until reopened.')) return;
      try { await saveNow(); mdoc = await api(`/meetings/${mtg.id}/write/final`, { method: 'POST', body: {} }); renderAll(); toast('Minutes marked final.'); }
      catch (e) { toast(e.message, true); }
    });
    $('reopenBtn').addEventListener('click', async () => {
      try { mdoc = await api(`/meetings/${mtg.id}/write/final`, { method: 'POST', body: { reopen: true } }); renderAll(); toast('Reopened for editing.'); }
      catch (e) { toast(e.message, true); }
    });
    ['dlDocx', 'dlPdf'].forEach(id => $(id).addEventListener('click', async e => {
      if (!saveTimer) return;
      e.preventDefault();
      await saveNow();
      if (id === 'dlDocx') window.location.href = $(id).href; else window.open($(id).href, '_blank');
    }));

    function renderAll() {
      $('title').textContent = `${mtg.entityName} — ${mtg.title || 'Meeting'}`;
      $('subtitle').textContent = [fmtDateLong(mtg.date), mtg.time, mtg.venueName, mtg.status === 'scheduled' ? 'scheduled' : ''].filter(Boolean).join(' · ');
      $('finalNote').innerHTML = mdoc.status === 'final'
        ? `<div class="final-note">Minutes marked final${mdoc.finalisedBy ? ' by ' + esc(mdoc.finalisedBy) : ''}. Reopen them on the Documents tab to make changes.</div>` : '';
      renderRoll(); renderAgenda(); renderMinutes(); renderDocs();
    }
    async function load() {
      const d = await api(`/meetings/${mmId()}/write`);
      mtg = d.meeting; mdoc = d.doc; prevMtg = d.previous; roster = d.roster || []; roll = d.roll; attInfo = d.attendance; procs = d.proceedings || {};
      mayEdit = !!d.canEdit; mayRecord = !!d.canRecord; mayUnlock = !!d.canUnlock;
      ['corrections', 'matters', 'main', 'other'].forEach(k => { if (!Array.isArray(mdoc[k])) mdoc[k] = []; });
      mdoc.proceedings = mdoc.proceedings || {};
      ['presentIds', 'onlineIds', 'apologyIds', 'guestsPresent', 'guestsApology'].forEach(k => { if (!Array.isArray(roll[k])) roll[k] = []; });
      agendaDraft = null;
      renderAll();
    }

    (async () => {
      me = await requireAuthAndRenderShell('/meetings.html');
      if (!me) return;
      if (!mmId()) { $('body').innerHTML = '<p class="sub">Open this from a meeting on the Meetings page.</p>'; return; }
      try {
        await load();
        // A meeting already held opens on the Minutes; one still to come opens on the Roll.
        if (attInfo && attInfo.locked) document.querySelector('.mtab[data-pane="minutes"]').click();
      } catch (e) { document.querySelector('.main').insertAdjacentHTML('beforeend', `<p class="sub">${esc(e.message)}</p>`); }
    })();
