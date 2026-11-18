// Documents page — SharePoint-style library with per-document access levels.
// Levels: none < view < download < manage. Uploading needs docs.upload (or
// admin tier); changing WHO can access a document is admin-tier only.
let me, docs = [], categories = [], usersList = null;
let canUpload = false, isAdminTier = false;
let editingDoc = null;   // null = uploading new
let permDoc = null;

const OVERRIDE_ROLES = [
  ['clerk', 'Session Clerk'],
  ['coordinator', 'Reporting Coordinator'],
  ['secretary', 'Committee/Group Secretary'],
  ['attendance', 'Attendance Officer'],
  ['treasurer', 'Treasurer'],
  ['accounts', 'Accounts Clerk'],
  ['viewer', 'Viewer (Minister/Session)'],
];
// 24x24 stroke icon paths (same style as the nav icons; rendered via iconSvg).
let savedIds = new Set();   // documents kept on this device (IndexedDB)

const ICONS = {
  view: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3',
  access: 'M19 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2zM7 11V7a5 5 0 0 1 10 0v4',
  edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z',
  del: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14M10 11v6M14 11v6',
  sync: 'M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15',
  pin: 'M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z',
};
const iconBtn = (kind, title, onclick, extra = '') =>
  `<button class="btn ${extra || 'btn-secondary'} btn-sm btn-icon" title="${title}" aria-label="${title}" onclick="${onclick}">${iconSvg(ICONS[kind])}</button>`;

const LEVEL_BADGE = {
  view: '<span class="badge">View only</span>',
  download: '<span class="badge badge-done">View & download</span>',
  manage: '<span class="badge badge-done">Full control</span>',
};

function fmtSize(bytes) {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}
function fileKind(mt) {
  if (mt === 'application/pdf') return 'PDF';
  if (mt.startsWith('image/')) return 'Image';
  if (mt.includes('wordprocessingml') || mt === 'application/msword') return 'Word';
  if (mt.includes('spreadsheetml') || mt === 'application/vnd.ms-excel') return 'Excel';
  if (mt.includes('presentationml') || mt === 'application/vnd.ms-powerpoint') return 'PowerPoint';
  if (mt === 'text/csv') return 'CSV';
  if (mt === 'text/plain') return 'Text';
  return 'File';
}

async function load() {
  try { savedIds = new Set((await shOffline.list()).map(s => s.id)); } catch (e) { /* no IndexedDB */ }
  const [res, cats] = await Promise.all([api('/documents'), api('/documents/categories')]);
  docs = res.documents; canUpload = res.canUpload; isAdminTier = res.isAdmin;
  categories = cats;
  syncOfflineCopies().catch(() => {});
  document.getElementById('uploadBtn').style.display = canUpload ? '' : 'none';
  document.getElementById('catBtn').style.display = isAdminTier ? '' : 'none';
  const catOptions = categories.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  // load() runs again after every upload, edit and category change, and
  // rebuilding the options resets the select — which threw you back to "All
  // categories" mid-task. Keep the choice, unless that category is now gone.
  const catFilter = document.getElementById('catFilter');
  const keepCat = catFilter.value;
  catFilter.innerHTML = '<option value="">All categories</option>' + catOptions;
  if (keepCat && [...catFilter.options].some(o => o.value === keepCat)) catFilter.value = keepCat;
  // Admins can mint a new category straight from the upload/edit form.
  document.getElementById('dCategory').innerHTML = catOptions
    + (isAdminTier ? '<option value="__new__">+ Create new category…</option>' : '');
  render();
}

// Colour + short tag per file kind, for the list's leading badge.
function kindTag(mt) {
  const k = fileKind(mt);
  const colours = { PDF: '#C0392B', Word: '#1D4ED8', Excel: '#00734A', PowerPoint: '#C2410C', Image: '#7C3AED', CSV: '#00734A', Text: '#475569', File: '#475569' };
  return `<span class="doc-kind" style="background:${colours[k] || '#475569'}">${esc(k === 'PowerPoint' ? 'PPT' : k)}</span>`;
}

