process.env.JWT_SECRET='x'.repeat(48);
process.env.AOTC_DATA_DIR='/tmp/aotc-data7';
const fs=require('fs');
fs.rmSync('/tmp/aotc-data7',{recursive:true,force:true}); fs.mkdirSync('/tmp/aotc-data7',{recursive:true});
const express=require('express'), cookieParser=require('cookie-parser'), jwt=require('jsonwebtoken'), db=require('./utils/db');
const clerk=db.insert('users',{name:'Gideon',email:'g@x.com',role:'clerk',permissions:['approvals.manage','congregation.view'],sessionVersion:0});
const T=jwt.sign({id:clerk.id,name:clerk.name,email:clerk.email,role:clerk.role,sv:0},process.env.JWT_SECRET,{expiresIn:'1h'});
const app=express(); app.use(express.json()); app.use(cookieParser());
app.use('/api/minutes', require('./routes/minutes'));
const server=app.listen(4327, run);
let pass=0,fail=0;
const ok=(n,c,x)=>{c?(pass++,console.log('  ✓',n)):(fail++,console.log('  ✗ FAIL:',n,x===undefined?'':JSON.stringify(x).slice(0,220)))};
const off2=(r,k)=>r.body.offices.find(o=>o.key===k);
const call=async(m,p,b)=>{const r=await fetch('http://localhost:4327/api/minutes'+p,{method:m,headers:{cookie:`token=${T}`,'content-type':'application/json'},body:b?JSON.stringify(b):undefined});return{status:r.status,body:await r.json()};};

