// Tidy status + export check, in a real browser.
// Hymn picker check. Run with: node tidy-letters-check.js   (needs playwright; set CHROME_PATH if Chromium lives elsewhere)
process.env.JWT_SECRET='x'.repeat(48);
process.env.AOTC_DATA_DIR='/tmp/aotc-tidy';
process.env.ANTHROPIC_API_KEY='test';
const fs=require('fs');
fs.rmSync('/tmp/aotc-tidy',{recursive:true,force:true}); fs.mkdirSync('/tmp/aotc-tidy',{recursive:true});
// Stand in for the Anthropic API: past-tense "tidied" text, and record the model asked for.
const realFetch=global.fetch; let modelsAsked=[]; let systemHasHouse=false;
global.fetch=async(url,opts)=>{
  if(String(url).includes('api.anthropic.com')){ const b=JSON.parse(opts.body); modelsAsked.push(b.model); systemHasHouse = systemHasHouse || /HOUSE STYLE/.test(b.system);
    const notes=b.messages[0].content[0].text.split('Notes:\n')[1]||'';
    return new Response(JSON.stringify({content:[{type:'text',text:'TIDIED: '+notes.replace(/ is /g,' was ')}]}),{status:200,headers:{'content-type':'application/json'}}); }
  return realFetch(url,opts);
};
const express=require('express'), cookieParser=require('cookie-parser'), jwt=require('jsonwebtoken'), db=require('./utils/db');
const clerk=db.insert('users',{name:'Gideon',email:'g@x.com',role:'clerk',permissions:['approvals.manage','congregation.view','minutes.manage'],sessionVersion:0});
const T=jwt.sign({id:clerk.id,name:clerk.name,email:clerk.email,role:clerk.role,sv:0},process.env.JWT_SECRET,{expiresIn:'1h'});
const app=express(); app.use(express.json()); app.use(cookieParser());
app.get('/api/auth/me',(req,res)=>res.json({ ...clerk, workspaces: [], entity:{type:'congregation',id:0,name:'AOTC'} }));
app.get('/api/setup/committees',(q,r)=>r.json([])); app.get('/api/setup/groups',(q,r)=>r.json([]));
app.get('/api/notifications',(q,r)=>r.json([])); app.get('/api/notifications/unread',(q,r)=>r.json({count:0}));
app.use('/api/minutes', require('./routes/minutes'));
app.use((req,res,next)=>{ if(req.path.startsWith('/api')) return res.status(404).json({error:'no route '+req.path}); next(); });
app.use(express.static('public'));
const server=app.listen(4458, run);
const LONG='Ing Kwaku Koranteng send that it to be inappropriate to just reach out to this time and best possibly for help when no relationship has been established and we should rather build one.';
async function run(){
  const call=async(m,p,b)=>{const r=await realFetch('http://localhost:4458/api/minutes'+p,{method:m,headers:{cookie:`token=${T}`,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return {status:r.status, body:await r.json()};};
  await call('POST','/roster/seed');
  const doc=(await call('POST','/',{date:'2026-09-24'})).body;
  const g=(await call('GET','/'+doc.id)).body.doc;
  const otherKey='other';
  // two Other Matters: one long raw, one short
  await call('PUT',`/${doc.id}/section`,{key:otherKey,enabled:true,children:[{subject:'Other Matters I',body:LONG},{subject:'Other Matters II',body:'The Session noted this.'}]});
  let pass=0,fail=0; const ok=(n,c,x)=>{c?(pass++,console.log('  ✓',n)):(fail++,console.log('  ✗ FAIL:',n,JSON.stringify(x)))};
  const { chromium } = require('playwright');
  const browser=await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx=await browser.newContext(); await ctx.addCookies([{name:'token',value:T,domain:'localhost',path:'/'}]);
  const page=await ctx.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  const RAW='Catechist Eugene Akuamoah Addo informed the Session that the daughter of Mr Asante, a member of the Congregation, does not fellowship with the Congregation at all.';
  const letter=await realFetch(`http://localhost:4458/api/minutes/${doc.id}/correspondence`,{method:'POST',headers:{cookie:`token=${T}`},body:(()=>{const f=new FormData(); f.append('heading','Wedding Invitation'); return f;})()}).then(r=>r.json());
  await call('PUT',`/correspondence/${letter.id}`,{summary:'An invitation was received.',deliberation:RAW,action:'Acknowledged'});
  await call('PUT',`/${doc.id}/proceedings`,{proceedings:{prayers:{ledBy:'Dr Nicholas A. Tweneboa',points:['Rev Joseph Richmond Tettey and his family','Rev Acheampong and his family','Preservation and protection of congregants and their families from sickness and premature death, using Mrs Cecilia Pokua Anto'],note:''}}});
  await page.goto(`http://localhost:4458/minutes.html?meeting=${doc.id}`,{waitUntil:'networkidle'}); await page.waitForTimeout(1000);
  await page.click('.mtab[data-pane="docs"]'); await page.waitForTimeout(300);
  let banner=await page.textContent('#tidyCheck');
  ok('the letter note is listed as not tidied', /Wedding Invitation — what the Session said/.test(banner), banner);
  ok('and so are the prayer points', /Prayers/.test(banner), banner);
  await page.click('.mtab[data-pane="corr"]'); await page.waitForTimeout(300);
  ok('the letter card shows "Not tidied yet"', /Not tidied yet/.test(await page.textContent(`#corrTidy-${letter.id}`)));
  const act=await page.$('#corrList input[list="corrActionList"]');
  ok('the Action is a free field with suggestions', !!act && (await page.$$eval('#corrActionList option',o=>o.map(x=>x.value))).includes('Referred to the Committee on Welfare'));
  await act.fill('Referred to the Committee on Welfare'); await act.evaluate(e=>e.dispatchEvent(new Event('change',{bubbles:true}))); await page.waitForTimeout(900);
  let L=(await call('GET','/'+doc.id)).body.correspondence.find(c=>c.id===letter.id);
  ok('a typed Action is saved as typed', L.action==='Referred to the Committee on Welfare', L.action);
  await page.click('.mtab[data-pane="body"]'); await page.waitForTimeout(300);
  ok('the prayers show "Not tidied yet"', /Not tidied yet/.test(await page.textContent('#prayerTidy')), await page.textContent('#prayerTidy'));
  await page.click('.mtab[data-pane="docs"]'); await page.waitForTimeout(200);
  await page.click('#tidyAllBtn'); await page.waitForTimeout(2500);
  banner=await page.textContent('#tidyCheck');
  ok('Tidy them all covers the letter note and the prayers', /Every item with text/.test(banner), banner);
  L=(await call('GET','/'+doc.id)).body.correspondence.find(c=>c.id===letter.id);
  ok('the tidied letter note is saved with its mark', /^TIDIED:/.test(L.deliberation) && L.delibTidiedWords>0, L);
  const pr=(await call('GET','/'+doc.id)).body.doc.proceedings.prayers;
  ok('the prayers are saved with their mark', pr.tidiedWords>0, pr);
  // tick by hand on a fresh raw note
  await call('PUT',`/correspondence/${letter.id}`,{deliberation:RAW+' '+RAW, delibTidiedWords:0});
  await page.reload({waitUntil:'networkidle'}); await page.waitForTimeout(800);
  await page.click('.mtab[data-pane="corr"]'); await page.waitForTimeout(300);
  await page.click(`#corrTidy-${letter.id} input`); await page.waitForTimeout(900);
  L=(await call('GET','/'+doc.id)).body.correspondence.find(c=>c.id===letter.id);
  ok('"checked by hand" on a letter is saved', L.delibHandChecked===true, L);
  ok('the page threw nothing', errors.length===0, errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); server.close(); process.exit(fail?1:0);
}
