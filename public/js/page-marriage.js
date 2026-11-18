// Intended Marriage workflow (CFL) — Phase 1.
// List of cases → full PCG-AOTC-CFL-FR01 interview form filled online →
// PDF export for Session → phone-scan upload of the signed copy.
let me, cases = [], current = null;

const D_QUESTIONS = [
  'Age (years)',
  'Denomination / Congregation',
  'Role in congregation',
  'Occupation',
  'Residence',
  'Have you been married before? (Yes / No)',
  'If Yes to Q6, what type of marriage was contracted? (Customary / Ordinance)',
  'If previously married, what is your current civil status? (Divorced / Widowed)',
  'If divorced under Ordinance: do you have your divorce certificate? (Yes – kindly submit a copy / No – explain)',
  'If divorced under Customary marriage: do you have evidence of the dissolution? (Yes – specify / No)',
  'Do you have a child / children? (Yes / No)',
  'If Yes, how many?',
  'Was/were the child(ren) born within marriage or out of wedlock?',
  'Is/are the child(ren) staying with you? (Yes / No)',
  'If No, where is/are the child(ren) staying?',
  'Do you provide for the care of the child(ren)? (Yes / No — if No, explain)',
  'Any remarks / comments',
];

// Fixed answer sets — these questions are picked, not typed, so the answers
// stay consistent across every form. (Question numbers are 1-based.)
const D_OPTIONS = {
  1: Array.from({ length: 83 }, (_, i) => String(i + 18)),          // ages 18–100
  6: ['No', 'Yes'],
  7: ['Not applicable', 'Customary', 'Ordinance'],
  8: ['Not applicable', 'Divorced', 'Widowed'],
  9: ['Not applicable', 'Yes — copy submitted', 'No — explained below'],
  10: ['Not applicable', 'Yes — evidence provided', 'No'],
  11: ['No', 'Yes'],
  13: ['Not applicable', 'Within marriage', 'Out of wedlock'],
  14: ['Not applicable', 'Yes', 'No'],
  16: ['Not applicable', 'Yes', 'No — explained below'],
};

const STAGES = {
  draft: { label: 'draft — interview form being filled', cls: 'badge-progress' },
  'with-session': { label: 'with Session — awaiting signatures', cls: 'badge-info' },
  signed: { label: 'signed copy filed ✓ — awaiting Session approval', cls: 'badge-done' },
  counselling: { label: 'counselling in progress', cls: 'badge-info' },
  cleared: { label: 'cleared by counsellor — awaiting final approval', cls: 'badge-info' },
  approved: { label: 'approved — banns scheduled', cls: 'badge-done' },
  married: { label: 'married ✓ — in the register', cls: 'badge-done' },
};
const stageBadge = st => { const s = STAGES[st] || STAGES.draft; return `<span class="badge ${s.cls}">${s.label}</span>`; };

// ---------- List view ----------
async function loadList() {
  cases = await api('/marriage/cases');
  document.getElementById('caseRows').innerHTML = cases.map(k => `<tr>
    <td class="mono">${esc(k.refNo)}</td>
    <td><b>${esc(k.couple)}</b></td>
    <td>${k.interviewDate ? fmtDate(k.interviewDate) : '—'}</td>
    <td>${k.recommendation === 'clear' ? 'No concerns' : k.recommendation === 'concerns' ? '⚠ Concerns for Session' : '—'}</td>
    <td>${stageBadge(k.stage)}${k.bannsPublished !== null && k.bannsPublished !== undefined
      ? `<div class="sub">banns ${k.bannsPublished}/3${k.marriageDate ? ` · marriage ${fmtDate(k.marriageDate)}` : ''}</div>`
      : k.counsellorName ? `<div class="sub">counsellor: ${esc(k.counsellorName)}</div>` : ''}</td>
    <td style="white-space:nowrap;">
      <button class="btn btn-secondary btn-sm" onclick="openCase(${k.id})">Open</button>
      <a class="btn btn-secondary btn-sm" href="/api/marriage/cases/${k.id}/form.pdf" target="_blank">Form PDF</a>
      ${k.signedAt ? `<a class="btn btn-secondary btn-sm" href="/api/marriage/cases/${k.id}/signed.pdf" target="_blank">Signed PDF</a>` : ''}
      ${isElevated(me) ? `<button class="btn btn-danger btn-sm" onclick="delCase(${k.id})">Del</button>` : ''}
    </td>
  </tr>`).join('') || '<tr><td colspan="6" class="sub">No cases yet — open one with “+ New case”.</td></tr>';
}

// ---------- Editor ----------
const inp = (id, val, ph = '', type = 'text') =>
  `<input type="${type}" data-f="${id}" value="${esc(val || '')}" placeholder="${esc(ph)}">`;
const ta = (id, val, rows = 3, ph = '') =>
  `<textarea data-f="${id}" rows="${rows}" placeholder="${esc(ph)}">${esc(val || '')}</textarea>`;

