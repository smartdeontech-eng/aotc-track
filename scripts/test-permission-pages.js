// The client half of the Oct 2026 permissions split, in jsdom: the Users page
// (sensitive marking, "vs role" badge, Who-can-do-what, own-account lock) and
// the Goals page (secretaries get "Propose change" on their own goals only).
// app.js is not loaded; its globals are stubbed. No server — the API is faked.
const path = require('path'), fs = require('fs'); const root = process.env.HOME + '/mnt/aotc-track';
const { JSDOM } = require(path.join(root, 'node_modules/jsdom'));
const { PERMISSIONS, ROLE_DEFAULT_PERMISSIONS, SENSITIVE_PERMISSIONS } = (() => { process.env.JWT_SECRET = 'x'.repeat(48); return require(path.join(root, 'middleware/auth')); })();
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const head = t => console.log('\n── ' + t);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function page(file, script, user, routes) {
  const html = fs.readFileSync(path.join(root, 'public', file), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost/' + file, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  w.api = async (p) => { const k = Object.keys(routes).find(r => p.startsWith(r)); if (!k) throw Object.assign(new Error('no route ' + p), { status: 404 }); return JSON.parse(JSON.stringify(routes[k])); };
  w.esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  w.toast = () => {}; w.confirmDialog = async () => true; w.promptDialog = async () => ''; w.infoDialog = async () => {};
  w.isElevated = u => ['admin', 'localadmin'].includes(u.role);
  w.hasPermission = (u, p) => w.isElevated(u) || (u.permissions || []).includes(p);
  w.roleLabel = r => ({ secretary: 'Secretary', treasurer: 'Treasurer', clerk: 'Session Clerk' })[r] || r;
  w.passwordChecklistHtml = () => ''; w.wirePasswordMeter = () => {};
  w.requireAuthAndRenderShell = async () => user;
  w.eval(fs.readFileSync(path.join(root, 'public/js', script), 'utf8'));
  return w;
}

(async () => {
  const sec = ROLE_DEFAULT_PERMISSIONS.secretary;
  const users = [
    { id: 1, name: 'Admin', role: 'admin', permissions: [], email: 'a@t' },
    { id: 8, name: 'Clerk', role: 'clerk', permissions: ROLE_DEFAULT_PERMISSIONS.clerk, email: 'c@t' },
    { id: 21, name: 'Treasurer', role: 'treasurer', permissions: ['fundraising.manage'], email: 't@t' },
    { id: 32, name: 'Choir Sec', role: 'secretary', permissions: [...sec, 'docs.upload'], email: 's@t', entity: { type: 'group', id: 7 } },
    { id: 60, name: 'Helper', role: 'secretary', permissions: [...sec, 'staff.manage'], email: 'h@t', entity: { type: 'group', id: 7 } },
    { id: 70, name: 'Gone Away', role: 'secretary', permissions: sec, email: 'g@t', disabled: true, disabledBy: 'Admin', disabledReason: 'Left the committee', disabledAt: '2026-10-05T10:00:00Z' },
  ];
  const routes = {
    '/auth/users': users, '/auth/permissions': { permissions: PERMISSIONS, roleDefaults: ROLE_DEFAULT_PERMISSIONS, sensitive: SENSITIVE_PERMISSIONS },
    '/setup/committees': [], '/setup/groups': [{ id: 7, code: 'CC', name: 'Church Choir' }], '/backups': [], '/auth/login-logs': [],
  };

  head('Users page, as an admin');
  let w = page('users.html', 'page-users.js', users[0], routes);
  for (let i = 0; i < 40 && !w.document.getElementById('rows').innerHTML.trim(); i++) await sleep(25);
  const d = w.document;
  const allKeys = [...new Set(Object.keys(PERMISSIONS))];
  w.eval("document.getElementById('addBtn').click()");
  const boxes = [...d.querySelectorAll('#permChecklist input[data-perm]')].map(b => b.dataset.perm);
  ok(allKeys.every(k => boxes.includes(k)), `every one of the ${allKeys.length} permissions can be ticked`);
  ok(!boxes.includes('setup.manage'), 'the old combined box is gone');
  ok(!/Other/.test(d.getElementById('permChecklist').textContent), 'none fall into the "Other" bucket');
  ok(d.querySelectorAll('#permChecklist .badge-attention').length === SENSITIVE_PERMISSIONS.length, 'each sensitive right is marked');
  ok(![...d.querySelectorAll('#permChecklist input')].some(b => b.disabled), 'an admin can tick all of them');
  ok(/−5? ?vs role|vs role/.test(d.getElementById('rows').textContent) && /−5 vs role/.test(d.getElementById('rows').textContent), 'the Treasurer row shows it is missing 5 role defaults');
  ok(/\+1 vs role/.test(d.getElementById('rows').textContent), 'the Choir secretary row shows one right added by hand');
  ok(d.getElementById('whoCard').style.display !== 'none', 'Who can do what is shown');
  w.eval("const s=document.getElementById('whoPerm'); s.value='docs.upload'; s.onchange();");
  ok(/Choir Sec/.test(d.getElementById('whoRows').textContent) && /added by hand/.test(d.getElementById('whoRows').textContent), 'picking a permission lists its holders and says why they have it');
  ok(/Treasurer account is missing/.test(d.getElementById('whoMissing').textContent) && /Add what/.test(d.getElementById('whoMissing').textContent), 'it flags the Treasurer account missing its defaults, with a fix button');
  w.eval('openEdit(21)');
  ok(/Differs from the Treasurer defaults/.test(d.getElementById('editDiffNote').textContent), 'the edit dialog says how the account differs');
  w.eval("document.getElementById('editResetBtn').click()");
  const after = [...d.querySelectorAll('#editPermChecklist input:checked')].map(b => b.dataset.perm);
  ok(ROLE_DEFAULT_PERMISSIONS.treasurer.every(p => after.includes(p)) && after.length === ROLE_DEFAULT_PERMISSIONS.treasurer.length, 'Reset to role defaults ticks exactly the role’s defaults');

  head('On / off switch beside each name');
  const row = name => [...d.querySelectorAll('#rows .ucard')].find(r => r.querySelector('.ucard-name').textContent.includes(name));
  const sw = name => row(name).querySelector('.acct-switch input');
  ok(sw('Choir Sec') && sw('Choir Sec').checked && !sw('Choir Sec').disabled, 'an ordinary account has a switch, on, and can be used');
  ok(!sw('Gone Away').checked && /Switched off/.test(row('Gone Away').textContent) && row('Gone Away').classList.contains('acct-off'), 'a switched-off account shows off, greyed, with a badge');
  ok(/Left the committee/.test(row('Gone Away').querySelector('.badge-critical').getAttribute('title')), '…and the badge says who switched it off and why');
  ok(!row('Admin') || !row('Admin').querySelector('.acct-switch input') || row('Admin').querySelector('.acct-switch input').disabled, 'you cannot switch yourself off');

  head('Search and filters (no sideways scrolling)');
  ok(!d.querySelector('#rows table') && d.querySelectorAll('#rows .ucard').length === users.length, 'one card per person, no wide table');
  const setQ = (v, role = '', st = '') => { d.getElementById('uSearch').value = v; d.getElementById('uRole').value = role; d.getElementById('uStatus').value = st; w.eval('render()'); return [...d.querySelectorAll('#rows .ucard')].map(c => c.querySelector('.ucard-name > span').textContent.trim()); };
  ok(setQ('choir').join() === 'Choir Sec,Helper', 'searching a group name finds everyone who works in it');
  ok(setQ('s@t').join() === 'Choir Sec', 'searching an email works');
  ok(setQ('treasurer').includes('Treasurer'), 'searching an access level works');
  ok(/<mark>Choir<\/mark>/i.test(setQ('choir') && d.getElementById('rows').innerHTML), 'the match is highlighted');
  ok(setQ('', '', 'off').join() === 'Gone Away', 'filter: switched off');
  ok(setQ('', 'treasurer').join() === 'Treasurer', 'filter: access level');
  ok(setQ('', '', 'diff').includes('Treasurer') && !setQ('', '', 'diff').includes('Clerk'), 'filter: differs from its role');
  ok(/Showing 1 of/.test((setQ('', 'treasurer'), d.getElementById('uCount').textContent)), 'the count says how many are shown');
  ok(/No one matches/.test((setQ('zzzz'), d.getElementById('rows').textContent)), 'an empty search says so');
  setQ('');

  head('Users page, as a non-admin with staff.manage');
  w = page('users.html', 'page-users.js', users[4], routes);
  for (let i = 0; i < 40 && !w.document.getElementById('rows').innerHTML.trim(); i++) await sleep(25);
  w.eval('openEdit(32)');
  const box = k => w.document.querySelector(`#editPermChecklist input[data-perm="${k}"]`);
  ok(box('approvals.manage').disabled && !box('docs.upload').disabled, 'sensitive boxes are locked, ordinary ones are not');
  ok(!/Add what/.test(w.document.getElementById('whoMissing').textContent), 'no "Add what’s missing" button (admin only)');

  head('Goals page');
  const goalsRoutes = { '/setup/committees': [{ id: 1, code: 'ME', name: 'Mission' }], '/setup/groups': [{ id: 7, code: 'CC', name: 'Church Choir' }],
    '/setup/goals': [{ id: 1, code: 'CC-1', description: 'Choir goal', ownerCode: 'CC', kpis: [] }, { id: 2, code: 'ME-1', description: 'Mission goal', ownerCode: 'ME', kpis: [] }],
    '/setup/goal-requests': [{ id: 9, kind: 'edit', code: 'CC-1', ownerCode: 'CC', status: 'pending', requestedBy: 'Choir Sec', patch: { kpis: [{ description: 'Rehearsals', target: 12 }] }, before: { kpis: [{ description: 'Rehearsals', target: 10 }] } }] };
  w = page('goals.html', 'page-goals.js', { id: 32, role: 'secretary', permissions: sec, entity: { type: 'group', id: 7 } }, goalsRoutes);
  w.myEntity = { type: 'group', id: 7, code: 'CC', name: 'Church Choir' };
  for (let i = 0; i < 40 && !w.document.getElementById('rows').innerHTML.trim(); i++) await sleep(25);
  const rows = [...w.document.querySelectorAll('#rows tr')];
  const rowFor = c => rows.find(r => r.textContent.includes(c));
  ok(/Propose change/.test(rowFor('CC-1').textContent), 'a secretary gets "Propose change" on their own goal');
  ok(!/Propose change|Edit/.test(rowFor('ME-1').textContent.replace('KPIs', '')), '…and nothing on another committee’s goal');
  ok(w.document.getElementById('addBtn').style.display !== 'none', 'they can propose a new goal');
  w.eval('editGoal(1)');
  ok(w.document.getElementById('gOwner').disabled, 'the owner is locked — they cannot move the goal');
  w = page('goals.html', 'page-goals.js', { id: 8, role: 'clerk', permissions: ROLE_DEFAULT_PERMISSIONS.clerk }, goalsRoutes);
  for (let i = 0; i < 40 && !w.document.getElementById('rows').innerHTML.trim(); i++) await sleep(25);
  ok(/target 10 → 12/.test(w.document.getElementById('pendingRows').textContent), 'the Clerk sees exactly what a proposal changes (target 10 → 12)');
  ok(/Approve/.test(w.document.getElementById('pendingRows').textContent), '…with Approve / Decline');

  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
