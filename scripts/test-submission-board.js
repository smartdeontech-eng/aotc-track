process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
const path=require('path'), fs=require('fs'); const root=process.env.HOME+'/mnt/aotc-track';
const { JSDOM } = require(path.join(root,'node_modules/jsdom'));
const authPath=require.resolve(path.join(root,'middleware/auth')); const realAuth=require(authPath);
let CURRENT=null;
require.cache[authPath]={id:authPath,filename:authPath,loaded:true,exports:{...realAuth,
  requireAuth:(q,_r,n)=>{q.user=CURRENT;n();},
  requirePermission:p=>(q,r,n)=>{q.user=CURRENT;return(['admin','localadmin'].includes(CURRENT.role)||(CURRENT.permissions||[]).includes(p))?n():r.status(403).json({error:'no'});},
  requireAnyPermission:(...ps)=>(q,r,n)=>{q.user=CURRENT;return(['admin','localadmin'].includes(CURRENT.role)||ps.some(p=>(CURRENT.permissions||[]).includes(p)))?n():r.status(403).json({error:'no'});},
  canManageAllEntities:()=>true}};
const db=require(path.join(root,'utils/db'));
const express=require(path.join(root,'node_modules/express'));
const app=express(); app.use(express.json());
app.use('/api/entry', require(path.join(root,'routes/entry')));
let fail=0,n=0; const ok=(c,m)=>{n++;console.log((c?'  PASS ':'  FAIL ')+m); if(!c)fail++;};
const head=t=>console.log('\n── '+t);

// users the scope helpers will read back
db.update('users',1,{role:'admin',permissions:['congregation.view','approvals.manage']});
db.update('users',3,{role:'secretary',permissions:['entry.manage'],entity:{type:'group',id:3}});

const server=app.listen(0, async () => {
  const P=server.address().port, base=`http://127.0.0.1:${P}`;
  const get=async u=>{const r=await fetch(base+u); return {status:r.status, body: await r.json().catch(()=>({}))};};
  const CLERK={id:1,name:'Clerk',role:'admin',permissions:['congregation.view','approvals.manage']};
  const SEC={id:3,name:'YPG Sec',role:'secretary',permissions:['entry.manage']};

  head('The board covers every entity, not just the ones that submitted');
  CURRENT=CLERK;
  let b=(await get('/api/entry/submission-board?quarter=2')).body;
  const nC=db.findAll('committees').length, nG=db.findAll('groups').length;
  console.log(`  ${b.submitted} submitted, ${b.outstanding} outstanding, ${b.reopened} reopened, of ${b.total}`);
  ok(b.total===nC+nG,`all ${nC+nG} committees and groups appear`);
  ok(b.submitted+b.outstanding+b.reopened===b.total,'every row lands in exactly one state');
  ok(b.rows.filter(r=>r.status==='submitted').every(r=>r.submittedBy),'submitted rows carry who and when');
  ok(b.rows.filter(r=>r.status==='outstanding').every(r=>!r.submittedBy),'outstanding rows carry nothing');

  head('A quarter nobody has touched');
  b=(await get('/api/entry/submission-board?quarter=4')).body;
  ok(b.outstanding===b.total && b.submitted===0,'reports everyone outstanding rather than erroring');

  head('Reopening shows as its own state, not as submitted');
  const sub=db.findAll('submissions').find(s=>s.quarter===2);
  db.update('submissions',sub.id,{reopenedUntil:new Date(Date.now()+86400000).toISOString(),reopenedBy:'Clerk',reopenedMode:'deadline'});
  b=(await get('/api/entry/submission-board?quarter=2')).body;
  const re=b.rows.find(r=>Number(r.entityId)===Number(sub.entityId)&&r.entityType===sub.entityType);
  ok(re.status==='reopened' && re.reopenedUntil,'a live reopen window reads as Reopened');
  db.update('submissions',sub.id,{reopenedUntil:new Date(Date.now()-86400000).toISOString()});
  b=(await get('/api/entry/submission-board?quarter=2')).body;
  ok(b.rows.find(r=>Number(r.entityId)===Number(sub.entityId)&&r.entityType===sub.entityType).status==='submitted',
     'an EXPIRED window is back to Submitted, not stuck open');

  head('Ordering and scope');
  const gs=b.rows.filter(r=>r.entityType==='group').map(r=>r.code).filter(Boolean);
  ok(gs.slice(0,6).join(',')==='CS,JY,YPG,YAF,MF,WF','groups keep the generational order');
  ok(b.rows.findIndex(r=>r.entityType==='group')>b.rows.findIndex(r=>r.entityType==='committee'),'committees before groups');
  ok(typeof b.daysLeft==='number' && b.dueAt,'the deadline and days left are reported');
  CURRENT=SEC;
  ok((await get('/api/entry/submission-board?quarter=2')).status===403,'a group secretary is refused the whole-congregation view');
  CURRENT=CLERK;

  head('It renders on the Reports page');
  const html=fs.readFileSync(path.join(root,'public/reports.html'),'utf8');
  const js=fs.readFileSync(path.join(root,'public/js/page-reports.js'),'utf8');
  const dom=new JSDOM(html,{url:'http://localhost/reports.html',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;
  w.api=async p=>{const r=await fetch(base+'/api'+p); const d=await r.json().catch(()=>null);
    if(!r.ok){const e=new Error((d&&d.error)||'err');e.status=r.status;throw e;} return d;};
  w.esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  w.isElevated=u=>['admin','localadmin'].includes(u.role);
  w.me=CLERK; w.quarter=2;
  // run just the board function against the real markup
  const i=js.indexOf('const BOARD_STATUS');
  w.eval(js.slice(i));
  await w.loadBoard();
  const txt=w.document.getElementById('boardCard').textContent.replace(/\s+/g,' ');
  ok(/Q2 2026 submissions/.test(txt),'the card renders with the quarter in its heading');
  ok(/of 25 in/.test(txt),'and the count out of 25');
  ok(/Not submitted/.test(txt),'outstanding rows are labelled');
  ok(/no separate final-draft step/.test(txt),'and the lifecycle is spelled out');
  ok(!/undefined|NaN/.test(txt),'no undefined / NaN');
  // Submitted first, then reopened, then the gap - the order the user asked
  // for: the board reads as progress, not as a complaint.
  const cells=[...w.document.querySelectorAll('#boardCard tbody tr')].map(tr=>tr.textContent);
  const idx=l=>cells.findIndex(c=>c.includes(l));
  const iSub=idx('Submitted'), iOut=idx('Not submitted');
  ok(iSub !== -1 && iOut !== -1 && iSub < iOut,'submitted rows come before the not-submitted ones');

  console.log(`\n${n-fail}/${n} checks — ${fail?'FAILURES ABOVE':'all green'}`);
  server.close(); process.exit(fail);
});
