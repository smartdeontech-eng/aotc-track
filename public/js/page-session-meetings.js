// AOTC Track — Session Meetings.
// Schedule → notify → take the roll as people arrive → confirm and lock →
// write the minutes. The roll stays editable all through the meeting, because
// members arrive at different times; locking is a decision the Clerk makes,
// not a gate the app imposes.
    let me, list = [], doc = null, roster = [], mayEdit = false;
    let onDuty = { names: [], label: '', hasRoster: false };
    let savingNote = null;
    let venues = [], defaultVenue = '';
    // The kinds of sitting, from the server, so the labels match the ones the
    // minutes are headed with.
    let meetingKinds = [];
    let offices = [];

    const $ = id => document.getElementById(id);
    const locked = () => !!(doc && doc.roll && doc.roll.locked);

    // Copy that works whether or not the browser grants clipboard access.
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;';
        document.body.appendChild(ta);
        ta.select();
        let done = false;
        try { done = document.execCommand('copy'); } catch (err) {}
        ta.remove();
        return done;
      }
    }

    // ---------------------------------------------------------------- venues
    // The same venue book the committee meetings use, with the Session Hall
    // offered first because that is where the Session normally sits. Anything
    // already recorded on a meeting stays selectable even if it has since been
    // taken off the list, so an old meeting never loses its venue.
    async function loadVenues() {
      try {
        const v = await SessionVenues.load();
        venues = v.venues || [];
        defaultVenue = v.defaultVenue || '';
        meetingKinds = v.meetingKinds || [];
      } catch (e) { venues = []; }
      // If the server is on an older build the dialog still has to work.
      if (!meetingKinds.length) meetingKinds = [
        { key: 'regular', label: 'Session Meeting' },
        { key: 'emergency', label: 'Emergency Session Meeting' },
      ];
    }
    // The venue box itself is shared with the Minutes page — /js/session-venues.js.
    function venueOptions(current) { return SessionVenues.options(current); }
    function venueValue(selId, otherId) { return SessionVenues.value($(selId), $(otherId)); }
    function bindVenue(selId, otherId, onPick) { SessionVenues.bind(selId, otherId, onPick); }

    function fmtDate(iso) {
      if (!iso) return '';
      const d = toLocalDate(iso);
      return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    }
    function note(msg) {
      if (!savingNote) {
        savingNote = document.createElement('div');
        savingNote.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:60;font-size:12px;padding:6px 11px;border-radius:8px;background:rgba(29,63,148,.92);color:#fff;opacity:0;transition:opacity .2s;';
        document.body.appendChild(savingNote);
      }
      savingNote.textContent = msg;
      savingNote.style.opacity = msg ? '1' : '0';
      if (msg === 'Saved') setTimeout(() => { if (savingNote.textContent === 'Saved') savingNote.style.opacity = '0'; }, 1200);
    }

    // Roll and agenda save on their own, so nothing else in the meeting is
    // touched by a tick or a duration change.
    //
    // Each has its OWN timer. They used to share one, which meant editing the
    // agenda within the debounce of a roll tick silently cancelled the roll
    // save — the ticks were on screen and never reached the server.
    const pending = { roll: null, agenda: null };

    async function writeRoll() {
      pending.roll = null;
      try {
        const saved = await api(`/minutes/${doc.id}/roll`, { method: 'PUT', body: { roll: doc.roll } });
        doc.roll = saved.roll;
        renderCounts(); note('Saved');
      } catch (e) { note(''); toast(e.message, true); }
    }
    async function writeAgenda() {
      pending.agenda = null;
      try { await api('/minutes/' + doc.id, { method: 'PUT', body: { agenda: doc.agenda } }); note('Saved'); }
      catch (e) { note(''); toast(e.message, true); }
    }
    function queueRoll() {
      if (!mayEdit || locked()) return;
      note('Saving…');
      clearTimeout(pending.roll);
      pending.roll = setTimeout(writeRoll, 600);
    }
    function queueAgenda() {
      if (!mayEdit) return;
      note('Saving…');
      clearTimeout(pending.agenda);
      pending.agenda = setTimeout(writeAgenda, 600);
    }
    // Anything still waiting on its debounce is written NOW. Called before the
    // page goes anywhere, because a pending save that never fires is work the
    // clerk watched himself do and then lost.
    async function flushSaves() {
      const jobs = [];
      if (pending.roll) { clearTimeout(pending.roll); pending.roll = null; jobs.push(writeRoll()); }
      if (pending.agenda) { clearTimeout(pending.agenda); pending.agenda = null; jobs.push(writeAgenda()); }
      if (jobs.length) await Promise.all(jobs);
    }
    // Last line of defence: closing the tab or hitting Back mid-debounce.
    window.addEventListener('beforeunload', e => {
      if (!pending.roll && !pending.agenda) return;
      e.preventDefault();
      e.returnValue = '';
    });

    // ------------------------------------------------------------------ list
    async function load() {
      list = await api('/minutes');
      $('rows').innerHTML = list.length ? list.map(d => `
        <tr>
          <td>${esc(fmtDate(d.date))}</td>
          <td>${esc(d.kindLabel || d.title || 'Session Meeting')}${
            d.meetingKind === 'emergency' ? ' <span class="badge">Emergency</span>' : ''}</td>
          <td>${esc(d.venue) || '<span class="sub">—</span>'}</td>
          <td>${d.present ? `${d.present} present${d.rollLocked ? ' · locked' : ''}` : '<span class="sub">not taken</span>'}</td>
          <td><span class="badge ${d.status === 'final' ? 'badge-done' : ''}">${d.status === 'final' ? 'Final' : 'Draft'}</span></td>
          <td style="text-align:right;"><button class="btn btn-secondary btn-sm" onclick="open_(${d.id})">Open</button></td>
        </tr>`).join('')
        : '<tr><td colspan="6" class="sub">No Session meetings yet — press “Schedule a meeting”.</td></tr>';
    }

    async function open_(id) {
      const d = await api('/minutes/' + id);
      doc = d.doc; roster = d.roster; mayEdit = d.canEdit;
      offices = d.offices || [];
      onDuty = d.onDuty || { names: [], label: '', hasRoster: false };
      $('listView').style.display = 'none';
      $('detail').style.display = '';
      $('backBtn').style.display = '';
      $('newBtn').style.display = 'none';
      $('headSub').textContent = `${doc.title || 'Session Meeting'} · ${fmtDate(doc.date)}${doc.venue ? ' · ' + doc.venue : ''}`;
      const filled = autoFillDuty();
      renderAll();
      if (filled) { queueAgenda(); note('Devotion filled from the duty roster'); }
    }
    async function back() {
      await flushSaves();
      doc = null;
      $('listView').style.display = '';
      $('detail').style.display = 'none';
      $('backBtn').style.display = 'none';
      $('newBtn').style.display = '';
      $('headSub').textContent = 'Schedule a meeting, take the roll, then write the minutes';
      load();
    }
    $('backBtn').addEventListener('click', back);

    document.querySelectorAll('.mtab').forEach(b => b.addEventListener('click', () => {
      document.querySelectorAll('.mtab').forEach(x => x.classList.toggle('active', x === b));
      document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + b.dataset.pane));
    }));

    function renderAll() { renderRoll(); renderGuests(); renderAgenda(); renderDetails(); renderMinutesLink(); renderMatters(); }

    // ------------------------------------------------------------------ roll
    function state(id) {
      const r = doc.roll || {};
      if ((r.presentIds || []).includes(id)) return 'present';
      if ((r.apologyIds || []).includes(id)) return 'apology';
      return 'absent';
    }
    function setRoll(id, s) {
      if (!mayEdit || locked()) return;
      const r = doc.roll = doc.roll || { presentIds: [], apologyIds: [], absentIds: [], onlineIds: [], guests: [] };
      r.presentIds = (r.presentIds || []).filter(x => x !== id);
      r.apologyIds = (r.apologyIds || []).filter(x => x !== id);
      if (s === 'present') r.presentIds.push(id);
      if (s === 'apology') r.apologyIds.push(id);
      renderRoll(); queueRoll();
    }
    function renderRoll() {
      $('rollEmpty').style.display = roster.length ? 'none' : '';
      const dis = (!mayEdit || locked()) ? 'disabled' : '';
      $('rollGrid').innerHTML = roster.map(m => {
        const st = state(m.id);
        return `<div class="roll-row ${st === 'present' ? 'is-present' : st === 'apology' ? 'is-apology' : ''}">
          <div class="who"><b>${esc(m.name)}</b><span>${esc(m.position || 'Member')}</span></div>
          <div class="roll-seg">
            <button class="${st === 'present' ? 'on' : ''}" onclick="setRoll(${m.id},'present')" ${dis}>P</button>
            <button class="${st === 'apology' ? 'on apo' : ''}" onclick="setRoll(${m.id},'apology')" ${dis}>Apol</button>
            <button class="${st === 'absent' ? 'on abs' : ''}" onclick="setRoll(${m.id},'absent')" ${dis}>Abs</button>
          </div>
        </div>`;
      }).join('');
      renderCounts();
      renderLockBar();
    }
    function renderCounts() {
      const r = doc.roll || {};
      $('cPresent').textContent = (r.presentIds || []).length;
      $('cApology').textContent = (r.apologyIds || []).length;
      $('cAbsent').textContent = Math.max(0, roster.length - (r.presentIds || []).length - (r.apologyIds || []).length);
      $('cAttend').textContent = (r.guests || []).length;
    }
    // The lock is offered, not enforced — take the roll as people arrive and
    // confirm it when the Session has settled.
    function renderLockBar() {
      let bar = $('lockBar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'lockBar';
        bar.className = 'card';
        bar.style.marginTop = '14px';
        $('pane-roll').insertBefore(bar, $('pane-roll').children[1] || null);
      }
      const r = doc.roll || {};
      bar.innerHTML = locked()
        ? `<b>Attendance confirmed</b>
           <p class="sub" style="margin:4px 0 8px;">Locked${r.lockedBy ? ' by ' + esc(r.lockedBy) : ''}${r.lockedAt ? ' on ' + new Date(r.lockedAt).toLocaleString('en-GB') : ''}. The minutes use this roll.</p>
           ${mayEdit ? '<button class="btn btn-secondary btn-sm" onclick="unlockRoll()">Unlock to correct it</button>' : ''}`
        : `<b>Attendance open</b>
           <p class="sub" style="margin:4px 0 8px;">Tick people in as they arrive — this saves as you go. Confirm it when the Session has settled; you can still unlock it afterwards if something was wrong.</p>
           ${mayEdit ? '<button class="btn btn-primary btn-sm" onclick="lockRoll()">Confirm &amp; lock attendance</button>' : ''}`;
    }
    async function lockRoll() {
      try {
        clearTimeout(pending.roll); pending.roll = null;
        await api(`/minutes/${doc.id}/roll`, { method: 'PUT', body: { roll: doc.roll } });
        const d = await api(`/minutes/${doc.id}/roll/lock`, { method: 'POST' });
        doc.roll = d.roll;
        renderRoll();
        toast('Attendance confirmed and locked.');
      } catch (e) { toast(e.message, true); }
    }
    async function unlockRoll() {
      if (!await confirmDialog('Unlock the attendance so it can be corrected?')) return;
      try {
        const d = await api(`/minutes/${doc.id}/roll/unlock`, { method: 'POST' });
        doc.roll = d.roll;
        renderRoll();
        toast('Attendance unlocked.');
      } catch (e) { toast(e.message, true); }
    }

    function renderGuests() {
      // By convention of the congregation the Linguist receives visitors to the
      // Session, so the Clerk is told who that is rather than having to ask.
      const lg = (roster || []).find(m => m.office === 'linguist' && m.active !== false);
      $('linguistNote').textContent = lg
        ? `Visitors are received by the Linguist, ${lg.name}.`
        : 'No Linguist is recorded — set one under AOTC Session → Composition.';
      const g = (doc.roll && doc.roll.guests) || [];
      $('guestList').innerHTML = g.length
        ? g.map((x, i) => `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;">
            <div style="flex:1;"><b style="font-size:13px;">${esc(x.name)}</b> <span class="sub">${esc(x.position || '')}</span>${x.details ? `<div class="sub" style="font-size:12px;">${esc(x.details)}</div>` : ''}</div>
            ${mayEdit && !locked() ? `<button class="btn btn-secondary btn-sm" onclick="editMeetingGuest(${i})">Edit</button> <button class="btn btn-danger btn-sm" onclick="dropGuest(${i})">Remove</button>` : ''}
          </div>`).join('')
        : '<p class="sub" style="margin:0;">Nobody recorded in attendance.</p>';
      renderCounts();
    }
    function dropGuest(i) { doc.roll.guests.splice(i, 1); renderGuests(); queueRoll(); }
    // In attendance prints as NAME + a short title, with any longer description
    // on a line underneath. An older entry whose description is all in the title
    // opens with it moved to Details, ready to be shortened.
    let meetingGuestAt = null;
    function editMeetingGuest(i) {
      meetingGuestAt = i;
      const g = i == null ? null : doc.roll.guests[i];
      $('guestForm').reset();
      $('guestTitle').textContent = g ? 'Edit someone in attendance' : 'Add someone in attendance';
      $('guestSave').textContent = g ? 'Save' : 'Add';
      if (g) {
        const long = !g.details && String(g.position || '').length > 32;
        $('gName').value = g.name || '';
        $('gPosition').value = long ? '' : (g.position === 'In attendance' ? '' : (g.position || ''));
        $('gDetails').value = long ? g.position : (g.details || '');
      }
      $('guestOverlay').style.display = 'flex';
    }
    $('addGuestBtn').addEventListener('click', () => editMeetingGuest(null));
    $('guestCancel').addEventListener('click', () => { $('guestOverlay').style.display = 'none'; });
    $('guestForm').addEventListener('submit', e => {
      e.preventDefault();
      doc.roll = doc.roll || {};
      const list = doc.roll.guests = doc.roll.guests || [];
      const entry = { name: $('gName').value.trim(), position: $('gPosition').value.trim() || 'In attendance' };
      const details = $('gDetails').value.trim();
      if (details) entry.details = details;
      // The same person never goes in twice: adding a name already listed
      // updates that line instead.
      const same = list.findIndex((g, i) => i !== meetingGuestAt && (g.name || '').trim().toLowerCase() === entry.name.toLowerCase());
      if (meetingGuestAt != null) list[meetingGuestAt] = entry;
      else if (same >= 0) { list[same] = entry; toast(`${entry.name} was already listed — updated.`); }
      else list.push(entry);
      if (meetingGuestAt != null && same >= 0) list.splice(same, 1);
      meetingGuestAt = null;
      $('guestOverlay').style.display = 'none';
      renderGuests(); queueRoll();
    });
    $('allPresentBtn').addEventListener('click', () => {
      if (!mayEdit || locked()) return;
      doc.roll = { ...(doc.roll || {}), presentIds: roster.map(m => m.id), apologyIds: [] };
      renderRoll(); queueRoll();
    });

    // ---------------------------------------------------------------- agenda
    // The running orders, the Responsible dropdowns and the duty auto-fill all
    // live in /js/agenda-editor.js, shared with the Minutes page's Agenda tab so
    // the two can never drift apart again.
    function times() {
      const m = /^(\d{1,2}):(\d{2})/.exec(doc.startTime || '');
      let clock = m ? Number(m[1]) * 60 + Number(m[2]) : null;
      return (doc.agenda || []).map(r => {
        const mins = Number(r.mins) > 0 ? Number(r.mins) : 0;
        let label = '';
        if (clock != null) {
          const t = ((clock % 1440) + 1440) % 1440;
          let h = Math.floor(t / 60) % 12; if (h === 0) h = 12;
          label = `${h}:${String(t % 60).padStart(2, '0')} ${Math.floor(t / 60) >= 12 ? 'pm' : 'am'}`;
          if (mins) label += ` (${mins} min${mins === 1 ? '' : 's'})`;
          clock += mins;
        }
        return label;
      });
    }
    function renderAgenda() {
      const ts = times();
      $('agRows').innerHTML = AgendaEditor.rows({
        agenda: doc.agenda || [], times: ts, mayEdit, offices, roster,
        meetings: list, date: (doc && doc.date) || '',
      }) || '<p class="sub">No agenda items yet — press \u201cStandard running order\u201d, or \u201cStandard + reports\u201d when Finance, Mission and Evangelism and Presbyters on Duty are being presented.</p>';

      $('dlAgDocx').href = `/api/minutes/${doc.id}/agenda.docx`;
      $('dlAgPdf').href = `/api/minutes/${doc.id}/agenda.pdf`;
      $('onDutyNote').innerHTML = !onDuty.hasRoster
        ? 'No Presbyters on Duty roster for this half of the year — upload one from Session Minutes and the devotion fills itself in.'
        : (onDuty.names.length
          ? `On duty for the week of ${esc(fmtDate(onDuty.sunday))}: <b>${esc(onDuty.label)}</b> — filled into the Devotion row automatically. `
            + `<button class="btn btn-secondary btn-sm" onclick="useDuty()" ${mayEdit ? '' : 'disabled'}>Put them there again</button>`
          : `No presbyters rostered for the week of ${esc(fmtDate(onDuty.sunday))}.`);
    }
    function setResp(i, j, v) {
      if (j === null || j === undefined) doc.agenda[i].responsible = v;
      else doc.agenda[i].subItems[j].responsible = v;
      queueAgenda();                       // no re-render: the row keeps focus
    }
    function agResp(i, j, sel) { AgendaEditor.pick(sel, v => setResp(i, j, v)); }
    function agRespTyped(i, j, inp) { setResp(i, j, inp.value.trim()); }
    function agSet(i, k, v) { doc.agenda[i][k] = k === 'mins' ? Number(v) || 0 : v; renderAgenda(); queueAgenda(); }
    function agSubSet(i, j, k, v) { doc.agenda[i].subItems[j][k] = v; queueAgenda(); }
    function agDel(i) { doc.agenda.splice(i, 1); renderAgenda(); queueAgenda(); }
    function agSubAdd(i) { (doc.agenda[i].subItems = doc.agenda[i].subItems || []).push({ item: '', responsible: '' }); renderAgenda(); queueAgenda(); }
    function agSubDel(i, j) { doc.agenda[i].subItems.splice(j, 1); renderAgenda(); queueAgenda(); }

    // Matters Arising comes from the Outstanding Matters register — that is what
    // the register is FOR. One sub-item per open matter, with the person the
    // register says should act as the Responsible. Anything already on the
    // agenda is left alone, so pressing it twice cannot double anything up.
    // The Review of minutes row names the sitting being taken. The dropdown
    // writes the sentence, so the date is in the form the minutes match on —
    // and it stays on the row, so a second set can be added after the first.
    function agAddReview(i, sel) {
      if (!mayEdit) return;
      const iso = sel && sel.value;
      if (sel) sel.value = '';
      const row = doc.agenda[i];
      if (!row || !iso) return;
      const mtg = (list || []).find(m => m.date === iso);
      const label = AgendaEditor.addReview(row, iso, mtg && (mtg.kindLabel || mtg.title), doc.agenda);
      if (!label) { toast('Those minutes are already on the agenda.'); return; }
      renderAgenda();
      queueAgenda();
      toast(`${label} added.`);
    }

    async function agFromRegister(i) {
      if (!mayEdit) return;
      const row = doc.agenda[i];
      if (!row) return;
      try {
        const r = await api('/minutes/matters?status=open');
        // The register's open matters, gathered under the agenda heading each
        // belongs to — the agenda takes the headings, not the detail.
        const groups = r.headings || [];
        if (!groups.length) {
          toast('Nothing is outstanding on the register.', true);
          return;
        }
        // Not everything the Session is carrying is for tonight, so the register
        // is offered as a list to scroll and tick rather than taken whole.
        const chosen = await AgendaEditor.pickFromRegister(row, groups);
        if (!chosen) return;                      // cancelled
        if (!chosen.length) { toast('Nothing was selected.', true); return; }
        const added = AgendaEditor.fromRegister(row, chosen);
        if (!added) { toast('Every heading selected is already on the agenda.'); return; }
        renderAgenda();
        queueAgenda();
        const under = chosen.reduce((n, g) => n + (g.matters || []).length, 0);
        toast(`${added} item${added === 1 ? '' : 's'} brought in, covering ${under} matter${under === 1 ? '' : 's'}.`);
      } catch (e) { toast(e.message, true); }
    }
    function useDuty() {
      const row = (doc.agenda || []).find(r => /devotion/i.test(r.item || ''));
      if (!row) { toast('Add a Devotion row first.', true); return; }
      row.responsible = onDuty.label;
      renderAgenda(); queueAgenda();
    }
    // Once a duty roster is in the app, the devotion fills itself: the meeting
    // date decides the week, the week decides who is on duty. Only ever written
    // into an empty cell or the generic placeholder — a name the Clerk typed is
    // never overwritten. Returns true when something was actually filled.
    function autoFillDuty() { return AgendaEditor.autoFillDuty(doc.agenda, onDuty, mayEdit); }
    $('agAddBtn').addEventListener('click', () => { (doc.agenda = doc.agenda || []).push({ mins: 10, item: '', responsible: '', subItems: [] }); renderAgenda(); queueAgenda(); });
    async function insertStandard(withReports) {
      if ((doc.agenda || []).length && !await confirmDialog(
        `Replace the current agenda with the standard running order${withReports ? ' and reports' : ''}?`)) return;
      doc.agenda = AgendaEditor.standardOrder(withReports);
      autoFillDuty();                       // the devotion row knows its own names
      renderAgenda(); queueAgenda();
    }
    $('agStdBtn').addEventListener('click', () => insertStandard(false));
    $('agStdRepBtn').addEventListener('click', () => insertStandard(true));

    // The app writes the WhatsApp post; the Clerk edits it if he wants, then
    // pastes it into the group. Two posts get made: the invitation when the
    // meeting is called, and the agenda once it is settled.
    async function showWhatsApp(kind, id) {
      const mid = id || (doc && doc.id);
      if (!mid) return;
      try {
        const r = await api(`/minutes/${mid}/whatsapp${kind === 'notice' ? '?kind=notice' : ''}`);
        $('waTitle').textContent = kind === 'notice' ? 'Meeting notice for WhatsApp' : 'Agenda for WhatsApp';
        $('waText').value = r.text;
        $('waPdf').href = `/api/minutes/${mid}/agenda.pdf`;
        $('waOverlay').style.display = 'flex';
        $('waText').focus();
      } catch (e) { toast(e.message, true); }
    }
    $('waBtn').addEventListener('click', () => showWhatsApp('agenda'));
    $('waNoticeBtn').addEventListener('click', () => showWhatsApp('notice'));
    $('waClose').addEventListener('click', () => { $('waOverlay').style.display = 'none'; });
    $('waCopy').addEventListener('click', async () => {
      if (window.freshBlessing) $('waText').value = window.freshBlessing($('waText').value);
      const done = await copyText($('waText').value);
      toast(done
        ? 'Copied — paste it into the Session WhatsApp group.'
        : 'Could not reach the clipboard — select the text and copy it by hand.', !done);
      if (done) $('waOverlay').style.display = 'none';
    });

    // --------------------------------------------------------------- details
    function renderDetails() {
      $('dDate').value = doc.date || '';
      $('dTime').value = doc.startTime || '18:30';
      $('dTitle').value = doc.title || '';
      $('dVenue').innerHTML = venueOptions(doc.venue);
      $('dVenueOther').style.display = 'none';
      ['dDate', 'dTime', 'dTitle', 'dVenue', 'dVenueOther'].forEach(id => { $(id).disabled = !mayEdit; });
      ['reSyncBtn', 'reNoticeBtn'].forEach(id => { $(id).disabled = !mayEdit; });
      renderNoticeState();
    }
    // The venue is saved through its own handler, because the value can come
    // from either the list or the "Other…" box.
    bindVenue('dVenue', 'dVenueOther', async v => {
      if (!doc || !mayEdit || !v || v === doc.venue) return;
      try {
        await api('/minutes/' + doc.id, { method: 'PUT', body: { venue: v } });
        doc.venue = v;
        $('dVenue').innerHTML = venueOptions(v);
        $('dVenueOther').style.display = 'none';
        $('headSub').textContent = `${doc.title || 'Session Meeting'} · ${fmtDate(doc.date)} · ${v}`;
        note('Saved');
      } catch (e) { toast(e.message, true); }
    });
    ['dDate', 'dTime', 'dTitle'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('change', async () => {
        const map = { dDate: 'date', dTime: 'startTime', dTitle: 'title' };
        try {
          await api('/minutes/' + doc.id, { method: 'PUT', body: { [map[id]]: el.value } });
          doc[map[id]] = el.value;
          note('Saved');
          // A new date is a new week, so the presbyters on duty change with it.
          if (id === 'dDate') { await open_(doc.id); return; }
          renderAgenda();
        } catch (e) { toast(e.message, true); }
      });
    });
    // Putting the meeting in the diary and telling the Session about it are two
    // separate acts, so they are two separate buttons.
    function sentLine(n) {
      let s = `Notice sent to ${n.sms} by SMS`;
      if (n.emails) s += `, ${n.emails} by email`;
      s += '.';
      if (n.agendaAttached) s += ' The agenda went with the email.';
      if (n.withoutPhone) s += ` ${n.withoutPhone} without a phone number.`;
      return s;
    }
    function renderNoticeState() {
      const el = $('noticeState');
      if (!el) return;
      el.textContent = doc.noticeSentAt
        ? `Notice last sent ${new Date(doc.noticeSentAt).toLocaleString('en-GB',
            { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`
          + `${doc.noticeSentBy ? ` by ${doc.noticeSentBy}` : ''}.`
        : 'No notice has gone out for this meeting yet.';
    }
    async function pushToMeetings(notify) {
      $('detailStatus').textContent = notify ? 'Sending…' : 'Updating…';
      try {
        const r = await api(`/minutes/${doc.id}/schedule`, { method: 'POST', body: { time: doc.startTime, notify } });
        $('detailStatus').textContent = '';
        let msg = r.updated ? 'Meetings page updated.' : 'Added to the Meetings page.';
        if (r.notified) {
          msg += ' ' + sentLine(r.notified);
          doc.noticeSentAt = new Date().toISOString();
          doc.noticeSentBy = me && me.name;
        } else if (r.tooLate) {
          msg += ' The meeting is already past, so no notice was sent.';
        } else if (notify) {
          msg += ' The notice could not be sent — check the Session has phone numbers.';
        } else {
          msg += ' Nobody was notified.';
        }
        renderNoticeState();
        toast(msg);
      } catch (e) { $('detailStatus').textContent = ''; toast(e.message, true); }
    }
    $('reSyncBtn').addEventListener('click', () => pushToMeetings(false));
    $('reNoticeBtn').addEventListener('click', async () => {
      if (!await confirmDialog('Send the meeting notice to the whole Session by SMS and email?')) return;
      pushToMeetings(true);
    });
    $('deleteBtn').addEventListener('click', async () => {
      if (!await confirmDialog('Delete this meeting, its roll and its minutes? This cannot be undone.')) return;
      try { await api('/minutes/' + doc.id, { method: 'DELETE' }); toast('Deleted.'); back(); }
      catch (e) { toast(e.message, true); }
    });

    // What the Session is still carrying. Shown on the meeting itself so the
    // register is in front of the Clerk when Matters Arising comes round,
    // rather than on a page he has to remember to open.
    async function renderMatters() {
      try {
        const r = await api('/minutes/matters?status=open');
        const list = r.matters || [];
        $('mattersList').innerHTML = list.length
          ? list.map(m => `
              <div style="display:flex; gap:9px; align-items:baseline; padding:5px 0; border-bottom:1px solid var(--line,#d5dae6);">
                <span style="flex:1; font-size:13px;"><b>${esc(m.subject)}</b>
                  ${m.owner ? `<span class="sub"> · ${esc(m.owner)} to act</span>` : ''}
                  ${m.age ? `<span class="sub"> · carried ${m.age} meeting${m.age === 1 ? '' : 's'}</span>` : ''}
                </span>
                <span class="sub" style="font-size:11.5px; white-space:nowrap;">${esc(m.statusLabel)}${m.flag ? ' · ' + esc(m.flag) : ''}</span>
              </div>`).join('')
            + `<p class="sub" style="margin:10px 0 0;">
                 <a href="/session-matters.html">Open the register</a> to record what the Session says about each of these.
               </p>`
          : `<p class="sub" style="margin:0;">Nothing outstanding on the register.
               <a href="/session-matters.html">Bring items in from the last minutes</a> if there should be.</p>`;
      } catch (e) { $('mattersList').innerHTML = ''; }
    }

    function renderMinutesLink() {
      $('minutesBtn').href = `/minutes.html?meeting=${doc.id}`;
      // Leaving for the minutes must not outrun the debounce: anything typed or
      // ticked in the last half-second is written before the page navigates.
      $('minutesBtn').onclick = async e => {
        e.preventDefault();
        const to = $('minutesBtn').href;
        note('Saving…');
        await flushSaves();
        window.location.href = to;
      };
      const n = (doc.sections || []).filter(s => (s.body || '').trim() || (s.children || []).some(c => (c.body || '').trim())).length;
      $('minutesState').textContent = doc.status === 'final'
        ? 'Marked final.'
        : n ? `${n} section${n === 1 ? '' : 's'} written so far.` : 'Not started.';
    }

    // ---------------------------------------------------------------- create
    bindVenue('nVenue', 'nVenueOther', null);
    $('newBtn').addEventListener('click', () => {
      $('newForm').reset();
      $('nStart').value = '18:30';
      $('nKind').innerHTML = meetingKinds
        .map(k => `<option value="${esc(k.key)}">${esc(k.label)}</option>`).join('')
        + '<option value="__other__">Something else — give it a title…</option>';
      $('nKind').value = 'regular';
      $('nTitle').value = '';
      $('nTitle').style.display = 'none';
      $('nVenue').innerHTML = venueOptions(defaultVenue);   // the Session Hall, ready to go
      $('nVenueOther').style.display = 'none';
      $('newOverlay').style.display = 'flex';
    });
    // Almost every sitting is one of the two kinds. The typed title is there for
    // the rare one that is neither, and stays out of the way until asked for.
    $('nKind').addEventListener('change', () => {
      const other = $('nKind').value === '__other__';
      $('nTitle').style.display = other ? '' : 'none';
      if (other) { $('nTitle').value = ''; $('nTitle').focus(); }
    });
    $('newCancel').addEventListener('click', () => { $('newOverlay').style.display = 'none'; });
    // Two ways out of the dialog: tell the Session, or don't. Both put the
    // meeting on the Meetings page — a quiet one can be announced later from
    // the Details tab, once the date is settled.
    async function createMeeting(notify) {
      if (!$('nDate').value) { toast('Pick a date first.', true); return; }
      try {
        const other = $('nKind').value === '__other__';
        const typed = $('nTitle').value.trim();
        if (other && !typed) { toast('Give the meeting a title, or pick one of the two kinds.', true); return; }
        const created = await api('/minutes', { method: 'POST', body: {
          date: $('nDate').value, startTime: $('nStart').value,
          // An unusual sitting is still recorded as a regular one underneath,
          // with the Clerk's own title on the front of it.
          meetingKind: other ? 'regular' : $('nKind').value,
          title: other ? typed : '',
          venue: venueValue('nVenue', 'nVenueOther'),
        } });
        const r = await api(`/minutes/${created.id}/schedule`, { method: 'POST', body: { time: $('nStart').value, notify } });
        $('newOverlay').style.display = 'none';
        toast(r.notified
          ? `Meeting scheduled. ${sentLine(r.notified)}`
          : notify
            ? (r.tooLate
                ? 'Meeting scheduled. It is already past, so no notice was sent.'
                : 'Meeting scheduled, but the notice could not be sent — check the Session has phone numbers.')
            : 'Meeting scheduled quietly — nobody was notified.');
        await open_(created.id);
        // Straight into the group post, the way the committees do it — the
        // Session is told on WhatsApp whether or not the SMS went out.
        showWhatsApp('notice', created.id);
      } catch (err) { toast(err.message, true); }
    }
    // ------------------------------------------------- what notices say
    async function loadNoticeSettings() {
      try {
        const r = await api('/minutes/notice-settings');
        $('agendaNote').value = r.agendaNote || '';
        $('agendaNote').placeholder = r.suggestion || '';
      } catch (e) {}
    }
    $('agendaNoteSave').addEventListener('click', async () => {
      try {
        const r = await api('/minutes/notice-settings', { method: 'PUT', body: { agendaNote: $('agendaNote').value } });
        toast(r.agendaNote ? 'Saved — future notices will say that.' : 'Saved — notices will say nothing about the agenda.');
      } catch (e) { toast(e.message, true); }
    });

    $('newQuiet').addEventListener('click', () => createMeeting(false));
    $('newForm').addEventListener('submit', e => { e.preventDefault(); createMeeting(true); });

    (async () => {
      me = await requireAuthAndRenderShell('/session-meetings.html');
      if (!me) return;
      await Promise.all([loadVenues(), loadNoticeSettings()]);
      load();
    })();
