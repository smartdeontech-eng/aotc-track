// The handover, driven through the real HTTP API against a throwaway data
// directory — the seed, the conferral with an induction date, and what the
// minutes and the quarterly report then print either side of it.
//
//   node scripts/test-office-handover-api.js
const os = require('os'), path = require('path'), fs = require('fs'), http = require('http');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aotc-ho-'));
process.env.AOTC_DATA_DIR = DATA;
process.env.TZ = process.env.TZ || 'Africa/Accra';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(64);
process.env.NODE_ENV = 'development';

const bcrypt = require('bcryptjs');
const db = require('./../utils/db');
const app = require('./../server');

let pass = 0, fail = 0;
const check = (what, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? (pass++, console.log(`  ok    ${what}`))
     : (fail++, console.log(`  FAIL  ${what}\n          got:  ${JSON.stringify(got)}\n          want: ${JSON.stringify(want)}`));
};

const OLD = 'Rev Joseph Richmond Tettey';
const NEW = 'Rev Emmanuel Nii Ayi Mensah';
const INDUCTION = '2026-09-14';

db.insert('users', {
  name: 'Clerk', email: 'clerk@test', passwordHash: bcrypt.hashSync('x', 4),
  role: 'admin', permissions: [], sessionVersion: 0,
});

const server = app.listen(0, async () => {
  const port = server.address().port;
  const jwt = require('jsonwebtoken');
  const token = jwt.sign({ id: 1, name: 'Clerk', email: 'clerk@test', role: 'admin', sv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' });

  const call = (method, p, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ port, method, path: '/api' + p, headers: {
      'Content-Type': 'application/json', Cookie: 'token=' + token,
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
    } }, res => { let s = ''; res.on('data', d => s += d); res.on('end', () => {
      try { resolve({ status: res.statusCode, body: s ? JSON.parse(s) : null }); } catch (e) { reject(new Error(s)); }
    }); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });

  try {
    // --- the roster as it stands before the transfer ---
    const a = await call('POST', '/minutes/roster', { name: OLD, office: 'district_minister', kind: 'agent', titles: ['Rev'] });
    const clerk = await call('POST', '/minutes/roster', { name: 'Gideon Adjiereh Adjei', office: 'session_clerk', kind: 'presbyter' });
    check('the outgoing minister is on the roster', a.status, 201);

    // A sitting he chaired, before the handover.
    const m1 = await call('POST', '/minutes', { kind: 'session', date: '2026-06-10', title: 'Session Meeting' });
    check('a June sitting is recorded', m1.status === 201 || m1.status === 200, true);

    // --- 1. back-fill, BEFORE anything changes ---
    check('setting up the roster records no term — that is not a succession',
      (await call('GET', '/minutes/offices/terms')).body.terms.length, 0);
    const seed = await call('POST', '/minutes/offices/seed');
    check('seeding records the current holders', seed.body.created.length, 2);
    const dmTerm = seed.body.created.find(t => t.officeKey === 'district_minister');
    check('the District Minister term is open-ended at both ends', [dmTerm.from, dmTerm.to], [null, null]);
    check('and carries his name', dmTerm.name, OLD);
    check('seeding again creates nothing', (await call('POST', '/minutes/offices/seed')).body.created.length, 0);

    // --- 2. the handover, with the induction date ---
    const nu = await call('POST', '/minutes/roster', { name: NEW, kind: 'agent', titles: ['Rev'] });
    const conf = await call('PUT', '/minutes/roster/' + nu.body.id, { office: 'district_minister', officeFrom: INDUCTION });
    check('the conferral succeeds', conf.status, 200);
    check('it releases the outgoing minister', conf.body.released, OLD);
    check('and reports the term it opened', conf.body.term.from, INDUCTION);
    check('closing the outgoing one on the same day', conf.body.term.closed.to, INDUCTION);

    // --- 3. what the documents now say ---
    const terms = await call('GET', '/minutes/offices/terms?office=district_minister');
    check('two terms are on record', terms.body.terms.length, 2);

    const OT = require('./../utils/officeTerms');
    check('the June sitting still signs with the outgoing minister', OT.nameOn('district_minister', '2026-06-10'), OLD);
    check('a sitting the day before the induction, too', OT.nameOn('district_minister', '2026-09-13'), OLD);
    check('a sitting on the induction day signs with the new minister', OT.nameOn('district_minister', INDUCTION), NEW);

    const cg = require('./../utils/congregationData');
    const q2 = cg.assembleCongregation({ year: 2026, quarter: 2 });
    const q4 = cg.assembleCongregation({ year: 2026, quarter: 4 });
    check('the Q2 report, compiled now, still signs with the outgoing minister', q2.minister, OLD);
    check('the Q4 report signs with the new minister', q4.minister, NEW);
    check('the Session Clerk is unaffected', q4.sessionClerk, 'Gideon Adjiereh Adjei');

    // --- 4. the outgoing minister leaves the Session entirely ---
    await call('PUT', '/minutes/roster/' + a.body.id, { active: false });
    check('his name still prints on the June sitting after he is off the roll',
      OT.nameOn('district_minister', '2026-06-10'), OLD);
    check('and on the Q2 report', cg.assembleCongregation({ year: 2026, quarter: 2 }).minister, OLD);

    // --- 5. the silent failure this guard exists for --------------------------
    // Adding the new minister straight from "Add member" with the office already
    // set, and no date, used to move the roster while leaving the terms alone —
    // so every document went on signing with the outgoing minister, for good.
    const sneak = await call('POST', '/minutes/roster', { name: 'Rev Someone Else', office: 'district_minister', kind: 'agent' });
    check('adding someone into an office that is already held, with no date, is refused', sneak.status, 400);
    check('and the message says whose name is at stake', /currently holds the office/.test(sneak.body.error), true);
    check('nothing moved on the roster', (await call('GET', '/minutes/roster')).body.filter(m => m.office === 'district_minister').length, 1);
    check('and the terms are untouched', (await call('GET', '/minutes/offices/terms?office=district_minister')).body.terms.length, 2);

    // With a date it is a proper succession.
    const ok2 = await call('POST', '/minutes/roster', { name: 'Rev Third Man', office: 'district_minister', kind: 'agent', officeFrom: '2027-01-06' });
    check('the same thing with a date is accepted', ok2.status, 201);
    check('and opens a third term', (await call('GET', '/minutes/offices/terms?office=district_minister')).body.terms.length, 3);
    check('so 2026 still belongs to the second minister', OT.nameOn('district_minister', '2026-12-01'), NEW);
    check('and 2027 to the third', OT.nameOn('district_minister', '2027-02-01'), 'Rev Third Man');

    // A vacant office needs no date — there is nobody to displace.
    check('taking a vacant office needs no date',
      (await call('POST', '/minutes/roster', { name: 'Presbyter K Mensah', office: 'treasurer', kind: 'presbyter' })).status, 201);

    // --- 6. a non-unique office keeps no timeline ---
    const cat = await call('POST', '/minutes/roster', { name: 'Catechist E A Addo', office: 'catechist', kind: 'agent' });
    check('conferring a Catechist records no term (the office has several holders)',
      (await call('GET', '/minutes/offices/terms?office=catechist')).body.terms.length, 0);
  } catch (e) {
    fail++; console.log('  FAIL  threw: ' + e.message);
  }

  server.close(() => {
    fs.rmSync(DATA, { recursive: true, force: true });
    console.log(`\n  ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
});
