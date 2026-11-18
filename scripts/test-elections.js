// End-to-end test of the Elections module against the real server, on a
// throwaway data folder. Run:  node scripts/test-elections.js
//
// Drives a whole election over HTTP: CLAN sets it up (ballot, photos, voters
// from the group and from Excel), the Session Clerk confirms, polls open on
// schedule, people vote online and at a booth, double votes and bad ballots
// are refused, the live stream updates, polls close, results and the PDF/Word
// report come out, the Clerk certifies — and the tally is checked to hold no
// link back to any voter.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aotc-elections-'));
process.env.AOTC_DATA_DIR = DIR;
process.env.JWT_SECRET = 'test-secret-'.padEnd(48, 'x');
process.env.NODE_ENV = 'test';
process.env.TZ = 'Africa/Accra';
delete process.env.SMS_API_KEY;

// Capture the codes the engine prints when no SMS gateway is configured.
const codes = {};
const realLog = console.log;
console.log = (...a) => {
  const s = a.join(' ');
  const m = s.match(/code for (.+?) (0\d{9}): (\d{6})/);
  if (m) { codes[m[2]] = m[3]; return; }
  if (/^\[sms\]/.test(s)) return;
  realLog(...a);
};

const db = require('../utils/db');
const jwt = require('jsonwebtoken');
const app = require('../server');
const E = require('../utils/elections');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; realLog(`  ok   ${label}`); } else { fail++; realLog(`  FAIL ${label}`); } }

const users = {};
function mkUser(key, role, permissions) {
  const u = db.insert('users', { name: key, email: `${key}@t.test`, role, permissions, twoFactorEnabled: false, sessionVersion: 0 });
  users[key] = `token=${jwt.sign({ id: u.id, name: u.name, email: u.email, role, sv: 0 }, process.env.JWT_SECRET, { expiresIn: '1h' })}`;
}

