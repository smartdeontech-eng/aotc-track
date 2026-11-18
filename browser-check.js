// The Minutes page, opened the way the Clerk opens it, in a real browser.
//
// Written after a swallowed ReferenceError in openDoc left the editor showing
// with an empty roll and empty agenda — the data was safe on the server the
// whole time, but it read as lost work. A unit test could not have caught it;
// only actually loading the page could.
process.env.JWT_SECRET='x'.repeat(48);
process.env.AOTC_DATA_DIR='/tmp/aotc-repro';
const fs=require('fs');
fs.rmSync('/tmp/aotc-repro',{recursive:true,force:true}); fs.mkdirSync('/tmp/aotc-repro',{recursive:true});
const express=require('express'), cookieParser=require('cookie-parser'), jwt=require('jsonwebtoken'), db=require('./utils/db');
const clerk=db.insert('users',{name:'Gideon',email:'g@x.com',role:'clerk',
  permissions:['approvals.manage','congregation.view','minutes.manage'],sessionVersion:0});
const T=jwt.sign({id:clerk.id,name:clerk.name,email:clerk.email,role:clerk.role,sv:0},process.env.JWT_SECRET,{expiresIn:'1h'});

const app=express(); app.use(express.json()); app.use(cookieParser());
app.get('/api/auth/me',(req,res)=>res.json({ ...clerk, workspaces: [], entity:{type:'congregation',id:0,name:'AOTC'} }));
app.get('/api/setup/committees',(q,r)=>r.json([])); app.get('/api/setup/groups',(q,r)=>r.json([]));
app.get('/api/notifications',(q,r)=>r.json([])); app.get('/api/notifications/unread',(q,r)=>r.json({count:0}));
app.use('/api/minutes', require('./routes/minutes'));
app.use((req,res,next)=>{ if(req.path.startsWith('/api')) return res.status(404).json({error:'no route '+req.path}); next(); });
app.use(express.static('public'));
const server=app.listen(4455, run);

