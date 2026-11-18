// A throwaway congregation with something of every kind for the Church Diary.
const path = require('path'), fs = require('fs'); const root = process.env.APP || path.resolve(__dirname, '../..');
const D = process.env.AOTC_DATA_DIR; fs.rmSync(D, { recursive: true, force: true }); fs.mkdirSync(D, { recursive: true });
const day = n => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const w = (c, rows) => fs.writeFileSync(`${D}/${c}.json`, JSON.stringify(rows));
w('users', [{ id: 1, name: 'Clerk', role: 'admin', email: 'c@t', permissions: [] }, { id: 2, name: 'Choir Secretary', role: 'secretary', email: 's@t', permissions: ['planning.manage'] }]);
w('minutes_docs', [{ id: 1, kind: 'session', date: day(5), startTime: '6:30 pm', venue: 'Session Room', sections: [], proceedings: {} },
  { id: 2, kind: 'session', date: day(-2), sections: [], proceedings: { visitors: [{ purpose: 'funeral', deceased: 'the late Madam Ama Owusu', events: [{ what: 'one-week observance', date: day(2), time: '9am', venue: 'the family house, Kokomlemle' }] }] } }]);
w('meetings', [{ id: 1, entityName: 'Church Choir', title: 'Executive meeting', date: day(3), time: '17:00', venueName: 'Chapel', status: 'scheduled' }]);
w('marriage_cases', [{ id: 1, refNo: 'IM-1', stage: 'approved', form: { b: { husband: { name: 'Kwabena Asante' }, wife: { name: 'Abena Darko' } } }, dates: { customaryDate: day(8), customaryTime: '10:00 am', marriageDate: day(9), marriageTime: '1:00 pm', marriageVenue: 'the AOTC Chapel' } }]);
w('correspondence', [{ id: 1, heading: 'Funeral of the late Opanyin Kofi Mensah', summary: 'Burial service at the AOTC Chapel.', from: 'The Mensah family', eventDate: day(10), status: 'new', minutesId: null }]);
w('diary_entries', [{ id: 1, kind: 'programme', title: 'Harvest launch', date: day(1), endDate: day(1), time: '9:00 am', venue: 'the AOTC Chapel', details: '' },
  { id: 2, kind: 'preaching', title: 'Sunday service', service: '', preacher: 'Rev Kofi Manukure Akyeampong', theme: 'Walking in the Spirit', readings: 'Gal 5:16-26', date: day((7 - new Date().getDay()) % 7 || 7) }]);
console.log('ok');
