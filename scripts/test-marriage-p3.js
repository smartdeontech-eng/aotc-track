// End-to-end test — Intended Marriage workflow, Phase 3.
// Solemnisation (gated on published banns) → married stage → marriage register.
const fs = require('fs');
const path = require('path');
const APP = process.env.APP_DIR || path.join(__dirname, '..');
const BASE = `http://localhost:${process.env.PORT || 4336}`;
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
  await login('clerk2', 'sessionclerk@test.com');
  await login('outsider', 'harvest@test.com');

  // Fast-forward a case to 'approved' with banns
  let r = await call('cfl', 'POST', '/marriage/cases', { husbandName: 'Kojo Antwi', wifeName: 'Adjoa Mensima' });
  const id = r.json.id;
  const img = fs.readFileSync(path.join(APP, 'public', 'img', 'logo.png'));
  const fd = new FormData();
  fd.append('pages', new Blob([img], { type: 'image/png' }), 'p1.png');
  await call('cfl', 'POST', `/marriage/cases/${id}/signed`, fd);
  const counsellorId = (db.findAll('counsellors')[0] || db.insert('counsellors', { name: 'Elder Osei', active: true })).id;
  await call('cfl', 'POST', `/marriage/cases/${id}/session-approval`, { date: '2026-07-20', minuteRef: 'SM/1', counsellorId });
  await call('cfl', 'PUT', `/marriage/cases/${id}/dates`, { marriageDate: '2026-10-17', customaryDate: '2026-10-15' });
  await call('cfl', 'POST', `/marriage/cases/${id}/clear`);
  r = await call('clerk2', 'POST', `/marriage/cases/${id}/final-approval`, { date: '2026-08-30', minuteRef: 'SM/2' });
  assert(r.json.stage === 'approved', 'case fast-forwarded to approved with banns');

  // Solemnisation blocked while banns unpublished
  r = await call('clerk2', 'POST', `/marriage/cases/${id}/solemnised`, { date: '2026-10-17', officiant: 'Rev. Asante' });
  assert(r.status === 400 && /not marked as published/i.test(r.json.error), 'solemnisation gated on published banns');

  for (const no of [1, 2, 3]) await call('clerk2', 'POST', `/marriage/cases/${id}/banns/${no}/published`);

  r = await call('outsider', 'POST', `/marriage/cases/${id}/solemnised`, { date: '2026-10-17', officiant: 'X' });
  assert(r.status === 403, 'outsiders cannot record solemnisation');
  r = await call('clerk2', 'POST', `/marriage/cases/${id}/solemnised`, { date: '2026-10-17', officiant: '' });
  assert(r.status === 400, 'officiant required');
  r = await call('clerk2', 'POST', `/marriage/cases/${id}/solemnised`, {
    date: '2026-10-17', officiant: 'Rev. Dr. K. Asante', venue: 'AOTC Sanctuary, Adabraka', certificateNo: 'MC-2026-114', customaryDone: true,
  });
  assert(r.status === 200 && r.json.stage === 'married', 'solemnisation recorded → married');
  assert(r.json.solemnised.certificateNo === 'MC-2026-114', 'certificate stored');

  // CFL notified
  const inbox = await call('cfl', 'GET', '/inbox');
  assert(inbox.json.items.some(i => /solemnised/i.test(i.title)), 'solemnisation lands in CFL inbox');

  // Register
  r = await call('cfl', 'GET', '/marriage/register?year=2026');
  assert(r.status === 200 && r.json.rows.length === 1, 'register lists the marriage');
  const row = r.json.rows[0];
  assert(row.husband === 'Kojo Antwi' && row.wife === 'Adjoa Mensima' && row.officiant === 'Rev. Dr. K. Asante', 'register row complete');
  r = await call('outsider', 'GET', '/marriage/register?year=2026');
  assert(r.status === 403, 'register is confidential');

  const pdf = await call('cfl', 'GET', '/marriage/register.pdf?year=2026', null, true);
  const buf = Buffer.from(await pdf.arrayBuffer());
  assert(pdf.status === 200 && buf.slice(0, 4).toString() === '%PDF', 'marriage register PDF renders');
  fs.writeFileSync('/tmp/marriage-register.pdf', buf);

  console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
