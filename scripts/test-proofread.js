// Proofreading round-trip (Oct 2026): export the minutes to Word, put tracked
// changes and a comment into that file as a proofreader would, upload it, and
// check the changes land in the minutes and the comment becomes a directive.
// Claude is stubbed. Throwaway data in $HOME/sbx.
process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
process.env.ANTHROPIC_API_KEY = 'test-key';
const path = require('path'), fs = require('fs'); const root = process.env.HOME + '/mnt/aotc-track';
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const head = t => console.log('\n── ' + t);
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
const PR = require(path.join(root, 'utils/proofread'));
const JSZip = require(path.join(root, 'node_modules/jszip'));
fs.writeFileSync(process.env.AOTC_DATA_DIR + '/users.json', JSON.stringify([{ id: 1, name: 'Clerk', role: 'admin', email: 'c@t', permissions: [] }]));
fs.writeFileSync(process.env.AOTC_DATA_DIR + '/session_members.json', JSON.stringify([{ id: 3, name: 'Gideon Adjei', titles: ['Mr'], position: 'Session Clerk', office: 'session_clerk', rank: 1 }]));
['minutes_docs', 'session_matters', 'office_terms', 'minutes_proofreads', 'house_style_rules'].forEach(c => fs.writeFileSync(`${process.env.AOTC_DATA_DIR}/${c}.json`, '[]'));
const express = require(path.join(root, 'node_modules/express'));
const app = express(); app.use(express.json());
app.use('/api/minutes', require(path.join(root, 'routes/minutes')));

const doc = db.insert('minutes_docs', SM.newMinutesDoc({ date: '2026-09-24' }));
const key = doc.sections.find(s => s.key === 'other').key;
const P1 = 'The Session Clerk informed the Session that the data was already available, and explained that distant members had been divided amongst Presbyters.';
const P2 = 'He added that he was yet to follow up with finance to complete the purchase.';
const P3 = 'The legal team was to be shared with Head Office.';
db.update('minutes_docs', doc.id, { sections: db.findById('minutes_docs', doc.id).sections.map(s => s.key === key ? { ...s, children: [{ subject: 'Distant members', body: P1 + '\n' + P2 }, { subject: 'Legal', body: P3 }] } : s) });

