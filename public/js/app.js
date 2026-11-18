// What counts as a phone: a narrow screen, or a phone turned on its side (a
// short, touch screen) — the same query in the CSS (Oct 2026). Without the
// second half a phone in landscape got the computer layout, and the sidebar
// left too little room.
const PHONE_MQ = '(max-width: 820px), (max-height: 520px) and (pointer: coarse) and (orientation: landscape)';
window.DEONTECH_GLASS = Object.assign({ phone: PHONE_MQ }, window.DEONTECH_GLASS || {});
// Shared helpers used across all pages.

// ---- Keyboard-safe viewport (mobile) ----
// The on-screen keyboard shrinks the *visual* viewport but not the layout
// viewport, so a position:fixed modal keeps its full height and its lower half
// (inputs + Save button) ends up hidden behind the keyboard. We publish the
// live visible height as --app-vvh so the mobile CSS can size the modal overlay
// to it, and scroll whatever field just got focused into the visible area.
(function initKeyboardSafeViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const setVVH = () => {
    document.documentElement.style.setProperty('--app-vvh', vv.height + 'px');
  };
  setVVH();
  vv.addEventListener('resize', setVVH);
  vv.addEventListener('scroll', setVVH);
  // When a field gains focus, wait for the keyboard to animate in, then
  // centre that field in the visible band so it's never occluded. Applies
  // to modal fields everywhere, and on phones to ordinary page fields too
  // (Quarterly Entry, Reports…) since .shell is the scroller there.
  document.addEventListener('focusin', (e) => {
    const el = e.target;
    if (!el || !el.closest) return;
    const inOverlay = el.closest('.modal, .sheet');
    const phonePage = window.matchMedia('(max-width: 640px)').matches;
    if (!inOverlay && !phonePage) return;
    if (!el.matches('input, textarea, select, [contenteditable]')) return;
    setTimeout(() => {
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {}
    }, 300);
  });
})();

// ---- Dismiss the keyboard: tap-away, on button tap, and a "Done" bar ----
// Three ways to put the on-screen keyboard down once you're finished typing:
//   1. Tap anywhere that isn't a text field  -> blur the field.
//   2. Tap a button (Save / Add / Search / …) -> blur first, then it clicks.
//   3. A floating "Done ⌄" bar above the keyboard while a field is focused.
(function initKeyboardDismiss() {
  const isTextField = (el) =>
    !!(el && el.matches && el.matches(
      'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]),' +
      'textarea,[contenteditable]'
    ));
  // Pickers manage their own focus — don't blur the field out from under them.
  const inPicker = (el) => !!(el && el.closest && el.closest('.tw-pop, .product-search-results'));

  // (1) + (2): capture-phase pointerdown. If a text field is focused and the
  // tap lands anywhere that isn't a field (blank space, a button, a label…),
  // blur it so the keyboard slides away. Blur doesn't cancel the tap, so the
  // button still receives its click and Save/Add/Search still fire.
  document.addEventListener('pointerdown', (e) => {
    const active = document.activeElement;
    if (!isTextField(active)) return;
    const t = e.target;
    if (t === active || isTextField(t) || inPicker(t)) return;
    if (t.closest && t.closest('#kbDoneBar')) return; // handled below
    // Chat: tapping Send must fire on the FIRST tap and keep the keyboard up
    // for the next message — so don't blur (blurring collapses the keyboard,
    // shifts the layout, and the tap misses the button).
    if (t.closest && t.closest('.chat-composer')) return;
    active.blur();
  }, true);

  // (3): only wire the floating bar up on phones with a shrinking viewport.
  const vv = window.visualViewport;
  const isPhone = () => window.matchMedia(PHONE_MQ).matches;
  if (!vv) return;

  let bar = null;
  const ensureBar = () => {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'kbDoneBar';
    bar.hidden = true;
    bar.innerHTML =
      '<button type="button" class="kb-done-btn" aria-label="Hide keyboard">' +
        '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
        'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
        '<polyline points="6 9 12 15 18 9"></polyline></svg>' +
        '<span>Done</span></button>';
    document.body.appendChild(bar);
    // pointerdown + preventDefault keeps focus from flickering before we blur.
    bar.querySelector('.kb-done-btn').addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const a = document.activeElement;
      if (a && a.blur) a.blur();
    });
    return bar;
  };
  const showBar = () => { ensureBar().hidden = false; };
  const hideBar = () => { if (bar) bar.hidden = true; };

  document.addEventListener('focusin', (e) => {
    if (!isPhone()) return;
    // The chat composer has its own Send button and you keep typing there, so
    // the floating "Done" bar just gets in the way — skip it for chat.
    if (isTextField(e.target) && !(e.target.closest && e.target.closest('.chat-composer'))) showBar();
  });
  document.addEventListener('focusout', () => {
    // Delay so moving between two fields doesn't flash the bar away.
    setTimeout(() => { if (!isTextField(document.activeElement)) hideBar(); }, 120);
  });
})();

// ---- HTML escaping ----
// Every page builds its lists/tables by dropping record fields (customer
// names, product names, notes, etc. — all free text a staff user can type)
// straight into innerHTML template literals. Without escaping, a name like
// `<img src=x onerror=...>` would execute as script in whoever's browser
// views that record — including an admin's. Wrap any such field with esc()
// before interpolating it into innerHTML. Safe values (numbers, ids, dates,
// enum strings we generated ourselves) don't need it.
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

// ---- Reusable wheel time picker (hour + minute 00–59 + AM/PM, plus typing) ----
// A typeable text field with an iOS-style scroll-wheel popup. Replaces the
// native <input type="time">, whose value silently reads empty when only
// partially filled. The text field is the source of truth: empty = unset;
// scrolling/tapping a wheel or typing fills it. Stores/returns 24-hour
// "HH:MM" to match how times are saved server-side.
// Usage: <div id="myTime" class="time-wheel"></div>, then
// initTimeSelect('myTime'); setTimeSelect('myTime', '14:00'); getTimeSelect('myTime').
const TW_ITEM_H = 38; // px per wheel row; must match .tw-item height in CSS
// NOTE: an earlier version of this rotated each row in 3D (rotateX +
// translateZ, a "cylinder") to look more like a real spinning wheel. Gideon
// compared both side by side in a live demo and picked this flat scale +
// opacity version — less flashy, but renders crisply everywhere and was
// actually seen and approved (unlike the 3D version, tuned blind).

function fmtTime12(hhmm) {
  if (!hhmm) return '';
  const [H, M] = String(hhmm).split(':').map(Number);
  if (isNaN(H) || isNaN(M)) return hhmm;
  const ap = H >= 12 ? 'PM' : 'AM';
  let h12 = H % 12; if (h12 === 0) h12 = 12;
  return `${h12}:${String(M).padStart(2, '0')} ${ap}`;
}

// Tolerant parser: "2:30 PM", "2:30pm", "230 pm", "14:30", "1430", "9" → {H,m}
// Returns 24-hour "HH:MM" or '' if it can't be understood.
function parseTimeText(s) {
  s = String(s || '').trim().toLowerCase();
  if (!s) return '';
  const ap = /p/.test(s) ? 'PM' : (/a/.test(s) ? 'AM' : null);
  const digits = s.replace(/[^0-9]/g, '');
  if (!digits) return '';
  let h, m;
  if (digits.length <= 2) { h = Number(digits); m = 0; }
  else { m = Number(digits.slice(-2)); h = Number(digits.slice(0, -2)); }
  if (isNaN(h) || isNaN(m) || m > 59) return '';
  let H;
  if (ap) { if (h < 1 || h > 12) return ''; H = (h % 12) + (ap === 'PM' ? 12 : 0); }
  else { if (h > 23) return ''; H = h; }
  return `${String(H).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function initTimeSelect(wrapperId) {
  const wrap = document.getElementById(wrapperId);
  if (!wrap || wrap.dataset.twInit) return;
  wrap.dataset.twInit = '1';
  wrap.classList.add('time-wheel');

  const pad = '<div class="tw-pad"></div>';
  const items = (arr) => arr.map(v => `<div class="tw-item" data-v="${v}">${v}</div>`).join('');
  const hours = Array.from({ length: 12 }, (_, i) => String(i + 1));
  const mins = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));
  wrap.innerHTML =
    `<input type="text" class="tw-input" autocomplete="off" placeholder="e.g. 2:30 PM">` +
    `<div class="tw-pop" hidden>` +
      `<div class="tw-cols">` +
        `<div class="tw-col tw-hour">${pad}${items(hours)}${pad}</div>` +
        `<div class="tw-col tw-min">${pad}${items(mins)}${pad}</div>` +
        `<div class="tw-col tw-ap">${pad}${items(['AM', 'PM'])}${pad}</div>` +
        `<div class="tw-center"></div>` +
      `</div>` +
      `<div class="tw-actions"><button type="button" class="btn btn-secondary btn-sm tw-done">Done</button></div>` +
    `</div>`;

  const input = wrap.querySelector('.tw-input');
  const pop = wrap.querySelector('.tw-pop');
  const cols = {
    hour: wrap.querySelector('.tw-hour'),
    min: wrap.querySelector('.tw-min'),
    ap: wrap.querySelector('.tw-ap'),
  };

  const centeredIndex = (col) => Math.max(0, Math.round(col.scrollTop / TW_ITEM_H));
  function markCentered(col) {
    const idx = centeredIndex(col);
    col.querySelectorAll('.tw-item').forEach((el, i) => el.classList.toggle('on', i === idx));
  }
  // Fades and shrinks each item based on how many rows it sits from the
  // (continuous, unrounded) center position — flat 2D only, no rotation, so
  // it renders crisply. Runs on every scroll tick so it animates as the
  // wheel spins, not just when it settles.
  function updateArc(col) {
    const raw = col.scrollTop / TW_ITEM_H;
    col.querySelectorAll('.tw-item').forEach((el, i) => {
      const dist = Math.min(3, Math.abs(i - raw));
      el.style.transform = `scale(${(1 - dist * 0.14).toFixed(3)})`;
      el.style.opacity = Math.max(0.15, 1 - dist * 0.3).toFixed(2);
    });
  }
  function scrollToIndex(col, idx, smooth) {
    col.scrollTo({ top: idx * TW_ITEM_H, behavior: smooth ? 'smooth' : 'auto' });
  }
  function readWheels() {
    const h12 = centeredIndex(cols.hour) + 1;            // 1..12
    const m = centeredIndex(cols.min);                   // 0..59
    const ap = centeredIndex(cols.ap) === 1 ? 'PM' : 'AM';
    let H = (h12 % 12) + (ap === 'PM' ? 12 : 0);
    return `${String(H).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  function commitFromWheels() {
    input.value = fmtTime12(readWheels());
  }
  // Position the wheels from a 24h value (or a sensible default when empty).
  // Sets scrollTop directly (no animation, no rAF) — reading/writing
  // scrollTop forces the browser to lay the element out synchronously, so
  // this works correctly even in the same tick the popup was un-hidden.
  // (An earlier version used scrollTo()+requestAnimationFrame, which raced
  // with the popup's own show/hide state inside a modal and could leave the
  // wheels showing blank rows or a stale position.)
  function positionWheels(hhmm) {
    const v = hhmm || '12:00';
    const [H, M] = v.split(':').map(Number);
    const ap = H >= 12 ? 1 : 0;
    let h12 = H % 12; if (h12 === 0) h12 = 12;
    cols.hour.scrollTop = (h12 - 1) * TW_ITEM_H;
    cols.min.scrollTop = M * TW_ITEM_H;
    cols.ap.scrollTop = ap * TW_ITEM_H;
    Object.values(cols).forEach(col => { markCentered(col); updateArc(col); });
  }

  // Per-column: snap to the nearest row after scrolling stops, then commit.
  // Also supports mouse click-and-drag (native overflow scrolling already
  // covers touch and the mouse wheel, but a plain <div> has no built-in
  // drag-to-scroll for a desktop mouse — verified in a live demo alongside
  // touch/wheel/tap before porting in here).
  Object.values(cols).forEach(col => {
    let settleTimer;
    let dragging = false, dragStartY = 0, dragStartTop = 0;
    function settle() {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        scrollToIndex(col, centeredIndex(col), true);
        commitFromWheels();
      }, 110);
    }
    updateArc(col); // initial (unscrolled) curve, before anything is opened
    col.addEventListener('scroll', () => {
      markCentered(col);
      updateArc(col);
      if (!dragging) settle();
    });
    // Tap a row to select it.
    col.addEventListener('click', (ev) => {
      const item = ev.target.closest('.tw-item');
      if (!item) return;
      const idx = [...col.querySelectorAll('.tw-item')].indexOf(item);
      scrollToIndex(col, idx, true);
      setTimeout(commitFromWheels, 120);
    });
    // Mouse drag-to-scroll. Skipped for touch pointers — native touch
    // scrolling already handles those.
    col.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'touch') return;
      dragging = true;
      dragStartY = ev.clientY;
      dragStartTop = col.scrollTop;
      col.setPointerCapture(ev.pointerId);
      col.classList.add('dragging');
    });
    col.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      col.scrollTop = dragStartTop - (ev.clientY - dragStartY);
    });
    function endDrag() {
      if (!dragging) return;
      dragging = false;
      col.classList.remove('dragging');
      settle();
    }
    col.addEventListener('pointerup', endDrag);
    col.addEventListener('pointercancel', endDrag);
    col.addEventListener('pointerleave', () => { if (dragging) endDrag(); });
  });

  function openPop() {
    if (input.disabled) return;
    pop.hidden = false;
    positionWheels(parseTimeText(input.value));
  }
  function closePop() { pop.hidden = true; }

  input.addEventListener('focus', openPop);
  input.addEventListener('click', openPop);
  // Typing: normalise on change/blur/Enter; reposition wheels to match.
  input.addEventListener('change', () => {
    const v = parseTimeText(input.value);
    input.value = v ? fmtTime12(v) : '';
    if (v) positionWheels(v);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); closePop(); }
    if (ev.key === 'Escape') { ev.preventDefault(); closePop(); }
  });
  wrap.querySelector('.tw-done').addEventListener('click', () => { commitFromWheels(); closePop(); });
  // Close when clicking outside this widget.
  document.addEventListener('pointerdown', (ev) => { if (!wrap.contains(ev.target)) closePop(); });
}

function getTimeSelect(wrapperId) {
  const wrap = document.getElementById(wrapperId);
  if (!wrap) return '';
  const input = wrap.querySelector('.tw-input');
  return input ? parseTimeText(input.value) : '';
}

function setTimeSelect(wrapperId, hhmm) {
  initTimeSelect(wrapperId);
  const wrap = document.getElementById(wrapperId);
  if (!wrap) return;
  const input = wrap.querySelector('.tw-input');
  input.value = hhmm ? fmtTime12(hhmm) : '';
}

function setTimeSelectDisabled(wrapperId, disabled) {
  const wrap = document.getElementById(wrapperId);
  if (!wrap) return;
  const input = wrap.querySelector('.tw-input');
  if (input) input.disabled = !!disabled;
  if (disabled) { const pop = wrap.querySelector('.tw-pop'); if (pop) pop.hidden = true; }
}

// ---- Theme (light/dark) ----
// "Auto" (the default) switches to dark between 7 PM and 6 AM local device
// time. A tiny inline script in each page's <head> applies the theme before
// paint (avoids a flash); this section keeps it in sync while the app is
// open (e.g. crossing 7 PM) and provides the sidebar toggle.
const THEME_DARK_START = 19; // 7 PM
const THEME_DARK_END = 6;    // 6 AM

function getThemePref() {
  return localStorage.getItem('theme-pref') || 'auto';
}

function isEveningNow() {
  const h = new Date().getHours();
  return h >= THEME_DARK_START || h < THEME_DARK_END;
}

function effectiveTheme() {
  const pref = getThemePref();
  return pref === 'auto' ? (isEveningNow() ? 'dark' : 'light') : pref;
}

function applyTheme() {
  document.documentElement.setAttribute('data-theme', effectiveTheme());
  updateThemeToggleLabel();
}

function setThemePref(pref) {
  localStorage.setItem('theme-pref', pref);
  applyTheme();
}

function cycleTheme() {
  const order = ['auto', 'light', 'dark'];
  const next = order[(order.indexOf(getThemePref()) + 1) % order.length];
  setThemePref(next);
}

function updateThemeToggleLabel() {
  const btn = document.getElementById('themeToggleBtn');
  if (!btn) return;
  const pref = getThemePref();
  const labels = { auto: `Auto (${effectiveTheme() === 'dark' ? 'dark now' : 'light now'})`, light: 'Light', dark: 'Dark' };
  btn.querySelector('.theme-toggle-label').textContent = labels[pref];
}

