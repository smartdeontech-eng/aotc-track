// ShareHub offline page — no network, no login: everything here is already
// stored on THIS device (IndexedDB) by its owner. PDFs open in the built-in
// viewer (cached by the service worker); other types open via the browser.
function esc(v) {
  return String(v === null || v === undefined ? '' : v)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

let pdfjsReady = null;
function loadPdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  if (pdfjsReady) return pdfjsReady;
  pdfjsReady = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/js/vendor/pdfjs/pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/js/vendor/pdfjs/pdf.worker.min.js'; resolve(); };
    s.onerror = () => reject(new Error('The PDF viewer is not available offline on this device yet.'));
    document.head.appendChild(s);
  });
  return pdfjsReady;
}

async function openPdf(title, bytes) {
  const viewer = document.getElementById('pdfViewer');
  const pagesEl = document.getElementById('pdfViewerPages');
  document.getElementById('pdfViewerTitle').textContent = title;
  pagesEl.innerHTML = '<div class="pdfviewer-status">Opening document…</div>';
  viewer.style.display = 'flex';
  try {
    await loadPdfJs();
    const pdf = await window.pdfjsLib.getDocument({ data: bytes }).promise;
    pagesEl.innerHTML = '';
    const maxWidth = Math.min(pagesEl.clientWidth - 24, 900);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: (maxWidth / base.width) * dpr });
      const canvas = document.createElement('canvas');
      canvas.width = vp.width; canvas.height = vp.height;
      canvas.style.width = (vp.width / dpr) + 'px';
      pagesEl.appendChild(canvas);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
    }
  } catch (e) {
    pagesEl.innerHTML = `<div class="pdfviewer-status">${esc(e.message)}</div>`;
  }
}

async function openSaved(id) {
  const rec = await shOffline.get(id);
  if (!rec) return;
  if (rec.mimetype === 'application/pdf') {
    return openPdf(rec.title, new Uint8Array(await rec.blob.arrayBuffer()));
  }
  await shSaveFile(rec.blob, rec.originalName || rec.title, rec.mimetype, rec.title);
}

async function init() {
  document.getElementById('pdfViewerClose').addEventListener('click', () => {
    document.getElementById('pdfViewer').style.display = 'none';
    document.getElementById('pdfViewerPages').innerHTML = '';
  });
  let saved = [];
  try { saved = await shOffline.list(); } catch (e) { /* no storage */ }
  saved.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
  document.getElementById('rows').innerHTML = saved.length ? saved.map(s => `
    <tr>
      <td><strong>${esc(s.title)}</strong><div class="sub mono" style="font-size:11px;">${esc(s.originalName || '')}</div></td>
      <td>${esc(s.category || '')}</td>
      <td>${s.savedAt ? fmtDate(s.savedAt) : '—'}</td>
      <td><button class="btn btn-secondary btn-sm" onclick="openSaved(${s.id})">Open</button></td>
    </tr>`).join('')
    : '<tr><td colspan="4" style="text-align:center; padding:28px;" class="sub">No documents saved on this device. When online, use the pin button in ShareHub to keep documents here.</td></tr>';
}
init();
