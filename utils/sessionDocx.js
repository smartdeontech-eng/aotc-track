// AOTC Track — Session agenda and minutes (.docx).
//
// Built by @deontech/minutes inside the congregation's own files
// (templates/session-minutes-template.docx and session-agenda-template.docx),
// so the page, masthead, crest watermark, footer, styles and fonts come across
// byte-identical. AOTC's measurements and wording are in utils/minutesStyle.js.
const { createMinutesDocx, longDate, ordinal } = require('./minutesLib');
const W = createMinutesDocx({ docx: require('docx'), JSZip: require('jszip'), style: require('./minutesStyle') });

// data: { heading, date, venue, present/apologies/absent:[{name,position}],
//         rows:[{no,subject,body,action,table}], signatories, appendices, owner }
const buildSessionMinutesDocx = (data, opts = {}) => W.minutes(data, opts);
// data: { heading, date, rows:[{at,mins,item,responsible,subItems}] }
const buildSessionAgendaDocx = (data, opts = {}) => W.agenda(data, opts);

module.exports = { buildSessionMinutesDocx, buildSessionAgendaDocx, longDate, ordinal };