// Re-check every minute so the theme flips live if the app stays open
// across the 7 PM / 6 AM boundary, without needing a page reload.
setInterval(() => { if (getThemePref() === 'auto') applyTheme(); }, 60000);

// ---- Global loading indicator ----
// A thin progress bar pinned to the very top of the screen, shown while any
// api() request is in flight. It only appears after a short delay so quick
// requests don't cause a distracting flash — matching "show a loader for
// anything that takes over ~a second".
const _loader = { count: 0, timer: null, el: null };
function _loaderEl() {
  if (_loader.el) return _loader.el;
  const el = document.createElement('div');
  el.className = 'app-loading-bar';
  el.innerHTML = '<div class="bar"></div>';
  document.body.appendChild(el);
  _loader.el = el;
  return el;
}
function loaderStart() {
  _loader.count++;
  if (_loader.timer) return;
  _loader.timer = setTimeout(() => { _loaderEl().classList.add('on'); }, 500);
}
function loaderStop() {
  _loader.count = Math.max(0, _loader.count - 1);
  if (_loader.count > 0) return;
  if (typeof skelIdle === 'function') skelIdle();
  clearTimeout(_loader.timer);
  _loader.timer = null;
  if (_loader.el) _loader.el.classList.remove('on');
}

async function api(path, options = {}) {
  loaderStart();
  try {
    const res = await fetch('/api' + path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const isJson = res.headers.get('content-type')?.includes('application/json');
    const data = isJson ? await res.json() : null;
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Something went wrong.');
      // The status matters to callers: a 404 on an /api path means the route
      // is not mounted on the running server (almost always a deploy where
      // the static files landed but the service was never restarted), which
      // is a completely different problem from a 403.
      err.status = res.status;
      if (data && data.failedRules) err.failedRules = data.failedRules;
      if (data) err.data = data;
      throw err;
    }
    return data;
  } finally {
    loaderStop();
  }
}

// ---- Responsive tables -> stacked cards ----
// Rather than hand-editing every page's row-rendering code, we tag each <td>
// with a data-label taken from its column header. The CSS (max-width:640px)
// then turns each row into a self-labelled card. A MutationObserver re-tags
// rows whenever a page re-renders its <tbody> via innerHTML.
function _labelTableCells(table) {
  const headRow = table.tHead && table.tHead.rows[0];
  if (!headRow) return;
  const heads = Array.from(headRow.cells).map(th => th.textContent.trim());
  table.classList.add('responsive');
  const body = table.tBodies[0];
  if (!body) return;
  for (const row of body.rows) {
    // Empty-state / full-width rows (a single colspan cell) stay full-width.
    if (row.cells.length === 1 && row.cells[0].hasAttribute('colspan')) {
      row.cells[0].classList.add('rt-fullrow');
      continue;
    }
    Array.from(row.cells).forEach((td, i) => {
      const label = heads[i] || '';
      if (label) td.setAttribute('data-label', label);
      else if (i === row.cells.length - 1) td.classList.add('rt-actions'); // TRAILING header-less column = action buttons
      else td.classList.add('rt-rowhead'); // a LEADING header-less column is a row label (e.g. the attendance matrix's Male/Female grid) — treat it as the card's title on mobile, not an action row
    });
  }
}
function initResponsiveTables(root = document) {
  // Modal tables (member rosters, backups, etc.) stack on phones too —
  // otherwise they get squeezed until buttons wrap letter-by-letter.
  root.querySelectorAll('.card table, .modal table').forEach(table => {
    if (!table.tHead) return;
    _labelTableCells(table);
    const body = table.tBodies[0];
    if (body && !body._rtObserved) {
      body._rtObserved = true;
      new MutationObserver(() => _labelTableCells(table)).observe(body, { childList: true });
    }
  });
}

// Pages like Annual Plan and Quarterly Entry build whole cards + tables from
// JavaScript AFTER the shell renders, so the one-time scan above misses them.
// Watch the page for any table arriving later and tag it the same way.
function watchForNewTables() {
  const main = document.querySelector('.main');
  if (!main || main._rtWatching) return;
  main._rtWatching = true;
  new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && (n.tagName === 'TABLE' || (n.querySelector && n.querySelector('table')))) {
          initResponsiveTables();
          initColumnToggle();
          return;
        }
      }
    }
  }).observe(main, { childList: true, subtree: true });
}

// ---- Column toggle (wide tables only) ----
// Wide tables (Users, committees, audit log, …) can be awkward to read on
// mid-size screens. This adds an opt-in "Columns" menu letting the user hide
// non-essential columns. It is deliberately conservative: nothing is hidden
// until the user chooses to; only tables with 6+ labelled columns get the
// control; the action column and the first (identifier) column can't be hidden;
// and the control is hidden on phones (≤820px, see CSS) where tables already
// stack into cards. The menu reuses the body-level showActionsMenu() so it is
// never clipped by the table card's overflow. Hidden state is kept per-table
// (keyed by its header signature) so it survives the tbody re-renders a page
// does when it refreshes its data.
const _colHidden = new Map();
function _colSig(table) {
  const hr = table.tHead && table.tHead.rows[0];
  return hr ? Array.from(hr.cells).map(c => c.textContent.trim()).join('|') : '';
}
function _applyColHidden(table) {
  const set = _colHidden.get(_colSig(table));
  if (!set) return;
  const headRow = table.tHead && table.tHead.rows[0];
  const bodyRows = table.tBodies[0] ? Array.from(table.tBodies[0].rows) : [];
  [headRow, ...bodyRows].filter(Boolean).forEach(row => {
    Array.from(row.cells).forEach((cell, i) => {
      if (cell.hasAttribute('colspan')) return;   // empty-state full-width row
      cell.style.display = set.has(i) ? 'none' : '';
    });
  });
}
function initColumnToggle(root = document) {
  try {
    root.querySelectorAll('.card table').forEach(table => {
      if (table._colToggle) return;
      const headRow = table.tHead && table.tHead.rows[0];
      if (!headRow) return;
      const heads = Array.from(headRow.cells).map(th => th.textContent.trim());
      if (heads.filter(Boolean).length < 6) return; // only genuinely wide tables
      table._colToggle = true;
      const sig = _colSig(table);
      if (!_colHidden.has(sig)) _colHidden.set(sig, new Set());

      const bar = document.createElement('div');
      bar.className = 'col-toggle';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'col-toggle-btn';
      btn.textContent = 'Columns';
      btn.addEventListener('click', () => {
        const set = _colHidden.get(sig);
        const items = heads.map((h, i) => {
          if (!h || i === 0) return null;            // keep action + first (id) column
          const visible = !set.has(i);
          return {
            label: (visible ? '✓ ' : '  ') + h,
            onClick: () => { if (visible) set.add(i); else set.delete(i); _applyColHidden(table); }
          };
        }).filter(Boolean);
        showActionsMenu(btn, items);
      });
      bar.appendChild(btn);
      table.parentNode.insertBefore(bar, table);

      const body = table.tBodies[0];
      if (body && !body._colObs) {
        body._colObs = true;
        new MutationObserver(() => _applyColHidden(table)).observe(body, { childList: true });
      }
    });
  } catch (e) { /* never break a page over a UI nicety */ }
}

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ---- Styled confirm / info dialogs ----
// Promise-based, on-brand replacements for window.confirm()/alert() so
// destructive actions match the app instead of a bare OS pop-up. Text is set
// via textContent (no injection) and the body uses white-space:pre-line, so
// "\n" in a message still renders as line breaks. Usage:
//   if (!await confirmDialog('Delete this?', { danger: true })) return;
//   await infoDialog('Done — 3 rows updated.');
function confirmDialog(message, opts = {}) {
  const {
    title = 'Please confirm', okText = 'Confirm', cancelText = 'Cancel',
    danger = false,
  } = opts;
  return new Promise(resolve => {
    const _prevFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay app-dialog';
    const modal = document.createElement('div');
    modal.className = 'modal confirm-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2'); h.textContent = title;
    const p = document.createElement('p'); p.className = 'confirm-body'; p.textContent = message;
    const actions = document.createElement('div'); actions.className = 'modal-actions';
    const ok = document.createElement('button');
    ok.type = 'button'; ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary'); ok.textContent = okText;
    let cancel = null;
    if (cancelText) {
      cancel = document.createElement('button');
      cancel.type = 'button'; cancel.className = 'btn btn-secondary'; cancel.textContent = cancelText;
      actions.append(cancel, ok);
    } else {
      actions.append(ok);
    }
    modal.append(h, p, actions);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const done = v => { document.removeEventListener('keydown', onKey); overlay.remove(); if (_prevFocus && _prevFocus.focus) { try { _prevFocus.focus(); } catch (e) {} } resolve(v); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) done(false); });
    ok.onclick = () => done(true);
    if (cancel) cancel.onclick = () => done(false);
    document.addEventListener('keydown', onKey);
    ok.focus();
  });
}
function infoDialog(message, opts = {}) {
  return confirmDialog(message, { title: opts.title || 'Done', okText: opts.okText || 'OK', cancelText: null, danger: false });
}

