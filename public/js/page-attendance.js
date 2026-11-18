// Attendance page — sectioned Sunday flow (Phase 12a) + group meetings.
// 1. Day setup (Clerk/admin): fix the day as joint or 1st + 2nd.
// 2. Section drafts: CS / JY / Main recorders each see and fill ONLY their
//    section, then submit it independently — nobody can overwrite another.
// 3. Confirm & lock (Clerk/admin) once all three sections are in.
let me, adminGroupId = null;      // a group id, or 'all' for every group at once
let allGroups = [];               // the groups the selector offers (Sunday ones excluded)
let canRecordGroups = false;      // may this account save figures, or only read?
let myAccess = { clerk: false, sections: [] };
let currentDay = null, currentEntries = {}, currentBible = {};

const SEC_DEFS = {
  cs: {
    label: "Children's Service",
    rows: [
      { label: 'Children', fields: { male: 'male', female: 'female', online: 'online' } },
      { label: ' ↳ Teachers', fields: { male: 'teachersMale', female: 'teachersFemale' }, sub: true },
    ],
  },
  jy: {
    label: 'Junior Youth',
    rows: [
      { label: 'Junior Youth', fields: { male: 'male', female: 'female', online: 'online' } },
      { label: ' ↳ Leaders', fields: { male: 'leadersMale', female: 'leadersFemale' }, sub: true },
    ],
  },
  adult: {
    label: 'Main Church (Adults)',
    rows: [
      { label: 'Adults', fields: { male: 'male', female: 'female', online: 'online' } },
    ],
  },
};
const SVC_LABEL = { joint: 'Joint service', '1st': '1st service', '2nd': '2nd service' };

function statusBadge(st) {
  if (st === 'submitted') return '<span class="badge badge-done">Submitted</span>';
  if (st === 'draft') return '<span class="badge badge-info">Draft saved</span>';
  return '<span class="badge badge-idle">Pending</span>';
}
function dayStatusBadge(day) {
  if (!day) return '<span class="badge badge-idle">Not set up</span>';
  const shape = day.shape === 'dual' ? '1st + 2nd' : 'Joint';
  return `<span class="badge badge-info">${shape}</span> ` +
    (day.status === 'confirmed'
      ? '<span class="badge badge-done">Confirmed &amp; locked</span>'
      : '<span class="badge badge-idle">Open</span>');
}

// ---- Section grids (Oct 2026) ----
// Each service is a compact grid: one row per line (Children, Teachers…),
// boxes for Male / Female / Online, and the row's total at the end. Divs, not
// a table, so a phone keeps the three boxes side by side instead of stacking
// every box on its own line.
let prevEntries = {}, prevDate = '';
function secGridHtml(sec, svc, locked) {
  const def = SEC_DEFS[sec];
  const box = (f, label) => `<input inputmode="numeric" data-num data-c="${sec}.${svc}.${f}" aria-label="${esc(label)}" autocomplete="off" ${locked ? 'disabled' : ''}>`;
  const rows = def.rows.map(r => {
    const name = r.label.replace(/^\s*↳\s*/, '');
    return `<div class="rl ${r.sub ? 'sub2' : ''}">${r.sub ? '<span class="arr">↳ </span>' : ''}${esc(name)}</div>
      ${box(r.fields.male, `${name}, male, ${SVC_LABEL[svc]}`)}
      ${box(r.fields.female, `${name}, female, ${SVC_LABEL[svc]}`)}
      ${r.fields.online ? box(r.fields.online, `${name}, online, ${SVC_LABEL[svc]}`) : '<div class="na" aria-hidden="true">—</div>'}
      <div class="rt" data-rowtot="${sec}.${svc}.${Object.values(r.fields).join(',')}">0</div>`;
  }).join('');
  return `<div class="sv-svc">
      <div class="sv-svctitle"><span>${SVC_LABEL[svc]}</span><b data-sectot="${sec}.${svc}">0</b></div>
      <div class="sv-grid" role="group" aria-label="${esc(def.label)} — ${SVC_LABEL[svc]}">
        <div class="h"></div><div class="h">Male</div><div class="h">Female</div><div class="h">Online</div><div class="h" style="text-align:right;">Total</div>
        ${rows}
      </div>
    </div>`;
}
function cval(sel) { const el = document.querySelector(`[data-c="${sel}"]`); return el ? (numVal(el.value) || 0) : 0; }
function refreshSectionTotals() {
  document.querySelectorAll('[data-rowtot]').forEach(el => {
    const [sec, svc, list] = el.dataset.rowtot.split('.');
    el.textContent = list.split(',').reduce((t, f) => t + cval(`${sec}.${svc}.${f}`), 0).toLocaleString();
  });
  const bySec = {};
  document.querySelectorAll('[data-sectot]').forEach(el => {
    const [sec, svc] = el.dataset.sectot.split('.');
    let t = 0;
    SEC_DEFS[sec].rows.forEach(r => Object.values(r.fields).forEach(f => { t += cval(`${sec}.${svc}.${f}`); }));
    el.textContent = t.toLocaleString();
    bySec[sec] = (bySec[sec] || 0) + t;
  });
  Object.entries(bySec).forEach(([sec, t]) => { const el = document.querySelector(`[data-secall="${sec}"]`); if (el) el.textContent = t.toLocaleString(); });
}
// Unsaved figures: the section is marked, and leaving the page asks first.
const dirtySecs = new Set();
function markDirty(sec, on) {
  if (on) dirtySecs.add(sec); else dirtySecs.delete(sec);
  const card = document.querySelector(`.sv-sec[data-sec="${sec}"]`);
  if (card) card.classList.toggle('dirty', !!on);
}
window.addEventListener('beforeunload', e => { if (dirtySecs.size) { e.preventDefault(); e.returnValue = ''; } });
document.addEventListener('input', e => { if (e.target.matches('[data-c]')) markDirty(e.target.dataset.c.split('.')[0], true); });
// Enter moves to the next box, as on a paper form; a box's figure is selected
// when you arrive in it, so typing replaces it.
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.matches || !e.target.matches('[data-c]')) return;
  e.preventDefault();
  const all = [...document.querySelectorAll('[data-c]:not([disabled])')];
  const next = all[all.indexOf(e.target) + 1];
  if (next) next.focus(); else e.target.blur();
});
// (Selected at once, not after a pause, so a fast typist's first digit is
// never caught by it; the mouse-up that would undo it is swallowed once.)
let justFocused = null;
document.addEventListener('focusin', e => { if (e.target.matches && e.target.matches('[data-c]')) { e.target.select(); justFocused = e.target; } });
document.addEventListener('mouseup', e => { if (justFocused && e.target === justFocused) e.preventDefault(); justFocused = null; });
document.addEventListener('input', e => { if (e.target.matches('[data-c]')) refreshSectionTotals(); });
document.addEventListener('change', e => { if (e.target.matches('[data-bible]')) toggleBibleStudy(e.target.dataset.bible, e.target.checked); });
async function toggleBibleStudy(service, held) {
  try {
    await api('/attendance/bible-study', { method: 'POST', body: { date: document.getElementById('sDate').value, service, held } });
    currentBible[service] = held;
    toast(held ? 'Bible study recorded.' : 'Bible study unmarked.');
  } catch (e) { toast(e.message, true); loadDay(); }
}
function collect(sec, svc) {
  const out = {};
  SEC_DEFS[sec].rows.forEach(r => Object.values(r.fields).forEach(f => { out[f] = cval(`${sec}.${svc}.${f}`); }));
  return out;
}
function fill(sec, svc, counts) {
  SEC_DEFS[sec].rows.forEach(r => Object.values(r.fields).forEach(f => {
    const el = document.querySelector(`[data-c="${sec}.${svc}.${f}"]`);
    if (el) el.value = counts && counts[f] ? Number(counts[f]).toLocaleString() : '';
    // Last Sunday's figure, faint, to check against — never filled in.
    // A joint Sunday after a 1st + 2nd one compares with both added together.
    const p = prevEntries[svc] ? ((prevEntries[svc][sec] || {})[f])
      : svc === 'joint' ? Object.values(prevEntries).reduce((t, e) => t + (Number(((e || {})[sec] || {})[f]) || 0), 0) : 0;
    if (el) el.placeholder = p ? Number(p).toLocaleString() : '';
  }));
}

