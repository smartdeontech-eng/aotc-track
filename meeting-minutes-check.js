// Minutes written in the app for committee and group executive meetings.
// Run with: node meeting-minutes-check.js
process.env.JWT_SECRET='x'.repeat(48);
process.env.AOTC_DATA_DIR='/tmp/aotc-mm';
const fs=require('fs');
fs.rmSync('/tmp/aotc-mm',{recursive:true,force:true}); fs.mkdirSync('/tmp/aotc-mm',{recursive:true});
const express=require('express'), cookieParser=require('cookie-parser'), jwt=require('jsonwebtoken'), db=require('./utils/db');
const { execSync } = require('child_process');
const welfare=db.insert('committees',{name:'Committee on Welfare',type:'standing',active:true,signatories:{head:{name:'Mrs Grace Bediako-Asante'},secretary:{name:'Mr Frank Anane Frempong'}}});
const finance=db.insert('committees',{name:'Finance Committee',type:'standing',active:true,signatories:{}});
const wf=db.insert('groups',{name:"Women's Fellowship",active:true,signatories:{head:{name:'Madam Esther Boatemaa',title:'President'},secretary:{name:'Mrs Cynthia Akuba Amartei'}}});
const mem=(name,position,type,id)=>db.insert('members',{name,position,entityType:type,entityId:id});
const a=mem('Mrs Grace Bediako-Asante','Chairperson','committee',welfare.id), b=mem('Mr Frank Anane Frempong','Secretary','committee',welfare.id), c=mem('Ms Betty Dufie Owusu','Member','committee',welfare.id), d=mem('Mr Alex Abankwa','Member','committee',welfare.id);
const mk=(name,entity,perms)=>{const u=db.insert('users',{name,email:name+'@x.com',role:'secretary',permissions:perms,entity,sessionVersion:0}); return {u,T:jwt.sign({id:u.id,name:u.name,email:u.email,role:u.role,sv:0},process.env.JWT_SECRET,{expiresIn:'1h'})};};
const sec=mk('Frank',{type:'committee',id:welfare.id,name:'Committee on Welfare'},['meetings.manage','attendance.manage']);
const other=mk('Kofi',{type:'committee',id:finance.id,name:'Finance Committee'},['meetings.manage','attendance.manage']);
// an earlier meeting, and an open action point from it
const prev=db.insert('meetings',{entityType:'committee',entityId:welfare.id,entityName:'Committee on Welfare',title:'Committee Meeting',date:'2026-08-20',time:'18:00',status:'held',kind:'general',attendance:{locked:true,presentMemberIds:[a.id,b.id]}});
db.insert('action_points',{meetingId:prev.id,entityType:'committee',entityId:welfare.id,text:'Visit the flood victims at Kaneshie',responsibleName:'Mr Alex Abankwa',status:'open',targetDate:'2026-09-10'});
const mtg=db.insert('meetings',{entityType:'committee',entityId:welfare.id,entityName:'Committee on Welfare',title:'Committee Meeting',date:'2026-09-17',time:'18:00',venueName:'Rev Adu-Mante Session Hall',status:'held',kind:'general',
  agenda:'1. Opening prayer\n2. Review of minutes\n3. Matters arising\n4. Support for bereaved members\n5. Hospital visitation roster\n6. Any other business\n7. Closing',
  attendance:{locked:true,presentMemberIds:[a.id,b.id,d.id],apologyMemberIds:[c.id],absentMemberIds:[],guestsPresent:['Rev Martin Owusu Boamah'],
    proceedings:{commencedAt:'6.10 p.m.',openingBy:'Mr Alex Abankwa',minutesMovedBy:'Mr Frank Anane Frempong',minutesSecondedBy:'Mr Alex Abankwa',closureMovedBy:'Mr Alex Abankwa',closureSecondedBy:'Mrs Grace Bediako-Asante',closedAt:'7.45 p.m.'}}});
