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
  const TRE={id:2,name:'Treasurer',role:'treasurer',permissions:['finance.weekly.confirm']};
  const CLERK={id:1,name:'Clerk',role:'accounts',permissions:['finance.weekly','finance.quarterly']};

  // AHRM Q2 2026 on record: children 437, JY 250, youth 229, youngAdults 226, adults 509
  const roll = db.findAll('membership_quarterly').find(r=>r.year===2026&&r.quarter===2).categories;
  const adults18 = roll.youth + roll.youngAdults + roll.adults;      // 964
  const adults40 = roll.adults;                                      // 509
  console.log(`  roll: 18+ = ${adults18}, 40+ only = ${adults40}, whole roll = ${Object.values(roll).reduce((a,b)=>a+b,0)}`);

  head('Two confirmed weeks, offertory and tithes');
  CURRENT=CLERK;
  for (const [d,off,tit] of [['2026-10-04',5165,10830],['2026-10-11',4835,9170]])
    await call('PUT',`/finance-weekly/week/${d}`,{amounts:{offertory1:off,tithes:tit},status:'entered'});
  CURRENT=TRE;
  for (const d of ['2026-10-04','2026-10-11']) await call('POST',`/finance-weekly/week/${d}/confirm`,{});
  CURRENT=CLERK;

  let t=await get('/finance-weekly/totals?year=2026&quarter=4');
  let pm=t.perMember;
  console.log(`  members counted ${pm.members} (${pm.basisLabels.join(', ')}) from ${pm.membersFrom}`);
  ok(pm.members===adults18,'defaults to everyone 18+ — Youth, Young Adults and Adults');
  ok(!pm.basis.includes('children') && !pm.basis.includes('juniorYouth'),'children and junior youth are excluded');
  ok(pm.weeksCounted===2,'averaged over the 2 confirmed Sundays');
  const expOff=(5165+4835)/2/adults18;
  ok(Math.abs(pm.offertoryPerMemberWeek-expOff)<1e-9,`weekly offertory per member = ${pm.offertoryPerMemberWeek.toFixed(4)}`);
  const expTit=((10830+9170)/2/adults18)*(52/12);
  ok(Math.abs(pm.tithePerMemberMonth-expTit)<1e-9,`monthly tithe per member = ${pm.tithePerMemberMonth.toFixed(4)}`);
  ok(pm.offertoryIncreasePct===null && pm.titheIncreasePct===null,'no percentage until a baseline exists — it is not invented');

  head('Switching the basis to Adults 40+ only');
  await call('PUT','/finance-weekly/config',{memberBasis:['adults']});
  pm=(await get('/finance-weekly/totals?year=2026&quarter=4')).perMember;
  ok(pm.members===adults40,'divides by 509 instead');
  ok(Math.abs(pm.tithePerMemberMonth-(((10830+9170)/2/adults40)*(52/12)))<1e-9,'and every figure moves accordingly');
  await call('PUT','/finance-weekly/config',{memberBasis:['youth','youngAdults','adults']});

  head('A baseline makes SO-2.1 computable');
  await call('PUT','/finance-weekly/config',{baseline:{label:'January 2026',offertoryPerMemberWeek:2.5,tithePerMemberMonth:20}});
  pm=(await get('/finance-weekly/totals?year=2026&quarter=4')).perMember;
  ok(pm.offertoryIncreasePct!==null && pm.titheIncreasePct!==null,'both percentages now compute');
  ok(Math.abs(pm.offertoryIncreasePct-((expOff-2.5)/2.5*100))<1e-9,`offertory increase = ${pm.offertoryIncreasePct.toFixed(1)}%`);
  ok(Math.abs(pm.titheIncreasePct-((expTit-20)/20*100))<1e-9,`tithe increase = ${pm.titheIncreasePct.toFixed(1)}%`);
  ok((await call('PUT','/finance-weekly/config',{memberBasis:[]})).status===400,'an empty basis is refused — never divide by nothing');
  CURRENT={id:9,role:'viewer',permissions:['congregation.view']};
  ok((await call('PUT','/finance-weekly/config',{memberBasis:['adults']})).status===403,'a viewer cannot change the basis');
  CURRENT=CLERK;

  head('It renders');
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
  for(let i=0;i<80;i++){await new Promise(r=>setTimeout(r,25)); if(w.document.getElementById('totalsCard').innerHTML.includes('Giving per member'))break;}
  const txt=w.document.getElementById('totalsCard').textContent;
  ok(/Giving per member/.test(txt),'the card appears');
  ok(new RegExp(adults18.toLocaleString()).test(txt),'it states the denominator it used');
  ok(/Youth \(18-30\), Young Adults \(30-40\), Adults \(40\+\)/.test(txt),'and names the exact categories counted');
  ok(/Q2 2026/.test(txt),'and which AHRM return they came from');
  ok(/2 confirmed Sunday/.test(txt),'and how many Sundays it averaged');
  ok(/SO-2.1/.test(txt),'it links the figures to SO-2.1');
  ok(!/undefined|NaN/.test(txt),'no undefined / NaN');

  console.log(`\n${n-fail}/${n} checks — ${fail?'FAILURES ABOVE':'all green'}`);
  server.close(); process.exit(fail);
});
