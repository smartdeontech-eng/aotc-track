// Seed a throwaway data dir with one set of minutes (two items), as test-proofread.js does.
const path = require('path'), fs = require('fs'); const root = require('path').resolve(__dirname, '../..');
const dir = process.env.AOTC_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(dir + '/users.json', JSON.stringify([{ id: 1, name: 'Clerk', role: 'admin', email: 'c@t', permissions: [] }]));
fs.writeFileSync(dir + '/session_members.json', JSON.stringify([{ id: 3, name: 'Gideon Adjei', titles: ['Mr'], position: 'Session Clerk', office: 'session_clerk', rank: 1 }]));
['minutes_docs', 'session_matters', 'office_terms', 'minutes_proofreads', 'house_style_rules'].forEach(c => fs.writeFileSync(`${dir}/${c}.json`, '[]'));
const db = require(path.join(root, 'utils/db')); const SM = require(path.join(root, 'utils/sessionMinutes'));
const doc = db.insert('minutes_docs', SM.newMinutesDoc({ date: '2026-09-24' }));
const P1 = 'The Session Clerk informed the Session that the data was already available, and explained that distant members had been divided amongst Presbyters.';
const P2 = 'He added that he was yet to follow up with finance to complete the purchase.';
const P3 = 'The legal team was to be shared with Head Office.';
db.update('minutes_docs', doc.id, { sections: db.findById('minutes_docs', doc.id).sections.map(s => s.key === 'other' ? { ...s, children: [{ subject: 'Distant members', body: P1 + '\n' + P2 }, { subject: 'Legal', body: P3 }] } : s) });
console.log(JSON.stringify({ docId: doc.id }));
