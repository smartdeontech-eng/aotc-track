// The Church Diary (Nov 2026): what goes on by itself, what is entered, the
// "Put this on the diary?" suggestions, who may keep it, and the preaching plan.
// Throwaway data in $HOME/sbx; auth stubbed (x-test-user picks the account).
process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
process.env.ANTHROPIC_API_KEY = 'test-key';
const path = require('path'), fs = require('fs'); const root = path.join(__dirname, '..');
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const head = t => console.log('\n── ' + t);
const realFetch = global.fetch; let lastAI = null, aiReply = null;
global.fetch = async (u, o) => {
  if (String(u).includes('anthropic.com')) { lastAI = JSON.parse(o.body); return { ok: true, status: 200, json: async () => aiReply }; }
  return realFetch(u, o);
};
const authPath = require.resolve(path.join(root, 'middleware/auth')); const realAuth = require(authPath);
let db;
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { ...realAuth,
  requireAuth: (q, _r, nx) => { const u = db.findById('users', Number(q.headers['x-test-user'] || 1)); q.user = { id: u.id, role: u.role, name: u.name }; nx(); } } };
fs.mkdirSync(process.env.AOTC_DATA_DIR, { recursive: true });
db = require(path.join(root, 'utils/db'));
const { toDayKey } = require(path.join(root, 'utils/dates'));
const day = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return toDayKey(d); };
['users', 'minutes_docs', 'meetings', 'marriage_cases', 'correspondence', 'diary_entries', 'diary_decisions', 'session_members', 'office_terms', 'activity_logs'].forEach(c => db.writeAll(c, []));
db.insert('users', { id: 1, name: 'Admin', role: 'admin', email: 'a@t', permissions: [] });
db.insert('users', { id: 2, name: 'Choir Secretary', role: 'secretary', email: 's@t', permissions: ['planning.manage'] });
db.insert('users', { id: 3, name: 'Church Administrator', role: 'attendance', email: 'ad@t', permissions: ['correspondence.intake'] });
db.insert('users', { id: 4, name: 'Session Clerk', role: 'clerk', email: 'c@t', permissions: ['approvals.manage', 'session.manage'] });
// Things scheduled elsewhere
db.insert('minutes_docs', { kind: 'session', date: day(5), startTime: '6:30 pm', venue: 'Session Room', sections: [], proceedings: {} });
db.insert('meetings', { entityName: 'Church Choir', title: 'Executive meeting', date: day(3), time: '17:00', venueName: 'Chapel', status: 'scheduled' });
db.insert('meetings', { entityName: 'Welfare', title: 'Meeting', date: day(4), status: 'cancelled' });
db.insert('marriage_cases', { refNo: 'IM-1', stage: 'approved', form: { b: { husband: { name: 'Kwabena Asante' }, wife: { name: 'Abena Darko' } } }, dates: { customaryDate: day(8), customaryTime: '10:00 am', marriageDate: day(15), marriageTime: '1:00 pm', marriageVenue: 'the AOTC Chapel' } });
db.insert('marriage_cases', { refNo: 'IM-2', stage: 'counselling', form: { b: { husband: { name: 'Not' }, wife: { name: 'Yet' } } }, dates: { marriageDate: day(9) } });
// Things only spotted
db.insert('correspondence', { heading: 'Funeral of the late Opanyin Kofi Mensah', summary: 'Burial service at the AOTC Chapel.', from: 'The Mensah family', eventDate: day(10), status: 'new', minutesId: null });
db.insert('correspondence', { heading: 'Old letter', eventDate: day(-3), status: 'new', minutesId: null });
db.insert('minutes_docs', { kind: 'session', date: day(-2), sections: [], proceedings: { visitors: [
  { purpose: 'funeral', deceased: 'the late Madam Ama Owusu', events: [{ what: 'one-week observance', date: day(12), time: '9am', venue: 'the family house' }] },
  { purpose: 'marriage', groom: 'Mr Kwabena Asante', bride: 'Miss Abena Darko', events: [{ what: 'church wedding', date: day(15), time: '1pm' }, { what: 'thanksgiving service', date: day(16), time: '9am', venue: 'the AOTC Chapel' }] },
] } });

