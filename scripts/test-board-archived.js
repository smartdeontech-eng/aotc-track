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
// Reproduce 4 Oct 2026: Church Choir (CC, id 7) archived, a second "Church Choir" (C-C) created.
const choir=db.findAll('groups').find(g=>g.code==='CC');
db.update('groups',choir.id,{active:false});
const dup=db.insert('groups',{code:'C-C',name:'Church Choir',type:'non-generational',active:true});
db.update('committees',1,{active:false});
const server=app.listen(0, async () => {
  const base=`http://127.0.0.1:${server.address().port}`;
  CURRENT={id:1,name:'Clerk',role:'admin',permissions:['congregation.view','approvals.manage']};
  const b=await (await fetch(base+'/api/entry/submission-board?quarter=3')).json();
  const choirs=b.rows.filter(r=>r.name==='Church Choir');
  ok(choirs.length===1,`Church Choir appears once (got ${choirs.length})`);
  ok(choirs[0]&&choirs[0].entityId===dup.id,'and it is the active one');
  ok(!b.rows.some(r=>r.entityType==='committee'&&r.entityId===1),'an archived committee is left off too');
  const liveC=db.findAll('committees',c=>c.active!==false).length, liveG=db.findAll('groups',g=>g.active!==false).length;
  ok(b.total===liveC+liveG,`total counts only active bodies (${b.total} = ${liveC}+${liveG})`);
  const svg=await (await fetch(base+'/api/entry/submission-board/poster.svg?quarter=3')).text();
  ok((svg.match(/Church Choir/g)||[]).length===1,'the WhatsApp poster shows it once as well');
  console.log(`\n${n-fail}/${n} checks — ${fail?'FAILURES ABOVE':'all green'}`);
  server.close(); process.exit(fail?1:0);
});
