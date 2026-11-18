// AOTC Track — which minutes the Session is reviewing.
//
// The Review of minutes row offers the sittings the app holds, most recent
// first, and the pick writes the sentence the minutes can match on. Where more
// than one set is being reviewed the dropdown stays, so picking again adds
// another. Driven here through the real agenda-editor module in a DOM.
const fs = require('fs');
const { JSDOM } = require('jsdom');
const SM = require('./utils/sessionMinutes');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓', n))
  : (fail++, console.log('  ✗ FAIL:', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300))); };

const dom = new JSDOM('<!doctype html><body><div id="agRows"></div></body>', { runScripts: 'outside-only' });
const w = dom.window;
w.eval(`window.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));`);
w.eval(fs.readFileSync(__dirname + '/public/js/agenda-editor.js', 'utf8'));
const AE = w.AgendaEditor;

// Eight sittings, deliberately out of order, so the sort is actually tested.
const MEETINGS = [
  { id: 3, date: '2026-03-12', title: 'Session Meeting' },
  { id: 8, date: '2026-08-13', title: 'Session Meeting' },
  { id: 1, date: '2026-01-29', title: 'Session Meeting' },
  { id: 6, date: '2026-06-11', title: 'Session Meeting' },
  { id: 7, date: '2026-07-09', title: 'Session Meeting' },
  { id: 4, date: '2026-04-16', title: 'Session Meeting' },
  { id: 5, date: '2026-05-14', title: 'Emergency Session Meeting' },
  { id: 2, date: '2026-02-26', title: 'Session Meeting' },
  { id: 9, date: '2026-08-27', title: 'Session Meeting' },   // tonight
];
const TONIGHT = '2026-08-27';

console.log('The date is written the congregation’s way:');
ok('11th June 2026', AE.ordinalDate('2026-06-11') === '11th June 2026', AE.ordinalDate('2026-06-11'));
ok('1st September 2026', AE.ordinalDate('2026-09-01') === '1st September 2026', AE.ordinalDate('2026-09-01'));
ok('2nd, 3rd handled', AE.ordinalDate('2026-06-02') === '2nd June 2026' && AE.ordinalDate('2026-06-03') === '3rd June 2026');
ok('the teens are all th', AE.ordinalDate('2026-06-11') === '11th June 2026'
  && AE.ordinalDate('2026-06-12') === '12th June 2026' && AE.ordinalDate('2026-06-13') === '13th June 2026');
ok('and it matches ordinalDate on the server, which the minutes match on',
  AE.ordinalDate('2026-06-11') === SM.ordinalDate('2026-06-11')
  && AE.ordinalDate('2026-09-01') === SM.ordinalDate('2026-09-01')
  && AE.ordinalDate('2026-01-29') === SM.ordinalDate('2026-01-29'),
  [AE.ordinalDate('2026-01-29'), SM.ordinalDate('2026-01-29')]);

console.log('The sentence it writes:');
ok('reads as the Session says it',
  AE.reviewLabel('2026-06-11', 'Session Meeting') === '11th June 2026 Session Meeting',
  AE.reviewLabel('2026-06-11', 'Session Meeting'));
ok('a meeting with its own title keeps it',
  AE.reviewLabel('2026-05-14', 'Emergency Session Meeting')
    === '14th May 2026 Emergency Session Meeting',
  AE.reviewLabel('2026-05-14', 'Emergency Session Meeting'));
ok('an untitled meeting is still a Session Meeting',
  AE.reviewLabel('2026-06-11', '') === '11th June 2026 Session Meeting');

console.log('What the dropdown offers:');
{
  const row = { item: 'Review of minutes', responsible: 'Session Clerk', subItems: [] };
  const c = AE.reviewChoices(row, MEETINGS, TONIGHT);
  ok('five at most, not ten', c.length === 5, c.length);
  ok('most recent first', c.map(m => m.date).join(',') === '2026-08-13,2026-07-09,2026-06-11,2026-05-14,2026-04-16',
    c.map(m => m.date));
  ok('tonight’s own sitting is not offered', !c.some(m => m.date === TONIGHT), c.map(m => m.date));
  ok('and nothing later than tonight', c.every(m => m.date < TONIGHT));
}

