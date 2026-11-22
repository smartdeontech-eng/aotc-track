// Harvest & Fundraising page (Phase 9).
// Streams (seed contributions, gratitude, day-borns, chairpersons) + payment
// methods per service (Cash with a denomination counting sheet / Cheques /
// MoMo / Bank transfers / IOU / Forex) with a LIVE reconciliation check,
// day results with day-borns ranked highest-first, an IOU register, and the
// submit → verify (Accounts Clerk) → approve (Treasurer) sign-off pipeline.
let me, data = null;
// When the whole-day form was opened, what each service's entry looked like
// (its updatedAt). Sent back on save, so the form cannot put old figures over
// sheets typed at another desk in the meantime (server answers 409).
let entryBase = {};
// Fallback if the shared shell hasn't defined it (defensive during refactors).
if (typeof isElevated !== 'function') { window.isElevated = u => !!u && ['admin', 'localadmin'].includes(u.role); }
const DAYBORN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SEED_DEFAULT = ['Harvest Committee', 'Session', 'Congregation'];
// Mirrors the server list; only used before the first overview lands.
const DENOM_FALLBACK = [
  { key: 'n200', label: 'GHS 200 note', value: 200, kind: 'note' },
  { key: 'n100', label: 'GHS 100 note', value: 100, kind: 'note' },
  { key: 'n50', label: 'GHS 50 note', value: 50, kind: 'note' },
  { key: 'n20', label: 'GHS 20 note', value: 20, kind: 'note' },
  { key: 'n10', label: 'GHS 10 note', value: 10, kind: 'note' },
  { key: 'n5', label: 'GHS 5 note', value: 5, kind: 'note' },
  { key: 'n2', label: 'GHS 2 note', value: 2, kind: 'note' },
  { key: 'n1', label: 'GHS 1 note', value: 1, kind: 'note' },
  { key: 'c2', label: 'GHS 2 coin', value: 2, kind: 'coin' },
  { key: 'c1', label: 'GHS 1 coin', value: 1, kind: 'coin' },
  { key: 'c50', label: '50 pesewas', value: 0.5, kind: 'coin' },
  { key: 'c20', label: '20 pesewas', value: 0.2, kind: 'coin' },
  { key: 'c10', label: '10 pesewas', value: 0.1, kind: 'coin' },
  { key: 'c5', label: '5 pesewas', value: 0.05, kind: 'coin' },
  { key: 'c1p', label: '1 pesewa', value: 0.01, kind: 'coin' },
];
function seedCats() { return (data && (data.seedCategories || []).length) ? data.seedCategories : SEED_DEFAULT; }
// The week's activities. Legitimately empty — a congregation that runs none
// should see no rows — so there is no fallback list here, unlike seed.
function activityCats() { return (data && Array.isArray(data.activityCategories)) ? data.activityCategories : []; }
function denoms() { return (data && (data.denominations || []).length) ? data.denominations : DENOM_FALLBACK; }
function denomValue(key) { const d = denoms().find(x => x.key === key); return d ? d.value : 0; }
// Streams grid — four separate areas, each with its own heading, because they
// are different kinds of giving and must not read as one another:
//   Seed Contributions   pledged by the leadership at the launch
//   Gratitude & Thanksgiving Offering   taken on the harvest day itself
//   Day-born Offerings   the seven day-born baskets — offerings, not contributions
//   Chairpersons & Co-chairpersons
// A group with `inline` is a single basket and is its own heading row.
function catGroups() {
  return [
    { title: 'Seed Contributions', rows: seedCats().map(sname => ['seed.' + sname, sname]) },
    { title: 'Gratitude & Thanksgiving Offering', rows: [['gratitude', 'Gratitude & Thanksgiving Offering']], inline: true },
    { title: 'Day-born Offerings', rows: DAYBORN.map(d => ['dayborn.' + d, d + '-borns']) },
    { title: 'Chairpersons & Co-chairpersons', rows: [['chairpersons', 'Chairpersons & Co-chairpersons']], inline: true },
    // The week's own activities — the health walk, the bazaar, a games night.
    // Neither the Sunday offering nor the seed pledged at the launch, so it
    // gets its own area and its own line in the reports. Absent entirely when
    // no activities are configured for the year.
    ...(activityCats().length
      ? [{ title: 'Harvest Week Activities', rows: activityCats().map(a => ['activity.' + a, a]) }]
      : []),
  ];
}
// ---- Today's rates ----
// The rate belongs to the DAY, so it is declared once at the top of the form.
// Every currency picker below offers exactly these currencies, and every
// foreign amount is converted at these rates.
function collectRates() {
  return [...document.querySelectorAll('[data-rate]')].map(row => ({
    currency: (row.querySelector('[data-rate-cur]').value || '').trim().toUpperCase(),
    rate: Number(row.querySelector('[data-rate-val]').value) || 0,
  })).filter(x => x.currency && x.rate > 0);
}
function rateFor(cur) {
  const hit = collectRates().find(x => x.currency === cur);
  return hit ? hit.rate : 0;
}
function syncCurrencyPickers() {
  const rates = collectRates();
  const opts = '<option value="">—</option>' + rates.map(x => `<option value="${esc(x.currency)}">${esc(x.currency)}</option>`).join('');
  document.querySelectorAll('select[data-fx-cur]').forEach(sel => {
    const keep = sel.value;
    sel.innerHTML = opts;
    sel.value = rates.some(x => x.currency === keep) ? keep : '';
  });
  const hint = document.getElementById('rateHint');
  if (hint) hint.style.display = rates.length ? 'none' : '';
}
function addRateRow(x) {
  const div = document.createElement('div');
  div.className = 'field-row';
  div.setAttribute('data-rate', '');
  div.style.marginTop = '4px';
  div.innerHTML = `
    <div class="field" style="max-width:120px;"><input list="curList" data-rate-cur placeholder="USD" value="${x ? esc(x.currency || '') : ''}" style="text-transform:uppercase;"></div>
    <div class="field" style="max-width:130px;"><input inputmode="decimal" data-rate-val placeholder="GHS per 1" value="${x && x.rate ? x.rate : ''}" style="text-align:right;"></div>
    <button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove(); syncCurrencyPickers(); refreshEntryTotal();">✕</button>`;
  document.getElementById('rateRows').appendChild(div);
  syncCurrencyPickers();
}
function resetRates(list) {
  const box = document.getElementById('rateRows');
  if (box) box.innerHTML = '';
  (list || []).forEach(addRateRow);
  syncCurrencyPickers();
}