// Export letters to share, as PDF or Word (Oct 2026). Used by the
// Correspondence Inbox, the Session's correspondence register and the
// Correspondence tab of a set of minutes — `params` says which letters
// (scope, view, q, id, ids); see GET /minutes/correspondence/export.
function openCorrExport(params, label) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay app-dialog';
  overlay.innerHTML = `
    <div class="modal confirm-modal" role="dialog" aria-modal="true" style="max-width:440px;">
      <h2>Export ${esc(label || 'correspondence')}</h2>
      <p class="confirm-body" style="margin-bottom:10px;">Each letter with its details: who it is from, the dates, what it asks for, the summary, the action and where it went.</p>
      <div style="display:flex; gap:8px; margin-bottom:10px;">
        <label class="cx-opt"><input type="radio" name="cxFmt" value="pdf" checked style="width:auto;"> PDF</label>
        <label class="cx-opt"><input type="radio" name="cxFmt" value="docx" style="width:auto;"> Word</label>
      </div>
      <label style="display:flex; gap:8px; align-items:flex-start; font-size:13.5px;">
        <input type="checkbox" id="cxPages" style="width:auto; margin-top:3px;">
        <span>Put in the scanned pages too<span class="sub" style="display:block; font-size:12px;">Photos and image scans go in after each letter. A page uploaded as a PDF is named but not copied in.</span></span>
      </label>
      <div class="modal-actions" style="margin-top:14px;">
        <button type="button" class="btn btn-secondary" data-x="no">Cancel</button>
        <button type="button" class="btn btn-primary" data-x="go">Export</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const close = () => { document.removeEventListener('keydown', onKey); overlay.remove(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) close(); });
  overlay.querySelector('[data-x="no"]').onclick = close;
  overlay.querySelector('[data-x="go"]').onclick = () => {
    const format = (overlay.querySelector('input[name="cxFmt"]:checked') || {}).value || 'pdf';
    const q = new URLSearchParams();
    Object.entries(params || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length)) q.set(k, Array.isArray(v) ? v.join(',') : String(v)); });
    q.set('format', format);
    if (overlay.querySelector('#cxPages').checked) q.set('pages', '1');
    close();
    const url = '/api/minutes/correspondence/export?' + q.toString();
    if (window.openDocViewer) window.openDocViewer(url, label || 'Correspondence');
    else window.location.href = url;
  };
  overlay.querySelector('[data-x="go"]').focus();
}

// A styled, accessible single-field prompt (replaces the native window.prompt).
// Resolves to the entered string, or null if cancelled/dismissed.
function promptDialog(message, opts = {}) {
  const {
    title = 'Enter details', defaultValue = '', placeholder = '',
    multiline = false, okText = 'Save', cancelText = 'Cancel', required = false,
  } = opts;
  return new Promise(resolve => {
    const _prevFocus = document.activeElement;
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay app-dialog';
    const modal = document.createElement('div'); modal.className = 'modal';
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2'); h.textContent = title; modal.appendChild(h);
    if (message) { const p = document.createElement('p'); p.className = 'confirm-body'; p.textContent = message; modal.appendChild(p); }
    const field = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) field.type = 'text'; else field.rows = 4;
    field.value = defaultValue; if (placeholder) field.placeholder = placeholder;
    field.style.width = '100%';
    modal.appendChild(field);
    const actions = document.createElement('div'); actions.className = 'modal-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary'; cancel.textContent = cancelText;
    const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'btn btn-primary'; ok.textContent = okText;
    actions.append(cancel, ok); modal.appendChild(actions);
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const done = v => { document.removeEventListener('keydown', onKey); overlay.remove(); if (_prevFocus && _prevFocus.focus) { try { _prevFocus.focus(); } catch (e) {} } resolve(v); };
    const submit = () => { if (required && !field.value.trim()) { field.focus(); return; } done(field.value); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter' && !multiline) { e.preventDefault(); submit(); }
    };
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) done(null); });
    ok.onclick = submit; cancel.onclick = () => done(null);
    document.addEventListener('keydown', onKey);
    field.focus(); try { field.select(); } catch (e) {}
  });
}

// A small multi-field form dialog. `fields` = [{name,label,value,placeholder,
// multiline,type}]. Resolves to { name: value, … } (trimmed), or null if
// cancelled.
function formDialog(title, fields, opts = {}) {
  const { okText = 'Save', cancelText = 'Cancel' } = opts;
  return new Promise(resolve => {
    const _prevFocus = document.activeElement;
    const overlay = document.createElement('div'); overlay.className = 'modal-overlay app-dialog';
    const modal = document.createElement('div'); modal.className = 'modal';
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
    const h = document.createElement('h2'); h.textContent = title; modal.appendChild(h);
    const inputs = {};
    (fields || []).forEach(f => {
      const wrap = document.createElement('div'); wrap.className = 'field';
      const lab = document.createElement('label'); lab.textContent = f.label || f.name; wrap.appendChild(lab);
      const el = document.createElement(f.multiline ? 'textarea' : 'input');
      if (!f.multiline) el.type = f.type || 'text'; else el.rows = f.rows || 3;
      el.value = f.value == null ? '' : f.value; if (f.placeholder) el.placeholder = f.placeholder;
      wrap.appendChild(el); modal.appendChild(wrap); inputs[f.name] = el;
    });
    const actions = document.createElement('div'); actions.className = 'modal-actions';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn btn-secondary'; cancel.textContent = cancelText;
    const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'btn btn-primary'; ok.textContent = okText;
    actions.append(cancel, ok); modal.appendChild(actions);
    overlay.appendChild(modal); document.body.appendChild(overlay);
    const done = v => { document.removeEventListener('keydown', onKey); overlay.remove(); if (_prevFocus && _prevFocus.focus) { try { _prevFocus.focus(); } catch (e) {} } resolve(v); };
    const onKey = e => { if (e.key === 'Escape') { e.preventDefault(); done(null); } };
    overlay.addEventListener('mousedown', e => { if (e.target === overlay) done(null); });
    ok.onclick = () => { const out = {}; Object.keys(inputs).forEach(k => out[k] = inputs[k].value.trim()); done(out); };
    cancel.onclick = () => done(null);
    document.addEventListener('keydown', onKey);
    const first = Object.values(inputs)[0]; if (first) { first.focus(); try { first.select(); } catch (e) {} }
  });
}

// ---- Global modal accessibility ----
// Makes EVERY modal in the app keyboard-accessible without touching each page:
// Escape closes the topmost open static modal, and Tab is trapped inside it.
// Programmatic dialogs (confirm/prompt/form) carry their own Escape handling
// and are marked .app-dialog, so we skip Escape for those but still trap Tab.
// A modal can opt out of Escape-to-close with a `data-no-escape` attribute.
function _topVisibleOverlay() {
  const list = [...document.querySelectorAll('.modal-overlay')].filter(o => {
    if (!o.offsetParent && getComputedStyle(o).position !== 'fixed') return false;
    return getComputedStyle(o).display !== 'none';
  });
  return list[list.length - 1] || null;
}
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape' && e.key !== 'Tab') return;
  const top = _topVisibleOverlay();
  if (!top) return;
  if (e.key === 'Escape') {
    if (top.classList.contains('app-dialog') || top.hasAttribute('data-no-escape')) return;
    e.preventDefault();
    top.style.display = 'none';
    return;
  }
  // Tab: keep focus within the top modal.
  const focusables = [...top.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
    .filter(el => el.offsetParent !== null);
  if (!focusables.length) return;
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

// Keyboard-only focus rings, a screen-reader-only utility class, and respect for
// "reduce motion" — injected here so it applies app-wide without a CSS edit.
(function injectA11yStyles() {
  const s = document.createElement('style');
  s.id = 'a11yStyles';
  s.textContent =
    ':focus-visible{outline:2px solid #4ea1ff;outline-offset:2px;}' +
    '.visually-hidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0;}' +
    '@media (prefers-reduced-motion: reduce){*,*::before,*::after{animation-duration:.001ms!important;animation-iteration-count:1!important;transition-duration:.001ms!important;scroll-behavior:auto!important;}}';
  document.head.appendChild(s);
})();

// Currency symbol is configurable from Settings; defaults to the cedi sign
// until the setting has loaded (requireAuthAndRenderShell fetches it).
let CURRENCY_SYMBOL = '\u20B5';
function setCurrencySymbol(sym) { if (sym) CURRENCY_SYMBOL = sym; }


// ---- Live thousands separator (AOTC Track) ----
// Any <input data-num> gets commas inserted automatically as the user types
// (1234567 -> 1,234,567). Decimals are preserved. Use numVal() to read back.
function formatThousands(raw) {
  let v = String(raw).replace(/[^\d.]/g, '');
  const firstDot = v.indexOf('.');
  if (firstDot !== -1) v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, '');
  const [int, dec] = v.split('.');
  const withCommas = (int || '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return dec !== undefined ? withCommas + '.' + dec : withCommas;
}
function numVal(v) {
  const clean = String(v || '').replace(/,/g, '').trim();
  return clean === '' ? null : Number(clean);
}
document.addEventListener('input', e => {
  const el = e.target;
  if (!el.matches || !el.matches('input[data-num]')) return;
  const before = el.value;
  const formatted = formatThousands(before);
  if (formatted !== before) {
    el.value = formatted;
    try { el.setSelectionRange(el.value.length, el.value.length); } catch (err) {}
  }
});

// ---- Asking for something locked to be opened again -------------------------
// One helper behind every "Request to reopen" button in the app. The five kinds
// of lock, and who is placed to judge each, live in utils/unlockKinds.js on the
// server; here we only need the wording. Asking unlocks nothing by itself: the
// request goes to whoever decides that kind (money to the Treasurer, the rest
// to the Session Clerk, an administrator either way) and the REASON travels
// with it — which is the part a phone call always lost.
const UNLOCK_KIND_LABELS = {
  'quarter': 'quarterly entry',
  'service-day': 'Sunday service attendance',
  'meeting-attendance': 'meeting attendance',
  'fundraising-day': "fundraising day's figures",
  'finance-week': "week's finance entry",
};
const UNLOCK_DECIDER = {
  'quarter': 'The Session Clerk',
  'service-day': 'The Session Clerk',
  'meeting-attendance': 'The Session Clerk',
  'fundraising-day': 'The Treasurer',
  'finance-week': 'The Treasurer',
};

// Resolves true when a request was sent, false if cancelled or refused.
async function askToReopen(kind, target, opts = {}) {
  const what = opts.what || UNLOCK_KIND_LABELS[kind] || 'this entry';
  const who = UNLOCK_DECIDER[kind] || 'An administrator';
  const reason = await promptDialog(
    `${who} (or an administrator) will see this and decide. Say what needs correcting.`,
    {
      title: 'Request to reopen \u2014 ' + what,
      multiline: true, required: true, okText: 'Send request',
      placeholder: opts.placeholder || 'e.g. two names were ticked by mistake',
    });
  if (reason === null) return false;
  try {
    await api('/unlocks', { method: 'POST', body: { kind, target, reason: String(reason).trim() } });
    toast('Request sent. You will be notified once it has been decided.');
    return true;
  } catch (e) {
    // 409 means somebody already asked for this one \u2014 that is good news for
    // the asker, not an error to apologise for.
    toast(e.message || 'Could not send the request.', e.status !== 409);
    return false;
  }
}

// A locked screen offers the button; a 423 from the server carries everything
// needed to build it (`canRequestUnlock`, `kind`, `target`).
function reopenButtonHtml(kind, target, label) {
  return '<button type="button" class="btn btn-secondary btn-sm" data-reopen-kind="' + esc(kind)
    + '" data-reopen-target="' + esc(JSON.stringify(target || {})) + '">'
    + esc(label || 'Request to reopen') + '</button>';
}
document.addEventListener('click', e => {
  const btn = e.target.closest && e.target.closest('[data-reopen-kind]');
  if (!btn) return;
  e.preventDefault();
  let target = {};
  try { target = JSON.parse(btn.getAttribute('data-reopen-target') || '{}'); } catch (err) {}
  askToReopen(btn.getAttribute('data-reopen-kind'), target, { what: btn.getAttribute('data-reopen-what') || '' })
    .then(sent => { if (sent && typeof window.onReopenRequested === 'function') window.onReopenRequested(); });
});

function money(n) {
  return CURRENCY_SYMBOL + Number(n).toFixed(2);
}

// ---- Dates ----------------------------------------------------------------
// A bare 'YYYY-MM-DD' is a CALENDAR DAY, not an instant in time. `new Date()`
// parses it as midnight *UTC*, so anywhere west of Greenwich every local-time
// formatter prints the day before: the Sunday attendance text for 2026-08-30
// read "29 August 2026" for anyone on a negative UTC offset. Parse date-only
// strings as LOCAL midnight; leave real timestamps (which carry a time, and
// usually a zone) to the normal Date parser, where local formatting is right.
//
// Rule for this codebase: a value that is only a day (date, dueDate,
// targetDate, marriageDate, …) goes through toLocalDate/fmtDate. A value that
// is an instant (createdAt, confirmedAt, lockedAt, submittedAt, …) does not.
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function toLocalDate(v) {
  if (v instanceof Date) return v;
  const s = String(v == null ? '' : v).trim();
  // `new Date(null)` is 1 January 1970, not an invalid date, so an empty
  // dueDate would print as a real day. Hand back something that fails isNaN.
  if (!s) return new Date(NaN);
  const m = DATE_ONLY_RE.exec(s);
  if (!m) return new Date(s);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// 'YYYY-MM-DD' read off a Date in LOCAL time — the value to assign to an
// <input type="date">. Never use `input.valueAsDate = d`: that setter reads
// d's *UTC* parts, so from 20:00 onward at UTC-4 it silently pre-fills
// tomorrow, and the figures then save under the wrong day.
function dateInputValue(d) {
  const dt = d instanceof Date ? d : toLocalDate(d);
  if (isNaN(dt)) return '';
  const p = n => String(n).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
}

// Today, and the Sunday on or before today, as input values.
function todayInputValue() {
  return dateInputValue(new Date());
}
function lastSundayInputValue() {
  const d = new Date();
  d.setDate(d.getDate() - d.getDay());
  return dateInputValue(d);
}

// The house date formats. `fmtDate` takes a day or a timestamp.
function fmtDate(d) {
  return toLocalDate(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
// "30 August 2026" — how a day is named in announcements and headings.
function fmtDateLong(d) {
  return toLocalDate(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}
// ---- end Dates ---- (scripts/test-dates.js lifts everything between the two
// markers and runs it on its own — keep them.)

// icon = inline SVG path drawn in a 24x24 viewBox
// perm = permission key required (admins always pass); omit perm for items open to any logged-in role.
// Sidebar / mobile navigation. Sections are named after SUBJECTS, never after
// a body or after the tooling — see claude/naming-and-categorisation.md. The
// first four entries a user is allowed to see also become the phone tab bar
// (items.slice(0, 4) further down), so the order here is a product decision.
const NAV_ITEMS = [
  { href: '/index.html', label: 'Home', icon: 'M3 12l9-9 9 9M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10' },
  { section: 'Plan & Report', href: '/goals.html', label: 'Goals & KPIs', icon: 'M22 11.08V12a10 10 0 1 1-5.93-9.14M22 4L12 14.01l-3-3' },
  { section: 'Plan & Report', href: '/planning.html', label: 'Annual Plan', icon: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' },
  { section: 'Plan & Report', href: '/entry.html', label: 'Quarterly Entry', icon: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z' },
  { section: 'Plan & Report', href: '/reports.html', label: 'Reports', icon: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8' },
  { section: 'Committees & Groups', href: '/committees.html', label: 'Committees', entityTypes: ['committee'], scopedLabel: 'My Committee', icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' },
  { section: 'Committees & Groups', href: '/groups.html', label: 'Groups', entityTypes: ['group'], scopedLabel: 'My Group', icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
  // Everyone sees the Church Diary; who may add to it is decided by the server (Nov 2026).
  { section: 'Meetings & Attendance', href: '/diary.html', label: 'Church Diary', icon: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 14h2M14 14h2M8 18h2' },
  { section: 'Meetings & Attendance', href: '/meetings.html', label: 'Meetings', icon: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z' },
  { section: 'Meetings & Attendance', href: '/attendance.html', label: 'Attendance', entityTypes: ['group'], anyPerm: ['attendance.cs', 'attendance.jy', 'attendance.main', 'approvals.manage'], icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' },
  { section: 'Meetings & Attendance', href: '/checkin.html', label: 'Check-in', entityTypes: ['group'], icon: 'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10' },
  { section: 'Elections', href: '/elections.html', label: 'Group Elections', anyPerm: ['elections.manage', 'approvals.manage'], icon: 'M9 12l2 2 4-4M5 7h14l-1 13H6L5 7zM8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' },
  // Shown to named polling officers (pollOfficer from /auth/me) and the election officer.
  { section: 'Elections', href: '/poll-desk.html', label: 'Polling Desk', pollDesk: true, icon: 'M3 21h18M5 21V10l7-5 7 5v11M9 21v-6h6v6' },
  { section: 'The Session', href: '/session-meetings.html', label: 'Session Meetings', anyPerm: ['approvals.manage', 'session.manage', 'congregation.view'], icon: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z' },
  { section: 'The Session', href: '/session-composition.html', label: 'Session Composition', anyPerm: ['approvals.manage', 'session.manage', 'congregation.view'], icon: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' },
  { section: 'The Session', href: '/session-matters.html', label: 'Outstanding Matters', anyPerm: ['approvals.manage', 'session.manage', 'congregation.view'], icon: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11' },
  { section: 'The Session', href: '/correspondence.html', label: 'Correspondence Inbox', anyPerm: ['approvals.manage', 'session.manage', 'correspondence.intake'], icon: 'M4 4h16v16H4zM4 13h4l2 3h4l2-3h4' },
  { section: 'The Session', href: '/minutes.html', label: 'Session Minutes', anyPerm: ['approvals.manage', 'session.manage', 'congregation.view'], icon: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z' },
  { section: 'Ministry', href: '/visitors.html', label: 'Visitors & New Members', perm: 'visitors.manage', icon: 'M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM20 8v6M23 11h-6' },
  { section: 'Ministry', href: '/counselling.html', label: 'Counselling', perm: 'counselling.manage', icon: 'M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z' },
  { section: 'Ministry', href: '/marriage.html', label: 'Intended Marriages', perm: 'counselling.manage', icon: 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z' },
  { section: 'Money', href: '/finance-weekly.html', label: 'Weekly Finance', anyPerm: ['finance.weekly', 'finance.weekly.confirm', 'finance.quarterly', 'approvals.manage'], icon: 'M3 3v18h18M7 14l4-4 3 3 5-6' },
  { section: 'Money', href: '/fundraising.html', label: 'Harvest & Fundraising', anyPerm: ['fundraising.manage', 'fundraising.verify', 'fundraising.approve', 'finance.quarterly'], icon: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6' },
  { section: 'ShareHub', href: '/documents.html', label: 'ShareHub', icon: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12' },
  { section: 'Administration', href: '/access.html', label: 'Access Requests', anyPerm: ['users.request', 'staff.manage', 'approvals.manage'], icon: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM19 8v6M22 11h-6' },
  // Anyone may ask for something locked to be reopened, and everyone can see
  // what became of their own request — so this one carries no permission.
  { section: 'Administration', href: '/unlocks.html', label: 'Reopen Requests', icon: 'M5 11h14a0 0 0 0 1 0 0v9a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-9a0 0 0 0 1 0 0zM7 11V7a5 5 0 0 1 9.9-1' },
  { section: 'Administration', href: '/users.html', label: 'User Accounts', perm: 'staff.manage', icon: 'M16 20v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' },
  { section: 'Administration', href: '/settings.html', label: 'Settings', adminOnly: true, icon: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' },
  { section: 'Me', href: '/messages.html', label: 'Messages', icon: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
  { section: 'Me', href: '/notifications.html', label: 'Notifications', icon: 'M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.73 21a2 2 0 0 1-3.46 0' },
  { section: 'Me', href: '/account.html', label: 'My Account', icon: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' },
];

function hasPermission(user, perm) {
  return user.role === 'admin' || (user.permissions || []).includes(perm);
}

// Admin-tier check used across pages (admin + local admin).
function isElevated(user) {
  return !!user && ['admin', 'localadmin'].includes(user.role);
}

function visibleNavItems(user) {
  // Minister — read-only oversight of the whole congregation. A fixed,
  // viewing-only menu: the congregation Dashboard (Sunday + group-meeting
  // attendance summaries and the fundraising raised-vs-target summary all live
  // here), Goals & Plans, Reports, Committees & Groups, Meetings, ShareHub
  // (which gates every document by its own access level) and the read-only
  // Fundraising overview. Action/entry pages (Quarterly Entry,
  // Check-in, the Attendance recorder) and the confidential/admin modules
  // (Counselling, Marriage, Visitors, Access Requests, Users, Settings) are
  // omitted. congregation.view already blocks every write server-side, and each
  // of these pages hides its edit controls when the user lacks the right — so a
  // Minister sees clean, read-only views with no dead buttons.
  if (user.role === 'minister') {
    const allow = ['/index.html', '/goals.html', '/planning.html', '/reports.html',
      '/committees.html', '/groups.html', '/diary.html', '/meetings.html',
      '/session-meetings.html', '/session-composition.html', '/session-matters.html',
      '/minutes.html', '/fundraising.html', '/documents.html',
      '/messages.html', '/notifications.html', '/account.html'];
    return NAV_ITEMS.filter(i => allow.includes(i.href));
  }
  // Scoped committee/group accounts only see pages that apply to them:
  // a committee account never sees "Groups", a group account never sees
  // "Committees", and scoped labels become "My Committee" / "My Group".
  const scopedType = user.entity && user.entity.type !== 'congregation' ? user.entity.type : null;
  return NAV_ITEMS.filter(item => {
    if (item.adminOnly && user.role !== 'admin') return false;
    if (item.pollDesk) return !!user.pollOfficer || isElevated(user) || (user.permissions || []).includes('elections.manage');
    // A matching anyPerm grant shows the page even for scoped accounts of a
    // different entity type (e.g. a committee-scoped CS recorder still gets
    // Attendance). Otherwise entityTypes decides for scoped accounts.
    const anyPermMatch = item.anyPerm && (user.role === 'admin' || item.anyPerm.some(p => (user.permissions || []).includes(p)));
    if (anyPermMatch) return true;
    if (item.entityTypes) {
      if (scopedType) return item.entityTypes.includes(scopedType);
      return !item.anyPerm; // congregation-wide: hidden when the item needs a grant they don't hold
    }
    if (item.anyPerm) return false;
    if (!item.perm) return true;
    return user.role === 'admin' || (user.permissions || []).includes(item.perm);
  }).map(item => (scopedType && item.scopedLabel) ? { ...item, label: item.scopedLabel } : item);
}

// An empty list, said kindly: an icon, a line saying what is missing, and —
// when this person can — the button that starts it. `click` is the id of the
// page's own button for that (only offered while that button is showing), or
// `href` a page to go to. (Oct 2026 look.)
const EMPTY_ICONS = {
  calendar: 'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  doc: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M12 18v-6M9 15h6',
  mail: 'M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM22 6l-10 7L2 6',
  people: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  check: 'M9 11l3 3 8-8M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
};
function emptyState(o) {
  o = o || {};
  const btn = document.getElementById(o.click || '');
  const can = o.action && (o.href || (btn && !btn.disabled && !btn.hidden && btn.style.display !== 'none' && !btn.closest('[hidden]')));
  const act = !can ? ''
    : o.href ? `<a class="btn btn-primary btn-sm" href="${o.href}">${esc(o.action)}</a>`
    : `<button type="button" class="btn btn-primary btn-sm" onclick="document.getElementById('${o.click}').click()">${esc(o.action)}</button>`;
  return `<div class="empty-state"><div class="es-ic">${iconSvg(EMPTY_ICONS[o.icon] || EMPTY_ICONS.check)}</div>
    <b>${esc(o.title || 'Nothing here yet')}</b>${o.text ? `<span>${esc(o.text)}</span>` : ''}${act}</div>`;
}

function iconSvg(path) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
}

// ================= Multi-workspace (linked accounts) =================
// A person who serves several committees/groups signs in ONCE; /auth/me hands
// back a `workspaces` list (2+ entries) so the shell can show a switcher and
// per-entity nav. Ordinary single-entity accounts get [] here and see no change
// at all. Switching re-issues the session as the chosen workspace (server side)
// and reloads, so every page then reflects that committee/group.
// The single source of truth for how a role is written for a human. Role KEYS
// ('clerk', 'localadmin', 'accounts') are storage, never display — anywhere a
// role reaches the screen it goes through roleLabel().
const ROLE_LABELS = {
  admin: 'Administrator',
  localadmin: 'Local Administrator',
  clerk: 'Session Clerk',
  coordinator: 'Reporting Coordinator',
  secretary: 'Secretary',
  attendance: 'Attendance Officer',
  treasurer: 'Treasurer',
  accounts: 'Accounts Clerk',
  minister: 'Minister',
  viewer: 'Viewer',
};
function roleLabel(r) { return ROLE_LABELS[r] || r; }

// Shorter forms for the workspace switcher, where the row already carries the
// committee/group name and the full title would not fit.
const WS_ROLE_SHORT = {
  secretary: 'Secretary', coordinator: 'Coordinator', attendance: 'Attendance',
  treasurer: 'Treasurer', accounts: 'Accounts Clerk', clerk: 'Clerk', viewer: 'Viewer',
};
const WS_ICON = {
  committee: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  group: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
};

// Turn raw workspaces from /auth/me into display rows (resolved name + code),
// or [] when there are fewer than two (nothing to switch between).
async function resolveWorkspaces(user) {
  const raw = user && user.workspaces;
  if (!Array.isArray(raw) || raw.length < 2) return [];
  const needCom = raw.some(w => w.entity && w.entity.type === 'committee');
  const needGrp = raw.some(w => w.entity && w.entity.type === 'group');
  const [coms, grps] = await Promise.all([
    needCom ? api('/setup/committees').catch(() => []) : Promise.resolve([]),
    needGrp ? api('/setup/groups').catch(() => []) : Promise.resolve([]),
  ]);
  const nameOf = ent => {
    if (!ent || ent.type === 'congregation') return { name: 'Congregation-wide', code: '' };
    const rec = (ent.type === 'committee' ? coms : grps).find(x => x.id === Number(ent.id));
    if (rec) return { name: rec.name, code: rec.code || '' };
    // Fallback if the name can't be resolved: at least say which kind it is.
    return { name: ent.type === 'committee' ? 'Committee' : 'Group', code: '' };
  };
  return raw.map(w => ({ ...w, ...nameOf(w.entity) }));
}

// Switch this session to another of the person's workspaces, then land on the
// destination page (or reload the current one) in the new context.
async function switchWorkspace(id, destHref) {
  try {
    await api('/auth/switch/' + id, { method: 'POST' });
    if (destHref && destHref !== location.pathname) location.href = destHref;
    else location.reload();
  } catch (e) { toast((e && e.message) || 'Could not switch workspace.', true); }
}

function workspaceSwitcherHtml(ws, id) {
  const opt = w => `<option value="${w.id}" ${w.active ? 'selected' : ''}>${esc(w.name)}${w.role && WS_ROLE_SHORT[w.role] ? ' · ' + WS_ROLE_SHORT[w.role] : ''}</option>`;
  const coms = ws.filter(w => w.entity && w.entity.type === 'committee');
  const grps = ws.filter(w => w.entity && w.entity.type === 'group');
  const other = ws.filter(w => !w.entity || w.entity.type === 'congregation');
  let inner = '';
  if (coms.length) inner += `<optgroup label="Committees">${coms.map(opt).join('')}</optgroup>`;
  if (grps.length) inner += `<optgroup label="Groups">${grps.map(opt).join('')}</optgroup>`;
  if (other.length) inner += `<optgroup label="Other">${other.map(opt).join('')}</optgroup>`;
  return `<select class="ws-switcher" id="${id}" onchange="switchWorkspace(this.value)" title="Switch committee or group">${inner}</select>`;
}

// Per-entity nav sections ("My Committee(s)" / "My Group(s)") — each entity is a
// switch-link; the currently active one carries a ✓, and clicking navigates to
// that entity's page after switching into it.
function workspaceNavHtml(ws, activeHref) {
  const section = (list, title, href) => {
    if (!list.length) return '';
    let out = `<div class="nav-section">${title}${list.length > 1 ? 's' : ''}</div>`;
    out += list.map(w =>
      `<div class="nav-link ws-nav ${w.active && href === activeHref ? 'active' : ''}" onclick="switchWorkspace(${w.id}, '${href}')">${iconSvg(WS_ICON[w.entity.type])}<span class="label">${esc(w.name)}</span>${w.active ? '<span class="ws-check">✓</span>' : ''}</div>`
    ).join('');
    return out;
  };
  return section(ws.filter(w => w.entity && w.entity.type === 'committee'), 'My Committee', '/committees.html')
       + section(ws.filter(w => w.entity && w.entity.type === 'group'), 'My Group', '/groups.html');
}

function injectWorkspaceStyles() {
  if (document.getElementById('wsStyles')) return;
  const s = document.createElement('style');
  s.id = 'wsStyles';
  s.textContent = `
    .ws-top{padding:6px 14px 10px;}
    .ws-top-name{font-size:12px;font-weight:600;opacity:.7;margin-bottom:5px;}
    .ws-switcher{width:100%;padding:7px 8px;border-radius:9px;border:1px solid rgba(128,140,170,.35);background:rgba(128,140,170,.12);color:inherit;font-size:12.5px;font-weight:600;cursor:pointer;}
    .ws-switcher:focus{outline:2px solid #4ea1ff;outline-offset:1px;}
    .nav-link.ws-nav .ws-check{margin-left:auto;color:#4ea1ff;font-weight:800;}
    .more-ws{padding:12px 16px;}
    .more-ws-label{font-size:12px;opacity:.7;margin-bottom:6px;}
  `;
  document.head.appendChild(s);
}

// ---- Mobile "More" sheet ----
// The bottom tab bar only has room for a few tabs, so overflow pages live in a
// slide-up sheet together with the theme toggle and log out.
const THEME_ICON = 'M12 3v2M12 19v2M5 5l1.4 1.4M17.6 17.6L19 19M3 12h2M19 12h2M5 19l1.4-1.4M17.6 6.4L19 5M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z';
const LOGOUT_ICON = 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9';

function buildMoreSheet(overflowItems, activeHref, user, ws) {
  const existing = document.getElementById('moreSheetOverlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.id = 'moreSheetOverlay';
  overlay.style.display = 'none';

  // Grouped by the same sections as the desktop sidebar (Oct 2026) — the sheet
  // used to be one flat grid of every page, so on a phone nothing said where a
  // page belonged. Each section can be folded away (remembered per phone), and
  // a search box finds a page by name.
  const groups = [];
  overflowItems.forEach(i => {
    const name = i.section || 'Other';
    let g = groups.find(x => x.name === name);
    if (!g) groups.push(g = { name, items: [] });
    g.items.push(i);
  });
  let folded = [];
  try { folded = JSON.parse(localStorage.getItem('moreFolded') || '[]'); } catch (e) { folded = []; }
  const navLinks = groups.map(g => {
    const hasActive = g.items.some(i => i.href === activeHref);
    const open = hasActive || !folded.includes(g.name);
    return `<details class="more-group" data-group="${esc(g.name)}" ${open ? 'open' : ''}>
      <summary><span>${esc(g.name)}</span><span class="more-group-n">${g.items.length}</span></summary>
      <div class="more-list">${g.items.map(i => `<a class="more-item ${i.href === activeHref ? 'active' : ''}" href="${i.href}" data-label="${esc(String(i.label).toLowerCase())} ${esc(String(g.name).toLowerCase())}">${iconSvg(i.icon)}<span>${esc(i.label)}</span></a>`).join('')}</div>
    </details>`;
  }).join('');
  const searchBox = overflowItems.length > 6
    ? `<div class="more-search"><input type="search" id="moreSearch" placeholder="Find a page\u2026" aria-label="Find a page" autocomplete="off"></div>` : '';

  const wsBlock = (Array.isArray(ws) && ws.length)
    ? `<div class="more-ws"><div class="more-ws-label">Switch committee / group</div>${workspaceSwitcherHtml(ws, 'wsSwitcherMobile')}</div>`
    : '';

  overlay.innerHTML = `
    <div class="sheet more-sheet">
      <div class="more-head">
        <div class="more-grabber" title="Close"></div>
        <button type="button" class="more-close" id="moreCloseBtn" aria-label="Close menu">\u2715 Close</button>
      </div>
      <div class="more-user">
        <div class="more-user-name">${esc(user.name)}</div>
        <div class="role-tag">${esc(roleLabel(user.role))}</div>
      </div>
      ${wsBlock}
      ${searchBox}
      ${navLinks ? `<div class="more-groups" id="moreGroups">${navLinks}</div>` : ''}
      <p class="sub more-none" id="moreNone" style="display:none; text-align:center; margin:8px 0 12px;">No page by that name.</p>
      <a class="more-item" href="/about.html">${iconSvg('M12 8h.01M11 12h1v4h1M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z')}<span>About AOTC Track</span><span class="app-ver more-ver">${window.APP_RUNNING_VERSION ? esc(window.APP_RUNNING_VERSION) : ''}</span></a>
      <button type="button" class="more-item" onclick="location.reload()">${iconSvg('M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15')}<span>Refresh page</span></button>
      <button type="button" class="more-item" id="moreThemeBtn">${iconSvg(THEME_ICON)}<span class="more-theme-label"></span></button>
      <button type="button" class="more-item danger" id="moreLogoutBtn">${iconSvg(LOGOUT_ICON)}<span>Log out</span></button>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', e => { if (e.target === overlay) closeMoreSheet(); });
  // More ways out than tapping the dimmed edge (Oct 2026): a Close button, the
  // grabber bar, Escape, and the phone's own Back button.
  document.getElementById('moreCloseBtn').addEventListener('click', () => closeMoreSheet());
  overlay.querySelector('.more-grabber').addEventListener('click', () => closeMoreSheet());
  // Going to a page from the menu REPLACES the menu's history step, so Back
  // on the new page returns to the page you were on, not to a closed menu.
  overlay.querySelectorAll('a.more-item').forEach(a => a.addEventListener('click', e => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    location.replace(a.href);
  }));
  document.getElementById('moreThemeBtn').addEventListener('click', () => { cycleTheme(); updateMoreThemeLabel(); });
  document.getElementById('moreLogoutBtn').addEventListener('click', logout);
  updateMoreThemeLabel();
  // Remember which sections were folded away.
  overlay.querySelectorAll('.more-group').forEach(d => d.addEventListener('toggle', () => {
    if (overlay.dataset.searching) return;
    const shut = [...overlay.querySelectorAll('.more-group:not([open])')].map(x => x.dataset.group);
    try { localStorage.setItem('moreFolded', JSON.stringify(shut)); } catch (e) {}
  }));
  const q = document.getElementById('moreSearch');
  if (q) q.addEventListener('input', () => {
    const v = q.value.trim().toLowerCase();
    overlay.dataset.searching = v ? '1' : '';
    let any = false;
    overlay.querySelectorAll('.more-group').forEach(d => {
      let hit = 0;
      d.querySelectorAll('.more-item').forEach(a => { const m = !v || a.dataset.label.includes(v); a.style.display = m ? '' : 'none'; if (m) hit += 1; });
      d.style.display = hit ? '' : 'none';
      if (v && hit) d.open = true;
      if (hit) any = true;
    });
    if (!v) { let f = []; try { f = JSON.parse(localStorage.getItem('moreFolded') || '[]'); } catch (e) {} overlay.querySelectorAll('.more-group').forEach(d => { if (!d.querySelector('.more-item.active')) d.open = !f.includes(d.dataset.group); }); }
    document.getElementById('moreNone').style.display = any ? 'none' : '';
  });
}

