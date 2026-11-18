// Self-contained test of the money-side offices: Treasurer and Accounts Clerk.
//
//   node scripts/test-fundraising-roles.js
//
// Both are congregation OFFICES, not committee seats: assigning the role alone
// must open the Fundraising module with the right level of authority. Boots the
// real Express app against a throwaway data directory — no running server, and
// it never touches the live records.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto');
const APP = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aotc-roles-'));
process.env.AOTC_DATA_DIR = DATA;
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.NODE_ENV = 'test';
process.chdir(APP);

const bcrypt = require(path.join(APP, 'node_modules', 'bcryptjs'));
const db = require(path.join(APP, 'utils', 'db'));
const { ROLE_DEFAULT_PERMISSIONS, ROLES } = require(path.join(APP, 'middleware', 'auth'));
const PASS = 'Password#12345';

let fails = 0;
const ok = (cond, msg) => { if (cond) console.log('ok  :', msg); else { fails++; console.log('FAIL:', msg); } };

// Everyone is congregation-wide: an office is not attached to a committee.
const people = {
  harvest: { name: 'Harvest Member', email: 'harvest@test.com', role: 'secretary', permissions: ['fundraising.manage'] },
  clerk: { name: 'Accounts Clerk', email: 'accounts@test.com', role: 'accounts', permissions: ROLE_DEFAULT_PERMISSIONS.accounts },
  treasurer: { name: 'Church Treasurer', email: 'treasurer@test.com', role: 'treasurer', permissions: ROLE_DEFAULT_PERMISSIONS.treasurer },
};
Object.values(people).forEach(p => db.insert('users', {
  name: p.name, email: p.email, phone: '', role: p.role, permissions: p.permissions,
  entity: { type: 'congregation', id: 0 },
  passwordHash: bcrypt.hashSync(PASS, 10),
  twoFactorEnabled: false, mustChangePassword: false,
}));

