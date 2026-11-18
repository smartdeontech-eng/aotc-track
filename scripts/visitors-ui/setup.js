const path = require('path'), fs = require('fs'); const root = path.resolve(__dirname, '../..');
const D = process.env.AOTC_DATA_DIR; fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
fs.writeFileSync(D + '/users.json', JSON.stringify([{ id: 1, name: 'Clerk', role: 'admin', email: 'c@t', permissions: [] }]));
fs.writeFileSync(D + '/session_members.json', JSON.stringify([{ id: 3, name: 'Gideon Adjei', titles: ['Mr'], position: 'Session Clerk', office: 'session_clerk', rank: 1 }, { id: 4, name: 'Kwaku Koranteng', titles: ['Presbyter'], position: 'Linguist', rank: 2 }]));
fs.writeFileSync(D + '/marriage_cases.json', JSON.stringify([{ id: 1, refNo: 'IM-2026-009', stage: 'approved', form: { b: { husband: { name: 'Mr Kwabena Asante' }, wife: { name: 'Miss Abena Darko' } } }, dates: { customaryDate: '2026-11-14', customaryTime: '10:00 am', customaryVenue: 'the bride’s family house, Kaneshie', marriageDate: '2026-12-05', marriageTime: '1:00 pm', marriageVenue: 'the AOTC Chapel' } }]));
const db = require(path.join(root, 'utils/db')); const SM = require(path.join(root, 'utils/sessionMinutes'));
const doc = db.insert('minutes_docs', SM.newMinutesDoc({ date: '2026-11-05' }));
console.log(doc.id);
