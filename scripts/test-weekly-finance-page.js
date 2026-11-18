// Loads the real finance-weekly.html + page-finance-weekly.js in jsdom and
// drives them against the real route over HTTP. app.js is not loaded (it does
// service-worker and shell work jsdom cannot honour), so the handful of
// globals it provides are stubbed to their real behaviour.
process.env.AOTC_DATA_DIR = process.env.HOME + '/sbx';
const path=require('path'), fs=require('fs'); const root=process.env.HOME+'/mnt/aotc-track';
const { JSDOM } = require(path.join(root,'node_modules/jsdom'));
const authPath=require.resolve(path.join(root,'middleware/auth')); const realAuth=require(authPath);
let CURRENT={id:1,name:'Accounts Clerk',role:'accounts',permissions:['finance.weekly']};
require.cache[authPath]={id:authPath,filename:authPath,loaded:true,exports:{...realAuth,
  requireAuth:(q,_r,n)=>{q.user=CURRENT;n();},
  requirePermission:p=>(q,r,n)=>{q.user=CURRENT;return(['admin','localadmin'].includes(CURRENT.role)||(CURRENT.permissions||[]).includes(p))?n():r.status(403).json({error:'no permission'});},
  requireAnyPermission:(...ps)=>(q,r,n)=>{q.user=CURRENT;return(['admin','localadmin'].includes(CURRENT.role)||ps.some(p=>(CURRENT.permissions||[]).includes(p)))?n():r.status(403).json({error:'no permission'});},
  canManageAllEntities:()=>true}};
const express=require(path.join(root,'node_modules/express'));
const app=express(); app.use(express.json());
app.use('/api/finance-weekly', require(path.join(root,'routes/financeWeekly')));

let fail=0,n=0; const ok=(c,m)=>{n++;console.log((c?'  PASS ':'  FAIL ')+m); if(!c)fail++;};
const head=t=>console.log('\n── '+t);

const server=app.listen(0, async () => {
  const P=server.address().port;
  const html=fs.readFileSync(path.join(root,'public/finance-weekly.html'),'utf8');
  const js=fs.readFileSync(path.join(root,'public/js/page-finance-weekly.js'),'utf8');

  async function openPage({ apiBase, user }) {
    const dom=new JSDOM(html,{url:'http://localhost/finance-weekly.html?date=2026-10-04',runScripts:'outside-only',pretendToBeVisual:true});
    const w=dom.window;
    w.api = async (p, o={}) => {
      const r = await fetch(apiBase + p, { method:o.method||'GET', headers:{'Content-Type':'application/json'}, body:o.body?JSON.stringify(o.body):undefined });
      const isJson=(r.headers.get('content-type')||'').includes('application/json');
      const d=isJson?await r.json():null;
      if(!r.ok){const e=new Error((d&&d.error)||'Something went wrong.'); e.status=r.status; throw e;}
      return d;
    };
    w.esc=s=>String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
    w.toast=()=>{}; w.reopenButtonHtml=(k,t,l)=>`<button data-reopen-kind="${k}">${l||'Request to reopen'}</button>`; w.confirmDialog=async()=>true; w.isElevated=u=>['admin','localadmin'].includes(u.role);
    w.requireAuthAndRenderShell=async()=>user;
    w.CSS={escape:s=>String(s).replace(/[^a-zA-Z0-9_-]/g,'\\$&')};
    w.eval(js);
    for(let i=0;i<60;i++){await new Promise(r=>setTimeout(r,25)); if(w.document.getElementById('weekBody').innerHTML.trim())break;}
    return w;
  }

  head('A Sunday with nothing entered yet — the form must still appear');
  let w=await openPage({apiBase:`http://127.0.0.1:${P}/api`, user:CURRENT});
  let body=w.document.getElementById('weekBody');
  ok(body.innerHTML.trim().length>0,'the body is not blank');
  ok(/Funds received and paid/.test(body.textContent),'the entry card is there');
  ok(w.document.getElementById('weekLabel').textContent.includes('4 October 2026'),'the heading shows the Sunday, not the placeholder');
  const labels=[...body.querySelectorAll('input[data-line]')].map(i=>i.getAttribute('data-line'));
  ok(labels.includes('tithes')&&labels.includes('offertory1'),'the receipt lines are rendered as inputs');
  ok(labels.includes('expWelfare')&&labels.includes('higherCourts'),'the payment lines are rendered too');
  ok(labels.length===16,`all 16 lines appear (got ${labels.length})`);
  ok(/Total funds received/.test(body.textContent),'the running total row is there');
  ok(/Announcement text/.test(body.textContent),'the announcement panel is there');
  ok(/Save draft/.test(body.textContent)&&/Submit for confirmation/.test(body.textContent),'the clerk gets Save and Submit');
  ok(!/Confirm this week/.test(body.textContent),'but not Confirm — that is the Treasurer’s');

  head('Typing updates the total and the announcement live');
  const set=(k,v)=>{const el=w.document.querySelector(`[data-line="${k}"]`); el.value=String(v); w.recalc();};
  [['offertory1',2247],['offertory2',2443],['offertoryJy',134],['offertoryCs',341],['tithes',10830],
   ['communionDues',34],['thanksOffering',1000],['buildingPledge',6300],['buildingSupport',3000],['kutunse',500]].forEach(([k,v])=>set(k,v));
  ok(w.document.getElementById('receiptsTotal').textContent==='26,829.00','the on-screen total counts every receipt (26,829.00)');
  const ann=w.document.getElementById('annText').textContent;
  ok(/amounted to GHS 26,329\.00/.test(ann),'the announcement totals only the lines that are read out (26,329.00)');
  ok(!/Kutunse/.test(ann),'and leaves Kutunse out');

  head('A Treasurer sees the confirm action, not the entry actions');
  CURRENT={id:2,name:'Treasurer',role:'treasurer',permissions:['finance.weekly.confirm']};
  const clerk={id:1,name:'Clerk',role:'accounts',permissions:['finance.weekly']};
  // clerk submits first
  const tmp=await openPage({apiBase:`http://127.0.0.1:${P}/api`,user:clerk});
  CURRENT=clerk;
  await tmp.api('/finance-weekly/week/2026-10-04',{method:'PUT',body:{amounts:{tithes:100},status:'entered'}});
  CURRENT={id:2,name:'Treasurer',role:'treasurer',permissions:['finance.weekly.confirm']};
  w=await openPage({apiBase:`http://127.0.0.1:${P}/api`,user:CURRENT});
  body=w.document.getElementById('weekBody');
  ok(/Confirm this week/.test(body.textContent),'the Treasurer gets Confirm');
  ok(!/Save draft/.test(body.textContent),'and not the entry buttons');
  ok([...body.querySelectorAll('input[data-line]')].every(i=>i.disabled),'the figures are read-only to the Treasurer');

  head('When the API is not answering, the page says so');
  w=await openPage({apiBase:`http://127.0.0.1:${P}/api/NOPE`, user:clerk});
  body=w.document.getElementById('weekBody');
  ok(/could not be loaded/i.test(body.textContent),'it reports the failure instead of showing nothing');
  ok(/restarted/i.test(body.textContent),'and names the likely cause when the route 404s');

  console.log(`\n${n-fail}/${n} checks — ${fail?'FAILURES ABOVE':'all green'}`);
  server.close(); process.exit(fail);
});
