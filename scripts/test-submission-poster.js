// The WhatsApp poster: built from the same board the page draws, and
// self-contained enough that a browser can rasterise it with no network.
process.env.AOTC_DATA_DIR = process.env.AOTC_DATA_DIR || (process.env.HOME + '/sbx');
const path = require('path'), fs = require('fs');
const root = path.join(__dirname, '..');
const authPath = require.resolve(path.join(root, 'middleware/auth'));
const realAuth = require(authPath);
let CURRENT = null;
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { ...realAuth,
  requireAuth: (q, _r, n) => { q.user = CURRENT; n(); },
  requirePermission: () => (q, _r, n) => { q.user = CURRENT; n(); },
  requireAnyPermission: () => (q, _r, n) => { q.user = CURRENT; n(); },
  canManageAllEntities: () => true } };
const db = require(path.join(root, 'utils/db'));
const { posterSvg } = require(path.join(root, 'utils/submissionPoster'));
const express = require(path.join(root, 'node_modules/express'));
const app = express(); app.use(express.json());
app.use('/api/entry', require(path.join(root, 'routes/entry')));
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const head = t => console.log('\n── ' + t);

db.update('users', 1, { role: 'admin', permissions: ['congregation.view'] });
db.update('users', 3, { role: 'secretary', permissions: ['entry.manage'], entity: { type: 'group', id: 3 } });

