// Settings page — congregation details, crest, notification checks.
let currentUser, settings = {};

async function load() {
  settings = await api('/settings');
  document.getElementById('companyName').value = settings.companyName || '';
  document.getElementById('presbytery').value = settings.presbytery || '';
  document.getElementById('district').value = settings.district || '';
  document.getElementById('addressLines').value = (settings.addressLines || []).join('\n');
  document.getElementById('phones').value = (settings.phones || []).join('\n');
  document.getElementById('email').value = settings.email || '';
  document.getElementById('sessionClerk').value = settings.sessionClerk || '';
  document.getElementById('minister').value = settings.minister || '';
  document.getElementById('absenceFlagThreshold').value = settings.absenceFlagThreshold || 4;
  document.getElementById('currentLogo').src = settings.logoPath || '/img/logo-icon.png';
}

document.getElementById('settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    settings = await api('/settings', {
      method: 'PUT',
      body: {
        companyName: document.getElementById('companyName').value,
        presbytery: document.getElementById('presbytery').value,
        district: document.getElementById('district').value,
        addressLines: document.getElementById('addressLines').value.split('\n').map(s => s.trim()).filter(Boolean),
        phones: document.getElementById('phones').value.split('\n').map(s => s.trim()).filter(Boolean),
        email: document.getElementById('email').value,
        sessionClerk: document.getElementById('sessionClerk').value,
        minister: document.getElementById('minister').value,
        absenceFlagThreshold: numVal(document.getElementById('absenceFlagThreshold').value) || 4,
      },
    });
    toast('Saved. New reports will use these details.');
  } catch (err) { toast(err.message, true); }
});

document.getElementById('testEmailBtn').addEventListener('click', async () => {
  const el = document.getElementById('testEmailResult');
  el.textContent = 'Sending…';
  try {
    const r = await api('/settings/test-email', { method: 'POST' });
    el.textContent = `Sent to ${r.sentTo}. Check that inbox (and spam folder).`;
    el.style.color = 'var(--primary)';
  } catch (err) { el.textContent = err.message; el.style.color = 'var(--pcg-red)'; }
});

document.getElementById('testSmsBtn').addEventListener('click', async () => {
  const el = document.getElementById('testSmsResult');
  const to = document.getElementById('testSmsPhone').value.trim();
  if (!to) { el.textContent = 'Enter a phone number first.'; el.style.color = 'var(--pcg-red)'; return; }
  el.textContent = 'Sending…';
  try {
    const r = await api('/settings/test-sms', { method: 'POST', body: { to, phoneCountry: '+233' } });
    el.textContent = `Sent to ${r.sentTo}. It should arrive within a minute.`;
    el.style.color = 'var(--primary)';
  } catch (err) { el.textContent = err.message; el.style.color = 'var(--pcg-red)'; }
});

async function uploadLogo(file) {
  if (!/^image\/(jpe?g|png|webp)$/.test(file.type)) return toast('Only JPG, PNG, or WEBP images are allowed.', true);
  if (file.size > 3 * 1024 * 1024) return toast('Image must be under 3 MB.', true);
  const fd = new FormData();
  fd.append('logo', file);
  try {
    const res = await fetch('/api/settings/logo', { method: 'POST', body: fd, credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed.');
    settings = data;
    document.getElementById('currentLogo').src = settings.logoPath + '?t=' + Date.now();
    toast('Crest updated.');
  } catch (err) { toast(err.message, true); }
}
const logoDrop = document.getElementById('logoDrop');
logoDrop.addEventListener('click', () => document.getElementById('logoFile').click());
document.getElementById('logoFile').addEventListener('change', (e) => {
  const file = e.target.files[0]; e.target.value = '';
  if (file) uploadLogo(file);
});
['dragenter', 'dragover'].forEach(evt => logoDrop.addEventListener(evt, (e) => { e.preventDefault(); logoDrop.classList.add('drag-over'); }));
['dragleave', 'dragend'].forEach(evt => logoDrop.addEventListener(evt, (e) => { e.preventDefault(); logoDrop.classList.remove('drag-over'); }));
logoDrop.addEventListener('drop', (e) => {
  e.preventDefault(); logoDrop.classList.remove('drag-over');
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file) uploadLogo(file);
});

// Subtabs: one panel at a time.
document.getElementById('settingsSubtabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-tab]');
  if (!btn) return;
  document.querySelectorAll('#settingsSubtabs button').forEach(b => b.classList.toggle('active', b === btn));
  ['congregation', 'notifications', 'reminders', 'year'].forEach(t => {
    document.getElementById(t + 'Panel').style.display = t === btn.dataset.tab ? '' : 'none';
  });
});

