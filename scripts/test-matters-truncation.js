// "Read with AI" on long minutes (Oct 2026). The 24 Sept 2026 minutes gave
// "Claude did not return a usable list": the answer hit the length cap and the
// half-written JSON would not parse. Claude is stubbed here (no API calls).
process.env.ANTHROPIC_API_KEY = 'test-key';
const path = require('path'); const root = process.env.HOME + '/mnt/aotc-track';
const ai = require(path.join(root, 'utils/aiAssist'));
let fail = 0, n = 0; const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
let reply = null, lastBody = null;
global.fetch = async (_u, o) => { lastBody = JSON.parse(o.body); return { ok: true, json: async () => reply }; };
const item = i => ({ heading: 'Update on Building Project', subject: `Item number ${i}`, detail: `Detail ${i} with a "quote", a {brace} and a ] bracket.`, owner: 'The Session Clerk', status: 'open' });
const full = JSON.stringify({ matters: Array.from({ length: 30 }, (_, i) => item(i + 1)) });
(async () => {
  console.log('\n── A cut-off answer (the 24 Sept case)');
  reply = { content: [{ type: 'text', text: full.slice(0, Math.floor(full.length * 0.6)) }], stop_reason: 'max_tokens' };
  let r = await ai.proposeMatters({ minutes: 'Session meeting held on 2026-09-24.\n1.0 Something', people: [] });
  ok(r.truncated === true, 'it is reported as cut short, not as a failure');
  ok(r.matters.length >= 15 && r.matters.length < 30, `every complete matter is kept (${r.matters.length} of 30)`);
  ok(r.matters.every((m, i) => m.subject === `Item number ${i + 1}`), 'in order, none garbled — quotes, braces and brackets inside a detail do not fool it');
  ok(lastBody.max_tokens >= 6000, `the length cap is raised (now ${lastBody.max_tokens}, was 3000)`);

  console.log('\n── A complete answer');
  reply = { content: [{ type: 'text', text: '```json\n' + full + '\n```' }], stop_reason: 'end_turn' };
  r = await ai.proposeMatters({ minutes: 'x', people: [] });
  ok(!r.truncated && r.matters.length === 30, 'all 30 matters, not marked as cut short');

  console.log('\n── Reading again after adding the first batch');
  await ai.proposeMatters({ minutes: 'x', people: [], skip: ['Item number 1', 'Item number 2'] });
  const sent = lastBody.messages[0].content[0].text;
  ok(/ALREADY in the register/.test(sent) && sent.includes('- Item number 2'), 'matters already brought in are named, so Claude moves on to the rest');

  console.log('\n── Nothing usable at all');
  reply = { content: [{ type: 'text', text: '{"matters":[{"heading":"Upd' }], stop_reason: 'max_tokens' };
  let err = null; try { await ai.proposeMatters({ minutes: 'x', people: [] }); } catch (e) { err = e; }
  ok(err && err.status === 502 && /cut off/.test(err.message), 'a cut-off with no complete matter says so plainly');
  reply = { content: [{ type: 'text', text: '{"matters":[]}' }], stop_reason: 'end_turn' };
  r = await ai.proposeMatters({ minutes: 'x', people: [] });
  ok(r.matters.length === 0 && !r.truncated, 'an honest empty list is still an empty list');

  console.log(`\n${n - fail}/${n} checks — ${fail ? 'FAILURES ABOVE' : 'all green'}`);
  process.exit(fail ? 1 : 0);
})();