const server = app.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}/api/minutes`;
  const call = async (method, url, body) => { const r = await realFetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };

  // 1. export, 2. "proofread" it
  const ex = await realFetch(`${base}/${doc.id}/minutes.docx`);
  const zip = await JSZip.loadAsync(Buffer.from(await ex.arrayBuffer()));
  let xml = await zip.file('word/document.xml').async('string');
  const A = 'w:id="900" w:author="Dr. N. Tweneboa" w:date="2026-10-01T10:00:00Z"';
  const run = t => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
  const para = (inner) => inner;
  const swap = (whole, html) => { const i = xml.indexOf(whole); if (i < 0) return false; xml = xml.slice(0, i) + html + xml.slice(i + whole.length); return true; };
  // find each paragraph's text run and replace it with tracked runs
  const findRun = text => { const m = xml.match(new RegExp(`<w:r>(?:(?!<w:r>)[\\s\\S])*?<w:t[^>]*>${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</w:t></w:r>`)); return m && m[0]; };
  const r1 = findRun(P1), r2 = findRun(P2), r3 = findRun(P3);
  ok(r1 && r2 && r3, 'the exported Word file carries the three paragraphs');
  swap(r1, run('The Session Clerk informed the Session that the data was already available') + `<w:del ${A}><w:r><w:delText>, and</w:delText></w:r></w:del><w:ins ${A}>${run(' and')}</w:ins>` + run(' explained that distant members had been ') + `<w:del ${A}><w:r><w:delText>divided amongst</w:delText></w:r></w:del><w:ins ${A}>${run('allocated to')}</w:ins>` + run(' Presbyters.'));
  swap(r2, run('He added that he was yet to follow up with ') + `<w:del ${A}><w:r><w:delText>finance</w:delText></w:r></w:del><w:ins ${A}>${run('Finance')}</w:ins>` + run(' to complete the purchase.'));
  swap(r3, run('The legal team was to be shared ') + '<w:commentRangeStart w:id="8"/>' + run('with Head Office') + '<w:commentRangeEnd w:id="8"/>' + run('.'));
  zip.file('word/document.xml', xml);
  zip.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="8" w:author="Dr. N. Tweneboa"><w:p><w:r><w:t>Perhaps “shared with the legal teams of the Presbytery and Head Office”?</w:t></w:r></w:p></w:comment></w:comments>`);
  const proofed = await zip.generateAsync({ type: 'nodebuffer' });

  head('Upload');
  const fd = new FormData(); fd.append('docx', new Blob([proofed]), 'proofread.docx');
  let r = await realFetch(`${base}/${doc.id}/proofread`, { method: 'POST', body: fd }); let pr = await r.json();
  ok(r.status === 201, 'the proofread file is accepted');
  ok(pr.proofreader === 'Dr. N. Tweneboa', 'the proofreader is named');
  ok(pr.changes.length === 2 && pr.comments.length === 1, `two changed paragraphs and one comment found (${pr.changes.length}, ${pr.comments.length})`);
  ok(pr.corrections === 3, `three corrections counted, a deletion and its replacement as one (${pr.corrections})`);
  ok(pr.changes.every(c => c.at.match === 'exact' && c.at.no), 'each change is matched to its item');
  ok(pr.comments[0].anchor === 'with Head Office' && /legal teams/.test(pr.comments[0].text), 'the comment comes with the words it was made on');
  ok(typeof pr.rate === 'number' && pr.rate > 0, `a corrections-per-1,000-words figure (${pr.rate})`);
  ok(pr.changes.every(c => Number.isInteger(c.para)) && Number.isInteger(pr.comments[0].para), 'each change and comment keeps its place in the document (para), for ordering the review list');

  head('Accepting changes writes them into the minutes');
  r = await call('POST', `/proofreads/${pr.id}/changes/${pr.changes[0].id}`, { action: 'accept' });
  let body = db.findById('minutes_docs', doc.id).sections.find(s => s.key === key).children[0].body;
  ok(r.status === 200 && body.split('\n')[0] === 'The Session Clerk informed the Session that the data was already available and explained that distant members had been allocated to Presbyters.', 'the accepted paragraph is now the corrected text in the app');
  ok(body.split('\n')[1] === P2, 'the other paragraph of the same item is untouched');
  r = await call('POST', `/proofreads/${pr.id}/changes/${pr.changes[0].id}`, { action: 'accept' });
  ok(r.status === 409, 'accepting twice is refused (the text no longer matches)');

  head('Undo');
  r = await call('POST', `/proofreads/${pr.id}/changes/${pr.changes[0].id}`, { action: 'undo' });
  body = db.findById('minutes_docs', doc.id).sections.find(s => s.key === key).children[0].body;
  ok(r.status === 200 && r.body.changes[0].status === 'pending' && body.split('\n')[0] === P1, 'undoing an accept puts the paragraph back as exported and the change back to pending');
  r = await call('POST', `/proofreads/${pr.id}/changes/${pr.changes[0].id}`, { action: 'accept' });
  ok(r.status === 200 && db.findById('minutes_docs', doc.id).sections.find(s => s.key === key).children[0].body.startsWith('The Session Clerk informed the Session that the data was already available and explained'), '…and it can be accepted again');
  r = await call('POST', `/proofreads/${pr.id}/changes/${pr.changes[1].id}`, { action: 'reject' });
  r = await call('POST', `/proofreads/${pr.id}/changes/${pr.changes[1].id}`, { action: 'undo' });
  ok(r.status === 200 && r.body.changes[1].status === 'pending', 'undoing a reject returns it to pending, text untouched');
  ok(db.findById('minutes_docs', doc.id).sections.find(s => s.key === key).children[0].body.split('\n')[1] === P2, '…the rejected paragraph never moved');
  // edit the accepted paragraph by hand, then try to undo: must be refused, edit kept
  const handEdit = s2 => db.update('minutes_docs', doc.id, { sections: db.findById('minutes_docs', doc.id).sections.map(s => s.key === key ? { ...s, children: s.children.map((c, i) => i === 0 ? { ...c, body: s2(c.body) } : c) } : s) });
  handEdit(b => b.replace('allocated to Presbyters', 'allocated to the Presbyters'));
  r = await call('POST', `/proofreads/${pr.id}/changes/${pr.changes[0].id}`, { action: 'undo' });
  ok(r.status === 409 && /edited since/.test(r.body.error), 'undoing an accept after the paragraph was edited is refused (409)');
  ok(/allocated to the Presbyters/.test(db.findById('minutes_docs', doc.id).sections.find(s => s.key === key).children[0].body), '…and the hand edit is kept');
  handEdit(b => b.replace('allocated to the Presbyters', 'allocated to Presbyters'));
  // edit the item by hand, then try the second change
  db.update('minutes_docs', doc.id, { sections: db.findById('minutes_docs', doc.id).sections.map(s => s.key === key ? { ...s, children: s.children.map((c, i) => i === 0 ? { ...c, body: c.body.replace('yet to follow up', 'still to follow up') } : c) } : s) });
  r = await call('POST', `/proofreads/${pr.id}/changes/${pr.changes[1].id}`, { action: 'accept' });
  // Nov 2026: Accept on a paragraph edited since the export amends just his
  // marked words in the Clerk's wording, instead of refusing.
  {
    const line1 = db.findById('minutes_docs', doc.id).sections.find(s => s.key === key).children[0].body.split('\n')[1];
    ok(r.status === 200 && r.body.amended && r.body.changes[1].status === 'merged' && line1 === 'He added that he was still to follow up with Finance to complete the purchase.', 'Accept on a paragraph edited since export amends just his marked words, keeping the Clerk\'s edit');
    r = await call('POST', `/proofreads/${pr.id}/changes/${pr.changes[1].id}`, { action: 'undo' });
    ok(r.status === 200 && r.body.changes[1].status === 'pending', '…and can be undone back to the Clerk\'s wording');
  }
  head('Edited since export: his corrections merged into the newer wording');
  r = await call('GET', `/${doc.id}/proofreads`);
  let mc = r.body[0].changes[1];
  ok(mc.at.match === 'close' && mc.merge && mc.merge.current === 'He added that he was still to follow up with finance to complete the purchase.', 'the screen is given the Clerk\'s current wording');
  ok(mc.merge.text === 'He added that he was still to follow up with Finance to complete the purchase.' && mc.merge.applied === 1 && !mc.merge.failed.length, 'and his correction merged into it, keeping the Clerk\'s own edit');
  r = await call('POST', `/proofreads/${pr.id}/changes/${pr.changes[1].id}`, { action: 'merge' });
  let lineNow = () => db.findById('minutes_docs', doc.id).sections.find(s => s.key === key).children[0].body.split('\n')[1];
  ok(r.status === 200 && r.body.changes[1].status === 'merged' && lineNow() === 'He added that he was still to follow up with Finance to complete the purchase.', 'Merge writes the merged text into the minutes');
  r = await call('POST', `/proofreads/${pr.id}/changes/${pr.changes[1].id}`, { action: 'undo' });
  ok(r.status === 200 && r.body.changes[1].status === 'pending' && lineNow() === 'He added that he was still to follow up with finance to complete the purchase.', 'Undo puts the Clerk\'s wording back');
  ok(PR.mergeSegs('Completely different words.', mc.segs).failed.length === 1, 'a correction whose words are gone is reported, not guessed');
  r = await call('POST', `/proofreads/${pr.id}/accept-all`, { merge: true });
  ok(r.status === 200 && r.body.accepted === 1 && r.body.proofread.changes[1].status === 'merged', '"Merge all that fit" merges it too');
  r = await call('POST', `/proofreads/${pr.id}/changes/${pr.changes[1].id}`, { action: 'undo' });
  r = await call('POST', `/proofreads/${pr.id}/changes/${pr.changes[1].id}`, { action: 'done' });
  ok(r.body.changes[1].status === 'done-by-hand', '…and can mark it done');

  head('A comment, a directive, and the fix');
  reply = { content: [{ type: 'text', text: 'The legal team was to be shared with the legal teams of the Presbytery and Head Office.' }], stop_reason: 'end_turn' };
  r = await call('POST', `/proofreads/${pr.id}/comments/1/propose`, { directive: 'Use his wording.' });
  ok(r.status === 200 && /Presbytery and Head Office/.test(r.body.comments[0].proposal), 'the directive produces a proposed paragraph');
  const sent = lastBody.messages[0].content[0].text;
  ok(/Use his wording/.test(sent) && /legal teams of the Presbytery/.test(sent) && /with Head Office/.test(sent), 'Claude is given the paragraph, the comment, the words it was on, and the directive');
  r = await call('POST', `/proofreads/${pr.id}/comments/1/resolve`, { action: 'apply', directive: 'Use his wording.' });
  body = db.findById('minutes_docs', doc.id).sections.find(s => s.key === key).children[1].body;
  ok(r.status === 200 && body === 'The legal team was to be shared with the legal teams of the Presbytery and Head Office.', 'applying it puts the new paragraph into the minutes');
  ok(r.body.comments[0].status === 'applied' && r.body.comments[0].directive === 'Use his wording.', 'the directive is kept with the comment');
  ok(r.body.pending === 0, 'nothing left pending');
  r = await call('POST', `/proofreads/${pr.id}/comments/1/resolve`, { action: 'undo' });
  body = db.findById('minutes_docs', doc.id).sections.find(s => s.key === key).children[1].body;
  ok(r.status === 200 && body === P3 && r.body.comments[0].status === 'pending', 'undoing an applied comment puts the paragraph back');
  ok(r.body.comments[0].directive === 'Use his wording.' && /Presbytery/.test(r.body.comments[0].proposal), '…keeping the directive and the draft for reuse');
  r = await call('POST', `/proofreads/${pr.id}/comments/1/resolve`, { action: 'apply' });
  ok(r.status === 200 && r.body.comments[0].status === 'applied', '…and the draft can be applied again');
  db.update('minutes_docs', doc.id, { sections: db.findById('minutes_docs', doc.id).sections.map(s => s.key === key ? { ...s, children: s.children.map((c, i) => i === 1 ? { ...c, body: c.body + ' It was agreed.' } : c) } : s) });
  r = await call('POST', `/proofreads/${pr.id}/comments/1/resolve`, { action: 'undo' });
  ok(r.status === 409, 'undoing an applied comment after a hand edit is refused (409)');

  head('Lessons for the tidy-up');
  reply = { content: [{ type: 'text', text: JSON.stringify({ rules: [{ rule: 'Capitalise Finance when it means the Finance Committee.', wrong: 'follow up with finance', right: 'follow up with Finance', times: 1 }] }) }], stop_reason: 'end_turn' };
  r = await call('POST', `/proofreads/${pr.id}/lessons`);
  ok(r.status === 200 && r.body.lessons.length === 1 && lastBody.thinking, 'rules are suggested from the corrections');
  r = await call('POST', `/proofreads/${pr.id}/lessons/1`, { approve: true });
  ok(db.findAll('house_style_rules').length === 1, 'approving puts the rule into the house style');
  reply = { content: [{ type: 'text', text: 'word '.repeat(60) }], stop_reason: 'end_turn' };
  await call('POST', '/polish', { notes: 'word '.repeat(60), subject: 'x', docId: doc.id });
  ok(/RULES THE SESSION CLERK APPROVED/.test(lastBody.system) && /Capitalise Finance/.test(lastBody.system), 'and the very next tidy-up follows it — no deploy needed');
  const tr = await call('GET', '/proofreads/trend');
  ok(tr.status === 200 && tr.body.length === 1 && tr.body[0].date === '2026-09-24', 'the trend lists the meeting with its rate');

  head('Bullet points and item headings get Accept too');
  const doc2 = db.insert('minutes_docs', SM.newMinutesDoc({ date: '2026-10-01' }));
  db.update('minutes_docs', doc2.id, { sections: db.findById('minutes_docs', doc2.id).sections.map(s => s.key === key ? { ...s, children: [{ subject: 'Distant members', body: 'The Session prayed for:\n- the bereaved' }] } : s) });
  const ex2 = await realFetch(`${base}/${doc2.id}/minutes.docx`);
  const zip2 = await JSZip.loadAsync(Buffer.from(await ex2.arrayBuffer()));
  let x2 = await zip2.file('word/document.xml').async('string');
  const sw2 = (w, h) => { const i = x2.indexOf(w); if (i < 0) return false; x2 = x2.slice(0, i) + h + x2.slice(i + w.length); return true; };
  ok(sw2('<w:t xml:space="preserve">the bereaved</w:t>', `<w:t xml:space="preserve">the bereaved</w:t></w:r><w:ins ${A}><w:r><w:t xml:space="preserve"> families</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"></w:t>`), 'tracked change put into a bullet point');
  ok(sw2('<w:t xml:space="preserve">Other Matters I: Distant members</w:t>', `<w:t xml:space="preserve">Other Matters I: Distant </w:t></w:r><w:del ${A}><w:r><w:delText>members</w:delText></w:r></w:del><w:ins ${A}><w:r><w:t xml:space="preserve">Members</w:t></w:r></w:ins><w:r><w:t xml:space="preserve"></w:t>`), 'and into the item heading');
  zip2.file('word/document.xml', x2);
  const fd3 = new FormData(); fd3.append('docx', new Blob([await zip2.generateAsync({ type: 'nodebuffer' })]), 'p2.docx');
  r = await realFetch(`${base}/${doc2.id}/proofread`, { method: 'POST', body: fd3 }); const pr2 = await r.json();
  const bul = pr2.changes.find(c => /bereaved/.test(c.before)), hd = pr2.changes.find(c => /Distant/.test(c.before));
  ok(bul && bul.at.match === 'exact', `an untouched bullet point matches exactly despite the printed • (${bul && bul.at.match})`);
  ok(hd && hd.at.match === 'exact' && hd.at.heading, `the item heading is found (${hd && hd.at.match})`);
  r = await call('POST', `/proofreads/${pr2.id}/changes/${bul.id}`, { action: 'accept' });
  let c2 = db.findById('minutes_docs', doc2.id).sections.find(s => s.key === key).children[0];
  ok(r.status === 200 && c2.body === 'The Session prayed for:\n- the bereaved families', 'accepting keeps the Clerk\'s own "-" and adds the correction');
  r = await call('POST', `/proofreads/${pr2.id}/changes/${hd.id}`, { action: 'accept' });
  c2 = db.findById('minutes_docs', doc2.id).sections.find(s => s.key === key).children[0];
  ok(r.status === 200 && c2.subject === 'Distant Members', `accepting the heading changes the item's subject only, not the "Other Matters I:" prefix (${c2.subject})`);
  r = await call('POST', `/proofreads/${pr2.id}/changes/${hd.id}`, { action: 'undo' });
  ok(r.status === 200 && db.findById('minutes_docs', doc2.id).sections.find(s => s.key === key).children[0].subject === 'Distant members', 'undo puts the heading back');
  // An upload made before this fix stored "close"; the screen now works it out afresh.
  const rec2 = db.findById('minutes_proofreads', pr2.id);
  db.update('minutes_proofreads', pr2.id, { changes: rec2.changes.map(c => ({ ...c, at: { match: 'close' } })) });
  r = await call('GET', `/${doc2.id}/proofreads`);
  ok(r.body[0].changes.find(c => c.id === hd.id).at.match === 'exact', 'an older upload is re-matched on reading, so it gains Accept without uploading again');

  // "Rev." in the app, "Rev" in the printed minutes: the same paragraph.
  ok(PR.locate([{ key: 'k', ci: 0, li: 0, no: '9.1', text: 'Rev. Kofi Manukure Akyeampong said Ms. Betty agreed.' }], 'Rev Kofi Manukure Akyeampong said Ms Betty agreed.').match === 'exact', 'a full stop after a title (Rev. / Ms.) does not count as an edit');
  ok(PR.locate([{ key: 'k', ci: 0, li: 0, no: '9.1', text: 'Rev. Kofi said yes.' }], 'Rev Kofi said no.').match !== 'exact', '…but a real wording change still does');

  head('A comment on words his own change put in');
  const doc3 = db.insert('minutes_docs', SM.newMinutesDoc({ date: '2026-10-02' }));
  db.update('minutes_docs', doc3.id, { sections: db.findById('minutes_docs', doc3.id).sections.map(s => s.key === key ? { ...s, children: [{ subject: 'Recognition', body: 'New members were handed over to the Session.' }] } : s) });
  const ex3 = await realFetch(`${base}/${doc3.id}/minutes.docx`);
  const zip3 = await JSZip.loadAsync(Buffer.from(await ex3.arrayBuffer()));
  let x3 = await zip3.file('word/document.xml').async('string');
  const W3 = '<w:t xml:space="preserve">New members were handed over to the Session.</w:t>';
  ok(x3.includes(W3), 'paragraph found in the export');
  x3 = x3.replace(W3, `<w:t xml:space="preserve">New members were </w:t></w:r><w:del ${A}><w:r><w:delText>handed over to</w:delText></w:r></w:del><w:ins ${A}><w:r><w:t xml:space="preserve"></w:t></w:r><w:commentRangeStart w:id="9"/><w:r><w:t xml:space="preserve">inducted into</w:t></w:r><w:commentRangeEnd w:id="9"/></w:ins><w:r><w:t xml:space="preserve"> the Session.</w:t>`);
  zip3.file('word/document.xml', x3);
  zip3.file('word/comments.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="9" w:author="Dr. N. Tweneboa"><w:p><w:r><w:t>I hope this term is correct in this context.</w:t></w:r></w:p></w:comment></w:comments>`);
  const fd4 = new FormData(); fd4.append('docx', new Blob([await zip3.generateAsync({ type: 'nodebuffer' })]), 'p3.docx');
  r = await realFetch(`${base}/${doc3.id}/proofread`, { method: 'POST', body: fd4 }); const pr3 = await r.json();
  ok(pr3.comments.length === 1 && pr3.comments[0].anchor === 'inducted into', `the comment is on his inserted words (${pr3.comments[0] && pr3.comments[0].anchor})`);
  r = await call('POST', `/proofreads/${pr3.id}/changes/${pr3.changes[0].id}`, { action: 'accept' });
  r = await call('GET', `/${doc3.id}/proofreads`);
  const cm3 = r.body[0].comments[0];
  ok(cm3.at.match === 'exact' && cm3.at.viaCorrection, 'once his change is accepted, the comment is NOT shown as "changed since you sent it"');
  ok(/inducted into/.test(cm3.current || ''), 'and it is shown on the paragraph as it now reads, with his words in it');
  reply = { content: [{ type: 'text', text: 'New members were installed into the Session.' }], stop_reason: 'end_turn' };
  r = await call('POST', `/proofreads/${pr3.id}/comments/1/propose`, { directive: 'Replace inducted with installed.' });
  ok(/inducted into/.test(lastBody.messages[0].content[0].text), 'Claude is given the current paragraph, not the old copy');
  r = await call('POST', `/proofreads/${pr3.id}/comments/1/resolve`, { action: 'apply' });
  ok(r.status === 200 && db.findById('minutes_docs', doc3.id).sections.find(s => s.key === key).children[0].body === 'New members were installed into the Session.', 'and Apply writes it in');

  head('Bad files');
  const fd2 = new FormData(); fd2.append('docx', new Blob([Buffer.from('not a docx')]), 'x.docx');
  r = await realFetch(`${base}/${doc.id}/proofread`, { method: 'POST', body: fd2 });
  ok(r.status === 400, 'something that is not a Word file is refused politely');

  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
  server.close(); process.exit(fail ? 1 : 0);
});