async function loadReminders() {
  try {
    const log = await api('/reminders/log');
    document.getElementById('reminderRows').innerHTML = log.slice(0, 12).map(r => `<tr>
      <td>${fmtDate(r.sentAt)}</td><td>${esc(r.type)}</td><td>${esc(r.detail)}</td>
      <td class="mono">${r.sms}</td><td class="mono">${r.emails}</td></tr>`).join('')
      || '<tr><td colspan="5" class="sub">Nothing sent yet.</td></tr>';
  } catch (e) { /* non-admin */ }
}
document.getElementById('runRemindersBtn').addEventListener('click', async () => {
  try { await api('/reminders/run-now', { method: 'POST' }); toast('Reminder checks completed'); loadReminders(); }
  catch (e) { toast(e.message, true); }
});

// ---- Reporting years: list, add, activate ----
async function loadYears() {
  const rows = document.getElementById('yearRows');
  if (!rows) return;
  let years = [];
  try { years = await api('/setup/years'); } catch (e) { return; }
  rows.innerHTML = years.map(y => `<tr>
    <td class="mono">${y.year}</td>
    <td>${y.active ? '<span class="badge badge-done">Active</span>' : '<span class="badge badge-idle">Not active</span>'}</td>
    <td style="text-align:right;">${y.active ? '' : `<button class="btn btn-primary btn-sm" onclick="activateYear(${y.id}, ${y.year})">Make active</button>`}</td>
  </tr>`).join('') || '<tr><td colspan="3" class="sub">No years yet — add one below.</td></tr>';
}

async function activateYear(id, year) {
  if (!await confirmDialog(`Make ${year} the active reporting year? Quarterly entry, reports, planning and the dashboard will all switch to ${year}.`)) return;
  try {
    await api(`/setup/years/${id}/activate`, { method: 'PUT' });
    toast(`${year} is now the active year.`);
    loadYears();
  } catch (e) { toast(e.message, true); }
}

document.getElementById('addYearBtn').addEventListener('click', async () => {
  const y = Number(document.getElementById('newYear').value);
  if (!y) return toast('Enter the year to add', true);
  try {
    await api('/setup/years', { method: 'POST', body: { year: y } });
    document.getElementById('newYear').value = '';
    toast(`${y} added. Use "Make active" when you're ready to work in it.`);
    loadYears();
  } catch (e) { toast(e.message, true); }
});

document.getElementById('rollBtn').addEventListener('click', async () => {
  const y = Number(document.getElementById('rollYear').value);
  if (!y) return toast('Enter the new year', true);
  if (!await confirmDialog(`Roll over to ${y}? This creates ${y} goals from ${y - 1} figures.`)) return;
  const el = document.getElementById('rollResult');
  try {
    const r = await api('/setup/rollover', { method: 'POST', body: { newYear: y, copyActivities: document.getElementById('rollActs').checked } });
    el.textContent = `Done — ${r.goals} goals and ${r.activities} activities created for ${y}. Now use “Make active” above to switch the app to ${y}.`;
    toast('Rollover complete');
    loadYears();
  } catch (e) { el.textContent = e.message; }
});

// ("Send announcement to everyone" now lives on the Notifications page.)

(async () => {
  currentUser = await requireAuthAndRenderShell('/settings.html');
  if (!currentUser) return;
  if (!hasPermission(currentUser, 'staff.manage')) { location.href = '/index.html'; return; }
  load();
  loadReminders();
  loadYears();
})();