// The list stays deliberately quiet: file kind + name (+ a small badge when a
// copy is on this device). Category, size, uploader, access level and every
// action live behind the ⋯ button, so phones aren't crowded.
function render() {
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const cat = document.getElementById('catFilter').value;
  const shown = docs.filter(d =>
    (!cat || d.category === cat) &&
    (!q || [d.title, d.originalName, d.description, (d.uploadedBy || {}).userName].join(' ').toLowerCase().includes(q))
  );
  document.getElementById('countLabel').textContent =
    shown.length === docs.length ? `${docs.length} document${docs.length === 1 ? '' : 's'}` : `${shown.length} of ${docs.length} documents`;
  document.getElementById('rows').innerHTML = shown.length ? shown.map(d => `
    <div class="doc-row">
      <button type="button" class="doc-main" onclick="viewDoc(${d.id})" title="Open">
        ${kindTag(d.mimetype)}
        <span class="doc-name">${esc(d.title)}</span>
        ${savedIds.has(d.id) ? '<span class="doc-offline-dot" title="Kept on this device"></span>' : ''}
      </button>
      <button type="button" class="doc-more" onclick="openDetails(${d.id})" title="More" aria-label="More about this document">⋯</button>
    </div>`).join('')
    : `<div class="sub" style="text-align:center; padding:28px;">No documents ${q || cat ? 'match your filter' : 'have been shared with you yet'}.</div>`;
}

// ---- Details / actions sheet (the ⋯ button) ----
function openDetails(id) {
  const d = docs.find(x => x.id === id);
  if (!d) return;
  const canDownload = ['download', 'manage'].includes(d.myLevel);
  const canManage = d.myLevel === 'manage';
  const row = (label, value) => `<div class="doc-detail"><span>${label}</span><strong>${value}</strong></div>`;
  document.getElementById('detailsTitle').textContent = d.title;
  document.getElementById('detailsBody').innerHTML = `
    ${d.description ? `<p class="sub" style="margin:0 0 10px;">${esc(d.description)}</p>` : ''}
    ${row('Category', esc(d.category))}
    ${row('File', `${esc(fileKind(d.mimetype))} · ${fmtSize(d.size)}`)}
    ${row('File name', `<span class="mono" style="font-size:12px;">${esc(d.originalName)}</span>`)}
    ${row('Uploaded by', esc((d.uploadedBy || {}).userName || '—'))}
    ${row('Last updated', fmtDate(d.updatedAt))}
    ${row('My access', LEVEL_BADGE[d.myLevel] || '')}
    ${savedIds.has(d.id) ? row('Offline', '<span class="badge badge-done">Kept on this device</span>') : ''}
    <div class="doc-actions">
      ${d.inlineViewable ? `<button class="btn btn-primary btn-sm" onclick="closeDetails(); viewDoc(${d.id});">Open</button>` : ''}
      ${canDownload ? `<button class="btn btn-secondary btn-sm" onclick="downloadDoc(${d.id}, this)">Download</button>` : ''}
      ${canDownload ? `<button class="btn btn-secondary btn-sm" onclick="toggleOffline(${d.id}); closeDetails();">${savedIds.has(d.id) ? 'Remove from device' : 'Keep on this device'}</button>` : ''}
      ${isAdminTier ? `<button class="btn btn-secondary btn-sm" onclick="closeDetails(); openPerms(${d.id});">Who can access</button>` : ''}
      ${canManage ? `<button class="btn btn-secondary btn-sm" onclick="closeDetails(); editDoc(${d.id});">Edit / replace</button>
                     <button class="btn btn-danger btn-sm" onclick="closeDetails(); deleteDoc(${d.id});">Delete</button>` : ''}
    </div>`;
  document.getElementById('detailsOverlay').style.display = 'flex';
}
function closeDetails() {
  document.getElementById('detailsOverlay').style.display = 'none';
}