function catLabelOf(key) {
  if (key.startsWith('seed.')) return 'Seed — ' + key.slice(5);
  if (key.startsWith('activity.')) return 'Harvest Week — ' + key.slice(9);
  if (key.startsWith('special.')) return key.slice(8);
  if (key.startsWith('dayborn.')) return key.slice(8) + '-borns';
  if (key === 'gratitude') return 'Gratitude & Thanksgiving Offering';
  if (key === 'chairpersons') return 'Chairpersons & Co-chairpersons';
  return key;
}
function activitySum(entry) {
  return Object.values(((entry || {}).categories || {}).activities || {}).reduce((a, b) => a + (Number(b) || 0), 0);
}
function seedSum(entry) {
  return Object.values(((entry || {}).categories || {}).seed || {}).reduce((a, b) => a + (Number(b) || 0), 0);
}
const gh = v => (Number(v) || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;

function canManage() {
  if (!me) return false;
  if (isElevated(me)) return true;
  return (me.permissions || []).includes('fundraising.manage');
}
function canVerify() {
  if (!me) return false;
  if (isElevated(me)) return true;
  return (me.permissions || []).includes('fundraising.verify');
}
function canApprove() {
  if (!me) return false;
  if (isElevated(me)) return true;
  return (me.permissions || []).includes('fundraising.approve');
}
function canMarkPaid() { return canManage() || canVerify() || canApprove(); }

function dayStatus(list) {
  if (list.every(e => e.status === 'confirmed')) return 'confirmed';
  if (list.every(e => e.status === 'verified')) return 'verified';
  if (list.some(e => e.submittedAt)) return 'submitted';
  if (list.some(e => e.declined)) return 'declined';
  return 'pending';
}
function statusBadge(list) {
  const s = dayStatus(list);
  if (s === 'confirmed') return `<span class="badge badge-done" title="approved by ${esc(list[0].confirmedBy || '')}">approved ✓ ${esc((list[0].confirmedBy || '').split(' ')[0])}</span>`;
  if (s === 'verified') return `<span class="badge badge-info" title="verified by ${esc(list[0].verifiedBy || '')}">verified · with Treasurer</span>`;
  if (s === 'submitted') return `<span class="badge badge-info" title="submitted by ${esc(list[0].submittedBy || '')}">submitted · with Accounts Clerk</span>`;
  if (s === 'declined') {
    const d = list.find(e => e.declined).declined;
    return `<span class="badge badge-critical" title="${esc(d.reason || '')}">declined by ${esc((d.by || '').split(' ')[0])} — fix &amp; resubmit</span>`;
  }
  return '<span class="badge badge-progress" title="Not yet submitted">draft</span>';
}

// Row actions for an inflow day (21 Nov 2026, per Gideon — the strip of up to
// nine buttons made the list scroll sideways). The row keeps Open and the one
// next step in the approval chain; everything else sits in "More ▾"
// (app.js showActionsMenu), so the list fits the page with no scrolling.
const _dayMenus = {};
function dayActionsHtml(k, list, status, editable, eventId, date) {
  const ev = Number(eventId);
  const next = canManage() && (status === 'pending' || status === 'declined')
      ? { label: 'Submit', fn: () => submitDay(ev, date) }
    : canApprove() && (status === 'verified' || (canVerify() && status === 'submitted'))
      ? { label: 'Approve', fn: () => approveDay(ev, date), title: status === 'verified' ? 'Approve and lock' : 'Verify and approve in one step — both signatures are recorded in your name' }
    : canVerify() && status === 'submitted'
      ? { label: 'Verify', fn: () => verifyDay(ev, date) }
    : null;
  const items = [
    { label: 'Results', onClick: () => viewDay(ev, date) },
    { label: 'Announcement PDF', href: `/api/fundraising/announcement.pdf?eventId=${ev}&date=${date}` },
    canManage() && editable && { label: 'Edit totals', title: "Change the day's totals directly, without sheets", onClick: () => editDay(ev, date) },
    canManage() && (status === 'pending' || status === 'declined') && next && next.label !== 'Submit' && { label: 'Submit', onClick: () => submitDay(ev, date) },
    canVerify() && (status === 'submitted' || status === 'pending' || status === 'declined') && !(next && next.label === 'Verify') && { label: 'Verify', onClick: () => verifyDay(ev, date) },
    canApprove() && (status === 'verified' || (canVerify() && status === 'submitted')) && !(next && next.label === 'Approve') && { label: 'Approve', onClick: () => approveDay(ev, date) },
    'divider',
    (canVerify() || canApprove()) && status !== 'confirmed' && status !== 'pending' && status !== 'declined' && { label: 'Decline', danger: true, onClick: () => declineDay(ev, date) },
    (status === 'confirmed' || status === 'verified') && (isElevated(me)
      ? { label: 'Unlock', danger: true, onClick: () => unconfirmDay(ev, date) }
      : { label: 'Ask to reopen', onClick: () => askToReopen('fundraising-day', { eventId: ev, date }, {})
            .then(sent => { if (sent && typeof window.onReopenRequested === 'function') window.onReopenRequested(); }) }),
    ...(canManage() && editable ? list.map(e => ({
      label: e.service === 'joint' ? 'Delete this entry' : `Delete ${e.service} service entry`,
      danger: true, onClick: () => delEntry(e.id) })) : []),
  ].filter(Boolean);
  while (items.length && items[items.length - 1] === 'divider') items.pop();
  _dayMenus[k] = items;
  return `<div class="fr-act-row">
    <button class="btn btn-secondary btn-sm" onclick="openHarvestSheets(${ev},'${date}')" title="The day: its sheets, entry, tally and report">Open</button>
    ${next ? `<button class="btn btn-primary btn-sm" data-day-next="${esc(k)}"${next.title ? ` title="${esc(next.title)}"` : ''}>${next.label}</button>` : ''}
    <button class="btn btn-secondary btn-sm" data-day-menu="${esc(k)}" aria-haspopup="menu">More ▾</button>
  </div>`;
}
document.addEventListener('click', e => {
  const m = e.target.closest && e.target.closest('[data-day-menu]');
  if (m) { showActionsMenu(m, _dayMenus[m.dataset.dayMenu] || []); return; }
  const n = e.target.closest && e.target.closest('[data-day-next]');
  if (n) {
    const [ev, date] = n.dataset.dayNext.split('|');
    const st = n.textContent.trim();
    if (st === 'Submit') submitDay(Number(ev), date);
    else if (st === 'Verify') verifyDay(Number(ev), date);
    else if (st === 'Approve') approveDay(Number(ev), date);
  }
});

// Target colours (22 Nov 2026, per Gideon): an event's raised figure is green
// once its target is met and red while it isn't. A switch beside the Events
// heading (and on the tally) turns the colours off; the choice is kept on this
// device. Shared with page-fundraising-sheets.js.
const TARGET_COLOURS_KEY = 'aotc.targetColours';
function targetColoursOn() { try { return localStorage.getItem(TARGET_COLOURS_KEY) !== 'off'; } catch (e) { return true; } }
function targetMark(raised, target, html) {
  if (!target || !targetColoursOn()) return html;
  return `<span class="tg-mark ${raised >= target ? 'tg-hit' : 'tg-miss'}" title="${raised >= target ? 'Target met' : 'Target not yet met'}">${html}</span>`;
}
function targetSwitchHtml() {
  return `<label class="tg-switch" title="Green when the target is met, red when it isn't"><input type="checkbox" data-tg-toggle${targetColoursOn() ? ' checked' : ''}> Target colours</label>`;
}
document.addEventListener('change', e => {
  if (!e.target.matches || !e.target.matches('[data-tg-toggle]')) return;
  try { localStorage.setItem(TARGET_COLOURS_KEY, e.target.checked ? 'on' : 'off'); } catch (err) { /* storage off */ }
  document.querySelectorAll('[data-tg-toggle]').forEach(x => { x.checked = e.target.checked; });
  load();
  if (typeof window.refreshHarvestTally === 'function') window.refreshHarvestTally();
});

async function load() {
  data = await api('/fundraising/overview');
  document.getElementById('countLabel').textContent = `${data.year} fundraising year`;
  document.getElementById('statRaised').textContent = gh(data.totalRaised);
  document.getElementById('statTarget').textContent = data.annualTarget ? gh(data.annualTarget) : '—';
  document.getElementById('statSpent').textContent = gh(data.totalSpent);
  document.getElementById('statNet').textContent = gh(data.totalRaised - data.totalSpent);
  document.getElementById('statIou').textContent = gh(data.iouOutstanding || 0);

  document.getElementById('tgSwitchEvents').innerHTML = targetSwitchHtml();
  document.getElementById('eventRows').innerHTML = data.events.map(ev => `<tr>
    <td><b>${esc(ev.name)}</b></td>
    <td class="mono">${ev.target ? gh(ev.target) : '—'}</td>
    <td class="mono">${targetMark(ev.raised, ev.target, `${gh(ev.raised)}${ev.target ? ` <span class="sub">(${Math.round(ev.raised / ev.target * 100)}%)</span>` : ''}`)}</td>
    <td class="mono">${gh(ev.spent)}</td>
    <td class="mono"><b>${gh(ev.net)}</b></td>
    <td style="white-space:nowrap;">${canManage() ? `<button class="btn btn-secondary btn-sm" onclick="editEvent(${ev.id}, '${esc(ev.name).replace(/'/g, "\\'")}', ${ev.target || 'null'})">Edit</button> <button class="btn btn-danger btn-sm" onclick="delEvent(${ev.id})">Del</button>` : ''}</td>
  </tr>`).join('');

  // group entries per event+date (a fundraising DAY)
  const days = {};
  data.entries.forEach(e => {
    const k = `${e.eventId}|${e.date}`;
    (days[k] = days[k] || []).push(e);
  });
  // Days set up but with nothing entered yet are listed too (19 Nov 2026).
  const setUpOnly = (data.days || []).filter(d => !days[`${d.eventId}|${d.date}`]);
  const setUpRows = setUpOnly.map(d => [`${d.eventId}|${d.date}`, null, d]);
  document.getElementById('entryRows').innerHTML = [...Object.entries(days), ...setUpRows]
    .sort((a, b) => b[0].split('|')[1].localeCompare(a[0].split('|')[1]))
    .map(([k, list, dayOnly]) => {
      const [eventId, date] = k.split('|');
      if (dayOnly) {
        const ev = data.events.find(x => x.id === dayOnly.eventId);
        return `<tr>
        <td><b>${esc(ev ? ev.name : dayOnly.eventName || '')}</b><div class="sub">${fmtDate(date)}</div></td>
        <td>${dayOnly.shape === 'dual' ? '1st + 2nd' : 'joint'}</td>
        <td class="mono">${gh(0)}</td>
        <td><span class="badge badge-progress">set up — nothing entered yet</span></td>
        <td class="fr-act"><div class="fr-act-row"><button class="btn btn-primary btn-sm" onclick="openHarvestSheets(${eventId},'${date}')" title="Print the sheets and enter them">Open</button></div></td>
      </tr>`;
      }
      const total = list.reduce((s, e) => s + (e.total || 0), 0);
      const status = dayStatus(list);
      const svc = list.map(e => e.service).sort().join(' + ');
      const editable = status === 'pending' || status === 'declined' || status === 'submitted';
      return `<tr>
        <td><b>${esc(list[0].eventName)}</b><div class="sub">${fmtDate(date)}</div></td>
        <td>${esc(svc)}</td>
        <td class="mono">${gh(total)}</td>
        <td>${statusBadge(list)}</td>
        <td class="fr-act">${dayActionsHtml(k, list, status, editable, eventId, date)}</td>
      </tr>`;
    }).join('') || '<tr><td colspan="5" class="sub">No inflows recorded yet.</td></tr>';

  // IOU register — outstanding first (soonest due), then paid
  const todayStr = new Date().toISOString().slice(0, 10);
  const ious = (data.ious || []).slice().sort((a, b) =>
    a.status === b.status ? (a.dueDate || '').localeCompare(b.dueDate || '') : a.status === 'paid' ? 1 : -1);
  document.getElementById('iouRows').innerHTML = ious.map(i => {
    const overdue = i.status !== 'paid' && i.dueDate && i.dueDate < todayStr;
    const badge = i.status === 'paid'
      ? `<span class="badge badge-done" title="marked by ${esc(i.paidBy || '')}">paid ✓</span>`
      : overdue ? '<span class="badge badge-critical">OVERDUE</span>'
        : '<span class="badge badge-progress">outstanding</span>';
    return `<tr>
      <td><b>${esc(i.name)}</b></td>
      <td>${esc(i.contact || '—')}</td>
      <td class="mono">${gh(i.amount)}</td>
      <td>${i.dueDate ? fmtDate(i.dueDate) : '—'}</td>
      <td class="sub">${esc(i.eventName)} · ${fmtDate(i.date)} (${esc(i.service)})</td>
      <td>${badge}</td>
      <td>${i.status !== 'paid' && canMarkPaid() ? `<button class="btn btn-primary btn-sm" onclick="markIouPaid(${i.id})">Mark paid</button>` : ''}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="sub">No IOUs on the register.</td></tr>';

  document.getElementById('expRows').innerHTML = data.expenses.slice().reverse().map(x => `<tr>
    <td>${esc(x.eventName)}</td><td>${esc(x.description)}<div class="sub">${esc(x.date || '')}</div></td><td class="mono">${gh(x.amount)}</td>
    <td style="white-space:nowrap;">${canManage() ? `<button class="btn btn-secondary btn-sm" onclick="editExp(${x.id}, '${esc(x.description).replace(/'/g, "\\'")}', ${x.amount || 0}, '${esc(x.date || '')}')">Edit</button> <button class="btn btn-danger btn-sm" onclick="delExp(${x.id})">Del</button>` : ''}</td>
  </tr>`).join('') || '<tr><td colspan="4" class="sub">No expenses yet.</td></tr>';

  const evOpts = data.events.map(ev => `<option value="${ev.id}">${esc(ev.name)}</option>`).join('');
  document.getElementById('eEvent').innerHTML = evOpts;
  document.getElementById('xEvent').innerHTML = evOpts;

  document.getElementById('tAnnual').value = data.annualTarget ? data.annualTarget.toLocaleString() : '';
  document.getElementById('tEvents').innerHTML = data.events.map(ev => `
    <div class="field" style="max-width:260px;"><label>${esc(ev.name)} target (GHS)</label>
      <input inputmode="decimal" data-num data-target="${ev.id}" value="${ev.target ? ev.target.toLocaleString() : ''}"></div>`).join('');
  seedDraft = (data.seedCategories || SEED_DEFAULT).slice();
  activityDraft = (data.activityCategories || []).slice();
  renderActivityCard();
  renderSeedCard();
  document.getElementById('seedCard').style.display = canManage() ? '' : 'none';
  const actCard = document.getElementById('activityCard');
  if (actCard) actCard.style.display = canManage() ? '' : 'none';
  document.getElementById('targetCard').style.display = canManage() ? '' : 'none';
  document.getElementById('entryBtn').style.display = canManage() ? '' : 'none';
}

// ---- Entry modal: streams grid ----
function isDual() { return document.getElementById('eDayType').value === 'dual'; }
function svcLabel(p) { return isDual() ? (p === 's1' ? '1st service' : '2nd service') : 'Joint service'; }
function renderCatGrid() {
  const dual = isDual();
  document.getElementById('catHead').innerHTML = dual
    ? '<tr><th>Category</th><th style="text-align:right;">1st service</th><th style="width:38px;"></th><th style="text-align:right;">2nd service</th><th style="width:38px;"></th></tr>'
    : '<tr><th>Category</th><th style="text-align:right;">Amount (GHS)</th><th style="width:38px;"></th></tr>';
  const span = dual ? 5 : 3;
  const SHADE = 'background:var(--surface-2,#EEF1F7);';
  // The figure and its breakdown button get a column each, so a dual-service
  // day has room to breathe instead of two controls fighting over one cell.
  const amountCell = (p, key, cellShade) => `<td style="text-align:right; ${cellShade}">
      <input inputmode="decimal" data-num data-cat="${p}.${esc(key)}" style="width:120px; max-width:100%; text-align:right;">
    </td>
    <td style="text-align:center; ${cellShade}">
      <button type="button" class="btn btn-secondary btn-sm" data-bdbtn="${p}.${esc(key)}" title="Break this basket down — count the cash, list cheques, transfers, MoMo, foreign notes and pledges" onclick="toggleBreakdown('${p}','${esc(key)}')">⊞</button>
    </td>`;
  const catRow = (key, label, indent, isHead) => `<tr data-catrow="${esc(key)}"${isHead ? ` style="${SHADE}"` : ''}>
      <td${indent ? ' style="padding-left:18px;"' : ''}>${isHead ? `<b>${esc(label)}</b>` : esc(label)}</td>
      ${amountCell('s1', key, isHead ? SHADE : '')}
      ${dual ? amountCell('s2', key, isHead ? SHADE : '') : ''}
    </tr>`;
  document.getElementById('catRows').innerHTML = catGroups().map(g => g.inline
    ? catRow(g.rows[0][0], g.title, false, true)
    : `<tr><td colspan="${span}" style="${SHADE}"><b>${esc(g.title)}</b></td></tr>`
      + g.rows.map(([key, label]) => catRow(key, label, true, false)).join('')
  ).join('');
  document.getElementById('catFoot').innerHTML = dual
    ? '<tr><td><b>Service totals</b></td><td class="mono" style="text-align:right;"><b id="eTotal1">0.00</b></td><td></td><td class="mono" style="text-align:right;"><b id="eTotal2">0.00</b></td><td></td></tr>' +
      '<tr><td><b>Grand total</b></td><td colspan="4" class="mono" style="text-align:right;"><b id="eTotal">0.00</b></td></tr>'
    : '<tr><td><b>Total</b></td><td class="mono" style="text-align:right;"><b id="eTotal">0.00</b></td><td></td></tr>';
  renderMethodsPanels();
  refreshEntryTotal();
}

// ---- Entry modal: payment methods / forex / IOU panels ----
function denomTable(p, kind, heading) {
  const rows = denoms().filter(d => d.kind === kind).map(d => `<tr>
    <td style="white-space:nowrap;">${esc(d.label)}</td>
    <td style="text-align:right;"><input inputmode="numeric" data-den="${p}.${d.key}" placeholder="0" style="max-width:66px; text-align:right;"></td>
    <td class="mono sub" style="text-align:right; min-width:80px;" data-denline="${p}.${d.key}">0.00</td>
  </tr>`).join('');
  return `<table style="flex:1; min-width:210px;">
    <thead><tr><th>${heading}</th><th style="text-align:right;">Qty</th><th style="text-align:right;">GHS</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}
function methodsPanel(p) {
  return `<div class="card" style="margin-bottom:12px; padding:12px 14px;" data-mpanel="${p}">
    <div class="section-title"><h3 style="font-size:0.95em;">How it came in — ${svcLabel(p)}</h3></div>
    <div class="sub" style="margin:-4px 0 8px;">Anything you have <b>not</b> already counted inside a basket above goes here.</div>
    <div class="field-row">
      <div class="field" style="max-width:150px;"><label>Cash (GHS)</label><input inputmode="decimal" data-num data-mth="${p}.cash" style="text-align:right;"></div>
      <div class="field" style="max-width:150px;"><label>MoMo (GHS)</label><input inputmode="decimal" data-num data-mth="${p}.momo" style="text-align:right;"></div>
    </div>
    <details data-dencard="${p}" style="margin-top:4px;">
      <summary style="cursor:pointer; font-size:0.85em;"><b>Count the cash</b> <span class="sub">— how many of each note and coin; the total fills the Cash box</span></summary>
      <div class="field-row" style="align-items:flex-start; gap:14px; margin-top:6px;">
        ${denomTable(p, 'note', 'Notes')}
        ${denomTable(p, 'coin', 'Coins')}
      </div>
      <div class="sub" style="text-align:right; margin-top:4px;">Counted: <b class="mono" data-dentotal="${p}">0.00</b>
        <button type="button" class="btn btn-secondary btn-sm" style="margin-left:8px;" onclick="clearDenoms('${p}')">Clear count</button></div>
    </details>
    <div style="margin-top:10px;"><b style="font-size:0.85em;">Cheques</b> <span class="sub">cheque number, bank, amount — one row per cheque</span>
      <div data-chq-rows="${p}"></div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="addChqRow('${p}')">+ Cheque</button>
      <span class="sub mono" style="margin-left:8px;">total <b data-chqtotal="${p}">0.00</b></span>
    </div>
    <div style="margin-top:10px;"><b style="font-size:0.85em;">Bank transfers</b> <span class="sub">bank, transaction reference, amount</span>
      <div data-trf-rows="${p}"></div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="addTrfRow('${p}')">+ Bank transfer</button>
      <span class="sub mono" style="margin-left:8px;">total <b data-trftotal="${p}">0.00</b></span>
    </div>
    <div style="margin-top:10px;"><b style="font-size:0.85em;">Forex</b> <span class="sub">amount + currency + rate → GHS</span>
      <div data-fx-rows="${p}"></div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="addFxRow('${p}')">+ Forex</button>
    </div>
    <div style="margin-top:10px;"><b style="font-size:0.85em;">IOUs (pledges)</b> <span class="sub">name, contact, amount, proposed payment date — reminders are automatic</span>
      <div data-iou-rows="${p}"></div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="addIouRow('${p}')">+ IOU</button>
    </div>
    <div class="sub" data-rollup="${p}" style="margin-top:10px;"></div>
    <div id="recon-${p}" class="sub" style="margin-top:4px;"></div>
  </div>`;
}
function renderMethodsPanels() {
  const panels = isDual() ? ['s1', 's2'] : ['s1'];
  document.getElementById('methodsWrap').innerHTML = panels.map(methodsPanel).join('');
}
function fxRowHtml(f) {
  return `<div class="field" style="max-width:120px;"><select data-fx-cur></select></div>
    <div class="field" style="max-width:130px;"><input inputmode="decimal" data-num data-fx-amt placeholder="Amount" value="${f && f.amount ? f.amount.toLocaleString() : ''}" style="text-align:right;"></div>
    <div class="field" style="max-width:140px;"><span class="mono sub" data-fx-ghs>= GHS 0.00</span></div>
    <button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove(); refreshEntryTotal();">✕</button>`;
}
function attachFxRow(box, f, marker, p) {
  const div = document.createElement('div');
  div.className = 'field-row';
  div.setAttribute(marker, p === undefined ? '' : p);
  div.style.marginTop = '4px';
  div.innerHTML = fxRowHtml(f);
  box.appendChild(div);
  syncCurrencyPickers();
  if (f && f.currency) div.querySelector('[data-fx-cur]').value = f.currency;
  return div;
}
function addFxRow(p, f) {
  attachFxRow(document.querySelector(`[data-fx-rows="${p}"]`), f, 'data-fx', p);
}
function addIouRow(p, i) {
  const div = document.createElement('div');
  div.className = 'field-row';
  div.setAttribute('data-iou', p);
  div.style.marginTop = '4px';
  div.innerHTML = `
    <div class="field"><input data-iou-name placeholder="Full name" value="${i ? esc(i.name) : ''}"></div>
    <div class="field" style="max-width:140px;"><input data-iou-contact placeholder="Phone" value="${i ? esc(i.contact || '') : ''}"></div>
    <div class="field" style="max-width:120px;"><input inputmode="decimal" data-num data-iou-amt placeholder="GHS" value="${i && i.amount ? i.amount.toLocaleString() : ''}" style="text-align:right;"></div>
    <div class="field" style="max-width:160px;"><input type="date" data-iou-due title="Proposed payment date" value="${i ? esc(i.dueDate || '') : ''}"></div>
    <button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove(); refreshEntryTotal();">✕</button>`;
  document.querySelector(`[data-iou-rows="${p}"]`).appendChild(div);
}

// ---- Bank picker (21 Nov 2026, per Gideon) ----
// Every "Bank" box on the harvest forms is a dropdown of the 23 universal banks
// licensed by the Bank of Ghana (BoG register, Nov 2026), plus "Other" for a
// rural/community bank, savings & loans or anything renamed since. The chosen
// name goes into a plain text input beside it (the one the save code reads),
// so nothing downstream changes; that input only shows for "Other". A value
// saved before that isn't on the list opens as Other with the text kept.
// When a bank merges or renames, change this list (store the short name).
const GH_BANKS = [
  'Absa Bank Ghana', 'Access Bank Ghana', 'ADB (Agricultural Development Bank)', 'Bank of Africa Ghana',
  'CalBank', 'Consolidated Bank Ghana (CBG)', 'Ecobank Ghana', 'Fidelity Bank Ghana', 'First Atlantic Bank',
  'First National Bank Ghana', 'FirstBank Ghana', 'GCB Bank', 'GTBank Ghana', 'National Investment Bank (NIB)',
  'OmniBSIC Bank Ghana', 'Prudential Bank', 'Republic Bank Ghana', 'Société Générale Ghana', 'Stanbic Bank Ghana',
  'Standard Chartered Bank Ghana', 'UBA Ghana', 'Universal Merchant Bank (UMB)', 'Zenith Bank Ghana',
];
// attrs: the attributes the text input carries today (e.g. 'data-chq-bank' or
// 'data-k="bank" data-nav'); style: optional width for the select.
function bankPickHtml(attrs, value, style) {
  const v = String(value || '').trim();
  const known = GH_BANKS.find(b => b.toLowerCase() === v.toLowerCase());
  const other = !!v && !known;
  const nav = /\bdata-nav\b/.test(attrs) ? ' data-nav' : '';
  return `<select data-bank-pick${nav} aria-label="Bank"${style ? ` style="${style}"` : ''}>
      <option value="">Bank…</option>
      ${GH_BANKS.map(b => `<option${known === b ? ' selected' : ''}>${esc(b)}</option>`).join('')}
      <option value="__other"${other ? ' selected' : ''}>Other (type it)…</option>
    </select><input ${attrs} placeholder="Type the bank" autocomplete="off" value="${esc(known || v)}"
      style="${other ? '' : 'display:none;'}${style || ''}">`;
}
document.addEventListener('change', e => {
  const sel = e.target.closest && e.target.closest('select[data-bank-pick]');
  if (!sel) return;
  const box = sel.nextElementSibling;
  if (!box) return;
  if (sel.value === '__other') { box.style.display = ''; box.value = ''; box.focus(); }
  else { box.style.display = 'none'; box.value = sel.value; }
  box.dispatchEvent(new Event('input', { bubbles: true }));
});

function addChqRow(p, c) {
  const div = document.createElement('div');
  div.className = 'field-row';
  div.setAttribute('data-chq', p);
  div.style.marginTop = '4px';
  div.innerHTML = `
    <div class="field" style="max-width:150px;"><input data-chq-no placeholder="Cheque no." value="${c ? esc(c.number || '') : ''}"></div>
    <div class="field">${bankPickHtml('data-chq-bank', c && c.bank)}</div>
    <div class="field" style="max-width:130px;"><input inputmode="decimal" data-num data-chq-amt placeholder="GHS" value="${c && c.amount ? c.amount.toLocaleString() : ''}" style="text-align:right;"></div>
    <button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove(); refreshEntryTotal();">✕</button>`;
  document.querySelector(`[data-chq-rows="${p}"]`).appendChild(div);
}
function addTrfRow(p, t) {
  const div = document.createElement('div');
  div.className = 'field-row';
  div.setAttribute('data-trf', p);
  div.style.marginTop = '4px';
  div.innerHTML = `
    <div class="field">${bankPickHtml('data-trf-bank', t && t.bank)}</div>
    <div class="field" style="max-width:170px;"><input data-trf-ref placeholder="Reference" value="${t ? esc(t.reference || '') : ''}"></div>
    <div class="field" style="max-width:130px;"><input inputmode="decimal" data-num data-trf-amt placeholder="GHS" value="${t && t.amount ? t.amount.toLocaleString() : ''}" style="text-align:right;"></div>
    <button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove(); refreshEntryTotal();">✕</button>`;
  document.querySelector(`[data-trf-rows="${p}"]`).appendChild(div);
}
// ---- Per-basket breakdown ----
// Any basket can be counted on its own: its own cash (typed or counted note by
// note), MoMo, cheques and bank transfers. When a basket has a breakdown, the
// breakdown IS its amount — the figure in the grid fills itself and locks.
// IOUs and forex stay at service level; they attach to a person or a currency,
// not to a basket.
function bdRowFields(kind, v) {
  if (kind === 'chq') {
    return `<div class="field" style="max-width:130px;"><input data-chq-no placeholder="Cheque no." value="${v ? esc(v.number || '') : ''}"></div>
       <div class="field">${bankPickHtml('data-chq-bank', v && v.bank)}</div>
       <div class="field" style="max-width:120px;"><input inputmode="decimal" data-num data-chq-amt placeholder="GHS" value="${v && v.amount ? v.amount.toLocaleString() : ''}" style="text-align:right;"></div>`;
  }
  if (kind === 'trf') {
    return `<div class="field">${bankPickHtml('data-trf-bank', v && v.bank)}</div>
       <div class="field" style="max-width:150px;"><input data-trf-ref placeholder="Reference" value="${v ? esc(v.reference || '') : ''}"></div>
       <div class="field" style="max-width:120px;"><input inputmode="decimal" data-num data-trf-amt placeholder="GHS" value="${v && v.amount ? v.amount.toLocaleString() : ''}" style="text-align:right;"></div>`;
  }
  return `<div class="field"><input data-iou-name placeholder="Full name" value="${v ? esc(v.name || '') : ''}"></div>
     <div class="field" style="max-width:130px;"><input data-iou-contact placeholder="Phone" value="${v ? esc(v.contact || '') : ''}"></div>
     <div class="field" style="max-width:110px;"><input inputmode="decimal" data-num data-iou-amt placeholder="GHS" value="${v && v.amount ? v.amount.toLocaleString() : ''}" style="text-align:right;"></div>
     <div class="field" style="max-width:150px;"><input type="date" data-iou-due title="Proposed payment date" value="${v ? esc(v.dueDate || '') : ''}"></div>`;
}
function bdAddRow(panel, kind, v) {
  if (kind === 'fx') return attachFxRow(panel.querySelector('[data-bd-fx-rows]'), v, 'data-bdfx');
  const box = panel.querySelector(`[data-bd-${kind}-rows]`);
  const div = document.createElement('div');
  div.className = 'field-row';
  div.setAttribute(kind === 'chq' ? 'data-bdchq' : kind === 'trf' ? 'data-bdtrf' : 'data-bdiou', '');
  div.style.marginTop = '4px';
  div.innerHTML = bdRowFields(kind, v)
    + '<button type="button" class="btn btn-danger btn-sm" onclick="this.parentElement.remove(); refreshEntryTotal();">✕</button>';
  box.appendChild(div);
  return div;
}
function bdAdd(btn, kind) { bdAddRow(btn.closest('[data-bdpanel]'), kind); refreshEntryTotal(); }
function bdAddChq(btn) { bdAdd(btn, 'chq'); }
function bdAddTrf(btn) { bdAdd(btn, 'trf'); }
function bdPanelHtml(p, key) {
  const denRows = kind => denoms().filter(d => d.kind === kind).map(d => `<tr>
      <td style="white-space:nowrap;">${esc(d.label)}</td>
      <td style="text-align:right;"><input inputmode="numeric" data-bd-den="${d.key}" placeholder="0" style="max-width:60px; text-align:right;"></td>
      <td class="mono sub" style="text-align:right; min-width:76px;" data-bd-denline="${d.key}">0.00</td>
    </tr>`).join('');
  return `<div class="card" style="padding:10px 12px; margin:6px 0;">
    <div class="section-title"><h3 style="font-size:0.88em;">${esc(catLabelOf(key))} — how this basket came in (${svcLabel(p)})</h3></div>
    <div class="field-row">
      <div class="field" style="max-width:140px;"><label>Cash (GHS)</label><input inputmode="decimal" data-num data-bd-cash style="text-align:right;"></div>
      <div class="field" style="max-width:140px;"><label>MoMo (GHS)</label><input inputmode="decimal" data-num data-bd-momo style="text-align:right;"></div>
    </div>
    <details data-bd-dencard style="margin-top:4px;">
      <summary style="cursor:pointer; font-size:0.82em;"><b>Count this basket</b> <span class="sub">— notes and coins</span></summary>
      <div class="field-row" style="align-items:flex-start; gap:14px; margin-top:6px;">
        <table style="flex:1; min-width:196px;"><thead><tr><th>Notes</th><th style="text-align:right;">Qty</th><th style="text-align:right;">GHS</th></tr></thead><tbody>${denRows('note')}</tbody></table>
        <table style="flex:1; min-width:196px;"><thead><tr><th>Coins</th><th style="text-align:right;">Qty</th><th style="text-align:right;">GHS</th></tr></thead><tbody>${denRows('coin')}</tbody></table>
      </div>
      <div class="sub" style="text-align:right; margin-top:4px;">Counted: <b class="mono" data-bd-dentotal>0.00</b></div>
    </details>
    <div style="margin-top:8px;"><b style="font-size:0.82em;">Cheques</b> <span class="sub">number, bank, amount</span>
      <div data-bd-chq-rows></div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="bdAddChq(this)">+ Cheque</button></div>
    <div style="margin-top:8px;"><b style="font-size:0.82em;">Bank transfers</b> <span class="sub">bank, reference, amount</span>
      <div data-bd-trf-rows></div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="bdAddTrf(this)">+ Bank transfer</button></div>
    <div style="margin-top:8px;"><b style="font-size:0.82em;">Foreign notes</b> <span class="sub">converted at today’s rates</span>
      <div data-bd-fx-rows></div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="bdAdd(this,'fx')">+ Foreign</button></div>
    <div style="margin-top:8px;"><b style="font-size:0.82em;">Pledges (IOUs)</b> <span class="sub">counted in this basket; reminders are automatic</span>
      <div data-bd-iou-rows></div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="bdAdd(this,'iou')">+ Pledge</button></div>
    <div class="field-row" style="margin-top:8px; justify-content:space-between; align-items:center;">
      <span class="sub">Total for this basket: <b class="mono" data-bd-total>0.00</b></span>
      <span style="display:flex; gap:6px;">
        <button type="button" class="btn btn-primary btn-sm" onclick="saveBasket('${p}','${esc(key)}')">Save this basket</button>
        <button type="button" class="btn btn-danger btn-sm" onclick="clearBreakdown('${p}','${esc(key)}')">Clear breakdown</button>
      </span>
    </div>
    <div class="sub" data-bd-verdict style="margin-top:6px; font-size:12px;"></div>
  </div>`;
}
// One row per basket holding one panel per service, so on a dual-service day
// the 1st and 2nd service counts of the same basket sit side by side.
function bdRowFor(key) { return document.querySelector(`tr[data-bdrow="${key}"]`); }
function bdPanelFor(p, key) { return document.querySelector(`[data-bdpanel][data-bdsvc="${p}"][data-bdkey="${key}"]`); }
// `collapsed` builds the panel but leaves it folded. Opening a saved day used
// to expand every basket that had been counted, so the Clerk arrived at a wall
// of cash sheets and cheque rows and had to scroll to find out where he was.
// The figure is what he needs at a glance; the detail is a click away.
function buildBreakdown(p, key, collapsed) {
  const found = bdPanelFor(p, key);
  if (found) return found;
  let tr = bdRowFor(key);
  if (!tr) {
    const row = document.querySelector(`tr[data-catrow="${key}"]`);
    if (!row) return null;
    tr = document.createElement('tr');
    tr.setAttribute('data-bdrow', key);
    tr.innerHTML = `<td colspan="${isDual() ? 5 : 3}" style="padding:0 4px;">
      <div class="field-row" data-bdwrap style="align-items:flex-start; gap:12px;"></div></td>`;
    row.parentNode.insertBefore(tr, row.nextSibling);
  }
  const wrap = tr.querySelector('[data-bdwrap]');
  const panel = document.createElement('div');
  panel.setAttribute('data-bdpanel', '');
  panel.setAttribute('data-bdsvc', p);
  panel.setAttribute('data-bdkey', key);
  panel.style.flex = '1';
  panel.style.minWidth = '330px';
  panel.innerHTML = bdPanelHtml(p, key);
  if (collapsed) panel.style.display = 'none';
  const second = wrap.querySelector('[data-bdsvc="s2"]');
  if (p === 's1' && second) wrap.insertBefore(panel, second);
  else wrap.appendChild(panel);
  markCounted(p, key);
  return panel;
}
// A folded panel has to announce itself, or a counted basket looks identical to
// an uncounted one. The ⊞ button becomes ⊟ and says what it holds.
function markCounted(p, key) {
  const btn = document.querySelector(`[data-bdbtn="${p}.${key}"]`);
  if (!btn) return;
  const panel = bdPanelFor(p, key);
  const counted = !!panel;
  const open = counted && panel.style.display !== 'none';
  btn.textContent = counted ? (open ? '⊟' : '⊞') : '⊞';
  btn.classList.toggle('btn-primary', counted);
  btn.classList.toggle('btn-secondary', !counted);
  btn.title = counted
    ? (open ? 'Hide this basket’s breakdown' : 'This basket is counted — click to see the breakdown')
    : 'Break this basket down — count the cash, list cheques, transfers, MoMo, foreign notes and pledges';
}
// Only one basket's detail is open at a time. Twelve panels open at once is the
// wall of cash sheets this was moved away from, and it made it impossible to
// see where you were in the counting.
function foldOthers(exceptPanel) {
  document.querySelectorAll('[data-bdpanel]').forEach(el => {
    if (el === exceptPanel || el.style.display === 'none') return;
    el.style.display = 'none';
    markCounted(el.getAttribute('data-bdsvc'), el.getAttribute('data-bdkey'));
  });
}
function toggleBreakdown(p, key) {
  const panel = bdPanelFor(p, key);
  if (panel) {
    const opening = panel.style.display === 'none';
    if (opening) foldOthers(panel);
    panel.style.display = opening ? '' : 'none';
    markCounted(p, key);
    return;
  }
  const made = buildBreakdown(p, key);
  foldOthers(made);
  markCounted(p, key);
  refreshEntryTotal();
}
function clearBreakdown(p, key) {
  const panel = bdPanelFor(p, key);
  if (panel) {
    const tr = panel.closest('tr');
    panel.remove();
    if (tr && !tr.querySelector('[data-bdpanel]')) tr.remove();
  }
  const catEl = document.querySelector(`[data-cat="${p}.${key}"]`);
  if (catEl) { catEl.readOnly = false; catEl.style.background = ''; catEl.title = ''; }
  markCounted(p, key);
  refreshEntryTotal();
}
// ---- Saving one basket -----------------------------------------------------
// The counting happens basket by basket — the Gratitude offering, the
// Chairpersons, then the day-borns one day at a time — so each is committed and
// answered for as it is finished. A mistake then surfaces at the basket that is
// wrong, while the money is still on the table, instead of at the end as an
// error about the whole service.
//
// The day's own reconciliation is NOT checked here and must not be: a
// half-counted day legitimately does not balance. It is checked at submit.
async function saveBasket(p, key) {
  const eventId = document.getElementById('eEvent').value;
  const date = document.getElementById('eDate').value;
  if (!eventId || !date) return toast('Pick the event and the date first.', true);
  const service = isDual() ? (p === 's1' ? '1st' : '2nd') : 'joint';
  const panel = bdPanelFor(p, key);
  const body = { eventId, date, service, key, rates: collectRates() };
  if (panel) body.breakdown = bdCollect(panel);
  else {
    const el = document.querySelector(`[data-cat="${p}.${key}"]`);
    body.amount = numVal((el || {}).value) || 0;
  }
  const box = panel && panel.querySelector('[data-bd-verdict]');
  if (box) box.innerHTML = '<span class="sub">Saving…</span>';
  try {
    const r = await api('/fundraising/entries/basket', { method: 'PUT', body });
    // The saved basket is a fact now, so this typing no longer needs the
    // working copy standing behind it. The rest of the day still does, so the
    // draft is refreshed rather than dropped.
    draftWrite();
    if (Array.isArray(data.entries)) {
      const i = data.entries.findIndex(e => e.id === r.entry.id);
      if (i >= 0) data.entries[i] = r.entry; else data.entries.push(r.entry);
    }
    renderBasketVerdict(p, key, r);
    toast(`${r.label} saved — GHS ${gh(r.basket.amount)}`);
  } catch (e) {
    if (box) box.innerHTML = `<b style="color:var(--danger,#c0392b);">Not saved</b> — ${esc(e.message)}`;
    toast(e.message, true);
  }
}
// What the server said about this basket, and where the day stands. The day
// line is progress, not a verdict — it must not read as an error while the
// counting is still going on.
function renderBasketVerdict(p, key, r) {
  const panel = bdPanelFor(p, key);
  const box = panel && panel.querySelector('[data-bd-verdict]');
  if (!box) return;
  const d = r.day || {};
  const basket = r.basket || {};
  const head = basket.counted
    ? (basket.reconciles
      ? `<b style="color:var(--ok,#178a43);">✓ Saved</b> — GHS ${gh(basket.amount)}, and the count adds up`
      : `<b style="color:var(--danger,#c0392b);">✗ Saved, but the count does not add up</b> — figure GHS ${gh(basket.amount)} against a breakdown of GHS ${gh(basket.breakdownTotal)}`)
    : `<b style="color:var(--ok,#178a43);">✓ Saved</b> — GHS ${gh(basket.amount)}, typed. Nothing to check here: money not counted in its own basket is covered by the service figures.`;
  const prog = d.balances
    ? `<span style="color:var(--ok,#178a43);">the day balances</span>`
    : `the day is ${d.diff > 0 ? 'short' : 'over'} by GHS ${gh(Math.abs(d.diff || 0))} so far`;
  box.innerHTML = `${head}<br><span class="sub">${d.countedBaskets || 0} of ${d.baskets || 0} baskets counted · ${prog}. `
    + `A day only has to balance when it is submitted.</span>`;
}

function bdCollect(panel) {
  const num = sel => numVal((panel.querySelector(sel) || {}).value) || 0;
  const cashCount = {};
  panel.querySelectorAll('[data-bd-den]').forEach(el => {
    const q = Math.floor(numVal(el.value) || 0);
    if (q > 0) cashCount[el.getAttribute('data-bd-den')] = q;
  });
  const hasCount = Object.keys(cashCount).length > 0;
  const counted = r2(Object.entries(cashCount).reduce((a, [k, q]) => a + q * denomValue(k), 0));
  const cash = hasCount ? counted : num('[data-bd-cash]');
  const momo = num('[data-bd-momo]');
  const cheques = [...panel.querySelectorAll('[data-bdchq]')].map(row => ({
    number: (row.querySelector('[data-chq-no]').value || '').trim(),
    bank: (row.querySelector('[data-chq-bank]').value || '').trim(),
    amount: numVal(row.querySelector('[data-chq-amt]').value) || 0,
  })).filter(c => c.number || c.amount > 0);
  const transfers = [...panel.querySelectorAll('[data-bdtrf]')].map(row => ({
    bank: (row.querySelector('[data-trf-bank]').value || '').trim(),
    reference: (row.querySelector('[data-trf-ref]').value || '').trim(),
    amount: numVal(row.querySelector('[data-trf-amt]').value) || 0,
  })).filter(t => t.bank || t.amount > 0);
  const forex = readFxRows(panel.querySelectorAll('[data-bdfx]'));
  const ious = [...panel.querySelectorAll('[data-bdiou]')].map(row => ({
    name: (row.querySelector('[data-iou-name]').value || '').trim(),
    contact: (row.querySelector('[data-iou-contact]').value || '').trim(),
    amount: numVal(row.querySelector('[data-iou-amt]').value) || 0,
    dueDate: row.querySelector('[data-iou-due]').value || '',
  })).filter(i => i.name && i.amount > 0);
  const chequeTotal = r2(cheques.reduce((a, c) => a + c.amount, 0));
  const transferTotal = r2(transfers.reduce((a, t) => a + t.amount, 0));
  const forexGhs = r2(forex.reduce((a, f) => a + f.amount * f.rate, 0));
  const iouTotal = r2(ious.reduce((a, i) => a + i.amount, 0));
  return { cash, momo, cashCount, cheques, transfers, forex, ious, hasCount, counted,
    total: r2(cash + momo + chequeTotal + transferTotal + forexGhs + iouTotal) };
}
function bdPanels(p) { return document.querySelectorAll(`[data-bdpanel][data-bdsvc="${p}"]`); }
function collectCatMethods(p) {
  const out = {};
  bdPanels(p).forEach(panel => {
    const bd = bdCollect(panel);
    out[panel.getAttribute('data-bdkey')] = {
      cash: bd.cash, momo: bd.momo, cashCount: bd.cashCount,
      cheques: bd.cheques, transfers: bd.transfers, forex: bd.forex, ious: bd.ious,
    };
  });
  return out;
}
function catMethodsTotal(p) {
  let sum = 0;
  bdPanels(p).forEach(panel => { sum += bdCollect(panel).total; });
  return r2(sum);
}
// Push every breakdown's total into its grid figure and lock it.
function applyBreakdowns(p) {
  bdPanels(p).forEach(panel => {
    const bd = bdCollect(panel);
    panel.querySelectorAll('[data-bd-den]').forEach(el => {
      const k = el.getAttribute('data-bd-den');
      const line = panel.querySelector(`[data-bd-denline="${k}"]`);
      if (line) line.textContent = gh((Math.floor(numVal(el.value) || 0)) * denomValue(k));
    });
    const dt = panel.querySelector('[data-bd-dentotal]');
    if (dt) dt.textContent = gh(bd.counted);
    const cashEl = panel.querySelector('[data-bd-cash]');
    if (cashEl) {
      cashEl.readOnly = bd.hasCount;
      cashEl.style.background = bd.hasCount ? 'var(--surface-2, #EEF1F7)' : '';
      if (bd.hasCount) cashEl.value = bd.counted.toLocaleString(undefined, { minimumFractionDigits: 2 });
    }
    const tot = panel.querySelector('[data-bd-total]');
    if (tot) tot.textContent = gh(bd.total);
    const catEl = document.querySelector(`[data-cat="${p}.${panel.getAttribute('data-bdkey')}"]`);
    if (catEl) {
      catEl.readOnly = true;
      catEl.style.background = 'var(--surface-2, #EEF1F7)';
      catEl.title = 'Computed from this basket\u2019s breakdown — use “Clear breakdown” to type a figure instead.';
      catEl.value = bd.total.toLocaleString(undefined, { minimumFractionDigits: 2 });
    }
  });
}

function collectCashCount(p) {
  const out = {};
  document.querySelectorAll(`[data-den^="${p}."]`).forEach(el => {
    const q = Math.floor(numVal(el.value) || 0);
    if (q > 0) out[el.dataset.den.slice(p.length + 1)] = q;
  });
  return out;
}
function cashCountedTotal(p) {
  const counts = collectCashCount(p);
  return r2(Object.entries(counts).reduce((s, [k, q]) => s + q * denomValue(k), 0));
}
// The counting sheet owns the Cash box whenever anything has been counted.
function refreshCash(p) {
  const counts = collectCashCount(p);
  denoms().forEach(d => {
    const el = document.querySelector(`[data-denline="${p}.${d.key}"]`);
    if (el) el.textContent = gh((counts[d.key] || 0) * d.value);
  });
  const counted = Object.keys(counts).length > 0;
  const tot = cashCountedTotal(p);
  const tEl = document.querySelector(`[data-dentotal="${p}"]`);
  if (tEl) tEl.textContent = gh(tot);
  const cashEl = document.querySelector(`[data-mth="${p}.cash"]`);
  if (cashEl) {
    cashEl.readOnly = counted;
    cashEl.title = counted ? 'Computed from the denomination count — clear the count to type a figure.' : '';
    cashEl.style.background = counted ? 'var(--surface-2, #EEF1F7)' : '';
    if (counted) cashEl.value = tot.toLocaleString(undefined, { minimumFractionDigits: 2 });
  }
}
function clearDenoms(p) {
  document.querySelectorAll(`[data-den^="${p}."]`).forEach(el => { el.value = ''; });
  const cashEl = document.querySelector(`[data-mth="${p}.cash"]`);
  if (cashEl) { cashEl.readOnly = false; cashEl.value = ''; cashEl.style.background = ''; }
  refreshEntryTotal();
}
function collectCheques(p) {
  return [...document.querySelectorAll(`[data-chq="${p}"]`)].map(row => ({
    number: (row.querySelector('[data-chq-no]').value || '').trim(),
    bank: (row.querySelector('[data-chq-bank]').value || '').trim(),
    amount: numVal(row.querySelector('[data-chq-amt]').value) || 0,
  })).filter(c => c.number || c.amount > 0);
}
function collectTransfers(p) {
  return [...document.querySelectorAll(`[data-trf="${p}"]`)].map(row => ({
    bank: (row.querySelector('[data-trf-bank]').value || '').trim(),
    reference: (row.querySelector('[data-trf-ref]').value || '').trim(),
    amount: numVal(row.querySelector('[data-trf-amt]').value) || 0,
  })).filter(t => t.bank || t.amount > 0);
}

function sumPrefix(p) {
  return [...document.querySelectorAll(`[data-cat^="${p}."]`)].reduce((s, el) => s + (numVal(el.value) || 0), 0);
}
function readFxRows(rows) {
  return [...rows].map(row => {
    const currency = (row.querySelector('[data-fx-cur]').value || '').trim().toUpperCase();
    return { currency, amount: numVal(row.querySelector('[data-fx-amt]').value) || 0, rate: rateFor(currency) };
  }).filter(f => f.currency && f.amount > 0);
}
function collectForex(p) {
  return readFxRows(document.querySelectorAll(`[data-fx="${p}"]`));
}
function collectIous(p) {
  return [...document.querySelectorAll(`[data-iou="${p}"]`)].map(row => ({
    name: (row.querySelector('[data-iou-name]').value || '').trim(),
    contact: (row.querySelector('[data-iou-contact]').value || '').trim(),
    amount: numVal(row.querySelector('[data-iou-amt]').value) || 0,
    dueDate: row.querySelector('[data-iou-due]').value || '',
  })).filter(i => i.name && i.amount > 0);
}
function collectMethods(p) {
  const get = k => numVal((document.querySelector(`[data-mth="${p}.${k}"]`) || {}).value) || 0;
  return {
    cash: get('cash'),
    momo: get('momo'),
    cheque: r2(collectCheques(p).reduce((s, c) => s + c.amount, 0)),
    transfer: r2(collectTransfers(p).reduce((s, t) => s + t.amount, 0)),
  };
}
function methodsTotal(p) {
  const m = collectMethods(p);
  const fx = collectForex(p).reduce((s, f) => s + f.amount * f.rate, 0);
  const iou = collectIous(p).reduce((s, i) => s + i.amount, 0);
  // Baskets counted on their own are already their own figure in the grid, so
  // their breakdown totals belong on the methods side of the balance too.
  return r2(m.cash + m.cheque + m.momo + m.transfer + fx + iou + catMethodsTotal(p));
}
function anyMethods(p) {
  const m = collectMethods(p);
  return (m.cash + m.cheque + m.momo + m.transfer) > 0
    || document.querySelectorAll(`[data-fx="${p}"]`).length > 0
    || document.querySelectorAll(`[data-iou="${p}"]`).length > 0
    || bdPanels(p).length > 0;
}
function refreshRecon(p) {
  const box = document.getElementById(`recon-${p}`);
  if (!box) return;
  refreshCash(p);
  const chqT = document.querySelector(`[data-chqtotal="${p}"]`);
  if (chqT) chqT.textContent = gh(collectCheques(p).reduce((s, c) => s + c.amount, 0));
  const trfT = document.querySelector(`[data-trftotal="${p}"]`);
  if (trfT) trfT.textContent = gh(collectTransfers(p).reduce((s, t) => s + t.amount, 0));
  // live forex GHS per row
  document.querySelectorAll('[data-fx-ghs]').forEach(span => {
    const row = span.closest('.field-row');
    const cur = (row.querySelector('[data-fx-cur]').value || '').trim().toUpperCase();
    const amt = numVal(row.querySelector('[data-fx-amt]').value) || 0;
    const rate = rateFor(cur);
    span.textContent = cur && !rate ? '⚠ no rate set' : '= GHS ' + gh(amt * rate);
  });
  const inBaskets = catMethodsTotal(p);
  const roll = document.querySelector(`[data-rollup="${p}"]`);
  if (roll) {
    const here = r2(methodsTotal(p) - inBaskets);
    roll.innerHTML = `Counted inside baskets: <b class="mono">${gh(inBaskets)}</b> · entered here: <b class="mono">${gh(here)}</b> · together <b class="mono">${gh(inBaskets + here)}</b>`;
  }
  const streams = r2(sumPrefix(p));
  const mt = methodsTotal(p);
  if (!anyMethods(p)) { box.innerHTML = '<span class="sub">No method breakdown yet — fill Cash / Cheques / MoMo / Bank transfers / Forex / IOU so the day reconciles.</span>'; return; }
  const diff = r2(streams - mt);
  box.innerHTML = Math.abs(diff) <= 0.01
    ? `<b style="color:var(--ok, #178a43);">✓ Reconciles</b> — methods GHS ${gh(mt)} = streams GHS ${gh(streams)}`
    : `<b style="color:var(--danger, #c0392b);">✗ Does not reconcile</b> — methods GHS ${gh(mt)} vs streams GHS ${gh(streams)} (${diff > 0 ? 'short' : 'over'} by GHS ${gh(Math.abs(diff))})`;
}
function refreshEntryTotal() {
  applyBreakdowns('s1');
  if (isDual()) applyBreakdowns('s2');
  const t1 = sumPrefix('s1'), t2 = isDual() ? sumPrefix('s2') : 0;
  const e1 = document.getElementById('eTotal1'); if (e1) e1.textContent = gh(t1);
  const e2 = document.getElementById('eTotal2'); if (e2) e2.textContent = gh(t2);
  const et = document.getElementById('eTotal'); if (et) et.textContent = gh(t1 + t2);
  refreshRecon('s1');
  if (isDual()) refreshRecon('s2');
}
document.addEventListener('input', e => {
  if (e.target.matches('[data-cat],[data-mth],[data-den],[data-bd-cash],[data-bd-momo],[data-bd-den],[data-chq-no],[data-chq-bank],[data-chq-amt],[data-trf-bank],[data-trf-ref],[data-trf-amt],[data-fx-cur],[data-fx-amt],[data-fx-rate],[data-iou-name],[data-iou-contact],[data-iou-amt],[data-iou-due]')) refreshEntryTotal();
});
function collectCats(prefix) {
  const categories = { seed: {}, gratitude: 0, chairpersons: 0, dayborn: {}, activities: {} };
  document.querySelectorAll(`[data-cat^="${prefix}."]`).forEach(el => {
    const v = numVal(el.value) || 0;
    const key = el.dataset.cat.slice(prefix.length + 1);
    if (key.startsWith('dayborn.')) categories.dayborn[key.slice(8)] = v;
    else if (key.startsWith('seed.')) categories.seed[key.slice(5)] = v;
    else if (key.startsWith('activity.')) categories.activities[key.slice(9)] = v;
    else categories[key] = v;
  });
  return categories;
}
function serviceBody(prefix, service) {
  return {
    service,
    baseUpdatedAt: entryBase[service] || null,
    categories: collectCats(prefix),
    methods: collectMethods(prefix),
    cashCount: collectCashCount(prefix),
    cheques: collectCheques(prefix),
    transfers: collectTransfers(prefix),
    catMethods: collectCatMethods(prefix),
    rates: collectRates(),
    forex: collectForex(prefix),
    ious: collectIous(prefix),
  };
}

document.addEventListener('input', e => {
  if (e.target.matches && e.target.matches('[data-rate-cur],[data-rate-val]')) { syncCurrencyPickers(); refreshEntryTotal(); }
});
document.addEventListener('change', e => {
  if (e.target.matches && e.target.matches('select[data-fx-cur]')) refreshEntryTotal();
});
document.getElementById('rateAddBtn').onclick = () => { addRateRow(); refreshEntryTotal(); };
document.getElementById('eDayType').addEventListener('change', renderCatGrid);
// ---- Nothing typed is lost -------------------------------------------------
// A fundraising day is a long sitting: seven day-born baskets, the Chairpersons,
// the Gratitude offering, cash counted note by note, cheque rows, pledges. It
// was all held in the DOM until the one save at the end, so a reload — an
// accidental pull-to-refresh, a phone killing the tab, a stray back-swipe —
// took the lot. It happened.
//
// So the form snapshots itself as it is typed. The snapshot has the SAME shape
// as a saved entry, which means restoring it reuses `fillCats` / `fillMethods`
// — the code that already knows how to rebuild every basket panel — instead of
// a second, parallel restore that would drift from it.
//
// Deliberately local, not on the server: a draft that does not reconcile is not
// a record, and the server is right to refuse those. This is the Clerk's own
// working copy of his own typing, and it survives exactly the thing that
// destroyed it.
const DRAFT_PREFIX = 'aotc.fr.draft.';
const draftKey = () => {
  const ev = (document.getElementById('eEvent') || {}).value;
  const dt = (document.getElementById('eDate') || {}).value;
  return (ev && dt) ? `${DRAFT_PREFIX}${ev}.${dt}` : '';
};
let draftTimer = null;
let draftDirty = false;
// The key the working copy is actually stored under. `draftKey()` reads the
// form, and the Clerk can change the date after he has started typing — which
// would orphan the draft under the old key and clear the wrong one.
let draftActiveKey = '';
function draftSnapshot() {
  const dual = isDual();
  return {
    at: new Date().toISOString(),
    dayType: dual ? 'dual' : 'joint',
    s1: serviceBody('s1', dual ? '1st' : 'joint'),
    s2: dual ? serviceBody('s2', '2nd') : null,
  };
}
function draftWrite() {
  const key = draftKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(draftSnapshot()));
    draftActiveKey = key;
    draftDirty = true;
  } catch (e) { /* a full or blocked store must never break the entry form */ }
}
// One timer for this one concern, and a flush on the way out — the lesson the
// minutes editor paid for when two concerns shared a timer and each cancelled
// the other's save. Do not fold this in with anything else.
function draftQueue() { clearTimeout(draftTimer); draftTimer = setTimeout(draftWrite, 700); }
function draftClear() {
  clearTimeout(draftTimer);
  draftTimer = null;
  draftDirty = false;
  // Both: the key the form points at now, and the one the copy was written
  // under. They differ if the date was edited mid-entry.
  [draftKey(), draftActiveKey].filter(Boolean).forEach(k => {
    try { localStorage.removeItem(k); } catch (e) {}
  });
  draftActiveKey = '';
}
function draftRead(eventId, date) {
  try {
    const raw = localStorage.getItem(`${DRAFT_PREFIX}${eventId}.${date}`);
    return raw ? JSON.parse(raw) : null;
  } catch (e) { return null; }
}
// A draft is restored through the same path a saved entry takes, so a basket
// counted note by note comes back counted note by note.
function draftApply(d) {
  if (!d) return;
  draftActiveKey = draftKey();
  document.getElementById('eDayType').value = d.dayType === 'dual' ? 'dual' : 'joint';
  renderCatGrid();
  resetRates((d.s1 && d.s1.rates) || []);
  const asEntry = b => b && ({
    id: null,
    categories: b.categories || {},
    // `methodsDirect` is the service-level part; fillMethods reads the panel
    // from it and the baskets from catMethods, which is how a saved entry works.
    methodsDirect: { ...(b.methods || {}), cashCount: b.cashCount || {}, cheques: b.cheques || [], transfers: b.transfers || [] },
    catMethods: b.catMethods || {},
    forex: b.forex || [],
  });
  const put = (p, b) => {
    if (!b) return;
    fillCats(p, b.categories || {});
    fillMethods(p, asEntry(b));
    // Service-level pledges live on the register for a SAVED entry, so
    // fillMethods reads them from `data.ious`. A draft has no entry id yet, so
    // its own rows are put back here.
    (b.ious || []).forEach(i => addIouRow(p, i));
  };
  put('s1', d.s1);
  if (d.dayType === 'dual') put('s2', d.s2);
  refreshEntryTotal();
}
function draftNote(d) {
  const box = document.getElementById('eDraftNote');
  if (!box) return;
  if (!d) { box.style.display = 'none'; box.innerHTML = ''; return; }
  const when = new Date(d.at);
  const stamp = isNaN(when) ? '' : when.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  box.style.display = '';
  box.innerHTML = `<b>Unsaved entries restored</b> — typed ${esc(stamp)} and never saved.
    Check them against the counting, then save. <button type="button" class="btn btn-secondary btn-sm"
    style="margin-left:8px;" onclick="draftDiscard()">Discard them</button>`;
}
function draftDiscard() {
  const ev = document.getElementById('eEvent').value;
  const dt = document.getElementById('eDate').value;
  draftClear();
  draftNote(null);
  // Back to whatever is actually saved for the day.
  if (data.entries.some(e => e.eventId === Number(ev) && e.date === dt)) editDay(ev, dt);
  else { document.getElementById('entryForm').reset(); renderCatGrid(); resetRates([]); refreshEntryTotal(); }
  toast('Draft discarded');
}