// Append unread-count chips to every "Notifications" nav entry (desktop
// sidebar + mobile More sheet) and a dot on the mobile More tab itself.
// Live unread-messages badge on the Messages nav entry (sidebar + More sheet).
// Polls so the count stays current on any page.
function updateMessagesBadge(unread) {
  document.querySelectorAll('.nav-link, .more-item').forEach(el => {
    const label = el.querySelector('.label, span:last-child');
    const isMsg = (el.getAttribute('onclick') || '').includes('messages.html')
      || (el.getAttribute('href') || '').includes('messages.html')
      || (label && label.textContent.trim() === 'Messages');
    if (!isMsg) return;
    let b = el.querySelector('.nav-badge');
    if (unread > 0) {
      if (b) b.textContent = unread > 99 ? '99+' : unread;
      else el.insertAdjacentHTML('beforeend', `<span class="nav-badge">${unread > 99 ? '99+' : unread}</span>`);
    } else if (b) { b.remove(); }
  });
}
function startMessagesBadge() {
  const tick = () => api('/messages/unread').then(r => updateMessagesBadge(r.count || 0)).catch(() => {});
  tick();
  setInterval(tick, 20000);
}

// ---- Member photo field (shared by the Committees/Groups member modal) ----
// State: undefined = leave unchanged, '' = remove, data-URL = new photo.
let _memberPhoto;
function downscaleImage(file, max) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const im = new Image();
      im.onload = () => {
        let w = im.width, h = im.height;
        if (w > h && w > max) { h = Math.round(h * max / w); w = max; }
        else if (h > max) { w = Math.round(w * max / h); h = max; }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(im, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', 0.82));
      };
      im.onerror = reject; im.src = r.result;
    };
    r.onerror = reject; r.readAsDataURL(file);
  });
}
function resetMemberPhotoField() {
  _memberPhoto = undefined;
  const img = document.getElementById('mPhotoPreview'), rm = document.getElementById('mPhotoRemove');
  if (img) { img.style.display = 'none'; img.removeAttribute('src'); }
  if (rm) rm.style.display = 'none';
}
function showMemberPhotoFor(id) {
  _memberPhoto = undefined; // unchanged until the user picks/removes
  const img = document.getElementById('mPhotoPreview'), rm = document.getElementById('mPhotoRemove');
  if (!img) return;
  img.onload = () => { img.style.display = ''; if (rm) rm.style.display = ''; };
  img.onerror = () => { img.style.display = 'none'; if (rm) rm.style.display = 'none'; };
  img.src = `/api/setup/members/${id}/photo?t=${Date.now()}`;
}
function getMemberPhoto() { return _memberPhoto; }
function initMemberPhotoField() {
  const btn = document.getElementById('mPhotoBtn');
  if (!btn) return; // not on this page
  const input = document.getElementById('mPhotoInput');
  const img = document.getElementById('mPhotoPreview');
  const rm = document.getElementById('mPhotoRemove');
  btn.onclick = () => input.click();
  input.onchange = async () => {
    const f = input.files && input.files[0];
    if (!f) return;
    try {
      _memberPhoto = await downscaleImage(f, 480);
      img.src = _memberPhoto; img.style.display = ''; rm.style.display = '';
    } catch (e) { toast('Could not read that image.', true); }
    input.value = '';
  };
  rm.onclick = () => { _memberPhoto = ''; img.style.display = 'none'; img.removeAttribute('src'); rm.style.display = 'none'; };
}

