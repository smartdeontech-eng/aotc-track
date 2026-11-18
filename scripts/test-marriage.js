// End-to-end test — Intended Marriage workflow, Phase 1.
// Run: seed a user with counselling.manage, start the server, then
//   APP_DIR=<app> PORT=<port> node scripts/test-marriage.js
const fs = require('fs');
const path = require('path');
const APP = process.env.APP_DIR || path.join(__dirname, '..');
const BASE = `http://localhost:${process.env.PORT || 4331}`;
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
  await login('cfl', 'cfl@test.com');
  await login('outsider', 'harvest@test.com'); // has fundraising.manage, NOT counselling.manage

  // Confidentiality
  let r = await call('outsider', 'GET', '/marriage/cases');
  assert(r.status === 403, 'non-CFL users cannot see marriage cases');

  // Create
  r = await call('cfl', 'POST', '/marriage/cases', { husbandName: 'Kwame Boateng', husbandPhone: '0244000010', wifeName: 'Abena Owusu', wifePhone: '0244000011' });
  assert(r.status === 200 && /^CFL-M-\d{4}-\d{3}$/.test(r.json.refNo), `case created (${r.json.refNo})`);
  assert(r.json.stage === 'draft', 'new case starts as draft');
  const id = r.json.id;

  // Send-to-session blocked until Section G is completed
  r = await call('cfl', 'POST', `/marriage/cases/${id}/send-to-session`);
  assert(r.status === 400 && /Section G/.test(r.json.error), 'cannot go to Session without a recommendation');

  // Fill the form
  const form = {
    a: { date: '2026-07-18', time: '18:30', committee: [
      { name: 'Rev. Mensah', role: 'Coordinator' }, { name: 'Grace Addo', role: 'Secretary' }, { name: 'Sam Ofori', role: 'Member' }] },
    b: { husband: { name: 'Kwame Boateng', phone: '0244000010' }, wife: { name: 'Abena Owusu', phone: '0244000011' } },
    c: { husbandFamily: [{ name: 'Yaw Boateng', relationship: 'Father' }], husbandConsentNote: '',
         wifeFamily: [{ name: 'Akosua Owusu', relationship: 'Mother' }], wifeConsentNote: 'Father deceased — death certificate sighted.' },
    d: { q1: { h: '34', w: '29' }, q2: { h: 'PCG — AOTC', w: 'Methodist, Kaneshie' }, q6: { h: 'No', w: 'No' }, q11: { h: 'No', w: 'No' },
         q17: { h: 'None', w: 'None' } },
    e: { h: { fatherSupport: 'Yes', motherSupport: 'Yes' }, w: { fatherSupport: '', motherSupport: 'Yes', remarks: 'Family fully in support.' } },
    f: 'The committee found no impediment to the intended marriage.',
    g: { recommendation: 'clear', details: '' },
    h: {},
  };
  r = await call('cfl', 'PUT', `/marriage/cases/${id}/form`, { form });
  assert(r.status === 200, 'form saved');
  assert(r.json.form.h.coordinatorName === 'Rev. Mensah' && r.json.form.h.secretaryName === 'Grace Addo',
    'Section H names auto-filled from Section A roles');
  assert(r.json.form.d.q1.h === '34', 'answers stored');

  // PDF export
  let pdf = await call('cfl', 'GET', `/marriage/cases/${id}/form.pdf`, null, true);
  let buf = Buffer.from(await pdf.arrayBuffer());
  assert(pdf.status === 200 && buf.slice(0, 4).toString() === '%PDF', 'filled interview form PDF renders');
  fs.writeFileSync('/tmp/marriage-form.pdf', buf);

  // To Session
  r = await call('cfl', 'POST', `/marriage/cases/${id}/send-to-session`);
  assert(r.status === 200 && r.json.stage === 'with-session', 'marked as with Session');

  // Upload signed scan as page PHOTOS (merged into one PDF server-side)
  const img = fs.readFileSync(path.join(APP, 'public', 'img', 'logo.png'));
  const fd = new FormData();
  fd.append('pages', new Blob([img], { type: 'image/png' }), 'page-1.png');
  fd.append('pages', new Blob([img], { type: 'image/png' }), 'page-2.png');
  fd.append('pages', new Blob([img], { type: 'image/png' }), 'page-3.png');
  r = await call('cfl', 'POST', `/marriage/cases/${id}/signed`, fd);
  assert(r.status === 200 && r.json.stage === 'signed', 'photo pages uploaded → stage signed');
  assert(r.json.signedScan.pages === 3, 'three photos merged');

  // Signed PDF streams back
  pdf = await call('cfl', 'GET', `/marriage/cases/${id}/signed.pdf`, null, true);
  buf = Buffer.from(await pdf.arrayBuffer());
  assert(pdf.status === 200 && buf.slice(0, 4).toString() === '%PDF', 'signed scan streams as a real PDF');
  fs.writeFileSync('/tmp/marriage-signed.pdf', buf);

  // Locked after signing
  r = await call('cfl', 'PUT', `/marriage/cases/${id}/form`, { form });
  assert(r.status === 423, 'form locks once the signed copy is filed');

  // Outsider still blocked from the files
  r = await call('outsider', 'GET', `/marriage/cases/${id}/signed.pdf`, null, true);
  assert(r.status === 403, 'signed scan is confidential');

  // Second case: PDF-mode upload + mix rejection
  r = await call('cfl', 'POST', '/marriage/cases', { husbandName: 'A', wifeName: 'B' });
  const id2 = r.json.id;
  const fdMix = new FormData();
  fdMix.append('pages', new Blob([fs.readFileSync('/tmp/marriage-form.pdf')], { type: 'application/pdf' }), 'signed.pdf');
  fdMix.append('pages', new Blob([img], { type: 'image/png' }), 'p.png');
  r = await call('cfl', 'POST', `/marriage/cases/${id2}/signed`, fdMix);
  assert(r.status === 400 && /not a mix/i.test(r.json.error), 'PDF + photos mix rejected');
  const fdPdf = new FormData();
  fdPdf.append('pages', new Blob([fs.readFileSync('/tmp/marriage-form.pdf')], { type: 'application/pdf' }), 'signed.pdf');
  r = await call('cfl', 'POST', `/marriage/cases/${id2}/signed`, fdPdf);
  assert(r.status === 200 && r.json.stage === 'signed', 'ready-made PDF accepted too');

  // CFL team notified in their inbox that counselling is unlocked
  const inbox = await call('cfl', 'GET', '/inbox');
  assert(inbox.json.items.some(i => /Signed marriage form filed/.test(i.title)), 'unlock notification lands in CFL inbox');

  // List summaries
  r = await call('cfl', 'GET', '/marriage/cases');
  assert(r.json.length === 2 && r.json.every(k => k.couple && k.stage), 'case list summarises cleanly');

  console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
