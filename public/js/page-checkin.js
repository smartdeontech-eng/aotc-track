// QR Check-in page (Phase 11). Camera scanning via the built-in
// BarcodeDetector API (Chrome/Android; most church phones), with a
// manual name-search fallback that works everywhere.
let me, groups = [], membersLite = [], stream = null, scanning = false, lastCode = '', lastAt = 0;

function isClerkish() {
  return isElevated(me) || (me.permissions || []).includes('approvals.manage');
}
function isGroup() { return me.entity && me.entity.type === 'group'; }

// Which group's context is active: a group account -> its own group; a
// clerk/admin -> whichever group is picked (null = church service).
function activeGroupId() {
  if (isGroup()) return Number(me.entity.id);
  if (isClerkish() && document.getElementById('cGroup').value) return Number(document.getElementById('cGroup').value);
  return null;
}
function selectedMeetingDate() {
  const sel = document.getElementById('cMeeting');
  const opt = sel && sel.options[sel.selectedIndex];
  return opt ? (opt.dataset.date || '') : '';
}
function ctx() {
  const gid = activeGroupId();
  if (gid) {
    const mid = document.getElementById('cMeeting').value;
    return { type: 'group', entityId: gid, meetingId: mid ? Number(mid) : null, date: selectedMeetingDate() };
  }
  return { type: 'service', date: document.getElementById('cDate').value, service: document.getElementById('cService').value };
}

// Group context shows the meeting picker; service context shows date + service.
function applyContext() {
  const groupMode = !!activeGroupId();
  document.getElementById('meetingField').style.display = groupMode ? '' : 'none';
  document.getElementById('newMeetingBtn').style.display = groupMode ? '' : 'none';
  const emb = document.getElementById('editMeetingBtn');
  if (emb) emb.style.display = groupMode ? '' : 'none';
  document.getElementById('svcField').style.display = groupMode ? 'none' : '';
  document.getElementById('dateField').style.display = groupMode ? 'none' : '';
}
async function loadMeetings(gid) {
  const sel = document.getElementById('cMeeting');
  if (!gid) { sel.innerHTML = ''; return; }
  let list = [];
  try { list = await api(`/checkin/meetings?entityId=${gid}`); } catch (e) {}
  sel.innerHTML = list.length
    ? list.map(m => `<option value="${m.id}" data-date="${m.date}">${esc(m.label)} — ${toLocalDate(m.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${m.time ? ' ' + esc(m.time) : ''}</option>`).join('')
    : '<option value="">No meetings yet — tap “New meeting”</option>';
}
async function refreshTally(meetingId) {
  const el = document.getElementById('mfTally');
  if (!meetingId) { el.style.display = 'none'; return; }
  try {
    const t = await api(`/checkin/meeting-tally?meetingId=${meetingId}`);
    document.getElementById('tally').textContent = t.total;
    el.style.display = '';
    el.textContent = `${t.male} male · ${t.female} female${t.unknown ? ` · ${t.unknown} unrecorded` : ''}`;
  } catch (e) { el.style.display = 'none'; }
}

async function refreshList() {
  const c = ctx();
  let q;
  if (c.type === 'service') { q = `?type=service&date=${c.date}&service=${c.service}`; }
  else if (c.meetingId) { q = `?type=group&meetingId=${c.meetingId}`; }
  else {
    document.getElementById('tally').textContent = '0';
    document.getElementById('mfTally').style.display = 'none';
    document.getElementById('checkinRows').innerHTML = '<tr><td class="sub">Create or select a meeting to start.</td></tr>';
    return;
  }
  try {
    const list = await api('/checkin/list' + q);
    document.getElementById('tally').textContent = list.length;
    document.getElementById('checkinRows').innerHTML = list.map(r => `<tr>
      <td>${esc(r.name)}</td><td class="sub" style="text-align:right;">${new Date(r.at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</td>
    </tr>`).join('') || '<tr><td class="sub">No one checked in yet.</td></tr>';
    if (c.type === 'group' && c.meetingId) refreshTally(c.meetingId);
    else document.getElementById('mfTally').style.display = 'none';
  } catch (e) { /* context not permitted */ }
}

