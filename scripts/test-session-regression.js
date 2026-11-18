// AOTC Track - regression for everything built in this session.
// Runs against a throwaway copy of data/ (AOTC_DATA_DIR), never the real one.
process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
const path = require('path'), fs = require('fs'), vm = require('vm');
const root = process.env.HOME + '/mnt/aotc-track';
const authPath = require.resolve(path.join(root, 'middleware/auth'));
const realAuth = require(authPath);
let CURRENT = null;
require.cache[authPath] = { id: authPath, filename: authPath, loaded: true, exports: { ...realAuth,
  requireAuth: (req,_r,n)=>{req.user=CURRENT;n();},
  requirePermission: p=>(req,res,n)=>{req.user=CURRENT; return (['admin','localadmin'].includes(CURRENT.role)||(CURRENT.permissions||[]).includes(p))?n():res.status(403).json({error:'no'});},
  requireAnyPermission: (...ps)=>(req,res,n)=>{req.user=CURRENT; return (['admin','localadmin'].includes(CURRENT.role)||ps.some(p=>(CURRENT.permissions||[]).includes(p)))?n():res.status(403).json({error:'no'});},
  canManageAllEntities: ()=>true } };
const db = require(path.join(root,'utils/db'));
const { reportedValue } = require(path.join(root,'utils/goalRollup'));
const express = require(path.join(root,'node_modules/express'));
const app = express(); app.use(express.json());
app.use('/api/entry', require(path.join(root,'routes/entry')));
app.use('/api/finance-weekly', require(path.join(root,'routes/financeWeekly')));

let fail=0, n=0; const ok=(c,m)=>{n++; console.log((c?'  PASS ':'  FAIL ')+m); if(!c)fail=1;};
const head=t=>console.log('\n── '+t+' '+'─'.repeat(Math.max(0,56-t.length)));
const src=fs.readFileSync(path.join(root,'public/js/page-entry.js'),'utf8');
const grab=nm=>{const a=src.indexOf('function '+nm+'('); let d=0; const j=src.indexOf('{',a);
  for(let k=j;k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d)return src.slice(a,k+1);}}};
const grabConst=nm=>{const i=src.indexOf('const '+nm+' = ['); return src.slice(i, src.indexOf('];',i)+2);};

const PASTED = `Funds received within the previous week amounted to GHS 26,329.00.
•\t1st Service Offertory\t2,247.00
•\t2nd Service Offertory\t2,443.00
•\tJunior Youth\t134.00
•\tChildren Service Offertory\t341.00
•\tTithes\t10,830.00
•\tCommunion Dues\t34.00
•\tVoluntary Thanks Offering\t1,000.00
•\tBuilding Pledge\t6,300.00
•\tBuilding Project Support\t3,000.00`;

const BEFORE={}; db.findAll('finance_quarterly').forEach(f=>{BEFORE[`${f.year}Q${f.quarter}`]=JSON.stringify(f.earmarked||{});});
db.update('users',1,{role:'admin',permissions:['entry.manage','congregation.view']});
db.update('users',3,{role:'secretary',permissions:['entry.manage'],entity:{type:'group',id:3}});

