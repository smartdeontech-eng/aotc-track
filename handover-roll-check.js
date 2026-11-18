// A transferred minister: off the roll for new meetings, still on the roll —
// and still District Minister — for the meetings he chaired.
// Run with: node handover-roll-check.js
process.env.JWT_SECRET='x'.repeat(48);
process.env.AOTC_DATA_DIR='/tmp/aotc-handover';
const fs=require('fs');
fs.rmSync('/tmp/aotc-handover',{recursive:true,force:true}); fs.mkdirSync('/tmp/aotc-handover',{recursive:true});
const express=require('express'), cookieParser=require('cookie-parser'), jwt=require('jsonwebtoken'), db=require('./utils/db');
const clerk=db.insert('users',{name:'Gideon',email:'g@x.com',role:'clerk',permissions:['approvals.manage','congregation.view','minutes.manage'],sessionVersion:0});
const T=jwt.sign({id:clerk.id,name:clerk.name,email:clerk.email,role:clerk.role,sv:0},process.env.JWT_SECRET,{expiresIn:'1h'});
const app=express(); app.use(express.json()); app.use(cookieParser());
app.use('/api/minutes', require('./routes/minutes'));
const server=app.listen(4459, run);
async function run(){
  const call=async(m,p,b)=>{const r=await fetch('http://localhost:4459/api/minutes'+p,{method:m,headers:{cookie:`token=${T}`,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return {status:r.status, body:await r.json()};};
  let pass=0,fail=0; const ok=(n,c,x)=>{c?(pass++,console.log('  ✓',n)):(fail++,console.log('  ✗ FAIL:',n,JSON.stringify(x)))};
  const ros=(await call('POST','/roster/seed')).body;
  const tettey=ros.find(m=>/Tettey/.test(m.name));
  ok('the seeded roster has Rev Tettey as District Minister', tettey && /District Minister/i.test(tettey.position), tettey);
  await call('POST','/offices/seed',{});
  const aug=(await call('POST','/',{date:'2026-08-27'})).body;
  await call('PUT',`/${aug.id}/roll`,{roll:{presentIds:[tettey.id, ros[1].id]}});
  // The new minister comes in through Add member, with the office set.
  const add=await call('POST','/roster',{name:'Kofi Manukure Akyeampong',titles:['Rev'],kind:'agent',office:'district_minister',officeFrom:'2026-09-01'});
  ok('Add member reports who was released', add.status===201 && /Tettey/.test(add.body.released||''), add.body);
  // Rev Tettey leaves (what "Yes, take him off" sends)
  const off=await call('PUT',`/roster/${tettey.id}`,{active:false,leftOn:'2026-09-01'});
  ok('taking him off keeps the date he left', off.body.active===false && off.body.leftOn==='2026-09-01', off.body);
  const sep=(await call('POST','/',{date:'2026-09-24'})).body;
  const g2=(await call('GET','/'+sep.id)).body;
  ok('he is NOT on the roll for 24th September', !g2.roster.some(m=>m.id===tettey.id), g2.roster.map(m=>m.name));
  ok('and the new minister is, as District Minister', g2.roster.some(m=>/Akyeampong/.test(m.name) && m.position==='District Minister'), g2.roster.filter(m=>/Akyeampong/.test(m.name)));
  await call('PUT',`/${sep.id}/roll`,{roll:{presentIds:[ros[1].id]}});
  const sepRoll=(await call('GET','/'+sep.id)).body.doc.roll;
  ok('nor among the absent when the roll is saved', !sepRoll.absentIds.includes(tettey.id), sepRoll.absentIds);
  const g1=(await call('GET','/'+aug.id)).body;
  const t1=g1.roster.find(m=>m.id===tettey.id);
  ok('he IS still on the roll for 27th August', !!t1, g1.roster.map(m=>m.name));
  ok('listed there as District Minister, not Member', t1 && t1.position==='District Minister', t1 && t1.position);
  await call('PUT',`/${aug.id}/roll`,{roll:{presentIds:[tettey.id, ros[1].id]}});
  const augRoll=(await call('GET','/'+aug.id)).body.doc.roll;
  ok('re-saving the August roll keeps him present', augRoll.presentIds.includes(tettey.id), augRoll);
  // A member taken off before leftOn existed, and never marked present
  db.update('session_members', ros[2].id, { active:false });
  const g3=(await call('GET','/'+aug.id)).body;
  ok('someone taken off without a date is left out unless the roll records him', !g3.roster.some(m=>m.id===ros[2].id));
  const pdf=await fetch(`http://localhost:4459/api/minutes/${aug.id}/minutes.pdf`,{headers:{cookie:`token=${T}`}});
  const buf=Buffer.from(await pdf.arrayBuffer()); require('fs').writeFileSync('/tmp/aotc-handover/aug.pdf',buf);
  const txt=require('child_process').execSync('pdftotext -layout /tmp/aotc-handover/aug.pdf -').toString();
  const line=(txt.split('\n').find(l=>/TETTEY/i.test(l))||'').replace(/\s+/g,' ').trim();
  ok('the printed August minutes list him as DISTRICT MINISTER', /TETTEY.*DISTRICT MINISTER/i.test(line), line || txt.slice(0,300));
  console.log(`\n${pass} passed, ${fail} failed`);
  server.close(); process.exit(fail?1:0);
}
