// End-to-end test — Intended Marriage workflow, Phase 2.
// Session approval → counselling → dates → clearance → final approval →
// banns Sunday math → clerk reminders (2 days / day-of / missed, deduped).
const fs = require('fs');
const path = require('path');
const APP = process.env.APP_DIR || path.join(__dirname, '..');
const BASE = `http://localhost:${process.env.PORT || 4333}`;
const assert = (c, m) => { if (!c) { console.error('FAIL:', m); process.exitCode = 1; } else console.log('ok  :', m); };

const jars = {};
async function call(user, method, p, body, raw) {
  const res = await fetch(BASE + '/api' + p, {
    method,
    headers: body instanceof FormData ? { cookie: jars[user] || '' } : { 'Content-Type': 'application/json', cookie: jars[user] || '' },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie'); if (sc) jars[user] = sc.split(';')[0];
  if (raw) return res;
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function login(u, email) {
  const r = await call(u, 'POST', '/auth/login', { email, password: 'Password#12345' });
  if (r.status !== 200) throw new Error('login failed: ' + email);
}

(async () => {
  const db = require(APP + '/utils/db');
  await login('cfl', 'cfl@test.com');
  await login('clerk2', 'sessionclerk@test.com'); // approvals.manage
  await login('outsider', 'harvest@test.com');

  // Fast-forward a case to 'signed' (Phase 1 already tested end-to-end)
  let r = await call('cfl', 'POST', '/marriage/cases', { husbandName: 'Yaw Darko', wifeName: 'Efua Sam' });
  const id = r.json.id;
  const img = fs.readFileSync(path.join(APP, 'public', 'img', 'logo.png'));
  const fd = new FormData();
  fd.append('pages', new Blob([img], { type: 'image/png' }), 'p1.png');
  r = await call('cfl', 'POST', `/marriage/cases/${id}/signed`, fd);
  assert(r.json.stage === 'signed', 'case fast-forwarded to signed');

  // Guards before session approval
  r = await call('cfl', 'POST', `/marriage/cases/${id}/meetings`, { note: 'too early' });
  assert(r.status === 400, 'no counselling meetings before Session approval');
  r = await call('outsider', 'POST', `/marriage/cases/${id}/session-approval`, { date: '2026-07-20', minuteRef: 'X' });
  assert(r.status === 403, 'outsiders cannot record Session approval');

  // Counsellor needed
  r = await call('cfl', 'POST', `/marriage/cases/${id}/session-approval`, { date: '2026-07-20', minuteRef: 'SM/2026/014' });
  assert(r.status === 400 && /counsellor/i.test(r.json.error), 'Session approval requires an assigned counsellor');
  db.insert('counsellors', { name: 'Elder Osei', phone: '0244000099', email: '', specialties: 'marriage', active: true });
  const counsellorId = db.findAll('counsellors').slice(-1)[0].id;

  // Session Clerk records approval (allowed via approvals.manage)
  r = await call('clerk2', 'POST', `/marriage/cases/${id}/session-approval`, {
    date: '2026-07-20', minuteRef: 'SM/2026/014', counsellorId,
    counsellingStartDate: '2026-08-01', coupleInformedDate: '2026-07-22',
  });
  assert(r.status === 200 && r.json.stage === 'counselling', 'Session approval recorded → counselling');
  assert(r.json.sessionApproval.counsellorName === 'Elder Osei', 'counsellor stored');

  // Meetings + notes
  r = await call('cfl', 'POST', `/marriage/cases/${id}/meetings`, { date: '2026-08-01', note: 'Session 1 — foundations' });
  r = await call('cfl', 'POST', `/marriage/cases/${id}/meetings`, { date: '2026-08-08', note: 'Session 2 — finances' });
  assert(r.status === 200 && r.json.counselling.meetings.length === 2, 'meetings logged');
  r = await call('cfl', 'PUT', `/marriage/cases/${id}/counselling`, { summary: 'Couple engaged well across six sessions.', durationNote: '6 weekly sessions' });
  assert(r.status === 200 && /six sessions/.test(r.json.counselling.summary), 'summary + duration saved');

  // Clearance blocked until BOTH dates are set
  r = await call('cfl', 'POST', `/marriage/cases/${id}/clear`);
  assert(r.status === 400 && /customary/i.test(r.json.error), 'clearance requires marriage AND customary dates');
  r = await call('cfl', 'PUT', `/marriage/cases/${id}/dates`, { marriageDate: '2026-10-17', customaryDate: '2026-10-15' });
  assert(r.status === 200 && r.json.dates.marriageDate === '2026-10-17', 'proposed dates saved');
  r = await call('cfl', 'POST', `/marriage/cases/${id}/clear`, { summary: 'Cleared with joy.' });
  assert(r.status === 200 && r.json.stage === 'cleared', 'counsellor cleared the couple');

  // Final approval — banns math (wedding Sat 17 Oct 2026 → Sundays 27 Sep, 4 Oct, 11 Oct)
  r = await call('outsider', 'POST', `/marriage/cases/${id}/final-approval`, { date: '2026-08-30', minuteRef: 'SM/2026/021' });
  assert(r.status === 403, 'outsiders cannot record final approval');
  r = await call('clerk2', 'POST', `/marriage/cases/${id}/final-approval`, { date: '2026-08-30', minuteRef: 'SM/2026/021' });
  assert(r.status === 200 && r.json.stage === 'approved', 'final approval → approved');
  const banns = r.json.banns;
  assert(JSON.stringify(banns.map(b => b.date)) === JSON.stringify(['2026-09-27', '2026-10-04', '2026-10-11']),
    `banns fall on the 3 Sundays before the wedding (${banns.map(b => b.date).join(', ')})`);

  // Clerk is notified in the inbox
  const inbox = await call('clerk2', 'GET', '/inbox');
  assert(inbox.json.items.some(i => /Banns of marriage scheduled/.test(i.title)), 'banns schedule lands in clerk inbox');

  // Mark bann 1 published
  r = await call('clerk2', 'POST', `/marriage/cases/${id}/banns/1/published`);
  assert(r.status === 200 && r.json.banns[0].published, 'bann 1 marked published');

  // ---- Reminder cadence (in-process, controlled "now") ----
  const { checkBannsReminders } = require(APP + '/utils/reminders');
  const at = iso => new Date(iso + 'T09:00:00');
  await checkBannsReminders(at('2026-10-02'));               // 2 days before bann 2 (4 Oct)
  await checkBannsReminders(at('2026-10-04'));               // day-of bann 2
  await checkBannsReminders(at('2026-10-05'));               // missed bann 2
  await checkBannsReminders(at('2026-10-09'));               // 2 days before bann 3
  await checkBannsReminders(at('2026-10-02'));               // repeat → deduped
  const logs = db.findAll('reminder_log', l => l.type === 'banns').map(l => l.key.split(':').slice(2).join(':')).sort();
  assert(JSON.stringify(logs) === JSON.stringify(['2:d0', '2:d2', '2:missed', '3:d2']),
    `banns reminders fired & deduped (${logs.join(', ')})`);
  // published bann 1 never reminds
  assert(!logs.some(k => k.startsWith('1:')), 'published banns are never reminded');

  // Form PDF still renders, now with Section I prefilled
  const pdf = await call('cfl', 'GET', `/marriage/cases/${id}/form.pdf`, null, true);
  const buf = Buffer.from(await pdf.arrayBuffer());
  assert(pdf.status === 200 && buf.slice(0, 4).toString() === '%PDF', 'form PDF renders with Section I data');
  fs.writeFileSync('/tmp/marriage-form-p2.pdf', buf);

  console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