// Fetch & open a committee/group's member QR-card sheet (cookie-auth), with a
// download fallback if the pop-up is blocked and a clean toast on any error.
async function printMemberCards(entityType, entityId, name) {
  try {
    const res = await fetch(`/api/checkin/cards.pdf?entityType=${entityType}&entityId=${entityId}`, { credentials: 'same-origin' });
    if (!res.ok) {
      let msg = 'Could not generate member cards.';
      try { msg = (await res.json()).error || msg; } catch (e) {}
      throw new Error(msg);
    }
    const url = URL.createObjectURL(await res.blob());
    const win = window.open(url, '_blank');
    if (!win) {
      const a = document.createElement('a');
      a.href = url; a.download = `${(name || 'members').replace(/\s+/g, '_')}_QR_cards.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`QR cards ready${name ? ' for ' + name : ''}.`);
  } catch (e) { toast(e.message, true); }
}

// Which sidebar sections this person has folded away, kept in this browser.
const NAV_FOLD_KEY = 'aotc-nav-folded';
function navFoldedSet() {
  try { return new Set(JSON.parse(localStorage.getItem(NAV_FOLD_KEY) || '[]')); } catch (e) { return new Set(); }
}
function toggleNavSection(btn) {
  const g = btn.closest('.nav-group');
  if (!g) return;
  const shut = !g.classList.contains('folded');
  g.classList.toggle('folded', shut);
  btn.setAttribute('aria-expanded', shut ? 'false' : 'true');
  const set = navFoldedSet();
  if (shut) set.add(g.dataset.sec); else set.delete(g.dataset.sec);
  try { localStorage.setItem(NAV_FOLD_KEY, JSON.stringify([...set])); } catch (e) {}
}

function decorateInboxBadges(unread) {
  if (!unread) return;
  const chip = `<span class="nav-badge">${unread > 99 ? '99+' : unread}</span>`;
  document.querySelectorAll('.nav-link, .more-item').forEach(el => {
    const label = el.querySelector('.label, span:last-child');
    const isNotif = (el.getAttribute('onclick') || '').includes('notifications.html')
      || (el.getAttribute('href') || '').includes('notifications.html')
      || (label && label.textContent.trim() === 'Notifications');
    if (isNotif && !el.querySelector('.nav-badge')) el.insertAdjacentHTML('beforeend', chip);
  });
  const moreBtn = document.getElementById('moreTabBtn');
  if (moreBtn && !moreBtn.querySelector('.tab-dot')) {
    moreBtn.insertAdjacentHTML('beforeend', '<span class="tab-dot"></span>');
  }
}

function updateMoreThemeLabel() {
  const el = document.querySelector('.more-theme-label');
  if (!el) return;
  const pref = getThemePref();
  el.textContent = 'Theme: ' + pref.charAt(0).toUpperCase() + pref.slice(1);
}

function openMoreSheet() {
  const o = document.getElementById('moreSheetOverlay');
  if (!o || o.style.display === 'flex') return;
  o.style.display = 'flex';
  // A history step, so the phone's Back button closes the menu instead of
  // leaving the page.
  try { history.pushState({ moreSheet: true }, ''); } catch (e) {}
}
function closeMoreSheet(fromPopState) {
  const o = document.getElementById('moreSheetOverlay');
  if (!o || o.style.display === 'none') return;
  o.style.display = 'none';
  if (!fromPopState && history.state && history.state.moreSheet) history.back();
}
window.addEventListener('popstate', () => closeMoreSheet(true));
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMoreSheet(); });

async function requireAuthAndRenderShell(activeHref) {
  // A page that does not say which it is (the dashboard) is the page it is on,
  // so Home is lit in the sidebar and on the phone's tab bar.
  if (!activeHref) activeHref = location.pathname === '/' ? '/index.html' : location.pathname;
  let user;
  try {
    user = await api('/auth/me');
  } catch (e) {
    window.location.href = '/login.html';
    return null;
  }

  const items = visibleNavItems(user);

  // Multi-workspace people get a switcher + per-entity nav; everyone else [] .
  const ws = await resolveWorkspaces(user);
  const multiWs = ws.length > 0;
  if (multiWs) injectWorkspaceStyles();

  // Desktop sidebar
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    let lastSection = null;
    // With a workspace switcher, the generic Committees/Groups items are
    // replaced by the per-entity "My Committee(s)/My Group(s)" sections below,
    // so drop them from the generic list to avoid showing them twice.
    const listItems = multiWs
      ? items.filter(i => i.href !== '/committees.html' && i.href !== '/groups.html')
      : items;
    // Sections fold away (Oct 2026): a section's heading opens and closes it,
    // and each person's choice is remembered on this device. The section
    // holding the page you are on always opens, so you never lose your place.
    const folded = navFoldedSet();
    const groups = [];
    listItems.forEach(item => {
      const sec = item.section || '';
      let g = groups[groups.length - 1];
      if (!g || g.sec !== sec || !sec) { g = { sec, items: [] }; groups.push(g); }
      g.items.push(item);
    });
    const linkHtml = item => `<div class="nav-link ${item.href === activeHref ? 'active' : ''}" onclick="location.href='${item.href}'">${iconSvg(item.icon)}<span class="label">${item.label}</span></div>`;
    const links = groups.map(g => {
      if (!g.sec) return g.items.map(linkHtml).join('');
      const here = g.items.some(i => i.href === activeHref);
      const shut = folded.has(g.sec) && !here;
      return `<div class="nav-group ${shut ? 'folded' : ''}" data-sec="${esc(g.sec)}">
        <button type="button" class="nav-section" aria-expanded="${shut ? 'false' : 'true'}" onclick="toggleNavSection(this)">
          <span>${g.sec}</span><span class="nav-fold-n">${g.items.length}</span><svg class="nav-chev" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
        <div class="nav-items"><div>${g.items.map(linkHtml).join('')}</div></div></div>`;
    }).join('');
    void lastSection;
    sidebar.innerHTML = `
      <img src="/img/logo.png" alt="AOTC Track" class="side-logo">
      <div class="brand">AOTC Track</div>
      <div class="brand-sub">PCG — Adabraka Official Town Congregation</div>
      ${multiWs ? `<div class="ws-top"><div class="ws-top-name">${esc(user.name)}</div>${workspaceSwitcherHtml(ws, 'wsSwitcher')}</div>` : ''}
      ${multiWs ? workspaceNavHtml(ws, activeHref) : ''}
      ${links}
      <button type="button" class="cmdk-kbtn" onclick="openCommandPalette()">🔍 Search… <kbd>⌘K</kbd></button>
      <div class="spacer"></div>
      <button class="theme-toggle-btn" id="themeToggleBtn" onclick="cycleTheme()" title="Cycle theme: Auto / Light / Dark">
        ${iconSvg('M12 3v2M12 19v2M5 5l1.4 1.4M17.6 17.6L19 19M3 12h2M19 12h2M5 19l1.4-1.4M17.6 6.4L19 5M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z')}
        <span class="theme-toggle-label">Auto</span>
      </button>
      <!-- Installed from the browser (the Mac's Dock, a phone's home screen) the
           app has no browser bar and no pull-to-refresh, so it carries its own. -->
      <button class="theme-toggle-btn" id="refreshPageBtn" onclick="location.reload()" title="Reload this page (⌘R / Ctrl+R)">
        ${iconSvg('M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15')}
        <span class="theme-toggle-label">Refresh page</span>
      </button>
      <div class="user-box">
        <div class="u-name">${user.name}</div>
        <div class="role-tag">${esc(roleLabel(user.role))}</div>
        <div class="entity-tag" id="entityTag"></div>
        <button class="logout-btn" onclick="logout()">Log out</button>
        <a class="side-ver" href="/about.html" title="About, version and What’s new">AOTC Track <span class="app-ver">${window.APP_RUNNING_VERSION ? esc(window.APP_RUNNING_VERSION) : ''}</span> · About</a>
      </div>
    `;
    applyTheme();
  }

  // Mobile bottom tab bar — 4 primary tabs + a "More" tab that opens a sheet
  // holding every remaining page plus the theme toggle and log out (which
  // otherwise live only in the desktop sidebar and were unreachable on phones).
  const tabbar = document.getElementById('tabbar');
  if (tabbar) {
    const primary = items.slice(0, 4);
    const overflow = items.slice(4);
    const activeInOverflow = overflow.some(i => i.href === activeHref);
    const tabs = primary
      .map(item => `<a class="tab ${item.href === activeHref ? 'active' : ''}" href="${item.href}">${iconSvg(item.icon)}<span>${item.label}</span></a>`)
      .join('');
    const moreTab = `<button type="button" class="tab more-tab ${activeInOverflow ? 'active' : ''}" id="moreTabBtn" aria-label="More">${iconSvg('M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z')}<span>More</span></button>`;
    tabbar.innerHTML = tabs + moreTab;
    buildMoreSheet(overflow, activeHref, user, multiWs ? ws : []);
    const moreBtn = document.getElementById('moreTabBtn');
    if (moreBtn) moreBtn.addEventListener('click', openMoreSheet);
  }

  // Unread-notification badges: count chip on the sidebar/More-sheet
  // "Notifications" entries, plus a dot on the mobile More tab so the count
  // is discoverable without opening the sheet.
  decorateInboxBadges(user.unreadNotifications || 0);

  // Currency symbol comes from Settings (falls back to GHS if it can't be read).
  api('/settings').then(s => setCurrencySymbol(s.currencySymbol)).catch(() => {});

  // expose for the command palette's permission filtering
  window.currentPaletteUser = user;
  // AOTC Track: resolve the user's committee/group so every page can show it.
  window.myEntity = null;
  if (user.entity && user.entity.type && user.entity.type !== 'congregation') {
    try {
      const list = await api(user.entity.type === 'committee' ? '/setup/committees' : '/setup/groups');
      const rec = list.find(x => x.id === Number(user.entity.id));
      if (rec) {
        window.myEntity = { ...user.entity, name: rec.name, code: rec.code };
        const tag = document.getElementById('entityTag');
        if (tag) tag.textContent = rec.name;
        document.title = document.title.replace(' — AOTC Track', ` — ${rec.code} · AOTC Track`);
      }
    } catch (e) { /* non-fatal */ }
  }

  addAppFooter();

  // Tag any tables already in the page (and watch for re-renders) so they
  // collapse into stacked cards on narrow screens. Also watch for tables
  // that pages build later (Annual Plan, Quarterly Entry, etc.).
  initResponsiveTables();
  initColumnToggle();
  watchForNewTables();

  // Push notifications: register the service worker, and if this device has
  // already granted permission, quietly keep its subscription fresh.
  initPushQuietly();

  // Live unread-messages badge on the Messages nav item.
  startMessagesBadge();

  // Wire the member-photo field if this page's member modal has one.
  initMemberPhotoField();

  return user;
}

// ---- Device push notifications ----
function urlB64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function initPushQuietly() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    if (!('PushManager' in window) || Notification.permission !== 'granted') return;
    await subscribeToPush(reg); // refresh existing grant silently
  } catch (e) { /* non-fatal */ }
}

// ---- Notification navigation ----
// The service worker forwards two messages: 'aotc-nav' when the user TAPS a
// notification (go to the area of attention now), and 'aotc-push' when one
// ARRIVES while the app is open (show a banner so they choose when to jump).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', e => {
    const d = e.data || {};
    if (d.type === 'aotc-nav' && d.url) gotoNotification(d.url);
    else if (d.type === 'aotc-push' && d.url) showPushBanner(d);
  });
}

// Take the user to a notification's target. If a form modal is open (the one
// place unsaved work lives — inline fields elsewhere autosave on change), ask
// first with Go now / Stay; otherwise navigate immediately.
async function gotoNotification(url) {
  if (!url) return;
  let target;
  try { target = new URL(url, location.origin); } catch (e) { location.assign(url); return; }
  const modalOpen = Array.from(document.querySelectorAll('.modal-overlay, .sheet-overlay'))
    .some(el => el.getClientRects().length > 0);
  if (modalOpen) {
    const go = await confirmDialog('You have a form open here — anything unsaved will be lost. Go to the notification now?', {
      title: 'Go to notification?', okText: 'Go now', cancelText: 'Stay here', danger: false,
    });
    if (!go) return;
  }
  if (target.pathname + target.search === location.pathname + location.search) location.reload();
  else location.assign(target.href);
}

// Small tappable banner when a notification arrives while the app is open.
let _pushBannerEl = null;
function showPushBanner(d) {
  try { if (new URL(d.url, location.origin).pathname === location.pathname) return; } catch (e) {}
  if (_pushBannerEl) _pushBannerEl.remove();
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'push-banner';
  b.innerHTML = `<span class="pb-dot">🔔</span><span class="pb-text"><b>${esc(d.title || 'AOTC Track')}</b>${d.body ? `<span class="pb-body">${esc(d.body)}</span>` : ''}</span><span class="pb-open">Open</span>`;
  b.onclick = () => { b.remove(); _pushBannerEl = null; gotoNotification(d.url); };
  document.body.appendChild(b);
  _pushBannerEl = b;
  setTimeout(() => { if (_pushBannerEl === b) { b.remove(); _pushBannerEl = null; } }, 12000);
}

// Ask for permission (must be called from a user gesture) and subscribe.
// Returns true when subscribed.
async function enablePushOnThisDevice() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    throw new Error('This browser does not support push notifications.');
  }
  const { key, configured } = await api('/push/public-key');
  if (!configured) throw new Error('Push notifications are not configured on the server yet.');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were not allowed on this device.');
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  return subscribeToPush(reg, key);
}

async function subscribeToPush(reg, key) {
  if (!key) {
    const r = await api('/push/public-key');
    if (!r.configured) return false;
    key = r.key;
  }
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlB64ToUint8Array(key),
    });
  }
  await api('/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  return true;
}

async function disablePushOnThisDevice() {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg && await reg.pushManager.getSubscription();
  if (sub) {
    try { await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); } catch (e) {}
    await sub.unsubscribe();
  }
}

function addAppFooter() {
  const main = document.querySelector('.main');
  if (!main || document.getElementById('appFooter')) return;
  const footer = document.createElement('div');
  footer.id = 'appFooter';
  footer.className = 'app-footer';
  footer.innerHTML = `© ${new Date().getFullYear()} DeonTech Systems. All rights reserved. &middot; <a href="/about.html">About AOTC Track <span class="app-ver">${window.APP_RUNNING_VERSION ? esc(window.APP_RUNNING_VERSION) : ''}</span></a>`;
  main.appendChild(footer);
}

// ---- Ghana's 16 regions (since the 2019 split) ----
const GH_REGIONS = [
  'Ahafo', 'Ashanti', 'Bono', 'Bono East', 'Central', 'Eastern', 'Greater Accra',
  'North East', 'Northern', 'Oti', 'Savannah', 'Upper East', 'Upper West',
  'Volta', 'Western', 'Western North',
];

function regionSelectOptions(selected) {
  return '<option value="">Select region...</option>' +
    GH_REGIONS.map(r => `<option value="${r}" ${r === selected ? 'selected' : ''}>${r}</option>`).join('');
}

// ---- Countries + calling codes, for phone numbers entered with a country selector ----
// (name, ISO 3166-1 alpha-2, E.164 calling code). Ghana is listed first / default.
const COUNTRIES = [
  { name: 'Ghana', iso2: 'GH', dial: '+233' },
  { name: 'Nigeria', iso2: 'NG', dial: '+234' },
  { name: 'Togo', iso2: 'TG', dial: '+228' },
  { name: "Côte d'Ivoire", iso2: 'CI', dial: '+225' },
  { name: 'Burkina Faso', iso2: 'BF', dial: '+226' },
  { name: 'Benin', iso2: 'BJ', dial: '+229' },
  { name: 'Senegal', iso2: 'SN', dial: '+221' },
  { name: 'Mali', iso2: 'ML', dial: '+223' },
  { name: 'Niger', iso2: 'NE', dial: '+227' },
  { name: 'Sierra Leone', iso2: 'SL', dial: '+232' },
  { name: 'Liberia', iso2: 'LR', dial: '+231' },
  { name: 'Guinea', iso2: 'GN', dial: '+224' },
  { name: 'Guinea-Bissau', iso2: 'GW', dial: '+245' },
  { name: 'Gambia', iso2: 'GM', dial: '+220' },
  { name: 'Cape Verde', iso2: 'CV', dial: '+238' },
  { name: 'Mauritania', iso2: 'MR', dial: '+222' },
  { name: 'Cameroon', iso2: 'CM', dial: '+237' },
  { name: 'Chad', iso2: 'TD', dial: '+235' },
  { name: 'Central African Republic', iso2: 'CF', dial: '+236' },
  { name: 'Gabon', iso2: 'GA', dial: '+241' },
  { name: 'Congo (Republic)', iso2: 'CG', dial: '+242' },
  { name: 'Congo (DRC)', iso2: 'CD', dial: '+243' },
  { name: 'Equatorial Guinea', iso2: 'GQ', dial: '+240' },
  { name: 'São Tomé and Príncipe', iso2: 'ST', dial: '+239' },
  { name: 'Angola', iso2: 'AO', dial: '+244' },
  { name: 'Zambia', iso2: 'ZM', dial: '+260' },
  { name: 'Zimbabwe', iso2: 'ZW', dial: '+263' },
  { name: 'Namibia', iso2: 'NA', dial: '+264' },
  { name: 'Botswana', iso2: 'BW', dial: '+267' },
  { name: 'South Africa', iso2: 'ZA', dial: '+27' },
  { name: 'Lesotho', iso2: 'LS', dial: '+266' },
  { name: 'Eswatini', iso2: 'SZ', dial: '+268' },
  { name: 'Mozambique', iso2: 'MZ', dial: '+258' },
  { name: 'Malawi', iso2: 'MW', dial: '+265' },
  { name: 'Madagascar', iso2: 'MG', dial: '+261' },
  { name: 'Mauritius', iso2: 'MU', dial: '+230' },
  { name: 'Seychelles', iso2: 'SC', dial: '+248' },
  { name: 'Comoros', iso2: 'KM', dial: '+269' },
  { name: 'Tanzania', iso2: 'TZ', dial: '+255' },
  { name: 'Kenya', iso2: 'KE', dial: '+254' },
  { name: 'Uganda', iso2: 'UG', dial: '+256' },
  { name: 'Rwanda', iso2: 'RW', dial: '+250' },
  { name: 'Burundi', iso2: 'BI', dial: '+257' },
  { name: 'South Sudan', iso2: 'SS', dial: '+211' },
  { name: 'Ethiopia', iso2: 'ET', dial: '+251' },
  { name: 'Eritrea', iso2: 'ER', dial: '+291' },
  { name: 'Djibouti', iso2: 'DJ', dial: '+253' },
  { name: 'Somalia', iso2: 'SO', dial: '+252' },
  { name: 'Sudan', iso2: 'SD', dial: '+249' },
  { name: 'Egypt', iso2: 'EG', dial: '+20' },
  { name: 'Libya', iso2: 'LY', dial: '+218' },
  { name: 'Tunisia', iso2: 'TN', dial: '+216' },
  { name: 'Algeria', iso2: 'DZ', dial: '+213' },
  { name: 'Morocco', iso2: 'MA', dial: '+212' },
  { name: 'United Kingdom', iso2: 'GB', dial: '+44' },
  { name: 'Ireland', iso2: 'IE', dial: '+353' },
  { name: 'France', iso2: 'FR', dial: '+33' },
  { name: 'Germany', iso2: 'DE', dial: '+49' },
  { name: 'Netherlands', iso2: 'NL', dial: '+31' },
  { name: 'Belgium', iso2: 'BE', dial: '+32' },
  { name: 'Switzerland', iso2: 'CH', dial: '+41' },
  { name: 'Austria', iso2: 'AT', dial: '+43' },
  { name: 'Spain', iso2: 'ES', dial: '+34' },
  { name: 'Portugal', iso2: 'PT', dial: '+351' },
  { name: 'Italy', iso2: 'IT', dial: '+39' },
  { name: 'Greece', iso2: 'GR', dial: '+30' },
  { name: 'Sweden', iso2: 'SE', dial: '+46' },
  { name: 'Norway', iso2: 'NO', dial: '+47' },
  { name: 'Denmark', iso2: 'DK', dial: '+45' },
  { name: 'Finland', iso2: 'FI', dial: '+358' },
  { name: 'Iceland', iso2: 'IS', dial: '+354' },
  { name: 'Poland', iso2: 'PL', dial: '+48' },
  { name: 'Czechia', iso2: 'CZ', dial: '+420' },
  { name: 'Slovakia', iso2: 'SK', dial: '+421' },
  { name: 'Hungary', iso2: 'HU', dial: '+36' },
  { name: 'Romania', iso2: 'RO', dial: '+40' },
  { name: 'Bulgaria', iso2: 'BG', dial: '+359' },
  { name: 'Ukraine', iso2: 'UA', dial: '+380' },
  { name: 'Russia', iso2: 'RU', dial: '+7' },
  { name: 'Turkey', iso2: 'TR', dial: '+90' },
  { name: 'Israel', iso2: 'IL', dial: '+972' },
  { name: 'United Arab Emirates', iso2: 'AE', dial: '+971' },
  { name: 'Saudi Arabia', iso2: 'SA', dial: '+966' },
  { name: 'Qatar', iso2: 'QA', dial: '+974' },
  { name: 'Kuwait', iso2: 'KW', dial: '+965' },
  { name: 'Lebanon', iso2: 'LB', dial: '+961' },
  { name: 'Jordan', iso2: 'JO', dial: '+962' },
  { name: 'India', iso2: 'IN', dial: '+91' },
  { name: 'Pakistan', iso2: 'PK', dial: '+92' },
  { name: 'Bangladesh', iso2: 'BD', dial: '+880' },
  { name: 'China', iso2: 'CN', dial: '+86' },
  { name: 'Japan', iso2: 'JP', dial: '+81' },
  { name: 'South Korea', iso2: 'KR', dial: '+82' },
  { name: 'Philippines', iso2: 'PH', dial: '+63' },
  { name: 'Indonesia', iso2: 'ID', dial: '+62' },
  { name: 'Malaysia', iso2: 'MY', dial: '+60' },
  { name: 'Singapore', iso2: 'SG', dial: '+65' },
  { name: 'Thailand', iso2: 'TH', dial: '+66' },
  { name: 'Vietnam', iso2: 'VN', dial: '+84' },
  { name: 'Australia', iso2: 'AU', dial: '+61' },
  { name: 'New Zealand', iso2: 'NZ', dial: '+64' },
  { name: 'United States', iso2: 'US', dial: '+1' },
  { name: 'Canada', iso2: 'CA', dial: '+1' },
  { name: 'Mexico', iso2: 'MX', dial: '+52' },
  { name: 'Brazil', iso2: 'BR', dial: '+55' },
  { name: 'Argentina', iso2: 'AR', dial: '+54' },
  { name: 'Jamaica', iso2: 'JM', dial: '+1' },
];

function countrySelectOptions(selectedDial) {
  return COUNTRIES.map(c =>
    `<option value="${c.dial}" ${c.dial === selectedDial ? 'selected' : ''}>${c.name} (${c.dial})</option>`
  ).join('');
}

// ITU-T E.123 international notation: the trunk "0" is shown in brackets
// because it's dialled locally but dropped when dialling internationally —
// e.g. stored as country "+233" + local "0244123456" displays as "+233 (0)244123456".
function formatPhoneDisplay(dial, localNumber) {
  if (!localNumber) return '';
  const digits = String(localNumber).replace(/\D/g, '');
  const withoutLeadingZero = digits.replace(/^0+/, '');
  if (!dial) return localNumber;
  return `${dial} (0)${withoutLeadingZero}`;
}

// ---- Password strength guide (mirrors utils/passwordPolicy.js server-side rules) ----
const PASSWORD_RULES = [
  { key: 'length', label: 'At least 10 characters', test: pw => pw.length >= 10 },
  { key: 'upper', label: 'One uppercase letter (A-Z)', test: pw => /[A-Z]/.test(pw) },
  { key: 'lower', label: 'One lowercase letter (a-z)', test: pw => /[a-z]/.test(pw) },
  { key: 'number', label: 'One number (0-9)', test: pw => /[0-9]/.test(pw) },
  { key: 'symbol', label: 'One symbol (e.g. ! @ # $ %)', test: pw => /[^A-Za-z0-9]/.test(pw) },
];

function passwordChecklistHtml(pw) {
  const results = PASSWORD_RULES.map(r => ({ ...r, ok: r.test(pw || '') }));
  const passed = results.filter(r => r.ok).length;
  const pct = Math.round((passed / PASSWORD_RULES.length) * 100);
  const strengthLabel = passed <= 2 ? 'Weak' : passed <= 4 ? 'Okay' : 'Strong';
  const strengthClass = passed <= 2 ? 'weak' : passed <= 4 ? 'okay' : 'strong';
  return `
    <div class="pw-meter">
      <div class="pw-meter-bar"><div class="pw-meter-fill ${strengthClass}" style="width:${pct}%"></div></div>
      <div class="pw-meter-label ${strengthClass}">${pw ? strengthLabel : 'Enter a password'}</div>
      <ul class="pw-rules">
        ${results.map(r => `<li class="${r.ok ? 'ok' : ''}">${r.ok ? '✓' : '○'} ${r.label}</li>`).join('')}
      </ul>
    </div>`;
}

function wirePasswordMeter(inputEl, containerEl) {
  const update = () => { containerEl.innerHTML = passwordChecklistHtml(inputEl.value); };
  inputEl.addEventListener('input', update);
  update();
}

// ---- CSV export ----
// columns = [{ key: 'name', label: 'Name' }, ...]. Values are read via row[key].
function toCsvValue(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function exportCsv(filename, rows, columns) {
  const header = columns.map(c => toCsvValue(c.label)).join(',');
  const body = rows.map(row => columns.map(c => toCsvValue(row[c.key])).join(',')).join('\n');
  const csv = header + '\n' + body;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Minimal CSV parser (handles quoted fields with commas/newlines). Returns
// an array of objects keyed by the header row.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && next === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter(r => r.length > 1 || (r[0] || '').trim() !== '');
  if (nonEmpty.length === 0) return [];
  const headers = nonEmpty[0].map(h => h.trim());
  return nonEmpty.slice(1).map(r => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (r[i] || '').trim(); });
    return obj;
  });
}

// ---- Hold-to-reveal password toggle ----
// Masking a password only guards against someone glancing at the screen —
// it doesn't change how the password is sent or stored, so there's no real
// security cost to letting a user check what they typed. To keep the
// shoulder-surfing risk as small as possible though, this only reveals the
// password while the button is actively held down (mouse, touch, or
// keyboard); it re-masks the instant it's released. Runs automatically on
// every page and wraps any input[type=password] it finds, so no per-page
// markup is needed (covers login, account, and reset-password forms).
function wirePasswordReveal() {
  document.querySelectorAll('input[type="password"]').forEach(input => {
    if (input.closest('.pw-field')) return; // already wired
    const wrap = document.createElement('div');
    wrap.className = 'pw-field';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.setAttribute('aria-label', 'Hold to show password');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
    wrap.appendChild(btn);

    const show = () => { input.type = 'text'; btn.classList.add('revealing'); };
    const hide = () => { input.type = 'password'; btn.classList.remove('revealing'); };

    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (btn.setPointerCapture) btn.setPointerCapture(e.pointerId);
      show();
    });
    btn.addEventListener('pointerup', hide);
    btn.addEventListener('pointercancel', hide);
    btn.addEventListener('pointerleave', hide);
    btn.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); show(); }
    });
    btn.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') hide();
    });
    btn.addEventListener('blur', hide);
  });
}
wirePasswordReveal();

// ---- Type-to-confirm destructive action modal ----
// Used for admin "delete permanently" actions (invoices, job cards,
// customers) where the record is genuinely gone afterward, not just
// voided/cancelled. The caller must type the record's own reference (invoice
// number, job number, customer name) back before the button becomes
// clickable, so a stray click can't destroy a real record. Built once,
// lazily, and reused across whichever page calls it.
let _cdmEls = null;
function _ensureConfirmDeleteModal() {
  if (_cdmEls) return _cdmEls;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.style.display = 'none';
  overlay.innerHTML =
    `<div class="modal" style="width:420px;">` +
      `<h2 id="cdmTitle">Delete permanently</h2>` +
      `<p class="sub" id="cdmMessage" style="margin:8px 0 14px;"></p>` +
      `<div class="field"><label id="cdmLabel">Type to confirm</label><input type="text" id="cdmInput" autocomplete="off"></div>` +
      `<div class="login-error" id="cdmError"></div>` +
      `<div class="modal-actions">` +
        `<button type="button" class="btn btn-secondary" id="cdmCancelBtn">Cancel</button>` +
        `<button type="button" class="btn btn-danger" id="cdmConfirmBtn" disabled>Delete permanently</button>` +
      `</div>` +
    `</div>`;
  document.body.appendChild(overlay);
  _cdmEls = {
    overlay,
    title: overlay.querySelector('#cdmTitle'),
    message: overlay.querySelector('#cdmMessage'),
    label: overlay.querySelector('#cdmLabel'),
    input: overlay.querySelector('#cdmInput'),
    error: overlay.querySelector('#cdmError'),
    cancelBtn: overlay.querySelector('#cdmCancelBtn'),
    confirmBtn: overlay.querySelector('#cdmConfirmBtn'),
  };
  _cdmEls.cancelBtn.addEventListener('click', () => { _cdmEls.overlay.style.display = 'none'; });
  return _cdmEls;
}

// opts: { title, message, confirmText, onConfirm } — onConfirm may be async;
// throw/reject with a .message to show an inline error instead of closing.
function confirmTypedDelete(opts) {
  const els = _ensureConfirmDeleteModal();
  const confirmText = opts.confirmText;
  els.title.textContent = opts.title || 'Delete permanently';
  els.message.textContent = opts.message || '';
  els.label.textContent = `Type "${confirmText}" to confirm`;
  els.error.textContent = '';
  els.overlay.style.display = 'flex';

  // Swap the input/button for fresh clones each time this opens, so
  // listeners from a previous record don't stack up or fire against the
  // wrong onConfirm callback.
  const newInput = els.input.cloneNode(true);
  els.input.replaceWith(newInput);
  els.input = newInput;
  els.input.value = '';
  const newConfirmBtn = els.confirmBtn.cloneNode(true);
  els.confirmBtn.replaceWith(newConfirmBtn);
  els.confirmBtn = newConfirmBtn;
  els.confirmBtn.disabled = true;

  els.input.addEventListener('input', () => {
    els.confirmBtn.disabled = els.input.value.trim() !== confirmText;
  });
  els.confirmBtn.addEventListener('click', async () => {
    els.error.textContent = '';
    els.confirmBtn.disabled = true;
    try {
      await opts.onConfirm();
      els.overlay.style.display = 'none';
    } catch (e) {
      els.error.textContent = e.message || 'Something went wrong.';
      els.confirmBtn.disabled = els.input.value.trim() !== confirmText;
    }
  });
  els.input.focus();
}

async function logout() {
  await api('/auth/logout', { method: 'POST' });
  window.location.href = '/login.html';
}

// ============================ Row actions menu ============================
// One compact "Actions ▾" button per table row instead of a strip of eight
// buttons (2026-07-11, per Gideon — the button strip was squeezing the № /
// name columns into nothing). showActionsMenu(anchorEl, items) pops a small
// dropdown by the button; items are { label, onClick, href, target, title,
// primary, danger } (falsy entries are skipped, the string 'divider' draws a
// rule). The menu is position:fixed and appended to <body>, so it never gets
// clipped by the table card's overflow scrolling on mobile; it closes on
// outside click, Escape, scroll, or resize. Clicking the same anchor again
// toggles it shut.
let _actionsMenuEl = null;
function closeActionsMenu() {
  if (_actionsMenuEl) { _actionsMenuEl.remove(); _actionsMenuEl = null; }
}
function showActionsMenu(anchorEl, items) {
  if (_actionsMenuEl && _actionsMenuEl._anchor === anchorEl) { closeActionsMenu(); return; }
  closeActionsMenu();
  const menu = document.createElement('div');
  menu.className = 'actions-menu';
  menu._anchor = anchorEl;
  items.filter(Boolean).forEach(it => {
    if (it === 'divider') {
      const d = document.createElement('div');
      d.className = 'actions-menu-divider';
      menu.appendChild(d);
      return;
    }
    const el = document.createElement(it.href ? 'a' : 'button');
    if (!it.href) el.type = 'button';
    else { el.href = it.href; el.target = it.target || '_blank'; el.rel = 'noopener'; }
    el.className = 'actions-menu-item' + (it.danger ? ' danger' : '') + (it.primary ? ' primary' : '');
    el.textContent = it.label;
    if (it.title) el.title = it.title;
    el.addEventListener('click', () => { closeActionsMenu(); if (it.onClick) it.onClick(); });
    menu.appendChild(el);
  });
  document.body.appendChild(menu);
  // Right-align under the button; flip above it if there's no room below.
  menu.style.visibility = 'hidden';
  const r = anchorEl.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8));
  let top = r.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - menu.offsetHeight - 4);
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
  menu.style.visibility = '';
  _actionsMenuEl = menu;
}
document.addEventListener('click', (e) => {
  if (_actionsMenuEl && !_actionsMenuEl.contains(e.target) && !_actionsMenuEl._anchor.contains(e.target)) closeActionsMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeActionsMenu(); });
window.addEventListener('scroll', closeActionsMenu, true);
window.addEventListener('resize', closeActionsMenu);

// ============================ Bulk selection ============================
// Reusable multi-select toolbar shared by the Invoices / Job cards /
// Customers / Inventory lists. A page opts in by (1) putting an
// <input type="checkbox" class="bulk-all"> in its table header, (2)
// rendering <input type="checkbox" class="bulk-cb" value="<id>"> as the
// first cell of each row, (3) calling createBulkBar({...}) once, and (4)
// calling bar.sync() after every time it re-renders the table body.
//
// Selection state is held here as a Set of id strings; a floating bar shows
// the count + the page's action buttons and only appears when ≥1 is selected.
function createBulkBar({ entityLabel, entityLabelPlural, actions, isAdmin }) {
  const selected = new Set();

  const bar = document.createElement('div');
  bar.className = 'bulk-bar';
  bar.hidden = true;
  const count = document.createElement('span');
  count.className = 'bulk-count';
  const btnWrap = document.createElement('div');
  btnWrap.className = 'bulk-actions';
  const clearBtn = document.createElement('button');
  clearBtn.className = 'btn btn-secondary btn-sm';
  clearBtn.textContent = 'Clear';
  bar.append(count, btnWrap, clearBtn);
  document.body.appendChild(bar);

  (actions || []).forEach(a => {
    if (a.adminOnly && !isAdmin) return;
    const b = document.createElement('button');
    b.className = 'btn btn-sm ' + (a.className || 'btn-secondary');
    b.textContent = a.label;
    b.addEventListener('click', async () => {
      const ids = [...selected];
      if (!ids.length) return;
      b.disabled = true;
      try { await a.run(ids); }
      finally { b.disabled = false; }
    });
    btnWrap.appendChild(b);
  });

  function updateBar() {
    const n = selected.size;
    bar.hidden = n === 0;
    count.textContent = `${n} ${n === 1 ? entityLabel : entityLabelPlural} selected`;
    const all = [...document.querySelectorAll('input.bulk-cb')];
    const allChecked = all.length > 0 && all.every(cb => selected.has(cb.value));
    document.querySelectorAll('input.bulk-all').forEach(cb => {
      cb.checked = allChecked;
      cb.indeterminate = !allChecked && n > 0;
    });
  }

  function clear() {
    selected.clear();
    document.querySelectorAll('input.bulk-cb').forEach(cb => { cb.checked = false; });
    updateBar();
  }
  clearBtn.addEventListener('click', clear);

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t || !t.matches) return;
    if (t.matches('input.bulk-cb')) {
      if (t.checked) selected.add(t.value); else selected.delete(t.value);
      updateBar();
    } else if (t.matches('input.bulk-all')) {
      document.querySelectorAll('input.bulk-cb').forEach(cb => {
        cb.checked = t.checked;
        if (t.checked) selected.add(cb.value); else selected.delete(cb.value);
      });
      updateBar();
    }
  });

  return {
    clear,
    getSelected: () => [...selected],
    // Re-checks boxes that are still selected after a re-render and drops any
    // ids whose rows are gone; then refreshes the bar + select-all state.
    sync() {
      const present = new Set([...document.querySelectorAll('input.bulk-cb')].map(cb => cb.value));
      [...selected].forEach(id => { if (!present.has(id)) selected.delete(id); });
      document.querySelectorAll('input.bulk-cb').forEach(cb => { cb.checked = selected.has(cb.value); });
      updateBar();
    },
  };
}

// Run an async per-item operation over many ids sequentially, collecting
// successes/failures and toasting a single summary. Used by every bulk action.
async function bulkRun(ids, perItem, verbPast) {
  let ok = 0;
  const fails = [];
  for (const id of ids) {
    try { await perItem(id); ok++; }
    catch (e) { fails.push({ id, msg: e.message || 'failed' }); }
  }
  if (fails.length) {
    toast(`${ok} ${verbPast}, ${fails.length} failed — e.g. ${fails[0].msg}`, true);
  } else {
    toast(`${ok} ${verbPast}.`);
  }
  return { ok, fails };
}


// ---- Date fields: open the calendar immediately on click/focus ----
document.addEventListener('click', e => {
  const el = e.target;
  if (el && el.matches && el.matches('input[type="date"]') && typeof el.showPicker === 'function') {
    try { el.showPicker(); } catch (err) { /* some browsers restrict this */ }
  }
});

/* ================================================================
   2026 polish pass (ported from Smart DeonTech mainframe)
   ================================================================ */

// ---- 3. Loading placeholders (Oct 2026) ----
// While a page's data is on the way, its empty parts show soft grey shapes
// in the layout they will take — tables get rows, tiles get tiles, lists get
// lines — instead of a blank page or a bare "Loading…". Each shape vanishes
// the moment the page fills that spot (it simply writes over it), and any
// left over are cleared once no request is still running.
//   Tables: any empty <tbody> in a card with a header row.
//   Tiles:  .stat-card values still showing "—" or blank.
//   Text:   anything whose whole text is "Loading…".
//   Others: opt in with data-skel="tiles | cards | list | lines | chart".
const SKEL_SHAPES = {
  tiles: () => Array.from({ length: 4 }, () => '<div class="stat-card skel-auto skel-tile"><div class="skel w55"></div><div class="skel skel-big w40"></div></div>').join(''),
  cards: () => Array.from({ length: 2 }, (_, i) => `<div class="card skel-auto skel-cardbox"><div class="skel skel-h ${i ? 'w40' : 'w55'}"></div><div class="skel w85"></div><div class="skel w55"></div><div class="skel w40"></div></div>`).join(''),
  list: () => '<div class="skel-auto">' + Array.from({ length: 4 }, (_, i) => `<div class="skel-li"><div class="skel skel-dot"></div><div class="skel-li-txt"><div class="skel ${i % 2 ? 'w55' : 'w85'}"></div><div class="skel w40"></div></div></div>`).join('') + '</div>',
  lines: () => '<div class="skel-auto skel-lines"><div class="skel w85"></div><div class="skel w55"></div><div class="skel w40"></div></div>',
  chart: () => '<div class="skel-auto skel-chart">' + [55, 80, 62, 90, 70, 84, 60, 76].map(h => `<div class="skel" style="height:${h}%"></div>`).join('') + '</div>',
};
const _skel = { seededAt: 0, timer: null };
function seedTableSkeletons() {
  const main = document.querySelector('.main') || document.body;
  const widths = ['w85', 'w55', 'w40', 'w55', 'w40', 'w55', 'w40'];
  main.querySelectorAll('.card table').forEach(t => {
    const head = t.querySelector('thead tr');
    const body = t.querySelector('tbody');
    if (!head || !body || body.children.length || body.textContent.trim()) return;
    const cols = head.children.length;
    body.innerHTML = Array.from({ length: 4 }, (_, r) =>
      `<tr class="skel-row">${Array.from({ length: cols }, (_, c) =>
        `<td><div class="skel ${widths[(r + c) % widths.length]}"></div></td>`).join('')}</tr>`).join('');
  });
  main.querySelectorAll('.stat-card .value').forEach(v => {
    const t = v.textContent.trim();
    if (t && t !== '—') return;
    v.classList.add('skel-val');
    const obs = new MutationObserver(() => { v.classList.remove('skel-val'); obs.disconnect(); });
    obs.observe(v, { childList: true, characterData: true, subtree: true });
  });
  main.querySelectorAll('p, div, span').forEach(el => {
    if (el.children.length || !/^Loading…?(\.\.\.)?$/.test(el.textContent.trim()) || el.closest('.modal-overlay')) return;
    el.innerHTML = SKEL_SHAPES.lines(); el.classList.add('skel-host');
  });
  main.querySelectorAll('[data-skel]').forEach(el => {
    if (el.children.length || el.textContent.trim()) return;
    const shape = SKEL_SHAPES[el.dataset.skel] || SKEL_SHAPES.lines;
    el.innerHTML = shape(); el.setAttribute('aria-busy', 'true');
  });
  _skel.seededAt = Date.now();
  // A page that asks for nothing still has its shapes cleared.
  setTimeout(skelIdle, 1500);
  // Never leave a shape up for ever (a request that hangs).
  setTimeout(skelSweep, 25000);
}
function skelSweep() {
  document.querySelectorAll('tr.skel-row, .skel-auto').forEach(n => n.remove());
  document.querySelectorAll('.skel-val').forEach(n => n.classList.remove('skel-val'));
  document.querySelectorAll('.skel-host').forEach(n => { if (n.querySelector('.skel-lines') && n.children.length === 1) n.innerHTML = ''; n.classList.remove('skel-host'); });
  document.querySelectorAll('[aria-busy="true"][data-skel]').forEach(n => n.removeAttribute('aria-busy'));
}
// Called whenever the last request in flight finishes: if nothing new has
// started a moment later, the page has drawn what it is going to draw.
function skelIdle() {
  if (!_skel.seededAt) return;
  clearTimeout(_skel.timer);
  _skel.timer = setTimeout(() => { if (_loader.count === 0) skelSweep(); }, 400);
}
// Real content arriving in a spot clears that spot's shapes straight away
// (pages that add rows one by one rather than writing the whole list).
new MutationObserver(muts => {
  for (const m of muts) {
    if (!m.addedNodes.length) continue;
    const real = [...m.addedNodes].some(n => n.nodeType === 1 && !n.classList.contains('skel-row') && !n.classList.contains('skel-auto') && !(n.querySelector && n.querySelector(':scope > .skel')));
    if (!real) continue;
    m.target.querySelectorAll(':scope > tr.skel-row, :scope > .skel-auto').forEach(n => n.remove());
    if (m.target.getAttribute && m.target.getAttribute('aria-busy') === 'true') m.target.removeAttribute('aria-busy');
  }
}).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('DOMContentLoaded', seedTableSkeletons);

// ---- 6. Count-up numbers on stat cards ----
function initCountUpNumbers() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll('.stat-card .value').forEach(el => {
    const obs = new MutationObserver(() => {
      const text = el.textContent.trim();
      const num = Number(text.replace(/,/g, ''));
      if (!text || isNaN(num) || num === 0 || el.dataset.counted) return;
      el.dataset.counted = '1';
      obs.disconnect();
      const start = performance.now(), dur = 650;
      const step = now => {
        const p = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(num * eased).toLocaleString();
        if (p < 1) requestAnimationFrame(step);
        else el.textContent = num.toLocaleString();
      };
      requestAnimationFrame(step);
    });
    obs.observe(el, { childList: true, characterData: true, subtree: true });
    setTimeout(() => obs.disconnect(), 10000);
  });
}
document.addEventListener('DOMContentLoaded', initCountUpNumbers);

// ---- ?new=1 deep link: auto-open the page's add modal ----
document.addEventListener('DOMContentLoaded', () => {
  if (new URLSearchParams(location.search).get('new') !== '1') return;
  setTimeout(() => {
    const btn = document.getElementById('addBtn') || document.getElementById('entryBtn') || document.getElementById('addCaseBtn');
    if (btn && btn.style.display !== 'none') btn.click();
  }, 600);
});

// ---- 4. Ctrl/Cmd+K command palette ----
(function () {
  let open = false, items = [], active = 0, token = 0;
  let cache = null;

  const PAGES = () => (typeof NAV_ITEMS !== 'undefined' ? NAV_ITEMS : []);
  const ACTIONS = [
    { label: 'Schedule a meeting', href: '/meetings.html?new=1', perm: 'meetings.manage' },
    { label: 'Record fundraising day', href: '/fundraising.html?new=1', perm: 'fundraising.manage' },
    { label: 'Register visitor / new member', href: '/visitors.html?new=1', perm: 'visitors.manage' },
    { label: 'Open counselling case', href: '/counselling.html?new=1', perm: 'counselling.manage' },
    { label: 'Enter quarterly data', href: '/entry.html', perm: 'entry.manage' },
    { label: 'Generate reports', href: '/reports.html', perm: 'reports.generate' },
  ];

  function overlay() {
    let el = document.getElementById('cmdkOverlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'cmdkOverlay';
    el.className = 'cmdk-overlay';
    el.style.display = 'none';
    el.innerHTML = `<div class="cmdk">
      <input id="cmdkInput" placeholder="Search pages, actions, members, goals…" autocomplete="off">
      <div class="cmdk-list" id="cmdkList"></div>
      <div class="cmdk-foot"><span>↑↓ navigate</span><span>↵ open</span><span>esc close</span></div>
    </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', e => { if (e.target === el) close(); });
    el.querySelector('#cmdkInput').addEventListener('input', render);
    el.querySelector('#cmdkInput').addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); paint(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); paint(); }
      if (e.key === 'Enter' && items[active]) { e.preventDefault(); go(items[active]); }
      if (e.key === 'Escape') close();
    });
    return el;
  }
  function openPalette() {
    const el = overlay();
    el.style.display = 'flex';
    open = true;
    el.querySelector('#cmdkInput').value = '';
    el.querySelector('#cmdkInput').focus();
    render();
  }
  function close() { const el = document.getElementById('cmdkOverlay'); if (el) el.style.display = 'none'; open = false; }
  function go(item) { close(); location.href = item.href; }

  async function loadCache() {
    if (cache) return cache;
    const safe = p => api(p).catch(() => []);
    const [goals, members, visitors, meetings] = await Promise.all([
      safe('/setup/goals'), safe('/setup/members'), safe('/visitors'), safe('/meetings'),
    ]);
    cache = { goals, members, visitors, meetings };
    return cache;
  }

  async function render() {
    const q = (document.getElementById('cmdkInput') || {}).value?.trim().toLowerCase() || '';
    const my = window.currentPaletteUser || {};
    const has = p => !p || my.role === 'admin' || (my.permissions || []).includes(p);
    items = [];
    const groups = [];

    const pages = PAGES().filter(p => (!q || p.label.toLowerCase().includes(q)))
      .filter(p => !p.adminOnly || my.role === 'admin')
      .filter(p => !p.perm || has(p.perm))
      .filter(p => !p.anyPerm || my.role === 'admin' || (p.anyPerm || []).some(x => (my.permissions || []).includes(x)))
      .slice(0, 6).map(p => ({ label: p.label, href: p.href, group: 'Pages' }));
    if (pages.length) groups.push(['Pages', pages]);

    const actions = ACTIONS.filter(a => has(a.perm)).filter(a => !q || a.label.toLowerCase().includes(q))
      .slice(0, 6).map(a => ({ ...a, group: 'Quick actions' }));
    if (actions.length) groups.push(['Quick actions', actions]);

    const myToken = ++token;
    if (q.length >= 2) {
      const c = await loadCache();
      if (myToken !== token) return;
      const hits = [];
      c.goals.filter(g => g.code.toLowerCase().includes(q) || g.description.toLowerCase().includes(q)).slice(0, 5)
        .forEach(g => hits.push({ label: `${g.code} — ${g.description.slice(0, 50)}`, href: '/goals.html', group: 'Goals' }));
      c.members.filter(m => m.name.toLowerCase().includes(q)).slice(0, 5)
        .forEach(m => hits.push({ label: m.name, sub: m.position || '', href: m.entityType === 'group' ? '/groups.html' : '/committees.html', group: 'Members' }));
      c.visitors.filter(v => v.name.toLowerCase().includes(q)).slice(0, 4)
        .forEach(v => hits.push({ label: v.name, sub: v.status, href: '/visitors.html', group: 'Visitors' }));
      c.meetings.filter(m => (m.title || '').toLowerCase().includes(q)).slice(0, 4)
        .forEach(m => hits.push({ label: `${m.title} (${m.date})`, href: '/meetings.html', group: 'Meetings' }));
      const byGroup = {};
      hits.forEach(h => (byGroup[h.group] = byGroup[h.group] || []).push(h));
      Object.entries(byGroup).forEach(([g, list]) => groups.push([g, list]));
    }

    items = groups.flatMap(([, list]) => list);
    active = 0;
    const listEl = document.getElementById('cmdkList');
    if (!listEl) return;
    listEl.innerHTML = groups.map(([g, list]) =>
      `<div class="cmdk-group">${g}</div>` + list.map(it =>
        `<div class="cmdk-item" data-idx="${items.indexOf(it)}">${esc(it.label)}${it.sub ? `<span class="sub">${esc(it.sub)}</span>` : ''}</div>`).join('')).join('')
      || '<div class="cmdk-group">No matches</div>';
    listEl.querySelectorAll('.cmdk-item').forEach(el => {
      el.onclick = () => go(items[Number(el.dataset.idx)]);
      el.onmouseenter = () => { active = Number(el.dataset.idx); paint(); };
    });
    paint();
  }
  function paint() {
    document.querySelectorAll('.cmdk-item').forEach(el =>
      el.classList.toggle('active', Number(el.dataset.idx) === active));
  }

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      open ? close() : openPalette();
    }
  });
  window.openCommandPalette = openPalette;
})();

