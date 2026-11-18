    document.getElementById('year').textContent = new Date().getFullYear();
    // Live app version from package.json (via /api/version)
    const fmtDay = (s) => { try { return new Date(`${String(s).slice(0, 10)}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return s; } };
    const showVersion = (d) => {
      const running = (window.appRunningVersion && window.appRunningVersion()) || d.version;
      document.querySelectorAll('.appVersion').forEach(el => { el.textContent = running; });
      document.getElementById('runningVersion').textContent = running;
      const sv = document.getElementById('serverVersion');
      sv.textContent = d.version + (d.version !== running ? ' — newer, reload to use it' : '');
      document.getElementById('releasedOn').textContent = d.released ? fmtDay(d.released) : '—';
      document.getElementById('startedAt').textContent = d.started ? new Date(d.started).toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
      const box = document.getElementById('changes');
      box.textContent = '';
      // The last three releases are shown in full (the one you are running is
      // marked); everything older sits under one fold — click it to see the
      // list, then click a release to read it (Nov 2026).
      const list = d.changes || [];
      const firstLine = (t) => { const m = String(t).match(/^[^.:—]{0,90}[.:—]?/); return (m ? m[0] : String(t).slice(0, 90)).replace(/[.:—]$/, ''); };
      const recent = list.slice(0, 3);
      recent.forEach(([v, t]) => {
        const mine = v === running;
        const cur = document.createElement('div');
        cur.style.cssText = `padding:10px 12px;margin:0 0 10px;border:1px solid var(--rule);border-left:4px solid ${mine ? 'var(--primary-light)' : 'var(--rule)'};border-radius:8px;color:var(--ink);line-height:1.5;`;
        const h = document.createElement('div'); h.style.cssText = 'font-weight:700;margin-bottom:4px;';
        h.textContent = `What’s new in ${v}${mine ? ' — the version you are using' : ''}`;
        const txt = document.createElement('div'); txt.textContent = t;
        cur.append(h, txt); box.append(cur);
      });
      const older = list.slice(3);
      if (older.length) {
        const all = document.createElement('details'); all.id = 'olderReleases';
        all.style.cssText = 'margin-top:4px;color:var(--ink);';
        const allSum = document.createElement('summary'); allSum.style.cssText = 'cursor:pointer;font-weight:600;padding:6px 0;';
        allSum.textContent = `Earlier releases (${older.length}) — click to show`;
        all.append(allSum);
        older.forEach(([v, t]) => {
          const det = document.createElement('details');
          det.style.cssText = 'border-bottom:1px solid var(--rule);padding:6px 0;color:var(--ink);';
          const sum = document.createElement('summary'); sum.style.cssText = 'cursor:pointer;line-height:1.45;';
          const tag = document.createElement('span'); tag.className = 'mono'; tag.style.cssText = 'font-weight:600;margin-right:10px;'; tag.textContent = v;
          const lead = document.createElement('span'); lead.className = 'sub'; lead.textContent = firstLine(t);
          sum.append(tag, lead);
          const body = document.createElement('div'); body.style.cssText = 'padding:6px 0 4px 66px;line-height:1.5;'; body.textContent = t;
          det.append(sum, body); all.append(det);
        });
        box.append(all);
      }
      if (!list.length) box.textContent = 'No notes for this version.';
    };
    fetch('/api/version', { cache: 'no-store' }).then(r => r.json()).then(showVersion)
      .catch(() => { /* non-fatal — placeholders stay as em dashes */ });
    document.getElementById('checkUpdates').addEventListener('click', async (e) => {
      const b = e.currentTarget; b.disabled = true; b.textContent = 'Checking…';
      const r = window.appCheckForUpdates ? await window.appCheckForUpdates() : null;
      b.disabled = false; b.textContent = 'Check for updates';
      if (r && !r.newer && typeof toast === 'function') toast(`AOTC Track ${r.running} is the newest version.`);
      fetch('/api/version', { cache: 'no-store' }).then(x => x.json()).then(showVersion).catch(() => {});
    });
    (async () => {
      const currentUser = await requireAuthAndRenderShell('/about.html');
      if (!currentUser) return;
      try {
        const settings = await api('/settings');
        document.getElementById('supportEmail').textContent = settings.email || '—';
      } catch (e) { /* non-fatal — page still works without it */ }
    })();