// ---- Day rendering ----
function paintDateLabel() {
  const v = document.getElementById('sDate').value;
  const el = document.getElementById('sDateLabel');
  if (!el) return;
  if (!v) { el.textContent = 'Choose a date'; return; }
  const d = toLocalDate(v);
  const today = lastSundayInputValue();
  // Sunday itself is "today"; Monday to Saturday it is "last Sunday".
  const tag = v === today ? (v === dateInputValue(new Date()) ? ' · today' : ' · last Sunday') : '';
  el.innerHTML = `<span class="long">${esc(d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + tag)}</span><span class="short">${esc(d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).replace(',', '') + tag)}</span>`;
}
let shownDate = '';
async function loadDay() {
  const input = document.getElementById('sDate');
  const date = input.value;
  if (!date) return;
  if (dirtySecs.size && shownDate && date !== shownDate
    && !await confirmDialog('You have figures that are not saved yet. Leave this Sunday without saving them?', { title: 'Unsaved figures', okText: 'Leave without saving', cancelText: 'Stay' })) {
    input.value = shownDate; paintDateLabel(); return;
  }
  shownDate = date;
  paintDateLabel();
  const r = await api('/attendance/days?date=' + encodeURIComponent(date));
  currentDay = r.day; currentEntries = r.entries || {}; currentBible = r.bible || {};
  prevEntries = (r.prev && r.prev.entries) || {}; prevDate = (r.prev && r.prev.date) || '';
  dirtySecs.clear();
  renderDay();
}

