// The client half of the unlock-request flow.
//
// routes/unlocks.js is tested separately; this asks the narrower question the
// server cannot answer: does each locked screen actually OFFER the button, to
// the right person, carrying the right kind and target — and does the admin
// still get their direct unlock instead of being made to ask themselves?
//
// It also checks the one piece of shared machinery: reopenButtonHtml() and the
// delegated click handler in app.js, which every one of those buttons goes
// through.
const path = require('path'), fs = require('fs');
const ROOT = path.join(__dirname, '..');
const { JSDOM } = require(path.join(ROOT, 'node_modules/jsdom'));

let fail = 0, n = 0;
const ok = (c, m) => { n++; console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fail++; };
const head = t => console.log('\n── ' + t);
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---- 1. The shared helper and handler, in a real DOM --------------------------
head('The button itself (app.js)');
{
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>',
    { runScripts: 'outside-only', url: 'https://track.pcg-aotc.com/meetings.html' });
  const w = dom.window;
  // app.js is a whole shell; we only want the two functions, so give it the
  // globals they touch and let the rest of the file define itself harmlessly.
  const app = read('public/js/app.js');
  const sliceStart = app.indexOf('function esc(value)');
  const helper = app.slice(app.indexOf('const UNLOCK_KIND_LABELS'), app.indexOf('function money(n)'));
  w.eval(app.slice(sliceStart, app.indexOf('\n', app.indexOf('}', sliceStart))) + '\n}');
  const calls = [];
  w.api = async (p, o) => { calls.push([p, o]); return { id: 1, status: 'pending' }; };
  w.toast = msg => { w.__toast = msg; };
  w.promptDialog = async () => '  two names ticked by mistake  ';
  w.eval(helper);

  const html = w.reopenButtonHtml('meeting-attendance', { meetingId: 42 }, 'Ask to reopen');
  w.document.getElementById('host').innerHTML = html;
  const btn = w.document.querySelector('[data-reopen-kind]');
  ok(!!btn, 'reopenButtonHtml renders a button');
  ok(btn.getAttribute('data-reopen-kind') === 'meeting-attendance', 'carrying its kind');
  ok(JSON.parse(btn.getAttribute('data-reopen-target')).meetingId === 42, 'and its target, intact through the attribute');
  ok(btn.textContent === 'Ask to reopen', 'with the label it was given');

  // A target with a quote in it must not break out of the attribute.
  w.document.getElementById('host').innerHTML =
    w.reopenButtonHtml('service-day', { date: '2026-09-20', note: 'a "quoted" thing' });
  const q = w.document.querySelector('[data-reopen-kind]');
  ok(q && JSON.parse(q.getAttribute('data-reopen-target')).note === 'a "quoted" thing',
     'a quote in the target survives the round trip instead of breaking the HTML');

  return (async () => {
    // Clicking goes through app.js's delegated handler, not an inline onclick.
    q.click();
    await new Promise(r => setTimeout(r, 30));
    ok(calls.length === 1 && calls[0][0] === '/unlocks', 'clicking it posts to /unlocks');
    ok(calls[0][1].body.kind === 'service-day', 'with the kind');
    ok(calls[0][1].body.reason === 'two names ticked by mistake', 'and the typed reason, trimmed');
    ok(/Request sent/.test(w.__toast || ''), 'and the person is told it was sent');

    // ---- 2. Meetings: a locked attendance row ---------------------------------
    head('Meetings — a locked attendance record');
    const mdom = new JSDOM(read('public/meetings.html'),
      { runScripts: 'outside-only', url: 'https://track.pcg-aotc.com/meetings.html' });
    const mw = mdom.window;
    const MEETING = {
      id: 7, date: '2026-09-20', time: '16:00', title: 'September general meeting',
      status: 'held', mode: 'in-person', venueName: 'Church hall',
      entityType: 'group', entityId: 6,
      attendance: { locked: true, recordedBy: 'WF Secretary', recordedAt: '2026-09-20T18:00:00Z', present: [] },
    };
    const renderAs = async user => {
      mw.me = user;
      mw.esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      mw.isElevated = u => ['admin', 'localadmin'].includes(u.role);
      mw.toast = () => {}; mw.confirmDialog = async () => true;
      mw.reopenButtonHtml = (k, t, l) => '<button data-reopen-kind="' + k
        + '" data-reopen-target=\'' + JSON.stringify(t) + '\'>' + (l || 'Request to reopen') + '</button>';
      // The overview tiles are not what this test is about; without this the
      // array stub reached them and threw later, unhandled, depending on timing.
      mw.api = async p => { if (p.startsWith('/meetings/overview')) throw new Error('not in this test'); return p.startsWith('/meetings/venues') ? [] : [MEETING]; };
      mw.requireAuthAndRenderShell = async () => user;
      mw.toLocalDate = d => new Date(d + 'T00:00:00');
      mw.eval(read('public/js/page-meetings.js'));
      mw.me = user;              // the script's own `let me` shadows the stub
      await mw.load();
      return mw.document.getElementById('rows');
    };
    // Read the target off the parsed attribute, not off the serialised HTML:
    // innerHTML re-escapes the quotes, so a regex over it proves nothing.
    const targetOf = el => {
      const b = el.querySelector('[data-reopen-target]');
      return b ? JSON.parse(b.getAttribute('data-reopen-target')) : null;
    };

    const secRows = await renderAs({ id: 3, role: 'secretary', name: 'WF Secretary',
      permissions: ['meetings.manage'], entity: { type: 'group', id: 6 } });
    ok(!!secRows.querySelector('[data-reopen-kind="meeting-attendance"]'), 'the secretary who recorded it is offered the button');
    ok((targetOf(secRows) || {}).meetingId === 7, 'pointed at that meeting');
    ok(!/unlockAtt\(/.test(secRows.innerHTML), 'and is NOT shown the admin unlock');

    const admRows = await renderAs({ id: 1, role: 'admin', name: 'Admin', permissions: [] });
    ok(/unlockAtt\(7\)/.test(admRows.innerHTML), 'the admin keeps the direct Unlock');
    ok(!admRows.querySelector('[data-reopen-kind]'), 'and is not made to ask themselves for it');

    // ---- 3. The call sites, as written ----------------------------------------
    // Cheap, but it is the thing that silently rots: a page stops offering the
    // button, or asks for the wrong kind, and nothing else notices.
    head('Every locked screen offers it');
    const sites = [
      ['public/js/page-meetings.js', 'meeting-attendance', 'meetingId'],
      ['public/js/page-attendance.js', 'service-day', 'date'],
      ['public/js/page-fundraising.js', 'fundraising-day', 'eventId'],
      ['public/js/page-finance-weekly.js', 'finance-week', 'date'],
    ];
    const KINDS = Object.keys(require(path.join(ROOT, 'utils/unlockKinds')).KINDS);
    sites.forEach(([file, kind, field]) => {
      const src = read(file);
      const call = (src.match(new RegExp("reopenButtonHtml\\('" + kind + "'[^\\n]*")) || [''])[0];
      ok(!!call, `${path.basename(file)} asks for '${kind}'`);
      ok(call.includes(field), `  └ and names ${field} in its target`);
    });
    // The quarterly entry is the fifth kind and already had its own change-request
    // flow before this work; it is deliberately NOT given a second button.
    ok(!read('public/js/page-entry.js').includes('reopenButtonHtml'),
       "the quarterly entry keeps its existing change-request flow rather than a second way to ask");
    ok(KINDS.length === 5, 'and there are still five kinds of lock in all');

    const nav = read('public/js/app.js');
    ok(/href: '\/unlocks\.html'/.test(nav), 'the queue is reachable from the menu');
    ok(fs.existsSync(path.join(ROOT, 'public/unlocks.html')), 'and the page exists');

    console.log(`\n${n - fail}/${n} checks — ${fail ? fail + ' FAILED (above)' : 'all green'}`);
    process.exit(fail ? 1 : 0);
  })();
}