// A click outside the open basket folds it up. Clicks INSIDE it, on its own
// ⊞ button, or on anything that opens a dialog of its own are left alone.
document.addEventListener('click', e => {
  const ov = document.getElementById('eOverlay');
  if (!ov || ov.style.display === 'none') return;
  const t = e.target;
  if (!t || !t.closest) return;
  if (t.closest('[data-bdpanel]')) return;          // inside the open panel
  if (t.closest('[data-bdbtn]')) return;            // its own toggle handles it
  if (!t.closest('#entryForm') && !t.closest('.modal')) return;
  foldOthers(null);
});

// Every keystroke the form already listens for also queues a snapshot.
document.addEventListener('input', e => {
  if (!document.getElementById('eOverlay') || document.getElementById('eOverlay').style.display === 'none') return;
  if (e.target.closest && e.target.closest('#entryForm')) draftQueue();
});
document.addEventListener('change', e => {
  if (!document.getElementById('eOverlay') || document.getElementById('eOverlay').style.display === 'none') return;
  if (e.target.closest && e.target.closest('#entryForm')) draftQueue();
});
// The gesture is disabled in CSS, but a real navigation still has to be caught,
// and the pending snapshot flushed before the page goes.
window.addEventListener('beforeunload', e => {
  const open = document.getElementById('eOverlay');
  if (!open || open.style.display === 'none') return;
  if (draftTimer) draftWrite();
  if (!draftDirty) return;
  e.preventDefault();
  e.returnValue = '';
});

