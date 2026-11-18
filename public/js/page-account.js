    let currentUser;
    let isStaffManager = false; // sees every account's sign-ins/activity + the Notifications tab

    async function loadLogs() {
      const logs = await api(isStaffManager ? '/auth/login-logs' : '/auth/my-login-logs');
      document.getElementById('logRows').innerHTML = logs.length ? logs.map(l => `
        <tr>
          ${isStaffManager ? `<td>${esc(l.email) || '—'}</td>` : ''}
          <td class="mono" style="white-space:nowrap;">${new Date(l.createdAt).toLocaleString('en-GB')}</td>
          <td><span class="badge ${l.success ? 'badge-info' : 'badge-critical'}">${l.success ? 'Success' : esc(l.reason)}</span></td>
          <td class="mono">${esc(l.ip) || '—'}</td>
          <td class="sub" style="max-width:300px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(l.userAgent) || '—'}</td>
        </tr>`).join('') : `<tr><td colspan="${isStaffManager ? 5 : 4}" class="sub">No sign-ins recorded yet.</td></tr>`;
    }

    async function loadActivity() {
      const logs = await api(isStaffManager ? '/auth/activity-logs' : '/auth/my-activity');
      document.getElementById('activityRows').innerHTML = logs.length ? logs.map(l => `
        <tr>
          ${isStaffManager ? `<td>${esc(l.userName)}</td>` : ''}
          <td class="mono" style="white-space:nowrap;">${new Date(l.createdAt).toLocaleString('en-GB')}</td>
          <td>${esc(l.action)}${l.entityLabel ? ` <span class="sub">— ${esc(l.entityLabel)}</span>` : ''}</td>
          <td class="sub">${esc(l.detail) || '—'}</td>
        </tr>`).join('') : `<tr><td colspan="${isStaffManager ? 4 : 3}" class="sub">No activity recorded yet.</td></tr>`;
    }

    const NOTIF_BADGE = { error: 'badge-critical', warning: 'badge-attention', info: 'badge-idle' };

    async function loadNotifications() {
      if (!isStaffManager) return;
      const notes = await api('/auth/notifications');
      document.getElementById('notificationRows').innerHTML = notes.length ? notes.map(n => `
        <tr>
          <td class="mono" style="white-space:nowrap;">${new Date(n.createdAt).toLocaleString('en-GB')}</td>
          <td><span class="badge ${NOTIF_BADGE[n.level] || 'badge-idle'}" style="text-transform:capitalize;">${esc(n.source)}</span></td>
          <td>${esc(n.message)}</td>
        </tr>`).join('') : `<tr><td colspan="3" class="sub">No notifications yet.</td></tr>`;
    }

    document.getElementById('markNotifsReadBtn').addEventListener('click', async () => {
      try {
        await api('/auth/notifications/mark-read', { method: 'POST' });
        toast('Notifications marked as read.');
        loadNotifications();
      } catch (e) { toast(e.message, true); }
    });

    // ---- Top tabs: Security (password/2FA/passkeys) vs Sign-in & activity ----
    document.getElementById('accountTopTabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      const tab = btn.dataset.tab;
      document.querySelectorAll('#accountTopTabs button').forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById('securityPanel').style.display = tab === 'security' ? '' : 'none';
      document.getElementById('activityWrap').style.display = tab === 'activity' ? '' : 'none';
    });

    // ---- Sub-tabs: Sign-in logs / Account activities / Notifications ----
    const ACCOUNT_TAB_LOADERS = { signins: loadLogs, activity: loadActivity, notifications: loadNotifications };
    document.getElementById('accountSubtabs').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      const tab = btn.dataset.tab;
      document.querySelectorAll('#accountSubtabs button').forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById('signinsPanel').style.display = tab === 'signins' ? '' : 'none';
      document.getElementById('activityPanel').style.display = tab === 'activity' ? '' : 'none';
      document.getElementById('notificationsPanel').style.display = tab === 'notifications' ? '' : 'none';
      const titles = { signins: 'Sign-in logs', activity: 'Account activities', notifications: 'Notifications' };
      document.getElementById('activitySectionTitle').textContent = titles[tab];
      (ACCOUNT_TAB_LOADERS[tab] || (() => {}))();
    });

    // ---- Profile (name / email / phone) ----
    let profilePendingToken = null;

    function fillProfileForm() {
      document.getElementById('profileName').value = currentUser.name || '';
      document.getElementById('profileEmail').value = currentUser.email || '';
      document.getElementById('profilePhone').value = currentUser.phone || '';
    }

    function applyUpdatedUser(updated) {
      currentUser.name = updated.name;
      currentUser.email = updated.email;
      currentUser.phone = updated.phone;
      currentUser.hasPhone = !!updated.phone;
      toast('Profile updated.');
      render2faState();
    }

    document.getElementById('profileForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const result = await api('/auth/me', {
          method: 'PUT',
          body: {
            name: document.getElementById('profileName').value,
            email: document.getElementById('profileEmail').value,
            phone: document.getElementById('profilePhone').value,
            currentPassword: document.getElementById('profileCurrentPassword').value,
          },
        });
        if (result.confirmationRequired) {
          // The seed admin's email/phone change needs a live 2FA code before
          // it lands — see PUT /auth/me. Everyone else's changes apply
          // immediately and never reach this branch.
          profilePendingToken = result.pendingToken;
          document.getElementById('profileConfirmMsg').textContent = result.method === 'totp'
            ? 'This account\'s email/phone change needs confirming with your authenticator app.'
            : `We sent a confirmation code to ${result.sentTo}. Enter it below to apply the change.`;
          document.getElementById('profileConfirmLabel').textContent = result.method === 'totp'
            ? 'Enter the 6-digit code from your authenticator app'
            : 'Enter the code we just sent';
          document.getElementById('profileConfirmCode').value = '';
          document.getElementById('profileConfirmBackupWrap').style.display = 'none';
          document.getElementById('profileConfirmForm').style.display = 'block';
          document.getElementById('profileConfirmCode').focus();
        } else {
          applyUpdatedUser(result);
        }
      } catch (e) { toast(e.message, true); }
      document.getElementById('profileCurrentPassword').value = '';
    });

    document.getElementById('profileConfirmBackupLink').addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById('profileConfirmBackupWrap').style.display = 'block';
      document.getElementById('profileConfirmBackupCode').focus();
    });

    document.getElementById('profileConfirmCancelBtn').addEventListener('click', () => {
      profilePendingToken = null;
      document.getElementById('profileConfirmForm').style.display = 'none';
    });

    document.getElementById('profileConfirmForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const body = { pendingToken: profilePendingToken };
        const backupCode = document.getElementById('profileConfirmBackupCode').value.trim();
        if (backupCode) body.backupCode = backupCode;
        else body.code = document.getElementById('profileConfirmCode').value.trim();
        const updated = await api('/auth/me/confirm', { method: 'POST', body });
        document.getElementById('profileConfirmForm').style.display = 'none';
        profilePendingToken = null;
        applyUpdatedUser(updated);
      } catch (e) { toast(e.message, true); }
    });

    wirePasswordMeter(document.getElementById('newPassword'), document.getElementById('pwMeter'));

    document.getElementById('pwForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/auth/change-password', {
          method: 'POST',
          body: {
            currentPassword: document.getElementById('currentPassword').value,
            newPassword: document.getElementById('newPassword').value,
          },
        });
        toast('Password updated.');
        document.getElementById('pwForm').reset();
        document.getElementById('pwMeter').innerHTML = passwordChecklistHtml('');
      } catch (e) {
        toast(e.message + (e.failedRules ? ' — ' + e.failedRules.join(', ') : ''), true);
      }
    });

    const METHOD_LABELS = { totp: 'an authenticator app', email: 'email code', sms: 'SMS code' };

    function render2faState() {
      const m = currentUser.twoFactorMethod || 'email';
      document.getElementById('twoFaMethodLabel').textContent = METHOD_LABELS[m] || m;
      document.getElementById('setup2fa').style.display = 'none';
      // Pre-select the current method so "Switch to" reads as a change, not
      // a fresh choice, and so re-submitting the same method (e.g. just to
      // move to a new phone number) works without re-picking it.
      const currentRadio = document.querySelector(`input[name="twoFaMethod"][value="${m}"]`);
      if (currentRadio) currentRadio.checked = true;
      // SMS needs a phone on file; disable that option + its start button hint.
      const smsRadio = document.querySelector('input[name="twoFaMethod"][value="sms"]');
      if (smsRadio && !currentUser.hasPhone) {
        smsRadio.disabled = true;
        document.getElementById('smsNoPhoneNote').style.display = 'inline';
      } else if (smsRadio) {
        smsRadio.disabled = false;
        document.getElementById('smsNoPhoneNote').style.display = 'none';
      }
    }

    function chosenMethod() {
      const el = document.querySelector('input[name="twoFaMethod"]:checked');
      return el ? el.value : 'totp';
    }

    document.getElementById('start2faBtn').addEventListener('click', async () => {
      const method = chosenMethod();
      const password = document.getElementById('switchMethodPassword').value;
      try {
        const data = await api('/auth/2fa/setup', { method: 'POST', body: { method, password } });
        const isTotp = data.method === 'totp';
        document.getElementById('setupTotp').style.display = isTotp ? 'block' : 'none';
        document.getElementById('setupSent').style.display = isTotp ? 'none' : 'block';
        if (isTotp) {
          document.getElementById('qrImg').src = data.qrCodeDataUrl || '';
          document.getElementById('qrImg').style.display = data.qrCodeDataUrl ? 'block' : 'none';
          document.getElementById('secretText').textContent = 'Manual entry code: ' + data.secret;
          document.getElementById('verifyCodeLabel').textContent = 'Enter the 6-digit code from your app';
        } else {
          document.getElementById('setupSentMsg').textContent = `We sent a test code to ${data.sentTo}. Enter it below to confirm and switch.`;
          document.getElementById('verifyCodeLabel').textContent = 'Enter the code we just sent';
        }
        document.getElementById('setup2fa').style.display = 'block';
        document.getElementById('verifyCode').focus();
      } catch (e) { toast(e.message, true); }
    });

    document.getElementById('verify2faBtn').addEventListener('click', async () => {
      const code = document.getElementById('verifyCode').value;
      try {
        const data = await api('/auth/2fa/enable', { method: 'POST', body: { token: code } });
        toast('Verification method updated.');
        currentUser.twoFactorEnabled = true;
        currentUser.twoFactorMethod = data.method;
        document.getElementById('switchMethodPassword').value = '';
        render2faState();
        document.getElementById('backupCodesList').innerHTML = data.backupCodes.join('<br>');
        document.getElementById('backupCodes').style.display = 'block';
      } catch (e) { toast(e.message, true); }
    });

    // ---- Passkeys (Face ID / fingerprint) ----
    const wa = window.SimpleWebAuthnBrowser;

    function renderPasskeys() {
      const list = document.getElementById('passkeyList');
      const keys = currentUser.passkeys || [];
      if (!keys.length) {
        list.innerHTML = '<p class="sub" style="margin:0;">No devices set up yet.</p>';
        return;
      }
      list.innerHTML = keys.map(p => {
        const added = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '';
        const used = p.lastUsedAt ? `last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : 'not used yet';
        return `<div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 0; border-top:1px solid var(--rule);">
          <span><strong>${esc(p.deviceName || 'Device')}</strong><br><span class="sub" style="font-size:12px;">Added ${added} · ${used}</span></span>
          <button class="btn btn-secondary btn-sm" type="button" data-passkey-id="${esc(p.id)}">Remove</button>
        </div>`;
      }).join('');
      list.querySelectorAll('[data-passkey-id]').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-passkey-id');
          try {
            await api('/auth/passkey/' + encodeURIComponent(id), { method: 'DELETE' });
            currentUser.passkeys = (currentUser.passkeys || []).filter(p => p.id !== id);
            renderPasskeys();
            toast('Device removed.');
          } catch (e) { toast(e.message, true); }
        });
      });
    }

    function initPasskeys() {
      if (!wa || !wa.browserSupportsWebAuthn()) {
        document.getElementById('passkeyUnsupported').style.display = 'block';
        return;
      }
      document.getElementById('passkeySupported').style.display = 'block';
      renderPasskeys();
    }

    document.getElementById('addPasskeyBtn').addEventListener('click', async () => {
      const btn = document.getElementById('addPasskeyBtn');
      btn.disabled = true;
      try {
        const options = await api('/auth/passkey/register/options', { method: 'POST' });
        const attResp = await wa.startRegistration({ optionsJSON: options });
        const deviceName = (navigator.platform || 'This device');
        const res = await api('/auth/passkey/register/verify', { method: 'POST', body: { attResp, deviceName } });
        currentUser.passkeys = (currentUser.passkeys || []).concat(res.passkey);
        renderPasskeys();
        toast('This device is set up. You can now sign in with Face ID / fingerprint.');
      } catch (e) {
        if (e && (e.name === 'NotAllowedError' || e.name === 'AbortError')) { btn.disabled = false; return; }
        toast(e.message || 'Could not set up this device.', true);
      }
      btn.disabled = false;
    });

    // ---- Device push notifications ----
    async function refreshPushCard() {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
        document.getElementById('pushUnsupported').style.display = 'block';
        return;
      }
      document.getElementById('pushSupported').style.display = 'block';
      const status = document.getElementById('pushStatus');
      const enableBtn = document.getElementById('enablePushBtn');
      const testBtn = document.getElementById('testPushBtn');
      const disableBtn = document.getElementById('disablePushBtn');
      let sub = null;
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        sub = reg && await reg.pushManager.getSubscription();
      } catch (e) {}
      const on = Notification.permission === 'granted' && !!sub;
      enableBtn.style.display = on ? 'none' : '';
      testBtn.style.display = on ? '' : 'none';
      disableBtn.style.display = on ? '' : 'none';
      status.textContent = on
        ? 'Notifications are ON for this device.'
        : (Notification.permission === 'denied'
          ? 'Notifications are blocked in your browser settings for this site — allow them there, then try again.'
          : '');
    }
    document.getElementById('enablePushBtn').addEventListener('click', async () => {
      const btn = document.getElementById('enablePushBtn');
      btn.disabled = true;
      try {
        await enablePushOnThisDevice();
        toast('Notifications are on for this device.');
      } catch (e) { toast(e.message, true); }
      btn.disabled = false;
      refreshPushCard();
    });
    document.getElementById('testPushBtn').addEventListener('click', async () => {
      try {
        const r = await api('/push/test', { method: 'POST' });
        toast(r.sent ? 'Test notification sent — check your notifications.' : 'No registered device found — try turning notifications off and on again.', !r.sent);
      } catch (e) { toast(e.message, true); }
    });
    document.getElementById('disablePushBtn').addEventListener('click', async () => {
      try {
        await disablePushOnThisDevice();
        toast('Notifications turned off on this device.');
      } catch (e) { toast(e.message, true); }
      refreshPushCard();
    });

    (async () => {
      currentUser = await requireAuthAndRenderShell('/account.html');
      if (!currentUser) return;
      isStaffManager = hasPermission(currentUser, 'staff.manage');
      document.getElementById('notifTabBtn').style.display = isStaffManager ? '' : 'none';
      document.getElementById('signinsUserCol').style.display = isStaffManager ? '' : 'none';
      document.getElementById('activityUserCol').style.display = isStaffManager ? '' : 'none';
      fillProfileForm();
      render2faState();
      initPasskeys();
      refreshPushCard();
      loadLogs();
    })();