async function submit(kind, payload) {
  const c = ctx();
  if (c.type === 'group' && !c.meetingId) { toast('Create or select a meeting first.', true); return; }
  try {
    const r = await api(`/checkin/${kind}`, { method: 'POST', body: { ...payload, context: c } });
    toast(r.already ? `${r.name} — already checked in` : `✓ ${r.name} checked in`, r.already);
    if (navigator.vibrate) navigator.vibrate(r.already ? [60, 60, 60] : 80);
    refreshList();
  } catch (e) { toast(e.message, true); }
}

// ---- camera scanning ----
// Uses the native BarcodeDetector where available (Chrome/Android — fastest),
// and falls back to the bundled jsQR decoder everywhere else (iOS Safari,
// desktop Safari, etc.) so scanning works on every phone.
let _scanCanvas = null;
function gotCode(v) {
  if (v && v.startsWith('AOTC:') && (v !== lastCode || Date.now() - lastAt > 4000)) {
    lastCode = v; lastAt = Date.now();
    submit('scan', { code: v });
  }
}
async function startScan() {
  const hasCamera = navigator.mediaDevices && navigator.mediaDevices.getUserMedia;
  if (!hasCamera) {
    document.getElementById('scanStatus').textContent = 'This device has no camera access — use the manual search below.';
    return;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (e) {
    document.getElementById('scanStatus').textContent =
      (e && e.name === 'NotAllowedError')
        ? 'Camera permission was declined. Allow camera access for this site in your browser settings, or use the manual search below.'
        : 'Could not start the camera — use the manual search below.';
    return;
  }
  const video = document.getElementById('scanVideo');
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  video.style.display = '';
  await video.play();
  document.getElementById('startScanBtn').style.display = 'none';
  document.getElementById('stopScanBtn').style.display = '';
  document.getElementById('scanStatus').textContent = 'Point the camera at a member card…';
  scanning = true;

  const useNative = ('BarcodeDetector' in window);
  const detector = useNative ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
  if (!useNative && !_scanCanvas) _scanCanvas = document.createElement('canvas');

  const loop = async () => {
    if (!scanning) return;
    try {
      if (useNative) {
        const codes = await detector.detect(video);
        for (const c of codes) gotCode(c.rawValue || '');
      } else if (typeof jsQR === 'function' && video.videoWidth) {
        // Downscale for speed; jsQR reads the pixel data from a canvas.
        const w = 320, h = Math.round(320 * video.videoHeight / video.videoWidth);
        _scanCanvas.width = w; _scanCanvas.height = h;
        const cx = _scanCanvas.getContext('2d', { willReadFrequently: true });
        cx.drawImage(video, 0, 0, w, h);
        const img = cx.getImageData(0, 0, w, h);
        const res = jsQR(img.data, w, h, { inversionAttempts: 'dontInvert' });
        if (res && res.data) gotCode(res.data);
      }
    } catch (e) {}
    // jsQR is heavier than BarcodeDetector, so pace it a little on the fallback.
    if (useNative) requestAnimationFrame(loop); else setTimeout(loop, 180);
  };
  loop();
}
function stopScan() {
  scanning = false;
  if (stream) stream.getTracks().forEach(t => t.stop());
  document.getElementById('scanVideo').style.display = 'none';
  document.getElementById('startScanBtn').style.display = '';
  document.getElementById('stopScanBtn').style.display = 'none';
  document.getElementById('scanStatus').textContent = 'Camera stopped.';
}

// ---- manual fallback ----
document.getElementById('manualSearch').addEventListener('input', async e => {
  const q = e.target.value.trim().toLowerCase();
  const box = document.getElementById('manualResults');
  if (q.length < 2) { box.innerHTML = ''; return; }
  if (!membersLite.length) membersLite = await api('/checkin/members-lite').catch(() => []);
  const hits = membersLite.filter(m => m.name.toLowerCase().includes(q)).slice(0, 6);
  box.innerHTML = hits.map(m => `<button class="btn btn-secondary btn-sm" style="margin:0 6px 6px 0;" onclick="submit('manual', { memberId: ${m.id} })">${esc(m.name)}</button>`).join('')
    || '<p class="sub">No match.</p>';
});

document.getElementById('startScanBtn').onclick = startScan;
document.getElementById('stopScanBtn').onclick = stopScan;

// Check in by the member's printed number. First look the member up (no record
// yet) and show their name + photo so the operator can confirm it's really
// them, then check in on confirm.
let _pendingCheckinId = null;
async function checkinByNumber() {
  const el = document.getElementById('numInput');
  const no = el.value.trim();
  if (!no) { toast('Enter a member number.', true); el.focus(); return; }
  const c = ctx();
  if (c.type === 'group' && !c.meetingId) { toast('Create or select a meeting first.', true); return; }
  let info;
  try { info = await api('/checkin/lookup', { method: 'POST', body: { memberNo: no, context: c } }); }
  catch (e) { toast(e.message, true); return; }
  _pendingCheckinId = info.id;
  document.getElementById('ccName').textContent = info.name;
  document.getElementById('ccPos').textContent = info.position + (info.already ? ' · already checked in' : '');
  const img = document.getElementById('ccPhoto'), noPhoto = document.getElementById('ccNoPhoto');
  if (info.hasPhoto) {
    img.src = `/api/setup/members/${info.id}/photo?t=${Date.now()}`;
    img.style.display = ''; noPhoto.style.display = 'none';
  } else {
    img.style.display = 'none'; img.removeAttribute('src'); noPhoto.style.display = 'flex';
  }
  el.value = '';
  document.getElementById('confirmOverlay').style.display = 'flex';
}
document.getElementById('numBtn').onclick = checkinByNumber;
document.getElementById('numInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); checkinByNumber(); } });
document.getElementById('ccCancel').onclick = () => {
  document.getElementById('confirmOverlay').style.display = 'none';
  _pendingCheckinId = null;
  document.getElementById('numInput').focus();
};
document.getElementById('ccConfirm').onclick = async () => {
  const id = _pendingCheckinId;
  document.getElementById('confirmOverlay').style.display = 'none';
  _pendingCheckinId = null;
  if (id) await submit('manual', { memberId: id });
  document.getElementById('numInput').focus();
};
document.getElementById('cardsBtn').onclick = async () => {
  // Printable member QR card sheet (A4, 2×5 grid). The backend
  // (/api/checkin/cards.pdf) builds it for one committee or group; here we use
  // the current group context — a group account prints its own roster, a
  // clerk/admin prints whichever group is selected. We fetch it (cookie auth)
  // so a permission error or "no members" comes back as a clean toast instead
  // of dumping raw JSON into a new tab, then open the PDF for printing (falling
  // back to a download if the browser blocks the pop-up).
  const c = ctx();
  if (c.type !== 'group' || !c.entityId) {
    toast('Pick a group first — member cards are printed per group.', true);
    return;
  }
  const g = isGroup() ? (window.myEntity && window.myEntity.name)
                      : (groups.find(x => Number(x.id) === Number(c.entityId)) || {}).name;
  const btn = document.getElementById('cardsBtn');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/checkin/cards.pdf?entityType=group&entityId=${c.entityId}`, { credentials: 'same-origin' });
    if (!res.ok) {
      let msg = 'Could not generate member cards.';
      try { msg = (await res.json()).error || msg; } catch (e) {}
      throw new Error(msg);
    }
    const url = URL.createObjectURL(await res.blob());
    const win = window.open(url, '_blank');
    if (!win) { // pop-up blocked — download instead
      const a = document.createElement('a');
      a.href = url; a.download = `${(g || 'members').replace(/\s+/g, '_')}_QR_cards.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`QR cards ready${g ? ' for ' + g : ''}.`, false);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
  }
};
['cDate', 'cService', 'cMeeting'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('change', refreshList);
});
// Clerk/admin switching group (or to church service) reloads that group's
// meetings and reshapes the context.
document.getElementById('cGroup').addEventListener('change', async () => {
  applyContext();
  await loadMeetings(activeGroupId());
  refreshList();
});

