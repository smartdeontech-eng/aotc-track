// AOTC Track — choosing which headings come onto the agenda.
//
// The register is offered as a list to scroll and tick, not taken whole: some of
// what the Session is carrying is not for tonight. This drives the real panel
// from public/js/agenda-editor.js in a DOM.
const fs = require('fs');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓', n))
  : (fail++, console.log('  ✗ FAIL:', n, x === undefined ? '' : JSON.stringify(x).slice(0, 300))); };

const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
const w = dom.window;
w.eval(`window.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));`);
w.eval(fs.readFileSync(__dirname + '/public/js/agenda-editor.js', 'utf8'));
const AE = w.AgendaEditor;

const GROUPS = [
  { heading: 'Update on Building Project', owner: 'Ing Sampson Agudze', matters: [
    { subject: 'Letter to contractor', owner: 'Ing Sampson Agudze' },
    { subject: 'Seeking legal counsel', owner: 'Ing Sampson Agudze' } ] },
  { heading: 'Letter to Head Office', owner: 'The Session Clerk', matters: [
    { subject: 'Submission of letter to head office', owner: 'The Session Clerk' } ] },
  { heading: 'Washrooms at the chapel', owner: '', matters: [
    { subject: 'Washrooms at the chapel are in a poor state', owner: '' } ] },
];

const q = sel => w.document.querySelector(sel);
const qa = sel => [...w.document.querySelectorAll(sel)];
const btnBy = re => qa('.modal-overlay button').find(b => re.test(b.textContent));

async function main() {
 console.log('The panel, opened on an empty Matters Arising row:');
 {
  const row = { item: 'Matters Arising', subItems: [] };
  const p = AE.pickFromRegister(row, GROUPS);
  ok('an overlay is put up', !!q('.modal-overlay'));
  const boxes = qa('.modal-overlay input[type=checkbox]');
  ok('one tickable line per heading, not per matter', boxes.length === 3, boxes.length);
  ok('everything is ticked to start with', boxes.every(b => b.checked));
  ok('the list scrolls rather than running off the panel',
    /overflow-y:\s*auto/.test(q('#agPickList').getAttribute('style') || ''),
    q('#agPickList').getAttribute('style'));
  const text = q('.modal-overlay').textContent;
  ok('each heading shows what sits beneath it', /Letter to contractor/.test(text) && /Seeking legal counsel/.test(text));
  ok('and how many', /2 matters beneath it/.test(text));
  ok('the count is stated in both grains',
    /3 headings selected, covering 4 matters/.test(q('#agPickCount').textContent),
    q('#agPickCount').textContent);

  console.log('Unticking one:');
  boxes[2].checked = false;
  boxes[2].dispatchEvent(new w.Event('change'));
  ok('the count follows', /2 headings selected, covering 3 matters/.test(q('#agPickCount').textContent),
    q('#agPickCount').textContent);

  btnBy(/^Bring in$/).click();
  const chosen = await p;
  ok('only the ticked headings come back', chosen.length === 2, chosen.map(g => g.heading));
  ok('and they are the right two',
    chosen.map(g => g.heading).join(' | ') === 'Update on Building Project | Letter to Head Office',
    chosen.map(g => g.heading));
  ok('the overlay is taken down', !q('.modal-overlay'));

  const added = AE.fromRegister(row, chosen);
  ok('the agenda gets one sub-item per chosen heading', added === 2 && row.subItems.length === 2,
    row.subItems.map(s => s.item));
  ok('the untouched heading is not on the agenda',
    !row.subItems.some(s => /Washrooms/.test(s.item)), row.subItems.map(s => s.item));
  ok('the owner comes across with it',
    row.subItems[0].responsible === 'Ing Sampson Agudze', row.subItems[0]);
 }

 console.log('Untick all, and tick all:');
 {
  const p = AE.pickFromRegister({ item: 'Matters Arising', subItems: [] }, GROUPS);
  btnBy(/Untick all/).click();
  ok('nothing selected', /Nothing selected/.test(q('#agPickCount').textContent));
  ok('and Bring in is refused', btnBy(/^Bring in$/).disabled);
  btnBy(/Tick all/).click();
  ok('all three back', /3 headings selected/.test(q('#agPickCount').textContent));
  ok('and Bring in is offered again', !btnBy(/^Bring in$/).disabled);
  btnBy(/Cancel/).click();
  ok('cancelling resolves to nothing', (await p) === null);
  ok('and takes the overlay down', !q('.modal-overlay'));
 }

 console.log('A heading already on the agenda:');
 {
  const row = { item: 'Matters Arising', subItems: [{ item: 'Letter to Head Office', responsible: '' }] };
  const p = AE.pickFromRegister(row, GROUPS);
  const boxes = qa('.modal-overlay input[type=checkbox]');
  ok('it is shown, but disabled', boxes[1].disabled && !boxes[1].checked, boxes.map(b => [b.checked, b.disabled]));
  ok('and said to be already there', /already on the agenda/.test(q('.modal-overlay').textContent));
  ok('the others are still tickable', !boxes[0].disabled && !boxes[2].disabled);
  ok('the count leaves it out', /2 headings selected, covering 3 matters/.test(q('#agPickCount').textContent),
    q('#agPickCount').textContent);
  btnBy(/Tick all/).click();
  ok('Tick all cannot re-tick it', qa('.modal-overlay input[type=checkbox]')[1].checked === false);
  btnBy(/^Bring in$/).click();
  const chosen = await p;
  ok('so it cannot be added twice', !chosen.some(g => g.heading === 'Letter to Head Office'),
    chosen.map(g => g.heading));
  const added = AE.fromRegister(row, chosen);
  ok('and the agenda ends with one of each', added === 2 && row.subItems.length === 3,
    row.subItems.map(s => s.item));
 }

 console.log('Escaping:');
 {
  const p = AE.pickFromRegister({ item: 'Matters Arising', subItems: [] },
    [{ heading: '<script>x</script> & co', owner: '', matters: [{ subject: 'a & b', owner: '' }] }]);
  ok('a heading is escaped, not executed',
    !/<script>x<\/script>/.test(q('#agPickList').innerHTML), q('#agPickList').innerHTML.slice(0, 160));
  btnBy(/Cancel/).click(); await p;
 }

 console.log(fail === 0 ? `ALL ${pass} CHECKS PASSED` : `${fail} FAILED, ${pass} passed`);
 process.exit(fail ? 1 : 0);
}
main();
