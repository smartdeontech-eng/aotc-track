// Oct 2026 minutes work: tidy-up that cannot lose text, the house-style
// additions, "Decision:" lines and the decisions register, chairman signs,
// "The Session Clerk" in the review, learned short forms, "carry to Matters
// Arising", and continuing matters becoming updates. Claude is stubbed.
process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
process.env.ANTHROPIC_API_KEY = 'test-key';
const path = require('path'), fs = require('fs'); const root = process.env.HOME + '/mnt/aotc-track';
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const head = t => console.log('\n── ' + t);

// ---- stub Claude (and leave every other fetch alone) ----
const realFetch = global.fetch;
let reply = null, lastBody = null;
global.fetch = async (u, o) => {
  if (String(u).includes('anthropic.com')) { lastBody = JSON.parse(o.body); return { ok: true, json: async () => reply }; }
  return realFetch(u, o);
};
const authPath = require.resolve(path.join(root, 'middleware/auth')); const realAuth = require(authPath);
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { ...realAuth,
  requireAuth: (q, _r, n) => { q.user = { id: 1, role: 'admin', name: 'Clerk' }; n(); } } };
const db = require(path.join(root, 'utils/db'));
const SM = require(path.join(root, 'utils/sessionMinutes'));
const ai = require(path.join(root, 'utils/aiAssist'));

// ---- a small Session ----
fs.writeFileSync(process.env.AOTC_DATA_DIR + '/users.json', JSON.stringify([{ id: 1, name: 'Clerk', role: 'admin', email: 'c@t', permissions: [] }]));
const roster = [
  { id: 1, name: 'Kofi Manukure Akyeampong', titles: ['Rev'], position: 'District Minister', office: 'district_minister', rank: 1 },
  { id: 2, name: 'Martin Owusu Boamah', titles: ['Rev', 'Dr'], position: 'Senior Presbyter', rank: 2 },
  { id: 3, name: 'Gideon Adjiereh Adjei', titles: ['Mr'], position: 'Session Clerk', office: 'session_clerk', rank: 3 },
  { id: 4, name: 'Nicholas A. Tweneboa', titles: ['Dr'], position: 'Member', rank: 4 },
];
fs.writeFileSync(process.env.AOTC_DATA_DIR + '/session_members.json', JSON.stringify(roster));
['minutes_docs', 'session_matters', 'office_terms'].forEach(c => fs.writeFileSync(`${process.env.AOTC_DATA_DIR}/${c}.json`, '[]'));

const express = require(path.join(root, 'node_modules/express'));
const app = express(); app.use(express.json({ limit: '5mb' }));
app.use('/api/minutes', require(path.join(root, 'routes/minutes')));

