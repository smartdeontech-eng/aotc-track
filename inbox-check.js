// Correspondence inbox: the Administrator scans in, the Clerk sorts and brings
// letters into the minutes. Run with: node inbox-check.js
process.env.JWT_SECRET='x'.repeat(48);
process.env.AOTC_DATA_DIR='/tmp/aotc-inbox';
process.env.ANTHROPIC_API_KEY='test';
const fs=require('fs');
fs.rmSync('/tmp/aotc-inbox',{recursive:true,force:true}); fs.mkdirSync('/tmp/aotc-inbox',{recursive:true});
const realFetch=global.fetch;
global.fetch=async(url,opts)=>{
  if(String(url).includes('api.anthropic.com')){
    const text=JSON.stringify({heading:'Funeral Announcement – Madam Ama Serwaa',summary:'A letter was received from the Serwaa family informing the Congregation of the funeral of the late Madam Ama Serwaa.',action:'Acknowledged',from:'The Serwaa family',letterDate:'2026-09-20',eventDate:'2026-10-03'});
    return new Response(JSON.stringify({content:[{type:'text',text}]}),{status:200,headers:{'content-type':'application/json'}}); }
  return realFetch(url,opts);
};
const express=require('express'), cookieParser=require('cookie-parser'), jwt=require('jsonwebtoken'), db=require('./utils/db');
const mk=(name,role,permissions)=>{const u=db.insert('users',{name,email:name+'@x.com',role,permissions,sessionVersion:0,entity:{type:'congregation',id:0,name:'AOTC'}}); return {u, T:jwt.sign({id:u.id,name:u.name,email:u.email,role:u.role,sv:0},process.env.JWT_SECRET,{expiresIn:'1h'})};};
const clerk=mk('Gideon','clerk',['approvals.manage','congregation.view']);
const admin=mk('Abena','attendance',['attendance.main','correspondence.intake']);
const app=express(); app.use(express.json()); app.use(cookieParser());
app.get('/api/auth/me',(req,res)=>{const p=jwt.verify(req.cookies.token,process.env.JWT_SECRET); const u=db.findById('users',p.id); res.json({ ...u, workspaces: [], entity:{type:'congregation',id:0,name:'AOTC'} });});
app.get('/api/setup/committees',(q,r)=>r.json([])); app.get('/api/setup/groups',(q,r)=>r.json([]));
app.get('/api/notifications',(q,r)=>r.json([])); app.get('/api/notifications/unread',(q,r)=>r.json({count:0}));
app.use('/api/minutes', require('./routes/minutes'));
app.use((req,res,next)=>{ if(req.path.startsWith('/api')) return res.status(404).json({error:'no route '+req.path}); next(); });
app.use(express.static('public'));
const server=app.listen(4460, run);
async function run(){
  const call=async(who,m,p,b)=>{const r=await realFetch('http://localhost:4460/api/minutes'+p,{method:m,headers:{cookie:`token=${who.T}`,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return {status:r.status, body:await r.json().catch(()=>null)};};
  let pass=0,fail=0; const ok=(n,c,x)=>{c?(pass++,console.log('  ✓',n)):(fail++,console.log('  ✗ FAIL:',n,JSON.stringify(x).slice(0,300)))};
  await call(clerk,'POST','/roster/seed');
  const sep=(await call(clerk,'POST','/',{date:'2026-10-08'})).body;
  // a letter recorded the old way, straight into the minutes
  const oldF=new FormData(); oldF.append('heading','Old-style letter');
  const old=await realFetch(`http://localhost:4460/api/minutes/${sep.id}/correspondence`,{method:'POST',headers:{cookie:`token=${clerk.T}`},body:oldF}).then(r=>r.json());

  const { chromium } = require('playwright');
  const browser=await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const errors=[];
  const pageFor=async who=>{const ctx=await browser.newContext(); await ctx.addCookies([{name:'token',value:who.T,domain:'localhost',path:'/'}]); const p=await ctx.newPage(); p.on('pageerror',e=>errors.push(e.message)); return p;};

  // ---- the Administrator scans two letters in
  const ap=await pageFor(admin);
  await ap.goto('http://localhost:4460/correspondence.html',{waitUntil:'networkidle'}); await ap.waitForTimeout(700);
  ok('the Administrator sees "Correspondence Inbox" in her menu', /Correspondence Inbox/.test(await ap.textContent('#sidebar')));
  ok('but not the Session minutes', !/Session Minutes/.test(await ap.textContent('#sidebar')));
  for (let i=0;i<2;i++){ await ap.setInputFiles('#scanIn','/tmp/letter.png'); await ap.waitForTimeout(1500); }
  let inbox=(await call(admin,'GET','/correspondence/inbox')).body;
  const mine=inbox.letters.filter(c=>c.status==='new');
  ok('two letters scanned in, waiting to be sorted', mine.length===2, inbox.counts);
  ok('each drafted from its pages at once', mine.every(c=>/Funeral Announcement/.test(c.heading) && c.eventDate==='2026-10-03' && c.pages===1), mine);
  ok('with the date received', mine.every(c=>/^\d{4}-\d{2}-\d{2}$/.test(c.receivedOn)));
  ok('flagged as due before the next meeting (8th October)', /before the next meeting/.test(await ap.textContent('#list')));
  ok('the old-style letter is not in the inbox', !inbox.letters.some(c=>c.id===old.id));
  ok('she cannot see Sort buttons', !(await ap.$('.sortbar')));
  ok('she cannot sort', (await call(admin,'POST',`/correspondence/${mine[0].id}/sort`,{to:'session'})).status===403);
  ok('nor open the minutes', (await call(admin,'GET','/'+sep.id)).status===403);
  ok('she can view a page of a letter in the inbox', (await realFetch(`http://localhost:4460/api/minutes/correspondence/${mine[0].id}/file/0`,{headers:{cookie:`token=${admin.T}`}})).status===200);

  // ---- the Clerk sorts them
  const cp=await pageFor(clerk);
  await cp.goto('http://localhost:4460/correspondence.html',{waitUntil:'networkidle'}); await cp.waitForTimeout(700);
  await (await cp.$$('.sortbar button'))[0].click(); await cp.waitForTimeout(700);   // first → For the Session
  await cp.click('.sortbar button:has-text("Handle without the Session")'); await cp.waitForTimeout(400);
  await cp.fill('.modal input, .app-dialog input', 'Forwarded to the Welfare Committee'); await cp.click('.app-dialog .btn-primary, .modal .btn-primary'); await cp.waitForTimeout(700);
  inbox=(await call(clerk,'GET','/correspondence/inbox')).body;
  ok('one for the Session, one handled', inbox.counts.session===1 && inbox.counts.handled===1, inbox.counts);
  const forS=inbox.letters.find(c=>c.status==='session'), hand=inbox.letters.find(c=>c.status==='handled');
  ok('the handled note is kept', hand && hand.handledNote==='Forwarded to the Welfare Committee', hand);

  // ---- the Clerk brings it into the minutes
  await cp.goto(`http://localhost:4460/minutes.html?meeting=${sep.id}`,{waitUntil:'networkidle'}); await cp.waitForTimeout(1000);
  await cp.click('.mtab[data-pane="corr"]'); await cp.waitForTimeout(300);
  const box=await cp.textContent('#corrWaiting');
  ok('the minutes offer the letter waiting for the Session', /1 letter waiting for the Session/.test(box) && /Funeral Announcement/.test(box), box);
  ok('and not the handled one', (await cp.$$('#corrWaiting .bringPick')).length===1);
  await cp.click('#corrWaiting button:has-text("Bring into these minutes")'); await cp.waitForTimeout(900);
  const corrNow=(await call(clerk,'GET','/'+sep.id)).body.correspondence;
  ok('it is now in the minutes, after the old-style letter', corrNow.length===2 && corrNow[0].id===old.id && corrNow[1].id===forS.id, corrNow.map(c=>c.heading));
  ok('and the waiting box has cleared', !(await cp.textContent('#corrWaiting')).includes('waiting for the Session'));
  inbox=(await call(clerk,'GET','/correspondence/inbox')).body;
  ok('the inbox shows it as tabled at that meeting', inbox.letters.some(c=>c.id===forS.id && c.status==='tabled' && c.meetingDate==='2026-10-08'));
  ok('the Administrator can no longer edit it', (await call(admin,'PUT',`/correspondence/${forS.id}`,{heading:'x'})).status===403);
  // ---- send it back
  await cp.click('button:has-text("Send back to the inbox")'); await cp.waitForTimeout(300);
  await cp.click('.app-dialog .btn-primary'); await cp.waitForTimeout(900);
  inbox=(await call(clerk,'GET','/correspondence/inbox')).body;
  const back=inbox.letters.find(c=>c.id===forS.id);
  ok('sent back, it waits for the Session again', back && back.status==='session' && back.returnedFrom && back.returnedFrom.date==='2026-10-08', back);
  ok('the old-style letter was never touched', !(await call(clerk,'GET','/'+sep.id)).body.correspondence.find(c=>c.id===old.id).status);
  ok('the pages threw nothing', errors.length===0, errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); server.close(); process.exit(fail?1:0);
}