function renderDay() {
  const date = document.getElementById('sDate').value;
  const wrap = document.getElementById('sectionsWrap');
  const hint = document.getElementById('daySetupHint');
  const confirmBar = document.getElementById('confirmBar');
  const progress = document.getElementById('dayProgress');
  const shapeField = document.getElementById('shapeField');
  const confirmed = currentDay && currentDay.status === 'confirmed';
  // The Clerk sees how the day ran on the switch itself; others get the badge.
  document.getElementById('dayBadge').innerHTML = myAccess.clerk && currentDay && !confirmed
    ? '<span class="badge badge-idle">Open</span>' : dayStatusBadge(currentDay);
  confirmBar.style.display = 'none';

  // How the day ran: a two-way switch for the Clerk. Choosing it sets the day
  // up; choosing again on a day already set up changes it.
  shapeField.style.display = myAccess.clerk && !confirmed ? '' : 'none';
  shapeField.querySelectorAll('[data-shape]').forEach(b => b.classList.toggle('on', !!currentDay && currentDay.shape === b.dataset.shape));

  if (!currentDay) {
    wrap.innerHTML = '';
    progress.innerHTML = '';
    hint.style.display = '';
    hint.innerHTML = myAccess.clerk
      ? `<b>How did ${esc(fmtDate(date))} run?</b><p class="sub" style="margin:6px 0 0;">Choose <b>Joint service</b> or <b>1st + 2nd services</b> above. The section recorders are told, and can then enter their figures.</p>`
      : `<b>This day has not been set up yet.</b>
        <p class="sub" style="margin:6px 0 10px;">The Session Clerk needs to set ${esc(fmtDate(date))} as joint or 1st + 2nd services before you can enter your section.</p>
        <button class="btn btn-secondary btn-sm" type="button" onclick="requestSetup()">Notify the Session Clerk</button>`;
    return;
  }
  hint.style.display = 'none';
  document.getElementById('sShape').value = currentDay.shape;

  const services = currentDay.shape === 'dual' ? ['1st', '2nd'] : ['joint'];
  const secs = myAccess.sections;
  const secState = sec => ((currentDay.sections || {})[sec] || {});

  // The Clerk's strip: the three sections as they come in, and the lock.
  if (myAccess.clerk) {
    const pills = ['cs', 'jy', 'adult'].map(sec => {
      const st = secState(sec).status || 'pending';
      const word = st === 'submitted' ? 'in' : st === 'draft' ? 'started' : 'waiting';
      return `<span class="sv-pill ${st}"><i></i>${esc(SEC_DEFS[sec].label)} · ${word}</span>`;
    }).join('');
    const allIn = ['cs', 'jy', 'adult'].every(sec => secState(sec).status === 'submitted');
    const act = confirmed
      ? `<span class="sub">Confirmed by ${esc(currentDay.confirmedBy || '')}${currentDay.confirmedAt ? ` on ${esc(new Date(currentDay.confirmedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}` : ''}</span>
         ${['admin', 'localadmin'].includes(me.role) ? `<button class="btn btn-danger btn-sm" type="button" onclick="unlockDay()">Unlock (admin)</button>` : ''}`
      : `<button class="btn ${allIn ? 'btn-primary' : 'btn-secondary'} btn-sm" type="button" onclick="confirmDay()">Confirm &amp; lock this day</button>`;
    progress.innerHTML = `<div class="sv-progress">${pills}<span class="sv-grow"></span>${act}</div>`;
  } else {
    progress.innerHTML = '';
  }

  // A confirmed day is locked for everyone who records it. The section officers
  // are usually the ones who spot the error, so the way to ask is right here.
  const dayLocked = confirmed && !['admin', 'localadmin'].includes(me.role)
    ? `<div class="sv-hint" style="border-style:solid;">
         <div class="sub" style="margin-bottom:8px;">This day is confirmed and locked. If a figure is wrong, ask for it to be reopened — the Session Clerk decides and the reason is kept on the record.</div>
         ${reopenButtonHtml('service-day', { date: currentDay.date || date }, 'Ask to reopen this day')}
       </div>`
    : '';

  wrap.innerHTML = dayLocked + secs.map(sec => {
    const st = secState(sec);
    const lockedForMe = confirmed || (st.status === 'submitted' && !myAccess.clerk);
    const grids = services.map(svc => {
      let g = secGridHtml(sec, svc, lockedForMe);
      // Main Church only: "Bible study held" feeds the CLN "Number of Bible
      // Studies in Sunday worship" KPI.
      if (sec === 'adult') {
        g = g.replace(/<\/div>\s*$/, `<label class="sv-bible"><input type="checkbox" data-bible="${svc}" ${currentBible[svc] ? 'checked' : ''} ${lockedForMe ? 'disabled' : ''}> Bible study held</label></div>`);
      }
      return g;
    }).join('');
    const who = st.by ? `<span class="sub">${st.status === 'submitted' ? 'submitted' : 'saved'} by ${esc(st.by)}</span>` : '';
    const saveLabel = st.status === 'submitted' ? 'Update' : 'Save';
    const buttons = lockedForMe ? '' : `
      <button class="btn btn-primary btn-sm" type="button" onclick="saveSection('${sec}')">${saveLabel}</button>
      ${st.status !== 'submitted' ? `<button class="btn btn-secondary btn-sm" type="button" onclick="submitSection('${sec}')">Submit — figures are final</button>` : ''}`;
    const reopen = (myAccess.clerk && st.status === 'submitted' && !confirmed)
      ? `<button class="btn btn-secondary btn-sm" type="button" onclick="reopenSection('${sec}')">Reopen for correction</button>` : '';
    return `<div class="sv-sec" data-sec="${sec}">
      <div class="sv-sechead">
        <h3>${esc(SEC_DEFS[sec].label)}</h3>
        ${statusBadge(st.status || 'pending')}<span class="sv-unsaved">Not saved</span>${who}
        <div class="sv-sectot"><b data-secall="${sec}">0</b><span>${services.length > 1 ? 'both services' : 'total'}</span></div>
      </div>
      <div class="sv-svcs">${grids}</div>
      ${prevDate && !lockedForMe ? `<div class="sv-prevnote">Faint figures are last Sunday’s (${esc(fmtDate(prevDate))}), to check against.</div>` : ''}
      <div class="sv-foot">${buttons}${reopen}</div>
    </div>`;
  }).join('');

  secs.forEach(sec => services.forEach(svc => fill(sec, svc, (currentEntries[svc] || {})[sec])));
  refreshSectionTotals();
}

async function setupDay() {
  if (currentDay && currentDay.shape !== document.getElementById('sShape').value
    && !await confirmDialog(`Change ${fmtDate(document.getElementById('sDate').value)} to ${document.getElementById('sShape').value === 'dual' ? '1st + 2nd services' : 'a joint service'}? The section recorders are told.`, { title: 'Change how the day ran', okText: 'Change it' })) { renderDay(); return; }
  try {
    await api('/attendance/days', { method: 'POST', body: {
      date: document.getElementById('sDate').value,
      shape: document.getElementById('sShape').value,
    } });
    toast('Day set up. Section recorders have been notified.');
    await loadDay(); loadRecent();
  } catch (e) { toast(e.message, true); }
}
async function requestSetup() {
  try {
    await api('/attendance/days/request-setup', { method: 'POST', body: { date: document.getElementById('sDate').value } });
    toast('The Session Clerk has been notified.');
  } catch (e) { toast(e.message, true); }
}
async function saveSection(sec) {
  const services = currentDay.shape === 'dual' ? ['1st', '2nd'] : ['joint'];
  const entries = {};
  services.forEach(svc => { entries[svc] = collect(sec, svc); });
  try {
    const wasSubmitted = (((currentDay || {}).sections || {})[sec] || {}).status === 'submitted';
    await api('/attendance/sections', { method: 'PUT', body: { date: document.getElementById('sDate').value, section: sec, entries } });
    toast(`${SEC_DEFS[sec].label} ${wasSubmitted ? 'updated' : 'saved'}.`);
    await loadDay(); loadRecent();
  } catch (e) { toast(e.message, true); }
}
async function submitSection(sec) {
  if (!await confirmDialog(`Submit the ${SEC_DEFS[sec].label} figures? You won't be able to change them afterwards unless the Session Clerk reopens the section.`)) return;
  try {
    // make sure the latest figures are saved before freezing
    await saveSection(sec);
    const r = await api('/attendance/sections/submit', { method: 'POST', body: { date: document.getElementById('sDate').value, section: sec } });
    toast(r.allIn ? 'Submitted — all sections are now in.' : `${SEC_DEFS[sec].label} submitted.`);
    await loadDay(); loadRecent();
  } catch (e) { toast(e.message, true); }
}
async function reopenSection(sec) {
  try {
    await api('/attendance/sections/reopen', { method: 'POST', body: { date: document.getElementById('sDate').value, section: sec } });
    toast(`${SEC_DEFS[sec].label} reopened — the recorder has been notified.`);
    await loadDay();
  } catch (e) { toast(e.message, true); }
}
async function confirmDay() {
  const date = document.getElementById('sDate').value;
  try {
    await api('/attendance/days/confirm', { method: 'POST', body: { date } });
    toast('Day confirmed and locked. Everyone has been notified.');
    await loadDay(); loadRecent();
  } catch (e) {
    const missing = e.missing || (e.data && e.data.missing);
    if (missing && await confirmDialog(`${e.message}\n\nConfirm anyway with the sections as they stand?`)) {
      try {
        await api('/attendance/days/confirm', { method: 'POST', body: { date, force: true } });
        toast('Day confirmed and locked.');
        await loadDay(); loadRecent();
      } catch (e2) { toast(e2.message, true); }
    } else if (!missing) { toast(e.message, true); }
  }
}
async function unlockDay() {
  if (!await confirmDialog('Unlock this confirmed day? This is logged.')) return;
  try {
    await api('/attendance/days/unlock', { method: 'POST', body: { date: document.getElementById('sDate').value } });
    toast('Day unlocked.');
    await loadDay(); loadRecent();
  } catch (e) { toast(e.message, true); }
}

// ---- Sunday summary sentences (clerk view) ----
function svcSummary(dateKey, entries) {
  const g = k => entries.reduce((n2, s) => n2 + (s.counts[k].male + s.counts[k].female), 0);
  const gm = (k, f) => entries.reduce((n2, s) => n2 + (s.counts[k][f] || 0), 0);
  const dual = entries.some(s => s.service !== 'joint');
  const tM = gm('jy', 'leadersMale'), tF = gm('jy', 'leadersFemale');
  const cM = gm('cs', 'teachersMale'), cF = gm('cs', 'teachersFemale');
  const staff = tM + tF + cM + cF;
  const adults = g('adult') + staff;
  const jy = g('jy'), cs = g('cs');
  const online = entries.reduce((n2, s) => n2 + s.counts.cs.online + s.counts.jy.online + s.counts.adult.online, 0);
  const total = adults + jy + cs + online;
  const dstr = fmtDateLong(dateKey);

  let adultDetail;
  if (dual) {
    const svc = n2 => entries.find(s => s.service === n2) || { counts: { adult: { male: 0, female: 0 } } };
    adultDetail = `1st Service: Men=${svc('1st').counts.adult.male}, Women=${svc('1st').counts.adult.female}; ` +
      `2nd Service: Men=${svc('2nd').counts.adult.male}, Women=${svc('2nd').counts.adult.female}`;
  } else {
    const s = entries[0];
    adultDetail = `Joint Service: Men=${s.counts.adult.male}, Women=${s.counts.adult.female}`;
  }
  adultDetail += `; Teachers – JY: M=${tM}, F=${tF}; CS: M=${cM}, F=${cF}`;
  let text = `Sunday service attendance for ${dstr} was ${total.toLocaleString()} in total; ` +
    `${adults.toLocaleString()} adults (${adultDetail}), ` +
    `${jy} Junior Youth (M=${gm('jy','male')}, F=${gm('jy','female')}), and ` +
    `${cs} children (M=${gm('cs','male')}, F=${gm('cs','female')}).`;
  if (online > 0) text = text.slice(0, -1) + `, plus ${online} online.`;
  return text;
}

// ---- Recent lists ----
async function loadRecent() {
  if (myAccess.clerk) return loadServices();
  return loadMyRecent();
}

const RECENT_SHOWN = 1;
async function loadServices() {
  document.getElementById('svcClerkExtras').style.display = '';
  const [list, daysRes] = await Promise.all([api('/attendance/services'), api('/attendance/days')]);
  const dayByDate = {};
  (daysRes.days || []).forEach(d => { dayByDate[d.date] = d; });
  const byDate = {};
  list.forEach(s => { (byDate[s.date] = byDate[s.date] || []).push(s); });
  // Every Sunday, newest first — not just the most recent handful. The summary
  // text is what gets pasted into the WhatsApp group, so all of them need to be
  // reachable, not only the last six.
  const dates = Object.keys(byDate).sort().reverse();
  // The latest Sunday's sentence first (the one you paste); the rest folded.
  const sumHtml = d => `<div class="sv-sum"><p>${esc(svcSummary(d, byDate[d]))}</p>
      <button class="btn btn-secondary btn-sm" onclick="navigator.clipboard.writeText(this.previousElementSibling.textContent).then(()=>toast('Copied'))">Copy</button></div>`;
  document.getElementById('svcSummaries').innerHTML = dates.length
    ? sumHtml(dates[0]) + (dates.length > 1 ? `<details><summary class="sv-sumtoggle">Earlier Sundays (${dates.length - 1})</summary>${dates.slice(1).map(sumHtml).join('')}</details>` : '')
    : '<p class="sub">Summaries appear here once services are entered.</p>';

  // ONE ROW PER SUNDAY. The store keeps a separate record per service, so a
  // dual-service Sunday used to appear as two rows with two totals and no
  // combined figure anywhere — which read as two different Sundays. Now the day
  // is the row, its figure is both services added together, and the row expands
  // to show 1st and 2nd separately for anyone who needs them.
  const n = v => Number(v) || 0;
  const svcOf = s2 => {
    const t = k => n(s2.counts[k].male) + n(s2.counts[k].female);
    const staff = n(s2.counts.cs.teachersMale) + n(s2.counts.cs.teachersFemale)
      + n(s2.counts.jy.leadersMale) + n(s2.counts.jy.leadersFemale);
    const online = n(s2.counts.cs.online) + n(s2.counts.jy.online) + n(s2.counts.adult.online);
    const adultsAll = t('adult') + staff;
    return { cs: t('cs'), jy: t('jy'), adults: adultsAll, online, total: t('cs') + t('jy') + adultsAll + online };
  };

  // Recent Sundays opens on the last FINISHED Sunday — confirmed, or already
  // past. A Sunday still being filled in (today, or set up ahead) is in the
  // entry area above, so it isn't listed until it is done; everything older
  // folds under "Earlier Sundays".
  const todayStr = dateInputValue(new Date());
  const finished = d => (dayByDate[d] && dayByDate[d].status === 'confirmed') || d < todayStr;
  const topIdx = Math.max(0, dates.findIndex(finished));
  const listDates = dates.slice(topIdx);
  document.getElementById('svcRows').innerHTML = listDates.map((date, di) => {
    const recs = byDate[date].slice().sort((a, b) => String(a.service).localeCompare(String(b.service)));
    const per = recs.map(r => ({ rec: r, ...svcOf(r) }));
    const sum = f => per.reduce((a, x) => a + x[f], 0);
    const day = dayByDate[date];
    const st = day && day.status === 'confirmed'
      ? '<span class="badge badge-done">Confirmed</span>'
      : (day ? '<span class="badge badge-idle">Open</span>' : '<span class="sub">—</span>');
    const dual = per.length > 1;
    const shape = dual ? per.map(x => SVC_LABEL[x.rec.service] || x.rec.service).join(' + ') : (SVC_LABEL[per[0].rec.service] || per[0].rec.service);
    const rid = 'svc-' + String(date).replace(/[^0-9]/g, '');
    const older = di >= RECENT_SHOWN ? ' sv-older' : '';

    const main = `<tr class="${older}">
      <td>${toLocalDate(date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
      <td>${dual
        ? `<button class="btn btn-secondary btn-sm" onclick="toggleSvcDetail('${rid}', this)" aria-expanded="false" title="${esc(shape)}">▸ 1st + 2nd</button>`
        : `<span class="sub">${esc(shape)}</span>`}</td>
      <td class="mono">${sum('cs')}</td><td class="mono">${sum('jy')}</td><td class="mono">${sum('adults')}</td>
      <td class="mono">${sum('online')}</td><td class="mono"><b>${sum('total').toLocaleString()}</b></td>
      <td>${st}</td>
      <td style="white-space:nowrap;">
        <button class="btn btn-secondary btn-sm" onclick="openDate('${date}')">Open</button>
      </td>
    </tr>`;

    // Per-service breakdown, hidden until the day is expanded.
    const detail = dual ? per.map(x => `<tr class="${rid}${older}" hidden style="background:var(--panel);">
      <td></td>
      <td class="sub">${esc(SVC_LABEL[x.rec.service] || x.rec.service)}</td>
      <td class="mono sub">${x.cs}</td><td class="mono sub">${x.jy}</td><td class="mono sub">${x.adults}</td>
      <td class="mono sub">${x.online}</td><td class="mono sub">${x.total.toLocaleString()}</td>
      <td></td>
      <td style="white-space:nowrap;">${day && day.status === 'confirmed' ? '' : `<button class="btn btn-danger btn-sm" onclick="delSvc(${x.rec.id})">Del</button>`}</td>
    </tr>`).join('') : '';

    return main + detail;
  }).join('') || '<tr><td colspan="9" class="sub">No entries yet.</td></tr>';
  // The latest Sundays show; earlier ones fold away, like the summaries below.
  const table = document.getElementById('svcTable'), more = document.getElementById('svcMoreBtn');
  const hiddenCount = Math.max(0, listDates.length - RECENT_SHOWN);
  table.classList.remove('all');
  more.hidden = !hiddenCount;
  const label = open => `${open ? '▾' : '▸'} ${open ? 'Hide earlier Sundays' : `Earlier Sundays (${hiddenCount})`}`;
  more.textContent = label(false);
  more.setAttribute('aria-expanded', 'false');
  more.onclick = () => { const open = table.classList.toggle('all'); more.textContent = label(open); more.setAttribute('aria-expanded', String(open)); };
}

// Expand/collapse a Sunday's per-service rows.
function toggleSvcDetail(rid, btn) {
  const rows = document.querySelectorAll('tr.' + rid);
  const opening = rows.length && rows[0].hidden;
  rows.forEach(r => { r.hidden = !opening; });
  btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
  btn.textContent = (opening ? '▾ ' : '▸ ') + btn.textContent.replace(/^[▸▾]\s*/, '');
}

async function loadMyRecent() {
  document.getElementById('myRecentWrap').style.display = '';
  const r = await api('/attendance/days');
  const mySec = myAccess.sections[0];
  document.getElementById('myRecentRows').innerHTML = (r.days || []).slice(0, 12).map(d => {
    const st = ((d.sections || {})[mySec] || {}).status || 'pending';
    return `<tr>
      <td>${toLocalDate(d.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
      <td>${d.shape === 'dual' ? '1st + 2nd' : 'Joint'}</td>
      <td>${statusBadge(st)}</td>
      <td>${d.status === 'confirmed' ? '<span class="badge badge-done">Confirmed</span>' : '<span class="badge badge-idle">Open</span>'}</td>
      <td><button class="btn btn-secondary btn-sm" onclick="openDate('${d.date}')">Open</button></td>
    </tr>`;
  }).join('') || '<tr><td colspan="5" class="sub">No Sundays set up yet.</td></tr>';
}

function openDate(d) {
  document.getElementById('sDate').value = d;
  loadDay();
  // On phones .shell is the scroller (body is overflow:hidden); on desktop
  // the window scrolls. Nudge both — the no-op one is harmless.
  window.scrollTo({ top: 0, behavior: 'smooth' });
  const shell = document.querySelector('.shell');
  if (shell) shell.scrollTo({ top: 0, behavior: 'smooth' });
}
async function delSvc(id) {
  if (!await confirmDialog('Delete this service entry?')) return;
  try { await api(`/attendance/services/${id}`, { method: 'DELETE' }); loadRecent(); } catch (e) { toast(e.message, true); }
}

// ---- Group meetings (unchanged) ----
// MF records men only; WF records women only; all other groups record both.
function applyGenderRule(code) {
  const maleOnly = code === 'MF', femaleOnly = code === 'WF';
  document.querySelectorAll('.gm-male').forEach(el => el.style.display = femaleOnly ? 'none' : '');
  document.querySelectorAll('.gm-female').forEach(el => el.style.display = maleOnly ? 'none' : '');
  if (maleOnly) { document.getElementById('gMembersFemale').value = ''; document.getElementById('gOnlineFemale').value = ''; }
  if (femaleOnly) { document.getElementById('gMembersMale').value = ''; document.getElementById('gOnlineMale').value = ''; }
}
function refreshGroupTotal() {
  const t = ['gMembersMale', 'gMembersFemale', 'gOnlineMale', 'gOnlineFemale']
    .reduce((n2, id) => n2 + (numVal((document.getElementById(id) || {}).value) || 0), 0);
  const el = document.getElementById('gTotal');
  if (el) el.innerHTML = `<b>${t.toLocaleString()}</b>`;
}
document.addEventListener('input', e => {
  if (['gMembersMale', 'gMembersFemale', 'gOnlineMale', 'gOnlineFemale'].includes(e.target.id)) refreshGroupTotal();
});

// adminGroupId === 'all' means "every group I can see" — the API already
// returns exactly that when no entityId is sent, so All is simply the
// unfiltered call with a Group column added and the entry form put away.
function allScope() { return adminGroupId === 'all'; }
// Who gets the cross-group view: the admin tier, the Session Clerk, and
// anyone holding congregation.view — the same reach the API already allows.
function canSeeAllGroups(u) {
  if (!u) return false;
  if (isElevated(u)) return true;
  const perms = u.permissions || [];
  return perms.includes('congregation.view') || perms.includes('approvals.manage');
}
function groupName(id) {
  const g = allGroups.find(x => Number(x.id) === Number(id));
  return g ? g.name : '';
}

async function loadGroup() {
  const q = adminGroupId && !allScope() ? `?entityId=${adminGroupId}` : '';
  const list = await api('/attendance/groups' + q);
  const all = allScope();
  const head = document.getElementById('grpHead');
  if (head) {
    head.innerHTML = (all ? '<th>Group</th>' : '') +
      '<th>Date</th><th>Members (M/F)</th><th>Online (M/F)</th><th>Total</th><th></th>';
  }
  const limit = all ? 60 : 20;
  document.getElementById('grpRows').innerHTML = list.slice(0, limit).map(g => {
    const mm = g.membersMale ?? g.members ?? 0, mf = g.membersFemale ?? 0;
    const om = g.onlineMale ?? g.online ?? 0, of = g.onlineFemale ?? 0;
    const total = mm + mf + om + of;
    const actions = canRecordGroups
      ? `<button class="btn btn-secondary btn-sm" onclick="editGrp('${g.date}', ${mm}, ${mf}, ${om}, ${of}, ${Number(g.entityId) || 0})">Edit</button> <button class="btn btn-danger btn-sm" onclick="delGrp(${g.id})">Del</button>`
      : '<span class="sub">—</span>';
    return `<tr>
    ${all ? `<td>${esc(groupName(g.entityId) || g.ownerCode || '—')}</td>` : ''}
    <td>${toLocalDate(g.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
    <td class="mono">${mm} / ${mf}</td><td class="mono">${om} / ${of}</td>
    <td class="mono"><b>${total.toLocaleString()}</b></td>
    <td style="white-space:nowrap;">${actions}</td>
  </tr>`;
  }).join('') || `<tr><td colspan="${all ? 6 : 5}" class="sub">No entries yet.</td></tr>`;
}

// Show the entry form only when a single group is in scope and this account
// may actually record. In All view the page is a read-across, not a form.
function applyGroupScopeUI() {
  const form = document.getElementById('grpForm');
  const hint = document.getElementById('grpAllHint');
  const show = canRecordGroups && !allScope();
  if (form) form.style.display = show ? '' : 'none';
  if (hint) {
    if (allScope()) {
      hint.style.display = '';
      hint.innerHTML = canRecordGroups
        ? 'Showing every group. <b>Pick one group above</b> to record or correct its figures.'
        : 'Showing every group. Your account can read these figures but not change them.';
    } else if (!canRecordGroups) {
      hint.style.display = '';
      hint.textContent = 'Your account can read these figures but not change them.';
    } else {
      hint.style.display = 'none';
    }
  }
}
async function delGrp(id) {
  if (!await confirmDialog('Delete this entry?')) return;
  try { await api(`/attendance/groups/${id}`, { method: 'DELETE' }); loadGroup(); } catch (e) { toast(e.message, true); }
}

// Load an existing entry back into the form so figures needn't be retyped.
// Saving re-submits the same date, which the backend upserts.
function editGrp(date, mm, mf, om, of, entityId) {
  // From the All view, editing a row first switches the page to that group so
  // the save goes to the right place.
  const sel = document.getElementById('grpScope');
  if (allScope() && entityId && sel) {
    sel.value = String(entityId);
    sel.onchange();
  }
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set('gDate', date);
  set('gMembersMale', mm); set('gMembersFemale', mf);
  set('gOnlineMale', om); set('gOnlineFemale', of);
  const form = document.getElementById('grpForm');
  if (form) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('Loaded — adjust the figures and save to update that date.');
}
document.getElementById('grpForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/attendance/groups', { method: 'PUT', body: {
      date: document.getElementById('gDate').value,
      membersMale: numVal(document.getElementById('gMembersMale').value) || 0,
      membersFemale: numVal(document.getElementById('gMembersFemale').value) || 0,
      onlineMale: numVal(document.getElementById('gOnlineMale').value) || 0,
      onlineFemale: numVal(document.getElementById('gOnlineFemale').value) || 0,
      ...(adminGroupId && !allScope() ? { entityId: adminGroupId } : {}),
    } });
    toast('Meeting attendance saved');
    loadGroup();
  } catch (err) { toast(err.message, true); }
});

