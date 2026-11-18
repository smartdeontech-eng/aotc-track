// Intended marriage presented to the Session (Nov 2026): two occasions — the
// traditional (customary) marriage and the church wedding — each with its
// date, time and place, on the marriage case and in the minutes' wording.
// Throwaway data in $HOME/sbx; auth stubbed as an admin.
process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
const path = require('path'), fs = require('fs');
const root = path.join(__dirname, '..');
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const head = t => console.log('\n── ' + t);
const authPath = require.resolve(path.join(root, 'middleware/auth')); const realAuth = require(authPath);
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { ...realAuth,
  requireAuth: (q, _r, nx) => { q.user = { id: 1, role: 'admin', name: 'Clerk', permissions: [] }; nx(); } } };
const D = process.env.AOTC_DATA_DIR;
fs.mkdirSync(D, { recursive: true });
const db = require(path.join(root, 'utils/db'));
const V = require(path.join(root, 'public/js/visitors-text.js'));
const SM = require(path.join(root, 'utils/sessionMinutes'));

head('The wording');
const g = { purpose: 'marriage', groom: 'Mr Kwabena Asante', bride: 'Miss Abena Darko',
  people: [{ name: 'Mr Kofi Asante', role: 'father of the groom' }],
  introducedBy: 'Presbyter Kwaku Koranteng', introducedByLinguist: true,
  events: [{ what: 'traditional marriage', date: '2026-11-14', time: '10am', venue: 'the bride’s family house, Kaneshie' },
    { what: 'church wedding', date: '2026-12-05', time: '13:00', venue: 'the AOTC Chapel' }],
  prayedFor: true, prayedBy: 'Mr Charles Osei Yeboah', withdrew: true };
const p = V.paragraph(g);
ok(V.title(g) === 'Intended Marriage — Mr Kwabena Asante and Miss Abena Darko', 'heading: "Intended Marriage — groom and bride", like "Funeral Announcement — name"');
ok(/introduced to the Session by the Linguist, Presbyter Kwaku Koranteng, to announce their intended marriage\./.test(p), 'why they came defaults to "to announce their intended marriage"');
ok(p.includes('The traditional marriage would be held on Saturday 14 November 2026 at 10:00 am at the bride’s family house, Kaneshie, and the church wedding on Saturday 5 December 2026 at 1:00 pm at the AOTC Chapel.'), 'both occasions, each with date, time (minutes’ style) and place, in one sentence');
ok(/prayed for the couple before they took leave of the Session\.$/.test(p), 'the couple prayed for and leave');
ok(/to seek the Session’s blessing/.test(V.paragraph({ ...g, why: 'to seek the Session’s blessing' })), 'a reason the Clerk types replaces the default');
const withThanks = V.paragraph({ ...g, events: g.events.concat([{ what: 'thanksgiving service', date: '2026-12-06', time: '9am', venue: 'the AOTC Chapel' }]) });
ok(withThanks.includes('the church wedding on Saturday 5 December 2026 at 1:00 pm at the AOTC Chapel, and the thanksgiving service on Sunday 6 December 2026 at 9:00 am at the AOTC Chapel.'), 'an optional thanksgiving service joins the same sentence (A, B, and C)');
const onlyChurch = V.paragraph({ purpose: 'marriage', groom: 'Mr A', bride: 'Miss B', introducedBy: '__self__', events: [{ what: 'church wedding', date: '2026-12-05', time: '1pm' }] });
ok(onlyChurch.endsWith('The church wedding would be held on Saturday 5 December 2026 at 1:00 pm.'), 'one occasion alone reads on its own');
const older = V.paragraph({ purpose: 'marriage', groom: 'Mr A', bride: 'Miss B', introducedBy: '__self__', weddingDate: '2026-12-05' });
ok(older.endsWith('The church wedding would be held on Saturday 5 December 2026.'), 'an older entry with only a wedding date reads as the church wedding');
ok(!/would be held/.test(V.paragraph({ purpose: 'marriage', groom: 'Mr A', bride: 'Miss B', introducedBy: '__self__' })), 'no dates, no sentence about them');

head('A seminarian or ministerial probationer');
const sem = { purpose: 'seminarian', people: [{ name: 'Mr Stephen Owusu Boateng' }], studyYear: 'third', introducedBy: 'Presbyter Kwaku Koranteng', introducedByLinguist: true, attachFrom: '2026-10-01', attachTo: '2026-12-31' };
ok(V.PURPOSES.some(p => p.key === 'seminarian'), 'offered in the list of visits');
ok(V.title(sem) === 'Seminarian on Attachment — Mr Stephen Owusu Boateng', 'heading: "Seminarian on Attachment — name"');
ok(V.paragraph(sem) === 'Mr Stephen Owusu Boateng, a third-year seminarian from Trinity Theological Seminary, was introduced to the Session by the Linguist, Presbyter Kwaku Koranteng. He had been attached to the Congregation from 1 October 2026 to 31 December 2026.', 'reads as the 8 Oct minutes described him; seminary defaults to Trinity');
const prob = { purpose: 'seminarian', studentKind: 'probationer', people: [{ name: 'Mr Adolph Ahenkorah Amankwah' }], introducedBy: 'Rev Joseph Richmond Tettey' };
ok(V.title(prob) === 'Ministerial Probationer — Mr Adolph Ahenkorah Amankwah', 'probationer heading');
ok(V.paragraph(prob) === 'Mr Adolph Ahenkorah Amankwah, a ministerial probationer, was introduced to the Session by Rev Joseph Richmond Tettey. He was present as an observer as part of his training.', 'probationer reads as the 9 Apr minutes put it');
ok(/Ramseyer/.test(V.paragraph({ ...sem, seminary: 'Ramseyer Training Centre' })), 'another seminary can be named');

