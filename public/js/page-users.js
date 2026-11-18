    let currentUser;
    let users = [];
    let PERMISSIONS = {};
    let ROLE_DEFAULTS = {};
    let SENSITIVE = [];
    let SESSION_ROLES = {}; // Session office presets (from /auth/permissions)
    let editingUserId = null;
    let resettingUserId = null;
    // Committee/group lists (for resolving workspace entity names) + workspace-modal state.
    let COMS = [], GRPS = [];
    let wsPrimaryId = null, wsEditingId = null;

    // Permissions grouped so a right can actually be found. Choosing a role
    // pre-ticks its defaults; every box stays individually selectable, so the
    // three fundraising levels (enter / verify / approve) can be handed out in
    // any combination regardless of the role chosen.
    // Oct 2026: 'setup.manage' ("Manage years, goals, KPIs, committees,
    // groups and codes") was split into the separate rights under
    // "Church set-up", "Planning & Reporting" and "Rosters". Every key the
    // server declares must appear here, or nobody can be given it — the
    // 'Other' bucket below is the safety net, not the plan.
    const PERM_GROUPS = [
      ['Planning & Reporting', ['planning.manage', 'entry.manage', 'reports.generate', 'goals.manage']],
      ['Attendance & Meetings', ['attendance.manage', 'attendance.main', 'attendance.jy', 'attendance.cs', 'meetings.manage']],
      ['Rosters', ['roster.propose', 'roster.manage', 'members.photos']],
      ['Fundraising & Finance', ['fundraising.manage', 'fundraising.verify', 'fundraising.approve', 'finance.quarterly', 'finance.weekly', 'finance.weekly.confirm', 'finance.weekly.lines']],
      ['Ministry', ['visitors.manage', 'counselling.manage']],
      ['Session & Correspondence', ['correspondence.intake', 'approvals.manage', 'diary.manage']],
      ['ShareHub', ['docs.upload']],
      ['Church set-up', ['setup.structure', 'setup.years', 'setup.venues']],
      ['Administration & Oversight', ['staff.manage', 'users.request', 'congregation.view', 'congregation.manage']],
    ];
    const iAmAdminTier = () => currentUser && ['admin', 'localadmin'].includes(currentUser.role);
    // Same person = the same login or one of its linked workspaces.
    function isSelf(u) {
      if (!u || !currentUser) return false;
      const root = x => Number(x.linkedTo || x.id);
      const me = users.find(x => x.id === currentUser.id) || currentUser;
      return root(u) === root(me);
    }
    // How an account differs from its role's defaults — the thing that was
    // invisible when 30 secretaries quietly carried a right no role gives.
    function roleDiff(u) {
      if (!u || ['admin', 'localadmin'].includes(u.role)) return { add: [], rem: [] };
      const d = ROLE_DEFAULTS[u.role] || [], p = u.permissions || [];
      return { add: p.filter(x => !d.includes(x)), rem: d.filter(x => !p.includes(x)) };
    }
    function diffBadge(u) {
      const { add, rem } = roleDiff(u);
      if (!add.length && !rem.length) return '';
      const tip = [...add.map(x => '+ ' + (PERMISSIONS[x] || x)), ...rem.map(x => '\u2212 ' + (PERMISSIONS[x] || x))].join('\n');
      return ` <span class="badge badge-progress" style="white-space:nowrap; cursor:help;" title="Differs from the ${esc(roleLabel(u.role))} defaults:\n${esc(tip)}">${add.length ? '+' + add.length : ''}${add.length && rem.length ? ' ' : ''}${rem.length ? '\u2212' + rem.length : ''} vs role</span>`;
    }
    // opts.locked: the whole list is read-only (your own account).
    // Sensitive rights are marked, and locked for anyone below the admin tier.
    function permChecklistHtml(selected, idPrefix, opts = {}) {
      const grouped = new Set(PERM_GROUPS.flatMap(g => g[1]));
      const leftovers = Object.keys(PERMISSIONS).filter(k => !grouped.has(k));
      const groups = leftovers.length ? [...PERM_GROUPS, ['Other', leftovers]] : PERM_GROUPS;
      const box = (key) => {
        if (PERMISSIONS[key] === undefined) return '';
        const sens = SENSITIVE.includes(key);
        const lock = opts.locked || (sens && !iAmAdminTier());
        return `
        <label style="display:flex; align-items:flex-start; gap:8px; font-weight:400; color:var(--ink); margin:0 0 6px 4px;${lock ? ' opacity:.65;' : ''}" ${lock && sens && !opts.locked ? 'title="Only an administrator can grant or remove this."' : ''}>
          <input type="checkbox" data-perm="${key}" id="${idPrefix}-${key}" style="width:auto; margin-top:3px;" ${selected.includes(key) ? 'checked' : ''} ${lock ? 'disabled' : ''}>
          <span>${PERMISSIONS[key]}${sens ? ' <span class="badge badge-attention" style="font-size:10px; padding:1px 6px;">sensitive</span>' : ''}</span>
        </label>`;
      };
      const lockNote = opts.locked ? `<p class="sub" style="margin:0 0 8px;">${opts.lockNote || 'This is your own account \u2014 an administrator has to change its permissions.'}</p>` : '';
      return lockNote + groups.map(([title, keys]) => {
        const boxes = keys.map(box).join('');
        if (!boxes) return '';
        return `<div style="margin-bottom:10px;">
          <div class="sub" style="text-transform:uppercase; letter-spacing:.04em; font-size:11px; font-weight:600; margin-bottom:4px;">${title}</div>
          ${boxes}
        </div>`;
      }).join('');
    }

    function readChecklist(containerId) {
      return [...document.querySelectorAll(`#${containerId} input[data-perm]`)]
        .filter(cb => cb.checked).map(cb => cb.dataset.perm);
    }

    // ---- "The Session" entity: swap the access-level dropdown for Session
    // office presets, and preview the permissions each preset grants. Mirrors
    // the server's resolveSessionPreset so the admin sees exactly what applies.
    function sessionPresetOptions() {
      return Object.entries(SESSION_ROLES).map(([id, p]) => `<option value="${id}">${esc(p.label)}</option>`).join('');
    }
    function clientResolveSessionPerms(presetId) {
      const p = SESSION_ROLES[presetId];
      if (!p) return [];
      const base = Array.isArray(p.permissions) ? p.permissions : (ROLE_DEFAULTS[p.role] || []);
      return [...new Set([...base, ...(p.add || [])])].filter(x => x !== 'staff.manage');
    }
    function renderPermsFor(roleSel, containerId, boxPrefix) {
      const el = document.getElementById(containerId);
      if (!el) return;
      if (roleSel.dataset.mode === 'session') {
        el.innerHTML = permChecklistHtml(clientResolveSessionPerms(roleSel.value), boxPrefix,
          { locked: true, lockNote: 'These follow the chosen Session role and are granted automatically.' });
      } else {
        el.innerHTML = permChecklistHtml(ROLE_DEFAULTS[roleSel.value] || [], boxPrefix);
      }
    }
    // Put a role <select> into Session-preset mode (presetsAllowed && entity is
    // the Session) or back to the normal account roles, then refresh its perms.
    function configureEntityRole(entitySel, roleSelId, containerId, boxPrefix, presetsAllowed) {
      const roleSel = document.getElementById(roleSelId);
      if (!roleSel) return;
      if (roleSel.dataset.acctOptions === undefined) roleSel.dataset.acctOptions = roleSel.innerHTML;
      const isSession = !!(entitySel && entitySel.value === 'session:0' && presetsAllowed);
      if (isSession && roleSel.dataset.mode !== 'session') {
        roleSel.innerHTML = sessionPresetOptions(); roleSel.dataset.mode = 'session';
      } else if (!isSession && roleSel.dataset.mode === 'session') {
        roleSel.innerHTML = roleSel.dataset.acctOptions; roleSel.dataset.mode = '';
      }
      renderPermsFor(roleSel, containerId, boxPrefix);
    }

    async function load() {
      [users, { permissions: PERMISSIONS, roleDefaults: ROLE_DEFAULTS, sensitive: SENSITIVE = [], sessionRoles: SESSION_ROLES = {} }, COMS, GRPS] = await Promise.all([
        api('/auth/users'), api('/auth/permissions'),
        api('/setup/committees').catch(() => []), api('/setup/groups').catch(() => []),
      ]);
      const opts = ['<option value="">None (congregation-wide)</option>',
        '<option value="session:0">The Session (court)</option>']
        .concat(COMS.map(c => `<option value="committee:${c.id}">Committee — ${esc(c.name)}</option>`))
        .concat(GRPS.map(g => `<option value="group:${g.id}">Group — ${esc(g.name)}</option>`)).join('');
      document.querySelectorAll('.entitySelect').forEach(sel => sel.innerHTML = opts);
      fillRoleFilter();
      render();
      renderWho();
      loadLogs();
      loadBackups();
    }

    function formatBytes(n) {
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
      return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    async function loadBackups() {
      const backups = await api('/backups');
      document.getElementById('backupRows').innerHTML = backups.length ? backups.map(b => `
        <div class="urow">
          <div class="grow"><b>${esc(new Date(b.createdAt).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }))}</b>
            <div class="sub mono" style="font-size:11.5px;">${esc(b.name)} \u00b7 ${formatBytes(b.sizeBytes)}</div></div>
          <a class="btn btn-secondary btn-sm" href="/api/backups/${esc(b.name)}/download" download>Download ZIP</a>
        </div>`).join('') : `<p class="sub">No backups yet — the first automatic backup runs shortly after the app starts.</p>`;
    }

    document.getElementById('backupNowBtn').addEventListener('click', async () => {
      try {
        await api('/backups/run', { method: 'POST' });
        toast('Backup created.');
        loadBackups();
      } catch (e) { toast(e.message, true); }
    });

    // Login activity: one line per sign-in attempt, searchable (Oct 2026).
    let LOGS = [];
    const REASON = { 'incorrect-credentials': 'Wrong password', 'locked-out': 'Locked out', 'awaiting-2fa': 'Waiting for 2FA code',
      'must-change-password': 'Had to change password', 'account-disabled': 'Account switched off', 'passkey-unknown': 'Unknown passkey' };
    // "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 …) … Safari" → "iPhone · Safari"
    function deviceOf(ua) {
      const u = String(ua || '');
      if (!u) return '';
      const os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Mac OS X|Macintosh/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : '';
      const br = /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox' : /CriOS|Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : '';
      return [os, br].filter(Boolean).join(' \u00b7 ') || u.slice(0, 40);
    }
    async function loadLogs() {
      LOGS = await api('/auth/login-logs');
      renderLogs();
    }
    function renderLogs() {
      const q = ((document.getElementById('logSearch') || {}).value || '').trim().toLowerCase();
      const res = (document.getElementById('logResult') || {}).value || '';
      const list = LOGS.filter(l => {
        if (res === 'ok' && !l.success) return false;
        if (res === 'fail' && l.success) return false;
        if (q && !`${l.email || ''} ${l.ip || ''} ${deviceOf(l.userAgent)} ${l.userAgent || ''} ${REASON[l.reason] || l.reason || ''}`.toLowerCase().includes(q)) return false;
        return true;
      });
      const c = document.getElementById('logCount');
      if (c) c.textContent = list.length === LOGS.length ? `${LOGS.length} recent sign-ins` : `Showing ${list.length} of ${LOGS.length}`;
      document.getElementById('logRows').innerHTML = list.length ? list.map(l => `
        <div class="urow">
          <span class="badge ${l.success ? 'badge-info' : 'badge-critical'}">${l.success ? 'Signed in' : esc(REASON[l.reason] || l.reason || 'Failed')}</span>
          <div class="grow"><b>${esc(l.email) || '\u2014'}</b>
            <div class="sub" style="font-size:11.5px;">${esc(new Date(l.createdAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}
              ${deviceOf(l.userAgent) ? ` \u00b7 <span title="${esc(l.userAgent)}">${esc(deviceOf(l.userAgent))}</span>` : ''}
              ${l.ip ? ` \u00b7 <span class="mono">${esc(l.ip)}</span>` : ''}</div></div>
        </div>`).join('') : `<p class="sub">${LOGS.length ? 'Nothing matches that search.' : 'No login activity recorded yet.'}</p>`;
    }
    (function wireLogFilters() {
      const s = document.getElementById('logSearch'), r = document.getElementById('logResult');
      let t = null;
      if (s) s.addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderLogs, 120); });
      if (r) r.addEventListener('change', renderLogs);
    })();

    // ---- The four views: Accounts / Who can do what / Backups / Login activity
    function showUserTab(name) {
      document.querySelectorAll('.utab').forEach(b => { const on = b.dataset.utab === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); });
      document.querySelectorAll('.upane').forEach(p => { p.hidden = p.dataset.upane !== name; });
      document.getElementById('addBtn').style.display = name === 'accounts' ? '' : 'none';
      try { sessionStorage.setItem('usersTab', name); } catch (e) {}
      if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    }
    document.querySelectorAll('.utab').forEach(b => b.addEventListener('click', () => showUserTab(b.dataset.utab)));
    (function () {
      let first = (location.hash || '').slice(1);
      if (!document.querySelector(`.upane[data-upane="${first}"]`)) { try { first = sessionStorage.getItem('usersTab') || 'accounts'; } catch (e) { first = 'accounts'; } }
      if (!document.querySelector(`.upane[data-upane="${first}"]`)) first = 'accounts';
      showUserTab(first);
    })();

    const WS_ADMIN_TIER = ['admin', 'localadmin'];
    function isAdminTier(u) { return WS_ADMIN_TIER.includes(u.role); }
    function roleShort(r) {
      return ({ secretary: 'Secretary', coordinator: 'Coordinator', attendance: 'Attendance', treasurer: 'Treasurer', accounts: 'Accounts Clerk', clerk: 'Clerk', minister: 'Minister', viewer: 'Viewer', admin: 'Admin', localadmin: 'Local Admin' })[r] || r;
    }
    function entityLabel(ent) {
      if (!ent || ent.type === 'congregation') return 'Congregation-wide';
      if (ent.type === 'session') return 'The Session';
      const rec = (ent.type === 'committee' ? COMS : GRPS).find(x => x.id === Number(ent.id));
      return rec ? rec.name : `${ent.type === 'committee' ? 'Committee' : 'Group'} #${ent.id}`;
    }

    function render() {
      // One row per PERSON. Linked "workspace" accounts (linkedTo set) never get
      // their own top-level row — they appear as chips under their primary.
      const primaries = users.filter(u => !u.linkedTo);
      const secsByPrimary = {};
      users.filter(u => u.linkedTo).forEach(s => {
        (secsByPrimary[s.linkedTo] = secsByPrimary[s.linkedTo] || []).push(s);
      });

      // ---- search and filters -------------------------------------------
      // A person matches if the words appear anywhere in their login OR any of
      // their workspaces: name, email, phone, position, access level, or the
      // committee/group the account works in.
      const q = (document.getElementById('uSearch') || {}).value || '';
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const roleF = (document.getElementById('uRole') || {}).value || '';
      const statF = (document.getElementById('uStatus') || {}).value || '';
      const hay = acc => [acc.name, acc.email, acc.phone, acc.position, roleLabel(acc.role), roleShort(acc.role), entityLabel(acc.entity)].join(' ').toLowerCase();
      const shown = primaries.filter(u => {
        const all = [u, ...(secsByPrimary[u.id] || [])];
        if (words.length) { const h = all.map(hay).join(' '); if (!words.every(w => h.includes(w))) return false; }
        if (roleF && !all.some(a => a.role === roleF)) return false;
        if (statF === 'on' && u.disabled) return false;
        if (statF === 'off' && !all.some(a => a.disabled)) return false;
        if (statF === 'diff' && !all.some(a => { const d = roleDiff(a); return d.add.length || d.rem.length; })) return false;
        if (statF === 'no2fa' && u.twoFactorEnabled) return false;
        return true;
      });
      const countEl = document.getElementById('uCount');
      if (countEl) countEl.textContent = shown.length === primaries.length ? `${primaries.length} people` : `Showing ${shown.length} of ${primaries.length}`;
      // Highlight what was searched for, inside text that is already escaped.
      const hi = text => {
        let out = esc(text || '');
        words.forEach(w => { const e = esc(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); out = out.replace(new RegExp(`(${e})(?![^<]*>)`, 'gi'), '<mark>$1</mark>'); });
        return out;
      };

      document.getElementById('rows').innerHTML = shown.map(u => {
        const perms = u.permissions || [];
        let permBadges;
        if (u.role === 'admin' || u.role === 'localadmin') {
          permBadges = `<span class="badge badge-done" style="white-space:nowrap;">All (${u.role === 'admin' ? 'Admin' : 'Local Admin'})</span>`;
        } else if (!perms.length) {
          permBadges = '<span class="sub">No permissions</span>';
        } else {
          const fullList = perms.map(p => '• ' + (PERMISSIONS[p] || p)).join('\n');
          permBadges = `<span class="badge badge-done" style="white-space:nowrap; cursor:help;" title="${esc(fullList)}">${perms.length} permission${perms.length === 1 ? '' : 's'}</span>`;
        }
        permBadges += diffBadge(u);
        const actions = u.id === currentUser.id ? '<span class="sub">You</span>' : u.role === 'admin' ? `
              <span class="sub" title="Admin accounts can only edit their own name/email/phone, from My Account.">Self-managed</span>
              <button class="btn btn-secondary btn-sm" onclick="openReset(${u.id})">Reset password</button>
              <button class="btn btn-danger btn-sm" onclick="del(${u.id})">Delete</button>` : `
              <button class="btn btn-secondary btn-sm" onclick="openEdit(${u.id})">Edit</button>
              <button class="btn btn-secondary btn-sm" onclick="openReset(${u.id})">Reset password</button>
              <button class="btn btn-danger btn-sm" onclick="del(${u.id})">Delete</button>`;
        const sep = '<span class="sep">\u00b7</span>';
        const meta = [
          u.position ? `<span>${hi(u.position)}</span>` : '',
          `<span class="role-tag">${hi(roleLabel(u.role))}</span>`,
          permBadges,
          u.twoFactorEnabled ? '<span class="badge badge-done" title="Two-factor sign-in is on">2FA on</span>' : '<span class="badge badge-idle" title="Two-factor sign-in is off">2FA off</span>',
        ].filter(Boolean).join(sep);
        const contact = [
          u.email ? `<a href="mailto:${esc(u.email)}">${hi(u.email)}</a>` : '',
          u.phone ? `<a href="tel:${esc(u.phone)}" class="mono">${hi(u.phone)}</a>` : '<span class="sub">no phone</span>',
        ].filter(Boolean).join(sep);

        // Workspaces: the committees/groups this person can switch between
        // under this one login. Admins already see every entity.
        let ws = '';
        if (!isAdminTier(u)) {
          const secs = secsByPrimary[u.id] || [];
          // The first chip is the person's LOGIN, not a detachable workspace: its
          // committee, role and permissions live on the account record itself.
          const primChip = `<span class="ws-chip" title="This is the login itself — its committee, role and permissions are part of the account. Edit them here; to remove the person entirely use Delete.">`
            + `<span>${hi(entityLabel(u.entity))}</span><span class="ws-chip-role">${esc(roleShort(u.role))}</span><span class="ws-chip-tag">login</span>`
            + `<button class="ws-chip-btn" title="Edit this login — committee, role and permissions" onclick="openEdit(${u.id})">✎</button></span>`;
          const secChips = secs.map(s =>
            `<span class="ws-chip${s.disabled ? ' off' : ''}" ${s.disabled ? `title="${esc(offTip(s))}"` : ''}><span>${hi(entityLabel(s.entity))}</span><span class="ws-chip-role">${esc(roleShort(s.role))}</span>${diffBadge(s)}`
            + `<button class="ws-chip-btn" title="${s.disabled ? 'Switch this workspace back on' : 'Switch just this workspace off'}" onclick="toggleAccount(${s.id}, ${!s.disabled})">⏻</button>`
            + `<button class="ws-chip-btn" title="Edit this workspace" onclick="openEditWorkspace(${s.id})">✎</button>`
            + `<button class="ws-chip-btn danger" title="Remove this workspace" onclick="removeWorkspace(${s.id})">✕</button></span>`
          ).join('');
          const NEEDS_ENTITY = ['secretary', 'attendance'];
          const hint = (u.entity || secs.length || !NEEDS_ENTITY.includes(u.role))
            ? '' : '<span class="sub" style="font-size:11.5px;">No committee/group yet — attach one so this person can work in it.</span>';
          ws = `<div class="ws-row"><span class="ws-row-label">Workspaces</span>${primChip}${secChips}${hint}
                <button class="btn btn-secondary btn-sm" onclick="openAddWorkspace(${u.id})">+ Add committee/group</button></div>`;
        }
        return `
        <div class="ucard ${u.disabled ? 'acct-off' : ''}" data-user="${u.id}">
          <div class="ucard-top">
            <div class="ucard-name">${switchHtml(u)}<span>${hi(u.name)}</span>${u.disabled ? ` <span class="badge badge-critical" title="${esc(offTip(u))}">Switched off</span>` : ''}</div>
            <div class="ucard-actions">${actions}</div>
          </div>
          <div class="ucard-meta">${meta}</div>
          <div class="ucard-meta">${contact}</div>
          ${ws}
        </div>`;
      }).join('') || `<p class="sub" style="padding:12px 0;">${words.length || roleF || statF ? 'No one matches that search.' : 'No accounts yet.'}</p>`;
    }
    // Filters redraw as you type; the access-level list is filled from the
    // roles actually in use.
    (function wireUserFilters() {
      const s = document.getElementById('uSearch'), r = document.getElementById('uRole'), st = document.getElementById('uStatus');
      let t = null;
      if (s) s.addEventListener('input', () => { clearTimeout(t); t = setTimeout(render, 120); });
      if (r) r.addEventListener('change', render);
      if (st) st.addEventListener('change', render);
    })();
    function fillRoleFilter() {
      const r = document.getElementById('uRole');
      if (!r) return;
      const keep = r.value;
      const roles = [...new Set(users.map(u => u.role))].sort((a, b) => roleLabel(a).localeCompare(roleLabel(b)));
      r.innerHTML = '<option value="">All access levels</option>' + roles.map(x => `<option value="${esc(x)}">${esc(roleLabel(x))}</option>`).join('');
      if (roles.includes(keep)) r.value = keep;
    }

    // ---- Switch an account on / off --------------------------------------
    // Off keeps everything the person recorded; they just can't sign in and
    // stop receiving notifications. A login's switch covers its workspaces.
    function offTip(u) {
      return `Switched off${u.disabledBy ? ' by ' + u.disabledBy : ''}${u.disabledAt ? ' on ' + new Date(u.disabledAt).toLocaleDateString('en-GB') : ''}${u.disabledReason ? ' \u2014 ' + u.disabledReason : ''}`;
    }
    function switchHtml(u) {
      const self = isSelf(u);
      const adminLocked = ['admin', 'localadmin'].includes(u.role) && currentUser.role !== 'admin';
      const lock = self || adminLocked;
      const title = self ? 'You cannot switch your own account off' : adminLocked ? 'Only an administrator can switch an admin account' : u.disabled ? `${offTip(u)}. Click to switch back on.` : 'On \u2014 click to switch this account off';
      return `<label class="acct-switch" title="${esc(title)}"><input type="checkbox" aria-label="${esc(u.name)}: account ${u.disabled ? 'off' : 'on'}" ${u.disabled ? '' : 'checked'} ${lock ? 'disabled' : ''} onchange="toggleAccount(${u.id}, this.checked, this)"><span></span></label>`;
    }
    async function toggleAccount(id, enable, box) {
      const u = users.find(x => x.id === id);
      if (!u) return;
      const undo = () => { if (box) box.checked = !enable; };
      let reason = '';
      if (!enable) {
        const scope = u.linkedTo ? 'this workspace' : `${u.name}\u2019s account${(users.some(x => Number(x.linkedTo) === u.id) ? ' and all their workspaces' : '')}`;
        reason = await promptDialog(`Switch off ${scope}? They will be signed out and unable to sign in, and will stop receiving notifications. Nothing they recorded is changed, and you can switch it back on at any time.\n\nReason (kept on the account and in the activity log):`,
          { title: 'Switch account off', okText: 'Switch off', placeholder: 'e.g. Left the committee, on leave until March\u2026' });
        if (reason === null) { undo(); return; }
        if (!String(reason).trim()) { toast('A reason is needed to switch an account off.', true); undo(); return; }
      } else if (!await confirmDialog(`Switch ${u.linkedTo ? 'this workspace' : u.name + '\u2019s account'} back on? They can sign in again straight away.`)) { undo(); return; }
      try {
        await api(`/auth/users/${id}/status`, { method: 'POST', body: { enabled: enable, reason } });
        toast(enable ? 'Account switched on.' : 'Account switched off.');
        load();
      } catch (e) { toast(e.message, true); undo(); }
    }

    async function del(id) {
      if (!await confirmDialog('Delete this account for good? They will no longer be able to log in.\n\nTo stop them signing in but keep the account (and switch it back on later), use the switch beside their name instead.')) return;
      try {
        await api('/auth/users/' + id, { method: 'DELETE' });
        toast('Account removed.');
        load();
      } catch (e) { toast(e.message, true); }
    }

    const addEntitySel = document.getElementById('userForm').querySelector('.entitySelect');
    document.getElementById('addBtn').addEventListener('click', () => {
      document.getElementById('userForm').reset();
      document.getElementById('pwMeter').innerHTML = passwordChecklistHtml('');
      // Sets account-roles-or-Session-presets and the perm preview for the
      // current entity (reset() clears it to "None").
      configureEntityRole(addEntitySel, 'role', 'permChecklist', 'add', true);
      document.getElementById('modalOverlay').style.display = 'flex';
    });
    document.getElementById('cancelBtn').addEventListener('click', () => document.getElementById('modalOverlay').style.display = 'none');

    if (addEntitySel) addEntitySel.addEventListener('change', () =>
      configureEntityRole(addEntitySel, 'role', 'permChecklist', 'add', true));
    document.getElementById('role').addEventListener('change', () =>
      renderPermsFor(document.getElementById('role'), 'permChecklist', 'add'));

    wirePasswordMeter(document.getElementById('password'), document.getElementById('pwMeter'));

    function readEntity(form) {
      const sel = form.querySelector('.entitySelect');
      if (!sel || !sel.value) return null;
      const [type, id] = sel.value.split(':');
      return { type, id: Number(id) };
    }

    document.getElementById('userForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const entity = readEntity(document.getElementById('userForm'));
        const roleVal = document.getElementById('role').value;
        const body = {
          name: document.getElementById('name').value,
          email: document.getElementById('email').value,
          phone: document.getElementById('phone').value,
          position: document.getElementById('position').value,
          password: document.getElementById('password').value,
          role: roleVal,
          permissions: readChecklist('permChecklist'),
          entity,
        };
        // For "The Session", roleVal is a Session office preset id — send it as
        // sessionRole; the server sets the account role, permissions and title.
        if (entity && entity.type === 'session') body.sessionRole = roleVal;
        await api('/auth/users', { method: 'POST', body });
        toast('Account created.');
        document.getElementById('modalOverlay').style.display = 'none';
        load();
      } catch (e) {
        toast(e.message + (e.failedRules ? ' ' + e.failedRules.join(', ') : ''), true);
      }
    });

    function openEdit(id) {
      const u = users.find(x => x.id === id);
      editingUserId = id;
      document.getElementById('editName').value = u.name || '';
      document.getElementById('editEmail').value = u.email || '';
      document.getElementById('editPhone').value = u.phone || '';
      document.getElementById('editPosition').value = u.position || '';
      document.getElementById('editOtpChannel').value = ['email', 'sms'].includes(u.otpChannel) ? u.otpChannel : 'auto';
      document.getElementById('editRole').value = u.role;
      document.getElementById('editPermChecklist').innerHTML = permChecklistHtml(u.permissions || [], 'edit', { locked: isSelf(u) && !iAmAdminTier() });
      showDiffNote('edit', u);
      const editSel = document.getElementById('editForm').querySelector('.entitySelect');
      if (editSel) editSel.value = u.entity && u.entity.type ? `${u.entity.type}:${u.entity.id}` : '';
      document.getElementById('editOverlay').style.display = 'flex';
    }
    document.getElementById('editCancelBtn').addEventListener('click', () => document.getElementById('editOverlay').style.display = 'none');
    document.getElementById('editRole').addEventListener('change', (e) => {
      document.getElementById('editPermChecklist').innerHTML = permChecklistHtml(ROLE_DEFAULTS[e.target.value] || [], 'edit');
      showDiffNote('edit', null);
    });

    // "Differs from role" line + Reset button inside the edit dialogs.
    function showDiffNote(prefix, u) {
      const list = document.getElementById(prefix === 'edit' ? 'editPermChecklist' : 'wsPermChecklist');
      let note = document.getElementById(prefix + 'DiffNote');
      if (!note) {
        note = document.createElement('div');
        note.id = prefix + 'DiffNote';
        note.className = 'sub';
        note.style.cssText = 'margin:0 0 6px; display:flex; gap:8px; align-items:center; flex-wrap:wrap;';
        list.parentNode.insertBefore(note, list);
      }
      const { add, rem } = u ? roleDiff(u) : { add: [], rem: [] };
      if (!u || (!add.length && !rem.length) || (isSelf(u) && !iAmAdminTier())) { note.innerHTML = ''; return; }
      const roleSel = document.getElementById(prefix === 'edit' ? 'editRole' : 'wsRole');
      note.innerHTML = `<span>Differs from the ${esc(roleLabel(u.role))} defaults \u2014 ${add.length ? `<b>extra:</b> ${add.map(x => esc(x)).join(', ')}` : ''}${add.length && rem.length ? '; ' : ''}${rem.length ? `<b>missing:</b> ${rem.map(x => esc(x)).join(', ')}` : ''}</span>
        <button type="button" class="btn btn-secondary btn-sm" id="${prefix}ResetBtn">Reset to role defaults</button>`;
      document.getElementById(prefix + 'ResetBtn').onclick = () => {
        // Keep sensitive boxes as they are for non-admins (they're locked anyway).
        const cur = readChecklist(list.id);
        const want = (ROLE_DEFAULTS[roleSel.value] || []).filter(x => iAmAdminTier() || !SENSITIVE.includes(x));
        const kept = iAmAdminTier() ? [] : cur.filter(x => SENSITIVE.includes(x));
        list.innerHTML = permChecklistHtml([...new Set([...want, ...kept])], prefix);
        note.innerHTML = '<span>Reset to the role\u2019s defaults \u2014 press Save to keep it.</span>';
      };
    }

    // ---- Who can do what ----------------------------------------------------
    // Pick a permission, see every account (logins and workspaces) holding it.
    // Plus, per role, the accounts that are missing one of their role's
    // defaults: changing a role's defaults in code never reached existing
    // accounts, which is how the Treasurer ended up unable to confirm a week.
    function renderWho() {
      const card = document.getElementById('whoCard');
      if (!card) return;
      card.style.display = '';
      const sel = document.getElementById('whoPerm');
      if (!sel.options.length) {
        sel.innerHTML = '<option value="">\u2014 choose a permission \u2014</option>' + PERM_GROUPS.map(([t, keys]) =>
          `<optgroup label="${esc(t)}">${keys.filter(k => PERMISSIONS[k]).map(k => `<option value="${k}">${esc(PERMISSIONS[k])}${SENSITIVE.includes(k) ? ' (sensitive)' : ''}</option>`).join('')}</optgroup>`).join('');
        sel.onchange = renderWho;
      }
      const key = sel.value;
      const out = document.getElementById('whoRows');
      if (!key) { out.innerHTML = ''; }
      else {
        const holders = users.filter(u => ['admin', 'localadmin'].includes(u.role) || (u.permissions || []).includes(key));
        const def = u => (ROLE_DEFAULTS[u.role] || []).includes(key) || ['admin', 'localadmin'].includes(u.role);
        out.innerHTML = holders.length ? `<p class="sub" style="margin:8px 0 4px;">${holders.length} account${holders.length === 1 ? '' : 's'}</p>` +
          '<table><thead><tr><th>Name</th><th>Workspace</th><th>Access level</th><th>Why</th><th></th></tr></thead><tbody>' +
          holders.map(u => `<tr><td>${esc(u.name)}${u.disabled ? ' <span class="badge badge-critical">off</span>' : ''}</td><td>${esc(entityLabel(u.entity))}</td><td>${esc(roleLabel(u.role))}</td>
            <td>${['admin', 'localadmin'].includes(u.role) ? '<span class="sub">admin \u2014 everything</span>' : def(u) ? '<span class="sub">role default</span>' : '<span class="badge badge-progress">added by hand</span>'}</td>
            <td style="text-align:right;">${['admin', 'localadmin'].includes(u.role) ? '' : `<button class="btn btn-secondary btn-sm" onclick="${u.linkedTo ? 'openEditWorkspace' : 'openEdit'}(${u.id})">Edit</button>`}</td></tr>`).join('') +
          '</tbody></table>' : '<p class="sub" style="margin:8px 0;">Nobody holds this (apart from administrators).</p>';
      }
      // Missing role defaults.
      const missing = {};
      users.forEach(u => { const r = roleDiff(u).rem; if (r.length) (missing[u.role] = missing[u.role] || []).push(u); });
      const roles = Object.keys(missing);
      document.getElementById('whoMissing').innerHTML = roles.length ? roles.map(r =>
        `<div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:6px 0;">
          <span>${missing[r].length} ${esc(roleLabel(r))} account${missing[r].length === 1 ? ' is' : 's are'} missing part of the role\u2019s defaults
            <span class="sub">(${[...new Set(missing[r].flatMap(u => roleDiff(u).rem))].map(esc).join(', ')})</span></span>
          ${iAmAdminTier() ? `<button class="btn btn-secondary btn-sm" onclick="applyRoleDefaults('${r}')">Add what\u2019s missing</button>` : ''}
        </div>`).join('') : '<p class="sub" style="margin:6px 0;">Every account has at least its role\u2019s defaults.</p>';
    }
    async function applyRoleDefaults(role) {
      if (!await confirmDialog(`Give every ${roleLabel(role)} account the role\u2019s default permissions it is missing? Nothing is taken away.`)) return;
      try {
        const r = await api(`/auth/roles/${role}/apply-defaults`, { method: 'POST' });
        toast(`${r.changed.length} account${r.changed.length === 1 ? '' : 's'} updated`);
        load();
      } catch (e) { toast(e.message, true); }
    }

    document.getElementById('editForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/auth/users/' + editingUserId, {
          method: 'PUT',
          body: {
            name: document.getElementById('editName').value,
            email: document.getElementById('editEmail').value,
            phone: document.getElementById('editPhone').value,
            position: document.getElementById('editPosition').value,
            otpChannel: document.getElementById('editOtpChannel').value,
            role: document.getElementById('editRole').value,
            permissions: readChecklist('editPermChecklist'),
            entity: readEntity(document.getElementById('editForm')),
          },
        });
        toast('Account updated.');
        document.getElementById('editOverlay').style.display = 'none';
        load();
      } catch (e) { toast(e.message, true); }
    });

    function openReset(id) {
      resettingUserId = id;
      document.getElementById('resetForm').reset();
      document.getElementById('resetPwMeter').innerHTML = passwordChecklistHtml('');
      document.getElementById('resetOverlay').style.display = 'flex';
    }
    document.getElementById('resetCancelBtn').addEventListener('click', () => document.getElementById('resetOverlay').style.display = 'none');
    wirePasswordMeter(document.getElementById('resetPassword'), document.getElementById('resetPwMeter'));

    document.getElementById('resetForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api(`/auth/users/${resettingUserId}/reset-password`, {
          method: 'POST', body: { newPassword: document.getElementById('resetPassword').value },
        });
        toast('Password reset. Share the new password with them securely.');
        document.getElementById('resetOverlay').style.display = 'none';
        load();
      } catch (e) {
        toast(e.message + (e.failedRules ? ' ' + e.failedRules.join(', ') : ''), true);
      }
    });

    // ---- Workspaces: attach / edit / remove a person's extra committees/groups ----
    function openAddWorkspace(primaryId) {
      wsPrimaryId = primaryId; wsEditingId = null;
      document.getElementById('wsTitle').textContent = 'Add workspace';
      document.getElementById('wsForm').reset();
      const sel = document.getElementById('wsForm').querySelector('.entitySelect');
      if (sel) sel.value = '';
      const wsRoleSel = document.getElementById('wsRole');
      configureEntityRole(sel, 'wsRole', 'wsPermChecklist', 'ws', true); // entity "" here -> account roles
      wsRoleSel.value = 'secretary';
      document.getElementById('wsPosition').value = '';
      renderPermsFor(wsRoleSel, 'wsPermChecklist', 'ws');
      document.getElementById('wsOverlay').style.display = 'flex';
    }
    function openEditWorkspace(id) {
      const s = users.find(x => x.id === id);
      if (!s) return;
      wsEditingId = id; wsPrimaryId = s.linkedTo;
      document.getElementById('wsTitle').textContent = 'Edit workspace';
      document.getElementById('wsForm').reset();
      const sel = document.getElementById('wsForm').querySelector('.entitySelect');
      if (sel) sel.value = s.entity && s.entity.type ? `${s.entity.type}:${s.entity.id}` : '';
      const validRoles = ['secretary', 'coordinator', 'attendance', 'treasurer', 'accounts', 'clerk', 'minister', 'viewer'];
      // Editing is a direct assignment (never preset mode), so keep the normal
      // account-role options even for a Session workspace.
      configureEntityRole(sel, 'wsRole', 'wsPermChecklist', 'ws', false);
      document.getElementById('wsRole').value = validRoles.includes(s.role) ? s.role : 'secretary';
      document.getElementById('wsPosition').value = s.position || '';
      document.getElementById('wsPermChecklist').innerHTML = permChecklistHtml(s.permissions || [], 'ws', { locked: isSelf(s) && !iAmAdminTier() });
      showDiffNote('ws', s);
      document.getElementById('wsOverlay').style.display = 'flex';
    }
    async function removeWorkspace(id) {
      if (!await confirmDialog('Remove this workspace? The person can no longer switch into this committee/group. Their other workspaces are unaffected.')) return;
      try {
        await api('/auth/users/' + id, { method: 'DELETE' });
        toast('Workspace removed.');
        load();
      } catch (e) { toast(e.message, true); }
    }

    document.getElementById('wsRole').addEventListener('change', () =>
      renderPermsFor(document.getElementById('wsRole'), 'wsPermChecklist', 'ws'));
    {
      const wsEntitySel = document.getElementById('wsForm').querySelector('.entitySelect');
      if (wsEntitySel) wsEntitySel.addEventListener('change', () =>
        configureEntityRole(wsEntitySel, 'wsRole', 'wsPermChecklist', 'ws', wsEditingId === null));
    }
    document.getElementById('wsCancelBtn').addEventListener('click', () => document.getElementById('wsOverlay').style.display = 'none');
    document.getElementById('wsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const entity = readEntity(document.getElementById('wsForm'));
      if (!entity) { toast('Choose a committee, a group, or the Session for this workspace.', true); return; }
      const body = {
        entity,
        role: document.getElementById('wsRole').value,
        permissions: readChecklist('wsPermChecklist'),
        position: document.getElementById('wsPosition').value,
      };
      try {
        if (wsEditingId) await api('/auth/users/' + wsEditingId, { method: 'PUT', body });
        else await api('/auth/users/' + wsPrimaryId + '/workspaces', { method: 'POST', body });
        toast('Workspace saved.');
        document.getElementById('wsOverlay').style.display = 'none';
        load();
      } catch (err) {
        toast(err.message + (err.failedRules ? ' ' + err.failedRules.join(', ') : ''), true);
      }
    });

    (async () => {
      currentUser = await requireAuthAndRenderShell('/users.html');
      if (!currentUser) return;
      if (!hasPermission(currentUser, 'staff.manage')) { location.href = '/index.html'; return; }
      load();
    })();