// ---- In-app PDF viewer (PDF.js, vendored — same experience on phone & PC).
// View-only users receive the server-watermarked copy through /file.
let pdfjsReady = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/js/vendor/pdfjs/pdf.min.js';
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdfjs/pdf.worker.min.js';
      resolve();
    };
    s.onerror = () => reject(new Error('Could not load the PDF viewer.'));
    document.head.appendChild(s);
  });
  return pdfjsReady;
}

async function openPdfViewer(title, dataPromise) {
  const viewer = document.getElementById('pdfViewer');
  const pagesEl = document.getElementById('pdfViewerPages');
  document.getElementById('pdfViewerTitle').textContent = title;
  pagesEl.innerHTML = '<div class="pdfviewer-status">Opening document…</div>';
  viewer.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  // Push a history entry so the phone's back button (and browser Back)
  // closes the viewer instead of leaving ShareHub.
  history.pushState({ shViewer: true }, '');
  try {
    const [data] = await Promise.all([dataPromise, loadPdfJs()]);
    const pdf = await window.pdfjsLib.getDocument({ data }).promise;
    pagesEl.innerHTML = '';
    const maxWidth = Math.min(pagesEl.clientWidth - 24, 900);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const scale = (maxWidth / base.width) * dpr;
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      canvas.style.width = (vp.width / dpr) + 'px';
      pagesEl.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    }
  } catch (e) {
    pagesEl.innerHTML = `<div class="pdfviewer-status">${esc(e.message || 'Could not open this document.')}</div>`;
  }
}
function closePdfViewer(fromPopState) {
  const viewer = document.getElementById('pdfViewer');
  const wasOpen = viewer.style.display !== 'none';
  viewer.style.display = 'none';
  document.getElementById('pdfViewerPages').innerHTML = '';
  document.body.style.overflow = '';
  // Closing via the ✕ button must also consume the history entry we pushed.
  if (wasOpen && !fromPopState && history.state && history.state.shViewer) history.back();
}
window.addEventListener('popstate', () => {
  const viewer = document.getElementById('pdfViewer');
  if (viewer && viewer.style.display !== 'none') closePdfViewer(true);
});

async function fetchDocBytes(id) {
  const res = await fetch(`/api/documents/${id}/file`, { credentials: 'same-origin' });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || 'Could not open this document.');
  }
  return new Uint8Array(await res.arrayBuffer());
}

// Everything opens INSIDE ShareHub. In the installed app there's no browser
// back arrow, so opening a new tab/window would strand the reader.
const WORD_TYPES = ['application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
const EXCEL_TYPES = ['application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];

function viewDoc(id) {
  const d = docs.find(x => x.id === id);
  if (!d) return;
  if (d.mimetype === 'application/pdf') return openPdfViewer(d.title, fetchDocBytes(id));
  if (d.mimetype.startsWith('image/')) return openImageViewer(d);
  if (WORD_TYPES.includes(d.mimetype)) return openWordViewer(d);
  if (EXCEL_TYPES.includes(d.mimetype) || d.mimetype === 'text/csv') return openSheetViewer(d);
  if (d.mimetype === 'text/plain') return openTextViewer(d);
  // PowerPoint has no reliable in-browser renderer — saving is the only way
  // to read it, which download-level access already allows.
  downloadDoc(id);
}

// Lazily pull a vendored renderer in only when a document needs it.
function loadScriptOnce(src, ready) {
  if (ready()) return Promise.resolve();
  loadScriptOnce._p = loadScriptOnce._p || {};
  if (loadScriptOnce._p[src]) return loadScriptOnce._p[src];
  loadScriptOnce._p[src] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the viewer for this file type.'));
    document.head.appendChild(s);
  });
  return loadScriptOnce._p[src];
}

// Shared chrome for the non-PDF viewers.
function beginViewer(title) {
  const viewer = document.getElementById('pdfViewer');
  const pagesEl = document.getElementById('pdfViewerPages');
  document.getElementById('pdfViewerTitle').textContent = title;
  pagesEl.innerHTML = '<div class="pdfviewer-status">Opening…</div>';
  viewer.style.display = 'flex';
  document.body.style.overflow = 'hidden';
  history.pushState({ shViewer: true }, '');
  return pagesEl;
}