console.log('Picking 11th June 2026:');
{
  const row = { item: 'Review of minutes', responsible: 'Session Clerk', subItems: [] };
  const label = AE.addReview(row, '2026-06-11', 'Session Meeting');
  ok('it is captured as a sub-item, and the row is left alone',
    row.item === 'Review of minutes' && row.subItems.length === 1, row);
  ok('worded as asked', row.subItems[0].item === '11th June 2026 Session Meeting',
    row.subItems[0].item);
  ok('the sentence is returned so the page can say what it did', label === row.subItems[0].item);

  // The whole point of the fixed wording: the minutes must find the sitting.
  const found = SM.reviewOptions({ agenda: [row] }, MEETINGS);
  ok('the minutes page matches it back to the real meeting',
    found.some(o => o.iso === '2026-06-11'), found.slice(0, 3));

  console.log('Reviewing a second set on the same night:');
  const c2 = AE.reviewChoices(row, MEETINGS, TONIGHT);
  ok('the one already named drops out of the dropdown',
    !c2.some(m => m.date === '2026-06-11'), c2.map(m => m.date));
  ok('but the dropdown still has others to offer', c2.length === 5, c2.length);
  const l2 = AE.addReview(row, '2026-07-09', 'Session Meeting');
  ok('a second sub-item is added, not a replacement', row.subItems.length === 2,
    row.subItems.map(s => s.item));
  ok('each names its own sitting',
    row.subItems.map(s => s.item).join(' | ')
      === '11th June 2026 Session Meeting | 9th July 2026 Session Meeting',
    row.subItems.map(s => s.item));
  ok('and both are matched back', ['2026-06-11', '2026-07-09']
    .every(d => SM.reviewOptions({ agenda: [row] }, MEETINGS).some(o => o.iso === d)));

  console.log('Picking the same set twice:');
  ok('is refused', AE.addReview(row, '2026-06-11', 'Session Meeting') === '');
  ok('and nothing is added', row.subItems.length === 2, row.subItems.length);
  ok('a date typed by hand earlier is recognised, not duplicated',
    AE.addReview({ item: 'Review of minutes', subItems: [{ item: 'Minutes of 11th June 2026' }] },
      '2026-06-11', 'Session Meeting') === '');
}

console.log('A sitting blocked once cannot come back anywhere on the agenda:');
{
  const agenda = [
    { item: 'Review of minutes', subItems: [{ item: '11th June 2026 Session Meeting' }] },
    { item: 'Matters Arising', subItems: [] },
    { item: 'Review of minutes (deferred set)', subItems: [] },
  ];
  const c = AE.reviewChoices(agenda[2], MEETINGS, TONIGHT, agenda);
  ok('the second review row does not offer what the first already took',
    !c.some(m => m.date === '2026-06-11'), c.map(m => m.date));
  ok('and it still offers the rest', c.length === 5, c.map(m => m.date));
  ok('adding it on the second row is refused outright',
    AE.addReview(agenda[2], '2026-06-11', 'Session Meeting', agenda) === '');
  ok('so nothing is added', agenda[2].subItems.length === 0);
  ok('a different sitting on the second row is fine',
    AE.addReview(agenda[2], '2026-07-09', 'Session Meeting', agenda)
      === '9th July 2026 Session Meeting');
  ok('and now the first row will not offer that one either',
    !AE.reviewChoices(agenda[0], MEETINGS, TONIGHT, agenda).some(m => m.date === '2026-07-09'),
    AE.reviewChoices(agenda[0], MEETINGS, TONIGHT, agenda).map(m => m.date));
}

