// One request model for every lock, routed to whoever is placed to judge it.
process.env.AOTC_DATA_DIR = process.env.AOTC_DATA_DIR || (process.env.HOME + '/sbx');
const path = require('path');
const root = path.join(__dirname, '..');
const authPath = require.resolve(path.join(root, 'middleware/auth'));
const realAuth = require(authPath);
let CURRENT = null;
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { ...realAuth,
  requireAuth: (q, _r, n) => { q.user = CURRENT; n(); },
  requirePermission: () => (q, _r, n) => { q.user = CURRENT; n(); },
  requireAnyPermission: () => (q, _r, n) => { q.user = CURRENT; n(); },
  canManageAllEntities: () => true } };
['utils/sms', 'utils/mailer', 'utils/push'].forEach(m => { const p = require.resolve(path.join(root, m));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: { sendSms: async () => ({}), sendMail: async () => ({}), sendPushToUsers: async () => ({ sent: 0 }), sendPushToUser: async () => ({ sent: 0 }) } }; });
const db = require(path.join(root, 'utils/db'));
const { approvableKinds } = require(path.join(root, 'utils/unlockKinds'));
const express = require(path.join(root, 'node_modules/express'));
const app = express(); app.use(express.json());
app.use('/api/unlocks', require(path.join(root, 'routes/unlocks')));
let fail = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const head = t => console.log('\n── ' + t);

// Three people, three different reaches.
db.update('users', 1, { name: 'Session Clerk', role: 'clerk', permissions: ['approvals.manage', 'congregation.view'] });
db.update('users', 2, { name: 'Treasurer', role: 'treasurer', permissions: ['fundraising.approve', 'finance.weekly.confirm'] });
db.update('users', 3, { name: 'WF Secretary', role: 'secretary', permissions: ['entry.manage', 'meetings.manage'], entity: { type: 'group', id: 6 } });
const CLERK = { id: 1 }, TREAS = { id: 2 }, SEC = { id: 3 };

