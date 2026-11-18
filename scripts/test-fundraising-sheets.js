// Self-contained test of the harvest basket sheets (17 Nov 2026): numbering,
// entering a sheet against its written totals, duplicates, the seed body,
// photos, the day board, the printed sets, and the whole-day form no longer
// overwriting sheets saved at another desk.
//
//   node scripts/test-fundraising-sheets.js
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto');
const APP = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aotc-sheets-'));
process.env.AOTC_DATA_DIR = DATA;
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.NODE_ENV = 'test';
process.chdir(APP);
const bcrypt = require(path.join(APP, 'node_modules', 'bcryptjs'));
const db = require(path.join(APP, 'utils', 'db'));
const PASS = 'Password#12345';
const mk = (email, name) => db.insert('users', {
  name, email, phone: '', passwordHash: bcrypt.hashSync(PASS, 10), role: 'localadmin',
  permissions: ['fundraising.manage', 'fundraising.verify', 'fundraising.approve', 'congregation.view'], entity: { type: 'congregation', id: 0 },
  twoFactorEnabled: false, mustChangePassword: false,
});
mk('desk1@test.com', 'Desk One'); mk('desk2@test.com', 'Desk Two');
const app = require(path.join(APP, 'server.js'));
let fails = 0;
const ok = (c, m) => { if (c) console.log('ok  :', m); else { fails++; console.log('FAIL:', m); } };