console.log('Regular sittings and emergency sittings:');
{
  ok('the two kinds are named as the minutes head them',
    SM.MEETING_KINDS.map(k => k.label).join(' | ') === 'Session Meeting | Emergency Session Meeting',
    SM.MEETING_KINDS.map(k => k.label));
  ok('a stored kind decides it', SM.meetingKindOf({ meetingKind: 'emergency', title: 'Session Meeting' }) === 'emergency');
  ok('an unknown kind falls back to regular', SM.meetingKindOf({ meetingKind: 'nonsense' }) === 'regular');
  ok('a meeting recorded before the kind existed is read from its title',
    SM.meetingKindOf({ title: 'Emergency Session Meeting' }) === 'emergency');
  ok('and an ordinary one is regular', SM.meetingKindOf({ title: 'Session Meeting' }) === 'regular');

  ok('an emergency sitting is named as one',
    SM.meetingTitleOf({ meetingKind: 'emergency' }) === 'Emergency Session Meeting');
  ok('a legacy title drops its prefix rather than dragging it onto the agenda',
    SM.meetingTitleOf({ title: 'AOTC Session Meeting' }) === 'Session Meeting',
    SM.meetingTitleOf({ title: 'AOTC Session Meeting' }));
  ok('but a title the Clerk wrote himself is left alone',
    SM.meetingTitleOf({ title: 'Joint Session and Committee Sitting' }) === 'Joint Session and Committee Sitting');

  ok('a new emergency document is titled by its kind',
    SM.newMinutesDoc({ date: '2026-05-14', meetingKind: 'emergency' }).title === 'Emergency Session Meeting');
  ok('and carries the kind on the record',
    SM.newMinutesDoc({ date: '2026-05-14', meetingKind: 'emergency' }).meetingKind === 'emergency');
  ok('a new regular one is a Session Meeting',
    SM.newMinutesDoc({ date: '2026-06-11' }).title === 'Session Meeting');

  console.log('And it flows into next month’s agenda:');
  const row = { item: 'Review of minutes', subItems: [] };
  ok('an emergency sitting reads as one',
    AE.addReview(row, '2026-05-14', 'Emergency Session Meeting', [row])
      === '14th May 2026 Emergency Session Meeting');
  ok('a regular sitting reads as one',
    AE.addReview(row, '2026-06-11', 'Session Meeting', [row])
      === '11th June 2026 Session Meeting');
  ok('and the minutes still match both back',
    ['2026-05-14', '2026-06-11'].every(d =>
      SM.reviewOptions({ agenda: [row] }, MEETINGS).some(o => o.iso === d)),
    SM.reviewOptions({ agenda: [row] }, MEETINGS).slice(0, 4));
}

console.log('The row, rendered:');
{
  const agenda = [
    { mins: 10, item: 'Review of minutes', responsible: 'Session Clerk', subItems: [] },
    { mins: 15, item: 'Matters Arising', responsible: '', subItems: [] },
    { mins: 8, item: 'Devotion', responsible: '' },
  ];
  w.document.getElementById('agRows').innerHTML = AE.rows({
    agenda, times: ['6.30 p.m.', '6.40 p.m.', '6.55 p.m.'], mayEdit: true,
    offices: [{ key: 'clerk', label: 'Session Clerk' }], roster: [],
    meetings: MEETINGS, date: TONIGHT,
  });
  const sels = [...w.document.querySelectorAll('select[onchange^="agAddReview"]')];
  ok('the Review row gets the dropdown', sels.length === 1, sels.length);
  ok('and only that row does', !/agAddReview\(1,|agAddReview\(2,/.test(w.document.getElementById('agRows').innerHTML));
  const opts = [...sels[0].querySelectorAll('option')].map(o => o.value).filter(Boolean);
  ok('offering five sittings', opts.length === 5, opts);
  ok('most recent first', opts[0] === '2026-08-13', opts);
  ok('with a placeholder that does nothing', sels[0].querySelector('option').value === '');
  ok('the placeholder invites the first pick',
    /minutes being reviewed/.test(sels[0].querySelector('option').textContent),
    sels[0].querySelector('option').textContent);
  ok('a meeting with its own title says so in the list',
    /Emergency Session Meeting/.test(sels[0].innerHTML));

  // Once one is named, the placeholder should invite another rather than repeat.
  agenda[0].subItems.push({ item: '11th June 2026 Session Meeting', responsible: '' });
  w.document.getElementById('agRows').innerHTML = AE.rows({
    agenda, times: [], mayEdit: true, offices: [], roster: [], meetings: MEETINGS, date: TONIGHT });
  const sel2 = w.document.querySelector('select[onchange^="agAddReview"]');
  ok('the placeholder now offers another set',
    /another set of minutes/.test(sel2.querySelector('option').textContent),
    sel2.querySelector('option').textContent);
  ok('the sub-item is shown for editing like any other',
    /11th June 2026 Session Meeting/.test(w.document.getElementById('agRows').innerHTML));
}

console.log('Nothing to offer:');
{
  const row = { item: 'Review of minutes', subItems: [] };
  ok('no earlier sittings means no dropdown at all, rather than an empty one',
    AE.rows({ agenda: [row], mayEdit: true, meetings: [{ id: 9, date: TONIGHT }], date: TONIGHT })
      .indexOf('agAddReview') === -1);
  ok('and the first meeting the app ever holds is the same case',
    AE.reviewChoices(row, [{ id: 1, date: TONIGHT }], TONIGHT).length === 0);
  ok('a read-only viewer gets no dropdown either',
    AE.rows({ agenda: [row], mayEdit: false, meetings: MEETINGS, date: TONIGHT }).indexOf('agAddReview') === -1);
}

console.log(fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