const express = require(path.join(root, 'node_modules/express'));
const app = express(); app.use(express.json()); app.use('/api/diary', require(path.join(root, 'routes/diary')));
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/api/diary`;
  const call = async (who, method, url, body) => { const r = await realFetch(base + url, { method, headers: { 'content-type': 'application/json', 'x-test-user': String(who) }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  try {
    head('Everyone sees it; what goes on by itself');
    let r = await call(2, 'GET', `?from=${day(0)}&to=${day(30)}`);
    ok(r.status === 200 && r.body.canManage === false, 'a secretary can open the diary, but not keep it');
    const kinds = r.body.items.map(i => i.kind + ':' + i.date);
    ok(kinds.includes(`session:${day(5)}`), 'the next Session meeting is on it');
    ok(r.body.items.find(i => i.kind === 'session').href === '', '…without the link for someone who cannot open the Session minutes');
    ok(kinds.includes(`meeting:${day(3)}`) && !kinds.includes(`meeting:${day(4)}`), 'committee/group meetings are on it; a cancelled one is not');
    ok(kinds.includes(`traditional:${day(8)}`) && kinds.includes(`wedding:${day(15)}`), 'an approved marriage puts its traditional marriage and church wedding on');
    ok(!kinds.includes(`wedding:${day(9)}`), 'a marriage still in counselling is not on yet');
    ok(r.body.items.find(i => i.kind === 'wedding').title === 'Church wedding — Kwabena Asante & Abena Darko', 'named for the couple');
    r = await call(2, 'GET', '/suggestions');
    ok(r.status === 403, 'a secretary is not shown the suggestions');
    r = await call(2, 'POST', '', { kind: 'programme', title: 'Choir anniversary', date: day(20) });
    ok(r.status === 403, '…and cannot add');

    head('Who keeps it');
    r = await call(3, 'GET', `?from=${day(0)}&to=${day(30)}`);
    ok(r.body.canManage === true, 'the Church Administrator keeps it (correspondence.intake)');
    r = await call(4, 'GET', `?from=${day(0)}&to=${day(30)}`);
    ok(r.body.canManage === true && r.body.items.find(i => i.kind === 'session').href.includes('/minutes.html'), 'so does the Session Clerk, with the link to the minutes');

    head('What the app found');
    r = await call(3, 'GET', '/suggestions');
    const keys = r.body.map(s => `${s.kind}:${s.date}`);
    console.log('     ', keys.join(', '));
    ok(keys.includes(`funeral:${day(10)}`), 'a funeral letter in the inbox is offered as a funeral');
    ok(!r.body.some(s => s.title === 'Old letter'), 'a letter whose date has passed is not');
    ok(keys.includes(`funeral:${day(12)}`) && r.body.find(s => s.date === day(12)).title === 'One-week observance — the late Madam Ama Owusu', 'a bereaved family’s arrangements announced to the Session are offered');
    ok(keys.includes(`thanksgiving:${day(16)}`), 'a couple’s thanksgiving service announced as visitors is offered');
    ok(!keys.includes(`wedding:${day(15)}`), 'their church wedding is not offered — it is already on from the approved marriage');
    const fun = r.body.find(s => s.date === day(10));
    ok(fun.foundIn && /Mensah family/.test(fun.foundIn.label) && fun.foundIn.href === '/correspondence.html', 'each says where it was found, with a link');
    r = await call(3, 'POST', '', { kind: fun.kind, title: fun.title, date: fun.date, time: '9am', venue: 'the AOTC Chapel', fromKey: fun.key, foundIn: fun.foundIn });
    ok(r.status === 201 && r.body.time === '9:00 am', 'putting it on the diary makes an entry (time in the minutes’ style)');
    const thanks = (await call(3, 'GET', '/suggestions')).body.find(s => s.kind === 'thanksgiving');
    r = await call(3, 'POST', '/suggestions/dismiss', { key: thanks.key });
    r = await call(3, 'GET', '/suggestions');
    ok(!r.body.some(s => s.key === fun.key) && !r.body.some(s => s.key === thanks.key), 'accepted and declined ones are not offered again');
    ok(r.body.length === 1, `one left to decide (${r.body.length})`);

    head('Entered by hand');
    r = await call(4, 'POST', '', { kind: 'programme', title: 'Harvest launch', date: day(20), endDate: day(22), venue: 'the AOTC Chapel' });
    const hid = r.body.id;
    ok(r.status === 201, 'a programme over several days');
    r = await call(2, 'GET', `?from=${day(21)}&to=${day(21)}`);
    ok(r.body.items.some(i => i.title === 'Harvest launch'), '…shows on every day it runs');
    r = await call(4, 'POST', '', { kind: 'programme', title: 'Bad', date: day(5), endDate: day(1) });
    ok(r.status === 400, 'a last day before the first is refused');
    r = await call(4, 'PUT', `/${hid}`, { venue: 'the Church Hall' });
    ok(r.status === 200 && r.body.venue === 'the Church Hall' && r.body.title === 'Harvest launch', 'changing one thing keeps the rest');
    r = await call(2, 'DELETE', `/${hid}`);
    ok(r.status === 403, 'a secretary cannot take it off');
    r = await call(4, 'DELETE', `/${hid}`);
    ok(r.status === 200 && !db.findById('diary_entries', hid), 'the Clerk can');

    head('The preaching plan');
    const JSZip = require(path.join(root, 'node_modules/jszip'));
    const zip = new JSZip();
    const cell = t => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
    zip.file('word/document.xml', `<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>PREACHING PLAN — NOVEMBER 2026</w:t></w:r></w:p><w:tbl><w:tr>${cell('Date') + cell('Preacher') + cell('Theme')}</w:tr><w:tr>${cell('8th November') + cell('Rev Kofi Manukure Akyeampong') + cell('Walking in the Spirit')}</w:tr></w:tbl></w:body></w:document>`);
    zip.file('[Content_Types].xml', '<Types/>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    aiReply = { content: [{ type: 'text', text: JSON.stringify({ rows: [{ date: '2026-11-08', service: '', preacher: 'Rev Kofi Manukure Akyeampong', theme: 'Walking in the Spirit', readings: 'Gal 5:16-26', notes: '' }, { date: 'no date', preacher: 'x' }] }) }], stop_reason: 'end_turn' };
    const fd = new FormData(); fd.append('file', new Blob([buf]), 'plan.docx'); fd.append('year', '2026');
    let res = await realFetch(`${base}/preaching/read`, { method: 'POST', body: fd, headers: { 'x-test-user': '4' } });
    let j = await res.json();
    ok(res.status === 200 && j.rows.length === 1 && j.rows[0].preacher === 'Rev Kofi Manukure Akyeampong', `the plan is read: one service with a date (${res.status} ${j.error || ''})`);
    const sent = lastAI.messages[0].content[0].text;
    ok(/8th November \| Rev Kofi Manukure Akyeampong \| Walking in the Spirit/.test(sent), 'the Word table is passed on row by row, cells kept together');
    const fd2 = new FormData(); fd2.append('file', new Blob([buf]), 'plan.docx');
    res = await realFetch(`${base}/preaching/read`, { method: 'POST', body: fd2, headers: { 'x-test-user': '2' } });
    ok(res.status === 403, 'a secretary cannot upload it');
    r = await call(4, 'POST', '/preaching', { rows: j.rows, fileName: 'plan.docx' });
    ok(r.status === 200 && r.body.added === 1, 'confirmed rows go on the diary');
    r = await call(4, 'POST', '/preaching', { rows: [{ ...j.rows[0], theme: 'Walking by the Spirit' }], fileName: 'plan-v2.docx' });
    ok(r.body.updated === 1 && r.body.added === 0 && db.findAll('diary_entries', e => e.kind === 'preaching').length === 1, 'a corrected plan updates the same Sunday, never doubles it');
    r = await call(2, 'GET', '?from=2026-11-08&to=2026-11-08');
    const pr = r.body.items.find(i => i.kind === 'preaching');
    ok(pr && pr.title === 'Sunday service — Rev Kofi Manukure Akyeampong' && pr.theme === 'Walking by the Spirit', 'everyone sees the preacher and theme');
    const fd3 = new FormData(); fd3.append('file', new Blob([Buffer.from('hello')]), 'plan.txt');
    res = await realFetch(`${base}/preaching/read`, { method: 'POST', body: fd3, headers: { 'x-test-user': '4' } });
    ok(res.status === 400, 'a file that is not Word or PDF is refused politely');
  } catch (e) { ok(false, 'threw: ' + e.stack); }
  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
  server.close(); process.exit(fail ? 1 : 0);
});
