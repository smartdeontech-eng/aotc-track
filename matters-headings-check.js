// AOTC Track — the register holds the detail, the agenda carries the heading.
//
// What this checks: that several outstanding matters gathered under one agenda
// heading reach the next agenda as ONE line, that a container Subject line
// ("Other Matters") never becomes a heading, that clearing one sub-note leaves
// the heading standing until the last one is cleared, and that the button is
// safe to press twice.
process.env.JWT_SECRET = 'x'.repeat(48);
process.env.AOTC_DATA_DIR = '/tmp/aotc-data-headings';
const fs = require('fs');
fs.rmSync('/tmp/aotc-data-headings', { recursive: true, force: true });
fs.mkdirSync('/tmp/aotc-data-headings', { recursive: true });

const express = require('express'), cookieParser = require('cookie-parser'),
      jwt = require('jsonwebtoken'), db = require('./utils/db');
const SM = require('./utils/sessionMinutes');

const clerk = db.insert('users', {
  name: 'Gideon', email: 'g@x.com', role: 'clerk',
  permissions: ['approvals.manage', 'congregation.view'], sessionVersion: 0,
});
const T = jwt.sign({ id: clerk.id, name: clerk.name, email: clerk.email, role: clerk.role, sv: 0 },
  process.env.JWT_SECRET, { expiresIn: '1h' });

const app = express(); app.use(express.json()); app.use(cookieParser());
app.use('/api/minutes', require('./routes/minutes'));
const server = app.listen(4461, run);

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓', n))
  : (fail++, console.log('  ✗ FAIL:', n, x === undefined ? '' : JSON.stringify(x).slice(0, 240))); };