let BASE;
async function call(method, url, body, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (opts.as) headers.Cookie = users[opts.as];
  const r = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer());
  return { status: r.status, data };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const server = app.listen(0);
  BASE = `http://127.0.0.1:${server.address().port}`;

  mkUser('admin', 'admin', []);
  mkUser('clan', 'secretary', ['elections.manage']);
  mkUser('clerk', 'clerk', ['approvals.manage']);
  mkUser('nobody', 'secretary', ['planning.manage']);
  mkUser('officer', 'secretary', []);
  const officerId = db.findOne('users', u => u.email === 'officer@t.test').id;
  const ypg = db.insert('groups', { name: 'Young People’s Guild', code: 'YPG' });
  const people = [
    ['Ama Mensah', '0244000001', 1001], ['Kofi Boateng', '0244000002', 1002], ['Esi Owusu', '+233 24 400 0003', 1003],
    ['Yaw Asante', '0244000004', 1004], ['No Phone Person', '', 1005], ['Dup Number', '0244000001', 1006],
  ];
  people.forEach(([name, phone, no]) => db.insert('members', { name, phone, entityType: 'group', entityId: ypg.id, memberNo: no, position: name === 'Ama Mensah' ? 'President' : name === 'Kofi Boateng' ? 'Vice President' : 'Member' }));

  realLog('\nPermissions');
  ok((await call('GET', '/api/elections', undefined, { as: 'nobody' })).status === 403, 'someone without elections rights is refused');
  ok((await call('POST', '/api/elections', { title: 'x' }, { as: 'clerk' })).status === 403, 'the Session Clerk cannot set up an election (CLAN does)');

  realLog('\nSet-up by CLAN');
  const soon = new Date(Date.now() + 2000).toISOString();
  const later = new Date(Date.now() + 3600000).toISOString();
  let r = await call('POST', '/api/elections', { title: 'YPG Executive Elections 2026', entityType: 'group', entityId: ypg.id, openAt: soon, closeAt: later, liveMode: 'turnout' }, { as: 'clan' });
  ok(r.status === 201 && r.data.status === 'draft' && !r.data.secret, 'election created as a draft (secret never sent out)');
  const eid = r.data.id, slug = r.data.slug;

  const pres = (await call('POST', `/api/elections/${eid}/positions`, { title: 'President', seats: 1 }, { as: 'clan' })).data;
  const sec = (await call('POST', `/api/elections/${eid}/positions`, { title: 'Secretary', seats: 1 }, { as: 'clan' })).data;
  const com = (await call('POST', `/api/elections/${eid}/positions`, { title: 'Committee Members', seats: 2 }, { as: 'clan' })).data;
  const png = process.env.TEST_PHOTO ? `data:image/jpeg;base64,${fs.readFileSync(process.env.TEST_PHOTO).toString('base64')}` : 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const p1 = (await call('POST', `/api/elections/${eid}/candidates`, { positionId: pres.id, name: 'Akua Darko', photo: png }, { as: 'clan' })).data;
  const p2 = (await call('POST', `/api/elections/${eid}/candidates`, { positionId: pres.id, name: 'Nana Kwame' }, { as: 'clan' })).data;
  const s1 = (await call('POST', `/api/elections/${eid}/candidates`, { positionId: sec.id, name: 'Abena Sarpong' }, { as: 'clan' })).data;
  const cms = [];
  for (const n of ['Kwesi A', 'Efua B', 'Kojo C']) cms.push((await call('POST', `/api/elections/${eid}/candidates`, { positionId: com.id, name: n }, { as: 'clan' })).data);
  ok(p1.photoFile && fs.existsSync(path.join(DIR, 'election-photos', p1.photoFile)), 'candidate photo saved under data/election-photos');
  const photo = await fetch(`${BASE}/api/vote/photo/${p1.id}`);
  ok(photo.status === 200, 'candidate photo is served for the ballot');

  r = await call('POST', `/api/elections/${eid}/voters/preview`, { source: 'members' }, { as: 'clan' });
  const byName = n => r.data.rows.find(x => x.name === n);
  ok(byName('Esi Owusu').status === 'ok' && byName('Esi Owusu').phone === '0244000003', '+233 numbers are normalised to 0244000003');
  ok(byName('No Phone Person').status === 'error', 'a member without a phone is flagged');
  ok(byName('Dup Number').status === 'duplicate', 'a second person on the same phone is refused (one voter per phone)');
  r = await call('POST', `/api/elections/${eid}/voters/import`, { rows: r.data.rows, source: 'members' }, { as: 'clan' });
  ok(r.data.added === 4, `4 voters added from the group (got ${r.data.added})`);

  // Excel: Excel drops leading zeros and writes dates day-first.
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook(); const ws = wb.addWorksheet('List');
  ws.addRow(['YPG voters']); ws.addRow(['Full Name', 'Mobile', 'Date of Birth', 'Member No']);
  ws.addRow(['Adwoa Excel', 244000005, '14/03/1999', '2001']);
  ws.addRow(['Yaa Excel', '0244000006', new Date(Date.UTC(2001, 4, 2)), '2002']);
  ws.addRow(['Bad Phone', '12345', '', '']);
  ws.addRow(['Already There', '0244000002', '', '']);
  const xbuf = Buffer.from(await wb.xlsx.writeBuffer());
  r = await call('POST', `/api/elections/${eid}/voters/preview`, { file: { name: 'list.xlsx', base64: xbuf.toString('base64') } }, { as: 'clan' });
  const xr = r.data.rows;
  ok(xr.find(x => x.name === 'Adwoa Excel').phone === '0244000005' && xr.find(x => x.name === 'Adwoa Excel').dob === '1999-03-14', 'Excel: leading 0 restored, 14/03/1999 read day-first');
  ok(xr.find(x => x.name === 'Yaa Excel').dob === '2001-05-02', 'Excel: real date cells read');
  ok(xr.find(x => x.name === 'Bad Phone').status === 'error' && xr.find(x => x.name === 'Already There').status === 'duplicate', 'Excel: bad and duplicate numbers flagged before saving');
  r = await call('POST', `/api/elections/${eid}/voters/import`, { rows: xr, source: 'excel' }, { as: 'clan' });
  ok(r.data.added === 2, 'only the 2 clean Excel rows were added');
  const tmpl = await fetch(`${BASE}/api/elections/${eid}/voters/template.xlsx`, { headers: { Cookie: users.clan } });
  ok(tmpl.status === 200 && (await tmpl.arrayBuffer()).byteLength > 1000, 'Excel template downloads');

  realLog('\nSession Clerk confirms');
  r = await call('POST', `/api/elections/${eid}/confirm`, {}, { as: 'clerk' });
  ok(r.status === 409, 'cannot confirm before CLAN submits');
  r = await call('POST', `/api/elections/${eid}/submit`, {}, { as: 'clan' });
  ok(r.data.status === 'pending', 'CLAN submits to the Session Clerk');
  ok((await call('POST', `/api/elections/${eid}/confirm`, {}, { as: 'clan' })).status === 403, 'CLAN cannot confirm its own election');
  r = await call('POST', `/api/elections/${eid}/confirm`, {}, { as: 'clerk' });
  ok(r.data.status === 'confirmed' && r.data.confirmedBy === 'clerk', 'the Session Clerk confirms');
  ok((await call('POST', `/api/elections/${eid}/voters`, { name: 'Late', phone: '0244000099' }, { as: 'clan' })).status === 409, 'voters’ list is locked once confirmed');
  ok((await call('GET', `/api/vote/e/${slug}`)).data.status === 'confirmed', 'public page shows polls not yet open');

  realLog('\nPolls open on schedule; codes go out');
  await sleep(2100);
  E.tick();
  await sleep(300);
  ok(E.getElection(eid).status === 'open', 'scheduler opened the polls at the set time');
  for (let i = 0; i < 40 && Object.keys(codes).length < 6; i++) await sleep(50);
  ok(Object.keys(codes).length === 6, `a code was issued to each of the 6 voters (${Object.keys(codes).length})`);
  const v = await call('GET', `/api/elections/${eid}/voters`, undefined, { as: 'clan' });
  ok(v.data.every(x => x.codeIssuedAt && !('codeHash' in x)), 'codes recorded as issued; hashes never sent to the page');

  realLog('\nBooths');
  r = await call('POST', `/api/elections/${eid}/booths`, { name: 'Booth 1 — Chapel' }, { as: 'clan' });
  const booth = r.data;
  ok(/^\d{6}$/.test(booth.pin), 'booth created with a 6-digit PIN');
  ok((await call('POST', `/api/vote/booth/${booth.token}/unlock`, { pin: '000000' === booth.pin ? '111111' : '000000' })).status === 401, 'wrong booth PIN refused');
  r = await call('POST', `/api/vote/booth/${booth.token}/unlock`, { pin: booth.pin });
  const boothKey = r.data.key;
  ok(!!boothKey, 'booth unlocked with its PIN');

  realLog('\nVoting');
  // Ama online, wrong code first.
  r = await call('POST', `/api/vote/e/${slug}/verify`, { phone: '024 400 0001', code: codes['0244000001'] === '123456' ? '654321' : '123456' });
  ok(r.status === 401 && /4 tries left/.test(r.data.error), 'wrong code refused, tries counted');
  r = await call('POST', `/api/vote/e/${slug}/verify`, { phone: '0244000001', code: codes['0244000001'] });
  ok(r.status === 200 && r.data.name === 'Ama Mensah' && r.data.ballot && r.data.ballot.length === 3, 'right code shows the voter’s name and the ballot');
  const secPos = r.data.ballot.find(p => p.id === sec.id);
  ok(secPos.mode === 'yesno', 'unopposed Secretary is a Yes/No vote');
  let t = r.data.token;
  ok((await call('POST', `/api/vote/e/${slug}/cast`, { token: t, choices: { [com.id]: cms.map(c => c.id) } })).status === 400, 'three picks for a two-seat position is refused');
  r = await call('POST', `/api/vote/e/${slug}/cast`, { token: t, choices: { [pres.id]: [p1.id], [sec.id]: { [s1.id]: 'yes' }, [com.id]: [cms[0].id, cms[1].id] } });
  ok(r.status === 200, 'Ama’s ballot counted');
  ok((await call('POST', `/api/vote/e/${slug}/cast`, { token: t, choices: { [pres.id]: [p2.id] } })).status === 410, 'the same session cannot vote twice');
  ok((await call('POST', `/api/vote/e/${slug}/verify`, { phone: '0244000001', code: codes['0244000001'] })).status === 409, 'Ama cannot start a second vote');

  // Kofi at the booth.
  r = await call('POST', `/api/vote/e/${slug}/verify`, { phone: '0244000002', code: codes['0244000002'] }, { headers: { 'X-Booth-Key': boothKey } });
  r = await call('POST', `/api/vote/e/${slug}/cast`, { token: r.data.token, choices: { [pres.id]: [p2.id], [sec.id]: { [s1.id]: 'no' }, [com.id]: [cms[2].id] } }, { headers: { 'X-Booth-Key': boothKey } });
  ok(r.status === 200, 'Kofi voted at the booth');

  // Esi opens two sessions (two devices) and casts both at the same instant.
  const a = await call('POST', `/api/vote/e/${slug}/verify`, { phone: '0244000003', code: codes['0244000003'] });
  const b = await call('POST', `/api/vote/e/${slug}/verify`, { phone: '0244000003', code: codes['0244000003'] });
  const both = await Promise.all([a, b].map(x => call('POST', `/api/vote/e/${slug}/cast`, { token: x.data.token, choices: { [pres.id]: [p1.id] } })));
  ok(both.filter(x => x.status === 200).length === 1, 'two devices at once: exactly one vote counts');

  // Live stream (Pulse-style SSE).
  realLog('\nLive display');
  const disp = E.getElection(eid).displayToken;
  r = await call('GET', `/api/vote/live/${disp}`);
  ok(r.data.voted === 3 && r.data.eligible === 6 && r.data.results === null, 'live: 3 of 6 voted; tallies hidden while open (turnout mode)');
  ok(r.data.byChannel.booth === 1 && r.data.byChannel.online === 2, 'live: booth vs online split');
  const ctrl = new AbortController();
  const events = [];
  const sse = fetch(`${BASE}/api/vote/stream/${disp}`, { signal: ctrl.signal }).then(async res => {
    ok(res.headers.get('content-type').startsWith('text/event-stream'), 'stream answers as text/event-stream');
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value);
      let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = chunk.match(/^event: (\w+)\ndata: (.*)$/s); if (m) events.push({ ev: m[1], data: JSON.parse(m[2]) }); } }
  }).catch(() => {});
  await sleep(200);
  r = await call('POST', `/api/vote/e/${slug}/verify`, { phone: '0244000004', code: codes['0244000004'] });
  await call('POST', `/api/vote/e/${slug}/cast`, { token: r.data.token, choices: { [pres.id]: [p1.id], [com.id]: [cms[0].id] } });
  await sleep(1400);
  ok(events.length >= 2 && events[0].data.voted === 3 && events[events.length - 1].data.voted === 4, `stream pushed the new vote live (${events.map(x => x.data.voted).join(' -> ')})`);
  ctrl.abort();

  realLog('\nLock-out and officer corrections');
  for (let i = 0; i < 5; i++) r = await call('POST', `/api/vote/e/${slug}/verify`, { phone: '0244000005', code: '000000' === codes['0244000005'] ? '111111' : '000000' });
  ok(r.status === 401 && /locked/.test(r.data.error), 'five wrong codes lock the number');
  ok((await call('POST', `/api/vote/e/${slug}/verify`, { phone: '0244000005', code: codes['0244000005'] })).status === 423, 'even the right code waits while locked');
  ok((await call('POST', `/api/elections/${eid}/voters/${v.data.find(x => x.phone === '0244000005').id}/unlock`, {}, { as: 'clan' })).status === 200, 'officer unlocks');
  const yaa = v.data.find(x => x.phone === '0244000006');
  ok((await call('PUT', `/api/elections/${eid}/voters/${yaa.id}`, { phone: '0244000077' }, { as: 'clan' })).status === 400, 'phone change during polls needs a reason');
  r = await call('PUT', `/api/elections/${eid}/voters/${yaa.id}`, { phone: '0244000077', reason: 'Old number lost' }, { as: 'clan' });
  ok(r.status === 200 && codes['0244000077'], 'phone corrected with a reason, fresh code sent to the new number');
  ok((await call('POST', `/api/vote/e/${slug}/verify`, { phone: '0244000006', code: codes['0244000006'] })).status === 404, 'the old number no longer works');

  realLog('\nClose, results, report, certify');
  r = await call('POST', `/api/elections/${eid}/close`, {}, { as: 'clan' });
  ok(r.data.status === 'closed', 'officer closes the polls');
  ok((await call('POST', `/api/vote/e/${slug}/verify`, { phone: '0244000077', code: codes['0244000077'] })).status === 403, 'codes stop working after close');
  r = await call('GET', `/api/vote/live/${disp}`);
  const res = Object.fromEntries(r.data.results.map(p => [p.title, p]));
  ok(res.President.options.find(o => o.name === 'Akua Darko').votes === 3 && res.President.options.find(o => o.name === 'Nana Kwame').votes === 1, 'President: Akua 3, Nana 1');
  ok(res.Secretary.options[0].yes === 1 && res.Secretary.options[0].no === 1 && res.Secretary.options[0].skip === 2, 'Secretary Yes/No: 1 yes, 1 no, 2 left blank');
  const cm = Object.fromEntries(res['Committee Members'].options.map(o => [o.name, o.votes]));
  ok(cm['Kwesi A'] === 2 && cm['Efua B'] === 1 && cm['Kojo C'] === 1 && res['Committee Members'].skipped === 1, 'Committee: Kwesi 2, Efua 1, Kojo 1, 1 blank');
  const cols = db.sql.all('PRAGMA table_info(election_tally)').map(c => c.name);
  ok(!cols.some(c => /voter|booth|ip|at$|time/.test(c)), `tally table has no voter/booth/time columns (${cols.join(', ')})`);
  realLog('\nReport sign-off');
  r = await call('GET', `/api/elections/${eid}`, undefined, { as: 'clerk' });
  ok(r.data.signoff.president === 'Ama Mensah' && r.data.signoff.clanCoordinator === 'clan', 'sign-off pre-filled: group President from the members list (not the Vice), CLAN Coordinator = who set it up');
  ok((await call('PUT', `/api/elections/${eid}/signoff`, { president: 'x' }, { as: 'nobody' })).status === 403, 'others cannot change the sign-off names');
  r = await call('PUT', `/api/elections/${eid}/signoff`, { groupWitness: 'Kofi Boateng', groupWitnessRole: 'Secretary', clanCoordinator: 'Elder Kwame Mensah', clanWitness: 'Grace Ofori', sessionClerk: 'Elder J. Asare' }, { as: 'clan' });
  ok(r.status === 200 && r.data.signoff.president === 'Ama Mensah' && r.data.signoff.clanWitness === 'Grace Ofori', 'CLAN fills in the witnesses');
  const R = require('../utils/electionReport');
  const so = R.reportData(E.getElection(eid)).blocks.find(b => b.t === 'signoff');
  const names = so.tiers.flatMap(x => x.items.map(i => `${i.verb}:${i.name}`));
  ok(so.tiers.length === 3 && names.join('|') === 'Signed by:Ama Mensah|Witnessed by:Kofi Boateng|Approved by:Elder Kwame Mensah|Witnessed by:Grace Ofori|Validated by:Elder J. Asare', `report sign-off: group, CLAN, Session (${names.join(', ')})`);
  const faces = R.reportData(E.getElection(eid)).blocks.filter(b => b.t === 'table').flatMap(b => b.rows.map(r => r[0])).filter(c => c && c.face);
  ok(faces.length === 6 && faces.filter(f => f.buf).length === 1, `candidate pictures in the results (${faces.filter(f => f.buf).length} photo, ${faces.length - faces.filter(f => f.buf).length} initials)`);
  const pdf = await call('GET', `/api/elections/${eid}/report.pdf`, undefined, { as: 'clerk' });
  ok(pdf.status === 200 && pdf.data.slice(0, 5).toString() === '%PDF-', `PDF report (${pdf.data.length} bytes)`);
  const docx = await call('GET', `/api/elections/${eid}/report.docx`, undefined, { as: 'clerk' });
  ok(docx.status === 200 && docx.data.slice(0, 2).toString() === 'PK', `Word report (${docx.data.length} bytes)`);
  if (process.env.KEEP_REPORTS) { fs.writeFileSync(process.env.KEEP_REPORTS + '.pdf', pdf.data); fs.writeFileSync(process.env.KEEP_REPORTS + '.docx', docx.data); }
  ok((await call('POST', `/api/elections/${eid}/certify`, {}, { as: 'clan' })).status === 403, 'CLAN cannot certify');
  ok((await call('POST', `/api/elections/${eid}/certify`, {}, { as: 'clerk' })).data.status === 'certified', 'the Session Clerk certifies');
  ok((await call('PUT', `/api/elections/${eid}/signoff`, { clanWitness: 'Someone Else' }, { as: 'clan' })).status === 409, 'sign-off names are fixed once certified');
  r = await call('GET', '/api/elections/entities', undefined, { as: 'clan' });
  ok(r.status === 200 && r.data.groups.some(g => g.name === 'Young People’s Guild'), 'the officer sees every group in the "For" list');

  realLog('\nSecond check (date of birth) election');
  r = await call('POST', '/api/elections', { title: 'YAF Elections', entityType: 'group', entityId: ypg.id, openAt: new Date(Date.now() - 1000).toISOString(), closeAt: later, verifyDob: true }, { as: 'clan' });
  const e2 = r.data;
  const pos = (await call('POST', `/api/elections/${e2.id}/positions`, { title: 'President', seats: 1 }, { as: 'clan' })).data;
  await call('POST', `/api/elections/${e2.id}/candidates`, { positionId: pos.id, name: 'Solo Candidate' }, { as: 'clan' });
  r = await call('POST', `/api/elections/${e2.id}/voters/preview`, { rows: [{ name: 'Dee Voter', phone: '0200000001', dob: '1/2/1990' }, { name: 'No Dob', phone: '0200000002' }, { name: 'Desk Voter', phone: '0200000003', dob: '5/6/1985' }, { name: 'Known Voter', phone: '0200000004', dob: '7/8/1970' }] }, { as: 'clan' });
  ok(r.data.rows[1].status === 'error', 'with the date-of-birth check on, a voter without one is flagged');
  await call('POST', `/api/elections/${e2.id}/voters/import`, { rows: r.data.rows, source: 'manual' }, { as: 'clan' });
  await call('POST', `/api/elections/${e2.id}/submit`, {}, { as: 'clan' });
  await call('POST', `/api/elections/${e2.id}/confirm`, {}, { as: 'clerk' });
  await call('POST', `/api/elections/${e2.id}/open`, {}, { as: 'clerk' });
  for (let i = 0; i < 40 && !codes['0200000001']; i++) await sleep(50);
  r = await call('POST', `/api/vote/e/${e2.slug}/verify`, { phone: '0200000001', code: codes['0200000001'] });
  ok(r.data.name === 'Dee Voter' && r.data.needs[0] === 'dob' && !r.data.ballot, 'code right: name shown, then date of birth asked before the ballot');
  ok((await call('POST', `/api/vote/e/${e2.slug}/confirm`, { token: r.data.token, dob: '1990-01-02' })).status === 401, 'wrong date of birth refused');
  const c2 = await call('POST', `/api/vote/e/${e2.slug}/confirm`, { token: r.data.token, dob: '1990-02-01' });
  ok(c2.status === 200 && c2.data.ballot.length === 1, 'right date of birth opens the ballot');

  realLog('\nPolling desk (voter without their phone)');
  const b2 = (await call('POST', `/api/elections/${e2.id}/booths`, { name: 'Booth A' }, { as: 'clan' })).data;
  const k2 = (await call('POST', `/api/vote/booth/${b2.token}/unlock`, { pin: b2.pin })).data.key;
  ok((await call('POST', `/api/elections/${e2.id}/desk/lookup`, { phone: '0200000003' }, { as: 'officer' })).status === 403, 'someone not named as polling officer cannot use the desk');
  r = await call('PUT', `/api/elections/${e2.id}/officers`, { userIds: [officerId] }, { as: 'clan' });
  ok(r.status === 200 && r.data.officers[0].name === 'officer', 'CLAN names a polling officer');
  ok((await call('PUT', `/api/elections/${e2.id}/officers`, { userIds: [] }, { as: 'officer' })).status === 403, 'a polling officer cannot name others');
  r = await call('GET', '/api/elections/desk/mine', undefined, { as: 'officer' });
  ok(r.data.length === 1 && r.data[0].id === e2.id, 'the officer sees this election on the Polling Desk');
  ok((await call('GET', '/api/auth/me', undefined, { as: 'officer' })).data.pollOfficer === true, '/auth/me flags them so the menu shows Polling Desk');
  ok((await call('POST', `/api/elections/${e2.id}/desk/lookup`, { phone: '0209999999' }, { as: 'officer' })).status === 404, 'a number not on the list is refused at the desk');
  r = await call('POST', `/api/elections/${e2.id}/desk/lookup`, { phone: '020 000 0003' }, { as: 'officer' });
  ok(r.status === 200 && r.data.name === 'Desk Voter' && r.data.dobOnList === true && !('dob' in r.data), 'phone found: name shown, date of birth NOT shown to the officer');
  r = await call('POST', `/api/elections/${e2.id}/desk/release`, { phone: '0200000003', boothId: b2.id, method: 'dob', dob: '1985-05-06' }, { as: 'officer' });
  ok(r.status === 401 && /2 tries left/.test(r.data.error), 'wrong date of birth at the desk refused, tries counted');
  ok((await call('POST', `/api/elections/${e2.id}/desk/release`, { phone: '0200000004', boothId: b2.id, method: 'known', note: 'x' }, { as: 'officer' })).status === 400, '"I know this person" needs a short note');
  r = await call('POST', `/api/elections/${e2.id}/desk/release`, { phone: '0200000003', boothId: b2.id, method: 'dob', dob: '1985-06-05' }, { as: 'officer' });
  ok(r.status === 200 && r.data.booth === 'Booth A', 'right date of birth: ballot released to Booth A');
  ok((await call('POST', `/api/elections/${e2.id}/desk/release`, { phone: '0200000004', boothId: b2.id, method: 'known', note: 'Same Bible study group' }, { as: 'officer' })).status === 409, 'a booth already waiting for someone takes no second release');
  ok((await call('GET', `/api/vote/booth/${b2.token}/next`)).status === 423, 'only the unlocked booth can collect the ballot');
  r = await call('GET', `/api/vote/booth/${b2.token}/next`, undefined, { headers: { 'X-Booth-Key': k2 } });
  ok(r.data.waiting && r.data.name === 'Desk Voter' && r.data.ballot.length === 1, 'the booth picks up the released ballot');
  const dTok = r.data.token;
  ok((await call('GET', `/api/vote/booth/${b2.token}/next`, undefined, { headers: { 'X-Booth-Key': k2 } })).data.waiting === false, 'a release is handed over once');
  const dPos = r.data.ballot[0];
  ok((await call('POST', `/api/vote/e/${e2.slug}/cast`, { token: dTok, choices: { [dPos.id]: { [dPos.candidates[0].id]: 'yes' } } })).status === 403, 'the released ballot cannot be cast from anywhere but that booth');
  r = await call('POST', `/api/vote/e/${e2.slug}/cast`, { token: dTok, choices: { [dPos.id]: { [dPos.candidates[0].id]: 'yes' } } }, { headers: { 'X-Booth-Key': k2 } });
  ok(r.status === 200, 'Desk Voter voted at Booth A');
  await sleep(200);
  const asst = db.findAll(E.C.assists, a => a.electionId === e2.id);
  ok(asst.length === 1 && asst[0].castAt && asst[0].officerName === 'officer' && asst[0].method === 'dob' && asst[0].noticeSms === 'skipped', `assisted vote recorded with officer and check; notice SMS attempted (${asst[0] && asst[0].noticeSms})`);
  ok((await call('POST', `/api/elections/${e2.id}/desk/lookup`, { phone: '0200000003' }, { as: 'officer' })).status === 409, 'the desk refuses someone who has already voted');
  r = await call('POST', `/api/elections/${e2.id}/desk/release`, { phone: '0200000004', boothId: b2.id, method: 'known', note: 'Same Bible study group' }, { as: 'officer' });
  ok(r.status === 200, '"known personally" release (with a note) accepted');
  ok((await call('POST', `/api/elections/${e2.id}/desk/cancel`, { boothId: b2.id }, { as: 'officer' })).status === 200, 'officer cancels a release');
  ok((await call('GET', `/api/vote/booth/${b2.token}/next`, undefined, { headers: { 'X-Booth-Key': k2 } })).data.waiting === false, 'a cancelled release never reaches the booth');
  r = await call('GET', `/api/elections/${e2.id}/desk/status`, undefined, { as: 'officer' });
  ok(r.data.recent.map(x => x.state).join(',') === 'cancelled,voted', `desk shows what happened to each release (${r.data.recent.map(x => x.state).join(', ')})`);
  await call('POST', `/api/elections/${e2.id}/close`, {}, { as: 'clan' });
  const R2 = require('../utils/electionReport').reportData(E.getElection(e2.id));
  const turnoutRow = R2.blocks.find(b => b.t === 'table' && b.rows.some(x => /polling officer/.test(x[0])));
  const deskTable = R2.blocks.find(b => b.t === 'table' && b.head && b.head.includes('Officer'));
  ok(turnoutRow && deskTable && deskTable.rows.length === 2 && /date of birth/.test(deskTable.rows[0].join(' ')) && /Bible study/.test(deskTable.rows[1].join(' ')), 'report lists officer-checked voters: who, which officer, which check, outcome');

  server.close();
  realLog(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(DIR, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(err => { realLog(err); process.exit(1); });
