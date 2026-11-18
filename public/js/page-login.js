    document.getElementById('footerYear').textContent = new Date().getFullYear();

    // ---- Oct 2026 polish ----
    // Greeting by the time of day; Caps Lock warning; a working state on
    // every submit button so a slow network never looks like nothing happened.
    (function () {
      const h = new Date().getHours();
      const t = document.getElementById('lcTitle');
      if (t) t.textContent = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
      const pw = document.getElementById('password'), caps = document.getElementById('capsNote');
      const capsCheck = e => { if (caps && e.getModifierState) caps.hidden = !e.getModifierState('CapsLock'); };
      if (pw) { pw.addEventListener('keydown', capsCheck); pw.addEventListener('keyup', capsCheck); pw.addEventListener('blur', () => { if (caps) caps.hidden = true; }); }
      // Backup codes have letters and a dash; switch the keyboard for them.
      const code = document.getElementById('twoFaCode'), useBackup = document.getElementById('useBackupLink');
      if (useBackup && code) useBackup.addEventListener('click', () => {
        const backup = code.getAttribute('inputmode') === 'numeric';
        code.setAttribute('inputmode', backup ? 'text' : 'numeric');
        code.placeholder = backup ? 'xxxxx-xxxxx' : '000000';
        code.classList.toggle('is-backup', backup);
        useBackup.textContent = backup ? 'Use the 6-digit code' : 'Use a backup code';
        code.value = ''; code.focus();
      });
    })();
    // Busy state: wraps a form's submit handler so its button spins and can't
    // be pressed twice. The handler's own success/redirect code is unchanged.
    function lcBusyOn(btn, label) { if (!btn || btn.dataset.busy) return; btn.dataset.busy = btn.innerHTML; btn.disabled = true; btn.classList.add('is-busy'); btn.innerHTML = '<span class="lc-spin" aria-hidden="true"></span>' + label; }
    function lcBusyOff(btn) { if (!btn || !btn.dataset.busy) return; btn.innerHTML = btn.dataset.busy; delete btn.dataset.busy; btn.disabled = false; btn.classList.remove('is-busy'); }
    [['loginForm', 'Logging in…'], ['twoFaForm', 'Checking…'], ['mustChangeForm', 'Saving…']].forEach(([id, label]) => {
      const f = document.getElementById(id); if (!f) return;
      const btn = f.querySelector('button[type="submit"]');
      f.addEventListener('submit', () => lcBusyOn(btn, label), true);
    });
    // Turn the spinner off again whenever an error appears, or the next step shows.
    ['error', 'twoFaError', 'mcError'].forEach(id => {
      const el = document.getElementById(id); if (!el) return;
      new MutationObserver(() => { if (el.textContent.trim()) document.querySelectorAll('.lc-submit.is-busy').forEach(lcBusyOff); }).observe(el, { childList: true, characterData: true, subtree: true });
    });
    ['twoFaForm', 'mustChangeForm', 'loginForm'].forEach(id => {
      const el = document.getElementById(id); if (!el) return;
      new MutationObserver(() => document.querySelectorAll('.lc-submit.is-busy').forEach(b => { if (!b.closest('form') || b.closest('form').style.display === 'none') lcBusyOff(b); })).observe(el, { attributes: true, attributeFilter: ['style'] });
    });
    window.addEventListener('pageshow', () => document.querySelectorAll('.lc-submit.is-busy').forEach(lcBusyOff));
    // The lead line follows the step.
    (function () {
      const lead = document.getElementById('lcLead'), title = document.getElementById('lcTitle'); if (!lead) return;
      const first = { t: title.textContent, l: lead.textContent };
      const sync = () => {
        if (document.getElementById('twoFaForm').style.display === 'block') { title.textContent = 'Check it’s you'; lead.textContent = 'One more step to keep the account safe.'; }
        else if (document.getElementById('mustChangeForm').style.display === 'block') { title.textContent = 'Choose a new password'; lead.textContent = 'You’ll use it from now on.'; }
        else { title.textContent = first.t; lead.textContent = first.l; }
      };
      ['twoFaForm', 'mustChangeForm', 'loginForm'].forEach(id => new MutationObserver(sync).observe(document.getElementById(id), { attributes: true, attributeFilter: ['style'] }));
    })();
    let pendingToken = null;
    let rememberMe = false;
    let twoFaMethod = 'totp';

    const wa = window.SimpleWebAuthnBrowser;

    // ---- Biometric / passkey sign-in ----
    // Only offer it where the browser can actually do WebAuthn. The button
    // triggers Face ID / fingerprint via a discoverable passkey — no email
    // typed. If the user has no passkey on this device the browser just shows
    // "no passkeys" and we fall back to the password form silently.
    if (wa && wa.browserSupportsWebAuthn()) {
      document.getElementById('biometricRow').style.display = 'block';
    }

    document.getElementById('biometricBtn').addEventListener('click', async () => {
      const errEl = document.getElementById('biometricError');
      errEl.textContent = '';
      const remember = document.getElementById('rememberMe').checked;
      try {
        const options = await api('/auth/passkey/login/options', { method: 'POST', body: { remember } });
        const authResp = await wa.startAuthentication({ optionsJSON: options });
        const result = await api('/auth/passkey/login/verify', { method: 'POST', body: { authResp } });
        if (result.mustChangePassword) {
          rememberMe = remember;
          pendingToken = result.pendingToken;
          document.getElementById('loginForm').style.display = 'none';
          document.getElementById('mustChangeForm').style.display = 'block';
          return;
        }
        window.location.href = '/index.html';
      } catch (err) {
        // A user cancelling the Face ID / fingerprint prompt isn't an error.
        if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) return;
        errEl.textContent = err.message || 'Biometric sign-in didn\'t work. Use your password.';
      }
    });

    // Show the 2FA step, tailored to the account's method. For email/SMS we
    // send a code immediately and adjust the wording; for an authenticator app
    // the code is already in their app.
    async function enterTwoFaStep(method) {
      twoFaMethod = method || 'totp';
      document.getElementById('loginForm').style.display = 'none';
      document.getElementById('mustChangeForm').style.display = 'none';
      document.getElementById('twoFaForm').style.display = 'block';
      const prompt = document.getElementById('twoFaPrompt');
      const resend = document.getElementById('resendOtpLink');
      document.getElementById('twoFaCode').focus();
      if (twoFaMethod === 'email' || twoFaMethod === 'sms') {
        resend.style.display = 'inline';
        prompt.textContent = 'Sending your code…';
        await sendLoginOtp(prompt);
      } else {
        resend.style.display = 'none';
        prompt.textContent = 'Enter the 6-digit code from your authenticator app, or one of your backup codes.';
      }
    }

    async function sendLoginOtp(promptEl) {
      try {
        const r = await api('/auth/login/send-otp', { method: 'POST', body: { pendingToken } });
        promptEl.textContent = `We sent a 6-digit code to ${r.sentTo}. Enter it below, or use a backup code.`;
      } catch (err) {
        promptEl.textContent = err.message || 'Could not send your code. Use a backup code, or go back.';
      }
    }

    document.getElementById('resendOtpLink').addEventListener('click', async () => {
      const prompt = document.getElementById('twoFaPrompt');
      prompt.textContent = 'Resending…';
      await sendLoginOtp(prompt);
    });

    document.getElementById('loginForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('email').value;
      const password = document.getElementById('password').value;
      rememberMe = document.getElementById('rememberMe').checked;
      const errEl = document.getElementById('error');
      errEl.textContent = '';
      try {
        const result = await api('/auth/login', { method: 'POST', body: { email, password, remember: rememberMe } });
        if (result.mustChangePassword) {
          pendingToken = result.pendingToken;
          document.getElementById('loginForm').style.display = 'none';
          document.getElementById('mustChangeForm').style.display = 'block';
          return;
        }
        if (result.twoFactorRequired) {
          pendingToken = result.pendingToken;
          await enterTwoFaStep(result.method);
          return;
        }
        window.location.href = '/index.html';
      } catch (err) {
        errEl.textContent = err.message;
      }
    });

    wirePasswordMeter(document.getElementById('mcNewPassword'), document.getElementById('mcPwMeter'));

    document.getElementById('mustChangeForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('mcError');
      errEl.textContent = '';
      const newPassword = document.getElementById('mcNewPassword').value;
      const confirmPassword = document.getElementById('mcConfirmPassword').value;
      if (newPassword !== confirmPassword) {
        errEl.textContent = 'Passwords do not match.';
        return;
      }
      try {
        const result = await api('/auth/login/complete-password-change', {
          method: 'POST', body: { pendingToken, newPassword },
        });
        if (result.twoFactorRequired) {
          pendingToken = result.pendingToken;
          await enterTwoFaStep(result.method);
          return;
        }
        window.location.href = '/index.html';
      } catch (err) {
        errEl.textContent = err.message + (err.failedRules ? ' — ' + err.failedRules.join(', ') : '');
      }
    });

    document.getElementById('twoFaForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const codeInput = document.getElementById('twoFaCode').value.trim();
      const errEl = document.getElementById('twoFaError');
      errEl.textContent = '';
      try {
        const body = { pendingToken };
        if (/^\d{6}$/.test(codeInput)) body.code = codeInput; else body.backupCode = codeInput;
        await api('/auth/login/verify-2fa', { method: 'POST', body });
        window.location.href = '/index.html';
      } catch (err) {
        errEl.textContent = err.message;
      }
    });

    document.getElementById('backToLoginLink').addEventListener('click', () => {
      pendingToken = null;
      document.getElementById('twoFaForm').style.display = 'none';
      document.getElementById('loginForm').style.display = 'block';
    });

    document.getElementById('forgotPasswordLink').addEventListener('click', () => {
      document.getElementById('forgotPasswordOverlay').style.display = 'flex';
    });
    document.getElementById('fpCancelBtn').addEventListener('click', () => document.getElementById('forgotPasswordOverlay').style.display = 'none');
    document.getElementById('forgotPasswordForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const result = await api('/auth/forgot-password', { method: 'POST', body: { email: document.getElementById('fpEmail').value } });
        toast(result.message);
        document.getElementById('forgotPasswordOverlay').style.display = 'none';
      } catch (err) { toast(err.message, true); }
    });

    document.getElementById('forgotEmailLink').addEventListener('click', () => {
      document.getElementById('forgotEmailOverlay').style.display = 'flex';
    });
    document.getElementById('feCancelBtn').addEventListener('click', () => document.getElementById('forgotEmailOverlay').style.display = 'none');
    document.getElementById('forgotEmailForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const result = await api('/auth/forgot-email', {
          method: 'POST',
          body: { name: document.getElementById('feName').value, phone: document.getElementById('fePhone').value },
        });
        toast(result.message);
        document.getElementById('forgotEmailOverlay').style.display = 'none';
      } catch (err) { toast(err.message, true); }
    });
