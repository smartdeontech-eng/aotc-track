// AOTC Track — the correspondence inbox.
//
// The Church Administrator scans each letter in as it arrives; Claude drafts
// its heading, summary and suggested Action straight away. The Session Clerk
// then sorts every letter: for the Session, or handled without it. The ones for
// the Session wait here until he opens the next set of minutes and brings them
// in from the Correspondence tab. Nothing is deleted when a letter moves on —
// the "Tabled" tab shows where each one went.
    let me, letters = [], counts = {}, nextMeeting = '', canSort = false, aiOn = false;
    let view = 'new';
    const $ = id => document.getElementById(id);
    const VIEWS = [
      { key: 'new', label: 'To be sorted' },
      { key: 'session', label: 'For the Session' },
      { key: 'handled', label: 'Handled without the Session' },
      { key: 'tabled', label: 'Tabled' },
    ];
    const ACTION_HINTS = ['Approved', 'Not approved', 'Administrative', 'Acknowledged', 'Noted', 'To be announced', 'Deferred',
      'Referred to the Committee on Welfare', 'Forwarded to SMC', 'For decision'];
    const STATUS_LABEL = { new: 'To be sorted', session: 'For the Session', handled: 'Handled', tabled: 'Tabled' };
    function day(iso) { return iso ? fmtDate(iso) : ''; }
    function todayKey() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

    async function load() {
      const d = await api('/minutes/correspondence/inbox');
      letters = d.letters || [];
      counts = d.counts || {};
      nextMeeting = d.nextMeeting || '';
      canSort = !!d.canSort;
      aiOn = !!d.aiEnabled;
      render();
    }

    // Due before the Session next sits — somebody has to act on it sooner.
    function isSoon(c) {
      if (!c.eventDate || c.status === 'tabled' || c.status === 'handled') return false;
      if (c.eventDate < todayKey()) return false;
      return !nextMeeting || c.eventDate < nextMeeting;
    }

    function render() {
      const tabledN = letters.filter(c => c.status === 'tabled').length;
      $('filters').innerHTML = VIEWS.map(v => {
        const n = v.key === 'tabled' ? tabledN : (counts[v.key] || 0);
        return `<button class="${view === v.key ? 'on' : ''}" onclick="setView('${v.key}')">${v.label}<span class="n">${n}</span></button>`;
      }).join('');
      const soon = letters.filter(isSoon).length;
      $('lead').innerHTML = [
        nextMeeting ? `Next Session meeting: <b>${esc(fmtDateLong(nextMeeting))}</b>.` : 'No Session meeting is set up yet.',
        soon ? `<span class="soon">${soon} due before it</span>` : '',
        canSort ? '' : 'The Session Clerk sorts each letter once it is scanned in.',
      ].filter(Boolean).join(' ');
      const list = letters.filter(c => c.status === view);
      $('emptyNote').style.display = list.length ? 'none' : '';
      $('emptyNote').textContent = {
        new: 'Nothing waiting to be sorted. Press “Scan a letter” when one arrives.',
        session: 'No letters waiting for the Session.',
        handled: 'No letters handled without the Session yet.',
        tabled: 'No letters from the inbox have been brought into minutes yet.',
      }[view];
      $('list').innerHTML = list.map(card).join('');
      $('actionList').innerHTML = ACTION_HINTS.map(a => `<option value="${esc(a)}"></option>`).join('');
    }
    function setView(v) { view = v; render(); }

    function pageStrip(c, editable) {
      const n = c.pages || 0;
      if (!n) return '<span class="sub" style="font-size:11.5px;">No pages attached yet.</span>';
      const files = (c.files && c.files.length) ? c.files : (c.file ? [c.file] : []);
      return Array.from({ length: n }, (_, i) => {
        const f = files[i] || {};
        const url = `/api/minutes/correspondence/${c.id}/file/${i}`;
        const isPdf = String(f.mimetype || '').includes('pdf');
        return `<figure class="pg"><a href="${url}" target="_blank" title="Open page ${i + 1}">${isPdf ? '<div class="pg-pdf">PDF</div>' : `<img src="${url}" alt="Page ${i + 1}" loading="lazy">`}</a>
          <figcaption>Page ${i + 1}</figcaption>
          ${editable ? `<button type="button" class="pg-x" onclick="dropPage(${c.id},${i})" title="Remove this page">✕</button>` : ''}</figure>`;
      }).join('');
    }

    function card(c) {
      const editable = c.status !== 'tabled';
      const where = c.status === 'tabled'
        ? `Tabled at the meeting of ${esc(day(c.meetingDate))}`
        : c.status === 'handled' ? `Handled without the Session${c.handledNote ? ' — ' + esc(c.handledNote) : ''}` : '';
      const meta = [
        c.receivedOn ? `Received ${esc(day(c.receivedOn))}` : '',
        c.addedBy ? `scanned in by ${esc(c.addedBy)}` : '',
        c.returnedFrom ? `sent back from the minutes of ${esc(day(c.returnedFrom.date))}` : '',
      ].filter(Boolean).join(' · ');
      const head = `<div class="lhead"><b>${esc(c.heading || 'Untitled')}</b>
          <span class="st ${c.status}">${STATUS_LABEL[c.status]}</span>
          ${isSoon(c) ? `<span class="soon">${esc(day(c.eventDate))} — before the next meeting</span>` : ''}</div>
        <div class="meta">${meta}${where ? ' · ' + where : ''}</div>`;
      if (!editable) {
        return `<div class="letter ro">${head}
          <p>${esc(c.summary || '')}</p>
          ${c.action ? `<p class="sub">Action: ${esc(c.action)}</p>` : ''}
          <div class="page-strip">${pageStrip(c, false)}</div></div>`;
      }
      return `<div class="letter">${head}
        <div class="field-row" style="margin-top:10px;">
          <div class="field"><label>Heading</label>
            <input type="text" value="${esc(c.heading || '')}" onchange="setField(${c.id},'heading',this.value)"></div>
          <div class="field"><label>From</label>
            <input type="text" value="${esc(c.from || '')}" placeholder="e.g. Ga West Presbytery" onchange="setField(${c.id},'from',this.value)"></div>
        </div>
        <div class="field"><label>Summary (as it will read in the minutes)</label>
          <textarea rows="4" onchange="setField(${c.id},'summary',this.value)">${esc(c.summary || '')}</textarea></div>
        <div class="field-row">
          <div class="field"><label>Suggested Action</label>
            <input type="text" list="actionList" value="${esc(c.action || '')}" placeholder="${c.actionSuggested ? `Claude suggests: ${esc(c.actionSuggested)} — type it to use it` : 'Leave for the Session Clerk, or e.g. Acknowledged'}" onchange="setField(${c.id},'action',this.value)"></div>
          <div class="field"><label>Date on the letter</label>
            <input type="date" value="${esc(c.letterDate || '')}" onchange="setField(${c.id},'letterDate',this.value)"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Received on</label>
            <input type="date" value="${esc(c.receivedOn || '')}" onchange="setField(${c.id},'receivedOn',this.value)"></div>
          <div class="field"><label>Happening on / reply needed by</label>
            <input type="date" value="${esc(c.eventDate || '')}" onchange="setField(${c.id},'eventDate',this.value)">
            <p class="sub" style="margin:4px 0 0;font-size:11.5px;">The funeral, programme or deadline. Flagged when it falls before the next meeting.</p></div>
        </div>
        <div class="field"><label>Pages${c.pages ? ' — ' + c.pages : ''}</label>
          <div class="page-strip">${pageStrip(c, true)}</div></div>
        <div class="acts">
          <button class="btn btn-secondary btn-sm" onclick="morePages(${c.id})">+ Add pages</button>
          <button class="btn btn-secondary btn-sm" onclick="draft(${c.id})" ${aiOn && c.pages ? '' : 'disabled'}>✨ Draft again from the pages</button>
          <span class="muted" id="busy${c.id}"></span>
          <button class="btn btn-danger btn-sm" style="margin-left:auto;" onclick="delLetter(${c.id})">Delete</button>
        </div>
        ${canSort ? `<div class="sortbar"><span class="sub" style="font-size:12px;">Sort:</span>
          ${c.status !== 'session' ? `<button class="btn btn-primary btn-sm" onclick="sortTo(${c.id},'session')">For the Session</button>` : ''}
          ${c.status !== 'handled' ? `<button class="btn btn-secondary btn-sm" onclick="sortTo(${c.id},'handled')">Handle without the Session</button>` : ''}
          ${c.status !== 'new' ? `<button class="btn btn-secondary btn-sm" onclick="sortTo(${c.id},'new')">Back to “To be sorted”</button>` : ''}
        </div>` : ''}
      </div>`;
    }

    function find(id) { return letters.find(x => x.id === id); }
    async function setField(id, key, value) {
      const c = find(id); if (!c) return;
      c[key] = value;
      try { await api('/minutes/correspondence/' + id, { method: 'PUT', body: { [key]: value } }); }
      catch (e) { toast(e.message, true); }
      if (key === 'eventDate' || key === 'heading') render();
    }

    async function draft(id, quiet) {
      const c = find(id); if (!c) return;
      const busy = $('busy' + id);
      if (busy) busy.textContent = `Reading ${c.pages} page${c.pages === 1 ? '' : 's'}…`;
      try {
        const d = await api(`/minutes/correspondence/${id}/draft`, { method: 'POST', body: {} });
        const patch = {
          heading: d.heading || c.heading, summary: d.summary || c.summary, from: d.from || c.from,
          action: d.action || c.action, actionSuggested: d.actionSuggested || '', letterDate: d.letterDate || c.letterDate,
          eventDate: d.eventDate || c.eventDate || '', draftedByAi: true,
        };
        Object.assign(c, patch);
        await api('/minutes/correspondence/' + id, { method: 'PUT', body: patch });
        render();
        if (!quiet) toast('Draft ready — please check it against the letter.');
        return true;
      } catch (e) {
        if (busy) busy.textContent = '';
        toast(e.message, true);
        return false;
      }
    }

    // ---------------------------------------------------------------- the tray
    // "+ Scan a letter" and "+ Add pages" open a tray instead of uploading at
    // once: take the pages one photo at a time (phone camera) or pick files,
    // see them as thumbnails, remove or reorder, then upload them together as
    // ONE letter. Big phone photos are shrunk here first. The tray is kept in
    // the browser (IndexedDB) after every change, because a phone often
    // reloads the page behind the camera — the pages are put back.
    const TRAY_MAX = 10;                 // the server's limit per letter (MAX_PAGES)
    const SHRINK_OVER = 900 * 1024;      // photos above this are scaled down…
    const SHRINK_TO = 2000;              // …to this many pixels on the long side
    let tray = null;                     // { target: letterId|null, pages: [{ name, type, blob, url }] }

    const trayDb = () => new Promise((res, rej) => {
      if (!window.indexedDB) { rej(new Error('no IndexedDB')); return; }
      const r = indexedDB.open('aotc-tray', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('tray');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    async function traySave() {
      try {
        const db = await trayDb();
        const tx = db.transaction('tray', 'readwrite');
        if (tray && tray.pages.length) tx.objectStore('tray').put({ target: tray.target, pages: tray.pages.map(p => ({ name: p.name, type: p.type, blob: p.blob })) }, 'current');
        else tx.objectStore('tray').delete('current');
      } catch (e) { /* private browsing: the tray simply is not kept */ }
    }
    async function trayLoadSaved() {
      try {
        const db = await trayDb();
        return await new Promise(res => {
          const g = db.transaction('tray').objectStore('tray').get('current');
          g.onsuccess = () => res(g.result || null);
          g.onerror = () => res(null);
        });
      } catch (e) { return null; }
    }

    // A photo over the limit becomes a JPEG at most SHRINK_TO px on its long
    // side, turned the right way up. PDFs, and anything the browser cannot
    // draw, go up as they are.
    async function shrink(file) {
      if (!/^image\//.test(file.type) || file.size <= SHRINK_OVER || file.type === 'image/gif') return file;
      try {
        let img;
        try { img = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
        catch (e) {
          img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = URL.createObjectURL(file); });
        }
        const w = img.width, h = img.height, k = Math.min(1, SHRINK_TO / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.round(w * k); c.height = Math.round(h * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
        if (!blob || blob.size >= file.size) return file;
        return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
      } catch (e) { return file; }
    }

    function openTray(target) {
      tray = { target: target || null, pages: [] };
      renderTray();
      $('trayOverlay').style.display = 'flex';
    }
    async function trayAdd(fileList) {
      const files = [...(fileList || [])];
      if (!tray || !files.length) return;
      const room = TRAY_MAX - tray.pages.length;
      if (room <= 0) { toast(`A letter can have at most ${TRAY_MAX} pages.`, true); return; }
      if (files.length > room) toast(`Only ${room} more page${room === 1 ? '' : 's'} fit — a letter can have at most ${TRAY_MAX}.`, true);
      $('trayNote').textContent = 'Preparing…';
      for (const f of files.slice(0, room)) {
        if (!/^image\//.test(f.type) && f.type !== 'application/pdf') { toast(`${f.name} is not a photo or a PDF.`, true); continue; }
        const s = await shrink(f);
        tray.pages.push({ name: s.name, type: s.type, blob: s, url: URL.createObjectURL(s) });
      }
      $('trayNote').textContent = '';
      renderTray();
      traySave();
    }
    function trayMove(i, d) {
      const j = i + d;
      if (!tray || j < 0 || j >= tray.pages.length) return;
      [tray.pages[i], tray.pages[j]] = [tray.pages[j], tray.pages[i]];
      renderTray(); traySave();
    }
    function trayDrop(i) {
      if (!tray) return;
      const [p] = tray.pages.splice(i, 1);
      if (p && p.url) URL.revokeObjectURL(p.url);
      renderTray(); traySave();
    }
    function renderTray() {
      if (!tray) return;
      const c = tray.target ? find(tray.target) : null;
      const n = tray.pages.length;
      $('trayTitle').textContent = c ? `Add pages to “${c.heading || 'this letter'}”` : 'Scan a letter';
      $('trayCount').textContent = n ? `${n} of ${TRAY_MAX} pages` : 'No pages yet — take a photo of each page, or choose files.';
      $('trayPages').innerHTML = tray.pages.map((p, i) => `
        <figure class="tp">
          ${/pdf/.test(p.type) ? '<div class="pg-pdf">PDF</div>' : `<img src="${p.url}" alt="Page ${i + 1}">`}
          <figcaption>Page ${i + 1}${p.blob && p.blob.size ? ` · ${Math.max(1, Math.round(p.blob.size / 1024))} KB` : ''}</figcaption>
          <div class="tp-acts">
            <button type="button" onclick="trayMove(${i},-1)" ${i ? '' : 'disabled'} title="Earlier" aria-label="Move page ${i + 1} earlier">◀</button>
            <button type="button" onclick="trayDrop(${i})" title="Remove" aria-label="Remove page ${i + 1}">✕</button>
            <button type="button" onclick="trayMove(${i},1)" ${i < n - 1 ? '' : 'disabled'} title="Later" aria-label="Move page ${i + 1} later">▶</button>
          </div>
        </figure>`).join('');
      $('trayGo').disabled = !n;
      $('trayGo').textContent = !n ? (c ? 'Add pages' : 'Upload') : c ? `Add ${n} page${n === 1 ? '' : 's'}` : `Upload ${n} page${n === 1 ? '' : 's'} as one letter`;
      $('trayCam').disabled = $('trayPick').disabled = n >= TRAY_MAX;
    }
    async function trayClose(ask) {
      if (ask && tray && tray.pages.length && !await confirmDialog(`Put away the ${tray.pages.length} page${tray.pages.length === 1 ? '' : 's'} without uploading?`, { okText: 'Discard them', danger: true })) return;
      if (tray) tray.pages.forEach(p => p.url && URL.revokeObjectURL(p.url));
      tray = null;
      $('trayOverlay').style.display = 'none';
      traySave();
    }
    async function trayUpload() {
      if (!tray || !tray.pages.length) return;
      const target = tray.target;
      const fd = new FormData();
      tray.pages.forEach(p => fd.append('letter', p.blob, p.name));
      if (!target) fd.append('receivedOn', todayKey());
      const n = tray.pages.length;
      $('trayGo').disabled = true;
      $('trayGo').textContent = `Uploading ${n} page${n === 1 ? '' : 's'}…`;
      try {
        const res = await fetch(target ? `/api/minutes/correspondence/${target}/pages` : '/api/minutes/correspondence/inbox',
          { method: 'POST', body: fd, credentials: 'same-origin' });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Could not upload the pages.');
        await trayClose(false);
        if (target) {
          const c = find(target);
          Object.assign(c, d, { pages: (d.files || []).length, status: c.status });
          render();
          toast(`${n} page${n === 1 ? '' : 's'} added.`);
          return;
        }
        letters.unshift(d);
        counts.new = (counts.new || 0) + 1;
        view = 'new'; render();
        if (aiOn) { toast('Drafting the summary…'); await draft(d.id, true); toast('Letter scanned in and drafted — check the summary.'); }
        else toast('Letter scanned in. Type its heading and summary.');
      } catch (err) {
        toast(err.message, true);
        renderTray();
      }
    }

    $('scanBtn').addEventListener('click', () => openTray(null));
    $('trayCam').addEventListener('click', () => $('trayCamIn').click());
    $('trayPick').addEventListener('click', () => $('trayPickIn').click());
    ['trayCamIn', 'trayPickIn'].forEach(id => $(id).addEventListener('change', async e => { const f = e.target.files; await trayAdd(f); e.target.value = ''; }));
    $('trayGo').addEventListener('click', trayUpload);
    $('trayCancel').addEventListener('click', () => trayClose(true));
    $('trayOverlay').addEventListener('mousedown', e => { if (e.target === $('trayOverlay')) trayClose(true); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && tray) trayClose(true); });
    $('cxBtn').addEventListener('click', () => {
      const v = VIEWS.find(x => x.key === view);
      openCorrExport({ scope: 'inbox', view }, (v ? v.label : 'letters').toLowerCase().replace(/^./, c => c.toUpperCase()));
    });

    function morePages(id) { openTray(id); }
    async function dropPage(id, i) {
      if (!await confirmDialog('Remove this page from the letter?')) return;
      try {
        const d = await api(`/minutes/correspondence/${id}/pages/${i}`, { method: 'DELETE' });
        const c = find(id);
        Object.assign(c, d, { pages: (d.files || []).length, status: c.status });
        render();
      } catch (e) { toast(e.message, true); }
    }
    async function delLetter(id) {
      if (!await confirmDialog('Delete this letter and its pages? Use this only for a letter scanned in by mistake.', { danger: true, okText: 'Delete' })) return;
      try {
        await api('/minutes/correspondence/' + id, { method: 'DELETE' });
        const c = find(id);
        letters = letters.filter(x => x.id !== id);
        if (c) counts[c.status] = Math.max(0, (counts[c.status] || 1) - 1);
        render();
      } catch (e) { toast(e.message, true); }
    }
    async function sortTo(id, to) {
      let note = '';
      if (to === 'handled') {
        const ans = await formDialog('Handle without the Session', [{
          name: 'note', label: 'How was it handled? (optional)', type: 'text', value: '',
        }], { okText: 'Mark as handled' });
        if (!ans) return;
        note = ans.note || '';
      }
      try {
        const d = await api(`/minutes/correspondence/${id}/sort`, { method: 'POST', body: { to, note } });
        const c = find(id);
        if (c) { counts[c.status] = Math.max(0, (counts[c.status] || 1) - 1); Object.assign(c, d); counts[to] = (counts[to] || 0) + 1; }
        render();
        toast(to === 'session' ? 'Waiting for the Session — bring it in from the minutes’ Correspondence tab.'
          : to === 'handled' ? 'Marked as handled without the Session.' : 'Back in “To be sorted”.');
      } catch (e) { toast(e.message, true); }
    }

    (async () => {
      me = await requireAuthAndRenderShell('/correspondence.html');
      if (!me) return;
      try { await load(); } catch (e) { $('list').innerHTML = `<p class="sub">${esc(e.message)}</p>`; }
      // Pages left in the tray when the phone reloaded the page behind the camera.
      const saved = await trayLoadSaved();
      if (saved && saved.pages && saved.pages.length) {
        tray = { target: saved.target && find(saved.target) ? saved.target : null,
          pages: saved.pages.map(p => ({ ...p, url: URL.createObjectURL(p.blob) })) };
        renderTray();
        $('trayOverlay').style.display = 'flex';
        toast(`${tray.pages.length} page${tray.pages.length === 1 ? '' : 's'} put back in the tray.`);
      }
    })();
