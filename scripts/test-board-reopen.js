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
// stub the channels so notifications are counted, not sent
['utils/sms','utils/mailer','utils/push'].forEach(m=>{const p2=require.resolve(path.join(root,m));
  require.cache[p2]={id:p2,filename:p2,loaded:true,exports:{sendSms:async()=>({}),sendMail:async()=>({}),sendPushToUsers:async()=>({sent:0}),sendPushToUser:async()=>({sent:0})}};});
const express=require(path.join(root,'node_modules/express'));
const app=express(); app.use(express.json());
app.use('/api/entry', require(path.join(root,'routes/entry')));
let fail=0,n=0; const ok=(c,m)=>{n++;console.log((c?'  PASS ':'  FAIL ')+m); if(!c)fail++;};
const head=t=>console.log('\n── '+t);

db.update('users',1,{role:'admin',permissions:['congregation.view','approvals.manage']});
db.update('users',3,{role:'secretary',permissions:['entry.manage','congregation.view'],entity:{type:'group',id:3}});

const server=app.listen(0, async () => {
  const P=server.address().port, base=`http://127.0.0.1:${P}`;
  const call=async(m,u,b)=>{const r=await fetch(base+u,{method:m,headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json().catch(()=>({}))};};
  const get=u=>call('GET',u).then(r=>r.body);
  const CLERK={id:1,name:'Session Clerk',role:'admin',permissions:['congregation.view','approvals.manage']};
  const VIEWER={id:3,name:'Viewer',role:'viewer',permissions:['congregation.view']};
  CURRENT=CLERK;

  const sub=db.findAll('submissions').find(s=>s.status==='submitted');
  const Q=sub.quarter, Y=sub.year;

  head('A submitted row offers Reopen; others do not');
  let b=await get(`/api/entry/submission-board?quarter=${Q}`);
  const target=b.rows.find(r=>r.entityType===sub.entityType&&Number(r.entityId)===Number(sub.entityId));
  ok(target.status==='submitted' && target.canReopen===true,'the submitted row is reopenable');
  ok(b.rows.filter(r=>r.status==='outstanding').every(r=>!r.canReopen),'nothing to reopen on an outstanding row');

  head('Reopening from the board opens the SAME window as a change request');
  let r=await call('POST','/api/entry/reopen-quarter',{year:Y,quarter:Q,entityType:sub.entityType,entityId:sub.entityId,window:'hours',reason:'figures need correcting'});
  ok(r.status===200,'the clerk can reopen');
  const after=db.findById('submissions',sub.id);
  // actor() takes the name from the stored user record, not from the session.
  const realName=db.findById('users',1).name;
  ok(after.reopenedUntil && after.reopenedBy===realName && after.reopenedMode==='hours',
     `it writes reopenedUntil / By / Mode exactly as approval does (by ${after.reopenedBy})`);
  const hrs=(new Date(after.reopenedUntil)-Date.now())/3600000;
  ok(hrs>47 && hrs<49,`the 48-hour window is 48 hours (${hrs.toFixed(1)})`);
  b=await get(`/api/entry/submission-board?quarter=${Q}`);
  const now=b.rows.find(r2=>r2.entityType===sub.entityType&&Number(r2.entityId)===Number(sub.entityId));
  ok(now.status==='reopened' && !now.canReopen,'the board now shows Reopened and offers no second reopen');

  head('Guards');
  ok((await call('POST','/api/entry/reopen-quarter',{year:Y,quarter:Q,entityType:sub.entityType,entityId:sub.entityId,window:'hours'})).status===400,'a reason is required');
  const miss=await call('POST','/api/entry/reopen-quarter',{year:Y,quarter:4,entityType:'committee',entityId:99,window:'hours',reason:'x'});
  ok(miss.status===404,'reopening something that was never submitted is refused');
  CURRENT=VIEWER;
  ok((await call('POST','/api/entry/reopen-quarter',{year:Y,quarter:Q,entityType:sub.entityType,entityId:sub.entityId,window:'hours',reason:'x'})).status===403,
     'a viewer can SEE the board but cannot reopen');
  ok((await call('GET',`/api/entry/submission-board?quarter=${Q}`)).status===200,'and can still see it');
  CURRENT=CLERK;

  head('An admin-unlocked quarter is not reported as Submitted');
  const sub2=db.findAll('submissions').find(s=>s.id!==sub.id && s.status==='submitted');
  if (sub2) {
    db.update('submissions',sub2.id,{status:'unlocked',unlockedBy:'Admin'});
    b=await get(`/api/entry/submission-board?quarter=${sub2.quarter}`);
    const u=b.rows.find(r2=>r2.entityType===sub2.entityType&&Number(r2.entityId)===Number(sub2.entityId));
    ok(u.status==='reopened' && u.openEnded===true,'it reads as Reopened, flagged as having no expiry');
  } else ok(true,'(no second submitted row to unlock - skipped)');

  head('The traffic light');
  const css=fs.readFileSync(path.join(root,'public/css/style.css'),'utf8');
  ok(/\.badge-done \{ background: #E3F2EC; color: var\(--pcg-green\); \}/.test(css),'badge-done is the crest green');
  const js=fs.readFileSync(path.join(root,'public/js/page-reports.js'),'utf8');
  ok(/outstanding: \{ label: 'Not submitted', cls: 'badge-bright-no' \}/.test(js),'not submitted is bright red');
  ok(/reopened: \{ label: 'Reopened', cls: 'badge-bright-warn' \}/.test(js),'reopened is bright amber');
  ok(/submitted: \{ label: 'Submitted', cls: 'badge-bright-ok' \}/.test(js),'submitted is bright green');

  head('It renders, with the action where it belongs');
  const html=fs.readFileSync(path.join(root,'public/reports.html'),'utf8');
  const dom=new JSDOM(html,{url:'http://localhost/reports.html',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;
  w.api=async p=>{const rr=await fetch(base+'/api'+p); const d=await rr.json().catch(()=>null);
    if(!rr.ok){const e=new Error((d&&d.error)||'err');e.status=rr.status;throw e;} return d;};
  w.esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
  w.isElevated=u=>['admin','localadmin'].includes(u.role); w.toast=()=>{};
  w.me=CLERK; w.quarter=Q;
  w.eval(js.slice(js.indexOf('// A traffic light')));
  await w.loadBoard();
  const host=w.document.getElementById('boardCard');
  ok(/badge-bright-no/.test(host.innerHTML),'bright red renders for the outstanding rows');
  ok(/badge-bright-ok/.test(host.innerHTML) || /badge-bright-warn/.test(host.innerHTML),'bright green/amber render for the rest');
  ok(!/undefined|NaN/.test(host.textContent),'no undefined / NaN');

  console.log(`\n${n-fail}/${n} checks — ${fail?'FAILURES ABOVE':'all green'}`);
  server.close(); process.exit(fail);
});