// ---- Document viewer for every PDF in the app (Oct 2026) --------------------
// Installed on a phone, AOTC Track runs as a home-screen app with no browser
// bar. A PDF opened with target="_blank" or window.open() then filled the
// screen with NO way back: on 8 Oct 2026 the Clerk exported the agenda and had
// to quit the whole app to get out. Every same-origin /api/ document now opens
// in this viewer instead — inside the page, with Close (and the phone's own
// Back) to return, Download, Share, and Save as image (PNG) for WhatsApp.
//
// It works by delegation, so no page needed changing: any link to /api/… with
// target="_blank" (or a data-viewer attribute), and any window.open('/api/…'),
// comes here. Anything that is not a PDF or an image is simply downloaded.
// Opt out with data-no-viewer.
(function () {
  let pdfjsReady = null;
  function loadPdfJs() {
    if (window.pdfjsLib) return Promise.resolve();
    if (pdfjsReady) return pdfjsReady;
    pdfjsReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/js/vendor/pdfjs/pdf.min.js';
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdfjs/pdf.worker.min.js'; resolve(); };
      s.onerror = () => { pdfjsReady = null; reject(new Error('Could not load the PDF viewer.')); };
      document.head.appendChild(s);
    });
    return pdfjsReady;
  }
  const isDocUrl = u => {
    try {
      if (String(u).startsWith('blob:')) return true;   // a document already fetched by the page
      const x = new URL(u, location.href); return x.origin === location.origin && x.pathname.startsWith('/api/');
    } catch (e) { return false; }
  };
  function fileNameFrom(res, url, fallback) {
    const cd = res.headers.get('content-disposition') || '';
    const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    const last = new URL(url, location.href).pathname.split('/').pop();
    return last && /\.\w{2,4}$/.test(last) ? last : (fallback || 'document');
  }
  function saveBlob(blob, name) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  }
  async function shareFiles(files, title, text) {
    if (navigator.canShare && navigator.canShare({ files })) {
      // A message goes with the files when there is one: WhatsApp takes it as
      // the picture's caption.
      const data = text ? { files, title, text } : { files, title };
      try { await navigator.share(data); return true; } catch (e) { if (e && e.name === 'AbortError') return true; }
      if (text) { try { await navigator.share({ files, title }); return true; } catch (e) { if (e && e.name === 'AbortError') return true; } }
    }
    return false;
  }
  // The closing blessing follows the time of day at the moment of sending —
  // the message may have been written hours earlier. Only the app's own line
  // is touched; anything the Clerk typed instead is left alone.
  function freshBlessing(text) {
    const h = new Date().getHours();
    const now = h < 12 ? 'day' : h < 16 ? 'afternoon' : h < 20 ? 'evening' : 'night';
    return String(text || '').replace(/Have a blessed (day|morning|afternoon|evening|night)\./, `Have a blessed ${now}.`);
  }
  window.freshBlessing = freshBlessing;
  // Best effort: some phones' WhatsApp drop the caption, so it is on the
  // clipboard as well, ready to paste.
  function copyQuietly(text) {
    try { if (text && navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).catch(() => {}); } catch (e) {}
  }

  // The Session agenda as a picture comes with its WhatsApp message.
  function captionUrlFor(url) {
    const m = String(url || '').match(/\/api\/minutes\/(\d+)\/agenda\.pdf/);
    return m ? `/api/minutes/${m[1]}/whatsapp?kind=image` : '';
  }
  let el = null, current = null;
  function build() {
    if (el) return el;
    const css = document.createElement('style');
    css.textContent = `
      .docview{position:fixed;inset:0;z-index:10000;display:flex;flex-direction:column;background:#525659;}
      .docview-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:calc(env(safe-area-inset-top,0px) + 8px) 12px 8px;background:var(--surface,#fff);border-bottom:1px solid var(--rule,#E3E9F4);}
      .docview-title{flex:1;min-width:120px;font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink,#111);}
      .docview-pages{flex:1;overflow:auto;-webkit-overflow-scrolling:touch;padding:12px;display:flex;flex-direction:column;align-items:center;gap:12px;}
      .docview-pages canvas,.docview-pages img{max-width:100%;background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.35);}
      .docview-status{color:#fff;padding:40px 16px;text-align:center;font-size:14px;}
      .docview-close{font-weight:600;}
      .docview-msg{width:100%;max-width:900px;background:var(--surface,#fff);border-radius:10px;padding:10px 12px;box-sizing:border-box;}
      .docview-msg label{display:block;font-size:12px;font-weight:600;color:var(--muted,#555);margin-bottom:4px;}
      .docview-msg textarea{width:100%;min-height:150px;font:inherit;font-size:14px;box-sizing:border-box;border:1px solid var(--rule,#d5dae6);border-radius:8px;padding:8px;}`;
    document.head.appendChild(css);
    el = document.createElement('div');
    el.className = 'docview';
    el.style.display = 'none';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `
      <div class="docview-bar">
        <button type="button" class="btn btn-secondary btn-sm docview-close" data-dv="close">← Close</button>
        <div class="docview-title" data-dv="title"></div>
        <button type="button" class="btn btn-secondary btn-sm" data-dv="download">⬇ Download</button>
        <button type="button" class="btn btn-secondary btn-sm" data-dv="share" style="display:none;">Share</button>
        <button type="button" class="btn btn-secondary btn-sm" data-dv="image" title="Save each page as a picture — for WhatsApp">\u{1F5BC} Image (PNG)</button>
      </div>
      <div class="docview-pages" data-dv="pages"></div>`;
    document.body.appendChild(el);
    el.querySelector('[data-dv="close"]').onclick = () => close();
    el.querySelector('[data-dv="download"]').onclick = () => current && current.blob && saveBlob(current.blob, current.name);
    el.querySelector('[data-dv="share"]').onclick = async () => {
      if (!current || !current.blob) return;
      const f = new File([current.blob], current.name, { type: current.blob.type });
      if (!await shareFiles([f], current.title)) saveBlob(current.blob, current.name);
    };
    el.querySelector('[data-dv="image"]').onclick = () => saveAsImages();
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && el.style.display !== 'none') close(); });
    window.addEventListener('popstate', () => { if (el.style.display !== 'none') close(true); });
    return el;
  }
  const part = k => el.querySelector(`[data-dv="${k}"]`);

  function close(fromPopState) {
    if (!el || el.style.display === 'none') return;
    el.style.display = 'none';
    part('pages').innerHTML = '';
    document.body.style.overflow = '';
    current = null;
    // Closing with the button also takes back the history step we added, so
    // the phone's Back button behaves the same either way.
    if (!fromPopState && history.state && history.state.docViewer) history.back();
  }

  async function open(url, title, opts = {}) {
    build();
    current = { url, title: title || 'Document', blob: null, name: 'document.pdf', pdf: null, images: null, wantImage: !!opts.image, textUrl: opts.textUrl || (opts.image ? captionUrlFor(url) : '') };
    part('title').textContent = current.title;
    part('pages').innerHTML = '<div class="docview-status">Opening…</div>';
    part('image').style.display = 'none';
    part('image').textContent = '🖼 Image (PNG)';
    part('image').classList.remove('btn-primary'); part('image').classList.add('btn-secondary');
    part('image').disabled = false;
    part('share').style.display = 'none';
    el.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    history.pushState({ docViewer: true }, '');
    const mine = current;
    try {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) {
        let msg = `Could not open this document (${res.status}).`;
        try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
        throw new Error(msg);
      }
      const blob = await res.blob();
      if (current !== mine) return;
      const type = (res.headers.get('content-type') || blob.type || '').toLowerCase();
      mine.blob = blob;
      mine.name = fileNameFrom(res, url, type.includes('pdf') ? 'document.pdf' : 'document');
      if (!title) part('title').textContent = mine.title = mine.name;
      const f = new File([blob], mine.name, { type: blob.type });
      if (navigator.canShare && navigator.canShare({ files: [f] })) part('share').style.display = '';

      if (type.startsWith('image/')) {
        const img = document.createElement('img');
        img.src = URL.createObjectURL(blob);
        part('pages').innerHTML = ''; part('pages').appendChild(img);
        return;
      }
      if (!type.includes('pdf')) {
        // Word, Excel, ZIP…: nothing to show — hand it straight over.
        saveBlob(blob, mine.name);
        part('pages').innerHTML = `<div class="docview-status">${esc(mine.name)} has been downloaded.<br><br>Use ← Close to go back.</div>`;
        return;
      }
      await loadPdfJs();
      const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
      if (current !== mine) return;
      mine.pdf = pdf;
      part('pages').innerHTML = '';
      part('image').style.display = '';
      // The message to go with the picture (the agenda for WhatsApp), shown
      // above it and editable before sharing.
      if (mine.textUrl) {
        try {
          const r = await fetch(mine.textUrl, { credentials: 'same-origin' });
          const j = r.ok ? await r.json() : null;
          if (current !== mine) return;
          if (j && j.text) {
            const msg = document.createElement('div');
            msg.className = 'docview-msg';
            msg.innerHTML = '<label>Message to go with the picture (you can edit it)</label><textarea></textarea>';
            msg.querySelector('textarea').value = j.text;
            part('pages').appendChild(msg);
          }
        } catch (e) {}
      }
      const box = part('pages');
      const maxWidth = Math.min(box.clientWidth - 24, 900);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        if (current !== mine) return;
        const base = page.getViewport({ scale: 1 });
        const vp = page.getViewport({ scale: (maxWidth / base.width) * dpr });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width; canvas.height = vp.height;
        canvas.style.width = (vp.width / dpr) + 'px';
        box.appendChild(canvas);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      }
      // Asked for as an image (the agenda for WhatsApp): make the pictures now,
      // so the tap on "Share image" can go straight to the phone's share sheet,
      // which only opens on a fresh tap, not after a long wait.
      if (mine.wantImage) {
        const btn = part('image');
        btn.disabled = true; btn.textContent = 'Preparing image…';
        mine.images = await makeImages(mine);
        if (current !== mine) return;
        btn.disabled = false; btn.textContent = '🖼 Share image';
        btn.classList.add('btn-primary'); btn.classList.remove('btn-secondary');
      }
    } catch (e) {
      if (current === mine) part('pages').innerHTML = `<div class="docview-status">${esc(e.message || 'Could not open this document.')}<br><br>Use ← Close to go back.</div>`;
    }
  }

  // Each page as a sharp PNG on a white background, about 1600px wide — clear
  // on a phone and well inside WhatsApp's limits. Several pages are shared
  // together where the phone allows it, otherwise downloaded one by one.
  async function makeImages(doc) {
    const pdf = doc.pdf, files = [];
    const stem = doc.name.replace(/\.pdf$/i, '');
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 1600 / base.width });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const blob = await new Promise(r => c.toBlob(r, 'image/png'));
      files.push(new File([blob], pdf.numPages > 1 ? `${stem}_page${i}.png` : `${stem}.png`, { type: 'image/png' }));
    }
    return files;
  }
  async function saveAsImages() {
    if (!current || !current.pdf) return;
    const btn = part('image');
    const was = btn.textContent;
    btn.disabled = true; btn.textContent = 'Making image…';
    try {
      const files = current.images || (current.images = await makeImages(current));
      const box = part('pages').querySelector('.docview-msg textarea');
      const text = box ? freshBlessing(box.value.trim()) : '';
      if (box) box.value = text;
      copyQuietly(text);
      const shared = await shareFiles(files, current.title, text);
      if (!shared) files.forEach((f, k) => setTimeout(() => saveBlob(f, f.name), k * 400));
      toast(text
        ? (shared ? 'Shared. The message is also copied — paste it if WhatsApp did not add it.' : 'Image saved, and the message copied — paste it with the picture.')
        : (files.length > 1 ? `${files.length} images ready — one per page.` : 'Image ready.'));
    } catch (e) { toast(e.message || 'Could not make the image.', true); }
    btn.disabled = false; btn.textContent = was;
  }

  // Links: same-origin /api/ documents opened in a new window.
  document.addEventListener('click', e => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.hasAttribute('data-no-viewer') || a.hasAttribute('download')) return;
    const href = a.getAttribute('href');
    if (!href || href === '#' || !isDocUrl(href)) return;
    if (a.target !== '_blank' && !a.hasAttribute('data-viewer')) return;
    e.preventDefault();
    open(a.href, a.getAttribute('data-title') || (a.textContent || '').trim() || '');
  });   // bubble phase: a page that handles its own click first (saving, say) wins

  // Scripts: window.open('/api/…') for a document.
  const nativeOpen = window.open.bind(window);
  window.open = function (url, target, features) {
    if (url && isDocUrl(url)) {
      open(url, '');
      // Callers test the return value to decide whether to download instead
      // (a blocked pop-up); hand back something window-like so they don't.
      return { closed: false, close: () => close(), focus() {} };
    }
    return nativeOpen(url, target, features);
  };

  window.openDocViewer = open;
  window.closeDocViewer = close;
})();

