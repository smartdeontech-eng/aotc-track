// Weekly Finance — the Sunday amt entry.
//
// The shape of the week, and who does what:
//   Accounts Clerk  enters the figures and submits    (finance.weekly)
//   Treasurer       confirms, which makes them count  (finance.weekly.confirm)
//   Session Clerk   is told, and copies the announcement
//
// The announcement text is the point of the page as much as the figures are.
// It already gets read out every Sunday; until now somebody retyped it from
// the cash book. Here it is built from the same numbers that feed the quarter,
// so the congregation and the District cannot be told different things.
let me = null;
let lines = [];
let week = null;
let runningTotals = null;   // quarter-to-date and year-to-date per line
let totalsQuarter = null;   // which quarter the totals cards are showing
let currentDate = '';
let canEnter = false, canConfirm = false, canEditLines = false, canEnterQuarterly = false;

// NOT called money(): app.js already declares a global function money() and
// both files are classic scripts sharing one global scope, so a second
// declaration is a SyntaxError that stops this ENTIRE file from running -
// silently, with no handler and no error card, just a dead page.
// scripts/test-global-clashes.js guards against it happening again.
const amt = n => Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = v => {
  if (v === '' || v === null || v === undefined) return 0;
  const n = Number(String(v).replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
// Snap any date to the Sunday of its week. The return is kept per Sunday, and
// silently correcting beats an error message for someone who tapped Monday.
function sundayOf(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  if (isNaN(d)) return ymd(new Date());
  d.setDate(d.getDate() - d.getDay());
  return ymd(d);
}
const shortDay = s => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const longDay = s => new Date(s + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

const STATUS = {
  draft: { label: 'Draft', cls: 'badge-idle' },
  entered: { label: 'Awaiting Treasurer', cls: 'badge-progress' },
  confirmed: { label: 'Confirmed', cls: 'badge-done' },
};

async function load() {
  // Everything below the header comes from this one call, so if it fails the
  // page must SAY so. The first version had no catch: a failed fetch left the
  // heading on its placeholder text and the body empty, which reads as "the
  // feature is broken" rather than "the request did not come back".
  let res;
  try {
    res = await api(`/finance-weekly/week/${currentDate}`);
  } catch (e) {
    document.getElementById('weekBody').innerHTML = `<div class="card" style="border-left:4px solid var(--danger, #b3261e);">
      <div class="section-title"><h3>The weekly finance book could not be loaded</h3></div>
      <p style="margin:0 0 8px;">${esc(e.message || 'The request did not come back.')}</p>
      ${e.status === 404 ? `<p class="sub" style="margin:0;">The page loaded but its API is not answering. That usually means the
        server is still running the previous version \u2014 static files update the moment they are copied across, but routes
        only appear when the service is restarted. Restarting AOTC Track on the server should fix it.</p>`
        : e.status === 403 ? `<p class="sub" style="margin:0;">Your account does not have access to the weekly finance book.
        It needs the Accounts Clerk entry right, the Treasurer confirmation right, or congregation-wide view.</p>`
        : `<p class="sub" style="margin:0;">Reload the page. If it keeps happening, note the message above.</p>`}
    </div>`;
    return;
  }
  lines = res.lines || [];
  week = res.week;
  fwProgs = JSON.parse(JSON.stringify((week && week.programmes) || []));
  document.getElementById('weekLabel').textContent = longDay(currentDate);
  render(res.warnings || []);
  loadTotals();
  loadList();
  fwLoadDiaryProgs();
}

// ---- Programmes during the week (Nov 2026) -----------------------------------
// A revival or a 2-, 3-, 5-day programme: an offering each day it runs. They
// count as Offertory and are read out, one line per programme with its days.
// Mirrors cleanProgrammes / daysLabel / programmeLabel in utils/financeWeekly.js.
let fwProgs = [];          // [{ name, diaryKey, days: [{ date, amount }] }]
let fwDiaryProgs = [];     // programmes on the Church Diary that week, to pick from
function fwWeekDays(sunday) {
  const out = []; const [y, m, d] = sunday.split('-').map(Number);
  for (let i = 6; i >= 0; i -= 1) { const x = new Date(y, m - 1, d - i, 12); out.push(ymd(x)); }
  return out;
}
function fwDay(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d, 12); }
function fwDaysLabel(dates) {
  const ds = (dates || []).filter(Boolean).slice().sort();
  if (!ds.length) return '';
  const wd = k => fwDay(k).toLocaleDateString('en-GB', { weekday: 'short' });
  const mon = k => fwDay(k).toLocaleDateString('en-GB', { month: 'long' });
  const part = (k, withMonth) => `${wd(k)} ${fwDay(k).getDate()}${withMonth ? ` ${mon(k)}` : ''}`;
  if (ds.length === 1) return part(ds[0], true);
  const inRow = ds.every((k, i) => i === 0 || (fwDay(k) - fwDay(ds[i - 1])) === 86400000);
  const one = mon(ds[0]) === mon(ds[ds.length - 1]);
  if (inRow) return `${part(ds[0], !one)} – ${part(ds[ds.length - 1], true)}`;
  const parts = ds.map((k, i) => part(k, !one || i === ds.length - 1));
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
function fwProgLabel(p) {
  const name = String(p.name || 'Programme').trim() || 'Programme';
  const lbl = fwDaysLabel((p.days || []).filter(d => num(d.amount) > 0).map(d => d.date));
  return `${/offering$/i.test(name) ? name : `${name} offering`}${lbl ? ` (${lbl})` : ''}`;
}
const fwProgTotal = p => (p.days || []).reduce((t, d) => t + num(d.amount), 0);
function fwProgHtml() {
  const locked = !canEnter || (week && week.status === 'confirmed');
  const days = fwWeekDays(currentDate);
  const list = fwProgs.map((p, i) => {
    const on = new Map((p.days || []).map(d => [d.date, d]));
    return `<div class="fw-prog" data-prog="${i}" style="border:1px dashed var(--rule);border-radius:10px;padding:10px 12px;margin:0 0 10px;">
      <div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;">
        <div class="field" style="flex:1 1 240px;margin:0;"><label>Programme</label>
          <input class="fw-prog-name" list="fwDiaryProgList" value="${esc(p.name || '')}" placeholder="e.g. Revival · Men's Fellowship week" ${locked ? 'disabled' : ''} onchange="fwProgName(${i}, this.value)"></div>
        <b class="mono" style="padding:8px 0;">GHS ${amt(fwProgTotal(p))}</b>
        ${locked ? '' : `<button type="button" class="btn btn-secondary btn-sm" onclick="fwProgDel(${i})" aria-label="Remove this programme">Remove</button>`}
      </div>
      <div class="sub" style="font-size:11.5px;margin:8px 0 4px;">Tick each day an offering was taken, and enter it:</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:6px;">
        ${days.map(k => { const d = on.get(k); return `<label style="display:block;border:1px solid var(--rule);border-radius:8px;padding:6px 8px;${d ? 'background:var(--hover-surface);' : ''}">
          <span style="display:flex;gap:6px;align-items:center;font-size:12.5px;"><input type="checkbox" style="width:auto;" ${d ? 'checked' : ''} ${locked ? 'disabled' : ''} onchange="fwProgDay(${i}, '${k}', this.checked)">
          ${esc(fwDay(k).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }))}</span>
          ${d ? `<input inputmode="decimal" class="fw-prog-amt" data-date="${k}" value="${d.amount ? Number(d.amount).toLocaleString() : ''}" placeholder="GHS" style="margin-top:4px;" ${locked ? 'disabled' : ''} oninput="fwProgAmt(${i}, '${k}', this.value)">` : ''}
        </label>`; }).join('')}
      </div>
    </div>`;
  }).join('');
  return `<div class="section-title" style="margin:16px 0 6px;"><h3 style="font-size:13.5px;">Programmes during the week <span class="sub" style="font-weight:400;">— a revival, a 2-, 3- or 5-day programme: an offering each day</span></h3></div>
    <p class="sub" style="margin:0 0 8px;font-size:12px;">Counted as Offertory and read out, one line per programme with its days. The days are this Sunday and the six before it.</p>
    <datalist id="fwDiaryProgList">${fwDiaryProgs.map(d => `<option value="${esc(d.title)}">`).join('')}</datalist>
    ${list || '<p class="sub" style="margin:0 0 8px;">None this week.</p>'}
    ${locked ? '' : `<button type="button" class="btn btn-secondary btn-sm" onclick="fwProgAdd()">+ Add a programme</button>`}`;
}
function fwProgRedraw() { const box = document.getElementById('fwProgBox'); if (box) box.innerHTML = fwProgHtml(); recalc(); }
function fwProgAdd() { fwProgs.push({ name: '', diaryKey: '', days: [] }); fwProgRedraw(); }
function fwProgDel(i) { fwProgs.splice(i, 1); fwProgRedraw(); }
function fwProgName(i, v) {
  const p = fwProgs[i]; p.name = v.trim();
  // A programme picked from the Church Diary ticks the days it runs this week.
  const hit = fwDiaryProgs.find(d => d.title === p.name);
  if (hit) {
    p.diaryKey = hit.key;
    const week7 = fwWeekDays(currentDate);
    week7.filter(k => k >= hit.date && k <= (hit.endDate || hit.date)).forEach(k => { if (!p.days.some(d => d.date === k)) p.days.push({ date: k, amount: 0 }); });
    p.days.sort((a, b) => a.date.localeCompare(b.date));
    fwProgRedraw(); return;
  }
  recalc();
}
function fwProgDay(i, k, on) {
  const p = fwProgs[i];
  if (on) { if (!p.days.some(d => d.date === k)) p.days.push({ date: k, amount: 0 }); p.days.sort((a, b) => a.date.localeCompare(b.date)); }
  else p.days = p.days.filter(d => d.date !== k);
  fwProgRedraw();
  if (on) { const el = document.querySelector(`[data-prog="${i}"] .fw-prog-amt[data-date="${k}"]`); if (el) el.focus(); }
}
function fwProgAmt(i, k, v) {
  const d = fwProgs[i].days.find(x => x.date === k); if (d) d.amount = num(v);
  const tot = document.querySelector(`[data-prog="${i}"] b.mono`); if (tot) tot.textContent = `GHS ${amt(fwProgTotal(fwProgs[i]))}`;
  recalc();
}
async function fwLoadDiaryProgs() {
  try {
    const days = fwWeekDays(currentDate);
    const d = await api(`/diary?from=${days[0]}&to=${days[6]}`);
    fwDiaryProgs = (d.items || []).filter(x => ['programme', 'other', 'thanksgiving'].includes(x.kind));
    fwProgRedraw();
  } catch (e) { fwDiaryProgs = []; }
}

function amountOf(key) {
  return week && week.amounts ? week.amounts[key] : null;
}

function lineRow(l) {
  const v = amountOf(l.key);
  const locked = !canEnter || (week && week.status === 'confirmed');
  return `<tr>
    <td>${esc(l.label)}${l.isTotal ? ' <span class="sub">(the whole figure, not a head)</span>' : ''}</td>
    <td><input inputmode="decimal" style="max-width:150px;" data-line="${esc(l.key)}" ${locked ? 'disabled' : ''}
      value="${v != null && v !== 0 ? Number(v).toLocaleString() : ''}" oninput="recalc()"></td>
    <td class="sub" style="font-size:11.5px;">${l.feeds ? esc(feedLabel(l.feeds)) : ''}</td>
    <td class="sub" style="font-size:11.5px; text-align:center;" title="${isAnnounced(l) ? 'Read out in the announcement' : 'Recorded, but not read out'}">${isAnnounced(l) ? '\u2713' : ''}</td>
  </tr>`;
}
let FEEDS = {};
function feedLabel(k) { return FEEDS[k] || k; }

function render(warnings) {
  const st = STATUS[(week && week.status) || 'draft'];
  const receipts = lines.filter(l => l.side === 'in');
  const payments = lines.filter(l => l.side === 'out');
  const confirmed = week && week.status === 'confirmed';

  const actions = [];
  if (canEnter && !confirmed) {
    actions.push(`<button class="btn btn-secondary" onclick="save('draft')">Save draft</button>`);
    actions.push(`<button class="btn btn-primary" onclick="save('entered')">Submit for confirmation</button>`);
  }
  if (canConfirm && week && week.status === 'entered') {
    actions.push(`<button class="btn btn-primary" onclick="confirmWeek()">Confirm this week</button>`);
  }
  if (canConfirm && confirmed) {
    actions.push(`<button class="btn btn-danger" onclick="reopen()">Reopen</button>`);
  } else if (confirmed && canEnter) {
    // The Accounts Clerk enters it but cannot reopen it — so they ask the
    // Treasurer here rather than over the phone.
    actions.push(reopenButtonHtml('finance-week', { date: currentDate }, 'Ask the Treasurer to reopen'));
  }

  document.getElementById('weekBody').innerHTML = `
    <div class="card" style="margin-bottom:18px; border-top:3px solid var(--pcg-green);">
      <div class="section-title" style="display:flex; justify-content:space-between; align-items:center;">
        <h3>Funds received and paid — ${esc(longDay(currentDate))}</h3>
        <span class="badge ${st.cls}">${st.label}</span>
      </div>
      ${week && week.status === 'confirmed' ? `<p class="sub" style="margin:0 0 10px;">Confirmed by ${esc(week.confirmedBy || '')} on ${new Date(week.confirmedAt).toLocaleString('en-GB')}. These figures now count towards the quarter.</p>` : ''}
      ${week && week.status === 'entered' ? `<p class="sub" style="margin:0 0 10px;">Entered by ${esc(week.enteredBy || '')}. Waiting for the Treasurer — it does not count towards the quarter until then.</p>` : ''}
      ${warnings.length ? `<div class="sub" style="background:var(--surface-2); border-left:3px solid var(--warn, #b8860b); padding:8px 12px; border-radius:6px; margin-bottom:12px;">${warnings.map(esc).join('<br>')}</div>` : ''}

      <div class="section-title" style="margin-bottom:6px;"><h3 style="font-size:13.5px;">Receipts</h3></div>
      <table><thead><tr><th style="width:44%;">Line</th><th>Amount (GHS)</th><th style="text-align:left;">Carried to</th><th style="text-align:center;" title="Appears in the announcement">Read out</th></tr></thead>
        <tbody>${receipts.map(lineRow).join('')}
        </tbody></table>
      <div id="fwProgBox">${fwProgHtml()}</div>
      <table><tbody>
          <tr style="border-top:2px solid var(--rule);"><td style="width:44%;"><b>Total funds received</b><div class="sub" style="font-size:11px;">Every receipt line and the programmes. The announcement totals only what is read out.</div></td>
            <td class="mono"><b id="receiptsTotal">0.00</b></td><td></td><td></td></tr>
        </tbody></table>

      <div class="section-title" style="margin:16px 0 6px;"><h3 style="font-size:13.5px;">Payments</h3></div>
      <table><thead><tr><th style="width:44%;">Line</th><th>Amount (GHS)</th><th style="text-align:left;">Carried to</th><th></th></tr></thead>
        <tbody>${payments.map(lineRow).join('')}</tbody></table>

      <div class="field" style="max-width:520px; margin-top:14px;"><label>Note (optional)</label>
        <input id="weekNote" ${!canEnter || confirmed ? 'disabled' : ''} value="${esc((week && week.note) || '')}" placeholder="Anything the Treasurer should know"></div>

      <div style="display:flex; gap:10px; margin-top:14px; flex-wrap:wrap;">${actions.join('')}</div>
    </div>

    <div class="card">
      <div class="section-title"><h3>Announcement text</h3></div>
      <p class="sub" style="margin:0 0 10px;">Exactly as it is read out — receipts only, totalled. Copy it straight into the announcement.</p>
      <div style="border:1px solid var(--rule); border-left:4px solid var(--primary); border-radius:8px; padding:10px 14px; display:flex; gap:12px; align-items:flex-start;">
        <p id="annText" style="margin:0; flex:1; white-space:pre-line;">${esc(announcement())}</p>
        <button class="btn btn-secondary btn-sm" onclick="copyAnnouncement()">Copy</button>
      </div>
    </div>`;
  recalc();
}

// Built in the browser from what is on screen, so it tracks as you type rather
// than only after a save. The server builds the same string from the stored
// figures; they agree because the rule is the same in both places.
// Only the lines flagged for the announcement, which is a shorter list than
// the books keep - see isAnnounced() in utils/financeWeekly.js. The headline
// total is the sum of what is actually read out, not of everything entered.
function isAnnounced(l) { return l && l.side === 'in' && l.announce !== false; }
function announcement() {
  const shown = lines.filter(isAnnounced).map(l => {
    const el = document.querySelector(`[data-line="${CSS.escape(l.key)}"]`);
    const v = el ? num(el.value) : num(amountOf(l.key));
    return { label: l.label, v };
  }).filter(x => x.v > 0);
  fwProgs.forEach(p => { const v = fwProgTotal(p); if (v > 0) shown.push({ label: fwProgLabel(p), v }); });
  const total = shown.reduce((t, x) => t + x.v, 0);
  return `Funds received within the previous week amounted to GHS ${amt(total)}.\n`
    + shown.map(x => `•\t${x.label}\t${amt(x.v)}`).join('\n');
}

function recalc() {
  const t = lines.filter(l => l.side === 'in').reduce((sum, l) => {
    const el = document.querySelector(`[data-line="${CSS.escape(l.key)}"]`);
    return sum + (el ? num(el.value) : 0);
  }, 0) + fwProgs.reduce((x, p) => x + fwProgTotal(p), 0);
  const cell = document.getElementById('receiptsTotal');
  if (cell) cell.textContent = amt(t);
  const ann = document.getElementById('annText');
  if (ann) ann.textContent = announcement();
}

async function copyAnnouncement() {
  const text = document.getElementById('annText').textContent;
  try { await navigator.clipboard.writeText(text); toast('Copied — paste it into the announcement'); }
  catch (e) { toast('Could not reach the clipboard — select the text and copy it by hand.', true); }
}

function collect() {
  const amounts = {};
  lines.forEach(l => {
    const el = document.querySelector(`[data-line="${CSS.escape(l.key)}"]`);
    if (el) amounts[l.key] = num(el.value);
  });
  return amounts;
}

async function save(status) {
  const amounts = collect();
  const note = (document.getElementById('weekNote') || {}).value || '';
  if (status === 'entered') {
    const total = lines.filter(l => l.side === 'in').reduce((t, l) => t + num(amounts[l.key]), 0) + fwProgs.reduce((x, p) => x + fwProgTotal(p), 0);
    if (!await confirmDialog(
      `Funds received: GHS ${amt(total)}.\n\nThis goes to the Treasurer to confirm. You can still change it until they do.`,
      { title: 'Submit this week?', okText: 'Submit' })) return;
  }
  try {
    const programmes = fwProgs.map(p => ({ name: p.name, diaryKey: p.diaryKey || '', days: (p.days || []).map(d => ({ date: d.date, amount: num(d.amount) })) }));
    const res = await api(`/finance-weekly/week/${currentDate}`, { method: 'PUT', body: { amounts, note, status, programmes } });
    week = res.week;
    fwProgs = JSON.parse(JSON.stringify((week && week.programmes) || []));
    toast(status === 'entered' ? 'Submitted — the Treasurer has been told' : 'Saved');
    render(res.warnings || []);
    loadList();
  } catch (e) { toast(e.message, true); }
}

async function confirmWeek() {
  const total = lines.filter(l => l.side === 'in').reduce((t, l) => t + num(amountOf(l.key)), 0);
  if (!await confirmDialog(
    `Funds received: GHS ${amt(total)} for ${longDay(currentDate)}.\n\nConfirming makes these figures count towards the quarter and tells the Session Clerk.`,
    { title: 'Confirm this week?', okText: 'Confirm' })) return;
  try { await api(`/finance-weekly/week/${currentDate}/confirm`, { method: 'POST', body: {} }); toast('Confirmed'); load(); }
  catch (e) { toast(e.message, true); }
}

async function reopen() {
  const reason = prompt('Why is this week being reopened?');
  if (!reason || !reason.trim()) return;
  try { await api(`/finance-weekly/week/${currentDate}/reopen`, { method: 'POST', body: { reason } }); toast('Reopened'); load(); }
  catch (e) { toast(e.message, true); }
}

// What every line adds up to so far. Fetched separately from the week so a
// slow or failing totals call can never stop the entry form appearing - the
// clerk’s job is to enter the figures, and that must always be possible.
async function loadTotals() {
  const host = document.getElementById('totalsCard');
  if (!host) return;
  const year = Number(currentDate.slice(0, 4));
  // The cards follow the Sunday on screen by default, but can be pointed at
  // any quarter - Q1 to Q3 2026 have no weekly data and still need figures.
  const q = totalsQuarter || (Math.floor(Number(currentDate.slice(5, 7) - 1) / 3) + 1);
  try { runningTotals = await api(`/finance-weekly/totals?year=${year}&quarter=${q}`); }
  catch (e) { host.innerHTML = `<div class="card"><p class="sub">Totals unavailable \u2014 ${esc(e.message)}</p></div>`; return; }
  const t = runningTotals;
  const row = r => `<tr>
      <td>${esc(r.label)}${r.retired ? ' <span class="sub">(retired)</span>' : ''}</td>
      <td class="mono">${amt(r.quarter)}</td>
      <td class="mono"><b>${amt(r.year)}</b></td>
    </tr>`;
  const receipts = t.lines.filter(l => l.side === 'in');
  const payments = t.lines.filter(l => l.side === 'out');
  host.innerHTML = perMemberCard(t.perMember) + `<div class="card" style="margin-bottom:18px;">
    <div class="section-title"><h3>Totals so far \u2014 Q${t.quarter} ${t.year}</h3></div>
    <p class="sub" style="margin:0 0 10px;">Confirmed Sundays only: <b>${t.quarterConfirmed} of ${t.sundaysInQuarter}</b> in Q${t.quarter},
      <b>${t.yearConfirmed} of ${t.sundaysInYear}</b> in ${t.year}${t.firstWeek ? ` (${shortDay(t.firstWeek)} to ${shortDay(t.lastWeek)})` : ''}.${t.quarterAwaiting ? ` ${t.quarterAwaiting} more entered and waiting for the Treasurer \u2014 these figures will move once confirmed.` : ''}</p>
    ${t.yearConfirmed && t.yearConfirmed < t.sundaysInYear / 2
      ? `<p class="sub" style="margin:-4px 0 10px; padding:6px 10px; background:var(--surface-2); border-left:3px solid var(--rule); border-radius:4px;">
         The ${t.year} column covers only the Sundays above, not the whole year \u2014 don't read it as an annual total, and don't compare it
         like-for-like against a full year later on.</p>` : ''}
    <table style="max-width:640px;">
      <thead><tr><th style="width:52%;">Line</th><th>Q${t.quarter}</th><th style="text-align:left;">${t.year} so far</th></tr></thead>
      <tbody>
        ${receipts.map(row).join('')}
        <tr style="border-top:2px solid var(--rule);"><td><b>Total received</b></td>
          <td class="mono"><b>${amt(t.receipts.quarter)}</b></td><td class="mono"><b>${amt(t.receipts.year)}</b></td></tr>
        ${payments.length ? `<tr><td colspan="3" style="padding-top:14px;"><b>Payments</b></td></tr>` + payments.map(row).join('') : ''}
      </tbody>
    </table>
  </div>`;
}

// Giving per member — the two figures CLN's SO-2.1 is measured on.
//
// Always says what it divided by, and by how many weeks. A per-member figure
// with an unstated denominator is worse than no figure: it looks precise and
// cannot be checked.
function perMemberCard(pm) {
  if (!pm) return '';
  const t = runningTotals || {};
  const gh = v => v === null || v === undefined ? '\u2014' : 'GHS ' + amt(v);
  const pct = v => v === null || v === undefined ? null : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  const qPicker = `<div class="basis-toggle" style="display:inline-flex;">${[1, 2, 3, 4]
    .map(q => `<button class="${t.quarter === q ? 'active' : ''}" onclick="showQuarter(${q})">Q${q}</button>`).join('')}</div>`;

  if (!pm.members) {
    return `<div class="card" style="margin-bottom:18px;">
      <div class="section-title" style="display:flex; justify-content:space-between; align-items:center;">
        <h3>Giving per member \u2014 Q${t.quarter} ${t.year}</h3>${qPicker}</div>
      <p class="sub" style="margin:0;">No membership figures on record for this quarter, so there is nothing to divide by.
        Enter members on roll in Quarterly Entry under AHRM, or type the figures directly with <b>Type figures</b>.</p>
      ${canEnterQuarterly ? '<button class="btn btn-secondary btn-sm" style="margin-top:10px;" onclick="openPerMemberEntry()">Type figures</button>' : ''}
    </div>`;
  }

  // Each row says where its number came from, and - when typed - what the
  // software would have said instead. Reverting should never be a leap.
  const row = (label, key, value, base, increase, kpi) => {
    const typed = pm.source[key] === 'typed';
    const comp = pm.computed[key];
    return `<tr>
      <td>${label}<div class="sub" style="font-size:11.5px;">${kpi}</div></td>
      <td class="mono"><b>${gh(value)}</b>
        <div><span class="badge ${typed ? 'badge-info' : 'badge-done'}" style="font-size:10px;">${typed ? 'typed' : 'computed'}</span></div>
        ${typed ? `<div class="sub" style="font-size:11px;">software would say ${comp === null ? 'nothing yet' : gh(comp)}</div>` : ''}</td>
      <td class="mono sub">${base === null ? '\u2014' : gh(base)}</td>
      <td class="mono">${increase === null ? '<span class="sub">needs a baseline</span>' : '<b>' + pct(increase) + '</b>'}</td>
    </tr>`;
  };
  const anyTyped = Object.values(pm.source).some(v => v === 'typed');
  return `<div class="card" style="margin-bottom:18px;">
    <div class="section-title" style="display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap;">
      <h3>Giving per member \u2014 Q${t.quarter} ${t.year}</h3>
      <div style="display:flex; gap:8px; align-items:center;">${qPicker}
        ${canEnterQuarterly ? '<button class="btn btn-secondary btn-sm" onclick="openPerMemberEntry()">Type figures</button>' : ''}
        ${canEnterQuarterly ? '<button class="btn btn-secondary btn-sm" onclick="openGivingBasis()">Change basis</button>' : ''}</div>
    </div>
    <p class="sub" style="margin:0 0 10px;">Divided by <b>${pm.members.toLocaleString()}</b> contributing members
      (${esc(pm.basisLabels.join(', '))})${pm.source.members === 'typed' ? ' \u2014 <b>typed</b>' : `, from the AHRM return for ${esc(pm.membersFrom || '\u2014')}${pm.membersStale ? ' (the most recent on record)' : ''}`}.
      ${pm.weeksCounted ? `Averaged over <b>${pm.weeksCounted}</b> confirmed Sunday${pm.weeksCounted === 1 ? '' : 's'}.` : 'No confirmed Sundays in this quarter.'}</p>
    <table style="max-width:700px;">
      <thead><tr><th style="width:38%;">Measure</th><th>This quarter</th><th style="text-align:left;">${esc(pm.baseline.label)}</th><th style="text-align:left;">Change</th></tr></thead>
      <tbody>
        ${row('Average weekly offertory per member', 'offertoryPerMemberWeek', pm.offertoryPerMemberWeek, pm.baseline.offertoryPerMemberWeek, pm.offertoryIncreasePct, 'SO-2.1 \u00b7 target 100% increase by 31 Dec 2027')}
        ${row('Average monthly tithe per member', 'tithePerMemberMonth', pm.tithePerMemberMonth, pm.baseline.tithePerMemberMonth, pm.titheIncreasePct, 'SO-2.1 \u00b7 target 50% increase by 31 Dec 2027')}
      </tbody>
    </table>
    ${anyTyped ? `<p class="sub" style="margin:8px 0 0;">A typed figure stays put and is what the report uses. The weekly returns keep working
       underneath it \u2014 clear the box under <b>Type figures</b> and the computed figure takes over again.</p>` : ''}
    ${!anyTyped && pm.baseline.offertoryPerMemberWeek === null && pm.baseline.tithePerMemberMonth === null
      ? `<p class="sub" style="margin:8px 0 0;">SO-2.1 measures the <b>increase</b> over ${esc(pm.baseline.label)}. Enter those figures once under
         <b>Change basis</b> and both percentages fill themselves in from here on.</p>`
      : ''}
  </div>`;
}

function showQuarter(q) { totalsQuarter = q; loadTotals(); }

// Typing figures for a quarter the ledger cannot produce - and clearing them
// again. A blank box means "use what the software computes", which is why
// every box shows the computed figure as its placeholder: you can see what
// you are reverting to before you revert.
async function openPerMemberEntry() {
  const t = runningTotals || {}; const pm = t.perMember || {};
  const c = pm.computed || {}; const ty = pm.typed || {};
  const ph = v => v === null || v === undefined ? 'nothing computed yet' : Number(v).toFixed(2);
  const body = document.createElement('div');
  body.innerHTML = `<div class="modal-overlay app-dialog"><div class="modal" style="max-width:560px;">
    <h2>Per-member figures \u2014 Q${t.quarter} ${t.year}</h2>
    <p class="sub">Type a figure where the weekly returns cannot produce one. <b>Leave a box empty to use what the
      software computes</b> \u2014 the grey text in each box is that figure, so you can see what you would be going back to.</p>
    <div class="field"><label>Average weekly offertory per member (GHS)</label>
      <input id="pmOff" inputmode="decimal" value="${ty.offertoryPerMemberWeek ?? ''}" placeholder="${esc(ph(c.offertoryPerMemberWeek))}"></div>
    <div class="field"><label>Average monthly tithe per member (GHS)</label>
      <input id="pmTit" inputmode="decimal" value="${ty.tithePerMemberMonth ?? ''}" placeholder="${esc(ph(c.tithePerMemberMonth))}"></div>
    <div class="field"><label>Contributing members</label>
      <input id="pmMem" inputmode="numeric" value="${ty.members ?? ''}" placeholder="${esc(c.members === null || c.members === undefined ? 'no AHRM return' : String(c.members))}"></div>
    <div class="modal-actions">
      <button class="btn btn-secondary" id="pmRevert">Use computed for all</button>
      <button class="btn btn-secondary" id="pmCancel">Cancel</button>
      <button class="btn btn-primary" id="pmSave">Save</button></div>
  </div></div>`;
  document.body.appendChild(body);
  const send = async payload => {
    try { await api(`/finance-weekly/per-member/${t.year}/${t.quarter}`, { method: 'PUT', body: payload });
      body.remove(); toast('Saved'); loadTotals(); }
    catch (e) { toast(e.message, true); }
  };
  body.querySelector('#pmCancel').onclick = () => body.remove();
  body.querySelector('#pmRevert').onclick = () => send({ offertoryPerMemberWeek: null, tithePerMemberMonth: null, members: null });
  body.querySelector('#pmSave').onclick = () => {
    const v = id => { const x = body.querySelector(id).value.trim(); return x === '' ? null : x; };
    send({ offertoryPerMemberWeek: v('#pmOff'), tithePerMemberMonth: v('#pmTit'), members: v('#pmMem') });
  };
}

async function openGivingBasis() {
  const t = runningTotals || {};
  const pm = t.perMember || {}; const cats = t.memberCategories || [];
  const b = pm.baseline || {};
  const body = document.createElement('div');
  body.innerHTML = `<div class="modal-overlay app-dialog"><div class="modal" style="max-width:560px;">
    <h2>Giving per member</h2>
    <p class="sub">Which members the totals are divided by. Children and Junior Youth are normally left out
      because they do not tithe \u2014 including them roughly halves every figure.</p>
    ${cats.map(c => `<label style="display:block; margin:6px 0;"><input type="checkbox" data-cat="${esc(c.key)}"
      ${(pm.basis || []).includes(c.key) ? 'checked' : ''}> ${esc(c.label)}</label>`).join('')}
    <div class="section-title" style="margin-top:14px;"><h3 style="font-size:13.5px;">Baseline for SO-2.1</h3></div>
    <p class="sub">The figures SO-2.1 measures the increase against. Leave blank if you do not have them.</p>
    <div class="field"><label>Baseline period</label><input id="gbLabel" value="${esc(b.label || 'January 2026')}"></div>
    <div class="field"><label>Weekly offertory per member then (GHS)</label><input id="gbOff" inputmode="decimal" value="${b.offertoryPerMemberWeek ?? ''}"></div>
    <div class="field"><label>Monthly tithe per member then (GHS)</label><input id="gbTit" inputmode="decimal" value="${b.tithePerMemberMonth ?? ''}"></div>
    <div class="modal-actions"><button class="btn btn-secondary" id="gbCancel">Cancel</button><button class="btn btn-primary" id="gbSave">Save</button></div>
  </div></div>`;
  document.body.appendChild(body);
  body.querySelector('#gbCancel').onclick = () => body.remove();
  body.querySelector('#gbSave').onclick = async () => {
    const memberBasis = [...body.querySelectorAll('[data-cat]')].filter(i => i.checked).map(i => i.getAttribute('data-cat'));
    if (!memberBasis.length) { toast('Choose at least one category to divide by.', true); return; }
    try {
      await api('/finance-weekly/config', { method: 'PUT', body: { memberBasis, baseline: {
        label: body.querySelector('#gbLabel').value,
        offertoryPerMemberWeek: body.querySelector('#gbOff').value,
        tithePerMemberMonth: body.querySelector('#gbTit').value,
      } } });
      body.remove(); toast('Saved'); loadTotals();
    } catch (e) { toast(e.message, true); }
  };
}

async function loadList() {
  const year = Number(currentDate.slice(0, 4));
  try {
    const res = await api(`/finance-weekly/weeks?year=${year}`);
    const rows = (res.weeks || []).map(w => {
      const st = STATUS[w.status] || STATUS.draft;
      return `<tr>
        <td><a href="#" onclick="go('${w.date}');return false;">${esc(longDay(w.date))}</a></td>
        <td class="mono">${amt(w.receiptsTotal)}</td>
        <td><span class="badge ${st.cls}">${st.label}</span></td>
        <td class="sub">${esc(w.confirmedBy || w.enteredBy || '')}</td>
      </tr>`;
    }).join('');
    document.getElementById('weekList').innerHTML = rows
      ? `<table><thead><tr><th>Sunday</th><th>Funds received</th><th>Status</th><th>By</th></tr></thead><tbody>${rows}</tbody></table>`
      : '<p class="sub">Nothing entered for this year yet.</p>';
  } catch (e) { document.getElementById('weekList').innerHTML = `<p class="sub">${esc(e.message)}</p>`; }
}

function go(date) {
  currentDate = date;
  document.getElementById('weekDate').value = date;
  load();
}

// ---- line editor (admin / setup.manage) ----
async function openLines() {
  const res = await api('/finance-weekly/lines?all=1');
  const all = res.lines || [];
  const opts = Object.entries(res.feedTargets || {}).map(([k, v]) => ({ k, v }));
  const rows = all.map((l, i) => `<tr>
    <td><input value="${esc(l.label)}" data-ed="label" data-i="${i}" style="min-width:200px;"></td>
    <td><select data-ed="side" data-i="${i}">
      <option value="in" ${l.side === 'in' ? 'selected' : ''}>Receipt</option>
      <option value="out" ${l.side === 'out' ? 'selected' : ''}>Payment</option></select></td>
    <td><select data-ed="feeds" data-i="${i}">${opts.map(o => `<option value="${esc(o.k)}" ${(l.feeds || '') === o.k ? 'selected' : ''}>${esc(o.v)}</option>`).join('')}</select></td>
    <td style="text-align:center;"><input type="checkbox" data-ed="announce" data-i="${i}" ${l.side === 'in' ? '' : 'disabled'} ${l.side === 'in' && l.announce !== false ? 'checked' : ''}></td>
    <td style="text-align:center;"><input type="checkbox" data-ed="active" data-i="${i}" ${l.active !== false ? 'checked' : ''}></td>
    <td class="mono sub">${esc(l.key)}</td>
  </tr>`).join('');
  const body = document.createElement('div');
  body.innerHTML = `<div class="modal-overlay app-dialog"><div class="modal" style="max-width:840px;">
    <h2>Weekly finance lines</h2>
    <p class="sub">Untick a line to retire it — weeks already entered keep their figures. "Carried to" is where the line lands in the quarterly Finance panel.</p>
    <div style="max-height:52vh; overflow:auto;"><table><thead><tr><th>Label</th><th>Side</th><th>Carried to</th><th>In announcement</th><th>In use</th><th>Key</th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="field" style="margin-top:12px; max-width:420px;"><label>Add a line (label)</label><input id="newLineLabel" placeholder="e.g. Harvest Thanksgiving"></div>
    <div class="modal-actions"><button class="btn btn-secondary" id="lnCancel">Cancel</button><button class="btn btn-primary" id="lnSave">Save lines</button></div>
  </div></div>`;
  document.body.appendChild(body);
  body.querySelector('#lnCancel').onclick = () => body.remove();
  body.querySelector('#lnSave').onclick = async () => {
    const out = all.map((l, i) => ({
      key: l.key, isTotal: !!l.isTotal,
      label: body.querySelector(`[data-ed="label"][data-i="${i}"]`).value,
      side: body.querySelector(`[data-ed="side"][data-i="${i}"]`).value,
      feeds: body.querySelector(`[data-ed="feeds"][data-i="${i}"]`).value,
      announce: body.querySelector(`[data-ed="announce"][data-i="${i}"]`).checked,
      active: body.querySelector(`[data-ed="active"][data-i="${i}"]`).checked,
    })).filter(l => l.active);
    const fresh = body.querySelector('#newLineLabel').value.trim();
    if (fresh) {
      // Key derived from the label, kept stable forever after: the key is what
      // historic weeks are stored against, so it must never be regenerated.
      let key = fresh.replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(' ')
        .map((p, i) => i ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p.toLowerCase()).join('');
      if (!/^[a-zA-Z]/.test(key)) key = 'line' + key;
      if (out.some(l => l.key === key) || all.some(l => l.key === key)) { toast('There is already a line with that name.', true); return; }
      out.push({ key, label: fresh, side: 'in', feeds: '', isTotal: false, announce: true, active: true });
    }
    try { await api('/finance-weekly/lines', { method: 'PUT', body: { lines: out } }); body.remove(); toast('Lines saved'); load(); }
    catch (e) { toast(e.message, true); }
  };
}

requireAuthAndRenderShell().then(async u => {
  me = u;
  const perms = me.permissions || [];
  canEnter = isElevated(me) || perms.includes('finance.weekly');
  canConfirm = isElevated(me) || perms.includes('finance.weekly.confirm');
  canEditLines = isElevated(me) || perms.includes('finance.weekly.lines');
  canEnterQuarterly = isElevated(me) || perms.includes('finance.quarterly');
  document.getElementById('linesBtn').style.display = canEditLines ? '' : 'none';
  document.getElementById('linesBtn').onclick = openLines;

  // Non-fatal: without this the "Carried to" column is blank, but the
  // figures still enter. load() below reports anything worse.
  try { const r = await api('/finance-weekly/lines'); FEEDS = r.feedTargets || {}; } catch (e) { FEEDS = {}; }

  const param = new URLSearchParams(location.search).get('date');
  currentDate = sundayOf(param || '');
  const picker = document.getElementById('weekDate');
  picker.value = currentDate;
  picker.onchange = () => { go(sundayOf(picker.value)); };
  load();
});
