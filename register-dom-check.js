// The register page, rendered into a real DOM. Not a substitute for a browser
// run, but it exercises the code that draws the page rather than grepping it.
const fs = require('fs');
const { JSDOM } = require('jsdom');
const path = __dirname;
const html = fs.readFileSync(path + '/public/session-matters.html', 'utf8');
const js = fs.readFileSync(path + '/public/js/page-session-matters.js', 'utf8');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓', n))
  : (fail++, console.log('  ✗ FAIL:', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300))); };

const dom = new JSDOM(html, { runScripts: 'outside-only' });
const w = dom.window;

const MATTERS = [
  { id: 1, heading: 'Update on Building Project', subject: 'Second legal counsel', detail: 'Opinion awaited.',
    owner: 'Ing Sampson Agudze', status: 'in-progress', open: true, raisedAt: '2026-06-11', age: 2, updates: [] },
  { id: 2, heading: 'Update on Building Project', subject: "Consultants' response", detail: 'No reply yet.',
    owner: 'Ing Sampson Agudze', status: 'open', open: true, raisedAt: '2026-06-11', age: 2, updates: [] },
  { id: 3, heading: 'Update on Building Project', subject: 'Letter to the contractor', detail: 'Sent; acknowledged.',
    owner: 'Ing Sampson Agudze', status: 'closed', open: false, raisedAt: '2026-05-14', closedAt: '2026-07-09', updates: [] },
  { id: 4, heading: '', subject: 'Repair of the chapel roof', detail: 'Quotation awaited.',
    owner: 'The Property Committee', status: 'open', open: true, raisedAt: '2026-07-09', age: 1, updates: [] },
  { id: 5, heading: 'Chapel Washrooms', subject: 'State of the chapel washrooms', detail: 'Inspection awaited.',
    owner: '', status: 'open', open: true, raisedAt: '2026-08-13', flag: 'overdue', due: '2026-08-20', updates: [] },
];

w.eval(`
  window.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.toast = () => {};
  window.confirmDialog = async () => true;
  window.api = async () => ({});
  window.requireAuthAndRenderShell = async () => null;
`);

