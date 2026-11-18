// Notifications inbox — everything sent to this account (sign-off alerts,
// IOU reminders, meeting reminders, approvals), whether or not the device
// received the live push. Unread items are highlighted; opening one (or
// "Mark all read") clears it.
let me;

function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hr${h === 1 ? '' : 's'} ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

async function load() {
  const data = await api('/inbox');
  document.getElementById('countLabel').textContent = data.unread
    ? `${data.unread} unread` : 'You’re all caught up';
  document.getElementById('markAllBtn').style.display = data.unread ? '' : 'none';

  document.getElementById('notifList').innerHTML = data.items.map(n => `
    <div class="notif-row ${n.readAt ? '' : 'unread'}" data-id="${n.id}" data-url="${esc(n.url || '/')}"
         style="padding:14px 16px; border-bottom:1px solid var(--rule); cursor:pointer; display:flex; gap:12px; align-items:flex-start;">
      <span style="width:8px; height:8px; border-radius:50%; margin-top:7px; flex-shrink:0; background:${n.readAt ? 'transparent' : 'var(--primary)'};"></span>
      <div style="min-width:0;">
        <div style="font-weight:${n.readAt ? '500' : '700'};">${esc(n.title)}</div>
        <div class="sub" style="margin-top:2px; overflow-wrap:anywhere;">${esc(n.body)}</div>
        <div class="sub" style="margin-top:4px; font-size:11.5px;">${timeAgo(n.createdAt)}</div>
      </div>
    </div>`).join('')
    || '<div class="sub" style="padding:24px 16px;">Nothing here yet — sign-off alerts, reminders and approvals will appear in this inbox.</div>';

  document.querySelectorAll('.notif-row').forEach(row => {
    row.addEventListener('click', async () => {
      const id = Number(row.dataset.id);
      try { await api('/inbox/read', { method: 'POST', body: { ids: [id] } }); } catch (e) {}
      const url = row.dataset.url;
      if (url && url !== '/' && url !== location.pathname) location.href = url;
      else load();
    });
  });
}

document.getElementById('markAllBtn').addEventListener('click', async () => {
  try { await api('/inbox/read', { method: 'POST', body: {} }); toast('All marked as read'); load(); }
  catch (e) { toast(e.message, true); }
});

// Nudge people to enable device push if this browser supports it and they
// haven't yet — the inbox catches everything, but live pushes are nicer.
async function offerPush() {
  const btn = document.getElementById('enablePushBtn');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
  if (Notification.permission === 'granted') return; // already on (or handled elsewhere)
  if (Notification.permission === 'denied') return;
  btn.style.display = '';
  btn.addEventListener('click', async () => {
    try {
      await enablePushOnThisDevice();
      toast('Push enabled on this device');
      btn.style.display = 'none';
    } catch (e) { toast(e.message || 'Could not enable push here.', true); }
  });
}

// ---- Broadcast announcement (admin tier) — moved here from Settings so
// composing happens next to where messages are read, and Local Admins
// (who can't open Settings) can reach it too. ----
function initBroadcast() {
  if (!isElevated(me)) return;
  document.getElementById('bcCard').style.display = '';
  document.getElementById('bcSendBtn').addEventListener('click', async () => {
    const title = document.getElementById('bcTitle').value.trim();
    const message = document.getElementById('bcMessage').value.trim();
    if (!message) { toast('Write the announcement message.', true); return; }
    const sms = document.getElementById('bcSms').checked;
    const email = document.getElementById('bcEmail').checked;
    if (!await confirmDialog(`Send this to EVERY user account${sms ? ' + SMS' : ''}${email ? ' + email' : ''}?\n\n"${title || 'Announcement'}: ${message}"`)) return;
    const btn = document.getElementById('bcSendBtn');
    btn.disabled = true;
    try {
      const r = await api('/push/broadcast', { method: 'POST', body: { title, message, sms, email } });
      document.getElementById('bcResult').textContent =
        `Sent to ${r.accounts} accounts — ${r.pushSent} push notification(s)` +
        (sms ? `, ${r.smsSent} SMS` : '') + (email ? `, ${r.mailSent} email(s)` : '') + '.';
      document.getElementById('bcTitle').value = '';
      document.getElementById('bcMessage').value = '';
      toast('Announcement sent.');
      load(); // it lands in your own inbox too — instant proof it went out
    } catch (e) { toast(e.message, true); }
    btn.disabled = false;
  });
}

requireAuthAndRenderShell('/notifications.html').then(u => { me = u; load(); offerPush(); initBroadcast(); });
