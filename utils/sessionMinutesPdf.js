// AOTC Track — Session minutes and agenda (PDF, A4), drawn by @deontech/minutes
// to the same measurements as the Word documents. See utils/minutesStyle.js.
const { createMinutesPdf } = require('./minutesLib');
const P = createMinutesPdf({ PDFDocument: require('pdfkit'), style: require('./minutesStyle') });

module.exports = { buildSessionMinutesPdf: (data) => P.minutes(data), buildSessionAgendaPdf: (data) => P.agenda(data) };