// New meeting modal
document.getElementById('newMeetingBtn').onclick = () => {
  document.getElementById('meetingForm').reset();
  document.getElementById('mmDate').value = todayInputValue();
  document.getElementById('meetingOverlay').style.display = 'flex';
};
document.getElementById('mmCancel').onclick = () => { document.getElementById('meetingOverlay').style.display = 'none'; };

// Correct the selected meeting's date/label/time (e.g. created on the wrong date).
document.getElementById('editMeetingBtn').onclick = async () => {
  const sel = document.getElementById('cMeeting');
  const id = sel && sel.value;
  if (!id) { toast('Pick a meeting first.', true); return; }
  const opt = sel.selectedOptions[0];
  const curDate = opt ? opt.dataset.date : '';
  const label = prompt('Meeting name:', (opt ? opt.textContent.split('—')[0] : '').trim()); if (label === null) return;
  const date = prompt('Date (YYYY-MM-DD):', curDate || ''); if (date === null) return;
  const time = prompt('Time (optional, e.g. 17:00):', ''); if (time === null) return;
  try {
    await api(`/checkin/meetings/${id}`, { method: 'PUT', body: {
      label: label.trim(), date: date.trim(), time: time.trim(),
    } });
    toast('Meeting updated');
    await loadMeetings(activeGroupId());
  } catch (e) { toast(e.message, true); }
};
document.getElementById('meetingForm').addEventListener('submit', async e => {
  e.preventDefault();
  const gid = activeGroupId();
  if (!gid) { toast('Pick a group first.', true); return; }
  try {
    const rec = await api('/checkin/meetings', { method: 'POST', body: {
      entityId: gid,
      date: document.getElementById('mmDate').value,
      time: document.getElementById('mmTime').value,
      label: document.getElementById('mmLabel').value.trim(),
    } });
    document.getElementById('meetingOverlay').style.display = 'none';
    await loadMeetings(gid);
    document.getElementById('cMeeting').value = rec.id; // select the new one
    toast('Meeting created');
    refreshList();
  } catch (err) { toast(err.message, true); }
});