// Run the page module with its bootstrap disabled — we drive render() ourselves.
const body = js.replace(/\(async \(\) => \{[\s\S]*$/, '');
w.eval(`(function(){
  ${body}
  window.__t = { setMatters(ms, st, f) { matters = ms; statuses = st; mayEdit = true; filter = f;
    counts = {}; renderHeadingList(); renderFilters(); render(); },
    groupsOf: typeof groupsOf === 'function' ? groupsOf : null,
    clearHeading: typeof clearHeading === 'function' ? clearHeading : null };
})();`);

const STATUSES = [
  { key: 'open', label: 'Open', note: 'nothing done yet' },
  { key: 'in-progress', label: 'In progress', note: 'under way' },
  { key: 'decided', label: 'Decided', note: 'to be carried out' },
  { key: 'closed', label: 'Closed', note: 'cleared' },
];

console.log('The register page, drawn into a DOM:');
w.__t.setMatters(MATTERS, STATUSES, 'all');
const doc = w.document;

const groups = doc.querySelectorAll('.mgroup');
// Five matters, three headings: the building project holds three of them, and
// the chapel roof reaches the agenda under its own subject.
ok('the page draws one card per heading, not per matter', groups.length === 3, groups.length);
ok('the building heading is one card holding three sub-notes',
  groups[0].querySelectorAll('.snote').length === 3, groups[0].querySelectorAll('.snote').length);
ok('the heading is shown as the agenda line',
  /Update on Building Project/.test(groups[0].querySelector('.ghead b').textContent),
  groups[0].querySelector('.ghead b').textContent);
ok('it says how many are still open beneath it',
  /2 of 3 still open/.test(groups[0].querySelector('.gcount').textContent),
  groups[0].querySelector('.gcount').textContent);
ok('and that it will be carried onto the next agenda',
  /next agenda/.test(groups[0].querySelector('.gmeta').textContent),
  groups[0].querySelector('.gmeta').textContent);
ok('one owner across the group is named on the heading',
  /Ing Sampson Agudze/.test(groups[0].querySelector('.gmeta').textContent));

console.log('Every sub-note can be cleared on its own:');
const notes = groups[0].querySelectorAll('.snote');
const clearBtns = [...notes].map(n => [...n.querySelectorAll('button')]
  .find(b => /Mark cleared/.test(b.textContent)));
ok('the two open sub-notes each have their own Mark cleared',
  clearBtns[0] && clearBtns[1], clearBtns.map(b => !!b));
ok('each targets its own matter, not the heading',
  /setStatus\(1,'closed'\)/.test(clearBtns[0].getAttribute('onclick'))
  && /setStatus\(2,'closed'\)/.test(clearBtns[1].getAttribute('onclick')),
  clearBtns.map(b => b && b.getAttribute('onclick')));
ok('the already-cleared sub-note offers Re-open instead',
  [...notes[2].querySelectorAll('button')].some(b => /Re-open/.test(b.textContent)));
ok('the cleared sub-note is dimmed, the heading is not',
  notes[2].className.includes('done') && !groups[0].className.includes('done'));

console.log('The whole heading can be cleared in one click:');
{
  const btn = [...groups[0].querySelectorAll('button')].find(b => /Clear the whole heading/.test(b.textContent));
  ok('the heading card offers it', !!btn);
  ok('it names the group by position, not by pasting text into an attribute',
    btn && /^clearHeading\(\d+\)$/.test(btn.getAttribute('onclick')), btn && btn.getAttribute('onclick'));
  ok('the sub-notes still have their own Mark cleared as well',
    [...groups[0].querySelectorAll('.snote button')].filter(b => /Mark cleared/.test(b.textContent)).length === 2);

  // Drive it, and watch which records it actually closes. The building heading
  // holds two open matters and one already cleared; only the two open ones
  // should be touched, so nothing's closing date gets rewritten.
  w.eval('window.confirmDialog = async () => true; window.__calls = [];'
    + 'window.api = async (p, o) => { window.__calls.push({ p, body: o && o.body }); return {}; };');
  w.__t.clearHeading(0);
}

console.log('A heading whose sub-notes are all cleared:');
w.__t.setMatters([MATTERS[2]], STATUSES, 'all');
const g2 = doc.querySelector('.mgroup');
ok('the card is dimmed', g2.className.includes('done'));
ok('and it says it will not appear on the next agenda',
  /will not appear on the next agenda/.test(g2.querySelector('.gmeta').textContent),
  g2.querySelector('.gmeta').textContent);

console.log('A matter with no heading of its own:');
w.__t.setMatters([MATTERS[3]], STATUSES, 'all');
ok('reaches the agenda as its own subject',
  /Repair of the chapel roof/.test(doc.querySelector('.ghead b').textContent),
  doc.querySelector('.ghead b').textContent);

console.log('The heading datalist:');
w.__t.setMatters(MATTERS, STATUSES, 'all');
const opts = [...doc.querySelectorAll('#headingList option')].map(o => o.value);
ok('every heading in use is offered', opts.length === 3, opts);
ok('sorted, so the clerk can find one', opts.join('|') === [...opts].sort((a, b) => a.localeCompare(b)).join('|'), opts);
ok('including a matter’s own subject where it has no heading',
  opts.includes('Repair of the chapel roof'), opts);
ok('a container label is never offered', !opts.some(o => /^other matters$/i.test(o)), opts);

console.log('The open filter:');
w.__t.setMatters(MATTERS, STATUSES, 'open');
const og = doc.querySelectorAll('.mgroup');
ok('the cleared sub-note drops out of the building card',
  og[0].querySelectorAll('.snote').length === 2, og[0].querySelectorAll('.snote').length);
ok('and a heading with nothing open disappears entirely',
  ![...og].some(g => /Letter to the contractor/.test(g.textContent)));

console.log('A flag on a sub-note shows on its heading:');
const washrooms = [...og].find(g => /Chapel Washrooms/.test(g.querySelector('.ghead b').textContent));
ok('the heading carries the overdue flag', !!washrooms.querySelector('.ghead .flag.overdue'));

console.log('Escaping:');
w.__t.setMatters([{ id: 9, heading: '<script>x</script>', subject: 'a & b', detail: '', status: 'open', open: true, updates: [] }],
  STATUSES, 'all');
ok('a heading is escaped, not executed', !/<script>x<\/script>/.test(doc.querySelector('.ghead').innerHTML),
  doc.querySelector('.ghead').innerHTML);

// clearHeading awaits one PUT per open sub-note; let those microtasks drain
// before asking what it did.
setTimeout(() => {
  const calls = w.__calls || [];
  // The writes, not the reload that follows them.
  const writes = calls.filter(c => c.body);
  ok('clearing the heading closed both open sub-notes, and only those',
    writes.length === 2, calls);
  ok('each was closed by its own id',
    writes.map(c => c.p).sort().join(',') === '/minutes/matters/1,/minutes/matters/2',
    writes.map(c => c.p));
  ok('and closed, not something else', writes.every(c => c.body.status === 'closed'),
    writes.map(c => c.body));
  ok('the sub-note already cleared was left alone, so its closing date stands',
    !writes.some(c => /\/3$/.test(c.p)), writes.map(c => c.p));
  ok('and the register is re-read afterwards',
    calls.some(c => !c.body && c.p === '/minutes/matters'), calls.map(c => c.p));

  console.log(fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} FAILED, ${pass} passed`);
  process.exit(fail ? 1 : 0);
}, 50);