document.getElementById('entryForm').addEventListener('submit', async e => {
  e.preventDefault();
  const eventId = document.getElementById('eEvent').value;
  const date = document.getElementById('eDate').value;
  const badIou = ['s1', ...(isDual() ? ['s2'] : [])].flatMap(p => collectIous(p)).find(i => !i.dueDate);
  if (badIou) return toast(`IOU for ${badIou.name}: set the proposed payment date (it drives the reminders).`, true);
  try {
    if (isDual()) {
      await api('/fundraising/entries', { method: 'PUT', body: { eventId, date, ...serviceBody('s1', '1st') } });
      await api('/fundraising/entries', { method: 'PUT', body: { eventId, date, ...serviceBody('s2', '2nd') } });
      toast('1st & 2nd service inflows saved');
    } else {
      await api('/fundraising/entries', { method: 'PUT', body: { eventId, date, ...serviceBody('s1', 'joint') } });
      toast('Fundraising day saved');
    }
    // Only now: the figures are on the server, so the working copy can go.
    draftClear();
    draftNote(null);
    document.getElementById('eOverlay').style.display = 'none';
    load();
  } catch (err) { toast(err.message, true); }
});

document.getElementById('expForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    await api('/fundraising/expenses', { method: 'POST', body: {
      eventId: document.getElementById('xEvent').value,
      description: document.getElementById('xDesc').value,
      amount: numVal(document.getElementById('xAmount').value) || 0,
      // Back-dating: blank = today (the backend default).
      date: document.getElementById('xDate').value || undefined,
    } });
    toast('Expense recorded');
    document.getElementById('xDesc').value = ''; document.getElementById('xAmount').value = '';
    load();
  } catch (err) { toast(err.message, true); }
});

