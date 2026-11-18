// Weekly Finance: revivals and other programmes during the week (Nov 2026).
// An offering each day the programme runs; counted as Offertory, read out one
// line per programme with its days. Throwaway data in $HOME/sbx.
process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
const path = require('path'); const root = path.join(__dirname, '..');
const authPath = require.resolve(path.join(root, 'middleware/auth')); const realAuth = require(authPath);
let CURRENT = { id: 1, name: 'Clerk', role: 'accounts', permissions: ['finance.weekly'] };
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { ...realAuth,
  requireAuth: (q, _r, n) => { q.user = CURRENT; n(); },
  requirePermission: p => (q, r, n) => { q.user = CURRENT; return (['admin', 'localadmin'].includes(CURRENT.role) || (CURRENT.permissions || []).includes(p)) ? n() : r.status(403).json({ error: 'no' }); },
  requireAnyPermission: (...ps) => (q, r, n) => { q.user = CURRENT; return (['admin', 'localadmin'].includes(CURRENT.role) || ps.some(p => (CURRENT.permissions || []).includes(p))) ? n() : r.status(403).json({ error: 'no' }); },
  canManageAllEntities: () => true } };
const db = require(path.join(root, 'utils/db'));
['finance_weekly', 'finance_weekly_lines', 'finance_quarterly', 'users', 'activity_logs'].forEach(c => db.writeAll(c, []));
const fw = require(path.join(root, 'utils/financeWeekly'));
const express = require(path.join(root, 'node_modules/express'));
const app = express(); app.use(express.json()); app.use('/api/finance-weekly', require(path.join(root, 'routes/financeWeekly')));
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/api/finance-weekly`;
  const call = async (m, u, b) => { const r = await fetch(base + u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const CLERK = CURRENT, TRE = { id: 2, name: 'Treasurer', role: 'treasurer', permissions: ['finance.weekly.confirm'] };
  try {
    const progs = [
      { name: 'Revival', days: [{ date: '2026-11-02', amount: '500' }, { date: '2026-11-03', amount: '1,250.50' }, { date: '2026-11-04', amount: 750 }] },
      { name: "Men's Fellowship week offering", days: [{ date: '2026-11-05', amount: 300 }, { date: '2026-11-07', amount: 200 }, { date: '2026-11-15', amount: 999 }] },
    ];
    let r = await call('PUT', '/week/2026-11-08', { amounts: { offertory1: 1000, tithes: 2000 }, status: 'entered', programmes: progs });
    const w = r.body.week;
    ok(r.status === 200 && w.programmes.length === 2, 'a week is saved with two programmes');
    ok(w.programmes[1].days.length === 2, 'a day outside the week (the 15th) is dropped');
    ok(w.programmes[0].days[1].amount === 1250.5, 'amounts typed with commas are read');
    ok(w.receiptsTotal === 1000 + 2000 + 2500.5 + 500, `total funds received includes the programmes (${w.receiptsTotal})`);
    console.log(w.announcement.split('\n').map(x => '      ' + x).join('\n'));
    ok(w.announcement.includes('Revival offering (Mon 2 – Wed 4 November)\t2,500.50'), 'the revival is read out with its days');
    ok(w.announcement.includes("Men's Fellowship week offering (Thu 5 and Sat 7 November)\t500.00"), 'a name already ending in "offering" is not doubled; separate days are listed');
    ok(w.announcement.startsWith('Funds received within the previous week amounted to GHS 6,000.50.'), 'the headline total includes them');
    CURRENT = TRE; await call('POST', '/week/2026-11-08/confirm', {}); CURRENT = CLERK;
    const sum = fw.quarterSummary(2026, 4);
    ok(sum.byFeed.offertory === 1000 + 3000.5, `the quarter's Offertory includes the programme offerings (${sum.byFeed.offertory})`);
    const t = (await call('GET', '/totals?year=2026&quarter=4')).body;
    const row = t.lines.find(l => l.key === 'programmes');
    ok(row && row.quarter === 3000.5 && row.side === 'in', 'the running totals show a Programme offerings row');
    ok(t.receipts.quarter === 6000.5, 'and the receipts total adds it once');
    r = await call('PUT', '/week/2026-11-08', { amounts: { offertory1: 1000 }, status: 'entered', programmes: [] });
    ok(r.status === 409, 'a confirmed week cannot be changed (programmes included)');
    r = await call('PUT', '/week/2026-11-15', { amounts: { offertory1: 900 }, status: 'draft' });
    ok(r.status === 200 && Array.isArray(r.body.week.programmes) && r.body.week.programmes.length === 0 && !/offering \(/.test(r.body.week.announcement), 'a week with no programme reads as before');
  } catch (e) { ok(false, 'threw: ' + e.stack); }
  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
  server.close(); process.exit(fail ? 1 : 0);
});