window.APP_PRODUCT_NAME = 'AOTC Track';
// ===================== Updates (same as Budget and Pulse) =====================
// When the server is updated while this app is open, a bar at the top fetches
// the new version's files (with progress), then offers Reload. Checked when a
// page opens, when you come back to the app, and every 5 minutes. The version
// a page is running is the one the server reported when it opened: this app
// keeps no offline copy, so every page load is already the newest.
(function () {
  var PRODUCT = window.APP_PRODUCT_NAME || document.title.split(/\s+[\u2014-]\s+/).pop() || 'The app';
  var running = null, busy = false, lastCheck = 0;
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function style() {
    if (document.getElementById('updStyle')) return;
    var s = document.createElement('style'); s.id = 'updStyle';
    s.textContent = '.upd-bar{position:fixed;left:12px;right:12px;top:calc(8px + env(safe-area-inset-top));z-index:10000;padding:10px 14px 12px;border-radius:16px;background:var(--panel,#fff);color:var(--ink,#0b1220);border:1px solid var(--rule,#e3e9f4);box-shadow:var(--shadow-md,0 8px 24px rgba(0,0,0,.12));font:600 14px/1.3 system-ui,-apple-system,sans-serif;transform:translateY(calc(-100% - 24px));transition:transform .35s cubic-bezier(.2,.8,.2,1)}'
      + '.upd-bar.show{transform:none}.upd-txt{display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:22px}'
      + '.upd-track{height:5px;border-radius:3px;background:var(--rule,#e3e9f4);margin-top:8px;overflow:hidden}.upd-track i{display:block;height:100%;width:0;border-radius:3px;background:var(--primary-gradient,var(--primary,#0b5fbf));transition:width .35s ease}'
      + '.upd-bar.done .upd-track i{background:#10b981}.upd-go{border:0;border-radius:999px;padding:6px 14px;background:var(--primary,#0b5fbf);color:#fff;font-weight:700;font-size:14px;cursor:pointer}'
      + '@media(min-width:960px){.upd-bar{left:auto;width:380px}}';
    document.head.appendChild(s);
  }
  function bar(stage, done, total, version) {
    style();
    var el = document.getElementById('updBar');
    if (!el) { el = document.createElement('div'); el.id = 'updBar'; el.className = 'upd-bar'; el.setAttribute('role', 'status'); el.innerHTML = '<div class="upd-txt"></div><div class="upd-track"><i></i></div>'; document.body.appendChild(el); }
    var pct = stage === 'check' ? 4 : stage === 'download' ? 8 + Math.round((done / Math.max(1, total)) * 80) : 100;
    var txt = stage === 'check' ? 'Checking for the new version\u2026' : stage === 'download' ? 'Downloading the new version \u00b7 ' + done + ' of ' + total : stage === 'reload' ? 'Opening the new version\u2026' : PRODUCT + ' ' + version + ' is ready';
    el.querySelector('.upd-txt').innerHTML = '<span>' + esc(txt) + '</span>' + (stage === 'ready' ? '<button class="upd-go" type="button">Reload</button>' : '');
    el.querySelector('.upd-track i').style.width = pct + '%';
    el.classList.toggle('done', stage === 'ready');
    var go = el.querySelector('.upd-go');
    if (go) go.onclick = function () { go.disabled = true; go.textContent = 'Updating\u2026'; bar('reload', 0, 0, version); location.reload(); };
    requestAnimationFrame(function () { el.classList.add('show'); });
  }
  // The files this page is made of: fetched fresh, so Reload opens at once.
  function pageFiles() {
    var out = [location.pathname];
    document.querySelectorAll('script[src],link[rel="stylesheet"][href]').forEach(function (n) {
      try { var u = new URL(n.getAttribute('src') || n.getAttribute('href'), location.href); if (u.origin === location.origin && out.indexOf(u.pathname) < 0) out.push(u.pathname); } catch (e) { /* skip */ }
    });
    return out;
  }
  async function getNew(v) {
    busy = true;
    var files = pageFiles(), done = 0;
    bar('download', 0, files.length, v);
    for (var i = 0; i < files.length; i++) {
      try { await fetch(files[i], { cache: 'reload', credentials: 'same-origin' }); } catch (e) { /* Reload still works */ }
      done++; bar('download', done, files.length, v);
    }
    bar('ready', 0, 0, v);
  }
  // The running version wherever it is shown: sidebar, More sheet, footer.
  function showVersion(v) {
    document.querySelectorAll('.app-ver').forEach(function (el) { el.textContent = v; });
  }
  async function check(force) {
    if (busy || (!force && Date.now() - lastCheck < 60000)) return null;
    lastCheck = Date.now();
    try {
      var r = await fetch('/api/version', { cache: 'no-store' });
      var d = await r.json();
      if (!d || !d.version) return null;
      if (running === null) { running = d.version; window.APP_RUNNING_VERSION = running; showVersion(running); return d; }
      if (d.version !== running) { if (force) bar('check'); await getNew(d.version); }
      return d;
    } catch (e) { return null; }
  }
  window.appCheckForUpdates = function () { return check(true).then(function (d) { return { running: running, server: d && d.version, newer: !!(d && d.version !== running) }; }); };
  window.appRunningVersion = function () { return running; };
  check(true);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') check(false); });
  setInterval(function () { check(false); }, 5 * 60000);
})();
