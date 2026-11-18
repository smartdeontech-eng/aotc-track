// The minutes, word for word.
//
// A small invented Session sits once, with every part of the minutes in use:
// devotion, constitution, a review with a correction and an adoption, matters
// arising with a decision, main business, correspondence, other matters,
// prayers, closure, a member online and a guest. The test exports the minutes
// and the agenda through the real routes, as Word and as PDF, and compares the
// Word text, paragraph by paragraph, with the copy kept in test/golden/.
//
// Nothing here judges whether the wording is right. It records what the
// minutes say TODAY so that moving the engine, or any later change, cannot
// alter a single word without someone seeing it. When a change is meant,
// regenerate and read the diff:
//
//   UPDATE_GOLDEN=1 node --test test/minutes-golden.test.js
//   git diff test/golden
'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TZ = 'Africa/Accra'; // dates print as the congregation reads them
const ROOT = path.join(__dirname, '..');
const GOLDEN = path.join(__dirname, 'golden');
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aotc-minutes-'));
process.env.AOTC_DATA_DIR = DIR;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
delete process.env.ANTHROPIC_API_KEY;

// Signed in as the clerk, without a login.
const authPath = require.resolve(path.join(ROOT, 'middleware/auth'));
const realAuth = require(authPath);
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { ...realAuth,
  requireAuth: (q, _r, n) => { q.user = { id: 1, role: 'admin', name: 'Clerk', permissions: [] }; n(); },
  requirePermission: () => (q, _r, n) => { q.user = q.user || { id: 1, role: 'admin', name: 'Clerk', permissions: [] }; n(); } } };

const ROSTER = [
  { id: 1, name: 'Kwame Asante Mensah', titles: ['Rev'], position: 'District Minister', office: 'district_minister', rank: 10 },
  { id: 2, name: 'Akosua Darko Boateng', titles: ['Rev', 'Dr'], position: 'Senior Presbyter', rank: 20 },
  { id: 3, name: 'Yaw Owusu Frimpong', titles: ['Mr'], position: 'Session Clerk', office: 'session_clerk', rank: 30 },
  { id: 4, name: 'Ama Serwaa Ofori', titles: ['Mrs'], position: 'Presbyter', rank: 40 },
  { id: 5, name: 'Kojo Antwi Badu', titles: ['Ing'], position: 'Presbyter', rank: 50 },
  { id: 6, name: 'Efua Mansa Quaye', titles: ['Ms'], position: 'Presbyter', rank: 60 },
];
for (const [c, v] of Object.entries({
  users: [{ id: 1, name: 'Clerk', role: 'admin', email: 'clerk@example.test', permissions: [] }],
  session_members: ROSTER, minutes_docs: [], session_matters: [], office_terms: [], correspondence: [], venues: [],
  committees: [{ id: 7, name: 'Building Committee', signatories: { secretary: { name: 'Ms Abena Kyei', title: 'Secretary' }, head: { name: 'Ing Kojo Antwi Badu', title: 'Chairperson' } } }],
  members: [
    { id: 71, name: 'Ing Kojo Antwi Badu', position: 'Chairperson', entityType: 'committee', entityId: 7 },
    { id: 72, name: 'Ms Abena Kyei', position: 'Secretary', entityType: 'committee', entityId: 7 },
    { id: 73, name: 'Mr Kwesi Arthur', position: 'Member', entityType: 'committee', entityId: 7 },
    { id: 74, name: 'Mrs Adwoa Sarpong', position: 'Member', entityType: 'committee', entityId: 7 },
  ],
  meetings: [{ id: 70, title: 'Committee Meeting', entityType: 'committee', entityId: 7, entityName: 'Building Committee', kind: 'regular',
    date: '2026-09-17', time: '17:00', venueName: 'Church Office', status: 'held', agenda: '1. Roof repairs\n2. Car park',
    attendance: { presentMemberIds: [71, 72, 73], onlinePresentMemberIds: [73], apologyMemberIds: [74], absentMemberIds: [], guestsPresent: ['Mr Kofi Amoah'], guestsApology: [], locked: true, recordedAt: '2026-09-17T19:00:00Z' } }],
  meeting_minutes: [{ id: 1, meetingId: 70, status: 'draft', openingNote: '', previousDate: '2026-08-20',
    corrections: [{ from: 'Mr Kwesi Arthurs', to: 'Mr Kwesi Arthur' }],
    proceedings: { commencedAt: '17:05', openingBy: 'Mrs Adwoa Sarpong', constitutedBy: 'Ing Kojo Antwi Badu', constitutedAt: '17:10', minutesMovedBy: 'Mr Kwesi Arthur', minutesSecondedBy: 'Ms Abena Kyei', closureMovedBy: 'Ms Abena Kyei', closureSecondedBy: 'Mr Kwesi Arthur', closedAt: '18:40' },
    matters: [{ subject: 'Roof repairs', body: 'The contractor had replaced the damaged sheets.', action: 'Chairperson' }],
    main: [{ subject: 'Car park', body: 'Quotations would be sought from three firms.', action: 'Secretary',
      motions: [{ text: 'the lowest of the three quotations be accepted', movedBy: 'Mr Kwesi Arthur', secondedBy: 'Ms Abena Kyei', result: 'carried', unanimous: true }] }],
    other: [], closingNote: '' }],
  action_points: [],
})) fs.writeFileSync(path.join(DIR, c + '.json'), JSON.stringify(v));

