// The Oct 2026 permissions split: the migration, and what each kind of account
// can and cannot do afterwards. Real permission middleware (only the login is
// stubbed), run against a throwaway copy of data/ in $HOME/sbx.
process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
const path = require('path'); const root = process.env.HOME + '/mnt/aotc-track';
const authPath = require.resolve(path.join(root, 'middleware/auth')); const realAuth = require(authPath);
let CURRENT = null;
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { ...realAuth,
  requireAuth: (q, _r, n) => { q.user = CURRENT; n(); } } };
const db = require(path.join(root, 'utils/db'));
const express = require(path.join(root, 'node_modules/express'));
const app = express(); app.use(express.json());
app.use('/api/setup', require(path.join(root, 'routes/setup')));
app.use('/api/auth', require(path.join(root, 'routes/auth')));
app.use('/api/meetings', require(path.join(root, 'routes/meetings')));
app.use('/api/finance-weekly', require(path.join(root, 'routes/financeWeekly')));
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const head = t => console.log('\n── ' + t);

// ---- A cast that mirrors the live accounts on 5 Oct 2026 ----
const cc = db.findAll('groups').find(g => g.code === 'CC');
const wf = db.findAll('groups').find(g => g.code === 'WF');
const me = db.findAll('committees').find(c => c.code === 'ME');
const sec = ['planning.manage', 'entry.manage', 'attendance.manage', 'meetings.manage', 'reports.generate', 'roster.propose'];
const cast = [
  { id: 1, name: 'Admin', role: 'admin', permissions: [] },
  { id: 3, name: 'Coordinator', role: 'coordinator', permissions: realAuth.ROLE_DEFAULT_PERMISSIONS.coordinator.slice(), entity: null },
  { id: 8, name: 'Session Clerk', role: 'clerk', permissions: ['approvals.manage', 'setup.manage', 'entry.manage', 'planning.manage', 'reports.generate', 'attendance.manage', 'meetings.manage', 'congregation.view'], entity: null },
  { id: 15, name: 'Naa Akwele Atiapa', role: 'attendance', permissions: ['attendance.main', 'staff.manage'], entity: null },
  { id: 21, name: 'Treasurer', role: 'treasurer', permissions: ['fundraising.manage', 'fundraising.approve', 'fundraising.verify'], entity: null },
  { id: 32, name: 'Choir Secretary', role: 'secretary', permissions: [...sec, 'setup.manage'], entity: { type: 'group', id: cc.id } },
  { id: 40, name: 'WF Secretary', role: 'secretary', permissions: sec.slice(), entity: { type: 'group', id: wf.id } },
  { id: 60, name: 'Helper with staff.manage', role: 'secretary', permissions: [...sec, 'staff.manage'], entity: { type: 'committee', id: me.id } },
];
db.writeAll('users', cast.map(u => ({ email: `u${u.id}@t.test`, ...u })));   // through the store (SQLite since Oct 2026)
const U = id => ({ id, role: db.findById('users', id).role, name: db.findById('users', id).name });
const perms = id => db.findById('users', id).permissions;