const server = app.listen(0, async () => {
  const BASE = `http://127.0.0.1:${server.address().port}/api`;
  const client = () => {
    let cookie = '';
    return async (method, p, body, raw) => {
      const res = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
      if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') };
      let json = null; try { json = await res.json(); } catch (e) {}
      return { status: res.status, json };
    };
  };
  const a = client(), b = client();
  try {
    ok((await a('POST', '/auth/login', { email: 'desk1@test.com', password: PASS })).status === 200, 'desk 1 logs in');
    ok((await b('POST', '/auth/login', { email: 'desk2@test.com', password: PASS })).status === 200, 'desk 2 logs in');
    const year = new Date().getFullYear();
    const ev = (await a('POST', '/fundraising/events', { name: 'Main Harvest', target: 700000, year })).json;
    const date = `${year}-11-29`;
    const q = `eventId=${ev.id}&date=${date}`;

    // ---- Numbering
    let board = (await a('GET', `/fundraising/sheets?${q}&services=dual`)).json;
    ok(board.rows.length === 20 && board.services.join() === '1st,2nd', 'a dual day has 20 sheets (10 per service)');
    ok(board.rows[0].no === 1 && board.rows[0].label === 'Sunday-borns' && board.rows[0].service === '1st', 'sheet 01 is 1st-service Sunday-borns');
    ok(board.rows[10].no === 11 && board.rows[10].service === '2nd' && board.rows[10].label === 'Sunday-borns', 'sheet 11 is 2nd-service Sunday-borns (numbers run through the day)');
    ok(board.rows[9].key === 'seed' && board.rows[9].label === 'Seed contributions', 'one seed sheet per service');
    ok(board.rows.every(r => r.status === 'missing'), 'nothing entered yet');

    // ---- The printed set
    const pdf = await a('GET', `/fundraising/basket-sheets.pdf?${q}&services=dual`, null, true);
    ok(pdf.status === 200 && /pdf/.test(pdf.type) && pdf.buf.slice(0, 4).toString() === '%PDF', 'basket sheets print as a PDF');
    const pages = (pdf.buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    ok(pages === 22, `20 sheets + 2 tick lists = 22 pages (got ${pages})`);
    fs.writeFileSync(path.join(DATA, 'sheets.pdf'), pdf.buf);

    // ---- Enter sheet 01 (Sunday-borns, 1st)
    const cashCount = { n200: 10, n50: 7, n2: 3, c50: 2 };   // 2000 + 350 + 6 + 1 = 2357
    const base = { eventId: ev.id, date, services: 'dual', cashCount, writtenCash: 2357,
      momo: [{ name: '024xxxxxxx', reference: 'MP123', amount: 150 }],
      cheques: [{ number: '000771', bank: 'GCB', amount: 500 }],
      ious: [{ name: 'Elder K', contact: '0240000000', amount: 1000, dueDate: `${year}-12-31` }] };
    let r = await a('PUT', '/fundraising/sheets/1', { ...base, writtenTotal: 4000 });
    ok(r.status === 400 && r.json.field === 'total' && r.json.counted === 4007, 'a wrong written total is refused, with what was typed (4007)');
    r = await a('PUT', '/fundraising/sheets/1', { ...base, writtenCash: 2350, writtenTotal: 4007 });
    ok(r.status === 400 && r.json.field === 'cash', 'cash that does not agree with the pieces is refused');
    r = await a('PUT', '/fundraising/sheets/1', { ...base, writtenTotal: 4007 });
    ok(r.status === 200 && r.json.total === 4007 && r.json.label === 'Sunday-borns', 'sheet 01 saves when it agrees (' + (r.json && r.json.error || '') + ')');

    // ---- Another desk, another sheet, same service, at the same time
    const [r2, r3] = await Promise.all([
      b('PUT', '/fundraising/sheets/2', { eventId: ev.id, date, services: 'dual', cashCount: { n100: 5 }, writtenCash: 500, writtenTotal: 500 }),
      a('PUT', '/fundraising/sheets/8', { eventId: ev.id, date, services: 'dual', cashCount: { n20: 25 }, transfers: [{ bank: 'Stanbic', reference: 'T1', amount: 1000 }], writtenTotal: 1500 }),
    ]);
    ok(r2.status === 200 && r3.status === 200, 'two desks save two sheets at once');
    let e1 = db.findOne('fundraising_entries', e => e.date === date && e.service === '1st');
    ok(e1.categories.dayborn.Sunday === 4007 && e1.categories.dayborn.Monday === 500 && e1.categories.gratitude === 1500, 'all three baskets are on the 1st-service entry — nothing overwritten');
    ok(e1.catMethods['dayborn.Sunday'].momo === 150 && e1.sheets['dayborn.Sunday'].momo[0].reference === 'MP123', 'MoMo rows are kept and summed');
    ok(db.findAll('fundraising_ious', i => i.entryId === e1.id).length === 1, 'the pledge is on the IOU register (reminders)');

    // ---- Duplicates
    r = await b('PUT', '/fundraising/sheets/1', { ...base, writtenTotal: 4007 });
    ok(r.status === 409 && /Desk One/.test(r.json.error), 'the same sheet entered again is stopped, naming who entered it');
    r = await b('PUT', '/fundraising/sheets/1', { ...base, cashCount: { ...cashCount, n200: 11 }, writtenCash: 2557, writtenTotal: 4207, replace: true });
    ok(r.status === 200 && r.json.total === 4207, 'it can be replaced on purpose');
    e1 = db.findOne('fundraising_entries', e => e.date === date && e.service === '1st');
    ok(e1.categories.dayborn.Sunday === 4207 && db.findAll('fundraising_ious', i => i.entryId === e1.id).length === 1, 'replacing does not double the pledge');

    // ---- Sheet arithmetic wrong on paper: corrected with a note
    r = await a('PUT', '/fundraising/sheets/3', { eventId: ev.id, date, services: 'dual', cashCount: { n10: 9 }, writtenCash: 100, writtenTotal: 100, corrected: true });
    ok(r.status === 400 && /what was wrong/i.test(r.json.error), 'a corrected sheet needs a note');
    r = await a('PUT', '/fundraising/sheets/3', { eventId: ev.id, date, services: 'dual', cashCount: { n10: 9 }, writtenCash: 100, writtenTotal: 100, corrected: true, note: 'Counters added 9 x 10 as 100; recounted: 90' });
    ok(r.status === 200 && r.json.total === 90, 'saved with the typed figure and the note on the trail');

    // ---- Seed: one sheet, the desk chooses the body
    r = await a('PUT', '/fundraising/sheets/10', { eventId: ev.id, date, services: 'dual', cheques: [{ number: '9001', bank: 'Ecobank', amount: 20000 }], writtenTotal: 20000 });
    ok(r.status === 400 && /which body/i.test(r.json.error), 'seed sheet asks which body');
    r = await a('PUT', '/fundraising/sheets/10', { eventId: ev.id, date, services: 'dual', seedBody: 'Session', cheques: [{ number: '9001', bank: 'Ecobank', amount: 20000 }], writtenTotal: 20000 });
    ok(r.status === 200 && r.json.label === 'Seed — Session', 'seed booked to Session');
    r = await a('PUT', '/fundraising/sheets/10', { eventId: ev.id, date, services: 'dual', seedBody: 'Harvest Committee', cheques: [{ number: '9001', bank: 'Ecobank', amount: 20000 }], writtenTotal: 20000, replace: true });
    e1 = db.findOne('fundraising_entries', e => e.date === date && e.service === '1st');
    ok(r.status === 200 && e1.categories.seed['Harvest Committee'] === 20000 && !e1.categories.seed.Session && !e1.catMethods['seed.Session'], 'moving the seed sheet to another body leaves nothing behind');

    // ---- Wrong numbers
    r = await a('PUT', '/fundraising/sheets/21', { eventId: ev.id, date, services: 'dual', cashCount: { n10: 1 }, writtenTotal: 10 });
    ok(r.status === 400 && /01 to 20/.test(r.json.error), 'sheet 21 is not one of the day\'s sheets');
    r = await a('PUT', '/fundraising/sheets/4', { eventId: ev.id, date, services: 'dual', cashCount: {}, writtenTotal: 0 });
    ok(r.status === 400, 'an empty sheet is refused');
    r = await a('PUT', '/fundraising/sheets/4', { eventId: ev.id, date, services: 'dual', cashCount: { n5: 2 } });
    ok(r.status === 400 && /BASKET TOTAL/.test(r.json.error), 'the written basket total is required');

    // ---- Foreign notes: a typed rate becomes the day's rate; a clash is refused
    r = await a('PUT', '/fundraising/sheets/12', { eventId: ev.id, date, services: 'dual', forex: [{ currency: 'usd', amount: 100, rate: 15 }], writtenTotal: 1500 });
    ok(r.status === 200 && r.json.total === 1500, '2nd-service sheet with USD 100 at 15 = GHS 1500');
    r = await a('PUT', '/fundraising/sheets/13', { eventId: ev.id, date, services: 'dual', forex: [{ currency: 'USD', amount: 10, rate: 14 }], writtenTotal: 140 });
    ok(r.status === 400 && /already 15/.test(r.json.error), 'a second rate for USD on the same day is refused (' + r.status + ' ' + JSON.stringify(r.json) + ')');

    // ---- Photos
    const png = 'data:image/png;base64,' + fs.readFileSync(path.join(APP, 'public', 'img', 'logo-icon.png')).toString('base64');
    r = await b('POST', '/fundraising/sheets/5/photo', { eventId: ev.id, date, services: 'dual', image: png });
    ok(r.status === 200 && r.json.photoId, 'a photo of sheet 05 is sent');
    board = (await a('GET', `/fundraising/sheets?${q}`)).json;
    ok(board.rows.find(x => x.no === 5).status === 'photo', 'the board shows sheet 05 as "photo received"');
    const img = await a('GET', '/fundraising/sheet-photo/' + r.json.photoId, null, true);
    ok(img.status === 200 && /image/.test(img.type), 'the photo can be opened by the desk');
    ok(!fs.existsSync(path.join(APP, 'public', 'uploads', r.json.photoId)), 'and is not kept in public/');
    r = await a('PUT', '/fundraising/sheets/5', { eventId: ev.id, date, services: 'dual', cashCount: { n1: 40 }, writtenTotal: 40 });
    board = (await a('GET', `/fundraising/sheets?${q}`)).json;
    const s5 = board.rows.find(x => x.no === 5);
    ok(s5.status === 'entered' && s5.photoId, 'typed from the photo: entered, photo still attached');
    const bad = await a('POST', '/fundraising/sheets/6/photo', { eventId: ev.id, date, services: 'dual', image: 'data:text/html;base64,PGgxPg==' });
    ok(bad.status === 400, 'anything that is not an image is refused');
    const trav = await a('GET', '/fundraising/sheet-photo/..%2F..%2Fetc%2Fpasswd', null, true);
    ok(trav.status === 400 || trav.status === 404, 'photo ids cannot walk out of the folder');

    // ---- The board
    ok(board.entered === 7 && board.total === 20, `board: 7 of 20 entered (got ${board.entered})`);
    ok(board.dayTotal === r2v(4207 + 500 + 1500 + 90 + 20000 + 40 + 1500), `board day total ${board.dayTotal}`);
    ok(board.cashCount.n200 === 11 && board.cashCounted > 0, 'board carries the cash by denomination');

    // ---- Day summary / cash handover
    const sum = await a('GET', `/fundraising/day-summary.pdf?${q}`, null, true);
    ok(sum.status === 200 && sum.buf.slice(0, 4).toString() === '%PDF', 'day summary + cash handover prints');
    fs.writeFileSync(path.join(DATA, 'summary.pdf'), sum.buf);

    // ---- The whole-day form cannot overwrite sheets saved since it was opened
    const stale = db.findOne('fundraising_entries', e => e.date === date && e.service === '2nd');
    const token = stale.updatedAt || stale.createdAt;
    await b('PUT', '/fundraising/sheets/14', { eventId: ev.id, date, services: 'dual', cashCount: { n50: 2 }, writtenTotal: 100 });
    r = await a('PUT', '/fundraising/entries', { eventId: ev.id, date, service: '2nd', baseUpdatedAt: token,
      categories: { seed: {}, gratitude: 0, chairpersons: 0, dayborn: { Sunday: 0, Monday: 0, Tuesday: 0, Wednesday: 0, Thursday: 0, Friday: 0, Saturday: 0 } } });
    ok(r.status === 409 && /someone else/.test(r.json.error), 'whole-day save with an old form is stopped (409)');
    const after = db.findOne('fundraising_entries', e => e.date === date && e.service === '2nd');
    ok(after.categories.dayborn.Wednesday === 100 && after.forexGhs === 1500, 'and the sheets saved at the other desk are intact');

    // ---- Submit: the day reconciles because every sheet balanced on its own
    const sub = await a('POST', '/fundraising/submit-day', { eventId: ev.id, date });
    ok(sub.status === 200, 'the day submits for verification (' + (sub.json && sub.json.error || '') + ')');
    r = await a('PUT', '/fundraising/sheets/15', { eventId: ev.id, date, services: 'dual', cashCount: { n50: 2 }, writtenTotal: 100 });
    ok(r.status === 200, 'still editable while only submitted (pending)');
    await a('POST', '/fundraising/verify-day', { eventId: ev.id, date });
    r = await b('PUT', '/fundraising/sheets/16', { eventId: ev.id, date, services: 'dual', cashCount: { n50: 2 }, writtenTotal: 100 });
    ok(r.status === 423, 'once verified, sheets are locked');
  } catch (e) { fails++; console.log('FAIL: threw', e.stack); }
  console.log(fails ? `\n${fails} FAILED` : '\nall passed'); console.log('data:', DATA);
  server.close(); process.exit(fails ? 1 : 0);
});
function r2v(v) { return Math.round(v * 100) / 100; }
