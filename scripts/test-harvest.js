// End-to-end test of the Harvest module against an isolated copy of the app.
// Covers: method breakdown + reconciliation, forex dual totals, IOU register,
// submit → verify → approve → lock pipeline, decline flow, treasurer role,
// announcement/statement PDFs, and the IOU reminder cadence.
const APP = process.env.APP_DIR;
const BASE = `http://localhost:${process.env.PORT || 4321}`;
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exitCode = 1; } else console.log('ok  :', msg); };

const jars = {};
async function call(user, method, path, body, raw) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', cookie: jars[user] || '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) jars[user] = setCookie.split(';')[0];
  if (raw) return res;
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, json };
}
async function login(user, email, password) {
  const r = await call(user, 'POST', '/auth/login', { email, password });
  if (r.status !== 200 || (r.json && (r.json.mustChangePassword || r.json.twoFactorRequired))) {
    throw new Error(`login failed for ${email}: ${JSON.stringify(r.json)}`);
  }
}

(async () => {
  const iso = d => d.toISOString().slice(0, 10);
  const today = new Date();
  const plus = days => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() + days));

  await login('harvest', 'harvest@test.com', 'Password#12345');
  await login('clerk', 'accounts@test.com', 'Password#12345');
  await login('treasurer', 'treasurer@test.com', 'Password#12345');

  // Treasurer role sanity (defaults granted at creation by setup script)
  const meT = await call('treasurer', 'GET', '/auth/me');
  const tPerms = (meT.json && (meT.json.permissions || (meT.json.user || {}).permissions)) || [];
  assert(tPerms.includes('fundraising.approve'), 'treasurer role carries fundraising.approve');

  // Event
  const ev = await call('harvest', 'POST', '/fundraising/events', { name: 'Main Harvest', target: 100000 });
  assert(ev.status === 200 && ev.json.id, 'create fundraising event');
  const evId = ev.json.id;

  // --- Reconciliation must FAIL when methods don't match streams ---
  const cats1 = { gratitude: 1000, chairpersons: 500, dayborn: { Sunday: 700, Monday: 300, Tuesday: 0, Wednesday: 900, Thursday: 100, Friday: 250, Saturday: 250 } };
  // streams total = 4000
  let r = await call('harvest', 'PUT', '/fundraising/entries', {
    eventId: evId, date: '2026-07-12', service: '1st', categories: cats1,
    methods: { cash: 1000, cheque: 0, momo: 500 }, forex: [], ious: [],
  });
  assert(r.status === 400 && /reconcile/i.test(r.json.error || ''), 'mismatched methods rejected (short)');

  // --- Correct entry: cash 1000 + momo 500 + IOU 875 + USD 130 @ 12.50 (=1625) = 4000 ---
  r = await call('harvest', 'PUT', '/fundraising/entries', {
    eventId: evId, date: '2026-07-12', service: '1st', categories: cats1,
    methods: { cash: 1000, cheque: 0, momo: 500 },
    forex: [{ currency: 'usd', amount: 130, rate: 12.5 }],
    ious: [{ name: 'Kofi Mensah', contact: '0244000001', amount: 875, dueDate: plus(30) }],
  });
  assert(r.status === 200, '1st service entry with methods+forex+IOU saved');
  assert(r.json.forexGhs === 1625, `forexGhs computed (${r.json.forexGhs})`);
  assert(r.json.ghsSubtotal === 2375, `GHS subtotal cash+cheque+momo+IOU (${r.json.ghsSubtotal})`);
  assert(r.json.total === 4000, 'streams grand total (all-in GHS)');
  assert((r.json.forex[0] || {}).currency === 'USD', 'currency normalised to upper case');

  // IOU without due date must be rejected
  r = await call('harvest', 'PUT', '/fundraising/entries', {
    eventId: evId, date: '2026-07-12', service: '2nd', categories: { gratitude: 100, chairpersons: 0, dayborn: {} },
    methods: { cash: 0, cheque: 0, momo: 0 }, forex: [], ious: [{ name: 'Ama', contact: '', amount: 100, dueDate: '' }],
  });
  assert(r.status === 400 && /payment date/i.test(r.json.error || ''), 'IOU without proposed payment date rejected');

  // 2nd service, clean (no methods breakdown -> allowed)
  r = await call('harvest', 'PUT', '/fundraising/entries', {
    eventId: evId, date: '2026-07-12', service: '2nd',
    categories: { gratitude: 800, chairpersons: 200, dayborn: { Sunday: 0, Monday: 1000, Tuesday: 0, Wednesday: 0, Thursday: 0, Friday: 0, Saturday: 0 } },
  });
  assert(r.status === 200 && r.json.total === 2000, '2nd service entry (no breakdown) saved');

  // Overview: IOU register + outstanding stat
  let ov = await call('harvest', 'GET', '/fundraising/overview');
  assert(ov.json.ious.length === 1 && ov.json.ious[0].name === 'Kofi Mensah', 'IOU on the register');
  assert(ov.json.iouOutstanding === 875, 'IOU outstanding total');

  // --- Sign-off pipeline ---
  r = await call('harvest', 'POST', '/fundraising/verify-day', { eventId: evId, date: '2026-07-12' });
  assert(r.status === 403, 'Harvest cannot verify its own figures');
  r = await call('harvest', 'POST', '/fundraising/submit-day', { eventId: evId, date: '2026-07-12' });
  assert(r.status === 200, 'Harvest submits day for sign-off');
  r = await call('treasurer', 'POST', '/fundraising/approve-day', { eventId: evId, date: '2026-07-12' });
  assert(r.status === 400, 'Treasurer cannot approve before Accounts Clerk verifies');
  r = await call('clerk', 'POST', '/fundraising/verify-day', { eventId: evId, date: '2026-07-12' });
  assert(r.status === 200, 'Accounts Clerk verifies (level 1)');
  r = await call('harvest', 'PUT', '/fundraising/entries', { eventId: evId, date: '2026-07-12', service: '1st', categories: cats1 });
  assert(r.status === 423, 'entry locked after verification');
  r = await call('treasurer', 'POST', '/fundraising/approve-day', { eventId: evId, date: '2026-07-12' });
  assert(r.status === 200, 'Treasurer approves & locks (level 2)');
  ov = await call('harvest', 'GET', '/fundraising/overview');
  assert(ov.json.entries.every(e => e.status === 'confirmed'), 'entries confirmed & locked');

  // --- Decline flow on a second day ---
  r = await call('harvest', 'PUT', '/fundraising/entries', {
    eventId: evId, date: '2026-07-19', service: 'joint',
    categories: { gratitude: 500, chairpersons: 0, dayborn: { Sunday: 500, Monday: 0, Tuesday: 0, Wednesday: 0, Thursday: 0, Friday: 0, Saturday: 0 } },
    methods: { cash: 1000, cheque: 0, momo: 0 }, forex: [], ious: [],
  });
  assert(r.status === 200, 'joint day saved');
  await call('harvest', 'POST', '/fundraising/submit-day', { eventId: evId, date: '2026-07-19' });
  r = await call('clerk', 'POST', '/fundraising/decline-day', { eventId: evId, date: '2026-07-19', reason: '' });
  assert(r.status === 400, 'decline requires a reason');
  r = await call('clerk', 'POST', '/fundraising/decline-day', { eventId: evId, date: '2026-07-19', reason: 'Cash count disagrees with tellers sheet' });
  assert(r.status === 200, 'Accounts Clerk declines with reason');
  ov = await call('harvest', 'GET', '/fundraising/overview');
  const declined = ov.json.entries.find(e => e.date === '2026-07-19');
  assert(declined.status === 'pending' && declined.declined && /tellers/.test(declined.declined.reason), 'declined day back to pending with reason');

  // --- IOU mark-paid ---
  const iouId = ov.json.ious[0].id;
  r = await call('clerk', 'POST', `/fundraising/ious/${iouId}/paid`);
  assert(r.status === 200 && r.json.status === 'paid', 'IOU marked paid');
  ov = await call('harvest', 'GET', '/fundraising/overview');
  assert(ov.json.iouOutstanding === 0, 'outstanding drops to zero after payment');

  // --- PDFs ---
  let pdf = await call('harvest', 'GET', `/fundraising/announcement.pdf?eventId=${evId}&date=2026-07-12`, null, true);
  let buf = Buffer.from(await pdf.arrayBuffer());
  assert(pdf.status === 200 && buf.slice(0, 4).toString() === '%PDF', 'announcement PDF renders (ranked day-borns + methods + forex)');
  pdf = await call('harvest', 'GET', '/fundraising/statement.pdf?year=2026', null, true);
  buf = Buffer.from(await pdf.arrayBuffer());
  assert(pdf.status === 200 && buf.slice(0, 4).toString() === '%PDF', 'statement PDF renders (with IOU register)');

  // --- IOU reminder cadence (in-process, same data dir) ---
  const db = require(APP + '/utils/db');
  const { checkIouReminders } = require(APP + '/utils/reminders');
  const mk = (name, dueDate, createdAt) => {
    const rec = db.insert('fundraising_ious', {
      entryId: 999, eventId: evId, eventName: 'Main Harvest', year: 2026, date: '2026-07-12', service: '1st',
      name, contact: '0244123456', amount: 500, dueDate, status: 'outstanding', enteredBy: 'Test',
    });
    if (createdAt) db.update('fundraising_ious', rec.id, { createdAt }); // backdate (db stamps createdAt on insert)
    return rec;
  };
  mk('Due In 3', plus(3), new Date().toISOString());
  mk('Due Today', plus(0), new Date().toISOString());
  mk('Overdue 1wk', plus(-7), new Date().toISOString());
  mk('Halfway', plus(5), new Date(today.getFullYear(), today.getMonth(), today.getDate() - 5).toISOString()); // 10-day span, midpoint today
  await checkIouReminders(new Date());
  const logs = db.findAll('reminder_log', l => l.type === 'iou');
  const tags = logs.map(l => l.key.split(':')[2]).sort();
  assert(JSON.stringify(tags) === JSON.stringify(['d0', 'd3', 'half', 'over-1']), `reminder cadence fired: ${tags.join(', ')}`);
  await checkIouReminders(new Date());
  assert(db.findAll('reminder_log', l => l.type === 'iou').length === 4, 'reminders deduplicated on re-run');

  // --- Notification inbox ---
  // The submit/verify/approve/decline fan-outs above went through the push
  // chokepoint, so they must be sitting in the recipients' inboxes even
  // though push/SMS are unconfigured.
  let inbox = await call('clerk', 'GET', '/inbox');
  assert(inbox.status === 200 && inbox.json.items.length > 0, 'Accounts Clerk has inbox items');
  assert(inbox.json.items.some(i => /awaiting verification/i.test(i.title)), 'submit-day notification stored in clerk inbox');
  assert(inbox.json.unread > 0, 'clerk inbox shows unread count');
  const meC = await call('clerk', 'GET', '/auth/me');
  assert((meC.json.unreadNotifications || 0) === inbox.json.unread, '/auth/me unread count matches inbox');

  let tInbox = await call('treasurer', 'GET', '/inbox');
  assert(tInbox.json.items.some(i => /awaiting your approval/i.test(i.title)), 'verify-day notification stored in treasurer inbox');
  let hInbox = await call('harvest', 'GET', '/inbox');
  assert(hInbox.json.items.some(i => /APPROVED/.test(i.title)), 'approval notification stored in harvest inbox');
  assert(hInbox.json.items.some(i => /DECLINED/.test(i.title)), 'decline notification stored in harvest inbox');

  // mark one read, then all read
  const firstId = inbox.json.items.find(i => !i.readAt).id;
  r = await call('clerk', 'POST', '/inbox/read', { ids: [firstId] });
  assert(r.status === 200 && r.json.marked === 1, 'mark single notification read');
  r = await call('clerk', 'POST', '/inbox/read', {});
  assert(r.status === 200, 'mark all read');
  inbox = await call('clerk', 'GET', '/inbox');
  assert(inbox.json.unread === 0, 'unread drops to zero after mark-all');

  // isolation: the submit-day alert went to the CLERK, not back to Harvest
  assert(!hInbox.json.items.some(i => /awaiting verification/i.test(i.title)), 'inboxes are per-user (no cross-delivery)');
  const iouOfficerInbox = await call('harvest', 'GET', '/inbox');
  assert(iouOfficerInbox.json.items.some(i => /^IOU /.test(i.title)), 'IOU reminder also stored in officer inbox');

  console.log(process.exitCode ? '\nSOME TESTS FAILED' : '\nALL TESTS PASSED');
  process.exit(process.exitCode || 0);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
