// Self-contained test of the harvest breakdown features: seed contributions
// (with configurable sub-categories), the cash denomination counting sheet,
// itemised cheques (number + bank) and bank transfers (bank + reference).
//
//   node scripts/test-fundraising-breakdown.js
//
// It boots the real Express app against a throwaway data directory, so it
// needs no running server and never touches the live records.
const os = require('os'), path = require('path'), fs = require('fs'), crypto = require('crypto');
const APP = path.join(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'aotc-fr-'));
process.env.AOTC_DATA_DIR = DATA;
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
process.env.NODE_ENV = 'test';
process.chdir(APP);

const bcrypt = require(path.join(APP, 'node_modules', 'bcryptjs'));
const db = require(path.join(APP, 'utils', 'db'));
const PASS = 'Password#12345';
db.insert('users', {
  name: 'Test Harvest Admin', email: 'fr@test.com', phone: '',
  passwordHash: bcrypt.hashSync(PASS, 10),
  role: 'localadmin', permissions: ['fundraising.manage', 'fundraising.verify', 'fundraising.approve', 'congregation.view'], entity: { type: 'congregation', id: 0 },
  twoFactorEnabled: false, mustChangePassword: false,
});

const app = require(path.join(APP, 'server.js'));
let fails = 0;
const ok = (cond, msg) => { if (cond) console.log('ok  :', msg); else { fails++; console.log('FAIL:', msg); } };

