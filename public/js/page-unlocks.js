// Reopen Requests.
//
// Before this page, four of the five locks in the app ended at "ring somebody".
// Now every one of them is asked for here, with a reason attached, and decided
// by whoever is placed to judge that kind: money (fundraising, the weekly
// finance entry) goes to the Treasurer, the rest (a quarterly entry, Sunday
// service attendance, a meeting's attendance) to the Session Clerk. An
// administrator decides any of them. The server is the authority on all of
// that — utils/unlockKinds.js — and tells us per row, in `canDecide`, so this
// page never has to re-derive the rule and get it subtly wrong.
let me, rows = [], scope = [], tab = 'pending', approving = null;

const KIND_LABEL = {
  'quarter': 'Quarterly entry',
  'service-day': 'Sunday service attendance',
  'meeting-attendance': 'Meeting attendance',
  'fundraising-day': 'Fundraising day',
  'finance-week': 'Weekly finance entry',
};
const STATUS_BADGE = {
  pending: '<span class="badge badge-progress">Waiting</span>',
  approved: '<span class="badge badge-done">Reopened</span>',
  declined: '<span class="badge badge-idle">Declined</span>',
  moot: '<span class="badge badge-idle">Already open</span>',
};

function when(iso) { return iso ? fmtDate(iso) : ''; }

async function load() {
  const data = await api('/unlocks').catch(() => ({ requests: [], approvableKinds: [] }));
  rows = data.requests || [];
  scope = data.approvableKinds || [];
  render();
}

function render() {
  // Say plainly what this person is here to do, so nobody wonders why their
  // colleague's request is not in their list.
  const card = document.getElementById('scopeCard');
  const text = document.getElementById('scopeText');
  if (scope.length) {
    card.style.display = '';
    text.innerHTML = 'You decide requests for: <strong>'
      + scope.map(k => esc(KIND_LABEL[k] || k)).join('</strong>, <strong>') + '</strong>.'
      + ' Other kinds go to whoever holds them.';
  } else {
    card.style.display = '';
    text.textContent = 'These are your own requests. You will be notified when each one is decided.';
  }

  const want = tab === 'pending' ? r => r.status === 'pending' : r => r.status !== 'pending';
  const list = rows.filter(want);
  const body = document.getElementById('rows');

  if (!list.length) {
    body.innerHTML = '<tr><td colspan="5" class="sub" style="padding:18px;">'
      + (tab === 'pending' ? 'Nothing is waiting to be decided.' : 'Nothing has been decided yet.')
      + '</td></tr>';
    return;
  }

  body.innerHTML = list.map(r => {
    const decided = r.status !== 'pending';
    const trail = decided
      ? `<div class="sub" style="margin-top:4px;">${esc(r.decidedBy || '')} &middot; ${esc(when(r.decidedAt))}`
        + (r.declineReason ? ` &middot; ${esc(r.declineReason)}` : '')
        + (r.expiresAt ? ` &middot; open until ${esc(when(r.expiresAt))}` : '') + '</div>'
      : '';
    const actions = r.canDecide
      ? `<button class="btn btn-primary btn-sm" data-approve="${r.id}">Reopen</button>
         <button class="btn btn-secondary btn-sm" data-decline="${r.id}">Decline</button>`
      : '';
    return `<tr>
      <td><div class="kind-tag">${esc(KIND_LABEL[r.kind] || r.kind)}</div>${esc(r.label || '')}</td>
      <td>${esc(r.requestedBy || '')}<div class="sub">${esc(when(r.createdAt))}</div></td>
      <td><div class="reason-quote">${esc(r.reason || '')}</div></td>
      <td>${STATUS_BADGE[r.status] || esc(r.status)}${trail}</td>
      <td style="text-align:right; white-space:nowrap;">${actions}</td>
    </tr>`;
  }).join('');
}

// ---- deciding ---------------------------------------------------------------
// A quarterly entry is the one timed kind: reopening it has to say for how
// long, exactly as the existing reopen on the submission board does. The other
// four simply open, and are re-locked by their owner when the correction is in.
function openApprove(id) {
  approving = rows.find(r => Number(r.id) === Number(id));
  if (!approving) return;
  const timed = approving.kind === 'quarter';
  document.getElementById('windowWrap').style.display = timed ? '' : 'none';
  document.getElementById('approveDetails').innerHTML =
    `<strong>${esc(KIND_LABEL[approving.kind] || approving.kind)}</strong> &mdash; ${esc(approving.label || '')}<br>`
    + `Asked by ${esc(approving.requestedBy || '')}: <em>${esc(approving.reason || '')}</em>`
    + (timed ? '' : '<br><span class="sub">It opens now, and locks again when it is confirmed.</span>');
  document.getElementById('approveOverlay').style.display = 'flex';
}
function closeApprove() {
  document.getElementById('approveOverlay').style.display = 'none';
  approving = null;
}

async function confirmApprove() {
  if (!approving) return;
  const body = approving.kind === 'quarter' ? { window: document.getElementById('windowSel').value } : {};
  try {
    await api(`/unlocks/${approving.id}/approve`, { method: 'POST', body });
    toast('Reopened. The person who asked has been notified.');
  } catch (e) {
    toast(e.message || 'Could not reopen it.', true);
  }
  closeApprove();
  await load();
}

async function decline(id) {
  const r = rows.find(x => Number(x.id) === Number(id));
  if (!r) return;
  // A decline without a reason is the phone call all over again, so ask for
  // one — but do not refuse the decline if they would rather not give it.
  const why = await promptDialog(
    'The person who asked will see this. Why is it staying as it is?',
    { title: 'Decline the request', multiline: true, okText: 'Decline', placeholder: 'e.g. the figures on file are correct' });
  if (why === null) return;
  try {
    await api(`/unlocks/${r.id}/decline`, { method: 'POST', body: { reason: String(why).trim() } });
    toast('Declined. The person who asked has been notified.');
  } catch (e) {
    toast(e.message || 'Could not decline it.', true);
  }
  await load();
}

document.addEventListener('click', e => {
  const chip = e.target.closest('#tabs .chip');
  if (chip) {
    tab = chip.getAttribute('data-tab');
    document.querySelectorAll('#tabs .chip').forEach(c => c.classList.toggle('active', c === chip));
    render();
    return;
  }
  const a = e.target.closest('[data-approve]');
  if (a) { openApprove(a.getAttribute('data-approve')); return; }
  const d = e.target.closest('[data-decline]');
  if (d) { decline(d.getAttribute('data-decline')); }
});

document.getElementById('approveCancelBtn').onclick = closeApprove;
document.getElementById('approveConfirmBtn').onclick = confirmApprove;

requireAuthAndRenderShell('/unlocks.html').then(u => {
  me = u;
  if (!me) return;
  load();
});