async function openWordViewer(d) {
  const pagesEl = beginViewer(d.title);
  try {
    const [bytes] = await Promise.all([
      fetchDocBytes(d.id),
      loadScriptOnce('/js/vendor/mammoth.browser.min.js', () => !!window.mammoth),
    ]);
    const result = await window.mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
    pagesEl.innerHTML = `<div class="doc-paper">${result.value || '<p class="sub">This document has no readable text (it may be all images).</p>'}</div>`;
  } catch (e) {
    pagesEl.innerHTML = `<div class="pdfviewer-status">${esc(e.message || 'Could not open this document.')}</div>`;
  }
}

async function openSheetViewer(d) {
  const pagesEl = beginViewer(d.title);
  try {
    const [bytes] = await Promise.all([
      fetchDocBytes(d.id),
      loadScriptOnce('/js/vendor/xlsx.full.min.js', () => !!window.XLSX),
    ]);
    const wb = window.XLSX.read(bytes, { type: 'array' });
    const sheets = wb.SheetNames.map(name => {
      const html = window.XLSX.utils.sheet_to_html(wb.Sheets[name], { editable: false });
      return `<h3 class="doc-sheet-name">${esc(name)}</h3><div class="doc-sheet">${html}</div>`;
    }).join('');
    pagesEl.innerHTML = `<div class="doc-paper">${sheets || '<p class="sub">This workbook is empty.</p>'}</div>`;
  } catch (e) {
    pagesEl.innerHTML = `<div class="pdfviewer-status">${esc(e.message || 'Could not open this spreadsheet.')}</div>`;
  }
}

async function openImageViewer(d) {
  const pagesEl = beginViewer(d.title);
  try {
    const res = await fetch(`/api/documents/${d.id}/file`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || 'Could not open this image.');
    const url = URL.createObjectURL(await res.blob());
    pagesEl.innerHTML = `<img src="${url}" alt="${esc(d.title)}" style="max-width:100%; height:auto; border-radius:4px;">`;
    setTimeout(() => URL.revokeObjectURL(url), 300000);
  } catch (e) {
    pagesEl.innerHTML = `<div class="pdfviewer-status">${esc(e.message)}</div>`;
  }
}

async function openTextViewer(d) {
  const pagesEl = beginViewer(d.title);
  try {
    const res = await fetch(`/api/documents/${d.id}/file`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))).error) || 'Could not open this file.');
    const text = await res.text();
    pagesEl.innerHTML = `<pre style="text-align:left; white-space:pre-wrap; word-break:break-word; background:#fff; color:#111; padding:16px; border-radius:6px; max-width:900px; margin:0 auto; font-size:13px;">${esc(text.slice(0, 400000))}</pre>`;
  } catch (e) {
    pagesEl.innerHTML = `<div class="pdfviewer-status">${esc(e.message)}</div>`;
  }
}

// ---- Keep on this device (offline copies, download-level users only) ----
async function fetchDocBlob(id) {
  const res = await fetch(`/api/documents/${id}/download`, { credentials: 'same-origin' });
  if (!res.ok) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error || 'Could not fetch the document.');
  }
  return res.blob();
}

async function toggleOffline(id, btn) {
  const d = docs.find(x => x.id === id);
  if (!d) return;
  try {
    if (savedIds.has(id)) {
      await shOffline.remove(id);
      savedIds.delete(id);
      toast('Removed from this device.');
    } else {
      if (btn) { btn.disabled = true; btn.classList.add('btn-syncing'); btn.innerHTML = iconSvg(ICONS.sync); }
      const blob = await fetchDocBlob(id);
      await shOffline.save({
        id: d.id, title: d.title, category: d.category, mimetype: d.mimetype,
        size: d.size, updatedAt: d.updatedAt, originalName: d.originalName,
      }, blob);
      savedIds.add(id);
      toast('Saved — available on this device even offline.');
    }
  } catch (e) { toast(e.message, true); }
  render();
}

