// Oct 2026 Home redesign: /api/home gives each person only what is theirs.
process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
const path = require('path'), fs = require('fs'); const root = process.env.HOME + '/mnt/aotc-track';
fs.mkdirSync(process.env.AOTC_DATA_DIR, { recursive: true });
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
let who = 1;
const authPath = require.resolve(path.join(root, 'middleware/auth')); const realAuth = require(authPath);
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { ...realAuth,
  requireAuth: (q, _r, nx) => { const u = USERS.find(x => x.id === who); q.user = { id: u.id, role: u.role, name: u.name }; nx(); } } };
const USERS = [
  { id: 1, name: 'Clerk', role: 'admin', email: 'c@t', permissions: [] },
  { id: 2, name: 'Secretary', role: 'secretary', email: 's@t', permissions: ['entry.manage'], entity: { type: 'group', id: 1 } },
  { id: 3, name: 'Administrator', role: 'secretary', email: 'a@t', permissions: ['correspondence.intake'] },
  { id: 4, name: 'Presbyter', role: 'secretary', email: 'p@t', permissions: ['congregation.view'] },
];
fs.writeFileSync(process.env.AOTC_DATA_DIR + '/users.json', JSON.stringify(USERS));
['minutes_docs', 'correspondence', 'minutes_proofreads', 'elections', 'session_members', 'pod_roster'].forEach(c => fs.writeFileSync(`${process.env.AOTC_DATA_DIR}/${c}.json`, '[]'));
const db = require(path.join(root, 'utils/db'));
const SM = require(path.join(root, 'utils/sessionMinutes'));
const express = require(path.join(root, 'node_modules/express'));
const app = express(); app.use(express.json());
app.use('/api/minutes', require(path.join(root, 'routes/minutes')));
app.use('/api/home', require(path.join(root, 'routes/home')));
const day = k => { const d = new Date(); d.setHours(12); d.setDate(d.getDate() + k); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const fut = db.insert('minutes_docs', SM.newMinutesDoc({ date: day(2), venue: 'Chapel' }));
const past = db.insert('minutes_docs', SM.newMinutesDoc({ date: day(-10) }));
db.insert('minutes_docs', { ...SM.newMinutesDoc({ date: day(-40) }), locked: true });
db.insert('minutes_proofreads', { docId: past.id, uploadedAt: 'x', proofreader: 'Mr P', changes: [{ id: 1, status: 'pending' }, { id: 2, status: 'accepted' }], comments: [{ id: 1, status: 'pending' }] });
db.insert('correspondence', { minutesId: past.id, heading: 'A', action: '' });
db.insert('correspondence', { minutesId: past.id, heading: 'B', action: 'Noted' });
db.insert('correspondence', { heading: 'New one', status: 'new', receivedOn: day(-2) });
db.insert('correspondence', { heading: 'Sorted', status: 'session', receivedOn: day(-2), eventDate: day(1) });
const opens = new Date(Date.now() + 2 * 86400000).toISOString();
db.insert('elections', { title: 'YPG Elections', entityName: 'YPG', status: 'pending', openAt: opens, officers: [] });
db.insert('elections', { title: 'Choir Elections', entityName: 'Choir', status: 'open', openAt: new Date(Date.now() - 3600e3).toISOString(), closeAt: new Date(Date.now() + 3600e3).toISOString(), officers: [{ userId: 4 }] });

const server = app.listen(0, async () => {
  const get = async u => { who = u; const r = await fetch(`http://127.0.0.1:${server.address().port}/api/home`); return r.json(); };
  console.log('\n── The Session Clerk');
  let h = await get(1);
  const t = h.needs.map(x => x.title).join(' | ');
  ok(/notice not yet sent/.test(t) && h.needs.find(x => /notice/.test(x.title)).tone === 'red', 'a Session meeting in two days with no notice sent is at the top, in red');
  ok(h.needs.some(x => /proofreading/.test(x.title) && /2 proofreading items/.test(x.meta) && /1 letter with no Action/.test(x.meta)), 'unadopted minutes: open proofreading and letters with no Action, counted');
  ok(!h.needs.some(x => /Minutes of/.test(x.title) && x.href.endsWith(`=${fut.id}`)), 'the minutes of a meeting still to come are not chased');
  ok(h.needs.some(x => /1 letter to sort/.test(x.title)), 'only letters still to be sorted count as "to sort"');
  ok(h.needs.some(x => /YPG Elections — waiting for your confirmation/.test(x.title)), 'an election waiting for confirmation');
  ok(h.week.some(x => x.kind === 'session' && x.date === fut.date) && h.week.some(x => x.kind === 'letter'), 'coming up: the Session meeting and a letter that asks for something before it');
  ok(h.needs.map(x => x.rank).every((r, i, a) => !i || a[i - 1] <= r), 'most urgent first');
  console.log('\n── Others');
  h = await get(2);
  ok(!h.needs.length && !h.week.length, 'a group secretary sees no Session, inbox or election items');
  h = await get(3);
  ok(!h.needs.length && !h.week.some(x => x.kind === 'session') && h.week.some(x => x.kind === 'letter'), 'the Church Administrator (inbox only) sees the inbox letter date, but no Session items and no sorting task');
  h = await get(4);
  ok(h.week.some(x => x.kind === 'session') && !h.needs.some(x => /notice|Minutes of|confirm/.test(x.title)), 'a Presbyter who may view the Session sees the meeting coming up, but no Clerk tasks');
  ok(h.needs.some(x => /Choir Elections — polls are open/.test(x.title) && /poll-desk/.test(x.href)), 'a polling officer is told polls are open, with the Polling Desk link');
  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
  server.close(); process.exit(fail ? 1 : 0);
});
