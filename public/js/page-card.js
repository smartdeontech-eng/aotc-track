// Personal member card page (public, no login). Reads the card token from the
// URL (?t=…), fetches the member's details + QR from the public endpoint, and
// renders a card the member can show at check-in or save to their home screen.
(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const params = new URLSearchParams(location.search);
  const token = (params.get('t') || '').trim();
  const card = document.getElementById('mcard');

  function showError(msg) {
    card.innerHTML = `<div class="mcard-body"><p class="err">${esc(msg)}</p></div>`;
  }

  if (!token) { showError('This link is missing its card code. Ask your committee or group head to re-share your card link.'); return; }

  fetch('/api/checkin/card?t=' + encodeURIComponent(token), { credentials: 'same-origin' })
    .then(async res => {
      if (!res.ok) {
        let msg = 'Card not found.';
        try { msg = (await res.json()).error || msg; } catch (e) {}
        throw new Error(msg);
      }
      return res.json();
    })
    .then(d => {
      card.innerHTML = `
        <div class="mcard-head">
          <img src="/img/logo.png" alt="PCG crest" onerror="this.style.display='none'">
          <div class="org">PCG — Adabraka Official Town Congregation</div>
        </div>
        <div class="mcard-body">
          <div class="name">${esc(d.name)}</div>
          <div class="pos">${esc(d.position || 'Member')}</div>
          ${d.entityName ? `<div class="entity">${esc(d.entityName)}</div>` : ''}
          ${d.qr ? `<img class="qr" src="${esc(d.qr)}" alt="Your check-in QR code">`
                 : `<p class="err">QR code unavailable — you can still check in with your number below.</p>`}
          ${d.memberNo ? `<div class="no">Member No. <b>${esc(d.memberNo)}</b></div>` : ''}
          <div class="hint">Show this at check-in, or add it to your home screen:<br>
            tap your browser’s Share button, then “Add to Home Screen”.</div>
        </div>`;
      document.title = `${d.name} — Member Card`;
    })
    .catch(e => showError(e.message));
})();
