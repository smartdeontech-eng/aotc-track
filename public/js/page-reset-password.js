    const params = new URLSearchParams(location.search);
    const id = params.get('id');
    const token = params.get('token');

    wirePasswordMeter(document.getElementById('newPassword'), document.getElementById('pwMeter'));

    document.getElementById('resetForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.getElementById('error');
      errEl.textContent = '';
      const newPassword = document.getElementById('newPassword').value;
      const confirmPassword = document.getElementById('confirmPassword').value;
      if (newPassword !== confirmPassword) {
        errEl.textContent = 'Passwords do not match.';
        return;
      }
      if (!id || !token) {
        errEl.textContent = 'This reset link is invalid. Please request a new one from the login page.';
        return;
      }
      try {
        await api('/auth/reset-password', { method: 'POST', body: { id, token, newPassword } });
        document.getElementById('resetForm').style.display = 'none';
        document.getElementById('successMsg').style.display = 'block';
      } catch (err) {
        errEl.textContent = err.message + (err.failedRules ? ' — ' + err.failedRules.join(', ') : '');
      }
    });
