// Tidy status + export check, in a real browser.
// Run with: node tidy-check.js   (needs playwright; set CHROME_PATH if Chromium lives elsewhere)
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
const server=app.listen(4456, run);
const LONG='Ing Kwaku Koranteng send that it to be inappropriate to just reach out to this time and best possibly for help when no relationship has been established and we should rather build one.';
async function run(){
  const call=async(m,p,b)=>{const r=await realFetch('http://localhost:4456/api/minutes'+p,{method:m,headers:{cookie:`token=${T}`,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return {status:r.status, body:await r.json()};};
  await call('POST','/roster/seed');
  const doc=(await call('POST','/',{date:'2026-09-24'})).body;
  const g=(await call('GET','/'+doc.id)).body.doc;
  const otherKey='other';
  // two Other Matters: one long raw, one short
  await call('PUT',`/${doc.id}/section`,{key:otherKey,enabled:true,children:[{subject:'Other Matters I',body:LONG},{subject:'Other Matters II',body:'The Session noted this.'}]});
  let pass=0,fail=0; const ok=(n,c,x)=>{c?(pass++,console.log('  ✓',n)):(fail++,console.log('  ✗ FAIL:',n,JSON.stringify(x)))};
  const { chromium } = require('playwright');
  const browser=await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx=await browser.newContext({acceptDownloads:true}); await ctx.addCookies([{name:'token',value:T,domain:'localhost',path:'/'}]);
  const page=await ctx.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://localhost:4456/minutes.html?meeting=${doc.id}`,{waitUntil:'networkidle'}); await page.waitForTimeout(1000);
  await page.click('.mtab[data-pane="body"]'); await page.waitForTimeout(300);
  const b1=await page.evaluate(()=>[...document.querySelectorAll('[id^="tidyBadge-"]')].map(e=>e.textContent.replace(/\s+/g,' ').trim()).filter(Boolean));
  ok('the long raw item is marked not tidied', b1.some(t=>/Not tidied yet/.test(t)), b1);
  ok('the short line carries no badge', b1.length===1, b1);
  await page.click('.mtab[data-pane="docs"]'); await page.waitForTimeout(300);
  const banner=await page.textContent('#tidyCheck');
  ok('the Documents tab lists it', /1 item has not been tidied/.test(banner) && /Other Matters I/.test(banner) && !/Other Matters II/.test(banner), banner);
  // download is intercepted
  await page.click('#dlMinDocx'); await page.waitForTimeout(400);
  const dlg=await page.evaluate(()=>document.querySelector('.confirm-modal')?.textContent||'');
  ok('downloading the Word file asks first', /not been tidied/.test(dlg) && /Download anyway/.test(dlg), dlg);
  await page.click('.confirm-modal .btn-secondary'); await page.waitForTimeout(200);
  // tidy them all
  await page.click('#tidyAllBtn'); await page.waitForTimeout(1500);
  const banner2=await page.textContent('#tidyCheck');
  ok('Tidy them all clears the list', /Every item with text has been tidied/.test(banner2), banner2);
  ok('the tidy-up asked for Opus 5.5', modelsAsked.length===1 && modelsAsked[0]==='claude-opus-5-5', modelsAsked);
  ok('and sent the house style', systemHasHouse);
  const saved=(await call('GET','/'+doc.id)).body.doc.sections.find(s=>s.key===otherKey).children[0];
  ok('the tidied text is SAVED on the server', /^TIDIED:/.test(saved.body), saved.body.slice(0,40));
  ok('with its tidy mark', saved.tidiedWords>0, saved);
  // reload: still tidied
  await page.reload({waitUntil:'networkidle'}); await page.waitForTimeout(800);
  await page.click('.mtab[data-pane="body"]'); await page.waitForTimeout(300);
  const b2=await page.evaluate(()=>[...document.querySelectorAll('[id^="tidyBadge-"]')].map(e=>e.textContent.replace(/\s+/g,' ').trim()).filter(Boolean));
  ok('after a reload it still shows tidied', b2.some(t=>/✓ Tidied/.test(t)), b2);
  // add a lot of dictation → flagged again
  const ta=await page.$$('#secList .child textarea'); 
  await ta[0].fill(saved.body+' '+LONG); await ta[0].evaluate(e=>e.dispatchEvent(new Event('change',{bubbles:true}))); await page.waitForTimeout(900);
  const b3=await page.evaluate(()=>[...document.querySelectorAll('[id^="tidyBadge-"]')].map(e=>e.id+': '+e.textContent.replace(/\s+/g,' ').trim()).join(' | '));
  ok('adding a lot after the tidy flags it again', /Added to a lot/.test(b3), b3);
  // tick checked by hand
  // a raw item typed into and then ticked straight away — the blur fires first
  await call('PUT',`/${doc.id}/section`,{key:'main',enabled:true,children:[{subject:'Farewell',body:LONG}]});
  await page.reload({waitUntil:'networkidle'}); await page.waitForTimeout(800); await page.click('.mtab[data-pane="body"]'); await page.waitForTimeout(300);
  const mainTa=await page.$$('#secList .child textarea'); await mainTa[0].click(); await page.keyboard.type(' More.');
  const firstTick=await page.$$('#secList .child input[onchange^="tidyHand"]'); await firstTick[0].click(); await page.waitForTimeout(800);
  const mainSaved=(await call('GET','/'+doc.id)).body.doc.sections.find(s=>s.key==='main').children[0];
  ok('typing then ticking straight away is not lost', mainSaved.handChecked===true && /More\.$/.test(mainSaved.body), mainSaved);
  const nTicks=await page.$$eval('#secList .child input[onchange^="tidyHand"]', els=>els.map(e=>e.outerHTML));
  await page.click('#secList .child:nth-of-type(n) input[onchange^="tidyHand(8"]').catch(async()=>{const x=await page.$$('input[onchange^="tidyHand"]'); await x[x.length-1].click();}); await page.waitForTimeout(800);
  const saved2=(await call('GET','/'+doc.id)).body.doc.sections.find(s=>s.key===otherKey).children[0];
  ok('"checked by hand" is saved', saved2.handChecked===true, saved2);
  await page.click('.mtab[data-pane="docs"]'); await page.waitForTimeout(300);
  ok('and clears the Documents check', /Every item/.test(await page.textContent('#tidyCheck')));
  // now download proceeds without a dialog
  const [dl]=await Promise.all([page.waitForEvent('download',{timeout:5000}).catch(()=>null), page.click('#dlMinDocx')]);
  await page.waitForTimeout(300);
  const dlg2=await page.evaluate(()=>!!document.querySelector('.confirm-modal'));
  ok('with nothing untidied, the download goes straight through', !dlg2);
  ok('the page threw nothing', errors.length===0, errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); server.close(); process.exit(fail?1:0);
}