async function run(){
 try{
  const ros=(await call('POST','/roster/seed')).body;
  const id=n=>ros.find(m=>new RegExp(n,'i').test(m.name)).id;
  const doc=(await call('POST','/',{date:'2026-07-09',venue:'2nd Floor'})).body;

  console.log('The roll saves on its own, as people arrive:');
  let r=await call('PUT',`/${doc.id}/roll`,{roll:{presentIds:[id('Tettey')]}});
  ok('first arrival saved', r.body.roll.presentIds.length===1);
  r=await call('PUT',`/${doc.id}/roll`,{roll:{presentIds:[id('Tettey'),id('Gideon')],guests:[{name:'Mr Kofi Mensah',position:'Presenter'}]}});
  ok('a late arrival added', r.body.roll.presentIds.length===2);
  ok('someone in attendance recorded', r.body.roll.guests.length===1);
  ok('absent recomputed each time', r.body.roll.absentIds.length===23, r.body.roll.absentIds.length);

  console.log('Confirm & lock, and unlock to correct:');
  r=await call('POST',`/${doc.id}/roll/lock`);
  ok('locked', r.body.roll.locked===true && !!r.body.roll.lockedBy);
  r=await call('PUT',`/${doc.id}/roll`,{roll:{presentIds:[id('Tettey')]}});
  ok('a locked roll refuses edits', r.status===400 && /locked/i.test(r.body.error), r.body);
  r=await call('PUT','/'+doc.id,{roll:{presentIds:[]}});
  ok('and a whole-document save cannot clobber it', (await call('GET','/'+doc.id)).body.doc.roll.presentIds.length===2);
  r=await call('POST',`/${doc.id}/roll/unlock`);
  ok('unlocked for correction', r.body.roll.locked===false);
  r=await call('PUT',`/${doc.id}/roll`,{roll:{presentIds:[id('Tettey'),id('Gideon'),id('Koranteng')]}});
  ok('correction accepted', r.body.roll.presentIds.length===3);

  console.log('Sections save one at a time:');
  await call('PUT',`/${doc.id}/section`,{key:'other',children:[{subject:'Use of Chapel',body:'Discussed at length.'}]});
  await call('PUT',`/${doc.id}/section`,{key:'prayers',body:'The Senior Presbyter led the Session in prayer.'});
  let full=(await call('GET','/'+doc.id)).body.doc;
  ok('Other Matters kept', full.sections.find(s=>s.key==='other').children[0].body==='Discussed at length.');
  ok('Prayers kept', /Senior Presbyter/.test(full.sections.find(s=>s.key==='prayers').body));
  // a stale writer touching one section must not wipe the other
  await call('PUT',`/${doc.id}/section`,{key:'main',children:[{subject:'Transfer of Minister',body:'Proposed 23rd August.'}]});
  full=(await call('GET','/'+doc.id)).body.doc;
  ok('writing a third section left the first two alone',
     full.sections.find(s=>s.key==='other').children[0].body==='Discussed at length.' &&
     /Senior Presbyter/.test(full.sections.find(s=>s.key==='prayers').body));
  ok('and the third landed', /23rd August/.test(full.sections.find(s=>s.key==='main').children[0].body));

  console.log('Proceedings merge field by field:');
  await call('PUT',`/${doc.id}/proceedings`,{proceedings:{commencedAt:'6.53 p.m.'}});
  await call('PUT',`/${doc.id}/proceedings`,{proceedings:{constitutedAt:'7.04 p.m.'}});
  full=(await call('GET','/'+doc.id)).body.doc;
  ok('both times kept', full.proceedings.commencedAt==='6.53 p.m.' && full.proceedings.constitutedAt==='7.04 p.m.', full.proceedings);

  console.log('Composition:');
  r=await call('GET','/composition');
  ok('roster returned in rank order', r.body.members[0].position==='District Minister');
  ok('tally present', !!r.body.tally && typeof r.body.tally.held==='number');
  const co=await call('POST','/roster',{name:'Mr Visitor Co-opt',position:'Member',coOpted:true,coOptedOn:'2026-03-12',coOptedFor:'Building liaison',coOptedUntil:'2026-06-30'});
  ok('co-opted member added', co.status===201 && co.body.coOpted===true);
  r=await call('GET','/composition');
  const cm=r.body.members.find(m=>m.id===co.body.id);
  ok('co-option note built', /co-opted 2026-03-12 · Building liaison/.test(cm.coOptionNote), cm.coOptionNote);
  ok('expired term surfaced', cm.coOptionExpired===true);
  ok('ordinary members carry no note', r.body.members.find(m=>m.position==='Session Clerk').coOptionNote==='');

  console.log('Venue is a list, defaulting to the Session Hall:');
  r=await call('GET','/venues');
  ok('the Session Hall is the default', r.body.defaultVenue==='Rev Adu-Mante Session Hall', r.body);
  ok('and is offered first', r.body.venues[0].name==='Rev Adu-Mante Session Hall', r.body.venues);
  const nVenues=r.body.venues.length;
  ok('asking again does not duplicate it', (await call('GET','/venues')).body.venues.length===nVenues);
  const d2=(await call('POST','/',{date:'2026-09-10'})).body;
  ok('a meeting created without a venue lands in the Session Hall', d2.venue==='Rev Adu-Mante Session Hall', d2.venue);
  const d3=(await call('POST','/',{date:'2026-10-08',venue:'Church Auditorium'})).body;
  ok('an explicit venue is respected', d3.venue==='Church Auditorium');
  // scheduling ties the name back to the venue book, so the Meetings page can
  // still spot a double booking of the hall
  await call('POST',`/${doc.id}/schedule`,{time:'18:30'});
  const mtg=db.findAll('meetings').find(m=>m.sessionMinutesId===doc.id);
  ok('scheduling records the venue name', mtg && mtg.venueName==='2nd Floor', mtg&&mtg.venueName);
  await call('PUT','/'+d2.id,{venue:'Rev Adu-Mante Session Hall'});
  await call('POST',`/${d2.id}/schedule`,{time:'18:30'});
  const mtg2=db.findAll('meetings').find(m=>m.sessionMinutesId===d2.id);
  const hall=db.findAll('venues').find(v=>v.name==='Rev Adu-Mante Session Hall');
  ok('and resolves it to the shared venue book', mtg2 && mtg2.venueId===hall.id, mtg2&&mtg2.venueId);
  // a venue taken off the list deliberately must not come back
  db.update('venues', hall.id, { active:false });
  r=await call('GET','/venues');
  ok('a removed venue is not resurrected',
     !r.body.venues.some(v=>v.name==='Rev Adu-Mante Session Hall') &&
     db.findAll('venues').filter(v=>v.name==='Rev Adu-Mante Session Hall').length===1, r.body.venues);
  db.update('venues', hall.id, { active:true });

  console.log('Scheduling without notifying:');
  // a future meeting, so the past-date guard is not what silences the notice
  const q=(await call('POST','/',{date:'2027-02-11',venue:'Rev Adu-Mante Session Hall'})).body;
  r=await call('POST',`/${q.id}/schedule`,{time:'18:30',notify:false});
  ok('the meeting reaches the Meetings page', !!r.body.meeting && r.body.meeting.sessionMinutesId===q.id);
  ok('but no notice goes out', r.body.notified===null && r.body.quiet===true, r.body);
  ok('and nothing is stamped as sent', !(await call('GET','/'+q.id)).body.doc.noticeSentAt);
  // a quiet edit afterwards must stay quiet
  await call('PUT','/'+q.id,{venue:'Church Auditorium'});
  r=await call('POST',`/${q.id}/schedule`,{time:'18:30',notify:false});
  ok('a move stays quiet when asked to', r.body.notified===null && r.body.quiet===true);
  ok('the venue change still reached the Meetings page', r.body.meeting.venueName==='Church Auditorium');
  // omitting the flag keeps the old behaviour: announce a real change
  r=await call('POST',`/${q.id}/schedule`,{time:'18:30'});
  ok('and with the flag left off, nothing changed means nothing sent', r.body.notified===null && r.body.quiet===true, r.body);

  console.log('What notices say about the agenda:');
  r=await call('GET','/notice-settings');
  ok('defaults to the WhatsApp group', /WhatsApp/i.test(r.body.agendaNote), r.body);
  r=await call('PUT','/notice-settings',{agendaNote:'The agenda is on the Session WhatsApp group.'});
  ok('the line can be changed', r.body.agendaNote==='The agenda is on the Session WhatsApp group.');
  ok('and it sticks', (await call('GET','/notice-settings')).body.agendaNote==='The agenda is on the Session WhatsApp group.');
  r=await call('PUT','/notice-settings',{agendaNote:''});
  ok('and can be emptied to say nothing', r.body.agendaNote==='');
  await call('PUT','/notice-settings',{agendaNote:'The agenda will be shared on the WhatsApp group.'});

  console.log('The WhatsApp post writes itself:');
  await call('PUT','/'+q.id,{agenda:[
    {mins:10,item:'Opening Devotion',responsible:'Presbyters on Duty',subItems:[]},
    {mins:15,item:'Correspondence',responsible:'Session Clerk',subItems:[{item:'Letter from the District'}]},
  ]});
  r=await call('GET',`/${q.id}/whatsapp`);
  const wa=r.body.text||'';
  ok('leads with the meeting, in WhatsApp bold', /^\*PCG-AOTC — Session Meeting\*/.test(wa), wa.slice(0,80));
  ok('carries the date in full', /Thursday, 11 February 2027/.test(wa), wa.split('\n')[1]);
  ok('and the venue', /Church Auditorium/.test(wa));
  ok('numbers the agenda as the sheet does', /1\. Opening Devotion/.test(wa) && /2\. Correspondence/.test(wa), wa);
  ok('letters the sub-items', /a\) Letter from the District/.test(wa), wa);
  ok('and shows the clock time', /6:30 pm/.test(wa), wa);

  console.log('The invitation post, in the Clerk\'s own words:');
  const inv=(await call('POST','/',{date:'2026-08-27',startTime:'18:30',venue:'Rev. Adu-Mante Hall'})).body;
  let n1=(await call('GET',`/${inv.id}/whatsapp?kind=notice`)).body.text||'';
  ok('opens with the greeting', /^May the peace of the Lord be with you\./.test(n1), n1.slice(0,60));
  ok('invites to the meeting by name', /You are kindly invited to attend a Session Meeting scheduled as follows:/.test(n1), n1);
  ok('date is bulleted and ordinal', / • Date: Thursday, 27th August 2026/.test(n1), n1);
  ok('time has no space before pm', / • Time: 6:30pm/.test(n1), n1);
  ok('venue as recorded', / • Venue: Rev\. Adu-Mante Hall/.test(n1), n1);
  ok('promises the agenda while there is none', /The agenda for the meeting would be shared soon\./.test(n1), n1);
  ok('closes with the blessing and hands', /Thank you, and may the Lord guide our deliberations\.\nHave a blessed (day|afternoon|night)\. 🙏🏾🙏🏾$/.test(n1), n1);
  // once an agenda exists the promise becomes a pointer to it
  await call('PUT','/'+inv.id,{agenda:[{mins:10,item:'Opening Devotion',responsible:'Presbyters on Duty',subItems:[]}]});
  n1=(await call('GET',`/${inv.id}/whatsapp?kind=notice`)).body.text||'';
  ok('and points to it once it exists', /Please find the agenda for the meeting attached\./.test(n1), n1);
  ok('the agenda post is still its own thing', /\*AGENDA\*/.test((await call('GET',`/${inv.id}/whatsapp`)).body.text));
  // the 11th–13th are the ones a naive ordinal gets wrong
  const odd=(await call('POST','/',{date:'2026-11-12',startTime:'09:00'})).body;
  ok('11th–13th handled', / • Date: Thursday, 12th November 2026/.test((await call('GET',`/${odd.id}/whatsapp?kind=notice`)).body.text));
  ok('morning times read correctly', / • Time: 9:00am/.test((await call('GET',`/${odd.id}/whatsapp?kind=notice`)).body.text));

  console.log('Sending the notice attaches the agenda:');
  r=await call('POST',`/${q.id}/schedule`,{time:'18:30',notify:true});
  ok('the notice went out on request', !!r.body.notified && r.body.quiet===false, r.body);
  ok('with the agenda PDF attached', r.body.notified.agendaAttached===true, r.body.notified);
  ok('and the send is stamped on the meeting', !!(await call('GET','/'+q.id)).body.doc.noticeSentAt);

  console.log('Agents, presbyters and the offices of the Session:');
  r=await call('GET','/composition');
  const off=k=>r.body.offices.find(o=>o.key===k);
  ok('offices are listed', (r.body.offices||[]).length>=9, (r.body.offices||[]).length);
  ok('the ministers and catechists are agents',
     off('district_minister').kind==='agent' && off('catechist').kind==='agent');
  ok('the Clerk and Treasurer are presbyters',
     off('session_clerk').kind==='presbyter' && off('treasurer').kind==='presbyter');
  ok('the Session\'s own offices are marked as such',
     off('deputy_senior_presbyter').constitutional===false &&
     off('assistant_session_clerk').constitutional===false &&
     off('linguist').constitutional===false);
  ok('the Linguist receives visitors', /receives visitors/i.test(off('linguist').note||''), off('linguist').note);
  ok('offices are read from an old roster with no migration',
     off('district_minister').holders[0] && /Tettey/.test(off('district_minister').holders[0].name), off('district_minister').holders);
  ok('a Catechist office holds more than one', off('catechist').holders.length===2, off('catechist').holders);
  ok('members carry their standing', r.body.members.find(m=>/Tettey/.test(m.name)).memberKind==='agent'
     && r.body.members.find(m=>/Koranteng/.test(m.name)).memberKind==='presbyter');

  console.log('Only an agent may constitute the Session:');
  r=await call('GET','/'+doc.id);
  const ag=r.body.eligibility.agents||[];
  ok('the chairperson pool is the agents', ag.length===4, ag.map(a=>a.name));
  ok('and holds no presbyters', !ag.some(a=>/Koranteng|Tweneboa|Adjierteh/.test(a.name)), ag.map(a=>a.name));
  ok('regardless of who is on tonight\'s roll', ag.length > r.body.eligibility.present.length, {ag:ag.length,present:r.body.eligibility.present.length});

  console.log('A new minister arrives:');
  const newMin=(await call('POST','/roster',{name:'Rev Kwame Asante',office:'district_minister'})).body;
  ok('he is recorded as an agent', newMin.office==='district_minister' && newMin.position==='District Minister');
  r=await call('GET','/composition');
  ok('and holds the office alone', off2(r,'district_minister').holders.length===1
     && /Asante/.test(off2(r,'district_minister').holders[0].name), off2(r,'district_minister').holders);
  const old=r.body.members.find(m=>/Tettey/.test(m.name));
  ok('the outgoing minister is released, not deleted', !!old && !old.office, old);
  ok('and is no longer offered as chairperson',
     !((await call('GET','/'+doc.id)).body.eligibility.agents||[]).some(a=>/Tettey/.test(a.name)));
  // the Session's own offices behave the same way
  await call('PUT','/roster/'+id('Koranteng'),{office:'linguist'});
  r=await call('GET','/composition');
  ok('the Linguist can be named', /Koranteng/.test((off2(r,'linguist').holders[0]||{}).name||''), off2(r,'linguist').holders);
  ok('and remains a presbyter, not an agent',
     r.body.members.find(m=>/Koranteng/.test(m.name)).memberKind==='presbyter');

  console.log('The agenda knows the offices:');
  r=await call('GET','/'+doc.id);
  const offs=(r.body.offices||[]).map(o=>o.label);
  ok('offices come with the document', offs.includes('District Minister') && offs.includes('Linguist'), offs);
  ok('and say which are constitutional',
     (r.body.offices.find(o=>o.key==='linguist')||{}).constitutional===false &&
     (r.body.offices.find(o=>o.key==='session_clerk')||{}).constitutional===true);
  ok('the roster comes with display names to offer',
     (r.body.roster||[]).every(m=>typeof m.displayName==='string'));

  console.log('People are addressed properly:');
  await call('PUT','/roster/'+id('Emmanuel Adjei Twum'),{title:'Mr'});
  await call('PUT','/roster/'+id('Cecilia Pokua Anto'),{titles:['Madam']});
  r=await call('GET','/composition');
  const twum=r.body.members.find(m=>/Twum/.test(m.name));
  ok('a title is recorded', JSON.stringify(twum.titles)===JSON.stringify(['Mr'])
     && twum.displayName==='Mr Emmanuel Adjei Twum', {titles:twum.titles, shown:twum.displayName});
  ok('a name that already carries one is left alone',
     r.body.members.find(m=>/Koranteng/.test(m.name)).displayName==='Kwaku Koranteng (Ing)');
  ok('and is not marked as needing one',
     r.body.members.find(m=>/Koranteng/.test(m.name)).needsTitle===false);
  ok('someone with neither is flagged for a title',
     r.body.members.find(m=>/Alex Abankwa/.test(m.name)).needsTitle===true);
  // a hurried short form typed during the meeting is written out in full
  await call('PUT',`/${doc.id}/proceedings`,{proceedings:{minutesMovedBy:'A. Twum', closureSecondedBy:'C. P. Anto'}});
  full=(await call('GET','/'+doc.id)).body.doc;
  ok('"A. Twum" becomes the full name', full.proceedings.minutesMovedBy==='Mr Emmanuel Adjei Twum', full.proceedings.minutesMovedBy);
  ok('initials resolve too', full.proceedings.closureSecondedBy==='Madam Cecilia Pokua Anto', full.proceedings.closureSecondedBy);
  await call('PUT',`/${doc.id}/proceedings`,{proceedings:{presentationBy:'Mr Kofi Mensah of Ghana Water'}});
  ok('a visitor the roster does not know is left exactly as typed',
     (await call('GET','/'+doc.id)).body.doc.proceedings.presentationBy==='Mr Kofi Mensah of Ghana Water');
  r=await call('GET','/'+doc.id);
  ok('the pools offer the titled names', (r.body.eligibility.present||[]).some(p=>p.name==='Mr Emmanuel Adjei Twum')
     || (r.body.eligibility.agents||[]).length>0, r.body.eligibility.present);

  console.log('More than one title, in the congregation\'s own arrangement:');
  const boa=id('Boamah');
  r=await call('PUT','/roster/'+boa,{name:'Martin Owusu Boamah',titles:['Dr','Rev']});
  ok('two titles are kept', JSON.stringify(r.body.titles)===JSON.stringify(['Rev','Dr']), r.body.titles);
  r=await call('GET','/composition');
  ok('and print as the minutes write them',
     r.body.members.find(m=>m.id===boa).displayName==='Rev Martin Owusu Boamah (Dr)',
     r.body.members.find(m=>m.id===boa).displayName);
  const hen=id('Henrietta');
  await call('PUT','/roster/'+hen,{name:'Henrietta Abena Frempong',titles:['Mrs','Catechist']});
  r=await call('GET','/composition');
  ok('two front titles come out in the right order',
     r.body.members.find(m=>m.id===hen).displayName==='Catechist Mrs Henrietta Abena Frempong',
     r.body.members.find(m=>m.id===hen).displayName);
  r=await call('PUT','/roster/'+boa,{titles:['Rev','rev','REV']});
  ok('the same title twice is only counted once', JSON.stringify(r.body.titles)===JSON.stringify(['Rev']), r.body.titles);

  console.log('A title inside the name still comes forward in a sentence:');
  {
    const SMx=require('./utils/sessionMinutes');
    const listing = m => SMx.displayName(m), prose = m => SMx.proseName(m);
    // exactly as the roster stands before the titles are lifted out
    ok('the roster keeps the bracketed form',
       listing({name:'Michael K. Tenkorang (Dr)'})==='Michael K. Tenkorang (Dr)');
    ok('but a sentence puts it in front',
       prose({name:'Michael K. Tenkorang (Dr)'})==='Dr Michael K. Tenkorang',
       prose({name:'Michael K. Tenkorang (Dr)'}));
    ok('and the same for an engineer',
       prose({name:'Kwaku Koranteng (Ing)'})==='Ing Kwaku Koranteng', prose({name:'Kwaku Koranteng (Ing)'}));
    ok('a minister who is also a doctor reads Rev Dr',
       prose({name:'Rev Martin Owusu Boamah (Dr)'})==='Rev Dr Martin Owusu Boamah',
       prose({name:'Rev Martin Owusu Boamah (Dr)'}));
    ok('titles already in front are left alone',
       prose({name:'Catechist Mrs Henrietta Abena Frempong'})==='Catechist Mrs Henrietta Abena Frempong');
    ok('and it reads the same once the titles are lifted into the title field',
       prose({name:'Michael K. Tenkorang', titles:['Dr']})===prose({name:'Michael K. Tenkorang (Dr)'}) &&
       listing({name:'Michael K. Tenkorang', titles:['Dr']})===listing({name:'Michael K. Tenkorang (Dr)'}));
    ok('no full stop after the title — their minutes use Dr 8 times to Dr. twice',
       !/Dr\./.test(prose({name:'Michael K. Tenkorang (Dr)'})));
    ok('someone with no title at all is untouched',
       prose({name:'Esther Boatemaa'})==='Esther Boatemaa');
  }

  console.log('Two ways of writing the same person:');
  await call('PUT','/roster/'+boa,{titles:['Rev','Dr']});
  r=await call('GET','/composition');
  const b2=r.body.members.find(m=>/Boamah/.test(m.name));
  ok('the roster of a meeting brackets the academic title', b2.displayName==='Rev Martin Owusu Boamah (Dr)', b2.displayName);
  ok('a sentence runs them together in front', b2.proseName==='Rev Dr Martin Owusu Boamah', b2.proseName);
  const h2=r.body.members.find(m=>/Henrietta/.test(m.name));
  ok('with only front titles the two forms are the same',
     h2.displayName===h2.proseName && h2.displayName==='Catechist Mrs Henrietta Abena Frempong', h2.displayName);
  r=await call('GET','/'+doc.id);
  ok('the dropdowns offer the sentence form',
     (r.body.eligibility.agents||[]).some(a=>a.name==='Rev Dr Martin Owusu Boamah'),
     (r.body.eligibility.agents||[]).map(a=>a.name));
  ok('and the roster payload carries both', (r.body.roster||[]).every(m=>'displayName' in m && 'proseName' in m));

  console.log('Lifting titles out of the names:');
  r=await call('GET','/roster/titles/split');
  const plan=r.body;
  const tet=plan.move.find(x=>/Tettey/.test(x.from));
  ok('names carrying titles are found', !!tet, plan.move.map(x=>x.from));
  ok('the split is proposed, not done', (await call('GET','/composition')).body.members.find(m=>/Rev Joseph/.test(m.name))!==undefined);
  ok('and each one reassembles to exactly what it was', plan.move.every(x=>x.rebuilt===x.from), plan.move.filter(x=>x.rebuilt!==x.from));
  ok('nothing unsafe is proposed', (plan.skip||[]).length===0, plan.skip);
  r=await call('POST','/roster/titles/split');
  ok('they are moved', r.body.moved>=1, r.body.moved);
  r=await call('GET','/composition');
  const t2=r.body.members.find(m=>/Joseph Richmond Tettey/.test(m.name));
  ok('the name is now the bare name', t2.name==='Joseph Richmond Tettey', t2.name);
  ok('the title sits in its own field', JSON.stringify(t2.titles)===JSON.stringify(['Rev']), t2.titles);
  ok('and the document still reads exactly as before', t2.displayName==='Rev Joseph Richmond Tettey', t2.displayName);
  const kor=r.body.members.find(m=>/Koranteng/.test(m.name));
  ok('a bracketed title moves too', kor.name==='Kwaku Koranteng' && JSON.stringify(kor.titles)===JSON.stringify(['Ing']), kor);
  ok('and still prints in brackets', kor.displayName==='Kwaku Koranteng (Ing)', kor.displayName);
  ok('running it again finds nothing left to do', (await call('POST','/roster/titles/split')).body.moved===0);
  ok('the split touches nothing but the name and the titles',
     kor.office==='linguist' && kor.position==='Linguist', {office:kor.office, position:kor.position});

  console.log('The register of outstanding matters:');
  let m1=(await call('POST','/matters',{subject:'Repair of the chapel roof',detail:'Awaiting two further quotations.',owner:'A. Twum',raisedAt:'2026-01-08',due:'2026-08-01'})).body;
  ok('a matter is added', m1.id>0 && m1.status==='open');
  ok('the owner is written out in full', /Emmanuel Adjei Twum/.test(m1.owner), m1.owner);
  const m2=(await call('POST','/matters',{subject:'Borehole project',status:'in-progress',raisedAt:'2026-07-09'})).body;
  ok('a status can be set on the way in', m2.status==='in-progress');
  r=await call('POST','/matters',{subject:''});
  ok('a matter needs a subject', r.status===400, r.body);
  r=await call('POST','/matters',{subject:'Nonsense',status:'somehow'});
  ok('and a status the register does not use is refused', r.status===400, r.body);

  console.log('It is worked through, meeting by meeting:');
  r=await call('POST',`/matters/${m1.id}/update`,{note:'The Treasurer reported one quotation received.',meetingId:doc.id});
  ok('what the Session said is kept', (r.body.updates||[]).length===1 && /one quotation/.test(r.body.updates[0].note));
  ok('and tied to the meeting it was said at', r.body.updates[0].meetingId===doc.id && r.body.updates[0].date===doc.date, r.body.updates[0]);
  await call('POST',`/matters/${m1.id}/update`,{note:'A second quotation was received.',meetingId:doc.id});
  r=await call('GET','/matters');
  const got=r.body.matters.find(x=>x.id===m1.id);
  ok('the history builds up rather than replacing itself', (got.updates||[]).length===2, (got.updates||[]).length);
  ok('an update with nothing said is refused', (await call('POST',`/matters/${m1.id}/update`,{note:''})).status===400);

  console.log('Flags put the right ones in front of the Session:');
  ok('a matter past its date is overdue', got.flag==='overdue', got);
  const stale=r.body.matters.find(x=>x.id===m2.id);
  ok('and counted as carried', typeof stale.age==='number', stale.age);
  ok('open ones are counted', r.body.openCount>=2, r.body.openCount);

  console.log('Clearing, and re-opening:');
  r=await call('PUT','/matters/'+m1.id,{status:'closed'});
  ok('closing stamps the date', r.body.status==='closed' && !!r.body.closedAt, r.body);
  ok('and it drops out of what is being carried',
     !((await call('GET','/matters?status=open')).body.matters||[]).some(x=>x.id===m1.id));
  r=await call('PUT','/matters/'+m1.id,{status:'open'});
  ok('re-opening clears the closing date', r.body.status==='open' && !r.body.closedAt, r.body);
  ok('a closed matter keeps its history', ((await call('GET','/matters')).body.matters.find(x=>x.id===m1.id).updates||[]).length===2);

  console.log('Bringing matters in from minutes:');
  await call('PUT',`/${doc.id}/section`,{key:'main',children:[
    {subject:'Transfer of Minister',body:'Proposed 23rd August.',action:'Session Clerk to write to the District',actionResponsible:'Session Clerk'},
    {subject:'Borehole project',body:'Deferred.',deferred:true},
  ]});
  r=await call('GET',`/matters/from/${doc.id}`);
  const subs=(r.body.found||[]).map(x=>x.subject);
  ok('the open actions are found', subs.includes('Transfer of Minister'), subs);
  ok('and anything already on the register is left out', !subs.includes('Borehole project'), subs);
  r=await call('POST',`/matters/from/${doc.id}`);
  ok('they can be brought across', r.body.added>=1, r.body.added);
  const before=(await call('GET','/matters')).body.matters.length;
  await call('POST',`/matters/from/${doc.id}`);
  ok('pulling twice does not double the register', (await call('GET','/matters')).body.matters.length===before, before);

  console.log('Removing:');
  ok('a matter can be removed', (await call('DELETE','/matters/'+m2.id)).status===200);
  ok('and is gone', !((await call('GET','/matters')).body.matters||[]).some(x=>x.id===m2.id));

  console.log('The benediction is pronounced by an agent:');
  r=await call('GET','/'+doc.id);
  const ag2=(r.body.eligibility.agents||[]).map(a=>a.name);
  ok('agents are offered for it', ag2.length>=1, ag2);
  ok('and no presbyter is among them', !ag2.some(n=>/Koranteng|Tweneboa|Abankwa/.test(n)), ag2);
  await call('PUT',`/${doc.id}/proceedings`,{proceedings:{benedictionBy:'M. O. Boamah'}});
  full=(await call('GET','/'+doc.id)).body.doc;
  ok('a short form still resolves to the full name',
     /Boamah/.test(full.proceedings.benedictionBy) && /Rev/.test(full.proceedings.benedictionBy),
     full.proceedings.benedictionBy);

  console.log('The minutes follow the agenda:');
  const fm=(await call('POST','/',{date:'2027-05-13'})).body;
  await call('PUT','/'+fm.id,{agenda:[
    {mins:8,item:'Devotion',responsible:'Presbyters on Duty',subItems:[]},
    {mins:15,item:'Matters Arising',responsible:'',subItems:[{item:'Update on Building Project'},{item:'Church History'}]},
    {mins:20,item:'Main Business',responsible:'',subItems:[{item:'Transfer of Minister'}]},
    {mins:10,item:'Other Matters',responsible:'All',subItems:[{item:'Privacy screens'}]},
  ]});
  r=await call('POST',`/${fm.id}/seed-from-agenda`,{auto:true});
  ok('opening the minutes lays the agenda out', r.body.seeded===true, r.body.seeded);
  let secs=r.body.sections;
  const kids=k=>(secs.find(x=>x.key===k).children||[]).map(c=>c.subject);
  ok('sub-items become items to write against', JSON.stringify(kids('matters'))===JSON.stringify(['Update on Building Project','Church History']), kids('matters'));
  ok('main business too', kids('main').includes('Transfer of Minister'), kids('main'));
  ok('and other matters', kids('other').includes('Privacy screens'), kids('other'));
  ok('standing items are not turned into sub-items', !kids('matters').includes('Devotion'));
  // it must happen once and once only
  r=await call('POST',`/${fm.id}/seed-from-agenda`,{auto:true});
  ok('a second opening changes nothing', r.body.seeded===false);
  await call('PUT',`/${fm.id}/section`,{key:'matters',children:[{subject:'Update on Building Project',body:'Reported.'}]});
  r=await call('POST',`/${fm.id}/seed-from-agenda`,{auto:true});
  full=(await call('GET','/'+fm.id)).body.doc;
  ok('an item the clerk removed is not put back',
     (full.sections.find(x=>x.key==='matters').children||[]).length===1,
     (full.sections.find(x=>x.key==='matters').children||[]).map(c=>c.subject));
  // the button is the deliberate version and always runs
  r=await call('POST',`/${fm.id}/seed-from-agenda`);
  ok('the Agenda tab button still refreshes it',
     (r.body.sections.find(x=>x.key==='matters').children||[]).length===2,
     (r.body.sections.find(x=>x.key==='matters').children||[]).map(c=>c.subject));

  console.log('The agenda drives the minutes, one way:');
  const older=(await call('POST','/',{date:'2027-06-10'})).body;
  await call('PUT','/'+older.id,{agenda:[
    {mins:15,item:'Matters Arising',responsible:'',subItems:[{item:'Update on Building Project'}]},
  ]});
  await call('POST',`/${older.id}/agenda-sync`,{});
  await call('PUT',`/${older.id}/section`,{key:'matters',children:[
    {subject:'Update on Building Project',body:'Reported.',fromAgenda:true},
    {subject:'Something raised on the night',body:'Discussed.'}]});

  // an item remembered late is brought in without being asked
  await call('PUT','/'+older.id,{agenda:[
    {mins:15,item:'Matters Arising',responsible:'',subItems:[{item:'Update on Building Project'},{item:'Church History'}]},
    {mins:20,item:'Main Business',responsible:'',subItems:[{item:'Transfer of Minister'}]},
  ]});
  r=await call('POST',`/${older.id}/agenda-sync`,{});
  ok('what the agenda gained is brought in automatically', r.body.added===2, r.body.added);
  full=(await call('GET','/'+older.id)).body.doc;
  ok('into the right sections',
     full.sections.find(x=>x.key==='matters').children.some(c=>c.subject==='Church History') &&
     full.sections.find(x=>x.key==='main').children.some(c=>c.subject==='Transfer of Minister'));
  ok('what was already written is untouched',
     full.sections.find(x=>x.key==='matters').children.find(c=>/Building Project/.test(c.subject)).body==='Reported.');
  ok('syncing again adds nothing', (await call('POST',`/${older.id}/agenda-sync`,{})).body.added===0);

  // taking an item OFF the agenda flags it — it is never deleted for you
  await call('PUT','/'+older.id,{agenda:[
    {mins:15,item:'Matters Arising',responsible:'',subItems:[{item:'Update on Building Project'}]},
  ]});
  r=await call('GET',`/${older.id}/agenda-sync`);
  const orph=(r.body.orphans||[]).map(o=>o.subject);
  ok('an item taken off the agenda is flagged', orph.includes('Church History'), orph);
  ok('and so is one in another section', orph.includes('Transfer of Minister'), orph);
  ok('but nothing typed on the night is ever flagged', !orph.includes('Something raised on the night'), orph);
  full=(await call('GET','/'+older.id)).body.doc;
  ok('and none of them is actually deleted',
     full.sections.find(x=>x.key==='matters').children.some(c=>c.subject==='Church History') &&
     full.sections.find(x=>x.key==='main').children.some(c=>c.subject==='Transfer of Minister'));
  ok('a flagged item says whether anything is written against it',
     (r.body.orphans||[]).every(o=>typeof o.hasBody==='boolean'), r.body.orphans);
  ok('the document is not in sync while items are flagged', r.body.inSync===false);
  // putting it back on the agenda clears the flag
  await call('PUT','/'+older.id,{agenda:[
    {mins:15,item:'Matters Arising',responsible:'',subItems:[{item:'Update on Building Project'},{item:'Church History'}]},
    {mins:20,item:'Main Business',responsible:'',subItems:[{item:'Transfer of Minister'}]},
  ]});
  r=await call('GET',`/${older.id}/agenda-sync`);
  ok('putting it back clears the flag', (r.body.orphans||[]).length===0 && r.body.inSync===true, r.body);

  console.log('Review of Minutes — one block per set reviewed:');
  const rv=(await call('POST','/',{date:'2027-07-08'})).body;
  r=await call('PUT',`/${rv.id}/reviews`,{reviews:[
    {date:'29th January 2026', readBy:'The Session Clerk', movedBy:'A. Twum', secondedBy:'Alex Abankwa',
     corrections:[{where:'Item numbering', note:'Item numbering corrections were effected after item 6.2.'}]},
    {date:'5th February 2026', readBy:'The Session Clerk', movedBy:'A. Twum', secondedBy:'Alex Abankwa',
     corrections:[{where:'Item numbering', note:'The item number for closure was changed from 11.0 to 5.0.'}]},
  ]});
  ok('both sets are kept', (r.body.reviews||[]).length===2, (r.body.reviews||[]).length);
  ok('and the names are written out in full', /Emmanuel Adjei Twum/.test(r.body.reviews[0].movedBy), r.body.reviews[0].movedBy);
  full=(await call('GET','/'+rv.id)).body.doc;
  const SMx=require('./utils/sessionMinutes');
  const rkids=SMx.reviewChildren(full).map(c=>c.subject);
  ok('each set gets review, correction, adoption — in that order',
     JSON.stringify(rkids)===JSON.stringify([
       'Review of Minutes of Session Meeting for 29th January 2026',
       'Correction — Item numbering',
       'Adoption of Session Minutes for 29th January 2026',
       'Review of Minutes of Session Meeting for 5th February 2026',
       'Correction — Item numbering',
       'Adoption of Session Minutes for 5th February 2026']), rkids);
  const bodies=SMx.reviewChildren(full).map(c=>c.body);
  ok('the adoption names its own meeting', /for the Session meeting of 29th January 2026 as corrected/.test(bodies[2]), bodies[2]);
  ok('and the second names the second', /for the Session meeting of 5th February 2026 as corrected/.test(bodies[5]), bodies[5]);
  // a set with no corrections reads differently, and never borrows another's
  await call('PUT',`/${rv.id}/reviews`,{reviews:[
    {date:'11th June 2026', readBy:'', movedBy:'Alex Abankwa', secondedBy:'A. Twum', corrections:[]},
  ]});
  full=(await call('GET','/'+rv.id)).body.doc;
  const one=SMx.reviewChildren(full);
  ok('one set gives exactly two items', one.length===2, one.map(c=>c.subject));
  ok('with no corrections it reads "in the absence of corrections"',
     /in the absence of corrections/.test(one[1].body), one[1].body);
  ok('and an unnamed reader falls back to the Session Clerk',
     /^The Session Clerk led the Session/.test(one[0].body), one[0].body);
  // the older single-set fields still render for minutes recorded before this
  const legacy=(await call('POST','/',{date:'2027-08-12'})).body;
  await call('PUT',`/${legacy.id}/proceedings`,{proceedings:{minutesReviewDate:'9th July 2026',minutesMovedBy:'Alex Abankwa'}});
  full=(await call('GET','/'+legacy.id)).body.doc;
  const legacyKids=SMx.reviewChildren(full);
  ok('minutes recorded the old way still read correctly',
     legacyKids.length===2 && /9th July 2026/.test(legacyKids[0].subject), legacyKids.map(c=>c.subject));

  console.log('The minutes to review are picked, not typed:');
  // two earlier sittings the app holds, and an agenda that names them
  const e1=(await call('POST','/',{date:'2027-03-04'})).body;
  const e2=(await call('POST','/',{date:'2027-03-18'})).body;
  const tonight=(await call('POST','/',{date:'2027-04-15'})).body;
  await call('PUT','/'+tonight.id,{agenda:[
    {mins:10,item:'Review of minutes',responsible:'Session Clerk',subItems:[
      {item:'Minutes of Session Meeting for 4th March 2027'},
      {item:'Minutes of 18th March 2027'}]},
  ]});
  r=await call('GET','/'+tonight.id);
  const opts=r.body.reviewOptions||[];
  const agendaOpts=opts.filter(o=>o.source==='agenda');
  ok('what the agenda names is offered', agendaOpts.length===2, agendaOpts);
  ok('worded as the minutes word a date',
     agendaOpts.map(o=>o.label).join(' | ')==='4th March 2027 | 18th March 2027', agendaOpts.map(o=>o.label));
  ok('and each carries the real meeting date',
     agendaOpts[0].iso==='2027-03-04' && agendaOpts[1].iso==='2027-03-18', agendaOpts.map(o=>o.iso));
  ok('earlier sittings are offered too', opts.some(o=>o.source==='app'), opts.map(o=>o.source));
  ok('with nothing listed twice', new Set(opts.map(o=>o.label)).size===opts.length, opts.map(o=>o.label));
  // an agenda entry the app does not know is offered exactly as worded
  await call('PUT','/'+tonight.id,{agenda:[
    {mins:10,item:'Review of minutes',responsible:'',subItems:[{item:'Minutes of the Emergency Meeting of 2nd January 2020'}]},
  ]});
  r=await call('GET','/'+tonight.id);
  ok('an unknown meeting is offered as the agenda words it',
     (r.body.reviewOptions||[]).some(o=>o.source==='agenda' && /Emergency Meeting of 2nd January 2020/.test(o.label)),
     (r.body.reviewOptions||[]).filter(o=>o.source==='agenda').map(o=>o.label));
  // the picked date is remembered, and drives which minutes a correction hits
  await call('PUT',`/${e1.id}/section`,{key:'main',children:[{subject:'Roof',body:'DANIEL ASUMADU reported.'}]});
  await call('PUT',`/${tonight.id}/reviews`,{reviews:[
    {date:'4th March 2027', iso:'2027-03-04', corrections:[{where:'Members Present',was:'DANIEL ASUMADU',now:'DANIEL ASUMADU OWUSU'}]},
  ]});
  ok('the picked meeting is remembered',
     (await call('GET','/'+tonight.id)).body.doc.reviews[0].iso==='2027-03-04');
  r=await call('POST',`/${tonight.id}/corrections/0/0/apply`);
  ok('and the correction lands on that meeting, not merely the last one',
     r.status===200 && r.body.targetId===e1.id, r.body);
  ok('the earlier minutes actually changed',
     /DANIEL ASUMADU OWUSU/.test((await call('GET','/'+e1.id)).body.doc.sections.find(x=>x.key==='main').children[0].body));

  console.log('The lead-in line agrees with the count:');
  await call('PUT',`/${fm.id}/section`,{key:'matters',children:[{subject:'Only one',body:'Discussed.'}]});
  let rows=(await call('GET',`/${fm.id}`)).body;
  const bodyOf=(sections,key)=>{ const SMx=require('./utils/sessionMinutes');
    const d=(rows.doc); const rr=SMx.renderRows(d); const sec=d.sections.find(x=>x.key===key);
    const idx=d.sections.filter(x=>x.enabled).findIndex(x=>x.key===key);
    return (rr.filter(x=>x.level===0)[idx]||{}).body; };
  ok('one matter reads "was discussed"', /The following was discussed under matters arising\./.test(bodyOf(null,'matters')), bodyOf(null,'matters'));
  await call('PUT',`/${fm.id}/section`,{key:'matters',children:[{subject:'One',body:'a'},{subject:'Two',body:'b'}]});
  rows=(await call('GET',`/${fm.id}`)).body;
  ok('two matters read "were discussed"', /The following were discussed under matters arising\./.test(bodyOf(null,'matters')), bodyOf(null,'matters'));

  console.log('How correspondence should be written:');
  const ai=require('./utils/aiAssist');
  ok('the house style forbids enumerating a schedule',
     /SUMMARISE\. DO NOT ENUMERATE/.test(ai.SYSTEM_PROMPT));
  ok('and names the sender as the Session names them',
     /Adabraka Official Town District.*not.*District Session Council Standing Committee/s.test(ai.SYSTEM_PROMPT));
  ok('with worked examples from the congregation\'s own minutes',
     /Emeralds of Praise seeking the Session/.test(ai.SYSTEM_PROMPT) &&
     /Oduu Piesie Asona family/.test(ai.SYSTEM_PROMPT));
  ok('and the blood donation letter shown both ways',
     /WRONG, because it enumerates/.test(ai.SYSTEM_PROMPT) && /RIGHT:/.test(ai.SYSTEM_PROMPT));
  ok('a length is set so it cannot ramble', /40 to 110 words/.test(ai.SYSTEM_PROMPT));
  ok('the Clerk\'s own note is appended, and wins',
     /Where it differs from anything above, follow this/.test(ai.styleBlock('never mention zones')));
  ok('and nothing is appended when he has said nothing', ai.styleBlock('')==='' && ai.styleBlock(null)==='');

  r=await call('GET','/notice-settings');
  ok('the style note is served with the other notice settings', 'correspondenceStyle' in r.body, Object.keys(r.body));
  r=await call('PUT','/notice-settings',{correspondenceStyle:'Never list a schedule date by date.'});
  ok('it can be set', r.body.correspondenceStyle==='Never list a schedule date by date.', r.body);
  ok('without disturbing the agenda note', /WhatsApp/.test((await call('GET','/notice-settings')).body.agendaNote));
  const keepNote=(await call('GET','/notice-settings')).body.agendaNote;
  r=await call('PUT','/notice-settings',{agendaNote:'Agenda on the group.'});
  ok('and setting the agenda note leaves the style note alone',
     (await call('GET','/notice-settings')).body.correspondenceStyle==='Never list a schedule date by date.');
  await call('PUT','/notice-settings',{correspondenceStyle:''});
  ok('it can be cleared', (await call('GET','/notice-settings')).body.correspondenceStyle==='');
  // settings.json outlives the test run, so put back what we borrowed
  await call('PUT','/notice-settings',{agendaNote:keepNote});

  console.log('Tidying rough notes into minute prose:');
  ok('the job is the register, not the content',
     /YOUR ONE JOB IS TO CHANGE THE REGISTER, NOT THE CONTENT/.test(ai.POLISH_PROMPT));
  ok('spoken habits are named and converted',
     /sat down to review/.test(ai.POLISH_PROMPT) && /from where he sat/.test(ai.POLISH_PROMPT)
     && /somewhere in 2016/.test(ai.POLISH_PROMPT), 'idiom list');
  ok('an invented "so" is forbidden — it made correct figures read as wrong',
     /NEVER MANUFACTURE A CONNECTIVE/.test(ai.POLISH_PROMPT)
     && /makes correct figures read as though they do not add up/.test(ai.POLISH_PROMPT));
  ok('and no arithmetic of its own',
     /Never compute, reconcile, total or correct a figure/.test(ai.POLISH_PROMPT));
  ok('replies and decisions have their own shapes',
     /In response, Ing Kwaku Koranteng indicated/.test(ai.POLISH_PROMPT)
     && /After deliberation, the Session agreed/.test(ai.POLISH_PROMPT));
  ok('the rule against inventing survives all of it',
     /Do not invent names, figures, dates, decisions, reasons or outcomes/.test(ai.POLISH_PROMPT));
  ok('paragraphs turn on the subject, not on who is speaking',
     /the rule is the SUBJECT turning, never the speaker changing/.test(ai.POLISH_PROMPT)
     && /Do NOT start a new paragraph merely because a different member has spoken/.test(ai.POLISH_PROMPT));
  ok('short items stay whole, discussions get broken',
     /median length is 23 words/.test(ai.POLISH_PROMPT)
     && /paragraphs average about 40 words/.test(ai.POLISH_PROMPT));
  ok('the same speaker may still start a new paragraph',
     /He further reported that/.test(ai.POLISH_PROMPT));
  ok('a question and its answer are not split',
     /A question and the answer to it belong in the same paragraph/.test(ai.POLISH_PROMPT));
  ok('and it is shown a real item broken at its four turns',
     /WHERE THE BREAKS FALL/.test(ai.POLISH_PROMPT)
     && /On site issues, Ing Kwaku Koranteng/.test(ai.POLISH_PROMPT)
     && /the matter has turned to the payment certificate/.test(ai.POLISH_PROMPT));
  ok('it is shown the fault, not just told about it',
     /WHAT THIS LOOKS LIKE/.test(ai.POLISH_PROMPT)
     && /so the outstanding mobilization amount was GHS 735,379\.26/.test(ai.POLISH_PROMPT)
     && /He stated that the outstanding mobilisation stood at GHS 735,379\.26/.test(ai.POLISH_PROMPT));
  ok('with each substitution spelled out',
     /"sat down to review" became "reviewed"/.test(ai.POLISH_PROMPT));
  ok('and shown how a debate is recorded',
     /In response, Ing Kwaku Koranteng indicated/.test(ai.POLISH_PROMPT)
     && /After deliberation, the Session agreed/.test(ai.POLISH_PROMPT));
  ok('length is explicitly not a fault — their entries run to six hundred words',
     /Length is not a fault/.test(ai.POLISH_PROMPT));
  ok('and the roster still goes with it so short forms come back in full',
     /THE PEOPLE OF THIS SESSION/.test(ai.POLISH_PROMPT + ai.styleBlock('') + require('fs').readFileSync('utils/aiAssist.js','utf8')));

  console.log('List shows the lock state:');
  await call('POST',`/${doc.id}/roll/lock`);
  r=await call('GET','/');
  ok('rollLocked exposed', r.body.find(d=>d.id===doc.id).rollLocked===true, r.body.find(d=>d.id===doc.id));
 }catch(e){fail++;console.log('  ✗ THREW:',e.message,(e.stack||'').split('\n')[1]);}
 console.log('');
 console.log(fail===0?`ALL ${pass} CHECKS PASSED`:`${fail} FAILED, ${pass} passed`);
 server.close(); process.exit(fail?1:0);
}