const app = require(path.join(APP, 'server.js'));
const server = app.listen(0, async () => {
  const BASE = `http://127.0.0.1:${server.address().port}/api`;
  const jars = {};
  const call = async (who, method, p, body) => {
    const res = await fetch(BASE + p, {
      method, headers: { 'Content-Type': 'application/json', cookie: jars[who] || '' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) jars[who] = sc.split(';')[0];
    let json = null; try { json = await res.json(); } catch (e) {}
    return { status: res.status, json };
  };
  const login = async who => {
    const r = await call(who, 'POST', '/auth/login', { email: people[who].email, password: PASS });
    if (r.status !== 200) throw new Error(`login failed for ${who}: ${JSON.stringify(r.json)}`);
  };

  try {
    ok(ROLES.includes('accounts'), 'Accounts Clerk is a real role, not a hand-ticked permission');
    ok(ROLE_DEFAULT_PERMISSIONS.treasurer.includes('fundraising.verify'), 'Treasurer carries the verify right as well as approve');
    ok(ROLE_DEFAULT_PERMISSIONS.treasurer.includes('fundraising.manage'), 'Treasurer can record figures too');
    ok(ROLE_DEFAULT_PERMISSIONS.accounts.includes('finance.quarterly'), 'Accounts Clerk carries the Finance quarterly books');
    ok(ROLE_DEFAULT_PERMISSIONS.accounts.includes('fundraising.manage'), 'Accounts Clerk can record figures too');
    ok(ROLE_DEFAULT_PERMISSIONS.accounts.includes('congregation.view'), 'Accounts Clerk sees the congregation read-only');

    await login('harvest'); await login('clerk'); await login('treasurer');

    // Both offices reach the module on the strength of the role alone.
    for (const who of ['clerk', 'treasurer']) {
      const ov = await call(who, 'GET', '/fundraising/overview');
      ok(ov.status === 200, `${people[who].name} sees Fundraising without belonging to the Harvest Committee`);
    }

    const ev = await call('harvest', 'POST', '/fundraising/events', { name: 'Main Harvest', target: 50000 });
    ok(ev.status === 200, 'a Harvest Committee member creates the event');
    const evId = ev.json.id;
    const year = new Date().getFullYear();
    const iso = d => d.toISOString().slice(0, 10);
    const due = iso(new Date(Date.now() + 30 * 86400000));

    const day = async (date, extra) => call('harvest', 'PUT', '/fundraising/entries', {
      eventId: evId, date, service: 'joint',
      categories: { seed: {}, gratitude: 150, chairpersons: 0, dayborn: {} },
      methods: { cash: 100 },
      ious: [{ name: 'Bro Kofi', contact: '0244000000', amount: 50, dueDate: due }],
      ...extra,
    });

    // ---- Day 1: the ordinary route — clerk verifies, treasurer approves ----
    const d1 = `${year}-10-04`;
    ok((await day(d1)).status === 200, 'entry recorded by the Harvest Committee');
    ok((await call('harvest', 'POST', '/fundraising/submit-day', { eventId: evId, date: d1 })).status === 200, 'Harvest submits the day');

    const hv = await call('harvest', 'POST', '/fundraising/verify-day', { eventId: evId, date: d1 });
    ok(hv.status === 403, 'the person who entered the figures cannot verify them');

    const cv = await call('clerk', 'POST', '/fundraising/verify-day', { eventId: evId, date: d1 });
    ok(cv.status === 200, 'Accounts Clerk verifies (level 1)');
    const ca = await call('clerk', 'POST', '/fundraising/approve-day', { eventId: evId, date: d1 });
    ok(ca.status === 403, 'Accounts Clerk cannot approve — that is the Treasurer\'s level');
    const ta = await call('treasurer', 'POST', '/fundraising/approve-day', { eventId: evId, date: d1 });
    ok(ta.status === 200, 'Treasurer approves and locks (level 2)');

    let ov = await call('treasurer', 'GET', '/fundraising/overview');
    const e1 = ov.json.entries.find(e => e.date === d1);
    ok(e1.status === 'confirmed' && e1.verifiedBy === 'Accounts Clerk' && e1.confirmedBy === 'Church Treasurer',
      `both signatures recorded: verified by ${e1.verifiedBy}, approved by ${e1.confirmedBy}`);

    // ---- Day 2: the clerk is away — the Treasurer closes it alone ----
    const d2 = `${year}-10-11`;
    ok((await day(d2)).status === 200, 'second day recorded');
    ok((await call('harvest', 'POST', '/fundraising/submit-day', { eventId: evId, date: d2 })).status === 200, 'Harvest submits the second day');
    const ta2 = await call('treasurer', 'POST', '/fundraising/approve-day', { eventId: evId, date: d2 });
    ok(ta2.status === 200, 'Treasurer approves a day the clerk never reached (' + (ta2.json.error || '') + ')');

    ov = await call('treasurer', 'GET', '/fundraising/overview');
    const e2 = ov.json.entries.find(e => e.date === d2);
    ok(e2.status === 'confirmed', 'that day is approved and locked');
    ok(e2.verifiedBy === 'Church Treasurer' && e2.confirmedBy === 'Church Treasurer',
      `both levels stamped in the Treasurer's name: ${e2.verifiedBy} / ${e2.confirmedBy}`);

    // ---- The clerk redeems a pledge ----
    const pledge = ov.json.ious.find(i => i.status !== 'paid');
    const paid = await call('clerk', 'POST', `/fundraising/ious/${pledge.id}/paid`, {});
    ok(paid.status === 200 && paid.json.status === 'paid', 'Accounts Clerk marks a pledge redeemed');

    // ---- Entry rights: both offices can record and correct figures ----
    const d4 = `${year}-10-25`;
    const he = await call('clerk', 'PUT', '/fundraising/entries', {
      eventId: evId, date: d4, service: 'joint',
      categories: { seed: {}, gratitude: 120, chairpersons: 0, dayborn: {} },
      methods: { cash: 120 },
    });
    ok(he.status === 200, 'Accounts Clerk can record and correct figures (' + (he.json.error || '') + ')');
    ok((await call('clerk', 'POST', '/fundraising/submit-day', { eventId: evId, date: d4 })).status === 200, 'Accounts Clerk submits their own day');
    ok((await call('clerk', 'POST', '/fundraising/verify-day', { eventId: evId, date: d4 })).status === 200, 'Accounts Clerk verifies their own day');
    const ca2 = await call('clerk', 'POST', '/fundraising/approve-day', { eventId: evId, date: d4 });
    ok(ca2.status === 403, 'but approval is still the Treasurer\'s — a second person closes the clerk\'s day');

    const d3 = `${year}-10-18`;
    const te = await call('treasurer', 'PUT', '/fundraising/entries', {
      eventId: evId, date: d3, service: 'joint',
      categories: { seed: {}, gratitude: 200, chairpersons: 0, dayborn: {} },
      methods: { cash: 200 },
    });
    ok(te.status === 200, 'Treasurer can record and correct figures (' + (te.json.error || '') + ')');
    ok((await call('treasurer', 'POST', '/fundraising/expenses', { eventId: evId, description: 'Envelopes', amount: 20 })).status === 200,
      'Treasurer can record an expense');

    // Documented consequence of giving the office entry rights: one person can
    // take a day from entry to lock. Asserted so it cannot change unnoticed.
    ok((await call('treasurer', 'POST', '/fundraising/submit-day', { eventId: evId, date: d3 })).status === 200, 'Treasurer submits their own day');
    ok((await call('treasurer', 'POST', '/fundraising/approve-day', { eventId: evId, date: d3 })).status === 200, 'Treasurer closes their own day single-handed');
    ov = await call('treasurer', 'GET', '/fundraising/overview');
    const e3 = ov.json.entries.find(e => e.date === d3);
    ok(e3.status === 'confirmed' && e3.enteredBy === 'Church Treasurer' && e3.verifiedBy === 'Church Treasurer' && e3.confirmedBy === 'Church Treasurer',
      'and the trail shows one name at every stage: ' + [e3.enteredBy, e3.verifiedBy, e3.confirmedBy].join(' / '));
  } catch (err) {
    fails++; console.log('FAIL: threw —', (err && err.stack) || err);
  }
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
  server.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  process.exit(fails ? 1 : 0);
});