window.addEventListener('beforeunload', stopScan);

requireAuthAndRenderShell().then(async u => {
  me = u;
  document.getElementById('cDate').value = todayInputValue();
  document.getElementById('countLabel').textContent = window.myEntity ? window.myEntity.name : 'Church services & group meetings';
  if (isGroup()) {
    document.getElementById('grpField').style.display = 'none';
    document.getElementById('cardsBtn').style.display = '';
    await loadMeetings(Number(me.entity.id));
  } else if (isClerkish()) {
    groups = await api('/setup/groups').catch(() => []);
    document.getElementById('grpField').style.display = '';
    document.getElementById('cGroup').innerHTML = '<option value="">— church service —</option>' +
      groups.map(g => `<option value="${g.id}">${esc(g.name)}</option>`).join('');
    document.getElementById('cardsBtn').style.display = '';
  }
  applyContext();
  refreshList();
});

// ================= Self check-in kiosk =================
// Full-screen, self-service check-in for a tablet at the entrance. The operator
// picks the meeting/service first, then enters kiosk mode; members tap their
// number (or scan their card), see their photo to confirm, and it resets for
// the next person. Reuses /checkin/lookup, /manual and /scan.
let kioskNumber = '', kioskPending = null;
let kioskStream = null, kioskScanning = false, kioskLast = '', kioskLastAt = 0, kioskCanvas = null;