head('In the exported minutes');
['users', 'session_members', 'minutes_docs', 'marriage_cases', 'office_terms', 'correspondence'].forEach(c => { try { db.writeAll(c, []); } catch (e) { fs.writeFileSync(`${D}/${c}.json`, '[]'); } });
db.insert('users', { id: 1, name: 'Clerk', role: 'admin', email: 'c@t', permissions: [] });
const doc = db.insert('minutes_docs', SM.newMinutesDoc({ date: '2026-11-05' }));
db.update('minutes_docs', doc.id, { proceedings: { ...(doc.proceedings || {}), visitors: [g] } });
const rows = SM.renderRows(db.findById('minutes_docs', doc.id), { correspondence: [], members: [] }) || [];
const flat = JSON.stringify(rows);
ok(flat.includes('Intended Marriage — Mr Kwabena Asante and Miss Abena Darko'), 'the item heading is in the Presentation section');
ok(flat.includes('the church wedding on Saturday 5 December 2026 at 1:00 pm at the AOTC Chapel'), 'and the paragraph, from the same wording file');

const express = require(path.join(root, 'node_modules/express'));
const app = express(); app.use(express.json());
app.use('/api/marriage', require(path.join(root, 'routes/marriage')));
app.use('/api/minutes', require(path.join(root, 'routes/minutes')));
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (method, url, body) => { const r = await fetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  try {
    head('The marriage case holds both occasions');
    const kase = db.insert('marriage_cases', { refNo: 'IM-2026-009', stage: 'counselling', form: { b: { husband: { name: 'Kwabena Asante' }, wife: { name: 'Abena Darko' } } } });
    let r = await call('PUT', `/marriage/cases/${kase.id}/dates`, { customaryDate: '2026-11-14', customaryTime: '10am', customaryVenue: 'Kaneshie', marriageDate: '2026-12-05', marriageTime: '13:00', marriageVenue: 'the AOTC Chapel', thanksgivingDate: '2026-12-06', thanksgivingTime: '9am', thanksgivingVenue: 'the AOTC Chapel' });
    ok(r.status === 200, `dates saved (${r.status} ${r.body.error || ''})`);
    const d = db.findById('marriage_cases', kase.id).dates;
    ok(d.customaryTime === '10:00 am' && d.marriageTime === '1:00 pm', `times stored in the minutes’ style (${d.customaryTime}, ${d.marriageTime})`);
    ok(d.customaryVenue === 'Kaneshie' && d.marriageVenue === 'the AOTC Chapel', 'places stored');
    ok(d.thanksgivingDate === '2026-12-06' && d.thanksgivingTime === '9:00 am' && d.thanksgivingVenue === 'the AOTC Chapel', 'the optional thanksgiving service stored');
    r = await call('GET', '/marriage/cases');
    const row = (Array.isArray(r.body) ? r.body : (r.body.cases || [])).find(c => c.id === kase.id) || {};
    ok(row.customaryDate === '2026-11-14' && row.customaryTime === '10:00 am' && row.marriageVenue === 'the AOTC Chapel', 'the cases list gives the Minutes page both occasions to fill in');
    r = await call('PUT', `/marriage/cases/${kase.id}/dates`, { marriageDate: '2026-12-05', customaryDate: 'not a date' });
    ok(r.status === 400, 'a bad customary date is refused');

    head('Saved through the minutes');
    // Start from none, so what is checked is what the route stored.
    db.update('minutes_docs', doc.id, { proceedings: { ...(db.findById('minutes_docs', doc.id).proceedings || {}), visitors: [] } });
    r = await call('PUT', `/minutes/${doc.id}/proceedings`, { proceedings: { visitors: [g] } });
    const saved = ((db.findById('minutes_docs', doc.id).proceedings || {}).visitors || [])[0] || {};
    ok(r.status === 200 && saved.events && saved.events.length === 2 && saved.events[1].venue === 'the AOTC Chapel', `both occasions are kept when the minutes are saved (${r.status} ${r.body.error || ''})`);
    r = await call('PUT', `/minutes/${doc.id}/proceedings`, { proceedings: { visitors: [g, sem] } });
    const s2 = ((db.findById('minutes_docs', doc.id).proceedings || {}).visitors || [])[1] || {};
    ok(r.status === 200 && s2.purpose === 'seminarian' && s2.studyYear === 'third' && s2.attachTo === '2026-12-31', 'a seminarian visit is kept when the minutes are saved');
  } catch (e) { ok(false, 'threw: ' + e.stack); }
  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
  server.close(); process.exit(fail ? 1 : 0);
});
