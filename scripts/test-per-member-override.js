process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
const path=require('path'), fs=require('fs'); const root=process.env.HOME+'/mnt/aotc-track';
const { JSDOM } = require(path.join(root,'node_modules/jsdom'));
const authPath=require.resolve(path.join(root,'middleware/auth')); const realAuth=require(authPath);
let CURRENT={id:1,name:'Clerk',role:'accounts',permissions:['finance.weekly','finance.quarterly']};
require.cache[authPath]={id:authPath,filename:authPath,loaded:true,exports:{...realAuth,
  requireAuth:(q,_r,n)=>{q.user=CURRENT;n();},
  requirePermission:p=>(q,r,n)=>{q.user=CURRENT;return(['admin','localadmin'].includes(CURRENT.role)||(CURRENT.permissions||[]).includes(p))?n():r.status(403).json({error:'no'});},
  requireAnyPermission:(...ps)=>(q,r,n)=>{q.user=CURRENT;return(['admin','localadmin'].includes(CURRENT.role)||ps.some(p=>(CURRENT.permissions||[]).includes(p)))?n():r.status(403).json({error:'no'});},
  canManageAllEntities:()=>true}};
const db=require(path.join(root,'utils/db'));
const express=require(path.join(root,'node_modules/express'));
const app=express(); app.use(express.json());
app.use('/api/finance-weekly', require(path.join(root,'routes/financeWeekly')));
let fail=0,n=0; const ok=(c,m)=>{n++;console.log((c?'  PASS ':'  FAIL ')+m); if(!c)fail++;};
const head=t=>console.log('\n── '+t);