function kioskShow(screen) {
  ['kioskEntry', 'kioskConfirm', 'kioskDone'].forEach(id => {
    document.getElementById(id).style.display = id === screen ? '' : 'none';
  });
}
function kioskRenderNum() { document.getElementById('kioskNum').textContent = kioskNumber || ' '; }
function buildKioskPad() {
  const pad = document.getElementById('kioskPad');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '↵'];
  pad.innerHTML = keys.map(k => `<button type="button" class="kiosk-key" data-k="${k}">${k}</button>`).join('');
  pad.querySelectorAll('.kiosk-key').forEach(b => b.onclick = () => kioskKey(b.dataset.k));
}
function kioskKey(k) {
  if (k === '⌫') kioskNumber = kioskNumber.slice(0, -1);
  else if (k === '↵') { kioskLookup(); return; }
  else if (kioskNumber.length < 8) kioskNumber += k;
  kioskRenderNum();
}
async function kioskLookup() {
  if (!kioskNumber) return;
  let info;
  try { info = await api('/checkin/lookup', { method: 'POST', body: { memberNo: kioskNumber, context: ctx() } }); }
  catch (e) { toast(e.message, true); return; }
  kioskPending = info.id;
  document.getElementById('kioskName').textContent = info.name;
  document.getElementById('kioskPos').textContent = info.position + (info.already ? ' · already checked in' : '');
  const img = document.getElementById('kioskPhoto'), np = document.getElementById('kioskNoPhoto');
  if (info.hasPhoto) { img.src = `/api/setup/members/${info.id}/photo?t=${Date.now()}`; img.style.display = ''; np.style.display = 'none'; }
  else { img.style.display = 'none'; img.removeAttribute('src'); np.style.display = ''; }
  kioskShow('kioskConfirm');
}
async function kioskRecord(kind, payload) {
  try {
    const r = await api(`/checkin/${kind}`, { method: 'POST', body: { ...payload, context: ctx() } });
    document.getElementById('kioskDoneMsg').textContent = r.already ? `${r.name} — already checked in` : `Welcome, ${r.name}!`;
    kioskShow('kioskDone');
    refreshList();
    setTimeout(kioskReset, 2500);
  } catch (e) { toast(e.message, true); kioskReset(); }
}
function kioskReset() {
  kioskStopScan();
  document.getElementById('kioskScanArea').style.display = 'none';
  kioskNumber = ''; kioskPending = null; kioskRenderNum();
  kioskShow('kioskEntry');
}
function openKiosk() {
  const c = ctx();
  if (c.type === 'group' && !c.meetingId) { toast('Pick or create a meeting first.', true); return; }
  let label;
  if (c.type === 'group') {
    const sel = document.getElementById('cMeeting');
    label = (sel.options[sel.selectedIndex] || {}).text || 'Group meeting';
  } else {
    label = 'Church service — ' + document.getElementById('cService').value;
  }
  document.getElementById('kioskCtx').textContent = label;
  buildKioskPad();
  kioskReset();
  document.getElementById('kioskOverlay').style.display = 'flex';
}
function closeKiosk() {
  kioskReset();
  document.getElementById('kioskOverlay').style.display = 'none';
}
// kiosk camera scan
async function kioskStartScan() {
  const area = document.getElementById('kioskScanArea');
  area.style.display = '';
  const status = document.getElementById('kioskScanStatus');
  const video = document.getElementById('kioskVideo');
  try { kioskStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }); }
  catch (e) { status.textContent = 'Camera unavailable — use the number pad.'; return; }
  video.srcObject = kioskStream; video.setAttribute('playsinline', ''); await video.play();
  status.textContent = 'Hold your card up to the camera…';
  kioskScanning = true;
  const useNative = ('BarcodeDetector' in window);
  const detector = useNative ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
  if (!useNative && !kioskCanvas) kioskCanvas = document.createElement('canvas');
  const loop = async () => {
    if (!kioskScanning) return;
    try {
      if (useNative) { const codes = await detector.detect(video); for (const c of codes) kioskGotCode(c.rawValue || ''); }
      else if (typeof jsQR === 'function' && video.videoWidth) {
        const w = 320, h = Math.round(320 * video.videoHeight / video.videoWidth);
        kioskCanvas.width = w; kioskCanvas.height = h;
        const cx = kioskCanvas.getContext('2d', { willReadFrequently: true });
        cx.drawImage(video, 0, 0, w, h);
        const res = jsQR(cx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'dontInvert' });
        if (res && res.data) kioskGotCode(res.data);
      }
    } catch (e) {}
    if (useNative) requestAnimationFrame(loop); else setTimeout(loop, 180);
  };
  loop();
}
function kioskStopScan() {
  kioskScanning = false;
  if (kioskStream) { kioskStream.getTracks().forEach(t => t.stop()); kioskStream = null; }
  const v = document.getElementById('kioskVideo');
  if (v) v.srcObject = null;
}
function kioskGotCode(v) {
  if (!v || !v.startsWith('AOTC:')) return;
  if (v === kioskLast && Date.now() - kioskLastAt < 4000) return;
  kioskLast = v; kioskLastAt = Date.now();
  kioskStopScan();
  document.getElementById('kioskScanArea').style.display = 'none';
  kioskRecord('scan', { code: v });
}
document.getElementById('kioskBtn').onclick = openKiosk;
document.getElementById('kioskExit').onclick = closeKiosk;
document.getElementById('kioskGo').onclick = kioskLookup;
document.getElementById('kioskYes').onclick = () => { if (kioskPending) kioskRecord('manual', { memberId: kioskPending }); };
document.getElementById('kioskNo').onclick = kioskReset;
document.getElementById('kioskScanBtn').onclick = kioskStartScan;
