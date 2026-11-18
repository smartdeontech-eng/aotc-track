// Oct 2026: "Why?" on a proofreading card. The Clerk types the idea behind a
// correction; it becomes a house-style rule at once, and it is carried through
// the minutes being proofread now. Claude is stubbed.
process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(48);
process.env.ANTHROPIC_API_KEY = 'test-key';
const path = require('path'), fs = require('fs'); const root = process.env.HOME + '/mnt/aotc-track';
fs.mkdirSync(process.env.AOTC_DATA_DIR, { recursive: true });
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const head = t => console.log('\n── ' + t);

// ---- stub Claude: the rule check fixes "Rev." and "Dr." in any paragraph ----
const realFetch = global.fetch;
let mode = 'rule', bodies = [];
global.fetch = async (u, o) => {
  if (!String(u).includes('anthropic.com')) return realFetch(u, o);
  const b = JSON.parse(o.body); bodies.push(b);
  if (mode === 'down') return { ok: false, status: 529, json: async () => ({ error: { message: 'Overloaded' } }) };
  const text = b.messages[0].content[0].text;
  if (/^THE RULE:/.test(text)) {
    const edits = [];
    const re = /\[(\d+)\] ([^\n]+)/g; let m;
    while ((m = re.exec(text))) {
      const fixed = m[2].replace(/\b(Rev|Dr)\./g, '$1');
      if (fixed !== m[2]) edits.push({ i: Number(m[1]), text: mode === 'rewrite' ? 'Something else entirely about nothing.' : fixed });
    }
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: JSON.stringify({ edits }) }], stop_reason: 'end_turn' }) };
  }
  return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'The Session agreed with Rev Kofi.' }], stop_reason: 'end_turn' }) };
};
const authPath = require.resolve(path.join(root, 'middleware/auth')); const realAuth = require(authPath);
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { ...realAuth,
  requireAuth: (q, _r, nx) => { q.user = { id: 1, role: 'admin', name: 'Clerk' }; nx(); } } };
const db = require(path.join(root, 'utils/db'));
const SM = require(path.join(root, 'utils/sessionMinutes'));
const ai = require(path.join(root, 'utils/aiAssist'));
fs.writeFileSync(process.env.AOTC_DATA_DIR + '/users.json', JSON.stringify([{ id: 1, name: 'Clerk', role: 'admin', email: 'c@t', permissions: [] }]));
fs.writeFileSync(process.env.AOTC_DATA_DIR + '/session_members.json', JSON.stringify([{ id: 1, name: 'Kofi Mensah', titles: ['Rev'], position: 'Chairman', rank: 1 }]));
['minutes_docs', 'minutes_proofreads', 'house_style_rules', 'session_matters', 'office_terms'].forEach(c => fs.writeFileSync(`${process.env.AOTC_DATA_DIR}/${c}.json`, '[]'));
const express = require(path.join(root, 'node_modules/express'));
const app = express(); app.use(express.json({ limit: '5mb' }));
app.use('/api/minutes', require(path.join(root, 'routes/minutes')));