const db = require(path.join(ROOT, 'utils/db'));
const SM = require(path.join(ROOT, 'utils/sessionMinutes'));
const JSZip = require(path.join(ROOT, 'node_modules/jszip'));
const express = require(path.join(ROOT, 'node_modules/express'));

function sittingOf(base) {
  const d = SM.newMinutesDoc({ date: '2026-09-24', venue: 'Session Hall', startTime: '18:30' });
  d.agenda = [
    { mins: 8, item: 'Opening Prayer and Devotion', responsible: 'Mrs Ama Serwaa Ofori', subItems: [] },
    { mins: 1, item: 'Constitution of the Session', responsible: 'Rev Kwame Asante Mensah', subItems: [] },
    { mins: 10, item: 'Review of Minutes', responsible: 'Session Clerk', subItems: [{ item: 'Minutes of 27th August 2026', responsible: '' }] },
    { mins: 15, item: 'Matters Arising', responsible: '', subItems: [{ item: 'Roof repairs', responsible: 'Ing Kojo Antwi Badu' }] },
    { mins: 20, item: 'Main Business', responsible: '', subItems: [{ item: 'Harvest planning', responsible: 'Ms Efua Mansa Quaye' }, { item: 'Youth camp', responsible: '' }] },
    { mins: 0, item: 'Closure', responsible: '', subItems: [] },
  ];
  d.roll = { presentIds: [1, 2, 3, 4, 5], apologyIds: [6], absentIds: [], onlineIds: [5], guests: [{ name: 'Mr Kofi Amoah', position: 'Church Accountant' }] };
  d.proceedings = {
    commencedAt: '18:32', devotionBy: 'Mrs Ama Serwaa Ofori', hymn: 'PH 250', scripture: 'Psalm 23',
    constitutedBy: 'Rev Kwame Asante Mensah', constitutedAt: '18:45',
    closureMovedBy: 'Ing Kojo Antwi Badu', closureSecondedBy: 'Mrs Ama Serwaa Ofori', closedAt: '21:05',
  };
  d.reviews = [{ date: '27th August 2026', iso: '2026-08-27', readBy: 'Mr Yaw Owusu Frimpong',
    movedBy: 'Rev Dr Akosua Darko Boateng', secondedBy: 'Ing Kojo Antwi Badu',
    corrections: [{ where: 'Members Present', ref: '4.2', was: 'Ms Efua Quaye', now: 'Ms Efua Mansa Quaye' }] }];
  const set = (key, patch) => Object.assign(d.sections.find((s) => s.key === key), patch);
  set('devotion', { body: 'The exhortation reminded the Session that a shepherd knows the flock by name.' });
  set('matters', { children: [{ subject: 'Roof repairs', body: 'Ing Kojo Antwi Badu reported that the contractor had replaced the damaged sheets.\nDecision: The Session agreed to release the final payment.', action: 'Treasurer', actionResponsible: 'Treasurer', actionStatus: 'open' }] });
  set('main', { children: [
    { subject: 'Harvest planning', body: 'The committee proposed the following:\n- a date in November\n- a single venue\n\nThe Session approved the proposal.', action: 'Noted' },
    { subject: 'Youth camp', body: 'The budget for the camp was presented.', deferred: true,
      motions: [{ text: 'That the camp budget be approved.', movedBy: 'Mrs Ama Serwaa Ofori', secondedBy: 'Ing Kojo Antwi Badu', result: 'carried', votes: { for: 4, against: 1, abstain: 0 } },
        { text: 'the camp be moved to December', movedBy: 'Rev Dr Akosua Darko Boateng', result: 'lost', votes: { for: 1, against: 4 } }] },
  ] });
  set('other', { children: [{ subject: 'Hall booking', body: 'A request to book the hall for a wedding was granted.' }] });
  set('prayers', { body: 'Rev Dr Akosua Darko Boateng led the closing prayers.' });
  return { ...d, ...base };
}