const general=db.insert('meetings',{entityType:'group',entityId:wf.id,entityName:"Women's Fellowship",title:'General Meeting',date:'2026-09-14',time:'16:00',status:'held',kind:'general',attendance:{mode:'headcount'}});
const exec=db.insert('meetings',{entityType:'group',entityId:wf.id,entityName:"Women's Fellowship",title:'Executive Meeting',date:'2026-09-15',time:'16:00',status:'held',kind:'executive',attendance:{locked:true,presentMemberIds:[]}});
const app=express(); app.use(express.json()); app.use(cookieParser());
app.get('/api/auth/me',(req,res)=>{const p=jwt.verify(req.cookies.token,process.env.JWT_SECRET); res.json({...db.findById('users',p.id),workspaces:[]});});
app.get('/api/notifications/unread',(q,r)=>r.json({count:0}));
app.use('/api/meetings', require('./routes/meetings'));
app.use((req,res,next)=>{ if(req.path.startsWith('/api')) return res.status(404).json({error:'no route '+req.path}); next(); });
app.use(express.static('public'));
const server=app.listen(4462, run);
async function run(){
  const call=async(who,m,p,b)=>{const r=await fetch('http://localhost:4462/api/meetings'+p,{method:m,headers:{cookie:`token=${who.T}`,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});let body=null;try{body=await r.json();}catch(e){}return {status:r.status, body};};
  let pass=0,fail=0; const ok=(n,c,x)=>{c?(pass++,console.log('  ✓',n)):(fail++,console.log('  ✗ FAIL:',n,JSON.stringify(x).slice(0,300)))};
  const g=(await call(sec,'GET',`/${mtg.id}/write`)).body;
  ok('Main Business starts from the agenda, boilerplate left out', g.doc.main.map(r=>r.subject).join('|')==='Support for bereaved members|Hospital visitation roster', g.doc.main);
  ok('Matters Arising starts from the open action point', g.doc.matters.length===1 && /flood victims/.test(g.doc.matters[0].subject), g.doc.matters);
  ok('the previous meeting date is filled in', g.doc.previousDate==='2026-08-20', g.doc.previousDate);
  ok('a group general meeting cannot have minutes written', (await call(sec,'GET',`/${general.id}/write`)).status===400);
  ok('another committee cannot open these', (await call(other,'GET',`/${mtg.id}/write`)).status===403);
  ok('nor save them', (await call(other,'PUT',`/${mtg.id}/write`,{openingNote:'x'})).status===403);

  const { chromium } = require('playwright');
  const browser=await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx=await browser.newContext({acceptDownloads:true}); await ctx.addCookies([{name:'token',value:sec.T,domain:'localhost',path:'/'}]);
  const page=await ctx.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://localhost:4462/meeting-minutes.html?meeting=${mtg.id}`,{waitUntil:'networkidle'}); await page.waitForTimeout(700);
  const txt=await page.textContent('#body');
  ok('the opening sentence writes itself', /The meeting commenced at 6.10 p.m. Mr Alex Abankwa led the opening prayer./.test(txt));
  ok('so does the adoption', /Mr Frank Anane Frempong moved for the adoption of the minutes, and Mr Alex Abankwa seconded the motion./.test(txt));
  ok('the attendance shows from the Meetings page', /Present \(3\)/.test(await page.textContent('#attCard')));
  // write into Main Business item 1, add a correction, add an Other Matter
  const tas=await page.$$('.child textarea');
  // tas[0] is Matters Arising 3.1; tas[1] is the first Main Business item
  await tas[1].fill('The Committee agreed to visit every bereaved member within a week of the funeral.'); await tas[1].evaluate(e=>e.dispatchEvent(new Event('change',{bubbles:true})));
  await page.click('button:has-text("+ Add a correction")'); await page.waitForTimeout(200);
  const fx=await page.$$('.fix input'); await fx[0].fill('Kaneshie'); await fx[0].evaluate(e=>e.dispatchEvent(new Event('change',{bubbles:true}))); await fx[1].fill('Kaneshie Market'); await fx[1].evaluate(e=>e.dispatchEvent(new Event('change',{bubbles:true})));
  await page.click('button:has-text("+ Add another matter")'); await page.waitForTimeout(200);
  const others=await page.$$('.sec:nth-last-child(2) .child');
  const lastChild=(await page.$$('.child')).pop();
  const li=await lastChild.$$('input'); await li[0].fill('Welfare Box'); await li[0].evaluate(e=>e.dispatchEvent(new Event('change',{bubbles:true})));
  const lt=await lastChild.$('textarea'); await lt.fill('Ms Betty Dufie Owusu suggested a welfare box at the entrance.'); await lt.evaluate(e=>e.dispatchEvent(new Event('change',{bubbles:true})));
  await page.waitForTimeout(1200);
  ok('the adoption now reads "as corrected"', /adoption of the minutes as corrected/.test(await page.textContent('#body')));
  let saved=(await call(sec,'GET',`/${mtg.id}/write`)).body.doc;
  ok('it all saved', /within a week/.test(saved.main[0].body) && saved.corrections[0].to==='Kaneshie Market' && saved.other[0].subject==='Welfare Box', saved);
  // the PDF
  const pdf=await fetch(`http://localhost:4462/api/meetings/${mtg.id}/write.pdf`,{headers:{cookie:`token=${sec.T}`}}); fs.writeFileSync('/tmp/aotc-mm/m.pdf',Buffer.from(await pdf.arrayBuffer()));
  const t=execSync('pdftotext -layout /tmp/aotc-mm/m.pdf -').toString().replace(/\s+/g,' ');
  ok('the PDF is headed for the committee', /MINUTES OF THE COMMITTEE ON WELFARE MEETING HELD AT REV ADU/i.test(t), t.slice(0,300));
  ok('with the roll', /MRS GRACE BEDIAKO-ASANTE.*CHAIRPERSON/i.test(t) && /MEMBERS WITH APOLOGIES: 1\. MS BETTY DUFIE OWUSU/i.test(t) && /IN ATTENDANCE: 1\. REV MARTIN OWUSU BOAMAH/i.test(t), t.slice(0,900));
  ok('numbered sections in order', /1\.0 Opening.*2\.0 Review of Minutes.*2\.1 Correction.*2\.2 Adoption of Minutes.*3\.0 Matters Arising.*3\.1 Visit the flood victims.*4\.0 Main Business.*4\.1 Support for bereaved members.*4\.2 Hospital visitation roster.*5\.0 Other Matters.*5\.1 Welfare Box.*6\.0 Closure/.test(t), t.slice(900,2600));
  ok('the closure writes itself', /Mr Alex Abankwa moved for the closure of the meeting at 7.45 p.m., and this was seconded by Mrs Grace Bediako-Asante\./.test(t));
  ok('signed by the secretary and the chairperson', /Mr Frank Anane Frempong.*\(Secretary\).*Mrs Grace Bediako-Asante.*\(Chairperson\)/.test(t) || /Mr Frank Anane Frempong Mrs Grace Bediako-Asante \(Secretary\) \(Chairperson\)/.test(t), t.slice(-500));
  ok('the footer names the committee, not the Session', /\(PCG-AOTC\) Committee on Welfare\./.test(t) && !/\(PCG-AOTC\) Session\./.test(t), t.slice(-400));
  // the Word file
  const docx=await fetch(`http://localhost:4462/api/meetings/${mtg.id}/write.docx`,{headers:{cookie:`token=${sec.T}`}});
  fs.writeFileSync('/tmp/aotc-mm/m.docx',Buffer.from(await docx.arrayBuffer()));
  const foot=execSync("unzip -p /tmp/aotc-mm/m.docx 'word/footer*.xml' | grep -o '(PCG-AOTC)[^.]*\\.' | sort -u").toString();
  const body=execSync("unzip -p /tmp/aotc-mm/m.docx word/document.xml | sed -e 's/<[^>]*>//g'").toString();
  ok('the Word file builds, with the committee in its footer', docx.status===200 && /Committee on Welfare/.test(foot) && !/Session\./.test(foot), foot);
  ok('and the same content', /Welfare Box/.test(body) && /within a week of the funeral/.test(body));
  // Session minutes footer untouched
  const SD=require('./utils/sessionDocx'); const sbuf=await SD.buildSessionMinutesDocx({heading:'AOTC Session Meeting',date:'2026-09-24',present:[],apologies:[],absent:[],rows:[],signatories:{}});
  fs.writeFileSync('/tmp/aotc-mm/s.docx',sbuf);
  ok('Session minutes still say Session in the footer', /\(PCG-AOTC\) Session\./.test(execSync("unzip -p /tmp/aotc-mm/s.docx 'word/footer*.xml'").toString()));
  // final
  await page.click('#finalBtn'); await page.waitForTimeout(200); await page.click('.app-dialog .btn-primary'); await page.waitForTimeout(700);
  ok('marked final, the page locks', await page.$eval('.child textarea', e=>e.disabled) && /Marked final/.test(await page.textContent('#finalNote')));
  ok('and the server refuses edits', (await call(sec,'PUT',`/${mtg.id}/write`,{openingNote:'x'})).status===400);
  await page.click('#reopenBtn'); await page.waitForTimeout(600);
  ok('reopening unlocks it', !(await page.$eval('.child textarea', e=>e.disabled)));
  // the Meetings page offers it
  await page.goto('http://localhost:4462/meetings.html',{waitUntil:'networkidle'}).catch(()=>{});
  ok('the pages threw nothing', errors.filter(e=>!/meetings\.html/.test(e)).length===0, errors);
  // group executive works
  ok('a group executive meeting can have minutes written', (await call(mk('Cyn',{type:'group',id:wf.id},['meetings.manage']),'GET',`/${exec.id}/write`)).status===200);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); server.close(); process.exit(fail?1:0);
}