// ---- Boot ----
requireAuthAndRenderShell().then(async u => {
  me = u;
  if (!me) return;
  document.getElementById('countLabel').textContent = window.myEntity ? window.myEntity.name : 'Congregation';
  try { myAccess = await api('/attendance/my-access'); } catch (e) {}
  // Section recorders come here to enter Sunday figures, and the overview is a
  // congregation-level read they don't get. Send them straight to the grid.
  const recorderOnly = myAccess.sections.length && !myAccess.clerk && !canSeeAllGroups(me);
  showTab(recorderOnly ? 'sunday' : 'overview');
  loadOverview();

  if (myAccess.sections.length) {
    document.getElementById('serviceCard').style.display = '';
    document.getElementById('svcIntro').textContent = myAccess.clerk
      ? 'Set the day up, watch the three sections come in, then confirm and lock.'
      : `You record the ${myAccess.sections.map(s => SEC_DEFS[s].label).join(' and ')} section. Save as often as you like, then submit when the figures are final.`;
    const d = document.getElementById('sDate');
    // Default to the most recent Sunday. Assigned as a 'YYYY-MM-DD' string:
    // `valueAsDate` reads the Date's UTC parts, so at UTC-4 a Sunday evening
    // set-up offered Monday and the section figures were filed under it.
    d.value = lastSundayInputValue();
    d.addEventListener('change', loadDay);
    document.getElementById('setupBtn').addEventListener('click', setupDay);
    // Step a week at a time; the date box opens the calendar for anything else.
    const step = days => { const t = toLocalDate(d.value || lastSundayInputValue()); t.setDate(t.getDate() + days); d.value = dateInputValue(t); loadDay(); };
    document.getElementById('sPrev').onclick = () => step(-7);
    document.getElementById('sNext').onclick = () => step(7);
    document.querySelectorAll('#shapeField [data-shape]').forEach(b => {
      b.onclick = () => { if (currentDay && currentDay.shape === b.dataset.shape) return; document.getElementById('sShape').value = b.dataset.shape; setupDay(); };
    });
    paintDateLabel();
    loadDay();
    loadRecent();
  }

  const SUNDAY_GROUPS = ['JY', 'CS'];
  const isGroup = me.entity && me.entity.type === 'group';
  if (isGroup && window.myEntity && SUNDAY_GROUPS.includes(window.myEntity.code)) {
    if (!myAccess.sections.length) {
      document.getElementById('groupCard').style.display = '';
      document.getElementById('groupCard').innerHTML = `<div class="section-title"><h3>${esc(window.myEntity.name)}</h3></div>
        <p class="sub">Your Sunday attendance is entered by your section recorder on the Sunday grid. If that should be you, ask an admin to add the "${window.myEntity.code === 'CS' ? "Children's Service" : 'JY'} recorder" permission to your account. Executive meetings are still scheduled and recorded on the Meetings page.</p>`;
    }
  } else if (isGroup) {
    canRecordGroups = true;
    document.getElementById('groupCard').style.display = '';
    document.getElementById('groupTitle').textContent = `${window.myEntity ? window.myEntity.name : 'Group'} — meeting attendance`;
    document.getElementById('gDate').value = todayInputValue();
    applyGenderRule(window.myEntity ? window.myEntity.code : null);
    loadGroup();
  } else if (canSeeAllGroups(me)) {
    // Congregation-wide accounts (admins, the Session Clerk, anyone with
    // congregation.view) see EVERY group. They land on "All groups" — the
    // read-across — and narrow to one group only to record or correct.
    // Recording still needs the admin tier, which is what the API enforces.
    canRecordGroups = isElevated(me);
    allGroups = (await api('/setup/groups')).filter(g => !SUNDAY_GROUPS.includes(g.code));
    document.getElementById('groupCard').style.display = '';
    const sel = document.createElement('select');
    sel.id = 'grpScope';
    sel.innerHTML = '<option value="all">All groups</option>' +
      allGroups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
    sel.style.maxWidth = '260px';
    sel.onchange = () => {
      adminGroupId = sel.value === 'all' ? 'all' : Number(sel.value);
      applyGenderRule(allScope() ? null : (allGroups.find(g => g.id === adminGroupId) || {}).code);
      applyGroupScopeUI();
      loadGroup();
    };
    adminGroupId = 'all';
    applyGenderRule(null);
    document.getElementById('groupTitle').textContent = canRecordGroups
      ? 'Group meeting attendance' : 'Group meeting attendance (view only)';
    document.getElementById('groupTitle').after(sel);
    document.getElementById('gDate').value = todayInputValue();
    applyGroupScopeUI();
    loadGroup();
  }
  // Card visibility is settled by here, so the tab strip can follow it.
  applyTabVisibility();
});