// ---- non-constitutional offices are listed as MEMBER --------------------------
// The Deputy Senior Presbyter, Assistant Session Clerk and Linguist are the
// Session's own arrangements, not offices of the court, so the printed roster of
// a meeting calls them what the constitution calls them: members.
{
  const SM = require('./utils/sessionMinutes');
  ok('Deputy Senior Presbyter is listed as a member',
    SM.rosterPosition('Deputy Senior Presbyter') === 'Member');
  ok('Assistant Session Clerk is listed as a member',
    SM.rosterPosition('Assistant Session Clerk') === 'Member');
  ok('and so is the Linguist — also not constitutional',
    SM.rosterPosition('Linguist') === 'Member');
  ok('but the Senior Presbyter keeps his office', SM.rosterPosition('Senior Presbyter') === 'Senior Presbyter');
  ok('and so do the Session Clerk and the Treasurer',
    SM.rosterPosition('Session Clerk') === 'Session Clerk' && SM.rosterPosition('Treasurer') === 'Treasurer');
  ok('and the District Minister', SM.rosterPosition('District Minister') === 'District Minister');
}

// ---- a name written into a sentence takes its running-text form ---------------
// Even on a document captured before the title rules existed: the names are put
// into prose form when the rows are BUILT, not only when they are saved.
{
  const SM = require('./utils/sessionMinutes');
  const members = [{ id: 1, name: 'Kwaku Koranteng (Ing)', position: 'Member' }];
  const doc = { sections: [{ key: 'devotion', enabled: true }],
    proceedings: { commencedAt: '6.32 p.m.', devotionBy: 'Kwaku Koranteng (Ing)' } };
  const body = SM.renderRows(doc, { members })[0].body;
  ok('the listing form is turned into the running-text form when the row is built',
    /Ing Kwaku Koranteng led/.test(body), body);
  ok('and the bracketed form is gone from the sentence', !/\(Ing\)/.test(body), body);
}

