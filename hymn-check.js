// Hymn stanza picker, in a real browser.
// Hymn picker check. Run with: node hymn-check.js   (needs playwright; set CHROME_PATH if Chromium lives elsewhere)
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
const server=app.listen(4457, run);
const LONG='Ing Kwaku Koranteng send that it to be inappropriate to just reach out to this time and best possibly for help when no relationship has been established and we should rather build one.';
async function run(){
  const call=async(m,p,b)=>{const r=await realFetch('http://localhost:4457/api/minutes'+p,{method:m,headers:{cookie:`token=${T}`,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return {status:r.status, body:await r.json()};};
  await call('POST','/roster/seed');
  const doc=(await call('POST','/',{date:'2026-09-24'})).body;
  const g=(await call('GET','/'+doc.id)).body.doc;
  const otherKey='other';
  // two Other Matters: one long raw, one short
  await call('PUT',`/${doc.id}/section`,{key:otherKey,enabled:true,children:[{subject:'Other Matters I',body:LONG},{subject:'Other Matters II',body:'The Session noted this.'}]});
  let pass=0,fail=0; const ok=(n,c,x)=>{c?(pass++,console.log('  ✓',n)):(fail++,console.log('  ✗ FAIL:',n,JSON.stringify(x)))};
  const SM=require('./utils/sessionMinutes');
  const { chromium } = require('playwright');
  const browser=await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const ctx=await browser.newContext(); await ctx.addCookies([{name:'token',value:T,domain:'localhost',path:'/'}]);
  const page=await ctx.newPage(); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  // an older set of minutes with only a typed line
  await call('PUT',`/${doc.id}/proceedings`,{proceedings:{hymn:'2 stanzas of PH 1', devotionBy:'Rev Joseph Richmond Tettey', commencedAt:'6.38 p.m.'}});
  await page.goto(`http://localhost:4457/minutes.html?meeting=${doc.id}`,{waitUntil:'networkidle'}); await page.waitForTimeout(1000);
  await page.click('.mtab[data-pane="body"]'); await page.waitForTimeout(300);
  ok('an old typed line still shows its PH number', await page.inputValue('#pHymnNo')==='1');
  await page.selectOption('#pHymnTotal','4'); await page.waitForTimeout(400);
  const chips=await page.$$('#pHymnChips .hymnStanza'); ok('four stanza boxes once the hymn has four', chips.length===4, chips.length);
  await chips[2].check(); await page.waitForTimeout(200); await (await page.$$('#pHymnChips .hymnStanza'))[3].check(); await page.waitForTimeout(700);
  ok('the printed line reads "the last two stanzas of PH 1"', await page.inputValue('#pHymn')==='the last two stanzas of PH 1', await page.inputValue('#pHymn'));
  let p=(await call('GET','/'+doc.id)).body.doc.proceedings;
  ok('and it is saved', p.hymn==='the last two stanzas of PH 1' && p.hymnStanzas==='3,4' && p.hymnTotal==='4', p);
  ok('the devotion sentence uses it', /leading the singing of the last two stanzas of PH 1\./.test(SM.autoBody('devotion',p)), SM.autoBody('devotion',p));
  await page.reload({waitUntil:'networkidle'}); await page.waitForTimeout(800); await page.click('.mtab[data-pane="body"]'); await page.waitForTimeout(300);
  const back=await page.$$eval('#pHymnChips .hymnStanza',els=>els.filter(e=>e.checked).map(e=>e.value));
  ok('after a reload the same boxes are ticked', back.join()==='3,4', back);
  await page.click('#hymnAllBtn'); await page.waitForTimeout(700);
  ok('"All 4" gives "all four stanzas of PH 1"', await page.inputValue('#pHymn')==='all four stanzas of PH 1', await page.inputValue('#pHymn'));
  // 1 and 3 with no total
  await page.selectOption('#pHymnTotal',''); await page.waitForTimeout(400);
  for (const c of await page.$$('#pHymnChips .hymnStanza')) await c.uncheck();
  await page.waitForTimeout(300);
  const cs=await page.$$('#pHymnChips .hymnStanza'); await cs[0].check(); await page.waitForTimeout(150); await cs[2].check(); await page.waitForTimeout(700);
  ok('stanzas 1 and 3 read "stanzas one and three of PH 1"', await page.inputValue('#pHymn')==='stanzas one and three of PH 1', await page.inputValue('#pHymn'));
  ok('the page threw nothing', errors.length===0, errors);
  console.log(`\n${pass} passed, ${fail} failed`);
  await browser.close(); server.close(); process.exit(fail?1:0);
}
