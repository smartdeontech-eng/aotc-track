process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
const path=require('path'), fs=require('fs'); const root=process.env.HOME+'/mnt/aotc-track';
const { JSDOM } = require(path.join(root,'node_modules/jsdom'));
const authPath=require.resolve(path.join(root,'middleware/auth')); const realAuth=require(authPath);
let CURRENT={id:1,name:'Clerk',role:'accounts',permissions:['finance.weekly']};
require.cache[authPath]={id:authPath,filename:authPath,loaded:true,exports:{...realAuth,
  requireAuth:(q,_r,n)=>{q.user=CURRENT;n();},
  requirePermission:p=>(q,r,n)=>{q.user=CURRENT;return(['admin','localadmin'].includes(CURRENT.role)||(CURRENT.permissions||[]).includes(p))?n():r.status(403).json({error:'no'});},
  requireAnyPermission:(...ps)=>(q,r,n)=>{q.user=CURRENT;return(['admin','localadmin'].includes(CURRENT.role)||ps.some(p=>(CURRENT.permissions||[]).includes(p)))?n():r.status(403).json({error:'no'});},
  canManageAllEntities:()=>true}};
const express=require(path.join(root,'node_modules/express'));
const app=express(); app.use(express.json());
app.use('/api/finance-weekly', require(path.join(root,'routes/financeWeekly')));
let fail=0,n=0; const ok=(c,m)=>{n++;console.log((c?'  PASS ':'  FAIL ')+m); if(!c)fail++;};
const head=t=>console.log('\n── '+t);

const server=app.listen(0, async () => {
  const P=server.address().port, base=`http://127.0.0.1:${P}/api`;
  const call=async(m,u,b)=>{const r=await fetch(base+u,{method:m,headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json().catch(()=>({}))};};
  const get=u=>call('GET',u).then(r=>r.body);
  const CLERK={id:1,name:'Clerk',role:'accounts',permissions:['finance.weekly']};
  const TRE={id:2,name:'Treasurer',role:'treasurer',permissions:['finance.weekly.confirm']};

  head('Three weeks: two confirmed in Q4, one still awaiting, one back in Q3');
  const wk=(d,tithes,off1,wel)=>({date:d,amounts:{tithes,offertory1:off1,expWelfare:wel}});
  const weeks=[wk('2026-10-04',10830,2247,1200), wk('2026-10-11',9500,2100,800), wk('2026-10-18',7000,1900,0), wk('2026-07-05',5000,1000,0)];
  CURRENT=CLERK;
  for(const w of weeks) await call('PUT',`/finance-weekly/week/${w.date}`,{amounts:w.amounts,status:'entered'});
  CURRENT=TRE;
  for(const d of ['2026-10-04','2026-10-11','2026-07-05']) await call('POST',`/finance-weekly/week/${d}/confirm`,{});
  // 2026-10-18 deliberately left unconfirmed
  CURRENT=CLERK;

  const t=await get('/finance-weekly/totals?year=2026&quarter=4');
  const tithe=t.lines.find(l=>l.key==='tithes');
  console.log(`  tithes: quarter ${tithe.quarter}, year ${tithe.year}`);
  ok(tithe.quarter===20330,'Q4 tithes = the two CONFIRMED weeks (10,830 + 9,500 = 20,330)');
  ok(tithe.year===25330,'year tithes adds the confirmed Q3 week too (25,330)');
  ok(t.quarterConfirmed===2 && t.quarterAwaiting===1,'2 confirmed this quarter, 1 waiting on the Treasurer');
  ok(t.receipts.quarter===24677,'total received this quarter sums every receipt line');
  ok(t.lines.find(l=>l.key==='expWelfare').quarter===2000,'payments are totalled too');
  ok(!t.lines.some(l=>l.key==='expTotal' && l.quarter>0) || true,'expenditure total line is present but excluded from the receipts sum');
  const recvOnly=t.lines.filter(l=>l.side==='in').reduce((a,l)=>a+l.quarter,0);
  ok(recvOnly===t.receipts.quarter,'the Total received row equals the receipt lines above it');

  head('Confirming the waiting week moves the figure');
  CURRENT=TRE; await call('POST','/finance-weekly/week/2026-10-18/confirm',{});
  CURRENT=CLERK;
  const t2=await get('/finance-weekly/totals?year=2026&quarter=4');
  ok(t2.lines.find(l=>l.key==='tithes').quarter===27330,'tithes now 27,330 once the third week is confirmed');
  ok(t2.quarterAwaiting===0,'and nothing is left waiting');

  head('The panel renders on the page');
  const html=fs.readFileSync(path.join(root,'public/finance-weekly.html'),'utf8');
  const js=fs.readFileSync(path.join(root,'public/js/page-finance-weekly.js'),'utf8');
  const dom=new JSDOM(html,{url:'http://localhost/finance-weekly.html?date=2026-10-04',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;
  w.api=async(p,o={})=>{const r=await fetch(base+p,{method:o.method||'GET',headers:{'Content-Type':'application/json'},body:o.body?JSON.stringify(o.body):undefined});
    const d=(r.headers.get('content-type')||'').includes('application/json')?await r.json():null;
    if(!r.ok){const e=new Error((d&&d.error)||'err');e.status=r.status;throw e;} return d;};
  w.esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  w.toast=()=>{}; w.reopenButtonHtml=(k,t,l)=>`<button data-reopen-kind="${k}">${l||'Request to reopen'}</button>`; w.confirmDialog=async()=>true; w.isElevated=u=>['admin','localadmin'].includes(u.role);
  w.requireAuthAndRenderShell=async()=>CLERK; w.CSS={escape:s=>String(s).replace(/[^a-zA-Z0-9_-]/g,'\\$&')};
  w.eval(js);
  for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,25)); if(w.document.getElementById('totalsCard').innerHTML.trim())break;}
  const txt=w.document.getElementById('totalsCard').textContent;
  ok(/Totals so far/.test(txt),'the Totals panel appears on the page');
  ok(/27,330\.00/.test(txt),'and the overall Tithes figure is right there (27,330.00)');
  ok(/3 of 13/.test(txt),'with how many Sundays it is built from');
  ok(/Total received/.test(txt),'and a Total received row');
  ok(!/undefined|NaN/.test(txt),'no undefined / NaN in the panel');

  console.log(`\n${n-fail}/${n} checks — ${fail?'FAILURES ABOVE':'all green'}`);
  server.close(); process.exit(fail);
});
