// Correspondence export (Word/PDF) and the title change carried into the text
// (Oct 2026). Throwaway data in $HOME/sbx; the live data/ is never opened for
// writing. The scanned-page embedding is tested on the builder with its own
// temporary folder, so nothing is written into minutes/correspondence.
process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
const path = require('path'), fs = require('fs'), os = require('os'), zlib = require('zlib');
const root = process.env.HOME + '/mnt/aotc-track';
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const head = t => console.log('\n── ' + t);
let who = { id: 1, role: 'admin', name: 'Clerk' };
const authPath = require.resolve(path.join(root, 'middleware/auth')); const realAuth = require(authPath);
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { ...realAuth,
  requireAuth: (q, _r, nx) => { q.user = { ...who }; nx(); } } };
const D = process.env.AOTC_DATA_DIR;
const write = (c, rows) => fs.writeFileSync(`${D}/${c}.json`, JSON.stringify(rows));
write('users', [
  { id: 1, name: 'Clerk', role: 'admin', email: 'c@t', permissions: [] },
  { id: 2, name: 'Administrator', role: 'secretary', email: 'a@t', permissions: ['correspondence.intake'] },
  { id: 3, name: 'Nobody', role: 'viewer', email: 'n@t', permissions: [] },
]);
write('session_members', [
  { id: 10, name: 'Cecilia Pokua Anto', titles: ['Mrs'], position: 'Presbyter', rank: 5, shortForm: 'Mrs Anto', shortFormSource: 'manual' },
  { id: 11, name: 'Gideon Adjei', titles: ['Mr'], position: 'Session Clerk', office: 'session_clerk', rank: 1 },
]);
['minutes_docs', 'session_matters', 'office_terms', 'correspondence', 'minutes_proofreads', 'house_style_rules'].forEach(c => write(c, []));
const db = require(path.join(root, 'utils/db'));
const SM = require(path.join(root, 'utils/sessionMinutes'));
const CX = require(path.join(root, 'utils/correspondenceExport'));
const JSZip = require(path.join(root, 'node_modules/jszip'));
const express = require(path.join(root, 'node_modules/express'));
const app = express(); app.use(express.json());
app.use('/api/minutes', require(path.join(root, 'routes/minutes')));

// Two meetings: one still being written, one signed.
const open = db.insert('minutes_docs', SM.newMinutesDoc({ date: '2026-09-24' }));
const signed = db.insert('minutes_docs', { ...SM.newMinutesDoc({ date: '2026-08-27' }), locked: true, status: 'final' });
const k = open.sections.find(s => s.key === 'other').key;
db.update('minutes_docs', open.id, { sections: db.findById('minutes_docs', open.id).sections.map(s => s.key === k
  ? { ...s, children: [{ subject: 'Welfare', body: 'Mrs Cecilia Pokua Anto reported on the visits. Mrs Anto added that two families were helped. Mr Gideon Adjei thanked her.' }] } : s) });
db.update('minutes_docs', signed.id, { sections: db.findById('minutes_docs', signed.id).sections.map(s => s.key === k
  ? { ...s, children: [{ subject: 'Old', body: 'Mrs Cecilia Pokua Anto opened in prayer.' }] } : s) });
const matter = db.insert('session_matters', { subject: 'Welfare visits', note: 'Mrs Anto to report.', status: 'open', raisedIn: open.id, updates: [] });

