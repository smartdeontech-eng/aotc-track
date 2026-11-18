// AOTC Track — the fundraising entry grid, driven in a DOM.
//
// The module's own notes say a jsdom harness has caught wiring mistakes the API
// test cannot see: column counts, locked inputs, panel placement. This one
// covers the behaviour asked for on 30 August — opening a saved day must show
// the FIGURES, with each basket's breakdown folded away behind its button —
// which no server-side test can see.
//
//   node scripts/test-fundraising-entry-dom.js
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('ok  :', n))
  : (fail++, console.log('FAIL:', n, x === undefined ? '' : JSON.stringify(x).slice(0, 200))); };

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'fundraising.html'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://track.pcg-aotc.com/fundraising.html' });
const w = dom.window;

// The shell's helpers, and the few globals the page reaches for.
w.eval(`
  window.esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.numVal = v => Number(String(v == null ? '' : v).replace(/[^0-9.-]/g, '')) || 0;
  window.toast = () => {};
  // page-fundraising.js now offers "Ask to reopen" on a signed-off day; the
  // helper itself lives in app.js, which this harness does not load. (This
  // block is itself a template literal, hence the escaping.)
  window.reopenButtonHtml = (k, t, l) =>
    '<button data-reopen-kind="' + k + '">' + (l || 'Request to reopen') + '</button>';
  window.confirmDialog = async () => true;
  window.fmtDate = d => String(d);
  window.api = async () => ({});
  window.requireAuthAndRenderShell = async () => ({ id: 1, name: 'Gideon', permissions: ['fundraising.manage'] });
`);
w.eval(fs.readFileSync(path.join(ROOT, 'public', 'js', 'page-fundraising.js'), 'utf8')
  // The page boots itself on load; the harness drives it by hand instead.
  .replace(/\n\(async \(\) => \{[\s\S]*$/, '\n')
  // `let` bindings made by one indirect eval are invisible to the next, so
  // `data` would stay null however many times the harness assigned it — and
  // fillMethods reads data.ious. `var` puts them on the global object.
  .replace(/^let me, data = null;$/m, 'var me, data = null;'));

// Enough state for the grid to render.
w.eval(`
  me = { id: 1, name: 'Gideon', permissions: ['fundraising.manage'] };
  data = { meta: { seedCategories: ['Harvest Committee', 'Session', 'Congregation'] },
           events: [], entries: [], ious: [], denominations: [
             { key:'n200', label:'GHS 200 note', value:200 },
             { key:'n100', label:'GHS 100 note', value:100 } ] };
`);

const $ = sel => w.document.querySelector(sel);
const dayType = $('#eDayType');
ok('the entry form is in the page', !!dayType && !!$('#catRows'), { dayType: !!dayType });
if (!dayType) { console.log('\ncannot continue without the form'); process.exit(1); }

dayType.value = 'dual';
w.eval('renderCatGrid();');

const KEY = 'dayborn.Monday';
const btn = () => $(`[data-bdbtn="s1.${KEY}"]`);
const panel = () => $(`[data-bdpanel][data-bdsvc="s1"][data-bdkey="${KEY}"]`);

console.log('Before anything is counted:');
ok('every basket has its breakdown button', !!btn());
ok('it reads ⊞', btn().textContent.trim() === '⊞', btn().textContent);
ok('and is the plain secondary style', btn().classList.contains('btn-secondary'));
ok('no panel exists yet', !panel());

console.log('A saved day is reopened — the breakdown is built FOLDED:');
w.eval(`buildBreakdown('s1', '${KEY}', true);`);
ok('the panel exists', !!panel());
ok('but it is hidden — the figure is what shows', panel().style.display === 'none', panel().style.display);
ok('the button marks the basket as counted', btn().classList.contains('btn-primary'));
ok('it still reads ⊞, inviting the click', btn().textContent.trim() === '⊞', btn().textContent);
ok('and says so', /click to see the breakdown/i.test(btn().title), btn().title);

console.log('Clicking it opens the detail:');
w.eval(`toggleBreakdown('s1', '${KEY}');`);
ok('the panel is shown', panel().style.display !== 'none', panel().style.display);
ok('the button turns to ⊟', btn().textContent.trim() === '⊟', btn().textContent);
ok('and offers to hide it again', /hide/i.test(btn().title), btn().title);

console.log('Clicking again folds it back:');
w.eval(`toggleBreakdown('s1', '${KEY}');`);
ok('hidden again', panel().style.display === 'none');
ok('button back to ⊞', btn().textContent.trim() === '⊞');
ok('still marked as counted', btn().classList.contains('btn-primary'));

console.log('A basket counted fresh in this sitting opens straight away:');
const K2 = 'gratitude';
w.eval(`toggleBreakdown('s1', '${K2}');`);
const p2 = $(`[data-bdpanel][data-bdsvc="s1"][data-bdkey="${K2}"]`);
ok('the panel is built and visible', !!p2 && p2.style.display !== 'none',
  p2 && p2.style.display);
ok('because the Clerk asked for it', $(`[data-bdbtn="s1.${K2}"]`).textContent.trim() === '⊟');

console.log('Clearing a breakdown puts the button back to untouched:');
w.eval(`clearBreakdown('s1', '${K2}');`);
ok('the panel is gone', !$(`[data-bdpanel][data-bdsvc="s1"][data-bdkey="${K2}"]`));
ok('the button is plain again', $(`[data-bdbtn="s1.${K2}"]`).classList.contains('btn-secondary'));
ok('and reads ⊞', $(`[data-bdbtn="s1.${K2}"]`).textContent.trim() === '⊞');

console.log('The dual-service grid still has its columns:');
ok('5 columns in dual mode', $('#catHead tr').children.length === 5,
  $('#catHead tr').children.length);
ok('and the breakdown row spans them',
  ($(`tr[data-bdrow="${KEY}"] td`) || {}).getAttribute
    && $(`tr[data-bdrow="${KEY}"] td`).getAttribute('colspan') === '5',
  ($(`tr[data-bdrow="${KEY}"] td`) || {}).getAttribute
    && $(`tr[data-bdrow="${KEY}"] td`).getAttribute('colspan'));
ok('both services can hold a panel for the same basket',
  (() => { w.eval(`buildBreakdown('s2', '${KEY}', true);`);
    return !!$(`[data-bdpanel][data-bdsvc="s2"][data-bdkey="${KEY}"]`); })());

console.log('Only one basket’s detail is open at a time:');
{
  // The click-outside fold is guarded on the entry modal being open, exactly as
  // it is in the app — a stray click on another page must not reach it.
  $('#eOverlay').style.display = 'flex';
  const KA = 'gratitude', KB = 'dayborn.Tuesday', KC = 'chairpersons';
  const pan = k => $(`[data-bdpanel][data-bdsvc="s1"][data-bdkey="${k}"]`);
  const shown = k => { const el = pan(k); return !!el && el.style.display !== 'none'; };

  w.eval(`toggleBreakdown('s1','${KA}');`);
  ok('the first opens', shown(KA));
  w.eval(`toggleBreakdown('s1','${KB}');`);
  ok('the second opens', shown(KB));
  ok('and the first folded itself away', !shown(KA));
  ok('its button went back to ⊞', $(`[data-bdbtn="s1.${KA}"]`).textContent.trim() === '⊞');
  ok('while still marked as counted', $(`[data-bdbtn="s1.${KA}"]`).classList.contains('btn-primary'));
  w.eval(`toggleBreakdown('s1','${KC}');`);
  ok('a third folds the second', !shown(KB) && shown(KC));
  ok('never more than one open', [...w.document.querySelectorAll('[data-bdpanel]')]
    .filter(el => el.style.display !== 'none').length === 1,
    [...w.document.querySelectorAll('[data-bdpanel]')].filter(el => el.style.display !== 'none')
      .map(el => el.getAttribute('data-bdkey')));

  console.log('And clicking elsewhere folds the open one:');
  ok('it is open to begin with', shown(KC));
  const elsewhere = $('[data-cat="s1.dayborn.Monday"]') || $('#catRows');
  elsewhere.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  ok('clicking a figure in the grid folds it', !shown(KC), pan(KC).style.display);
  ok('nothing is left open', ![...w.document.querySelectorAll('[data-bdpanel]')]
    .some(el => el.style.display !== 'none'));

  console.log('But a click inside the open panel leaves it alone:');
  w.eval(`toggleBreakdown('s1','${KC}');`);
  const inside = pan(KC).querySelector('[data-bd-cash]');
  inside.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  ok('still open', shown(KC));
  ok('and its own button still folds it',
    (() => { $(`[data-bdbtn="s1.${KC}"]`).dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      w.eval(`toggleBreakdown('s1','${KC}');`); return !shown(KC); })());
}

console.log('Each basket panel carries its own Save:');
{
  w.eval(`toggleBreakdown('s1','gratitude');`);
  const pnl = $('[data-bdpanel][data-bdsvc="s1"][data-bdkey="gratitude"]');
  const save = [...pnl.querySelectorAll('button')].find(b => /Save this basket/.test(b.textContent));
  ok('the Save button is there', !!save);
  ok('it names this basket and service', /saveBasket\('s1','gratitude'\)/.test(save.getAttribute('onclick')),
    save.getAttribute('onclick'));
  ok('and there is somewhere to put the verdict', !!pnl.querySelector('[data-bd-verdict]'));
  ok('Clear breakdown is still offered',
    [...pnl.querySelectorAll('button')].some(b => /Clear breakdown/.test(b.textContent)));

  console.log('The verdict the server sends is rendered honestly:');
  w.eval(`renderBasketVerdict('s1','gratitude', {
    label: 'Gratitude & Thanksgiving',
    basket: { counted: true, reconciles: true, amount: 5000, breakdownTotal: 5000 },
    day: { countedBaskets: 1, baskets: 12, diff: 7000, balances: false } });`);
  let txt = pnl.querySelector('[data-bd-verdict]').textContent;
  ok('a counted basket that adds up says so', /Saved/.test(txt) && /adds up/.test(txt), txt.slice(0, 90));
  ok('the day line is progress, not a verdict', /1 of 12 baskets counted/.test(txt), txt);
  ok('and it says when the day must balance', /only has to balance when it is submitted/.test(txt));
  ok('an unbalanced day is stated without calling it an error', /short by GHS 7,000/.test(txt), txt);

  w.eval(`renderBasketVerdict('s1','gratitude', {
    basket: { counted: false, reconciles: null, amount: 7000 },
    day: { countedBaskets: 3, baskets: 12, diff: 0, balances: true } });`);
  txt = pnl.querySelector('[data-bd-verdict]').textContent;
  ok('a typed basket is saved with no verdict claimed',
    /typed/.test(txt) && /Nothing to check here/.test(txt), txt.slice(0, 120));
  ok('and a balanced day says so', /the day balances/.test(txt), txt);

  w.eval(`renderBasketVerdict('s1','gratitude', {
    basket: { counted: true, reconciles: false, amount: 5000, breakdownTotal: 4000 },
    day: { countedBaskets: 1, baskets: 12, diff: 1000, balances: false } });`);
  txt = pnl.querySelector('[data-bd-verdict]').textContent;
  ok('a count that does not add up is flagged at the basket', /does not add up/.test(txt), txt.slice(0, 110));
}

console.log('A reload must not cost the day’s counting:');
{
  // The overlay already reads as open from the accordion block above; the draft
  // listeners are guarded the same way.
  $('#eOverlay').style.display = 'flex';
  // A clean slate. The blocks above left breakdown panels open, and a basket
  // WITH a breakdown has its figure replaced by the count — which is right, and
  // would make the typed Chairpersons figure below read 0.
  w.eval(`
    ['gratitude', 'dayborn.Tuesday', 'chairpersons', 'dayborn.Monday'].forEach(k => clearBreakdown('s1', k));
  `);
  $('#eEvent').innerHTML = '<option value="7">2nd Fundraising</option>';
  $('#eEvent').value = '7';
  $('#eDate').value = '2026-08-30';

  // Type a day: Monday-borns counted in its own panel, Chairpersons typed, and
  // a cheque against the Chairpersons basket.
  w.eval(`
    document.querySelector('[data-cat="s1.dayborn.Monday"]').value = '';
    buildBreakdown('s1', 'dayborn.Monday');
    const mp = document.querySelector('[data-bdpanel][data-bdsvc="s1"][data-bdkey="dayborn.Monday"]');
    mp.querySelector('[data-bd-cash]').value = '5,510';
    bdAddRow(mp, 'chq', { number: '267020', bank: 'Absa', amount: 20000 });
    document.querySelector('[data-cat="s1.chairpersons"]').value = '75,850';
    refreshEntryTotal();
  `);
  const monday = () => $('[data-cat="s1.dayborn.Monday"]').value;
  ok('the counted basket filled its own figure', /25,?510/.test(monday()), monday());

  // The snapshot the page would have written.
  w.eval('draftWrite();');
  const raw = w.localStorage.getItem('aotc.fr.draft.7.2026-08-30');
  ok('a draft was written for this day', !!raw);
  const snap = JSON.parse(raw || '{}');
  ok('it carries the typed Chairpersons figure', Number(snap.s1.categories.chairpersons) === 75850,
    snap.s1 && snap.s1.categories);
  // The snapshot carries the PARTS; the server recomputes the basket total from
  // them, which is why nothing here trusts a client-sent total.
  const mb = snap.s1.catMethods['dayborn.Monday'] || {};
  ok('and the counted basket — its cash', Number(mb.cash) === 5510, mb);
  ok('and its cheque', (mb.cheques || []).reduce((a, c) => a + Number(c.amount || 0), 0) === 20000, mb.cheques);
  ok('the cheque kept its number and bank',
    (snap.s1.catMethods['dayborn.Monday'].cheques || []).some(c => c.number === '267020' && c.bank === 'Absa'),
    snap.s1.catMethods['dayborn.Monday'].cheques);

  // The reload: wipe the form the way a fresh page would, then restore.
  w.eval(`
    document.getElementById('entryForm').reset();
    document.querySelectorAll('tr[data-bdrow]').forEach(tr => tr.remove());
    renderCatGrid();
    // editDay sets these before it restores; a fresh page would too.
    document.getElementById('eEvent').value = '7';
    document.getElementById('eDate').value = '2026-08-30';
  `);
  ok('after the reload the form is empty', !$('[data-cat="s1.dayborn.Monday"]').value
    && !$('[data-cat="s1.chairpersons"]').value);
  ok('but the day it belongs to is known', $('#eEvent').value === '7' && $('#eDate').value === '2026-08-30');
  ok('and every basket panel is gone', !$('[data-bdpanel]'));

  w.eval(`draftApply(draftRead('7', '2026-08-30'));`);
  ok('the Chairpersons figure is back', /75,?850/.test($('[data-cat="s1.chairpersons"]').value),
    $('[data-cat="s1.chairpersons"]').value);
  ok('so is the counted Monday basket', /25,?510/.test(monday()), monday());
  const mp = $('[data-bdpanel][data-bdsvc="s1"][data-bdkey="dayborn.Monday"]');
  ok('its panel was rebuilt', !!mp);
  ok('folded, like any restored basket', mp && mp.style.display === 'none', mp && mp.style.display);
  ok('with the cash it was counted with',
    /5,?510/.test(mp.querySelector('[data-bd-cash]').value), mp.querySelector('[data-bd-cash]').value);
  ok('and its cheque row, number and bank intact',
    mp.querySelector('[data-chq-no], [data-bd-chq-no]')
      ? /267020/.test(mp.innerHTML) && /Absa/.test(mp.innerHTML)
      : /267020/.test(mp.innerHTML),
    mp.innerHTML.slice(0, 120));

  console.log('And the working copy is only dropped once the server has it:');
  ok('the draft is still there before saving', !!w.localStorage.getItem('aotc.fr.draft.7.2026-08-30'));
  w.eval('draftClear();');
  ok('and gone after', !w.localStorage.getItem('aotc.fr.draft.7.2026-08-30'));
  ok('draftRead returns nothing for a day with no draft', w.eval(`draftRead('7','2026-08-30')`) === null);

  console.log('And a date changed mid-entry does not orphan the working copy:');
  w.eval(`
    document.getElementById('eDate').value = '2026-08-30';
    document.querySelector('[data-cat="s1.chairpersons"]').value = '1,000';
    draftWrite();
    document.getElementById('eDate').value = '2026-09-06';
    draftWrite();
  `);
  ok('a copy exists under each date',
    !!w.localStorage.getItem('aotc.fr.draft.7.2026-08-30')
    && !!w.localStorage.getItem('aotc.fr.draft.7.2026-09-06'));
  w.eval('draftClear();');
  ok('clearing removes the one the form points at', !w.localStorage.getItem('aotc.fr.draft.7.2026-09-06'));
  w.eval(`document.getElementById('eDate').value = '2026-08-30'; draftClear();`);
  ok('and the earlier one can be cleared too', !w.localStorage.getItem('aotc.fr.draft.7.2026-08-30'));
}

console.log('The page itself no longer pulls to refresh:');
{
  const css = require('fs').readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
  ok('overscroll-behavior-y is contained on html and body',
    /html,\s*body\s*\{[^}]*overscroll-behavior-y:\s*contain/.test(css));
}

console.log(fail === 0 ? `\nALL ${pass} PASS` : `\n${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
