// ShareHub offline store — keeps chosen documents on the device (IndexedDB)
// so they open with no network. Shared by documents.html (save/sync) and
// offline-docs.html (the no-network fallback page).
// Only users with DOWNLOAD rights can save a copy; that rule is enforced
// server-side too (the fetch itself needs download level).
(function () {
  const DB_NAME = 'sharehub-offline';
  const STORE = 'docs';

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Offline storage unavailable.'));
    });
  }
  function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }

  // Save a file to the device WITHOUT navigating away.
  // iOS (especially an installed PWA) has no real download manager: pointing
  // at a blob replaces the app with a full-screen preview that has no back
  // button. The Web Share sheet floats OVER the app instead — "Save to Files",
  // "Open in Word", etc. — and returns you to ShareHub when dismissed.
  // Desktop/Android keep the normal <a download> path.
  window.shSaveFile = async function (blob, filename, mimetype, title) {
    try {
      const file = new File([blob], filename, { type: mimetype || blob.type || 'application/octet-stream' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: title || filename });
        return 'shared';
      }
    } catch (e) {
      // User dismissed the sheet — that's not an error, and not a reason to
      // fall through to a navigation that would strand them.
      if (e && (e.name === 'AbortError' || e.name === 'NotAllowedError')) return 'cancelled';
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return 'downloaded';
  };

  window.shOffline = {
    // meta: {id,title,category,mimetype,size,updatedAt,originalName} + blob
    async save(meta, blob) {
      const db = await openDb();
      await tx(db, 'readwrite', s => s.put({ ...meta, blob, savedAt: new Date().toISOString() }));
      db.close();
    },
    async get(id) {
      const db = await openDb();
      const rec = await new Promise((res, rej) => {
        const r = db.transaction(STORE).objectStore(STORE).get(Number(id));
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => rej(r.error);
      });
      db.close();
      return rec;
    },
    async list() {
      const db = await openDb();
      const all = await new Promise((res, rej) => {
        const r = db.transaction(STORE).objectStore(STORE).getAll();
        r.onsuccess = () => res(r.result || []);
        r.onerror = () => rej(r.error);
      });
      db.close();
      return all;
    },
    async remove(id) {
      const db = await openDb();
      await tx(db, 'readwrite', s => s.delete(Number(id)));
      db.close();
    },
  };
})();
