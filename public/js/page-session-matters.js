// AOTC Track — the Session's register of outstanding matters.
//
// Things the Session is carrying between meetings: a matter deferred, a
// decision awaited, an instruction given to someone. Kept here as well as in
// the minutes so that nothing quietly lapses — every one of them is worked
// through, meeting after meeting, until the Session actually clears it.
    let me, matters = [], counts = {}, statuses = [], mayEdit = false;
    let meetings = [], roster = [], filter = 'open';
    let editingId = null, updatingId = null, proposed = [];
    // The heading groups as last drawn — a button click names one by position.
    let shown = [];

    const $ = id => document.getElementById(id);
    const statusOf = k => statuses.find(s => s.key === k) || { key: 'open', label: 'Open' };

    function fmtDate(iso) {
      if (!iso) return '';
      const d = toLocalDate(iso);
      return isNaN(d) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    async function load() {
      const d = await api('/minutes/matters');
      matters = d.matters || [];
      counts = d.counts || {};
      statuses = d.statuses || [];
      mayEdit = !!d.canEdit;
      $('sOpen').textContent = counts.open || 0;
      $('sProg').textContent = counts['in-progress'] || 0;
      $('sDecided').textContent = counts.decided || 0;
      $('sClosed').textContent = counts.closed || 0;
      $('sFlagged').textContent = d.flagged || 0;
      renderHeadingList();
      renderFilters();
      render();
    }

    // Every heading already in use, so a matter typed by hand joins an existing
    // group rather than starting a near-duplicate of it — "Building Project"
    // and "Update on Building Project" would be two lines on the agenda.
    function renderHeadingList() {
      const seen = new Map();
      matters.forEach(m => {
        const h = (m.heading || m.subject || '').trim();
        if (h && !seen.has(h.toLowerCase())) seen.set(h.toLowerCase(), h);
      });
      const el = $('headingList');
      if (el) el.innerHTML = [...seen.values()].sort((a, b) => a.localeCompare(b))
        .map(h => `<option value="${esc(h)}"></option>`).join('');
    }

    function renderFilters() {
      const opts = [
        { key: 'open', label: `Still being carried (${matters.filter(m => m.open).length})` },
        ...statuses.map(s => ({ key: s.key, label: `${s.label} (${counts[s.key] || 0})` })),
        { key: 'all', label: `Everything (${matters.length})` },
      ];
      $('filters').innerHTML = opts.map(o =>
        `<button data-f="${o.key}" class="${filter === o.key ? 'on' : ''}">${esc(o.label)}</button>`).join('');
      $('filters').querySelectorAll('button').forEach(b => {
        b.addEventListener('click', () => { filter = b.dataset.f; renderFilters(); render(); });
      });
    }

    function visible() {
      if (filter === 'all') return matters;
      if (filter === 'open') return matters.filter(m => m.open);
      return matters.filter(m => (m.status || 'open') === filter);
    }

    // The register groups by AGENDA HEADING, because that is the grain the
    // Session works in on the night: it takes "Update on Building Project", and
    // the second legal counsel and the consultants' response are sub-notes
    // beneath it. Each sub-note is cleared on its own — the heading is not a
    // record, it is a gathering — and once the last one is cleared the heading
    // stops appearing on the next agenda.
    function groupsOf(list) {
      const order = [], by = new Map();
      list.forEach(m => {
        const h = (m.heading || m.subject || '').trim();
        const key = h.toLowerCase();
        if (!by.has(key)) { by.set(key, { heading: h, matters: [] }); order.push(key); }
        by.get(key).matters.push(m);
      });
      return order.map(k => {
        const g = by.get(k);
        const openOnes = g.matters.filter(m => m.open);
        const owners = [...new Set(g.matters.map(m => (m.owner || '').trim()).filter(Boolean))];
        return {
          ...g,
          open: openOnes.length,
          // One owner across the group is the heading's owner; several means it
          // is left blank rather than naming one person for another's work.
          owner: owners.length === 1 ? owners[0] : '',
          flag: g.matters.some(m => m.flag === 'overdue') ? 'overdue'
            : g.matters.some(m => m.flag === 'stale') ? 'stale' : '',
        };
      });
    }

    function subNote(m) {
      const st = statusOf(m.status);
      // The history is what makes this a register rather than a to-do list: a
      // matter carried for six months can be read back in full.
      const hist = (m.updates || []).length
        ? `<div class="hist">${m.updates.map(u =>
            `<div><span class="when">${esc(fmtDate(u.date))}</span> — ${esc(u.note)}</div>`).join('')}</div>`
        : '';
      return `
        <div class="snote ${m.open ? '' : 'done'}">
          <div class="mhead">
            <b>${esc(m.subject)}</b>
            <span class="st ${m.status || 'open'}">${esc(st.label)}</span>
            ${m.flag ? `<span class="flag ${m.flag}" title="${m.flag === 'overdue'
                ? 'The target date has passed' : 'Carried for three meetings or more'}">${m.flag}</span>` : ''}
          </div>
          ${m.detail ? `<p style="margin:6px 0 0; font-size:13px;">${esc(m.detail)}</p>` : ''}
          ${m.decision ? `<p style="margin:6px 0 0; font-size:13px;"><b>Decision:</b> ${esc(m.decision)}</p>` : ''}
          <div class="meta">
            Raised ${esc(fmtDate(m.raisedAt)) || 'at an unrecorded meeting'}${m.age ? ` · carried through ${m.age} meeting${m.age === 1 ? '' : 's'}` : ''}
            ${m.owner ? ` · ${esc(m.owner)} to act` : ''}
            ${m.due ? ` · target ${esc(fmtDate(m.due))}` : ''}
            ${m.closedAt ? ` · closed ${esc(fmtDate(m.closedAt))}` : ''}
          </div>
          ${hist}
          ${mayEdit ? `
          <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:9px;">
            <button class="btn btn-secondary btn-sm" onclick="openUpdate(${m.id})">Record what was said</button>
            <button class="btn btn-secondary btn-sm" onclick="edit(${m.id})">Edit</button>
            ${m.open
              ? `<button class="btn btn-secondary btn-sm" onclick="setStatus(${m.id},'closed')">Mark cleared</button>`
              : `<button class="btn btn-secondary btn-sm" onclick="setStatus(${m.id},'open')">Re-open</button>`}
            <button class="btn btn-danger btn-sm" onclick="del(${m.id})">Remove</button>
          </div>` : ''}
        </div>`;
    }

    function render() {
      const list = visible();
      const groups = groupsOf(list);
      shown = groups;
      $('rows').innerHTML = groups.map((g, gi) => `
        <div class="mgroup ${g.open ? '' : 'done'}">
          <div class="ghead">
            <b>${esc(g.heading)}</b>
            ${g.flag ? `<span class="flag ${g.flag}">${g.flag}</span>` : ''}
            <span class="gcount">${g.open
              ? `${g.open} of ${g.matters.length} still open`
              : `all ${g.matters.length} cleared`}</span>
          </div>
          <div class="gmeta">
            ${g.open
              ? `Carried onto the next agenda as one line under Matters Arising${g.owner ? ` · ${esc(g.owner)}` : ''}`
              : 'Cleared — this heading will not appear on the next agenda'}
          </div>
          ${mayEdit && g.open ? `
          <div style="display:flex; gap:6px; flex-wrap:wrap; margin-top:9px;">
            <button class="btn btn-secondary btn-sm" onclick="clearHeading(${gi})">
              Clear the whole heading</button>
          </div>` : ''}
          <div class="snotes">${g.matters.map(subNote).join('')}</div>
        </div>`).join('');
      $('emptyNote').style.display = list.length ? 'none' : '';
      $('emptyNote').textContent = matters.length
        ? 'Nothing in the register under that filter.'
        : 'The register is empty. Add a matter, or bring the open items in from the last minutes.';
    }

    // Dealing with the heading deals with everything beneath it — so once the
    // Session has taken "Update on Building Project" and finished with it, the
    // Clerk clears the heading in one action rather than opening each sub-note.
    // Every open sub-note under it is closed; ones already closed are left as
    // they are, so their closing dates are not rewritten.
    async function clearHeading(gi) {
      const g = shown[gi];
      if (!g) return;
      const heading = g.heading;
      const open = g.matters.filter(m => m.open);
      if (!open.length) return;
      const what = open.length === 1
        ? `“${open[0].subject}”`
        : `all ${open.length} matters still open beneath it`;
      if (!await confirmDialog(`Clear “${heading}” — ${what}? It will stop appearing on the agenda.`)) return;
      try {
        // One at a time, so a failure part way through is visible rather than
        // leaving the register in a state nobody asked for.
        for (const m of open) {
          await api('/minutes/matters/' + m.id, { method: 'PUT', body: { status: 'closed' } });
        }
        toast(`“${heading}” cleared — ${open.length} matter${open.length === 1 ? '' : 's'}.`);
        load();
      } catch (e) { toast(e.message, true); load(); }
    }

    async function setStatus(id, status) {
      try { await api('/minutes/matters/' + id, { method: 'PUT', body: { status } }); load(); }
      catch (e) { toast(e.message, true); }
    }
    async function del(id) {
      const m = matters.find(x => x.id === id);
      if (!await confirmDialog(`Remove “${m ? m.subject : 'this matter'}” from the register? Its history goes with it.`)) return;
      try { await api('/minutes/matters/' + id, { method: 'DELETE' }); load(); }
      catch (e) { toast(e.message, true); }
    }

    // ------------------------------------------------------------ add / edit
    function statusOptions(sel) {
      return statuses.map(s => `<option value="${s.key}"${s.key === sel ? ' selected' : ''}>${esc(s.label)} — ${esc(s.note)}</option>`).join('');
    }
    function openForm(m) {
      editingId = m ? m.id : null;
      $('mTitle').textContent = m ? 'Edit the matter' : 'Add a matter';
      $('mForm').reset();
      $('fStatus').innerHTML = statusOptions(m ? m.status : 'open');
      $('fHeading').value = m ? (m.heading || '') : '';
      $('fSubject').value = m ? m.subject : '';
      $('fDetail').value = m ? (m.detail || '') : '';
      $('fOwner').value = m ? (m.owner || '') : '';
      $('fDue').value = m ? (m.due || '') : '';
      $('fRaised').value = m ? (m.raisedAt || '') : new Date().toISOString().slice(0, 10);
      $('fDecision').value = m ? (m.decision || '') : '';
      $('mOverlay').style.display = 'flex';
    }
    function edit(id) { openForm(matters.find(m => m.id === id)); }
    $('addBtn').addEventListener('click', () => openForm(null));
    $('mCancel').addEventListener('click', () => { $('mOverlay').style.display = 'none'; });
    $('mForm').addEventListener('submit', async e => {
      e.preventDefault();
      const body = {
        heading: $('fHeading').value,
        subject: $('fSubject').value, detail: $('fDetail').value, owner: $('fOwner').value,
        due: $('fDue').value, raisedAt: $('fRaised').value,
        status: $('fStatus').value, decision: $('fDecision').value,
      };
      try {
        if (editingId) await api('/minutes/matters/' + editingId, { method: 'PUT', body });
        else await api('/minutes/matters', { method: 'POST', body });
        $('mOverlay').style.display = 'none';
        load();
      } catch (err) { toast(err.message, true); }
    });

    // --------------------------------------------------- what was said today
    function openUpdate(id) {
      const m = matters.find(x => x.id === id);
      if (!m) return;
      updatingId = id;
      $('uSubject').textContent = m.subject;
      $('uForm').reset();
      $('uMeeting').innerHTML = '<option value="">— not tied to a meeting —</option>'
        + meetings.map(d => `<option value="${d.id}">${esc(fmtDate(d.date))} · ${esc(d.title || 'Session Meeting')}</option>`).join('');
      $('uStatus').innerHTML = statusOptions(m.status);
      $('uOverlay').style.display = 'flex';
    }
    $('uCancel').addEventListener('click', () => { $('uOverlay').style.display = 'none'; });
    $('uForm').addEventListener('submit', async e => {
      e.preventDefault();
      try {
        await api(`/minutes/matters/${updatingId}/update`, { method: 'POST', body: {
          note: $('uNote').value, meetingId: $('uMeeting').value || null,
        } });
        const m = matters.find(x => x.id === updatingId);
        if (m && $('uStatus').value !== m.status) {
          await api('/minutes/matters/' + updatingId, { method: 'PUT', body: { status: $('uStatus').value } });
        }
        $('uOverlay').style.display = 'none';
        load();
      } catch (err) { toast(err.message, true); }
    });

    // ------------------------------------------------ bring in from minutes
    // Two ways of finding them: the rows that already carry an unfinished
    // action, which needs no AI at all; and a reading of the whole minutes,
    // which catches what was deferred or awaited without an action being typed.
    $('pullBtn').addEventListener('click', () => {
      $('pMeeting').innerHTML = meetings.map(d =>
        `<option value="${d.id}">${esc(fmtDate(d.date))} · ${esc(d.title || 'Session Meeting')}</option>`).join('');
      proposed = []; renderProposed();
      $('pOverlay').style.display = 'flex';
    });
    $('pCancel').addEventListener('click', () => { $('pOverlay').style.display = 'none'; });

    function renderProposed() {
      $('pList').innerHTML = proposed.length
        ? proposed.map((m, i) => `
          <label class="pick">
            <input type="checkbox" ${m.already ? 'disabled' : 'checked'} onchange="proposed[${i}].take=this.checked; syncAdd();">
            <span>
              <b style="font-size:13px;">${esc(m.subject)}</b>
              ${m.already ? `<span class="st closed" style="margin-left:6px;">${m.updateOf ? 'already updated from these minutes' : 'already in the register'}</span>` : ''}
              ${m.updateOf && !m.already ? `<div style="font-size:12px; margin:3px 0;">
                <span class="st in-progress">update</span> to the matter already in the register: <b>${esc(m.updateOf.subject)}</b>${m.updateOf.heading && m.updateOf.heading !== m.updateOf.subject ? ` <span class="sub">(${esc(m.updateOf.heading)})</span>` : ''}
                <label class="sub" style="display:inline-flex; gap:4px; align-items:center; margin-left:8px; font-size:11.5px;" onclick="event.stopPropagation();">
                  <input type="checkbox" style="width:auto;" ${m.asNew ? 'checked' : ''} onchange="proposed[${i}].asNew=this.checked;"> no — it is a new matter
                </label></div>` : ''}
              ${m.heading && m.heading !== m.subject ? `<div class="sub" style="font-size:11.5px;">filed under <b>${esc(m.heading)}</b></div>` : ''}
              ${m.detail ? `<div class="sub" style="font-size:12px;">${esc(m.detail)}</div>` : ''}
              ${m.owner ? `<div class="sub" style="font-size:11.5px;">${esc(m.owner)} to act</div>` : ''}
              ${m.source ? `<div class="sub" style="font-size:11px; font-style:italic;">${esc(m.source)}</div>` : ''}
            </span>
          </label>`).join('')
        : '';
      syncAdd();
    }
    function syncAdd() {
      $('pAddBtn').disabled = !proposed.some(m => m.take && !m.already);
    }
    async function findItems(useAi) {
      const id = $('pMeeting').value;
      if (!id) { toast('Pick a set of minutes first.', true); return; }
      $('pList').innerHTML = `<p class="sub">${useAi ? 'Reading the minutes…' : 'Looking…'}</p>`;
      try {
        const r = useAi
          ? await api(`/minutes/matters/propose/${id}`, { method: 'POST' })
          : await api(`/minutes/matters/from/${id}`);
        proposed = (r.found || []).map(m => ({ ...m, take: !m.already }));
        renderProposed();
        // Claude's answer reached its length limit. Everything listed is
        // complete and real; there may be more after it. Adding these and
        // reading again picks up the rest (anything added shows as "already
        // in the register").
        if (r.truncated && proposed.length) {
          $('pList').insertAdjacentHTML('afterbegin', `<p class="sub" style="background:rgba(255,179,0,.12); border-radius:6px; padding:8px 10px; margin:0 0 8px;">These minutes are long, and Claude\u2019s list stopped after ${proposed.length} matter${proposed.length === 1 ? '' : 's'}. Everything below is complete, but there may be more. Add these, then <b>read with AI</b> again to pick up the rest.</p>`);
        }
        if (!proposed.length) {
          $('pList').innerHTML = `<p class="sub">Nothing outstanding found in those minutes${useAi ? '' : ' — try reading the whole minutes'}.</p>`;
        }
      } catch (e) { $('pList').innerHTML = ''; toast(e.message, true); }
    }
    // ---- Decisions register --------------------------------------------
    let decTimer = null;
    async function loadDecisions() {
      const q = ($('decQ') && $('decQ').value || '').trim();
      try {
        const r = await api('/minutes/decisions' + (q ? '?q=' + encodeURIComponent(q) : ''));
        const fmt = d => { try { return new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return d; } };
        $('decRows').innerHTML = r.decisions.length
          ? `<table><thead><tr><th style="width:110px;">Meeting</th><th style="width:70px;">Item</th><th>Decision</th></tr></thead><tbody>` +
            r.decisions.map(d => `<tr><td>${esc(fmt(d.date))}</td><td class="mono">${esc(d.no)}</td>
              <td>${d.kind === 'motion' ? `<span class="badge ${d.result === 'carried' ? 'badge-done' : d.result === 'lost' ? 'badge-critical' : 'badge-idle'}" style="font-size:10.5px;">${esc({ carried: 'Carried', lost: 'Lost', withdrawn: 'Withdrawn', deferred: 'Deferred', pending: 'Not yet put' }[d.result] || d.result)}${d.unanimous ? ' · unanimous' : d.votes && d.votes.for != null ? ` · ${d.votes.for}–${d.votes.against || 0}${d.votes.abstain ? ', ' + d.votes.abstain + ' abst.' : ''}` : ''}</span> That ` : ''}${esc(d.text)}<div class="sub" style="font-size:11px;">${esc(d.subject)}${d.kind === 'motion' ? ` \u00b7 moved by ${esc(d.movedBy || '—')}${d.secondedBy ? ', seconded by ' + esc(d.secondedBy) : ''}` : ''}${d.labelled ? '' : ' \u00b7 <i>from the prose</i>'}</div></td></tr>`).join('') +
            '</tbody></table>' + (r.total > r.decisions.length ? `<p class="sub">Showing ${r.decisions.length} of ${r.total}. Search to narrow.</p>` : '')
          : `<p class="sub">${q ? 'No decision matches that.' : 'No decisions recorded yet.'}</p>`;
      } catch (e) { $('decRows').innerHTML = `<p class="sub">${esc(e.message)}</p>`; }
    }
    if ($('decQ')) $('decQ').addEventListener('input', () => { clearTimeout(decTimer); decTimer = setTimeout(loadDecisions, 300); });

    $('pScanBtn').addEventListener('click', () => findItems(false));
    $('pAiBtn').addEventListener('click', () => findItems(true));
    $('pAddBtn').addEventListener('click', async () => {
      const take = proposed.filter(m => m.take && !m.already);
      if (!take.length) return;
      try {
        const r = await api(`/minutes/matters/from/${$('pMeeting').value}`, { method: 'POST', body: { matters: take } });
        $('pOverlay').style.display = 'none';
        const msg = [r.added ? `${r.added} new matter${r.added === 1 ? '' : 's'} added` : '', r.updated ? `${r.updated} existing matter${r.updated === 1 ? '' : 's'} updated` : ''].filter(Boolean).join(', ');
        toast(msg ? msg + '.' : 'Nothing new to add.');
        load();
      } catch (e) { toast(e.message, true); }
    });

    (async () => {
      me = await requireAuthAndRenderShell('/session-matters.html');
      if (!me) return;
      try {
        meetings = await api('/minutes');
        const comp = await api('/minutes/composition');
        roster = comp.members || [];
        $('ownerList').innerHTML = roster
          .filter(m => m.active !== false)
          .map(m => `<option value="${esc(m.displayName || m.name)}"></option>`).join('');
      } catch (e) {}
      load();
      loadDecisions();
    })();