const mig = require(path.join(root, 'utils/migrations/permSplit2026'));
head('Migration');
const changes = mig.run();
ok(changes && changes.length === 4, `changes exactly the 4 accounts that need it (got ${changes && changes.length})`);
ok(!perms(32).includes('setup.manage') && perms(32).length === sec.length, 'a secretary loses setup.manage and keeps everything else');
ok(['setup.years', 'setup.structure', 'setup.venues', 'goals.manage', 'roster.manage', 'members.photos'].every(p => perms(8).includes(p)) && !perms(8).includes('setup.manage'), 'the Session Clerk gets the seven split rights instead');
ok(!perms(15).includes('staff.manage') && ['attendance.cs', 'attendance.jy', 'attendance.main', 'correspondence.intake'].every(p => perms(15).includes(p)), 'Church Administrator: no staff.manage; all three sections + correspondence');
ok(['finance.weekly.confirm', 'finance.weekly.lines', 'congregation.view'].every(p => perms(21).includes(p)), 'Treasurer gets the role defaults the account was missing');
ok(perms(40).length === sec.length && perms(1).length === 0, 'accounts that need nothing are left alone');
const rec = db.findOne('migrations', m => m.key === mig.KEY);
ok(rec && rec.changes.every(c => Array.isArray(c.before) && Array.isArray(c.after)), 'the record keeps every account’s before and after');
ok(db.findAll('activity_logs', l => /Permissions changed/.test(l.action)).length === 4, 'each change is in the activity log');
ok(mig.run() === null, 'running it again does nothing');

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (who, method, url, body) => { CURRENT = U(who); const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  head('A group secretary can no longer reach church-wide set-up');
  ok((await call(32, 'POST', '/api/setup/groups', { code: 'ZZ', name: 'New Group' })).status === 403, 'cannot create a group');
  ok((await call(32, 'PUT', `/api/setup/groups/${wf.id}`, { active: false })).status === 403, 'cannot archive another group');
  ok((await call(32, 'PUT', `/api/setup/groups/${cc.id}`, { active: false })).status === 403, 'cannot archive their own group either');
  ok((await call(32, 'POST', '/api/setup/rollover', { newYear: 2030 })).status === 403, 'cannot run the year rollover');
  ok((await call(32, 'POST', '/api/setup/years', { year: 2031 })).status === 403, 'cannot add a year');
  ok((await call(32, 'POST', '/api/meetings/venues', { name: 'X' })).status === 403, 'cannot add a venue');
  ok((await call(32, 'PUT', '/api/finance-weekly/lines', { lines: [] })).status === 403, 'cannot change the weekly finance lines');

  head('Goals: own goals by proposal, nobody else’s at all');
  const year = (db.findOne('years', y => y.active) || { year: 2026 }).year;
  const own = db.insert('goals', { year, code: 'CC-T1', description: 'Choir goal', ownerType: 'group', ownerCode: 'CC', kpis: [{ description: 'Rehearsals', unit: '', target: 10 }] });
  const other = db.insert('goals', { year, code: 'ME-T1', description: 'Mission goal', ownerType: 'committee', ownerCode: 'ME', kpis: [] });
  let r = await call(32, 'PUT', `/api/setup/goals/${other.id}`, { description: 'hijacked' });
  ok(r.status === 403 && db.findById('goals', other.id).description === 'Mission goal', 'cannot edit another body’s goal (could before, with no approval)');
  r = await call(32, 'PUT', `/api/setup/goals/${own.id}`, { ownerCode: 'ME' });
  ok(r.status === 403, 'cannot hand their goal to someone else');
  r = await call(32, 'PUT', `/api/setup/goals/${own.id}`, { kpis: [{ description: 'Rehearsals', unit: '', target: 12 }] });
  ok(r.status === 200 && r.body.pending === true, 'changing their own KPI target becomes a proposal');
  ok(db.findById('goals', own.id).kpis[0].target === 10, '…and the live goal is untouched until the Clerk decides');
  ok((await call(32, 'PUT', `/api/setup/goals/${own.id}`, { description: 'again' })).status === 409, 'a second change while one is waiting is refused');
  const pend = r.body.request;
  ok(pend.before && pend.before.kpis[0].target === 10, 'the proposal keeps what it said before, for the Clerk');
  ok((await call(32, 'POST', `/api/setup/goal-requests/${pend.id}/approve`)).status === 403, 'a secretary cannot approve their own proposal');
  r = await call(8, 'POST', `/api/setup/goal-requests/${pend.id}/approve`);
  ok(r.status === 200 && db.findById('goals', own.id).kpis[0].target === 12, 'the Clerk approves and the change goes live');
  r = await call(32, 'POST', '/api/setup/goals', { year, code: 'CC-T2', description: 'New choir goal', ownerCode: 'CC' });
  ok(r.status === 200 && r.body.pending === true, 'a secretary can propose a new goal for their own group');
  ok((await call(32, 'POST', '/api/setup/goals', { year, code: 'ME-T2', description: 'x', ownerCode: 'ME' })).status === 403, '…but not for anyone else');
  ok((await call(40, 'PUT', `/api/setup/goals/${own.id}`, { description: 'x' })).status === 403, 'the Women’s Fellowship secretary cannot touch the Choir’s goal');
  r = await call(3, 'PUT', `/api/setup/goals/${other.id}`, { description: 'Mission goal (coordinator)' });
  ok(r.status === 200 && !r.body.pending, 'the Reporting Coordinator still edits any goal directly');
  r = await call(8, 'PUT', `/api/setup/goals/${own.id}`, { description: 'Choir goal (clerk)' });
  ok(r.status === 200 && db.findById('goals', own.id).description === 'Choir goal (clerk)', 'the Clerk edits any goal directly');

  head('Groups: no more twins, and archive can be undone');
  ok((await call(8, 'POST', '/api/setup/groups', { code: 'C-C', name: 'Church Choir' })).status === 409, '"C-C" / "Church Choir" is refused (the 4 Oct duplicate)');
  ok((await call(8, 'POST', '/api/setup/groups', { code: 'NEW', name: '  church   choir ' })).status === 409, 'the same name in other spacing or case is refused');
  ok((await call(8, 'POST', '/api/setup/groups', { code: 'cc ', name: 'Something' })).status === 409, 'the same code in other case is refused');
  ok((await call(8, 'PUT', `/api/setup/groups/${wf.id}`, { name: 'Church Choir' })).status === 409, 'renaming onto an existing name is refused');
  r = await call(8, 'PUT', `/api/setup/groups/${cc.id}`, { active: false });
  ok(r.status === 200 && db.findAll('activity_logs', l => l.action === 'ARCHIVED group' && Number(l.entityId) === cc.id).length === 1, 'archiving is logged as ARCHIVED, not "Updated group"');
  r = await call(8, 'GET', '/api/setup/groups/archived');
  ok(r.status === 200 && r.body.some(g => g.id === cc.id), 'the archived list shows it');
  ok((await call(32, 'GET', '/api/setup/groups/archived')).status === 403, 'a secretary cannot see the archived list');
  r = await call(8, 'POST', '/api/setup/groups', { code: 'CHR', name: 'Church Choir' });
  ok(r.status === 409 && /restore it/.test(r.body.error || ''), 'creating a twin of an archived group says to restore it instead');
  r = await call(8, 'PUT', `/api/setup/groups/${cc.id}`, { active: true });
  ok(r.status === 200 && db.findById('groups', cc.id).active === true, 'Restore brings back the same record');
  ok(db.findAll('activity_logs', l => l.action === 'RESTORED group').length === 1, 'and logs RESTORED');

  head('Accounts: sensitive rights and your own account');
  r = await call(60, 'PUT', '/api/auth/users/40', { permissions: [...sec, 'approvals.manage'] });
  ok(r.status === 403 && !perms(40).includes('approvals.manage'), 'a non-admin with staff.manage cannot hand out the Clerk’s approvals');
  r = await call(60, 'PUT', '/api/auth/users/40', { permissions: [...sec, 'docs.upload'] });
  ok(r.status === 200 && perms(40).includes('docs.upload'), '…but can still grant an ordinary right');
  r = await call(60, 'PUT', '/api/auth/users/60', { permissions: [...sec, 'staff.manage', 'docs.upload'] });
  ok(r.status === 403 && !perms(60).includes('docs.upload'), 'nobody below admin changes their own permissions');
  r = await call(1, 'PUT', '/api/auth/users/40', { permissions: [...sec, 'docs.upload', 'members.photos'] });
  ok(r.status === 200 && perms(40).includes('members.photos'), 'an admin can grant a sensitive right');
  r = await call(1, 'GET', '/api/auth/permissions');
  ok(r.body.sensitive && r.body.sensitive.includes('setup.structure') && !r.body.permissions['setup.manage'], 'the catalogue lists the new rights, marks the sensitive ones, and setup.manage is gone');

  head('Add missing role defaults');
  db.update('users', 21, { permissions: ['fundraising.manage'] });
  ok((await call(60, 'POST', '/api/auth/roles/treasurer/apply-defaults')).status === 403, 'only an admin may do it');
  r = await call(1, 'POST', '/api/auth/roles/treasurer/apply-defaults');
  ok(r.status === 200 && r.body.changed.length === 1 && realAuth.ROLE_DEFAULT_PERMISSIONS.treasurer.every(p => perms(21).includes(p)), 'adds what the Treasurer is missing');
  db.update('users', 21, { permissions: [...perms(21), 'docs.upload'] });
  await call(1, 'POST', '/api/auth/roles/treasurer/apply-defaults');
  ok(perms(21).includes('docs.upload'), 'and never takes anything away');

  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
  server.close(); process.exit(fail ? 1 : 0);
});
