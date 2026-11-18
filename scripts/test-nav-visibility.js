const fs=require('fs'), vm=require('vm');
const src=fs.readFileSync(process.env.HOME+'/mnt/aotc-track/public/js/app.js','utf8');
const i=src.indexOf('const NAV_ITEMS = [');
const navSrc=src.slice(i, src.indexOf('\n];', i)+3);
const grab=n=>{const a=src.indexOf('function '+n+'('); let d=0; const j=src.indexOf('{',a);
  for(let k=j;k<src.length;k++){if(src[k]==='{')d++;else if(src[k]==='}'){d--;if(!d)return src.slice(a,k+1);}}};
const ctx={console}; vm.createContext(ctx);
vm.runInContext([navSrc, grab('isElevated'), grab('visibleNavItems')].join('\n'), ctx);
const nav=u=>{ctx.U=u; return vm.runInContext('visibleNavItems(U).map(i=>i.href)', ctx);};

let fail=0; const ok=(c,m)=>{console.log((c?'PASS: ':'FAIL: ')+m); if(!c)fail=1;};

const dssSecretary={ role:'secretary', entity:{type:'committee',id:5},
  permissions:['planning.manage','entry.manage','attendance.manage','meetings.manage','reports.generate','roster.propose'] };
const n1=nav(dssSecretary);
console.log('\nDSS secretary nav:\n  '+n1.join('\n  ')+'\n');
ok(!n1.includes('/attendance.html'), 'a DSS committee secretary does NOT get the Attendance page');
ok(!n1.includes('/groups.html'), 'nor the Groups page');
ok(n1.includes('/meetings.html'), 'but does keep Meetings, which a committee genuinely holds');
ok(!n1.includes('/finance-weekly.html'), 'and not Weekly Finance');

const csRecorder={ role:'secretary', entity:{type:'committee',id:5}, permissions:['entry.manage','attendance.cs'] };
ok(nav(csRecorder).includes('/attendance.html'), 'a committee-scoped CS recorder still gets Attendance, as intended');

const groupSec={ role:'secretary', entity:{type:'group',id:3},
  permissions:['planning.manage','entry.manage','attendance.manage','meetings.manage'] };
ok(nav(groupSec).includes('/attendance.html'), 'a group secretary still gets Attendance for their own group meetings');

const accounts={ role:'accounts', entity:null, permissions:['finance.weekly','finance.quarterly','congregation.view'] };
ok(nav(accounts).includes('/finance-weekly.html'), 'the Accounts Clerk gets Weekly Finance');
const treasurer={ role:'treasurer', entity:null, permissions:['finance.weekly.confirm','congregation.view'] };
ok(nav(treasurer).includes('/finance-weekly.html'), 'so does the Treasurer');
process.exit(fail);