document.getElementById('saveTargetsBtn').onclick = async () => {
  try {
    await api('/fundraising/targets', { method: 'PUT', body: {
      year: data.year,
      annualTarget: numVal(document.getElementById('tAnnual').value),
      eventTargets: [...document.querySelectorAll('[data-target]')].map(el => ({ id: Number(el.dataset.target), target: numVal(el.value) })),
    } });
    toast('Targets saved');
    load();
  } catch (e) { toast(e.message, true); }
};

function fillCats(prefix, categories) {
  document.querySelectorAll(`[data-cat^="${prefix}."]`).forEach(el => {
    const key = el.dataset.cat.slice(prefix.length + 1);
    let v;
    if (key.startsWith('dayborn.')) v = (categories.dayborn || {})[key.slice(8)];
    else if (key.startsWith('seed.')) v = (categories.seed || {})[key.slice(5)];
    else if (key.startsWith('activity.')) v = (categories.activities || {})[key.slice(9)];
    else v = categories[key];
    el.value = v ? Number(v).toLocaleString() : '';
  });
}
function fillMethods(prefix, entry) {
  // `methods` is the combined picture (service level + every basket breakdown).
  // The service-level panel must show only the service-level part.
  const direct = entry.methodsDirect || entry.methods || {};
  ['cash', 'momo'].forEach(k => {
    const el = document.querySelector(`[data-mth="${prefix}.${k}"]`);
    if (el) el.value = direct[k] ? Number(direct[k]).toLocaleString() : '';
  });
  const counts = (entry.methodsDirect ? entry.methodsDirect.cashCount : entry.cashCount) || {};
  Object.entries(counts).forEach(([k, q]) => {
    const el = document.querySelector(`[data-den="${prefix}.${k}"]`);
    if (el) el.value = q;
  });
  if (Object.keys(counts).length) {
    const card = document.querySelector(`[data-dencard="${prefix}"]`);
    if (card) card.open = true;
  }
  // Entries saved before cheques became itemised carry only a total — bring it
  // across as one row so the cheque number and bank can be filled in.
  const cheques = (entry.methodsDirect ? entry.methodsDirect.cheques : entry.cheques) || [];
  if (cheques.length) cheques.forEach(c => addChqRow(prefix, c));
  else if (!entry.methodsDirect && direct.cheque) addChqRow(prefix, { number: '', bank: '', amount: direct.cheque });
  ((entry.methodsDirect ? entry.methodsDirect.transfers : entry.transfers) || []).forEach(t => addTrfRow(prefix, t));

  // A pledge already marked paid stays on the register and is counted there —
  // it must not come back as an editable row, or it would be counted twice.
  const paidHere = (data.ious || []).filter(i => i.entryId === entry.id && i.status === 'paid');
  const isPaid = i => paidHere.some(x => x.name === i.name && Number(x.amount) === Number(i.amount) && (x.dueDate || '') === (i.dueDate || ''));

  // Rebuild each basket's own breakdown.
  Object.entries(entry.catMethods || {}).forEach(([key, bd]) => {
    // Folded: the grid already shows this basket's figure, locked.
    const panel = buildBreakdown(prefix, key, true);
    if (!panel) return;
    Object.entries(bd.cashCount || {}).forEach(([k, q]) => {
      const el = panel.querySelector(`[data-bd-den="${k}"]`);
      if (el) el.value = q;
    });
    if (Object.keys(bd.cashCount || {}).length) {
      const card = panel.querySelector('[data-bd-dencard]');
      if (card) card.open = true;
    } else if (bd.cash) {
      panel.querySelector('[data-bd-cash]').value = Number(bd.cash).toLocaleString();
    }
    if (bd.momo) panel.querySelector('[data-bd-momo]').value = Number(bd.momo).toLocaleString();
    (bd.cheques || []).forEach(c => bdAddRow(panel, 'chq', c));
    (bd.transfers || []).forEach(t => bdAddRow(panel, 'trf', t));
    (bd.forex || []).forEach(f => bdAddRow(panel, 'fx', f));
    (bd.ious || []).filter(i => !isPaid(i)).forEach(i => bdAddRow(panel, 'iou', i));
  });
  // Service-level foreign notes: rows with no basket against them.
  (entry.forex || []).filter(f => !f.category).forEach(f => addFxRow(prefix, f));
  // Only UNPAID service-level IOUs are editable here; basket pledges were
  // restored above, and paid ones stay on the register.
  (data.ious || []).filter(i => i.entryId === entry.id && i.status !== 'paid' && !i.category).forEach(i => addIouRow(prefix, i));
}
function editDay(eventId, date) {
  const list = data.entries.filter(e => e.eventId === Number(eventId) && e.date === date);
  const dual = list.some(e => e.service !== 'joint');
  entryBase = Object.fromEntries(list.map(e => [e.service, e.updatedAt || e.createdAt || null]));
  document.getElementById('entryForm').reset();
  document.getElementById('eEvent').value = String(eventId);
  document.getElementById('eDate').value = date;
  document.getElementById('eDayType').value = dual ? 'dual' : 'joint';
  renderCatGrid();
  // Rates first — every currency picker below is built from them. Entries saved
  // before rates moved to the top carry the rate on each forex row.
  const saved = (list.find(e => (e.rates || []).length) || {}).rates;
  const derived = [];
  list.flatMap(e => e.forex || []).forEach(f => {
    if (f.currency && f.rate > 0 && !derived.some(x => x.currency === f.currency)) derived.push({ currency: f.currency, rate: f.rate });
  });
  resetRates(saved && saved.length ? saved : derived);
  if (dual) {
    const s1 = list.find(e => e.service === '1st'); if (s1) { fillCats('s1', s1.categories); fillMethods('s1', s1); }
    const s2 = list.find(e => e.service === '2nd'); if (s2) { fillCats('s2', s2.categories); fillMethods('s2', s2); }
  } else if (list[0]) { fillCats('s1', list[0].categories); fillMethods('s1', list[0]); }
  refreshEntryTotal();
  // A draft for this day means the last sitting never got saved. Put the typing
  // back and say so, rather than quietly showing the older saved figures.
  const d = draftRead(eventId, date);
  if (d) { draftApply(d); draftNote(d); } else { draftNote(null); }
  document.getElementById('eOverlay').style.display = 'flex';
}

