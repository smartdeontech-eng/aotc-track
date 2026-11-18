// Switching an account off and on (Oct 2026), end to end with the REAL auth:
// real login, real cookie, real requireAuth. Throwaway data in $HOME/sbx.
process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
const path = require('path'), fs = require('fs'); const root = process.env.HOME + '/mnt/aotc-track';
const bcrypt = require(path.join(root, 'node_modules/bcryptjs'));
const express = require(path.join(root, 'node_modules/express'));
const cookieParser = require(path.join(root, 'node_modules/cookie-parser'));
const db = require(path.join(root, 'utils/db'));
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const head = t => console.log('\n── ' + t);

const hash = bcrypt.hashSync('Correct-Horse-9!', 8);
const mk = (id, name, role, extra = {}) => ({ id, name, email: `u${id}@t.test`, role, passwordHash: hash, permissions: [], twoFactorEnabled: false, mustChangePassword: false, ...extra });
// Since the move to SQLite (Oct 2026) the store has its own file; set rows through it.
db.writeAll('users', ([
  mk(1, 'Admin One', 'admin'), mk(2, 'Admin Two', 'admin'),
  mk(8, 'Clerk', 'clerk', { permissions: ['approvals.manage'] }),
  mk(32, 'Choir Sec', 'secretary', { permissions: ['planning.manage', 'staff.manage'], entity: { type: 'group', id: 7 } }),
  mk(33, 'Choir Sec', 'secretary', { permissions: ['planning.manage'], entity: { type: 'group', id: 8 }, linkedTo: 32, email: 'ws33@t.local' }),
  mk(40, 'WF Sec', 'secretary', { permissions: ['planning.manage'], entity: { type: 'group', id: 6 } }),
]));

const app = express(); app.use(express.json()); app.use(cookieParser());
app.use('/api/auth', require(path.join(root, 'routes/auth')));
app.use('/api/setup', require(path.join(root, 'routes/setup')));
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = async email => { const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'Correct-Horse-9!' }) }); const c = (r.headers.get('set-cookie') || '').split(';')[0]; return { status: r.status, cookie: c, body: await r.json().catch(() => ({})) }; };
  const call = async (cookie, method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  const admin = (await login('u1@t.test')).cookie;
  const sec = await login('u40@t.test');
  ok(sec.status === 200 && sec.cookie, 'a secretary signs in normally');
  ok((await call(sec.cookie, 'GET', '/api/setup/years')).status === 200, '…and the app answers them');

  head('Switching off');
  ok((await call(admin, 'POST', '/api/auth/users/40/status', { enabled: false })).status === 400, 'a reason is required');
  let r = await call(admin, 'POST', '/api/auth/users/40/status', { enabled: false, reason: 'Left the fellowship' });
  ok(r.status === 200 && r.body.user.disabled === true && r.body.user.disabledReason === 'Left the fellowship', 'switched off, with who/why kept on the account');
  r = await call(sec.cookie, 'GET', '/api/setup/years');
  ok(r.status === 401 && r.body.disabled, 'their open session stops working on the very next request');
  r = await login('u40@t.test');
  ok(r.status === 403 && /switched off/.test(r.body.error), 'they cannot sign in again, and are told why');
  const bad = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'u40@t.test', password: 'wrong' }) });
  ok(bad.status === 401, 'a wrong password still just says "incorrect" (switched-off is not revealed to guessers)');
  ok(db.findAll('activity_logs', l => /SWITCHED OFF account: Left the fellowship/.test(l.action)).length === 1, 'the activity log records it with the reason');
  const { activeUsers } = require(path.join(root, 'utils/accountStatus'));
  ok(!activeUsers().some(u => u.id === 40), 'they drop out of every notification list');
  ok(db.findById('users', 40).permissions.includes('planning.manage'), 'nothing else on the account is touched');

  head('Switching back on');
  r = await call(admin, 'POST', '/api/auth/users/40/status', { enabled: true });
  ok(r.status === 200 && !r.body.user.disabled, 'switched back on');
  r = await login('u40@t.test');
  ok(r.status === 200 && (await call(r.cookie, 'GET', '/api/setup/years')).status === 200, 'they can sign in and work again');

  head('A login carries its workspaces; one workspace can go alone');
  await call(admin, 'POST', '/api/auth/users/33/status', { enabled: false, reason: 'Stepped down as YPG secretary' });
  r = await login('u32@t.test');
  ok(r.status === 200, 'switching off one workspace leaves the login working');
  ok((await call(r.cookie, 'POST', '/api/auth/switch/33')).status === 403, '…but that workspace can no longer be switched into');
  await call(admin, 'POST', '/api/auth/users/33/status', { enabled: true });
  await call(admin, 'POST', '/api/auth/users/32/status', { enabled: false, reason: 'On leave' });
  ok(!activeUsers().some(u => u.id === 33), 'switching the login off takes its workspaces with it');
  await call(admin, 'POST', '/api/auth/users/32/status', { enabled: true });

  head('Guards');
  const choir = (await login('u32@t.test')).cookie;   // holds staff.manage, not an admin
  ok((await call(choir, 'POST', '/api/auth/users/32/status', { enabled: false, reason: 'x' })).status === 403, 'nobody switches their own account off');
  ok((await call(choir, 'POST', '/api/auth/users/33/status', { enabled: false, reason: 'x' })).status === 403, '…or one of their own workspaces');
  ok((await call(choir, 'POST', '/api/auth/users/1/status', { enabled: false, reason: 'x' })).status === 403, 'only an administrator can switch an admin');
  ok((await call(choir, 'POST', '/api/auth/users/40/status', { enabled: false, reason: 'x' })).status === 200, 'a staff manager can switch an ordinary account');
  ok((await call(sec.cookie, 'POST', '/api/auth/users/8/status', { enabled: false, reason: 'x' })).status === 401, 'without staff.manage (here: already off) nothing happens');
  await call(admin, 'POST', '/api/auth/users/40/status', { enabled: true });
  const w = (await login('u40@t.test')).cookie;
  ok((await call(w, 'POST', '/api/auth/users/8/status', { enabled: false, reason: 'x' })).status === 403, 'a secretary without staff.manage cannot switch anyone');
  ok((await call(admin, 'POST', '/api/auth/users/2/status', { enabled: false, reason: 'test' })).status === 200, 'an admin can switch another admin off');
  const admin2Login = await login('u2@t.test');
  ok(admin2Login.status === 403, '…who then cannot sign in');
  ok((await call(admin, 'POST', '/api/auth/users/1/status', { enabled: false, reason: 'x' })).status === 403, 'the last working admin cannot switch themselves off (own account)');

  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
  server.close(); process.exit(fail ? 1 : 0);
});