let server, base, docId;
before(async () => {
  docId = db.insert('minutes_docs', sittingOf({})).id;
  const app = express();
  app.use(express.json());
  app.use('/api/minutes', require(path.join(ROOT, 'routes/minutes')));
  app.use('/api/meetings', require(path.join(ROOT, 'routes/meetings')));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/minutes`;
});
after(() => { server && server.close(); fs.rmSync(DIR, { recursive: true, force: true }); });

const get = async (url) => {
  const r = await fetch(url.startsWith('/api/') ? base.replace('/api/minutes', '') + url : base + url);
  return { status: r.status, type: r.headers.get('content-type') || '', body: Buffer.from(await r.arrayBuffer()) };
};

// A Word file as text: one line per paragraph, cells separated by " | ",
// then the header and footer parts and the pictures, so the masthead,
// watermark and confidentiality line are held too.
async function wordText(buf) {
  const zip = await JSZip.loadAsync(buf);
  // Walk the XML once: text runs make paragraphs, paragraphs fill cells,
  // cells make rows. Tables inside cells are flattened into the cell.
  const flatten = (xml) => {
    const out = [];
    let para = null, cell = null, row = null, depth = 0;
    const re = /<w:tr[ >]|<\/w:tr>|<w:tc[ >]|<\/w:tc>|<w:p[ >]|<w:p\/>|<\/w:p>|<w:tab\/>|<w:br\/>|<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
    let m;
    while ((m = re.exec(xml))) {
      const t = m[0];
      if (t.startsWith('<w:tr')) { depth++; if (depth === 1) row = []; }
      else if (t === '</w:tr>') { depth--; if (depth === 0 && row) { out.push('[row] ' + row.join(' | ')); row = null; } }
      else if (t.startsWith('<w:tc')) { if (depth === 1) cell = []; }
      else if (t === '</w:tc>') { if (depth === 1 && cell) { row.push(cell.filter(Boolean).join(' / ')); cell = null; } }
      else if (t === '<w:p/>') { /* empty paragraph */ }
      else if (t.startsWith('<w:p')) para = '';
      else if (t === '</w:p>') { if (para !== null && para.trim()) (cell || out).push(para); para = null; }
      else if (t === '<w:tab/>') { if (para !== null) para += '\t'; }
      else if (t === '<w:br/>') { if (para !== null) para += ' '; }
      else if (para !== null) para += m[1];
    }
    return out;
  };
  const lines = flatten(await zip.file('word/document.xml').async('string'));
  const parts = Object.keys(zip.files).filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)).sort();
  for (const n of parts) lines.push(`[${n.slice(5, -4)}] ${flatten(await zip.file(n).async('string')).join(' / ')}`);
  lines.push('[media] ' + Object.keys(zip.files).filter((n) => n.startsWith('word/media/')).length + ' picture(s)');
  return lines.join('\n') + '\n';
}

function golden(name, text) {
  const file = path.join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN || !fs.existsSync(file)) {
    fs.mkdirSync(GOLDEN, { recursive: true });
    fs.writeFileSync(file, text);
    return;
  }
  assert.strictEqual(text, fs.readFileSync(file, 'utf8'), `${name} changed — if that was meant, run UPDATE_GOLDEN=1 and read git diff test/golden`);
}

test('the minutes text, row by row', () => {
  const rows = SM.renderRows(db.findById('minutes_docs', docId), { members: ROSTER });
  golden('session-minutes.rows.txt', rows.map((r) => `${r.no || ''}\t${r.subject || ''}\n${r.body || ''}${r.action ? '\n[action] ' + r.action : ''}`).join('\n\n') + '\n');
});

test('the minutes as Word', async () => {
  const r = await get(`/${docId}/minutes.docx`);
  assert.strictEqual(r.status, 200);
  golden('session-minutes.docx.txt', await wordText(r.body));
});

test('the agenda as Word', async () => {
  const r = await get(`/${docId}/agenda.docx`);
  assert.strictEqual(r.status, 200);
  golden('session-agenda.docx.txt', await wordText(r.body));
});

test('the minutes and the agenda as PDF', async () => {
  for (const what of ['minutes', 'agenda']) {
    const r = await get(`/${docId}/${what}.pdf`);
    assert.strictEqual(r.status, 200, what);
    assert.strictEqual(r.body.subarray(0, 5).toString(), '%PDF-', what);
    const pages = (r.body.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    golden(`session-${what}.pdf.txt`, `pages: ${pages}\n`);
  }
});

test('committee minutes as Word and PDF', async () => {
  const r = await get('/api/meetings/70/write.docx');
  assert.strictEqual(r.status, 200, r.body.toString().slice(0, 200));
  golden('committee-minutes.docx.txt', await wordText(r.body));
  const p = await get('/api/meetings/70/write.pdf');
  if (process.env.DUMP) fs.writeFileSync(process.env.DUMP, p.body);
  assert.strictEqual(p.body.subarray(0, 5).toString(), '%PDF-');
  golden('committee-minutes.pdf.txt', `pages: ${(p.body.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length}\n`);
});

test('the decisions register lists motions as records', async () => {
  const r = await get('/decisions');
  const d = JSON.parse(r.body.toString());
  const motions = d.decisions.filter((x) => x.kind === 'motion');
  assert.deepStrictEqual(motions.map((m) => [m.text, m.result]), [['the camp budget be approved', 'carried'], ['the camp be moved to December', 'lost']]);
  assert.strictEqual(d.decisions.filter((x) => /Motion:/.test(x.text)).length, 0, 'a motion is not listed twice');
});