const call = async (m, p, b) => {
  const r = await fetch('http://localhost:4461/api/minutes' + p, {
    method: m, headers: { cookie: `token=${T}`, 'content-type': 'application/json' },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: r.status, body: await r.json() };
};

async function run() {
 try {
  // ---------------------------------------------------------------- grouping
  console.log('Several matters under one heading make one agenda line:');
  {
    const groups = SM.groupByHeading([
      { subject: 'Second legal counsel', heading: 'Update on Building Project', owner: 'Ing Sampson Agudze' },
      { subject: "Consultants' response", heading: 'Update on Building Project', owner: 'Ing Sampson Agudze' },
      { subject: 'Reply from the General Assembly', heading: 'Update on Letter to Head Office', owner: 'The Session Clerk' },
    ]);
    ok('three matters became two headings', groups.length === 2, groups.map(g => g.heading));
    ok('the first heading keeps both its matters', groups[0].matters.length === 2, groups[0].matters.length);
    ok('headings come back in the order first met',
      groups[0].heading === 'Update on Building Project' && groups[1].heading === 'Update on Letter to Head Office',
      groups.map(g => g.heading));
    ok('one owner across the group becomes the heading owner',
      groups[0].owner === 'Ing Sampson Agudze', groups[0].owner);
  }
  {
    const groups = SM.groupByHeading([
      { subject: 'a', heading: 'Update on Building Project', owner: 'Ing Sampson Agudze' },
      { subject: 'b', heading: 'Update on Building Project', owner: 'The Session Clerk' },
    ]);
    ok('different owners leave the heading owner blank rather than naming one for another’s work',
      groups[0].owner === '', groups[0].owner);
  }
  {
    const groups = SM.groupByHeading([{ subject: 'Repair of the chapel roof', heading: '' }]);
    ok('a matter typed with no heading reaches the agenda as itself',
      groups.length === 1 && groups[0].heading === 'Repair of the chapel roof', groups);
  }
  {
    const groups = SM.groupByHeading([
      { subject: 'a', heading: 'Update on Building Project' },
      { subject: 'b', heading: 'update on building project' },
    ]);
    ok('the same heading in different case is one group, not two', groups.length === 1, groups.map(g => g.heading));
  }

  // -------------------------------------------------------- container labels
  console.log('A container Subject line is not a heading:');
  ok('"Other Matters" is recognised as a container', SM.isCatchAllHeading('Other Matters'));
  ok('"Any Other Business" too', SM.isCatchAllHeading('Any Other Business'));
  ok('"A.O.B." too', SM.isCatchAllHeading('A.O.B.'));
  ok('"Correspondence" too', SM.isCatchAllHeading('Correspondence'));
  ok('"Matters Arising" itself too', SM.isCatchAllHeading('Matters Arising'));
  ok('a numbered container is still a container', SM.isCatchAllHeading('8.0 Other Matters'));
  ok('a real subject is not', !SM.isCatchAllHeading('Update on Building Project'));
  ok('nor is one that merely mentions business', !SM.isCatchAllHeading('Business Committee Report'));

  console.log('A heading composed from the matter’s own words names the concern:');
  ok('the reporting frame is dropped and the predicate cut',
    SM.shortHeading('It was reported that the washrooms at the chapel are in a poor state and need urgent repair')
      === 'Washrooms at the chapel',
    SM.shortHeading('It was reported that the washrooms at the chapel are in a poor state and need urgent repair'));
  ok('a concern raised keeps its noun phrase',
    SM.shortHeading('A concern was raised about the security of the manse at night, which the Session asked be looked into')
      === 'Security of the manse at night',
    SM.shortHeading('A concern was raised about the security of the manse at night, which the Session asked be looked into'));
  ok('a heading is never a whole sentence',
    SM.shortHeading('The Session was informed that the church bus has broken down again') === 'Church bus',
    SM.shortHeading('The Session was informed that the church bus has broken down again'));
  ok('a heading that is already short is left alone',
    SM.shortHeading('Repair of the chapel roof') === 'Repair of the chapel roof');
  ok('a composed heading is at most six words',
    SM.shortHeading('the state of the accounts of the youth camp held in the long vacation')
      .split(' ').length <= 6,
    SM.shortHeading('the state of the accounts of the youth camp held in the long vacation'));
  ok('nothing in gives nothing out', SM.shortHeading('') === '' && SM.shortHeading(null) === '');

  console.log('A sub-item under a heading is labelled by the act, not the whole instruction:');
  ok('the trailing "regarding…" is cut',
    SM.shortSubject('Letter to contractor regarding reverting to original contract terms and requesting for meeting')
      === 'Letter to contractor',
    SM.shortSubject('Letter to contractor regarding reverting to original contract terms and requesting for meeting'));
  ok('so is a trailing "before…"',
    SM.shortSubject('Seeking legal counsel before proceeding with termination of contractor')
      === 'Seeking legal counsel',
    SM.shortSubject('Seeking legal counsel before proceeding with termination of contractor'));
  ok('and a trailing "with copies to…", keeping who it goes to',
    SM.shortSubject('Submission of letter to head office with copies to clerk')
      === 'Submission of letter to head office',
    SM.shortSubject('Submission of letter to head office with copies to clerk'));
  ok('an "in respect of…" qualifier goes too',
    SM.shortSubject('Write to the consultants in respect of the reviewed claim')
      === 'Write to the consultants',
    SM.shortSubject('Write to the consultants in respect of the reviewed claim'));
  ok('a label already brief is left exactly as it is',
    SM.shortSubject('Repair of the chapel roof') === 'Repair of the chapel roof');
  ok('the cut is refused when it would leave one word',
    SM.shortSubject('Letter regarding the contractor').split(' ').length > 1,
    SM.shortSubject('Letter regarding the contractor'));
  ok('two items under one heading stay distinguishable',
    SM.shortSubject('Letter to contractor regarding reverting to original contract terms')
      !== SM.shortSubject('Seeking legal counsel before proceeding with termination'));
  ok('nothing in gives nothing out', SM.shortSubject('') === '' && SM.shortSubject(null) === '');

  console.log('The three worked examples, end to end:');
  {
    const doc = { sections: [
      { key: 'a', enabled: true, subject: 'Update on Building Project', children: [
        { action: 'Letter to contractor regarding reverting to original contract terms and requesting for meeting',
          actionStatus: 'open', actionResponsible: 'Ing Sampson Agudze' },
        { action: 'Seeking legal counsel before proceeding with termination of contractor',
          actionStatus: 'open', actionResponsible: 'Ing Sampson Agudze' },
      ] },
      { key: 'b', enabled: true, subject: 'Letter to Head Office', children: [
        { action: 'Submission of letter to head office with copies to clerk', actionStatus: 'open' },
      ] },
    ] };
    const items = SM.mattersFromDoc(doc);
    const groups = SM.groupByHeading(items);
    ok('two headings out of three items', groups.length === 2, groups.map(g => g.heading));
    ok('the building heading holds both its items',
      groups[0].heading === 'Update on Building Project' && groups[0].matters.length === 2,
      groups[0].matters.map(m => m.subject));
    ok('labelled "Letter to contractor" and "Seeking legal counsel"',
      groups[0].matters.map(m => m.subject).join(' | ') === 'Letter to contractor | Seeking legal counsel',
      groups[0].matters.map(m => m.subject));
    ok('the head office heading is kept from the minutes',
      groups[1].heading === 'Letter to Head Office', groups[1].heading);
    ok('with its item labelled by the act',
      groups[1].matters[0].subject === 'Submission of letter to head office',
      groups[1].matters[0].subject);
    ok('and the full instruction is preserved in the detail',
      /copies to clerk/.test(groups[1].matters[0].detail), groups[1].matters[0].detail);
  }

  console.log('headingFor falls through in order of trust:');
  ok('the item’s own subject wins when it is a real subject',
    SM.headingFor('Second legal counsel', 'Update on Building Project', 'x') === 'Second legal counsel');
  ok('a blank subject falls to the parent',
    SM.headingFor('', 'Update on Building Project', 'x') === 'Update on Building Project');
  ok('a container parent composes from the matter instead',
    SM.headingFor('', 'Other Matters', 'It was reported that the washrooms at the chapel are in a poor state')
      === 'Washrooms at the chapel',
    SM.headingFor('', 'Other Matters', 'It was reported that the washrooms at the chapel are in a poor state'));
  ok('a container subject AND a container parent still names the concern',
    SM.headingFor('Other Matters', 'Any Other Business', 'Concern was expressed about the security of the manse')
      === 'Security of the manse',
    SM.headingFor('Other Matters', 'Any Other Business', 'Concern was expressed about the security of the manse'));

  console.log('matterHeading refuses a container stored on the record:');
  ok('a container heading falls back to the subject',
    SM.matterHeading({ heading: 'Other Matters', subject: 'State of the chapel washrooms' })
      === 'State of the chapel washrooms');
  ok('a container heading AND a container subject compose from the detail',
    SM.matterHeading({ heading: 'Other Matters', subject: 'Other Matters',
      detail: 'It was reported that the church bus has broken down again' }) === 'Church bus',
    SM.matterHeading({ heading: 'Other Matters', subject: 'Other Matters',
      detail: 'It was reported that the church bus has broken down again' }));

  // ------------------------------------------------- carry-forward from a doc
  console.log('Matters carried out of a set of minutes arrive with a heading:');
  {
    const doc = { sections: [
      { key: 'a', enabled: true, subject: 'Update on Building Project',
        children: [
          { subject: '', action: 'Obtain a second legal opinion on the claim', actionStatus: 'open', actionResponsible: 'Ing Sampson Agudze' },
          { subject: '', action: 'Write to the consultants', actionStatus: 'open', actionResponsible: 'Ing Sampson Agudze' },
        ] },
      { key: 'b', enabled: true, subject: 'Other Matters',
        children: [
          { subject: '', action: 'It was reported that the washrooms at the chapel are in a poor state', actionStatus: 'open' },
        ] },
    ] };
    const items = SM.mattersFromDoc(doc);
    ok('both building items carry the section subject as their heading',
      items.filter(i => i.heading === 'Update on Building Project').length === 2,
      items.map(i => i.heading));
    ok('the item under a container gets a composed heading, not "Other Matters"',
      items.some(i => i.heading === 'Washrooms at the chapel'), items.map(i => i.heading));
    ok('"Other Matters" never appears as a heading',
      !items.some(i => SM.isCatchAllHeading(i.heading)), items.map(i => i.heading));
    const groups = SM.groupByHeading(items);
    ok('so the next agenda gets two lines, not three', groups.length === 2, groups.map(g => g.heading));
  }

  // ------------------------------------------------------------ the API path
  console.log('The register, over the wire:');
  const ros = (await call('POST', '/roster/seed')).body;
  const owner = Array.isArray(ros) ? ros.find(m => /Agudze|Tettey/i.test(m.name)) : null;
  const mk = (heading, subject, ownerName) => call('POST', '/matters',
    { heading, subject, detail: 'awaited', owner: ownerName || '' });

  const a = (await mk('Update on Building Project', 'Second legal counsel', owner && owner.name)).body;
  const b = (await mk('Update on Building Project', "Consultants' response", owner && owner.name)).body;
  const c = (await mk('Update on Letter to Head Office', 'Reply from the General Assembly')).body;
  ok('the heading is stored on the record', a.heading === 'Update on Building Project', a.heading);

  const bad = (await mk('Other Matters', 'State of the chapel washrooms')).body;
  ok('a container heading is not stored', bad.heading === '', bad.heading);
  ok('and it reads back as its own subject instead',
    SM.matterHeading(bad) === 'State of the chapel washrooms', SM.matterHeading(bad));

  let r = await call('GET', '/matters?status=open');
  ok('the summary returns headings alongside the flat list', Array.isArray(r.body.headings));
  ok('four matters, three headings', r.body.matters.length === 4 && r.body.headings.length === 3,
    { matters: r.body.matters.length, headings: r.body.headings.length });
  ok('the building heading gathers two of them',
    r.body.headings.find(g => g.heading === 'Update on Building Project').matters.length === 2);

  console.log('Clearing sub-notes one at a time:');
  await call('PUT', `/matters/${a.id}`, { status: 'closed' });
  r = await call('GET', '/matters?status=open');
  ok('clearing one sub-note leaves the heading standing',
    !!r.body.headings.find(g => g.heading === 'Update on Building Project'),
    r.body.headings.map(g => g.heading));
  ok('with one matter left beneath it',
    r.body.headings.find(g => g.heading === 'Update on Building Project').matters.length === 1);

  await call('PUT', `/matters/${b.id}`, { status: 'closed' });
  r = await call('GET', '/matters?status=open');
  ok('clearing the last one drops the heading off the next agenda',
    !r.body.headings.find(g => g.heading === 'Update on Building Project'),
    r.body.headings.map(g => g.heading));
  ok('the other headings are untouched', r.body.headings.length === 2, r.body.headings.map(g => g.heading));

  console.log('Bringing the register onto an agenda, twice:');
  {
    const src = fs.readFileSync('./public/js/agenda-editor.js', 'utf8');
    const m = src.match(/function fromRegister\(row, groups\) \{[\s\S]*?\n  \}/);
    ok('fromRegister works in headings, not matters', !!m);
    const body = m[0].replace(/^function fromRegister\(row, groups\) \{/, '').replace(/\n  \}$/, '');
    const fromRegister = new Function('row', 'groups', body);
    const row = { item: 'Matters Arising', subItems: [] };
    const groups = r.body.headings;
    const added = fromRegister(row, groups);
    ok('every outstanding heading came in', added === groups.length, { added, groups: groups.length });
    ok('one sub-item per heading, none per matter', row.subItems.length === groups.length,
      row.subItems.map(s => s.item));
    ok('the sub-item is the heading, not the detail',
      row.subItems.some(s => s.item === 'Update on Letter to Head Office'), row.subItems.map(s => s.item));
    const again = fromRegister(row, groups);
    ok('pressing it a second time adds nothing', again === 0 && row.subItems.length === groups.length,
      { again, n: row.subItems.length });
  }

  console.log('Scheduling an emergency sitting, over the wire:');
  {
    const reg = (await call('POST', '/', { date: '2026-06-11', meetingKind: 'regular' })).body;
    const eme = (await call('POST', '/', { date: '2026-05-14', meetingKind: 'emergency' })).body;
    ok('the regular sitting is titled Session Meeting', reg.title === 'Session Meeting', reg.title);
    ok('the emergency one is titled Emergency Session Meeting',
      eme.title === 'Emergency Session Meeting', eme.title);
    ok('and the kind is on the record', eme.meetingKind === 'emergency', eme.meetingKind);

    const own = (await call('POST', '/', { date: '2026-04-16', title: 'Joint Session and Committee Sitting' })).body;
    ok('a title the Clerk gives is kept', own.title === 'Joint Session and Committee Sitting', own.title);

    const list = (await call('GET', '/')).body;
    const byDate = d => list.find(x => x.date === d);
    ok('the list says what to call each one in a sentence',
      byDate('2026-05-14').kindLabel === 'Emergency Session Meeting'
      && byDate('2026-06-11').kindLabel === 'Session Meeting'
      && byDate('2026-04-16').kindLabel === 'Joint Session and Committee Sitting',
      list.map(x => [x.date, x.kindLabel]));
    ok('and which kind it was', byDate('2026-05-14').meetingKind === 'emergency');

    ok('the venues call serves the kinds rather than the page hardcoding them',
      ((await call('GET', '/venues')).body.meetingKinds || []).map(k => k.key).join(',') === 'regular,emergency',
      (await call('GET', '/venues')).body.meetingKinds);

    console.log('Correcting the kind afterwards:');
    let r = await call('PUT', `/${reg.id}`, { meetingKind: 'emergency' });
    ok('the meeting is renamed with it', r.body.title === 'Emergency Session Meeting', r.body.title);
    r = await call('PUT', `/${own.id}`, { meetingKind: 'emergency' });
    ok('but a title of the Clerk’s own is not overwritten',
      r.body.title === 'Joint Session and Committee Sitting', r.body.title);
    ok('though the kind is still recorded', r.body.meetingKind === 'emergency', r.body.meetingKind);
  }

  console.log('The register page and the form:');
  {
    const html = fs.readFileSync('./public/session-matters.html', 'utf8');
    ok('the form has an Agenda heading box', /id="fHeading"/.test(html));
    ok('with a datalist for headings already in use', /id="headingList"/.test(html));
    ok('and the page styles the heading groups', /\.mgroup\{/.test(html) && /\.snote\{/.test(html));
    const js = fs.readFileSync('./public/js/page-session-matters.js', 'utf8');
    ok('the page groups by heading', /function groupsOf\(/.test(js));
    ok('renders sub-notes beneath each heading', /function subNote\(/.test(js));
    ok('each sub-note is cleared on its own', /setStatus\(\$\{m\.id\},'closed'\)/.test(js));
    ok('and the datalist is populated', /function renderHeadingList\(/.test(js));
  }

  console.log('The AI extraction asks for the heading, and forbids containers:');
  {
    const ai = require('./utils/aiAssist');
    const p = ai.MATTERS_PROMPT || '';
    ok('the prompt is reachable for checking', !!p);
    ok('it asks for a heading field', /heading\s+the AGENDA HEADING/.test(p));
    ok('it names the container labels', /Any Other Business/.test(p) && /Announcements/.test(p));
    ok('it forbids returning a container', /Never return a container label as a heading/.test(p));
    ok('it carries a worked example of a container', /Chapel Washrooms/.test(p));
    ok('and one of several matters under one heading', /Update on Building Project/.test(p));
  }

 } catch (e) {
  fail++; console.log('  ✗ THREW:', e && e.stack || e);
 }
 console.log(fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} FAILED, ${pass} passed`);
 server.close(); process.exit(fail ? 1 : 0);
}