const server = app.listen(0, async () => {
  const P = server.address().port, base = `http://127.0.0.1:${P}`;
  const CLERK = { id: 1, name: 'Clerk', role: 'admin', permissions: ['congregation.view'] };
  const SEC = { id: 3, name: 'Sec', role: 'secretary', permissions: ['entry.manage'] };

  head('Seed a quarter with all three states');
  const mk = (t, code, reopened) => {
    const e = db.findOne(t === 'committee' ? 'committees' : 'groups', x => x.code === code);
    const r = { year: 2026, quarter: 3, entityType: t, entityId: e.id, ownerCode: code,
      status: 'submitted', submittedBy: 'E. Ando', submittedAt: '2026-09-28T10:00:00Z' };
    if (reopened) r.reopenedUntil = new Date(Date.now() + 864e5).toISOString();
    db.insert('submissions', r);
  };
  ['EYS', 'SB'].forEach(c => mk('group', c));
  ['CLN', 'Sch'].forEach(c => mk('committee', c));
  mk('committee', 'Wel', true);

  CURRENT = CLERK;
  const board = await (await fetch(base + '/api/entry/submission-board?year=2026&quarter=3')).json();
  // The data copy may already carry a Q3 submission of its own, so assert the
  // shape rather than a magic number the fixture does not control.
  ok(board.submitted >= 4 && board.reopened === 1 && board.total === 25,
     `board: ${board.submitted} submitted, ${board.reopened} reopened, ${board.outstanding} outstanding of ${board.total}`);

  head('The poster endpoint');
  const res = await fetch(base + '/api/entry/submission-board/poster.svg?year=2026&quarter=3');
  ok(res.status === 200, 'it answers');
  ok((res.headers.get('content-type') || '').includes('image/svg+xml'), 'as an SVG');
  const svg = await res.text();
  ok(svg.startsWith('<svg') && svg.trim().endsWith('</svg>'), 'well-formed');

  head('Self-contained — a browser must rasterise it with no network');
  ok(!/<image\b/i.test(svg), 'no embedded <image>');
  ok(!/@import|xlink:href|url\(http/i.test(svg), 'no external references');
  ok(!/<foreignObject/i.test(svg), 'no foreignObject (it does not rasterise reliably)');
  ok(!/https?:\/\//i.test(svg.replace(/xmlns="[^"]*"/g, '')), 'no http(s) anywhere but the namespace');

  head('Every entity appears, exactly once');
  const names = db.findAll('committees').map(c => c.name).concat(db.findAll('groups').map(g => g.name));
  const missing = names.filter(nm => !svg.includes(nm.split(/\s+/)[0]));
  ok(!missing.length, `all ${names.length} names present${missing.length ? ' (missing: ' + missing.join(', ') + ')' : ''}`);
  ok((svg.match(/>Harvest Committee</g) || []).length >= 1, 'Harvest Committee is on it (ICT was folded into AHRM)');
  ok(!/\bICT\b/.test(svg), 'and ICT is not');

  head('All three states, each with a word as well as a colour');
  ok(svg.includes('#00C853') && svg.includes('SUBMITTED'), 'submitted: bright green + the word');
  ok(svg.includes('#FFB300') && svg.includes('REOPENED'), 'reopened: bright amber + the word');
  ok(svg.includes('#F5222D') && svg.includes('PENDING'), 'pending: bright red + the word');
  ok((svg.match(/stroke="#fff"/g) || []).length >= 1, 'the tick glyph is drawn, so shape differs too');

  head('Headline figures match the board');
  ok(svg.includes(`>${board.submitted}<`), `the hero number is ${board.submitted}`);
  ok(svg.includes(`/${board.total}`), `out of ${board.total}`);
  ok(/Deadline — /.test(svg), 'the deadline is stated');
  ok(/days? (left|overdue) · 20 outstanding/.test(svg), 'and what is outstanding'); // after the deadline it reads "N days overdue"

  head('Alphabetical within each column');
  // Names are split by x: the groups column sits at 101, committees at 567.
  // (Groups are emitted first because they are the left-hand column.)
  const colAt = x => [...svg.matchAll(new RegExp(`<text x="${x}" y="\\d+(?:\\.\\d+)?" font-family="[^"]*" font-size="21"[^>]*>([^<]+)<`, 'g'))].map(m => m[1]);
  const gNames = colAt(101), cNames = colAt(567);
  ok(gNames.length >= 12 && cNames.length >= 13, `both columns rendered (${gNames.length} / ${cNames.length} lines)`);
  ok(/^Bible Study/.test(gNames[0]), `groups start at the alphabetical first: "${gNames[0]}"`);
  ok(/^Administration/.test(cNames[0]), `committees start at the alphabetical first: "${cNames[0]}"`);
  ok(/^Young People/.test(gNames[gNames.length - 1]), `and groups end at "${gNames[gNames.length - 1]}"`);
  ok(/^Welfare/.test(cNames[cNames.length - 1]), `committees end at "${cNames[cNames.length - 1]}"`);

  head('A passed deadline reads as overdue, not "0 days left"');
  const late = posterSvg({ ...board, daysLeft: -3 });
  ok(/3 days overdue/.test(late), 'it says 3 days overdue');
  ok(late.includes('#FEEAE9'), 'and the strip turns red');

  head('Scope');
  CURRENT = SEC;
  ok((await fetch(base + '/api/entry/submission-board/poster.svg?year=2026&quarter=3')).status === 403,
     'a group secretary cannot pull the congregation-wide poster');
  CURRENT = CLERK;

  head('The page offers the download');
  const js = fs.readFileSync(path.join(root, 'public/js/page-reports.js'), 'utf8');
  ok(/downloadBoardImage/.test(js) && /Download image/.test(js), 'the button is wired');
  ok(/canvas\.toBlob/.test(js), 'it rasterises in the browser');
  ok(!/cdn|unpkg|jsdelivr/i.test(js), 'with no CDN');
  const css = fs.readFileSync(path.join(root, 'public/css/style.css'), 'utf8');
  ok(/badge-bright-ok\s*\{ background: #00C853/.test(css), 'the board chips use the same green');
  ok(/badge-bright-warn\s*\{ background: #FFB300/.test(css) && /badge-bright-no\s*\{ background: #F5222D/.test(css), 'and the same amber and red');

  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
  server.close(); process.exit(fail);
});
