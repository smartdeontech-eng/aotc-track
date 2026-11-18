// AOTC Track — Session minutes page.
// List of minutes documents, then a six-tab editor: Roll, Agenda, Minutes,
// Correspondence, Finance and Documents. Everything the clerk types is autosaved.
    let me, doc = null, roster = [], corr = [], mayEdit = false, aiEnabled = false;
    let pools = { present: [], adoption: [], ineligible: [], agents: [], adoptionByDate: {} };
    let previous = null, carryItems = [], mayConfirm = false;
    let onDuty = { names: [], label: '', hasRoster: false };
    let offices = [];
    let reviewOptions = [];
    // Every sitting the app holds, for the Review of minutes dropdown on the
    // Agenda tab. Filled by loadList and refreshed whenever it runs.
    let allMeetings = [];
    let podDraft = null;
    // One timer per concern. They shared one, so an agenda edit within the
    // debounce of another save silently cancelled it.
    const pending = { doc: null, agenda: null };
    let savingNote = null;

    const $ = id => document.getElementById(id);
    const ROMAN = ['I','II','III','IV','V','VI','VII','VIII','IX','X','XI','XII','XIII','XIV','XV','XVI','XVII','XVIII','XIX','XX'];
    // Kept in step with utils/sessionMinutes.js on the server.
    const SECTION_META = {
      devotion:      { auto: true },
      constitution:  { auto: true },
      presentation:  {},
      review:        { container: true, generated: true },
      matters:       { container: true },
      main:          { container: true },
      reports:       { container: true },
      correspondence:{ container: true, fromRegister: true },
      other:         { container: true, roman: true },
      prayers:       {},
      closure:       { auto: true },
    };
    // Sections whose text is written entirely from the fields above; the Tidy
    // button is hidden on these because there is no prose to tidy.
    const AUTO_NOTE = {
      constitution: 'Written from “constituted by” and “constituted at” above — type here only to override it.',
      closure: 'Written from the closure mover, seconder, time and benediction above — type here only to override it.',
      review: 'Built from the review date, any corrections below, and who moved and seconded the adoption. Leave this box empty — “The following minutes was reviewed.” is written for you, and who led the review prints under the first item.',
    };
    // Devotion is different: the opening sentence is written from the fields
    // above and whatever you type here follows it, so the Tidy button stays.
    const PREFIX_NOTE = {
      devotion: 'The opening sentence (time, who led it, hymn, scripture) is added automatically. Type the summary of the exhortation here — it follows that sentence in the minutes.',
      presentation: 'Leave this empty unless there is something more to say — it prints after the visitors’ paragraphs.',
    };
    const FIN_ROWS = [
      { key: 'opening', label: 'OPENING BALANCE' },
      { key: 'cash', label: 'Receipts — Cash' },
      { key: 'chequeDt', label: 'Receipts — Cheque/DT' },
      { key: 'momo', label: 'Receipts — MOMO' },
      { key: 'payments', label: 'PAYMENTS' },
    ];
    // Which pool each person-field may be chosen from.
    // Devotion is deliberately NOT here: it is free text, prefilled from the
    // Presbyters on Duty roster rather than picked from a restricted list.
    // Constituting is drawn from the AGENTS — the ministers and catechists —
    // because only an agent may chair the Session, and that list does not
    // depend on tonight's roll.
    const PEOPLE_FIELDS = {
      pConstitutedBy: 'agents',
      pCloseMoved: 'present', pCloseSeconded: 'present',
      // The benediction is pronounced by an agent — a Reverend Minister or a
      // Catechist — so only agents are offered, as with constituting.
      pBenediction: 'agents',
      // Anyone present may be asked to lead the Session in prayer.
      pPrayerLed: 'present',
      // Whoever took the minutes when it was not the Session Clerk; signs as Recorder.
      pRecordedBy: 'present',
    };
    const PROC = {
      pCommenced: 'commencedAt', pDevotionBy: 'devotionBy', pHymn: 'hymn', pScripture: 'scripture',
      pConstitutedBy: 'constitutedBy', pConstitutedAt: 'constitutedAt', pConstWordRef: 'constitutedWordRef',
      pPresentationBy: 'presentationBy', pPresentationTopic: 'presentationTopic',
      pCloseMoved: 'closureMovedBy', pCloseSeconded: 'closureSecondedBy',
      pClosedAt: 'closedAt', pBenediction: 'benedictionBy',
      pRecordedBy: 'recordedBy',
    };

    // ---------------------------------------------------------------- utils
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
    function money(v) {
      const n = Number(String(v == null ? '' : v).replace(/[, ]/g, ''));
      if (!Number.isFinite(n) || !n) return '-';
      return n.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    // Autosave: the PUT replaces the arrays wholesale, so we always send the
    // current editable state rather than trying to patch field by field.
    function queueSave() {
      if (!mayEdit || !doc) return;
      note('Saving…');
      clearTimeout(pending.doc);
      pending.doc = setTimeout(doSave, 700);
    }
    async function doSave() {
      clearTimeout(pending.doc); pending.doc = null;
      if (!mayEdit || !doc) return;
      try {
        // Only the appendices are still owned by this page. The roll and the
        // agenda belong to the meeting and are saved from Session Meetings
        // through their own endpoints — sending them from here could overwrite
        // attendance taken while this page sat open.
        await api('/minutes/' + doc.id, { method: 'PUT', body: { appendices: doc.appendices } });
        note('Saved');
      } catch (e) { note(''); toast(e.message, true); }
    }

    // The sittings the app holds, for the Review of minutes dropdown on the
    // Agenda tab. This has its own fetch because arriving from Session Meetings
    // with ?meeting=N opens the editor and never draws the list — and a
    // dropdown that is empty for that reason reads as a broken dropdown.
    async function loadMeetings() {
      try { allMeetings = await api('/minutes'); } catch (e) { /* the list is a convenience */ }
    }

    // ----------------------------------------------------------------- list
    async function loadList() {
      const list = await api('/minutes');
      allMeetings = list;
      $('docRows').innerHTML = list.length ? list.map(d => `
        <tr>
          <td>${esc(fmtDate(d.date))}</td>
          <td>${esc(d.title || 'Session Meeting')}</td>
          <td>${esc(d.venue) || '<span class="sub">—</span>'}</td>
          <td>${d.present}</td>
          <td><span class="badge ${d.status === 'final' ? 'badge-done' : ''}">${d.status === 'final' ? 'Final' : 'Draft'}</span></td>
          <td style="text-align:right;"><button class="btn btn-secondary btn-sm" onclick="openDoc(${d.id})">Open</button></td>
        </tr>`).join('')
        : `<tr><td colspan="6">${emptyState({ icon: 'doc', title: 'No Session minutes yet', text: 'Each Session meeting gets its own minutes: agenda, roll, items, correspondence and finance.', action: '+ New minutes', click: 'newBtn' })}</td></tr>`;
      loadRegister();
      loadPod();
    }

    async function loadRegister() {
      const q = $('regSearch').value.trim();
      const list = await api('/minutes/correspondence/register' + (q ? '?q=' + encodeURIComponent(q) : ''));
      $('regResults').innerHTML = list.length ? list.map(c => `
        <div class="corr-card">
          <h4>${esc(c.heading)} ${c.draftedByAi ? '<span class="ai-badge">AI draft</span>' : ''}</h4>
          <div class="sub">${esc(fmtDate(c.meetingDate))}${c.from ? ' · from ' + esc(c.from) : ''}${c.action ? ' · ' + esc(c.action) : ''}</div>
          <p style="margin:6px 0 0; font-size:13px;">${esc(c.summary)}</p>
          <div style="margin-top:8px;">${pageLinks(c, `/api/minutes/correspondence/${c.id}`)}</div>
        </div>`).join('')
        : emptyState({ icon: 'mail', title: 'No letters recorded yet', text: 'Every letter the Session receives is kept here, across all meetings.' });
    }

    let allTimer = null;
    $('allSearch').addEventListener('input', () => { clearTimeout(allTimer); allTimer = setTimeout(runSearch, 300); });
    async function runSearch() {
      const q = $('allSearch').value.trim();
      if (q.length < 2) { $('allResults').innerHTML = ''; return; }
      const hits = await api('/minutes/search?q=' + encodeURIComponent(q));
      $('allResults').innerHTML = hits.length ? hits.map(h => `
        <div class="corr-card">
          <h4><span class="sec-no">${esc(h.no)}</span> ${esc(h.subject)}</h4>
          <div class="sub">${esc(fmtDate(h.date))} · ${esc(h.title || 'Session Meeting')}</div>
          <p style="margin:6px 0 8px; font-size:13px;">${esc(h.snippet)}</p>
          <button class="btn btn-secondary btn-sm" onclick="openDoc(${h.minutesId})">Open those minutes</button>
        </div>`).join('')
        : '<p class="sub">Nothing found.</p>';
    }

    // --------------------------------------------------------------- editor
    async function openDoc(id) {
      const data = await api('/minutes/' + id);
      doc = data.doc; roster = data.roster; corr = data.correspondence;
      pools = data.eligibility || { present: [], adoption: [], ineligible: [], agents: [], adoptionByDate: {} };
      previous = data.previous; carryItems = data.carryForward || [];
      onDuty = data.onDuty || { names: [], label: '', hasRoster: false };
      reviewOptions = data.reviewOptions || [];
      offices = data.offices || [];
      mayConfirm = !!data.canConfirm;
      mayEdit = data.canEdit;
      aiEnabled = data.aiEnabled;
      inboxWaiting = []; inboxToSort = 0;
      loadInbox();
      $('listView').style.display = 'none';
      $('editor').style.display = '';
      $('backBtn').style.display = '';
      $('newBtn').style.display = 'none';
      $('headSub').textContent = `${doc.title || 'Session Meeting'} · ${fmtDate(doc.date)}${doc.venue ? ' · ' + doc.venue : ''}`;
      await syncWithAgenda(true);
      if (!aiEnabled) {
        $('aiHint').textContent = 'Automatic summarising is switched off on this server. Type each letter\u2019s heading and summary yourself; pages can still be attached for the record.';
        $('finReadBtn').disabled = true;
      }
      renderAll();
    }
    function backToList() {
      doc = null;
      $('listView').style.display = '';
      $('editor').style.display = 'none';
      $('backBtn').style.display = 'none';
      $('newBtn').style.display = '';
      $('headSub').textContent = 'Agenda, attendance, minutes and correspondence for Session meetings';
      loadList();
    }

    function renderAll() {
      renderRoll(); renderRoster(); renderGuests();
      renderAgenda(); renderOnDutyNote(); renderProceedings(); renderSections();
      renderReviews(); renderCarry();
      renderCorrespondence(); renderFinance(); renderDocs();
    }

    document.querySelectorAll('.mtab').forEach(btn => btn.addEventListener('click', () => {
      // Going back to Documents by hand ends the "Back to proofreading" offer.
      if (btn.dataset.pane === 'docs') { prReturn = null; prBackPill(false); }
      document.querySelectorAll('.mtab').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + btn.dataset.pane));
    }));

    // ----------------------------------------------------------------- roll
    function rollState(id) {
      const r = doc.roll || {};
      if ((r.presentIds || []).includes(id)) return 'present';
      if ((r.apologyIds || []).includes(id)) return 'apology';
      return 'absent';
    }
    function setRoll(id, state) {
      if (!mayEdit) return;
      const r = doc.roll = doc.roll || { presentIds: [], apologyIds: [], absentIds: [], onlineIds: [], guests: [] };
      r.presentIds = (r.presentIds || []).filter(x => x !== id);
      r.apologyIds = (r.apologyIds || []).filter(x => x !== id);
      r.onlineIds = (r.onlineIds || []).filter(x => x !== id);
      if (state === 'present') r.presentIds.push(id);
      if (state === 'apology') r.apologyIds.push(id);
      renderRoll();
      refreshPoolsLocally();
      saveRoll();
    }
    async function saveRoll() {
      if (!mayEdit) return;
      note('Saving…');
      try {
        const r = await api(`/minutes/${doc.id}/roll`, { method: 'PUT', body: { roll: doc.roll } });
        doc.roll = r.roll; renderRollCounts(); note('Saved');
      } catch (e) { note(''); toast(e.message, true); }
    }
    // Keep the mover/seconder lists honest as the roll is ticked, without a
    // round-trip: present = ticked now; adoption = also at the last meeting.
    function refreshPoolsLocally() {
      const present = (doc.roll && doc.roll.presentIds) || [];
      const byId = new Map(roster.map(m => [m.id, m]));
      const asPerson = id => { const m = byId.get(id); return m ? { id: m.id, name: m.name, position: m.position } : null; };
      const wasThere = new Set((pools.adoption || []).concat(pools.ineligible || []).length
        ? (pools.adoption || []).map(p => p.id) : []);
      pools.present = present.map(asPerson).filter(Boolean);
      if (previous) {
        pools.adoption = pools.present.filter(p => wasThere.has(p.id));
        pools.ineligible = pools.present.filter(p => !wasThere.has(p.id));
      } else {
        pools.adoption = pools.present.slice();
        pools.ineligible = [];
      }
      renderProceedings();
    }
    function renderRoll() {
      const grid = $('rollGrid');
      $('rollEmpty').style.display = roster.length ? 'none' : '';
      grid.innerHTML = roster.map(m => {
        const st = rollState(m.id);
        return `<div class="roll-row ${st === 'present' ? 'is-present' : st === 'apology' ? 'is-apology' : ''}">
          <div class="who"><b>${esc(m.name)}</b><span>${esc(m.position || 'Member')}</span></div>
          <div class="roll-seg">
            <button class="${st === 'present' ? 'on' : ''}" onclick="setRoll(${m.id},'present')" ${mayEdit ? '' : 'disabled'}>P</button>
            <button class="${st === 'apology' ? 'on apo' : ''}" onclick="setRoll(${m.id},'apology')" ${mayEdit ? '' : 'disabled'}>Apol</button>
            <button class="${st === 'absent' ? 'on abs' : ''}" onclick="setRoll(${m.id},'absent')" ${mayEdit ? '' : 'disabled'}>Abs</button>
          </div>
        </div>`;
      }).join('');
      renderRollCounts();
    }
    function renderRollCounts() {
      const r = doc.roll || {};
      $('cPresent').textContent = (r.presentIds || []).length;
      $('cApology').textContent = (r.apologyIds || []).length;
      $('cAbsent').textContent = Math.max(0, roster.length - (r.presentIds || []).length - (r.apologyIds || []).length);
    }
    $('allPresentBtn').addEventListener('click', () => {
      if (!mayEdit) return;
      doc.roll = { ...(doc.roll || {}), presentIds: roster.map(m => m.id), apologyIds: [], onlineIds: [] };
      renderRoll(); refreshPoolsLocally(); saveRoll();
    });

    function renderGuests() {
      const list = (doc.roll && doc.roll.guests) || [];
      $('guestList').innerHTML = list.length
        ? list.map((g, i) => `<div style="display:flex;align-items:center;gap:10px;padding:5px 0;">
             <div style="flex:1;"><b style="font-size:13px;">${esc(g.name)}</b> <span class="sub">${esc(g.position || '')}</span>${g.details ? `<div class="sub" style="font-size:12px;">${esc(g.details)}</div>` : ''}</div>
             ${mayEdit ? `<button class="btn btn-secondary btn-sm" onclick="editMinutesGuest(${i})">Edit</button> <button class="btn btn-danger btn-sm" onclick="removeGuest(${i})">Remove</button>` : ''}
           </div>`).join('')
        : '<p class="sub" style="margin:0;">None.</p>';
    }
    function removeGuest(i) { doc.roll.guests.splice(i, 1); renderGuests(); saveRoll(); }
    // In attendance prints as NAME + a short title, with any longer description
    // on a line underneath. An older entry whose description is all in the title
    // opens with it moved to Details, ready to be shortened.
    let minutesGuestAt = null;
    function openMinutesGuest(i) {
      minutesGuestAt = i;
      const g = i == null ? null : doc.roll.guests[i];
      $('guestForm').reset();
      $('guestTitle').textContent = g ? 'Edit guest / in attendance' : 'Add guest / in attendance';
      $('guestSave').textContent = g ? 'Save' : 'Add';
      if (g) {
        const long = !g.details && String(g.position || '').length > 32;
        $('gName').value = g.name || '';
        $('gPosition').value = long ? '' : (g.position === 'In attendance' ? '' : (g.position || ''));
        $('gDetails').value = long ? g.position : (g.details || '');
      }
      $('guestOverlay').style.display = 'flex';
    }
    function editMinutesGuest(i) { openMinutesGuest(i); }

    function renderRoster() {
      $('rosterRows').innerHTML = roster.length ? roster.map((m, i) => `
        <tr>
          <td class="mono">${i + 1}</td>
          <td>${esc(m.name)}${m.email ? `<br><span class="sub" style="font-size:11px;">${esc(m.email)}</span>` : ''}</td>
          <td>${esc(m.position || 'Member')}</td>
          <td style="text-align:right; white-space:nowrap;">
            ${mayEdit ? `
              <button class="btn btn-secondary btn-sm" onclick="moveMember(${m.id},-1)" title="Move up">↑</button>
              <button class="btn btn-secondary btn-sm" onclick="moveMember(${m.id},1)" title="Move down">↓</button>
              <button class="btn btn-secondary btn-sm" onclick="editMember(${m.id})">Edit</button>
              <button class="btn btn-danger btn-sm" onclick="delMember(${m.id})">Remove</button>` : ''}
          </td>
        </tr>`).join('')
        : '<tr><td colspan="4" class="sub">No Session members yet.</td></tr>';
    }
    async function moveMember(id, dir) {
      const i = roster.findIndex(m => m.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= roster.length) return;
      const a = roster[i], b = roster[j];
      await api('/minutes/roster/reorder', { method: 'POST', body: { order: [{ id: a.id, rank: b.rank }, { id: b.id, rank: a.rank }] } });
      roster = await api('/minutes/roster');
      renderRoster(); renderRoll();
    }
    async function delMember(id) {
      const m = roster.find(x => x.id === id);
      if (!await confirmDialog(`Remove ${m ? m.name : 'this member'} from the Session roster?`)) return;
      try {
        await api('/minutes/roster/' + id, { method: 'DELETE' });
        roster = await api('/minutes/roster');
        renderRoster(); renderRoll();
      } catch (e) { toast(e.message, true); }
    }

    // ------------------------------------------------- syncing with the agenda
    // One direction only. Anything ADDED to the agenda is brought in without
    // asking — remembering an item late should not mean typing it twice.
    // Anything REMOVED from the agenda is flagged in the minutes instead, so a
    // body already written against it is never thrown away by a rule.
    let orphans = [];
    async function syncWithAgenda(quiet) {
      if (!doc || !mayEdit || doc.locked) return;
      if (!(doc.agenda || []).length) { orphans = []; renderSyncNote(); return; }
      try {
        const r = await api(`/minutes/${doc.id}/agenda-sync`, { method: 'POST', body: { quiet: !!quiet } });
        if (r.sections) doc.sections = r.sections;
        orphans = r.orphans || [];
        renderSyncNote();
        if (r.added) {
          renderSections();
          toast(`${r.added} agenda item${r.added === 1 ? '' : 's'} brought into the minutes.`);
        }
      } catch (e) { /* a failed sync must never stop the minutes opening */ }
    }
    function renderSyncNote() {
      const el = $('syncNote');
      if (!el || !doc) return;
      if (!(doc.agenda || []).length) { el.textContent = 'No agenda has been entered for this meeting yet.'; return; }
      el.innerHTML = orphans.length
        ? `<b>${orphans.length} item${orphans.length === 1 ? '' : 's'} in the minutes ${orphans.length === 1 ? 'is' : 'are'} no longer on the agenda</b> —
           ${orphans.map(o => esc(o.subject)).join(', ')}. They are marked in the Minutes tab; delete them there if they should go.`
        : 'The minutes follow the agenda. Anything you add to the agenda appears here automatically.';
    }
    const isOrphan = (secKey, subject) => orphans.some(o =>
      o.key === secKey && String(o.subject || '').toLowerCase() === String(subject || '').trim().toLowerCase());

    // --------------------------------------------------------------- agenda
    function agendaTimes() {
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
      $('agStart').value = doc.startTime || '18:30';
      if (document.activeElement !== $('agVenue')) $('agVenue').innerHTML = SessionVenues.options(doc.venue || '');
      $('agVenue').disabled = !mayEdit;
      const times = agendaTimes();
      // Shared with the Session Meetings page — see /js/agenda-editor.js.
      $('agRows').innerHTML = AgendaEditor.rows({
        agenda: doc.agenda || [], times, mayEdit, offices, roster,
        meetings: allMeetings, date: (doc && doc.date) || '',
      }) || '<p class="sub">No agenda items yet.</p>';
    }
    function saveAgenda() {
      if (!mayEdit) return;
      note('Saving…');
      clearTimeout(pending.agenda);
      pending.agenda = setTimeout(() => {
        pending.agenda = null;
        api('/minutes/' + doc.id, { method: 'PUT', body: { agenda: doc.agenda } })
          .then(() => note('Saved')).catch(e => { note(''); toast(e.message, true); });
      }, 600);
    }
    function setResp(i, j, v) {
      if (j === null || j === undefined) doc.agenda[i].responsible = v;
      else doc.agenda[i].subItems[j].responsible = v;
      saveAgenda();                        // no re-render: the row keeps focus
    }
    function agResp(i, j, sel) { AgendaEditor.pick(sel, v => setResp(i, j, v)); }
    function agRespTyped(i, j, inp) { setResp(i, j, inp.value.trim()); }
    function agSet(i, k, v) { doc.agenda[i][k] = k === 'mins' ? Number(v) || 0 : v; renderAgenda(); saveAgenda();  queueSync(); }
    function agSubSet(i, j, k, v) { doc.agenda[i].subItems[j][k] = v; saveAgenda();  queueSync(); }
    function agDel(i) { doc.agenda.splice(i, 1); renderAgenda(); saveAgenda();  queueSync(); }
    function agSubAdd(i) { (doc.agenda[i].subItems = doc.agenda[i].subItems || []).push({ item: '', responsible: '' }); renderAgenda(); saveAgenda(); }
    function agSubDel(i, j) { doc.agenda[i].subItems.splice(j, 1); renderAgenda(); saveAgenda();  queueSync(); }

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
      const mtg = (allMeetings || []).find(m => m.date === iso);
      const label = AgendaEditor.addReview(row, iso, mtg && (mtg.kindLabel || mtg.title), doc.agenda);
      if (!label) { toast('Those minutes are already on the agenda.'); return; }
      renderAgenda();
      saveAgenda();
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
        saveAgenda();
        const under = chosen.reduce((n, g) => n + (g.matters || []).length, 0);
        toast(`${added} item${added === 1 ? '' : 's'} brought in, covering ${under} matter${under === 1 ? '' : 's'}.`);
      } catch (e) { toast(e.message, true); }
    }
    // An agenda change should show in the minutes without the clerk going and
    // fetching it. Debounced, because it fires on every keystroke-completed edit.
    let syncTimer = null;
    function queueSync() { clearTimeout(syncTimer); syncTimer = setTimeout(() => syncWithAgenda(true), 1200); }
    $('agAddBtn').addEventListener('click', () => { (doc.agenda = doc.agenda || []).push({ mins: 10, item: '', responsible: '', subItems: [] }); renderAgenda(); saveAgenda(); });
    async function insertStandard(withReports) {
      if ((doc.agenda || []).length && !await confirmDialog(
        `Replace the current agenda with the standard running order${withReports ? ' and reports' : ''}?`)) return;
      doc.agenda = AgendaEditor.standardOrder(withReports);
      AgendaEditor.autoFillDuty(doc.agenda, onDuty, mayEdit);   // the devotion knows its own names
      renderAgenda(); saveAgenda(); queueSync();
    }
    $('agStdBtn').addEventListener('click', () => insertStandard(false));
    $('agStdRepBtn').addEventListener('click', () => insertStandard(true));
    $('agStart').addEventListener('change', e => { doc.startTime = e.target.value; renderAgenda(); api('/minutes/' + doc.id, { method: 'PUT', body: { startTime: e.target.value } }).then(() => note('Saved')).catch(() => {}); });
    // The Session's venue list (shared with the Session Meetings page).
    SessionVenues.load().then(() => {
      if (doc && document.activeElement !== $('agVenue')) $('agVenue').innerHTML = SessionVenues.options(doc.venue || '');
    });
    SessionVenues.bind('agVenue', 'agVenueOther', v => {
      if (!doc || !mayEdit || !v || v === doc.venue) return;
      doc.venue = v;
      api('/minutes/' + doc.id, { method: 'PUT', body: { venue: v } }).then(() => note('Saved')).catch(() => {});
    });
    SessionVenues.bind('nVenue', 'nVenueOther', null);
    // The agenda tab's button is just "do it now" — the same sync, on demand.
    $('agSeedBtn').addEventListener('click', () => syncWithAgenda(false));

    // Nothing waiting on a debounce may be lost to a navigation.
    window.addEventListener('beforeunload', e => {
      if (!pending.doc && !pending.agenda && !Object.keys(corrPending).length) return;
      e.preventDefault();
      e.returnValue = '';
    });

    // ------------------------------------------- how correspondence is written
    // The house style lives in the prompt; this is the Clerk's own correction
    // on top of it, so a habit can be fixed without waiting for a deploy.
    $('styleBtn').addEventListener('click', async () => {
      try {
        const r = await api('/minutes/notice-settings');
        $('styleNote').value = r.correspondenceStyle || '';
        $('styleOverlay').style.display = 'flex';
        $('styleNote').focus();
      } catch (e) { toast(e.message, true); }
    });
    $('styleCancel').addEventListener('click', () => { $('styleOverlay').style.display = 'none'; });
    $('styleSave').addEventListener('click', async () => {
      try {
        await api('/minutes/notice-settings', { method: 'PUT', body: { correspondenceStyle: $('styleNote').value } });
        $('styleOverlay').style.display = 'none';
        toast($('styleNote').value.trim()
          ? 'Saved — letters drafted from now on will follow it.'
          : 'Saved — back to the house style alone.');
      } catch (e) { toast(e.message, true); }
    });

    // ---------------------------------------------------------- proceedings
    // A person-field is a dropdown of who may take that part. "Other" is kept
    // for the exceptional case so the clerk is never actually blocked.
    function personOptions(poolName, value, emptyLabel = '— not recorded —') {
      const pool = pools[poolName] || [];
      const known = pool.some(p => p.name === value);
      let html = `<option value="">${esc(emptyLabel)}</option>`;
      html += pool.map(p => `<option value="${esc(p.name)}" ${p.name === value ? 'selected' : ''}>${esc(p.name)}${p.position && p.position !== 'Member' ? ' · ' + esc(p.position) : ''}</option>`).join('');
      if (poolName === 'adoption' && (pools.ineligible || []).length) {
        html += `<optgroup label="Here tonight, but not at the meeting being adopted">`
          + pools.ineligible.map(p => `<option value="${esc(p.name)}" disabled>${esc(p.name)}</option>`).join('')
          + `</optgroup>`;
      }
      html += `<option value="__other__" ${value && !known ? 'selected' : ''}>Other…</option>`;
      return html;
    }
    // Visitors to the Session (public/js/minutes-visitors.js), mounted once.
    let visitorsMounted = false;
    function mountVisitors() {
      if (visitorsMounted || !window.MinutesVisitors) return;
      visitorsMounted = true;
      $('presConvertBtn').addEventListener('click', convertPresentation);
      MinutesVisitors.mount({
        list: $('visitorsList'), addBtn: $('addVisitorsBtn'),
        groups: () => (doc && doc.proceedings && doc.proceedings.visitors) || [],
        save: (groups) => {
          doc.proceedings = doc.proceedings || {};
          doc.proceedings.visitors = groups;
          commit('visitors');
          renderSections(); renderCorrespondence();
        },
        present: () => pools.present || [],
        linguist: () => pools.linguist || null,
        // Letters the visitors brought live in this meeting's Correspondence.
        minutesId: () => doc.id,
        // The minutes' own tidy-up, for what the visitors said and the response.
        tidy: (text, subject, lead) => polish(text, subject, '', lead),
        letters: () => corr || [],
        addLetter: (rec) => { corr.push(rec); renderCorrespondence(); },
        updateLetter: (rec) => { const i = corr.findIndex(c => c.id === rec.id); if (i >= 0) corr[i] = rec; renderCorrespondence(); },
        // A letter of this meeting: its item number as the minutes will print it.
        letterRef: (id) => {
          const i = (corr || []).findIndex(c => String(c.id) === String(id));
          if (i < 0) return null;
          let n = 0, sec = 0;
          (doc.sections || []).forEach(s => { if (s.enabled) { n += 1; if (s.key === 'correspondence') sec = n; } });
          return { current: true, no: sec ? `${sec}.${i + 1}` : '' };
        },
        mayEdit: () => !!(mayEdit && doc),
      });
    }
    // Minutes begun before 0.4.2 hold the presentation as two lines of text,
    // and its presenters may have been put under IN ATTENDANCE as "Presenter".
    // One tap turns all of that into a visitors group and opens it to finish.
    function convertPresentation() {
      if (!mayEdit || !doc) return;
      const p = doc.proceedings = doc.proceedings || {};
      const names = String(p.presentationBy || '').split(/\s*(?:,|;|\band\b|&)\s*/).map(x => x.trim()).filter(Boolean);
      const guests = (doc.roll && doc.roll.guests) || [];
      const presenters = guests.filter(g => /^presenter$/i.test(String(g.position || '').trim()));
      presenters.forEach(g => { if (g.name && !names.some(n => n.toLowerCase() === g.name.toLowerCase())) names.push(g.name); });
      const topic = String(p.presentationTopic || '').trim();
      const ling = MinutesVisitors.linguistHere();
      const group = {
        purpose: 'presentation',
        people: names.map(n => {
          const g = presenters.find(x => (x.name || '').toLowerCase() === n.toLowerCase());
          return { name: n, role: (g && g.details) || '' };
        }),
        introducedBy: ling, introducedByLinguist: !!ling,
        why: topic ? `to make a presentation on ${topic.replace(/[.]$/, '')}` : '',
        withdrew: false,
      };
      p.visitors = (Array.isArray(p.visitors) ? p.visitors : []).concat([group]);
      p.presentationBy = ''; p.presentationTopic = '';
      api(`/minutes/${doc.id}/proceedings`, { method: 'PUT', body: { proceedings: { visitors: p.visitors, presentationBy: '', presentationTopic: '' } } })
        .then(() => note('Saved')).catch(e => { note(''); toast(e.message, true); });
      if (presenters.length) {
        doc.roll.guests = guests.filter(g => !presenters.includes(g));
        renderGuests(); saveRoll();
      }
      renderProceedings();
      toast(presenters.length ? `Changed to visitors; ${presenters.length} taken out of In attendance.` : 'Changed to visitors.');
      MinutesVisitors.open(p.visitors.length - 1);
    }
    function renderProceedings() {
      mountVisitors();
      const p = doc.proceedings || {};
      // plain text fields (devotion name included — free text, prefilled below)
      ['pCommenced', 'pHymn', 'pScripture', 'pConstitutedAt', 'pConstWordRef', 'pClosedAt', 'pDevotionBy',
        'pPresentationBy', 'pPresentationTopic'].forEach(id => {
        const el = $(id);
        if (el) { el.value = p[PROC[id]] || ''; el.disabled = !mayEdit; }
      });
      // The two older presentation fields show only on minutes that used them.
      $('presLegacy').style.display = (p.presentationBy || p.presentationTopic) ? '' : 'none';
      if (window.MinutesVisitors && visitorsMounted) MinutesVisitors.render();
      // person dropdowns
      Object.entries(PEOPLE_FIELDS).forEach(([id, pool]) => {
        const sel = $(id), other = $(id + '__other');
        if (!sel) return;
        // Who led the prayers lives inside the prayers structure, not at the
        // top of proceedings, so it is read from there.
        const value = (id === 'pPrayerLed' ? (p.prayers || {}).ledBy : p[PROC[id]]) || '';
        sel.innerHTML = personOptions(pool, value, id === 'pRecordedBy' ? 'The Session Clerk' : undefined);
        sel.disabled = !mayEdit;
        const known = (pools[pool] || []).some(x => x.name === value);
        if (value && !known) {
          sel.value = '__other__';
          other.style.display = ''; other.value = value; other.disabled = !mayEdit;
        } else {
          other.style.display = 'none'; other.value = '';
        }
      });
      const pr = prayers();
      if ($('pPrayerNote')) { $('pPrayerNote').value = pr.note || ''; $('pPrayerNote').disabled = !mayEdit; }
      renderPrayerPoints();
      renderPrayerTidy();
      renderHymnBuilder();
      if ($('prayerPolishBtn')) $('prayerPolishBtn').style.display = (mayEdit && aiEnabled) ? '' : 'none';
      if ($('addPrayerBtn')) $('addPrayerBtn').style.display = mayEdit ? '' : 'none';
      const grace = $('pGrace');
      if (grace) { grace.checked = !!p.graceSaid; grace.disabled = !mayEdit; }
      const onWord = $('pConstOnWord');
      if (onWord) { onWord.checked = !!p.constitutedOnWord; onWord.disabled = !mayEdit; }
      renderClosurePreview();
      const nAgents = (pools.agents || []).length;
      $('agentNote').textContent = nAgents
        ? `Only an agent may chair, so only an agent may constitute the Session — ${nAgents} on the roster.`
        : 'No agents are recorded yet. Set the District Minister, Associate Minister and Catechists under AOTC Session → Composition.';
      $('poolNote').textContent = previous
        ? `Adoption may only be moved or seconded by someone who is here tonight and was also at the meeting of ${fmtDate(previous.date)} — ${(pools.adoption || []).length} of the ${(pools.present || []).length} present qualify.`
        : 'No earlier minutes are in the app yet, so anyone present may move the adoption.';
      renderDutyChips();
      $('corrPrevNote').textContent =
        'One block for each set of minutes the Session reviewed. Each prints as its own review, '
        + 'then its corrections, then its own adoption — in that order.';
    }
    // ---- Prayers -----------------------------------------------------------
    // Captured the way they are prayed: who led, then the points one at a time,
    // then anything else. The points print as bullets — see `bulletise` in
    // utils/sessionMinutes.js — so the Clerk never types a bullet character.
    function prayers() {
      doc.proceedings = doc.proceedings || {};
      const pr = doc.proceedings.prayers || (doc.proceedings.prayers = { ledBy: '', points: [], note: '' });
      if (!Array.isArray(pr.points)) pr.points = [];
      return pr;
    }
    function savePrayers() {
      if (!doc || !mayEdit) return;
      note('Saving…');
      api(`/minutes/${doc.id}/proceedings`, { method: 'PUT', body: { proceedings: { prayers: prayers() } } })
        .then(() => note('Saved')).catch(e => { note(''); toast(e.message, true); });
      renderSections();
      renderPrayerTidy();
    }
    function renderPrayerPoints() {
      const box = $('prayerPoints');
      if (!box) return;
      const pts = prayers().points;
      if (!pts.length) {
        box.innerHTML = '<div class="pt-empty">No prayer points yet — add them one at a time as they are prayed.</div>';
        return;
      }
      box.innerHTML = pts.map((t, i) => `
        <div class="pt-row" data-i="${i}">
          <span class="pt-n">${i + 1}.</span>
          <input type="text" value="${esc(t)}" placeholder="The point prayed for"${mayEdit ? '' : ' disabled'}>
          ${mayEdit ? '<button type="button" class="pt-x" title="Remove this point">&times;</button>' : ''}
        </div>`).join('');
    }
    if ($('addPrayerBtn')) $('addPrayerBtn').addEventListener('click', () => {
      if (!mayEdit) return;
      prayers().points.push('');
      renderPrayerPoints();
      const rows = $('prayerPoints').querySelectorAll('.pt-row input');
      if (rows.length) rows[rows.length - 1].focus();
    });
    if ($('prayerPoints')) {
      $('prayerPoints').addEventListener('input', e => {
        const row = e.target.closest('.pt-row');
        if (!row || !mayEdit) return;
        prayers().points[Number(row.dataset.i)] = e.target.value;
        queuePrayers();
      });
      $('prayerPoints').addEventListener('click', e => {
        if (!e.target.classList.contains('pt-x') || !mayEdit) return;
        prayers().points.splice(Number(e.target.closest('.pt-row').dataset.i), 1);
        renderPrayerPoints();
        savePrayers();
      });
    }
    if ($('pPrayerNote')) $('pPrayerNote').addEventListener('input', () => {
      if (!mayEdit) return;
      prayers().note = $('pPrayerNote').value;
      queuePrayers();
    });
    // Tidy the prayer points and the note together, in one pass, so the API
    // sees them as the one item they print as. Each point comes back on its own
    // line, so the list survives the round trip.
    if ($('prayerPolishBtn')) $('prayerPolishBtn').addEventListener('click', () => prayerPolish());
    async function prayerPolish() {
      const pr = prayers();
      const pts = pr.points.map(x => String(x || '').trim()).filter(Boolean);
      if (!pts.length && !String(pr.note || '').trim()) {
        toast('Type the prayer points first.', true); return false;
      }
      const rough = [
        pr.ledBy ? `${pr.ledBy} led the Session in prayer on the following:` : 'The Session prayed on the following:',
        ...pts,
        String(pr.note || '').trim() ? '\n' + pr.note.trim() : '',
      ].filter(Boolean).join('\n');
      const out = await polish(rough, 'Prayers');
      if (!out) return false;
      // Split the tidied text back into a lead-in, the points and the note.
      const lines = out.split('\n').map(x => x.trim());
      const points = [], tail = [];
      let listing = false, done = false;
      lines.forEach(l => {
        if (!l) { if (listing) { listing = false; done = true; } return; }
        const bare = l.replace(/^\s*[-*\u2022\u2013\u2014]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
        if (/:$/.test(l) && !listing && !done) { listing = true; return; }   // the lead-in
        if (listing) { points.push(bare); return; }
        tail.push(l);
      });
      if (!points.length) { toast('The tidied text had no points in it — left as it was.', true); return false; }
      pr.points = points;
      pr.note = tail.join(' ').trim();
      pr.tidiedWords = tidyWords(prayerRow().body);
      pr.handChecked = false;
      renderPrayerPoints();
      if ($('pPrayerNote')) $('pPrayerNote').value = pr.note;
      savePrayers();
      return true;
    }

    let prayerTimer = null;
    function queuePrayers() {
      renderPrayerTidy();
      clearTimeout(prayerTimer);
      prayerTimer = setTimeout(savePrayers, 900);
    }

    // The closure reads back differently depending on what actually happened —
    // the Grace said, the benediction pronounced, both, or neither — so the
    // Clerk sees the sentence he is about to print while he ticks.
    function renderClosurePreview() {
      const box = $('closurePreview');
      if (!box) return;
      const p = doc.proceedings || {};
      const moved = String(p.closureMovedBy || '').trim();
      const sec = String(p.closureSecondedBy || '').trim();
      const at = String(p.closedAt || '').trim();
      const ben = String(p.benedictionBy || '').trim();
      let tail = '';
      if (p.graceSaid && ben) tail = `, after which the Grace was said and the benediction pronounced by ${ben}`;
      else if (ben) tail = `, after which the benediction was given by ${ben}`;
      else if (p.graceSaid) tail = ', after which the Grace was said';
      box.textContent = (moved || sec || at || ben || p.graceSaid)
        ? `${moved || '…'} moved for the closure of the meeting at ${at || '…'}, and this was seconded by ${sec || '…'}${tail}.`
        : '—';
    }
    const ledSel = $('pPrayerLed');
    if (ledSel) ledSel.addEventListener('change', () => {
      if (!mayEdit) return;
      const other = $('pPrayerLed__other');
      if (ledSel.value === '__other__') {
        other.style.display = ''; other.disabled = false;
        prayers().ledBy = other.value.trim();
      } else {
        other.style.display = 'none'; other.value = '';
        prayers().ledBy = ledSel.value;
      }
      savePrayers();
    });
    if ($('pPrayerLed__other')) $('pPrayerLed__other').addEventListener('input', () => {
      if (!mayEdit) return;
      prayers().ledBy = $('pPrayerLed__other').value.trim();
      queuePrayers();
    });

    // Constituted on the word shared — a tick, and the scripture if one was named.
    const onWordBox = $('pConstOnWord');
    if (onWordBox) onWordBox.addEventListener('change', () => {
      if (!mayEdit) return;
      doc.proceedings = doc.proceedings || {};
      doc.proceedings.constitutedOnWord = onWordBox.checked;
      note('Saving…'); commit('constitutedOnWord'); renderSections();
    });
    // Mirrors constitutionSentence() in utils/sessionMinutes.js.
    function renderConstPreview() {
      const el = $('constPreview'); if (!el) return;
      const p = (doc && doc.proceedings) || {}; const or = v => (String(v || '').trim() || '______');
      const ref = String(p.constitutedWordRef || '').trim();
      const on = p.constitutedOnWord ? (ref ? `, drawing on ${ref},` : ', drawing on the words shared during the devotion,') : '';
      el.textContent = `${or(p.constitutedBy)}${on} duly constituted the Session at ${or(p.constitutedAt)} in the name of the Triune God.`;
      const refBox = $('pConstWordRef'); if (refBox) refBox.style.display = p.constitutedOnWord ? '' : 'none';
    }
    const graceBox = $('pGrace');
    if (graceBox) graceBox.addEventListener('change', () => {
      if (!mayEdit) return;
      doc.proceedings = doc.proceedings || {};
      doc.proceedings.graceSaid = graceBox.checked;
      renderClosurePreview();
      note('Saving…');
      commit('graceSaid');
      renderSections();
    });

    // ---- Hymn ----------------------------------------------------------------
    // The hymn is picked, not typed: the PH number, the stanzas actually sung,
    // and (optionally) how many stanzas the hymn has. From those the minutes'
    // own wording is written — "the first two stanzas of PH 1", "the last two
    // stanzas of PH 1", "stanzas one and three of PH 1", "all four stanzas of
    // PH 597". What prints is still the one `hymn` line, shown below the picker,
    // so an unusual case can be typed over by hand.
    const HYMN_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
    const HYMN_ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth'];
    function hymnListWords(list) {
      const w = list.map(n => HYMN_WORDS[n] || String(n));
      return w.length === 1 ? w[0] : w.slice(0, -1).join(', ') + ' and ' + w[w.length - 1];
    }
    function hymnPhrase(no, stanzas, total) {
      const ph = String(no || '').trim();
      if (!ph) return '';
      const sel = [...new Set((stanzas || []).map(Number).filter(n => n > 0))].sort((a, b) => a - b);
      const T = Number(total) || 0;
      const book = `PH ${ph}`;
      if (!sel.length) return book;
      const k = sel.length, a = sel[0], b = sel[k - 1];
      const run = b - a + 1 === k;
      let words;
      if (T && run && a === 1 && b === T) {
        words = T === 1 ? 'the only stanza' : T === 2 ? 'both stanzas' : `all ${HYMN_WORDS[T] || T} stanzas`;
      } else if (run && a === 1) {
        words = k === 1 ? 'the first stanza' : `the first ${HYMN_WORDS[k] || k} stanzas`;
      } else if (run && T && b === T) {
        words = k === 1 ? 'the last stanza' : `the last ${HYMN_WORDS[k] || k} stanzas`;
      } else if (k === 1) {
        words = `the ${HYMN_ORD[a] || a + 'th'} stanza`;
      } else if (run && k >= 3) {
        words = `stanzas ${HYMN_WORDS[a] || a} to ${HYMN_WORDS[b] || b}`;
      } else {
        words = `stanzas ${hymnListWords(sel)}`;
      }
      return `${words} of ${book}`;
    }
    function hymnState() {
      const p = doc.proceedings || (doc.proceedings = {});
      let no = p.hymnNo || '';
      // Minutes recorded before the picker existed carry only the typed line.
      if (!no) { const m = String(p.hymn || '').match(/\bPH\s*(\d+)/i); if (m) no = m[1]; }
      const stanzas = String(p.hymnStanzas || '').split(',').map(Number).filter(n => n > 0);
      return { no, stanzas, total: Number(p.hymnTotal) || 0 };
    }
    function renderHymnBuilder() {
      if (!$('pHymnNo')) return;
      const st = hymnState();
      $('pHymnNo').value = st.no;
      $('pHymnNo').disabled = !mayEdit;
      $('pHymnTotal').innerHTML = '<option value="">not given</option>'
        + Array.from({ length: 12 }, (_, i) => i + 1).map(n => `<option value="${n}" ${st.total === n ? 'selected' : ''}>${n}</option>`).join('');
      $('pHymnTotal').disabled = !mayEdit;
      const shown = st.total || Math.max(6, ...st.stanzas);
      $('pHymnChips').innerHTML = Array.from({ length: shown }, (_, i) => i + 1).map(n => `
        <label class="sub" style="display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line,#d9dee8);border-radius:6px;padding:3px 8px;cursor:pointer;">
          <input type="checkbox" class="hymnStanza" value="${n}" ${st.stanzas.includes(n) ? 'checked' : ''} ${mayEdit ? '' : 'disabled'} style="width:auto;"> ${n}
        </label>`).join('')
        + (mayEdit && st.total ? `<button type="button" class="btn btn-secondary btn-sm" id="hymnAllBtn">All ${st.total}</button>` : '');
    }
    function hymnCommit(rebuild) {
      if (!doc || !mayEdit) return;
      const no = $('pHymnNo').value.trim().replace(/^PH\s*/i, '');
      const total = Number($('pHymnTotal').value) || 0;
      let stanzas = [...document.querySelectorAll('#pHymnChips .hymnStanza:checked')].map(x => Number(x.value));
      if (total) stanzas = stanzas.filter(n => n <= total);
      const phrase = hymnPhrase(no, stanzas, total);
      const patch = { hymnNo: no, hymnStanzas: stanzas.join(','), hymnTotal: total ? String(total) : '' };
      // Only overwrite the printed line when the picker says something; a line
      // typed by hand with no PH number given is left alone.
      if (no) { patch.hymn = phrase; $('pHymn').value = phrase; }
      doc.proceedings = { ...(doc.proceedings || {}), ...patch };
      note('Saving…');
      api(`/minutes/${doc.id}/proceedings`, { method: 'PUT', body: { proceedings: patch } })
        .then(() => note('Saved')).catch(e => { note(''); toast(e.message, true); });
      if (rebuild) renderHymnBuilder();
      renderSections();
    }
    if ($('pHymnNo')) {
      $('pHymnNo').addEventListener('change', () => hymnCommit(false));
      $('pHymnTotal').addEventListener('change', () => hymnCommit(true));
      $('pHymnChips').addEventListener('change', e => { if (e.target.classList.contains('hymnStanza')) hymnCommit(false); });
      $('pHymnChips').addEventListener('click', e => {
        if (e.target.id !== 'hymnAllBtn') return;
        document.querySelectorAll('#pHymnChips .hymnStanza').forEach(x => { x.checked = true; });
        hymnCommit(false);
      });
    }

    // One proceedings field, saved on its own. The roll, the sections and the
    // agenda each have their own endpoint; this is the proceedings' one, and it
    // merges field by field so two fields edited quickly cannot overwrite each
    // other.
    function commit(key) {
      if (!doc || !mayEdit) return;
      api(`/minutes/${doc.id}/proceedings`, { method: 'PUT', body: { proceedings: { [key]: doc.proceedings[key] } } })
        .then(() => note('Saved')).catch(e => { note(''); toast(e.message, true); });
    }
    Object.entries(PROC).forEach(([id, key]) => {
      const el = $(id);
      if (!el) return;
      el.addEventListener('change', () => {
        doc.proceedings = doc.proceedings || {};
        // Times typed any way ("9:00 PM", "9pm", "21:00") are put in the
        // minutes' style ("9:00 pm") as soon as the box is left.
        if (['pCommenced', 'pConstitutedAt', 'pClosedAt'].includes(id) && window.VisitorsText) el.value = VisitorsText.clock(el.value);
        if (PEOPLE_FIELDS[id]) {
          const other = $(id + '__other');
          if (el.value === '__other__') {
            other.style.display = ''; other.disabled = false;
            doc.proceedings[key] = other.value.trim();
          } else {
            other.style.display = 'none'; other.value = '';
            doc.proceedings[key] = el.value;
          }
        } else {
          doc.proceedings[key] = el.value;
        }
        note('Saving…'); commit(key); renderSections();
      });
      const other = $(id + '__other');
      if (other) other.addEventListener('change', () => {
        doc.proceedings = doc.proceedings || {};
        doc.proceedings[key] = other.value.trim();
        note('Saving…'); commit(key); renderSections();
      });
    });

    // -------------------------------------------------------- corrections
    // ---------------------------------------------------- review of minutes
    // The Session may review more than one set at a sitting, and each set gets
    // the same three parts in the same order: the review, then any corrections
    // to THAT set, then its own adoption. So this is a list of blocks, not one
    // set of fields — two sets reviewed produce two complete blocks.
    function reviews() { return (doc.reviews = doc.reviews || []); }

    // Migrate the older single-set fields the first time this is opened, so
    // nothing recorded before today is lost or has to be retyped.
    function adoptFromOldFields() {
      if (Array.isArray(doc.reviews)) return;
      const p = doc.proceedings || {};
      const one = {
        date: p.minutesReviewDate || '', readBy: p.minutesReadBy || '',
        movedBy: p.minutesMovedBy || '', secondedBy: p.minutesSecondedBy || '',
        note: '', corrections: (doc.corrections || []).slice(),
      };
      const empty = !one.date && !one.readBy && !one.movedBy && !one.secondedBy && !one.corrections.length;
      doc.reviews = empty ? [] : [one];
    }

    // Who may move the adoption of a given set: present tonight AND at that
    // meeting. The server sends one list per earlier meeting date.
    function adoptionPool(r) {
      const byDate = pools.adoptionByDate || {};
      const iso = r.iso || Object.keys(byDate).find(d => sameMeeting(d, r.date));
      return (iso && byDate[iso]) ? byDate[iso] : (pools.present || []);
    }
    function sameMeeting(iso, text) {
      const t = String(text || '').trim().toLowerCase();
      if (!t) return false;
      const d = toLocalDate(iso);
      if (isNaN(d)) return false;
      const long = d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).toLowerCase();
      const day = String(d.getDate());
      return t === long || (t.includes(day) && t.includes(long.split(' ')[1]) && t.includes(String(d.getFullYear())));
    }
    function personPicker(value, list, handler) {
      const known = list.some(p => p.name === value);
      return `<select onchange="${handler}(this)" ${mayEdit ? '' : 'disabled'}>
          <option value="">— not recorded —</option>
          ${list.map(p => `<option value="${esc(p.name)}"${p.name === value ? ' selected' : ''}>${esc(p.name)}${p.position && p.position !== 'Member' ? ' · ' + esc(p.position) : ''}</option>`).join('')}
          <option value="__other__"${value && !known ? ' selected' : ''}>Other…</option>
        </select>
        <input type="text" class="revOther" placeholder="Type the name" value="${value && !known ? esc(value) : ''}"
               style="margin-top:5px; ${value && !known ? '' : 'display:none;'}"
               onchange="${handler}Typed(this)" ${mayEdit ? '' : 'disabled'}>`;
    }

    function renderReviews() {
      adoptFromOldFields();
      const list = reviews();
      $('reviewList').innerHTML = list.length ? list.map((r, i) => {
        const pool = adoptionPool(r);
        const fixes = r.corrections || [];
        return `
        <div class="rev" data-rev="${i}">
          <div class="rev-head">
            <span class="n">${i + 1}</span>
            <b>${r.date ? esc(`Minutes of ${r.date}`) : 'Which minutes?'}</b>
            ${mayEdit ? `<button class="btn btn-danger btn-sm" onclick="revDel(${i})">Remove</button>` : ''}
          </div>
          <div class="field-row">
            <div class="field"><label>Which minutes</label>
              ${minutesPicker(r, i)}</div>
            <div class="field"><label>Read by</label>
              ${personPicker(r.readBy || '', pools.present || [], `revRead${i}`)}</div>
          </div>

          <p class="sub" style="margin:6px 0 4px;"><b>Corrections</b> — these print between the review and the adoption.</p>
          ${fixes.map((c, ci) => `
            <div class="fix">
              <div class="field-row">
                <div class="field"><label>Where</label>
                  <input type="text" value="${esc(c.where || '')}" placeholder="e.g. Item numbering"
                    onchange="fixSet(${i},${ci},'where',this.value)" ${mayEdit ? '' : 'disabled'}></div>
                <div class="field"><label>Item number (optional)</label>
                  <input type="text" value="${esc(c.ref || '')}" placeholder="e.g. 5.2"
                    onchange="fixSet(${i},${ci},'ref',this.value)" ${mayEdit ? '' : 'disabled'}></div>
              </div>
              <div class="field-row">
                <div class="field"><label>From</label>
                  <input type="text" value="${esc(c.was || '')}" placeholder="DANIEL ASUMADU"
                    onchange="fixSet(${i},${ci},'was',this.value)" ${mayEdit ? '' : 'disabled'}></div>
                <div class="field"><label>To</label>
                  <input type="text" value="${esc(c.now || '')}" placeholder="DANIEL ASUMADU OWUSU"
                    onchange="fixSet(${i},${ci},'now',this.value)" ${mayEdit ? '' : 'disabled'}></div>
              </div>
              <div class="field"><label>Or describe the correction</label>
                <input type="text" value="${esc(c.note || '')}" placeholder="e.g. The item number for closure was changed from 11.0 to 5.0."
                  onchange="fixSet(${i},${ci},'note',this.value)" ${mayEdit ? '' : 'disabled'}></div>
              ${mayEdit ? `
                <button class="btn btn-secondary btn-sm" onclick="applyFix(${i},${ci})" ${previous && !previous.locked ? '' : 'disabled'}>Apply to the earlier minutes</button>
                <button class="btn btn-danger btn-sm" onclick="fixDel(${i},${ci})">Remove</button>` : ''}
            </div>`).join('')
          || '<p class="sub" style="margin:0 0 8px;">None — the adoption will read “in the absence of corrections”.</p>'}
          ${mayEdit ? `<button class="btn btn-secondary btn-sm" onclick="fixAdd(${i})">+ Add a correction</button>` : ''}

          <div class="field-row" style="margin-top:12px;">
            <div class="field"><label>Adoption moved by</label>
              ${personPicker(r.movedBy || '', pool, `revMoved${i}`)}</div>
            <div class="field"><label>Seconded by</label>
              ${personPicker(r.secondedBy || '', pool, `revSec${i}`)}</div>
          </div>
          <p class="sub" style="margin:0;">${r.date && pool !== (pools.present || [])
            ? `${pool.length} of those here tonight were also at that meeting, so only they may move or second its adoption.`
            : 'Type the meeting date above and the list narrows to those who were there.'}</p>
        </div>`;
      }).join('')
        : '<p class="sub">No minutes recorded as reviewed yet. Press “+ Add the minutes reviewed”, once for each set the Session took.</p>';

      // The button only says "another" once there IS one — otherwise it reads
      // as though something has already been added.
      $('addReviewBtn').textContent = list.length ? '+ Another set of minutes' : '+ Add the minutes reviewed';

      // one handler per block, so the inline markup stays simple
      list.forEach((r, i) => {
        window[`revRead${i}`] = sel => pickRev(sel, i, 'readBy');
        window[`revRead${i}Typed`] = inp => revSet(i, 'readBy', inp.value.trim());
        window[`revMoved${i}`] = sel => pickRev(sel, i, 'movedBy');
        window[`revMoved${i}Typed`] = inp => revSet(i, 'movedBy', inp.value.trim());
        window[`revSec${i}`] = sel => pickRev(sel, i, 'secondedBy');
        window[`revSec${i}Typed`] = inp => revSet(i, 'secondedBy', inp.value.trim());
        window[`revDate${i}`] = sel => pickDate(sel, i);
        window[`revDate${i}Typed`] = inp => { reviews()[i].iso = ''; revSet(i, 'date', inp.value.trim()); };
      });
    }
    // The minutes being reviewed: whatever the agenda named, then the earlier
    // sittings the app holds. Picking one carries its real date along, so the
    // corrections and the mover list line up with the right meeting.
    // Which sets other blocks have already claimed.
    function usedElsewhere(i) {
      return new Set(reviews()
        .map((x, xi) => (xi === i ? '' : String(x.date || '').trim().toLowerCase()))
        .filter(Boolean));
    }
    // The list comes from two places, and when it is short it is worth saying
    // which one is missing — an empty dropdown with no explanation reads as a
    // broken dropdown.
    function hintFor(nAgenda, nApp) {
      const line = t => `<p class="sub" style="margin:5px 0 0; font-size:11.5px;">${t}</p>`;
      if (!nAgenda && !nApp) {
        return line('Nothing to choose from yet. Add the meetings under <b>Review of minutes</b> on the '
          + 'Agenda tab — one sub-item per set, e.g. “Minutes of 29th January 2026” — and they appear here. '
          + 'Earlier Session meetings held in the app are offered too, once there are some. '
          + 'Until then, use <b>Other…</b> and type the date.');
      }
      if (!nAgenda) {
        return line('These are earlier Session meetings the app holds. To have tonight\u2019s agenda drive this list, '
          + 'add a sub-item under <b>Review of minutes</b> for each set being reviewed.');
      }
      return '';
    }
    function minutesPicker(r, i) {
      const cur = String(r.date || '').trim();
      // A set already taken by another block is shown but cannot be picked
      // again — reviewing the same minutes twice in one sitting is an error,
      // not a choice, and this way the one left over is obvious.
      const taken = usedElsewhere(i);
      const fromAgenda = reviewOptions.filter(o => o.source === 'agenda');
      const fromApp = reviewOptions.filter(o => o.source === 'app' && !fromAgenda.some(a => a.label === o.label));
      const known = reviewOptions.some(o => o.label === cur);
      const opt = o => {
        const used = taken.has(o.label.toLowerCase()) && o.label !== cur;
        return `<option value="${esc(o.label)}" data-iso="${esc(o.iso || '')}"${o.label === cur ? ' selected' : ''}`
          + `${used ? ' disabled' : ''}>${esc(o.label)}${used ? ' · already added' : ''}</option>`;
      };
      return `<select onchange="revDate${i}(this)" ${mayEdit ? '' : 'disabled'}>
          <option value="">— which minutes? —</option>
          ${fromAgenda.length ? `<optgroup label="On tonight's agenda">${fromAgenda.map(opt).join('')}</optgroup>` : ''}
          ${fromApp.length ? `<optgroup label="Earlier meetings">${fromApp.map(opt).join('')}</optgroup>` : ''}
          <option value="__other__"${cur && !known ? ' selected' : ''}>Other…</option>
        </select>
        <input type="text" class="revOther" placeholder="e.g. 29th January 2026" value="${cur && !known ? esc(cur) : ''}"
               style="margin-top:5px; ${cur && !known ? '' : 'display:none;'}"
               onchange="revDate${i}Typed(this)" ${mayEdit ? '' : 'disabled'}>
        ${hintFor(fromAgenda.length, fromApp.length)}`;
    }
    function pickDate(sel, i) {
      const other = sel.parentElement.querySelector('.revOther');
      if (sel.value === '__other__') { other.style.display = ''; other.value = ''; other.focus(); return; }
      other.style.display = 'none'; other.value = '';
      const iso = sel.selectedOptions[0] ? sel.selectedOptions[0].dataset.iso || '' : '';
      reviews()[i].iso = iso;
      revSet(i, 'date', sel.value);
    }
    function pickRev(sel, i, key) {
      const other = sel.parentElement.querySelector('.revOther');
      if (sel.value === '__other__') { other.style.display = ''; other.value = ''; other.focus(); return; }
      other.style.display = 'none'; other.value = '';
      revSet(i, key, sel.value);
    }
    function revSet(i, k, v) {
      reviews()[i][k] = v;
      saveReviews(); renderSections();
      if (k === 'date') renderReviews();      // the other blocks' choices shift with it
    }
    function revDel(i) { reviews().splice(i, 1); saveReviews(); renderReviews(); renderSections(); }
    function fixSet(i, ci, k, v) { reviews()[i].corrections[ci][k] = v; saveReviews(); renderSections(); }
    function fixDel(i, ci) { reviews()[i].corrections.splice(ci, 1); saveReviews(); renderReviews(); renderSections(); }
    function fixAdd(i) {
      (reviews()[i].corrections = reviews()[i].corrections || []).push({ where: '', ref: '', was: '', now: '', note: '' });
      renderReviews();
    }
    async function saveReviews() {
      try {
        const r = await api('/minutes/' + doc.id + '/reviews', { method: 'PUT', body: { reviews: doc.reviews } });
        doc.reviews = r.reviews; note('Saved');
      } catch (e) { toast(e.message, true); }
    }
    $('addReviewBtn').addEventListener('click', () => {
      adoptFromOldFields();
      // Take the next set the agenda names that no block has claimed yet. With
      // two on the agenda and the first already added, the second fills itself
      // in — there is nothing left to choose.
      const claimed = new Set(reviews().map(x => String(x.date || '').trim().toLowerCase()).filter(Boolean));
      const next = reviewOptions.find(o => o.source === 'agenda' && !claimed.has(o.label.toLowerCase()));
      reviews().push({ date: next ? next.label : '', iso: next ? next.iso : '',
                       readBy: '', movedBy: '', secondedBy: '', note: '', corrections: [] });
      if (next) saveReviews();
      renderReviews(); renderSections();
    });

    async function applyFix(i, ci) {
      try {
        const r = await api(`/minutes/${doc.id}/corrections/${i}/${ci}/apply`, { method: 'POST' });
        toast(`Corrected ${r.replacements} place${r.replacements === 1 ? '' : 's'} in the minutes of ${fmtDate(r.targetDate)}.`);
      } catch (e) { toast(e.message, true); }
    }

    // ------------------------------------------------------- carry-forward
    function renderCarry() {
      $('carryList').innerHTML = carryItems.length ? carryItems.map(it => `
        <div style="padding:6px 0; border-bottom:1px solid var(--line,#e6e9f0);">
          <b style="font-size:13px;">${esc(it.subject || it.action)}</b>
          ${it.deferred ? '<span class="ai-badge" style="margin-left:6px;">deferred</span>' : ''}
          ${it.action ? `<div class="sub">${esc(it.action)}${it.responsible ? ' — ' + esc(it.responsible) : ''}</div>` : ''}
        </div>`).join('')
        : `<p class="sub" style="margin:0;">${previous ? 'Nothing outstanding from the last meeting.' : 'No earlier minutes in the app yet.'}</p>`;
    }
    $('carryBtn').addEventListener('click', async () => {
      if (!carryItems.length) { toast('There is nothing outstanding to bring forward.', true); return; }
      try {
        await doSave();
        const r = await api(`/minutes/${doc.id}/carry-forward`, { method: 'POST', body: { items: carryItems } });
        doc = r.doc;
        renderSections(); renderAgenda();
        toast(r.added ? `Brought ${r.added} item${r.added === 1 ? '' : 's'} into Matters Arising.` : 'They were already there.');
      } catch (e) { toast(e.message, true); }
    });

    // ------------------------------------------------------------- sections
    // Under the Presentation item: what the visitors' groups will print, so the
    // box below is plainly for anything EXTRA, not a second copy of them.
    function visitorsLead() {
      const groups = (doc.proceedings && doc.proceedings.visitors) || [];
      const items = window.VisitorsText ? VisitorsText.visitorsItems(groups) : [];
      const n = (doc.sections || []).filter(s => s.enabled).findIndex(s => s.key === 'presentation') + 1;
      const text = items.length ? [VisitorsText.visitorsLeadLine(items.length)]
        .concat(items.map((it, i) => `${n ? `${n}.${i + 1}  ` : ''}${it.subject}\n${it.body}`)).join('\n\n') : '';
      if (!text) {
        const legacy = doc.proceedings && (doc.proceedings.presentationBy || doc.proceedings.presentationTopic);
        return legacy ? '' : '<p class="sub" style="margin:0 0 8px;font-size:12.5px;">No visitors added yet — use “+ Add visitors” above. With none, this item prints “No presentation was scheduled for the meeting.”</p>';
      }
      // The visitors' cards just above already show each printed paragraph.
      return '';
    }
    // Which pick group sits at the top of which section's block (Nov 2026).
    // The groups are plain HTML in #mParking; they are MOVED (not copied) into
    // the block on every render, so their listeners and values survive.
    const SEC_PICKS = { devotion: 'grpOpening', constitution: 'grpConstitution', presentation: 'grpVisitors', review: 'grpReview', matters: 'grpCarry', prayers: 'grpPrayers', closure: 'grpClosure' };
    const SEC_SHORT = { devotion: 'Opening', constitution: 'Constitution', presentation: 'Presentation', review: 'Review', matters: 'Matters Arising', main: 'Main Business', reports: 'Reports', correspondence: 'Correspondence', other: 'Other Matters', prayers: 'Prayers', closure: 'Closure' };
    function parkPicks() {
      const park = $('mParking'); if (!park) return;
      Object.values(SEC_PICKS).forEach(id => { const g = $(id); if (g && g.parentNode !== park) park.appendChild(g); });
    }
    function placePicks() {
      document.querySelectorAll('#secList [data-slot]').forEach(slot => {
        const g = $(SEC_PICKS[slot.dataset.slot]); if (g) slot.appendChild(g);
      });
    }
    function renderJump() {
      const nav = $('secJump'); if (!nav) return;
      let n = 0;
      nav.innerHTML = (doc.sections || []).filter(s => s.enabled).map(s => {
        n += 1;
        return `<button type="button" class="sec-jump-btn" data-go="${esc(s.key)}"><b>${n}.0</b> ${esc(SEC_SHORT[s.key] || s.subject || '')}</button>`;
      }).join('');
    }
    // Moving a field that has the cursor fires its blur/change handlers, which
    // call renderSections() again in the middle of this one. Do that re-render
    // afterwards instead, once.
    let sectionsRendering = false, sectionsAgain = false;
    function renderSections() {
      if (sectionsRendering) { sectionsAgain = true; return; }
      sectionsRendering = true;
      try { renderSectionsNow(); } finally { sectionsRendering = false; }
      if (sectionsAgain) { sectionsAgain = false; setTimeout(renderSections, 0); }
    }
    function renderSectionsNow() {
      renderClosurePreview(); renderConstPreview();
      const secs = doc.sections || [];
      let n = 0;
      // Moving a field takes the cursor out of it: remember where it was.
      const act = document.activeElement;
      const keep = act && act.closest && act.closest('#mParking, [data-slot]') ? { el: act, a: act.selectionStart, b: act.selectionEnd } : null;
      parkPicks();
      $('secList').innerHTML = secs.map((s, si) => {
        const m = SECTION_META[s.key] || {};
        if (s.enabled) n += 1;
        const no = s.enabled ? `${n}.0` : '—';
        const kids = m.fromRegister ? corr.map(c => ({ subject: c.heading, body: c.summary, action: c.action })) : (s.children || []);
        return `
        <div class="sec ${s.enabled ? '' : 'off'}" data-mi="${esc(s.key)}:-1">
          <div class="sec-head">
            <span class="sec-no">${no}</span>
            <span class="sec-title">${esc(s.subject || '')}</span>
            <label class="sub" style="display:flex;align-items:center;gap:6px;">
              <input type="checkbox" ${s.enabled ? 'checked' : ''} onchange="secToggle(${si},this.checked)" ${mayEdit ? '' : 'disabled'} style="width:auto;">
              included
            </label>
          </div>
          ${s.enabled ? `
            ${SEC_PICKS[s.key] ? `<div class="sec-pick" data-slot="${esc(s.key)}"><div class="sec-cap">${s.key === 'review' || s.key === 'matters' || s.key === 'presentation' ? '' : 'Pick'}</div></div>` : ''}
            ${m.fromRegister ? '<p class="sub" style="margin:0 0 8px;">Filled from the Correspondence tab.</p>' : ''}
            ${m.generated ? '<p class="sub" style="margin:0 0 8px;">Written from the minutes reviewed and their corrections, above.</p>' : ''}
            ${SEC_PICKS[s.key] && !m.generated ? '<div class="sec-cap">Type</div>' : ''}
            ${s.key === 'presentation' ? visitorsLead() : ''}
            <textarea placeholder="${s.key === 'presentation' ? 'Anything further to add after the visitors (optional)…' : PREFIX_NOTE[s.key] ? 'Summary of the devotion…' : (m.container ? 'Lead-in line (optional)' : 'What happened…')}"
              onchange="secSet(${si},'body',this.value)" ${mayEdit ? '' : 'disabled'}>${esc(s.body || '')}</textarea>
            ${polishBtn(`secPolish(${si})`, s.key)}${undoBtn(si, -1)}${!m.container ? tidyBadge(s, si, -1) : ''}
            ${AUTO_NOTE[s.key] || PREFIX_NOTE[s.key] ? `<p class="sub" style="margin:4px 0 0; font-size:11.5px;">${AUTO_NOTE[s.key] || PREFIX_NOTE[s.key]}</p>` : ''}
            ${m.container && !m.generated ? kids.map((c, ci) => `
              <div class="child${isOrphan(s.key, c.subject) ? ' dropped' : ''}" data-mi="${esc(s.key)}:${ci}">
                ${isOrphan(s.key, c.subject) ? `<p class="dropped-note">Taken off the agenda — delete it here if it should go.</p>` : ''}
                ${c.carriedFrom ? `<p class="sub" style="margin:0 0 6px; font-size:11.5px;">Carried from ${esc(fmtDate(c.carriedFrom.date))} item ${esc(c.carriedFrom.no)}${c.carriedFrom.text ? ' — ' + esc(c.carriedFrom.text) : ''}</p>` : ''}
                <div class="row-2">
                  <input type="text" value="${esc(c.subject || '')}"
                    placeholder="${m.roman ? 'Other Matters ' + (ROMAN[ci] || ci + 1) + ' — subject' : 'Sub-item heading'}"
                    onchange="childSet(${si},${ci},'subject',this.value)" ${mayEdit && !m.fromRegister ? '' : 'disabled'}>
                  <input type="text" value="${esc(c.action || '')}" placeholder="Action (optional)"
                    onchange="childSet(${si},${ci},'action',this.value)" ${mayEdit && !m.fromRegister ? '' : 'disabled'}>
                </div>
                ${m.fromRegister && corrUnsettled(c) ? `<p class="sub" style="margin:4px 0 6px; font-size:11.5px; color:#8a5d00;">No Action yet — choose it on the Correspondence tab.</p>` : ''}
                <textarea placeholder="${s.key === 'reports' ? 'The report… (leave blank and the minutes say “No report was presented.”)' : 'What was said or decided…'}" onchange="childSet(${si},${ci},'body',this.value)"
                  ${mayEdit && !m.fromRegister ? '' : 'disabled'}>${esc(c.body || '')}</textarea>
                ${!m.fromRegister ? polishBtn(`childPolish(${si},${ci})`, s.key) + undoBtn(si, ci) + tidyBadge(c, si, ci) : ''}
                ${!m.fromRegister ? motionsBlock(si, ci, c) : ''}
                ${mayEdit && !m.fromRegister && (c.action || '').trim() ? `
                  <div class="row-2" style="margin-top:6px;">
                    <input type="text" value="${esc(c.actionResponsible || '')}" placeholder="Responsible (for follow-up)"
                      onchange="childSet(${si},${ci},'actionResponsible',this.value)">
                    <input type="date" value="${esc(c.actionDate || '')}" onchange="childSet(${si},${ci},'actionDate',this.value)">
                  </div>
                  <label class="sub" style="display:inline-flex;align-items:center;gap:6px;margin-top:6px;">
                    <input type="checkbox" ${c.actionStatus === 'done' ? 'checked' : ''} style="width:auto;"
                      onchange="childSet(${si},${ci},'actionStatus',this.checked?'done':'open')"> done
                  </label>` : ''}
                ${mayEdit && !m.fromRegister ? `
                  <label class="sub" style="display:inline-flex;align-items:center;gap:6px;margin-left:12px;">
                    <input type="checkbox" ${c.deferred ? 'checked' : ''} style="width:auto;"
                      onchange="childSet(${si},${ci},'deferred',this.checked)"> defer to next meeting
                  </label>
                  ${carryBox(si, ci, c)}
                  <button class="btn btn-danger btn-sm" style="display:block;margin-top:8px;" onclick="childDel(${si},${ci})">Remove item</button>` : ''}
              </div>`).join('') : ''}
            ${m.container && !m.fromRegister && !m.generated && mayEdit ? `<button class="btn btn-secondary btn-sm" onclick="childAdd(${si})">+ Add ${m.roman ? 'other matter' : 'sub-item'}</button>` : ''}
            ${!m.container ? `<div class="field" style="margin-top:8px;"><label>Action (optional)</label>
              <input type="text" value="${esc(s.action || '')}" onchange="secSet(${si},'action',this.value)" ${mayEdit ? '' : 'disabled'}></div>
              ${mayEdit && !m.generated && !AUTO_NOTE[s.key] ? carryBox(si, -1, s) : ''}` : ''}
          ` : ''}
        </div>`;
      }).join('');
      placePicks();
      renderJump();
      if (keep && document.contains(keep.el) && document.activeElement !== keep.el) {
        try { keep.el.focus({ preventScroll: true }); if (keep.a != null && keep.el.setSelectionRange) keep.el.setSelectionRange(keep.a, keep.b); } catch (e) {}
      }
    }
    // The section bar: jump to a section's block.
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('.sec-jump-btn'); if (!b) return;
      const el = document.querySelector(`#secList [data-mi="${b.dataset.go}:-1"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    // ---- Motions (Oct 2026) ------------------------------------------------
    // A decision put as a motion is kept as a record — who moved it, who
    // seconded it, and whether it was carried — and prints as one sentence:
    // "Motion: X moved that …, and Y seconded the motion. The motion was carried."
    // The Decisions register reads these records directly.
    const MOTION_RESULTS = [['pending', 'Not yet put'], ['carried', 'Carried'], ['lost', 'Lost'], ['withdrawn', 'Withdrawn'], ['deferred', 'Deferred']];
    function motionsBlock(si, ci, c) {
      const list = c.motions || [];
      if (!list.length && !mayEdit) return '';
      const dis = mayEdit ? '' : 'disabled';
      const people = `<datalist id="motionPeople">${(pools.present || []).map(p => `<option value="${esc(p.name)}"></option>`).join('')}</datalist>`;
      return `<div class="motions" style="margin-top:8px;">
        ${list.map((mo, mi) => {
          const v = mo.votes || {};
          return `<div class="motion" style="border-left:3px solid var(--primary,#1f4e79);padding:6px 0 6px 10px;margin:6px 0;">
            <div class="field"><label>Motion ${list.length > 1 ? mi + 1 : ''} — that …</label>
              <textarea rows="2" placeholder="the final payment be released to the contractor" onchange="motionSet(${si},${ci},${mi},'text',this.value)" ${dis}>${esc(mo.text || '')}</textarea></div>
            <div class="row-2">
              <input type="text" list="motionPeople" value="${esc(mo.movedBy || '')}" placeholder="Moved by" onchange="motionSet(${si},${ci},${mi},'movedBy',this.value)" ${dis}>
              <input type="text" list="motionPeople" value="${esc(mo.secondedBy || '')}" placeholder="Seconded by" onchange="motionSet(${si},${ci},${mi},'secondedBy',this.value)" ${dis}>
            </div>
            <div class="row-2" style="margin-top:6px;align-items:center;">
              <select onchange="motionSet(${si},${ci},${mi},'result',this.value)" ${dis}>
                ${MOTION_RESULTS.map(([k, l]) => `<option value="${k}"${(mo.result || 'pending') === k ? ' selected' : ''}>${l}</option>`).join('')}
              </select>
              <span style="display:flex;gap:6px;align-items:center;">
                <input type="number" min="0" style="width:70px" value="${v.for ?? ''}" placeholder="For" title="Votes for" onchange="motionVote(${si},${ci},${mi},'for',this.value)" ${dis}>
                <input type="number" min="0" style="width:70px" value="${v.against ?? ''}" placeholder="Against" title="Votes against" onchange="motionVote(${si},${ci},${mi},'against',this.value)" ${dis}>
                <input type="number" min="0" style="width:70px" value="${v.abstain ?? ''}" placeholder="Abst." title="Abstentions" onchange="motionVote(${si},${ci},${mi},'abstain',this.value)" ${dis}>
                <label class="sub" style="display:inline-flex;gap:4px;align-items:center;"><input type="checkbox" style="width:auto;" ${mo.unanimous ? 'checked' : ''} onchange="motionSet(${si},${ci},${mi},'unanimous',this.checked)" ${dis}> unanimous</label>
              </span>
            </div>
            ${mayEdit ? `<button class="btn btn-danger btn-sm" style="margin-top:6px;" onclick="motionDel(${si},${ci},${mi})">Remove motion</button>` : ''}
          </div>`;
        }).join('')}
        ${mayEdit ? `<button class="btn btn-secondary btn-sm" onclick="motionAdd(${si},${ci})">+ Record a motion</button>${people}` : ''}
      </div>`;
    }
    function motionRow(si, ci) { const s = doc.sections[si]; return ci < 0 ? s : s.children[ci]; }
    function motionAdd(si, ci) { const r = motionRow(si, ci); (r.motions = r.motions || []).push({ text: '', movedBy: '', secondedBy: '', result: 'pending', votes: {} }); renderSections(); }
    function motionDel(si, ci, mi) { motionRow(si, ci).motions.splice(mi, 1); renderSections(); saveSection(si, true); }
    function motionSet(si, ci, mi, k, v) { motionRow(si, ci).motions[mi][k] = v; saveSection(si); }
    function motionVote(si, ci, mi, k, v) { const m = motionRow(si, ci).motions[mi]; m.votes = { ...(m.votes || {}), [k]: v === '' ? null : Number(v) }; saveSection(si); }

    // "Carry to Matters Arising": the item was discussed and is still open, so
    // it goes into the register of outstanding matters (or, if the register
    // already holds it from an earlier meeting, adds an update to it).
    function carryBox(si, ci, row) {
      const link = row && row.toMatters;
      return `<label class="sub" style="display:inline-flex;align-items:center;gap:6px;margin-left:12px;" title="Discussed, but still open: keep it in front of the Session under Matters Arising until it is closed">
        <input type="checkbox" ${link ? 'checked' : ''} style="width:auto;" onchange="carryToMatters(${si},${ci},this.checked,this)"> carry to Matters Arising
        ${link ? `<span class="badge badge-info" style="font-size:10.5px;">${link.kind === 'update' ? 'added as an update' : 'in the register'}</span>` : ''}
      </label>`;
    }
    async function carryToMatters(si, ci, on, box) {
      const s = doc.sections[si];
      const row = ci < 0 ? s : s.children[ci];
      try {
        await saveSection(si, true);   // so the register gets the text as it stands
        const r = await api(`/minutes/${doc.id}/to-matters`, { method: 'POST', body: { key: s.key, ci, on } });
        row.toMatters = r.toMatters || undefined;
        renderSections();
        toast(on ? (r.toMatters && r.toMatters.kind === 'update'
          ? `Added as an update to \u201c${r.matter ? r.matter.subject : 'the open matter'}\u201d in Matters Arising.`
          : 'Carried to Matters Arising.') : 'Taken back out of Matters Arising.');
      } catch (e) { if (box) box.checked = !on; toast(e.message, true); }
    }
    function polishBtn(call, key) {
      if (!mayEdit || !aiEnabled || AUTO_NOTE[key]) return '';
      return `<button class="btn btn-secondary btn-sm" style="margin-top:6px;" onclick="${call}">✨ Tidy into minute style</button>`;
    }
    // Each section saves on its own, so working on Correspondence can never
    // overwrite what was typed under Other Matters.
    const secTimers = {};
    function saveSection(i, immediate) {
      const sec = doc.sections[i];
      if (!sec || !mayEdit) return Promise.resolve();
      const send = async () => {
        try {
          await api(`/minutes/${doc.id}/section`, { method: 'PUT', body: {
            key: sec.key, enabled: sec.enabled, subject: sec.subject,
            body: sec.body, action: sec.action, children: sec.children || [],
            tidiedWords: sec.tidiedWords || 0, handChecked: !!sec.handChecked,
            rawNotes: sec.rawNotes, aiText: sec.aiText, tidiedAt: sec.tidiedAt,
          } });
          note('Saved');
        } catch (e) { note(''); toast(e.message, true); }
      };
      note('Saving…');
      clearTimeout(secTimers[sec.key]);
      if (immediate) return send();
      return new Promise(r => { secTimers[sec.key] = setTimeout(() => send().then(r), 600); });
    }
    function secToggle(i, on) { doc.sections[i].enabled = on; renderSections(); saveSection(i, true); }
    function secSet(i, k, v) { doc.sections[i][k] = v; saveSection(i); if (k === 'body') refreshTidyBadge(i, -1); }
    function childSet(i, j, k, v) {
      doc.sections[i].children = doc.sections[i].children || [];
      doc.sections[i].children[j] = doc.sections[i].children[j] || { subject: '', body: '', action: '' };
      doc.sections[i].children[j][k] = v;
      saveSection(i);
      if (k === 'body') refreshTidyBadge(i, j);
      if (k === 'action') renderSections();
    }
    function childAdd(i) { (doc.sections[i].children = doc.sections[i].children || []).push({ subject: '', body: '', action: '' }); renderSections(); saveSection(i, true); }
    function childDel(i, j) { doc.sections[i].children.splice(j, 1); renderSections(); saveSection(i, true); }

    // ------------------------------------------------------ tidy status
    // Every item that carries prose shows whether it has been through the
    // tidy-up. Short lines (under TIDY_MIN_WORDS) are left alone: "The District
    // Minister noted this." needs no second look. An item tidied and then
    // added to heavily counts as untidied again, because the addition is
    // usually more dictation. The clerk can instead tick "checked by hand".
    const TIDY_MIN_WORDS = 15, TIDY_DRIFT_WORDS = 20;
    function tidyWords(t) { return (String(t || '').match(/\S+/g) || []).length; }
    function tidyState(row) {
      const w = tidyWords(row && row.body);
      if (w < TIDY_MIN_WORDS) return 'short';
      if (row.handChecked) return 'checked';
      if (row.tidiedWords) return Math.abs(w - row.tidiedWords) > TIDY_DRIFT_WORDS ? 'changed' : 'tidied';
      return 'raw';
    }
    function tidyBadgeInner(row, si, ci) { return tidyBadgeHtml(row, `tidyHand(${si},${ci},this.checked)`); }
    function tidyBadgeHtml(row, onTick) {
      const st = tidyState(row);
      if (st === 'short') return '';
      const label = {
        tidied: '<span class="badge badge-done">✓ Tidied</span>',
        checked: '<span class="badge badge-done">✓ Checked by hand</span>',
        changed: '<span class="badge badge-attention">Added to a lot since it was tidied</span>',
        raw: '<span class="badge badge-attention">Not tidied yet</span>',
      }[st];
      const tick = mayEdit && st !== 'tidied' ? `
        <label class="sub" style="display:inline-flex;align-items:center;gap:6px;margin-left:10px;font-size:11.5px;">
          <input type="checkbox" ${row.handChecked ? 'checked' : ''} style="width:auto;" onchange="${onTick}"> checked by hand
        </label>` : '';
      return label + tick;
    }
    function tidyBadge(row, si, ci) {
      return `<span id="tidyBadge-${si}-${ci}" data-state="${tidyState(row)}|${row.handChecked ? 1 : 0}" style="display:inline-flex;align-items:center;margin:6px 0 0 8px;">${tidyBadgeInner(row, si, ci)}</span>`;
    }
    function refreshTidyBadge(si, ci) {
      const s = doc.sections[si];
      const row = ci < 0 ? s : (s.children || [])[ci];
      const el = document.getElementById(`tidyBadge-${si}-${ci}`);
      // Redrawn only when the state actually changes. Leaving the textarea
      // fires its change event on the same mousedown that ticks the box, and
      // redrawing then would swap the box out from under the click.
      const key = row ? `${tidyState(row)}|${row.handChecked ? 1 : 0}` : '';
      if (el && row && el.dataset.state !== key) { el.innerHTML = tidyBadgeInner(row, si, ci); el.dataset.state = key; }
      renderTidyCheck();
    }
    function tidyHand(si, ci, on) {
      const s = doc.sections[si];
      const row = ci < 0 ? s : (s.children || [])[ci];
      if (!row) return;
      row.handChecked = !!on;
      saveSection(si, true);
      refreshTidyBadge(si, ci);
    }
    // "What the Session said" under a letter, and the prayer points, are checked
    // the same way as the sections. The letter's own summary is not: it is
    // drafted from the letter, not from dictation.
    function corrRow(c) { return { body: c.deliberation || '', tidiedWords: c.delibTidiedWords || 0, handChecked: !!c.delibHandChecked }; }
    function corrTidyBadge(c) {
      const row = corrRow(c);
      return `<span id="corrTidy-${c.id}" data-state="${tidyState(row)}|${row.handChecked ? 1 : 0}" style="display:inline-flex;align-items:center;margin:6px 0 0 8px;">${tidyBadgeHtml(row, `corrTidyHand(${c.id},this.checked)`)}</span>`;
    }
    function refreshCorrTidy(id) {
      const c = corr.find(x => x.id === id);
      const el = document.getElementById(`corrTidy-${id}`);
      if (c && el) {
        const row = corrRow(c), key = `${tidyState(row)}|${row.handChecked ? 1 : 0}`;
        if (el.dataset.state !== key) { el.innerHTML = tidyBadgeHtml(row, `corrTidyHand(${id},this.checked)`); el.dataset.state = key; }
      }
      renderTidyCheck();
    }
    function corrTidyHand(id, on) {
      corrSet(id, 'delibHandChecked', !!on);
      writeCorr(id);
      refreshCorrTidy(id);
    }
    function prayerRow() {
      const pr = (doc && doc.proceedings && doc.proceedings.prayers) || {};
      const text = [...(pr.points || []), pr.note || ''].map(x => String(x || '').trim()).filter(Boolean).join(' ');
      return { body: text, tidiedWords: pr.tidiedWords || 0, handChecked: !!pr.handChecked };
    }
    function renderPrayerTidy() {
      const el = $('prayerTidy');
      if (!el || !doc) return;
      const row = prayerRow(), key = `${tidyState(row)}|${row.handChecked ? 1 : 0}`;
      if (el.dataset.state !== key) { el.innerHTML = tidyBadgeHtml(row, 'prayerTidyHand(this.checked)'); el.dataset.state = key; }
      renderTidyCheck();
    }
    function prayerTidyHand(on) {
      prayers().handChecked = !!on;
      savePrayers();
    }

    // Items still holding untidied prose, numbered as they will print.
    function untidiedItems() {
      const out = [];
      let n = 0;
      (doc && doc.sections || []).forEach((s, si) => {
        if (!s.enabled) return;
        n += 1;
        const m = SECTION_META[s.key] || {};
        if (AUTO_NOTE[s.key]) return;
        if (s.key === 'prayers') {
          const st = tidyState(prayerRow());
          if (st === 'raw' || st === 'changed') out.push({ no: `${n}.0`, subject: s.subject || 'Prayers', kind: 'prayers' });
        }
        if (s.key === 'correspondence') {
          corr.forEach((c, ci) => {
            const st = tidyState(corrRow(c));
            if (st === 'raw' || st === 'changed') out.push({ no: `${n}.${ci + 1}`, subject: (c.heading || 'Letter') + ' — what the Session said', kind: 'corr', id: c.id });
          });
          return;
        }
        if (!m.container) {
          const st = tidyState(s);
          if (st === 'raw' || st === 'changed') out.push({ no: `${n}.0`, subject: s.subject || '', si, ci: -1 });
          return;
        }
        if (m.fromRegister || m.generated) return;
        (s.children || []).forEach((c, ci) => {
          const st = tidyState(c);
          if (st === 'raw' || st === 'changed') out.push({ no: `${n}.${ci + 1}`, subject: c.subject || s.subject || '', si, ci });
        });
      });
      return out;
    }
    function tidyListText(list) { return list.map(x => `${x.no} ${x.subject}`.trim()).join('; '); }
    // Slips the proofreader should never have to mark (Oct 2026 — from the
    // proofreading of the 24 Sept minutes): a doubled word ("the the"), an
    // item starting with a small letter, a double space. Found by rule, not AI.
    function proofSlips() {
      const out = [];
      let n = 0;
      (doc && doc.sections || []).forEach(s => {
        if (!s.enabled) return;
        n += 1;
        const rows = (s.children || []).length ? s.children.map((c, ci) => ({ no: `${n}.${ci + 1}`, body: c.body })) : [{ no: `${n}.0`, body: s.body }];
        rows.forEach(r => {
          const t = String(r.body || '');
          if (!t.trim()) return;
          const dbl = t.match(/\b(\w+)\s+\1\b/i);
          if (dbl && !/^(that|had)$/i.test(dbl[1])) out.push(`${r.no}: \u201c${dbl[0]}\u201d`);
          t.split(/\n+/).forEach(par => { const p = par.trim(); if (/^[a-z]/.test(p)) out.push(`${r.no}: starts with a small letter (\u201c${p.slice(0, 20)}\u2026\u201d)`); });
          if (/[^\s] {2,}[^\s]/.test(t)) out.push(`${r.no}: a double space`);
        });
      });
      return out;
    }
    function renderTidyCheck() {
      const box = $('tidyCheck');
      if (!box || !doc) return;
      if (!tidyApplies()) { box.innerHTML = ''; return; }
      const list = untidiedItems();
      const slips = proofSlips();
      const slipHtml = slips.length ? `
        <div style="background:#FBF1DE;border-radius:8px;padding:10px 12px;margin:0 0 12px;">
          <b>Before it goes for proofreading \u2014 ${slips.length} slip${slips.length === 1 ? '' : 's'} to fix:</b>
          ${slips.map(esc).join('; ')}.
        </div>` : '';
      if (!list.length) {
        box.innerHTML = slipHtml + '<p class="sub" style="margin:0 0 10px;">✓ Every item with text has been tidied or checked by hand.</p>';
        return;
      }
      box.innerHTML = slipHtml + `
        <div style="background:#FBF1DE;border-radius:8px;padding:10px 12px;margin:0 0 12px;">
          <b>${list.length === 1 ? '1 item has' : list.length + ' items have'} not been tidied:</b>
          ${list.map(x => esc(`${x.no} ${x.subject}`)).join('; ')}.
          <div style="margin-top:8px;">
            ${mayEdit && aiEnabled ? '<button class="btn btn-secondary btn-sm" id="tidyAllBtn" onclick="tidyAllNow()">✨ Tidy them all now</button>' : ''}
            <span class="sub" style="font-size:11.5px;margin-left:6px;">Or open the item on the Minutes tab and tick “checked by hand”.</span>
          </div>
        </div>`;
    }
    async function tidyAllNow() {
      const list = untidiedItems();
      const btn = $('tidyAllBtn');
      if (btn) btn.disabled = true;
      let done = 0;
      for (const x of list) {
        if (btn) btn.textContent = `Tidying ${done + 1} of ${list.length}…`;
        const ok = x.kind === 'corr' ? await corrPolish(x.id)
          : x.kind === 'prayers' ? await prayerPolish()
          : x.ci < 0 ? await secPolish(x.si) : await childPolish(x.si, x.ci);
        if (!ok) break;   // the tidy-up failed and has already said why
        done += 1;
      }
      renderTidyCheck();
      if (done) toast(`Tidied ${done} item${done === 1 ? '' : 's'}. Read them through on the Minutes tab before you download.`);
    }
    // Asked before anything leaves the app with untidied text in it. Minutes
    // already final or adopted are past this point and are not asked about.
    function tidyApplies() { return !!doc && !doc.locked && doc.status !== 'final'; }
    async function tidyGate(what) {
      if (!tidyApplies()) return true;
      const list = untidiedItems();
      if (!list.length) return true;
      return confirmDialog(
        `${list.length === 1 ? '1 item has' : list.length + ' items have'} not been tidied: ${tidyListText(list)}. ${what} anyway?`,
        { title: 'Some items are not tidied', okText: `${what} anyway`, cancelText: 'Go back' });
    }

    // `lead` is the sentence the app writes for itself at the head of some
    // sections — the devotion, the constituting of the Session. It is sent so
    // the tidied notes carry on from it rather than repeating it.
    async function polish(text, subject, sectionKey, lead) {
      if (!String(text || '').trim()) { toast('Type your rough notes first.', true); return null; }
      note('Tidying…');
      try {
        const r = await api('/minutes/polish', {
          method: 'POST',
          body: { notes: text, subject, docId: doc.id, sectionKey: sectionKey || '', lead: lead || '' },
        });
        note('');
        // Much shorter than the notes means something was dropped. Ask before
        // the notes are replaced.
        if (r.suspectShort && !await confirmDialog(
          `The tidied text is much shorter than your notes (${r.outWords} words from ${r.inWords}). Something may have been left out.\n\nUse it anyway? (You can undo it afterwards.)`,
          { title: 'Check before replacing your notes', okText: 'Use it', cancelText: 'Keep my notes' })) return null;
        return r.text;
      } catch (e) { note(''); toast(e.message, true); return null; }
    }
    // The notes as they were before the last tidy-up are SAVED with the item
    // (rawNotes), with what the tidy-up returned (aiText) — so the notes can be
    // brought back at any time, even days later, and the versions compared.
    function rowAt(si, ci) { const s = doc.sections[si]; return ci < 0 ? s : (s.children || [])[ci]; }
    function undoBtn(si, ci) {
      const row = rowAt(si, ci);
      if (!row || typeof row.rawNotes !== 'string' || !row.rawNotes.trim() || !mayEdit || doc.locked) return '';
      const when = row.tidiedAt ? new Date(row.tidiedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
      return `<button class="btn btn-secondary btn-sm" style="margin:6px 0 0 6px;" onclick="tidyUndoNow(${si},${ci})" title="Your notes as you typed them, before the tidy-up${when ? ' of ' + when : ''}">\u21B6 My notes before tidy-up</button>`;
    }
    async function tidyUndoNow(si, ci) {
      const row = rowAt(si, ci);
      if (!row || typeof row.rawNotes !== 'string') return;
      const keep = await confirmDialog('Put your original notes back in place of the tidied text?\n\nThe tidied text is kept too: tidying again, or this button, can switch back.',
        { title: 'Back to my notes', okText: 'Put my notes back', cancelText: 'Cancel' });
      if (!keep) return;
      // Swap, so nothing is lost either way: the current text becomes the
      // "tidied" copy and the notes come back.
      const current = row.body;
      row.body = row.rawNotes; row.aiText = current; row.rawNotes = '';
      row.tidiedWords = 0; row.handChecked = false;
      renderSections(); renderTidyCheck();
      await saveSection(si, true);
      toast('Your notes are back as you typed them.');
    }
    async function secPolish(i) {
      const s = doc.sections[i];
      const before = s.body;
      const out = await polish(s.body, s.subject, s.key);
      // Tidying the tidy-up's own text again keeps the ORIGINAL notes.
      if (out) { if (!(s.rawNotes && before === s.aiText)) s.rawNotes = before; s.aiText = out; s.tidiedAt = new Date().toISOString(); }
      // Saved at once through the section's own endpoint. This used to call
      // queueSave(), which only writes the appendices — so tidied text sat in
      // the browser and was lost on reload unless something else in the same
      // section was edited afterwards.
      if (out) { s.body = out; s.tidiedWords = tidyWords(out); s.handChecked = false; renderSections(); renderTidyCheck(); await saveSection(i, true); return true; }
      return false;
    }
    async function childPolish(i, j) {
      const c = doc.sections[i].children[j];
      const before = c.body;
      const out = await polish(c.body, c.subject || doc.sections[i].subject, doc.sections[i].key);
      // Tidying the tidy-up's own text again keeps the ORIGINAL notes.
      if (out) { if (!(c.rawNotes && before === c.aiText)) c.rawNotes = before; c.aiText = out; c.tidiedAt = new Date().toISOString(); }
      if (out) { c.body = out; c.tidiedWords = tidyWords(out); c.handChecked = false; renderSections(); renderTidyCheck(); await saveSection(i, true); return true; }
      return false;
    }

    // -------------------------------------------------------- correspondence
    // Every letter is a silo. It owns its own pages, and a draft is only ever
    // built from the pages inside that one letter — so three sheets belonging
    // to one letter and two belonging to another are never read together.
    let corrSaveTimers = {};

    function pagesOfCorr(c) { return (c.files && c.files.length) ? c.files : (c.file ? [c.file] : []); }
    // Plain links to a letter's pages, for the correspondence register. It was
    // called here but never defined, so a register with any letter in it threw
    // and stayed empty (found 8 Oct 2026).
    function pageLinks(c, base) {
      const pages = pagesOfCorr(c);
      if (!pages.length) return '';
      return pages.map((f, i) => `<a class="btn btn-secondary btn-sm" href="${base}/file/${i}" target="_blank" rel="noopener">${pages.length > 1 ? `Page ${i + 1}` : 'Open the letter'}</a>`).join(' ');
    }

    // The pages of a letter, shown rather than listed. A photograph of a letter
    // is only useful if the clerk can see at a glance that he attached the right
    // sheet, and in the right order — a row of "Page 1, Page 2" chips does not
    // tell him that.
    function pageChips(c) {
      const pages = pagesOfCorr(c);
      if (!pages.length) return '<span class="sub" style="font-size:11.5px;">No pages attached yet.</span>';
      return pages.map((f, i) => {
        const url = `/api/minutes/correspondence/${c.id}/file/${i}`;
        const isPdf = /pdf/i.test(f.mimetype || '') || /\.pdf$/i.test(f.originalName || f.filename || '');
        const name = esc(f.originalName || `Page ${i + 1}`);
        const thumb = isPdf
          ? `<div class="pg-pdf"><span>PDF</span></div>`
          : `<img src="${url}" alt="Page ${i + 1} of this letter" loading="lazy">`;
        return `
          <figure class="pg">
            <a href="${url}" target="_blank" rel="noopener" title="Open ${name} full size">${thumb}</a>
            <figcaption>Page ${i + 1}</figcaption>
            ${mayEdit ? `<button type="button" class="pg-x" onclick="dropPage(${c.id},${i})" title="Remove this page" aria-label="Remove page ${i + 1}">✕</button>` : ''}
          </figure>`;
      }).join('');
    }

    // Suggestions only — the Action is free text, because the minutes name who
    // a letter goes to ("Referred to the Committee on Welfare").
    const ACTIONS = ['Approved', 'Not approved', 'Administrative', 'Acknowledged', 'Noted', 'To be announced', 'Deferred',
      'Referred to the Committee on Welfare', 'Forwarded to SMC', 'For decision'];

    // The Action is what the Session did with the letter, so nothing is put
    // there for the Clerk (Oct 2026). Empty — or still "For decision", which is
    // a letter waiting, not an outcome — is flagged here and asked about again
    // before the minutes are downloaded or circulated.
    const CORR_QUICK = ['Acknowledged', 'Noted', 'Approved', 'Not approved', 'To be announced', 'Administrative', 'Deferred'];
    const corrUnsettled = c => !String(c.action || '').trim() || /^for decision$/i.test(String(c.action || '').trim());
    function corrActionInner(c) {
      const need = corrUnsettled(c);
      const sug = String(c.actionSuggested || '').trim();
      return `<label>Action${need ? ' <span class="corr-need-tag">needed</span>' : ''}</label>
        <input type="text" list="corrActionList" id="corrAct${c.id}" class="${need && mayEdit ? 'corr-need' : ''}" value="${esc(c.action || '')}" placeholder="What did the Session do with this letter?"
          onchange="corrActionSet(${c.id}, this.value)" ${mayEdit ? '' : 'disabled'}>
        ${mayEdit && need ? `<div class="corr-quick">
          ${/^for decision$/i.test(String(c.action || '').trim()) ? '<div class="sub corr-need-note">“For decision” is the letter waiting — choose what the Session decided.</div>' : ''}
          ${sug && sug.toLowerCase() !== String(c.action || '').trim().toLowerCase() ? `<button type="button" class="corr-chip corr-chip-sug" onclick="corrActionSet(${c.id}, ${esc(JSON.stringify(sug))})" title="Claude’s reading of the letter — only a suggestion">Suggested: ${esc(sug)}</button>` : ''}
          ${CORR_QUICK.filter(a => a.toLowerCase() !== sug.toLowerCase()).map(a => `<button type="button" class="corr-chip" onclick="corrActionSet(${c.id}, '${a}')">${a}</button>`).join('')}
          <button type="button" class="corr-chip" onclick="corrActionSet(${c.id}, 'Referred to ', true)">Referred to …</button>
          <button type="button" class="corr-chip" onclick="corrActionSet(${c.id}, 'Forwarded to ', true)">Forwarded to …</button>
        </div>` : ''}`;
    }
    function corrActionSet(id, value, typeMore) {
      const c = corr.find(x => x.id === id);
      if (!c) return;
      if (!typeMore) corrSet(id, 'action', String(value || '').trim());
      else c.action = value;
      const box = $('corrActBox' + id);
      if (box) box.innerHTML = corrActionInner(c);
      if (typeMore) { const el = $('corrAct' + id); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }
    }

    // Letters linked to a visitors group (see minutes-visitors.js).
    function viaVisitors(id) {
      return ((doc.proceedings && doc.proceedings.visitors) || []).some(g => g && String(g.letterId || '') === String(id));
    }
    function renderCorrespondence() {
      $('corrList').innerHTML = (corr.length ? `<datalist id="corrActionList">${ACTIONS.map(a => `<option value="${esc(a)}"></option>`).join('')}</datalist>` : '') + (corr.length ? corr.map((c, idx) => {
        const n = pagesOfCorr(c).length;
        return `
        <div class="corr-card" data-cid="${c.id}">
          <div class="sec-head">
            <span class="sec-no">Letter ${idx + 1}</span>
            <span class="sec-title">${esc(c.heading || 'Untitled')}</span>
            ${c.draftedByAi ? '<span class="ai-badge">AI draft</span>' : ''}
          </div>
          ${viaVisitors(c.id) ? '<p class="sub" style="margin:0 0 8px;font-size:12px;">Brought by visitors — the Presentation item refers to this letter by its number. Put the full arrangements in the summary here.</p>' : ''}
          <div class="field-row">
            <div class="field"><label>Heading</label>
              <input type="text" value="${esc(c.heading || '')}" placeholder="e.g. Funeral Announcement"
                onchange="corrSet(${c.id},'heading',this.value)" ${mayEdit ? '' : 'disabled'}></div>
            <div class="field"><label>From</label>
              <input type="text" value="${esc(c.from || '')}" placeholder="e.g. Mrs Gladys Sasu Akuamoah"
                onchange="corrSet(${c.id},'from',this.value)" ${mayEdit ? '' : 'disabled'}></div>
          </div>
          <div class="field"><label>Summary (as it will read in the minutes)</label>
            <textarea rows="4" onchange="corrSet(${c.id},'summary',this.value)" ${mayEdit ? '' : 'disabled'}>${esc(c.summary || '')}</textarea></div>
          <div class="field-row">
            <div class="field" id="corrActBox${c.id}">${corrActionInner(c)}</div>
            <div class="field"><label>Date on the letter</label>
              <input type="date" value="${esc(c.letterDate || '')}"
                onchange="corrSet(${c.id},'letterDate',this.value)" ${mayEdit ? '' : 'disabled'}></div>
          </div>
          <div class="field">
            <label>What the Session said</label>
            <textarea rows="3" id="corrDelib${c.id}" placeholder="Anything said when the letter was read — who spoke, what was asked, what was resolved. Leave empty if the Action says it all."
              onchange="corrSet(${c.id},'deliberation',this.value)" ${mayEdit ? '' : 'disabled'}>${esc(c.deliberation || '')}</textarea>
            <p class="sub" style="margin:4px 0 0; font-size:11.5px;">Prints on the end of the summary above, as one paragraph — the way the minutes run them together.</p>
            ${mayEdit && aiEnabled ? `<button class="btn btn-secondary btn-sm" style="margin-top:6px;" onclick="corrPolish(${c.id})">✨ Tidy into minute style</button>` : ''}${corrTidyBadge(c)}
          </div>
          <div class="field">
            <label>This letter's pages${n ? ` — ${n}` : ''}</label>
            <div class="page-strip">${pageChips(c)}</div>
            ${mayEdit ? `
              <input type="file" class="pagesIn" data-cid="${c.id}" accept="image/*,application/pdf" multiple style="display:none;">
              <button class="btn btn-secondary btn-sm" style="margin-top:8px;" onclick="addPages(${c.id})">+ Attach pages to this letter</button>
              <span class="muted" id="pagesBusy${c.id}"></span>` : ''}
          </div>
          ${mayEdit ? `
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
              <button class="btn btn-primary btn-sm" onclick="draftOne(${c.id})" ${aiEnabled ? '' : 'disabled'}>
                ✨ Draft from ${n ? `${n} page${n === 1 ? '' : 's'}` : 'pasted text'}
              </button>
              <button class="btn btn-secondary btn-sm" onclick="togglePaste(${c.id})">Paste the text instead</button>
              <span class="muted" id="corrStatus${c.id}"></span>
            </div>
            <div class="field" id="corrPaste${c.id}" style="display:none; margin-top:8px;">
              <label>Letter text</label>
              <textarea rows="3" id="corrPasteText${c.id}" placeholder="Paste the wording of this letter."></textarea>
            </div>
            ${c.fromInbox ? `<button class="btn btn-secondary btn-sm" style="margin-top:10px;" onclick="returnLetter(${c.id})">Send back to the inbox</button>` : ''}
            <button class="btn btn-danger btn-sm" style="margin-top:10px;" onclick="delCorr(${c.id})">Remove this letter</button>
          ` : ''}
        </div>`;
      }).join('')
        : emptyState({ icon: 'mail', title: 'No letters for this meeting yet', text: 'Bring them in from the Correspondence Inbox, or add one here.', action: '+ Add a letter', click: 'corrAddBtn' }));
    }

    // ---- From the correspondence inbox ---------------------------------------
    // Letters the Administrator has scanned in and the Clerk has sorted "for the
    // Session" wait in the inbox until they are brought into a set of minutes.
    // Bringing one in moves it here; "Send back to the inbox" moves it out again
    // (deferred, or brought in by mistake). Letters already recorded in these
    // minutes are never touched by any of this.
    let inboxWaiting = [], inboxToSort = 0;
    async function loadInbox() {
      if (!mayEdit) { renderWaiting(); return; }
      try {
        const d = await api('/minutes/correspondence/inbox');
        inboxWaiting = (d.letters || []).filter(c => c.status === 'session');
        inboxToSort = (d.counts && d.counts.new) || 0;
      } catch (e) { inboxWaiting = []; inboxToSort = 0; }
      renderWaiting();
    }
    function renderWaiting() {
      const box = $('corrWaiting');
      if (!box) return;
      if (!mayEdit || (!inboxWaiting.length && !inboxToSort)) { box.innerHTML = ''; return; }
      const toSort = inboxToSort
        ? `<p class="sub" style="margin:6px 0 0;font-size:12px;">${inboxToSort} more in the <a href="/correspondence.html">inbox</a> still to be sorted.</p>` : '';
      if (!inboxWaiting.length) { box.innerHTML = `<div class="card" style="margin-bottom:14px;">${toSort}</div>`; return; }
      box.innerHTML = `
        <div class="card" style="margin-bottom:14px;">
          <b>${inboxWaiting.length} letter${inboxWaiting.length === 1 ? '' : 's'} waiting for the Session</b>
          <p class="sub" style="margin:2px 0 8px;font-size:12px;">Tick the ones read at this meeting. They move into these minutes, in the order received.</p>
          ${inboxWaiting.map(c => `
            <label style="display:flex;gap:9px;align-items:flex-start;padding:7px 0;border-top:1px solid var(--line,#e6e9f0);">
              <input type="checkbox" class="bringPick" value="${c.id}" checked style="width:auto;margin-top:3px;">
              <span><b>${esc(c.heading || 'Untitled')}</b>${c.from ? ' — ' + esc(c.from) : ''}
                <span class="sub" style="display:block;font-size:11.5px;">${c.receivedOn ? 'Received ' + esc(fmtDate(c.receivedOn)) : ''}${c.action ? ' · ' + esc(c.action) : ''}</span></span>
            </label>`).join('')}
          <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:8px;">
            <button class="btn btn-primary btn-sm" onclick="bringLetters()">Bring into these minutes</button>
            <button class="btn btn-secondary btn-sm" onclick="exportWaiting()" title="Export the ticked letters as PDF or Word, e.g. to send ahead of the meeting">Export the ticked ones</button>
          </div>
          ${toSort}
        </div>`;
    }
    function exportWaiting() {
      const ids = [...document.querySelectorAll('#corrWaiting .bringPick:checked')].map(x => Number(x.value));
      if (!ids.length) { toast('Tick at least one letter.', true); return; }
      openCorrExport({ scope: 'waiting', ids }, 'the letters for the Session');
    }
    async function bringLetters() {
      const ids = [...document.querySelectorAll('#corrWaiting .bringPick:checked')].map(x => Number(x.value));
      if (!ids.length) { toast('Tick at least one letter.', true); return; }
      try {
        const r = await api(`/minutes/${doc.id}/correspondence/bring`, { method: 'POST', body: { ids } });
        corr = r.correspondence || corr;
        renderCorrespondence(); renderSections(); renderTidyCheck();
        toast(`Brought in ${r.brought.length} letter${r.brought.length === 1 ? '' : 's'}.`);
        loadInbox();
      } catch (e) { toast(e.message, true); }
    }
    async function returnLetter(id) {
      if (!await confirmDialog('Send this letter back to the inbox? It leaves these minutes and waits for the next meeting.', { okText: 'Send back' })) return;
      try {
        await api(`/minutes/correspondence/${id}/return`, { method: 'POST' });
        corr = corr.filter(c => c.id !== id);
        renderCorrespondence(); renderSections(); renderTidyCheck();
        loadInbox();
      } catch (e) { toast(e.message, true); }
    }

    // Field edits autosave against that letter alone.
    // The rough note of what was said, tidied into minute prose — the same
    // polish the sections use, and it never touches the letter's own summary.
    async function corrPolish(id) {
      const c = corr.find(x => x.id === id);
      if (!c) return;
      const out = await polish(c.deliberation, c.heading || 'Correspondence');
      if (!out) return false;
      c.deliberation = out;
      const box = $('corrDelib' + id);
      if (box) box.value = out;
      corrSet(id, 'deliberation', out);
      corrSet(id, 'delibTidiedWords', tidyWords(out));
      corrSet(id, 'delibHandChecked', false);
      await writeCorr(id);
      refreshCorrTidy(id);
      renderSections();
      return true;
    }
    // Fields waiting to be written, per letter. They ACCUMULATE: the debounce is
    // one timer per letter, so sending only the last field edited would drop the
    // heading when the summary was typed straight after it.
    const corrPending = {};
    function corrSet(id, key, value) {
      const c = corr.find(x => x.id === id);
      if (!c) return;
      c[key] = value;
      if (key === 'deliberation') refreshCorrTidy(id);
      corrPending[id] = { ...(corrPending[id] || {}), [key]: value };
      note('Saving…');
      clearTimeout(corrSaveTimers[id]);
      corrSaveTimers[id] = setTimeout(() => writeCorr(id), 600);
    }
    async function writeCorr(id) {
      const body = corrPending[id];
      if (!body || !Object.keys(body).length) return;
      delete corrPending[id];
      clearTimeout(corrSaveTimers[id]);
      try {
        await api('/minutes/correspondence/' + id, { method: 'PUT', body });
        note('Saved');
        renderSections();
      } catch (e) {
        note(''); toast(e.message, true);
      }
    }

    $('corrExportBtn').addEventListener('click', () => {
      if (!doc) return;
      openCorrExport({ scope: 'minutes', id: doc.id }, 'the letters read at this meeting');
    });
    $('corrAddBtn').addEventListener('click', async () => {
      if (!mayEdit) return;
      const fd = new FormData();
      fd.append('heading', '');
      try {
        const res = await fetch(`/api/minutes/${doc.id}/correspondence`, { method: 'POST', body: fd, credentials: 'same-origin' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Could not add the letter.');
        corr.push(d);
        renderCorrespondence(); renderSections();
        toast('Letter added — attach its pages, then draft.');
      } catch (e) { toast(e.message, true); }
    });

    // Which letter a photograph belongs to is carried by the input itself, not
    // by a variable. On a phone, taking a picture can put the browser to sleep
    // and reload the page behind the camera; a remembered target is gone by the
    // time the file comes back, and the upload used to be dropped in silence —
    // which is why the first attempt failed and the second worked.
    function inputFor(id) {
      return document.querySelector(`.pagesIn[data-cid="${id}"]`);
    }
    function addPages(id) {
      const el = inputFor(id);
      if (!el) { toast('That letter is no longer on the page — reload and try again.', true); return; }
      el.click();
    }
    async function uploadPages(cid, files, busyEl) {
      const fd = new FormData();
      files.forEach(f => fd.append('letter', f));
      const many = files.length === 1 ? 'page' : 'pages';
      if (busyEl) busyEl.textContent = `Attaching ${files.length} ${many}…`;
      try {
        const res = await fetch(`/api/minutes/correspondence/${cid}/pages`, { method: 'POST', body: fd, credentials: 'same-origin' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Could not attach the pages.');
        const i = corr.findIndex(c => c.id === cid);
        if (i >= 0) corr[i] = d;
        renderCorrespondence();
        toast(`Attached ${files.length} ${many} to this letter.`);
      } catch (err) {
        if (busyEl) busyEl.textContent = '';
        toast(err.message, true);          // never fail in silence
      }
    }
    // One listener for the whole list, so cards re-rendered later still work.
    $('corrList').addEventListener('change', e => {
      const el = e.target;
      if (!el.classList || !el.classList.contains('pagesIn')) return;
      const files = [...el.files];
      const cid = Number(el.dataset.cid);
      el.value = '';                        // so the same photo can be picked again
      if (!files.length) return;
      if (!cid) { toast('Could not tell which letter that belongs to — try again.', true); return; }
      uploadPages(cid, files, $('pagesBusy' + cid));
    });

    async function dropPage(id, idx) {
      if (!await confirmDialog('Remove this page from the letter?')) return;
      try {
        const d = await api(`/minutes/correspondence/${id}/pages/${idx}`, { method: 'DELETE' });
        const i = corr.findIndex(c => c.id === id);
        if (i >= 0) corr[i] = d;
        renderCorrespondence();
      } catch (e) { toast(e.message, true); }
    }

    function togglePaste(id) {
      const box = $('corrPaste' + id);
      box.style.display = box.style.display === 'none' ? '' : 'none';
    }

    // Drafts from THIS letter's pages only.
    async function draftOne(id) {
      const c = corr.find(x => x.id === id);
      if (!c) return;
      const pasteEl = $('corrPasteText' + id);
      const text = pasteEl ? pasteEl.value.trim() : '';
      const n = pagesOfCorr(c).length;
      if (!n && !text) { toast('Attach this letter’s pages first, or paste its text.', true); return; }
      const st = $('corrStatus' + id);
      st.textContent = n ? `Reading ${n} page${n === 1 ? '' : 's'}…` : 'Reading…';
      try {
        const d = await api(`/minutes/correspondence/${id}/draft`, { method: 'POST', body: { text } });
        Object.assign(c, {
          heading: d.heading || c.heading,
          summary: d.summary || c.summary,
          from: d.from || c.from,
          action: d.action || c.action,
          actionSuggested: d.actionSuggested || '',
          letterDate: d.letterDate || c.letterDate,
          draftedByAi: true,
        });
        await api('/minutes/correspondence/' + id, {
          method: 'PUT',
          body: { heading: c.heading, summary: c.summary, from: c.from, action: c.action, actionSuggested: c.actionSuggested, letterDate: c.letterDate, draftedByAi: true },
        });
        renderCorrespondence(); renderSections();
        toast(corrUnsettled(c) ? 'Draft ready — check it against the letter, then choose the Action.' : 'Draft ready — please check it against the letter.');
      } catch (e) {
        st.textContent = '';
        toast(e.message, true);
      }
    }

    async function delCorr(id) {
      if (!await confirmDialog('Remove this letter and its pages from the minutes?')) return;
      try {
        await api('/minutes/correspondence/' + id, { method: 'DELETE' });
        corr = corr.filter(c => c.id !== id);
        renderCorrespondence(); renderSections();
      } catch (e) { toast(e.message, true); }
    }

    // -------------------------------------------------------------- finance
    function finance() {
      if (!doc.finance) doc.finance = { asOf: doc.date, accounts: null, values: {}, stated: {} };
      if (!doc.finance.accounts || !doc.finance.accounts.length) {
        doc.finance.accounts = [
          { key: 'gcb', label: 'GCB' }, { key: 'ecobank', label: 'ECOBANK' },
          { key: 'nib', label: 'NIB' }, { key: 'welfare', label: 'GCB (WELFARE)' },
        ];
      }
      return doc.finance;
    }
    function renderFinance() {
      const f = finance();
      $('finAsOf').value = f.asOf || doc.date || '';
      $('finStOpening').value = f.stated && f.stated.opening != null ? f.stated.opening : '';
      $('finStPayments').value = f.stated && f.stated.payments != null ? f.stated.payments : '';
      $('finStClosing').value = f.stated && f.stated.closing != null ? f.stated.closing : '';
      const head = `<thead><tr><th></th>${f.accounts.map(a => `<th style="text-align:right;">${esc(a.label)}</th>`).join('')}<th style="text-align:right;">TOTAL</th></tr></thead>`;
      const val = (r, k) => { const v = ((f.values || {})[r] || {})[k]; return v == null ? '' : v; };
      const rowTotal = r => f.accounts.reduce((s, a) => s + (Number(val(r, a.key)) || 0), 0);
      const body = FIN_ROWS.map(r => `
        <tr>
          <td><b>${esc(r.label)}</b></td>
          ${f.accounts.map(a => `<td><input type="text" data-num style="text-align:right;min-width:92px;"
             value="${val(r.key, a.key)}" onchange="finSet('${r.key}','${a.key}',this.value)" ${mayEdit ? '' : 'disabled'}></td>`).join('')}
          <td style="text-align:right;" class="mono">${money(rowTotal(r.key))}</td>
        </tr>`).join('');
      // Derived rows, shown so the clerk sees exactly what will print.
      const der = (label, fn) => `<tr style="background:rgba(29,63,148,.06);">
          <td><b>${label}</b></td>
          ${f.accounts.map(a => `<td style="text-align:right;" class="mono">${money(fn(a.key))}</td>`).join('')}
          <td style="text-align:right;" class="mono"><b>${money(f.accounts.reduce((s, a) => s + fn(a.key), 0))}</b></td>
        </tr>`;
      const num = v => Number(String(v == null ? '' : v).replace(/[, ]/g, '')) || 0;
      const sub = k => num(val('opening', k)) + num(val('cash', k)) + num(val('chequeDt', k)) + num(val('momo', k));
      const close = k => sub(k) - num(val('payments', k));
      $('finTable').innerHTML = head + '<tbody>' + body + der('Sub-total (computed)', sub) + der('CLOSING BALANCE (computed)', close) + '</tbody>';
      if (window.attachNumFormatting) window.attachNumFormatting($('finTable'));
      renderFinWarnings(sub, close, num, val, f);
    }
    function renderFinWarnings(sub, close, num, val, f) {
      const out = [];
      const st = f.stated || {};
      const cmp = (label, stated, computed) => {
        if (stated == null || stated === '') return;
        if (Math.abs(num(stated) - computed) > 0.005) {
          out.push(`${label}: the statement shows ${money(stated)} but these figures come to ${money(computed)}.`);
        }
      };
      cmp('Opening balance total', st.opening, f.accounts.reduce((s, a) => s + num(val('opening', a.key)), 0));
      cmp('Payments total', st.payments, f.accounts.reduce((s, a) => s + num(val('payments', a.key)), 0));
      cmp('Closing balance total', st.closing, f.accounts.reduce((s, a) => s + close(a.key), 0));
      $('finWarn').innerHTML = out.length
        ? out.map(w => `<div class="badge badge-critical" style="display:block;margin-bottom:6px;padding:7px 10px;">⚠ ${esc(w)}</div>`).join('')
        : '';
    }
    function finSet(row, acct, v) {
      const f = finance();
      f.values = f.values || {};
      f.values[row] = f.values[row] || {};
      const s = String(v).replace(/[, ]/g, '').trim();
      if (s === '') delete f.values[row][acct];
      else f.values[row][acct] = Number(s) || 0;
      renderFinance();
    }
    ['finStOpening', 'finStPayments', 'finStClosing'].forEach(id => {
      $(id).addEventListener('change', () => {
        const f = finance();
        f.stated = f.stated || {};
        const key = id === 'finStOpening' ? 'opening' : id === 'finStPayments' ? 'payments' : 'closing';
        const v = $(id).value.replace(/[, ]/g, '').trim();
        f.stated[key] = v === '' ? null : Number(v) || 0;
        renderFinance();
      });
    });
    $('finAsOf').addEventListener('change', () => { finance().asOf = $('finAsOf').value; });
    $('finSaveBtn').addEventListener('click', async () => {
      try {
        const r = await api(`/minutes/${doc.id}/finance`, { method: 'PUT', body: finance() });
        doc.finance = r.finance;
        const full = await api('/minutes/' + doc.id);
        doc.sections = full.doc.sections;
        renderSections(); renderFinance();
        toast(r.warnings && r.warnings.length ? 'Saved — but check the flagged totals.' : 'Figures saved.');
      } catch (e) { toast(e.message, true); }
    });

    let finPending = [];
    $('finDrop').addEventListener('click', () => $('finFile').click());
    $('finFile').addEventListener('change', e => {
      finPending = [...e.target.files];
      $('finDropText').textContent = finPending.length
        ? `📎 ${finPending.length} page${finPending.length === 1 ? '' : 's'} attached`
        : '📄 Tap to choose a photo or PDF of the statement';
    });
    $('finReadBtn').addEventListener('click', async () => {
      if (!finPending.length) { toast('Choose a photo or PDF of the statement first.', true); return; }
      const fd = new FormData();
      finPending.forEach(f => fd.append('statement', f));
      $('finReadStatus').textContent = 'Reading the statement…';
      $('finReadBtn').disabled = true;
      try {
        const res = await fetch(`/api/minutes/${doc.id}/finance/read`, { method: 'POST', body: fd, credentials: 'same-origin' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Could not read the statement.');
        $('finReadStatus').textContent = '';
        showRead(d);
      } catch (e) { $('finReadStatus').textContent = ''; toast(e.message, true); }
      finally { $('finReadBtn').disabled = !aiEnabled; }
    });
    function showRead(d) {
      const g = d.grid;
      const rows = g.rows.map(r => `<tr>${r.map((c, i) => `<td style="${i ? 'text-align:right;' : ''}">${esc(c)}</td>`).join('')}</tr>`).join('');
      $('finReadResult').innerHTML = `
        <p class="sub"><b>Check every figure against the photograph before you accept it.</b> The totals below were worked out by the app, not read off the page.</p>
        ${(d.unreadable || []).length ? `<div class="badge badge-critical" style="display:block;padding:8px 10px;margin-bottom:8px;">Could not read with confidence: ${esc((d.unreadable || []).join('; '))}</div>` : ''}
        ${(d.warnings || []).map(w => `<div class="badge badge-critical" style="display:block;padding:7px 10px;margin-bottom:6px;">⚠ ${esc(w)}</div>`).join('')}
        <div style="overflow-x:auto;"><table style="min-width:520px;">
          <thead><tr>${g.head.map((h, i) => `<th style="${i ? 'text-align:right;' : ''}">${esc(h)}</th>`).join('')}</tr></thead>
          <tbody>${rows}</tbody></table></div>
        <button class="btn btn-primary btn-sm" style="margin-top:10px;" onclick='acceptRead()'>Accept these figures into the table</button>`;
      window._lastRead = d.read;
    }
    function acceptRead() {
      const r = window._lastRead;
      if (!r) return;
      const f = finance();
      f.values = r.values || {};
      f.stated = r.stated || {};
      if (r.asOf) f.asOf = r.asOf;
      $('finReadResult').innerHTML = '';
      renderFinance();
      document.querySelector('.mtab[data-pane="finance"]').click();
      toast('Figures copied in — review them, then press “Save figures”.');
    }

    // Accounts (columns)
    $('finAccountsBtn').addEventListener('click', () => { renderAccts(); $('acctOverlay').style.display = 'flex'; });
    $('acctCancel').addEventListener('click', () => $('acctOverlay').style.display = 'none');
    let acctDraft = [];
    function renderAccts() {
      if (!acctDraft.length) acctDraft = finance().accounts.map(a => ({ ...a }));
      $('acctRows').innerHTML = acctDraft.map((a, i) => `
        <div style="display:flex;gap:8px;margin-bottom:6px;">
          <input type="text" value="${esc(a.label)}" onchange="acctSet(${i},this.value)" style="flex:1;">
          <button class="btn btn-danger btn-sm" onclick="acctDel(${i})">✕</button>
        </div>`).join('');
    }
    function acctSet(i, v) { acctDraft[i].label = v; }
    function acctDel(i) { acctDraft.splice(i, 1); renderAccts(); }
    $('acctAddBtn').addEventListener('click', () => { acctDraft.push({ key: 'acct' + Date.now().toString(36), label: '' }); renderAccts(); });
    $('acctSave').addEventListener('click', () => {
      const list = acctDraft.filter(a => (a.label || '').trim())
        .map(a => ({ key: a.key || a.label.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20), label: a.label.trim() }));
      if (!list.length) { toast('Keep at least one account.', true); return; }
      finance().accounts = list;
      acctDraft = [];
      $('acctOverlay').style.display = 'none';
      renderFinance();
    });

    // ------------------------------------------------------------ documents
    function renderDocs() {
      $('dlMinDocx').href = `/api/minutes/${doc.id}/minutes.docx`;
      $('dlMinPdf').href = `/api/minutes/${doc.id}/minutes.pdf`;
      $('dlAgDocx').href = `/api/minutes/${doc.id}/agenda.docx`;
      $('dlAgPdf').href = `/api/minutes/${doc.id}/agenda.pdf`;
      $('statusText').textContent = doc.locked
        ? 'Adopted by the Session — this is the signed record and can no longer be altered.'
        : doc.status === 'final'
          ? `Marked final${doc.finalisedBy ? ' by ' + doc.finalisedBy : ''}. Reopen to make further changes.`
          : 'These minutes are a draft — you can still edit every section.';
      const bits = [];
      // No adoption date, by design — see the note in routes/minutes.js.
      if (doc.adopted) bits.push(`Adopted by the Session — moved by ${doc.adopted.movedBy} and seconded by ${doc.adopted.secondedBy}.`);
      if (doc.confirmation) bits.push(`Confirmed by ${doc.confirmation.byName}.`);
      $('adoptNote').textContent = bits.join(' ');
      $('adoptNote').style.display = bits.length ? '' : 'none';
      $('finaliseBtn').style.display = (doc.status === 'final' || doc.locked) ? 'none' : '';
      $('reopenBtn').style.display = (doc.status === 'final' && !doc.locked) ? '' : 'none';
      $('adoptBtn').style.display = previous && !previous.adopted ? '' : 'none';
      $('confirmBtn').style.display = mayConfirm && !doc.confirmation ? '' : 'none';
      renderVersions();
      renderAppendices();
      renderTidyCheck();
      loadProofreads();
    }

    // ---------------------------------------------------------- proofreading
    // The proofreader's tracked changes and comments, brought back into the
    // minutes. See routes/minutes.js "Proofreading".
    let proofreads = [];
    async function loadProofreads() {
      if (!$('prCard')) return;
      $('prUploadBtn').style.display = mayEdit && !doc.locked ? '' : 'none';
      try { proofreads = await api(`/minutes/${doc.id}/proofreads`); } catch (e) { proofreads = []; }
      renderProofread();
    }
    function prDiff(segs, before) {
      if (!segs) return esc(before || '');
      return segs.map(x => x.mode === 'ins' ? `<ins>${esc(x.text)}</ins>` : x.mode === 'del' ? `<del>${esc(x.text)}</del>` : esc(x.text)).join('');
    }
    const PR_LABEL = { pending: '', accepted: '\u2713 accepted', rejected: 'rejected', 'done-by-hand': '\u2713 you changed it yourself', applied: '\u2713 applied', merged: '\u2713 merged into your wording', 'no-change': '\u2713 no change' };
    function prWhere(at) {
      if (!at || at.match === 'none') return '<span class="pr-meta">written from the meeting details, or not found \u2014 change it by hand</span>';
      return `<span class="pr-meta">Item ${esc(at.no)} ${esc(at.subject || '')}${at.match === 'close' ? ' \u2014 edited since export: apply by hand' : ''}</span>`;
    }
    // One list in the order of the minutes, grouped by item, changes and
    // comments together. Every decision can be undone; the accepted text is
    // shown clean; "Go to item" opens the Minutes tab at that item.
    let prOnlyLeft = false;
    const prPreview = new Set();
    // Word-by-word difference between two versions of a paragraph: removed
    // words struck through, added words marked. Used to show what changed in
    // the app since the minutes went for proofreading.
    function prWordDiff(a, b) {
      const A = String(a || '').split(/(\s+)/).filter(x => x !== ''), B = String(b || '').split(/(\s+)/).filter(x => x !== '');
      if (A.length * B.length > 250000) return `<del>${esc(a)}</del> <ins>${esc(b)}</ins>`;
      const L = Array.from({ length: A.length + 1 }, () => new Uint16Array(B.length + 1));
      for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      const out = []; let i = 0, j = 0;
      const push = (mode, t) => { const last = out[out.length - 1]; if (last && last.mode === mode) last.t += t; else out.push({ mode, t }); };
      while (i < A.length && j < B.length) {
        if (A[i] === B[j]) { push('', A[i]); i++; j++; }
        else if (L[i + 1][j] >= L[i][j + 1]) { push('del', A[i]); i++; }
        else { push('ins', B[j]); j++; }
      }
      while (i < A.length) push('del', A[i++]);
      while (j < B.length) push('ins', B[j++]);
      return out.map(x => (x.mode === 'del' ? `<del>${esc(x.t)}</del>` : x.mode === 'ins' ? `<ins>${esc(x.t)}</ins>` : esc(x.t))).join('');
    }
    function prMark(paragraph, anchor) {
      const p = String(paragraph || '');
      const a = String(anchor || '').trim();
      if (!p) return a ? `<mark>${esc(a)}</mark>` : '';
      const i = a ? p.toLowerCase().indexOf(a.toLowerCase()) : -1;
      if (i < 0) return esc(p) + (a ? ` <span class="pr-meta">(on “${esc(a)}”)</span>` : '');
      return esc(p.slice(0, i)) + `<mark>${esc(p.slice(i, i + a.length))}</mark>` + esc(p.slice(i + a.length));
    }
    function prGo(at, ref) {
      if (!at || at.match === 'none' || !at.key) return '';
      return `<button class="btn btn-link btn-sm pr-go" onclick="prGoTo('${esc(at.key)}',${Number(at.ci)},'${esc(ref || '')}')">Go to item ${esc(at.no || '')} →</button>`;
    }
    // "Go to item" leaves a way back: a floating "Back to proofreading" button,
    // and the phone's Back button, both return to the card you came from.
    let prReturn = null;
    function prBackPill(show) {
      let b = $('prBackPill');
      if (!b && show) {
        b = document.createElement('button');
        b.id = 'prBackPill'; b.type = 'button'; b.className = 'pr-back-pill';
        b.textContent = '← Back to proofreading';
        b.addEventListener('click', prBack);
        document.body.appendChild(b);
      }
      if (b) b.style.display = show ? '' : 'none';
    }
    function prBack() {
      if (!prReturn) { prBackPill(false); return; }
      if (history.state && history.state.prGo) { history.back(); return; }   // popstate does the rest
      prReturnNow();
    }
    function prReturnNow() {
      const ret = prReturn; prReturn = null; prBackPill(false);
      if (!ret) return;
      const tab = document.querySelector('.mtab[data-pane="docs"]');
      if (tab) tab.click();
      setTimeout(() => {
        const card = ret.ref && document.querySelector(`[data-pr="${ret.ref}"]`);
        if (card) {
          card.scrollIntoView({ block: 'center' });
          card.classList.add('pr-flash');
          setTimeout(() => card.classList.remove('pr-flash'), 2200);
        } else window.scrollTo(0, ret.y || 0);
      }, 60);
    }
    window.addEventListener('popstate', () => { if (prReturn) prReturnNow(); });
    function prGoTo(key, ci, ref) {
      prGoTarget('body', [`[data-mi="${key}:${ci}"]`, `[data-mi="${key}:-1"]`], ref);
    }
    // Open a tab, scroll to the first of `sels` that exists, flash it, and
    // leave the "Back to proofreading" way back.
    function prGoTarget(pane, sels, ref) {
      const y = window.scrollY;
      const tab = document.querySelector(`.mtab[data-pane="${pane}"]`);
      if (tab) tab.click();
      prReturn = { ref, y };
      try { history.pushState({ prGo: 1 }, ''); } catch (e) {}
      prBackPill(true);
      setTimeout(() => {
        let el = null;
        for (const sel of [].concat(sels)) { el = document.querySelector(sel); if (el) break; }
        if (!el) { toast('Could not find that on the page.', true); return; }
        // A single field is shown with its whole box, so the context is visible.
        const box = el.closest('.field, .rev, .corr-card, .card') || el;
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
        box.classList.add('pr-flash');
        setTimeout(() => box.classList.remove('pr-flash'), 2200);
        if (el.matches('input, textarea, select')) setTimeout(() => { try { el.focus({ preventScroll: true }); } catch (e) {} }, 500);
      }, 60);
    }
    // Text the app writes itself (devotion, constituting, review of minutes,
    // a letter, closure…) cannot be changed on the Minutes tab item — it comes
    // from a field somewhere else. Work out which, from the text.
    const prSources = [];
    function prSource(text) {
      const t = String(text || '').toLowerCase().replace(/\s+/g, ' ');
      const words = s => new Set(String(s || '').toLowerCase().split(/[^a-z0-9']+/).filter(w => w.length > 3));
      const sim = (a, b) => { const A = words(a), B = words(b); if (!A.size || !B.size) return 0; let k = 0; A.forEach(w => { if (B.has(w)) k += 1; }); return (2 * k) / (A.size + B.size); };
      // A letter: the closest correspondence summary.
      let best = null, score = 0;
      (corr || []).forEach(c => { const sc = sim(c.summary || c.heading || '', text); if (sc > score) { score = sc; best = c; } });
      if (best && score >= 0.5) return { pane: 'corr', sels: [`[data-cid="${best.id}"]`, '#corrList'], label: 'Open the letter on the Correspondence tab' };
      // A correction made under Review of Minutes.
      const revs = (doc && doc.reviews) || [];
      const ri = revs.findIndex(r => sim(JSON.stringify(r.corrections || []), text) >= 0.5);
      if (ri >= 0 || /amended to|was added to item|were reviewed|was reviewed|adoption of|adopted as/.test(t)) {
        return { pane: 'body', sels: [ri >= 0 ? `[data-rev="${ri}"]` : '#reviewList', '#reviewList'], label: 'Open Review of Minutes' };
      }
      if (/constituted the session/.test(t)) return { pane: 'body', sels: ['#pConstitutedBy', '#pConstitutedAt'], label: 'Open the constitution details' };
      if (/commenced at|in devotion|led the session in/.test(t)) return { pane: 'body', sels: ['#pCommenced', '#pDevotionBy'], label: 'Open the opening & devotion details' };
      if (/closure|benediction|the grace|closed at/.test(t)) return { pane: 'body', sels: ['#pCloseMoved', '#closurePreview'], label: 'Open the closure details' };
      if (/presentation|presented|visitor/.test(t)) return { pane: 'body', sels: ['#visitorsField'], label: 'Open the visitors to the Session' };
      if (/pray/.test(t)) return { pane: 'body', sels: ['#prayerPoints', '#pPrayerNote'], label: 'Open the prayers' };
      return { pane: 'body', sels: ['#secList'], label: 'Open the Minutes tab' };
    }
    function prSourceBtn(text, ref) {
      const src = prSource(text);
      prSources.push(src);
      return `<button class="btn btn-link btn-sm pr-go" onclick="prGoSource(${prSources.length - 1},'${esc(ref || '')}')">${esc(src.label)} →</button>`;
    }
    function prGoSource(i, ref) { const src = prSources[i]; if (src) prGoTarget(src.pane, src.sels, ref); }
    function prToggleLeft(on) { prOnlyLeft = on; renderProofread(); }
    // "Why?" (Oct 2026): the Clerk types the idea behind a correction. It becomes
    // a house-style rule at once and is carried through these minutes too.
    const prWhyOpen = new Set();
    const prWhyDraft = {};
    function prWhyBlock(r, kind, c, can) {
      const k = `${kind}:${c.id}`, fid = `prWhy-${kind}-${c.id}`;
      if (can && prWhyOpen.has(k)) {
        const v = prWhyDraft[k] != null ? prWhyDraft[k] : (c.reason || '');
        return `<div class="pr-why-edit">
          <div class="pr-meta"><b>The idea behind this ${kind === 'cm' ? 'comment' : 'correction'}</b> — say it as a rule. The tidy-up follows it from now on, and the rest of these minutes is checked for the same thing straight away.</div>
          <textarea id="${fid}" rows="2" maxlength="400" oninput="prWhyDraft['${k}']=this.value" placeholder="e.g. “Write Rev and Dr without a full stop” · “Say ‘the Session agreed’, not ‘it was agreed’” · “Spell out numbers under ten”">${esc(v)}</textarea>
          <div class="pr-actions"><button class="btn btn-primary btn-sm" onclick="prWhySave(${r.id},'${kind}',${c.id},this)">Save the rule</button>
            <button class="btn btn-secondary btn-sm" onclick="prWhyToggle('${k}')">Cancel</button></div></div>`;
      }
      if (c.reason) {
        return `<div class="pr-why"><span><b>Rule:</b> ${esc(c.reason)}</span>${can ? `<button class="pr-go" onclick="prWhyToggle('${k}')">Edit</button><button class="pr-go" onclick="prWhySave(${r.id},'${kind}',${c.id},this,true)">Remove</button>` : ''}</div>`;
      }
      return '';
    }
    const prWhyBtn = (kind, c, can) => (can && !c.reason && !prWhyOpen.has(`${kind}:${c.id}`) && c.source !== 'rule'
      ? `<button class="btn btn-secondary btn-sm pr-why-btn" onclick="prWhyToggle('${kind}:${c.id}')" title="Type the reason behind this correction. The tidy-up will follow it from now on.">Why? — teach the tidy-up</button>` : '');
    function prWhyToggle(k) {
      if (prWhyOpen.has(k)) { prWhyOpen.delete(k); delete prWhyDraft[k]; } else prWhyOpen.add(k);
      renderProofread();
      const el = $('prWhy-' + k.replace(':', '-')); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }
    async function prWhySave(pid, kind, id, btn, remove) {
      const k = `${kind}:${id}`;
      const reason = remove ? '' : (($('prWhy-' + kind + '-' + id) || {}).value || '').trim();
      if (!remove && !reason) { toast('Type the idea behind it first.', true); return; }
      if (remove && !await confirmDialog('Remove this rule? The tidy-up stops following it, and the suggestions it made in these minutes that you have not accepted are taken away.', { title: 'Remove rule', okText: 'Remove' })) return;
      const was = btn.textContent; btn.disabled = true; btn.textContent = remove ? 'Removing…' : 'Saving — checking the rest of these minutes…';
      try {
        const out = await api(`/minutes/proofreads/${pid}/reason`, { method: 'POST', body: { kind, id, reason } });
        prWhyOpen.delete(k); delete prWhyDraft[k];
        prReplace(out.proofread);
        if (remove) toast('Rule removed.');
        else if (out.warning) toast(out.warning, true);
        else toast(out.found
          ? `Saved — the tidy-up follows this from now on. It found ${out.found} more place${out.found === 1 ? '' : 's'} in these minutes; look for “Suggested by your rule”.`
          : 'Saved — the tidy-up follows this from now on. Nothing else in these minutes needed it.');
      } catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = was; }
    }
    function prTogglePreview(cid) { if (prPreview.has(cid)) prPreview.delete(cid); else prPreview.add(cid); renderProofread(); }
    function renderProofread() {
      prSources.length = 0;
      const body = $('prBody');
      if (!body) return;
      const r = proofreads[0];
      if (!r) { body.innerHTML = '<p class="sub" style="margin:0;">No proofreading uploaded for these minutes yet.</p>'; return; }
      const can = mayEdit && !doc.locked;
      const exactPending = r.changes.filter(c => c.status === 'pending' && c.at && c.at.match === 'exact').length;
      const cleanMerges = r.changes.filter(c => c.status === 'pending' && c.merge && c.merge.applied && !c.merge.failed.length).length;
      const all = [...r.changes.map(c => ({ kind: 'ch', c })), ...r.comments.map(c => ({ kind: 'cm', c }))];
      const total = all.length;
      const done = all.filter(x => x.c.status !== 'pending').length;
      const head = `<div style="display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:8px;">
        <div><b>${esc(r.proofreader || 'Proofreader')}</b> · ${r.corrections} correction${r.corrections === 1 ? '' : 's'} in ${r.words.toLocaleString()} words
          · <b>${r.rate}</b> per 1,000 words <span class="pr-meta">(uploaded ${esc(new Date(r.uploadedAt).toLocaleDateString('en-GB'))}${proofreads.length > 1 ? `; ${proofreads.length - 1} earlier upload(s)` : ''})</span></div>
        <div style="display:flex; gap:6px; flex-wrap:wrap;">
        ${can && cleanMerges ? `<button class="btn btn-primary btn-sm" onclick="prAcceptAll(${r.id}, true)" title="His corrections on paragraphs you changed after exporting, carried into your newer wording — only where every one of them fits.">Merge his ${cleanMerges} correction${cleanMerges === 1 ? '' : 's'} into your newer wording</button>` : ''}
        ${can && exactPending ? `<button class="btn btn-primary btn-sm" onclick="prAcceptAll(${r.id})" title="The tracked changes (and any suggestions from your rules) on paragraphs that are still exactly as you sent them.">Accept ${r.changes.some(c => c.source === 'rule' && c.status === 'pending') ? 'the' : 'his'} ${exactPending} correction${exactPending === 1 ? '' : 's'} on unchanged paragraphs</button>` : ''}
        </div>
      </div>
      ${total ? `<div class="pr-progress"><div class="pr-bar"><span style="width:${Math.round((done / total) * 100)}%"></span></div>
        <b>${done} of ${total} done</b>${done === total ? ' — all dealt with' : ''}
        <label class="pr-meta" style="display:inline-flex; gap:6px; align-items:center; margin-left:auto;">
          <input type="checkbox" style="width:auto;" ${prOnlyLeft ? 'checked' : ''} onchange="prToggleLeft(this.checked)"> Show only what’s left</label></div>` : ''}`;

      // Document order: the paragraph number from the Word file (new uploads),
      // otherwise the order they were found in.
      const order = x => (Number.isFinite(x.c.para) ? x.c.para : 1e6 + (x.kind === 'cm' ? 5e5 : 0) + x.c.id);
      const shown = all.filter(x => !prOnlyLeft || x.c.status === 'pending').sort((a, b) => order(a) - order(b));
      const groups = [];
      shown.forEach(x => {
        const at = x.c.at || {};
        // Paragraphs changed in the app since the export come first, so the
        // Clerk settles them before the ordinary corrections.
        const gk = x.c.status === 'pending' && at.match === 'close' ? 'changed'
          : (at.match && at.match !== 'none' && at.key ? `${at.key}:${at.ci}` : 'none');
        let g = groups.find(y => y.gk === gk);
        if (!g) { g = { gk, at, items: [] }; groups.push(g); }
        g.items.push(x);
      });
      // The not-found group goes last; the rest in item order (a suggestion
      // from the Clerk's own rule has no Word paragraph number to sort by).
      const rank = g => (g.gk === 'changed' ? -1 : g.gk === 'none' ? 1 : 0);
      const itemNo = g => String((g.at && g.at.no) || '').split('.').map(Number);
      groups.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? (itemNo(a)[0] - itemNo(b)[0]) || (itemNo(a)[1] - itemNo(b)[1]) : 0) || 0);
      const lineNo = x => (x.c.at && Number.isFinite(x.c.at.li) ? x.c.at.li : x.c.at && x.c.at.li === 'subject' ? -1 : 1e6);
      groups.forEach(g => { if (g.gk !== 'changed' && g.gk !== 'none') g.items.sort((a, b) => lineNo(a) - lineNo(b) || order(a) - order(b)); });

      const undo = (fn) => (can ? `<button class="btn btn-secondary btn-sm" onclick="${fn}">↶ Undo</button>` : '');
      const changeCard = c => {
        const decided = c.status !== 'pending';
        const exact = c.at && c.at.match === 'exact';
        const close = c.at && c.at.match === 'close';
        let inner;
        if (c.status === 'merged') {
          inner = `<div class="pr-meta">Now in the minutes (his corrections merged into your wording):</div><div class="pr-clean">${esc(c.mergedTo || '')}</div>
            ${(c.mergeFailed || []).length ? `<div class="pr-warn">Still to make by hand: ${c.mergeFailed.map(f => `${f.del ? `<del>${esc(f.del)}</del>` : ''}${f.ins ? ` → <ins>${esc(f.ins)}</ins>` : ''}`).join(' · ')}</div>` : ''}
            <details class="pr-meta"><summary>His corrections</summary><div class="pr-diff">${prDiff(c.segs, c.before)}</div></details>`;
        } else if (!decided && close && c.merge) {
          const m = c.merge;
          inner = `<div class="pr-meta">His corrections (on the text you sent him):</div><div class="pr-diff">${prDiff(c.segs, c.before)}</div>
            <div class="pr-meta">What changed in the app since you sent it <span class="pr-meta">(struck = was in the copy he read, marked = in the app now)</span>:</div><div class="pr-diff pr-ctx">${prWordDiff(c.before, m.current)}</div>
            ${m.applied ? `<div class="pr-meta">After merging his corrections into your wording:</div><div class="pr-clean">${esc(m.text)}</div>` : ''}
            ${m.failed.length ? `<div class="pr-warn">${m.applied ? 'These' : 'His corrections'} no longer fit your wording — make ${m.failed.length === 1 ? 'it' : 'them'} by hand: ${m.failed.map(f => `${f.del ? `<del>${esc(f.del)}</del>` : ''}${f.ins ? ` → <ins>${esc(f.ins)}</ins>` : ''}`).join(' · ')}</div>` : ''}`;
        } else if (c.status === 'accepted') {
          inner = `<div class="pr-meta">Now in the minutes:</div><div class="pr-clean">${esc(c.after || '')}</div>
            <details class="pr-meta"><summary>What changed</summary><div class="pr-diff">${prDiff(c.segs, c.before)}</div></details>`;
        } else if (!decided && prPreview.has(c.id)) {
          inner = `<div class="pr-meta">How it will read:</div><div class="pr-clean">${esc(c.after || '')}</div>`;
        } else {
          inner = `<div class="pr-diff">${prDiff(c.segs, c.before)}</div>`;
        }
        if (c.source === 'rule') inner = `<div class="pr-meta pr-rule-note">Your rule: ${esc(c.ruleText || '')}</div>` + inner;
        else if (c.adjustedRule && !decided) inner += `<div class="pr-meta pr-rule-note">Brought into line with your rule: ${esc(c.adjustedRule)}</div>
          <details class="pr-meta"><summary>His correction as he made it</summary><div class="pr-clean">${esc(c.afterOriginal || '')}</div></details>`;
        const actions = !can ? '' : decided
          ? `<div class="pr-actions"><b class="pr-meta">${PR_LABEL[c.status] || c.status}</b>${undo(`prChange(${r.id},${c.id},'undo')`)}${prGo(c.at, 'ch:' + c.id)}${!c.at || c.at.match === 'none' ? prSourceBtn(c.before, 'ch:' + c.id) : ''}${prWhyBtn('ch', c, can)}</div>`
          : `<div class="pr-actions">
              ${close ? '' : `<button class="btn btn-secondary btn-sm" onclick="prTogglePreview(${c.id})">${prPreview.has(c.id) ? 'Show the marks' : 'Preview'}</button>`}
              ${exact ? `<button class="btn btn-primary btn-sm" onclick="prChange(${r.id},${c.id},'accept')">Accept</button>`
                : close && c.merge && c.merge.applied ? `<button class="btn btn-primary btn-sm" onclick="prChange(${r.id},${c.id},'merge')" title="Only the words he marked are changed; the rest of your wording stays as it is.">Amend just the marked words</button>
                   <button class="btn btn-secondary btn-sm" onclick="prChange(${r.id},${c.id},'done')">Done — I changed it myself</button>`
                : `<button class="btn btn-secondary btn-sm" onclick="prChange(${r.id},${c.id},'done')" title="The paragraph has changed since the export (or is written from the meeting details), so make the change yourself, then tick it off here.">Done — I changed it myself</button>`}
              <button class="btn btn-secondary btn-sm" onclick="prChange(${r.id},${c.id},'reject')">Reject</button>
              ${prGo(c.at, 'ch:' + c.id)}${!c.at || c.at.match === 'none' ? prSourceBtn(c.before, 'ch:' + c.id) : ''}
              ${prWhyBtn('ch', c, can)}
            </div>
            ${close && !(c.merge && c.merge.applied) ? '<div class="pr-meta">This paragraph has been changed in the app since the minutes went for proofreading, and his corrections no longer fit it. Go to the item, make the correction there yourself, then come back and press “Done — I changed it myself”.</div>' : ''}
            ${!c.at || c.at.match === 'none' ? '<div class="pr-meta">This line is written by the app from details kept elsewhere (the opening, constituting, review of minutes, a letter, closure…), so it cannot be accepted here. Use the button above to open where it comes from, make the correction there, then press “← Back to proofreading” and “Done — I changed it myself”.</div>' : ''}`;
        return `<div class="pr-ch ${decided ? 'done' : ''} ${c.source === 'rule' ? 'pr-byrule' : ''}" data-pr="ch:${c.id}"><div class="pr-kind">${c.source === 'rule' ? 'Suggested by your rule' : 'Tracked change'}</div>${inner}${actions}${prWhyBlock(r, 'ch', c, can)}</div>`;
      };
      const commentCard = c => {
        const decided = c.status !== 'pending';
        const exact = c.at && c.at.match === 'exact';
        const changed = !decided && c.at && c.at.match === 'close' && c.current;
        const ctx = changed
          ? `<div class="pr-meta">What changed in the app since you sent it <span class="pr-meta">(struck = was in the copy he read, marked = in the app now)</span>:</div><div class="pr-diff pr-ctx">${prWordDiff(c.paragraph, c.current)}</div>
             <div class="pr-meta">The paragraph now, with the words he commented on:</div><div class="pr-ctx">${prMark(c.current, c.anchor)}</div>`
          : `<div class="pr-ctx">${prMark(c.current || c.paragraph, c.anchor)}</div>`;
        let inner = `<div class="pr-say"><b>${esc(c.author || 'Proofreader')}:</b> ${esc(c.text)}</div>${c.status === 'applied' ? '' : ctx}`;
        if (c.status === 'applied') inner += `<div class="pr-meta">Now in the minutes:</div><div class="pr-clean">${esc(c.resolution || '')}</div>`;
        if (c.directive && decided) inner += `<div class="pr-meta" style="margin-top:4px;">Your directive: ${esc(c.directive)}</div>`;
        let actions = '';
        if (can && decided) {
          actions = `<div class="pr-actions"><b class="pr-meta">${PR_LABEL[c.status] || c.status}</b>${undo(`prResolve(${r.id},${c.id},'undo')`)}${prGo(c.at, 'cm:' + c.id)}${!c.at || c.at.match === 'none' ? prSourceBtn(c.paragraph, 'cm:' + c.id) : ''}${prWhyBtn('cm', c, can)}</div>`;
        } else if (can) {
          actions = `
            <div class="pr-meta" style="margin-top:8px;"><b>Your directive</b> — tell Claude what to do with the paragraph above. It drafts a new version for you to check; nothing changes in the minutes until you press “Apply”.</div>
            <textarea id="prDir-${c.id}" rows="2" placeholder="e.g. “Use his wording: shared with the legal teams of the Presbytery and Head Office” · “Add: No decision was taken.” · “Replace inducted with installed”" style="width:100%; margin-top:4px;">${esc(c.directive || '')}</textarea>
            ${c.proposal ? `<div class="pr-meta" style="margin-top:6px;">Claude’s draft (edit it if needed, then Apply):</div>
              <textarea id="prProp-${c.id}" rows="4" style="width:100%;">${esc(c.proposal)}</textarea>
              ${c.adjustedRule ? `<div class="pr-meta pr-rule-note">Brought into line with your rule: ${esc(c.adjustedRule)}</div>` : ''}` : ''}
            <div class="pr-actions">
              <button class="btn ${c.proposal ? 'btn-secondary' : 'btn-primary'} btn-sm" onclick="prPropose(${r.id},${c.id},this)">${c.proposal ? 'Draft it again' : 'Draft the change'}</button>
              ${c.proposal ? `<button class="btn btn-primary btn-sm" onclick="prResolve(${r.id},${c.id},'apply')">Apply to the minutes</button>` : ''}
              <button class="btn btn-secondary btn-sm" onclick="prResolve(${r.id},${c.id},'no-change')">No change needed</button>
              ${!exact ? `<button class="btn btn-secondary btn-sm" onclick="prResolve(${r.id},${c.id},'done')">Done — I changed it myself</button>` : ''}
              ${prGo(c.at, 'cm:' + c.id)}${!c.at || c.at.match === 'none' ? prSourceBtn(c.paragraph, 'cm:' + c.id) : ''}
              ${prWhyBtn('cm', c, can)}
            </div>`;
        }
        return `<div class="pr-ch pr-cm ${decided ? 'done' : ''}" data-pr="cm:${c.id}"><div class="pr-kind">Comment</div>${inner}${actions}${prWhyBlock(r, 'cm', c, can)}</div>`;
      };
      const list = groups.map(g => `
        <h4 class="pr-group">${g.gk === 'changed' ? '⚠ Changed in the app since you sent it for proofreading — settle these first'
          : g.gk === 'none' ? 'Written from the meeting details, or not found' : `Item ${esc(g.at.no || '')} ${esc(g.at.subject || '')}`}</h4>
        ${g.gk === 'changed' ? '<p class="pr-meta" style="margin:0 0 8px;">You (or the tidy-up) changed these paragraphs after exporting, so his corrections were made on an older copy. Each card shows exactly what changed. For a correction, press Merge to carry it into your newer wording; for a comment, write your directive as usual — Claude works on the paragraph as it is now.</p>' : ''}
        ${g.items.map(x => (x.kind === 'ch' ? changeCard(x.c) : commentCard(x.c))).join('')}`).join('');

      const lessons = (r.lessons || []).length ? `<h4 style="margin:16px 0 6px;">Suggested house-style rules</h4>` + r.lessons.map(l => `
        <div class="pr-ch ${l.status !== 'proposed' ? 'done' : ''}">
          <div style="font-size:13px;"><b>${esc(l.rule)}</b> <span class="pr-meta">(explains ${l.times} correction${l.times === 1 ? '' : 's'})</span></div>
          ${l.wrong ? `<div class="pr-diff"><del>${esc(l.wrong)}</del> → <ins>${esc(l.right)}</ins></div>` : ''}
          ${l.status === 'proposed' && can ? `<button class="btn btn-primary btn-sm" onclick="prLesson(${r.id},${l.id},true)">Teach the tidy-up this</button>
            <button class="btn btn-secondary btn-sm" onclick="prLesson(${r.id},${l.id},false)">Skip</button>` : `<b class="pr-meta">${l.status === 'approved' ? '✓ now part of the house style' : 'skipped'}</b>`}
        </div>`).join('') : '';
      body.innerHTML = head
        + (list || (prOnlyLeft && total ? '<p class="sub">Nothing left — every change and comment has been dealt with.</p>' : ''))
        + (can ? `<div style="margin-top:12px;"><button class="btn btn-secondary btn-sm" onclick="prLessons(${r.id},this)">${(r.lessons || []).length ? 'Suggest rules again' : 'Suggest house-style rules from these corrections'}</button></div>` : '')
        + lessons;
    }
    // Anything typed but not yet saved goes first, so an accepted correction is
    // never overwritten by a save already queued; then the page takes the
    // minutes back from the server.
    async function prFlush() {
      await Promise.all((doc.sections || []).map((s, i) => (secTimers[s.key] ? saveSection(i, true) : null)));
    }
    async function prRefreshDoc() {
      try { const fresh = await api('/minutes/' + doc.id); doc.sections = fresh.doc.sections; renderSections(); renderTidyCheck(); } catch (e) {}
    }
    function prReplace(rec) { proofreads = [rec, ...proofreads.filter(x => x.id !== rec.id)]; renderProofread(); }
    async function prChange(pid, cid, action) {
      try {
        await prFlush();
        const out = await api(`/minutes/proofreads/${pid}/changes/${cid}`, { method: 'POST', body: { action } });
        prReplace(out);
        if (action === 'accept' || action === 'merge' || action === 'undo') await prRefreshDoc();
        // Accept on a paragraph edited since: only his marked words were changed.
        if (out && out.amended) toast(out.amended.failed ? `The paragraph had changed, so only his marked words were amended — ${out.amended.failed} still to do by hand.` : 'The paragraph had changed, so only his marked words were amended.');
      }
      catch (e) { toast(e.message, true); }
    }
    async function prAcceptAll(pid, merge) {
      try { await prFlush(); const r = await api(`/minutes/proofreads/${pid}/accept-all`, { method: 'POST', body: merge ? { merge: true } : {} }); prReplace(r.proofread); await prRefreshDoc(); toast(`${r.accepted} correction${r.accepted === 1 ? '' : 's'} ${merge ? 'merged into your wording' : 'accepted into the minutes'}.`); }
      catch (e) { toast(e.message, true); }
    }
    async function prPropose(pid, cid, btn) {
      const directive = ($('prDir-' + cid) || {}).value || '';
      if (!directive.trim()) { toast('Write your directive first.', true); return; }
      const was = btn.textContent; btn.disabled = true; btn.textContent = 'Working\u2026';
      try { prReplace(await api(`/minutes/proofreads/${pid}/comments/${cid}/propose`, { method: 'POST', body: { directive } })); }
      catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = was; }
    }
    async function prResolve(pid, cid, action) {
      const directive = ($('prDir-' + cid) || {}).value || '';
      const text = ($('prProp-' + cid) || {}).value;
      try { await prFlush(); prReplace(await api(`/minutes/proofreads/${pid}/comments/${cid}/resolve`, { method: 'POST', body: { action, directive, text } })); if (action === 'apply' || action === 'undo') await prRefreshDoc(); }
      catch (e) { toast(e.message, true); }
    }
    async function prLessons(pid, btn) {
      const was = btn.textContent; btn.disabled = true; btn.textContent = 'Studying the corrections\u2026';
      try { prReplace(await api(`/minutes/proofreads/${pid}/lessons`, { method: 'POST' })); }
      catch (e) { toast(e.message, true); btn.disabled = false; btn.textContent = was; }
    }
    async function prLesson(pid, lid, approve) {
      try { prReplace(await api(`/minutes/proofreads/${pid}/lessons/${lid}`, { method: 'POST', body: { approve } })); if (approve) toast('The tidy-up will follow this rule from now on.'); }
      catch (e) { toast(e.message, true); }
    }
    if ($('prUploadBtn')) {
      $('prUploadBtn').addEventListener('click', () => $('prFile').click());
      $('prFile').addEventListener('change', async e => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        $('prStatus').textContent = 'Reading the tracked changes\u2026';
        const fd = new FormData(); fd.append('docx', f);
        try {
          const res = await fetch(`/api/minutes/${doc.id}/proofread`, { method: 'POST', body: fd, credentials: 'same-origin' });
          const j = await res.json();
          if (!res.ok) throw new Error(j.error || 'Could not read that file.');
          $('prStatus').textContent = '';
          prReplace(j);
          toast(`${j.changes.length} change${j.changes.length === 1 ? '' : 's'} and ${j.comments.length} comment${j.comments.length === 1 ? '' : 's'} found.`);
        } catch (err) { $('prStatus').textContent = ''; toast(err.message, true); }
      });
    }
    function renderVersions() {
      const list = doc.versions || [];
      $('verList').innerHTML = list.length ? list.map((v, i) => `
        <div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--line,#e6e9f0);">
          <span class="badge ${v.kind === 'final' ? 'badge-done' : ''}">${v.kind === 'final' ? 'Final adopted' : 'Tabled draft'}</span>
          <div style="flex:1;min-width:0;">
            <b style="font-size:13px;">${esc(v.originalName || v.filename)}</b>
            <div class="sub">${new Date(v.uploadedAt).toLocaleString('en-GB')} · ${esc(v.uploadedBy || '')}</div>
          </div>
          <a class="btn btn-secondary btn-sm" href="/api/minutes/${doc.id}/versions/${i}/file" target="_blank">Open</a>
        </div>`).join('')
        : '<p class="sub" style="margin:0;">No signed copies uploaded yet.</p>';
    }
    function renderAppendices() {
      const list = doc.appendices || [];
      const L = 'ABCDEFGHIJ';
      $('appList').innerHTML = list.length ? list.map((a, i) => `
        <div class="card" style="margin-bottom:10px;">
          <div class="field"><label>Appendix ${L[i] || i + 1} — title</label>
            <input type="text" value="${esc(a.title || '')}" onchange="appSet(${i},'title',this.value)" ${mayEdit ? '' : 'disabled'}></div>
          <div class="field"><label>Text</label>
            <textarea rows="6" onchange="appSet(${i},'body',this.value)" ${mayEdit ? '' : 'disabled'}>${esc(a.body || '')}</textarea></div>
          ${mayEdit ? `<button class="btn btn-danger btn-sm" onclick="appDel(${i})">Remove appendix</button>` : ''}
        </div>`).join('')
        : '<p class="sub">None.</p>';
    }
    function appSet(i, k, v) { doc.appendices[i][k] = v; queueSave(); }
    function appDel(i) { doc.appendices.splice(i, 1); renderAppendices(); queueSave(); }
    $('addAppBtn').addEventListener('click', () => { (doc.appendices = doc.appendices || []).push({ title: '', body: '' }); renderAppendices(); queueSave(); });

    $('verUploadBtn').addEventListener('click', () => $('verFile').click());
    $('verFile').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      const fd = new FormData();
      fd.append('pdf', file);
      fd.append('kind', $('verKind').value);
      $('verStatus').textContent = 'Uploading…';
      try {
        const res = await fetch(`/api/minutes/${doc.id}/versions`, { method: 'POST', body: fd, credentials: 'same-origin' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Upload failed.');
        (doc.versions = doc.versions || []).push(d);
        $('verStatus').textContent = '';
        renderVersions();
        toast('Copy stored.');
      } catch (err) { $('verStatus').textContent = ''; toast(err.message, true); }
      $('verFile').value = '';
    });
    // The minutes downloads pass through the tidy check. The agenda ones do not.
    let tidyBypass = 0;
    // Letters with no Action yet: asked before anything leaves the app.
    function corrMissing() {
      const sec = (doc.sections || []).find(s => s.key === 'correspondence');
      if (sec && sec.enabled === false) return [];
      return corr.filter(corrUnsettled);
    }
    async function actionGate(what) {
      const list = corrMissing();
      if (!list.length) return true;
      const names = list.slice(0, 6).map(c => `“${c.heading || 'Untitled'}”${String(c.action || '').trim() ? ' (still “For decision”)' : ''}`).join(', ') + (list.length > 6 ? ` and ${list.length - 6} more` : '');
      const go = await confirmDialog(
        `${list.length === 1 ? '1 letter has' : list.length + ' letters have'} no Action recorded yet: ${names}. The Action column will be blank for ${list.length === 1 ? 'it' : 'them'}.`,
        { title: 'Choose the Action for each letter', okText: `${what} anyway`, cancelText: 'Fill in the Actions' });
      if (!go) {
        document.querySelector('.mtab[data-pane="corr"]').click();
        const el = $('corrAct' + list[0].id);
        if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => el.focus(), 350); }
      }
      return go;
    }
    ['dlMinDocx', 'dlMinPdf'].forEach(id => $(id).addEventListener('click', async e => {
      if (Date.now() < tidyBypass) return;
      const needTidy = tidyApplies() && untidiedItems().length;
      if (!needTidy && !corrMissing().length) return;
      e.preventDefault();
      if (!await actionGate('Download')) return;
      if (needTidy && !await tidyGate('Download')) return;
      const href = $(id).href;
      if (id === 'dlMinDocx') { window.location.href = href; return; }
      if (!window.open(href, '_blank')) {
        tidyBypass = Date.now() + 60000;
        toast('Your browser blocked the PDF window. Click “Minutes (PDF)” again.');
      }
    }));

    $('circulateBtn').addEventListener('click', async () => {
      if (!await actionGate('Circulate')) return;
      if (!await tidyGate('Circulate')) return;
      if (!await confirmDialog('Email the draft minutes to the members who were present?')) return;
      $('verStatus').textContent = 'Sending…';
      try {
        const r = await api(`/minutes/${doc.id}/circulate`, { method: 'POST', body: { onlyPresent: true } });
        $('verStatus').textContent = '';
        toast(`Sent to ${r.sent} of ${r.total}${r.failed ? ` — ${r.failed} could not be sent` : ''}.`);
      } catch (e) { $('verStatus').textContent = ''; toast(e.message, true); }
    });

    $('adoptBtn').addEventListener('click', async () => {
      if (!await confirmDialog(`Record that the Session adopted the minutes of ${previous ? fmtDate(previous.date) : 'the last meeting'}? Those minutes will be locked as the signed record.`)) return;
      try {
        await doSave();
        const r = await api(`/minutes/${doc.id}/adopt-previous`, { method: 'POST' });
        toast(`Adoption recorded against the minutes of ${fmtDate(r.targetDate)}.`);
        openDoc(doc.id);
      } catch (e) { toast(e.message, true); }
    });
    $('confirmBtn').addEventListener('click', async () => {
      try {
        doc = await api(`/minutes/${doc.id}/confirm`, { method: 'POST' });
        renderDocs();
        toast('Confirmed.');
      } catch (e) { toast(e.message, true); }
    });

    $('finaliseBtn').addEventListener('click', async () => {
      if (!await tidyGate('Mark as final')) return;
      if (!await confirmDialog('Mark these minutes as final? They cannot be edited until reopened.')) return;
      try {
        await doSave();
        doc = await api('/minutes/' + doc.id + '/finalise', { method: 'POST' });
        mayEdit = false;
        renderAll(); toast('Minutes marked final.');
      } catch (e) { toast(e.message, true); }
    });
    $('reopenBtn').addEventListener('click', async () => {
      try {
        doc = await api('/minutes/' + doc.id, { method: 'PUT', body: { reopen: true } });
        mayEdit = true;
        renderAll(); toast('Reopened for editing.');
      } catch (e) { toast(e.message, true); }
    });
    $('deleteBtn').addEventListener('click', async () => {
      if (!await confirmDialog('Delete these minutes and their correspondence? This cannot be undone.')) return;
      try {
        await api('/minutes/' + doc.id, { method: 'DELETE' });
        toast('Deleted.'); backToList();
      } catch (e) { toast(e.message, true); }
    });

    // --------------------------------------------------------------- modals
    $('backBtn').addEventListener('click', backToList);
    $('newBtn').addEventListener('click', async () => {
      $('newForm').reset(); $('nStart').value = '18:30'; $('nTitle').value = 'Session Meeting';
      if (!SessionVenues.list.length) await SessionVenues.load();
      $('nVenue').innerHTML = SessionVenues.options(SessionVenues.defaultVenue);
      $('nVenueOther').style.display = 'none';
      $('newOverlay').style.display = 'flex';
    });
    $('newCancel').addEventListener('click', () => $('newOverlay').style.display = 'none');
    $('newForm').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        const created = await api('/minutes', { method: 'POST', body: {
          date: $('nDate').value, startTime: $('nStart').value,
          title: $('nTitle').value, venue: SessionVenues.value($('nVenue'), $('nVenueOther')),
        } });
        $('newOverlay').style.display = 'none';
        openDoc(created.id);
      } catch (err) { toast(err.message, true); }
    });

    let editingMember = null;
    $('addMemberBtn').addEventListener('click', () => {
      editingMember = null;
      $('memTitle').textContent = 'Add Session member';
      $('memForm').reset();
      $('memOverlay').style.display = 'flex';
    });
    function editMember(id) {
      const m = roster.find(x => x.id === id);
      if (!m) return;
      editingMember = id;
      $('memTitle').textContent = 'Edit Session member';
      $('mName').value = m.name; $('mPosition').value = m.position || '';
      $('mEmail').value = m.email || ''; $('mPhone').value = m.phone || '';
      $('mRank').value = m.rank || '';
      $('memOverlay').style.display = 'flex';
    }
    $('memCancel').addEventListener('click', () => $('memOverlay').style.display = 'none');
    $('memForm').addEventListener('submit', async e => {
      e.preventDefault();
      const body = {
        name: $('mName').value, position: $('mPosition').value || 'Member',
        email: $('mEmail').value, phone: $('mPhone').value,
      };
      if ($('mRank').value) body.rank = Number($('mRank').value);
      try {
        if (editingMember) await api('/minutes/roster/' + editingMember, { method: 'PUT', body });
        else await api('/minutes/roster', { method: 'POST', body });
        roster = await api('/minutes/roster');
        $('memOverlay').style.display = 'none';
        renderRoster(); renderRoll();
      } catch (err) { toast(err.message, true); }
    });
    $('seedBtn').addEventListener('click', async () => {
      try {
        roster = await api('/minutes/roster/seed', { method: 'POST' });
        renderRoster(); renderRoll();
        toast('Session roster created — edit any name or position as needed.');
      } catch (e) { toast(e.message, true); }
    });

    $('addGuestBtn').addEventListener('click', () => openMinutesGuest(null));
    $('guestCancel').addEventListener('click', () => $('guestOverlay').style.display = 'none');
    $('guestForm').addEventListener('submit', e => {
      e.preventDefault();
      doc.roll = doc.roll || {};
      const list = doc.roll.guests = doc.roll.guests || [];
      const entry = { name: $('gName').value.trim(), position: $('gPosition').value.trim() || 'In attendance' };
      const details = $('gDetails').value.trim();
      if (details) entry.details = details;
      // The same person never goes in twice: adding a name already listed
      // updates that line instead.
      const same = list.findIndex((g, i) => i !== minutesGuestAt && (g.name || '').trim().toLowerCase() === entry.name.toLowerCase());
      if (minutesGuestAt != null) list[minutesGuestAt] = entry;
      else if (same >= 0) { list[same] = entry; toast(`${entry.name} was already listed — updated.`); }
      else list.push(entry);
      if (minutesGuestAt != null && same >= 0) list.splice(same, 1);
      minutesGuestAt = null;
      $('guestOverlay').style.display = 'none';
      renderGuests(); saveRoll();
    });

    $('pullBtn').addEventListener('click', async () => {
      try {
        const meetings = await api('/meetings');
        const held = (meetings || []).filter(m => m.attendance && m.attendance.locked);
        if (!held.length) { toast('No meetings with locked attendance yet.', true); return; }
        $('pullSelect').innerHTML = held.map(m => `<option value="${m.id}">${esc(m.entityName || '')} — ${esc(m.title || 'Meeting')} (${esc(m.date)})</option>`).join('');
        $('pullOverlay').style.display = 'flex';
      } catch (e) { toast(e.message, true); }
    });
    $('pullCancel').addEventListener('click', () => $('pullOverlay').style.display = 'none');
    $('pullGo').addEventListener('click', async () => {
      try {
        const r = await api(`/minutes/${doc.id}/pull-attendance`, { method: 'POST', body: { meetingId: Number($('pullSelect').value) } });
        doc = r.doc;
        $('pullOverlay').style.display = 'none';
        renderRoll(); refreshPoolsLocally();
        toast(`Matched ${r.matched} people against the Session roster.`);
      } catch (e) { toast(e.message, true); }
    });

    let regTimer = null;
    $('regSearch').addEventListener('input', () => { clearTimeout(regTimer); regTimer = setTimeout(loadRegister, 300); });
    $('regExportBtn').addEventListener('click', () => {
      const q = $('regSearch').value.trim();
      openCorrExport({ scope: 'register', q }, q ? 'the letters found' : 'the correspondence register');
    });


    // ------------------------------------------------- presbyters on duty
    // The pair rostered for the week of this meeting take the devotion. Their
    // names are offered, never forced — one of the two usually leads it.
    function renderDutyChips() {
      const box = $('podChips');
      if (!box) return;
      if (!onDuty.names.length) {
        box.innerHTML = onDuty.hasRoster
          ? '<span class="sub" style="font-size:11.5px;">No presbyters rostered for the week of this meeting.</span>'
          : '<span class="sub" style="font-size:11.5px;">No duty roster uploaded for this half of the year yet.</span>';
        return;
      }
      box.innerHTML = '<span class="sub" style="font-size:11.5px;">On duty this week — tap to use:</span> '
        + onDuty.names.map((n, i) => `<button type="button" class="btn btn-secondary btn-sm" style="margin:4px 4px 0 0;" onclick="useDuty(${i})" ${mayEdit ? '' : 'disabled'}>${esc(n)}</button>`).join('')
        + (onDuty.names.length > 1 ? `<button type="button" class="btn btn-secondary btn-sm" style="margin-top:4px;" onclick="useDuty(-1)" ${mayEdit ? '' : 'disabled'}>Both</button>` : '');
    }
    function useDuty(i) {
      if (!mayEdit) return;
      const value = i < 0 ? onDuty.names.join(' / ') : onDuty.names[i];
      $('pDevotionBy').value = value;
      doc.proceedings = doc.proceedings || {};
      doc.proceedings.devotionBy = value;
      note('Saving…');
      api(`/minutes/${doc.id}/proceedings`, { method: 'PUT', body: { proceedings: { devotionBy: value } } })
        .then(() => note('Saved')).catch(e => { note(''); toast(e.message, true); });
      renderSections();
    }
    function renderOnDutyNote() {
      const el = $('onDutyNote');
      if (!el) return;
      if (!onDuty.hasRoster) {
        el.innerHTML = 'No Presbyters on Duty roster for this half of the year — upload one from the main Session Minutes page and the devotion will fill itself in.';
        return;
      }
      el.innerHTML = onDuty.names.length
        ? `On duty for the week of ${esc(fmtDate(onDuty.sunday))}: <b>${esc(onDuty.label)}</b> `
          + `<button class="btn btn-secondary btn-sm" onclick="fillDevotionRow()" ${mayEdit ? '' : 'disabled'}>Use for the Devotion row</button>`
        : `No presbyters rostered for the week of ${esc(fmtDate(onDuty.sunday))}.`;
    }
    // Drop the duty pair into the agenda's Devotion row.
    function fillDevotionRow() {
      if (!mayEdit || !onDuty.names.length) return;
      let row = (doc.agenda || []).find(r => /devotion/i.test(r.item || ''));
      if (!row) { toast('Add a Devotion row to the agenda first.', true); return; }
      row.responsible = onDuty.label;
      renderAgenda(); saveAgenda();
      toast('Devotion row filled from the duty roster.');
    }

    // ------------------------------------------------------- time stamping
    // "6:53 pm" — how the minutes write times (Session Clerk's choice, Oct 2026).
    function stampNow() {
      const d = new Date();
      let h = d.getHours();
      const ampm = h >= 12 ? 'pm' : 'am';
      h = h % 12; if (h === 0) h = 12;
      return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${ampm}`;
    }
    document.querySelectorAll('.nowBtn').forEach(btn => btn.addEventListener('click', () => {
      if (!mayEdit) return;
      const id = btn.dataset.now;
      const el = $(id);
      el.value = stampNow();
      doc.proceedings = doc.proceedings || {};
      doc.proceedings[PROC[id]] = el.value;
      note('Saving…');
      api(`/minutes/${doc.id}/proceedings`, { method: 'PUT', body: { proceedings: { [PROC[id]]: el.value } } })
        .then(() => note('Saved')).catch(e => { note(''); toast(e.message, true); });
      renderSections();
    }));

    // --------------------------------------------- put it on the Meetings page
    $('scheduleBtn').addEventListener('click', async () => {
      try {
        await doSave();
        const r = await api(`/minutes/${doc.id}/schedule`, { method: 'POST', body: { time: doc.startTime } });
        doc.meetingId = r.meeting.id;
        const n = r.notified;
        let msg = r.updated ? 'Meeting details updated on the Meetings page.' : 'Session meeting added to the Meetings page.';
        if (n) {
          msg += ` Notice sent to ${n.sms} by SMS`;
          if (n.emails) msg += `, ${n.emails} by email`;
          msg += '.';
          if (n.withoutPhone) msg += ` ${n.withoutPhone} member${n.withoutPhone === 1 ? ' has' : 's have'} no phone number on the roster.`;
        }
        toast(msg);
      } catch (e) { toast(e.message, true); }
    });

    // ----------------------------------------------------- duty roster admin
    async function loadPod() {
      const list = await api('/minutes/pod');
      $('podList').innerHTML = list.length ? list.map(r => `
        <div class="corr-card">
          <h4>${esc(r.label)}</h4>
          <div class="sub">${r.entries.length} of ${r.sundays} Sundays filled${r.uploadedBy ? ' · ' + esc(r.uploadedBy) : ''}</div>
          <div style="margin-top:8px; display:flex; gap:6px; flex-wrap:wrap;">
            <button class="btn btn-secondary btn-sm" onclick="editPod(${r.id})">View / edit</button>
            ${r.file ? `<a class="btn btn-secondary btn-sm" href="/api/minutes/pod/${r.id}/file" target="_blank">Original file</a>` : ''}
            <button class="btn btn-danger btn-sm" onclick="delPod(${r.id})">Remove</button>
          </div>
        </div>`).join('')
        : emptyState({ icon: 'people', title: 'No duty roster yet', text: 'Upload the half-year roster and the pair on duty is filled in for each Sunday and Session meeting.', action: '+ Upload a roster', click: 'podNewBtn' });
      window._pod = list;
    }
    let podFilePending = [], podEditingId = null;
    function openPod(rec) {
      podEditingId = rec ? rec.id : null;
      podFilePending = [];
      const now = new Date();
      $('podYear').value = rec ? rec.year : now.getFullYear();
      $('podHalf').value = rec ? rec.half : (now.getMonth() >= 6 ? 2 : 1);
      $('podDropText').textContent = '📄 Tap to choose a photo or PDF of the roster';
      $('podStatus').textContent = '';
      $('podWarn').innerHTML = '';
      podDraft = rec ? (rec.entries || []).map(e => ({ ...e, names: (e.names || []).slice() })) : [];
      renderPodRows();
      $('podOverlay').style.display = 'flex';
    }
    function editPod(id) { openPod((window._pod || []).find(r => r.id === id)); }
    async function delPod(id) {
      if (!await confirmDialog('Remove this duty roster?')) return;
      try { await api('/minutes/pod/' + id, { method: 'DELETE' }); loadPod(); }
      catch (e) { toast(e.message, true); }
    }
    function renderPodRows() {
      const rows = podDraft || [];
      $('podRows').innerHTML = rows.length ? `
        <table><thead><tr><th>Sunday</th><th>Presbyters on duty</th><th></th></tr></thead><tbody>
        ${rows.map((e, i) => `
          <tr>
            <td class="mono" style="white-space:nowrap;">${esc(fmtDate(e.date))}</td>
            <td><input type="text" value="${esc((e.names || []).join(' / '))}" placeholder="Name / Name"
                  onchange="podSet(${i}, this.value)" style="width:100%;"></td>
            <td style="text-align:right;"><button class="btn btn-danger btn-sm" onclick="podDel(${i})">✕</button></td>
          </tr>`).join('')}
        </tbody></table>`
        : '<p class="sub">Nothing yet — read a roster or start a blank one.</p>';
    }
    function podSet(i, v) {
      podDraft[i].names = String(v).split('/').map(x => x.trim()).filter(Boolean);
    }
    function podDel(i) { podDraft.splice(i, 1); renderPodRows(); }

    $('podNewBtn').addEventListener('click', () => openPod(null));
    $('podCancel').addEventListener('click', () => { $('podOverlay').style.display = 'none'; });
    $('podDrop').addEventListener('click', () => $('podFile').click());
    $('podFile').addEventListener('change', e => {
      podFilePending = [...e.target.files];
      $('podDropText').textContent = podFilePending.length
        ? `📎 ${podFilePending.length} page${podFilePending.length === 1 ? '' : 's'} attached`
        : '📄 Tap to choose a photo or PDF of the roster';
    });
    $('podBlankBtn').addEventListener('click', async () => {
      const year = Number($('podYear').value), half = Number($('podHalf').value);
      const r = await api(`/minutes/pod/on-duty?date=${year}-${half === 2 ? '07' : '01'}-01`).catch(() => null);
      // Build the list of Sundays client-side to avoid another round-trip.
      const out = [];
      const d = new Date(Date.UTC(year, half === 2 ? 6 : 0, 1));
      d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
      const end = new Date(Date.UTC(year, half === 2 ? 11 : 5, half === 2 ? 31 : 30));
      while (d <= end) { out.push({ date: d.toISOString().slice(0, 10), names: [] }); d.setUTCDate(d.getUTCDate() + 7); }
      podDraft = out;
      renderPodRows();
    });
    $('podReadBtn').addEventListener('click', async () => {
      if (!podFilePending.length) { toast('Choose a photo or PDF of the roster first.', true); return; }
      const fd = new FormData();
      podFilePending.forEach(f => fd.append('roster', f));
      fd.append('year', $('podYear').value);
      fd.append('half', $('podHalf').value);
      $('podStatus').textContent = podFilePending.length > 1 ? `Reading ${podFilePending.length} pages…` : 'Reading the roster…';
      $('podReadBtn').disabled = true;
      try {
        const res = await fetch('/api/minutes/pod/read', { method: 'POST', body: fd, credentials: 'same-origin' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Could not read the roster.');
        podDraft = d.entries || [];
        $('podStatus').textContent = `${podDraft.length} Sundays read — please check the names.`;
        const notes = [];
        if ((d.unreadable || []).length) notes.push(`Could not read with confidence: ${d.unreadable.join('; ')}`);
        if ((d.missing || []).length) notes.push(`${d.missing.length} Sunday${d.missing.length === 1 ? '' : 's'} in this half-year not covered: ${d.missing.slice(0, 6).map(fmtDate).join(', ')}${d.missing.length > 6 ? '…' : ''}`);
        $('podWarn').innerHTML = notes.map(n => `<div class="badge badge-critical" style="display:block;padding:7px 10px;margin-bottom:6px;">⚠ ${esc(n)}</div>`).join('');
        renderPodRows();
      } catch (e) { $('podStatus').textContent = ''; toast(e.message, true); }
      finally { $('podReadBtn').disabled = false; }
    });
    $('podSave').addEventListener('click', async () => {
      const fd = new FormData();
      fd.append('year', $('podYear').value);
      fd.append('half', $('podHalf').value);
      fd.append('entries', JSON.stringify((podDraft || []).filter(e => (e.names || []).length)));
      podFilePending.forEach(f => fd.append('roster', f));
      try {
        const res = await fetch('/api/minutes/pod', { method: 'POST', body: fd, credentials: 'same-origin' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Could not save.');
        $('podOverlay').style.display = 'none';
        loadPod();
        toast(d.dropped
          ? `Duty roster saved — ${d.dropped} row${d.dropped === 1 ? '' : 's'} ignored because the date was not a Sunday in this half-year.`
          : 'Duty roster saved.');
      } catch (e) { toast(e.message, true); }
    });

    (async () => {
      me = await requireAuthAndRenderShell('/minutes.html');
      if (!me) return;
      // Arriving from Session Meetings → open that meeting's minutes directly.
      const wanted = Number(new URLSearchParams(location.search).get('meeting'));
      if (wanted) {
        try { await loadMeetings(); await openDoc(wanted); return; }
        catch (e) {
          // Never fail silently here. A swallowed error used to leave the
          // editor open and completely empty, which reads as lost work.
          console.error('Could not open those minutes:', e);
          toast('Could not open those minutes — showing the list instead.', true);
          $('editor').style.display = 'none';
          $('listView').style.display = '';
        }
      }
      loadList();
    })();