// Auto-sync: refresh replaced files, drop deleted/revoked ones. Runs quietly
// on every online page load.
async function syncOfflineCopies() {
  let updated = 0, removed = 0;
  let saved;
  try { saved = await shOffline.list(); } catch (e) { return; }
  for (const s of saved) {
    const cur = docs.find(d => d.id === s.id);
    if (!cur || !['download', 'manage'].includes(cur.myLevel)) {
      await shOffline.remove(s.id); removed++;              // deleted or access revoked
    } else if ((cur.updatedAt || '') !== (s.updatedAt || '')) {
      try {
        const blob = await fetchDocBlob(s.id);              // file was replaced
        await shOffline.save({
          id: cur.id, title: cur.title, category: cur.category, mimetype: cur.mimetype,
          size: cur.size, updatedAt: cur.updatedAt, originalName: cur.originalName,
        }, blob);
        updated++;
      } catch (e) { /* try again next visit */ }
    }
  }
  savedIds = new Set((await shOffline.list()).map(s => s.id));
  if (updated || removed) {
    toast(`Offline copies synced${updated ? ` — ${updated} updated` : ''}${removed ? ` — ${removed} removed` : ''}.`);
    render();
  }
}
// Fetch the bytes first, then save from a blob URL. Navigating straight to
// the API URL made some mobile browsers replace the page (leaving people
// stranded with no way back) — this keeps ShareHub on screen throughout.
async function downloadDoc(id, btn) {
  const d = docs.find(x => x.id === id);
  const restore = () => {
    if (!btn) return;
    btn.disabled = false;
    btn.classList.remove('btn-syncing');
    btn.innerHTML = iconSvg(ICONS.download);
  };
  if (btn) { btn.disabled = true; btn.classList.add('btn-syncing'); btn.innerHTML = iconSvg(ICONS.sync); }
  try {
    const blob = await fetchDocBlob(id);
    const name = (d && (d.originalName || d.title)) || 'document';
    const how = await shSaveFile(blob, name, d && d.mimetype, d && d.title);
    if (how === 'downloaded') toast('Saved to your downloads.');
    else if (how === 'shared') toast('Sent to your device.');
  } catch (e) { toast(e.message, true); }
  restore();
}

// ---- Upload / edit ----
function openUpload() {
  editingDoc = null;
  document.getElementById('docTitle').textContent = 'Upload document';
  document.getElementById('docSaveBtn').textContent = 'Upload';
  document.getElementById('docForm').reset();
  document.getElementById('dNewCatField').style.display = 'none';
  document.getElementById('dFile').required = true;
  document.getElementById('docNote').textContent = isAdminTier
    ? 'New documents start as “everyone can view”. Use the Access button afterwards to restrict or widen it.'
    : 'New documents start as “everyone can view”. An administrator can restrict access afterwards.';
  document.getElementById('docOverlay').style.display = 'flex';
}
function editDoc(id) {
  editingDoc = docs.find(d => d.id === id);
  if (!editingDoc) return;
  document.getElementById('docTitle').textContent = 'Edit document';
  document.getElementById('docSaveBtn').textContent = 'Save';
  document.getElementById('docForm').reset();
  document.getElementById('dNewCatField').style.display = 'none';
  document.getElementById('dFile').required = false;
  document.getElementById('dTitle').value = editingDoc.title;
  document.getElementById('dCategory').value = editingDoc.category;
  document.getElementById('dDesc').value = editingDoc.description || '';
  document.getElementById('docNote').textContent = 'Choosing a file replaces the current one (' + editingDoc.originalName + ').';
  document.getElementById('docOverlay').style.display = 'flex';
}