const server = app.listen(0, async () => {
  const P = server.address().port, base = `http://127.0.0.1:${P}`;
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  head('Routing — who is placed to judge what');
  ok(approvableKinds('clerk', ['approvals.manage']).join() === 'quarter,service-day,meeting-attendance',
     'the Session Clerk judges the quarter, Sunday attendance and meeting attendance');
  ok(approvableKinds('treasurer', ['fundraising.approve', 'finance.weekly.confirm']).join() === 'fundraising-day,finance-week',
     'the Treasurer judges the money ones');
  ok(approvableKinds('admin', []).length === 5, 'an admin judges all five');
  ok(approvableKinds('secretary', ['entry.manage']).length === 0, 'a secretary judges none');

  head('A secretary asks for locked meeting attendance');
  const mtg = db.insert('meetings', { entityType: 'group', entityId: 6, entityName: "Women's Fellowship",
    date: '2026-09-20', title: 'September general meeting',
    attendance: { locked: true, recordedBy: 'WF Secretary', recordedAt: '2026-09-20T18:00:00Z', present: [] } });
  CURRENT = SEC;
  let r = await call('POST', '/api/unlocks', { kind: 'meeting-attendance', target: { meetingId: mtg.id }, reason: 'two names ticked by mistake' });
  ok(r.status === 200 && r.body.status === 'pending', 'the request is raised');
  ok(r.body.reason === 'two names ticked by mistake', 'and carries the reason — the thing a phone call loses');
  const reqId = r.body.id;
  ok((await call('POST', '/api/unlocks', { kind: 'meeting-attendance', target: { meetingId: mtg.id }, reason: 'again' })).status === 409,
     'asking twice for the same thing is refused');
  ok((await call('POST', '/api/unlocks', { kind: 'meeting-attendance', target: { meetingId: mtg.id } })).status === 400,
     'and a request with no reason is refused');

  head('The queue shows each person only what they may decide');
  CURRENT = CLERK;
  let q = (await call('GET', '/api/unlocks?status=pending')).body;
  ok(q.requests.some(x => x.id === reqId && x.canDecide), 'the Session Clerk sees it and may decide');
  CURRENT = TREAS;
  q = (await call('GET', '/api/unlocks?status=pending')).body;
  ok(!q.requests.some(x => x.id === reqId), 'the Treasurer does not see a meeting-attendance request at all');
  ok((await call('POST', `/api/unlocks/${reqId}/approve`, {})).status === 403, 'and cannot decide it if they try');
  CURRENT = SEC;
  q = (await call('GET', '/api/unlocks?status=pending')).body;
  ok(q.requests.some(x => x.id === reqId && !x.canDecide), 'the asker can watch their own request without being able to decide it');

  head('Approving actually unlocks the thing');
  CURRENT = CLERK;
  r = await call('POST', `/api/unlocks/${reqId}/approve`, {});
  ok(r.status === 200 && r.body.status === 'approved', 'approved');
  ok(db.findById('meetings', mtg.id).attendance.locked === false, 'the meeting attendance is genuinely open now');
  ok((await call('POST', `/api/unlocks/${reqId}/approve`, {})).status === 400, 'and it cannot be approved twice');

  head('The money ones go the other way');
  const ev = db.insert('fundraising_events', { name: 'Harvest 2026', year: 2026 });
  db.insert('fundraising_entries', { eventId: ev.id, date: '2026-09-13', status: 'confirmed', amount: 500 });
  CURRENT = SEC;
  r = await call('POST', '/api/unlocks', { kind: 'fundraising-day', target: { eventId: ev.id, date: '2026-09-13' }, reason: 'wrong basket total' });
  ok(r.status === 200, 'a secretary may ask about a fundraising day');
  const fId = r.body.id;
  CURRENT = CLERK;
  ok((await call('POST', `/api/unlocks/${fId}/approve`, {})).status === 403, 'the Session Clerk may NOT approve a money reopening');
  CURRENT = TREAS;
  ok((await call('POST', `/api/unlocks/${fId}/approve`, {})).status === 200, 'the Treasurer may');
  ok(db.findAll('fundraising_entries', e => Number(e.eventId) === ev.id)[0].status === 'pending', 'and the day really reopens');

  head('A timed kind still gets its window');
  const sub = db.insert('submissions', { year: 2026, quarter: 4, entityType: 'group', entityId: 6, ownerCode: 'WF', status: 'submitted', submittedBy: 'WF Secretary' });
  CURRENT = SEC;
  const qId = (await call('POST', '/api/unlocks', { kind: 'quarter', target: { year: 2026, quarter: 4, entityType: 'group', entityId: 6, ownerCode: 'WF' }, reason: 'figures corrected' })).body.id;
  CURRENT = CLERK;
  r = await call('POST', `/api/unlocks/${qId}/approve`, { window: 'hours' });
  ok(r.status === 200 && r.body.window === 'hours', 'the quarter is approved with a 48-hour window');
  const after = db.findById('submissions', sub.id);
  const hrs = (new Date(after.reopenedUntil) - Date.now()) / 3600000;
  ok(hrs > 47 && hrs < 49, `and the submission carries that window (${hrs.toFixed(1)}h)`);

  head('Declining, and things that are already open');
  const mtg2 = db.insert('meetings', { entityType: 'group', entityId: 6, entityName: "Women's Fellowship", date: '2026-09-27', attendance: { locked: true, recordedBy: 'X', recordedAt: '2026-09-27T18:00:00Z' } });
  CURRENT = SEC;
  const dId = (await call('POST', '/api/unlocks', { kind: 'meeting-attendance', target: { meetingId: mtg2.id }, reason: 'please' })).body.id;
  CURRENT = CLERK;
  r = await call('POST', `/api/unlocks/${dId}/decline`, { reason: 'the figures are right' });
  ok(r.status === 200 && r.body.status === 'declined' && r.body.declineReason === 'the figures are right', 'a decline is recorded with its reason');
  ok(db.findById('meetings', mtg2.id).attendance.locked === true, 'and the thing stays locked');
  CURRENT = SEC;
  const open = db.insert('meetings', { entityType: 'group', entityId: 6, date: '2026-10-04', attendance: { locked: false } });
  ok((await call('POST', '/api/unlocks', { kind: 'meeting-attendance', target: { meetingId: open.id }, reason: 'x' })).status === 400,
     'asking about something that is not locked is refused — just edit it');
  ok((await call('POST', '/api/unlocks', { kind: 'nonsense', target: {}, reason: 'x' })).status === 400, 'an unknown kind is refused');

  console.log(`\n${n - fail}/${n} checks — ${fail ? fail + ' FAILED (above)' : 'all green'}`);
  server.close(); process.exit(fail ? 1 : 0);
});