const server = app.listen(0, async () => {
  const P=server.address().port;
  const call=async(m,u,b)=>{const r=await fetch(`http://127.0.0.1:${P}${u}`,{method:m,headers:{'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json().catch(()=>({}))};};
  const get=u=>call('GET',u).then(r=>r.body);
  const CLERK={id:1,name:'Clerk',role:'admin',permissions:['entry.manage','congregation.view','finance.quarterly','finance.weekly']};
  const ACC={id:1,name:'Accounts',role:'accounts',permissions:['finance.weekly','finance.quarterly']};
  const TRE={id:2,name:'Treasurer',role:'treasurer',permissions:['finance.weekly.confirm']};
  const ADMIN={id:1,name:'Admin',role:'admin',permissions:[]};
  const cid=c=>db.findOne('committees',x=>x.code===c).id;
  CURRENT=CLERK;

  head('CLN-02: the combined group figure');
  const plan={YPG:[[12,14,2,1],[15,16,0,0],[11,13,3,2]],YAF:[[9,11,1,0],[10,12,0,2]],MF:[[20,0,3,0],[18,0,2,0],[22,0,1,0]],WF:[[0,25,0,4],[0,28,0,2]]};
  let dd=10;
  for(const [code,rows] of Object.entries(plan)){const g=db.findOne('groups',x=>x.code===code);
    rows.forEach(([a,b,c,d])=>db.insert('group_attendance',{entityType:'group',entityId:g.id,ownerCode:code,date:`2026-08-${String(dd++).padStart(2,'0')}`,year:2026,quarter:3,membersMale:a,membersFemale:b,onlineMale:c,onlineFemale:d}));}
  const clnData=await get(`/api/entry/data?quarter=3&entityType=committee&entityId=${cid('CLN')}`);
  const comb=clnData.stats.groupAttendance.combined;
  ok(comb && comb.quarter.average===105,'combined = each group’s own average added together (105)');
  ok(clnData.stats.groupAttendance.quarter.average!==105,'and is NOT the per-meeting average, which is a different number');
  const shared=db.findAll('goals',g=>g.year===2026&&g.code==='CLN-02');
  clnData.stats.groupAttendance.perGroup.forEach(pg=>{const goal=shared.find(x=>x.ownerCode===pg.code&&x.ownerType==='group'); if(!goal)return;
    const ex=db.findOne('kpi_entries',e=>e.goalId===goal.id&&Number(e.quarter)===3);
    const v=[pg.quarter.average,null]; if(ex)db.update('kpi_entries',ex.id,{values:v}); else db.insert('kpi_entries',{year:2026,quarter:3,goalId:goal.id,entityType:'group',entityId:db.findOne('groups',x=>x.code===pg.code).id,ownerCode:pg.code,values:v});});
  const parent=shared.find(x=>x.ownerType==='committee');
  ok(reportedValue(parent,0,{year:2026,quarter:3})===comb.quarter.average,'the field figure equals what the roll-up prints in the report');
  ok(!db.findOne('kpi_entries',e=>e.goalId===parent.id&&Number(e.quarter)===3),'nothing is stored against CLN, so the groups are not counted twice');
  ok(clnData.stats.groupAttendance.perGroup.map(g=>g.code).join(',')==='JY,YPG,YAF,MF,WF','the breakdown is in generational order');

  head('Scoping: who sees the attendance figures');
  for (const c of ['DSS','Fin','HRV']) { const d=await get(`/api/entry/data?quarter=3&entityType=committee&entityId=${cid(c)}`);
    ok(d.stats.groupAttendance.perGroup===undefined && d.stats.groupAttendance.combined===undefined, `${c} is not sent the group headcounts`); }
  CURRENT={id:3,name:'YPG Sec',role:'secretary',permissions:['entry.manage']};
  const ypg=await get('/api/entry/data?quarter=3');
  ok(ypg.entity.type==='group' && ypg.stats.groupAttendance.scope==='own','a group secretary is scoped to their own group');
  ok(ypg.stats.groupAttendance.perGroup===undefined,'and is not given other groups’ numbers');
  CURRENT=CLERK;

  head('The footnote only where something derives from attendance');
  const stats={serviceAttendance:{quarter:{count:9,total:4600,average:511},year:{count:9,total:4600,average:511}},groupAttendance:{scope:'all groups',quarter:{count:11,total:259,average:28},year:{count:11,total:259,average:28}}};
  const foot=(anyDerived,ga)=>{const ctx={quarter:3,console,esc:s=>String(s),_anyDerived:anyDerived,data:{stats:{...stats,groupAttendance:ga||stats.groupAttendance}}};
    vm.createContext(ctx); vm.runInContext(grab('groupBreakdown')+'\n'+grab('attendanceFootnote'),ctx); return vm.runInContext('attendanceFootnote()',ctx);};
  ok(foot(false)==='','a committee with no attendance KPI sees no Sunday table at all');
  const ch=foot(true,{...stats.groupAttendance,perGroup:[{code:'WF',name:"Women's Fellowship",quarter:{count:2,total:59,average:30},year:{count:2,total:59,average:30}}],combined:{quarter:{groups:1,meetings:2,total:59,average:30},year:{groups:1,meetings:2,total:59,average:30}}});
  ok(/Attendance counted for Q3/.test(ch)&&/Group meeting attendance by group/.test(ch),'CLN still sees the full working');
  ok(!/undefined|NaN|\[object/.test(ch),'no undefined / NaN in the markup');

  head('Weekly finance: entry, confirmation, the quarter');
  const A={offertory1:2247,offertory2:2443,offertoryJy:134,offertoryCs:341,tithes:10830,communionDues:34,thanksOffering:1000,buildingPledge:6300,buildingSupport:3000,kutunse:500,expMissionsEvangelism:400,expWelfare:1200,expTotal:9000,higherCourts:2500};
  CURRENT=ACC;
  let r=await call('PUT','/api/finance-weekly/week/2026-10-04',{amounts:A,status:'entered'});
  ok(r.status===200&&r.body.week.status==='entered','the Accounts Clerk submits a week as awaiting-Treasurer');
  ok(r.body.week.announcement===PASTED,'the announcement is byte-identical to the posted wording (26,329.00)');
  ok(!/Kutunse|Welfare|Transferred/.test(r.body.week.announcement),'and holds none of the lines that are not read out');
  ok(r.body.week.receiptsTotal===26829,'while the books still hold the full 26,829');
  ok((await get('/api/finance-weekly/summary?year=2026&quarter=4')).confirmed===0,'an unconfirmed week counts for nothing');
  ok((await call('POST','/api/finance-weekly/week/2026-10-04/confirm',{})).status===403,'the clerk cannot confirm their own week');
  CURRENT=TRE;
  ok((await call('POST','/api/finance-weekly/week/2026-10-04/confirm',{})).status===200,'the Treasurer confirms it');
  const sum=await get('/api/finance-weekly/summary?year=2026&quarter=4');
  ok(sum.byFeed.offertory===5165&&sum.byFeed.tithes===10830,'offertory lines add into one figure; tithes carries');
  ok(sum.byFeed.kutunse===500&&sum.higherCourtWeeks===1,'Kutunse and the higher-court transfer are counted separately');
  ok(sum.sundaysInQuarter===13,'coverage is expressed against the quarter’s 13 Sundays');
  CURRENT=ACC;
  ok(!db.findOne('finance_quarterly',f=>f.year===2026&&f.quarter===4),'entering weeks creates no quarterly row on its own');
  await call('POST','/api/finance-weekly/quarter/2026/4/source',{source:'weekly'});
  const q4=db.findOne('finance_quarterly',f=>f.year===2026&&f.quarter===4);
  ok(q4.earmarked.tithes===10830&&q4.earmarked.offertory===5165,'switching materialises the figures into the panel');
  ok(!('kutunse' in q4.earmarked),'goal-KPI feeds stay out of the earmarked boxes');
  ok((await call('PUT','/api/entry/finance',{year:2026,quarter:4,earmarked:{tithes:1}})).status===409,'typing over a weekly-sourced quarter is refused');
  CURRENT=TRE; await call('POST','/api/finance-weekly/week/2026-10-04/reopen',{reason:'wrong figure'});
  ok(db.findOne('finance_quarterly',f=>f.year===2026&&f.quarter===4).earmarked.tithes===0,'reopening pulls the figure straight back out');

  head('The announcement list is editable');
  CURRENT=ADMIN;
  let cur=(await get('/api/finance-weekly/lines?all=1')).lines;
  await call('PUT','/api/finance-weekly/lines',{lines:cur.map(l=>l.key==='buildingPledge'?{...l,announce:false}:l.key==='kutunse'?{...l,announce:true}:l)});
  const after=(await get('/api/finance-weekly/week/2026-10-04')).week.announcement;
  ok(!/Building Pledge/.test(after)&&/Kutunse Project/.test(after),'lines can be taken off and added to the notice');
  ok(/amounted to GHS 20,529\.00/.test(after),'and the headline total follows the list');
  ok((await get('/api/finance-weekly/week/2026-10-04')).week.amounts.buildingPledge===6300,'the de-listed figure is still recorded');
  await call('PUT','/api/finance-weekly/lines',{lines:cur.map(l=>l.key==='expWelfare'?{...l,announce:true}:l)});
  ok((await get('/api/finance-weekly/lines?all=1')).lines.find(l=>l.key==='expWelfare').announce===false,'a payment can never be forced into the notice');
  await call('PUT','/api/finance-weekly/lines',{lines:cur});
  ok((await get('/api/finance-weekly/week/2026-10-04')).week.announcement===PASTED,'restoring the list gives the posted wording again exactly');

  head('The quarterly Finance panel renders');
  const ctx={quarter:4,console,esc:s=>String(s),dis:()=>'',canEnter:()=>true,locked:()=>false,data:{}};
  vm.createContext(ctx); vm.runInContext([grabConst('FIN_RECEIPTS'),grabConst('FIN_SPEND'),grab('financePanel')].join('\n'),ctx);
  const panel=(fin,wk)=>{ctx.data={year:2026,special:{finance:fin},weekly:wk}; return vm.runInContext('financePanel()',ctx);};
  let h=panel({earmarked:{welfare:36630,totalAllExpenditure:416449.77},almanac:[]},null);
  ok(/These figures are typed/.test(h)&&/36,630/.test(h),'an untouched quarter keeps its typed figures');
  ok(/Receipts/.test(h)&&/Earmarked expenditure/.test(h)&&/Offertory/.test(h),'money in and money out are separated, with Offertory present');
  h=panel({earmarked:{tithes:20000},almanac:[]},{byFeed:{tithes:21660},confirmed:2,entered:3,sundaysInQuarter:13});
  ok(/2 of 13 Sundays confirmed/.test(h)&&/differs from the weekly returns by 1,660.00/.test(h),'coverage and any gap are stated');
  h=panel({source:'weekly',earmarked:{tithes:21660},almanac:[]},{byFeed:{tithes:21660},confirmed:13,entered:13,sundaysInQuarter:13});
  ok(/These figures come from the weekly returns/.test(h)&&(h.split('Almanac')[0].match(/disabled/g)||[]).length>=7,'a switched quarter says so and locks every box');

  head('Nothing pre-existing moved');
  const drift=[]; db.findAll('finance_quarterly').forEach(f=>{const k=`${f.year}Q${f.quarter}`; if(BEFORE[k]!==undefined&&BEFORE[k]!==JSON.stringify(f.earmarked||{}))drift.push(k);});
  ok(!drift.length,'every quarter that existed before is byte-identical'+(drift.length?' (drifted: '+drift.join(', ')+')':''));

  console.log(`\n${n - (fail?1:0)}/${n} checks — ${fail?'FAILURES ABOVE':'all green'}`);
  server.close(); process.exit(fail);
});