const server = app.listen(0, async () => {
  const BASE = `http://127.0.0.1:${server.address().port}/api`;
  let cookie = '';
  const call = async (method, p, body, raw) => {
    const res = await fetch(BASE + p, {
      method, headers: { 'Content-Type': 'application/json', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    if (raw) return { status: res.status, buf: Buffer.from(await res.arrayBuffer()) };
    let json = null; try { json = await res.json(); } catch (e) {}
    return { status: res.status, json };
  };

  try {
    const login = await call('POST', '/auth/login', { email: 'fr@test.com', password: PASS });
    ok(login.status === 200, 'login (' + login.status + ' ' + JSON.stringify(login.json).slice(0, 120) + ')');

    const year = new Date().getFullYear();
    const ev = await call('POST', '/fundraising/events', { name: 'Main Harvest', target: 100000, year });
    ok(ev.status === 200 && ev.json.id, 'create event');
    const evId = ev.json.id;

    let ov = await call('GET', '/fundraising/overview?year=' + year);
    ok(ov.json.seedCategories && ov.json.seedCategories.length === 3, 'overview ships 3 default seed sub-categories');
    ok((ov.json.denominations || []).length === 15, 'overview ships 15 cedi denominations');

    const sc = await call('PUT', '/fundraising/seed-categories', { year, categories: ['Harvest Committee', 'Session', 'Congregation', "Men's Fellowship"] });
    ok(sc.status === 200 && sc.json.seedCategories.length === 4, 'add a seed sub-category');

    const categories = {
      seed: { 'Harvest Committee': 5000, Session: 3000, Congregation: 2000 },
      gratitude: 1000, chairpersons: 500,
      dayborn: { Sunday: 700, Monday: 300, Tuesday: 0, Wednesday: 900, Thursday: 100, Friday: 250, Saturday: 250 },
    };
    const cashCount = { n200: 30, n50: 20, c50: 4 };           // 6000 + 1000 + 2.00 = 7002
    const cheques = [{ number: '000123', bank: 'GCB', amount: 3000 }, { number: '000124', bank: 'Ecobank', amount: 1998 }];
    const transfers = [{ bank: 'Stanbic', reference: 'TRF-99881', amount: 2000 }];

    const bad = await call('PUT', '/fundraising/entries', {
      eventId: evId, date: `${year}-08-02`, service: 'joint', categories, cashCount, cheques,
      transfers: [{ bank: 'Stanbic', reference: 'TRF-99881', amount: 1500 }],
    });
    ok(bad.status === 400 && /reconcile/i.test(bad.json.error || ''), 'short transfer fails reconciliation');

    const good = await call('PUT', '/fundraising/entries', {
      eventId: evId, date: `${year}-08-02`, service: 'joint', categories, cashCount, cheques, transfers,
    });
    ok(good.status === 200, 'entry saves when it reconciles (' + (good.json.error || '') + ')');
    const e = good.json || {};
    ok(e.total === 14000, 'total includes seed: ' + e.total + ' (expected 14000)');
    ok((e.categories.seed || {})['Harvest Committee'] === 5000, 'seed sub-category stored');
    ok(e.methods.cash === 7002, 'cash computed from the denomination count: ' + e.methods.cash);
    ok(e.cashCounted === 7002, 'cashCounted recorded: ' + e.cashCounted);
    ok(e.methods.cheque === 4998, 'cheque total from rows: ' + e.methods.cheque);
    ok(e.methods.transfer === 2000, 'transfer total from rows: ' + e.methods.transfer);
    ok((e.cheques || []).length === 2 && e.cheques[0].number === '000123', 'cheque rows kept with number + bank');
    ok((e.transfers || []).length === 1 && e.transfers[0].reference === 'TRF-99881', 'transfer rows kept with bank + reference');
    ok(e.ghsSubtotal === 14000, 'ghsSubtotal includes transfers: ' + e.ghsSubtotal);

    const noNum = await call('PUT', '/fundraising/entries', {
      eventId: evId, date: `${year}-08-09`, service: 'joint',
      categories: { seed: {}, gratitude: 100, chairpersons: 0, dayborn: {} },
      cheques: [{ number: '', bank: 'GCB', amount: 100 }],
    });
    ok(noNum.status === 400 && /cheque number/i.test(noNum.json.error || ''), 'cheque without a number is rejected');

    const noBank = await call('PUT', '/fundraising/entries', {
      eventId: evId, date: `${year}-08-09`, service: 'joint',
      categories: { seed: {}, gratitude: 100, chairpersons: 0, dayborn: {} },
      transfers: [{ bank: '', reference: 'X1', amount: 100 }],
    });
    ok(noBank.status === 400 && /no bank/i.test(noBank.json.error || ''), 'bank transfer without a bank is rejected');

    // ---- Per-basket breakdowns ----
    // Sunday-borns counted on its own (cash + a cheque), Gratitude on its own
    // (MoMo + a transfer); everything else typed and covered service-level.
    const catMethods = {
      'dayborn.Sunday': { cashCount: { n50: 10 }, cheques: [{ number: 'SB-01', bank: 'GCB', amount: 200 }] },   // 500 + 200 = 700
      gratitude: { momo: 400, transfers: [{ bank: 'Fidelity', reference: 'GT-77', amount: 600 }] },              // 400 + 600 = 1000
    };
    const day2 = {
      eventId: evId, date: `${year}-08-16`, service: 'joint',
      categories: {
        seed: { 'Harvest Committee': 5000, Session: 3000, Congregation: 2000 },
        gratitude: 999999,          // ignored — the breakdown owns this basket
        chairpersons: 500,
        dayborn: { Sunday: 999999, Monday: 300, Tuesday: 0, Wednesday: 900, Thursday: 100, Friday: 250, Saturday: 250 },
      },
      catMethods,
      cashCount: { n200: 50 },                                                    // 10,000 service-level
      cheques: [{ number: '000200', bank: 'GCB', amount: 1300 }],
      transfers: [{ bank: 'Stanbic', reference: 'TRF-500', amount: 1000 }],
    };
    const r2res = await call('PUT', '/fundraising/entries', day2);
    ok(r2res.status === 200, 'day with per-basket breakdowns saves (' + (r2res.json.error || '') + ')');
    const b = r2res.json || {};
    ok((b.categories.dayborn || {}).Sunday === 700, 'breakdown overrides the typed Sunday figure: ' + (b.categories.dayborn || {}).Sunday);
    ok(b.categories.gratitude === 1000, 'breakdown overrides the typed Gratitude figure: ' + b.categories.gratitude);
    ok(b.total === 14000, 'day total with mixed entry: ' + b.total);
    ok(b.methods.cash === 10500, 'combined cash (service 10,000 + basket 500): ' + b.methods.cash);
    ok(b.methods.momo === 400, 'combined MoMo: ' + b.methods.momo);
    ok(b.methods.cheque === 1500, 'combined cheques (1,300 + 200): ' + b.methods.cheque);
    ok(b.methods.transfer === 1600, 'combined transfers (1,000 + 600): ' + b.methods.transfer);
    ok(b.methodsDirect.cash === 10000, 'service-level cash kept separately: ' + b.methodsDirect.cash);
    ok(b.cashCount.n200 === 50 && b.cashCount.n50 === 10, 'denomination counts merged across baskets');
    ok(b.cheques.length === 2 && b.cheques.some(c => c.category === 'Sunday-borns'), 'cheques tagged with their basket');
    ok(b.transfers.length === 2 && b.transfers.some(t => t.category === 'Gratitude & Thanksgiving'), 'transfers tagged with their basket');
    ok((b.catMethods['dayborn.Sunday'] || {}).total === 700, 'basket breakdown stored');

    const bdBad = await call('PUT', '/fundraising/entries', {
      ...day2, date: `${year}-08-23`,
      catMethods: { 'dayborn.Monday': { cheques: [{ number: '', bank: 'GCB', amount: 50 }] } },
    });
    ok(bdBad.status === 400 && /Monday-borns/.test(bdBad.json.error || ''), 'a numberless cheque inside a basket names that basket: ' + (bdBad.json.error || '').slice(0, 90));

    // ---- Day rates, foreign notes and pledges inside a basket ----
    const day3 = {
      eventId: evId, date: `${year}-09-06`, service: 'joint',
      rates: [{ currency: 'USD', rate: 15 }],
      categories: {
        seed: { 'Harvest Committee': 111, Session: 3000, Congregation: 2000 },
        gratitude: 1000, chairpersons: 500,
        dayborn: { Sunday: 700, Monday: 300, Tuesday: 0, Wednesday: 900, Thursday: 100, Friday: 250, Saturday: 250 },
      },
      catMethods: {
        'seed.Harvest Committee': {
          forex: [{ currency: 'USD', amount: 100 }],                                  // 100 x 15 = 1,500
          ious: [{ name: 'Elder Mensah', contact: '0244000000', amount: 500, dueDate: `${year}-12-01` }],
        },
      },
      methods: { cash: 9000 },
    };
    const r3 = await call('PUT', '/fundraising/entries', day3);
    ok(r3.status === 200, 'day with rates, basket forex and a basket pledge saves (' + (r3.json.error || '') + ')');
    const c3 = r3.json || {};
    ok((c3.categories.seed || {})['Harvest Committee'] === 2000, 'basket forex + pledge become its amount: ' + (c3.categories.seed || {})['Harvest Committee']);
    ok(c3.total === 11000, 'day total: ' + c3.total);
    ok((c3.rates || [])[0] && c3.rates[0].currency === 'USD' && c3.rates[0].rate === 15, 'the day rate is stored on the entry');
    ok(c3.forexGhs === 1500, 'foreign converted at the day rate: ' + c3.forexGhs);
    ok((c3.forex || [])[0] && c3.forex[0].rate === 15 && c3.forex[0].category === 'Seed — Harvest Committee', 'forex row carries the day rate and its basket');
    ok(c3.iouTotal === 500, 'basket pledge counted: ' + c3.iouTotal);
    ok((c3.catMethods['seed.Harvest Committee'] || {}).total === 2000, 'basket breakdown total');

    const ovIou = await call('GET', '/fundraising/overview?year=' + year);
    const pledge = (ovIou.json.ious || []).find(i => i.name === 'Elder Mensah');
    ok(pledge && pledge.category === 'Seed — Harvest Committee', 'the register knows which basket the pledge came from');

    const noRate = await call('PUT', '/fundraising/entries', {
      ...day3, date: `${year}-09-13`,
      catMethods: { gratitude: { forex: [{ currency: 'GBP', amount: 50 }] } },
    });
    ok(noRate.status === 400 && /No exchange rate for GBP/.test(noRate.json.error || ''), 'foreign money with no rate for the day is refused: ' + (noRate.json.error || '').slice(0, 80));

    const drop = await call('PUT', '/fundraising/seed-categories', { year, categories: ['Session', 'Congregation'] });
    ok(drop.status === 400 && /Harvest Committee/.test(drop.json.error || ''), 'cannot drop a seed sub-category that carries figures');

    const ann = await call('GET', `/fundraising/announcement.pdf?eventId=${evId}&date=${year}-08-02`, null, true);
    ok(ann.status === 200 && ann.buf.slice(0, 4).toString() === '%PDF', 'announcement PDF renders (' + ann.buf.length + ' bytes)');
    const st = await call('GET', '/fundraising/statement.pdf?year=' + year, null, true);
    ok(st.status === 200 && st.buf.slice(0, 4).toString() === '%PDF', 'statement PDF renders (' + st.buf.length + ' bytes)');

    ov = await call('GET', '/fundraising/overview?year=' + year);
    ok(ov.json.totalRaised === 39000, 'overview totalRaised across all three days: ' + ov.json.totalRaised);
    if (process.env.KEEP_PDFS) {
      const out = path.resolve(process.env.KEEP_PDFS);
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, 'fundraising-announcement-sample.pdf'), ann.buf);
      fs.writeFileSync(path.join(out, 'fundraising-statement-sample.pdf'), st.buf);
      console.log('    sample PDFs written to', out);
    }

    // ---- Saving one basket at a time ------------------------------------
    // The counting happens basket by basket, so each one is saved and answered
    // for on its own. Everything already on the day must survive each merge.
    console.log('\n-- one basket at a time --');
    const D2 = `${year}-11-15`;
    const putB = (key, body) => call('PUT', '/fundraising/entries/basket',
      { eventId: evId, date: D2, service: 'joint', key, ...body });

    // Gratitude, counted in its own panel: cash + a cheque.
    let bk = await putB('gratitude', {
      breakdown: { cash: 4000, momo: 0, cheques: [{ number: '000123', bank: 'GCB', amount: 1000 }] },
    });
    ok(bk.status === 200, 'save the Gratitude basket (' + bk.status + ' ' + JSON.stringify(bk.json).slice(0, 140) + ')');
    ok(bk.json.basket.counted === true, 'it is reported as counted');
    ok(bk.json.basket.amount === 5000, 'its figure is its breakdown total: ' + bk.json.basket.amount);
    ok(bk.json.basket.reconciles === true, 'and the basket reconciles on its own');
    ok(bk.json.day.countedBaskets === 1, 'the day says 1 basket counted');

    // Monday-borns next. Gratitude must still be there afterwards.
    bk = await putB('dayborn.Monday', { breakdown: { cash: 2500, momo: 500 } });
    ok(bk.status === 200, 'save Monday-borns');
    ok(bk.json.basket.amount === 3000, 'Monday total: ' + bk.json.basket.amount);
    ok(bk.json.day.countedBaskets === 2, 'two baskets counted now');
    ok(bk.json.entry.categories.gratitude === 5000, 'saving Monday did NOT drop Gratitude');
    ok((bk.json.entry.catMethods['gratitude'] || {}).total === 5000, 'and Gratitude keeps its own breakdown');
    ok(bk.json.entry.cheques.some(c => c.number === '000123' && c.category === 'Gratitude & Thanksgiving'),
      'the Gratitude cheque is still on the register, labelled with its basket');

    // Tuesday, then Chairpersons typed with no breakdown.
    bk = await putB('dayborn.Tuesday', { breakdown: { cash: 1200 } });
    ok(bk.json.basket.amount === 1200, 'Tuesday total: ' + bk.json.basket.amount);
    bk = await putB('chairpersons', { amount: 7000 });
    ok(bk.status === 200, 'save the Chairpersons figure with no breakdown');
    ok(bk.json.basket.counted === false, 'it is reported as NOT counted');
    ok(bk.json.basket.reconciles === null, 'so there is no verdict at this grain — it is covered at service level');
    ok(bk.json.basket.amount === 7000, 'but the figure is stored: ' + bk.json.basket.amount);
    ok(bk.json.day.countedBaskets === 3, 'still three counted baskets');
    ok(bk.json.day.basketsWithFigures === 4, 'four baskets now carry a figure');

    // The day does not balance yet — the typed Chairpersons has no method
    // behind it — and that must NOT block the per-basket save.
    ok(bk.json.day.balances === false, 'the day does not balance yet, and saying so is not an error');
    ok(Math.abs(bk.json.day.diff - 7000) < 0.01, 'it is short by exactly the typed figure: ' + bk.json.day.diff);

    // And it must block SUBMIT.
    let subm = await call('POST', '/fundraising/submit-day', { eventId: evId, date: D2 });
    ok(subm.status === 400, 'submitting an unbalanced day is refused (' + subm.status + ')');
    ok(/does not reconcile yet/.test((subm.json || {}).error || ''), 'and says why: ' + ((subm.json || {}).error || '').slice(0, 100));
    ok(Array.isArray((subm.json || {}).unreconciled) && subm.json.unreconciled.length === 1,
      'naming the service that is out');

    // Cover the typed basket at service level, then it balances and submits.
    bk = await putB('chairpersons', { amount: 7000 });
    let cover = await call('PUT', '/fundraising/entries', {
      eventId: evId, date: D2, service: 'joint',
      categories: bk.json.entry.categories,
      catMethods: bk.json.entry.catMethods,
      methods: { cash: 7000 },
      rates: bk.json.entry.rates,
    });
    ok(cover.status === 200, 'the whole-day save still works, and still enforces reconciliation (' + cover.status + ')');
    subm = await call('POST', '/fundraising/submit-day', { eventId: evId, date: D2 });
    ok(subm.status === 200, 'a balanced day submits (' + subm.status + ' ' + JSON.stringify(subm.json).slice(0, 80) + ')');

    // Guards.
    const badKey = await putB('dayborn.Someday', { breakdown: { cash: 1 } });
    ok(badKey.status === 400, 'an unknown basket key is refused');
    const D3 = `${year}-11-22`;
    const clash = await call('PUT', '/fundraising/entries/basket',
      { eventId: evId, date: D2, service: '1st', key: 'gratitude', breakdown: { cash: 5 } });
    ok(clash.status === 400 && /joint entry/.test((clash.json || {}).error || ''),
      'a 1st-service basket on a joint day is refused');
    // A basket save on a day in the pipeline is locked out for non-admins; this
    // user is a localadmin, so it is allowed — assert it is at least not a 500.
    const afterSubmit = await putB('gratitude', { breakdown: { cash: 4000, momo: 0, cheques: [{ number: '000123', bank: 'GCB', amount: 1000 }] } });
    ok(afterSubmit.status === 200 || afterSubmit.status === 423,
      'a basket save on a submitted day is either allowed for admins or locked, never a crash (' + afterSubmit.status + ')');

    // Clearing a breakdown by sending an amount instead.
    bk = await putB('dayborn.Tuesday', { amount: 999 });
    ok(bk.json.basket.counted === false && bk.json.basket.amount === 999,
      'sending an amount clears the breakdown and types the figure: ' + bk.json.basket.amount);
    ok(!(bk.json.entry.catMethods || {})['dayborn.Tuesday'], 'the basket breakdown is gone');
    ok((bk.json.entry.catMethods || {})['gratitude'], 'and the other baskets are untouched');


    // ---- The counting sheet -------------------------------------------
    console.log('\n-- the counting sheet --');
    const csBlank = await call('GET', '/fundraising/counting-sheet.pdf?year=' + year, null, true);
    ok(csBlank.status === 200 && csBlank.buf.length > 4000,
      'a blank pad prints with nothing saved at all (' + csBlank.status + ', ' + csBlank.buf.length + ' bytes)');
    const csDay = await call('GET', `/fundraising/counting-sheet.pdf?eventId=${evId}&date=${year}-12-06`, null, true);
    ok(csDay.status === 200 && csDay.buf.length > 4000, 'and for a day with no entries yet — which is the point');
    const csBad = await call('GET', '/fundraising/counting-sheet.pdf?eventId=999999', null, true);
    ok(csBad.status === 404, 'an unknown event is refused (' + csBad.status + ')');

    // It must follow the CONFIGURED baskets, not a hardcoded list — a sheet with
    // nowhere to write a basket is how a basket goes unrecorded.
    await call('PUT', '/fundraising/seed-categories',
      { year, categories: ['Harvest Committee', 'Session', 'Congregation', 'Men\u2019s Fellowship'] });
    const csNew = await call('GET', '/fundraising/counting-sheet.pdf?year=' + year, null, true);
    ok(csNew.status === 200, 'it still prints after a seed sub-category is added');
    ok(csNew.buf.length > csBlank.buf.length,
      'and the sheet grew, so the new giving body has a row: ' + csBlank.buf.length + ' -> ' + csNew.buf.length);


    // ---- Harvest week activities ----------------------------------------
    // A fifth giving area: what the week's own activities raise. Neither the
    // Sunday offering nor the seed, so it is counted and reported on its own.
    console.log('\n-- harvest week activities --');
    let ac = await call('GET', '/fundraising/overview?year=' + year);
    ok(Array.isArray(ac.json.activityCategories) && ac.json.activityCategories.length === 0,
      'a year starts with NO activities — an empty list is normal here, unlike seed');

    let setA = await call('PUT', '/fundraising/activity-categories',
      { year, categories: ['Health Walk', 'Bazaar', 'Games Night'] });
    ok(setA.status === 200 && setA.json.activityCategories.length === 3, 'three activities configured');
    ac = await call('GET', '/fundraising/overview?year=' + year);
    ok((ac.json.activityCategories || []).join('|') === 'Health Walk|Bazaar|Games Night',
      'and the overview ships them to the browser');

    const DA = `${year}-10-04`;
    // Counted like any other basket, through the per-basket route.
    let ab = await call('PUT', '/fundraising/entries/basket',
      { eventId: evId, date: DA, service: 'joint', key: 'activity.Health Walk',
        breakdown: { cash: 3200, momo: 800 } });
    ok(ab.status === 200, 'an activity basket saves (' + ab.status + ' ' + JSON.stringify(ab.json).slice(0, 120) + ')');
    ok(ab.json.basket.amount === 4000, 'its figure is its breakdown total: ' + ab.json.basket.amount);
    ok(ab.json.basket.reconciles === true, 'and it reconciles on its own like any basket');
    ok(ab.json.label === 'Harvest Week — Health Walk', 'labelled as a harvest week activity: ' + ab.json.label);

    ab = await call('PUT', '/fundraising/entries/basket',
      { eventId: evId, date: DA, service: 'joint', key: 'activity.Bazaar', amount: 1500 });
    ok(ab.json.basket.amount === 1500, 'a typed activity is stored: ' + ab.json.basket.amount);
    ok(ab.json.entry.categories.activities['Health Walk'] === 4000, 'and the first activity survived the merge');
    ok(ab.json.entry.total === 5500, 'activities count into the entry total: ' + ab.json.entry.total);

    // It must be a genuine basket key — the same guard the others get.
    const badAct = await call('PUT', '/fundraising/entries/basket',
      { eventId: evId, date: DA, service: 'joint', key: 'activity.Not Configured', breakdown: { cash: 5 } });
    ok(badAct.status === 400, 'an activity that is not on the list is refused (' + badAct.status + ')');

    // The whole-day save carries them, and the total still reconciles.
    const wd = await call('PUT', '/fundraising/entries', {
      eventId: evId, date: DA, service: 'joint',
      categories: { seed: {}, gratitude: 0, chairpersons: 0, dayborn: {},
        activities: { 'Health Walk': 4000, Bazaar: 1500, 'Games Night': 0 } },
      methods: { cash: 5500 },
    });
    ok(wd.status === 200, 'the whole-day save takes activities too (' + wd.status + ')');
    ok(wd.json.total === 5500, 'and totals them: ' + wd.json.total);

    // Removing a name that carries figures must be refused, as with seed.
    const dropA = await call('PUT', '/fundraising/activity-categories',
      { year, categories: ['Bazaar', 'Games Night'] });
    ok(dropA.status === 400 && /Health Walk/.test((dropA.json || {}).error || ''),
      'an activity carrying figures cannot be dropped: ' + ((dropA.json || {}).error || '').slice(0, 80));

    // Emptying the list entirely is allowed once nothing carries figures.
    const emptyOk = await call('PUT', '/fundraising/activity-categories', { year: year - 1, categories: [] });
    ok(emptyOk.status === 200 && emptyOk.json.activityCategories.length === 0,
      'and a year with no activities can be set empty');

    // The reports carry them.
    const annA = await call('GET', `/fundraising/announcement.pdf?eventId=${evId}&date=${DA}`, null, true);
    ok(annA.status === 200 && annA.buf.length > 4000, 'the announcement builds with an activities area');
    const csA = await call('GET', '/fundraising/counting-sheet.pdf?year=' + year, null, true);
    ok(csA.status === 200, 'and the counting sheet has rows to write them on');

  } catch (err) {
    fails++; console.log('FAIL: threw —', err && err.stack || err);
  }
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL PASS');
  server.close();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
  process.exit(fails ? 1 : 0);
});