// ============ Overview tab ============
// The summary you land on: headline figures first, the detail behind a tab.
// One measure per chart, one hue, values labelled directly — no legend needed
// for a single series, and no second axis anywhere.

function tile(label, value, note) {
  return `<div class="stat-card"><div class="label">${esc(label)}</div>` +
    `<div class="value">${value === null || value === undefined ? '—' : esc(String(value))}</div>` +
    `${note ? `<div class="sub" style="margin-top:6px;">${note}</div>` : ''}</div>`;
}

// Horizontal bars for a single measure. `rows` = [{label, value, title}].
function barList(rows) {
  const max = Math.max(1, ...rows.map(r => r.value || 0));
  return `<div style="display:flex; flex-direction:column; gap:10px;">` + rows.map(r => `
    <div style="display:grid; grid-template-columns:86px 1fr auto; align-items:center; gap:10px;">
      <span class="sub" style="white-space:nowrap;">${esc(r.label)}</span>
      <span style="display:block; background:var(--rule); border-radius:4px; height:10px;" title="${esc(r.title || '')}">
        <span style="display:block; width:${Math.round(((r.value || 0) / max) * 100)}%; height:100%; background:var(--primary-light); border-radius:4px;"></span>
      </span>
      <b class="mono">${(r.value || 0).toLocaleString()}</b>
    </div>`).join('') + `</div>`;
}