async function saveDoc(e) {
  e.preventDefault();
  const btn = document.getElementById('docSaveBtn');
  const file = document.getElementById('dFile').files[0];
  const title = document.getElementById('dTitle').value.trim();
  let category = document.getElementById('dCategory').value;
  const description = document.getElementById('dDesc').value.trim();
  const btnLabel = btn.textContent;
  btn.disabled = true;
  btn.classList.add('btn-icon', 'btn-syncing');
  btn.innerHTML = `${iconSvg(ICONS.sync)}<span>${editingDoc ? 'Saving…' : 'Uploading…'}</span>`;
  try {
    if (category === '__new__') {
      const name = document.getElementById('dNewCat').value.trim();
      if (!name) throw new Error('Type a name for the new category.');
      const created = await api('/documents/categories', { method: 'POST', body: { name } });
      categories.push(created);
      category = created.name;
    }
    if (!editingDoc) {
      if (!file) throw new Error('Choose a file to upload.');
      const fd = new FormData();
      fd.append('file', file, file.name);
      fd.append('title', title || file.name);
      fd.append('category', category);
      fd.append('description', description);
      const res = await fetch('/api/documents', { method: 'POST', body: fd, credentials: 'same-origin' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Upload failed.');
      toast('Document uploaded.');
    } else {
      await api(`/documents/${editingDoc.id}`, { method: 'PUT', body: { title, category, description } });
      if (file) {
        const fd = new FormData();
        fd.append('file', file, file.name);
        const res = await fetch(`/api/documents/${editingDoc.id}/file`, { method: 'POST', body: fd, credentials: 'same-origin' });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || 'Replacing the file failed.');
      }
      toast('Document updated.');
    }
    document.getElementById('docOverlay').style.display = 'none';
    await load();
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.classList.remove('btn-icon', 'btn-syncing');
  btn.textContent = btnLabel;
}

async function deleteDoc(id) {
  const d = docs.find(x => x.id === id);
  if (!d) return;
  if (!await confirmDialog(`Delete “${d.title}”? The file is removed for everyone.`, { danger: true })) return;
  try {
    await api(`/documents/${id}`, { method: 'DELETE' });
    toast('Document deleted.');
    await load();
  } catch (e) { toast(e.message, true); }
}

// ---- Permissions (admin only) ----
const levelSelect = (id, value, allowInherit) => `
  <select id="${id}" style="min-width:150px;">
    ${allowInherit ? `<option value=""${!value ? ' selected' : ''}>— inherit —</option>` : ''}
    <option value="none"${value === 'none' ? ' selected' : ''}>No access</option>
    <option value="view"${value === 'view' ? ' selected' : ''}>View only</option>
    <option value="download"${value === 'download' ? ' selected' : ''}>View &amp; download</option>
  </select>`;

async function openPerms(id) {
  permDoc = docs.find(d => d.id === id);
  if (!permDoc) return;
  if (!usersList) {
    usersList = (await api('/auth/users').catch(() => []))
      .filter(u => !['admin', 'localadmin'].includes(u.role));
  }
  const acc = permDoc.access || { everyone: 'view', roles: {}, users: {} };
  document.getElementById('permDocName').textContent = permDoc.title;
  document.getElementById('permEveryone').value = acc.everyone || 'view';
  document.getElementById('permRoles').innerHTML = OVERRIDE_ROLES.map(([role, label]) => `
    <div class="field-row" style="align-items:center; margin-bottom:6px;">
      <div style="flex:1;">${esc(label)}</div>
      ${levelSelect(`permRole-${role}`, (acc.roles || {})[role], true)}
    </div>`).join('');
  document.getElementById('permUsers').innerHTML = usersList.length ? usersList.map(u => `
    <div class="field-row" style="align-items:center; margin-bottom:6px;">
      <div style="flex:1;">${esc(u.name)} <span class="sub">(${esc(roleLabel(u.role))})</span></div>
      ${levelSelect(`permUser-${u.id}`, (acc.users || {})[String(u.id)], true)}
    </div>`).join('') : '<p class="sub">No non-admin accounts yet.</p>';
  document.getElementById('permOverlay').style.display = 'flex';
}

async function savePerms() {
  if (!permDoc) return;
  const access = { everyone: document.getElementById('permEveryone').value, roles: {}, users: {} };
  OVERRIDE_ROLES.forEach(([role]) => {
    const v = document.getElementById(`permRole-${role}`).value;
    if (v) access.roles[role] = v;
  });
  (usersList || []).forEach(u => {
    const el = document.getElementById(`permUser-${u.id}`);
    if (el && el.value) access.users[String(u.id)] = el.value;
  });
  const btn = document.getElementById('permSaveBtn');
  btn.disabled = true;
  try {
    await api(`/documents/${permDoc.id}/access`, { method: 'PUT', body: { access } });
    toast('Access updated.');
    document.getElementById('permOverlay').style.display = 'none';
    await load();
  } catch (e) { toast(e.message, true); }
  btn.disabled = false;
}

// ---- Categories (admin only) ----
function renderCatList() {
  document.getElementById('catList').innerHTML = categories.map(c => `
    <div class="field-row" style="align-items:center; margin-bottom:6px;">
      <div style="flex:1;">${esc(c.name)}</div>
      <button type="button" class="btn btn-secondary btn-sm" onclick="renameCategory(${c.id}, '${esc(c.name).replace(/'/g, "\\'")}')">Rename</button>
      <button type="button" class="btn btn-danger btn-sm" onclick="deleteCategory(${c.id})">Delete</button>
    </div>`).join('');
}
// Rename a category — documents filed under it are moved automatically.
async function renameCategory(id, current) {
  const name = prompt('Category name:', current);
  if (name === null || !name.trim() || name.trim() === current) return;
  try {
    const r = await api(`/documents/categories/${id}`, { method: 'PUT', body: { name: name.trim() } });
    categories = await api('/documents/categories');
    renderCatList();
    if (typeof load === 'function') load();
    toast(r.movedDocuments ? `Renamed — ${r.movedDocuments} document(s) moved.` : 'Category renamed.');
  } catch (e) { toast(e.message, true); }
}

async function deleteCategory(id) {
  try {
    await api(`/documents/categories/${id}`, { method: 'DELETE' });
    categories = await api('/documents/categories');
    renderCatList(); load();
  } catch (e) { toast(e.message, true); }
}
async function addCategory(e) {
  e.preventDefault();
  const name = document.getElementById('catName').value.trim();
  if (!name) return;
  try {
    await api('/documents/categories', { method: 'POST', body: { name } });
    document.getElementById('catName').value = '';
    categories = await api('/documents/categories');
    renderCatList(); load();
  } catch (err) { toast(err.message, true); }
}

// ---- Init ----
requireAuthAndRenderShell('/documents.html').then(u => {
  if (!u) return;
  me = u;
  document.getElementById('uploadBtn').addEventListener('click', openUpload);
  document.getElementById('docCancelBtn').addEventListener('click', () => { document.getElementById('docOverlay').style.display = 'none'; });
  document.getElementById('docForm').addEventListener('submit', saveDoc);
  document.getElementById('permCancelBtn').addEventListener('click', () => { document.getElementById('permOverlay').style.display = 'none'; });
  document.getElementById('permSaveBtn').addEventListener('click', savePerms);
  document.getElementById('dCategory').addEventListener('change', () => {
    const isNew = document.getElementById('dCategory').value === '__new__';
    document.getElementById('dNewCatField').style.display = isNew ? '' : 'none';
    if (isNew) document.getElementById('dNewCat').focus();
  });
  document.getElementById('searchInput').addEventListener('input', render);
  document.getElementById('catFilter').addEventListener('change', render);
  document.getElementById('catBtn').addEventListener('click', () => { renderCatList(); document.getElementById('catOverlay').style.display = 'flex'; });
  document.getElementById('catCloseBtn').addEventListener('click', () => { document.getElementById('catOverlay').style.display = 'none'; });
  document.getElementById('catForm').addEventListener('submit', addCategory);
  document.getElementById('pdfViewerClose').addEventListener('click', closePdfViewer);
  document.getElementById('detailsCloseBtn').addEventListener('click', closeDetails);
  document.getElementById('detailsOverlay').addEventListener('click', e => {
    if (e.target.id === 'detailsOverlay') closeDetails();
  });
  load().catch(e => toast(e.message, true));
});