const server=app.listen(0, async () => {
  const P=server.address().port, base=`http://127.0.0.1:${P}/api`;
  const call=async(m,u,b)=>{const r=await fetch(base+u,{method:m,headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json().catch(()=>({}))};};
  const get=u=>call('GET',u).then(r=>r.body);
  const CLERK={id:1,name:'Clerk',role:'accounts',permissions:['finance.weekly','finance.quarterly']};
  const TRE={id:2,name:'Treasurer',role:'treasurer',permissions:['finance.weekly.confirm']};

  head('Q2 2026: no weekly data at all, so nothing can be computed');
  let pm=(await get('/finance-weekly/totals?year=2026&quarter=2')).perMember;
  ok(pm.computed.offertoryPerMemberWeek===null,'the software computes nothing, and says so rather than showing zero');
  ok(pm.offertoryPerMemberWeek===null && pm.source.offertoryPerMemberWeek==='computed','so the effective figure is empty');

  head('Typing the known Q2 figures');
  let r=await call('PUT','/finance-weekly/per-member/2026/2',{offertoryPerMemberWeek:3.2,tithePerMemberMonth:26.5});
  ok(r.status===200,'they are accepted');
  pm=(await get('/finance-weekly/totals?year=2026&quarter=2')).perMember;
  ok(pm.offertoryPerMemberWeek===3.2 && pm.tithePerMemberMonth===26.5,'and are what the quarter now reports');
  ok(pm.source.offertoryPerMemberWeek==='typed','marked as typed, not passed off as computed');
  ok(pm.computed.offertoryPerMemberWeek===null,'the computation is untouched underneath');

  head('Q4 2026 has real weekly data — typed and computed side by side');
  CURRENT=CLERK;
  for (const [d,off,tit] of [['2026-10-04',5165,10830],['2026-10-11',4835,9170]])
    await call('PUT',`/finance-weekly/week/${d}`,{amounts:{offertory1:off,tithes:tit},status:'entered'});
  CURRENT=TRE; for (const d of ['2026-10-04','2026-10-11']) await call('POST',`/finance-weekly/week/${d}/confirm`,{});
  CURRENT=CLERK;
  pm=(await get('/finance-weekly/totals?year=2026&quarter=4')).perMember;
  const auto=pm.offertoryPerMemberWeek;
  ok(pm.source.offertoryPerMemberWeek==='computed' && auto>0,`Q4 computes on its own (${auto.toFixed(4)})`);
  await call('PUT','/finance-weekly/per-member/2026/4',{offertoryPerMemberWeek:9.99});
  pm=(await get('/finance-weekly/totals?year=2026&quarter=4')).perMember;
  ok(pm.offertoryPerMemberWeek===9.99,'a typed figure overrides even where data exists');
  ok(Math.abs(pm.computed.offertoryPerMemberWeek-auto)<1e-9,'and the computed figure is still returned, unchanged, for comparison');
  ok(pm.source.tithePerMemberMonth==='computed','the OTHER measure is untouched — each decides for itself');

  head('Reverting hands it straight back');
  await call('PUT','/finance-weekly/per-member/2026/4',{offertoryPerMemberWeek:null});
  pm=(await get('/finance-weekly/totals?year=2026&quarter=4')).perMember;
  ok(pm.source.offertoryPerMemberWeek==='computed' && Math.abs(pm.offertoryPerMemberWeek-auto)<1e-9,'blank restores the computed figure exactly');

  head('Quarters do not bleed into each other');
  ok((await get('/finance-weekly/totals?year=2026&quarter=2')).perMember.offertoryPerMemberWeek===3.2,'Q2 still holds its typed figure');
  ok((await get('/finance-weekly/totals?year=2026&quarter=3')).perMember.source.offertoryPerMemberWeek==='computed','Q3 was never touched');

  head('Guards');
  ok((await call('PUT','/finance-weekly/per-member/2026/4',{offertoryPerMemberWeek:'abc'})).status===400,'a non-number is refused');
  ok((await call('PUT','/finance-weekly/per-member/2026/9',{offertoryPerMemberWeek:1})).status===400,'a bad quarter is refused');
  CURRENT={id:9,role:'viewer',permissions:['congregation.view']};
  ok((await call('PUT','/finance-weekly/per-member/2026/2',{offertoryPerMemberWeek:1})).status===403,'a viewer cannot type figures');
  CURRENT=CLERK;

  head('It renders, and the page can move between quarters');
  const html=fs.readFileSync(path.join(root,'public/finance-weekly.html'),'utf8');
  const js=fs.readFileSync(path.join(root,'public/js/page-finance-weekly.js'),'utf8');
  const dom=new JSDOM(html,{url:'http://localhost/finance-weekly.html?date=2026-10-04',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;
  w.api=async(p,o={})=>{const rr=await fetch(base+p,{method:o.method||'GET',headers:{'Content-Type':'application/json'},body:o.body?JSON.stringify(o.body):undefined});
    const d=(rr.headers.get('content-type')||'').includes('application/json')?await rr.json():null;
    if(!rr.ok){const e=new Error((d&&d.error)||'err');e.status=rr.status;throw e;} return d;};
  w.esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  w.toast=()=>{}; w.reopenButtonHtml=(k,t,l)=>`<button data-reopen-kind="${k}">${l||'Request to reopen'}</button>`; w.confirmDialog=async()=>true; w.isElevated=u=>['admin','localadmin'].includes(u.role);
  w.requireAuthAndRenderShell=async()=>CLERK; w.CSS={escape:s=>String(s).replace(/[^a-zA-Z0-9_-]/g,'\\$&')};
  w.eval(js);
  const wait=async pred=>{for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,25)); if(pred())break;}};
  await wait(()=>w.document.getElementById('totalsCard').innerHTML.includes('Giving per member'));
  let txt=w.document.getElementById('totalsCard').textContent;
  ok(/Giving per member .* Q4 2026/.test(txt.replace(/\s+/g,' ')),'opens on the quarter of the Sunday on screen');
  ok(/computed/.test(txt),'shows the computed badge');
  w.showQuarter(2);
  await wait(()=>w.document.getElementById('totalsCard').textContent.includes('Q2 2026'));
  txt=w.document.getElementById('totalsCard').textContent;
  ok(/Q2 2026/.test(txt),'the quarter picker moves it to Q2 without changing the Sunday');
  ok(/typed/.test(txt),'Q2 shows its typed figure, badged as typed');
  ok(/software would say nothing yet/.test(txt),'and says what reverting would give — nothing, for Q2');
  ok(!/undefined|NaN/.test(txt),'no undefined / NaN');

  console.log(`\n${n-fail}/${n} checks — ${fail?'FAILURES ABOVE':'all green'}`);
  server.close(); process.exit(fail);
});
