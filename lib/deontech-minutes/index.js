// @deontech/minutes — meetings and minutes, as one engine for every app.
//
// What it is: the parts of AOTC Track's Session minutes that were never about a
// church — the numbering that closes up behind a switched-off section, the
// lead-in that agrees with how many items follow, the blank that stays visible
// until it is filled, the agenda clock, motions with a mover, a seconder and a
// result, and the Word and PDF documents built inside an organisation's own
// letterhead template.
//
// What it is not: any app's vocabulary. Section titles, house sentences, office
// names, mastheads, fonts and footers come in from the app as a style or as
// hooks. docx, jszip and pdfkit are injected too — no package here depends on a
// third-party library (see test/packaging.test.js).
'use strict';

module.exports = {
  ...require('./text'),
  ...require('./motions'),
  ...require('./sections'),
  createMinutesDocx: require('./docx').createMinutesDocx,
  createMinutesPdf: require('./pdf').createMinutesPdf,
};
