// Elections — the live display (/live/<token>) for screens in the hall and
// for anyone given the link. Updates arrive by Server-Sent Events, the same
// way DeonTech Pulse does it; if the stream cannot connect (an old browser or
// a proxy that buffers), the page falls back to asking every 5 seconds.
(function () {
  'use strict';
  const TOKEN = location.pathname.split('/').filter(Boolean)[1] || new URLSearchParams(location.search).get('d') || '';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = n => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  const fmtT = iso => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
  const fmtDT = iso => iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }) : '';

  let snap = null, skew = 0, es = null, poll = null, lastAt = 0;

  function countdown() {
    if (!snap) return '';
    const e = snap.election, now = Date.now() + skew;
    const fmt = ms => {
      const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
      return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}:${String(x).padStart(2, '0')}`;
    };
    if (e.status === 'open' && e.closeAt) return `Polls close in ${fmt(new Date(e.closeAt) - now)}`;
    if (e.status === 'confirmed' && e.openAt) return `Polls open in ${fmt(new Date(e.openAt) - now)}`;
    return '';
  }

  function pill(e) {
    const p = $('lvPill');
    p.className = 'live-pill' + (e.status === 'open' ? ' open' : ['closed', 'certified'].includes(e.status) ? ' closed' : '');
    p.innerHTML = e.status === 'open' ? '<span class="live-dot"></span>POLLS OPEN'
      : e.status === 'certified' ? 'RESULTS CERTIFIED'
      : e.status === 'closed' ? 'POLLS CLOSED'
      : 'NOT YET OPEN';
  }

  function face(o) {
    return o.photo ? `<img src="${esc(o.photo)}" alt="">` : `<span class="ph">${esc(initials(o.name))}</span>`;
  }
  function resultsHtml(s) {
    if (!s.results) {
      return `<div class="live-hidden">Results will show here when polls close.<br>Until then only the number of votes cast is shown, so every vote stays secret.</div>`;
    }
    if (!s.results.length) return '<div class="live-hidden">No positions on this ballot.</div>';
    return s.results.map(p => {
      if (p.mode === 'pick') {
        const top = Math.max(1, ...p.options.map(o => o.votes));
        return `<div class="live-pos"><div class="live-pos-title">${esc(p.title)}${p.seats > 1 ? ` <span style="opacity:.7;font-weight:600">· ${p.seats} seats</span>` : ''}</div>
          ${p.options.map(o => `<div class="live-cand">${face(o)}<div><div>${esc(o.name)}${o.leading ? ' <span style="color:#FFD54F">●</span>' : ''}</div>
            <div class="bar"><span style="width:${(o.votes / top) * 100}%"></span></div></div>
            <div class="n">${o.votes}<div style="font-size:.6em;opacity:.7;font-weight:600">${o.pct}%</div></div></div>`).join('')}
          ${p.tieAtCut && s.election.status !== 'open' ? '<div style="opacity:.8;font-size:.9em">Tie at the cut-off — to be settled by the officers.</div>' : ''}</div>`;
      }
      return `<div class="live-pos"><div class="live-pos-title">${esc(p.title)} <span style="opacity:.7;font-weight:600">· unopposed</span></div>
        ${p.options.map(o => {
          const tot = Math.max(1, o.yes + o.no);
          return `<div class="live-cand">${face(o)}<div><div>${esc(o.name)}</div>
            <div class="bar"><span style="width:${(o.yes / tot) * 100}%;background:#00C853"></span></div></div>
            <div class="n">${o.yes} <span style="opacity:.6">Yes</span> · ${o.no} <span style="opacity:.6">No</span></div></div>`;
        }).join('')}</div>`;
    }).join('');
  }

  function render(s) {
    snap = s; lastAt = Date.now();
    if (s.serverTime) skew = new Date(s.serverTime).getTime() - Date.now();
    const e = s.election;
    $('lvTitle').textContent = e.title;
    $('lvGroup').textContent = [e.entityName, e.status === 'open' ? `Polls close ${fmtDT(e.closeAt)}` : e.status === 'confirmed' ? `Polls open ${fmtDT(e.openAt)}` : e.closedAt ? `Polls closed ${fmtDT(e.closedAt)}` : ''].filter(Boolean).join(' · ');
    document.title = `${e.title} — live`;
    pill(e);
    const boothRows = s.booths.length
      ? s.booths.map(b => `<div class="live-booth"><span>${esc(b.name)}${b.enabled ? '' : ' <span style="opacity:.6">(off)</span>'}</span><b>${b.votes}</b></div>`).join('')
      : '<div class="live-booth"><span>No booths set up</span><b>—</b></div>';
    $('lvBody').innerHTML = `<div class="live-grid">
      <div class="live-panel">
        <div class="live-label">Votes cast</div>
        <div class="live-big">${s.voted.toLocaleString('en-GB')}</div>
        <div class="live-of">of ${s.eligible.toLocaleString('en-GB')} eligible voters · <b>${s.turnoutPct}%</b> turnout</div>
        <div class="live-bar"><span style="width:${Math.min(100, s.turnoutPct)}%"></span></div>
        <div class="live-stats">
          <div><b>${s.byChannel.booth}</b>at the booths</div>
          <div><b>${s.byChannel.online}</b>online</div>
          <div><b>${s.lastVoteAt ? esc(fmtT(s.lastVoteAt)) : '—'}</b>last vote</div>
          <div><b id="lvCount">${esc(countdown()) || '—'}</b>&nbsp;</div>
        </div>
        <div class="live-label" style="margin-top:1.6vw">By booth</div>
        ${boothRows}
      </div>
      <div class="live-panel">
        <div class="live-label">${s.results ? (['closed', 'certified'].includes(e.status) ? 'Results' : 'Live tally') : 'Results'}</div>
        ${resultsHtml(s)}
      </div>
    </div>`;
  }

  function setConn(txt) { $('lvConn').textContent = txt; }
  function gone() {
    if (es) es.close();
    clearInterval(poll);
    $('lvBody').innerHTML = '<div class="live-hidden">This display link has been replaced. Ask the election officer for the new link.</div>';
    $('lvPill').textContent = 'LINK REPLACED'; $('lvPill').className = 'live-pill';
    setConn('Disconnected');
  }

  async function pollOnce() {
    try {
      const r = await fetch(`/api/vote/live/${encodeURIComponent(TOKEN)}`, { cache: 'no-store' });
      if (r.status === 404) return gone();
      if (!r.ok) throw new Error();
      render(await r.json());
      setConn('Updating every 5 seconds');
    } catch (e) { setConn('Reconnecting…'); }
  }
  function startPolling() {
    if (poll) return;
    pollOnce();
    poll = setInterval(pollOnce, 5000);
  }

  function connect() {
    if (!window.EventSource) return startPolling();
    es = new EventSource(`/api/vote/stream/${encodeURIComponent(TOKEN)}`);
    let opened = false;
    es.addEventListener('snapshot', ev => {
      opened = true;
      if (poll) { clearInterval(poll); poll = null; }
      try { render(JSON.parse(ev.data)); } catch (e) {}
      setConn('Live');
    });
    es.addEventListener('gone', gone);
    es.onerror = () => {
      // EventSource retries by itself; meanwhile keep the screen fresh by polling.
      setConn(opened ? 'Reconnecting…' : 'Connecting…');
      startPolling();
    };
    // If no snapshot has arrived in 8 s, the stream is being buffered somewhere.
    setTimeout(() => { if (!opened) startPolling(); }, 8000);
  }

  // Clock and countdown tick every second; a stalled stream falls back to polling.
  setInterval(() => {
    $('lvClock').textContent = new Date(Date.now() + skew).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    const c = $('lvCount'); if (c) c.textContent = countdown() || '—';
    if (lastAt && Date.now() - lastAt > 70000) startPolling();
  }, 1000);

  if (!TOKEN) { $('lvTitle').textContent = 'No display link'; return; }
  connect();
})();