(async () => {
  head('Tidy-up never loses the notes');
  const notes = Array.from({ length: 1100 }, (_, i) => (i % 12 === 11 ? 'end.' : 'word')).join(' ');
  reply = { content: [{ type: 'text', text: 'Half of the minute' }], stop_reason: 'max_tokens' };
  let err = null; try { await ai.polishNotes({ notes, subject: 'Address', people: [] }); } catch (e) { err = e; }
  ok(err && err.status === 502 && /NOT been changed/.test(err.message), 'an answer cut off at the length cap is refused — no half-text comes back');
  ok(lastBody.max_tokens >= 4000, `the cap grows with the notes (${lastBody.max_tokens} for ~1,100 words; was a flat 2000)`);
  reply = { content: [{ type: 'text', text: 'Far too short.' }], stop_reason: 'end_turn' };
  let r = await ai.polishNotes({ notes, subject: 'x', people: [] });
  ok(r.suspectShort === true, 'a result much shorter than the notes is flagged, so the page asks first');
  reply = { content: [{ type: 'text', text: notes }], stop_reason: 'end_turn' };
  r = await ai.polishNotes({ notes, subject: 'x', people: [{ full: 'Dr Nicholas A. Tweneboa', short: 'Dr. Nicholas A. Tweneboa' }], meetingDate: '2026-09-24' });
  const sys = lastBody.system;
  ok(!r.suspectShort, 'a full-length result is not flagged');
  ok(/short: Dr\. Nicholas A\. Tweneboa/.test(sys), 'a member’s own short form is handed to the tidy-up');
  ok(/it is 2026/.test(sys) && /October 2026/.test(sys), 'a month with no year takes the meeting’s year');
  ok(/Decision:/.test(sys) && /THE CLERK'S OWN INSTRUCTIONS/.test(sys) && /session clock/.test(sys) && /FIRST MENTION IN THE ITEM/.test(sys), 'the house style now covers Decision lines, bracketed instructions, "session clock", and short names after the first mention');

  ok(lastBody.thinking && lastBody.thinking.type === 'enabled' && lastBody.thinking.budget_tokens >= 2048, `the tidy-up thinks first (budget ${lastBody.thinking && lastBody.thinking.budget_tokens} tokens)`);
  ok(lastBody.max_tokens > lastBody.thinking.budget_tokens + 2000, 'and the answer still has its full room on top of the thinking');
  {
    let calls = 0;
    const keep = global.fetch;
    global.fetch = async (u, o) => { calls++; const b = JSON.parse(o.body); if (b.thinking) return { ok: false, status: 400, json: async () => ({ error: { message: 'thinking is not supported for this model' } }) }; lastBody = b; return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'word '.repeat(900) }], stop_reason: 'end_turn' }) }; };
    const r2 = await ai.polishNotes({ notes, subject: 'x', people: [] });
    ok(calls === 2 && !lastBody.thinking && r2.text, 'if thinking is refused, it quietly tries again without');
    global.fetch = keep;
  }
  reply = { content: [{ type: 'thinking', thinking: 'Let me work out who said what…' }, { type: 'text', text: notes }], stop_reason: 'end_turn' };
  r = await ai.polishNotes({ notes, subject: 'x', people: [] });
  ok(!/work out who said/.test(r.text), 'the thinking itself never ends up in the minutes');

  ok(/LEARNED FROM THE PROOFREADING/.test(sys) && /allocated to Presbyters/.test(sys) && /Needy Fund/.test(sys), 'the proofreader\u2019s corrections to the 24 Sept minutes are part of the house style');

  head('Times read "6:30 pm"');
  ok(SM.minuteTime('6.32 p.m.') === '6:32 pm' && SM.minuteTime('18:32') === '6:32 pm' && SM.minuteTime('6:32PM') === '6:32 pm', 'any typed or stamped time prints as "6:32 pm"');
  ok(SM.minuteTime('around six') === 'around six', 'something that is not a time is left alone');
  ok(/The meeting commenced at 6:32 pm\./.test(SM.renderRows({ ...SM.newMinutesDoc({ date: '2026-09-24' }), proceedings: { commencedAt: '6.32 p.m.' } }, { members: [] }).map(r => r.body).join(' ')), 'minutes recorded in the old form print in the new one');
  ok(/"6:30 pm"/.test(require(path.join(root, 'utils/minutesHouseStyle'))), 'and the tidy-up is told the same');

  head('Decision lines');
  const lines = SM.bulletise('Discussion.\nDecision: The Session agreed to move the prayer meeting.\nMore.');
  ok(lines[1].decision && !lines[0].decision, 'a "Decision:" line is picked out');
  const pr = SM.bulletise('Prayed on:\nOne\nTwo\nDecision: The Session agreed.');
  ok(pr[3].decision && !pr[3].bullet, 'a decision after a prayer list is not swallowed into the list');

  // ---- two meetings ----
  const d1 = db.insert('minutes_docs', { ...SM.newMinutesDoc({ date: '2026-08-27' }) });
  const d2base = SM.newMinutesDoc({ date: '2026-09-24' });
  d2base.proceedings = { ...(d2base.proceedings || {}), constitutedBy: 'Rev Dr Martin Owusu Boamah' };
  d2base.reviews = [{ date: '27th August 2026', readBy: 'Mr G. A. Adjei', movedBy: 'A', secondedBy: 'B', corrections: [] }];
  const d2 = db.insert('minutes_docs', d2base);
  const other = (d2.sections || []).find(s => s.key === 'other') || (d2.sections || []).find(s => SM.meta ? true : true);

  const server = app.listen(0, async () => {
    const base = `http://127.0.0.1:${server.address().port}/api/minutes`;
    const call = async (method, url, body) => { const r = await realFetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const ct = r.headers.get('content-type') || ''; return { status: r.status, body: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }; };

    head('Review of minutes, and who signs');
    const rows = SM.renderRows(db.findById('minutes_docs', d2.id), { members: roster });
    const rev = rows.find(x => /led the Session to review/.test(x.body || ''));
    ok(rev && /^The Session Clerk led the Session/.test(rev.body), 'when the Session Clerk led the review, the minutes say "The Session Clerk", not his name');
    const rows2 = SM.renderRows({ ...d2, reviews: [{ ...d2.reviews[0], readBy: 'Dr Nicholas A. Tweneboa' }] }, { members: roster });
    ok(rows2.some(x => /^Dr Nicholas A\. Tweneboa led the Session/.test(x.body || '')), 'anyone else is still named');
    const docx = await call('GET', `/${d2.id}/minutes.docx`);
    let xml = '';
    try { const JSZip = require(path.join(root, 'node_modules/jszip')); xml = await (await JSZip.loadAsync(docx.body)).file('word/document.xml').async('string'); } catch (e) { xml = docx.body.toString('latin1'); }
    ok(docx.status === 200 && /Martin Owusu Boamah/.test(xml) && /Chairman/.test(xml), 'the exported minutes are confirmed by the chairman of the meeting (Rev Dr Martin Owusu Boamah)');
    ok(!/Minister-in-Charge/.test(xml), '…not by the minister in charge, who did not chair');

    head('Original notes are kept for good');
    {
      const k0 = db.findById('minutes_docs', d1.id).sections[5].key;
      await call('PUT', `/${d1.id}/section`, { key: k0, children: [{ subject: 'X', body: 'Tidied text.', rawNotes: 'my rough notes as typed', aiText: 'Tidied text.', tidiedAt: '2026-10-07T10:00:00.000Z', tidiedWords: 2 }] });
      const ch = db.findById('minutes_docs', d1.id).sections.find(x => x.key === k0).children[0];
      ok(ch.rawNotes === 'my rough notes as typed' && ch.aiText === 'Tidied text.' && ch.tidiedAt, 'the notes typed before a tidy-up are saved with the item, beside the tidy-up\u2019s own text');
      await call('PUT', `/${d1.id}/section`, { key: k0, children: [{ subject: 'X', body: 'Tidied text, corrected.', rawNotes: 'my rough notes as typed', aiText: 'Tidied text.', tidiedAt: '2026-10-07T10:00:00.000Z', tidiedWords: 2 }] });
      ok(db.findById('minutes_docs', d1.id).sections.find(x => x.key === k0).children[0].rawNotes === 'my rough notes as typed', '\u2026and survive later edits and saves');
      const rowsOut = SM.renderRows(db.findById('minutes_docs', d1.id), { members: roster });
      ok(!rowsOut.some(x => /rough notes/.test(x.body || '')), 'they are never printed in the minutes');
      await call('PUT', `/${d1.id}/section`, { key: k0, children: [] });
    }

    head('Carry to Matters Arising');
    const sec2 = db.findById('minutes_docs', d2.id).sections.find(s => !(s.children) || true);
    const key = db.findById('minutes_docs', d1.id).sections[5].key;
    // put an item into each meeting under the same section
    const put = async (doc, children) => call('PUT', `/${doc.id}/section`, { key, children });
    await put(d1, [{ subject: 'Letter to the contractor', body: 'A letter was to be written to the contractor.', action: 'Write to contractor' }]);
    await put(d2, [{ subject: 'Letter to contractor', body: 'The letter had been drafted and would be sent this week.' }, { subject: 'Church bus', body: 'The bus needed new tyres.' }]);
    let c = await call('POST', `/${d1.id}/to-matters`, { key, ci: 0, on: true });
    ok(c.status === 200 && c.body.toMatters.kind === 'new' && db.findAll('session_matters').length === 1, 'August: the item goes into the register as a new matter');
    c = await call('POST', `/${d2.id}/to-matters`, { key, ci: 0, on: true });
    const m1 = db.findAll('session_matters')[0];
    ok(c.body.toMatters.kind === 'update' && db.findAll('session_matters').length === 1 && m1.updates.length === 1, 'September: the same matter becomes an UPDATE to it, not a second entry');
    ok(/drafted/.test(m1.updates[0].note) && m1.updates[0].meetingId === d2.id, 'the update carries what September said, and which meeting');
    c = await call('POST', `/${d2.id}/to-matters`, { key, ci: 1, on: true });
    ok(c.body.toMatters.kind === 'new' && db.findAll('session_matters').length === 2, 'an unrelated item is a new matter');
    ok(db.findById('minutes_docs', d2.id).sections.find(s => s.key === key).children[0].toMatters.kind === 'update', 'the minutes item remembers its link');
    await put(db.findById('minutes_docs', d2.id), db.findById('minutes_docs', d2.id).sections.find(s => s.key === key).children);
    ok(db.findById('minutes_docs', d2.id).sections.find(s => s.key === key).children[0].toMatters, 'and keeps it through a later save');
    c = await call('POST', `/${d2.id}/to-matters`, { key, ci: 0, on: false });
    ok(db.findById('session_matters', m1.id).updates.length === 0, 'unticking takes the update back out');
    c = await call('POST', `/${d2.id}/to-matters`, { key, ci: 1, on: false });
    ok(db.findAll('session_matters').length === 1, 'unticking a new matter removes it again');

    head('Bringing in from minutes: continuing matters are updates');
    reply = { content: [{ type: 'text', text: JSON.stringify({ matters: [
      { heading: 'Building', subject: 'Letter to contractor', detail: 'Drafted; to be sent this week.', owner: '', status: 'in-progress', continues: m1.id },
      { heading: 'Transport', subject: 'Church bus tyres', detail: 'New tyres needed.', owner: '', status: 'open' },
    ] }) }], stop_reason: 'end_turn' };
    let p = await call('POST', `/matters/propose/${d2.id}`);
    ok(/MATTERS ALREADY IN THE REGISTER/.test(lastBody.system) && lastBody.system.includes(`[${m1.id}]`), 'the AI reading is shown the open register');
    const f0 = p.body.found[0], f1 = p.body.found[1];
    ok(f0.updateOf && f0.updateOf.id === m1.id && !f1.updateOf, 'the continuing matter comes back as an update; the new one as new');
    let a = await call('POST', `/matters/from/${d2.id}`, { matters: p.body.found });
    ok(a.body.added === 1 && a.body.updated === 1, '"Add" adds one and updates one');
    ok(db.findById('session_matters', m1.id).status === 'in-progress', 'the update moves the matter forward');
    a = await call('POST', `/matters/from/${d2.id}`, { matters: p.body.found });
    ok(a.body.added === 0 && a.body.updated === 0, 'adding again from the same minutes doubles nothing');
    p = await call('POST', `/matters/propose/${d2.id}`);
    ok(p.body.found[0].already === true, 'a second reading shows it as already updated from these minutes');
    reply = { content: [{ type: 'text', text: JSON.stringify({ matters: [{ heading: 'Building', subject: 'Letter to contractor', detail: 'x', status: 'open', continues: m1.id }] }) }], stop_reason: 'end_turn' };
    const d3 = db.insert('minutes_docs', SM.newMinutesDoc({ date: '2026-10-08' }));
    p = await call('POST', `/matters/propose/${d3.id}`);
    await call('POST', `/matters/from/${d3.id}`, { matters: p.body.found });
    ok(db.findById('session_matters', m1.id).status === 'in-progress', 'a later reading that says "open" never moves a matter backwards');

    head('Decisions register');
    await put(db.findById('minutes_docs', d2.id), [{ subject: 'Prayer meeting', body: 'Rev Akyeampong recommended a change.\nDecision: The Session agreed to move the Tuesday prayer meeting to Wednesday mornings.' }]);
    await put(db.findById('minutes_docs', d1.id), [{ subject: 'Bus', body: 'Discussion of the bus. After deliberation, the Session agreed that the bus be serviced.' }]);
    const dec = await call('GET', '/decisions');
    const labelled = dec.body.decisions.find(x => x.labelled);
    ok(labelled && /Wednesday mornings/.test(labelled.text) && labelled.date === '2026-09-24', 'every "Decision:" line is gathered, with its meeting');
    ok(dec.body.decisions.some(x => !x.labelled && /bus be serviced/.test(x.text)), 'older minutes are read for "the Session agreed" sentences too');
    const q = await call('GET', '/decisions?q=prayer');
    ok(q.body.decisions.length === 1, 'and the register can be searched');
    const dx = await call('GET', `/${d2.id}/minutes.docx`);
    let dxml = ''; try { const JSZip = require(path.join(root, 'node_modules/jszip')); dxml = await (await JSZip.loadAsync(dx.body)).file('word/document.xml').async('string'); } catch (e) {}
    ok(/<w:i\/>[\s\S]{0,200}?Decision:/.test(dxml) || /<w:i\/><w:iCs\/>[\s\S]{0,200}?Decision:/.test(dxml), 'in the Word minutes "Decision:" is set in italics');
    const pdf = await call('GET', `/${d2.id}/minutes.pdf`);
    ok(pdf.status === 200 && pdf.body.slice(0, 4).toString() === '%PDF', 'the PDF minutes build with a Decision line in them');

    head('Short forms learned from the Clerk’s corrections');
    await put(db.findById('minutes_docs', d2.id), [{ subject: 'Report', body: 'Dr Nicholas A. Tweneboa reported. Dr Tweneboa added that all was well.', tidiedWords: 11 }]);
    await put(db.findById('minutes_docs', d2.id), [{ subject: 'Report', body: 'Dr Nicholas A. Tweneboa reported. Dr. Nicholas A. Tweneboa added that all was well.', tidiedWords: 11 }]);
    const tw = db.findById('session_members', 4);
    ok(tw.shortForm === 'Dr. Nicholas A. Tweneboa' && tw.shortFormSource === 'learned', 'correcting "Dr Tweneboa" by hand teaches the app his own short form');
    db.update('session_members', 4, { shortForm: 'Dr Tweneboa', shortFormSource: 'manual' });
    await put(db.findById('minutes_docs', d2.id), [{ subject: 'Report', body: 'Dr Nicholas A. Tweneboa reported. Doc Tweneboa added.', tidiedWords: 5 }]);
    ok(db.findById('session_members', 4).shortForm === 'Dr Tweneboa', 'a short form typed in on the roster is never overwritten by learning');

    head('Tidy-up: paragraphs with no empty line between them');
    ok(ai.tightParagraphs('Para one.\n\nPara two.\n\n\nDecision: Yes.') === 'Para one.\nPara two.\nDecision: Yes.', 'blank lines between paragraphs are removed');
    ok(ai.tightParagraphs('The Session prayed for:\nthe sick\n\nFollowing the prayers, he spoke.\n\nNext.') === 'The Session prayed for:\nthe sick\n\nFollowing the prayers, he spoke.\nNext.', 'except the one that ends an unmarked list, so the next line stays prose');
    ok(ai.tightParagraphs('Intro:\n- a\n\nAfter.') === 'Intro:\n- a\nAfter.', 'a list marked with "-" needs no blank line, so none is kept');
    console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
    server.close(); process.exit(fail ? 1 : 0);
  });
})().catch(e => { console.error(e); process.exit(1); });
