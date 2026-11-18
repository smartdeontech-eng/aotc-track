// Constituted on the word shared at the devotion, or on a scripture (Nov 2026).
process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
const path = require('path'), fs = require('fs'); const root = path.join(__dirname, '..');
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const authPath = require.resolve(path.join(root, 'middleware/auth')); const realAuth = require(authPath);
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { ...realAuth,
  requireAuth: (q, _r, nx) => { q.user = { id: 1, role: 'admin', name: 'Clerk', permissions: [] }; nx(); } } };
fs.mkdirSync(process.env.AOTC_DATA_DIR, { recursive: true });
const db = require(path.join(root, 'utils/db')); const SM = require(path.join(root, 'utils/sessionMinutes'));
['users', 'session_members', 'minutes_docs', 'office_terms', 'correspondence'].forEach(c => db.writeAll(c, []));
db.insert('users', { id: 1, name: 'Clerk', role: 'admin', email: 'c@t', permissions: [] });
const doc = db.insert('minutes_docs', SM.newMinutesDoc({ date: '2026-11-05' }));
const read = () => { const rows = SM.renderRows(db.findById('minutes_docs', doc.id), { correspondence: [], members: [] }) || []; return JSON.stringify(rows); };
const express = require(path.join(root, 'node_modules/express'));
const app = express(); app.use(express.json()); app.use('/api/minutes', require(path.join(root, 'routes/minutes')));
const server = app.listen(0, async () => {
  const put = async (proceedings) => (await fetch(`http://127.0.0.1:${server.address().port}/api/minutes/${doc.id}/proceedings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proceedings }) })).status;
  try {
    await put({ constitutedBy: 'Rev Joseph Richmond Tettey' }); await put({ constitutedAt: '6:46 pm' });
    ok(read().includes('Rev Joseph Richmond Tettey duly constituted the Session at 6:46 pm in the name of the Triune God.'), 'no tick: as before');
    ok(await put({ constitutedOnWord: 'yes' }) === 200 && db.findById('minutes_docs', doc.id).proceedings.constitutedOnWord === true, 'the tick is stored as a tick');
    ok(read().includes('Rev Joseph Richmond Tettey, drawing on the words shared during the devotion, duly constituted the Session at 6:46 pm in the name of the Triune God.'), 'ticked: on the words shared during the devotion');
    await put({ constitutedWordRef: 'Hebrews 4:16' });
    ok(read().includes('Rev Joseph Richmond Tettey, drawing on Hebrews 4:16, duly constituted the Session'), 'ticked with a scripture: drawing on Hebrews 4:16');
    await put({ constitutedOnWord: false });
    ok(read().includes('Rev Joseph Richmond Tettey duly constituted the Session at 6:46 pm'), 'unticked: the scripture is not printed');
  } catch (e) { ok(false, 'threw: ' + e.stack); }
  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
  server.close(); process.exit(fail ? 1 : 0);
});