async function run(){
  const call=async(m,p,b)=>{const r=await fetch('http://localhost:4455/api/minutes'+p,{method:m,
    headers:{cookie:`token=${T}`,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});
    return {status:r.status, body:await r.json()};};
  const ros=(await call('POST','/roster/seed')).body;
  const doc=(await call('POST','/',{date:'2026-09-24',venue:'Rev Adu-Mante Session Hall'})).body;
  await call('PUT',`/${doc.id}/roll`,{roll:{presentIds:[ros[0].id,ros[1].id,ros[5].id]}});
  const earlier=(await call('POST','/',{date:'2026-09-10'})).body;
  await call('POST','/',{date:'2026-09-17'});
  await call('PUT','/'+doc.id,{agenda:[
    {mins:8,item:'Devotion',responsible:'Presbyters on Duty',subItems:[]},
    {mins:10,item:'Review of minutes',responsible:'Session Clerk',subItems:[{item:'Minutes of 10th September 2026'},{item:'Minutes of 17th September 2026'}]},
    {mins:15,item:'Matters Arising',responsible:'',subItems:[{item:'Update on Building Project',responsible:''}]},
  ]});
  const check=(await call('GET','/'+doc.id)).body;
  let pass=0, fail=0;
  const ok=(n,c,x)=>{c?(pass++,console.log('  \u2713',n)):(fail++,console.log('  \u2717 FAIL:',n,JSON.stringify(x)))};
  console.log('Opening the minutes from Session Meetings:');
  ok('the roll is on the server before we start',(check.doc.roll.presentIds||[]).length===3);
  ok('and so is the agenda',(check.doc.agenda||[]).length===3);

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx = await browser.newContext();
  await ctx.addCookies([{name:'token',value:T,domain:'localhost',path:'/'}]);
  const page = await ctx.newPage();
  const errors=[];
  page.on('pageerror', e => errors.push('PAGEERROR: '+e.message));
  page.on('console', m => { if (m.type()==='error') errors.push('CONSOLE: '+m.text()); });

  // surface what the boot's catch swallows
  await page.addInitScript(() => {
    window.__caught = [];
    const realError = console.error;
    console.error = (...a) => { window.__caught.push(String(a[0])); realError(...a); };
    window.addEventListener('unhandledrejection', e => window.__caught.push('REJECT: ' + (e.reason && e.reason.stack || e.reason)));
  });
  // two sets of minutes reviewed on the night, each with its own adoption
  await fetch('http://localhost:4455/api/minutes/'+doc.id+'/reviews',{method:'PUT',
    headers:{cookie:`token=${T}`,'content-type':'application/json'},
    body:JSON.stringify({reviews:[
      {date:'10th September 2026',iso:'2026-09-10',readBy:'',movedBy:'',secondedBy:'',corrections:[{where:'Item numbering',note:'x'}]},
    ]})});
  await page.goto(`http://localhost:4455/minutes.html?meeting=${doc.id}`, { waitUntil:'networkidle' });
  await page.waitForTimeout(1200);

  const seen = await page.evaluate(() => ({
    editorShown: document.getElementById('editor')?.style.display !== 'none',
    listShown: document.getElementById('listView')?.style.display !== 'none',
    rollRows: document.querySelectorAll('#rollGrid .roll-row').length,
    rollOn: document.querySelectorAll('#rollGrid .roll-seg button.on:not(.abs)').length,
    agendaRows: document.querySelectorAll('#agRows .ag-row').length,
    head: document.getElementById('headSub')?.textContent,
    reviewBlocks: document.querySelectorAll('#reviewList .rev').length,
    corrections: document.querySelectorAll('#reviewList .fix').length,
    dateIsPicker: !!document.querySelector('#reviewList select'),
    addLabel: document.getElementById('addReviewBtn')?.textContent.trim(),
    agendaNamed: [...document.querySelectorAll('#reviewList optgroup')].map(g => g.label),
    offered: [...document.querySelectorAll('#reviewList optgroup option')].map(o => o.textContent),
  }));
  const caught = (await page.evaluate(() => window.__caught || [])).filter(c => !/404|MIME/.test(c));
  ok('the editor opens', seen.editorShown && !seen.listShown, seen);
  ok('every member of the roster is listed', seen.rollRows===25, seen.rollRows);
  ok('the three ticked as present come through', seen.rollOn===3, seen.rollOn);
  ok('the agenda rows are there', seen.agendaRows===3, seen.agendaRows);
  ok('and the page threw nothing', caught.length===0, caught.slice(0,2));
  ok('the recorded set gets its own block', seen.reviewBlocks===1, seen.reviewBlocks);
  ok('and the correction sits inside the block it belongs to', seen.corrections===1, seen.corrections);
  ok('which minutes to review is a dropdown, not a typed date', seen.dateIsPicker);
  ok('headed by what tonight\'s agenda names', seen.agendaNamed.includes("On tonight's agenda"), seen.agendaNamed);
  ok('offering the meetings the agenda listed',
     seen.offered.includes('10th September 2026') && seen.offered.includes('17th September 2026'), seen.offered);

  // Adding a second block should take the set that is left, without being asked.
  await page.click('.mtab[data-pane="body"]');   // the review blocks live on the Minutes tab
  await page.waitForTimeout(200);
  await page.click('#addReviewBtn');
  await page.waitForTimeout(500);
  const two = await page.evaluate(() => {
    // the first select in each block is the "which minutes" picker
    const firsts = [...document.querySelectorAll('#reviewList .rev')].map(b => b.querySelector('select'));
    const first = firsts[0], second = firsts[1];
    return {
      blocks: document.querySelectorAll('#reviewList .rev').length,
      firstPick: first ? first.value : null,
      secondPick: second ? second.value : null,
      secondDisabled: second ? [...second.options].filter(o => o.disabled).map(o => o.textContent) : [],
    };
  });
  ok('the button says "another" only once there is one', seen.addLabel==='+ Another set of minutes', seen.addLabel);
  ok('a second block appears', two.blocks===2, two.blocks);
  ok('and the set left over is chosen for it',
     two.firstPick==='10th September 2026' && two.secondPick==='17th September 2026', two);
  ok('with the one already added shown as taken',
     two.secondDisabled.some(t => /10th September 2026 · already added/.test(t)), two.secondDisabled);

  // a set of minutes with nothing reviewed yet must not say "another"
  const fresh=(await call('POST','/',{date:'2026-10-15'})).body;
  await page.goto(`http://localhost:4455/minutes.html?meeting=${fresh.id}`, { waitUntil:'networkidle' });
  await page.waitForTimeout(600);
  const empty = await page.evaluate(() => ({
    label: document.getElementById('addReviewBtn')?.textContent.trim(),
    blocks: document.querySelectorAll('#reviewList .rev').length,
  }));
  ok('with nothing reviewed the button invites a first one',
     empty.blocks===0 && empty.label==='+ Add the minutes reviewed', empty);

  // With nothing on the agenda and no earlier meetings, the dropdown is empty —
  // and must say why rather than looking broken.
  await page.click('.mtab[data-pane="body"]');
  await page.click('#addReviewBtn');
  await page.waitForTimeout(400);
  const bare = await page.evaluate(() => {
    const rev = document.querySelector('#reviewList .rev');
    const sel = rev && rev.querySelector('select');
    return { hasSelect: !!sel,
             options: sel ? [...sel.options].map(o => o.textContent) : [],
             hint: rev ? [...rev.querySelectorAll('.sub')].map(p => p.textContent).join(' ') : '' };
  });
  ok('the dropdown is still there when there is nothing to offer', bare.hasSelect, bare);
  ok('and it says where the list comes from',
     /Review of minutes/.test(bare.hint), bare.hint.slice(0,140));
  ok('offering the earlier sittings the app holds', bare.options.length > 2, bare.options);

  // ---- Matters Arising comes from the Outstanding Matters register ----------
  // Two open matters on the register, one of which is ALREADY on the agenda, so
  // pressing the button must add exactly one and never duplicate.
  await call('POST', '/matters', { subject: 'Update on Building Project', owner: 'Ing Sampson Agudze', status: 'open' });
  await call('POST', '/matters', { subject: 'Church Bus insurance renewal', owner: 'Mr Kwaku Koranteng', status: 'open' });
  await call('POST', '/matters', { subject: 'Something long since finished', status: 'closed' });

  await page.goto(`http://localhost:4455/minutes.html?meeting=${doc.id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.click('.mtab[data-pane="agenda"]').catch(() => {});
  await page.waitForTimeout(300);
  const btn = await page.$('button[onclick^="agFromRegister"]');
  ok('the Matters Arising row offers to bring the register in', !!btn);
  const other = await page.$$('button[onclick^="agFromRegister"]');
  ok('and only that row does — not Devotion, not Review of Minutes', other.length === 1, other.length);

  if (btn) {
    await btn.click();
    await page.waitForTimeout(1200);
  }
  const pulled = (await call('GET', '/' + doc.id)).body.doc.agenda
    .find(r => /Matters Arising/i.test(r.item || '')) || {};
  const subs = (pulled.subItems || []).map(x => x.item);
  ok('the open matter is now a sub-item', subs.includes('Church Bus insurance renewal'), subs);
  ok('the one already on the agenda is not duplicated',
    subs.filter(x => x === 'Update on Building Project').length === 1, subs);
  ok('a closed matter is not brought in', !subs.includes('Something long since finished'), subs);
  ok('and the register says who should act',
    (pulled.subItems || []).some(x => /Kwaku Koranteng/.test(x.responsible || '')), pulled.subItems);

  // re-query: renderAgenda() replaced the DOM, so the old handle is stale
  const again = await page.$('button[onclick^="agFromRegister"]');
  if (again) { await again.click(); await page.waitForTimeout(1200); }
  const twice = (await call('GET', '/' + doc.id)).body.doc.agenda
    .find(r => /Matters Arising/i.test(r.item || '')) || {};
  ok('pressing it twice changes nothing', (twice.subItems || []).length === subs.length,
    { first: subs.length, second: (twice.subItems || []).length });

  // back to the empty set of minutes for the proceedings checks below
  await page.goto(`http://localhost:4455/minutes.html?meeting=${fresh.id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  // ---- prayers are captured point by point -----------------------------------
  await page.click('.mtab[data-pane="proceedings"]').catch(() => {});
  await page.waitForTimeout(300);
  const prayed = await page.evaluate(async () => {
    document.getElementById('addPrayerBtn').click();
    document.getElementById('addPrayerBtn').click();
    const ins = [...document.querySelectorAll('#prayerPoints .pt-row input')];
    ins[0].value = 'God\u2019s presence with the Congregation at all times';
    ins[0].dispatchEvent(new Event('input', { bubbles: true }));
    ins[1].value = 'Protection of the Chapel from further flooding';
    ins[1].dispatchEvent(new Event('input', { bubbles: true }));
    const nt = document.getElementById('pPrayerNote');
    nt.value = 'The District Minister then led the Session to pray for one another.';
    nt.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 1400));
    return { rows: document.querySelectorAll('#prayerPoints .pt-row').length,
             numbers: [...document.querySelectorAll('#prayerPoints .pt-n')].map(n => n.textContent) };
  });
  ok('prayer points are added one at a time and numbered', prayed.rows === 2 && prayed.numbers.join('') === '1.2.', prayed);

  const saved = (await call('GET', '/' + fresh.id)).body.doc.proceedings.prayers || {};
  ok('and they are saved in the order they were prayed',
     (saved.points || []).length === 2 && /Chapel/.test(saved.points[1]), saved.points);
  ok('with the note kept alongside them', /pray for one another/.test(saved.note || ''), saved.note);

  const dropped = await page.evaluate(async () => {
    document.querySelector('#prayerPoints .pt-row .pt-x').click();
    await new Promise(r => setTimeout(r, 800));
    return document.querySelectorAll('#prayerPoints .pt-row').length;
  });
  ok('a point can be taken back out', dropped === 1, dropped);

  // ---- the closing of the meeting -------------------------------------------
  // The Grace, the benediction, both or neither: the Clerk ticks, and the
  // sentence he is about to print reads back to him before he prints it.
  await page.click('.mtab[data-pane="proceedings"]').catch(() => {});
  await page.waitForTimeout(300);
  const closing = await page.evaluate(async () => {
    const setP = async (k, v) => {
      const el = document.getElementById(k);
      el.value = v; el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    await setP('pCloseMoved', '');
    const out = {};
    const doc = window.__doc || null;
    return { hasTick: !!document.getElementById('pGrace'),
             hasPreview: !!document.getElementById('closurePreview') };
  });
  ok('the closing card carries a tick for the Grace', closing.hasTick, closing);
  ok('and reads the closure sentence back before it is printed', closing.hasPreview, closing);

  const said = await page.evaluate(async () => {
    document.getElementById('pGrace').click();
    await new Promise(r => setTimeout(r, 500));
    return document.getElementById('closurePreview').textContent;
  });
  ok('ticking the Grace puts it into the sentence', /after which the Grace was said\.$/.test(said), said);

  const kept = (await call('GET', '/' + fresh.id)).body;
  ok('and the tick is saved, not just shown', kept.doc.proceedings.graceSaid === true,
     kept.doc.proceedings.graceSaid);

  const after=(await call('GET','/'+doc.id)).body;
  ok('and opening the page changed nothing on the server',
     (after.doc.roll.presentIds||[]).length===3 && (after.doc.agenda||[]).length===3,
     {roll:(after.doc.roll.presentIds||[]).length, agenda:(after.doc.agenda||[]).length});
  if (process.env.SHOT) {
    await page.evaluate(async () => {
      document.getElementById('addPrayerBtn').click();
      const ins = [...document.querySelectorAll('#prayerPoints .pt-row input')];
      ins[ins.length - 1].value = 'Protection of congregants and their families from ailments and premature death';
      ins[ins.length - 1].dispatchEvent(new Event('input', { bubbles: true }));
      const sel = document.getElementById('pPrayerLed');
      if (sel && sel.options.length > 1) { sel.selectedIndex = 1; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      document.getElementById('pGrace').click();
      const mv = document.getElementById('pCloseMoved');
      if (mv && mv.options.length > 1) { mv.selectedIndex = 1; mv.dispatchEvent(new Event('change', { bubbles: true })); }
      document.getElementById('pClosedAt').value = '9.05 p.m.';
      document.getElementById('pClosedAt').dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1200));
    });
    const card = await page.$('.prayer-card');
    await page.screenshot({ path: '/tmp/prayer-card.png', clip: await (async () => {
      const b = await card.boundingBox();
      return { x: b.x - 12, y: b.y - 12, width: b.width + 24, height: b.height + 330 };
    })() });
  }

  console.log('');
  console.log(fail===0?`ALL ${pass} CHECKS PASSED`:`${fail} FAILED, ${pass} passed`);
  await browser.close(); server.close(); process.exit(fail?1:0);
}