function shortDay(d) {
  return toLocalDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

async function loadOverview() {
  let o;
  try { o = await api('/attendance/overview'); }
  catch (e) { document.getElementById('attStats').innerHTML = `<p class="sub">${esc(e.message)}</p>`; return; }

  // Nothing to summarise for this account (a section recorder, say) — drop the
  // tab strip rather than offering an empty tab.
  if (!o.sunday && (!o.groups || !o.groups.groupCount)) {
    const has = applyTabVisibility(false);
    showTab(has.sunday ? 'sunday' : has.groups ? 'groups' : 'overview');
    return;
  }

  const tiles = [];
  if (o.sunday) {
    const l = o.sunday.latest;
    tiles.push(tile('Last Sunday', l ? l.total.toLocaleString() : '—',
      l ? `${shortDay(l.date)} · ${l.adults} adults · ${l.jy} JY · ${l.cs} children${l.online ? ` · ${l.online} online` : ''}` : 'No service recorded yet'));
    tiles.push(tile(`Q${o.quarter} average`, o.sunday.quarterAvg === null ? '—' : o.sunday.quarterAvg.toLocaleString(),
      `across ${o.sunday.quarterSundays} Sunday${o.sunday.quarterSundays === 1 ? '' : 's'}`));
    tiles.push(tile('Bible studies', o.sunday.bibleStudies.year,
      `${o.sunday.bibleStudies.quarter} this quarter · counts toward SO-1.2`));
  }
  if (o.groups) {
    tiles.push(tile('Groups reporting', `${o.groups.reporting}/${o.groups.groupCount}`,
      `${o.groups.meetings} meeting${o.groups.meetings === 1 ? '' : 's'} logged in Q${o.quarter}`));
  }
  document.getElementById('attStats').innerHTML = tiles.join('');

  // ---- Sunday trend ----
  const sundayCard = document.getElementById('attSundayCard');
  if (o.sunday && o.sunday.weeks.length) {
    sundayCard.style.display = '';
    document.getElementById('attTrend').innerHTML = barList(o.sunday.weeks.map(w => ({
      label: shortDay(w.date),
      value: w.total,
      title: `${shortDay(w.date)} — ${w.total} total: ${w.adults} adults, ${w.jy} JY, ${w.cs} children${w.online ? `, ${w.online} online` : ''}`,
    })));
    const aw = o.sunday.awaiting;
    document.getElementById('attAwaiting').innerHTML = aw.length
      ? `<div class="section-title" style="margin-bottom:8px;"><h3 style="font-size:14px;">Not yet locked</h3></div>` +
        aw.map(a => `<div class="sub" style="margin-bottom:4px;">${esc(shortDay(a.date))} — ${a.readyToConfirm
            ? '<b>all sections in</b>, waiting to be confirmed &amp; locked'
            : `waiting on ${a.missing.map(esc).join(', ')}`}
          <button class="btn btn-secondary btn-sm" style="margin-left:6px;" onclick="showTab('sunday'); openDate('${a.date}')">Open</button></div>`).join('')
      : '<p class="sub" style="margin:0;">Every Sunday set up so far is confirmed and locked.</p>';
  } else if (sundayCard) {
    sundayCard.style.display = 'none';
  }

  // ---- Group meetings ----
  const gCard = document.getElementById('attGroupsCard');
  if (o.groups && o.groups.groupCount) {
    gCard.style.display = '';
    document.getElementById('attGroupsTitle').textContent =
      o.wide ? `Group meetings — Q${o.quarter} ${o.year}` : `Your group — Q${o.quarter} ${o.year}`;
    document.getElementById('attGroupRows').innerHTML = o.groups.perGroup.map(g => `<tr>
      <td>${esc(g.name)}</td>
      <td class="mono">${g.meetings}</td>
      <td class="mono">${g.avg === null ? '—' : g.avg.toLocaleString()}</td>
      <td class="mono">${g.total.toLocaleString()}</td>
      <td>${g.lastDate ? `${esc(shortDay(g.lastDate))} <span class="sub">(${g.daysSince}d ago)</span>` : '<span class="sub">never</span>'}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="sub">No groups.</td></tr>';
    const stale = o.groups.stale;
    document.getElementById('attStale').innerHTML = stale.length
      ? `<p class="sub" style="margin:0;"><b>Nothing logged in over five weeks:</b> ${stale.map(g => esc(g.name)).join(', ')}.</p>`
      : '<p class="sub" style="margin:0;">Every group has logged a meeting in the last five weeks.</p>';
  } else if (gCard) {
    gCard.style.display = 'none';
  }
}

// Three tabs, not two nested ones: Sunday services and group meetings are
// separate jobs done by different people, and burying the group form under a
// "Records" tab meant scrolling past the whole Sunday grid to reach it.
const PANES = { overview: 'overviewPane', sunday: 'sundayPane', groups: 'groupsPane' };
function showTab(tab) {
  if (!PANES[tab]) tab = 'overview';
  Object.entries(PANES).forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = key === tab ? '' : 'none';
  });
  document.querySelectorAll('#attTabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
}

// A tab whose card this account never sees is a dead end — hide the button,
// and hide the whole strip when it would offer a choice of one. `hasOverview`
// is passed false once the overview turns out to be empty for this account.
// Returns the tabs that are actually usable, so the caller can land on one.
let overviewUsable = true;
function applyTabVisibility(hasOverview) {
  if (hasOverview !== undefined) overviewUsable = !!hasOverview;
  const svc = document.getElementById('serviceCard');
  const grp = document.getElementById('groupCard');
  const has = {
    overview: overviewUsable,
    sunday: !!(svc && svc.style.display !== 'none'),
    groups: !!(grp && grp.style.display !== 'none'),
  };
  document.querySelectorAll('#attTabs button').forEach(b => {
    b.style.display = has[b.dataset.tab] ? '' : 'none';
  });
  const tabs = document.getElementById('attTabs');
  if (tabs) tabs.style.display = Object.values(has).filter(Boolean).length > 1 ? '' : 'none';
  return has;
}
document.querySelectorAll('#attTabs button').forEach(b => {
  b.onclick = () => showTab(b.dataset.tab);
});
