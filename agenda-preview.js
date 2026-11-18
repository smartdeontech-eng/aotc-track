// AOTC Track — build the agenda and look at it.
//
// Word and PDF have both shipped visually broken output that passed every XML
// assertion, so the rule in CONTINUATION.md is to render and LOOK. This builds
// both formats from one sample agenda — the congregation's own 30 July 2026
// one, so the result can be held against the real document — converts them and
// rasterises page 1 into _preview/.
//
//   node agenda-preview.js
//
// Needs soffice and pdftoppm on the box. _preview/ is excluded from the deploy.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { buildSessionAgendaDocx } = require('./utils/sessionDocx');
const { buildSessionAgendaPdf } = require('./utils/sessionMinutesPdf');

const SAMPLE = {
  heading: 'Session Meeting', date: '2026-07-30',
  rows: [
    { at: '6:30 pm', mins: 10, item: 'Devotion', responsible: 'Ing. Sampson Agudze / Mad. Gladys Biama Sackey' },
    // 6:40 pm (10 mins) and 12:30 pm (10 mins) are the strings that overflowed
    // the Time column, so the sample carries them.
    { at: '6:40 pm', mins: 10, item: 'Constitution of the Session', responsible: 'Rev Joseph Richmond Tettey' },
    { at: '12:30 pm', mins: 10, item: 'Presentation', responsible: '' },
    { at: '6:45 pm', mins: 5, item: 'Roll and Apology', responsible: 'Session Clerk' },
    { at: '6:50 pm', mins: 15, item: 'Review of Minutes', responsible: 'Session Clerk', subItems: [
      { item: '11th June 2026 Session Meeting' }, { item: '9th July 2026 Session Meeting' } ] },
    { at: '7:05 pm', mins: 20, item: 'Matters Arising', responsible: '', subItems: [
      { item: 'Update on Building Project', responsible: 'Ing. Sampson Agudze' },
      { item: 'Update on Letter to Head Office', responsible: 'Rev. J. R. Tettey' },
      { item: "Members' Contributions towards Relocation from the Flood Zone", responsible: 'Rev. J. R. Tettey' },
      { item: 'Replacement of Damaged Privacy Screens', responsible: 'Mrs. Grace Bediako-Asante' },
      { item: 'Arrangements for the Send-off of the District Minister', responsible: 'Senior Presbyter' } ] },
    { at: '7:25 pm', mins: 40, item: 'Main Business', responsible: '', subItems: [
      { item: 'Discussion of AOTC Flood Victims', responsible: 'Senior Presbyter' } ] },
    { at: '8:05 pm', mins: 10, item: 'Correspondence', responsible: 'Session Clerk' },
    { at: '8:15 pm', mins: 10, item: 'Other Matters', responsible: 'Rev. J. R. Tettey' },
    { at: '8:25 pm', mins: 10, item: 'Prayers', responsible: 'Senior Presbyter' },
    { at: '8:35 pm', mins: 0, item: 'Closure', responsible: 'Rev. J. R. Tettey' },
  ],
};
module.exports = { SAMPLE };

if (require.main === module) {
  const OUT = path.join(__dirname, '_preview');
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'pipe' });
  (async () => {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'agenda.docx'), await buildSessionAgendaDocx(SAMPLE));
    console.log('built _preview/agenda.docx');
    try {
      run('soffice', ['--headless', '--convert-to', 'pdf', path.join(OUT, 'agenda.docx'), '--outdir', OUT]);
      fs.renameSync(path.join(OUT, 'agenda.pdf'), path.join(OUT, 'agenda-word.pdf'));
      run('pdftoppm', ['-r', '110', '-png', '-f', '1', '-l', '1',
        path.join(OUT, 'agenda-word.pdf'), path.join(OUT, 'agenda-word')]);
      console.log('rendered _preview/agenda-word-1.png — the Word file');
    } catch (e) { console.log('could not render the Word file: ' + (e.message || e)); }
    fs.writeFileSync(path.join(OUT, 'agenda.pdf'), await buildSessionAgendaPdf(SAMPLE));
    console.log('built _preview/agenda.pdf');
    try {
      run('pdftoppm', ['-r', '110', '-png', '-f', '1', '-l', '1',
        path.join(OUT, 'agenda.pdf'), path.join(OUT, 'agenda-pdf')]);
      console.log('rendered _preview/agenda-pdf-1.png — the PDF');
    } catch (e) { console.log('could not render the PDF: ' + (e.message || e)); }
  })().catch(e => { console.error(e); process.exit(1); });
}
