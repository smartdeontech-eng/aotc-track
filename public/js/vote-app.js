// Elections — the voter's screens, online (/v/<election>) and at a polling
// booth (/booth/<token>). No login: the voter proves who they are with their
// phone number and the 6-digit code sent to it by SMS (plus date of birth or
// member number when the election asks for it).
//
// Flow: phone -> code -> "Welcome, <name>" (-> second check) -> ballot ->
// review -> cast -> thank you. A booth clears itself for the next person.
(function () {
  'use strict';
  const MODE = document.body.dataset.mode; // 'online' | 'booth'
  const parts = location.pathname.split('/').filter(Boolean);
  const KEY = parts[1] || new URLSearchParams(location.search).get('e') || new URLSearchParams(location.search).get('b') || '';
  const main = document.getElementById('vMain');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const initials = n => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  const fmtDT = iso => iso ? new Date(iso).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true }) : '';
  const fmtT = iso => iso ? new Date(iso).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }) : '';

  let info = null, slug = null, boothKey = null, boothName = '';
  let st = {}; // the current voter: { phone, token, name, needs, ballot, choices }
  let idle = null;

  const storeKey = `aotc-booth:${KEY}`;
  function getStored() { try { return sessionStorage.getItem(storeKey) || localStorage.getItem(storeKey); } catch (e) { return null; } }
  function setStored(v) { try { if (v) { sessionStorage.setItem(storeKey, v); localStorage.setItem(storeKey, v); } else { sessionStorage.removeItem(storeKey); localStorage.removeItem(storeKey); } } catch (e) {} }

  async function call(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (boothKey) headers['X-Booth-Key'] = boothKey;
    const r = await fetch('/api/vote' + url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
    let data = {};
    try { data = await r.json(); } catch (e) {}
    if (!r.ok) { const err = new Error(data.error || 'Something went wrong. Please try again.'); err.status = r.status; throw err; }
    return data;
  }
  function err(msg) { return msg ? `<div class="vote-err">${esc(msg)}</div>` : ''; }

  // Booths reset after 3 idle minutes so an unfinished ballot never sits on screen.
  function touch() {
    if (MODE !== 'booth') return;
    clearTimeout(idle);
    idle = setTimeout(() => { if (st.token || st.phone) screenPhone('The last voter did not finish, so the screen was cleared.'); }, 180000);
  }
  ['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, touch, { passive: true }));

  // ------------------------------------------------------------ start
  async function start() {
    try {
      if (MODE === 'booth') {
        const b = await call('GET', `/booth/${encodeURIComponent(KEY)}`);
        info = b.election; boothName = b.booth.name; slug = info.slug;
        document.getElementById('vBooth').textContent = boothName;
        boothKey = getStored();
      } else {
        info = await call('GET', `/e/${encodeURIComponent(KEY)}`);
        slug = info.slug;
      }
    } catch (e) {
      main.innerHTML = `<h2>Not available</h2><p class="vote-muted">${esc(e.message)}</p>`;
      return;
    }
    document.getElementById('vTitle').textContent = info.title;
    document.getElementById('vSub').textContent = [info.entityName, info.closeAt ? `Polls close ${fmtDT(info.closeAt)}` : ''].filter(Boolean).join(' · ');
    document.title = `${info.title} — vote`;
    if (MODE === 'booth' && !boothKey) return screenPin();
    if (info.status !== 'open') return screenClosed();
    screenPhone();
  }

  function screenClosed() {
    const s = info.status;
    main.innerHTML = s === 'confirmed'
      ? `<h2>Polls are not open yet</h2><p class="vote-muted">Voting opens <b>${esc(fmtDT(info.openAt))}</b>. Your code will come by SMS when polls open.</p>
         <button class="vote-btn secondary" id="vRe">Check again</button>`
      : `<h2>Polls are closed</h2><p class="vote-muted">Voting for this election has ended. Thank you.</p>`;
    const re = document.getElementById('vRe'); if (re) re.onclick = () => location.reload();
  }

  // ------------------------------------------------------------ booth PIN
  function screenPin(msg) {
    main.innerHTML = `<h2>Unlock this booth</h2>
      <p class="vote-muted">For the election officer: enter the booth PIN once. The booth then stays ready for voters for the rest of the day.</p>
      ${err(msg)}
      <form id="vf"><div class="vote-field"><label>Booth PIN</label><input id="vPin" class="vote-code" inputmode="numeric" maxlength="6" autocomplete="off" autofocus></div>
      <button class="vote-btn" type="submit">Unlock</button></form>`;
    document.getElementById('vf').onsubmit = async e => {
      e.preventDefault();
      try {
        const r = await call('POST', `/booth/${encodeURIComponent(KEY)}/unlock`, { pin: document.getElementById('vPin').value });
        boothKey = r.key; setStored(r.key);
        if (info.status !== 'open') return screenClosed();
        screenPhone();
      } catch (ex) { screenPin(ex.message); }
    };
  }

  // ------------------------------------------------------------ phone, then code
  function screenPhone(msg) {
    st = {};
    main.innerHTML = `<h2>${MODE === 'booth' ? 'Welcome — ready to vote' : 'Cast your vote'}</h2>
      <p class="vote-muted">Enter the phone number your voting code was sent to.</p>
      ${err(msg)}
      <form id="vf"><div class="vote-field"><label>Phone number</label><input id="vPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="e.g. 0244123456" autofocus></div>
      <button class="vote-btn" type="submit">Next</button></form>
      ${MODE === 'booth' ? '<p class="vote-muted" style="text-align:center; margin:14px 0 0;">No phone with you? See the polling officer.</p>' : ''}`;
    const input = document.getElementById('vPhone'); setTimeout(() => input.focus(), 50);
    document.getElementById('vf').onsubmit = e => {
      e.preventDefault();
      const p = input.value.replace(/[^\d+]/g, '');
      if (p.replace(/\D/g, '').length < 9) return screenPhone('Enter the full phone number, e.g. 0244123456.');
      st.phone = p;
      screenCode();
    };
  }
  // A voter without their phone is checked by a polling officer, who releases
  // the ballot to this booth. While the booth shows an empty phone screen it
  // asks every few seconds whether a ballot is waiting for it.
  let asking = false;
  async function checkReleased() {
    const input = document.getElementById('vPhone');
    if (MODE !== 'booth' || !boothKey || asking || !input || input.value || st.token) return;
    asking = true;
    try {
      const r = await call('GET', `/booth/${encodeURIComponent(KEY)}/next`);
      const still = document.getElementById('vPhone');
      if (r.waiting && still && !still.value) {
        st = { token: r.token, name: r.name, ballot: r.ballot, assisted: true };
        screenWelcome();
      }
    } catch (ex) {
      if (ex.status === 423) { setStored(null); boothKey = null; screenPin(ex.message); }
    } finally { asking = false; }
  }
  if (MODE === 'booth') setInterval(checkReleased, 3000);

  function screenCode(msg) {
    main.innerHTML = `<h2>Enter your code</h2>
      <p class="vote-muted">The 6-digit code in the SMS sent to <b>${esc(st.phone)}</b>.</p>
      ${err(msg)}
      <form id="vf"><div class="vote-field"><label>Voting code</label><input id="vCode" class="vote-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" autofocus></div>
      <button class="vote-btn" type="submit">Continue</button>
      <button class="vote-btn secondary" type="button" id="vBack">Use a different number</button></form>`;
    const input = document.getElementById('vCode'); setTimeout(() => input.focus(), 50);
    document.getElementById('vBack').onclick = () => screenPhone();
    document.getElementById('vf').onsubmit = async e => {
      e.preventDefault();
      const code = input.value.replace(/\D/g, '');
      if (code.length !== 6) return screenCode('The code has 6 digits.');
      try {
        const r = await call('POST', `/e/${slug}/verify`, { phone: st.phone, code });
        Object.assign(st, r);
        if (r.needs && r.needs.length) return screenSecond();
        screenWelcome();
      } catch (ex) {
        if (ex.status === 423 && MODE === 'booth' && /booth/i.test(ex.message)) { setStored(null); boothKey = null; return screenPin(ex.message); }
        if (ex.status === 403) { info.status = 'closed'; return screenClosed(); }
        if ([404, 409].includes(ex.status) || /locked/i.test(ex.message)) return screenPhone(ex.message);
        screenCode(ex.message);
      }
    };
  }

  // ------------------------------------------------------------ second check
  // Day / month / year boxes rather than a date picker: quicker on any phone,
  // and nobody has to scroll back decades on a calendar.
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function dobValue() {
    const d = Number(document.getElementById('vDobD').value), m = Number(document.getElementById('vDobM').value), y = Number(document.getElementById('vDobY').value);
    if (!d || !m || !y || y < 1900 || y > new Date().getFullYear() || d > 31) return '';
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCDate() !== d) return '';
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  function screenSecond(msg) {
    const needDob = st.needs.includes('dob'), needNo = st.needs.includes('memberNo');
    main.innerHTML = `<div class="vote-hello">Welcome, ${esc(st.name)}</div>
      <p class="vote-muted">One more check, so we know it is really you.</p>
      ${err(msg)}
      <form id="vf">
        ${needDob ? `<div class="vote-field"><label>Your date of birth</label><div class="vote-dob">
          <input id="vDobD" inputmode="numeric" maxlength="2" placeholder="Day" aria-label="Day" required>
          <select id="vDobM" aria-label="Month" required><option value="">Month</option>${MONTHS.map((m, i) => `<option value="${i + 1}">${m}</option>`).join('')}</select>
          <input id="vDobY" inputmode="numeric" maxlength="4" placeholder="Year" aria-label="Year" required></div></div>` : ''}
        ${needNo ? '<div class="vote-field"><label>Your member number</label><input id="vNo" inputmode="numeric" required></div>' : ''}
        <button class="vote-btn" type="submit">Continue</button>
        <button class="vote-btn secondary" type="button" id="vBack">This is not me</button>
      </form>`;
    document.getElementById('vBack').onclick = () => screenPhone();
    document.getElementById('vf').onsubmit = async e => {
      e.preventDefault();
      if (needDob && !dobValue()) return screenSecond('Enter your full date of birth: day, month and year (e.g. 14 March 1999).');
      try {
        const r = await call('POST', `/e/${slug}/confirm`, { token: st.token, dob: needDob ? dobValue() : undefined, memberNo: needNo ? document.getElementById('vNo').value : undefined });
        st.ballot = r.ballot;
        screenWelcome();
      } catch (ex) {
        if (ex.status === 410 || /officer/.test(ex.message)) return screenPhone(ex.message);
        screenSecond(ex.message);
      }
    };
  }

  // ------------------------------------------------------------ ballot
  function screenWelcome() {
    st.choices = {};
    st.ballot.forEach(p => { st.choices[p.id] = p.mode === 'pick' ? [] : {}; });
    screenBallot();
  }
  function ph(c, cls) { return c.photo ? `<img class="${cls}" src="${esc(c.photo)}" alt="">` : `<span class="${cls}">${esc(initials(c.name))}</span>`; }
  function screenBallot(msg) {
    main.innerHTML = `<div class="vote-hello">${esc(st.name)}</div>
      ${st.assisted ? '<p class="vote-muted" style="margin:0 0 4px;">Your details were checked by the polling officer.</p>' : ''}
      <p class="vote-muted">Make your choices, then review them before casting. You may leave a position blank.</p>
      ${err(msg)}
      ${st.ballot.map(p => {
        if (p.mode === 'pick') {
          const n = st.choices[p.id].length;
          return `<section class="vote-pos"><div class="vote-pos-title">${esc(p.title)}</div>
            <div class="vote-pos-hint">${p.seats > 1 ? `Choose up to ${p.seats}` : 'Choose one'} · ${n} chosen</div>
            <div class="vote-opts">${p.candidates.map(c => `<div class="vote-opt ${st.choices[p.id].includes(c.id) ? 'on' : ''}" data-pid="${p.id}" data-cid="${c.id}" role="button" tabindex="0">${ph(c, 'vote-ph')}<div class="vote-opt-name">${esc(c.name)}</div></div>`).join('')}</div></section>`;
        }
        return `<section class="vote-pos"><div class="vote-pos-title">${esc(p.title)}</div>
          <div class="vote-pos-hint">Unopposed — do you endorse ${p.candidates.length > 1 ? 'each candidate' : 'the candidate'}?</div>
          ${p.candidates.map(c => { const v = st.choices[p.id][c.id]; return `<div class="vote-yn">${ph(c, 'vote-ph')}<div class="vote-yn-name">${esc(c.name)}</div>
            <button type="button" class="yes ${v === 'yes' ? 'on' : ''}" data-pid="${p.id}" data-cid="${c.id}" data-yn="yes">Yes</button>
            <button type="button" class="no ${v === 'no' ? 'on' : ''}" data-pid="${p.id}" data-cid="${c.id}" data-yn="no">No</button></div>`; }).join('')}</section>`;
      }).join('')}
      <button class="vote-btn" id="vReview">Review my vote</button>`;
    main.querySelectorAll('.vote-opt').forEach(el => {
      const toggle = () => {
        const p = st.ballot.find(x => x.id === Number(el.dataset.pid)); const cid = Number(el.dataset.cid);
        const list = st.choices[p.id];
        const i = list.indexOf(cid);
        if (i >= 0) list.splice(i, 1);
        else if (p.seats === 1) { list.length = 0; list.push(cid); }
        else if (list.length < p.seats) list.push(cid);
        else return screenBallot(`${p.title}: you have already chosen ${p.seats}. Untick one first.`);
        const y = window.scrollY; screenBallot(); window.scrollTo(0, y);
      };
      el.onclick = toggle;
      el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
    });
    main.querySelectorAll('.vote-yn button').forEach(b => {
      b.onclick = () => {
        const m = st.choices[Number(b.dataset.pid)];
        m[b.dataset.cid] = m[b.dataset.cid] === b.dataset.yn ? undefined : b.dataset.yn;
        const y = window.scrollY; screenBallot(); window.scrollTo(0, y);
      };
    });
    document.getElementById('vReview').onclick = screenReview;
  }
  function screenReview() {
    const lines = st.ballot.map(p => {
      let txt;
      if (p.mode === 'pick') {
        const names = st.choices[p.id].map(id => (p.candidates.find(c => c.id === id) || {}).name);
        txt = names.length ? names.map(esc).join(', ') : '<i>left blank</i>';
      } else {
        txt = p.candidates.map(c => `${esc(c.name)}: ${st.choices[p.id][c.id] ? `<b>${st.choices[p.id][c.id] === 'yes' ? 'Yes' : 'No'}</b>` : '<i>blank</i>'}`).join('; ');
      }
      return `<li><b>${esc(p.title)}:</b> ${txt}</li>`;
    }).join('');
    main.innerHTML = `<h2>Check your vote</h2><p class="vote-muted">Once cast, a vote cannot be changed.</p>
      <ul class="vote-review">${lines}</ul>
      <button class="vote-btn green" id="vCast">Cast my vote</button>
      <button class="vote-btn secondary" id="vEdit">Change my choices</button>`;
    document.getElementById('vEdit').onclick = () => screenBallot();
    document.getElementById('vCast').onclick = async e => {
      e.target.disabled = true; e.target.textContent = 'Casting…';
      const choices = {};
      st.ballot.forEach(p => {
        if (p.mode === 'pick') choices[p.id] = st.choices[p.id];
        else { const o = {}; Object.entries(st.choices[p.id]).forEach(([k, v]) => { if (v) o[k] = v; }); choices[p.id] = o; }
      });
      try {
        await call('POST', `/e/${slug}/cast`, { token: st.token, choices });
        screenDone();
      } catch (ex) {
        if ([403, 409, 410, 423].includes(ex.status)) { if (ex.status === 403) info.status = 'closed'; return screenEnd(ex.message); }
        screenBallot(ex.message);
      }
    };
  }
  function screenEnd(msg) {
    main.innerHTML = `<h2>Not counted</h2>${err(msg)}`;
    if (MODE === 'booth') setTimeout(() => screenPhone(), 8000);
  }
  function screenDone() {
    const name = st.name; st = {};
    main.innerHTML = `<div class="vote-done"><div class="tick">✓</div><h2>Thank you${name ? `, ${esc(name.split(' ')[0])}` : ''}</h2>
      <p class="vote-muted">Your vote has been counted at ${esc(fmtT(new Date().toISOString()))}.</p>
      ${MODE === 'booth' ? '<p class="vote-muted">This screen clears for the next voter in a few seconds.</p>' : ''}</div>`;
    if (MODE === 'booth') setTimeout(() => screenPhone(), 6000);
  }

  start();
})();