function peopleRows(prefix, list, n, f2label, f2options) {
  return Array.from({ length: n }, (_, i) => {
    const p = list[i] || {};
    return `<tr>
      <td style="width:34px;" class="mono">${i + 1}</td>
      <td><input data-f="${prefix}.${i}.name" value="${esc(p.name || '')}" placeholder="Full name"></td>
      <td style="width:38%;">${f2options
        ? `<select data-f="${prefix}.${i}.role"><option value=""></option>${f2options.map(o => `<option ${p.role === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`
        : `<input data-f="${prefix}.${i}.relationship" value="${esc(p.relationship || '')}" placeholder="${f2label}">`}</td>
    </tr>`;
  }).join('');
}

// Parents' consent form (per side): phone photos or a PDF, stored on the case.
function consentBox(side) {
  const c = (current.consents || {})[side];
  const label = side === 'husband' ? "husband's" : "wife's";
  return `<div class="field" style="border:1px solid var(--rule); border-radius:8px; padding:10px;">
    <label>Parents' consent form — ${label} family (if any)</label>
    ${c ? `<p class="sub" style="margin:4px 0;">✓ On file (${c.pages ? c.pages + ' page photo(s)' : 'PDF'}, uploaded by ${esc(c.uploadedBy)})
        <a class="btn btn-secondary btn-sm" href="/api/marriage/cases/${current.id}/consent/${side}.pdf" target="_blank">View</a></p>` : ''}
    <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
      <label class="btn btn-secondary btn-sm" style="margin:0;">📷 Scan with camera
        <input type="file" accept="image/*" capture="environment" multiple style="display:none;" onchange="uploadConsent('${side}', this.files, true)">
      </label>
      <label class="btn btn-secondary btn-sm" style="margin:0;">📄 Attach PDF/photos
        <input type="file" accept="image/*,application/pdf" multiple style="display:none;" onchange="uploadConsent('${side}', this.files, false)">
      </label>
      <span class="sub" id="consentStatus-${side}"></span>
    </div>
  </div>`;
}

// Upload consent pages — photos are compressed and merged into one PDF server-side.
async function uploadConsent(side, files, fromCamera) {
  if (!files || !files.length) return;
  const status = document.getElementById('consentStatus-' + side);
  const fd = new FormData();
  try {
    if (status) status.textContent = 'Preparing…';
    for (const file of files) {
      const blob = file.type === 'application/pdf' ? file : await compressImage(file);
      fd.append('pages', blob, file.name || 'page.jpg');
    }
    if (status) status.textContent = 'Uploading…';
    const res = await fetch(`/api/marriage/cases/${current.id}/consent/${side}`, {
      method: 'POST', body: fd, credentials: 'same-origin',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed.');
    current = data;
    toast('Consent form uploaded');
    renderEditor();
  } catch (e) {
    if (status) status.textContent = '';
    toast(e.message, true);
  }
}

// Load the CFL committee roster and show it as a tick-list for Section A.
async function renderCflAttendance(form) {
  const box = document.getElementById('cflAttendance');
  if (!box) return;
  let members = [];
  try {
    const coms = await api('/setup/committees');
    const cfl = coms.find(c => c.code === 'CFL');
    if (cfl) members = await api(`/setup/members?entityType=committee&entityId=${cfl.id}`);
  } catch (e) { /* fall through */ }
  if (!members.length) {
    box.innerHTML = '<span class="sub">The CFL committee roster is empty — add members on the Committees page.</span>';
    return;
  }
  // Pre-tick from saved ids, or match saved names for forms filled before this change.
  const savedIds = ((form.attendance || {}).presentMemberIds || []).map(Number);
  const savedNames = (form.a && form.a.committee ? form.a.committee : []).map(m => (m.name || '').toLowerCase());
  const isOn = m => savedIds.includes(Number(m.id)) || savedNames.includes((m.name || '').toLowerCase());
  box.innerHTML = `<div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:4px;">
    ${members.map(m => `
      <label style="display:flex; align-items:center; gap:8px; padding:5px 6px; font-weight:400; border:1px solid var(--rule); border-radius:8px;">
        <input type="checkbox" class="cfl-att" value="${m.id}" data-name="${esc(m.name)}" data-role="${esc(m.position || 'Member')}" style="width:auto;" ${isOn(m) ? 'checked' : ''}>
        <span>${esc(m.name)} <span class="sub">— ${esc(m.position || 'Member')}</span></span>
      </label>`).join('')}
  </div>
  <p class="sub" id="cflAttSummary" style="margin:8px 0 0;"></p>`;
  const refresh = () => {
    const on = [...document.querySelectorAll('.cfl-att:checked')];
    const coord = on.find(x => /coordinator|chairperson/i.test(x.dataset.role));
    const sec = on.find(x => /^secretary$/i.test(x.dataset.role)) || on.find(x => /secretary/i.test(x.dataset.role));
    document.getElementById('cflAttSummary').textContent =
      `${on.length} present${coord ? ` · signing: ${coord.dataset.name} (Coordinator)` : ' · no Coordinator ticked'}${sec ? ` and ${sec.dataset.name} (${sec.dataset.role})` : ''}`;
    // Mirror into Section H so the signing block shows who will sign.
    const cn = document.querySelector('[data-f="h.coordinatorName"]');
    const sn = document.querySelector('[data-f="h.secretaryName"]');
    if (cn && coord) cn.value = coord.dataset.name;
    if (sn && sec) sn.value = sec.dataset.name;
  };
  document.querySelectorAll('.cfl-att').forEach(cb => cb.addEventListener('change', refresh));
  refresh();
  // The meeting date drives the signing date.
  const dateEl = document.querySelector('[data-f="a.date"]');
  const signEl = document.querySelector('[data-f="h.signDate"]');
  if (dateEl && signEl) dateEl.addEventListener('change', () => { signEl.value = dateEl.value; });
}

function renderEditor() {
  const f = current.form || {};
  const a = f.a || {}, b = f.b || {}, c = f.c || {}, d = f.d || {}, e = f.e || {}, g = f.g || {}, h = f.h || {};
  const eh = e.h || {}, ew = e.w || {};
  document.getElementById('edTitle').textContent = `${current.refNo} — ${(b.husband || {}).name || '?'} & ${(b.wife || {}).name || '?'}`;
  document.getElementById('edStageBar').innerHTML = stageBadge(current.stage) +
    (current.signedScan ? ` <a class="btn btn-secondary btn-sm" href="/api/marriage/cases/${current.id}/signed.pdf" target="_blank">View signed copy</a>` : '');
  const locked = current.stage === 'signed' && !isElevated(me);

  const yn = (id, val) => `<select data-f="${id}"><option value=""></option><option ${val === 'Yes' ? 'selected' : ''}>Yes</option><option ${val === 'No' ? 'selected' : ''}>No</option></select>`;

  document.getElementById('formSections').innerHTML = `
  <div class="card" style="margin-bottom:16px;">
    <div class="section-title"><h3>Section A — Interview details</h3></div>
    <div class="field-row">
      <div class="field" style="max-width:180px;"><label>Date</label>${inp('a.date', a.date, '', 'date')}</div>
      <div class="field" style="max-width:140px;"><label>Time</label>${inp('a.time', a.time, '', 'time')}</div>
    </div>
    <label style="font-weight:600; font-size:0.9em;">Committee members in attendance</label>
    <p class="sub" style="margin:2px 0 8px;">Tick who attended — the list is the CFL committee roster, so no names are typed. The Coordinator and Secretary present are carried to Section H for signing, with the meeting date.</p>
    <div id="cflAttendance" class="sub">Loading the committee roster…</div>
  </div>

  <div class="card" style="margin-bottom:16px;">
    <div class="section-title"><h3>Section B — The intended couple</h3></div>
    <div class="field-row">
      <div class="field"><label>Intended husband — full name</label>${inp('b.husband.name', (b.husband || {}).name)}</div>
      <div class="field" style="max-width:170px;"><label>Phone</label>${inp('b.husband.phone', (b.husband || {}).phone)}</div>
    </div>
    <div class="field-row">
      <div class="field"><label>Intended wife — full name</label>${inp('b.wife.name', (b.wife || {}).name)}</div>
      <div class="field" style="max-width:170px;"><label>Phone</label>${inp('b.wife.phone', (b.wife || {}).phone)}</div>
    </div>
  </div>

  <div class="card" style="margin-bottom:16px;">
    <div class="section-title"><h3>Section C — Family members in attendance</h3></div>
    <label style="font-weight:600; font-size:0.9em;">C1 — Family of the intended husband</label>
    <table><thead><tr><th>No.</th><th>Name</th><th>Relationship</th></tr></thead>
      <tbody>${peopleRows('c.husbandFamily', c.husbandFamily || [], 6, 'Relationship')}</tbody></table>
    <div class="field"><label>NB — father/mother absent: reasons &amp; written consent(s)</label>${ta('c.husbandConsentNote', c.husbandConsentNote, 2)}</div>
    ${consentBox('husband')}
    <label style="font-weight:600; font-size:0.9em; margin-top:12px; display:block;">C2 — Family of the intended wife</label>
    <table><thead><tr><th>No.</th><th>Name</th><th>Relationship</th></tr></thead>
      <tbody>${peopleRows('c.wifeFamily', c.wifeFamily || [], 6, 'Relationship')}</tbody></table>
    <div class="field"><label>NB — father/mother absent: reasons &amp; written consent(s)</label>${ta('c.wifeConsentNote', c.wifeConsentNote, 2)}</div>
    ${consentBox('wife')}
  </div>

  <div class="card" style="margin-bottom:16px;">
    <div class="section-title"><h3>Section D — Screening questions for the couple</h3></div>
    <table><thead><tr><th style="width:30px;">No.</th><th>Question</th><th>Intended husband</th><th>Intended wife</th></tr></thead>
      <tbody>${D_QUESTIONS.map((q, i) => {
        const no = i + 1;
        const qq = d['q' + no] || {};
        // Questions with a fixed answer set are picked from a dropdown; the
        // rest stay free text.
        const cell = (who, val) => D_OPTIONS[no]
          ? `<select data-f="d.q${no}.${who}"><option value=""></option>${D_OPTIONS[no].map(o =>
              `<option ${String(val || '') === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
          : `<textarea data-f="d.q${no}.${who}" rows="1">${esc(val || '')}</textarea>`;
        return `<tr><td class="mono">${no}</td><td style="max-width:280px;">${esc(q)}</td>
          <td>${cell('h', qq.h)}</td>
          <td>${cell('w', qq.w)}</td></tr>`;
      }).join('')}</tbody></table>
  </div>

  <div class="card" style="margin-bottom:16px;">
    <div class="section-title"><h3>Section E — Parents / in loco parentis</h3></div>
    <p class="sub" style="margin-top:0;">Are you in support of the intended marriage?</p>
    <table><thead><tr><th></th><th>Family of intended husband</th><th>Family of intended wife</th></tr></thead><tbody>
      <tr><td>Father / Representative</td><td>${yn('e.h.fatherSupport', eh.fatherSupport)}</td><td>${yn('e.w.fatherSupport', ew.fatherSupport)}</td></tr>
      <tr><td>If No, reasons</td><td><textarea data-f="e.h.fatherReasons" rows="1">${esc(eh.fatherReasons || '')}</textarea></td><td><textarea data-f="e.w.fatherReasons" rows="1">${esc(ew.fatherReasons || '')}</textarea></td></tr>
      <tr><td>Mother / Representative</td><td>${yn('e.h.motherSupport', eh.motherSupport)}</td><td>${yn('e.w.motherSupport', ew.motherSupport)}</td></tr>
      <tr><td>If No, reasons</td><td><textarea data-f="e.h.motherReasons" rows="1">${esc(eh.motherReasons || '')}</textarea></td><td><textarea data-f="e.w.motherReasons" rows="1">${esc(ew.motherReasons || '')}</textarea></td></tr>
      <tr><td>Parents' remarks</td><td><textarea data-f="e.h.remarks" rows="1">${esc(eh.remarks || '')}</textarea></td><td><textarea data-f="e.w.remarks" rows="1">${esc(ew.remarks || '')}</textarea></td></tr>
    </tbody></table>
  </div>

  <div class="card" style="margin-bottom:16px;">
    <div class="section-title"><h3>Section F — Committee's remarks</h3></div>
    ${ta('f', f.f, 4)}
  </div>

  <div class="card" style="margin-bottom:16px;">
    <div class="section-title"><h3>Section G — Recommendation to Session</h3></div>
    <label style="display:flex; gap:8px; align-items:flex-start; font-weight:400; margin-bottom:8px;">
      <input type="radio" name="gRec" value="clear" style="width:auto; margin-top:3px;" ${g.recommendation === 'clear' ? 'checked' : ''}>
      <span>No concerns — the couple is to be cleared and provided with a counsellor.</span></label>
    <label style="display:flex; gap:8px; align-items:flex-start; font-weight:400;">
      <input type="radio" name="gRec" value="concerns" style="width:auto; margin-top:3px;" ${g.recommendation === 'concerns' ? 'checked' : ''}>
      <span>Concerns for which Session should be alerted.</span></label>
    <div class="field" style="margin-top:8px;"><label>Details of the concerns</label>${ta('g.details', g.details, 3)}</div>
  </div>

  <div class="card" style="margin-bottom:16px;">
    <div class="section-title"><h3>Section H — Authentication (signed on the printout)</h3></div>
    <p class="sub" style="margin-top:0;">Names prefill from Section A roles if left blank. Signatures and dates are completed BY HAND on the printed form.</p>
    <div class="field-row">
      <div class="field"><label>CFL Coordinator — name</label>${inp('h.coordinatorName', h.coordinatorName)}</div>
      <div class="field"><label>CFL Secretary — name</label>${inp('h.secretaryName', h.secretaryName)}</div>
      <div class="field" style="max-width:180px;"><label>Date (for signing)</label>${inp('h.signDate', h.signDate || a.date, '', 'date')}</div>
    </div>
  </div>`;

  // Section A attendance comes from the CFL roster (async).
  renderCflAttendance(f);
  // Section G: the details box only applies when there ARE concerns.
  const syncConcerns = () => {
    const rec = document.querySelector('input[name="gRec"]:checked');
    const box = document.querySelector('[data-f="g.details"]');
    if (!box) return;
    const noConcerns = rec && rec.value === 'clear';
    box.disabled = noConcerns || locked;
    box.placeholder = noConcerns ? 'Not applicable — no concerns raised.' : '';
    box.style.background = noConcerns ? 'var(--panel)' : '';
    if (noConcerns) box.value = '';
  };
  document.querySelectorAll('input[name="gRec"]').forEach(r => r.addEventListener('change', syncConcerns));
  syncConcerns();

  document.querySelectorAll('#formSections input, #formSections textarea, #formSections select')
    .forEach(el => { if (locked) el.disabled = true; });
  document.getElementById('saveBtn').style.display = locked ? 'none' : '';
  document.getElementById('saveBtn2').style.display = locked ? 'none' : '';
  document.getElementById('sendBtn').style.display = (current.stage === 'draft' && !locked) ? '' : 'none';
  document.getElementById('uploadBtn').style.display = ['draft', 'with-session'].includes(current.stage) ? '' : 'none';
  renderPhase2();
}

// ---------- Phase 2: Session approval → counselling → clearance → banns ----------
let counsellors = null;
async function getCounsellors() {
  if (!counsellors) { try { counsellors = await api('/counselling/counsellors'); } catch (e) { counsellors = []; } }
  return counsellors;
}

// Blank FR02 questionnaires — printed for the couple to fill privately.
function qBtns() {
  return `<a class="btn btn-secondary btn-sm" href="/api/marriage/cases/${current.id}/questionnaire.pdf?who=husband" target="_blank">🖨 Questionnaire — Husband</a>
    <a class="btn btn-secondary btn-sm" href="/api/marriage/cases/${current.id}/questionnaire.pdf?who=wife" target="_blank">🖨 Questionnaire — Wife</a>`;
}

async function renderPhase2() {
  const box = document.getElementById('phase2');
  const st = current.stage;
  const sa = current.sessionApproval || {};
  const cns = current.counselling || { meetings: [] };
  const dts = current.dates || {};
  const todayStr = new Date().toISOString().slice(0, 10);

  if (st === 'signed') {
    const list = await getCounsellors();
    box.innerHTML = `<div class="card" style="margin-bottom:16px; border-left:4px solid var(--primary);">
      <div class="section-title"><h3>Next step — record Session approval (Section I)</h3></div>
      <div class="field-row">
        <div class="field" style="max-width:180px;"><label>Date of Session approval</label><input type="date" id="p2Date"></div>
        <div class="field" style="max-width:200px;"><label>Session minute / ref no.</label><input type="text" id="p2Ref" placeholder="e.g. SM/2026/014"></div>
        <div class="field"><label>Assigned counsellor</label><select id="p2Counsellor">
          <option value="">— choose —</option>
          ${list.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}
        </select></div>
      </div>
      <div class="field-row">
        <div class="field" style="max-width:200px;"><label>Counselling commences</label><input type="date" id="p2Start"></div>
        <div class="field" style="max-width:200px;"><label>Couple informed on</label><input type="date" id="p2Informed"></div>
      </div>
      ${list.length ? '' : '<p class="sub">No counsellors on the list yet — an admin adds them on the Counselling page.</p>'}
      <button class="btn btn-primary" id="p2ApproveBtn">Record approval — start counselling</button>
      <div style="margin-top:10px;">${qBtns()}
        <span class="sub">Print for the couple to fill privately before counselling begins.</span></div>
    </div>`;
    document.getElementById('p2ApproveBtn').onclick = async () => {
      try {
        current = await api(`/marriage/cases/${current.id}/session-approval`, { method: 'POST', body: {
          date: document.getElementById('p2Date').value,
          minuteRef: document.getElementById('p2Ref').value,
          counsellorId: document.getElementById('p2Counsellor').value,
          counsellingStartDate: document.getElementById('p2Start').value,
          coupleInformedDate: document.getElementById('p2Informed').value,
        } });
        toast('Session approval recorded — counselling phase open');
        renderEditor();
      } catch (e) { toast(e.message, true); }
    };
    return;
  }

  if (st === 'counselling' || st === 'cleared') {
    const meetings = (cns.meetings || []).slice().sort((a, b) => a.date.localeCompare(b.date));
    box.innerHTML = `
    <div class="card" style="margin-bottom:16px; border-left:4px solid var(--primary);">
      <div class="section-title"><h3>Counselling — ${esc(sa.counsellorName || '')}</h3></div>
      <div class="sub" style="margin-bottom:10px;">Session approved ${sa.date ? fmtDate(sa.date) : '—'} (minute ${esc(sa.minuteRef || '—')})${sa.counsellingStartDate ? ` · commenced ${fmtDate(sa.counsellingStartDate)}` : ''}</div>
      <div style="margin-bottom:12px;">${qBtns()}
        <span class="sub">Each partner fills their copy privately; the counsellor compares the two.</span></div>
      <table style="margin-bottom:10px;"><thead><tr><th>Date</th><th>Meeting note</th><th>By</th></tr></thead><tbody>
        ${meetings.map(m => `<tr><td>${fmtDate(m.date)}</td><td>${esc(m.note || '')}</td><td class="sub">${esc(m.by || '')}</td></tr>`).join('') || '<tr><td colspan="3" class="sub">No meetings logged yet.</td></tr>'}
      </tbody></table>
      ${st === 'counselling' ? `
      <div class="field-row">
        <div class="field" style="max-width:180px;"><label>Meeting date</label><input type="date" id="p2MDate" value="${todayStr}"></div>
        <div class="field"><label>Brief note</label><input type="text" id="p2MNote" placeholder="e.g. Session 2 — communication & finances"></div>
        <div class="field" style="max-width:120px; align-self:flex-end;"><button class="btn btn-secondary" id="p2AddMeeting">Add</button></div>
      </div>` : ''}
      <div class="field"><label>Duration / agreed schedule</label><input type="text" id="p2Duration" value="${esc(cns.durationNote || '')}" placeholder="e.g. 6 weekly sessions, Saturdays 4pm" ${st === 'cleared' ? 'disabled' : ''}></div>
      <div class="field"><label>Counsellor's brief summary</label><textarea id="p2Summary" rows="3" ${st === 'cleared' ? 'disabled' : ''}>${esc(cns.summary || '')}</textarea></div>
      ${st === 'counselling' ? '<button class="btn btn-secondary" id="p2SaveCns">Save counselling notes</button>' : ''}
    </div>

    <div class="card" style="margin-bottom:16px;">
      <div class="section-title"><h3>Proposed marriage dates ${dts.marriageDate ? '' : '— required before clearance'}</h3></div>
      <div class="sub" style="margin:-4px 0 8px;">Usually two occasions: the traditional (customary) marriage, then the church wedding. Both dates are needed before clearance; the thanksgiving service, and every time and place, are optional and are used when the couple is presented to the Session.</div>
      ${[['Cust', 'customary', 'Traditional (customary) marriage', 'e.g. the bride’s family house, Kaneshie'], ['Marr', 'marriage', 'Church wedding', 'e.g. the AOTC Chapel'], ['Thx', 'thanksgiving', 'Thanksgiving service (optional)', 'e.g. the AOTC Chapel']].map(([id, key, label, ph]) => `
      <div class="field-row" style="align-items:flex-end;">
        <div class="field" style="max-width:200px;"><label>${label} — date</label><input type="date" id="p2${id}Date" value="${esc(dts[key + 'Date'] || '')}" ${st === 'cleared' ? 'disabled' : ''}></div>
        <div class="field" style="max-width:130px;"><label>Time</label><input type="text" id="p2${id}Time" value="${esc(dts[key + 'Time'] || '')}" placeholder="e.g. 10am" ${st === 'cleared' ? 'disabled' : ''}></div>
        <div class="field" style="flex:1 1 220px;"><label>Venue</label><input type="text" id="p2${id}Venue" value="${esc(dts[key + 'Venue'] || '')}" placeholder="${ph}" ${st === 'cleared' ? 'disabled' : ''}></div>
      </div>`).join('')}
      ${st === 'counselling' ? '<button class="btn btn-secondary" id="p2SaveDates">Save dates</button>' : ''}
      <div class="sub" id="p2DateHint"></div>
    </div>

    ${st === 'counselling' ? `<div class="card" style="margin-bottom:16px;">
      <button class="btn btn-primary" id="p2ClearBtn">✓ Counsellor clears the couple</button>
      <span class="sub" style="margin-left:10px;">Needs both proposed dates set. Moves the case to Session for final approval.</span>
    </div>` : `<div class="card" style="margin-bottom:16px; border-left:4px solid var(--primary);">
      <div class="section-title"><h3>Next step — Session final approval</h3></div>
      <div class="sub" style="margin-bottom:8px;">Cleared by ${esc(current.clearedBy || '')} on ${current.clearedAt ? fmtDate(current.clearedAt.slice(0, 10)) : '—'}. Marriage ${dts.marriageDate ? fmtDate(dts.marriageDate) : '—'}, customary ${dts.customaryDate ? fmtDate(dts.customaryDate) : '—'}.</div>
      <div class="field-row">
        <div class="field" style="max-width:180px;"><label>Final approval date</label><input type="date" id="p2FDate"></div>
        <div class="field" style="max-width:200px;"><label>Session minute / ref no.</label><input type="text" id="p2FRef"></div>
        <div class="field" style="max-width:220px; align-self:flex-end;"><button class="btn btn-primary" id="p2FinalBtn">Approve — schedule banns</button></div>
      </div>
    </div>`}`;

    const hint = document.getElementById('p2DateHint');
    const updateHint = () => {
      const val = document.getElementById('p2MarrDate').value;
      if (!val) { hint.textContent = ''; return; }
      const d = toLocalDate(val);
      hint.textContent = d.getDay() === 6
        ? 'Saturday — banns will fall on the three Sundays before it.'
        : `Note: ${d.toLocaleDateString('en-GB', { weekday: 'long' })} — weddings are usually Saturdays; banns will still be scheduled on the three Sundays before.`;
    };
    document.getElementById('p2MarrDate').addEventListener('change', updateHint);
    updateHint();

    if (st === 'counselling') {
      document.getElementById('p2AddMeeting').onclick = async () => {
        try {
          current = await api(`/marriage/cases/${current.id}/meetings`, { method: 'POST', body: {
            date: document.getElementById('p2MDate').value, note: document.getElementById('p2MNote').value } });
          toast('Meeting logged'); renderPhase2();
        } catch (e) { toast(e.message, true); }
      };
      document.getElementById('p2SaveCns').onclick = async () => {
        try {
          current = await api(`/marriage/cases/${current.id}/counselling`, { method: 'PUT', body: {
            summary: document.getElementById('p2Summary').value, durationNote: document.getElementById('p2Duration').value } });
          toast('Counselling notes saved');
        } catch (e) { toast(e.message, true); }
      };
      document.getElementById('p2SaveDates').onclick = async () => {
        try {
          current = await api(`/marriage/cases/${current.id}/dates`, { method: 'PUT', body: {
            marriageDate: document.getElementById('p2MarrDate').value, customaryDate: document.getElementById('p2CustDate').value,
            marriageTime: document.getElementById('p2MarrTime').value, customaryTime: document.getElementById('p2CustTime').value,
            marriageVenue: document.getElementById('p2MarrVenue').value, customaryVenue: document.getElementById('p2CustVenue').value,
            thanksgivingDate: document.getElementById('p2ThxDate').value, thanksgivingTime: document.getElementById('p2ThxTime').value, thanksgivingVenue: document.getElementById('p2ThxVenue').value } });
          toast('Proposed dates saved');
        } catch (e) { toast(e.message, true); }
      };
      document.getElementById('p2ClearBtn').onclick = async () => {
        if (!await confirmDialog('Clear the couple? Confirms counselling is complete; the case goes to Session for FINAL approval.')) return;
        try {
          current = await api(`/marriage/cases/${current.id}/clear`, { method: 'POST', body: { summary: document.getElementById('p2Summary').value } });
          toast('Couple cleared — awaiting Session final approval');
          renderEditor();
        } catch (e) { toast(e.message, true); }
      };
    } else {
      document.getElementById('p2FinalBtn').onclick = async () => {
        try {
          current = await api(`/marriage/cases/${current.id}/final-approval`, { method: 'POST', body: {
            date: document.getElementById('p2FDate').value, minuteRef: document.getElementById('p2FRef').value } });
          toast('Final approval recorded — banns scheduled');
          renderEditor();
        } catch (e) { toast(e.message, true); }
      };
    }
    return;
  }

  if (st === 'approved') {
    const fa = current.finalApproval || {};
    const banns = current.banns || [];
    box.innerHTML = `<div class="card" style="margin-bottom:16px; border-left:4px solid var(--pcg-green, #00734A);">
      <div class="section-title"><h3>Banns of marriage — ${dts.marriageDate ? fmtDate(dts.marriageDate) : ''}</h3></div>
      <div class="sub" style="margin-bottom:10px;">Final approval ${fa.date ? fmtDate(fa.date) : '—'} (minute ${esc(fa.minuteRef || '—')}) · customary marriage ${dts.customaryDate ? fmtDate(dts.customaryDate) : '—'} · counsellor ${esc(sa.counsellorName || '—')}</div>
      <table><thead><tr><th></th><th>Sunday</th><th>Status</th><th></th></tr></thead><tbody>
        ${banns.map(b => {
          const missed = !b.published && b.date < todayStr;
          const badge = b.published
            ? `<span class="badge badge-done" title="by ${esc(b.publishedBy || '')}">published ✓</span>`
            : missed ? '<span class="badge badge-critical">NOT marked published</span>'
              : '<span class="badge badge-progress">upcoming</span>';
          return `<tr>
            <td><b>Banns ${b.no} of 3</b></td>
            <td>${fmtDate(b.date)}</td>
            <td>${badge}</td>
            <td>${!b.published ? `<button class="btn btn-primary btn-sm" onclick="markBann(${b.no})">Mark published</button>` : ''}</td>
          </tr>`;
        }).join('')}
      </tbody></table>
      <p class="sub" style="margin-bottom:0;">The Session Clerk gets a reminder 2 days before each Sunday, on the day, and a flag the day after if a bann isn't marked published.</p>
    </div>
    ${banns.every(b => b.published) ? `<div class="card" style="margin-bottom:16px; border-left:4px solid var(--pcg-green, #00734A);">
      <div class="section-title"><h3>Record the solemnisation</h3></div>
      <div class="field-row">
        <div class="field" style="max-width:180px;"><label>Marriage date</label><input type="date" id="p3Date" value="${esc(dts.marriageDate || '')}"></div>
        <div class="field"><label>Officiating minister</label><input type="text" id="p3Officiant" placeholder="e.g. Rev. Dr. K. Asante"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Venue</label><input type="text" id="p3Venue" placeholder="e.g. AOTC sanctuary, Adabraka"></div>
        <div class="field" style="max-width:180px;"><label>Certificate no. (optional)</label><input type="text" id="p3Cert"></div>
      </div>
      <label style="display:flex; align-items:center; gap:8px; font-weight:400; margin-bottom:10px;">
        <input type="checkbox" id="p3Customary" style="width:auto;" ${dts.customaryDate ? 'checked' : ''}> Customary marriage performed
      </label>
      <button class="btn btn-primary" id="p3MarryBtn">✓ Solemnised — enter in the marriage register</button>
    </div>` : ''}`;
    if (banns.every(b => b.published)) {
      document.getElementById('p3MarryBtn').onclick = async () => {
        if (!await confirmDialog('Record the marriage as solemnised and enter it in the register?')) return;
        try {
          current = await api(`/marriage/cases/${current.id}/solemnised`, { method: 'POST', body: {
            date: document.getElementById('p3Date').value,
            officiant: document.getElementById('p3Officiant').value,
            venue: document.getElementById('p3Venue').value,
            certificateNo: document.getElementById('p3Cert').value,
            customaryDone: document.getElementById('p3Customary').checked,
          } });
          toast('Entered in the marriage register 🎉');
          renderEditor();
        } catch (e) { toast(e.message, true); }
      };
    }
    return;
  }

  if (st === 'married') {
    const so = current.solemnised || {};
    box.innerHTML = `<div class="card" style="margin-bottom:16px; border-left:4px solid var(--pcg-green, #00734A);">
      <div class="section-title"><h3>Married ✓</h3></div>
      <p style="margin:0 0 4px;">Solemnised <b>${so.date ? fmtDate(so.date) : '—'}</b> by <b>${esc(so.officiant || '—')}</b>${so.venue ? ` at ${esc(so.venue)}` : ''}.</p>
      <p class="sub" style="margin:0;">${so.certificateNo ? `Certificate no. ${esc(so.certificateNo)} · ` : ''}customary marriage ${so.customaryDone ? 'performed' : 'not recorded'} · counsellor ${esc(sa.counsellorName || '—')} · recorded by ${esc(so.recordedBy || '')}</p>
      <div style="margin-top:10px;"><a class="btn btn-secondary btn-sm" href="/api/marriage/register.pdf?year=${(so.date || '').slice(0, 4)}" target="_blank">📖 Marriage Register ${esc((so.date || '').slice(0, 4))}</a></div>
    </div>`;
    return;
  }

  box.innerHTML = '';
}

window.markBann = async function (no) {
  if (!await confirmDialog(`Mark banns ${no} of 3 as published in church?`)) return;
  try {
    current = await api(`/marriage/cases/${current.id}/banns/${no}/published`, { method: 'POST' });
    toast(`Banns ${no} of 3 marked published`);
    renderPhase2();
  } catch (e) { toast(e.message, true); }
};

function collectForm() {
  const form = { a: { committee: [] }, b: { husband: {}, wife: {} }, c: { husbandFamily: [], wifeFamily: [] }, d: {}, e: { h: {}, w: {} }, f: '', g: {}, h: {} };
  document.querySelectorAll('#formSections [data-f]').forEach(el => {
    const parts = el.dataset.f.split('.');
    let node = form;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      const idx = /^\d+$/.test(parts[i + 1]) ? Number(parts[i + 1]) : null;
      if (idx !== null) { node[key] = node[key] || []; node[key][idx] = node[key][idx] || {}; node = node[key][idx]; i++; }
      else { node[key] = node[key] || {}; node = node[key]; }
    }
    node[parts[parts.length - 1]] = el.value;
  });
  const rec = document.querySelector('input[name="gRec"]:checked');
  form.g.recommendation = rec ? rec.value : '';
  // Section A attendance: ticked committee members (ids + resolved names).
  const ticked = [...document.querySelectorAll('.cfl-att:checked')];
  form.attendance = { presentMemberIds: ticked.map(x => Number(x.value)) };
  form.a.committee = ticked.slice(0, 10).map(x => ({ name: x.dataset.name, role: x.dataset.role }));
  form.a.committee = (form.a.committee || []).filter(Boolean);
  form.c.husbandFamily = (form.c.husbandFamily || []).filter(Boolean);
  form.c.wifeFamily = (form.c.wifeFamily || []).filter(Boolean);
  return form;
}

async function saveForm(silent) {
  current = await api(`/marriage/cases/${current.id}/form`, { method: 'PUT', body: { form: collectForm() } });
  if (!silent) toast('Interview form saved');
  renderEditor();
}

window.openCase = async function (id) {
  current = await api(`/marriage/cases/${id}`);
  document.getElementById('listView').style.display = 'none';
  document.getElementById('editView').style.display = '';
  renderEditor();
  window.scrollTo({ top: 0 });
  const sh = document.querySelector('.shell'); if (sh) sh.scrollTo({ top: 0 });
};
window.delCase = async function (id) {
  if (!await confirmDialog('Delete this marriage case AND its filed signed copy? This cannot be undone.')) return;
  try { await api(`/marriage/cases/${id}`, { method: 'DELETE' }); toast('Case deleted'); loadList(); }
  catch (e) { toast(e.message, true); }
};

document.getElementById('backBtn').onclick = () => {
  document.getElementById('editView').style.display = 'none';
  document.getElementById('listView').style.display = '';
  loadList();
};
document.getElementById('saveBtn').onclick = () => saveForm().catch(e => toast(e.message, true));
document.getElementById('saveBtn2').onclick = () => saveForm().catch(e => toast(e.message, true));
document.getElementById('pdfBtn').onclick = async () => {
  try { if (current.stage !== 'signed') await saveForm(true); } catch (e) { return toast(e.message, true); }
  window.open(`/api/marriage/cases/${current.id}/form.pdf`, '_blank');
};
document.getElementById('sendBtn').onclick = async () => {
  try {
    await saveForm(true);
    if (!await confirmDialog('Mark this form as printed and sent to Session? You can still edit until the signed copy is uploaded.')) return;
    current = await api(`/marriage/cases/${current.id}/send-to-session`, { method: 'POST' });
    toast('Marked as with Session');
    renderEditor();
  } catch (e) { toast(e.message, true); }
};

// ---------- New case ----------
document.getElementById('newCaseBtn').onclick = () => { document.getElementById('newForm').reset(); document.getElementById('nOverlay').style.display = 'flex'; };
document.getElementById('nCancelBtn').onclick = () => document.getElementById('nOverlay').style.display = 'none';
document.getElementById('newForm').addEventListener('submit', async e => {
  e.preventDefault();
  try {
    const rec = await api('/marriage/cases', { method: 'POST', body: {
      husbandName: document.getElementById('nHName').value,
      husbandPhone: document.getElementById('nHPhone').value,
      wifeName: document.getElementById('nWName').value,
      wifePhone: document.getElementById('nWPhone').value,
    } });
    document.getElementById('nOverlay').style.display = 'none';
    toast(`Case ${rec.refNo} opened`);
    openCase(rec.id);
  } catch (err) { toast(err.message, true); }
});

// ---------- Signed-scan upload (phone camera → one PDF) ----------
let scanPages = [];   // [{ blob, thumbUrl }]
let scanPdfFile = null;

function renderPages() {
  const box = document.getElementById('pageList');
  if (scanPdfFile) {
    box.innerHTML = `<div class="sub">📄 ${esc(scanPdfFile.name)} (${(scanPdfFile.size / 1048576).toFixed(1)} MB)
      <button class="btn btn-danger btn-sm" onclick="clearScan()">✕</button></div>`;
  } else {
    box.innerHTML = scanPages.map((p, i) => `
      <div style="position:relative; width:84px;">
        <img src="${p.thumbUrl}" style="width:84px; height:112px; object-fit:cover; border:1px solid var(--rule); border-radius:6px;">
        <div class="sub" style="text-align:center; font-size:10.5px;">p.${i + 1}</div>
        <div style="display:flex; gap:2px; justify-content:center;">
          <button class="btn btn-secondary btn-sm" style="padding:1px 6px;" onclick="movePage(${i},-1)" ${i === 0 ? 'disabled' : ''}>←</button>
          <button class="btn btn-danger btn-sm" style="padding:1px 6px;" onclick="dropPage(${i})">✕</button>
          <button class="btn btn-secondary btn-sm" style="padding:1px 6px;" onclick="movePage(${i},1)" ${i === scanPages.length - 1 ? 'disabled' : ''}>→</button>
        </div>
      </div>`).join('');
  }
  document.getElementById('uSendBtn').disabled = !scanPdfFile && !scanPages.length;
  document.getElementById('uStatus').textContent = scanPdfFile ? '' :
    scanPages.length ? `${scanPages.length} page photo(s) — they'll be merged into one PDF in this order.` : '';
}
window.movePage = (i, dir) => { const t = scanPages[i]; scanPages[i] = scanPages[i + dir]; scanPages[i + dir] = t; renderPages(); };
window.dropPage = (i) => { URL.revokeObjectURL(scanPages[i].thumbUrl); scanPages.splice(i, 1); renderPages(); };
window.clearScan = () => { scanPdfFile = null; renderPages(); };

// Downscale each photo to ≤1800px JPEG so a 5-page upload stays small.
function compressImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const maxSide = 1800;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const cv = document.createElement('canvas');
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      cv.toBlob(b => { URL.revokeObjectURL(url); resolve(b || file); }, 'image/jpeg', 0.82);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

document.getElementById('scanCam').addEventListener('change', async e => {
  scanPdfFile = null;
  document.getElementById('uStatus').textContent = 'Preparing photos…';
  for (const file of e.target.files) {
    const blob = await compressImage(file);
    scanPages.push({ blob, thumbUrl: URL.createObjectURL(blob) });
  }
  e.target.value = '';
  renderPages();
});
document.getElementById('scanPdf').addEventListener('change', e => {
  if (e.target.files[0]) { scanPages.forEach(p => URL.revokeObjectURL(p.thumbUrl)); scanPages = []; scanPdfFile = e.target.files[0]; }
  e.target.value = '';
  renderPages();
});

document.getElementById('uploadBtn').onclick = () => {
  scanPages = []; scanPdfFile = null; renderPages();
  document.getElementById('uOverlay').style.display = 'flex';
};
document.getElementById('uCancelBtn').onclick = () => document.getElementById('uOverlay').style.display = 'none';
document.getElementById('uSendBtn').onclick = async () => {
  const btn = document.getElementById('uSendBtn');
  btn.disabled = true;
  document.getElementById('uStatus').textContent = 'Uploading…';
  try {
    const fd = new FormData();
    if (scanPdfFile) fd.append('pages', scanPdfFile, scanPdfFile.name);
    else scanPages.forEach((p, i) => fd.append('pages', p.blob, `page-${i + 1}.jpg`));
    const res = await fetch(`/api/marriage/cases/${current.id}/signed`, { method: 'POST', body: fd, credentials: 'same-origin' });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || 'Upload failed.');
    current = json;
    document.getElementById('uOverlay').style.display = 'none';
    toast('Signed copy filed — counselling phase unlocked');
    renderEditor();
  } catch (e) {
    toast(e.message, true);
    document.getElementById('uStatus').textContent = '';
    btn.disabled = false;
  }
};

document.getElementById('registerBtn').onclick = () => {
  const year = prompt('Marriage register for which year?', String(new Date().getFullYear()));
  if (!year) return;
  window.open(`/api/marriage/register.pdf?year=${Number(year) || new Date().getFullYear()}`, '_blank');
};

requireAuthAndRenderShell('/marriage.html').then(u => { me = u; loadList(); });