// Letters: two read at the open meeting, one waiting for the Session, one new, one handled.
const L = (o) => db.insert('correspondence', { heading: 'Letter', summary: '', action: '', from: '', letterDate: '', eventDate: '', receivedOn: '2026-09-01', files: [], file: null, order: 0, ...o });
const a = L({ minutesId: open.id, status: 'tabled', fromInbox: true, order: 10, heading: 'Invitation to the Presbytery Synod', from: 'Accra Presbytery', letterDate: '2026-09-02', eventDate: '2026-10-17', summary: 'The Presbytery invited two delegates to the Synod.\nMrs Cecilia Pokua Anto was named as contact.', action: 'Noted', addedBy: 'Administrator' });
const b = L({ minutesId: open.id, status: 'tabled', order: 20, heading: 'Request for the use of the chapel', from: 'Ebenezer Choir', summary: 'The Choir asked to use the chapel.', action: 'Approved' });
const c = L({ minutesId: null, status: 'session', heading: 'Harvest date', from: 'Finance Committee', receivedOn: '2026-09-20', summary: 'Proposed harvest date.' });
const d = L({ minutesId: null, status: 'new', heading: 'Unsorted letter', receivedOn: '2026-09-28' });
const e = L({ minutesId: null, status: 'handled', heading: 'Thank-you note', handledNote: 'Acknowledged by phone' });

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/api/minutes`;
  const get = async url => { const r = await fetch(base + url); return { status: r.status, type: r.headers.get('content-type') || '', cd: r.headers.get('content-disposition') || '', buf: Buffer.from(await r.arrayBuffer()) }; };
  const post = async (url, body) => { const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const docText = async buf => { const z = await JSZip.loadAsync(buf); return (await z.file('word/document.xml').async('string')).replace(/<[^>]+>/g, ''); };
  try {
    head('Export: the letters read at one meeting');
    let r = await get(`/correspondence/export?scope=minutes&id=${open.id}&format=docx`);
    ok(r.status === 200 && /wordprocessingml/.test(r.type), 'Word file returned');
    ok(/attachment; filename="Correspondence_2026-09-24_\d{4}-\d{2}-\d{2}\.docx"/.test(r.cd), `named for the meeting (${r.cd})`);
    let t = await docText(r.buf);
    ok(t.includes('Invitation to the Presbytery Synod') && t.includes('Request for the use of the chapel'), 'both letters are in it');
    ok(t.indexOf('Invitation') < t.indexOf('Request for the use'), 'in the order they sit in the minutes');
    ok(t.includes('Accra Presbytery') && t.includes('2 September 2026') && t.includes('17 October 2026'), 'from, dated and the date it asks for are written out');
    ok(t.includes('Read at the Session meeting of 24 September 2026'), 'says where it went');
    ok(t.includes('The Presbytery invited two delegates') && t.includes('Noted'), 'summary and action included');
    ok(!t.includes('Harvest date') && !t.includes('Unsorted letter'), 'letters from elsewhere are not included');
    r = await get(`/correspondence/export?scope=minutes&id=${open.id}&format=pdf`);
    ok(r.status === 200 && r.type.includes('pdf') && r.buf.slice(0, 5).toString() === '%PDF-', 'PDF returned');
    ok(/^inline/.test(r.cd), 'PDF opens in the viewer (inline)');

    head('Export: the inbox views, the waiting box and the register');
    r = await get('/correspondence/export?scope=inbox&view=new&format=docx'); t = await docText(r.buf);
    ok(t.includes('Unsorted letter') && !t.includes('Harvest date') && t.includes('Letters to be sorted'), 'inbox "to be sorted" view');
    r = await get('/correspondence/export?scope=inbox&view=handled&format=docx'); t = await docText(r.buf);
    ok(t.includes('Thank-you note') && t.includes('Acknowledged by phone'), 'handled view carries how it was handled');
    r = await get('/correspondence/export?scope=inbox&view=all&format=docx'); t = await docText(r.buf);
    ok(t.includes('Unsorted letter') && t.includes('Harvest date') && t.includes('Thank-you note') && t.includes('Invitation') && !t.includes('Request for the use'), 'all = inbox letters plus those it sent into minutes (not letters typed straight into minutes)');
    r = await get(`/correspondence/export?scope=waiting&ids=${c.id}&format=docx`); t = await docText(r.buf);
    ok(t.includes('Harvest date') && t.includes('Waiting for the Session') && t.includes('1 letter'), 'the ticked waiting letters');
    r = await get('/correspondence/export?scope=register&q=chapel&format=docx'); t = await docText(r.buf);
    ok(t.includes('Request for the use of the chapel') && !t.includes('Synod') && t.includes('matching'), 'register follows the search');
    r = await get(`/correspondence/export?scope=register&ids=${a.id},${b.id}&format=pdf`);
    ok(r.status === 200 && r.buf.length > 1000, 'register with ids, as PDF');

    head('Who may export');
    who = { id: 2, role: 'secretary', name: 'Administrator' };
    r = await get('/correspondence/export?scope=inbox&view=new&format=pdf');
    ok(r.status === 200, 'the Administrator (intake) can export the inbox');
    r = await get(`/correspondence/export?scope=minutes&id=${open.id}&format=pdf`);
    ok(r.status === 403, 'but not the letters inside minutes');
    who = { id: 3, role: 'viewer', name: 'Nobody' };
    r = await get('/correspondence/export?scope=inbox&format=pdf');
    ok(r.status === 403, 'someone without the inbox is refused');
    who = { id: 1, role: 'admin', name: 'Clerk' };

    head('Scanned pages put in (builder, temp folder)');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cx-'));
    const png = (() => {
      const w = 40, h = 60, raw = Buffer.alloc((w * 3 + 1) * h, 0x99);
      for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
      const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) >>> 0 : crc32(td)); return Buffer.concat([len, td, crc]); };
      const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
      return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    })();
    function crc32(buf) { let c, crc = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) { c = (crc ^ buf[i]) & 0xFF; for (let k2 = 0; k2 < 8; k2++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xFFFFFFFF) >>> 0; }
    fs.writeFileSync(path.join(tmp, 'p1.png'), png);
    ok(JSON.stringify(CX.imageSize(png)) === JSON.stringify({ type: 'png', width: 40, height: 60 }), 'PNG size read from its header');
    const letter = { heading: 'With pages', status: 'new', pageCount: 3, files: [
      { filename: 'p1.png', mimetype: 'image/png' }, { filename: 'p2.pdf', mimetype: 'application/pdf' }, { filename: 'gone.jpg', mimetype: 'image/jpeg' }] };
    fs.writeFileSync(path.join(tmp, 'p2.pdf'), '%PDF-1.4');
    const wd = await CX.buildCorrespondenceDocx({ title: 'T', letters: [letter] }, { pages: true, filesDir: tmp });
    const z = await JSZip.loadAsync(wd);
    const media = Object.keys(z.files).filter(f => f.startsWith('word/media/') && !f.endsWith('/'));
    t = (await z.file('word/document.xml').async('string')).replace(/<[^>]+>/g, '');
    ok(media.length === 2, `the scanned image is in the Word file, beside the crest (${media.length} images)`);
    ok(t.includes('Page 2 was uploaded as a PDF') && t.includes('Page 3: the file is missing'), 'pages that cannot go in are named');
    const pd = await CX.buildCorrespondencePdf({ title: 'T', letters: [letter] }, { pages: true, filesDir: tmp });
    const pageCount = (pd.toString('latin1').match(/\/Type \/Page\b/g) || []).length;
    ok(pageCount === 2, `PDF: the letter, then its scanned page on its own page (${pageCount} pages)`);
    const plain = await CX.buildCorrespondencePdf({ title: 'T', letters: [letter] }, { pages: false, filesDir: tmp });
    ok((plain.toString('latin1').match(/\/Type \/Page\b/g) || []).length === 1, 'without pages, one page');
    fs.rmSync(tmp, { recursive: true, force: true });

    head('Mrs → Madam carried into the text');
    ok(SM.retitleText('Mrs Akua Anto spoke.', { name: 'Cecilia Pokua Anto' }, ['Mrs'], ['Madam'], false).n === 0, 'a different forename is a different person');
    db.update('session_members', 10, { titles: ['Madam'] });
    let p = await post('/roster/10/retitle', { from: ['Mrs'] });
    ok(p.status === 200 && p.body.count === 4, `found 4 mentions not yet signed (${p.body.count}): two in the minutes, one matter, one letter`);
    ok(p.body.shortForm === 'Madam Anto', 'her short form would become "Madam Anto"');
    ok(p.body.signedLeftAlone === 1, 'one signed set of minutes left alone');
    ok(/Mrs Cecilia/.test(JSON.stringify(db.findById('minutes_docs', open.id).sections)), 'nothing changed before she says so');
    p = await post('/roster/10/retitle', { from: ['Mrs'], apply: true });
    const body = JSON.stringify(db.findById('minutes_docs', open.id).sections);
    ok(body.includes('Madam Cecilia Pokua Anto reported') && body.includes('Madam Anto added') && !/Mrs (Cecilia|Anto)/.test(body), 'the minutes being written now say Madam');
    ok(body.includes('Mr Gideon Adjei'), 'other people untouched');
    ok(JSON.stringify(db.findById('minutes_docs', signed.id).sections).includes('Mrs Cecilia Pokua Anto opened'), 'the signed minutes still read as approved');
    ok(db.findById('session_matters', matter.id).note === 'Madam Anto to report.', 'the open matter');
    ok(db.findById('correspondence', a.id).summary.includes('Madam Cecilia Pokua Anto'), 'the letter summary');
    ok(db.findById('session_members', 10).shortForm === 'Madam Anto', 'her short form');
    p = await post('/roster/10/retitle', { from: ['Mrs'] });
    ok(p.body.count === 0, 'nothing left to change');
    p = await post('/roster/10/retitle', {});
    ok(p.status === 400, 'the old title is required');
  } catch (err) { console.error(err); fail++; }
  server.close();
  console.log(`\n${n - fail}/${n} passed`);
  process.exit(fail ? 1 : 0);
});
