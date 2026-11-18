process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
const path=require('path'), fs=require('fs'); const root=process.env.HOME+'/mnt/aotc-track';
const { JSDOM } = require(path.join(root,'node_modules/jsdom'));
const authPath=require.resolve(path.join(root,'middleware/auth')); const realAuth=require(authPath);
let CURRENT={id:1,role:'accounts',name:'Clerk',permissions:['finance.weekly','finance.quarterly']};
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
  const CLERK={id:1,role:'accounts',name:'Clerk',permissions:['finance.weekly','finance.quarterly']};
  const TRE={id:2,role:'treasurer',name:'Treasurer',permissions:['finance.weekly.confirm']};

  head('Q1 and Q2 left completely empty - nothing should break');
  for (const q of [1,2,3]) {
    const t=await get(`/finance-weekly/totals?year=2026&quarter=${q}`);
    ok(t.quarterConfirmed===0 && t.receipts.quarter===0, `Q${q} reports zero cleanly, no error`);
    ok(t.perMember.offertoryPerMemberWeek===null, `Q${q} per-member is empty rather than a false zero`);
  }

  head('Only the last three Sundays of the year are entered');
  CURRENT=CLERK;
  for (const d of ['2026-09-27','2026-10-04','2026-10-11'])
    await call('PUT',`/finance-weekly/week/${d}`,{amounts:{tithes:10000,offertory1:5000},status:'entered'});
  CURRENT=TRE; for (const d of ['2026-09-27','2026-10-04','2026-10-11']) await call('POST',`/finance-weekly/week/${d}/confirm`,{});
  CURRENT=CLERK;
  const t=await get('/finance-weekly/totals?year=2026&quarter=4');
  console.log(`  year: ${t.yearConfirmed} of ${t.sundaysInYear} Sundays, ${t.firstWeek} to ${t.lastWeek}`);
  ok(t.sundaysInYear===52 || t.sundaysInYear===53,'the year knows how many Sundays it has');
  ok(t.yearConfirmed===3,'and how few are actually on record');
  ok(t.firstWeek==='2026-09-27' && t.lastWeek==='2026-10-11','and names the period the figures really cover');
  ok(t.lines.find(l=>l.key==='tithes').year===30000,'the year figure is the three weeks, not a projection');

  head('The page says so rather than letting it read as a full year');
  const html=fs.readFileSync(path.join(root,'public/finance-weekly.html'),'utf8');
  const js=fs.readFileSync(path.join(root,'public/js/page-finance-weekly.js'),'utf8');
  const dom=new JSDOM(html,{url:'http://localhost/finance-weekly.html?date=2026-10-11',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;
  w.api=async(p,o={})=>{const rr=await fetch(base+p,{method:o.method||'GET',headers:{'Content-Type':'application/json'},body:o.body?JSON.stringify(o.body):undefined});
    const d=(rr.headers.get('content-type')||'').includes('application/json')?await rr.json():null;
    if(!rr.ok){const e=new Error((d&&d.error)||'err');e.status=rr.status;throw e;} return d;};
  w.esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  w.toast=()=>{}; w.reopenButtonHtml=(k,t,l)=>`<button data-reopen-kind="${k}">${l||'Request to reopen'}</button>`; w.confirmDialog=async()=>true; w.isElevated=u=>['admin','localadmin'].includes(u.role);
  w.requireAuthAndRenderShell=async()=>CLERK; w.CSS={escape:s=>String(s).replace(/[^a-zA-Z0-9_-]/g,'\\$&')};
  w.eval(js);
  for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,25)); if(w.document.getElementById('totalsCard').innerHTML.includes('Totals so far'))break;}
  const txt=w.document.getElementById('totalsCard').textContent.replace(/\s+/g,' ');
  ok(/3 of 5[23] in 2026/.test(txt),'the header states 3 of 52 Sundays, not just "this year"');
  ok(/27 Sept? to 11 Oct/.test(txt),'and the actual date range');
  ok(/covers only the Sundays above/.test(txt),'a warning appears while the year is barely covered');
  ok(/2026 so far/.test(txt),'and the column is headed "2026 so far", not "This year"');
  ok(!/undefined|NaN/.test(txt),'no undefined / NaN');

  console.log(`\n${n-fail}/${n} checks — ${fail?'FAILURES ABOVE':'all green'}`);
  server.close(); process.exit(fail);
});
