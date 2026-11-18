// AOTC Track Home (redesigned Oct 2026).
// Top to bottom: greeting with search and New · verse of the day and the
// quarter · "Needs you" (what is waiting on this person, most urgent first) ·
// "Coming up" (the next fortnight) · the numbers that matter this quarter ·
// charts and the report board · quick actions.
// Everything is best-effort: a part that cannot load is left out, never the
// whole page. All of it sits inside one function so nothing clashes with app.js.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Verse of the day — rotates daily through a curated list (KJV, public domain).
  const VERSES = [
    { t: 'I was glad when they said unto me, Let us go into the house of the LORD.', r: 'Psalm 122:1' },
    { t: 'This is the day which the LORD hath made; we will rejoice and be glad in it.', r: 'Psalm 118:24' },
    { t: 'And whatsoever ye do, do it heartily, as to the Lord, and not unto men.', r: 'Colossians 3:23' },
    { t: 'Trust in the LORD with all thine heart; and lean not unto thine own understanding.', r: 'Proverbs 3:5' },
    { t: 'But they that wait upon the LORD shall renew their strength; they shall mount up with wings as eagles.', r: 'Isaiah 40:31' },
    { t: 'Be strong and of a good courage; be not afraid... for the LORD thy God is with thee whithersoever thou goest.', r: 'Joshua 1:9' },
    { t: 'Except the LORD build the house, they labour in vain that build it.', r: 'Psalm 127:1' },
    { t: 'Let your light so shine before men, that they may see your good works, and glorify your Father which is in heaven.', r: 'Matthew 5:16' },
    { t: 'Be ye stedfast, unmoveable, always abounding in the work of the Lord, forasmuch as ye know that your labour is not in vain in the Lord.', r: '1 Corinthians 15:58' },
    { t: 'And let us not be weary in well doing: for in due season we shall reap, if we faint not.', r: 'Galatians 6:9' },
    { t: 'The joy of the LORD is your strength.', r: 'Nehemiah 8:10' },
    { t: 'Behold, how good and how pleasant it is for brethren to dwell together in unity!', r: 'Psalm 133:1' },
    { t: 'He hath shewed thee, O man, what is good... to do justly, and to love mercy, and to walk humbly with thy God.', r: 'Micah 6:8' },
    { t: 'Not slothful in business; fervent in spirit; serving the Lord.', r: 'Romans 12:11' },
    { t: 'Rejoice evermore. Pray without ceasing. In every thing give thanks.', r: '1 Thessalonians 5:16–18' },
    { t: 'I can do all things through Christ which strengtheneth me.', r: 'Philippians 4:13' },
    { t: 'Thy word is a lamp unto my feet, and a light unto my path.', r: 'Psalm 119:105' },
    { t: 'Commit thy works unto the LORD, and thy thoughts shall be established.', r: 'Proverbs 16:3' },
  ];
  const dayOfYear = () => Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);

  // ---- small helpers ---------------------------------------------------------
  const p2 = n => String(n).padStart(2, '0');
  const keyOf = d => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const plusDays = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
  const fromKey = k => new Date(`${k}T12:00:00`);
  const fmtShort = d => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  const fmtDM = d => d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const fmtTime = t => {
    if (/[ap]m\s*$/i.test(String(t || '').trim())) return String(t).trim();   // already "1:00 pm" (Church Diary)
    const m = String(t || '').match(/^(\d{1,2}):(\d{2})/); if (!m) return '';
    const h = Number(m[1]); return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
  };
  const num = n => Number(n || 0).toLocaleString();

  const ICON = {
    calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
    mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
    doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 15l2 2 4-4',
    people: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM20 8v6M23 11h-6',
    check: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
    ballot: 'M9 12l2 2 4-4M5 7h14l-1 13H6L5 7zM8 7V4h8v3',
    chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
    unlock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 7.5-2',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICON[k] || ICON.check}"/></svg>`;

  // Numbers count up once, as the cards rise in.
  function countUp(root) {
    (root || document).querySelectorAll('[data-count]').forEach(el => {
      const to = Number(el.dataset.count) || 0;
      if (reduce() || to < 2) { el.textContent = num(to); return; }
      const t0 = performance.now();
      const step = t => { const k = Math.min(1, (t - t0) / 900), e = 1 - Math.pow(1 - k, 3); el.textContent = num(Math.round(to * e)); if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  }
  function fillBars(root) {
    requestAnimationFrame(() => setTimeout(() => (root || document).querySelectorAll('.hm-bar > div[data-w]').forEach(b => { b.style.width = Math.max(0, Math.min(100, Number(b.dataset.w) || 0)) + '%'; }), 60));
  }
  function spark(values, color) {
    const v = (values || []).filter(x => Number.isFinite(x));
    if (v.length < 2) return '';
    const max = Math.max(...v), min = Math.min(...v), span = max - min || 1;
    const pts = v.map((x, i) => `${2 + i * (80 / (v.length - 1))},${26 - ((x - min) / span) * 22}`).join(' ');
    return `<svg class="hm-spark" width="84" height="30" viewBox="0 0 84 30" aria-hidden="true"><polyline fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="${pts}"/></svg>`;
  }
  // Bars for a trend: the latest bar in full colour, the rest softer; an
  // average line; each bar's figure above it and its date below.
  function bars(points, opts = {}) {
    if (!points || !points.length) return `<p class="sub" style="margin:6px 0 0;">${opts.empty || 'No figures yet.'}</p>`;
    // Drawn at the width it will be shown at, so the figures stay the same
    // size on a phone and on a wide screen.
    const W = Math.max(280, Math.round(opts.width || 640)), H = W < 480 ? 120 : 140, top = 18, n = points.length;
    const bw = Math.min(56, (W - (n - 1) * 10) / n), gap = n > 1 ? Math.min(48, (W - bw * n) / (n - 1)) : 0;
    const x0 = (W - (n * bw + (n - 1) * gap)) / 2;
    const max = Math.max(...points.map(p => p.total), 1) * 1.1;
    const avg = points.reduce((s, p) => s + p.total, 0) / n;
    const gid = 'hg' + Math.random().toString(36).slice(2, 7);
    const [c1, c2] = opts.green ? ['#3FC18C', '#00734A'] : ['#5EA3F5', '#1D3F94'];
    const body = points.map((p, i) => {
      const h = Math.max(3, (p.total / max) * H), x = x0 + i * (bw + gap), y = top + H - h, last = i === n - 1;
      const d = toLocalDate(p.date);
      return `<rect class="b" x="${x}" y="${top + H}" width="${bw}" height="0" rx="6" fill="url(#${gid})" opacity="${last ? 1 : .55}" data-y="${y}" data-h="${h}"><title>${fmtShort(d)}: ${num(p.total)}</title></rect>
        <text x="${x + bw / 2}" y="${y - 5}" text-anchor="middle" font-size="11" font-weight="${last ? 700 : 500}" fill="${last ? 'var(--ink)' : 'var(--muted)'}">${num(p.total)}</text>
        <text x="${x + bw / 2}" y="${top + H + 16}" text-anchor="middle" font-size="10.5" fill="var(--muted)">${fmtDM(d)}</text>`;
    }).join('');
    const avgY = top + H - (avg / max) * H;
    return `<div class="hm-legend ${opts.green ? 'green' : ''}"><span>${esc(opts.label || 'Total present')}</span>${n > 1 ? `<span class="avg">Average ${num(Math.round(avg))}</span>` : ''}</div>
      <svg viewBox="0 0 ${W} ${top + H + 22}" role="img" aria-label="${esc(opts.aria || 'Attendance')}">
        <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
        ${n > 1 ? `<line x1="0" x2="${W}" y1="${avgY}" y2="${avgY}" stroke="var(--amber)" stroke-width="1.5" stroke-dasharray="5 4"/>` : ''}
        ${body}
      </svg>`;
  }
  function growBars(root) {
    const go = r => { r.style.y = r.dataset.y + 'px'; r.style.height = r.dataset.h + 'px'; };
    const list = (root || document).querySelectorAll('.hm-chart rect.b');
    if (reduce()) { list.forEach(go); return; }
    requestAnimationFrame(() => setTimeout(() => list.forEach((r, i) => { r.style.transitionDelay = `${i * 45}ms`; go(r); }), 80));
  }

  // ---- greeting, band, search, New -----------------------------------------
  const today = new Date();
  const q = Math.floor(today.getMonth() / 3) + 1, year = today.getFullYear();
  const qStart = new Date(year, (q - 1) * 3, 1), qEnd = new Date(year, q * 3, 0);
  const reportDue = new Date(year, q * 3, 5), districtDue = new Date(year, q * 3, 7);
  const pct = Math.min(100, Math.max(0, Math.round(((today - qStart) / (qEnd - qStart)) * 100)));
  const daysTo = d => Math.ceil((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  const weekOfQ = Math.min(13, Math.floor((today - qStart) / (7 * 86400000)) + 1);

  function paintBand() {
    const v = VERSES[dayOfYear() % VERSES.length];
    $('hmVerse').innerHTML = `“${esc(v.t)}”<span>${esc(v.r)} · verse of the day</span>`;
    $('hmRingPct').textContent = pct + '%';
    const ring = $('hmRing');
    requestAnimationFrame(() => setTimeout(() => { ring.style.strokeDashoffset = String(194.8 * (1 - pct / 100)); }, 60));
    const dueIn = daysTo(reportDue), endIn = daysTo(qEnd);
    $('hmChips').innerHTML = `
      <span><i></i>Q${q} ends ${fmtShort(qEnd)} — ${endIn} day${endIn === 1 ? '' : 's'}</span>
      <span class="${dueIn <= 14 ? 'warn' : ''}"><i></i>Q${q} report due ${fmtShort(reportDue)}${dueIn <= 14 && dueIn >= 0 ? ` (${dueIn} day${dueIn === 1 ? '' : 's'})` : ''}</span>
      <span><i></i>District deadline ${fmtShort(districtDue)}</span>`;
  }

  // The quick actions and the New menu offer only pages this account can open.
  const QUICK = [
    { href: '/minutes.html', label: 'Session minutes' },
    { href: '/correspondence.html', label: 'Log a letter', make: 'A letter received' },
    { href: '/entry.html', label: 'Quarterly entry' },
    { href: '/attendance.html', label: 'Attendance', make: 'Sunday attendance' },
    { href: '/visitors.html', label: 'Add a visitor', make: 'A visitor or new member' },
    { href: '/meetings.html', label: 'Meetings', make: 'A meeting' },
    { href: '/session-meetings.html', label: 'Session meetings', make: 'A Session meeting' },
    { href: '/finance-weekly.html', label: 'Weekly finance', make: 'This week’s finance' },
    { href: '/poll-desk.html', label: 'Polling desk' },
    { href: '/goals.html', label: 'Goals & KPIs' },
    { href: '/reports.html', label: 'Reports' },
    { href: '/documents.html', label: 'ShareHub', make: 'A document to share' },
  ];
  function paintQuick(me) {
    let nav = [];
    try { nav = visibleNavItems(me) || []; } catch (e) { nav = []; }
    const byHref = new Map(nav.map(i => [i.href, i]));
    const mine = QUICK.filter(x => byHref.has(x.href));
    $('hmQuick').innerHTML = mine.slice(0, 6).map(x => `<a href="${x.href}">${iconSvg(byHref.get(x.href).icon)}${esc(x.label)}</a>`).join('');
    const makes = mine.filter(x => x.make);
    if (!makes.length) return;
    const btn = $('hmNewBtn'), menu = $('hmNewMenu');
    btn.hidden = false;
    menu.innerHTML = makes.map(x => `<button type="button" role="menuitem" data-href="${x.href}">${iconSvg(byHref.get(x.href).icon)}${esc(x.make)}</button>`).join('');
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.onclick = e => { e.stopPropagation(); const open = menu.hidden; menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) { const f = menu.querySelector('button'); if (f) f.focus(); } };
    menu.onclick = e => { const b = e.target.closest('[data-href]'); if (b) location.href = b.dataset.href; };
    document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) close(); });
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); } });
  }

  // ---- Needs you -------------------------------------------------------------
  function paintNeeds(list, foot) {
    const ul = $('hmNeeds');
    list.sort((a, b) => a.rank - b.rank);
    const n = list.length;
    const badge = $('hmNeedsN');
    badge.hidden = false; badge.textContent = n; badge.classList.toggle('zero', !n);
    if (n) {
      ul.innerHTML = list.map((x, i) => `
      <li style="--i:${i}" data-href="${esc(x.href)}" tabindex="0">
        <div class="hm-ic ${x.tone || ''}">${svg(x.icon)}</div>
        <div><div class="t">${esc(x.title)}</div>${x.meta || x.due ? `<div class="m">${esc(x.meta || '')}${x.due ? `${x.meta ? ' · ' : ''}<span class="due">${esc(x.due)}</span>` : ''}</div>` : ''}</div>
        <button type="button" class="btn ${i === 0 && x.tone === 'red' ? 'btn-primary' : 'btn-secondary'} btn-sm go" data-href="${esc(x.href)}">${esc(x.cta || 'Open')}</button>
      </li>`).join('');
    } else {
      ul.outerHTML = `<div class="hm-empty" id="hmNeeds"><div class="hm-ic green">${svg('check')}</div><div><b>All caught up</b><span>Nothing is waiting on you right now.</span></div></div>`;
    }
    $('hmNeedsFoot').innerHTML = foot.map(f => `<div class="hm-foot ${f.warn ? 'warn' : ''}">${esc(f.text)}</div>`).join('');
  }
  document.addEventListener('click', e => {
    const li = e.target.closest('#hmNeeds [data-href], #hmEvents [data-href]');
    if (li) location.href = li.dataset.href;
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.closest) return;
    const li = e.target.closest('#hmNeeds li[data-href], #hmEvents [data-href]');
    if (li) location.href = li.dataset.href;
  });

  async function gatherNeeds(me, s, home) {
    const needs = (home && home.needs ? home.needs : []).slice();
    const foot = [];
    const jobs = [];
    const entity = me.entity && me.entity.type !== 'congregation';
    const dueIn = daysTo(reportDue);

    // The quarter's report: for a committee or group, its own; congregation-wide, the count.
    if (entity) {
      jobs.push(api(`/entry/data?quarter=${q}`).then(data => {
        const sub = data.submission;
        const reopen = sub && sub.reopenedUntil && new Date(sub.reopenedUntil) > new Date();
        if (reopen) {
          needs.push({ rank: 2, tone: 'amber', icon: 'unlock', title: 'Change window open — resubmit when done', meta: `Editing allowed until ${new Date(sub.reopenedUntil).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`, href: '/entry.html', cta: 'Open entry' });
        } else if (sub) {
          foot.push({ text: `Q${q} report submitted${sub.submittedBy ? ` by ${sub.submittedBy}` : ''}` });
        } else {
          const entered = new Set((data.kpiEntries || []).filter(e => e.quarter === q).map(e => e.goalId));
          const missK = (data.goals || []).filter(g => (g.kpis || []).length && !entered.has(g.id)).length;
          const updated = new Set((data.activityUpdates || []).filter(u => u.quarter === q).map(u => u.activityId));
          const missA = (data.activities || []).filter(a => !updated.has(a.id)).length;
          if (missK + missA) {
            needs.push({ rank: dueIn <= 14 ? 1 : 6, tone: dueIn <= 14 ? 'red' : 'amber', icon: 'chart', title: `Q${q} report — ${missK} goal figure${missK === 1 ? '' : 's'} and ${missA} activity update${missA === 1 ? '' : 's'} to enter`, meta: `Due ${fmtShort(reportDue)}`, due: dueIn <= 14 && dueIn >= 0 ? `${dueIn} day${dueIn === 1 ? '' : 's'} left` : '', href: '/entry.html', cta: 'Enter figures' });
          } else if ((data.goals || []).length + (data.activities || []).length) {
            needs.push({ rank: 3, tone: 'green', icon: 'chart', title: `Q${q} report — everything entered`, meta: 'Ready to submit', href: '/entry.html', cta: 'Submit' });
          }
        }
      }).catch(() => {}));
    } else if (hasPermission(me, 'congregation.view') || isElevated(me)) {
      jobs.push(Promise.all([api('/entry/submissions'), api('/setup/committees'), api('/setup/groups')]).then(([subs, coms, grps]) => {
        const total = coms.length + grps.length;
        const done = new Set(subs.filter(x => x.year === year && Number(x.quarter) === q && x.status === 'submitted').map(x => `${x.entityType}:${x.entityId}`)).size;
        if (done < total && dueIn <= 21 && dueIn >= -7) {
          needs.push({ rank: dueIn <= 7 ? 1 : 4, tone: dueIn <= 7 ? 'red' : 'amber', icon: 'chart', title: `Q${q} reports: ${total - done} of ${total} still to come in`, meta: `Due ${fmtShort(reportDue)} · District ${fmtShort(districtDue)}`, href: '/reports.html', cta: 'See who' });
        } else {
          foot.push({ text: done >= total ? `Q${q} reports: all ${total} in` : `Q${q} reports: ${done} of ${total} in · due ${fmtShort(reportDue)}`, warn: done < total && dueIn <= 21 });
        }
      }).catch(() => {}));
    }

    // Approvals (Session Clerk / administrators).
    if (isElevated(me) || hasPermission(me, 'approvals.manage')) {
      jobs.push(Promise.all([
        api('/entry/change-requests?status=pending').catch(() => []),
        api('/setup/roster-requests').catch(() => []),
      ]).then(([cr, rr]) => {
        const roster = (rr || []).filter(r => r.status === 'pending');
        const windows = (cr || []).length;
        if (roster.length) {
          const names = roster.map(r => r.memberName || r.name).filter(Boolean);
          needs.push({ rank: 5, tone: '', icon: 'people', title: `${roster.length} membership request${roster.length === 1 ? '' : 's'} to approve`, meta: names.slice(0, 3).join(' · ') + (names.length > 3 ? ` and ${names.length - 3} more` : ''), href: '/committees.html', cta: 'Approve' });
        }
        if (windows) needs.push({ rank: 4, tone: 'amber', icon: 'unlock', title: `${windows} request${windows === 1 ? '' : 's'} to reopen a submitted report`, meta: 'Change windows', href: '/unlocks.html', cta: 'Decide' });
      }).catch(() => {}));
    }

    // Action points from meetings.
    jobs.push(api('/meetings/action-points-list?status=open').then(list => {
      if (!list || !list.length) return;
      const t0 = new Date(); t0.setHours(0, 0, 0, 0);
      const wk = new Date(t0.getTime() + 7 * 86400000);
      const overdue = [], soon = [];
      list.forEach(a => { if (!a.targetDate) return; const d = toLocalDate(a.targetDate); if (d < t0) overdue.push(a); else if (d <= wk) soon.push(a); });
      const label = a => `${a.description || a.text || a.title || 'Action'}${a.targetDate ? ` (due ${fmtDM(toLocalDate(a.targetDate))})` : ''}`;
      if (overdue.length) needs.push({ rank: 2, tone: 'red', icon: 'check', title: `${overdue.length} action point${overdue.length === 1 ? '' : 's'} overdue`, meta: overdue.slice(0, 2).map(label).join(' · '), href: '/meetings.html', cta: 'See them' });
      if (soon.length) needs.push({ rank: 6, tone: '', icon: 'check', title: `${soon.length} action point${soon.length === 1 ? '' : 's'} due this week`, meta: soon.slice(0, 2).map(label).join(' · '), href: '/meetings.html', cta: 'See them' });
    }).catch(() => {}));

    if (s && s.scope === 'entity' && s.myPendingRequests) {
      foot.push({ text: `${s.myPendingRequests} membership request${s.myPendingRequests === 1 ? '' : 's'} waiting for the Session Clerk`, warn: true });
    }
    await Promise.all(jobs);
    paintNeeds(needs, foot);
  }

  // ---- Coming up ---------------------------------------------------------------
  async function gatherWeek(home) {
    const events = (home && home.week ? home.week : []).slice();
    const sessionMeetings = new Set(events.filter(e => e.meetingId).map(e => Number(e.meetingId)));
    try {
      const list = await api('/meetings');
      const from = keyOf(plusDays(0)), to = keyOf(plusDays(14));
      (list || []).filter(m => m.status === 'scheduled' && m.date >= from && m.date <= to && !sessionMeetings.has(Number(m.id)))
        .forEach(m => events.push({ kind: 'meeting', date: m.date, time: m.time || '', title: m.entityName || m.title, meta: [m.entityName ? m.title : '', m.venueName].filter(Boolean).join(' · '), href: '/meetings.html' }));
    } catch (e) {}
    // From the Church Diary: funerals, weddings, programmes, the preaching plan
    // (meetings and Session meetings are already above).
    try {
      const d = await api(`/diary?from=${keyOf(plusDays(0))}&to=${keyOf(plusDays(14))}`);
      (d.items || []).filter(i => i.kind !== 'session' && i.kind !== 'meeting').forEach(i => events.push({
        kind: `diary ${i.kind}`, date: i.date, time: i.time || '', title: i.title,
        meta: [(d.kinds || {})[i.kind], i.venue].filter(Boolean).join(' · '), href: `/diary.html?day=${i.date}`,
      }));
    } catch (e) {}
    events.sort((a, b) => String(a.date + (a.time || '')).localeCompare(String(b.date + (b.time || ''))));

    const has = new Set(events.map(e => e.date));
    $('hmDays').innerHTML = Array.from({ length: 7 }, (_, i) => {
      const d = plusDays(i), k = keyOf(d);
      return `<div class="${i === 0 ? 'today' : ''}" title="${esc(fmtShort(d))}">${d.toLocaleDateString('en-GB', { weekday: 'short' })}<b>${d.getDate()}</b><span class="${has.has(k) ? 'dot' : 'nodot'}"></span></div>`;
    }).join('');

    const todayKey = keyOf(plusDays(0)), tomorrowKey = keyOf(plusDays(1));
    const dayLabel = k => (k === todayKey ? 'Today' : k === tomorrowKey ? 'Tomorrow' : fmtShort(fromKey(k)).replace(/ [A-Za-z]+$/, ''));
    const shown = events.slice(0, 6);
    $('hmEvents').innerHTML = shown.length ? shown.map(e => {
      const t = e.at ? new Date(e.at).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }) : fmtTime(e.time);
      return `<div class="hm-ev" data-href="${esc(e.href || '#')}" tabindex="0"><time><b>${esc(dayLabel(e.date))}</b>${esc(t)}</time><i class="${esc(e.kind)}"></i>
        <div><div class="t">${esc(e.title)}</div>${e.meta ? `<div class="m">${esc(e.meta)}</div>` : ''}</div></div>`;
    }).join('') + (events.length > shown.length ? `<p class="sub" style="margin:8px 0 0; font-size:12px;">and ${events.length - shown.length} more in the next fortnight</p>` : '')
      : '<p class="sub" style="margin:6px 0;">Nothing in the diary for the next fortnight.</p>';
  }

  // ---- numbers, charts, board --------------------------------------------------
  function tile(o) {
    return `<div class="hm-card hm-tile rise" style="--i:${o.i}" ${o.href ? `onclick="location.href='${o.href}'"` : ''}>
      <div class="lb">${esc(o.label)}</div><div class="v">${o.value}</div><div class="d">${o.detail || ''}</div>${o.bar != null ? `<div class="hm-bar ${o.green ? 'green' : ''}"><div data-w="${o.bar}"></div></div>` : ''}${o.spark || ''}</div>`;
  }
  function paintCongregation(an) {
    const trend = an.attendanceTrend || [];
    const last = trend.length ? trend[trend.length - 1] : null;
    const prev = trend.slice(-5, -1);
    const prevAvg = prev.length ? prev.reduce((s, p) => s + p.total, 0) / prev.length : 0;
    const delta = prevAvg ? Math.round(((last.total - prevAvg) / prevAvg) * 100) : null;
    const submitted = (an.board || []).filter(b => b.submitted).length, total = (an.board || []).length;
    const fund = an.fund || { raised: 0 };
    const fpct = fund.target ? Math.round((fund.raised / fund.target) * 100) : null;
    const nq = an.newThisQuarter || { seen: 0, joined: 0 };
    $('hmPulse').innerHTML = [
      tile({ i: 4, label: 'Sunday attendance', href: '/attendance.html', value: last ? `<span data-count="${last.total}">0</span>` : '—',
        detail: !last ? 'No Sunday recorded yet' : delta == null ? `${esc(fmtShort(toLocalDate(last.date)))} · the first Sunday recorded` : `<span class="${delta >= 0 ? 'up' : 'dn'}">${delta >= 0 ? '▲' : '▼'} ${Math.abs(delta)}%</span> on the ${prev.length}-week average`,
        spark: spark(trend.map(p => p.total), 'var(--primary-light)') }),
      tile({ i: 5, label: `Q${an.quarter} reports in`, href: '/reports.html', value: `<span data-count="${submitted}">0</span><small>/ ${total}</small>`, detail: `committees &amp; groups · due ${esc(fmtShort(reportDue))}`, bar: total ? Math.round((submitted / total) * 100) : 0, green: true }),
      tile({ i: 6, label: 'Harvest & fundraising', href: '/fundraising.html', value: `<small style="margin-left:0">GHS</small><span data-count="${Math.round(fund.raised || 0)}">0</span>`, detail: fund.target ? `${fpct}% of GHS ${num(fund.target)} for ${an.year}` : `raised in ${an.year} · no target set`, bar: fpct != null ? fpct : null }),
      tile({ i: 7, label: 'New this quarter', href: '/visitors.html', value: `<span data-count="${nq.seen}">0</span>`, detail: `visitor${nq.seen === 1 ? '' : 's'} · <b>${nq.joined}</b> became member${nq.joined === 1 ? '' : 's'}` }),
    ].join('');

    // Sunday chart + the board
    const SVC = { joint: 'Joint service', '1st': '1st service', '2nd': '2nd service' };
    const rows = (an.attendanceRecent || []).map(s => {
      const parts = s.services || [];
      return `<tr><td>${esc(fmtShort(toLocalDate(s.date)))}</td><td class="sub">${esc(parts.map(p => `${SVC[p.service] || p.service}${parts.length > 1 ? ` ${num(p.total)}` : ''}`).join(' · ') || '—')}</td><td class="mono" style="text-align:right;"><b>${num(s.total)}</b></td></tr>`;
    }).join('') || '<tr><td colspan="3" class="sub">No services recorded yet.</td></tr>';
    const byGroup = an.meetingAttendanceByGroup || [];
    $('hmAnalytics').innerHTML = `
      <div class="hm-low">
        <section class="hm-card rise" style="--i:8">
          <header><h3>Sunday attendance</h3><span class="sub">last ${trend.length} Sunday${trend.length === 1 ? '' : 's'}</span></header>
          <div class="hm-chart"><div id="hmSunChart"></div>
            <details class="hm-more"><summary>Every recorded Sunday</summary>
              <table style="margin-top:8px;"><thead><tr><th>Sunday</th><th>Services</th><th style="text-align:right;">Total present</th></tr></thead><tbody>${rows}</tbody></table>
            </details>
          </div>
        </section>
        <section class="hm-card rise" style="--i:9">
          <header><h3>Q${an.quarter} reports</h3><a class="lnk" href="/reports.html">Who is outstanding →</a></header>
          <div class="hm-board">${(an.board || []).map(b => `<span class="${b.submitted ? 'ok' : ''}" title="${esc(b.name)} — ${b.submitted ? 'submitted' : 'not yet submitted'}">${esc(b.code)}</span>`).join('')}</div>
          <div class="hm-board-foot"><span>${(an.board || []).filter(b => b.type === 'committee').length} committees · ${(an.board || []).filter(b => b.type === 'group').length} groups</span><span>${submitted} in · ${total - submitted} to come</span></div>
        </section>
      </div>
      <div class="hm-full">
        <section class="hm-card rise" style="--i:9">
          <header><h3>Group meeting attendance</h3>
            <select id="hmGrpSel" aria-label="Which group"><option value="all">All groups combined</option>${byGroup.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('')}</select></header>
          <div class="hm-chart"><div class="sub" id="hmGrpSub" style="margin:-2px 0 8px;"></div><div id="hmGrpChart"></div><div id="hmGrpNote" style="margin-top:10px;"></div>
            <details class="hm-more"><summary>Meeting by meeting</summary>
              <table style="margin-top:8px;"><thead><tr><th>Date</th><th>Group</th><th style="text-align:right;">Members</th><th style="text-align:right;">Online</th><th style="text-align:right;">Total</th></tr></thead><tbody id="hmGrpRows"></tbody></table>
            </details>
          </div>
        </section>
      </div>`;

    $('hmSunChart').innerHTML = bars(trend, { width: $('hmSunChart').clientWidth, aria: 'Sunday attendance', empty: 'No Sunday attendance recorded yet — it is entered on the Attendance page.' });

    // Group attendance, one group at a time or all combined. A group that has
    // gone quiet is named under the chart (figures come from the Attendance page).
    const quiet = an.meetingAttendanceQuiet || [];
    const sel = $('hmGrpSel');
    const paintGroup = value => {
      const g = value === 'all' ? null : byGroup.find(x => String(x.id) === String(value));
      const tr = g ? g.trend : (an.meetingAttendanceTrend || []);
      $('hmGrpChart').innerHTML = bars(tr, { width: $('hmGrpChart').clientWidth, green: true, label: g ? g.name : 'Every group added together', aria: 'Group meeting attendance', empty: g ? 'Nothing logged for this group yet.' : 'No group meeting attendance logged yet.' });
      $('hmGrpSub').textContent = tr.length ? (g ? `last ${tr.length} meeting${tr.length === 1 ? '' : 's'}${g.average ? ` · ${g.average} on average` : ''}` : `last ${tr.length} meeting day${tr.length === 1 ? '' : 's'}`) : '';
      const list = (an.meetingAttendanceRecent || []).filter(m => !g || Number(m.entityId) === Number(g.id));
      $('hmGrpRows').innerHTML = list.map(m => `<tr><td>${esc(fmtDM(toLocalDate(m.date)))}</td><td>${esc(m.group)}</td><td class="mono" style="text-align:right;">${num(m.members)}</td><td class="mono" style="text-align:right;">${num(m.online)}</td><td class="mono" style="text-align:right;"><b>${num(m.present)}</b></td></tr>`).join('')
        || '<tr><td colspan="5" class="sub">Nothing logged yet — figures are entered on the Attendance page.</td></tr>';
      const mine = g ? quiet.filter(x => Number(x.id) === Number(g.id)) : quiet;
      $('hmGrpNote').innerHTML = mine.length ? `<div class="hm-note">${g
        ? `<b>${esc(g.name)}</b> has logged nothing ${g.lastDate ? `since ${esc(fmtDM(toLocalDate(g.lastDate)))}` : 'at all'}.`
        : `<b>${mine.length} group${mine.length === 1 ? '' : 's'} with nothing logged in over five weeks:</b> ${mine.slice(0, 6).map(x => esc(x.name) + (x.lastDate ? ` (${esc(fmtDM(toLocalDate(x.lastDate)))})` : ' (never)')).join(', ')}${mine.length > 6 ? '…' : ''}`}
        Figures are entered on the Attendance page, under Group meeting attendance.</div>` : '';
      growBars($('hmGrpChart').parentNode);
    };
    sel.onchange = () => paintGroup(sel.value);
    paintGroup('all');
  }

  function paintEntity(an, s, goals) {
    const subs = an.submissions || [];
    const thisQ = subs.find(x => x.quarter === q);
    const trend = an.attendanceTrend || [];
    $('hmPulse').innerHTML = [
      tile({ i: 4, label: 'My goals', href: '/goals.html', value: `<span data-count="${s.goals || 0}">0</span>`, detail: `for ${s.year || year}` }),
      tile({ i: 5, label: 'KPIs to track', href: '/goals.html', value: `<span data-count="${s.kpis || 0}">0</span>`, detail: 'figures entered each quarter' }),
      tile({ i: 6, label: 'Members', href: s.entityType === 'committee' ? '/committees.html' : '/groups.html', value: `<span data-count="${s.roster || 0}">0</span>`, detail: esc(s.entityName || '') }),
      tile({ i: 7, label: `Q${q} report`, href: '/entry.html', value: thisQ && thisQ.submitted ? 'Submitted' : 'Not yet', detail: subs.map(x => `Q${x.quarter} ${x.submitted ? '✓' : '—'}`).join(' · ') }),
    ].join('');
    const kp = an.kpiProgress || [];
    $('hmAnalytics').innerHTML = `
      <div class="hm-low">
        <section class="hm-card rise" style="--i:8">
          <header><h3>Goal progress</h3><span class="sub">year to date against target</span></header>
          <div class="hm-chart hm-kpi">${kp.length ? kp.map(k => `<p><b class="mono">${esc(k.code)}</b> ${esc(k.kpi)} — ${num(k.ytd)} / ${num(k.target)}</p><div class="hm-bar"><div data-w="${k.pct}"></div></div>`).join('') : '<p class="sub">No numeric targets to track yet.</p>'}</div>
        </section>
        <section class="hm-card rise" style="--i:9">
          <header><h3>${esc(s.entityCode || 'My')} goals</h3><a class="lnk" href="/goals.html">View all →</a></header>
          <div class="hm-goals"><table><tbody>${(goals || []).slice(0, 6).map(g => `<tr><td class="mono">${esc(g.code)}</td><td>${esc(g.description.length > 70 ? g.description.slice(0, 70) + '…' : g.description)}</td></tr>`).join('') || '<tr><td class="sub">No goals yet.</td></tr>'}</tbody></table></div>
        </section>
      </div>
      ${trend.length ? `<div class="hm-full"><section class="hm-card rise" style="--i:9"><header><h3>Meeting attendance</h3><span class="sub">last ${trend.length} meeting${trend.length === 1 ? '' : 's'}</span></header><div class="hm-chart"><div id="hmEntChart"></div></div></section></div>` : ''}`;
    if ($('hmEntChart')) $('hmEntChart').innerHTML = bars(trend, { width: $('hmEntChart').clientWidth, green: true, aria: 'Meeting attendance' });
  }

  // ---- go ----------------------------------------------------------------------
  requireAuthAndRenderShell().then(async me => {
    if (!me) return;
    const hour = today.getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    const firstName = (me.name || '').split(' ')[0];
    $('hmGreet').textContent = firstName ? `${greeting}, ${firstName}` : greeting;
    const dateLine = who => { $('hmDate').innerHTML = `${esc(today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))} · <b>Q${q}, week ${weekOfQ} of 13</b>${who ? ` · ${esc(who)}` : ''}`; };
    dateLine(me.title || '');
    paintBand();
    paintQuick(me);
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    $('hmKbd').textContent = mac ? '⌘K' : 'Ctrl K';
    $('hmSearch').onclick = () => { if (window.openCommandPalette) window.openCommandPalette(); };

    const [s, goals, an, home] = await Promise.all([
      api('/setup/summary').catch(() => null), api('/setup/goals').catch(() => []),
      api('/analytics/dashboard').catch(() => null), api('/home').catch(() => null),
    ]);
    if (s && s.scope === 'entity') dateLine([me.title, s.entityName].filter(Boolean).join(' · '));
    else if (!me.title) dateLine('Congregation-wide');

    gatherNeeds(me, s, home).catch(() => paintNeeds([], []));
    gatherWeek(home).catch(() => {});
    if (an && an.scope === 'congregation') paintCongregation(an);
    else if (an && s && s.scope === 'entity') paintEntity(an, s, goals);
    countUp($('hmPulse')); fillBars(document); growBars(document);
  });
})();