(async () => {
  const base0 = SM.newMinutesDoc({ date: '2026-10-08' });
  const d = db.insert('minutes_docs', base0);
  const key = d.sections[5].key;
  const sections = d.sections.map(s => (s.key === key ? { ...s, enabled: true, children: [
    { subject: 'Harvest', body: 'Rev. Kofi reported on the harvest.\nThe committee met twice.' },
    { subject: 'Building', body: 'Dr. Ama said the roof was done.\nRev. Kofi thanked her.\nAll was well.' },
    { subject: 'Youth', body: 'The youth met Dr. Yaw on Sunday.' },
  ] } : s));
  db.update('minutes_docs', d.id, { sections });
  const rec = db.insert('minutes_proofreads', {
    docId: d.id, date: d.date, proofreader: 'Mr P', words: 100, corrections: 3, uploadedAt: new Date().toISOString(),
    changes: [
      { id: 1, para: 1, before: 'Rev. Kofi reported on the harvest.', after: 'Rev Kofi reported on the harvest.', segs: [{ mode: '', text: 'Rev' }, { mode: 'del', text: '.' }, { mode: '', text: ' Kofi reported on the harvest.' }], status: 'pending' },
      { id: 2, para: 2, before: 'The committee met twice.', after: 'The committee met twice with Dr. Ama.', segs: [{ mode: '', text: 'The committee met twice' }, { mode: 'ins', text: ' with Dr. Ama' }, { mode: '', text: '.' }], status: 'pending' },
    ],
    comments: [
      { id: 1, para: 6, author: 'Mr P', text: 'Who led this?', anchor: 'met', paragraph: 'The youth met Dr. Yaw on Sunday.', paragraphAfter: '', status: 'pending', directive: 'Say Dr. Yaw led it', proposal: 'The youth met on Sunday, led by Dr. Yaw.', proposalFrom: 'The youth met Dr. Yaw on Sunday.', resolution: '' },
    ],
    lessons: [],
  });

  const server = app.listen(0, async () => {
    const base = `http://127.0.0.1:${server.address().port}/api/minutes`;
    const call = async (method, url, body) => { const r = await realFetch(base + url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json() }; };
    const reason = (body) => call('POST', `/proofreads/${rec.id}/reason`, body);

    head('Typing the idea behind a correction');
    let r = await reason({ kind: 'ch', id: 1, reason: 'Write Rev and Dr without a full stop.' });
    ok(r.status === 200, 'the reason is saved');
    const rules = db.findAll('house_style_rules');
    ok(rules.length === 1 && rules[0].rule === 'Write Rev and Dr without a full stop.' && rules[0].active === true && rules[0].source === 'clerk-reason', 'it becomes an active house-style rule at once — no approving step');
    ok(rules[0].wrong.includes('Rev.') && rules[0].right.includes('Rev Kofi') && rules[0].wrong.length < 60, `with a short wrong → right example from the correction ("${rules[0].wrong}" → "${rules[0].right}")`);
    const ch1 = r.body.proofread.changes.find(c => c.id === 1);
    ok(ch1.reason === 'Write Rev and Dr without a full stop.' && ch1.ruleId === rules[0].id, 'the card keeps the reason');

    head('It reaches the corrections in progress');
    const P = r.body.proofread;
    const byRule = P.changes.filter(c => c.source === 'rule');
    ok(byRule.some(c => c.before === 'Dr. Ama said the roof was done.' && c.after === 'Dr Ama said the roof was done.' && c.at.match === 'exact'), 'another paragraph that breaks the rule comes up as a new suggested change, ready to Accept');
    ok(byRule.some(c => c.before === 'Rev. Kofi thanked her.'), '…every one of them');
    ok(!byRule.some(c => c.before.startsWith('Rev. Kofi reported')), 'a paragraph that already has a correction waiting is left alone');
    ok(!byRule.some(c => c.before === 'The youth met Dr. Yaw on Sunday.'), 'so is a paragraph with a comment waiting');
    ok(byRule.every(c => c.segs.filter(s => s.mode).length === 1 && c.segs.find(s => s.mode).text === '.'), 'each suggestion marks exactly what it changes — just the full stop');
    const ch2 = P.changes.find(c => c.id === 2);
    ok(ch2.after === 'The committee met twice with Dr Ama.' && ch2.afterOriginal === 'The committee met twice with Dr. Ama.' && ch2.adjustedRule, 'the proofreader’s own open change is brought into line, and his version is kept');
    const cm1 = P.comments.find(c => c.id === 1);
    ok(cm1.proposal === 'The youth met on Sunday, led by Dr Yaw.' && cm1.proposalOriginal, 'an unapplied comment draft is brought into line too');
    ok(r.body.found === 4, `the Clerk is told how many places it found (${r.body.found})`);
    ok(P.corrections === 3, 'the proofreader’s correction count is not inflated by the rule’s suggestions');

    head('Accepting a suggestion from the rule');
    const sug = byRule.find(c => c.before === 'Dr. Ama said the roof was done.');
    r = await call('POST', `/proofreads/${rec.id}/changes/${sug.id}`, { action: 'accept' });
    const body = db.findById('minutes_docs', d.id).sections.find(s => s.key === key).children[1].body;
    ok(r.status === 200 && body.startsWith('Dr Ama said the roof was done.'), 'Accept puts it in the minutes, like any correction');
    r = await call('POST', `/proofreads/${rec.id}/changes/2`, { action: 'accept' });
    ok(db.findById('minutes_docs', d.id).sections.find(s => s.key === key).children[0].body.includes('The committee met twice with Dr Ama.'), 'the adjusted proofreader change accepts with the rule applied');
    r = await call('POST', `/proofreads/${rec.id}/changes/2`, { action: 'undo' });
    ok(r.status === 200, '…and can be undone');

    head('Comment drafts follow the rules');
    bodies = [];
    r = await call('POST', `/proofreads/${rec.id}/comments/1/propose`, { directive: 'Say Dr. Yaw led it' });
    ok(r.status === 200 && /Write Rev and Dr without a full stop/.test(bodies[0].system), 'a new draft for a comment is written with the rule in front of Claude');
    ok(/Write Rev and Dr without a full stop/.test(ai.approvedRulesBlock(db.findAll('house_style_rules'))), 'and so is every later tidy-up');

    head('Editing and removing the reason');
    r = await reason({ kind: 'ch', id: 1, reason: 'Titles never take a full stop: Rev, Dr, Mr.' });
    ok(db.findAll('house_style_rules').length === 1 && db.findAll('house_style_rules')[0].rule.startsWith('Titles never'), 'editing updates the same rule — no duplicate');
    const pend = r.body.proofread.changes.filter(c => c.source === 'rule' && c.status === 'pending');
    ok(pend.length === 1 && pend[0].before === 'Rev. Kofi thanked her.' && pend[0].ruleText.startsWith('Titles never'), 'the open suggestions are made again under the new wording, not doubled');
    ok(r.body.proofread.changes.some(c => c.source === 'rule' && c.status === 'accepted'), 'an accepted suggestion stays accepted');
    r = await reason({ kind: 'ch', id: 1, reason: '' });
    ok(db.findAll('house_style_rules')[0].active === false, 'removing switches the rule off');
    const after = r.body.proofread;
    ok(!after.changes.some(c => c.source === 'rule' && c.status === 'pending'), 'its open suggestions are taken away');
    const c2 = after.changes.find(c => c.id === 2);
    ok(c2.after === 'The committee met twice with Dr. Ama.' && !c2.adjustedRule && c2.segs[1].text === ' with Dr. Ama', 'the proofreader’s change goes back to exactly what he wrote');
    ok(after.comments[0].proposal === 'The Session agreed with Rev Kofi.', 'a draft made after the rule is left as it is');
    ok(!after.changes.find(c => c.id === 1).reason, 'the card no longer shows a reason');

    head('Guards');
    mode = 'rewrite';
    r = await reason({ kind: 'cm', id: 1, reason: 'Write Rev and Dr without a full stop.' });
    ok(r.status === 200 && r.body.found === 0, 'a "fix" that rewrites the paragraph is not offered');
    const cmRule = db.findAll('house_style_rules', x => x.fromItem === 'cm:1')[0];
    ok(cmRule && cmRule.active, 'a reason can be given on a comment too');
    mode = 'down';
    r = await reason({ kind: 'ch', id: 1, reason: 'No full stops after titles.' });
    ok(r.status === 200 && /rule is saved/.test(r.body.warning || '') && db.findAll('house_style_rules', x => x.fromItem === 'ch:1')[0].active, 'if Claude is unreachable the rule is still saved, and the Clerk is told the check did not run');
    r = await reason({ kind: 'ch', id: 99, reason: 'x' });
    ok(r.status === 404, 'an unknown card is refused');

    console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
    server.close(); process.exit(fail ? 1 : 0);
  });
})().catch(e => { console.error(e); process.exit(1); });