// ---- Day results modal: ranked day-borns, methods, forex two-forms, IOUs ----
function viewDay(eventId, date) {
  const list = data.entries.filter(e => e.eventId === Number(eventId) && e.date === date)
    .sort((a, b) => a.service.localeCompare(b.service));
  if (!list.length) return;
  document.getElementById('vTitle').textContent = `${list[0].eventName} — ${fmtDate(date)}`;
  const cols = list.map(e => e.service === 'joint' ? 'Joint' : e.service);
  // day-borns RANKED highest-first by combined total
  // Ordered by the COMBINED total, because one table can only be in one order.
  // On a dual-service day the two services rank differently, so neither column
  // reads in its own order here — each service's own ranking is listed under
  // the table instead, exactly as the announcement PDF does it.
  const bornOf = (e, d) => Number(((e.categories || {}).dayborn || {})[d]) || 0;
  const ranked = DAYBORN.slice().sort((d1, d2) =>
    list.reduce((s, e) => s + bornOf(e, d2), 0) -
    list.reduce((s, e) => s + bornOf(e, d1), 0));
  // Zeros left out: a basket that received nothing was not "last", it simply
  // did not feature.
  const rankedFor = e => DAYBORN.slice()
    .map(d => [d, bornOf(e, d)])
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1]);
  const cell = v => `<td class="mono" style="text-align:right;">${gh(v)}</td>`;
  // Seed sub-categories: this year's list plus any legacy name still carrying a figure.
  const seedKeys = [...new Set([...seedCats(), ...list.flatMap(e => Object.keys((e.categories || {}).seed || {}))])]
    .filter(k => seedCats().includes(k) || list.some(e => (((e.categories || {}).seed || {})[k] || 0) > 0));
  const seedBlock = seedKeys.length ? [
    `<tr><td colspan="${cols.length + 1}" style="background:var(--surface-2,#EEF1F7);"><b>Seed Contributions</b></td></tr>`,
    ...seedKeys.map(k => `<tr><td style="padding-left:18px;">${esc(k)}</td>${list.map(e => cell(((e.categories || {}).seed || {})[k] || 0)).join('')}</tr>`),
    `<tr><td style="padding-left:18px;"><b>Seed subtotal</b></td>${list.map(e => `<td class="mono" style="text-align:right;"><b>${gh(seedSum(e))}</b></td>`).join('')}</tr>`,
  ] : [];
  const actKeys = [...new Set([...activityCats(), ...list.flatMap(e => Object.keys((e.categories || {}).activities || {}))])]
    .filter(k => activityCats().includes(k) || list.some(e => (((e.categories || {}).activities || {})[k] || 0) > 0));
  const areaHead = t => `<tr><td colspan="${cols.length + 1}" style="background:var(--surface-2,#EEF1F7);"><b>${t}</b></td></tr>`;
  // Sheets added on the day (22 Nov 2026), by name.
  const spKeys = [...new Set(list.flatMap(e => Object.keys((e.categories || {}).special || {})))]
    .filter(k => list.some(e => (((e.categories || {}).special || {})[k] || 0) > 0));
  const streamRows = [
    ...seedBlock,
    areaHead('Gratitude &amp; Thanksgiving Offering'),
    `<tr><td style="padding-left:18px;">Gratitude &amp; Thanksgiving</td>${list.map(e => cell(e.categories.gratitude)).join('')}</tr>`,
    areaHead(list.length > 1
      ? 'Day-born Offerings &mdash; ordered by the two services together'
      : 'Day-born Offerings &mdash; ranked highest first'),
    ...ranked.map((d, idx) => `<tr><td style="padding-left:18px;">${idx + 1}. ${d}-borns</td>${list.map(e => cell((e.categories.dayborn || {})[d] || 0)).join('')}</tr>`),
    areaHead('Chairpersons &amp; Co-chairpersons'),
    `<tr><td style="padding-left:18px;">Chairpersons &amp; Co-chairpersons</td>${list.map(e => cell(e.categories.chairpersons)).join('')}</tr>`,
    ...actKeys.length ? [
      areaHead('Harvest Week Activities'),
      ...actKeys.map(k => `<tr><td style="padding-left:18px;">${esc(k)}</td>${list.map(e => cell(((e.categories || {}).activities || {})[k] || 0)).join('')}</tr>`),
      `<tr><td style="padding-left:18px;"><b>Activities subtotal</b></td>${list.map(e => `<td class="mono" style="text-align:right;"><b>${gh(activitySum(e))}</b></td>`).join('')}</tr>`,
    ] : [],
    ...spKeys.length ? [
      areaHead('Special sheets'),
      ...spKeys.map(k => `<tr><td style="padding-left:18px;">${esc(k)}</td>${list.map(e => cell(((e.categories || {}).special || {})[k] || 0)).join('')}</tr>`),
    ] : [],
    `<tr><td><b>Service total</b></td>${list.map(e => `<td class="mono" style="text-align:right;"><b>${gh(e.total)}</b></td>`).join('')}</tr>`,
  ].join('');

  // Each service's day-borns in ITS OWN order — what is read out on the night.
  const rankBlocks = list.map(e => [e, rankedFor(e)]).filter(([, r]) => r.length);
  const rankHtml = rankBlocks.length ? `<h3 style="margin-top:14px;">Day-born offerings, ranked</h3>
    ${rankBlocks.map(([e, r]) => `<div style="margin-bottom:6px;">
      <b>${esc(e.service === 'joint' ? 'Joint service' : e.service + ' service')}</b>
      <div class="sub" style="font-size:12.5px;">${r.map(([d, v], i) =>
        `${i + 1}. ${esc(d)}-borns ${gh(v)}`).join(' &nbsp;·&nbsp; ')}</div>
    </div>`).join('')}` : '';

  const hasMethods = list.some(e => e.methods && ((e.methods.cash || 0) + (e.methods.cheque || 0) + (e.methods.momo || 0) + (e.methods.transfer || 0) + (e.iouTotal || 0) + (e.forexGhs || 0)) > 0);
  let methodsHtml = '';
  if (hasMethods) {
    const mRow = (label, get) => `<tr><td>${label}</td>${list.map(e => cell(get(e))).join('')}</tr>`;
    methodsHtml = `<h3 style="margin-top:16px;">How it came in</h3>
    <table>
      <thead><tr><th>Method</th>${cols.map(c => `<th style="text-align:right;">${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>
        ${mRow('Cash', e => (e.methods || {}).cash || 0)}
        ${mRow('Cheques', e => (e.methods || {}).cheque || 0)}
        ${mRow('Mobile Money', e => (e.methods || {}).momo || 0)}
        ${mRow('Bank Transfers', e => (e.methods || {}).transfer || 0)}
        ${mRow('IOUs (pledged)', e => e.iouTotal || 0)}
        <tr><td><b>GHS subtotal</b></td>${list.map(e => `<td class="mono" style="text-align:right;"><b>${gh(e.ghsSubtotal || 0)}</b></td>`).join('')}</tr>
      </tbody>
    </table>`;

    // Cash counting sheet — quantities combined across the day's services.
    const counts = {};
    list.forEach(e => Object.entries(e.cashCount || {}).forEach(([k, q]) => { counts[k] = (counts[k] || 0) + Number(q || 0); }));
    if (Object.keys(counts).length) {
      const dRows = denoms().filter(d => counts[d.key]).map(d =>
        `<tr><td>${esc(d.label)}</td><td class="mono" style="text-align:right;">${counts[d.key]}</td><td class="mono" style="text-align:right;">${gh(counts[d.key] * d.value)}</td></tr>`).join('');
      const dTot = denoms().reduce((acc, d) => acc + (counts[d.key] || 0) * d.value, 0);
      methodsHtml += `<h3 style="margin-top:16px;">Cash counted — denomination breakdown</h3>
      <table><thead><tr><th>Denomination</th><th style="text-align:right;">Qty</th><th style="text-align:right;">GHS</th></tr></thead>
      <tbody>${dRows}<tr><td><b>Total cash counted</b></td><td></td><td class="mono" style="text-align:right;"><b>${gh(dTot)}</b></td></tr></tbody></table>`;
    }

    // Baskets counted on their own — what each one was made up of.
    const bdKeys = [...new Set(list.flatMap(e => Object.keys(e.catMethods || {})))];
    if (bdKeys.length) {
      const bdGet = (k, f) => list.reduce((a, e) => a + Number((((e.catMethods || {})[k]) || {})[f] || 0), 0);
      const bdCols = ['cash', 'chequeTotal', 'transferTotal', 'momo', 'forexGhs', 'iouTotal'];
      const bdRow = k => `<tr><td>${esc(catLabelOf(k))}</td>
        ${bdCols.map(f => `<td class="mono" style="text-align:right;">${gh(bdGet(k, f))}</td>`).join('')}
        <td class="mono" style="text-align:right;"><b>${gh(bdGet(k, 'total'))}</b></td></tr>`;
      methodsHtml += `<h3 style="margin-top:16px;">Breakdown by basket</h3>
      <table><thead><tr><th>Basket</th><th style="text-align:right;">Cash</th><th style="text-align:right;">Cheques</th><th style="text-align:right;">Transfers</th><th style="text-align:right;">MoMo</th><th style="text-align:right;">Foreign</th><th style="text-align:right;">Pledges</th><th style="text-align:right;">Total</th></tr></thead>
      <tbody>${bdKeys.map(bdRow).join('')}
      <tr><td><b>Counted baskets total</b></td><td colspan="6"></td><td class="mono" style="text-align:right;"><b>${gh(bdKeys.reduce((a, k) => a + bdGet(k, 'total'), 0))}</b></td></tr>
      </tbody></table>`;
    }

    const allChq = list.flatMap(e => (e.cheques || []).map(c => ({ ...c, service: e.service })));
    if (allChq.length) {
      methodsHtml += `<h3 style="margin-top:16px;">Cheques</h3>
      <table><thead><tr><th>Cheque no.</th><th>Bank</th><th>Basket</th><th>Service</th><th style="text-align:right;">Amount</th></tr></thead><tbody>
      ${allChq.map(c => `<tr><td class="mono">${esc(c.number || '—')}</td><td>${esc(c.bank || '—')}</td><td class="sub">${esc(c.category || 'service level')}</td><td class="sub">${esc(c.service)}</td><td class="mono" style="text-align:right;">${gh(c.amount)}</td></tr>`).join('')}
      <tr><td colspan="4"><b>Total</b></td><td class="mono" style="text-align:right;"><b>${gh(allChq.reduce((a, c) => a + (c.amount || 0), 0))}</b></td></tr>
      </tbody></table>`;
    }

    const allTrf = list.flatMap(e => (e.transfers || []).map(t => ({ ...t, service: e.service })));
    if (allTrf.length) {
      methodsHtml += `<h3 style="margin-top:16px;">Bank transfers</h3>
      <table><thead><tr><th>Bank</th><th>Reference</th><th>Basket</th><th>Service</th><th style="text-align:right;">Amount</th></tr></thead><tbody>
      ${allTrf.map(t => `<tr><td>${esc(t.bank || '—')}</td><td class="mono">${esc(t.reference || '—')}</td><td class="sub">${esc(t.category || 'service level')}</td><td class="sub">${esc(t.service)}</td><td class="mono" style="text-align:right;">${gh(t.amount)}</td></tr>`).join('')}
      <tr><td colspan="4"><b>Total</b></td><td class="mono" style="text-align:right;"><b>${gh(allTrf.reduce((a, t) => a + (t.amount || 0), 0))}</b></td></tr>
      </tbody></table>`;
    }

    const allFx = list.flatMap(e => e.forex || []);
    if (allFx.length) {
      const byCur = {};
      allFx.forEach(f => { byCur[f.currency] = byCur[f.currency] || { amount: 0, ghs: 0, rate: f.rate }; byCur[f.currency].amount += f.amount; byCur[f.currency].ghs += f.ghs; });
      const ghsSub = list.reduce((s, e) => s + (e.ghsSubtotal || 0), 0);
      const fxGhs = list.reduce((s, e) => s + (e.forexGhs || 0), 0);
      methodsHtml += `<h3 style="margin-top:16px;">Foreign currency</h3>
      <div class="sub">Form 1 — GHS subtotal with foreign amounts listed separately:</div>
      <div style="margin:6px 0 10px;"><b class="mono">GHS ${gh(ghsSub)}</b> + ${Object.entries(byCur).map(([c, v]) =>
        `<span class="mono">${esc(c)} ${gh(v.amount)}</span> <span class="sub">(@ ${v.rate} = GHS ${gh(v.ghs)})</span>`).join(' + ')}</div>
      <div class="sub">Form 2 — everything converted to GHS at the day's rates:</div>
      <div style="margin-top:6px;"><b class="mono">GHS ${gh(ghsSub + fxGhs)}</b></div>`;
    }
  }

  const dayIous = (data.ious || []).filter(i => i.eventId === Number(eventId) && i.date === date);
  const iouHtml = dayIous.length ? `<h3 style="margin-top:16px;">Pledges (IOUs) on this day</h3>
    <table><thead><tr><th>Name</th><th>Basket</th><th>Amount</th><th>Proposed payment</th><th>Status</th></tr></thead><tbody>
    ${dayIous.map(i => `<tr><td>${esc(i.name)}</td><td class="sub">${esc(i.category || 'service level')}</td><td class="mono">${gh(i.amount)}</td><td>${i.dueDate ? fmtDate(i.dueDate) : '—'}</td>
      <td>${i.status === 'paid' ? '<span class="badge badge-done">paid ✓</span>' : '<span class="badge badge-progress">outstanding</span>'}</td></tr>`).join('')}
    </tbody></table>` : '';

  const grand = list.reduce((s, e) => s + (e.total || 0), 0);
  const declined = list.find(e => e.declined);
  document.getElementById('vBody').innerHTML = `
    <div style="margin-bottom:8px;">${statusBadge(list)}${declined && dayStatus(list) !== 'confirmed' && dayStatus(list) !== 'verified' ? `<div class="sub" style="margin-top:4px;">Declined at ${esc(declined.declined.stage)}: “${esc(declined.declined.reason)}”</div>` : ''}</div>
    <h3>Where it came from</h3>
    <table>
      <thead><tr><th>Category</th>${cols.map(c => `<th style="text-align:right;">${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${streamRows}</tbody>
    </table>
    ${rankHtml}
    ${methodsHtml}
    ${iouHtml}
    <div style="margin-top:16px; text-align:center;"><b>GRAND TOTAL (all in GHS): ${gh(grand)}</b></div>`;
  document.getElementById('vOverlay').style.display = 'flex';
}

async function submitDay(eventId, date) {
  if (!await confirmDialog('Submit this day for sign-off? The Accounts Clerk will be notified to verify.')) return;
  try { await api('/fundraising/submit-day', { method: 'POST', body: { eventId, date } }); toast('Submitted — Accounts Clerk notified'); load(); }
  catch (e) { toast(e.message, true); }
}
async function verifyDay(eventId, date) {
  if (!await confirmDialog('Verify these figures (level 1 — Accounts Clerk)? Editing closes after verification and the Treasurer is notified.')) return;
  try { await api('/fundraising/verify-day', { method: 'POST', body: { eventId, date } }); toast('Verified — Treasurer notified'); load(); }
  catch (e) { toast(e.message, true); }
}
async function approveDay(eventId, date) {
  if (!await confirmDialog('Approve these figures (level 2 — Treasurer)? The day LOCKS after approval and the person who entered them is notified.')) return;
  try { await api('/fundraising/approve-day', { method: 'POST', body: { eventId, date } }); toast('Approved & locked'); load(); }
  catch (e) { toast(e.message, true); }
}
async function declineDay(eventId, date) {
  const reason = prompt('Reason for declining (the Harvest Committee will see this):');
  if (reason === null) return;
  if (!reason.trim()) return toast('A reason is required.', true);
  try { await api('/fundraising/decline-day', { method: 'POST', body: { eventId, date, reason: reason.trim() } }); toast('Declined — Harvest Committee notified'); load(); }
  catch (e) { toast(e.message, true); }
}
async function unconfirmDay(eventId, date) {
  if (!await confirmDialog('Unlock this signed-off day? The unlock is logged.')) return;
  try { await api('/fundraising/unconfirm-day', { method: 'POST', body: { eventId, date } }); toast('Unlocked'); load(); }
  catch (e) { toast(e.message, true); }
}
async function delEntry(id) {
  if (!await confirmDialog('Delete this inflow entry (its unpaid IOUs go too)?')) return;
  try { await api(`/fundraising/entries/${id}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, true); }
}
async function markIouPaid(id) {
  if (!await confirmDialog('Mark this IOU as PAID? Reminders stop immediately.')) return;
  try { await api(`/fundraising/ious/${id}/paid`, { method: 'POST' }); toast('IOU marked paid'); load(); } catch (e) { toast(e.message, true); }
}
async function delExp(id) {
  if (!await confirmDialog('Delete this expense?')) return;
  try { await api(`/fundraising/expenses/${id}`, { method: 'DELETE' }); load(); } catch (e) { toast(e.message, true); }
}

// Correct an expense (description / amount / date).
async function editExp(id, desc, amount, date) {
  const description = prompt('Description:', desc || ''); if (description === null) return;
  const amt = prompt('Amount (GHS):', amount == null ? '' : String(amount)); if (amt === null) return;
  const d = prompt('Date (YYYY-MM-DD):', date || ''); if (d === null) return;
  try {
    await api(`/fundraising/expenses/${id}`, { method: 'PUT', body: {
      description: description.trim(),
      amount: Number(String(amt).replace(/,/g, '')) || 0,
      date: d.trim() || undefined,
    } });
    toast('Expense updated'); load();
  } catch (e) { toast(e.message, true); }
}

// Rename a fundraising event / adjust its target.
async function editEvent(id, name, target) {
  const nm = prompt('Event name:', name || ''); if (nm === null) return;
  const tg = prompt('Target (GHS, blank for none):', target == null ? '' : String(target)); if (tg === null) return;
  try {
    await api(`/fundraising/events/${id}`, { method: 'PUT', body: {
      name: nm.trim(),
      target: tg.trim() === '' ? null : Number(String(tg).replace(/,/g, '')) || null,
    } });
    toast('Event updated'); load();
  } catch (e) { toast(e.message, true); }
}

async function delEvent(id) {
  if (!await confirmDialog('Remove this fundraising event? Only possible while it has no figures recorded.')) return;
  try { await api(`/fundraising/events/${id}`, { method: 'DELETE' }); toast('Event removed'); load(); }
  catch (e) { toast(e.message, true); }
}

// ---- Seed contribution sub-categories (who gives the lead gift) ----
let seedDraft = [];
function cleanSeedName(v) {
  return String(v == null ? '' : v).replace(/["'.<>\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
}
function renderSeedCard() {
  const box = document.getElementById('seedRows');
  if (!box) return;
  box.innerHTML = seedDraft.map((sname, i) => `<span class="badge badge-progress" style="display:inline-block; margin:2px 6px 2px 0;">${esc(sname)}
    <a href="#" title="remove" style="margin-left:4px; text-decoration:none;" onclick="removeSeed(${i});return false;">✕</a></span>`).join('')
    || '<span class="sub">None — add at least one.</span>';
}
function removeSeed(i) { seedDraft.splice(i, 1); renderSeedCard(); }
function addSeed() {
  const el = document.getElementById('seedNew');
  const v = cleanSeedName(el.value);
  if (!v) return toast('Type a name first.', true);
  if (seedDraft.some(x => x.toLowerCase() === v.toLowerCase())) return toast('That one is already on the list.', true);
  seedDraft.push(v); el.value = ''; renderSeedCard();
}
async function saveSeedCats() {
  try {
    await api('/fundraising/seed-categories', { method: 'PUT', body: { year: data.year, categories: seedDraft } });
    toast('Seed sub-categories saved');
    load();
  } catch (e) { toast(e.message, true); }
}

// ---- Harvest week activities ----------------------------------------------
// Same card as seed, with one difference: an empty list is allowed and normal.
let activityDraft = [];
function renderActivityCard() {
  const box = document.getElementById('activityRows');
  if (!box) return;
  box.innerHTML = activityDraft.map((a, i) => `<span class="badge badge-progress" style="display:inline-block; margin:2px 6px 2px 0;">${esc(a)}
    <a href="#" title="remove" style="margin-left:4px; text-decoration:none;" onclick="removeActivity(${i});return false;">✕</a></span>`).join('')
    || '<span class="sub">None set — the entry grid will show no activity rows.</span>';
}
function removeActivity(i) { activityDraft.splice(i, 1); renderActivityCard(); }
function addActivity() {
  const el = document.getElementById('activityNew');
  const v = cleanSeedName(el.value);
  if (!v) return toast('Type a name first.', true);
  if (activityDraft.some(x => x.toLowerCase() === v.toLowerCase())) return toast('That one is already on the list.', true);
  activityDraft.push(v); el.value = ''; renderActivityCard();
}
async function saveActivityCats() {
  try {
    await api('/fundraising/activity-categories', { method: 'PUT', body: { year: data.year, categories: activityDraft } });
    toast('Harvest week activities saved');
    load();
  } catch (e) { toast(e.message, true); }
}

document.getElementById('eCancelBtn').onclick = () => document.getElementById('eOverlay').style.display = 'none';
document.getElementById('vCloseBtn').onclick = () => document.getElementById('vOverlay').style.display = 'none';
// The totals form (no sheets): opened from the day window ("Type totals without
// sheets") or a day's "Edit totals". A day that already has figures opens them.
// "+ Record fundraising day" (#entryBtn) opens the day window — page-fundraising-sheets.js.
window.openTotalsForm = (eventId, date, dayType) => {
  if (eventId && date && data.entries.some(e => e.eventId === Number(eventId) && e.date === date)) return editDay(Number(eventId), date);
  entryBase = {};
  document.getElementById('entryForm').reset();
  renderCatGrid();
  resetRates([]);
  if (eventId) document.getElementById('eEvent').value = String(eventId);
  document.getElementById('eDate').value = date || todayInputValue();
  if (dayType) document.getElementById('eDayType').value = dayType;
  document.getElementById('eDayType').dispatchEvent(new Event('change'));
  document.getElementById('eOverlay').style.display = 'flex';
};

document.getElementById('seedAddBtn').onclick = addSeed;
document.getElementById('seedNew').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addSeed(); } });
document.getElementById('saveSeedBtn').onclick = saveSeedCats;
document.getElementById('activityAddBtn').onclick = addActivity;
document.getElementById('activityNew').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addActivity(); } });
document.getElementById('saveActivityBtn').onclick = saveActivityCats;
document.getElementById('statementBtn').onclick = () => window.open('/api/fundraising/statement.pdf', '_blank');
requireAuthAndRenderShell().then(u => { me = u; load(); });
